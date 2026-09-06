// ============================================================================
// tests/dynamics.test.ts — 运行时动力学的机制级测试（条件触发路径）
// ----------------------------------------------------------------------------
// 演示不触发的分支在这里用构造工作区 + 变体剧本逐一点火：
//   1. 静默更新检测告警（评分卡劣化超阈值）
//   2. 固化自动降级（热启动 + 命中率漂移 → 解冻最旧键 + 审计事件）
//   3. Reject 真重派（路由重选，排除失败执行体）
//   4. Escalate 用户仲裁（arbitrate 轨道回填 → 复用四态裁决全逻辑）
//   5. 能力变更补丁：未批准拒绝（审计事件） / 批准后合入（audit-user-only 闸门）
//   6. 流程补丁：拓扑关键词 → 全量 fixture + 评测分不回退闸门
//   7. N 版本冗余：实现来源多样的候选对镜像派单（产出只计分）
// ============================================================================

import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  TEST_RUN, runOrgRun, runVariant, fixtureVariant, makeWorkspace,
  eventsOf, countEvents, journalEvents, metricsOf, readJson, exists,
} from "./helpers";

// ----------------------------------------------------------------------------
// 1. 静默更新检测：预置基线 → 劣化告警
// ----------------------------------------------------------------------------
describe("静默更新检测（评分卡漂移告警）", () => {
  test("当期评分卡劣化超阈值 → score_drift_alert + metrics 计数", () => {
    const ws = makeWorkspace("drift");
    // 预置基线：judgment 格满分（固化命中率 1.0）
    const baselineDir = path.join(ws, "registry/scorecards");
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(path.join(baselineDir, "baseline-scripted.json"), JSON.stringify({
      model: "scripted", evidence_count: 1,
      cells: [{ cell: "judgment|structured_extract", score: 1.0, confidence: 1 }],
    }));
    const out = path.join(ws, "out-drift");
    const r = runOrgRun(ws, out);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // run A 判定节点全 miss（命中率 0）→ 相对基线劣化 1.0 > 0.25 → 告警
    const events = eventsOf(out);
    expect(countEvents(events, "score_drift_alert")).toBeGreaterThanOrEqual(1);
    const m = metricsOf(ws, "drift")!;
    expect(m.drift_alerts).toBeGreaterThanOrEqual(1);
  });
});

// ----------------------------------------------------------------------------
// 2. 固化自动降级：热启动低命中 → 解冻最旧键
// ----------------------------------------------------------------------------
describe("固化自动降级（降级是生命线）", () => {
  test("热启动 + 命中率漂移 → crystallize_degrade 事件 + memo 解冻", () => {
    const ws = makeWorkspace("degrade");
    // 预置热启动 memo：两个与本期输入无关的旧键（模拟输入分布漂移）
    const memoDir = path.join(ws, "registry/memos");
    fs.mkdirSync(memoDir, { recursive: true });
    fs.writeFileSync(path.join(memoDir, "notice-parser.json"), JSON.stringify({
      memos: { "旧键甲": "旧输出甲", "旧键乙": "旧输出乙" },
      observations: {},
    }));
    const out = path.join(ws, "out-degrade");
    const r = runOrgRun(ws, out);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    // 本期 5 次判定全 miss（旧键永不命中）→ 命中率 0 < 0.4 → 降级最旧键
    expect(countEvents(events, "crystallize_degrade")).toBe(1);
    // 解冻后 memo 只剩 1 条旧键
    const memo = readJson(path.join(ws, "registry/memos/notice-parser.json"));
    expect(Object.keys(memo.memos)).toEqual(["旧键乙"]);
  });
});

