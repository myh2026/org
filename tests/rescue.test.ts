// ============================================================================
// tests/rescue.test.ts — scripted 车道域外任务语义地板 + 跨车道救援（v0.5.10）
// ----------------------------------------------------------------------------
// QA 实测（BUGFIXES B-19，agent-browser 驱动 Web GUI 团队模式发
// 「请创作一首古典风格的卡农」）：scripted 团队车道对域外任务零语义重合时，
// decompose 仍套用 STOCK 公告流水线跑完交差 —— run ok=true、交付公告表格，
// 答非所问比诚实降级更糟（用户以为成功了）。
//
// v0.5.10 预检三段式（CLI cmdRun / engine startRun 双入口同构）：
//  ① 域内（词面重合 ≥ 0.15 地板，或 ≥2 实义命中护持）→ 原 STOCK 行为零变化
//  ② 域外 + 注册表专家命中（manifest + direct: 轨道语料 ≥ 地板）→ 跨车道
//     救援转直连（同 run / ORG_TOOLS 默认 write / 事件流 lane_rescue 注入）
//  ③ 域外无命中 → 零消耗诚实降级（不跑流水线，标准产物直写 + 建议出口）
//
// 场景：
//   R1 单元：地板数值定标（域内放行 / 域外拦截 / 命中护持 / 超短放行）
//   R2 单元：救援评分（卡农→composer、写诗→bard、量子→null；direct 轨道加权）
//   R3 e2e reroute（CLI）：卡农 → 直连 composer → music.wav + .mid 交付
//   R4 e2e reroute（startRun）：事件流含 lane_rescue（Web/TUI 车道预检）
//   R5 e2e degrade（CLI）：量子任务 → 零消耗 + report/run.json 诚实
//   R6 域内零影响（CLI）：公告任务 → STOCK 原行为（3/3 收货，无 lane_rescue）
//   R7 显式 fixture 零影响：--fixture 显式传参跳过预检（用户意图优先）
//   R8 语义地板判据（v0.5.27 车道清欠）：生效车道 ≠ real + 未显式 fixture 才设闸
//      —— shouldApplySemanticFloor 共享函数四态定标（engine 与 cmdRun 同源）
// ============================================================================
import { TT } from "./tt.ts";
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspace, runOrg, ROOT, TEST_RUN } from "./helpers";
import {
  SEMANTIC_FLOOR,
  tokenOverlap,
  stockAffinityOf,
  rescueExpertOf,
  startRun,
  shouldApplySemanticFloor,
} from "../lib/engine.ts";
import { classifyRunEvent } from "../lib/runCards.ts";

const STOCK = path.join(ROOT, "fixtures/run-notices.json");

describe("v0.5.10 R1 语义地板数值定标", () => {
  test("域外任务被拦截（< 地板）", () => {
    expect(stockAffinityOf("请创作一首古典风格的卡农", STOCK)).toBeLessThan(SEMANTIC_FLOOR);
    expect(stockAffinityOf("写一首关于秋天的现代诗", STOCK)).toBeLessThan(SEMANTIC_FLOOR);
  });

  test("域内任务放行（≥ 地板 —— 含 bigram 碎片化的命中护持）", () => {
    // 「抓取近一周公告并输出表格」裸覆盖率 0.33；曾因字符串展开 bug 全灭
    expect(stockAffinityOf("抓取近一周公告并输出表格", STOCK)).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
    expect(stockAffinityOf("解析公告文件为结构化记录", STOCK)).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
    expect(stockAffinityOf("校验这些记录的完整性", STOCK)).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
  });

  test("超短任务保守放行（信息不足不拦，原行为）", () => {
    // 「hi」单 token 直接放行（=1）；「公告」2 token 走正常计算但命中即域内（≥ 地板）
    expect(stockAffinityOf("hi", STOCK)).toBe(1);
    expect(stockAffinityOf("公告", STOCK)).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
  });

  test("西文任务不被超短护栏误放（quantum 3 token 仍预检 → 拦）", () => {
    // 回归锚：阈值曾为 <4，「quantum braiding simulation」（3 token）被误放行
    expect(stockAffinityOf("quantum braiding simulation", STOCK)).toBeLessThan(SEMANTIC_FLOOR);
  });

  test("tokenOverlap：CJK bigram 命中语义（古典/作曲）", () => {
    expect(tokenOverlap("古典音乐作曲", "古典音乐作曲与音频渲染")).toBeGreaterThan(0.3);
    expect(tokenOverlap("量子纠缠", "古典音乐作曲")).toBe(0);
  });

  test("剧本不可读 → 放行（兜底不拦）", () => {
    expect(stockAffinityOf("请创作一首古典风格的卡农", path.join(TEST_RUN, "no-such-fixture.json"))).toBe(1);
  });
});

