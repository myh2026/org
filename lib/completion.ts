// ============================================================================
// lib/completion.ts — 代码补全（v0.5.16 · capabilities #32）
// ----------------------------------------------------------------------------
// 「光标处补全」的零 LSP 实现：lib/symbols.ts 的符号索引之上叠一层语言
// 关键字表，三级候选来源按分数排序：
//   · 同文件符号 100 分（正在编辑的文件 —— 最可能是当下意图）
//   · 项目符号   80 分（工作区其他文件的符号 —— indexSymbols 全量索引）
//   · 语言关键字 50 分（HSL / TS / PY 三语言各一组，见 KEYWORDS_BY_LANG）
//   前缀长度加分（score = 基础分 + prefix.length —— 前缀越长权重越高，
//   长前缀的自然歧义更小）；同分按 label 字典序稳定排序（确定性输出）。
//
//   completeAt(ws, file, lineText, column, {dirs?, max?=20})
//   → { candidates: {label, kind, detail, score, source}[], prefix, language,
//       reason? } —— column 为 0 基字符偏移（VSCode 风格），越界钳制到
//   [0, lineText.length]；前缀 = 光标前连续标识符字符 [A-Za-z0-9_$]（符号
//   字符集与 symbols.ts 同规的超集）；前缀匹配大小写不敏感（编辑器惯例，
//   已测试锁定）。
//
// 诚实边界（文件头写明）：**点后成员补全与类型推断不做**（obj. → 空候选
// + reason；完整 LSP 是路线图）；触发面上「空格后 / 行首 / 非标识符字符后」
// 均返回空候选 + reason（绝不臆造）；非支持扩展名（.hsl/.ts/.tsx/.py 之外）
// → language:"other" + reason 降级。文件参数接受工作区相对路径（推荐，与
// SymbolHit.file 同形）或绝对路径（自动转相对）；不在索引面内的文件仍给
// 项目级 + 关键字候选（同文件级为空，诚实）。
// ============================================================================
import * as path from "node:path";
import { indexSymbols, type SymbolHit } from "./symbols.ts";

// ---- 常量与关键字表 -----------------------------------------------------------

/** 补全语言面（other = 非支持扩展名的降级标记）。 */
export type CompletionLanguage = "hsl" | "ts" | "py" | "other";

/** 候选来源三级：同文件符号 > 项目符号 > 语言关键字。 */
export type CompletionSource = "file" | "project" | "keyword";

/** 基础分：同文件 100 · 项目 80 · 关键字 50（前缀长度另加）。 */
export const SCORE_BASE = { file: 100, project: 80, keyword: 50 } as const;

/** 缺省候选帽。 */
export const DEFAULT_MAX_CANDIDATES = 20;
/** 候选帽上限（max 消毒用）。 */
export const MAX_CANDIDATES_CAP = 100;

/**
 * 三语言关键字表（#32 交付面；HSL 按 Rust 风格语法族、TS/TSX 按
 * TypeScript 保留字、PY 按 Python 关键字 —— 核心集而非全量保留字清单，
 * 够用即止的诚实边界）。导出供 rename.ts 的「新名是语言关键字」校验复用
 * （单一事实源，两模块不各养一份）。
 */
export const KEYWORDS_BY_LANG: Record<"hsl" | "ts" | "py", readonly string[]> = {
  hsl: [
    "fn", "let", "graph", "export", "pub", "struct", "enum", "trait", "impl",
    "const", "type", "use", "mut", "return", "if", "else", "for", "while",
    "loop", "match", "break", "continue", "as", "in", "ref", "self", "true",
    "false",
  ],
  ts: [
    "const", "let", "var", "function", "interface", "type", "enum", "class",
    "export", "import", "from", "async", "await", "return", "if", "else",
    "for", "while", "switch", "case", "try", "catch", "finally", "throw",
    "new", "extends", "implements", "of", "in", "this", "typeof",
    "instanceof", "void", "null", "undefined", "true", "false", "yield",
    "static", "readonly", "public", "private", "protected", "abstract",
    "declare",
  ],
  py: [
    "def", "class", "import", "from", "as", "return", "if", "elif", "else",
    "for", "while", "with", "lambda", "try", "except", "finally", "raise",
    "pass", "break", "continue", "in", "is", "not", "and", "or", "None",
    "True", "False", "global", "nonlocal", "assert", "del", "yield", "async",
    "await", "match",
  ],
};

/** 语言人读名（detail 字段用）。 */
const LANG_LABEL: Record<"hsl" | "ts" | "py", string> = { hsl: "HSL", ts: "TS", py: "Python" };

// ---- 类型 -------------------------------------------------------------------

/** 一个补全候选。 */
export interface CompletionCandidate {
  /** 补全项文本（符号名或关键字）。 */
  label: string;
  /** 符号种类（SymbolKind）或 "keyword"。 */
  kind: string;
  /** 人读详情：符号 = "file:line · kind"；关键字 = "TS 关键字"。 */
  detail: string;
  /** 基础分 + 前缀长度（排序键）。 */
  score: number;
  source: CompletionSource;
}

/** completeAt 结果（空候选必有 reason —— 空结果永不静默）。 */
export interface CompletionResult {
  candidates: CompletionCandidate[];
  /** 光标前提取到的标识符前缀（空串 = 无前缀触发）。 */
  prefix: string;
  language: CompletionLanguage;
  /** 空候选原因（点后成员 / 空格后 / 行首 / 非支持扩展名 / 无命中）。 */
  reason?: string;
}

// ---- 小工具 -----------------------------------------------------------------

/** 扩展名 → 语言（.tsx 归 ts 面）。 */
function langOf(file: string): CompletionLanguage {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".hsl") return "hsl";
  if (ext === ".ts" || ext === ".tsx") return "ts";
  if (ext === ".py") return "py";
  return "other";
}

