# CHANGELOG

## v0.5.18.2（2026-09-19）—— CI 追修：macOS openrsync 版本行形态

run 35408498464 残余红（mac cross-platform 仅 1 用例 ×2 段）：macOS 12+ 自带
openrsync 的 `--version` 首行是 `openrsync: protocol version 29`（非
`openrsync version x.y.z` 形态）→ 版本行断言放宽 match /rsync/i（锁 rsync
字样不锁发行版语法）。verify/win/native-smoke 四 job 本轮已绿。

本地 remote 53/53 全绿。
## v0.5.18.1（2026-09-19）—— CI 环境自适应五修（run 35407741607 三平台红清零）

v0.5.18 合并推送后 CI 三 job 红（verify + cross-platform win/mac）——全部是
「沙箱无工具 vs runner 预装」环境面差异，按 v0.5.17.2 哲学（锁形态不锁环境）修：

1. mobileLogcat PATH 置空用例：runner 预装 Android SDK（ANDROID_HOME/常见位置
   探测可绕过置空的 PATH）→ else 分支 ok 断言改 kind 集合（真 adb 无设备
   ok=false 是诚实形态）。
2. mobileApkInfo 魔数车道 reason：缺席「诚实降级」vs 在场 dump 失败「魔数车道
   降级」两种到达方式都诚实 → 断言放宽 match /降级/。
3. remote Web probe：open_ssh 解析结果嵌在 ssh 面对象内（j.ssh.open_ssh）——
   测试键位对齐（runner ssh 在场时才触达该断言，沙箱缺席故本地全绿）。
4. probeRemote rsync 版本行：macOS 12+ 自带 openrsync → 正则放宽
   /^(rsync|openrsync)\s+version/i。
5. win32 假 adb 注入 4 用例（Web devices/logcat + 工具环 e2e×2）补
   skipIf(!POSIX)（POSIX shell 脚本注入 win 不可行，诚实跳过非假红）。

本地验证：mobile + remote 113/113 全绿。
## v0.5.18（2026-09-19）—— 终局三 ⬜ 清零批：IaC 深度 + 移动端调试 + 远程 Agent（⬜3→⬜0，✅118/150）

v0.5.17 三簇批 CI 全绿基线之上，能力矩阵**终局三 ⬜ 清零**（子智能体 15-A/15-B/15-C
三 worktree 并行，主 Agent 集成收尾）：3 项 ⬜→✅（#44/#117/#133），主表 **✅ 118/150
（🟡32 · ⬜0）**——150 项能力矩阵未做项清零。测试 977 → **1093**（+116：iac 63 ·
mobile 60 · remote 53，三簇共享文件合并边界修复后集成回归 304 全绿）。

### 一、IaC 深度实现簇（#44）—— lib/iac.ts 1786 行（与 #147 iacscan 扫描面互补）

- **内置 HCL 子集解析器**（零依赖主车道）：block 九族（terraform/provider/resource/
  data/variable/output/locals/module）/引号与裸 label/基础类型/list/嵌套 object（尾逗号
  容忍）/**heredoc**（<< 与 <<- 公共缩进剥除 + 体内插值）/插值表达式（traversal/函数
  调用/索引/splat（suffix 属性链保持顶层）/一元二元三元）/$${ 转义/注释三形态；行号级
  诚实报错。
- **parseValue 标量统一走 parseExpr 车道**（v0.5.18.1 修复）：count = var.x + 1 /
  三元等续接不再被「赋值后须换行」截断；表达式域 boolv/nullv 字面量折叠回 IacValue 域。
- **资源依赖图**：iacGraph（var/local/data/module/资源地址/depends_on 双来源去重边 +
  Kahn 拓扑序 + DFS 环检测（最多报 3 条）+ 未声明引用诚实警告 + locals 字面量属性
  降粒度不入图）。**人读 Plan**：to create N resources 风格 + 依赖序 + 与真
  terraform plan 差异五条诚实尾注。**manifest 逆向生成**：iacGenerate（provider +
  variable 提取（$ref 自动变量）+ resource + output），iacParse 往返自洽。
- **外部车道**：probeIac（terraform/tofu/tflint 探测）+ iacValidate（在场
  terraform validate -json 只读；缺席→内置车道为主车道）。
- 三端：CLI org iac 六子命令 · 工具环 iac_parse/plan/graph/generate（全只读）·
  Web ⚒ 面板（GET /api/govex/iac 五动作）。

### 二、移动端调试簇（#117）—— lib/mobile.ts（多重优雅降级全链）

- **四层降级**：devices（adb 缺席→无设备→未授权；devices -l 五字段解析 + usb:1-1
  transport 保留 + iOS idevice 面）/ logcat（-d 快照五元组：时间/进程/级别/tag/消息；
  -s TAG 服务端过滤 + pidof 包名过滤；行数 1..2000 钳制）/ forward（adb→设备→
  /proc/net/unix socket 发现→CDP /json 页面清单，本地端口可达性探测）/ apk（aapt
  badging 解析→PK 魔数降级）。
- **plan 纯函数保底**：平台（android/ios/both）× 症状（crash/白屏/network/性能/
  构建/安装/webview，CJK 关键词归一）矩阵 → 步骤化计划（每步可粘贴命令 + 预期 +
  降级指引）——零外部依赖永远可用。install/uninstall 只出现在计划文本里，任何执行
  面全只读。**mobileSelfTest 8/8 自检**。
- 三端：CLI org mobile 七子命令 · 工具环 mobile_devices/logcat/plan（全只读）·
  Web 📱 面板（GET /api/govex/mobile 四动作 + selftest）。

### 三、远程 Agent 簇（#133）—— lib/remote.ts（会话/部署/计划层，与 #68 cloud_ssh 互补）

- **主机档案门**：remote-hosts.json（name→host/user/port/identity 路径；**私钥内容
  PEM 头混入拒绝 + password 字段拒绝**；host 不在档案拒绝不猜默认）。
- **remoteExec 会话级执行**：ssh -o BatchMode=yes -o ConnectTimeout=8 -o
  StrictHostKeyChecking=accept-new 构造 + 白名单默认只读九命令 + 元字符拒 +
  allow_full 显式 + 三类诊断（超时/拒连/鉴权含指纹漂移）。
- **remoteSync** rsync→scp→指引三层降级（local 过 pathjail）；**remotePing** ssh
  echo 往返三统计（min/avg/max，部分降级只计成功轮）；**remoteDeployPlan** 四模式
  （摸底/git/rsync/容器三式 + run 队列远程化（org web + 网关模型）+ 回滚，纯函数保底）。
- 三端：CLI org remote 六子命令 · 工具环 remote_probe/plan/ping（只读）+
  remote_exec（**process_spawn 门 + 审批在环**——capability 映射缺失曾致合并版
  门控旁路 120s 卡死，已修）· Web 🛰 面板（GET /api/govex/remote 四动作）。

### 四、集成与流程沉淀

- **三 worktree 并行**（wt-iac/wt-mobile/wt-remote 各挂 feat 分支）——子智能体真
  并行不踩工作区；15-A 超时后产物修复收尾（7 处实现/测试不收敛点：parseValue 表达式
  车道/splat 顶层/未收口报错含 labels/locals 降粒度/CLI 措辞/heredoc 期望自洽/web
  内联转义）。
- **合并边界修复**：三共享文件（cli/org.ts · hsl/pool/tools.hsl · web/entry.ts）
  三轮合并的**双侧保留边界截断**系统性问题——干净重建策略（mobile 侧完整版 + iac
  增量 apply）+ 函数区整体重建 + 能力映射（process_spawn 门）补齐。
- 版本 0.5.18 四件套对齐；capabilities.md #44/#117/#133 ⬜→✅ + 统计行 ✅118/⬜0 +
  v0.5.18 交付段 + 论文叙事第 3 点「未做项清零」更新。

## v0.5.17（2026-09-19）—— 三簇主攻批：LSP/DAP 深度 + 云生态 + 团队协作（⬜10→⬜3）

v0.5.16.1 CI 全绿基线之上，能力矩阵剩余 ⬜ 项三簇并进（子智能体 14-A/14-B/14-C
并行批次，主 Agent 统一收尾）：7 项 ⬜→✅（#26/#108/#67/#68/#72/#74/#87），
主表 **✅ 115/150**（🟡32 · ⬜3：#44 IaC 深度实现 / #117 移动端调试 / #133 远程 Agent）。
测试 867 → **977**（+110：lsp 41 · cloud 43 · collab 26）。

### 一、LSP/DAP 深度簇（#26 + #108）—— lib/lsp.ts 880 行 · lib/debug.ts 471 行

- **#26 LSP/DAP 协议集成**：JSON-RPC 2.0 分帧层（Content-Length 流式解码：
  粘包/半包/CJK 字节精确/坏帧跳过）+ 构造器全家桶（request/response/notification）
  + initialize→initialized→shutdown→exit 完整生命周期；**双车道**——内置符号索引
  车道（definition/references/hover，LSP 0 基 uri/range + 人读 1 基双形，零依赖）
  与外部 server 车道（detectLspServers 7 家 which 探测 + spawnLspServer/LspClient
  真协议对话）。echo 型假 LSP server 测试锁定协议层真实可用。
- **#108 断点/调试建议**：suggestBreakpoints（symbol 级入口 + heuristic 级
  分支/循环/return 前一行，confidence 双级 + reason）+ DAP 构造器四件套
  （与 LSP 分帧层共用）+ debugPlan（7 步调试计划）。诚实边界：真 DAP attach
  是路线图，协议封装已就绪。
- 三端接线：CLI `lsp`（definition/references/hover/servers/protocol 五子命令）+
  `debug`（suggest/plan/dap）；工具环 6 工具（lsp_definition/lsp_references/
  lsp_hover/lsp_servers/debug_breakpoints/debug_plan）；Web `/api/govex/lsp`（5
  动作）+ `/api/govex/debug`（3 动作）+ 🐞 LSP/DAP 面板。

### 二、云生态簇（#67/#68/#72/#74）—— lib/cloud.ts 五层降级

- **#67 Docker**：白名单子命令封装（build/run/ps/inspect 等，破坏性命令一律
  拒绝）+ 数组参数 spawn + daemon 探测；降级车道 dockerfileFor（node/bun/
  python/rust 四型多阶段模板）+ composeFor + dockerPlan（可粘贴命令序列）。
- **#68 SSH**：host 白名单门控（ssh-hosts.allow 文件，缺省拒绝 + 创建指引）+
  BatchMode/ConnectTimeout/StrictHostKeyChecking 安全参数；降级车道
  sshConfigTemplate + sshPlan；scp 同门控。
- **#72 K8s/Terraform**：kubectl 白名单 + 集群可达性探测；降级车道
  k8sManifestFor（Deployment/Service/Ingress/ConfigMap/PVC，带资源限额/探针）
  + terraform 骨架。
- **#74 云 CLI**：10 家注册表（aws/gcloud/az/gh/vercel/flyctl/railway/heroku/
  doctl/oci）批量探测 + installHint，与 21 家模型服务商注册表全景联动。
- **探测灵魂**：cloudProbeAll() 全景探测单一入口（存在≠可用，坏安装按缺席
  降级），CLI `cloud` / 工具环 6 工具 / Web ☁ 云生态区块三端同源。

### 三、团队协作簇（#87）—— lib/collab.ts 向后兼容铁律

- 单用户会话账本（lib/sessions.ts）之上叠多用户协作层：**runtime/collab/
  threads/*.jsonl append-only 协议**（seq 单调 + replyTo 回复树 + @mention
  自动抽取 + sinceSeq 增量读）；协作者视图（collaborators 去重计数）+ 协作
  摘要（collabSummary）；**桥（bridgeSession）**把单用户账本镜像成团队线程
  （kind:"system"，只镜像不改写——tests 前后 hash 对拍锁定）。
- lib/sessions.ts 一行不改（向后兼容铁律），既有 session 测试原样全绿。
- 三端接线：CLI `collab`（whoami/user/threads/feed/post/comment/users/
  summary/bridge）；工具环 5 工具；Web 👥 团队协作面板（发帖/评论表单 +
  回复树渲染 + XSS 转义）。

### 验证

- 三簇定向 165/165（lsp 41 · cloud 43 · collab 26 · check 守卫 55）+ 全量
  **973 pass / 0 fail / 4 skip**（977 例 · 53 文件 · 5413 断言 · 338s）。
- capabilities.md 统计行新口径与表格实态由防漂移守卫锁定一致。

## v0.5.16.1（2026-09-19）—— CI 红灯清零补丁：win32 监狱混形 + gitmerge CRLF + payload 编译态

3a7af68（v0.5.16 合并推送）后 CI 五 job 两红（run 35367288947）：verify 的
payload 新鲜度门 + win32 cross-platform-tests 三用例。三处根因 + 一处潜伏
编译态缺陷，同批清零：

### 一、win32 监狱混合分隔符假性越界（系统性 · pathjail 单点收敛）

- **实锤**：`complete_at` 对合法相对路径 `src/app.hsl` 报「路径越界」——
  native 块把 ws 归一成 `/` 形（`.replace(/\\/g,"/")` 绝对路径原样保留），
  而 `path.resolve()` 在 win32 产 `\` 形，混形前缀比较必然失败。
- **同病潜伏一并修**：`git_merge`/`git_rebase` 显式 repo 参数、
  `plugin_install` 本地源、`browser_screenshot` 相对 out（同混形模式）；
  7 处 `wsReal` 型监狱对绝对路径输入的同类隐患（正斜杠绝对输入 vs
  realpathSync 反斜杠根）。
- **修复**：新增 `lib/pathjail.ts` —— `canonFor/inWsFor`（平台参数化）+
  `inWorkspace/jailCanonical/jailRelative/resolveInWorkspace`（当前平台）。
  比较形统一 `/` 分隔符 + win32 大小写折叠（D: vs d: 文件系统不敏感）+
  POSIX 保持大小写敏感。10 个工具站点全部接入，fs_move 保留零硬依赖
  （DHV_TS 缺席时内联同形回退 —— 多重优雅降级）。
- **回归钉**：`tests/pathjail.test.ts`（14 例）—— THE bug shape 正反两向、
  盘符大小写、POSIX 不折叠、前缀边界（ws-evil ≠ ws 子路径）、词法逃逸
  仍拒绝（修复不放松监狱）。平台参数化使 win32 分支在任意宿主可测。

### 二、gitmerge 测试 CRLF 双层防线

GitHub win32 runner 机器级 `core.autocrlf=true` 在 merge --abort /
checkout 重写文件时把 LF blob 涂成 CRLF → 字节精确断言假红（两个冲突
自动 abort 用例）。**第 1 层**：测试仓播种时 `core.autocrlf=false`
（makeRepo + makeCloneRepo，跨平台确定性）；**第 2 层**：`read()` 助手
CRLF→LF 归一（语义断言，与 turing.test.ts normOut 同规）。

### 三、payload 再生（verify 新鲜度门）

合并冲突取 org 侧旧 payload（1,289,806B）vs 接线版（1,289,954B）→
`bun scripts/build-bin.ts --payload-only` 再生提交。

### 四、编译态工具环 lib/ 缺席（潜伏缺陷 · native-smoke 盲区）

编译态 ROOT=解包目录，而 PAYLOAD_ROOTS 不含 `lib/` → 工具环 native 块
`import(root+"/lib/*.ts")` 在单二进制形态下 15 个工具全断（native-smoke
只跑 check/demo/TUI 不踩工具环，故未暴露）。**修复**：`lib` 入
PAYLOAD_ROOTS（38 文件 · payload 1,260→1,907 KB），lib 均为自包含 TS
（node 内建 + lib 内相对引用 + bun:sqlite）全量嵌入免维护清单；
`tests/pathjail.test.ts` 加守卫防 PAYLOAD_ROOTS 回退静默复发。

## v0.5.16（2026-09-18）—— 治理与扩展批：9 模块统一接线（CLI / 工具环 / Web 三端）

9 个 lib 模块（dbdiag/gitmerge/rbac/iacscan/plugins/openapi/browser/
completion/rename，153 专项测试先行落地）统一接入三端消费面，沿用
v0.5.15 的「lib 单一实现 → CLI / 工具环 / Web 三端」与 native 块
`await import(root+"/lib/x.ts")` 动态导入同源范式。

### 一、CLI（+11 命令）

| 命令 | 能力 |
|:--|:--|
| `org dbdiag <x.db\|:memory:> "SELECT…" [--setup SQL]` | #113 EXPLAIN QUERY PLAN 诊断 |
| `org merge [--no-ff] [--message M] <source>` / `org rebase <onto>` / `org mergestate` | #80 冲突恒 abort + 清单 |
| `org rbac [list\|check <角色> <动作>]` | #149 角色权限查询 |
| `org iacscan [dirs…]` | #147 容器/IaC 16 规则 |
| `org plugin [list\|install\|remove\|validate]` | #132 事务性安装只装不执行 |
| `org openapi <spec.json>` | #134 3.x/2.0 解析 + 工具命名建议 |
| `org browser [status\|snapshot\|screenshot]` | #116/#30 多引擎降级 |
| `org complete <file> <line> <col>` | #32 三级候选补全 |
| `org rename <old> <new> [--apply]` | #56 缺省 dryRun 预览 |

### 二、工具环（+13 工具 + RBAC 可选门控）

- 只读（ReadOnly 可用）：`db_diagnose` / `rbac_check` / `iac_scan` /
  `openapi_parse` / `plugin_list` / `browser_snapshot` / `complete_at`
- 写动作（Full + 审批在环）：`git_merge` / `git_rebase` /
  `plugin_install` / `plugin_remove` / `browser_screenshot`（PNG 落工作区）/
  `rename_symbol`（缺省 dryRun 预览）
- 浏览器工具超时预算收敛引擎侧既有约束（1-60s 钳制，缺省 30s）
- **RBAC 可选门控**（execute_tool 分发处最外层）：`ORG_RBAC_ROLE` 未设 =
  完全不启用（零行为回归，单机缺省 owner 全放行）；设了 → 每工具调用判
  `tool:<name>`，拒绝返回含 rule/reason 的工具错误并落两处审计
  （journal `rbac_denied` 事件 + `runtime/rbac.jsonl` 决策账本）；
  插件 manifest 的 permissions 字段与该命名空间联动（执行面路线图）

### 三、Web 🛡 治理与扩展面板（8 区 11 端点）

IaC 扫描 / 插件清单+安装表单 / RBAC 角色查看 / OpenAPI 上传与粘贴解析 /
浏览器快照+截图 / dbdiag 表单 / 补全+重命名表单（真写可选）/ git
状态+merge+rebase —— `/api/govex/*`；写端点用真实工作区 + dist/demo
只读守卫（与 /api/memory 同规）。**顺带修复 v0.5.15 遗留**：工具箱面板
（🧰）与遮罩缺 display CSS（页面加载即常显）—— 本轮与治理面板同款补上。

### 四、能力矩阵与版本口径

- capabilities.md 10 行修订：8 项 ⬜→✅（#30/#32/#80/#113/#132/#134/#147/
  #149）+ 2 项 ⬜→🟡 诚实口径（#116 DevTools：DOM 快照/截图交付，console/
  网络面板路线图；#56 重命名交付、代码动作路线图）+ #121 插件系统补市场
  半面注记 —— 主表 ✅ 100→**108**/150 · 🟡 30→32 · ⬜ 20→10
