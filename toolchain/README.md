# toolchain/ — 内嵌 HSL 工具链（dhv-ts）

本目录内嵌 [harness-specification-language](https://github.com/myh2026/harness-specification-language)
仓库的 **dhv-ts 参考解释器**（BNF v1.5.0 可执行子集），使 ORG 仓库**自包含**：
克隆即用，不再依赖兄弟目录克隆或外部安装。

## 版本锚定（vendored at）

- **上游提交**：`990dd83eda7003c438673135217afcdb07e7be54`（2026-09-06）
  —— 该提交包含 `Vec::iter_mut` 与 `String::push(char)` 两项内建方法修复
  （见根目录 [BUGFIXES.md](../BUGFIXES.md) B-1 / B-2，check 过 / run 崩的静默断层）。
- **上游版本号**：dhv-ts 0.2.56（`src/version.ts` 运行时读取；package.json 为上游原始文件）。
- **许可证**：MIT（见 [dhv-ts/LICENSE](dhv-ts/LICENSE)）。

## 修改纪律（vendoring 规则）

1. **零补丁原则**：本仓库当前对 `dhv-ts/src` **未做任何修改**（提交 990dd83 已含
   ORG 实测所需全部修复）。任何未来必须的修改都要：
   - 在本文件登记（PATCHES 清单：现象 / 根因 / 修法 / 上游 issue 链接）；
   - 优先回推上游，上游合入后重新同步并解除本地补丁；
   - 补一个 `hsl/probe/` 探针或 `tests/` 用例锁定行为。
2. **同步方式**：`bun scripts/sync-toolchain.ts`（从上游仓库拉取指定 ref 覆盖
   `dhv-ts/src`，diff 审查后提交）。禁止手工零散改动。
3. **外部工具链优先**：设 `DHV_TS=/path/to/dhv-ts/src/main.ts` 可用自有工具链
   覆盖内嵌版本（解析顺序见 `cli/org.ts resolveDhv()`）——内嵌版保底，外部版优先，
   便于上游联调。

## 目录

```
toolchain/
├── README.md          # 本文件（版本锚定 + 修改纪律）
└── dhv-ts/
    ├── src/           # 解释器源码（main/lexer/parser/ast/checker/interp/host/builtins/...）
    ├── package.json   # 上游原始文件（无第三方依赖，Bun 直接运行）
    └── LICENSE        # MIT（上游）
```
