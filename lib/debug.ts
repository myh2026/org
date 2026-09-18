// ============================================================================
// lib/debug.ts — 断点/调试建议（v0.5.17 · capabilities #108）
// ----------------------------------------------------------------------------
// 「在哪下断点」的建议器 + DAP 协议封装 + 调试计划（debugPlan）：
//   · suggestBreakpoints(ws, file)
//     基于符号索引（lib/symbols.ts）+ 源码行扫描给出建议断点行：
//       - 函数/方法入口行（fn/def/graph —— 符号索引命中，confidence:"symbol"）
//       - if/else 分支行、循环头行（for/while/loop/match —— 源码启发式，
//         confidence:"heuristic"，reason 附最近上方符号作词法归因）
//       - return 前一行（向上找最近一条代码行 —— 观察返回前状态）
//     每条建议带 reason（如「函数 foo 入口」「compute 内 if 分支」）与
//     confidence（符号级 > 启发式级）。语言面：HSL/TS/TSX/PY；其余扩展名
//     诚实空建议 + reason（绝不臆造）。
//   · DAP 消息构造器（Debug Adapter Protocol 的忠实请求形态，与 lib/lsp.ts
//     的 JSON 分帧层共用 —— DAP 帧同样是 Content-Length + JSON body）：
//       makeDapInitialize / makeDapSetBreakpoints / makeDapStackTrace /
//       makeDapThreads（seq 单调、command/arguments 按 DAP 规范字段）。
//   · debugPlan(ws, file)：把断点建议组织成可执行的调试步骤说明
//     （attach → 入口断点 → 分支/循环断点 → 命中后看栈），每步附 DAP
//     协议就绪的 payload（initialize / setBreakpoints / threads /
//     stackTrace 消息序列直接可观测）。
//
// jail 铁律：file 入参必过 resolveJailedFile（lib/lsp.ts 的 pathjail 同源
// 入口）—— 越界即拒（ok:false + reason），绝不静默放行。
//
// 诚实边界（文件头写明）：**不 spawn 真 debug adapter**（沙箱无 node
// --inspect 桥 / debugpy / lldb-dap —— 交付的是协议封装 + 建议器 + 调试
// 计划）；真 DAP attach（进程连接、断点验证回执、变量面板、步进控制）
// 是路线图。断点建议是词法/符号级的 80% 场景启发式 —— 不做数据流/作用域
// 分析（启发式行可能在不可达/注释邻近位置，confidence 字段如实分级）。
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { indexSymbols, type SymbolHit } from "./symbols.ts";
import { resolveJailedFile, LspFrameDecoder, encodeLspMessage } from "./lsp.ts";

// ---- 常量 -------------------------------------------------------------------

/** 建议断点帽（防大文件刷屏；触顶 → truncated:true 诚实标注）。 */
export const MAX_BREAKPOINT_SUGGESTIONS = 60;

/** 支持断点启发式的语言面（与 symbols.ts/completion.ts 的语言面同族）。 */
export type DebugLanguage = "hsl" | "ts" | "py" | "other";

/** 扩展名 → 启发式语言。 */
const LANG_BY_EXT: Record<string, Exclude<DebugLanguage, "other">> = {
  ".hsl": "hsl",
  ".ts": "ts",
  ".tsx": "ts",
  ".py": "py",
};

/** 注释行前缀（symbols.ts 同规）。 */
const COMMENT_RE = /^(?:\/\/|#|--|\*|\/\*)/;

// ---- 类型 -------------------------------------------------------------------

/** 一条断点建议。 */
export interface BreakpointSuggestion {
  /** 1 基行号（DAP linesStartAt1 缺省口径 —— 与编辑器一致）。 */
  line: number;
  kind: "entry" | "branch" | "loop" | "return";
  /** 人读原因（如「函数 compute 入口」「parse 内 if 分支」）。 */
  reason: string;
  /** 符号级（索引命中）> 启发式级（行扫描）。 */
  confidence: "symbol" | "heuristic";
  /** 该行 trim 后 ≤120 字符的原文。 */
  snippet: string;
}

/** suggestBreakpoints 结果。 */
export interface BreakpointSuggestResult {
  ok: boolean;
  /** 工作区相对路径（jail 通过时；正斜杠）。 */
  file: string;
  language: DebugLanguage;
  /** 源码总行数（读盘成功时）。 */
  lines: number;
  suggestions: BreakpointSuggestion[];
  truncated?: boolean;
  reason?: string;
}

/** DAP 请求消息（seq 单调 + type:"request" + command + arguments）。 */
export interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
}

