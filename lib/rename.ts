// ============================================================================
// lib/rename.ts — 项目级符号重命名（v0.5.16 · capabilities #56 LSP 重命名/代码动作）
// ----------------------------------------------------------------------------
// 「跨文件重命名」的零 LSP 实现：lib/symbols.ts 的定义/引用索引之上构建
// 重命名计划（plan）与执行面（apply）：
//   · planRename(ws, oldName, newName, {dirs?})
//     → {definition, refs, edits, warnings, reason?}
//     edits = 定义行 + 引用行（findRefs 已排除定义行 —— 两者相并恰为该名字
//     的全部出现行）；安全检查：目标名已存在（大小写敏感硬拒 + 大小写不同
//     软警告）· 新名非法标识符（HSL/TS/PY 各自正则 —— TS 允许 $，HSL/PY
//     不允许）· 新名是语言关键字（复用 completion.ts 的 KEYWORDS_BY_LANG
//     单一事实源）· 新旧名相同（无操作）—— 拒绝时 edits:[] + warnings/reason。
//   · applyRename(ws, oldName, newName, {dryRun?=true, dirs?})
//     dryRun:true（缺省）→ plan + 逐文件 unified diff 预览（lib/diff.ts
//     renderUnified；最多前 5 文件，超出如实标注）；dryRun:false → 真写
//     （写前逐文件读 → 行级替换 → 写 → 复读校验；任何文件失败即停，返回
//     已完成清单 —— 诚实部分失败）。
//
// 词边界替换：手动扫描 + 前瞻正则（不依赖 lookbehind —— 跨引擎稳），
// 词法字符集 [A-Za-z0-9_$] 与 symbols.ts 同规（\b 会把 "foo$bar" 的 foo
// 误判为词 —— 故不用裸 \b）；一行内多处全替换。
//
// 诚实边界（行级扫描的固有面，见 symbols.ts 文件头）：注释/字符串里的
// mention 也在重命名面内（附 warning 明示 —— LSP 通常不动注释，本工具
// 会动，接线层应把该 warning 呈现给用户）；块注释中裸露的同形行可能误报；
// 单文件 512KB / 文件帽 600 沿用 symbols.ts（超帽文件的重命名面不完整）；
// 多定义（同名 N 处）全部纳入编辑面并附 warning。完整 LSP（作用域感知）
// 是路线图，本模块接口面按其可替换形态设计。
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import {
  indexSymbols,
  lookupDef,
  findRefs,
  type SymbolHit,
  type SymbolRef,
} from "./symbols.ts";
import { diffText, renderUnified, renderStats } from "./diff.ts";
import { KEYWORDS_BY_LANG } from "./completion.ts";

// ---- 常量 -------------------------------------------------------------------

/** dryRun 预览的文件数帽（超出如实标注 —— 预览是给人看的，全量编辑面在 plan.edits）。 */
export const PREVIEW_FILE_CAP = 5;

/** 各语言合法标识符正则（TS 允许 $；HSL 为 Rust 风格族、PY 为 Python 族 —— 均不允许 $）。 */
export const IDENT_RE: Record<"hsl" | "ts" | "py", RegExp> = {
  hsl: /^[A-Za-z_][A-Za-z0-9_]*$/,
  ts: /^[A-Za-z_$][A-Za-z0-9_$]*$/,
  py: /^[A-Za-z_][A-Za-z0-9_]*$/,
};

/** 词法字符集（与 symbols.ts 的 BEFORE/AFTER 同规 —— \b 的标识符精确版）。 */
const WORD_CHARS = /[A-Za-z0-9_$]/;

// ---- 类型 -------------------------------------------------------------------

/** 一处行级编辑（from/to 为符号名；行内多处出现全替换）。 */
export interface RenameEdit {
  file: string;
  /** 1 基行号。 */
  line: number;
  from: string;
  to: string;
}

/** 重命名计划（拒绝面用 edits:[] + warnings/reason 表达，绝不做半吊子计划）。 */
export interface RenamePlan {
  /** 主定义（多定义时取 file/line 序首个；找不到 → null + reason）。 */
  definition: SymbolHit | null;
  refs: SymbolRef[];
  edits: RenameEdit[];
  warnings: string[];
  /** 不可执行的原因（找不到定义 / 目标名冲突 / 新名非法或关键字 / 新旧名相同）。 */
  reason?: string;
}

/** dryRun 预览（单文件 unified diff + 一行统计）。 */
export interface RenamePreview {
  file: string;
  diff: string;
  stats: string;
}

