# ORG 能力矩阵 —— 主 Agent 150 项 / 专家 Agent 25 项对照（v0.5.4 底稿 + v0.5.6 增补）

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
| 20 | 符号定义/引用/跳转 | ⬜ | 未做（上游 HSL IDE 有 LSP 雏形；org 侧未接） |
| 21 | 依赖图/调用图 | 🟡 | registry 资产图 + 专家复用/依赖归因（B/C 路径）；代码级调用图未做 |
| 22 | RAG/向量检索 | ✅ | v0.5.8 检索增强生成的检索半环：`@?查询词` → BM25 top-5 命中展开为围栏摘要块自动织入模型上下文（org ask / 直连车道；无命中/异常附注降级不炸）。诚实边界：BM25 词频语义非 embedding 向量 —— embedding 升级是路线图（z-ai SDK 车道预留） |
| 23 | 长期记忆 | ✅ | v0.5.3：runtime/memories/<expert>.md（跨会话注入尾部 40 行）· org memory CLI/Web/`/memory` 三端 |
| 24 | 文档/PDF 读取 | 🟡 | 工具环 fs_read 文本类；PDF 解析未做（native 块可接 python pdf 库——逃生舱在） |
| 25 | 图片/截图理解 | ✅ | v0.5.13 视觉入口：lib/vision.ts（z-ai SDK createVision · 多图 ≤4 · 魔数唤探防伪造 mime · prompt 超长诚实截断）→ Web 📷 按钮（分析→引用闭环：描述追加进输入框可编辑后派单）+ CLI org vision；401/凭据缺席降级 remedy（部署环境配好即全功能） |
| 26 | LSP/DAP 协议集成 | ⬜ | 未做 |
| 27 | AST、语法树与类型信息 | ✅ | **这是 HSL 的本体**：S1-S8 静态铁律 + 38 后端 AST 投射 + 语义对拍 |
| 28 | 增量索引/跨仓搜索 | 🟡 | 静默更新检测 + N 版本冗余 + registry git 资产层；代码索引未做 |
| 29 | 代码图谱/知识图谱 | 🟡 | graph 拓扑（G1-G6 校验 + node/edge 事件可观测）即程序结构图谱；知识图谱未做 |
| 30 | 浏览器 DOM/页面上下文 | ⬜ | 未做（org web 是控制面不是浏览器自动化面） |

## 三、代码生成与理解（31–45）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 31 | 代码生成 | ✅ | 工厂 mint 流水线（mint_hsl 生成 + check 闸门 + fixture 验收 + git 注册）；HSL 38 后端投射 |
| 32 | 代码补全 | ⬜ | 未做（IDE 侧能力） |
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
| 43 | 数据库 Schema/迁移 | ⬜ | 未做（registry 的 git 版本演化是数据层迁移的类似物） |
| 44 | IaC/基础设施代码 | ⬜ | 未做 |
| 45 | 注释/文档生成 | ✅ | run 报告（report.md/memory.md/评分卡）+ hsl-mirror 围栏文档 + CHANGELOG 叙事 |

## 四、编辑与文件操作（46–60）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 46 | 读取文件 | ✅ | 工具环 fs_read（32KB 截断可观测）+ $host.fs.read（2MB 上限 + 路径监狱） |
| 47 | 写入文件 | ✅ | 工具环 fs_write（**能力门 + 审批在环**）+ $host.fs.write |
| 48 | 多文件编辑 | ✅ | 工厂多文件产物 + 补丁 fs.edit 锚点替换；工具环多轮多文件 |
| 49 | diff 预览 | 🟡 | 补丁 apply 前后的 journal 留痕；Web 运行卡叙事；无专用 diff 视图 |
| 50 | patch 应用 | ✅ | merge_patch（三级分类 + 锚点编辑 + 版本归档 + 回退） |
| 51 | 文件搜索/glob | ✅ | 工具环 fs_glob（\*\*/\* 模式 + 上限 200）+ fs_list |
| 52 | 批量重命名/移动 | ⬜ | 未做（shell_run + git mv 的组合可覆盖，无专用入口） |
| 53 | 冲突解决 | 🟡 | 补丁唯一锚点约束（多处命中即拒绝，不猜）；git 层冲突未接 |
| 54 | 撤销/回滚 | ✅ | `org revert`（版本回退本身可逆：当前源先归档）· 会话 fork 反悔通道 |
| 55 | 检查点/快照 | ✅ | **git 作为资产层**（每次 mint/keep/patch 一 commit）+ N 版本冗余 + dist 快照 |
| 56 | LSP 重命名/代码动作 | ⬜ | 未做 |
| 57 | 多仓库/多工作区 | 🟡 | --workspace 显式多区并行（任务队列天然多区）；跨仓联动未做 |
| 58 | 文件监听/自动同步 | 🟡 | 上游 dhv-ts watch 模式；org 侧静默更新检测 + vendored 新鲜度守卫 |
| 59 | 编码、换行、权限处理 | ✅ | vendored fs 层 CRLF 归一化重试 + PYTHONUTF8 + UTF-8 全链（三平台 CI 实证） |
| 60 | 编辑预览/干跑模式 | 🟡 | review 的 dry-run（org review --dry-run）+ 补丁 classify；工具环写动作审批即干跑闸 |

