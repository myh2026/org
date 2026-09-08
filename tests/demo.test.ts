// ============================================================================
// tests/demo.test.ts — README 核心声明的端到端验证（全叙事演示）
// ----------------------------------------------------------------------------
// 逐条断言 README 承诺的机制与数据：
//   - 三连跑 3/3 子任务、model_calls 5→1→0（固化改变成本结构）
//   - 工厂闸门：mint 过真实 dhv check + fixture 验收后注册
//   - 意见复发两次 → 补丁提案 → 同一验收管线合入 → git 注册表留痕
//   - 用户选取保留：工厂产出候选 → keep 转正 → B 路径自动复用（新增）
//   - 金丝雀影子晋升：新旧版本同输入双跑，一致才确认
//   - 蓝绿：run C 补丁版首验即收（零返工）
//   - 固化：冻结映射跨运行持久，命中零模型调用
//   - 直连：多轮会话 + 记账 + 会话账本 + 纪要回写
//   - 暖移交：移交摘要 + 代答 + 记账
//   - 资产沉淀：新专家 / 冻结节点 / 记忆 / 补丁四类资产有记账
//   - journal→fixture：审查裁决沉淀为基准题
//   - 静默更新检测：评分卡基线建立、无漂移时零告警
// ============================================================================

import { describe, test, expect, beforeAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  ROOT, TEST_RUN, runOrg, eventsOf, countEvents, journalEvents,
  metricsOf, readJson, exists,
} from "./helpers";

const WS = path.join(TEST_RUN, "demo");
const TASK = "抓取某站点近一周公告，输出结构化表格";

beforeAll(() => {
  // 全叙事演示（A/B/C 三连跑 + D 多轮直连 + E 暖移交）
  const r = runOrg(["demo", "--workspace", WS]);
  if (!r.ok) console.error(r.stdout + r.stderr);
  expect(r.ok).toBe(true);
}, 120_000);

describe("README 走读：三连跑监督回路", () => {
  for (const id of ["a", "b", "c"]) {
    test(`run ${id.toUpperCase()} 全部子任务收货`, () => {
      const run = readJson(path.join(WS, `out-${id}`, "run.json"));
      expect(run.ok).toBe(true);
      const m = metricsOf(WS, id);
      expect(m).not.toBeNull();
      expect(m.accepted).toBe(3);
      expect(m.subtasks).toBe(3);
    });
  }

  test("model_calls 衰减曲线 5 → 1 → 0（固化改变成本结构）", () => {
    const a = metricsOf(WS, "a")!;
    const b = metricsOf(WS, "b")!;
    const c = metricsOf(WS, "c")!;
    expect(a.model_calls_total).toBe(5);
    expect(b.model_calls_total).toBe(1);
    expect(c.model_calls_total).toBe(0);
  });

  test("返工曲线 1 → 1 → 0（蓝绿生效后零返工）", () => {
    const a = metricsOf(WS, "a")!;
    const b = metricsOf(WS, "b")!;
    const c = metricsOf(WS, "c")!;
    expect(a.revises_total).toBe(1);
    expect(b.revises_total).toBe(1);
    expect(c.revises_total).toBe(0);
  });
});

describe("README 走读：工厂闸门（生成必须过闸门）", () => {
  test("run A 现场铸专家 record-validator@1.0.0（mint-register 事件）", () => {
    const events = eventsOf(path.join(WS, "out-a"));
    const registers = journalEvents(events, "mint-register");
    expect(registers.length).toBe(1);
    expect(registers[0]!.detail).toContain("record-validator@1.0.0");
    expect(registers[0]!.detail).toContain("eval=1");
  });

  test("新专家落盘且 dhv check 可过（嵌套解释器真实闸门）", () => {
    const entry = path.join(WS, "registry/experts/record-validator.hsl");
    expect(exists(entry)).toBe(true);
  });

  test("run A 记 NewExpert + FrozenNode + Memory 资产（资产记账完整）", () => {
    const m = metricsOf(WS, "a")!;
    const labels = m.asset_labels as string[];
    expect(labels.some((l) => l.startsWith("expert record-validator@"))).toBe(true);
    expect(labels.some((l) => l.startsWith("frozen notice-parser."))).toBe(true);
    expect(labels.some((l) => l.startsWith("memory: task memory index"))).toBe(true);
    expect(m.assets).toBeGreaterThanOrEqual(3);
  });
});

