// ============================================================================
// lib/stacktrace.ts — 堆栈自动分析（v0.5.23 · capabilities #107）
// ----------------------------------------------------------------------------
// 「粘贴一段崩溃输出 → 拿回结构化诊断」的堆栈分析器，四个导出：
//   · analyzeStackTrace(ws, text, opts?)
//     崩溃文本 → 解析 → 符号化 → 根因提示 → 报告：
//       1) 语言探测（TS/JS · Python · Rust panic · HSL 四格式族；未知 →
//          unknown + 诚实 reason，绝不臆造）
//       2) 帧解析（JS `at fn (file:line:col)` 三形态 · PY `File "…", line N,
//          in fn` · Rust `panicked at file:line:col` + backtrace `at` 行 ·
//          HSL `at file.hsl:line:col` 泛形）
//       3) 帧富化：外部分类（node_modules/node:internal/bun:/site-packages/
//          ~/.cargo/… → external:true）· 工作区内文件存在性（exists）·
//          源码行原文（snippet，读盘）· 包围符号（enclosing —— indexSymbols
//          同文件中 line ≤ 帧行的最近符号定义，confidence 字面量「symbol」）
//       4) 根因提示（HINTS 模式库 → 命中 → cause + 三步 checklist + 关联帧）
//       5) 统计面（total/app/external/symbolicated/filesMissing）
//   · stackSelfTest()
//     纯内存自检（四语言帧解析形状 + 外部分类 + 提示命中 + 帽纪律），与
//     debug.ts dapSelfTest 同款协议 —— CLI `org debug stack --self-test`。
//
// jail 铁律：读源码行原文必须经 resolveJailedFile（lib/lsp.ts 同源入口）——
// 越界路径 → 该帧 snippet 留空 + exists 保持 null（分析不因外部帧中断；
// 栈文本本身是用户输入面，文件字段天然不可信，越界即不读盘）。
//
// 诚实边界：模式库是高频崩溃族的启发式（40 基因 × 三生态 + HSL 诊断码），
// 不做数据流/控制流分析 —— hint.severity 如实分级（high=可行动根因 /
// medium=需结合上下文 / low=方向性）；无命中 → hints:[] 空数组诚实返回。
// 符号化是词法级（与 lib/symbols.ts 同一诚实面：块注释/字符串中的伪定义
// 可能误报 enclosing）。Rust backtrace 的机器码帧（0x55… 无源码行）按
// external 归类不臆造文件。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { indexSymbols, type SymbolHit } from "./symbols.ts";
import { resolveJailedFile } from "./lsp.ts";

// ---- 常量（预算面）----------------------------------------------------------

/** 帧帽：最多解析 60 帧（防超长 backtrace 刷屏；触顶 → truncated:true）。 */
export const MAX_STACK_FRAMES = 60;

/** 源码行 snippet 上限（trim 后截 120 字符 —— 与 symbols.ts 同规）。 */
export const SNIPPET_MAX = 120;

/** 单帧 raw 原文上限（解析入报告前截 200 字符）。 */
const RAW_MAX = 200;

/** 输入文本上限：超过 64KB 拒绝（防粘贴整个日志文件拖死交互）。 */
export const MAX_INPUT_BYTES = 64 * 1024;

// ---- 类型 -------------------------------------------------------------------

/** 帧语言（与 symbols.ts 的语言面不同：这里含 rust —— panic/backtrace 形态）。 */
export type StackLanguage = "ts" | "py" | "rust" | "hsl" | "unknown";

