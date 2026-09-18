// ============================================================================
// tests/tools2.test.ts — v0.5.15 桌面 Agent 补全批次：工具环扩展 e2e
// ----------------------------------------------------------------------------
// 覆盖（scripted 剧本驱动，直连车道全链）：
//   1. symbol_search（#20）：定义 + 引用清单
//   2. db_schema / db_query（#43/#73 只读半环）：schema 检查 + 查询 + 写语句只读门拒绝
//   3. db_migrate（#43/#73 写半环）：审批放行（granted.json 预置）→ 迁移落账
//      + dry_run 回滚不落盘
//   4. fs_write preview 干跑（#60）：返回 unified diff 不落盘
//   5. fs_write 密钥拦截（#141）：高危密钥拒绝落盘
//   6. fs_move（#52）：审批放行 → 真实移动 + 越界拒绝
//   7. db 路径监狱：工作区外的 .db 拒绝
//   8. read_pdf（#24）：引擎缺席优雅降级（无引擎环境 skip）
//   9. audit_export（#150）：审批放行 → zip 落盘
//  10. review_suggest（#85/#89）：CODEOWNERS 推荐
//
// 端到端用例逐例 120s 超时（B-15 纪律）。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, runDhv, eventsOf } from "./helpers";
import { pdfEngines } from "../lib/pdfread.ts";
import { Database } from "bun:sqlite";

const WS = path.join(TEST_RUN, "tools2-ws");
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
  // 预置长期放行集（file_write）—— 审批文件协议的 always 语义，
  // request_approval 命中 granted.json 缓存直接放行（不打扰测试流程）
  fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
  fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"),
    JSON.stringify({ capabilities: ["file_write"] }));
});

afterEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

