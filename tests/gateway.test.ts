// ============================================================================
// tests/gateway.test.ts — 直连 OpenAI 兼容服务商网关三件套（v0.4.13）
// ============================================================================
// 背景：v0.4.10 的 DHV_LLM_GATEWAY 假设「网关自持鉴权/限流」；实测直连
// DeepSeek 官方 API（https://api.deepseek.com/v1，模型 deepseek-flash）发现
// 缺 Authorization 头（401）与 model 字段（无法路由）。v0.2.59/v0.4.13
// 补齐 DHV_LLM_API_KEY / DHV_LLM_MODEL / DHV_LLM_TIMEOUT_MS。
//
// 测试形态：本地 mock 网关（Bun.serve 随机端口）断言请求头/请求体贯通与
// 缺省行为不变 —— 不出网、确定性、毫秒级。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Host } from "../toolchain/dhv-ts/src/host";

/** 与 CLI/引擎同构的最小 HostOptions（model=deepseek 走网关车道）。 */
function makeHost(): Host {
  return new Host({
    workspace: "/tmp/org-gw-test-ws",
    task: "gateway probe",
    model: "deepseek",
    temperature: 0.1,
    maxTurns: 1,
    maxBashCalls: 0,
    maxOutputChars: 4096,
    allow: [],
    scale: "solo",
    outdir: "/tmp/org-gw-test-out",
    quiet: true,
  });
}

interface Seen {
  auth: string | null;
  model: unknown;
  body: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let seen: Seen[] = [];
const SAVED: Record<string, string | undefined> = {};
const VARS = ["DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL", "DHV_LLM_TIMEOUT_MS", "DHV_LLM_THINKING"];

/** 起一个 mock 网关：记录鉴权头/model 字段，回显 model 便于断言贯通。 */
function startMockGateway(delayMs = 0): void {
  seen = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ auth: req.headers.get("authorization"), model: body.model, body });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return Response.json({
        choices: [{ message: { content: `pong:${String(body.model ?? "default")}` } }],
      });
    },
  });
}

function gatewayUrl(): string {
  return `http://127.0.0.1:${server!.port}/v1`;
}

async function complete(host: Host): Promise<string> {
  const llm = host.api.llm as { complete: (r: unknown) => Promise<string> };
  return llm.complete({ messages: [{ role: "user", content: "ping" }], temperature: 0.1, maxTokens: 32 });
}

beforeEach(() => {
  for (const v of VARS) SAVED[v] = process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v]!;
  }
  server?.stop(true);
  server = null;
});

