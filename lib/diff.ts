// ============================================================================
// lib/diff.ts — unified diff 渲染器（v0.5.15 · capabilities #49/#60）
// ----------------------------------------------------------------------------
// 「diff 预览 + 编辑干跑模式」的纯函数内核，零第三方依赖：
//   · diffText(old, new)      行级 diff（LCS 内核 + 大文件快速路径）
//   · diffFiles(old, new)     文件版三态降级（missing / binary / read；
//                             oldFile 允许不存在 = 全新增 —— 新文件首演预览）
//   · renderUnified(result)   标准 unified diff 文本（--- a/x · +++ b/x · @@ 头）
//   · renderStats(result)     单文件一行摘要（+12 −4 · 2 hunks）
// 计划消费入口：CLI 编辑预览、Web 干跑面板、工具环 dry_run 工具。
//
// 算法（分层防线，性能保护绝不卡死）：
//   1. CRLF 归一：\r\n → \n（孤立 \r 一并归一 —— 跨平台行尾统一）
//   2. 公共头/尾剥离 O(N+M)：把 LCS 问题缩小到「中段」
//   3. 行内联哈希（intern：字符串行 → 整数 ID）——「公共头尾剥离 + 哈希分块」
//      快速路径的前半：DP 内的行比较从字符串等值降为整数等值
//   4. 中段两侧均 ≤ 2000 行：逐行 LCS 动态规划，O(P·Q) 时间/空间
//      （≤ 2001×2001 ≈ 400 万格 Int32Array ≈ 16MB，毫秒级）
//   5. 中段任一侧 > 2000 行：诚实降级为「整段替换」单 hunk（O(P+Q)）——
//      这是快速路径而非截断（truncated:false），最优 diff 让位于不卡死承诺
//
// 优雅降级：文本相同（含仅行尾差异）→ identical 直返；输出超 maxLines
// （缺省 4000，含 @@ 头行）→ truncated:true，按 hunk 整体丢弃保持每段自
// 包含可渲染（首个 hunk 单独超帽才硬切保头）。统计口径：hunks/adds/dels
// 始终是全量 diff 口径 —— 干跑模式要的是完整影响面；lines 才是可能被
// 截断的渲染面。
// ============================================================================

import * as fs from "node:fs";

// ---- 常量（预算面）----------------------------------------------------------

/** LCS 动态规划的中段行数上限（任一侧超过 → 整段替换快速路径）。 */
const LCS_LIMIT = 2000;

/** 缺省上下文行数（unified diff 惯例 3）。 */
const DEFAULT_CONTEXT = 3;

/** 缺省输出行数帽（含 @@ 头行；超出 → truncated:true）。 */
const DEFAULT_MAX_LINES = 4000;

// ---- 类型 -------------------------------------------------------------------

/** 一行 diff 输出：context=公共行 · add=新增 · del=删除 · hunk=@@ 头。 */
export interface DiffLine {
  kind: "context" | "add" | "del" | "hunk";
  /** 行内容（hunk 行为 `@@ -l,c +l,c @@` 头本身；其余为原始行文本，无前缀）。 */
  text: string;
  /** 旧文件行号（1 基；context/del 行有值）。 */
  oldNo?: number;
  /** 新文件行号（1 基；context/add 行有值）。 */
  newNo?: number;
}

/** diff 结果：统计为全量口径，lines 为可能截断的渲染面。 */
export interface DiffResult {
  /** hunk 总数（全量口径 —— 即使 lines 被 maxLines 截断）。 */
  hunks: number;
  /** 新增行数（全量口径）。 */
  adds: number;
  /** 删除行数（全量口径）。 */
  dels: number;
  /** 渲染行（hunk 头 + 上下文 + 变更行；可能被 maxLines 截断）。 */
  lines: DiffLine[];
  /** 输出是否被 maxLines 截断。 */
  truncated: boolean;
  /** 两文本是否完全相同（CRLF 归一后）。 */
  identical: boolean;
}