## 五、执行与终端（61–75）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 61 | Shell 命令执行 | ✅ | $host.shell.run（首词白名单 --allow + 60s 超时 + 8MB 上限 + capability_denied 事件）+ 工具环 shell_run（能力门+审批） |
| 62 | 脚本运行 | ✅ | 同上（bun/node 白名单内） |
| 63 | 构建/编译 | ✅ | dhv check（编译期校验）+ emit（38 后端投射）+ py_compile 交叉语法校验 |
| 64 | 启动服务 | ✅ | org web/taskd（守护执行器）；长程任务后台起停 |
| 65 | 安装依赖 | 🟡 | shell_run 可执行 install（白名单内）；无专用依赖管理面 |
| 66 | 环境变量管理 | ✅ | 用户环境不可覆盖层 + org config 注入 + DHV_LLM_\*/ORG_\* 全链传递（双车道合并的历史 bug 档案） |
| 67 | Docker/容器操作 | ⬜ | 未做（shell_run 可达，无专用安全封装） |
| 68 | 远程 SSH | ⬜ | 未做 |
| 69 | 沙箱执行 | ✅ | **多层**：路径监狱（symlink 实解析）+ 首词白名单 + 产物目录隔离 + 工具环能力门 + 审批队列 |
| 70 | 超时/取消/重试 | ✅ | shell 超时 killed 标注 · LLM 180s AbortController + 3 次退避 + 路由器 key 轮换 · 任务 cancel/pause/resume/retry · web abort 票据化 |
| 71 | CI/CD 流水线执行 | ✅ | 本仓库 CI（verify 三平台矩阵 + 单二进制冒烟 + ruff 门禁 + dist 回写）+ release 五目标交叉编译 |
| 72 | K8s/Terraform | ⬜ | 未做 |
| 73 | 数据库迁移/操作 | ⬜ | 未做 |
| 74 | 云服务/云 CLI | ⬜ | 未做 |
| 75 | 发布/部署/回滚 | ✅ | auto-release 打 tag + release 发布 + sha256 + 版本单一来源守卫（org 资产层的发布回滚：revert + 金丝雀 + 蓝绿） |

