// ============================================================================
// tests/turing.test.ts — HSL 图灵完备实证（Rule 110 / 忙海狸 / Brainfuck）
// ----------------------------------------------------------------------------
// 毕业论文级证据链：每个程序走四条验证路径 ——
//   1. dhv check（S/G/P 静态铁律）
//   2. dhv run（vendored 解释器真实执行 → 黄金输出）
//   3. dhv emit → python3 真实运行（输出与解释器逐行一致）+ ruff 全绿
//   4. dhv emit → rustc / g++（C++20）真实编译运行（输出一致）
//
// 图灵完备论证：
//   - Rule 110 元胞自动机已被证明图灵完备（Cook 2004）；
//   - 图灵机是 TC 的定义性模型（BB(3) 不变量 Σ=6 是文献级已知解）；
//   - Brainfuck 是极简 TC 语言 —— 「用 HSL 解释 TC 语言」是最强证据。
// 三者全部只用 HSL 原语（无 native 块）实现。
//
// 附带生成器修复的回归价值（本批落地的六修）：
//   PIE808（range(0,N)→range(N)）· SIM114（同体 match 臂合并）·
//   F541（无占位符 f-string）· UP034（f-string 参数外括号）·
//   rust as 转换保真 · rust char_at 映射。
//
// 端到端用例逐例 120s 超时（B-15 纪律）。
// ============================================================================

import { describe, test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDhv } from "./helpers";
import { execFileSync } from "node:child_process";

const TURING = path.join(process.cwd(), "fixtures/turing");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "org-turing-"));

/** 编译工具的 PATH（rustup 落在 ~/.cargo/bin）。 */
function toolPath(tool: string): string {
  for (const c of [...(process.env.PATH?.split(path.delimiter) ?? []),
    path.join(os.homedir(), ".cargo", "bin"),
    path.join(os.homedir(), ".local", "bin")]) {
    const p = path.join(c, tool);
    if (fs.existsSync(p)) return p;
  }
  return tool;
}

function emit(hsl: string, out: string): boolean {
  const r = runDhv(["emit", hsl, "--out", out]);
  if (!r.ok) console.error(r.stdout + r.stderr);
  return r.ok;
}

/** 从 dhv run 的 stdout 提取程序自己的 println 输出行（含黄金锚点）。 */
function runHslLines(hsl: string, tag: string): string[] {
  const ws = path.join(SCRATCH, `ws-${tag}`);
  fs.mkdirSync(ws, { recursive: true });
  const out = path.join(SCRATCH, `out-${tag}`);
  const r = runDhv([
    "run", hsl,
    "--workspace", ws,
    "--task", "turing",
    "--model", "scripted",
    "--fixture", path.join(process.cwd(), "fixtures/run-notices.json"),
    "--out", out,
    "--allow", "bun",
  ]);
  expect(r.ok).toBe(true);
  // 程序 println 直接进 stdout；取非空行
  return r.stdout.split("\n").filter((l) => l.trim().length > 0);
}

beforeAll(() => {
  expect(fs.existsSync(path.join(TURING, "rule110.hsl"))).toBe(true);
});

