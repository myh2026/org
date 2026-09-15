// ============================================================================
// tests/directgate.test.ts — 直连车道语义地板 + 救援（v0.5.14 · BUGFIXES B-22）
// ----------------------------------------------------------------------------
// QA 实测（agent-browser 驱动 Web GUI 直连模式）：GUI 缺省专家 notice-parser
// + scripted 模型，问「你好」/「请创作卡农」得到的是公告域罐头答案（字段
// 映射规则 memo）—— B-19 的直连车道变体：v0.5.10 只修了团队车道，直连
// ask（Web askOnce/askStreamOnce + CLI cmdAsk）对域外问题照样答非所问。
//
// v0.5.14 预检三岔口（directAskGateOf，与团队车道同哲学）：
//  ① passthrough —— 选中专家域内（direct: 轨道语料或 manifest 词面 ≥ 地板）
//  ② reroute     —— 域外但注册表有域内专家 → 换专家 + 换剧本 + 事件留痕
//  ③ degrade     —— 域外且无可救援 → 零消耗诚实降级（不跑模型不落账本）
//  附带修复：选中专家无 direct:<name> 轨道时（旧路径 FIXTURE_EXHAUSTED 硬
//  失败）也走 ②/③ —— 硬失败变三岔口。
//
// 场景：
//   D1 单元：三岔口定标（域内放行 / 域外救援 / 完全域外降级 / 真实车道旁路 /
//            无轨道专家不硬失败）
//   D2 e2e CLI reroute：ask notice-parser 卡农 → composer 应答 + WAV + 留痕
//   D3 e2e CLI degrade：ask notice-parser 量子 → 零消耗 + 产物诚实
//   D4 e2e Web reroute（SSE）：done 帧带 rescue 元数据 + 音频 + lane_rescue
//   D5 e2e Web degrade（SSE）：done 帧带 degraded + 零账本
//   D6 域内零影响（CLI）：公告问题 → 原罐头答案（无救援行）
//   D7 GUI 要素：rsc-badge 徽标样式 + finalize 救援渲染（内联脚本自洽）
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspace, runOrg, ROOT, TEST_RUN } from "./helpers";
import {
  SEMANTIC_FLOOR,
  directAskGateOf,
  directDegradeAnswer,
} from "../lib/engine.ts";
import { startWebServer } from "../web/entry.ts";

const STOCK = path.join(ROOT, "fixtures/run-notices.json");

