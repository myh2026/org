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
//
// v0.5.15 三重平台防御（CI 实测驱动，跨平台假红清零）：
//   1. 工具缺席优雅降级：ruff/rustc/g++ 缺失时 test.skip（可见理由）
//      而非 ENOENT 假红 —— 与全仓「多重优雅降级」哲学一致（裸检出
//      bun test 不炸；CI 已装工具，覆盖不缩水）；
//   2. win32 可执行后缀：rustc/g++ 产物在 Windows 是 <name>.exe，
//      execFileSync 不自动补后缀 → exeOf() 统一追加；
//   3. CRLF 归一：MSVC CRT 文本模式把 \n 翻译成 \r\n（管道也不例外），
//      对拍前 normLines() 归一 —— 与解释器逐行一致。
// ============================================================================

import { describe, test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDhv } from "./helpers";
import { execFileSync } from "node:child_process";

const TURING = path.join(process.cwd(), "fixtures/turing");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "org-turing-"));
const WIN32 = process.platform === "win32";
/** python 解释器命令（Windows runner 只有 python.exe，无 python3 别名）。 */
const PY = WIN32 ? "python" : "python3";

/** 编译工具的 PATH（rustup 落在 ~/.cargo/bin）。 */
function toolPath(tool: string): string {
  const exe = WIN32 ? ".exe" : "";
  for (const c of [...(process.env.PATH?.split(path.delimiter) ?? []),
    path.join(os.homedir(), ".cargo", "bin"),
    path.join(os.homedir(), ".local", "bin")]) {
    const p = path.join(c, tool + exe);
    if (fs.existsSync(p)) return p;
    if (!WIN32 && fs.existsSync(path.join(c, tool))) return path.join(c, tool);
  }
  return tool + exe;
}

/** 工具是否可用（缺席 → 用例优雅降级 skip，不假红）。 */
function hasTool(tool: string): boolean {
  const exe = WIN32 ? ".exe" : "";
  for (const c of [...(process.env.PATH?.split(path.delimiter) ?? []),
    path.join(os.homedir(), ".cargo", "bin"),
    path.join(os.homedir(), ".local", "bin")]) {
    if (fs.existsSync(path.join(c, tool + exe))) return true;
    if (!WIN32 && fs.existsSync(path.join(c, tool))) return true;
  }
  return false;
}

/** 工具在场才注册用例；缺席降级为 skip（理由写进用例名，输出可见）。 */
function toolTest(tool: string, name: string, fn: () => void, ms = 120_000) {
  const reg = hasTool(tool) ? test : test.skip;
  reg(`${name}${hasTool(tool) ? "" : `（${tool} 缺席，降级跳过）`}`, fn, ms);
}

/** Windows 可执行路径（rustc/g++ 产物 .exe 后缀）。 */
function exeOf(bin: string): string {
  return WIN32 ? bin + ".exe" : bin;
}

/** v0.5.15：行为无关的编译产物执行 —— rustc 对 `-o name`（无扩展名）在
 * Windows 会补 .exe，MinGW g++ 同样补；但两者历史行为不一（CI 实录：exec
 * 补了 .exe 却 ENOENT）。改为双候选探测：<name>.exe 与 <name> 谁存在跑谁，
 * 编译器后缀策略不再进入测试语义。 */
function runBin(bin: string): string {
  const candidates = WIN32 ? [bin + ".exe", bin] : [bin];
  for (const c of candidates) {
    if (fs.existsSync(c)) return execFileSync(c, { encoding: "utf-8" });
  }
  throw new Error(`编译产物未找到（候选：${candidates.join(" / ")}）—— 编译器输出名与预期不符`);
}

