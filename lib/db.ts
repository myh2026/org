// ============================================================================
// lib/db.ts — SQLite 数据库操作层（v0.5.15 · capabilities #43/#73）
// ----------------------------------------------------------------------------
// 「开袋即食地查看 / 查询 / 迁移用户工作区里的 SQLite 文件」：基于 Bun 内置
// bun:sqlite（零第三方依赖）的三通道设计 —— 桌面 Agent 的数据库能力，四个
// 消费入口共用本实现（CLI org db … / Web GUI / 工具环 / 测试）：
//   · schema 通道   dbSchema / dbTables      只读元数据聚合（表 / 列 / 行数
//                                            抽查 / 索引 / 视图 / journal mode）
//   · query 通道    dbQuery                  只读门（词法白名单 + 只读连接双层防御）
//   · migrate 通道  dbApplyMigration         唯一写面（事务包裹 + 版本账本双写）
//
// 【只读门 —— 双层防御】
//   第一层（词法，kind:"denied"）：语句经扫描器剥除注释 / 字符串 / 引号标识
//   符后，必须是单条语句（唯一分号只许出现在句尾）、前导词 ∈ {SELECT,
//   WITH, EXPLAIN, PRAGMA}；PRAGMA 仅放行 table_info / table_list。写动词
//   （INSERT / UPDATE / DELETE / DROP / CREATE / ALTER / ATTACH / VACUUM…）
//   一律在词法层被拒，写操作只能走专用 migrate 通道 —— SQL 注入面被结构性
//   消灭，而非穷举式封堵。
//   第二层（内核，kind:"readonly"）：查询 / schema 连接以 readonly:true 打
//   开，SQLite 内核自身拒绝一切写入。词法层已知存在刻意的漏网面 —— 前导词
//   合法但尾部落写动词的语句（WITH … INSERT / EXPLAIN 写句）；这正是第二
//   层的存在意义（漏网写句在 .values() 执行时被内核拦截，实测报
//   "attempt to write a readonly database"）。SELECT load_extension() 类
//   逃逸面同样由内核守卫（实测 "not authorized" → kind:"denied"）。
//   错误分型：denied=词法门拒 · readonly=只读连接拒（漏网写语句实证）·
//   syntax=SQLite 编译 / 执行报错统称（附原始 message）· missing=文件不
//   存在 · internal=预算 / IO 等内部错误。
//
// 【伴车迁移协议】
//   迁移账本双写：库内 _org_migrations 表（version INTEGER PRIMARY KEY,
//   name TEXT NOT NULL, applied_at TEXT NOT NULL）+ 伴车
//   <file>.migrations.json（JSON 数组，含完整 SQL —— 人读 + git 友好，评
//   审迁移史不用打开二进制库）。
//   · 版本号 = 表内最大 version + 1（表为唯一权威，伴车必须镜像）
//   · 双边不一致（任一侧有对方没有的版本、或同版本名称不同）→
//     kind:"conflict" 附诊断并拒绝应用 —— 防止手工改史 / 半写状态静默漂移
//   · dryRun = 走同一条事务路径跑完即 ROLLBACK（真正验证 SQL 可执行但不
//     落盘），非 dryRun COMMIT
//   · 迁移 SQL 允许多条语句（事务内 db.exec）；任何一条失败整体回滚
//     （kind:"syntax"），先前语句不残留
//   · 迁移 SQL 不得自带事务管理语句（BEGIN / COMMIT / ROLLBACK）—— 协议
//     约束：事务管理权归本模块
//
// 【:memory: 语义】file === ":memory:" 时每次调用新开一个瞬态库（测试用），
// 连接关闭即蒸发。SQLite 不允许匿名库只读打开（bun:sqlite 实测抛 "Cannot
// open an anonymous database in read-only mode"），故 :memory: 通道用读写
// 连接 —— 但写面仅及于当次调用的临时副本，无任何持久化风险；:memory: 无
// 文件锚点，跳过伴车读写与冲突比对。
//
// 【预算与诚实边界】
//   · 查询通道文件 >256MB（DB_LIMITS.maxFileBytes）→ kind:"internal" 附提示
//   · 行帽：缺省 200（DB_LIMITS.defaultRowLimit），opts.limit 钳制到
//     1..1000；超出帽的行被丢弃并标 truncated:true
//   · bun:sqlite 是同步执行模型，无法中断正在跑的 VDBE —— 本模块不承诺
//     wall-clock 查询超时，代之以「进入引擎前收口」的拒绝面（文件帽 + 单
//     语句强制 + 行帽）。残余风险诚实记录：COUNT(*) / 聚合类语句的全量计
//     算在首行返回前完成（行帽不设防），其上界由 256MB 文件帽间接约束。
//   · dbSchema 行数抽查：SELECT COUNT(*) 逐表进行；文件 >10MB 一律跳过
//     （rowCount:null）—— 单表大小无廉价探针（dbstat 虚表非所有构建默认
//     启用），以文件大小做代理，超限全跳。
//
// 【优雅降级铁律】所有导出函数绝不让异常逃逸：查询 / 迁移通道返回
// { ok:false, kind, error } 结构化错误；schema 通道（无错误联合的便捷
// API）返回空结构并置 missing:true 标记；打开的连接一律 try/finally
// close，语句 finalize 兜底。
// ============================================================================

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- 常量（预算面）----------------------------------------------------------

