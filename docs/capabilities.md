# ORG 能力矩阵 —— 主 Agent 150 项 / 专家 Agent 25 项对照（v0.5.4 底稿 · 持续增补至 v0.5.16）

> 本文是**毕业论文的能力对照底稿**：把 ORG 当前实现（v0.5.4，357/357 测试全绿）
> 对照「桌面 Agent 主 agent 应有的 150 项能力」（十大类）与「专家 agent 应有的
> 25 项共同能力」逐项给出状态、实现位置与诚实边界。三态标记：
> **✅ 落地**（有实现 + 有测试 + 有操作入口）/ **🟡 部分**（有实现但覆盖面
> 有限或入口不完整）/ **⬜ 未做**（路线图项）。
>
> 结论先行：ORG 的差异化不在「会写代码」，而在**资产化治理**（生成过闸门、
> 任务沉淀、固化降本、能力/成本/审批三层治理）——150 项清单中 ORG 在
> 治理类（十、四、六类）显著超出主流 Agent，在 IDE 集成/云生态（四、七
> 类的外围）为诚实未做。

---


---

## v0.5.6 增补（2026-09-15）

> v0.5.9 增补：音频工坊（「音频产物通道」新维度条目强化：8 乐器音色 × 7 和弦进行 × MIDI 导出 + Web 🎵 试听面板；+22 测试，全量 469/469，见下方条目）；v0.5.8 增补：语义检索/RAG（#19/#22 双 ⬜→✅，+13 测试，全量 447/447，见上方表 19/22 行）；v0.5.7 增补：嵌套执行多重优雅降级（空壳工作区修复 + 三路 dispatch 降级，+3 测试，全量 434/434，见「增补」表）；v0.5.6 在 v0.5.4 底稿之上新增三项（+42 测试，全量 431/431）：

| 增补 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|
| **音频产物通道**（产物开袋即食——超出 150 项清单的新维度） | ✅ | `lib/audio.ts`（WAV 合成渲染器：PCM16 立体声 · **8 乐器音色库**（谐波表+包络+颤音 FM）· **7 和弦进行预设**（柱式/琶音）· **MIDI 导出**（SMF 0）· 峰值归一化 · 多重降级）· 静态专家 `composer`（B:reuse 路由，timbre 参数）· 工具环 `audio_compose`（timbre/chords 和弦车道）· CLI ♪ 行 + `audio_rendered` 事件 + Web `<audio>` 播放器（`GET /api/audio` 含 .mid）+ **🎵 音色试听面板**（`/api/audio-demo`）+ 直连 t-bot 音频卡 + TUI 通知条。古典音乐的交付物是可播放 WAV + 可导入 DAW 的 MIDI，不是乐谱。真实车道实测：DeepSeek deepseek-flash 经工具环作曲 → 27.1s WAV。 |
| **#129 多 Agent 协作 → 递归派生（子生孙）** | ✅（深化） | 工具环 `agent_spawn {goal, mode, expert, reuse?}`：direct 车道 agent 派生完整子组织（org run 团队任务 / org ask 直连专家）；子组织工厂铸造的专家即「孙」。**双重治理**（v0.5.11）：① 深度 `ORG_SPAWN_DEPTH`/`ORG_SPAWN_MAX`（缺省 2，0=关闭）；② 预算继承 `ORG_SPAWN_BUDGET`（缺省 100 份，0=耗尽，off=关闭）× `ORG_SPAWN_DECAY`（缺省 0.5）—— 子预算 = floor(父预算 × 衰减率) 随深度指数衰减，子组织 tokens/model_calls 用量回填观测。**池化重档**（v0.5.11）：`<ws>/spawn/pool.json` 登记每次派生，相似 goal（词面重合 ≥0.6）命中即零成本复用（reuse:false 强制新派生）；Web 🌳 派生池面板（树形 + 统计 + 递归挂孙 + legacy 兜底）。 |
| **作品集 10 项目矩阵**（验收口径落地） | ✅ | `tests/portfolio.test.ts`：三条执行车道（A 内联 / B 复用静态 / B 复用导入 harness）× 10 类使命（公告/音乐/诗歌/变更日志/纪要/周报/风险/术语表/数据字典/发布说明）全部 scripted 进 CI。 |
| 静态专家 `bard`（诗歌创作） | ✅ | 轨道 `poetry` · poem.md 工件 · 降级内置示例诗；真实车道实测写诗闭环。 |
| **嵌套执行多重优雅降级**（v0.5.7 · QA 实测双修） | ✅ | 空壳工作区修复：TaskRunner 先行 mkdir 骗过 ensureWorkspace → 标记物判据（registry/raw/.git 全缺即补模板，幂等且保留 runtime/ 队列）；嵌套专家执行失败（Reuse/Generate/WarmHandoff 三路）从硬 Err 降级为失败报告（coverage 0 + `*-run-failed` 标注 + remedy 提示）交监督回路有界处理（Revise → 返工 ≤2 → 强制收货），摘要诚实可见。`tests/degrade.test.ts` 3 例钉进 CI。 |
| 图灵完备实证（issue #34） | ✅ | `fixtures/turing/`（Rule 110 / BB(3) / Brainfuck）× 四语言对拍（解释器 + python ruff + rustc + g++）11/11；vendored dhv-ts 0.2.65→0.2.66；ruff 语料 3→6。 |

## 一、交互与入口（1–15）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 1 | CLI/TUI 交互式对话 | ✅ | `org chat`（REPL：流式/思考指示器/22 斜杠命令/↑↓历史）· `org tui`（三区驾驶舱） |
| 2 | 非交互/脚本模式 | ✅ | `org run/ask/handoff`（单发子命令 + 退出码语义，CI 即脚本消费者） |
| 3 | JSON/结构化输出 | ✅ | 产物层全结构化（run.json/events.jsonl/journal.jsonl/metrics.json/scorecard.json）；llm-ledger 台账 JSONL |
| 4 | IDE/编辑器集成 | 🟡 | 上游 HSL 仓库有 IDE（vsix + 语法高亮 + LSP 客户端雏形）；org 本体未接（诚实边界：org 的 IDE 面经 HSL 仓库提供） |
| 5 | Web/桌面入口 | ✅ | `org web`（4600 端口零依赖 GUI：对话/任务中心/审批/通知/车道/记忆/复核 八面板） |
| 6 | 多轮对话 | ✅ | 直连多轮（磁盘会话账本 + 历史织入 + `--turns` 批量轮） |
| 7 | 会话历史/恢复 | ✅ | `runtime/sessions/<expert>/<id>.jsonl` 跨进程持久 · `org sessions` · `--continue` · `/resume` · `org session fork` |
| 8 | 上下文压缩 | ✅ | `/compact`（LLM 摘要 → 账本重写为单轮摘要，备份可回滚）· ctx 窗口计量条 |
| 9 | 澄清提问 | ✅ | 主控监督回路 clarify 阶段（批量澄清 + consume_answers 回填） |
| 10 | 任务计划/待办列表 | ✅ | org.hsl decompose（任务树分解）→ Web/TUI 任务卡叙事；任务队列 P0-P10 |
| 11 | 后台/异步任务执行 | ✅ | v0.5.2 长程任务队列（文件协议状态机 + 三形态执行器） |
| 12 | 任务队列、优先级与并行执行 | ✅ | TaskRunner（P0-P10 优先级 · 并发 ORG_TASK_CONCURRENCY · 跨进程 runner lock） |
| 13 | 暂停、恢复、中断与继续 | ✅ | 运行中 **SIGSTOP/SIGCONT 真进程暂停**（RunHandle.pause/resume 实测）· cancel（SIGTERM）· retry（attempts 计数）· 孤儿收割断点续跑 |
| 14 | 通知中心/任务提醒 | ✅ | v0.5.2 通知中心（存储 + 未读徽标 + CLI/Web 双端）+ 桌面通知三级降级 |
| 15 | 移动端/语音入口 | ✅ | 移动端自适应（≤720px 抽屉布局）；**语音入口（v0.5.12）**：`lib/voice.ts`（z-ai SDK ASR/TTS 封装 + 多重优雅降级）—— Web 🎤 录音转写（MediaRecorder → `POST /api/asr` → 转写进输入框）· 🔊 回复朗读（`POST /api/tts` → 24kHz WAV，7 声音 × 语速 0.5-2.0，超长句子边界分段 PCM 拼接，4K 截断诚实标注，LRU 缓存零重复计费）· 🎙 语音面板（声音网格/语速滑条/服务状态探测/localStorage 记忆）；CLI `org speak`（TTS 落盘）/`org voice`（状态+清单）；凭据缺席 → 明确降级提示（文本交互不受影响）；`DHV_VOICE_DISABLE_SDK=1` 零外联开关 |

