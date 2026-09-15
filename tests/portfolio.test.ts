// ============================================================================
// tests/portfolio.test.ts — 作品集：10 个项目矩阵（v0.5.6）
// ============================================================================
// 用户验收口径：「拿这个东西做一些测试……再想其他的 10 个项目进行测试」。
// 10 个项目 × 三条执行车道（A 内联 / B 复用静态专家 / B 复用导入 harness），
// 全部 scripted 剧本驱动（CI 零外联可复现）；真实车道（DeepSeek deepseek-flash
// 实测：写诗 + 古典音乐 WAV）见 issue 留痕，不入 CI（成本与不确定性）。
//
//   #1 公告结构化        B:reuse notice-parser（解析记录 JSON 交付）
//   #2 古典音乐创作      B:reuse composer（music.notes.json + music.wav）
//   #3 十四行诗创作      B:reuse bard（poem.md 工件）
//   #4 变更日志解析      B:reuse changelog-parser（org import 导入 → 嵌套解释器车道）
//   #5 会议纪要摘要      A:inline
//   #6 周报草拟          A:inline
//   #7 风险清单梳理      A:inline
//   #8 术语表提取        A:inline
//   #9 数据字典核对      A:inline
//   #10 发布说明撰写     A:inline
// ============================================================================

import { describe, test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, ROOT, runOrg, eventsOf } from "./helpers";
import { wavInfo } from "../lib/audio.ts";

const WS = path.join(TEST_RUN, "portfolio-ws");

/** 内联任务的通用剧本（单子任务 + 澄清 + 验收）。 */
function inlineFixture(role: string, goal: string, clarifyQ: string, clarifyA: string): string {
  const file = path.join(TEST_RUN, `portfolio-inline-${role}.json`);
  const doc = {
    acts: [], reviews: [],
    tracks: {
      decompose: [JSON.stringify([
        { id: 1, goal, role, skills: [], depends_on: [], priority: 1, input: "mission" },
      ])],
      clarify: [JSON.stringify([clarifyQ])],
      answers: [JSON.stringify([clarifyA])],
      [`review:${role}`]: [JSON.stringify({ verdict: "accept" })],
    },
  };
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** 跑一次使命并断言骨架（run ok + 验收 + 路由 + report.md）。 */
function runProject(name: string, task: string, fixture: string, outName: string, ws = WS): { ok: boolean; stdout: string; outDir: string } {
  const out = path.join(ws, outName); // 绝对路径（相对会被 CLI 解析到 CWD）
  const r = runOrg(["run", "--task", task, "--workspace", ws, "--fixture", fixture, "--out", out]);
  return { ok: r.ok, stdout: r.stdout, outDir: out };
}

beforeAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true });
});

