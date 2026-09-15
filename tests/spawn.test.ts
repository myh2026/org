// ============================================================================
// tests/spawn.test.ts — 子生孙递归派生（v0.5.6）：agent_spawn + 深度治理
// ============================================================================
// 覆盖面：
//   1. e2e 递归派生（run 模式）：direct 车道模型发 agent_spawn → 子组织
//      完整监督回路（分解/路由/工厂铸孙专家/审查）→ 孙专家 .hsl 落盘 +
//      事件观测（tool_call agent_spawn）+ 结果回灌收束。
//      子子孙孙的「孙」= 子组织内部经工厂铸造的新专家（record-validator）。
//   2. 深度治理：ORG_SPAWN_MAX=0 全局关闭 → 拒绝且零派生（预算不烧）。
//   3. 档位降级：ORG_TOOLS=1（只读）→ agent_spawn 明确拒绝。
//   4. 剧本继承：子组织消费同一剧本文件的 run 轨道（decompose/review 等）。
//
// 工程注：每用例真实 spawn 完整子组织（bun cli/org.ts → 嵌套 dhv 解释器），
// 逐例 120s 超时（B-15 纪律）。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, ROOT, runDhv, eventsOf } from "./helpers";

const WS = path.join(TEST_RUN, "spawn-ws");
const DIRECT = path.join(ROOT, "hsl/pool/direct.hsl");
const BASE_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true });
});

afterEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