/** applyRename 结果（真写模式的部分失败诚实清单）。 */
export interface RenameApplyResult {
  /** true = 请求的操作完成（dryRun 预览产出 / 真写全部落盘）。 */
  ok: boolean;
  dryRun: boolean;
  plan: RenamePlan;
  /** dryRun:false：已完成文件清单（含行数与替换次数；失败即停，故为前缀）。 */
  applied?: Array<{ file: string; lines: number; occurrences: number }>;
  /** 真写失败时的止步文件（ok:false 时在场）。 */
  failed?: { file: string; error: string };
  /** dryRun:true：逐文件预览（≤ PREVIEW_FILE_CAP）。 */
  previews?: RenamePreview[];
  /** 计划覆盖的文件总数（previews 被帽截断时的诚实口径）。 */
  filesTotal?: number;
  /** previews 是否被帽截断。 */
  previewTruncated?: boolean;
  /** ok:false 的原因。 */
  reason?: string;
}

// ---- 小工具 -----------------------------------------------------------------

/** 正则元字符转义。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 数值选项消毒。 */
function saneDirs(v: string[] | undefined): string[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** 定义文件扩展名 → 语言（.tsx 归 ts）。 */
function langOfDef(file: string): "hsl" | "ts" | "py" {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".hsl") return "hsl";
  if (ext === ".py") return "py";
  return "ts"; // .ts / .tsx
}

/**
 * 行内词边界替换（全部出现；手动扫描 + 前瞻，不依赖 lookbehind）。
 * 词边界字符集 [A-Za-z0-9_$] —— "foo" 不误伤 "foobar"/"myfoo"/"foo$bar"。
 */
export function replaceWordInLine(line: string, from: string, to: string): { text: string; count: number } {
  const re = new RegExp(`${escapeRe(from)}(?![A-Za-z0-9_$])`, "g");
  let out = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const idx = m.index;
    // 回看前边界：行首或非词字符（前瞻已保证后边界）
    if (idx === 0 || !WORD_CHARS.test(line[idx - 1]!)) {
      out += line.slice(last, idx) + to;
      last = idx + from.length;
      count++;
    }
  }
  out += line.slice(last);
  return { text: out, count };
}

/** 行内词边界出现次数（漂移检测 / 复读校验用）。 */
function countWordInLine(line: string, name: string): number {
  return replaceWordInLine(line, name, name).count;
}

/** 读工作区文件文本（失败返回 null —— 逐文件隔离）。 */
function readText(ws: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(ws, rel), "utf-8");
  } catch {
    return null;
  }
}

// ---- API ----------------------------------------------------------------------

/**
 * 规划项目级重命名（#56 计划面，纯只读不落盘）。
 *
 * 拒绝面（edits:[] + warnings/reason）：目标名已存在（大小写敏感）· 新名
 * 非法标识符（per 语言正则）· 新名是语言关键字 · 新旧名相同 · 找不到
 * oldName 定义（definition:null + reason，附大小写不同的候选提示）。
 * edits = 全部定义行 + 全部引用行（该名字的完整出现面）。
 */