## 二、上下文与知识（16–30）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 16 | 项目结构扫描 | ✅ | 工具环 `fs_list`（深度 8 上限 32 + 截断可观测）· `fs_glob`；TUI/引擎的工作区扫描 |
| 17 | AGENTS.md/规则文件 | ✅ | v0.5.3：AGENTS.md / .org/rules.md 自动注入 direct 车道系统提示（8KB 截断） |
| 18 | @文件/目录引用 | ✅ | v0.5.3 lib/mentions.ts：@路径 → 围栏内容（目录树+预览；越界/二进制/预算三防） |
| 19 | 语义代码搜索 | ✅ | v0.5.8 `lib/search.ts` BM25 + 短语加成 + 中英混合分词（CJK bigram）；四入口：CLI `org search` / Web 🔍 面板（点击命中插入 @引用）/ 工具环 `semantic_search`（ABI 内同构实现，tests 行为对拍 top-1 一致）/ `@?查询词` RAG 注入 |
| 20 | 符号定义/引用/跳转 | ✅ | **v0.5.15** lib/symbols.ts 轻量符号索引（HSL fn/struct/enum/trait/graph/const/impl · TS fn/class/interface/type/const · PY def/class；文件帽 600 · 512KB · 二进制嗅探）→ 三端：CLI `org symbols <名> --refs`（call/mention 两类引用）· 工具环 `symbol_search`（ReadOnly 可用）· Web 🔎 工具箱。诚实边界：正则词法级非 LSP（完整 LSP 是路线图）；tests/symbols 14 例 |
| 21 | 依赖图/调用图 | 🟡 | registry 资产图 + 专家复用/依赖归因（B/C 路径）；代码级调用图未做 |
| 22 | RAG/向量检索 | ✅ | v0.5.8 检索增强生成的检索半环：`@?查询词` → BM25 top-5 命中展开为围栏摘要块自动织入模型上下文（org ask / 直连车道；无命中/异常附注降级不炸）。诚实边界：BM25 词频语义非 embedding 向量 —— embedding 升级是路线图（z-ai SDK 车道预留） |
| 23 | 长期记忆 | ✅ | v0.5.3：runtime/memories/<expert>.md（跨会话注入尾部 40 行）· org memory CLI/Web/`/memory` 三端 |
| 24 | 文档/PDF 读取 | ✅ | **v0.5.15** lib/pdfread.ts 三层降级链：pdftotext（系统）→ uv+pypdf（零全局污染）→ 诚实失败附安装指引；魔数嗅探 · 页帽/字符帽截断标注。三端：CLI `org read` · 工具环 `read_pdf`（ReadOnly 可用）· 引擎探测 `pdfEngines()`；tests/pdfread 10 例（引擎缺席 skip） |
| 25 | 图片/截图理解 | ✅ | v0.5.13 视觉入口：lib/vision.ts（z-ai SDK createVision · 多图 ≤4 · 魔数唤探防伪造 mime · prompt 超长诚实截断）→ Web 📷 按钮（分析→引用闭环：描述追加进输入框可编辑后派单）+ CLI org vision；401/凭据缺席降级 remedy（部署环境配好即全功能） |
| 26 | LSP/DAP 协议集成 | ✅ | **v0.5.17** lib/lsp.ts 三层：①**协议层** JSON-RPC 2.0 分帧（Content-Length 头 + JSON body，LSP 与 DAP 共用；流式解码器处理粘包/半包/多字节字符字节边界 —— CJK 体按字节数计不按字符数；坏帧跳过计数不炸流）+ 构造器全家桶（request/response/notification/error + initialize→initialized→shutdown→exit 生命周期消息）—— 任何外部 LSP server 都能用这层对话；②**内置符号索引车道**（无外部 server 的主车道）：lspDefinition/lspReferences/lspHover 复用 lib/symbols.ts 索引，输出 LSP 规范形（file:// uri + 0 基 range）与人读形（1 基 file:line:column）双形，call/mention 分类 + 列号精确化；③**外部 server 车道**：detectLspServers（typescript-language-server/pylsp/pyright/gopls/rust-analyzer/clangd/bash-language-server 七家 which 探测，缺席诚实降级）+ spawnLspServer 真协议对话（LspClient：响应按 id 关联 · 超时诚实拒绝 · server 早夭不连坐 · shutdown→exit→kill 兜底全生命周期）。三端：CLI `org lsp definition/references/hover/servers/protocol` · 工具环 6 工具（lsp_definition/lsp_references/lsp_hover/lsp_servers 只读）· Web GET /api/govex/lsp（5 动作）+ 🐞 面板 Tab。诚实边界：真编辑器级会话（didOpen/didChange 增量同步/补全路由）是路线图；tests/lsp 41 例（含 echo 型假 server 全生命周期 + 工具环 e2e） |
| 27 | AST、语法树与类型信息 | ✅ | **这是 HSL 的本体**：S1-S8 静态铁律 + 38 后端 AST 投射 + 语义对拍 |
| 28 | 增量索引/跨仓搜索 | 🟡 | 静默更新检测 + N 版本冗余 + registry git 资产层；代码索引未做 |
| 29 | 代码图谱/知识图谱 | 🟡 | graph 拓扑（G1-G6 校验 + node/edge 事件可观测）即程序结构图谱；知识图谱未做 |
| 30 | 浏览器 DOM/页面上下文 | ✅ | **v0.5.16** lib/browser.ts 多引擎降级链（agent-browser → chromium → chrome，探活 + 级联 + 全败合并错误摘要）：`browserSnapshot`（标题/正文/链接 cap 100/图片 cap 50，剥 script·style）· `browserScreenshot`（整页 PNG，盘上字节校验非引擎自报）· 非 http(s) 协议拒绝。三端：CLI `org browser snapshot/screenshot` · 工具环 `browser_snapshot`（只读）/`browser_screenshot`（审批在环，PNG 落工作区）· Web 🌐 快照/截图表单；超时预算收敛引擎侧（1-60s 钳制，缺省 30s）；tests/browser 49 例中相关面已锁定 |

