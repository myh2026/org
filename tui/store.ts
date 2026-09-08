// ============================================================================
// org/tui/store.ts — useReducer 单 store + 事件→卡片纯函数管线（规格书 §1/§3/§5）
// ----------------------------------------------------------------------------
// 设计：全部状态在一个 TuiState 里；pushEngineEvent(state, ev) 是纯函数
// （引擎事件 → 卡片流变更），reducer 与冒烟测试共用同一条管线。
// 卡片高度由渲染器按行计算（见 components/cards.tsx），滚动按行精确切片。
// ============================================================================

import type { WorkspaceInfo, SessionInfo, ExpertInfo, Scorecard } from "../lib/engine.ts";
import type { EngineEvent } from "../lib/events.ts";
import type { ThemeName } from "./theme.ts";

// ---------- 卡片模型（八类 + 评分卡） ----------

export type RoutePath = "A" | "B" | "C" | "D";
export type Verdict = "Accept" | "Revise" | "Reject" | "Escalate";

export interface Subtask {
  id: number;
  role: string;
  route: RoutePath;
  channel?: string;    // inline / reuse <expert> / factory mint
  expert?: string;
  state: "pending" | "running" | "done";
}

export interface QaPair {
  q: string;
  a?: string;
}

export type StepState = "pending" | "active" | "done";

export interface FactorySteps {
  spec: StepState;
  mint: StepState;
  check: StepState;
  accept: StepState;
  register: StepState;
}

export const FACTORY_STEP_LABELS = ["规格", "生成", "check", "验收", "登记 git"] as const;

export type Card =
  | { id: number; t: "user"; text: string }
  | {
      id: number; t: "task"; mission: string; qa: QaPair[]; subtasks: Subtask[];
    }
  | {
      id: number; t: "factory"; name?: string; version?: string;
      steps: FactorySteps; failed?: string;
    }
  | {
      id: number; t: "review"; task: string; role: string; verdict: Verdict;
      coverage?: number; attempt: number; remedy?: string;
    }
  | {
      id: number; t: "crystal"; frozen: Array<{ node: string; input: string }>;
      hits: Array<{ node: string; input: string }>;
    }
  | {
      id: number; t: "patch"; trigger: string; version?: string;
      sha?: string; confirmed?: boolean;
    }
  | {
      id: number; t: "direct"; expert?: string; question: string;
      answers: string[]; turns?: number; note?: string; done: boolean;
      ctxTokens?: number; ctxWindow?: number; ctxTurn?: number;
    }
  | {
      id: number; t: "done"; ok: boolean; canceled?: boolean;
      deliverables?: number; assets?: number; assetLabels?: string[];
      modelCalls?: number; revises?: number; elapsedMs?: number;
      decay?: string; sha?: string; error?: string;
    }
  | { id: number; t: "system"; text: string; tone: "info" | "ok" | "warn" | "err" }
  | {
      id: number; t: "score"; model: string; evidence: number;
      cells: Scorecard["cells"]; axis?: string;
    };

// ---------- 事件流过滤（:filter，视图偏好；不随 run / 清屏 / 重演重置） ----------

export type FilterKey = "all" | "user" | "task" | "factory" | "review" | "direct" | "done" | "dyn";

export const FILTERS: Array<{ k: FilterKey; label: string }> = [
  { k: "all", label: "全部" },
  { k: "user", label: "任务" },
  { k: "task", label: "分解" },
  { k: "factory", label: "工厂" },
  { k: "review", label: "裁决" },
  { k: "direct", label: "直连" },
  { k: "done", label: "汇总" },
  { k: "dyn", label: "动态" },
];

/** 卡片是否属于过滤类（system 提示卡恒可见，由调用方短路）。 */
export function cardMatchesFilter(card: Card, f: FilterKey): boolean {
  if (f === "all") return true;
  switch (f) {
    case "user": return card.t === "user";
    case "task": return card.t === "task";
    case "factory": return card.t === "factory";
    case "review": return card.t === "review";
    case "direct": return card.t === "direct";
    case "done": return card.t === "done";
    case "dyn": return card.t === "crystal" || card.t === "patch" || card.t === "score";
  }
}

