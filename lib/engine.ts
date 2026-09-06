// ============================================================================
// org/lib/engine.ts — 引擎桥：CLI 与 TUI 共用（v0.4.0，规格书 §4）
// ----------------------------------------------------------------------------
// 主路径：spawn `bun <dhv-ts> run <entry> --workspace --task --model --fixture
// --out --allow bun,node,ls,cat,grep,diff,git`（与 cli/org.ts runHsl 同参），
// 150ms 轮询 tail events.jsonl + journal.jsonl → 归一化事件流。
// fallback：ORG_FORCE_INPROC=1 或 PATH 无 bun 时进程内执行 vendored dhv-ts
// main.ts（先改 process.argv 跑完恢复；dhv-ts 是顶层读 argv 的 CLI 脚本，
// 顶层 process.exit 需临时接管）。cancel() = SIGTERM 子进程。
// 仅 node:fs / node:path —— Windows 兼容，零原生依赖。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineEvent, RunMetrics } from "./events.ts";
import {
  normalizeEventLine,
  normalizeJournalLine,
  parseEventsLine,
  parseJournalLine,
  readEventStream,
  readLines,
  tailLines,
} from "./events.ts";
import { ROOT } from "./root.ts";
const HSL_ENTRY = path.join(ROOT, "hsl/org.hsl");
const DIRECT_ENTRY = path.join(ROOT, "hsl/pool/direct.hsl");
const STOCK_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");
const WS_TEMPLATE = path.join(ROOT, "demo-ws");
const VENDORED_MAIN = path.join(ROOT, "toolchain/dhv-ts/src/main.ts");

// ---------- 公共类型（规格书 §4） ----------

export interface RunOptions {
  entry: "org" | "direct";        // org.hsl / pool/direct.hsl
  task: string;
  workspace: string;              // 默认 <repo>/demo-run
  model: "scripted" | "deepseek";
  fixture?: string;               // 默认 fixtures/run-notices.json
  outDir?: string;                // 默认 <workspace>/out-<ts>
  expert?: string;                // direct 模式必填
  session?: string;               // direct 会话账本 id（默认 "default"）
}

export interface DirectTurn {
  turn: number;
  question: string;
  answer: string;
  tokens?: number;
}

export interface RunResult {
  ok: boolean;
  canceled: boolean;
  outDir: string;
  elapsed_ms: number;
  error?: string;
  runJson: { ts?: string; ok?: boolean; elapsed_ms?: number; model?: string; task?: string; panic?: string } | null;
  metrics: RunMetrics | null;
  directTurns?: DirectTurn[];
}

export interface RunHandle {
  runId: string;
  outDir: string;
  events: AsyncIterable<EngineEvent>;
  cancel(): Promise<void>;
  wait(): Promise<RunResult>;
}

// ---------- Bun.spawn 最小面（避免依赖 ambient bun 类型） ----------

