// ============================================================================
// tests/retest.test.ts — 选择性重跑 / flaky 管理（#104，v0.5.22）
// ----------------------------------------------------------------------------
// 覆盖面（不真跑 bun test —— 台账用 fixture 注入）：
//   1. 发现：tests/*.test.ts 平铺发现 + 排序 + 缺席诚实空
//   2. 选择器单元：--file（glob/子串）· --name（→ -t 模式）· --failed-only
//      （台账最新一轮失败集 → 文件集合 + 失败名观测面）+ 空选择/全绿/台账空
//      三种诚实错误
//   3. flaky 台账：append-only 读写往返 · 连续 2 败标记 / 再 pass 解除 ·
//      file::name 键（同名测试跨文件不混账）· 坏行容忍
//   4. 命令生成：bun test <files> --timeout 120000 [-t 模式]（B-15 超时纪律）
//      + bun test 输出解析器（(pass)/(fail) 行协议 + 文件头归属）
//   5. CLI 冒烟：org retest plan 渲染 + org retest 无 verb usage + 台账空
//      failed-only exit 2
//   6. 工具环 e2e：retest_plan 只读（计划不执行）
//   7. Web GET /api/govex/retest（plan/flaky 两动作）+ 🔁 面板要素
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverTestFiles, retestPlan, readFlakyLedger, appendFlakyRecord, flakySummary,
  nextRunNumber, parseBunTestOutput, flakyLedgerPath, type FlakyRunRecord,
} from "../lib/retest.ts";
import { ROOT, TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";

/** 测试工作区：tests/ 三文件 + 可选台账。 */
const WS = path.join(TEST_RUN, "retest-ws");
function seedWorkspace(ledger = false): void {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true }); // registry 锚（Web readWorkspaceOf）
  fs.mkdirSync(path.join(WS, "tests"), { recursive: true });
  for (const f of ["alpha.test.ts", "beta.test.ts", "gamma.test.ts"]) {
    fs.writeFileSync(path.join(WS, "tests", f), `import { test } from "bun:test";\ntest("${f} 用例", () => {});\n`);
  }
  if (ledger) fs.rmSync(path.join(WS, "runtime", "flaky.jsonl"), { force: true });
}

/** 造一轮台账记录（fixture 注入 —— 不真跑 bun test）。 */
function run(run: number, results: Array<[string, string, boolean]>, exitCode = 0): FlakyRunRecord {
  return {
    ts: new Date(2026, 8, 22, 12, run).toISOString(),
    run,
    command: "bun test tests/alpha.test.ts --timeout 120000",
    exitCode,
    results: results.map(([file, name, pass]) => ({ file, name, pass })),
  };
}

// ---- 1. 发现 --------------------------------------------------------------------

