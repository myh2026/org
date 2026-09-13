// ============================================================================
// lib/schedule.ts — 定时任务触发器（v0.5.5）
// ----------------------------------------------------------------------------
// 「定时任务」的单一实现，taskd / web 内嵌执行器的队列泵之上挂载：
//
//   表达式        五段 cron（分 时 日 月 周）—— * / */n / a-b / a,b 组合，
//                dom-dow 按 Vixie 语义（两者都 * 才是每天，否则 OR）；
//                简化式 @every 30s|10m|2h|1d（固定间隔，秒级粒度）
//   文件协议      <ws>/runtime/schedules/<id>.json（原子写 + journal 审计）
//   触发          next_run ≤ now → 领取（先推进 next_run 再入队，双重读
//                防双执行器并发双发）→ submitTask 入队（复用 v0.5.2 队列）
//   错过策略      misfire=skip（缺省，错过即跳到下个周期）/ run（补跑一次
//                再跳周期）—— 长离线（休眠）后不风暴
//   多重优雅降级  无执行器在跑 → 记录照常推进，任务躺在队列（org taskd /
//                org web 启动即领取）；表达式坏 → 条目标 invalid 不炸循环
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

export type ScheduleKind = "run" | "ask";

export interface ScheduleSpec {
  /** run：团队派单任务描述。 */
  task?: string;
  /** ask：专家名 + 问题。 */
  expert?: string;
  question?: string;
  model: string;
}

export interface ScheduleRecord {
  id: string;
  expr: string;
  enabled: boolean;
  kind: ScheduleKind;
  spec: ScheduleSpec;
  /** 触发即提交的任务通知开关。 */
  notify: boolean;
  created_at: string;
  /** 最近一次触发时间（ISO；从未触发为空）。 */
  last_run?: string;
  /** 下一次触发时间（ISO；invalid/暂停语义由 enabled 表达）。 */
  next_run: string;
  /** 已触发次数。 */
  runs: number;
  /** 错过策略：skip（缺省）/ run。 */
  misfire: "skip" | "run";
  /** 表达式解析失败 → 如实标注（循环不炸，list 可见）。 */
  invalid?: string;
}

const SCHEDULES_DIR = "runtime/schedules";
const SAFE_SCHEDULE_ID = /^s-[a-z0-9]+-[a-z0-9]+$/;
/** 逐分钟扫描上限（366 天防死循环）。 */
const MAX_SCAN_MINUTES = 366 * 24 * 60;
/** 领取时的容差（时钟偏差 2 分钟内视为「错过」而非「未到」）。 */
const MISFIRE_GRACE_MS = 2 * 60_000;

function schedulesDir(ws: string): string {
  return path.join(ws, SCHEDULES_DIR);
}

function scheduleFile(ws: string, id: string): string | null {
  if (!SAFE_SCHEDULE_ID.test(id)) return null;
  return path.join(schedulesDir(ws), `${id}.json`);
}

function journalFile(ws: string, id: string): string | null {
  if (!SAFE_SCHEDULE_ID.test(id)) return null;
  return path.join(schedulesDir(ws), `${id}.journal.jsonl`);
}

function newScheduleId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
}

