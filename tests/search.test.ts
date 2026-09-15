// ============================================================================
// tests/search.test.ts — 语义检索 / RAG 注入（v0.5.8 · capabilities #19/#22）
// ----------------------------------------------------------------------------
// 四入口全覆盖 + 行为对拍（「一源多投射」治理手法的检索版）：
//   1. 引擎单测：分词（CJK bigram / 西文 / 混合）· BM25 相关性排序 · 降级
//   2. RAG 注入：@?查询词 → expandMentions 织入检索命中（+ 无命中降级）
//   3. CLI：org search 输出命中与引导行
//   4. Web：GET /api/search JSON 契约 + k 参数
//   5. 工具环：semantic_search（ReadOnly 模式 e2e）—— HSL 侧 ABI 内实现
//      与 lib/search.ts 的 top-1 命中对拍（排序等价的实证）
// ============================================================================
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, makeWorkspace, runDhv, runOrg, eventsOf } from "./helpers";
import { tokenize, buildIndex, searchIndex, semanticSearch } from "../lib/search.ts";
import { expandMentions } from "../lib/mentions.ts";
import { startWebServer } from "../web/entry.ts";

const WS = path.join(TEST_RUN, "search-ws");
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

/** 构造检索语料床：3 份相关度分明的文档 + 1 份无关文档。 */
function seedCorpus(ws: string): void {
  fs.mkdirSync(path.join(ws, "raw"), { recursive: true });
  fs.writeFileSync(path.join(ws, "raw", "audit.txt"),
    "关于修订公司内部审计制度的公告\n审计部 2024年3月14日\n为进一步规范内部审计工作，现对《内部审计制度》进行修订。\n审计委员会审议通过，自发布之日起施行。\n");
  fs.writeFileSync(path.join(ws, "raw", "meeting.txt"),
    "关于召开2024年第一季度业绩说明会的公告\n董事会办公室 2024-03-10\n会议将披露第一季度业绩并与投资者交流。\n");
  fs.writeFileSync(path.join(ws, "raw", "audit-plan.txt"),
    "2024年度审计工作计划\n审计范围：财务审计、内控审计、专项审计。\n");
  fs.writeFileSync(path.join(ws, "raw", "unrelated.txt"),
    "食堂菜单公示\n周一：红烧肉、青菜豆腐汤。\n");
}

beforeEach(() => {
  // makeWorkspace：模板带 registry（direct 车道要求专家在岗）+ git 资产层；
  // seedCorpus 在模板之上叠加语料（raw/notices.txt 共存 —— 对拍断言用动态值）
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
});

afterEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

// ---- 1. 引擎单测 ------------------------------------------------------------

describe("检索引擎：分词（CJK bigram + 西文词元）", () => {
  test("CJK bigram：连续汉字段滑窗 + 尾字保留", () => {
    const t = tokenize("审计制度");
    expect(t).toContain("审计");
    expect(t).toContain("计制");
    expect(t).toContain("制度");
    expect(t).toContain("度"); // 尾字单字
  });

  test("西文：小写词元（含数字）", () => {
    expect(tokenize("Date Format ISO 8601")).toEqual(["date", "format", "iso", "8601"]);
  });

  test("中英混合：两段各自处理", () => {
    const t = tokenize("date 格式规范");
    expect(t).toContain("date");
    expect(t).toContain("格式");
    expect(t).toContain("规范");
  });
});