## 三、代码生成与理解（31–45）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 31 | 代码生成 | ✅ | 工厂 mint 流水线（mint_hsl 生成 + check 闸门 + fixture 验收 + git 注册）；HSL 38 后端投射 |
| 32 | 代码补全 | ✅ | **v0.5.16** lib/completion.ts `completeAt`：三级候选（同文件符号 100 > 项目符号 80 > 语言关键字 50，前缀排序全确定性）HSL/TS/PY 三语言；空候选永不静默（附原因：行首/空格后/点后成员/无命中）。三端：CLI `org complete <file> <line> <col>` · 工具环 `complete_at`（line_text+column 或 line 行号双形态）· Web ⌨ 补全表单；tests/completion 锁定 |
| 33 | 代码解释 | ✅ | 直连专家问答 + 工具环读真实代码作答（实测：读 notices.txt → 正确计数） |
| 34 | 代码审查 | ✅ | 监督回路 review 阶段（四态裁决 + coverage 客观闸门 + 意见复发→补丁提案） |
| 35 | Bug 定位 | 🟡 | 审查/复发计数/评分卡漂移告警提供定位信号；无专用调试器 |
| 36 | Bug 修复 | ✅ | 补丁线（三级分类 + 金丝雀影子晋升 + 蓝绿回退可逆） |
| 37 | 重构 | 🟡 | 工厂补丁的 flow 级变更（check+smoke+评测不回退三闸门）；无重命名级重构 |
| 38 | 代码迁移/翻译 | ✅ | **HSL 王牌**：一源 → 38 后端（python/ts/js/rust/go/…）；行为级对拍保证语义一致 |
| 39 | 算法/数据结构实现 | ✅ | HSL 语言层全支持（Vec/HashMap/闭包/递归/模式匹配；ruff 语料含递归/闭包） |
| 40 | SQL/Shell/正则生成 | 🟡 | LLM 生成面（deepseek 车道可生成任意文本；无专用验证闸门——shell 有执行白名单） |
| 41 | 前端/UI 组件生成 | 🟡 | 同 40（文本生成可产出；无预览/验证环） |
| 42 | API/接口契约设计 | ✅ | 信封契约（TaskSpec/StatusReport/Verdict 类型化接口 + 类型检查闸门） |
| 43 | 数据库 Schema/迁移 | ✅ | **v0.5.15** lib/db.ts（bun:sqlite 零依赖）：`dbSchema`（表/列/索引/视图/行数抽查）+ `dbApplyMigration` 版本化迁移（_org_migrations 账本 + 伴车 .migrations.json 双写 · dry_run 事务回滚预演 · 坏 SQL 整体回滚 · 冲突诊断）。三端：CLI `org db schema/query/migrate/history` · 工具环 `db_schema/db_query/db_migrate`（写半环审批在环）· Web 🗄 工具箱；tests/db 24 例 |
| 44 | IaC/基础设施代码 | ✅ | **v0.5.18 深度实现**：lib/iac.ts（与 #147 iacscan 扫描面互补的解析/规划/生成层）—— 内置 HCL 子集解析器（block/label/属性/插值/heredoc/注释，行号级诚实报错；零依赖主车道）+ 资源依赖图（拓扑序/环检测/未声明引用警告 + locals 字面量降粒度）+ 人读 Plan（"to create N resources" 风格，与真 terraform plan 差异诚实标注）+ JSON manifest 逆向生成 .tf（iacParse 往返自洽）；外部车道 terraform/tofu/tflint 探测（在场 validate -json 只读，缺席→内置车道为主车道）。三端：CLI `org iac parse/plan/graph/generate/probe/validate` · 工具环 `iac_parse/iac_plan/iac_graph/iac_generate`（全只读）· Web ⚒ 面板；tests/iac 63 例 |
| 45 | 注释/文档生成 | ✅ | run 报告（report.md/memory.md/评分卡）+ hsl-mirror 围栏文档 + CHANGELOG 叙事 |

## 四、编辑与文件操作（46–60）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 46 | 读取文件 | ✅ | 工具环 fs_read（32KB 截断可观测）+ $host.fs.read（2MB 上限 + 路径监狱） |
| 47 | 写入文件 | ✅ | 工具环 fs_write（**能力门 + 审批在环**）+ $host.fs.write |
| 48 | 多文件编辑 | ✅ | 工厂多文件产物 + 补丁 fs.edit 锚点替换；工具环多轮多文件 |
| 49 | diff 预览 | ✅ | **v0.5.15** lib/diff.ts unified diff（公共头尾剥离 + LCS DP ≤400 万格 · 大文件快速路径 · CRLF 归一），**与 GNU diff -u 对拍逐字节一致**（hunk 头行号边界实测对齐）。三端：CLI `org diff` · 工具环 fs_write/fs_edit `preview:true` 干跑 · Web 工具箱；tests/diff 16 例 |
| 50 | patch 应用 | ✅ | merge_patch（三级分类 + 锚点编辑 + 版本归档 + 回退） |
| 51 | 文件搜索/glob | ✅ | 工具环 fs_glob（\*\*/\* 模式 + 上限 200）+ fs_list |
| 52 | 批量重命名/移动 | ✅ | **v0.5.15** 工具环 `fs_move {from,to}`：Full 模式 + 审批在环 + 工作区监狱（词法判定先行 + realpath 符号链实解析双层）+ 防自嵌套 + 目标父目录自动补建。诚实边界：单文件移动语义（批量 = 工具环多轮循环，模型侧自然批处理），无 glob 批量重命名语法；tests/tools2 e2e |
| 53 | 冲突解决 | 🟡 | 补丁唯一锚点约束（多处命中即拒绝，不猜）；git 层冲突未接 |
| 54 | 撤销/回滚 | ✅ | `org revert`（版本回退本身可逆：当前源先归档）· 会话 fork 反悔通道 |
| 55 | 检查点/快照 | ✅ | **git 作为资产层**（每次 mint/keep/patch 一 commit）+ N 版本冗余 + dist 快照 |
| 56 | LSP 重命名/代码动作 | 🟡 | **v0.5.16 重命名半面 ✅**：lib/rename.ts `planRename/applyRename`（词法符号索引 + 行级词边界替换；拒绝面：找不到定义/目标名冲突/非法标识符附原因；dryRun 缺省预览 unified diff ≤5 文件，真写逐文件读→替换→复读校验失败即停）。三端：CLI `org rename <old> <new> [--apply]` · 工具环 `rename_symbol`（审批在环）· Web ✏️ 表单（真写可选）。**代码动作（quick fix/自动修复菜单）未做** —— 行整体按重命名交付 + 代码动作路线图定 🟡 |
| 57 | 多仓库/多工作区 | 🟡 | --workspace 显式多区并行（任务队列天然多区）；跨仓联动未做 |
| 58 | 文件监听/自动同步 | 🟡 | 上游 dhv-ts watch 模式；org 侧静默更新检测 + vendored 新鲜度守卫 |
| 59 | 编码、换行、权限处理 | ✅ | vendored fs 层 CRLF 归一化重试 + PYTHONUTF8 + UTF-8 全链（三平台 CI 实证） |
| 60 | 编辑预览/干跑模式 | ✅ | **v0.5.15** fs_write/fs_edit `preview:true` 干跑：不落盘返回 unified diff（stats + 16KB diff 面）；fs_edit 预览同样要求锚点唯一命中（预览语义 = 执行语义）。叠加：org review --dry-run + 工厂补丁 classify 三闸门；tests/tools2 e2e 锁定「预览不落盘」承诺 |

