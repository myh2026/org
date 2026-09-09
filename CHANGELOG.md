# CHANGELOG

## v0.4.9（2026-09-09）

**`org web` GUI 工程化重设计（Codex 风终端美学）+ 正常 Agent 功能补全
（issue #12）**。GUI 从「组织驾驶舱」深琥珀风改为安静致密的工程终端风：
近黑 zinc 色板、1px 发丝边框、等宽 chrome、tmux 式底部状态栏、`❯` 提示符
转写行（无气泡）、运行日志终端窗口、braille 旋转指示；无渐变无辉光，低饱和
功能色（emerald=运行/在线，red=错误），琥珀仅作状态栏品牌微标记。

### 新增

- **停止生成（`POST /api/abort`）**：SIGKILL 当前 spawn 车道子进程 ——
  账本写入发生在 hsl 运行收尾，进程被杀即该轮不落账本（干净丢弃）；SSE 端
  发 `error{aborted:true}`，GUI 呈现「■ 已停止 · 本轮未落账本」+ 已浮出的
  部分正文；`Esc` 快捷键；空闲时 abort 返回 `ok:false` 人话（不误杀，
  进程内车道同样人话告知）；
- **会话管理端点**：`DELETE /api/session/<E>/<S>`（删账本文件 = 删会话，
  幂等 404）· `PATCH /api/session/<E>/<S>`（body `{to}`，同专家 mv 账本，
  目标已存在 409、非法名 400）—— GUI 侧栏行内重命名 + 两步删除确认；
- **GUI 功能补全**：失败重试（错误块「重试」按钮，失败轮不落账本安全重发）·
  导出会话 Markdown（含流水线头信息）· 模型切换（scripted/deepseek 分段
  控制）· 智能滚动（用户在底部才跟随 + 「回到最新」悬浮按钮）· 会话/专家
  左栏计数徽标 · 空态终端 banner（engine/workspace/expert/session/快捷键）；
- **`GET /api/status` 增返 `model`**：GUI 初始值对齐 `org web --model`；
- **GUI 转写式消息流**：用户消息 = `❯` 提示符行；助手消息 = `org · 专家 ·
  turn · tokens · 耗时` 元信息行 + 正文 + run log 终端窗口（`▸` 折叠、行
  计数）；运行中 = braille 旋转 + 阶段行 + 逐行日志。

### 修复

- 内联 JS 转义纪律回归测试：模板字符串内 `\n` 双写（此前踩坑：注释被劈开
  导致整段 script 语法错误）；GUI 单页新增内联 JS `new Function` 解析断言
  之外的机制级要素断言（statusbar/modelSeg/abort/❯/jumpBtn）。

### 并存

- 旧 `POST /api/ask`（JSON 整轮）保留（兼容 API 消费方），GUI 走流式；
- SSE 客户端意外断开仍不中止运行（账本是事实源）—— 显式停止才走
  `/api/abort`（fire-and-poll 消费方不受影响）。

## v0.4.8（2026-09-08）

**`org web` 对话流式：`POST /api/ask-stream` SSE 端点 + GUI 渐进渲染（issue #11，
v0.4.7 已知边界「ask 长任务无流式」补齐）**。deepseek 真实模式下长回答不再
黑盒等整轮 —— 运行配置（子进程 banner/入口/模型/工作区行）到达即推送，等待
期间流水线阶段轮换可见，回答正文逐行浮出。

### 新增

- **SSE 事件协议**（`event: X\ndata: {json}` 帧）：`open`（请求回显 + 排队
  状态）→ `start`（串行队列轮到本轮）→ `stage`（2.6s 轮换 direct.hsl 真实
  阶段：能力核对 → 注册表寻址 → 会话史装载 → 模型网关 → 记账回写）→
  `log`（子进程 stdout 逐行实时）→ `done`（AskOutcome 整体）/ `error`（人话
  message）。客户端断开不中止运行（账本是事实源，轮次照常落盘）；