## 六、Git 与协作（76–90）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 76 | status/diff/log | ✅ | 注册表 git 历史（org status / demo 走读）+ shell_run git 白名单 |
| 77 | 生成 commit message | ✅ | 注册表语义 commit（mint/keep/patch 带语义消息）；deepseek 车道可生成 |
| 78 | 分支管理 | 🟡 | shell_run git 白名单内可达；org 无专用分支面（资产层用 main 单线 + git-chain） |
| 79 | 提交/amend | ✅ | 注册表自动提交 + 留痕（sh_quote POSIX 转义防注入） |
| 80 | merge/rebase | ⬜ | 未做（资产层单线演进 + 补丁线代替合并语义） |
| 81 | 冲突处理 | 🟡 | 同 53 |
| 82 | 创建 PR/MR | 🟡 | 工程流程层（本开发系列即 PR 工作流）；org 无 API 集成 |
| 83 | PR 审查 | ✅ | **监督回路 review 是 org 的核心**（四态 + 复发检测 + 补丁提案 + 金丝雀） |
| 84 | 变更影响分析 | ✅ | 补丁 flow 级闸门（评测分不回退）+ 评分卡漂移 + 影子对比 |
| 85 | 评审人推荐 | ⬜ | 未做 |
| 86 | Issue/工单集成 | 🟡 | 开发流程层（issue 驱动交付，本系列 #28-#31）；org 运行时无 tracker API |
| 87 | 团队共享会话/评论 | ⬜ | 未做（会话账本是单用户文件协议） |
| 88 | 多人协作与角色权限 | 🟡 | 审批决定者署名（by: web/cli）+ 能力三态；RBAC 未做 |
| 89 | CODEOWNERS | ⬜ | 未做 |
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
| 108 | 断点/调试建议 | ⬜ | 未做（DAP 路线图） |
| 109 | 日志查询与关联 | ✅ | 三路事件流（events/journal/llm-stream）归一化合并去重 + replay 时间线 |
| 110 | 性能剖析 | 🟡 | 计量全链（tokens/ms/model_calls）；profiler 未做 |
| 111 | 内存/CPU 分析 | 🟡 | 池并发/预算水位；OS 级分析未做 |
| 112 | 网络请求诊断 | ✅ | 路由器台账（latency/status/key 指纹/usage）+ 连通测试 testLane |
| 113 | 数据库查询诊断 | ⬜ | 未做 |
| 114 | 依赖冲突诊断 | ✅ | vendored 漂移守卫（版本比对 + 浅克隆）+ 锁文件纪律 |
| 115 | 根因分析与验证 | ✅ | 复发计数（跨运行 recurrence.json）→ 补丁提案 → 金丝雀验证闭环 |
| 116 | 浏览器 DevTools | ⬜ | 未做 |
| 117 | 移动端调试 | ⬜ | 未做 |
| 118 | 分布式追踪 | 🟡 | trace 概念在事件 seq/ts 全链贯通；无 APM 接入 |
| 119 | 监控告警关联 | 🟡 | 漂移告警 + 预算水位 + 通知中心；外部监控未接 |
| 120 | 故障复现/最小化 | ✅ | scripted 剧本即「可复现的模型响应录制」+ 故障注入第五类 slow/corrupt |

## 九、扩展与集成（121–135）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 121 | 插件系统 | 🟡 | `org import`（用户 harness 导入 + check 闸门 + 即刻复用）+ 工厂 stock；无动态加载 |
| 122 | MCP 支持 | 🟡 | adapters/bridge.hsl（外部 subagent 登记）；协议翻译未做（登记≠在岗，诚实标注） |
| 123 | 自定义命令 | ✅ | 斜杠命令 22 个 + TUI `:命令` + Web 面板动作（三端同权） |
| 124 | 工作流编排 | ✅ | **HSL graph**（node/edge/guard + G 拓扑校验）+ 监督回路四阶段 + 工厂管线 |
| 125 | 多模型切换 | ✅ | 21 服务商车道 + key 池 + 降级链 + `/model`/`:model`/Web 段控热切换 |
| 126 | 本地模型/API 模型 | ✅ | ollama/lmstudio/vllm 预设免 key 即用 + OpenAI 兼容一条协议打天下 |
| 127 | Webhook/API 调用 | 🟡 | 路由器 fetch 全链 + 工具环 shell/net；出站 webhook 通知未接 |
| 128 | 定时任务 | ⬜ | 未做（taskd 常驻 + 文件协议已具备底座，缺 cron 触发器） |
| 129 | 多 Agent 协作 | ✅ | **org 本体**：主控-专家监督回路 + 工厂铸专家 + 池化 + 暖移交 + 金丝雀双跑 |
| 130 | 工具注册/发现 | ✅ | 工具环注册表 + registry manifest + adapter 登记 |
| 131 | SDK/API Server | ✅ | cliMain 可编程入口 + startWebServer({port:0}) + $host.dhv 嵌入执行面 |
| 132 | 插件/规则市场 | ⬜ | 未做（registry + git 即本地市场形态） |
| 133 | 远程 Agent/云执行 | ⬜ | 未做（沙盒本地执行） |
| 134 | OpenAPI/GraphQL/gRPC | ⬜ | 未做（OpenAI 兼容协议是唯一外部协议面——最大公约数选择） |
| 135 | 评测/基准平台 | ✅ | **评分卡**（证据归因 + 客观/裁判档权重 + 漂移基线）+ fixture-miner 出题 + 诗歌擂台反哺 |

