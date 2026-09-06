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
