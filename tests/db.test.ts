// ============================================================================
// tests/db.test.ts — SQLite 数据库操作层（v0.5.15 · capabilities #43/#73）
// ----------------------------------------------------------------------------
// lib/db.ts 三通道全覆盖（24 用例，全部显式 30s 超时）：
//   schema 通道（5）：两表+索引+视图聚合 / sqlite_* 内部表滤除 / 缺失空结构
//                    降级 / :memory: 瞬态语义 / >10MB 行数抽查跳过
//   query 正常路（6）：:memory: 结果契约 / 文件 SELECT 列序+空结果集 /
//                    WHERE+JOIN（位置数组不丢列）/ 缺省 200 行帽 truncated /
//                    opts.limit 钳制 1..1000 / PRAGMA·EXPLAIN 白名单放行
//   只读门（4）：写语句全家桶 denied / 越界 PRAGMA + 大小写变体 denied /
//                多语句与中置分号拒（尾分号·字符串分号不误伤）/
//                注释头注入拒（合法注释不误伤）
//   错误分型（3）：词法门漏网写句 → 只读连接拦截（kind:"readonly" 双层
//                防御实证 + 无写入核验）/ syntax 附 SQLite 原始 message /
//                文件级守卫（missing · 非库文件 · >256MB → internal）
//   migrate 通道（6）：首次迁移全链路（版本 1 + _org_migrations 落账 +
//                伴车 json + dbMigrations 读回）/ 版本递增 + 跨函数状态保持 /
//                dryRun 事务回滚 / 坏 SQL 整体回滚 + 参数校验 / 双向冲突
//                conflict 附诊断 / :memory: 瞬态迁移不落伴车
// ============================================================================
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN } from "./helpers";
import {
  DB_LIMITS,
  dbSchema,
  dbTables,
  dbQuery,
  dbMigrations,
  dbApplyMigration,
} from "../lib/db.ts";

const SCRATCH_ROOT = path.join(TEST_RUN, "db");
let SCRATCH = ""; // beforeEach 注入唯一子目录（v0.5.15：跨用例零删除 —— bun:sqlite 的 Windows 句柄释放滞后于 close()，删除必 EBUSY）
let scratchSeq = 0;

// ---- 测试基建 ----------------------------------------------------------------

beforeEach(() => {
  SCRATCH = path.join(SCRATCH_ROOT, `t${String(++scratchSeq).padStart(3, "0")}`);
  fs.mkdirSync(SCRATCH, { recursive: true });
});

/** 建一个真实 .db 文件（测试用 bun:sqlite 直种数据 —— 读写通道不经过被测门）。 */
function makeDb(rel: string, setupSql?: string): string {
  const file = path.join(SCRATCH, rel);
  const db = new Database(file);
  if (setupSql) db.exec(setupSql);
  db.close();
  return file;
}

/** 标准语料床：author/book 两表 + 索引 + 视图 + 3+2 行数据。 */
const LIBRARY_SQL = `
CREATE TABLE author(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INT);
CREATE TABLE book(id INTEGER PRIMARY KEY, author_id INT NOT NULL, title TEXT);
CREATE INDEX idx_author_name ON author(name);
CREATE VIEW v_adult AS SELECT * FROM author WHERE age >= 18;
INSERT INTO author VALUES (1, '甲', 30), (2, '乙', 15), (3, '丙', 41);
INSERT INTO book VALUES (10, 1, '书一'), (11, 2, '书二');
`;

/** 成功窄化：失败即抛（附完整错误体，断言消息可直接诊断）。 */
function mustOk<T>(r: { ok: boolean } & T): { ok: true } & T {
  if (!r.ok) throw new Error(`预期 ok:true，得到：${JSON.stringify(r)}`);
  return r as { ok: true } & T;
}

