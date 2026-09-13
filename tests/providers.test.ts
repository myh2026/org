// ============================================================================
// tests/providers.test.ts — 主流 API key 模式（v0.5.1）
// ============================================================================
// 覆盖面：
//   1. 服务商注册表：20 家 · 网关/模型/env 变量名完备性
//   2. 环境变量自动发现：OPENAI_API_KEY 等 shell 变量即刻可用
//   3. 车道解析：--model 旗标五种输入（scripted/车道名/服务商名/裸模型/空）
//   4. key 池：平面与车道形态的去重合并
//   5. 环境注入：用户显式 export 不可覆盖（env > 程序）
//   6. 车道生命周期：preset/set/use/rm/keys add/autoFromEnv + 平面镜像
//   7. 本地路由器（端到端，mock 上游）：429 key 轮换 / 降级链模型改写 /
//      预算水位 / 台账归因 / SSE 流式透传
//
// 全部本地 mock（Bun.serve 随机端口），不出网、确定性、毫秒级。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROVIDERS, PROVIDER_NAMES, discoverEnvLanes,
  resolveModelFlag, resolveDefaultLane, applyLaneToEnv, snapshotUserEnv,
  testLane, providerRows, keyPoolOf,
} from "../lib/providers.ts";
import { keyFingerprint, ensureRouter, activeRouter, readLedger } from "../lib/router.ts";
import {
  loadConfig, setConfigValue, applyPreset, setLaneValue, removeLane,
  useLane, addApiKey, autoFromEnv, emptyConfig,
} from "../lib/config.ts";

// ---- 基础设施：临时配置文件 + 环境变量卫生 ------------------------------------

const tmpDir = fs.mkdtempSync("/tmp/org-providers-test-");
const cfgFile = path.join(tmpDir, "config.json");
const wsDir = path.join(tmpDir, "ws");
fs.mkdirSync(wsDir, { recursive: true });

const SAVED: Record<string, string | undefined> = {};
const ENV_VARS = [
  "ORG_CONFIG", "DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL",
  "DHV_LLM_THINKING", "DHV_LLM_TIMEOUT_MS", "ORG_LLM_KEY_POOL",
  "ORG_LLM_FALLBACKS", "ORG_LANE_KIND", "ORG_DEFAULT_MODEL",
  // 服务商 key 变量（全清，防宿主环境污染发现测试）
  "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
  "XAI_API_KEY", "GROK_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY", "PERPLEXITY_API_KEY", "PPLX_API_KEY", "DEEPINFRA_API_KEY",
  "SILICONFLOW_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY",
  "MOONSHOT_API_KEY", "KIMI_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY",
  "ALIYUN_LLM_API_KEY", "MINIMAX_API_KEY", "CLAUDE_API_KEY",
];

beforeEach(() => {
  for (const v of ENV_VARS) SAVED[v] = process.env[v];
  process.env.ORG_CONFIG = cfgFile;
  if (fs.existsSync(cfgFile)) fs.rmSync(cfgFile);
});

afterEach(() => {
  for (const v of ENV_VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v]!;
  }
  const router = activeRouter();
  if (router) router.stop();
});

// ---- 1. 服务商注册表 ----------------------------------------------------------

describe("providers：服务商注册表（v0.5.1）", () => {
  test("20 家主流服务商：国内外主流 + 本地推理", () => {
    expect(PROVIDER_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const name of [
      "deepseek", "openai", "anthropic", "gemini", "openrouter", "groq",
      "mistral", "xai", "zhipu", "moonshot", "dashscope", "siliconflow",
      "ollama", "lmstudio", "vllm",
    ]) {
      expect(PROVIDERS[name]).toBeDefined();
      expect(PROVIDERS[name]!.gateway.startsWith("http")).toBe(true);
      expect(PROVIDERS[name]!.label.length).toBeGreaterThan(0);
      expect(PROVIDERS[name]!.note.length).toBeGreaterThan(0);
    }
  });

  test("云端服务商都有 env 变量名（key 自动发现的前提）", () => {
    for (const [name, spec] of Object.entries(PROVIDERS)) {
      if (spec.local) continue;
      expect(spec.envKeys.length).toBeGreaterThan(0);
    }
    expect(PROVIDERS.anthropic!.extraHeaders?.["anthropic-version"]).toBe("2023-06-01");
  });

  test("本地推理预设免 key（ollama/lmstudio/vllm）", () => {
    expect(PROVIDERS.ollama!.local).toBe(true);
    expect(PROVIDERS.lmstudio!.local).toBe(true);
    expect(PROVIDERS.vllm!.local).toBe(true);
    expect(PROVIDERS.ollama!.gateway).toBe("http://127.0.0.1:11434/v1");
  });
});