/** diffFiles 结果：成功 / 三态降级（missing · binary · read）。 */
export type DiffFilesResult =
  | { ok: true; result: DiffResult }
  | { ok: false; error: string; kind: "missing" | "binary" | "read" };

// ---- 小工具 -----------------------------------------------------------------

/** CRLF 归一：\r\n → \n；孤立 \r（老 Mac / 混合行尾）也归一为 \n。 */
function normalizeEol(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** 行切分：尾随换行不产生幻影空行（"a\n" → ["a"]，"a\n\n" → ["a",""]）。 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** 数值选项消毒：非有限数回落缺省；下限钳制（负 context/maxLines 无意义）。 */
function saneInt(v: number | undefined, dflt: number, min: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : dflt;
}

/** 错误消息提取（catch 不逃逸原则的伴随件）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- LCS 内核 ----------------------------------------------------------------

/** 编辑操作：eq=公共行 · del=旧侧独有 · ins=新侧独有（i/j 为中段下标）。 */
type EditOp =
  | { t: "eq"; i: number; j: number }
  | { t: "del"; i: number }
  | { t: "ins"; j: number };

/** 中段 LCS 编辑脚本。
 *
 *  复杂度：O(P·Q) 时间 / O(P·Q) 空间（P,Q 为剥离公共头尾后的中段行数，
 *  调用方保证 ≤ LCS_LIMIT → ≤ 2001×2001 ≈ 400 万格 Int32Array ≈ 16MB）。
 *
 *  DP 自后向前填表（dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度），再自前向后
 *  回溯出编辑脚本；并列时删除优先于插入 —— del 排在 add 前，符合 unified
 *  diff「先删后增」的展示惯例。输入为内联哈希后的整数行 ID（intern），
 *  比较是 O(1) 整数等值而非字符串等值。 */
function lcsOps(a: number[], b: number[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", i, j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: "del", i });
      i++;
    } else {
      ops.push({ t: "ins", j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: "del", i });
    i++;
  }
  while (j < m) {
    ops.push({ t: "ins", j });
    j++;
  }
  return ops;
}

// ---- 核心：diffText -----------------------------------------------------------

/** 两文本行级 diff。
 *
 *  @param oldText 旧文本（CRLF 自动归一）
 *  @param newText 新文本（CRLF 自动归一）
 *  @param opts.context  上下文行数（缺省 3）
 *  @param opts.maxLines 输出行数帽（含 @@ 头，缺省 4000；超出 truncated:true）
 *
 *  快速路径：公共头尾剥离后中段任一侧 > 2000 行 → 整段替换单 hunk
 *  （不是截断 —— truncated 仍由 maxLines 决定；性能保护优先于最优 diff）。 */
export function diffText(
  oldText: string,
  newText: string,
  opts?: { context?: number; maxLines?: number },
): DiffResult {
  const context = saneInt(opts?.context, DEFAULT_CONTEXT, 0);
  const maxLines = saneInt(opts?.maxLines, DEFAULT_MAX_LINES, 0);

  const a = splitLines(normalizeEol(oldText));
  const b = splitLines(normalizeEol(newText));

  // identical 直返（归一后逐行等值 —— 零成本短路）
  if (a.length === b.length) {
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return { hunks: 0, adds: 0, dels: 0, lines: [], truncated: false, identical: true };
    }
  }

  // 1) 公共头/尾剥离 O(N+M)：p=公共前缀行数，s=公共后缀行数（先榨干前缀
  //    再榨后缀，保证中段两侧不可能再压缩）
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const midA = a.slice(p, a.length - s);
  const midB = b.slice(p, b.length - s);

  // 2) 中段 → 编辑脚本（LCS DP 或整段替换快速路径）
  let ops: EditOp[];
  if (midA.length > LCS_LIMIT || midB.length > LCS_LIMIT) {
    // 快速路径：中段过大，DP 预算（~16MB / 400 万格）守不住 —— 整段替换，
    // O(P+Q)。诚实降级：diff 语义上仍是完整的（只是不找中段内的公共行）。
    ops = [];
    for (let i = 0; i < midA.length; i++) ops.push({ t: "del", i });
    for (let j = 0; j < midB.length; j++) ops.push({ t: "ins", j });
  } else {
    // 行内联哈希（intern）：字符串行 → 整数 ID，公共行共享同一 ID
    const ids = new Map<string, number>();
    const idOf = (line: string): number => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    };
    ops = lcsOps(midA.map(idOf), midB.map(idOf));
  }

  // 3) 编辑脚本 → 有序行数组（头/尾上下文从剥离区回借，每侧至多 context 行）
  const entries: DiffLine[] = [];
  for (let k = Math.max(0, p - context); k < p; k++) {
    entries.push({ kind: "context", text: a[k]!, oldNo: k + 1, newNo: k + 1 });
  }
  let adds = 0;
  let dels = 0;
  for (const op of ops) {
    if (op.t === "eq") {
      entries.push({ kind: "context", text: midA[op.i]!, oldNo: p + op.i + 1, newNo: p + op.j + 1 });
    } else if (op.t === "del") {
      entries.push({ kind: "del", text: midA[op.i]!, oldNo: p + op.i + 1 });
      dels++;
    } else {
      entries.push({ kind: "add", text: midB[op.j]!, newNo: p + op.j + 1 });
      adds++;
    }
  }
  for (let k = 0; k < Math.min(context, s); k++) {
    const idx = a.length - s + k;
    entries.push({ kind: "context", text: a[idx]!, oldNo: idx + 1, newNo: idx + 1 });
  }

  // 4) 变更分组 → hunk：相邻变更间隔 ≤ 2·context 个上下文行则并入同一 hunk
  //    （GNU diff 惯例：两段上下文恰好相接时不拆分）
  //    hunk 头行号：非空侧取 hunk 内首个行号（entries 不含被剥离的公共
  //    头尾，不能用「前缀计数 + 1」推）；空侧（纯增/纯删）锚定到前一
  //    行 —— entries 前部最后一个行号，无则回退公共前缀行数 p（文件头部
  //    则为 0），与 git `@@ -0,0 +1,n @@` / `@@ -1,2 +0,0 @@` 同形。
  const changes: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind !== "context") changes.push(i);
  }
  const hunkLines: DiffLine[][] = [];
  let g = 0;
  while (g < changes.length) {
    let last = changes[g]!;
    let k = g + 1;
    while (k < changes.length && changes[k]! - last - 1 <= 2 * context) {
      last = changes[k]!;
      k++;
    }
    const start = Math.max(0, changes[g]! - context);
    const end = Math.min(entries.length, last + context + 1);
    let firstOld: number | undefined;
    let firstNew: number | undefined;
    let lastOldBefore: number | undefined;
    let lastNewBefore: number | undefined;
    for (let i = 0; i < start; i++) {
      if (entries[i]!.oldNo !== undefined) lastOldBefore = entries[i]!.oldNo;
      if (entries[i]!.newNo !== undefined) lastNewBefore = entries[i]!.newNo;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i < end; i++) {
      const e = entries[i]!;
      if (e.oldNo !== undefined) {
        oldCount++;
        if (firstOld === undefined) firstOld = e.oldNo;
      }
      if (e.newNo !== undefined) {
        newCount++;
        if (firstNew === undefined) firstNew = e.newNo;
      }
    }
    const oldStart = oldCount > 0 ? firstOld! : (lastOldBefore ?? p);
    const newStart = newCount > 0 ? firstNew! : (lastNewBefore ?? p);
    const header: DiffLine = {
      kind: "hunk",
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    };
    const block: DiffLine[] = [header];
    for (let i = start; i < end; i++) block.push(entries[i]!);
    hunkLines.push(block);
    g = k;
  }

  // 5) 装配 + maxLines 截断：优先整 hunk 收录（每段自包含可渲染）；仅当首
  //    个 hunk 单独超帽才硬切保头（truncated 诚实标注）
  const lines: DiffLine[] = [];
  let truncated = false;
  for (const block of hunkLines) {
    if (lines.length + block.length > maxLines) {
      truncated = true;
      if (lines.length === 0) {
        for (const l of block) {
          if (lines.length >= maxLines) break;
          lines.push(l);
        }
      }
      break;
    }
    for (const l of block) lines.push(l);
  }

  return { hunks: hunkLines.length, adds, dels, lines, truncated, identical: false };
}

