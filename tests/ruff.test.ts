// ============================================================================
// tests/ruff.test.ts — HSL python 产物 ruff 门禁锁定（v0.5.4）
// ============================================================================
// 锁定两层：
//   1. 生成器卫生单元：vendored dhv-ts 的 python 头部按需导入（无 F401）、
//      prelude 助手无单行 if（E701）、复合赋值算符不翻倍（+== 回归）；
//   2. 门禁脚本集成：scripts/ruff-gate.ts 全语料跑通（ruff 缺席时跳过
//      而非假红 —— CI 已装 ruff，本地裸跑 bun test 不炸）。
// ============================================================================

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const DHV = path.join(ROOT, "toolchain/dhv-ts/src/main.ts");

/** emit 一个语料并返回产物目录。 */
function emitTo(hsl: string, tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `org-ruff-test-${tag}-`));
  const r = Bun.spawnSync([process.execPath, DHV, "emit", path.join(ROOT, hsl), "--out", dir], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`emit 失败：${r.stderr.toString().slice(0, 300)}`);
  return dir;
}

function findRuff(): string | null {
  // v0.5.15：win32 后缀兼容（fs.existsSync 不自动解析 .exe）
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const c of process.env.PATH?.split(path.delimiter) ?? []) {
    const p = path.join(c, "ruff" + exe);
    if (fs.existsSync(p)) return p;
    if (!exe && fs.existsSync(path.join(c, "ruff"))) return path.join(c, "ruff");
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "ruff" + exe);
  return fs.existsSync(fallback) ? fallback : null;
}

function runRuff(dir: string): { ok: boolean; out: string } {
  const ruff = findRuff();
  if (!ruff) return { ok: true, out: "(ruff 未安装 —— 跳过，CI 侧已装)" };
  const r = Bun.spawnSync([ruff, "check", "--output-format", "concise", dir], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

describe("ruff 门禁：python 生成器卫生（v0.5.4）", () => {
  test("ORG 内核 python 投射（hsl/org.hsl → 3 个 .py）ruff 全绿", () => {
    const dir = emitTo("hsl/org.hsl", "org");
    const pyFiles = collectPy(dir);
    expect(pyFiles.length).toBe(3); // org.py / factory.py / notice_parser.py
    const r = runRuff(dir);
    expect(r.ok).toBe(true);
  }, 60_000);

  test("全特性语料（kernel-tour）ruff 全绿 —— 含复合赋值/闭包/Result 模式", () => {
    const dir = emitTo("fixtures/ruff-corpus/kernel-tour.hsl", "kern");
    const pyFiles = collectPy(dir);
    expect(pyFiles.length).toBeGreaterThanOrEqual(11);
    const r = runRuff(dir);
    expect(r.ok).toBe(true);
    // 复合赋值回归（+== bug 锁定）：生成文本不含 '+==' 算符
    const text = pyFiles.map((f) => fs.readFileSync(f, "utf-8")).join("");
    expect(text).not.toContain("+==");
    expect(text).toContain("+= 1");
  }, 60_000);

  test("按需导入：无 dataclass 的文件头部不出现 dataclasses 导入（F401 清零）", () => {
    const dir = emitTo("fixtures/ruff-corpus/kernel-tour.hsl", "imports");
    const verdict = fs.readFileSync(path.join(dir, "verdict_note.py"), "utf-8");
    // verdict_note 只做 match + format —— 不该导入 dataclasses/math/typing
    const importLines = verdict.split("\n").filter((l) => l.startsWith("from ") || l.startsWith("import "));
    expect(importLines.some((l) => l.includes("dataclasses"))).toBe(false);
    expect(importLines.some((l) => l.startsWith("import math"))).toBe(false);
  }, 60_000);

  test("prelude 助手卫生：无单行 if（E701）· 无 'format(x)'（UP032）· NaN 不用 x!=x（PLR0124）", () => {
    const dir = emitTo("fixtures/ruff-corpus/kernel-tour.hsl", "prelude");
    const text = fs.readFileSync(path.join(dir, "verdict_note.py"), "utf-8");
    // E701：助手定义无 `): return` 同行单行形态（跨行换行缩进是正常形态）
    const oneLiners = text.split("\n").filter((l) => /\)\s*:\s+return\s+\S/.test(l));
    expect(oneLiners).toEqual([]);
    // UP032：_dhv_str 用 f-string
    expect(text).not.toContain("'.format(x)");
    // PLR0124：NaN 用 math.isnan（函数内局部 import）
    expect(text).toContain("_dhv_m.isnan(x)");
  }, 60_000);

  test("Result 模式桩类：first_ok 引用 Ok → 纯 class 桩注入（F821 清零）", () => {
    const dir = emitTo("fixtures/ruff-corpus/kernel-tour.hsl", "stubs");
    const text = fs.readFileSync(path.join(dir, "first_ok.py"), "utf-8");
    expect(text).toContain("class Ok:");
    expect(text).toContain("self.f0 = f0");
    expect(text).toContain("isinstance(r, Ok)");
  }, 60_000);

  test("emit 零投射文件到不存在目录：manifest 兜底（ENOENT 修复回归）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-ruff-enoent-"));
    const target = path.join(dir, "fresh-sub", "out");
    const r = Bun.spawnSync([process.execPath, DHV, "emit", path.join(ROOT, "hsl/pool/tools.hsl"), "--out", target], {
      cwd: ROOT, stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

function collectPy(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".py")) out.push(p);
    }
  };
  walk(dir);
  return out;
}
