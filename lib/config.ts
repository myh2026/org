// ============================================================================
// lib/config.ts — 用户模型/API 配置（v0.4.16：org config）
// ----------------------------------------------------------------------------
// 主流 Agent（codex ~/.codex/config.toml / opencode opencode.json）的标配：
// 用户可持久化配置自己的模型与 API 端点，不必每次 export 环境变量。
//
// 优先级（高 → 低）：
//   CLI 旗标（--model/--gateway） > 环境变量（DHV_LLM_*） > 配置文件 > 内建缺省
// 环境变量已设置时配置文件不覆盖（Unix 惯例：显式环境优先）。
//
// 配置文件：~/.org/config.json（与单二进制运行时同根，跨版本持久）；
// ORG_CONFIG 环境变量可指向自定义路径。结构：
//   {
//     "gateway":      "https://api.deepseek.com/v1",
//     "api_key":      "sk-…",
//     "model":        "deepseek-flash",
//     "thinking":     "low",              // 可选：off/low/medium/high
//     "timeout_ms":   "180000",           // 可选
//     "default_lane": "deepseek"          // 可选：chat/run 缺省模型车道
//   }
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 配置键（文件字段名 —— 全部 snake_case）。 */
export type ConfigKey = "gateway" | "api_key" | "model" | "thinking" | "timeout_ms" | "default_lane";

export const CONFIG_KEYS: readonly ConfigKey[] = ["gateway", "api_key", "model", "thinking", "timeout_ms", "default_lane"] as const;

/** 键归一：连字符/别名 → 规范键（CLI 输入容错）。 */
export function normalizeKey(raw: string): ConfigKey | null {
  const k = raw.trim().toLowerCase().replace(/-/g, "_");
  if ((CONFIG_KEYS as readonly string[]).includes(k)) return k as ConfigKey;
  if (k === "key" || k === "apikey") return "api_key";
  if (k === "lane" || k === "default") return "default_lane";
  if (k === "base_url" || k === "baseurl" || k === "endpoint") return "gateway";
  return null;
}

/** 配置条目形态（文件里就是这些字段；空串 = 未配置）。 */
export interface UserConfig {
  gateway: string;
  api_key: string;
  model: string;
  thinking: string;
  timeout_ms: string;
  default_lane: string;
}

export function emptyConfig(): UserConfig {
  return { gateway: "", api_key: "", model: "", thinking: "", timeout_ms: "", default_lane: "" };
}

// ---- 服务商预设（org config preset <name> 一键写入） ------------------------
// 本地预设（ollama/lmstudio/vllm）网关即开即用，model 留空待用户
// `org config set model <name>` 按本地已拉取的模型填。
export interface Preset {
  label: string;
  gateway: string;
  model: string;
  note: string;
}

export const PRESETS: Record<string, Preset> = {
  deepseek: {
    label: "DeepSeek 官方 API",
    gateway: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    note: "api_key 必填（platform.deepseek.com 获取）",
  },
  openai: {
    label: "OpenAI 官方 API",
    gateway: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    note: "api_key 必填；gateway 兼容任何 OpenAI 协议端点",
  },
  openrouter: {
    label: "OpenRouter 聚合网关",
    gateway: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    note: "api_key 必填；数百模型经统一协议路由",
  },
  ollama: {
    label: "Ollama 本地推理",
    gateway: "http://127.0.0.1:11434/v1",
    model: "",
    note: "无需 api_key；model 填本地已拉取名（ollama list 查看）",
  },
  lmstudio: {
    label: "LM Studio 本地推理",
    gateway: "http://127.0.0.1:1234/v1",
    model: "",
    note: "无需 api_key；model 填已加载模型名",
  },
  vllm: {
    label: "vLLM 自托管",
    gateway: "http://127.0.0.1:8000/v1",
    model: "",
    note: "自建推理服务；model 填 --served-model-name",
  },
};

// ---- 路径与读写 ---------------------------------------------------------------

