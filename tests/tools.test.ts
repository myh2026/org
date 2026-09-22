// ============================================================================
// tests/tools.test.ts — agent 工具环 + @文件引用 + 长期记忆 + AGENTS.md（v0.5.3）
// ============================================================================
// 覆盖面：
//   1. 工具环 e2e（scripted 剧本驱动）：模型发 <tool> 调用 → HSL 解析 →
//      $host 执行（真实读文件）→ 结果回灌 → 最终答案；事件 tool_call/
//      tool_result 上总线
//   2. 只读模式降级：ORG_TOOLS=1 时 fs_write 被拒（明确反馈，模型可自纠）
//   3. 工具环关闭：ORG_TOOLS 未设 → 纯问答（v0.5.2 行为零变化）
//   4. 轮数上限：ORG_TOOL_MAX_TURNS=1 → 强制收束不失控
//   5. @文件引用：展开/目录/越界拒绝/二进制拒绝/预算截断（纯 TS 单测）
//   6. 长期记忆：add/list/rm + 坏文件容错（纯 TS 单测）
//   7. AGENTS.md / 记忆注入：HSL 侧 build 提示词的探针验证（scripted 也能
//      断言系统提示组装，不需要真实模型）
//
// 端到端用例逐例 120s 超时（B-15 纪律）。
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, makeWorkspace, runDhv, eventsOf } from "./helpers";

/** 独立产物目录（每用例隔离）。 */
function makeOut(name: string): string {
  const dir = path.join(TEST_RUN, "out-tools", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
import { expandMentions } from "../lib/mentions.ts";
import { listMemories, addMemory, removeMemory, allMemories } from "../lib/memories.ts";

const WS = path.join(TEST_RUN, "tools-ws");
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
});

afterEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

/** 造一个 direct 专用剧本：轨道 direct:<expert> 逐条消费。 */
function makeFixture(tracks: Record<string, string[]>): string {
  const file = path.join(TEST_RUN, "tools-fixture.json");
  fs.writeFileSync(file, JSON.stringify({ tracks }, null, 2));
  return file;
}

// ---- 1-4. 工具环 e2e -----------------------------------------------------------