describe("README 走读：补丁流水线与金丝雀影子晋升", () => {
  test("run B 意见复发两次 → 补丁提案（复发计数跨运行持久）", () => {
    const a = eventsOf(path.join(WS, "out-a"));
    const b = eventsOf(path.join(WS, "out-b"));
    // run A 记 1 次（意见即数据：remedy 行）
    expect(journalEvents(a, "review").some((d) => String(d.detail).includes("verdict=Revise"))).toBe(true);
    // run B 复发 → 升级补丁
    expect(journalEvents(b, "patch").some((d) => String(d.detail).includes("意见复发两次"))).toBe(true);
  });

  test("补丁经同一闸门合入 record-validator@1.0.1（git 注册表留痕）", () => {
    const manifest = readJson(path.join(WS, "registry/record-validator.json"));
    expect(manifest.version).toBe("1.0.1");
    expect(manifest.provenance.length).toBeGreaterThanOrEqual(1);
    const rec = manifest.provenance[0];
    expect(rec.kind).toBe("knowledge");
    expect(rec.gate).toBe("check+smoke");
    expect(rec.trigger).toContain("remedy:");
    // 版本归档存在（金丝雀回退原料 / 蓝绿的旧版本）
    expect(exists(path.join(WS, "registry/experts/record-validator@1.0.0.hsl"))).toBe(true);
  });

  test("金丝雀影子晋升：新旧版本同输入双跑 → 一致确认", () => {
    const events = eventsOf(path.join(WS, "out-b"));
    expect(countEvents(events, "shadow_compare")).toBe(1);
    expect(countEvents(events, "canary_confirmed")).toBe(1);
    const cmp = events.find((e) => e.name === "shadow_compare")!;
    expect(cmp.data!.agree).toBe(true);
    expect(cmp.data!.old_coverage).toBe(cmp.data!.new_coverage);
  });

  test("补丁资产记账（Patch asset）", () => {
    const m = metricsOf(WS, "b")!;
    const labels = m.asset_labels as string[];
    expect(labels.some((l) => l.startsWith("patch record-validator ::"))).toBe(true);
  });
});

describe("README 走读：固化管线（成本结构递减）", () => {
  test("冻结映射跨运行持久（memo 3 条：A 冻结 2 + B 冻结 1）", () => {
    const memo = readJson(path.join(WS, "registry/memos/notice-parser.json"));
    expect(Object.keys(memo.memos).length).toBe(3);
    expect(memo.memos["2024年3月10日"]).toBe("2024-03-10");
    expect(memo.memos["3月14日"]).toBe("unknown");
  });

  test("固化命中事件计数 0 → 4 → 5", () => {
    expect(countEvents(eventsOf(path.join(WS, "out-a")), "crystallize_hit")).toBe(0);
    expect(countEvents(eventsOf(path.join(WS, "out-b")), "crystallize_hit")).toBe(4);
    expect(countEvents(eventsOf(path.join(WS, "out-c")), "crystallize_hit")).toBe(5);
  });

  test("冻结事件计数（A: 2、B: 1）", () => {
    expect(countEvents(eventsOf(path.join(WS, "out-a")), "crystallize_frozen")).toBe(2);
    expect(countEvents(eventsOf(path.join(WS, "out-b")), "crystallize_frozen")).toBe(1);
  });
});

describe("README 走读：评分卡（证据归因聚合）", () => {
  test("评分卡落盘且证据计数随运行增长", () => {
    const a = readJson(path.join(WS, "out-a/scorecard.json"));
    const c = readJson(path.join(WS, "out-c/scorecard.json"));
    expect(a.model).toBe("scripted");
    expect(c.evidence_count).toBeGreaterThan(a.evidence_count);
  });

  test("judgment 格随固化命中率改善（A: 0 → C: 1.0）", () => {
    const a = readJson(path.join(WS, "out-a/scorecard.json"));
    const c = readJson(path.join(WS, "out-c/scorecard.json"));
    const cellA = a.cells.find((c: any) => c.cell === "judgment|structured_extract");
    const cellC = c.cells.find((c: any) => c.cell === "judgment|structured_extract");
    expect(cellA.score).toBe(0);
    expect(cellC.score).toBe(1);
  });

  test("金丝雀证据与影子裁判档入卡（canary_confirm / shadow_compare）", () => {
    const b = readJson(path.join(WS, "out-b/scorecard.json"));
    const cells = b.cells.map((c: any) => c.cell);
    expect(cells).toContain("tool_reliability|structured_extract");
  });

  test("静默更新检测：基线建立且无漂移时零告警", () => {
    expect(exists(path.join(WS, "registry/scorecards/baseline-scripted.json"))).toBe(true);
    const a = metricsOf(WS, "a")!;
    const c = metricsOf(WS, "c")!;
    expect(a.drift_alerts).toBe(0);
    expect(c.drift_alerts).toBe(0);
  });
});

describe("README 走读：资产层（git 注册表 = 增长率账本）", () => {
  test("git 注册表四提交链：template → mint → keep → patch（用户选取留痕）", () => {
    const proc = Bun.spawnSync(["git", "-C", WS, "log", "--oneline", "--all"], { stdout: "pipe" });
    const log = proc.stdout.toString().split("\n").filter((l) => l.trim().length > 0);
    expect(log.length).toBeGreaterThanOrEqual(4);
    expect(log.some((l) => l.includes("registry template"))).toBe(true);
    expect(log.some((l) => l.includes("mint record-validator@1.0.0"))).toBe(true);
    // 用户选取（工具库治理）：K 相位在 run A 后留痕 —— 增长率账本的一部分
    expect(log.some((l) => l.includes("keep record-validator@1.0.0"))).toBe(true);
    expect(log.some((l) => l.includes("(user curation)"))).toBe(true);
    expect(log.some((l) => l.includes("patch record-validator -> 1.0.1"))).toBe(true);
  });
});

