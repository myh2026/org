// ============================================================================
// lib/dbdiag.ts — 数据库查询诊断器（v0.5.16 · capabilities #113）
// ----------------------------------------------------------------------------
// 「这条 SQL 为什么慢」的零执行诊断：在只读 SQLite 连接上跑 EXPLAIN QUERY
// PLAN（纯计划分析，不执行查询本体 —— 大表也不会被拖去全量计算），解析计
// 划步骤，识别全表扫描（SCAN）vs 索引命中（SEARCH … USING INDEX），并给出
// 人读建议。单一入口：
//   · dbDiagnose(file, sql, {setup?}) → 计划步骤 / 涉及表 / fullScan 标记 /
//     suggestions 建议 / 耗时
//
// 【只读门 —— 复用 lib/db.ts 的哲学，白名单更窄 + 写动词骨架扫描】
//   语句经与 db.ts 同构的词法扫描器剥除注释 / 字符串 / 引号标识符后：① 必
//   须是单条语句（唯一分号只许在句尾）；② 前导词 ∈ {SELECT, WITH} —— 比
//   dbQuery 的白名单（SELECT/WITH/EXPLAIN/PRAGMA）更窄：EXPLAIN 前缀由本
//   模块自己拼（调用方传 EXPLAIN 反而被拒），诊断通道不放行 PRAGMA；
//   ③ 骨架里不许出现写动词（INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/
//   ATTACH/DETACH/VACUUM/REINDEX/REPLACE-语句形态）—— 堵住 dbQuery 词法层
//   已知的漏网面（WITH…INSERT 前导词合法）：dbQuery 靠内核在执行时拦，而
//   诊断通道永不执行（EQP 纯计划，实测 WITH…INSERT 的 EQP 返回空计划且零
//   写入），词法层就是唯一边界，故在此收口。误伤面诚实声明：replace() 函
//   数调用用负向先行豁免（后接 "(" 的是函数不是语句）；骨架里出现裸写动
//   词且非语句形态的场景（如未被引号包裹的同名列）本就是非法 SQL（保留
//   字不可作裸标识符），到不了这里。
//   连接层（第二层防御，惰性先手）：文件库以 readonly:true 打开，内核拒绝
//   一切写入 —— 即便未来某路径意外执行语句，这层仍在（实测 EQP 路径零
//   写入，本层是纵深防御的冗余层）。
//
// [:memory: 语义 + setup 播种]  file === ":memory:" 时每次调用新开一个瞬态
//   库（与 db.ts 同规）。诊断需要表 / 索引存在才有意义，故提供 opts.setup
//   —— 播种 SQL（允许多条语句），仅在 :memory: 通道生效：写面只及于当次
//   调用的临时副本，连接关闭即蒸发，无持久化风险。文件库传 setup →
//   kind:"denied"（诚实拒绝而非静默忽略 —— 文件库的写面只属于
//   dbApplyMigration 通道）。setup 超过 256KB → kind:"internal"（预算面）。
//
// 【错误分型】missing=文件不存在 / 不是常规文件 / 不是有效 SQLite 库（任务
//   口径：非库也归 missing，消息里写明原因）· denied=词法门拒 · syntax=
//   SQLite 编译 / 执行报错统称（附原始 message，含 no such table）·
//   internal=打开 / IO 等内部错误。全部 { ok:false, kind, error } 结构化
//   返回，绝不抛异常（优雅降级铁律）。
//
// 【解析口径与诚实边界】
//   · EQP 输出四列 [id, parent, notused, detail]（bun:sqlite 1.3.14 实测）；
//     notused 列如实丢弃，不做解读。
//   · usesIndex：detail 含 USING INDEX / USING COVERING INDEX / USING
//     INTEGER PRIMARY KEY 任一形态。
//   · fullScan：任一步骤是「裸 SCAN 表」（SCAN 无 USING 修饰）—— 经典全表
//     扫描。SCAN … USING COVERING INDEX（全索引扫描）不算 fullScan 但会单
//     独给一条建议：它仍要遍历整棵索引，只是比扫表便宜。
//   · tables：SCAN/SEARCH 步骤的表名（或别名 —— 查询用了别名时 EQP 报的就
//     是别名，本模块不反解真实表名，如实呈现）；按出现次序去重。子查询 /
//     UNION 分支的表也收录。SUBQUERY/CO-ROUTINE/MATERIALIZE 等非表访问步骤
//     不入 tables。
//   · 「无 WHERE」判定在剥注释 / 字符串后的骨架上做 \b 词边界匹配 ——
//     字符串里的 where / 列名 weather / somewhere 均不误伤；`SELECT where
//     FROM t` 这类把保留字当列名的病态语句本就过不了 SQLite 语法关（先报
//     syntax），到不了这一步。
//   · 步骤帽 500：超帽截断并在 suggestions 里如实标注（计划不完整）。
//   · 同步模型说明：bun:sqlite 是同步执行模型，EQP 是纯元数据操作（不跑
//     查询本体），实测毫秒级；本函数签名是 async —— 为将来把诊断挪进
//     worker 线程（配 wall-clock 超时）预留的 API 面，当前实现体同步完成。
// ============================================================================