// ---- 文件版 ------------------------------------------------------------------

/** 双文件 diff（读文件 + 三态降级）。
 *
 *  降级语义：
 *   · oldFile 不存在 → 允许（全新增：新文件首演 / 模板落盘前的预览）
 *   · newFile 不存在 → kind:"missing"
 *   · 任一文件含 NUL（\0）→ kind:"binary"（全量嗅探 —— diff 面向文本编辑）
 *   · 读取失败（权限 / 路径是目录等）→ kind:"read"
 *
 *  @param opts.context 上下文行数（透传 diffText；maxLines 用其缺省 4000） */
export function diffFiles(
  oldFile: string,
  newFile: string,
  opts?: { context?: number },
): DiffFilesResult {
  let oldBuf: Buffer | null = null;
  if (fs.existsSync(oldFile)) {
    try {
      oldBuf = fs.readFileSync(oldFile);
    } catch (e) {
      return { ok: false, error: `旧文件读取失败：${oldFile}（${errMsg(e)}）`, kind: "read" };
    }
  }
  if (!fs.existsSync(newFile)) {
    return {
      ok: false,
      error: `新文件不存在：${newFile}${oldBuf === null ? "（旧文件也不存在）" : ""}`,
      kind: "missing",
    };
  }
  let newBuf: Buffer;
  try {
    newBuf = fs.readFileSync(newFile);
  } catch (e) {
    return { ok: false, error: `新文件读取失败：${newFile}（${errMsg(e)}）`, kind: "read" };
  }
  if (oldBuf !== null && oldBuf.includes(0)) {
    return { ok: false, error: `旧文件是二进制（含 NUL）：${oldFile}`, kind: "binary" };
  }
  if (newBuf.includes(0)) {
    return { ok: false, error: `新文件是二进制（含 NUL）：${newFile}`, kind: "binary" };
  }
  const result = diffText(oldBuf === null ? "" : oldBuf.toString("utf-8"), newBuf.toString("utf-8"), {
    context: opts?.context,
  });
  return { ok: true, result };
}

