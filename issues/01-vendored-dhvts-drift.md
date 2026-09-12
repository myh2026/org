# Issue 文案：vendored dhv-ts 落后上游一个修复批次（双仓漂移）

> 粘贴到 GitHub → New issue。已随 commit `7c8feaf`（分支 `fix/practical-bugs-2026-09-12`）修复，合并后可关闭。

---

**标题**：vendored dhv-ts（resolveDhv 首选）落后上游 HSL 一个修复批次，上游正确性修复对 org 不生效

**标签**：bug / drift / toolchain

**正文**：

## 现象

org 内嵌 `toolchain/dhv-ts`（v0.2.61）是 `cli/org.ts resolveDhv()` 的**首选**工具链（`$DHV_TS` → 内嵌 vendored → 兄弟目录克隆），本地开发与 CI 实际运行的都是这份 vendored 副本。上游 HSL 已发布 v0.2.62（六处正确性修复），但 vendored 副本未同步——**上游修复批次对 org 完全不生效**。

##影响（v0.2.61 缺失的六处修复）

1. **G-8 expr 守卫指纹误杀**（checker.ts）：指纹用 `span[0]/span[1]` 索引 `{line,col,file}` 对象，恒 `undefined` → 同端点两条**不同的**合法守卫（`x > 1` / `x < 0`）被 G-8 当作复制粘贴误杀；
2. **`v[i..j]` 切片死代码**（parser.ts）：下标语境 `parseExpr()` 抢先吸收 range → 解析为 `v[range(1,3)]` → interp 将 range `Number()` 成 NaN → NaN 绕过越界检查静默返回 `undefined`；
3. **`x %= 0` 静默 NaN**（interp.ts）：`evalCompound` 的 `%` 缺除零检查与 bigint 分支，垃圾值污染数据流；
4. **fn body 内 block 资源块非法**（parser.ts）：`ITEM_KWS` 缺 `'block'`，顶层合法、函数体内非法的不对称；
5. **`\x` 转义 NUL 静默入值**（lexer.ts）：`parseInt('Zi',16)=NaN` → `fromCharCode(NaN)` = NUL 字符入值，字符串"看着是空的"却 len=1；
6. dhv（Rust）侧 PEG edge guard expr 形态解析修复（双端一致性）。

## 复现

在 org 任意 expert/edge 上使用两条同端点不同条件的 expr 守卫（Vigil 惯用法），G-8 误报「守卫重复」。

## 根因

双仓 vendored 无新鲜度机制：上游快进后没有任何断言拦截「vendored 落后」。

## 修复（commit 7c8feaf）

- 从上游同步 `checker.ts / parser.ts / interp.ts / lexer.ts / README.md`，`package.json` 0.2.61 → 0.2.62；
- **保留 org 独有 patch**：`host.ts` 零外联开关（`DHV_LLM_DISABLE_SDK`，上游无此改动）；
- 新增漂移守卫 `scripts/check-vendored-fresh.ts`：断言 vendored 版本 ≥ 上游 HSL main（git sparse 浅克隆取版本，不走 REST API、无限流依赖；失败 exit 1，`VENDORED_FRESH_ALLOW=1` 降级警告）；
- `ci.yml` verify job 新增「vendored 工具链新鲜度」步骤。

## 验证

- check 35/35 · test 224/224 · TUI 冒烟 0 失败 · demo 全叙事通过；
- 守卫双路径实测：vendored 0.2.60 < 上游 0.2.61 → exit 1；0.2.62 ≥ 0.2.61 → exit 0；
- payload / dist/demo 再生（指纹 b2ed881d99d3）。
