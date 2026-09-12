// ============================================================================
// org/lib/runCards.ts — 运行事件 → 卡片 的**解析契约**（纯函数，无状态）
// ----------------------------------------------------------------------------
// 为什么单独一层：TUI 与 Web GUI 都要把同一条引擎事件流渲染成「卡片叙事」
// （任务树 + A/B/C/D 路由徽标 / 工厂 stepper / 四态裁决 / 固化 / 补丁 / 资产 /
// done 成本衰减）。两端的**渲染**必然不同（终端 vs DOM），但**解析**必须同源
// —— 否则同一次运行在两个前端会显示成两件事（detail 文本是 `|` 分隔的
// 自由字段，正则一旦各自演化就会静默错配）。
//
// 因此本模块只放「契约」：路由/裁决的类型与标签、事件 detail 的正则与
// 逐字段解析。渲染层各自实现，但都从这里取料。
//
// 事件 detail 的真实形态（来自 hsl/org.hsl 的 journal.log）：
//   route        task#3 validate -> C:generate
//   dispatch     task#2 channel=reuse notice-parser
//                task#1 channel=inline (kernel context)
//                task#3 channel=factory mint
//   review       task#3 validate verdict=Revise coverage=0.80
//   re-dispatch  task#3 revise #1: remedy: count date_status=unparsed as valid
//   mint-register record-validator@1.0.0 eval=1
//   direct_ctx   notice-parser/demo turn=2 ctx=141 window=131072
//   drift        静默更新检测：alerts=0 baseline=registry/scorecards/baseline-x.json
// ============================================================================

/** 路由四态：A 内联 / B 复用 / C 生成 / D 移交。 */
export type RoutePath = "A" | "B" | "C" | "D";

/** 语义裁决四态（与 hsl/contracts/contract.hsl 的 Verdict 同名同序）。 */
export type Verdict = "Accept" | "Revise" | "Reject" | "Escalate";

const ROUTE_LABEL: Record<RoutePath, string> = { A: "内联", B: "复用", C: "生成", D: "移交" };

/** 路由徽标的可读标签（两端共用同一措辞）。 */
export const routeLabel = (r: RoutePath): string => ROUTE_LABEL[r];

const VERDICTS: readonly Verdict[] = ["Accept", "Revise", "Reject", "Escalate"];

/** 裁决文本 → 四态（大小写无关；不认识的值回落 Accept，与解析侧同宽容策略）。 */
export function parseVerdict(s: string): Verdict {
  const v = s.trim().toLowerCase();
  return VERDICTS.find((x) => x.toLowerCase() === v) ?? "Accept";
}

// ---------- 正则（契约的唯一来源） ----------

/** `task#3 validate -> C:generate` */
export const RE_ROUTE = /^task#(\d+)\s+(\S+)\s*->\s*([ABCD]):(\S+)/;
/** `task#2 channel=reuse notice-parser` / `task#1 channel=inline (kernel context)` */
export const RE_DISPATCH = /^task#(\d+)\s+channel=(\S+)(?:\s+(.*))?$/;
/** `task#3 validate verdict=Revise coverage=0.80` */
export const RE_REVIEW = /^task#(\d+)\s+(\S+)\s+verdict=(\S+)(?:\s+coverage=([\d.]+))?(?:\s+(.*))?$/;
/** `task#3 revise #1: remedy: ...` */
export const RE_REDISPATCH = /^task#(\d+)\s+revise\s+#(\d+):\s*(.*)$/;
/** `record-validator@1.0.0 eval=1`（有界的域名：不吞空格） */
export const RE_MINT = /^([^@\s]+)@(\S+?)(?:\s+eval=(\S+))?\s*$/;
/** `notice-parser/demo turn=2 ctx=141 window=131072` */
export const RE_CTX = /^(\S+)\/(\S+) turn=(\d+) ctx=(\d+) window=(\d+)$/;
/** `静默更新检测：alerts=0 baseline=...` */
export const RE_DRIFT = /alerts=(\d+)/;

// ---------- 逐字段解析（返回 null = 不认识，调用方原样忽略） ----------

export interface RouteFact {
  id: number;
  role: string;
  route: RoutePath;
  channel: string;
}

export function parseRoute(detail: string): RouteFact | null {
  const m = RE_ROUTE.exec(detail);
  if (!m) return null;
  return { id: Number(m[1]), role: m[2] ?? "", route: (m[3] ?? "A") as RoutePath, channel: m[4] ?? "" };
}