function makeOut(name: string): string {
  const dir = path.join(TEST_RUN, "out-tools2", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造 direct 专用剧本。 */
function makeFixture(tracks: Record<string, string[]>): string {
  const file = path.join(TEST_RUN, "tools2-fixture.json");
  fs.writeFileSync(file, JSON.stringify({ tracks }, null, 2));
  return file;
}

/** 直连一轮（带工具环 env）。 */
function askOnce(fixture: string, out: string, env: Record<string, string> = {}): { ok: boolean; stdout: string } {
  return runDhv([
    "run", DIRECT,
    "--workspace", WS,
    "--task", "(direct) 工具测试",
    "--model", "scripted",
    "--fixture", fixture,
    "--out", out,
    "--allow", "bun,node,ls,cat,grep,diff,git",
  ], {
    ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools2", ORG_ASK_QUESTION: "工具测试",
    ORG_TOOLS: "write", ORG_APPROVAL: "1",
    ...env,
  });
}

/** 从 events 里提取最后一条 tool_result 的 data.detail（JSON 摘要行）。 */
function lastToolResult(out: string): string {
  const events = eventsOf(out);
  const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
  expect(results.length).toBeGreaterThanOrEqual(1);
  return String((results[results.length - 1]!.data as { detail?: string }).detail ?? "");
}

describe("v0.5.15 工具环扩展 e2e（scripted 剧本驱动）", () => {
  test("symbol_search：定义 + 引用（ReadOnly 模式可用）", () => {
    // 工作区播种一个带符号的源文件（demo-ws 无 .hsl 符号面 → 造一个）
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 2 }\n");
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"symbol_search","args":{"name":"compute","refs":true}}</tool>',
        "最终答案：compute 定义在 src/app.hsl。",
      ],
    });
    const out = makeOut("symbol");
    const r = askOnce(fixture, out, { ORG_TOOLS: "1" }); // 只读模式也可用
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("defs=1");
    expect(tr).toContain("src/app.hsl"); // top= 命中定义位置
  }, 120_000);

  test("db_schema + db_query：SQLite 只读查询（真库真查）", () => {
    // 工作区播种一个真实 SQLite 库（bun:sqlite 不建父目录 —— 先建）
    fs.mkdirSync(path.join(WS, "data"), { recursive: true });
    const db = new Database(path.join(WS, "data", "app.db"));
    db.exec("CREATE TABLE notices (id INTEGER PRIMARY KEY, title TEXT)");
    db.exec("INSERT INTO notices (title) VALUES ('审计制度修订'), ('业绩说明会')");
    db.close();
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"db_schema","args":{"file":"data/app.db"}}</tool>',
        '<tool>{"name":"db_query","args":{"file":"data/app.db","sql":"SELECT id, title FROM notices ORDER BY id"}}</tool>',
        "最终答案：2 条公告。最终答案：审计制度修订、业绩说明会。",
      ],
    });
    const out = makeOut("db-read");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(results.length).toBe(2);
    const schemaDetail = String((results[0]!.data as { detail?: string }).detail ?? "");
    const queryDetail = String((results[1]!.data as { detail?: string }).detail ?? "");
    expect(schemaDetail).toContain("notices"); // 表名可观测
    expect(queryDetail).toContain("rows=2");   // 行数可观测（数据面由 tests/db.test.ts 锁定）
  }, 120_000);

  test("db_query 只读门：DROP TABLE 被拒（双层门第一层）", () => {
    fs.mkdirSync(path.join(WS, "data"), { recursive: true });
    const db = new Database(path.join(WS, "data", "app.db"));
    db.exec("CREATE TABLE t (x INTEGER)");
    db.close();
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"db_query","args":{"file":"data/app.db","sql":"DROP TABLE t"}}</tool>',
        "最终答案：查询通道拒绝写语句 —— 应走 db_migrate。",
      ],
    });
    const out = makeOut("db-gate");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("[denied]"); // v0.5.15 摘要带 kind
    // 库还在：表未被破坏
    const db2 = new Database(path.join(WS, "data", "app.db"), { readonly: true });
    const names = db2.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    db2.close();
    expect(names.some((n) => n.name === "t")).toBe(true);
  }, 120_000);

  test("db_migrate：审批放行（granted 缓存）→ 版本账本 + dry_run 回滚", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"db_migrate","args":{"file":"data/app.db","name":"init","sql":"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"}}</tool>',
        '<tool>{"name":"db_migrate","args":{"file":"data/app.db","name":"dry","sql":"CREATE TABLE tmp (x INTEGER)","dry_run":true}}</tool>',
        "最终答案：迁移 v1 已落账，dry_run 已回滚。",
      ],
    });
    const out = makeOut("db-migrate");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const db = new Database(path.join(WS, "data", "app.db"), { readonly: true });
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    const ver = db.query("SELECT version, name FROM _org_migrations").all() as Array<{ version: number; name: string }>;
    db.close();
    expect(tables).toContain("users");
    expect(tables).not.toContain("tmp"); // dry_run 已回滚
    expect(ver.length).toBe(1);
    expect(ver[0]!.name).toBe("init");
    // 伴车迁移账本
    expect(fs.existsSync(path.join(WS, "data", "app.db.migrations.json"))).toBe(true);
  }, 120_000);

  test("db 路径监狱：工作区外的库拒绝", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"db_schema","args":{"file":"../../etc/passwd.db"}}</tool>',
        "最终答案：越界被拒。",
      ],
    });
    const out = makeOut("db-jail");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("越界");
  }, 120_000);

  test("fs_write preview：返回 unified diff 不落盘（#60 干跑）", () => {
    fs.writeFileSync(path.join(WS, "raw", "target.txt"), "alpha\nbeta\n");
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_write","args":{"path":"raw/target.txt","content":"alpha\\ngamma\\n","preview":true}}</tool>',
        "最终答案：预览显示 beta → gamma。",
      ],
    });
    const out = makeOut("preview");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("preview");           // 干跑模式可观测
    expect(tr).toContain("raw/target.txt");
    // 未落盘：内容原样（干跑的核心承诺）
    expect(fs.readFileSync(path.join(WS, "raw", "target.txt"), "utf-8")).toBe("alpha\nbeta\n");
  }, 120_000);

  test("fs_write 密钥拦截：高危密钥拒绝落盘（#141）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_write","args":{"path":"raw/leak.txt","content":"token = \\"sk-abcdefghijklmnopqrstuvwxyz123456\\"\\n"}}</tool>',
        "最终答案：写入被拒 —— 密钥不该落盘。",
      ],
    });
    const out = makeOut("secret");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("[secret_scan]");
    expect(fs.existsSync(path.join(WS, "raw", "leak.txt"))).toBe(false);
  }, 120_000);

  test("fs_write 密钥拦截逃生口：ORG_SCAN=off 放行", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_write","args":{"path":"raw/trusted.env","content":"token = \\"sk-abcdefghijklmnopqrstuvwxyz123456\\"\\n"}}</tool>',
        "最终答案：用户明示信任，已写入。",
      ],
    });
    const out = makeOut("scan-off");
    const r = askOnce(fixture, out, { ORG_SCAN: "off" });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(WS, "raw", "trusted.env"))).toBe(true);
  }, 120_000);

  test("fs_move：审批放行 → 真实移动 + 越界拒绝", () => {
    fs.writeFileSync(path.join(WS, "raw", "origin.txt"), "content");
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_move","args":{"from":"raw/origin.txt","to":"archive/moved.txt"}}</tool>',
        '<tool>{"name":"fs_move","args":{"from":"raw/notices.txt","to":"../escape.txt"}}</tool>',
        "最终答案：移动成功，越界被拒。",
      ],
    });
    const out = makeOut("move");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(WS, "archive", "moved.txt"))).toBe(true);
    expect(fs.existsSync(path.join(WS, "raw", "origin.txt"))).toBe(false);
    const events = eventsOf(out);
    const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(String((results[0]!.data as { detail?: string }).detail ?? "")).toContain("raw/origin.txt → archive/moved.txt");
    expect(String((results[1]!.data as { detail?: string }).detail ?? "")).toContain("越界");
  }, 120_000);

  test("audit_export：审批放行 → zip + 摘要落盘（#150）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"audit_export","args":{}}</tool>',
        "最终答案：审计已导出。",
      ],
    });
    const out = makeOut("audit");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const zips = fs.readdirSync(WS).filter((f) => f.startsWith("audit-export-") && f.endsWith(".zip"));
    expect(zips.length).toBe(1);
  }, 120_000);

  test("review_suggest：CODEOWNERS 推荐（#85/#89）", () => {
    fs.mkdirSync(path.join(WS, ".org"), { recursive: true });
    fs.writeFileSync(path.join(WS, ".org", "CODEOWNERS"), "raw/ @data-owner\nregistry/ @asset-owner\n");
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"review_suggest","args":{"files":["raw/notices.txt","registry/index.json"]}}</tool>',
        "最终答案：推荐 data-owner 与 asset-owner。",
      ],
    });
    const out = makeOut("owners");
    const r = askOnce(fixture, out, { ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("data-owner");
    expect(tr).toContain("asset-owner");
  }, 120_000);

  const pdfReady = pdfEngines().pdftotext || pdfEngines().uv;
  (pdfReady ? test : test.skip)("read_pdf：PDF 文本提取（引擎在场才跑）", () => {
    // 引擎在场：用 uv + fpdf 生成真 PDF（或 pdftotext 配套工具）—— 生成侧
    // 统一走 uv（本机/CI ubuntu 均有 uv 或 pdftotext 之一）
    const gen = Bun.spawnSync(["uv", "run", "--with", "fpdf", "python", "-c",
      "from fpdf import FPDF; p=FPDF(); p.add_page(); p.set_font('Helvetica', size=16); p.cell(200,10,'Hello ORG PDF', ln=True); p.output('pdf-out/ok.pdf')"],
      { cwd: TEST_RUN, stdout: "pipe", stderr: "pipe" });
    if (gen.exitCode !== 0) return; // 生成失败（离线环境）→ 本用例静默跳过语义
    fs.mkdirSync(path.join(WS, "docs"), { recursive: true });
    fs.copyFileSync(path.join(TEST_RUN, "pdf-out", "ok.pdf"), path.join(WS, "docs", "ok.pdf"));
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"read_pdf","args":{"file":"docs/ok.pdf"}}</tool>',
        "最终答案：PDF 内容是 Hello ORG PDF。",
      ],
    });
    const out = makeOut("pdf");
    const r = askOnce(fixture, out, { ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = lastToolResult(out);
    expect(tr).toContain("engine=");
    expect(tr).toContain("pages=1");
  }, 180_000);
});

