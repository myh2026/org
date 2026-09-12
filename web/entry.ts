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
import { tailLines } from "../lib/events.ts";
import type { EngineEvent } from "../lib/events.ts";
import { classifyRunEvent } from "../lib/runCards.ts";
import { listApprovals, decideApproval } from "../lib/approvals.ts";
import { readCostTimeline, latestHarnessRunDir } from "../lib/engine.ts";
import { AskGate, QueueCancelledError } from "./gate.ts";
import { ORG_VERSION as VERSION } from "../lib/version.ts"; // 版本单一来源（v0.4.14 漂移治理：此前本文件落后两版）

const DIRECT_ENTRY = path.join(ROOT, "hsl/pool/direct.hsl");
const STOCK_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");
const DEFAULT_PORT = 4600; // 3000/3030/5000 被本机其他服务占用，绝不复用

// ---- 参数解析 ----

export interface WebParsed {
  workspace: string;
  model: string;
  port: number;
  gateway: string;
}

export function parseWebArgv(argv: string[]): WebParsed {
  const p: WebParsed = {
    workspace: process.env.ORG_WORKSPACE ?? DEFAULT_WORKSPACE,
    model: "scripted",
    port: DEFAULT_PORT,
    gateway: process.env.DHV_LLM_GATEWAY ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--workspace" || a === "-w") p.workspace = path.resolve(argv[++i] ?? p.workspace);
    else if (a === "--model" || a === "-m") p.model = argv[++i] ?? "scripted";
    else if (a === "--port" || a === "-p") p.port = Number(argv[++i] ?? DEFAULT_PORT) || DEFAULT_PORT;
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

// ---- 会话目录扫描（防路径穿越：expert/session 名只允许字母数字连字符下划线） ----

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

/** 进程内执行一轮直连（DIRECT_ENTRY + env ORG_ASK_* + expertFixtureOf 剧本
 *  自动发现 + dhvRun 双车道）。不 spawn CLI 自身（web 服务进程内完成）。 */
async function askOnce(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
): Promise<AskOutcome> {
  ensureWorkspace(ws);
  const env: Record<string, string> = {
    ORG_ASK_EXPERT: req.expert,
    ORG_ASK_SESSION: req.session,
    ORG_ASK_QUESTION: req.question,
  };
  // 剧本自动发现（与 cmdAsk 同规则）：导入 harness 自带占位剧本
  // （manifest.fixture）——不传 fixture 也能立即 scripted 问答
  let fixture = STOCK_FIXTURE;
  const found = expertFixtureOf(ws, req.expert);
  if (found) fixture = found;
  const r = await dhvRun(
    [
      "run", DIRECT_ENTRY,
      "--workspace", ws,
      "--task", `(direct) ${req.question}`,
      "--model", req.model,
      "--fixture", fixture,
      "--out", path.join(ws, "out-ask"),
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ],
    env,
  );
  return parseAskOut(r.out);
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
  const env: Record<string, string> = {
    ORG_ASK_EXPERT: req.expert,
    ORG_ASK_SESSION: req.session,
    ORG_ASK_QUESTION: req.question,
  };
  let fixture = STOCK_FIXTURE;
  const found = expertFixtureOf(ws, req.expert);
  if (found) fixture = found;
  const args = [
    "run", DIRECT_ENTRY,
    "--workspace", ws,
    "--task", `(direct) ${req.question}`,
    "--model", req.model,
    "--fixture", fixture,
    "--out", path.join(ws, "out-ask"),
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
    return parseAskOut(chunks.join(""));
  }
  // 进程内车道：无增量输出，走 dhvRun 拿最终结果
  const r = await dhvRun(args, env);
  return parseAskOut(r.out);
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
                elapsed_ms: res.elapsed_ms, error: res.error ?? null,
                metrics: res.metrics ?? null,
                runJson: res.runJson ?? null,
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
export function startWebServer(opts: { workspace: string; port: number; model: string }): Bun.Server {
  const ws = opts.workspace;
  return Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1", // 本地 GUI 原型：只听回环（演示场景够用）
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
    server = startWebServer({ workspace: p.workspace, port: p.port, model: p.model });
  } catch (err) {
    process.stderr.write(`✗ Web 服务启动失败：${(err as Error).message}\n`);
    process.stderr.write(`  （端口 ${p.port} 被占用？--port N 换一个）\n`);
    return 2;
  }
  console.log(`ORG web · v${VERSION} · 工作区 ${p.workspace}`);
  console.log(`  GUI        http://127.0.0.1:${server.port}/`);
  console.log(`  只读面     GET /api/status · /api/sessions?expert=… · /api/session/<专家>/<会话>`);
  console.log(`  会话管理   DELETE /api/session/<E>/<S>（删除）· PATCH（重命名 body {to}）`);
  console.log(`  交互面     POST /api/ask-stream（SSE 流式）· POST /api/ask（JSON 整轮）`);
  console.log(`  停止       POST /api/abort（运行轮 SIGKILL / body{id} 取消排队轮）`);
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
  .cbox { max-width: 860px; margin: 0 auto; display: flex; align-items: flex-start;
           border: 1px solid var(--border); border-radius: 4px;
           background: var(--bg); transition: border-color .15s; }
  .cbox:focus-within { border-color: var(--border2); }
  .cbox .ps { flex: none; padding: 7px 0 0 12px; font: 14px var(--mono);
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
  .rvsettled { padding: 10px 14px; font: 11px/1.7 var(--mono); color: var(--dim);
        border-bottom: 1px solid var(--border); }

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
  <span class="tstats" id="topStats"></span>
</header>
<div id="backdrop" aria-hidden="true"></div>
<div id="reviewScrim" aria-hidden="true"></div>
<div id="reviewPane" role="dialog" aria-modal="true" aria-labelledby="rvTitle"></div>
<div id="approvalScrim" aria-hidden="true"></div>
<div id="approvalPane" role="dialog" aria-modal="true" aria-labelledby="apTitle"></div>
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
        <span class="ps" aria-hidden="true">❯</span>
        <textarea id="question" rows="1"
          placeholder="输入问题，enter 发送 · shift+enter 换行 · esc 停止"></textarea>
      </div>
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
function api(path, opts) {
  return fetch(path, opts).then(function (r) { return r.json(); });
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
    var cls = n.tone === "err" ? "nv-err" : (n.tone === "warn" ? "nv-warn" : "nv-info");
    h += '<div class="revt ' + cls + '">' + esc(n.text) + '</div>';
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
      if (d) d.innerHTML = runDoneHtml(lastRunDone);
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
    if (d) d.innerHTML = runDoneHtml({ metrics: r.metrics, elapsed_ms: m.elapsed, outDir: name });
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

/** 消息级操作行（hover 浮现）：复制（每轮）+ 重发（仅末轮；账本为事实源，
 * 重发 = 追加新轮次，不篡改历史）。 */
function mactsHtml(isLast) {
  return '<div class="macts">' +
    '<button class="mact mact-copy" type="button" title="复制本轮回答">复制</button>' +
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

  function finalize(outcome, errMsg, aborted, queuedCancel) {
    if (settled) return;
    settled = true;
    stopSpin();
    var pending = el("pending");
    if (pending) pending.remove();
    var chat = document.getElementById("chat");
    if (outcome && outcome.ok) {
      var meta = "org · " + state.currentExpert + " · turn " +
        (outcome.turn == null ? "-" : outcome.turn) + " · " +
        (outcome.tokens == null ? "-" : outcome.tokens) + " tok" +
        (outcome.durationMs == null ? "" : " · " + outcome.durationMs + " ms");
      chat.insertAdjacentHTML("beforeend",
        '<div class="t-bot"><div class="who">' + esc(meta) + '</div>' +
        '<div class="body md">' + renderMd(outcome.answer || "（无回答）") + '</div>' +
        '<div class="obs">' + meterHtml(outcome.ctxLine) +
        '<span>ledger 已落盘</span></div>' +
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
    ask();
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
  api("/api/status").then(function (r) {
    state.usages = r.usages || [];
    renderTop();
  });
}, 15000);
</script>
</body>
</html>`;
}