/** 配置文件路径：ORG_CONFIG 显式指定 > ~/.org/config.json。 */
export function configPath(): string {
  if (process.env.ORG_CONFIG && process.env.ORG_CONFIG.trim().length > 0) {
    return path.resolve(process.env.ORG_CONFIG.trim());
  }
  const runtime = process.env.ORG_RUNTIME?.trim() || path.join(os.homedir(), ".org");
  return path.join(runtime, "config.json");
}

/** 读配置（文件缺失/损坏 → 空配置，不炸主流程）。 */
export function loadConfig(file?: string): UserConfig {
  const p = file ?? configPath();
  const cfg = emptyConfig();
  if (!fs.existsSync(p)) return cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    for (const k of CONFIG_KEYS) {
      const v = raw[k];
      if (typeof v === "string") cfg[k] = v;
      else if (typeof v === "number") cfg[k] = String(v);
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
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
  return p;
}

/** 单项设置（键归一 + 写回）。返回规范键；未知键返回 null。 */
export function setConfigValue(rawKey: string, value: string, file?: string): ConfigKey | null {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const cfg = loadConfig(file);
  cfg[key] = value.trim();
  saveConfig(cfg, file);
  return key;
}

/** 单项删除（存在则删并写回）。 */
export function unsetConfigValue(rawKey: string, file?: string): ConfigKey | null {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const cfg = loadConfig(file);
  if (cfg[key] === "") return key;
  cfg[key] = "";
  saveConfig(cfg, file);
  return key;
}

/** 应用预设（写 gateway/model，其余字段不动）。返回预设名；未知返回 null。 */
export function applyPreset(name: string, file?: string): string | null {
  const p = PRESETS[name.trim().toLowerCase()];
  if (!p) return null;
  const cfg = loadConfig(file);
  cfg.gateway = p.gateway;
  cfg.model = p.model;
  saveConfig(cfg, file);
  return name.trim().toLowerCase();
}

// ---- 生效归因（org config 显示「值 + 来源」） --------------------------------

export type ConfigSource = "cli" | "env" | "file" | "default";

/** 某键的最终生效值与来源（不含 CLI —— CLI 由调用方旗标显式表达）。 */
export function effectiveValue(key: ConfigKey, cfg?: UserConfig): { value: string; source: ConfigSource } {
  const envName = envNameOf(key);
  const envVal = envName ? (process.env[envName] ?? "").trim() : "";
  if (envVal.length > 0) return { value: envVal, source: "env" };
  const c = cfg ?? loadConfig();
  if (c[key].length > 0) return { value: c[key], source: "file" };
  return { value: "", source: "default" };
}

/** 配置键 → DHV_LLM_* 环境变量名映射（default_lane 走 ORG_DEFAULT_MODEL）。 */
export function envNameOf(key: ConfigKey): string {
  switch (key) {
    case "gateway": return "DHV_LLM_GATEWAY";
    case "api_key": return "DHV_LLM_API_KEY";
    case "model": return "DHV_LLM_MODEL";
    case "thinking": return "DHV_LLM_THINKING";
    case "timeout_ms": return "DHV_LLM_TIMEOUT_MS";
    case "default_lane": return "ORG_DEFAULT_MODEL";
  }
}

/**
 * 把配置文件注入环境（主入口启动时调用一次，全部子命令/子进程继承）。
 * 仅填空：环境变量已设置的不覆盖（env > file 惯例）。
 * 返回实际注入的键数（横幅/测试可断言）。
 */
export function applyConfigToEnv(file?: string): number {
  const cfg = loadConfig(file);
  let n = 0;
  for (const k of CONFIG_KEYS) {
    if (cfg[k].length === 0) continue;
    const envName = envNameOf(k);
    if ((process.env[envName] ?? "").trim().length > 0) continue;
    process.env[envName] = cfg[k];
    n++;
  }
  return n;
}

/** 脱敏显示（api_key 只露尾 4 位）。 */
export function maskSecret(v: string): string {
  if (v.length <= 8) return v.length > 0 ? "****" : "";
  return `${v.slice(0, 3)}…${v.slice(-4)}`;
}
