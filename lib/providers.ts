// ============================================================================
// lib/providers.ts — 主流模型服务商注册表与车道解析（v0.5.1）
// ----------------------------------------------------------------------------
// 「支持所有主流 API key 模式」的单一事实来源：
//   1. 服务商注册表 PROVIDERS：18+ 主流服务商（OpenAI 兼容协议端点），
//      每个携带：网关、缺省模型、key 的环境变量名、附加头、说明。
//   2. 环境变量自动发现 discoverEnvLanes()：用户 shell 里已 export 的
//      OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY … 即刻可用。
//   3. 车道解析 resolveLane()：--model 旗标 / default_lane / 裸模型 id
//      三种输入统一归一为 ResolvedLane（scripted 或真实车道 + key 池 +
//      降级链），供 CLI / chat / TUI / Web 共用。
//   4. 连通测试 testLane()：1-token 真实请求（CLI `org config test` 与
//      Web providers 面板共用同一实现）。
//
// 设计纪律（多重优雅降级）：
//   - 全部服务商走 OpenAI 兼容端点（anthropic/gemini 亦提供兼容端点），
//     不需要为原生协议分叉实现 —— 一条协议打天下。
//   - 解析任何一步失败（配置缺失 / 车道名拼错 / 文件损坏）都回落到
//     scripted 或空车道，绝不炸主流程。
// ============================================================================

import { loadConfig, type UserConfig, type LaneConfig } from "./config.ts";
import { PROVIDERS, PROVIDER_NAMES, discoverEnvLanes, type EnvDiscovery } from "./provider-registry.ts";

export { PROVIDERS, PROVIDER_NAMES, discoverEnvLanes } from "./provider-registry.ts";
export type { ProviderSpec, EnvDiscovery } from "./provider-registry.ts";

// ---- 车道解析 ---------------------------------------------------------------

export type LaneKind = "scripted" | "real";

export interface ResolvedLane {
  /** 车道名（scripted / 配置车道名 / "model:<id>" 裸模型）。 */
  name: string;
  kind: LaneKind;
  /** OpenAI 兼容网关（real 车道；scripted 为空）。 */
  gateway: string;
  /** 模型名（scripted 为空）。 */
  model: string;
  /** key 池（含主 key + api_keys；本地推理为空数组）。 */
  keys: string[];
  thinking: string;
  timeout_ms: string;
  /** 降级链（车道名列表，按序）。 */
  fallbacks: string[];
  /** 车道来源描述（显示用）。 */
  origin: string;
  /** 服务商注册表名（有则带附加头）。 */
  provider?: string;
  /** 显式配置的车道（文件/环境变量/env 发现）：注入 DHV_LLM_*。
   *  false = 服务商名猜测（无 key 无网关）—— 不注入，回落 z-ai SDK 车道
   *  （与 v0.4.x 行为完全一致：--model deepseek 未配 key 时走 SDK）。 */
  explicit: boolean;
}

export function scriptedLane(): ResolvedLane {
  return {
    name: "scripted", kind: "scripted", gateway: "", model: "", keys: [],
    thinking: "", timeout_ms: "", fallbacks: [], origin: "剧本车道（确定性 · 零外联）",
    explicit: true,
  };
}

/** LaneConfig（文件形态）→ ResolvedLane（运行形态）。key 池 = api_key + api_keys 去重。 */
export function laneFromConfig(name: string, lane: LaneConfig, origin: string): ResolvedLane {
  const keys: string[] = [];
  const push = (k: string): void => {
    const t = (k ?? "").trim();
    if (t.length > 0 && !keys.includes(t)) keys.push(t);
  };
  push(lane.api_key);
  for (const k of lane.api_keys ?? []) push(k);
  const provider = lane.provider && PROVIDERS[lane.provider] ? lane.provider : undefined;
  return {
    name, kind: "real",
    gateway: (lane.gateway ?? "").trim(),
    model: (lane.model ?? "").trim(),
    keys,
    thinking: (lane.thinking ?? "").trim(),
    timeout_ms: (lane.timeout_ms ?? "").trim(),
    fallbacks: (lane.fallbacks ?? []).map((s) => s.trim()).filter((s) => s.length > 0 && s !== name),
    origin,
    provider,
    explicit: (lane.gateway ?? "").trim().length > 0, // 文件车道显式配置
  };
}

