// ============================================================================
// lib/tasks.ts — 长程任务队列（v0.5.2）
// ----------------------------------------------------------------------------
// 「后台/异步任务执行 · 任务队列/优先级/并行 · 暂停/恢复/中断/继续」的
// 单一实现，CLI（org task/taskd）与 Web（任务中心面板）共用：
//
//   文件协议（<ws>/runtime/tasks/）：
//     <id>.json          任务记录（状态机唯一事实来源，原子写）
//     <id>.journal.jsonl 状态迁移审计（ts|event|detail 追加）
//     .runner.lock       执行器跨进程互斥（pid + 心跳，过期可接管）
//
//   状态机：
//     queued ⇄ paused（入队后暂停 = 不再被领取；恢复 = 回队列）
//     queued → running ⇄ paused（SIGSTOP/SIGCONT，spawn 车道）
//            → done | failed | cancelled
//     done/failed/cancelled → queued（retry：新一次尝试，attempts+1）
//
//   执行器（TaskRunner）：
//     - 并发上限 ORG_TASK_CONCURRENCY（缺省 1 —— git 注册表写入的保守
//       上限；纯 ask 任务多的工作区可调 2-3）
//     - 每任务独立产物目录 out-task-<id>（与用户直连的 out-ask 天然隔离，
//       可与前台操作并行）
//     - 完成即通知（lib/notify：存储 + 桌面通知三级降级）
//   多重优雅降级：
//     - 无执行器在跑 → submit 照常入队（提示 org taskd / org web 启动）
//     - org task run-next → 前台单发执行（无守护进程时的手动模式）
//     - 进程内车道不支持 SIGSTOP → pause 降级为「结束后不再领取下一批」
//       并在记录中如实标注 paused_inproc=true
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { startRun, type RunHandle, type RunResult, ensureWorkspace } from "./engine.ts";
import { notifyEvent, type NotifyKind } from "./notify.ts";

export type TaskKind = "run" | "ask";
export type TaskStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface TaskSpec {
  /** run：团队派单任务描述。 */
  task?: string;
  /** ask：直连专家名 + 问题。 */
  expert?: string;
  question?: string;
  session?: string;
  model: string;
  approval?: boolean;
}

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  /** 0（最高）– 10（最低），缺省 5。 */
  priority: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  spec: TaskSpec;
  run_dir?: string;
  error?: string;
  result?: { ok: boolean; elapsed_ms: number; summary: string };
  attempts: number;
  /** 通知开关（缺省 true：完成/失败发通知）。 */
  notify: boolean;
  /** 进程内车道无法 SIGSTOP —— 状态级暂停的如实标注。 */
  paused_inproc?: boolean;
  pid?: number;
}

const TASKS_DIR = "runtime/tasks";
const SAFE_TASK_ID = /^t-[a-z0-9]+-[a-z0-9]+$/;
const LOCK_STALE_MS = 30_000;

function tasksDir(ws: string): string {
  return path.join(ws, TASKS_DIR);
}

function taskFile(ws: string, id: string): string | null {
  if (!SAFE_TASK_ID.test(id)) return null;
  return path.join(tasksDir(ws), `${id}.json`);
}

function journalFile(ws: string, id: string): string | null {
  if (!SAFE_TASK_ID.test(id)) return null;
  return path.join(tasksDir(ws), `${id}.journal.jsonl`);
}

function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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

// ---- 提交与查询 ---------------------------------------------------------------

export function submitTask(
  ws: string,
  kind: TaskKind,
  spec: TaskSpec,
  opts: { priority?: number; notify?: boolean } = {},
): TaskRecord {
  if (kind === "run" && !(spec.task ?? "").trim()) throw new Error("run 任务必填 task");
  if (kind === "ask") {
    if (!(spec.expert ?? "").trim()) throw new Error("ask 任务必填 expert");
    if (!(spec.question ?? "").trim()) throw new Error("ask 任务必填 question");
  }
  const t: TaskRecord = {
    id: newTaskId(),
    kind,
    status: "queued",
    priority: Math.max(0, Math.min(10, Math.round(opts.priority ?? 5))),
    created_at: new Date().toISOString(),
    spec: { ...spec, model: spec.model || "scripted" },
    attempts: 0,
    notify: opts.notify !== false,
  };
  const file = taskFile(ws, t.id)!;
  atomicWrite(file, JSON.stringify(t, null, 2) + "\n");
  journal(ws, t.id, "submitted", `kind=${kind} priority=${t.priority} model=${t.spec.model}`);
  return t;
}