describe("检索引擎：BM25 相关性排序与降级", () => {
  test("相关文档排前（审计 制度 → audit.txt 首位；无关文档不命中）", () => {
    seedCorpus(WS);
    const sr = semanticSearch(WS, "审计 制度", 5);
    expect(sr.ok).toBe(true);
    expect(sr.hits.length).toBeGreaterThanOrEqual(2);
    expect(sr.hits[0]!.path).toBe("raw/audit.txt");
    expect(sr.hits.find((h) => h.path === "raw/unrelated.txt")).toBeUndefined();
    // 摘要含命中词上下文
    expect(sr.hits[0]!.snippet.length).toBeGreaterThan(0);
    expect(sr.hits[0]!.terms.length).toBeGreaterThanOrEqual(2);
  });

  test("英文查询命中英文文档（BM25 跨语料）", () => {
    seedCorpus(WS);
    fs.writeFileSync(path.join(WS, "raw", "readme.txt"),
      "Quarterly earnings report Q1 2024. The board will present results.\n");
    const sr = semanticSearch(WS, "quarterly earnings", 5);
    expect(sr.hits[0]!.path).toBe("raw/readme.txt");
  });

  test("空查询 / 空工作区 → 空 hits（不炸）", () => {
    const sr1 = semanticSearch(WS, "", 5);
    expect(sr1.hits).toEqual([]);
    const sr2 = semanticSearch(path.join(TEST_RUN, "no-such-ws"), "审计", 5);
    expect(sr2.ok).toBe(true);
    expect(sr2.hits).toEqual([]);
    expect(sr2.total_docs).toBe(0);
  });

  test("二进制文件跳过（NUL 嗅探）且单文件坏不连坐", () => {
    seedCorpus(WS);
    fs.writeFileSync(path.join(WS, "raw", "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const idx = buildIndex(WS);
    expect(idx.stats.skippedBinary).toBe(1);
    const sr = searchIndex(idx, "审计", 5);
    expect(sr.hits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- 2. RAG 注入 -------------------------------------------------------------

describe("RAG 注入：@?查询词（expandMentions 织入检索命中）", () => {
  test("命中织入：块头 + 路径 + 摘要 + 原文保留 @?token", () => {
    seedCorpus(WS);
    const r = expandMentions("总结一下 @?审计制度 的要求", WS);
    expect(r.expanded).toContain("?审计制度");
    expect(r.text).toContain("语义检索 top");
    expect(r.text).toContain("raw/audit.txt");
    expect(r.text).toContain("@?审计制度"); // 原文保留（模型对齐）
    expect(r.text).toContain("总结一下"); // 原问题在前
  });

  test("无命中降级：附注说明不炸（空工作区）", () => {
    const emptyWs = path.join(TEST_RUN, "search-empty-ws");
    fs.rmSync(emptyWs, { recursive: true, force: true });
    fs.mkdirSync(emptyWs, { recursive: true });
    const r = expandMentions("看看 @?不存在的东西", emptyWs);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.reason).toContain("检索无命中");
    expect(r.text).toContain("@?不存在的东西");
  });
});

// ---- 3. CLI -------------------------------------------------------------------

describe("CLI：org search", () => {
  test("命中输出 + 引导行（@引用 / @? RAG）", () => {
    seedCorpus(WS);
    const r = runOrg(["search", "审计 制度", "--k", "3", "--workspace", WS]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("raw/audit.txt");
    expect(r.stdout).toContain("🔍");
    expect(r.stdout).toContain("RAG 注入");
  });

  test("空查询 → 用法提示（exit 2）", () => {
    const r = runOrg(["search", "", "--workspace", WS]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("用法");
  });
});

// ---- 4. Web API ---------------------------------------------------------------

describe("Web：GET /api/search", () => {
  test("JSON 契约（hits/total_docs/took_ms/stats）+ k 参数生效", async () => {
    seedCorpus(WS);
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const r = await fetch(`${base}/api/search?q=${encodeURIComponent("审计 制度")}&k=2`);
      expect(r.status).toBe(200);
      const body = await r.json() as {
        ok: boolean; hits: Array<{ path: string; score: number; snippet: string }>;
        total_docs: number; took_ms: number;
      };
      expect(body.ok).toBe(true);
      expect(body.hits.length).toBeLessThanOrEqual(2); // k 生效
      expect(body.hits[0]!.path).toBe("raw/audit.txt");
      expect(body.total_docs).toBeGreaterThanOrEqual(4); // 模板语料 + 4 份新文档
      expect(typeof body.took_ms).toBe("number");
      // 缺 q → 400
      const bad = await fetch(`${base}/api/search`);
      expect(bad.status).toBe(400);
    } finally {
      srv.stop(true);
    }
  });
});

// ---- 5. 工具环 + 行为对拍 ------------------------------------------------------

describe("工具环：semantic_search（ReadOnly 模式 e2e + 行为对拍）", () => {
  test("<tool> 调用 → ABI 内 BM25 → 结果回灌 + 事件留痕 + 与 lib 版 top-1 对拍一致", async () => {
    seedCorpus(WS);
    const fixture = path.join(TEST_RUN, "search-fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '我检索一下相关材料。\n<tool>{"name":"semantic_search","args":{"query":"审计 制度","k":3}}</tool>',
        "最终答案：找到了《内部审计制度》修订公告（raw/audit.txt）。",
      ],
    } }));
    const dir = path.join(TEST_RUN, "out-search", "tool-e2e");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 检索审计制度",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", dir,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "search-e2e", ORG_ASK_QUESTION: "检索审计制度", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);

    // 工具真实执行：事件留痕 tool_call / tool_result（观测摘要含 top-1 路径）
    const events = eventsOf(dir);
    const toolCalls = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    expect(toolCalls.length).toBe(1);
    expect(JSON.stringify(toolCalls[0])).toContain("semantic_search");
    const toolResults = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(toolResults.length).toBe(1);
    const summary = JSON.stringify(toolResults[0]);

    // ---- 行为对拍（「一源多投射」的检索实证）：----
    // lib 版（lib/search.ts）与工具环版（$host ABI 内同构实现）在同一
    // 工作区、同一查询下 top-1 命中必须一致 —— 排序等价钉进 CI。
    const lib = semanticSearch(WS, "审计 制度", 3);
    expect(lib.hits[0]!.path).toBe("raw/audit.txt");
    expect(summary).toContain(`top=${lib.hits[0]!.path}`);
    // 文档数对拍（语料面一致：模板语料 + 4 份新文档全部入索引）
    expect(summary).toContain(`docs=${lib.total_docs}`);
    expect(lib.total_docs).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