describe("portfolio：10 个项目矩阵（scripted · 三条车道）", () => {
  test("#1 公告结构化 → B:reuse notice-parser（解析记录交付）", () => {
    const r = runProject("p1", "抓取某站点近一周公告，输出结构化表格",
      path.join(ROOT, "fixtures/run-notices.json"), "out-p1");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("accepted 3 / 3 subtasks");
    expect(r.stdout).toContain("task#2 parse");
    // 解析记录真实交付（公告标题出现在交付物里）
    expect(r.stdout).toContain("关于修订公司内部审计制度的公告");
    expect(fs.existsSync(path.join(r.outDir, "report.md"))).toBe(true);
  }, 120_000);

  test("#2 古典音乐创作 → B:reuse composer（音频产物开袋即食）", () => {
    const r = runProject("p2", "为读书会创作一段约 30 秒的古典背景音乐（卡农风格）",
      path.join(ROOT, "fixtures/run-music.json"), "out-p2");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("task#2 compose");
    expect(r.stdout).toContain("♪ 音频产物已渲染：music.wav");
    const info = wavInfo(fs.readFileSync(path.join(r.outDir, "music.wav")));
    expect(info).not.toBeNull();
    expect(info!.durationSec).toBeGreaterThan(28);
  }, 120_000);

  test("#3 十四行诗创作 → B:reuse bard（poem.md 工件）", () => {
    const r = runProject("p3", "为毕业论文写一首十四行诗，主题是多智能体协作如卡农",
      path.join(ROOT, "fixtures/run-poetry.json"), "out-p3");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("task#2 poetry");
    expect(r.stdout).toContain("poem.md（");
    const poem = fs.readFileSync(path.join(r.outDir, "poem.md"), "utf-8");
    expect(poem).toContain("《代码与卡农》");
    expect(poem.split("\n").length).toBeGreaterThanOrEqual(10);
  }, 120_000);

  test("#4 变更日志解析 → B:reuse 导入 harness changelog-parser（嵌套解释器车道）", () => {
    // 导入 Conventional Commits 解析 harness（org import · 登记即可派单）
    const src = path.join(ROOT, "projects/changelog/changelog-parser.hsl");
    const imp = runOrg(["import", src, "--workspace", WS, "--name", "changelog-parser"]);
    expect(imp.ok).toBe(true);
    // 原料：提交对象 JSON 数组（harness 的 payload 契约：[{hash,author,message}]；
    // 写进工作区原料位 = prepare_payload 的读取约定）
    fs.writeFileSync(path.join(WS, "raw/notices.txt"), JSON.stringify([
      { hash: "a1b2c3", author: "张三", message: "feat(parser): 新增范围解析" },
      { hash: "d4e5f6", author: "李四", message: "fix(router): 修复空指针!" },
      { hash: "g7h8i9", author: "王五", message: "docs: 补充 README" },
      { hash: "j0k1l2", author: "张三", message: "refactor(core): 拆分主循环" },
      { hash: "m3n4o5", author: "李四", message: "feat!: 破坏性 API 变更" },
      { hash: "p6q7r8", author: "王五", message: "chore: 升级依赖" },
    ]));
    const fixture = path.join(TEST_RUN, "portfolio-changelog.json");
    const doc = {
      acts: [], reviews: [],
      tracks: {
        decompose: [JSON.stringify([
          { id: 1, goal: "读取提交历史原料", role: "fetch", skills: [], depends_on: [], priority: 1, input: "mission" },
          { id: 2, goal: "Conventional Commits 解析与版本推断（产出变更日志）", role: "changelog", skills: ["versioning"], depends_on: [1], priority: 2, input: "raw" },
        ])],
        clarify: [JSON.stringify(["版本基线从 0.5.5 起推断？"])],
        answers: [JSON.stringify(["是，从 0.5.5 起按 Conventional Commits 推断"])],
        "review:fetch": [JSON.stringify({ verdict: "accept" })],
        "review:changelog": [JSON.stringify({ verdict: "accept" })],
      },
    };
    fs.writeFileSync(fixture, JSON.stringify(doc));
    const r = runProject("p4", "解析提交历史并产出变更日志与下一版本推断",
      fixture, "out-p4");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("task#2 changelog");
    // 路由证据（B:reuse 走事件总线）
    const events4 = eventsOf(r.outDir);
    const reused = events4.filter((e) => String((e.data as { detail?: string })?.detail ?? "").includes("-> B:reuse"));
    expect(reused.length).toBe(1);
    // 导入 harness 经嵌套解释器真实执行：changelog 工件落盘 work-out
    const md = fs.readFileSync(path.join(WS, "work-out/changelog.md"), "utf-8");
    expect(md).toContain("Features");
    expect(md).toContain("BREAKING");
    const stats = JSON.parse(fs.readFileSync(path.join(WS, "work-out/changelog-stats.json"), "utf-8")) as Record<string, number>;
    expect(stats["feat"]).toBeGreaterThanOrEqual(2);
    expect(stats["breaking"]).toBeGreaterThanOrEqual(1);
    // 恢复 notices 原料（后续内联项目共享工作区）
    fs.copyFileSync(path.join(ROOT, "demo-ws/raw/notices.txt"), path.join(WS, "raw/notices.txt"));
  }, 120_000);

  // ---- #5-#10 内联车道（六类文书使命：监督回路 + 审查 + 报告骨架） ----------

  const inlineProjects: Array<{ n: string; role: string; goal: string; q: string; a: string }> = [
    { n: "#5", role: "summarize", goal: "把本周三场会议的要点汇总成一页纪要", q: "纪要按会议分节还是按主题分节？", a: "按主题分节，突出决议与待办" },
    { n: "#6", role: "draft", goal: "起草本周工程周报（进展/风险/下周计划三段）", q: "周报读者是管理层还是同组工程师？", a: "管理层，突出里程碑与风险" },
    { n: "#7", role: "risk", goal: "梳理本季度交付的风险清单并给出缓解建议", q: "风险按影响还是按概率排序？", a: "按影响×概率综合排序" },
    { n: "#8", role: "glossary", goal: "从需求文档提取术语表并逐条给出定义", q: "术语表需要中英对照吗？", a: "需要，中文为主英文括注" },
    { n: "#9", role: "audit", goal: "核对数据字典与实际表结构的一致性并出具差异报告", q: "差异按严重度分级吗？", a: "分三级：阻断/警告/提示" },
    { n: "#10", role: "release", goal: "为本版本撰写面向用户的发布说明（亮点+升级指引）", q: "发布说明面向技术用户还是普通用户？", a: "普通用户，避免术语" },
  ];

  for (const p of inlineProjects) {
    test(`${p.n} ${p.goal.slice(0, 18)}… → A:inline（监督回路 + 审查 + 报告）`, () => {
      const fixture = inlineFixture(p.role, p.goal, p.q, p.a);
      const out = `out-${p.role}`;
      const r = runProject(p.n, p.goal, fixture, out);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("accepted 1 / 1 subtasks");
      expect(fs.existsSync(path.join(r.outDir, "report.md"))).toBe(true);
      // 路由证据（A:inline 走事件总线，不在 stdout）
      const events = eventsOf(r.outDir);
      const routed = events.filter((e) => String((e.data as { detail?: string })?.detail ?? "").includes("-> A:inline"));
      expect(routed.length).toBe(1);
      // 澄清早发被消费（批量澄清与执行重叠的机制证据）
      const clarify = events.filter((e) => String((e.data as { detail?: string })?.detail ?? "").includes(p.q.slice(0, 8)));
      expect(clarify.length).toBeGreaterThanOrEqual(1);
    }, 120_000);
  }
});