export interface DispatchFact {
  id: number;
  channel: string;
  detail: string;
}

export function parseDispatch(detail: string): DispatchFact | null {
  const m = RE_DISPATCH.exec(detail);
  if (!m) return null;
  return { id: Number(m[1]), channel: m[2] ?? "", detail: m[3] ?? "" };
}

export interface ReviewFact {
  id: number;
  role: string;
  verdict: Verdict;
  coverage?: number;
  note: string;
}

export function parseReview(detail: string): ReviewFact | null {
  const m = RE_REVIEW.exec(detail);
  if (!m) return null;
  return {
    id: Number(m[1]),
    role: m[2] ?? "",
    verdict: parseVerdict(m[3] ?? ""),
    coverage: m[4] !== undefined ? Number(m[4]) : undefined,
    note: m[5] ?? "",
  };
}

export interface ReDispatchFact {
  id: number;
  attempt: number;
  remedy: string;
}

export function parseReDispatch(detail: string): ReDispatchFact | null {
  const m = RE_REDISPATCH.exec(detail);
  if (!m) return null;
  return { id: Number(m[1]), attempt: Number(m[2]), remedy: m[3] ?? "" };
}

export interface MintFact {
  name: string;
  version: string;
  eval: string;
}

export function parseMint(detail: string): MintFact | null {
  const m = RE_MINT.exec(detail);
  if (!m) return null;
  return { name: m[1]!, version: m[2]!, eval: m[3] ?? "" };
}

export interface CtxFact {
  expert: string;
  session: string;
  turn: number;
  ctx: number;
  window: number;
}

export function parseCtx(detail: string): CtxFact | null {
  const m = RE_CTX.exec(detail);
  if (!m) return null;
  return {
    expert: m[1]!, session: m[2]!,
    turn: Number(m[3]), ctx: Number(m[4]), window: Number(m[5]),
  };
}

/** 漂移告警数（`静默更新检测：alerts=N baseline=…`）。 */
export function parseDrift(detail: string): number | null {
  const m = RE_DRIFT.exec(detail);
  return m ? Number(m[1]) : null;
}

// ---------- 归一化引擎事件 → 渲染事实（服务端分类，浏览器只渲染） ----------
// 设计取舍：浏览器端是内联 JS（无构建步骤），无法 import 本模块。若让 GUI 自己
// 写正则，就回到了「两端各自演化」的老问题。因此**分类全部在服务端做**，
// SSE 的 card 帧携带 {ev, fact}，浏览器只按 fact.t 渲染。

export type RunFact =
  | { t: "mission"; mission: string }
  | { t: "clarify"; q: string }
  | { t: "answer"; a: string }
  | { t: "route"; id: number; role: string; route: RoutePath; channel: string }
  | { t: "dispatch"; id: number; channel: string; detail: string }
  | { t: "review"; id: number; role: string; verdict: Verdict; coverage?: number; note: string }
  | { t: "revision"; id: number; attempt: number; remedy: string }
  | { t: "reroute"; id: number; detail: string }
  | { t: "mint"; name: string; version: string; eval: string }
  | { t: "patch"; detail: string }
  | { t: "canary"; detail: string }
  | { t: "asset"; label: string }
  | { t: "ctx"; expert: string; session: string; turn: number; ctx: number; window: number }
  | { t: "drift"; alerts: number; detail: string }
  | { t: "mined"; entries: number; tracks: number }
  | { t: "crystal"; node: string; input: string; frozen: boolean }
  | { t: "capability"; capability: string; mode: string; granted: boolean }
  | { t: "score"; axis: string; kind: string; value: number }
  | { t: "shadow"; expert: string; candidate: string; baseline: string; agree: boolean }
  | { t: "node"; graph: string; node: string }
  | { t: "runStart"; entry: string; model: string; mission: string }
  | { t: "runEnd"; ok: boolean; elapsed_ms: number }
  | { t: "result" }
  // 审计与异常类事实（v0.5.0 具名化的那批事件）：统一渲染成一条带色调的提示行
  | { t: "notice"; tone: "info" | "warn" | "err"; text: string }
  /** 待批准项：渲染层应给出可操作入口（Web 勾选 / CLI org approvals） */
  | { t: "approval"; id: string; capability: string; action: string; detail: string; tone: "warn"; text: string }
  | { t: "other"; name: string; action: string; detail: string };