- 版本对齐：lib/version.ts 0.5.15→0.5.16；package.json 0.5.14→0.5.16
  （漂移两版）；README 徽章与状态注记
- build/payload.json 再生（tools.hsl 变更）

## v0.5.15（2026-09-18）—— 桌面 Agent 补全批 + CI 红灯清零 + 漂移治理

实测驱动的三线交付：**① org CI 连续 8 run 红灯的根因清零**（payload 过期 /
跨平台测试假红 / notify 超时）；**② 能力矩阵 12 项升级，主表 ✅ 破百
（100/150）**——数据库 / diff 干跑 / 符号跳转 / PDF / 密钥扫描 / 审计导出 /
SBOM / CODEOWNERS，每项 = lib 实现 + 测试 + CLI + 工具环 + Web 工具箱五端；
**③ 治理漂移修订**（capabilities.md 三处滞后条目 + 统计行防漂移守卫）。
测试 668/668 全绿（31 文件，+118 例）。

### 一、CI 红灯清零（P0）

- **payload 再生**：v0.5.6–v0.5.14 源码变更未再生 build/payload.json
  （verify job 的「payload 新鲜度」闸门连续 8 run 红）—— 再生后指纹入库。
- **跨平台测试五重防御**：turing.test.ts 工具缺席优雅降级（ruff/rustc/g++/
  python3 缺失 → test.skip 可见理由，裸检出 bun test 不假红）+ win32 可执行
  后缀（rustc/g++ 产物 .exe，execFileSync 不自动补）+ CRLF 归一（MSVC CRT
  文本模式 \r\n）+ cross-platform-tests job 补装 ruff（原先只有 ubuntu 装）+
  ruff-gate/ruff.test findRuff 的 win32 .exe 兼容。
- **notify 双修**：desktopNotify tryCmd 预算 5s→3s（headless Windows
  powershell toast 挂满 5s 拖爆 bun 默认用例超时，CI 实录 5334ms）+ 用例
  显式 15s 超时。

### 二、能力补全（12 项，主表 ✅ 91→100）

全部遵循「lib 单一实现 → CLI / 工具环 / Web 三端消费」与「动态 import 同源」
（工具环 native 块 `await import(root + "/lib/x.ts")` —— 行为等价由构造保证）：

| 能力 | 实现 | 三端入口 |
|:--|:--|:--|
| #43/#73 数据库 Schema/迁移/操作 | lib/db.ts（bun:sqlite 零依赖 · 双层只读门 · 版本化迁移账本） | org db / db_schema·db_query·db_migrate / Web 🗄 |
| #49/#60 diff 预览/干跑 | lib/diff.ts（GNU diff -u 对拍一致 · LCS + 快速路径） | org diff / fs_write·fs_edit preview:true / Web |
| #20 符号定义/引用 | lib/symbols.ts（HSL/TS/PY 词法索引 · 600 文件帽） | org symbols / symbol_search / Web 🔎 |
| #52 文件移动 | 工具环 fs_move（审批在环 + 双层监狱 + 防自嵌套） | fs_move / — / — |
| #24 PDF 读取 | lib/pdfread.ts（pdftotext → uv+pypdf → 诚实失败） | org read / read_pdf / — |
| #141 密钥扫描 | lib/scan.ts（18 类模式 · 脱敏预览） | org scan / fs_write 写入拦截 / Web 🛡 |
| #150 审计导出 | lib/audit.ts（零依赖 zip + md 摘要） | org audit / audit_export / Web 📦 |
| #148 SBOM | lib/sbom.ts（SPDX-2.3 · spdx-tools 校验 0 错） | org sbom / — / Web 📋 |
| #85/#89 评审推荐/CODEOWNERS | lib/owners.ts（GitHub 兼容子集 · 启发式降级） | org owners / review_suggest / Web 👥 |

fs_write 密钥拦截策略：高危（sk-/ghp_/AKIA/私钥…）拒绝落盘（ORG_SCAN=off
逃生口）· 中低危告警放行；preview 干跑 = 执行语义（锚点唯一性同样校验）。

### 三、治理漂移（P1）

- capabilities.md：#128 定时任务 ⬜→✅（v0.5.5 已落地）、#127 出站 webhook
  🟡→✅（v0.5.5）、B9 语义检索 ⬜→✅（v0.5.8）三处滞后修订；统计行重算
  （91/34/25 → 实态 88/36/26 → 交付后 100/30/20）。
- **统计行防漂移守卫**（tests/check.test.ts 4 例）：主表 150 行齐全 + 专家
  表 25 行齐全 + 统计行与表格实态机械一致 + 截断残留防复发 —— 改表不改行
  CI 当场红，漂移治理从「人工对齐」变「机械锁定」。
- 21 家服务商计数修正（provider-registry 注释与 CLI help 均写「20 家」）；
  dashscope 拼写修正（dashqueue → dashscope）。

## v0.5.14（2026-09-16）—— 直连车道语义地板 + 救援（B-22）

agent-browser QA 驱动 Web GUI 直连模式发现：**GUI 缺省专家 notice-parser +
scripted 模型，问「你好」/「请创作卡农」得到的是公告域罐头答案**（字段映射
规则 memo）—— B-19 的直连车道变体（v0.5.10 只修了团队车道）。本轮把同一套
「语义地板 + 救援 + 降级」三岔口哲学落到直连 ask（Web askOnce/askStreamOnce
+ CLI cmdAsk 双入口同构），另修复 QA 探测中发现的 vision 端点宽容解析与一枚
潜伏的 CLI `dim` 未定义雷。测试 550/550 全绿（+14 例：directgate D1-D7，30 文件）。

### B-22 直连车道语义地板（三岔口）

- **`directAskGateOf`（lib/engine.ts 共享闸门）**：仅 scripted 车道介入（真实
  LLM 天然域感知，任何专家答任何问题）——
  ① `passthrough`：选中专家域内（`direct:<name>` 轨道语料或 manifest 词面
  重合 ≥ 0.15 地板）→ 原行为零变化；
  ② `reroute`：域外但注册表有域内专家（`rescueExpertOf` 复用）→ 换专家 +
  换剧本应答 + `lane_rescue` 事件前插（回放面板 ⇄ 卡）+ 救援轮默认开工具环
  （`ORG_TOOLS=write`，与团队救援同规则 —— audio_compose/fs_write 交付需要）；
  ③ `degrade`：域外且无可救援 → **零消耗诚实降级**（不跑模型不落账本，
  `writeDirectDegradeRun` 产物直写 + 建议出口四条）；
- **附带修复**：选中专家在可用剧本中无 `direct:<name>` 轨道时（旧路径会在
  消费阶段 FIXTURE_EXHAUSTED 硬失败）也走 ②/③ —— 硬失败变三岔口；
- **超短问题口径差异**（与团队车道有意不同）：「你好」这类 1-token 域外
  问题在直连车道**也降级**（团队车道保守放行）—— 直连的降级是一段可读
  应答而非拦路墙，答非所问的罐头更糟；
- **Web GUI**：reroute 轮 who 行亮出 `⇄ 救援自 <原专家>（重合 0.00 < 0.15
  地板）` 琥珀徽标（`.rsc-badge`）+ 有效专家名；degrade 轮 `◌ 零消耗` 灰
  徽标 + `.t-bot.degraded` 左竖线暗色气泡 + obs 行「本轮零消耗，未落账本」；
- **CLI**：`org ask notice-parser "请创作卡农"` → `⇄ 直连救援 → composer
  （原选 notice-parser 重合 0.00 < 0.15 地板 · 域内专家评分 0.75）` +
  WAV/MIDI 开袋即食；降级轮退出码 0（诚实降级不是失败）。

### 附带修复

- **vision 端点宽容解析**（QA 探测发现）：`POST /api/vision` 的 `images[]`
  此前只认 `[{base64, mime}]` 对象形态，裸 `"data:image/...;base64,..."`
  字符串元素会得到困惑性的「图片为空（未读到内容）」—— 现两形态都收，
  data URL 前缀统一剥离；
- **CLI `dim` 未定义潜伏雷**（v0.5.3 @引用展开引入，本轮 D3 测试首次踩响）：
  `cli/org.ts` 引用 `dim` 却从未定义，非 TTY 管道下 ReferenceError 炸退出
  码 —— 补 `isTTY` 守卫的本地助手（TTY 才着色，管道/测试拿纯文本）。

### 测试

- 新增 `tests/directgate.test.ts` 14 例：D1 单元三岔口定标（域内放行 /
  域外救援 / 完全域外降级 / 超短降级 / 真实车道旁路 / 占位剧本旁路 /
  空问题旁路 / 无轨道专家不硬失败）· D2 CLI reroute e2e（WAV + 账本 + 事件前插）· D3 CLI
  degrade e2e（零账本 + 产物诚实 + 退出码 0）· D4/D5 Web SSE reroute/
  degrade（done 帧 rescue/degraded 元数据 + 音频 + 观测面）· D6 域内零影响
  （公告问题原罐头答案）· D7 GUI 要素（rsc-badge 样式 + finalize 渲染 +
  内联脚本自洽回归锚）；既有 tools.test.ts @mention 用例措辞域内化
 （B-22 后域外措辞不再落 notice-parser 账本 —— 新契约的诚实适配）。

## v0.5.13（2026-09-16）—— 视觉入口 + 派生池清理 + 双 UI 修复（B-20/B-21）

agent-browser QA 复测 v0.5.12 稳定性时发现两枚 UI 回归，随本轮新能力一并
修复交付。**能力面三新增**：📷 图片分析（capabilities #25 ⬜→✅，重点方向①
再下一城）· 🔊 声音试听 · 🧹 派生池清理（worklog 风险 #3/#5 收口）。
测试 536/536 全绿（+24 例：vision 22 + B-20/B-21 回归 2）。

### 双 UI 修复（QA 发现）

- **B-20 幽灵转写浮条**：`.mictx`/`.schmeta` 定义了 `display:flex`，其
  特异性覆盖 UA 的 `[hidden]{display:none}` → v0.5.12 起「⠋ 转写中…」
  浮条**从页面加载即常驻显示**（`hidden` 属性形同虚设）。修复：全局
  `[hidden] { display: none !important; }` 防护规则（一劳永逸防再犯；
  `.rchip[hidden]` 定向规则保留双保险）。回归测试锚定两受害元素 + 防护规则；
- **B-21 Enter 派发无视团队模式**：textarea 的 Enter handler 无条件
  `ask()`（直连车道），完全忽略 `state.mode` → 用户切「团队」后按回车
  （最常用路径）UI 显示团队、行为却是直连。修复：Enter 与 send 按钮
  onclick 同构分派（`state.mode === "team" ? runTeam(text) : ask()`）；
  回归测试锚定 Enter 块内含 mode 分派。修复后团队模式卡农全链路 QA 复验：
  Enter → 团队 → 语义地板 0 < 0.15 → ⇄ 跨车道救援 → composer →
  audio_compose → ♪ 24.7s WAV + MIDI（B-19 修复持续有效）。

### lib/vision.ts（视觉入口执行层）

- `analyzeImages`：图片 Buffer 列表 + prompt → VLM 描述。**校验全在 SDK
  调用前**：张数 ≤4 · 单图 ≤10MB · mime 白名单（png/jpeg/gif/webp/bmp）·
  **魔数嗅探防伪造 mime**（声明 png 但内容 jpeg → 拒绝）· prompt >2000
  诚实截断（truncated 标注）· 缺省提示词兜底；
- SDK 车道：`chat.completions.createVision`（多 content 消息：text +
  image_url×N data URL · thinking disabled）· 空结果明确错误；
- **多重优雅降级**（与 voice.ts 同构纪律）：401/凭据缺席 → remedy 文案
  （部署环境配置后即刻可用，文本交互不受影响）· `DHV_VISION_DISABLE_SDK=1`
  零外联开关 · `setZaiFactory` 测试注入口（22 例全 mock 零外联）；
- `visionStatus` 健康探测（凭据在首次调用时校验 —— 与 voice 同语义）。

### Web GUI（web/entry.ts）

- `POST /api/vision`：两种 body 形态（便捷单图 `{image_base64, mime?,
  prompt?}` / 多图 `{images:[{base64,mime}], prompt}`）；凭据缺席 503
  JSON；`GET /api/vision-status`（60s 缓存）；
- **📷 composer 图片钮**（🎤 旁，同构分析→引用闭环）：file picker（多选
  ≤4）→ FileReader → 分析中浮条（「N 张 · NKB」+ spinner）+ 按钮琥珀脉冲
  （vispulse）→ 描述追加进输入框（🖼 前缀，可编辑后回车派单）；失败
  诚实提示 + busy 复位（降级路径按钮不卡死）；