/** 失败断言：kind 精确匹配 + error 非空。 */
function expectFail(r: unknown, kind: string): string {
  const rec = r as { ok: boolean; kind?: string; error?: string };
  expect(rec.ok).toBe(false);
  expect(rec.kind).toBe(kind);
  expect(typeof rec.error).toBe("string");
  expect(rec.error!.length).toBeGreaterThan(0);
  return rec.error!;
}

// ---- 1. schema 通道 -----------------------------------------------------------

describe("schema 通道：dbSchema / dbTables", () => {
  test("两表 + 索引 + 视图 → 聚合正确（表/列元数据 pk·notNull/行数/索引/视图/journalMode/sizeBytes）", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const s = dbSchema(f);
    expect(s.missing).toBeUndefined();
    expect(s.file).toBe(f);
    expect(s.sizeBytes).toBeGreaterThan(0);
    expect(s.tables.map((t) => t.name)).toEqual(["author", "book"]);
    expect(s.indexes).toEqual(["idx_author_name"]);
    expect(s.views).toEqual(["v_adult"]);
    expect(s.journalMode).toBe("delete");

    const author = s.tables.find((t) => t.name === "author")!;
    expect(author.rowCount).toBe(3);
    expect(author.columns).toEqual([
      { name: "id", type: "INTEGER", notNull: false, pk: true }, // INTEGER PRIMARY KEY：pk 隐式非空但 notnull 报 0（SQLite 语义，如实映射）
      { name: "name", type: "TEXT", notNull: true, pk: false },
      { name: "age", type: "INT", notNull: false, pk: false },
    ]);
    expect(s.tables.find((t) => t.name === "book")!.rowCount).toBe(2);

    expect(dbTables(f)).toEqual(["author", "book"]); // 建库序
  }, 30_000);

  test("sqlite_* 内部表滤除（AUTOINCREMENT 的 sqlite_sequence 不入清单）", () => {
    const f = makeDb("autoinc.db",
      "CREATE TABLE seq_t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); INSERT INTO seq_t(v) VALUES ('x')");
    expect(dbTables(f)).toEqual(["seq_t"]); // sqlite_sequence 被滤除
    const s = dbSchema(f);
    expect(s.tables.map((t) => t.name)).toEqual(["seq_t"]);
    expect(s.tables[0]!.rowCount).toBe(1);
  }, 30_000);

  test("文件不存在 → 空结构 + missing:true；dbTables/dbMigrations 空数组（不炸）", () => {
    const miss = path.join(SCRATCH, "nope.db");
    const s = dbSchema(miss);
    expect(s.missing).toBe(true);
    expect(s.tables).toEqual([]);
    expect(s.indexes).toEqual([]);
    expect(s.views).toEqual([]);
    expect(s.journalMode).toBeNull();
    expect(s.sizeBytes).toBe(0);
    expect(dbTables(miss)).toEqual([]);
    expect(dbMigrations(miss)).toEqual([]);
  }, 30_000);

  test(":memory: → 瞬态空库（tables 空 + journalMode memory + sizeBytes 0）", () => {
    const s = dbSchema(":memory:");
    expect(s.missing).toBeUndefined();
    expect(s.tables).toEqual([]);
    expect(s.journalMode).toBe("memory");
    expect(s.sizeBytes).toBe(0);
    expect(dbTables(":memory:")).toEqual([]);
  }, 30_000);

  test(">10MB 文件 → 行数抽查跳过（rowCount:null）但元数据仍聚合", () => {
    const blob = "x".repeat(11 * 1024 * 1024);
    const f = makeDb("big.db",
      `CREATE TABLE big(v TEXT); CREATE TABLE tiny(v TEXT); INSERT INTO big VALUES ('${blob}'); INSERT INTO tiny VALUES ('t')`);
    expect(fs.statSync(f).size).toBeGreaterThan(10 * 1024 * 1024);
    const s = dbSchema(f);
    expect(s.tables.map((t) => t.name)).toEqual(["big", "tiny"]);
    expect(s.tables[0]!.rowCount).toBeNull(); // 文件级代理：超阈全跳
    expect(s.tables[1]!.rowCount).toBeNull();
    expect(s.tables[0]!.columns).toEqual([{ name: "v", type: "TEXT", notNull: false, pk: false }]);
  }, 30_000);
});

