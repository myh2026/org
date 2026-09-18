// ============================================================================
// tests/rename.test.ts — 项目级符号重命名（v0.5.16 · capabilities #56）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/rename.ts planRename/applyRename 的行为级断言）：
//   1. 计划面：定义+5 引用跨 2 文件 → edits 恰 6 行精确（file:line）·
//      mention 警告 · 多定义不唯一警告（全定义行入编辑面）
//   2. dryRun：预览含 --- a/ 头与 +/- 行（lib/diff.ts renderUnified）·
//      ≤5 文件帽 + previewTruncated 诚实标注 · 缺省 dryRun=true 不落盘
//   3. 真写：ok 后复读 grep 旧名词边界 0 命中 · 新名落位 · applied 行数/
//      替换次数精确 · 行内多处全替换
//   4. 安全拒绝（edits:[] + warnings/reason）：目标名已存在 · 新名非法
//      标识符（HSL/py 拒 $ · TS 收 $ —— 语言差异各一例）· 新名是语言关键
//      字（TS class）· 找不到定义（含大小写不同候选提示）· 新旧名相同
//   5. 词边界：foo 不误伤 foobar/myfoo/foo$bar
//   6. 部分失败：chmod 444 只读文件 → 失败即停 + 已完成清单（root 环境
//      skipIf 诚实跳过 —— root 不受 444 约束）
// 全部显式 30s 超时。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN } from "./helpers";
import { planRename, applyRename, PREVIEW_FILE_CAP } from "../lib/rename.ts";

/** 一次性 tmp 工作区（afterAll 统一回收）。 */
const TMP: string[] = [];