/** 行尾归一（MSVC CRT 文本模式 \r\n → \n），跨平台逐行对拍。 */
function normOut(s: string): string {
  return s.replace(/\r\n/g, "\n");
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

  toolTest(WIN32 ? "python" : "python3", "python 投射：真实运行输出一致 + ruff 全绿", () => {
    const dir = path.join(SCRATCH, "r110-py");
    expect(emit("fixtures/turing/rule110.hsl", dir)).toBe(true);
    const py = execFileSync(PY, [path.join(dir, "main.py")], { encoding: "utf-8" });
    const interp = runHslLines("fixtures/turing/rule110.hsl", "r110b").filter((l) => /^[.#]+$/.test(l));
    const pyLines = normOut(py).split("\n").filter((l) => l.trim().length > 0);
    expect(pyLines).toEqual(interp);
    if (hasTool("ruff")) execFileSync(toolPath("ruff"), ["check", dir], { stdio: "pipe" });
  });

  toolTest("rustc", "rust 投射：rustc 真实编译运行输出一致", () => {
    const dir = path.join(SCRATCH, "r110-rs");
    expect(emit("fixtures/turing/rule110.hsl", dir)).toBe(true);
    const bin = path.join(dir, "rule110-bin");
    execFileSync(toolPath("rustc"), [path.join(dir, "rule110.rs"), "-o", exeOf(bin)], { stdio: "pipe" }); // v0.5.15：显式 .exe —— rustc 对无扩展名 -o 产出无后缀 PE，Windows 无法执行
    const rsOut = runBin(bin);
    const interp = runHslLines("fixtures/turing/rule110.hsl", "r110c").filter((l) => /^[.#]+$/.test(l));
    const rsLines = normOut(rsOut).split("\n").filter((l) => l.trim().length > 0);
    expect(rsLines).toEqual(interp);
  });

  toolTest("g++", "cpp 投射：g++ -std=c++20 真实编译运行输出一致", () => {
    const dir = path.join(SCRATCH, "r110-cpp");
    expect(emit("fixtures/turing/rule110.hsl", dir)).toBe(true);
    const bin = path.join(dir, "rule110-cpp-bin");
    execFileSync(toolPath("g++"), ["-std=c++20", path.join(dir, "rule110.cpp"), "-o", exeOf(bin)], { stdio: "pipe" });
    const cppOut = runBin(bin);
    const interp = runHslLines("fixtures/turing/rule110.hsl", "r110d").filter((l) => /^[.#]+$/.test(l));
    const cppLines = normOut(cppOut).split("\n").filter((l) => l.trim().length > 0);
    expect(cppLines).toEqual(interp);
  });
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

  toolTest(WIN32 ? "python" : "python3", "python 投射：真实运行输出一致 + ruff 全绿", () => {
    const dir = path.join(SCRATCH, "bb-py");
    expect(emit("fixtures/turing/busy-beaver.hsl", dir)).toBe(true);
    const py = execFileSync(PY, [path.join(dir, "busy_beaver.py")], { encoding: "utf-8" });
    expect(normOut(py)).toContain("steps=13 configs=14 ones=6");
    expect(normOut(py)).toContain("BB(3) VERIFIED");
    if (hasTool("ruff")) execFileSync(toolPath("ruff"), ["check", dir], { stdio: "pipe" });
  });

  toolTest("rustc", "rust 投射：rustc 真实编译运行输出一致（as 转换保真回归）", () => {
    const dir = path.join(SCRATCH, "bb-rs");
    expect(emit("fixtures/turing/busy-beaver.hsl", dir)).toBe(true);
    const bin = path.join(dir, "bb-bin");
    execFileSync(toolPath("rustc"), [path.join(dir, "busy_beaver.rs"), "-o", exeOf(bin)], { stdio: "pipe" });
    const rsOut = runBin(bin);
    expect(normOut(rsOut)).toContain("steps=13 configs=14 ones=6");
    expect(normOut(rsOut)).toContain("BB(3) VERIFIED");
  });
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

  toolTest(WIN32 ? "python" : "python3", "python 投射：真实运行输出一致 + ruff 全绿", () => {
    const dir = path.join(SCRATCH, "bf-py");
    expect(emit("fixtures/turing/bf.hsl", dir)).toBe(true);
    const py = execFileSync(PY, [path.join(dir, "bf.py")], { encoding: "utf-8" });
    expect(normOut(py)).toContain("BF says: Hello World!");
    expect(normOut(py)).toContain("executed=906 instructions");
    if (hasTool("ruff")) execFileSync(toolPath("ruff"), ["check", dir], { stdio: "pipe" });
  });

  toolTest("rustc", "rust 投射：rustc 真实编译运行输出一致（char_at 映射回归）", () => {
    const dir = path.join(SCRATCH, "bf-rs");
    expect(emit("fixtures/turing/bf.hsl", dir)).toBe(true);
    const bin = path.join(dir, "bf-bin");
    execFileSync(toolPath("rustc"), [path.join(dir, "bf.rs"), "-o", exeOf(bin)], { stdio: "pipe" });
    const rsOut = runBin(bin);
    expect(normOut(rsOut)).toContain("BF says: Hello World!");
    expect(normOut(rsOut)).toContain("executed=906 instructions");
  });
});

describe("ruff 门禁：图灵语料入册（六语料全绿）", () => {
  toolTest("ruff", "bun scripts/ruff-gate.ts 全绿（含三份图灵语料）", () => {
    const r = Bun.spawnSync([process.execPath, "scripts/ruff-gate.ts"], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PATH: [path.dirname(toolPath("ruff")), process.env.PATH].filter(Boolean).join(path.delimiter) },
    });
    const text = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(text).toContain("rule110.hsl");
    expect(text).toContain("busy-beaver.hsl");
    expect(text).toContain("bf.hsl");
  });
});