describe("图灵完备 I：Rule 110 元胞自动机（Cook 2004 TC 证明）", () => {
  test("check + 解释器黄金输出（单点种子 → 30 代周期边界演化）", () => {
    const c = runDhv(["check", "fixtures/turing/rule110.hsl"]);
    expect(c.ok).toBe(true);
    const lines = runHslLines("fixtures/turing/rule110.hsl", "r110").filter((l) => /^[.#]+$/.test(l));
    // 31 行（种子 + 30 代），每行 79 列
    expect(lines.length).toBe(31);
    expect(lines[0]!.length).toBe(79);
    // 种子：第 39 列单点
    expect(lines[0]!.split("").filter((c2) => c2 === "#").length).toBe(1);
    expect(lines[0]!.indexOf("#")).toBe(39);
    // 第一代：38、39 两列（邻域 001→1 / 010→1 / 100→0）
    expect(lines[1]!.indexOf("#")).toBe(38);
    expect(lines[1]!.split("").filter((c2) => c2 === "#").length).toBe(2);
    // 黄金锚点：第 5 代（邻域规则复合演化的稳定对拍位）
    expect(lines[5]).toBe("..................................##...#.......................................");
  }, 120_000);

  test("python 投射：真实运行输出一致 + ruff 全绿", () => {
    const dir = path.join(SCRATCH, "r110-py");
    expect(emit("fixtures/turing/rule110.hsl", dir)).toBe(true);
    const py = execFileSync("python3", [path.join(dir, "main.py")], { encoding: "utf-8" });
    const interp = runHslLines("fixtures/turing/rule110.hsl", "r110b").filter((l) => /^[.#]+$/.test(l));
    const pyLines = py.split("\n").filter((l) => l.trim().length > 0);
    expect(pyLines).toEqual(interp);
    execFileSync(toolPath("ruff"), ["check", dir], { stdio: "pipe" });
  }, 120_000);

  test("rust 投射：rustc 真实编译运行输出一致", () => {
    const dir = path.join(SCRATCH, "r110-rs");
    expect(emit("fixtures/turing/rule110.hsl", dir)).toBe(true);
    const bin = path.join(dir, "rule110-bin");
    execFileSync(toolPath("rustc"), [path.join(dir, "rule110.rs"), "-o", bin], { stdio: "pipe" });
    const rsOut = execFileSync(bin, { encoding: "utf-8" });
    const interp = runHslLines("fixtures/turing/rule110.hsl", "r110c").filter((l) => /^[.#]+$/.test(l));
    const rsLines = rsOut.split("\n").filter((l) => l.trim().length > 0);
    expect(rsLines).toEqual(interp);
  }, 120_000);

  test("cpp 投射：g++ -std=c++20 真实编译运行输出一致", () => {
    const dir = path.join(SCRATCH, "r110-cpp");
    expect(emit("fixtures/turing/rule110.hsl", dir)).toBe(true);
    const bin = path.join(dir, "rule110-cpp-bin");
    execFileSync("g++", ["-std=c++20", path.join(dir, "rule110.cpp"), "-o", bin], { stdio: "pipe" });
    const cppOut = execFileSync(bin, { encoding: "utf-8" });
    const interp = runHslLines("fixtures/turing/rule110.hsl", "r110d").filter((l) => /^[.#]+$/.test(l));
    const cppLines = cppOut.split("\n").filter((l) => l.trim().length > 0);
    expect(cppLines).toEqual(interp);
  }, 120_000);
});

describe("图灵完备 II：图灵机（3 态忙海狸 BB(3)）", () => {
  test("check + 解释器黄金输出（13 转移 / 14 构型 / Σ=6）", () => {
    const c = runDhv(["check", "fixtures/turing/busy-beaver.hsl"]);
    expect(c.ok).toBe(true);
    const lines = runHslLines("fixtures/turing/busy-beaver.hsl", "bb");
    const joined = lines.join("\n");
    // Σ(3)=6：文献级不变量（Rado 1962）
    expect(joined).toContain("steps=13 configs=14 ones=6");
    expect(joined).toContain("BB(3) VERIFIED");
  }, 120_000);

  test("python 投射：真实运行输出一致 + ruff 全绿", () => {
    const dir = path.join(SCRATCH, "bb-py");
    expect(emit("fixtures/turing/busy-beaver.hsl", dir)).toBe(true);
    const py = execFileSync("python3", [path.join(dir, "busy_beaver.py")], { encoding: "utf-8" });
    expect(py).toContain("steps=13 configs=14 ones=6");
    expect(py).toContain("BB(3) VERIFIED");
    execFileSync(toolPath("ruff"), ["check", dir], { stdio: "pipe" });
  }, 120_000);

  test("rust 投射：rustc 真实编译运行输出一致（as 转换保真回归）", () => {
    const dir = path.join(SCRATCH, "bb-rs");
    expect(emit("fixtures/turing/busy-beaver.hsl", dir)).toBe(true);
    const bin = path.join(dir, "bb-bin");
    execFileSync(toolPath("rustc"), [path.join(dir, "busy_beaver.rs"), "-o", bin], { stdio: "pipe" });
    const rsOut = execFileSync(bin, { encoding: "utf-8" });
    expect(rsOut).toContain("steps=13 configs=14 ones=6");
    expect(rsOut).toContain("BB(3) VERIFIED");
  }, 120_000);
});

describe("图灵完备 III：Brainfuck 解释器（用 HSL 解释 TC 语言）", () => {
  test("check + 解释器黄金输出（Hello World · 906 指令）", () => {
    const c = runDhv(["check", "fixtures/turing/bf.hsl"]);
    expect(c.ok).toBe(true);
    const lines = runHslLines("fixtures/turing/bf.hsl", "bf");
    const joined = lines.join("\n");
    expect(joined).toContain("BF says: Hello World!");
    expect(joined).toContain("executed=906 instructions");
    expect(joined).toContain("BF VERIFIED");
  }, 120_000);

  test("python 投射：真实运行输出一致 + ruff 全绿", () => {
    const dir = path.join(SCRATCH, "bf-py");
    expect(emit("fixtures/turing/bf.hsl", dir)).toBe(true);
    const py = execFileSync("python3", [path.join(dir, "bf.py")], { encoding: "utf-8" });
    expect(py).toContain("BF says: Hello World!");
    expect(py).toContain("executed=906 instructions");
    execFileSync(toolPath("ruff"), ["check", dir], { stdio: "pipe" });
  }, 120_000);

  test("rust 投射：rustc 真实编译运行输出一致（char_at 映射回归）", () => {
    const dir = path.join(SCRATCH, "bf-rs");
    expect(emit("fixtures/turing/bf.hsl", dir)).toBe(true);
    const bin = path.join(dir, "bf-bin");
    execFileSync(toolPath("rustc"), [path.join(dir, "bf.rs"), "-o", bin], { stdio: "pipe" });
    const rsOut = execFileSync(bin, { encoding: "utf-8" });
    expect(rsOut).toContain("BF says: Hello World!");
    expect(rsOut).toContain("executed=906 instructions");
  }, 120_000);
});

describe("ruff 门禁：图灵语料入册（六语料全绿）", () => {
  test("bun scripts/ruff-gate.ts 全绿（含三份图灵语料）", () => {
    const r = Bun.spawnSync([process.execPath, "scripts/ruff-gate.ts"], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const text = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(text).toContain("rule110.hsl");
    expect(text).toContain("busy-beaver.hsl");
    expect(text).toContain("bf.hsl");
  }, 120_000);
});
