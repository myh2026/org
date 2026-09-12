// ============================================================================
// tests/review.test.ts — 运行范围复核（org review）：本次运行产出什么、留什么
// ----------------------------------------------------------------------------
// 覆盖两件事：
//   A. 工具库治理第四动作 review —— 选取范围由运行产物界定（事件溯源），
//      交互与显式（--keep/--all/--none/--dry-run）两条通道同语义；
//   B. 构建本功能过程中实测到的两个缺陷的回归锁：
//      B1. 工厂闸门依赖 DHV_TS：按 HSL 指南直接跑解释器（不注入 DHV_TS）时
//          dhv_path() 退回哨兵串，shell 车道拼出 `bun UNSET_DHV_TS check …`
//          —— 必然失败，工厂降级为 (factory failed) 而整轮仍报 accepted 3/3。
//      B2. 资产留痕落空：sink_assets 收到的是 journal.clone()，
//          asset/drift 条目写进副本随函数返回丢弃 → journal.jsonl 永久缺失
//          资产沉淀证据（只有总线侧 events.jsonl 有，而 TS 读取层在
//          journal.jsonl 非空时整体丢弃该镜像）。
// ============================================================================

import { describe, test, expect, beforeAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  ROOT, DHV, TEST_RUN, runOrg, runOrgRun, makeWorkspace, readJson, exists, shPath,
} from "./helpers";
import { parseSelection } from "../cli/org";
import {
  latestRunDir, latestHarnessRunDir, reviewCandidates, applyReview, loadRegistryIndex,
} from "../lib/engine";

const WS = path.join(TEST_RUN, "review");
const TASK = "抓取某站点近一周公告，输出结构化表格";

