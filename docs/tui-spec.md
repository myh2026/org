# ORG TUI 规格书 — v0.4.0「OpenCode 级前端」

> 参照系：OpenCode / Codex CLI / z-code 这类正经开源 agent 的终端界面排布。
> 目标：org 的产品级终端前端——不是调试工具，是**用户每天用来派单、审查、看资产**的主界面。
> 技术底座：ink@6 + react@19（已安装）+ bun。零原生依赖，Windows/macOS/Linux 全平台。
> 单二进制分发：`bun build --compile`（已验证可行，见下「分发」节）。

## 1. 布局（三区结构）

```
┌ ORG ─ Organization Harness ──────────────────────────────── v0.4.0 ─┐
│ ┌ 会话 (3) ─────┐ ┌ 线程 ─────────────────────────────────────────┐ │
│ │ ● 公告三连跑   │ │ you  抓取某站点近一周公告，输出结构化表格         │ │
│ │ ○ 直连·ask     │ │                                               │ │
│ │ ○ 演示 replay  │ │ org  任务分解 → 3 子任务                        │ │
│ │               │ │   ├ task#1 检索  [A 内联]                      │ │
│ │ 专家库 (3)     │ │   ├ task#2 解析  [B 复用] notice-parser        │ │
│ │ notice-parser │ │   └ task#3 校验  [C 生成]                      │ │
│ │ record-valid… │ │                                               │ │
│ │ notice-parse… │ │ ⚙ 工厂  record-validator@1.0.0                 │ │
│ │               │ │   规格 → 生成 → ✓ check → ✓ 验收 → 登记 git     │ │
│ │ 池            │ │                                               │ │
│ │ busy 1 idle 2 │ │ ◆ review  Revise · 覆盖率 0.80 < 0.95（第1次）  │ │
│ │               │ │ ◆ review  Accept · coverage 1.0               │ │
│ │ 固化          │ │                                               │ │
│ │ 命中 5 冻结 3 │ │ ✓ 汇总  交付物 3 · 资产 2 · model_calls 5→1→0   │ │
│ └───────────────┘ └───────────────────────────────────────────────┘ │
│ › 输入任务或 :命令…                          团队模式 · scripted · idle │
└──────────────────────────────────────────────────────────────────────┘
```

- **左栏（rail）**：三个可折叠分区——会话（历史 run）、专家库（registry index.json）、
  池与固化（runtime/recurrence.json + memos 计数）。`Tab / Shift+Tab` 切换聚焦分区，
  `j/k` 在分区内移动，`Enter` 选中（会话=加载其事件流重演）。
- **主区（thread）**：消息流。you/org 两种角色；事件以卡片渲染（见 §3）。
  自动滚动到底部；用户上翻后停止跟随，出现「↓ 回到底部」提示（OpenCode 行为）。
- **底栏（input + status）**：单行输入（多行粘贴自动展开成 3 行内的缓冲），
  右侧状态段：模式 · 模型 · 引擎状态（idle/running+计时）。
- 窄终端（<100 列）自动隐藏左栏；<60 列显示极简模式。最小可用宽度 40 列。

## 2. 输入协议（OpenCode/Codex 风格）

| 输入 | 语义 |
|:---|:---|
| 任意文本 + Enter | 团队模式派单（= `org run --task <text>`） |
| `?notice-parser 字段映射规则?` | 直连 ask（首个 `?` 后到第二个 `?` 前是专家名，余下是问题） |
| `:demo` | 三连跑演示（A→B→C 依次进同一会话流） |
| `:replay <run-dir>` | 加载历史 run 的事件流（重演时间线） |
| `:status` / `:score [axis]` | 侧栏刷新 / 展开评分卡卡片 |
| `:theme <name>` | 切换主题（org-dark / org-light / paper） |
| `:help` | 快捷键与命令帮助浮层（`?` 同效） |
| `:quit` / Ctrl+C | 退出（运行中先确认：再按一次 Ctrl+C 取消运行并退出） |

