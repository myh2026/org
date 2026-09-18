// ============================================================================
// tests/symbols.test.ts — 轻量符号索引（v0.5.15 · capabilities #20）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/symbols.ts 三导出的行为级断言）：
//   1. 播种工作区（tmp）：HSL（fn/struct/enum/trait/graph/const/type/impl +
//      pub/export 双前缀 + // 注释干扰）· TS/TSX（function/async/class/
//      interface/type/const + 函数式组件记 const）· PY（async def / 缩进
//      方法 / class + # 注释干扰）→ indexSymbols 计数 · 各 kind 命中 ·
//      snippet 规范（trim 原文 + 120 帽）· 显式 dirs 范围
//   2. lookupDef：exact 缺省（大小写敏感优先 + 不敏感兜底）· 子串
//      （exact:false）· 未命中 → []
//   3. findRefs：call（name 后接 `(`）· mention（纯提及，含注释）· 定义行
//      排除 · maxHits 帽
//   4. 降级与预算帽：二进制跳过（skippedBinary）· 文件帽 600（truncated）·
//      单文件 512KB（truncated + 符号缺席）· 缺目录 = 空索引不炸
//   5. e2e（org-lab 真实仓库根 process.cwd()）：startRun（lib/engine.ts）·
//      startWebServer（web/entry.ts）· normalize_note（hsl/contracts/
//      contract.hsl）· graph Supervisor（hsl/probe/probe1.hsl）+
//      findRefs("startRun") 双 kind
// 注：e2e 断言一律按 file 过滤（tests/ 在默认扫描面内，本文件自含的播种
// 字面量会被自索引 —— 不构成计数断言的干扰源）。
// 全部显式 30s 超时。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN } from "./helpers";
import { indexSymbols, lookupDef, findRefs, type SymbolHit } from "../lib/symbols.ts";

/** 一次性 tmp 工作区（afterAll 统一回收）。 */
const TMP: string[] = [];