- **🔊 声音试听钮**（vocard 右上角）：该声音合成一句自我介绍并播放
  （互斥：新试听先停旧 · busy/play 态 · 401 降级按钮复位 + 人话提示）；
  试听不切换选中（stopPropagation）；
- **🧹 派生池清理**：统计条「清理失败」/「重置池」钮（confirm 两步）+
  行级 🗑 删除钮（hover 浮现，失败行常显 + 红沿 failrow 态）；
  `DELETE /api/spawns`（body `{mode:"failed"|"all", ids?}` —— 池登记
  移除 + spawn/<id> 目录整删 + 孤儿半成品 failed 语义 + **路径越界守卫**
  + pool.json 回写；空态也能清理孤儿目录）。

### CLI

- `org vision [图片...] [--prompt "问题"]`：多图 ≤4 分析输出（魔数嗅探，
  不信任扩展名）；无参 → 服务状态 + 用法（退出码 3 = 未就绪）；
- `org spawn [prune --failed | --all [--dry-run]]`：派生池观测（列表 +
  统计 + 孤儿计数）与清理（dry-run 预览 · 越界守卫 · 与 Web DELETE 同
  语义）。

### 踩坑记录（模板字符串内嵌 JS 的转义陷阱）

GUI 脚本嵌在 TS 模板字符串里输出 —— 源码里的 `\n`（字符串或**注释中**）
都会被模板先解释为真实换行 → 浏览器端 JS 字符串断行 / 注释断行致代码
污染（SyntaxError）。修复：字符串用 `"\\n"`（输出字面转义）；注释避免
反斜杠转义。教训锚定在 vision.test.ts 的内联脚本自洽断言（new Function
不抛 = 全脚本语法健康）。

## v0.5.12（2026-09-16）—— 语音入口：ASR 转写 + TTS 朗读（capabilities #15 🟡→✅）

worklog 风险清单 #1（重点方向①剩余）落地：语音输入/输出。`lib/voice.ts`
封装 z-ai SDK 的 audio.asr / audio.tts（后端专用），Web GUI 三入口（🎤 录音
转写 / 🔊 回复朗读 / 🎙 设置面板）+ CLI 两命令（org speak / org voice）。
**多重优雅降级**贯穿：SDK 凭据缺席 → 明确提示（文本交互不受影响）；本沙箱
实测 401 路径完整，部署环境配好凭据即全功能。测试 512/512 全绿（+21 例）。

### lib/voice.ts（执行层）

- `transcribeAudio`：音频 Buffer → base64 → ASR `{text}`；空音频/超 15MB/
  空转写 → 明确错误；401 → remedy 文案（部署提示）；
- `synthesizeSpeech`：句子边界分段（段上限 1000，SDK 硬限 1024）→ 逐段
  **PCM 合成** → 拼接 → **自封 WAV 头**（24kHz PCM16 单声道，与
  lib/audio.ts 同构手法 —— 不依赖 SDK wav 内部格式，行为确定可测）；
  超过 4096 字诚实截断（truncated 标注）；**LRU 缓存**（32 条 / 8MB，
  text+voice+speed 键 → 零重复计费）；
- 7 声音白名单（tongtong/chuichui/xiaochen/jam/kazi/douji/luodo）+
  语速 clamp [0.5, 2.0]；`DHV_VOICE_DISABLE_SDK=1` 零外联开关（对齐
  DHV_LLM_DISABLE_SDK 惯例）；`setZaiFactory` 测试注入口（全 mock 零外联）。

### Web GUI（web/entry.ts）

- `POST /api/asr`（body `{audio_base64}`，dataURL 前缀容忍）→ `{ok,text}`；
  `POST /api/tts`（body `{text,voice,speed}`）→ audio/wav 二进制 +
  `X-Voice-Chunks`/`X-Voice-Truncated` 头；`GET /api/voice-status`（60s
  缓存）——凭据缺席 503 JSON（GUI 显示提示条）；
- **🎤 录音转写**：composer 左侧麦克风钮 → MediaRecorder（webm）→ base64
  → /api/asr → 转写文本进输入框（追加不覆盖）；录制中红点脉冲动画 +
  转写中 spinner 浮条；浏览器不支持 → 按钮降级隐藏；
- **🔊 朗读**：每轮回复操作行的喇叭钮（复制旁）→ /api/tts → Audio 播放
  （⏹ 可停、播完自动复位、截断/分段 toast 提示）；
- **🎙 语音面板**：顶栏 rchip → 声音网格（7 卡片选中态）+ 语速滑条
  （×0.50-×2.00 实时显示）+ 服务状态行（探测/重新探测）+ 用法注解；
  选择记忆 localStorage（跨会话保持）；Esc 栈式关闭。

### CLI（cli/org.ts）

- `org speak "文本" [--voice v] [--speed s] [--out file.wav]`：TTS 落盘
  （摘要行：KB · 声音 · 语速 · 段数 · 截断标注）；
- `org voice`：服务状态探测 + 声音清单（未就绪退出码 3）。

### 测试（tests/voice.test.ts · 21 例全 mock）

- 纯函数 5：分段（句子/逗号/硬切边界、空白归一、无损重组）+ 声音/语速
  归一；
- 模块层 9：单段 WAV 封头（RIFF/24kHz/单声道/PCM16 全参数断言）+ 多段
  PCM 连续拼接 + 超长截断 + 缓存命中（零重复调用）+ 401 降级文案 +
  ASR 成功/空结果/超限 + 禁用开关 + 状态探测；
- Web 端点 5：voice-status / tts 200+头 / asr 200+dataURL / 双 503 降级 /
  GUI 要素（面板/按钮/注入的声音清单/内联脚本自洽）；
- CLI 2：零外联开关路径（任何环境一致的确定降级；mock 不跨进程——
  成功路径已在模块层覆盖）。

## v0.5.11（2026-09-16）—— 子生孙递归派生深化：预算继承 + 池化重档 + 派生池面板

v0.5.6 的 agent_spawn 只有深度治理（ORG_SPAWN_MAX），**无预算语义**
（子组织可无限烧 token）、**无池化登记**（相似任务不能复用、spawn 目录用完
即弃）、**无 Web 观测面**（只能看运行卡 tool_call 通知）。本版补全三块：
**双重治理**（深度帽 + 预算随深度指数衰减）、**池化重档**（相似 goal 零成本
复用）、**🌳 派生池面板**（Web GUI 独立操作面板：树形视图 + 统计 + 展开
详情）。测试 491/491 全绿（+7 例：spawn 预算/池化 4 例 + Web 端点/自洽/GUI 3 例）。

### 预算继承（hsl/pool/tools.hsl tool_agent_spawn）

- `ORG_SPAWN_BUDGET`（份数）：未设 = 100；`0` = 已耗尽（拒绝派生，明确
  反馈「请在本层自行完成任务」）；`off` / `unlimited` = 治理关闭（逃生口，
  与 ORG_SPAWN_MAX=0 语义对称）；
- `ORG_SPAWN_DECAY`（衰减率 (0,1]，缺省 0.5）：**子预算 =
  floor(父预算 × decay)** —— 预算随深度指数衰减（100→50→25→…→0），
  无保底（floor 到 0 即耗尽）；默认深度帽 2 先到，用户调大 MAX 时预算
  接得住（预算是第二道安全线）；
- 旗标 `--spawn-budget N|off`（cli/org.ts cmdRun/cmdAsk 双入口）：深度
  经旗标递归传递的既有模式同构（env 前缀会破坏 shell 白名单首词判定）；
- **用量回填**：子组织 `metrics.json` 的 tokens_total / model_calls_total
  与 run.json 的 elapsed_ms 回填到 agent_spawn 结果（scripted 车道是估算
  口径、真实车道是 llm_stream_done 计量 —— 本层只搬运不重复计量）。

### 池化重档（<ws>/spawn/pool.json）

- 每次派生登记一条：`{id, goal, mode, depth, budget, workspace, out, ok,
  usage, summary, spawned_at, finished_at, reuse_count}`（粗上限 200 条防膨胀）；
- **复用判定**：派生前查池 —— 成功记录中 goal 相似度（中英混合分词 +
  **双向词面重合 max**，长短表述不齐不漏）≥ `ORG_SPAWN_REUSE_FLOOR`
  （缺省 0.6）→ 命中即复用：reuse_count 递增、结果标 `reused: true +
  similarity + 零派生成本`；`args.reuse: false` 强制新派生；
- **治理面降级不阻断执行面**：池读写失败（损坏/权限）→ 派生照常，
  只是不留痕（登记是治理面，派生是执行面）；
- 存量兼容：v0.5.6-v0.5.10 的旧派生目录无登记 —— /api/spawns 扫描
  `spawn/*/out-spawn/run.json` 合成 legacy 记录（面板无盲区）。

### Web GUI：🌳 派生池面板（web/entry.ts）

- 顶栏新 rchip「🌳 派生」→ scrim+pane 对话框（与检索/音频面板同族交互，
  Esc 栈式关闭）；
- `GET /api/spawns`：三层数据源 —— ① 顶层池登记 ② 孤儿目录兜底合成
  ③ **递归挂孙**（沿 record.workspace BFS 深入各子池，深度 ≤4 · 总量
  ≤300 · 工作区越界守卫）→ 完整子生孙树形；
- 面板要素：统计条（总派生/成功/失败/复用命中/tokens 合计）· 树形行
  （depth 缩进 + 状态点 + goal + mode/depth/预算 ◈/复用 ♻ 徽标 + 相对
  时间 + tokens）· 点击展开（summary 全文 + 产物/工作区路径复制）·
  空态与底部语义注解（预算继承 + 池化复用口径一页可查）；
- 运行卡增强（lib/runCards.ts）：agent_spawn 专属卡 —— 派生 🌳 调用卡
  （goal + mode + reuse 开关）/ ♻ 池化复用结果卡（×N + 相似度）/ 预算
  拒绝卡 / 完成卡（预算 + tokens）—— 三端（TUI/Web/chat）同源渲染。

### 测试

- tests/spawn.test.ts +4（B1 预算继承 e2e：缺省 100→子 50 + 池登记 +
  usage 回填；B2 预算耗尽拒绝零派生；B3 同 goal 二连发 → 第二次复用
  reuse_count=1；B4 reuse:false 强制新派生二目录二记录）；
- tests/web.test.ts +3（/api/spawns 池登记+孤儿兜底+递归挂孙+统计；
  空工作区不炸自洽；GUI 要素 + 内联脚本自洽）；
- 既有 spawn e2e 适配：spawn/ 目录现在含 pool.json —— 子目录断言改
  statSync 过滤（实现细节变更，无语义损失）。

## v0.5.10（2026-09-16）—— scripted 车道语义地板 + 跨车道救援

QA 实测（agent-browser 驱动 Web GUI 团队模式）发现 B-19：发域外任务
「请创作一首古典风格的卡农」，scripted 车道套用 STOCK 公告流水线跑完
交差 —— run ok=true、交付公告表格，**答非所问比诚实降级更糟**（用户以为
成功了）。v0.5.7 修的是「空壳工作区不炸」，本版修「有模板但任务域外」的
语义错配：**语义地板预检三段式** —— 域内放行 / 注册表专家**跨车道救援**
转直连 / **零消耗诚实降级**。484/484 机制级测试全绿（27 文件 · 2096
expect，+15 例）。

### 语义地板（lib/engine.ts，CLI cmdRun / engine startRun 双入口同构）

- `stockAffinityOf`：任务与 STOCK 剧本域内文本（decompose 目标 + clarify）
  的词面重合 —— 复用 v0.5.8 语义检索的中英混合分词（CJK bigram + 西文
  词元）；**命中数护持**（≥2 实义 token 命中即按地板放行 —— bigram 碎片化
  会把「抓取近一周公告并输出表格」稀释到 0.33，明确域内不能误拦）；
- `SEMANTIC_FLOOR = 0.15`（实测定标：卡农/写诗 0.00 ｜ 公告类 0.33-0.58）；
  超短任务（<2 token）/ 剧本不可读 → 保守放行（原行为兜底）；
- 介入条件：scripted + 团队 entry + **未显式指定 fixture**（--fixture 显式
  传参 = 用户意图优先，跳过预检；真实 LLM 车道动态分解天然域感知）。

### 跨车道救援（reroute）

- `rescueExpertOf`：注册表专家评分 = manifest（name+description+
  capabilities）与 **direct: 轨道语料**取 max（预录回复复述任务域词汇，
  是最强领域信号 —— 卡农任务 composer 综合分 0.75 vs manifest 分 0.17）；
  前置校验 fixture 含 `direct:<name>` 轨道（否则直连 FIXTURE_EXHAUSTED，
  不可救援）；
- 命中 → 同一 run 转直连（entry/expert/fixture 改写，Web/TUI/CLI 三端）：
  `lane_rescue` 事件先于解释器事件注入卡片流（⇄ 跨车道救援 → 专家（评分
  可见））；**ORG_TOOLS 默认 write**（audio_compose 是 Full 即门类工具，
  开箱即用无需审批；fs_write 仍审批在环 —— 团队车道本就 approval:true，
  GUI 审批卡承接；用户显式设置优先）；direct 会话账本照常落盘（记账权
  不可绕）；
- STOCK 剧本补 `direct:bard` 轨道（写诗演示）：第一轮 fs_write poem.md
  工件 + 第二轮**附诗文全文**（审批缺席时交付不丢失 —— 优雅降级）。

### 零消耗诚实降级（degrade）

- 无专家命中 → **不跑流水线**：直写标准产物四件套（journal.jsonl 管道
  分隔 / events.jsonl 归一化事件 / report.md / run.json `lane:
  degraded-out-of-domain` + remedies）—— Web 回放面板与 org score 零适配
  消费；GUI 渲染 ◌ 域外降级卡（建议出口：切直连 / 配真实模型 / org search）。

### GUI 直连工具环缺口补齐（B-19 伴生）

- v0.5.9 的「GUI 开箱演示」实际只有纯文本：直连 t-bot 从未注入
  ORG_TOOLS（缺省 Off），audio_compose/fs_write 一律不执行（`<tool>` 标记
  原样输出）。askOnce/askStreamOnce 现默认 `ORG_TOOLS=write`（用户显式
  设置优先）。

### 观测与契约

- `runCards.ts` 新增 `rescue` 事实（mode/expert/score/stockScore/floor）；
  Web runCard 渲染 ⇄/◌ 行（先于任务树 —— 车道决策第一眼可见）+ done 帧
  directTurns 透传（救援回答以对话气泡呈现：团队卡讲「为什么换车道」，
  气泡讲「专家答了什么」）；
- degrade 路径的事件流合成（journal open → lane_rescue → run_end →
  run_result），回放与实时卡片同源。

### 测试（tests/rescue.test.ts，15 例）

- R1 地板数值定标（含西文护栏回归锚：quantum 3 token 曾被 <4 阈值误放）
  / R2 救援评分（卡农→composer、写诗→bard、无轨道不可救援）/ R3 CLI
  reroute e2e（WAV+MID+会话账本）/ R4 startRun 事件流契约（lane_rescue +
  directTurns + audioRendered）/ R5 degrade e2e（产物四件套 + 零消耗）/
  R6 域内零影响 / R7 显式 fixture 零影响；
- degrade T2 适配：原用例「卡农」任务现被预检改道（reroute 是 rescue.test
  的领地），改域内任务保持「空壳修复 → 模板补全 → parse 复用」意图。

## v0.5.9（2026-09-16）—— 音频工坊（音色库 × 和弦库 × MIDI 导出）

「古典音乐 = 音频」的乐器面与交换格式一次补齐：**8 种乐器音色**
（谐波表 + 包络特征 + 颤音 FM 合成）、**7 套和弦进行预设**（卡农/流行/
史诗/五度圈/爵士/布鲁斯/浪漫，柱式与琶音双风格）、**MIDI 导出**
（SMF 格式 0，可导入 DAW/打谱软件）—— 产物从「单一正弦 WAV」升级为
「多乐器 WAV + MIDI 双格式」。Web GUI 同步交付**音频工坊面板**
（🎵 音色试听）与断连优雅降级。469/469 机制级测试全绿（26 文件 ·
2042 expect，+22 例）。