- **spawn 车道增量读**：`askStreamOnce` 用 `ReadableStream.getReader()` +
  行缓冲泵逐行回调（跨 chunk 半行拼接保真）；进程内车道
  （`ORG_FORCE_INPROC`）降级为 stage+done 两类事件；
- **GUI 渐进渲染**：等待气泡 = 阶段轮换行（琥珀光标呼吸）+ 运行日志终端
  折叠区（逐行追加 · 计数徽标）+ 回答正文逐行浮出（`[direct]` 头行触发、
  `[ctx]` 行止笔，光标跟随）；完成态消息附完整运行日志折叠区与观测元数据行
  （turn/tokens/耗时/ctx meter）；
- **HTTP 错误人话化**：流建立前的验证类 400 由前端读 JSON body 呈现具体
  原因（不再是笼统 HTTP 400）。

### 修复

- **`org web --model` 失效**（v0.4.7 引入）：`/api/ask` 的 model 只看请求体
  缺省 scripted，服务级 flag 被忽略。现改为回落链：请求体显式传 > 服务级
  （`org web --model deepseek`）> scripted；`open`/`start` 事件回显生效值。

### 并存

- 旧 `POST /api/ask`（JSON 整轮）保留（兼容 API 消费方），GUI 已切流式。

### 已知边界（本版新增口径）

- 事件总线 WebSocket 拓扑观测（issue #10 第 4 点）仍未做；`stage` 事件是
  流水线阶段的推演轮换（等待期 liveness 指示），非逐阶段真实回执 —— 真实
  逐阶段事件需要 dhv-ts 事件总线透传（跨仓库项）；
- token 级流式（模型输出逐 token 推送）受 dhv-ts `$host.llm` 非流式调用
  约束 —— 当前粒度 = 子进程 stdout 逐行（回答正文整段在模型返回后一次
  打印）。

### 测试

- `tests/web.test.ts` 新增 5 用例：SSE 事件全链（open/start/log*/done +
  账本落盘 + 无 error）、第二轮 ctx 单调增长、验证类 400（流建立前）、
  GUI 单页 SSE 消费要素、model 回落链（第二服务 `srv-level-flag` 判别）；
  全套 123/123（`bun test`，35s）。

## v0.4.7（2026-09-08）

**Web GUI 原型：`org web` 子命令（issue #10 路线图 1-3 点）**。Bun.serve 起
零依赖轻量 HTTP（默认端口 4600，`--port N` 覆盖，避开本机 3000/3030/5000），
单页内联 HTML（无静态文件 / 无第三方依赖，原生 fetch 交互，深色琥珀主题）。
GUI 只是薄渲染层 —— 逻辑全部复用 CLI 同一代码路径；orgAgent 图形界面长在
产品仓库里。

### 新增

- **`org web [--port N] [--workspace DIR]`**（web/entry.ts，CLI 进程内
  import，与 tui 同模式）：三区布局 —— 左侧专家卡（★ 保留 / ○ 候选 /
  import 徽标）+ 会话侧栏（id / 轮数 / 相对时间 / 首问预览，点击装载历史）；
  主区对话视图（消息气泡 + 观测元数据行 tokens / 耗时 / `[ctx]` 窗口计量
  进度条）+ 底部输入框（选专家 + 提问 + 新会话）；顶部 org status 摘要条。
- **只读面**：`GET /api/status`（专家清单 loadRegistryIndex + 会话上下文
  占用 listContextUsage，与 org status 同数据源；读命令遵循 demo-run 活
  数据优先 / dist/demo 快照兜底）· `GET /api/sessions?expert=X`（会话列表）·
  `GET /api/session/<E>/<S>`（逐轮 question/answer/tokens/ctx_tokens）。
- **账本健壮解析**（parseLedgerRaw）：org 的 append_session 用 format!
  裸插值，多行 answer 带字面换行落盘破坏逐行 JSON —— 先按 `\n{"turn":`
  记录边界重组，逐条先试标准 JSON.parse，失败再用字段定长布局的修复式
  正则兜底（兼容 v0.4.6 前存量坏账本）。