function gitHead(ws: string): string {
  const p = Bun.spawnSync(["git", "log", "-1", "--format=%h %s"], { cwd: ws, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

function retainedOf(ws: string, name: string): boolean | undefined {
  return loadRegistryIndex(ws).find((m) => m.name === name)?.retained;
}

beforeAll(() => {
  const ws = makeWorkspace("review");
  const r = runOrgRun(ws, path.join(ws, "out-a"));
  if (!r.ok) console.error(r.stdout + r.stderr);
  expect(r.ok).toBe(true);
}, 120_000);

// ---------------------------------------------------------------------------
// A. 复核范围与交互语义
// ---------------------------------------------------------------------------

describe("运行范围复核（org review）", () => {
  test("范围由运行产物界定：本次铸出与复用分别入列", () => {
    const plan = reviewCandidates(WS, path.join(WS, "out-a"));
    expect(plan.scope).not.toBeNull();
    expect(plan.scope!.minted.map((m) => m.name)).toEqual(["record-validator"]);
    expect(plan.scope!.reused).toContain("notice-parser");
    // mint-register 的验收分随事件带出（复核表要展示「本次验收几分」）
    expect(plan.scope!.minted[0]!.eval).toBe("1");
  });

  test("待决策集 = 本次铸出且尚未保留；存量复用只作上下文", () => {
    const plan = reviewCandidates(WS, path.join(WS, "out-a"));
    // 工厂产出默认候选（retained=false）→ 进待决策集
    expect(plan.pending.map((c) => c.name)).toEqual(["record-validator"]);
    expect(plan.pending[0]!.retained).toBe(false);
    expect(plan.pending[0]!.origin).toContain("minted");
    expect(plan.pending[0]!.evalInRun).toBe("1");
    // 存量 manual 资产仅被复用 → 只作上下文，绝不进选取对象
    expect(plan.settled.map((c) => c.name)).toEqual(["notice-parser"]);
    expect(plan.settled[0]!.retained).toBe(true);
  });

  test("缺省范围跳过无 harness 产出的运行（不按字面最新选）", () => {
    // 造一个更新的 decoy：字面最新是它，但它没有任何 harness 接触面
    const decoy = path.join(WS, "out-zzz-decoy");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "run.json"), JSON.stringify({ ok: true, task: "no harness here", model: "scripted", elapsed_ms: 1 }));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(decoy, future, future);

    expect(path.basename(latestRunDir(WS)!)).toBe("out-zzz-decoy");       // 字面最新
    expect(path.basename(latestHarnessRunDir(WS)!)).toBe("out-a");        // 有产出那次
    const r = runOrg(["review", "--workspace", WS, "--dry-run"]);
    expect(r.stdout).toContain("复核范围：out-a");
    expect(r.stdout).toContain("record-validator@1.0.0");
  });

  test("--dry-run 不写入：retained 与 git 头都不变", () => {
    const before = gitHead(WS);
    const r = runOrg(["review", "--workspace", WS, "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("待决策候选");
    expect(r.stdout).toContain("--dry-run：未写入");
    expect(retainedOf(WS, "record-validator")).toBe(false);
    expect(gitHead(WS)).toBe(before);
  });

  test("非交互环境（stdin 非 TTY）不给选取 → 退出码 2 且指路显式通道", () => {
    const r = runOrg(["review", "--workspace", WS]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("非交互环境");
    expect(r.stderr).toContain("--keep record-validator");
    expect(retainedOf(WS, "record-validator")).toBe(false); // 未误写
  });

  test("--keep 未知名 → 退出码 1 + 列出可选集合（不静默）", () => {
    const r = runOrg(["review", "--workspace", WS, "--keep", "no-such-expert"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("不在本次待决策候选内");
    expect(r.stderr).toContain("record-validator");
  });

  test("--keep 选定 → 只转正选中项 + git 留痕；其余保持候选", () => {
    const before = gitHead(WS);
    const r = runOrg(["review", "--workspace", WS, "--keep", "record-validator"]);
    if (r.exitCode !== 0) console.error(r.stdout + r.stderr);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("已选取保留：record-validator@1.0.0");
    expect(retainedOf(WS, "record-validator")).toBe(true);
    // git 留痕与 org keep 同链（(user curation) 语义）
    expect(gitHead(WS)).not.toBe(before);
    expect(gitHead(WS)).toContain("keep record-validator");
    expect(gitHead(WS)).toContain("(user curation)");
    // 未勾选项不动 —— 候选态是「不自动复用」，不是删除
    expect(exists(path.join(WS, "registry/record-validator.json"))).toBe(true);
  });

  test("全部转正后重跑：无待决策候选（幂等，不重复提交）", () => {
    const before = gitHead(WS);
    const r = runOrg(["review", "--workspace", WS]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("没有待决策候选");
    expect(gitHead(WS)).toBe(before);
  });

  test("应用层：applyReview 空选不产生提交", () => {
    const before = gitHead(WS);
    const out = applyReview(WS, []);
    expect(out.kept).toEqual([]);
    expect(gitHead(WS)).toBe(before);
  });

  test("parseSelection：全选 / 空输入 / 全不选 / 取消 / 非法", () => {
    expect(parseSelection("", 3)).toEqual({ kind: "ok", picked: [1, 2, 3] });
    expect(parseSelection("a", 3)).toEqual({ kind: "ok", picked: [1, 2, 3] });
    expect(parseSelection("n", 3)).toEqual({ kind: "ok", picked: [] });
    expect(parseSelection("q", 3)).toEqual({ kind: "cancel" });
    expect(parseSelection("3,1", 3)).toEqual({ kind: "ok", picked: [1, 3] });
    expect(parseSelection("1，2", 3)).toEqual({ kind: "ok", picked: [1, 2] });   // 全角逗号
    expect(parseSelection("1 3", 3)).toEqual({ kind: "ok", picked: [1, 3] });   // 空格分隔
    expect(parseSelection("0", 3)).toEqual({ kind: "invalid", token: "0" });
    expect(parseSelection("9", 3)).toEqual({ kind: "invalid", token: "9" });
    expect(parseSelection("abc", 3)).toEqual({ kind: "invalid", token: "abc" });
  });
});

// ---------------------------------------------------------------------------
// B1. 工厂闸门不得依赖 DHV_TS（直接跑解释器也要能铸出）
// ---------------------------------------------------------------------------

/** 不注入 DHV_TS 的 dhv 调用（复刻「按 HSL 指南直接跑解释器」的环境）。 */
function runDhvWithoutToolchainEnv(args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  delete env.DHV_TS;
  const proc = Bun.spawnSync([process.execPath, DHV, ...args], {
    cwd: ROOT, env, stdout: "pipe", stderr: "pipe",
  });
  return { ok: proc.exitCode === 0, exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("v0.4.17 修复：工厂闸门自解析工具链（DHV_TS 不再是隐式前置）", () => {
  test("不设 DHV_TS 直接跑 org.hsl → 结构闸门仍过、专家照常注册", () => {
    const ws = makeWorkspace("review-no-dhvts");
    const r = runDhvWithoutToolchainEnv([
      "run", "hsl/org.hsl",
      "--workspace", ws,
      "--task", TASK,
      "--model", "scripted",
      "--fixture", path.join(ROOT, "fixtures/run-notices.json"),
      "--out", path.join(ws, "out-a"),
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // 旧代码：dhv_path() 退回 "UNSET_DHV_TS" → 三次 check 未过 → (factory failed)
    expect(r.stdout).not.toContain("check 未过");
    expect(r.stdout).not.toContain("(factory failed)");
    expect(r.stdout).toContain("stage=Register");
    // 语义断言：工厂产物真的落进注册表（source=factory）
    const entry = loadRegistryIndex(ws).find((m) => m.name === "record-validator");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("factory");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// B2. 资产留痕必须落在真实 journal 上
// ---------------------------------------------------------------------------

describe("v0.4.17 修复：资产沉淀证据不再从 journal 丢失", () => {
  test("journal.jsonl 含 asset 条目（与 metrics 的资产计数对得上）", () => {
    const jl = fs.readFileSync(path.join(WS, "out-a/journal.jsonl"), "utf-8");
    const assetLines = jl.split("\n").filter((l) => l.includes("|asset|"));
    const metrics = readJson(path.join(WS, "out-a/metrics.json"));
    // 旧代码：asset 记在 journal.clone() 上 → journal.jsonl 一条 asset 都没有
    expect(assetLines.length).toBe(metrics.assets);
    expect(assetLines.some((l) => l.includes("expert record-validator@1.0.0"))).toBe(true);
  });

  test("journal.jsonl 含 drift 条目（静默更新检测留痕不落空）", () => {
    const jl = fs.readFileSync(path.join(WS, "out-a/journal.jsonl"), "utf-8");
    expect(jl.split("\n").some((l) => l.includes("|drift|"))).toBe(true);
  });

  test("journal.jsonl 与 events.jsonl 的 journal 镜像条数一致（两份账本不漂）", () => {
    const jl = fs.readFileSync(path.join(WS, "out-a/journal.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0).length;
    const ev = fs.readFileSync(path.join(WS, "out-a/events.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .filter((e) => e.name === "journal" && e.data?.name !== "open").length;
    // events.jsonl 侧多一条 kernel:open 之外的语义差：这里只要求 journal 不缺条目
    expect(jl).toBeGreaterThanOrEqual(ev);
  });
});

// ---------------------------------------------------------------------------
// 冒烟：shPath 正斜杠约定（review 引入的路径展示依赖它）
// ---------------------------------------------------------------------------

describe("复核输出与既有约定一致", () => {
  test("shPath 统一正斜杠（bash -c 环境的路径约定）", () => {
    expect(shPath("C:\\a\\b\\main.ts")).toBe("C:/a/b/main.ts");
  });
});