/** 调试计划的一个步骤。 */
export interface DebugPlanStep {
  /** 1 基步骤号。 */
  step: number;
  /** 步骤标题（做什么）。 */
  title: string;
  /** 步骤说明（怎么做/为什么）。 */
  detail: string;
  /** 关联的建议断点（步骤 2+ 才有）。 */
  breakpoints?: BreakpointSuggestion[];
}

/** debugPlan 结果。 */
export interface DebugPlanResult {
  ok: boolean;
  file: string;
  language: DebugLanguage;
  steps: DebugPlanStep[];
  /** 协议就绪的 DAP 消息序列（initialize → setBreakpoints → threads → stackTrace）。 */
  dapMessages: DapRequest[];
  /** 建议断点总数。 */
  suggestions: number;
  reason?: string;
}

// ---- 断点建议器 ----------------------------------------------------------------

/** 入口断点的符号种类（fn=HSL/TS 函数 · PY def 也记 fn；graph=HSL 图入口）。 */
const ENTRY_KINDS = new Set(["fn", "graph"]);

/** 行扫描正则（trim 后锚定；容许行首闭括号前缀 —— `} else {` 形）。 */
const BRANCH_RE: Record<"hsl" | "ts" | "py", RegExp> = {
  hsl: /^(?:\}?\s*)?(?:if\b|else\b|match\b)/,
  ts: /^(?:\}?\s*)?(?:if\s*\(|else\b|switch\s*\(|case\b)/,
  py: /^(?:if\b.*:|elif\b.*:|else\s*:)/,
};
const LOOP_RE: Record<"hsl" | "ts" | "py", RegExp> = {
  hsl: /^(?:for\b|while\b|loop\b)/,
  ts: /^(?:for\s*\(|while\s*\(|do\b)/,
  py: /^(?:for\b.*:|while\b.*:)/,
};
const RETURN_RE: Record<"hsl" | "ts" | "py", RegExp> = {
  hsl: /^return\b/,
  ts: /^return\b/,
  py: /^return\b/,
};

/** 分支关键字提取（剥行首闭括号后取首关键字 —— reason 用；顺序上 else if 先于 else）。 */
const BRANCH_KEYWORD_RE = /^[\}\]]*\s*(else\s+if|elif|if|else|case|match|switch)\b/;
function branchKind(t: string): string {
  const m = BRANCH_KEYWORD_RE.exec(t);
  return m === null ? "if" : m[1]!.replace(/\s+/g, " ");
}

/** 仅闭括号/分号的行（不是好断点 —— return 前行回溯时跳过）。 */
const CLOSE_ONLY_RE = /^[\}\])]+[,;]?$/;

/**
 * 断点建议器：符号索引入口行（symbol 级）+ 源码行扫描（heuristic 级：
 * if/else 分支 · 循环头 · return 前一行）。同行去重（符号级优先）；
 * 按 line 升序确定性输出。jail 越界 / 文件不可读 / 非支持语言 → 诚实
 * ok:false 或空建议 + reason（绝不臆造）。
 */