- **交互面 `POST /api/ask`**：进程内直连（DIRECT_ENTRY + ORG_ASK_EXPERT/
  SESSION/QUESTION env + expertFixtureOf 剧本自动发现 + dhvRun 双车道，
  不 spawn CLI 自身）；stdout 解析 `[direct]` 行 → answer 正文（多行，
  止于 `[ctx]` 行）→ `harness 返回 Ok（Y ms）`；响应
  `{ok, answer, tokens, ctxLine, durationMs, turn, logs}`；ask 单飞队列
  （串行锁）防并发互踩 workspace/out-ask；model 缺省 scripted（占位
  剧本秒回）。
- **安全**：服务只听 127.0.0.1（本地 GUI 原型）；expert/session 名白名单
  正则（防路径穿越）。
- 测试：tests/web.test.ts 14 用例（端到端：页面/状态/会话列表/ask 两轮
  ctx 单调增长/防呆 400/404；纯函数：账本双形态解析、stdout 单/多轮形态
  解析）；全套 118 用例全绿（原 104 零回归）。
- 文档：README「Web GUI 原型」段落 + 快速开始 `org web` 步骤。

### 已知边界

- issue #10 路线图第 4 点（事件总线 WebSocket 拓扑观测高亮）未做。
- ask 长任务无流式（SSE/流式回传是后续项；当前一次性响应）。

## v0.4.6（2026-09-08）

**B 路径执行面：导入 harness 被任务派单真实执行（issue #6）**。`org import`
注册的 harness 此前只能直连问答（`org ask`）——任务派单（`org run` / demo
全叙事）命中 B 路径时，`run_expert` 硬编码 `registry/experts/` + `factory/fixtures/`
约定寻址，无视注册表登记的 `entry`/`fixture` 字段，导入专家命中即
「入口文件不存在」。本版修复后：**导入的 harness 经嵌套解释器车道被
find_reusable 真实派单执行，交付物经 deliverable 契约流转下游子任务**。

### 修复

- **派单寻址注册表优先**（pipeline.hsl `resolve_dispatch_paths`）：按名
  加载磁盘注册表 → 命中取 manifest 登记的 `entry_path`；未登记回退约定
  车道（mint Exam 前未注册场景兼容）。`run_expert` 全调用面（B 路径 Reuse /
  C 路径 Generate / D 路径 WarmHandoff / 补丁 smoke）统一走解析器。
- **manifest.fixture 字段二相解析**（`run_fixture_of`，按 source 分相）：
  `import` → fixture 字段即嵌套 run 剧本（tracks 形态）直接可用；
  `factory` → fixture 字段是验收样本（TaskSpec 形态），run 剧本走约定
  `factory/fixtures/<name>.fixture.json`。语义错配会把样本当剧本传——
  金丝雀 / N 版本冗余同规则修复（promotion.hsl）。
- **工单序列化卫生**（pipeline.hsl `spec_to_json`）：goal / acceptance /
  payload / feedback 一律 `json_escape` 后按 JSON 字符串嵌入。原先 payload
  裸插值——纯文本负载（fetch/parse 角色的 raw 材料）会嵌坏整个
  current-spec.json，嵌套 harness 报「工单不是合法 JSON」。字符串形态与
  裸 JSON 嵌入在 `$host.json.fields` 解析后字段值同构，既有 harness 的
  `JSON.parse(payload)` 语义不变。
- **deliverable 契约**（org.hsl `read_report_artifact`）：磁盘车道专家可在
  acceptance 工件声明 `deliverable` 字段（如 parse 专家的记录数组）——下游
  子任务的 payload 从这里机械编接（`work/parse-output.json`）；缺省保持
  占位符（诚实边界：不编造数据）。
