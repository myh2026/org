// ============================================================================
// lib/audit.ts — 审计导出（v0.5.15 · capabilities #150 隐私模式/审计导出）
// ----------------------------------------------------------------------------
// 把一次运行（opts.run）或整个工作区的「审计面」打包成一个 zip + 一份人读
// markdown 摘要：决策事件流 / 审查日志 / LLM 流水与台账 / 审批记录 / 记分卡
// / git 资产链。这是隐私模式的可携带等价物 —— 不必交出整个工作区，审计者
// 拿到的恰好是「谁在何时凭什么做了什么、花了多少 token」的完整证据面。
//
// 审计面（缺省全工作区；work-*/factory/* 等资产目录不在面内 —— 它们是产物
// 不是审计记录）：
//   out-*/    events.jsonl · journal.jsonl · llm-stream.jsonl · run.json ·
//             metrics.json · report.md · scorecard.json（全 run）
//   runtime/  approvals/*（审批请求 + 判定回写 —— 请求文件同时是审计记录，
//             不删只标记）· llm-ledger.jsonl（LLM 调用台账）·
//             notifications.json · llm-pool.json（key 池冷却台账 —— 只含
//             指纹，落盘前已脱敏，无需二次脱敏）
//   registry/ git-chain.json（资产链）
// 指定 run（opts.run="out-a"）→ 只带该 run 的七件套 + runtime/registry
// 台账（台账是全局面，run 模式也带上 —— 「导出这次运行」的审计完整性）。
//
// zip 实现：零依赖手写容器（store，method 0 —— 不压缩）。取舍：审计面通常
// < 数 MB，压缩收益低于 deflateRaw 包装的复杂度/出错面；store 的三段结构
// （local file header + central directory + EOCD）约 120 行即可写对，且
// python3 zipfile.testzip() 可作跨实现校验（tests/audit.test.ts 实测）。
// CRC-32：优先 node:zlib.crc32（Bun ≥1.1 / Node ≥20.15 内建），缺席时查表
// 兜底（同一多项式 0xEDB88320）—— 与本仓库「优雅降级」纪律一致。
//
// 优雅降级：缺文件 → warning 后继续（不炸）；run 目录空/不存在 → warning；
// 单文件读失败逐个隔离；空工作区 → 0 条目 zip + 诚实 warning 仍 ok:true。
// 输出名缺省 <ws>/audit-export-<yyyymmdd-hhmmss>.zip，同秒重复导出加序号
// （不覆盖）；显式 opts.out 视为最终路径（调用方明示覆盖语义）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---- 审计面清单 -------------------------------------------------------------

/** run 目录七件套（缺哪件警告哪件 —— 诚实记账，不静默装满）。 */
const RUN_FILES = [
  "events.jsonl",
  "journal.jsonl",
  "llm-stream.jsonl",
  "run.json",
  "metrics.json",
  "report.md",
  "scorecard.json",
] as const;

/** 全局审计面（run 无关的台账；两种导出模式都带上）。llm-pool.json 只含
 *  key 指纹（router 侧落盘前已脱敏），无需二次脱敏。 */
const GLOBAL_FILES = [
  "runtime/llm-ledger.jsonl",
  "runtime/notifications.json",
  "runtime/llm-pool.json",
  "registry/git-chain.json",
] as const;

// ---- 零依赖 zip（store 容器）-------------------------------------------------

interface ZipEntry {
  /** entry 名（zip 内相对路径，正斜杠）。 */
  name: string;
  data: Buffer;
  mtime: Date;
}

