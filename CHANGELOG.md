# CHANGELOG

## v0.4.0（2026-09-06）

**OpenCode 级终端前端（TUI）+ Windows/macOS/Linux 三平台单二进制分发**。
产品形态从「开发者克隆仓库跑 CLI」升级为「终端用户下载即用」。

### 新增

- **组织驾驶舱 TUI**（`tui/`，零依赖自研渲染器，规格见 `docs/tui-spec.md`）：
  - 三区布局：左栏（会话 / 专家库 / 池与固化，Tab 切换 · j/k 移动 · Enter 打开）+
    主区事件流 + 底栏输入与状态；
  - 八类事件卡片：任务分解（A/B/C/D 路由徽标四色）、工厂五步 stepper、四态裁决徽标
    （Accept 绿 / Revise 琥珀 / Reject 红 / Escalate 紫）、固化（❄冻结 ⚡命中）、补丁
    （版本 bump + git sha + 金丝雀确认）、直连（多轮 + 记账）、完成卡（成本衰减 5→1→0）、
    系统卡；
  - 输入协议：任务回车派单 / `?专家 问题?` 直连 / `:demo :replay :score :theme :status
    :clear :help :quit`；
  - 三主题（org-dark emerald 系 / org-light / paper 打印友好）、窄终端降级（<100 列隐左栏）、
    帮助浮层（`?`）、运行取消（Esc）、历史会话秒开重演（`:replay`，不重跑引擎）；
  - `lib/engine.ts` 引擎桥：CLI 与 TUI 共用——子进程优先（保留嵌套解释器蓝绿语义）、
    事件流 150ms 增量 tail（events.jsonl + journal.jsonl 权威去重）、SIGTERM 取消；
  - `tui/smoke.ts` 离屏冒烟（20 断言，含进程内桥路径），CI 无 TTY 可跑。
- **三平台单二进制分发**（`scripts/build-bin.ts` + `.github/workflows/release.yml` 矩阵）：
  - 5 目标交叉编译：`bun-linux-x64 / bun-linux-arm64 / bun-darwin-x64 / bun-darwin-arm64 /
    bun-windows-x64`；
  - 运行时资源打包（`build/payload.json`：hsl 源码 + vendored dhv-ts + 工作区模板 +
    fixture 剧本，55 文件 / 934KB）→ 二进制按内容指纹解包到 `~/.org/runtime-<sha1>/`；
  - **无 bun 环境全功能**：vendored dhv-ts 重构出 `cliMain` 可编程入口 +
    `$host.dhv.{check,run}` 进程内兜底 API + HSL 工厂闸门双车道（bun 在场走嵌套子进程
    ——蓝绿语义不变；缺席走进程内——路径基准显式对齐 workspace）。实测无 bun 单二进制
    `check 30/30`、全叙事 `demo`（mint→patch→蓝绿→直连→暖移交）完整通过。

### 变更

- `cli/org.ts`：`tui` 子命令（进程内加载 `tui/entry.ts`）；引擎执行统一走 `lib/engine.ts
  dhvRun`（bun 子进程优先 → 进程内 fallback）；默认工作区解析收敛到 `lib/root.ts`。
- `cli/org.ts check` 的逐文件检查改为异步批量（进程内兜底路径下不再逐个冷启动）。

### 工具链回馈（vendored dhv-ts 与上游同步）

- `version.ts`：嵌入执行（打包进宿主二进制）时 `import.meta.dir` 指向虚拟 FS，读不到
  package.json —— 回退 `DHV_VERSION` 环境变量，最终回退 `0.0.0`（单一来源纪律不变，
  只增稳健性）。
- `main.ts`：顶层执行重构为 `export async function cliMain(argv): Promise<number>` +
  `import.meta.main` 守卫——CLI 行为零变化，嵌入场景获得无缓存泄漏的重复调用能力。
- `host.ts`：新增 `$host.dhv.check(file)` / `$host.dhv.run(args)`——进程内嵌套执行面
  （懒加载 cliMain 规避 main↔host 循环；stdout/stderr 捕获后恢复）。

### 兼容性