### 音色库（lib/audio.ts · TIMBRES）

- 8 种乐器：`piano / strings / flute / organ / harpsichord / music-box /
  guitar / bell` —— 每种 = 谐波表（非整数 ratio 造金属/钟质感）+ 包络
  特征（起音/衰减渐近 sustain/释放）+ 颤音（相位积分 FM，5.5Hz 揉弦）；
- 协议：notes.json 顶层 `timbre` 字段（音符级 wave 仍可覆盖）；未注册
  名降级到基础波形不炸曲；notes.json 顶层 `export_midi: true` 同写
  `.mid`（opt-in；audio_compose 显式调用缺省开）。

### 和弦库（CHORD_QUALITIES × PROGRESSIONS）

- 11 种和弦质量（maj/min/dim/aug/sus4/sus2/7/maj7/m7/m7b5/6）×
  7 套进行预设（级数半音 + 自然音级自动配质：I maj / V 7 / ii vi m7）；
- `progressionToNotes(root, prog, {style: block|arp, beatsPerChord,
  gain, octave})`：音名/MIDI/频率三向转换（C4=60 · A4=440Hz），
  柱式（同拍起拍留缝 0.95）与琶音（滚动起拍尾音交叠 1.4× 连奏感）；
- 参数宽容：坏根音降级 C4、未注册进行降级 canon —— degraded 标注可观测。

### MIDI 导出（SMF 格式 0）

- `renderNotesToMidi`：MThd + MTrk · 480 PPQ · tempo meta · note_on/off；
  频率 → 最近半音（±50 音分内人耳无感，和弦/旋律语义保真）；
- 同音重叠区间合并（note_off 不提前掐断前音）；导出失败不影响 WAV
  主产物（降级不报错）；
- 三入口同钩子：cli runHsl / lib/engine / **web 直连车道（B-18 补齐）**
  —— `scanAndRenderArtifacts` 幂等（wav+mid 双新跳过）。

### 工具环与专家（audio_compose · composer.hsl）

- `audio_compose` 新参数：`timbre`（音色透传）+ `chords`（和弦进行车道，
  可代 notes：宽容形态 `"canon"` / `"D3:canon:arp"` / `{root,name,style,
  beats_per_chord}`，ABI 内同构实现与 lib 对拍）+ `export_midi` 缺省 true；
- composer 专家提示词升级（音色/和声语义）；降级内置曲改弦乐音色；
  STOCK 剧本新增 `direct:composer` 轨道（GUI 开箱可演示）。

### Web GUI

- **🎵 音频工坊面板**：8 音色卡片（图标+特质+标签）网格 · 7 进行下拉 +
  柱式/琶音切换 · 点击试听（`/api/audio-demo` 服务端合成 2 和弦样本，
  内存缓存 64 条）· 再点同卡停止；
- **直连 t-bot 音频卡**（B-18）：直连回答内联 .raud 播放器 + 下载 +
  MIDI 链接 —— 与团队运行卡同款交互；
- **断连优雅降级**：api() 连续失败 ≥3 → 顶部琥珀状态条（脉动点 +
  立即重试）+ 轮询降频一半；恢复自动消失。此前是控制台 Failed to
  fetch 刷屏（跨轮会话累积噪音）；
- **Esc 关闭全部面板**（search/audio/tasks/sched/notify/memory/
  providers/approval 统一口径）+ 面板 ✕ 关闭钮；
- `--host` / `ORG_WEB_HOST` 参数（缺省仍只听 127.0.0.1；容器/远程/
  云端浏览器场景 opt-in 绑 0.0.0.0）。

## v0.5.8（2026-09-16）—— 语义检索 / RAG 注入（capabilities #19/#22 双 ⬜→✅）

「语义代码搜索 + RAG 向量检索」两 ⬜ 一次落地：工作区语料的 **BM25 词频
语义检索**（Lucene 风格 IDF 防负 + 短语加成）+ 中英混合分词（CJK
bigram + 西文词元），**四入口**开袋即食；RAG 注入语法 `@?查询词` 把
检索命中自动织入模型上下文。447/447 机制级测试全绿（26 文件 · 1849
expect，+13 例）。

### 引擎（lib/search.ts · 单一实现）

- BM25（k1=1.5 · b=0.75 · Lucene IDF 防负）+ **短语加成**（查询 CJK
  连续段在原文头部命中 → +3.0 —— 修正纯长度归一让短文档反超的直觉
  偏差，「审计制度」整词组命中的文档稳定居首）；
- 分词：CJK 连续段 bigram（尾字保留）+ 西文小写词元 —— 中英混合
  查询开箱可用，零重依赖；
- 语料面：`raw/ registry/ work/ factory/`（上限 512 文件 · 单文件
  256KB · 总量 4MB，超限跳过计数不连坐；二进制 NUL 嗅探）；
- 优雅降级：目录缺失空索引 / 逐文件隔离 / 空查询空结果 / 索引异常
  逐层兜底 —— 全部不炸主流程。

### 四入口

- **CLI** `org search <查询词> [--k N]`：命中排序 + 摘要 + 引导行
  （@引用 / @? RAG 双提示）；
- **Web** `GET /api/search?q&k` + 顶栏 🔍 检索面板：防抖 300ms 实时
  检索 · 分数分档徽标（≥3 绿 / ≥1.5 琥珀）· 命中词高亮（esc 后受控
  `<b>`，XSS 安全）· **点击命中插入 @路径 到问题框**（检索→引用
  闭环）· 语料徽标与降级计数可观测；
- **RAG 注入**（lib/mentions.ts）：`@?查询词` → top-5 检索命中展开
  为围栏摘要块（路径 + 分数 + 摘要）注入模型上下文 —— 用户不必知道
  文件名；无命中/引擎异常 → 附注降级不炸；
- **工具环** `semantic_search {query, k}`（ReadOnly 模式可用）：
  HSL 侧 $host ABI 内同构实现（分词/BM25/短语加成同参），`tests/
  search.test.ts` 行为对拍保证与 lib 版 top-1 排序一致 —— 「一源
  多投射 + 行为级对拍」治理手法的检索版。

### 测试（tests/search.test.ts · 13 例）

- 分词 3（CJK bigram / 西文 / 混合）· 排序与降级 4（相关排前 / 跨
  语料 / 空查询空区 / 二进制跳过）· RAG 注入 2（织入 / 无命中降级）
- CLI 2（命中输出 / 用法提示）· Web 1（JSON 契约 + k 生效）· 工具环
  e2e + 对拍 1（事件留痕 + top-1 与 lib 版一致）

## v0.5.7（2026-09-15）—— 空壳工作区修复 + 嵌套专家执行多重优雅降级

agent-browser 驱动 Web GUI 的 QA 实测揪出两个连环真 bug，本版双修 +
回归钉进 CI：434/434 机制级测试全绿（25 文件 · 1799 expect，+3 例）。

### 空壳工作区修复（ensureWorkspace 标记物判据）

- **根因**：`org web` 启动即内嵌任务执行器，`TaskRunner.acquireLock`
  先行 `mkdirSync <ws>/runtime/tasks` —— 默认工作区以「只含 runtime/
  的空壳」存在，骗过 `ensureWorkspace` 的存在性检查（`fs.existsSync` →
  直接 return），demo-ws 模板从未复制：工作区缺 `raw/` 物料与
  `registry` 模板，首个 ask 的 parse 子任务被迫路由 C:generate 现场
  铸专家 → 空载荷过不了 minted 专家自身闸门 → 硬 Err 炸穿整次 run
  （GUI 显示「结束（Err）」）；
- **修复**：标记物判据（`registry/` · `raw/` · `.git` 任一在 = 已初始
  化或用户自带数据，尊重不动；全缺 = 空壳 → 补模板）。`cpSync` 合并
  语义：已有 `runtime/`（任务队列）不受影响；`lib/engine.ts` 与
  `cli/org.ts` 双份同构修复；幂等（已初始化工作区零触碰）。

### 嵌套专家执行多重优雅降级（Reuse/Generate/WarmHandoff 三路）

- **炸半径**：v0.4.12 只给「工厂 mint 失败」加了降级，但**铸出来的专家
  自己跑挂**（自身闸门拒绝/嵌套解释器非零退出）时三路 dispatch 一律
  `return Err` 硬失败 —— 监督回路根本没机会接管；
- **修复**：三路（`reuse-run-failed` / `mint-run-failed` /
  `handoff-run-failed`）统一降级为失败报告（coverage 0 + 标注 +
  remedy 提示）交监督回路有界处理：客观覆盖线 Revise → 有界返工
  （DEFAULT_MAX_REVISES=2）→ 耗尽强制收货（accepted with flags）→
  aggregate 摘要诚实可见（`(minted run failed)` / `(factory failed)`
  交付物不编造）→ run ok=true；
- `truncate_note` 助手：嵌套执行的 stderr 诊断压到单行 300 字符再灌
  notes，报告与摘要保持可读。

### 测试（tests/degrade.test.ts · 3 例）

- T1 空壳修复单元：runtime/ 空壳 → 补模板且保留 runtime/ · 幂等；
- T2 GUI 复现端到端：空壳工作区首问 → parse 走 B:reuse（不再铸专家）
  → run ok=true（QA 场景全绿）；
- T3 mint 降级全链：域外使命 + 空注册表 + 无物料 → mint-run-failed
  降级 → 有界返工（revise #N ≤ 2）→ 强制收货 → run ok=true + 事件
  留痕诚实。

## v0.5.6（2026-09-15）—— 音频产物通道（开袋即食）+ 子生孙递归派生 + 作品集 10 项目矩阵

「org agent 成为正常 agent」的产物与组织双补全：古典音乐的交付物从此是
**可播放的 WAV 音频**（不是一纸乐谱），direct 车道的 agent 可**递归派生
子组织**（子生孙、深度治理），外加 10 项目作品集矩阵把三条执行车道钉进
CI。431/431 机制级测试全绿（24 文件 · 1783 expect，+42 例）；真实车道
实测：DeepSeek deepseek-flash 写诗 + 作曲（audio_compose 工具 → WAV）。

### 音频产物通道（lib/audio.ts · composer 专家 · audio_compose 工具）

- 协议：专家/工具写 `<name>.notes.json` 乐谱工件（title/tempo/notes
  [{freq,start_beat,beats,gain,wave,channel}]）→ 引擎收尾扫描渲染同名
  `.wav`（PCM16 立体声 44.1kHz · 44 字节标准 RIFF 头）；
- 合成器：sine 叠加 2/3 次谐波（钢琴暖度）/triangle/saw/square，5ms
  起音 + 指数衰减 + 20ms 释放包络，峰值归一化 0.9（不爆音）；
- 多重优雅降级：字段级容错（坏音符跳过并记录 skipped）、时长上限 240s
  截断、全静音诚实报错（不产假绿空 WAV）、composer 专家输出非法 JSON
  → 内置 D 大调卡农进行兜底（降级事实记入 report.notes 可观测）；
- 三端观测：CLI ♪ 渲染行 + events.jsonl `audio_rendered` 事件 +
  Web 运行卡 `<audio>` 播放器/下载（`GET /api/audio`）+ TUI 通知条；
- 静态专家 `composer`（B:reuse 路由 · 轨道 compose）：判定节点经模型
  网关作曲（真实车道 = LLM 创作；scripted = 剧本）；工具环新增
  `audio_compose`（direct 车道模型作曲 → 工件 → 渲染）。

### 子生孙递归派生（agent_spawn 工具 · 深度治理）

- 工具环新增 `agent_spawn {goal, mode: run|ask, expert}`：direct 车道
  agent 可派生完整子组织（团队任务 org run / 直连专家 org ask）——
  子组织内部工厂铸造的专家即「孙」；
- 深度治理：`ORG_SPAWN_DEPTH`（派生方经 `--spawn-depth` 旗标注入，白
  名单友好）+ `ORG_SPAWN_MAX`（上限，缺省 2，0=全局关闭）—— 理论上
  子子孙孙无穷尽，深度帽是安全线；拒绝先于执行（不烧预算）；
- 剧本/车道环境全继承（ORG_FIXTURE 透传 · DHV_LLM_* 经 bash 自动透
  传）；子工作区 `<ws>/spawn/<id>-<slug>`（模板自动铺设）；
- 工具调用解析多形态宽容（实测 deepseek-flash 混合格式）：规范
  `<tool>JSON</tool>` / 混合未闭合（`<tool>` 开 + DSML 闭，花括号配
  平提取）/ 纯 DSML 块。

### 作品集 10 项目矩阵（tests/portfolio.test.ts）

- #1 公告结构化（B:reuse notice-parser）· #2 古典音乐（composer →
  WAV）· #3 十四行诗（B:reuse bard → poem.md）· #4 变更日志（org
  import changelog-parser → 嵌套解释器车道 → changelog.md/stats）·
  #5-#10 内联车道六类文书使命（纪要/周报/风险/术语表/数据字典/发布
  说明 —— 监督回路 + 审查 + 报告骨架断言）。

### 其他

- 静态专家 `bard`（诗歌创作 · 轨道 poetry · poem.md 工件 · 降级内置
  示例诗）；
- 图灵完备实证恢复合入（issue #34：Rule 110 / BB(3) / Brainfuck 三程
  序四语言对拍 11/11 + vendored dhv-ts 0.2.65→0.2.66 生成器六修 +
  ruff 语料 3→6）；
- RunResult 增 audioRendered/audioFailures 字段；Web done 帧与回放
  面板带音频清单。
## v0.5.5（2026-09-13）—— 定时触发器 + webhook 出站 + key 池冷却落盘 + 预算水位三端渲染

issue #32 遗留清单的集中消化：长程任务队列装上**时间维度**（cron /
@every 到期自动入队），通知中心接**webhook 出站**（桌面/存储/远程三
通道），路由器 key 池状态**落盘跨进程共享**（429 冷却不再各进程各扫
各的），预算水位在 **CLI / chat / Web 三端统一口径渲染**。389/389
机制级测试全绿（20 文件 · 1600 expect，+32 例）。

### 定时任务触发器（lib/schedule.ts · org schedule）

- 表达式：五段 cron（`0,15,30,45 9-17 ... 1-5` / 步进 / 范围 / 列表 /
  dow 7 归一 · dom-dow Vixie OR 语义）+ `@every 30s|m|h|d` 简化式；
- nextAfter 逐分钟扫描（UTC 基准确定性 · 366 天上限防死循环 ——
  「2 月 30 日」如实返回无命中）；
- 文件协议 `<ws>/runtime/schedules/`（原子写 + journal 审计）；领取
  即推进 next_run（双重读防双发）；
- misfire 策略：`skip`（缺省：迟到超 2 分钟跳本周期）/ `run`（补跑
  一次）—— 长离线后不风暴；
- 挂载点：TaskRunner.start() 起 30s 检查 timer（org taskd / org web
  内嵌执行器即「有定时能力」）；无执行器在跑时记录照常推进，任务躺在
  队列等执行器（多重优雅降级）；
- CLI：`org schedule list|add|rm|on|off|test`（test 预览未来 3 触发点）；
- Web：`GET/POST /api/schedules` + `GET /api/schedules/preview` +
  任务中心旁 ⏰ 定时面板（新建/启停/删除/预览）。

### 通知 webhook 出站（lib/notify.ts）

- `org config set notify_webhook_url URL` 启用；每条通知
  fire-and-forget POST JSON（5s 超时；失败静默 —— 慢/坏 endpoint 绝不
  拖累通知写入与业务主流程）；
- `notify_webhook_events` 事件过滤（逗号分隔 kind；空/`*` 全发）；
- `org notify test` 实测三通道（存储/桌面/webhook）并显式报告出站
  结果；payload 契约 `{source:"org", event, title, detail, ts, taskId}`。

### key 池状态落盘（lib/router.ts）