import { Database } from "bun:sqlite";
import * as fs from "node:fs";

// ---- 常量（预算面）----------------------------------------------------------

/** 诊断通道预算。 */
export const DBDIAG_LIMITS = {
  /** :memory: 播种 SQL 的尺寸帽（防巨型 setup 拖死瞬态通道）。 */
  maxSetupBytes: 256 * 1024,
  /** 计划步骤帽：超过即截断（suggestions 里如实标注）。 */
  maxSteps: 500,
} as const;

/** 只读门允许的前导词（小写）—— 比 dbQuery 的白名单更窄，见文件头。 */
const LEADING_WHITELIST = new Set(["select", "with"]);

/** 写动词骨架扫描（剥注释 / 字符串后）：堵 WITH…INSERT 类前导词合法的写
 *  句（见文件头「只读门」③）。replace 的函数形态（后接 "("）豁免。误伤
 *  边界：created_at / attachments 这类前后缀词不命中（\b 词边界），保留字
 *  不可作裸标识符（引号包裹会被剥除）。 */
const WRITE_VERB_RE = /\b(?:insert|update|delete|create|drop|alter|attach|detach|vacuum|reindex)\b|\breplace\b(?!\s*\()/i;

// ---- 类型 -------------------------------------------------------------------

/** 一条 EXPLAIN QUERY PLAN 步骤（detail 原样保留，usesIndex 为解析增值）。 */
export interface DbDiagStep {
  /** 步骤 id（SQLite 计划树节点号；与 parent 构成树结构）。 */
  id: number;
  /** 父步骤 id（根步骤为 0）。 */
  parent: number;
  /** 计划细节原文（如 "SCAN author" / "SEARCH a USING INDEX i (name=?)"）。 */
  detail: string;
  /** detail 命中索引访问形态（USING INDEX / COVERING INDEX / INTEGER
   *  PRIMARY KEY）时为 true；纯表扫描 / 非访问步骤不设。 */
  usesIndex?: boolean;
}

/** 解析后的查询计划。 */
export interface DbDiagnosePlan {
  /** 计划步骤（EQP 输出序；步骤帽截断后是前 maxSteps 条）。 */
  steps: DbDiagStep[];
  /** 计划涉及的表 / 别名清单（SCAN/SEARCH 步骤提取，按出现次序去重）。 */
  tables: string[];
  /** 任一裸 SCAN（无 USING 修饰的全表扫描）时为 true。 */
  fullScan: boolean;
}

/** dbDiagnose 的失败分型（语义见文件头「错误分型」）。 */
export type DbDiagnoseError =
  | { ok: false; kind: "denied"; error: string }
  | { ok: false; kind: "syntax"; error: string }
  | { ok: false; kind: "missing"; error: string }
  | { ok: false; kind: "internal"; error: string };

/** dbDiagnose 完整结果（成功联合 / 失败联合）。 */
export type DbDiagnoseResult =
  | { ok: true; plan: DbDiagnosePlan; suggestions: string[]; ms: number }
  | DbDiagnoseError;

/** dbDiagnose 选项。 */
export interface DbDiagnoseOpts {
  /** 播种 SQL（建表 / 建索引 / 灌数据，允许多条语句）。仅 :memory: 通道
   *  生效 —— 文件库传 setup 会被 kind:"denied" 拒绝（写面属于迁移通道）。 */
  setup?: string;
}

// ---- 词法扫描器（与 lib/db.ts 同构，本模块独立持有一份窄化版）----------------

/** SQL 词法扫描：剥除行注释 / 块注释 / 单引号字符串 / 引号标识符（含 MS
 *  方括号），剥除区域替换为单个空格保持词元分隔。语义与 db.ts 的 scanSql
 *  一致 —— `-- DROP TABLE t` 里的 DROP 不参与只读门判定；`SELECT ';'` 里
 *  的分号不是语句分隔符。 */
function scanSql(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const c2 = i + 1 < n ? sql[i + 1] : "";
    if (c === "-" && c2 === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out.push(" ");
    } else if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && i + 1 < n && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out.push(" ");
    } else if (c === "'" || c === '"' || c === "`") {
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
      i++;
      while (i < n && sql[i] !== "]") i++;
      i = Math.min(i + 1, n);
      out.push(" ");
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

/** 只读门判定：通过返回剥注释后的代码骨架；被拒返回人读原因（kind 恒为
 *  "denied"）。规则：非空 + 单语句（唯一分号只许句尾）+ 前导词 ∈
 *  {SELECT, WITH} + 骨架无写动词（三层语义见文件头「只读门」①②③）。 */
function diagGate(sql: string): { ok: true; stripped: string } | { ok: false; reason: string } {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return { ok: false, reason: "空语句（或仅注释）" };
  }
  const stripped = scanSql(sql);
  const body = stripped.replace(/;\s*$/, "");
  if (body.includes(";")) return { ok: false, reason: "多语句（诊断通道仅接受单条语句）" };
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: "空语句（或仅注释）" };
  const word = trimmed.match(/^[A-Za-z_]+/)?.[0]?.toLowerCase() ?? "";
  if (!LEADING_WHITELIST.has(word)) {
    return {
      ok: false,
      reason: `前导词「${word || "?"}」不在诊断白名单（SELECT/WITH —— EXPLAIN 由诊断器自己拼接，写操作请走 dbApplyMigration 通道）`,
    };
  }
  if (WRITE_VERB_RE.test(trimmed)) {
    return {
      ok: false,
      reason: "写语句不在诊断通道（含 WITH…INSERT 这类前导词合法的写句；写操作请走 dbApplyMigration 通道）",
    };
  }
  return { ok: true, stripped: trimmed };
}