/** 一个解析后的栈帧。 */
export interface StackFrame {
  /** 原始行（≤200 字符；审计与回放面）。 */
  raw: string;
  /** 函数名（JS at 前缀 / PY in 后缀 / Rust 符号 / 未知 "<anonymous>"）。 */
  fn: string;
  /** 文件路径（工作区内 → 工作区相对正斜杠；外部的保持原样）。 */
  file: string;
  /** 1 基行号（无 → null）。 */
  line: number | null;
  /** 1 基列号（无 → null）。 */
  col: number | null;
  /** 语言族（按帧内文件扩展名归一；与全局 language 可能不同 —— 混合栈诚实并存）。 */
  language: StackLanguage;
  /** 外部帧（node_modules / runtime / 标准库 / 车道外部 —— 非用户代码）。 */
  external: boolean;
  /** 文件在工作区内是否存在（null = 未探测 —— 外部帧/无行号帧不探测）。 */
  exists: boolean | null;
  /** 源码行原文（≤120 字符；读盘失败/越界/外部 → 空串）。 */
  snippet: string;
  /** 包围符号（同文件最近上方定义；null = 未命中）。 */
  enclosing: { kind: string; name: string; defLine: number } | null;
}

/** 一条根因提示。 */
export interface StackHint {
  /** 提示 id（如 js-null-deref —— 稳定契约，测试/前端可引用）。 */
  id: string;
  title: string;
  /** high = 可行动根因 · medium = 需上下文 · low = 方向性。 */
  severity: "high" | "medium" | "low";
  /** 命中的模式（正则源；审计面 —— 为什么触发本提示）。 */
  matched: string;
  /** 根因解释（中文，与仓内文案同风格）。 */
  cause: string;
  /** 三步行动清单（可执行优先）。 */
  checklist: string[];
  /** 关联帧索引（命中文本所在帧；0 基）。 */
  frames: number[];
}

/** analyzeStackTrace 报告。 */
export interface StackAnalyzeResult {
  ok: boolean;
  /** !ok 时的原因（空输入 / 超帽 / 无可解析帧）。 */
  reason?: string;
  /** 全局语言判定（按帧多数 + 头部格式；无帧 → unknown）。 */
  language: StackLanguage;
  /** 语言判定依据（审计面：如「py: Traceback 头部」）。 */
  detectedBy: string;
  frames: StackFrame[];
  /** 非外部帧索引列表（用户代码面）。 */
  appFrames: number[];
  /** 最内层用户帧索引（null = 全外部/无帧 —— 诚实面）。 */
  innermostAppFrame: number | null;
  hints: StackHint[];
  stats: {
    total: number;
    app: number;
    external: number;
    symbolicated: number;
    filesMissing: number;
  };
  truncated?: boolean;
}

// ---- 语言探测 ----------------------------------------------------------------

/** 探测崩溃文本的语言族（不解析帧 —— 只看头部/全局形状）。 */
export function detectStackLanguage(text: string): { language: StackLanguage; detectedBy: string } {
  if (/Traceback \(most recent call last\)/.test(text)) return { language: "py", detectedBy: "py: Traceback 头部" };
  if (/thread '.*' panicked at/.test(text)) return { language: "rust", detectedBy: "rust: thread panicked 头部" };
  if (/^\s*at\s+\S.*:\d+:\d+/m.test(text)) {
    if (/\.hsl:\d+/.test(text)) return { language: "hsl", detectedBy: "hsl: .hsl 帧" };
    return { language: "ts", detectedBy: "ts: at 帧（file:line:col）" };
  }
  if (/^  File ".*", line \d+/m.test(text)) return { language: "py", detectedBy: "py: File 行" };
  if (/error\[[SPGN]-?\d+\]/.test(text)) return { language: "hsl", detectedBy: "hsl: error[码] 头部" };
  if (/^\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?[\w:<>.]/m.test(text) && /stack backtrace|panicked/.test(text)) {
    return { language: "rust", detectedBy: "rust: backtrace 帧" };
  }
  return { language: "unknown", detectedBy: "unknown: 无已知崩溃形状" };
}

// ---- 帧解析 ------------------------------------------------------------------

