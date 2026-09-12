# Issue 文案：setup-hsl.ts 候选缺内嵌 vendored 路径

> 粘贴到 GitHub → New issue。已随 commit `7c8feaf` 修复，合并后可关闭。

---

**标题**：scripts/setup-hsl.ts 候选列表缺内嵌 vendored 路径——CI runner 每次白克隆上游，与 resolveDhv() 语义不一致

**标签**：bug / ci

**正文**：

## 现象

`scripts/setup-hsl.ts` 的注释与 `ci.yml` 的步骤名都宣称「vendored 优先，通常直接命中退出」，但其候选列表是：

```
$DHV_TS → ../hsl/toolchain/dhv-ts → ../harness-specification-language/toolchain/dhv-ts → ./harness-specification-language/toolchain/dhv-ts
```

**不含 org 仓内 `toolchain/dhv-ts`**。而 `cli/org.ts resolveDhv()` 的解析顺序是 `$DHV_TS → 内嵌 vendored → 兄弟目录`。

后果：GitHub runner（无兄弟克隆）上 `setup-hsl.ts` 永远不命中，每次 CI 都真实克隆一次上游 HSL（网络抖动即 CI 红），随后 `resolveDhv()` 仍优先用仓内 vendored——克隆产物只被用于制造「vendored 与克隆版并存」的歧义，从未被使用。

## 根因

`setup-hsl.ts` 与 `resolveDhv()` 的候选列表各自维护、不同步。

## 修复（commit 7c8feaf）

候选列表头部补 `path.resolve(ROOT, "toolchain/dhv-ts/src/main.ts")`，与 `resolveDhv()` 完全对齐；runner 上直接命中 vendored 退出，不再无谓克隆。

## 建议

后续如两处候选列表再演化，考虑抽成单一 `lib/toolchain-paths.ts` 供双端引用，消除重复维护点。
