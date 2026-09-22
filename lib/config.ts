// ============================================================================
// lib/config.ts — 用户模型/API 配置（v0.5.1：车道 / key 池 / 降级链 / 预算）
// ----------------------------------------------------------------------------
// 主流 Agent（codex ~/.codex/config.toml / opencode opencode.json）的标配：
// 用户可持久化配置自己的模型与 API 端点，不必每次 export 环境变量。
//
// 优先级（高 → 低）：
//   CLI 旗标（--model 车道名） > 环境变量（DHV_LLM_* / 服务商 *_API_KEY）
//   > 配置文件 > 内建缺省（scripted）
//
// 配置文件：~/.org/config.json（与单二进制运行时同根，跨版本持久）；
// ORG_CONFIG 环境变量可指向自定义路径。v0.5.1 起支持车道形态：
//   {
//     "version": 3,
//     "lanes": {                       // 命名车道（org config preset / lane add 创建）
//       "deepseek": {
//         "gateway": "https://api.deepseek.com/v1",
//         "api_key": "sk-…",
//         "api_keys": ["sk-备用1"],     // key 池（轮换）
//         "model": "deepseek-chat",
//         "fallbacks": ["openrouter"], // 降级链
//         "provider": "deepseek"
//       }
//     },
//     "default_lane": "deepseek",
//     "budget_requests": "200",        // 当日请求预算（路由器强制）
//     // v1 平面字段（缺省车道镜像，老版本/只配一条车道时直接用）
//     "gateway": "…", "api_key": "…", "model": "…",
//     "thinking": "…", "timeout_ms": "…"
//   }
// 兼容纪律：v1 平面形态完全保留 —— 老文件不改一行照常生效；
// 任何车道变更同步镜像到平面字段（所有既有消费者零改动）。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROVIDERS } from "./provider-registry.ts";

/** 配置键（平面字段名 —— 全部 snake_case）。 */
export type ConfigKey =
  | "gateway" | "api_key" | "model" | "thinking" | "timeout_ms" | "default_lane"
  | "api_keys" | "fallbacks" | "budget_requests" | "desktop_notify"
  | "notify_webhook_url" | "notify_webhook_events"
  | "gh_token" | "gh_api";

export const CONFIG_KEYS: readonly ConfigKey[] = [
  "gateway", "api_key", "model", "thinking", "timeout_ms", "default_lane",
  "api_keys", "fallbacks", "budget_requests", "desktop_notify",
  "notify_webhook_url", "notify_webhook_events",
  "gh_token", "gh_api",
] as const;

/** 命名车道（文件形态）。 */
export interface LaneConfig {
  gateway: string;
  api_key: string;
  model: string;
  thinking: string;
  timeout_ms: string;
  api_keys: string[];
  fallbacks: string[];
  provider: string;
}

export function emptyLane(): LaneConfig {
  return { gateway: "", api_key: "", model: "", thinking: "", timeout_ms: "", api_keys: [], fallbacks: [], provider: "" };
}

/** 键归一：连字符/别名 → 规范键（CLI 输入容错）。 */
export function normalizeKey(raw: string): ConfigKey | null {
  const k = raw.trim().toLowerCase().replace(/-/g, "_");
  if ((CONFIG_KEYS as readonly string[]).includes(k)) return k as ConfigKey;
  if (k === "keys" || k === "key_pool" || k === "keypool") return "api_keys";
  if (k === "key" || k === "apikey" || k === "primary_key") return "api_key";
  if (k === "lane" || k === "default") return "default_lane";
  if (k === "base_url" || k === "baseurl" || k === "endpoint") return "gateway";
  if (k === "fallback" || k === "fallback_lanes") return "fallbacks";
  if (k === "budget" || k === "budget_per_day" || k === "requests_per_day") return "budget_requests";
  if (k === "desktop" || k === "notify" || k === "notifications") return "desktop_notify";
  if (k === "webhook" || k === "webhook_url") return "notify_webhook_url";
  if (k === "webhook_events" || k === "notify_events") return "notify_webhook_events";
  return null;
}

/** 配置条目形态（文件里就是这些字段；空串/空数组 = 未配置）。 */
export interface UserConfig {
  gateway: string;
  api_key: string;
  model: string;
  thinking: string;
  timeout_ms: string;
  default_lane: string;
  // v0.5.1（全部可选，老文件缺省为空）：
  api_keys: string[];
  fallbacks: string[];
  budget_requests: string;
  /** 桌面通知开关：on/off/auto（缺省 auto —— 检测到命令才发）。 */
  desktop_notify: string;
  /** 通知 webhook 出站（v0.5.5）：URL（空 = 关闭）。 */
  notify_webhook_url: string;
  /** webhook 事件过滤（逗号分隔 kind；空/"*" = 全发）。 */
  notify_webhook_events: string;
  /** GitHub token（v0.5.21 工单系统 #86/#82）：issue/PR 真集成鉴权（空 = 未配置）。 */
  gh_token: string;
  /** GitHub API base（GitHub Enterprise 指向 <host>/api/v3；空 = api.github.com）。 */
  gh_api: string;
  lanes: Record<string, LaneConfig>;
}