// ---- 2. query 通道：正常路径 -----------------------------------------------------

describe("query 通道：dbQuery 正常路径", () => {
  test(":memory: 常量查询 → 结果契约（columns/rows/rowCount/ms/truncated/statement）", () => {
    const r = mustOk(dbQuery(":memory:", "SELECT 1 + 1 AS two, 'hi' AS s"));
    expect(r.result.columns).toEqual(["two", "s"]);
    expect(r.result.rows).toEqual([[2, "hi"]]);
    expect(r.result.rowCount).toBe(1);
    expect(r.result.ms).toBeGreaterThanOrEqual(0);
    expect(r.result.truncated).toBe(false);
    expect(r.result.statement).toBe("SELECT 1 + 1 AS two, 'hi' AS s");
  }, 30_000);

  test("文件 SELECT：列序 + 行数据 + 空结果集（columns 仍完整）", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const r = mustOk(dbQuery(f, "SELECT id, name FROM author ORDER BY id"));
    expect(r.result.columns).toEqual(["id", "name"]);
    expect(r.result.rows).toEqual([[1, "甲"], [2, "乙"], [3, "丙"]]);
    expect(r.result.rowCount).toBe(3);

    const empty = mustOk(dbQuery(f, "SELECT id, name FROM author WHERE 1 = 0"));
    expect(empty.result.columns).toEqual(["id", "name"]); // 零行也报得出列
    expect(empty.result.rows).toEqual([]);
    expect(empty.result.rowCount).toBe(0);
    expect(empty.result.truncated).toBe(false);
  }, 30_000);

  test("WHERE 过滤 + JOIN 联结（rows 位置数组，同名列值不丢）", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const where = mustOk(dbQuery(f, "SELECT name FROM author WHERE age >= 18 ORDER BY id"));
    expect(where.result.rows).toEqual([["甲"], ["丙"]]);

    const join = mustOk(dbQuery(f,
      "SELECT a.name AS author, b.title FROM book b JOIN author a ON b.author_id = a.id ORDER BY b.id"));
    expect(join.result.rows).toEqual([["甲", "书一"], ["乙", "书二"]]);

    // 同名列：columnNames 折叠（bun:sqlite 已知边界），但位置数组两列值都在
    const dup = mustOk(dbQuery(f, "SELECT author.id, book.id FROM author, book WHERE author.id = 1 AND book.id = 10"));
    expect(dup.result.rows).toEqual([[1, 10]]);
    expect(dup.result.rows[0]!.length).toBe(2);
  }, 30_000);

  test("缺省 200 行帽：250 行 → 200 + truncated:true；未超 → 全量 + truncated:false", () => {
    const f = makeDb("rows250.db",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);" +
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 250) " +
      "INSERT INTO t SELECT x, 'row-' || x FROM c");
    const capped = mustOk(dbQuery(f, "SELECT id FROM t ORDER BY id"));
    expect(capped.result.rowCount).toBe(DB_LIMITS.defaultRowLimit);
    expect(capped.result.rows.length).toBe(200);
    expect(capped.result.truncated).toBe(true);
    expect(capped.result.rows[199]).toEqual([200]); // 前 200 行原样（ORDER BY 保序）

    const f2 = makeDb("rows150.db",
      "CREATE TABLE t(id INTEGER PRIMARY KEY);" +
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 150) " +
      "INSERT INTO t SELECT x FROM c");
    const full = mustOk(dbQuery(f2, "SELECT id FROM t ORDER BY id"));
    expect(full.result.rowCount).toBe(150);
    expect(full.result.truncated).toBe(false);
  }, 30_000);

  test("opts.limit 生效与 1..1000 钳制（1500 行表）", () => {
    const f = makeDb("rows1500.db",
      "CREATE TABLE t(id INTEGER PRIMARY KEY);" +
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1500) " +
      "INSERT INTO t SELECT x FROM c");
    const small = mustOk(dbQuery(f, "SELECT id FROM t", { limit: 5 }));
    expect(small.result.rows.length).toBe(5);
    expect(small.result.truncated).toBe(true);

    const over = mustOk(dbQuery(f, "SELECT id FROM t", { limit: 9999 }));
    expect(over.result.rows.length).toBe(DB_LIMITS.maxRowLimit); // 钳到 1000
    expect(over.result.truncated).toBe(true);

    const floor = mustOk(dbQuery(f, "SELECT id FROM t", { limit: 0 }));
    expect(floor.result.rows.length).toBe(1); // 钳到下界 1
  }, 30_000);

  test("PRAGMA 白名单放行：table_info / table_list / EXPLAIN QUERY PLAN", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const ti = mustOk(dbQuery(f, "PRAGMA table_info(author)"));
    expect(ti.result.columns).toEqual(["cid", "name", "type", "notnull", "dflt_value", "pk"]);
    expect(ti.result.rows[0]).toEqual([0, "id", "INTEGER", 0, null, 1]);

    const tl = mustOk(dbQuery(f, "PRAGMA table_list"));
    expect(tl.result.columns).toContain("name");
    expect(JSON.stringify(tl.result.rows)).toContain("author");

    const plan = mustOk(dbQuery(f, "EXPLAIN QUERY PLAN SELECT * FROM author WHERE name = 'x'"));
    expect(plan.result.columns).toContain("detail");
    expect(JSON.stringify(plan.result.rows)).toContain("author");
  }, 30_000);
});

