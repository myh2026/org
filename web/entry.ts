// ============================================================================
// org/web/entry.ts — Web GUI 入口（Bun.serve 零依赖，issue #10 路线图 1-3 点）
// ----------------------------------------------------------------------------
//   org web [--port N] [--workspace DIR] [--model scripted|deepseek]
//     Bun.serve 起轻量 HTTP（默认端口 4600，避开本机 3000/3030/5000 服务），
//     单页内联 HTML（无静态文件 / 无第三方依赖），原生 fetch 交互。
//
// 端面（GUI 是薄渲染层，逻辑全部复用 CLI 同一代码路径）：
//   GET  /                        单页 GUI（深色琥珀主题三区布局）
//   GET  /api/status              专家清单（loadRegistryIndex）+ 会话上下文占用
//                                  （listContextUsage）——与 org status 同数据源
//   GET  /api/sessions?expert=X   会话列表（runtime/sessions/<expert>/*.jsonl：
//                                  id / 轮数 / mtime / 首问预览）
//   GET  /api/session/<E>/<S>     逐轮 question/answer/tokens/ctx_tokens（账本
//                                  健壮解析：记录边界重组 + 修复式正则兜底）
//   POST /api/ask                 进程内直连（DIRECT_ENTRY + ORG_ASK_* env +
//                                  expertFixtureOf 剧本自动发现 + dhvRun —— 与
//                                  org ask 同链路，不 spawn CLI 自身）
//   POST /api/ask-stream          同链路 SSE 流式版（issue #11）：open →
//                                  queued? → start → stage*（2.6s 轮换）→
//                                  log*（子进程 stdout 逐行实时）→ done/error。
//                                  spawn 车道 banner/配置行到达即推；进程内
//                                  车道降级为 stage+done 两类事件。
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

const VERSION = "0.4.8";
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
//   3. 失败再用字段定长布局的修复式正则兜底。

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
    // 2) 修复式：format! 固定字段布局（answer 含裸换行）
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

// ---- SSE 流式执行（issue #11：spawn 车道增量读子进程 stdout 逐行回调） ----

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
    await Promise.all([
      proc.exited,
      pump(proc.stdout as unknown as ReadableStream<Uint8Array>),
      pump(proc.stderr as unknown as ReadableStream<Uint8Array>),
    ]);
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

// ---- SSE 流式端点（issue #11）----
// 事件协议（`event: <type>\ndata: <json>\n\n`）：
//   open    请求回显 + 排队状态（queued=true 表示前一轮仍在跑）
//   start   串行队列轮到本轮（流水线真正开跑）
//   stage   等待期流水线阶段轮换（2.6s 一帧，direct.hsl 真实阶段）
//   log     子进程 stdout 逐行实时（banner/配置行/回答正文/收尾行）
//   done    AskOutcome 整体（answer/tokens/ctxLine/durationMs/turn/logs）
//   error   引擎失败（人话 message）
// 客户端断开不中止运行：账本是事实源，轮次照常落盘（enqueue 静默失败）。

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
        send("done", outcome);
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
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
          });
        }
        if (route === "GET /api/sessions") {
          const expert = url.searchParams.get("expert") ?? "";
          if (!SAFE_NAME.test(expert)) return json({ error: "expert 名不合法" }, 400);
          return json({ expert, sessions: listSessions(readWorkspaceOf(ws), expert) });
        }
        const sessionRoute = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
        if (req.method === "GET" && sessionRoute) {
          const expert = decodeURIComponent(sessionRoute[1]!);
          const id = decodeURIComponent(sessionRoute[2]!);
          if (!SAFE_NAME.test(expert) || !SAFE_NAME.test(id)) {
            return json({ error: "expert/session 名不合法" }, 400);
          }
          return json({ expert, session: id, turns: readSession(readWorkspaceOf(ws), expert, id) });
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
          // model 回落链（issue #11 修复）：请求体显式传 > 服务级
          // （org web --model deepseek）> scripted 缺省。此前服务级 flag
          // 被忽略（body 缺省写死 scripted）—— --model deepseek 启动后
          // GUI 不传 model 也应走 deepseek。
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
        // ---- 交互面（SSE 流式，issue #11）----
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
  console.log(`  交互面     POST /api/ask（JSON 整轮）· POST /api/ask-stream（SSE 流式）`);
  console.log(`  模型       ${p.model}（请求体可逐次覆盖）`);
  console.log(`  Ctrl+C 退出`);
  process.on("SIGINT", () => { server.stop(true); process.exit(0); });
  process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
  await new Promise<void>(() => { /* 常驻：信号退出统一走 server.stop */ });
  return 0;
}