describe("retest：测试文件发现", () => {
  test("tests/*.test.ts 平铺发现 + 排序 + 目录缺席诚实空", () => {
    seedWorkspace();
    expect(discoverTestFiles(WS)).toEqual(["tests/alpha.test.ts", "tests/beta.test.ts", "tests/gamma.test.ts"]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rt-empty-"));
    expect(discoverTestFiles(empty)).toEqual([]);
    fs.rmSync(empty, { recursive: true, force: true });
  }, 30_000);
});

// ---- 2. 选择器 ------------------------------------------------------------------

describe("retest：选择器（--file / --name / --failed-only）", () => {
  beforeEach(() => seedWorkspace(true));

  test("--file：glob 命中子集 + 子串命中 + 无命中诚实错误", () => {
    const glob = retestPlan(WS, { file: "beta*" });
    expect(glob.ok).toBe(true);
    expect(glob.files).toEqual(["tests/beta.test.ts"]);
    const sub = retestPlan(WS, { file: "gamma" });
    expect(sub.files).toEqual(["tests/gamma.test.ts"]);
    const none = retestPlan(WS, { file: "nope*" });
    expect(none.ok).toBe(false);
    expect(none.error).toContain("无命中");
  }, 30_000);

  test("--name：进 -t 模式（bun test -t 子串）+ 命令形态精确", () => {
    const p = retestPlan(WS, { name: "probe" });
    expect(p.ok).toBe(true);
    expect(p.namePattern).toBe("probe");
    expect(p.command).toBe("bun test tests/alpha.test.ts tests/beta.test.ts tests/gamma.test.ts --timeout 120000 -t probe");
    const noName = retestPlan(WS, {});
    expect(noName.command).toBe("bun test tests/alpha.test.ts tests/beta.test.ts tests/gamma.test.ts --timeout 120000"); // B-15 超时纪律
  }, 30_000);

  test("--failed-only：台账最新一轮失败集 → 文件 + 失败名；台账空/全绿/选择器交集空 三种诚实错误", () => {
    // 台账空
    const empty = retestPlan(WS, { failedOnly: true });
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("台账为空");
    // run1 有失败
    appendFlakyRecord(WS, run(1, [["tests/alpha.test.ts", "A 用例", false], ["tests/alpha.test.ts", "B 用例", true], ["tests/beta.test.ts", "C 用例", false]]));
    // run2 全绿（最新一轮）→ 无失败可重跑
    appendFlakyRecord(WS, run(2, [["tests/alpha.test.ts", "A 用例", true], ["tests/beta.test.ts", "C 用例", true]]));
    const allGreen = retestPlan(WS, { failedOnly: true });
    expect(allGreen.ok).toBe(false);
    expect(allGreen.error).toContain("全绿");
    // run3 又有失败 → failed-only 取 run3
    appendFlakyRecord(WS, run(3, [["tests/gamma.test.ts", "G 用例", false], ["tests/alpha.test.ts", "A 用例", true]]));
    const p = retestPlan(WS, { failedOnly: true });
    expect(p.ok).toBe(true);
    expect(p.files).toEqual(["tests/gamma.test.ts"]); // run3 的失败集文件
    expect(p.failedNames).toEqual(["G 用例"]);
    expect(p.command).toBe("bun test tests/gamma.test.ts --timeout 120000");
    expect(p.note).toContain("run #3");
    // failed-only × --file 交集空
    const inter = retestPlan(WS, { failedOnly: true, file: "beta*" });
    expect(inter.ok).toBe(false);
  }, 30_000);
});

// ---- 3. flaky 台账 ---------------------------------------------------------------

describe("retest：flaky 台账（runtime/flaky.jsonl append-only）", () => {
  beforeEach(() => seedWorkspace(true));

  test("读写往返 + 轮次号递增", () => {
    expect(flakyLedgerPath(WS)).toBe(path.join(WS, "runtime", "flaky.jsonl"));
    expect(readFlakyLedger(WS).records).toEqual([]);
    const r1 = run(1, [["tests/a.test.ts", "t1", false]]);
    expect(appendFlakyRecord(WS, r1).ok).toBe(true);
    const { records } = readFlakyLedger(WS);
    expect(records.length).toBe(1);
    expect(records[0]!.run).toBe(1);
    expect(records[0]!.results[0]).toEqual({ file: "tests/a.test.ts", name: "t1", pass: false });
    expect(nextRunNumber(records)).toBe(2);
  }, 30_000);

  test("连续 2 败标记 flaky + 再 pass 解除（连续性语义，非累计）", () => {
    appendFlakyRecord(WS, run(1, [["tests/a.test.ts", "t1", false]])); // 1 败
    expect(flakySummary(WS).flakyCount).toBe(0); // 单次失败不标
    appendFlakyRecord(WS, run(2, [["tests/a.test.ts", "t1", false]])); // 连续 2 败
    const s2 = flakySummary(WS);
    expect(s2.flakyCount).toBe(1);
    expect(s2.entries[0]!.history).toEqual(["fail", "fail"]);
    appendFlakyRecord(WS, run(3, [["tests/a.test.ts", "t1", true]])); // 再 pass 解除
    expect(flakySummary(WS).flakyCount).toBe(0);
    expect(flakySummary(WS).entries[0]!.history).toEqual(["fail", "fail", "pass"]);
  }, 30_000);

  test("file::name 键：同名测试跨文件不混账", () => {
    appendFlakyRecord(WS, run(1, [["tests/a.test.ts", "同用例", false], ["tests/b.test.ts", "同用例", false]]));
    appendFlakyRecord(WS, run(2, [["tests/a.test.ts", "同用例", false], ["tests/b.test.ts", "同用例", true]]));
    const s = flakySummary(WS);
    expect(s.entries.length).toBe(2); // 两键独立
    const a = s.entries.find((e) => e.file === "tests/a.test.ts")!;
    const b = s.entries.find((e) => e.file === "tests/b.test.ts")!;
    expect(a.flaky).toBe(true); // a 连续 2 败
    expect(b.flaky).toBe(false); // b 败→pass
  }, 30_000);

  test("坏行容忍：坏 JSON 行计数不炸，好行照常解析", () => {
    appendFlakyRecord(WS, run(1, [["tests/a.test.ts", "t1", true]]));
    fs.appendFileSync(flakyLedgerPath(WS), "{broken json\nnot-a-json\n");
    appendFlakyRecord(WS, run(2, [["tests/a.test.ts", "t1", true]]));
    const { records, bad } = readFlakyLedger(WS);
    expect(records.length).toBe(2);
    expect(bad).toBe(2);
    expect(flakySummary(WS).bad).toBe(2);
  }, 30_000);
});

// ---- 4. 命令生成 + 输出解析 --------------------------------------------------------

describe("retest：命令生成与 bun test 输出解析", () => {
  test("parseBunTestOutput：文件头归属 + (pass)/(fail) 行协议 + 计时后缀剥离", () => {
    const sample = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "tests/dummy.test.ts:",
      "(pass) grp > passes [0.06ms]",
      "(fail) grp > fails [0.10ms]",
      "",
      " 1 pass",
      " 1 fail",
      "Ran 2 tests across 1 file. [9.00ms]",
      "",
      "tests/other.test.ts:",
      "(pass) solo [1.00ms]",
    ].join("\n");
    const r = parseBunTestOutput(sample);
    expect(r).toEqual([
      { file: "tests/dummy.test.ts", name: "grp > passes", pass: true },
      { file: "tests/dummy.test.ts", name: "grp > fails", pass: false },
      { file: "tests/other.test.ts", name: "solo", pass: true },
    ]);
    // 头前的结果（异常形态）file 空串 —— 解析器不炸
    expect(parseBunTestOutput("(pass) orphan")[0]!.file).toBe("");
  }, 30_000);

  test("空选择诚实错误：tests/ 缺席", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rt-no-tests-"));
    const p = retestPlan(empty, {});
    expect(p.ok).toBe(false);
    expect(p.error).toContain("未发现");
    fs.rmSync(empty, { recursive: true, force: true });
  }, 30_000);
});

