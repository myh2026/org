// ============================================================================
// tests/degrade.test.ts — 多重优雅降级 + 空壳工作区修复回归（v0.5.7）
// ----------------------------------------------------------------------------
// QA 实测（agent-browser 驱动 Web GUI）发现的两个真 bug：
//
//  Bug-B（根因）：org web 启动即内嵌任务执行器，TaskRunner.acquireLock 会
//  mkdirSync <ws>/runtime/tasks —— demo-run 以「只含 runtime/ 的空壳」存在，
//  骗过 ensureWorkspace 的存在性检查（fs.existsSync → return），demo-ws 模板
//  从未复制：工作区缺 raw/ 物料与 registry 模板。首个 ask 的 parse 子任务
//  路由 C:generate 现场铸专家 → 空载荷过不了 minted 专家自身闸门 → 硬 Err
//  炸穿整次 run（Web GUI 显示「结束（Err）」）。
//
//  Bug-A（炸半径）：嵌套专家执行失败（Reuse/Generate/WarmHandoff 三路）此前
//  一律 `return Err` 硬失败 —— v0.4.12 只给「工厂 mint 失败」加了降级，铸出来
//  的专家自己跑挂时监督回路根本没机会接管。
//
// v0.5.7 修复口径：
//  ① ensureWorkspace 标记物判据：registry/ · raw/ · .git 全缺 = 空壳 → 补模板
//    （cpSync 合并语义，runtime/ 不受影响；lib/engine.ts 与 cli/org.ts 双份同构）
//  ② 嵌套专家执行失败 → 失败报告（coverage 0 + *-run-failed 标注 + remedy
//    提示）交监督回路：客观覆盖线 Revise → 有界返工（DEFAULT_MAX_REVISES=2）
//    → 耗尽强制收货（accepted with flags）→ aggregate 摘要可见 → run ok=true
//
// 场景：
//   T1 空壳修复（单元）：runtime/ 空壳 → ensureWorkspace 补模板且保留 runtime/
//   T2 GUI 场景（端到端）：空壳工作区首问 → 模板补全 → parse 走 B:reuse（不再
//      C:generate 铸专家）→ run ok=true（QA 复现场景全绿）
//   T3 mint 降级链：域外使命 + 空注册表 + 无物料 → mint-run-failed 降级 →
//      有界返工 → 强制收货 → run ok=true + 事件留痕诚实
// ============================================================================
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspace, runOrg, runOrgRun, eventsOf, TEST_RUN, ROOT } from "./helpers";
import { ensureWorkspace } from "../lib/engine.ts";

/** journal 事件的 (node, detail) 提取。 */
function journalEntries(outDir: string): Array<{ node: string; detail: string }> {
  return eventsOf(outDir)
    .filter((e) => e.name === "journal")
    .map((e) => ({ node: String(e.data?.name ?? ""), detail: String(e.data?.detail ?? "") }));
}

/** 构造 TaskRunner 留下的空壳工作区（只含 runtime/tasks —— GUI 启动即如此）。 */
function bareWorkspace(name: string): string {
  const ws = path.join(TEST_RUN, name);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, "runtime", "tasks"), { recursive: true });
  return ws;
}