- 源码模式（`bun cli/org.ts …`）行为零变化：69/69 测试与 50 模块 check 全绿；
- 二进制默认工作区 `~/.org/workspace`（源码模式仍为仓库内 `demo-run/`）；
- 二进制运行 `--model deepseek` 需要 `z-ai-web-dev-sdk` 可达（scripted 默认模式无外联）。

---

## v0.3.0（2026-09-06）


运行时动力学收官：**影子晋升 / 静默更新检测 / N 版本冗余 / 三档补丁 / 多轮直连 / 暖移交**，
外加 69 个机制级测试与工具链 vendored 入库。

### 新增

- **影子晋升（金丝雀双跑）**（`hsl/runtime/promotion.hsl::canary_check`）：补丁版本合入后，
  旧版本源码自动归档（`<name>@<from>.hsl`）；候选与在岗版本在验收样本上同输入双跑
  （产物目录隔离），`(ok, coverage, valid, total)` 全一致 → `canary_confirmed`；
  任一指标分歧 → `canary_rollback`（归档源写回 + manifest 降版）。
- **静默更新检测**（`drift_check`）：当期评分卡 vs 基线
  （`registry/scorecards/baseline-<model>.json`）逐格对比，劣化超阈值（0.25）→
  `score_drift_alert` 审计事件；首运行自动建立基线。诚实边界：任务分布漂移同样触发，
  告警需人工复核归因。
- **N 版本冗余**（`redundant_dispatch`，`ORG_REDUNDANCY>=2`）：向实现来源多样的专家对
  镜像派单，产出一致记 `redundancy_compare agree=true`（置信度加成），分歧记健康度事件。
  计次口径 = 按真实执行（返工轮是第二次真实执行，同样触发对比）。
- **补丁变更分级闸门**（`merge_patch`，提议权与合入权分离）：
  - `knowledge`（规则行）：`check + smoke + 失败回滚`（v0.1.0 已有）；
  - `flow`（graph 拓扑关键词）：`full-fixture + 评测分不回退`（补丁后 coverage 低于在岗
    eval_score 即回滚）；
  - `capability`（`#[capability]` 注解）：仅用户可批准（`ORG_CAPABILITY_APPROVED=1` 环境门），
    拒绝/批准均留审计事件，被拒时补丁不触碰源码。
- **多轮直连**（`org ask --session <id> --turns "q1|q2"`）：会话账本跨轮持久
  （`runtime/sessions/<expert>/<session>.jsonl`）、逐轮记账、纪要回写。
- **暖移交通道**（`org handoff <expert> --task "..."`）：主控移交摘要 → 专家代答 →
  handoff 通道记账。
- **外部智能体导入线**（`hsl/adapters/bridge.hsl`）：三平台格式探测与注册表登记
  —— subagent JSON（Claude Code / Codex 式）、MCP server manifest、A2A agent card；
  每次导入是一条审计事件。v1 边界：登记 ≠ 在岗（协议翻译是路线图项）。
- **测试体系**（69 个，`bun test tests/`）：结构闸门（dhv check 全源 + 生成器出题与
  人工抽查逐字一致）/ README 走读（三连跑衰减曲线、工厂闸门、补丁与金丝雀、固化持久化、
  评分卡归因、journal→fixture、直连、暖移交、git 注册表链）/ 动力学点火（漂移告警、
  固化降级、Reject 重派、Escalate 仲裁返工、三档补丁闸门、N 版本冗余）。
- **CLI**：`org handoff` 子命令；`org ask` 支持 `--session/--turns` 多轮；help 文案同步。

### 变更

- **评分卡证据账本**：`evidence_count` 从「当期归因条数」升级为「跨运行累计」
  （`registry/scorecards/evidence-ledger.json` 单调增长）；cells 分数保持当期窗口聚合
  ——两种语义分表，静默更新检测的证据基础随运行增长。
- **固化降级语义收紧**（`maybe_degrade`）：热启动 + 命中率漂移时，除解冻最旧键外，
  同时把**本轮新冻结的键回退到观测态**（漂移期间学习降速，防污染）；执行顺序为
  先回滚后解冻（降级使表收缩，反向顺序会使 warm 边界偏移一位，漏删一个新冻结键）。
