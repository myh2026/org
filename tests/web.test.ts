// ============================================================================
// tests/web.test.ts — org web 子命令机制级测试（issue #10 路线图 1-3 点）
// ----------------------------------------------------------------------------
// 覆盖「Bun.serve 零依赖 Web GUI 原型」的完整语义：
//   1. 页面：GET / 返回单页 HTML（内联 · 深色琥珀主题 · 无第三方依赖）
//   2. 只读面：GET /api/status（专家清单 + 上下文占用）· /api/sessions?expert
//      （会话列表：id/轮数/首问预览）· /api/session/<E>/<S>（逐轮问答）
//   3. 交互面：POST /api/ask —— 进程内直连（DIRECT_ENTRY + 剧本自动发现），
//      scripted 占位剧本秒回，响应含 answer/tokens/ctxLine/durationMs/turn
//   4. 账本健壮解析：标准 JSON 与存量坏账本（format! 裸插值多行 answer）双形态
//   5. 防呆面：expert/session 名路径穿越拒绝 · ask 必填字段校验 · 未知端点 404
// 服务用可编程入口 startWebServer（--port 0 随机高端口），afterAll 停服 ——
// CI 无残留进程、无端口冲突（绝不用 3000/3030/5000/4600 固定端口）。
// ============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { TEST_RUN, runOrg, makeWorkspace, exists } from "./helpers";
import { startWebServer, parseLedgerRaw, parseAskOut } from "../web/entry.ts";

/** 诗人 harness 样本（导入测试用）：/// 人格文档 + #[capability] 注解，
 *  import 时自动生成占位剧本（direct:poet 轨道）—— scripted 秒回。 */
const POET_HARNESS = `/// 诗人（Poet）：一位专业诗人，深谙现代诗、古典格律诗与俳句。
#[capability(llm_call)]
#[capability(poetry)]
export fn main() -> Result<(), String> {
    println!("poet harness on duty");
    Ok(())
}
`;