function readTask(ws: string, id: string): TaskRecord | null {
  const file = taskFile(ws, id);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as TaskRecord;
  } catch {
    return null; // 损坏记录按不存在处理（不炸列表）
  }
}

function writeTask(ws: string, t: TaskRecord): void {
  const file = taskFile(ws, t.id);
  if (!file) throw new Error(`任务 id 不合法：${t.id}`);
  atomicWrite(file, JSON.stringify(t, null, 2) + "\n");
}

export function getTask(ws: string, id: string): TaskRecord | null {
  return readTask(ws, id);
}

export function listTasks(ws: string, opts: { status?: TaskStatus; kind?: TaskKind } = {}): TaskRecord[] {
  const dir = tasksDir(ws);
  const out: TaskRecord[] = [];
  try {
    for (const e of fs.readdirSync(dir)) {
      if (!e.endsWith(".json") || e.startsWith(".")) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, e), "utf-8")) as TaskRecord;
        if (!t.id || !t.status) continue;
        if (opts.status && t.status !== opts.status) continue;
        if (opts.kind && t.kind !== opts.kind) continue;
        out.push(t);
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 目录不存在 → 空列表 */ }
  // 排序：优先级升序 → 创建时间升序 → id 末位 tiebreak（同毫秒提交的
  // 全序确定性 —— id 含随机尾，测试与轮询都拿到稳定列表）
  out.sort((a, b) =>
    a.priority - b.priority ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id));
  return out;
}