/** 文件扩展名 → 帧语言。 */
function langOf(file: string): StackLanguage {
  const f = file.toLowerCase();
  if (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs")) return "ts";
  if (f.endsWith(".py")) return "py";
  if (f.endsWith(".rs")) return "rust";
  if (f.endsWith(".hsl")) return "hsl";
  return "unknown";
}

/** JS 帧：`    at fn (/path/file.ts:12:34)` 三形态。 */
const JS_FRAME_RE = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
/** JS 无位置帧：`    at fn (node:internal/...)` / `    at fn`。 */
const JS_BARE_RE = /^\s*at\s+(?:async\s+)?(.+?)\s*(?:\(([^()]+)\))?\s*$/;
/** PY 帧：`  File "/path/file.py", line 12, in fn`。 */
const PY_FRAME_RE = /^\s*File\s+"([^"]+)",\s*line\s+(\d+)(?:,\s*in\s+(.+))?$/;
/** Rust panic 主位：`thread 'main' panicked at src/main.rs:5:9:`（旧）或 `panicked at 'msg', src/main.rs:5:9`（新）。 */
const RUST_PANIC_RE = /panicked at\s+(?:'[^']*',\s*)?([^:\s]+\.[a-z]+):(\d+):(\d+)/;
/** Rust backtrace 帧：`             at ./src/lib.rs:10:5` / `   2: symbol`。 */
const RUST_BT_AT_RE = /^\s*(?:\d+:\s+.*\n\s*)?at\s+([^:\s]+\.[a-z]+):(\d+)(?::(\d+))?/;

/** 解析一行 → 候选帧（null = 非帧行）。 */
function parseFrameLine(rawLine: string): { fn: string; file: string; line: number | null; col: number | null } | null {
  const line = rawLine.replace(/\r$/, "");
  // Python：File "…" 行
  const py = PY_FRAME_RE.exec(line);
  if (py) {
    return { fn: py[3] ?? "<module>", file: py[1]!, line: Number(py[2]!), col: null };
  }
  // JS：at fn (file:line:col) / at file:line:col
  const js = JS_FRAME_RE.exec(line);
  if (js) {
    return { fn: js[1]?.trim() || "<anonymous>", file: js[2]!, line: Number(js[3]!), col: Number(js[4]!) };
  }
  // JS 无位置（node:internal 等）—— 无 file:line 不成帧（外部噪声行）
  if (JS_BARE_RE.test(line)) return null;
  // Rust backtrace `at` 行（不带帧号前缀的独立 at）
  const rs = /^\s*at\s+([^:\s]+\.(?:rs|hsl|ts)):(\d+)(?::(\d+))?\s*$/.exec(line);
  if (rs) {
    return { fn: "<rust-frame>", file: rs[1]!, line: Number(rs[2]!), col: rs[3] ? Number(rs[3]!) : null };
  }
  return null;
}

/** Rust panic 主位置行（panicked at … file:line:col —— 与帧列表合并为第 0 帧）。 */
function parseRustPanic(text: string): { fn: string; file: string; line: number; col: number | null } | null {
  const m = RUST_PANIC_RE.exec(text);
  if (!m) return null;
  return { fn: "panic!", file: m[1]!, line: Number(m[2]!), col: Number(m[3]!) };
}

// ---- 外部分类 ----------------------------------------------------------------

/** 外部路径特征（前缀/子串）—— 命中即 external:true。 */
const EXTERNAL_MARKERS = [
  "node_modules/", "node:internal", "node:crypto", "bun:", "/.bun/", "/usr/lib/", "/usr/local/lib/",
  "/System/Library", "/Library/Python", "site-packages/", "/dist-packages/", "python3.", "/lib/python",
  "/.rustup/", "/.cargo/", "/rustc/", "\\?\\", "internal/deps", "/v8/", "/src/cljs", "(bun built-in)",
] as const;

/** 帧是否外部（用户代码之外）。 */
function isExternalFile(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  return EXTERNAL_MARKERS.some((m) => f.includes(m));
}

// ---- 根因提示库 --------------------------------------------------------------

/** 提示基因（正则 + 因果 + 清单）。severity 如实分级，matched 记录命中源。 */
interface HintGene {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  re: RegExp;
  cause: string;
  checklist: string[];
}