- `runtime/llm-pool.json`：按 lane → key 指纹 → {until, fails,
  last_status}；429/5xx/timeout 进冷却（60s 起按连败档位放大，封顶
  300s），4xx 只记状态（key 失效是常态不冷却）；
- **跨进程共享**：chat / taskd / web 三端同池同冷却（此前轮换状态
  只在单进程内存里）；
- 冷却中的 key 在尝试序列中**稳定沉底**（全部冷却则照原序用，不阻断）；
  成功即清零；
- `org providers` 输出池健康；Web ⚙ 面板同数据源渲染。

### 预算水位三端渲染

- `budgetWatermark(workspace)` 统一口径：{budget, used, remaining,
  exceeded}（按当日 ok 请求数；budget 每请求重读）；
- CLI `org providers`：`█░` 水位条；chat REPL `/lane`：水位行 +
  池健康；Web ⚙ 面板：水位条 + 池状态列表。

### chat REPL 指挥台化（/tools /lane /tasks /sched /notify）

`org chat` 内直接查看/切换：工具环能力门（off/read/write）、当前车道
+ key 池 + 预算、任务队列快照、定时任务快照、通知未读 —— 不离开会话
即可掌握全局（issue #32 遗留项「/tools 命令」落地）。

### 顺手修复

- chat help 的 `/model [m]` 显示（既有，实为显示层 ANSI 消费假象，
  源文件完好；保留占位说明）；
- `CONFIG_KEYS` 前向扩展：notify_webhook_url / notify_webhook_events
  （老配置文件缺省空串）。

### 验证

- `bun test tests/`：**389/389**（20 文件 · 1600 expect；v0.5.5 新增
  tests/v055.test.ts 32 例：cron 解析 7 形态 / nextAfter 8 语义断言
  （跨小时/跨月/周末跳周一/2 月无命中不死循环）/ 文件协议 + 防双发 +
  misfire 双策略 / TaskRunner 挂载 e2e / webhook 四态（off/sent/
  filtered/failed）+ payload 契约 / 池冷却 429-4xx-timeout 分流 + 档位
  封顶 / 预算水位超限口径）；
- `org check` 43 模块全绿 · `bun scripts/ruff-gate.ts` 三语料全绿 ·
  `org demo` 全叙事 · chat REPL 五新命令冒烟 · Web script 块
  `new Function` 解析回归（模板字符串内 `\"` 转义被消费导致裸引号
  嵌套的实测缺陷已修）。

## v0.5.4（2026-09-13）—— HSL python 产物 ruff 门禁（生成器六修 + CI 接线 + 语料）

「所有产物 ruff 检测均可通过」的可执行落地：vendored dhv-ts 的 python
生成器从 134 项 ruff 失败修到**全规则全绿**（ruff 0.16.7 默认集含
E/F/I001/PLR0124/UP032/UP034/UP018/TRY004），双仓同步（上游
`feat/v0.2.64-ruff-clean-python` 分支同 commit，上游 176/176 测试 +
emit 行为级对拍全等回归）。

### python 生成器修复（toolchain/dhv-ts/src/backends/ · 双仓镜像）

| # | 缺陷（实测形态） | 修复 |
|:--|:--|:--|
| 1 | **F401×9/文件**：头部 typing/dataclasses/math 全量导入从不裁剪 | `finalizePython`：占位标记 + 正文用量扫描按需生成；导入块 isort 排序与空行约定 |
| 2 | **F821**：trait 投射 `class X(Protocol)` 但 Protocol 从未导入 | 按需导入覆盖 Protocol |
| 3 | **F821**：模式匹配引用 `Ok/Err/Some` 无定义（py_compile 不查名字解析故语法校验绿） | prelude 变体桩类按需注入（纯 class，零 import 依赖） |
| 4 | **复合赋值算符翻倍**：AST op 已是 `'+='`，模板再追加 `=` → `i +== 1` 非法语法（py_compile 抓到） | `${t} ${e.op} ${v}`（上游 emit 一致性语料未覆盖复合赋值 —— 覆盖缺口实录） |
| 5 | **E701/UP032/PLR0124/UP018/TRY004**：prelude 助手单行 if · `'{}'.format` · `x != x` NaN 判定 · `str('lit')` · match 守卫 ValueError | 逐项修正（多行化/f-string/math.isnan/恒等/TypeError） |
| 6 | **UP034 + F401**：二元表达式全括号化在语句位产生冗余括号；contract 回退文件的镜像注释名字被误判「已用」 | `pyStripOuter`（元组保护）+ 注释剥离后的用量扫描 |
| + | **ENOENT**：emit 无 project 的源到不存在目录 → manifest 先写即炸 | outDir 兜底 mkdir |
| + | python 类型映射缺 i8/i16/u8/u16/i128/u128（nova `u8` 注解泄漏 F821） | registry 补全 int 族 |

### ruff 门禁（scripts/ruff-gate.ts）

- 语料三份：ORG 内核 python 投射（hsl/org.hsl 新增 python 车道）+
  ORG 自有全特性语料（fixtures/ruff-corpus/kernel-tour.hsl：复合赋值/
  闭包/递归/Result 模式/trait/常量）+ 模式全家族（vendored pattern-tour）；
- emit → ruff check（0.16 默认全规则）；失败逐条列出 exit 1；无 ruff 环境
  诚实失败（不静默跳过）；`--keep` 保留产物排查；
- CI verify job 接线：uv + ruff 安装 → gate 步骤（在测试前）。

### 双仓漂移治理

- 上游 HSL 仓库：`feat/v0.2.64-ruff-clean-python`（c92caa2 起同批提交，
  176/176 + emit 行为级对拍 6/6 全等回归）—— vendored 0.2.64 ≥ 上游
  main 0.2.61，check-vendored-fresh 绿；
- vendored 补齐 examples/（上游本有，org 裁剪时被去 —— 现作 ruff 语料）。

### 验证

- 全量 **357/357 全绿**（19 文件 · 1481 expect；+ruff.test.ts 6 例锁定：
  复合赋值回归 + 按需导入 + prelude 卫生 + 桩类 + ENOENT）；
- `org check` 43 模块（org.hsl python 投射 + kernel-tour 语料入列）·
  ruff gate 3 语料 22 个 .py 全绿；
- 上游：run-all 176/176 · emit 行为级对拍（interp ↔ python 真实运行）
  三方逐行全等 ✓。


## v0.5.3（2026-09-13）—— agent 工具环 + AGENTS.md + @文件引用 + 长期记忆

「org agent 成为正常 agent」的执行层落地：模型不只是回答 —— 它能**读
文件、写文件、跑命令**（能力门控），带工作区规则与长期记忆作答。新增
17 例锁定（tests/tools.test.ts），真实模型端到端实测闭环。

### agent 工具环（hsl/pool/tools.hsl · 新模块）

direct 车道的模型回复可携带 `<tool>{"name":"...","args":{...}}</tool>`
结构化调用；HSL 侧解析 → 能力门 → $host 执行 → 结果回灌对话（有界循环
ORG_TOOL_MAX_TURNS 缺省 6，防失控强制收束）：

- **工具集**：fs_read（32KB 截断可观测）/ fs_list / fs_glob（简单
  glob）/ fs_write / fs_edit（唯一锚点）/ shell_run（60s 超时 + 白名单）；
- **多形态宽容解析**（实测真实模型驱动）：`{name,args}` 规范形 /
  `{name, path}` 平铺形 / `{tool,...}` 别名形全兼容；坏 JSON 跳过不炸，
  错误反馈携带实际解析结果（模型可自纠）；
- **能力门（安全缺省）**：读工具 Auto；写/执行工具需 ORG_TOOLS=write
  **且**审批队列在环（ORG_APPROVAL=1）—— 未开审批时明确拒绝并告知
  模型原因，绝不静默放行；
- **开关三档**（多重优雅降级）：ORG_TOOLS 未设 = 纯问答（v0.5.2 行为
  零变化）；=1 只读工具（零风险）；=write 全量 + 能力门；
- 事件 tool_call / tool_result / tool_denied 上总线（三端渲染：
  TUI 系统卡 / Web notice 三色调）。

### 模型网关多轮化（hsl/providers/model.hsl）

`ask_conv(track, system, turns_json)`：完整 messages 组装（system +
任意 user/assistant 序列）；`ask` 变为单轮特例（统一实现，语义零变化）。
工具环把工具结果作为 user 消息回灌 —— 模型带完整上文自纠。

### 上下文三注入（direct 车道系统提示自动组装）

- **AGENTS.md**（codex 同形）：工作区规则织入（AGENTS.md /
  .org/rules.md，8KB 截断可观测）；
- **长期记忆**：runtime/memories/<expert>.md 尾部 40 行跨会话注入
  （org memory add 管理；CLI/`/memory`/Web 🧠 面板三端同权）；
- **@文件/目录引用**（lib/mentions.ts）：`org ask "…@src/main.ts"` /
  chat / Web 的 `@相对路径` 展开为围栏内容（文件 64KB / 目录 20 文件树 +
  8 行预览 / 总预算 96KB；越界·二进制·不存在逐项跳过并附注，绝不炸）。

### CLI / Web 操作面

- `org memory list/add/rm` + chat `/memory` + Web 🧠 记忆面板
  （GET/POST /api/memory：分组列表/追加/删除）；
- Web ask 链路 @展开（askOnce / askStreamOnce 同规则）。

### 真实模型端到端实测（z-ai SDK 车道）

```
问题：请用 fs_read 工具读取 raw/notices.txt，告诉我有多少个 NOTICE 块
事件：tool_call fs_read path=raw/notices.txt → tool_result ok 546 chars
回答：文件里有 5 个 NOTICE 块。   （grep -c 验证 = 5 ✓）
```
首版实测抓到的缺陷（已修）：真实模型的工具参数平铺形态
`{name,path}` 不被解析 → 六连「args.path 必填」空转到轮上限 ——
多形态宽容解析后单轮闭环（719ms）。

### 验证

- 全量 **346/346 全绿**（18 文件 · 1460 expect）；
- 工具环 e2e（scripted 剧本驱动）：读工具全链（真实读文件 + 事件 +
  账本落最终答案）· 只读模式 fs_write 拒绝 · write 未开审批仍拒绝
  （安全缺省）· 关闭档零变化 · 轮上限收束 · 坏 JSON 不炸；
- @引用：文件/目录/越界/二进制/预算五类 + Web 账本查证；
- 记忆：add/list/rm/防呆/坏文件容错 + Web 端点与 GUI 要素。


## v0.5.2（2026-09-13）—— 长程任务队列 + 通知中心（桌面 Agent 的后台面）

「新建长程任务」的完整落地：后台/异步执行 · 队列优先级/并行 · 暂停/
恢复/中断/继续 · 通知中心/任务提醒。CLI（org task/taskd/notify）与
Web（任务中心面板 + 铃铛）共用同一实现（lib/tasks.ts + lib/notify.ts），
新增 19 例锁定（tests/tasks.test.ts）。

### 任务队列（lib/tasks.ts）

- **文件协议**：`<ws>/runtime/tasks/<id>.json`（状态机唯一事实来源，
  原子写）+ `<id>.journal.jsonl`（状态迁移审计）+ `.runner.lock`
  （执行器互斥）；
- **状态机**：queued ⇄ paused（入队级）· queued → running ⇄ paused
  （**SIGSTOP/SIGCONT 真进程暂停**，spawn 车道）· → done/failed/
  cancelled · 终态 retry → queued（attempts+1）；
- **优先级 P0-P10**（0 最高），同级 FIFO（created_at + id 全序确定）；
- **独立产物目录 out-task-<id>**：与用户前台直连（out-ask）天然隔离，
  前后台可并行；
- **执行器三形态**（多重优雅降级）：
  1. `org taskd` 守护进程（500ms 领取 · 并发 ORG_TASK_CONCURRENCY 缺省
     1 —— git 注册表写入的保守上限 · Ctrl+C 退出保留排队）；
  2. `org web` 内嵌执行器（taskRunner:true —— Web 即守护进程，与
     taskd 二选一，runner lock 跨进程互斥）；
  3. `org task run-next` 前台单发（无守护时的手动模式；有活执行器时
     拒绝执行防双跑）；
- **跨进程契约**：任务记录携带执行 pid —— 孤儿收割只收 pid 已死的
  任务（执行器崩溃后的断点清理），活 pid（run-next / 同进程另一执行器
  / 他进程）绝不误杀；锁带 5s 心跳，30s 无心跳的死进程锁可接管；
- **同进程互斥**：模块级持有者（web 内嵌与 run-next 等同进程场景）。

### RunHandle.pause/resume（lib/engine.ts）

spawn 车道 SIGSTOP/SIGCONT（实测验证：暂停期完成 promise 800ms 不
settle）；inproc 车道返回 false → 任务层降级为「本轮自然结束后停领」
并如实标注 paused_inproc。

### 通知中心（lib/notify.ts）

- 任务完成/失败/取消自动通知（notify 开关随任务）；
- **桌面通知三级降级**：notify-send（Linux）→ osascript（macOS）→
  powershell toast（Windows）→ 仅控制台；无 DISPLAY 的 CI 自动跳过；
  `org config set desktop_notify off` 关闭；
- 存储 `runtime/notifications.json`（原子写 · 200 条容量 · 坏文件容错）；
- CLI：`org notify list/read/clear/test`；Web：顶栏 🔔 徽标（5s 轮询）+
  通知面板（逐条已读 / 全部已读 / 清空）。

### Web 任务中心（操作页面）

顶栏 ☰ 任务入口 → 面板：提交表单（任务描述 + 优先级 P0-P10）· 任务
表（状态徽标 ⏸▶✓✗⊘ · 优先级 · 摘要 · 动作按钮 暂停/恢复/取消/重试）·
执行器状态行（内嵌运行中 / 无执行器提示）· 打开期间 3s 自动刷新。
端点：GET /api/tasks · POST /api/task/submit · GET/POST /api/task/<id> ·
GET/POST /api/notifications —— 与 CLI 同一实现。

### 验证

- 全量 **328/328 全绿**（17 文件 · 1394 expect）；
- e2e：run-next 团队任务全链（done + result 摘要 + journal 审计链 +
  通知）· P0 抢先 · Web 提交 → 内嵌执行器自动执行 → 通知 → 动作链
  （pause→resume→cancel→retry）· SIGSTOP 暂停期不完成 → SIGCONT 收尾；
- 排序确定性（同毫秒 id tiebreak）· 非法 id 拒绝（路径穿越）· 坏
  通知/坏任务文件容错。


## v0.5.1（2026-09-13）—— 所有主流 API key 模式（服务商注册表 / key 池轮换 / 降级链 / 预算）

对标 codex / opencode 的多服务商配置面，把「支持所有主流 API key」从
六预设扩到**全量注册表 + 运行时韧性层**。全部本地 mock 测试（不出网、
毫秒级），新增 34 例锁定（tests/providers.test.ts）+ 4 例 Web 面板。

### 服务商注册表（lib/provider-registry.ts · 新模块）

- **21 家服务商** OpenAI 兼容端点一条打天下：海外主流（OpenAI /
  Anthropic / Gemini / OpenRouter / Groq / Mistral / xAI / Together /
  Fireworks / Cerebras / Perplexity / DeepInfra）+ 国内主流（DeepSeek /
  智谱 GLM / 月之暗面 Kimi / 通义 Qwen / MiniMax / 硅基流动）+ 本地推理
  （Ollama / LM Studio / vLLM 免 key 即用）；
- 每家携带：网关、缺省模型、**key 的环境变量名**、附加头（如
  anthropic-version）、获取说明；
- **环境变量自动发现**：shell 里已 export 的 OPENAI_API_KEY /
  DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / ZHIPU_API_KEY
  … 即刻可用（`org config auto` 为全部发现建车道）。

### 车道解析（lib/providers.ts · 新模块）

- `resolveModelFlag()`：`--model` 旗标五种输入统一归一（scripted /
  配置车道名 / 服务商名 / 裸模型 id / 空 → 缺省车道），CLI / chat /
  TUI / Web 四端同一实现；
