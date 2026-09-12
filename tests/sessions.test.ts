// ============================================================================
// tests/sessions.test.ts — v0.5.0：会话派生 / 版本回退 / 事件具名化
// ----------------------------------------------------------------------------
// 三个「agent 本该有」的能力，后端原语都已存在，缺的是用户可触达的入口：
//   1. 会话派生（fork）：账本 append-only，复制即分叉 —— 对应 codex/opencode /fork
//   2. 版本回退（revert）：工厂补丁把旧源归档为 <name>@<ver>.hsl（金丝雀回滚
//      用的正是它），还原即回退，且回退本身可逆 —— 对应 opencode /undo、codex diff
//   3. 事件具名化：此前 audit / capability_denied / canary_rollback /
//      crystallize_degrade / score_drift_alert / llm_stream_done 等 11 类全部落
//      kind:"unknown"，渲染层 switch 直接丢弃 —— 审计与异常在三个前端都看不见
// ============================================================================
//
// 端到端用例超时：本文件用例会跑完整监督回路（实测单轮 3–14s），而 bun 的默认
// 每用例超时是 5000ms。全局手段都不可用（详见 tests/helpers.ts 的说明），
// 故逐例显式声明 120_000。

import { describe, test, expect, beforeAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { TEST_RUN, runOrg, runOrgRun, makeWorkspace, readJson, exists } from "./helpers";
import { forkSession, renameSession, deleteSession, revertExpert, archivedVersions } from "../lib/engine";
import { normalizeEventLine } from "../lib/events";
import { classifyRunEvent } from "../lib/runCards";

// ---------------------------------------------------------------------------
// 1. 会话派生 / 改名 / 删除（纯文件操作，直接驱动 engine 层）
// ---------------------------------------------------------------------------

describe("v0.5.0：会话派生 fork / rename / rm", () => {
  const ws = path.join(TEST_RUN, "session-ops");
  const dir = () => path.join(ws, "runtime", "sessions", "notice-parser");

  beforeAll(() => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "base.jsonl"),
      [
        JSON.stringify({ turn: 1, question: "q1", answer: "a1", tokens: 10 }),
        JSON.stringify({ turn: 2, question: "q2", answer: "a2", tokens: 12 }),
      ].join("\n") + "\n");
  });

  test("fork：复制账本，轮数与内容一致，原会话字节不变", () => {
    const before = fs.readFileSync(path.join(dir(), "base.jsonl"), "utf-8");
    const r = forkSession(ws, "notice-parser", "base", "copy1");
    expect(r.turns).toBe(2);
    expect(r.from).toBe("base");
    expect(r.to).toBe("copy1");
    expect(r.file).toBe(path.join(dir(), "copy1.jsonl"));
    expect(fs.readFileSync(path.join(dir(), "copy1.jsonl"), "utf-8")).toBe(before);
    // 原会话不受影响（append-only 语义：派生不是移动）
    expect(fs.readFileSync(path.join(dir(), "base.jsonl"), "utf-8")).toBe(before);
  });

  test("fork：派生点之后可独立演进（在副本追加不影响原账本）", () => {
    const orig = fs.readFileSync(path.join(dir(), "base.jsonl"), "utf-8");
    fs.appendFileSync(path.join(dir(), "copy1.jsonl"),
      JSON.stringify({ turn: 3, question: "q3", answer: "a3", tokens: 9 }) + "\n");
    expect(fs.readFileSync(path.join(dir(), "copy1.jsonl"), "utf-8").length)
      .toBeGreaterThan(orig.length);
    expect(fs.readFileSync(path.join(dir(), "base.jsonl"), "utf-8")).toBe(orig);
  });

  test("fork 防呆：目标已存在不覆盖 / 源不存在 / 非法名", () => {
    expect(() => forkSession(ws, "notice-parser", "base", "copy1")).toThrow(/已存在/);
    expect(() => forkSession(ws, "notice-parser", "nope", "x1")).toThrow(/不存在/);
    expect(() => forkSession(ws, "notice-parser", "base", "../evil")).toThrow(/不合法/);
  });

  test("rename：同专家内改名；目标存在则拒绝", () => {
    renameSession(ws, "notice-parser", "copy1", "copy2");
    expect(exists(path.join(dir(), "copy2.jsonl"))).toBe(true);
    expect(exists(path.join(dir(), "copy1.jsonl"))).toBe(false);
    expect(() => renameSession(ws, "notice-parser", "copy2", "base")).toThrow(/已存在/);
    expect(() => renameSession(ws, "notice-parser", "ghost", "z")).toThrow(/不存在/);
  });

  test("rm：删账本即删会话；不存在则报错（不静默成功）", () => {
    deleteSession(ws, "notice-parser", "copy2");
    expect(exists(path.join(dir(), "copy2.jsonl"))).toBe(false);
    expect(() => deleteSession(ws, "notice-parser", "copy2")).toThrow(/不存在/);
  });

  test("CLI：org session fork|rename|rm（与 engine 层同一语义）", () => {
    const f = runOrg(["session", "fork", "notice-parser", "base", "cli1", "--workspace", ws]);
    expect(f.exitCode).toBe(0);
    expect(f.stdout).toContain("已派生会话");
    expect(exists(path.join(dir(), "cli1.jsonl"))).toBe(true);

    const rn = runOrg(["session", "rename", "notice-parser", "cli1", "cli2", "--workspace", ws]);
    expect(rn.exitCode).toBe(0);
    expect(exists(path.join(dir(), "cli2.jsonl"))).toBe(true);

    const rm = runOrg(["session", "rm", "notice-parser", "cli2", "--workspace", ws]);
    expect(rm.exitCode).toBe(0);
    expect(exists(path.join(dir(), "cli2.jsonl"))).toBe(false);

    // 无参给用法，退出码 2（不猜）
    expect(runOrg(["session", "--workspace", ws]).exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. 版本回退（需要真实工厂谱系：run A 铸出 → run B 补丁合入 → 归档 1.0.0）
// ---------------------------------------------------------------------------

describe("v0.5.0：版本回退 org revert", () => {
  const WS = path.join(TEST_RUN, "revert");

  beforeAll(() => {
    const ws = makeWorkspace("revert");
    expect(runOrgRun(ws, path.join(ws, "out-a")).ok).toBe(true);
    expect(runOrgRun(ws, path.join(ws, "out-b")).ok).toBe(true);
  }, 120_000);

  const versionOf = (name: string): string =>
    (readJson(path.join(WS, "registry/index.json")) as Array<{ name: string; version: string }>)
      .find((m) => m.name === name)!.version;

  test("补丁合入后归档源存在（回退的前提）", () => {
    expect(versionOf("record-validator")).toBe("1.0.1");
    expect(archivedVersions(WS, "record-validator")).toContain("1.0.0");
  });

  test("revert：版本号回退 + 在岗源被替换 + 当前源归档（回退可逆）", () => {
    const liveFile = path.join(WS, "registry/experts/record-validator.hsl");
    const patched = fs.readFileSync(liveFile, "utf-8");

    const r = revertExpert(WS, "record-validator");
    expect(r.from).toBe("1.0.1");
    expect(r.to).toBe("1.0.0");
    expect(versionOf("record-validator")).toBe("1.0.0");
    // 在岗源变成归档里那份（1.0.0），与补丁版不同
    const reverted = fs.readFileSync(liveFile, "utf-8");
    expect(reverted).not.toBe(patched);
    expect(reverted).toBe(fs.readFileSync(path.join(WS, "registry/experts/record-validator@1.0.0.hsl"), "utf-8"));
    // 当前源已归档 → 再 revert 可回去
    expect(r.archived).not.toBeNull();
    expect(exists(path.join(WS, "registry/experts/record-validator@1.0.1.hsl"))).toBe(true);
  });

  test("revert 可逆：再回退一次回到补丁版", () => {
    const r = revertExpert(WS, "record-validator", "1.0.1");
    expect(r.to).toBe("1.0.1");
    expect(versionOf("record-validator")).toBe("1.0.1");
  });

  test("git 留痕：两次回退都在注册表历史里", () => {
    const proc = Bun.spawnSync(["git", "-C", WS, "log", "--pretty=%s"], { stdout: "pipe" });
    const subjects = proc.stdout.toString();
    expect(subjects).toContain("revert record-validator 1.0.1 -> 1.0.0");
    expect(subjects).toContain("revert record-validator 1.0.0 -> 1.0.1");
  });

  test("防呆：未知名 / 版本不存在 / 目标等于当前", () => {
    expect(() => revertExpert(WS, "no-such-expert")).toThrow(/没有专家/);
    expect(() => revertExpert(WS, "record-validator", "9.9.9")).toThrow(/归档源不存在/);
    expect(() => revertExpert(WS, "record-validator", "1.0.1")).toThrow(/与当前版本相同/);
  });

  test("CLI：org revert --to（退出码与提示）", () => {
    const bad = runOrg(["revert", "no-such-expert", "--workspace", WS]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("回退失败");

    const ok = runOrg(["revert", "record-validator", "--to", "1.0.0", "--workspace", WS]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("已回退");
    expect(versionOf("record-validator")).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// 3. 事件具名化（11 类此前落 unknown，三端静默丢弃）
// ---------------------------------------------------------------------------

describe("v0.5.0：未知事件具名化（审计与异常不再静默丢弃）", () => {
  const norm = (name: string, data: Record<string, unknown>) =>
    normalizeEventLine({ seq: 1, ts: "t", name, data } as never) as { kind: string } & Record<string, unknown>;

  test("audit / capability_denied：两条来源的字段都认得", () => {
    const a = norm("audit", { event: "capability_elevated: file_write -> confirm" });
    expect(a.kind).toBe("audit");
    expect(a.event).toContain("capability_elevated");

    // 能力策略来源
    const d1 = norm("capability_denied", { capability: "file_write", reason: "Confirm 降级拒绝" });
    expect(d1.kind).toBe("capability_denied");
    expect(d1.capability).toBe("file_write");
    // 宿主故障注入来源（键名是 target 而不是 capability）
    const d2 = norm("capability_denied", { target: "shell.run", reason: "fault(deny)" });
    expect(d2.capability).toBe("shell.run");
  });

  test("canary_rollback / crystallize_degrade / redundancy_compare", () => {
    const c = norm("canary_rollback", { expert: "record-validator", version: "1.0.1", restored: true });
    expect(c.kind).toBe("canary_rollback");
    expect(c.restored).toBe(true);

    const g = norm("crystallize_degrade", { node: "notice-parser", input: "k" });
    expect(g.kind).toBe("crystallize_degrade");
    expect(g.node).toBe("notice-parser");

    const r = norm("redundancy_compare", { a: "x", b: "y", agree: false, coverage_a: 1, coverage_b: 0.5 });
    expect(r.kind).toBe("redundancy_compare");
    expect(r.agree).toBe(false);
    expect(r.coverageB).toBe(0.5);
  });

  test("score_drift_alert / registry_commit_skipped / patch_rollback_failed / run_panic", () => {
    const d = norm("score_drift_alert", { model: "scripted", cell: "judgment|x", previous: 1, current: 0.2, threshold: 0.25 });
    expect(d.kind).toBe("score_drift_alert");
    expect(d.threshold).toBe(0.25);

    expect(norm("registry_commit_skipped", { message: "git 不可用" }).kind).toBe("registry_commit_skipped");
    expect(norm("patch_rollback_failed", { path: "a.hsl", message: "boom" }).kind).toBe("patch_rollback_failed");
    expect(norm("run_panic", { message: "panic" }).kind).toBe("run_panic");
  });

  test("llm_stream_done：用量收尾成为一等事件（成本面板的数据源）", () => {
    const e = norm("llm_stream_done", {
      track: "direct:notice-parser", chars: 120, reasoning_chars: 8,
      elapsed_ms: 900, usage: { total_tokens: 42 },
    });
    expect(e.kind).toBe("llm_stream_done");
    expect(e.track).toBe("direct:notice-parser");
    expect(e.chars).toBe(120);
    expect(e.reasoningChars).toBe(8);
    expect(e.elapsedMs).toBe(900);
    expect((e.usage as { total_tokens: number }).total_tokens).toBe(42);
  });

  test("fault_injected / fault_rejected 归一到 fault（action 区分）", () => {
    const i = norm("fault_injected", { target: "shell.run", nth: 1, kind: "deny", message: "blocked" });
    expect(i.kind).toBe("fault");
    expect(i.action).toBe("injected");
    expect(i.target).toBe("shell.run");
    const r = norm("fault_rejected", { target: "fs.read", reason: "slow 不适用同步目标" });
    expect(r.kind).toBe("fault");
    expect(r.action).toBe("rejected");
  });

  test("分类器：上述事件产出 notice 事实（而不是落 other 被吞）", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["audit", { event: "capability_elevated: x" }, "info"],
      ["capability_denied", { capability: "file_write", reason: "denied" }, "warn"],
      ["canary_rollback", { expert: "e", version: "1.0.1", restored: true }, "err"],
      ["patch_rollback_failed", { path: "p", message: "m" }, "err"],
      ["run_panic", { message: "boom" }, "err"],
      ["score_drift_alert", { model: "m", cell: "c", previous: 1, current: 0, threshold: 0.25 }, "warn"],
      ["llm_stream_done", { track: "t", chars: 1, reasoningChars: 0, elapsedMs: 2, usage: null }, "info"],
    ];
    for (const [name, data, tone] of cases) {
      const ev = normalizeEventLine({ seq: 1, ts: "t", name, data } as never);
      const fact = classifyRunEvent(ev as never) as { t: string; tone?: string; text?: string };
      expect(fact.t).toBe("notice");
      expect(fact.tone).toBe(tone);
      expect(String(fact.text).length).toBeGreaterThan(0);
    }
  });

  test("run_result 合成终态仍有具名分支（不再落 other）", () => {
    const fact = classifyRunEvent({ kind: "run_result" } as never) as { t: string };
    expect(fact.t).toBe("result");
  });
});