interface SpawnProc {
  pid: number;
  exited: Promise<number>;
  kill(signal?: string): boolean;
  stdout: { text(): Promise<string> };
  stderr: { text(): Promise<string> };
}
interface BunLike {
  spawn(cmd: string[], opts: {
    env?: Record<string, string>;
    stdout?: "pipe" | "ignore" | "inherit";
    stderr?: "pipe" | "ignore" | "inherit";
    cwd?: string;
  }): SpawnProc;
  spawnSync(cmd: string[], opts: { cwd?: string; stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore" }): {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
  };
}
const B: BunLike = (globalThis as unknown as { Bun: BunLike }).Bun;

// ---------- 路径与工具链解析（与 cli/org.ts resolveDhv 同序） ----------

/** 传给子进程的路径统一正斜杠（Windows 上 bash/child 不吃反斜杠）。 */
function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function resolveDhv(): string {
  const candidates = [
    process.env.DHV_TS,
    VENDORED_MAIN,
    path.resolve(ROOT, "../hsl/toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "../harness-specification-language/toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "harness-specification-language/toolchain/dhv-ts/src/main.ts"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("找不到 HSL 工具链（dhv-ts）：设 DHV_TS 或检查 toolchain/dhv-ts/ 是否在位");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** bun 解析顺序：$BUN → process.execPath（是否 bun 本体）→ PATH。 */
export function resolveBun(): string | null {
  const envBun = process.env.BUN;
  if (envBun && isFile(envBun)) return envBun;
  const exec = process.execPath;
  if (exec && path.basename(exec).toLowerCase().startsWith("bun")) return exec;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0);
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  for (const d of dirs) {
    const c = path.join(d, exe);
    if (isFile(c)) return c;
  }
  return null;
}

// ---------- 工作区（模板初始化 + git 注册表） ----------

function git(ws: string, args: string[]): void {
  try {
    B.spawnSync(["git", ...args], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  } catch { /* 尽力而为 */ }
}

export function gitInit(ws: string): void {
  git(ws, ["init", "-q"]);
  git(ws, ["config", "user.email", "org@local"]);
  git(ws, ["config", "user.name", "org-registry"]);
  git(ws, ["add", "-A"]);
  git(ws, ["commit", "-q", "-m", "registry template (notice-parser@1.0.0)"]);
}

export function ensureWorkspace(ws: string): void {
  if (fs.existsSync(ws)) return;
  fs.cpSync(WS_TEMPLATE, ws, { recursive: true });
  gitInit(ws);
}

/** demo 语义：重置工作区到模板（可重复的三连跑叙事）。 */
export function resetWorkspace(ws: string): void {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(WS_TEMPLATE, ws, { recursive: true });
  gitInit(ws);
}

export function gitShortLog(ws: string, n = 5): Array<{ sha: string; subject: string }> {
  try {
    const out = B.spawnSync(["git", "-C", ws, "log", "--pretty=format:%h%x1f%s", "--all"], { stdout: "pipe" });
    return out.stdout.toString().split("\n").filter((l) => l.trim().length > 0).slice(0, n).map((l) => {
      const [sha, subject] = l.split("\x1f");
      return { sha: sha ?? "", subject: subject ?? "" };
    });
  } catch {
    return [];
  }
}

// ---------- 产物读取 ----------

export function readRunJson(outDir: string): RunResult["runJson"] {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, "run.json"), "utf-8")) as RunResult["runJson"];
  } catch {
    return null;
  }
}

export function readMetrics(outDir: string): RunMetrics | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, "metrics.json"), "utf-8")) as RunMetrics;
  } catch {
    return null;
  }
}

export interface Scorecard {
  model: string;
  evidence_count: number;
  cells: Array<{ cell: string; score: number; confidence: number }>;
}

export function readScorecard(outDir: string): Scorecard | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, "scorecard.json"), "utf-8")) as Scorecard;
  } catch {
    return null;
  }
}

function readDirectTurns(workspace: string, expert: string, session: string): DirectTurn[] {
  if (!expert) return [];
  const file = path.join(workspace, "runtime", "sessions", expert, `${session}.jsonl`);
  return readLines(file).flatMap((l) => {
    try {
      const o = JSON.parse(l) as { turn?: number; question?: string; answer?: string; tokens?: number };
      return [{ turn: o.turn ?? 0, question: o.question ?? "", answer: o.answer ?? "", tokens: o.tokens }];
    } catch {
      return [];
    }
  });
}

// ---------- 工作区扫描（左栏 rail 数据源） ----------

export interface SessionInfo {
  dir: string;
  name: string;
  mtimeMs: number;
  ok: boolean;
  task: string;
  elapsed_ms: number;
}

export interface ExpertInfo {
  name: string;
  version: string;
  source: string;
  eval_score: number;
  entry: string;
  uses: number;
  capabilities: string[];
}

export interface WorkspaceInfo {
  sessions: SessionInfo[];
  experts: ExpertInfo[];
  memoKeys: number;          // 固化冻结条数（registry/memos/*.json 的 memos 键）
  hitLedger: number;         // 复发计数条目数（runtime/recurrence.json）
  minedTracks: number;       // 基准题轨道数
  scorecardDir: string | null;
}

