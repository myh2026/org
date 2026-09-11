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
import { startWebServer, parseLedgerRaw, parseAskOut, parseWebArgv, renderMd } from "../web/entry.ts";

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

  test("GET / 返回单页 HTML（Codex 风终端美学 · 无外链依赖）", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("direct harness");       // 面包屑/空态 banner 标识
    expect(html).toContain("输入问题");              // 输入坞 placeholder
    expect(html).toContain("❯");                    // 用户转写行提示符
    expect(html).toContain("#0a0a0b");             // 近黑 zinc 底（issue #12）
    expect(html).toContain("#d97706");             // 琥珀仅作品牌微标记
    expect(html).toContain('id="statusbar"');       // tmux 式底部状态栏
    expect(html).toContain('id="modelSeg"');        // 模型切换分段控制
    expect(html).toContain('"/api/abort"');         // 停止生成端点
    expect(html).toContain('id="jumpBtn"');         // 回到最新悬浮按钮
    expect(html).toContain("renderMd");              // Markdown 渲染器注入（issue #13）
    expect(html).toContain('id="sessSearch"');       // 会话搜索框
    expect(html).toContain('id="menuBtn"');          // 移动端抽屉菜单钮
    expect(html).toContain('id="backdrop"');         // 移动端遮罩
    expect(html).toContain("mact-copy");             // 消息级复制钮
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

  // ---- SSE 流式端点（issue #11）----

  /** 解析一段完整 SSE 文本 → {event → data[]} 映射（帧边界 \n\n）。 */
  function parseSse(text: string): Map<string, unknown[]> {
    const out = new Map<string, unknown[]>();
    for (const frame of text.split("\n\n")) {
      if (!frame.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let obj: unknown = dataLines.join("");
      try { obj = JSON.parse(dataLines.join("")); } catch { /* 保留原文 */ }
      const list = out.get(event) ?? [];
      list.push(obj);
      out.set(event, list);
    }
    return out;
  }

  test("POST /api/ask-stream：SSE 事件全链（open → start → log* → done）+ 账本落盘", async () => {
    const r = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "写一首关于冬夜的俳句", session: "web-sse1" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("cache-control")).toContain("no-cache");
    const text = await r.text(); // 服务端 done 后关流，text() 完整收尾
    const events = parseSse(text);

    // open：请求回显 + 排队状态
    const opens = events.get("open") as Array<{ expert: string; session: string; model: string; queued: boolean }>;
    expect(opens?.length).toBe(1);
    expect(opens[0]!.expert).toBe("poet");
    expect(opens[0]!.session).toBe("web-sse1");
    expect(opens[0]!.queued).toBe(false);
    // start：流水线开跑（模型回显）
    expect((events.get("start") as Array<{ model: string }>)?.[0]!.model).toBe("scripted");
    // log：子进程 stdout 逐行实时（spawn 车道：banner / 配置 / direct / ctx / Ok）
    const logs = (events.get("log") as Array<{ line: string }>) ?? [];
    expect(logs.length).toBeGreaterThan(5);
    const joined = logs.map((l) => l.line).join("\n");
    expect(joined).toContain("dhv-ts");            // banner（工具链身份行）
    expect(joined).toMatch(/hsl[\\/]pool[\\/]direct\.hsl/); // 配置行（入口，路径分隔符平台无关）
    expect(joined).toContain("[direct]");           // 回答头行
    expect(joined).toContain("harness 返回 Ok");    // 收尾行
    // done：AskOutcome 整体
    const dones = events.get("done") as Array<{
      ok: boolean; answer: string; tokens: number | null;
      ctxLine: string; durationMs: number | null; turn: number | null;
    }>;
    expect(dones?.length).toBe(1);
    const done = dones[0]!;
    expect(done.ok).toBe(true);
    expect(done.answer).toContain("占位剧本应答");
    expect(done.tokens).toBeGreaterThan(0);
    expect(done.ctxLine).toContain("[ctx] 窗口占用");
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.turn).toBe(1); // web-sse1 新会话首轮
    // error 事件不应出现
    expect(events.has("error")).toBe(false);
    // 账本落盘（磁盘事实源）
    expect(exists(path.join(ws, "runtime/sessions/poet/web-sse1.jsonl"))).toBe(true);
  });

  test("ask-stream 第二轮：同会话 turn=2 + ctx 单调增长（与 JSON 端点同语义）", async () => {
    const r = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "再写一首同主题的现代诗", session: "web-sse1" }),
    });
    expect(r.status).toBe(200);
    const events = parseSse(await r.text());
    const done = (events.get("done") as Array<{ ok: boolean; turn: number | null; ctxLine: string }>)[0]!;
    expect(done.ok).toBe(true);
    expect(done.turn).toBe(2);
    expect(done.ctxLine).toContain("2 轮累计");
    const detail = (await (await fetch(base + "/api/session/poet/web-sse1")).json()) as {
      turns: Array<{ turn: number; ctx_tokens: number }>;
    };
    expect(detail.turns.length).toBe(2);
    expect(detail.turns[1]!.ctx_tokens).toBeGreaterThan(detail.turns[0]!.ctx_tokens);
  });

  test("ask-stream 防呆：必填缺失/坏 JSON → 400 JSON（流建立前拒绝）", async () => {
    const r1 = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "", question: "x" }),
    });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toContain("必填");
    const r2 = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r2.status).toBe(400);
  });

  // ---- 停止/取消（v0.4.14：排队轮票据化预取消）----

  test("POST /api/abort：空转时诚实告知（无 body → 传统语义 ok:false）", async () => {
    const r = await fetch(base + "/api/abort", { method: "POST" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; aborted: boolean; message: string };
    expect(j.ok).toBe(false);
    expect(j.aborted).toBe(false);
    expect(j.message).toContain("没有运行中的直连");
  });

  test("POST /api/abort {id}：查无此票 → 人话告知（不误报）", async () => {
    const r = await fetch(base + "/api/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 999999 }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; message: string };
    expect(j.ok).toBe(false);
    expect(j.message).toContain("不在排队中");
  });

  test("排队轮可预先取消（open{queued,ticketId} → abort{id} → error{aborted,queued}；不误伤前一轮）", async () => {
    // A：第一轮直连（spawn 车道真实运行，至少数百 ms —— 保证 B 稳定排队）
    const aP = fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "第一轮：写一句诗", session: "web-queue-a" }),
    });
    // B：紧随其后入队（不等待 A 完成）
    const b = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "第二轮：排队后被取消", session: "web-queue-b" }),
    });
    expect(b.status).toBe(200);

    // 增量读 B 的流：拿到 open 帧（queued=true + ticketId 回显）
    const reader = b.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let open: { queued: boolean; ticketId: number } | null = null;
    while (!open) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: open\ndata: (.*)\n\n/);
      if (m) open = JSON.parse(m[1]!) as { queued: boolean; ticketId: number };
    }
    expect(open).not.toBeNull();
    expect(open!.queued).toBe(true); // A 仍在跑（spawn 车道耗时 > 本测试的读帧时间）
    expect(open!.ticketId).toBeGreaterThan(0);

    // 取消排队的 B（不误伤 A）
    const ab = await fetch(base + "/api/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: open!.ticketId }),
    });
    const abj = (await ab.json()) as { ok: boolean; aborted: boolean; queued: boolean };
    expect(abj.ok).toBe(true);
    expect(abj.aborted).toBe(true);
    expect(abj.queued).toBe(true);

    // B 的流以 error{aborted:true, queued:true} 收尾（服务端关流后 done）
    let bText = buf;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bText += dec.decode(value, { stream: true });
    }
    const bEvents = parseSse(bText);
    expect(bEvents.has("start")).toBe(false); // 从未开跑
    expect(bEvents.has("done")).toBe(false); // 没有完整收轮
    const bErr = (bEvents.get("error") as Array<{ aborted: boolean; queued: boolean; message: string }>)[0]!;
    expect(bErr.aborted).toBe(true);
    expect(bErr.queued).toBe(true);
    expect(bErr.message).toContain("已取消排队");

    // A 完整收场（被取消的是 B，不误伤）
    const aRes = await aP;
    const aEvents = parseSse(await aRes.text());
    const aDone = (aEvents.get("done") as Array<{ ok: boolean; turn: number | null }>)[0]!;
    expect(aDone.ok).toBe(true);
    expect(aDone.turn).toBe(1);

    // 账本事实源：A 落盘、B 未落（取消的轮次从未运行）
    expect(exists(path.join(ws, "runtime/sessions/poet/web-queue-a.jsonl"))).toBe(true);
    expect(exists(path.join(ws, "runtime/sessions/poet/web-queue-b.jsonl"))).toBe(false);
  });

  test("GUI 单页含 SSE 消费实现（渐进渲染要素齐备）", async () => {
    const html = await (await fetch(base + "/")).text();
    // 前端走 /api/ask-stream + 阶段行 + 运行日志折叠区 + 渐进答案
    expect(html).toContain('"/api/ask-stream"');
    expect(html).toContain('id="pstage"');
    expect(html).toContain('id="plogbody"');
    expect(html).toContain('id="panswer"');
    expect(html).toContain("sseFrame");
    // 失败轮（done.ok=false）走错误块 + 重试，不再显示「无回答·已落盘」（v0.4.10 修复）
    expect(html).toContain("outcome && outcome.ok");
    // 旧 JSON 端点仍在服务端（兼容并存），但 GUI 已切流式
    expect(html).not.toContain('"/api/ask"');
  });

  test("GET /api/status 含服务级 model（GUI 初始值对齐 org web --model）", async () => {
    const st = (await (await fetch(base + "/api/status")).json()) as { model: string };
    expect(st.model).toBe("scripted"); // 本服务 startWebServer({model: "scripted"})
  });

  test("model 回落链（issue #11 修复）：请求体缺省 → 服务级 model（org web --model 不再失效）", async () => {
    // 独立第二服务（同工作区 · port 0 随机）：服务级 model = srv-level-flag。
    // 请求体不带 model → open/start 事件应回显服务级值（修复前：写死
    // "scripted"，org web --model deepseek 启动后 GUI 永远走 scripted）。
    const srv2 = startWebServer({ workspace: ws, port: 0, model: "srv-level-flag" });
    try {
      const r = await fetch(`http://127.0.0.1:${srv2.port}/api/ask-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expert: "poet", question: "校验服务级 model 回落", session: "web-model-fb" }),
      });
      expect(r.status).toBe(200);
      const events = parseSse(await r.text());
      const open = (events.get("open") as Array<{ model: string }>)[0]!;
      const start = (events.get("start") as Array<{ model: string }>)[0]!;
      expect(open.model).toBe("srv-level-flag");
      expect(start.model).toBe("srv-level-flag");
      // 未知模型名按 scripted 剧本轨道执行（不触发真实 LLM 调用）
      const done = (events.get("done") as Array<{ ok: boolean; answer: string }>)[0]!;
      expect(done.ok).toBe(true);
      expect(done.answer).toContain("占位剧本应答");
    } finally {
      srv2.stop(true);
    }
  });

  // ---- 会话管理（issue #12：DELETE 删除 / PATCH 重命名）----

  test("会话生命周期：ask 落账 → PATCH 重命名（mv 账本）→ 逐轮读取走新名 → DELETE 删除", async () => {
    // 造一个会话
    const ask = await fetch(base + "/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "poet", question: "会话管理链路验证", session: "web-mgmt" }),
    });
    expect(ask.status).toBe(200);
    expect(exists(path.join(ws, "runtime/sessions/poet/web-mgmt.jsonl"))).toBe(true);
    // PATCH 重命名：同专家内 mv 账本文件
    const ren = await fetch(base + "/api/session/poet/web-mgmt", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "web-mgmt-renamed" }),
    });
    expect(ren.status).toBe(200);
    const ro = (await ren.json()) as { ok: boolean; from: string; to: string };
    expect(ro.ok).toBe(true);
    expect(ro.to).toBe("web-mgmt-renamed");
    expect(exists(path.join(ws, "runtime/sessions/poet/web-mgmt.jsonl"))).toBe(false);
    expect(exists(path.join(ws, "runtime/sessions/poet/web-mgmt-renamed.jsonl"))).toBe(true);
    // 逐轮读取走新名（账本内容随文件搬走）
    const detail = (await (await fetch(base + "/api/session/poet/web-mgmt-renamed")).json()) as {
      turns: Array<{ question: string }>;
    };
    expect(detail.turns.length).toBe(1);
    expect(detail.turns[0]!.question).toContain("会话管理链路验证");
    // sessions 列表显示新名
    const ls = (await (await fetch(base + "/api/sessions?expert=poet")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(ls.sessions.map((s) => s.id)).toContain("web-mgmt-renamed");
    // DELETE 删除：删账本文件 = 删会话
    const del = await fetch(base + "/api/session/poet/web-mgmt-renamed", { method: "DELETE" });
    expect(del.status).toBe(200);
    const dobj = (await del.json()) as { ok: boolean; deleted: string };
    expect(dobj.ok).toBe(true);
    expect(exists(path.join(ws, "runtime/sessions/poet/web-mgmt-renamed.jsonl"))).toBe(false);
    // 再删 → 404（幂等防呆）
    const del2 = await fetch(base + "/api/session/poet/web-mgmt-renamed", { method: "DELETE" });
    expect(del2.status).toBe(404);
  });

  test("PATCH 防呆：坏 JSON/非法名/目标已存在 → 400/400/409", async () => {
    const bad = await fetch(base + "/api/session/poet/web-t1", {
      method: "PATCH",
      body: "not json",
    });
    expect(bad.status).toBe(400);
    const illegal = await fetch(base + "/api/session/poet/web-t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "../escape" }),
    });
    expect(illegal.status).toBe(400);
    const clash = await fetch(base + "/api/session/poet/web-t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "web-sse1" }), // 已存在的会话
    });
    expect(clash.status).toBe(409);
  });

  test("POST /api/abort（issue #12 停止生成）：空闲时 → ok:false 人话（不误杀）", async () => {
    const r = await fetch(base + "/api/abort", { method: "POST" });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { ok: boolean; aborted: boolean; message?: string };
    expect(out.ok).toBe(false);
    expect(out.aborted).toBe(false);
    expect(out.message).toContain("没有运行中的直连");
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

  test("parseWebArgv：--gateway 解析（org web --gateway http://127.0.0.1:3030/v1 → deepseek 车道网关路由）", () => {
    const p1 = parseWebArgv(["--gateway", "http://127.0.0.1:3030/v1"]);
    expect(p1.gateway).toBe("http://127.0.0.1:3030/v1");
    // 尾斜杠归一 + 短参 -g
    const p2 = parseWebArgv(["-g", "http://127.0.0.1:3030/v1//"]);
    expect(p2.gateway).toBe("http://127.0.0.1:3030/v1//"); // 解析层原样保留，webMain 归一
    // 缺省：不配置（$host.llm 直连 SDK）
    const p3 = parseWebArgv([]);
    expect(p3.gateway).toBe("");
    expect(p3.port).toBe(4600); // 默认端口（避开 3000/3030/5000）
  });

  test("未知端点 404（/api/* JSON 形态；其余纯文本）", async () => {
    const r = await fetch(base + "/api/unknown");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain("未知端点");
    const r2 = await fetch(base + "/no-such-page");
    expect(r2.status).toBe(404);
  });

  // ---- 工具库治理（v0.4.12：用户在 GUI 选取哪些 harness 保留到工具库）----

  test("POST /api/keep|drop：retained 翻转 + git 留痕 + /api/status 反映", async () => {
    // drop：notice-parser（模板自带 retained=true）→ 取消保留
    const d = await fetch(base + "/api/drop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "notice-parser" }),
    });
    expect(d.status).toBe(200);
    const dropBody = (await d.json()) as { ok: boolean; expert: string; retained: boolean };
    expect(dropBody.ok).toBe(true);
    expect(dropBody.retained).toBe(false);
    // 状态面与注册表数据面一致
    const s1 = (await (await fetch(base + "/api/status")).json()) as { experts: Array<{ name: string; retained: boolean }> };
    expect(s1.experts.find((e) => e.name === "notice-parser")!.retained).toBe(false);
    const idx1 = JSON.parse(fs.readFileSync(path.join(ws, "registry/index.json"), "utf-8")) as Array<{ name: string; retained: boolean }>;
    expect(idx1.find((e) => e.name === "notice-parser")!.retained).toBe(false);
    // keep：转正回保留
    const k = await fetch(base + "/api/keep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "notice-parser" }),
    });
    expect(k.status).toBe(200);
    const keepBody = (await k.json()) as { ok: boolean; retained: boolean };
    expect(keepBody.ok).toBe(true);
    expect(keepBody.retained).toBe(true);
    const idx2 = JSON.parse(fs.readFileSync(path.join(ws, "registry/index.json"), "utf-8")) as Array<{ name: string; retained: boolean }>;
    expect(idx2.find((e) => e.name === "notice-parser")!.retained).toBe(true);
    // git 留痕（user curation 提交 ×2）
    const git = Bun.spawnSync(["git", "log", "--oneline"], { cwd: ws, stdout: "pipe" });
    const logLines = git.stdout.toString().split("\n");
    const curation = logLines.filter((l) => l.includes("(user curation)"));
    expect(curation.length).toBeGreaterThanOrEqual(2);
  });

  test("keep/drop 防呆：非法名 400 · 不存在专家 404", async () => {
    const bad = await fetch(base + "/api/keep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "../escape" }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(base + "/api/keep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "no-such-expert" }),
    });
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { ok: boolean; error: string };
    expect(missingBody.ok).toBe(false);
  });

  test("GUI HTML：专家卡渲染 ★/○ 切换钮 + hintline 元素（v0.4.12 治理面）", async () => {
    const html = await (await fetch(base + "/")).text();
    // 切换钮渲染逻辑（renderExperts 的 data-retain + retainToggle/flashHint 函数）
    expect(html).toContain("data-retain=");
    expect(html).toContain("retainToggle");
    expect(html).toContain("flashHint");
    expect(html).toContain('id="hintline"');
    // 端点文档行（头部注释渲染进源码字符串）
    expect(html).toContain("/api/keep");
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

// ============================================================================
// renderMd：零依赖 Markdown 渲染器（issue #13 · 与 GUI 注入同一实现）
// 纪律：XSS 优先（全量转义后再还原受控标签）；未识别语法按原文降级。
// ============================================================================

describe("renderMd：Markdown 渲染器（服务端单测 = 浏览器同一实现）", () => {
  test("围栏代码块：语言标签 + copy 钮 + 内容转义", () => {
    const h = renderMd("```ts\nconst a = \"<b>\";\n```");
    expect(h).toContain('<div class="mdcode">');
    expect(h).toContain("<span>ts</span>");
    expect(h).toContain('class="mdcopy"');
    expect(h).toContain("const a = &quot;&lt;b&gt;&quot;");
    expect(h).not.toContain("<b>"); // 代码块内不还原标签
  });

  test("未闭合围栏（流式 EOF）：先渲染已到内容，不崩", () => {
    const h = renderMd("```js\nconsole.log(1)");
    expect(h).toContain("console.log(1)");
    expect(h).toContain("mdcode");
  });

  test("表格：thead/th + tbody/td + 行内码", () => {
    const h = renderMd("| 名称 | 值 |\n|---|---|\n| `ctx` | 131k |\n| 轮次 | 2 |");
    expect(h).toContain("<th>名称</th>");
    expect(h).toContain('<td><code class="icd">ctx</code></td>');
    expect(h).toContain("<td>131k</td>");
    expect(h).toContain("<td>2</td>");
  });

  test("列表：嵌套（缩进 2 空格）+ 有序 + 续行", () => {
    const h = renderMd("- 甲\n  - 甲子\n  续行\n- 乙\n\n1. 一\n2. 二");
    expect(h).toContain("<ul><li>甲<ul><li>甲子<br>续行</li></ul></li><li>乙</li></ul>");
    expect(h).toContain("<ol><li>一</li><li>二</li></ol>");
  });

  test("行内：粗体/斜体/行内码/链接（http(s) 限定）/裸 URL", () => {
    const h = renderMd("**粗** *斜* `码` [文](https://x.io) 见 https://y.io/a?b=1");
    expect(h).toContain("<b>粗</b>");
    expect(h).toContain("<i>斜</i>");
    expect(h).toContain('<code class="icd">码</code>');
    expect(h).toContain('<a href="https://x.io" target="_blank" rel="noopener noreferrer">文</a>');
    expect(h).toContain('<a href="https://y.io/a?b=1"');
  });

  test("XSS：script/onerror/javascript: 一律转义或拒绝", () => {
    const h = renderMd('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(h).toContain("&lt;script&gt;");     // 原文转义成纯文本展示
    expect(h).toContain("&lt;img src=x");      // 同上（含属性一并转义）
    expect(h).not.toMatch(/<img[^&]/);         // 不存在未转义的 img 标签
    expect(h).not.toMatch(/<script/);          // 不存在未转义的 script 标签
    expect(h).not.toContain('href="javascript'); // 链接仅 http(s)
  });

  test("块级：标题/引用/分割线/段落软换行", () => {
    const h = renderMd("## 标题\n\n> 引用一\n> 引用二\n\n---\n\n甲行\n乙行");
    expect(h).toContain("<h2>标题</h2>");
    expect(h).toContain("<blockquote>引用一<br>引用二</blockquote>");
    expect(h).toContain('<hr class="mdhr">');
    expect(h).toContain("<p>甲行<br>乙行</p>");
  });

  test("空输入与纯文本：空串 → 空输出；纯文本 → 单段落", () => {
    expect(renderMd("")).toBe("");
    expect(renderMd("你好")).toBe("<p>你好</p>");
  });
});
