# 三连跑走读（org demo 的逐步注解）

> 前置：`bun scripts/make-fixture.ts` 生成剧本 → `bun cli/org.ts demo`。
> 全程 scripted 模式（零外联、CI 可复现），总耗时 ~1.6s。

## Run A —— 现场铸专家 + 过程审查 + 固化起步

| 步骤 | 事件（events.jsonl） | 说明 |
|:---|:---|:---|
| 分解 | `decompose` | 任务 → 3 个子任务（fetch / parse / validate DAG） |
| 澄清 | `clarify` ×2 + `answer` ×2 | 批量早发，人类思考时间与机器执行时间重叠 |
| 路由 | task#1 → A:inline；task#2 → B:reuse notice-parser；task#3 → C:generate | 四选一判定（纯函数） |
| 工厂 | mint_spec → mint_hsl → **dhv check（真实子进程）** → fixture 验收 → 登记 | 生成物 record-validator@1.0.0；git 提交 |
| 派单 | task#3 嵌套解释器执行（磁盘车道） | acceptance.json: coverage 0.80 |
| 审查 | 客观闸门（覆盖率 0.80 < 0.95）→ **Revise**（remedy 意见） | 结构性优先于裁判 |
| 返工 | spec.with_feedback → 重新派单 | 嵌套重跑：coverage 1.0 → Accept |
| 固化 | norm_date 判定节点：A/B 两日期各 obs2 → **冻结 2 条** | memo 落盘 registry/memos/ |
| 汇总 | report.md + scorecard.json + journal.jsonl | 资产沉淀 |

model_calls = 5（判定节点 5 次真实调用），revises = 1。

## Run B —— 复用资产 + 意见复发 → 补丁合入

- task#2 复用 notice-parser：日期 A/B **命中 memo**（零模型调用），unknown 第二次观测 → 冻结（model_calls = 1）；
- task#3 复用 record-validator（注册表命中，**零工厂成本**）：首轮 coverage 0.80 → Revise；
- **意见复发**（跨运行持久化 recurrence.json 计数 = 2）→ 补丁提案（patch_diff 轨道）；
- 补丁合入：fs.edit（锚点行）→ **dhv check** → smoke（样本重跑 + 覆盖率不回退）→ 版本 bump 1.0.0 → 1.0.1 → git 提交；
- 返工轮：feedback 语义 → coverage 1.0 → Accept。

## Run C —— 蓝绿验证（补丁版上岗）

- task#3 路由 B:reuse → 嵌套解释器**从磁盘加载 v1.0.1**（新派单自动加载新版）；
- 首验 coverage 1.0 → **Accept（零返工）**；
- task#2 判定节点 **5/5 全命中（零模型调用）**。

## 成本曲线

| | run A | run B | run C |
|:---|:---|:---|:---|
| model_calls | 5 | 1 | **0** |
| revises | 1 | 1 | **0** |
| 工厂调用 | 1（mint） | 0 | 0 |
| git 提交 | +mint | +patch | — |

**固化的成本结构证据：成熟流程的单位成本随复用次数递减。**