function listOutDirs(ws: string): string[] {
  try {
    return fs.readdirSync(ws, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("out-"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function scanWorkspace(ws: string): WorkspaceInfo {
  const sessions: SessionInfo[] = [];
  let scorecardDir: string | null = null;
  let scorecardMtime = -1;
  for (const name of listOutDirs(ws)) {
    const dir = path.join(ws, name);
    const runJson = readRunJson(dir);
    if (!runJson) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(dir, "run.json")).mtimeMs;
    } catch { /* 忽略 */ }
    sessions.push({
      dir, name, mtimeMs,
      ok: runJson.ok === true,
      task: runJson.task ?? "",
      elapsed_ms: runJson.elapsed_ms ?? 0,
    });
    const sc = path.join(dir, "scorecard.json");
    if (fs.existsSync(sc)) {
      const m = fs.statSync(sc).mtimeMs;
      if (m > scorecardMtime) { scorecardMtime = m; scorecardDir = dir; }
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let experts: ExpertInfo[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ws, "registry/index.json"), "utf-8")) as Array<Record<string, unknown>>;
    experts = raw.map((m) => ({
      name: String(m.name ?? "?"),
      version: String(m.version ?? "?"),
      source: String(m.source ?? "?"),
      eval_score: Number(m.eval_score ?? 0),
      entry: String(m.entry ?? ""),
      uses: Number(m.uses ?? 0),
      capabilities: Array.isArray(m.capabilities) ? (m.capabilities as unknown[]).map(String) : [],
    }));
  } catch { /* 空 registry */ }

  let memoKeys = 0;
  try {
    const memosDir = path.join(ws, "registry/memos");
    for (const f of fs.readdirSync(memosDir)) {
      const o = JSON.parse(fs.readFileSync(path.join(memosDir, f), "utf-8")) as { memos?: Record<string, unknown> };
      memoKeys += Object.keys(o.memos ?? {}).length;
    }
  } catch { /* 无 memo */ }

  let hitLedger = 0;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(ws, "runtime/recurrence.json"), "utf-8")) as Record<string, number>;
    hitLedger = Object.keys(rec).length;
  } catch { /* 无复发计数 */ }

  let minedTracks = 0;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ws, "registry/fixtures-mined/reviews.json"), "utf-8")) as { tracks?: Record<string, unknown> };
    minedTracks = Object.keys(m.tracks ?? {}).length;
  } catch { /* 无基准题 */ }

  return { sessions, experts, memoKeys, hitLedger, minedTracks, scorecardDir };
}

// ---------- 事件泵（150ms 增量 tail，journal 权威去重） ----------

class EventQueue {
  private items: EngineEvent[] = [];
  private closed = false;
  private wake: (() => void) | null = null;
  push(ev: EngineEvent): void {
    this.items.push(ev);
    const w = this.wake;
    this.wake = null;
    w?.();
  }
  close(): void {
    this.closed = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }
  async *iterate(): AsyncGenerator<EngineEvent> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((r) => { this.wake = r; });
      }
    }
  }
}

const POLL_MS = 150;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PumpOffsets {
  events: number;
  journal: number;
  seen: Set<string>;   // 已推送的期刊签名（跨文件去重）
}

function pumpTick(outDir: string, off: PumpOffsets, q: EventQueue): void {
  const evFile = path.join(outDir, "events.jsonl");
  const jrFile = path.join(outDir, "journal.jsonl");
  // journal 权威（含 phase/actor），先收
  const jr = tailLines(jrFile, off.journal);
  off.journal = jr.next;
  for (const line of jr.lines) {
    const raw = parseJournalLine(line);
    if (!raw) continue;
    const ev = normalizeJournalLine(raw);
    if (ev.kind === "journal") off.seen.add(`${ev.action}|${ev.detail}`);
    q.push(ev);
  }
  const evs = tailLines(evFile, off.events);
  off.events = evs.next;
  for (const line of evs.lines) {
    const raw = parseEventsLine(line);
    if (!raw) continue;
    if (raw.name === "journal") {
      const data = raw.data as { name?: unknown; detail?: unknown };
      const sig = `${String(data.name ?? "")}|${String(data.detail ?? "")}`;
      if (off.seen.has(sig)) continue; // journal.jsonl 已收录该条
    }
    q.push(normalizeEventLine(raw));
  }
}

// ---------- dhv 统一执行器（CLI 与 TUI 共用；编译二进制的核心通路） ----------
//
// 优先子进程（PATH / $BUN 上的 bun → 保留「嵌套解释器 = 独立进程」的蓝绿语义）；
// 无 bun 可用（单二进制分发环境）→ 进程内 fallback（vendored dhv-ts import）。
// CLI（cli/org.ts runHsl/checkFile）与本文件的 startRun 都经由这里的能力面。

export interface DhvResult {
  ok: boolean;
  out: string;
}

