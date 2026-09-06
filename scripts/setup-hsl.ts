#!/usr/bin/env bun
// ============================================================================
// org/scripts/setup-hsl.ts — HSL 工具链（dhv-ts）自动安装
// ----------------------------------------------------------------------------
// 幂等：已存在则直接退出。克隆目标为 org 仓库的兄弟目录，命中
// cli/org.ts resolveDhv() 的候选路径（../harness-specification-language）。
// CI（.github/workflows/*.yml）与本地开发共用此脚本。
//
// 用法：
//   bun scripts/setup-hsl.ts [--ref <git-ref>]   # 默认克隆默认分支
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const HSL_REPO = "https://github.com/myh2026/harness-specification-language.git";

const args = process.argv.slice(2);
const refIdx = args.indexOf("--ref");
const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;

// 解析顺序与 cli/org.ts 一致：$DHV_TS → ../hsl → ../harness-specification-language
const candidates = [
  process.env.DHV_TS,
  path.resolve(ROOT, "../hsl/toolchain/dhv-ts/src/main.ts"),
  path.resolve(ROOT, "../harness-specification-language/toolchain/dhv-ts/src/main.ts"),
  path.resolve(ROOT, "harness-specification-language/toolchain/dhv-ts/src/main.ts"),
].filter((c): c is string => Boolean(c));

const existing = candidates.find((c) => fs.existsSync(c));
if (existing) {
  console.log(`✓ HSL 工具链已就位：${path.relative(process.cwd(), existing)}`);
  process.exit(0);
}

const target = path.resolve(ROOT, "../harness-specification-language");
console.log(`ℹ 克隆 ${HSL_REPO} → ${target}${ref ? `（ref: ${ref}）` : ""}`);
const clone = Bun.spawnSync(
  ref
    ? ["git", "clone", "--depth", "1", "--branch", ref, HSL_REPO, target]
    : ["git", "clone", "--depth", "1", HSL_REPO, target],
  { stdout: "inherit", stderr: "inherit" },
);
if (clone.exitCode !== 0) {
  console.error("✗ 克隆失败（网络 / 权限）。也可手动：");
  console.error(`  git clone ${HSL_REPO} ${target}`);
  process.exit(1);
}

const dhv = path.join(target, "toolchain/dhv-ts/src/main.ts");
if (!fs.existsSync(dhv)) {
  console.error(`✗ 克隆完成但未找到 dhv 入口：${dhv}`);
  process.exit(1);
}

// dhv-ts 零 npm 依赖（纯 bun 运行）；若未来引入依赖，在此补 bun install。
const pkg = path.join(target, "toolchain/dhv-ts/package.json");
if (fs.existsSync(pkg)) {
  const manifest = JSON.parse(fs.readFileSync(pkg, "utf-8")) as { dependencies?: Record<string, string> };
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    console.log("ℹ dhv-ts 声明了依赖，执行 bun install …");
    Bun.spawnSync(["bun", "install"], {
      cwd: path.dirname(pkg), stdout: "inherit", stderr: "inherit",
    });
  }
}

console.log(`✓ 工具链就绪：${path.relative(process.cwd(), dhv)}`);
console.log("  验证：bun cli/org.ts check");