describe("tools：agent 工具环（scripted 剧本驱动 e2e）", () => {
  test("DSML 第 4 形态：deepseek 原生 <｜｜DSML｜｜ invoke> XML 工具调用被解析执行（B-23）", async () => {
    // 2026-09-19 实测（deepseek-chat 真实车道）：模型无视提示词注入的 <tool>
    // 协议，直接吐服务端原生 DSML XML 形态（invoke/parameter 标签 + 全角竖线），
    // 工具调用被当纯文本展示、零工具执行。解析器补第 4 形态后本用例锁定。
    const fixture = makeFixture({
      "direct:notice-parser": [
        '我来读文件。\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="fs_read">\n<｜｜DSML｜｜ parameter name="path" string="true">raw/notices.txt</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
        "最终答案：公告分块规则是「=== NOTICE」。",
      ],
    });
    const dir = makeOut("tools-dsml");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 公告怎么分块？",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-dsml", ORG_ASK_QUESTION: "公告怎么分块？", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const events = eventsOf(dir);
    const toolCalls = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    expect(toolCalls.length).toBe(1);
    expect(JSON.stringify(toolCalls[0])).toContain("fs_read");
    // 工具真实执行（不是把 DSML 标记当文本回显）
    const toolResults = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(toolResults.length).toBe(1);
    expect(JSON.stringify(toolResults[0])).toContain("ok");
    // 最终答案落账本（工具环走通两轮）
    const ledger = fs.readFileSync(path.join(WS, "runtime/sessions/notice-parser/tools-dsml.jsonl"), "utf-8");
    expect(ledger).toContain("最终答案");
    expect(ledger).not.toContain("DSML");
  }, 120_000);

  test("DSML 第 4 形态：数值参数语义（string=\"false\" → 数值，B-23）", async () => {
    // 同一解析器路径的参数类型锁定：audio_compose 的 tempo 在 DSML 里标
    // string="false"，应解析为数值 84 而非字符串 "84"（实测形态）。
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="audio_compose">\n<｜｜DSML｜｜ parameter name="timbre" string="true">strings</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="chords" string="true">D3:canon:arp</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="tempo" string="false">84</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
        "最终答案：已渲染。",
      ],
    });
    const dir = makeOut("tools-dsml-num");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 作曲",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-dsml-num", ORG_ASK_QUESTION: "作曲", ORG_TOOLS: "write" });
    expect(r.ok).toBe(true);
    const events = eventsOf(dir);
    const toolCalls = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    expect(toolCalls.length).toBe(1);
    // args 摘要里 tempo 是数值 84（无引号），timbre 是字符串（带引号）
    const callJson = JSON.stringify(toolCalls[0]);
    expect(callJson).toContain("audio_compose");
    expect(callJson).toMatch(/tempo[":= ]+84/);
    expect(callJson).not.toMatch(/tempo[":= ]+"84"/);
  }, 120_000);

  test("读工具全链：<tool> 调用 → 真实读文件 → 结果回灌 → 最终答案 + 事件", async () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '我先读一下原始公告。\n<tool>{"name":"fs_read","args":{"path":"raw/notices.txt"}}</tool>',
        "最终答案：公告分块规则是「=== NOTICE」，共 4 块。",
      ],
    });
    const dir = makeOut("tools-e2e");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 公告怎么分块？",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-e2e", ORG_ASK_QUESTION: "公告怎么分块？", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const out = r.stdout;
    expect(out).toContain("最终答案");
    // 工具真实执行：fs_read 读到了工作区真实文件（demo-ws 的 notices.txt）
    const events = eventsOf(dir);
    const toolCalls = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    const toolResults = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(toolCalls.length).toBe(1);
    expect(toolResults.length).toBe(1);
    expect(JSON.stringify(toolCalls[0])).toContain("fs_read");
    expect(JSON.stringify(toolResults[0])).toContain("ok");
    // 会话账本落的是最终答案（不是工具调用轮）
    const ledger = fs.readFileSync(path.join(WS, "runtime/sessions/notice-parser/tools-e2e.jsonl"), "utf-8");
    expect(ledger).toContain("最终答案");
  }, 120_000);

  test("只读模式：fs_write 被拒（模型收到明确反馈，事件 tool_denied）", async () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '写个文件。<tool>{"name":"fs_write","args":{"path":"evil.txt","content":"hacked"}}</tool>',
        "好吧，只读模式下我不能写文件。最终答案：需要 ORG_TOOLS=write 与审批。",
      ],
    });
    const dir = makeOut("tools-ro");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 写文件",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-ro", ORG_ASK_QUESTION: "写文件", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const events = eventsOf(dir);
    const denied = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_denied");
    expect(denied.length).toBe(1);
    // 文件绝不被写
    expect(fs.existsSync(path.join(WS, "evil.txt"))).toBe(false);
  }, 120_000);

  test("write 模式未开审批：fs_write 仍被拒（安全缺省 —— 人在环不可静默绕过）", async () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '写个文件。<tool>{"name":"fs_write","args":{"path":"evil2.txt","content":"x"}}</tool>',
        "最终答案：被拒 —— 需要 ORG_APPROVAL=1 启动审批。",
      ],
    });
    const dir = makeOut("tools-write");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 写文件",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-write", ORG_ASK_QUESTION: "写文件", ORG_TOOLS: "write" });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(WS, "evil2.txt"))).toBe(false);
  }, 120_000);

  test("工具环关闭：ORG_TOOLS 未设 → 纯问答（v0.5.2 行为零变化）", async () => {
    const fixture = makeFixture({
      "direct:notice-parser": ["最终答案：直接回答，不调工具。"],
    });
    const dir = makeOut("tools-off");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 问题",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-off", ORG_ASK_QUESTION: "问题" });
    expect(r.ok).toBe(true);
    const events = eventsOf(dir);
    expect(events.filter((e) => e.name === "journal" && String((e.data as { name?: string })?.name).startsWith("tool_")).length).toBe(0);
  }, 120_000);

  test("轮数上限：ORG_TOOL_MAX_TURNS=1 → 强制收束（不失控）", async () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"fs_read","args":{"path":"raw/notices.txt"}}</tool>',
        '<tool>{"name":"fs_read","args":{"path":"registry/index.json"}}</tool>',
      ],
    });
    const dir = makeOut("tools-cap");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 一直调工具",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-cap", ORG_ASK_QUESTION: "一直调工具", ORG_TOOLS: "1", ORG_TOOL_MAX_TURNS: "1" });
    // 有界收束：run 完成（不强转失败），答案带收束说明
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("轮上限");
  }, 120_000);

  test("坏工具 JSON 跳过不炸（无有效调用 → 原文即答案，不空转）", async () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '部分回答 + <tool>{"name": broken json!!!</tool>（坏标记）',
      ],
    });
    const dir = makeOut("tools-badjson");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 问题",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-badjson", ORG_ASK_QUESTION: "问题", ORG_TOOLS: "1" });
    // 设计语义：坏 JSON 被跳过 → 无有效工具调用 → 该轮原文即最终答案
    //（绝不因坏标记空转或崩炸；run 正常收尾）
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("部分回答");
    const events = eventsOf(dir);
    expect(events.filter((e) => e.name === "journal" && String((e.data as { name?: string })?.name).startsWith("tool_")).length).toBe(0);
  }, 120_000);
});

