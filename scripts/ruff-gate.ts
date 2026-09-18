// ============================================================================
// scripts/ruff-gate.ts — HSL python 产物 ruff 门禁（v0.5.4）
// ----------------------------------------------------------------------------
// 「所有产物 ruff 检测均可通过」的可执行门禁：
//   1. 用 vendored dhv-ts 把语料 emit 成 Python 工程（org.hsl 的 python
//      投射 + vendored examples 的 python 目标）；
//   2. 逐目录跑 ruff check（ruff 0.16 默认全规则集）；
//   3. 任何失败 → exit 1 + 逐条列出（生成器回归当场可见）。
//
// ruff 定位：PATH > ~/.local/bin（uv tool install ruff 的默认落点）。
// 无 ruff 环境直接报错退出（门禁不静默跳过 —— 诚实失败优于假绿）。
//
// 用法：bun scripts/ruff-gate.ts [--keep]（--keep 保留产物目录便于排查）
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const DHV = path.join(ROOT, "toolchain/dhv-ts/src/main.ts");

/** 语料：org 内核 python 投射 + vendored examples（模式/标准库/翻译全覆盖）。 */
const CORPUS: Array<{ hsl: string; note: string }> = [
  { hsl: "hsl/org.hsl", note: "ORG 内核（graph 投射 · python 车道 v0.5.4）" },
  { hsl: "fixtures/ruff-corpus/kernel-tour.hsl", note: "ORG 自有全特性语料（复合赋值/闭包/递归/Result 模式/实参括号）" },
  { hsl: "toolchain/dhv-ts/examples/pattern-tour.hsl", note: "模式全家族（match/if-let/while-let · Ok/Err/Some 桩）" },
  { hsl: "fixtures/turing/rule110.hsl", note: "图灵完备实证 I：Rule 110 元胞自动机（Cook 2004 TC 证明）" },
  { hsl: "fixtures/turing/busy-beaver.hsl", note: "图灵完备实证 II：图灵机执行器（BB(3)：13 转移/14 构型/6 个 1）" },
  { hsl: "fixtures/turing/bf.hsl", note: "图灵完备实证 III：Brainfuck 解释器（906 指令 Hello World）" },
];

function findRuff(): string {
  // v0.5.15：win32 后缀兼容 —— fs.existsSync 不自动解析 .exe，
  // 裸检 "ruff" 在 Windows 永远落空（即便 pip 已装）。
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const c of process.env.PATH?.split(path.delimiter) ?? []) {
    const p = path.join(c, "ruff" + exe);
    if (fs.existsSync(p)) return p;
    if (!exe && fs.existsSync(path.join(c, "ruff"))) return path.join(c, "ruff");
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "ruff" + exe);
  if (fs.existsSync(fallback)) return fallback;
  console.error("✗ 找不到 ruff。安装：uv tool install ruff（或 pip install ruff）");
  process.exit(2);
}

const keep = process.argv.includes("--keep");
const ruff = findRuff();
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "org-ruff-gate-"));
let failed = 0;

console.log(`ruff gate —— ${CORPUS.length} 份语料 emit → python → ruff check\n`);
console.log(`  ruff: ${ruff}\n`);

for (const c of CORPUS) {
  const src = path.join(ROOT, c.hsl);
  if (!fs.existsSync(src)) {
    console.log(`  ⏭ ${c.hsl}（语料缺失，跳过）`);
    continue;
  }
  const dir = path.join(outRoot, path.basename(c.hsl, ".hsl"));
  fs.rmSync(dir, { recursive: true, force: true });
  // emit（生成器自身先过语法校验）
  const emit = Bun.spawnSync([process.execPath, DHV, "emit", src, "--out", dir], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
  });
  if (emit.exitCode !== 0) {
    console.log(`  ✗ ${c.hsl} emit 失败：\n${emit.stderr.toString().slice(0, 500)}`);
    failed++;
    continue;
  }
  // 收集 python 文件
  const pyFiles: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".py")) pyFiles.push(p);
    }
  };
  walk(dir);
  if (pyFiles.length === 0) {
    console.log(`  ⏭ ${c.hsl}（无 python 目标，跳过）`);
    continue;
  }
  // ruff check（ruff 0.16 默认全规则集：E4/E7/E9/F/I001/PLR0124…）
  const res = Bun.spawnSync([ruff, "check", "--output-format", "concise", dir], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
  });
  const outText = (res.stdout.toString() + res.stderr.toString()).trim();
  if (res.exitCode === 0) {
    console.log(`  ✓ ${c.hsl.padEnd(46)} ${pyFiles.length} 个 .py · ${c.note}`);
  } else {
    console.log(`  ✗ ${c.hsl}（${pyFiles.length} 个 .py）—— ruff 失败：\n${outText.split("\n").map((l) => "      " + l).join("\n")}`);
    failed++;
  }
}

if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
else console.log(`\n  产物保留：${outRoot}`);

if (failed > 0) {
  console.error(`\n✗ ruff gate 失败（${failed} 份语料）—— python 生成器回归，见上`);
  process.exit(1);
}
console.log(`\n✓ ruff gate 全绿（${CORPUS.length} 份语料 · ruff 0.16 默认全规则）`);