## 五、执行与终端（61–75）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 61 | Shell 命令执行 | ✅ | $host.shell.run（首词白名单 --allow + 60s 超时 + 8MB 上限 + capability_denied 事件）+ 工具环 shell_run（能力门+审批） |
| 62 | 脚本运行 | ✅ | 同上（bun/node 白名单内） |
| 63 | 构建/编译 | ✅ | dhv check（编译期校验）+ emit（38 后端投射）+ py_compile 交叉语法校验 |
| 64 | 启动服务 | ✅ | org web/taskd（守护执行器）；长程任务后台起停 |
| 65 | 安装依赖 | 🟡 | shell_run 可执行 install（白名单内）；无专用依赖管理面 |
| 66 | 环境变量管理 | ✅ | 用户环境不可覆盖层 + org config 注入 + DHV_LLM_\*/ORG_\* 全链传递（双车道合并的历史 bug 档案） |
| 67 | Docker/容器操作 | ✅ | **v0.5.17** lib/cloud.ts 四层：probeDocker（which + --version 探活 + docker info 守护进程可达 5s 硬超时）→ dockerRun **白名单子命令封装**（16 子命令：version/info/ps/images/build/run/create/start/stop/rm/rmi/logs/inspect/pull/tag/push；system prune/kill/exec 等破坏性命令绝不在内，拒绝先于 spawn）+ 数组参数零 shell 面 + 30s 硬超时 + dockerBuild（context/Dockerfile 过 pathjail）→ 降级车道：dockerfileFor 四型生产级模板（node/bun/python/rust，多阶段 + 非 root + healthcheck，过自家 iacscan 自检）+ composeFor + dockerPlan 五意图可粘贴命令序列。三端：CLI org cloud · 工具环 cloud_docker/cloud_dockerfile（process_spawn 门+审批）· Web ☁ 面板 |
| 68 | 远程 SSH | ✅ | **v0.5.17** lib/cloud.ts：probeSsh（ssh -V 探活 + ~/.ssh config/known_hosts **只看存在性** —— 私钥/密钥内容绝不读取绝不回显）→ sshRun/scpUpload **host 白名单门控**（<ws>/ssh-hosts.allow 缺席 = 拒绝一切远程执行 + 创建指引）+ BatchMode=yes + ConnectTimeout=10 + StrictHostKeyChecking=accept-new + 数组参数 + scp local 过 pathjail/remote 拒 shell 元字符 → 降级车道：sshConfigTemplate（Host 片段 + 密钥/跳板机/IdentitiesOnly 安全建议）+ sshPlan 五步计划。三端：CLI org cloud ssh/scp/ssh-template · 工具环 cloud_ssh（双形态：执行/上传）· Web ☁ 面板。诚实注：沙箱无真实远程主机，交付门控+模板车道，真实车道代码路径完整 |
| 69 | 沙箱执行 | ✅ | **多层**：路径监狱（symlink 实解析）+ 首词白名单 + 产物目录隔离 + 工具环能力门 + 审批队列 |
| 70 | 超时/取消/重试 | ✅ | shell 超时 killed 标注 · LLM 180s AbortController + 3 次退避 + 路由器 key 轮换 · 任务 cancel/pause/resume/retry · web abort 票据化 |
| 71 | CI/CD 流水线执行 | ✅ | 本仓库 CI（verify 三平台矩阵 + 单二进制冒烟 + ruff 门禁 + dist 回写）+ release 五目标交叉编译 |
| 72 | K8s/Terraform | ✅ | **v0.5.17** lib/cloud.ts：probeK8s（kubectl version --client + cluster-info 集群可达 5s）/probeTerraform 同型 → k8sRun **白名单子命令**（get/describe/apply/logs/rollout/top/config…；delete/edit/scale/exec/drain 永不在内，拒绝先于 spawn）+ apply -f 路径过 pathjail（-f - stdin 拒绝）→ 降级车道：k8sManifestFor 五族生产级模板（Deployment 带资源限额/双探针/securityContext/亲和性 · Service/Ingress/ConfigMap/PVC）+ terraformPlan main.tf 骨架（provider+变量校验+输出，密钥铁律注释）。三端：CLI org cloud k8s/manifest/terraform · 工具环 cloud_k8s · Web ☁ 面板。诚实注：沙箱无集群可实测，真实集群车道已实现、模板车道为主交付 |
| 73 | 数据库迁移/操作 | ✅ | **v0.5.15** lib/db.ts 查询半环 `dbQuery`：**双层只读门**（词法白名单：单语句 + SELECT/WITH/EXPLAIN/PRAGMA table_info 前导 + 内核 readonly 连接兜底 —— WITH…INSERT 漏网句实测被内核拦截零写入）+ 行帽 200（上限 1000）+ 256MB 文件帽 + 工作区监狱。三端同 #43；tests/db 24 例 |
| 74 | 云服务/云 CLI | ✅ | **v0.5.17** lib/cloud.ts cloudCliRegistry：10 家注册表（aws/gcloud/az/gh/vercel/flyctl/railway/heroku/doctl/oci，每家 {cmd, probeFlag, installHint, docsUrl}）+ probeCloudClis 批量探测（which + 版本旗标各带 5s 超时，缺席即不 spawn）+ **cloudProvidersOverview 与 21 家模型服务商注册表口径打通**（推理面 21 + 基建面 10 = 31 面 provider 全景）+ cloudProbeAll 统一探测总入口（docker/ssh/k8s/tf/clis 五键，Web/CLI/工具环三端共用防口径漂移）。三端：CLI org cloud clis/overview · 工具环 cloud_probe/cloud_clis · Web ☁ 面板（绿/灰 + installHint tooltip） |
| 75 | 发布/部署/回滚 | ✅ | auto-release 打 tag + release 发布 + sha256 + 版本单一来源守卫（org 资产层的发布回滚：revert + 金丝雀 + 蓝绿） |

## 六、Git 与协作（76–90）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 76 | status/diff/log | ✅ | 注册表 git 历史（org status / demo 走读）+ shell_run git 白名单 |
| 77 | 生成 commit message | ✅ | 注册表语义 commit（mint/keep/patch 带语义消息）；deepseek 车道可生成 |
| 78 | 分支管理 | 🟡 | shell_run git 白名单内可达；org 无专用分支面（资产层用 main 单线 + git-chain） |
| 79 | 提交/amend | ✅ | 注册表自动提交 + 留痕（sh_quote POSIX 转义防注入） |
| 80 | merge/rebase | ✅ | **v0.5.16** lib/gitmerge.ts：`gitMerge`（--no-ff/自定义 message）· `gitRebase` · `gitMergeState` 只读探测（分支/上游/ahead-behind/分叉/脏树/stash，git 缺席降级不炸）。**冲突哲学：绝不自动解决** —— 冲突即自动 abort 回滚 + 冲突清单；每命令 30s 超时 + 输出 64KB 截断；仓外零执行（repoGuard）。三端：CLI `org merge/rebase/mergestate` · 工具环 `git_merge/git_rebase`（审批在环 + repo 工作区监狱）· Web 🌿 面板；tests/gitmerge 19 例（真 clone 含冲突 abort 后工作区干净验证） |
| 81 | 冲突处理 | 🟡 | 同 53 |
| 82 | 创建 PR/MR | 🟡 | 工程流程层（本开发系列即 PR 工作流）；org 无 API 集成 |
| 83 | PR 审查 | ✅ | **监督回路 review 是 org 的核心**（四态 + 复发检测 + 补丁提案 + 金丝雀） |
| 84 | 变更影响分析 | ✅ | 补丁 flow 级闸门（评测分不回退）+ 评分卡漂移 + 影子对比 |
| 85 | 评审人推荐 | ✅ | **v0.5.15** lib/owners.ts `recommendReviewers`：CODEOWNERS 规则聚合（覆盖数排序 + 模式归因 reason）；无 CODEOWNERS → 目录启发式降级（fromCodeowners:false + 诚实说明）。三端：CLI `org owners --review a,b` · 工具环 `review_suggest`（ReadOnly）· Web 工具箱；tests/owners 14 例 |
| 86 | Issue/工单集成 | 🟡 | 开发流程层（issue 驱动交付，本系列 #28-#31）；org 运行时无 tracker API |
| 87 | 团队共享会话/评论 | ✅ | **v0.5.17** lib/collab.ts：单用户会话账本之上叠多用户协作层（向后兼容铁律 —— lib/sessions.ts 只读复用零改写）。append-only JSONL 团队线程（runtime/collab/threads/<id>.jsonl，与审计账本同哲学：只追加不改写；seq 单调 + 坏行容忍）· 回复树（replyTo 任意挂评论，flattenThread 平铺带 depth）· @mention 自动抽取（@name 用户 id 形，与 @路径 同形实现）· 身份层（collab-user 文件 + ORG_COLLAB_USER 覆盖 + 缺省 local）· 协作者视图/摘要 · **会话账本桥** bridgeSession（LedgerTurn 镜像成 kind:"system" 帖，只镜像不改写，meta 回溯键幂等）。三端：CLI `org collab`（whoami/user/threads/feed --since/post/comment/users/summary/bridge 九子命令）· 工具环 `collab_threads/collab_feed/collab_summary/collab_post/collab_comment`（前三只读，后二 file_write 门 + 审批在环）· Web 👥 治理与扩展面板协作 Tab（GET/POST /api/govex/collab，XSS esc 全转义）；tests/collab 26 例（含工具环 e2e + 原账本字节不变 sha256 对拍）。诚实注：本地文件协议，多进程强并发不在面内（append 直写 + seq 冲突检测重读，单机协作场景） |
| 88 | 多人协作与角色权限 | 🟡 | 审批决定者署名（by: web/cli）+ 能力三态；RBAC 未做 |
| 89 | CODEOWNERS | ✅ | **v0.5.15** lib/owners.ts `loadCodeowners`：GitHub 兼容子集（glob 模式 + @owner + 注释 + 后规则覆盖语义）；查找顺序 .org/CODEOWNERS → CODEOWNERS → .github/CODEOWNERS；`matchOwners` 最长匹配。CLI `org owners` + 匹配清单；tests/owners 14 例 |
| 90 | 发布说明/变更日志 | ✅ | CHANGELOG 叙事纪律（本仓库即实例）+ release notes 自动截取 |

