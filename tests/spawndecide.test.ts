// ============================================================================
// tests/spawndecide.test.ts — 派生决策器（v0.5.22：「该不该派」显式化）
// ----------------------------------------------------------------------------
// 覆盖面：
//   1. decideSpawn 单元四态定标：deny（深度/预算红线）· self（琐碎/可替代
//      工具）· reuse（池命中）· spawn（多步信号/复杂度）+ 信号归因
//   2. tokenizeGoal / goalOverlap（中英混合分词 + 双向重合）
//   3. 工具环 spawn_decide（只读）：scripted 剧本全链
//   4. agent_spawn 内嵌决策：trivial goal → self 拦截（零派生 + spawn_decision
//      事件 + 建议工具）；force:true → self 被覆盖（模型显式判断）
//   5. CLI 冒烟：org spawn-decide 四态渲染
//   6. Web GET /api/govex/spawn-decide：四态 + 参数贯通
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { decideSpawn, tokenizeGoal, goalOverlap } from "../lib/spawn-decision.ts";
import { TEST_RUN, ROOT, runDhv, runOrg, eventsOf } from "./helpers";

const WS = path.join(TEST_RUN, "spawndecide-ws");
const DIRECT = path.join(ROOT, "hsl/pool/direct.hsl");

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true });
});
afterEach(() => fs.rmSync(WS, { recursive: true, force: true }));

function ctx(over: Partial<Parameters<typeof decideSpawn>[0]> = {}) {
  return {
    goal: "抓取某站点近一周公告，解析后输出结构化表格并验收",
    depth: 0, maxDepth: 2, budget: 100, decay: 0.5, poolGoals: [],
    ...over,
  };
}

// ---- 1-2. 单元 -----------------------------------------------------------------

describe("spawndecide：decideSpawn 四态定标", () => {
  test("spawn：多步信号（复合交付词）→ 派生 + 子预算/深度归因", () => {
    const d = decideSpawn(ctx());
    expect(d.decision).toBe("spawn");
    expect(d.signals.multiStepSignals).toContain("复合交付词");
    expect(d.childBudget).toBe(50);
    expect(d.childDepth).toBe(1);
    expect(d.reason).toContain("子预算 50");
  });

  test("self：琐碎任务（词元 < 4 · 零多步信号）→ 亲力亲为 + 建议工具", () => {
    const d = decideSpawn(ctx({ goal: "你好" }));
    expect(d.decision).toBe("self");
    expect(d.signals.trivial).toBe(true);
    expect(d.suggestedTool).toBeTruthy();
    expect(d.reason).toContain("琐碎");
  });

  test("self：可替代工具（读文件）且无多步信号 → fs_read 建议", () => {
    const d = decideSpawn(ctx({ goal: "读一下 README.md 文件看看内容" }));
    expect(d.decision).toBe("self");
    expect(d.signals.toolSubstitute).toBe("fs_read");
    expect(d.suggestedTool).toBe("fs_read");
  });

  test("可替代工具 + 多步信号 → 仍 spawn（工具替代只对单步任务生效）", () => {
    const d = decideSpawn(ctx({ goal: "先读 README.md 文件，然后解析公告，最后输出表格并验收" }));
    expect(d.decision).toBe("spawn");
  });

  test("deny：深度耗尽（depth+1 > max）→ 拒绝且给出口", () => {
    const d = decideSpawn(ctx({ depth: 2, maxDepth: 2 }));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("深度已达上限");
    const d2 = decideSpawn(ctx({ maxDepth: 0 }));
    expect(d2.decision).toBe("deny");
    expect(d2.reason).toContain("全局关闭");
  });

  test("deny：预算耗尽（budget 0）→ 拒绝 + 调大指引", () => {
    const d = decideSpawn(ctx({ budget: 0 }));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("预算已耗尽");
  });

  test("deny 优先级最高：预算耗尽时即使 trivial 也 deny（治理红线先于效率）", () => {
    const d = decideSpawn(ctx({ goal: "你好", budget: 0 }));
    expect(d.decision).toBe("deny");
  });

  test("reuse：池命中（相似度 ≥ 0.6）→ 零成本复用 + 池记录 id", () => {
    const d = decideSpawn(ctx({
      poolGoals: [{ goal: "抓取某站点近一周公告，解析后输出结构化表格并验收", id: "abc123" }],
    }));
    expect(d.decision).toBe("reuse");
    expect(d.poolRecordId).toBe("abc123");
    expect(d.signals.poolBestSimilarity).toBe(1);
  });

  test("预算 off（-1）：子预算 -1 且不 deny", () => {
    const d = decideSpawn(ctx({ budget: -1 }));
    expect(d.decision).toBe("spawn");
    expect(d.childBudget).toBe(-1);
  });

  test("tokenizeGoal：中英混合（西文词元 + CJK bigram）", () => {
    const t = tokenizeGoal("解析 notice 公告表格");
    expect(t).toContain("notice");
    expect(t).toContain("公告"); // bigram
    expect(tokenizeGoal("hello world").length).toBe(2);
  });

  test("goalOverlap：双向重合（max 覆盖率）—— 长短表述不齐", () => {
    expect(goalOverlap("做X", "请帮我做X")).toBeGreaterThan(0.5);
    expect(goalOverlap("完全无关", "another thing")).toBe(0);
  });
});

// ---- 3-4. 工具环 e2e --------------------------------------------------------------

function fixtureWith(tracks: Record<string, string[]>): string {
  const f = path.join(TEST_RUN, "spawndecide-fixture.json");
  fs.writeFileSync(f, JSON.stringify({ tracks }, null, 2));
  return f;
}