/** `:filter <类>`：接受中文标签或英文键（裁决/review），空参复位为全部；未知返回 null。 */
export function parseFilterArg(arg: string): FilterKey | null {
  const a = arg.trim().toLowerCase();
  if (a.length === 0) return "all";
  const hit = FILTERS.find((f) => f.label === arg.trim() || f.k === a);
  return hit ? hit.k : null;
}

// ---------- 状态 ----------

export type Focus = "input" | "sessions" | "experts" | "pool";
export type Mode = "team" | "direct" | "replay" | "demo";
export type EngineState = "idle" | "running" | "canceled" | "error";

interface RunCtx {
  mission: string;
  model: string;
  qa: QaPair[];
  taskCardId: number | null;
  factoryCardId: number | null;
  crystalCardId: number | null;
  directCardId: number | null;
  reviewCount: Map<string, number>;   // task#N → 已出现的审查数
  busy: number;
  assets: string[];
  driftAlerts: number;
}

export interface TuiState {
  theme: ThemeName;
  cols: number;
  rows: number;
  focus: Focus;
  selIdx: { sessions: number; experts: number; pool: number };
  collapsed: { sessions: boolean; experts: boolean; pool: boolean };
  sessions: SessionInfo[];
  experts: ExpertInfo[];
  crystal: { frozen: number; hits: number; memos: number };
  cards: Card[];
  nextId: number;
  runCtx: RunCtx | null;
  follow: boolean;
  scrollFromBottom: number;
  input: string;
  history: string[];
  historyIdx: number;
  mode: Mode;
  filter: FilterKey;               // 事件流过滤（:filter）
  model: string;
  engine: EngineState;
  startedAt: number | null;
  nowMs: number;
  helpOpen: boolean;
  notice: { text: string; tone: "info" | "warn" | "err" } | null;
  workspace: string;
  currentSession: string | null;   // 当前线程对应会话名（● 标记）
  demoHistory: number[];           // :demo 的 model_calls 序列（5→1→0）
  demoStep: "A" | "B" | "C" | null;
}

export function initialState(partial?: Partial<TuiState>): TuiState {
  return {
    theme: "org-dark",
    cols: 120,
    rows: 36,
    focus: "input",
    selIdx: { sessions: 0, experts: 0, pool: 0 },
    collapsed: { sessions: false, experts: false, pool: false },
    sessions: [],
    experts: [],
    crystal: { frozen: 0, hits: 0, memos: 0 },
    cards: [],
    nextId: 1,
    runCtx: null,
    follow: true,
    scrollFromBottom: 0,
    input: "",
    history: [],
    historyIdx: -1,
    mode: "team",
    filter: "all",
    model: "scripted",
    engine: "idle",
    startedAt: null,
    nowMs: 0,
    helpOpen: false,
    notice: null,
    workspace: "",
    currentSession: null,
    demoHistory: [],
    demoStep: null,
    ...partial,
  };
}

// ---------- Actions ----------

export type Action =
  | { type: "resize"; cols: number; rows: number }
  | { type: "setFocus"; focus: Focus }
  | { type: "cycleFocus"; dir: 1 | -1 }
  | { type: "moveSel"; delta: 1 | -1 }
  | { type: "toggleSection"; section: "sessions" | "experts" | "pool" }
  | { type: "workspace"; info: WorkspaceInfo }
  | { type: "setWorkspace"; workspace: string }
  | { type: "inputSet"; value: string }
  | { type: "inputAppend"; text: string }
  | { type: "inputBackspace" }
  | { type: "inputHistory"; dir: 1 | -1 }
  | { type: "inputSubmit"; value: string }
  | { type: "runStart"; mode: Mode; session: string; userText: string }
  | { type: "runEvent"; ev: EngineEvent }
  | { type: "runDone"; ok: boolean; error?: string; sha?: string }
  | { type: "demoCalls"; calls: number }
  | { type: "attachSha"; sha: string }
  | { type: "directAnswers"; answers: string[]; turns: number }
  | { type: "setTheme"; theme: ThemeName }
  | { type: "setFilter"; filter: FilterKey }
  | { type: "toggleHelp"; open?: boolean }
  | { type: "scroll"; deltaLines: number }
  | { type: "scrollTop" }
  | { type: "scrollBottom" }
  | { type: "clearScreen" }
  | { type: "notice"; text: string; tone?: "info" | "warn" | "err" }
  | { type: "dismissNotice" }
  | { type: "tick" }
  | { type: "replay"; events: EngineEvent[]; session: string; model: string }
  | { type: "replayDone"; ok: boolean; deliverables?: number; assets?: number; modelCalls?: number; revises?: number; elapsedMs?: number }
  | { type: "demoStart" }
  | { type: "demoStep"; step: "A" | "B" | "C" }
  | { type: "scoreCard"; model: string; evidence: number; cells: Scorecard["cells"] };

