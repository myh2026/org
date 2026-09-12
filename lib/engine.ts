// ============================================================================
// org/lib/engine.ts — 引擎桥：CLI 与 TUI 共用（v0.4.6，规格书 §4）
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
  normalizeLlmStreamLine,
  parseEventsLine,
  parseJournalLine,
  parseLlmStreamLine,
  readEventStream,
  readLines,
  tailLines,
} from "./events.ts";
import { ROOT } from "./root.ts";
import { readSession as libReadSession } from "./sessions.ts";
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
  /** 交互式审批（v0.5.0）：true 时给子进程注入 ORG_APPROVAL=1，
   *  能力类决策（目前是能力变更补丁）会写审批请求并**有界等待**用户回复。
   *  缺省 false —— 无人在场的场景（CI / 脚本 / org demo）行为零变化，
   *  且绝不会因为等不到人而挂住 run（超时降级为拒绝）。 */
  approval?: boolean;
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

/** 模板目录只读守卫：工作区不能指向 demo-ws 本身。
 *  实录事故：`dhv run probe9 --workspace demo-ws` 把固化观测账本写进模板 →
 *  后续每次 demo 复制被污染的模板 → 三连跑叙事漂移（A 出现命中、衰减曲线
 *  5→1→0 变 1→0→0）。模板是演示可重复性的地基，必须守卫。 */
export function assertWorkspaceNotTemplate(ws: string): void {
  if (path.resolve(ws) === path.resolve(WS_TEMPLATE)) {
    throw new Error(
      `工作区不能指向模板目录 ${WS_TEMPLATE}：运行会把观测账本 / 注册表写回模板，` +
      `污染后续所有 demo 的叙事（衰减曲线漂移）。请换一个工作区目录` +
      `（如 demo-run 或 --workspace <dir>）——模板由仓库分发，只读。`,
    );
  }
}

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
  assertWorkspaceNotTemplate(ws);
  if (fs.existsSync(ws)) return;
  fs.cpSync(WS_TEMPLATE, ws, { recursive: true });
  gitInit(ws);
}

/** demo 语义：重置工作区到模板（可重复的三连跑叙事）。 */
export function resetWorkspace(ws: string): void {
  assertWorkspaceNotTemplate(ws);
  assertSafeResetWorkspace(ws);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(WS_TEMPLATE, ws, { recursive: true });
  gitInit(ws);
}

/** demo 重置安全守卫：rmSync 脚枪防线。
 *  目标目录非空且不含任何 org 工作区标记（registry/raw/out- 目录/.git）时拒绝
 *  整目录删除 —— `org demo --workspace <任意目录>` 此前只有模板只读守卫，
 *  指错目录（如 ~）会把整个目录静默删光。空目录与不存在的目录放行。 */
export function assertSafeResetWorkspace(ws: string): void {
  if (!fs.existsSync(ws)) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(ws, { withFileTypes: true });
  } catch {
    return; // 不可读 → 后续 rmSync 自会报错，不在此拦截
  }
  if (entries.length === 0) return;
  const markers = new Set(["registry", "raw", ".git", ".hsl-runs", "work", "factory", "runtime"]);
  const runLike = entries.some((e) => e.isDirectory() && e.name.startsWith("out-"));
  const hasMarker = entries.some((e) => e.isDirectory() && markers.has(e.name)) || runLike;
  if (!hasMarker) {
    throw new Error(
      `拒绝重置 ${ws}：目录非空且不含 org 工作区标记（registry/raw/out-*）。` +
      `demo 会整目录 rmSync —— 请确认这是 org 工作区，或换一个空目录。`,
    );
  }
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

// ---------- 工具库治理：用户选取保留（org keep / org drop / TUI :keep / :drop） ----------
// 工厂产出默认是候选（retained=false）：B 路径自动复用只命中用户保留资产
// （manual/import 存量例外）。选取动作 = 翻转 retained + git 提交留痕
// （与 mint/patch 同链 —— 增长率账本的一部分）。

export interface RegistryEntry {
  name: string;
  version: string;
  source: string;
  retained?: boolean;
  [key: string]: unknown;
}