// ---- 3. query 通道：只读门（词法层）----------------------------------------------

describe("query 通道：只读门（词法层 → kind:「denied」）", () => {
  test("写语句全家桶一律拒：INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/ATTACH/VACUUM/REPLACE", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const writes = [
      "INSERT INTO author(id, name, age) VALUES (9, '丁', 20)",
      "UPDATE author SET age = 0",
      "DELETE FROM author",
      "DROP TABLE author",
      "CREATE TABLE evil(x)",
      "ALTER TABLE author ADD COLUMN evil TEXT",
      "ATTACH DATABASE 'x.db' AS x",
      "VACUUM",
      "REPLACE INTO author(id, name, age) VALUES (9, '丁', 20)",
    ];
    for (const sql of writes) {
      expectFail(dbQuery(f, sql), "denied");
    }
    // 拒绝后数据原封不动
    const count = mustOk(dbQuery(f, "SELECT COUNT(*) AS c FROM author"));
    expect(count.result.rows).toEqual([[3]]);
  }, 30_000);

  test("越界 PRAGMA 拒 + 大小写变体拒（门对大小写不敏感）", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    expectFail(dbQuery(f, "PRAGMA journal_mode"), "denied"); // 可变更行为
    expectFail(dbQuery(f, "PRAGMA writable_schema = 1"), "denied");
    expectFail(dbQuery(f, "PRAGMA main.table_info(author)"), "denied"); // 带库前缀不在白名单形
    expectFail(dbQuery(f, "drop table author"), "denied");
    expectFail(dbQuery(f, "iNsErT INTO author(id) VALUES (9)"), "denied");
    expectFail(dbQuery(f, "Update author SET age = 0"), "denied");
    expectFail(dbQuery(f, "cReAtE TABLE evil(x)"), "denied");
  }, 30_000);

  test("多语句与中置分号拒；尾分号 + 字符串内分号不误伤", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    expectFail(dbQuery(f, "SELECT 1; SELECT 2"), "denied"); // 中置分号 = 两条语句
    expectFail(dbQuery(f, "SELECT 1; DROP TABLE author"), "denied");
    expectFail(dbQuery(f, "SELECT 1; SELECT 2;"), "denied");

    // 不误伤面：尾分号 / 字符串里的分号 / 尾随注释
    expect(mustOk(dbQuery(f, "SELECT 1 AS v;")).result.rows).toEqual([[1]]);
    const strSemi = mustOk(dbQuery(f, "SELECT '; DROP TABLE author;' AS payload, ';' AS semi"));
    expect(strSemi.result.rows).toEqual([[`; DROP TABLE author;`, ";"]]);
    expect(mustOk(dbQuery(f, "SELECT 1 AS v; -- trailing comment")).result.rows).toEqual([[1]]);
  }, 30_000);

  test("注释头注入拒（行注释/块注释）；合法注释前缀查询不误伤", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    expectFail(dbQuery(f, "-- x\nDROP TABLE author"), "denied"); // 剥注释后前导词现形
    expectFail(dbQuery(f, "/* harmless */ DELETE FROM author"), "denied");
    expectFail(dbQuery(f, "/*\nmulti line\n*/ ATTACH DATABASE 'x' AS y"), "denied");
    expectFail(dbQuery(f, "-- 仅注释"), "denied"); // 剥完为空

    // 不误伤面：注释只是前缀/中缀的合法只读语句
    expect(mustOk(dbQuery(f, "-- 前置注释\nSELECT 41 + 1 AS v")).result.rows).toEqual([[42]]);
    expect(mustOk(dbQuery(f, "SELECT /* 中缀 */ 7 AS v")).result.rows).toEqual([[7]]);
  }, 30_000);
});

