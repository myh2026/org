# toolchain/ — 内嵌 HSL 工具链（dhv-ts）

本目录内嵌 [harness-specification-language](https://github.com/myh2026/harness-specification-language)
仓库的 **dhv-ts 参考解释器**（BNF v1.5.0 可执行子集），使 ORG 仓库**自包含**：
克隆即用，不再依赖兄弟目录克隆或外部安装。

## 版本锚定（vendored at）

- **上游提交**：`990dd83eda7003c438673135217afcdb07e7be54`（2026-09-06）
  —— 该提交包含 `Vec::iter_mut` 与 `String::push(char)` 两项内建方法修复
  （见根目录 [BUGFIXES.md](../BUGFIXES.md) B-1 / B-2，check 过 / run 崩的静默断层）。
- **上游版本号**：dhv-ts 0.2.56（`src/version.ts` 运行时读取）。
- **本地补丁基线**：vendored 0.2.58（ORG v0.4.2 起，见下方 PATCHES 清单——
  0.2.57 号段为上游已合入修复的历史标记，0.2.58 = 0.2.56 代码基线 + 本地补丁面；
  `package.json` 版本号随本地补丁推进，不再是上游原始文件）。
- **许可证**：MIT（见 [dhv-ts/LICENSE](dhv-ts/LICENSE)）。

## 修改纪律（vendoring 规则）

1. **零补丁原则**（2026-09-08 起修订为「登记补丁原则」）：上游 990dd83 之后，
   ORG 实测回推的必要修复以本地补丁形式存在，全部在下方 PATCHES 清单登记
   （现象 / 根因 / 修法 / 复现探针）。任何未来新增补丁同样要：
   - 在本文件 PATCHES 清单登记；
   - 优先回推上游，上游合入后重新同步并解除本地补丁；
   - 补一个 `hsl/probe/` 探针或 `tests/` 用例锁定行为。
2. **同步方式**：`bun scripts/sync-toolchain.ts`（从上游仓库拉取指定 ref 覆盖
   `dhv-ts/src`，diff 审查后提交）。禁止手工零散改动。
3. **外部工具链优先**：设 `DHV_TS=/path/to/dhv-ts/src/main.ts` 可用自有工具链
   覆盖内嵌版本（解析顺序见 `cli/org.ts resolveDhv()`）——内嵌版保底，外部版优先，
   便于上游联调。

## PATCHES（本地补丁清单，待回推上游）

| # | 版本 | 文件 | 现象 | 根因 | 修法 | 复现 |
|---|:---|:---|:---|:---|:---|:---|
| P-1 | v0.4.0 | `src/version.ts` | 打包进宿主二进制后 import 即崩（ENOENT） | `import.meta.dir` 指向打包器虚拟 FS | readVersion try/catch + `DHV_VERSION` env 回退 | BUGFIXES B-4 |
| P-2 | v0.4.0 | `src/main.ts` | 宿主进程内无法复用 CLI（顶层 argv/exit） | 顶层执行式入口 | 重构为 `cliMain(argv)` 可编程导出 + `import.meta.main` 守卫 | BUGFIXES B-5 |
| P-3 | 0.2.58 | `src/builtins.ts` | 26 个 Rust 对等高频方法缺失（check 全过 / run 全崩） | checker 不校验方法名，`builtinMethodFor` 找不到即崩 | 按补齐表逐一注册（Vec×15 / String×7 / HashMap×1 / Result×2 / Option×1） | `hsl/probe/probe10.hsl` |
| P-4 | 0.2.58 | `src/checker.ts` | 方法名断层在 check 期不可见（B-1/B-6 共同根因） | `case 'method'` 不查方法面 | 新增 S-19 warning：注解类型绑定 × 运行期方法面交叉校验 | `hsl/probe/probe10-negative.hsl` |

> 上游回推提示：P-3 / P-4 对应上游 issue 的建议修法与 ORG 侧实现一致
> （`hsl/probe/probe10.hsl` 探针可原样回放）；合入后以 sync-toolchain 重新锚定。

## 目录

```
toolchain/
├── README.md          # 本文件（版本锚定 + 修改纪律 + PATCHES 清单）
└── dhv-ts/
    ├── src/           # 解释器源码（main/lexer/parser/ast/checker/interp/host/builtins/...）
    ├── package.json   # 版本号随本地补丁推进（0.2.58）；无第三方依赖，Bun 直接运行
    └── LICENSE        # MIT（上游）
```