// ---- 2. 环境变量自动发现 -------------------------------------------------------

describe("providers：环境变量自动发现", () => {
  test("OPENAI_API_KEY 即刻发现", () => {
    process.env.OPENAI_API_KEY = "sk-found-openai";
    const found = discoverEnvLanes();
    const openai = found.find((d) => d.provider === "openai");
    expect(openai?.envName).toBe("OPENAI_API_KEY");
    expect(openai?.key).toBe("sk-found-openai");
  });

  test("多服务商共存（按注册表序）+ 同服务商多变量取首个命中", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    process.env.GEMINI_API_KEY = "gem-1";
    process.env.GOOGLE_API_KEY = "gem-2"; // GEMINI_API_KEY 优先（数组序）
    const found = discoverEnvLanes();
    const names = found.map((d) => d.provider);
    expect(names).toContain("deepseek");
    expect(names).toContain("gemini");
    expect(found.find((d) => d.provider === "gemini")?.envName).toBe("GEMINI_API_KEY");
  });

  test("无任何变量 → 空发现（不炸）", () => {
    expect(discoverEnvLanes().length).toBe(0);
  });
});

// ---- 3. 车道解析 ---------------------------------------------------------------

describe("providers：车道解析 resolveModelFlag", () => {
  test("scripted 旗标 → 剧本车道", () => {
    const lane = resolveModelFlag("scripted");
    expect(lane.kind).toBe("scripted");
  });

  test("配置车道名 → 命名车道（key 池 + 降级链完整）", () => {
    applyPreset("deepseek");
    setLaneValue("deepseek", "api_keys", "sk-b1,sk-b2");
    setLaneValue("deepseek", "fallbacks", "openrouter");
    const lane = resolveModelFlag("deepseek");
    expect(lane.kind).toBe("real");
    expect(lane.gateway).toBe("https://api.deepseek.com/v1");
    expect(lane.keys.length).toBe(2); // 池（主 key 空 + 2 备用）
    expect(lane.fallbacks).toEqual(["openrouter"]);
    expect(lane.explicit).toBe(true);
  });

  test("服务商名 + shell 环境变量 → 环境发现车道", () => {
    process.env.GROQ_API_KEY = "gsk-found";
    const lane = resolveModelFlag("groq");
    expect(lane.kind).toBe("real");
    expect(lane.keys).toEqual(["gsk-found"]);
    expect(lane.gateway).toBe("https://api.groq.com/openai/v1");
    expect(lane.explicit).toBe(true);
  });

  test("服务商名无 key → 真实车道但不注入（回落 SDK 车道）", () => {
    const lane = resolveModelFlag("anthropic");
    expect(lane.kind).toBe("real");
    expect(lane.explicit).toBe(false); // 不注入 DHV_LLM_*
    expect(lane.gateway).toBe("https://api.anthropic.com/v1");
  });

  test("裸模型 id + 已配网关 → 沿用网关切模型", () => {
    setConfigValue("gateway", "https://api.deepseek.com/v1");
    setConfigValue("api_key", "sk-x");
    const lane = resolveModelFlag("deepseek-reasoner");
    expect(lane.kind).toBe("real");
    expect(lane.model).toBe("deepseek-reasoner");
    expect(lane.gateway).toBe("https://api.deepseek.com/v1");
    expect(lane.keys).toEqual(["sk-x"]);
  });

  test("裸模型 id + 无任何配置 → 剧本（不触发真实调用）", () => {
    const lane = resolveModelFlag("some-random-model");
    expect(lane.kind).toBe("scripted");
  });

  test("空旗标 → 缺省车道（default_lane > 平面 > env 发现 > scripted）", () => {
    expect(resolveDefaultLane(emptyConfig()).kind).toBe("scripted");
    setConfigValue("default_lane", "scripted");
    expect(resolveModelFlag("").kind).toBe("scripted");
  });
});