/** node:zlib.crc32 若在（Bun ≥1.1 / Node ≥20.15），否则 undefined 走查表兜底。 */
const ZLIB_CRC32: ((data: Buffer) => number) | undefined =
  (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32;

/** CRC-32 查表兜底（reflected 0xEDB88320 / init & xorout 0xFFFFFFFF）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  if (ZLIB_CRC32) return ZLIB_CRC32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** mtime → DOS 时间/日期域（年 <1980 钳到 1980；& 0xffff 保 uint16 域）。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * 手写 zip 容器（store：method 0，不压缩）。
 *
 * 结构（全部小端；条目名 UTF-8，flags 置 0x0800）：
 *
 *   ┌─ local file header × N   0x04034b50 + 版本 20 + flags + method 0 +
 *   │                          DOS 时间/日期 + CRC32 + 压缩/未压缩尺寸（同值）
 *   │                          + 名长 + extra(0) + 名 + 数据
 *   ├─ central directory × N   0x02014b50 + 同上元信息 + 本地头偏移
 *   └─ EOCD                    0x06054b50 + 条目数 + cd 尺寸/偏移
 *
 * 不用数据描述符（尺寸/CRC 头内直写 —— 我们不是流式写入）；条目 < 65535
 * （uint16 域；审计面量级下不会触顶，触顶时 writeUInt16LE 会截断属可观察
 * 异常而非静默损坏）。校验：python3 -c "import zipfile; zipfile.ZipFile(
 * <path>).testzip()" 跨实现验证（tests/audit.test.ts 实测）。
 */
function buildZipStore(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0; // 下一个 local header 的起始偏移（central 目录回指用）

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf-8");
    const crc = crc32(e.data);
    const { time, date } = dosDateTime(e.mtime);

    const lh = Buffer.alloc(30); // local file header 固定段
    lh.writeUInt32LE(0x04034b50, 0); // 签名 "PK\x03\x04"
    lh.writeUInt16LE(20, 4); // version needed：2.0
    lh.writeUInt16LE(0x0800, 6); // flags：UTF-8 名
    lh.writeUInt16LE(0, 8); // method：store（0 = 不压缩）
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18); // compressed size（store = 原长）
    lh.writeUInt32LE(e.data.length, 22); // uncompressed size
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46); // central directory 固定段
    ch.writeUInt32LE(0x02014b50, 0); // 签名 "PK\x01\x02"
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // flags：UTF-8 名
    ch.writeUInt16LE(0, 10); // method：store
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // 本地头偏移
    centrals.push(ch, name);

    offset += 30 + name.length + e.data.length;
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22); // end of central directory
  eocd.writeUInt32LE(0x06054b50, 0); // 签名 "PK\x05\x06"
  eocd.writeUInt16LE(0, 4); // 本盘号
  eocd.writeUInt16LE(0, 6); // cd 所在盘号
  eocd.writeUInt16LE(entries.length, 8); // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 总条目数
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16); // cd 起始偏移（EOCD 第 16 字节 —— 曾误写 14 与尺寸域重叠，python testzip 锁定）
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ---- 聚合（auditSummary 与 report 共用）--------------------------------------

export interface AuditRunSummary {
  name: string;
  events: number;
  tokens: number;
  ok: boolean | null;
}