describe("Web GUI 原型：服务端到端（startWebServer · port 0 随机）", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;

  beforeAll(() => {
    // 一次性工作区：notice-parser（模板自带）+ poet（导入 → 占位剧本）
    ws = makeWorkspace("web-e2e");
    const src = path.join(TEST_RUN, "web-poet.hsl");
    fs.mkdirSync(TEST_RUN, { recursive: true });
    fs.writeFileSync(src, POET_HARNESS);
    const imp = runOrg(["import", src, "--workspace", ws, "--name", "poet"]);
    if (!imp.ok) console.error(imp.stdout + imp.stderr);
    expect(imp.ok).toBe(true);
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.port).toBeGreaterThan(1024); // 随机高端口，非固定端口
  });

  afterAll(() => {
    server.stop(true);
  });

  test("GET / 返回单页 HTML（内联 · 中文 UI · 无外链依赖）", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("组织驾驶舱");          // 顶栏标识
    expect(html).toContain("专家（工具库）");       // 左侧栏
    expect(html).toContain("向专家提问");           // 底部输入框
    expect(html).toContain("#0c0a09");             // 深色琥珀主题（stone-950）
    expect(html).toContain("#f59e0b");             // amber 点缀
    expect(html).not.toMatch(/src="http|href="http/); // 零外链（无静态文件）
  });

  test("GET /api/status：专家清单（含导入 poet）+ 上下文占用（与 org status 同源）", async () => {
    const r = await fetch(base + "/api/status");
    expect(r.status).toBe(200);
    const st = (await r.json()) as {
      workspace: string;
      experts: Array<{ name: string; version: string; source: string; retained: boolean; description: string }>;
      usages: Array<{ expert: string; session: string; turns: number; billed: number; context: number; window: number }>;
      windowTokens: number;
    };
    expect(st.workspace).toBe(ws);
    const names = st.experts.map((e) => e.name);
    expect(names).toContain("notice-parser"); // 模板自带（manual · 保留）
    expect(names).toContain("poet");          // 导入（import · 入库即保留）
    const poet = st.experts.find((e) => e.name === "poet")!;
    expect(poet.source).toBe("import");
    expect(poet.retained).toBe(true);
    expect(poet.description).toContain("诗人");
    expect(st.windowTokens).toBe(131_072);
    expect(Array.isArray(st.usages)).toBe(true);
  });

  test("GET /api/sessions?expert=poet：导入后无会话 → 空列表（账本按需生成）", async () => {
    const r = await fetch(base + "/api/sessions?expert=poet");
    expect(r.status).toBe(200);
    const data = (await r.json()) as { expert: string; sessions: unknown[] };
    expect(data.expert).toBe("poet");
    expect(data.sessions).toEqual([]);
  });

  test("POST /api/ask：进程内直连（scripted 占位剧本秒回 + 观测元数据）", async () => {
    const r = await fetch(base + "/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "写一首关于秋夜湖面的四行现代诗", session: "web-t1" }),
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      ok: boolean; answer: string; tokens: number | null;
      ctxLine: string; durationMs: number | null; turn: number | null; logs: string;
    };
    expect(out.ok).toBe(true);
    expect(out.answer).toContain("占位剧本应答");    // scripted 轨道内容
    expect(out.tokens).toBeGreaterThan(0);          // 记账 tokens
    expect(out.ctxLine).toContain("[ctx] 窗口占用"); // Codex 风格计量条
    expect(out.ctxLine).toContain("▓");             // meter 条
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.turn).toBe(1);                       // 新会话首轮
    expect(out.logs).toContain("harness 返回 Ok");  // 引擎收尾行
  });

  test("ask 之后：会话账本落盘 → sessions 列表与逐轮读取全链路", async () => {
    // 账本文件（org 磁盘事实源，GUI 不另建副本）
    expect(exists(path.join(ws, "runtime/sessions/poet/web-t1.jsonl"))).toBe(true);
    // 会话列表：id / 轮数 / mtime / 首问预览
    const ls = (await (await fetch(base + "/api/sessions?expert=poet")).json()) as {
      sessions: Array<{ id: string; turns: number; lastAt: string; preview: string }>;
    };
    expect(ls.sessions.length).toBe(1);
    expect(ls.sessions[0]!.id).toBe("web-t1");
    expect(ls.sessions[0]!.turns).toBe(1);
    expect(ls.sessions[0]!.preview).toContain("秋夜湖面");
    // 逐轮问答：question/answer/tokens/ctx_tokens
    const detail = (await (await fetch(base + "/api/session/poet/web-t1")).json()) as {
      expert: string; session: string;
      turns: Array<{ turn: number; question: string; answer: string; tokens: number; ctx_tokens: number }>;
    };
    expect(detail.expert).toBe("poet");
    expect(detail.turns.length).toBe(1);
    const t = detail.turns[0]!;
    expect(t.turn).toBe(1);
    expect(t.question).toContain("秋夜湖面");
    expect(t.answer).toContain("占位剧本应答");
    expect(t.tokens).toBeGreaterThan(0);
    expect(t.ctx_tokens).toBeGreaterThan(0);
  });

  test("POST /api/ask 第二轮：同会话 ctx 单调增长（会话史织入提示词）", async () => {
    const r = await fetch(base + "/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "再用俳句写同一个主题", session: "web-t1" }),
    });
    const out = (await r.json()) as { ok: boolean; turn: number | null; ctxLine: string };
    expect(out.ok).toBe(true);
    expect(out.turn).toBe(2);
    // 逐轮读取：两轮都在账本里
    const detail = (await (await fetch(base + "/api/session/poet/web-t1")).json()) as {
      turns: Array<{ turn: number; ctx_tokens: number }>;
    };
    expect(detail.turns.length).toBe(2);
    expect(detail.turns[1]!.ctx_tokens).toBeGreaterThan(detail.turns[0]!.ctx_tokens);
  });

  test("防呆：ask 必填字段缺失 → 400；expert 名路径穿越编码 → 400", async () => {
    const r1 = await fetch(base + "/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "", question: "x" }),
    });
    expect(r1.status).toBe(400);
    const r2 = await fetch(base + "/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r2.status).toBe(400);
    // 路径穿越（%2e%2e%2f 绕过 URL 规范化，在 handler 的 decode 后被拒）
    const r3 = await fetch(base + "/api/session/%2e%2e%2fregistry/index");
    expect(r3.status).toBe(400);
  });

  test("未知端点 404（/api/* JSON 形态；其余纯文本）", async () => {
    const r = await fetch(base + "/api/unknown");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain("未知端点");
    const r2 = await fetch(base + "/no-such-page");
    expect(r2.status).toBe(404);
  });
});