## 七、测试与质量（91–105）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 91 | 单元测试生成 | ✅ | 工厂 mint_fixture（行为剧本生成 + 验收闸门）+ journal→fixture 出题（生产即出题） |
| 92 | 集成测试生成 | ✅ | scripted 全链 e2e（本仓库 357 例即范式） |
| 93 | E2E 测试生成 | ✅ | web SSE 全链 + demo 六相位叙事 + 真实模型工具环实测 |
| 94 | 运行测试 | ✅ | dhv_run_gate（嵌套解释器真实执行）+ bun test 消费 |
| 95 | 覆盖率分析 | 🟡 | 评分卡 evidence_count / confidence 归因；行覆盖率未做 |
| 96 | mock/stub/fixture | ✅ | **Fixture v2 多轨道剧本**（scripted 确定性模型）+ 故障注入 Gauntlet v2（error/deny/empty/corrupt/slow 五类） |
| 97 | lint/format | ✅ | dhv check（S/G/P/N 规则）+ ruff 门禁（python 产物全规则全绿） |
| 98 | 类型检查 | ✅ | S 严格性（零隐式转换/穷尽 match/未使用即错误）+ 12 整型域静态检查 |
| 99 | 静态分析 | ✅ | 同 97/98（+ 交叉语法校验 py_compile/bun 转译/bash -n） |
| 100 | 性能/基准测试 | 🟡 | 耗时计量全链（run.json elapsed/ms 事件）+ 评分卡；专用基准未做 |
| 101 | 契约测试 | ✅ | 信封契约类型化 + P 投射铁律 |
| 102 | 快照/视觉回归 | 🟡 | dist/demo 入库快照再生（CI 对拍）；视觉回归未做 |
| 103 | 模糊/属性/突变测试 | 🟡 | 上游 HSL fuzz 用例；org 侧故障注入即突变测试的运行时形态 |
| 104 | flaky 管理/测试选择 | 🟡 | 超时纪律（B-15 档案）+ 逐例超时声明；选择性重跑未做 |
| 105 | 测试数据管理 | ✅ | fixtures 目录 + 剧本变体 fixtureVariant + makeWorkspace 隔离工作区 |

## 八、调试与诊断（106–120）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 106 | 错误日志解析 | ✅ | run panic 收尾 + 错误尾行捕获（captureDone await 修复） |
| 107 | 堆栈跟踪分析 | 🟡 | HSL_DEBUG stack 透传；自动分析未做 |
| 108 | 断点/调试建议 | ✅ | **v0.5.17** lib/debug.ts：①**断点建议器** suggestBreakpoints（符号索引入口行 fn/graph = confidence:"symbol" + 源码行扫描 if/else 分支行/循环头行/return 前一行 = confidence:"heuristic"，每条带 reason 与双级置信；同行去重符号级优先；词法归因最近上方符号；HSL/TS/TSX/PY 面，其余扩展名诚实空建议）②**DAP 构造器** makeDapInitialize/makeDapSetBreakpoints/makeDapStackTrace/makeDapThreads（seq 单调 + command/arguments 规范忠实 —— setBreakpoints 双字段 lines+breakpoints 兼容新旧 adapter；与 lib/lsp.ts 分帧层共用往返）③**调试计划** debugPlan（attach→入口断点→分支/循环→return 前→命中看栈→disconnect 步骤化说明 + 协议就绪 DAP 消息序列直接可观测）。三端：CLI `org debug suggest/plan/dap`（breakpoints 别名）· 工具环 debug_breakpoints/debug_plan（只读，file 过 pathjail）· Web GET /api/govex/debug（3 动作）。诚实边界：不 spawn 真 debug adapter（沙箱无 node --inspect/debugpy/lldb-dap 桥）—— 真 DAP attach 是路线图，交付协议封装 + 建议器 + 计划；tests/lsp 41 例 |
| 109 | 日志查询与关联 | ✅ | 三路事件流（events/journal/llm-stream）归一化合并去重 + replay 时间线 |
| 110 | 性能剖析 | 🟡 | 计量全链（tokens/ms/model_calls）；profiler 未做 |
| 111 | 内存/CPU 分析 | 🟡 | 池并发/预算水位；OS 级分析未做 |
| 112 | 网络请求诊断 | ✅ | 路由器台账（latency/status/key 指纹/usage）+ 连通测试 testLane |
| 113 | 数据库查询诊断 | ✅ | **v0.5.16** lib/dbdiag.ts `dbDiagnose`：EXPLAIN QUERY PLAN 只读通道（前导词白名单 SELECT/WITH + 写动词骨架扫描堵 WITH…INSERT 漏网 + readonly 连接纵深）→ 计划解析（索引命中/全表扫描/涉及表，SCAN CONSTANT ROW 伪步骤不计）+ 四类调优建议；:memory: 瞬态可 setup 播种（文件库拒绝）。三端：CLI `org dbdiag` · 工具环 `db_diagnose`（只读）· Web 🩺 表单；tests/dbdiag 16 例 |
| 114 | 依赖冲突诊断 | ✅ | vendored 漂移守卫（版本比对 + 浅克隆）+ 锁文件纪律 |
| 115 | 根因分析与验证 | ✅ | 复发计数（跨运行 recurrence.json）→ 补丁提案 → 金丝雀验证闭环 |
| 116 | 浏览器 DevTools | 🟡 | **v0.5.16 交付可本地化半面**：DOM 快照（标题/正文/链接/图片清单）+ 整页截图 + 引擎探测（lib/browser.ts 多引擎降级，与 #30 同源）；CLI/工具环/Web 三端可用。**console 面板/网络面板/DOM 交互（点击/输入）未做** —— 需要常驻会话型引擎（CDP 协议），是路线图；行按诚实口径定 🟡 |
| 117 | 移动端调试 | ✅ | **v0.5.18**：lib/mobile.ts —— 多重优雅降级全链：devices 三层（adb 缺席→无设备→未授权，devices -l 多设备/offline 诚实入列 + iOS idevice 面）/ logcat 五元组 dump（-d 快照，tag/级别/包名三重过滤）/ forward 四层（adb→设备→/proc/net/unix socket 发现→CDP /json 页面清单，本地 9222 探测）/ apk 两层（aapt badging→PK 魔数）/ plan 纯函数保底（平台×症状矩阵步骤化计划，零外部依赖永远可用）+ mobileSelfTest 自检。三端：CLI `org mobile probe/devices/logcat/forward/apk/plan/self-test` · 工具环 `mobile_devices/mobile_logcat/mobile_plan`（全只读）· Web 📱 面板；tests/mobile 60 例。真机实测是诚实边界（沙箱无真机；外部车道全用假脚本锁定） |
| 118 | 分布式追踪 | 🟡 | trace 概念在事件 seq/ts 全链贯通；无 APM 接入 |
| 119 | 监控告警关联 | 🟡 | 漂移告警 + 预算水位 + 通知中心；外部监控未接 |
| 120 | 故障复现/最小化 | ✅ | scripted 剧本即「可复现的模型响应录制」+ 故障注入第五类 slow/corrupt |