describe("v0.5.14 D1 直连闸门三岔口（单元）", () => {
  test("域内问题放行：notice-parser × 公告任务 → passthrough", () => {
    const ws = makeWorkspace("dgate-unit-in");
    const g = directAskGateOf(ws, "notice-parser", "解析公告文件为结构化记录", true);
    expect(g.kind).toBe("passthrough");
    expect(g.hasTrack).toBe(true);
    expect(g.selfScore!).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
  });

  test("域外问题救援：notice-parser × 卡农 → reroute composer", () => {
    const ws = makeWorkspace("dgate-unit-canon");
    const g = directAskGateOf(ws, "notice-parser", "请创作一首古典风格的卡农", true);
    expect(g.kind).toBe("reroute");
    expect(g.expert).toBe("composer");
    expect(g.fixture).toBe(STOCK); // composer 无自有剧本 → STOCK 的 direct:composer 轨道
    expect(g.score!).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
    expect(g.selfScore!).toBeLessThan(SEMANTIC_FLOOR);
  });

  test("完全域外降级：notice-parser × 量子 → degrade（无专家可救援）", () => {
    const ws = makeWorkspace("dgate-unit-quantum");
    const g = directAskGateOf(ws, "notice-parser", "quantum braiding simulation", true);
    expect(g.kind).toBe("degrade");
    expect(g.reason).toContain("notice-parser");
    expect(g.remedies!.length).toBeGreaterThanOrEqual(3);
    const answer = directDegradeAnswer("notice-parser", g);
    expect(answer).toContain("◌ 直连车道不服务此问题域");
    expect(answer).toContain("建议出口");
  });

  test("超短域外问题也降级（「你好」不套罐头 —— 直连与团队口径的差异点）", () => {
    const ws = makeWorkspace("dgate-unit-hi");
    const g = directAskGateOf(ws, "notice-parser", "你好", true);
    expect(g.kind).toBe("degrade");
  });

  test("真实车道旁路：任何专家 × 任何问题 → passthrough（域感知是模型的活）", () => {
    const ws = makeWorkspace("dgate-unit-real");
    const g = directAskGateOf(ws, "notice-parser", "quantum braiding simulation", false);
    expect(g.kind).toBe("passthrough");
  });

  test("占位剧本旁路：导入专家的元应答对任何问题诚实（不属答非所问）", () => {
    const ws = makeWorkspace("dgate-unit-placeholder");
    // 导入一个 harness → 自动生成「[imported harness X] 占位剧本应答」占位轨道
    const src = path.join(TEST_RUN, "dgate-poet.hsl");
    fs.writeFileSync(src, [
      "/// 诗人（Poet）：一位专业诗人，深谙现代诗、古典格律诗与俳句。",
      "#[capability(llm_call)]",
      "#[capability(poetry)]",
      "export fn main() -> Result<(), String> {",
      '    println!("poet harness on duty");',
      "    Ok(())",
      "}",
      "",
    ].join("\n"));
    const imp = runOrg(["import", src, "--workspace", ws, "--name", "poet"]);
    expect(imp.ok).toBe(true);
    // 词汇稀薄的追问 / 完全域外的元问题 → 均放行（占位应答对任何问题诚实：
    // 「这是占位，真实回答请 --model deepseek」—— 不是域罐头答非所问）
    const g1 = directAskGateOf(ws, "poet", "再用俳句写同一个主题", true);
    expect(g1.kind).toBe("passthrough");
    expect(g1.placeholder).toBe(true);
    const g2 = directAskGateOf(ws, "poet", "校验服务级 model 回落", true);
    expect(g2.kind).toBe("passthrough");
    expect(g2.placeholder).toBe(true);
    // 域剧本专家不受占位旁路影响（STOCK 的 notice-parser 是真罐头，照常拦）
    const g3 = directAskGateOf(ws, "notice-parser", "quantum braiding simulation", true);
    expect(g3.kind).toBe("degrade");
    expect(g3.placeholder).toBeFalsy();
  }, 120_000);

  test("空问题旁路（信息不足不拦，原行为）", () => {
    const ws = makeWorkspace("dgate-unit-empty");
    expect(directAskGateOf(ws, "notice-parser", "   ", true).kind).toBe("passthrough");
  });

  test("无 direct 轨道的专家不硬失败：reroute/degrade 兜住 FIXTURE_EXHAUSTED", () => {
    const ws = makeWorkspace("dgate-unit-notrack");
    // 注册一个 manifest 高度相关但 fixture 无 direct: 轨道的专家
    const idx = path.join(ws, "registry/index.json");
    const reg = JSON.parse(fs.readFileSync(idx, "utf-8")) as Array<Record<string, unknown>>;
    const fx = path.join(TEST_RUN, "dgate-no-direct-track.json");
    fs.writeFileSync(fx, JSON.stringify({ tracks: { "handoff:weird": ["x"] } }));
    reg.push({ name: "weird", version: "1.0.0", source: "manual", fixture: path.relative(ws, fx), description: "量子 braiding 模拟 quantum braiding" });
    fs.writeFileSync(idx, JSON.stringify(reg));
    // 选中 weird + 量子问题（manifest 满分）→ 无轨道仍不 passthrough；
    // 无其它专家可救援 → degrade（而非旧的 FIXTURE_EXHAUSTED 硬失败）
    const g = directAskGateOf(ws, "weird", "quantum braiding simulation", true);
    expect(g.kind).toBe("degrade");
    expect(g.reason).toContain("无 direct:weird 轨道");
    // 有其它专家可救援时 → reroute（轨道缺失不挡救援）
    const g2 = directAskGateOf(ws, "weird", "请创作一首古典风格的卡农", true);
    expect(g2.kind).toBe("reroute");
    expect(g2.expert).toBe("composer");
  });
});