export function emptyConfig(): UserConfig {
  return {
    gateway: "", api_key: "", model: "", thinking: "", timeout_ms: "", default_lane: "",
    api_keys: [], fallbacks: [], budget_requests: "", desktop_notify: "",
    notify_webhook_url: "", notify_webhook_events: "", gh_token: "", gh_api: "",
    lanes: {},
  };
}

/** 服务商预设（org config preset <name> 一键写入；与 PROVIDERS 注册表同源）。 */
export interface Preset {
  label: string;
  gateway: string;
  model: string;
  note: string;
}

/** v0.4.16 六预设别名保持（老用户肌肉记忆 + 老测试引用不破）。 */
export const PRESETS: Record<string, Preset> = Object.fromEntries(
  Object.entries(PROVIDERS).map(([name, p]) => [name, { label: p.label, gateway: p.gateway, model: p.model, note: p.note }]),
);

// ---- 路径与读写 ---------------------------------------------------------------

/** 配置文件路径：ORG_CONFIG 显式指定 > ~/.org/config.json。 */
export function configPath(): string {
  if (process.env.ORG_CONFIG && process.env.ORG_CONFIG.trim().length > 0) {
    return path.resolve(process.env.ORG_CONFIG.trim());
  }
  const runtime = process.env.ORG_RUNTIME?.trim() || path.join(os.homedir(), ".org");
  return path.join(runtime, "config.json");
}

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (typeof v === "string") {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

/** 读配置（文件缺失/损坏 → 空配置，不炸主流程）。 */
export function loadConfig(file?: string): UserConfig {
  const p = file ?? configPath();
  const cfg = emptyConfig();
  if (!fs.existsSync(p)) return cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    for (const k of CONFIG_KEYS) {
      if (k === "api_keys" || k === "fallbacks") {
        cfg[k] = parseStringArray(raw[k]);
      } else if (k === "budget_requests") {
        const v = raw[k];
        if (typeof v === "string") cfg[k] = v.trim();
        else if (typeof v === "number") cfg[k] = String(v);
      } else {
        const v = raw[k];
        if (typeof v === "string") cfg[k] = v;
        else if (typeof v === "number") cfg[k] = String(v);
      }
    }
    if (raw.lanes && typeof raw.lanes === "object") {
      for (const [name, val] of Object.entries(raw.lanes as Record<string, unknown>)) {
        if (!val || typeof val !== "object") continue;
        const lane = emptyLane();
        const l = val as Record<string, unknown>;
        for (const field of ["gateway", "api_key", "model", "thinking", "timeout_ms", "provider"] as const) {
          const v = l[field];
          if (typeof v === "string") lane[field] = v.trim();
          else if (typeof v === "number") lane[field] = String(v);
        }
        lane.api_keys = parseStringArray(l.api_keys);
        lane.fallbacks = parseStringArray(l.fallbacks);
        if (name.trim().length > 0) cfg.lanes[name.trim()] = lane;
      }
    }
  } catch {
    // 损坏文件按空配置处理（用户可 org config set 修复）
  }
  return cfg;
}

/** 写配置（原子写：tmp → rename；目录自动创建）。 */
export function saveConfig(cfg: UserConfig, file?: string): string {
  const p = file ?? configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  const out: Record<string, unknown> = { version: 3 };
  for (const k of CONFIG_KEYS) (out as Record<string, unknown>)[k] = cfg[k];
  out.lanes = cfg.lanes;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
  return p;
}

// ---- 车道镜像（平面字段 ⟷ 缺省车道，双向同步） --------------------------------

/** 把缺省车道镜像到平面字段（所有既有消费者零改动）。 */
export function mirrorLaneToFlat(cfg: UserConfig): UserConfig {
  const dl = cfg.default_lane.trim();
  const lane = dl.length > 0 ? cfg.lanes[dl] : undefined;
  if (!lane) return cfg;
  cfg.gateway = lane.gateway;
  cfg.api_key = lane.api_key;
  cfg.model = lane.model;
  cfg.thinking = lane.thinking;
  cfg.timeout_ms = lane.timeout_ms;
  cfg.api_keys = [...lane.api_keys];
  return cfg;
}