- **mint Exam 显式寻址**：验收阶段新专家尚未注册，若注册表恰有同名导入
  专家，按名解析会劫持寻址跑错文件——Exam 改为显式约定车道。

### 新增

- 测试：tests/import.test.ts 新增「B 路径执行面」组 3 用例（端到端
  派单执行 + 交付物流转 / 工单序列化卫生 / uses 计数跟进）；全套 104
  用例全绿。
- 文档：README「B 路径执行面」段落（磁盘车道信封契约：输入 current-spec.json /
  输出 acceptance.json + deliverable 字段）。

## v0.4.5（2026-09-08）

**剧本联动：导入即能用（零摩擦消费链）**。`org import` 自动生成占位剧本
（`registry/harnesses/<name>.fixture.json`：`direct:<name>` 3 轮 +
`handoff:<name>` 1 轮轨道）；`org ask` / `org handoff` / TUI `?专家`
不传 `--fixture` 时按 manifest.fixture 字段自动发现 —— 导入的 harness
零参数即可 scripted 问答（记账 / 会话账本 / `[ctx]` 计量全链路可验证），
真实回答切 `--model deepseek`。显式 `--fixture` 优先（fixtureExplicit 语义）。

### 新增

- **占位剧本生成**（engine.ts importHarness）：direct/handoff 双轨道
  随导入落盘；manifest `fixture` 字段登记相对路径（导入命令输出含剧本行）。
- **剧本自动发现**（engine.ts `expertFixtureOf`）：CLI ask/handoff 与
  TUI 直连（startRun direct 路径）共用；自动发现时打印 `ℹ 使用导入剧本 …`
  提示（含 deepseek 切换指引）。
- **CLI `--fixture` 显式语义**（fixtureExplicit）：显式传参优先于自动发现
  —— 用户显式指定不被静默覆盖。
- 测试：tests/import.test.ts 新增「剧本联动」组 4 用例（剧本生成/零参数
  ask/handoff 同规则/显式优先）；全套 101 用例全绿。

## v0.4.4（2026-09-08）

**工具库治理第三动作 `org import`（导入你自己的 harness）+ 上下文窗口计量（Codex 风格）**。
用户不再只能消费系统铸出的专家——自己的 .hsl harness 经 check 闸门直接入工具库
（导入即保留，B 路径自动复用立即可用）；直连会话的上下文占用随轮次增长，现在
每轮可见（meter 计量条 + 事件上总线 + status 汇总）。

### 新增

- **`org import <file.hsl>`（导入用户 harness）**：
  - 质量闸门：`dhv check` 必须绿——坏 harness 拒绝入库（工具库不收坏件）；
  - 入库三件套：复制源文件到 `registry/harnesses/<name>.hsl`（可追溯）+
    `registry/index.json` 条目 + 每专家副本（与 keep/drop 双写形态一致）；
  - 治理语义：`source=import · retained=true`——导入即保留（区别于 factory
    候选），`find_reusable` 的 B 路径判据 `source != "factory" || retained`
    立即命中；`eval_score=0.0`（诚实边界：导入 ≠ 已验证）；
  - 元数据自动提取：描述取文件首个 `///` 文档注释；能力扫描
    `#[capability(…)]` 注解（去重保序）；`--name / --description /
    --capability` 显式覆盖；
  - git 留痕：`import <name>@0.1.0 (user harness)`（与 mint/patch/keep 同链，
    增长率账本的一部分）；
  - 防呆面：重名拒绝（同名专家需改名或先 drop）、非 .hsl 拒绝、非法名拒绝
    （`^[a-z][a-z0-9-]*$`，与专家名同域）、空文件拒绝；
  - TUI 同构命令 `:import <file.hsl> [--name N]`（通知 + 工作区刷新 + 帮助
    浮层同步）。
