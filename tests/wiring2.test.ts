// ============================================================================
// tests/wiring2.test.ts — v0.5.16 治理与扩展批：统一接线 e2e
// ----------------------------------------------------------------------------
// 覆盖（CLI / 工具环 / Web 三端冒烟 + RBAC 门控行为矩阵）：
//   1. RBAC 可选门控（ORG_RBAC_ROLE）：
//      a. 未设 → 门控完全不启用（工具照常执行，零行为回归）
//      b. observer（DEFAULT 模板 deny:["*"]）→ fs_read 被拒 + 拒绝文案含
//         rule 与 reason + journal rbac_denied 审计事件 + runtime/rbac.jsonl
//         决策账本（单行 JSONL 可 parse）
//      c. dev（allow tool:fs_*）→ fs_read 放行（前缀通配命中）
//   2. 工具环新工具 e2e（scripted 剧本驱动，直连车道全链）：
//      db_diagnose（:memory: setup 播种 + 计划解析可观测）/ iac_scan
//      （播种 Dockerfile → 命中可观测）/ openapi_parse（操作清单可观测）/
//      rename_symbol（dryRun 预览不落盘）/ git_merge（真 git 仓合并可观测）
//   3. CLI 冒烟：rbac check 双态退出码 / dbdiag --setup / plugin list /
//      openapi / complete / rename 预览 / browser status（引擎探测输出，
//      退出码随环境 0/1 皆合法 —— 引擎缺席是诚实降级不是失败）
//   4. Web 🛡 治理面板 /api/govex/*：11 端点全通 + 越界拒绝 + 写语句拒绝
//      + 插件安装/移除周期 + rename apply 真写
//
// 端到端用例逐例 120s 超时（B-15 纪律）。
// ============================================================================

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, runDhv, runOrg, eventsOf } from "./helpers";
import { DEFAULT_RBAC_POLICY } from "../lib/rbac.ts";

const WS_ROOT = path.join(TEST_RUN, "wiring2-ws");
let WS = ""; // beforeEach 注入唯一子目录（v0.5.15 纪律：跨用例零删除，Windows 句柄滞后不炸）
let wsSeq = 0;
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

beforeEach(() => {
  WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
  fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
});