/** 文件参数归一：绝对路径转工作区相对；反斜杠 → 正斜杠（与 SymbolHit.file 同形）。 */
function normalizeFile(ws: string, file: string): string {
  const fwd = file.replace(/\\/g, "/");
  if (path.isAbsolute(fwd)) {
    const rel = path.relative(ws, fwd).replace(/\\/g, "/");
    // 不在工作区下的绝对路径：原样保留（不匹配任何索引文件 → 同文件级为空）
    return rel.startsWith("..") ? fwd : rel;
  }
  return fwd;
}

/** 标识符字符（symbols.ts 词法字符集的超集：A-Z a-z 0-9 _ $）。 */
function isIdentChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  return /[A-Za-z0-9_$]/.test(c);
}

/** max 消毒：非有限/≤0 → 缺省 20；上限 100。 */
function saneMax(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_MAX_CANDIDATES;
  return Math.min(Math.floor(v), MAX_CANDIDATES_CAP);
}

/** 符号 → 候选（source/detail 按来源装配）。 */
function symbolCandidate(s: SymbolHit, source: "file" | "project", prefixLen: number): CompletionCandidate {
  return {
    label: s.name,
    kind: s.kind,
    detail: `${s.file}:${s.line} · ${s.kind}`,
    score: SCORE_BASE[source] + prefixLen,
    source,
  };
}

// ---- API ----------------------------------------------------------------------

/**
 * 光标处补全（#32）：symbols 索引（indexSymbols）+ 语言关键字表的三级候选。
 *
 * @param ws        工作区根（绝对路径）
 * @param file      正在编辑的文件（工作区相对路径推荐；绝对路径自动转相对）
 * @param lineText  光标所在行全文
 * @param column    光标 0 基字符偏移（越界钳制到 [0, lineText.length]）
 * @param opts.dirs indexSymbols 扫描根（缺省 DEFAULT_SYMBOL_DIRS）
 * @param opts.max  候选帽（缺省 20，上限 100）
 *
 * 空候选 + reason 的触发面：非支持扩展名 · 行首/空格后（无前缀）· 点后
 * 成员访问（完整 LSP 是路线图）· 前缀无命中 —— 空结果永不静默。
 */
export async function completeAt(
  ws: string,
  file: string,
  lineText: string,
  column: number,
  opts?: { dirs?: string[]; max?: number },
): Promise<CompletionResult> {
  // 1. 语言识别（非支持扩展名 → 诚实降级，不臆造关键字）
  const language = langOf(file);
  if (language === "other") {
    return {
      candidates: [],
      prefix: "",
      language,
      reason: `非支持的扩展名（${path.extname(file) || "(无)"}）—— 本模块支持 .hsl/.ts/.tsx/.py`,
    };
  }

  // 2. 列钳制 + 前缀提取（光标前连续标识符字符）
  const line = typeof lineText === "string" ? lineText : "";
  const col = typeof column === "number" && Number.isFinite(column)
    ? Math.min(Math.max(0, Math.floor(column)), line.length)
    : 0;
  let end = col;
  while (end > 0 && isIdentChar(line[end - 1])) end--;
  const prefix = line.slice(end, col);

  // 3. 触发面判定（空结果 + reason —— 绝不臆造）
  if (prefix.length === 0) {
    const prev = col > 0 ? line[col - 1] : undefined;
    let reason: string;
    if (col === 0) reason = "行首无前缀（光标列 0）";
    else if (prev === ".") reason = "点后成员补全不在本轮交付（需要类型推断 —— 完整 LSP 是路线图）";
    else if (/\s/.test(prev!)) reason = "空格后无前缀";
    else reason = `光标前是 "${prev}"（非标识符字符），无前缀可补全`;
    return { candidates: [], prefix, language, reason };
  }
  // 前缀非空但紧邻前是 "." → 成员访问（obj.prefix 形态）
  if (end > 0 && line[end - 1] === ".") {
    return {
      candidates: [],
      prefix,
      language,
      reason: `点后成员补全不在本轮交付（obj.${prefix} 形态需要类型推断 —— 完整 LSP 是路线图）`,
    };
  }

  // 4. 候选装配：同文件符号 > 项目符号 > 语言关键字（大小写不敏感前缀匹配）
  const rel = normalizeFile(ws, file);
  const idx = indexSymbols(ws, opts?.dirs);
  const lower = prefix.toLowerCase();
  const candidates: CompletionCandidate[] = [];

  for (const s of idx.symbols) {
    if (!s.name.toLowerCase().startsWith(lower)) continue;
    candidates.push(symbolCandidate(s, s.file === rel ? "file" : "project", prefix.length));
  }
  for (const kw of KEYWORDS_BY_LANG[language]) {
    if (!kw.toLowerCase().startsWith(lower)) continue;
    candidates.push({
      label: kw,
      kind: "keyword",
      detail: `${LANG_LABEL[language]} 关键字`,
      score: SCORE_BASE.keyword + prefix.length,
      source: "keyword",
    });
  }

  // 5. 排序（score 降序 → label 字典序 → source 字典序 —— 全确定性）+ 帽
  candidates.sort((a, b) =>
    b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : a.source < b.source ? -1 : 1)
  );
  const max = saneMax(opts?.max);
  const capped = candidates.slice(0, max);

  if (capped.length === 0) {
    return {
      candidates: [],
      prefix,
      language,
      reason: `前缀 "${prefix}" 无命中（同文件/项目符号与${LANG_LABEL[language]}关键字均不匹配）`,
    };
  }
  return { candidates: capped, prefix, language };
}
