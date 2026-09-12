#!/usr/bin/env bun
// ============================================================================
// org/scripts/check-vendored-fresh.ts — vendored dhv-ts 上游新鲜度守卫（漂移治理）
// ----------------------------------------------------------------------------
// 背景：org 内嵌 toolchain/dhv-ts（vendored，resolveDhv() 首选）曾落后上游
// HSL 一个修复批次（v0.2.61 vs v0.2.62，六处正确性修复对 org 不生效）——
// 双仓 vendored 漂移无任何机制拦截。本守卫把「vendored 版本 ≥ 上游默认分支
// 版本」变成 CI 可执行断言：
//
//   vendored < 上游  → exit 1（提示同步；VENDORED_FRESH_ALLOW=1 降级为警告）
//   vendored ≥ 上游  → exit 0
//
// 上游版本获取：git 浅克隆（--depth 1 --filter=blob:none + sparse-checkout），
// 不走 REST API —— 无匿名限流问题，CI runner 与本地行为一致。
//
// 用法：
//   bun scripts/check-vendored-fresh.ts                 # 常规守卫（失败 exit 1）
//   VENDORED_FRESH_ALLOW=1 bun scripts/check-vendored-fresh.ts   # 仅警告
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const HSL_REPO = "https://github.com/myh2026/harness-specification-language.git";
const VENDORED_PKG = path.join(ROOT, "toolchain/dhv-ts/package.json");

interface Manifest {
  version?: string;
  name?: string;
}

function readVersion(pkgPath: string, label: string): string {
  if (!fs.existsSync(pkgPath)) {
    console.error(`✗ ${label} 不存在：${pkgPath}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Manifest;
  const version = manifest.version ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`✗ ${label} 版本号非法："${version}"（期望 semver）`);
    process.exit(2);
  }
  return version;
}

function versionTuple(v: string): [number, number, number] {
  return v.split(".").map((n) => Number(n)) as [number, number, number];
}

function versionLt(a: string, b: string): boolean {
  const [a1, a2, a3] = versionTuple(a);
  const [b1, b2, b3] = versionTuple(b);
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 < b3;
}

// ---------- 上游浅克隆（sparse，只取 dhv-ts/package.json） ----------

const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "hsl-fresh-"));
const target = path.join(tmp, "hsl");

function git(args: string[], opts?: { cwd?: string; quiet?: boolean }): number {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: opts?.cwd,
    stdout: opts?.quiet ? "pipe" : "inherit",
    stderr: opts?.quiet ? "pipe" : "inherit",
  });
  return proc.exitCode;
}

console.log(`ℹ 浅克隆上游（sparse：toolchain/dhv-ts/package.json）…`);
const cloned =
  git(["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", HSL_REPO, target], { quiet: true }) === 0 &&
  git(["sparse-checkout", "init", "--cone"], { cwd: target, quiet: true }) === 0 &&
  git(["sparse-checkout", "set", "toolchain/dhv-ts/package.json"], { cwd: target, quiet: true }) === 0 &&
  git(["checkout"], { cwd: target, quiet: true }) === 0;

if (!cloned) {
  console.error("✗ 上游克隆失败（网络 / 权限）——守卫无法判定，按失败处理");
  console.error("  （离线环境可暂以 VENDORED_FRESH_ALLOW=1 降级为警告）");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.env.VENDORED_FRESH_ALLOW === "1" ? 0 : 1);
}

// ---------- 比对 ----------

const vendoredVer = readVersion(VENDORED_PKG, "vendored dhv-ts");
const upstreamPkg = path.join(target, "toolchain/dhv-ts/package.json");
const upstreamVer = readVersion(upstreamPkg, "上游 dhv-ts");

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`  vendored : ${vendoredVer}  (org/toolchain/dhv-ts)`);
console.log(`  上游 main : ${upstreamVer}  (${HSL_REPO})`);

if (versionLt(vendoredVer, upstreamVer)) {
  const msg = `vendored dhv-ts 落后上游：${vendoredVer} < ${upstreamVer} —— 双仓漂移，工具链修复对 org 不生效`;
  if (process.env.VENDORED_FRESH_ALLOW === "1") {
    console.warn(`⚠ ${msg}（VENDORED_FRESH_ALLOW=1，降级为警告）`);
    process.exit(0);
  }
  console.error(`✗ ${msg}`);
  console.error("  修复：从上游同步 toolchain/dhv-ts（保留 org 独有 patch，如 host.ts 零外联开关），");
  console.error("        再生 build/payload.json（bun scripts/build-bin.ts --payload-only）并重新导出 demo。");
  process.exit(1);
}

console.log(`✓ vendored 新鲜度 OK（${vendoredVer} ≥ ${upstreamVer}）`);
