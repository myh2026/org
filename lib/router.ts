// ============================================================================
// lib/router.ts — 本地模型路由器（v0.5.1：key 池轮换 / 降级链 / 预算 / 台账）
// ----------------------------------------------------------------------------
// 「多重优雅降级」的执行层：一个进程内 Bun.serve（127.0.0.1 随机端口），
// 对外暴露 OpenAI 兼容端点 /v1/chat/completions，对内把请求转发给当前车道：
//
//   逐 key 轮换    429 / 5xx / 网络错误 → 同车道下一个 key（round-robin 起点轮转）
//   车道降级链     key 池全部失败 / 超时 → fallback 链的下一个车道（模型名随之改写）
//   预算水位      budget_requests（org config set budget_requests N）超出 → 429
//   调用台账      每次尝试落 <ws>/runtime/llm-ledger.jsonl（key 指纹 / 状态 / 延迟）
//   池状态落盘    429/5xx/timeout → 该 key 冷却并落 <ws>/runtime/llm-pool.json
//                （v0.5.5：跨进程共享 —— chat / taskd / web 三端同池同冷却；
//                冷却中的 key 排序沉底，全部冷却则照用不阻断）
//   流式透传      SSE 字节级转发（注入 include_usage 尽力收 usage；被拒则去 option 重试）
//
// 生命周期：ensureRouter() 幂等（多 key / 降级链 / 预算任一命中才启动）；
// 路由器崩溃或未启动 → 调用方回落直连（engine 不感知差异）。ORG_ROUTER=0/1 强制开关。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { PROVIDERS } from "./provider-registry.ts";
import { resolveModelFlag, applyLaneToEnv, snapshotUserEnv, isUserOwnedEnv, type ResolvedLane } from "./providers.ts";
import { loadConfig } from "./config.ts";

/** key 指纹（台账与显示用，不落原值）。 */
export function keyFingerprint(key: string, index: number): string {
  if (key.length <= 8) return `k${index + 1}(****)`;
  return `k${index + 1}(${key.slice(0, 3)}…${key.slice(-2)})`;
}

export interface LedgerEntry {
  ts: string;
  lane: string;
  upstream: string;
  key_id: string;
  model: string;
  stream: boolean;
  status: "ok" | string; // ok / 429 / 5xx / timeout / net-error / budget / bad-request
  code?: number;
  ms: number;
  tokens?: number;
}

export interface RouterHandle {
  /** 网关基址（OpenAI 兼容形态，含 /v1 —— 与 DHV_LLM_GATEWAY 同构）。 */
  url: string;
  port: number;
  /** 当前路由的车道名（车道切换时自动重建路由器）。 */
  laneName: string;
  stop(): void;
}

let active: RouterHandle | null = null;

/** 幂等获取/启动路由器；返回 null = 无需路由（直连更优）。 */
export async function ensureRouter(lane: ResolvedLane, workspace: string): Promise<RouterHandle | null> {
  if (process.env.ORG_ROUTER === "0") return null;
  if (active) {
    // 车道切换（chat /model、Web 面板）→ 重建路由器指向新车道
    if (active.laneName !== lane.name) {
      active.stop();
      active = null;
    } else {
      return active;
    }
  }
  const cfg = loadConfig();
  const budget = (cfg.budget_requests ?? "").trim();
  const beneficial =
    process.env.ORG_ROUTER === "1" ||
    lane.keys.length > 1 ||
    lane.fallbacks.length > 0 ||
    budget.length > 0;
  if (!beneficial || lane.kind !== "real" || !lane.explicit) return null;
  active = await startRouter(lane, workspace);
  return active;
}

/** 当前活动路由器（观测/测试用）。 */
export function activeRouter(): RouterHandle | null {
  return active;
}

// ---- 转发链 ----------------------------------------------------------------

interface Attempt {
  lane: ResolvedLane;
  key: string;
  keyIndex: number;
}

