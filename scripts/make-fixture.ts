#!/usr/bin/env bun
// ============================================================================
// org/scripts/make-fixture.ts — 演示剧本生成器
// ----------------------------------------------------------------------------
// 产出 fixtures/run-notices.json：全叙事演示（A: 现场铸专家+返工+固化起步；
// B: 复用资产+意见复发→补丁合入+金丝雀影子晋升；C: 补丁版蓝绿验证；
// D: 多轮直连；E: 暖移交）的全部判定响应轨道。
//
// 工程语义：scripted 模式的剧本 = 某次真实运行的「录制响应」。mint_hsl 轨道
// 的内容与 hsl/factory/stock/record-validator.hsl 逐字一致 —— 该文件即人工抽查
// 存档（生成器同时出题与答题的结构性风险，由人工抽查机制兜底）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const STOCK = path.join(ROOT, "hsl/factory/stock/record-validator.hsl");
const OUT = path.join(ROOT, "fixtures/run-notices.json");

const validatorSource = fs.readFileSync(STOCK, "utf-8");

// ---- 判定响应轨道（按消费顺序精确排列） ----
//
// norm_date 消费序列（关键工程事实：每次 dhv run 是独立进程，fixture 轨道
// 索引每轮从 0 重置 —— 因此各轮的第一条 miss 必须落在同一轨道位置且取值一致）：
//   通知序：unknown(3月14日) / A(3月10日) / B(3月12日) / A / B
//   run A（memo 空）  ：n1 unknown obs1 → n2 A obs1 → n3 B obs1 → n4 A obs2 冻结
//                        → n5 B obs2 冻结 —— 消耗位置 0-4（5 条）
//   run B（memo: A,B）：n1 unknown obs2 冻结 → 其余全命中 —— 消耗位置 0（1 条）
//                        （位置 0 = "unknown"，与 run A 的 n1 obs1 同值 —— 无冲突）
//   run C（memo: A,B,unknown）：全部命中 —— 消耗 0 条（判定节点零模型调用）
//   model_calls 衰减曲线：5 → 1 → 0；hits 增长：0 → 4 → 5
const normDate = [
  "unknown",    // 位置 0：run A n1 obs1 / run B n1 obs2（同值，双轮复用）
  "2024-03-10", // 位置 1：run A n2 A obs1
  "2024-03-12", // 位置 2：run A n3 B obs1
  "2024-03-10", // 位置 3：run A n4 A obs2 → 冻结
  "2024-03-12", // 位置 4：run A n5 B obs2 → 冻结
  "unknown",    // 位置 5：备用（防消费序列偏移时快速定位）
];

const fixture = {
  acts: [],
  reviews: [],
  tracks: {
    // 任务分解（三连跑共用同一录制响应）
    decompose: [
      JSON.stringify([
        { id: 1, goal: "读取工作区 raw/notices.txt 获取一周公告原文", role: "fetch", skills: [], depends_on: [], priority: 1 },
        { id: 2, goal: "结构化解析公告为记录（标题 日期 部门 分类）", role: "parse", skills: ["parse"], depends_on: [1], priority: 2 },
        { id: 3, goal: "校验记录完整性并产出验收结论", role: "validate", skills: ["validate"], depends_on: [2], priority: 3 },
      ]),
    ],
    clarify: [
      JSON.stringify([
        "输出字段偏好：标题、日期、部门、分类？",
        "日期格式用 ISO 8601 还是保留原文？",
      ]),
    ],
    answers: [
      JSON.stringify([
        "字段偏好：标题、日期、部门、分类",
        "日期用 ISO 8601，无法解析的保留原文并标注",
      ]),
    ],
    // 判定节点：日期归一化（固化管线的观测/命中序列）
    norm_date: normDate,
    // 语义审查（fetch 内联全覆盖 1.0 → 三次 accept；审查通道对全部子任务统一）
    "review:fetch": [
      JSON.stringify({ verdict: "accept" }),
      JSON.stringify({ verdict: "accept" }),
      JSON.stringify({ verdict: "accept" }),
    ],
    // 语义审查（parse 全覆盖 1.0 → 三次 accept）
    "review:parse": [
      JSON.stringify({ verdict: "accept" }),
      JSON.stringify({ verdict: "accept" }),
      JSON.stringify({ verdict: "accept" }),
    ],
    // 语义审查（validate 首轮 0.8 被客观闸门拦截不走轨道；返工轮 1.0 走轨道）
    "review:validate": [
      JSON.stringify({ verdict: "accept" }),
      JSON.stringify({ verdict: "accept" }),
      JSON.stringify({ verdict: "accept" }),
    ],
    // 工厂管线（run A 铸专家；B/C 走复用路径不再消耗）
    mint_spec: [
      JSON.stringify({
        name: "record-validator",
        description: "校验结构化记录完整性并产出验收结论",
        capabilities: ["validate"],
        acceptance: "coverage >= 0.95 (all records pass field rules)",
      }),
    ],
    mint_hsl: [validatorSource],
    mint_fixture: [
      JSON.stringify({
        goal: "acceptance rehearsal: validate sample records",
        acceptance: "coverage >= 0.95",
        payload: [
          { title: "样本公告", date: "2024-03-10", date_status: "ok", dept: "办公室", category: "announcement" },
          { title: "样本通知", date: "3月14日", date_status: "unparsed", dept: "综合部", category: "notice" },
        ],
        feedback: ["accept flagged records"],
      }),
    ],
    // 补丁提案（run B：意见复发两次 → 内核提议；合并键在工厂管线）。
    // new_text 保留 feedback_raw 引用（|| true）—— 补丁后源码必须仍过 S7 卫生检查
    patch_diff: [
      JSON.stringify({
        old_text: 'let unparsed_ok = feedback_raw != String::from("[]");',
        new_text:
          'let unparsed_ok = feedback_raw != String::from("[]") || true; // v1.0.1: unparsed records count as valid (flagged)',
      }),
    ],
    // 直连演示（多轮会话：一次进程消费两条 —— 轨道内顺序应答）
    "direct:notice-parser": [
      "上周抓取任务的字段映射规则：标题/日期/部门取自块内「字段: 值」行；分类由标题关键词判定（公告→announcement，通知→notice）；日期经 norm_date 判定节点归一化为 ISO 8601，无法解析的保留原文并标注 date_status=unparsed。该判定节点已固化，命中 memo 时零模型调用。",
      "日期无法解析时保留原文并在记录里标注 date_status=unparsed（不静默丢弃）；补丁 v1.0.1 之后这些标注记录计入覆盖（flagged, not excluded），由校验专家以 flagged 语义验收。",
    ],
    // 暖移交演示（转接模式：主控移交摘要 → 专家代答）
    "handoff:notice-parser": [
      "一句话版：公告按「=== NOTICE」切块，取标题/日期/部门三字段，分类看标题关键词，日期归一化为 ISO 8601（解析不了就保留原文并标注 unparsed）。",
    ],
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
console.log(`✓ fixture written: ${path.relative(process.cwd(), OUT)}`);
console.log(`  tracks: ${Object.keys(fixture.tracks).join(", ")}`);
console.log(`  norm_date entries: ${normDate.length}（run A 消耗 5、run B 消耗 1、run C 消耗 0 —— 零模型调用）`);
console.log(`  mint_hsl bytes: ${validatorSource.length}（与 hsl/factory/stock/record-validator.hsl 逐字一致）`);
