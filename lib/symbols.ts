// ============================================================================
// lib/symbols.ts — 轻量符号索引（v0.5.15 · capabilities #20）
// ----------------------------------------------------------------------------
// 「符号定义 / 引用 / 跳转」的进程内实现：正则/词法行扫描，构建三类语言
// （HSL · TypeScript/TSX · Python）的符号表与引用表。三个导出：
//   · indexSymbols(ws, dirs?)  扫描工作区 → SymbolHit[]（默认扫 hsl/ lib/
//     cli/ web/ tui/ tests/ projects/ + 顶层 *.ts；文件帽 600 · 单文件
//     512KB；索引对象显式传递 —— 纯函数，无模块级缓存态，与 lib/search.ts
//     同构的治理取向）
//   · lookupDef(symbols, name, exact?)  定义查找（exact 缺省 true：大小写
//     敏感优先，敏感无命中时大小写不敏感兜底；exact:false = 子串匹配）
//   · findRefs(ws, name, opts?)  引用查找（逐文件行扫描词边界 name；
//     定义行本身排除；name 后接 `(` → kind:"call"，纯出现 → kind:"mention"；
//     maxHits 缺省 200）
// 计划消费入口：CLI org symbols 命令、Web 符号面板、编辑器跳转接线。
//
// 诚实边界：这是正则/词法扫描的 80% 场景实现 —— 不做作用域解析 / 类型
// 推断（块注释中裸露的同形行、字符串字面量里的伪定义可能误报；一行内
// 「定义 + 自引用」会随定义行整体排除）。完整 LSP（tree-sitter / 语言
// 服务器）是路线图，本模块的接口面按其可替换形态设计（显式索引对象）。
//
// 优雅降级：目录缺失 → 空索引（不炸）；二进制（前 4KB 含 NUL，与
// search.ts 同规）→ 跳过并计数 skippedBinary；超帽文件 → 跳过（truncated
// 诚实标注索引不完整）；单文件读失败不连坐。HSL 可见性前缀同时接受 pub
// 与 export（规范族用 pub，本仓 HSL 实际用 export —— 超集兼容，两者同权）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- 常量（预算面）----------------------------------------------------------

/** 默认扫描根（工作区子目录，递归；另加顶层 *.ts 非递归）。 */
export const DEFAULT_SYMBOL_DIRS = ["hsl", "lib", "cli", "web", "tui", "tests", "projects"] as const;

/** 参与索引的扩展名 → 语言（小写匹配）。 */
const LANG_BY_EXT: Record<string, "hsl" | "ts" | "py"> = {
  ".hsl": "hsl",
  ".ts": "ts",
  ".tsx": "ts",
  ".py": "py",
};

/** 文件帽：索引/引用扫描最多收录 600 个文件（超帽 → truncated:true）。 */
const MAX_FILES = 600;

/** 单文件帽：超过 512KB 跳过（防单个巨文件拖死交互；跳过 → truncated:true）。 */
const MAX_FILE_BYTES = 512 * 1024;

/** 病态目录树保护：候选收集的硬上限（正常仓库远达不到；触顶即超帽）。 */
const HARD_COLLECT_CAP = 10_000;

/** findRefs 的 maxHits 缺省（引用面帽 —— 防热门名刷屏）。 */
const DEFAULT_MAX_HITS = 200;

/** snippet 上限：命中行 trim 后截 120 字符。 */
const SNIPPET_MAX = 120;

// ---- 类型 -------------------------------------------------------------------

/** 符号种类（fn/struct/enum/trait/graph/const 为 HSL 面；class/interface/
 *  type 为 TS 面；impl 为 HSL 实现块 —— name 记类型名）。 */
export type SymbolKind =
  | "fn"
  | "struct"
  | "enum"
  | "trait"
  | "graph"
  | "const"
  | "class"
  | "interface"
  | "type"
  | "impl";