- **hsl/providers/model.hsl 车道信号化**：真实车道判定从硬编码
  `model == "deepseek"` 改为宿主信号 `ORG_LANE_KIND`（宿主解析后显式
  声明）。信号缺席时保留兼容语义（deepseek 走真实、未知名走剧本）——
  任何服务商车道名零改动接入，`org web --model <lane>` 回落链行为不变；
- **用户环境不可覆盖层**（snapshotUserEnv）：用户 shell 显式 export 的
  DHV_LLM_* 优先于程序注入（Unix 惯例的代码级保证）；
- 非显式车道（无 key 的服务商名猜测）不注入网关 —— 回落 z-ai SDK
  车道，与 v0.4.x `--model deepseek` 未配 key 行为完全一致。

### 本地路由器（lib/router.ts · 新模块）

进程内 Bun.serve（127.0.0.1 随机端口）暴露 OpenAI 兼容端点，多重优雅
降级的执行层：

- **key 池轮换**：429 / 5xx / 网络错误 → 同车道下一把 key（round-robin
  起点轮转，公平分摊限流）；
- **车道降级链**：key 池全失败 / 超时 → fallback 链下一车道（**模型名
  随之改写**），`org config set fallback "openrouter,ollama"`；
- **预算水位**：`org config set budget_requests 200` —— 当日成功调用
  超出即 429（每请求重读配置，改预算不用重启）；
- **调用台账**：每次尝试落 `<ws>/runtime/llm-ledger.jsonl`（key 指纹
  脱敏 / 状态 / 延迟 / usage），`org providers ledger` 与 Web 面板归因；
- **SSE 流式透传**：字节级转发保持逐 token 节奏 + 注入 include_usage
  尽力收尾帧 usage（被拒自动去 option 重试）；
- **每请求重读车道配置**（v0.5.1 设计修正：路由器不缓存车道快照 ——
  用户改 config.json 即刻生效，同名车道换网关不会路由到死地址）；
- 生命周期：多 key / 降级链 / 预算任一命中才启动（单 key 直连零开销）；
  车道切换自动重建；`ORG_ROUTER=0/1` 强制开关；启动失败静默直连。

### CLI / Web 操作面

- `org config` 扩展：`lane <name> set/list/rm/test` · `use <name>` ·
  `keys add/clear` · `fallback` · `budget_requests` · `auto` ·
  `test [lane]`（连通测试走车道全解析）；
- `org providers [ledger]`：服务商健康面板（注册 21 家 · 命名车道 ·
  环境变量发现 · 台账统计）；
- **Web GUI ⚙ 车道面板**（顶栏入口）：车道表（设缺省 / 测试 / 删除）+
  预设下拉 + key 池追加 + env 发现 + auto 一键 + 台账统计 ——
  `GET/POST /api/providers`、`POST /api/config`、
  `POST /api/providers/test` 三端点与 CLI 同一实现（绝不双轨）。

### 配置文件 v3（向后兼容）

- `~/.org/config.json` 支持 `lanes`（命名车道）+ `api_keys`（key 池）+
  `fallbacks`（降级链）+ `budget_requests`（日预算）；
- **v1 平面形态完全保留**：老文件不改一行照常生效；任何车道变更同步
  镜像到平面字段（所有既有消费者零改动）；
- 损坏文件 → 空配置不炸（既有纪律保持）。

### 验证

- 全量 **309/309 全绿**（16 文件 · 1311 expect；v0.5.0 基线 271 +
  providers 34 + web 4）；
- `org check` 35 个 HSL 模块 0 失败 · `org demo` 全叙事通过 · TUI 冒烟
  0 失败 · vendored 新鲜度 0.2.63 ≥ 0.2.61；
- 路由器端到端（mock 上游）：429 轮换命中序断言（sk-a→sk-b）/ 降级链
  模型改写（m-primary→m-backup）/ 台账 tokens=7 贯通 / 预算第二次 429 /
  SSE 尾帧 usage=9 抓取 / 幂等与车道切换重建；
- 四场景车道信号贯通实测：scripted / 未知名（回落剧本）/ deepseek 无
  key（回落 SDK）/ 配置车道双 key（路由器 + 网关改写 + key 池）。


## v0.5.0（2026-09-12）—— Web 补齐团队模式面 + agent 反悔通道 + 事件具名化

对标 codex / zcode / opencode 的一次「可操作界面 + agent 应有功能」补全。
范围按实测缺口排序，先补**旗舰能力在前端的可见性**，再补**低成本的 agent 能力**。

### 1. Web GUI 补齐团队模式派单面（此前的最大缺口）

问题：Web 此前只能直连单专家 —— `web/entry.ts` 连 `startRun` 都没 import，
所有执行路径都落在 `hsl/pool/direct.hsl`。于是 ORG 的旗舰能力（分解 → 路由 →
派单 → 审查 → 资产沉淀）在 Web 上**完全不可见**，只有 TUI 有。

- **`POST /api/run-stream`**：团队派单 SSE（复用 `sseAsk` 模板 + `AskGate`
  串行化，团队 run 与直连互斥）。帧序 `open → start → run → card* → done/error`。
- **`GET /api/runs`** 运行产物列表 · **`GET /api/run?dir=`** 只读回放
  （`replayRun`；`SAFE_NAME` 守卫，坏名 400 / 不存在 404）· **`GET /api/score`**
  评分卡。`POST /api/abort` 扩展到团队 run（`RunHandle.cancel` → SIGTERM）。
- **GUI**：派单模式切换（团队 / 直连，缺省团队，与 TUI 缺省一致）+ 运行卡片叙事
  （任务树 + A/B/C/D 路由徽标 + 四态裁决 + 工厂 stepper + ❄/⚡ 固化 + 补丁 +
  金丝雀 + 资产 + 能力授予 + 影子对比 + done 成本行）+ 侧栏运行列表（点击只读
  回放）+ 评分卡面板。
- **单一解析源**：新增 `lib/runCards.ts` 承载「事件 → 卡片」的解析契约，
  TUI 改为 import（保留再导出，既有 import 路径不变）。分类**在服务端做**，
  SSE / 回放的帧都携带 `fact`，浏览器只渲染 —— 浏览器是内联 JS 无构建步骤，
  让它自己写正则就会回到「同一次运行在两个前端显示成两件事」的老问题。

### 2. agent 反悔通道：会话派生 + 版本回退

后端原语都已存在，缺的只是用户可触达的入口：

- **`org session fork <expert> <from> <to>`**（对应 codex/opencode 的 `/fork`）：
  账本 append-only，复制即分叉 —— 上下文从派生点续跑，原会话字节不变。
  同时补齐 CLI 的会话 `rename` / `rm`（此前只有 Web 有这两个端点）。
- **`org revert <expert> [--to x.y.z]`**（对应 opencode `/undo`、codex diff/revert）：
  工厂每次补丁都把旧源归档为 `registry/experts/<name>@<旧版本>.hsl`（金丝雀回滚
  用的正是这批归档源），还原即回退；**当前源先归档 → 回退本身可逆**，注册表
  版本号随之回退并 git 留痕。实测 `1.0.1 → 1.0.0 → 1.0.1` 往返。

### 3. 事件具名化：审计与异常不再静默丢弃

此前 11 类事件全部落 `kind:"unknown"`，被三端渲染层 switch 直接丢弃 ——
**审计与异常在三个前端都看不见**。现补齐具名类型与归一化分支：
`audit` / `capability_denied` / `crystallize_degrade` / `canary_rollback` /
`redundancy_compare` / `score_drift_alert` / `registry_commit_skipped` /
`patch_rollback_failed` / `run_panic` / `llm_stream_done` / `fault`。

其中 `llm_stream_done` 是成本面板的数据源（chars / 思考量 / 耗时 / usage）；
`capability_denied` 有两条来源且键名不同（能力策略走 `capability`，宿主故障注入
走 `target`），归一化时都认。Web 卡片以三色调 notice 行显示这些事实。

### 4. 测试批次修复

- 新增 `tests/web.test.ts` +7（团队 SSE 全链与 `done.metrics` 对账 / card 帧
  事实覆盖 / task 必填 400 / runs 列表 / 回放与坏名不存在 / 评分卡 / GUI 要素
  与内联脚本可解析）。
- 新增 `tests/sessions.test.ts` 19 例（fork 隔离与防呆 / revert 往返与防呆 /
  11 类事件归一化 / 分类器 tone）+ `tests/approval.test.ts` 11 例（审批队列四态）。
- **修复 v0.4.17 批次三条新回归用例缺超时**：它们起初只在带 `--timeout` 的
  npm 脚本下全绿，裸 `bun test tests/` 会假红（第 3 例要跑完整 `org demo`，
  实测 10.8s）。已补齐 `, 120_000`（该文件头部本就写着这条约定）。
- 全量 **266/266 全绿**（14 文件 · 1069 expect），裸 `bun test tests/` 即可复现。

### 5. 交互式审批：审批队列文件协议（mid-run 暂停等人点头）

此前「审批」只有一个运行前开关（`--approve-capability` / `ORG_CAPABILITY_APPROVED=1`），
而且三态表基本是摆设：`decide()` 只被 `llm_call` 调用，`elevate()` 零调用点。

**为什么是文件协议**：图执行当前没有挂起点（`interp.ts` 的 graph 求值一次 await 到底），
要做真正的 `$host.askUser(await …)` 得改 vendored 解释器 —— 跨仓库、回归面最大。
文件协议的取舍是**最多一个轮询周期的延迟**，换来「不改解释器 + 四端天然同权」。

- **`hsl/policy/approval.hsl`**（新增）：`request_approval()` 落
  `runtime/approvals/<id>.json` 并有界轮询 `<id>.reply.json`。
  **超时/拿不到回复一律降级为拒绝 —— run 永远不会被挂住**；
  回复带 `always` 时写入长期放行集 `granted.json`，之后同类请求直接命中缓存
  （对应 codex 的 "always allow"）。
  四态各发一条事件：`approval_requested` / `approval_resolved` / `approval_timeout` /
  `approval_cached` —— 审批不是静默行为。
- **接入点**：能力变更补丁闸门（`pipeline.hsl`）—— 预授权缺失时，若审批队列开启则
  **问用户**；天花板调升仍然只能由用户点头，变的只是「怎么问」。队列关闭时行为与旧版
  一字不差（CI / 脚本 / `org demo` 零变化）。
- **开启方式**：`ORG_APPROVAL=1` / `org run --approval` / TUI 团队派单 / Web 团队派单
  （交互式前端默认开 —— 人在场才问）。超时可用 `ORG_APPROVAL_TIMEOUT_MS` 调。
- **四端同权**（共用 `lib/approvals.ts` 唯一实现，避免四份目录遍历各自漂移）：
  CLI `org approvals [allow|always|deny|clear <id>]` · TUI `:approvals` / `:approve <id>` ·
  chat `/approvals` / `/approve <id>` · Web 顶栏「待批准 N」徽标 + 面板（放行 / 总是放行 /
  拒绝）+ run 卡片内联按钮。端点 `GET/POST /api/approvals`（已判定重复决策 → 409，
  坏 id → 400，不存在 → 404）。
- **判定后不删只标记**：请求文件写回 `resolved{allow,always,by,ts,waited_ms}`，
  既是自洽的审计记录，也避免「已放行却永远挂在待批准列表里」。

测试：`tests/approval.test.ts` 11 例（队列关闭零变化 / 有界超时降级 / 并发放行 /
长期放行集命中 / 拒绝 / CLI 五条路径 / Web 端点与状态码 / 四态事件归一化与分类）。
探针 `hsl/probe/probe11-approval.hsl` 可重放三态。

### 6. 三端能力对齐（账本解析统一 + TUI/chat 补齐）

**账本解析从 4 份收敛为 1 份**（新增 `lib/sessions.ts`）：此前
`cli/chat.ts` · `web/entry.ts` · `lib/engine.ts` 各有一份账本解析，**健壮性还不一致**
（Web 有记录边界重组 + 修复式解析，另两处只逐行 `JSON.parse`）—— 同一份账本在 Web 上
显示 N 轮、在 chat 与 `RunResult.directTurns` 里只剩 M 轮（M ≤ N），静默分歧。
更具体的一个后果：**`compacted` 字段只有 chat 解析**，Web 把 `/compact` 的摘要条目当
普通轮次渲染（问题栏赫然写着 `(compact digest of N turns)`）。现统一解析，Web 侧显式
标注「已压缩（原 N 轮摘要）」。各前端的**展示**差异保留（Web 预览取首问、chat 取最近
问题）——那是产品选择，不是该统一的东西。

**TUI 修补**（都是「帮助里写了、代码里没有」或死代码）：
- `j` / `k` 栏内移动：帮助表里一直有这条，但 `app.tsx` 从未处理 —— 按下只是把 j/k
  当可打印字符塞进输入框。
- `PgUp` / `PgDn` 翻页：顺带复活了 `store.ts` 里**零调用点**的 `scroll` 动作。
- `:model scripted|deepseek`：此前只能在 `org tui --model` 时定（chat 有 `/model`、
  Web 有分段控制，TUI 是唯一没有的）。
- `:score` 双轴匹配：此前只匹配能力轴，传任务类（如 `structured_extract`）会**静默空卡**；
  现与 `org score` 对齐并给出「可用能力轴 / 任务类」反馈。

**chat 补齐 7 条命令**：`/runs`（运行产物）· `/score [轴|任务类]`（评分卡，双轴）·
`/review`（运行范围复核候选）· `/keep` `/drop`（工具库治理）· `/fork`（会话派生）·
`/undo [版本]`（版本回退）。

**顺带修一个我自己的缺陷**：`cli/chat.ts` 的 `green` / `red` 两个颜色助手**从未定义**
（现有助手只有 `dim`/`bold`/`cyan`/`amber`）—— `/approve` 与治理类命令会抛
`ReferenceError`。既有单测只覆盖纯函数，斜杠分支零覆盖，所以它溜到了运行期。
已补助手，并新增 `tests/chat.test.ts` 的**进程级斜杠冒烟**（管道喂真实 REPL 逐条执行，
断言不出现 `ReferenceError` / `is not defined`）——这正是能抓到该类缺陷的测试形态。

### 7. 用量/成本时间线（补齐「数据源」承诺的另一半）

v0.5.0 把 `llm_stream_done` 具名化时写明它是「成本面板的数据源」，但当时并没有面板。
本版补齐：`lib/engine.ts::readCostTimeline()` 把一次运行的逐次模型调用还原成时间线
（轨道 / 正文与思考字符 / 耗时 / 网关 usage），按轨道聚合 + 总量；
`scripted` 剧本车道不经过网关时**明说「没有模型调用记录」而不是显示 0**；
usage 缺失时 tokens 标注为**下界**而不是伪装成精确值。

入口：CLI `org cost [--run <dir>]` · Web 侧栏「查看用量 / 成本时间线」+ `GET /api/cost`。
测试 `tests/cost.test.ts` 5 例（还原/聚合/下界/零调用明说/损坏容忍/CLI 退出码）。

### 诚实的边界（本版未做）

按约定范围，以下需要改 vendored 解释器或新增宿主通道，留作后续：
逐步文件 diff（`fs.write/edit` 记录 old/new）、`$host.net.fetch` 与 `net_connect`
接线、LLM 工具循环（function calling）、附件 / `@path` 提及、自定义 skills 目录、
桌面通知。三端能力对齐（Web 的
import/handoff/demo/config；TUI 的 `:model` / `j,k` / 会话管理；chat 的
`/review` 等）同样在后续批次 —— 本版先把「旗舰面可见」与「反悔通道」落地。

## v0.4.17（2026-09-12）—— 运行范围复核（org review）+ 四个实测缺陷修复

工具库治理第四动作 **`org review`**：回答「**这一次运行产出的东西里，哪些值得
沉淀进工具库**」—— 与 keep/drop（按名字治理库里已有资产）互补，范围由运行产物
本身界定，不靠目录时间戳猜测：