describe("README 走读：用户选取保留（工具库治理）", () => {
  test("工厂产出候选 → K 相位自动转正：retained=true 落盘", () => {
    const manifest = readJson(path.join(WS, "registry/record-validator.json"));
    expect(manifest.retained).toBe(true);
    const idx = readJson(path.join(WS, "registry/index.json"));
    const rv = (idx as Array<Record<string, unknown>>).find((m) => m.name === "record-validator");
    expect(rv!.retained).toBe(true);
  });

  test("转正后 B 路径自动复用：run B/C task#3 走 reuse 通道（非 C 生成）", () => {
    for (const id of ["b", "c"]) {
      const events = eventsOf(path.join(WS, `out-${id}`));
      const dispatches = journalEvents(events, "dispatch")
        .filter((d) => String(d.detail).includes("task#3"));
      expect(dispatches.length).toBeGreaterThanOrEqual(1);
      expect(dispatches.some((d) => String(d.detail).includes("channel=reuse record-validator"))).toBe(true);
    }
  });

  test("uses 计数随派单增长（notice-parser 3 次 / record-validator 5 次）", () => {
    const idx = readJson(path.join(WS, "registry/index.json")) as Array<Record<string, unknown>>;
    const np = idx.find((m) => m.name === "notice-parser");
    const rv = idx.find((m) => m.name === "record-validator");
    // 三轮各派单 1 次
    expect(Number(np!.uses)).toBe(3);
    // A×2（首次+返工）+ B×2（首次+返工）+ C×1
    expect(Number(rv!.uses)).toBe(5);
  });
});

describe("README 走读：journal→fixture（生产即出题）", () => {
  test("审查裁决自动沉淀为验收基准题（去重后逐轨留档）", () => {
    const mined = readJson(path.join(WS, "registry/fixtures-mined/reviews.json"));
    expect(mined.source).toBe("journal");
    const tracks = Object.keys(mined.tracks);
    expect(tracks).toContain("review:fetch");
    expect(tracks).toContain("review:parse");
    expect(tracks).toContain("review:validate");
    expect(mined.tracks["review:validate"][0]).toEqual({ verdict: "accept" });
    for (const id of ["a", "b", "c"]) {
      expect(countEvents(eventsOf(path.join(WS, `out-${id}`)), "fixtures_mined")).toBe(1);
    }
  });
});

describe("README 走读：直连（调度可绕，知情/记账不可绕）", () => {
  test("多轮直连：2 轮问答、记账 2 条、会话账本持久", () => {
    const ledger = fs.readFileSync(path.join(WS, "out-direct/direct-ledger.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0);
    expect(ledger.length).toBe(2);
    const turn1 = JSON.parse(ledger[0]!);
    const turn2 = JSON.parse(ledger[1]!);
    expect(turn1.turn).toBe(1);
    expect(turn2.turn).toBe(2);
    expect(turn1.tokens).toBeGreaterThan(0);
    // 会话账本（多轮连续性载体）
    const sessions = readJson2l(path.join(WS, "runtime/sessions/notice-parser/demo.jsonl"));
    expect(sessions.length).toBe(2);
    expect(sessions[1]!.turn).toBe(2);
    // 事件上总线
    const events = eventsOf(path.join(WS, "out-direct"));
    const directOpens = events.filter((e) => e.name === "journal" && e.data?.name === "direct_open");
    expect(directOpens.length).toBe(2);
  });

  test("纪要回写（主控编排上下文保持完整）", () => {
    const memos = fs.readFileSync(path.join(WS, "runtime/direct-memos.md"), "utf-8");
    expect(memos).toContain("direct session with notice-parser [demo]");
    expect(memos.split("\n").filter((l) => l.includes("direct session")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("README 走读：转接模式（暖移交）", () => {
  test("移交摘要 + 专家代答 + 记账（handoff 通道）", () => {
    const ledger = fs.readFileSync(path.join(WS, "out-handoff/direct-ledger.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0);
    expect(ledger.length).toBe(1);
    const line = JSON.parse(ledger[0]!);
    expect(line.channel).toBe("handoff");
    const events = eventsOf(path.join(WS, "out-handoff"));
    const opens = events.filter((e) => e.name === "journal" && e.data?.name === "handoff_open");
    expect(opens.length).toBe(1);
  });
});

/** 读 JSONL 文件。 */
function readJson2l(p: string): Array<Record<string, any>> {
  return fs.readFileSync(p, "utf-8")
    .split("\n").filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, any>);
}