const HINT_GENES: HintGene[] = [
  // ---- JS/TS 族 ----
  {
    id: "js-null-deref",
    title: "空值解引用（读 null/undefined 的属性）",
    severity: "high",
    re: /Cannot read propert(?:y|ies) of (?:null|undefined)/i,
    cause: "对一个 null/undefined 值取属性 —— 内层帧的宿主对象在你使用时还没就绪（异步时序/失败路径没走 guard）。",
    checklist: [
      "看最内层用户帧的 snippet：`.` 左侧的表达式是谁，找出它的来源（参数/await/Map.get）",
      "在该行上方加判空（`if (!x) return` / `x?.…` / 默认值 `x ?? {}`），或修上游让失败路径也返回有效形状",
      "若来自 await：确认是不是漏了 await / Promise 链断在中间（pending 值当结果用）",
    ],
  },
  {
    id: "js-call-non-fn",
    title: "把非函数当函数调用",
    severity: "high",
    re: /(?:is not a function|is not callable)/i,
    cause: "调了一个不是函数的值 —— 常见于 import 错名（拿 default 当命名）、对象属性覆盖、API 形状与预期不符。",
    checklist: [
      "对照被调名的 import 语句与源模块导出（默认导出 vs 命名导出混用是头号来源）",
      "在调用前打 `typeof x` 观测实际类型",
      "若跨包升级后出现：查该版本 API 是否改名/移除（changelog）",
    ],
  },
  {
    id: "js-undefined-ref",
    title: "未定义标识符（拼写/导入缺失）",
    severity: "high",
    re: /(\w+ is not defined|ReferenceError)/,
    cause: "引用了不存在的变量名 —— 拼写错误或 import 遗漏（编译期该拦住，出现在运行期说明是动态构造/eval 边界）。",
    checklist: [
      "用符号搜索（org symbols / lsp references）确认该名字在本文件与依赖中的定义",
      "补 import 或改拼写；若来自 JSON 字符串里的模板，检查模板变量注入",
    ],
  },
  {
    id: "fs-missing-file",
    title: "文件不存在（ENOENT）",
    severity: "high",
    re: /ENOENT|no such file or directory/i,
    cause: "打开的路径在磁盘上不存在 —— 工作目录漂移（CWD 不是仓库根）或路径拼写/分隔符错误。",
    checklist: [
      "确认报错路径是相对还是绝对；相对路径以进程 CWD 解析，改用基于仓库根的绝对锚",
      "ls 该目录核对实际文件名（大小写敏感）；检查 path.resolve 的 base",
      "若应存在：查 .gitignore/构建产物是否没生成",
    ],
  },
  {
    id: "fs-permission",
    title: "权限不足（EACCES/EPERM）",
    severity: "medium",
    re: /EACCES|EPERM\b|permission denied/i,
    cause: "文件系统权限拒绝 —— 目标目录不可写或执行体不可执行。",
    checklist: [
      "ls -l 看目标路径属主与权限位",
      "写操作落家目录/工作区内（jail 铁律同源）；系统位置改 sudo 前先确认真的必要",
    ],
  },
  {
    id: "net-unreachable",
    title: "网络不可达（ECONNREFUSED/ETIMEDOUT）",
    severity: "medium",
    re: /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network unreachable/i,
    cause: "对端拒绝或超时 —— 服务没起、端口不对、或 DNS 解析失败（离线环境）。",
    checklist: [
      "核对 URL 的 host:port 与服务实际监听地址（127.0.0.1 vs 0.0.0.0 vs 远程）",
      "curl 同 URL 复现；通则查代码侧代理/超时设置，不通则起服务或改地址",
      "DNS 失败 → 离线沙箱内改用本地 mock 或缓存车道（降级链同源理念）",
    ],
  },
  {
    id: "syntax-error",
    title: "语法/解析错误",
    severity: "high",
    re: /SyntaxError|Unexpected token|Unexpected end of (?:JSON|input|module)/i,
    cause: "源码或 JSON 文本解析失败 —— 常见于 JSON.parse 收到非 JSON（HTML 错误页/空响应）。",
    checklist: [
      "若在 JSON.parse：先打原始文本头 200 字符看实际内容",
      "响应侧加 content-type 校验与失败分支（不要把错误页当数据解析）",
    ],
  },
  // ---- Python 族 ----
  {
    id: "py-key",
    title: "字典键缺失（KeyError）",
    severity: "high",
    re: /KeyError|'dict' object has no attribute/i,
    cause: "取了不存在的键 —— 上游数据形状变化（少字段/改名）或拼写错误。",
    checklist: [
      "改 dict.get(key, default) 或先 in 判断，失败路径给默认值",
      "打印实际键集合 sorted(d.keys()) 对照预期形状",
    ],
  },
  {
    id: "py-index",
    title: "序列越界（IndexError）",
    severity: "high",
    re: /IndexError|list index out of range|string index out of range/i,
    cause: "下标超出序列长度 —— 空列表取 [0] 或边界差一（< vs <=）。",
    checklist: [
      "取值前查长度：if not xs: return / 取值用 xs[i] if i < len(xs) else None",
      "核对循环边界与切片端点（半开区间语义）",
    ],
  },
  {
    id: "py-import",
    title: "模块导入失败（ModuleNotFoundError）",
    severity: "high",
    re: /ModuleNotFoundError|ImportError|No module named/i,
    cause: "依赖没装或虚拟环境不对 —— 解释器不是你装包的那个。",
    checklist: [
      "which python + pip list 核对（uv/pip 装进的目标环境）",
      "缺包则 org deps install 或 uv pip install；本地包则查 sys.path/相对导入",
    ],
  },
  {
    id: "py-none-op",
    title: "对 None 做操作（TypeError NoneType）",
    severity: "high",
    re: /TypeError.*NoneType|'NoneType' object is not/i,
    cause: "函数返回 None 被直接使用（漏 return / 失败路径返回 None 没分支）。",
    checklist: [
      "顺着栈看最内层用户帧调用的函数：所有分支都有返回值吗",
      "对可 None 结果显式判空（is None 检查），或改返回哨兵值/抛出",
    ],
  },
  {
    id: "py-recursion",
    title: "递归无终止（RecursionError）",
    severity: "high",
    re: /RecursionError|maximum recursion depth/i,
    cause: "递归基例缺失或自引用结构成环。",
    checklist: [
      "看重复帧（同名 fn 连续出现）——那就是没有出口的递归体",
      "补基例返回；对图/树遍历加 visited 集合防环",
    ],
  },
  // ---- Rust 族 ----
  {
    id: "rs-unwrap",
    title: "unwrap 落空（Option/Result panic）",
    severity: "high",
    re: /`?Option::unwrap\(\)`? on a `?None|`?Result::unwrap\(\)`? on an `?Err|`?unwrap_err\(\)`? on `?Ok|unwrap\(\) on `?None\b|`Result::expect\(\)` on an `?Err/i,
    cause: "unwrap 遇到 None/Err 直接 panic —— 失败路径没有处理。",
    checklist: [
      "把最内层帧的 unwrap 改成 match / if let / ok_or_else 带上下文",
      "对 Err 情形补日志与降级分支（与仓内「诚实降级」同理念）",
    ],
  },
  {
    id: "rs-index",
    title: "切片越界（index out of bounds）",
    severity: "high",
    re: /index out of bounds|range start index \d+ out of range/i,
    cause: "索引/切片超出集合长度。",
    checklist: [
      "取值前判长（xs.get(i) / if i < xs.len()）",
      "切片端点按半开区间核对（a..b 中 b ≤ len）",
    ],
  },
  {
    id: "rs-overflow",
    title: "算术溢出（overflow）",
    severity: "medium",
    re: /attempt to (add|subtract|multiply|divide) with overflow/i,
    cause: "debug 断言下的有符号溢出（release 是回绕语义 —— 两态行为不一致）。",
    checklist: [
      "checked_* / saturating_* / wrapping_* 按语义选一个",
      "排查输入规模：是不是把「字节数」当「元素数」这类单位错",
    ],
  },
  // ---- HSL 族 ----
  {
    id: "hsl-unknown-method",
    title: "HSL 运行期未知方法",
    severity: "high",
    re: /没有方法 "|S-19|unknown method/i,
    cause: "调用接收者类型没有的方法 —— check 期就该拦截（S-19），出现在 run 说明绕过了 check 或跨版本方法面漂移。",
    checklist: [
      "org check 该文件 —— S-19 error 应给出接收者类型与方法名",
      "对照 BNF 附录 A / builtins.ts 的正牌方法面（版本间方法增删是漂移源）",
    ],
  },
  {
    id: "hsl-type-mismatch",
    title: "HSL 类型不匹配（S 族）",
    severity: "medium",
    re: /error\[S-\d+\]|类型不匹配|expected .*, found/i,
    cause: "静态检查报错 —— as 转换缺失或容器/函数形状与签名不符。",
    checklist: [
      "按 error[S-N] 码查 checker.ts 对应规则的诊断文案",
      "显式 as 转换（HSL 唯一转换通道，零隐式）",
    ],
  },
];

/** 求根因提示（对全文匹配；关联帧 = 帧原文命中，无命中回落最内层用户帧）。 */
function collectHints(text: string, frames: StackFrame[], innermostApp: number | null): StackHint[] {
  const hints: StackHint[] = [];
  for (const gene of HINT_GENES) {
    if (!gene.re.test(text)) continue;
    // 关联帧：帧 raw/snippet 命中模式 → 帧级；否则回落最内层用户帧（贴近崩溃点的行动锚）
    const rel: number[] = [];
    frames.forEach((f, i) => {
      if (gene.re.test(f.raw) || (f.snippet && gene.re.test(f.snippet))) rel.push(i);
    });
    const related = rel.length > 0 ? rel.slice(0, 5) : innermostApp !== null ? [innermostApp] : [];
    hints.push({
      id: gene.id,
      title: gene.title,
      severity: gene.severity,
      matched: gene.re.source.slice(0, 80),
      cause: gene.cause,
      checklist: gene.checklist,
      frames: related,
    });
  }
  return hints;
}

// ---- 主分析 ------------------------------------------------------------------

/** 文本字节长（UTF-8 —— 与 MAX_INPUT_BYTES 同口径）。 */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * 堆栈自动分析主入口。
 * @param ws 工作区根（符号化/源码行/snippet 存在性的锚）
 * @param text 崩溃文本（粘贴或读自文件）
 */
export function analyzeStackTrace(ws: string, text: string, opts?: { maxFrames?: number }): StackAnalyzeResult {
  const maxFrames = Math.max(1, opts?.maxFrames ?? MAX_STACK_FRAMES);
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      ok: false, reason: "输入为空 —— 粘贴一段崩溃输出（含 stack trace / Traceback / panicked），或用 --file 指向日志文件",
      language: "unknown", detectedBy: "空输入", frames: [], appFrames: [], innermostAppFrame: null,
      hints: [], stats: { total: 0, app: 0, external: 0, symbolicated: 0, filesMissing: 0 },
    };
  }
  if (byteLen(trimmed) > MAX_INPUT_BYTES) {
    return {
      ok: false, reason: `输入超帽（${byteLen(trimmed)}B > ${MAX_INPUT_BYTES}B）—— 崩溃输出请只贴错误头部与栈体`,
      language: "unknown", detectedBy: "超帽", frames: [], appFrames: [], innermostAppFrame: null,
      hints: [], stats: { total: 0, app: 0, external: 0, symbolicated: 0, filesMissing: 0 },
    };
  }

  const det = detectStackLanguage(trimmed);
  const lines = trimmed.split("\n");

  // 帧收集：逐行 parseFrameLine + Rust panic 主位补第 0 帧
  const rawFrames: Array<{ fn: string; file: string; line: number | null; col: number | null; raw: string }> = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const f = parseFrameLine(l);
    if (!f) continue;
    const key = `${f.fn}|${f.file}|${f.line}|${f.col}`;
    if (seen.has(key)) continue; // 重复帧去重（递归栈常见 —— hint 用 recurrence 观测）
    seen.add(key);
    rawFrames.push({ ...f, raw: l.trim().slice(0, RAW_MAX) });
  }
  if (det.language === "rust") {
    const panic = parseRustPanic(trimmed);
    if (panic && !seen.has(`panic!|${panic.file}|${panic.line}|${panic.col}`)) {
      rawFrames.unshift({ ...panic, raw: `panicked at ${panic.file}:${panic.line}:${panic.col ?? ""}`.slice(0, RAW_MAX) });
    }
  }

  const truncated = rawFrames.length > maxFrames;
  const capped = rawFrames.slice(0, maxFrames);

  if (capped.length === 0) {
    return {
      ok: false, reason: "未解析出栈帧 —— 文本不含已知帧形态（at / File \"…\", line N / panicked at / rust backtrace）。错误消息级分析可看 hints 是否命中",
      language: det.language, detectedBy: det.detectedBy, frames: [], appFrames: [], innermostAppFrame: null,
      hints: collectHints(trimmed, [], null), stats: { total: 0, app: 0, external: 0, symbolicated: 0, filesMissing: 0 },
    };
  }

  // 符号索引（一次构建 —— 帧符号化共用；失败不炸分析，enclosing 全 null）
  let symbols: SymbolHit[] = [];
  try {
    symbols = indexSymbols(ws).symbols;
  } catch {
    // 工作区不可读/不存在 —— 符号化诚实缺席（帧与提示照常交付）
  }

  // 帧富化
  const frames: StackFrame[] = capped.map((f) => {
    const language = langOf(f.file);
    const external = isExternalFile(f.file);
    let rel = f.file.replace(/\\/g, "/");
    const wsNorm = path.resolve(ws).replace(/\\/g, "/");
    if (rel.startsWith(wsNorm + "/")) rel = rel.slice(wsNorm.length + 1);
    else if (!external && f.line !== null) {
      // 工作区外但非外部特征：可能就是相对路径（py 栈常见相对形态）—— 尝试 jailed 解析
      const jailed = resolveJailedFile(ws, rel);
      if (jailed.ok) rel = rel.replace(/^\.?\//, "");
    }
    let exists: boolean | null = null;
    let snippet = "";
    let enclosing: StackFrame["enclosing"] = null;
    if (!external && f.line !== null) {
      const jailed = resolveJailedFile(ws, rel);
      if (jailed.ok && jailed.abs) {
        exists = fs.existsSync(jailed.abs);
        if (exists) {
          try {
            const src = fs.readFileSync(jailed.abs, "utf8");
            const srcLine = src.split("\n")[f.line - 1];
            if (srcLine !== undefined) snippet = srcLine.trim().slice(0, SNIPPET_MAX);
          } catch {
            // 读失败（权限/编码）—— snippet 诚实留空
          }
          // 包围符号：同文件 line ≤ 帧行的最近「函数类作用域」定义。
          // 只取 fn/graph/class/impl —— const/type/enum 等非作用域符号
          //（局部 `const v = …` 会误报包围 —— 实测教训）不作候选。
          const SCOPE_KINDS = new Set(["fn", "graph", "class", "impl"]);
          let best: SymbolHit | null = null;
          for (const s of symbols) {
            if (s.file !== rel || s.line > f.line!) continue;
            if (!SCOPE_KINDS.has(s.kind)) continue;
            if (!best || s.line > best.line) best = s;
          }
          if (best) enclosing = { kind: best.kind, name: best.name, defLine: best.line };
        }
      } else if (f.line !== null) {
        // 越界路径 —— 不读盘（jail 铁律）；exists 留 null 表示「未探测」
      }
    }
    return { raw: f.raw, fn: f.fn, file: rel, line: f.line, col: f.col, language, external, exists, snippet, enclosing };
  });

  const appFrames = frames.map((f, i) => (f.external ? -1 : i)).filter((i) => i >= 0);
  const innermostAppFrame = appFrames.length > 0 ? appFrames[0]! : null;
  // JS/PY 栈自顶向下最内层在前；Rust 栈 panic 主位在前。统一取 app 帧中第一个（贴近崩溃点）。
  const symbolicated = frames.filter((f) => f.enclosing !== null).length;
  const filesMissing = frames.filter((f) => f.exists === false).length;

  return {
    ok: true,
    language: det.language,
    detectedBy: det.detectedBy,
    frames,
    appFrames,
    innermostAppFrame,
    hints: collectHints(trimmed, frames, innermostAppFrame),
    stats: { total: frames.length, app: appFrames.length, external: frames.length - appFrames.length, symbolicated, filesMissing },
    ...(truncated ? { truncated: true } : {}),
  };
}

// ---- 自检（纯内存 · 与 dapSelfTest 同款协议）--------------------------------

export interface StackSelfTestCheck { name: string; ok: boolean; detail?: string }
export interface StackSelfTestResult { ok: boolean; passed: number; total: number; checks: StackSelfTestCheck[] }

/** 纯内存自检：解析形状 + 外部分类 + 提示命中 + 帽纪律（不碰磁盘）。 */
export function stackSelfTest(): StackSelfTestResult {
  const checks: StackSelfTestCheck[] = [];
  const js = analyzeStackTrace("/nonexistent-ws", [
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "    at compute (/ws/lib/app.ts:2:12)",
    "    at run (/ws/lib/caller.ts:3:9)",
    "    at node:internal/main/run_main_module:23:47",
  ].join("\n"));
  // 外部帧保留在 frames（上下文面）但计入 stats.external 且不入 appFrames
  checks.push({ name: "JS 帧解析：at fn (file:line:col) + node:internal 外部分类（保留不误伤）", ok: js.ok && js.frames.length === 3 && js.frames[0]!.fn === "compute" && js.frames[0]!.line === 2 && js.stats.external === 1 && js.appFrames.length === 2 && js.frames[2]!.external === true, detail: `frames=${js.frames.length} ext=${js.stats.external}` });
  checks.push({ name: "JS null-deref 提示：high + checklist ≥3 步 + 关联最内层用户帧", ok: js.hints.some((h) => h.id === "js-null-deref" && h.severity === "high" && h.checklist.length >= 3 && h.frames.includes(0)) });
  const py = analyzeStackTrace("/nonexistent-ws", [
    "Traceback (most recent call last):",
    '  File "/ws/lib/mod.py", line 2, in scale',
    "    if v > 0:",
    "KeyError: 'price'",
  ].join("\n"));
  checks.push({ name: "PY 帧解析：File \"…\", line N, in fn", ok: py.language === "py" && py.frames.length === 1 && py.frames[0]!.fn === "scale" && py.frames[0]!.line === 2 });
  checks.push({ name: "PY KeyError 提示命中", ok: py.hints.some((h) => h.id === "py-key") });
  const rs = analyzeStackTrace("/nonexistent-ws", [
    "thread 'main' panicked at src/main.rs:5:9:",
    "called `Option::unwrap()` on a `None` value",
    "stack backtrace:",
  ].join("\n"));
  checks.push({ name: "Rust panic 主位成帧（panic! + file:line:col）", ok: rs.language === "rust" && rs.frames.length === 1 && rs.frames[0]!.fn === "panic!" && rs.frames[0]!.line === 5 });
  checks.push({ name: "Rust unwrap 提示命中（high · 反引号形态）", ok: rs.hints.some((h) => h.id === "rs-unwrap" && h.severity === "high") });
  const cap = analyzeStackTrace("/nonexistent-ws", Array.from({ length: 80 }, (_, i) => `    at f${i} (/ws/lib/x.ts:${i + 1}:1)`).join("\n"));
  checks.push({ name: "帧帽 60 + truncated 诚实标注", ok: cap.frames.length === 60 && cap.truncated === true });
  const empty = analyzeStackTrace("/nonexistent-ws", "  ");
  checks.push({ name: "空输入：ok:false + 指引文案", ok: !empty.ok && (empty.reason ?? "").includes("粘贴") });
  const noFrames = analyzeStackTrace("/nonexistent-ws", "一切正常，没有错误");
  checks.push({ name: "无帧文本：ok:false + 诚实原因（不臆造帧）", ok: !noFrames.ok && noFrames.frames.length === 0 });
  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