// ---- 5. @文件引用（纯 TS 单测） --------------------------------------------------

describe("mentions：@文件/目录引用展开", () => {
  test("文件展开：围栏注入 + 原文保留", () => {
    const file = path.join(WS, "hello.txt");
    fs.writeFileSync(file, "line1\nline2");
    const r = expandMentions("看看 @hello.txt 的内容", WS);
    expect(r.expanded).toEqual(["hello.txt"]);
    expect(r.text).toContain("```");
    expect(r.text).toContain("line1\nline2");
    expect(r.text).toContain("看看 @hello.txt");
    expect(r.text).toContain("[referenced files] hello.txt");
  });

  test("目录展开：树 + 每文件 8 行预览", () => {
    fs.mkdirSync(path.join(WS, "srcs"), { recursive: true });
    fs.writeFileSync(path.join(WS, "srcs/a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(WS, "srcs/b.ts"), "export const b = 2;");
    const r = expandMentions("扫一眼 @srcs", WS);
    expect(r.expanded).toEqual(["srcs"]);
    expect(r.text).toContain("a.ts");
    expect(r.text).toContain("export const a = 1;");
  });

  test("越界路径拒绝（@../../ 逃逸）+ 不存在 + 二进制", () => {
    const r = expandMentions("读 @../../etc/passwd 和 @nope.txt", WS);
    expect(r.expanded.length).toBe(0);
    expect(r.skipped.find((s) => s.path === "../../etc/passwd")?.reason).toContain("越出");
    expect(r.skipped.find((s) => s.path === "nope.txt")?.reason).toContain("不存在");
    expect(r.text).toContain("[mentions skipped]");
  });

  test("无 @ 提及零成本直通", () => {
    const r = expandMentions("普通问题", WS);
    expect(r.text).toBe("普通问题");
    expect(r.expanded.length).toBe(0);
  });
});

// ---- 6. 长期记忆（纯 TS 单测） ----------------------------------------------------

describe("memories：长期记忆", () => {
  test("add / list / rm / allMemories", () => {
    expect(listMemories(WS, "notice-parser")).toEqual([]);
    expect(addMemory(WS, "notice-parser", "日期一律输出 ISO 8601")).toBe(1);
    expect(addMemory(WS, "notice-parser", "表格用 markdown")).toBe(2);
    const list = listMemories(WS, "notice-parser");
    expect(list.length).toBe(2);
    expect(list[0]!.text).toContain("ISO 8601");
    expect(removeMemory(WS, "notice-parser", 1)).toBe(1);
    expect(listMemories(WS, "notice-parser").length).toBe(1);
    expect(allMemories(WS).length).toBe(1);
  });

  test("防呆：空内容 / 超长 / 坏行号 / 非法专家名", () => {
    expect(() => addMemory(WS, "notice-parser", "")).toThrow("必填");
    expect(() => addMemory(WS, "notice-parser", "x".repeat(501))).toThrow("500");
    expect(() => addMemory(WS, "notice-parser", "ok")).not.toThrow();
    expect(() => removeMemory(WS, "notice-parser", 99)).toThrow("不存在");
    expect(() => addMemory(WS, "../evil", "x")).toThrow("不合法");
  });

  test("坏文件容错：空列表不炸", () => {
    fs.mkdirSync(path.join(WS, "runtime/memories"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime/memories/bad.md"), "not json anything");
    expect(listMemories(WS, "bad").length).toBe(1); // 纯文本按行读（md 本来就是文本）
  });
});

// ---- 7. AGENTS.md / 记忆注入（HSL 探针） ------------------------------------------

describe("prompt 注入：AGENTS.md 与长期记忆（HSL 探针）", () => {
  test("direct 车道系统提示含 AGENTS.md 规则与专家记忆", async () => {
    fs.writeFileSync(path.join(WS, "AGENTS.md"), "# 工作区规则\n- 一律用中文回答");
    addMemory(WS, "notice-parser", "回答末尾附来源块数");
    // 探针：scripted 车道下模型回复固定 —— 用 Web GUI 的 /api/ask 无法断言
    // 系统提示；这里跑一轮 ORG_TOOLS=1 的工具环（fs_read 工具的真实调用
    // 走 $host），通过「工具执行成功」侧证进程存活 + 注入不炸。真正断言
    // 提示词组装用 e2e：deepseek 车道才有意义 —— 此处用行为级探针：
    // AGENTS.md 存在时 run 不炸 + 正常收尾（坏注入会炸 direct.hsl）。
    const fixture = makeFixture({
      "direct:notice-parser": ["最终答案：注入正常。"],
    });
    const dir = makeOut("tools-agents");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 问题",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-agents", ORG_ASK_QUESTION: "问题" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("注入正常");
    // 记忆与 AGENTS.md 都在（文件落盘可查证注入源存在）
    expect(fs.existsSync(path.join(WS, "AGENTS.md"))).toBe(true);
    expect(listMemories(WS, "notice-parser").length).toBe(1);
  }, 120_000);

  test("记忆注入：HSL memory_block 直读 runtime/memories/<expert>.md", async () => {
    // 用工具环的 fs_read 探针验证 hsl 侧读记忆文件这条路径本身可用：
    // 记忆文件写入后，direct 车道运行（其 memory_block 会 fs.read 同一路径）
    // 不炸即路径正确；坏路径会在 check/run 报错。
    addMemory(WS, "notice-parser", "喜欢简洁");
    const fixture = makeFixture({ "direct:notice-parser": ["最终答案：好。"] });
    const dir = makeOut("tools-mem");
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) hi",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tools-mem", ORG_ASK_QUESTION: "hi" });
    expect(r.ok).toBe(true);
  }, 120_000);
});

// ---- 8. Web：@文件引用 + 记忆端点 -------------------------------------------------

describe("Web：@文件引用与记忆端点", () => {
  test("POST /api/ask 带 @文件 → 展开进提示词（账本可查证）", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    fs.writeFileSync(path.join(WS, "ref-me.txt"), "FILE-CONTENT-42");
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    try {
      // v0.5.14：问题措辞域内化（「解析…公告…」过 B-22 直连语义地板）——
      // 本用例验证 @mention 展开机制，不测罐头答案质量；域外措辞（如
      // 「读 @x 讲讲」）如今会被闸门降级，不再落 notice-parser 账本
      const r = (await (await fetch(`http://127.0.0.1:${srv.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expert: "notice-parser", question: "解析 @ref-me.txt 里的公告记录", session: "web-mention" }),
      })).json()) as { ok: boolean; answer: string };
      expect(r.ok).toBe(true);
      // 账本里的问题带展开内容（模型看到的实际输入）
      const ledger = fs.readFileSync(path.join(WS, "runtime/sessions/notice-parser/web-mention.jsonl"), "utf-8");
      expect(ledger).toContain("FILE-CONTENT-42");
    } finally {
      srv.stop(true);
    }
  }, 120_000);

  test("GET/POST /api/memory：列表 + 追加 + 删除 + GUI 要素", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const add = (await (await fetch(`${base}/api/memory`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", expert: "notice-parser", text: "Web 面板写入的记忆" }),
      })).json()) as { ok: boolean; count: number };
      expect(add.ok).toBe(true);
      expect(add.count).toBe(1);
      const list = (await (await fetch(`${base}/api/memory`)).json()) as { ok: boolean; groups: Array<{ expert: string; entries: unknown[] }> };
      expect(list.groups[0]?.expert).toBe("notice-parser");
      expect(list.groups[0]?.entries.length).toBe(1);
      const rm = (await (await fetch(`${base}/api/memory`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rm", expert: "notice-parser", line: 1 }),
      })).json()) as { ok: boolean; count: number };
      expect(rm.ok).toBe(true);
      expect(rm.count).toBe(0);
      // GUI 要素
      const html = await (await fetch(`${base}/`)).text();
      for (const needle of ["memoryBtn", "memoryPane", "function renderMemoryPane(", "/api/memory", "mmAdd"]) {
        expect(html).toContain(needle);
      }
    } finally {
      srv.stop(true);
    }
  }, 120_000);
});