describe("v0.5.10 R2 救援专家评分", () => {
  test("卡农 → composer（direct: 轨道语料加权后胜出）", () => {
    const ws = makeWorkspace("rescue-pick-canon");
    const pick = rescueExpertOf("请创作一首古典风格的卡农", ws);
    expect(pick).not.toBeNull();
    expect(pick!.expert).toBe("composer");
    // direct:composer 轨道预录回复复述任务域词汇 —— 综合分显著高于 manifest 分
    expect(pick!.score).toBeGreaterThan(pick!.manifestScore);
    expect(pick!.score).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
  });

  test("写诗 → bard（STOCK 补 direct:bard 轨道后可救援）", () => {
    const ws = makeWorkspace("rescue-pick-poem");
    const pick = rescueExpertOf("写一首关于秋天的现代诗", ws);
    expect(pick).not.toBeNull();
    expect(pick!.expert).toBe("bard");
  });

  test("完全域外 → null（无专家可救援）", () => {
    const ws = makeWorkspace("rescue-pick-quantum");
    expect(rescueExpertOf("quantum braiding simulation", ws)).toBeNull();
  });

  // ---- B-26（v0.5.22）：长任务尺度三处回归 -----------------------------------
  // 实测踩坑（org task submit · model=deepseek）：「写诗+作曲+汇总」42 词元
  // 长任务被 STOCK 公告流水线答非所问（189s · model_calls=0 · 零作品）。
  // 三处修复的回归锚：stockAffinity 命中护持规模边界 + 救援地板 √(12/N) 自适应。

  test("B-26 长任务不再被 hit≥2 护持误抬（40+ 词元命中两个通用动词 → 域外）", () => {
    // 修复前：hit=2（保存/生成/汇总）触发 max 护持 → 0.05 被抬到 0.15 →
    // 恰好不小于地板 → 长驱直入 STOCK 流水线
    const t = "写一首关于量子计算的五言绝句并保存为 poem.md，然后用 audio_compose 创作一段 30 秒的量子主题 ambient 音乐，最后生成 summary.md 汇总两个作品";
    expect(stockAffinityOf(t, STOCK)).toBeLessThan(0.15);
  });

  test("B-26 长任务救援命中（地板 √(12/N) 自适应 → composer）", () => {
    // 修复前：bard direct 0.104 < 0.15 漏判 → 零消耗降级拒可服务任务
    const ws = makeWorkspace("rescue-b26-long");
    const pick = rescueExpertOf("写一首关于量子计算的五言绝句并保存为 poem.md，然后用 audio_compose 创作一段 30 秒的量子主题 ambient 音乐，最后生成 summary.md 汇总两个作品", ws);
    expect(pick).not.toBeNull();
    expect(["composer", "bard"]).toContain(pick!.expert);
    // 短任务地板不变（0.15 原行为 —— 12 词元内不缩放）
    expect(rescueExpertOf("quantum braiding simulation", ws)).toBeNull();
  });

  test("无 direct: 轨道的专家不可救援（防 FIXTURE_EXHAUSTED）", () => {
    const ws = makeWorkspace("rescue-pick-notrack");
    // 注册一个 description 高度相关但 fixture 无 direct: 轨道的专家
    const idx = path.join(ws, "registry/index.json");
    const reg = JSON.parse(fs.readFileSync(idx, "utf-8")) as Array<Record<string, unknown>>;
    const fx = path.join(TEST_RUN, "rescue-no-direct-track.json");
    fs.writeFileSync(fx, JSON.stringify({ tracks: { "handoff:weird": ["x"] } }));
    reg.push({ name: "weird", version: "1.0.0", source: "manual", fixture: path.relative(ws, fx), description: "量子 braiding 模拟 quantum braiding" });
    fs.writeFileSync(idx, JSON.stringify(reg));
    // manifest 分再高，没有 direct:weird 轨道 → 不可救援
    expect(rescueExpertOf("quantum braiding simulation", ws)).toBeNull();
  });
});