// ---- 4. query 通道：错误分型与双层防御 --------------------------------------------

describe("query 通道：错误分型与双层防御", () => {
  test("词法门漏网的写语句 → 只读连接拦截（kind:「readonly」）且实际零写入", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    // WITH 前导词合法 → 过词法门；INSERT 尾落 → 只读连接在执行时拦截
    const r = dbQuery(f,
      "WITH c AS (SELECT 99) INSERT INTO book(id, author_id, title) SELECT 99, 1, 'evil' FROM c");
    const err = expectFail(r, "readonly");
    expect(err).toContain("dbApplyMigration"); // 引导到正确通道

    // 内核级保证的实证：一条都没写进去
    const count = mustOk(dbQuery(f, "SELECT COUNT(*) AS c FROM book"));
    expect(count.result.rows).toEqual([[2]]);
    expect(dbTables(f)).toEqual(["author", "book"]); // 表结构原封
  }, 30_000);

  test("语法错 → kind:「syntax」附 SQLite 原始 message", () => {
    const f = makeDb("library.db", LIBRARY_SQL);
    const e1 = expectFail(dbQuery(f, "SELECT FROM"), "syntax");
    expect(e1).toContain("syntax error"); // SQLite 原始 message 透传
    const e2 = expectFail(dbQuery(f, "SELECT * FROM no_such_table"), "syntax");
    expect(e2).toContain("no such table");
  }, 30_000);

  test("文件级守卫分型：缺失 → missing；非库文件 / >256MB → internal", () => {
    const miss = path.join(SCRATCH, "missing.db");
    const eMiss = expectFail(dbQuery(miss, "SELECT 1"), "missing");
    expect(eMiss).toContain("不存在"); // 附提示

    const garbage = path.join(SCRATCH, "garbage.db");
    fs.writeFileSync(garbage, "this is definitely not a sqlite database, just text");
    const eBad = expectFail(dbQuery(garbage, "SELECT 1"), "internal");
    expect(eBad).toContain("不是有效的 SQLite 数据库");

    const huge = path.join(SCRATCH, "huge.db");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, DB_LIMITS.maxFileBytes + 1024); // 稀疏膨胀到 256MB+1KB
    const eBig = expectFail(dbQuery(huge, "SELECT 1"), "internal");
    expect(eBig).toContain("256MB"); // 附预算提示
  }, 30_000);
});

// ---- 5. migrate 通道 -------------------------------------------------------------