全局键：`Esc` 取消当前运行（SIGTERM 子进程，线程内记 `run_canceled` 卡片）；
`g/G` 回顶/回底；`Ctrl+L` 清屏重绘。

## 3. 事件卡片（线程内的可视单元）

引擎事件流来自两个文件：`events.jsonl`（结构化事件）与 `journal.jsonl`（人读期刊，
`ts|seq|phase|actor|action|detail` 管道分隔）。卡片模型 = 合并两者按 seq 排序。

| 卡片 | 触发事件 | 渲染要点 |
|:---|:---|:---|
| 任务卡 | `decompose` | 子任务列表 + 路由徽标（A 内联 / B 复用 / C 生成 / D 移交，四种颜色） |
| 工厂卡 | `factory_*`（mint_spec/mint_hsl/mint_check/mint_exam/mint_register） | 五步横向进度条 stepper，当前步高亮；check 失败整卡变红并显示诊断摘要 |
| 审查卡 | `review` / journal `verdict` | 四态徽标：Accept=绿 · Revise=琥珀 · Reject=红 · Escalate=紫；附覆盖率/预算数字与 remedy 意见 |
| 固化卡 | `crystallize_*` | 冻结（❄）与命中（⚡）计数；「零模型调用」强调色 |
| 补丁卡 | journal `patch` | 版本 bump 1.0.0 → 1.0.1 + git 短 sha |
| 直连卡 | `ask` 运行 | 专家名 + 问题 + 纪要回写提示 |
| 完成卡 | run 结束 | run.json 汇总：交付物/资产/model_calls/revises/耗时；失败时红底错误摘要 |
| 系统卡 | bridge 自身 | run_canceled / 工具链缺失 / 非 TTY 警告等 |

徽标统一风格：`[A 内联]` 方括号 + 单字母 + 短词，颜色语义全局一致（路由四色、裁决四色）。

## 4. 引擎桥（lib/engine.ts — CLI 与 TUI 共用）

```ts
export interface RunOptions {
  entry: "org" | "direct";        // org.hsl / pool/direct.hsl
  task: string;
  workspace: string;              // 默认 <repo>/demo-run
  model: "scripted" | "deepseek";
  fixture?: string;               // 默认 fixtures/run-notices.json
  outDir?: string;                // 默认 <workspace>/out-<ts>
  expert?: string;                // direct 模式必填
}
export interface RunHandle {
  runId: string;
  events: AsyncIterable<EngineEvent>;   // 归一化事件（卡片模型直接消费）
  cancel(): Promise<void>;              // SIGTERM 子进程树
  wait(): Promise<RunResult>;           // 解析 run.json / report.md
}
export function startRun(opts: RunOptions): RunHandle
```

- 主路径：spawn `bun <dhv-ts> run <entry> --workspace … --task … --model … --fixture … --out …`
  （与 cli/org.ts runHsl 同参；`bun` 解析顺序：$BUN → process.execPath 是否可执行 ts → PATH 查找）。
- **编译二进制 fallback**：PATH 无 bun 时，动态 import vendored dhv-ts 的 main.ts
  （先设 `process.argv`，跑完恢复——dhv-ts 是顶层读 argv 的 CLI 脚本），stdout 捕获逻辑相同。
  该路径用环境变量 `ORG_FORCE_INPROC=1` 可强制，便于 CI 测试。
- 事件流实现：启动前清点 `out/events.jsonl` 行数，轮询（150ms）tail 增量行 → JSON.parse →
  归一化；journal.jsonl 同法。进程退出后 flush 尾部并 `wait()` 解析产物。
- 工具链解析复用 cli/org.ts 的 resolveDhv 顺序（$DHV_TS → 兄弟目录 → 仓库内 vendored）。

## 5. 会话（sessions）