/** 一个符号定义命中。file 为工作区相对路径（正斜杠）。 */
export interface SymbolHit {
  kind: SymbolKind;
  name: string;
  file: string;
  /** 1 基行号。 */
  line: number;
  /** 命中行 trim 后 ≤120 字符的原文。 */
  snippet: string;
}

/** 一个符号引用命中（call=带调用括号 · mention=纯提及）。 */
export interface SymbolRef {
  file: string;
  /** 1 基行号。 */
  line: number;
  snippet: string;
  kind: "call" | "mention";
}

/** indexSymbols 结果：索引数据 + 构建面元信息。 */
export interface SymbolIndexResult {
  symbols: SymbolHit[];
  /** 实际入库文件数（帽子/二进制/超帽跳过后的口径）。 */
  files: number;
  builtMs: number;
  /** 二进制嗅探跳过的文件数。 */
  skippedBinary: number;
  /** 索引是否不完整（文件帽触顶 或 有超帽文件被跳过）。 */
  truncated: boolean;
}

// ---- 符号模式（逐语言；对 trim 后的行匹配，锚定行首关键字）-------------------
//
// HSL（Rust 风格语法族）：pub/export 前缀同权；fn/struct/enum/trait/const/
//   type 直取名；graph 取图名（`graph NAME -> Ret {`）；impl 记类型名
//   （`impl Trait for Type` 取 Type，`impl Type` 取 Type）。
// TS/TSX：function（含 async/generator `function*`/default 导出）、abstract
//   class、interface、type、`const NAME =`（函数式组件不深究，记 const）。
// PY：def / async def（含缩进的方法 —— trim 后匹配）、class。
// 注释行跳过：trim 后以 // # -- * /* 开头的行（块注释续行 ` *` 覆盖在内）。
const PATTERNS: Record<"hsl" | "ts" | "py", Array<{ kind: SymbolKind; re: RegExp }>> = {
  hsl: [
    { kind: "fn", re: /^(?:(?:pub|export)\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "struct", re: /^(?:(?:pub|export)\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: "enum", re: /^(?:(?:pub|export)\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: "trait", re: /^(?:(?:pub|export)\s+)?trait\s+([A-Za-z_]\w*)/ },
    { kind: "graph", re: /^graph\s+([A-Za-z_]\w*)/ },
    { kind: "const", re: /^(?:(?:pub|export)\s+)?const\s+([A-Za-z_]\w*)/ },
    { kind: "type", re: /^(?:(?:pub|export)\s+)?type\s+([A-Za-z_]\w*)/ },
    { kind: "impl", re: /^impl\s+(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s+for\s+)?([A-Za-z_]\w*)/ },
  ],
  ts: [
    { kind: "fn", re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/ },
    { kind: "class", re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: "interface", re: /^(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_]\w*)/ },
    { kind: "type", re: /^(?:export\s+)?type\s+([A-Za-z_]\w*)/ },
    { kind: "const", re: /^(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_]\w*)\s*[=:<]/ },
  ],
  py: [
    { kind: "fn", re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^class\s+([A-Za-z_]\w*)/ },
  ],
};

/** 注释行前缀（trim 后锚定）：// · # · -- · * · /*。 */
const COMMENT_RE = /^(?:\/\/|#|--|\*|\/\*)/;

// ---- 小工具 -----------------------------------------------------------------

/** 词法边界包裹（\b 的标识符精确版：边界字符集含 $，防 `foo` 误配 `foo$bar`）。 */
const BEFORE = "(?:^|[^A-Za-z0-9_$])";
const AFTER = "(?:$|[^A-Za-z0-9_$])";

/** 正则元字符转义（标识符已校验，此处为纵深防御）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单文件符号提取（CRLF 归一 + 逐行模式匹配；注释行跳过；一行至多一个符号）。 */
function scanSource(rel: string, text: string, lang: "hsl" | "ts" | "py"): SymbolHit[] {
  const out: SymbolHit[] = [];
  const lines = (text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length === 0 || COMMENT_RE.test(t)) continue;
    for (const p of PATTERNS[lang]) {
      const m = p.re.exec(t);
      if (m) {
        out.push({
          kind: p.kind,
          name: m[1]!,
          file: rel,
          line: i + 1,
          snippet: t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX) : t,
        });
        break;
      }
    }
  }
  return out;
}