## 十、安全与治理（136–150）

| # | 能力 | 状态 | 实现位置 / 说明 |
|:--|:--|:--|:--|
| 136 | 权限确认 | ✅ | 能力三态（Auto/Confirm/Deny）+ **审批队列文件协议**（四端入口 + 有界等待 + 超时降级拒绝） |
| 137 | 只读/自动/全自动模式 | ✅ | 工具环三档（ORG_TOOLS 未设/1/write）+ 审批在环（未开审批写动作明确拒绝——安全缺省） |
| 138 | 危险命令拦截 | ✅ | 首词白名单 + sh_quote POSIX 转义 + 路径监狱 + 模板目录只读守卫 + rmSync 脚枪防线 |
| 139 | 工作区信任 | ✅ | dist/demo 只读守卫（Web 全动词覆盖）+ 工作区标记检查 |
| 140 | 密钥/环境变量保护 | ✅ | maskSecret 全端（首 3 尾 4）+ key 指纹脱敏台账 + 用户环境不可覆盖层 |
| 141 | 密钥/漏洞扫描 | 🟡 | 危险命令面拦截；依赖漏洞扫描未做 |
| 142 | 审计日志 | ✅ | journal（人读）+ events（结构化）+ approvals resolved 留痕 + llm-ledger + replay 确定性重演 |
| 143 | 成本/Token 限额 | ✅ | 计量全链 + 日预算（budget_requests 路由器强制 429）+ 成本时间线面板 |
| 144 | 数据脱敏 | ✅ | key/args 摘要截断 + preview 60 字符；全量脱敏管道未做 |
| 145 | 登录/API Key/配置管理 | ✅ | org config v3（车道/key 池/降级链/预算）+ env 自动发现 + 连通测试 |
| 146 | SAST/DAST | 🟡 | dhv check 是 SAST 的语言级形态（编译期处决）；通用 SAST 未接 |
| 147 | 容器/IaC 扫描 | ⬜ | 未做 |
| 148 | SBOM/许可证合规 | 🟡 | LICENSE 全仓 + vendored 许可证保留；SBOM 未做 |
| 149 | SSO/RBAC/数据驻留 | ⬜ | 未做（单机 Agent 边界） |
| 150 | 隐私模式/审计导出 | 🟡 | DHV_LLM_DISABLE_SDK 零外联开关 + 产物全本地；审计导出入口未做 |

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
| B9 语义检索 | ⬜ | 同 #19 |
| B10 文档/图理解 | 🟡 | 文本全链；PDF/图未接 |
| C11 工具调用 | ✅ | 工具环六工具 + 能力门 + 审批在环 |
| C12 MCP/插件注册 | 🟡 | org import + adapter 登记（协议翻译路线图） |
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

**统计**：主 Agent 150 项 → ✅ 91 · 🟡 34 · ⬜ 25；专家 25 项 → ✅ 21 · 🟡 3 · ⬜ 1。（v0.5.8：#19

---

## 论文叙事建议（本矩阵的三个可论证论点）

1. **治理领先**：第十类（安全与治理）15 项中 13 项落地——能力三态 + 审批文件协议 +
   审计双日志 + 预算水位 + 密钥治理在同类开源 Agent（codex/opencode 的开源形态）中
   属第一梯队；这来自 ORG 的「能力/成本/审批三层治理」架构决策，而非功能堆叠。
2. **专家即流程**：25 项专家能力中 21 项落地的方式是**结构化**（graph SOP + 闸门 +
   资产沉淀），对照主流「系统提示词 + 工具白名单」的人设式专家——这是 ORG 的
   核心创新点（论文第 4 章主材料）。
3. **诚实边界**：27 项未做集中三类——语义检索/向量（RAG 派）、IDE/LSP/调试器
   （工具派）、云生态（K8s/多云/合规派）。每项都有明确的路线图挂点（上游 IDE、
   native 逃生舱、网关扩展），这是「知道边界在哪」的工程证据而非缺点。
