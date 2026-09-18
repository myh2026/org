// ============================================================================
// org/web/entry.ts — Web GUI 入口（Bun.serve 零依赖）
// ----------------------------------------------------------------------------
//   org web [--port N] [--workspace DIR] [--model scripted|deepseek]
//     Bun.serve 起轻量 HTTP（默认端口 4600，避开本机 3000/3030/5000 服务），
//     单页内联 HTML（无静态文件 / 无第三方依赖），原生 fetch 交互。
//
// 端面（GUI 是薄渲染层，逻辑全部复用 CLI 同一代码路径）：
//   GET    /                        单页 GUI（Codex 风终端美学：近黑 zinc ·
//                                   等宽 chrome · 发丝边框 · tmux 式状态栏）
//   GET    /api/status              专家清单 + 会话上下文占用 + 服务级 model
//   GET    /api/runs                运行产物列表（out-*，TUI 会话栏同源）
//   GET    /api/run?dir=out-a       单次运行回放（journal/events/metrics/scorecard）
//   GET    /api/score?dir=out-a     评分卡（缺省取最新）
//   GET    /api/cost?dir=out-a      用量/成本时间线（llm_stream_done 的消费面）
//   GET    /api/approvals           待批准项 + 长期放行集（审批队列文件协议）
//   POST   /api/approvals           决策：body {id, allow, always?} → 写回复文件
//   POST   /api/run-stream          团队模式派单（SSE：open → queued? → start →
//                                   run → card* → done/error）。与 CLI org run /
//                                   TUI 团队输入同一代码路径（startRun entry:"org"）；
//                                   card 帧是归一化 EngineEvent，Web 侧用
//                                   lib/runCards.ts 的同一份解析契约渲染
//   POST   /api/keep                工具库治理：选取保留（候选转正，git 留痕）
//   POST   /api/drop                工具库治理：取消保留（退出 B 路径自动复用）
//   GET    /api/review?run=         运行范围复核：本次运行碰过哪些 harness
//                                   （铸出 / 补丁 / 复用）+ 待决策候选
//   POST   /api/review              按运行范围选取沉淀：body {run?, keep:[名]}
//                                   （只翻转 retained；越界名 409 拒绝）
//   GET    /api/sessions?expert=X   会话列表（runtime/sessions/<expert>/*.jsonl）
//   GET    /api/session/<E>/<S>     逐轮 question/answer/tokens/ctx_tokens
//   DELETE /api/session/<E>/<S>     删除会话（删账本文件 = 删会话）
//   PATCH  /api/session/<E>/<S>     重命名会话（body {to}，同专家 mv 账本）
//   POST   /api/ask                 进程内直连（JSON 整轮，兼容并存）
//   POST   /api/ask-stream          SSE 流式（open → queued? → start →
//                                   stage* → log* → done/error）
//   POST   /api/abort               停止生成：body {id} 可选 —— 无 id/
//                                   id=运行轮 → SIGKILL 当前 org 子进程
//                                   （该轮不落账本）；id=排队轮 → 预先取消
//                                   （轮到时拒绝执行，SSE 发 error{aborted,queued}）
//
// 入口形态（与 tui/entry.ts 同模式）：
//   cli/org.ts cmdWeb      org web 子命令（进程内 import 本文件；bun compile
//                          会把 web/ 静态打进单文件）
//   tests/web.test.ts      startWebServer 可编程入口（--port 0 随机高端口 +
//                          server.stop() 可停，CI 无残留进程）
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, DEFAULT_WORKSPACE } from "../lib/root.ts";
import {
  ensureWorkspace, loadRegistryIndex, listContextUsage,
  expertFixtureOf, dhvRun, resolveDhv, resolveBun, setRetained,
  reviewCandidates, applyReview,
  startRun, scanWorkspace, replayRun, latestScorecardDir, readScorecard,
  type RunHandle,
} from "../lib/engine.ts";
import { directAskGateOf, directDegradeAnswer, writeDirectDegradeRun, prependAskRescueEvent, type DirectAskGate } from "../lib/engine.ts"; // v0.5.14 直连语义地板（B-22）
import { tailLines } from "../lib/events.ts";
import type { EngineEvent } from "../lib/events.ts";
import { classifyRunEvent } from "../lib/runCards.ts";
import { listApprovals, decideApproval } from "../lib/approvals.ts";
import { readCostTimeline, latestHarnessRunDir } from "../lib/engine.ts";
import { AskGate, QueueCancelledError } from "./gate.ts";
import { transcribeAudio, synthesizeSpeech, voiceStatus, VOICES } from "../lib/voice.ts"; // v0.5.12 语音入口（ASR/TTS）
import { analyzeImages, visionStatus, VISION_MAX_IMAGES } from "../lib/vision.ts"; // v0.5.13 视觉入口（VLM 图片理解）
import { ORG_VERSION as VERSION } from "../lib/version.ts"; // 版本单一来源（v0.4.14 漂移治理：此前本文件落后两版）
import { latestSession } from "../lib/sessions.ts"; // v0.5.17：collab bridge 缺省会话（只读复用会话账本协议）
import {
  currentUser, setUser, postThread, commentOn, listThreads, threadFeed, flattenThread,
  collaborators, collabSummary, bridgeSession, COLLAB_DIR_REL,
} from "../lib/collab.ts"; // v0.5.17 团队协作层（#87 团队共享会话/评论）

const DIRECT_ENTRY = path.join(ROOT, "hsl/pool/direct.hsl");
const STOCK_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");
const DEFAULT_PORT = 4600; // 3000/3030/5000 被本机其他服务占用，绝不复用

/** v0.5.12：语音服务探测缓存（60s —— 面板状态行不发探测风暴）。 */
const voiceStatusCache = new Map<number, { at: number; value: { sdk: boolean; voices: number; error?: string } }>();
const visionStatusCache = new Map<number, { at: number; value: { sdk: boolean; formats: number; error?: string } }>();

// ---- 参数解析 ----

export interface WebParsed {
  workspace: string;
  model: string;
  port: number;
  host: string;
  gateway: string;
}

export function parseWebArgv(argv: string[]): WebParsed {
  const p: WebParsed = {
    workspace: process.env.ORG_WORKSPACE ?? DEFAULT_WORKSPACE,
    model: "scripted",
    port: DEFAULT_PORT,
    host: process.env.ORG_WEB_HOST ?? "127.0.0.1", // 默认只听回环（本地 GUI 原型）；ORG_WEB_HOST=0.0.0.0 可远程/容器访问
    gateway: process.env.DHV_LLM_GATEWAY ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--workspace" || a === "-w") p.workspace = path.resolve(argv[++i] ?? p.workspace);
    else if (a === "--model" || a === "-m") p.model = argv[++i] ?? "scripted";
    else if (a === "--port" || a === "-p") p.port = Number(argv[++i] ?? DEFAULT_PORT) || DEFAULT_PORT;
    else if (a === "--host") p.host = argv[++i] ?? p.host;
    else if (a === "--gateway" || a === "-g") p.gateway = argv[++i] ?? "";
  }
  return p;
}

/** 读命令的默认工作区（与 cli/org.ts cmdStatus 同规则）：
 *  demo-run 有注册表 → 用之（活数据）；否则 dist/demo 入库快照兜底（只读）。 */
function readWorkspaceOf(ws: string): string {
  if (fs.existsSync(path.join(ws, "registry", "index.json"))) return ws;
  const snapshot = path.join(ROOT, "dist", "demo");
  if (fs.existsSync(path.join(snapshot, "registry", "index.json"))) return snapshot;
  return ws;
}

// ---- 会话账本（v0.5.0：解析统一到 lib/sessions.ts） ----
// 此前 Web / chat / engine 各有一份账本解析，健壮性还不一致（Web 有记录边界重组与
// 修复式解析，另两处只逐行 JSON.parse）→ 同一份账本在不同前端显示的轮数不同，且
// **compacted 只有 chat 解析**（Web 把压缩摘要当普通轮次渲染）。现统一到 lib。
// 本文件保留 parseLedgerRaw 的再导出：tests/web.test.ts 直接单测它。

export type { LedgerTurn } from "../lib/sessions.ts";
export { parseLedgerRaw } from "../lib/sessions.ts";
import {
  parseLedgerRaw, readSession as libReadSession, listSessionIds,
  type LedgerTurn,
} from "../lib/sessions.ts";
import { prepareLlmEnv, readLedger, poolView, budgetWatermark } from "../lib/router.ts"; // 车道环境准备（v0.5.1 · 池状态/预算水位 v0.5.5）
import { loadConfig, applyPreset, setConfigValue, unsetConfigValue, setLaneValue,
         removeLane, useLane, addApiKey, autoFromEnv } from "../lib/config.ts";
import { PROVIDER_NAMES, discoverEnvLanes, resolveModelFlag, providerRows, testLane } from "../lib/providers.ts";
import {
  submitTask, listTasks, getTask, readTaskJournal, cancelTask, pauseTask,
  resumeTask, retryTask, TaskRunner, type TaskRecord, type TaskStatus,
} from "../lib/tasks.ts"; // 长程任务队列（v0.5.2）
import {
  addSchedule, listSchedules, removeSchedule, setScheduleEnabled, previewNext,
} from "../lib/schedule.ts"; // 定时任务触发器（v0.5.5）
import {
  readNotifications, unreadCount, markRead, clearNotifications, notifyEvent,
} from "../lib/notify.ts"; // 通知中心（v0.5.2）
import { expandMentions } from "../lib/mentions.ts"; // @文件引用（v0.5.3）
import { listMemories, addMemory, removeMemory, allMemories } from "../lib/memories.ts"; // 长期记忆（v0.5.3）
import { semanticSearch } from "../lib/search.ts"; // 语义检索（v0.5.8 · capabilities #19/#22）
import { scanAndRenderArtifacts } from "../lib/audio.ts"; // 音频收尾（v0.5.9：GUI 直连车道的三入口同钩子）
import { dbSchema, dbQuery, dbTables } from "../lib/db.ts"; // v0.5.15 数据库操作层（#43/#73）
import { indexSymbols, lookupDef, findRefs } from "../lib/symbols.ts"; // v0.5.15 符号索引（#20）
import { scanWorkspace as scanSecrets, SECRET_PATTERNS } from "../lib/scan.ts"; // v0.5.15 密钥扫描（#141；别名避开 engine.ts 的 scanWorkspace）
import { exportAudit, auditSummary } from "../lib/audit.ts"; // v0.5.15 审计导出（#150）
import { buildSbom, renderSpdxJson } from "../lib/sbom.ts"; // v0.5.15 SBOM（#148）
import { loadCodeowners, recommendReviewers } from "../lib/owners.ts"; // v0.5.15 CODEOWNERS/评审推荐（#89/#85）
import { dbDiagnose } from "../lib/dbdiag.ts"; // v0.5.16 数据库查询诊断（#113）
import { gitMergeState, gitMerge, gitRebase } from "../lib/gitmerge.ts"; // v0.5.16 merge/rebase（#80）
import { loadRbac, rbacCheck, rbacRoles, rbacActions } from "../lib/rbac.ts"; // v0.5.16 RBAC（#149）
import { scanIac, IAC_RULES } from "../lib/iacscan.ts"; // v0.5.16 IaC 扫描（#147）
import { pluginList, pluginInstall, pluginRemove } from "../lib/plugins.ts"; // v0.5.16 插件市场（#132）
import { parseOpenApiText, parseOpenApiFile, suggestToolName } from "../lib/openapi.ts"; // v0.5.16 OpenAPI（#134）
import { browserEngines, browserSnapshot, browserScreenshot } from "../lib/browser.ts"; // v0.5.16 浏览器（#116/#30）
import { completeAt } from "../lib/completion.ts"; // v0.5.16 代码补全（#32）
import { applyRename } from "../lib/rename.ts"; // v0.5.16 项目级重命名（#56）
import { lspDefinition, lspReferences, lspHover, detectLspServers, protocolSelfTest, resolveJailedFile } from "../lib/lsp.ts"; // v0.5.17 LSP/DAP 协议集成（#26）
import { cloudProbeAll, probeDocker, probeSsh, probeK8s, probeTerraform, probeCloudClis, cloudProvidersOverview,
         dockerRun, dockerBuild, dockerfileFor, composeFor, dockerPlan,
         sshRun, scpUpload, sshConfigTemplate, sshPlan, k8sRun, k8sManifestFor, terraformPlan } from "../lib/cloud.ts"; // v0.5.17 云生态统一模块（#67/#68/#72/#74）
import { suggestBreakpoints, debugPlan, dapSelfTest } from "../lib/debug.ts"; // v0.5.17 断点/调试建议（#108）
import { probeMobile, mobileDevices, mobileLogcat, mobileDebugPlan, mobileSelfTest, MOBILE_PLAN_PLATFORMS } from "../lib/mobile.ts"; // v0.5.18 移动端调试（#117）

// ---- 会话目录扫描（防路径穿越：expert/session 名只允许字母数字连字符下划线） ----

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// v0.5.9：音色试听样本缓存（timbre|chords|style → WAV Buffer；64 条粗上限）
const audioDemoCache = new Map<string, Buffer>();

function sessionFile(ws: string, expert: string, session: string): string | null {
  if (!SAFE_NAME.test(expert) || !SAFE_NAME.test(session)) return null;
  return path.join(ws, "runtime", "sessions", expert, `${session}.jsonl`);
}

export interface SessionSummary {
  id: string;
  expert: string;
  turns: number;
  lastAt: string;
  preview: string;
}

/** 列某专家的会话（mtime 降序）。解析在 lib/sessions.ts；
 *  展示选择归 Web：预览用**首问**（GUI 侧栏要「这会话在聊什么」的锚点）。 */
export function listSessions(ws: string, expert: string): SessionSummary[] {
  if (!SAFE_NAME.test(expert)) return [];
  return listSessionIds(ws, expert).map(({ id, turns, mtimeMs }) => ({
    id,
    expert,
    turns: turns.length,
    lastAt: new Date(mtimeMs).toISOString(),
    preview: turns[0]!.question.slice(0, 40),
  })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function readSession(ws: string, expert: string, session: string): LedgerTurn[] {
  if (!SAFE_NAME.test(expert) || !SAFE_NAME.test(session)) return [];
  return libReadSession(ws, expert, session);
}

// ---- org ask 进程内直连（与 cli/org.ts cmdAsk 同链路） ----

export interface AskOutcome {
  ok: boolean;
  answer: string;
  tokens: number | null;
  ctxLine: string;
  durationMs: number | null;
  turn: number | null;
  logs: string;
  /** v0.5.9：直连车道的音频产物（out-ask 的 audio_rendered 事实；无则缺省）。 */
  audio?: Array<{ wavFile: string; midiFile?: string; timbre?: string; durationSec: number; notes: number; title: string }>;
  /** v0.5.14：B-22 直连语义地板 —— 域外问题的跨车道救援元数据（换专家应答
   *  的事实回执；GUI 气泡渲染 ⇄ 徽标，回放面板由 lane_rescue 事件渲染卡）。 */
  rescue?: { from: string; to: string; score: number; selfScore: number };
  /** v0.5.14：零消耗降级（不落账本，不跑模型；answer 自带 ◌ 叙事与出路）。 */
  degraded?: boolean;
}

/** 解析 direct.hsl 的 stdout：[direct] 行 → 回答正文（多行）→ [ctx] 行 →
 *  ✓ harness 返回 Ok（Y ms）。单轮形态 `[direct] {专家} 回答（X tokens）：`，
 *  多轮形态 `[direct] turn N —— {专家}（X tokens）：`，两种都兼容。 */
export function parseAskOut(out: string): AskOutcome {
  const lines = out.split("\n");
  let answer: string[] = [];
  let tokens: number | null = null;
  let ctxLine = "";
  let durationMs: number | null = null;
  let turn: number | null = null;
  let inAnswer = false;
  for (const line of lines) {
    const multi = line.match(/^\[direct\]\s+turn\s+(\d+)\s+——\s+(.+?)（(\d+)\s*tokens）：\s*$/);
    const single = multi ? null : line.match(/^\[direct\]\s+(.+?)回答（(\d+)\s*tokens）：\s*$/);
    const direct = multi ?? single;
    if (direct) {
      if (multi) turn = Number(multi[1]); // 多轮形态直接带轮号
      tokens = Number((multi ?? single)![multi ? 3 : 2]!);
      inAnswer = true;
      answer = [];
      continue;
    }
    if (line.startsWith("[ctx]")) {
      ctxLine = line.trim();
      inAnswer = false;
      const t = ctxLine.match(/（(\d+)\s*轮累计）/);
      if (t) turn = Number(t[1]);
      continue;
    }
    const dur = line.match(/harness 返回 Ok（(\d+)\s*ms）/);
    if (dur) {
      durationMs = Number(dur[1]);
      continue;
    }
    if (inAnswer) answer.push(line);
  }
  return {
    ok: /harness 返回 Ok/.test(out),
    answer: answer.join("\n").trim(),
    tokens,
    ctxLine,
    durationMs,
    turn,
    logs: out.trim(),
  };
}

// ask 串行锁：direct 流水线固定写 workspace/out-ask（与 org ask 同产物约定），
// 并发 POST 会让两个运行互踩产物目录 —— 原型用单飞队列（一次一轮）。
// v0.4.14：串行门抽到 web/gate.ts（排队票据化，排队轮可预先取消 ——
// 此前 abort 只认 runningProc，排队中的第二轮既撤不回、还可能误伤前一轮）；
// gate.busy 供 SSE 端点诚实告知「排队中」（多用户并发原型取舍）。
const gate = new AskGate();

// 兼容旧名（非 SSE 端点与内部语义沿用）
function askSerialized<T>(fn: () => Promise<T>, ticket: Parameters<AskGate["enter"]>[1]): Promise<T> {
  return gate.enter(fn, ticket);
}

/** v0.5.14：直连语义地板闸门（B-22）—— askOnce / askStreamOnce 共用。
 *  返回 kind=degrade = 零消耗降级（调用方写产物 + 直接返回诚实应答）；
 *  kind=run 携带有效专家/剧本（reroute 时已换）。仅 scripted 车道介入；
 *  真实车道任何专家答任何问题（域感知是模型的活，不是桥的活）。 */
type AskGatePrep =
  | { kind: "run"; gate: DirectAskGate; expert: string; fixture: string }
  | { kind: "degrade"; gate: DirectAskGate };

function askGatePrepare(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
  question: string,
  scripted: boolean,
): AskGatePrep {
  const gate = directAskGateOf(ws, req.expert, question, scripted);
  if (gate.kind === "degrade") return { kind: "degrade", gate };
  if (gate.kind === "reroute") {
    return { kind: "run", gate, expert: gate.expert!, fixture: gate.fixture! };
  }
  return {
    kind: "run", gate, expert: req.expert,
    fixture: expertFixtureOf(ws, req.expert) ?? STOCK_FIXTURE,
  };
}

/** v0.5.14：reroute 事后回执 —— AskOutcome.rescue 元数据 + out-ask 事件前插
 *  （回放面板渲染 ⇄ 卡）。 */
function annotateAskRescue(
  outcome: AskOutcome,
  req: { expert: string },
  prep: { gate: DirectAskGate; expert: string },
  outDir: string,
): void {
  outcome.rescue = {
    from: req.expert, to: prep.expert,
    score: prep.gate.score ?? 0, selfScore: prep.gate.selfScore ?? 0,
  };
  prependAskRescueEvent(outDir, {
    mode: "reroute", from: req.expert, expert: prep.expert,
    score: prep.gate.score ?? 0, selfScore: prep.gate.selfScore ?? 0,
    floor: 0.15,
  });
}

/** 进程内执行一轮直连（DIRECT_ENTRY + env ORG_ASK_* + expertFixtureOf 剧本
 *  自动发现 + dhvRun 双车道）。不 spawn CLI 自身（web 服务进程内完成）。 */
async function askOnce(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
): Promise<AskOutcome> {
  ensureWorkspace(ws);
  // 车道环境准备（v0.5.1）：--model 车道名/裸模型 id 统一解析（key 池/
  // 降级链/路由器）；scripted 与未知名零影响
  const lane = await prepareLlmEnv(req.model, ws);
  // v0.5.3：@文件/目录引用展开（workspace 相对路径 → 围栏内容注入）
  let question = req.question;
  if (req.question.includes("@")) {
    const m = expandMentions(req.question, ws);
    if (m.expanded.length > 0) question = m.text;
  }
  const outDir = path.join(ws, "out-ask");
  // v0.5.14：B-22 直连语义地板 —— 域外问题不再套罐头答非所问
  const prep = askGatePrepare(ws, req, question, lane.kind === "scripted");
  if (prep.kind === "degrade") {
    writeDirectDegradeRun(outDir, req.expert, question, prep.gate);
    return {
      ok: true, answer: directDegradeAnswer(req.expert, prep.gate),
      tokens: 0, ctxLine: "", durationMs: 0, turn: null,
      logs: `◌ 零消耗降级：${prep.gate.reason ?? "问题在所选专家的剧本域外"}`,
      degraded: true,
    };
  }
  const env: Record<string, string> = {
    ORG_ASK_EXPERT: prep.expert,
    ORG_ASK_SESSION: req.session,
    ORG_ASK_QUESTION: question,
    // v0.5.10：GUI 直连默认开工具环（B-19 伴生：直连 t-bot 的
    // audio_compose/fs_write 此前因 ORG_TOOLS 缺省 Off 而不执行 ——
    // v0.5.9 的 GUI 开箱演示实际只有纯文本；Full 即门类即用，写类
    // 仍审批在环；用户显式设置优先）
    ORG_TOOLS: process.env.ORG_TOOLS || "write",
  };
  const r = await dhvRun(
    [
      "run", DIRECT_ENTRY,
      "--workspace", ws,
      "--task", `(direct) ${question}`,
      "--model", req.model,
      "--fixture", prep.fixture,
      "--out", outDir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ],
    env,
  );
  const out = parseAskOut(r.out);
  if (prep.gate.kind === "reroute") annotateAskRescue(out, req, prep, outDir);
  return out;
}

// ---- 停止生成（POST /api/abort）----
// 运行中的 spawn 车道子进程登记在 runningProc；abort 端点 SIGKILL 它并立
// abortRequested 标记 —— 账本写入发生在 hsl 运行收尾，进程被杀即该轮不落
// 账本（与网站侧 orgAgent 工作台同一语义：干净丢弃）。sseAsk 在 outcome 返回
// 后查标记，把 done 改判为 error{aborted:true}。进程内车道（ORG_FORCE_INPROC）
// 无子进程可杀，abort 返回 ok:false 人话告知。

let runningProc: ReturnType<typeof Bun.spawn> | null = null;
let abortRequested = false;
/** 团队模式 run 的句柄（abort 走 RunHandle.cancel → SIGTERM，与直连的
 *  SIGKILL 路径分开：团队 run 由 lib/engine.ts 自己管子进程）。 */
let runningRun: RunHandle | null = null;

// ---- SSE 流式执行（spawn 车道增量读子进程 stdout 逐行回调） ----

/** direct.hsl 的真实流水线阶段（与 direct.hsl 源码对照；GUI 等待期轮换展示）。 */
export const ASK_STAGES = [
  "能力核对（capability gate）",
  "注册表寻址（resolve）",
  "会话史装载（ledger replay）",
  "模型网关调用（model gateway）",
  "记账与纪要回写（billing & ledger write）",
] as const;

/** 流式执行一轮直连：与 askOnce 同参数/同产物约定，区别在于 ——
 *  spawn 车道用 ReadableStream.getReader() 增量读 stdout/stderr，
 *  每凑齐一行即回调 onLog（banner/配置行到达即推，deepseek 长回答
 *  期间 GUI 不再黑盒等待）；进程内车道（ORG_FORCE_INPROC）无增量
 *  输出，仅返回最终结果（SSE 端点用 stage 事件填充等待期）。
 *  v0.4.15：onDelta —— llm-stream.jsonl 尾随（宿主流式车道逐 token 增量），
 *  reasoning/content/reset 三通道；GUI 逐 token 渲染正文 + 思考指示器。 */
async function askStreamOnce(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
  onLog: (line: string) => void,
  onDelta?: (channel: "reasoning" | "content" | "reset", delta: string) => void,
): Promise<AskOutcome> {
  ensureWorkspace(ws);
  // 车道环境准备（v0.5.1）：同 askOnce（spawn 车道读 process.env 注入）
  const lane = await prepareLlmEnv(req.model, ws);
  // v0.5.3：@文件/目录引用展开（与 askOnce 同规则）
  let question = req.question;
  if (req.question.includes("@")) {
    const m = expandMentions(req.question, ws);
    if (m.expanded.length > 0) question = m.text;
  }
  const outDir = path.join(ws, "out-ask");
  // v0.5.14：B-22 直连语义地板（与 askOnce 同规则；SSE 是 GUI 主路径）
  const prep = askGatePrepare(ws, req, question, lane.kind === "scripted");
  if (prep.kind === "degrade") {
    writeDirectDegradeRun(outDir, req.expert, question, prep.gate);
    onLog(`◌ 零消耗降级：${prep.gate.reason ?? "问题在所选专家的剧本域外"}`);
    return {
      ok: true, answer: directDegradeAnswer(req.expert, prep.gate),
      tokens: 0, ctxLine: "", durationMs: 0, turn: null,
      logs: `◌ 零消耗降级：${prep.gate.reason ?? "问题在所选专家的剧本域外"}`,
      degraded: true,
    };
  }
  const env: Record<string, string> = {
    ORG_ASK_EXPERT: prep.expert,
    ORG_ASK_SESSION: req.session,
    ORG_ASK_QUESTION: question,
    // v0.5.10：GUI 直连默认开工具环（与 askOnce 同规则，B-19 伴生）
    ORG_TOOLS: process.env.ORG_TOOLS || "write",
  };
  const args = [
    "run", DIRECT_ENTRY,
    "--workspace", ws,
    "--task", `(direct) ${question}`,
    "--model", req.model,
    "--fixture", prep.fixture,
    "--out", outDir,
    "--allow", "bun,node,ls,cat,grep,diff,git",
  ];
  const forceInproc = process.env.ORG_FORCE_INPROC === "1";
  const bun = forceInproc ? null : resolveBun();
  if (bun) {
    const dhv = resolveDhv();
    const full: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") full[k] = v;
    }
    full.DHV_TS = dhv.replace(/\\/g, "/");
    Object.assign(full, env);
    const proc = Bun.spawn([bun, dhv, ...args], { env: full, stdout: "pipe", stderr: "pipe" });
    runningProc = proc;
    const chunks: string[] = [];
    // v0.4.15：llm-stream.jsonl 尾随泵（120ms）—— 宿主流式车道的逐 token
    // 增量（deepseek 网关车道）；scripted/无网关时文件不出现，泵空转零成本。
    const streamTailer = startLlmStreamTailer(path.join(ws, "out-ask"), onDelta);
    // 行缓冲泵：chunk → 完整行（含跨 chunk 的半行拼接），逐行回调 + 原文留档
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          chunks.push(line + "\n");
          if (line.trim().length > 0) onLog(line);
        }
      }
      buf += dec.decode();
      if (buf.length > 0) {
        chunks.push(buf);
        if (buf.trim().length > 0) onLog(buf.replace(/\n$/, ""));
      }
    };
    try {
      await Promise.all([
        proc.exited,
        pump(proc.stdout as unknown as ReadableStream<Uint8Array>),
        pump(proc.stderr as unknown as ReadableStream<Uint8Array>),
      ]);
    } finally {
      streamTailer.stop();
      streamTailer.flush(); // 收尾冲刷：退出与最后一帧增量之间的竞态窗口补齐
      runningProc = null;
    }
    const streamed = withAskAudio(parseAskOut(chunks.join("")), outDir);
    if (prep.gate.kind === "reroute") annotateAskRescue(streamed, req, prep, outDir);
    return streamed;
  }
  // 进程内车道：无增量输出，走 dhvRun 拿最终结果
  const r = await dhvRun(args, env);
  const inproc = withAskAudio(parseAskOut(r.out), outDir);
  if (prep.gate.kind === "reroute") annotateAskRescue(inproc, req, prep, outDir);
  return inproc;
}

/** v0.5.9：直连产物音频附面（开袋即食的直连版）。
 * 背景：GUI 直连直接 spawn dhv 解释器，绕过 cli runHsl / lib/engine 的
 * 收尾钩子 → 此前三入口中唯独 Web 直连不渲染音频。这里补齐第三份钩子：
 * scanAndRenderArtifacts(out-ask)（幂等：mtime 判定，重跑不重复渲染）。
 * 容错：渲染/读失败静默降级为无音频（产物事实不改变问答语义）。 */
function withAskAudio(outcome: AskOutcome, outDir: string): AskOutcome {
  try {
    const r = scanAndRenderArtifacts(outDir);
    if (r.rendered.length > 0) {
      outcome.audio = r.rendered.map((a) => ({
        wavFile: a.wavFile,
        ...(a.midiFile ? { midiFile: a.midiFile } : {}),
        ...(a.timbre ? { timbre: a.timbre } : {}),
        durationSec: a.durationSec,
        notes: a.notes,
        title: a.title,
      }));
    }
  } catch { /* 渲染失败 → 无音频面（不改变问答语义） */ }
  return outcome;
}

/** llm-stream.jsonl 尾随泵（v0.4.15）：宿主流式车道的逐 token 增量 →
 *  onDelta 回调（reasoning/content/reset）。120ms 轮询 tailLines 语义
 *  （只取完整行，半行留待下次）；scripted/无网关时文件不出现，空转零成本。 */
function startLlmStreamTailer(
  outDir: string,
  onDelta?: (channel: "reasoning" | "content" | "reset", delta: string) => void,
): { stop(): void; flush(): void } {
  if (!onDelta) return { stop(): void {}, flush(): void {} };
  const file = path.join(outDir, "llm-stream.jsonl");
  let offset = 0;
  const drain = (): void => {
    const t = tailLines(file, offset);
    offset = t.next;
    for (const line of t.lines) {
      try {
        const o = JSON.parse(line) as { kind?: string; delta?: string };
        const kind = o.kind === "reasoning" || o.kind === "reset" ? o.kind : "content";
        onDelta(kind, String(o.delta ?? ""));
      } catch { /* 坏行容忍 */ }
    }
  };
  const timer = setInterval(drain, 120);
  return {
    stop(): void { clearInterval(timer); },
    flush(): void { drain(); },
  };
}

// ---- HTTP 服务 ----

function json(res: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---- SSE 流式端点 ----
// 事件协议（`event: <type>\ndata: <json>\n\n`）：
//   open    请求回显 + 排队状态（queued=true 表示前一轮仍在跑）
//   start   串行队列轮到本轮（流水线真正开跑；同时复位 abort 标记）
//   stage   等待期流水线阶段轮换（2.6s 一帧，direct.hsl 真实阶段）
//   log     子进程 stdout 逐行实时（banner/配置行/回答正文/收尾行）
//   delta   v0.4.15 流式增量（llm-stream.jsonl 尾随；channel=reasoning|
//           content|reset，GUI 逐 token 渲染正文 + 思考指示器）
//   done    AskOutcome 整体（answer/tokens/ctxLine/durationMs/turn/logs）
//   error   引擎失败（人话 message；aborted=true 表示用户停止，本轮未落账本）
// 客户端意外断开不中止运行：账本是事实源，轮次照常落盘（enqueue 静默失败）；
// 显式停止走 POST /api/abort（SIGKILL 子进程，干净丢弃该轮）。

// ---- 团队模式派单的 SSE（v0.5.0：Web 补齐旗舰面） ----
// 事件协议（与 sseAsk 同族，多一个 run 帧）：
//   open    请求回显 + 排队状态 + ticketId
//   start   串行队列轮到本轮（真正开跑；复位 abort 标记）
//   run     RunHandle 身份（runId / outDir，供「产物已就绪」跳转）
//   card    归一化引擎事件逐条（EngineEvent，含 kind；Web 侧用 lib/runCards.ts
//           的同一份解析契约渲染成与 TUI 同源的卡片叙事）
//   done    终态（ok / elapsed_ms / outDir / metrics / error）
//   error   引擎失败或用户停止（aborted=true → 本轮未落账本）
// 与 sseAsk 共用 AskGate：团队 run 与直连都写同一 workspace（团队 run 还会起
// 嵌套解释器做工厂闸门），必须单飞串行，否则 out-* 目录与注册表写互相踩。

function sseRun(ws: string, req: { task: string; model: string }): Response {
  const enc = new TextEncoder();
  let closed = false;
  const ticket = gate.issue();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // 客户端断开：运行继续（产物与注册表是事实源）
        }
      };
      send("open", { task: req.task, model: req.model, queued: gate.busy, ticketId: ticket.id });
      try {
        await askSerialized(async () => {
          send("start", { model: req.model, ticketId: ticket.id });
          abortRequested = false;
          ensureWorkspace(ws);
          const handle = startRun({ entry: "org", task: req.task, workspace: ws, model: req.model, approval: true });
          runningRun = handle;
          try {
            send("run", { runId: handle.runId, outDir: handle.outDir });
            for await (const ev of handle.events) {
              // 分类在服务端做（lib/runCards.ts 的同一份契约）——浏览器是内联
              // JS 无构建步骤，让它自己写正则就回到「两端各自演化」的老问题。
              send("card", { ev: ev as EngineEvent, fact: classifyRunEvent(ev as never) });
            }
            const res = await handle.wait();
            if (abortRequested) {
              send("error", { aborted: true, message: "已停止：本轮未落账本" });
            } else {
              send("done", {
                ok: res.ok, canceled: res.canceled, outDir: res.outDir,
                outDirName: path.basename(res.outDir),
                elapsed_ms: res.elapsed_ms, error: res.error ?? null,
                metrics: res.metrics ?? null,
                runJson: res.runJson ?? null,
                directTurns: res.directTurns ?? null,
                audioRendered: res.audioRendered ?? [],
                audioFailures: res.audioFailures ?? [],
              });
            }
          } finally {
            runningRun = null;
          }
        }, ticket);
      } catch (err) {
        if (err instanceof QueueCancelledError) {
          send("error", { aborted: true, queued: true, message: err.message });
        } else {
          send("error", { message: (err as Error).message });
        }
      } finally {
        abortRequested = false;
        gate.release(ticket);
        try {
          controller.close();
        } catch { /* 已关闭 */ }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

const SSE_STAGE_MS = 2600;

function sseAsk(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
): Response {
  const enc = new TextEncoder();
  let closed = false;
  // v0.4.14：发票入队 —— open 事件回显 ticketId，排队中可 POST /api/abort {id}
  // 预先取消本轮（轮到时拒绝执行，不占流水线、不落账本）
  const ticket = gate.issue();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // 客户端已断开：静默，运行继续（账本照写）
        }
      };
      send("open", { expert: req.expert, session: req.session, model: req.model, queued: gate.busy, ticketId: ticket.id });
      try {
        const outcome = await askSerialized(async () => {
          send("start", { model: req.model, ticketId: ticket.id });
          abortRequested = false; // 队列轮到本轮：复位停止标记
          let stageIdx = 0;
          const ticker = setInterval(() => {
            send("stage", { stage: ASK_STAGES[stageIdx % ASK_STAGES.length]!, n: stageIdx + 1 });
            stageIdx++;
          }, SSE_STAGE_MS);
          try {
            return await askStreamOnce(ws, req, (line) => send("log", { line }), (channel, delta) => {
              send("delta", { channel, delta });
            });
          } finally {
            clearInterval(ticker);
          }
        }, ticket);
        if (abortRequested && !outcome.ok) {
          send("error", { aborted: true, message: "已停止：本轮未落账本" });
        } else {
          send("done", outcome);
        }
      } catch (err) {
        if (err instanceof QueueCancelledError) {
          send("error", { aborted: true, queued: true, message: err.message });
        } else {
          send("error", { message: (err as Error).message });
        }
      } finally {
        abortRequested = false;
        gate.release(ticket);
        try {
          controller.close();
        } catch { /* 已关闭 */ }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** 起服务（可编程入口：测试用 port 0 随机高端口 + server.stop()）。 */
export function startWebServer(opts: { workspace: string; port: number; host?: string; model: string; taskRunner?: boolean }): Bun.Server {
  const ws = opts.workspace;
  // v0.5.2：内嵌任务执行器（org web 即守护进程 —— 与 org taskd 二选一，
  // runner lock 跨进程互斥；抢不到锁 = taskd 在跑，Web 只读任务状态）。
  let taskRunner: TaskRunner | null = null;
  if (opts.taskRunner) {
    taskRunner = new TaskRunner(ws);
    if (taskRunner.acquireLock()) {
      taskRunner.start();
      console.log(`◆ 任务执行器已内嵌（500ms 领取间隔 · 并发 ${process.env.ORG_TASK_CONCURRENCY ?? "1"}）`);
    } else {
      taskRunner = null; // taskd 持锁 —— 只读模式
      console.log("ℹ 已有 taskd 执行器在跑（Web 面板只读任务状态）");
    }
  }
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host ?? "127.0.0.1", // 默认只听回环；org web --host 0.0.0.0 / ORG_WEB_HOST 可远程（容器/云端浏览器 QA）
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      try {
        // ---- 页面 ----
        if (route === "GET /") {
          return new Response(renderIndexHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        // ---- 停止/取消（issue #12：运行轮 SIGKILL；v0.4.14：排队轮可预取消）----
        if (route === "POST /api/abort") {
          // 可选 body {id}：票据 id（SSE open 事件回显）。无 body / 无 id →
          // 传统语义（停止当前运行轮）。id 命中排队轮 → 预先取消（轮到时
          // 拒绝执行，SSE 发 error{aborted,queued}）；id 命中运行轮 → 落到
          // 传统 SIGKILL 路径；查无此票 → 人话告知。
          let abortId: number | null = null;
          try {
            const body = (await req.json()) as { id?: unknown };
            if (body && typeof body.id === "number" && Number.isInteger(body.id)) abortId = body.id;
          } catch { /* 空 body / 非 JSON：传统语义 */ }
          if (abortId !== null) {
            const res = gate.cancel(abortId);
            if (res === "cancelled") {
              return json({ ok: true, aborted: true, queued: true });
            }
            if (res === "unknown") {
              return json({
                ok: false, aborted: false,
                message: "该轮不在排队中（可能已开始或已结束）",
              });
            }
            // res === "running"：票据是当前运行轮 → 落到下方 SIGKILL 路径
          }
          if (runningRun) {
            // 团队 run：RunHandle.cancel() → SIGTERM 子进程（引擎侧语义：
            // 取消的 run 不落「成功」终态，产物里也不会出现当轮交付物）
            abortRequested = true;
            try {
              runningRun.cancel();
            } catch { /* 已结束 */ }
            return json({ ok: true, aborted: true, team: true });
          }
          if (runningProc) {
            abortRequested = true;
            try {
              runningProc.kill("SIGKILL");
            } catch { /* 进程已退出 */ }
            return json({ ok: true, aborted: true });
          }
          return json({
            ok: false, aborted: false,
            message: "当前没有运行中的直连（进程内车道或空闲）",
          });
        }
        // ---- 交互式审批队列（v0.5.0）：文件协议（runtime/approvals/）的 Web 面 ----
        // 请求由 HSL 侧 hsl/policy/approval.hsl 落盘；这里只读列表 + 写回复。
        // 契约与 CLI org approvals 完全一致（三端同权，无旁路）。
        if (route === "GET /api/approvals") {
          // 用 ws 而非 readWorkspaceOf：审批请求由**本工作区**里运行中的 run 落盘；
          // 读侧回退到 dist/demo 快照只会永远列空（实测踩到）。
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: true, workspace: ws, pending: [], granted: [], resolved: [] });
          }
          const view = listApprovals(ws);
          return json({ ok: true, workspace: ws, ...view });
        }
        if (route === "POST /api/approvals") {
          const body = await req.json().catch(() => ({})) as { id?: unknown; allow?: unknown; always?: unknown };
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          const r = decideApproval(ws, String(body.id ?? ""), body.allow === true, body.always === true, "web");
          if (!r.ok) return json({ ok: false, error: r.error }, r.status);
          return json({ ok: true, id: String(body.id ?? ""), allow: body.allow === true, always: body.always === true });
        }
        // ---- 任务中心 + 通知中心（v0.5.2：org task / org notify 的 Web 面）----
        if (route === "GET /api/tasks") {
          const status = url.searchParams.get("status");
          const tasks = listTasks(ws, status ? { status: status as TaskStatus } : undefined);
          const unread = unreadCount(ws);
          return json({ ok: true, tasks, unread, runner: taskRunner ? "web" : "external/none" });
        }
        if (route === "POST /api/task/submit") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const kind = body.kind === "ask" ? "ask" : "run";
          const spec = {
            task: kind === "run" ? String(body.task ?? "").trim() : undefined,
            expert: kind === "ask" ? String(body.expert ?? "").trim() : undefined,
            question: kind === "ask" ? String(body.question ?? "").trim() : undefined,
            session: kind === "ask" ? (String(body.session ?? "").trim() || "task") : undefined,
            model: String(body.model ?? opts.model ?? "scripted"),
            approval: kind === "run",
          };
          const priority = Math.max(0, Math.min(10, Number(body.priority ?? 5) || 5));
          try {
            const t = submitTask(ws, kind, spec, { priority });
            return json({ ok: true, task: t });
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        {
          // POST /api/task/<id>（cancel/pause/resume/retry）与 GET /api/task/<id>
          const m = url.pathname.match(/^\/api\/task\/(t-[a-z0-9-]+)$/);
          if (m && (req.method === "POST" || req.method === "GET")) {
            const id = m[1]!;
            if (req.method === "GET") {
              const t = getTask(ws, id);
              if (!t) return json({ ok: false, error: "任务不存在" }, 404);
              return json({ ok: true, task: t, journal: readTaskJournal(ws, id).slice(-20) });
            }
            if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
              return json({ error: "dist/demo 是入库快照（只读）。" }, 400);
            }
            const body = await req.json().catch(() => ({})) as { action?: unknown };
            const action = String(body.action ?? "");
            const fn = action === "cancel" ? cancelTask
              : action === "pause" ? pauseTask
              : action === "resume" ? resumeTask
              : action === "retry" ? retryTask : null;
            if (!fn) return json({ ok: false, error: "未知 action（cancel/pause/resume/retry）" }, 400);
            const r = fn(ws, id);
            if (!r.ok) return json({ ok: false, error: r.error }, 400);
            return json({ ok: true, status: r.status, task: getTask(ws, id) });
          }
        }
        if (route === "GET /api/notifications") {
          const all = url.searchParams.get("all") === "1";
          return json({
            ok: true,
            notifications: readNotifications(ws, { unreadOnly: !all }),
            unread: unreadCount(ws),
          });
        }
        if (route === "POST /api/notifications") {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const action = String(body.action ?? "");
          if (action === "read") {
            const n = markRead(ws, String(body.id ?? "all"));
            return json({ ok: true, marked: n });
          }
          if (action === "read-all") {
            const n = markRead(ws, "all");
            return json({ ok: true, marked: n });
          }
          if (action === "clear") {
            clearNotifications(ws);
            return json({ ok: true });
          }
          return json({ ok: false, error: "未知 action（read/read-all/clear）" }, 400);
        }
        // ---- 定时任务（v0.5.5：org schedule 的 Web 面）----
        if (route === "GET /api/schedules") {
          return json({ ok: true, schedules: listSchedules(ws) });
        }
        if (route === "GET /api/schedules/preview") {
          const expr = url.searchParams.get("expr") ?? "";
          if (expr.trim().length === 0) return json({ ok: false, error: "expr 必填" }, 400);
          return json({ ok: true, next: previewNext(expr, new Date(), 3).map((d) => d.toISOString()) });
        }
        if (route === "POST /api/schedules") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const action = String(body.action ?? "");
          try {
            if (action === "add") {
              const expr = String(body.expr ?? "").trim();
              const kind = body.kind === "ask" ? "ask" : "run";
              const spec = kind === "run"
                ? { task: String(body.task ?? "").trim(), model: String(body.model ?? opts.model ?? "scripted") }
                : { expert: String(body.expert ?? "").trim(), question: String(body.question ?? "").trim(), model: String(body.model ?? opts.model ?? "scripted") };
              const s = addSchedule(ws, expr, kind, spec, {
                misfire: body.misfire === "run" ? "run" : "skip",
                notify: body.notify !== false,
              });
              if (s.invalid) {
                removeSchedule(ws, s.id);
                return json({ ok: false, error: "表达式不可解析（五段 cron 或 @every 30m）" }, 400);
              }
              return json({ ok: true, schedule: s });
            }
            if (action === "rm") {
              removeSchedule(ws, String(body.id ?? ""));
              return json({ ok: true });
            }
            if (action === "toggle") {
              const s = setScheduleEnabled(ws, String(body.id ?? ""), body.enabled === true);
              if (!s) return json({ ok: false, error: "条目不存在" }, 404);
              return json({ ok: true, schedule: s });
            }
            return json({ ok: false, error: "未知 action（add/rm/toggle）" }, 400);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        // ---- 长期记忆（v0.5.3：org memory 的 Web 面）----
        if (route === "GET /api/memory") {
          return json({ ok: true, groups: allMemories(ws) });
        }
        // ---- 语义检索（v0.5.8：org search 的 Web 面 · capabilities #19/#22）----
        if (route === "GET /api/search") {
          const q = String(url.searchParams.get("q") ?? "").trim();
          const k = Math.max(1, Math.min(20, Math.floor(Number(url.searchParams.get("k") ?? "5") || 5)));
          if (!q) return json({ ok: false, error: "q 必填" }, 400);
          try {
            return json(semanticSearch(ws, q, k));
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 500);
          }
        }
        if (route === "POST /api/memory") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const expert = String(body.expert ?? "").trim();
          const action = String(body.action ?? "");
          try {
            if (action === "add") {
              const n = addMemory(ws, expert, String(body.text ?? ""));
              return json({ ok: true, count: n });
            }
            if (action === "rm") {
              const n = removeMemory(ws, expert, Number(body.line ?? 0));
              return json({ ok: true, count: n });
            }
            return json({ ok: false, error: "未知 action（add/rm）" }, 400);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        // ---- 模型车道/服务商面板（v0.5.1：org providers 的 Web 面）----
        if (route === "GET /api/providers") {
          const cfg = loadConfig();
          const env = discoverEnvLanes().map((d) => ({ provider: d.provider, envName: d.envName }));
          return json({
            ok: true,
            presets: PROVIDER_NAMES,
            rows: providerRows(cfg),
            env,
            default_lane: cfg.default_lane,
            lanes: Object.fromEntries(Object.entries(cfg.lanes).map(([n, l]) => [
              n,
              {
                model: l.model, gateway: l.gateway,
                keys: (l.api_key ? 1 : 0) + l.api_keys.length,
                fallbacks: l.fallbacks, provider: l.provider,
              },
            ])),
            ledger: readLedger(readWorkspaceOf(ws)),
            // v0.5.5：预算水位 + key 池健康（三端渲染之 Web 端）
            budget: budgetWatermark(readWorkspaceOf(ws)),
            pool: poolView(readWorkspaceOf(ws)),
          });
        }
        if (route === "POST /api/config") {
          // 配置写入面板（与 CLI org config 同一实现，绝不双轨）
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const action = String(body.action ?? "");
          try {
            switch (action) {
              case "preset": {
                const name = applyPreset(String(body.name ?? ""));
                if (!name) return json({ ok: false, error: "未知预设" }, 400);
                return json({ ok: true, applied: name });
              }
              case "set": {
                const key = setConfigValue(String(body.key ?? ""), String(body.value ?? ""));
                if (!key) return json({ ok: false, error: "未知配置项" }, 400);
                return json({ ok: true, key });
              }
              case "unset": {
                const key = unsetConfigValue(String(body.key ?? ""));
                if (!key) return json({ ok: false, error: "未知配置项" }, 400);
                return json({ ok: true, key });
              }
              case "use": {
                const name = useLane(String(body.name ?? ""));
                if (!name) return json({ ok: false, error: "车道不存在" }, 404);
                return json({ ok: true, lane: name });
              }
              case "lane-set": {
                const name = setLaneValue(String(body.name ?? ""), String(body.field ?? ""), String(body.value ?? ""));
                if (!name) return json({ ok: false, error: "车道名/字段非法" }, 400);
                return json({ ok: true, lane: name });
              }
              case "lane-rm": {
                const name = removeLane(String(body.name ?? ""));
                if (!name) return json({ ok: false, error: "车道不存在" }, 404);
                return json({ ok: true, removed: name });
              }
              case "keys-add": {
                const n = addApiKey(String(body.key ?? ""));
                return json({ ok: true, keys: n });
              }
              case "keys-clear": {
                setConfigValue("api_keys", "");
                return json({ ok: true });
              }
              case "auto": {
                const created = autoFromEnv();
                return json({ ok: true, created });
              }
              default:
                return json({ ok: false, error: "未知 action" }, 400);
            }
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 500);
          }
        }
        if (route === "POST /api/providers/test") {
          const body = await req.json().catch(() => ({})) as { lane?: unknown };
          const lane = body.lane ? resolveModelFlag(String(body.lane)) : resolveModelFlag("");
          const r = await testLane(lane);
          return json({ ok: r.ok, result: r });
        }
        if (route === "GET /api/cost") {
          const rws = readWorkspaceOf(ws);
          const name = url.searchParams.get("dir") ?? "";
          let dir: string | null = null;
          if (name) {
            if (!SAFE_NAME.test(name)) return json({ error: "run 目录名不合法" }, 400);
            dir = path.join(rws, name);
          } else {
            dir = latestScorecardDir(rws) ?? latestHarnessRunDir(rws);
          }
          if (!dir || !fs.existsSync(dir)) return json({ ok: false, error: "没有可读的运行产物（先派单）" }, 404);
          return json({ ok: true, dir: path.basename(dir), timeline: readCostTimeline(dir) });
        }
        // ---- 团队模式派单（v0.5.0：Web 不再只有直连）----
        // 与 CLI org run / TUI 团队输入同一代码路径（lib/engine.ts startRun
        // entry:"org"）。dist/demo 是入库快照（只读）—— 与 keep/drop 同守卫。
        if (route === "POST /api/run-stream") {
          const body = await req.json().catch(() => ({})) as { task?: unknown; model?: unknown };
          const task = String(body.task ?? "").trim();
          if (task.length === 0) return json({ error: "task 必填" }, 400);
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          const model = typeof body.model === "string" && body.model.length > 0 ? body.model : opts.model;
          return sseRun(ws, { task, model });
        }
        // ---- 运行产物：列表 / 回放 / 评分卡（TUI :replay 与 org score 的 Web 面）----
        if (route === "GET /api/runs") {
          const info = scanWorkspace(readWorkspaceOf(ws));
          return json({
            workspace: readWorkspaceOf(ws),
            runs: info.sessions,
            memoKeys: info.memoKeys,
            hitLedger: info.hitLedger,
            minedTracks: info.minedTracks,
            scorecardDir: info.scorecardDir,
          });
        }
        if (route === "GET /api/audio") {
          // v0.5.6：音频产物直通（开袋即食的 Web 面 —— <audio> 播放/下载）。
          // v0.5.9：允许 .mid（MIDI 下载）；dir 同 /api/run 的 run 目录名；
          // file 限 [A-Za-z0-9_.-]+ 且必为 .wav/.mid。
          const name = url.searchParams.get("dir") ?? "";
          const file = url.searchParams.get("file") ?? "";
          if (!SAFE_NAME.test(name)) return json({ error: "run 目录名不合法" }, 400);
          if (!/^[A-Za-z0-9_.-]+\.(wav|mid)$/.test(file) || file.includes("..")) {
            return json({ error: "音频文件名不合法" }, 400);
          }
          const p = path.join(readWorkspaceOf(ws), name, file);
          if (!fs.existsSync(p)) return json({ error: `找不到音频产物：${name}/${file}` }, 404);
          return new Response(Bun.file(p), {
            headers: {
              "Content-Type": file.endsWith(".mid") ? "audio/midi" : "audio/wav",
              "Cache-Control": "no-store",
              "Content-Disposition": 'inline; filename="' + file + '"',
            },
          });
        }
        if (route === "GET /api/audio-demo") {
          // v0.5.9：音色试听（音频工坊的样本车道）：timbre × chords → 服务端
          // 合成 2 和弦短样本（约 4s）；内存缓存（同参只渲染一次）。
          // 参数宽容：未注册 timbre → strings；未注册 chords → canon。
          const timbre = url.searchParams.get("timbre") ?? "strings";
          const chords = url.searchParams.get("chords") ?? "canon";
          const arp = url.searchParams.get("style") === "arp";
          if (!/^[a-z0-9-]{1,24}$/.test(timbre) || !/^[a-z0-9-]{1,24}$/.test(chords)) {
            return json({ error: "参数不合法" }, 400);
          }
          const cacheKey = `${timbre}|${chords}|${arp ? "arp" : "block"}`;
          const hit = audioDemoCache.get(cacheKey);
          if (hit) {
            return new Response(new Uint8Array(hit), {
              headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
            });
          }
          const { progressionToNotes, TIMBRES, renderNotesToWav } = await import("../lib/audio.ts");
          const tim = TIMBRES[timbre] ?? TIMBRES["strings"]!;
          const prog = progressionToNotes("C4", chords, {
            style: arp ? "arp" : "block",
            beatsPerChord: 4,
            gain: 0.7,
          });
          // 2 和弦样本（约 8 拍 @ 96bpm ≈ 5s）：覆盖进行前两级，音色/风格差异可听
          const sampleNotes = prog.notes.filter((n) => n.start_beat < 8);
          const outcome = renderNotesToWav({
            title: `${tim.label} · ${chords}${arp ? " 琶音" : ""}`,
            tempo: 96,
            sample_rate: 44100,
            timbre: TIMBRES[timbre] ? timbre : "strings",
            notes: sampleNotes,
          });
          if (!outcome.ok || !outcome.wav) {
            return json({ error: outcome.error ?? "样本合成失败" }, 500);
          }
          if (audioDemoCache.size > 64) audioDemoCache.clear(); // 粗上限防膨胀
          audioDemoCache.set(cacheKey, outcome.wav);
          return new Response(new Uint8Array(outcome.wav), {
            headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
          });
        }
            // v0.5.15 工具箱：数据库 / 符号 / 密钥扫描 / 治理件（与 CLI、工具环同源 lib）
        if (route === "GET /api/toolbox/db") {
          // 表结构（只读）：?file=data/app.db
          const file = String(url.searchParams.get("file") ?? "").trim();
          if (!file) return json({ ok: false, error: "file 参数必填" }, 400);
          const target = path.resolve(readWorkspaceOf(ws), file);
          if (!target.startsWith(path.resolve(readWorkspaceOf(ws)) + path.sep)) return json({ ok: false, error: "路径越界（须在工作区内）" }, 400);
          const schema = dbSchema(target);
          if (schema.missing) return json({ ok: false, error: "库文件不存在或不可读" }, 404);
          return json({ ok: true, tables: schema.tables, indexes: schema.indexes, views: schema.views });
        }
        if (route === "POST /api/toolbox/db-query") {
          const body = (await req.json().catch(() => ({}))) as { file?: string; sql?: string; limit?: number };
          const file = String(body.file ?? "").trim();
          const sql = String(body.sql ?? "").trim();
          if (!file || !sql) return json({ ok: false, error: "file/sql 必填" }, 400);
          const wsAbs = path.resolve(readWorkspaceOf(ws));
          const target = path.resolve(wsAbs, file);
          if (!target.startsWith(wsAbs + path.sep)) return json({ ok: false, error: "路径越界（须在工作区内）" }, 400);
          const limit = Math.max(1, Math.min(200, Math.floor(Number(body.limit) || 50)));
          const r = dbQuery(target, sql, { limit });
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error }, 400);
          return json({ ok: true, columns: r.result.columns, rows: r.result.rows, row_count: r.result.rowCount, truncated: r.result.truncated, ms: r.result.ms });
        }
        if (route === "GET /api/toolbox/symbols") {
          const name = String(url.searchParams.get("name") ?? "").trim();
          if (!name) return json({ ok: false, error: "name 参数必填" }, 400);
          const rws = readWorkspaceOf(ws);
          const idx = indexSymbols(rws, [""]);
          const defs = lookupDef(idx.symbols, name, true);
          const refs = findRefs(rws, name, { dirs: [""], maxHits: 50 });
          return json({ ok: true, files: idx.files, symbols: idx.symbols.length, defs: defs.slice(0, 20), refs });
        }
        if (route === "GET /api/toolbox/scan") {
          const report = scanSecrets(readWorkspaceOf(ws));
          return json({ ok: true, ...report, patterns: SECRET_PATTERNS.length, hits: report.hits.slice(0, 200) });
        }
        if (route === "POST /api/toolbox/audit") {
          const r = exportAudit(readWorkspaceOf(ws));
          if (!r.ok) return json({ ok: false, error: (r.warnings || []).join("; ") }, 500);
          const sum = auditSummary(readWorkspaceOf(ws));
          return json({ ok: true, zip: path.basename(r.zip), entries: r.entries, bytes: r.bytes, summary: sum });
        }
        if (route === "GET /api/toolbox/sbom") {
          const r = buildSbom(ROOT);
          if (!r.ok) return json({ ok: false, error: r.error }, 500);
          return json({ ok: true, packages: r.doc.packages, spdx: JSON.parse(renderSpdxJson(r.doc)) });
        }
        if (route === "POST /api/toolbox/review") {
          const body = (await req.json().catch(() => ({}))) as { files?: string[] };
          const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean).slice(0, 100) : [];
          if (files.length === 0) return json({ ok: false, error: "files 必填" }, 400);
          const r = recommendReviewers(readWorkspaceOf(ws), files);
          return json({ ok: true, ...r, codeowners: loadCodeowners(readWorkspaceOf(ws)).file });
        }
        // v0.5.16 治理与扩展面板（🛡 govex）：IaC 扫描 / 插件 / RBAC / OpenAPI /
        // 浏览器 / dbdiag / 补全 / 重命名 / git —— 与 CLI、工具环同源 lib。
        if (route === "GET /api/govex/iacscan") {
          const r = scanIac(readWorkspaceOf(ws));
          return json({
            ok: true, files: r.files, scanned: r.scanned, took_ms: r.tookMs, rules: IAC_RULES.length,
            truncated: r.truncated, high: r.hits.filter((h) => h.severity === "high").length,
            hits: r.hits.slice(0, 200),
          });
        }
        if (route === "GET /api/govex/plugins") {
          const r = pluginList(readWorkspaceOf(ws));
          return json({ ok: true, plugins: r.plugins.map((p) => ({ ...p, path: path.basename(p.path) })), dir: ".org/plugins" });
        }
        if (route === "POST /api/govex/plugin-install") {
          // 写动作：用真实工作区（非 dist/demo 快照回退）+ 只读守卫（与 /api/memory 同规）
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as { source?: unknown };
          const source = String(body.source ?? "").trim();
          if (!source) return json({ ok: false, error: "source 必填（本地目录或 git URL）" }, 400);
          const r = pluginInstall(path.resolve(ws), source);
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error }, 400);
          return json({ ok: true, name: r.name, version: r.version, warnings: r.warnings });
        }
        if (route === "POST /api/govex/plugin-remove") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as { name?: unknown };
          const name = String(body.name ?? "").trim();
          if (!name) return json({ ok: false, error: "name 必填" }, 400);
          const r = pluginRemove(path.resolve(ws), name);
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error }, 400);
          return json({ ok: true, name: r.name });
        }
        if (route === "GET /api/govex/rbac") {
          const rws = readWorkspaceOf(ws);
          const { policy, file, fallbackReason } = loadRbac(rws);
          return json({
            ok: true, policy_file: file, ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
            roles: rbacRoles(policy).map((role) => ({ role, ...rbacActions(policy, role) })),
          });
        }
        if (route === "POST /api/govex/openapi") {
          // body {text}（粘贴的 spec JSON）或 {file}（工作区相对路径）—— 二选一
          const body = (await req.json().catch(() => ({}))) as { text?: unknown; file?: unknown };
          const text = typeof body.text === "string" ? body.text : "";
          const file = String(body.file ?? "").trim();
          if (!text && !file) return json({ ok: false, error: "text / file 必填其一" }, 400);
          let r;
          if (text) {
            r = parseOpenApiText(text);
          } else {
            const wsAbs = path.resolve(readWorkspaceOf(ws));
            const target = path.resolve(wsAbs, file);
            if (!target.startsWith(wsAbs + path.sep)) return json({ ok: false, error: "路径越界（须在工作区内）" }, 400);
            r = parseOpenApiFile(target);
          }
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error }, 400);
          return json({
            ok: true, version: r.version, info: r.info, servers: r.servers, schemas: r.schemas,
            operations: r.operations.map((op) => ({ ...op, tool_name: suggestToolName(op) })),
          });
        }
        if (route === "GET /api/govex/engines") {
          const e = browserEngines();
          return json({ ok: true, agent_browser: e.agentBrowser, chromium: e.chromium, chrome: e.chrome, ...(e.hint ? { hint: e.hint } : {}) });
        }
        if (route === "POST /api/govex/browser-snapshot") {
          const body = (await req.json().catch(() => ({}))) as { url?: unknown };
          const url = String(body.url ?? "").trim();
          if (!url) return json({ ok: false, error: "url 必填（http/https）" }, 400);
          // 超时预算收敛到引擎侧既有约束（与工具环同口径：1-60s 钳制，缺省 30s）
          const r = await browserSnapshot(url, { timeoutMs: 30_000 });
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error, ...(r.hint ? { hint: r.hint } : {}) }, 200);
          return json({
            ok: true, engine: r.engine, url: r.url, ...(r.finalUrl ? { final_url: r.finalUrl } : {}),
            ...(r.title ? { title: r.title } : {}), text: r.text.slice(0, 16384), ms: r.ms,
            links: (r.links ?? []).slice(0, 50), imgs: (r.imgs ?? []).slice(0, 20),
          });
        }
        if (route === "POST /api/govex/browser-screenshot") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as { url?: unknown };
          const url = String(body.url ?? "").trim();
          if (!url) return json({ ok: false, error: "url 必填（http/https）" }, 400);
          const out = path.join(path.resolve(ws), `browser-${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.png`);
          const r = await browserScreenshot(url, { out, timeoutMs: 30_000 });
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error, ...(r.hint ? { hint: r.hint } : {}) }, 200);
          return json({ ok: true, engine: r.engine, path: path.basename(r.path), ms: r.ms });
        }
        if (route === "POST /api/govex/dbdiag") {
          const body = (await req.json().catch(() => ({}))) as { file?: unknown; sql?: unknown; setup?: unknown };
          const file = String(body.file ?? "").trim();
          const sql = String(body.sql ?? "").trim();
          if (!file || !sql) return json({ ok: false, error: "file / sql 必填" }, 400);
          if (file !== ":memory:") {
            const wsAbs = path.resolve(readWorkspaceOf(ws));
            const target = path.resolve(wsAbs, file);
            if (!target.startsWith(wsAbs + path.sep)) return json({ ok: false, error: "路径越界（须在工作区内）" }, 400);
          }
          const setup = typeof body.setup === "string" && body.setup.trim().length > 0 ? body.setup : undefined;
          const r = await dbDiagnose(file === ":memory:" ? ":memory:" : path.resolve(readWorkspaceOf(ws), file), sql, setup ? { setup } : {});
          if (!r.ok) return json({ ok: false, kind: r.kind, error: r.error }, 400);
          return json({ ok: true, ms: r.ms, plan: r.plan, suggestions: r.suggestions });
        }
        if (route === "POST /api/govex/complete") {
          const body = (await req.json().catch(() => ({}))) as { file?: unknown; line?: unknown; column?: unknown };
          const file = String(body.file ?? "").trim();
          const line = Math.max(1, Math.floor(Number(body.line) || 1));
          const column = Math.max(1, Math.floor(Number(body.column) || 1));
          if (!file) return json({ ok: false, error: "file 必填" }, 400);
          const rws = readWorkspaceOf(ws);
          const wsAbs = path.resolve(rws);
          const target = path.resolve(wsAbs, file);
          if (!target.startsWith(wsAbs + path.sep)) return json({ ok: false, error: "路径越界（须在工作区内）" }, 400);
          let lineText = "";
          try {
            lineText = fs.readFileSync(target, "utf8").split("\n")[line - 1] ?? "";
          } catch {
            return json({ ok: false, error: `文件不可读：${file}` }, 400);
          }
          const r = await completeAt(rws, file, lineText, column - 1, { dirs: [""] });
          return json({ ok: true, line_text: lineText, ...r });
        }
        if (route === "POST /api/govex/rename") {
          // body {old, new, apply?} —— 缺省 dryRun 预览（unified diff）；apply:true 真写。
          // 写面用真实工作区（非 dist/demo 快照回退）+ 只读守卫（与 /api/memory 同规）。
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as { old?: unknown; new?: unknown; apply?: unknown };
          const oldName = String(body.old ?? "").trim();
          const newName = String(body.new ?? "").trim();
          if (!oldName || !newName) return json({ ok: false, error: "old / new 必填" }, 400);
          const r = await applyRename(path.resolve(ws), oldName, newName, { dryRun: body.apply !== true, dirs: [""] });
          if (!r.ok) return json({ ok: false, reason: r.reason, warnings: r.plan.warnings }, 200);
          return json({
            ok: true, dry_run: r.dryRun,
            definition: { kind: r.plan.definition!.kind, file: r.plan.definition!.file, line: r.plan.definition!.line },
            edits: r.plan.edits.length, files: new Set(r.plan.edits.map((e) => e.file)).size, warnings: r.plan.warnings,
            ...(r.dryRun
              ? { previews: (r.previews ?? []).map((p) => ({ file: p.file, stats: p.stats, diff: p.diff.slice(0, 8192) })), files_total: r.filesTotal, preview_truncated: r.previewTruncated ?? false }
              : { applied: r.applied, failed: r.failed ?? null }),
          });
        }
        if (route === "GET /api/govex/gitstate") {
          const r = gitMergeState(readWorkspaceOf(ws));
          return json({ ok: !r.degraded, state: r, ...(r.degraded ? { error: r.degraded } : {}) });
        }
        if (route === "POST /api/govex/git-merge") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as { source?: unknown; message?: unknown; no_ff?: unknown };
          const source = String(body.source ?? "").trim();
          if (!source) return json({ ok: false, error: "source 必填" }, 400);
          const r = gitMerge(path.resolve(ws), { source, ...(body.message ? { message: String(body.message) } : {}), noFf: body.no_ff === true });
          return json({ ok: r.ok, output: r.output.slice(0, 4096), conflicts: r.conflicts, aborted: r.aborted, kind: r.kind ?? null, error: r.error ?? null });
        }
        if (route === "POST /api/govex/git-rebase") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as { onto?: unknown };
          const onto = String(body.onto ?? "").trim();
          if (!onto) return json({ ok: false, error: "onto 必填" }, 400);
          const r = gitRebase(path.resolve(ws), { onto });
          return json({ ok: r.ok, output: r.output.slice(0, 4096), conflicts: r.conflicts, aborted: r.aborted, kind: r.kind ?? null, error: r.error ?? null });
        }
        // v0.5.17 LSP/DAP 调试（#26/#108）：GET ?action=definition|references|hover&name=…
        // | servers | protocol-selftest。与 CLI org lsp / 工具环 lsp_* 同源 lib/lsp.ts
        // （内置符号索引车道；外部 server spawn 车道在 CLI/tests 侧）。只读面。
        if (route === "GET /api/govex/lsp") {
          const action = String(url.searchParams.get("action") ?? "").trim();
          const rws = readWorkspaceOf(ws);
          try {
            if (action === "definition" || action === "references" || action === "hover") {
              const name = String(url.searchParams.get("name") ?? "").trim();
              if (!name) return json({ ok: false, error: "name 必填（符号名）" }, 400);
              if (action === "definition") {
                const r = lspDefinition(rws, name, { dirs: [""] });
                return json({ ok: r.ok, lane: r.lane, name: r.name, ...(r.reason ? { reason: r.reason } : {}), definitions: r.definitions });
              }
              if (action === "references") {
                const maxHitsParam = url.searchParams.get("max_hits");
                const maxHits = maxHitsParam !== null ? Math.max(0, Math.floor(Number(maxHitsParam) || 0)) : 200;
                const r = lspReferences(rws, name, { dirs: [""], maxHits });
                return json({ ok: r.ok, lane: r.lane, name: r.name, definitions: r.definitions, ...(r.truncated ? { truncated: true } : {}), ...(r.reason ? { reason: r.reason } : {}), refs: r.refs });
              }
              const r = lspHover(rws, name, { dirs: [""] });
              return json({ ok: r.ok, lane: r.lane, name: r.name, hover: r.hover, ...(r.reason ? { reason: r.reason } : {}) });
            }
            if (action === "servers") {
              const servers = detectLspServers();
              return json({
                ok: true, servers,
                available: servers.filter((s) => s.available).length,
                ...(servers.every((s) => !s.available) ? { note: "全部缺席 —— 内置符号索引车道常在（definition/references/hover）" } : {}),
              });
            }
            if (action === "protocol-selftest" || action === "selftest" || action === "protocol") {
              const r = protocolSelfTest();
              return json({ ok: r.ok, passed: r.passed, total: r.total, checks: r.checks });
            }
            return json({ ok: false, error: "action 须为 definition / references / hover / servers / protocol-selftest" }, 400);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        // v0.5.17 断点/调试建议（#108）：GET ?action=suggest|plan&file=… | dap-selftest。
        // 与 CLI org debug / 工具环 debug_* 同源 lib/debug.ts。file 过 pathjail（越界即拒）。
        if (route === "GET /api/govex/debug") {
          const action = String(url.searchParams.get("action") ?? "").trim();
          const rws = readWorkspaceOf(ws);
          try {
            if (action === "suggest" || action === "plan") {
              const file = String(url.searchParams.get("file") ?? "").trim();
              if (!file) return json({ ok: false, error: "file 必填（工作区相对路径）" }, 400);
              const jailed = resolveJailedFile(rws, file);
              if (!jailed.ok) return json({ ok: false, error: jailed.reason }, 400);
              if (action === "suggest") {
                const r = suggestBreakpoints(rws, file);
                return json({
                  ok: r.ok, ...(r.reason ? { reason: r.reason } : {}),
                  file: r.file, language: r.language, lines: r.lines, ...(r.truncated ? { truncated: true } : {}),
                  suggestions: r.suggestions,
                });
              }
              const r = debugPlan(rws, file);
              return json({
                ok: r.ok, ...(r.reason ? { reason: r.reason } : {}),
                file: r.file, language: r.language, suggestions: r.suggestions,
                steps: r.steps, dap_messages: r.dapMessages,
                roadmap: "真 debug adapter attach（node --inspect / debugpy / lldb-dap）是路线图 —— 本计划交付协议就绪的消息序列与步骤说明",
              });
            }
            if (action === "dap-selftest" || action === "selftest" || action === "dap") {
              const r = dapSelfTest();
              return json({ ok: r.ok, passed: r.passed, total: r.total, checks: r.checks });
            }
            return json({ ok: false, error: "action 须为 suggest / plan / dap-selftest" }, 400);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        // v0.5.17 👥 团队协作（#87）：线程/增量读/协作者/摘要/身份 + 发帖/评论/切身份/桥。
        // GET  ?action=threads|feed&thread=…&since=N|users|summary|whoami（缺省 summary）
        // POST {action:"post"|"comment"|"user"|"bridge", thread, seq, text, user, display, expert, session}
        // 与 CLI org collab / 工具环 collab_* 同源 lib/collab.ts。协作是写面：
        // 不走 readWorkspaceOf 的 dist/demo 快照回退（与 sessions 哲学同 —— 不设注册表门槛），
        // 写动作带 dist/demo 只读守卫（与 plugin-install 同规）。
        if (route === "GET /api/govex/collab") {
          const action = String(url.searchParams.get("action") ?? "summary").trim();
          const rws = path.resolve(ws);
          try {
            if (action === "threads") {
              return json({ ok: true, threads: listThreads(rws), summary: collabSummary(rws) });
            }
            if (action === "feed") {
              const thread = String(url.searchParams.get("thread") ?? "").trim();
              if (!thread) return json({ ok: false, error: "thread 必填（线程 id）" }, 400);
              const sinceParam = url.searchParams.get("since");
              const sinceSeq = sinceParam !== null ? Math.max(0, Math.floor(Number(sinceParam) || 0)) : 0;
              const feed = threadFeed(rws, thread, { sinceSeq });
              return json({
                ok: true, thread, since_seq: sinceSeq, truncated: feed.truncated,
                posts: flattenThread(feed.posts).map((p) => ({
                  seq: p.seq, user: p.user, kind: p.kind, depth: p.depth, at: p.at,
                  ...(p.replyTo !== undefined ? { reply_to: p.replyTo } : {}),
                  ...(p.mentions && p.mentions.length ? { mentions: p.mentions } : {}),
                  text: p.text.slice(0, 2000),
                })),
              });
            }
            if (action === "users") {
              return json({ ok: true, collaborators: collaborators(rws) });
            }
            if (action === "whoami") {
              return json({ ok: true, ...currentUser(rws), dir: COLLAB_DIR_REL });
            }
            // 缺省：summary（总览 + 协作者 + 我是谁）
            const s = collabSummary(rws);
            return json({
              ok: true, ...s,
              collaborators: collaborators(rws).slice(0, 50),
              me: currentUser(rws),
            });
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        if (route === "POST /api/govex/collab") {
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const action = String(body.action ?? "").trim();
          const rws = path.resolve(ws);
          try {
            if (action === "post") {
              const thread = String(body.thread ?? "").trim();
              const text = String(body.text ?? "").trim();
              if (!thread || !text) return json({ ok: false, error: "thread / text 必填" }, 400);
              const user = String(body.user ?? "").trim() || currentUser(rws).user;
              const r = postThread(rws, thread, user, text);
              return json({ ok: true, thread, seq: r.seq, user, mentions: r.mentions });
            }
            if (action === "comment") {
              const thread = String(body.thread ?? "").trim();
              const seq = Math.floor(Number(body.seq));
              const text = String(body.text ?? "").trim();
              if (!thread || !text || !Number.isInteger(seq)) return json({ ok: false, error: "thread / seq / text 必填" }, 400);
              const user = String(body.user ?? "").trim() || currentUser(rws).user;
              const r = commentOn(rws, thread, seq, user, text);
              return json({ ok: true, thread, seq: r.seq, reply_to: seq, user, mentions: r.mentions });
            }
            if (action === "user") {
              const userId = String(body.user ?? "").trim();
              if (!userId) return json({ ok: false, error: "user 必填（如 alice —— 小写字母/数字/连字符）" }, 400);
              const display = typeof body.display === "string" ? body.display.trim() : undefined;
              const id = setUser(rws, userId, display && display.length > 0 ? display : undefined);
              return json({ ok: true, ...id });
            }
            if (action === "bridge") {
              const expert = String(body.expert ?? "").trim().toLowerCase();
              if (!expert) return json({ ok: false, error: "expert 必填（如 notice-parser）" }, 400);
              const session = String(body.session ?? "").trim() || latestSession(rws, expert);
              const derived = `session-${expert}-${session}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, (m) => (m ? "-" : "")).slice(0, 64);
              const thread = String(body.thread ?? "").trim() || (derived.length > 0 ? derived : "session");
              const r = bridgeSession(rws, expert, session, thread, { user: currentUser(rws).user });
              return json({ ok: true, expert, session, ...r });
            }
            return json({ ok: false, error: `未知 action：${action || "（空）"}（post/comment/user/bridge）` }, 400);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        // v0.5.17 ☁ 云生态面板（#67/#68/#72/#74）：GET 探测/模板车道（只读），
        // POST 执行车道（docker/ssh/k8s —— body 过 lib 白名单门）。
        // 与 CLI org cloud / 工具环 cloud_* 同源 lib/cloud.ts（单一实现防口径漂移）。
        if (route === "GET /api/govex/cloud") {
          const action = String(url.searchParams.get("action") ?? "probe").trim();
          if (action === "probe") {
            const r = cloudProbeAll();
            return json({
              ok: true, took_ms: r.tookMs, summary: r.summary,
              docker: r.docker, ssh: r.ssh, k8s: r.k8s, terraform: r.terraform,
              clis: r.clis,
              hint: "工具缺席环境：模板车道（dockerfile/compose/manifest/terraform/ssh-template）始终可用",
            });
          }
          if (action === "probe-docker") return json({ ok: true, ...probeDocker() });
          if (action === "probe-ssh") return json({ ok: true, ...probeSsh() });
          if (action === "probe-k8s") return json({ ok: true, ...probeK8s() });
          if (action === "probe-tf") return json({ ok: true, ...probeTerraform() });
          if (action === "clis") {
            const clis = probeCloudClis();
            return json({ ok: true, available: clis.filter((c) => c.available).length, total: clis.length, clis });
          }
          if (action === "overview") return json({ ok: true, ...cloudProvidersOverview() });
          if (action === "dockerfile") {
            const project = String(url.searchParams.get("project") ?? "node");
            try {
              const r = dockerfileFor(project);
              return json({ ok: true, project_type: r.projectType, dockerfile: r.dockerfile, notes: r.notes });
            } catch (e) {
              return json({ ok: false, error: (e as Error).message }, 400);
            }
          }
          if (action === "compose") {
            const r = composeFor({ appName: String(url.searchParams.get("app") ?? "app") || "app" });
            return json({ ok: true, compose: r.compose, notes: r.notes });
          }
          if (action === "manifest") {
            const kind = String(url.searchParams.get("kind") ?? "deployment");
            try {
              const m = k8sManifestFor(kind);
              return json({ ok: true, kind: m.kind, api_version: m.apiVersion, manifest: m.manifest, notes: m.notes });
            } catch (e) {
              return json({ ok: false, error: (e as Error).message }, 400);
            }
          }
          if (action === "terraform") return json({ ok: true, ...terraformPlan(String(url.searchParams.get("provider") ?? "aws")) });
          if (action === "ssh-template") {
            const t = sshConfigTemplate();
            return json({ ok: true, config: t.config, advice: t.advice });
          }
          if (action === "plan") {
            const act = String(url.searchParams.get("intent") ?? "build");
            try {
              return json({ ok: true, ...dockerPlan(act) });
            } catch (e) {
              return json({ ok: false, error: (e as Error).message }, 400);
            }
          }
          return json({ ok: false, error: `未知 action：${action}（probe/probe-docker/probe-ssh/probe-k8s/probe-tf/clis/overview/dockerfile/compose/manifest/terraform/ssh-template/plan）` }, 400);
        }
        if (route === "POST /api/govex/cloud") {
          // 执行车道：docker/ssh/k8s 三动作。写面用真实工作区（非 dist/demo
          // 快照回退）+ 只读守卫（与 /api/memory、govex 写端点同规）；
          // 白名单/host 门控/监狱在 lib/cloud.ts 内部（拒绝先于 spawn）。
          if (path.resolve(ws) === path.join(ROOT, "dist", "demo")) {
            return json({ ok: false, error: "dist/demo 是入库快照（只读）。" }, 400);
          }
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const action = String(body.action ?? "").trim();
          const rws = path.resolve(ws);
          const renderRun = (r: import("../lib/cloud.ts").CloudRunResult) => json({
            ok: r.ok, ...(r.kind ? { kind: r.kind } : {}), ...(r.reason ? { reason: r.reason } : {}),
            argv: r.argv, exit_code: r.exitCode,
            stdout: r.stdout.slice(0, 16384), stderr: r.stderr.slice(0, 4096), took_ms: r.tookMs,
          });
          if (action === "docker") {
            const args = Array.isArray(body.args) ? (body.args as unknown[]).map(String) : [];
            if (args.length === 0) return json({ ok: false, error: "args 必填（数组，首元素为 docker 子命令；白名单 16 子命令）" }, 400);
            if (args[0] === "build") {
              return renderRun(dockerBuild(rws, String(body.context ?? "."), {
                ...(body.dockerfile ? { dockerfile: String(body.dockerfile) } : {}),
                ...(body.tag ? { tag: String(body.tag) } : {}),
              }));
            }
            return renderRun(dockerRun(args[0]!, args.slice(1)));
          }
          if (action === "ssh") {
            const host = String(body.host ?? "").trim();
            if (!host) return json({ ok: false, error: "host 必填（且须在 <工作区>/ssh-hosts.allow 白名单内）" }, 400);
            if (body.upload_local != null || body.upload_remote != null) {
              const local = String(body.upload_local ?? "");
              const remote = String(body.upload_remote ?? "");
              if (!local || !remote) return json({ ok: false, error: "upload_local / upload_remote 必填（scp 车道，local 须在工作区内）" }, 400);
              return renderRun(scpUpload(rws, host, local, remote));
            }
            const command = String(body.command ?? "");
            if (!command) return json({ ok: false, error: "command 必填（或 upload_local/upload_remote 走 scp 车道）" }, 400);
            return renderRun(sshRun(rws, host, command));
          }
          if (action === "k8s") {
            const args = Array.isArray(body.args) ? (body.args as unknown[]).map(String) : [];
            if (args.length === 0) return json({ ok: false, error: "args 必填（数组，首元素为 kubectl 子命令；delete 等变更面永不在白名单）" }, 400);
            return renderRun(k8sRun(rws, args));
          }
          return json({ ok: false, error: `未知 action：${action || "（空）"}（docker/ssh/k8s）` }, 400);
        }
        // v0.5.18 📱 移动端调试（#117）：GET ?action=probe|devices|logcat|plan
        // [selftest]。只读四动作 + 自检。与 CLI org mobile / 工具环 mobile_* 同源
        // lib/mobile.ts（单一实现防口径漂移）。执行车道全只读 —— forward/apk 的
        // 深层探测在 CLI（Web 面保持只读四动作）。
        if (route === "GET /api/govex/mobile") {
          const action = String(url.searchParams.get("action") ?? "probe").trim();
          try {
            if (action === "probe") {
              const p = probeMobile();
              const face = (f: typeof p.adb) => ({ available: f.available, version: f.version, ...(f.reason ? { reason: f.reason } : {}) });
              return json({
                ok: true, took_ms: p.tookMs,
                adb: { ...face(p.adb), android_home: p.androidHome },
                aapt: face(p.aapt), aapt2: face(p.aapt2), scrcpy: face(p.scrcpy),
                ideviceinstaller: face(p.ideviceinstaller), idevice_id: face(p.ideviceId),
                flutter: face(p.flutter),
                android_home: p.androidHome, summary: p.summary,
                hint: "工具缺席不是失败 —— org mobile plan（纯函数保底）与 APK 魔数车道（org mobile apk）恒可用",
              });
            }
            if (action === "devices") {
              const r = mobileDevices();
              return json({
                ok: r.ok, ...(r.kind ? { kind: r.kind } : {}), ...(r.reason ? { reason: r.reason } : {}),
                argv: r.argv, devices: r.devices, ready: r.ready, ios: r.ios, took_ms: r.tookMs,
                hint: "unauthorized/offline 是设备清单的诚实状态而非失败（解锁屏幕点「允许」/重插）",
              });
            }
            if (action === "logcat") {
              const linesParam = url.searchParams.get("lines");
              const lines = linesParam !== null ? Math.max(1, Math.floor(Number(linesParam) || 0)) : undefined;
              const r = mobileLogcat({
                ...(lines ? { lines } : {}),
                ...(url.searchParams.get("tag") ? { tag: String(url.searchParams.get("tag")) } : {}),
                ...(url.searchParams.get("level") ? { level: String(url.searchParams.get("level")) } : {}),
                ...(url.searchParams.get("serial") ? { serial: String(url.searchParams.get("serial")) } : {}),
                ...(url.searchParams.get("package") ? { package: String(url.searchParams.get("package")) } : {}),
              });
              return json({
                ok: r.ok, ...(r.kind ? { kind: r.kind } : {}), ...(r.reason ? { reason: r.reason } : {}),
                argv: r.argv,
                entries: r.entries.slice(0, 200).map((e) => ({ time: e.time, pid: e.pid, tid: e.tid, level: e.level, tag: e.tag, message: e.message.slice(0, 200) })),
                count: r.entries.length, skipped: r.skipped, truncated: r.truncated, took_ms: r.tookMs,
                hint: "-d 是一次性 dump（流式尾随是路线图）；复现一次目标操作后再抓最完整",
              });
            }
            if (action === "plan") {
              const platform = String(url.searchParams.get("platform") ?? "android");
              const symptom = String(url.searchParams.get("symptom") ?? "crash");
              if (!(MOBILE_PLAN_PLATFORMS as readonly string[]).includes(platform)) {
                return json({ ok: false, error: `platform 须为 ${MOBILE_PLAN_PLATFORMS.join("/")}` }, 400);
              }
              const p = mobileDebugPlan(platform, symptom);
              return json({ ok: true, platform: p.platform, symptom: p.symptom, steps: p.steps, note: p.note });
            }
            if (action === "selftest" || action === "self-test") {
              const t = mobileSelfTest();
              return json({ ok: t.ok, passed: t.passed, total: t.total, checks: t.checks });
            }
            return json({ ok: false, error: `未知 action：${action || "（空）"}（probe/devices/logcat/plan/selftest —— 只读动作；forward/apk 深层探测走 CLI org mobile）` }, 400);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        }
        if (route === "GET /api/spawns") {
        // v0.5.11：派生池（agent_spawn 池化重档的观测面）。
          // 数据源三层：① <ws>/spawn/pool.json 登记（v0.5.11 起每次派生回写）；
          // ② 孤儿目录兜底（v0.5.6-v0.5.10 的旧派生无登记 —— 扫描
          //    spawn/*/out-spawn/run.json 合成 legacy 记录，面板不出现盲区）；
          // ③ 递归挂孙：沿 record.workspace 深入各子池（BFS，深度 ≤4 ·
          //    总量 ≤300），子生孙的完整树形。
          const rws = readWorkspaceOf(ws);
          const rwsAbs = path.resolve(rws);
          type SpawnRec = Record<string, unknown> & { id?: string; workspace?: string; children?: SpawnRec[] };
          const readPool = (wsDir: string): SpawnRec[] => {
            try {
              const pool = JSON.parse(fs.readFileSync(path.join(wsDir, "spawn", "pool.json"), "utf-8")) as { records?: unknown };
              if (Array.isArray(pool.records)) {
                return pool.records.filter((r): r is SpawnRec => !!r && typeof r === "object");
              }
            } catch { /* 池不存在/损坏 → 空 */ }
            return [];
          };
          const records: SpawnRec[] = readPool(rws);
          // 孤儿兜底：池里没有的 spawn 目录（旧版本派生）合成 legacy 记录
          const seen = new Set(records.map((r) => String(r.id ?? "")));
          const spawnRoot = path.join(rws, "spawn");
          try {
            for (const e of fs.readdirSync(spawnRoot, { withFileTypes: true })) {
              if (!e.isDirectory()) continue;
              const id = e.name;
              if (seen.has(id)) continue;
              try {
                const j = JSON.parse(fs.readFileSync(path.join(spawnRoot, id, "out-spawn", "run.json"), "utf-8")) as {
                  ok?: boolean; task?: string; elapsed_ms?: number; ts?: string;
                };
                records.push({
                  id, goal: j.task ?? id, mode: "run", depth: 1, budget: "?",
                  workspace: path.join(spawnRoot, id), out: path.join(spawnRoot, id, "out-spawn"),
                  ok: j.ok === true, usage: null, summary: "", legacy: true,
                  spawned_at: j.ts ?? "", finished_at: j.ts ?? "", reuse_count: 0,
                });
              } catch { /* 无 run.json 的半成品目录：跳过（可能是进行中的派生） */ }
            }
          } catch { /* spawn 目录不存在 → 空 */ }
          // 递归挂孙（工作区越界守卫：子池路径必须在本 ws 之下）
          const queue: SpawnRec[] = [...records];
          let nodeBudget = 300;
          while (queue.length > 0 && nodeBudget > 0) {
            const r = queue.shift()!;
            const wsDir = String(r.workspace ?? "");
            if (!wsDir || !path.resolve(wsDir).startsWith(rwsAbs + path.sep)) continue;
            const kids = readPool(wsDir);
            if (kids.length > 0) r.children = kids;
            nodeBudget -= kids.length;
            queue.push(...kids);
          }
          // 统计（全树递归）
          let okN = 0, failN = 0, reuseHits = 0, tokens = 0;
          const walk = (arr: SpawnRec[]): void => {
            for (const r of arr) {
              if (r.ok === true) okN++; else failN++;
              reuseHits += Math.max(0, Number(r.reuse_count) || 0);
              tokens += Number((r.usage as { tokens?: number } | null)?.tokens) || 0;
              if (Array.isArray(r.children)) walk(r.children);
            }
          };
          walk(records);
          return json({
            ok: true, workspace: rws, records,
            stats: { total: okN + failN, ok: okN, failed: failN, reuse_hits: reuseHits, tokens_total: tokens },
          });
        }
        if (route === "DELETE /api/spawns") {
        // v0.5.13：派生池清理（失败记录占位 / 全量重置 / 按id精确删）。
          // body {mode:"failed"|"all", ids?: string[]}；删除语义 = 池登记移除 +
          // 对应 spawn/<id> 目录整删（路径越界守卫：必须在本 ws 的 spawn/ 之下）。
          const body = await req.json().catch(() => ({})) as { mode?: unknown; ids?: unknown };
          const mode = String(body.mode ?? "failed");
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
          if (mode !== "failed" && mode !== "all" && !ids) {
            return json({ ok: false, error: 'mode 必须是 "failed" | "all"，或提供 ids 数组' }, 400);
          }
          const rws = readWorkspaceOf(ws);
          const spawnRoot = path.join(rws, "spawn");
          const inGuard = (p: string): boolean => {
            try { const abs = path.resolve(p); return abs.startsWith(path.resolve(spawnRoot) + path.sep); }
            catch { return false; }
          };
          // 读池（失败 → 空池，仍可清孤儿目录）
          type PoolRec = Record<string, unknown> & { id?: string; workspace?: string; ok?: boolean };
          const poolPath = path.join(spawnRoot, "pool.json");
          let poolRecs: PoolRec[] = [];
          try {
            const pool = JSON.parse(fs.readFileSync(poolPath, "utf-8")) as { records?: unknown };
            if (Array.isArray(pool.records)) poolRecs = pool.records.filter((r): r is PoolRec => !!r && typeof r === "object");
          } catch { /* 池不存在/损坏 */ }
          const keep: PoolRec[] = [];
          const dropped: Array<{ id: string; dir?: string }> = [];
          for (const r of poolRecs) {
            const id = String(r.id ?? "");
            const drop = mode === "all" || (mode === "failed" && r.ok !== true) || (ids !== null && ids.includes(id));
            if (drop) dropped.push({ id, dir: String(r.workspace ?? "") || undefined });
            else keep.push(r);
          }
          // 孤儿目录（legacy 无登记）：failed 模式删 run.json 标记失败的；all 模式全删
          const seen = new Set(poolRecs.map((r) => String(r.id ?? "")));
          try {
            for (const e of fs.readdirSync(spawnRoot, { withFileTypes: true })) {
              if (!e.isDirectory() || e.name === ".DS_Store") continue;
              if (seen.has(e.name)) continue;
              if (mode === "all" || mode === "failed" || ids?.includes(e.name)) {
                let isFailed = mode === "all";
                if (!isFailed) {
                  try {
                    const j = JSON.parse(fs.readFileSync(path.join(spawnRoot, e.name, "out-spawn", "run.json"), "utf-8")) as { ok?: boolean };
                    isFailed = j.ok !== true;
                  } catch { isFailed = true; } // 无 run.json 的半成品 → 失败语义
                }
                if (isFailed) dropped.push({ id: e.name, dir: path.join(spawnRoot, e.name) });
              }
            }
          } catch { /* spawn 目录不存在 → 跳过 */ }
          // 执行删除（目录整删 + 池回写）
          let dirsRemoved = 0, dirErrors: string[] = [];
          for (const d of dropped) {
            const dir = d.dir && inGuard(d.dir) ? d.dir : (d.id ? path.join(spawnRoot, d.id) : "");
            if (!dir || !inGuard(dir)) continue;
            if (!fs.existsSync(dir)) continue;
            try { fs.rmSync(dir, { recursive: true, force: true }); dirsRemoved++; }
            catch (err) { dirErrors.push(`${d.id}: ${String((err as Error).message ?? err).slice(0, 120)}`); }
          }
          try {
            fs.mkdirSync(spawnRoot, { recursive: true });
            fs.writeFileSync(poolPath, JSON.stringify({ version: 1, records: keep }, null, 2));
          } catch (err) {
            dirErrors.push(`pool.json 回写失败: ${String((err as Error).message ?? err).slice(0, 120)}`);
          }
          return json({
            ok: dirErrors.length === 0, mode: ids ? "ids" : mode,
            removed: dropped.length, records_kept: keep.length, dirs_removed: dirsRemoved,
            errors: dirErrors.length ? dirErrors : undefined,
          });
        }
        if (route === "GET /api/voice-status") {
          // v0.5.12：语音服务健康探测（GUI 🎙 面板状态行 + 🎤 按钮降级依据）。
          // 60s 内存缓存（探测不打 SDK——零调用实现：仅试 create 实例化）。
          const hit = voiceStatusCache.get(0);
          if (hit && Date.now() - hit.at < 60_000) {
            return json(hit.value);
          }
          const value = await voiceStatus();
          voiceStatusCache.set(0, { at: Date.now(), value });
          return json(value);
        }
        if (route === "POST /api/asr") {
          // v0.5.12：语音转写（🎤 录音 → base64 → 文本）。body {audio_base64}。
          // 降级：SDK 凭据缺席 → 503 {ok:false, error}（GUI 提示条，不炸）。
          const body = await req.json().catch(() => ({})) as { audio_base64?: unknown };
          const b64 = String(body.audio_base64 ?? "").replace(/^data:[^,]*,/, "");
          if (!b64) return json({ ok: false, error: "audio_base64 必填（录音数据）" }, 400);
          const buf = Buffer.from(b64, "base64");
          const out = await transcribeAudio(buf);
          if (!out.ok) {
            const status = /凭据|401|SDK/.test(out.error ?? "") ? 503 : 400;
            return json({ ok: false, error: out.error }, status);
          }
          return json({ ok: true, text: out.text, chars: out.chars });
        }
        if (route === "POST /api/tts") {
          // v0.5.12：文本合成（🔊 朗读回复）。body {text, voice?, speed?} →
          // audio/wav 二进制；SDK 凭据缺席 → 503 JSON（错误可显示）。
          const body = await req.json().catch(() => ({})) as { text?: unknown; voice?: unknown; speed?: unknown };
          const text = String(body.text ?? "");
          if (!text.trim()) return json({ ok: false, error: "text 必填（要朗读的文本）" }, 400);
          if (text.length > 8192) return json({ ok: false, error: `文本过长（${text.length} > 8192 上限）` }, 400);
          const out = await synthesizeSpeech(text, {
            voice: body.voice === undefined ? undefined : String(body.voice),
            speed: body.speed === undefined ? undefined : Number(body.speed),
          });
          if (!out.ok || !out.wav) {
            const status = /凭据|401|SDK/.test(out.error ?? "") ? 503 : 400;
            return json({ ok: false, error: out.error }, status);
          }
          return new Response(new Uint8Array(out.wav), {
            headers: {
              "Content-Type": "audio/wav",
              "Cache-Control": "no-store",
              "Content-Disposition": 'inline; filename="speech.wav"',
              "X-Voice-Chunks": String(out.chunks ?? 1),
              "X-Voice-Truncated": out.truncated ? "1" : "0",
            },
          });
        }
        if (route === "GET /api/vision-status") {
          // v0.5.13：视觉服务健康探测（GUI 📷 按钮降级依据；与 voice-status 同构 60s 缓存）。
          const hit = visionStatusCache.get(0);
          if (hit && Date.now() - hit.at < 60_000) {
            return json(hit.value);
          }
          const value = await visionStatus();
          visionStatusCache.set(0, { at: Date.now(), value });
          return json(value);
        }
        if (route === "POST /api/vision") {
          // v0.5.13：视觉分析（📷 选图 → base64 → VLM 描述）。两种 body 形态：
          //   便捷单图 {image_base64, mime?, prompt?} / 多图 {images: [{base64, mime}], prompt}。
          // 降级：SDK 凭据缺席 → 503 {ok:false, error}（GUI 提示条，不炸）。
          const body = await req.json().catch(() => ({})) as {
            image_base64?: unknown; mime?: unknown; prompt?: unknown;
            images?: Array<{ base64?: unknown; mime?: unknown } | string>;
          };
          const prompt = body.prompt === undefined ? undefined : String(body.prompt);
          // v0.5.14：宽容解析 —— images[] 元素支持 {base64, mime} 对象与
          // "data:image/...;base64,..." 字符串两形态（裸字符串此前报
          // 「图片为空」，对 API 消费者不友好）；data URL 前缀统一剥离。
          const stripDataUrl = (s: string): string => s.replace(/^data:[^,]*,/, "");
          let imgs: Array<{ buf: Buffer; mime?: string }> = [];
          if (Array.isArray(body.images) && body.images.length > 0) {
            imgs = body.images.slice(0, VISION_MAX_IMAGES).map((im) => {
              if (typeof im === "string") {
                const m = im.match(/^data:([^;,]*)[;,]/);
                return { buf: Buffer.from(stripDataUrl(im), "base64"), mime: m?.[1] };
              }
              return {
                buf: Buffer.from(stripDataUrl(String(im?.base64 ?? "")), "base64"),
                mime: im?.mime === undefined ? undefined : String(im.mime),
              };
            });
          } else {
            const b64 = stripDataUrl(String(body.image_base64 ?? ""));
            if (!b64) return json({ ok: false, error: "image_base64 必填（图片数据），或多图形态 images[] 数组" }, 400);
            imgs = [{
              buf: Buffer.from(b64, "base64"),
              mime: body.mime === undefined ? undefined : String(body.mime),
            }];
          }
          const out = await analyzeImages(imgs, prompt);
          if (!out.ok) {
            const status = /凭据|401|SDK/.test(out.error ?? "") ? 503 : 400;
            return json({ ok: false, error: out.error }, status);
          }
          return json({
            ok: true, text: out.text, chars: out.chars, images: out.images,
            prompt: out.prompt, prompt_truncated: out.promptTruncated ?? false,
          });
        }
        if (route === "GET /api/run") {
          const name = url.searchParams.get("dir") ?? "";
          // run 目录名形如 out-a / out-20260912-101500；SAFE_NAME 覆盖（含 - 与数字）
          if (!SAFE_NAME.test(name)) return json({ error: "run 目录名不合法" }, 400);
          const dir = path.join(readWorkspaceOf(ws), name);
          if (!fs.existsSync(dir)) return json({ error: `找不到运行产物：${name}` }, 404);
          const data = replayRun(dir);
          return json({
            dir: name,
            runJson: data.runJson,
            metrics: data.metrics,
            scorecard: data.scorecard,
            // 与 SSE 的 card 帧同形：附服务端 fact，浏览器只渲染不解析
            events: data.events.map((ev) => ({ ...ev, fact: classifyRunEvent(ev as never) })),
          });
        }
        if (route === "GET /api/score") {
          const name = url.searchParams.get("dir") ?? "";
          const rws = readWorkspaceOf(ws);
          let dir: string | null = null;
          if (name) {
            if (!SAFE_NAME.test(name)) return json({ error: "run 目录名不合法" }, 400);
            dir = path.join(rws, name);
          } else {
            dir = latestScorecardDir(rws);
          }
          if (!dir) return json({ ok: false, error: "尚无评分卡（先派单或 org demo）" }, 404);
          const card = readScorecard(dir);
          if (!card) return json({ ok: false, error: "评分卡读取失败" }, 404);
          return json({ ok: true, dir: path.basename(dir), scorecard: card });
        }
        // ---- 只读面 ----
        if (route === "GET /api/status") {
          const rws = readWorkspaceOf(ws);
          const experts = loadRegistryIndex(rws).map((m) => ({
            name: m.name,
            version: m.version,
            source: m.source,
            retained: m.retained !== false,
            description: String((m as Record<string, unknown>).description ?? ""),
            capabilities: Array.isArray((m as Record<string, unknown>).capabilities)
              ? (m as Record<string, unknown>).capabilities
              : [],
          }));
          const usages = listContextUsage(rws);
          return json({
            workspace: rws,
            experts,
            usages,
            windowTokens: 131_072,
            model: opts.model, // 服务级 model（GUI 初始值对齐 org web --model）
          });
        }
        // ---- 工具库治理（v0.4.12：用户在 GUI 选取哪些 harness 保留到工具库）----
        // 与 CLI 的 org keep / org drop 同一代码路径（setRetained：翻转
        // retained 标志 + 双写注册表 + git 留痕「(user curation)」）—— GUI
        // 只是薄渲染层的设计纪律不变。工厂产出是候选（retained=false），用户
        // 选取转正后才参与 B 路径自动复用；「哪些 harness 值得留下」是用户的
        // 决策权，不是系统的默认行为。
        const retainRoute = url.pathname.match(/^\/api\/(keep|drop)$/);
        if (retainRoute && req.method === "POST") {
          const body = await req.json().catch(() => ({})) as { expert?: unknown };
          const expert = String(body.expert ?? "");
          if (!SAFE_NAME.test(expert)) return json({ error: "expert 名不合法" }, 400);
          const rws = readWorkspaceOf(ws);
          // dist/demo 是入库快照（只读，与 CLI keep/drop 同守卫）
          if (path.resolve(rws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          if (!fs.existsSync(path.join(rws, "registry/index.json"))) {
            return json({ error: "工作区无注册表（先 org demo / org run）" }, 400);
          }
          const retained = retainRoute[1] === "keep";
          const out = setRetained(rws, [expert], retained);
          if (out.kept.length === 0) {
            return json({ ok: false, error: `专家不存在：${expert}` }, 404);
          }
          return json({ ok: true, expert, retained, kept: out.kept });
        }
        // ---- 运行范围复核（org review 的 GUI 面）----
        // 与 CLI org review 同一代码路径（reviewCandidates + applyReview）：
        // 范围由运行产物界定（本次铸出 / 补丁合入 / 复用命中），选取只翻转
        // retained，不删文件。GUI 在这里承担「本次运行产出的东西，哪些值得
        // 沉淀进工具库」的勾选面 —— CLI 交互选取的可视化等价物。
        if (route === "GET /api/review") {
          const rws = readWorkspaceOf(ws);
          const runParam = url.searchParams.get("run") ?? "";
          const plan = reviewCandidates(rws, runParam || undefined);
          if (!plan.scope) {
            return json({ ok: false, error: "工作区没有 run 产物目录（先 org run / org demo）" }, 404);
          }
          return json({ ok: true, ...plan });
        }
        if (route === "POST /api/review") {
          const body = await req.json().catch(() => ({})) as { run?: unknown; keep?: unknown };
          const rws = readWorkspaceOf(ws);
          if (path.resolve(rws) === path.join(ROOT, "dist", "demo")) {
            return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
          }
          const keep = Array.isArray(body.keep) ? body.keep.map((x) => String(x)) : [];
          if (keep.some((n) => !SAFE_NAME.test(n))) return json({ error: "harness 名不合法" }, 400);
          // 只接受本次复核范围内的候选：越界选取说明客户端状态已过期，
          // 明确 409 拒绝而不是「静默生效一部分」。
          const plan = reviewCandidates(rws, String(body.run ?? "") || undefined);
          const allowed = new Set(plan.pending.map((c) => c.name));
          const outOfScope = keep.filter((n) => !allowed.has(n));
          if (outOfScope.length > 0) {
            return json({
              ok: false,
              error: `不在本次待决策候选内：${outOfScope.join(", ")}`,
              allowed: [...allowed],
            }, 409);
          }
          const out = applyReview(rws, keep);
          return json({ ok: true, kept: out.kept, keptCount: out.kept.length, run: plan.scope?.label ?? "" });
        }
        if (route === "GET /api/sessions") {
          const expert = url.searchParams.get("expert") ?? "";
          if (!SAFE_NAME.test(expert)) return json({ error: "expert 名不合法" }, 400);
          return json({ expert, sessions: listSessions(readWorkspaceOf(ws), expert) });
        }
        const sessionRoute = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
        if (sessionRoute) {
          const expert = decodeURIComponent(sessionRoute[1]!);
          const id = decodeURIComponent(sessionRoute[2]!);
          if (!SAFE_NAME.test(expert) || !SAFE_NAME.test(id)) {
            return json({ error: "expert/session 名不合法" }, 400);
          }
          // GET：逐轮问答
          if (req.method === "GET") {
            return json({ expert, session: id, turns: readSession(readWorkspaceOf(ws), expert, id) });
          }
          // dist/demo 是入库快照（只读）—— v0.4.17 修复：DELETE/PATCH 此前
          // 无守卫（keep/drop 有），空工作区起服时读侧回退 dist/demo，写侧
          // 会把入库快照里的会话账本删掉/改名，污染仓库（实测复现）。
          if (req.method === "DELETE" || req.method === "PATCH") {
            const rws = readWorkspaceOf(ws);
            if (path.resolve(rws) === path.join(ROOT, "dist", "demo")) {
              return json({ error: "dist/demo 是入库快照（只读）。请以可写工作区启动 org web。" }, 400);
            }
          }
          // DELETE：删除会话（账本是唯一事实源：删账本文件 = 删会话）
          if (req.method === "DELETE") {
            const file = sessionFile(readWorkspaceOf(ws), expert, id);
            if (!file || !fs.existsSync(file)) {
              return json({ ok: false, error: `会话不存在（${expert}/${id}）` }, 404);
            }
            fs.rmSync(file);
            return json({ ok: true, deleted: id });
          }
          // PATCH：重命名（body {to} —— 同专家内 mv 账本文件）
          if (req.method === "PATCH") {
            let body: Record<string, unknown>;
            try {
              body = (await req.json()) as Record<string, unknown>;
            } catch {
              return json({ error: "请求体必须是 JSON" }, 400);
            }
            const to = String(body.to ?? "").trim();
            if (!SAFE_NAME.test(to)) {
              return json({ error: "新会话名不合法（字母数字连字符下划线，≤64）" }, 400);
            }
            const fromFile = sessionFile(readWorkspaceOf(ws), expert, id);
            if (!fromFile || !fs.existsSync(fromFile)) {
              return json({ ok: false, error: `会话不存在（${expert}/${id}）` }, 404);
            }
            const toFile = sessionFile(readWorkspaceOf(ws), expert, to);
            if (toFile && fs.existsSync(toFile)) {
              return json({ ok: false, error: `目标会话已存在（${expert}/${to}）` }, 409);
            }
            fs.renameSync(fromFile, toFile!);
            return json({ ok: true, from: id, to });
          }
        }
        // ---- 交互面 ----
        if (route === "POST /api/ask") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return json({ error: "请求体必须是 JSON" }, 400);
          }
          const expert = String(body.expert ?? "").trim();
          const question = String(body.question ?? "").trim();
          const session = String(body.session ?? "default").trim();
          // model 回落链：请求体显式传 > 服务级（org web --model deepseek）
          // > scripted 缺省。
          const model = String(body.model ?? "").trim() || opts.model || "scripted";
          if (!expert || !question) {
            return json({ error: "expert 与 question 必填" }, 400);
          }
          if (!SAFE_NAME.test(expert) || !SAFE_NAME.test(session)) {
            return json({ error: "expert/session 名不合法" }, 400);
          }
          const ticket = gate.issue();
          try {
            const outcome = await askSerialized(() => askOnce(ws, { expert, question, session, model }), ticket);
            return json(outcome as unknown as Record<string, unknown>, outcome.ok ? 200 : 500);
          } catch (err) {
            if (err instanceof QueueCancelledError) {
              return json({ ok: false, aborted: true, queued: true, message: err.message });
            }
            throw err;
          } finally {
            gate.release(ticket);
          }
        }
        // ---- 交互面（SSE 流式） ----
        if (route === "POST /api/ask-stream") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return json({ error: "请求体必须是 JSON" }, 400);
          }
          const expert = String(body.expert ?? "").trim();
          const question = String(body.question ?? "").trim();
          const session = String(body.session ?? "default").trim();
          const model = String(body.model ?? "").trim() || opts.model || "scripted";
          if (!expert || !question) {
            return json({ error: "expert 与 question 必填" }, 400);
          }
          if (!SAFE_NAME.test(expert) || !SAFE_NAME.test(session)) {
            return json({ error: "expert/session 名不合法" }, 400);
          }
          return sseAsk(ws, { expert, question, session, model });
        }
        // ---- 未知路由 ----
        if (url.pathname.startsWith("/api/")) {
          return json({ error: `未知端点 ${route}` }, 404);
        }
        return new Response("Not Found", { status: 404 });
      } catch (err) {
        return json({ error: (err as Error).message }, 500);
      }
    },
  });
  if (taskRunner) {
    // stop 联动：srv.stop() 一并停执行器 + 释放 runner lock（测试与进程退出都干净）
    const origStop = server.stop.bind(server);
    (server as unknown as { stop: (force?: boolean) => void }).stop = (force?: boolean) => {
      try { taskRunner!.stop(); taskRunner!.releaseLock(); } catch { /* 已停 */ }
      return origStop(force);
    };
  }
  return server;
}

// ---- CLI 入口（org web 子命令；常驻直到 Ctrl+C） ----

export async function webMain(argv: string[]): Promise<number> {
  const p = parseWebArgv(argv);
  // 网关路由（deepseek 真实模型车道）：--gateway 或既有 DHV_LLM_GATEWAY
  // 环境变量 → 注入子进程 env（spawn 车道继承 process.env）。缺省时
  // $host.llm 直连 z-ai-web-dev-sdk（需要本机装包，仓库零依赖不内置）。
  if (p.gateway) {
    process.env.DHV_LLM_GATEWAY = p.gateway.replace(/\/+$/, "");
  }
  let server: Bun.Server;
  try {
    server = startWebServer({ workspace: p.workspace, port: p.port, host: p.host, model: p.model, taskRunner: true });
  } catch (err) {
    process.stderr.write(`✗ Web 服务启动失败：${(err as Error).message}\n`);
    process.stderr.write(`  （端口 ${p.port} 被占用？--port N 换一个）\n`);
    return 2;
  }
  console.log(`ORG web · v${VERSION} · 工作区 ${p.workspace}`);
  console.log(`  GUI        http://${p.host}:${server.port}/`);
  console.log(`  只读面     GET /api/status · /api/sessions?expert=… · /api/session/<专家>/<会话>`);
  console.log(`  会话管理   DELETE /api/session/<E>/<S>（删除）· PATCH（重命名 body {to}）`);
  console.log(`  交互面     POST /api/ask-stream（SSE 流式）· POST /api/ask（JSON 整轮）`);
  console.log(`  停止       POST /api/abort（运行轮 SIGKILL / body{id} 取消排队轮）`);
  console.log(`  协作面     GET/POST /api/govex/collab（v0.5.17 #87：threads/feed/users/summary/whoami + post/comment/user/bridge）`);
  console.log(`  云生态     GET/POST /api/govex/cloud（v0.5.17 #67/#68/#72/#74：probe 全景/dockerfile/compose/manifest/terraform 模板 + docker/ssh/k8s 白名单执行）`);
  console.log(`  移动端     GET /api/govex/mobile（v0.5.18 #117：probe 三面探测/devices 设备清单/logcat dump 五元组/plan 计划保底 + selftest —— 只读动作）`);
  console.log(`  模型       ${p.model}（GUI 可切 scripted/deepseek，请求体可逐次覆盖）`);
  // v0.4.13：网关三件套可见性 —— 直连服务商（DeepSeek 等）的鉴权/模型/超时
  // 经环境变量注入（spawn 车道继承 process.env），横幅回显防「配了没生效」。
  const llmModel = process.env.DHV_LLM_MODEL ?? "";
  const llmKey = process.env.DHV_LLM_API_KEY ?? "";
  console.log(p.gateway
    ? `  网关       ${p.gateway}${llmModel ? ` · 模型 ${llmModel}` : ""}${llmKey ? " · 鉴权 ✓" : "（未配 DHV_LLM_API_KEY，若服务商需鉴权将 401）"}`
    : `  网关       未配置（--gateway https://api.deepseek.com/v1 + DHV_LLM_API_KEY/DHV_LLM_MODEL 直连服务商）`);
  console.log(`  Ctrl+C 退出`);
  process.on("SIGINT", () => { server.stop(true); process.exit(0); });
  process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
  await new Promise<void>(() => { /* 常驻：信号退出统一走 server.stop */ });
  return 0;
}

// ---- Markdown 渲染（零依赖 · 自包含：服务端导出可单测，客户端同一实现）----
// 注入方式：renderIndexHtml 用 fn.toString() 把本函数源码嵌进内联 JS ——
// 浏览器与 tests/web.test.ts 永远跑同一实现，无双份漂移。纪律：XSS 优先
// （全量转义后再还原受控标签）；未识别语法按原文降级显示，不猜测。
// 支持面：围栏代码块（```lang + 块级 copy 钮）· 表格 · 有序/无序列表（缩进
// 嵌套 + 续行）· 引用 · h1-h4 · 分割线 · 行内粗/斜/删/行内码/链接（http(s)）。
export function renderMd(src: string): string {
  function E(s: string): string {
    return s.replace(/[&<>"']/g, function (c: string): string {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">"
        ? "&gt;" : c === '"' ? "&quot;" : "&#39;";
    });
  }
  function inline(s: string): string {
    let t = E(s);
    t = t.replace(/`([^`]+)`/g, '<code class="icd">$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^<\s)"']+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return t;
  }
  function splitRow(l: string): string[] {
    let s = l.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map(function (c: string): string { return c.trim(); });
  }
  function kind(l: string): string {
    if (/^\s*$/.test(l)) return "blank";
    if (/^\s*```/.test(l)) return "fence";
    if (/^#{1,4}\s+\S/.test(l)) return "heading";
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return "hr";
    if (/^>/.test(l)) return "quote";
    if (/^\s*[-*+]\s+\S/.test(l)) return "ul";
    if (/^\s*\d+[.)]\s+\S/.test(l)) return "ol";
    return "text";
  }
  function closeAll(): void {
    while (stack.length > 0) {
      const top = stack.pop()!;
      out.push((top.liOpen ? "</li>" : "") + "</" + top.tag + ">");
    }
  }
  function isTableStart(idx: number): boolean {
    const cur = lines[idx] ?? "";
    const sep = lines[idx + 1] ?? "";
    return cur.indexOf("|") >= 0 &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(sep);
  }
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const stack: Array<{ tag: string; indent: number; liOpen: boolean }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const k = kind(line);
    if (k === "blank") { closeAll(); i++; continue; }
    if (k === "fence") {
      closeAll();
      const lang = (line.match(/^\s*```\s*(\S*)/) ?? ["", ""])[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) { body.push(lines[i]!); i++; }
      if (i < lines.length) i++; // 收口 ```（EOF 容忍：流式未闭合也先渲染）
      out.push('<div class="mdcode"><div class="mdcode-h"><span>' + E(lang) +
        '</span><button class="mdcopy" type="button" title="复制代码">copy</button></div>' +
        "<pre><code>" + E(body.join("\n")) + "</code></pre></div>");
      continue;
    }
    if (isTableStart(i)) {
      closeAll();
      const header = splitRow(line);
      i += 2; // 表头 + 分隔行
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.indexOf("|") >= 0 && kind(lines[i]!) === "text") {
        rows.push(splitRow(lines[i]!)); i++;
      }
      out.push('<div class="mdtable"><table><thead><tr>' +
        header.map(function (c: string): string { return "<th>" + inline(c) + "</th>"; }).join("") +
        "</tr></thead><tbody>" +
        rows.map(function (r: string[]): string {
          return "<tr>" + r.map(function (c: string): string {
            return "<td>" + inline(c) + "</td>";
          }).join("") + "</tr>";
        }).join("") + "</tbody></table></div>");
      continue;
    }
    if (k === "heading") {
      closeAll();
      const m = line.match(/^(#{1,4})\s+(.*)$/) ?? ["", "#", ""];
      out.push("<h" + m[1]!.length + ">" + inline(m[2]!) + "</h" + m[1]!.length + ">");
      i++; continue;
    }
    if (k === "hr") { closeAll(); out.push('<hr class="mdhr">'); i++; continue; }
    if (k === "quote") {
      closeAll();
      const q: string[] = [];
      while (i < lines.length && kind(lines[i]!) === "quote") {
        q.push(lines[i]!.replace(/^>\s?/, "")); i++;
      }
      out.push("<blockquote>" + q.map(inline).join("<br>") + "</blockquote>");
      continue;
    }
    if (k === "ul" || k === "ol") {
      const m = line.match(k === "ul" ? /^(\s*)[-*+]\s+(.*)$/ : /^(\s*)\d+[.)]\s+(.*)$/)
        ?? ["", "", ""];
      const indent = Math.floor((m[1] ?? "").length / 2);
      const tag = k === "ul" ? "ul" : "ol";
      while (stack.length > 0 && stack[stack.length - 1]!.indent > indent) {
        const top = stack.pop()!;
        out.push((top.liOpen ? "</li>" : "") + "</" + top.tag + ">");
      }
      if (stack.length === 0 || stack[stack.length - 1]!.indent < indent) {
        out.push("<" + tag + ">");
        stack.push({ tag, indent, liOpen: false });
      } else if (stack[stack.length - 1]!.tag !== tag) {
        const top = stack.pop()!;
        out.push((top.liOpen ? "</li>" : "") + "</" + top.tag + ">");
        out.push("<" + tag + ">");
        stack.push({ tag, indent, liOpen: false });
      } else if (stack[stack.length - 1]!.liOpen) {
        out.push("</li>");
      }
      i++;
      out.push("<li>" + inline(m[2] ?? ""));
      // 列表项续行（≥2 空格缩进的普通文本并入本项）
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && kind(lines[i]!) === "text") {
        out.push("<br>" + inline(lines[i]!.trim())); i++;
      }
      stack[stack.length - 1]!.liOpen = true;
      continue;
    }
    // 段落：连续 text 行（遇表格头/块级语法即断）
    const para: string[] = [line];
    i++;
    while (i < lines.length && kind(lines[i]!) === "text" && !isTableStart(i)) {
      para.push(lines[i]!); i++;
    }
    out.push("<p>" + para.map(inline).join("<br>") + "</p>");
  }
  closeAll();
  return out.join("");
}

// ---- 单页 GUI（内联 HTML：Codex 风终端美学 · 原生 fetch · 中文文案） ----
// 设计语言（issue #12）：近黑 zinc 色板 + 1px 发丝边框 + 4px 小圆角 + 等宽
// chrome（标签/元数据/状态栏）+ tmux 式底部状态栏 + ❯ 提示符转写行（无气泡）
// + 运行日志终端窗口 + braille 旋转指示。无渐变、无辉光、低饱和功能色
// （emerald=运行/在线，red=错误），琥珀仅作状态栏品牌微标记。
// 转义纪律：模板字符串内 JS 的 \\n / \\d 等双写（编译后单反斜杠）；内联 JS
// 一律字符串拼接（不用反引号模板）；除 VERSION 外不出现 ${ 字样。

function renderIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>org · agent</title>
<style>
  :root {
    --bg: #0a0a0b; --panel: #0f0f11; --panel2: #16161a; --raise: #1d1d22;
    --border: #232328; --border2: #31313a;
    --text: #d4d4d8; --muted: #9d9da6; --dim: #6b6b74;
    --green: #10b981; --greenb: #34d399; --red: #ef4444; --redb: #f87171;
    --amber: #d97706;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas,
            "Liberation Mono", "Noto Sans Mono CJK SC", monospace;
    --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { background: var(--bg); color: var(--text);
         font: 13px/1.6 var(--sans); display: flex; flex-direction: column;
         overflow: hidden; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--raise); border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ── 顶栏 ─────────────────────────────────────────────── */
  header { flex: none; height: 34px; display: flex; align-items: center;
           gap: 10px; padding: 0 12px; background: var(--panel);
           border-bottom: 1px solid var(--border);
           font: 11px var(--mono); color: var(--dim); }
  header .brand { color: var(--amber); font-weight: 700; letter-spacing: 1px; }
  header .ver { color: var(--muted); }
  header .path { flex: 1; min-width: 0; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; }
  header .tstats { margin-left: auto; color: var(--muted); white-space: nowrap; }
  #menuBtn { display: none; flex: none; width: 26px; height: 20px;
           border: 1px solid var(--border); background: transparent; color: var(--muted);
           font: 13px/1 var(--mono); border-radius: 3px; cursor: pointer; }
  #menuBtn:hover { color: var(--text); border-color: var(--border2); }

  .app { flex: 1; display: flex; min-height: 0; }

  /* ── 侧栏（sessions / experts）────────────────────────── */
  aside { width: 272px; flex: none; background: var(--panel);
          border-right: 1px solid var(--border); display: flex;
          flex-direction: column; min-height: 0; }
  .newbtn { margin: 10px 10px 2px; flex: none; height: 30px;
            display: flex; align-items: center; justify-content: center; gap: 6px;
            border: 1px solid var(--border); border-radius: 4px;
            background: transparent; color: var(--muted);
            font: 12px var(--mono); cursor: pointer; }
  .newbtn:hover { border-color: var(--border2); color: var(--text);
                  background: var(--panel2); }
  .newbtn:disabled { opacity: .5; cursor: not-allowed; }
  #sessSearch { flex: none; margin: 6px 10px 0; height: 26px; background: var(--bg);
           border: 1px solid var(--border); border-radius: 3px; color: var(--text);
           font: 11px var(--mono); padding: 0 8px; outline: none; }
  #sessSearch:focus { border-color: var(--border2); }
  #sessSearch::placeholder { color: var(--dim); }
  .sec { flex: none; display: flex; align-items: center; gap: 6px;
         padding: 12px 12px 4px; font: 10px var(--mono);
         letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); }
  .sec .cnt { margin-left: auto; letter-spacing: 0; }
  .list { overflow-y: auto; padding: 0 6px 6px; }
  #sessions { flex: 1; min-height: 0; }
  #experts { flex: none; border-top: 1px solid var(--border); }

  .sess { position: relative; padding: 5px 6px 5px 10px; margin: 1px 0;
          border-radius: 3px; cursor: pointer; }
  .sess:hover { background: var(--panel2); }
  .sess.active { background: var(--panel2); }
  .sess.active::before { content: ""; position: absolute; left: 0; top: 5px;
          bottom: 5px; width: 2px; background: var(--green); border-radius: 1px; }
  .sess .l1 { display: flex; align-items: center; gap: 6px; font: 12px var(--mono); }
  .sess .id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; color: var(--muted); }
  .sess.active .id { color: var(--text); }
  .sess .n { color: var(--dim); font-size: 10px; }
  .sess .l2 { margin-top: 1px; font: 10px var(--mono); color: var(--dim);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acts { display: none; gap: 2px; }
  .sess:hover .acts, .sess.editing .acts { display: flex; }
  .exp:hover .acts { display: flex; }
  .hintline { position: fixed; left: 50%; transform: translateX(-50%); bottom: 34px;
          max-width: 72%; padding: 4px 10px; border: 1px solid var(--line);
          border-radius: 4px; background: var(--raise); color: var(--dim);
          font: 11px var(--mono); opacity: 0; pointer-events: none;
          transition: opacity .18s; z-index: 60; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; }
  .hintline.on { opacity: 1; }
  .ic { border: none; background: transparent; color: var(--dim);
        font: 11px var(--mono); cursor: pointer; padding: 1px 4px;
        border-radius: 2px; line-height: 1.4; }
  .ic:hover { color: var(--text); background: var(--raise); }
  .ic.danger:hover { color: var(--redb); }
  .sess input { flex: 1; min-width: 0; background: var(--bg);
        border: 1px solid var(--border2); border-radius: 3px; color: var(--text);
        font: 12px var(--mono); padding: 2px 6px; outline: none; }
  .sess input.err { border-color: var(--red); }
  .confirm { flex: 1; min-width: 0; font: 11px var(--mono); color: var(--redb);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .exp { position: relative; padding: 6px 8px 6px 10px; margin: 1px 0;
         border-radius: 3px; cursor: pointer; }
  .exp:hover { background: var(--panel2); }
  .exp.active { background: var(--panel2); }
  .exp.active::before { content: ""; position: absolute; left: 0; top: 6px;
         bottom: 6px; width: 2px; background: var(--green); border-radius: 1px; }
  .exp .l1 { display: flex; align-items: center; gap: 6px; font: 12px var(--mono); }
  .exp .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
         white-space: nowrap; color: var(--muted); font-weight: 600; }
  .exp.active .nm { color: var(--text); }
  .exp .vr { color: var(--dim); font-size: 10px; }
  .exp .bdg { flex: none; font: 9px var(--mono); padding: 0 4px;
         border: 1px solid var(--border2); border-radius: 2px; color: var(--muted); }
  .exp .bdg.import { color: var(--greenb); border-color: rgba(16,185,129,.35); }
  .exp .l2 { margin-top: 1px; font: 10px var(--mono); color: var(--dim);
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── 主列 ─────────────────────────────────────────────── */
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .thead { flex: none; height: 34px; display: flex; align-items: center; gap: 10px;
           padding: 0 12px; border-bottom: 1px solid var(--border);
           font: 11px var(--mono); color: var(--dim); }
  .thead .crumb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
           white-space: nowrap; color: var(--muted); }
  .thead .ghost { border: 1px solid var(--border); background: transparent;
           color: var(--dim); font: 11px var(--mono); padding: 3px 10px;
           border-radius: 3px; cursor: pointer; }
  .thead .ghost:hover { color: var(--text); border-color: var(--border2); }

  .chatwrap { flex: 1; min-height: 0; overflow-y: auto; position: relative; }
  .chat { max-width: 860px; margin: 0 auto; padding: 20px 16px 28px; }

  /* 转写行（无气泡）：❯ 用户行 + org 元信息行 + 正文 */
  .t-user { display: flex; gap: 8px; margin: 18px 0 2px; font: 13px var(--mono); }
  .t-user .ps { color: var(--dim); user-select: none; flex: none; }
  .t-user .q { flex: 1; min-width: 0; color: var(--text); white-space: pre-wrap;
           word-break: break-word; }
  .t-bot { margin: 0 0 2px; }
  .t-bot .who { font: 10px var(--mono); color: var(--dim); letter-spacing: .3px;
           margin: 4px 0 5px; }
  .t-bot .body { font: 14px/1.75 var(--sans); color: var(--text);
           white-space: pre-wrap; word-break: break-word; }
  /* v0.5.14：B-22 直连救援/降级徽标与降级气泡 */
  .rsc-badge { display: inline-block; margin-left: 8px; padding: 1px 7px;
           border: 1px solid var(--amber, #b8860b); border-radius: 999px;
           font: 10px var(--mono); color: var(--amber, #b8860b);
           background: rgba(184, 134, 11, .08); vertical-align: 1px; }
  .rsc-badge.deg { border-color: var(--dim); color: var(--dim);
           background: transparent; }
  .t-bot.degraded .body { color: var(--dim); }
  .t-bot.degraded { border-left: 2px solid var(--border2);
           padding-left: 10px; }

  .runline { display: flex; align-items: center; gap: 8px;
           font: 12px var(--mono); color: var(--greenb); margin: 6px 0; }
  .spin { flex: none; width: 1.2ch; display: inline-block; }
  .answering { font: 14px/1.75 var(--sans); color: var(--text);
           white-space: pre-wrap; word-break: break-word; }
  .caret { color: var(--greenb); animation: blink 1s steps(1) infinite;
           margin-left: 2px; }
  @keyframes blink { 50% { opacity: 0; } }

  /* 运行日志终端窗口 */
  .logwin { border: 1px solid var(--border); border-radius: 4px;
           background: #08080a; margin: 8px 0 0; overflow: hidden; }
  .loghead { display: flex; align-items: center; gap: 6px; padding: 4px 10px;
           font: 10px var(--mono); color: var(--dim);
           border-bottom: 1px solid var(--border); cursor: pointer;
           user-select: none; }
  .loghead:hover { color: var(--muted); }
  .loghead .tri { display: inline-block; transition: transform .15s; }
  .logwin.open .loghead .tri { transform: rotate(90deg); }
  .loghead .ln { color: var(--muted); }
  .logwin pre { display: none; margin: 0; padding: 8px 10px;
           font: 11px/1.55 var(--mono); color: #8f8f98; max-height: 200px;
           overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .logwin.open pre { display: block; }

  /* 观测元数据行 + ctx 计量条 */
  .obs { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
         margin-top: 6px; font: 10px var(--mono); color: var(--dim); }
  .meter { display: inline-block; width: 80px; height: 3px; background: var(--raise);
         border-radius: 1px; overflow: hidden; vertical-align: middle; }
  .meter i { display: block; height: 100%; background: var(--green); }

  .errbox { display: flex; align-items: center; gap: 8px; margin: 6px 0;
         font: 12px var(--mono); color: var(--redb);
         border: 1px solid rgba(239,68,68,.3); background: rgba(239,68,68,.06);
         border-radius: 4px; padding: 8px 10px; white-space: pre-wrap;
         word-break: break-word; }
  .errbox .retry { margin-left: auto; flex: none; border: 1px solid var(--border2);
         background: transparent; color: var(--muted); font: 11px var(--mono);
         padding: 2px 10px; border-radius: 3px; cursor: pointer; }
  .errbox .retry:hover { color: var(--text); border-color: var(--redb); }
  .stoppedbox { font: 11px var(--mono); color: var(--dim); margin: 6px 0; }

  /* ── Markdown 渲染面（回答正文 · Codex 式克制，issue #13）── */
  .t-bot .body.md { white-space: normal; }
  .md p { margin: 0 0 8px; }
  .md > :last-child { margin-bottom: 0; }
  .md h1 { font: 600 16px/1.45 var(--sans); margin: 16px 0 6px; color: #f4f4f5; }
  .md h2 { font: 600 15px/1.45 var(--sans); margin: 14px 0 6px; color: #eeeef0; }
  .md h3 { font: 600 14px/1.45 var(--sans); margin: 12px 0 4px; color: #e6e6e9; }
  .md h4 { font: 600 13px/1.45 var(--sans); margin: 10px 0 4px; }
  .md ul, .md ol { margin: 0 0 8px; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px;
           border-left: 2px solid var(--border2); color: var(--muted); }
  .md blockquote p { margin: 0; }
  .md .icd { font: 12px var(--mono); background: var(--raise);
           border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; }
  .md a { color: var(--greenb); text-decoration: none;
           border-bottom: 1px solid rgba(52, 211, 153, .35); }
  .md a:hover { border-bottom-color: var(--greenb); }
  .md .mdhr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .mdcode { border: 1px solid var(--border); border-radius: 4px;
           background: #08080a; margin: 8px 0; overflow: hidden; }
  .mdcode .mdcode-h { display: flex; align-items: center; gap: 6px; padding: 3px 10px;
           border-bottom: 1px solid var(--border); font: 10px var(--mono);
           color: var(--dim); }
  .mdcopy { margin-left: auto; border: 1px solid var(--border); background: transparent;
           color: var(--dim); font: 10px var(--mono); padding: 1px 8px;
           border-radius: 2px; cursor: pointer; }
  .mdcopy:hover { color: var(--text); border-color: var(--border2); }
  .mdcopy.copied { color: var(--greenb); border-color: rgba(16,185,129,.35); }
  .mdcode pre { margin: 0; padding: 10px 12px; font: 12px/1.6 var(--mono);
           color: #c9c9d1; overflow-x: auto; }
  .mdtable { margin: 8px 0; border: 1px solid var(--border); border-radius: 4px;
           overflow-x: auto; }
  .mdtable table { border-collapse: collapse; width: 100%; font: 12px/1.5 var(--mono); }
  .mdtable th, .mdtable td { padding: 5px 10px; text-align: left;
           border-bottom: 1px solid var(--border); }
  .mdtable tr:last-child td { border-bottom: none; }
  .mdtable th { color: var(--muted); font-weight: 600; background: var(--panel2); }

  /* 消息级操作（hover 浮现，issue #13） */
  .macts { display: flex; gap: 2px; margin-top: 4px; opacity: 0;
           transition: opacity .12s; }
  .t-bot:hover .macts { opacity: 1; }
  .mact { border: 1px solid transparent; background: transparent; color: var(--dim);
           font: 10px var(--mono); cursor: pointer; padding: 1px 8px;
           border-radius: 2px; }
  .mact:hover { color: var(--text); background: var(--raise);
           border-color: var(--border); }
  .mact.copied { color: var(--greenb); }

  /* 空态：终端 banner */
  .banner { max-width: 560px; margin: 8vh auto 0; border: 1px solid var(--border);
           border-radius: 4px; background: var(--panel); padding: 14px 16px;
           font: 12px var(--mono); color: var(--muted); }
  .b-row { display: flex; gap: 12px; padding: 3px 0; }
  .b-k { flex: none; width: 88px; color: var(--dim); text-transform: uppercase;
           font-size: 10px; letter-spacing: 1px; padding-top: 2px; }
  .b-v { color: var(--muted); word-break: break-all; }
  .b-hr { height: 1px; background: var(--border); margin: 8px 0; }

  /* 回到最新 */
  #jumpBtn { display: none; position: absolute; bottom: 14px; left: 50%;
           transform: translateX(-50%); border: 1px solid var(--border2);
           background: var(--panel2); color: var(--muted); font: 11px var(--mono);
           padding: 4px 12px; border-radius: 3px; cursor: pointer; z-index: 5; }
  #jumpBtn:hover { color: var(--text); }

  /* ── 输入坞 ───────────────────────────────────────────── */
  .composer { flex: none; border-top: 1px solid var(--border);
              background: var(--panel); padding: 10px 12px; }
  .cbox { max-width: 860px; margin: 0 auto; display: flex; align-items: center; gap: 6px;
        border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px;
        background: var(--bg); transition: border-color .15s; }
  .cbox:focus-within { border-color: var(--border2); }
  .cbox .ps { flex: none; font: 14px var(--mono);
           color: var(--green); user-select: none; }
  #question { flex: 1; min-width: 0; background: transparent; border: none;
           outline: none; resize: none; font: 14px/1.6 var(--sans);
           color: var(--text); padding: 7px 10px; max-height: 140px;
           min-height: 32px; }
  #question::placeholder { color: var(--dim); }
  #question:disabled { opacity: .5; }
  .crow { max-width: 860px; margin: 8px auto 0; display: flex;
           align-items: center; gap: 8px; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: 3px;
           overflow: hidden; }
  .seg button { border: none; background: transparent; color: var(--dim);
           font: 11px var(--mono); padding: 4px 10px; cursor: pointer; }
  .seg button.on { background: var(--raise); color: var(--text); }
  .seg button:not(.on):hover { color: var(--muted); }
  #send { margin-left: auto; border: 1px solid var(--border2);
           background: transparent; color: var(--text); font: 12px var(--mono);
           padding: 5px 16px; border-radius: 3px; cursor: pointer; }
  #send:hover { background: var(--raise); }
  #send.running { border-color: rgba(239,68,68,.4); color: var(--redb); }
  #send.running:hover { background: rgba(239,68,68,.08); }
  .khint { font: 10px var(--mono); color: var(--dim); white-space: nowrap; }

  /* ── 状态栏（tmux 式）─────────────────────────────────── */
  .statusbar { flex: none; height: 26px; display: flex; align-items: center;
           gap: 16px; padding: 0 12px; border-top: 1px solid var(--border);
           background: var(--panel); font: 11px var(--mono); color: var(--dim);
           white-space: nowrap; overflow: hidden; }
  .statusbar .sb-brand { color: var(--amber); font-weight: 700; }
  .statusbar .sb-right { margin-left: auto; display: flex; gap: 14px; }
  .statusbar .run { color: var(--greenb); }
  .statusbar .sb-right .run::before { content: "● "; }
  .statusbar .idle::before { content: "○ "; }

  /* ── 团队模式：运行卡片叙事（v0.5.0）──────────────────────
     Web 补齐旗舰面：与 TUI 的九类卡片同源叙事（解析契约见 lib/runCards.ts，
     分类在服务端做，浏览器只渲染）。风格沿用近黑 zinc + 发丝边 + 等宽。 */
  .rcard { margin: 10px 0 14px; border: 1px solid var(--border);
        border-radius: 4px; background: var(--panel); overflow: hidden; }
  .rchead { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        border-bottom: 1px solid var(--border); font: 11px var(--mono); color: var(--muted); }
  .rchead .rt { color: var(--text); font-weight: 600; }
  .rcbody { padding: 10px 12px; font: 12px/1.7 var(--mono); }
  .rcbody .row { display: flex; gap: 8px; align-items: baseline; }
  .rcbody .k { color: var(--dim); flex: none; }
  .rc-mission { color: var(--text); }
  .rsub { display: flex; gap: 7px; align-items: baseline; padding: 1px 0; }
  .rsub .tid { color: var(--dim); flex: none; min-width: 58px; }
  .rsub .role { color: var(--muted); flex: none; min-width: 84px; }
  .rtag { flex: none; font: 10px var(--mono); padding: 0 5px; border-radius: 2px;
        border: 1px solid var(--border2); color: var(--muted); }
  .rtag.A { color: #7dd3fc; border-color: rgba(125,211,252,.35); }
  .rtag.B { color: var(--greenb); border-color: rgba(16,185,129,.35); }
  .rtag.C { color: #fbbf24; border-color: rgba(251,191,36,.35); }
  .rtag.D { color: #c084fc; border-color: rgba(192,132,252,.35); }
  .rvb { flex: none; font: 10px var(--mono); padding: 0 5px; border-radius: 2px;
        border: 1px solid var(--border2); }
  .rvb.Accept { color: var(--greenb); border-color: rgba(16,185,129,.4); }
  .rvb.Revise { color: #fbbf24; border-color: rgba(251,191,36,.4); }
  .rvb.Reject { color: var(--redb); border-color: rgba(239,68,68,.4); }
  .rvb.Escalate { color: #c084fc; border-color: rgba(192,132,252,.4); }
  .rsteps { display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
        margin-top: 6px; font: 10px var(--mono); color: var(--dim); }
  .rsteps .s { padding: 0 5px; border: 1px solid var(--border2); border-radius: 2px; }
  .rsteps .s.done { color: var(--greenb); border-color: rgba(16,185,129,.4); }
  .rsteps .s .ar { color: var(--dim); margin-left: 4px; }
  .revt { padding: 1px 0; color: var(--muted); }
  .revt .dim { color: var(--dim); }
  .rasset { color: var(--greenb); }
  .revt.nv-info { color: var(--muted); }
  .revt.nv-warn { color: #fbbf24; }
  .revt.nv-err { color: var(--redb); }
  .revt.nv-ok { color: var(--greenb); }
  .raud { display: flex; align-items: center; gap: 10px; padding: 6px 10px;
          border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .raud audio { height: 34px; max-width: 320px; }
  .raud a { text-decoration: none; }
  .rdone { display: flex; gap: 14px; flex-wrap: wrap; padding: 10px 12px;
        border-top: 1px solid var(--border); font: 11px var(--mono); color: var(--muted); }
  .rdone b { color: var(--text); font-weight: 600; }
  /* 侧栏运行列表 + 评分卡 */
  .run { padding: 6px 8px 6px 10px; margin: 1px 0; border-radius: 3px; cursor: pointer;
        position: relative; }
  .run:hover { background: var(--panel2); }
  .run .l1 { display: flex; gap: 6px; align-items: center; font: 11px var(--mono); }
  .run .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; color: var(--muted); }
  .run .l2 { font: 10px var(--mono); color: var(--dim); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
  .run.ok .nm::before { content: "● "; color: var(--greenb); }
  .run.bad .nm::before { content: "◍ "; color: var(--redb); }
  .scgrid { display: grid; grid-template-columns: 1fr auto auto; gap: 4px 12px;
        padding: 10px 12px; font: 11px var(--mono); }
  .scgrid .h { color: var(--dim); }
  .scgrid .n { color: var(--text); }

  /* ── 运行范围复核（org review 的 GUI 面）──────────────────
     「本次运行产出的 harness，哪些沉淀进工具库」的勾选面板。与 keep/drop
     的区别是范围：那两个按名字治理库里已有资产，这里按运行范围复核本次产出。 */
  .rchip { flex: none; margin-left: 8px; background: transparent;
        border: 1px solid var(--border2); color: var(--amber);
        font: 600 10px var(--mono); padding: 4px 7px; border-radius: 3px;
        cursor: pointer; white-space: nowrap; }
  .rchip:hover { border-color: var(--amber); background: var(--raise); }
  .rchip[hidden] { display: none; }
  /* 全局防护：class 定义了 display 的元素携带 hidden 属性时必须真正隐藏
     （.mictx/.schmeta 的 display:flex 曾覆盖 UA 的 [hidden] 样式 → 幽灵浮条 B-20） */
  [hidden] { display: none !important; }
  #reviewScrim { display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.58); z-index: 40; }
  #reviewScrim.on { display: block; }
  #reviewPane { display: none; position: fixed; z-index: 41;
        left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: min(700px, calc(100vw - 28px)); max-height: min(78vh, 660px);
        overflow: auto; background: var(--panel); border: 1px solid var(--border2);
        border-radius: 4px; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
  #reviewPane.on { display: block; }
  .rvhead { padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .rvhead .t { font: 600 12px var(--mono); color: var(--text); }
  .rvhead .s { margin-top: 3px; font: 11px/1.6 var(--mono); color: var(--muted); }
  .rvitem { display: flex; gap: 10px; padding: 10px 14px;
        border-bottom: 1px solid var(--border); cursor: pointer; }
  .rvitem:hover { background: var(--panel2); }
  .rvitem input { flex: none; margin-top: 3px; accent-color: var(--green); }
  .rvitem .nm { font: 600 12px/1.5 var(--mono); color: var(--text); }
  .rvitem .vr { color: var(--dim); font-size: 10px; }
  .rvitem .meta { margin-top: 2px; font: 11px/1.6 var(--mono); color: var(--dim); }
  .rvitem .desc { margin-top: 2px; font: 11px/1.6 var(--sans); color: var(--muted); }
  .rvempty { padding: 16px 14px; font: 11px var(--mono); color: var(--dim); }
  .rvfoot { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
        position: sticky; bottom: 0; background: var(--panel);
        border-top: 1px solid var(--border); }
  .rvfoot .sp { flex: 1; }
  .rvfoot .cnt { font: 11px var(--mono); color: var(--dim); }
  .rvfoot button { background: transparent; border: 1px solid var(--border2);
        color: var(--text); font: 600 11px var(--mono); padding: 7px 11px;
        border-radius: 3px; cursor: pointer; }
  .rvfoot button:hover { background: var(--raise); }
  .rvfoot button.pri { border-color: rgba(16,185,129,.45); color: var(--greenb); }
  .rvfoot button.pri:disabled { opacity: .45; cursor: default; }
  .apitem { padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .apitem .ap1 { display: flex; gap: 8px; align-items: baseline; font: 11px var(--mono); }
  .apitem .ap1 .nm { color: #fbbf24; font-weight: 600; }
  .apitem .ap2 { margin-top: 3px; font: 12px/1.6 var(--sans); color: var(--text); }
  .apitem .ap3 { margin-top: 2px; font: 11px/1.6 var(--mono); color: var(--dim); word-break: break-all; }
  .apacts { display: flex; gap: 8px; margin-top: 8px; }
  .apacts button { background: transparent; border: 1px solid var(--border2); color: var(--text);
        font: 600 11px var(--mono); padding: 5px 10px; border-radius: 3px; cursor: pointer; }
  .apacts button:hover { background: var(--raise); }
  .apacts button.pri { border-color: rgba(16,185,129,.45); color: var(--greenb); }
  .apacts button.danger { border-color: rgba(239,68,68,.45); color: var(--redb); }
  .revt.nv-approval { color: #fbbf24; }
  .rchip-ap { color: #fbbf24; margin-left: 6px; }
  /* ── 模型车道/服务商面板（v0.5.1）────────────────────── */
  #providersScrim { display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.58); z-index: 40; }
  #providersScrim.on { display: block; }
  #providersPane { display: none; position: fixed; z-index: 41;
        left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: min(760px, calc(100vw - 28px)); max-height: min(80vh, 700px);
        overflow: auto; background: var(--panel); border: 1px solid var(--border2);
        border-radius: 4px; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
  #providersPane.on { display: block; }
  .pvhead { padding: 12px 14px; border-bottom: 1px solid var(--border);
        display: flex; align-items: baseline; gap: 10px; }
  .pvhead .t { font: 600 12px var(--mono); color: var(--text); }
  .pvhead .s { font: 11px var(--mono); color: var(--dim); margin-left: auto; }
  .pvsec { padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .pvsec .st { font: 600 11px var(--mono); color: var(--muted); margin-bottom: 6px; }
  .pvrow { display: flex; gap: 8px; align-items: center; padding: 4px 0;
        font: 11px var(--mono); color: var(--text); flex-wrap: wrap; }
  .pvrow .nm { min-width: 96px; font-weight: 600; }
  .pvrow .meta { color: var(--dim); }
  .pvrow .mark { color: var(--greenb); }
  .pvrow .fb { color: var(--amber); }
  .pvacts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .pvacts input[type="text"], .pvacts select {
        background: var(--bg); border: 1px solid var(--border2); color: var(--text);
        font: 11px var(--mono); padding: 6px 8px; border-radius: 3px; }
  .pvacts input.pvkey { width: 240px; }
  .pvacts button { background: transparent; border: 1px solid var(--border2);
        color: var(--text); font: 600 11px var(--mono); padding: 6px 10px;
        border-radius: 3px; cursor: pointer; }
  .pvacts button:hover { background: var(--raise); }
  .pvacts button.pri { border-color: rgba(16,185,129,.45); color: var(--greenb); }
  .pvempty { padding: 8px 0; font: 11px var(--mono); color: var(--dim); }
  .pvtest { margin-top: 6px; font: 11px/1.6 var(--mono); color: var(--muted); word-break: break-all; }
  .pvtest.ok { color: var(--greenb); }
  .pvtest.bad { color: var(--redb); }
  /* ── 任务中心 + 通知中心（v0.5.2）────────────────────────── */
  #tasksScrim, #notifyScrim { display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.58); z-index: 40; }
  #tasksScrim.on, #notifyScrim.on { display: block; }
  #tasksPane, #notifyPane { display: none; position: fixed; z-index: 41;
        left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: min(760px, calc(100vw - 28px)); max-height: min(80vh, 700px);
        overflow: auto; background: var(--panel); border: 1px solid var(--border2);
        border-radius: 4px; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
  #tasksPane.on, #notifyPane.on { display: block; }
  .tkrow { display: flex; gap: 8px; align-items: center; padding: 7px 14px;
        border-bottom: 1px solid var(--border); font: 11px var(--mono);
        flex-wrap: wrap; }
  .tkrow .st { flex: none; width: 22px; text-align: center; }
  .tkrow .st.queued { color: var(--dim); }
  .tkrow .st.running { color: var(--greenb); }
  .tkrow .st.paused { color: #fbbf24; }
  .tkrow .st.done { color: var(--greenb); }
  .tkrow .st.failed, .tkrow .st.cancelled { color: var(--redb); }
  .tkrow .id { color: var(--text); }
  .tkrow .body { color: var(--muted); flex: 1; min-width: 160px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
  .tkrow .acts { display: flex; gap: 5px; margin-left: auto; }
  .tkrow .acts button { background: transparent; border: 1px solid var(--border2);
        color: var(--text); font: 600 10px var(--mono); padding: 3px 7px;
        border-radius: 3px; cursor: pointer; }
  .tkrow .acts button:hover { background: var(--raise); }
  .tkrow .acts button.warn { color: #fbbf24; border-color: rgba(251,191,36,.35); }
  .tkrow .acts button.bad { color: var(--redb); border-color: rgba(239,68,68,.35); }
  .tkform { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 14px;
        border-bottom: 1px solid var(--border); }
  .tkform input[type="text"], .tkform select, .tkform input[type="number"] {
        background: var(--bg); border: 1px solid var(--border2); color: var(--text);
        font: 11px var(--mono); padding: 6px 8px; border-radius: 3px; }
  .tkform .taskinput { flex: 1; min-width: 220px; }
  .tkform button { background: transparent; border: 1px solid rgba(16,185,129,.45);
        color: var(--greenb); font: 600 11px var(--mono); padding: 6px 12px;
        border-radius: 3px; cursor: pointer; }
  .tkform button:hover { background: var(--raise); }
  .ntrow { padding: 8px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .ntrow:hover { background: var(--panel2); }
  .ntrow .l1 { display: flex; gap: 8px; font: 11px var(--mono); color: var(--text); }
  .ntrow .l1 .dot { color: var(--greenb); }
  .ntrow.read .dot { color: var(--dim); }
  .ntrow .l1 .kind { color: var(--dim); }
  .ntrow .l2 { margin-top: 2px; font: 11px/1.5 var(--sans); color: var(--muted); }
  .ntrow.read .l1, .ntrow.read .l2 { opacity: .6; }
  /* ── 记忆面板（v0.5.3）──────────────────────────────── */
  #memoryScrim { display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.58); z-index: 40; }
  #memoryScrim.on { display: block; }
  #memoryPane { display: none; position: fixed; z-index: 41;
        left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: min(680px, calc(100vw - 28px)); max-height: min(78vh, 660px);
        overflow: auto; background: var(--panel); border: 1px solid var(--border2);
        border-radius: 4px; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
  #memoryPane.on { display: block; }
  .mmgrp { padding: 8px 14px 4px; border-bottom: 1px solid var(--border); }
  .mmgrp .gt { font: 600 11px var(--mono); color: var(--greenb); margin-bottom: 4px; }
  .mmrow { display: flex; gap: 8px; align-items: baseline; padding: 3px 0;
        font: 11px/1.6 var(--sans); color: var(--text); }
  .mmrow .ln { flex: none; font: 10px var(--mono); color: var(--dim); width: 28px; }
  .mmrow .tx { flex: 1; min-width: 0; word-break: break-word; }
  .mmrow button { flex: none; background: transparent; border: 1px solid rgba(239,68,68,.3);
        color: var(--redb); font: 600 10px var(--mono); padding: 1px 6px;
        border-radius: 3px; cursor: pointer; }
  .rvsettled { padding: 10px 14px; font: 11px/1.7 var(--mono); color: var(--dim);
        border-bottom: 1px solid var(--border); }

  /* ── 语义检索面板（v0.5.8 · BM25 + RAG）────────────────── */
  #searchScrim { display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.58); z-index: 40; }
  #searchScrim.on { display: block; }
  #searchPane { display: none; position: fixed; z-index: 41;
        left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: min(720px, calc(100vw - 28px)); max-height: min(78vh, 660px);
        display: none; flex-direction: column;
        background: var(--panel); border: 1px solid var(--border2);
        border-radius: 4px; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
  #searchPane.on { display: flex; }
  .schhead { flex: none; padding: 12px 14px 10px; border-bottom: 1px solid var(--border); }
  .schhead .tt { font: 600 12px var(--sans); color: var(--text); }
  .schbar { display: flex; gap: 8px; margin-top: 8px; }
  .schbar input { flex: 1; background: var(--raise); border: 1px solid var(--border2);
        color: var(--text); font: 12px var(--mono); padding: 7px 10px;
        border-radius: 3px; outline: none; }
  .schbar input:focus { border-color: var(--green); }
  .schbar select { flex: none; background: var(--raise); border: 1px solid var(--border2);
        color: var(--muted); font: 11px var(--mono); padding: 7px 6px;
        border-radius: 3px; outline: none; cursor: pointer; }
  .schmeta { margin-top: 6px; font: 10px/1.5 var(--mono); color: var(--dim);
        display: flex; gap: 10px; flex-wrap: wrap; }
  .schmeta .corp { color: var(--muted); }
  .schbody { flex: 1; min-height: 120px; overflow-y: auto; }
  .schrow { padding: 8px 14px; border-bottom: 1px solid var(--border);
        cursor: pointer; transition: background .1s; }
  .schrow:hover { background: var(--raise); }
  .schrow .top { display: flex; gap: 8px; align-items: baseline; }
  .schrow .sc { flex: none; font: 600 10px var(--mono); padding: 1px 6px;
        border-radius: 3px; min-width: 44px; text-align: center; }
  .schrow .sc.hi { color: #34d399; background: rgba(16,185,129,.12); }
  .schrow .sc.md { color: #fbbf24; background: rgba(217,119,6,.12); }
  .schrow .sc.lo { color: var(--muted); background: var(--raise); }
  .schrow .pth { font: 11px var(--mono); color: var(--text);
        word-break: break-all; }
  .schrow:hover .pth { color: var(--greenb); }
  .schrow .snip { margin: 4px 0 0 52px; font: 10px/1.6 var(--mono);
        color: var(--muted); word-break: break-word; }
  .schrow .snip b { color: var(--greenb); font-weight: 600; }
  .schempty { padding: 28px 14px; text-align: center;
        font: 11px/1.8 var(--mono); color: var(--dim); }
  .schfoot { flex: none; padding: 8px 14px; border-top: 1px solid var(--border);
        font: 10px/1.6 var(--mono); color: var(--dim); }
  .schfoot b { color: var(--muted); font-weight: 600; }

  /* v0.5.9：面板关闭钮（检索/音色面板共用） */
  .schclose { flex: none; margin-left: 8px; padding: 2px 9px; border: 1px solid var(--border);
        background: transparent; color: var(--dim); font: 12px/1.4 var(--mono);
        cursor: pointer; border-radius: 4px; }
  .schclose:hover { color: var(--fg); border-color: var(--muted); }

  /* v0.5.9：断连状态条（api 连续失败 ≥3 → 显示；恢复自动消失） */
  #connBar { display: none; flex: none; padding: 5px 14px; gap: 8px; align-items: center;
        background: rgba(217,119,6,.12); border-bottom: 1px solid rgba(217,119,6,.35);
        font: 11px/1.6 var(--mono); color: #d97706; }
  #connBar.on { display: flex; }
  #connBar .dot { width: 8px; height: 8px; border-radius: 50%; background: #d97706;
        animation: connpulse 1.2s ease-in-out infinite; }
  @keyframes connpulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  #connBar .retry { margin-left: auto; padding: 1px 10px; border: 1px solid rgba(217,119,6,.5);
        background: transparent; color: #d97706; font: 10px/1.6 var(--mono); cursor: pointer;
        border-radius: 4px; }
  #connBar .retry:hover { background: rgba(217,119,6,.15); }

  /* v0.5.9：音频工坊面板（8 音色网格 + 试听） */
  #audioPane { display: none; position: fixed; top: 10vh; left: 50%; transform: translateX(-50%);
        width: min(640px, 94vw); max-height: 80vh; z-index: 40;
        background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 18px 60px rgba(0,0,0,.45); flex-direction: column; }
  #audioPane.on { display: flex; }
  #audioPane .schhead { padding: 12px 14px; display: flex; align-items: center;
        border-bottom: 1px solid var(--border); }
  #audioPane .schhead .tt { font: 600 13px/1.4 var(--mono); color: var(--fg); }
  .audbody { flex: 1; overflow-y: auto; padding: 12px 14px; }
  .audgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px; }
  .audcard { padding: 9px 11px; border: 1px solid var(--border); border-radius: 7px;
        cursor: pointer; transition: border-color .12s, background .12s; }
  .audcard:hover { border-color: var(--muted); background: rgba(255,255,255,.025); }
  .audcard.playing { border-color: var(--greenb); background: rgba(16,185,129,.07); }
  .audcard .nm { font: 600 12px/1.5 var(--mono); color: var(--fg); display: flex;
        align-items: center; gap: 6px; }
  .audcard .nm .ic { font-size: 14px; }
  .audcard .ds { margin-top: 2px; font: 10px/1.6 var(--mono); color: var(--dim); }
  .audcard .tg { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
  .audcard .tg span { font: 9px/1.6 var(--mono); padding: 0 6px; border-radius: 3px;
        border: 1px solid var(--border); color: var(--muted); }
  .audctl { flex: none; display: flex; gap: 8px; align-items: center; padding: 10px 14px;
        border-top: 1px solid var(--border); font: 11px/1.6 var(--mono); color: var(--muted); }
  .audctl select { background: var(--bg); color: var(--fg); border: 1px solid var(--border);
        border-radius: 4px; padding: 3px 6px; font: 11px var(--mono); }
  .audctl button { padding: 3px 12px; border: 1px solid var(--border); background: transparent;
        color: var(--muted); font: 11px var(--mono); cursor: pointer; border-radius: 4px; }
  .audctl button:hover { color: var(--fg); border-color: var(--muted); }
  .audctl button.on { color: var(--greenb); border-color: var(--greenb); }
  .audnote { padding: 8px 14px; border-top: 1px solid var(--border);
        font: 10px/1.7 var(--mono); color: var(--dim); }

  /* v0.5.11：派生池面板（预算继承 + 池化重档的观测面 —— 树形 + 连接线） */
  #spawnPane { display: none; position: fixed; top: 8vh; left: 50%; transform: translateX(-50%);
        width: min(780px, 94vw); max-height: 82vh; z-index: 40;
        background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 18px 60px rgba(0,0,0,.45); flex-direction: column; }
  #spawnPane.on { display: flex; }
  #spawnPane .schhead { padding: 12px 14px; display: flex; align-items: center;
        border-bottom: 1px solid var(--border); }
  #spawnPane .schhead .tt { font: 600 13px/1.4 var(--mono); color: var(--fg); }
  .spwstats { flex: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px;
        border-bottom: 1px solid var(--border); }
  .spwstats span { font: 10px/1.6 var(--mono); color: var(--muted);
        padding: 2px 10px; border: 1px solid var(--border); border-radius: 4px; }
  .spwstats b { color: var(--greenb); font-weight: 600; }
  .spwstats span.warnstat b { color: #f59e0b; }
  /* v0.5.13：统计条清理钮（🧹 失败 / 重置池 —— danger 态红沿） */
  .spwstats .spwclean { font: 10px/1.6 var(--mono); color: var(--muted); padding: 2px 10px;
        border: 1px solid var(--border); border-radius: 4px; background: transparent;
        cursor: pointer; transition: border-color .12s, color .12s; margin-left: auto; }
  .spwstats .spwclean:hover { color: #f59e0b; border-color: rgba(245,158,11,.45); }
  .spwstats .spwclean.danger { margin-left: 0; }
  .spwstats .spwclean.danger:hover { color: #ef4444; border-color: rgba(239,68,68,.45); }
  .spwbody { flex: 1; overflow-y: auto; padding: 12px 14px; }
  .spwempty { padding: 28px 14px; text-align: center; font: 11px/1.8 var(--mono); color: var(--dim); }
  /* 树行：depth 缩进 + 左侧连接线（::before 竖线 + ::after 肘弯） */
  .spwrow { position: relative; border: 1px solid var(--border); border-radius: 7px;
        margin: 0 0 6px calc(var(--ind, 0) * 22px); padding: 8px 11px;
        cursor: pointer; transition: border-color .12s, background .12s; background: var(--panel); }
  .spwrow:hover { border-color: var(--muted); background: rgba(255,255,255,.025); }
  .spwrow.open { border-color: var(--greenb); background: rgba(16,185,129,.05); }
  /* v0.5.13：失败行红沿提示 + 行级删除钮（hover 浮现，失败行常显） */
  .spwrow.failrow { border-color: rgba(239,68,68,.3); }
  .spwrow.failrow:hover { border-color: rgba(239,68,68,.5); }
  .spwrow .spwdel { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center;
        justify-content: center; border: 1px solid transparent; background: transparent;
        color: var(--dim); border-radius: 4px; cursor: pointer; font-size: 11px;
        opacity: 0; transition: opacity .12s, border-color .12s, color .12s; }
  .spwrow:hover .spwdel, .spwrow.failrow .spwdel { opacity: 1; }
  .spwdel:hover { color: #ef4444; border-color: rgba(239,68,68,.45); }
  .spwrow .l1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .spwrow .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .spwrow .dot.ok { background: var(--greenb); box-shadow: 0 0 6px rgba(16,185,129,.45); }
  .spwrow .dot.fail { background: #ef4444; }
  .spwrow .dot.legacy { background: var(--muted); }
  .spwrow .gl { flex: 1 1 auto; min-width: 0; font: 600 11.5px/1.5 var(--mono);
        color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .spwrow .bds { flex: none; display: flex; gap: 4px; flex-wrap: wrap; }
  .spwrow .bd { font: 9px/1.6 var(--mono); padding: 0 6px; border-radius: 3px;
        border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .spwrow .bd.run { color: #38bdf8; border-color: rgba(56,189,248,.35); }
  .spwrow .bd.ask { color: #c084fc; border-color: rgba(192,132,252,.35); }
  .spwrow .bd.bud { color: #fbbf24; border-color: rgba(251,191,36,.3); }
  .spwrow .bd.reuse { color: var(--greenb); border-color: rgba(16,185,129,.35); }
  .spwrow .bd.legacy { color: var(--dim); }
  .spwrow .l2 { margin-top: 3px; font: 10px/1.6 var(--mono); color: var(--dim);
        display: flex; gap: 10px; flex-wrap: wrap; }
  .spwrow .l2 .tm { color: var(--dim); }
  .spwrow .l2 .tk { color: var(--muted); }
  /* 展开区：摘要 + 路径 + 用量 */
  .spwdetail { margin-top: 7px; border-top: 1px dashed var(--border); padding-top: 7px; }
  .spwdetail .sm { font: 10px/1.7 var(--mono); color: var(--muted); white-space: pre-wrap;
        word-break: break-word; max-height: 180px; overflow-y: auto; }
  .spwdetail .pth { margin-top: 5px; font: 10px/1.6 var(--mono); color: var(--dim);
        word-break: break-all; }
  .spwdetail .pth b { color: var(--greenb); cursor: pointer; font-weight: 600; }
  .spwdetail .pth b:hover { text-decoration: underline; }
  .spwfoot { flex: none; padding: 8px 14px; border-top: 1px solid var(--border);
        font: 10px/1.7 var(--mono); color: var(--dim); }
  .spwfoot b { color: var(--muted); font-weight: 600; }

  /* v0.5.12：语音入口（🎤 录音转写 + 🔊 朗读 + 🎙 设置面板） */
  #voicePane { display: none; position: fixed; top: 10vh; left: 50%; transform: translateX(-50%);
        width: min(560px, 94vw); max-height: 80vh; z-index: 40;
        background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 18px 60px rgba(0,0,0,.45); flex-direction: column; }
  #voicePane.on { display: flex; }
  #voicePane .schhead { padding: 12px 14px; display: flex; align-items: center;
        border-bottom: 1px solid var(--border); }
  #voicePane .schhead .tt { font: 600 13px/1.4 var(--mono); color: var(--fg); }
  .vobody { flex: 1; overflow-y: auto; padding: 14px; }
  .vosec { margin-bottom: 14px; }
  .vosec .st { font: 600 11px/1.6 var(--mono); color: var(--muted); margin-bottom: 6px; }
  /* 声音网格（7 声音卡片：名字 + 描述 + 选中态） */
  .vogrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
  .vocard { position: relative; padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px;
        cursor: pointer; transition: border-color .12s, background .12s; }
  .vocard:hover { border-color: var(--muted); background: rgba(255,255,255,.025); }
  .vocard.on { border-color: var(--greenb); background: rgba(16,185,129,.07); }
  .vocard .nm { font: 600 11px/1.5 var(--mono); color: var(--fg); }
  .vocard .ds { margin-top: 1px; font: 10px/1.6 var(--mono); color: var(--dim); }
  .vocard.on .ds { color: var(--greenb); }
  /* v0.5.13：声音试听钮（卡片右上角；合成/播放中态互斥） */
  .voaud { position: absolute; top: 5px; right: 5px; padding: 1px 6px; border: 1px solid var(--border);
        background: transparent; color: var(--dim); font: 10px/1.6 var(--mono); cursor: pointer;
        border-radius: 4px; transition: border-color .12s, color .12s; }
  .voaud:hover { color: var(--greenb); border-color: rgba(16,185,129,.4); }
  .voaud.play { color: var(--greenb); border-color: rgba(16,185,129,.55); }
  .voaud.busy { color: var(--amber); border-color: rgba(217,119,6,.55); }
  /* 语速滑条（0.5-2.0 —— 数值实时显示） */
  .vospeed { display: flex; align-items: center; gap: 10px; }
  .vospeed input[type="range"] { flex: 1; accent-color: var(--greenb); height: 4px; }
  .vospeed .val { flex: none; min-width: 62px; text-align: center; font: 600 11px/1.4 var(--mono);
        color: var(--greenb); padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; }
  /* 状态行 + 试听按钮 */
  .vostatus { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
        border: 1px solid var(--border); border-radius: 7px; font: 10.5px/1.6 var(--mono); }
  .vostatus .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .vostatus .dot.ok { background: var(--greenb); box-shadow: 0 0 6px rgba(16,185,129,.45); }
  .vostatus .dot.err { background: #f59e0b; }
  .vostatus .tx { flex: 1; color: var(--muted); word-break: break-all; }
  .vostatus button { flex: none; padding: 3px 12px; border: 1px solid var(--border); background: transparent;
        color: var(--muted); font: 10.5px var(--mono); cursor: pointer; border-radius: 4px; }
  .vostatus button:hover { color: var(--fg); border-color: var(--muted); }
  .vofoot { flex: none; padding: 8px 14px; border-top: 1px solid var(--border);
        font: 10px/1.7 var(--mono); color: var(--dim); }
  .vofoot b { color: var(--muted); font-weight: 600; }
  /* 🎤 录音钮（composer 内，录制中红点脉冲）；📷 图片钮同构（分析中琥珀脉冲） */
  #micBtn, #visBtn { flex: none; width: 30px; height: 30px; display: inline-flex; align-items: center;
        justify-content: center; border: 1px solid var(--border); background: transparent;
        color: var(--muted); border-radius: 6px; cursor: pointer; font-size: 13px;
        transition: border-color .12s, color .12s; }
  #micBtn:hover, #visBtn:hover { color: var(--fg); border-color: var(--muted); }
  #micBtn.rec { color: #ef4444; border-color: rgba(239,68,68,.55);
        animation: micpulse 1.1s ease-in-out infinite; }
  #visBtn.busy { color: var(--amber); border-color: rgba(217,119,6,.55);
        animation: vispulse 1.1s ease-in-out infinite; }
  @keyframes micpulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.35) } 50% { box-shadow: 0 0 0 6px rgba(239,68,68,0) } }
  @keyframes vispulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,119,6,.35) } 50% { box-shadow: 0 0 0 6px rgba(217,119,6,0) } }
  #micBtn:disabled, #visBtn:disabled { opacity: .4; cursor: not-allowed; }
  /* 🔊 朗读钮（t-bot 操作行；合成/播放中态） */
  .saybtn { flex: none; padding: 1px 8px; border: 1px solid var(--border); background: transparent;
        color: var(--dim); font: 10px/1.6 var(--mono); cursor: pointer; border-radius: 4px;
        transition: border-color .12s, color .12s; }
  .saybtn:hover { color: var(--greenb); border-color: rgba(16,185,129,.4); }
  .saybtn.busy { color: var(--muted); cursor: wait; }
  .saybtn.playing { color: var(--greenb); border-color: var(--greenb);
        animation: saywave 1s ease-in-out infinite; }
  @keyframes saywave { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
  /* 转写中浮条（录音结束后 ASR 进行时） */
  .mictx { display: flex; align-items: center; gap: 8px; padding: 4px 12px;
        font: 10px/1.6 var(--mono); color: var(--muted); }
  .mictx .sp { color: var(--greenb); }

  /* v0.5.16：🧰 工具箱 / 🛡 治理与扩展 面板（v0.5.15 遗漏的 display 规则在此补上——
     此前面板无 display:none，页面加载即常显；复用 spawnPane 的模态形态） */
  #toolboxPane, #govexPane { display: none; position: fixed; top: 8vh; left: 50%; transform: translateX(-50%);
        width: min(820px, 94vw); max-height: 82vh; z-index: 40;
        background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 18px 60px rgba(0,0,0,.45); flex-direction: column; }
  #toolboxPane.on, #govexPane.on { display: flex; }
  #toolboxScrim, #govexScrim { display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.5); z-index: 39; }
  #toolboxScrim.on, #govexScrim.on { display: block; }
  #toolboxPane .schhead, #govexPane .schhead { padding: 12px 14px; display: flex; align-items: center;
        flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--border); }
  #toolboxPane .schhead .tt, #govexPane .schhead .tt { font: 600 13px/1.4 var(--mono); color: var(--fg); }
  .tbtabs { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
  .tbtab { padding: 3px 12px; border: 1px solid var(--border); background: transparent;
        color: var(--muted); font: 11px/1.6 var(--mono); cursor: pointer; border-radius: 4px;
        transition: border-color .12s, color .12s; }
  .tbtab:hover { color: var(--fg); border-color: var(--muted); }
  .tbtab.on { color: var(--greenb); border-color: rgba(16,185,129,.55); background: rgba(16,185,129,.07); }
  .tbbody { flex: 1; overflow-y: auto; padding: 12px 14px; }
  .tbsec { margin-bottom: 6px; }
  .tbbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0; }
  .tbbar input[type="text"] { flex: 1 1 160px; min-width: 120px; background: var(--bg); color: var(--fg);
        border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px;
        font: 11px var(--mono); outline: none; }
  .tbbar button { padding: 4px 12px; border: 1px solid var(--border2); background: transparent;
        color: var(--muted); font: 11px/1.6 var(--mono); cursor: pointer; border-radius: 4px; }
  .tbbar button:hover { color: var(--fg); border-color: var(--muted); }
  .tbout { border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; margin: 4px 0 10px;
        max-height: 320px; overflow-y: auto; font: 11px/1.7 var(--mono); }
  .tbmeta { font: 10px/1.7 var(--mono); color: var(--dim); word-break: break-all; }
  .tbsym { padding: 4px 0; border-bottom: 1px dashed var(--border); word-break: break-all; }
  .tbsym:last-child { border-bottom: none; }
  .tbrow { padding: 2px 0; color: var(--muted); word-break: break-all; white-space: pre-wrap; }
  .tbrow.tbhdr { color: var(--text); }

  /* 移动端：侧栏改抽屉（≤720px，issue #13 —— 不再 display:none 直接消失） */
  #backdrop { display: none; position: fixed; inset: 34px 0 0 0;
           background: rgba(0,0,0,.5); z-index: 25; }
  @media (max-width: 720px) {
    #menuBtn { display: inline-flex; align-items: center; justify-content: center; }
    aside { position: fixed; left: 0; top: 34px; bottom: 0; z-index: 30;
           width: min(280px, 84vw); transform: translateX(-102%);
           transition: transform .18s ease; box-shadow: 12px 0 32px rgba(0,0,0,.5); }
    aside.open { transform: translateX(0); }
    .khint { display: none; }
    .chat { padding: 16px 12px 24px; }
    .rchip .rc-label { display: none; }
  }
</style>
</head>
<body>
<header>
  <button id="menuBtn" type="button" aria-label="打开侧栏">≡</button>
  <span class="brand">org</span>
  <span class="ver">v${VERSION}</span>
  <span class="path" id="wsPath"></span>
  <button id="reviewBtn" class="rchip" type="button" hidden
          title="本次运行铸出/合入的 harness 尚未保留 —— 点击选取哪些沉淀进工具库">
    <span class="rc-label">待复核</span> <b id="reviewCount">0</b>
  </button>
  <button id="approvalBtn" class="rchip rchip-ap" type="button" hidden
          title="有等待放行的能力决策 —— 点击处理">
    <span class="rc-label">待批准</span> <b id="approvalCount">0</b>
  </button>
  <button id="providersBtn" class="rchip" type="button" title="模型车道 / 服务商配置面板">
    <span class="rc-label">⚙ 车道</span>
  </button>
  <button id="tasksBtn" class="rchip" type="button" title="长程任务中心（后台队列 · 优先级 · 暂停/恢复）">
    <span class="rc-label">☰ 任务</span>
  </button>
  <button id="schedBtn" class="rchip" type="button" title="定时任务（cron / @every · 到期自动入队）">
    <span class="rc-label">⏰ 定时</span>
  </button>
  <button id="notifyBtn" class="rchip" type="button" title="通知中心（任务完成/失败/取消）">
    <span class="rc-label">🔔</span> <b id="notifyCount" hidden>0</b>
  </button>
  <button id="memoryBtn" class="rchip" type="button" title="专家长期记忆（偏好/约定 · 直连自动注入）">
    <span class="rc-label">🧠 记忆</span>
  </button>
  <button id="searchBtn" class="rchip" type="button" title="语义检索（BM25 · 中英混合）—— 检索工作区语料，点击命中可插入 @引用">
    <span class="rc-label">🔍 检索</span>
  </button>
  <button id="timbreBtn" class="rchip" type="button" title="音频工坊（v0.5.9）— 8 种乐器音色试听 · 7 套和弦进行 · 柱式/琶音；派单作曲任务时在问题里写明音色即可">
    <span class="rc-label">🎵 音色</span>
  </button>
  <button id="spawnBtn" class="rchip" type="button" title="派生池（v0.5.11）— 子生孙递归派生登记 · 预算继承（随深度衰减）· 池化复用（相似 goal 零成本）">
    <span class="rc-label">🌳 派生</span>
  </button>
  <button id="voiceBtn" class="rchip" type="button" title="语音（v0.5.12）— 🎤 录音转写（ASR）· 🔊 回复朗读（TTS · 7 声音 · 语速 0.5-2.0）；凭据缺席时自动降级为文本交互">
    <span class="rc-label">🎙 语音</span>
  </button>
  <button id="toolboxBtn" class="rchip" type="button" title="工具箱（v0.5.15）— 🗄 SQLite 查询 · 🔎 符号跳转 · 🛡 密钥扫描 · 📦 审计导出 · 📋 SBOM · 👥 评审推荐">
    <span class="rc-label">🧰 工具箱</span>
  </button>
  <button id="govexBtn" class="rchip" type="button" title="治理与扩展（v0.5.16+）— 🛡 IaC 扫描 · 🧩 插件 · 🛂 RBAC · 🔌 OpenAPI · 🌐 浏览器快照 · 🩺 查询诊断 · ⌨ 补全/重命名 · 🐞 LSP/DAP 调试 · 🌿 merge/rebase · 👥 团队协作 · ☁ 云生态 · 📱 移动端调试">
    <span class="rc-label">🛡 治理与扩展</span>
  </button>
  <span class="tstats" id="topStats"></span>
</header>
<div id="connBar" role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>
  <span>与服务断开连接（服务器停止或网络中断）· 轮询已降频，恢复后自动重连</span>
  <button class="retry" type="button" onclick="connRetryNow()">立即重试</button>
</div>
<div id="backdrop" aria-hidden="true"></div>
<div id="reviewScrim" aria-hidden="true"></div>
<div id="reviewPane" role="dialog" aria-modal="true" aria-labelledby="rvTitle"></div>
<div id="approvalScrim" aria-hidden="true"></div>
<div id="approvalPane" role="dialog" aria-modal="true" aria-labelledby="apTitle"></div>
<div id="providersScrim" aria-hidden="true"></div>
<div id="providersPane" role="dialog" aria-modal="true" aria-labelledby="pvTitle"></div>
<div id="tasksScrim" aria-hidden="true"></div>
<div id="tasksPane" role="dialog" aria-modal="true" aria-labelledby="tkTitle"></div>
<div id="schedScrim" aria-hidden="true"></div>
<div id="schedPane" role="dialog" aria-modal="true" aria-labelledby="tkTitle"></div>
<div id="notifyScrim" aria-hidden="true"></div>
<div id="notifyPane" role="dialog" aria-modal="true" aria-labelledby="ntTitle"></div>
<div id="memoryScrim" aria-hidden="true"></div>
<div id="memoryPane" role="dialog" aria-modal="true" aria-labelledby="mmTitle"></div>
<div id="searchScrim" aria-hidden="true"></div>
<div id="searchPane" role="dialog" aria-modal="true" aria-labelledby="schTitle">
  <div class="schhead">
    <div class="tt" id="schTitle">🔍 语义检索 — 工作区语料 BM25</div>
    <button class="schclose" type="button" onclick="closeSearch()" title="关闭（Esc）" aria-label="关闭检索面板">✕</button>
    <div class="schbar">
      <input id="schQuery" type="text" placeholder="查询词（中英混合 · 回车检索 · 如「审计 制度」「date format」）" autocomplete="off" aria-label="检索查询">
      <select id="schK" aria-label="命中数">
        <option value="3">top 3</option>
        <option value="5" selected>top 5</option>
        <option value="10">top 10</option>
      </select>
    </div>
    <div class="schmeta" id="schMeta" hidden></div>
  </div>
  <div class="schbody" id="schBody">
    <div class="schempty">输入查询词检索 raw/ registry/ work/ factory/ 语料 ——
点击命中路径可把 <b>@路径</b> 插入问题输入框（检索→引用闭环）。</div>
  </div>
  <div class="schfoot">RAG 注入：问题里写 <b>@?查询词</b> —— 检索命中自动织入模型上下文（org ask / 直连车道）· 语料降级：超限/二进制文件跳过不连坐</div>
</div>
<div id="audioScrim" aria-hidden="true"></div>
<div id="audioPane" role="dialog" aria-modal="true" aria-labelledby="audTitle">
  <div class="schhead">
    <div class="tt" id="audTitle">🎵 音频工坊 — 乐器音色试听</div>
    <button class="schclose" type="button" onclick="closeTimbre()" title="关闭（Esc）" aria-label="关闭音色面板">✕</button>
  </div>
  <div class="audbody">
    <div class="audgrid" id="audGrid"></div>
  </div>
  <div class="audctl">
    <label for="audProg">和弦进行</label>
    <select id="audProg" aria-label="和弦进行">
      <option value="canon" selected>卡农 I-V-vi-iii-IV-I-IV-V</option>
      <option value="pop">流行 I-V-vi-IV</option>
      <option value="epic">史诗 vi-IV-I-V</option>
      <option value="circle">五度圈 I-IV-V-I</option>
      <option value="jazz">爵士 ii-V-I</option>
      <option value="blues">十二小节布鲁斯</option>
      <option value="romance">浪漫 I-vi-IV-V</option>
    </select>
    <button id="audStyle" type="button" title="柱式和弦与琶音滚动切换">琶音</button>
  </div>
  <div class="audnote">作曲任务用法：团队/直连派单时在问题里写明音色与进行，如「用弦乐音色写一段卡农进行」或直连 composer/audio_compose 工具（timbre + chords 参数）。产物 = .wav（开袋即食）+ .mid（可导入 DAW/打谱软件）。</div>
</div>
<div id="spawnScrim" aria-hidden="true"></div>
<div id="spawnPane" role="dialog" aria-modal="true" aria-labelledby="spwTitle">
  <div class="schhead">
    <div class="tt" id="spwTitle">🌳 派生池 — 子生孙递归派生登记</div>
    <button class="schclose" type="button" onclick="closeSpawns()" title="关闭（Esc）" aria-label="关闭派生池面板">✕</button>
  </div>
  <div class="spwstats" id="spwStats"></div>
  <div class="spwbody" id="spwBody">
    <div class="spwempty">尚无派生记录 —— 直连专家经 agent_spawn 工具派生子组织（团队任务 run / 直连 ask），相似 goal 自动池化复用；每次派生登记在此（预算 / 用量 / 复用计数）。</div>
  </div>
  <div class="spwfoot"><b>预算继承</b>：ORG_SPAWN_BUDGET（缺省 100 份）× ORG_SPAWN_DECAY（缺省 0.5）→ 子预算 = floor(父预算 × 衰减率)，随深度指数衰减；深度帽 ORG_SPAWN_MAX（缺省 2）仍是最外层安全线。 <b>池化复用</b>：相似 goal（词面重合 ≥0.6）命中即零成本复用，reuse:false 强制新派生。旧版本派生自动兼容显示（legacy）。</div>

<div id="toolboxScrim" aria-hidden="true"></div>
<div id="toolboxPane" role="dialog" aria-modal="true" aria-labelledby="tbTitle">
  <div class="schhead">
    <div class="tt" id="tbTitle">🧰 工具箱 — 桌面 Agent 操作面（v0.5.15）</div>
    <button class="schclose" type="button" onclick="closeToolbox()" title="关闭（Esc）" aria-label="关闭工具箱面板">✕</button>
    <div class="tbtabs" role="tablist">
      <button class="tbtab on" id="tbTabDb" type="button" role="tab" onclick="tbTab('db')">🗄 数据库</button>
      <button class="tbtab" id="tbTabSym" type="button" role="tab" onclick="tbTab('sym')">🔎 符号</button>
      <button class="tbtab" id="tbTabScan" type="button" role="tab" onclick="tbTab('scan')">🛡 密钥扫描</button>
      <button class="tbtab" id="tbTabGov" type="button" role="tab" onclick="tbTab('gov')">📦 治理件</button>
    </div>
  </div>

  <div class="tbbody">
    <section class="tbsec" id="tbSecDb">
      <div class="tbbar">
        <input id="tbDbFile" type="text" placeholder="SQLite 文件（工作区相对路径，如 data/app.db）" autocomplete="off" aria-label="数据库文件">
        <button type="button" onclick="tbDbSchema()">表结构</button>
      </div>
      <div class="tbbar">
        <input id="tbDbSql" type="text" placeholder="只读查询（单条 SELECT/WITH；写语句走 CLI org db migrate）" autocomplete="off" aria-label="SQL 查询">
        <button type="button" onclick="tbDbQuery()">查询</button>
      </div>
      <div class="tbout" id="tbDbOut"><div class="schempty">🗄 输入工作区内的 .db 路径查看表结构 —— 只读门双层（词法白名单 + readonly 连接），写操作走 org db migrate（CLI）或 db_migrate（工具环，审批在环）。</div></div>
    </section>

    <section class="tbsec" id="tbSecSym" hidden>
      <div class="tbbar">
        <input id="tbSymName" type="text" placeholder="符号名（fn/struct/enum/graph/class/def … HSL/TS/PY）" autocomplete="off" aria-label="符号名">
        <button type="button" onclick="tbSymSearch()">查找定义与引用</button>
      </div>
      <div class="tbout" id="tbSymOut"><div class="schempty">🔎 符号定义 + 引用跳转（file:line）—— 工作区根扫描（runtime/out-* 已排除）；CLI 同款：org symbols &lt;名字&gt; --refs。</div></div>
    </section>

    <section class="tbsec" id="tbSecScan" hidden>
      <div class="tbbar">
        <button type="button" onclick="tbScan()">🛡 扫描工作区（18 类密钥模式）</button>
        <span class="tbmeta" id="tbScanMeta"></span>
      </div>
      <div class="tbout" id="tbScanOut"><div class="schempty">扫描工作区文件中的密钥/敏感信息（OpenAI/Anthropic/GitHub/AWS/Google/私钥/JWT/.env 赋值…）；预览行全脱敏。高危命中建议立即轮换密钥。</div></div>
    </section>

    <section class="tbsec" id="tbSecGov" hidden>
      <div class="tbbar">
        <button type="button" onclick="tbAudit()">📦 导出审计包（zip）</button>
        <button type="button" onclick="tbSbom()">📋 生成 SBOM（SPDX-2.3）</button>
        <button type="button" onclick="tbOwners()">👥 评审推荐</button>
      </div>
      <div class="tbout" id="tbGovOut"><div class="schempty">治理三件套：审计导出（events/journal/审批台账/LLM 台账 → 零依赖 zip + 摘要）· SBOM（org + 运行时依赖 + vendored 组件清单）· 评审人推荐（.org/CODEOWNERS 规则）。</div></div>
    </section>
  </div>

  <div class="spwfoot">工具箱与 CLI / 工具环同源（lib/db · symbols · scan · audit · sbom · owners 单一实现三端消费）—— 「每个功能都有对应操作页面」的 v0.5.15 落地。</div>
</div>
</div>
<div id="govexScrim" aria-hidden="true"></div>
<div id="govexPane" role="dialog" aria-modal="true" aria-labelledby="gxTitle">
  <div class="schhead">
    <div class="tt" id="gxTitle">🛡 治理与扩展 — IaC · 插件 · RBAC · OpenAPI · 浏览器 · 诊断 · 补全/重命名 · git · 👥 协作 · ☁ 云生态 · 📱 移动端（v0.5.16+）</div>
    <button class="schclose" type="button" onclick="closeGovex()" title="关闭（Esc）" aria-label="关闭治理与扩展面板">✕</button>
    <div class="tbtabs" role="tablist">
      <button class="tbtab on" id="gxTabIac" type="button" role="tab" onclick="gxTab('iac')">🛡 IaC</button>
      <button class="tbtab" id="gxTabPlug" type="button" role="tab" onclick="gxTab('plug')">🧩 插件</button>
      <button class="tbtab" id="gxTabRbac" type="button" role="tab" onclick="gxTab('rbac')">🛂 RBAC</button>
      <button class="tbtab" id="gxTabOapi" type="button" role="tab" onclick="gxTab('oapi')">🔌 OpenAPI</button>
      <button class="tbtab" id="gxTabWeb" type="button" role="tab" onclick="gxTab('web')">🌐 浏览器</button>
      <button class="tbtab" id="gxTabDbd" type="button" role="tab" onclick="gxTab('dbd')">🩺 诊断</button>
      <button class="tbtab" id="gxTabCode" type="button" role="tab" onclick="gxTab('code')">⌨ 补全/重命名</button>
      <button class="tbtab" id="gxTabLsp" type="button" role="tab" onclick="gxTab('lsp')">🐞 LSP/DAP</button>
      <button class="tbtab" id="gxTabGit" type="button" role="tab" onclick="gxTab('git')">🌿 git</button>
      <button class="tbtab" id="gxTabCollab" type="button" role="tab" onclick="gxTab('collab')">👥 协作</button>
      <button class="tbtab" id="gxTabCloud" type="button" role="tab" onclick="gxTab('cloud')">☁ 云生态</button>
      <button class="tbtab" id="gxTabMobile" type="button" role="tab" onclick="gxTab('mobile')">📱 移动端</button>
    </div>
  </div>

  <div class="tbbody">
    <section class="tbsec" id="gxSecIac">
      <div class="tbbar">
        <button type="button" onclick="gxIac()">🛡 扫描工作区（16 条 IaC 规则）</button>
        <span class="tbmeta" id="gxIacMeta"></span>
      </div>
      <div class="tbout" id="gxIacOut"><div class="schempty">Dockerfile / docker-compose / .tf 的静态安全扫描（root 用户 · 特权容器 · docker.sock 挂载 · 0.0.0.0 ingress · 硬编码密钥 · :latest …）；CLI 同款 org iacscan。</div></div>
    </section>

    <section class="tbsec" id="gxSecPlug" hidden>
      <div class="tbbar">
        <input id="gxPlugSrc" type="text" placeholder="安装源（工作区内插件目录 或 git URL）" autocomplete="off" aria-label="插件安装源">
        <button type="button" onclick="gxPlugInstall()">安装</button>
        <button type="button" onclick="gxPlugList()">刷新清单</button>
      </div>
      <div class="tbout" id="gxPlugOut"><div class="schempty">插件市场（#132）：事务性安装（staging → 校验 → 原子 rename）· 只装不执行（permissions 与 RBAC 命名空间联动，执行面是路线图）。CLI 同款 org plugin list/install/remove。</div></div>
    </section>

    <section class="tbsec" id="gxSecRbac" hidden>
      <div class="tbbar">
        <button type="button" onclick="gxRbac()">查看角色与规则</button>
        <span class="tbmeta">.org/rbac.json（缺席 = 单机 owner 兜底）</span>
      </div>
      <div class="tbout" id="gxRbacOut"><div class="schempty">RBAC 角色权限（#149）：判定次序 = 未知角色拒 → deny 命中拒（优先）→ allow 命中放 → 默认拒。工具环启用：ORG_RBAC_ROLE=&lt;角色&gt; 启动（未设 = 门控完全不启用）；拒绝落审计（rbac_denied 事件 + runtime/rbac.jsonl）。CLI 同款 org rbac list/check。</div></div>
    </section>

    <section class="tbsec" id="gxSecOapi" hidden>
      <div class="tbbar">
        <input id="gxOapiFile" type="text" placeholder="spec 文件（工作区相对路径，JSON）" autocomplete="off" aria-label="OpenAPI 文件">
        <button type="button" onclick="gxOapi(false)">解析文件</button>
      </div>
      <div class="tbbar">
        <input id="gxOapiText" type="text" placeholder="或粘贴 OpenAPI/Swagger JSON（3.x / 2.0）" autocomplete="off" aria-label="OpenAPI 文本">
        <button type="button" onclick="gxOapi(true)">解析文本</button>
      </div>
      <div class="tbout" id="gxOapiOut"><div class="schempty">OpenAPI 解析（#134）：操作清单（method/path/参数/security）+ suggestToolName 工具命名建议；YAML 请先转 JSON（错误信息附指引）。CLI 同款 org openapi。</div></div>
    </section>

    <section class="tbsec" id="gxSecWeb" hidden>
      <div class="tbbar">
        <input id="gxWebUrl" type="text" placeholder="页面 URL（http/https）" autocomplete="off" aria-label="页面 URL">
        <button type="button" onclick="gxWebSnapshot()">🌐 快照</button>
        <button type="button" onclick="gxWebScreenshot()">📸 截图</button>
      </div>
      <div class="tbout" id="gxWebOut"><div class="schempty">浏览器入口（#116/#30）：多引擎降级链 agent-browser → chromium → chrome；快照 = 标题/正文/链接/图片清单，截图 = PNG 落工作区；console/网络面板是路线图（诚实边界）。CLI 同款 org browser snapshot/screenshot。</div></div>
    </section>

    <section class="tbsec" id="gxSecDbd" hidden>
      <div class="tbbar">
        <input id="gxDbdFile" type="text" placeholder="SQLite 文件（工作区相对）或 :memory:" autocomplete="off" aria-label="数据库文件">
        <input id="gxDbdSql" type="text" placeholder="SELECT …（单条语句）" autocomplete="off" aria-label="待诊断 SQL">
        <button type="button" onclick="gxDbdiag()">🩺 诊断</button>
      </div>
      <div class="tbout" id="gxDbdOut"><div class="schempty">查询诊断（#113）：EXPLAIN QUERY PLAN → 计划解析（索引命中 🔑 / 全表扫描 ⚠ / 涉及表）+ 调优建议。:memory: 瞬态通道不碰盘。CLI 同款 org dbdiag。</div></div>
    </section>

    <section class="tbsec" id="gxSecCode" hidden>
      <div class="tbbar">
        <input id="gxCplFile" type="text" placeholder="文件（工作区相对，.hsl/.ts/.py）" autocomplete="off" aria-label="补全文件">
        <input id="gxCplLine" type="text" placeholder="行号（1 基）" autocomplete="off" aria-label="行号" style="max-width:90px">
        <input id="gxCplCol" type="text" placeholder="列（1 基）" autocomplete="off" aria-label="列" style="max-width:80px">
        <button type="button" onclick="gxComplete()">⌨ 补全</button>
      </div>
      <div class="tbout" id="gxCplOut" style="margin-bottom:10px"><div class="schempty">代码补全（#32）：三级候选（同文件符号 &gt; 项目符号 &gt; 语言关键字）；空候选附原因（成员补全是 LSP 路线图）。CLI 同款 org complete。</div></div>
      <div class="tbbar">
        <input id="gxRnOld" type="text" placeholder="旧符号名" autocomplete="off" aria-label="旧名">
        <input id="gxRnNew" type="text" placeholder="新名" autocomplete="off" aria-label="新名">
        <label class="tbmeta" style="display:flex;align-items:center;gap:4px"><input id="gxRnApply" type="checkbox"> 真写</label>
        <button type="button" onclick="gxRename()">✏️ 重命名</button>
      </div>
      <div class="tbout" id="gxRnOut"><div class="schempty">项目级重命名（#56）：缺省 dryRun 预览（unified diff ≤5 文件）；勾选「真写」后落盘（行级词边界替换，失败即停）。CLI 同款 org rename [--apply]。</div></div>
    </section>

    <section class="tbsec" id="gxSecLsp" hidden>
      <div class="tbbar">
        <input id="gxLspName" type="text" placeholder="符号名（如 startRun / compute）" autocomplete="off" aria-label="符号名">
        <button type="button" onclick="gxLspDef()">🎯 定义</button>
        <button type="button" onclick="gxLspRefs()">🔗 引用</button>
        <button type="button" onclick="gxLspHover()">💬 hover</button>
      </div>
      <div class="tbout" id="gxLspOut" style="margin-bottom:10px"><div class="schempty">LSP/DAP 协议集成（#26）：JSON-RPC 2.0 分帧（LSP 与 DAP 共用）+ 内置符号索引车道（definition/references/hover —— 无外部 server 时的主车道，输出 LSP 0 基 uri/range + 人读 1 基双形）。CLI 同款 org lsp definition/references/hover。</div></div>
      <div class="tbbar">
        <button type="button" onclick="gxLspServers()">🔎 探测外部 server</button>
        <button type="button" onclick="gxLspProto()">🧪 协议层自检</button>
        <button type="button" onclick="gxDebugDap()">🧪 DAP 自检</button>
        <span class="tbmeta">servers 缺席 = 诚实降级到内置车道</span>
      </div>
      <div class="tbout" id="gxLspSrvOut" style="margin-bottom:10px"><div class="schempty">外部车道：typescript-language-server / pylsp / gopls / rust-analyzer / clangd … which 探测；spawn 车道（initialize → initialized → shutdown → exit）在 lib/lsp.ts。</div></div>
      <div class="tbbar">
        <input id="gxDbgFile" type="text" placeholder="文件（工作区相对，.hsl/.ts/.py）" autocomplete="off" aria-label="断点建议文件">
        <button type="button" onclick="gxDebugSuggest()">🐞 断点建议</button>
        <button type="button" onclick="gxDebugPlan()">📋 调试计划</button>
      </div>
      <div class="tbout" id="gxDbgOut"><div class="schempty">断点/调试建议（#108）：入口/分支/循环/return 前断点建议（符号级 &gt; 启发式级，每条带 reason）+ 调试计划（步骤 + DAP 协议就绪消息序列）。真 debug adapter attach 是路线图（诚实边界）。CLI 同款 org debug suggest/plan。</div></div>
    </section>

    <section class="tbsec" id="gxSecGit" hidden>
      <div class="tbbar">
        <button type="button" onclick="gxGitState()">🌿 状态探测</button>
        <input id="gxGitSrc" type="text" placeholder="merge 源分支 / rebase 目标分支" autocomplete="off" aria-label="git 分支">
        <button type="button" onclick="gxGitMerge()">merge</button>
        <button type="button" onclick="gxGitRebase()">rebase</button>
      </div>
      <div class="tbout" id="gxGitOut"><div class="schempty">merge / rebase 安全操作（#80）：冲突绝不自动解决 —— 冲突即自动 abort 回滚 + 冲突清单。CLI 同款 org merge / org rebase / org mergestate。</div></div>
    </section>

    <section class="tbsec" id="gxSecCollab" hidden>
      <div class="tbbar">
        <span class="tbmeta" id="gxCollabWho">身份：…</span>
        <input id="gxCollabUser" type="text" placeholder="切换用户 id（如 alice）" autocomplete="off" aria-label="协作用户 id" style="max-width:170px">
        <button type="button" onclick="gxCollabSetUser()">👤 切换</button>
        <button type="button" onclick="gxCollabLoad()">👥 刷新</button>
      </div>
      <div class="tbbar">
        <input id="gxCollabThread" type="text" placeholder="线程 id（如 t1 —— 小写/数字/连字符）" autocomplete="off" aria-label="线程 id" style="max-width:200px">
        <input id="gxCollabText" type="text" placeholder="发帖文本（@user 自动提及）" autocomplete="off" aria-label="发帖文本">
        <button type="button" onclick="gxCollabPost()">💬 发帖</button>
      </div>
      <div class="tbbar">
        <input id="gxCollabSeq" type="text" placeholder="楼层 #" autocomplete="off" aria-label="评论目标楼层" style="max-width:80px">
        <input id="gxCollabCommentText" type="text" placeholder="评论文本（挂 replyTo 树）" autocomplete="off" aria-label="评论文本">
        <button type="button" onclick="gxCollabComment()">↳ 评论</button>
      </div>
      <div class="tbbar">
        <input id="gxCollabBridgeExpert" type="text" placeholder="桥：专家名（如 notice-parser）" autocomplete="off" aria-label="桥专家" style="max-width:190px">
        <button type="button" onclick="gxCollabBridge()">🌉 会话账本镜像成线程</button>
        <span class="tbmeta">单用户账本 → 团队可见（只镜像不改写，幂等）</span>
      </div>
      <div class="tbout" id="gxCollabOut"><div class="schempty">👥 团队协作（#87）：append-only JSONL 团队线程（runtime/collab/threads）· 回复树（replyTo 缩进）· @mention 自动抽取 · 会话账本桥。CLI 同款 org collab。诚实边界：本地文件协议，多进程强并发不在面内。</div></div>
    </section>
    <section class="tbsec" id="gxSecCloud" hidden>
      <div class="tbbar">
        <button type="button" onclick="gxCloudProbe()">☁ 全景探测</button>
        <button type="button" onclick="gxCloudOverview()">21 模型商 + 10 云 CLI 全景</button>
        <span class="tbmeta" id="gxCloudMeta"></span>
      </div>
      <div class="tbout" id="gxCloudOut" style="margin-bottom:10px"><div class="schempty">云生态探测（#67/#68/#72/#74）：docker（CLI + 守护进程）· ssh · kubectl（CLI + 集群）· terraform · 10 家云 CLI —— 缺席即诚实降级（绿 ✓ 在场 / 灰 ⬜ 缺席，悬停看安装指引），模板车道始终可用。CLI 同款 org cloud probe。</div></div>
      <div class="tbbar">
        <select id="gxCldDfType" aria-label="Dockerfile 型" style="max-width:120px">
          <option value="node">node</option><option value="bun">bun</option><option value="python">python</option><option value="rust">rust</option>
        </select>
        <button type="button" onclick="gxCloudTemplate('dockerfile')">🐳 Dockerfile</button>
        <button type="button" onclick="gxCloudTemplate('compose')">compose</button>
        <select id="gxCldManifestKind" aria-label="K8s manifest 族" style="max-width:130px">
          <option value="deployment">deployment</option><option value="service">service</option><option value="ingress">ingress</option><option value="configmap">configmap</option><option value="pvc">pvc</option>
        </select>
        <button type="button" onclick="gxCloudTemplate('manifest')">☸ manifest</button>
        <button type="button" onclick="gxCloudTemplate('terraform')">🏗 terraform</button>
        <button type="button" onclick="gxCloudTemplate('ssh-template')">🔐 ssh-config</button>
        <select id="gxCldPlanIntent" aria-label="docker 计划意图" style="max-width:120px">
          <option value="build">plan: build</option><option value="run">plan: run</option><option value="push">plan: push</option><option value="debug">plan: debug</option><option value="cleanup">plan: cleanup</option>
        </select>
        <button type="button" onclick="gxCloudTemplate('plan')">📋 命令计划</button>
      </div>
      <div class="tbbar">
        <button type="button" onclick="gxCloudCopy()">📋 复制模板</button>
        <span class="tbmeta" id="gxCloudTplMeta">模板车道（无 docker/kubectl/ssh 环境的主交付）：多阶段 · 非 root · healthcheck · 资源限额/探针/亲和性</span>
      </div>
      <div class="tbout" id="gxCloudTplOut" style="max-height:300px"><div class="schempty">生成 Dockerfile / compose / K8s manifest / terraform / ssh-config 模板 —— 可直接粘贴（复制按钮）或落盘后经执行车道应用。</div></div>
      <div class="tbbar">
        <input id="gxCldDockerArgs" type="text" placeholder="docker args（空格分隔，如：ps -a）" autocomplete="off" aria-label="docker 参数" style="max-width:260px">
        <button type="button" onclick="gxCloudRun('docker')">🐳 执行</button>
        <input id="gxCldSshHost" type="text" placeholder="ssh host（须在 ssh-hosts.allow）" autocomplete="off" aria-label="ssh host" style="max-width:180px">
        <input id="gxCldSshCmd" type="text" placeholder="远程命令" autocomplete="off" aria-label="ssh 命令" style="max-width:200px">
        <button type="button" onclick="gxCloudRun('ssh')">🔐 执行</button>
        <input id="gxCldK8sArgs" type="text" placeholder="kubectl args（如：get pods -n prod）" autocomplete="off" aria-label="kubectl 参数" style="max-width:260px">
        <button type="button" onclick="gxCloudRun('k8s')">☸ 执行</button>
      </div>
      <div class="tbout" id="gxCloudRunOut"><div class="schempty">执行车道：docker/kubectl 子命令白名单（破坏性命令一律拒绝，拒绝先于 spawn）· ssh host 门控（ssh-hosts.allow）· 数组参数零 shell 面 · 路径过工作区监狱。CLI 同款 org cloud docker/ssh/k8s。</div></div>
    </section>

    <section class="tbsec" id="gxSecMobile" hidden>
      <div class="tbbar">
        <button type="button" onclick="gxMobileProbe()">📱 工具链探测</button>
        <button type="button" onclick="gxMobileDevices()">📲 设备清单</button>
        <button type="button" onclick="gxMobileSelftest()">🧪 自检</button>
        <span class="tbmeta" id="gxMobileMeta"></span>
      </div>
      <div class="tbout" id="gxMobileOut" style="margin-bottom:10px"><div class="schempty">移动端调试（#117）：Android/iOS/跨端三面探测（adb/aapt/scrcpy/idevice/flutter，缺席诚实降级）· 设备清单（adb devices -l 解析 · 未授权/offline 是诚实状态非失败 + iOS 面 UDID）。CLI 同款 org mobile probe/devices。</div></div>
      <div class="tbbar">
        <input id="gxMobTag" type="text" placeholder="tag（如 chromium/AndroidRuntime）" autocomplete="off" aria-label="logcat tag" style="max-width:190px">
        <input id="gxMobLines" type="text" placeholder="行数（帽 2000）" autocomplete="off" aria-label="logcat 行数" style="max-width:90px">
        <button type="button" onclick="gxMobileLogcat()">📜 logcat dump</button>
        <span class="tbmeta">-d 快照（非尾随）· 五元组（时间/进程/级别/tag/消息）</span>
      </div>
      <div class="tbout" id="gxMobLogcatOut" style="margin-bottom:10px"><div class="schempty">logcat dump：adb logcat -d -t N 快照 + 五元组结构化（时间/进程/级别/tag/消息）· tag 过滤（-s TAG）· 行数钳 1..2000。无 adb/无设备 → 诚实降级 + 指引。CLI 同款 org mobile logcat。</div></div>
      <div class="tbbar">
        <select id="gxMobPlat" aria-label="计划平台" style="max-width:110px">
          <option value="android">android</option><option value="ios">ios</option><option value="both">both</option>
        </select>
        <select id="gxMobSym" aria-label="症状" style="max-width:130px">
          <option value="crash">crash 崩溃</option><option value="白屏">白屏</option><option value="network">network 网络</option><option value="卡顿">performance 卡顿</option><option value="build">build 构建</option><option value="装不上">install 安装</option><option value="webview">webview</option>
        </select>
        <button type="button" onclick="gxMobilePlan()">📋 调试计划</button>
        <span class="tbmeta">纯函数保底（零外部依赖永远可用）</span>
      </div>
      <div class="tbout" id="gxMobPlanOut" style="max-height:320px"><div class="schempty">调试计划：平台 × 症状矩阵 → 步骤化计划（每步 = 可粘贴命令 + 预期 + 降级指引）。工具缺席环境的主交付 —— 无 adb/无真机也永远可用。CLI 同款 org mobile plan。</div></div>
    </section>
  </div>

  <div class="spwfoot">治理与扩展面板与 CLI / 工具环同源（lib/dbdiag · gitmerge · rbac · iacscan · plugins · openapi · browser · completion · rename · lsp · debug · collab · cloud · mobile 单一实现三端消费）—— v0.5.16 「每个功能都有对应操作页面」的延续。</div>
</div>
<div id="voiceScrim" aria-hidden="true"></div>
<div id="voicePane" role="dialog" aria-modal="true" aria-labelledby="voTitle">
  <div class="schhead">
    <div class="tt" id="voTitle">🎙 语音 — 转写 · 朗读 · 声音设置</div>
    <button class="schclose" type="button" onclick="closeVoice()" title="关闭（Esc）" aria-label="关闭语音面板">✕</button>
  </div>
  <div class="vobody">
    <div class="vosec">
      <div class="st">服务状态</div>
      <div class="vostatus">
        <span class="dot" id="voDot"></span>
        <span class="tx" id="voStatusTx">探测中…</span>
        <button type="button" id="voProbe" title="重新探测语音服务">重新探测</button>
      </div>
    </div>
    <div class="vosec">
      <div class="st">朗读声音（TTS）</div>
      <div class="vogrid" id="voGrid"></div>
    </div>
    <div class="vosec">
      <div class="st">语速</div>
      <div class="vospeed">
        <input id="voSpeed" type="range" min="0.5" max="2" step="0.05" value="1" aria-label="朗读语速">
        <span class="val" id="voSpeedVal">×1.00</span>
      </div>
    </div>
  </div>
  <div class="vofoot"><b>🎤 录音转写</b>：输入框左侧麦克风按钮 → 说话 → 再点结束 → 转写文本进输入框（ASR）。<b>🔊 朗读</b>：每条回复操作行的喇叭按钮（TTS · 超长自动分段拼接 · 4K 字截断诚实标注）。同文本同参数命中缓存（零重复计费）。</div>
</div>
<div class="app">
  <aside>
    <button class="newbtn" id="newSession" type="button">+ 新会话</button>
    <input id="sessSearch" type="text" placeholder="搜索会话（id / 预览）…" autocomplete="off" aria-label="搜索会话">
    <div class="sec">sessions<span class="cnt" id="sessCount"></span></div>
    <div class="list" id="sessions"></div>
    <div class="sec">experts<span class="cnt" id="expertCount"></span></div>
    <div class="list" id="experts"></div>
    <div class="sec">runs<span class="cnt" id="runCount"></span></div>
    <div class="list" id="runs"></div>
    <div class="sec">评分卡</div>
    <div class="list"><div class="run" id="scoreBtn" title="查看最近一次运行的评分卡"><div class="l1"><span class="nm">查看评分卡（证据归因）</span></div></div></div>
    <div class="list"><div class="run" id="costBtn" title="逐次模型调用：轨道 · 字符 · 耗时 · tokens"><div class="l1"><span class="nm">查看用量 / 成本时间线</span></div></div></div>
  </aside>
  <main>
    <div class="thead">
      <span class="crumb" id="crumb">org · direct harness</span>
      <button class="ghost" id="exportBtn" type="button" title="导出当前会话为 Markdown">导出 .md</button>
    </div>
    <div class="chatwrap" id="chatWrap">
      <div class="chat" id="chat"></div>
      <button id="jumpBtn" type="button">回到最新 ↓</button>
    </div>
    <div class="composer">
      <div class="cbox">
        <button id="micBtn" type="button" title="语音输入（v0.5.12）— 点击开始录音，再点结束并转写进输入框（ASR）" aria-label="语音输入">🎤</button>
        <button id="visBtn" type="button" title="图片分析（v0.5.13）— 选择图片，VLM 描述内容并追加进输入框" aria-label="图片分析">📷</button>
        <input type="file" id="visFile" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple hidden>
        <span class="ps" aria-hidden="true">❯</span>
        <textarea id="question" rows="1"
          placeholder="输入问题，enter 发送 · shift+enter 换行 · esc 停止"></textarea>
      </div>
      <div class="mictx" id="micTx" hidden><span class="sp">⠋</span><span id="micTxText">转写中…</span></div>
      <div class="mictx" id="visTx" hidden><span class="sp">⠋</span><span id="visTxText">分析中…</span></div>
      <div class="crow">
        <div class="seg" id="modeSeg" role="radiogroup" aria-label="派单模式">
          <button type="button" data-mode="team" class="on">团队</button>
          <button type="button" data-mode="direct">直连</button>
        </div>
        <div class="seg" id="modelSeg" role="radiogroup" aria-label="模型选择">
          <button type="button" data-model="scripted" class="on">scripted</button>
          <button type="button" data-model="deepseek">deepseek</button>
        </div>
        <span class="khint">⌘K 新会话 · / 聚焦</span>
        <button id="send" type="button">发送</button>
      </div>
    </div>
    <footer class="statusbar" id="statusbar"></footer>
    <div id="hintline" class="hintline" role="status" aria-live="polite"></div>
  </main>
</div>
<script>
var VER = "${VERSION}";
var renderMd = ${renderMd.toString()};
var state = {
  experts: [], usages: [], currentExpert: null, currentSession: null,
  model: "scripted", running: false, myRunStarted: false, ticketId: 0,
  lastQuestion: "", turns: [], atBottom: true,
  // v0.5.0：派单模式。team = 监督回路（org run 的 Web 面，必需旗舰叙事）；
  // direct = 单专家直连（原行为）。缺省 team，与 TUI 的缺省输入模式一致。
  mode: "team"
};
var lastSessions = [];
var sessFilter = "";
var editId = null, editDraft = "", editErr = false, confirmId = null;
var SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
var spinIdx = 0, spinTimer = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
// v0.5.9：断连优雅降级 —— 连续失败 ≥3 显示状态条 + 轮询降频（每 2 次跳 1 次），
// 恢复自动消失。此前的行为是控制台「Failed to fetch」刷屏（跨轮会话累积噪音）。
var connFail = 0;
var connLost = false;
function connSetLost(v) {
  if (v === connLost) return;
  connLost = v;
  document.getElementById("connBar").classList.toggle("on", v);
}
function connRetryNow() {
  connFail = 0;
  connSetLost(false);
  notifyBadgeRefresh();
  approvalChipRefresh();
  loadRuns();
}
/** 断连时轮询闸门：降频一半（调用处 setInterval 内统一过闸）。 */
function connGate(tick) {
  return !connLost || tick % 2 === 0;
}
var connTick = 0;
function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    connFail = 0;
    connSetLost(false);
    return r.json();
  }).catch(function (e) {
    connFail++;
    if (connFail >= 3) connSetLost(true); // 偶发单次失败不扰动，连续才断言
    throw e;
  });
}
function relTime(iso) {
  var d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return (d / 60 | 0) + " 分钟前";
  if (d < 86400) return (d / 3600 | 0) + " 小时前";
  return (d / 86400 | 0) + " 天前";
}
// [ctx] 行 → 细计量条（emerald，极小占比保底 1.2% 可见宽）
function meterHtml(ctxLine) {
  // v0.4.12 修复：used 侧 ≥1000 tokens 时 CLI 打印 "8.4k/131.1k"（fmt_k 加 k 后缀），
  // 此前 /(\\d+)\\// 只认纯数字 → 长会话的计量条永远失配降级纯文本。
  var m = /([\\d.]+)k?\\/([\\d.]+)k/.exec(ctxLine || "");
  var p = /([\\d.]+)%/.exec(ctxLine || "");
  if (!m) return esc(ctxLine || "");
  var pct = p ? Math.max(1.2, Math.min(100, parseFloat(p[1]))) : 1.2;
  var txt = m[0];
  return '<span class="meter" aria-hidden="true"><i style="width:' + pct +
    '%"></i></span><span>ctx ' + esc(txt) + '</span>';
}

// ---- 顶栏 / 状态栏 / 面包屑 ----

function renderTop() {
  var turns = 0, billed = 0;
  state.usages.forEach(function (u) { turns += u.turns; billed += u.billed; });
  document.getElementById("topStats").textContent =
    "experts " + state.experts.length + " · sessions " + state.usages.length +
    " · " + turns + " turns · " + billed + " tok";
  document.getElementById("expertCount").textContent =
    state.experts.length ? String(state.experts.length) : "";
}
function renderStatusbar() {
  var el = document.getElementById("statusbar");
  var run = state.running
    ? '<span class="run">running</span>'
    : '<span class="idle">idle</span>';
  el.innerHTML = '<span class="sb-brand">org</span>' +
    '<span>' + (state.mode === "team" ? "团队" : "直连") + '</span>' +
    '<span>expert ' + esc(state.currentExpert || "—") + '</span>' +
    '<span>model ' + esc(state.model) + '</span>' +
    '<span>session ' + esc(state.currentSession || "(new)") + '</span>' +
    '<span class="sb-right">' + run + '</span>';
}
function renderCrumb() {
  var ex = state.experts.filter(function (e) { return e.name === state.currentExpert; })[0];
  var c = (ex ? ex.name + " @" + ex.version : "direct harness") +
    (state.currentSession ? " · " + state.currentSession : "");
  document.getElementById("crumb").textContent = c;
}

// ---- 侧栏渲染 ----

function renderExperts() {
  var el = document.getElementById("experts");
  el.innerHTML = state.experts.map(function (e) {
    var bdg = e.source === "import"
      ? '<span class="bdg import">import</span>'
      : (e.retained ? '<span class="bdg">★</span>' : '<span class="bdg">○</span>');
    var title = e.source === "import" ? "用户导入（入库即保留）"
      : (e.retained ? "保留（B 路径自动复用）" : "候选（未保留）");
    // 工具库治理（v0.4.12）：★/○ 切换钮（hover 浮现，与消息级操作同交互形态）。
    // 导入专家免切换（导入即保留是既有语义）；运行中禁用（派单寻址变更需空闲态）。
    var act = e.source === "import" ? "" :
      '<span class="acts"><button class="ic" data-retain="' + (e.retained ? "drop" : "keep") +
      '" title="' + (e.retained ? "取消保留（退出 B 路径自动复用）" : "选取保留（候选转正，git 留痕）") + '">' +
      (e.retained ? "○ drop" : "★ keep") + '</button></span>';
    return '<div class="exp' + (state.currentExpert === e.name ? " active" : "") +
      '" data-name="' + esc(e.name) + '" title="' + esc(title + " · " + e.description) + '">' +
      '<div class="l1"><span class="nm">' + esc(e.name) + '</span>' +
      '<span class="vr">@' + esc(e.version) + '</span>' + bdg + act + '</div>' +
      '<div class="l2">' + esc(e.description) + '</div></div>';
  }).join("") || '<div class="l2" style="padding:4px 8px">注册表为空</div>';
  Array.prototype.forEach.call(el.querySelectorAll(".exp"), function (node) {
    node.onclick = function () {
      if (state.running) return;
      selectExpert(node.dataset.name);
      closeDrawer();
    };
  });
  // 保留切换：stopPropagation 避免触发卡片选中
  Array.prototype.forEach.call(el.querySelectorAll(".exp button[data-retain]"), function (btn) {
    btn.onclick = function (ev) {
      ev.stopPropagation();
      if (state.running) { flashHint("运行中不可切换保留（Esc 停止后再试）"); return; }
      retainToggle(btn.closest(".exp").dataset.name, btn.dataset.retain === "keep");
    };
  });
}

// 工具库治理：POST /api/keep|drop → 刷新注册表（与 CLI org keep/drop 同代码路径）
function retainToggle(name, retained) {
  api("/api/" + (retained ? "keep" : "drop"), { method: "POST", body: JSON.stringify({ expert: name }) })
    .then(function (r) {
      if (r && r.ok) {
        flashHint(retained ? "★ 已选取保留 " + name + "（git 留痕，B 路径自动复用从下轮派单命中）"
          : "○ 已取消保留 " + name + "（显式寻址仍可用）");
        return refreshStatus();
      }
      flashHint((r && r.error) || "操作失败");
    })
    .catch(function (e) { flashHint(String(e && e.message || e)); });
}

// ---- 运行范围复核（org review 的 GUI 面）--------------------------------
// 与 CLI org review 同一语义：范围由运行产物界定（本次铸出 / 补丁合入 /
// 复用命中），勾选后只翻转 retained（不删文件）。侧栏的 ★/○ 是「按名字治理
// 库里已有资产」，这里是「按本次运行复核产出」——范围不同，故并列而非替代。
var reviewPlan = null;   // GET /api/review 的最近结果（勾选面板数据源）

function reviewItemHtml(c, idx) {
  var why = c.origin.indexOf("minted") >= 0 ? "本次铸出"
    : (c.origin.indexOf("patched") >= 0 ? "本次补丁合入" : "本次复用命中");
  var bits = [why];
  if (c.evalInRun) bits.push("本次验收 " + c.evalInRun);
  bits.push("库内评测 " + Number(c.eval_score).toFixed(2));
  if (c.capabilities && c.capabilities.length) bits.push("能力 " + c.capabilities.join("/"));
  return '<label class="rvitem">' +
    '<input type="checkbox" data-rv="' + esc(c.name) + '" checked>' +
    '<span><span class="nm">' + esc(c.name) + '</span>' +
    '<span class="vr"> @' + esc(c.version) + '</span>' +
    (c.description ? '<div class="desc">' + esc(c.description) + '</div>' : '') +
    '<div class="meta">' + esc(bits.join(" · ")) + '</div>' +
    (c.patchNote ? '<div class="meta">补丁：' + esc(c.patchNote) + '</div>' : '') +
    '</span></label>';
}

function renderReviewPane() {
  var pane = document.getElementById("reviewPane");
  if (!reviewPlan || !reviewPlan.scope) { pane.innerHTML = ""; return; }
  var scope = reviewPlan.scope;
  var pending = reviewPlan.pending || [];
  var settled = reviewPlan.settled || [];
  var head = '<div class="rvhead"><div class="t" id="rvTitle">运行范围复核 · 选取沉淀进工具库</div>' +
    '<div class="s">' + esc(scope.label) + ' · 任务 ' + esc(scope.task || "(未记录)") +
    ' · 模型 ' + esc(scope.model || "?") + ' · 结果 ' + (scope.ok ? "Ok" : "Err") + '</div>' +
    '<div class="s">本次接触 铸出 ' + scope.minted.length + ' · 补丁 ' + scope.patched.length +
    ' · 复用 ' + scope.reused.length + '</div></div>';
  var body = pending.length
    ? pending.map(reviewItemHtml).join("")
    : '<div class="rvempty">本次运行没有待决策候选（无新铸出/合入的未保留资产）。</div>';
  var settledHtml = settled.length
    ? '<div class="rvsettled">已在库保留（仅上下文，不参与本次选取）：' +
      settled.map(function (c) { return esc((c.retained ? "★ " : "○ ") + c.name); }).join(" · ") + '</div>'
    : "";
  var foot = '<div class="rvfoot">' +
    '<button type="button" id="rvAll">全选</button>' +
    '<button type="button" id="rvNone">全不选</button>' +
    '<span class="sp"></span><span class="cnt" id="rvCount"></span>' +
    '<button type="button" id="rvCancel">取消</button>' +
    '<button type="button" class="pri" id="rvApply"' + (pending.length ? "" : " disabled") + '>确认沉淀</button>' +
    '</div>';
  pane.innerHTML = head + body + settledHtml + foot;
  var boxes = function () { return Array.prototype.slice.call(pane.querySelectorAll("input[data-rv]")); };
  function syncCount() {
    var n = boxes().filter(function (b) { return b.checked; }).length;
    var el = document.getElementById("rvCount");
    if (el) el.textContent = "已选 " + n + " / " + pending.length;
  }
  boxes().forEach(function (b) { b.onchange = syncCount; });
  syncCount();
  document.getElementById("rvAll").onclick = function () { boxes().forEach(function (b) { b.checked = true; }); syncCount(); };
  document.getElementById("rvNone").onclick = function () { boxes().forEach(function (b) { b.checked = false; }); syncCount(); };
  document.getElementById("rvCancel").onclick = closeReview;
  document.getElementById("rvApply").onclick = submitReview;
}

function openReview() {
  var pane = document.getElementById("reviewPane");
  var scrim = document.getElementById("reviewScrim");
  pane.classList.add("on"); scrim.classList.add("on");
  api("/api/review").then(function (r) {
    if (!r || !r.ok) {
      closeReview();
      flashHint((r && r.error) || "读取复核范围失败");
      return;
    }
    reviewPlan = r;
    renderReviewPane();
  }).catch(function (e) { closeReview(); flashHint(String(e && e.message || e)); });
}

function closeReview() {
  document.getElementById("reviewPane").classList.remove("on");
  document.getElementById("reviewScrim").classList.remove("on");
}

function submitReview() {
  if (!reviewPlan) return;
  var pane = document.getElementById("reviewPane");
  var keep = Array.prototype.slice.call(pane.querySelectorAll("input[data-rv]"))
    .filter(function (b) { return b.checked; })
    .map(function (b) { return b.dataset.rv; });
  var btn = document.getElementById("rvApply");
  btn.disabled = true;
  api("/api/review", {
    method: "POST",
    body: JSON.stringify({ run: reviewPlan.scope.dir, keep: keep }),
  }).then(function (r) {
    if (!r || !r.ok) { btn.disabled = false; flashHint((r && r.error) || "写入失败"); return; }
    closeReview();
    flashHint(keep.length
      ? "★ 已沉淀 " + r.keptCount + " 个（git 留痕，B 路径自动复用从下轮派单命中）"
      : "○ 本次未沉淀任何候选（资产留在库，仅退出 B 路径自动复用）");
    refreshStatus();
    refreshReviewChip();
  }).catch(function (e) { btn.disabled = false; flashHint(String(e && e.message || e)); });
}

// 顶栏计数徽标：本次运行有未保留候选时才出现（界面上给「该复核了」一个信号）
function refreshReviewChip() {
  api("/api/review").then(function (r) {
    var btn = document.getElementById("reviewBtn");
    if (!btn) return;
    if (r && r.ok && r.pending && r.pending.length > 0) {
      reviewPlan = r;
      document.getElementById("reviewCount").textContent = String(r.pending.length);
      btn.hidden = false;
      btn.title = "本次运行（" + r.scope.label + "）有 " + r.pending.length +
        " 个未保留候选 —— 点击选取哪些沉淀进工具库";
    } else {
      btn.hidden = true;
    }
  }).catch(function () { /* 无工作区/无产物：徽标保持隐藏 */ });
}

// ---- 团队模式派单（v0.5.0）：运行卡片叙事 ----------------------------------
// 解析契约在服务端（lib/runCards.ts）：SSE 的 card 帧携带 {ev, fact}，这里只按
// fact.t 渲染，不自己写正则 —— Web 是内联 JS 无构建步骤，让浏览器自己解析就
// 回到了「同一次运行在两个前端显示成两件事」的老问题。
// 渲染策略：把事实并进一个 runModel，然后整块重绘（一次运行几十条事实，重绘
// 比增量改 DOM 更不容易出错，且天然幂等）。

var runModel = null;
var runSeq = 0;
var lastRunDone = null;
// 内联 JS 位于 renderIndexHtml 的模板字面量里，裸反斜杠-n 会被模板字面量先吃掉，
// 故此处分帧分隔符显式构造，避免转义层叠。
var NL = String.fromCharCode(10);

function newRunModel(task, model) {
  return {
    id: ++runSeq, task: task, model: model, startedAt: Date.now(),
    mission: "", qa: [], subs: {}, order: [],
    revisions: [], mints: [], patches: [], canaries: [], assets: [],
    crystals: [], scores: [], caps: [], others: [], shadows: [], notices: [],
    approvals: [], noise: 0,
    drift: 0, mined: 0, ctx: null, factoryNodes: [],
    rescues: [],
    audio: [], audioFailures: [],
    runOk: null, elapsed: 0
  };
}

function subOf(m, id) {
  var key = String(id);
  if (!m.subs[key]) {
    m.subs[key] = { id: id, role: "", route: "", channel: "", detail: "", expert: "",
                    verdict: "", coverage: null, note: "", attempt: 0, remedy: "", rerouted: false };
    m.order.push(key);
  }
  return m.subs[key];
}

function applyFact(m, fact) {
  var i, mm;
  if (!fact) return;
  switch (fact.t) {
    case "mission": m.mission = fact.mission; break;
    case "clarify": m.qa.push({ q: fact.q }); break;
    case "answer":
      for (i = 0; i < m.qa.length; i++) {
        if (m.qa[i].a === undefined) { m.qa[i].a = fact.a; break; }
      }
      break;
    case "rescue": m.rescues.push(fact); break;
    case "route": {
      var s1 = subOf(m, fact.id);
      s1.role = fact.role; s1.route = fact.route; s1.channel = fact.channel;
      break;
    }
    case "dispatch": {
      var s2 = subOf(m, fact.id);
      s2.channel = fact.channel; s2.detail = fact.detail;
      mm = /reuse\s+(\S+)/.exec(fact.detail);
      if (mm) s2.expert = mm[1];
      break;
    }
    case "review": {
      var s3 = subOf(m, fact.id);
      s3.verdict = fact.verdict;
      s3.coverage = fact.coverage == null ? null : fact.coverage;
      s3.note = fact.note || "";
      break;
    }
    case "revision": {
      var s4 = subOf(m, fact.id);
      s4.attempt = fact.attempt; s4.remedy = fact.remedy;
      m.revisions.push(fact);
      break;
    }
    case "reroute": subOf(m, fact.id).rerouted = true; break;
    case "node": if (fact.graph === "Factory") m.factoryNodes.push(fact.node); break;
    case "mint": m.mints.push(fact); break;
    case "patch": m.patches.push(fact.detail); break;
    case "canary": m.canaries.push(fact.detail); break;
    case "asset": m.assets.push(fact.label); break;
    case "crystal": m.crystals.push(fact); break;
    case "ctx": m.ctx = fact; break;
    case "drift": m.drift = fact.alerts; break;
    case "mined": m.mined = fact.entries; break;
    case "score": m.scores.push(fact); break;
    case "capability": m.caps.push(fact); break;
    case "runEnd": m.runOk = fact.ok; m.elapsed = fact.elapsed_ms; break;
    case "runStart": if (!m.mission && fact.mission) m.mission = fact.mission; break;
    case "shadow": m.shadows.push(fact); break;
    case "notice": m.notices.push(fact); break;
    case "approval": m.approvals.push(fact); break;
    // v0.5.6：音频产物（引擎收尾注入的 audio_rendered 事实）
    case "audio":
      fact.files.forEach(function (f) { m.audio.push(f); });
      fact.failures.forEach(function (f) { m.audioFailures.push(f); });
      break;
    // run_result 是引擎桥的合成终态（与 done 帧同源信息），不再当作「未分类」
    case "result": break;
    default:
      // 分两桶：journal 的内部动作（decompose / worker-done 等监督回路步骤）
      // 只计数 —— 它们已由任务卡与裁决行表达，列出来是噪音；而**真正未分类的
      // 引擎事件**（audit / capability_denied / canary_rollback …）必须留名，
      // 这正是过去落到 unknown 后被所有前端丢掉的那批。
      if (fact.name === "journal") m.noise++; else m.others.push(fact);
      break;
  }
}

var ROUTE_CN = { A: "内联", B: "复用", C: "生成", D: "移交" };
var FACTORY_STEPS = [["spec", "规格"], ["mint", "生成"], ["check", "check"], ["accept", "验收"], ["register", "登记 git"]];

function subRowHtml(s) {
  var h = '<div class="rsub"><span class="tid">task#' + s.id + '</span>' +
    '<span class="role">' + esc(s.role || "-") + '</span>';
  if (s.route) {
    h += '<span class="rtag ' + esc(s.route) + '">' + esc(s.route) + ' ' + esc(ROUTE_CN[s.route] || "") + '</span>';
  }
  if (s.channel) {
    var ch = (s.channel === "reuse" && s.expert) ? "reuse " + s.expert : s.channel;
    h += '<span class="dim">' + esc(ch) + '</span>';
  }
  if (s.verdict) {
    h += '<span class="rvb ' + esc(s.verdict) + '">' + esc(s.verdict) + '</span>';
    if (s.coverage != null) h += '<span class="dim">coverage ' + s.coverage.toFixed(2) + '</span>';
    if (s.attempt > 0) h += '<span class="dim">第 ' + s.attempt + ' 次返工后</span>';
  }
  if (s.rerouted) h += '<span class="dim">已重派（排除失败执行体）</span>';
  return h + '</div>';
}

function renderRun(m) {
  if (!m) return "";
  var h = '<div class="rcard" id="runCard' + m.id + '">';
  h += '<div class="rchead"><span class="rt">团队派单</span><span>· ' + esc(m.model) +
       '</span><span style="margin-left:auto" id="runStatus' + m.id + '">运行中…</span></div>';
  h += '<div class="rcbody">';
  if (m.mission) h += '<div class="rc-mission">' + esc(m.mission) + '</div>';
  // v0.5.10：车道救援判定行（语义地板 —— 先于任务树，用户第一眼看到车道决策）
  m.rescues.forEach(function (r) {
    if (r.mode === "reroute") {
      h += '<div class="revt nv-ok">⇄ 跨车道救援 → <b>' + esc(r.expert || "?") + '</b>' +
           '<span class="dim">（任务域外：与团队剧本重合 ' + r.stockScore + ' &lt; ' + r.floor +
           ' 地板 · 直连车道接管 · 专家评分 ' + r.score + '）</span></div>';
    } else {
      h += '<div class="revt nv-warn">◌ 域外任务 · 零消耗降级' +
           '<span class="dim">（与团队剧本重合 ' + r.stockScore + ' &lt; ' + r.floor +
           ' 地板，流水线未启动 —— 不套用域外剧本答非所问）建议：切「直连」模式选专家，或配置真实模型车道获得动态分解</span></div>';
    }
  });
  m.qa.forEach(function (p) {
    h += '<div class="revt"><span class="dim">澄清 </span>' + esc(p.q) + '</div>';
    if (p.a !== undefined) h += '<div class="revt"><span class="dim">答复 </span>' + esc(p.a) + '</div>';
  });
  if (m.order.length > 0) {
    h += '<div style="margin-top:6px">';
    m.order.forEach(function (k) { h += subRowHtml(m.subs[k]); });
    h += '</div>';
  }
  m.revisions.forEach(function (r) {
    h += '<div class="revt"><span class="dim">返工 task#' + r.id + ' #' + r.attempt + ' · </span>' + esc(r.remedy) + '</div>';
  });
  if (m.factoryNodes.length > 0 || m.mints.length > 0) {
    var done = m.mints.length > 0;
    h += '<div class="rsteps"><span class="dim">工厂</span>';
    FACTORY_STEPS.forEach(function (st, i) {
      var isDone = done || m.factoryNodes.length > i;
      h += '<span class="s' + (isDone ? ' done' : '') + '">' + esc(st[1]) + '</span>';
      if (i < FACTORY_STEPS.length - 1) h += '<span class="ar">→</span>';
    });
    h += '</div>';
  }
  m.mints.forEach(function (mm) {
    h += '<div class="revt"><span class="dim">铸出 </span>' + esc(mm.name) + '@' + esc(mm.version) +
         (mm.eval ? '<span class="dim"> · 验收 ' + esc(mm.eval) + '</span>' : '') + '</div>';
  });
  m.crystals.forEach(function (c) {
    h += '<div class="revt">' + (c.frozen ? "❄ 冻结 " : "⚡ 命中 ") +
         '<span class="dim">' + esc(c.node) + ' ← ' + esc(c.input) + '</span></div>';
  });
  m.patches.forEach(function (p) { h += '<div class="revt"><span class="dim">补丁 </span>' + esc(p) + '</div>'; });
  m.canaries.forEach(function (c) { h += '<div class="revt"><span class="dim">金丝雀 </span>' + esc(c) + '</div>'; });
  if (m.drift > 0) h += '<div class="revt"><span class="dim">⚠ 静默更新告警 ' + m.drift + ' 条</span></div>';
  if (m.mined > 0) h += '<div class="revt"><span class="dim">journal→fixture 出题 ' + m.mined + ' 批</span></div>';
  if (m.ctx) {
    h += '<div class="revt"><span class="dim">' + esc(m.ctx.expert) + '/' + esc(m.ctx.session) +
         ' turn=' + m.ctx.turn + ' · ctx ' + m.ctx.ctx + '/' + m.ctx.window + '</span></div>';
  }
  if (m.assets.length > 0) {
    h += '<div class="revt" style="margin-top:6px"><span class="dim">资产 </span><span class="rasset">' +
         m.assets.map(esc).join(" · ") + '</span></div>';
  }
  m.shadows.forEach(function (sh) {
    h += '<div class="revt"><span class="dim">影子对比 </span>' + esc(sh.expert) + ' ' +
         esc(sh.baseline) + ' → ' + esc(sh.candidate) + ' · ' +
         (sh.agree ? "一致" : "不一致（触发回滚）") + '</div>';
  });
  if (m.caps.length > 0) {
    var byCap = {};
    m.caps.forEach(function (c) { byCap[c.capability] = (byCap[c.capability] || 0) + 1; });
    h += '<div class="revt"><span class="dim">能力授予 </span>' +
         esc(Object.keys(byCap).map(function (k) { return k + "×" + byCap[k]; }).join(" · ")) + '</div>';
  }
  m.approvals.forEach(function (ap) {
    h += '<div class="revt nv-approval">' + esc(ap.text || ("待批准 · " + ap.action)) + '</div>';
    h += approvalItemHtml({ id: ap.id, capability: ap.capability, action: ap.action, detail: ap.detail });
  });
  m.notices.forEach(function (n) {
    var cls = n.tone === "err" ? "nv-err" : (n.tone === "warn" ? "nv-warn" : (n.tone === "ok" ? "nv-ok" : "nv-info"));
    h += '<div class="revt ' + cls + '">' + esc(n.text) + '</div>';
  });
  // v0.5.6：音频产物行（♪ 开袋即食；播放器在 done 段 —— dir 在终帧才确定）
  // v0.5.9：音色徽标（timbre 命中注册表时）+ MIDI 同行提示
  m.audio.forEach(function (a) {
    h += '<div class="revt nv-ok">♪ 音频产物 ' + esc(a.wavFile) +
         ' · ' + esc(a.title) + ' · ' + a.durationSec + 's · ' + a.notes + ' 音符' +
         (a.timbre ? ' · <b>' + esc(a.timbre) + '</b> 音色' : '') +
         (a.midiFile ? ' · 附 MIDI' : '') + '</div>';
  });
  m.audioFailures.forEach(function (f) {
    h += '<div class="revt nv-warn">♪ 渲染失败 ' + esc(f.file) + '：<span class="dim">' + esc(f.error) + '</span></div>';
  });
  if (m.others.length > 0 || m.noise > 0) {
    // 不静默丢弃：未分类事件留名（audit / capability_denied / canary_rollback …）
    var parts = [];
    if (m.others.length > 0) {
      parts.push("未分类 " + m.others.length + " 条：" + m.others.slice(0, 8).map(function (o) {
        var lbl = o.name || o.t || "?";
        return o.action ? lbl + ":" + o.action : lbl;
      }).join(" · "));
    }
    if (m.noise > 0) parts.push("监督回路内部步骤 " + m.noise + " 条");
    h += '<div class="revt" style="margin-top:6px"><span class="dim">' + esc(parts.join(" · ")) + '</span></div>';
  }
  h += '</div>';
  h += '<div class="rdone" id="runDone' + m.id + '"></div>';
  return h + '</div>';
}

function refreshRunCard(m) {
  var host = document.getElementById("runCard" + m.id);
  if (!host) return;
  var prevDone = document.getElementById("runDone" + m.id);
  var keep = prevDone ? prevDone.innerHTML : "";
  var tmp = document.createElement("div");
  tmp.innerHTML = renderRun(m);
  var fresh = tmp.firstChild;
  if (keep) {
    var freshDone = fresh.querySelector("#runDone" + m.id);
    if (freshDone) freshDone.innerHTML = keep;
  }
  host.parentNode.replaceChild(fresh, host);
}

function runDoneHtml(x) {
  x = x || {};
  var mt = x.metrics || {};
  function cell(k, v) { return '<span>' + k + ' <b>' + esc(String(v)) + '</b></span>'; }
  var h = "";
  if (mt.subtasks != null) h += cell("收货", (mt.accepted == null ? "-" : mt.accepted) + "/" + mt.subtasks);
  if (mt.deliverables != null) h += cell("交付物", mt.deliverables);
  if (mt.assets != null) h += cell("资产", mt.assets);
  if (mt.model_calls_total != null) h += cell("model_calls", mt.model_calls_total);
  if (mt.revises_total != null) h += cell("返工", mt.revises_total);
  if (x.elapsed_ms != null) h += cell("耗时", (x.elapsed_ms / 1000).toFixed(1) + "s");
  if (x.outDir) h += '<span class="dim">产物 ' + esc(x.outDir) + '</span>';
  // v0.5.6：音频产物播放器（dir 名在终帧/回放时已知 —— 开袋即食的 Web 面；
  // .rdone 是 flex-wrap 容器，播放器卡片作为子项自然流动）
  var dirName = x.outDirName || (typeof x.outDir === "string" ? x.outDir.split(/[\\/]/).pop() : "");
  var audio = x.audio || [];
  if (dirName && audio.length > 0) {
    audio.forEach(function (a) {
      var src = "/api/audio?dir=" + encodeURIComponent(dirName) + "&file=" + encodeURIComponent(a.wavFile || a.file);
      h += '<div class="raud">' +
           '<span class="dim">♪ ' + esc(a.title || a.wavFile || a.file) + ' · ' +
           (a.durationSec || 0) + 's' + (a.timbre ? ' · ' + esc(a.timbre) : '') + '</span>' +
           '<audio controls preload="none" src="' + esc(src) + '"></audio>' +
           '<a class="dim" download href="' + esc(src) + '">下载</a>' +
           (a.midiFile ? '<a class="dim" download href="/api/audio?dir=' + encodeURIComponent(dirName) +
             '&file=' + encodeURIComponent(a.midiFile) + '">MIDI</a>' : '') +
           '</div>';
    });
  }
  return h;
}

/** 团队派单：SSE 消费 /api/run-stream，把 card 帧喂给 runModel。 */
function runTeam(task) {
  if (state.running) return;
  state.running = true;
  state.myRunStarted = false;
  state.ticketId = 0;
  setRunning(true);
  document.getElementById("question").value = "";
  var chat = document.getElementById("chat");
  if (chat.querySelector(".banner")) chat.innerHTML = "";
  chat.insertAdjacentHTML("beforeend",
    '<div class="t-user"><span class="ps">❯</span><span class="q">' + esc(task) + '</span></div>');
  runModel = newRunModel(task, state.model);
  chat.insertAdjacentHTML("beforeend", renderRun(runModel));
  scrollDown(true);

  var settled = false;
  function finish(errMsg, aborted) {
    if (settled) return;
    settled = true;
    state.running = false;
    setRunning(false);
    var m = runModel;
    if (!m) return;
    var st = document.getElementById("runStatus" + m.id);
    if (errMsg) {
      if (st) st.textContent = aborted ? "已停止" : "失败";
      document.getElementById("chat").insertAdjacentHTML("beforeend",
        '<div class="errbox">✗ ' + esc(errMsg) + '</div>');
    } else {
      if (st) st.textContent = m.runOk ? "完成" : "结束（Err）";
      var d = document.getElementById("runDone" + m.id);
      if (d) d.innerHTML = runDoneHtml(lastRunDone && {
        metrics: lastRunDone.metrics, elapsed_ms: lastRunDone.elapsed_ms,
        outDir: lastRunDone.outDir, outDirName: lastRunDone.outDirName,
        audio: lastRunDone.audioRendered,
      });
      // v0.5.10：跨车道救援（reroute）后 direct 轮次的回答以对话气泡呈现 ——
      // 团队派单卡讲「为什么换了车道」，气泡讲「专家答了什么」
      if (lastRunDone && lastRunDone.directTurns && lastRunDone.directTurns.length > 0) {
        var lastTurn = lastRunDone.directTurns[lastRunDone.directTurns.length - 1];
        var rescuedBy = (m.rescues && m.rescues[0] && m.rescues[0].expert) || "?";
        var tHtml = '<div class="t-bot"><div class="who">org · ' + esc(rescuedBy) +
          ' · turn ' + (lastTurn.turn || 1) + ' · ' + (lastTurn.tokens || 0) +
          ' tok <span style="opacity:.6">（跨车道救援直连）</span></div>' +
          '<div class="body md">' + renderMd(lastTurn.answer || "（空回答）") + '</div></div>';
        document.getElementById("chat").insertAdjacentHTML("beforeend", tHtml);
        scrollDown(false);
      }
    }
    loadRuns();
    refreshReviewChip();
  }

  sseConnect("/api/run-stream", { task: task, model: state.model }, function (ev, d) {
    if (settled) return;
    if (ev === "open") {
      state.ticketId = (d && d.ticketId) || 0;
      if (d && d.queued) {
        var st0 = document.getElementById("runStatus" + runModel.id);
        if (st0) st0.textContent = "排队中（前一轮仍在运行）· esc 取消本轮";
      }
    } else if (ev === "start") {
      state.myRunStarted = true;
      var st1 = document.getElementById("runStatus" + runModel.id);
      if (st1) st1.textContent = "监督回路运行中…";
    } else if (ev === "card") {
      applyFact(runModel, d && d.fact);
      refreshRunCard(runModel);
      scrollDown(false);
    } else if (ev === "done") {
      lastRunDone = d;
      finish(null, false);
    } else if (ev === "error") {
      finish((d && d.message) || "引擎失败", d && d.aborted);
    }
  }, function (e) { finish("SSE 连接失败：" + e, false); },
     function () { if (!settled) finish("SSE 连接意外中断（未收到 done）", false); });
}

// 通用 SSE 连接（团队 run 用）。直连路径保留既有实现不动 —— 那条链路已被
// web.test.ts 全链覆盖，没有理由为省几行去动它。
function sseConnect(url, body, onEvent, onError, onEof) {
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(function (r) {
    if (!r.ok) {
      return r.json().then(
        function (e) { throw new Error(e && e.error ? e.error : "HTTP " + r.status); },
        function () { throw new Error("HTTP " + r.status); },
      );
    }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return;
        buf += dec.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf(NL + NL)) >= 0) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          sseFrame(frame, onEvent);
        }
        return pump();
      });
    }
    return pump();
  }).catch(function (e) { onError(e); }).then(function () { onEof(); });
}

// ---- 交互式审批队列（v0.5.0）：Web 面 --------------------------------------
// 与 CLI org approvals 同一文件协议（runtime/approvals/），无旁路。
// 两种入口：顶栏「待批准 N」徽标（轮询发现）+ run 卡片里的内联按钮
// （运行中当场放行，不必换终端）。

var approvalState = { pending: [], granted: [] };

function approvalChipRefresh() {
  api("/api/approvals").then(function (r) {
    var btn = document.getElementById("approvalBtn");
    if (!btn || !r || !r.ok) return;
    approvalState.pending = r.pending || [];
    approvalState.granted = r.granted || [];
    if (approvalState.pending.length > 0) {
      document.getElementById("approvalCount").textContent = String(approvalState.pending.length);
      btn.hidden = false;
      btn.title = "有 " + approvalState.pending.length + " 项能力决策等待你放行（超时未回复将被拒绝）";
    } else {
      btn.hidden = true;
    }
    if (runModel && runModel.approvals.length > 0) refreshRunCard(runModel);
  }).catch(function () { /* 无工作区/无审批目录：保持隐藏 */ });
}

function approvalItemHtml(p) {
  var mine = approvalState.pending.some(function (x) { return x.id === p.id; });
  var h = '<div class="apitem" data-ap="' + esc(p.id) + '">' +
    '<div class="ap1"><span class="nm">' + esc(p.capability) + '</span>' +
    '<span class="dim">' + esc(p.id) + '</span></div>' +
    '<div class="ap2">' + esc(p.action || "") + '</div>';
  if (p.detail) h += '<div class="ap3">' + esc(p.detail) + '</div>';
  if (mine) {
    h += '<div class="apacts">' +
      '<button type="button" class="pri" data-ap-allow="' + esc(p.id) + '">放行</button>' +
      '<button type="button" data-ap-always="' + esc(p.id) + '">总是放行</button>' +
      '<button type="button" class="danger" data-ap-deny="' + esc(p.id) + '">拒绝</button>' +
      '</div>';
  } else {
    h += '<div class="ap3">已处理（或已超时）</div>';
  }
  return h + '</div>';
}

function renderApprovalPane() {
  var pane = document.getElementById("approvalPane");
  var pending = approvalState.pending || [];
  var granted = approvalState.granted || [];
  var head = '<div class="rvhead"><div class="t" id="apTitle">交互式审批 · 能力决策</div>' +
    '<div class="s">请求来自运行中的 run（org run --approval / TUI / Web 团队派单）。' +
    '「放行」只对本次生效，「总是放行」会写入长期放行集。</div>' +
    '<div class="s">超时未回复将由 HSL 侧降级为拒绝 —— run 不会被挂住。</div></div>';
  var body = pending.length
    ? pending.map(approvalItemHtml).join("")
    : '<div class="rvempty">当前没有待批准的项。</div>';
  var g = granted.length
    ? '<div class="rvsettled">长期放行集：' + esc(granted.join(" · ")) + '</div>'
    : "";
  var foot = '<div class="rvfoot"><span class="cnt">' +
    (pending.length ? "待批准 " + pending.length + " 项" : "空闲") + '</span>' +
    '<span class="sp"></span><button type="button" id="apCancel">关闭</button></div>';
  pane.innerHTML = head + body + g + foot;
  document.getElementById("apCancel").onclick = closeApprovals;
  Array.prototype.forEach.call(
    pane.querySelectorAll("button[data-ap-allow],button[data-ap-always],button[data-ap-deny]"),
    function (b) {
      b.onclick = function () {
        var id = b.dataset.apAllow || b.dataset.apAlways || b.dataset.apDeny;
        decideApproval(id, !b.dataset.apDeny, !!b.dataset.apAlways);
      };
    });
}

// ---- 任务中心 + 通知中心（v0.5.2：org task / org notify 的 GUI 面） ----

var tasksState = { tasks: [], unread: 0, runner: "none" , schedules: [] };
var notifyState = { list: [], unread: 0 };
var tasksTimer = null;

var TASK_STATUS_MARK = { queued: "…", running: "▶", paused: "⏸", done: "✓", failed: "✗", cancelled: "⊘" };

function openTasks() {
  document.getElementById("tasksPane").classList.add("on");
  document.getElementById("tasksScrim").classList.add("on");
  renderTasksPane();
  loadTasks();
  if (tasksTimer) clearInterval(tasksTimer);
  tasksTimer = setInterval(function () {
    connTick++;
    if (connGate(connTick)) loadTasks();
  }, 3000); // 打开期间 3s 自动刷新（含 schedules；断连时降频）
}

function closeTasks() {
  document.getElementById("tasksPane").classList.remove("on");
  document.getElementById("tasksScrim").classList.remove("on");
  if (tasksTimer) { clearInterval(tasksTimer); tasksTimer = null; }
}

function loadTasks() {
  api("/api/tasks").then(function (r) {
    if (!r || !r.ok) return;
    tasksState.tasks = r.tasks || [];
    tasksState.runner = r.runner || "none";
    renderTasksPane();
  }).catch(function () { /* 轮询失败静默 */ });
  loadSchedules(); // v0.5.5：定时任务快照随任务中心一起刷新
}

function loadSchedules() {
  api("/api/schedules").then(function (r) {
    if (!r || !r.ok) return;
    tasksState.schedules = r.schedules || [];
    renderSchedPane();
  }).catch(function () { /* 静默 */ });
}

function schedRowsHtml() {
  var list = tasksState.schedules || [];
  if (list.length === 0) return '<div class="pvempty" style="padding:10px 14px">（无定时 —— 下方新建：cron 五段或 @every 30m）</div>';
  var now = Date.now();
  return list.map(function (s) {
    var inMin = Math.round((Date.parse(s.next_run) - now) / 60000);
    var next = !isFinite(inMin) ? "?" : inMin <= 0 ? "到期" : inMin < 90 ? inMin + " 分钟后" : Math.round(inMin / 1440) + " 天后";
    var mark = s.invalid ? "⚠" : s.enabled ? "⏰" : "○";
    var spec = s.kind === "run" ? "run · " + esc(String(s.spec.task || "").slice(0, 40)) : "ask · " + esc(s.spec.expert || "?");
    var acts = '<button data-schtog="' + esc(s.id) + '" data-on="' + (s.enabled ? "1" : "0") + '">' + (s.enabled ? "停用" : "启用") + "</button>" +
      '<button data-schrm="' + esc(s.id) + '" class="bad">删除</button>';
    return '<div class="tkrow"><span class="st">' + mark + '</span>' +
      '<span class="id">' + esc(s.expr) + "</span>" +
      '<span class="meta">' + esc(s.id) + "</span>" +
      '<span class="body">' + spec + " · 下次 " + next + " · 已触发 " + s.runs + " 次</span>" +
      '<span class="acts">' + acts + "</span></div>";
  }).join("");
}

function renderSchedPane() {
  var pane = document.getElementById("schedPane");
  if (!pane || !pane.classList.contains("on")) return;
  pane.innerHTML =
    '<div class="pvhead"><span class="t">⏰ 定时任务</span>' +
    '<span class="s">org schedule 的 GUI 面（执行器挂载触发 · 到期入队）</span>' +
    '<button onclick="closeSched()" style="background:transparent;border:1px solid var(--border2);color:var(--text);font:600 11px var(--mono);padding:4px 9px;border-radius:3px;cursor:pointer;margin-left:12px">关闭</button></div>' +
    '<div class="tkform">' +
    '<input type="text" id="schExpr" class="taskinput" placeholder="表达式：*/30 9-17 * * 1-5（cron）或 @every 30m" style="min-width:200px">' +
    '<input type="text" id="schTask" class="taskinput" placeholder="团队任务描述（run 语义）">' +
    '<button id="schPreview">预览</button>' +
    '<button id="schAdd" class="pri">新建定时</button>' +
    "</div>" +
    '<div id="schPreviewOut" class="pvtest" style="color:var(--dim)"></div>' +
    '<div class="pvsec" style="padding:0">' + schedRowsHtml() + "</div>";
  wireSchedButtons(pane);
}

function wireSchedButtons(pane) {
  var el;
  el = pane.querySelector("#schAdd");
  if (el) el.onclick = function () {
    var expr = ((pane.querySelector("#schExpr") || {}).value || "").trim();
    var task = ((pane.querySelector("#schTask") || {}).value || "").trim();
    if (!expr || !task) { flashHint("表达式与任务描述必填"); return; }
    api("/api/schedules", { method: "POST", body: JSON.stringify({ action: "add", kind: "run", expr: expr, task: task, model: state.model }) })
      .then(function (r) {
        if (!r || !r.ok) { flashHint((r && r.error) || "新建失败"); return; }
        flashHint("✓ 定时已建 " + r.schedule.id + "（下次 " + String(r.schedule.next_run).slice(0, 19).replace("T", " ") + "）");
        loadSchedules();
      }).catch(function (e) { flashHint("新建失败：" + e); });
  };
  el = pane.querySelector("#schPreview");
  if (el) el.onclick = function () {
    var expr = ((pane.querySelector("#schExpr") || {}).value || "").trim();
    var out = pane.querySelector("#schPreviewOut");
    if (!expr) { flashHint("先填表达式"); return; }
    api("/api/schedules/preview?expr=" + encodeURIComponent(expr))
      .then(function (r) {
        if (!r || !r.ok) { if (out) out.textContent = "✗ " + ((r && r.error) || "不可解析"); return; }
        if (out) out.textContent = "未来触发点（UTC）：" + (r.next || []).map(function (d) { return String(d).slice(0, 16).replace("T", " "); }).join(" → ") + (r.next && r.next.length === 0 ? "（366 天内无命中）" : "");
      });
  };
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-schrm]"), function (b) {
    b.onclick = function () {
      api("/api/schedules", { method: "POST", body: JSON.stringify({ action: "rm", id: b.dataset.schrm }) })
        .then(function (r) {
          if (!r || !r.ok) { flashHint((r && r.error) || "删除失败"); return; }
          flashHint("✓ 已删除定时");
          loadSchedules();
        });
    };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-schtog]"), function (b) {
    b.onclick = function () {
      api("/api/schedules", { method: "POST", body: JSON.stringify({ action: "toggle", id: b.dataset.schtog, enabled: b.dataset.on !== "1" }) })
        .then(function (r) {
          if (!r || !r.ok) { flashHint((r && r.error) || "切换失败"); return; }
          loadSchedules();
        });
    };
  });
}

function openSched() {
  document.getElementById("schedPane").classList.add("on");
  document.getElementById("schedScrim").classList.add("on");
  loadSchedules();
}

function closeSched() {
  document.getElementById("schedPane").classList.remove("on");
  document.getElementById("schedScrim").classList.remove("on");
}

function taskRowHtml(t) {
  var mark = TASK_STATUS_MARK[t.status] || "?";
  var body = t.kind === "ask"
    ? "ask " + esc(t.spec.expert || "?") + " · " + esc(String(t.spec.question || "").slice(0, 34))
    : esc(String(t.spec.task || "").slice(0, 44));
  var extra = t.result ? " · " + esc(String(t.result.summary).slice(0, 30))
    : t.error ? ' · <span style="color:var(--redb)">' + esc(String(t.error).slice(0, 30)) + "</span>" : "";
  var acts = "";
  if (t.status === "queued" || t.status === "paused") acts += '<button data-tkresume="' + esc(t.id) + '">恢复</button>';
  if (t.status === "queued" || t.status === "running" || t.status === "paused") acts += '<button data-tkpause="' + esc(t.id) + '" class="warn">暂停</button><button data-tkcancel="' + esc(t.id) + '" class="bad">取消</button>';
  if (t.status === "failed" || t.status === "cancelled" || t.status === "done") acts += '<button data-tkretry="' + esc(t.id) + '">重试</button>';
  var time = String(t.finished_at || t.started_at || t.created_at || "").slice(11, 19);
  return '<div class="tkrow"><span class="st ' + esc(t.status) + '">' + mark + '</span>' +
    '<span class="id">' + esc(t.id) + '</span><span class="meta">P' + t.priority + '</span>' +
    '<span class="meta">' + esc(time) + '</span>' +
    '<span class="body">' + body + extra + "</span>" +
    '<span class="acts">' + acts + "</span></div>";
}

function renderTasksPane() {
  var pane = document.getElementById("tasksPane");
  if (!pane.classList.contains("on")) return;
  var runnerNote = tasksState.runner === "web"
    ? '<span style="color:var(--greenb)">◆ 内嵌执行器运行中</span>'
    : tasksState.runner === "external/none"
      ? '<span style="color:#fbbf24">◇ 无执行器（org taskd 或带 taskRunner 的 org web 才会执行；提交先入队）</span>'
      : esc(tasksState.runner);
  var rows = tasksState.tasks.map(taskRowHtml).join("") ||
    '<div class="pvempty" style="padding:14px">（空 —— 下方提交第一个长程任务）</div>';
  pane.innerHTML =
    '<div class="pvhead"><span class="t" id="tkTitle">☰ 长程任务中心</span>' +
    '<span class="s">' + runnerNote + '</span>' +
    '<button onclick="closeTasks()" style="background:transparent;border:1px solid var(--border2);color:var(--text);font:600 11px var(--mono);padding:4px 9px;border-radius:3px;cursor:pointer;margin-left:12px">关闭</button></div>' +
    '<div class="tkform">' +
    '<input type="text" id="tkTask" class="taskinput" placeholder="团队任务（org run 语义）—— 例如：抓取近一周公告并输出表格">' +
    '<input type="number" id="tkPriority" min="0" max="10" value="5" title="优先级 P0（最高）– P10" style="width:64px">' +
    '<button id="tkSubmit">提交任务</button>' +
    "</div>" +
    '<div class="pvsec" style="padding:0">' + rows + "</div>";

  var el = document.getElementById("tkSubmit");
  if (el) el.onclick = function () {
    var task = (document.getElementById("tkTask") || {}).value || "";
    var priority = Number(((document.getElementById("tkPriority") || {}).value) || "5") || 5;
    if (!task.trim()) { flashHint("任务描述必填"); return; }
    api("/api/task/submit", { method: "POST", body: JSON.stringify({ kind: "run", task: task, priority: priority, model: state.model }) })
      .then(function (r) {
        if (!r || !r.ok) { flashHint((r && r.error) || "提交失败"); return; }
        flashHint("✓ 已入队 " + r.task.id + "（执行器自动领取 · 完成时通知）");
        document.getElementById("tkTask").value = "";
        loadTasks();
      }).catch(function (e) { flashHint("提交失败：" + e); });
  };
  wireTaskButtons(pane);
}

function wireTaskButtons(pane) {
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-tkpause]"), function (b) {
    b.onclick = function () { taskAction(b.dataset.tkpause, "pause"); };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-tkresume]"), function (b) {
    b.onclick = function () { taskAction(b.dataset.tkresume, "resume"); };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-tkcancel]"), function (b) {
    b.onclick = function () { taskAction(b.dataset.tkcancel, "cancel"); };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-tkretry]"), function (b) {
    b.onclick = function () { taskAction(b.dataset.tkretry, "retry"); };
  });
}

function taskAction(id, action) {
  api("/api/task/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify({ action: action }) })
    .then(function (r) {
      if (!r || !r.ok) { flashHint((r && r.error) || "操作失败"); return; }
      flashHint("✓ " + action + " → " + r.status);
      loadTasks();
    }).catch(function (e) { flashHint("操作失败：" + e); });
}

// ---- 通知中心 ----

var notifyTimer = null;

function notifyBadgeRefresh() {
  api("/api/notifications").then(function (r) {
    if (!r || !r.ok) return;
    var badge = document.getElementById("notifyCount");
    badge.textContent = String(r.unread || 0);
    badge.hidden = !r.unread;
    notifyState.list = r.notifications || [];
    notifyState.unread = r.unread || 0;
    if (document.getElementById("notifyPane").classList.contains("on")) renderNotifyPane();
  }).catch(function () { /* 静默 */ });
}

function openNotify() {
  document.getElementById("notifyPane").classList.add("on");
  document.getElementById("notifyScrim").classList.add("on");
  renderNotifyPane();
}

function closeNotify() {
  document.getElementById("notifyPane").classList.remove("on");
  document.getElementById("notifyScrim").classList.remove("on");
}

function renderNotifyPane() {
  var pane = document.getElementById("notifyPane");
  var rows = notifyState.list.slice(0, 50).map(function (n) {
    return '<div class="ntrow' + (n.read ? " read" : "") + '" data-nt="' + esc(n.id) + '">' +
      '<div class="l1"><span class="dot">' + (n.read ? "○" : "●") + '</span>' +
      "<span>" + esc(String(n.ts).slice(11, 19)) + '</span>' +
      '<span class="kind">[' + esc(n.kind) + "]</span>" +
      "<span>" + esc(n.title) + "</span></div>" +
      '<div class="l2">' + esc(n.detail || "") + "</div></div>";
  }).join("") || '<div class="pvempty" style="padding:14px">（无未读 —— 长程任务完成时自动产生）</div>';
  pane.innerHTML =
    '<div class="pvhead"><span class="t" id="ntTitle">🔔 通知中心</span>' +
    '<span class="s">未读 ' + notifyState.unread + "</span>" +
    '<button onclick="closeNotify()" style="background:transparent;border:1px solid var(--border2);color:var(--text);font:600 11px var(--mono);padding:4px 9px;border-radius:3px;cursor:pointer;margin-left:12px">关闭</button></div>' +
    '<div style="padding:0">' + rows + "</div>" +
    '<div class="rvfoot"><span class="sp"></span>' +
    '<button id="ntReadAll">全部已读</button><button id="ntClear" class="bad" style="color:var(--redb)">清空</button></div>';
  Array.prototype.forEach.call(pane.querySelectorAll(".ntrow[data-nt]"), function (node) {
    node.onclick = function () {
      api("/api/notifications", { method: "POST", body: JSON.stringify({ action: "read", id: node.dataset.nt }) })
        .then(function () { notifyBadgeRefresh(); });
    };
  });
  var el = document.getElementById("ntReadAll");
  if (el) el.onclick = function () {
    api("/api/notifications", { method: "POST", body: JSON.stringify({ action: "read-all" }) })
      .then(function () { notifyBadgeRefresh(); });
  };
  el = document.getElementById("ntClear");
  if (el) el.onclick = function () {
    api("/api/notifications", { method: "POST", body: JSON.stringify({ action: "clear" }) })
      .then(function () { notifyBadgeRefresh(); });
  };
}

// ---- 记忆面板（v0.5.3：org memory 的 GUI 面） ----

var memoryState = { groups: [] };

function openMemory() {
  document.getElementById("memoryPane").classList.add("on");
  document.getElementById("memoryScrim").classList.add("on");
  loadMemory();
}

function closeMemory() {
  document.getElementById("memoryPane").classList.remove("on");
  document.getElementById("memoryScrim").classList.remove("on");
}

function loadMemory() {
  api("/api/memory").then(function (r) {
    if (!r || !r.ok) return;
    memoryState.groups = r.groups || [];
    renderMemoryPane();
  }).catch(function () { flashHint("记忆读取失败"); });
}

function renderMemoryPane() {
  var pane = document.getElementById("memoryPane");
  if (!pane.classList.contains("on")) return;
  var rows = memoryState.groups.map(function (g) {
    var items = g.entries.map(function (e) {
      return '<div class="mmrow"><span class="ln">' + e.line + '</span><span class="tx">' +
        esc(e.text) + '</span><button data-mmrm="' + esc(g.expert) + '" data-mmline="' + e.line + '">删</button></div>';
    }).join("");
    return '<div class="mmgrp"><div class="gt">◆ ' + esc(g.expert) + '（' + g.entries.length + ' 条 · 直连自动注入尾部 40 行）</div>' + items + "</div>";
  }).join("") || '<div class="pvempty" style="padding:14px">（无记忆 —— 下方为当前对话专家添加第一条）</div>';
  pane.innerHTML =
    '<div class="pvhead"><span class="t" id="mmTitle">🧠 专家长期记忆</span>' +
    '<span class="s">偏好/约定沉淀 · direct 车道每轮自动注入</span>' +
    '<button onclick="closeMemory()" style="background:transparent;border:1px solid var(--border2);color:var(--text);font:600 11px var(--mono);padding:4px 9px;border-radius:3px;cursor:pointer;margin-left:12px">关闭</button></div>' +
    '<div style="padding:0;max-height:52vh;overflow:auto">' + rows + "</div>" +
    '<div class="tkform">' +
    '<input type="text" id="mmExpert" placeholder="专家名（如 notice-parser）" style="width:170px" value="' + esc(state.expert || "") + '">' +
    '<input type="text" id="mmText" class="taskinput" placeholder="记忆内容（≤500 字符 · 如：日期一律输出 ISO 8601）">' +
    '<button id="mmAdd">记入</button>' +
    "</div>";
  var el = document.getElementById("mmAdd");
  if (el) el.onclick = function () {
    var expert = (document.getElementById("mmExpert") || {}).value || "";
    var text = (document.getElementById("mmText") || {}).value || "";
    if (!expert.trim() || !text.trim()) { flashHint("专家名与记忆内容必填"); return; }
    api("/api/memory", { method: "POST", body: JSON.stringify({ action: "add", expert: expert, text: text }) })
      .then(function (r) {
        if (!r || !r.ok) { flashHint((r && r.error) || "写入失败"); return; }
        flashHint("✓ 已记入（" + expert + " 共 " + r.count + " 条 · 下轮对话生效）");
        document.getElementById("mmText").value = "";
        loadMemory();
      }).catch(function (e) { flashHint("写入失败：" + e); });
  };
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-mmrm]"), function (b) {
    b.onclick = function () {
      api("/api/memory", { method: "POST", body: JSON.stringify({ action: "rm", expert: b.dataset.mmrm, line: Number(b.dataset.mmline) }) })
        .then(function (r) {
          if (!r || !r.ok) { flashHint((r && r.error) || "删除失败"); return; }
          loadMemory();
        });
    };
  });
}

document.getElementById("memoryBtn").onclick = openMemory;
document.getElementById("memoryScrim").onclick = closeMemory;

// ---- 语义检索面板（v0.5.8：org search 的 GUI 面 · BM25 + RAG） ----

var schTimer = null;
var schSeq = 0;

function openSearch() {
  document.getElementById("searchPane").classList.add("on");
  document.getElementById("searchScrim").classList.add("on");
  var inp = document.getElementById("schQuery");
  if (inp) { inp.focus(); inp.select(); }
}

function closeSearch() {
  document.getElementById("searchPane").classList.remove("on");
  document.getElementById("searchScrim").classList.remove("on");
}

/** 命中词高亮（esc 后替换 —— XSS 安全：先全量转义再做受控 <b>）。 */
function schHighlight(snippet, terms) {
  var s = esc(snippet || "");
  for (var i = 0; i < terms.length; i++) {
    var t = esc(terms[i]);
    if (t.length > 0) {
      s = s.split(t).join("<b>" + t + "</b>");
    }
  }
  return s;
}

function schScoreClass(score) {
  return score >= 3 ? "hi" : score >= 1.5 ? "md" : "lo";
}

function runSearch() {
  var q = (document.getElementById("schQuery") || { value: "" }).value || "";
  var k = Number((document.getElementById("schK") || { value: "5" }).value || "5");
  var body = document.getElementById("schBody");
  var meta = document.getElementById("schMeta");
  if (!body) return;
  q = q.trim();
  if (!q) {
    meta.hidden = true;
    body.innerHTML = '<div class="schempty">输入查询词检索 raw/ registry/ work/ factory/ 语料 ——<br>点击命中路径可把 <b>@路径</b> 插入问题输入框（检索→引用闭环）。</div>';
    return;
  }
  var mySeq = ++schSeq;
  body.innerHTML = '<div class="schempty">检索中…</div>';
  api("/api/search?q=" + encodeURIComponent(q) + "&k=" + k).then(function (r) {
    if (mySeq !== schSeq) return; // 过期响应丢弃（防抖竞态）
    if (!r || !r.ok) {
      body.innerHTML = '<div class="schempty">✗ ' + esc((r && r.error) || "检索失败") + "</div>";
      meta.hidden = true;
      return;
    }
    meta.hidden = false;
    meta.innerHTML = "<span>" + r.hits.length + " 命中 / " + r.total_docs + " 文档 · " + r.took_ms + "ms</span>" +
      '<span class="corp">语料 ' + esc((r.stats && r.stats.corpusDirs || []).join(" · ") || "（空）") + "</span>";
    if (r.hits.length === 0) {
      body.innerHTML = '<div class="schempty">（无命中 —— 换个说法？中英混合均可，如「审计 制度」「date format」）</div>';
      return;
    }
    body.innerHTML = r.hits.map(function (h) {
      return '<div class="schrow" data-schpath="' + esc(h.path) + '" title="点击插入 @' + esc(h.path) + ' 到问题输入框">' +
        '<div class="top"><span class="sc ' + schScoreClass(h.score) + '">' + h.score.toFixed(2) + "</span>" +
        '<span class="pth">' + esc(h.path) + "</span></div>" +
        '<div class="snip">' + schHighlight(h.snippet, h.terms || []) + "</div></div>";
    }).join("");
    Array.prototype.forEach.call(body.querySelectorAll(".schrow"), function (row) {
      row.onclick = function () {
        var p = row.dataset.schpath || "";
        var q2 = document.getElementById("question");
        if (q2 && p) {
          q2.value = (q2.value.trim() + " @" + p).trim() + " ";
          q2.focus();
          flashHint("已插入 @" + p + "（关闭面板后直接提问）");
        }
      };
    });
  }).catch(function (e) {
    if (mySeq !== schSeq) return;
    body.innerHTML = '<div class="schempty">✗ 检索失败：' + esc(String(e)) + "</div>";
  });
}

document.getElementById("searchBtn").onclick = function () {
  openSearch();
  if ((document.getElementById("schQuery") || { value: "" }).value.trim()) runSearch();
};
document.getElementById("searchScrim").onclick = closeSearch;

// ---- 音频工坊面板（v0.5.9：8 音色试听 × 7 进行 × 柱式/琶音） ----

/** 音色元数据（与服务端 lib/audio.ts TIMBRES 同源镜像；图标 + 一句话特质 + 标签）。 */
var TIMBRE_META = [
  { id: "piano", icon: "🎹", label: "钢琴 Piano", desc: "谐波衰减 · 温暖木质", tags: ["衰减包络", "4 分音"] },
  { id: "strings", icon: "🎻", label: "弦乐 Strings", desc: "弓弦持续 · 柔和揉弦颤音", tags: ["持续音", "颤音 5.5Hz"] },
  { id: "flute", icon: "🪈", label: "长笛 Flute", desc: "气声正弦 · 奇次谐波", tags: ["慢起音", "清亮"] },
  { id: "organ", icon: "🎼", label: "管风琴 Organ", desc: "泛音列 · 教堂式持续", tags: ["6 分音", "平坦"] },
  { id: "harpsichord", icon: "🪕", label: "羽管键琴 Harpsichord", desc: "高次谐波 · 拨弦瞬态", tags: ["巴洛克", "快衰减"] },
  { id: "music-box", icon: "🎁", label: "八音盒 Music Box", desc: "非整数泛音 · 金属质感", tags: ["3.98× 泛音", "梦幻"] },
  { id: "guitar", icon: "🎸", label: "吉他 Guitar", desc: "拨弦 · 中速衰减", tags: ["民谣", "4 分音"] },
  { id: "bell", icon: "🔔", label: "钟琴 Bell", desc: "钟声泛音 · 长衰减", tags: ["2.76× 泛音", "空灵"] },
];

var audAudioEl = null;   // 当前播放的 Audio（切卡片先停）
var audPlayingId = "";

function openTimbre() {
  renderTimbreGrid();
  document.getElementById("audioPane").classList.add("on");
  document.getElementById("audioScrim").classList.add("on");
}

function closeTimbre() {
  stopTimbreDemo();
  document.getElementById("audioPane").classList.remove("on");
  document.getElementById("audioScrim").classList.remove("on");
}

function stopTimbreDemo() {
  if (audAudioEl) {
    audAudioEl.pause();
    audAudioEl.src = "";
    audAudioEl = null;
  }
  audPlayingId = "";
  var cur = document.querySelector(".audcard.playing");
  if (cur) cur.classList.remove("playing");
}

function renderTimbreGrid() {
  var grid = document.getElementById("audGrid");
  grid.innerHTML = TIMBRE_META.map(function (t) {
    return '<div class="audcard" data-timbre="' + t.id + '" role="button" tabindex="0" ' +
      'title="试听 ' + t.label + '（卡农进行前两小节样本）">' +
      '<div class="nm"><span class="ic">' + t.icon + "</span>" + t.label + "</div>" +
      '<div class="ds">' + t.desc + "</div>" +
      '<div class="tg">' + t.tags.map(function (x) { return "<span>" + x + "</span>"; }).join("") + "</div>" +
      "</div>";
  }).join("");
  Array.prototype.forEach.call(grid.querySelectorAll(".audcard"), function (card) {
    card.onclick = function () { playTimbreDemo(card.dataset.timbre, card); };
    card.onkeydown = function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); playTimbreDemo(card.dataset.timbre, card); }
    };
  });
}

function playTimbreDemo(timbre, card) {
  var prog = (document.getElementById("audProg") || { value: "canon" }).value || "canon";
  var arp = (document.getElementById("audStyle") || { classList: { contains: function () { return false; } } }).classList.contains("on");
  if (audPlayingId === timbre && audAudioEl && !audAudioEl.paused) {
    stopTimbreDemo(); // 再点同卡片 = 停止
    return;
  }
  stopTimbreDemo();
  card.classList.add("playing");
  audPlayingId = timbre;
  fetch("/api/audio-demo?timbre=" + encodeURIComponent(timbre) +
    "&chords=" + encodeURIComponent(prog) + (arp ? "&style=arp" : ""))
    .then(function (r) {
      if (!r.ok) throw new Error("样本合成失败（" + r.status + "）");
      return r.blob();
    })
    .then(function (blob) {
      if (audPlayingId !== timbre) return; // 已切走：丢弃
      var url = URL.createObjectURL(blob);
      audAudioEl = new Audio(url);
      audAudioEl.onended = function () { stopTimbreDemo(); URL.revokeObjectURL(url); };
      audAudioEl.onerror = function () { stopTimbreDemo(); URL.revokeObjectURL(url); flashHint("样本播放失败"); };
      audAudioEl.play().catch(function () { stopTimbreDemo(); flashHint("浏览器阻止了自动播放 —— 再点一次"); });
    })
    .catch(function (e) {
      stopTimbreDemo();
      flashHint("试听失败：" + e);
    });
}

document.getElementById("timbreBtn").onclick = openTimbre;
document.getElementById("audioScrim").onclick = closeTimbre;
(function () {
  var styleBtn = document.getElementById("audStyle");
  if (!styleBtn) return;
  styleBtn.onclick = function () {
    styleBtn.classList.toggle("on");
    styleBtn.textContent = styleBtn.classList.contains("on") ? "琶音 ✓" : "琶音";
    stopTimbreDemo();
  };
  var progSel = document.getElementById("audProg");
  if (progSel) progSel.onchange = function () { stopTimbreDemo(); };
})();

// ---- 派生池面板（v0.5.11：预算继承 + 池化重档的观测面） ----
var spwExpanded = {}; // id → true（展开态，刷新时保留）
function openSpawns() {
  document.getElementById("spawnPane").classList.add("on");
  document.getElementById("spawnScrim").classList.add("on");
  refreshSpawns();
}
function closeSpawns() {
  document.getElementById("spawnPane").classList.remove("on");
  document.getElementById("spawnScrim").classList.remove("on");
}
function spwAgo(iso) {
  var t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  var s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + "s 前";
  if (s < 3600) return Math.floor(s / 60) + "m 前";
  if (s < 86400) return Math.floor(s / 3600) + "h 前";
  return Math.floor(s / 86400) + "d 前";
}
function spwRow(r, depth) {
  var dot = r.legacy ? "legacy" : (r.ok ? "ok" : "fail");
  var bds = '';
  bds += '<span class="bd ' + esc(String(r.mode || "run")) + '">' + esc(String(r.mode || "run")) + '</span>';
  bds += '<span class="bd">d' + esc(String(r.depth ?? "?")) + '</span>';
  if (r.budget !== undefined && r.budget !== null) bds += '<span class="bd bud">◈ ' + esc(String(r.budget)) + '</span>';
  if (Number(r.reuse_count) > 0) bds += '<span class="bd reuse">♻ ×' + esc(String(r.reuse_count)) + '</span>';
  if (r.legacy) bds += '<span class="bd legacy">legacy</span>';
  var usage = r.usage;
  var l2 = '<div class="l2">' +
    '<span class="tm">' + esc(spwAgo(String(r.finished_at || r.spawned_at || ""))) + '</span>' +
    (usage && usage.tokens ? '<span class="tk">' + esc(String(usage.tokens)) + ' tok · ' + esc(String(usage.model_calls || 0)) + ' calls' + (usage.elapsed_ms ? ' · ' + (usage.elapsed_ms / 1000).toFixed(1) + 's' : '') + '</span>' : '') +
    '</div>';
  var open = !!spwExpanded[String(r.id)];
  var h = '<div class="spwrow' + (open ? " open" : "") + (r.ok ? "" : " failrow") + '" data-spw="' + esc(String(r.id)) + '" style="--ind:' + depth + '">';
  h += '<div class="l1"><span class="dot ' + dot + '" aria-hidden="true"></span>' +
       '<span class="gl" title="' + esc(String(r.goal || "")) + '">' + esc(String(r.goal || r.id)) + '</span>' +
       '<span class="bds">' + bds + '</span>' +
       '<button type="button" class="spwdel" data-del="' + esc(String(r.id)) + '" title="删除此派生（登记 + 目录，v0.5.13）" aria-label="删除 ' + esc(String(r.goal || r.id)) + '">🗑</button></div>' + l2;
  if (open) {
    h += '<div class="spwdetail">';
    h += '<div class="sm">' + (String(r.summary || "").trim() ? esc(String(r.summary)) : '（无摘要 —— 池化命中或旧版派生）') + '</div>';
    if (r.out) h += '<div class="pth">产物 <b data-out="' + esc(String(r.out)) + '">复制路径</b> ' + esc(String(r.out)) + '</div>';
    if (r.workspace) h += '<div class="pth">工作区 <b data-ws="' + esc(String(r.workspace)) + '">复制路径</b> ' + esc(String(r.workspace)) + '</div>';
    h += '</div>';
  }
  h += '</div>';
  var kids = Array.isArray(r.children) ? r.children : [];
  for (var i = 0; i < kids.length; i++) h += spwRow(kids[i], depth + 1);
  return h;
}
function refreshSpawns() {
  fetch("/api/spawns").then(function (r) { return r.json(); }).then(function (j) {
    if (!j || j.ok !== true) return;
    var st = j.stats || {};
    var sh = document.getElementById("spwStats");
    if (sh) sh.innerHTML =
      '<span>总派生 <b>' + esc(String(st.total ?? 0)) + '</b></span>' +
      '<span>成功 <b>' + esc(String(st.ok ?? 0)) + '</b></span>' +
      '<span class="warnstat">失败 <b>' + esc(String(st.failed ?? 0)) + '</b></span>' +
      '<span>复用命中 <b>' + esc(String(st.reuse_hits ?? 0)) + '</b></span>' +
      '<span>tokens 合计 <b>' + esc(String(st.tokens_total ?? 0)) + '</b></span>' +
      '<button type="button" class="spwclean" data-clean="failed" title="删除全部失败派生（登记 + 目录）">🧹 清理失败</button>' +
      '<button type="button" class="spwclean danger" data-clean="all" title="清空派生池（全部登记 + 目录，不可恢复）">重置池</button>';
    var body = document.getElementById("spwBody");
    // 统计条清理按钮（空态也要能清理 —— 孤儿目录不占 records 数）
    var statsEl = document.getElementById("spwStats");
    if (statsEl) {
      Array.prototype.forEach.call(statsEl.querySelectorAll("[data-clean]"), function (b) {
        b.onclick = function () {
          var mode = b.getAttribute("data-clean");
          var msg = mode === "all"
            ? "重置整个派生池？（全部登记 + 目录，不可恢复）"
            : "删除全部失败派生？（登记 + 目录）";
          if (!confirm(msg)) return;
          fetch("/api/spawns", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: mode })
          }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.ok) {
              flashHint("已清理 " + (j.removed ?? 0) + " 条（保留 " + (j.records_kept ?? 0) + " 条 · 目录 " + (j.dirs_removed ?? 0) + "）");
              spwExpanded = {};
              refreshSpawns();
            } else {
              flashHint("清理失败：" + ((j && j.errors && j.errors[0]) || (j && j.error) || "未知错误"));
            }
          }).catch(function (e) { flashHint("清理失败：" + e); });
        };
      });
    }
    if (!body) return;
    var recs = Array.isArray(j.records) ? j.records : [];
    if (recs.length === 0) {
      body.innerHTML = '<div class="spwempty">尚无派生记录 —— 直连专家经 agent_spawn 工具派生子组织（团队任务 run / 直连 ask），相似 goal 自动池化复用；每次派生登记在此（预算 / 用量 / 复用计数）。</div>';
      return;
    }
    var h = "";
    for (var i = 0; i < recs.length; i++) h += spwRow(recs[i], 0);
    body.innerHTML = h;
    // 交互：点击行展开/收起；复制路径按钮；行级删除；统计条清理
    Array.prototype.forEach.call(body.querySelectorAll(".spwrow"), function (row) {
      row.onclick = function (ev) {
        if (ev.target && (ev.target.hasAttribute("data-out") || ev.target.hasAttribute("data-ws") || ev.target.hasAttribute("data-del"))) return;
        var id = row.getAttribute("data-spw");
        spwExpanded[id] = !spwExpanded[id];
        refreshSpawns();
      };
    });
    Array.prototype.forEach.call(body.querySelectorAll("[data-out]"), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        copyText(b.getAttribute("data-out"));
        flashHint("产物路径已复制");
      };
    });
    Array.prototype.forEach.call(body.querySelectorAll("[data-ws]"), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        copyText(b.getAttribute("data-ws"));
        flashHint("工作区路径已复制");
      };
    });
    Array.prototype.forEach.call(body.querySelectorAll("[data-del]"), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var id = b.getAttribute("data-del");
        if (!confirm("删除此派生？（登记 + 目录，不可恢复）「" + id + "」")) return;
        fetch("/api/spawns", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [id] })
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok) {
            flashHint("已删除 1 条派生（保留 " + (j.records_kept ?? 0) + " 条）");
            delete spwExpanded[id];
            refreshSpawns();
          } else {
            flashHint("删除失败：" + ((j && j.error) || (j && j.errors && j.errors[0]) || "未知错误"));
          }
        }).catch(function (e) { flashHint("删除失败：" + e); });
      };
    });
  }).catch(function () {
    flashHint("派生池加载失败");
  });
}
document.getElementById("spawnBtn").onclick = openSpawns;
document.getElementById("spawnScrim").onclick = closeSpawns;

// ---- 巧 工具箱（v0.5.15：🗄 db · 🔎 symbols · 🛡 scan · 📦 治理件） ----
function openToolbox() {
  document.getElementById("toolboxPane").classList.add("on");
  document.getElementById("toolboxScrim").classList.add("on");
}
function closeToolbox() {
  document.getElementById("toolboxPane").classList.remove("on");
  document.getElementById("toolboxScrim").classList.remove("on");
}
function tbTab(sec) {
  for (const k of ["Db", "Sym", "Scan", "Gov"]) {
    document.getElementById("tbTab" + k).classList.toggle("on", k.toLowerCase() === sec.replace("db", "db").replace("sym", "sym").replace("scan", "scan").replace("gov", "gov"));
    document.getElementById("tbSec" + (k === "Db" ? "Db" : k)).hidden = (k.toLowerCase() !== sec);
  }
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function tbDbSchema() {
  const file = document.getElementById("tbDbFile").value.trim();
  const out = document.getElementById("tbDbOut");
  if (!file) { out.innerHTML = '<div class="schempty">先输入 .db 路径</div>'; return; }
  out.innerHTML = '<div class="schempty">加载中…</div>';
  fetch("/api/toolbox/db?file=" + encodeURIComponent(file)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = "";
    for (const t of j.tables || []) {
      h += '<div class="tbsym"><b>' + esc(t.name) + "</b> · " + String(t.rowCount == null ? "行数未抽查" : t.rowCount + " 行") + "<br><span class=\\"tbmeta\\">" + (t.columns || []).map(function (c) { return esc(c.name) + (String(c).indexOf("PK") >= 0 ? " 🔑" : ""); }).join(" · ") + "</span></div>";
    }
    if ((j.indexes || []).length) h += '<div class="tbmeta">索引：' + esc(j.indexes.join(" · ")) + "</div>";
    if ((j.views || []).length) h += '<div class="tbmeta">视图：' + esc(j.views.join(" · ")) + "</div>";
    out.innerHTML = h || '<div class="schempty">（库为空：无表）</div>';
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function tbDbQuery() {
  const file = document.getElementById("tbDbFile").value.trim();
  const sql = document.getElementById("tbDbSql").value.trim();
  const out = document.getElementById("tbDbOut");
  if (!file || !sql) { out.innerHTML = '<div class="schempty">file 与 SQL 都要填</div>'; return; }
  out.innerHTML = '<div class="schempty">查询中…</div>';
  fetch("/api/toolbox/db-query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: file, sql: sql }) })
    .then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + "</div>"; return; }
      let h = '<div class="tbmeta">' + j.row_count + " 行 · " + j.ms + "ms" + (j.truncated ? "（截断）" : "") + "</div>";
      if ((j.columns || []).length) h += '<div class="tbrow tbhdr">' + j.columns.map(function (c) { return "<b>" + esc(c) + "</b>"; }).join(" | ") + "</div>";
      for (const row of j.rows || []) h += '<div class="tbrow">' + row.map(function (c) { return esc(c === null ? "NULL" : c); }).join(" | ") + "</div>";
      out.innerHTML = h;
    }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function tbSymSearch() {
  const name = document.getElementById("tbSymName").value.trim();
  const out = document.getElementById("tbSymOut");
  if (!name) { out.innerHTML = '<div class="schempty">先输入符号名</div>'; return; }
  out.innerHTML = '<div class="schempty">查找中…</div>';
  fetch("/api/toolbox/symbols?name=" + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbmeta">索引 ' + j.files + " 文件 · " + j.symbols + " 符号</div>";
    if (!(j.defs || []).length) { h += '<div class="schempty">无定义命中</div>'; }
    for (const d of j.defs || []) h += '<div class="tbsym"><b>' + esc(d.kind) + "</b> " + esc(d.name) + " · <code>" + esc(d.file) + ":" + d.line + "</code><br><span class=\\"tbmeta\\">" + esc(d.snippet) + "</span></div>";
    if ((j.refs || []).length) {
      h += '<div class="tbmeta" style="margin-top:8px">引用 ' + j.refs.length + "：</div>";
      for (const r of j.refs.slice(0, 30)) h += '<div class="tbrow">' + esc(r.kind) + " · " + esc(r.file) + ":" + r.line + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function tbScan() {
  const out = document.getElementById("tbScanOut");
  const meta = document.getElementById("tbScanMeta");
  out.innerHTML = '<div class="schempty">扫描中…</div>';
  fetch("/api/toolbox/scan").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    meta.textContent = j.scanned + "/" + j.files + " 文件 · " + j.hits.length + " 命中 · " + j.tookMs + "ms · " + j.patterns + " 类模式";
    if (!(j.hits || []).length) { out.innerHTML = '<div class="schempty">✓ 未发现密钥模式</div>'; return; }
    let h = "";
    const order = { high: 0, medium: 1, low: 2 };
    const hits = j.hits.slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; });
    for (const hit of hits.slice(0, 100)) h += '<div class="tbsym"><b class="' + (hit.severity === "high" ? "spwc" : "") + '">[' + hit.severity.toUpperCase() + "]</b> " + esc(hit.pattern) + " · <code>" + esc(hit.file) + ":" + hit.line + "</code><br><span class=\\"tbmeta\\">" + esc(hit.preview) + "</span></div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function tbAudit() {
  const out = document.getElementById("tbGovOut");
  out.innerHTML = '<div class="schempty">打包中…</div>';
  fetch("/api/toolbox/audit", { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbsym">📦 ' + esc(j.zip) + " · " + j.entries + " 条目 · " + (j.bytes / 1024).toFixed(1) + " KB（工作区内，org audit CLI 同款）</div>";
    for (const r of (j.summary && j.summary.runs) || []) h += '<div class="tbrow">' + esc(r.name) + " · " + r.events + " 事件 · " + r.tokens + " tokens · " + (r.ok === null ? "—" : r.ok ? "ok" : "err") + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function tbSbom() {
  const out = document.getElementById("tbGovOut");
  out.innerHTML = '<div class="schempty">生成中…</div>';
  fetch("/api/toolbox/sbom").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbsym">📋 SPDX-2.3 · ' + (j.packages || []).length + " 组件</div>";
    for (const p of j.packages || []) h += '<div class="tbrow">' + esc(p.scope) + " · " + esc(p.name) + "@" + esc(p.version) + " · " + esc(p.license || "NOASSERTION") + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function tbOwners() {
  const out = document.getElementById("tbGovOut");
  out.innerHTML = '<div class="schempty">分析中…</div>';
  fetch("/api/toolbox/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: ["hsl/org.hsl", "lib/engine.ts", "web/entry.ts", "cli/org.ts"] }) })
    .then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
      let h = '<div class="tbsym">👥 ' + (j.from_codeowners ? "CODEOWNERS：" + esc(j.codeowners || "?") : "目录启发式（无 CODEOWNERS）") + "</div>";
      for (const rv of j.reviewers || []) h += '<div class="tbrow">@' + esc(rv.name) + " · 覆盖 " + rv.files_covered + " · " + esc(rv.reason) + "</div>";
      out.innerHTML = h;
    }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
document.getElementById("toolboxBtn").onclick = openToolbox;
document.getElementById("toolboxScrim").onclick = closeToolbox;

// ---- 🛡 治理与扩展面板（v0.5.16：IaC · 插件 · RBAC · OpenAPI · 浏览器 · 诊断 · 补全/重命名 · git） ----
function openGovex() {
  document.getElementById("govexPane").classList.add("on");
  document.getElementById("govexScrim").classList.add("on");
}
function closeGovex() {
  document.getElementById("govexPane").classList.remove("on");
  document.getElementById("govexScrim").classList.remove("on");
}
var GX_TABS = [["Iac", "iac"], ["Plug", "plug"], ["Rbac", "rbac"], ["Oapi", "oapi"], ["Web", "web"], ["Dbd", "dbd"], ["Code", "code"], ["Lsp", "lsp"], ["Git", "git"], ["Collab", "collab"], ["Cloud", "cloud"], ["Mobile", "mobile"]];
function gxTab(sec) {
  for (const [k, id] of GX_TABS) {
    document.getElementById("gxTab" + k).classList.toggle("on", id === sec);
    document.getElementById("gxSec" + k).hidden = (id !== sec);
  }
}
function gxPost(u, body) {
  return fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}
function gxIac() {
  const out = document.getElementById("gxIacOut"), meta = document.getElementById("gxIacMeta");
  out.innerHTML = '<div class="schempty">扫描中…</div>';
  fetch("/api/govex/iacscan").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    meta.textContent = j.scanned + "/" + j.files + " 候选文件 · " + j.hits.length + " 命中 · " + j.took_ms + "ms · " + j.rules + " 条规则" + (j.truncated ? "（截断）" : "");
    if (!(j.hits || []).length) { out.innerHTML = '<div class="schempty">✓ 未发现 IaC 风险模式</div>'; return; }
    let h = "";
    for (const hit of j.hits.slice(0, 100)) h += '<div class="tbsym"><b class="' + (hit.severity === "high" ? "spwc" : "") + '">[' + esc(hit.severity.toUpperCase()) + "]</b> " + esc(hit.ruleId) + " · <code>" + esc(hit.file) + ":" + hit.line + '</code><br><span class="tbmeta">' + esc(hit.message) + " 💡 " + esc(hit.hint) + "</span></div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxPlugRender(j) {
  let h = '<div class="tbmeta">' + esc(j.dir) + " · " + (j.plugins || []).length + " 个插件 · 只装不执行（permissions 与 RBAC 联动）</div>";
  if (!(j.plugins || []).length) { h += '<div class="schempty">（空 —— 上方输入源安装）</div>'; }
  for (const p of j.plugins || []) {
    const m = p.manifest;
    h += '<div class="tbsym">' + (p.valid ? "✓" : "✗") + " <b>" + esc(m ? m.name : p.path) + "</b>" + (m ? "@" + esc(m.version) + " · " + esc(m.description || "") : "（manifest 不可解析）") +
      (m && (m.permissions || []).length ? ' · <span class="tbmeta">权限 ' + esc((m.permissions || []).join(" ")) + "</span>" : "") +
      ' <button type="button" onclick="gxPlugRemove(\\'' + esc(m ? m.name : p.path) + '\\')">移除</button>' +
      ((p.problems || []).length ? '<br><span class="tbmeta">问题：' + esc((p.problems || []).join("；")) + "</span>" : "") + "</div>";
  }
  document.getElementById("gxPlugOut").innerHTML = h;
}
function gxPlugList() {
  document.getElementById("gxPlugOut").innerHTML = '<div class="schempty">加载中…</div>';
  fetch("/api/govex/plugins").then(function (r) { return r.json(); }).then(gxPlugRender).catch(function () { document.getElementById("gxPlugOut").innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxPlugInstall() {
  const source = document.getElementById("gxPlugSrc").value.trim();
  const out = document.getElementById("gxPlugOut");
  if (!source) { out.innerHTML = '<div class="schempty">先输入安装源（工作区内目录或 git URL）</div>'; return; }
  out.innerHTML = '<div class="schempty">安装中…（git 源最多 60s）</div>';
  gxPost("/api/govex/plugin-install", { source: source }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + "</div>"; return; }
    out.innerHTML = '<div class="tbsym">✓ 已安装 ' + esc(j.name) + "@" + esc(j.version) + "</div>" + ((j.warnings || []).length ? '<div class="tbrow">⚠ ' + esc((j.warnings || []).join("；")) + "</div>" : "");
    gxPlugList();
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxPlugRemove(name) {
  gxPost("/api/govex/plugin-remove", { name: name }).then(function (j) {
    if (!j.ok) { document.getElementById("gxPlugOut").innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + "</div>"; return; }
    gxPlugList();
  }).catch(function () { document.getElementById("gxPlugOut").innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxRbac() {
  const out = document.getElementById("gxRbacOut");
  out.innerHTML = '<div class="schempty">加载中…</div>';
  fetch("/api/govex/rbac").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbmeta">' + (j.policy_file ? "策略：" + esc(j.policy_file) : "内建兜底（" + esc(j.fallback_reason || "") + "）") + "</div>";
    for (const r of j.roles || []) {
      h += '<div class="tbsym"><b>' + esc(r.role) + "</b> · allow: " + esc((r.allow || []).join(" ") || "（空 → 默认全拒）") + " · deny: " + esc((r.deny || []).join(" ") || "（无）") + "</div>";
    }
    h += '<div class="tbrow">判定次序：未知角色拒 → deny 命中拒（优先）→ allow 命中放 → 默认拒</div>';
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxOapi(useText) {
  const out = document.getElementById("gxOapiOut");
  const body = useText ? { text: document.getElementById("gxOapiText").value } : { file: document.getElementById("gxOapiFile").value.trim() };
  if (useText && !body.text) { out.innerHTML = '<div class="schempty">先粘贴 spec JSON</div>'; return; }
  if (!useText && !body.file) { out.innerHTML = '<div class="schempty">先输入 spec 文件路径</div>'; return; }
  out.innerHTML = '<div class="schempty">解析中…</div>';
  gxPost("/api/govex/openapi", body).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbsym">🔌 ' + esc(j.info.title) + " v" + esc(j.info.version) + "（OpenAPI " + esc(j.version) + " · " + (j.operations || []).length + " 操作 · " + j.schemas + " schema）</div>";
    if ((j.servers || []).length) h += '<div class="tbmeta">servers：' + esc(j.servers.join(" · ")) + "</div>";
    for (const op of j.operations || []) {
      h += '<div class="tbrow"><b>' + esc(op.method) + "</b> " + esc(op.path) + " · " + esc(op.operationId) + (op.security ? " 🔒" : "") + " → 工具名 " + esc(op.tool_name) + (op.summary ? ' <span class="tbmeta">' + esc(op.summary.slice(0, 80)) + "</span>" : "") + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxWebSnapshot() {
  const url = document.getElementById("gxWebUrl").value.trim();
  const out = document.getElementById("gxWebOut");
  if (!url) { out.innerHTML = '<div class="schempty">先输入 URL（http/https）</div>'; return; }
  out.innerHTML = '<div class="schempty">快照中…（引擎链 agent-browser → chromium → chrome，最多 30s）</div>';
  gxPost("/api/govex/browser-snapshot", { url: url }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + (j.hint ? '<br><span class="tbmeta">' + esc(j.hint) + "</span>" : "") + "</div>"; return; }
    let h = '<div class="tbsym">🌐 ' + esc(j.url) + (j.final_url && j.final_url !== j.url ? " → " + esc(j.final_url) : "") + " · 引擎 " + esc(j.engine) + " · " + j.ms + "ms" + (j.title ? " · " + esc(j.title) : "") + "</div>";
    h += '<div class="tbrow">' + esc(String(j.text || "").slice(0, 4000)) + "</div>";
    if ((j.links || []).length) {
      h += '<div class="tbmeta" style="margin-top:6px">链接（' + j.links.length + "）：</div>";
      for (const l of j.links.slice(0, 20)) h += '<div class="tbrow">· ' + esc(String(l.text || "").slice(0, 40)) + " → " + esc(l.href) + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxWebScreenshot() {
  const url = document.getElementById("gxWebUrl").value.trim();
  const out = document.getElementById("gxWebOut");
  if (!url) { out.innerHTML = '<div class="schempty">先输入 URL（http/https）</div>'; return; }
  out.innerHTML = '<div class="schempty">截图中…（PNG 落工作区，最多 30s）</div>';
  gxPost("/api/govex/browser-screenshot", { url: url }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + (j.hint ? '<br><span class="tbmeta">' + esc(j.hint) + "</span>" : "") + "</div>"; return; }
    out.innerHTML = '<div class="tbsym">📸 ' + esc(j.url) + " → " + esc(j.path) + "（工作区内 · 引擎 " + esc(j.engine) + " · " + j.ms + "ms）</div>";
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxDbdiag() {
  const file = document.getElementById("gxDbdFile").value.trim();
  const sql = document.getElementById("gxDbdSql").value.trim();
  const out = document.getElementById("gxDbdOut");
  if (!file || !sql) { out.innerHTML = '<div class="schempty">file 与 SQL 都要填</div>'; return; }
  out.innerHTML = '<div class="schempty">诊断中…</div>';
  gxPost("/api/govex/dbdiag", { file: file, sql: sql }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbmeta">' + j.ms + "ms · " + (j.plan.steps || []).length + " 步骤 · " + (j.plan.fullScan ? "⚠ 含全表扫描" : "无全表扫描") + " · 涉及表 " + esc((j.plan.tables || []).join(" · ") || "（无）") + "</div>";
    for (const s of j.plan.steps || []) h += '<div class="tbrow">' + (s.usesIndex ? "🔑 " : "· ") + esc(s.detail) + "</div>";
    if ((j.suggestions || []).length) {
      h += '<div class="tbmeta" style="margin-top:6px">建议：</div>';
      for (const s of j.suggestions) h += '<div class="tbrow">- ' + esc(s) + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxComplete() {
  const file = document.getElementById("gxCplFile").value.trim();
  const line = document.getElementById("gxCplLine").value.trim() || "1";
  const col = document.getElementById("gxCplCol").value.trim() || "1";
  const out = document.getElementById("gxCplOut");
  if (!file) { out.innerHTML = '<div class="schempty">先输入文件路径</div>'; return; }
  out.innerHTML = '<div class="schempty">补全中…</div>';
  gxPost("/api/govex/complete", { file: file, line: Number(line), column: Number(col) }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbmeta">' + esc(j.language) + (j.prefix ? ' · 前缀 "' + esc(j.prefix) + '"' : "") + " · 行内容：" + esc(j.line_text || "") + "</div>";
    if (!(j.candidates || []).length) { h += '<div class="schempty">无候选 —— ' + esc(j.reason || "前缀无命中") + "</div>"; }
    for (const c of j.candidates || []) h += '<div class="tbrow">' + String(c.score).padStart(4) + " " + esc(c.kind) + " <b>" + esc(c.label) + "</b> · " + esc(c.source) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxRename() {
  const oldName = document.getElementById("gxRnOld").value.trim();
  const newName = document.getElementById("gxRnNew").value.trim();
  const apply = document.getElementById("gxRnApply").checked;
  const out = document.getElementById("gxRnOut");
  if (!oldName || !newName) { out.innerHTML = '<div class="schempty">旧名与新名都要填</div>'; return; }
  out.innerHTML = '<div class="schempty">' + (apply ? "真写中…（失败即停）" : "预览中…") + "</div>";
  gxPost("/api/govex/rename", { old: oldName, new: newName, apply: apply }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ 不可执行：' + esc(j.reason || "?") + ((j.warnings || []).length ? '<br><span class="tbmeta">' + esc((j.warnings || []).join("；")) + "</span>" : "") + "</div>"; return; }
    let h = '<div class="tbsym">' + (j.dry_run ? "🔍 dryRun 预览" : "✓ 已应用") + "：" + esc(j.definition.kind) + " " + esc(oldName) + " → " + esc(newName) + "（" + j.edits + " 处编辑 · " + j.files + " 文件）</div>";
    for (const w of j.warnings || []) h += '<div class="tbrow">⚠ ' + esc(w) + "</div>";
    if (j.dry_run) {
      for (const p of j.previews || []) {
        h += '<div class="tbmeta" style="margin-top:6px">--- ' + esc(p.file) + "（" + esc(p.stats) + "）</div>";
        for (const l of String(p.diff || "").split("\\n").slice(2, 26)) h += '<div class="tbrow">' + esc(l) + "</div>";
      }
      if (j.preview_truncated) h += '<div class="tbmeta">…（预览帽 5 文件，共 ' + j.files_total + " 文件）</div>";
    } else {
      for (const f of j.applied || []) h += '<div class="tbrow">✓ ' + esc(f.file) + "（" + f.lines + " 行 · " + f.occurrences + " 处）</div>";
      if (j.failed) h += '<div class="tbrow">✗ 止步于 ' + esc(j.failed.file) + "：" + esc(j.failed.error) + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxGitState() {
  const out = document.getElementById("gxGitOut");
  out.innerHTML = '<div class="schempty">探测中…</div>';
  fetch("/api/govex/gitstate").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || "?") + "</div>"; return; }
    const s = j.state;
    out.innerHTML = '<div class="tbsym">🌿 ' + esc(s.branch || "（detached HEAD）") + (s.upstream ? " → " + esc(s.upstream) + "（ahead " + s.ahead + " · behind " + s.behind + (s.diverged ? " · ⚠ 分叉" : "") + "）" : "（无上游）") + '</div><div class="tbrow">工作区 ' + (s.dirty ? "⚠ 有未提交改动" : "干净") + " · stash " + s.stashed + " 条</div>";
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
// ---- 🐞 LSP/DAP 调试区块（v0.5.17 · #26/#108 —— 与 CLI org lsp/debug 同源） ----
function gxLspDef() {
  const name = document.getElementById("gxLspName").value.trim();
  const out = document.getElementById("gxLspOut");
  if (!name) { out.innerHTML = '<div class="schempty">先输入符号名</div>'; return; }
  out.innerHTML = '<div class="schempty">查找定义中…（内置符号索引车道）</div>';
  fetch("/api/govex/lsp?action=definition&name=" + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || j.reason || "?") + "</div>"; return; }
    if (!(j.definitions || []).length) { out.innerHTML = '<div class="schempty">（空 —— ' + esc(j.reason || "符号未在索引中") + "）</div>"; return; }
    let h = '<div class="tbsym">🎯 ' + esc(j.name) + " —— " + j.definitions.length + " 处定义（" + esc(j.lane) + " 车道）</div>";
    for (const d of j.definitions) h += '<div class="tbrow"><code>' + esc(d.file) + ":" + d.line + ":" + d.column + "</code> · " + esc(d.kind) + ' · <span class="tbmeta">LSP ' + esc(d.lsp.uri) + " range " + d.lsp.range.start.line + ":" + d.lsp.range.start.character + '</span><br><span class="tbmeta">' + esc(d.snippet) + "</span></div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxLspRefs() {
  const name = document.getElementById("gxLspName").value.trim();
  const out = document.getElementById("gxLspOut");
  if (!name) { out.innerHTML = '<div class="schempty">先输入符号名</div>'; return; }
  out.innerHTML = '<div class="schempty">扫描引用中…</div>';
  fetch("/api/govex/lsp?action=references&name=" + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || j.reason || "?") + "</div>"; return; }
    const calls = (j.refs || []).filter(function (x) { return x.kind === "call"; }).length;
    let h = '<div class="tbsym">🔗 ' + esc(j.name) + " —— " + (j.refs || []).length + " 处引用（call " + calls + " · mention " + ((j.refs || []).length - calls) + "）+ " + j.definitions + " 处定义（定义行已排除）" + (j.truncated ? "（截断）" : "") + "</div>";
    if (!(j.refs || []).length) h += '<div class="schempty">（空 —— ' + esc(j.reason || "无引用") + "）</div>";
    for (const x of (j.refs || []).slice(0, 60)) h += '<div class="tbrow"><code>' + esc(x.file) + ":" + x.line + ":" + x.column + "</code> · " + esc(x.kind) + " · " + esc(x.snippet.slice(0, 80)) + "</div>";
    if ((j.refs || []).length > 60) h += '<div class="tbmeta">…（' + (j.refs.length - 60) + " 更多）</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxLspHover() {
  const name = document.getElementById("gxLspName").value.trim();
  const out = document.getElementById("gxLspOut");
  if (!name) { out.innerHTML = '<div class="schempty">先输入符号名</div>'; return; }
  out.innerHTML = '<div class="schempty">hover 中…</div>';
  fetch("/api/govex/lsp?action=hover&name=" + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || "?") + "</div>"; return; }
    if (!j.hover) { out.innerHTML = '<div class="schempty">💬 hover 为空 —— ' + esc(j.reason || "?") + "</div>"; return; }
    let h = '<div class="tbsym">💬 ' + esc(j.hover.kind) + " <b>" + esc(j.hover.name) + "</b> · <code>" + esc(j.hover.file) + ":" + j.hover.line + "</code></div>";
    for (const c of j.hover.contents || []) h += '<div class="tbrow">' + esc(c) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxLspServers() {
  const out = document.getElementById("gxLspSrvOut");
  out.innerHTML = '<div class="schempty">探测中…（which 探测 7 个已知 server）</div>';
  fetch("/api/govex/lsp?action=servers").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || "?") + "</div>"; return; }
    let h = '<div class="tbsym">🔎 可用 ' + j.available + "/" + (j.servers || []).length + "</div>";
    for (const s of j.servers || []) h += '<div class="tbrow">' + (s.available ? "✓" : "✗") + " <b>" + esc(s.name) + "</b>" + (s.path ? ' · <span class="tbmeta">' + esc(s.path) + "</span>" : "") + "</div>";
    if (j.note) h += '<div class="tbmeta">' + esc(j.note) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxLspProto() {
  const out = document.getElementById("gxLspSrvOut");
  out.innerHTML = '<div class="schempty">自检中…（纯内存分帧 roundtrip）</div>';
  fetch("/api/govex/lsp?action=protocol-selftest").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || "?") + "</div>"; return; }
    let h = '<div class="tbsym">🧪 ' + (j.ok ? "✓" : "✗") + " " + j.passed + "/" + j.total + " 通过</div>";
    for (const c of j.checks || []) h += '<div class="tbrow">' + (c.ok ? "✓" : "✗") + " " + esc(c.name) + (c.detail ? ' <span class="tbmeta">' + esc(c.detail) + "</span>" : "") + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxDebugDap() {
  const out = document.getElementById("gxLspSrvOut");
  out.innerHTML = '<div class="schempty">自检中…（DAP 构造器字段忠实性）</div>';
  fetch("/api/govex/debug?action=dap-selftest").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || "?") + "</div>"; return; }
    let h = '<div class="tbsym">🧪 ' + (j.ok ? "✓" : "✗") + " " + j.passed + "/" + j.total + " 通过</div>";
    for (const c of j.checks || []) h += '<div class="tbrow">' + (c.ok ? "✓" : "✗") + " " + esc(c.name) + (c.detail ? ' <span class="tbmeta">' + esc(c.detail) + "</span>" : "") + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxDebugSuggest() {
  const file = document.getElementById("gxDbgFile").value.trim();
  const out = document.getElementById("gxDbgOut");
  if (!file) { out.innerHTML = '<div class="schempty">先输入文件（工作区相对路径）</div>'; return; }
  out.innerHTML = '<div class="schempty">扫描断点建议中…</div>';
  fetch("/api/govex/debug?action=suggest&file=" + encodeURIComponent(file)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || j.reason || "?") + "</div>"; return; }
    let h = '<div class="tbsym">🐞 ' + esc(j.file) + "（" + esc(j.language) + " · " + j.lines + " 行 · " + (j.suggestions || []).length + " 处建议断点" + (j.truncated ? "（截断）" : "") + "）</div>";
    if (!(j.suggestions || []).length) h += '<div class="schempty">（空 —— ' + esc(j.reason || "?") + "）</div>";
    for (const s of j.suggestions || []) h += '<div class="tbrow"><code>' + String(s.line).padStart(4) + "</code> [" + (s.confidence === "symbol" ? "符号" : "启发") + "] " + esc(s.reason) + ' · <span class="tbmeta">' + esc(s.snippet.slice(0, 70)) + "</span></div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxDebugPlan() {
  const file = document.getElementById("gxDbgFile").value.trim();
  const out = document.getElementById("gxDbgOut");
  if (!file) { out.innerHTML = '<div class="schempty">先输入文件（工作区相对路径）</div>'; return; }
  out.innerHTML = '<div class="schempty">组织调试计划中…</div>';
  fetch("/api/govex/debug?action=plan&file=" + encodeURIComponent(file)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error || j.reason || "?") + "</div>"; return; }
    let h = '<div class="tbsym">📋 ' + esc(j.file) + "（" + j.suggestions + " 断点建议 · " + (j.steps || []).length + " 步 · " + (j.dap_messages || []).length + " 条 DAP 消息）</div>";
    for (const st of j.steps || []) h += '<div class="tbrow"><b>第 ' + st.step + " 步 · " + esc(st.title) + "</b><br><span class=\\"tbmeta\\">" + esc(st.detail) + "</span></div>";
    h += '<div class="tbmeta" style="margin-top:6px">DAP 消息序列（协议就绪）：</div>';
    for (const m of j.dap_messages || []) h += '<div class="tbrow"><code>seq=' + m.seq + " " + esc(m.command) + "</code></div>";
    if (j.roadmap) h += '<div class="tbmeta">⚠ ' + esc(j.roadmap) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxGitMerge() {
  const source = document.getElementById("gxGitSrc").value.trim();
  const out = document.getElementById("gxGitOut");
  if (!source) { out.innerHTML = '<div class="schempty">先输入源分支</div>'; return; }
  out.innerHTML = '<div class="schempty">merge 中…（冲突即自动 abort）</div>';
  gxPost("/api/govex/git-merge", { source: source }).then(function (j) {
    let h = j.ok ? '<div class="tbsym">✓ merge 完成</div>' : '<div class="tbsym">✗ merge 未完成（' + esc(j.kind || "?") + "）：" + esc(j.error || "") + "</div>";
    h += '<div class="tbrow">' + esc(String(j.output || "").trim().split("\\n")[0] || "") + "</div>";
    for (const c of j.conflicts || []) h += '<div class="tbrow">冲突：' + esc(c) + "</div>";
    if (!j.ok && j.kind === "conflict" && !j.aborted) h += '<div class="tbrow">⚠ abort 未成功：工作区仍处冲突态，需人工处理</div>';
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxGitRebase() {
  const onto = document.getElementById("gxGitSrc").value.trim();
  const out = document.getElementById("gxGitOut");
  if (!onto) { out.innerHTML = '<div class="schempty">先输入变基目标分支</div>'; return; }
  out.innerHTML = '<div class="schempty">rebase 中…（冲突即自动 abort）</div>';
  gxPost("/api/govex/git-rebase", { onto: onto }).then(function (j) {
    let h = j.ok ? '<div class="tbsym">✓ rebase 完成</div>' : '<div class="tbsym">✗ rebase 未完成（' + esc(j.kind || "?") + "）：" + esc(j.error || "") + "</div>";
    h += '<div class="tbrow">' + esc(String(j.output || "").trim().split("\\n")[0] || "") + "</div>";
    for (const c of j.conflicts || []) h += '<div class="tbrow">冲突：' + esc(c) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
// ---- 👥 团队协作（v0.5.17 · #87：线程 + 回复树 + @mention + 会话账本桥） ----
// XSS 纪律：全部用户文本经 esc() 转义后再进 innerHTML（与既有面板同最严口径）。
var gxCollabCurrent = ""; // 当前查看的线程 id（发帖/评论缺省目标）
function gxCollabWhoRender(j) {
  const who = document.getElementById("gxCollabWho");
  if (who) who.textContent = "身份：" + j.user + (j.display ? "（" + j.display + "）" : "") + " ← " + (j.source === "env" ? "环境变量" : j.source === "file" ? "身份文件" : "缺省 local");
}
function gxCollabLoad() {
  const out = document.getElementById("gxCollabOut");
  out.innerHTML = '<div class="schempty">加载中…</div>';
  fetch("/api/govex/collab?action=threads").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    gxCollabWhoRender(j.me || {});
    const s = j.summary || {};
    let h = '<div class="tbsym">👥 ' + s.threads + " 线程 · " + s.posts + " 帖（" + s.comments + " 评论）· " + s.users + " 位协作者" + (s.last_active ? " · 最后活动 " + String(s.last_active).replace("T", " ").slice(0, 19) : "") + "</div>";
    if (!(j.threads || []).length) { h += '<div class="schempty">（空 —— 上方输入线程 id 与文本发第一帖）</div>'; }
    for (const t of j.threads || []) {
      h += '<div class="tbsym"><b>' + esc(t.id) + "</b> · " + esc(t.title) + ' <span class="tbmeta">' + t.posts + " 帖（" + t.comments + " 评论）· " + esc((t.participants || []).join(", ")) + "</span>" +
        ' <button type="button" onclick="gxCollabFeed(\\'' + esc(t.id) + '\\')">查看</button></div>';
    }
    const users = j.collaborators || [];
    if (users.length) {
      h += '<div class="tbmeta" style="margin-top:6px">协作者（' + users.length + "）：</div>";
      for (const u of users.slice(0, 20)) h += '<div class="tbrow">· ' + esc(u.user) + " — " + u.posts + " 帖 · 活跃 " + String(u.last_active || "").replace("T", " ").slice(0, 19) + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCollabFeed(threadId) {
  gxCollabCurrent = threadId;
  const threadInput = document.getElementById("gxCollabThread");
  if (threadInput) threadInput.value = threadId;
  const out = document.getElementById("gxCollabOut");
  out.innerHTML = '<div class="schempty">读取中…</div>';
  fetch("/api/govex/collab?action=feed&thread=" + encodeURIComponent(threadId)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbsym">◆ 线程 ' + esc(j.thread) + " · " + (j.posts || []).length + " 帖" + (j.truncated ? "（超 2000 帖截断）" : "") + ' <button type="button" onclick="gxCollabLoad()">← 返回列表</button></div>';
    if (!(j.posts || []).length) { h += '<div class="schempty">（空线程）</div>'; }
    for (const p of j.posts || []) {
      const pad = "padding-left:" + (8 + (p.depth || 0) * 22) + "px";
      const kindMark = p.kind === "comment" ? "评论" : p.kind === "system" ? "系统" : "帖";
      const mentionMark = (p.mentions || []).length ? ' · <span class="tbmeta">@' + esc(p.mentions.join(" @")) + "</span>" : "";
      const replyMark = p.reply_to !== undefined ? " ↳ #" + p.reply_to : "";
      h += '<div class="tbrow" style="' + pad + '"><b>#' + p.seq + "</b> " + esc(p.user) + ' <span class="tbmeta">' + kindMark + replyMark + " · " + String(p.at || "").replace("T", " ").slice(0, 19) + "</span>" + mentionMark +
        '<br><span style="white-space:pre-wrap">' + esc(String(p.text || "").slice(0, 400)) + "</span>" +
        ' <button type="button" onclick="gxCollabQuote(' + p.seq + ')" title="评论这层">↳</button></div>';
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCollabQuote(seq) {
  const seqInput = document.getElementById("gxCollabSeq");
  if (seqInput) seqInput.value = String(seq);
  const textInput = document.getElementById("gxCollabCommentText");
  if (textInput) textInput.focus();
}
function gxCollabPost() {
  const thread = document.getElementById("gxCollabThread").value.trim();
  const text = document.getElementById("gxCollabText").value.trim();
  const out = document.getElementById("gxCollabOut");
  if (!thread || !text) { out.innerHTML = '<div class="schempty">先填线程 id 与发帖文本</div>'; return; }
  gxPost("/api/govex/collab", { action: "post", thread: thread, text: text }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    document.getElementById("gxCollabText").value = "";
    out.innerHTML = '<div class="tbsym">✓ 已发帖 ' + esc(j.thread) + " #" + j.seq + "（" + esc(j.user) + ((j.mentions || []).length ? " · 已提及 @" + esc(j.mentions.join(" @")) : "") + "）</div>";
    gxCollabFeed(j.thread);
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCollabComment() {
  const thread = (document.getElementById("gxCollabThread").value.trim() || gxCollabCurrent);
  const seqRaw = document.getElementById("gxCollabSeq").value.trim();
  const text = document.getElementById("gxCollabCommentText").value.trim();
  const out = document.getElementById("gxCollabOut");
  const seq = Math.floor(Number(seqRaw));
  if (!thread || !seqRaw || !Number.isFinite(seq) || !text) { out.innerHTML = '<div class="schempty">先填楼层 # 与评论文本</div>'; return; }
  gxPost("/api/govex/collab", { action: "comment", thread: thread, seq: seq, text: text }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    document.getElementById("gxCollabCommentText").value = "";
    out.innerHTML = '<div class="tbsym">✓ 已评论 ' + esc(j.thread) + " #" + j.seq + "（↳ #" + j.reply_to + " · " + esc(j.user) + "）</div>";
    gxCollabFeed(j.thread);
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCollabSetUser() {
  const userId = document.getElementById("gxCollabUser").value.trim();
  const out = document.getElementById("gxCollabOut");
  if (!userId) { out.innerHTML = '<div class="schempty">先输入用户 id（如 alice —— 小写字母/数字/连字符）</div>'; return; }
  gxPost("/api/govex/collab", { action: "user", user: userId }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    out.innerHTML = '<div class="tbsym">✓ 协作用户已切换：' + esc(j.user) + (j.display ? "（" + esc(j.display) + "）" : "") + "</div>";
    gxCollabLoad();
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCollabBridge() {
  const expert = document.getElementById("gxCollabBridgeExpert").value.trim();
  const out = document.getElementById("gxCollabOut");
  if (!expert) { out.innerHTML = '<div class="schempty">先输入专家名（如 notice-parser）</div>'; return; }
  out.innerHTML = '<div class="schempty">镜像中…（读单用户会话账本 → 团队线程，原账本字节不变）</div>';
  gxPost("/api/govex/collab", { action: "bridge", expert: expert }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    out.innerHTML = '<div class="tbsym">🌉 已镜像 ' + esc(j.expert) + "/" + esc(j.session) + " → 线程 " + esc(j.threadId) + "：" + j.mirrored + "/" + j.turns + " 轮（" + j.skipped + " 轮已镜像跳过 · 原账本字节不变）</div>";
    gxCollabFeed(j.threadId);
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}

// ---- ☁ 云生态面板（v0.5.17：#67/#68/#72/#74 —— 探测全景 · 模板生成器 · 白名单执行） ----
var gxCldTplText = ""; // 当前模板文本（复制按钮用）
function gxCloudProbe() {
  const out = document.getElementById("gxCloudOut"), meta = document.getElementById("gxCloudMeta");
  out.innerHTML = '<div class="schempty">探测中…（各 CLI which + 版本探活 + 守护进程/集群可达，5s 硬超时）</div>';
  fetch("/api/govex/cloud?action=probe").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    meta.textContent = j.took_ms + "ms · docker/ssh/k8s/tf/clis 五面";
    let h = "";
    const row = function (icon, name, p) {
      return '<div class="tbrow">' + icon + " <b>" + name + "</b> " + (p.available ? '<span class="spwc">✓ 在场' + (p.version ? "（" + esc(String(p.version).slice(0, 40)) + "）" : "") + "</span>" : "⬜ 缺席") + (p.daemonReachable !== undefined ? " · 守护进程 " + (p.daemonReachable ? "✓ 可达" : "✗ 不可达") : "") + (p.clusterReachable !== undefined ? " · 集群 " + (p.clusterReachable ? "✓ 可达" : "✗ 不可达") : "") + (p.reason ? ' · <span class="tbmeta">' + esc(String(p.reason).slice(0, 110)) + "</span>" : "") + "</div>";
    };
    h += row("🐳", "docker", j.docker);
    h += row("🔐", "ssh", j.ssh);
    h += row("☸", "kubectl", j.k8s);
    h += row("🏗", "terraform", j.terraform);
    h += '<div class="tbmeta" style="margin-top:6px">☁ 云 CLI（' + j.summary.clisAvailable + "/" + j.summary.clisTotal + " 家在场，悬停看安装指引）：</div>";
    for (const c of j.clis || []) {
      h += '<div class="tbrow"' + (c.available ? "" : ' title="' + esc(c.installHint) + '"') + ">" + (c.available ? '<span class="spwc">✓</span>' : "⬜") + " <b>" + esc(c.name) + "</b> " + (c.available ? esc(String(c.version || "").slice(0, 44)) : '<span class="tbmeta">' + esc(c.installHint.slice(0, 60)) + "</span>") + "</div>";
    }
    if (!(j.summary.dockerDaemon || j.summary.sshAvailable || j.summary.k8sCluster || j.summary.terraformAvailable || j.summary.clisAvailable > 0)) {
      h += '<div class="tbrow" style="margin-top:4px">⚠ 工具缺席环境 —— 模板车道即主车道（下方生成器：Dockerfile/compose/manifest/terraform/ssh-config + 命令计划）</div>';
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCloudOverview() {
  const out = document.getElementById("gxCloudOut");
  out.innerHTML = '<div class="schempty">加载中…</div>';
  fetch("/api/govex/cloud?action=overview").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbsym">☁ provider 全景：模型服务商 <b>' + j.modelProviders + "</b> 家（推理面）+ 云 CLI <b>" + j.cloudClis + "</b> 家（基建面）= <b>" + j.total + "</b> 面</div>";
    h += '<div class="tbmeta">模型：' + esc(j.providers.filter(function (p) { return !p.local; }).map(function (p) { return p.name; }).join(" · ")) + "</div>";
    h += '<div class="tbmeta">本地推理：' + esc(j.providers.filter(function (p) { return p.local; }).map(function (p) { return p.name; }).join(" · ")) + "（无需 key）</div>";
    h += '<div class="tbmeta">云 CLI：' + esc(j.clis.map(function (c) { return c.name + (c.available ? "✓" : ""); }).join(" · ")) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCloudTemplate(kind) {
  const out = document.getElementById("gxCloudTplOut"), meta = document.getElementById("gxCloudTplMeta");
  let url = "/api/govex/cloud?action=" + kind;
  if (kind === "dockerfile") url += "&project=" + encodeURIComponent(document.getElementById("gxCldDfType").value);
  if (kind === "manifest") url += "&kind=" + encodeURIComponent(document.getElementById("gxCldManifestKind").value);
  if (kind === "plan") url += "&intent=" + encodeURIComponent(document.getElementById("gxCldPlanIntent").value);
  out.innerHTML = '<div class="schempty">生成中…</div>';
  fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let text = "", title = "";
    if (kind === "dockerfile") { text = j.dockerfile; title = "Dockerfile（" + j.project_type + " 型 · 多阶段 · 非 root · healthcheck）"; }
    else if (kind === "compose") { text = j.compose; title = "docker-compose.yml（服务 · 专用网络 · 具名卷 · healthcheck）"; }
    else if (kind === "manifest") { text = j.manifest; title = j.kind + "（apiVersion " + j.api_version + "）"; }
    else if (kind === "terraform") { text = j.mainTf; title = "main.tf（provider " + j.provider + "）"; }
    else if (kind === "ssh-template") { text = j.config + "\\n# 安全建议：\\n" + j.advice.map(function (a) { return "# - " + a; }).join("\\n"); title = "~/.ssh/config 片段模板"; }
    else if (kind === "plan") { text = j.steps.map(function (s, i) { return (i + 1) + ". " + s.cmd + "\\n   # " + s.note; }).join("\\n\\n") + (j.warning ? "\\n\\n⚠ " + j.warning : ""); title = "docker 命令计划（意图 " + j.action + "）"; }
    gxCldTplText = text;
    meta.textContent = title + " · " + (j.notes || []).length + " 条要点（模板尾注）";
    let h = "<div class=\\"tbsym\\">" + esc(title) + "</div>";
    h += '<pre style="margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:11px/1.5 var(--mono);color:var(--fg)">' + esc(text) + "</pre>";
    for (const n of j.notes || []) h += '<div class="tbmeta">💡 ' + esc(n) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxCloudCopy() {
  const meta = document.getElementById("gxCloudTplMeta");
  if (!gxCldTplText) { meta.textContent = "先在上方生成一个模板"; return; }
  const done = function () { meta.textContent = "✓ 已复制到剪贴板（" + gxCldTplText.length + " 字符）"; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(gxCldTplText).then(done, function () { gxCloudCopyFallback(done); });
  } else gxCloudCopyFallback(done);
}
function gxCloudCopyFallback(done) {
  // 降级车道：临时 textarea + execCommand（非安全上下文无 clipboard API）
  const ta = document.createElement("textarea");
  ta.value = gxCldTplText; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { document.getElementById("gxCloudTplMeta").textContent = "✗ 复制失败 —— 手动选择模板文本复制"; }
  document.body.removeChild(ta);
}
function gxCloudRun(lane) {
  const out = document.getElementById("gxCloudRunOut");
  let body;
  if (lane === "docker") {
    const args = document.getElementById("gxCldDockerArgs").value.trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) { out.innerHTML = '<div class="schempty">先输入 docker 参数（如：ps -a）</div>'; return; }
    body = { action: "docker", args: args };
  } else if (lane === "ssh") {
    const host = document.getElementById("gxCldSshHost").value.trim();
    const command = document.getElementById("gxCldSshCmd").value.trim();
    if (!host || !command) { out.innerHTML = '<div class="schempty">host 与命令都要填（host 须在 <工作区>/ssh-hosts.allow）</div>'; return; }
    body = { action: "ssh", host: host, command: command };
  } else {
    const args = document.getElementById("gxCldK8sArgs").value.trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) { out.innerHTML = '<div class="schempty">先输入 kubectl 参数（如：get pods -n prod）</div>'; return; }
    body = { action: "k8s", args: args };
  }
  out.innerHTML = '<div class="schempty">执行中…（数组参数 · 白名单门控 · 30s 硬超时）</div>';
  gxPost("/api/govex/cloud", body).then(function (j) {
    if (!j.ok) {
      const kindText = { denied: "白名单拒绝（未执行）", "tool-absent": "CLI 缺席（用模板车道）", "host-not-allowed": "host 未获放行（ssh-hosts.allow）", jail: "路径越界（工作区监狱）", timeout: "超时", failed: "退出码非 0" };
      out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(kindText[j.kind] || "") + " —— " + esc(j.reason || "") + "</div>";
      return;
    }
    let h = '<div class="tbsym">✓ ' + esc(lane) + " 执行成功（" + j.took_ms + "ms · argv 数组参数）</div>";
    h += '<div class="tbmeta">argv：' + esc(j.argv.join(" ").slice(0, 160)) + "</div>";
    const so = String(j.stdout || "").trim();
    if (so) h += '<pre style="margin:6px 0 0;white-space:pre-wrap;font:11px/1.5 var(--mono)">' + esc(so.slice(0, 6000)) + "</pre>";
    const se = String(j.stderr || "").trim();
    if (se) h += '<div class="tbmeta">（stderr）' + esc(se.slice(0, 1500)) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
// ---- 📱 移动端面板（v0.5.18：#117 —— 三面探测 · 设备清单 · logcat dump · 调试计划，只读动作） ----
function gxMobileProbe() {
  const out = document.getElementById("gxMobileOut"), meta = document.getElementById("gxMobileMeta");
  out.innerHTML = '<div class="schempty">探测中…（adb/aapt/scrcpy/idevice/flutter 五工具 which + 版本探活；缺席诚实降级）</div>';
  fetch("/api/govex/mobile?action=probe").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    const s = j.summary || {};
    meta.textContent = j.took_ms + "ms · Android " + (s.androidFace ? "✓" : "✗") + " · APK " + (s.apkFace ? "✓" : "✗") + " · iOS " + (s.iosFace ? "✓" : "✗") + " · 跨端 " + (s.crossFace ? "✓" : "✗");
    let h = "";
    const row = function (icon, name, f) {
      h += '<div class="tbrow">' + icon + " <b>" + name + "</b> " + (f.available ? '<span class="spwc">✓ 在场' + (f.version ? "（" + esc(String(f.version).slice(0, 40)) + "）" : "") + "</span>" : "⬜ 缺席") + (f.reason ? ' · <span class="tbmeta">' + esc(String(f.reason).slice(0, 110)) + "</span>" : "") + "</div>";
    };
    row("🤖", "adb", j.adb);
    row("📦", "aapt", j.aapt);
    row("📦", "aapt2", j.aapt2);
    row("🖼", "scrcpy", j.scrcpy);
    row("🍏", "ideviceinstaller", j.ideviceinstaller);
    row("🍏", "idevice_id", j.idevice_id);
    row("🦋", "flutter", j.flutter);
    h += '<div class="tbrow">SDK 根：' + esc(j.android_home || "未定位（adb 在 PATH 时无需定位）") + "</div>";
    if (s.facesUp === 0) h += '<div class="tbrow" style="margin-top:4px">⚠ 工具缺席环境 —— 调试计划（下方）是保底车道（纯函数永远可用）</div>';
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxMobileDevices() {
  const out = document.getElementById("gxMobileOut"), meta = document.getElementById("gxMobileMeta");
  out.innerHTML = '<div class="schempty">清单中…（adb devices -l · 未授权/offline 是诚实状态非失败）</div>';
  fetch("/api/govex/mobile?action=devices").then(function (r) { return r.json(); }).then(function (j) {
    const kindText = { "tool-absent": "adb CLI 缺席（安装指引见探测）", "no-device": "无设备", unauthorized: "未授权", "multi-device": "多设备", timeout: "超时", failed: "执行失败" };
    if (!j.ok) {
      out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(kindText[j.kind] || "") + " —— " + esc(String(j.reason || j.error || "").split("\\n")[0].slice(0, 200)) + "</div>";
      return;
    }
    meta.textContent = (j.devices || []).length + " 台 · 就绪 " + (j.ready ?? 0);
    let h = '<div class="tbsym">📱 Android 设备（' + (j.devices || []).length + " 台 · 就绪 " + (j.ready ?? 0) + "）</div>";
    for (const d of j.devices || []) {
      const stateCls = d.state === "device" ? "spwc" : "tbmeta";
      h += '<div class="tbrow"><b>' + esc(d.serial) + '</b> <span class="' + stateCls + '">' + esc(d.state) + "</span> " + esc([d.model, d.product, d.device].filter(Boolean).join(" · ") || "（无 -l 描述 —— 未授权/离线常见）") + (d.transport ? ' · <span class="tbmeta">' + esc(d.transport) + "</span>" : "") + "</div>";
    }
    if (!(j.devices || []).length) h += '<div class="schempty">（' + esc(String(j.reason || "无设备连接").slice(0, 200)) + "）</div>";
    const ios = j.ios || {};
    h += '<div class="tbmeta" style="margin-top:6px">🍏 iOS 面：' + esc(String(ios.note || "").slice(0, 160)) + "</div>";
    for (const u of ios.udids || []) h += '<div class="tbrow">　' + esc(u) + "</div>";
    h += '<div class="tbmeta">argv：' + esc((j.argv || []).join(" ")) + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxMobileLogcat() {
  const out = document.getElementById("gxMobLogcatOut");
  const tag = document.getElementById("gxMobTag").value.trim();
  const lines = document.getElementById("gxMobLines").value.trim();
  let url = "/api/govex/mobile?action=logcat";
  if (tag) url += "&tag=" + encodeURIComponent(tag);
  if (lines) url += "&lines=" + encodeURIComponent(lines);
  out.innerHTML = '<div class="schempty">抓取中…（adb logcat -d 快照 · 五元组解析）</div>';
  fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    const kindText = { "tool-absent": "adb CLI 缺席", "no-device": "无设备连接", unauthorized: "设备未授权", "multi-device": "多设备未指定 serial", timeout: "超时", failed: "执行失败" };
    if (!j.ok) {
      out.innerHTML = '<div class="schempty">✗ [' + esc(j.kind || "?") + "] " + esc(kindText[j.kind] || "") + " —— " + esc(String(j.reason || j.error || "").split("\\n")[0].slice(0, 200)) + "</div>";
      return;
    }
    let h = '<div class="tbsym">📜 logcat dump（' + (j.count ?? 0) + " 条 · 未匹配 " + (j.skipped ?? 0) + (j.truncated ? " · 截断" : "") + "）</div>";
    h += '<div class="tbmeta">argv：' + esc((j.argv || []).join(" ")) + "</div>";
    for (const e of (j.entries || []).slice(-25)) {
      h += '<div class="tbrow"><span class="tbmeta">' + esc(e.time) + "</span>  " + String(e.pid).padStart(6) + "  " + esc(e.level) + " <b>" + esc(e.tag) + "</b>: " + esc(String(e.message).slice(0, 120)) + "</div>";
    }
    if (!(j.entries || []).length) h += '<div class="schempty">（空 —— ' + esc(String(j.reason || "无匹配日志行").slice(0, 160)) + "）</div>";
    else if ((j.entries || []).length > 25) h += '<div class="tbmeta">…（仅示尾 25 条 / 共 ' + j.entries.length + " 条）</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxMobilePlan() {
  const plat = document.getElementById("gxMobPlat").value;
  const sym = document.getElementById("gxMobSym").value;
  const out = document.getElementById("gxMobPlanOut");
  out.innerHTML = '<div class="schempty">生成中…（纯函数 —— 零外部依赖永远可用）</div>';
  fetch("/api/govex/mobile?action=plan&platform=" + encodeURIComponent(plat) + "&symptom=" + encodeURIComponent(sym)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    let h = '<div class="tbsym">📋 调试计划（平台 ' + esc(j.platform) + " · 症状 " + esc(j.symptom) + " · " + (j.steps || []).length + " 步）</div>";
    for (const s of j.steps || []) {
      h += '<div class="tbrow" style="margin-top:6px">' + s.step + ". <b>" + esc(s.title) + "</b>" + (s.cmd ? ' — <code>' + esc(String(s.cmd).slice(0, 140)) + "</code>" : "") + "</div>";
      h += '<div class="tbmeta">　▸ 预期：' + esc(s.expect) + "</div>";
      h += '<div class="tbmeta">　↩ 降级：' + esc(s.degrade) + "</div>";
    }
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
function gxMobileSelftest() {
  const out = document.getElementById("gxMobileOut"), meta = document.getElementById("gxMobileMeta");
  out.innerHTML = '<div class="schempty">自检中…（解析器/计划器/魔数/socket 提取 —— 纯内存）</div>';
  fetch("/api/govex/mobile?action=selftest").then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok && !j.checks) { out.innerHTML = '<div class="schempty">✗ ' + esc(j.error) + "</div>"; return; }
    meta.textContent = j.passed + "/" + j.total + " 通过";
    let h = '<div class="tbsym">🧪 自检 ' + j.passed + "/" + j.total + "</div>";
    for (const c of j.checks || []) h += '<div class="tbrow">' + (c.ok ? "✓" : "✗") + " " + esc(c.name) + (c.detail ? ' <span class="tbmeta">（' + esc(c.detail) + "）</span>" : "") + "</div>";
    out.innerHTML = h;
  }).catch(function () { out.innerHTML = '<div class="schempty">✗ 请求失败</div>'; });
}
document.getElementById("govexBtn").onclick = openGovex;
document.getElementById("govexScrim").onclick = closeGovex;


// ---- 语音入口（v0.5.12：🎤 录音转写 ASR + 🔊 朗读 TTS + 🎙 设置面板） ----
var VOICE_META = ${JSON.stringify(VOICES)}; // 服务端注入声音清单（单一来源）
var voiceCfg = {
  voice: (function () { try { return localStorage.getItem("org.voice") || "tongtong"; } catch (e) { return "tongtong"; } })(),
  speed: (function () { var s = Number(localStorage.getItem("org.voiceSpeed")); return Number.isFinite(s) && s >= 0.5 && s <= 2 ? s : 1; })()
};
var micRec = null;          // MediaRecorder 实例（录音中）
var micChunks = [];         // 录音分片
var micStream = null;       // MediaStream（停止后关轨道）
var sayAudio = null;        // 当前朗读的 Audio（点击 ⏹ 停止）
var sayBtnActive = null;    // 播放中的朗读钮

function openVoice() {
  document.getElementById("voicePane").classList.add("on");
  document.getElementById("voiceScrim").classList.add("on");
  renderVoiceGrid();
  refreshVoiceStatus();
}
function closeVoice() {
  document.getElementById("voicePane").classList.remove("on");
  document.getElementById("voiceScrim").classList.remove("on");
}
function renderVoiceGrid() {
  var grid = document.getElementById("voGrid");
  if (!grid) return;
  var h = "";
  Object.keys(VOICE_META).forEach(function (k) {
    h += '<div class="vocard' + (k === voiceCfg.voice ? " on" : "") + '" data-voice="' + esc(k) + '" title="' + esc(VOICE_META[k]) + '">' +
         '<div class="nm">' + esc(k) + '</div><div class="ds">' + esc(VOICE_META[k]) + '</div>' +
         '<button type="button" class="voaud" data-voice="' + esc(k) + '" title="试听一句（v0.5.13）" aria-label="试听 ' + esc(k) + '">🔊</button></div>';
  });
  grid.innerHTML = h;
  Array.prototype.forEach.call(grid.querySelectorAll(".vocard"), function (card) {
    card.onclick = function () {
      voiceCfg.voice = card.getAttribute("data-voice");
      try { localStorage.setItem("org.voice", voiceCfg.voice); } catch (e) { /* 隐私模式 */ }
      renderVoiceGrid();
      flashHint("朗读声音已切换：" + VOICE_META[voiceCfg.voice]);
    };
  });
  Array.prototype.forEach.call(grid.querySelectorAll(".voaud"), function (aud) {
    aud.onclick = function (ev) { // 试听不切换选中（stopPropagation）
      ev.stopPropagation();
      previewVoice(aud.getAttribute("data-voice"), aud);
    };
  });
}
// v0.5.13：声音试听 —— 该声音合成一句自我介绍并播放（互斥：新试听先停旧）。
// 降级：401/凭据缺席 → 按钮复位 + 人话提示（不炸不卡）。
var voicePreview = { audio: null, btn: null };
function previewVoice(voice, btn) {
  if (!voice) return;
  if (voicePreview.audio) { try { voicePreview.audio.pause(); } catch (e) { /* 已结束 */ } voicePreview.audio = null; }
  if (voicePreview.btn) { voicePreview.btn.classList.remove("play", "busy"); voicePreview.btn.textContent = "🔊"; }
  var meta = VOICE_META[voice] || "";
  var text = "你好，我是" + voice + "。" + (meta ? meta.replace(/ · /g, "，") + "。" : "这是我的声音。");
  btn.classList.add("busy");
  btn.textContent = "…";
  fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text, voice: voice, speed: voiceCfg.speed })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || "HTTP " + r.status); });
    return r.arrayBuffer().then(function (ab) {
      var blob = new Blob([ab], { type: "audio/wav" });
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      voicePreview.audio = audio;
      voicePreview.btn = btn;
      btn.classList.remove("busy");
      btn.classList.add("play");
      btn.textContent = "▶";
      audio.onended = function () {
        btn.classList.remove("play");
        btn.textContent = "🔊";
        URL.revokeObjectURL(url);
        if (voicePreview.audio === audio) voicePreview.audio = null;
      };
      audio.play().catch(function (e) {
        btn.classList.remove("play");
        btn.textContent = "🔊";
        flashHint("试听播放失败：" + (e && e.message ? e.message : e));
      });
    });
  }).catch(function (e) {
    btn.classList.remove("busy", "play");
    btn.textContent = "🔊";
    flashHint("试听失败：" + (e && e.message ? e.message : e));
  });
}
function refreshVoiceStatus() {
  var dot = document.getElementById("voDot");
  var tx = document.getElementById("voStatusTx");
  if (!dot || !tx) return;
  tx.textContent = "探测中…";
  fetch("/api/voice-status").then(function (r) { return r.json(); }).then(function (j) {
    var ok = !!(j && j.sdk);
    dot.className = "dot " + (ok ? "ok" : "err");
    tx.textContent = ok
      ? "语音 SDK 就绪（" + (j.voices || 7) + " 种声音 · 凭据在首次调用时校验）"
      : String((j && j.error) || "语音服务未配置（凭据缺席）—— 文本交互不受影响");
  }).catch(function () {
    dot.className = "dot err";
    tx.textContent = "语音服务探测失败（服务不可达）";
  });
}
(function () {
  var slider = document.getElementById("voSpeed");
  var sval = document.getElementById("voSpeedVal");
  if (slider) {
    slider.value = String(voiceCfg.speed);
    if (sval) sval.textContent = "×" + Number(voiceCfg.speed).toFixed(2);
    slider.oninput = function () {
      voiceCfg.speed = Number(slider.value) || 1;
      if (sval) sval.textContent = "×" + voiceCfg.speed.toFixed(2);
      try { localStorage.setItem("org.voiceSpeed", String(voiceCfg.speed)); } catch (e) { /* 忽略 */ }
    };
  }
  var probe = document.getElementById("voProbe");
  if (probe) probe.onclick = refreshVoiceStatus;
})();
document.getElementById("voiceBtn").onclick = openVoice;
document.getElementById("voiceScrim").onclick = closeVoice;

// ---- 🔊 朗读（TTS：mact-say 按钮 → /api/tts → 播放；缓存命中即时） ----
function stopSpeaking() {
  if (sayAudio) { try { sayAudio.pause(); } catch (e) { /* 忽略 */ } sayAudio = null; }
  if (sayBtnActive) {
    sayBtnActive.classList.remove("playing", "busy");
    sayBtnActive.textContent = "🔊";
    sayBtnActive = null;
  }
}
function speakText(text, btn) {
  if (!text) { flashHint("无可朗读内容（空回复）"); return; }
  if (sayBtnActive === btn) { stopSpeaking(); return; } // 再点 = 停止
  stopSpeaking();
  // 复位辅助：busy 态可能未被 stopSpeaking 覆盖（sayBtnActive 尚未赋值就失败）
  function resetBtn() {
    btn.classList.remove("busy", "playing");
    btn.textContent = "🔊";
  }
  btn.classList.add("busy");
  btn.textContent = "…";
  fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 4096), voice: voiceCfg.voice, speed: voiceCfg.speed })
  }).then(function (r) {
    if (!r.ok) {
      return r.json().catch(function () { return { error: "合成失败（HTTP " + r.status + "）" }; })
        .then(function (j) { throw new Error(j.error || "合成失败"); });
    }
    var truncated = r.headers.get("X-Voice-Truncated") === "1";
    var chunks = Number(r.headers.get("X-Voice-Chunks") || 1);
    return r.blob().then(function (blob) { return { blob: blob, truncated: truncated, chunks: chunks }; });
  }).then(function (o) {
    var url = URL.createObjectURL(o.blob);
    sayAudio = new Audio(url);
    sayBtnActive = btn;
    btn.classList.remove("busy");
    btn.classList.add("playing");
    btn.textContent = "⏹";
    sayAudio.onended = function () { URL.revokeObjectURL(url); stopSpeaking(); };
    sayAudio.onerror = function () { URL.revokeObjectURL(url); stopSpeaking(); flashHint("朗读播放失败"); };
    sayAudio.play().catch(function () {
      URL.revokeObjectURL(url);
      stopSpeaking();
      flashHint("浏览器阻止了自动播放 —— 再点一次 🔊");
    });
    if (o.truncated) flashHint("已朗读前 4096 字（更长内容诚实截断）");
    else if (o.chunks > 1) flashHint("分段合成 " + o.chunks + " 段已拼接");
  }).catch(function (e) {
    resetBtn(); // busy 态复位（降级路径按钮不可卡死）
    flashHint("朗读失败：" + (e && e.message ? e.message : e));
  });
}

// ---- 🎤 录音转写（MediaRecorder → base64 → /api/asr → 输入框） ----
(function () {
  var btn = document.getElementById("micBtn");
  if (!btn) return;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) {
    btn.hidden = true; // 浏览器不支持录音：降级隐藏（不打扰文本交互）
    return;
  }
  function micSetTx(text, spin) {
    var bar = document.getElementById("micTx");
    var tx = document.getElementById("micTxText");
    if (!bar || !tx) return;
    if (!text) { bar.hidden = true; return; }
    bar.hidden = false;
    tx.textContent = text;
    bar.querySelector(".sp").textContent = spin ? SPIN[0] : "";
  }
  var spinTimer = null;
  function micSpin(on) {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    if (!on) return;
    var i = 0;
    spinTimer = setInterval(function () {
      var el = document.querySelector("#micTx .sp");
      if (el) el.textContent = SPIN[(i++) % SPIN.length];
    }, 120);
  }
  btn.onclick = function () {
    if (micRec && micRec.state === "recording") {
      try { micRec.stop(); } catch (e) { /* 忽略 */ }
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStream = stream;
      micChunks = [];
      micRec = new MediaRecorder(stream);
      micRec.ondataavailable = function (ev) { if (ev.data && ev.data.size > 0) micChunks.push(ev.data); };
      micRec.onstop = function () {
        btn.classList.remove("rec");
        btn.textContent = "🎤";
        if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
        var blob = new Blob(micChunks, { type: (micRec && micRec.mimeType) || "audio/webm" });
        micChunks = [];
        if (blob.size < 1200) { // 极小 = 没说话（webm 头就 ~几百字节）
          micSetTx("", false);
          flashHint("录音太短（未录到语音）");
          return;
        }
        micSetTx("转写中…（" + Math.round(blob.size / 1024) + "KB）", true);
        micSpin(true);
        var fr = new FileReader();
        fr.onload = function () {
          var b64 = String(fr.result).replace(/^data:[^,]*,/, "");
          fetch("/api/asr", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio_base64: b64 })
          }).then(function (r) { return r.json(); }).then(function (j) {
            micSpin(false);
            micSetTx("", false);
            if (j && j.ok && j.text) {
              var q = document.getElementById("question");
              var cur = q.value.trim();
              q.value = cur ? cur + " " + j.text : j.text;
              q.focus();
              q.dispatchEvent(new Event("input", { bubbles: true }));
              flashHint("已转写 " + j.chars + " 字（回车发送）");
            } else {
              flashHint("转写失败：" + ((j && j.error) || "未知错误"));
            }
          }).catch(function (e) {
            micSpin(false);
            micSetTx("", false);
            flashHint("转写失败：" + e);
          });
        };
        fr.onerror = function () { micSpin(false); micSetTx("", false); flashHint("录音读取失败"); };
        fr.readAsDataURL(blob);
      };
      micRec.start();
      btn.classList.add("rec");
      btn.textContent = "⏺";
      flashHint("录音中 —— 再点 🎤 结束并转写");
    }).catch(function (e) {
      flashHint("麦克风不可用：" + (e && e.message ? e.message : "权限拒绝"));
    });
  };
})();

// ---- 📷 图片分析（v0.5.13：file picker → base64 → /api/vision → 描述追加进输入框） ----
// 与 🎤 转写同构（分析 → 引用闭环）：多选 ≤4 张，浮条 + 琥珀脉冲按钮，
// 失败诚实提示（含 401 remedy），成功追加 🖼 前缀描述并可继续编辑后回车派单。
(function () {
  var btn = document.getElementById("visBtn");
  var file = document.getElementById("visFile");
  if (!btn || !file) return;
  var busy = false;
  function setTx(text, spin) {
    var bar = document.getElementById("visTx");
    var tx = document.getElementById("visTxText");
    if (!bar || !tx) return;
    if (!text) { bar.hidden = true; return; }
    bar.hidden = false;
    tx.textContent = text;
    bar.querySelector(".sp").textContent = spin ? SPIN[0] : "";
  }
  var spinT = null;
  function spin(on) {
    if (spinT) { clearInterval(spinT); spinT = null; }
    if (!on) return;
    var i = 0;
    spinT = setInterval(function () {
      var el = document.querySelector("#visTx .sp");
      if (el) el.textContent = SPIN[(i++) % SPIN.length];
    }, 120);
  }
  function reset() { // 复位（含 busy —— 降级路径按钮不可卡死）
    busy = false;
    btn.classList.remove("busy");
    spin(false);
    setTx("", false);
  }
  btn.onclick = function () { if (!busy) file.click(); };
  file.onchange = function () {
    if (busy) { file.value = ""; return; }
    var files = Array.from(file.files || []);
    file.value = ""; // 立即清空（同名重选可再触发）
    if (files.length === 0) return;
    if (files.length > 4) { flashHint("图片过多（" + files.length + " > 4 张上限）"); return; }
    var readers = files.map(function (f) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res({ dataUrl: String(fr.result), kb: Math.round(f.size / 1024) }); };
        fr.onerror = function () { rej(new Error("读取失败：" + f.name)); };
        fr.readAsDataURL(f);
      });
    });
    busy = true;
    btn.classList.add("busy");
    Promise.all(readers).then(function (imgs) {
      setTx("分析中…（" + imgs.length + " 张 · " + imgs.reduce(function (a, b) { return a + b.kb; }, 0) + "KB）", true);
      spin(true);
      var single = imgs.length === 1;
      var body = single
        ? { image_base64: imgs[0].dataUrl }
        : { images: imgs.map(function (m) { return { base64: m.dataUrl }; }) };
      return fetch("/api/vision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); }).then(function (j) {
        reset();
        if (j && j.ok && j.text) {
          var q = document.getElementById("question");
          var cur = q.value.trim();
          var add = (imgs.length > 1 ? "🖼×" + imgs.length + " " : "🖼 ") + j.text.trim();
          q.value = cur ? cur + "\\n" + add : add; // 模板内双反斜杠 n → 输出字面换行转义
          q.focus();
          q.dispatchEvent(new Event("input", { bubbles: true }));
          flashHint("已分析 " + j.chars + " 字 · " + imgs.length + " 图（可编辑后回车发送）");
        } else {
          flashHint("分析失败：" + ((j && j.error) || "未知错误"));
        }
      });
    }).catch(function (e) {
      reset();
      flashHint("图片分析失败：" + (e && e.message ? e.message : e));
    });
  };
})();

// ---- Esc 关闭当前面板（v0.5.9：所有 dialog/scrim 类面板统一口径） ----
// 顺序：最后打开的先关（栈式）。输入框内 Esc 已有既有语义（停止运行）的
// 不受影响 —— 这里只处理「有面板打开」的情形。
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Escape") return;
  var panes = [
    { pane: "searchPane", close: closeSearch },
    { pane: "audioPane", close: closeTimbre },
    { pane: "spawnPane", close: closeSpawns },
    { pane: "voicePane", close: closeVoice },
    { pane: "toolboxPane", close: closeToolbox },
    { pane: "govexPane", close: closeGovex },
    { pane: "tasksPane", close: closeTasks },
    { pane: "schedPane", close: closeSched },
    { pane: "notifyPane", close: closeNotify },
    { pane: "memoryPane", close: closeMemory },
    { pane: "providersPane", close: closeProviders },
    { pane: "approvalPane", close: closeApprovals },
  ];
  for (var i = 0; i < panes.length; i++) {
    var el = document.getElementById(panes[i].pane);
    if (el && el.classList.contains("on")) {
      ev.preventDefault();
      ev.stopPropagation();
      panes[i].close();
      return;
    }
  }
}, true); // 捕获阶段：先于输入框的 esc 停止语义（有面板时面板优先）
(function () {
  var inp = document.getElementById("schQuery");
  if (!inp) return;
  inp.oninput = function () {
    if (schTimer) clearTimeout(schTimer);
    schTimer = setTimeout(runSearch, 300); // 防抖 300ms
  };
  inp.onkeydown = function (ev) {
    if (ev.key === "Enter") {
      if (schTimer) clearTimeout(schTimer);
      runSearch();
    }
  };
  var kSel = document.getElementById("schK");
  if (kSel) kSel.onchange = runSearch;
})();

document.getElementById("tasksBtn").onclick = openTasks;
document.getElementById("tasksScrim").onclick = closeTasks;
document.getElementById("schedBtn").onclick = openSched;
document.getElementById("schedScrim").onclick = closeSched;
document.getElementById("notifyBtn").onclick = openNotify;
document.getElementById("notifyScrim").onclick = closeNotify;
notifyBadgeRefresh();
setInterval(function () {
  connTick++;
  if (connGate(connTick)) notifyBadgeRefresh();
}, 5000); // 铃铛徽标 5s 轮询（断连时降频一半）

// ---- 模型车道/服务商面板（v0.5.1：org providers / org config 的 GUI 面） ----

var providersState = { rows: [], env: [], lanes: {}, default_lane: "", presets: [], ledger: null, testing: "" };

function openProviders() {
  document.getElementById("providersPane").classList.add("on");
  document.getElementById("providersScrim").classList.add("on");
  renderProvidersPane();
}

function closeProviders() {
  document.getElementById("providersPane").classList.remove("on");
  document.getElementById("providersScrim").classList.remove("on");
}

function loadProviders(then) {
  api("/api/providers").then(function (r) {
    if (!r || !r.ok) { flashHint((r && r.error) || "providers 读取失败"); return; }
    providersState.rows = r.rows || [];
    providersState.env = r.env || [];
    providersState.lanes = r.lanes || {};
    providersState.default_lane = r.default_lane || "";
    providersState.presets = r.presets || [];
    providersState.ledger = r.ledger || null;
    providersState.budget = r.budget || null;   // v0.5.5 预算水位
    providersState.pool = r.pool || [];         // v0.5.5 key 池健康
    if (then) then();
    renderProvidersPane();
  }).catch(function (e) { flashHint("providers 读取失败：" + e); });
}

function laneRowsHtml() {
  var names = Object.keys(providersState.lanes);
  if (names.length === 0) return '<div class="pvempty">（无命名车道 —— 下方选择服务商预设一键创建）</div>';
  return names.map(function (n) {
    var l = providersState.lanes[n];
    var mark = providersState.default_lane === n ? "→ 缺省" : "";
    return '<div class="pvrow"><span class="nm">' + esc(n) + '</span>' +
      '<span class="meta">' + esc(l.model || "（未设模型）") + ' · key×' + l.keys +
      (l.fallbacks && l.fallbacks.length ? ' · <span class="fb">降级→ ' + esc(l.fallbacks.join(",")) + '</span>' : "") +
      '</span><span class="mark">' + mark + '</span>' +
      '<span style="margin-left:auto;display:flex;gap:6px">' +
      (providersState.default_lane === n ? "" : '<button data-pvuse="' + esc(n) + '">设为缺省</button>') +
      '<button data-pvtest="' + esc(n) + '">测试</button>' +
      '<button data-pvrm="' + esc(n) + '" class="danger" style="color:var(--redb)">删除</button>' +
      '</span></div>';
  }).join("");
}

function envRowsHtml() {
  if (providersState.env.length === 0) return "";
  return '<div class="pvsec"><div class="st">环境变量发现（shell 已 export 的服务商 key）</div>' +
    providersState.env.map(function (d) {
      return '<div class="pvrow"><span class="nm">' + esc(d.provider) + '</span>' +
        '<span class="meta">← ' + esc(d.envName) + '</span>' +
        '<button data-pvuse="' + esc(d.provider) + '" style="margin-left:auto">设为缺省</button></div>';
    }).join("") +
    '<div class="pvacts"><button id="pvAuto" class="pri">为全部发现的服务商创建车道（auto）</button></div></div>';
}

function ledgerHtml() {
  var l = providersState.ledger;
  var wm = providersState.budget;
  var pool = providersState.pool || [];
  if ((!l || !l.total) && (!wm || !wm.budget) && pool.length === 0) return "";
  var out = "";
  if (l && l.total) {
    out += '<div class="pvsec"><div class="st">调用台账（本地路由器 · key 轮换归因）</div>' +
      '<div class="pvrow"><span class="meta">总 ' + l.total + '（ok ' + l.ok + ' · 失败 ' + l.failed +
      '） · 今日 ' + l.today + '（ok ' + l.today_ok + '）</span></div></div>';
  }
  if (wm && wm.budget > 0) { // v0.5.5：预算水位条（三端渲染之 Web 端）
    var pct = Math.min(100, Math.round((wm.used / wm.budget) * 100));
    var cells = "";
    for (var i = 0; i < 10; i++) cells += i < Math.round(pct / 10) ? "█" : "░";
    out += '<div class="pvsec"><div class="st">今日预算水位</div>' +
      '<div class="pvrow"><span class="meta" style="color:' + (wm.exceeded ? "var(--redb)" : pct >= 80 ? "#fbbf24" : "var(--greenb)") + '">' +
      cells + " " + wm.used + "/" + wm.budget + "（剩 " + wm.remaining + "）" +
      (wm.exceeded ? " · 已超额（路由器 429）" : "") + "</span></div></div>";
  }
  if (pool.length > 0) { // v0.5.5：key 池健康（跨进程冷却）
    var prows = "";
    pool.forEach(function (pv) {
      pv.keys.forEach(function (k) {
        prows += '<div class="pvrow"><span class="meta">' + esc(pv.lane) + " · " + esc(k.key_id) +
          '</span><span class="meta" style="color:' + (k.cooling ? "#fbbf24" : "var(--greenb)") + '">' +
          (k.cooling ? "冷却中" : "可用") + " · 连败 " + k.fails + " · 上次 " + esc(k.last_status) +
          "</span></div>";
      });
    });
    out += '<div class="pvsec"><div class="st">key 池状态（runtime/llm-pool.json · 跨进程共享冷却）</div>' + prows + "</div>";
  }
  return out;
}

function renderProvidersPane() {
  var pane = document.getElementById("providersPane");
  if (!pane.classList.contains("on")) return;
  var opts = providersState.presets.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("");
  var rows = providersState.rows || [];
  var configured = rows.filter(function (r) { return r.status !== "preset" || r.local || r.default; });
  pane.innerHTML =
    '<div class="pvhead"><span class="t" id="pvTitle">⚙ 模型车道 / 服务商</span>' +
    '<span class="s">org config · org providers 的 GUI 面（与 CLI 同一实现）</span>' +
    '<button onclick="closeProviders()" style="background:transparent;border:1px solid var(--border2);color:var(--text);font:600 11px var(--mono);padding:4px 9px;border-radius:3px;cursor:pointer;margin-left:12px">关闭</button></div>' +
    '<div class="pvsec"><div class="st">命名车道（chat / run / ask 的 --model 取值 · 缺省免旗标）</div>' + laneRowsHtml() +
    '<div class="pvtest" id="pvTestOut"></div></div>' +
    envRowsHtml() +
    '<div class="pvsec"><div class="st">新建 / 增强</div>' +
    '<div class="pvacts">' +
    '<select id="pvPreset">' + opts + "</select>" +
    '<button id="pvApply" class="pri">应用预设（建车道 + 设缺省）</button>' +
    '<input type="text" id="pvKeyInput" class="pvkey" placeholder="追加 api key（429 自动轮换）">' +
    '<button id="pvKeyAdd">加入 key 池</button>' +
    '<button id="pvKeyClear">清空池</button>' +
    "</div>" +
    '<div class="pvtest" style="color:var(--dim)">已注册 ' + providersState.presets.length +
    " 家服务商（OpenAI 兼容协议 · deepseek/openai/anthropic/gemini/groq/zhipu/qwen/…）</div></div>" +
    ledgerHtml();

  var el;
  el = document.getElementById("pvApply");
  if (el) el.onclick = function () {
    var name = (document.getElementById("pvPreset") || {}).value || "";
    if (!name) return;
    api("/api/config", { method: "POST", body: JSON.stringify({ action: "preset", name: name }) })
      .then(function (r) {
        if (!r || !r.ok) { flashHint((r && r.error) || "预设应用失败"); return; }
        flashHint("✓ 预设 " + name + " 已建为车道并设缺省（key 请补配）");
        loadProviders();
      }).catch(function (e) { flashHint("预设应用失败：" + e); });
  };
  el = document.getElementById("pvKeyAdd");
  if (el) el.onclick = function () {
    var key = ((document.getElementById("pvKeyInput") || {}).value || "").trim();
    if (!key) { flashHint("请先粘贴 api key"); return; }
    api("/api/config", { method: "POST", body: JSON.stringify({ action: "keys-add", key: key }) })
      .then(function (r) {
        if (!r || !r.ok) { flashHint((r && r.error) || "key 追加失败"); return; }
        flashHint("✓ key 池已有 " + r.keys + " 把（429/5xx 自动轮换）");
        document.getElementById("pvKeyInput").value = "";
        loadProviders();
      }).catch(function (e) { flashHint("key 追加失败：" + e); });
  };
  el = document.getElementById("pvKeyClear");
  if (el) el.onclick = function () {
    api("/api/config", { method: "POST", body: JSON.stringify({ action: "keys-clear" }) })
      .then(function () { flashHint("✓ key 池已清空"); loadProviders(); });
  };
  el = document.getElementById("pvAuto");
  if (el) el.onclick = function () {
    api("/api/config", { method: "POST", body: JSON.stringify({ action: "auto" }) })
      .then(function (r) {
        if (!r || !r.ok) { flashHint((r && r.error) || "auto 失败"); return; }
        flashHint("✓ 已创建 " + (r.created || []).join(", ") + " 车道");
        loadProviders();
      });
  };
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-pvuse]"), function (b) {
    b.onclick = function () { configAction("use", { name: b.dataset.pvuse }, "缺省车道 → " + b.dataset.pvuse); };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-pvrm]"), function (b) {
    b.onclick = function () { configAction("lane-rm", { name: b.dataset.pvrm }, "已删除车道 " + b.dataset.pvrm); };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("button[data-pvtest]"), function (b) {
    b.onclick = function () { testProviderLane(b.dataset.pvtest); };
  });
}

function configAction(action, body, okMsg) {
  api("/api/config", { method: "POST", body: JSON.stringify(Object.assign({ action: action }, body)) })
    .then(function (r) {
      if (!r || !r.ok) { flashHint((r && r.error) || "配置写入失败"); return; }
      flashHint("✓ " + okMsg);
      loadProviders();
    }).catch(function (e) { flashHint("配置写入失败：" + e); });
}

function testProviderLane(lane) {
  var out = document.getElementById("pvTestOut");
  if (out) { out.className = "pvtest"; out.textContent = "⏳ 正在测试车道 " + lane + "（1-token 真实请求）…"; }
  api("/api/providers/test", { method: "POST", body: JSON.stringify({ lane: lane }) })
    .then(function (r) {
      var res = r && r.result;
      if (r && r.ok) {
        if (out) { out.className = "pvtest ok"; out.textContent = "✓ " + lane + " 连通（" + res.ms + "ms · 回复「" + (res.reply || "") + "」 · tokens " + (res.tokens == null ? "?" : res.tokens) + "）"; }
      } else if (out) {
        out.className = "pvtest bad";
        out.textContent = "✗ " + lane + " 失败（" + ((res && res.error) || "未知") + "）";
      }
    }).catch(function (e) {
      if (out) { out.className = "pvtest bad"; out.textContent = "✗ 测试请求失败：" + e; }
    });
}

// 面板打开时拉数据； scrim 点击关闭
document.getElementById("providersBtn").onclick = function () { loadProviders(openProviders); };
document.getElementById("providersScrim").onclick = closeProviders;

function openApprovals() {
  document.getElementById("approvalPane").classList.add("on");
  document.getElementById("approvalScrim").classList.add("on");
  approvalChipRefresh();
  renderApprovalPane();
}

function closeApprovals() {
  document.getElementById("approvalPane").classList.remove("on");
  document.getElementById("approvalScrim").classList.remove("on");
}

function decideApproval(id, allow, always) {
  api("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ id: id, allow: allow, always: always }),
  }).then(function (r) {
    if (!r || !r.ok) { flashHint((r && r.error) || "审批写入失败"); return; }
    flashHint(allow ? (always ? "✓ 已放行（并写入长期放行集）" : "✓ 已放行本次请求")
                    : "✗ 已拒绝本次请求");
    approvalState.pending = approvalState.pending.filter(function (x) { return x.id !== id; });
    document.getElementById("approvalCount").textContent = String(approvalState.pending.length);
    document.getElementById("approvalBtn").hidden = approvalState.pending.length === 0;
    renderApprovalPane();
    if (runModel) refreshRunCard(runModel);
  }).catch(function (e) { flashHint("审批写入失败：" + e); });
}

/** 轮询待批准项：审批请求由子进程落盘，SSE 事件也会到达；这里兜的是
 *  「面板没开」以及「多标签页」两种场景。 */
function startApprovalPoll() {
  approvalChipRefresh();
  setInterval(function () {
    connTick++;
    if (!connGate(connTick)) return;
    approvalChipRefresh();
    if (document.getElementById("approvalPane").classList.contains("on")) renderApprovalPane();
  }, 4000);
}

// ---- 运行产物：列表 / 回放 / 评分卡（TUI :replay 与 org score 的 Web 面） ----

function loadRuns() {
  api("/api/runs").then(function (r) {
    var el = document.getElementById("runs");
    if (!el) return;
    var runs = (r && r.runs) || [];
    document.getElementById("runCount").textContent = runs.length ? String(runs.length) : "";
    if (runs.length === 0) {
      el.innerHTML = '<div class="l2" style="padding:4px 8px">暂无运行产物（派单即产生）</div>';
      return;
    }
    el.innerHTML = runs.map(function (x) {
      return '<div class="run' + (x.ok ? " ok" : " bad") + '" data-run="' + esc(x.name) + '" ' +
        'title="' + esc(x.task || "") + '">' +
        '<div class="l1"><span class="nm">' + esc(x.name) + '</span>' +
        '<span class="dim">' + (((x.elapsed_ms || 0) / 1000)).toFixed(1) + 's</span></div>' +
        '<div class="l2">' + esc((x.task || "").slice(0, 34)) + '</div></div>';
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".run[data-run]"), function (node) {
      node.onclick = function () { openRun(node.dataset.run); closeDrawer(); };
    });
  }).catch(function () { /* 无产物：保持空态 */ });
}

/** 只读回放一次历史运行（与 TUI :replay 同源：replayRun 读三路产物重演）。 */
function openRun(name) {
  api("/api/run?dir=" + encodeURIComponent(name)).then(function (r) {
    if (!r || r.error) { flashHint((r && r.error) || "回放失败"); return; }
    var m = newRunModel((r.runJson && r.runJson.task) || name, (r.runJson && r.runJson.model) || "?");
    m.mission = (r.runJson && r.runJson.task) || "";
    (r.events || []).forEach(function (ev) { applyFact(m, ev.fact); });
    m.runOk = !!(r.runJson && r.runJson.ok);
    m.elapsed = (r.runJson && r.runJson.elapsed_ms) || 0;
    var chat = document.getElementById("chat");
    chat.innerHTML = '<div class="t-user"><span class="ps">↺</span><span class="q">回放 ' + esc(name) + '</span></div>';
    chat.insertAdjacentHTML("beforeend", renderRun(m));
    var st = document.getElementById("runStatus" + m.id);
    if (st) st.textContent = "历史回放（只读）";
    var d = document.getElementById("runDone" + m.id);
    if (d) d.innerHTML = runDoneHtml({
      metrics: r.metrics, elapsed_ms: m.elapsed, outDir: name,
      outDirName: name, audio: m.audio,
    });
    scrollDown(true);
    flashHint("已回放 " + name + "（只读，未重跑引擎）");
  }).catch(function (e) { flashHint("回放失败：" + e); });
}

/** 用量/成本时间线面板（org cost 的 Web 面）。 */
function showCost() {
  api("/api/cost").then(function (r) {
    if (!r || !r.ok) { flashHint((r && r.error) || "没有可读的运行产物"); return; }
    var t = r.timeline;
    var chat = document.getElementById("chat");
    var h = '<div class="rcard"><div class="rchead"><span class="rt">用量 / 成本</span><span>· ' +
      esc(r.dir) + '</span><span style="margin-left:auto">' + t.totals.calls + ' 次调用 · ' +
      (t.totals.elapsedMs / 1000).toFixed(1) + 's</span></div><div class="scgrid">' +
      '<span class="h">轨道</span><span class="h">次数</span><span class="h">耗时</span>';
    if (t.calls.length === 0) {
      h += '</div><div class="rvempty">本次运行没有模型调用记录 —— scripted 剧本车道不经过网关，' +
        '故无 llm_stream_done（用 --model deepseek 才有真实用量）</div></div>';
    } else {
      t.byTrack.forEach(function (x) {
        h += '<span class="n">' + esc(x.track) + '</span><span>' + x.calls +
             '</span><span class="dim">' + (x.elapsedMs / 1000).toFixed(1) + 's · ' + x.chars + ' 字' +
             (x.tokens > 0 ? ' · ' + x.tokens + ' tok' : '') + '</span>';
      });
      h += '</div><div class="rdone">' +
        '<span>正文 <b>' + t.totals.chars + '</b> 字</span>' +
        '<span>思考 <b>' + t.totals.reasoningChars + '</b> 字</span>' +
        '<span>tokens <b>' + (t.tokensComplete ? t.totals.tokens : t.totals.tokens + "+") + '</b></span>' +
        (t.tokensComplete ? '' : '<span class="dim">（网关未回传全部 usage，token 为下界）</span>') +
        '</div></div>';
    }
    chat.insertAdjacentHTML("beforeend", h);
    scrollDown(true);
  }).catch(function (e) { flashHint("用量读取失败：" + e); });
}

/** 评分卡面板（org score 的 Web 面）。 */
function showScorecard() {
  api("/api/score").then(function (r) {
    if (!r || !r.ok) { flashHint((r && r.error) || "尚无评分卡"); return; }
    var c = r.scorecard;
    var chat = document.getElementById("chat");
    var h = '<div class="rcard"><div class="rchead"><span class="rt">评分卡</span><span>· ' +
      esc(r.dir) + ' · 模型 ' + esc(c.model) + '</span><span style="margin-left:auto">证据 ' +
      c.evidence_count + ' 条</span></div><div class="scgrid">' +
      '<span class="h">单元</span><span class="h">分数</span><span class="h">置信度</span>';
    c.cells.forEach(function (x) {
      h += '<span class="n">' + esc(x.cell) + '</span><span>' + Number(x.score).toFixed(3) +
           '</span><span class="dim">' + Number(x.confidence).toFixed(2) + '</span>';
    });
    h += '</div></div>';
    chat.insertAdjacentHTML("beforeend", h);
    scrollDown(true);
  }).catch(function (e) { flashHint("评分卡读取失败：" + e); });
}

// 轻量提示（状态栏闪现，2.6s 自清；无侵入）
function flashHint(text) {
  var el = document.getElementById("hintline");
  if (!el) return;
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(flashHint._t);
  flashHint._t = setTimeout(function () { el.classList.remove("on"); el.textContent = ""; }, 2600);
}

function renderSessions() {
  var el = document.getElementById("sessions");
  var f = sessFilter.toLowerCase();
  var shown = lastSessions.filter(function (s) {
    if (!f) return true;
    return s.id.toLowerCase().indexOf(f) >= 0 ||
      String(s.preview || "").toLowerCase().indexOf(f) >= 0;
  });
  document.getElementById("sessCount").textContent =
    lastSessions.length ? String(lastSessions.length) : "";
  el.innerHTML = shown.map(function (s) {
    var cls = "sess" + (s.id === state.currentSession ? " active" : "");
    if (s.id === editId) {
      return '<div class="' + cls + ' editing" data-id="' + esc(s.id) + '">' +
        '<div class="l1"><input id="renInput" value="' + esc(editDraft) +
        '" maxlength="64" aria-label="重命名会话">' +
        '<span class="acts"><button class="ic" data-act="renOk" title="确认重命名">✓</button>' +
        '<button class="ic danger" data-act="renCancel" title="取消">✕</button></span></div></div>';
    }
    if (s.id === confirmId) {
      return '<div class="' + cls + '" data-id="' + esc(s.id) + '">' +
        '<div class="l1"><span class="confirm">删除 ' + esc(s.id) + '？</span>' +
        '<span class="acts"><button class="ic danger" data-act="delOk" title="确认删除">✓</button>' +
        '<button class="ic" data-act="delCancel" title="取消">✕</button></span></div></div>';
    }
    return '<div class="' + cls + '" data-id="' + esc(s.id) + '" data-act="open" title="' +
      esc(s.id + " · " + s.turns + " 轮") + '">' +
      '<div class="l1"><span class="id">' + esc(s.id) + '</span>' +
      '<span class="n">' + s.turns + '轮</span>' +
      '<span class="acts"><button class="ic" data-act="rename" title="重命名">✎</button>' +
      '<button class="ic danger" data-act="del" title="删除会话（删 org 账本）">✕</button></span></div>' +
      '<div class="l2">' + relTime(s.lastAt) + " · " + esc(s.preview) + '</div></div>';
  }).join("") || '<div class="l2" style="padding:4px 10px">' + (lastSessions.length === 0
    ? "暂无会话账本 · 提问即写账本"
    : "无匹配「" + esc(sessFilter) + "」") + "</div>";
  var inp = document.getElementById("renInput");
  if (inp) {
    if (editErr) inp.classList.add("err");
    inp.focus(); inp.select();
    inp.onkeydown = function (e) {
      if (e.key === "Enter") submitRename(inp.value);
      if (e.key === "Escape") cancelEdit();
      e.stopPropagation();
    };
  }
}

document.getElementById("sessions").addEventListener("click", function (e) {
  var btn = e.target.closest("[data-act]");
  var row = e.target.closest(".sess");
  if (!row) return;
  var id = row.dataset.id;
  var act = btn ? btn.dataset.act : "open";
  if (act === "rename") {
    editId = id; editDraft = id; editErr = false; confirmId = null; renderSessions();
  } else if (act === "renOk") {
    submitRename(document.getElementById("renInput").value);
  } else if (act === "renCancel" || act === "delCancel") {
    editId = null; confirmId = null; renderSessions();
  } else if (act === "del") {
    confirmId = id; editId = null; renderSessions();
  } else if (act === "delOk") {
    doDelete(id);
  } else if (act === "open") {
    if (!state.running) { selectSession(id); closeDrawer(); }
  }
});

function cancelEdit() { editId = null; confirmId = null; renderSessions(); }

function submitRename(val) {
  var to = String(val || "").trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  var from = editId;
  if (!to || to === from) { cancelEdit(); return; }
  api("/api/session/" + encodeURIComponent(state.currentExpert) + "/" + encodeURIComponent(from), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: to }),
  }).then(function (r) {
    if (r && r.ok) {
      editId = null; editErr = false;
      if (state.currentSession === from) state.currentSession = to;
      refreshSessions(); renderCrumb(); renderStatusbar();
    } else {
      editErr = true; editDraft = to; renderSessions();
      setTimeout(function () { editErr = false; renderSessions(); }, 1500);
    }
  });
}

function doDelete(id) {
  api("/api/session/" + encodeURIComponent(state.currentExpert) + "/" + encodeURIComponent(id), {
    method: "DELETE",
  }).then(function (r) {
    confirmId = null;
    if (r && r.ok) {
      if (state.currentSession === id) {
        state.currentSession = null; state.turns = [];
        renderChat(); renderCrumb(); renderStatusbar();
      }
      refreshSessions();
    }
  });
}

function refreshSessions() {
  if (!state.currentExpert) return;
  api("/api/sessions?expert=" + encodeURIComponent(state.currentExpert))
    .then(function (r) {
      lastSessions = r.sessions || [];
      renderSessions();
    });
}

// ---- 对话区 ----

function expertVersion(name) {
  var ex = state.experts.filter(function (e) { return e.name === name; })[0];
  return ex ? ex.version : "—";
}

function bannerHtml() {
  var sess = state.currentSession
    ? state.currentSession + "（已就绪 · 提问即写账本）" : "（尚未选择）";
  return '<div class="banner">' +
    '<div class="b-row"><span class="b-k">engine</span><span class="b-v">org v' + VER + ' · direct harness</span></div>' +
    '<div class="b-row"><span class="b-k">workspace</span><span class="b-v" id="bws">' +
    esc(state.workspace || "…") + '</span></div>' +
    '<div class="b-row"><span class="b-k">expert</span><span class="b-v">' +
    esc(state.currentExpert || "—") + " @" + esc(expertVersion(state.currentExpert)) + '</span></div>' +
    '<div class="b-row"><span class="b-k">session</span><span class="b-v">' + esc(sess) + '</span></div>' +
    '<div class="b-hr"></div>' +
    '<div class="b-row"><span class="b-k">keys</span><span class="b-v">enter 发送 · shift+enter 换行 · esc 停止 · ⌘K 新会话 · / 聚焦</span></div>' +
    '</div>';
}

function turnHtml(t, isLast) {
  // /compact 的重写条目不是「一轮问答」：显式标注来源轮数，否则用户会看到一条
  // 问题叫 (compact digest of N turns) 的怪轮次（此前 Web 不解析 compacted 字段）
  var meta = "org · " + (state.currentExpert || "?") + " · turn " + t.turn +
    " · " + t.tokens + " tok · ctx " + t.ctx_tokens;
  if (t.compacted) {
    meta = "org · " + (state.currentExpert || "?") + " · 已压缩（原 " +
      (t.compacted_from || "?") + " 轮摘要） · " + t.tokens + " tok · ctx " + t.ctx_tokens;
  }
  var q = t.compacted ? "(compact digest of " + (t.compacted_from || "?") + " turns)" : t.question;
  return '<div class="t-user' + (t.compacted ? ' compacted' : '') + '"><span class="ps">' +
    (t.compacted ? "⇲" : "❯") + '</span><span class="q">' +
    esc(q) + '</span></div>' +
    '<div class="t-bot"><div class="who">' + esc(meta) + '</div>' +
    '<div class="body md">' + renderMd(t.answer || "（空回答）") + '</div>' +
    mactsHtml(isLast) + '</div>';
}

/** 消息级操作行（hover 浮现）：复制（每轮）+ 朗读（每轮，v0.5.12）+ 重发
 * （仅末轮；账本为事实源，重发 = 追加新轮次，不篡改历史）。 */
function mactsHtml(isLast) {
  return '<div class="macts">' +
    '<button class="mact mact-copy" type="button" title="复制本轮回答">复制</button>' +
    '<button class="mact mact-say" type="button" title="朗读本轮回答（TTS · 当前声音/语速）">🔊</button>' +
    (isLast ? '<button class="mact mact-rs" type="button" title="重发此问（账本为事实源，追加新轮次）">重发</button>' : "") +
    "</div>";
}

/** 非末轮的「重发」钮清除（新轮落座后田刷新）。 */
function markLast() {
  var bots = document.querySelectorAll("#chat .t-bot");
  for (var k = 0; k < bots.length - 1; k++) {
    var rs = bots[k].querySelector(".mact-rs");
    if (rs) rs.remove();
  }
}

function renderChat() {
  var el = document.getElementById("chat");
  if (state.turns.length === 0) { el.innerHTML = bannerHtml(); return; }
  el.innerHTML = state.turns.map(function (t, k) {
    return turnHtml(t, k === state.turns.length - 1);
  }).join("");
  markLast();
}

function selectExpert(name) {
  state.currentExpert = name;
  state.currentSession = null;
  state.turns = [];
  renderExperts(); renderCrumb(); renderStatusbar();
  api("/api/sessions?expert=" + encodeURIComponent(name)).then(function (r) {
    lastSessions = r.sessions || [];
    renderSessions();
    if (lastSessions.length > 0) {
      selectSession(lastSessions[0].id);
    } else {
      renderChat(); renderStatusbar();
    }
  });
}

function selectSession(id) {
  state.currentSession = id;
  api("/api/session/" + encodeURIComponent(state.currentExpert) + "/" + encodeURIComponent(id))
    .then(function (r) {
      state.turns = r.turns || [];
      renderSessions(); renderChat(); renderCrumb(); renderStatusbar();
      scrollDown(true);
    });
}

// ---- 智能滚动 ----

var chatWrap = document.getElementById("chatWrap");
chatWrap.addEventListener("scroll", function () {
  state.atBottom = chatWrap.scrollHeight - chatWrap.scrollTop - chatWrap.clientHeight < 40;
  document.getElementById("jumpBtn").style.display = state.atBottom ? "none" : "block";
});
document.getElementById("jumpBtn").onclick = function () {
  state.atBottom = true;
  chatWrap.scrollTo({ top: chatWrap.scrollHeight, behavior: "smooth" });
  this.style.display = "none";
};
function scrollDown(force) {
  if (force || state.atBottom) chatWrap.scrollTop = chatWrap.scrollHeight;
}

// ---- 转发 / 运行态 ----

function setRunning(on) {
  state.running = on;
  var send = document.getElementById("send");
  var ta = document.getElementById("question");
  send.textContent = on ? "停止" : "发送";
  send.classList.toggle("running", on);
  ta.disabled = on;
  document.getElementById("newSession").disabled = on;
  renderStatusbar();
}
function startSpin() {
  stopSpin();
  spinTimer = setInterval(function () {
    spinIdx = (spinIdx + 1) % SPIN.length;
    var n = document.getElementById("pspin");
    if (n) n.textContent = SPIN[spinIdx];
  }, 90);
}
function stopSpin() {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
}

function stopRun() {
  if (!state.running) return;
  if (!state.myRunStarted) {
    // v0.4.14：排队轮可预先取消（按票据 id，不误伤前一轮）
    api("/api/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.ticketId })
    }).then(function (r) {
      if (r && !r.ok) setStage(r.message || "取消失败");
    });
    return;
  }
  api("/api/abort", { method: "POST" }).then(function (r) {
    if (r && !r.ok) setStage(r.message || "无运行中的直连");
  });
}

// SSE 帧 → {event, data}（「event: X」+「data: {...}」两行一帧；注释行/心跳忽略）
function sseFrame(frame, handler) {
  var ev = "message", data = "";
  frame.split("\\n").forEach(function (l) {
    if (l.indexOf("event:") === 0) ev = l.slice(6).trim();
    else if (l.indexOf("data:") === 0) data += l.slice(5).trim();
  });
  var obj = null;
  try { obj = data ? JSON.parse(data) : null; } catch (e) { /* 容忍非 JSON */ }
  handler(ev, obj);
}

function ask(text, isRetry) {
  var question = String(text || document.getElementById("question").value).trim();
  if (!question || state.running) return;
  if (!state.currentExpert) return;
  var session = state.currentSession || ("web-" + Date.now().toString(36));
  if (!state.currentSession) state.currentSession = session;
  state.lastQuestion = question;
  state.myRunStarted = false;
  state.ticketId = 0;
  setRunning(true);
  document.getElementById("question").value = "";
  document.getElementById("question").style.height = "auto";
  var chat = document.getElementById("chat");
  if (chat.querySelector(".banner")) chat.innerHTML = "";
  if (!isRetry) {
    chat.insertAdjacentHTML("beforeend",
      '<div class="t-user"><span class="ps">❯</span><span class="q">' +
      esc(question) + '</span></div>');
  }
  chat.insertAdjacentHTML("beforeend",
    '<div class="t-bot" id="pending">' +
    '<div class="runline"><span class="spin" id="pspin">⠋</span>' +
    '<span id="pstage">启动直连流水线…</span></div>' +
    '<div class="answering" id="panswer" style="display:none"></div>' +
    '<div class="logwin open" id="plogwin">' +
    '<div class="loghead" id="ploghead"><span class="tri">▸</span>run log' +
    '<span class="ln" id="plogn">0</span>行</div>' +
    '<pre id="plogbody"></pre></div>' +
    '</div>');
  startSpin();
  scrollDown(true);
  var inAnswer = false, answerLines = [];
  var settled = false;
  // v0.4.15 流式增量状态：streamText = content 通道拼接；thinkChars = reasoning
  // 通道累计（思考指示器）；reset 清空重绘（网关重试重发）
  var streamText = "", thinkChars = 0;

  function el(id) { return document.getElementById(id); }
  function setStage(text) { var n = el("pstage"); if (n) n.textContent = text; }
  function appendLog(line) {
    var body = el("plogbody"), n = el("plogn");
    if (!body) return;
    body.textContent += line + "\\n";
    if (n) n.textContent = String(Number(n.textContent) + 1);
    body.scrollTop = body.scrollHeight;
  }
  function renderAnswer() {
    var a = el("panswer");
    if (!a) return;
    a.style.display = "";
    a.className = "answering md";
    // 流式优先：逐 token 增量拼接的正文（回退 stdout 行流 —— scripted 车道）
    var body = streamText.length > 0 ? streamText : answerLines.join("\\n");
    a.innerHTML = renderMd(body) + '<span class="caret">▌</span>';
  }

  function onEvent(ev, d) {
    if (settled) return;
    if (ev === "open") {
      state.ticketId = (d && d.ticketId) || 0;
      if (d && d.queued) setStage("排队中（前一轮直连仍在运行）· esc 取消本轮");
    } else if (ev === "delta") {
      // v0.4.15：流式增量（llm-stream 尾随）—— reasoning 思考指示器 /
      // content 逐 token 正文 / reset 网关重试清屏重绘
      if (d && d.channel === "reasoning") {
        thinkChars += String(d.delta || "").length;
        setStage("◈ thinking · " + thinkChars + " chars");
      } else if (d && d.channel === "reset") {
        streamText = ""; thinkChars = 0;
        setStage("网关重试，重新流式 …");
        renderAnswer();
      } else if (d && d.channel === "content") {
        streamText += String(d.delta || "");
        renderAnswer();
        scrollDown(false);
      }
    } else if (ev === "start") {
      state.myRunStarted = true;
      setStage("direct 流水线启动（" + ((d && d.model) || "scripted") + "）");
    } else if (ev === "stage") {
      setStage((d && d.stage) || "…");
    } else if (ev === "log" && d && d.line) {
      var line = d.line;
      appendLog(line);
      if (/^\\[direct\\]/.test(line)) {
        inAnswer = true; answerLines = [];
        setStage("回答输出中（stdout 逐行回传）…");
      } else if (line.indexOf("[ctx]") === 0) {
        inAnswer = false;
        setStage("记账与纪要回写…");
      } else if (line.indexOf("harness 返回") >= 0) {
        inAnswer = false;
      } else if (inAnswer) {
        answerLines.push(line);
        renderAnswer();
      }
      scrollDown(false);
    } else if (ev === "done") {
      finalize(d);
    } else if (ev === "error") {
      finalize(null, (d && d.message) || "引擎失败", d && d.aborted, d && d.queued);
    }
  }

  /** v0.5.9：直连 t-bot 的音频产物卡（与团队运行卡 .raud 同款；dir 固定 out-ask）。 */
function askAudioHtml(audio) {
  var dirName = "out-ask";
  return audio.map(function (a) {
    var src = "/api/audio?dir=" + encodeURIComponent(dirName) + "&file=" + encodeURIComponent(a.wavFile || a.file);
    return '<div class="raud">' +
      '<span class="dim">♪ ' + esc(a.title || a.wavFile || a.file) + ' · ' +
      (a.durationSec || 0) + 's' + (a.timbre ? ' · ' + esc(a.timbre) : '') + '</span>' +
      '<audio controls preload="none" src="' + esc(src) + '"></audio>' +
      '<a class="dim" download href="' + esc(src) + '">下载</a>' +
      (a.midiFile ? '<a class="dim" download href="/api/audio?dir=' + encodeURIComponent(dirName) +
        '&file=' + encodeURIComponent(a.midiFile) + '">MIDI</a>' : '') +
      '</div>';
  }).join("");
}

function finalize(outcome, errMsg, aborted, queuedCancel) {
    if (settled) return;
    settled = true;
    stopSpin();
    var pending = el("pending");
    if (pending) pending.remove();
    var chat = document.getElementById("chat");
    if (outcome && outcome.ok) {
      // v0.5.14：B-22 —— 救援轮的 who 行亮出换专家事实；降级轮 ◌ 零消耗标注
      var effExpert = (outcome.rescue && outcome.rescue.to) || state.currentExpert;
      var meta = "org · " + effExpert + " · turn " +
        (outcome.turn == null ? "-" : outcome.turn) + " · " +
        (outcome.tokens == null ? "-" : outcome.tokens) + " tok" +
        (outcome.durationMs == null ? "" : " · " + outcome.durationMs + " ms");
      var whoExtra = "";
      if (outcome.rescue) {
        whoExtra = '<span class="rsc-badge" title="域外问题语义地板放行：直连救援换专家应答（v0.5.14）">⇄ 救援自 ' +
          esc(outcome.rescue.from) + "（重合 " + outcome.rescue.selfScore +
          " < 0.15 地板）</span>";
      } else if (outcome.degraded) {
        whoExtra = '<span class="rsc-badge deg" title="零消耗降级：未跑模型、未落账本（v0.5.14）">◌ 零消耗</span>';
      }
      chat.insertAdjacentHTML("beforeend",
        '<div class="t-bot' + (outcome.degraded ? " degraded" : "") + '"><div class="who">' + esc(meta) + whoExtra + '</div>' +
        '<div class="body md">' + renderMd(outcome.answer || "（无回答）") + '</div>' +
        (outcome.audio && outcome.audio.length > 0 ? askAudioHtml(outcome.audio) : "") +
        '<div class="obs">' + meterHtml(outcome.ctxLine) +
        '<span>' + (outcome.degraded ? "本轮零消耗，未落账本" : "ledger 已落盘") + '</span></div>' +
        mactsHtml(true) +
        logWinHtml(outcome.logs || "", false) + '</div>');
      markLast();
      state.turns.push({
        turn: outcome.turn == null ? state.turns.length + 1 : outcome.turn,
        question: question,
        answer: outcome.answer || "",
        tokens: outcome.tokens == null ? 0 : outcome.tokens,
        ctx_tokens: 0,
        durationMs: outcome.durationMs,
      });
    } else if (outcome) {
      // 引擎失败（ok:false，如网关限流/上游超时）：失败轮不落账本 → 重试安全；
      // run log 默认展开呈现失败原因（banner/错误行一目了然）。
      chat.insertAdjacentHTML("beforeend",
        '<div class="t-bot"><div class="errbox"><span>✗ 直连失败：引擎返回失败（见下方 run log）</span>' +
        '<button class="retry" type="button">重试</button></div>' +
        logWinHtml(outcome.logs || "", true) + '</div>');
    } else if (aborted) {
      var partial = answerLines.join("\\n");
      var html = '<div class="t-bot">';
      if (partial && !queuedCancel) {
        html += '<div class="who">org · ' + esc(state.currentExpert) + ' · stopped</div>' +
          '<div class="body">' + esc(partial) + '</div>';
      }
      html += '<div class="stoppedbox">■ ' + (queuedCancel ? "已取消排队 · 本轮未开始" : "已停止 · 本轮未落账本") + '</div></div>';
      chat.insertAdjacentHTML("beforeend", html);
    } else {
      chat.insertAdjacentHTML("beforeend",
        '<div class="t-bot"><div class="errbox"><span>✗ 直连失败：' +
        esc(errMsg || "未知错误") + '</span>' +
        '<button class="retry" type="button">重试</button></div></div>');
    }
    scrollDown(false);
    setRunning(false);
    refreshSessions(); renderCrumb(); renderStatusbar();
  }

  fetch("/api/ask-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expert: state.currentExpert,
      question: question,
      session: session,
      model: state.model,
    }),
  }).then(function (r) {
    if (!r.ok) {
      // 验证类失败在流建立前返回 JSON（expert 必填/名不合法等）—— 读出人话错误
      return r.json().then(
        function (e) { throw new Error(e && e.error ? e.error : "HTTP " + r.status); },
        function () { throw new Error("HTTP " + r.status); },
      );
    }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return;
        buf += dec.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf("\\n\\n")) >= 0) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          sseFrame(frame, onEvent);
        }
        return pump();
      });
    }
    return pump();
  }).catch(function (e) {
    finalize(null, "SSE 连接失败：" + e);
  }).then(function () {
    if (!settled) finalize(null, "SSE 连接意外中断（未收到 done）");
  });
}

function logWinHtml(logs, open) {
  if (!logs) return "";
  var lines = logs.split("\\n").filter(function (l) { return l.trim().length > 0; }).length;
  return '<div class="logwin' + (open ? " open" : "") + '">' +
    '<div class="loghead"><span class="tri">▸</span>run log<span class="ln">' +
    lines + '</span>行</div><pre>' + esc(logs) + '</pre></div>';
}

// ---- 剪贴板（Clipboard API + execCommand 兜底） ----

function fallbackCopy(text, cb) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* 忽略 */ }
  ta.remove();
  if (cb) cb();
}
function copyText(text, cb) {
  var done = function () { if (cb) cb(); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () {
      fallbackCopy(text, done);
    });
  } else fallbackCopy(text, done);
}
function flashBtn(btn, text) {
  var old = btn.textContent;
  btn.textContent = text;
  btn.classList.add("copied");
  setTimeout(function () {
    btn.textContent = old;
    btn.classList.remove("copied");
  }, 1200);
}

// 日志窗口折叠 / 重试 / 消息级操作 / 代码块复制：对话区事件委托
document.getElementById("chat").addEventListener("click", function (e) {
  var lh = e.target.closest(".loghead");
  if (lh) {
    lh.parentElement.classList.toggle("open");
    return;
  }
  var mc = e.target.closest(".mdcopy");
  if (mc) {
    var box = mc.closest(".mdcode");
    var pre = box ? box.querySelector("pre") : null;
    if (pre) copyText(pre.textContent || "", function () { flashBtn(mc, "已复制"); });
    return;
  }
  var cp = e.target.closest(".mact-copy");
  if (cp) {
    var blk2 = cp.closest(".t-bot");
    var body = blk2 ? blk2.querySelector(".body") : null;
    if (body) copyText(body.innerText || body.textContent || "",
      function () { flashBtn(cp, "已复制"); });
    return;
  }
  var rs = e.target.closest(".mact-rs");
  if (rs && !state.running) {
    ask(state.lastQuestion, false);
    return;
  }
  var sy = e.target.closest(".mact-say");
  if (sy) {
    var blk3 = sy.closest(".t-bot");
    var body3 = blk3 ? blk3.querySelector(".body") : null;
    if (body3) speakText((body3.innerText || "").trim(), sy);
    return;
  }
  var rt = e.target.closest(".retry");
  if (rt && !state.running) {
    var blk = rt.closest(".t-bot");
    if (blk) blk.remove();
    ask(state.lastQuestion, true);
  }
});

// ---- 输入坞 / 快捷键 ----

var question = document.getElementById("question");
question.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 140) + "px";
});
question.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // 模式分派与 send 按钮同构（B-21：Enter 曾无条件走直连，团队模式切
    // 换后按回车仍派直连 —— UI 显示团队、行为却是直连的不一致 bug）
    if (state.mode === "team") runTeam(this.value.trim()); else ask();
  }
});
document.addEventListener("keydown", function (e) {
  var rvPane = document.getElementById("reviewPane");
  if (e.key === "Escape" && rvPane.classList.contains("on")) { closeReview(); return; }
  var apPane = document.getElementById("approvalPane");
  if (e.key === "Escape" && apPane.classList.contains("on")) { closeApprovals(); return; }
  if (e.key === "Escape" && state.running) stopRun();
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    newSession();
  }
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey &&
      e.target === document.body) {
    e.preventDefault();
    document.getElementById("question").focus();
  }
});
document.getElementById("send").onclick = function () {
  if (state.running) { stopRun(); return; }
  var text = document.getElementById("question").value.trim();
  if (!text) return;
  // 模式分派：团队 = 监督回路（org run 的 Web 面）；直连 = 单专家（原行为）
  if (state.mode === "team") runTeam(text); else ask(text);
};
function newSession() {
  if (state.running) return;
  state.currentSession = "web-" + Date.now().toString(36);
  state.turns = [];
  renderSessions(); renderChat(); renderCrumb(); renderStatusbar();
}
document.getElementById("newSession").onclick = newSession;

// ---- 会话搜索（id / 首问预览匹配；esc 清空） ----

var sessSearch = document.getElementById("sessSearch");
sessSearch.addEventListener("input", function () {
  sessFilter = this.value;
  renderSessions();
});
sessSearch.addEventListener("keydown", function (e) {
  if (e.key === "Escape") { this.value = ""; sessFilter = ""; renderSessions(); }
  e.stopPropagation(); // 不触发全局 esc 停止
});

// ---- 移动端抽屉（≤720px：menuBtn 开关 + 遮罩点击关闭） ----

var asideEl = document.querySelector("aside");
var backdropEl = document.getElementById("backdrop");
function closeDrawer() {
  asideEl.classList.remove("open");
  backdropEl.style.display = "none";
}
document.getElementById("menuBtn").onclick = function () {
  var on = !asideEl.classList.contains("open");
  asideEl.classList.toggle("open", on);
  backdropEl.style.display = on ? "block" : "none";
};
backdropEl.onclick = closeDrawer;

// 运行范围复核面板：顶栏徽标打开，遮罩/Esc 关闭（与抽屉同交互形态）
document.getElementById("reviewBtn").onclick = openReview;
document.getElementById("reviewScrim").onclick = closeReview;

// 交互式审批面板（与复核面板同交互形态）
document.getElementById("approvalBtn").onclick = openApprovals;
document.getElementById("approvalScrim").onclick = closeApprovals;

// 模型切换（scripted / deepseek）
document.getElementById("modelSeg").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b || state.running) return;
  state.model = b.dataset.model;
  renderSeg(); renderStatusbar();
});
function renderSeg() {
  Array.prototype.forEach.call(
    document.querySelectorAll("#modelSeg button"),
    function (b) { b.classList.toggle("on", b.dataset.model === state.model); },
  );
}

// 派单模式切换（团队 / 直连）—— 团队是旗舰面，缺省即它
document.getElementById("modeSeg").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b || state.running) return;
  state.mode = b.dataset.mode;
  renderMode();
});
function renderMode() {
  Array.prototype.forEach.call(
    document.querySelectorAll("#modeSeg button"),
    function (b) { b.classList.toggle("on", b.dataset.mode === state.mode); },
  );
  var team = state.mode === "team";
  var q = document.getElementById("question");
  var ex = document.getElementById("experts");
  if (q) {
    q.placeholder = team
      ? "输入任务，enter 派单（团队模式：分解 → 路由 → 审查 → 汇总）· esc 停止"
      : "输入问题，enter 发送（直连单专家）· shift+enter 换行 · esc 停止";
  }
  // 直连需要专家在岗；团队模式不需要（专家由路由决定）
  if (ex) ex.style.opacity = team ? "0.55" : "1";
  renderStatusbar();
}

// 评分卡（org score 的 Web 面）
document.getElementById("scoreBtn").onclick = function () { showScorecard(); closeDrawer(); };
document.getElementById("costBtn").onclick = function () { showCost(); closeDrawer(); };

// 启动即加载运行产物列表 + 开始审批轮询
loadRuns();
startApprovalPoll();

// ---- 导出 Markdown ----

document.getElementById("exportBtn").onclick = function () {
  if (state.turns.length === 0) return;
  var lines = [
    "# org 会话 · " + state.currentExpert,
    "",
    "> org web v" + VER + " · session " + state.currentSession + " · model " + state.model,
    "> 流水线：能力核对 → 注册表寻址 → 会话史装载 → 模型网关 → 记账回写",
    "",
  ];
  state.turns.forEach(function (t) {
    lines.push("## 问", "", t.question, "");
    lines.push("## 答（" + state.currentExpert + "）", "", t.answer || "", "");
    var meta = [];
    if (t.tokens) meta.push("tokens " + t.tokens);
    if (t.ctx_tokens) meta.push("ctx " + t.ctx_tokens);
    if (t.durationMs != null) meta.push("耗时 " + t.durationMs + " ms");
    if (meta.length) lines.push("> " + meta.join(" · "), "");
  });
  var blob = new Blob([lines.join("\\n")], { type: "text/markdown;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "org-" + state.currentExpert + "-" +
    new Date().toISOString().slice(0, 10) + ".md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// ---- 启动装载 + 顶栏摘要周期刷新（15s，只重读占用不动对话区） ----

// 工具库治理后刷新：重读注册表 + 占用，重渲染侧栏（不动当前选中与对话区）
function refreshStatus() {
  return api("/api/status").then(function (r) {
    state.experts = r.experts || [];
    state.usages = r.usages || [];
    renderTop(); renderExperts(); renderSeg(); renderStatusbar();
  });
}

api("/api/status").then(function (r) {
  state.experts = r.experts || [];
  state.usages = r.usages || [];
  state.workspace = r.workspace || "";
  if (r.model === "scripted" || r.model === "deepseek") state.model = r.model;
  document.getElementById("wsPath").textContent = r.workspace || "";
  renderTop(); renderExperts(); renderSeg(); renderStatusbar(); renderMode();
  refreshReviewChip();
  if (state.experts.length > 0) {
    var retained = state.experts.filter(function (e) { return e.retained; });
    var first = (retained.length > 0 ? retained : state.experts)[0];
    selectExpert(first.name);
  } else {
    renderChat();
  }
});
setInterval(function () {
  connTick++;
  if (!connGate(connTick)) return;
  api("/api/status").then(function (r) {
    state.usages = r.usages || [];
    renderTop();
  }).catch(function () { /* 断连：状态条已由 api() 层呈现 */ });
}, 15000);
</script>
</body>
</html>`;
}
