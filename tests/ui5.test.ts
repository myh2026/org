// ============================================================================
// tests/ui5.test.ts — UI v5 骨架冒烟（S1）
//   守护 renderV5Page() 的模板完整性：关键锚点 + 核心函数在位 + 体量下限。
//   历史背景：模板转义事故（\\` 截断）曾致页面脚本残缺 —— 本测试即防复发锁。
// ============================================================================
import { describe, test, expect } from "bun:test";
import { renderV5Page } from "../web/ui5/ui.ts";

describe("UI v5 骨架冒烟（ORG_WEB_UI=v5 轨）", () => {
  const page = renderV5Page();

  test("页面组装：DOM 锚点齐备（rail/侧栏/composer/状态栏/审批条）", () => {
    const anchors = [
      'id="app"', 'id="rail"', "rbChat", "rbRuns", "rbTasks", "rbAbout",
      "newAsk", "lstExp", "lstSes", "lstRuns", "lstTasks",
      "chipMode", "chipLane", "chipAppr", "inp", 'id="send"', 'id="stop"',
      "sbCtx", "sbTok", "sbLane", "sbState", 'id="appr"', "streamCol",
    ];
    const miss = anchors.filter((k) => !page.includes(k));
    if (miss.length) console.error("缺失锚点:", miss.join(", "));
    expect(miss.length).toBe(0);
  });

  test("脚本完整：SSE 引擎 + 事实字典 + 流程函数在位", () => {
    const fns = [
      "function ssePost", "function factLine", "function taskSeg", "function appendFact",
      "function startTeam", "function startDirect", "function renderEmpty",
      "function renderSessions", "function renameSession", "function deleteSession",
      "function refreshApprovals", "function renderSb", "function replayRun",
    ];
    const miss = fns.filter((k) => !page.includes(k));
    if (miss.length) console.error("缺失函数:", miss.join(", "));
    expect(miss.length).toBe(0);
  });

  test("模板体量 sanity（曾蒸发/截断事故 → 下限防御）", () => {
    expect(page.length).toBeGreaterThan(36000);
    expect(page.includes("org · console")).toBe(true);
    expect(page.trim().endsWith("</html>")).toBe(true);
  });
});