/** 通道预算（查询通道的拒绝面，见文件头「预算与诚实边界」）。 */
export const DB_LIMITS = {
  /** 查询通道文件硬帽：超过即拒绝打开（防大库拖死会话）。 */
  maxFileBytes: 256 * 1024 * 1024,
  /** dbQuery 缺省返回行数。 */
  defaultRowLimit: 200,
  /** dbQuery 返回行数上限（opts.limit 越界钳制到此）。 */
  maxRowLimit: 1000,
} as const;

/** dbSchema 行数抽查阈值：文件超过则所有表 rowCount 置 null（见文件头）。 */
const ROWCOUNT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 迁移账本表名（库内权威账本）。 */
const MIGRATIONS_TABLE = "_org_migrations";

/** 伴车文件后缀：<file> + 该后缀（追加式，兼容 .db/.sqlite 任意扩展名）。 */
const SIDECAR_SUFFIX = ".migrations.json";

// ---- bun:sqlite 语句面（结构收窄）--------------------------------------------

/** 本模块依赖的语句面（以运行时实证为准：columnNames 是属性而非方法；
 *  values() 返回位置数组 —— 同名列不丢失，这是 JOIN 场景选它的原因）。 */
interface SqliteStmt {
  readonly columnNames: string[];
  values(...params: unknown[]): unknown[][];
  finalize(): void;
}

/** 把 db.prepare 的返回值收窄为本模块用的语句面。 */
function stmtOf(db: Database, sql: string): SqliteStmt {
  return db.prepare(sql) as unknown as SqliteStmt;
}

// ---- 词法扫描器（只读门第一层的地基）------------------------------------------

interface ScannedSql {
  /** 剥除注释 / 字符串 / 引号标识符后的代码骨架（原样大小写）。 */
  stripped: string;
}

/** SQL 词法扫描：单趟处理行注释（--）、块注释、单引号字符串（'' 转义）、
 *  双引号 / 反引号 / 方括号标识符，剥除区域替换为单个空格（保持词元分
 *  隔）。剥除区域内的分号 / 关键字一律不参与只读门判定 —— `SELECT ';'`
 *  里的分号不是语句分隔符，`-- DROP TABLE t` 里的 DROP 不是前导词；反之
 *  注释头注入正是靠这条被拦下（剥注释后前导词现形为写动词）。 */
