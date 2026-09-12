// ============================================================================
// org/lib/events.ts — 引擎事件流：原始解析 → 归一化 → 合并去重（v0.4.0）
// ----------------------------------------------------------------------------
// 引擎产物三路：
//   events.jsonl  每行 {seq, ts, name, data}（结构化事件，含 name="journal" 的期刊镜像）
//   journal.jsonl 每行 `seq|ts|phase|actor|action|detail` 管道分隔（人读期刊）
//   llm-stream.jsonl 每行 {ts, track, kind: "reasoning"|"content", delta}（v0.4.15
//                  流式增量 —— 宿主流式车道 append-only 落盘，观测面逐 token 渲染）
// 卡片模型 = 三路合并（按 ts 排序，journal 权威、events 内的 journal 镜像去重）。
// 仅用 node:fs / node:path —— Windows 兼容，零原生依赖。
// ============================================================================

import * as fs from "node:fs";

// ---------- 原始行类型 ----------

export interface RawEventLine {
  seq?: number;
  ts: string;
  name: string;
  data: Record<string, unknown>;
}

export interface RawJournalLine {
  seq: number;
  ts: string;
  phase: string;
  actor: string;
  action: string;
  detail: string;
}

/** llm-stream.jsonl 原始行（v0.4.15）：流式增量 —— track 归因，reasoning/content/reset 三通道（reset = 新一次流式调用开始，重试场景观测面清屏重绘）。 */
export interface RawLlmStreamLine {
  ts: string;
  track: string;
  kind: "reasoning" | "content" | "reset";
  delta: string;
}

/** llm-stream.jsonl 单行 → RawLlmStreamLine（不认识的行弃；观测面降级不炸）。 */
export function parseLlmStreamLine(line: string): RawLlmStreamLine | null {
  const s = line.trim();
  if (s.length === 0) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (typeof o.delta !== "string") return null;
    const kind = o.kind === "reasoning" ? "reasoning" : o.kind === "reset" ? "reset" : "content";
    return {
      ts: typeof o.ts === "string" ? o.ts : "",
      track: typeof o.track === "string" ? o.track : "",
      kind,
      delta: o.delta,
    };
  } catch {
    return null;
  }
}