const FOCUS_CYCLE: Focus[] = ["input", "sessions", "experts", "pool"];

function newRunCtx(model: string): RunCtx {
  return {
    mission: "", model, qa: [],
    taskCardId: null, factoryCardId: null, crystalCardId: null, directCardId: null,
    reviewCount: new Map(), busy: 0, assets: [], driftAlerts: 0,
  };
}

function withCard(state: TuiState, id: number, patch: (c: Card) => Card): TuiState {
  return { ...state, cards: state.cards.map((c) => (c.id === id ? patch(c) : c)) };
}

function appendCard(state: TuiState, card: Omit<Card, "id">): TuiState {
  const id = state.nextId;
  return { ...state, cards: [...state.cards, { ...card, id } as Card], nextId: id + 1 };
}

// ---------- 引擎事件 → 卡片管线（纯函数，冒烟测试共用） ----------

const ROUTE_LABEL: Record<RoutePath, string> = { A: "内联", B: "复用", C: "生成", D: "移交" };
export const routeLabel = (r: RoutePath): string => ROUTE_LABEL[r];

const VERDICTS: Verdict[] = ["Accept", "Revise", "Reject", "Escalate"];
function parseVerdict(s: string): Verdict {
  const v = s.trim().toLowerCase();
  return VERDICTS.find((x) => x.toLowerCase() === v) ?? "Accept";
}

/** `task#3 validate -> C:generate` */
const RE_ROUTE = /^task#(\d+)\s+(\S+)\s*->\s*([ABCD]):(\S+)/;
/** `task#2 channel=reuse notice-parser` / `task#1 channel=inline (kernel context)` / `task#3 channel=factory mint` */
const RE_DISPATCH = /^task#(\d+)\s+channel=(\S+)(?:\s+(.*))?$/;
/** `task#3 validate verdict=Revise coverage=0.80` */
const RE_REVIEW = /^task#(\d+)\s+(\S+)\s+verdict=(\S+)(?:\s+coverage=([\d.]+))?(?:\s+(.*))?$/;
/** `task#3 revise #1: remedy: count date_status=unparsed as valid ...` */
const RE_REDISPATCH = /^task#(\d+)\s+revise\s+#(\d+):\s*(.*)$/;
/** `record-validator@1.0.0 eval=1` */
const RE_MINT = /^(\S+)@([\d.]+)\s+eval=(\S+)/;
/** `静默更新检测：alerts=0 baseline=...` */
const RE_DRIFT = /alerts=(\d+)/;

/** `direct_ctx` 事件：`notice-parser/demo turn=2 ctx=141 window=131072`（Codex 风格窗口计量） */
const RE_CTX = /^(\S+)\/(\S+) turn=(\d+) ctx=(\d+) window=(\d+)$/;