/** 构造尝试序列：车道 × key 池（每 key 一次），降级链铺在后面。 */
function attemptsOf(lane: ResolvedLane, cfgLanes: Record<string, unknown>): Attempt[] {
  const out: Attempt[] = [];
  const emit = (l: ResolvedLane): void => {
    const keys = l.keys.length > 0 ? l.keys : [""];
    for (let i = 0; i < keys.length; i++) out.push({ lane: l, key: keys[i]!, keyIndex: i });
  };
  emit(lane);
  for (const fb of lane.fallbacks) {
    const raw = (cfgLanes[fb] ?? null) as Record<string, unknown> | null;
    if (!raw) continue;
    const spec = PROVIDERS[fb];
    const keys = [String(raw.api_key ?? ""), ...(Array.isArray(raw.api_keys) ? raw.api_keys.map(String) : [])]
      .map((s) => s.trim()).filter((s, i, a) => s.length > 0 && a.indexOf(s) === i);
    emit({
      name: fb, kind: "real",
      gateway: String(raw.gateway ?? spec?.gateway ?? "").trim(),
      model: String(raw.model ?? spec?.model ?? "").trim(),
      keys, thinking: "", timeout_ms: String(raw.timeout_ms ?? ""),
      fallbacks: [], origin: `fallback 车道 ${fb}`, provider: raw.provider && PROVIDERS[String(raw.provider)] ? String(raw.provider) : (spec ? fb : undefined),
    });
  }
  return out;
}

async function appendLedger(workspace: string, e: LedgerEntry): Promise<void> {
  try {
    const dir = path.join(workspace, "runtime");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "llm-ledger.jsonl"), JSON.stringify(e) + "\n", "utf-8");
  } catch {
    // 台账失败静默（观测面不挡业务）
  }
}

function todayBudgetUsed(workspace: string, budget: number): number {
  try {
    const file = path.join(workspace, "runtime", "llm-ledger.jsonl");
    if (!fs.existsSync(file)) return 0;
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    for (const l of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!l.trim().startsWith("{")) continue;
      try {
        const e = JSON.parse(l) as LedgerEntry;
        if (e.ts.startsWith(today) && e.status === "ok") n++;
      } catch { /* 坏行跳过 */ }
    }
    return n;
  } catch {
    return 0;
  }
}


// ---- key 池状态落盘（v0.5.5：跨进程共享冷却） --------------------------------

export interface PoolKeyState {
  /** 冷却到期（epoch ms；小于当下 = 不在冷却）。 */
  until: number;
  /** 连续失败次数（冷却时长按档位放大）。 */
  fails: number;
  last_status: string;
  last_ts: string;
}

export type PoolState = Record<string, Record<string, PoolKeyState>>;

function poolFile(ws: string): string {
  return path.join(ws, "runtime", "llm-pool.json");
}

/** 读池状态（坏文件 → 空对象不炸）。 */
export function readPool(ws: string): PoolState {
  try {
    const file = poolFile(ws);
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (raw === null || typeof raw !== "object") return {};
    const out: PoolState = {};
    for (const [lane, keys] of Object.entries(raw as Record<string, unknown>)) {
      if (keys === null || typeof keys !== "object") continue;
      const laneOut: Record<string, PoolKeyState> = {};
      for (const [keyId, v] of Object.entries(keys as Record<string, unknown>)) {
        if (v === null || typeof v !== "object") continue;
        const s = v as Record<string, unknown>;
        laneOut[keyId] = {
          until: Number(s.until ?? 0) || 0,
          fails: Number(s.fails ?? 0) || 0,
          last_status: String(s.last_status ?? ""),
          last_ts: String(s.last_ts ?? ""),
        };
      }
      if (Object.keys(laneOut).length > 0) out[lane] = laneOut;
    }
    return out;
  } catch {
    return {};
  }
}