// ---- 计划解析 ----------------------------------------------------------------

/** 索引访问形态（bun:sqlite 1.3.14 + SQLite ≥3.36 计划格式实测）。 */
const INDEX_RE = /\bUSING\s+(?:COVERING\s+)?(?:INDEX|INTEGER PRIMARY KEY)\b/i;
/** 表访问步骤（SCAN 全扫 / SEARCH 定点查找）。 */
const ACCESS_RE = /^(SCAN|SEARCH)\s+(\S+)(?:\s|$)/i;
/** 裸表扫描（SCAN 无 USING 修饰）—— 经典全表扫描。 */
const BARE_SCAN_RE = /^SCAN\s+/i;
/** 伪表访问步骤（实测 SQLite ≥3.36：SELECT 1 这类无 FROM 常量查询报
 *  「SCAN CONSTANT ROW」—— 不是表访问，不入 tables 也不算 fullScan）。 */
const PSEUDO_RE = /^SCAN\s+CONSTANT ROW$/i;

/** 剥除表名的引号包裹（"t" / [t] / `t` → t；未包裹原样）。 */
function unquoteTable(tok: string): string {
  if (tok.length >= 2) {
    const first = tok[0]!;
    const last = tok[tok.length - 1]!;
    if ((first === '"' && last === '"') || (first === "`" && last === "`") || (first === "[" && last === "]")) {
      return tok.slice(1, -1);
    }
  }
  return tok;
}