## 九、扩展与集成（121–135）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 121 | 插件系统 | 🟡 | `org import`（用户 harness 导入 + check 闸门 + 即刻复用）+ 工厂 stock；无动态加载。**v0.5.16 补插件包市场半面**（lib/plugins.ts 事务性安装/清单/移除，见 #132 —— 只装不执行，动态加载是路线图） |
| 122 | MCP 支持 | ✅ | **v0.5.19 协议翻译半面交付**：lib/mcp.ts MCP 客户端桥 —— <ws>/mcp-servers.json 档案（秘密键只收 $env:VAR 引用，值永不入档）→ spawn 外部 server（stdio 换行分帧 JSON-RPC）→ initialize 握手 + 能力协商（tools/resources/prompts 三面独立，缺席诚实 unsupported）→ tools/list 分页跟进 / tools/call（isError 双层语义）/ resources list+read / prompts/list。三端：CLI `org mcp` 七子命令 · 工具环 mcp_servers/mcp_tools（只读）+ mcp_call_tool（process_spawn 门 + 审批在环）· Web GET /api/govex/mcp 只读五动作 + 🔌 面板。与 adapters/bridge.hsl 外部 subagent 登记互补：登记 → 真握手真调用。诚实边界：会话粒度=每操作一会话（长连接复用/采样/roots 订阅是路线图）；协议层由 fixture server 实弹锁定（真 spawn 真握手真调用 51 例） |
| 123 | 自定义命令 | ✅ | 斜杠命令 22 个 + TUI `:命令` + Web 面板动作（三端同权） |
| 124 | 工作流编排 | ✅ | **HSL graph**（node/edge/guard + G 拓扑校验）+ 监督回路四阶段 + 工厂管线 |
| 125 | 多模型切换 | ✅ | 21 服务商车道 + key 池 + 降级链 + `/model`/`:model`/Web 段控热切换 |
| 126 | 本地模型/API 模型 | ✅ | ollama/lmstudio/vllm 预设免 key 即用 + OpenAI 兼容一条协议打天下 |
| 127 | Webhook/API 调用 | ✅ | 路由器 fetch 全链 + **v0.5.5 出站 webhook**（`notify_webhook_url` 三通道：存储/桌面/webhook 互不影响，5s 超时静默降级，事件过滤 `notify_webhook_events`）+ 工具环 shell/net。诚实边界：入站 webhook 服务端未做（org 是发起方不是接收方） |
| 128 | 定时任务 | ✅ | **v0.5.5 定时触发器**：lib/schedule.ts 五段 cron + @every 区间 + UTC 语义 + misfire 策略（skip/run）+ 到期自动入队 TaskRunner；CLI `org schedule list/add/rm/on/off/test` + Web ⏰ 面板 + previewNext 预览；v055.test.ts 33 例锁定 |
| 129 | 多 Agent 协作 | ✅ | **org 本体**：主控-专家监督回路 + 工厂铸专家 + 池化 + 暖移交 + 金丝雀双跑 |
| 130 | 工具注册/发现 | ✅ | 工具环注册表 + registry manifest + adapter 登记 |
| 131 | SDK/API Server | ✅ | cliMain 可编程入口 + startWebServer({port:0}) + $host.dhv 嵌入执行面 |
| 132 | 插件/规则市场 | ✅ | **v0.5.16** lib/plugins.ts：manifest 契约（name/version/description/entry/permissions）+ **事务性安装**（staging 中转 → 校验 → 同文件系统原子 rename，任何失败整体清理绝不留半成品）+ git 源浅克隆（60s 硬超时，缺席诚实降级 tool-absent）+ 重名冲突双查 + remove/validate（纯只读预览）。**permissions 字段（"tool:shell_run" 形态）与 RBAC 命名空间联动**。诚实边界：只装不执行（entry 仅验存在），插件执行面是路线图。三端：CLI `org plugin list/install/remove/validate` · 工具环 `plugin_list/plugin_install/plugin_remove`（写半环审批在环）· Web 🧩 面板；tests/plugins 15 例 |
| 133 | 远程 Agent/云执行 | ✅ | **v0.5.18 会话/部署/计划层**（与 #68 cloud_ssh 单命令执行互补）：lib/remote.ts —— probeRemote 四工具探测 + remote-hosts.json 主机档案（host/user/port/identity 路径——私钥内容 PEM 头混入拒绝 + password 字段拒绝；host 不在档案拒绝不猜默认）+ remoteExec 会话级执行（白名单默认只读九命令 + 元字符拒 + allow_full 显式 + 三类诊断：超时/拒连/鉴权含指纹漂移）+ remoteSync rsync→scp→指引三层降级（local 过 pathjail）+ remotePing 往返三统计 + remoteDeployPlan 四模式（摸底/git/rsync/容器三式/run 队列远程化+回滚）。三端：CLI `org remote probe/hosts/exec/sync/ping/plan` · 工具环 `remote_probe/remote_plan/remote_ping`（只读）+ `remote_exec`（process_spawn 门+审批在环）· Web 🛰 面板；tests/remote 53 例。无真远程机实测是诚实边界（参数构造/输出解析全锁定） |
| 134 | OpenAPI/GraphQL/gRPC | ✅ | **v0.5.16 OpenAPI 半面**：lib/openapi.ts `parseOpenApiText/File`（OpenAPI 3.x / Swagger 2.0 双识别；2.0 的 basePath/schemes 合成 servers 语义对齐；路径级公共参数并入操作级按 in:name 覆盖；$ref 参数不展开如实标注）+ `suggestToolName`（api_<operationId> 清洗，工具环命名建议）。诚实边界：**GraphQL/gRPC 未做**（路线图）；YAML 不写半吊子 parser（错误附 python3 yaml→JSON 转换指引）；spec 帽 1MB。三端：CLI `org openapi` · 工具环 `openapi_parse`（只读）· Web 🔌 上传/粘贴解析；tests/openapi 16 例 |
| 135 | 评测/基准平台 | ✅ | **评分卡**（证据归因 + 客观/裁判档权重 + 漂移基线）+ fixture-miner 出题 + 诗歌擂台反哺 |

