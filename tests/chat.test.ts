// ============================================================================
// tests/chat.test.ts — v0.4.15 批次：聊天 REPL + Token 流式输出
// ============================================================================
// 覆盖面：
//   1. parseInput —— 斜杠/shell/问题/空 四态解析（REPL 输入语义单元）
//   2. 会话账本单元 —— readSession / listSessions / latestSession / compactLedger
//   3. 流式车道（mock SSE 网关）—— reset 标记 + reasoning/content 双通道
//      逐块落盘 llm-stream.jsonl · 返回值完整正文 · llm_stream_done 事件
//   4. events.ts 流式解析 —— parseLlmStreamLine 三通道 + readEventStream 合流
//   5. scripted 车道不产生 llm-stream.jsonl（负例：观测面降级不炸）
// 全部本地 mock（Bun.serve 随机端口）—— 不出网、确定性、毫秒级。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Host } from "../toolchain/dhv-ts/src/host";
import { parseInput, readSession, listSessions, latestSession, compactLedger } from "../cli/chat.ts";
import { parseLlmStreamLine, readEventStream } from "../lib/events.ts";

// ---------- 工具 ----------

let seqDir = 0;
function tmpWs(): { ws: string; dir: string } {
  const dir = path.join("/tmp", `org-chat-test-${Date.now()}-${seqDir++}`);
  fs.mkdirSync(dir, { recursive: true });
  return { ws: dir, dir };
}
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeSession(ws: string, expert: string, session: string, lines: object[]): void {
  const file = path.join(ws, "runtime", "sessions", expert, `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

// ---------- 1. parseInput ----------

describe("聊天 REPL：输入解析（parseInput）", () => {
  test("斜杠命令带参数", () => {
    const p = parseInput("/model deepseek");
    expect(p.kind).toBe("slash");
    expect(p.command).toBe("model");
    expect(p.arg).toBe("deepseek");
  });
  test("斜杠命令无参数（尾空格容忍）", () => {
    const p = parseInput("/sessions   ");
    expect(p.kind).toBe("slash");
    expect(p.command).toBe("sessions");
    expect(p.arg).toBe("");
  });
  test("斜杠命令大小写不敏感", () => {
    expect(parseInput("/HELP").command).toBe("help");
  });
  test("shell 逃逸", () => {
    const p = parseInput("!ls -la demo-ws");
    expect(p.kind).toBe("shell");
    expect(p.arg).toBe("ls -la demo-ws");
  });
  test("普通问题（含多行）", () => {
    const p = parseInput("什么是 ORG 的路由语义？\n第二行");
    expect(p.kind).toBe("question");
    expect(p.question).toContain("第二行");
  });
  test("空输入", () => {
    expect(parseInput("").kind).toBe("empty");
    expect(parseInput("   ").kind).toBe("empty");
  });
  test("问题以感叹号开头仍是问题（仅 ! 前缀才是逃逸）", () => {
    expect(parseInput("!!").kind).toBe("shell");
    expect(parseInput("¡hola!").kind).toBe("question");
  });
});

// ---------- 2. 会话账本单元 ----------

describe("聊天 REPL：会话账本（list/read/compact）", () => {
  let env: { ws: string; dir: string };
  beforeEach(() => { env = tmpWs(); });
  afterEach(() => { cleanup(env.dir); });

  test("readSession：缺失 = 空数组；JSONL 逐行解析", () => {
    expect(readSession(env.ws, "nobody", "default")).toEqual([]);
    writeSession(env.ws, "expert-a", "default", [
      { turn: 1, question: "q1", answer: "a1", tokens: 10, ctx_tokens: 20 },
      { turn: 2, question: "q2", answer: "a2", tokens: 5, ctx_tokens: 30 },
    ]);
    const turns = readSession(env.ws, "expert-a", "default");
    expect(turns.length).toBe(2);
    expect(turns[1]!.turn).toBe(2);
    expect(turns[1]!.ctx_tokens).toBe(30);
  });

  test("listSessions：跨会话汇总（轮次/tokens/最近问题），mtime 降序", () => {
    writeSession(env.ws, "e", "s-old", [{ turn: 1, question: "旧问题", answer: "旧答案", tokens: 3, ctx_tokens: 9 }]);
    writeSession(env.ws, "e", "s-new", [
      { turn: 1, question: "新问题一", answer: "答", tokens: 4, ctx_tokens: 12 },
      { turn: 2, question: "新问题二", answer: "答", tokens: 6, ctx_tokens: 22 },
    ]);
    // 保证 mtime 顺序
    const now = Date.now();
    fs.utimesSync(path.join(env.ws, "runtime/sessions/e/s-old.jsonl"), new Date(now - 5000), new Date(now - 5000));
    const list = listSessions(env.ws, "e");
    expect(list.length).toBe(2);
    expect(list[0]!.session).toBe("s-new");
    expect(list[0]!.turns).toBe(2);
    expect(list[0]!.tokens).toBe(10);
    expect(list[0]!.lastQuestion).toBe("新问题二");
    expect(list[1]!.session).toBe("s-old");
  });

  test("latestSession：取最近；无会话 → default", () => {
    expect(latestSession(env.ws, "e")).toBe("default");
    writeSession(env.ws, "e", "s1", [{ turn: 1, question: "q", answer: "a", tokens: 1, ctx_tokens: 2 }]);
    expect(latestSession(env.ws, "e")).toBe("s1");
  });

  test("compactLedger：重写为单轮摘要 + 备份可回滚 + compacted 标记", () => {
    writeSession(env.ws, "e", "s", [
      { turn: 1, question: "q1", answer: "很长的答案".repeat(10), tokens: 40, ctx_tokens: 80 },
      { turn: 2, question: "q2", answer: "另一些答案".repeat(10), tokens: 50, ctx_tokens: 120 },
    ]);
    const { backup } = compactLedger(env.ws, "e", "s", "这是摘要", 2);
    expect(fs.existsSync(backup)).toBe(true);
    // 备份内容 = 原账本（回滚证据）
    const bak = fs.readFileSync(backup, "utf-8");
    expect(bak).toContain("q1");
    expect(bak).toContain("q2");
    // 压缩后账本：单条 compacted 摘要
    const turns = readSession(env.ws, "e", "s");
    expect(turns.length).toBe(1);
    expect(turns[0]!.compacted).toBe(true);
    expect(turns[0]!.compacted_from).toBe(2);
    expect(turns[0]!.answer).toBe("这是摘要");
    expect(turns[0]!.turn).toBe(1);
    expect(turns[0]!.tokens).toBeGreaterThan(0);
  });
});

// ---------- 3. 流式车道（mock SSE 网关） ----------

const SAVED: Record<string, string | undefined> = {};
const VARS = ["DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL"];

describe("流式车道：SSE 逐块解析与 llm-stream.jsonl 落盘", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let outdir = "";

  beforeEach(() => {
    for (const v of VARS) SAVED[v] = process.env[v];
    outdir = path.join("/tmp", `org-chat-stream-${Date.now()}-${seqDir++}`);
    fs.mkdirSync(outdir, { recursive: true });
  });
  afterEach(() => {
    for (const v of VARS) {
      if (SAVED[v] === undefined) delete process.env[v];
      else process.env[v] = SAVED[v]!;
    }
    server?.stop(true);
    server = null;
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  function makeHost(): Host {
    return new Host({
      workspace: "/tmp/org-chat-test-ws",
      task: "stream probe",
      model: "deepseek",
      temperature: 0.1,
      maxTurns: 1,
      maxBashCalls: 0,
      maxOutputChars: 4096,
      allow: [],
      scale: "solo",
      outdir,
      quiet: true,
    });
  }

  /** SSE mock：先发 N 块 reasoning，再发 M 块 content，尾包带 usage + [DONE]。 */
  function startSseMock(reasoningChunks: string[], contentChunks: string[]): void {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        expect(body.stream).toBe(true); // 流式车道必须带 stream:true
        const frames: string[] = [];
        const push = (delta: Record<string, unknown>): void => {
          frames.push(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
        };
        for (const r of reasoningChunks) push({ reasoning_content: r });
        for (const c of contentChunks) push({ content: c });
        frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } })}\n\n`);
        frames.push("data: [DONE]\n\n");
        // 慢速分帧送达（模拟真实逐 token）
        const stream = new ReadableStream({
          async start(controller) {
            for (const f of frames) {
              controller.enqueue(new TextEncoder().encode(f));
              await new Promise((r) => setTimeout(r, 5));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    process.env.DHV_LLM_GATEWAY = `http://127.0.0.1:${server.port}/v1`;
  }

  function streamFileLines(): { ts: string; track: string; kind: string; delta: string }[] {
    const f = path.join(outdir, "llm-stream.jsonl");
    return fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  }

  test("reasoning/content 双通道逐块落盘 + 返回完整正文 + reset 标记 + llm_stream_done 事件", async () => {
    startSseMock(["思考A", "思考B"], ["你好", "，", "世界"]);
    const host = makeHost();
    const llm = host.api.llm as { complete: (r: unknown) => Promise<string> };
    const out = await llm.complete({
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.1, maxTokens: 64,
      stream: true, track: "direct:expert-a",
    });
    // 返回值 = 完整正文（拼接）
    expect(out).toBe("你好，世界");
    // llm-stream.jsonl：reset + 2 reasoning + 3 content
    const lines = streamFileLines();
    const kinds = lines.map((l) => l.kind);
    expect(kinds[0]).toBe("reset");
    expect(kinds.filter((k) => k === "reasoning").length).toBe(2);
    expect(kinds.filter((k) => k === "content").length).toBe(3);
    // 增量按原样保序落盘
    expect(lines.filter((l) => l.kind === "content").map((l) => l.delta).join("")).toBe("你好，世界");
    expect(lines.filter((l) => l.kind === "reasoning").map((l) => l.delta).join("")).toBe("思考A思考B");
    // track 归因贯通
    expect(lines.every((l) => l.track === "direct:expert-a")).toBe(true);
    // llm_stream_done 事件（chars/reasoning_chars/elapsed 可观测）
    const done = (host as unknown as { events: { name: string; data: Record<string, unknown> }[] }).events
      .find((e) => e.name === "llm_stream_done");
    expect(done).toBeDefined();
    expect(done!.data.chars).toBe("你好，世界".length);
    expect(done!.data.reasoning_chars).toBe("思考A思考B".length);
    expect(done!.data.usage).toEqual({ total_tokens: 42 });
  });

  test("再次调用 → 每次流开始都有 reset 标记（重试重绘观测面）", async () => {
    startSseMock([], ["a", "b"]);
    const host = makeHost();
    const llm = host.api.llm as { complete: (r: unknown) => Promise<string> };
    await llm.complete({ messages: [{ role: "user", content: "1" }], stream: true, track: "t" });
    await llm.complete({ messages: [{ role: "user", content: "2" }], stream: true, track: "t" });
    const kinds = streamFileLines().map((l) => l.kind);
    expect(kinds.filter((k) => k === "reset").length).toBe(2);
    expect(kinds.filter((k) => k === "content").length).toBe(4);
  });

  test("空正文流（推理吃满预算）→ 抛错带 reasoning_chars 诊断面", async () => {
    startSseMock(["只有思考没有正文"], []);
    const host = makeHost();
    const llm = host.api.llm as { complete: (r: unknown) => Promise<string> };
    let err: Error | null = null;
    try {
      await llm.complete({ messages: [{ role: "user", content: "x" }], stream: true, track: "t" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("empty completion");
    expect(err!.message).toContain("reasoning_chars=8");
  });

  test("scripted 车道（无网关）不产生 llm-stream.jsonl（负例：观测面降级不炸）", async () => {
    delete process.env.DHV_LLM_GATEWAY;
    // v0.4.17：负例前提从「环境恰好没装 SDK」改为机械开关 DHV_LLM_DISABLE_SDK=1
    // —— 装了 z-ai-web-dev-sdk 的机器上（本仓库 bun install 即装）旧写法会
    // 真实外联成功 → 负例假阴（实测踩坑）。
    process.env.DHV_LLM_DISABLE_SDK = "1";
    const ws = tmpWs();
    const host = new Host({
      workspace: ws.ws, task: "t", model: "scripted", temperature: 0.1,
      maxTurns: 1, maxBashCalls: 0, maxOutputChars: 4096,
      allow: [], scale: "solo", outdir, quiet: true,
    });
    const llm = host.api.llm as { complete: (r: unknown) => Promise<string> };
    // 零外联模式：期望抛错（错误可诊断）而不是产生流文件
    let threw = false;
    let message = "";
    try {
      await llm.complete({ messages: [{ role: "user", content: "x" }], stream: true, track: "t" });
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("DHV_LLM_DISABLE_SDK");
    expect(fs.existsSync(path.join(outdir, "llm-stream.jsonl"))).toBe(false);
    delete process.env.DHV_LLM_DISABLE_SDK;
    cleanup(ws.dir);
  });
});

// ---------- 4. events.ts 流式解析 ----------

describe("events.ts：llm-stream 解析与合流", () => {
  test("parseLlmStreamLine：三通道 + 坏行容忍", () => {
    expect(parseLlmStreamLine('{"ts":"t","track":"direct:e","kind":"content","delta":"hi"}')!.delta).toBe("hi");
    expect(parseLlmStreamLine('{"ts":"t","track":"direct:e","kind":"reasoning","delta":"想"}')!.kind).toBe("reasoning");
    expect(parseLlmStreamLine('{"ts":"t","track":"direct:e","kind":"reset","delta":""}')!.kind).toBe("reset");
    expect(parseLlmStreamLine("not json")).toBeNull();
    expect(parseLlmStreamLine('{"ts":"t","kind":"content"}')).toBeNull(); // 无 delta
  });

  test("readEventStream：llm-stream 增量并入事件流", () => {
    const dir = path.join("/tmp", `org-chat-events-${Date.now()}-${seqDir++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"),
      JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00Z", name: "run_start", data: { mission: "m" } }) + "\n", "utf-8");
    fs.writeFileSync(path.join(dir, "llm-stream.jsonl"), [
      JSON.stringify({ ts: "2026-01-01T00:00:01Z", track: "direct:e", kind: "reset", delta: "" }),
      JSON.stringify({ ts: "2026-01-01T00:00:02Z", track: "direct:e", kind: "content", delta: "答" }),
    ].join("\n") + "\n", "utf-8");
    const events = readEventStream(
      path.join(dir, "events.jsonl"),
      path.join(dir, "journal.jsonl"),
      path.join(dir, "llm-stream.jsonl"),
    );
    const deltas = events.filter((e) => e.kind === "llm_delta");
    expect(deltas.length).toBe(2);
    expect(deltas[0]!.kind === "llm_delta" && deltas[0]!.channel).toBe("reset");
    expect(deltas[1]!.kind === "llm_delta" && deltas[1]!.delta).toBe("答");
    // 无 journal 文件时 events 通道正常
    expect(events[0]!.kind).toBe("run_start");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