describe("v0.4.13 网关直连三件套（DHV_LLM_API_KEY / DHV_LLM_MODEL / DHV_LLM_TIMEOUT_MS）", () => {
  test("鉴权头 + model 字段贯通：DeepSeek 直连形态（Bearer + deepseek-flash）", async () => {
    startMockGateway();
    process.env.DHV_LLM_GATEWAY = gatewayUrl();
    process.env.DHV_LLM_API_KEY = "sk-test-org-gateway";
    process.env.DHV_LLM_MODEL = "deepseek-flash";
    delete process.env.DHV_LLM_TIMEOUT_MS;

    const out = await complete(makeHost());
    expect(seen.length).toBe(1);
    expect(seen[0].auth).toBe("Bearer sk-test-org-gateway");
    expect(seen[0].model).toBe("deepseek-flash");
    // 回显贯通：mock 网关把 model 写进 content —— 完整请求→响应闭环
    expect(out).toBe("pong:deepseek-flash");
    // 既有字段不受影响（messages/temperature/max_tokens 仍按请求传递）
    expect(Array.isArray((seen[0].body as { messages: unknown[] }).messages)).toBe(true);
    expect(seen[0].body.max_tokens).toBe(32);
  });

  test("缺省行为不变：未配 API_KEY/MODEL 时不发鉴权头、不写 model 字段", async () => {
    startMockGateway();
    process.env.DHV_LLM_GATEWAY = gatewayUrl();
    delete process.env.DHV_LLM_API_KEY;
    delete process.env.DHV_LLM_MODEL;

    const out = await complete(makeHost());
    expect(seen.length).toBe(1);
    expect(seen[0].auth).toBeNull(); // 内网自持鉴权网关：原行为
    expect(seen[0].model).toBeUndefined(); // 网关侧默认模型路由：原行为
    expect(out).toBe("pong:default");
  });

  test("超时保护：DHV_LLM_TIMEOUT_MS=1 对慢网关（300ms）及时中止并传播错误", async () => {
    startMockGateway(300);
    process.env.DHV_LLM_GATEWAY = gatewayUrl();
    delete process.env.DHV_LLM_API_KEY;
    process.env.DHV_LLM_MODEL = "deepseek-flash";
    process.env.DHV_LLM_TIMEOUT_MS = "1";

    // v0.2.59 前无超时：挂死 fetch 无限等待 → 整个 agent run 卡死。
    // 现在 1ms 中止，错误原样传播（可诊断、调用侧退避重试可接管）。
    const t0 = Date.now();
    let err: unknown = null;
    try {
      await complete(makeHost());
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(2500); // 远小于无超时的挂死形态
  });

  test("错误传播：网关 4xx/5xx 响应体进错误信息（可诊断）", async () => {
    seen = [];
    server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response('{"error":{"message":"Invalid API key"}}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    process.env.DHV_LLM_GATEWAY = gatewayUrl();
    process.env.DHV_LLM_API_KEY = "sk-wrong-key";
    process.env.DHV_LLM_MODEL = "deepseek-flash";

    let err: unknown = null;
    try {
      await complete(makeHost());
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain("401");
    expect(String((err as Error).message)).toContain("Invalid API key");
  });

  test("空 content 可诊断化：错误带 finish_reason=length 与 usage（推理模型吃满预算形态）", async () => {
    // 实测形态：deepseek-flash reasoning 吃满 max_tokens → content="" +
    // finish_reason=length。此前表现为无信息 "empty completion"（v0.4.13 E2E
    // 实测三连空炸穿 run 的根因），现带诊断抛出。
    seen = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        seen.push({ auth: req.headers.get("authorization"), model: body.model, body });
        return Response.json({
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: { completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2048 } },
        });
      },
    });
    process.env.DHV_LLM_GATEWAY = gatewayUrl();
    process.env.DHV_LLM_MODEL = "deepseek-flash";
    delete process.env.DHV_LLM_API_KEY;

    let err: unknown = null;
    try {
      await complete(makeHost());
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    const msg = String((err as Error).message);
    expect(msg).toContain("empty completion");
    expect(msg).toContain("finish_reason=length");
    expect(msg).toContain("reasoning_tokens");
  });

  test("思考量控制：DHV_LLM_THINKING=off 注入 thinking disabled，缺省不发送", async () => {
    startMockGateway();
    process.env.DHV_LLM_GATEWAY = gatewayUrl();
    process.env.DHV_LLM_MODEL = "deepseek-flash";
    delete process.env.DHV_LLM_API_KEY;

    // off → thinking: {type: "disabled"}（实测 DeepSeek 接受，reasoning_len=0）
    process.env.DHV_LLM_THINKING = "off";
    await complete(makeHost());
    expect((seen[0].body as Record<string, unknown>).thinking).toEqual({ type: "disabled" });
    expect((seen[0].body as Record<string, unknown>).reasoning_effort).toBeUndefined();

    // low → reasoning_effort: "low"（DeepSeek/OpenAI 同名字段）
    process.env.DHV_LLM_THINKING = "low";
    await complete(makeHost());
    expect((seen[1].body as Record<string, unknown>).reasoning_effort).toBe("low");
    expect((seen[1].body as Record<string, unknown>).thinking).toBeUndefined();

    // 缺省 → 两个都不发（服务商默认行为，兼容严格校验的网关）
    delete process.env.DHV_LLM_THINKING;
    await complete(makeHost());
    expect((seen[2].body as Record<string, unknown>).thinking).toBeUndefined();
    expect((seen[2].body as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });
});