afterAll(() => {
  // best-effort：Windows 句柄滞后不炸（唯一子目录已自然隔离）
  try { fs.rmSync(WS_ROOT, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
});

function makeOut(name: string): string {
  const dir = path.join(TEST_RUN, "out-wiring2", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造 direct 专用剧本。 */
function makeFixture(tracks: Record<string, string[]>): string {
  const file = path.join(TEST_RUN, `wiring2-fixture-${wsSeq}.json`);
  fs.writeFileSync(file, JSON.stringify({ tracks }, null, 2));
  return file;
}

/** 直连一轮（带工具环 env）。 */
function askOnce(fixture: string, out: string, env: Record<string, string> = {}): { ok: boolean; stdout: string } {
  return runDhv([
    "run", DIRECT,
    "--workspace", WS,
    "--task", "(direct) 接线测试",
    "--model", "scripted",
    "--fixture", fixture,
    "--out", out,
    "--allow", "bun,node,ls,cat,grep,diff,git",
  ], {
    ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "wiring2", ORG_ASK_QUESTION: "接线测试",
    ORG_TOOLS: "write", ORG_APPROVAL: "1",
    ...env,
  });
}

/** 从 events 里提取全部 tool_result 的 data.detail。 */
function toolResults(out: string): string[] {
  const events = eventsOf(out);
  return events
    .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
    .map((e) => String((e.data as { detail?: string }).detail ?? ""));
}

// ---- 1. RBAC 可选门控（ORG_RBAC_ROLE 开关行为矩阵） ----------------------------

describe("v0.5.16 RBAC 可选门控（execute_tool 分发处）", () => {
  test("未设 ORG_RBAC_ROLE → 门控完全不启用（fs_read 照常执行，零行为回归）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_read","args":{"path":"raw/notices.txt"}}</tool>',
        "最终答案：读取完成。",
      ],
    });
    const out = makeOut("rbac-off");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("fs_read ok"); // 未被 RBAC 拦
    // 无 rbac_denied 事件 + 无决策账本（门控完全静默）
    const events = eventsOf(out);
    expect(events.some((e) => e.name === "journal" && (e.data as { name?: string })?.name === "rbac_denied")).toBe(false);
    expect(fs.existsSync(path.join(WS, "runtime", "rbac.jsonl"))).toBe(false);
  }, 120_000);

  test("ORG_RBAC_ROLE=observer（deny:*）→ fs_read 被拒 + rule/reason + 双审计落盘", () => {
    // 播种 DEFAULT_RBAC_POLICY 模板（observer 的 deny:["*"] 按拒绝优先语义生效）
    fs.mkdirSync(path.join(WS, ".org"), { recursive: true });
    fs.writeFileSync(path.join(WS, ".org", "rbac.json"), JSON.stringify(DEFAULT_RBAC_POLICY));
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_read","args":{"path":"raw/notices.txt"}}</tool>',
        "最终答案：被拒。",
      ],
    });
    const out = makeOut("rbac-observer");
    const r = askOnce(fixture, out, { ORG_RBAC_ROLE: "observer" });
    expect(r.ok).toBe(true);
    // 工具结果 = DENIED (RBAC)（json_ok 包裹：ok:false + content 文案）
    const events = eventsOf(out);
    const denied = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_denied");
    expect(denied.length).toBe(1);
    // 审计 ①：journal rbac_denied 事件（含 action + rule）
    const rbacEvents = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "rbac_denied");
    expect(rbacEvents.length).toBe(1);
    const detail = String((rbacEvents[0]!.data as { detail?: string }).detail ?? "");
    expect(detail).toContain("tool:fs_read");
    expect(detail).toContain("deny:*");
    // 审计 ②：runtime/rbac.jsonl 决策账本（单行 JSONL 可 parse 往返）
    const ledger = fs.readFileSync(path.join(WS, "runtime", "rbac.jsonl"), "utf8").trim().split("\n");
    expect(ledger.length).toBe(1);
    const entry = JSON.parse(ledger[0]!) as { allowed: boolean; role: string; action: string; rule: string; reason: string; ts: string };
    expect(entry.allowed).toBe(false);
    expect(entry.role).toBe("observer");
    expect(entry.action).toBe("tool:fs_read");
    expect(entry.rule).toBe("deny:*");
    expect(entry.reason).toContain("deny 优先");
    expect(typeof entry.ts).toBe("string");
  }, 120_000);

  test("ORG_RBAC_ROLE=dev（allow tool:fs_* 前缀通配）→ fs_read 放行", () => {
    fs.mkdirSync(path.join(WS, ".org"), { recursive: true });
    fs.writeFileSync(path.join(WS, ".org", "rbac.json"), JSON.stringify({
      roles: { dev: { allow: ["tool:fs_*"], deny: [] } },
    }));
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_read","args":{"path":"raw/notices.txt"}}</tool>',
        "最终答案：放行。",
      ],
    });
    const out = makeOut("rbac-dev");
    const r = askOnce(fixture, out, { ORG_RBAC_ROLE: "dev" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("fs_read ok");
    // 放行静默：无 rbac_denied、无账本
    const events = eventsOf(out);
    expect(events.some((e) => e.name === "journal" && (e.data as { name?: string })?.name === "rbac_denied")).toBe(false);
  }, 120_000);
});

// ---- 2. 工具环新工具 e2e（scripted 剧本驱动） -----------------------------------