function writePool(ws: string, pool: PoolState): void {
  try {
    fs.mkdirSync(path.join(ws, "runtime"), { recursive: true });
    const tmp = `${poolFile(ws)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pool, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, poolFile(ws));
  } catch {
    // 池状态写失败静默（排序优化丢了不影响正确性 —— 只是照原序用 key）
  }
}

/** 冷却时长档位：60s 起，连续失败放大（5 档封顶 300s）。 */
function cooldownMs(fails: number): number {
  return Math.min(60_000 * Math.max(1, fails), 300_000);
}

/** 记一次 key 失败：429/5xx/timeout 进冷却；其它 4xx 只记状态（key 失效是常态，不冷却）。 */
export function recordKeyFailure(ws: string, laneName: string, keyId: string, status: string): void {
  const coolable = status === "429" || (/^\d+$/.test(status) && Number(status) >= 500) || status === "timeout" || status === "net-error";
  const pool = readPool(ws);
  const lane = pool[laneName] ?? {};
  const prev = lane[keyId] ?? { until: 0, fails: 0, last_status: "", last_ts: "" };
  const fails = coolable ? prev.fails + 1 : prev.fails;
  lane[keyId] = {
    until: coolable ? Date.now() + cooldownMs(fails) : prev.until,
    fails,
    last_status: status,
    last_ts: new Date().toISOString(),
  };
  pool[laneName] = lane;
  writePool(ws, pool);
}

/** 记一次 key 成功：清冷却与连续失败计数。 */
export function recordKeyOk(ws: string, laneName: string, keyId: string): void {
  const pool = readPool(ws);
  const lane = pool[laneName];
  if (!lane || !lane[keyId]) return; // 无状态零写盘（常见路径零成本）
  delete lane[keyId];
  if (Object.keys(lane).length === 0) delete pool[laneName];
  writePool(ws, pool);
}

/** 池健康观测（CLI / chat / Web 三端渲染共用）。 */
export interface LanePoolView {
  lane: string;
  keys: Array<{ key_id: string; cooling: boolean; until?: string; fails: number; last_status: string }>;
}

export function poolView(ws: string, laneName?: string): LanePoolView[] {
  const pool = readPool(ws);
  const now = Date.now();
  const out: LanePoolView[] = [];
  for (const [lane, keys] of Object.entries(pool)) {
    if (laneName && lane !== laneName) continue;
    const list = Object.entries(keys).map(([key_id, s]) => ({
      key_id,
      cooling: s.until > now,
      ...(s.until > now ? { until: new Date(s.until).toISOString() } : {}),
      fails: s.fails,
      last_status: s.last_status,
    }));
    if (list.length > 0) out.push({ lane, keys: list });
  }
  return out;
}

/** 冷却中的 key 沉底（稳定排序；全冷却 → 原序照用，不阻断）。 */
function orderAttemptsByCooldown(attempts: Attempt[], ws: string): Attempt[] {
  const pool = readPool(ws);
  const laneKeys = pool[(attempts[0]?.lane.name ?? "")];
  if (!laneKeys || attempts.length < 2) return attempts;
  const now = Date.now();
  const cooling = (a: Attempt): boolean => {
    const s = laneKeys[keyFingerprint(a.key, a.keyIndex)];
    return s !== undefined && s.until > now;
  };
  // 稳定排序（ES2019+ 保证）：冷却的沉底，其余保持轮转序
  return [...attempts].sort((a, b) => (cooling(a) ? 1 : 0) - (cooling(b) ? 1 : 0));
}

/** 预算水位（v0.5.5：三端渲染统一口径）。 */
export interface BudgetWatermark {
  budget: number;
  used: number;
  remaining: number;
  exceeded: boolean;
}

export function budgetWatermark(workspace: string): BudgetWatermark {
  const budget = Number((loadConfig().budget_requests ?? "").trim() || "0");
  if (budget <= 0) return { budget: 0, used: 0, remaining: 0, exceeded: false };
  const used = todayBudgetUsed(workspace, budget);
  return { budget, used, remaining: Math.max(0, budget - used), exceeded: used >= budget };
}

// ---- 服务器 ----------------------------------------------------------------

async function startRouter(lane: ResolvedLane, workspace: string): Promise<RouterHandle> {
  const rotation = { next: 0 };
  const laneName = lane.name;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
        return Response.json({ ok: true, router: "org-provider-router/0.5.1", lane: laneName });
      }
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `router: ${req.method} ${url.pathname} 不支持（仅 OpenAI 兼容 /v1/chat/completions）` } }, { status: 404 });
      }
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: { message: "router: 请求体不是合法 JSON" } }, { status: 400 });
      }
      const stream = body.stream === true;
      // 每请求重读配置（v0.5.1 修正：路由器不缓存车道快照 —— 用户改
      // config.json / 环境发现变化即刻生效，无需重启进程；车道被删则 502）
      const cfgNow = loadConfig();
      const budget = Number((cfgNow.budget_requests ?? "").trim() || "0");
      const liveLane = cfgNow.lanes[laneName]
        ? { ...lane, ...laneFromCfg(cfgNow.lanes[laneName]!) }
        : lane;
      // 预算水位（按当日成功请求数；budget 每请求重读）
      if (budget > 0 && todayBudgetUsed(workspace, budget) >= budget) {
        await appendLedger(workspace, {
          ts: new Date().toISOString(), lane: laneName, upstream: "", key_id: "-",
          model: liveLane.model, stream, status: "budget", ms: 0,
        });
        return Response.json(
          { error: { message: `org budget: 当日 ${budget} 次请求预算已用尽（org config set budget_requests 调整）`, type: "budget_exceeded" } },
          { status: 429 },
        );
      }
      const attempts = attemptsOf(liveLane, cfgNow.lanes ?? {});
      if (attempts.length === 0) {
        return Response.json({ error: { message: "router: 车道无可尝试的 key" } }, { status: 502 });
      }
      // key 池轮转起点（round-robin：每次请求从池的下一个 key 开始）
      const start = attempts.length > 1 ? rotation.next++ % Math.max(1, liveLane.keys.length) : 0;
      const rotated = attempts.slice(start).concat(attempts.slice(0, Math.min(start, attempts.length - start)));
      // v0.5.5：冷却中的 key 沉底（池状态跨进程共享 —— llm-pool.json）
      const ordered = orderAttemptsByCooldown(rotated, workspace);
      let lastStatus = "net-error";
      let lastCode = 502;
      let lastMsg = "全部尝试失败";
      for (const a of ordered) {
        if (a.lane.gateway.length === 0) continue;
        const forward: Record<string, unknown> = { ...body };
        if (a.lane.model.length > 0) forward.model = a.lane.model; // 降级车道模型名改写
        if (stream) forward.stream_options = { include_usage: true };
        const timeoutMs = Number(a.lane.timeout_ms || process.env.DHV_LLM_TIMEOUT_MS || "180000") || 180_000;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, Math.min(timeoutMs, 600_000)));
        const t0 = Date.now();
        try {
          const spec = a.lane.provider ? PROVIDERS[a.lane.provider] : undefined;
          const res = await fetch(`${a.lane.gateway.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(a.key ? { Authorization: `Bearer ${a.key}` } : {}),
              ...(spec?.extraHeaders ?? {}),
            },
            body: JSON.stringify(forward),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          const ms = Date.now() - t0;
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            lastStatus = String(res.status);
            lastCode = res.status >= 500 ? 502 : res.status;
            lastMsg = text.slice(0, 300);
            await appendLedger(workspace, {
              ts: new Date().toISOString(), lane: a.lane.name, upstream: hostOf(a.lane.gateway),
              key_id: keyFingerprint(a.key, a.keyIndex), model: a.lane.model, stream,
              status: String(res.status), code: res.status, ms,
            });
            recordKeyFailure(workspace, a.lane.name, keyFingerprint(a.key, a.keyIndex), String(res.status));
            // stream_options 不被支持（部分服务商 4xx 明示）→ 去 option 重试本 key 一次
            if (stream && res.status >= 400 && res.status < 500 && /stream_options|include_usage/i.test(text)) {
              delete forward.stream_options;
              const retry = await fetch(`${a.lane.gateway.replace(/\/+$/, "")}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(a.key ? { Authorization: `Bearer ${a.key}` } : {}), ...(spec?.extraHeaders ?? {}) },
                body: JSON.stringify(forward),
                signal: ctrl.signal,
              });
              if (retry.ok) return relay(retry, { lane: a, stream, workspace, ms: Date.now() - t0 });
            }
            if (res.status === 429 || res.status >= 500) continue; // 可重试错误 → 下一个 key / 车道
            continue; // 4xx（key 失效等）→ 也换 key（个别 key 失效是常态）
          }
          return relay(res, { lane: a, stream, workspace, ms });
        } catch (e) {
          clearTimeout(timer);
          lastStatus = "timeout";
          lastCode = 504;
          lastMsg = (e as Error).message;
          await appendLedger(workspace, {
            ts: new Date().toISOString(), lane: a.lane.name, upstream: hostOf(a.lane.gateway),
            key_id: keyFingerprint(a.key, a.keyIndex), model: a.lane.model, stream,
            status: "timeout", ms: Date.now() - t0,
          });
          recordKeyFailure(workspace, a.lane.name, keyFingerprint(a.key, a.keyIndex), "timeout");
          continue; // 超时/网络 → 下一车道（换 key 对超时意义不大，但链会推进）
        }
      }
      return Response.json(
        { error: { message: `router: ${lastMsg}`, type: "upstream_failed", status: lastStatus, lane: laneName } },
        { status: lastCode },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    port: server.port,
    laneName,
    stop: () => {
      try { server.stop(true); } catch { /* 已停 */ }
      active = null;
    },
  };
}

/** LaneConfig（文件形态）→ 轻量运行形态（handler 内每请求重读用）。 */
function laneFromCfg(l: { gateway?: string; api_key?: string; model?: string; thinking?: string; timeout_ms?: string; api_keys?: unknown; fallbacks?: unknown; provider?: string }): Pick<ResolvedLane, "gateway" | "model" | "keys" | "thinking" | "timeout_ms" | "fallbacks" | "provider"> {
  const keys: string[] = [];
  const push = (k: string): void => {
    const t = (k ?? "").trim();
    if (t.length > 0 && !keys.includes(t)) keys.push(t);
  };
  push(l.api_key ?? "");
  if (Array.isArray(l.api_keys)) for (const k of l.api_keys) push(String(k));
  return {
    gateway: (l.gateway ?? "").trim(),
    model: (l.model ?? "").trim(),
    keys,
    thinking: (l.thinking ?? "").trim(),
    timeout_ms: (l.timeout_ms ?? "").trim(),
    fallbacks: Array.isArray(l.fallbacks) ? l.fallbacks.map(String) : [],
    provider: l.provider ?? "",
  };
}

function hostOf(gateway: string): string {
  try { return new URL(gateway).host; } catch { return gateway; }
}

interface RelayCtx {
  lane: Attempt;
  stream: boolean;
  workspace: string;
  ms: number;
}

/** 转发成功响应；流式透传并尽力从尾部 data 帧收 usage 计入台账。 */
async function relay(res: Response, ctx: RelayCtx): Promise<Response> {
  const { lane, stream, workspace, ms } = ctx;
  const keyId = keyFingerprint(lane.key, lane.keyIndex);
  // v0.5.5：成功即清冷却与失败计数（池状态跨进程共享）
  recordKeyOk(workspace, lane.lane.name, keyId);
  if (!stream) {
    const text = await res.text();
    let tokens: number | undefined;
    try {
      const data = JSON.parse(text) as { usage?: { total_tokens?: number } };
      tokens = data.usage?.total_tokens;
    } catch { /* 非 JSON（罕见）照常透传 */ }
    await appendLedger(workspace, {
      ts: new Date().toISOString(), lane: lane.lane.name, upstream: hostOf(lane.lane.gateway),
      key_id: keyId, model: lane.lane.model, stream: false, status: "ok", ms, tokens,
    });
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  }
  // 流式：读取整条流并透传（保持逐块推送节奏），尾部帧解析 usage
  const upstream = res.body;
  if (!upstream) {
    await appendLedger(workspace, {
      ts: new Date().toISOString(), lane: lane.lane.name, upstream: hostOf(lane.lane.gateway),
      key_id: keyId, model: lane.lane.model, stream: true, status: "ok", ms,
    });
    return new Response(null, { status: res.status, headers: { "Content-Type": "text/event-stream" } });
  }
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let usage: number | undefined;
  const out = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // 尽力从尾部 data 帧收 usage（include_usage 被注入时 OpenAI 兼容端普遍回包）
        for (const m of tail.matchAll(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/g)) {
          usage = Number(m[1]);
        }
        await appendLedger(workspace, {
          ts: new Date().toISOString(), lane: lane.lane.name, upstream: hostOf(lane.lane.gateway),
          key_id: keyId, model: lane.lane.model, stream: true, status: "ok", ms, tokens: usage,
        });
        controller.close();
        return;
      }
      const chunk = decoder.decode(value, { stream: true });
      tail = (tail + chunk).slice(-4096); // 只留尾部足够解析 usage 的窗口
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel();
    },
  });
  return new Response(out, {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---- 车道环境准备（CLI / chat / TUI / Web 的统一 choke point） ---------------

/**
 * 解析模型旗标 → 注入车道环境 → 按需启动本地路由器。
 *
 * 调用时机：任何将要 spawn HSL 子进程（真实车道）之前。幂等；车道切换时
 * 路由器自动重建。返回解析后的车道（显示 / 归因用）。
 *
 * 降级链：路由器启动失败 → 静默直连（DHV_LLM_GATEWAY 保持真实网关）；
 * 车道不显式（无 key 的服务商名猜测）→ 不注入，回落 z-ai SDK 车道。
 */
export async function prepareLlmEnv(modelFlag: string, workspace: string): Promise<ResolvedLane> {
  snapshotUserEnv();
  const lane = resolveModelFlag(modelFlag);
  applyLaneToEnv(lane);
  if (lane.kind === "real" && lane.explicit) {
    try {
      const router = await ensureRouter(lane, workspace);
      if (router && !isUserOwnedEnv("DHV_LLM_GATEWAY")) {
        process.env.DHV_LLM_GATEWAY = router.url;
      }
    } catch {
      // 路由器启动失败：静默降级直连（观测面照旧，业务零影响）
    }
  }
  return lane;
}

// ---- 台账读取（org providers / cost 面板共用） --------------------------------

export interface LedgerStats {
  total: number;
  ok: number;
  failed: number;
  today: number;
  today_ok: number;
  byLane: Record<string, { ok: number; failed: number }>;
  recent: LedgerEntry[];
}

export function readLedger(workspace: string): LedgerStats {
  const stats: LedgerStats = { total: 0, ok: 0, failed: 0, today: 0, today_ok: 0, byLane: {}, recent: [] };
  try {
    const file = path.join(workspace, "runtime", "llm-ledger.jsonl");
    if (!fs.existsSync(file)) return stats;
    const today = new Date().toISOString().slice(0, 10);
    for (const l of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!l.trim().startsWith("{")) continue;
      try {
        const e = JSON.parse(l) as LedgerEntry;
        stats.total++;
        if (e.ts.startsWith(today)) stats.today++;
        const lane = stats.byLane[e.lane] ?? { ok: 0, failed: 0 };
        if (e.status === "ok") {
          stats.ok++; lane.ok++;
          if (e.ts.startsWith(today)) stats.today_ok++;
        } else {
          stats.failed++; lane.failed++;
        }
        stats.byLane[e.lane] = lane;
        stats.recent.push(e);
      } catch { /* 坏行跳过 */ }
    }
    stats.recent = stats.recent.slice(-20);
  } catch { /* 台账缺失按空 */ }
  return stats;
}
