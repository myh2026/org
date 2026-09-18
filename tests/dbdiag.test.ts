// ============================================================================
// tests/dbdiag.test.ts — 数据库查询诊断器（v0.5.16 · capabilities #113）
// ----------------------------------------------------------------------------
// lib/dbdiag.ts 全覆盖（16 用例，全部显式 30s 超时）：
//   计划解析（5）：:memory: 索引命中 SEARCH / 无索引 WHERE → fullScan+建议 /
//                无 WHERE 全量提醒 / JOIN 两表计划步骤与 tables / ORDER BY
//                临时 B-树建议 + 全索引扫描建议
//   只读门（4）：写动词全家桶 denied / 非白名单前导词（PRAGMA/EXPLAIN）denied /
//                多语句拒（尾分号放行）/ 注释头注入拒（合法注释不误伤）
//   错误分型（4）：坏 SQL → syntax 附 SQLite 原始 message（no such table +
//                incomplete input）/ 缺失文件 → missing / 非库文件 → missing /
//                目录路径 → missing
//   播种与边界（3）：真实文件 e2e（tmp 建库 → readonly 诊断）/ setup 仅
//                :memory:（文件库 → denied）/ setup 坏 SQL → syntax + 常量
//                查询伪步骤不入 tables
// ============================================================================
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN } from "./helpers";
import { dbDiagnose, DBDIAG_LIMITS } from "../lib/dbdiag.ts";

const SCRATCH_ROOT = path.join(TEST_RUN, "dbdiag");
let SCRATCH = ""; // beforeEach 注入唯一子目录（v0.5.15 跨用例零删除教训：Windows 句柄滞后）
let scratchSeq = 0;

beforeEach(() => {
  SCRATCH = path.join(SCRATCH_ROOT, `t${String(++scratchSeq).padStart(3, "0")}`);
  fs.mkdirSync(SCRATCH, { recursive: true });
});

/** 诊断语料床：author/book 两表 + 两个索引（name / author_id）。 */
const LIBRARY_SQL = `
CREATE TABLE author(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INT);
CREATE TABLE book(id INTEGER PRIMARY KEY, author_id INT NOT NULL, title TEXT);
CREATE INDEX idx_author_name ON author(name);
CREATE INDEX idx_book_author ON book(author_id);
INSERT INTO author VALUES (1, '甲', 30), (2, '乙', 15), (3, '丙', 41);
INSERT INTO book VALUES (10, 1, '书一'), (11, 2, '书二');
`;

/** 建一个真实 .db 文件（测试自种数据 —— 不经过被测的门）。 */
function makeDb(rel: string, setupSql?: string): string {
  const file = path.join(SCRATCH, rel);
  const db = new Database(file);
  if (setupSql) db.exec(setupSql);
  db.close();
  return file;
}

/** 成功窄化：失败即抛（附完整错误体）。 */
async function mustOk(file: string, sql: string, opts?: { setup?: string }) {
  const r = await dbDiagnose(file, sql, opts);
  if (!r.ok) throw new Error(`预期 ok:true，得到：${JSON.stringify(r)}`);
  return r;
}

/** 失败断言：kind 精确匹配 + error 非空，返回 error 文本。 */
async function expectFail(file: string, sql: string, kind: string, opts?: { setup?: string }) {
  const r = await dbDiagnose(file, sql, opts);
  expect(r.ok).toBe(false);
  expect((r as { kind?: string }).kind).toBe(kind);
  const err = (r as { error?: string }).error!;
  expect(typeof err).toBe("string");
  expect(err.length).toBeGreaterThan(0);
  return err;
}

// ---- 1. 计划解析 ---------------------------------------------------------------