function laneFromEnvDiscovery(d: EnvDiscovery, extra: Partial<LaneConfig> = {}): ResolvedLane {
  const spec = PROVIDERS[d.provider]!;
  return {
    name: d.provider, kind: "real",
    gateway: (extra.gateway ?? spec.gateway).trim(),
    model: (extra.model ?? spec.model).trim(),
    keys: [d.key],
    thinking: (extra.thinking ?? "").trim(),
    timeout_ms: (extra.timeout_ms ?? "").trim(),
    fallbacks: [],
    origin: `环境变量 ${d.envName} 自动发现（${spec.label}）`,
    provider: d.provider,
    explicit: true,
  };
}

/**
 * 解析 `--model` 旗标（chat/run/ask/tui/web 的统一入口）：
 *   "scripted"        → 剧本车道
 *   配置车道名        → 该车道（key 池 + 降级链完整携带）
 *   其他非空字符串    → 裸模型 id：当前缺省网关上切模型（DHV_LLM_MODEL）
 * 空 / 未配置        → 按缺省车道解析（default_lane → env 发现 → scripted）
 */
export function resolveModelFlag(flag: string, cfg?: UserConfig): ResolvedLane {
  const c = cfg ?? loadConfig();
  const f = (flag ?? "").trim();
  if (f === "scripted") return scriptedLane();
  if (f.length > 0 && c.lanes[f]) return laneFromConfig(f, c.lanes[f]!, "配置文件车道（org config lane）");
  if (f.length > 0 && PROVIDERS[f]) {
    // 未配置的服务商名：环境变量发现优先；否则仅提示（不注入 —— 回落
    // z-ai SDK 车道，与 v0.4.x `--model deepseek` 未配 key 行为一致）
    const d = discoverEnvLanes().find((x) => x.provider === f);
    if (d) return laneFromEnvDiscovery(d);
    const spec = PROVIDERS[f]!;
    return {
      name: f, kind: "real", gateway: spec.gateway, model: spec.model, keys: [],
      thinking: "", timeout_ms: "", fallbacks: [], origin: `服务商预设（${spec.label} · 未配 key，回落 SDK 车道）`,
      provider: f, explicit: false,
    };
  }
  if (f.length > 0) {
    // 裸模型 id：沿用缺省车道的网关与 key，仅模型名覆盖；基底是剧本则整体剧本
    const base = resolveDefaultLane(c);
    if (base.kind === "scripted" || !base.explicit) {
      return { ...scriptedLane(), name: `model:${f}`, origin: `裸模型 ${f}（无可用网关 → 剧本车道）` };
    }
    return { ...base, name: `model:${f}`, model: f, fallbacks: base.fallbacks.filter((x) => x !== base.name) };
  }
  return resolveDefaultLane(c);
}