export function readTaskJournal(ws: string, id: string): string[] {
  const file = journalFile(ws, id);
  if (!file || !fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

// ---- 状态迁移（用户动作） ------------------------------------------------------

export interface ActionResult {
  ok: boolean;
  status?: TaskStatus;
  error?: string;
}

export function cancelTask(ws: string, id: string): ActionResult {
  const t = readTask(ws, id);
  if (!t) return { ok: false, error: "任务不存在" };
  if (t.status === "done" || t.status === "cancelled") return { ok: false, error: `任务已 ${t.status}（不可取消）` };
  if (t.status === "running") {
    // 运行中取消：执行器轮到它时发现 cancelled 意图 → SIGTERM。
    // 这里只写状态（跨进程契约：执行器每 500ms 对账）。
    t.status = "cancelled";
    t.finished_at = new Date().toISOString();
    writeTask(ws, t);
    journal(ws, id, "cancel_requested", "运行中取消（执行器将 SIGTERM）");
    notifyIfEnabled(ws, t, "task_cancelled");
    return { ok: true, status: t.status };
  }
  t.status = "cancelled";
  t.finished_at = new Date().toISOString();
  writeTask(ws, t);
  journal(ws, id, "cancelled", "入队/暂停状态直接取消");
  return { ok: true, status: t.status };
}

export function pauseTask(ws: string, id: string): ActionResult {
  const t = readTask(ws, id);
  if (!t) return { ok: false, error: "任务不存在" };
  if (t.status === "queued") {
    t.status = "paused";
    writeTask(ws, t);
    journal(ws, id, "paused", "入队暂停（不再被领取）");
    return { ok: true, status: t.status };
  }
  if (t.status === "running") {
    // 运行中暂停：状态先落盘，执行器发现 paused 意图 → SIGSTOP 并确认。
    // 执行器不在场（用户 Ctrl+C 了 taskd）→ 下次领取时按记录恢复语义。
    t.status = "paused";
    writeTask(ws, t);
    journal(ws, id, "pause_requested", "运行中暂停（执行器将 SIGSTOP）");
    return { ok: true, status: t.status };
  }
  return { ok: false, error: `状态 ${t.status} 不可暂停` };
}

export function resumeTask(ws: string, id: string): ActionResult {
  const t = readTask(ws, id);
  if (!t) return { ok: false, error: "任务不存在" };
  if (t.status !== "paused") return { ok: false, error: `状态 ${t.status} 不可恢复` };
  // 有 started_at（运行中被暂停）→ 恢复为 running（在岗执行器 reconcile
  // 会 SIGCONT）；无 started_at（入队时暂停）→ 回队列重新排队。
  // 执行器已死（孤儿）→ 恢复为 running 后由下一次 harvest 如实收割为
  // failed（可 retry）—— 不假装它在跑。
  t.status = t.started_at ? "running" : "queued";
  t.paused_inproc = false;
  writeTask(ws, t);
  journal(ws, id, "resumed", t.started_at ? "恢复运行（SIGCONT）" : "回队列");
  return { ok: true, status: t.status };
}

export function retryTask(ws: string, id: string): ActionResult {
  const t = readTask(ws, id);
  if (!t) return { ok: false, error: "任务不存在" };
  if (t.status !== "failed" && t.status !== "cancelled" && t.status !== "done") {
    return { ok: false, error: `状态 ${t.status} 不可重试（done/failed/cancelled 才可）` };
  }
  t.status = "queued";
  t.attempts += 1;
  t.finished_at = undefined;
  t.error = undefined;
  t.result = undefined;
  t.started_at = undefined;
  writeTask(ws, t);
  journal(ws, id, "retried", `第 ${t.attempts + 1} 次尝试（手动 retry）`);
  return { ok: true, status: t.status };
}

// ---- 执行器 -------------------------------------------------------------------

interface RunningSlot {
  handle: RunHandle;
  task: TaskRecord;
  paused: boolean;
}

/** 同进程锁持有者（web 内嵌执行器与 run-next 等在同一进程时的互斥）。 */
let inProcessHolder: TaskRunner | null = null;

/** 任务执行器：单进程内并发受控的队列泵。跨进程互斥靠 runner lock。 */
export class TaskRunner {
  private ws: string;
  private concurrency: number;
  private slots = new Map<string, RunningSlot>();
  private stopped = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lockHeartbeat: ReturnType<typeof setInterval> | null = null;
  private lockFile: string;

  constructor(ws: string, opts: { concurrency?: number } = {}) {
    this.ws = ws;
    this.concurrency = Math.max(1, opts.concurrency ?? envConcurrency());
    this.lockFile = path.join(tasksDir(ws), ".runner.lock");
  }

  /** 尝试成为本工作区的执行器（同进程 + 跨进程双重互斥）。失败返回 false。 */
  acquireLock(): boolean {
    if (inProcessHolder && inProcessHolder !== this) return false;
    try {
      fs.mkdirSync(tasksDir(this.ws), { recursive: true });
      if (fs.existsSync(this.lockFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(this.lockFile, "utf-8")) as { pid?: number; hb?: number };
          const age = Date.now() - (raw.hb ?? 0);
          const alive = isPidAlive(raw.pid);
          if (age < LOCK_STALE_MS && alive && raw.pid !== process.pid) return false; // 他进程持有
        } catch {
          // 坏锁/死进程锁 → 接管
        }
      }
      this.writeLock();
      this.lockHeartbeat = setInterval(() => this.writeLock(), 5_000);
      inProcessHolder = this;
      return true;
    } catch {
      return false;
    }
  }

  private writeLock(): void {
    try {
      atomicWrite(this.lockFile, JSON.stringify({ pid: process.pid, hb: Date.now() }) + "\n");
    } catch { /* 心跳失败静默 */ }
  }

  releaseLock(): void {
    if (inProcessHolder === this) inProcessHolder = null;
    if (this.lockHeartbeat) clearInterval(this.lockHeartbeat);
    try { fs.rmSync(this.lockFile, { force: true }); } catch { /* 不存在 */ }
  }

  /** 启动队列泵（500ms 领取间隔）。 */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => { void this.tick(); }, 500);
    // 立即跑一次（启动即响应）
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** 单次泵：领取 + 对账 + 收割。公开给 run-next 单发模式复用。 */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.reconcile();
    await this.harvest();
    while (this.slots.size < this.concurrency) {
      const next = this.pickNext();
      if (!next) break;
      await this.launch(next);
    }
  }

  /** 用户意图对账：cancel → SIGTERM；pause → SIGSTOP；resume 恢复。 */
  private async reconcile(): Promise<void> {
    for (const [id, slot] of this.slots) {
      const t = readTask(this.ws, id);
      if (!t) continue;
      if (t.status === "cancelled") {
        await slot.handle.cancel();
        journal(this.ws, id, "sigterm", "执行器按取消意图终止子进程");
      } else if (t.status === "paused" && !slot.paused) {
        const ok = await slot.handle.pause();
        if (ok) {
          slot.paused = true;
          journal(this.ws, id, "sigstop", "执行器暂停子进程");
        } else {
          // 进程内车道无法 SIGSTOP —— 如实标注（状态级暂停）
          const cur = readTask(this.ws, id);
          if (cur) {
            cur.paused_inproc = true;
            writeTask(this.ws, cur);
          }
          journal(this.ws, id, "pause_degraded", "inproc 车道无法 SIGSTOP（等待本轮自然结束）");
        }
      } else if (t.status === "running" && slot.paused) {
        const ok = await slot.handle.resume();
        if (ok) {
          slot.paused = false;
          journal(this.ws, id, "sigcont", "执行器恢复子进程");
        }
      }
    }
  }

  private pickNext(): TaskRecord | null {
    const queued = listTasks(this.ws, { status: "queued" });
    // 恢复态优先（resume 后 status=running 且 started_at 存在但不在 slots 中 →
    // 是别的执行器留下的孤儿恢复，或本执行器重启后的断点续跑）
    return queued[0] ?? null;
  }

  private async launch(t: TaskRecord): Promise<void> {
    t.status = "running";
    t.started_at = t.started_at ?? new Date().toISOString();
    t.pid = process.pid;
    writeTask(this.ws, t);
    journal(this.ws, t.id, "started", `attempt ${t.attempts + 1} · out-task-${t.id}`);
    const outDir = path.join(this.ws, `out-task-${t.id}`);
    const handle = startRun({
      entry: t.kind === "ask" ? "direct" : "org",
      task: t.kind === "ask" ? (t.spec.question ?? "") : (t.spec.task ?? ""),
      workspace: this.ws,
      model: t.spec.model,
      outDir,
      expert: t.kind === "ask" ? t.spec.expert : undefined,
      session: t.kind === "ask" ? (t.spec.session ?? "task") : undefined,
      approval: t.spec.approval,
    });
    this.slots.set(t.id, { handle, task: t, paused: false });
    // 异步收割（不阻塞 tick）
    void handle.wait().then((r) => {
      this.slots.delete(t.id);
      this.finishRun(t, r, outDir);
    });
  }

  private finishRun(t: TaskRecord, r: RunResult, outDir: string): void {
    const cur = readTask(this.ws, t.id);
    if (!cur) return;
    if (cur.status === "cancelled") return; // 已被取消：保持 cancelled
    cur.run_dir = outDir;
    cur.finished_at = new Date().toISOString();
    cur.pid = undefined;
    if (r.ok) {
      cur.status = "done";
      cur.result = { ok: true, elapsed_ms: r.elapsed_ms, summary: summarize(this.ws, r, t) };
      writeTask(this.ws, cur);
      journal(this.ws, t.id, "done", `ok · ${r.elapsed_ms}ms · ${cur.result.summary.slice(0, 80)}`);
      notifyIfEnabled(this.ws, cur, "task_done");
    } else {
      cur.status = "failed";
      cur.error = r.error ?? "引擎退出非零";
      writeTask(this.ws, cur);
      journal(this.ws, t.id, "failed", (cur.error ?? "").slice(0, 120));
      notifyIfEnabled(this.ws, cur, "task_failed");
    }
  }

  /** 收割孤儿：running 状态但不在本执行器 slots、且发起 pid 已死的任务。
   * 跨进程契约：pid 活着（无论哪个进程 —— run-next / 同进程另一执行器 /
   * 本进程早期实例）= 有执行者在岗 —— 绝不误杀；pid 死了或缺失才是真
   * 孤儿（执行器崩溃后的断点清理）。 */
  private async harvest(): Promise<void> {
    for (const t of listTasks(this.ws, { status: "running" })) {
      if (this.slots.has(t.id)) continue;
      if (t.pid !== undefined && isPidAlive(t.pid)) continue; // 有执行者在（活 pid 不动）
      // 判断是否真的死了：run_dir 的 run.json 已收尾 → 按 run.json 判定
      const runJson = readRunJsonSafe(t.run_dir);
      if (runJson) {
        const cur = readTask(this.ws, t.id);
        if (!cur) continue;
        cur.status = runJson.ok ? "done" : "failed";
        cur.finished_at = new Date().toISOString();
        if (!runJson.ok) cur.error = "执行器中断（孤儿收割，run.json 非零退出）";
        cur.result = { ok: runJson.ok, elapsed_ms: runJson.elapsed_ms ?? 0, summary: summarize(this.ws, { ok: runJson.ok, elapsed_ms: runJson.elapsed_ms ?? 0 } as RunResult, cur) };
        writeTask(this.ws, cur);
        journal(this.ws, t.id, "orphan_harvested", `执行器重启后收割 → ${cur.status}`);
      } else {
        // 无 run.json：产物未收尾 → 标记 failed（可 retry）
        const cur = readTask(this.ws, t.id);
        if (!cur) continue;
        cur.status = "failed";
        cur.error = "执行器中断（无 run.json，可 org task retry）";
        cur.finished_at = new Date().toISOString();
        writeTask(this.ws, cur);
        journal(this.ws, t.id, "orphan_failed", "执行器中断且产物未收尾");
      }
    }
  }

  get runningCount(): number {
    return this.slots.size;
  }
}