export async function planRename(
  ws: string,
  oldName: string,
  newName: string,
  opts?: { dirs?: string[] },
): Promise<RenamePlan> {
  const warnings: string[] = [];

  // 1. 旧名词法校验（与 findRefs 同一防线 —— 非标识符直接诚实拒绝）
  if (typeof oldName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(oldName)) {
    return {
      definition: null,
      refs: [],
      edits: [],
      warnings,
      reason: `旧名 "${oldName}" 不是合法标识符`,
    };
  }
  if (typeof newName !== "string" || newName.length === 0) {
    return {
      definition: null,
      refs: [],
      edits: [],
      warnings,
      reason: "新名为空",
    };
  }
  if (oldName === newName) {
    return { definition: null, refs: [], edits: [], warnings, reason: `新旧名相同（${oldName}），无操作` };
  }

  // 2. 定义查找（lookupDef 的大小写兜底会被剔除 —— 重命名必须精确大小写）
  const idx = indexSymbols(ws, saneDirs(opts?.dirs));
  const defs = lookupDef(idx.symbols, oldName).filter((h) => h.name === oldName);
  if (defs.length === 0) {
    // 大小写不同的候选提示（人读 —— 调用方第一想知道「是不是打错了大小写」）
    const ci = idx.symbols.filter(
      (s) => s.name !== oldName && s.name.toLowerCase() === oldName.toLowerCase(),
    );
    const reason = `未找到 "${oldName}" 的定义（indexSymbols 扫描面内无精确大小写命中）`
      + (ci.length > 0
        ? `；存在大小写不同的符号：${ci.slice(0, 3).map((s) => `${s.name}（${s.file}:${s.line}）`).join("、")}`
        : "");
    return { definition: null, refs: [], edits: [], warnings, reason };
  }
  const definition = defs[0]!;
  if (defs.length > 1) {
    warnings.push(
      `定义不唯一（${defs.length} 处）：${defs.map((d) => `${d.file}:${d.line}`).join("、")} —— 全部纳入重命名面`,
    );
  }

  // 3. 新名校验（per 语言正则 + 关键字 + 冲突 —— 拒绝面 edits:[]）
  const lang = langOfDef(definition.file);
  const reject = (reason: string): RenamePlan => ({ definition, refs: [], edits: [], warnings, reason });
  if (!IDENT_RE[lang].test(newName)) {
    warnings.push(
      `新名 "${newName}" 不是合法 ${lang.toUpperCase()} 标识符（${lang === "ts" ? "字母/_/$ 开头，后随字母/数字/_/$" : "字母/_ 开头，后随字母/数字/_（不含 $）"}）`,
    );
    return reject(`新名 "${newName}" 不是合法 ${lang.toUpperCase()} 标识符`);
  }
  if ((KEYWORDS_BY_LANG[lang] as readonly string[]).includes(newName)) {
    warnings.push(`新名 "${newName}" 是 ${lang.toUpperCase()} 语言关键字`);
    return reject(`新名 "${newName}" 是语言关键字，不可用作标识符`);
  }
  const clash = lookupDef(idx.symbols, newName).filter((h) => h.name === newName);
  if (clash.length > 0) {
    warnings.push(
      `目标名已存在：${newName}（${clash.slice(0, 3).map((h) => `${h.file}:${h.line} · ${h.kind}`).join("、")}${clash.length > 3 ? " 等" : ""}，共 ${clash.length} 处）`,
    );
    return reject(`目标名 "${newName}" 已存在（${clash.length} 处定义）—— 重命名会产生冲突`);
  }
  const ciClash = idx.symbols.filter((s) => s.name !== newName && s.name.toLowerCase() === newName.toLowerCase());
  if (ciClash.length > 0) {
    warnings.push(
      `目标名与既有符号大小写不同但同名：${ciClash.slice(0, 3).map((s) => `${s.name}（${s.file}:${s.line}）`).join("、")} —— 不拦截，但请确认意图`,
    );
  }

  // 4. 引用面 + 编辑面（定义行 ∪ 引用行 —— findRefs 已排除定义行）
  const refs = findRefs(ws, oldName, { dirs: saneDirs(opts?.dirs) });
  const mentions = refs.filter((r) => r.kind === "mention").length;
  if (mentions > 0) {
    warnings.push(
      `${mentions} 处 mention（注释/字符串提及）也在重命名面内 —— 行级扫描的诚实边界（LSP 通常不动注释，本工具会动）`,
    );
  }
  const editMap = new Map<string, RenameEdit>();
  for (const d of defs) {
    editMap.set(`${d.file}:${d.line}`, { file: d.file, line: d.line, from: oldName, to: newName });
  }
  for (const r of refs) {
    editMap.set(`${r.file}:${r.line}`, { file: r.file, line: r.line, from: oldName, to: newName });
  }
  const edits = [...editMap.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
  );
  return { definition, refs, edits, warnings };
}

/** 把编辑组按文件分组（file 升序 —— 真写顺序与预览顺序全确定性）。 */
function groupByFile(edits: RenameEdit[]): Map<string, RenameEdit[]> {
  const byFile = new Map<string, RenameEdit[]>();
  for (const e of [...edits].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const list = byFile.get(e.file);
    if (list) list.push(e);
    else byFile.set(e.file, [e]);
  }
  return byFile;
}

