#!/usr/bin/env bun
// ============================================================================
// org/scripts/build-bin.ts — 三平台单二进制构建（Windows / macOS / Linux）
// ----------------------------------------------------------------------------
// 原理：org 的引擎运行时资源（hsl 源码 / vendored dhv-ts / 工作区模板 /
// fixture 剧本）全部是文本文件 → 构建期打包为 build/payload.json（单文件、
// 无 tar 依赖、Windows 安全），cli/org.ts 经静态 import 嵌入二进制；
// 运行期（lib/root.ts）按内容指纹解包到 ~/.org/runtime-<hash> 并以此为 ROOT。
// 源码模式（bun cli/org.ts）不受影响：ROOT 仍是仓库，payload 仅编译态使用。
//
// 用法：
//   bun scripts/build-bin.ts                # 生成 payload + 当前平台二进制
//   bun scripts/build-bin.ts --all          # 生成 payload + 5 目标交叉编译
//   bun scripts/build-bin.ts --payload-only # 只再生 payload（CI 新鲜度校验用）
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BUILD_DIR = path.join(ROOT, "build");
const PAYLOAD = path.join(BUILD_DIR, "payload.json");

const PAYLOAD_ROOTS = [
  "hsl",
  "toolchain/dhv-ts/src",
  "toolchain/dhv-ts/package.json",
  "demo-ws",
  "fixtures",
];

interface PayloadFile { rel: string; content: string }

function collectFiles(): PayloadFile[] {
  const out: PayloadFile[] = [];
  const skipDirs = new Set(["__pycache__", "node_modules", ".git"]);
  for (const base of PAYLOAD_ROOTS) {
    const absBase = path.join(ROOT, base);
    if (!fs.existsSync(absBase)) {
      console.error(`✗ payload 源缺失：${base}（应在仓库内）`);
      process.exit(1);
    }
    if (fs.statSync(absBase).isFile()) {
      // 单文件条目（如 toolchain/dhv-ts/package.json）
      out.push({ rel: base.replace(/\\/g, "/"), content: fs.readFileSync(absBase, "utf-8") });
      continue;
    }
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDirs.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          const rel = path.relative(ROOT, p).replace(/\\/g, "/");
          out.push({ rel, content: fs.readFileSync(p, "utf-8") });
        }
      }
    };
    walk(absBase);
  }
  // 字典序规范化：readdirSync 顺序跨文件系统不稳定（ext4 hash 序 vs runner 序），
  // 不排序则 JSON 键序随环境漂移 —— CI 与本地的 payload 永远对不上。
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function writePayload(): { bytes: number; files: number } {
  const files = collectFiles();
  const map: Record<string, string> = {};
  for (const f of files) map[f.rel] = f.content;
  const doc = {
    generator: "org build-bin",
    format: 1,
    files: map,
  };
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(PAYLOAD, JSON.stringify(doc));
  const bytes = fs.statSync(PAYLOAD).size;
  console.log(`✓ payload 再生：${files.length} 文件 · ${(bytes / 1024).toFixed(0)} KB → build/payload.json`);
  return { bytes, files: files.length };
}

// 与 lib/root.ts 的指纹算法保持一致（内容 sha1 前 12 位）
async function payloadHash(): Promise<string> {
  const raw = fs.readFileSync(PAYLOAD, "utf-8");
  const h = new Bun.CryptoHasher("sha1");
  h.update(raw);
  return h.digest("hex").slice(0, 12);
}

const TARGETS: Array<{ flag: string; name: string }> = [
  { flag: "bun-linux-x64", name: "org-linux-x64" },
  { flag: "bun-linux-arm64", name: "org-linux-arm64" },
  { flag: "bun-darwin-x64", name: "org-darwin-x64" },
  { flag: "bun-darwin-arm64", name: "org-darwin-arm64" },
  { flag: "bun-windows-x64", name: "org-windows-x64.exe" },
];

async function compile(target: { flag: string; name: string } | null): Promise<void> {
  const list = target ? [target] : [{ flag: "", name: process.platform === "win32" ? "org.exe" : "org" }];
  for (const t of list) {
    const outfile = path.join(BUILD_DIR, t.name);
    const args = ["build", "--compile"];
    if (t.flag) args.push(`--target=${t.flag}`);
    // z-ai-web-dev-sdk：deepseek 真实模式的动态依赖（scripted 默认模式不需要）。
    // 标记 external：打包时不解析；二进制环境跑 --model deepseek 时给出明确错误。
    args.push("--external", "z-ai-web-dev-sdk");
    args.push("--outfile", outfile, "cli/org.ts");
    console.log(`… 编译 ${t.flag || "host"} → dist-bin 同名产物（build/${t.name}）`);
    const proc = Bun.spawnSync([process.execPath, ...args], {
      cwd: ROOT, stdout: "pipe", stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    if (proc.exitCode !== 0) {
      console.error(out);
      process.exit(1);
    }
    const lines = out.split("\n").filter((l) => l.includes("bundle") || l.includes("compile"));
    for (const l of lines) console.log("   " + l.trim());
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  writePayload();
  if (argv.includes("--payload-only")) {
    console.log(`✓ 指纹 ${await payloadHash()}（lib/root.ts 运行时同算）`);
    return 0;
  }
  fs.mkdirSync(path.join(ROOT, "dist-bin"), { recursive: true });
  if (argv.includes("--all")) {
    for (const t of TARGETS) await compile(t);
    console.log("\n✓ 5 平台二进制完成 → build/（release 工作流将其改名发布）");
  } else {
    await compile(null);
    console.log("\n✓ 当前平台二进制完成（--all 可交叉编译 5 平台）");
  }
  return 0;
}

process.exit(await main());
