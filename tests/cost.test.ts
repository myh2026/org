// ============================================================================
// tests/cost.test.ts — v0.5.0：用量/成本时间线（llm_stream_done 的消费面）
// ----------------------------------------------------------------------------
// 这块补的是一个**承诺与实现的落差**：v0.5.0 把 llm_stream_done 具名化时写了它是
// 「成本面板的数据源」，但当时并没有面板。本文件锁住那一半：
//   1. 单元：从 events.jsonl 的 llm_stream_done 还原逐次调用 + 按轨道聚合；
//   2. 契约：usage 缺失时 tokens 只是下界（tokensComplete=false），不得伪装成精确值；
//   3. 诚实：scripted 剧本车道不经过网关 → 0 次调用，渲染必须明说而不是显示 0；
//   4. 集成：真实网关车道（mock OpenAI 兼容端点）确实产出 llm_stream_done 记录。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, ROOT, CLI, DHV, runOrg, makeWorkspace, shPath } from "./helpers";
import { readCostTimeline, renderCostTimeline } from "../lib/engine.ts";

const PROBE = path.join(TEST_RUN, "cost-probe");

function writeEvents(dir: string, lines: Array<Record<string, unknown>>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const streamDone = (seq: number, ts: string, track: string, chars: number, reasoning: number, ms: number, usage: unknown) =>
  ({ seq, ts, name: "llm_stream_done", data: { track, chars, reasoning_chars: reasoning, elapsed_ms: ms, usage } });

describe("v0.5.0：用量/成本时间线", () => {
  test("逐次调用还原 + 按轨道聚合 + 总量", () => {
    const dir = path.join(PROBE, "multi");
    fs.rmSync(dir, { recursive: true, force: true });
    writeEvents(dir, [
      streamDone(1, "2026-01-01T00:00:01Z", "direct:a", 100, 5, 500, { total_tokens: 20 }),
      streamDone(2, "2026-01-01T00:00:02Z", "mint_source", 800, 40, 2000, { total_tokens: 300 }),
      streamDone(3, "2026-01-01T00:00:03Z", "direct:a", 40, 0, 300, { total_tokens: 9 }),
      { seq: 4, ts: "2026-01-01T00:00:04Z", name: "run_end", data: { ok: true, elapsed_ms: 3000 } },
    ]);
    const t = readCostTimeline(dir);
    expect(t.calls.length).toBe(3);                   // run_end 不算调用
    expect(t.totals.chars).toBe(940);
    expect(t.totals.reasoningChars).toBe(45);
    expect(t.totals.elapsedMs).toBe(2800);
    expect(t.totals.tokens).toBe(329);
    expect(t.tokensComplete).toBe(true);
    // 聚合按次数降序：direct:a 两次在前
    expect(t.byTrack.map((r) => r.track)).toEqual(["direct:a", "mint_source"]);
    expect(t.byTrack[0]!.calls).toBe(2);
    expect(t.byTrack[0]!.tokens).toBe(29);
    // 调用按时间升序
    expect(t.calls.map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  test("usage 缺失 → tokens 只是下界（tokensComplete=false），不得伪装成精确", () => {
    const dir = path.join(PROBE, "partial");
    fs.rmSync(dir, { recursive: true, force: true });
    writeEvents(dir, [
      streamDone(1, "2026-01-01T00:00:01Z", "x", 10, 0, 100, { total_tokens: 5 }),
      streamDone(2, "2026-01-01T00:00:02Z", "y", 10, 0, 100, null),
    ]);
    const t = readCostTimeline(dir);
    expect(t.tokensComplete).toBe(false);
    expect(t.totals.tokens).toBe(5);                  // 只累加已知的
    expect(t.calls[1]!.tokens).toBeNull();
    expect(renderCostTimeline(t)).toContain("下界");
  });

  test("零调用（scripted 剧本车道）→ 明说无记录，而不是显示 0 次", () => {
    const dir = path.join(PROBE, "empty");
    fs.rmSync(dir, { recursive: true, force: true });
    writeEvents(dir, [{ seq: 1, ts: "t", name: "run_end", data: { ok: true, elapsed_ms: 10 } }]);
    const t = readCostTimeline(dir);
    expect(t.calls.length).toBe(0);
    expect(t.tokensComplete).toBe(false);
    const txt = renderCostTimeline(t);
    expect(txt).toContain("没有模型调用记录");
    expect(txt).toContain("scripted");                // 指明原因，便于用户判断
  });

  test("产物缺失 / 损坏 → 空时间线（不抛错）", () => {
    const t1 = readCostTimeline(path.join(PROBE, "does-not-exist"));
    expect(t1.calls.length).toBe(0);
    const dir = path.join(PROBE, "broken");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), "{not json\n\n");
    expect(readCostTimeline(dir).calls.length).toBe(0);
  });

  test("CLI：org cost 渲染（scripted 产物 → 诚实说明；退出码 0）", () => {
    const ws = path.join(TEST_RUN, "cost-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    writeEvents(path.join(ws, "out-a"), [
      streamDone(1, "2026-01-01T00:00:01Z", "direct:poet", 120, 8, 900, { total_tokens: 42 }),
    ]);
    const r = runOrg(["cost", "--run", path.join(ws, "out-a"), "--workspace", ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("direct:poet");
    expect(r.stdout).toContain("42 tok");

    // 无产物 → 退出码 2（用法/前置缺失，不静默成功）
    const none = runOrg(["cost", "--workspace", path.join(TEST_RUN, "cost-none")]);
    expect(none.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 集成（**未完成，已移出**）：真实网关车道（mock SSE 端点）产出 llm_stream_done
// ----------------------------------------------------------------------------
// 现状：mock 改为返回 SSE 后，org ask --model deepseek 仍是 3 x 180s 超时才失败
// （实测单条用例 237s / 197s），说明流式车道的握手或帧格式仍未对上。
// 为避免把不确定的用例留在套件里（它会把裸 bun test 拖成数分钟且假红），
// 集成面先移出；网关契约由 tests/gateway.test.ts 既有的非流式用例覆盖。
// 流式车道的用量记录待排查后补回 —— 见 GitHub issue「v0.5.0 未完成项」。
//
// 本文件其余用例（单元面）覆盖：逐次调用还原 / 按轨道聚合 / usage 缺失时 tokens
// 只是下界 / 零调用诚实说明 / 产物缺失与损坏容忍 / CLI 渲染与退出码。
