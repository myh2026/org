// ============================================================================
// tests/completion.test.ts — 代码补全（v0.5.16 · capabilities #32）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/completion.ts completeAt 的行为级断言）：
//   1. 三级候选与优先级：同文件符号 100+前缀 > 项目符号 80+前缀 > 关键字
//      50+前缀（播种 lib/alpha.ts 与 lib/beta.ts 双文件，同名符号 render
//      跨文件 —— 文件级先于项目级）· 分数与 detail 精确值
//   2. 触发面降级（空候选 + reason，绝不静默）：空格后 · 点后成员（含
//      obj. 与 obj.pref 两形态）· 行首列 0 · 前缀无命中
//   3. 语言面：py 关键字（def/del 同分字典序）· hsl 关键字（graph）·
//      .tsx 归 ts 面 · 非支持扩展名（.md → language:"other" + reason）
//   4. 前缀语义：大小写不敏感（STAR → startAlpha）· 光标行中取左前缀 ·
//      列越界钳制（999 → 行长）
//   5. 帽与确定性：max 截断（同名双文件 top-2）· 同分 label 字典序稳定
//   6. 文件参数双形态：工作区相对路径与绝对路径（自动转相对 → 同文件级）
// 全部显式 30s 超时。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN } from "./helpers";
import { completeAt, KEYWORDS_BY_LANG } from "../lib/completion.ts";

/** 一次性 tmp 工作区（afterAll 统一回收）。 */
const TMP: string[] = [];

function makeTmp(name: string): string {
  const dir = path.join(TEST_RUN, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  TMP.push(dir);
  return dir;
}

/** 播种补全工作区：双 TS 文件（同名符号跨文件）+ PY + HSL + TSX。 */
function seedWorkspace(ws: string): void {
  fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "lib", "alpha.ts"),
    [
      "export function startAlpha(): number { return 1; }",
      "export function render(): string { return \"a\"; }",
      "export const MAX_SIZE = 10;",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ws, "lib", "beta.ts"),
    [
      "export function startBeta(): number { return 2; }",
      "export function render(): string { return \"b\"; }",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ws, "lib", "app.py"),
    ["def run_task(name):", "    pass", ""].join("\n"),
  );
  fs.writeFileSync(path.join(ws, "lib", "ui.tsx"), "export const Card = () => null;\n");
  fs.mkdirSync(path.join(ws, "hsl"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "hsl", "demo.hsl"),
    ["export fn parse_widget(spec: String) -> String {", "    spec", "}", "graph Orchestrator -> u32 {", "}", ""].join("\n"),
  );
}

const WS: string = makeTmp("completion-ws");

beforeAll(() => {
  seedWorkspace(WS);
});

afterAll(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 1. 三级候选与优先级 ------------------------------------------------------

describe("completion · 三级候选与优先级", () => {
  test("同文件符号先于项目符号：分数 100+5 / 80+5 · detail 精确", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "  start", 7);
    expect(r.language).toBe("ts");
    expect(r.prefix).toBe("start");
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toEqual({
      label: "startAlpha",
      kind: "fn",
      detail: "lib/alpha.ts:1 · fn",
      score: 105, // 100 + 前缀 5
      source: "file",
    });
    expect(r.candidates[1]!.label).toBe("startBeta");
    expect(r.candidates[1]!.source).toBe("project");
    expect(r.candidates[1]!.score).toBe(85); // 80 + 5
    expect(r.candidates[1]!.detail).toBe("lib/beta.ts:1 · fn");
  }, 30_000);

  test("项目级视角互换：beta.ts 视角下 startBeta 为 file 级", async () => {
    const r = await completeAt(WS, "lib/beta.ts", "start", 5);
    expect(r.candidates[0]).toMatchObject({ label: "startBeta", source: "file", score: 105 });
    expect(r.candidates[1]).toMatchObject({ label: "startAlpha", source: "project", score: 85 });
  }, 30_000);

  test("符号 > 关键字：render(102) 先于 return/readonly(52)", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "re", 2);
    expect(r.candidates[0]).toMatchObject({ label: "render", source: "file", score: 102 });
    expect(r.candidates.some((c) => c.label === "return" && c.source === "keyword")).toBe(true);
    expect(r.candidates.some((c) => c.label === "readonly" && c.source === "keyword")).toBe(true);
    // 同为关键字的 return/readonly 同分 52 —— label 字典序稳定
    const kws = r.candidates.filter((c) => c.source === "keyword").map((c) => c.label);
    expect(kws.indexOf("readonly")).toBeLessThan(kws.indexOf("return"));
  }, 30_000);

  test("同名符号跨文件：max:2 截断保留 file 级与 project 级各一", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "re", 2, { max: 2 });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toMatchObject({ label: "render", source: "file" });
    expect(r.candidates[1]).toMatchObject({ label: "render", source: "project" });
  }, 30_000);
});

// ---- 2. 触发面降级（空候选 + reason）--------------------------------------------