// ---- 单页 GUI（内联 HTML：深色琥珀主题 · 原生 fetch · 中文文案） ----

function renderIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORG · 组织驾驶舱 Web</title>
<style>
  :root {
    --bg: #0c0a09; --panel: #1c1917; --panel2: #292524; --border: #44403c;
    --text: #d6d3d1; --muted: #a8a29e; --dim: #78716c;
    --amber: #f59e0b; --amber-soft: #b45309; --amber-bg: #78350f;
    --green: #4ade80; --red: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.6 ui-sans-serif,
         "PingFang SC", "Microsoft YaHei", sans-serif; height: 100vh;
         display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
           background: var(--panel); border-bottom: 1px solid var(--border); flex: none; }
  header .logo { color: var(--amber); font-weight: 700; letter-spacing: 1px; }
  header .meta { color: var(--dim); font-size: 12px; }
  .app { flex: 1; display: flex; min-height: 0; }
  aside { width: 300px; flex: none; background: var(--panel);
          border-right: 1px solid var(--border); overflow-y: auto; padding: 12px; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .chat { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .composer { flex: none; padding: 12px 16px; background: var(--panel);
              border-top: 1px solid var(--border); display: flex; gap: 8px; }
  h3.sec { color: var(--dim); font-size: 11px; letter-spacing: 2px; margin: 14px 0 8px; }
  h3.sec:first-child { margin-top: 0; }
  .expert { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
            margin-bottom: 6px; cursor: pointer; background: var(--bg); }
  .expert:hover { border-color: var(--amber-soft); }
  .expert.active { border-color: var(--amber); background: #1a1512; }
  .expert .row { display: flex; align-items: center; gap: 6px; }
  .expert .name { color: var(--text); font-weight: 600; }
  .expert .ver { color: var(--dim); font-size: 11px; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid; }
  .badge.star { color: var(--amber); border-color: var(--amber-soft); }
  .badge.cand { color: var(--muted); border-color: var(--border); }
  .badge.imp  { color: var(--green); border-color: #166534; }
  .expert .desc { color: var(--dim); font-size: 11px; margin-top: 2px;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session { padding: 6px 10px; border-radius: 6px; margin-bottom: 4px; cursor: pointer; }
  .session:hover { background: var(--panel2); }
  .session.active { background: var(--panel2); outline: 1px solid var(--amber-soft); }
  .session .id { color: var(--text); font-size: 12px; }
  .session .sub { color: var(--dim); font-size: 11px; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap; }
  .msg { max-width: 78%; margin: 10px 0; }
  .msg.user { margin-left: auto; }
  .bubble { padding: 10px 14px; border-radius: 12px; white-space: pre-wrap;
            word-break: break-word; }
  .msg.user .bubble { background: var(--amber-bg); border: 1px solid var(--amber-soft); }
  .msg.bot .bubble { background: var(--panel2); border: 1px solid var(--border); }
  .obs { font-size: 11px; color: var(--dim); margin-top: 4px; }
  .obs b { color: var(--muted); font-weight: 500; }
  .meter { display: inline-block; width: 120px; height: 6px; background: #3a3634;
           border-radius: 3px; vertical-align: middle; margin: 0 6px; overflow: hidden; }
  .meter i { display: block; height: 100%; background: linear-gradient(90deg,
             var(--amber-soft), var(--amber)); }
  /* SSE 等待态（issue #11）：阶段轮换行（光标呼吸）+ 运行日志终端折叠区 */
  .stage { color: var(--amber); font-size: 12px; }
  .stage::after { content: "▊"; margin-left: 3px; color: var(--amber);
                  animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  details.runlogs { margin-top: 8px; font-size: 11px; }
  details.runlogs summary { color: var(--dim); cursor: pointer; user-select: none; }
  details.runlogs summary:hover { color: var(--muted); }
  details.runlogs summary b { color: var(--amber-soft); font-weight: 600; }
  details.runlogs pre { margin-top: 6px; background: #0a0908; border: 1px solid #33302c;
      border-radius: 6px; padding: 8px 10px; color: #a8967a; font: 11px/1.5 ui-monospace,
      Menlo, Consolas, monospace; max-height: 160px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-all; }
  .answering { margin-top: 6px; color: var(--text); white-space: pre-wrap;
               word-break: break-word; }
  .answering .caret { color: var(--amber); animation: blink 1s steps(1) infinite; }
  .composer select, .composer input[type=text] { background: var(--bg);
      color: var(--text); border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 12px; font-size: 13px; outline: none; }
  .composer input[type=text] { flex: 1; }
  .composer input:focus, .composer select:focus { border-color: var(--amber-soft); }
  .composer button { background: var(--amber-soft); color: #fff; border: none;
      border-radius: 8px; padding: 8px 18px; cursor: pointer; font-size: 13px; }
  .composer button:hover { background: var(--amber); }
  .composer button:disabled { opacity: 0.5; cursor: not-allowed; }
  .composer button.ghost { background: transparent; border: 1px solid var(--border);
      color: var(--muted); }
  .empty { color: var(--dim); text-align: center; margin-top: 60px; line-height: 2; }
  .statusline { display: flex; gap: 18px; }
  .statusline span { color: var(--dim); font-size: 12px; }
  .statusline span b { color: var(--amber); font-weight: 600; }
</style>
</head>
<body>
<header>
  <span class="logo">ORG</span>
  <span class="meta">组织驾驶舱 · Web 原型</span>
  <div class="statusline" id="statusline" style="margin-left:auto"></div>
</header>
<div class="app">
  <aside>
    <h3 class="sec">专家（工具库）</h3>
    <div id="experts"></div>
    <h3 class="sec">会话（账本）</h3>
    <div id="sessions"></div>
  </aside>
  <main>
    <div class="chat" id="chat"><div class="empty">左侧选一位专家开始直连<br>（scripted 占位剧本秒回 · 提问后可见 SSE 流式：阶段轮换 + 实时运行日志）</div></div>
    <div class="composer">
      <select id="expertSel"></select>
      <input type="text" id="question" placeholder="向专家提问…（回车发送）" autofocus>
      <button class="ghost" id="newSession" title="开新会话（新账本文件）">＋ 新会话</button>
      <button id="send">发送</button>
    </div>
  </main>
</div>
<script>
var state = { experts: [], usages: [], currentExpert: null, currentSession: null };
var lastSessions = [];

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
// [ctx] 行 → 进度条（极小占比保底 1.2% 可见宽，与产品族 CtxMeter 同规则）
function meterHtml(ctxLine) {
  var m = /(\\d+(?:\\.\\d+)?)(k?)\\/(\\d+(?:\\.\\d+)?)(k?)（([\\d.]+)%/.exec(ctxLine || "");
  if (!m) return esc(ctxLine || "");
  var pct = Math.max(1.2, Math.min(100, parseFloat(m[5])));
  return '<span class="meter"><i style="width:' + pct + '%"></i></span>' + esc(ctxLine);
}

function renderStatus() {
  var totalTurns = state.usages.reduce(function (a, u) { return a + u.turns; }, 0);
  var billed = state.usages.reduce(function (a, u) { return a + u.billed; }, 0);
  document.getElementById("statusline").innerHTML =
    "<span>专家 <b>" + state.experts.length + "</b></span>" +
    "<span>会话 <b>" + state.usages.length + "</b></span>" +
    "<span>累计 <b>" + totalTurns + "</b> 轮 · <b>" + billed + "</b> tokens</span>";
}

function renderExperts() {
  var el = document.getElementById("experts");
  el.innerHTML = state.experts.map(function (e) {
    var badge = e.source === "import"
      ? '<span class="badge imp">import</span>'
      : (e.retained ? '<span class="badge star">★</span>' : '<span class="badge cand">○</span>');
    var title = e.source === "import" ? "用户导入（入库即保留）"
      : (e.retained ? "保留（B 路径自动复用）" : "候选（未保留）");
    return '<div class="expert' + (state.currentExpert === e.name ? " active" : "") +
      '" data-name="' + esc(e.name) + '">' +
      '<div class="row"><span class="name">' + esc(e.name) + '</span>' +
      '<span class="ver">@' + esc(e.version) + "</span>" + badge +
      '<span style="margin-left:auto;color:var(--dim);font-size:11px" title="' + title + '">' +
      esc(e.source) + "</span></div>" +
      '<div class="desc" title="' + esc(e.description) + '">' + esc(e.description) + "</div></div>";
  }).join("") || '<div class="empty">注册表为空</div>';
  Array.prototype.forEach.call(el.querySelectorAll(".expert"), function (node) {
    node.onclick = function () { selectExpert(node.dataset.name); };
  });
  var sel = document.getElementById("expertSel");
  sel.innerHTML = state.experts.map(function (e) {
    return '<option value="' + esc(e.name) + '">' + esc(e.name) + "</option>";
  }).join("");
  if (state.currentExpert) sel.value = state.currentExpert;
}

function renderSessions(sessions) {
  lastSessions = sessions;
  var el = document.getElementById("sessions");
  el.innerHTML = sessions.map(function (s) {
    return '<div class="session' + (state.currentSession === s.id ? " active" : "") +
      '" data-id="' + esc(s.id) + '"><div class="id">' + esc(s.id) +
      " · " + s.turns + " 轮</div>" +
      '<div class="sub" title="' + esc(s.id) + '">' + relTime(s.lastAt) + " · " + esc(s.preview) + "</div></div>";
  }).join("") || '<div class="sub" style="color:var(--dim);padding:4px 10px">暂无会话账本</div>';
  Array.prototype.forEach.call(el.querySelectorAll(".session"), function (node) {
    node.onclick = function () { selectSession(node.dataset.id); };
  });
}

function msgHtml(who, text) {
  return '<div class="msg ' + who + '"><div class="bubble">' + esc(text) + "</div></div>";
}

function selectExpert(name) {
  state.currentExpert = name;
  state.currentSession = null;
  renderExperts();
  document.getElementById("chat").innerHTML =
    '<div class="empty">已选专家 <b style="color:var(--amber)">' + esc(name) +
    "</b> · 正在装载会话账本…</div>";
  api("/api/sessions?expert=" + encodeURIComponent(name)).then(function (r) {
    renderSessions(r.sessions || []);
    if ((r.sessions || []).length > 0) {
      selectSession(r.sessions[0].id);
    } else {
      document.getElementById("chat").innerHTML =
        '<div class="empty">专家 <b style="color:var(--amber)">' + esc(name) +
        "</b> 无历史会话<br>下方直接提问即开新账本</div>";
    }
  });
}

function selectSession(id) {
  state.currentSession = id;
  api("/api/session/" + encodeURIComponent(state.currentExpert) + "/" + encodeURIComponent(id))
    .then(function (r) {
      renderSessions(lastSessions);
      var chat = document.getElementById("chat");
      var html = (r.turns || []).map(function (t) {
        return msgHtml("user", t.question) +
          '<div class="msg bot"><div class="bubble">' + esc(t.answer) + "</div>" +
          '<div class="obs">turn ' + t.turn + " · <b>" + t.tokens + " tokens</b> · ctx " + t.ctx_tokens + "</div></div>";
      }).join("");
      chat.innerHTML = html || '<div class="empty">空会话</div>';
      chat.scrollTop = chat.scrollHeight;
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

function ask() {
  var expert = document.getElementById("expertSel").value || state.currentExpert;
  var question = document.getElementById("question").value.trim();
  if (!expert || !question) return;
  var session = state.currentSession || "default";
  var btn = document.getElementById("send");
  btn.disabled = true; btn.textContent = "运行中…";
  var chat = document.getElementById("chat");
  if (chat.querySelector(".empty")) chat.innerHTML = "";
  chat.insertAdjacentHTML("beforeend",
    msgHtml("user", question) +
    '<div class="msg bot" id="pending"><div class="bubble">' +
    '<div class="stage" id="pstage">启动直连流水线…</div>' +
    '<div class="answering" id="panswer" style="display:none"></div>' +
    '<details class="runlogs" id="plogs"><summary>运行日志（<b id="plogn">0</b> 行 · 实时）</summary><pre id="plogbody"></pre></details>' +
    "</div></div>");
  chat.scrollTop = chat.scrollHeight;
  var inAnswer = false, answerLines = [];
  var settled = false;

  function el(id) { return document.getElementById(id); }
  function setStage(text) { var n = el("pstage"); if (n) n.textContent = text; }
  function scrollDown() { chat.scrollTop = chat.scrollHeight; }
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
    a.insertAdjacentHTML("beforeend", '<span class="caret">▊</span>');
  }

  function onEvent(ev, d) {
    if (settled) return;
    if (ev === "open") {
      if (d && d.queued) setStage("排队中（前一轮直连仍在运行）…");
    } else if (ev === "start") {
      setStage("流水线开跑（" + ((d && d.model) || "scripted") + "）");
    } else if (ev === "stage") {
      setStage("org 流水线 · " + ((d && d.stage) || ""));
    } else if (ev === "log" && d && d.line) {
      var line = d.line;
      appendLog(line);
      if (/^\\[direct\\]/.test(line)) {
        inAnswer = true; answerLines = [];
        setStage("回答输出中（子进程 stdout 逐行回传）…");
      } else if (line.indexOf("[ctx]") === 0) {
        inAnswer = false;
        setStage("记账与纪要回写…");
      } else if (line.indexOf("harness 返回") >= 0) {
        inAnswer = false;
      } else if (inAnswer) {
        answerLines.push(line);
        renderAnswer();
      }
      scrollDown();
    } else if (ev === "done") {
      finalize(d);
    } else if (ev === "error") {
      finalize(null, (d && d.message) || "引擎失败");
    }
  }

  function finalize(outcome, errMsg) {
    if (settled) return;
    settled = true;
    var pending = el("pending");
    if (pending) pending.remove();
    if (outcome) {
      var meta = "turn " + (outcome.turn == null ? "-" : outcome.turn) + " · <b>" +
        (outcome.tokens == null ? "-" : outcome.tokens) + " tokens</b>" +
        (outcome.durationMs == null ? "" : " · " + outcome.durationMs + " ms") +
        " · ctx " + meterHtml(outcome.ctxLine);
      chat.insertAdjacentHTML("beforeend",
        '<div class="msg bot"><div class="bubble">' +
        esc(outcome.answer || "（无回答）") + "</div>" +
        '<details class="runlogs"><summary>运行日志</summary><pre>' +
        esc(outcome.logs || "") + "</pre></details>" +
        '<div class="obs">' + meta + "</div></div>");
      if (!state.currentSession) state.currentSession = session;
    } else {
      chat.insertAdjacentHTML("beforeend",
        '<div class="msg bot"><div class="bubble" style="color:var(--red)">直连失败：' +
        esc(errMsg || "未知错误") + "</div></div>");
    }
    scrollDown();
    api("/api/sessions?expert=" + encodeURIComponent(expert))
      .then(function (x) { renderSessions(x.sessions || []); });
  }

  fetch("/api/ask-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expert: expert, question: question, session: session }),
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
    btn.disabled = false; btn.textContent = "发送";
    document.getElementById("question").value = "";
    document.getElementById("question").focus();
  });
}

document.getElementById("send").onclick = ask;
document.getElementById("question").addEventListener("keydown", function (e) {
  if (e.key === "Enter") ask();
});
document.getElementById("newSession").onclick = function () {
  var d = new Date();
  var p = function (n) { return String(n).padStart(2, "0"); };
  state.currentSession = "web-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  document.getElementById("chat").innerHTML =
    '<div class="empty">新会话 <b style="color:var(--amber)">' + state.currentSession +
    "</b> 已就绪 · 提问即写账本</div>";
  renderSessions(lastSessions);
};
document.getElementById("expertSel").addEventListener("change", function (e) {
  selectExpert(e.target.value);
});

// 启动装载 + 顶栏摘要周期刷新（15s，只重读占用不动对话区）
api("/api/status").then(function (r) {
  state.experts = r.experts || [];
  state.usages = r.usages || [];
  renderStatus(); renderExperts();
  if (state.experts.length > 0) selectExpert(state.experts[0].name);
});
setInterval(function () {
  api("/api/status").then(function (r) {
    state.usages = r.usages || []; renderStatus();
  });
}, 15000);
</script>
</body>
</html>`;
}
