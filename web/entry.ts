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
//   GET    /api/sessions?expert=X   会话列表（runtime/sessions/<expert>/*.jsonl）
//   GET    /api/session/<E>/<S>     逐轮 question/answer/tokens/ctx_tokens
//   DELETE /api/session/<E>/<S>     删除会话（删账本文件 = 删会话）
//   PATCH  /api/session/<E>/<S>     重命名会话（body {to}，同专家 mv 账本）
//   POST   /api/ask                 进程内直连（JSON 整轮，兼容并存）
//   POST   /api/ask-stream          SSE 流式（open → queued? → start →
//                                   stage* → log* → done/error）
//   POST   /api/abort               停止生成（SIGKILL 当前 org 子进程，
//                                   该轮不落账本；SSE 发 error{aborted:true}）
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
  expertFixtureOf, dhvRun, resolveDhv, resolveBun,
} from "../lib/engine.ts";

const VERSION = "0.4.9";
const DIRECT_ENTRY = path.join(ROOT, "hsl/pool/direct.hsl");
const STOCK_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");
const DEFAULT_PORT = 4600; // 3000/3030/5000 被本机其他服务占用，绝不复用

// ---- 参数解析 ----

export interface WebParsed {
  workspace: string;
  model: string;
  port: number;
}

export function parseWebArgv(argv: string[]): WebParsed {
  const p: WebParsed = {
    workspace: process.env.ORG_WORKSPACE ?? DEFAULT_WORKSPACE,
    model: "scripted",
    port: DEFAULT_PORT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--workspace" || a === "-w") p.workspace = path.resolve(argv[++i] ?? p.workspace);
    else if (a === "--model" || a === "-m") p.model = argv[++i] ?? "scripted";
    else if (a === "--port" || a === "-p") p.port = Number(argv[++i] ?? DEFAULT_PORT) || DEFAULT_PORT;
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

// ---- 会话账本健壮解析 ----
// org 的 append_session（hsl/pool/direct.hsl）用 format! 裸插值写账本：多行
// answer 会带字面换行落盘，破坏逐行 JSON（上游序列化卫生已修，v0.4.6，但
// 存量坏账本仍在盘上）。解析策略（两层兜底，与 engine.ts contextUsageOf 同
// 思路，此处保留完整轮记录供 GUI 逐轮渲染）：
//   1. 按 "\n{"turn": 记录边界重组 segment；
//   2. 逐条先试标准 JSON.parse；
//   3. 不可解析的 segment 静默跳过（坏行容忍）。

export interface LedgerTurn {
  turn: number;
  question: string;
  answer: string;
  tokens: number;
  ctx_tokens: number;
}

export function parseLedgerRaw(raw: string): LedgerTurn[] {
  const turns: LedgerTurn[] = [];
  const segments = raw.split(/\n(?=\{"turn":)/);
  for (const seg of segments) {
    const t = seg.trim();
    if (t.length === 0) continue;
    // 1) 标准 JSON（修复后的正常形态）
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      turns.push({
        turn: Number(o.turn ?? 0),
        question: String(o.question ?? ""),
        answer: String(o.answer ?? ""),
        tokens: Number(o.tokens ?? 0),
        ctx_tokens: Number(o.ctx_tokens ?? 0),
      });
      continue;
    } catch { /* fallthrough：修复式解析 */ }
    // 2) 修复式：format! 固定字段布局（answer 含裸换行，v0.4.6 前存量）
    const m = t.match(
      /^\{"turn":(\d+),"question":"([\s\S]*?)","answer":"([\s\S]*)","tokens":(\d+),"ctx_tokens":(\d+)\}$/,
    );
    if (m) {
      turns.push({
        turn: Number(m[1]),
        question: m[2]!,
        answer: m[3]!,
        tokens: Number(m[4]),
        ctx_tokens: Number(m[5]),
      });
    }
  }
  return turns;
}

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

export function listSessions(ws: string, expert: string): SessionSummary[] {
  if (!SAFE_NAME.test(expert)) return [];
  const dir = path.join(ws, "runtime", "sessions", expert);
  let files: fs.Dirent[] = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
    const id = f.name.slice(0, -".jsonl".length);
    const turns = readSession(ws, expert, id);
    if (turns.length === 0) continue;
    const first = turns[0]!;
    out.push({
      id,
      expert,
      turns: turns.length,
      lastAt: fs.statSync(path.join(dir, f.name)).mtime.toISOString(),
      preview: first.question.slice(0, 40),
    });
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function readSession(ws: string, expert: string, session: string): LedgerTurn[] {
  const file = sessionFile(ws, expert, session);
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return parseLedgerRaw(raw);
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
// askBusy 供 SSE 端点诚实告知「排队中」（多用户并发原型取舍）。
let askChain: Promise<unknown> = Promise.resolve();
let askBusy = false;

function askSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = askChain.then(async () => {
    askBusy = true;
    try {
      return await fn();
    } finally {
      askBusy = false;
    }
  });
  askChain = run.then(() => undefined, () => undefined);
  return run;
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
 *  输出，仅返回最终结果（SSE 端点用 stage 事件填充等待期）。 */
async function askStreamOnce(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
  onLog: (line: string) => void,
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
      runningProc = null;
    }
    return parseAskOut(chunks.join(""));
  }
  // 进程内车道：无增量输出，走 dhvRun 拿最终结果
  const r = await dhvRun(args, env);
  return parseAskOut(r.out);
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
//   done    AskOutcome 整体（answer/tokens/ctxLine/durationMs/turn/logs）
//   error   引擎失败（人话 message；aborted=true 表示用户停止，本轮未落账本）
// 客户端意外断开不中止运行：账本是事实源，轮次照常落盘（enqueue 静默失败）；
// 显式停止走 POST /api/abort（SIGKILL 子进程，干净丢弃该轮）。

const SSE_STAGE_MS = 2600;

function sseAsk(
  ws: string,
  req: { expert: string; question: string; session: string; model: string },
): Response {
  const enc = new TextEncoder();
  let closed = false;
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
      send("open", { expert: req.expert, session: req.session, model: req.model, queued: askBusy });
      try {
        const outcome = await askSerialized(async () => {
          send("start", { model: req.model });
          abortRequested = false; // 队列轮到本轮：复位停止标记
          let stageIdx = 0;
          const ticker = setInterval(() => {
            send("stage", { stage: ASK_STAGES[stageIdx % ASK_STAGES.length]!, n: stageIdx + 1 });
            stageIdx++;
          }, SSE_STAGE_MS);
          try {
            return await askStreamOnce(ws, req, (line) => send("log", { line }));
          } finally {
            clearInterval(ticker);
          }
        });
        if (abortRequested && !outcome.ok) {
          send("error", { aborted: true, message: "已停止：本轮未落账本" });
        } else {
          send("done", outcome);
        }
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        abortRequested = false;
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
        // ---- 停止生成（issue #12：SIGKILL 当前直连子进程，本轮不落账本）----
        if (route === "POST /api/abort") {
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
          const outcome = await askSerialized(() => askOnce(ws, { expert, question, session, model }));
          return json(outcome as unknown as Record<string, unknown>, outcome.ok ? 200 : 500);
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
  console.log(`  停止       POST /api/abort（SIGKILL 当前直连，该轮不落账本）`);
  console.log(`  模型       ${p.model}（GUI 可切 scripted/deepseek，请求体可逐次覆盖）`);
  console.log(`  Ctrl+C 退出`);
  process.on("SIGINT", () => { server.stop(true); process.exit(0); });
  process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
  await new Promise<void>(() => { /* 常驻：信号退出统一走 server.stop */ });
  return 0;
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

  @media (max-width: 720px) {
    aside { display: none; }
    .chat { padding: 16px 12px 24px; }
  }
</style>
</head>
<body>
<header>
  <span class="brand">org</span>
  <span class="ver">v${VERSION}</span>
  <span class="path" id="wsPath"></span>
  <span class="tstats" id="topStats"></span>
</header>
<div class="app">
  <aside>
    <button class="newbtn" id="newSession" type="button">+ 新会话</button>
    <div class="sec">sessions<span class="cnt" id="sessCount"></span></div>
    <div class="list" id="sessions"></div>
    <div class="sec">experts<span class="cnt" id="expertCount"></span></div>
    <div class="list" id="experts"></div>
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
        <div class="seg" id="modelSeg" role="radiogroup" aria-label="模型选择">
          <button type="button" data-model="scripted" class="on">scripted</button>
          <button type="button" data-model="deepseek">deepseek</button>
        </div>
        <button id="send" type="button">发送</button>
      </div>
    </div>
    <footer class="statusbar" id="statusbar"></footer>
  </main>
</div>
<script>
var VER = "${VERSION}";
var state = {
  experts: [], usages: [], currentExpert: null, currentSession: null,
  model: "scripted", running: false, myRunStarted: false,
  lastQuestion: "", turns: [], atBottom: true
};
var lastSessions = [];
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
  var m = /(\\d+)\\/([\\d.]+)k/.exec(ctxLine || "");
  var p = /([\\d.]+)%/.exec(ctxLine || "");
  if (!m) return esc(ctxLine || "");
  var pct = p ? Math.max(1.2, Math.min(100, parseFloat(p[1]))) : 1.2;
  var txt = m[1] + "/" + m[2] + "k";
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
    return '<div class="exp' + (state.currentExpert === e.name ? " active" : "") +
      '" data-name="' + esc(e.name) + '" title="' + esc(title + " · " + e.description) + '">' +
      '<div class="l1"><span class="nm">' + esc(e.name) + '</span>' +
      '<span class="vr">@' + esc(e.version) + '</span>' + bdg + '</div>' +
      '<div class="l2">' + esc(e.description) + '</div></div>';
  }).join("") || '<div class="l2" style="padding:4px 8px">注册表为空</div>';
  Array.prototype.forEach.call(el.querySelectorAll(".exp"), function (node) {
    node.onclick = function () { if (!state.running) selectExpert(node.dataset.name); };
  });
}

function renderSessions() {
  var el = document.getElementById("sessions");
  document.getElementById("sessCount").textContent =
    lastSessions.length ? String(lastSessions.length) : "";
  el.innerHTML = lastSessions.map(function (s) {
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
  }).join("") || '<div class="l2" style="padding:4px 10px">暂无会话账本 · 提问即写账本</div>';
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
    if (!state.running) selectSession(id);
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
    '<div class="b-row"><span class="b-k">keys</span><span class="b-v">enter 发送 · shift+enter 换行 · esc 停止</span></div>' +
    '</div>';
}

function turnHtml(t) {
  var meta = "org · " + (state.currentExpert || "?") + " · turn " + t.turn +
    " · " + t.tokens + " tok · ctx " + t.ctx_tokens;
  return '<div class="t-user"><span class="ps">❯</span><span class="q">' +
    esc(t.question) + '</span></div>' +
    '<div class="t-bot"><div class="who">' + esc(meta) + '</div>' +
    '<div class="body">' + esc(t.answer || "（空回答）") + '</div></div>';
}

function renderChat() {
  var el = document.getElementById("chat");
  if (state.turns.length === 0) { el.innerHTML = bannerHtml(); return; }
  el.innerHTML = state.turns.map(turnHtml).join("");
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
    setStage("排队中：前一轮仍在运行，尚不能停止");
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
    a.textContent = answerLines.join("\\n");
    a.insertAdjacentHTML("beforeend", '<span class="caret">▌</span>');
  }

  function onEvent(ev, d) {
    if (settled) return;
    if (ev === "open") {
      if (d && d.queued) setStage("排队中（前一轮直连仍在运行）…");
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
      finalize(null, (d && d.message) || "引擎失败", d && d.aborted);
    }
  }

  function finalize(outcome, errMsg, aborted) {
    if (settled) return;
    settled = true;
    stopSpin();
    var pending = el("pending");
    if (pending) pending.remove();
    var chat = document.getElementById("chat");
    if (outcome) {
      var meta = "org · " + state.currentExpert + " · turn " +
        (outcome.turn == null ? "-" : outcome.turn) + " · " +
        (outcome.tokens == null ? "-" : outcome.tokens) + " tok" +
        (outcome.durationMs == null ? "" : " · " + outcome.durationMs + " ms");
      chat.insertAdjacentHTML("beforeend",
        '<div class="t-bot"><div class="who">' + esc(meta) + '</div>' +
        '<div class="body">' + esc(outcome.answer || "（无回答）") + '</div>' +
        '<div class="obs">' + meterHtml(outcome.ctxLine) +
        '<span>ledger 已落盘</span></div>' +
        logWinHtml(outcome.logs || "", false) + '</div>');
      state.turns.push({
        turn: outcome.turn == null ? state.turns.length + 1 : outcome.turn,
        question: question,
        answer: outcome.answer || "",
        tokens: outcome.tokens == null ? 0 : outcome.tokens,
        ctx_tokens: 0,
        durationMs: outcome.durationMs,
      });
    } else if (aborted) {
      var partial = answerLines.join("\\n");
      var html = '<div class="t-bot">';
      if (partial) {
        html += '<div class="who">org · ' + esc(state.currentExpert) + ' · stopped</div>' +
          '<div class="body">' + esc(partial) + '</div>';
      }
      html += '<div class="stoppedbox">■ 已停止 · 本轮未落账本</div></div>';
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

// 日志窗口折叠 / 重试按钮：对话区事件委托
document.getElementById("chat").addEventListener("click", function (e) {
  var lh = e.target.closest(".loghead");
  if (lh) {
    lh.parentElement.classList.toggle("open");
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
  if (e.key === "Escape" && state.running) stopRun();
});
document.getElementById("send").onclick = function () {
  if (state.running) stopRun(); else ask();
};
document.getElementById("newSession").onclick = function () {
  if (state.running) return;
  state.currentSession = "web-" + Date.now().toString(36);
  state.turns = [];
  renderSessions(); renderChat(); renderCrumb(); renderStatusbar();
};

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

api("/api/status").then(function (r) {
  state.experts = r.experts || [];
  state.usages = r.usages || [];
  state.workspace = r.workspace || "";
  if (r.model === "scripted" || r.model === "deepseek") state.model = r.model;
  document.getElementById("wsPath").textContent = r.workspace || "";
  renderTop(); renderExperts(); renderSeg(); renderStatusbar();
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