export function loadRegistryIndex(ws: string): RegistryEntry[] {
  const index = path.join(ws, "registry/index.json");
  try {
    const raw = JSON.parse(fs.readFileSync(index, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function gitCommitRegistry(ws: string, message: string): void {
  git(ws, ["add", "registry/"]);
  git(ws, ["commit", "-q", "-m", message]);
}

/** 翻转专家保留标记（index.json + 每专家副本 + git 提交；CLI 与 TUI 共用）。 */
export function setRetained(ws: string, names: string[], retained: boolean): { kept: string[]; missing: string[] } {
  const experts = loadRegistryIndex(ws);
  const wanted = new Set(names);
  const hit: string[] = [];
  for (const m of experts) {
    if (wanted.has(m.name)) {
      m.retained = retained;
      hit.push(`${m.name}@${m.version}`);
      wanted.delete(m.name);
      // 同步每专家副本（与 HSL flush 的双写形态一致）
      const per = path.join(ws, "registry", `${m.name}.json`);
      try { fs.writeFileSync(per, JSON.stringify(m)); } catch { /* 副本缺失容忍 */ }
    }
  }
  const missing = [...wanted];
  if (hit.length > 0) {
    fs.writeFileSync(path.join(ws, "registry/index.json"), JSON.stringify(experts));
    const action = retained ? "keep" : "drop";
    gitCommitRegistry(ws, `${action} ${hit.join(", ")} (user curation)`);
  }
  return { kept: hit, missing };
}

/** demo 剧本内的用户选取：保留全部 factory 候选（返回转正名单）。 */
export function keepAllCandidates(ws: string): string[] {
  const experts = loadRegistryIndex(ws);
  const candidates = experts
    .filter((m) => m.source === "factory" && m.retained !== true)
    .map((m) => m.name);
  if (candidates.length === 0) return [];
  const { kept } = setRetained(ws, candidates, true);
  return kept;
}

// ---------- 运行范围复核：本次运行碰过哪些 harness（org review / Web 候选面） ----------
// 工具库治理的第四动作（前三：import / keep / drop）。keep 与 drop 回答的是
// 「库里某个资产要不要留」，review 回答的是「这一次运行产出的东西里，哪些值得
// 沉淀」—— 选取范围由运行产物本身界定，不靠目录时间戳猜测，判据全在事件流：
//   journal:mint-register  "name@version eval=N"     → 本次现场铸出（新资产）
//   journal:asset          "patch name :: note"      → 本次补丁合入（版本演进）
//   journal:dispatch       "task#N channel=reuse X"  → 本次复用命中（成本结构证据）
// 语义边界：review 只翻转 retained，不删任何文件。未勾选的候选保持
// retained=false（B 路径自动复用不命中），资产源码、fixture、评分卡全部留在库里
// ——「不保留」是可逆的降权，不是删除。drop 的语义同理（退出自动复用，
// 显式寻址 ?专家 与 C 路径记忆化派单仍可用）。

export interface RunMint {
  name: string;
  version: string;
  eval: string; // mint-register 携带的 fixture 验收分（"1" / "0.67" …）
}

export interface RunPatch {
  name: string;
  note: string; // 补丁 remedy 摘要
}

/** 一次运行的 harness 接触面（事件溯源得出）。 */
export interface RunScope {
  dir: string;
  label: string;
  task: string;
  model: string;
  ok: boolean;
  minted: RunMint[];
  patched: RunPatch[];
  reused: string[];
}

/** 复核表里的一行（运行接触面 ∩ 注册表元数据）。 */
export interface ReviewCandidate {
  name: string;
  version: string;
  source: string;
  retained: boolean;
  description: string;
  capabilities: string[];
  eval_score: number;
  pass_rate: number;
  uses: number;
  /** 本次运行的接触面：minted（铸出）/ patched（补丁）/ reused（复用命中）。 */
  origin: string[];
  /** 本次验收分（仅 minted 有）。 */
  evalInRun: string;
  /** 本次补丁说明（仅 patched 有）。 */
  patchNote: string;
}

export interface ReviewPlan {
  scope: RunScope | null;
  candidates: ReviewCandidate[];
  /** 待决策集：本次铸出/合入且尚未保留的候选（review 的选取对象）。 */
  pending: ReviewCandidate[];
  /** 已在库中保留、本次仅被复用的存量资产（只作上下文展示，不参与选取）。 */
  settled: ReviewCandidate[];
}

export interface RunDirInfo {
  dir: string;
  name: string;
  mtimeMs: number;
}

/** 工作区内全部 run 产物目录，最新在前（按目录 mtime）。 */
export function listRunDirs(ws: string): RunDirInfo[] {
  const out: RunDirInfo[] = [];
  for (const name of listOutDirs(ws)) {
    const dir = path.join(ws, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch { /* 目录已消失：忽略 */ }
    out.push({ dir, name, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 最新 run 目录（org review 的字面缺省 —— 「最近一次运行」）。 */
export function latestRunDir(ws: string): string | null {
  return listRunDirs(ws)[0]?.dir ?? null;
}

/**
 * 最新「有 harness 产出」的 run 目录（org review 的实用缺省）。
 * 为什么不用字面最新：一次 demo 会连跑 out-a…out-c 再跑 out-direct /
 * out-handoff，最后落盘的往往是直连或移交（不铸专家、不打补丁）——按字面
 * 最新选范围会永远命中最不相关的那次。这里从新到旧取第一个有铸出/补丁的
 * 运行；全都没有时回落字面最新（由调用方如实展示范围）。
 */
export function latestHarnessRunDir(ws: string): string | null {
  const dirs = listRunDirs(ws);
  for (const d of dirs) {
    const scope = runScopeOf(d.dir);
    if (scope.minted.length > 0 || scope.patched.length > 0) return d.dir;
  }
  return dirs[0]?.dir ?? null;
}

/** 解析一次运行的 harness 接触面。产物缺失时返回全空（不抛错）。 */
export function runScopeOf(dir: string): RunScope {
  const events = readEventStream(
    path.join(dir, "events.jsonl"),
    path.join(dir, "journal.jsonl"),
    path.join(dir, "llm-stream.jsonl"),
  );
  const minted: RunMint[] = [];
  const patched: RunPatch[] = [];
  const reused: string[] = [];
  for (const ev of events) {
    if (ev.kind !== "journal") continue;
    if (ev.action === "mint-register") {
      const m = /^([^@\s]+)@(\S+?)(?:\s+eval=(\S+))?\s*$/.exec(ev.detail);
      if (m) minted.push({ name: m[1]!, version: m[2]!, eval: m[3] ?? "" });
    } else if (ev.action === "asset" && ev.detail.startsWith("patch ")) {
      const m = /^patch\s+([^@\s:]+)\s*(?:::\s*)?(.*)$/.exec(ev.detail);
      if (m) patched.push({ name: m[1]!, note: (m[2] ?? "").trim() });
    } else if (ev.action === "dispatch" && ev.detail.includes("channel=reuse ")) {
      const name = ev.detail.split("channel=reuse ")[1]?.trim();
      if (name && !reused.includes(name)) reused.push(name);
    }
  }
  const runJson = readRunJson(dir);
  return {
    dir,
    label: path.basename(dir),
    task: runJson?.task ?? "",
    model: runJson?.model ?? "",
    ok: runJson?.ok === true,
    minted,
    patched,
    reused,
  };
}

/**
 * 组装复核表：runDir（缺省 = 最新 run）的接触面与注册表元数据 join。
 * 只列出注册表里仍在册的名字 —— 历史运行产物指向已删除专家时静默跳过。
 */
export function reviewCandidates(ws: string, runDir?: string | null): ReviewPlan {
  const dir = runDir ?? latestRunDir(ws);
  if (!dir || !fs.existsSync(dir)) return { scope: null, candidates: [], pending: [], settled: [] };
  const scope = runScopeOf(dir);
  const byName = new Map(loadRegistryIndex(ws).map((m) => [m.name, m]));
  const origin = new Map<string, Set<string>>();
  const touch = (name: string, kind: string): void => {
    const set = origin.get(name) ?? new Set<string>();
    set.add(kind);
    origin.set(name, set);
  };
  for (const m of scope.minted) touch(m.name, "minted");
  for (const p of scope.patched) touch(p.name, "patched");
  for (const r of scope.reused) touch(r, "reused");

  const candidates: ReviewCandidate[] = [];
  for (const [name, kinds] of origin) {
    const m = byName.get(name);
    if (!m) continue;
    const evalInRun = scope.minted.find((x) => x.name === name)?.eval ?? "";
    candidates.push({
      name,
      version: m.version,
      source: m.source,
      retained: m.retained !== false,
      description: String((m as Record<string, unknown>).description ?? ""),
      capabilities: Array.isArray(m.capabilities) ? (m.capabilities as string[]) : [],
      eval_score: typeof m.eval_score === "number" ? m.eval_score : 0,
      pass_rate: typeof m.pass_rate === "number" ? m.pass_rate : 0,
      uses: typeof m.uses === "number" ? m.uses : 0,
      origin: [...kinds],
      evalInRun,
      patchNote: scope.patched.find((x) => x.name === name)?.note ?? "",
    });
  }
  // 本次铸出/合入的排前面（有选取价值），仅被复用的存量排后面
  const rank = (c: ReviewCandidate): number =>
    c.origin.includes("minted") ? 0 : c.origin.includes("patched") ? 1 : 2;
  candidates.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const isDecision = (c: ReviewCandidate): boolean =>
    c.origin.some((o) => o === "minted" || o === "patched") && !c.retained;
  const pending = candidates.filter(isDecision);
  const settled = candidates.filter((c) => !isDecision(c));
  return { scope, candidates, pending, settled };
}

/**
 * 应用复核选取：keep 转正选中项（一次 git 提交留痕）。
 * 未勾选项不动 —— 它们本来就是 retained=false 的候选，无需额外动作。
 */
export function applyReview(ws: string, keep: string[]): { kept: string[]; missing: string[] } {
  if (keep.length === 0) return { kept: [], missing: [] };
  return setRetained(ws, keep, true);
}

// ---------- 工具库治理：导入用户自己的 harness（org import / TUI :import） ----------
// 语义：导入 = 用户在场交付自己的 .hsl harness 进工具库。与 factory 产物不同，
// 导入是用户的显式动作 —— source="import" 且 retained=true（B 路径立即可用，
// 与 manual 存量同待遇，见 manifest.hsl find_reusable 的判据）。
// 质量闸门：导入前强制 dhv check（不通过拒绝入库 —— 工具库不收坏 harness）。

export interface ImportOptions {
  name?: string;              // 缺省取文件名 stem
  description?: string;       // 缺省取文件首个 /// 文档注释
  capabilities?: string[];    // 缺省扫描 #[capability(...)] 注解
}

export interface ImportResult {
  name: string;
  version: string;
  file: string;               // 入库后的 harness 文件（registry/harnesses/<name>.hsl）
  description: string;
  capabilities: string[];
  checkOutput: string;
  fixture: string;            // 随导入生成的占位剧本（direct:/handoff: 轨道）
}

/** 校验 harness 名（与专家名同域：小写字母/数字/连字符）。 */
export function validHarnessName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && name.length >= 2 && name.length <= 48;
}

/** 从 HSL 源码提取首个 /// 文档注释作为描述。 */
export function docCommentOf(source: string): string {
  for (const line of source.split("\n")) {
    const m = /^\s*\/\/\/\s?(.*)$/.exec(line);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return "";
}

/** 从 HSL 源码扫描 #[capability(...)] 注解（去重，保持出现顺序）。 */
export function capabilitiesOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/#\[capability\(\s*([a-zA-Z0-9_,\s]+?)\s*\)\]/g)) {
    for (const raw of m[1]!.split(",")) {
      const c = raw.trim();
      if (c.length > 0 && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/**
 * 导入一个用户 harness：check 闸门 → 复制入库 → 注册 index.json + 每专家
 * 副本 → git 提交留痕（与 keep/drop 同链 —— 增长率账本的一部分）。
 * 抛错即失败（CLI/TUI 捕获后展示）。check 通道默认 dhvRun（可注入替换）。
 */
export async function importHarness(
  ws: string,
  file: string,
  opts: ImportOptions = {},
  check: (args: string[]) => Promise<{ ok: boolean; out: string }> = dhvRun,
): Promise<ImportResult> {
  if (!fs.existsSync(file)) {
    throw new Error(`文件不存在：${file}`);
  }
  if (!file.endsWith(".hsl")) {
    throw new Error(`只接受 .hsl 文件（收到 ${path.basename(file)}）`);
  }
  const source = fs.readFileSync(file, "utf-8");
  if (source.trim().length === 0) {
    throw new Error("文件为空（空 harness 不能入库）");
  }
  // 质量闸门：dhv check 必须绿（导入的是要被 B 路径复用的资产）
  const checkRes = await check(["check", file]);
  if (!checkRes.ok) {
    throw new Error(`dhv check 未通过（工具库不收坏 harness）：\n${checkRes.out.trim().split("\n").slice(-6).join("\n")}`);
  }
  // 名字：--name 优先，缺省文件 stem；与注册表同域查重
  const name = (opts.name ?? path.basename(file, ".hsl")).toLowerCase();
  if (!validHarnessName(name)) {
    throw new Error(`名字不合法：${name}（小写字母开头，仅 a-z0-9-，2-48 字符）`);
  }
  const experts = loadRegistryIndex(ws);
  if (experts.some((m) => m.name === name)) {
    throw new Error(`注册表已有同名专家：${name}（改名或先 org drop）`);
  }
  const description = (opts.description && opts.description.length > 0)
    ? opts.description
    : (docCommentOf(source) || `(imported harness ${name})`);
  const capabilities = (opts.capabilities && opts.capabilities.length > 0)
    ? opts.capabilities
    : (capabilitiesOf(source).length > 0 ? capabilitiesOf(source) : ["general"]);

  // 入库：registry/harnesses/<name>.hsl（用户源文件原样保存，可追溯）
  const harnessDir = path.join(ws, "registry", "harnesses");
  fs.mkdirSync(harnessDir, { recursive: true });
  const dest = path.join(harnessDir, `${name}.hsl`);
  fs.copyFileSync(file, dest);

  // 剧本联动（导入即能用）：占位剧本 direct:<name>（3 轮）+ handoff:<name>（1 轮）
  // 轨道 —— scripted 模式 org ask/handoff 立即可问答（记账/会话账本/ctx meter
  // 全链路可验证）；真实回答切 --model deepseek（fixture 不参与真实模式）。
  const placeholder = `[imported harness ${name}] 占位剧本应答（导入时自动生成，供 scripted 链路验证）。真实回答请 --model deepseek。`;
  const fixtureRel = `registry/harnesses/${name}.fixture.json`;
  fs.writeFileSync(
    path.join(ws, fixtureRel),
    JSON.stringify({ tracks: { [`direct:${name}`]: [placeholder, placeholder, placeholder], [`handoff:${name}`]: [placeholder] } }, null, 2) + "\n",
  );

  // 注册：index.json + 每专家副本（与 setRetained 双写形态一致）
  const entry: Record<string, unknown> = {
    name,
    version: "0.1.0",
    bnf: "v1.5.0",
    description,
    capabilities,
    signature: "fn main() -> Result<(), ExpertError>",
    source: "import",
    eval_score: 0.0,   // 诚实边界：未评估（不是 1.0 —— 导入 ≠ 已验证）
    pass_rate: 0.0,
    entry: `registry/harnesses/${name}.hsl`,
    fixture: fixtureRel,
    uses: 0,
    retained: true,    // 用户导入 = 用户保留（区别于 factory 候选）
    provenance: [{ imported_from: path.basename(file), at: new Date().toISOString() }],
  };
  fs.writeFileSync(path.join(ws, "registry/index.json"), JSON.stringify([...experts, entry]));
  fs.writeFileSync(path.join(ws, "registry", `${name}.json`), JSON.stringify(entry));
  git(ws, ["add", "registry/"]);
  git(ws, ["commit", "-q", "-m", `import ${name}@0.1.0 (user harness)`]);

  return {
    name, version: "0.1.0", file: dest,
    description, capabilities, checkOutput: checkRes.out.trim(),
    fixture: path.join(ws, fixtureRel),
  };
}

// ---------- 上下文窗口计量（Codex 风格：会话上下文占用可见） ----------
// 直连会话每轮把全部历史织入提示词（direct.hsl render_history）—— 上下文
// 占用随轮次单调增长。计量口径（诚实边界：近似估算，非精确 tokenizer）：
//   当前上下文 ≈ est(专家描述) + Σ est(每轮 问答) + 结构开销
// 与 direct.hsl 的 estimate_tokens 同源（chars/3），双端数字一致。

/** 模型上下文窗口（GLM-4.5，128K tokens）。 */
export const CONTEXT_WINDOW_TOKENS = 131_072;

/** 估算文本 token 数（与 HSL 侧 estimate_tokens 同口径：chars/3）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface ContextUsage {
  expert: string;
  session: string;
  turns: number;
  /** 全会话问答 token 合计（记账口径：每轮 tokens 求和）。 */
  billed: number;
  /** 当前上下文占用（近似：描述 + 全部历史 + 结构开销）。 */
  context: number;
  window: number;
}

/** 读取一个会话账本的上下文占用（缺账本 → null）。 */
export function contextUsageOf(ws: string, expert: string, session: string, description = ""): ContextUsage | null {
  const file = path.join(ws, "runtime", "sessions", expert, `${session}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let billed = 0;
  let qaChars = 0;
  let turns = 0;
  // 记录边界重组：历史账本存在 format! 裸插值形态（多行 answer 带字面换行，
  // 一条记录跨多行）。按 "\n{"turn": 重组后逐条解析：先标准 JSON，
  // 再退回字段定长布局的修复式（兼容存量坏账本，统计不再漏记）。
  const segments = raw.split(/\n(?=\{"turn":)/);
  for (const seg of segments) {
    const t = seg.trim();
    if (t.length === 0) continue;
    let o: { question?: string; answer?: string; tokens?: number } | null = null;
    try {
      o = JSON.parse(t) as { question?: string; answer?: string; tokens?: number };
    } catch {
      const m = t.match(
        /^\{"turn":\d+,"question":"([\s\S]*?)","answer":"([\s\S]*)","tokens":(\d+),"ctx_tokens":\d+\}$/,
      );
      if (m) o = { question: m[1], answer: m[2], tokens: Number(m[3]) };
    }
    if (!o) continue; // 坏行容忍
    turns += 1;
    billed += Number(o.tokens ?? 0);
    qaChars += (o.question ?? "").length + (o.answer ?? "").length;
  }
  // 口径统一（v0.4.17 修复）：完全复刻 HSL 侧 direct.hsl estimate_context
  // —— (desc + Σqa(含当轮) + 64 + 24×(T-1)) / 3，整体 floor。此前 TS 侧是
  // 「各段分别 ceil + 32×turns」，与 HSL 侧公式不同（注释却声称同源），
  // 每轮发散 ~10.7 tokens：[ctx] 计量条（HSL 权威落盘）与 org status /
  // TUI / Web 显示的数字随轮次持续走差。
  const context = Math.floor((description.length + qaChars + 64 + 24 * Math.max(0, turns - 1)) / 3);
  return { expert, session, turns, billed, context, window: CONTEXT_WINDOW_TOKENS };
}

/** 全工作区会话账本扫描（status / TUI 会话栏共用）。 */
export function listContextUsage(ws: string): ContextUsage[] {
  const out: ContextUsage[] = [];
  const experts = loadRegistryIndex(ws);
  const descOf = (name: string): string => {
    const hit = experts.find((m) => m.name === name);
    return hit ? String(hit.description ?? "") : "";
  };
  const root = path.join(ws, "runtime", "sessions");
  let expertsDirs: fs.Dirent[] = [];
  try {
    expertsDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of expertsDirs) {
    if (!e.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, e.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const usage = contextUsageOf(ws, e.name, f.replace(/\.jsonl$/, ""), descOf(e.name));
      if (usage && usage.turns > 0) out.push(usage);
    }
  }
  return out.sort((a, b) => a.expert.localeCompare(b.expert) || a.session.localeCompare(b.session));
}

/** 渲染上下文计量条：▓▓░░░ 8.4k/128k（6.6%）（CLI status / TUI 共用）。 */
export function renderContextMeter(usage: { context: number; window: number }): string {
  const pct = usage.window > 0 ? usage.context / usage.window : 0;
  const cells = 12;
  const filled = Math.max(usage.context > 0 ? 1 : 0, Math.min(cells, Math.round(pct * cells)));
  const bar = "▓".repeat(filled) + "░".repeat(cells - filled);
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `${bar} ${fmt(usage.context)}/${fmt(usage.window)}（${(pct * 100).toFixed(1)}%）`;
}

/** 剧本形态校验：tracks / acts / reviews 任一键存在即视为 run 剧本 ——
 *  防 TaskSpec 形态的验收样本（factory/samples/）被误当剧本传给 --fixture
 *  （实测 bug：对消费 $host.fixture 轨道的专家必然 FIXTURE_EXHAUSTED，
 *  「可用：无」且毫无提示）。 */
export function isTracksFixtureFile(abs: string): boolean {
  try {
    const obj = JSON.parse(fs.readFileSync(abs, "utf-8")) as Record<string, unknown>;
    return "tracks" in obj || "acts" in obj || "reviews" in obj;
  } catch {
    return false;
  }
}

/** 直连剧本自动发现（导入 harness 的零摩擦消费链）：专家 manifest 的
 *  fixture 字段按 source 二相解析（与 HSL 侧 factory/pipeline.hsl
 *  run_fixture_of 同语义，v0.4.17 修复：原先不分相，工厂专家的 fixture
 *  字段是 TaskSpec 形态验收样本 —— 把样本当剧本传，scripted 直连工厂
 *  专家必然 FIXTURE_EXHAUSTED）：
 *   source=import  → fixture 字段即 tracks 形态 run 剧本，直接可用；
 *   source=factory → run 剧本走约定 factory/fixtures/<name>.fixture.json；
 *   其它（manual） → fixture 字段经 tracks 形态校验后可用（防同类错配）；
 *  均未命中返回 null（调用方回退 STOCK_FIXTURE）。CLI org ask / chat /
 *  handoff、TUI ?专家、Web GUI 共用。 */
export function expertFixtureOf(ws: string, expert: string): string | null {
  const hit = loadRegistryIndex(ws).find((m) => m.name === expert);
  if (!hit) return null;
  const rec = hit as Record<string, unknown>;
  const rel = String(rec.fixture ?? "");
  const source = String(rec.source ?? "");
  if (source === "import" && rel) {
    const abs = path.join(ws, rel);
    return fs.existsSync(abs) ? abs : null;
  }
  if (source === "factory") {
    const conventional = path.join(ws, "factory", "fixtures", `${expert}.fixture.json`);
    return fs.existsSync(conventional) ? conventional : null;
  }
  if (rel) {
    const abs = path.join(ws, rel);
    if (fs.existsSync(abs) && isTracksFixtureFile(abs)) return abs;
  }
  return null;
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
  // v0.5.0：统一到 lib/sessions.ts（此前这里是第三份账本解析，只用逐行 JSON.parse
  // —— 存量坏账本会让 RunResult.directTurns 静默少数几轮，而 Web 侧显示的是全部）
  return libReadSession(workspace, expert, session).map((t) => ({
    turn: t.turn, question: t.question, answer: t.answer, tokens: t.tokens,
  }));
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
  retained: boolean;
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
      // 旧注册表无 retained 字段 → 默认 true（与 HSL 侧 registry_entry_to_manifest 同口径）
      retained: m.retained === undefined ? true : m.retained === true,
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
  llmStream: number;   // v0.4.15：流式增量尾随（llm-stream.jsonl）
  seen: Set<string>;   // 已推送的期刊签名（跨文件去重）
}

function pumpTick(outDir: string, off: PumpOffsets, q: EventQueue): void {
  const evFile = path.join(outDir, "events.jsonl");
  const jrFile = path.join(outDir, "journal.jsonl");
  const lsFile = path.join(outDir, "llm-stream.jsonl");
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
  // v0.4.15：流式增量（逐 token 渲染面）—— 行序即序，不参与去重
  const ls = tailLines(lsFile, off.llmStream);
  off.llmStream = ls.next;
  for (let i = 0; i < ls.lines.length; i++) {
    const raw = parseLlmStreamLine(ls.lines[i]!);
    if (raw) q.push(normalizeLlmStreamLine(raw, i));
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
  // 进程内车道：capture 元素携带原文（含换行），join("") 还原字节级输出 ——
  // 此前逐行过滤空行再 join("\n")，空行丢失且结尾无换行，与子进程车道
  // 输出不一致（B-8：两车道输出保真度必须一致，否则同一命令在有无 bun 环境
  // 下呈现不同结果，比对/测试/人眼对不齐）。
  const capture: string[] = [];
  const extra: Record<string, string> = { DHV_TS: shPath(dhv) };
  if (envExtra) Object.assign(extra, envExtra);
  const code = await runInproc(args, extra, capture);
  return { ok: code === 0, out: capture.join("") };
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
  // v0.4.2（B-8）：写入原文直接入队（不再逐行过滤空行）——子进程车道返回
  // 原始字节流，本车道也必须字节级一致；console 捕获由 captureFn 补换行。
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const silentWrite = (sink: string[]): ((chunk: unknown) => boolean) => {
    return (chunk: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : String(chunk));
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
    capture.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n");
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
    capture.push(`inproc import failed: ${(err as Error).message}\n`);
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
  const off: PumpOffsets = { events: 0, journal: 0, llmStream: 0, seen: new Set() };
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
      // 直连剧本自动发现：导入 harness 自带占位剧本（manifest.fixture）——
      // TUI ?专家 不传 fixture 也能立即 scripted 问答（零摩擦消费链）
      const fixture = opts.fixture
        ?? (opts.entry === "direct" && opts.expert ? expertFixtureOf(opts.workspace, opts.expert) : null)
        ?? STOCK_FIXTURE;
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
      // 交互式审批开关（缺省不开：见 RunOptions.approval 的说明）
      if (opts.approval === true) envExtra.ORG_APPROVAL = "1";
      if (opts.entry === "direct") {
        if (!opts.expert) throw new Error("direct 模式必填 expert（?专家名 问题?）");
        envExtra.ORG_ASK_EXPERT = opts.expert;
        envExtra.ORG_ASK_SESSION = opts.session ?? "default";
        envExtra.ORG_ASK_QUESTION = opts.task;
      }
      // 直连环境变量必须同时进入两条车道：bun 子进程车道（B.spawn env）与
      // 进程内车道（runInproc envExtra）。历史 bug：子进程车道漏合并 envExtra
      // → TUI `?专家 问题?` 在有 bun 的机器上以 usage 错误失败（进程内车道
      // 恰好正常，冒烟测试只覆盖了后者）。
      Object.assign(env, envExtra);
      const forceInproc = process.env.ORG_FORCE_INPROC === "1";
      const bun = forceInproc ? null : resolveBun();
      let code = 0;
      if (bun) {
        proc = B.spawn([bun, resolveDhv(), ...args], { env, stdout: "pipe", stderr: "pipe" });
        // v0.4.17：捕获 promise 与退出轮询并行，但 finish 前必须 await 全部
        // 捕获完成 —— 此前 void 悬空，proc.exited 先 resolve 时 finish 读
        // capture 取错误尾行可能拿到空/不完整（失败原因展示不稳定）。
        const captureDone = Promise.all([
          proc.stdout.text().then((t) => {
            for (const l of t.split("\n")) if (l.length > 0) capture.push(l);
          }),
          proc.stderr.text().then((t) => {
            for (const l of t.split("\n")) if (l.length > 0) capture.push(l);
          }),
        ]);
        for (;;) {
          pumpTick(outDir, off, q);
          const exited = await Promise.race([
            proc.exited.then((c) => ["exit", c] as const),
            sleep(POLL_MS).then(() => null),
          ]);
          if (exited !== null) { code = exited[1]; break; }
        }
        await captureDone; // 尾行捕获完整后再 finish（失败原因可诊断）
        pumpTick(outDir, off, q); // 收尾 flush
      } else {
        // 进程内 fallback：事件在 import 返回后一次性可见
        code = await runInproc(args, envExtra, capture);
        pumpTick(outDir, off, q);
      }
      if (code !== 0 && !canceled) {
        // v0.4.2（B-8）：in-proc 车道 capture 元素含内嵌换行（字节级保真），
        // 展平后再取尾部行，与子进程车道同一行粒度。
        const tail = capture.flatMap((l) => l.split("\n")).filter((l) => l.trim().length > 0).slice(-6).join(" / ");
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
  const events = readEventStream(path.join(outDir, "events.jsonl"), path.join(outDir, "journal.jsonl"), path.join(outDir, "llm-stream.jsonl"));
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

// ---------- v0.5.0：会话派生与版本回退（agent 应有的两个「反悔」通道） ----------
// 这两个功能的后端原语都已存在，缺的只是用户可触达的入口：
//   fork   —— 会话账本本来就是 append-only 的普通文件，复制即派生；
//   revert —— 工厂每次补丁都把旧源归档为 registry/experts/<name>@<旧版本>.hsl
//             （金丝雀回滚用的正是它），ExpertManifest::revert_version 也已存在。
// 对应 codex / opencode 的 /fork 与 /undo · diff/revert。

export interface ForkResult {
  expert: string;
  from: string;
  to: string;
  turns: number;
  file: string;
}

/**
 * 派生会话：把 `<expert>/<from>.jsonl` 复制为 `<to>.jsonl`。
 * 上下文从派生点继续，原会话不受影响（账本 append-only，复制即分叉）。
 */
export function forkSession(ws: string, expert: string, from: string, to: string): ForkResult {
  if (!validHarnessName(expert)) throw new Error(`专家名不合法：${expert}`);
  for (const [label, v] of [["源", from], ["目标", to]] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) throw new Error(`${label}会话 id 不合法：${v}`);
  }
  const src = path.join(ws, "runtime", "sessions", expert, `${from}.jsonl`);
  if (!fs.existsSync(src)) throw new Error(`源会话不存在：${expert}/${from}`);
  const dst = path.join(ws, "runtime", "sessions", expert, `${to}.jsonl`);
  if (fs.existsSync(dst)) throw new Error(`目标会话已存在：${expert}/${to}（派生不会覆盖，换一个 id）`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const body = fs.readFileSync(src, "utf-8");
  fs.writeFileSync(dst, body);
  const turns = body.split("\n").filter((l) => l.trim().length > 0).length;
  return { expert, from, to, turns, file: dst };
}

export interface RevertResult {
  name: string;
  from: string;
  to: string;
  live: string;
  archived: string | null;
}

/** 在岗源文件候选（工厂产物在 experts/，导入 harness 在 harnesses/）。 */
function liveSourceCandidates(ws: string, name: string): string[] {
  const out: string[] = [];
  const rec = loadRegistryIndex(ws).find((m) => m.name === name) as Record<string, unknown> | undefined;
  const entry = rec ? String(rec.entry ?? "") : "";
  if (entry.endsWith(".hsl")) out.push(path.join(ws, entry));
  out.push(path.join(ws, "registry", "experts", `${name}.hsl`));
  out.push(path.join(ws, "registry", "harnesses", `${name}.hsl`));
  return out;
}

/** 归档源路径（工厂补丁每次合入都把旧版本源留在这里）。 */
function archivePathOf(dir: string, name: string, version: string): string {
  return path.join(dir, `${name}@${version}.hsl`);
}

/** 某专家已归档的版本号（新→旧按语义排序，仅取 x.y.z 数字形）。 */
export function archivedVersions(ws: string, name: string): string[] {
  const seen = new Set<string>();
  for (const cand of liveSourceCandidates(ws, name)) {
    const dir = path.dirname(cand);
    if (!fs.existsSync(dir)) continue;
    // 归档命名是机械的 `<name>@<x.y.z>.hsl`（工厂合入补丁时写入）。用前缀/后缀
    // 切分而不是拼正则 —— 专家名里的字符不必再考虑正则元字符转义。
    const prefix = `${name}@`;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith(".hsl")) continue;
      const ver = f.slice(prefix.length, -".hsl".length);
      if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) seen.add(ver);
    }
  }
  return [...seen].sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
    return 0;
  });
}

/**
 * 版本回退：把归档源还原为在岗源，并把当前源归档（回退本身可逆）。
 * 「留在岗」的语义对齐金丝雀回滚：注册表版本号随之回退，git 留痕。
 */
export function revertExpert(ws: string, name: string, to?: string): RevertResult {
  const experts = loadRegistryIndex(ws);
  const rec = experts.find((m) => m.name === name);
  if (!rec) throw new Error(`注册表中没有专家：${name}`);
  const current = String(rec.version ?? "");
  const versions = archivedVersions(ws, name);
  const target = to ?? versions.find((v) => v !== current) ?? "";
  if (!target) {
    throw new Error(`没有可回退的归档版本（${name}@${current}）—— 归档源出现的前提是工厂合入过补丁`);
  }
  if (target === current) throw new Error(`目标版本与当前版本相同：${name}@${current}`);

  const live = liveSourceCandidates(ws, name).find((p) => fs.existsSync(p));
  if (!live) throw new Error(`找不到在岗源文件（${name}）`);
  const dir = path.dirname(live);
  const archive = archivePathOf(dir, name, target);
  if (!fs.existsSync(archive)) throw new Error(`归档源不存在：${path.relative(ws, archive)}（可选：${versions.join(", ") || "无"}）`);

  // 1) 当前源归档（保证可逆）—— 已存在则不覆盖（同一版本重复回退是幂等的）
  const keep = archivePathOf(dir, name, current);
  let archived: string | null = null;
  if (current && !fs.existsSync(keep)) {
    fs.copyFileSync(live, keep);
    archived = keep;
  }
  // 2) 还原目标版本源
  fs.copyFileSync(archive, live);
  // 3) 注册表版本号回退（index.json + 每专家副本，与 setRetained 同双写形态）
  for (const m of experts) {
    if (m.name === name) m.version = target;
  }
  fs.writeFileSync(path.join(ws, "registry/index.json"), JSON.stringify(experts));
  const per = path.join(ws, "registry", `${name}.json`);
  if (fs.existsSync(per)) {
    try {
      const obj = JSON.parse(fs.readFileSync(per, "utf-8")) as Record<string, unknown>;
      obj.version = target;
      fs.writeFileSync(per, JSON.stringify(obj));
    } catch { /* 副本损坏容忍：index.json 是权威 */ }
  }
  gitCommitRegistry(ws, `revert ${name} ${current} -> ${target} (user revert)`);
  return { name, from: current, to: target, live, archived };
}

// ---------- 会话账本改名 / 删除（CLI org session，Web 已有同名端点的 CLI 面） ----------

export function renameSession(ws: string, expert: string, from: string, to: string): string {
  const src = path.join(ws, "runtime", "sessions", expert, `${from}.jsonl`);
  const dst = path.join(ws, "runtime", "sessions", expert, `${to}.jsonl`);
  if (!fs.existsSync(src)) throw new Error(`会话不存在：${expert}/${from}`);
  if (fs.existsSync(dst)) throw new Error(`目标会话已存在：${expert}/${to}`);
  fs.renameSync(src, dst);
  return dst;
}

export function deleteSession(ws: string, expert: string, session: string): string {
  const file = path.join(ws, "runtime", "sessions", expert, `${session}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`会话不存在：${expert}/${session}`);
  fs.rmSync(file);
  return file;
}