describe("completion · 触发面降级", () => {
  test("空格后 → 空候选 + reason 提及空格", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "render ", 7);
    expect(r.candidates).toEqual([]);
    expect(r.prefix).toBe("");
    expect(r.reason).toContain("空格");
  }, 30_000);

  test("点后（obj. 形态）→ 空候选 + reason 提及成员补全路线图", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "obj.", 4);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toContain("点后");
    expect(r.reason).toContain("LSP");
  }, 30_000);

  test("点后（obj.pref 形态）→ 空候选 + reason（前缀非空仍拒成员面）", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "obj.render", 10);
    expect(r.candidates).toEqual([]);
    expect(r.prefix).toBe("render");
    expect(r.reason).toContain("点后");
  }, 30_000);

  test("前缀无命中 → 空候选 + reason 附前缀", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "zzzq", 4);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toContain("zzzq");
    expect(r.reason).toContain("无命中");
  }, 30_000);
});

// ---- 3. 语言面 ----------------------------------------------------------------

describe("completion · 语言面", () => {
  test("py 关键字：de → def/del 同分字典序 · language:py", async () => {
    const r = await completeAt(WS, "lib/app.py", "  de", 4);
    expect(r.language).toBe("py");
    expect(r.candidates.map((c) => c.label)).toEqual(["def", "del"]);
    expect(r.candidates[0]).toMatchObject({ kind: "keyword", source: "keyword", score: 52 });
  }, 30_000);

  test("hsl 关键字：gr → graph（无符号命中时关键字独立成候选）", async () => {
    const r = await completeAt(WS, "hsl/demo.hsl", "gr", 2);
    expect(r.language).toBe("hsl");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ label: "graph", source: "keyword" });
  }, 30_000);

  test("hsl 符号命中：parse → parse_widget（fn · file 级）", async () => {
    const r = await completeAt(WS, "hsl/demo.hsl", "parse", 5);
    expect(r.candidates[0]).toMatchObject({ label: "parse_widget", kind: "fn", source: "file" });
  }, 30_000);

  test(".tsx 归 ts 面：Car → Card（const · file 级）· language:ts", async () => {
    const r = await completeAt(WS, "lib/ui.tsx", "Car", 3);
    expect(r.language).toBe("ts");
    expect(r.candidates[0]).toMatchObject({ label: "Card", kind: "const", source: "file" });
  }, 30_000);

  test("非支持扩展名：.md → language:other + reason 提及扩展名", async () => {
    const r = await completeAt(WS, "docs/readme.md", "star", 4);
    expect(r.candidates).toEqual([]);
    expect(r.language).toBe("other");
    expect(r.reason).toContain(".hsl");
    expect(r.reason).toContain(".py");
  }, 30_000);

  test("关键字表三语言非空且互不含对方核心词（HSL 无 def · PY 无 fn）", () => {
    expect(KEYWORDS_BY_LANG.hsl.length).toBeGreaterThan(10);
    expect(KEYWORDS_BY_LANG.ts.length).toBeGreaterThan(10);
    expect(KEYWORDS_BY_LANG.py.length).toBeGreaterThan(10);
    expect(KEYWORDS_BY_LANG.hsl).not.toContain("def");
    expect(KEYWORDS_BY_LANG.py).not.toContain("fn");
    expect(KEYWORDS_BY_LANG.py).toContain("lambda");
    expect(KEYWORDS_BY_LANG.hsl).toContain("graph"); // HSL 特色（图）
  }, 30_000);
});

// ---- 4. 前缀语义与列边界 ---------------------------------------------------------

describe("completion · 前缀语义与列边界", () => {
  test("大小写不敏感：STAR → startAlpha/startBeta", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "STAR", 4);
    expect(r.prefix).toBe("STAR");
    expect(r.candidates.map((c) => c.label).sort()).toEqual(["startAlpha", "startBeta"]);
  }, 30_000);

  test("光标行中取左前缀：startAlpha 第 5 列 → 前缀 start", async () => {
    const r = await completeAt(WS, "lib/alpha.ts", "startAlpha", 5);
    expect(r.prefix).toBe("start");
    expect(r.candidates[0]!.label).toBe("startAlpha");
  }, 30_000);

  test("列边界：列 0 → 行首 reason；列 999 → 钳制到行长", async () => {
    const head = await completeAt(WS, "lib/alpha.ts", "startAlpha", 0);
    expect(head.candidates).toEqual([]);
    expect(head.reason).toContain("行首");
    const far = await completeAt(WS, "lib/alpha.ts", "startAlpha", 999);
    expect(far.prefix).toBe("startAlpha");
    expect(far.candidates[0]!.label).toBe("startAlpha");
  }, 30_000);

  test("绝对路径文件参数：自动转工作区相对 → 同文件级命中", async () => {
    const r = await completeAt(WS, path.join(WS, "lib", "alpha.ts"), "start", 5);
    expect(r.candidates[0]).toMatchObject({ label: "startAlpha", source: "file" });
  }, 30_000);
});