describe("migrate 通道：dbApplyMigration / dbMigrations", () => {
  test("首次迁移全链路：新文件建表 + 版本 1 落 _org_migrations + 伴车 json 双写", () => {
    const f = path.join(SCRATCH, "fresh.db"); // 不预建 —— 首次迁移的正当入口
    const sql = "CREATE TABLE task(id INTEGER PRIMARY KEY, title TEXT NOT NULL);\nINSERT INTO task(title) VALUES ('a')";
    const r = mustOk(dbApplyMigration(f, "init", sql));
    expect(r.version).toBe(1);
    expect(r.dryRun).toBe(false);
    expect(r.durMs).toBeGreaterThanOrEqual(0);

    // 库内账本 + 用户表 + 数据（只读通道可查）
    const hist = mustOk(dbQuery(f, "SELECT version, name FROM _org_migrations ORDER BY version"));
    expect(hist.result.rows).toEqual([[1, "init"]]);
    const tasks = mustOk(dbQuery(f, "SELECT COUNT(*) AS c FROM task"));
    expect(tasks.result.rows).toEqual([[1]]);

    // 伴车 json：数组 + version/name/sql/appliedAt（人读 + git 友好）
    const sidecar = JSON.parse(fs.readFileSync(`${f}.migrations.json`, "utf-8")) as Array<Record<string, unknown>>;
    expect(sidecar.length).toBe(1);
    expect(sidecar[0]!.version).toBe(1);
    expect(sidecar[0]!.name).toBe("init");
    expect(String(sidecar[0]!.sql)).toContain("CREATE TABLE task");
    expect(String(sidecar[0]!.appliedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // dbMigrations 读回
    const list = dbMigrations(f);
    expect(list.length).toBe(1);
    expect(list[0]!.version).toBe(1);
    expect(list[0]!.name).toBe("init");
    expect(list[0]!.sql).toContain("CREATE TABLE task");
  }, 30_000);

  test("第二条迁移版本 2 + 双写同步 + 跨函数状态保持（dbQuery/dbTables/dbSchema 见新表）", () => {
    const f = path.join(SCRATCH, "app.db");
    mustOk(dbApplyMigration(f, "init", "CREATE TABLE task(id INTEGER PRIMARY KEY, title TEXT NOT NULL)"));
    const r2 = mustOk(dbApplyMigration(f, "add-index", "CREATE INDEX idx_task ON task(title)"));
    expect(r2.version).toBe(2);

    expect(dbMigrations(f).map((m) => m.version)).toEqual([1, 2]);
    const hist = mustOk(dbQuery(f, "SELECT version, name FROM _org_migrations ORDER BY version"));
    expect(hist.result.rows).toEqual([[1, "init"], [2, "add-index"]]);

    // 跨函数状态：迁移建的表，三个只读口都看得见（建库序：账本表先于用户表）
    expect(dbTables(f)).toEqual(["_org_migrations", "task"]);
    const s = dbSchema(f);
    expect(s.tables.map((t) => t.name)).toEqual(["_org_migrations", "task"]);
    expect(s.indexes).toEqual(["idx_task"]);
    expect(s.tables.find((t) => t.name === "task")!.rowCount).toBe(0);
  }, 30_000);

  test("dryRun：事务跑完即 ROLLBACK（表不留、版本不落、伴车不增）", () => {
    const f = path.join(SCRATCH, "app.db");
    mustOk(dbApplyMigration(f, "init", "CREATE TABLE base(x)"));

    const dr = mustOk(dbApplyMigration(f, "tentative",
      "CREATE TABLE tmp_t(v TEXT); INSERT INTO tmp_t VALUES ('x')", { dryRun: true }));
    expect(dr.dryRun).toBe(true);
    expect(dr.version).toBe(2); // 报告「本应是 v2」—— 但已回滚

    expectFail(dbQuery(f, "SELECT * FROM tmp_t"), "syntax"); // 表不存在了
    expect(dbTables(f)).toEqual(["_org_migrations", "base"]); // 无 tmp_t
    expect(dbMigrations(f).map((m) => m.version)).toEqual([1]); // 伴车不增
    const next = mustOk(dbApplyMigration(f, "real", "CREATE TABLE real_t(x)"));
    expect(next.version).toBe(2); // 版本未被 dryRun 占用
  }, 30_000);

  test("坏 SQL 整体回滚（kind:「syntax」，先前语句不残留，版本不消耗）+ 参数校验", () => {
    const f = path.join(SCRATCH, "app.db");
    mustOk(dbApplyMigration(f, "init", "CREATE TABLE base(x)"));

    const bad = dbApplyMigration(f, "bad",
      "CREATE TABLE keepme(a); INSERT INTO no_such_table VALUES (1);");
    expectFail(bad, "syntax");
    expect(dbTables(f)).toEqual(["_org_migrations", "base"]); // keepme 不残留
    expect(dbMigrations(f).map((m) => m.version)).toEqual([1]);

    const next = mustOk(dbApplyMigration(f, "good", "CREATE TABLE good_t(x)"));
    expect(next.version).toBe(2); // 坏迁移没消耗版本号

    // 参数校验（调用方错误 → internal 附人读提示）
    expectFail(dbApplyMigration(f, "", "SELECT 1"), "internal");
    expectFail(dbApplyMigration(f, "x", "   "), "internal");
  }, 30_000);

  test("双向冲突 → kind:「conflict」附诊断（伴车有表无 / 表有伴车无）", () => {
    // 方向一：伴车 json 有记录但库里没有（手工写史 / 重建库未清伴车）
    const f1 = path.join(SCRATCH, "ghost.db");
    fs.writeFileSync(`${f1}.migrations.json`,
      JSON.stringify([{ version: 1, name: "ghost", sql: "CREATE TABLE g(x)", appliedAt: "2026-01-01T00:00:00Z" }]));
    const e1 = expectFail(dbApplyMigration(f1, "real", "CREATE TABLE r(x)"), "conflict");
    expect(e1).toContain("仅伴车有 v1(ghost)，表缺失");
    expect(e1).toContain("人工核对");

    // 方向二：表有记录但伴车没有（迁移后伴车被删）
    const f2 = path.join(SCRATCH, "app.db");
    mustOk(dbApplyMigration(f2, "init", "CREATE TABLE base(x)"));
    fs.rmSync(`${f2}.migrations.json`);
    const e2 = expectFail(dbApplyMigration(f2, "second", "CREATE TABLE s(x)"), "conflict");
    expect(e2).toContain("仅 _org_migrations 表有 v1(init)，伴车缺失");

    // 双方一致后恢复可用
    fs.writeFileSync(`${f2}.migrations.json`,
      JSON.stringify([{ version: 1, name: "init", sql: "CREATE TABLE base(x)", appliedAt: "2026-01-01T00:00:00Z" }]));
    const ok2 = mustOk(dbApplyMigration(f2, "second", "CREATE TABLE s(x)"));
    expect(ok2.version).toBe(2);
  }, 30_000);

  test(":memory: 迁移：瞬态可用（ok + v1）+ 不落伴车 + 每次新开", () => {
    const memSidecar = path.resolve(":memory:.migrations.json");
    fs.rmSync(memSidecar, { force: true }); // 防御：清掉历史残留

    const r = mustOk(dbApplyMigration(":memory:", "mem-init", "CREATE TABLE t(x); INSERT INTO t VALUES (1)"));
    expect(r.version).toBe(1);
    expect(fs.existsSync(memSidecar)).toBe(false); // 无文件锚点 → 不落伴车

    // 每次新开：第二次调用拿到的是全新瞬态库 → 版本又从 1 起
    const r2 = mustOk(dbApplyMigration(":memory:", "mem-init-2", "CREATE TABLE u(y)"));
    expect(r2.version).toBe(1);

    fs.rmSync(memSidecar, { force: true }); // 清理
  }, 30_000);
});

afterAll(() => {
  // best-effort：Windows 下 bun:sqlite 句柄可能滞后到进程退出，删除失败不炸
  try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
});