- **工具链 vendored**：dhv-ts 解释器入库 `toolchain/dhv-ts/`——克隆即跑，零环境依赖；
  `scripts/setup-hsl.ts` 与 `resolveDhv()` 均改为 vendored 优先（兄弟目录克隆仍兼容）。
- **dist/demo 快照扩容**：全叙事产物（out-{a,b,c,direct,handoff}）+ 评分卡基线 +
  evidence-ledger + 会话账本一并入库。

### 修复

- 评审测试暴露的边界：Escalate 仲裁返工轮的 review 轨道需第二条裁决（fixture 耗尽
  报错 → 现为返工语义的一部分）；补丁测试的判卷样本（全 valid）与补丁文本语法
  （注释追加，`|| true;` 拼接是 HSL 语法错误）。

### 兼容性

- `org run / demo / ask` 行为不变；`score` 的 evidence_count 数值变大（累计语义）；
  新增环境变量不改变缺省行为（`ORG_CAPABILITY_APPROVED` 缺省拒绝、`ORG_REDUNDANCY`
  缺省 1）。

## v0.2.0（2026-09-06）

仓库工程化：**HSL 源码单列 + 编译产物入库 + CI/CD**。

### 变更

- **源码重组**：全部 27 个 `.hsl` 源模块从仓库根目录迁入 `hsl/`（内核 `hsl/org.hsl` +
  13 个域目录），相对 import 链原样保持；CLI 入口路径与文档引用同步更新。
- **编译产物入库**：新增 `dist/` 目录——`org demo` 结束时自动导出三连跑全量快照
  （`out-{a,b,c}` run/events/journal/评分卡、registry 专家注册表与固化 memo、
  factory mint/patch 产物、runtime 复发计数）与 `git-chain.json`（资产层 git 历史
  快照；嵌套 `.git` 不入库，链条以数据形式保存）。
  克隆即得可校验完整状态：`bun cli/org.ts check` 28 模块全过（hsl/ 源 27 +
  dist/ 铸出专家 1），`org status` 无本地运行时自动读 `dist/demo`。
- **CI**（`.github/workflows/ci.yml`，push/PR）：setup bun → 工具链自动安装
  （`scripts/setup-hsl.ts`，幂等）→ `dhv check` 28 模块 → 三连跑冒烟 → `status` 冒烟 →
  产物上传 workflow artifact → **dist/ 有变化自动回写提交**（`[skip ci]` 防循环）。
- **CD**（`.github/workflows/release.yml`，tag `v*`）：同套校验 → 打包源码 tar.gz +
  dist zip → 创建 GitHub Release（发布说明取 CHANGELOG 对应版本段落）。
- **新增 `scripts/setup-hsl.ts`**：dhv-ts 工具链自动安装（克隆到兄弟目录、幂等、
  未来有依赖时自动 `bun install`），本地与 CI 共用。
- **布局语义**：`hsl/` 源码层（人写）；`dist/` 编译产物层（机器生成，与源码同库演进）；
  `demo-run/` 本地构建目录（git 忽略，含嵌套 git 注册表）。

### 兼容性

- `org run / demo / ask` 行为不变；`status / score` 默认工作区增加 dist/demo 回退；
  `check` 走查范围新增 `dist/`（跳过 `.git / node_modules / .hsl-runs / demo-run`）。

## v0.1.0（2026-09-06）

首个可运行实现：**P0 + P1 + P2 + P3 + P4（轻档）+ P5（单轮直连）+ P6（知识补丁）+ P7（归因聚合）+ P8（精确匹配档固化）** 的最小闭环。

### 新增

- **信封契约**（`hsl/contracts/contract.hsl`）：`TaskSpec -> Result<StatusReport, ExpertError>`、
  四态裁决 `Accept/Revise/Reject/Escalate`、契约锻造（预算水位 + 返工上限）。
- **主控内核**（`hsl/org.hsl`）：监督回路 graph（分解 → 批量澄清 → 路由 → 派单 → 过程审查 →
  汇总 → 资产沉淀），microkernel 事件拓扑，`org run` / `org demo` 可运行。