/** 对单文件文本执行行级替换（漂移行跳过并计入 warnings；lines=0 = 无变更）。 */
function applyToText(
  rel: string,
  text: string,
  edits: RenameEdit[],
  warnings: string[],
): { next: string; lines: number; occurrences: number } {
  const lines = text.split("\n"); // 无损切分：\r\n 的 \r 留在行尾，替换不受影响
  let linesDone = 0;
  let occ = 0;
  let changed = false;
  for (const e of edits) {
    const i = e.line - 1;
    if (i < 0 || i >= lines.length) {
      warnings.push(`${rel}:${e.line} 超出文件行数（${lines.length}）—— 跳过（计划与实际漂移）`);
      continue;
    }
    const before = lines[i]!;
    if (countWordInLine(before, e.from) === 0) {
      warnings.push(`${rel}:${e.line} 不再包含词边界 "${e.from}"（计划与实际漂移）—— 跳过该行`);
      continue;
    }
    const { text: after, count } = replaceWordInLine(before, e.from, e.to);
    lines[i] = after;
    linesDone++;
    occ += count;
    changed = true;
  }
  return changed
    ? { next: lines.join("\n"), lines: linesDone, occurrences: occ }
    : { next: text, lines: 0, occurrences: 0 };
}

/**
 * 执行重命名（#56 执行面）。
 *
 * @param opts.dryRun 缺省 true（只产出 plan + 逐文件 unified diff 预览，
 *        最多前 5 文件 —— 超出 previewTruncated:true）；false = 真写：写前
 *        逐文件读 → 行级替换 → 写盘 → 复读校验（新名在场 · 旧名不在场），
 *        任何文件失败即停并返回已完成清单（诚实部分失败）。
 */
export async function applyRename(
  ws: string,
  oldName: string,
  newName: string,
  opts?: { dryRun?: boolean; dirs?: string[] },
): Promise<RenameApplyResult> {
  const dryRun = opts?.dryRun !== false; // 缺省 true（安全缺省：不落盘）
  const plan = await planRename(ws, oldName, newName, { dirs: opts?.dirs });

  // 拒绝面（找不到定义 / 冲突 / 非法新名）—— dryRun 与真写一致拒绝
  if (plan.edits.length === 0) {
    return {
      ok: false,
      dryRun,
      plan,
      ...(dryRun ? {} : { applied: [] }),
      reason: plan.reason ?? plan.warnings[0] ?? "计划不可执行",
    };
  }

  const byFile = groupByFile(plan.edits);

  // ---- dryRun：逐文件 unified diff 预览（≤5 文件）----
  if (dryRun) {
    const previews: RenamePreview[] = [];
    for (const [rel, edits] of byFile) {
      if (previews.length >= PREVIEW_FILE_CAP) break;
      const text = readText(ws, rel);
      if (text === null) {
        plan.warnings.push(`${rel} 读取失败 —— 预览缺席（真写时该文件也会失败）`);
        continue;
      }
      const applied = applyToText(rel, text, edits, plan.warnings);
      const result = diffText(text, applied.next);
      previews.push({ file: rel, diff: renderUnified(result, rel, rel), stats: renderStats(result) });
    }
    return {
      ok: true,
      dryRun: true,
      plan,
      previews,
      filesTotal: byFile.size,
      previewTruncated: byFile.size > previews.length,
    };
  }

  // ---- 真写：失败即停 + 已完成清单（诚实部分失败）----
  const applied: Array<{ file: string; lines: number; occurrences: number }> = [];
  for (const [rel, edits] of byFile) {
    const text = readText(ws, rel);
    if (text === null) {
      return {
        ok: false,
        dryRun: false,
        plan,
        applied,
        failed: { file: rel, error: `文件读取失败：${rel}` },
        reason: `在 ${rel} 失败：文件读取失败`,
      };
    }
    const r = applyToText(rel, text, edits, plan.warnings);
    if (r.lines === 0) {
      // 该文件全部计划行漂移 —— 无变更不写盘，继续下一文件（诚实计数在 warnings）
      continue;
    }
    try {
      fs.writeFileSync(path.join(ws, rel), r.next, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        dryRun: false,
        plan,
        applied,
        failed: { file: rel, error: `写入失败（${msg}）` },
        reason: `在 ${rel} 写入失败：${msg}`,
      };
    }
    // 复读校验：写后新名在场 · 旧名不在场（盘上字节才算，内存不算）
    const verify = readText(ws, rel);
    if (verify === null || verify !== r.next) {
      return {
        ok: false,
        dryRun: false,
        plan,
        applied,
        failed: { file: rel, error: `写后复读校验失败（文件已写入，内容与预期不符）` },
        reason: `在 ${rel} 写后复读校验失败`,
      };
    }
    applied.push({ file: rel, lines: r.lines, occurrences: r.occurrences });
  }

  if (applied.length === 0) {
    return {
      ok: false,
      dryRun: false,
      plan,
      applied,
      reason: "所有计划行均已漂移（文件内容与 plan 时不符），未做任何修改",
    };
  }
  return { ok: true, dryRun: false, plan, applied };
}