// ---- Web 工具箱面板 API（v0.5.15：「每个功能都有对应操作页面」的 Web 面） ----

describe("Web 工具箱 API（/api/toolbox/*）", () => {
  test("七个端点全通 + 越界拒绝 + 写语句拒绝", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    // 播种：db + 符号源 + CODEOWNERS
    fs.mkdirSync(path.join(WS, "data"), { recursive: true });
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.hsl"), "fn compute(x: i32) -> i32 { x * 2 }\n");
    const db = new Database(path.join(WS, "data", "app.db"));
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42)");
    db.close();
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = async (u: string): Promise<Record<string, unknown>> => (await (await fetch(base + u)).json()) as Record<string, unknown>;
      const post = async (u: string, body: unknown): Promise<Record<string, unknown>> =>
        (await (await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

      const sym = await get("/api/toolbox/symbols?name=compute");
      expect(sym.ok).toBe(true);
      expect(JSON.stringify(sym.defs)).toContain("src/app.hsl");

      const scan = await get("/api/toolbox/scan");
      expect(scan.ok).toBe(true);
      expect(Number(scan.patterns)).toBeGreaterThanOrEqual(16);

      const sbom = await get("/api/toolbox/sbom");
      expect(sbom.ok).toBe(true);
      expect((sbom.packages as unknown[]).length).toBeGreaterThanOrEqual(2);

      const aud = await post("/api/toolbox/audit", {});
      expect(aud.ok).toBe(true);
      expect(String(aud.zip)).toContain("audit-export-");

      const sch = await get("/api/toolbox/db?file=data/app.db");
      expect(sch.ok).toBe(true);
      expect(JSON.stringify(sch.tables)).toContain("t");

      const q = await post("/api/toolbox/db-query", { file: "data/app.db", sql: "SELECT x FROM t" });
      expect(q.ok).toBe(true);
      expect(JSON.stringify(q.rows)).toContain("42");

      // 写语句拒绝（只读门）
      const qd = await post("/api/toolbox/db-query", { file: "data/app.db", sql: "DROP TABLE t" });
      expect(qd.ok).toBe(false);

      // 路径越界拒绝
      const esc = await get("/api/toolbox/db?file=../../etc/passwd");
      expect(esc.ok).toBe(false);

      const rev = await post("/api/toolbox/review", { files: ["src/app.hsl"] });
      expect(rev.ok).toBe(true);
    } finally {
      srv.stop();
    }
  }, 60_000);
});
