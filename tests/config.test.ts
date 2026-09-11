// ============================================================================
// tests/config.test.ts — v0.4.16 批次：用户模型/API 配置（org config）
// ============================================================================
// 覆盖面：
//   1. 键归一 —— 别名/连字符容错（api-key/key/lane/base_url → 规范键）
//   2. 配置文件读写 —— 缺失不炸 · 原子写往返 · 损坏文件按空配置
//   3. applyConfigToEnv —— 填空注入 · 环境变量优先不覆盖 · 空值跳过
//   4. 预设 —— 六服务商网关齐全 · 应用写盘（只动 gateway/model）
//   5. 生效归因 —— env > file > default 三态
//   6. 脱敏 —— api_key 只露首3尾4
// 全部本地文件操作（tmp 目录隔离）—— 不出网、确定性。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeKey, configPath, loadConfig, saveConfig, setConfigValue,
  unsetConfigValue, applyPreset, effectiveValue, applyConfigToEnv,
  envNameOf, maskSecret, PRESETS, CONFIG_KEYS,
} from "../lib/config.ts";

const ENV_KEYS = [
  "DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL",
  "DHV_LLM_THINKING", "DHV_LLM_TIMEOUT_MS", "ORG_DEFAULT_MODEL",
  "ORG_CONFIG", "ORG_RUNTIME",
];

let tmpDir = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-config-test-"));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ORG_CONFIG = path.join(tmpDir, "config.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config：键归一", () => {
  test("规范键直通", () => {
    expect(normalizeKey("gateway")).toBe("gateway");
    expect(normalizeKey("api_key")).toBe("api_key");
    expect(normalizeKey("default_lane")).toBe("default_lane");
  });
  test("连字符与别名归一", () => {
    expect(normalizeKey("api-key")).toBe("api_key");
    expect(normalizeKey("key")).toBe("api_key");
    expect(normalizeKey("apikey")).toBe("api_key");
    expect(normalizeKey("lane")).toBe("default_lane");
    expect(normalizeKey("default")).toBe("default_lane");
    expect(normalizeKey("base_url")).toBe("gateway");
    expect(normalizeKey("endpoint")).toBe("gateway");
  });
  test("未知键返回 null", () => {
    expect(normalizeKey("nope")).toBeNull();
    expect(normalizeKey("")).toBeNull();
  });
});

describe("config：路径与读写", () => {
  test("ORG_CONFIG 显式路径生效", () => {
    expect(configPath()).toBe(path.resolve(process.env.ORG_CONFIG!));
  });
  test("缺省 ~/.org/config.json（ORG_CONFIG/ORG_RUNTIME 未设时）", () => {
    delete process.env.ORG_CONFIG;
    delete process.env.ORG_RUNTIME;
    expect(configPath()).toBe(path.join(os.homedir(), ".org", "config.json"));
  });
  test("文件缺失 → 空配置不炸", () => {
    const cfg = loadConfig();
    expect(cfg.gateway).toBe("");
    expect(cfg.api_key).toBe("");
  });
  test("写读往返保真", () => {
    const cfg = loadConfig();
    cfg.gateway = "https://api.deepseek.com/v1";
    cfg.model = "deepseek-flash";
    cfg.default_lane = "deepseek";
    saveConfig(cfg);
    const back = loadConfig();
    expect(back.gateway).toBe("https://api.deepseek.com/v1");
    expect(back.model).toBe("deepseek-flash");
    expect(back.default_lane).toBe("deepseek");
  });
  test("损坏 JSON → 空配置（用户可 set 修复）", () => {
    fs.writeFileSync(process.env.ORG_CONFIG!, "{ 这不是 JSON", "utf-8");
    const cfg = loadConfig();
    expect(cfg.gateway).toBe("");
  });
  test("setConfigValue 单项写入（含键归一）", () => {
    const key = setConfigValue("api-key", "sk-test-12345678");
    expect(key).toBe("api_key");
    expect(loadConfig().api_key).toBe("sk-test-12345678");
  });
  test("unsetConfigValue 清空", () => {
    setConfigValue("model", "x");
    unsetConfigValue("model");
    expect(loadConfig().model).toBe("");
  });
});