function makeTmp(name: string): string {
  const dir = path.join(TEST_RUN, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  TMP.push(dir);
  return dir;
}

/** 词边界计数（测试本地助手 —— 与实现同字符集的独立复刻，交叉验证）。 */
function countWord(text: string, name: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    const re = new RegExp(`${name}(?![A-Za-z0-9_$])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index === 0 || !/[A-Za-z0-9_$]/.test(line[m.index - 1]!)) count++;
    }
  }
  return count;
}

// ---- 播种：主工作区（定义 + 5 引用跨 2 文件）----------------------------------

function seedBasic(ws: string): void {
  fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "lib", "def.ts"),
    [
      "export function alpha(): number { return 1; }",
      "",
      "export function beta(): number { return alpha() + 1; }",
      "// alpha 是唯一入口",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ws, "lib", "use.ts"),
    [
      "import { alpha } from \"./def.ts\";",
      "export function caller(): number { return alpha() * 2; }",
      "const alias = alpha;",
      "",
    ].join("\n"),
  );
}

/** 主工作区（beforeAll 播种；真写用例各自播种独立 ws，互不污染）。 */
const WS: string = makeTmp("rename-ws");

beforeAll(() => {
  seedBasic(WS);
});

afterAll(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 1. 计划面 ----------------------------------------------------------------

describe("rename · 计划面", () => {
  test("定义 + 5 引用跨 2 文件 → edits 恰 6 行精确 · mention 警告在场", async () => {
    const p = await planRename(WS, "alpha", "gamma");
    expect(p.definition).toMatchObject({ kind: "fn", name: "alpha", file: "lib/def.ts", line: 1 });
    // 引用：def.ts:3(call) · def.ts:4(mention) · use.ts:1/2/3
    expect(p.refs).toHaveLength(5);
    expect(p.refs.map((r) => `${r.file}:${r.line}`).sort()).toEqual([
      "lib/def.ts:3",
      "lib/def.ts:4",
      "lib/use.ts:1",
      "lib/use.ts:2",
      "lib/use.ts:3",
    ]);
    expect(p.refs.filter((r) => r.kind === "call")).toHaveLength(2);
    // edits = 定义行 + 5 引用行
    expect(p.edits).toHaveLength(6);
    expect(p.edits[0]).toEqual({ file: "lib/def.ts", line: 1, from: "alpha", to: "gamma" });
    expect(new Set(p.edits.map((e) => e.file))).toEqual(new Set(["lib/def.ts", "lib/use.ts"]));
    // 3 处 mention（注释/字符串提及）→ 诚实警告（行级扫描会动注释）
    expect(p.warnings.some((w) => w.includes("3 处 mention"))).toBe(true);
    expect(p.reason).toBeUndefined();
  }, 30_000);

  test("多定义不唯一：警告 + 全部定义行入编辑面", async () => {
    const ws = makeTmp("rename-multi");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(path.join(ws, "lib", "m1.ts"), "export function delta() {}\n");
    fs.writeFileSync(path.join(ws, "lib", "m2.ts"), "export function delta() {}\n");
    fs.writeFileSync(path.join(ws, "lib", "m3.ts"), "export const d = delta();\n");
    const p = await planRename(ws, "delta", "epsilon");
    expect(p.definition!.file).toBe("lib/m1.ts"); // file 序首个
    expect(p.warnings.some((w) => w.includes("定义不唯一（2 处）"))).toBe(true);
    expect(p.edits.map((e) => `${e.file}:${e.line}`).sort()).toEqual([
      "lib/m1.ts:1",
      "lib/m2.ts:1",
      "lib/m3.ts:1",
    ]);
  }, 30_000);
});

// ---- 2. dryRun 预览 -------------------------------------------------------------

describe("rename · dryRun 预览", () => {
  test("缺省 dryRun=true：预览含 --- a/ 头与 +/- 行，不落盘", async () => {
    const r = await applyRename(WS, "alpha", "gamma");
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesTotal).toBe(2);
    expect(r.previewTruncated).toBe(false);
    expect(r.previews).toHaveLength(2);
    expect(r.previews![0]!.file).toBe("lib/def.ts");
    expect(r.previews![0]!.diff).toContain("--- a/lib/def.ts");
    expect(r.previews![0]!.diff).toContain("+++ b/lib/def.ts");
    expect(r.previews![0]!.diff).toContain("-export function alpha(): number { return 1; }");
    expect(r.previews![0]!.diff).toContain("+export function gamma(): number { return 1; }");
    expect(r.previews![0]!.stats).toContain("+");
    // 不落盘：原文件原样
    expect(fs.readFileSync(path.join(WS, "lib", "def.ts"), "utf-8")).toContain("function alpha");
  }, 30_000);

  test("预览帽 5 文件：7 文件计划 → 5 预览 + previewTruncated 诚实标注", async () => {
    const ws = makeTmp("rename-cap");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(path.join(ws, "lib", "d0.ts"), "export function sigma(): number { return 1; }\n");
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(ws, "lib", `r${i}.ts`), `export const v${i} = sigma() + ${i};\n`);
    }
    const r = await applyRename(ws, "sigma", "tau");
    expect(r.plan.edits).toHaveLength(7); // 1 定义 + 6 引用
    expect(r.filesTotal).toBe(7);
    expect(r.previews).toHaveLength(PREVIEW_FILE_CAP);
    expect(r.previewTruncated).toBe(true);
  }, 30_000);
});

// ---- 3. 真写 -------------------------------------------------------------------

describe("rename · 真写", () => {
  test("alpha→gamma 真写：复读旧名词边界 0 命中 · 新名落位 · applied 精确计数", async () => {
    const ws = makeTmp("rename-apply");
    seedBasic(ws);
    const r = await applyRename(ws, "alpha", "gamma", { dryRun: false });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(r.applied).toHaveLength(2);
    expect(r.applied![0]).toEqual({ file: "lib/def.ts", lines: 3, occurrences: 3 });
    expect(r.applied![1]).toEqual({ file: "lib/use.ts", lines: 3, occurrences: 3 });
    // 复读：旧名词边界 0 · 新名 6 行落位
    const def = fs.readFileSync(path.join(ws, "lib", "def.ts"), "utf-8");
    const use = fs.readFileSync(path.join(ws, "lib", "use.ts"), "utf-8");
    expect(countWord(def, "alpha")).toBe(0);
    expect(countWord(use, "alpha")).toBe(0);
    expect(def.split("\n")[0]).toBe("export function gamma(): number { return 1; }");
    expect(def.split("\n")[2]).toContain("return gamma() + 1");
    expect(def.split("\n")[3]).toBe("// gamma 是唯一入口"); // mention 也改（warning 已明示）
    expect(use.split("\n")[0]).toContain('import { gamma }');
  }, 30_000);

  test("词边界：foo 不误伤 foobar/myfoo · 行内多处全替换", async () => {
    const ws = makeTmp("rename-edge");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "lib", "edge.ts"),
      [
        "export function foo(): number { return 1; }",
        "export function foobar(): number { return foo() + 1; }",
        "const myfoo = foo;",
        "const s = \"foo bar foo\";",
        "const dollar = \"foo$bar\";",
        "",
      ].join("\n"),
    );
    const p = await planRename(ws, "foo", "qux");
    // 引用 = foobar 行的 foo() · myfoo 行的裸 foo · 字符串行（两处）——
    // foo$bar 行不足词边界（$ 是词字符，与 symbols.ts 同规）
    expect(p.refs.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(p.edits).toHaveLength(4); // 定义行 1 + 引用行 2/3/4
    const r = await applyRename(ws, "foo", "qux", { dryRun: false });
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(path.join(ws, "lib", "edge.ts"), "utf-8");
    const lines = text.split("\n");
    expect(countWord(text, "foo")).toBe(0);
    expect(lines[1]).toContain("foobar"); // 不误伤
    expect(lines[1]).toContain("qux()");
    expect(lines[2]).toBe("const myfoo = qux;"); // myfoo 完整保留
    expect(lines[3]).toBe('const s = "qux bar qux";'); // 行内多处全替换
    expect(lines[4]).toBe('const dollar = "foo$bar";'); // $ 是词字符 —— foo 不动
    expect(r.applied![0]).toEqual({ file: "lib/edge.ts", lines: 4, occurrences: 5 }); // 行 4 内两处
  }, 30_000);

  test.skipIf(process.getuid?.() === 0)(
    "部分失败：只读文件 → 失败即停 + 已完成清单（root 不受 444 约束，诚实跳过）",
    async () => {
    // root 不受 chmod 444 约束（写入会成功 → 断言必假）—— 诚实跳过而非假红
    const ws = makeTmp("rename-ro");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "lib", "a.ts"),
      ["export function alpha(): number { return 1; }", "export function callA(): number { return alpha() + 1; }", ""].join("\n"),
    );
    const roFile = path.join(ws, "lib", "z.ts");
    fs.writeFileSync(roFile, "export function callZ(): number { return alpha() * 3; }\n");
    fs.chmodSync(roFile, 0o444);
    try {
      const r = await applyRename(ws, "alpha", "gamma", { dryRun: false });
      expect(r.ok).toBe(false);
      expect(r.failed!.file).toBe("lib/z.ts");
      expect(r.failed!.error).toContain("写入失败");
      expect(r.reason).toContain("lib/z.ts");
      // 诚实部分失败：a.ts 已完成（file 序在 z.ts 前），z.ts 原样
      expect(r.applied).toHaveLength(1);
      expect(r.applied![0]!.file).toBe("lib/a.ts");
      expect(countWord(fs.readFileSync(path.join(ws, "lib", "a.ts"), "utf-8"), "alpha")).toBe(0);
      expect(countWord(fs.readFileSync(roFile, "utf-8"), "alpha")).toBe(1);
    } finally {
      fs.chmodSync(roFile, 0o666); // 恢复权限（afterAll 回收顺畅）
    }
    },
    30_000,
  );
});

// ---- 4. 安全拒绝 ----------------------------------------------------------------

describe("rename · 安全拒绝", () => {
  test("目标名已存在 → edits:[] + 警告附冲突位置", async () => {
    const p = await planRename(WS, "alpha", "beta"); // beta 定义于 lib/def.ts:3
    expect(p.definition).not.toBeNull(); // 定义找到了，但计划被拒
    expect(p.edits).toEqual([]);
    expect(p.warnings.some((w) => w.includes("目标名已存在"))).toBe(true);
    expect(p.warnings.some((w) => w.includes("lib/def.ts:3"))).toBe(true);
    expect(p.reason).toContain("已存在");
  }, 30_000);

  test("HSL 新名非法：$ 不允许（Rust 风格标识符族）", async () => {
    const ws = makeTmp("rename-hsl");
    fs.mkdirSync(path.join(ws, "hsl"), { recursive: true });
    fs.writeFileSync(path.join(ws, "hsl", "mod.hsl"), "export fn zeta(x: u32) -> u32 { x }\n");
    const p = await planRename(ws, "zeta", "new$name");
    expect(p.edits).toEqual([]);
    expect(p.warnings.some((w) => w.includes("HSL"))).toBe(true);
    expect(p.reason).toContain("不是合法");
    expect(p.reason).toContain("new$name");
  }, 30_000);

  test("PY 新名非法：连字符拒绝", async () => {
    const ws = makeTmp("rename-py");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(path.join(ws, "lib", "app.py"), "def omega():\n    pass\n");
    const p = await planRename(ws, "omega", "bad-name");
    expect(p.edits).toEqual([]);
    expect(p.warnings.some((w) => w.includes("PY"))).toBe(true);
    expect(p.reason).toContain("不是合法");
    expect(p.reason).toContain("bad-name");
  }, 30_000);

  test("TS 语言关键字作新名 → 拒（completion 关键字表单一事实源）", async () => {
    const p = await planRename(WS, "alpha", "class");
    expect(p.edits).toEqual([]);
    expect(p.warnings.some((w) => w.includes("语言关键字"))).toBe(true);
    expect(p.reason).toContain("关键字");
  }, 30_000);

  test("TS 允许 $ 新名（与 HSL/PY 的语言差异）", async () => {
    const p = await planRename(WS, "alpha", "new$name");
    expect(p.edits.length).toBeGreaterThan(0);
    expect(p.reason).toBeUndefined();
  }, 30_000);

  test("找不到定义 → definition:null + reason（含大小写不同候选提示）", async () => {
    const miss = await planRename(WS, "nonexistent", "x");
    expect(miss.definition).toBeNull();
    expect(miss.edits).toEqual([]);
    expect(miss.reason).toContain("未找到");
    // 大小写打错的提示（lookupDef 的兜底被剔除 —— 重命名必须精确大小写）
    const ci = await planRename(WS, "ALPHA", "x");
    expect(ci.definition).toBeNull();
    expect(ci.reason).toContain("alpha（lib/def.ts:1）");
  }, 30_000);

  test("新旧名相同 → 无操作拒绝", async () => {
    const p = await planRename(WS, "alpha", "alpha");
    expect(p.edits).toEqual([]);
    expect(p.reason).toContain("新旧名相同");
  }, 30_000);

  test("被拒计划真写 → ok:false + 空已完成清单（不碰盘）", async () => {
    const before = fs.readFileSync(path.join(WS, "lib", "def.ts"), "utf-8");
    const r = await applyRename(WS, "alpha", "beta", { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.reason).toContain("已存在");
    expect(fs.readFileSync(path.join(WS, "lib", "def.ts"), "utf-8")).toBe(before);
  }, 30_000);
});
