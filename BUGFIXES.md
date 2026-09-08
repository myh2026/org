# BUGFIXES — ORG 开发过程中发现并修复的 HSL 工具链问题

> 开发 ORG 的过程同时是对 HSL（dhv-ts 参考解释器）的一次实测。以下按严重度排序，
> 每项含复现探针（`hsl/probe/` 下可重放）。上游修复提交在
> [harness-specification-language](https://github.com/myh2026/harness-specification-language) 仓库。

## B-1（已修复上游）`Vec::iter_mut` 缺失于解释器内建方法面

- **现象**：`dhv check` 通过的源码在运行期崩溃 `Vec 没有方法 "iter_mut"`。
- **影响面**：旗舰示例 nova 的 `state.hsl::accept/complete_task`（`for t in self.tasks.iter_mut()`）
  即使用该写法——**nova 可 check 不可 run**，属于「check 过 / run 崩」的静默断层。
- **复现**：`hsl/probe/probe7.hsl`（check ✓ / run ✗ → 修复后 run ✓ 且字段写透传）。
- **修复**（`dhv-ts/src/builtins.ts`）：`VEC_METHODS` 注册 `iter_mut: { fn: (r) => r }`。
  语义：返回数组本体；struct 元素是 JS 对象引用，`for t in v.iter_mut() { t.field = ... }`
  的字段写按引用透传（与解释器既有的对象透明共享模型一致）。primitive 元素的写不透传
  ——这是解释器透明性模型已记录的边界，在修复注释中声明。
- **权衡**：也可以在 nova 侧改写为重建模式绕开，但 `iter_mut` 是 Rust 对等 API 且
  checker 已接受——修解释器比修示例更正确（一处修复，全生态受益）。

## B-2（已修复上游）`String::push(char)` 缺失

- **现象**：`out.push('\n')` / `out.push(' ')`（Rust 惯用的 char 追加）运行期报
  `String 没有方法 "push"`；`push_str` 存在。
- **影响面**：ORG 中 5 处使用（`normalize_note` / `normalize_key` / journal flush 等）。
- **权衡**：第一反应是逐处改写为 `push_str("\n")`（单处出现时这是更低扰动的选择）；
  当出现第 5 处时判断反转——补齐 Rust 对等 API 是 3 行修复且无歧义，逐处改写反而
  让源码偏离惯用法。**判定规则：出现 1-2 处改调用方；≥3 处修工具链。**
- **修复**（`dhv-ts/src/builtins.ts`）：`STRING_METHODS` 注册 `push`（mutating，与 push_str 同构）。

## B-3（设计观察，未修上游）`$host.json.fields` 的类型纪律没有防呆

- **现象**：手写 native 块里的 `out.set(k, String(v))` 把 `["parse"]` 静默压成 `"parse"`
  （JS `Array.toString` 语义），下游 `JSON.parse` 报 `Unexpected identifier "parse"`。
- **根因**：HSL 生态已有定式「native 拍平字符串 + `$host.json.fields` 逐字段重建」（dsh 注释明示），
  但没有工具级防呆——手写映射极易踩中 JS 类型强转陷阱。
- **处置**：ORG 侧统一修复为 `typeof v === "object" ? JSON.stringify(v) : String(v)`
  （3 处：manifest 加载 / org 分解 / minted 专家工单解析），并在每处标注类型纪律注释。
  未改上游（防呆属于 host API 设计决策，超出 bug 修复范围——记录于此供 HSL 演进参考）。

## ORG 自身的关键工程教训（对联调日志的沉淀）

1. **节点按引用传递**：graph 体内 `execute(journal.clone(), ...)` 会让工厂登记写进克隆副本，
   内核注册表永远学不到新专家（表现为「工厂每次重跑」）。HSL 参数按 JS 引用传递，
   需要写回的节点直接传本体。
2. **fixture 轨道索引随进程重置**：每次 `dhv run` 是独立进程，轨道消费从 0 重算——
   跨轮剧本设计必须保证「各轮的第一条 miss 落在同一轨道位置且取值一致」
   （见 `scripts/make-fixture.ts` 的轨道设计注释）。
3. **JSON 序列化卫生**：手写 `push(',')` 循环会产生尾逗号，统一 `Vec<String>.join(",")`。
4. **验收语义 ≠ 执行语义**：嵌套执行的 ok 判定（run.json）与覆盖率闸门（acceptance.json）
   必须分离——真实派单首轮低覆盖是合法的 Revise 语义，只有工厂 Exam/smoke 才施加覆盖率线。
5. **补丁文本必须过 S7**：替换行导致原变量未使用会被严格性检查拒绝——补丁提案要保留
   被替换表达式的变量引用（`|| true` 幂等化）。


## B-4（vendored 修复，随 v0.4.0 上游同步）`version.ts` 在嵌入执行下读取 package.json 失败

- **现象**：dhv-ts 被静态打包进宿主二进制（ORG 单文件分发）后，`import.meta.dir` 指向
  打包器虚拟 FS（`/$bunfs/...`），`readFileSync(join(import.meta.dir, '..', 'package.json'))`
  抛 ENOENT，解释器 import 即崩。
- **权衡**：package.json 单一来源纪律必须保留（这正是该文件的设计动机）；虚拟 FS 又不可写。
  判定：保留主路径，加两层降级——`DHV_VERSION` 环境变量（宿主解包运行时资源后注入）→
  `0.0.0`。崩溃变成可诊断的版本号占位，纪律与稳健性兼得。
- **修复**（`dhv-ts/src/version.ts`）：`readVersion()` try/catch 包裹 + 环境变量回退。

## B-5（vendored 修复，随 v0.4.0 上游同步）CLI 顶层执行式入口无法被宿主进程内复用

- **现象**：`main.ts` 顶层读 `process.argv` 并 `process.exit`——宿主进程（ORG TUI 引擎桥 /
  `$host.dhv.*`）无法在不爆模块缓存（`?v=N` query 再 import 的 hack 在 bun compile 的
  打包产物里直接失效：动态计算 specifier 不进 bundle）的前提下重复调用解释器。
- **权衡**：也可保持 CLI 形态、由宿主 spawn 自身二进制 + 隐藏命令转发——但那样 HSL 侧
  工厂闸门的 `$host.shell.run` 首词白名单、带空格路径的 shell 分词都要跟着改，扰动更大。
  判定：把 main.ts 重构为 `export async function cliMain(argv): Promise<number>` +
  `import.meta.main` 守卫——CLI 行为零变化，嵌入场景获得可编程入口（重复调用状态隔离由
  `loadProgram` 的 fresh Map 保证，无模块级缓存）。
- **修复**（`dhv-ts/src/main.ts` + `host.ts`）：`cliMain` 导出；宿主新增
  `$host.dhv.check(file)` / `$host.dhv.run(args)` 进程内兜底（懒加载 cliMain 规避
  main↔host 静态循环；stdout/stderr 捕获后恢复）。ORG 侧配套：`hsl/factory/pipeline.hsl`
  工厂闸门双车道（bun 在场走嵌套子进程——蓝绿语义不变；缺席走进程内——路径基准显式
  对齐 `$host.config.workspace`）。

## B-6（vendored 修复，v0.2.58）内建方法面大面积缺口：Rust 对等高频方法 check 全过 / run 全崩

- **现象**：实测（probe10.hsl 前身，逐方法探针）以下 Rust 对等方法在 dhv-ts 中全部缺失——
  checker 对 `.method()` 只查接收者与参数、不校验方法名，解释器 `builtinMethodFor`
  找不到即抛「没有方法」—— B-1 类断层的最大聚集面：
  - **Vec 迭代器**：`find` / `filter_map` / `flat_map` / `flatten` / `count` / `min` / `max` / `zip` / `chain` / `step_by`；
  - **Vec 变形**：`reverse` / `dedup` / `retain` / `truncate` / `chunks`（`reverse` 尤其隐蔽：数组被 foreign 直通分支显式排除，必崩）；
  - **String**：`split_once` / `rsplit_once` / `clear` / `truncate` / `retain` / `insert` / `remove`（「k: v」拆键值此前只能 find+take+native slice 三跳绕）；
  - **HashMap**：`iter`（遍历此前只能 keys()+get() 两跳）；
  - **Result**：`unwrap_or_else`（Option 有、Result 无——同族不对称）/ `unwrap_err`；
  - **Option**：`and`（`or` 在、`and` 无——同族不对称）。
- **复现**：`hsl/probe/probe10.hsl`（修复前逐项报「没有方法」，修复后 25+ 断言全绿）。
- **修复**（`dhv-ts/src/builtins.ts`）：按 Rust 语义逐一对齐——`find`/`min`/`max` 返回
  `Option`（空 Vec → None）；`dedup` 去连续重复（deepEq）；`split_once` 空分隔符报
  运行期错误（Rust panic 对应物）、返回 `Option<(before, after)>`（`Some((k, v))`
  直接解构）；`min`/`max` 要求同构 Ord（全数值或全字符串，混合报错不静默强转）；
  `String::insert/remove` 返回值语义对齐（remove 返回被移除字符）；`zip` 短边截断；
  `chunks` 尾块允许不足 n；`HashMap::iter` 产出 (K, V) 二元组流。
- **判定依据**（沿用 B-1/B-2 的裁决规则）：这是「Rust 对等 API + check 已接受」的
  缺失面，修工具链（一处修复，全生态受益）而不是要求每个项目绕写。
- **已知边界（记录不修）**：`HashMap::entry`（or_insert 需左值语义）、
  `unwrap_or_default`（None 无类型信息可推默认值）—— 解释器透明性模型的既定边界，
  待 HSL 演进（BNF 路线图）决策。

## B-7（vendored 修复，v0.2.58）check 阶段无法暴露方法名断层：新增 S-19 静态预警

- **现象**：B-1（iter_mut）与 B-6（26 个方法）的共同根因——checker 的 `case 'method'`
  只做 S-2 裸 unwrap 警告，方法名是否存在于运行期方法面完全不可见。
  「check 全绿 → 上线 → run 崩」在类型化注解场景是静态可判定的，不应留到运行期。
- **修复**（`dhv-ts/src/checker.ts`）：新增 `S-19` warning——`let` 声明注解为
  `String` / `Vec` / `HashMap` / `Option` / `Result`（穿引用/泛型取首段）的绑定
  记入作用域；该绑定上的 `.method()` 若不在运行期方法面（与 `builtinMethodFor`
  同表），check 输出带位置与提示的预警。
- **复现**：`hsl/probe/probe10-negative.hsl`（故意调用三个不存在的方法 →
  `check` 输出 3 条 warning[S-19]、0 error；退出码不受影响——CI 门禁语义不变）。
- **保守边界**：仅注解口径（无注解绑定/闭包参数/函数参数/结构体字段不判——
  B-1 的 nova 现场 `self.tasks.iter_mut()` 就是字段接收者，本版不覆盖，诚实记录）；
  severity = warning（重赋值换类型等场景不误伤门禁）；用户 impl 方法与内建同名时
  派发先查 impl——预警文案已提示「若为自定义 impl 方法请忽略」。

## B-8（vendored 修复，v0.4.2）进程内执行车道的输出保真度低于子进程车道

- **现象**：`ORG_FORCE_INPROC=1`（或无 bun 环境）时，`lib/engine.ts` 的 stdout
  捕获逐行过滤空行再 `join("\n")`——引擎输出的空行全部丢失、结尾换行丢失；
  同一命令在两条执行车道下呈现不同结果（比对、快照测试、人眼对不齐）。
- **修复**（`lib/engine.ts` `runInproc`）：写入原文直接入队（`join("")` 字节级还原）；
  console 捕获补换行；错误尾行提取先展平再过滤（两车道同一行粒度）。实测
  `org run` 双车道输出 diff 仅剩 run_id/耗时类时变字段。
- **关联**：B-5 引入进程内车道时引入的回归——车道可以不同，输出必须同构。

## ORG CLI 层的实测修复（随 v0.4.2）

1. **`org score --axis` 匹配与空结果反馈**：cell 格式为 `能力轴|任务类`，此前只匹配
   能力轴前缀——README 示例 `--axis structured_output` 实为不存在的轴名，过滤后
   沉默输出空列表（无法区分「无数据」与「拼写错误」）。修复：两侧任一命中即保留；
   空结果列出当前卡上真实的能力轴与任务类。README 示例同步改为真实存在的
   `structured_extract`。
2. **`org check` 模块清单随本地状态漂移**：`demo-run-tests/`（bun test 的本地工作区，
   git 忽略）不在 walker 跳过集合——跑过测试后 check 模块数 32 → 48。修复：跳过
   集合补 `demo-run-tests` / `out-ask`（与 `demo-run` 同口径：本地运行时工作区不入
   稳定清单）。
3. **工作区模板目录可写（无只读守卫）**：实测实录——`dhv run probe9 --workspace demo-ws`
   把固化观测账本写进模板 `registry/memos/`，后续每次 `org demo` 复制被污染的模板，
   三连跑衰减曲线 5→1→0 静默漂移为 1→0→0（模板是演示可重复性的地基）。修复：
   `lib/engine.ts` 新增 `assertWorkspaceNotTemplate` 守卫（ensureWorkspace /
   resetWorkspace / org demo 重置前置检查，CLI 侧报错退出 2）；`hsl/probe/probe9.hsl`
   头注释补正确运行方式。守卫覆盖 org 命令面；直接调用 dhv 工具链时工作区语义
   归调用者（诚实边界）。

## B-9（已修复上游）dsh 演示工作区以「已修复」状态入库 —— README 快速开始是一场假演示

- **现象**：按 HSL 仓库 README 快速开始跑 dsh 剧本端到端，exit 0 + accepted，
  但 transcript 里 `edit_file FAILED old_text 未找到（0 处）`——修复从未发生。
  「Agent 修好了 bug」的演示叙事是假的：committed 的
  `toolchain/examples/dsh/workspace/stats.ts` 处于 post-fix 状态（variance 已用 n-1、
  median 已实现），fixture 的 `old_text` 期望 bug 版 → 锚点永不命中 → 模型照剧本
  跑完后续步骤（测试因「本来就修好了」而 PASS）→ 审查 accept → 假绿灯。
- **根因**（两层）：
  1. `toolchain/tests/hsl/run-all.ts` 的 dsh 端到端用例**直接对仓库内 workspace 执行**
     （scripted run 会真实改写 stats.ts）——测试跑完把污染状态留在工作树里，
     某次连同污染一起 commit 入库；
  2. 入库后无人校验「workspace 处于 pre-fix 状态」——fixture 与工作区的配对约束
     没有测试锁定。
- **修复**（上游 harness-specification-language）：
  1. 恢复 `examples/dsh/workspace/stats.ts` 为 bug 版（与 fixture `old_text` 逐字一致）；
  2. `run-all.ts` dsh 用例改为**临时目录副本隔离**（`fs.cpSync` → TMP）并新增两个
     行为断言：跑完后副本应含 `xs.length - 1` 分母与 `export function median`
     （「修复真实发生」从隐式期待变成显式验证）；
  3. CI（quarter-tests.yml）本就用 `/tmp/dsh-ws` 副本——正确的既有实践，无需改动。
- **教训**：**任何会写工作区的 scripted 测试都必须跑在副本上**；「端到端 ok」不等于
  「端到端做了正确的事」——用产物内容断言锁住行为，而不只是退出码。

## B-10（ORG 修复，v0.4.3）TUI 直连在 bun 子进程车道必然失败（env 泄漏）

- **现象**：TUI 里 `?notice-parser 问题?`（直连）以「引擎退出码 1」失败；同一命令
  `ORG_FORCE_INPROC=1`（进程内车道）正常。CLI `org ask` 不受影响。
- **根因**（`lib/engine.ts` `startRun`）：直连三件套 `ORG_ASK_EXPERT/SESSION/QUESTION`
  只进了 `envExtra`——它只被传给 `runInproc`；bun 子进程车道 `B.spawn([...], { env })`
  的 `env` 是 process.env 拷贝，**从未合并 envExtra**。冒烟测试只覆盖 inproc 车道
  （恰好正常的那条），漏网。
- **复现**：`startRun({ entry: "direct", expert: "notice-parser", ... })` 在有 bun 的
  机器上 `ok: false`；`ORG_FORCE_INPROC=1` 同参 `ok: true`。
- **修复**：spawn 前 `Object.assign(env, envExtra)`——直连环境变量同时进入两条车道。
- **教训**：**双车道抽象的每个车道都要有同参直测**（车道可以不同，行为必须同构——
  与 B-8 同族）。

## B-11（ORG 修复，v0.4.3）注册表 provenance「只写不读」—— 任何 load→flush 往返静默洗掉补丁历史

- **现象**：v0.4.3 引入 uses 磁盘态增量（`note_use`：load → +1 → flush）后，
  `record-validator` 的 `provenance` 落盘后变回 `[]`——补丁历史被洗掉。
- **根因**（`hsl/registry/manifest.hsl` `registry_entry_to_manifest`）：`to_json` 写出
  `provenance` 数组，但加载侧**从不解析该字段**（硬编码 `provenance: Vec::new()`）。
  原有代码恰好没有「load→flush」回路（merge_patch 用内存克隆直写），磁盘上的
  provenance 由 merge_patch 的单次写出维持——磁盘态增量一旦引入，每次往返都把
  历史抹平。
- **修复**：加载侧补齐 provenance 解析（`$host.json.fields` 通道逐行重建 `PatchRecord`）；
  json 序列化卫生同步加固（`json_escape`：引号/反斜杠/换行/制表符转义——真实模型
  产出的 description 含 `"` 时注册表 JSON 不再损坏）。
- **教训**：**序列化对称性是隐性契约**——写了却不读的字段是埋给未来调用者的雷；
  一旦引入「以磁盘为准」的写路径（增量/合并），所有 load→flush 往返都是雷的引信。
  测试锁定：`tests/keep.test.ts`「注册表序列化卫生」用例（含引号/反斜杠的
  description 经 keep 的 load→flip→flush 往返后保真）。

## B-12（ORG 修复，v0.4.3）uses 计数器从未递增 + 陈旧快照全量 flush 互相覆盖

- **现象**：`ExpertManifest::used()` 定义于 v0.1.0 但**零调用点**——复用两轮后注册表
  仍显示 `uses: 0`，`org status` 展示误导。
- **修复过程**（三步，每步都踩出下一个坑——记录完整链路）：
  1. 直接 `registry.register(m.used())` → **版本回退 bug**：merge_patch 经 clone 值语义
     写盘（1.0.1），主控节点内存态仍 1.0.0——重派时的 uses 写回把版本拖回 1.0.0；
  2. 改为磁盘态增量（`note_use`：从磁盘新鲜加载再 +1）→ **uses 回退 bug**：patched
     manifest 源自陈旧克隆，`register(patched)` 全量覆盖磁盘（把 note_use 刚写入的
     计数拖回旧值）；
  3. 终态：merge_patch / canary 回滚 / bridge 导入统一「磁盘新鲜态合入 + 保留磁盘
     最新 uses」（`set_uses`）；org 主控 mint 注册改 `upsert_memory`（只进内存不落盘
     ——磁盘已由 register_expert 写过）。
- **修复后实测**：三连跑 `notice-parser uses=3`、`record-validator@1.0.1 uses=5`
  （A×2 + B×2 + C×1，与派单记录逐一对应）。
- **教训**：**「load-all → mutate → write-all」的多写者模型里，任何持有旧快照的
  写者都是覆盖攻击者**。修法只有两条路：要么所有写者都从磁盘新鲜加载（本修复选择，
  代价是 I/O）；要么改写为按字段合并。值语义语言里前者更稳——后者要求语言层支持
  字段级寻址。