export function parseEventsLine(line: string): RawEventLine | null {
  const s = line.trim();
  if (s.length === 0) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (typeof o.name !== "string") return null;
    return {
      seq: typeof o.seq === "number" ? o.seq : undefined,
      ts: typeof o.ts === "string" ? o.ts : "",
      name: o.name,
      data: (o.data ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** journal.jsonl：`seq|ts|phase|actor|action|detail`（detail 可含 `|`，取末段余量）。 */
export function parseJournalLine(line: string): RawJournalLine | null {
  const s = line.trim();
  if (s.length === 0) return null;
  const parts = s.split("|");
  if (parts.length < 6) return null;
  const seq = Number(parts[0]);
  if (!Number.isFinite(seq)) return null; // 首段非数字 → 不认识的行序，弃
  return {
    seq,
    ts: parts[1] ?? "",
    phase: parts[2] ?? "",
    actor: parts[3] ?? "",
    action: parts[4] ?? "",
    detail: parts.slice(5).join("|"),
  };
}

// ---------- 归一化事件（卡片模型直接消费） ----------

export type EngineEvent =
  | { kind: "run_start"; seq: number; ts: string; entry: string; model: string; task: string; mission?: string }
  | { kind: "journal"; seq: number; ts: string; phase: string; actor: string; action: string; detail: string }
  | { kind: "llm_delta"; seq: number; ts: string; track: string; channel: "reasoning" | "content" | "reset"; delta: string }
  | { kind: "node"; seq: number; ts: string; graph: string; node: string }
  | { kind: "capability_granted"; seq: number; ts: string; capability: string; mode: string }
  | { kind: "score_evidence"; seq: number; ts: string; model: string; axis: string; kind2: string; value: number }
  | { kind: "crystallize_frozen"; seq: number; ts: string; node: string; input: string }
  | { kind: "crystallize_hit"; seq: number; ts: string; node: string; input: string }
  | { kind: "shadow_compare"; seq: number; ts: string; expert: string; candidate: string; baseline: string; agree: boolean }
  | { kind: "canary_confirmed"; seq: number; ts: string; expert: string; version: string }
  | { kind: "fixtures_mined"; seq: number; ts: string; entries: number; tracks: number }
  | { kind: "run_end"; seq: number; ts: string; ok: boolean; elapsed_ms: number }
  // ---- v0.5.0：以下 11 类此前全部落 kind:"unknown"，渲染层 switch 直接丢弃 ----
  // 它们不是边角料：审计（capability_elevated / agent_imported）、能力拒绝、
  // 固化降级、金丝雀回滚、静默更新告警、N 版本冗余对比、补丁回滚失败、运行时
  // panic、以及模型调用的用量收尾（成本面板的数据源）。
  | { kind: "audit"; seq: number; ts: string; event: string; detail: string }
  | { kind: "capability_denied"; seq: number; ts: string; capability: string; reason: string }
  | { kind: "crystallize_degrade"; seq: number; ts: string; node: string; input: string }
  | { kind: "canary_rollback"; seq: number; ts: string; expert: string; version: string; restored: boolean }
  | {
      kind: "redundancy_compare"; seq: number; ts: string;
      a: string; b: string; agree: boolean; coverageA: number; coverageB: number;
    }
  | {
      kind: "score_drift_alert"; seq: number; ts: string;
      model: string; cell: string; previous: number; current: number; threshold: number;
    }
  | { kind: "registry_commit_skipped"; seq: number; ts: string; message: string }
  | { kind: "patch_rollback_failed"; seq: number; ts: string; path: string; message: string }
  | { kind: "run_panic"; seq: number; ts: string; message: string }
  | {
      kind: "llm_stream_done"; seq: number; ts: string; track: string;
      chars: number; reasoningChars: number; elapsedMs: number;
      usage: Record<string, unknown> | null;
    }
  | { kind: "fault"; seq: number; ts: string; action: string; target: string; kind2: string; message: string }
  // ---- v0.5.0：交互式审批队列的四态（请求 / 结论 / 超时 / 长期放行命中）----
  | {
      kind: "approval_requested"; seq: number; ts: string;
      id: string; capability: string; action: string; detail: string; timeoutMs: number;
    }
  | {
      kind: "approval_resolved"; seq: number; ts: string;
      id: string; capability: string; allow: boolean; always: boolean; by: string; waitedMs: number;
    }
  | { kind: "approval_timeout"; seq: number; ts: string; id: string; capability: string; action: string; timeoutMs: number }
  | { kind: "approval_cached"; seq: number; ts: string; capability: string; action: string }
  | { kind: "unknown"; seq: number; ts: string; name: string; data: Record<string, unknown> }
  // 引擎桥合成事件（不在磁盘产物中，wait() 完成前注入流尾）
  | {
      kind: "run_result"; seq: number; ts: string;
      ok: boolean; canceled: boolean; outDir: string;
      elapsed_ms: number; error?: string;
      runJson: Record<string, unknown> | null;
      metrics: RunMetrics | null;
    };

export interface RunMetrics {
  accepted?: number;
  subtasks?: number;
  deliverables?: number;
  assets?: number;
  asset_labels?: string[];
  tokens_total?: number;
  revises_total?: number;
  model_calls_total?: number;
  mined_entries?: number;
  drift_alerts?: number;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** events.jsonl 单行 → EngineEvent（name="journal" 走期刊通道，与 journal.jsonl 同构）。 */
export function normalizeEventLine(raw: RawEventLine): EngineEvent {
  const seq = raw.seq ?? -1;
  const ts = raw.ts ?? "";
  const d = raw.data ?? {};
  switch (raw.name) {
    case "journal":
      return {
        kind: "journal", seq, ts,
        phase: "?", actor: "?",
        action: str(d.name), detail: str(d.detail),
      };
    case "run_start":
      return {
        kind: "run_start", seq, ts,
        entry: str(d.entry), model: str(d.model), task: str(d.task),
        mission: d.mission !== undefined ? str(d.mission) : undefined,
      };
    case "node":
      return { kind: "node", seq, ts, graph: str(d.graph), node: str(d.node) };
    case "capability_granted":
      return { kind: "capability_granted", seq, ts, capability: str(d.capability), mode: str(d.mode) };
    case "score_evidence":
      return {
        kind: "score_evidence", seq, ts, model: str(d.model),
        axis: str(d.axis), kind2: str(d.kind), value: num(d.value),
      };
    case "crystallize_frozen":
      return { kind: "crystallize_frozen", seq, ts, node: str(d.node), input: str(d.input) };
    case "crystallize_hit":
      return { kind: "crystallize_hit", seq, ts, node: str(d.node), input: str(d.input) };
    case "shadow_compare":
      return {
        kind: "shadow_compare", seq, ts,
        expert: str(d.expert), candidate: str(d.candidate_version),
        baseline: str(d.baseline_version), agree: d.agree === true,
      };
    case "canary_confirmed":
      return { kind: "canary_confirmed", seq, ts, expert: str(d.expert), version: str(d.version) };
    case "fixtures_mined":
      return { kind: "fixtures_mined", seq, ts, entries: num(d.entries), tracks: num(d.tracks) };
    case "run_end":
      return { kind: "run_end", seq, ts, ok: d.ok === true, elapsed_ms: num(d.elapsed_ms) };
    // ---- v0.5.0：具名化此前落到 unknown 的 11 类事件 ----
    case "audit":
      return {
        kind: "audit", seq, ts,
        event: str(d.event),
        // 导入线（bridge）带的补充字段拼一段 detail，便于审计展示
        detail: [str(d.name), str(d.format), str(d.path)].filter((x) => x.length > 0).join(" · "),
      };
    case "capability_denied":
      // 两条来源：能力策略（{capability, reason}）与宿主故障注入（{target, reason}）
      return {
        kind: "capability_denied", seq, ts,
        capability: str(d.capability) || str(d.target),
        reason: str(d.reason),
      };
    case "crystallize_degrade":
      return { kind: "crystallize_degrade", seq, ts, node: str(d.node), input: str(d.input) };
    case "canary_rollback":
      return {
        kind: "canary_rollback", seq, ts,
        expert: str(d.expert), version: str(d.version), restored: d.restored === true,
      };
    case "redundancy_compare":
      return {
        kind: "redundancy_compare", seq, ts,
        a: str(d.a), b: str(d.b), agree: d.agree === true,
        coverageA: num(d.coverage_a), coverageB: num(d.coverage_b),
      };
    case "score_drift_alert":
      return {
        kind: "score_drift_alert", seq, ts,
        model: str(d.model), cell: str(d.cell),
        previous: num(d.previous), current: num(d.current), threshold: num(d.threshold),
      };
    case "registry_commit_skipped":
      return { kind: "registry_commit_skipped", seq, ts, message: str(d.message) };
    case "patch_rollback_failed":
      return { kind: "patch_rollback_failed", seq, ts, path: str(d.path), message: str(d.message) };
    case "run_panic":
      return { kind: "run_panic", seq, ts, message: str(d.message) };
    case "llm_stream_done":
      return {
        kind: "llm_stream_done", seq, ts, track: str(d.track),
        chars: num(d.chars), reasoningChars: num(d.reasoning_chars),
        elapsedMs: num(d.elapsed_ms),
        usage: (d.usage ?? null) as Record<string, unknown> | null,
      };
    case "approval_requested":
      return {
        kind: "approval_requested", seq, ts,
        id: str(d.id), capability: str(d.capability), action: str(d.action),
        detail: str(d.detail), timeoutMs: num(d.timeout_ms),
      };
    case "approval_resolved":
      return {
        kind: "approval_resolved", seq, ts,
        id: str(d.id), capability: str(d.capability),
        allow: d.allow === true, always: d.always === true,
        by: str(d.by), waitedMs: num(d.waited_ms),
      };
    case "approval_timeout":
      return {
        kind: "approval_timeout", seq, ts,
        id: str(d.id), capability: str(d.capability), action: str(d.action), timeoutMs: num(d.timeout_ms),
      };
    case "approval_cached":
      return { kind: "approval_cached", seq, ts, capability: str(d.capability), action: str(d.action) };
    case "fault_injected":
    case "fault_rejected":
      return {
        kind: "fault", seq, ts,
        action: raw.name === "fault_injected" ? "injected" : "rejected",
        target: str(d.target), kind2: str(d.kind), message: str(d.message) || str(d.reason),
      };
    default:
      return { kind: "unknown", seq, ts, name: raw.name, data: d };
  }
}

export function normalizeJournalLine(raw: RawJournalLine): EngineEvent {
  return {
    kind: "journal", seq: raw.seq, ts: raw.ts,
    phase: raw.phase, actor: raw.actor, action: raw.action, detail: raw.detail,
  };
}

/** llm-stream 行 → EngineEvent（seq 用文件内行号近似 —— 仅流式渲染，不参与去重）。 */
export function normalizeLlmStreamLine(raw: RawLlmStreamLine, lineNo: number): EngineEvent {
  return { kind: "llm_delta", seq: lineNo, ts: raw.ts, track: raw.track, channel: raw.kind, delta: raw.delta };
}

// ---------- 合并去重与排序 ----------

const journalSig = (ev: EngineEvent): string =>
  ev.kind === "journal" ? `${ev.action}|${ev.detail}` : "";

/**
 * 合并两路事件：journal.jsonl 权威（events 内的 journal 镜像按签名去重），
 * 按 ts 稳定排序（来源行序为并列时的次序）。
 */
export function mergeStreams(
  fromEvents: EngineEvent[],
  fromJournal: EngineEvent[],
): EngineEvent[] {
  const hasJournalFile = fromJournal.length > 0;
  const seen = new Set<string>();
  const out: EngineEvent[] = [];
  const order: EngineEvent[] = [];
  const push = (ev: EngineEvent): void => {
    if (ev.kind === "journal") {
      const sig = journalSig(ev);
      if (sig.length > 0) {
        if (seen.has(sig)) return;
        seen.add(sig);
      }
    }
    out.push(ev);
    order.push(ev);
  };
  if (hasJournalFile) {
    for (const ev of fromEvents) if (ev.kind !== "journal") push(ev);
  } else {
    for (const ev of fromEvents) push(ev);
  }
  for (const ev of fromJournal) push(ev);
  const orderIdx = new Map<EngineEvent, number>();
  order.forEach((ev, i) => orderIdx.set(ev, i));
  out.sort((a, b) => {
    const ta = a.ts || "9999";
    const tb = b.ts || "9999";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0);
  });
  return out;
}

// ---------- 文件读取（全量 + 增量 tail） ----------

export function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n");
  } catch {
    return [];
  }
}

export function readEventStream(eventsFile: string, journalFile: string, llmStreamFile?: string): EngineEvent[] {
  const fromEvents = readLines(eventsFile)
    .map(parseEventsLine)
    .filter((r): r is RawEventLine => r !== null)
    .map(normalizeEventLine);
  const fromJournal = readLines(journalFile)
    .map(parseJournalLine)
    .filter((r): r is RawJournalLine => r !== null)
    .map(normalizeJournalLine);
  const out = mergeStreams(fromEvents, fromJournal);
  // llm-stream 增量按行序追加在尾（时间上晚于同期期刊行；不参与去重）
  if (llmStreamFile) {
    let i = 0;
    for (const line of readLines(llmStreamFile)) {
      const raw = parseLlmStreamLine(line);
      if (raw) out.push(normalizeLlmStreamLine(raw, i));
      i++;
    }
  }
  return out;
}

/** 增量 tail：从 byteOffset 起读新整行（半行留待下次）。 */
export function tailLines(
  file: string,
  offset: number,
): { lines: string[]; next: number } {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], next: offset };
  }
  if (size <= offset) return { lines: [], next: Math.min(offset, size) };
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { lines: [], next: offset };
  }
  let text: string;
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    text = buf.toString("utf-8");
  } catch {
    return { lines: [], next: offset };
  } finally {
    fs.closeSync(fd);
  }
  const nl = text.lastIndexOf("\n");
  if (nl < 0) return { lines: [], next: offset };
  const complete = text.slice(0, nl);
  const next = offset + Buffer.byteLength(complete, "utf-8") + 1;
  return { lines: complete.split("\n").filter((l) => l.length > 0), next };
}
