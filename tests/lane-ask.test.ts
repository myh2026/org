// ============================================================================
// tests/lane-ask.test.ts — 真车道消息完整性（v0.5.24 关键修复回归）
// ============================================================================
// 背景（实测发现，毕业论文工程价值排序第一的缺陷）：v0.5.3 统一 ask→ask_conv
// 时引入双引号缺陷 —— json_str(user) 返回值自带引号，format! 模板又包一层
// \"{}\，turns_json 成为非法 JSON → 运行期 JSON.parse 失败 → 回落
// [{role:"user",content:""}] → **真实车道 user 消息恒空**。
//
// 影响面（剧本车道全掩盖 —— 1385 测试全绿看不见）：
//   - decompose 只见系统提示词（含公告示例）→ 任意任务被分解成 STOCK 公告管线
//   - direct ask 专家一律「请提供具体需求」（模型从未见过用户问题）
//   - review/clarify/mint 全部在无任务上下文下运行
//
// 测试形态：本地 mock 网关（Bun.serve 随机端口，进程内）+ 异步 Bun.spawn 驱动
// dhv-ts 跑真实 ask() 调用链，断言用户消息非空且逐字贯通 —— 不出网、确定性。
// 工程教训：不能用 spawnSync —— 同步等待会冻结本进程事件循环，子进程 fetch
// mock 网关的请求永远无人应答（死锁实录：用例 100s 无输出假挂起）。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setDefaultTimeout } from "bun:test";
import { ROOT, DHV, shPath } from "./helpers";

setDefaultTimeout(120_000);

const TMP = "/tmp/org-lane-ask-test";

interface SeenMsg {
  role: unknown;
  content: unknown;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let seen: SeenMsg[][] = [];
const SAVED: Record<string, string | undefined> = {};
const VARS = ["ORG_LANE_KIND", "DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL", "DHV_LLM_TIMEOUT_MS", "ORG_CONFIG"];

function startMockGateway(): void {
  seen = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: SeenMsg[] };
      seen.push(body.messages ?? []);
      // SSE 流式车道（v0.2.61+）：host 以 stream:true 消费 data: 增量帧，
      // 流关闭即结束 —— 普通 JSON 响应会让 SSE 解析器挂到超时（实测教训）
      const sse = [
        'data: {"choices":[{"delta":{"content":"pong"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

/** 写一个调用真实 ask() 的 HSL 程序（绝对路径 import —— 与 /tmp 实测同形态）。 */
function writeAskProgram(userText: string): string {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, "ask-probe.hsl");
  const mod = path.join(ROOT, "hsl", "providers", "model.hsl").replace(/\\/g, "/");
  fs.writeFileSync(
    p,
    `import { ask } from "${mod}";

export fn main() -> Result<(), String> {
    let r: String = ask(String::from("regress-lane"), String::from("probe system"), String::from("${userText.replace(/"/g, '\\"')}")).await?;
    println!("ASK_OK: {}", r);
    Ok(())
}
`,
    "utf-8",
  );
  return p;
}

/** 异步驱动 dhv-ts（事件循环保持存活，mock 网关可服务子进程的请求）。 */
async function runDhvAsync(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, DHV, ...args], {
    cwd: ROOT,
    env: { ...process.env, DHV_TS: shPath(DHV), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

function laneEnv(): Record<string, string> {
  return {
    ORG_CONFIG: "/tmp/org-lane-ask-test/config-absent.json",
    ORG_LANE_KIND: "real",
    DHV_LLM_GATEWAY: `http://127.0.0.1:${server!.port}/v1`,
    DHV_LLM_API_KEY: "test-key",
    DHV_LLM_MODEL: "deepseek-chat",
    DHV_LLM_TIMEOUT_MS: "20000",
  };
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
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("真车道消息完整性（v0.5.24 双引号缺陷回归）", () => {
  test("ask() 单轮：用户消息非空且逐字贯通网关（空消息缺陷锁定）", async () => {
    startMockGateway();
    const p = writeAskProgram("写一首七言绝句：明月与代码");
    const r = await runDhvAsync(["run", p, "--quiet"], laneEnv());
    expect(r.stdout).toContain("ASK_OK: pong");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const msgs = seen[0]!;
    // 系统消息在前，用户消息在后 —— 双引号缺陷形态是 content:"" 空串
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("probe system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toBe("写一首七言绝句：明月与代码");
  });

  test("ask() 含引号/反斜杠的用户文本：JSON 转义后语义等价（marshaling 卫生）", async () => {
    startMockGateway();
    // HSL 字面量转义在 HSL 侧硬编码（避开 TS→HSL→json_str 三层转义地狱）：
    // HSL 源里 \\" → 值含引号，\\\\ → 值含反斜杠 —— json_str 必须正确编码
    const mod = path.join(ROOT, "hsl", "providers", "model.hsl").replace(/\\/g, "/");
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, "ask-probe-tricky.hsl");
    fs.writeFileSync(
      p,
      `import { ask } from "${mod}";

export fn main() -> Result<(), String> {
    let tricky: String = String::from("含\\"引号\\"与反斜杠\\\\的内容");
    let r: String = ask(String::from("regress-lane"), String::from("probe system"), tricky).await?;
    println!("ASK_OK: {}", r);
    Ok(())
}
`,
      "utf-8",
    );
    const r = await runDhvAsync(["run", p, "--quiet"], laneEnv());
    expect(r.stdout).toContain("ASK_OK: pong");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const user = seen[0]!.find((m) => m.role === "user");
    expect(user).toBeDefined();
    const content = String(user!.content);
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("引号"); // 引号字符经 json_str 编码后语义保留
    expect(content).toContain("反斜杠");
    expect(content).toContain("\\"); // 反斜杠字符本体存活（JSON 转义不丢内容）
  });

  test("scripted 车道回归零变化：model.hsl check 全过（修复不得误伤）", () => {
    // 修复只动 turns_json 组装（real 车道消费），scripted 车道走 fixture.next
    const proc = Bun.spawnSync([process.execPath, DHV, "check", path.join(ROOT, "hsl", "providers", "model.hsl")], {
      cwd: ROOT,
      env: { ...process.env, DHV_TS: shPath(DHV) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("0 error");
  });
});