export function suggestBreakpoints(ws: string, file: string, opts?: { max?: number }): BreakpointSuggestResult {
  const jailed = resolveJailedFile(ws, file);
  if (!jailed.ok) {
    return { ok: false, file: String(file ?? ""), language: "other", lines: 0, suggestions: [], reason: jailed.reason };
  }
  const rel = jailed.rel;
  const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()] ?? "other";
  if (lang === "other") {
    return { ok: true, file: rel, language: "other", lines: 0, suggestions: [], reason: `非支持扩展名（${path.extname(rel) || "无"}）—— 断点启发式面是 .hsl/.ts/.tsx/.py` };
  }
  let text: string;
  try {
    text = fs.readFileSync(jailed.abs, "utf-8");
  } catch (e) {
    return { ok: false, file: rel, language: lang, lines: 0, suggestions: [], reason: `文件不可读：${(e as Error).message}` };
  }
  const lines = (text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text).split("\n");
  const max = typeof opts?.max === "number" && Number.isFinite(opts.max)
    ? Math.max(1, Math.min(MAX_BREAKPOINT_SUGGESTIONS, Math.floor(opts.max)))
    : MAX_BREAKPOINT_SUGGESTIONS;

  // 1) 符号级入口断点（该文件的 fn/def/graph 命中）
  const idx = indexSymbols(ws, [""]);
  const fileSymbols = idx.symbols
    .filter((s) => s.file === rel && ENTRY_KINDS.has(s.kind))
    .sort((a, b) => a.line - b.line);
  const byLine = new Map<number, BreakpointSuggestion>();
  for (const s of fileSymbols) {
    const label = s.kind === "graph" ? "图" : "函数";
    byLine.set(s.line, {
      line: s.line,
      kind: "entry",
      reason: `${label} ${s.name} 入口`,
      confidence: "symbol",
      snippet: (lines[s.line - 1] ?? s.snippet).trim().slice(0, 120),
    });
  }

  // 2) 启发式级行扫描（if/else 分支 · 循环头 · return 前一行）
  //    词法归因：最近上方的同文件符号（不追作用域 —— 启发式如实分级）。
  const nearestSymbolAbove = (line: number): SymbolHit | null => {
    let best: SymbolHit | null = null;
    for (const s of idx.symbols.filter((s) => s.file === rel)) {
      if (s.line <= line && (best === null || s.line > best.line)) best = s;
    }
    return best;
  };
  const suggest = (line: number, kind: "branch" | "loop" | "return", reason: string): void => {
    if (byLine.has(line)) return; // 同行去重（符号级优先）
    const raw = lines[line - 1];
    if (raw === undefined) return;
    const t = raw.trim();
    if (t.length === 0 || COMMENT_RE.test(t)) return; // 空行/注释行不是好断点
    byLine.set(line, {
      line,
      kind,
      reason,
      confidence: "heuristic",
      snippet: t.slice(0, 120),
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length === 0 || COMMENT_RE.test(t)) continue;
    const line = i + 1;
    const owner = nearestSymbolAbove(line);
    const where = owner ? `${owner.name} 内` : "顶层";
    if (BRANCH_RE[lang].test(t)) suggest(line, "branch", `${where} ${branchKind(t)} 分支`);
    if (LOOP_RE[lang].test(t)) suggest(line, "loop", `${where} 循环头`);
    if (RETURN_RE[lang].test(t)) {
      // return 前一行：向上找最近一条代码行（跳过空行/注释/仅闭括号行）
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]!.trim();
        if (prev.length === 0 || COMMENT_RE.test(prev) || CLOSE_ONLY_RE.test(prev)) continue;
        suggest(j + 1, "return", `${where} return 前一行（观察返回前状态）`);
        break;
      }
    }
  }

  const all = [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, max);
  return {
    ok: true,
    file: rel,
    language: lang,
    lines: lines.length,
    suggestions: all,
    ...(all.length >= max && byLine.size > max ? { truncated: true } : {}),
    ...(all.length === 0 ? { reason: "未发现可建议的断点行（无入口符号且无分支/循环/return 结构）" } : {}),
  };
}

// ---- DAP 消息构造器 -------------------------------------------------------------

/** DAP initialize 可选项。 */
export interface DapInitializeOptions {
  clientID?: string;
  clientName?: string;
  /** 目标 adapter 标识（DAP 规范必填，如 "node"/"debugpy"/"corelldb"）。 */
  adapterID?: string;
  locale?: string;
  /** 缺省 true（与 DAP 规范一致）。 */
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  /** 缺省 "path"。 */
  pathFormat?: "path" | "uri";
}

/** DAP initialize 请求（规范忠实：adapterID 必填 · pathFormat/lines/columns 缺省）。 */
export function makeDapInitialize(seq: number, opts: DapInitializeOptions = {}): DapRequest {
  return {
    seq,
    type: "request",
    command: "initialize",
    arguments: {
      adapterID: opts.adapterID ?? "org",
      clientID: opts.clientID ?? "org-debug-client",
      clientName: opts.clientName ?? "ORG Debug Plan (v0.5.17)",
      locale: opts.locale ?? "en",
      linesStartAt1: opts.linesStartAt1 ?? true,
      columnsStartAt1: opts.columnsStartAt1 ?? true,
      pathFormat: opts.pathFormat ?? "path",
      supportsVariableType: false,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
    },
  };
}

/**
 * DAP setBreakpoints 请求：一个源文件 + 断点行数组。规范形态：
 * arguments.source.path + arguments.breakpoints[{line}]（lines 数组是
 * 规范的历史兼容字段 —— 两者一并给出，兼容新旧 adapter）。
 */