/** 把平面字段镜像回缺省车道（org config set 直接改平面时保持车道一致）。 */
export function mirrorFlatToLane(cfg: UserConfig): UserConfig {
  const dl = cfg.default_lane.trim();
  if (dl.length === 0 || !cfg.lanes[dl]) return cfg;
  const lane = cfg.lanes[dl]!;
  lane.gateway = cfg.gateway;
  lane.api_key = cfg.api_key;
  lane.model = cfg.model;
  lane.thinking = cfg.thinking;
  lane.timeout_ms = cfg.timeout_ms;
  lane.api_keys = [...cfg.api_keys];
  return cfg;
}

// ---- 变更操作 ----------------------------------------------------------------

/** 单项设置（键归一 + 写回 + 车道镜像）。返回规范键；未知键返回 null。 */
export function setConfigValue(rawKey: string, value: string, file?: string): ConfigKey | null {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const cfg = loadConfig(file);
  if (key === "api_keys" || key === "fallbacks") {
    cfg[key] = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    cfg[key] = value.trim();
  }
  mirrorFlatToLane(cfg);
  saveConfig(cfg, file);
  return key;
}

/** 单项删除（存在则删并写回）。 */
export function unsetConfigValue(rawKey: string, file?: string): ConfigKey | null {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const cfg = loadConfig(file);
  if (key === "api_keys" || key === "fallbacks") {
    if (cfg[key].length === 0) return key;
    cfg[key] = [];
  } else {
    if (cfg[key] === "") return key;
    cfg[key] = "";
  }
  mirrorFlatToLane(cfg);
  saveConfig(cfg, file);
  return key;
}

/** 应用预设：写平面字段 + 创建命名车道 + 设为缺省（api_key 不动 —— 既有纪律）。 */
export function applyPreset(name: string, file?: string): string | null {
  const n = name.trim().toLowerCase();
  const p = PROVIDERS[n];
  if (!p) return null;
  const cfg = loadConfig(file);
  const oldKey = cfg.api_key;
  cfg.gateway = p.gateway;
  cfg.model = p.model;
  const lane = cfg.lanes[n] ?? emptyLane();
  lane.gateway = p.gateway;
  lane.model = p.model;
  lane.provider = n;
  cfg.lanes[n] = lane;
  cfg.default_lane = n;
  mirrorLaneToFlat(cfg);
  cfg.api_key = oldKey; // 预设不动 key（老测试锁定的行为）
  cfg.lanes[n]!.api_key = oldKey;
  saveConfig(cfg, file);
  return n;
}

/** 写入/更新命名车道（字段级合并；未指定字段不动）。 */
export function setLaneValue(name: string, field: string, value: string, file?: string): string | null {
  const n = name.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(n) || n === "scripted") return null;
  const cfg = loadConfig(file);
  const lane = cfg.lanes[n] ?? emptyLane();
  switch (field) {
    case "gateway": lane.gateway = value.trim(); break;
    case "api_key": lane.api_key = value.trim(); break;
    case "model": lane.model = value.trim(); break;
    case "thinking": lane.thinking = value.trim(); break;
    case "timeout_ms": lane.timeout_ms = value.trim(); break;
    case "provider": {
      const v = value.trim().toLowerCase();
      lane.provider = PROVIDERS[v] ? v : "";
      break;
    }
    case "api_keys": lane.api_keys = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0); break;
    case "fallbacks": lane.fallbacks = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0); break;
    default: return null;
  }
  cfg.lanes[n] = lane;
  mirrorLaneToFlat(cfg);
  saveConfig(cfg, file);
  return n;
}

/** 删除命名车道（若是缺省车道则清 default_lane，平面字段不动）。 */
export function removeLane(name: string, file?: string): string | null {
  const n = name.trim().toLowerCase();
  const cfg = loadConfig(file);
  if (!cfg.lanes[n]) return null;
  delete cfg.lanes[n];
  if (cfg.default_lane === n) cfg.default_lane = "";
  saveConfig(cfg, file);
  return n;
}

/** 切换缺省车道（车道存在才切；切完镜像到平面）。 */
export function useLane(name: string, file?: string): string | null {
  const cfg = loadConfig(file);
  const n = name.trim().toLowerCase();
  if (n === "scripted") {
    cfg.default_lane = "scripted";
    saveConfig(cfg, file);
    return n;
  }
  if (!cfg.lanes[n]) return null;
  cfg.default_lane = n;
  mirrorLaneToFlat(cfg);
  saveConfig(cfg, file);
  return n;
}