/** 候选收集：默认 = DEFAULT_SYMBOL_DIRS 递归 + 顶层 *.ts；显式 dirs = 仅这些
 *  目录递归（顶层不附加）。去重 + 字典序 = 跨平台确定性。文件帽在收集后
 *  切片（触顶 → capped，而非行进中截断 —— 恰好 600 个文件不算截断）。 */
function collectCandidates(ws: string, dirs: string[] | undefined): { rels: string[]; capped: boolean } {
  const raw: string[] = [];
  const roots: readonly string[] = dirs ?? DEFAULT_SYMBOL_DIRS;
  for (const dir of roots) walkDir(ws, dir, raw, 0);
  if (dirs === undefined) {
    // 顶层 *.ts（非递归 —— 根下散置脚本/入口；子目录已由 dirs 覆盖）
    try {
      for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase().endsWith(".ts")) raw.push(e.name);
      }
    } catch {
      // 工作区根不可读 → 顶层无候选（子目录各自隔离降级）
    }
  }
  const unique = [...new Set(raw)].sort();
  const capped = unique.length >= HARD_COLLECT_CAP || unique.length > MAX_FILES;
  return { rels: unique.slice(0, MAX_FILES), capped };
}

/** 工作区运行时/产物目录（组织约定）：符号索引无业务价值且体积夫 —— 跳过。
 * v0.5.15：支持 dirs=[""]（工作区根扫描）时保持索引面干净。 */
const SKIP_DIRS = new Set(["runtime", "spawn", "dist", "demo-run", "node_modules", ".git"]);

/** 递归收集语言文件（跳隐藏目录 / node_modules / 运行时产物目录；深度 ≤ 8；硬帽保护）。 */
function walkDir(ws: string, relDir: string, out: string[], depth: number): void {
  if (out.length >= HARD_COLLECT_CAP || depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(ws, relDir === "" ? "." : relDir), { withFileTypes: true });
  } catch {
    return; // 目录不存在 / 不可读 → 该根降级为空（不连坐其他根）
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules"
      || SKIP_DIRS.has(e.name) || (e.isDirectory() && e.name.startsWith("out-"))) continue;
    const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      walkDir(ws, rel, out, depth + 1);
    } else if (e.isFile() && LANG_BY_EXT[path.extname(e.name).toLowerCase()] !== undefined) {
      out.push(rel);
    }
    if (out.length >= HARD_COLLECT_CAP) return;
  }
}

/** 读取候选文件并抽取符号（逐文件隔离：超帽 / 二进制 / 读失败各跳各的）。 */
function scanFiles(
  ws: string,
  rels: string[],
): { symbols: SymbolHit[]; files: number; skippedBinary: number; skippedOversize: number } {
  const symbols: SymbolHit[] = [];
  let files = 0;
  let skippedBinary = 0;
  let skippedOversize = 0;
  for (const rel of rels) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(ws, rel));
    } catch {
      continue; // 单文件读失败不连坐
    }
    if (buf.length > MAX_FILE_BYTES) {
      skippedOversize++;
      continue;
    }
    // 二进制嗅探：前 4KB 含 NUL（与 search.ts 同规）
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
      skippedBinary++;
      continue;
    }
    const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()];
    if (lang === undefined) continue; // 防御（收集时已过滤）
    files++;
    symbols.push(...scanSource(rel, buf.toString("utf-8"), lang));
  }
  return { symbols, files, skippedBinary, skippedOversize };
}

// ---- API --------------------------------------------------------------------