export function pushEngineEvent(state: TuiState, ev: EngineEvent): TuiState {
  switch (ev.kind) {
    case "run_start": {
      const ctx = newRunCtx(ev.model || state.model);
      ctx.mission = ev.mission ?? ev.task ?? state.runCtx?.mission ?? "";
      return { ...state, runCtx: ctx, model: ev.model || state.model };
    }
    case "journal":
      return applyJournal(state, ev.action, ev.detail);
    case "node": {
      if (ev.graph !== "Factory" || !state.runCtx?.factoryCardId) return state;
      const fid = state.runCtx.factoryCardId;
      let steps: FactorySteps | null = null;
      if (ev.node === "spec") steps = { spec: "done", mint: "active", check: "pending", accept: "pending", register: "pending" };
      else if (ev.node === "source") steps = { spec: "done", mint: "done", check: "active", accept: "pending", register: "pending" };
      else if (ev.node === "gate") steps = { spec: "done", mint: "done", check: "done", accept: "done", register: "active" };
      else if (ev.node === "registry") steps = { spec: "done", mint: "done", check: "done", accept: "done", register: "done" };
      if (!steps) return state;
      return withCard(state, fid, (c) => (c.t === "factory" ? { ...c, steps } : c));
    }
    case "crystallize_frozen": {
      const ctx = state.runCtx ?? newRunCtx(state.model);
      let next: TuiState;
      if (ctx.crystalCardId === null) {
        const id = state.nextId;
        next = {
          ...state, nextId: id + 1, runCtx: { ...ctx, crystalCardId: id },
          cards: [...state.cards, {
            id, t: "crystal",
            frozen: [{ node: ev.node, input: ev.input }], hits: [],
          }],
        };
      } else {
        next = withCard({ ...state, runCtx: ctx }, ctx.crystalCardId, (c) =>
          c.t === "crystal" ? { ...c, frozen: [...c.frozen, { node: ev.node, input: ev.input }] } : c);
      }
      return { ...next, crystal: { ...next.crystal, frozen: next.crystal.frozen + 1 } };
    }
    case "crystallize_hit": {
      const ctx = state.runCtx ?? newRunCtx(state.model);
      let next: TuiState;
      if (ctx.crystalCardId === null) {
        const id = state.nextId;
        next = {
          ...state, nextId: id + 1, runCtx: { ...ctx, crystalCardId: id },
          cards: [...state.cards, {
            id, t: "crystal",
            frozen: [], hits: [{ node: ev.node, input: ev.input }],
          }],
        };
      } else {
        next = withCard({ ...state, runCtx: ctx }, ctx.crystalCardId, (c) =>
          c.t === "crystal" ? { ...c, hits: [...c.hits, { node: ev.node, input: ev.input }] } : c);
      }
      return { ...next, crystal: { ...next.crystal, hits: next.crystal.hits + 1 } };
    }
    case "canary_confirmed": {
      // 附加到最后一张补丁卡；无补丁卡则开一张（蓝绿生效叙事）
      const lastPatch = [...state.cards].reverse().find((c) => c.t === "patch");
      if (lastPatch) {
        return withCard(state, lastPatch.id, (c) =>
          c.t === "patch" ? { ...c, version: ev.version, confirmed: true } : c);
      }
      return appendCard(state, {
        t: "patch", version: ev.version, confirmed: true,
        trigger: `金丝雀影子晋升确认 ${ev.expert}@${ev.version}（蓝绿生效）`,
      });
    }
    case "fixtures_mined":
      return appendCard(state, {
        t: "system", tone: "info",
        text: `journal→fixture 出题 ${ev.tracks} 条轨道 · ${ev.entries} 条样本（基准题沉淀）`,
      });
    case "run_end":
      return { ...state, nowMs: Date.now() };
    case "run_result": {
      let next = state;
      const ctx = state.runCtx;
      if (ev.canceled) {
        next = appendCard(next, { t: "system", tone: "warn", text: "run_canceled · 运行已取消（SIGTERM）" });
      } else if (ev.ok) {
        const m = ev.metrics ?? {};
        // 衰减序列包含本次 run（app 会在 runDone 后再补 demoCalls，序列以完成卡为准）
        const decay = state.mode === "demo" && m.model_calls_total !== undefined
          ? [...state.demoHistory, m.model_calls_total].join("→")
          : undefined;
        next = appendCard(next, {
          t: "done", ok: true,
          deliverables: m.deliverables, assets: m.assets, assetLabels: m.asset_labels,
          modelCalls: m.model_calls_total, revises: m.revises_total,
          elapsedMs: ev.elapsed_ms, decay,
        });
      } else {
        next = appendCard(next, {
          t: "done", ok: false, error: ev.error ?? "运行失败",
          elapsedMs: ev.elapsed_ms,
        });
        // 工厂卡标红（check 拒绝是最常见失败面）
        if (ctx?.factoryCardId) {
          next = withCard(next, ctx.factoryCardId, (c) =>
            c.t === "factory" ? { ...c, failed: ev.error ?? "工厂闸门拒绝" } : c);
        }
      }
      return next;
    }
    default:
      return state;
  }
}