function scanSql(sql: string): ScannedSql {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const c2 = i + 1 < n ? sql[i + 1] : "";
    if (c === "-" && c2 === "-") {
      // 行注释：吃到换行前（换行保留，维持词元边界）
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out.push(" ");
    } else if (c === "/" && c2 === "*") {
      // 块注释：吃到 */（未闭合吃到串尾）
      i += 2;
      while (i < n && !(sql[i] === "*" && i + 1 < n && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out.push(" ");
    } else if (c === "'" || c === '"' || c === "`") {
      // 字符串 / 引号标识符：引号翻倍转义（未闭合吃到串尾）
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out.push(" ");
    } else if (c === "[") {
      // MS 风格标识符：吃到 ]
      i++;
      while (i < n && sql[i] !== "]") i++;
      i = Math.min(i + 1, n);
      out.push(" ");
    } else {
      out.push(c);
      i++;
    }
  }
  return { stripped: out.join("") };
}

/** 只读门允许的前导词（小写）。 */
const LEADING_WHITELIST = new Set(["select", "with", "explain", "pragma"]);

/** 只读门判定：通过返回 null；被拒返回人读原因（kind 恒为 "denied"）。
 *  规则见文件头「只读门 —— 双层防御」。 */
function readonlyGate(sql: string): string | null {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return "空语句（或仅注释）";
  }
  const { stripped } = scanSql(sql);
  // 唯一分号只许在句尾：剥掉一个尾分号后，骨架中不许再出现任何分号
  // （"SELECT 1; SELECT 2" 的分号在中置位 → 多语句，拒）。
  const body = stripped.replace(/;\s*$/, "");
  if (body.includes(";")) return "多语句（只读通道仅接受单条语句）";
  const trimmed = body.trim();
  if (trimmed.length === 0) return "空语句（或仅注释）";
  const word = trimmed.match(/^[A-Za-z_]+/)?.[0]?.toLowerCase() ?? "";
  if (!LEADING_WHITELIST.has(word)) {
    return `前导词「${word || "?"}」不在只读白名单（SELECT/WITH/EXPLAIN/PRAGMA）`;
  }
  if (word === "pragma") {
    // PRAGMA 只放行两个纯元数据探针；journal_mode / writable_schema 等
    // 可变更行为的一律拒（写操作请走 dbApplyMigration 通道）。
    if (!/^pragma\s+(table_info|table_list)\b/i.test(trimmed)) {
      return "PRAGMA 仅放行 table_info / table_list";
    }
  }
  return null;
}

// ---- 连接与错误分型 -----------------------------------------------------------

/** 只读连接打开失败的结构化原因。 */
type OpenFail = { ok: false; kind: "missing" | "internal"; error: string };

/** 打开查询 / schema 通道连接：普通文件一律 readonly:true（第二层防御），
 *  :memory: 用读写连接（见文件头「:memory: 语义」）。文件缺失在打开前收
 *  口，绝不自动建库。enforceSizeCap 仅供查询通道（256MB 拒绝面；schema
 *  通道是轻量元数据面，不设此帽，大库的行数抽查由 10MB 阈自行跳过）。 */
function openReadConn(file: string, opts?: { enforceSizeCap?: boolean }): { ok: true; db: Database } | OpenFail {
  if (file === ":memory:") {
    try {
      return { ok: true, db: new Database(":memory:") };
    } catch (e) {
      return { ok: false, kind: "internal", error: `无法打开内存库：${errMsg(e)}` };
    }
  }
  if (!fs.existsSync(file)) {
    return {
      ok: false, kind: "missing",
      error: `数据库文件不存在：${file}（新库请用 dbApplyMigration 初始化，或检查路径）`,
    };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { ok: false, kind: "internal", error: `无法读取文件状态：${errMsg(e)}` };
  }
  if (!st.isFile()) {
    return { ok: false, kind: "missing", error: `路径不是常规文件：${file}` };
  }
  if (opts?.enforceSizeCap && st.size > DB_LIMITS.maxFileBytes) {
    return {
      ok: false, kind: "internal",
      error: `文件 ${st.size} 字节超出 ${DB_LIMITS.maxFileBytes}（256MB）查询预算：` +
        `拒绝打开以防拖死会话 —— 需要分析大库请先导出子集`,
    };
  }
  try {
    // readonly 连接：bun:sqlite 对缺失文件会抛（被上面的 existsSync 前置
    // 拦截）；对存在但不可读 / 非库文件在打开或首查时报错，进 catch。
    return { ok: true, db: new Database(file, { readonly: true }) };
  } catch (e) {
    return { ok: false, kind: "internal", error: `无法打开数据库（只读）：${errMsg(e)}` };
  }
}

/** SQLite 报错分型（prepare / values / exec 共用）：readonly→词法门漏网的
 *  写语句（第二层防御的观测面）；not authorized→内核拒授权（如
 *  load_extension）；not a database→文件级错误；其余归 syntax（附原始
 *  message，含 "no such table" 这类对象错误 —— SQLite 报错统称）。 */