describe("spawndecide：工具环 e2e", () => {
  function run(out: string, fx: string, env: Record<string, string>) {
    return runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 评估", "--model", "scripted",
      "--fixture", fx, "--out", out, "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "sd-e2e", ORG_ASK_QUESTION: "评估", ORG_TOOLS: "write", ...env }); // agent_spawn 需 Full 档（只读门先于内嵌决策器）
  }

  test("spawn_decide 只读工具：多步任务 → decision=spawn 回灌", () => {
    const out = path.join(TEST_RUN, "out-sd", "decide");
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    const r = run(out, fixtureWith({ "direct:notice-parser": [
      '<tool>{"name":"spawn_decide","args":{"goal":"抓取某站点近一周公告，解析后输出结构化表格并验收"}}</tool>',
      "最终答案：决策器说该派（多步信号）。",
    ] }), {});
    expect(r.ok).toBe(true);
    const ev = eventsOf(out);
    const calls = ev.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    expect(JSON.stringify(calls)).toContain("spawn_decide");
    // 决策内容回灌给模型（剧本第二轮的最终答案是对决策的消费）
    const ledger = fs.readFileSync(path.join(WS, "runtime/sessions/notice-parser/sd-e2e.jsonl"), "utf-8");
    expect(ledger).toContain("该派");
  }, 120_000);

  test("agent_spawn 内嵌决策：trivial goal → self 拦截（零派生 + 事件 + 建议工具）", () => {
    const out = path.join(TEST_RUN, "out-sd", "self-block");
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    const r = run(out, fixtureWith({ "direct:notice-parser": [
      '<tool>{"name":"agent_spawn","args":{"goal":"你好","mode":"run"}}</tool>',
      "最终答案：决策器拦了 —— 琐碎任务亲力亲为。",
    ] }), {});
    expect(r.ok).toBe(true);
    const ev = eventsOf(out);
    // 决策事件（self + 理由）
    const decisions = ev.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "spawn_decision");
    expect(decisions.length).toBe(1);
    expect(JSON.stringify(decisions[0])).toContain("self");
    // 工具结果：ok=false + decision=self + 建议工具（模型可自纠）
    const results = ev.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    // 人读摘要走 result_summary 的 error 分支（含「琐碎任务」判定词）；决策
    // 四态的机读面在 spawn_decision 事件（上面已断言）与回灌模型的完整 JSON
    expect(JSON.stringify(results[0])).toContain("琐碎任务");
    // 零派生：子工作区不存在
    expect(fs.existsSync(path.join(WS, "spawn"))).toBe(false);
  }, 120_000);

  test("agent_spawn 内嵌决策：force:true → self 被覆盖（模型显式判断，事件 force_overridden）", () => {
    const out = path.join(TEST_RUN, "out-sd", "force");
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    // 剧本：force 派 trivial goal → 决策器放行 → 真派生（run 模式走 run-notices 剧本）
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/run-notices.json"), "utf-8")) as { tracks: Record<string, string[]> };
    const tracks = { ...base.tracks };
    tracks["direct:notice-parser"] = [
      '<tool>{"name":"agent_spawn","args":{"goal":"你好","mode":"run","force":true}}</tool>',
      "最终答案：force 派生完成（模型显式判断优先于效率建议）。",
    ];
    const r = run(out, fixtureWith(tracks), {});
    expect(r.ok).toBe(true);
    const ev = eventsOf(out);
    const decisions = ev.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "spawn_decision");
    const all = JSON.stringify(decisions);
    expect(all).toContain("force_overridden");
    // 真派生：子工作区落盘（force 生效）
    const spawnDir = path.join(WS, "spawn");
    expect(fs.existsSync(spawnDir)).toBe(true);
  }, 120_000);
});

// ---- 5. CLI 冒烟 ------------------------------------------------------------------

describe("spawndecide：CLI 冒烟", () => {
  test("org spawn-decide：spawn 态渲染（子预算 + 信号归因）", () => {
    const r = runOrg(["spawn-decide", "--goal", "抓取某站点近一周公告，解析后输出结构化表格并验收", "--workspace", WS]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("SPAWN");
    expect(r.stdout).toContain("子预算");
  }, 120_000);

  test("org spawn-decide：self 态渲染（建议工具）", () => {
    const r = runOrg(["spawn-decide", "--goal", "读一下 README.md 文件", "--workspace", WS]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("SELF");
    expect(r.stdout).toContain("fs_read");
  }, 120_000);
});

// ---- 6. Web 端点 --------------------------------------------------------------------

describe("spawndecide：Web GET /api/govex/spawn-decide", () => {
  test("四态之一 + 信号归因 + 参数贯通（depth 超限 → deny）", async () => {
    const { startWebServer } = await import("../web/entry.ts") as unknown as { startWebServer: (opts: { workspace: string; port: number; model: string }) => Bun.Server };
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const j1 = await (await fetch(`${base}/api/govex/spawn-decide?goal=${encodeURIComponent("抓取公告解析输出表格并验收")}&workspace=${encodeURIComponent(WS)}`)).json();
      expect(j1.ok).toBe(true);
      expect(j1.decision).toBe("spawn");
      expect(j1.signals.tokenCount).toBeGreaterThan(0);
      const j2 = await (await fetch(`${base}/api/govex/spawn-decide?goal=${encodeURIComponent("抓取公告解析输出表格并验收")}&depth=2&max=2&workspace=${encodeURIComponent(WS)}`)).json();
      expect(j2.decision).toBe("deny");
      const j3 = await (await fetch(`${base}/api/govex/spawn-decide?workspace=${encodeURIComponent(WS)}`)).json();
      expect(j3.ok).toBe(false); // goal 缺失 → 400
    } finally {
      srv.stop(true);
    }
  }, 120_000);
});