/** 读文本行（缺失/读失败 → 空数组；空行不计）。 */
function readLines(p: string): string[] {
  try {
    return fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** 读 JSON（缺失/半写/非法 → null，不炸）。 */
function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 工作区的 run 目录清单（out-* 前缀，字典序）。 */
function listRuns(ws: string): string[] {
  try {
    return fs
      .readdirSync(ws, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("out-"))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // 工作区不可读 → 无 run
  }
}

/** 审批记录数：runtime/approvals 下的请求/判定文件（granted.json 是放行集
 *  不是记录；*.reply.json 是瞬时回复通道 —— 都不计）。 */
function countApprovals(ws: string): number {
  try {
    return fs
      .readdirSync(path.join(ws, "runtime", "approvals"))
      .filter((n) => n.endsWith(".json") && !n.endsWith(".reply.json") && n !== "granted.json")
      .length;
  } catch {
    return 0;
  }
}

interface RunFacts {
  name: string;
  events: number;
  tokens: number;
  ok: boolean | null;
  first: string | null;
  last: string | null;
}

/** 单 run 审计事实：事件数（events.jsonl 行数）、token 总量（metrics）、
 *  结果（run.json.ok；缺失/非法 → null）、时间范围（事件 ts 的 min/max，
 *  ISO 串字典序即时间序；半写行逐行隔离）。 */
function runFacts(ws: string, run: string): RunFacts {
  const dir = path.join(ws, run);
  const lines = readLines(path.join(dir, "events.jsonl"));
  let first: string | null = null;
  let last: string | null = null;
  for (const l of lines) {
    try {
      const ts = (JSON.parse(l) as { ts?: unknown }).ts;
      if (typeof ts !== "string") continue;
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    } catch {
      // 半写行 → 跳过（事件流是追加式 jsonl，读侧容忍中间态）
    }
  }
  const metrics = readJson(path.join(dir, "metrics.json"));
  const runJson = readJson(path.join(dir, "run.json"));
  return {
    name: run,
    events: lines.length,
    tokens: typeof metrics?.tokens_total === "number" ? metrics.tokens_total : 0,
    ok: typeof runJson?.ok === "boolean" ? runJson.ok : null,
    first,
    last,
  };
}

/**
 * 面板用的轻量聚合（不打包）：run 清细（事件/token/结果）+ 审批记录数 +
 * LLM 台账条目数。全部读侧容错 —— 半写 JSON 按 null/0 处理。
 */
export function auditSummary(ws: string): {
  runs: AuditRunSummary[];
  approvals: number;
  ledgerEntries: number;
} {
  return {
    runs: listRuns(ws).map((r) => {
      const f = runFacts(ws, r);
      return { name: f.name, events: f.events, tokens: f.tokens, ok: f.ok };
    }),
    approvals: countApprovals(ws),
    ledgerEntries: readLines(path.join(ws, "runtime", "llm-ledger.jsonl")).length,
  };
}

// ---- 导出 -------------------------------------------------------------------

export interface AuditExport {
  /** zip + report 都写出成功（读侧永远不失败 —— 缺面降级；false 仅在写出异常）。 */
  ok: boolean;
  /** zip 绝对路径。 */
  zip: string;
  /** zip 内条目数。 */
  entries: number;
  /** zip 字节数。 */
  bytes: number;
  /** 人读摘要（同名 .md）绝对路径。 */
  report: string;
  /** 降级警告（缺文件/空 run/读失败/写出失败 —— 诚实面，不静默）。 */
  warnings: string[];
}

/** 收集审计面文件（相对 ws，正斜杠）。缺 run 文件 → 逐条警告；审批目录
 *  缺席 → 静默（常态）；全局台账缺席 → 静默（可选面，按需出现）。 */
function collectAuditFiles(ws: string, run?: string): { files: string[]; warnings: string[] } {
  const files: string[] = [];
  const warnings: string[] = [];
  const runs = run ? [run] : listRuns(ws);
  if (run) {
    if (!fs.existsSync(path.join(ws, run))) warnings.push(`run 目录不存在：${run}`);
  } else if (runs.length === 0) {
    warnings.push("工作区无 out-* 运行目录（没有运行产物可导出）");
  }
  for (const r of runs) {
    let got = 0;
    for (const f of RUN_FILES) {
      const rel = `${r}/${f}`;
      if (fs.existsSync(path.join(ws, rel))) {
        files.push(rel);
        got++;
      } else {
        warnings.push(`跳过缺失：${rel}`);
      }
    }
    if (got === 0) warnings.push(`run 目录无任何审计面文件：${r}`);
  }
  for (const rel of GLOBAL_FILES) {
    if (fs.existsSync(path.join(ws, rel))) files.push(rel);
  }
  const apDir = path.join(ws, "runtime", "approvals");
  try {
    const names = fs
      .readdirSync(apDir)
      .filter((n) => fs.statSync(path.join(apDir, n)).isFile())
      .sort();
    for (const n of names) files.push(`runtime/approvals/${n}`);
  } catch {
    // 无审批目录 → 常态，静默
  }
  return { files, warnings };
}

/** 文件名时间戳：yyyymmdd-hhmmss（本地时间 —— 文件名给人看）。 */
function timestampSlug(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同名不覆盖：audit-export-<ts>.zip → -2 → -3 …（同秒重复导出的序号语义）。 */
function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const dot = p.lastIndexOf(".");
  const base = dot > 0 ? p.slice(0, dot) : p;
  const ext = dot > 0 ? p.slice(dot) : "";
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
  return `${base}-${Date.now()}${ext}`; // 序号也撞满（理论态）→ 时间戳兜底
}

function buildReport(o: {
  ws: string;
  scope: string;
  facts: RunFacts[];
  approvals: number;
  ledger: number;
  zipName: string;
  entries: number;
  bytes: number;
  warnings: string[];
}): string {
  const totalEvents = o.facts.reduce((n, f) => n + f.events, 0);
  const totalTokens = o.facts.reduce((n, f) => n + f.tokens, 0);
  const firsts = o.facts.map((f) => f.first).filter((t): t is string => t !== null).sort();
  const lasts = o.facts.map((f) => f.last).filter((t): t is string => t !== null).sort();
  const first = firsts[0];
  const last = lasts[lasts.length - 1];

  const lines: string[] = [
    "# ORG 审计导出摘要",
    "",
    `- 工作区：${o.ws}`,
    `- 范围：${o.scope}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 产物：${o.zipName}（${o.entries} 项 · ${o.bytes} 字节 · zip store 零压缩）`,
    "",
    "## 总览",
    "",
    "| 指标 | 值 |",
    "| --- | --- |",
    `| run 数 | ${o.facts.length} |`,
    `| 事件总数 | ${totalEvents} |`,
    `| 审批记录 | ${o.approvals} |`,
    `| LLM 台账条目 | ${o.ledger} |`,
    `| token 总量 | ${totalTokens} |`,
    `| 时间范围 | ${first && last ? `${first} → ${last}` : "—"} |`,
    "",
    "## run 明细",
    "",
    "| run | 事件数 | token | 结果 |",
    "| --- | --- | --- | --- |",
  ];
  if (o.facts.length === 0) lines.push("| （无） | — | — | — |");
  for (const f of o.facts) {
    lines.push(`| ${f.name} | ${f.events} | ${f.tokens} | ${f.ok === null ? "—" : f.ok ? "ok" : "fail"} |`);
  }
  lines.push(
    "",
    "## 导出面",
    "",
    "- out-*/：events / journal / llm-stream / run / metrics / report / scorecard",
    "- runtime/approvals/：审批请求与判定回写（审计记录，不删只标记）",
    "- runtime/llm-ledger.jsonl · notifications.json · llm-pool.json：LLM 台账面（llm-pool 只含 key 指纹）",
    "- registry/git-chain.json：git 资产链",
  );
  if (o.warnings.length > 0) {
    lines.push("", `## 警告（${o.warnings.length}）`, "");
    for (const w of o.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * 审计导出：把一次运行（opts.run = run 目录名，如 "out-a"）或整个工作区的
 * 审计面打包成 zip（store 零压缩）+ 同名 .md 人读摘要。
 *
 * 降级语义：缺文件 → warnings 继续（ok 不受读侧影响）；空工作区 → 0 条目
 * zip + 诚实 warning；仅写出异常（磁盘满/路径不可写）→ ok:false。
 * 输出名：缺省 <ws>/audit-export-<yyyymmdd-hhmmss>.zip（同秒 + 序号不覆
 * 盖）；显式 opts.out 为最终路径（相对路径按进程 cwd 解析，覆盖写）。
 */
export function exportAudit(ws: string, opts?: { run?: string; out?: string }): AuditExport {
  const { files: relFiles, warnings } = collectAuditFiles(ws, opts?.run);

  // 读入审计面（读失败 → 降级警告，不炸）
  const entries: ZipEntry[] = [];
  for (const rel of relFiles) {
    const abs = path.join(ws, rel);
    try {
      const st = fs.statSync(abs);
      const data = fs.readFileSync(abs);
      entries.push({ name: rel, data, mtime: st.mtime });
    } catch {
      warnings.push(`读取失败（跳过）：${rel}`);
    }
  }

  // 聚合（report 用）：指定 run 目录缺席 → 空 facts（警告已在收集阶段给出）
  const runNames = opts?.run
    ? fs.existsSync(path.join(ws, opts.run))
      ? [opts.run]
      : []
    : listRuns(ws);
  const facts = runNames.map((r) => runFacts(ws, r));
  const approvals = countApprovals(ws);
  const ledger = readLines(path.join(ws, "runtime", "llm-ledger.jsonl")).length;

  const zipPath = opts?.out
    ? path.resolve(opts.out)
    : uniquePath(path.join(ws, `audit-export-${timestampSlug()}.zip`));
  const reportPath = zipPath.replace(/\.zip$/i, "") + ".md";
  const scope = opts?.run ? `单 run：${opts.run}` : `全工作区（${facts.length} 个 run）`;

  try {
    const buf = buildZipStore(entries);
    const md = buildReport({
      ws: path.resolve(ws),
      scope,
      facts,
      approvals,
      ledger,
      zipName: path.basename(zipPath),
      entries: entries.length,
      bytes: buf.length,
      warnings,
    });
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.writeFileSync(zipPath, buf);
    fs.writeFileSync(reportPath, md, "utf-8");
    return { ok: true, zip: zipPath, entries: entries.length, bytes: buf.length, report: reportPath, warnings };
  } catch (e) {
    warnings.push(`写出失败：${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, zip: zipPath, entries: entries.length, bytes: 0, report: reportPath, warnings };
  }
}