/**
 * 把一条归一化 EngineEvent 分类成渲染事实。
 * journal 事件按 action 分派到具体解析器；其它 kind 直接映射；不认识的原样
 * 透传为 other（前端可选显示，绝不静默吞掉 —— 见 BUGFIXES 关于 unknown 的条目）。
 */
export function classifyRunEvent(ev:
  | { kind: "run_start"; entry: string; model: string; mission?: string; task?: string }
  | { kind: "journal"; action: string; detail: string }
  | { kind: "node"; graph: string; node: string }
  | { kind: "capability_granted"; capability: string; mode: string }
  | { kind: "score_evidence"; axis: string; kind2: string; value: number }
  | { kind: "crystallize_frozen"; node: string; input: string }
  | { kind: "crystallize_hit"; node: string; input: string }
  | { kind: "shadow_compare"; expert: string; candidate: string; baseline: string; agree: boolean }
  | { kind: "fixtures_mined"; entries: number; tracks: number }
  | { kind: "run_end"; ok: boolean; elapsed_ms: number }
  | { kind: "unknown"; name: string; data: Record<string, unknown> }
  | { kind: "run_result" }
  | { kind: "audit"; event: string; detail: string }
  | { kind: "capability_denied"; capability: string; reason: string }
  | { kind: "crystallize_degrade"; node: string; input: string }
  | { kind: "canary_rollback"; expert: string; version: string; restored: boolean }
  | { kind: "redundancy_compare"; a: string; b: string; agree: boolean; coverageA: number; coverageB: number }
  | { kind: "score_drift_alert"; model: string; cell: string; previous: number; current: number; threshold: number }
  | { kind: "registry_commit_skipped"; message: string }
  | { kind: "patch_rollback_failed"; path: string; message: string }
  | { kind: "run_panic"; message: string }
  | { kind: "llm_stream_done"; track: string; chars: number; reasoningChars: number; elapsedMs: number; usage: Record<string, unknown> | null }
  | { kind: "fault"; action: string; target: string; kind2: string; message: string }
  | { kind: "approval_requested"; id: string; capability: string; action: string; detail: string; timeoutMs: number }
  | { kind: "approval_resolved"; id: string; capability: string; allow: boolean; always: boolean; by: string; waitedMs: number }
  | { kind: "approval_timeout"; id: string; capability: string; action: string; timeoutMs: number }
  | { kind: "approval_cached"; capability: string; action: string }
): RunFact {
  switch (ev.kind) {
    case "run_start":
      return { t: "runStart", entry: ev.entry ?? "", model: ev.model ?? "", mission: ev.mission ?? ev.task ?? "" };
    case "node":
      return { t: "node", graph: ev.graph, node: ev.node };
    case "capability_granted":
      return { t: "capability", capability: ev.capability, mode: ev.mode, granted: true };
    case "score_evidence":
      return { t: "score", axis: ev.axis, kind: ev.kind2, value: ev.value };
    case "crystallize_frozen":
      return { t: "crystal", node: ev.node, input: ev.input, frozen: true };
    case "crystallize_hit":
      return { t: "crystal", node: ev.node, input: ev.input, frozen: false };
    case "shadow_compare":
      return { t: "shadow", expert: ev.expert, candidate: ev.candidate, baseline: ev.baseline, agree: ev.agree };
    case "fixtures_mined":
      return { t: "mined", entries: ev.entries, tracks: ev.tracks };
    case "run_end":
      return { t: "runEnd", ok: ev.ok, elapsed_ms: ev.elapsed_ms };
    case "unknown":
      return { t: "other", name: ev.name, action: String(ev.data?.name ?? ""), detail: String(ev.data?.detail ?? "") };
    case "journal": {
      const { action, detail } = ev;
      if (action === "open") return { t: "mission", mission: detail };
      if (action === "clarify") return { t: "clarify", q: detail };
      if (action === "answer") return { t: "answer", a: detail };
      if (action === "route") {
        const f = parseRoute(detail);
        return f ? { t: "route", ...f } : { t: "other", name: "journal", action, detail };
      }
      if (action === "dispatch") {
        const f = parseDispatch(detail);
        return f ? { t: "dispatch", ...f } : { t: "other", name: "journal", action, detail };
      }
      if (action === "review") {
        const f = parseReview(detail);
        return f ? { t: "review", ...f } : { t: "other", name: "journal", action, detail };
      }
      if (action === "re-dispatch") {
        const f = parseReDispatch(detail);
        return f ? { t: "revision", ...f } : { t: "other", name: "journal", action, detail };
      }
      if (action === "re-route") return { t: "reroute", id: Number(/\d+/.exec(detail)?.[0] ?? 0), detail };
      if (action === "mint-register") {
        const f = parseMint(detail);
        return f ? { t: "mint", ...f } : { t: "other", name: "journal", action, detail };
      }
      if (action === "patch") return { t: "patch", detail };
      if (action === "canary") return { t: "canary", detail };
      if (action === "asset") return { t: "asset", label: detail };
      if (action === "direct_ctx") {
        const f = parseCtx(detail);
        return f ? { t: "ctx", ...f } : { t: "other", name: "journal", action, detail };
      }
      if (action === "drift") {
        const n = parseDrift(detail);
        return { t: "drift", alerts: n ?? 0, detail };
      }
      return { t: "other", name: "journal", action, detail };
    }
    // 合成终态（引擎桥注入，不在磁盘产物里）：与 done 帧同源，渲染层不需要它
    case "run_result":
      return { t: "result" };
    // ---- v0.5.0：审计与异常类事件（此前落 unknown，三端都看不到）----
    case "audit":
      return { t: "notice", tone: "info", text: `审计 ${ev.event}${ev.detail ? " · " + ev.detail : ""}` };
    case "capability_denied":
      return { t: "notice", tone: "warn", text: `能力拒绝 ${ev.capability}${ev.reason ? " · " + ev.reason : ""}` };
    case "crystallize_degrade":
      return { t: "notice", tone: "warn", text: `固化降级（解冻）${ev.node} ← ${ev.input}` };
    case "canary_rollback":
      return { t: "notice", tone: "err", text: `金丝雀回滚 ${ev.expert}@${ev.version}${ev.restored ? "（已还原归档源）" : "（还原失败）"}` };
    case "redundancy_compare":
      return {
        t: "notice", tone: ev.agree ? "info" : "warn",
        text: `N 版本冗余 ${ev.a} ↔ ${ev.b} · ${ev.agree ? "一致" : "不一致"}（coverage ${ev.coverageA.toFixed(2)} / ${ev.coverageB.toFixed(2)}）`,
      };
    case "score_drift_alert":
      return {
        t: "notice", tone: "warn",
        text: `静默更新告警 ${ev.model} · ${ev.cell}：${ev.previous.toFixed(2)} → ${ev.current.toFixed(2)}（阈值 ${ev.threshold}）`,
      };
    case "registry_commit_skipped":
      return { t: "notice", tone: "warn", text: `注册表 git 留痕跳过 · ${ev.message}` };
    case "patch_rollback_failed":
      return { t: "notice", tone: "err", text: `补丁回滚失败 ${ev.path} · ${ev.message}` };
    case "run_panic":
      return { t: "notice", tone: "err", text: `运行时 panic · ${ev.message}` };
    case "llm_stream_done":
      return {
        t: "notice", tone: "info",
        text: `模型调用 ${ev.track} · ${ev.chars} 字${ev.reasoningChars > 0 ? `（思考 ${ev.reasoningChars}）` : ""} · ${ev.elapsedMs}ms`,
      };
    case "fault":
      return { t: "notice", tone: "warn", text: `故障注入 ${ev.action} ${ev.target}${ev.kind2 ? " (" + ev.kind2 + ")" : ""} · ${ev.message}` };
    // ---- 交互式审批四态：请求要显眼（人要看它），结论要可追溯 ----
    case "approval_requested":
      return {
        t: "approval", id: ev.id, capability: ev.capability, action: ev.action, detail: ev.detail,
        tone: "warn",
        text: `待批准 · ${ev.action}（能力 ${ev.capability}，${Math.round(ev.timeoutMs / 1000)}s 内无应答将拒绝）`,
      };
    case "approval_resolved":
      return {
        t: "notice", tone: ev.allow ? "info" : "err",
        text: `审批${ev.allow ? "放行" : "拒绝"} · ${ev.capability}${ev.always ? "（长期放行）" : ""} · ${ev.by} · 等待 ${ev.waitedMs}ms`,
      };
    case "approval_timeout":
      return {
        t: "notice", tone: "warn",
        text: `审批超时（${Math.round(ev.timeoutMs / 1000)}s）降级为拒绝 · ${ev.capability} · ${ev.action}`,
      };
    case "approval_cached":
      return { t: "notice", tone: "info", text: `长期放行命中 · ${ev.capability}` };
    default:
      return { t: "other", name: String((ev as { kind: string }).kind), action: "", detail: "" };
  }
}