- **上下文窗口计量（Codex 风格，`[ctx]` meter）**：
  - `hsl/pool/direct.hsl`：`estimate_context`（系统提示含会话史 + 本轮问答，
    chars/3 近似口径——与既有 `estimate_tokens` 同源）；每轮问答后打印
    `[ctx] 窗口占用 ▓░░ 8.4k/131.0k（6.4%）（N 轮累计）`（整数运算千分数，
    12 格 meter；GLM-4.5 窗口 128k tokens）；会话账本行新增 `ctx_tokens`
    字段（additive，向后兼容）；`DirectSession` 新增 `ctx_tokens`；
  - 事件上总线：`direct_ctx` journal 事件（detail 字符串
    `expert/session turn=N ctx=N window=N`，与既有事件同构）——知情权
    不可绕，TUI / replay / status 均可消费；
  - TUI：直连卡实时渲染 meter（`direct_ctx` 事件驱动，store 新增
    RE_CTX 解析 + 卡片 `ctxTokens/ctxWindow/ctxTurn` 字段）；
  - `org status`：按会话汇总上下文占用（每会话一行：轮次 · 记账 tokens ·
    ctx meter）；
  - `lib/engine.ts`：`CONTEXT_WINDOW_TOKENS` / `estimateTokens` /
    `contextUsageOf` / `listContextUsage` / `renderContextMeter`（CLI 与
    TUI 共用计量基础设施）。
- 测试：`tests/import.test.ts` 13 个机制级用例（导入数据面 / 元数据面 /
  治理联动 / 防呆面 4 桩 / 上下文计量 5 桩），全套 97 用例全绿。
- 文档：README 工具库治理升级为三动作（import/keep/drop）+ 上下文窗口
  计量小节；快速开始加入 import 与 [ctx] 示例；测试徽章 97。

## v0.4.3（2026-09-08）

**工具库治理：用户选取保留（org keep / org drop）+ 注册表写盘模型系统性修复 + TUI 直连车道修复**。
工厂产出从「自动入库即资产」升级为「候选 → 用户选取 → 转正」：B 路径自动复用只命中
用户保留的 harness，选取动作进 git 账本（与 mint/patch 同链）。配套修复注册表写盘的
三处静默覆盖（版本回退 / uses 回退 / provenance 洗掉）与 TUI 直连 env 泄漏。
详见 [BUGFIXES.md](BUGFIXES.md) B-9 / B-10 / B-11 / B-12。

### 新增

- **用户选取保留（工具库治理核心特性）**：
  - `ExpertManifest.retained` 字段：factory 产出默认候选（false）；manual/import
    存量默认保留；旧注册表无该字段时加载默认 true（向后兼容）；
  - `Registry::find_reusable`（B 路径专用检索）：只命中保留资产——未保留候选
    不参与自动复用（显式寻址 `?专家` 与 C 路径记忆化派单仍可用，诚实边界）；
  - CLI：`org keep <expert...>` / `org drop <expert...>`——翻转 retained +
    index.json 与每专家副本双写 + git 提交留痕（`(user curation)`）；无参时
    列出注册表（★/○ 可见）；dist/demo 入库快照只读守卫；
  - TUI：`:keep <name>` / `:drop <name>` 命令（无参作用于专家栏选中项）；
    专家库行标记 ★ 保留（绿）/ ○ 候选（琥珀）；帮助浮层同步；
  - `org demo` 新增 K 相位：run A 铸出候选后「用户选取转正」（scripted 演示
    自动全选，真实用户用 `org keep` 挑选）——叙事从「铸专家 → 复用」升级为
    「铸候选 → 选取 → 复用」，git 链从三提交变四提交
    （template → mint → **keep** → patch）；
  - `org status`：注册表行加 ★/○ 与 retained/candidate 标记 + 候选计数提示。
- **uses 计数器（修复性新增）**：`used()` 首次接线——磁盘态增量
  （`note_expert_use`：load → +1 → flush），B 复用 / C 生成（含记忆化重派）/
  D 暖移交三类派单全部计数；实测三连跑 `notice-parser uses=3` /
  `record-validator uses=5`。