export async function dhvRun(
  args: string[],
  envExtra?: Record<string, string>,
): Promise<DhvResult> {
  const dhv = resolveDhv();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.DHV_TS = shPath(dhv);
  if (envExtra) Object.assign(env, envExtra);
  const forceInproc = process.env.ORG_FORCE_INPROC === "1";
  const bun = forceInproc ? null : resolveBun();
  if (bun) {
    const proc = B.spawn([bun, dhv, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [so, se, code] = await Promise.all([
      proc.stdout.text(), proc.stderr.text(), proc.exited,
    ]);
    return { ok: code === 0, out: so + se };
  }
  const capture: string[] = [];
  const extra: Record<string, string> = { DHV_TS: shPath(dhv) };
  if (envExtra) Object.assign(extra, envExtra);
  const code = await runInproc(args, extra, capture);
  return { ok: code === 0, out: capture.join("\n") };
}

// ---------- 进程内 fallback（vendored dhv-ts main.ts） ----------

let inprocRuns = 0;

async function runInproc(
  args: string[],
  envExtra: Record<string, string>,
  capture: string[],
): Promise<number> {
  const dhvMain = resolveDhv();
  const savedArgv = process.argv;
  const savedLog = {
    log: console.log, error: console.error, warn: console.warn, info: console.info,
  };
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(envExtra)) savedEnv[k] = process.env[k];
  const savedExit = process.exit;
  // 静默引擎直写（println! 走 process.stdout.write，不经过 console）——
  // 进程内执行时若不拦截，引擎输出会污染 TUI 画面。
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const silentWrite = (sink: string[]): ((chunk: unknown) => boolean) => {
    return (chunk: unknown): boolean => {
      const t = typeof chunk === "string" ? chunk : String(chunk);
      for (const l of t.split("\n")) if (l.trim().length > 0) sink.push(l);
      return true;
    };
  };
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = silentWrite(capture);
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = silentWrite(capture);
  let code = 0;
  process.argv = [savedArgv[0] ?? "org", dhvMain, ...args];
  Object.assign(process.env, envExtra);
  (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => {
    code = c ?? 0;
    return undefined as never;
  }) as (c?: number) => never;
  const captureFn = (...a: unknown[]): void => {
    capture.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
  };
  console.log = captureFn;
  console.error = captureFn;
  console.warn = captureFn;
  console.info = captureFn;
  try {
    // 字面量 specifier：bun compile 会把 vendored main.ts 打进单二进制（fallback 可用）。
    // 优先 cliMain（可编程入口，返回退出码、无模块缓存问题——repeated 调用状态隔离
    // 由 fresh loadProgram 保证）；旧版 vendored dhv-ts（无 cliMain 导出）退回
    // 顶层执行式 import（同进程第二次起用 query 爆缓存）。
    if (path.resolve(dhvMain) === path.resolve(VENDORED_MAIN)) {
      const mod = await import("../toolchain/dhv-ts/src/main.ts") as {
        cliMain?: (argv: string[]) => Promise<number>;
      };
      if (typeof mod.cliMain === "function") {
        code = await mod.cliMain(args);
      } else if (inprocRuns === 0) {
        await import("../toolchain/dhv-ts/src/main.ts");
      } else {
        await import(`../toolchain/dhv-ts/src/main.ts?v=${inprocRuns}`);
      }
    } else {
      await import(`${dhvMain}${inprocRuns > 0 ? `?v=${inprocRuns}` : ""}`);
    }
  } catch (err) {
    capture.push(`inproc import failed: ${(err as Error).message}`);
    code = 1;
  } finally {
    (process as unknown as { exit: (c?: number) => never }).exit = savedExit;
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = realStdoutWrite;
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = realStderrWrite;
    process.argv = savedArgv;
    console.log = savedLog.log;
    console.error = savedLog.error;
    console.warn = savedLog.warn;
    console.info = savedLog.info;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  inprocRuns += 1;
  return code;
}

// ---------- startRun ----------

function makeOutDir(workspace: string, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return path.join(workspace, `out-${stamp}`);
}

export function startRun(opts: RunOptions): RunHandle {
  const outDir = makeOutDir(opts.workspace, opts.outDir);
  const runId = `${path.basename(outDir)}-${Math.random().toString(36).slice(2, 6)}`;
  const q = new EventQueue();
  const off: PumpOffsets = { events: 0, journal: 0, seen: new Set() };
  let proc: SpawnProc | null = null;
  let canceled = false;
  let result: RunResult | null = null;
  const capture: string[] = [];

  const finish = (ok: boolean, error?: string): void => {
    const runJson = readRunJson(outDir);
    const metrics = readMetrics(outDir);
    const turns = opts.entry === "direct"
      ? readDirectTurns(opts.workspace, opts.expert ?? "", opts.session ?? "default")
      : undefined;
    result = {
      ok, canceled, outDir,
      elapsed_ms: runJson?.elapsed_ms ?? 0,
      error: error ?? runJson?.panic ?? undefined,
      runJson, metrics, directTurns: turns,
    };
    q.push({
      kind: "run_result", seq: 2 ** 30, ts: new Date().toISOString(),
      ok, canceled, outDir, elapsed_ms: result.elapsed_ms,
      error: result.error, runJson, metrics,
    });
    q.close();
  };

  const main = async (): Promise<void> => {
    try {
      ensureWorkspace(opts.workspace);
      fs.mkdirSync(outDir, { recursive: true });
      const entryFile = opts.entry === "direct" ? DIRECT_ENTRY : HSL_ENTRY;
      const fixture = opts.fixture ?? STOCK_FIXTURE;
      const args = [
        "run", entryFile,
        "--workspace", opts.workspace,
        "--task", opts.entry === "direct" ? `(direct) ${opts.task}` : opts.task,
        "--model", opts.model,
        "--fixture", fixture,
        "--out", outDir,
        "--allow", "bun,node,ls,cat,grep,diff,git",
      ];
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") env[k] = v;
      }
      env.DHV_TS = shPath(resolveDhv());
      const envExtra: Record<string, string> = { DHV_TS: shPath(resolveDhv()) };
      if (opts.entry === "direct") {
        if (!opts.expert) throw new Error("direct 模式必填 expert（?专家名 问题?）");
        envExtra.ORG_ASK_EXPERT = opts.expert;
        envExtra.ORG_ASK_SESSION = opts.session ?? "default";
        envExtra.ORG_ASK_QUESTION = opts.task;
      }
      const forceInproc = process.env.ORG_FORCE_INPROC === "1";
      const bun = forceInproc ? null : resolveBun();
      let code = 0;
      if (bun) {
        proc = B.spawn([bun, resolveDhv(), ...args], { env, stdout: "pipe", stderr: "pipe" });
        void proc.stdout.text().then((t) => {
          for (const l of t.split("\n")) if (l.length > 0) capture.push(l);
        });
        void proc.stderr.text().then((t) => {
          for (const l of t.split("\n")) if (l.length > 0) capture.push(l);
        });
        for (;;) {
          pumpTick(outDir, off, q);
          const exited = await Promise.race([
            proc.exited.then((c) => ["exit", c] as const),
            sleep(POLL_MS).then(() => null),
          ]);
          if (exited !== null) { code = exited[1]; break; }
        }
        pumpTick(outDir, off, q); // 收尾 flush
      } else {
        // 进程内 fallback：事件在 import 返回后一次性可见
        code = await runInproc(args, envExtra, capture);
        pumpTick(outDir, off, q);
      }
      if (code !== 0 && !canceled) {
        const tail = capture.filter((l) => l.trim().length > 0).slice(-6).join(" / ");
        finish(false, `引擎退出码 ${code}${tail ? "：" + tail : ""}`);
      } else {
        finish(code === 0);
      }
    } catch (err) {
      finish(false, (err as Error).message);
    }
  };
  void main();

  return {
    runId,
    outDir,
    events: q.iterate(),
    cancel: async () => {
      canceled = true;
      if (proc) {
        try { proc.kill("SIGTERM"); } catch { /* 已退出 */ }
      }
    },
    wait: async () => {
      while (result === null) {
        await sleep(30);
      }
      return result!;
    },
  };
}

// ---------- 重演 / 会话加载 ----------

export interface ReplayData {
  events: EngineEvent[];
  runJson: RunResult["runJson"];
  metrics: RunMetrics | null;
  scorecard: Scorecard | null;
}

/** :replay —— 读历史 run 产物，秒开不重跑。 */
export function replayRun(outDir: string): ReplayData {
  const events = readEventStream(path.join(outDir, "events.jsonl"), path.join(outDir, "journal.jsonl"));
  return {
    events,
    runJson: readRunJson(outDir),
    metrics: readMetrics(outDir),
    scorecard: readScorecard(outDir),
  };
}

/** 最新评分卡所在 run 目录（:score 用）。 */
export function latestScorecardDir(workspace: string): string | null {
  return scanWorkspace(workspace).scorecardDir;
}