describe("v0.5.16 工具环新工具 e2e", () => {
  test("db_diagnose：:memory: setup 播种 + EQP 计划解析可观测（#113）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"db_diagnose","args":{"file":":memory:","sql":"SELECT b FROM t WHERE a = 2","setup":"CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT); INSERT INTO t VALUES (1,\'x\'),(2,\'y\');"}}</tool>',
        "最终答案：走主键索引。",
      ],
    });
    const out = makeOut("db-diagnose");
    const r = askOnce(fixture, out, { ORG_TOOLS: "1" }); // 只读模式也可用
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("steps=1");
    expect(tr[0]).toContain("tables=t");
    expect(tr[0]).not.toContain("全表扫描"); // INTEGER PRIMARY KEY 命中
  }, 120_000);

  test("iac_scan：播种 Dockerfile → 命中可观测（#147）", () => {
    fs.mkdirSync(path.join(WS, "deploy"), { recursive: true });
    fs.writeFileSync(path.join(WS, "deploy", "Dockerfile"), "FROM ubuntu:latest\nUSER root\nRUN apt-get update && apt-get install -y curl\n");
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"iac_scan","args":{}}</tool>',
        "最终答案：有高危。",
      ],
    });
    const out = makeOut("iac-scan");
    const r = askOnce(fixture, out, { ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("hits=");
    // USER root=high；:latest=medium；apt 未瘦身=low（high 只有 1 条 —— :latest 不是 high）
    expect(Number(tr[0]!.match(/high=(\d+)/)?.[1] ?? "0")).toBeGreaterThanOrEqual(1);
    expect(Number(tr[0]!.match(/hits=(\d+)/)?.[1] ?? "0")).toBeGreaterThanOrEqual(3);
    expect(tr[0]).toContain("deploy/Dockerfile"); // top= 命中路径可观测
  }, 120_000);

  test("openapi_parse + complete_at：操作清单与补全候选可观测（#134/#32）", () => {
    fs.writeFileSync(path.join(WS, "api.json"), JSON.stringify({
      openapi: "3.0.3", info: { title: "Demo API", version: "1.0.0" },
      paths: { "/pets": { get: { operationId: "listPets", responses: {} } } },
    }));
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 2 }\n");
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"openapi_parse","args":{"file":"api.json"}}</tool>',
        '<tool>{"name":"complete_at","args":{"file":"src/app.hsl","line_text":"fn com","column":6}}</tool>',
        "最终答案：1 个操作，补全命中 compute。",
      ],
    });
    const out = makeOut("openapi-complete");
    const r = askOnce(fixture, out, { ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(2);
    expect(tr[0]).toContain("1 操作");
    expect(tr[0]).toContain("3.0.3");
    expect(tr[0]).toContain("Demo API");
    expect(tr[1]).toContain("1 候选");
    expect(tr[1]).toContain("prefix=com");
  }, 120_000);

  test("rename_symbol：dryRun 缺省预览不落盘（#56）+ git_merge 真合并（#80）", () => {
    // git 仓：main 先落 src/app.hsl（rename 要能找到定义），feature 改一行
    for (const args of [
      ["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"],
      ["git", "config", "user.name", "t"],
    ] as const) {
      Bun.spawnSync(args as unknown as string[], { cwd: WS, stdout: "ignore", stderr: "ignore" });
    }
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 2 }\n");
    for (const args of [
      ["git", "add", "-A"], ["git", "commit", "-qm", "init"], ["git", "checkout", "-q", "-b", "feature"],
    ] as const) {
      Bun.spawnSync(args as unknown as string[], { cwd: WS, stdout: "ignore", stderr: "ignore" });
    }
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 3 }\n");
    for (const args of [
      ["git", "add", "-A"], ["git", "commit", "-qm", "feat"], ["git", "checkout", "-q", "main"],
    ] as const) {
      Bun.spawnSync(args as unknown as string[], { cwd: WS, stdout: "ignore", stderr: "ignore" });
    }
    // 预置长期放行集（file_write —— rename_symbol/git_merge 同属 file_write 能力，tools2 同款）
    fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["file_write"] }));

    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"rename_symbol","args":{"old":"compute","new":"computeV2"}}</tool>',
        '<tool>{"name":"git_merge","args":{"source":"feature","no_ff":true,"message":"merge feature"}}</tool>',
        "最终答案：预览与合并完成。",
      ],
    });
    const out = makeOut("rename-merge");
    const r = askOnce(fixture, out); // 审批丝放行：rename 走缺省 dryRun，merge 真合并
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(2);
    // rename_symbol 缺省 dryRun：预览产出（edits 可观测）
    expect(tr[0]).toContain("dry-run");
    // git_merge 审批放行 → 真合并落历史（--no-ff 双亲提交）
    expect(tr[1]).toContain("git_merge ok");
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: WS, stdout: "pipe" });
    expect(log.stdout.toString()).toContain("merge feature");
    // 合并后拿到 feature 的改动（x*3），且旧名 compute 原样（rename 只是 dryRun 未落盘）
    const merged = fs.readFileSync(path.join(WS, "src", "app.hsl"), "utf8");
    expect(merged).toContain("x * 3");
    expect(merged).toContain("fn compute(");
    expect(merged).not.toContain("computeV2");
  }, 120_000);

  test("git_merge：审批放行 → 真合并落历史（#80 写半环）", () => {
    for (const args of [
      ["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"],
      ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "init"],
    ] as const) {
      Bun.spawnSync(args as unknown as string[], { cwd: WS, stdout: "ignore", stderr: "ignore" });
    }
    fs.writeFileSync(path.join(WS, "feature.txt"), "x");
    Bun.spawnSync(["git", "add", "-A"], { cwd: WS, stdout: "ignore" });
    Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: WS, stdout: "ignore" });
    Bun.spawnSync(["git", "checkout", "-q", "-b", "feature"], { cwd: WS, stdout: "ignore" });
    fs.writeFileSync(path.join(WS, "feature.txt"), "y");
    Bun.spawnSync(["git", "add", "-A"], { cwd: WS, stdout: "ignore" });
    Bun.spawnSync(["git", "commit", "-qm", "feat"], { cwd: WS, stdout: "ignore" });
    Bun.spawnSync(["git", "checkout", "-q", "main"], { cwd: WS, stdout: "ignore" });
    // 预置长期放行集（file_write）—— tools2 同款
    fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["file_write"] }));

    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"git_merge","args":{"source":"feature","no_ff":true,"message":"merge feature"}}</tool>',
        "最终答案：已合并。",
      ],
    });
    const out = makeOut("git-merge");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr[0]).toContain("git_merge ok");
    // 真合并落历史（--no-ff 双亲提交）
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: WS, stdout: "pipe" });
    expect(log.stdout.toString()).toContain("merge feature");
    expect(fs.readFileSync(path.join(WS, "feature.txt"), "utf8")).toBe("y");
  }, 120_000);
});