export function makeDapSetBreakpoints(seq: number, file: string, lines: number[], opts?: { sourceModified?: boolean }): DapRequest {
  return {
    seq,
    type: "request",
    command: "setBreakpoints",
    arguments: {
      source: { path: file },
      lines: [...lines],
      breakpoints: lines.map((line) => ({ line })),
      ...(opts?.sourceModified !== undefined ? { sourceModified: opts.sourceModified } : {}),
    },
  };
}

/** DAP stackTrace 请求（threadId 必填 —— 缺省 1；startFrame/levels 分页）。 */
export function makeDapStackTrace(seq: number, opts?: { threadId?: number; startFrame?: number; levels?: number }): DapRequest {
  return {
    seq,
    type: "request",
    command: "stackTrace",
    arguments: {
      threadId: opts?.threadId ?? 1,
      startFrame: opts?.startFrame ?? 0,
      levels: opts?.levels ?? 20,
    },
  };
}

/** DAP threads 请求（规范固定空 arguments）。 */
export function makeDapThreads(seq: number): DapRequest {
  return { seq, type: "request", command: "threads", arguments: {} };
}

// ---- 调试计划 -------------------------------------------------------------------

/**
 * 调试计划：把断点建议组织成可执行的调试步骤（attach → 入口断点 →
 * 分支/循环断点 → 命中后看调用栈），每步说明做什么/为什么；dapMessages
 * 给出协议就绪的消息序列（initialize → setBreakpoints（全部建议行一次
 * 设置）→ threads → stackTrace）—— 与真 debug adapter 对话时按序发送即
 * 可复现该计划。诚实边界：真 attach 是路线图（沙箱无 adapter），本计划
 * 的「可执行」指协议序列忠实 + 步骤说明可照做。
 */
export function debugPlan(ws: string, file: string, opts?: { maxBreakpoints?: number }): DebugPlanResult {
  const suggest = suggestBreakpoints(ws, file, { max: opts?.maxBreakpoints });
  if (!suggest.ok) {
    return { ok: false, file: String(file ?? ""), language: "other", steps: [], dapMessages: [], suggestions: 0, reason: suggest.reason };
  }
  const steps: DebugPlanStep[] = [];
  const abs = path.resolve(ws, suggest.file);
  const entries = suggest.suggestions.filter((s) => s.kind === "entry");
  const branches = suggest.suggestions.filter((s) => s.kind === "branch");
  const loops = suggest.suggestions.filter((s) => s.kind === "loop");
  const returns = suggest.suggestions.filter((s) => s.kind === "return");

  steps.push({
    step: 1,
    title: "attach：初始化 DAP 会话",
    detail: `向 debug adapter 发 initialize（adapterID="org"、linesStartAt1=true、pathFormat="path"），随后按需 launch/attach 目标进程 —— 真 adapter attach（node --inspect / debugpy / lldb-dap）是路线图，沙箱内本步骤只交付协议就绪的消息形态。`,
  });
  if (entries.length > 0) {
    steps.push({
      step: steps.length + 1,
      title: `入口断点：${entries.length} 处（符号级 · 高置信）`,
      detail: `在 ${entries.map((s) => `${s.reason}（${suggest.file}:${s.line}）`).join("；")} 设断点 —— 函数/图入口是观察入参与前置状态的第一站。`,
      breakpoints: entries,
    });
  }
  if (branches.length > 0) {
    steps.push({
      step: steps.length + 1,
      title: `分支断点：${branches.length} 处（启发式）`,
      detail: `if/else/case/match 分支行 —— 命中即知走了哪条路径：${branches.slice(0, 6).map((s) => `${suggest.file}:${s.line} ${s.reason}`).join("；")}${branches.length > 6 ? " …" : ""}`,
      breakpoints: branches,
    });
  }
  if (loops.length > 0) {
    steps.push({
      step: steps.length + 1,
      title: `循环断点：${loops.length} 处（启发式）`,
      detail: `循环头行 —— 观察每轮迭代状态与终止条件：${loops.slice(0, 6).map((s) => `${suggest.file}:${s.line} ${s.reason}`).join("；")}${loops.length > 6 ? " …" : ""}`,
      breakpoints: loops,
    });
  }
  if (returns.length > 0) {
    steps.push({
      step: steps.length + 1,
      title: `return 前断点：${returns.length} 处（启发式）`,
      detail: `return 前一行 —— 观察返回前状态（局部变量终值/副作用已否）：${returns.slice(0, 6).map((s) => `${suggest.file}:${s.line}`).join("、")}${returns.length > 6 ? " …" : ""}`,
      breakpoints: returns,
    });
  }
  steps.push({
    step: steps.length + 1,
    title: "命中后：threads → stackTrace 看调用栈",
    detail: "断点命中后先 threads 取线程清单，再 stackTrace（startFrame=0, levels=20）逐层看调用栈；栈帧变量检查（variables 请求）随后续版本接入。",
  });
  steps.push({
    step: steps.length + 1,
    title: "收尾：disconnect",
    detail: "调试结束发 disconnect（terminateDebuggee=false）—— 让目标进程与 adapter 会话干净收场。",
  });

  const dapMessages: DapRequest[] = [
    makeDapInitialize(1),
    makeDapSetBreakpoints(2, abs, suggest.suggestions.map((s) => s.line)),
    makeDapThreads(3),
    makeDapStackTrace(4),
  ];
  return {
    ok: true,
    file: suggest.file,
    language: suggest.language,
    steps,
    dapMessages,
    suggestions: suggest.suggestions.length,
    ...(suggest.suggestions.length === 0 ? { reason: suggest.reason } : {}),
  };
}