## 十、安全与治理（136–150）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 136 | 权限确认 | ✅ | 能力三态（Auto/Confirm/Deny）+ **审批队列文件协议**（四端入口 + 有界等待 + 超时降级拒绝） |
| 137 | 只读/自动/全自动模式 | ✅ | 工具环三档（ORG_TOOLS 未设/1/write）+ 审批在环（未开审批写动作明确拒绝——安全缺省） |
| 138 | 危险命令拦截 | ✅ | 首词白名单 + sh_quote POSIX 转义 + 路径监狱 + 模板目录只读守卫 + rmSync 脚枪防线 |
| 139 | 工作区信任 | ✅ | dist/demo 只读守卫（Web 全动词覆盖）+ 工作区标记检查 |
| 140 | 密钥/环境变量保护 | ✅ | maskSecret 全端（首 3 尾 4）+ key 指纹脱敏台账 + 用户环境不可覆盖层 |
| 141 | 密钥/漏洞扫描 | ✅ | **v0.5.15** lib/scan.ts **18 类密钥模式**（OpenAI/Anthropic/GitHub/GitLab/AWS/Google/Slack/Stripe/DeepSeek/智谱/通义/私钥/JWT/数据库连接串/Telegram/微信… 先精确后宽泛归属）· 预览行全脱敏（前 4 后 2）。三端：CLI `org scan`（高危 exit 1）· **工具环 fs_write 写入前拦截**（高危拒绝落盘 · 中低危告警放行 · ORG_SCAN=off 逃生口）· Web 🛡 工具箱；tests/scan 18 例 + tools2 e2e |
| 142 | 审计日志 | ✅ | journal（人读）+ events（结构化）+ approvals resolved 留痕 + llm-ledger + replay 确定性重演 |
| 143 | 成本/Token 限额 | ✅ | 计量全链 + 日预算（budget_requests 路由器强制 429）+ 成本时间线面板 |
| 144 | 数据脱敏 | ✅ | key/args 摘要截断 + preview 60 字符；全量脱敏管道未做 |
| 145 | 登录/API Key/配置管理 | ✅ | org config v3（车道/key 池/降级链/预算）+ env 自动发现 + 连通测试 |
| 146 | SAST/DAST | 🟡 | dhv check 是 SAST 的语言级形态（编译期处决）；通用 SAST 未接 |
| 147 | 容器/IaC 扫描 | ✅ | **v0.5.16** lib/iacscan.ts：16 条规则三族 —— Dockerfile（USER root/无 USER/:latest/ADD url/EXPOSE 22/ENV 密钥/apt 未瘦身，续行 \\ 拼接后同层判定）· compose（privileged/docker.sock/ports 22/network host/2375，环回绑定误报守卫）· terraform（0.0.0.0/0 ingress 且非 80/443/publicly_accessible/硬编码 secret/ssl=false）；注释跳过 + 二进制/超限/读失败三重降级逐文件隔离。诚实边界：行级正则非完整 parser（截断误截方向是漏报，安全侧）。三端：CLI `org iacscan`（高危 exit 1）· 工具环 `iac_scan`（只读）· Web 🛡 面板；tests/iacscan 22 例 |
| 148 | SBOM/许可证合规 | ✅ | **v0.5.15** lib/sbom.ts SPDX-2.3 生成器：application（org 本体）+ runtime（z-ai-web-dev-sdk，bun.lock 三层宽容解析 JSONC 尾随逗号）+ vendored（dhv-ts）；JSON 与 tag:value 双渲染，**spdx-tools 全量校验 0 错误**；CLI `org sbom --format json|tv` + Web 📋 工具箱；tests/sbom 12 例 |
| 149 | SSO/RBAC/数据驻留 | ✅ | **v0.5.16 RBAC 半面**：lib/rbac.ts（策略 <ws>/.org/rbac.json 严格形状校验坏文件降级单机 owner 兜底；模式匹配 `*` 全量/尾 `*` 前缀通配/中置 * 不通配；判定次序：未知角色拒→deny 优先→allow→默认拒）+ **工具环可选门控**（`ORG_RBAC_ROLE` 未设 = 完全不启用零回归；设了 → 每工具调用判 tool:<name>，拒绝返回含 rule/reason 的工具错误并落审计：journal rbac_denied 事件 + runtime/rbac.jsonl 决策账本）+ 插件 permissions 字段同命名空间联动（执行面路线图）。诚实边界：**SSO 身份联邦/数据驻留未做**（单机角色声明形态，路线图）。三端：CLI `org rbac list/check` · 工具环 `rbac_check` · Web 🛂 面板；tests/rbac 16 例 |
| 150 | 隐私模式/审计导出 | ✅ | **v0.5.15** lib/audit.ts 审计导出：out-*/ 七件套 + runtime 审批台账/LLM 台账/通知/key 池指纹 + git-chain → **零依赖手写 zip**（CRC-32 与 python zlib 对拍 · EOCD 偏移 bug 实测抓修）+ markdown 摘要；缺文件警告不炸。三端：CLI `org audit [--run]` · 工具环 `audit_export`（审批在环）· Web 📦 工具箱；tests/audit 11 例。隐私模式（DHV_LLM_DISABLE_SDK 零外联）v0.5.4 起在册 |

---

## 专家 Agent 25 项共同能力对照

> 论断：这 25 项的共同点是「能理解、能记忆、能调用工具、能执行、能验证、能治理」
> —— ORG 把它们作为**专家生命周期的结构属性**（不是提示词里的人设）。

| # | 能力 | 状态 | ORG 的实现形态 |
|:--|:--|:--|:--|
| A1 澄清提问 | ✅ | 监督回路 clarify 阶段（批量澄清 + 仲裁回填防活锁） |
| A2 任务计划/待办 | ✅ | decompose 任务树 + 路由四判据 + 派单卡叙事 |
| A3 多轮+会话恢复 | ✅ | 磁盘会话账本 + fork 派生 + resume |
| A4 上下文压缩 | ✅ | /compact 摘要重写 + ctx 计量条 |
| A5 长期记忆 | ✅ | runtime/memories + 三端管理 + 自动注入 |
| B6 结构扫描 | ✅ | 工具环 fs_list/fs_glob + 工作区播种 |
| B7 规则文件 | ✅ | AGENTS.md 注入（codex 同形） |
| B8 @引用 | ✅ | lib/mentions 三防展开 |
| B9 语义检索 | ✅ | 同 #19（v0.5.8 四入口：CLI org search / Web 🔍 / 工具环 semantic_search / @? RAG 注入，tests 行为对拍 top-1 一致） |
| B10 文档/图理解 | ✅ | 文本全链 + **图片理解（v0.5.13 视觉入口：lib/vision.ts 多图 ≤4 + 魔数唤探 + Web 📷 分析→引用闭环 + CLI org vision）** + **PDF 读取（v0.5.15：lib/pdfread.ts 三层降级链 pdftotext → uv+pypdf → 诚实失败 · org read CLI + read_pdf 工具环）** |
| C11 工具调用 | ✅ | 工具环六工具 + 能力门 + 审批在环 |
| C12 MCP/插件注册 | ✅ | org import + adapter 登记 + **v0.5.19 MCP 协议翻译**（lib/mcp.ts 客户端桥：档案 → spawn → initialize → 能力协商 → tools/resources/prompts 翻译到三端；mcp_call_tool 执行车道走门+审批）—— 「登记 ≠ 在岗」的缺口闭合，专家矩阵 25/25 |
| C13 工作流编排 | ✅ | HSL graph（拓扑可验证的 SOP） |
| C14 多 Agent 协作 | ✅ | 主控-专家 + 工厂 + 池 + 移交 |
| C15 后台/队列/沙箱 | ✅ | 任务队列 + SIGSTOP + 路径监狱/白名单/超时 |
| D16 文件读写/diff/patch | ✅ | 工具环 + 工厂补丁 + revert 可逆 |
| D17 生成与理解 | ✅ | mint 流水线 + 问答 + 真实代码作答 |
| D18 测试/lint/类型 | ✅ | check + fixture 验收 + ruff 门禁 |
| D19 调试/根因 | ✅ | 复发计数→补丁→金丝雀验证闭环 |
| D20 Git/影响分析 | ✅ | 资产层 git + 影子对比 + 评分卡漂移 |
| E21 权限/拦截/信任 | ✅ | 三态 + 审批 + 白名单 + 只读守卫 |
| E22 审计/回放 | ✅ | 双日志 + replay + approvals 留痕 |
| E23 密钥保护/脱敏 | ✅ | mask + 指纹 + 不可覆盖层 |
| E24 成本限额/多模型 | ✅ | 预算水位 + 21 车道 + key 池轮换 |
| E25 评测/配置管理 | ✅ | 评分卡归因 + org config v3 |

**统计（v0.5.19 MCP 协议翻译批后口径，tests/check.test.ts 防漂移守卫锁定）**：主 Agent 150 项 → ✅ 119 · 🟡 31 · ⬜ 0；专家 25 项 → ✅ 25 · 🟡 0 · ⬜ 0。