function classifySqliteError(e: unknown): { kind: "readonly" | "denied" | "syntax" | "internal"; error: string } {
  const m = errMsg(e);
  const code = (e as { code?: string } | null)?.code;
  if (code === "SQLITE_READONLY" || /readonly database/i.test(m)) {
    return {
      kind: "readonly",
      error: `只读连接拒绝写入：${m}（写操作请走 dbApplyMigration 通道）`,
    };
  }
  if (/not authorized/i.test(m)) {
    return { kind: "denied", error: `SQLite 拒绝授权：${m}` };
  }
  if (/file is not a database/i.test(m)) {
    return { kind: "internal", error: `文件不是有效的 SQLite 数据库：${m}` };
  }
  return { kind: "syntax", error: `SQLite 报错：${m}` };
}

/** 异常 → 人读 message（非 Error 对象也兜住）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 安全部件：finalize / close 的 best-effort 包装（清理失败不掩盖主结果）。 */
function safeClose(db: Database, st?: SqliteStmt): void {
  if (st) { try { st.finalize(); } catch { /* 已 finalize / 执行中报错 → 无需处理 */ } }
  try { db.close(); } catch { /* 连接已关 → 无需处理 */ }
}

// ---- schema 通道 ---------------------------------------------------------------

export interface DbTable {
  /** 表名（sqlite_* 内部表已滤除；_org_migrations 协议表保留 —— 诚实自省）。 */
  name: string;
  /** 列元数据（PRAGMA table_info 聚合，建表序）。 */
  columns: Array<{ name: string; type: string; notNull: boolean; pk: boolean }>;
  /** 行数抽查值；文件 >10MB 时为 null（见文件头「预算与诚实边界」）。 */
  rowCount: number | null;
}

export interface DbSchemaInfo {
  /** 数据库文件路径（原样回显；":memory:" 亦原样）。 */
  file: string;
  /** 文件字节数（:memory: 恒 0）。 */
  sizeBytes: number;
  /** 表清单（sqlite_master type='table'，建库序）。 */
  tables: DbTable[];
  /** 索引名清单（sqlite_autoindex_* 内部索引已滤除）。 */
  indexes: string[];
  /** 视图名清单。 */
  views: string[];
  /** journal mode（"delete"/"wal"/"memory"…）；读失败为 null。 */
  journalMode: string | null;
  /** 文件缺失 / 不可用标记（空结构降级时的可观测信号；正常路径为 undefined）。 */
  missing?: boolean;
}

/** 聚合一个 SQLite 文件的完整 schema：表（含列元数据与行数抽查）、索引、
 *  视图、journal mode。绝不抛异常 —— 文件缺失 / 打开失败 / 非库文件一律
 *  返回空结构（missing:true）；部分聚合失败时保留已聚合部分。 */
export function dbSchema(file: string): DbSchemaInfo {
  const info: DbSchemaInfo = { file, sizeBytes: 0, tables: [], indexes: [], views: [], journalMode: null };
  const opened = openReadConn(file);
  if (!opened.ok) return { ...info, missing: true };
  const db = opened.db;
  try {
    if (file !== ":memory:") info.sizeBytes = fs.statSync(file).size;
    // sqlite_master 一次取全（元数据面天然轻量；256MB 帽不设于此 —— 行数
    // 抽查自带 10MB 阈，其余全是目录读取）
    const master = stmtOf(db, "SELECT type, name FROM sqlite_master").values() as Array<[string, string]>;
    const tableNames: string[] = [];
    for (const [type, name] of master) {
      if (type === "table" && !name.startsWith("sqlite_")) tableNames.push(name);
      else if (type === "index" && !name.startsWith("sqlite_")) info.indexes.push(name);
      else if (type === "view") info.views.push(name);
    }
    const countRows = info.sizeBytes <= ROWCOUNT_MAX_FILE_BYTES;
    const colSt = stmtOf(db, 'SELECT name, type, "notnull", pk FROM pragma_table_info(?)');
    for (const name of tableNames) {
      const cols = colSt.values(name).map((row) => {
        const [cname, ctype, notNull, pk] = row as [string, string, number, number];
        return { name: cname, type: ctype, notNull: notNull > 0, pk: pk > 0 };
      });
      // 行数抽查：>10MB 文件全跳（null）；COUNT 失败也降级为 null（不连坐）
      let rowCount: number | null = null;
      if (countRows) {
        try {
          const ident = `"${name.replace(/"/g, '""')}"`;
          rowCount = (stmtOf(db, `SELECT COUNT(*) FROM ${ident}`).values()[0]?.[0] as number | undefined) ?? null;
        } catch { rowCount = null; }
      }
      info.tables.push({ name, columns: cols, rowCount });
    }
    try { colSt.finalize(); } catch { /* 兜底 */ }
    const jm = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
    info.journalMode = jm?.journal_mode ?? null;
  } catch {
    // 部分聚合失败 → 保留已聚合部分（优雅降级，绝不抛）
  } finally {
    safeClose(db);
  }
  return info;
}