// ---- 5. CLI 冒烟 ------------------------------------------------------------------

describe("retest：CLI 冒烟（org retest）", () => {
  beforeEach(() => seedWorkspace(true));

  test("org retest plan --file：命令渲染 + flaky 观测；org retest 无 verb usage exit 2", () => {
    appendFlakyRecord(WS, run(1, [["tests/alpha.test.ts", "A 用例", false]]));
    appendFlakyRecord(WS, run(2, [["tests/alpha.test.ts", "A 用例", false]]));
    const p = runOrg(["retest", "plan", "--file", "beta*", "--workspace", WS]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toContain("bun test tests/beta.test.ts --timeout 120000");
    expect(p.stdout).toContain("flaky"); // flaky 台账观测行
    const usage = runOrg(["retest", "--workspace", WS]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("org retest plan");
    // 台账空 + failed-only → 诚实 exit 2
    const emptyWs = path.join(TEST_RUN, "retest-empty-ws");
    fs.rmSync(emptyWs, { recursive: true, force: true });
    fs.cpSync(WS, emptyWs, { recursive: true });
    fs.rmSync(path.join(emptyWs, "runtime", "flaky.jsonl"), { force: true });
    const fo = runOrg(["retest", "plan", "--failed-only", "--workspace", emptyWs]);
    expect(fo.exitCode).toBe(2);
    expect(fo.stderr).toContain("台账为空");
  }, 120_000);
});

// ---- 6. 工具环 e2e（retest_plan 只读） ----------------------------------------------

describe("retest：工具环 e2e（retest_plan 只读 —— 计划不执行）", () => {
  const WSE = path.join(TEST_RUN, "retest-e2e-ws");
  const DIRECT = path.join(ROOT, "hsl/pool/direct.hsl");

  beforeEach(() => {
    fs.rmSync(WSE, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "demo-ws"), WSE, { recursive: true });
    fs.mkdirSync(path.join(WSE, "tests"), { recursive: true });
    fs.writeFileSync(path.join(WSE, "tests", "alpha.test.ts"), "import { test } from \"bun:test\";\ntest(\"A 用例\", () => {});\n");
    fs.mkdirSync(path.join(WSE, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(WSE, "runtime", "flaky.jsonl"),
      JSON.stringify(run(1, [["tests/alpha.test.ts", "A 用例", false]])) + "\n" +
      JSON.stringify(run(2, [["tests/alpha.test.ts", "A 用例", false]])) + "\n");
  });
  afterEach(() => fs.rmSync(WSE, { recursive: true, force: true }));

  test("retest_plan 只读工具：计划生成（命令 + flaky 观测）不执行任何测试", () => {
    const fixture = path.join(TEST_RUN, "retest-fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({
      tracks: {
        "direct:notice-parser": [
          '<tool>{"name":"retest_plan","args":{"failed_only":true}}</tool>',
          "最终答案：重跑命令已生成，A 用例已连败 2 轮标记 flaky。",
        ],
      },
    }, null, 2));
    const out = path.join(TEST_RUN, "out-retest", "e2e");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WSE,
      "--task", "(direct) 生成失败用例的重跑计划",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "retest-e2e",
      ORG_ASK_QUESTION: "生成失败用例的重跑计划", ORG_TOOLS: "1",
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(results.length).toBe(1);
    const detail = JSON.stringify(results[0]);
    expect(detail).toContain("retest_plan ok");
    expect(detail).toContain("flaky=1"); // 观测摘要：台账 flaky 计数
    expect(detail).toContain("bun test tests/alpha.test.ts"); // 命令观测
    // 只读语义：台账未被改写（run 号仍是 2 —— plan 不记账）
    const { records } = readFlakyLedger(WSE);
    expect(records.length).toBe(2);
  }, 120_000);
});