function makeTmp(name: string): string {
  const dir = path.join(TEST_RUN, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  TMP.push(dir);
  return dir;
}

/** 播种主工作区：三语言全形态 + 注释干扰 + 二进制 + 超长行 + 顶层 *.ts。 */
function seedWorkspace(ws: string): void {
  fs.mkdirSync(path.join(ws, "hsl"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "hsl", "demo.hsl"),
    [
      "// 注释干扰：fn ghost_comment() 不应入库",
      "export fn parse_widget(spec: String) -> String {",
      "    ...",
      "}",
      "fn helper_inner(x: u32) -> u32 { x + 1 }",
      "pub struct TaskFrame {",
      "}",
      "export enum Verdict {",
      "}",
      "trait Sendable {",
      "}",
      "graph Orchestrator -> Result<u32, String> {",
      "}",
      "export const ENVELOPE_SIG: String = String::from(\"x\");",
      "type Alias = u32;",
      "impl Registry {",
      "}",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "lib", "util.ts"),
    [
      "// 注释干扰：function ghost_fn() {}",
      "export function startEngine(opts: Opts): Handle {",
      "  return null as any;",
      "}",
      "export async function fetchData(url: string): Promise<void> {}",
      "export interface Repo {}",
      "export type Id = string;",
      "export const MAX_RETRIES = 3;",
      "class InternalCache {}",
      `export const PAD = "${"x".repeat(130)}";`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(ws, "lib", "ui.tsx"), "export const Card = () => null; // 函数式组件记 const\n");
  fs.writeFileSync(
    path.join(ws, "lib", "app.py"),
    [
      "# 注释干扰：def ghost_def(): pass",
      "async def run_task(name):",
      "    pass",
      "class Scheduler:",
      "    def tick(self):",
      "        pass",
      "def top_level():",
      "    pass",
      "",
    ].join("\n"),
  );
  // 顶层 *.ts（默认扫描面的非递归补充）
  fs.writeFileSync(path.join(ws, "main.ts"), "export function rootEntry() {}\n");
  // 二进制：扩展名在扫描面内但内容含 NUL → skippedBinary
  fs.writeFileSync(path.join(ws, "lib", "nulled.ts"), "export function hidden_in_binary() {}\n\u0000\n");
}

const WS: string = makeTmp("symbols-ws");

beforeAll(() => {
  seedWorkspace(WS);
});

afterAll(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 1. indexSymbols：播种工作区 ----------------------------------------------

describe("indexSymbols · 播种工作区", () => {
  test("计数：files=5 · symbols=22 · 二进制跳过 1 · 不截断", () => {
    const idx = indexSymbols(WS);
    expect(idx.files).toBe(5); // demo.hsl + util.ts + ui.tsx + app.py + 顶层 main.ts
    expect(idx.symbols).toHaveLength(22);
    expect(idx.skippedBinary).toBe(1); // lib/nulled.ts（前 4KB 含 \0）
    expect(idx.truncated).toBe(false);
    expect(idx.builtMs).toBeGreaterThanOrEqual(0);
    // 二进制文件的符号不入库
    expect(lookupDef(idx.symbols, "hidden_in_binary")).toHaveLength(0);
  }, 30_000);

  test("HSL 全形态：fn/struct/enum/trait/graph/const/type/impl（pub/export 双前缀）", () => {
    const { symbols } = indexSymbols(WS);
    const expectKind = (name: string, kind: SymbolHit["kind"]): void => {
      const hits = lookupDef(symbols, name);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.kind).toBe(kind);
      expect(hits[0]!.file).toBe("hsl/demo.hsl");
    };
    expectKind("parse_widget", "fn"); // export fn
    expectKind("helper_inner", "fn"); // 裸 fn
    expectKind("TaskFrame", "struct"); // pub struct
    expectKind("Verdict", "enum"); // export enum
    expectKind("Sendable", "trait"); // 裸 trait
    expectKind("Orchestrator", "graph"); // graph NAME -> Ret {
    expectKind("ENVELOPE_SIG", "const"); // export const
    expectKind("Alias", "type"); // 裸 type
    expectKind("Registry", "impl"); // impl 类型名
  }, 30_000);

  test("TS/TSX 全形态：function/async/class/interface/type/const + 顶层 *.ts", () => {
    const { symbols } = indexSymbols(WS);
    const hit = (name: string): SymbolHit => {
      const hits = lookupDef(symbols, name);
      expect(hits).toHaveLength(1);
      return hits[0]!;
    };
    expect(hit("startEngine").kind).toBe("fn");
    expect(hit("startEngine").line).toBe(2);
    expect(hit("fetchData").kind).toBe("fn"); // async function
    expect(hit("Repo").kind).toBe("interface");
    expect(hit("Id").kind).toBe("type");
    expect(hit("MAX_RETRIES").kind).toBe("const");
    expect(hit("InternalCache").kind).toBe("class"); // 无 export 的裸 class
    expect(hit("Card").kind).toBe("const"); // 函数式组件记 const（不深究）
    expect(hit("Card").file).toBe("lib/ui.tsx");
    expect(hit("rootEntry").file).toBe("main.ts"); // 顶层 *.ts 收录
  }, 30_000);

  test("PY 全形态：async def / 缩进方法 / class；注释行干扰不入库", () => {
    const { symbols } = indexSymbols(WS);
    const hit = (name: string): SymbolHit => lookupDef(symbols, name)[0]!;
    expect(hit("run_task").kind).toBe("fn"); // async def
    expect(hit("run_task").file).toBe("lib/app.py");
    expect(hit("Scheduler").kind).toBe("class");
    expect(hit("tick").kind).toBe("fn"); // 缩进方法（trim 后匹配）
    expect(hit("top_level").kind).toBe("fn");
    for (const ghost of ["ghost_comment", "ghost_fn", "ghost_def"]) {
      expect(lookupDef(symbols, ghost)).toHaveLength(0);
    }
  }, 30_000);

  test("snippet 规范：trim 后原文；超长行截 120 字符", () => {
    const { symbols } = indexSymbols(WS);
    const pw = lookupDef(symbols, "parse_widget")[0]!;
    expect(pw.snippet).toBe("export fn parse_widget(spec: String) -> String {");
    const pad = lookupDef(symbols, "PAD")[0]!;
    expect(pad.snippet.length).toBe(120);
    expect(pad.snippet.startsWith("export const PAD = ")).toBe(true);
  }, 30_000);

  test("显式 dirs 参数：只扫指定目录（顶层 *.ts 不附加）", () => {
    const idx = indexSymbols(WS, ["hsl"]);
    expect(idx.files).toBe(1);
    expect(idx.symbols).toHaveLength(9);
    expect(idx.symbols.every((h) => h.file.startsWith("hsl/"))).toBe(true);
  }, 30_000);
});

// ---- 2. lookupDef 匹配语义 ----------------------------------------------------

describe("lookupDef · 匹配语义", () => {
  test("exact 缺省：大小写敏感优先，无命中时不敏感兜底；未命中 → []", () => {
    const { symbols } = indexSymbols(WS);
    expect(lookupDef(symbols, "parse_widget")).toHaveLength(1); // 敏感命中
    const ci = lookupDef(symbols, "PARSE_WIDGET"); // 敏感无命中 → 不敏感兜底
    expect(ci).toHaveLength(1);
    expect(ci[0]!.name).toBe("parse_widget");
    expect(lookupDef(symbols, "nonexistent_xyz")).toHaveLength(0);
  }, 30_000);

  test("exact:false = 子串匹配（大小写敏感）", () => {
    const { symbols } = indexSymbols(WS);
    expect(lookupDef(symbols, "widget", false).map((h) => h.name)).toEqual(["parse_widget"]);
    expect(lookupDef(symbols, "Task", false).map((h) => h.name)).toEqual(["TaskFrame"]);
    expect(lookupDef(symbols, "zzz", false)).toHaveLength(0);
  }, 30_000);
});

// ---- 3. findRefs 引用语义 -----------------------------------------------------

describe("findRefs · 引用语义", () => {
  test("call（name 后接 \\(）· mention（纯提及）· 定义行排除", () => {
    const ws = makeTmp("symbols-refs");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "lib", "refs.ts"),
      [
        "export function alpha(): number { return 1; }", // 定义行 → 排除
        "export function beta(): number { return alpha() + 1; }", // call
        "// alpha 是唯一入口", // mention（注释提及也计）
        "const label = \"alpha-core\";", // mention（词边界命中，非定义行）
        "",
      ].join("\n"),
    );
    const refs = findRefs(ws, "alpha");
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => `${r.line}:${r.kind}`)).toEqual(["2:call", "3:mention", "4:mention"]);
    expect(refs[0]!.file).toBe("lib/refs.ts");
    expect(refs[0]!.snippet).toContain("alpha() + 1");
  }, 30_000);

  test("maxHits 帽：显式 5 与缺省 200", () => {
    const ws = makeTmp("symbols-many");
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    const body = `${Array.from({ length: 30 }, (_, i) => `// alpha 提及 ${i}`).join("\n")}\n`;
    fs.writeFileSync(path.join(ws, "lib", "many.ts"), body);
    expect(findRefs(ws, "alpha", { maxHits: 5 })).toHaveLength(5);
    expect(findRefs(ws, "alpha")).toHaveLength(30); // 30 < 200 缺省帽
  }, 30_000);
});