- **CJK 语义亲和**：`goal_words`（B 粗排：空格词 + 二元滑窗）与 `duty_words`
  （D 闸门：空格词 + **三元**滑窗——2 字杂散重合不触发误移交）。中文任务目标
  此前在 `split(" ")` 下是单 token，词面重合恒 0（D 暖移交对中文结构性失效）。

### 修复

- **B-10 TUI 直连 env 泄漏（严重）**：bun 子进程车道从未合并 `envExtra`
  （ORG_ASK_EXPERT 等）→ TUI `?专家 问题?` 在有 bun 的机器上必然失败；
  修复 `Object.assign(env, envExtra)`（双车道同构，B-8 同族教训）。
- **B-11 provenance 只写不读**：加载侧补齐 `PatchRecord` 解析——任何
  load→flush 往返（note_use / keep）不再洗掉补丁历史；`json_escape`
  序列化卫生（description 含引号/反斜杠/换行时注册表 JSON 不再损坏——
  deepseek 真实模式的关键加固）。
- **B-12 uses 计数 + 注册表写盘模型**：merge_patch / canary 回滚 / bridge 导入
  统一「磁盘新鲜态合入 + 保留磁盘最新 uses」；org mint 注册改 `upsert_memory`
  （内存可见、磁盘由 register_expert 写）；修复两处静默覆盖（版本回退、
  uses 回退）。
- **B-9（上游）dsh 假演示**：HSL 仓库 workspace 以 post-fix 状态入库导致
  README 快速开始为假绿灯——上游已恢复 bug 版 + run-all.ts 副本隔离 +
  行为断言（详见 BUGFIXES.md B-9 与上游 Issue）。
- **`org demo --workspace` rmSync 脚枪**：`assertSafeResetWorkspace` 守卫——
  目标目录非空且不含 org 工作区标记（registry/raw/out-*/.git）时拒绝整目录
  删除（此前指错目录会静默删光）。
- **`native typescript` 块实为纯 JS**：块内类型注解（`const x: string[] =`）
  报 `Unexpected token ':'`——文档与命名误导（见 BUGFIXES 注记与上游 Issue）。

### 测试

- 84 个机制级测试（原 71 + 新增 13）：`tests/keep.test.ts`（10 个：数据面
  翻转/git 留痕/防呆、路由面 C 记忆化 vs B 复用往返、序列化卫生）+
  `tests/demo.test.ts` 新增「用户选取保留」组（retained 落盘、B 通道派单、
  uses 曲线）+ git 链断言升级四提交。


## v0.4.2（2026-09-08）

**HSL 实测回推：内建方法面补齐 26 个 Rust 对等方法 + S-19 静态断层预警；CLI 实测修复**。
对 HSL（vendored dhv-ts）做了一次系统实测（逐方法探针），把 B-1 类「check 过 / run 崩」
断层从两个方向收口：运行期补齐方法面、check 期新增预警。详见 [BUGFIXES.md](BUGFIXES.md)
B-6 / B-7 / B-8。

### 新增

- **HSL 内建方法面（B-6，`toolchain/dhv-ts/src/builtins.ts`，vendored 0.2.58）**：
  - Vec 迭代器 10 个：`find` / `filter_map` / `flat_map` / `flatten` / `count` / `min` /
    `max` / `zip` / `chain` / `step_by`（`min`/`max` 空为 None、同构 Ord）；
  - Vec 变形 5 个：`reverse` / `dedup`（连续重复）/ `retain` / `truncate` / `chunks`；
  - String 7 个：`split_once` / `rsplit_once`（返回 `Option<(before, after)>`，可
    `Some((k, v))` 直接解构）/ `clear` / `truncate` / `retain` / `insert` / `remove`；
  - HashMap 1 个：`iter`（(K, V) 二元组流）；
  - Result 2 个：`unwrap_or_else` / `unwrap_err`；Option 1 个：`and`（补齐同族对称）；
  - 复现探针入库：`hsl/probe/probe10.hsl`（25+ 断言全绿）。