- 会话 = 一次 run 的产物目录（out-*）。启动时扫描 `<workspace>/out-*` 有 run.json 者，
  按 mtime 倒序列入左栏；当前运行标记 ●，历史 ○。
- 选中历史会话 = `:replay` 语义（读 events.jsonl + journal.jsonl 重演，秒开、不重跑）。
- `:demo` 把 A/B/C 三次 run 依次挂到同一会话流（「公告三连跑」），体现成本衰减叙事
  （model_calls 5→1→0 是 ORG 的招牌数字，完成卡要醒目展示）。

## 6. 主题

三主题，语义色全局统一：
- **org-dark**（默认）：底 #0C1210 系，正文 #D6E4DC，强调 emerald 系（品牌色），琥珀/红/紫按语义。
- **org-light**：纸感浅底，同语义色系加深。
- **paper**：米白底 + 全灰阶 + 仅裁决徽标有色（打印友好）。
主题 = 一份 token 表（bg/fg/dim/brand/ok/warn/err/info/badgeA..D/verdictX..），组件只消费 token。

## 7. 工程与分发硬要求

1. 零原生依赖；Windows 兼容（path 用 node:path，不留 POSIX-only API）。
2. **冒烟测试**：`tui/smoke.ts` 用 ink 的 `render(<App/>, { stdout: mock })` 离屏渲染一帧，
   断言含关键 token（如 "ORG"、"专家库"），`bun run tui:smoke` 退出码 0——CI 必绿且不需要 TTY。
   同时覆盖 `ORG_FORCE_INPROC=1` 的 in-process 桥路径。
3. `package.json` 增加 `"tui": "bun tui/main.tsx"`、`"tui:smoke": "bun tui/smoke.ts"` 脚本。
   （cli/org.ts 的 `tui` 子命令由主会话接线，TUI 代理不要改 cli/org.ts。）
4. **分发**（主会话负责 workflow；TUI 代理只需保证入口干净）：
   `bun build --compile --outfile dist-bin/org-<target> cli/org.ts` 可用
   （已验证 ink@6 + compile + 交叉编译 windows-x64/darwin-arm64 均通过）。
   入口不得在 import 期做副作用渲染（render 必须在 main 函数内）。
5. React 19：组件用函数组件 + hooks；状态用一个 `useReducer` 中心 store（不引额外状态库）。
6. 文件清单（建议）：
   ```
   tui/main.tsx        入口（参数解析 --workspace --model，render(<App/>))
   tui/app.tsx         三区布局 + 键盘路由
   tui/theme.ts        三主题 token 表
   tui/store.ts        useReducer store（sessions/panel/thread/status/input）
   tui/components/rail.tsx         左栏三分区
   tui/components/thread.tsx       消息流 + 卡片
   tui/components/cards.tsx        八类事件卡片 + 徽标
   tui/components/input.tsx        输入栏（:命令解析）
   tui/components/status.tsx       状态栏 + 帮助浮层
   tui/smoke.ts        离屏冒烟
   lib/engine.ts       §4 桥
   lib/events.ts       事件类型与归一化
   ```
7. 文案语言：界面主体中文（与 ORG 仓库一致），徽标/键位表可用英文短词。

## 8. 验收标准（DoD）

- [ ] `bun run tui` 打开三区布局；输入「抓取某站点近一周公告，输出结构化表格」回车后，
      事件卡片按序流动，工厂 stepper 五步走完，审查出现 Revise→Accept，完成卡显示
      model_calls 5（scripted run A）。
- [ ] `:demo` 三连跑在同一流内完成，末卡可见 5→1→0 衰减与 git 短 sha。
- [ ] `:replay out-a` 秒开历史会话；左栏专家库/池/固化数字与 dist/demo 一致。
- [ ] `?notice-parser …?` 直连卡正常（scripted fixture）。
- [ ] `bun run tui:smoke` 0 退出（含 in-process 桥路径）；窄终端降级可用。
- [ ] `bun test tests/` 仍 69/69 全绿（不得破坏现有测试）。