describe("v0.5.7 空壳工作区修复（ensureWorkspace 标记物判据）", () => {
  test("T1 runtime/ 空壳 → 补模板（registry/raw 就位）且 runtime/ 原样保留", () => {
    const ws = bareWorkspace("degrade-bare");
    ensureWorkspace(ws);
    // 模板三件套就位
    expect(fs.existsSync(path.join(ws, "registry", "index.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "raw", "notices.txt"))).toBe(true);
    // 空壳残留不被清除（任务队列不丢）
    expect(fs.existsSync(path.join(ws, "runtime", "tasks"))).toBe(true);
    // 已初始化工作区不被二次触碰（幂等）
    const before = fs.statSync(path.join(ws, "registry", "index.json")).mtimeMs;
    ensureWorkspace(ws);
    const after = fs.statSync(path.join(ws, "registry", "index.json")).mtimeMs;
    expect(after).toBe(before);
  });

  test("T2 GUI 复现场景（端到端）：空壳工作区首问不再 Err，parse 走 B:reuse", () => {
    const ws = bareWorkspace("degrade-gui-repro");
    const out = path.join(ws, "out-t2");
    // v0.5.10 起域外任务（原用例「请创作一首古典风格的卡农」）在 CLI 桥层
    // 被语义地板拦截改道（reroute 直连 composer）—— 那是 rescue.test.ts 的
    // 领地；本用例的意图是「空壳修复 → 模板补全 → parse 复用」，用域内任务。
    const r = runOrg([
      "run", "--task", "抓取近一周公告并输出表格",
      "--workspace", ws, "--out", out,
    ]);
    // 修复前：ok=false（minted 专家执行失败 → 硬 Err 炸穿 run）
    expect(r.ok).toBe(true);

    const routes = journalEntries(out).filter((j) => j.node === "route");
    // 模板补全后 notice-parser 在岗：parse 复用而非现场铸专家
    const parseRoute = routes.find((j) => j.detail.includes("parse ->"));
    expect(parseRoute).toBeDefined();
    expect(parseRoute!.detail).toContain("B:reuse");
    expect(parseRoute!.detail).not.toContain("C:generate");

    // 降级路径零触发（工作区修复后根本走不到 mint 失败）
    const fails = journalEntries(out).filter((j) =>
      j.detail.includes("run-failed"));
    expect(fails.length).toBe(0);
  });
});

describe("v0.5.7 多重优雅降级：嵌套专家执行失败不炸整次 run", () => {
  /** 域外使命的降级复现床：模板工作区 → 摘除物料与注册表（GUI 空壳的等价运行时态）。 */
  function degradedWorkspace(name: string): string {
    const ws = makeWorkspace(name);
    fs.rmSync(path.join(ws, "raw"), { recursive: true, force: true });
    fs.writeFileSync(path.join(ws, "registry", "index.json"), "[]");
    return ws;
  }

  test("T3 mint-run-failed 降级全链：失败报告 → 有界返工 → 强制收货 → run ok=true", () => {
    const ws = degradedWorkspace("degrade-mint");
    const out = path.join(ws, "out-t3");
    const r = runOrgRun(ws, out, {}, "请创作一首古典风格的卡农");
    // 修复前：ok=false，error="minted 专家执行失败：…payload 不含任何记录…"
    expect(r.ok).toBe(true);

    const journal = journalEntries(out);
    // ① 降级事件留痕（可观测性：不静默吞失败）—— journal.log(node, 事件名, 详情)
    //   落进 events.jsonl 的 data.name = 事件名（如 mint-run-failed）
    const mintFailed = journal.filter((j) => j.node === "mint-run-failed");
    expect(mintFailed.length).toBeGreaterThanOrEqual(1);
    // ② 监督回路确实接管：coverage 0 → Revise → 有界返工
    const redispatch = journal.filter((j) => j.node === "re-dispatch");
    expect(redispatch.length).toBeGreaterThanOrEqual(1);
    // ③ 返工有界（每子任务 DEFAULT_MAX_REVISES=2 → 「revise #N」的 N ≤ 2，防活锁）
    const reviseNums = redispatch
      .map((j) => /revise #(\d+)/.exec(j.detail)?.[1] ?? "0")
      .map(Number);
    expect(Math.max(...reviseNums)).toBeLessThanOrEqual(2);
    // ④ 审查留痕（失败报告被真实裁决过，不是绕过监督）
    const reviews = journal.filter((j) => j.node === "review" && j.detail.includes("verdict="));
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    // ⑤ run.json 语义收口 + 摘要诚实（失败交付物可见，不编造）
    const runJson = JSON.parse(fs.readFileSync(path.join(out, "run.json"), "utf-8"));
    expect(runJson.ok).toBe(true);
    const report = fs.readFileSync(path.join(out, "report.md"), "utf-8");
    expect(report).toContain("(minted run failed)");
  });
});