- **路由器**（`hsl/router/policy.hsl`）：A 内联 / B 复用 / C 生成 / D 暖移交 四路径判定（纯函数）。
- **专家工厂**（`hsl/factory/pipeline.hsl`）：规格提取 → HSL 生成 → `dhv check`（真实结构闸门，
  嵌套解释器子进程）→ fixture 验收（run.json ok + acceptance 覆盖率双条件）→ 入库登记（git 提交）。
  补丁合入流水线同闸门（check + smoke + 失败回滚 + 版本 bump + provenance）。
- **专家库**（`hsl/registry/manifest.hsl`）：manifest schema（interface/capabilities/eval/version/stats/provenance）、
  磁盘注册表（index.json + 每专家 manifest）、能力交集 + 语义粗排检索。
- **智能体池**（`hsl/pool/lifecycle.hsl`）：实例生命周期状态机（入编/待命/派单/审查/直连）、
  会话隔离、并发额度；v1 双执行车道（进程内静态专家 / 嵌套解释器磁盘专家 = 蓝绿）。
- **固化管线**（`hsl/runtime/crystallize.hsl`）：判定节点观测账本（跨运行持久化）、
  稳定计数 → 冻结（精确匹配档）、命中监控、降级通道、memo 资产落盘。
- **模型评分卡**（`hsl/models/scorecard.hsl`）：能力轴 × 任务类、证据分级归因聚合
  （verdict 率 / 预算遵守 / 固化命中，客观档权重 1.0）。
- **直连前台**（`hsl/pool/direct.hsl`）：`org ask`——事件上总线、独立记账、纪要回写。
- **事件溯源**（`hsl/runtime/journal.hsl`）：journal.jsonl + events.jsonl 双留痕、
  `org replay` 时间线重演。
- **外部导入适配**（`hsl/adapters/bridge.hsl`）：subagent/MCP/A2A 描述文件探测、登记
  （执行接线为路线图项，登记不等于在岗）。
- **能力三态策略**（`hsl/policy/capability.hsl`）：auto/confirm/deny × 编排/直连模式、
  审计事件、天花板调升（仅用户）。
- **示例专家**：`notice-parser`（手写成熟：机械节点 + 判定节点固化演示）、
  `record-validator`（工厂生成物录制 + 人工抽查存档，全机械节点，返工零模型成本）。
- **CLI**（`cli/org.ts`）：`run / demo / ask / status / score / replay / check` 七命令。
- **三连跑演示**（`org demo`）：1.6s 内完成「铸专家 → 复用+补丁 → 蓝绿验证」全叙事。

### 实测记录（scripted 模式，CI 可复现）

| 轮次 | 耗时 | 结果 | 关键事件 |
|:---|:---|:---|:---|
| run A | ~0.5s | 3/3 子任务，1 次返工 | 工厂 mint record-validator@1.0.0（过 dhv check + fixture 验收）；固化 2 条日期映射 |
| run B | ~0.5s | 3/3 子任务，1 次返工 | 零工厂（复用资产）；固化命中 4 次；意见复发 → 补丁合入 1.0.1（git 留痕） |
| run C | ~0.2s | 3/3 子任务，**0 返工** | 判定节点 5/5 全命中（**零模型调用**）；补丁版首验即收（蓝绿生效） |

model_calls 衰减曲线：**5 → 1 → 0**（固化改变成本结构的直接证据）。

### 对 HSL 上游的修复（详见 BUGFIXES.md）

- `Vec::iter_mut` 缺失于解释器内建方法面（check 过 / run 崩的静默断层；nova 示例即中招）
- `String::push(char)` 缺失（Rust 对等 API）

### 已知边界（诚实声明）

- 池化重档（私有记忆工作台、并发写隔离）未实现，仅轻档（manifest + 任务历史索引）
- 补丁仅知识档（静态资源/规则行）；流程补丁（graph 拓扑）与能力变更闸门是路线图项
- 固化仅精确匹配档；语义等价判定是开放问题
- 评分卡裁判档（影子对比）未采集；静默更新检测是路线图项
- mint_hsl 剧本与 `hsl/factory/stock/` 逐字一致（人工抽查存档）——「生成器同时出题又答题」
  的结构性风险由人工抽查机制兜底，抽检比例待定案