// ---- 7. Web GET /api/govex/retest + 🔁 面板 ------------------------------------------

describe("retest：Web GET /api/govex/retest + 🔁 重跑面板", () => {
  test("plan/flaky 两动作（只读）+ 面板要素 + 本簇 JS 可解析", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    seedWorkspace(true);
    appendFlakyRecord(WS, run(1, [["tests/alpha.test.ts", "A 用例", false], ["tests/beta.test.ts", "B 用例", true]]));
    appendFlakyRecord(WS, run(2, [["tests/alpha.test.ts", "A 用例", false], ["tests/beta.test.ts", "B 用例", true]]));
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = async (u: string): Promise<any> => (await (await fetch(base + u)).json());

      // plan：--file 选择器 + 命令回显
      const plan = await get("/api/govex/retest?action=plan&file=beta*");
      expect(plan.ok).toBe(true);
      expect(plan.files).toEqual(["tests/beta.test.ts"]);
      expect(plan.command).toBe("bun test tests/beta.test.ts --timeout 120000");
      expect(plan.flaky_count).toBe(1);

      // plan：failed-only（台账最新一轮）
      const fo = await get("/api/govex/retest?action=plan&failed_only=1");
      expect(fo.ok).toBe(true);
      expect(fo.failed_names).toEqual(["A 用例"]);
      expect(fo.command).toContain("tests/alpha.test.ts");

      // plan：错误面（400 + discovered 观测）
      const miss = await fetch(base + "/api/govex/retest?action=plan&file=nope*");
      expect(miss.status).toBe(400);
      const mj = await miss.json();
      expect(mj.error).toContain("无命中");
      expect(mj.discovered).toBe(3);

      // flaky：台账汇总（runs/flaky/历史）
      const fl = await get("/api/govex/retest?action=flaky");
      expect(fl.ok).toBe(true);
      expect(fl.runs).toBe(2);
      expect(fl.flaky_count).toBe(1);
      const entry = fl.entries.find((e: any) => e.name === "A 用例");
      expect(entry.flaky).toBe(true);
      expect(entry.history).toEqual(["fail", "fail"]);

      // 未知 action 400
      const unk = await fetch(base + "/api/govex/retest?action=nope");
      expect(unk.status).toBe(400);

      // 面板要素 + 本簇 JS 独立可解析
      const html = await (await fetch(base + "/")).text();
      expect(html).toContain('id="gxSecRt"');
      expect(html).toContain('id="gxTabRt"');
      expect(html).toContain("/api/govex/retest?action=plan"); // 前端 fetch 带 query 的完整形态
      expect(html).toContain("gxRtPlan()");
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
      for (const fn of ["gxRtPlan", "gxRtFlaky"]) {
        const i = script.indexOf(`function ${fn}(`);
        expect(i).toBeGreaterThanOrEqual(0);
        const j2 = script.indexOf("\nfunction ", i + 1);
        const chunk = script.slice(i, j2 < 0 ? undefined : j2);
        expect(() => new Function(chunk)).not.toThrow();
      }
    } finally {
      srv.stop(true);
    }
  }, 60_000);
});