/** 解析 EQP 原始行 → 步骤 + 表访问增值信息。 */
function parsePlan(rows: unknown[][]): { steps: DbDiagStep[]; tables: string[]; fullScan: boolean; truncated: boolean } {
  const steps: DbDiagStep[] = [];
  const tables: string[] = [];
  const seen = new Set<string>();
  let fullScan = false;
  let truncated = false;
  for (const row of rows) {
    if (steps.length >= DBDIAG_LIMITS.maxSteps) { truncated = true; break; }
    const [id, parent, , detail] = row as [number, number, unknown, string];
    const text = typeof detail === "string" ? detail : String(detail ?? "");
    const step: DbDiagStep = { id, parent, detail: text };
    if (INDEX_RE.test(text)) step.usesIndex = true;
    steps.push(step);
    if (PSEUDO_RE.test(text)) continue; // SCAN CONSTANT ROW：伪表访问，不计
    const m = text.match(ACCESS_RE);
    if (m) {
      const table = unquoteTable(m[2]!);
      if (!seen.has(table)) { seen.add(table); tables.push(table); }
      if (BARE_SCAN_RE.test(text) && !step.usesIndex) fullScan = true;
    }
  }
  return { steps, tables, fullScan, truncated };
}

/** 建议生成（人读；空数组 = 没发现值得提醒的点）。 */
function buildSuggestions(
  planSteps: DbDiagStep[],
  tables: string[],
  fullScan: boolean,
  strippedSql: string,
  truncated: boolean,
): string[] {
  const out: string[] = [];
  // 1) 裸全表扫描的表（去重，按首次出现序）
  const bareScanTables: string[] = [];
  const idxScanTables: string[] = [];
  for (const s of planSteps) {
    if (PSEUDO_RE.test(s.detail)) continue; // 伪表访问（SCAN CONSTANT ROW）
    if (!ACCESS_RE.test(s.detail)) continue;
    const m = s.detail.match(ACCESS_RE)!;
    const t = unquoteTable(m[2]!);
    if (BARE_SCAN_RE.test(s.detail) && !s.usesIndex) {
      if (!bareScanTables.includes(t)) bareScanTables.push(t);
    } else if (BARE_SCAN_RE.test(s.detail) && s.usesIndex) {
      // SCAN … USING INDEX/COVERING INDEX：全索引扫描（仍遍历整棵索引）
      if (!idxScanTables.includes(t)) idxScanTables.push(t);
    }
  }
  for (const t of bareScanTables) {
    out.push(`表 ${t} 全表扫描：考虑为 WHERE / JOIN / ORDER BY 涉及的列建索引`);
  }
  for (const t of idxScanTables) {
    out.push(`表 ${t} 全索引扫描（SCAN … USING INDEX）：仍需遍历全部条目，确认无法改为等值 / 范围查找`);
  }
  // 2) 无 WHERE 的全量读（只在确有表访问时提醒 —— SELECT 1 之类无表查询不打扰）
  if (tables.length > 0 && !/\bwhere\b/i.test(strippedSql)) {
    out.push("查询无 WHERE：确认是否故意全量（可用 LIMIT 控制返回量）");
  }
  // 3) 临时 B-树（排序 / 去重 / 分组无索引支撑）
  if (planSteps.some((s) => /USE TEMP B-TREE/i.test(s.detail))) {
    out.push("排序 / 去重走临时 B-树：为 ORDER BY / GROUP BY / DISTINCT 涉及的列建索引可免去临时结构");
  }
  if (truncated) {
    out.push(`计划步骤超过 ${DBDIAG_LIMITS.maxSteps} 已截断：诊断基于不完整计划（可拆分查询后分次诊断）`);
  }
  return out;
}

// ---- 连接与错误分型 -----------------------------------------------------------

/** 异常 → 人读 message（非 Error 对象也兜住）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SQLite / 打开报错分型：非库文件 → missing（任务口径，消息写明）；其余
 *  在诊断通道语境下归 syntax（附原始 message）或 internal（打开 / IO）。 */