/** 缺省车道：default_lane（文件车道）→ 环境变量发现 → 空（scripted 由调用方兜底）。 */
export function resolveDefaultLane(cfg?: UserConfig): ResolvedLane {
  const c = cfg ?? loadConfig();
  const dl = (c.default_lane ?? "").trim();
  if (dl === "scripted") return scriptedLane();
  if (dl.length > 0 && c.lanes[dl]) return laneFromConfig(dl, c.lanes[dl]!, "缺省车道（org config use）");
  // 平面配置（v1 形态，无 lanes）：直接组车道
  if ((c.gateway ?? "").trim().length > 0) {
    return {
      name: "default", kind: "real",
      gateway: c.gateway.trim(), model: (c.model ?? "").trim(),
      keys: keyPoolOf(c), thinking: (c.thinking ?? "").trim(), timeout_ms: (c.timeout_ms ?? "").trim(),
      fallbacks: (c.fallbacks ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
      origin: "平面配置（org config set）", explicit: true,
    };
  }
  // 环境变量发现：显式 DHV_LLM_GATEWAY + 服务商 key
  const explicitGateway = (process.env.DHV_LLM_GATEWAY ?? "").trim();
  const discovered = discoverEnvLanes();
  if (explicitGateway.length > 0) {
    const explicitKey = (process.env.DHV_LLM_API_KEY ?? "").trim();
    return {
      name: "env", kind: "real", gateway: explicitGateway,
      model: (process.env.DHV_LLM_MODEL ?? "").trim(),
      keys: explicitKey.length > 0 ? [explicitKey] : [],
      thinking: (process.env.DHV_LLM_THINKING ?? "").trim(),
      timeout_ms: (process.env.DHV_LLM_TIMEOUT_MS ?? "").trim(),
      fallbacks: (c.fallbacks ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
      origin: "环境变量 DHV_LLM_*", explicit: true,
    };
  }
  if (discovered.length > 0) {
    // 多个发现：default_lane 指名优先，否则按服务商名稳定排序取首个
    const pick = dl.length > 0
      ? discovered.find((d) => d.provider === dl) ?? discovered[0]!
      : discovered[0]!;
    return laneFromEnvDiscovery(pick);
  }
  return scriptedLane();
}

/** 配置的 key 池（平面形态：api_key + api_keys 去重）。 */
export function keyPoolOf(cfg: UserConfig): string[] {
  const keys: string[] = [];
  const push = (k: string): void => {
    const t = (k ?? "").trim();
    if (t.length > 0 && !keys.includes(t)) keys.push(t);
  };
  push(cfg.api_key);
  for (const k of cfg.api_keys ?? []) push(k);
  return keys;
}

// ---- 车道环境注入（供子进程继承） --------------------------------------------

/**
 * 把解析后的车道注入 DHV_LLM_* 环境变量。
 * 只覆盖「本进程注入层」：用户 shell 显式 export 的变量不碰（env > 程序）。
 * 返回注入键数（横幅/测试可断言）。
 */
export function applyLaneToEnv(lane: ResolvedLane): number {
  let n = 0;
  const set = (envName: string, value: string): void => {
    if (value.length === 0) return;
    if (userOwnedEnv.has(envName)) return; // 用户显式设置优先
    if ((process.env[envName] ?? "") === value) return;
    process.env[envName] = value;
    n++;
  };
  if (lane.kind === "real") {
    // 非显式车道（服务商名猜测，无 key）不注入网关 —— 回落 z-ai SDK 车道
    if (lane.explicit) {
      set("DHV_LLM_GATEWAY", lane.gateway);
      set("DHV_LLM_MODEL", lane.model);
      if (lane.keys.length > 0) set("DHV_LLM_API_KEY", lane.keys[0]!);
      if (lane.keys.length > 1) set("ORG_LLM_KEY_POOL", lane.keys.join(","));
      set("DHV_LLM_THINKING", lane.thinking);
      set("DHV_LLM_TIMEOUT_MS", lane.timeout_ms);
      if (lane.fallbacks.length > 0) set("ORG_LLM_FALLBACKS", lane.fallbacks.join(","));
      if (lane.provider && PROVIDERS[lane.provider]?.extraHeaders) {
        set("ORG_LLM_EXTRA_HEADERS", JSON.stringify(PROVIDERS[lane.provider]!.extraHeaders));
      }
    }
    set("ORG_LANE_KIND", "real");
  } else {
    set("ORG_LANE_KIND", "scripted");
  }
  return n;
}

/** 启动时快照：哪些 DHV_LLM / ORG_LLM 前缀变量是用户 shell 显式设置的（不可覆盖层）。 */
const userOwnedEnv = new Set<string>();
/** 某环境变量是否用户显式设置（路由器等改写前的守门）。 */
export function isUserOwnedEnv(name: string): boolean {
  return userOwnedEnv.has(name);
}
export function snapshotUserEnv(): number {
  const names = [
    "DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL", "DHV_LLM_THINKING",
    "DHV_LLM_TIMEOUT_MS", "ORG_LLM_KEY_POOL", "ORG_LLM_FALLBACKS", "ORG_LLM_EXTRA_HEADERS",
    "ORG_DEFAULT_MODEL",
  ];
  for (const n of names) {
    if ((process.env[n] ?? "").trim().length > 0) userOwnedEnv.add(n);
  }
  return userOwnedEnv.size;
}

// ---- 连通测试（CLI `org config test [lane]` 与 Web providers 面板共用） -------

export interface LaneTestResult {
  ok: boolean;
  lane: string;
  gateway: string;
  model: string;
  ms: number;
  reply?: string;
  tokens?: number;
  error?: string;
  triedKeys?: number;
}

/** 对车道发一次 1-token 真实请求（多重降级：逐 key 尝试，429/5xx 换 key）。 */
export async function testLane(lane: ResolvedLane, timeoutMs = 30_000): Promise<LaneTestResult> {
  const base: LaneTestResult = { ok: false, lane: lane.name, gateway: lane.gateway, model: lane.model, ms: 0 };
  if (lane.kind === "scripted" || lane.gateway.length === 0) {
    return { ...base, ok: lane.kind === "scripted", error: lane.kind === "scripted" ? undefined : "未配置网关" };
  }
  if (lane.model.length === 0) return { ...base, error: "未配置模型名（org config set model <name>）" };
  const keys = lane.keys.length > 0 ? lane.keys : [""];
  const spec = lane.provider ? PROVIDERS[lane.provider] : undefined;
  let tried = 0;
  let lastErr = "";
  for (const key of keys) {
    tried++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(`${lane.gateway.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(spec?.extraHeaders ?? {}),
        },
        body: JSON.stringify({ model: lane.model, stream: false, max_tokens: 8, messages: [{ role: "user", content: "回复一个字：好" }] }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        lastErr = `HTTP ${res.status} ${body.slice(0, 160)}`;
        if (res.status === 429 || res.status >= 500) continue; // 换下一个 key
        return { ...base, ms, error: lastErr, triedKeys: tried }; // 4xx（鉴权/参数）：换 key 也无用，但继续试（key 可能个别失效）
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
      return {
        ...base, ok: true, ms,
        reply: (data.choices?.[0]?.message?.content ?? "").trim().slice(0, 30),
        tokens: data.usage?.total_tokens,
        triedKeys: tried,
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e as Error).message;
      // 网络错误 / 超时：本地服务可能是“未启动”而非“key 坏”—— 直接返回诊断
      return { ...base, ms: Date.now() - t0, error: lastErr, triedKeys: tried };
    }
  }
  return { ...base, error: lastErr || "全部 key 失败", triedKeys: tried };
}

/** 列出全部服务商的健康快照（configured / env-key / local / unknown）。 */
export interface ProviderRow {
  name: string;
  label: string;
  gateway: string;
  model: string;
  local: boolean;
  status: "lane" | "env" | "preset" | "flat";
  envName?: string;
  keys: number;
  fallbacks: string[];
  default: boolean;
}

export function providerRows(cfg?: UserConfig): ProviderRow[] {
  const c = cfg ?? loadConfig();
  const env = discoverEnvLanes();
  const rows: ProviderRow[] = [];
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const lane = c.lanes[name];
    const d = env.find((x) => x.provider === name);
    let status: ProviderRow["status"] = "preset";
    let keys = 0;
    let fallbacks: string[] = [];
    if (lane) {
      status = "lane";
      keys = laneFromConfig(name, lane, "").keys.length;
      fallbacks = lane.fallbacks ?? [];
    } else if (d) {
      status = "env";
      keys = 1;
    } else if (name === "default") {
      status = "flat";
    }
    rows.push({
      name, label: spec.label, gateway: spec.gateway, model: spec.model,
      local: Boolean(spec.local), status, envName: d?.envName,
      keys, fallbacks,
      default: (c.default_lane ?? "") === name,
    });
  }
  return rows;
}
