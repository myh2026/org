// ============================================================================
// tests/depends-transfer.test.ts — v0.5.36（F1 交付物对齐 · B-38）定向回归
// ----------------------------------------------------------------------------
// 真实车道首演 F1 实锤：写文件子任务（depends_on=[1]）被「input=workspace →
// raw/notices.txt」惯例劫持 —— 分解器已声明的依赖被 prepare_payload 无视，
// 上游作品（诗）被五条公告替换，现场铸出的专家把《公告纪事》覆盖回 poem.md。
// 修复：⓪「依赖任务真实交付物优先」（括号占位/失败标注不转移，回落既有路由）。
//
// 本文件用 scripted 剧本把 F1 的物料形态钉死为可复现断言（修一个 bug 锁一个用例）：
//   P1 正向：task#1 parse（B:reuse notice-parser）产出真实交付物（记录 JSON）
//      → task#2 write（C:generate，depends_on=[1]）的真实派单载荷 = 上游交付物
//      （含 "date_status"），而非 raw/notices.txt（含 "=== NOTICE"）。
//   P2 反向：task#1 fetch（inline）交付物是「(」占位 → 不转移，回落 raw/
//      notices.txt（公告演示语义不变 —— 防修复过度扩张 / 防未来「简化」回归）。
//
// 观测点：factory/current-spec.json —— run_expert_at 在每次嵌套派单前写入的
// 工单落盘（含 payload）；run 收尾时该文件 = 最后一次真实派单的 spec。
// （task#1 的 B:reuse 是进程内静态专家、不落盘工单；task#2 的 C:generate
//  经工厂铸造后必有一次嵌套真实派单 —— 故 current-spec 恰为 task#2 的载荷真源。）
// 负控证据（修前必红）：hsl/org.hsl 回退 dea78b7（v0.5.35 含 B-38 前行为）复跑
// P1 → payload 含 "=== NOTICE"、不含 "date_status" —— 见 /root/audit/b38-negative-control.log。
// ============================================================================
import { TT } from "./tt.ts";
import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "../lib/fssafe-fs.ts"; // fs 垫片（受限内核删除降级链；同 fixes.test.ts）
import {
  runVariant, makeWorkspace, fixtureVariant, readJson,
} from "./helpers";

/** 读最后一次真实派单的 payload（工单落盘真源）。 */
function lastDispatchSpec(ws: string): { taskId: number; payload: string } {
  const spec = readJson(path.join(ws, "factory/current-spec.json"));
  return { taskId: Number(spec.task_id), payload: String(spec.payload ?? "") };
}

describe("v0.5.36 B-38：depends_on 上游交付物 → 下游载荷转移", () => {
  test("正向：真实交付物优先 —— 下游载荷 = 上游记录 JSON（非 raw/notices）", () => {
    const ws = makeWorkspace("depends-positive");
    const fx = fixtureVariant((f) => {
      const plan = [
        { id: 1, goal: "结构化解析公告为记录（标题 日期 部门 分类）", role: "parse",
          skills: ["parse"], depends_on: [], priority: 1, input: "workspace" },
        { id: 2, goal: "将上游解析出的记录汇总写入 summary.md 报告文件", role: "write",
          skills: ["write"], depends_on: [1], priority: 2, input: "workspace" },
      ];
      f.tracks["decompose"] = [JSON.stringify(plan)];
      // 轨道垫厚：两次派单/审查的余量（余量同 B-38 POC 实跑验证过的配比）
      f.tracks["review:parse"] = ['{"verdict":"accept"}', '{"verdict":"accept"}', '{"verdict":"accept"}', '{"verdict":"accept"}'];
      f.tracks["review:write"] = ['{"verdict":"accept"}', '{"verdict":"accept"}', '{"verdict":"accept"}'];
      f.tracks["norm_date"] = f.tracks["norm_date"].concat(f.tracks["norm_date"]);
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // 路由自诊断：task#1 真实交付物生产者；task#2 观测点（嵌套派单落工单）
    const journal = fs.readFileSync(path.join(ws, "out-a/journal.jsonl"), "utf-8");
    expect(journal).toContain("task#1 parse -> B:reuse");
    expect(journal).toContain("task#2 write -> C:generate");
    // 真源断言：B-38 病灶（raw/notices 惯例劫持）不再复现
    const { taskId, payload } = lastDispatchSpec(ws);
    expect(taskId).toBe(2);
    expect(payload).toContain('"date_status"');   // 上游 notice-parser 交付物（记录 JSON）真身
    expect(payload).not.toContain("=== NOTICE");  // 不被 raw/notices.txt 劫持（B-38 病灶）
  }, TT);

  test("反向：「(」占位交付物不转移 → 回落 raw（公告演示语义不变）", () => {
    const ws = makeWorkspace("depends-negative");
    const fx = fixtureVariant((f) => {
      const plan = [
        { id: 1, goal: "读取工作区 raw/notices.txt 获取一周公告原文", role: "fetch",
          skills: [], depends_on: [], priority: 1 },
        { id: 2, goal: "将上游解析出的记录汇总写入 summary.md 报告文件", role: "write",
          skills: ["write"], depends_on: [1], priority: 2, input: "workspace" },
      ];
      f.tracks["decompose"] = [JSON.stringify(plan)];
      f.tracks["review:write"] = ['{"verdict":"accept"}', '{"verdict":"accept"}', '{"verdict":"accept"}'];
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const journal = fs.readFileSync(path.join(ws, "out-a/journal.jsonl"), "utf-8");
    expect(journal).toContain("task#1 fetch -> A:inline");
    expect(journal).toContain("task#2 write -> C:generate");
    // inline fetch 交付物 = 「(fetched raw notices)」（括号占位）→ 不转移
    const { taskId, payload } = lastDispatchSpec(ws);
    expect(taskId).toBe(2);
    expect(payload).toContain("=== NOTICE");      // 回落既有物料路由（raw/notices.txt）
    expect(payload).not.toContain('"date_status"');
  }, TT);
});