// ----------------------------------------------------------------------------
// 3. Reject 真重派
// ----------------------------------------------------------------------------
describe("Reject 重派（路由重选）", () => {
  test("语义裁决 Reject → 排除失败执行体重派 → 二次执行收货", () => {
    const ws = makeWorkspace("reject");
    // 剧本：validate 首个语义裁决 = Reject（首轮 0.8 被客观闸门拦不走轨道，
    // 返工轮 1.0 进轨道被 Reject）→ 重派（工厂重铸）→ 下一轮 accept
    const fixture = fixtureVariant((f) => {
      f.tracks["review:validate"] = [
        JSON.stringify({ verdict: "reject", reason: "字段抽取规则与契约不符" }),
        JSON.stringify({ verdict: "accept" }),
        JSON.stringify({ verdict: "accept" }),
      ];
      // 重派走工厂重铸：第二份 mint 轨道
      f.tracks.mint_spec.push(f.tracks.mint_spec[0]);
      f.tracks.mint_hsl.push(f.tracks.mint_hsl[0]);
      f.tracks.mint_fixture.push(f.tracks.mint_fixture[0]);
    });
    const out = path.join(ws, "out-reject");
    const r = runVariant(ws, out, fixture);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    // 裁决与重派留痕
    expect(journalEvents(events, "review").some((d) => String(d.detail).includes("rejected"))).toBe(true);
    expect(journalEvents(events, "re-route").length).toBeGreaterThanOrEqual(1);
    // 重派后仍收货 3/3
    const m = metricsOf(ws, "reject")!;
    expect(m.accepted).toBe(3);
    expect(m.revises_total).toBeGreaterThanOrEqual(1);
  });
});

// ----------------------------------------------------------------------------
// 4. Escalate 用户仲裁
// ----------------------------------------------------------------------------
describe("Escalate 仲裁（用户是信任链的根）", () => {
  test("语义裁决 Escalate → arbitrate 轨道回填用户裁决 → 收货", () => {
    const ws = makeWorkspace("escalate");
    const fixture = fixtureVariant((f) => {
      f.tracks["review:parse"] = [JSON.stringify({ verdict: "escalate", question: "日期列要保留原文字段吗？" })];
      f.tracks["arbitrate:parse"] = [JSON.stringify({ verdict: "accept" })];
    });
    const out = path.join(ws, "out-escalate");
    const r = runVariant(ws, out, fixture);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    expect(journalEvents(events, "review").some((d) => String(d.detail).includes("escalate"))).toBe(true);
    expect(journalEvents(events, "arbitrate").some((d) => String(d.detail).includes("verdict=Accept"))).toBe(true);
    const m = metricsOf(ws, "escalate")!;
    expect(m.accepted).toBe(3);
  });

  test("仲裁要求修改 → 复用 Revise 全逻辑（返工 + 复发计数）", () => {
    const ws = makeWorkspace("escalate-revise");
    const fixture = fixtureVariant((f) => {
      // 返工后 parse 单会再次进入审查 —— 轨道需第二条裁决（返工轮 accept）
      f.tracks["review:parse"] = [
        JSON.stringify({ verdict: "escalate", question: "分类粒度够吗？" }),
        JSON.stringify({ verdict: "accept" }),
      ];
      f.tracks["arbitrate:parse"] = [JSON.stringify({ verdict: "revise", note: "请补充部门字段" })];
    });
    const out = path.join(ws, "out-escalate-revise");
    const r = runVariant(ws, out, fixture);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    // 仲裁的 Revise 进入同一套返工通道（re-dispatch 留痕）
    expect(journalEvents(events, "re-dispatch").length).toBeGreaterThanOrEqual(1);
    const m = metricsOf(ws, "escalate-revise")!;
    expect(m.accepted).toBe(3);
  });
});

// ----------------------------------------------------------------------------
// 5/6. 补丁变更分级闸门
// ----------------------------------------------------------------------------
const ANCHOR = 'let unparsed_ok = feedback_raw != String::from("[]");';

/** 判卷样本（全 valid）：smoke 与 no-regress 闸门的判卷依据 —— 无行为变更的补丁不得回退。 */
function writeValidSample(ws: string): void {
  fs.mkdirSync(path.join(ws, "factory/samples"), { recursive: true });
  fs.writeFileSync(path.join(ws, "factory/samples/record-validator.json"),
    JSON.stringify({
      task_id: 1, goal: "validate records", acceptance: "coverage >= 0.95",
      payload: [{ title: "样本公告", date: "2024-03-10", date_status: "ok", dept: "办公室", category: "announcement" }],
      feedback: [],
    }));
}