describe("config：applyConfigToEnv 注入语义", () => {
  test("填空注入全部五件套 + 缺省车道", () => {
    const cfg = loadConfig();
    cfg.gateway = "https://g.example/v1";
    cfg.api_key = "sk-k";
    cfg.model = "m1";
    cfg.thinking = "low";
    cfg.timeout_ms = "90000";
    cfg.default_lane = "deepseek";
    saveConfig(cfg);
    const n = applyConfigToEnv();
    expect(n).toBe(6);
    expect(process.env.DHV_LLM_GATEWAY).toBe("https://g.example/v1");
    expect(process.env.DHV_LLM_API_KEY).toBe("sk-k");
    expect(process.env.DHV_LLM_MODEL).toBe("m1");
    expect(process.env.DHV_LLM_THINKING).toBe("low");
    expect(process.env.DHV_LLM_TIMEOUT_MS).toBe("90000");
    expect(process.env.ORG_DEFAULT_MODEL).toBe("deepseek");
  });
  test("环境变量优先 —— 已设的不被覆盖（env > file）", () => {
    const cfg = loadConfig();
    cfg.model = "from-file";
    cfg.gateway = "https://file.example/v1";
    saveConfig(cfg);
    process.env.DHV_LLM_MODEL = "from-env";
    const n = applyConfigToEnv();
    expect(process.env.DHV_LLM_MODEL).toBe("from-env");
    expect(process.env.DHV_LLM_GATEWAY).toBe("https://file.example/v1"); // 未设 env 的仍注入
    expect(n).toBe(1);
  });
  test("空配置零注入", () => {
    expect(applyConfigToEnv()).toBe(0);
  });
});

describe("config：预设", () => {
  test("六服务商网关齐全", () => {
    for (const name of ["deepseek", "openai", "openrouter", "ollama", "lmstudio", "vllm"]) {
      expect(PRESETS[name]).toBeDefined();
      expect(PRESETS[name]!.gateway.startsWith("http")).toBe(true);
    }
  });
  test("应用预设只写 gateway/model（api_key 等不动）", () => {
    setConfigValue("api_key", "sk-keep");
    const name = applyPreset("deepseek");
    expect(name).toBe("deepseek");
    const cfg = loadConfig();
    expect(cfg.gateway).toBe("https://api.deepseek.com/v1");
    expect(cfg.model).toBe("deepseek-flash");
    expect(cfg.api_key).toBe("sk-keep");
  });
  test("未知预设返回 null", () => {
    expect(applyPreset("nope")).toBeNull();
  });
});

describe("config：生效归因与脱敏", () => {
  test("三态来源：env > file > default", () => {
    setConfigValue("model", "from-file");
    expect(effectiveValue("model").source).toBe("file");
    expect(effectiveValue("model").value).toBe("from-file");
    process.env.DHV_LLM_MODEL = "from-env";
    expect(effectiveValue("model").source).toBe("env");
    expect(effectiveValue("model").value).toBe("from-env");
    delete process.env.DHV_LLM_MODEL;
    unsetConfigValue("model");
    expect(effectiveValue("model").source).toBe("default");
    expect(effectiveValue("model").value).toBe("");
  });
  test("键 → 环境变量名映射完整", () => {
    expect(envNameOf("gateway")).toBe("DHV_LLM_GATEWAY");
    expect(envNameOf("api_key")).toBe("DHV_LLM_API_KEY");
    expect(envNameOf("model")).toBe("DHV_LLM_MODEL");
    expect(envNameOf("thinking")).toBe("DHV_LLM_THINKING");
    expect(envNameOf("timeout_ms")).toBe("DHV_LLM_TIMEOUT_MS");
    expect(envNameOf("default_lane")).toBe("ORG_DEFAULT_MODEL");
    expect(CONFIG_KEYS.length).toBe(6);
  });
  test("api_key 脱敏只露首尾", () => {
    expect(maskSecret("sk-848e25504f854db4")).toBe("sk-…4db4");
    expect(maskSecret("short")).toBe("****");
    expect(maskSecret("")).toBe("");
  });
});