describe("dbdiag：计划解析", () => {
  test(":memory: 索引命中 → SEARCH + usesIndex + 无扫描建议", async () => {
    const r = await mustOk(":memory:", "SELECT * FROM author WHERE name = '甲'", { setup: LIBRARY_SQL });
    expect(r.plan.steps.length).toBeGreaterThan(0);
    expect(r.plan.steps[0]!.detail).toMatch(/^SEARCH author USING INDEX idx_author_name/);
    expect(r.plan.steps[0]!.usesIndex).toBe(true);
    expect(r.plan.tables).toEqual(["author"]);
    expect(r.plan.fullScan).toBe(false);
    expect(r.suggestions).toEqual([]); // 索引命中且带 WHERE —— 没有值得提醒的点
    expect(r.ms).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("无索引 WHERE（age 列）→ fullScan:true + 建索引建议", async () => {
    const r = await mustOk(":memory:", "SELECT * FROM author WHERE age > 18", { setup: LIBRARY_SQL });
    expect(r.plan.fullScan).toBe(true);
    expect(r.plan.steps[0]!.detail).toBe("SCAN author");
    expect(r.plan.steps[0]!.usesIndex).toBeUndefined();
    const s = r.suggestions.find((x) => x.includes("author"))!;
    expect(s).toContain("全表扫描");
    expect(s).toContain("建索引");
  }, 30_000);

  test("无 WHERE 全量读 → 「查询无 WHERE」建议；rowid 主键查找算索引命中", async () => {
    const r = await mustOk(":memory:", "SELECT * FROM author", { setup: LIBRARY_SQL });
    expect(r.plan.fullScan).toBe(true);
    expect(r.suggestions.some((x) => x.includes("查询无 WHERE"))).toBe(true);
    expect(r.suggestions.some((x) => x.includes("全表扫描"))).toBe(true);

    const r2 = await mustOk(":memory:", "SELECT * FROM author WHERE id = 1", { setup: LIBRARY_SQL });
    expect(r2.plan.fullScan).toBe(false);
    expect(r2.plan.steps[0]!.detail).toMatch(/SEARCH author USING INTEGER PRIMARY KEY/);
    expect(r2.plan.steps[0]!.usesIndex).toBe(true);
  }, 30_000);

  test("JOIN 两表：计划步骤 ≥2、两表入 tables（别名如实呈现）、双侧 SEARCH", async () => {
    const r = await mustOk(
      ":memory:",
      "SELECT b.title FROM book b JOIN author a ON a.id = b.author_id WHERE a.name = '甲'",
      { setup: LIBRARY_SQL },
    );
    expect(r.plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(r.plan.tables).toEqual(["a", "b"]); // EQP 报别名 —— 如实呈现（诚实边界）
    expect(r.plan.fullScan).toBe(false);
    expect(r.plan.steps.every((s) => s.usesIndex === true)).toBe(true);
    expect(r.suggestions).toEqual([]);
  }, 30_000);

  test("ORDER BY 无索引 → 临时 B-树建议；ORDER BY 有索引（覆盖扫描）→ 全索引扫描提醒而非全表扫", async () => {
    const r = await mustOk(":memory:", "SELECT * FROM author ORDER BY age", { setup: LIBRARY_SQL });
    expect(r.plan.steps.some((s) => /USE TEMP B-TREE FOR ORDER BY/.test(s.detail))).toBe(true);
    expect(r.suggestions.some((x) => x.includes("临时 B-树"))).toBe(true);

    // 覆盖索引全扫：SCAN … USING COVERING INDEX —— 不算 fullScan（比扫表便宜），但单独提醒
    const r2 = await mustOk(":memory:", "SELECT name FROM author ORDER BY name", { setup: LIBRARY_SQL });
    expect(r2.plan.fullScan).toBe(false);
    expect(r2.plan.steps[0]!.usesIndex).toBe(true);
    expect(r2.suggestions.some((x) => x.includes("全索引扫描"))).toBe(true);
  }, 30_000);
});

// ---- 2. 只读门 -------------------------------------------------------------------

describe("dbdiag：只读门", () => {
  test("写动词全家桶 denied（INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/ATTACH/VACUUM/REPLACE）", async () => {
    for (const sql of [
      "INSERT INTO author VALUES (9, '丁', 20)",
      "UPDATE author SET age = 1",
      "DELETE FROM author",
      "DROP TABLE author",
      "CREATE TABLE x(a)",
      "ALTER TABLE author ADD COLUMN z INT",
      "ATTACH DATABASE 'x.db' AS x",
      "VACUUM",
      "REPLACE INTO author VALUES (1, '甲', 30)",
      "TRUNCATE author",
    ]) {
      const err = await expectFail(":memory:", sql, "denied");
      expect(err).toContain("诊断门拒绝");
    }
  }, 30_000);

  test("非白名单前导词 denied：PRAGMA / EXPLAIN（EXPLAIN 由诊断器自己拼接）；WITH…INSERT 漏网写句收口", async () => {
    const e1 = await expectFail(":memory:", "PRAGMA table_info(author)", "denied");
    expect(e1).toContain("诊断白名单");
    const e2 = await expectFail(":memory:", "EXPLAIN QUERY PLAN SELECT 1", "denied");
    expect(e2).toContain("诊断白名单");
    // WITH…INSERT 前导词合法但骨架含写动词 → 词法层收口（诊断通道永不执行，
    // 词法门就是唯一边界；与 dbQuery 靠内核拦截的哲学差异见实现文件头）
    const e3 = await expectFail(":memory:", "WITH x AS (SELECT 1) INSERT INTO author VALUES (1,'a',1)", "denied");
    expect(e3).toContain("写语句不在诊断通道");
    // replace() 函数形态豁免（负向先行）—— 合法 SELECT 不误伤
    const okFn = await mustOk(":memory:", "SELECT replace(name, '甲', 'A') FROM author WHERE age > 1", { setup: LIBRARY_SQL });
    expect(okFn.plan.tables).toEqual(["author"]);
  }, 30_000);

  test("多语句拒（中置分号）；尾分号放行；字符串里的分号不误伤", async () => {
    await expectFail(":memory:", "SELECT 1; SELECT 2", "denied");
    const okTail = await mustOk(":memory:", "SELECT * FROM author WHERE name = '甲';", { setup: LIBRARY_SQL });
    expect(okTail.plan.tables).toEqual(["author"]);
    const okStr = await mustOk(":memory:", "SELECT * FROM author WHERE name = 'a;b'", { setup: LIBRARY_SQL });
    expect(okStr.ok).toBe(true);
  }, 30_000);

  test("注释头注入拒（剥注释后写动词现形）；合法注释不误伤", async () => {
    const err = await expectFail(":memory:", "-- harmless comment\nDROP TABLE author", "denied");
    expect(err).toContain("诊断门拒绝");
    const ok = await mustOk(
      ":memory:",
      "SELECT * FROM author -- 取全部作者\nWHERE name = '甲'",
      { setup: LIBRARY_SQL },
    );
    expect(ok.plan.tables).toEqual(["author"]);
    expect(ok.plan.fullScan).toBe(false);
  }, 30_000);
});

// ---- 3. 错误分型 -----------------------------------------------------------------

describe("dbdiag：错误分型", () => {
  test("坏 SQL → syntax 附 SQLite 原始 message（no such table / incomplete input）", async () => {
    const e1 = await expectFail(":memory:", "SELECT * FROM nope_table", "syntax", { setup: LIBRARY_SQL });
    expect(e1).toContain("no such table: nope_table"); // SQLite 原始 message 原样附上
    const e2 = await expectFail(":memory:", "SELECT * FROM author WHERE", "syntax", { setup: LIBRARY_SQL });
    expect(e2).toContain("incomplete input");
  }, 30_000);

  test("缺失文件 → missing（不自动建库）", async () => {
    const miss = path.join(SCRATCH, "nope.db");
    const err = await expectFail(miss, "SELECT 1", "missing");
    expect(err).toContain("数据库文件不存在");
    expect(fs.existsSync(miss)).toBe(false); // 绝不自动建库
  }, 30_000);

  test("非库文件 → missing 附诊断（任务口径：非库归 missing）", async () => {
    const fake = path.join(SCRATCH, "fake.db");
    fs.writeFileSync(fake, "this is just text, not a sqlite database at all");
    const err = await expectFail(fake, "SELECT 1", "missing");
    expect(err).toContain("不是有效的 SQLite 数据库");
  }, 30_000);

  test("目录路径 → missing", async () => {
    const dir = path.join(SCRATCH, "adir");
    fs.mkdirSync(dir);
    const err = await expectFail(dir, "SELECT 1", "missing");
    expect(err).toContain("不是常规文件");
  }, 30_000);
});

// ---- 4. 播种与边界 -----------------------------------------------------------------

describe("dbdiag：播种与边界", () => {
  test("真实文件 e2e：tmp 建库 → 只读诊断 SEARCH 命中 + 文件未被改动", async () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const before = fs.statSync(f).size;
    const r = await mustOk(f, "SELECT * FROM author WHERE name = '甲'");
    expect(r.plan.steps[0]!.detail).toMatch(/^SEARCH author USING INDEX idx_author_name/);
    expect(r.plan.fullScan).toBe(false);
    expect(r.ms).toBeLessThan(5_000); // EQP 纯计划分析，毫秒级
    expect(fs.statSync(f).size).toBe(before); // 只读连接零写入
    // 同库再跑一条无索引 WHERE → fullScan（跨调用文件状态稳定）
    const r2 = await mustOk(f, "SELECT * FROM book WHERE title = '书一'");
    expect(r2.plan.fullScan).toBe(true);
    expect(r2.plan.tables).toEqual(["book"]);
  }, 30_000);

  test("setup 仅 :memory:：文件库传 setup → denied（写面属于迁移通道）", async () => {
    const f = makeDb("seeded.db", LIBRARY_SQL);
    const err = await expectFail(f, "SELECT 1", "denied", { setup: "CREATE TABLE x(a)" });
    expect(err).toContain("仅支持 :memory:");
  }, 30_000);

  test("setup 坏 SQL → syntax 附原因（瞬态库不留痕迹）；常量查询伪步骤不入 tables", async () => {
    const err = await expectFail(":memory:", "SELECT 1", "syntax", { setup: "CREATE TABLE broken(" });
    expect(err).toContain("播种 SQL 执行失败");
    // 无 FROM 常量查询：SCAN CONSTANT ROW 是伪步骤 —— 不入 tables、不算 fullScan
    const r = await mustOk(":memory:", "SELECT 1");
    expect(r.plan.steps.length).toBeGreaterThan(0); // 步骤如实呈现
    expect(r.plan.steps[0]!.detail).toBe("SCAN CONSTANT ROW");
    expect(r.plan.tables).toEqual([]); // 但伪表不计
    expect(r.plan.fullScan).toBe(false);
    expect(r.suggestions).toEqual([]); // 无表访问 → 无 WHERE 提醒不打扰
    // setup 尺寸帽
    const huge = `${"--".padEnd(300 * 1024, "x")}\nSELECT 1`;
    const err2 = await expectFail(":memory:", "SELECT 1", "internal", { setup: huge });
    expect(err2).toContain("256KB");
    expect(DBDIAG_LIMITS.maxSetupBytes).toBe(256 * 1024);
  }, 30_000);
});

afterAll(() => {
  // best-effort：Windows 下 bun:sqlite 句柄可能滞后到进程退出，删除失败不炸
  try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
});