describe("补丁变更分级闸门（提议权与合入权分离）", () => {
  test("能力变更补丁未批准 → 拒绝 + 审计事件，版本不变", () => {
    const ws = makeWorkspace("cap-reject");
    // run A 记复发 1 次
    expect(runOrgRun(ws, path.join(ws, "out-a")).ok).toBe(true);
    // run B 复发 → 补丁提案触碰能力注解 → 未经用户批准 → 拒绝
    const fixture = fixtureVariant((f) => {
      f.tracks.patch_diff = [JSON.stringify({
        old_text: ANCHOR,
        new_text: `${ANCHOR} // #[capability(process_spawn = "auto")]`,
      })];
    });
    const r = runVariant(ws, path.join(ws, "out-b"), fixture);
    expect(r.ok).toBe(true);
    const events = eventsOf(path.join(ws, "out-b"));
    expect(countEvents(events, "audit")).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.name === "audit" && String(e.data?.event ?? "").includes("capability_change_rejected"))).toBe(true);
    const manifest = readJson(path.join(ws, "registry/record-validator.json"));
    expect(manifest.version).toBe("1.0.0");
  });

  test("能力变更补丁经用户批准（ORG_CAPABILITY_APPROVED=1）→ 合入 audit-user-only 闸门", () => {
    const ws = makeWorkspace("cap-approve");
    expect(runOrgRun(ws, path.join(ws, "out-a")).ok).toBe(true);
    // 判卷样本（全 valid）：无行为变更的补丁在验收上不得回退
    writeValidSample(ws);
    const fixture = fixtureVariant((f) => {
      f.tracks.patch_diff = [JSON.stringify({
        old_text: ANCHOR,
        new_text: `${ANCHOR} // #[capability] reviewed by user`,
      })];
    });
    const r = runVariant(ws, path.join(ws, "out-b"), fixture, { ORG_CAPABILITY_APPROVED: "1" });
    expect(r.ok).toBe(true);
    const manifest = readJson(path.join(ws, "registry/record-validator.json"));
    expect(manifest.version).toBe("1.0.1");
    expect(manifest.provenance[0].kind).toBe("capability");
    expect(manifest.provenance[0].gate).toContain("audit-user-only");
  });

  test("流程补丁（拓扑关键词）→ full-fixture+no-regress 闸门合入", () => {
    const ws = makeWorkspace("flow-patch");
    expect(runOrgRun(ws, path.join(ws, "out-a")).ok).toBe(true);
    // 判卷样本（全 valid）：无行为变更的补丁在验收上不得回退
    writeValidSample(ws);
    const fixture = fixtureVariant((f) => {
      f.tracks.patch_diff = [JSON.stringify({
        old_text: ANCHOR,
        new_text: `${ANCHOR} // flow: loop guard reviewed`,
      })];
    });
    const r = runVariant(ws, path.join(ws, "out-b"), fixture);
    expect(r.ok).toBe(true);
    const manifest = readJson(path.join(ws, "registry/record-validator.json"));
    expect(manifest.version).toBe("1.0.1");
    expect(manifest.provenance[0].kind).toBe("flow");
    expect(manifest.provenance[0].gate).toBe("full-fixture+no-regress");
  });

  test("评测分不回退闸门：恶意流程补丁（破坏校验规则）→ 拒绝回滚", () => {
    const ws = makeWorkspace("flow-regress");
    expect(runOrgRun(ws, path.join(ws, "out-a")).ok).toBe(true);
    // 流程补丁：替换 title 校验规则为恒真（样本仍过 smoke）？
    // 更狠：把字段规则改成失败语义 → smoke 覆盖率跌破 eval(1.0) → 评测分回退 → 拒绝
    const fixture = fixtureVariant((f) => {
      f.tracks.patch_diff = [JSON.stringify({
        old_text: 'if title.len() == 0 {',
        new_text: 'if title.len() < 0 { // flow: relax loop',
      })];
    });
    const r = runVariant(ws, path.join(ws, "out-b"), fixture);
    // 补丁被拒绝后运行继续（补丁未合入 ≠ 运行失败）
    expect(r.ok).toBe(true);
    const manifest = readJson(path.join(ws, "registry/record-validator.json"));
    expect(manifest.version).toBe("1.0.0");
    expect(journalEvents(eventsOf(path.join(ws, "out-b")), "patch")
      .some((d) => String(d.detail).includes("补丁未合入"))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// 7. N 版本冗余
// ----------------------------------------------------------------------------
describe("N 版本冗余（实现来源多样）", () => {
  test("ORG_REDUNDANCY=2 → 候选对镜像派单 → redundancy_compare 一致", () => {
    const ws = makeWorkspace("redundancy");
    // 构造第二实现：record-validator-alt（manual 来源、独立 .hsl entry）
    const stock = fs.readFileSync(path.join(process.cwd(), "hsl/factory/stock/record-validator.hsl"), "utf-8");
    fs.mkdirSync(path.join(ws, "registry/experts"), { recursive: true });
    // base 与 alt 的 entry 都要落盘（镜像双跑从磁盘加载各自实现）
    fs.writeFileSync(path.join(ws, "registry/experts/record-validator.hsl"), stock);
    fs.writeFileSync(path.join(ws, "registry/experts/record-validator-alt.hsl"), stock);
    fs.mkdirSync(path.join(ws, "factory/fixtures"), { recursive: true });
    fs.writeFileSync(path.join(ws, "factory/fixtures/record-validator-alt.fixture.json"),
      JSON.stringify({ acts: [], reviews: [], tracks: {} }));
    // 注册表加入 alt（notice-parser + record-validator 预登记，双实现来源多样）
    const idx = readJson(path.join(ws, "registry/index.json"));
    const noticeParser = idx.find((m: any) => m.name === "notice-parser");
    const base: any = {
      name: "record-validator", version: "1.0.0", bnf: "v1.5.0",
      description: "校验结构化记录完整性并产出验收结论",
      capabilities: ["validate"],
      signature: "fn(TaskSpec) -> Result<StatusReport, ExpertError>",
      source: "factory", eval_score: 1.0,
      fixture: "factory/samples/record-validator.json",
      entry: "registry/experts/record-validator.hsl",
      uses: 0, pass_rate: 1.0, provenance: [],
    };
    const alt: any = {
      ...base,
      name: "record-validator-alt",
      description: "独立实现的记录完整性校验（第二实现来源）",
      source: "manual",
      entry: "registry/experts/record-validator-alt.hsl",
    };
    fs.writeFileSync(path.join(ws, "registry/index.json"),
      JSON.stringify([noticeParser, base, alt]));
    fs.mkdirSync(path.join(ws, "factory/samples"), { recursive: true });
    fs.writeFileSync(path.join(ws, "factory/samples/record-validator.json"),
      JSON.stringify({
        task_id: 1, goal: "validate records", acceptance: "coverage >= 0.95",
        payload: [{ title: "样本公告", date: "2024-03-10", date_status: "ok", dept: "办公室", category: "announcement" }],
        feedback: [],
      }));
    fs.writeFileSync(path.join(ws, "factory/fixtures/record-validator.fixture.json"),
      JSON.stringify({ acts: [], reviews: [], tracks: {} }));

    const out = path.join(ws, "out-redundancy");
    const r = runOrgRun(ws, out, { ORG_REDUNDANCY: "2" });
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    // validate 单返工一次（unparsed 语义首轮 coverage 0.8 → 客观闸门拦下）→
    // 两次真实执行各触发一次镜像对比（冗余按执行计次，不按子任务）
    expect(countEvents(events, "redundancy_compare")).toBe(2);
    const cmp = events.find((e) => e.name === "redundancy_compare")!;
    expect(cmp.data!.agree).toBe(true);
    const m = metricsOf(ws, "redundancy")!;
    expect(m.accepted).toBe(3);
  });
});