function classify(e: unknown, where: string): DbDiagnoseError {
  const m = errMsg(e);
  if (/file is not a database/i.test(m)) {
    return { ok: false, kind: "missing", error: `文件不是有效的 SQLite 数据库：${m}` };
  }
  if (/attempt to write a readonly database|not authorized/i.test(m)) {
    // 第二层防御的观测面：词法漏网写句 / 越权函数被内核拦下
    return { ok: false, kind: "denied", error: `只读连接拒绝：${m}（诊断通道零写入）` };
  }
  if (where === "open") {
    return { ok: false, kind: "internal", error: `无法打开数据库（只读）：${m}` };
  }
  return { ok: false, kind: "syntax", error: `SQLite 报错：${m}` };
}

// ---- 主入口 --------------------------------------------------------------------

/** 诊断一条只读查询的执行计划。绝不抛异常：成功 {ok:true, plan, suggestions,
 *  ms}；失败 {ok:false, kind, error}（分型见文件头）。:memory: 每次调用新开
 *  瞬态库，opts.setup 仅在 :memory: 通道生效（文件库传 setup → denied）。 */
export async function dbDiagnose(
  file: string,
  sql: string,
  opts?: DbDiagnoseOpts,
): Promise<DbDiagnoseResult> {
  const t0 = Date.now();

  // 参数与播种守卫（先于一切文件操作 —— 快速失败）
  const setup = opts?.setup;
  if (setup !== undefined) {
    if (typeof setup !== "string" || setup.trim().length === 0) {
      return { ok: false, kind: "internal", error: "opts.setup 必须是非空字符串（省略则不播种）" };
    }
    if (file !== ":memory:") {
      return {
        ok: false, kind: "denied",
        error: "opts.setup 仅支持 :memory: 瞬态库（文件库的写面属于 dbApplyMigration 通道）",
      };
    }
    if (Buffer.byteLength(setup, "utf8") > DBDIAG_LIMITS.maxSetupBytes) {
      return {
        ok: false, kind: "internal",
        error: `播种 SQL ${Buffer.byteLength(setup, "utf8")} 字节超出 ${DBDIAG_LIMITS.maxSetupBytes}（256KB）预算`,
      };
    }
  }

  // 第一层：词法只读门（白名单 SELECT/WITH，见文件头）
  const gate = diagGate(sql);
  if (!gate.ok) {
    return { ok: false, kind: "denied", error: `诊断门拒绝：${gate.reason}` };
  }

  // 打开连接：文件 → readonly:true（第二层防御载体）；:memory: → 读写瞬态
  let db: Database;
  if (file === ":memory:") {
    try {
      db = new Database(":memory:");
    } catch (e) {
      return classify(e, "open");
    }
  } else {
    if (!fs.existsSync(file)) {
      return {
        ok: false, kind: "missing",
        error: `数据库文件不存在：${file}（诊断需要已存在的库；新库请用 dbApplyMigration 初始化）`,
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
    try {
      db = new Database(file, { readonly: true });
    } catch (e) {
      return classify(e, "open");
    }
  }

  try {
    // :memory: 播种（瞬态副本上的写面，见文件头；setup 失败 → syntax 附原文）
    if (file === ":memory:" && setup !== undefined) {
      try {
        db.exec(setup);
      } catch (e) {
        return {
          ok: false, kind: "syntax",
          error: `播种 SQL 执行失败（瞬态库，未留任何痕迹）：${errMsg(e)}`,
        };
      }
    }
    // 计划分析（EXPLAIN 前缀由本模块拼接 —— 调用方只提供被诊断的查询本体）
    let raw: unknown[][];
    try {
      const st = db.prepare(`EXPLAIN QUERY PLAN ${sql}`) as unknown as {
        values(): unknown[][];
        finalize(): void;
      };
      try {
        raw = st.values();
      } finally {
        try { st.finalize(); } catch { /* 已终结 */ }
      }
    } catch (e) {
      return classify(e, "prepare");
    }
    const { steps, tables, fullScan, truncated } = parsePlan(raw);
    const suggestions = buildSuggestions(steps, tables, fullScan, gate.stripped, truncated);
    return { ok: true, plan: { steps, tables, fullScan }, suggestions, ms: Date.now() - t0 };
  } finally {
    try { db.close(); } catch { /* 连接已关 → 无需处理 */ }
  }
}