function readRunJsonSafe(dir?: string): { ok?: boolean; elapsed_ms?: number } | null {
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf-8")) as { ok?: boolean; elapsed_ms?: number };
  } catch {
    return null;
  }
}

function summarize(ws: string, r: RunResult, t: TaskRecord): string {
  if (t.kind === "ask") {
    const turns = r.directTurns ?? [];
    const last = turns[turns.length - 1];
    return last ? `回答 ${String(last.answer ?? "").slice(0, 120)}` : "直连完成";
  }
  const m = r.metrics;
  if (m) return `model_calls ${m.model_calls_total} · 资产 ${m.assets} · 耗时 ${(r.elapsed_ms / 1000).toFixed(1)}s`;
  return `耗时 ${(r.elapsed_ms / 1000).toFixed(1)}s`;
}

function notifyIfEnabled(ws: string, t: TaskRecord, kind: NotifyKind): void {
  if (!t.notify) return;
  const title = kind === "task_done" ? `任务完成 ${t.id}` : kind === "task_failed" ? `任务失败 ${t.id}` : `任务取消 ${t.id}`;
  const detail = t.kind === "ask"
    ? `${t.spec.expert} · ${String(t.spec.question ?? "").slice(0, 60)}`
    : String(t.spec.task ?? "").slice(0, 80);
  notifyEvent(ws, kind, title, detail, { taskId: t.id });
}