// ---- 渲染 --------------------------------------------------------------------

/** 渲染为标准 unified diff 文本。
 *
 *  格式：`--- a/<oldName>` · `+++ b/<newName>` 头 + `@@ -l,c +l,c @@` hunk
 *  头 + 前缀行（" "=context · "-"=del · "+"=add）。identical → 空串
 *  （git 惯例：无差异无输出）；truncated 的 result 原样渲染已收录部分。 */
export function renderUnified(result: DiffResult, oldName: string, newName: string): string {
  if (result.identical) return "";
  const prefixOf = (l: DiffLine): string =>
    l.kind === "del" ? "-" : l.kind === "add" ? "+" : l.kind === "context" ? " " : "";
  let out = `--- a/${oldName}\n+++ b/${newName}\n`;
  for (const l of result.lines) out += `${prefixOf(l)}${l.text}\n`;
  return out;
}

/** 单文件一行摘要：`+12 −4 · 2 hunks`（− 为 U+2212 数学减号，与 + 视觉等宽）。
 *  identical → 「无变化」；truncated → 追加「 · 已截断」。 */
export function renderStats(result: DiffResult): string {
  if (result.identical) return "无变化";
  const hunks = result.hunks === 1 ? "1 hunk" : `${result.hunks} hunks`;
  return `+${result.adds} −${result.dels} · ${hunks}${result.truncated ? " · 已截断" : ""}`;
}