- **S-19 静态预警（B-7，`toolchain/dhv-ts/src/checker.ts`）**：注解为
  String/Vec/HashMap/Option/Result 的绑定调用方法面之外的方法名 → check 期 warning
  （带位置与运行期报错预告）—— B-1/B-6 类断层的首个静态暴露面；负样本探针
  `hsl/probe/probe10-negative.hsl`（3 warning / 0 error，CI 门禁语义不变）。

### 修复

- **`org score --axis`**：cell 为 `能力轴|任务类`，现在两侧任一命中即保留（此前只匹配
  能力轴前缀，README 示例轴名拼错时沉默输出空列表）；空结果列出真实可用轴与任务类；
  README 示例改为真实存在的 `structured_extract`；
- **进程内车道输出保真度（B-8，`lib/engine.ts`）**：`ORG_FORCE_INPROC=1` 时 stdout
  捕获字节级还原（空行与结尾换行不再丢失）——同一命令双车道输出 diff 仅剩
  run_id/耗时类时变字段；
- **`org check` 模块清单稳定**：walker 跳过集合补 `demo-run-tests` / `out-ask`
  （本地测试工作区不再使模块数 32 → 48 漂移）；
- **工作区模板只读守卫**：`--workspace demo-ws`（模板目录本身）现在会被拒绝——
  实测实录该用法会把固化观测账本写回模板，使后续 `org demo` 三连跑衰减曲线
  5→1→0 静默漂移为 1→0→0（`lib/engine.ts` `assertWorkspaceNotTemplate`，
  CLI 报错退出 2；probe9 头注释补正确运行方式）。

### 变更

- 版本联动：ORG 0.4.1 → 0.4.2（package.json / cli / tui frame / tui 冒烟断言 /
  README 徽章）；vendored dhv-ts 0.2.56 → 0.2.58（包版本对齐代码内已含的 0.2.57 系
  修复并叠加本次方法面补齐）。

### 兼容性

- 无破坏性变更：方法面为纯新增（与既有 ORG 源码零冲突，69 测全绿）；S-19 为
  warning 级（退出码与 CI 门禁不变）；score/check 行为变化仅限空结果与本地
  工作区口径。

## v0.4.1（2026-09-07）

**TUI 事件流过滤 `:filter` + 发布资产官方 sha256 校验和**。

### 新增

- **`:filter` 事件流过滤**（`tui/`）：`:filter 裁决` 只看裁决卡，类目 `任务 / 分解 /
  工厂 / 裁决 / 直连 / 汇总 / 动态`（动态 = 固化 / 补丁 / 评分卡）；接受中文标签与
  英文键（`review` 等），空参复位为全部，未知类提示合法类目；
  - 过滤是**视图偏好**：不随 run / 清屏 / 重演重置（与终端 pager 习惯一致）；
    system 提示卡恒可见（报错不因过滤丢失）；过滤态在状态栏显示 `filter=<类>` 徽标；
    匹配为空时给出复位引导行；
  - `--print` 模式支持视图类命令：`org tui --print --demo ":filter 裁决"` 一帧出图；
  - 冒烟测试 +9 断言（共 29）：过滤归集、渲染徽标消失、复位恢复、偏好跨 run 保持、
    `parseFilterArg` 四态（中文 / 英文 / 空参 / 未知）；
- **发布资产 sha256 校验和**（`.github/workflows/release.yml`）：binaries job 每平台
  zip 生成 `.sha256` 旁车，publish job 源码包 / dist 同规格 + `org-checksums-src.txt`
  汇总——下游可离线验证下载完整性（官网下载卡自动探测旁车并展示）。

### 变更

- TUI 冒烟版本断言随版本号联动（v0.4.1）。

### 兼容性

- 无破坏性变更；`:filter` 为纯新增命令，老会话 / 重演 / 二进制分发音容不变。

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
