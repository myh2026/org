// tests/reconcile.test.ts — v0.5.36（F2 计量归集）：真实车道用量归集
//   llm_stream_done（events.jsonl 逐调用真源）→ metrics.json（机器面）
//   + report.md 成本行（人工面）。scripted 车道零 llm_stream_done → 恒等 no-op。
//   （真实车道首演 F2 实锤：27 次真实调用，metrics.json 恒 0 —— 本文件锁定修复面。）
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { reconcileRealUsage } from "../lib/engine.ts";
import { ROOT } from "./helpers";

/** 唯一 scratch 目录（受限内核 rmSync 不稳，测后不清理 —— 名字唯一防撞）。 */
function scratch(name: string): string {
  const d = path.join(
    ROOT, "demo-run-tests",
    `reconcile-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const llmDone = (track: string, tokens: number) => JSON.stringify({
  seq: 1, ts: new Date().toISOString(), name: "llm_stream_done",
  data: { track, chars: 10, reasoning_chars: 0, elapsed_ms: 100, usage: { total_tokens: tokens } },
});

describe("F2 真实用量归集（reconcileRealUsage）", () => {
  test("真实车道：调用数与 tokens 归集进 metrics.json + report.md 成本行", () => {
    const d = scratch("real");
    fs.writeFileSync(path.join(d, "events.jsonl"), [
      llmDone("decompose", 100),
      llmDone("mint_hsl", 200),
      llmDone("review:write", 300),
      JSON.stringify({ seq: 4, ts: new Date().toISOString(), name: "journal", data: { name: "run_end" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(d, "metrics.json"), JSON.stringify({ accepted: 2, tokens_total: 0, model_calls_total: 0 }));
    fs.writeFileSync(path.join(d, "report.md"), "# 报告\n\n## 成本谱系\ntokens=0 revises=4 model_calls=0\n");
    const rec = reconcileRealUsage(d);
    expect(rec).not.toBeNull();
    expect(rec!.calls).toBe(3);
    expect(rec!.tokens).toBe(600);
    const m = JSON.parse(fs.readFileSync(path.join(d, "metrics.json"), "utf-8"));
    expect(m.model_calls_total).toBe(3);
    expect(m.tokens_total).toBe(600);
    expect(m.llm_calls).toBe(3);
    expect(m.llm_tokens).toBe(600);
    expect(m.accepted).toBe(2); // 既有字段保留
    const r = fs.readFileSync(path.join(d, "report.md"), "utf-8");
    expect(r).toContain("tokens=600 revises=4 model_calls=3");
  });

  test("幂等：重复调用不叠加", () => {
    const d = scratch("idem");
    fs.writeFileSync(path.join(d, "events.jsonl"), llmDone("decompose", 50) + "\n");
    fs.writeFileSync(path.join(d, "metrics.json"), JSON.stringify({ tokens_total: 0, model_calls_total: 0 }));
    const a = reconcileRealUsage(d);
    const b = reconcileRealUsage(d);
    expect(a!.tokens).toBe(50);
    expect(b!.tokens).toBe(50);
    const m = JSON.parse(fs.readFileSync(path.join(d, "metrics.json"), "utf-8"));
    expect(m.model_calls_total).toBe(1);
    expect(m.tokens_total).toBe(50);
  });

  test("自报口径更大时取较大值（同一批调用不重复计）", () => {
    const d = scratch("max");
    fs.writeFileSync(path.join(d, "events.jsonl"), llmDone("decompose", 10) + "\n");
    fs.writeFileSync(path.join(d, "metrics.json"), JSON.stringify({ tokens_total: 480, model_calls_total: 5 }));
    const rec = reconcileRealUsage(d);
    expect(rec!.calls).toBe(5);
    expect(rec!.tokens).toBe(480);
  });

  test("scripted 车道：无 llm_stream_done → 恒等 no-op", () => {
    const d = scratch("scripted");
    fs.writeFileSync(path.join(d, "events.jsonl"), JSON.stringify({ seq: 1, ts: new Date().toISOString(), name: "journal", data: { name: "run_start" } }) + "\n");
    fs.writeFileSync(path.join(d, "metrics.json"), JSON.stringify({ tokens_total: 0, model_calls_total: 0 }));
    expect(reconcileRealUsage(d)).toBeNull();
    const m = JSON.parse(fs.readFileSync(path.join(d, "metrics.json"), "utf-8"));
    expect(m.model_calls_total).toBe(0);
    expect(m.llm_calls).toBeUndefined();
  });

  test("产物缺席容错：无 events.jsonl / 无 metrics.json → null 不抛", () => {
    const d = scratch("missing");
    expect(reconcileRealUsage(d)).toBeNull();
    fs.writeFileSync(path.join(d, "events.jsonl"), llmDone("t", 1) + "\n");
    expect(reconcileRealUsage(d)).toBeNull();
  });
});