/** key 池追加（去重；主 key 一并纳入池）。 */
export function addApiKey(key: string, file?: string): number {
  const cfg = loadConfig(file);
  const t = key.trim();
  const pool = [...cfg.api_keys];
  if (cfg.api_key.trim().length > 0 && !pool.includes(cfg.api_key.trim())) pool.unshift(cfg.api_key.trim());
  if (t.length > 0 && !pool.includes(t)) pool.push(t);
  cfg.api_keys = pool;
  mirrorFlatToLane(cfg);
  saveConfig(cfg, file);
  return pool.length;
}

/** 环境变量自动装配：为每个发现的服务商建车道（key 来自环境变量）。 */
export function autoFromEnv(file?: string): string[] {
  const created: string[] = [];
  const cfg = loadConfig(file);
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    for (const envName of spec.envKeys) {
      const v = (process.env[envName] ?? "").trim();
      if (v.length === 0) continue;
      const lane = cfg.lanes[name] ?? emptyLane();
      lane.gateway = lane.gateway || spec.gateway;
      lane.model = lane.model || spec.model;
      lane.provider = name;
      if (!lane.api_keys.includes(v) && lane.api_key !== v) lane.api_keys = [...lane.api_keys, v];
      cfg.lanes[name] = lane;
      if (!created.includes(name)) created.push(name);
      break;
    }
  }
  if (created.length > 0 && (cfg.default_lane.trim().length === 0 || !cfg.lanes[cfg.default_lane])) {
    cfg.default_lane = created[0]!;
    mirrorLaneToFlat(cfg);
  }
  if (created.length > 0) saveConfig(cfg, file);
  return created;
}

// ---- 生效归因（org config 显示「值 + 来源」） --------------------------------

export type ConfigSource = "cli" | "env" | "file" | "default";

/** 某键的最终生效值与来源（不含 CLI —— CLI 由调用方旗标显式表达）。 */
export function effectiveValue(key: ConfigKey, cfg?: UserConfig): { value: string; source: ConfigSource } {
  if (key === "api_keys" || key === "fallbacks") {
    const c = cfg ?? loadConfig();
    const envName = key === "api_keys" ? "ORG_LLM_KEY_POOL" : "ORG_LLM_FALLBACKS";
    const envVal = (process.env[envName] ?? "").trim();
    if (envVal.length > 0) return { value: envVal.split(",").filter((s) => s.length > 0).join(", "), source: "env" };
    if (c[key].length > 0) return { value: c[key].join(", "), source: "file" };
    return { value: "", source: "default" };
  }
  const envName = envNameOf(key);
  const envVal = envName ? (process.env[envName] ?? "").trim() : "";
  if (envVal.length > 0) return { value: envVal, source: "env" };
  const c = cfg ?? loadConfig();
  if (c[key].length > 0) return { value: c[key], source: "file" };
  return { value: "", source: "default" };
}

/** 配置键 → 环境变量名映射（default_lane 走 ORG_DEFAULT_MODEL）。 */
export function envNameOf(key: ConfigKey): string {
  switch (key) {
    case "gateway": return "DHV_LLM_GATEWAY";
    case "api_key": return "DHV_LLM_API_KEY";
    case "model": return "DHV_LLM_MODEL";
    case "thinking": return "DHV_LLM_THINKING";
    case "timeout_ms": return "DHV_LLM_TIMEOUT_MS";
    case "default_lane": return "ORG_DEFAULT_MODEL";
    case "api_keys": return "ORG_LLM_KEY_POOL";
    case "fallbacks": return "ORG_LLM_FALLBACKS";
    case "budget_requests": return "ORG_LLM_BUDGET_REQUESTS";
  }
}

/**
 * 把配置注入环境（主入口启动时调用一次，全部子命令/子进程继承）。
 * 仅填空：环境变量已设置的不覆盖（env > file 惯例）。
 * 返回实际注入的键数（横幅/测试可断言）。
 */
export function applyConfigToEnv(file?: string): number {
  const cfg = loadConfig(file);
  let n = 0;
  for (const k of CONFIG_KEYS) {
    if (k === "api_keys" || k === "fallbacks") {
      if (cfg[k].length === 0) continue;
      const envName = envNameOf(k);
      if ((process.env[envName] ?? "").trim().length > 0) continue;
      process.env[envName] = cfg[k].join(",");
      n++;
      continue;
    }
    if (cfg[k].length === 0) continue;
    const envName = envNameOf(k);
    if ((process.env[envName] ?? "").trim().length > 0) continue;
    process.env[envName] = cfg[k];
    n++;
  }
  return n;
}

/** 脱敏显示（api_key 只露首 3 尾 4）。 */
export function maskSecret(v: string): string {
  if (v.length <= 8) return v.length > 0 ? "****" : "";
  return `${v.slice(0, 3)}…${v.slice(-4)}`;
}