function applyJournal(state: TuiState, action: string, detail: string): TuiState {
  switch (action) {
    case "clarify": {
      if (!state.runCtx) return state;
      const ctx = { ...state.runCtx, qa: [...state.runCtx.qa, { q: detail }] };
      return { ...state, runCtx: ctx };
    }
    case "answer": {
      if (!state.runCtx) return state;
      const qa = [...state.runCtx.qa];
      for (let i = 0; i < qa.length; i++) {
        if (qa[i]!.a === undefined) { qa[i] = { ...qa[i]!, a: detail }; break; }
      }
      return { ...state, runCtx: { ...state.runCtx, qa } };
    }
    case "route": {
      const m = RE_ROUTE.exec(detail);
      if (!m) return state;
      const sub: Subtask = {
        id: Number(m[1]), role: m[2] ?? "", route: (m[3] ?? "A") as RoutePath, state: "pending",
      };
      let next = state;
      const ctx = state.runCtx ?? newRunCtx(state.model);
      if (ctx.taskCardId === null) {
        const id = state.nextId;
        next = {
          ...state, nextId: id + 1,
          runCtx: { ...ctx, taskCardId: id },
          cards: [...state.cards, {
            id, t: "task",
            mission: ctx.mission,
            qa: ctx.qa, subtasks: [sub],
          } as Card],
        };
      } else {
        next = withCard({ ...state, runCtx: ctx }, ctx.taskCardId, (c) =>
          c.t === "task" ? { ...c, subtasks: [...c.subtasks, sub] } : c);
      }
      // 更新任务卡标题（子任务计数）
      const taskCard = next.cards.find((c) => c.id === next.runCtx?.taskCardId);
      if (taskCard && taskCard.t === "task") {
        next = withCard(next, taskCard.id, (c) =>
          c.t === "task" ? { ...c, mission: c.mission || next.runCtx?.mission || "" } : c);
      }
      return next;
    }
    case "dispatch": {
      const m = RE_DISPATCH.exec(detail);
      if (!m) return state;
      const taskId = Number(m[1]);
      const channel = m[2] ?? "";
      const rest = m[3] ?? "";
      let expert: string | undefined;
      if (channel === "reuse") expert = rest.split(/\s+/)[0];
      let next = state;
      const ctx = state.runCtx ?? newRunCtx(state.model);
      next = { ...state, runCtx: { ...ctx, busy: ctx.busy + 1 } };
      if (ctx.taskCardId !== null) {
        next = withCard(next, ctx.taskCardId, (c) => {
          if (c.t !== "task") return c;
          return {
            ...c,
            subtasks: c.subtasks.map((s) =>
              s.id === taskId
                ? { ...s, state: "running", channel, expert: expert ?? s.expert }
                : s),
          };
        });
      }
      if (channel === "factory" && next.runCtx && next.runCtx.factoryCardId === null) {
        const id = next.nextId;
        next = {
          ...next, nextId: id + 1,
          runCtx: { ...next.runCtx!, factoryCardId: id },
          cards: [...next.cards, {
            id, t: "factory",
            steps: { spec: "active", mint: "pending", check: "pending", accept: "pending", register: "pending" },
          }],
        };
      }
      return next;
    }
    case "review": {
      const m = RE_REVIEW.exec(detail);
      if (!m) return state;
      const taskId = m[1] ?? "";
      const role = m[2] ?? "";
      const verdict = parseVerdict(m[3] ?? "Accept");
      const coverage = m[4] !== undefined ? Number(m[4]) : undefined;
      const ctx = state.runCtx ?? newRunCtx(state.model);
      const attempt = (ctx.reviewCount.get(taskId) ?? 0) + 1;
      const reviewCount = new Map(ctx.reviewCount);
      reviewCount.set(taskId, attempt);
      return appendCard({ ...state, runCtx: { ...ctx, reviewCount } }, {
        t: "review", task: taskId, role, verdict, coverage, attempt,
      });
    }
    case "re-dispatch": {
      const m = RE_REDISPATCH.exec(detail);
      if (!m) return state;
      const taskId = `task#${m[1]}`;
      const remedy = m[3] ?? "";
      const ctx = state.runCtx ?? newRunCtx(state.model);
      let next = { ...state, runCtx: { ...ctx, busy: ctx.busy + 1 } };
      // remedy 挂到最后一张该任务的 Revise 审查卡
      const idx = [...next.cards].reverse().findIndex((c) => c.t === "review" && c.task === taskId);
      if (idx >= 0) {
        const cardId = next.cards[next.cards.length - 1 - idx]!.id;
        next = withCard(next, cardId, (c) => (c.t === "review" ? { ...c, remedy } : c));
      }
      // 子任务回到 running
      if (next.runCtx?.taskCardId !== null && next.runCtx) {
        next = withCard(next, next.runCtx.taskCardId!, (c) => {
          if (c.t !== "task") return c;
          return {
            ...c,
            subtasks: c.subtasks.map((s) => (`task#${s.id}` === taskId ? { ...s, state: "running" } : s)),
          };
        });
      }
      return next;
    }
    case "worker-done": {
      const m = /^task#(\d+)/.exec(detail);
      if (!m) return state;
      const taskId = Number(m[1]);
      const ctx = state.runCtx ?? newRunCtx(state.model);
      let next = { ...state, runCtx: { ...ctx, busy: Math.max(0, ctx.busy - 1) } };
      if (next.runCtx?.taskCardId !== null && next.runCtx) {
        next = withCard(next, next.runCtx.taskCardId!, (c) => {
          if (c.t !== "task") return c;
          return {
            ...c,
            subtasks: c.subtasks.map((s) => (s.id === taskId ? { ...s, state: "done" } : s)),
          };
        });
      }
      return next;
    }
    case "mint-register": {
      const m = RE_MINT.exec(detail);
      const ctx = state.runCtx;
      if (!ctx?.factoryCardId) return state;
      return withCard(state, ctx.factoryCardId, (c) =>
        c.t === "factory"
          ? {
              ...c,
              name: m?.[1], version: m?.[2],
              steps: { spec: "done", mint: "done", check: "done", accept: "done", register: "done" },
            }
          : c);
    }
    case "asset": {
      if (!state.runCtx) return state;
      return { ...state, runCtx: { ...state.runCtx, assets: [...state.runCtx.assets, detail] } };
    }
    case "drift": {
      const m = RE_DRIFT.exec(detail);
      const alerts = m ? Number(m[1]) : 0;
      if (!state.runCtx) return state;
      return { ...state, runCtx: { ...state.runCtx, driftAlerts: alerts } };
    }
    case "patch": {
      return appendCard(state, { t: "patch", trigger: detail });
    }
    case "canary": {
      // journal: 影子对比一致 → 金丝雀确认 record-validator@1.0.1（蓝绿生效）
      const lastPatch = [...state.cards].reverse().find((c) => c.t === "patch");
      if (lastPatch) {
        return withCard(state, lastPatch.id, (c) =>
          c.t === "patch" ? { ...c, confirmed: true } : c);
      }
      return appendCard(state, { t: "system", tone: "ok", text: detail });
    }
    case "direct_open": {
      const ctx = state.runCtx ?? newRunCtx(state.model);
      let next = state;
      if (ctx.directCardId === null) {
        const id = state.nextId;
        next = {
          ...state, nextId: id + 1,
          runCtx: { ...ctx, directCardId: id },
          cards: [...state.cards, { id, t: "direct", expert: detail, question: ctx.mission, answers: [], done: false }],
        };
      } else {
        next = withCard(state, ctx.directCardId, (c) => (c.t === "direct" ? { ...c, expert: detail } : c));
      }
      return next;
    }
    case "direct_ctx": {
      // 直连上下文窗口占用（Codex 风格）：expert/session turn=N ctx=N window=N
      const m = RE_CTX.exec(detail);
      if (!m) return state;
      const ctx = state.runCtx ?? newRunCtx(state.model);
      if (ctx.directCardId === null) {
        const id = state.nextId;
        return {
          ...state, nextId: id + 1,
          runCtx: { ...ctx, directCardId: id },
          cards: [...state.cards, {
            id, t: "direct", expert: m[1], question: ctx.mission,
            answers: [], done: false,
            ctxTokens: Number(m[4]), ctxWindow: Number(m[5]), ctxTurn: Number(m[3]),
          }],
        };
      }
      return withCard(state, ctx.directCardId, (c) =>
        c.t === "direct"
          ? { ...c, expert: m[1], ctxTokens: Number(m[4]), ctxWindow: Number(m[5]), ctxTurn: Number(m[3]) }
          : c);
    }
    case "direct_close": {
      const ctx = state.runCtx;
      if (!ctx?.directCardId) return state;
      return withCard(state, ctx.directCardId, (c) => (c.t === "direct" ? { ...c, done: true } : c));
    }
    default:
      return state;
  }
}