// ---- 4/5. key 池与环境注入 -----------------------------------------------------

describe("providers：key 池与环境注入", () => {
  test("key 池去重合并（api_key + api_keys）", () => {
    const cfg = emptyConfig();
    cfg.api_key = "sk-main";
    cfg.api_keys = ["sk-main", "sk-2", "sk-3", "sk-2"];
    expect(keyPoolOf(cfg)).toEqual(["sk-main", "sk-2", "sk-3"]);
  });

  test("用户 shell 显式 export 的变量不可覆盖（env > 程序）", () => {
    process.env.DHV_LLM_MODEL = "user-model"; // 先于快照 → 用户层
    snapshotUserEnv();
    const lane = resolveModelFlag("deepseek"); // 预设车道 model=deepseek-chat
    applyLaneToEnv(lane);
    expect(process.env.DHV_LLM_MODEL).toBe("user-model");
    // 非用户层注入成功
    expect(process.env.ORG_LANE_KIND).toBe("real");
  });

  test("scripted 车道注入 ORG_LANE_KIND=scripted", () => {
    snapshotUserEnv();
    applyLaneToEnv(resolveModelFlag("scripted"));
    expect(process.env.ORG_LANE_KIND).toBe("scripted");
  });

  test("非显式车道（无 key 服务商名）不注入网关 —— SDK 回落", () => {
    snapshotUserEnv();
    applyLaneToEnv(resolveModelFlag("anthropic"));
    expect(process.env.DHV_LLM_GATEWAY ?? "").toBe("");
    expect(process.env.ORG_LANE_KIND).toBe("real");
  });
});

// ---- 6. 车道生命周期 ------------------------------------------------------------

describe("config v3：车道生命周期与镜像", () => {
  test("preset 创建命名车道 + 设为缺省 + 平面镜像 + api_key 不动", () => {
    setConfigValue("api_key", "sk-keep");
    applyPreset("zhipu");
    const cfg = loadConfig();
    expect(cfg.lanes.zhipu).toBeDefined();
    expect(cfg.default_lane).toBe("zhipu");
    expect(cfg.gateway).toBe("https://open.bigmodel.cn/api/paas/v4"); // 镜像
    expect(cfg.api_key).toBe("sk-keep"); // 预设不动 key（既有纪律）
    expect(cfg.lanes.zhipu!.api_key).toBe("sk-keep"); // 车道同步保留
  });

  test("lane set 字段级更新 + use 切换 + rm 删除", () => {
    applyPreset("moonshot");
    expect(setLaneValue("moonshot", "model", "moonshot-v1-32k")).toBe("moonshot");
    expect(loadConfig().lanes.moonshot!.model).toBe("moonshot-v1-32k");
    // 切走缺省 → 平面镜像跟随
    applyPreset("deepseek");
    expect(useLane("moonshot")).toBe("moonshot");
    expect(loadConfig().model).toBe("moonshot-v1-32k");
    expect(removeLane("moonshot")).toBe("moonshot");
    const cfg = loadConfig();
    expect(cfg.lanes.moonshot).toBeUndefined();
    expect(cfg.default_lane).toBe(""); // 缺省车道被删则清空（不悬空指向）
  });

  test("keys add 追加去重（池含主 key）", () => {
    setConfigValue("api_key", "sk-main");
    expect(addApiKey("sk-2")).toBe(2);
    expect(addApiKey("sk-2")).toBe(2); // 重复不增
    expect(addApiKey("sk-3")).toBe(3);
    expect(loadConfig().api_keys).toEqual(["sk-main", "sk-2", "sk-3"]);
  });

  test("autoFromEnv：为发现的服务商建车道并设首个缺省", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-auto";
    process.env.OPENAI_API_KEY = "sk-oai-auto";
    const created = autoFromEnv();
    expect(created.length).toBe(2);
    const cfg = loadConfig();
    expect(cfg.lanes.deepseek!.api_keys).toContain("sk-ds-auto");
    expect(cfg.lanes.openai!.api_keys).toContain("sk-oai-auto");
    expect(["deepseek", "openai"]).toContain(cfg.default_lane);
    expect(cfg.model.length).toBeGreaterThan(0); // 镜像到平面
  });

  test("损坏的 config.json → 空配置不炸", () => {
    fs.writeFileSync(cfgFile, "{broken json", "utf-8");
    const cfg = loadConfig();
    expect(cfg.gateway).toBe("");
    expect(cfg.lanes).toEqual({});
  });

  test("providerRows：三态状态（lane/env/preset）+ 缺省标记", () => {
    applyPreset("deepseek");
    process.env.GROQ_API_KEY = "gsk-x";
    const rows = providerRows();
    expect(rows.find((r) => r.name === "deepseek")?.status).toBe("lane");
    expect(rows.find((r) => r.name === "deepseek")?.default).toBe(true);
    expect(rows.find((r) => r.name === "groq")?.status).toBe("env");
    expect(rows.find((r) => r.name === "openai")?.status).toBe("preset");
  });
});