- **范围判据全部来自事件流**（事件溯源，不猜目录）：`journal:mint-register`
  （本次现场铸出）/ `journal:asset` 的 `patch <name> :: note`（本次补丁合入）/
  `journal:dispatch` 的 `channel=reuse <name>`（本次复用命中）。缺省范围取
  **最近一次有 harness 产出的运行**（`latestHarnessRunDir`）——一次 demo 会连跑
  out-a…out-c 再跑 out-direct/out-handoff，按字面最新选会永远命中最不相关那次；
- **交互选取**：编号逗号分隔 / `a` 全选 / `n` 全不选 / 回车全选 / `q` 取消；
  支持全角逗号与空格分隔；非法输入明确报错而不是静默当作空选；
- **非交互通道**（脚本与三前端共用同一语义）：`--keep a,b` / `--all` / `--none` /
  `--dry-run`；**stdin 非 TTY 且未给选取时不猜**（退出码 2 + 指路显式通道）；
- **选取只翻转 retained，不删任何文件**：未勾选候选保持 `retained=false`
  （B 路径自动复用不命中），源码 / fixture / 评分卡全部留在库里 —— 「不保留」是
  可逆的降权而不是删除；
- **三端同权**：CLI `org review` · TUI `:review [all]` · Web GUI 复核面板
  （顶栏「待复核 N」徽标 → 勾选面板 → 确认沉淀）；Web 端 `GET /api/review` /
  `POST /api/review`，越界名 **409 明确拒绝**而不是静默生效一部分；
- **org demo 的 K 相位改为真交互**：人在场（TTY）就真的问用户选哪几个候选；
  非交互（CI / 管道 / 测试）保持 scripted 全选，叙事确定性不变；
- **`org run` 收尾提示**：本次有待决策候选时打印一行可执行的下一步
  （不提示就等于工厂白铸 —— 工厂产物默认候选，不选取不进 B 路径）；
- 测试 15 例锁定（tests/review.test.ts：范围判据 / 待决策集与上下文分离 /
  缺省范围跳过无产出运行 / dry-run 不写 / 非交互不猜 / 越界拒绝 / git 留痕 /
  幂等重跑 / parseSelection 四态）。

同步修复**四个实测缺陷**（详见 BUGFIXES.md B-13…B-16）：

- **B-13 工厂闸门依赖 `DHV_TS`，按 HSL 指南直接跑解释器时静默降级**：`dhv_path()`
  在 `DHV_TS` 缺省时返回哨兵串 `"UNSET_DHV_TS"`，而闸门只看 `has_bun()` → 走
  shell 车道拼出 `bun UNSET_DHV_TS check …`（必然失败），进程内兜底车道永不可达。
  工厂每轮「check 未过」三次后降级 `(factory failed)` / `coverage 0.00` / 资产少
  一项，而整轮仍报 `accepted 3/3`、退出码 0。修复：`dhv_path()` 增加自解析级
  （`DHV_TS` → `process.argv[1]`），判据改为 `has_bun() && dhv_path().len() > 0`
  （路径不可解析退回进程内车道）。测试全程掩盖此缺陷的原因是 `helpers.ts` 与
  `dhvRun` 都注入了 `DHV_TS` —— 只有「用户按指南直接跑」这条路径没有注入者；
- **B-14 资产沉淀证据从 journal 丢失**：`sink_assets` 按值收到 `journal.clone()`，
  `asset`/`drift` 两条留痕写进临时副本随函数返回丢弃 → `journal.jsonl` 永久缺失
  资产沉淀证据（实测 run A：journal 22 条 vs events 镜像 26 条，差值恰为那 4 条）。
  总线侧看似有救（`events.jsonl` 有镜像），但 `mergeStreams` 在 journal.jsonl 非空时
  整体丢弃该镜像 —— 两端叠加导致 Web/TUI/chat/`org replay` 都看不到资产沉淀。
  `metrics.json` 走另一条路所以表层指标完好，故障只藏在事件流里。修复：留痕移到
  main 的 sink 段写在真实 `mut journal` 上，`sink_assets` 不再接收 Journal；
  基线路径抽 `baseline_path_of()` 共用；
- **B-15 测试套件没有配置默认超时**：干净检出按 README 跑 `bun test tests/`，
  **26 例必然假红**——端到端用例单轮 3–14s，而 bun 默认每用例超时 5000ms，超时会
  kill 子进程从而把断言读成「真断言失败」。排查否掉两条看似可行的全局路径（实测）：
  bunfig 的 `[test]` 段**无 timeout 键**（写上仍按 5000ms 生效）；`[test] preload`
  与 `setDefaultTimeout` **只在单文件调用时生效**，`bun test tests/` 这种多文件
  （并行 worker）形态下到不了 worker —— 写进所有文件都 import 的 `tests/helpers.ts`
  也一样，环境变量 `BUN_TEST_TIMEOUT` 同样无效。故改回**逐例显式超时**（5 个纯
  端到端文件共 56 例 + `tests/web.test.ts` 的 beforeAll 与 8 个真实 spawn 用例统一
  `}, 120_000);`，与 demo.test.ts 既有写法一致；120s 是放宽等待上限、断言一字未改），
  `package.json` 的 `test` 脚本同步带上 `--timeout 120000`。修后 `bun test tests/`
  无旗标即 **220/220 全绿**；
- **B-16 `cli/org.ts` 缺 `import.meta.main` 守卫**：任何 `import` 都会执行整条 CLI
  并 `process.exit`（表现为导入方被静默终结）。`cli/chat.ts` 早有守卫且
  `tests/chat.test.ts` 正靠它导入纯函数 —— 同一约定在 org.ts 漏了。修复：
  导出 `orgMain` + 入口守卫，与 chat.ts 对齐（副作用：CLI 纯函数从此可单测）。

## v0.4.16（2026-09-11）—— 用户模型/API 持久配置（org config）

对标 codex（`~/.codex/config.toml`）/ opencode（`opencode.json`）的模型
持久配置面 —— 用户可自己配置模型与 API，不必每次 export 环境变量：

- **`org config` 子命令**（lib/config.ts · 全新模块）：`~/.org/config.json`
  跨版本持久（`ORG_CONFIG` 可重定向）；原子写（tmp → rename）；
- **六服务商预设**：deepseek / openai / openrouter / ollama / lmstudio /
  vllm 一键写入（`org config preset <name>`，本地推理预设免 key 即用）；
- **来源归因**：`org config`（无参）逐项标注 ← 环境变量 / 配置文件 / 缺省；
  优先级 **CLI 旗标 > 环境变量 > 配置文件 > 内建缺省**（Unix 惯例）；
- **`org config test` 连通验证**：当前生效配置发一次 1-token 真实请求
  （延迟 · 回复 · tokens 回显）——「配了没生效」立即暴露；
- **`default_lane` 缺省车道**：`org config set default_lane deepseek` 后
  `org chat` / `org run` / `org ask` 免每次 `--model`（modelExplicit
  显式旗标优先，不打架）；
- **api_key 脱敏**：显示只露首 3 尾 4（`sk-…9402`）；
- **双入口注入**：cli/org.ts main() 启动即注入 + cli/chat.ts 独立入口
  幂等补注入 —— 全部子命令 / 子进程（dhv run 嵌套车道）统一继承；
- 测试 20 例锁定（tests/config.test.ts：键归一别名 / 原子写往返 / 损坏
  容错 / env>file 优先级 / 预设不动 api_key / 三态归因 / 脱敏），
  全量 **205/205 全绿**（11 文件）；
- 实测：deepseek 预设 + 真实 key `org config test` 181ms 连通 ✓；
  `default_lane=deepseek` 后无旗标 `org ask` 直连真实车道（1.2s 应答）。

## v0.4.15（2026-09-11）—— 交互式聊天 REPL + Token 流式输出（对标主流 Agent）

把 ORG 从「批处理流水线」补齐为「真正的交互式 Agent」—— 对标 codex /
opencode / zcode 的核心交互面，同时**零旁路**直连池的全部治理（事件上总线 ·
花销记账 · 会话账本 · 纪要回写）：

### org chat —— 交互式聊天 REPL（cli/chat.ts）

- **多轮交互对话**：`org chat [expert]`，会话史跨轮织入提示词（磁盘会话账本
  `runtime/sessions/<expert>/<session>.jsonl`）；专家缺省取首个保留专家（★）；
- **Token 流式输出**：宿主流式车道（vendored dhv-ts v0.2.61）增量落盘
  `llm-stream.jsonl` → 引擎泵尾随 → REPL 逐 token 渲染；**思考指示器**
  （`◈ thinking · N chars` 单行刷新，DeepSeek reasoning 通道分离实测）；
- **斜杠命令**：/help /model /expert /new /sessions /resume /status /ctx
  /history /retry /compact /clear /exit —— 模型热切换、专家热切换、会话管理
  一应俱全；
- **上下文压缩 /compact**：LLM 摘要会话史 → 账本重写为单轮摘要条目
  （`compacted:true, compacted_from:N`），原文件备份可手工回滚 —— 主流
  Agent 的 context compaction；
- **shell 逃逸**：`!cmd` 用户发起 · 结果直接可见（不经 harness 能力面）；
- **Ctrl+C 语义**：运行轮 = 取消当前轮（SIGTERM 子进程，本轮不落账本）；
  队列中 = 跳过待处理行；空闲 = 双击退出；
- **↑↓ 历史导航**：readline 原生 + 跨会话持久 `runtime/chat-history.txt`
  （500 条上限）；反斜杠续行多行输入；
- **readline 异步陷阱修复**：line 事件不等待 async 处理器 —— 管道/粘贴多行
  输入时轮次会被跳过。输入队列 + 串行泵保证逐行完全落地；
- **`org sessions [expert]`**：跨专家会话账本清单（轮次 · tokens · ctx 窗口
  计量 · 最近问题）。

### 流式基础设施（观测面三端贯通）

- **宿主**（vendored dhv-ts v0.2.61 同步）：`$host.llm.complete` 补
  `stream/track` 参数；SSE 逐块解析；reasoning/content/reset 三通道增量
  append-only 落盘；llm_stream_done 事件；空正文可诊断（reasoning_chars）；
- **模型网关**（hsl/providers/model.hsl）：deepseek 车道一律带
  `stream:true + track`（轨道归因贯通到每条增量）；
- **引擎泵**（lib/engine.ts + lib/events.ts）：150ms 尾随 llm-stream.jsonl →
  `llm_delta` 事件（三通道）并入归一化事件流；
- **Web GUI**：askStreamOnce 加 llm-stream 尾随泵（120ms）→ SSE `delta`
  事件；GUI 思考指示器 + 逐 token 正文渲染 + reset 清屏重绘（scripted 车道
  回退 stdout 行流，行为不变）；
- **TUI**：llm_delta 走 default 分支优雅忽略（事件卡面向 run 叙事，不炸）。

### 实测验证（DeepSeek 官方 API · deepseek-flash）

- chat REPL E2E：思考 889 chars 流式指示 → 正文逐 token 渲染 →
  `turn 1 · 47 tokens · 1.7s · 思考 889 chars` 计量收尾 → 账本落盘；
- Web GUI E2E：SSE 160 个 delta 事件 + done 完整答案 + ctx 计量条；
- 增量产物：848 行（1 reset + 357 reasoning + 490 content）保序落盘。

### 测试

- 新增 tests/chat.test.ts 17 例（parseInput 四态 / 会话账本单元 / compact
  重写回滚 / mock SSE 流式四例 / events 解析合流 / scripted 负例）；
- 全量 168 → **185 全绿**；HSL 侧 172 → **176 全绿**（网关测试补位）。

## v0.4.14（2026-09-11）

**Web GUI 排队轮可预先取消 + 版本单一来源治理批次**。排队取消：`org web`
的 ask 是单飞串行（direct 流水线固定写 `workspace/out-ask`，并发互踩产物），
但纯 promise 链没有句柄 —— 第二轮排队期间既无法撤回（Esc 提示「尚不能停止」
形同虚设），`POST /api/abort` 又只认 `runningProc`：想停 B 却把运行中的 A
误杀。版本漂移：v0.4.13 批次后 `web/entry.ts` 仍硬编码 `0.4.12`（GUI chrome
徽标落后两版）—— worklog 记录的 TUI 版本漂移 bug 在 web 侧复发，本轮把
版本字面量收敛到单一来源模块根治。

### 新增：排队票据化（web/gate.ts）

- **AskGate 串行门**：`issue()` 发票（id 唯一递增）· `enter()` 轮到执行
  （票据已取消则抛 `QueueCancelledError`，不占流水线、不落账本）·
  `cancel(id)` → `cancelled`/`running`/`unknown` 三态 · `release()` 流终
  态清理（排队中的票据不摘：客户端断开 ≠ 取消，轮次照常落账本 —— 与
  「账本是事实源」同一语义）；「查取消 → 置 running → 摘票」同步临界区，
  JS 单线程事件循环保证与 `cancel()` 无交织；
- **SSE 协议**：`open` 事件新增 `ticketId` 回显；排队轮被取消时流以
  `error{aborted:true, queued:true}` 收尾（`start`/`done` 不出现 ——
  本轮从未开跑）；
- **`POST /api/abort` 语义升级**（向后兼容）：无 body / 无 `id` → 传统
  行为（SIGKILL 运行轮）；`{id}` 命中排队轮 → 预先取消（不误伤前一轮，
  这是本轮修的交互性 bug 的核心）；`{id}` 命中运行轮 → 等价传统路径；
  查无此票 → 人话告知；JSON 端点 `POST /api/ask` 同享票据语义（取消的
  轮返回 `{ok:false, aborted:true, queued:true}`）；
- **GUI**：排队等待行从「尚不能停止」改为「esc 取消本轮」；取消收场
  专属提示「已取消排队 · 本轮未开始」。

### 修复：版本单一来源（lib/version.ts）

- 新增 `lib/version.ts`（`ORG_VERSION` / `ORG_VERSION_TAG`），`cli/org.ts` ·
  `tui/frame.ts`（重导出保持消费面不变）· `web/entry.ts` 三处统一引用；
  根治「每发一版总有某个入口的徽标忘记改」的结构性问题；
- `package.json` 0.4.14；README 徽章与状态行同步。

### 同步：vendored dhv-ts v0.2.60（上游 S-20 字面量字段闸门 + 宿主面三修）

- 上游 HSL v0.2.60 新增 `S-20` 静态校验（struct/变体字面量未知/缺失/重复
  字段 —— 实测：构造不存在字段 check 全绿、run 静默收下），本仓 vendored
  同步 → **工厂闸门随之变严**：minted harness 的坏字段字面量从此被
  `dhv check` 拦截（与既有「check 拒绝 → 诊断反馈有界再生成」链路天然
  衔接）；ORG 自身 HSL 源与全部 fixture 经全量回归零误报；
- 同步宿主面三修：`nextReview` 耗尽抛错（审查判定不可静默伪造 accept ——
  验收闸门证据源完整性）；`fs.list` 深度默认 8 层可配（原 2 层硬编码，
  深层文件对 harness 静默不可见）；**路径监狱 symlink 实解析**（实测
  workspace 内符号链可把 read/write 送到监狱外 —— 双向量穿越修复，
  脚本化 harness 的安全边界即保证）；
- payload 再生（指纹 37cdaea…）。

### 测试

- 新增 `tests/gate.test.ts`（7 例：FIFO 串行 / 取消拒绝执行 / 不误伤 /
  running/unknown 判别 / release 语义 / 失败不堵队列 / id 递增）；
- `tests/web.test.ts` +3 例（abort 空转诚实告知 / 查无此票 / 排队取消
  E2E：真实 spawn 车道 A 运行中 B 排队 → 取消 B → A 完整收场 + A 落账本
  B 未落）；全量 168/168 通过。

## v0.4.13（2026-09-10）