function journal(ws: string, id: string, event: string, detail: string): void {
  const file = journalFile(ws, id);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()}|${event}|${detail}\n`, "utf-8");
  } catch { /* 审计失败静默 */ }
}

// ---- 表达式解析 ----------------------------------------------------------------

export interface CronFields {
  /** 分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6, 0=周日)。 */
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** dom/dow 是否都是 *（决定 Vixie OR 语义的分支）。 */
  domStar: boolean;
  dowStar: boolean;
}

export interface ParsedExpr {
  kind: "cron";
  fields: CronFields;
  /** 原始表达式（显示用）。 */
  raw: string;
}

export interface ParsedEvery {
  kind: "every";
  /** 间隔毫秒。 */
  ms: number;
  raw: string;
}

export type ParsedScheduleExpr = ParsedExpr | ParsedEvery;

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 7],  // dow（7 视作 0 = 周日，解析时归一）
];

const EVERY_RE = /^@every\s+(\d+)\s*(s|m|h|d)$/i;

/**
 * 解析表达式：五段 cron 或 @every。返回 null = 语法非法（调用方如实标注）。
 * 例：分钟段写 0,15,30,45（即每 15 分钟）；"0 9-17 ... 1-5" = 工作日
 * 9-17 点整点；"@every 30m" = 每 30 分钟。
 */
export function parseExpr(raw: string): ParsedScheduleExpr | null {
  const expr = raw.trim().replace(/\s+/g, " ");
  if (expr.length === 0) return null;
  const every = expr.match(EVERY_RE);
  if (every) {
    const n = Number(every[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = every[2]!.toLowerCase();
    const ms = unit === "s" ? n * 1_000 : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return { kind: "every", ms, raw: expr };
  }
  if (expr.toLowerCase().startsWith("@")) return null; // 其他 @ 形式不支持
  const parts = expr.split(" ");
  if (parts.length !== 5) return null;
  const sets: Array<Set<number>> = [];
  const stars: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i]!, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1], i === 4);
    if (!parsed) return null;
    sets.push(parsed.values);
    stars.push(parsed.star);
  }
  return {
    kind: "cron",
    fields: { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow: sets[4]!, domStar: stars[2]!, dowStar: stars[4]! },
    raw: expr,
  };
}

/** 单段解析：星号 / 步进（如 0,15,30,45 或等价写法）/ 范围 / 列表（dow 的 7 归一为 0）。 */
function parseField(
  field: string,
  min: number,
  max: number,
  isDow: boolean,
): { values: Set<number>; star: boolean } | null {
  const values = new Set<number>();
  let star = false;
  for (const piece of field.split(",")) {
    const seg = piece.trim();
    if (seg.length === 0) return null;
    let rangeMin = min;
    let rangeMax = max;
    let step = 1;
    let body = seg;
    const slash = seg.indexOf("/");
    if (slash >= 0) {
      body = seg.slice(0, slash);
      step = Number(seg.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    if (body === "*") {
      if (slash >= 0 && seg === "*/1") { /* 等价 * */ }
      if (seg === "*") star = true;
    } else if (body.includes("-")) {
      const [aRaw, bRaw] = body.split("-");
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      rangeMin = a;
      rangeMax = b;
      if (rangeMin > rangeMax) return null;
    } else {
      const v = Number(body);
      if (!Number.isInteger(v)) return null;
      rangeMin = v;
      rangeMax = v;
    }
    for (let v = rangeMin; v <= rangeMax; v += step) {
      if (v < min || v > max) return null; // 越界即非法（cron 惯例）
      values.add(isDow && v === 7 ? 0 : v);
    }
  }
  if (values.size === 0) return null;
  return { values, star };
}

/** cron 字段是否命中日期（Vixie dom/dow OR 语义）。 */
function cronMatches(f: CronFields, d: Date): boolean {
  const minute = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const dom = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const dow = d.getUTCDay();
  if (!f.minute.has(minute) || !f.hour.has(hour) || !f.month.has(month)) return false;
  if (f.domStar && f.dowStar) return true; // 都是 * → 每天
  if (f.domStar) return f.dow.has(dow);    // 只有 dow 限定
  if (f.dowStar) return f.dom.has(dom);    // 只有 dom 限定
  return f.dom.has(dom) || f.dow.has(dow); // 两者都限定 → OR（Vixie）
}

/**
 * 下一个触发点（cron 逐分钟扫描；every = from + ms）。
 * 时间基准 UTC（无时区争议，测试确定）。返回 null = 不可解析。
 */
export function nextAfter(raw: string, from: Date): Date | null {
  const parsed = parseExpr(raw);
  if (!parsed) return null;
  if (parsed.kind === "every") return new Date(from.getTime() + parsed.ms);
  // 从「from 的下一分钟对齐」开始扫（秒/毫秒归零）
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (cronMatches(parsed.fields, start)) return new Date(start.getTime());
    start.setUTCMinutes(start.getUTCMinutes() + 1);
  }
  return null; // 366 天内无命中（如 2 月 30 日）
}

/** 表达式的人类可读预览（org schedule test：未来 3 个触发点）。 */
export function previewNext(raw: string, from: Date, count = 3): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from.getTime());
  for (let i = 0; i < count; i++) {
    const n = nextAfter(raw, cursor);
    if (!n) break;
    out.push(n);
    cursor = n;
  }
  return out;
}

// ---- 文件协议 ------------------------------------------------------------------

export function listSchedules(ws: string): ScheduleRecord[] {
  const out: ScheduleRecord[] = [];
  try {
    const dir = schedulesDir(ws);
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json") || name.includes(".tmp-") || name.startsWith(".")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as unknown;
        if (raw === null || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.id !== "string" || typeof r.expr !== "string") continue;
        out.push(normalize(r));
      } catch { /* 坏文件跳过（列表不炸） */ }
    }
  } catch { /* 目录缺失按空 */ }
  // 稳定排序：next_run 升序（同刻 id 兜底 —— 列表确定性）
  out.sort((a, b) => (a.next_run === b.next_run ? (a.id < b.id ? -1 : 1) : a.next_run < b.next_run ? -1 : 1));
  return out;
}

function readSchedule(ws: string, id: string): ScheduleRecord | null {
  const file = scheduleFile(ws, id);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (raw === null || typeof raw !== "object") return null;
    return normalize(raw as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** 未知字段宽容（前向兼容）+ 缺省值补全。 */
function normalize(raw: Record<string, unknown>): ScheduleRecord {
  const expr = String(raw.expr ?? "");
  const parsed = parseExpr(expr);
  const base: ScheduleRecord = {
    id: String(raw.id ?? ""),
    expr,
    enabled: raw.enabled !== false,
    kind: raw.kind === "ask" ? "ask" : "run",
    spec: {
      task: raw.spec && typeof raw.spec === "object" ? String((raw.spec as Record<string, unknown>).task ?? "") : "",
      expert: raw.spec && typeof raw.spec === "object" ? String((raw.spec as Record<string, unknown>).expert ?? "") : "",
      question: raw.spec && typeof raw.spec === "object" ? String((raw.spec as Record<string, unknown>).question ?? "") : "",
      model: raw.spec && typeof raw.spec === "object" ? String((raw.spec as Record<string, unknown>).model ?? "scripted") : "scripted",
    },
    notify: raw.notify !== false,
    created_at: String(raw.created_at ?? new Date().toISOString()),
    last_run: raw.last_run ? String(raw.last_run) : undefined,
    next_run: String(raw.next_run ?? new Date().toISOString()),
    runs: Number(raw.runs ?? 0) || 0,
    misfire: raw.misfire === "run" ? "run" : "skip",
  };
  if (!parsed) base.invalid = "表达式不可解析";
  return base;
}

function writeSchedule(ws: string, r: ScheduleRecord): void {
  const file = scheduleFile(ws, r.id);
  if (!file) throw new Error("非法 schedule id");
  atomicWrite(file, JSON.stringify(r, null, 2) + "\n");
}

export interface AddScheduleOpts {
  enabled?: boolean;
  notify?: boolean;
  misfire?: "skip" | "run";
  id?: string;
  now?: Date;
}

export function addSchedule(
  ws: string,
  expr: string,
  kind: ScheduleKind,
  spec: ScheduleSpec,
  opts: AddScheduleOpts = {},
): ScheduleRecord {
  if (kind === "run" && !(spec.task ?? "").trim()) throw new Error("run 定时必填 task");
  if (kind === "ask") {
    if (!(spec.expert ?? "").trim()) throw new Error("ask 定时必填 expert");
    if (!(spec.question ?? "").trim()) throw new Error("ask 定时必填 question");
  }
  const now = opts.now ?? new Date();
  const next = nextAfter(expr, now);
  const r: ScheduleRecord = {
    id: opts.id ?? newScheduleId(),
    expr: expr.trim(),
    enabled: opts.enabled ?? true,
    kind,
    spec,
    notify: opts.notify ?? true,
    created_at: now.toISOString(),
    next_run: (next ?? now).toISOString(),
    runs: 0,
    misfire: opts.misfire ?? "skip",
    ...(next ? {} : { invalid: "表达式不可解析" }),
  };
  writeSchedule(ws, r);
  journal(ws, r.id, "added", `${expr} · ${kind} · 下次 ${r.next_run}`);
  return r;
}

export function removeSchedule(ws: string, id: string): boolean {
  const file = scheduleFile(ws, id);
  if (!file) throw new Error("非法 schedule id");
  const existed = fs.existsSync(file);
  try { fs.rmSync(file, { force: true }); } catch { /* 不存在 */ }
  const jf = journalFile(ws, id);
  if (jf) { try { fs.rmSync(jf, { force: true }); } catch { /* 不存在 */ } }
  if (existed) journal(ws, id, "removed", "手动删除");
  return existed;
}

export function setScheduleEnabled(ws: string, id: string, enabled: boolean): ScheduleRecord | null {
  const r = readSchedule(ws, id);
  if (!r) return null;
  r.enabled = enabled;
  // 重新启用 → next_run 从当下重算（不追旧账）
  if (enabled) {
    const next = nextAfter(r.expr, new Date());
    if (next) {
      r.next_run = next.toISOString();
      r.invalid = undefined;
    } else {
      r.invalid = "表达式不可解析";
    }
  }
  writeSchedule(ws, r);
  journal(ws, id, enabled ? "enabled" : "disabled", `next_run=${r.next_run}`);
  return r;
}

// ---- 到期领取（防双发） ----------------------------------------------------------

export interface DueSchedules {
  /** 到期领取到的条目（调用方据此 submitTask）。 */
  due: ScheduleRecord[];
  /** 本次跳过补跑的条目（misfire=skip 且错过超容差）。 */
  skipped: Array<{ id: string; missedBy: string }>;
}

/**
 * 领取到期条目：next_run ≤ now → 立即推进 next_run（落盘）再返回。
 * 双重读（读 → 判定 → 重读验证 → 写）—— 第二个执行器 tick 到时
 * next_run 已被推进，天然空手而归（双执行器被 runner lock 排他，此为
 * 极端窗口兜底）。
 */
export function dueSchedules(ws: string, now: Date = new Date()): DueSchedules {
  const out: DueSchedules = { due: [], skipped: [] };
  for (const r of listSchedules(ws)) {
    if (!r.enabled || r.invalid) continue;
    const nextMs = Date.parse(r.next_run);
    if (!Number.isFinite(nextMs)) continue;
    if (nextMs > now.getTime()) continue; // 未到期
    // 错过判定：超过容差 → misfire 策略
    const lateBy = now.getTime() - nextMs;
    // 重读验证（并发窗口兜底：别人可能已推进）
    const fresh = readSchedule(ws, r.id);
    if (!fresh || !fresh.enabled || Date.parse(fresh.next_run) > now.getTime()) continue;
    const next = nextAfter(fresh.expr, now);
    const cur: ScheduleRecord = { ...fresh };
    if (lateBy > MISFIRE_GRACE_MS && fresh.misfire === "skip") {
      // 跳过本周期：只推进时间，不入队
      cur.next_run = (next ?? new Date(now.getTime() + 3_600_000)).toISOString();
      cur.last_run = now.toISOString();
      writeSchedule(ws, cur);
      journal(ws, cur.id, "misfire_skip", `迟到 ${Math.round(lateBy / 60_000)} 分钟跳过`);
      out.skipped.push({ id: cur.id, missedBy: `${Math.round(lateBy / 60_000)} 分钟` });
      continue;
    }
    // 正常触发（或 misfire=run 补跑一次）：先推进落盘（防双发），再返回
    cur.next_run = (next ?? new Date(now.getTime() + 3_600_000)).toISOString();
    cur.last_run = now.toISOString();
    cur.runs = fresh.runs + 1;
    writeSchedule(ws, cur);
    journal(ws, cur.id, "fired", `第 ${cur.runs} 次 → 下次 ${cur.next_run}`);
    out.due.push(cur);
  }
  return out;
}
