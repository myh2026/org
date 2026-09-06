# dist/demo — 全叙事演示编译产物（自动生成，勿手改）

`org demo` 的全量输出快照：out-a/b/c（run.json / events.jsonl /
journal.jsonl / 评分卡 / metrics.json）、out-direct（多轮直连）与
out-handoff（暖移交）、registry（专家注册表 + 固化 memo + 基准题沉淀 +
评分卡基线）、runtime（复发计数 / 会话账本 / 纪要）与 git-chain.json
（资产层 git 历史，因嵌套 .git 不入库而以数据保存）。

再生：`bun cli/org.ts demo`（CI 每次 push 自动再生并回写，见
.github/workflows/ci.yml）。