// ---- 3. CLI 冒烟（runOrg 真子进程） ---------------------------------------------

describe("v0.5.16 CLI 冒烟", () => {
  test("org rbac check：owner 放行 exit 0 / 未知角色拒绝 exit 1（fallback 策略）", () => {
    const ok = runOrg(["rbac", "check", "owner", "tool:fs_write"]);
    expect(ok.ok).toBe(true);
    expect(ok.stdout).toContain("放行");
    expect(ok.stdout).toContain("rule=allow:*");
    const bad = runOrg(["rbac", "check", "nobody", "tool:fs_write"]);
    expect(bad.ok).toBe(false); // exit 1
    expect(bad.stdout).toContain("拒绝");
    expect(bad.stdout).toContain("unknown-role");
  }, 120_000);

  test("org dbdiag :memory: --setup：EQP 计划 + 建议输出", () => {
    const r = runOrg(["dbdiag", ":memory:", "SELECT b FROM t WHERE a = 2", "--setup",
      "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT); INSERT INTO t VALUES (1,'x'),(2,'y');"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("查询计划");
    expect(r.stdout).toContain("INTEGER PRIMARY KEY");
    expect(r.stdout).toContain("涉及表：t");
  }, 120_000);

  test("org plugin list + org openapi + org complete + org rename（预览）", () => {
    // 工作区播种：api spec + 补全源 + 重命名目标
    fs.writeFileSync(path.join(WS, "api.json"), JSON.stringify({
      openapi: "3.0.3", info: { title: "Demo API", version: "1.0.0" },
      paths: { "/pets": { get: { operationId: "listPets", responses: {} } } },
    }));
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 2 }\n");

    const plug = runOrg(["plugin", "list", "--workspace", WS]);
    expect(plug.ok).toBe(true);
    expect(plug.stdout).toContain("插件清单");

    const oa = runOrg(["openapi", path.join(WS, "api.json")]);
    expect(oa.ok).toBe(true);
    expect(oa.stdout).toContain("Demo API");
    expect(oa.stdout).toContain("api_list_pets"); // suggestToolName

    const cpl = runOrg(["complete", "src/app.hsl", "1", "7", "--workspace", WS]);
    expect(cpl.ok).toBe(true);
    expect(cpl.stdout).toContain("compute"); // 项目符号候选

    const rn = runOrg(["rename", "compute", "computeV2", "--workspace", WS]);
    expect(rn.ok).toBe(true);
    expect(rn.stdout).toContain("dryRun 预览"); // 缺省预览
    expect(rn.stdout).toContain("src/app.hsl");
    // 预览不落盘
    expect(fs.readFileSync(path.join(WS, "src", "app.hsl"), "utf8")).toContain("fn compute(");
  }, 120_000);

  test("org browser status：引擎探测输出（引擎缺席退出 1 是诚实降级，非失败）", () => {
    const r = runOrg(["browser", "status"]);
    expect(r.stdout).toContain("浏览器引擎链");
    expect([0, 1]).toContain(r.exitCode); // 引擎在场 0 / 缺席 1（附安装指引）
  }, 120_000);
});

// ---- 4. Web 🛡 治理与扩展面板 API（/api/govex/*） -------------------------------

describe("Web 🛡 治理面板 API（/api/govex/*，11 端点）", () => {
  test("全端点通 + 越界拒绝 + 插件周期 + rename apply 真写", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    // 播种：IaC 语料 + 插件源 + rbac 策略 + api spec + 补全/重命名源 + git 仓
    fs.mkdirSync(path.join(WS, "deploy"), { recursive: true });
    fs.writeFileSync(path.join(WS, "deploy", "Dockerfile"), "FROM ubuntu:latest\nUSER root\n");
    fs.mkdirSync(path.join(WS, "mk-plugin"), { recursive: true });
    fs.writeFileSync(path.join(WS, "mk-plugin", "plugin.json"), JSON.stringify({
      name: "demo-plugin", version: "1.0.0", description: "演示", entry: "index.ts", permissions: ["tool:fs_read"],
    }));
    fs.writeFileSync(path.join(WS, "mk-plugin", "index.ts"), "export function run() { return 1; }\n");
    fs.mkdirSync(path.join(WS, ".org"), { recursive: true });
    fs.writeFileSync(path.join(WS, ".org", "rbac.json"), JSON.stringify(DEFAULT_RBAC_POLICY));
    fs.writeFileSync(path.join(WS, "api.json"), JSON.stringify({
      openapi: "3.0.3", info: { title: "Demo API", version: "1.0.0" },
      paths: { "/pets": { get: { operationId: "listPets", responses: {} } } },
    }));
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 2 }\n");

    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = async (u: string): Promise<Record<string, unknown>> => (await (await fetch(base + u)).json()) as Record<string, unknown>;
      const post = async (u: string, body: unknown): Promise<Record<string, unknown>> =>
        (await (await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

      // IaC 扫描（播种语料命中）
      const iac = await get("/api/govex/iacscan");
      expect(iac.ok).toBe(true);
      expect(Number(iac.rules)).toBe(16);
      expect(Number(iac.high)).toBeGreaterThanOrEqual(1); // USER root（:latest 是 medium 不是 high）
      expect(JSON.stringify(iac.hits)).toContain("deploy/Dockerfile");

      // RBAC 角色查看（播种策略）
      const rbac = await get("/api/govex/rbac");
      expect(rbac.ok).toBe(true);
      expect(JSON.stringify(rbac.roles)).toContain("observer");
      expect(String(rbac.policy_file)).toContain("rbac.json");

      // OpenAPI：文件 + 文本双形态
      const oa1 = await post("/api/govex/openapi", { file: "api.json" });
      expect(oa1.ok).toBe(true);
      expect(JSON.stringify(oa1.operations)).toContain("api_list_pets");
      const oa2 = await post("/api/govex/openapi", { text: JSON.stringify({ swagger: "2.0", info: { title: "S2", version: "0" }, paths: {}, definitions: {} }) });
      expect(oa2.ok).toBe(true);
      expect(oa2.version).toBe("2.0");
      const oaBad = await post("/api/govex/openapi", { text: "not-json" });
      expect(oaBad.ok).toBe(false);
      expect(oaBad.kind).toBe("syntax");
      const oaEsc = await post("/api/govex/openapi", { file: "../../etc/passwd" });
      expect(oaEsc.ok).toBe(false);
      expect(String(oaEsc.error)).toContain("越界");

      // 引擎探测 + 浏览器快照（协议拒绝面无条件可测）
      const engines = await get("/api/govex/engines");
      expect(engines.ok).toBe(true);
      const snap = await post("/api/govex/browser-snapshot", { url: "file:///etc/passwd" });
      expect(snap.ok).toBe(false);
      expect(snap.kind).toBe("denied");

      // dbdiag：:memory: + 越界拒绝
      const dbd = await post("/api/govex/dbdiag", { file: ":memory:", sql: "SELECT * FROM t", setup: "CREATE TABLE t(a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)" });
      expect(dbd.ok).toBe(true);
      expect(JSON.stringify(dbd.plan)).toContain("SCAN t");
      const dbdEsc = await post("/api/govex/dbdiag", { file: "../../etc/passwd", sql: "SELECT 1" });
      expect(dbdEsc.ok).toBe(false);

      // 补全（行号形态 → 服务端读盘取行）
      const cpl = await post("/api/govex/complete", { file: "src/app.hsl", line: 1, column: 7 });
      expect(cpl.ok).toBe(true);
      expect(JSON.stringify(cpl.candidates)).toContain("compute");

      // 插件周期：install → list → remove
      const inst = await post("/api/govex/plugin-install", { source: "mk-plugin" });
      expect(inst.ok).toBe(true);
      expect(inst.name).toBe("demo-plugin");
      const list = await get("/api/govex/plugins");
      expect(list.ok).toBe(true);
      expect(JSON.stringify(list.plugins)).toContain("demo-plugin");
      const rm = await post("/api/govex/plugin-remove", { name: "demo-plugin" });
      expect(rm.ok).toBe(true);
      expect(fs.existsSync(path.join(WS, ".org", "plugins", "demo-plugin"))).toBe(false);

      // rename：预览（不落盘）→ apply 真写
      const prev = await post("/api/govex/rename", { old: "compute", new: "computeX" });
      expect(prev.ok).toBe(true);
      expect(prev.dry_run).toBe(true);
      expect(fs.readFileSync(path.join(WS, "src", "app.hsl"), "utf8")).toContain("fn compute(");
      const apply = await post("/api/govex/rename", { old: "compute", new: "computeX", apply: true });
      expect(apply.ok).toBe(true);
      expect(apply.dry_run).toBe(false);
      expect(fs.readFileSync(path.join(WS, "src", "app.hsl"), "utf8")).toContain("fn computeX(");

      // git 状态（工作区非 git 仓 → 诚实 degraded，不炸）
      const git = await get("/api/govex/gitstate");
      expect(typeof git.ok).toBe("boolean");
      expect(git.state).toBeTruthy();
    } finally {
      srv.stop();
    }
  }, 120_000);

  test("GUI 单页含治理面板要素 + 内联脚本可解析（govexPane/govexBtn/CSS）", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    try {
      const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      expect(html).toContain('id="govexPane"');
      expect(html).toContain('id="govexBtn"');
      expect(html).toContain('id="govexScrim"');
      expect(html).toContain("#toolboxPane, #govexPane"); // v0.5.15 遗漏的面板 display CSS 已补
      expect(html).toContain('"/api/govex/iacscan"');
      // 内联脚本自洽（模板字面量转义层级的守卫 —— v0.5.15 踩过）
      const m = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(m).not.toBeNull();
      expect(() => new Function(m![1]!)).not.toThrow();
    } finally {
      srv.stop();
    }
  }, 60_000);
});