function makeOut(name: string): string {
  const dir = path.join(TEST_RUN, "out-spawn", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 递归派生剧本：direct 轨道（父）+ run-notices 全轨道（子组织消费）。 */
function spawnFixture(): string {
  const file = path.join(TEST_RUN, "spawn-fixture.json");
  const base = JSON.parse(fs.readFileSync(BASE_FIXTURE, "utf-8")) as {
    tracks: Record<string, string[]>;
  };
  const tracks = { ...base.tracks };
  tracks["direct:notice-parser"] = [
    "这个任务需要多步分解（抓取+解析+校验），我派生一个子组织团队来完成。\n<tool>{\"name\":\"agent_spawn\",\"args\":{\"goal\":\"抓取某站点近一周公告，输出结构化表格\",\"mode\":\"run\"}}</tool>",
    "最终答案：子组织团队已完成公告结构化任务（3 子任务全部验收，解析记录已交付）。",
  ];
  fs.writeFileSync(file, JSON.stringify({ acts: [], reviews: [], tracks }, null, 2));
  return file;
}

describe("spawn：子生孙递归派生（agent_spawn 工具）", () => {
  test("e2e：direct 模型派生子组织 → 完整监督回路 → 工厂铸造孙专家", async () => {
    const fixture = spawnFixture();
    const dir = makeOut("spawn-e2e");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 帮我完成公告结构化任务",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser",
      ORG_ASK_SESSION: "spawn-e2e",
      ORG_ASK_QUESTION: "帮我完成公告结构化任务",
      ORG_TOOLS: "write",
      ORG_FIXTURE: fixture,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("最终答案");

    // 工具调用与结果上事件总线（观测面）
    const events = eventsOf(dir);
    const calls = events.filter((e) => e.name === "journal"
      && (e.data as { name?: string })?.name === "tool_call"
      && String((e.data as { detail?: string })?.detail ?? "").includes("agent_spawn"));
    expect(calls.length).toBe(1);

    // 子组织真实落盘：<ws>/spawn/<id>-<slug>/out-spawn/run.json ok
    const spawnRoot = path.join(WS, "spawn");
    expect(fs.existsSync(spawnRoot)).toBe(true);
    const children = fs.readdirSync(spawnRoot);
    expect(children.length).toBe(1);
    const childWs = path.join(spawnRoot, children[0]!);
    const childRun = JSON.parse(
      fs.readFileSync(path.join(childWs, "out-spawn", "run.json"), "utf-8"),
    ) as { ok?: boolean; task?: string };
    expect(childRun.ok).toBe(true);
    expect(childRun.task).toContain("公告");

    // 「孙」：子组织内部经工厂铸造的新专家（record-validator.hsl 落盘）
    const grandchild = path.join(childWs, "registry", "experts", "record-validator.hsl");
    expect(fs.existsSync(grandchild)).toBe(true);
    const gcSrc = fs.readFileSync(grandchild, "utf-8");
    expect(gcSrc).toContain("record-validator");

    // 子组织的监督回路事件（分解/路由/审查的完整证据链）
    const childEvents = eventsOf(path.join(childWs, "out-spawn"));
    const routed = childEvents.filter((e) => String((e.data as { detail?: string })?.detail ?? "").includes("task#2 parse -> B:reuse"));
    expect(routed.length).toBe(1);
  }, 120_000);

  test("深度治理：ORG_SPAWN_MAX=0 全局关闭 → 拒绝且零派生", async () => {
    const fixture = spawnFixture();
    const dir = makeOut("spawn-off");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 帮我完成公告结构化任务",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser",
      ORG_ASK_SESSION: "spawn-off",
      ORG_ASK_QUESTION: "帮我完成公告结构化任务",
      ORG_TOOLS: "write",
      ORG_SPAWN_MAX: "0",
      ORG_FIXTURE: fixture,
    });
    expect(r.ok).toBe(true);
    // 拒绝信息可观测（模型收到明确反馈，可自纠完成）
    const events = eventsOf(dir);
    const denied = events.filter((e) => e.name === "journal"
      && (e.data as { name?: string })?.name === "tool_result"
      && String((e.data as { detail?: string })?.detail ?? "").includes("递归派生已全局关闭"));
    expect(denied.length).toBe(1);
    // 零派生：子工作区不存在（拒绝先于执行，不烧预算）
    expect(fs.existsSync(path.join(WS, "spawn"))).toBe(false);
  }, 120_000);

  test("档位降级：ORG_TOOLS=1（只读）→ agent_spawn 明确拒绝", async () => {
    const fixture = spawnFixture();
    const dir = makeOut("spawn-ro");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 帮我完成公告结构化任务",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser",
      ORG_ASK_SESSION: "spawn-ro",
      ORG_ASK_QUESTION: "帮我完成公告结构化任务",
      ORG_TOOLS: "1",
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(dir);
    const denied = events.filter((e) => e.name === "journal"
      && (e.data as { name?: string })?.name === "tool_denied"
      && String((e.data as { detail?: string })?.detail ?? "").startsWith("agent_spawn"));
    expect(denied.length).toBe(1);
    expect(fs.existsSync(path.join(WS, "spawn"))).toBe(false);
  }, 120_000);

  test("参数校验：goal 缺失 → 明确错误（不派生）", async () => {
    const fixture = path.join(TEST_RUN, "spawn-noargs-fixture.json");
    const base = JSON.parse(fs.readFileSync(BASE_FIXTURE, "utf-8")) as { tracks: Record<string, string[]> };
    const tracks = { ...base.tracks };
    tracks["direct:notice-parser"] = [
      '<tool>{"name":"agent_spawn","args":{"mode":"run"}}</tool>',
      "最终答案：agent_spawn 需要 goal 参数（已向用户说明）。",
    ];
    fs.writeFileSync(fixture, JSON.stringify({ acts: [], reviews: [], tracks }));
    const dir = makeOut("spawn-noargs");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 帮我完成公告结构化任务",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser",
      ORG_ASK_SESSION: "spawn-noargs",
      ORG_ASK_QUESTION: "帮我完成公告结构化任务",
      ORG_TOOLS: "write",
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(dir);
    const err = events.filter((e) => e.name === "journal"
      && (e.data as { name?: string })?.name === "tool_result"
      && String((e.data as { detail?: string })?.detail ?? "").includes("goal 必填"));
    expect(err.length).toBe(1);
    expect(fs.existsSync(path.join(WS, "spawn"))).toBe(false);
  }, 120_000);
});