/** 构建工作区符号索引。
 *
 *  @param ws   工作区根（绝对路径）
 *  @param dirs 显式子目录列表（缺省 DEFAULT_SYMBOL_DIRS + 顶层 *.ts；
 *              传 [] = 只扫顶层也不加，得到空索引）
 *  降级：目录缺失 → 空索引；二进制 → skippedBinary；文件帽/单文件帽触顶
 *  → truncated:true（索引不完整的诚实标注）。 */
export function indexSymbols(ws: string, dirs?: string[]): SymbolIndexResult {
  const t0 = Date.now();
  const { rels, capped } = collectCandidates(ws, dirs);
  const { symbols, files, skippedBinary, skippedOversize } = scanFiles(ws, rels);
  return {
    symbols,
    files,
    builtMs: Date.now() - t0,
    skippedBinary,
    truncated: capped || skippedOversize > 0,
  };
}

/** 定义查找（在 indexSymbols 的结果上做纯函数查询）。
 *
 *  @param exact 缺省 true：先大小写敏感全等；敏感无命中 → 大小写不敏感
 *               全等兜底（「大小写敏感优先」的两层语义）。false = 子串
 *               匹配（大小写敏感）。
 *  排序：file 字典序 + line 升序（确定性输出）。 */
export function lookupDef(symbols: SymbolHit[], name: string, exact = true): SymbolHit[] {
  if (typeof name !== "string" || name.length === 0) return [];
  const sorted = [...symbols].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line),
  );
  if (!exact) return sorted.filter((s) => s.name.includes(name));
  const cs = sorted.filter((s) => s.name === name);
  if (cs.length > 0) return cs;
  const lower = name.toLowerCase();
  return sorted.filter((s) => s.name.toLowerCase() === lower);
}

/** 引用查找：逐文件行扫描词边界 name，定义行本身排除。
 *
 *  @param opts.dirs     扫描根（缺省同 indexSymbols）
 *  @param opts.maxHits  引用数帽（缺省 200）
 *  分类：行内 name 后接 `(`（可含空白）→ kind:"call"；纯出现（含注释里的
 *  提及）→ kind:"mention"。定义行整体排除 —— 一行内「定义 + 自引用」也随
 *  之排除（行级扫描的诚实边界，见文件头）。
 *  降级：目录缺失 → []；二进制 / 超帽文件跳过；非标识符 name → []（防
 *  正则注入，也防无意义扫描）。 */
export function findRefs(
  ws: string,
  name: string,
  opts?: { dirs?: string[]; maxHits?: number },
): SymbolRef[] {
  if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return [];
  const maxHits =
    typeof opts?.maxHits === "number" && Number.isFinite(opts.maxHits)
      ? Math.max(0, Math.floor(opts.maxHits))
      : DEFAULT_MAX_HITS;
  if (maxHits === 0) return [];
  const { rels } = collectCandidates(ws, opts?.dirs);
  const wordRe = new RegExp(`${BEFORE}${escapeRe(name)}${AFTER}`);
  const callRe = new RegExp(`${BEFORE}${escapeRe(name)}\\s*\\(`);
  const refs: SymbolRef[] = [];
  for (const rel of rels) {
    if (refs.length >= maxHits) break;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(ws, rel));
    } catch {
      continue;
    }
    if (buf.length > MAX_FILE_BYTES) continue;
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) continue;
    const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()];
    if (lang === undefined) continue;
    const text = buf.toString("utf-8");
    const lines = (text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text).split("\n");
    // 该文件中目标名的定义行集合（整体排除）
    const defLines = new Set(
      scanSource(rel, text, lang).filter((h) => h.name === name).map((h) => h.line),
    );
    for (let i = 0; i < lines.length && refs.length < maxHits; i++) {
      const t = lines[i]!.trim();
      if (t.length === 0 || !wordRe.test(t) || defLines.has(i + 1)) continue;
      refs.push({
        file: rel,
        line: i + 1,
        snippet: t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX) : t,
        kind: callRe.test(t) ? "call" : "mention",
      });
    }
  }
  return refs;
}