describe("v0.5.14 直连救援/降级（e2e CLI）", () => {
  test("D2 ask reroute：notice-parser × 卡农 → composer 应答 + WAV + lane_rescue 留痕", () => {
    const ws = makeWorkspace("dgate-e2e-canon");
    const r = runOrg(["ask", "notice-parser", "请创作一首古典风格的卡农", "--workspace", ws]);
    expect(r.ok).toBe(true);
    // 救援提示可观测（调度权可绕、知情权不可绕）
    expect(r.stdout).toContain("直连救援");
    expect(r.stdout).toContain("composer");
    // 音频产物真实交付（救援轮默认开工具环 —— 与团队救援同规则）
    const wav = path.join(ws, "out-ask/music.wav");
    expect(fs.existsSync(wav)).toBe(true);
    expect(fs.statSync(wav).size).toBeGreaterThan(100_000);
    expect(fs.existsSync(path.join(ws, "out-ask/music.mid"))).toBe(true);
    // 会话账本落盘（记账权不可绕 —— 记在救援专家名下）
    expect(fs.existsSync(path.join(ws, "runtime/sessions/composer/default.jsonl"))).toBe(true);
    // lane_rescue 事件前插（回放面板 ⇄ 卡的数据源）
    const first = fs.readFileSync(path.join(ws, "out-ask/events.jsonl"), "utf-8")
      .split("\n")[0]!;
    const ev = JSON.parse(first) as { name: string; data: Record<string, unknown> };
    expect(ev.name).toBe("lane_rescue");
    expect(ev.data["mode"]).toBe("reroute");
    expect(ev.data["expert"]).toBe("composer");
    expect(ev.data["from"]).toBe("notice-parser");
  }, 120_000);

  test("D3 ask degrade：notice-parser × 量子 → 零消耗 + 产物诚实 + 不落账本", () => {
    const ws = makeWorkspace("dgate-e2e-quantum");
    const r = runOrg(["ask", "notice-parser", "quantum braiding simulation", "--workspace", ws]);
    expect(r.exitCode).toBe(0); // 诚实降级不是失败
    expect(r.stdout).toContain("◌ 直连车道不服务此问题域");
    expect(r.stdout).toContain("建议出口");
    // 降级产物（回放面板 ◌ 卡的数据源）
    const runJson = JSON.parse(fs.readFileSync(path.join(ws, "out-ask/run.json"), "utf-8"));
    expect(runJson["lane"]).toBe("degraded-out-of-domain");
    expect(runJson["ok"]).toBe(true);
    const evs = fs.readFileSync(path.join(ws, "out-ask/events.jsonl"), "utf-8");
    expect(evs).toContain("lane_rescue");
    expect(evs).toContain("\"mode\":\"degrade\"");
    // 零消耗铁证：direct.hsl 未跑（无账本写入、无解释器事件）
    expect(fs.existsSync(path.join(ws, "out-ask/direct-ledger.jsonl"))).toBe(false);
    expect(evs).not.toContain("capability_granted");
    expect(fs.existsSync(path.join(ws, "runtime/sessions/notice-parser/default.jsonl"))).toBe(false);
  }, 60_000);

  test("D6 域内零影响：notice-parser × 公告问题 → 原罐头答案（无救援行）", () => {
    const ws = makeWorkspace("dgate-e2e-notices");
    const r = runOrg(["ask", "notice-parser", "解析公告文件为结构化记录", "--workspace", ws]);
    expect(r.ok).toBe(true);
    expect(r.stdout).not.toContain("直连救援");
    expect(r.stdout).not.toContain("零消耗降级");
    // 原行为：direct 流水线真实跑了（账本落盘 + 解释器事件）
    expect(fs.existsSync(path.join(ws, "out-ask/direct-ledger.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "runtime/sessions/notice-parser/default.jsonl"))).toBe(true);
  }, 60_000);
});

describe("v0.5.14 直连救援/降级（e2e Web · SSE 主路径）", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;

  beforeAll(() => {
    ws = makeWorkspace("dgate-web");
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(() => {
    server.stop(true);
  });

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

  test("D4 Web reroute：done 帧 rescue 元数据 + 音频 + 事件前插", async () => {
    const r = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "notice-parser", question: "请创作一首古典风格的卡农", session: "dgate-r1" }),
    });
    expect(r.status).toBe(200);
    const events = parseSse(await r.text());
    const dones = events.get("done") as Array<{
      ok: boolean; answer: string; rescue?: { from: string; to: string; score: number };
      audio?: Array<{ wavFile: string }>;
    }>;
    expect(dones?.length).toBe(1);
    const done = dones[0]!;
    expect(done.ok).toBe(true);
    // 救援元数据（GUI 气泡 ⇄ 徽标的数据源）
    expect(done.rescue).toMatchObject({ from: "notice-parser", to: "composer" });
    expect(done.rescue!.score).toBeGreaterThanOrEqual(SEMANTIC_FLOOR);
    // 音频开袋即食（withAskAudio 钩子在救援轮同样生效）
    expect(done.audio!.length).toBeGreaterThanOrEqual(1);
    expect(done.audio![0]!.wavFile).toBe("music.wav");
    // 账本记在救援专家名下
    expect(fs.existsSync(path.join(ws, "runtime/sessions/composer/dgate-r1.jsonl"))).toBe(true);
    // 事件前插（回放 ⇄ 卡）
    const first = fs.readFileSync(path.join(ws, "out-ask/events.jsonl"), "utf-8")
      .split("\n")[0]!;
    expect((JSON.parse(first) as { name: string }).name).toBe("lane_rescue");
  }, 120_000);

  test("D5 Web degrade：done 帧 degraded + 零账本 + 降级产物", async () => {
    const r = await fetch(base + "/api/ask-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expert: "notice-parser", question: "quantum braiding simulation", session: "dgate-d1" }),
    });
    expect(r.status).toBe(200);
    const events = parseSse(await r.text());
    const dones = events.get("done") as Array<{
      ok: boolean; answer: string; degraded?: boolean; tokens: number;
    }>;
    expect(dones?.length).toBe(1);
    const done = dones[0]!;
    expect(done.ok).toBe(true);
    expect(done.degraded).toBe(true);
    expect(done.tokens).toBe(0);
    expect(done.answer).toContain("◌ 直连车道不服务此问题域");
    expect(done.answer).toContain("建议出口");
    // 零消耗：无账本（问题域外连解释器都没起）
    expect(fs.existsSync(path.join(ws, "runtime/sessions/notice-parser/dgate-d1.jsonl"))).toBe(false);
    // 降级产物（回放 ◌ 卡）
    const runJson = JSON.parse(fs.readFileSync(path.join(ws, "out-ask/run.json"), "utf-8"));
    expect(runJson["lane"]).toBe("degraded-out-of-domain");
    // log 事件至少有一条降级说明（SSE 观测面）
    const logs = (events.get("log") as Array<{ line: string }>) ?? [];
    expect(logs.some((l) => l.line.includes("零消耗降级"))).toBe(true);
  }, 60_000);

  test("D7 GUI 要素：rsc-badge 徽标样式 + finalize 救援渲染（内联脚本自洽）", async () => {
    const r = await fetch(base + "/");
    const html = await r.text();
    // CSS：救援徽标（琥珀描边）与降级气泡（左侧竖线 + 暗色正文）
    expect(html).toContain(".rsc-badge");
    expect(html).toContain(".rsc-badge.deg");
    expect(html).toContain(".t-bot.degraded");
    // finalize 渲染：救援轮 who 行亮出换专家事实（⇄ 徽标）
    expect(html).toContain("⇄ 救援自");
    expect(html).toContain("outcome.rescue");
    expect(html).toContain("◌ 零消耗");
    // 内联脚本自洽（模板字符串转义陷阱的回归锚 —— v0.5.13 教训）
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1]!)).not.toThrow();
  });
});