**DeepSeek 官方 API 直连（v4.1 flash / `deepseek-flash`）+ 实测驱动的数据路由
与工厂健壮性批次**。v0.4.10 的 `DHV_LLM_GATEWAY` 假设「网关自持鉴权/限流」
的内网部署形态；用户提供 DeepSeek 官方 key 实测直连
`https://api.deepseek.com/v1` 抓到三个缺口（401 无鉴权头 / model 字段缺失
无法路由 / 无超时挂死），随后跑真实 E2E 又暴露五个系统性缺陷（任务数据
不达专家 / 技能标签盲配复用 / 自生成验收样本格式漂移 / Exam 失败无重试 /
推理型模型预算失控），本批全部修复。

### 新增：网关直连（vendored dhv-ts v0.2.59）

- **网关三件套 + 思考量控制**：
  - `DHV_LLM_API_KEY` → `Authorization: Bearer <key>`（缺省不发，内网网关
    行为不变）；
  - `DHV_LLM_MODEL` → 请求体 `model` 字段（缺省不写，网关侧默认路由不变）；
  - `DHV_LLM_TIMEOUT_MS` → fetch 超时保护（默认 180s，显式 0 关闭）；
  - `DHV_LLM_THINKING` → `off` → `thinking:{type:"disabled"}`，
    `low/medium/high` → `reasoning_effort`（实测 DeepSeek 均接受，off 时
    reasoning_len=0）；缺省不发送（服务商默认，兼容严格校验的网关）；
  - 429/瞬断退避仍由 `providers/model.hsl` 有界重试承担（1s→3s 三次），
    工具链层错误原样传播可诊断；
  - 超时实现用 AbortController + finally clearTimeout（不用
    AbortSignal.timeout —— 实测 Bun 的 fetch 完成路径与 timeout 信号交互
    可丢延续：响应已达但 await 不恢复，进程 park 在 sigsuspend 空事件
    循环，且每调用泄漏一个 180s timer）。
- **Web 横幅网关可见性**：`org web` 启动横幅回显网关地址 · 模型名 · 鉴权
  状态（防「配了没生效」——环境变量经 spawn 车道继承，横幅是唯一确认面）；
- **README 直连服务商速查**：DeepSeek / OpenRouter / vLLM / Ollama 环境变量
  即插即用示例。

### 新增：推理型模型适配（E2E 实测根因修复）

- **maxTokens 2048→8192**：deepseek-flash 的 reasoning 计入 `max_tokens`
  同一预算 —— 实测 mint 调用 reasoning 吃满 2048（finish_reason=length、
  content 空）→ 三连 "empty completion" 炸穿 run；
- **空 content 可诊断化**：网关路径空 content 抛错携带 `finish_reason` +
  `usage`（预算截断 vs 真空返回可区分，实测抓根因的关键观测面）；
- **退避升级**：`finish_reason=length`（推理失控）时下一次重试自动关思考
  直接产出 —— 实测 reasoning 可膨胀到 32k 字符仍零正文，加预算是烧钱
  不是修复；与工厂 check 闸门「诊断反馈重试」同构的有界自适应；
- **mint 轨道默认关思考**：推理型模型在代码生成上推理失控是常态
  （~45s/次的烧预算税），check + Exam 双闸门保证 mint 质量 —— 闸门优先
  于信任；显式 `DHV_LLM_THINKING` 配置优先（用户要思考就给思考）。E2E
  实测：烧预算税消除后全链路 560s+ 超时 → 176s 完成。

### 新增：任务物料路由（mission 数据不达专家 → 专家编造数据）

- **SubTask.input 物料提示**：分解器标注每个子任务的输入物料在哪儿
  （`mission` = 使命文本内联数据 / `workspace` = 工作区 raw 材料）；
  DECOMPOSE_PROMPT 按数据实际位置路由，缺省 workspace（旧剧本不带此字段
  行为不变）；
- **prepare_payload 三级路由**：validate → 上游交付物机械编接（不变）；
  input=mission → 使命文本即输入材料；workspace 缺材料时回落使命文本
  （诚实边界：空载荷下专家只能编造 —— 实测 `total_reviews: 25` 凭空
  出现）；
- **内联通道同款回落**：无 raw 材料不再硬错「raw/notices.txt 缺失」（新
  工作区跑任意任务都被演示约定卡死）；parse 角色的内联交付物 = 真实材料
  原文（占位符实测流进 mint_fixture 预览与 validate 载荷）。

### 新增：B 复用语义地板（技能标签命中 ≠ 语义匹配）

- **REUSE_AFFINITY_RATIO = 0.3**：serves 只看技能交集、affinity 只用于
  选优 —— 实测情感分析任务的 parse 子任务被复用到公告解析器（词面重合
  2/22=9%）→ 产出 5 条旧公告记录。命中比例达地板才可复用，否则 C 现场
  生成（工厂成为活跃路径）；比例制统一处理中文二元滑窗膨胀与英文/短 goal
  （minted 描述由 goal 派生，重派命中率高 —— 记忆化重派不误伤）；
- **工厂登记后按名取回**：身份已知时语义检索是多余自由度（地板落地后
  mint_spec 描述漂移会让登记后检索落空 →「管线状态不一致」假 Err）。

### 新增：工厂健壮性（自生成验收样本的格式漂移）

- **载荷预览织入 mint_hsl 与 mint_fixture 双侧 brief**（前 400 字符）：
  mint_hsl 与 mint_fixture 是两次独立模型调用，字段名词汇表会漂移（实测
  生成器找 "date" 而样本用「日期」→ 闸门必挂；样本单引号伪 JSON
  `'record_id':'R001'`）；同一预览喂两侧，词汇表钉死在真实载荷上；
- **Exam 失败有界再生成**：与 check 失败同构（诊断反馈重试）—— 此前
  行为闸门一挂直接 Err 炸工厂，但行为缺陷恰恰是诊断反馈最能修的形态。

### 测试

- 新增 `tests/gateway.test.ts` 6 例：鉴权头+model 字段贯通（mock 网关回显
  闭环）/ 缺省行为不变 / 超时中止（300ms 慢网关 + `DHV_LLM_TIMEOUT_MS=1`）/
  4xx 错误体传播（401）/ 空 content 诊断（finish_reason=length +
  reasoning_tokens）/ 思考量控制三态（off→thinking、low→reasoning_effort、
  缺省→均不发送）；
- 新增 `tests/fixes.test.ts` 5 例：input=mission 路由（1 块而非 5 条公告）/
  缺省 workspace 行为不变 / 无材料回落不硬错 / 低亲和 goal 走 C:generate /
  高亲和 goal 仍 B:reuse；
- 全量 147→**158** 通过；HSL 上游 run-all 163/163（版本联动 0.2.59）。

### E2E 实测（DeepSeek 官方 API · deepseek-flash）

- `org ask` 直连问答 3.4s 真实结构化回答；
- 团队模式全链路（分解 → 路由 → 工厂 mint → check → Exam → Register →
  监督 → 汇总）多轮验证：语义地板下情感任务三个子任务全部正确走工厂；
  烧预算全部被思考升级救回；公告域任务高亲和正确复用 notice-parser
  （5 条记录 + 日期归一化，coverage 1.00）；z-ai-web-dev-sdk 账号级 429
  配额不再是真实模式唯一出口；
- 已知边界（诚实声明）：minted 专家质量存在生成方差（词典覆盖度参差），
  check/Exam 双闸门尽职拦截不合格生成物 —— 闸门拒绝率即基座模型能力的
  真实度量（论文可用的实测数据点）。

## v0.4.12（2026-09-10）

**实测驱动的健壮性批次：deepseek 真实模式全链路打通 + Web GUI 工具库治理**。
外部实测（真实模型跑团队模式全流程）发现五个缺陷面并全部修复；同时把用户
「选取哪些 harness 保留到工具库」的决策权搬进 Web GUI。

### 修复（实测发现）

- **工厂生成有界再生成（本批核心）**：deepseek 真实模式下首生成物是 Rust
  风格（`use std::…` / serde_json / `$host.http`——基座模型不认识 HSL），
  `dhv check` 正确拒绝后**整个 run 直接 Err 崩溃**。三层修复：
  ① `MINT_SOURCE_PROMPT` 补齐 HSL 语法铁律 + 经 check/run 实测验证的完整
  最小示例 + 不存在的 API 负面清单（内建 prelude 无需 import / 无网络访问 /
  宿主 API 只在 native 块内）；
  ② 管线有界再生成（`MAX_MINT_ATTEMPTS=3`，与监督回路的有界返工同构）：
  check 拒绝后把诊断信息反馈给生成器重试，耗尽才 Err（错误文案含次数与
  诊断）；
  ③ mint_spec 提示词把子任务技能标签织入 brief + 登记时取能力并集 ——
  分解器 skills 与规格 capabilities 是两次独立模型输出，词汇表漂移会让
  登记后检索 `serves` 失配（「管线状态不一致」Err）；
- **工厂失败优雅降级**：C 路径工厂失败不再 `?` 炸全场 —— 转为失败报告
  （coverage 0 + factory-failed 标注）交监督回路处理（有界返工重试 /
  耗尽后强制收货时失败标注随报告可见），不连累已完成的其余子任务；
- **recurrence 序列化卫生**：`save_recurrence` 键（`expert::note`，note 来自
  模型审查意见）裸 `format!` 插值 —— 一条含引号的 Revise note 即写坏
  `runtime/recurrence.json`，且 `load_recurrence` 裸 `JSON.parse` 使之后
  **每次 org run 崩溃**（需手工删文件）。写侧过 `json_escape` + 读侧损坏
  容错（降级空表 + stderr 提示，save 重写自愈）；
- **handoff 账本续写**：`$host.artifacts.write` 覆写语义使重复暖移交把
  账本截断到只剩最后一条（与 direct.hsl 的多轮累加不一致）；改为读旧续写
  （与 direct.hsl 同款）+ task 过 `json_escape`；
- **Web GUI ctx meter 正则**：used 侧 ≥1k tokens 时 CLI 打印 `8.4k/131.1k`
  （fmt_k 加 k 后缀），旧正则 `(\d+)\/` 只认纯数字 → 长会话的计量条永远
  失配降级纯文本。正则改 `([\d.]+)k?\/` 并用整段匹配展示；
- **crystallize 序列化卫生**：memo 键值裸插值（含引号写坏
  `registry/memos/<expert>.json`）→ 过 `json_escape`；
- **版本号联动修复**：`tui/frame.ts` 的 `ORG_VERSION` 停在 v0.4.3（README
  声称的版本联动自 v0.4.3 后失守）+ `cli/org.ts` 头注释 v0.4.8 → 统一
  v0.4.12；`--turns` 用法注释的分隔符（`,` → 实际的 `|`）；TUI 会话名格式
  与 `lib/engine.ts` 的 `makeOutDir` 对齐（`out-YYYYMMDD-HHMMSS`，此前
  状态栏 currentSession 与真实产物目录永远对不上）。

### 新增

- **Web GUI 工具库治理（用户点名的功能）**：`POST /api/keep` / `POST /api/drop`
  端点（复用 CLI `setRetained` 同一代码路径：翻转 retained + 双写注册表 +
  git「(user curation)」留痕）+ 专家卡 hover 浮现 ★/○ 切换钮（导入专家免
  切换——导入即保留；运行中禁用防派单寻址漂移）+ hintline 轻量提示条；
  dist/demo 快照只读守卫与 CLI 同款。「哪些 harness 值得留下来」是用户的
  决策权——现在 GUI 与 CLI / TUI 三端同权；
- **vendored dhv-ts 与上游统一**：同步至上游 v0.2.58（吸收本仓库 B-6/B-7/
  网关的上游化版本 + 上游 CRLF 容忍/execPy 跨平台回退/PYTHONUTF8 + 位运算
  BigInt 语义与 String::find 码点索引两修复）—— 终止双向漂移，恢复单一
  事实源（HSL 仓库 issue #8）。

### 测试

- 新增 `tests/fixes.test.ts` 8 例：recurrence 写侧/读侧 round-trip/损坏容错、
  工厂再生成（重试成功 + 耗尽显式 Err）、handoff 账本两行、meter 正则双形
  态、crystallize 含引号 round-trip；
- web.test.ts 新增 3 例：keep/drop 端到端（retained 翻转 + git 留痕 ×2 +
  /api/status 反映）、防呆（非法名 400 / 不存在 404）、GUI HTML 治理面断言；
- 全套 144 个机制级测试通过（136 + 16 新增）；`org demo` 全叙事 2.3s 复现
  model_calls 5→1→0 不变。

## v0.4.11（2026-09-09）

**`org web` GUI 正常 Agent 化收尾（issue #13）**。方向背景：擂台/对比
退役（issue #10 收口），仓库只保留 Agent 本体；GUI 对照「正常 Agent」
的最后一层缺口补齐 —— 回答此前以纯文本渲染、无消息级操作、会话不可
搜索、移动端侧栏直接消失。

### 新增

- **Markdown 渲染（零依赖 renderMd）**：回答正文支持围栏代码块（语言
  标签 + 块级 copy 钮）· 表格 · 有序/无序列表（缩进嵌套 + 续行）·
  引用 · h1-h4 · 分割线 · 行内粗/斜/删/行内码/链接（http(s) 限定 +
  裸 URL 链接化）；流式期间渐进渲染（未闭合围栏 EOF 容忍）；实现纪律：
  服务端导出可单测，`fn.toString()` 注入 GUI —— 浏览器与测试永远同一
  实现；XSS 优先：全量转义后再还原受控标签；
- **消息级操作**：每轮「复制」（Clipboard API + execCommand 兜底，按钮
  闪烁反馈）+ 末轮「重发」（账本为事实源：重发 = 追加新轮次，不篡改
  历史）+ 代码块级 copy；hover 浮现不抢视觉；
- **会话搜索**：侧栏过滤框（id / 首问预览匹配，`Esc` 清空）；
- **移动端抽屉**：≤720px 侧栏不再 `display:none` 消失 —— 改抽屉
  （header 菜单钮 `≡` + 遮罩点击关闭，选会话/专家自动收起）；
- **快捷键**：`⌘K`/`Ctrl+K` 新会话 · `/` 聚焦输入（esc 停止为既有），
  banner 与输入坞 hint 同步展示；

### 测试

- 新增 renderMd 单测 8 例（围栏/表格/嵌套列表/续行/XSS/行内/块级/空
  输入）+ GUI HTML 回归断言 5 处（renderMd 注入/sessSearch/menuBtn/
  backdrop/mact-copy）；全套 136 个机制级测试通过；
- agent-browser 实测通过：Markdown 富回答渲染（标题/嵌套列表/表格/
  引用/代码块 copy）、消息复制反馈、搜索过滤（无匹配/命中/清空）、
  移动 500×900 抽屉开合与自动收起、Ctrl+K 新会话、`/` 聚焦、scripted
  SSE 真实对话（turn 2 落账本）、控制台零错误。

## v0.4.10（2026-09-09）

**`org web` GUI 失败轮呈现修复（v0.4.9 实测发现的真 bug）**。deepseek 真实
模型遇到网关限流/上游超时时，SSE `done` 事件携带 `ok:false` —— v0.4.9 的
GUI 把它当成功轮渲染成「（无回答）· ledger 已落盘」，误导（失败轮实际不落
账本）。现在走错误块：`✗ 直连失败` + 「重试」按钮 + 默认展开的 run log
（失败原因一目了然）；失败轮不落账本 → 重试安全（复用同一问题重发）。

### 新增

- **`org web --gateway <url>`（短参 `-g`，或环境变量 `DHV_LLM_GATEWAY`）**：
  把 `$host.llm` 路由到 OpenAI 兼容端点（如本机 llm-gateway 的
  `http://127.0.0.1:3030/v1`）—— deepseek 真实模型车道独立部署可用，
  无需本机安装 z-ai-web-dev-sdk（仓库零依赖原则不破坏）；未配置时
  启动横幅人话提示。

### 修复

- `finalize` 的 done 分支加 `outcome && outcome.ok` 守卫：ok:false 走
  errbox（重试按钮 + run log 默认展开），不再显示「无回答 · 已落盘」；
- 回归断言：GUI 单页含 `outcome && outcome.ok` 守卫字符串（防止回退）。

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