describe("v0.5.10 跨车道救援（e2e）", () => {
  test("R3 CLI reroute：卡农 → 直连 composer → music.wav + .mid 开袋即食", () => {
    const ws = makeWorkspace("rescue-e2e-canon");
    const out = path.join(ws, "out-r3");
    const r = runOrg([
      "run", "--task", "请创作一首古典风格的卡农",
      "--workspace", ws, "--out", out,
    ]);
    expect(r.ok).toBe(true);
    // 救援提示可观测（调度权可绕、知情权不可绕）
    expect(r.stdout).toContain("跨车道救援");
    expect(r.stdout).toContain("composer");
    // 音频产物真实交付（audio_compose 是 Full 即门类：无需审批开箱即用）
    const wav = path.join(out, "music.wav");
    expect(fs.existsSync(wav)).toBe(true);
    expect(fs.statSync(wav).size).toBeGreaterThan(100_000); // 真 WAV（非空壳）
    expect(fs.existsSync(path.join(out, "music.mid"))).toBe(true); // v0.5.9 MIDI 同行
    // 会话账本落盘（记账权不可绕）
    expect(fs.existsSync(path.join(ws, "runtime/sessions/composer/default.jsonl"))).toBe(true);
  }, TT);

  test("R4 startRun reroute：事件流注入 lane_rescue（Web/TUI 车道契约）", async () => {
    const ws = makeWorkspace("rescue-e2e-events");
    const handle = startRun({
      entry: "org", task: "请创作一首古典风格的卡农",
      workspace: ws, model: "scripted",
    });
    const evs: Array<Record<string, unknown>> = [];
    for await (const ev of handle.events) evs.push(ev as Record<string, unknown>);
    const res = await handle.wait();
    expect(res.ok).toBe(true);
    // lane_rescue 事件先于解释器事件（seq=0）且被 runCards 契约分类
    const rescueEv = evs.find((e) => e["kind"] === "unknown" && e["name"] === "lane_rescue");
    expect(rescueEv).toBeDefined();
    const fact = classifyRunEvent(rescueEv as never);
    expect(fact).toMatchObject({ t: "rescue", mode: "reroute", expert: "composer" });
    // v0.5.29：判定器观测事件 —— 本输入被如何判定（seq=0 先于一切解释器事件）
    const decEv = evs.find((e) => e["kind"] === "unknown" && e["name"] === "lane_decision");
    expect(decEv).toBeDefined();
    expect(decEv!["seq"]).toBe(0);
    const decFact = classifyRunEvent(decEv as never);
    expect(decFact).toMatchObject({ t: "laneDecision", mode: "expert", expert: "composer", laneKind: "scripted" });
    expect((decFact as { because: string }).because.length).toBeGreaterThan(0);
    // 救援轮次的回答进 directTurns（Web done 帧 / TUI 气泡的数据源）
    expect(res.directTurns).not.toBeNull();
    expect(res.directTurns!.length).toBeGreaterThanOrEqual(1);
    expect(res.directTurns![0]!.answer.length).toBeGreaterThan(0);
    // 音频收尾钩子在直连车道同样生效（B-18 契约）
    expect(res.audioRendered.length).toBeGreaterThanOrEqual(1);
    expect(res.audioRendered[0]!.wavFile).toBe("music.wav");
    // v0.5.31（B-35）：reroute 路径双留痕（lane_decision + lane_rescue 均落盘）
    const evFile4 = fs.readFileSync(path.join(res.outDir, "events.jsonl"), "utf-8");
    expect(evFile4).toContain("lane_decision");
    expect(evFile4).toContain("lane_rescue");
  }, TT);

  test("R5 CLI degrade：完全域外 → 零消耗 + 产物诚实（不套用域外剧本）", () => {
    const ws = makeWorkspace("rescue-e2e-quantum");
    const out = path.join(ws, "out-r5");
    const r = runOrg([
      "run", "--task", "quantum braiding simulation",
      "--workspace", ws, "--out", out,
    ]);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("零消耗降级");
    // 标准产物四件套（Web 回放 / org score 零适配消费）
    for (const f of ["journal.jsonl", "events.jsonl", "report.md", "run.json"]) {
      expect(fs.existsSync(path.join(out, f))).toBe(true);
    }
    const runJson = JSON.parse(fs.readFileSync(path.join(out, "run.json"), "utf-8"));
    expect(runJson["lane"]).toBe("degraded-out-of-domain");
    expect(runJson["ok"]).toBe(true);
    expect(Array.isArray(runJson["remedies"])).toBe(true);
    const report = fs.readFileSync(path.join(out, "report.md"), "utf-8");
    expect(report).toContain("语义地板");
    expect(report).toContain("建议出口");
    // 零消耗：没有子任务产物（metrics/scorecard 不存在 —— 流水线未启动）
    expect(fs.existsSync(path.join(out, "metrics.json"))).toBe(false);
  }, 60_000);

  test("R6 域内零影响：公告任务 → STOCK 原行为（3/3 收货，无救援）", () => {
    const ws = makeWorkspace("rescue-e2e-notices");
    const out = path.join(ws, "out-r6");
    const r = runOrg([
      "run", "--task", "抓取近一周公告并输出表格",
      "--workspace", ws, "--out", out,
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).not.toContain("跨车道救援");
    expect(r.stdout).toContain("accepted 3 / 3 subtasks");
    expect(fs.existsSync(path.join(out, "metrics.json"))).toBe(true); // 流水线真实跑了
  }, TT);

  test("R7 显式 fixture 零影响：--fixture 显式传参跳过预检（用户意图优先）", () => {
    const ws = makeWorkspace("rescue-e2e-explicit");
    const out = path.join(ws, "out-r7");
    // 显式传 STOCK fixture + 域外任务 → 不预检，原 STOCK 行为（v0.5.7 降级链
    // 的测试领地 T3 依赖此语义：直接驱动 org.hsl 的用例不经桥层）
    const r = runOrg([
      "run", "--task", "请创作一首古典风格的卡农",
      "--workspace", ws, "--fixture", STOCK, "--out", out,
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).not.toContain("跨车道救援");
    // 走了团队流水线（STOCK decompose 的任务树可见）
    expect(r.stdout).toContain("task#1 fetch");
  }, TT);
});

describe("v0.5.27 R8 语义地板判据（生效车道：闸门只做 scripted 的兜底）", () => {
  test("scripted 车道 + 未显式 fixture → 设闸（B-19 原语义）", () => {
    expect(shouldApplySemanticFloor({ entry: "org", fixtureExplicit: false, laneKind: "scripted" })).toBe(true);
  });
  test("真实车道 → 不前置否决（域感知是模型的活）", () => {
    expect(shouldApplySemanticFloor({ entry: "org", fixtureExplicit: false, laneKind: "real" })).toBe(false);
  });
  test("显式 fixture → 不设闸（用户意图优先）", () => {
    expect(shouldApplySemanticFloor({ entry: "org", fixtureExplicit: true, laneKind: "scripted" })).toBe(false);
  });
  test("直连 entry → 不设闸（团队车道专属预检）", () => {
    expect(shouldApplySemanticFloor({ entry: "direct", fixtureExplicit: false, laneKind: "scripted" })).toBe(false);
  });
});

describe("v0.5.29 判定器观测：lane_decision 三态（startRun 事件流）", () => {
  test("R9 域内任务 → lane_decision=team（直入团队 + signals 齐）", async () => {
    const ws = makeWorkspace("rescue-dec-team");
    const handle = startRun({
      entry: "org", task: "抓取近一周公告并输出表格",
      workspace: ws, model: "scripted",
    });
    const evs: Array<Record<string, unknown>> = [];
    for await (const ev of handle.events) evs.push(ev as Record<string, unknown>);
    const res = await handle.wait();
    expect(res.ok).toBe(true);
    const decEv = evs.find((e) => e["kind"] === "unknown" && e["name"] === "lane_decision");
    expect(decEv).toBeDefined();
    const decFact = classifyRunEvent(decEv as never);
    expect(decFact).toMatchObject({ t: "laneDecision", mode: "team", laneKind: "scripted" });
    expect((decFact as { stockScore: number }).stockScore).toBeGreaterThanOrEqual(0);
    // v0.5.31（B-35）：落盘留痕 —— 回放面（/api/run 读 events.jsonl）同样可见
    const evFile = fs.readFileSync(path.join(res.outDir, "events.jsonl"), "utf-8");
    expect(evFile).toContain("lane_decision");
  }, TT);

  test("R10 域外无救援 → lane_decision=degrade（零消耗 + 事件齐）", async () => {
    const ws = makeWorkspace("rescue-dec-degrade");
    const handle = startRun({
      entry: "org", task: "quantum braiding simulation",
      workspace: ws, model: "scripted",
    });
    const evs: Array<Record<string, unknown>> = [];
    for await (const ev of handle.events) evs.push(ev as Record<string, unknown>);
    const res = await handle.wait();
    expect(res.ok).toBe(true);
    const decEv = evs.find((e) => e["kind"] === "unknown" && e["name"] === "lane_decision");
    expect(decEv).toBeDefined();
    const decFact = classifyRunEvent(decEv as never);
    expect(decFact).toMatchObject({ t: "laneDecision", mode: "degrade" });
    expect((decFact as { because: string }).because).toContain("零消耗");
    // v0.5.31（B-35）：降级手写路径 + 收尾补写 → 文件同样可见
    const evFile = fs.readFileSync(path.join(res.outDir, "events.jsonl"), "utf-8");
    expect(evFile).toContain("lane_decision");
  }, TT);
});