// ---- 7. 本地路由器（端到端 mock） -----------------------------------------------

describe("router：key 池轮换 / 降级链 / 预算 / 台账（端到端）", () => {
  interface Hit { auth: string | null; model: string; }
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let hits: Hit[] = [];

  beforeEach(() => {
    // 台账跨用例共享（同 wsDir）—— 每用例前清零，断言只看本用例的写入
    fs.rmSync(path.join(wsDir, "runtime", "llm-ledger.jsonl"), { force: true });
    if (fs.existsSync(cfgFile)) fs.rmSync(cfgFile);
  });
  /** mock 上游：sk-a 恒 429，sk-b 200；记录每次命中。 */
  function startUpstream(opts: { firstKey429?: boolean; always429?: boolean } = {}): void {
    hits = [];
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        const auth = req.headers.get("authorization");
        hits.push({ auth, model: String(body.model ?? "") });
        if (opts.always429) {
          return Response.json({ error: { message: "rate limited" } }, { status: 429 });
        }
        if (opts.firstKey429 && auth === "Bearer sk-a") {
          return Response.json({ error: { message: "rate limited" } }, { status: 429 });
        }
        return Response.json({
          choices: [{ message: { content: `pong:${String(body.model)}` } }],
          usage: { total_tokens: 7 },
        });
      },
    });
  }

  function laneTo(upstreamUrl: string, keys: string[], fallbacks: string[] = []): void {
    const cfg = loadConfig();
    cfg.lanes.primary = {
      gateway: upstreamUrl, api_key: keys[0] ?? "", model: "m-primary",
      thinking: "", timeout_ms: "10000",
      api_keys: keys.slice(1), fallbacks, provider: "",
    };
    if (fallbacks.length > 0) {
      cfg.lanes.backup = {
        gateway: upstreamUrl, api_key: "sk-backup", model: "m-backup",
        thinking: "", timeout_ms: "10000", api_keys: [], fallbacks: [], provider: "",
      };
    }
    saveRaw(cfg);
  }

  function saveRaw(cfg: ReturnType<typeof loadConfig>): void {
    fs.writeFileSync(cfgFile, JSON.stringify({ version: 3, ...cfg, lanes: cfg.lanes }, null, 2));
  }

  afterEach(() => {
    upstream?.stop(true);
    upstream = null;
    const router = activeRouter();
    if (router) router.stop();
  });

  test("429 → key 轮换（同车道第二把 key 接管）", async () => {
    startUpstream({ firstKey429: true });
    laneTo(`http://127.0.0.1:${upstream!.port}/v1`, ["sk-a", "sk-b"]);
    const lane = resolveModelFlag("primary");
    const router = await ensureRouter(lane, wsDir);
    expect(router).not.toBeNull();
    const res = await fetch(`${router!.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-primary", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(data.choices[0]!.message.content).toBe("pong:m-primary");
    // 命中序列：sk-a(429) → sk-b(200)
    expect(hits.length).toBe(2);
    expect(hits[0]!.auth).toBe("Bearer sk-a");
    expect(hits[1]!.auth).toBe("Bearer sk-b");
  });

  test("全 key 失败 → 降级链（fallback 车道 + 模型名改写）", async () => {
    startUpstream({ always429: true });
    // primary 全 429，fallback backup 用不同 key（mock 只按 auth 区分……此 mock 对 backup key 也 429）
    // 改造：让 mock 对 sk-backup 放行 —— 用 always429:false + firstKey429:false，
    // 但 primary 的两把 key 都撞 429 的场景用专门开关表达：
    upstream?.stop(true);
    hits = [];
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        const auth = req.headers.get("authorization");
        hits.push({ auth, model: String(body.model ?? "") });
        if (auth === "Bearer sk-backup") {
          return Response.json({ choices: [{ message: { content: `from-backup:${String(body.model)}` } }] });
        }
        return Response.json({ error: { message: "rate limited" } }, { status: 429 });
      },
    });
    laneTo(`http://127.0.0.1:${upstream!.port}/v1`, ["sk-a", "sk-b"], ["backup"]);
    const lane = resolveModelFlag("primary");
    const router = await ensureRouter(lane, wsDir);
    const res = await fetch(`${router!.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-primary", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    // 降级车道的模型名被改写（请求体的 model=m-primary → m-backup）
    expect(data.choices[0]!.message.content).toBe("from-backup:m-backup");
    expect(hits[hits.length - 1]!.model).toBe("m-backup");
    expect(hits[hits.length - 1]!.auth).toBe("Bearer sk-backup");
  });

  test("台账归因：每次尝试落 llm-ledger.jsonl（key 指纹 / 状态 / 耗时）", async () => {
    startUpstream({ firstKey429: true });
    laneTo(`http://127.0.0.1:${upstream!.port}/v1`, ["sk-a", "sk-b"]);
    const lane = resolveModelFlag("primary");
    const router = await ensureRouter(lane, wsDir);
    await fetch(`${router!.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-primary", messages: [{ role: "user", content: "ping" }] }),
    });
    const stats = readLedger(wsDir);
    expect(stats.total).toBe(2); // 429 一次 + ok 一次
    expect(stats.ok).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.byLane.primary?.ok).toBe(1);
    const last = stats.recent[stats.recent.length - 1]!;
    expect(last.status).toBe("ok");
    expect(last.tokens).toBe(7); // usage 贯通到台账
    expect(last.key_id).toContain("k2("); // 第二把 key 的指纹
  });

  test("预算水位：budget_requests=1 时第二次请求 429", async () => {
    startUpstream();
    laneTo(`http://127.0.0.1:${upstream!.port}/v1`, ["sk-a"]);
    // 清掉上一测试的台账（共享 wsDir）
    fs.rmSync(path.join(wsDir, "runtime", "llm-ledger.jsonl"), { force: true });
    setConfigValue("budget_requests", "1");
    const lane = resolveModelFlag("primary");
    const router = await ensureRouter(lane, wsDir);
    const r1 = await fetch(`${router!.url}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-primary", messages: [{ role: "user", content: "one" }] }),
    });
    expect(r1.status).toBe(200);
    const r2 = await fetch(`${router!.url}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-primary", messages: [{ role: "user", content: "two" }] }),
    });
    expect(r2.status).toBe(429);
    const body = await r2.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("预算");
  });

  test("SSE 流式透传：字节级转发 + 尾帧 usage 计入台账", async () => {
    hits = [];
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.json();
        hits.push({ auth: req.headers.get("authorization"), model: "" });
        const sse = [
          'data: {"choices":[{"delta":{"content":"你"}}]}',
          'data: {"choices":[{"delta":{"content":"好"}}]}',
          'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":9}}',
          "data: [DONE]",
          "",
        ].join("\n\n");
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    laneTo(`http://127.0.0.1:${upstream!.port}/v1`, ["sk-a", "sk-b"]); // 双 key → 路由器启动条件成立
    const lane = resolveModelFlag("primary");
    const router = await ensureRouter(lane, wsDir);
    const res = await fetch(`${router!.url}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-primary", stream: true, messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("content\":\"你");
    expect(text).toContain("content\":\"好");
    expect(text).toContain("total_tokens");
    expect(text).toContain("[DONE]");
    const stats = readLedger(wsDir);
    expect(stats.ok).toBe(1);
    expect(stats.recent[0]!.tokens).toBe(9); // 尾帧 usage 抓到
    expect(stats.recent[0]!.stream).toBe(true);
  });

  test("路由器幂等 + 车道切换重建", async () => {
    startUpstream();
    laneTo(`http://127.0.0.1:${upstream!.port}/v1`, ["sk-a", "sk-b"], ["backup"]);
    const lane1 = resolveModelFlag("primary");
    const r1 = await ensureRouter(lane1, wsDir);
    const r2 = await ensureRouter(lane1, wsDir);
    expect(r1).toBe(r2); // 同车道幂等
    // 切换车道 → 重建（backup 车道配置双 key 满足启动条件）
    const cfg = loadConfig();
    cfg.lanes.backup!.api_keys = ["sk-backup-2"];
    fs.writeFileSync(cfgFile, JSON.stringify({ version: 3, ...cfg, lanes: cfg.lanes }, null, 2));
    const lane2 = resolveModelFlag("backup");
    const r3 = await ensureRouter(lane2, wsDir);
    expect(r3).not.toBe(r1);
    expect(r3!.laneName).toBe("backup");
    r1!.stop();
  });

  test("keyFingerprint 脱敏（不落原值）", () => {
    expect(keyFingerprint("sk-1234567890abcdef", 0)).toBe("k1(sk-…ef)");
    expect(keyFingerprint("short", 2)).toBe("k3(****)");
  });
});

// ---- 8. testLane 连通测试 ------------------------------------------------------

describe("providers：testLane 连通测试", () => {
  test("ok 路径：延迟/回复/tokens/尝试 key 数", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          choices: [{ message: { content: "好" } }],
          usage: { total_tokens: 5 },
        });
      },
    });
    try {
      const lane = {
        ...resolveModelFlag("scripted"),
        kind: "real" as const, name: "mock", gateway: `http://127.0.0.1:${server.port}/v1`,
        model: "m", keys: ["sk-a"], explicit: true,
      };
      const r = await testLane(lane, 3000);
      expect(r.ok).toBe(true);
      expect(r.reply).toBe("好");
      expect(r.tokens).toBe(5);
      expect(r.triedKeys).toBe(1);
      expect(r.ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop(true);
    }
  });

  test("scripted / 未配网关：人话诊断不炸", async () => {
    const r1 = await testLane(resolveModelFlag("scripted"));
    expect(r1.ok).toBe(true);
    const r2 = await testLane({ ...resolveModelFlag("scripted"), kind: "real", name: "x", gateway: "", model: "m" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("未配置网关");
  });
});

// ---- 9. CLI 冒烟（org config / providers） -------------------------------------

describe("CLI 冒烟：org config v0.5.1 子命令", () => {
  test("org config lane/use/keys/auto 子命令链", async () => {
    const r = Bun.spawnSync(["bun", "cli/org.ts", "config", "lane"], { env: { ...process.env } });
    const out = r.stdout.toString();
    expect(out).toContain("命名车道");
    const r2 = Bun.spawnSync(["bun", "cli/org.ts", "config", "use", "nope"], { env: { ...process.env } });
    // 错误信息走 stderr（Unix 惯例），退出码 2
    expect(r2.stderr.toString()).toContain("不存在");
    expect(r2.exitCode).toBe(2);
  }, 60_000);

  test("org providers：健康面板（注册数 + 台账入口）", async () => {
    const r = Bun.spawnSync(["bun", "cli/org.ts", "providers"], { env: { ...process.env } });
    const out = r.stdout.toString();
    expect(out).toContain("ORG providers");
    expect(out).toContain("家注册");
  }, 60_000);
});