> v0.5.19 MCP 客户端桥（#122 主表 🟡→✅ + 专家表 C12 🟡→✅ —— **专家矩阵 25/25 满贯**）：
> lib/mcp.ts 单一实现三端消费 —— stdio 换行分帧 JSON-RPC（跨 chunk 半行缓冲 + 坏行拒收
> 计数 + 内嵌换行构造性拒绝）+ McpClient 生命周期（initialize 握手 → notifications/
> initialized → 请求/通知 → close；server→client 请求自动响应：ping→{} / sampling→
> -32601 诚实最小；早夭/EPIPE 竞态窗容忍 + pending 统一诚实拒绝）+ 档案层 mcp-servers.json
> （单一规则源校验：name 唯一/command 非空/args 全字符串/cwd 过 pathjail 监狱/**秘密键
> 字面值拒绝 —— 只收 $env:VAR 引用（spawn 时解析，缺席拒绝，值永不入档）**）+ 能力协商
> （tools/resources/prompts 三面独立，缺席诚实 unsupported）+ 分页跟进（nextCursor 帽
> 8 页）+ 内容归一（text 拼接/image·resource 计数/16KB 帽）+ 协议自检 20 项（纯内存）。
> CLI `org mcp` 七子命令（servers/tools/call/resources/read/prompts/self-test）；工具环
> +3（mcp_servers/mcp_tools 只读协议操作 + mcp_call_tool 执行车道 process_spawn 门+审批
> 在环）；Web GET /api/govex/mcp 只读五动作 + 🔌 面板 Tab（call 不在 Web 只读面 ——
> remote 口径）。tests/mcp 51 例（fixture server 真 spawn 实弹：握手/协商/分页/能力缺席/
> 人话日志拒收/早夭/超时/门序/三端冒烟/e2e 双层治理）。主表 ✅119/150 · 🟡31。

> v0.5.17 LSP/DAP 深度簇（#26/#108 两项 ⬜→✅）：lib/lsp.ts + lib/debug.ts 单一实现三端消费 —— JSON-RPC 2.0 分帧层（LSP 与 DAP 共用：粘包/半包/多字节字符字节边界精确）+ 构造器全家桶（initialize→initialized→shutdown→exit 生命周期）+ 内置符号索引车道（definition/references/hover，0 基 uri/range + 1 基人读双形）+ 外部 server 车道（detectLspServers 七家 which 探测 + spawnLspServer/LspClient 真协议对话，echo 型假 server 测试锁定全生命周期）+ 断点建议器（符号级入口/启发式级分支/循环/return 前，confidence 双级 + reason）+ DAP 构造器四件套 + 调试计划（步骤化 + 协议就绪消息序列）。CLI +2 命令（org lsp 五子命令 · org debug 三子命令 + breakpoints 别名）、工具环 +6 工具（全只读，native 块动态 import 与 lib 同源，file 过 pathjail）、Web +2 端点（GET /api/govex/lsp 五动作 · GET /api/govex/debug 三动作）+ 🐞 面板 Tab。诚实边界：真编辑器级 LSP 会话（didOpen/didChange 增量同步）与真 debug adapter attach（node --inspect/debugpy/lldb-dap）是路线图；tests/lsp 41 例（分帧/内置车道/假 server 全生命周期/建议器/DAP/jail/CLI+Web+工具环三端冒烟）。

> v0.5.17 云生态簇（#67/#68/#72/#74 四项 ⬜→✅）：lib/cloud.ts 单一实现三端消费 —— 探测（docker/ssh/kubectl/terraform/10 家云 CLI，各带硬超时）→ 白名单真实车道（docker 16 子命令/kubectl 15 子命令 + 数组参数零 shell 面 + 拒绝先于 spawn）→ 模板/计划降级车道（Dockerfile 四型/compose/K8s manifest 五族/terraform 骨架/ssh-config + dockerPlan 五意图）→ 诚实拒绝（host 白名单/路径监狱）。CLI +1 命令（org cloud 十六子命令）、工具环 +6 工具（cloud_probe/cloud_dockerfile/cloud_clis 只读；cloud_docker/cloud_ssh/cloud_k8s 执行车道 process_spawn 门+审批）、Web +2 端点（GET/POST /api/govex/cloud）+ ☁ 面板 Tab（探测全景卡片 + 模板生成器 + 白名单执行）。诚实边界：沙箱无 docker/kubectl/ssh/云 CLI，降级车道是主车道；真实车道代码路径完整但无真实守护进程/集群/远程主机可实测（#68/#72 附诚实注）。

> v0.5.18 终局三 ⬜ 清零簇（#44/#117/#133 三项 ⬜→✅，主 Agent 矩阵 ⬜ 归零）：三簇各一
  个单一实现三端消费 —— lib/iac.ts（HCL 子集解析器主车道 + 依赖图/拓扑/环检测 + 人读 Plan +
  manifest 逆向生成往返自洽；terraform/tofu/tflint 外部探测，在场 validate 只读）·
  lib/mobile.ts（devices/logcat/forward/apk 四面多级降级 + plan 纯函数保底 + 自检）·
  lib/remote.ts（remote-hosts.json 档案门 + 白名单只读 exec + rsync→scp→指引三层 sync +
  ping 三统计 + 部署计划四式；与 cloud_ssh 单命令执行互补的会话层）。CLI +3 命令组
  （org iac/org mobile/org remote）、工具环 +11 工具（iac×4 + mobile×3 只读；remote×3
  只读 + remote_exec 走 process_spawn 门+审批在环）、Web +3 端点（GET /api/govex/iac ·
  /mobile · /remote）+ ⚒/📱/🛰 三面板 Tab。诚实边界：沙箱无真机/真远程机/terraform——
  外部车道全用假脚本注入锁定（参数构造/输出解析/降级链），纯函数保底车道永远可用。tests
  iac 63 + mobile 60 + remote 53 例（三簇集成合并后 304 回归全绿）。

> v0.5.17 协作簇首项（#87 团队共享会话/评论 ⬜→✅）：lib/collab.ts 单一实现三端消费 —— append-only JSONL 团队线程 + 回复树 + @mention + 身份层 + 会话账本桥（只镜像不改写）；CLI +1 命令（org collab 九子命令）、工具环 +5 工具、Web +2 端点（GET/POST /api/govex/collab）+ 👥 面板 Tab。诚实边界：本地文件协议，多进程强并发不在面内（单机协作场景）。

> v0.5.16 交付治理与扩展批（9 模块 × CLI/工具环/Web 三端接线）：8 项 ⬜→✅（#30 浏览器 DOM/#32 补全/#80 merge·rebase/#113 查询诊断/#132 插件市场/#134 OpenAPI/#147 IaC 扫描/#149 RBAC）+ 2 项 ⬜→🟡 诚实口径（#116 DevTools：DOM 快照/截图交付，console/网络面板是路线图；#56 重命名交付、代码动作路线图）—— 主表 ✅ 108/150。工具环 +13 工具（native 块动态 import 与 lib 同源）+ RBAC 可选门控（ORG_RBAC_ROLE）；CLI +11 命令；Web 🛡 治理与扩展面板（11 端点）。
>
> v0.5.15 交付 12 项升级（6 ⬜→✅：#20 符号/#43 Schema/#52 移动/#73 迁移操作/#85 评审推荐/#89 CODEOWNERS；6 🟡→✅：#24 PDF/#49 diff/#60 干跑/#141 密钥扫描/#148 SBOM/#150 审计导出）——**主表 ✅ 破百（100/150）**；专家表 B10 随 PDF 补齐升 ✅（24/25）。
>
历史统计行曾停留在 v0.5.4 口径且被截断（91/34/25），与表格实态漂移 —— v0.5.15 按表逐行重算并修订三处滞后条目：#128 定时任务 ⬜→✅（v0.5.5 已落地）、#127 出站 webhook 🟡→✅（v0.5.5 已落地）、B9 语义检索 ⬜→✅（v0.5.8 已落地，与 #19 自相矛盾的行）。

---

## 论文叙事建议（本矩阵的三个可论证论点）

1. **治理领先**：第十类（安全与治理）15 项中 13 项落地——能力三态 + 审批文件协议 +
   审计双日志 + 预算水位 + 密钥治理在同类开源 Agent（codex/opencode 的开源形态）中
   属第一梯队；这来自 ORG 的「能力/成本/审批三层治理」架构决策，而非功能堆叠。
2. **专家即流程**：25 项专家能力中 21 项落地的方式是**结构化**（graph SOP + 闸门 +
   资产沉淀），对照主流「系统提示词 + 工具白名单」的人设式专家——这是 ORG 的
   核心创新点（论文第 4 章主材料）。
3. **诚实边界**：⬜ 未做项经 v0.5.15–0.5.18 五批**清零**（终局三 ⬜：#44 IaC 深度、#117
   移动端调试、#133 远程 Agent 于 v0.5.18 落地）——补全/重命名/RBAC/LSP 协议层/断点建议/
   云生态门控/共享会话/HCL 解析/ADB 车道/SSH 会话层已逐一交付；🟡32 是「诚实半面」口径
   （如 #116 DevTools 交付 DOM 快照面、console/网络面板是路线图）。每项剩余边界都有明确
   的路线图挂点（上游 IDE、native 逃生舱、网关扩展），这是「知道边界在哪」的工程证据而非缺点。