// ---- DAP 自检 --------------------------------------------------------------------

/** makeDap* 构造器自检结果（与 lib/lsp.ts protocolSelfTest 同形）。 */
export interface DapSelfTestResult {
  ok: boolean;
  passed: number;
  total: number;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * DAP 构造器自检（CLI `org debug dap --self-test` / Web dap-selftest 数据源）：
 * 字段忠实性断言 + 与 lib/lsp.ts 分帧层的共用验证（DAP 消息走同一
 * Content-Length 编解码往返）。纯内存零副作用。
 */
export function dapSelfTest(): DapSelfTestResult {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const t = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const init = makeDapInitialize(1, { adapterID: "node" });
  t(
    "initialize 字段忠实",
    init.seq === 1 && init.type === "request" && init.command === "initialize"
      && init.arguments!.adapterID === "node" && init.arguments!.linesStartAt1 === true
      && init.arguments!.columnsStartAt1 === true && init.arguments!.pathFormat === "path"
      && typeof init.arguments!.clientID === "string",
  );
  const sbp = makeDapSetBreakpoints(2, "/ws/src/app.ts", [3, 10, 42]);
  t(
    "setBreakpoints 字段忠实",
    sbp.seq === 2 && sbp.command === "setBreakpoints" && sbp.arguments!.source.path === "/ws/src/app.ts"
      && JSON.stringify(sbp.arguments!.lines) === JSON.stringify([3, 10, 42])
      && JSON.stringify(sbp.arguments!.breakpoints) === JSON.stringify([{ line: 3 }, { line: 10 }, { line: 42 }]),
  );
  const st = makeDapStackTrace(3, { levels: 5 });
  t(
    "stackTrace 字段忠实",
    st.seq === 3 && st.command === "stackTrace" && st.arguments!.threadId === 1
      && st.arguments!.startFrame === 0 && st.arguments!.levels === 5,
  );
  const th = makeDapThreads(4);
  t("threads 字段忠实", th.seq === 4 && th.command === "threads" && JSON.stringify(th.arguments) === "{}");
  t("seq 单调递增", [init.seq, sbp.seq, st.seq, th.seq].every((v, i, arr) => i === 0 || v > arr[i - 1]!));

  // 与 lib/lsp.ts 分帧层共用：DAP 消息走同一 Content-Length 编解码往返
  {
    const frame = encodeLspMessage(sbp); // DAP 消息体不含 jsonrpc 字段 —— 分帧层照收
    const decoder = new LspFrameDecoder();
    const back = decoder.push(frame);
    t(
      "DAP 消息复用 LSP 分帧往返",
      back.length === 1 && (back[0] as DapRequest).command === "setBreakpoints" && (back[0] as DapRequest).seq === 2,
    );
  }
  // setBreakpoints 行号口径：1 基（与 DAP linesStartAt1 缺省一致）
  {
    const s = makeDapSetBreakpoints(5, "x.hsl", [1]);
    t("断点行 1 基口径（linesStartAt1）", s.arguments!.breakpoints![0]!.line === 1);
  }

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