// ---- 4. 降级与预算帽 ----------------------------------------------------------

describe("降级与预算帽", () => {
  test("文件帽 600：601 个候选 → files=600 · truncated:true", () => {
    const ws = makeTmp("symbols-cap");
    fs.mkdirSync(path.join(ws, "cap"), { recursive: true });
    for (let i = 0; i < 601; i++) {
      fs.writeFileSync(
        path.join(ws, "cap", `f${String(i).padStart(3, "0")}.ts`),
        `export function unit_${i}() {}\n`,
      );
    }
    const idx = indexSymbols(ws, ["cap"]);
    expect(idx.files).toBe(600);
    expect(idx.truncated).toBe(true);
    expect(idx.symbols).toHaveLength(600); // 每文件恰 1 个 fn
  }, 30_000);

  test("单文件帽 512KB：超帽跳过（truncated + 符号缺席）；缺目录 = 空索引不炸", () => {
    const ws = makeTmp("symbols-big");
    fs.mkdirSync(path.join(ws, "big"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "big", "huge.hsl"),
      `fn real_symbol() {}\n//${"x".repeat(600 * 1024)}\n`,
    );
    const idx = indexSymbols(ws, ["big"]);
    expect(idx.files).toBe(0);
    expect(idx.symbols).toHaveLength(0);
    expect(idx.truncated).toBe(true);
    // 缺目录：索引与引用双面降级为空（不炸）
    const nope = path.join(ws, "nope");
    expect(indexSymbols(nope).files).toBe(0);
    expect(indexSymbols(nope).symbols).toHaveLength(0);
    expect(indexSymbols(nope).truncated).toBe(false);
    expect(findRefs(nope, "x")).toEqual([]);
  }, 30_000);
});

// ---- 5. e2e：org-lab 真实仓库根 ------------------------------------------------

describe("e2e · org-lab 真实仓库根", () => {
  test("indexSymbols(process.cwd())：真实符号命中（TS + HSL 双语言）", () => {
    const idx = indexSymbols(process.cwd());
    expect(idx.files).toBeGreaterThanOrEqual(10);
    expect(idx.truncated).toBe(false); // ~106 个代码文件 · 最大 293KB < 帽
    const hit = (name: string, file: string, kind: SymbolHit["kind"]): void => {
      expect(
        lookupDef(idx.symbols, name).some((h) => h.file === file && h.kind === kind),
      ).toBe(true);
    };
    hit("startRun", "lib/engine.ts", "fn");
    hit("startWebServer", "web/entry.ts", "fn");
    hit("normalize_note", "hsl/contracts/contract.hsl", "fn"); // export fn（真实 HSL 前缀）
    hit("Supervisor", "hsl/probe/probe1.hsl", "graph");
  }, 30_000);

  test("findRefs(process.cwd(), 'startRun')：call 与 mention 双 kind", () => {
    const refs = findRefs(process.cwd(), "startRun");
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.some((r) => r.kind === "call")).toBe(true); // cli/chat.ts · tui/app.tsx 的 startRun({
    expect(refs.some((r) => r.kind === "mention")).toBe(true); // cli/org.ts 注释 / import 行
    // v0.5.15：工具清单（hsl/pool/tools.hsl）示例提及 startRun → .hsl 也合法入列
    expect(refs.every((r) => /\.(ts|tsx|hsl)$/.test(r.file))).toBe(true);
  }, 30_000);
});