/** 便捷：表名清单（dbSchema 的轻量版，跳过列 / 行数聚合）。文件缺失 → []。 */
export function dbTables(file: string): string[] {
  const opened = openReadConn(file);
  if (!opened.ok) return [];
  try {
    const rows = stmtOf(opened.db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    ).values() as Array<[string]>;
    return rows.map((r) => r[0]!);
  } catch {
    return [];
  } finally {
    safeClose(opened.db);
  }
}

// ---- query 通道（只读门）--------------------------------------------------------

export interface DbQueryResult {
  /** 列名（bun:sqlite columnNames，位置序）。已知诚实边界：JOIN 同名列
   *  折叠为一个 —— 但 rows 是位置数组，全部列值如实保留（列数以
   *  rows[i].length 为准，不因重名丢数据）。 */
  columns: string[];
  /** 行数据（位置数组；已按行帽截断）。 */
  rows: unknown[][];
  /** 实际返回行数（= rows.length；被截断时它就是帽值）。 */
  rowCount: number;
  /** 查询耗时（毫秒，整数）。 */
  ms: number;
  /** 超出行帽被丢弃时为 true（还有更多行没带回来）。 */
  truncated: boolean;
  /** 原样回显的查询语句。 */
  statement: string;
}

/** dbQuery 的失败分型（语义见文件头「只读门 —— 双层防御」）。 */
export type DbQueryError =
  | { ok: false; kind: "denied"; error: string }
  | { ok: false; kind: "readonly"; error: string }
  | { ok: false; kind: "syntax"; error: string }
  | { ok: false; kind: "missing"; error: string }
  | { ok: false; kind: "internal"; error: string };

/** 在 SQLite 文件上执行一条只读语句（SELECT / WITH…SELECT / EXPLAIN /
 *  PRAGMA table_info|table_list）。双层防御 + 三重预算（单语句强制、
 *  256MB 文件帽、行帽 1..1000 缺省 200）。绝不抛异常。 */
export function dbQuery(
  file: string,
  sql: string,
  opts?: { limit?: number },
): { ok: true; result: DbQueryResult } | DbQueryError {
  const t0 = Date.now();
  // 行帽钳制：1..1000（NaN / 缺省 → 200）
  const rawLimit = opts?.limit;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(DB_LIMITS.maxRowLimit, Math.max(1, Math.floor(rawLimit as number)))
    : DB_LIMITS.defaultRowLimit;

  // 第一层：词法只读门（写语句 / 多语句 / 越界 PRAGMA → denied）
  const denied = readonlyGate(sql);
  if (denied) {
    return { ok: false, kind: "denied", error: `只读门拒绝：${denied}（写操作请走 dbApplyMigration 通道）` };
  }

  // 文件守卫（256MB 拒绝面）+ 只读连接（第二层的载体）
  const opened = openReadConn(file, { enforceSizeCap: true });
  if (!opened.ok) return { ok: false, kind: opened.kind, error: opened.error };
  const db = opened.db;
  let st: SqliteStmt | undefined;
  try {
    st = stmtOf(db, sql);
    const columns = [...st.columnNames];
    // .values()：位置数组（JOIN 同名列不丢）+ 第二层防御的观测点（漏网写
    // 语句在此被只读连接拦截 → classify → "readonly"）
    const all = st.values();
    const truncated = all.length > limit;
    const rows = truncated ? all.slice(0, limit) : all;
    return {
      ok: true,
      result: { columns, rows, rowCount: rows.length, ms: Date.now() - t0, truncated, statement: sql },
    };
  } catch (e) {
    const cls = classifySqliteError(e);
    return { ok: false, kind: cls.kind, error: cls.error };
  } finally {
    safeClose(db, st);
  }
}