describe("Web GUI 原型：纯函数（账本解析 / stdout 解析）", () => {
  test("parseLedgerRaw：标准 JSON 账本（含转义换行）逐轮解析", () => {
    const raw = [
      '{"turn":1,"question":"q1","answer":"a1\\n多行","tokens":10,"ctx_tokens":42}',
      '{"turn":2,"question":"q2","answer":"a2","tokens":5,"ctx_tokens":60}',
    ].join("\n") + "\n";
    const turns = parseLedgerRaw(raw);
    expect(turns.length).toBe(2);
    expect(turns[0]!.answer).toBe("a1\n多行");
    expect(turns[1]!.ctx_tokens).toBe(60);
  });

  test("parseLedgerRaw：存量坏账本（format! 裸插值 · answer 带字面换行）修复式解析", () => {
    // 上游 append_session 缺陷形态：多行 answer 落盘带裸换行（v0.4.6 前存量）
    const raw = [
      '{"turn":1,"question":"写一首诗","answer":"《秋夜湖面》',
      '',
      '湖光潋滟映秋空，',
      '月影徘徊水镜中。","tokens":27,"ctx_tokens":59}',
    ].join("\n") + "\n";
    const turns = parseLedgerRaw(raw);
    expect(turns.length).toBe(1);
    expect(turns[0]!.turn).toBe(1);
    expect(turns[0]!.question).toBe("写一首诗");
    expect(turns[0]!.answer).toContain("《秋夜湖面》");
    expect(turns[0]!.answer).toContain("月影徘徊水镜中。");
    expect(turns[0]!.tokens).toBe(27);
    expect(turns[0]!.ctx_tokens).toBe(59);
  });

  test("parseLedgerRaw：坏行容忍（无法解析的 segment 静默跳过）", () => {
    const raw = 'garbage line\n{"turn":1,"question":"q","answer":"a","tokens":1,"ctx_tokens":2}\n';
    const turns = parseLedgerRaw(raw);
    expect(turns.length).toBe(1);
    expect(parseLedgerRaw("")).toEqual([]);
  });

  test("parseAskOut：direct.hsl stdout（单轮形态 → answer/ctx/duration）解析", () => {
    const out = [
      "  ┌─────────┐ banner ...",
      "",
      "[direct] poet 回答（31 tokens）：",
      "[imported harness poet] 占位剧本应答（导入时自动生成）。",
      "[ctx] 窗口占用 ▓░░░░░░░░░░░ 63/131.0k（0.0%）（1 轮累计）",
      "",
      "✓ harness 返回 Ok（35 ms）",
      "",
      "产物：/somewhere/out-ask/report.md",
    ].join("\n");
    const r = parseAskOut(out);
    expect(r.ok).toBe(true);
    expect(r.answer).toContain("占位剧本应答");
    expect(r.answer).not.toContain("[ctx]");   // answer 止于 [ctx] 行
    expect(r.tokens).toBe(31);
    expect(r.ctxLine).toContain("[ctx] 窗口占用");
    expect(r.ctxLine).toContain("1 轮累计");
    expect(r.durationMs).toBe(35);
    expect(r.turn).toBe(1);
  });

  test("parseAskOut：多轮形态（turn N —— 专家（X tokens））解析", () => {
    const out = [
      "[direct] turn 2 —— poet（19 tokens）：",
      "第二行回答",
      "还有第三行",
      "[ctx] 窗口占用 ▓░ 99/131.0k（0.1%）（2 轮累计）",
      "✓ harness 返回 Ok（48 ms）",
    ].join("\n");
    const r = parseAskOut(out);
    expect(r.ok).toBe(true);
    expect(r.turn).toBe(2);
    expect(r.tokens).toBe(19);
    expect(r.answer).toBe("第二行回答\n还有第三行");
    expect(r.durationMs).toBe(48);
  });

  test("parseAskOut：失败输出（harness 返回 Err）→ ok=false", () => {
    const r = parseAskOut("✗ harness 返回 Err：usage（org ask <expert> …）");
    expect(r.ok).toBe(false);
    expect(r.answer).toBe("");
    expect(r.tokens).toBeNull();
  });
});