// ---------- reducer ----------

export function reducer(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case "resize":
      return { ...state, cols: action.cols, rows: action.rows };
    case "setFocus":
      return { ...state, focus: action.focus };
    case "cycleFocus": {
      const i = FOCUS_CYCLE.indexOf(state.focus);
      const n = (i + action.dir + FOCUS_CYCLE.length) % FOCUS_CYCLE.length;
      return { ...state, focus: FOCUS_CYCLE[n]!, selIdx: { ...state.selIdx, [FOCUS_CYCLE[n]!]: state.selIdx[FOCUS_CYCLE[n]!] ?? 0 } };
    }
    case "moveSel": {
      if (state.focus === "sessions") {
        const max = Math.max(0, state.sessions.length - 1);
        return { ...state, selIdx: { ...state.selIdx, sessions: Math.min(max, Math.max(0, state.selIdx.sessions + action.delta)) } };
      }
      if (state.focus === "experts") {
        const max = Math.max(0, state.experts.length - 1);
        return { ...state, selIdx: { ...state.selIdx, experts: Math.min(max, Math.max(0, state.selIdx.experts + action.delta)) } };
      }
      return state;
    }
    case "toggleSection":
      return { ...state, collapsed: { ...state.collapsed, [action.section]: !state.collapsed[action.section] } };
    case "workspace": {
      const info = action.info;
      return {
        ...state,
        sessions: info.sessions,
        experts: info.experts,
        crystal: { ...state.crystal, memos: info.memoKeys },
        selIdx: {
          ...state.selIdx,
          sessions: Math.min(state.selIdx.sessions, Math.max(0, info.sessions.length - 1)),
          experts: Math.min(state.selIdx.experts, Math.max(0, info.experts.length - 1)),
        },
      };
    }
    case "setWorkspace":
      return { ...state, workspace: action.workspace };
    case "inputSet":
      return { ...state, input: action.value, historyIdx: -1 };
    case "inputAppend":
      return { ...state, input: state.input + action.text, historyIdx: -1 };
    case "inputBackspace":
      return { ...state, input: state.input.slice(0, -1), historyIdx: -1 };
    case "inputHistory": {
      if (state.history.length === 0) return state;
      let idx = state.historyIdx;
      if (action.dir === -1) idx = Math.min(state.history.length - 1, idx + 1);
      else idx = Math.max(-1, idx - 1);
      return {
        ...state, historyIdx: idx,
        input: idx === -1 ? "" : state.history[state.history.length - 1 - idx]!,
      };
    }
    case "inputSubmit":
      return {
        ...state,
        input: "",
        historyIdx: -1,
        history: action.value.trim().length > 0 && state.history[state.history.length - 1] !== action.value
          ? [...state.history, action.value]
          : state.history,
      };
    case "runStart": {
      const userCard = appendCard(state, { t: "user", text: action.userText });
      return {
        ...userCard,
        mode: action.mode,
        engine: "running",
        startedAt: Date.now(),
        nowMs: Date.now(),
        follow: true,
        scrollFromBottom: 0,
        runCtx: newRunCtx(state.model),
        currentSession: action.session,
        focus: "input",
        helpOpen: false,
      };
    }
    case "runEvent":
      return pushEngineEvent(state, action.ev);
    case "runDone":
      return {
        ...state,
        engine: action.ok ? "idle" : (state.engine === "canceled" ? "canceled" : "error"),
        startedAt: null,
      };
    case "demoCalls":
      return { ...state, demoHistory: [...state.demoHistory, action.calls] };
    case "attachSha": {
      let next = state;
      const lastPatch = [...next.cards].reverse().find((c) => c.t === "patch");
      if (lastPatch) {
        next = withCard(next, lastPatch.id, (c) => (c.t === "patch" ? { ...c, sha: action.sha } : c));
      }
      const lastDone = [...next.cards].reverse().find((c) => c.t === "done");
      if (lastDone) {
        next = withCard(next, lastDone.id, (c) => (c.t === "done" ? { ...c, sha: action.sha } : c));
      }
      return next;
    }
    case "directAnswers": {
      const lastDirect = [...state.cards].reverse().find((c) => c.t === "direct");
      if (!lastDirect) return state;
      return withCard(state, lastDirect.id, (c) =>
        c.t === "direct" ? { ...c, answers: action.answers, turns: action.turns, done: true } : c);
    }
    case "setTheme":
      return { ...state, theme: action.theme };
    case "setFilter":
      return { ...state, filter: action.filter };
    case "toggleHelp":
      return { ...state, helpOpen: action.open === undefined ? !state.helpOpen : action.open };
    case "scroll":
      return {
        ...state,
        follow: false,
        scrollFromBottom: Math.max(0, state.scrollFromBottom + action.deltaLines),
      };
    case "scrollTop":
      return { ...state, follow: false, scrollFromBottom: 100000 };
    case "scrollBottom":
      return { ...state, follow: true, scrollFromBottom: 0 };
    case "clearScreen":
      return {
        ...state, cards: [], nextId: 1, runCtx: null,
        follow: true, scrollFromBottom: 0,
        currentSession: null, demoHistory: [], demoStep: null,
        notice: { text: "已清屏（会话与资产不受影响）", tone: "info" },
      };
    case "notice":
      return { ...state, notice: { text: action.text, tone: action.tone ?? "info" } };
    case "dismissNotice":
      return { ...state, notice: null };
    case "tick":
      return { ...state, nowMs: Date.now() };
    case "replay": {
      let next: TuiState = {
        ...state,
        cards: [], nextId: 1, runCtx: null,
        mode: "replay", engine: "idle", startedAt: null,
        follow: true, scrollFromBottom: 0,
        currentSession: action.session,
        crystal: { ...state.crystal, frozen: 0, hits: 0 },
        helpOpen: false, focus: "input",
      };
      for (const ev of action.events) {
        next = pushEngineEvent(next, ev);
      }
      return next;
    }
    case "replayDone": {
      return appendCard(state, {
        t: "done", ok: action.ok,
        deliverables: action.deliverables, assets: action.assets,
        modelCalls: action.modelCalls, revises: action.revises, elapsedMs: action.elapsedMs,
      });
    }
    case "demoStart":
      return { ...state, demoHistory: [], demoStep: null };
    case "demoStep":
      return { ...state, demoStep: action.step };
    case "scoreCard":
      return appendCard(state, {
        t: "score", model: action.model, evidence: action.evidence, cells: action.cells,
      });
    default:
      return state;
  }
}

/** demo 完成时把本次 run 的 model_calls 记入衰减序列（app 在 runDone 后调用）。 */
export function withDemoCall(state: TuiState, modelCalls: number): TuiState {
  return { ...state, demoHistory: [...state.demoHistory, modelCalls] };
}