// ---- migrate 通道（唯一写面）----------------------------------------------------

export interface DbMigration {
  /** 版本号（应用顺序，库内 _org_migrations 表为权威）。 */
  version: number;
  /** 迁移名（人读标识，双侧账本一致性比对的一部分）。 */
  name: string;
  /** 迁移 SQL（多条语句允许；伴车 json 保留全文供评审）。 */
  sql: string;
  /** 应用时间（ISO 8601；读伴车时可能缺失）。 */
  appliedAt?: string;
}

/** 伴车文件路径（<file>.migrations.json）；:memory: 无文件锚点 → null。 */
function sidecarPath(file: string): string | null {
  return file === ":memory:" ? null : `${file}${SIDECAR_SUFFIX}`;
}

/** 读伴车 json：不存在 → 空表；存在但无法解析 / 非数组 → 结构化失败
 *  （dbMigrations 降级为 []，dbApplyMigration 则以 internal 拒绝 —— 半写
 *  状态不能被静默当作「无历史」）。 */
function readSidecar(file: string): { ok: true; list: DbMigration[] } | { ok: false; error: string } {
  const p = sidecarPath(file);
  if (!p || !fs.existsSync(p)) return { ok: true, list: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return { ok: false, error: `伴车文件无法解析（${p}）：${errMsg(e)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `伴车文件不是 JSON 数组（${p}）` };
  }
  const list: DbMigration[] = [];
  for (const it of parsed) {
    const rec = it as Partial<DbMigration> | null;
    if (typeof rec?.version !== "number" || typeof rec.name !== "string") {
      return { ok: false, error: `伴车文件条目非法（需 version:number + name:string）：${p}` };
    }
    list.push({ version: rec.version, name: rec.name, sql: rec.sql ?? "", appliedAt: rec.appliedAt });
  }
  return { ok: true, list };
}

/** 原子写伴车 json（tmp+rename，与 lib/memories.ts 同手法）。 */
function writeSidecar(file: string, list: DbMigration[]): void {
  const p = sidecarPath(file)!;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, p);
}

/** 读库内 _org_migrations 表 → Map<version, name>；表不存在（新库）→ 空。 */
function tableHistory(db: Database): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const rows = stmtOf(db, `SELECT version, name FROM ${MIGRATIONS_TABLE} ORDER BY version`).values();
    for (const [v, name] of rows as Array<[number, string]>) out.set(v, name);
  } catch {
    // no such table（尚未初始化）→ 空历史
  }
  return out;
}

/** 双边账本比对：不一致项清单（空 = 一致）。 */
function historyDiff(table: Map<number, string>, sidecar: DbMigration[]): string[] {
  const problems: string[] = [];
  const sc = new Map(sidecar.map((m) => [m.version, m.name] as const));
  for (const [v, name] of table) {
    if (!sc.has(v)) problems.push(`仅 _org_migrations 表有 v${v}(${name})，伴车缺失`);
    else if (sc.get(v) !== name) problems.push(`v${v} 名称不一致：表「${name}」vs 伴车「${sc.get(v)}」`);
  }
  for (const [v, name] of sc) {
    if (!table.has(v)) problems.push(`仅伴车有 v${v}(${name})，表缺失`);
  }
  return problems;
}

/** 读迁移史（伴车 <file>.migrations.json，人读 + git 友好侧）。文件不存在
 *  / 损坏 → 空表（诊断走 dbApplyMigration 的 conflict / internal 通道）。 */
export function dbMigrations(file: string): DbMigration[] {
  const r = readSidecar(file);
  return r.ok ? r.list : [];
}

/** 应用一条迁移（唯一写面）。流程：双边账本比对（不一致 → conflict 附诊
 *  断）→ 版本 = 表内最大 +1 → 事务内（建账本表 + 记账 + db.exec(sql)）→
 *  dryRun ROLLBACK / 正常 COMMIT → 伴车 json 追加（原子写）。SQL 失败整体
 *  回滚（kind:"syntax"），绝不抛异常。 */
export function dbApplyMigration(
  file: string,
  name: string,
  sql: string,
  opts?: { dryRun?: boolean },
): { ok: true; version: number; dryRun: boolean; durMs: number } |
  { ok: false; error: string; kind: "syntax" | "conflict" | "internal" } {
  const t0 = Date.now();
  const dryRun = opts?.dryRun ?? false;

  // 参数校验（调用方错误 → internal，附人读提示）
  const n = name.trim();
  if (n.length === 0 || n.length > 200) {
    return { ok: false, kind: "internal", error: `迁移名不合法（1-200 字符）：${JSON.stringify(name)}` };
  }
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return { ok: false, kind: "internal", error: "迁移 SQL 必填（多条语句用分号分隔）" };
  }

  // 伴车预读（:memory: 跳过 —— 无文件锚点）
  let sidecar: DbMigration[] = [];
  if (file !== ":memory:") {
    const r = readSidecar(file);
    if (!r.ok) return { ok: false, kind: "internal", error: r.error };
    sidecar = r.list;
  }

  // 读写连接（迁移通道允许建新库 —— 首次迁移的正当入口）。
  // v0.5.15：父目录缺失时自动补建（迁移到 data/ 等新目录是桌面场景常态；
  // 补建失败（无写权限）仍由 SQLite 报错兜底进 internal）
  let db: Database;
  try {
    if (file !== ":memory:") {
      const parent = path.dirname(path.resolve(file));
      fs.mkdirSync(parent, { recursive: true });
    }
    db = new Database(file);
  } catch (e) {
    return {
      ok: false, kind: "internal",
      error: `无法打开数据库（读写）：${errMsg(e)}（父目录不存在或无写权限？）`,
    };
  }

  try {
    // 1) 双边账本比对（在任何写入之前）
    const table = tableHistory(db);
    const problems = historyDiff(table, sidecar);
    if (problems.length > 0) {
      const head = problems.slice(0, 5).join("；");
      const more = problems.length > 5 ? `（另有 ${problems.length - 5} 项）` : "";
      return {
        ok: false, kind: "conflict",
        error: `伴车迁移史与 ${MIGRATIONS_TABLE} 表不一致：${head}${more} —— ` +
          `请人工核对（伴车 ${sidecarPath(file) ?? "（无）"} / 库 ${file}）后重试`,
      };
    }

    // 2) 版本号（表为权威）
    const version = table.size === 0 ? 1 : Math.max(...table.keys()) + 1;
    const appliedAt = new Date().toISOString();

    // 3) 事务内：建账本 + 记账 + 执行迁移 SQL；dryRun 跑完即 ROLLBACK
    try {
      db.exec("BEGIN");
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} ` +
          "(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE}(version, name, applied_at) VALUES (?, ?, ?)`)
        .run(version, n, appliedAt);
      db.exec(sql); // 多条语句允许；失败 → 外层 catch 整体回滚
      if (dryRun) db.exec("ROLLBACK");
      else db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* 事务已不在（如 BEGIN 即失败）→ 无需处理 */ }
      return { ok: false, kind: "syntax", error: `迁移 SQL 执行失败（已整体回滚）：${errMsg(e)}` };
    }

    // 4) 伴车追加（仅 COMMIT 后；dryRun / :memory: 跳过）
    if (!dryRun && file !== ":memory:") {
      try {
        writeSidecar(file, [...sidecar, { version, name: n, sql, appliedAt }]);
      } catch (e) {
        // 诚实回报半写状态：库已提交而伴车未落 —— 下次应用会被 conflict
        // 门拦下，提示人工补记
        return {
          ok: false, kind: "internal",
          error: `迁移已提交（v${version}）但伴车文件写入失败：${errMsg(e)}` +
            ` —— 请人工把该条补进 ${sidecarPath(file)}，否则下次应用将报冲突`,
        };
      }
    }

    return { ok: true, version, dryRun, durMs: Date.now() - t0 };
  } finally {
    safeClose(db);
  }
}