function envConcurrency(): number {
  const n = Number((process.env.ORG_TASK_CONCURRENCY ?? "1").trim() || "1");
  return Number.isFinite(n) ? Math.max(1, Math.min(4, Math.floor(n))) : 1;
}

function isPidAlive(pid?: number): boolean {
  if (pid === undefined || pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但无权限
  }
}

// ---- 单发模式（无守护进程时的优雅降级） ---------------------------------------

/** 前台执行下一个排队任务至完成（org task run-next）。
 * 有活执行器在跑（taskd / org web）时拒绝 —— 防双执行。
 * 返回执行的记录；队列空返回 null；锁被持有抛 Error。 */
export async function runNextTask(ws: string): Promise<TaskRecord | null> {
  const runner = new TaskRunner(ws);
  if (!runner.acquireLock()) {
    throw new Error("已有执行器在跑（org taskd / org web）—— 排队任务会被自动领取，无需 run-next");
  }
  try {
    const queued = listTasks(ws, { status: "queued" });
    if (queued.length === 0) return null;
    ensureWorkspace(ws);
    await runner.tick(); // 领取一个（并发 1 → 至多领一个）
    // 等待本执行器领走的任务收割（他进程的 running 不等 —— pid 对账）
    for (;;) {
      const stillMine = listTasks(ws, { status: "running" }).filter((t) => t.pid === process.pid);
      if (stillMine.length === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return readTask(ws, queued[0]!.id);
  } finally {
    runner.releaseLock();
  }
}
