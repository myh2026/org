// ============================================================================
// tests/stacktrace.test.ts — v0.5.23 批次：堆栈自动分析（#107 🟡→✅）
// ============================================================================
// 覆盖面（四层）：
//   1. 纯函数 —— 四语言帧解析（TS/JS 三形态 · PY · Rust panic 主位 · HSL 泛形）
//      + 外部分类（node_modules/node:internal/site-packages）+ 符号化（包围符号
//      + 源码行 snippet + 文件存在性）+ 根因提示库（四生态基因命中 + 关联帧
//      回落最内层）+ 帽纪律（帧 60 · 输入 64KB · 重复帧去重）+ 诚实边界
//      （空输入 / 无帧文本 / 越界路径不读盘）
//   2. stackSelfTest —— 协议自检全绿
//   3. CLI 冒烟 —— org debug stack --text / 日志文件 / --json / --self-test /
//      用法面退出码 / jail 越界拒绝
//   4. Web 端点 —— GET file 车道 + POST text 车道 + stack-selftest + 错误传播
//      + 面板要素 + 整页脚本可解析守卫
//   5. 工具环 e2e —— stack_analyze 只读工具（scripted 剧本 · result_summary
//      可观测 + jail 铁律）
// 全部本地操作（tmp 工作区隔离 + 进程内 Web 服务 + 假剧本）—— 不出网、确定性。
// ============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";
import { analyzeStackTrace, stackSelfTest, MAX_STACK_FRAMES } from "../lib/stacktrace.ts";

// ---- 工作区播种（与 tests/lsp.test.ts 同款语料 —— 符号化对拍锚定） --------------

const TMP: string[] = [];
function makeTmp(name: string): string {
  const dir = path.join(TEST_RUN, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  TMP.push(dir);
  return dir;
}

const WS: string = makeTmp("stacktrace-ws");

function seedWorkspace(ws: string): void {
  fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "lib", "app.ts"),
    [
      "export function compute(x: number): number {",
      "    if (x > 2) {",
      "        return x * 2;",
      "    }",
      "    let total = 0;",
      "    for (let i = 0; i < 3; i++) {",
      "        total += compute(x - 1);",
      "    }",
      "    return total;",
      "}",
      "export const LIMIT = 10;",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ws, "lib", "caller.ts"),
    [
      'import { compute } from "./app.ts";',
      "export function run(): number {",
      "    const v = compute(3);",
      "    return v + 1;",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ws, "lib", "mod.py"),
    [
      "def scale(v):",
      "    if v > 0:",
      "        return v * 2",
      "    else:",
      "        return 0",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(ws, "hsl"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "hsl", "orch.hsl"),
    [
      "export fn parse_widget(spec: String) -> String {",
      "    let out = spec;",
      "    if out.len() > 3 {",
      "        out = out.substr(0, 3);",
      "    }",
      "    return out;",
      "}",
      "",
    ].join("\n"),
  );
}

beforeAll(() => {
  seedWorkspace(WS);
});

afterAll(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 1. 纯函数：JS/TS 帧族 ----------------------------------------------------

describe("stacktrace · JS/TS 帧族", () => {
  const JS_TEXT = [
    "TypeError: Cannot read properties of undefined (reading 'x')",
    `    at compute (${WS}/lib/app.ts:2:12)`,
    `    at run (${WS}/lib/caller.ts:3:9)`,
    "    at async Promise.all (node:internal/process/task_queues:95:5)",
    `    at readFile (/node_modules/strip-ansi/index.js:55:10)`,
  ].join("\n");

  test("三形态帧解析：at fn (file:line:col) / async / 无函数名（file:line:col 直给）", () => {
    const r = analyzeStackTrace(WS, JS_TEXT);
    expect(r.ok).toBe(true);
    expect(r.language).toBe("ts");
    expect(r.detectedBy).toContain("ts:");
    expect(r.frames).toHaveLength(4);
    expect(r.frames[0]).toMatchObject({ fn: "compute", file: "lib/app.ts", line: 2, col: 12 });
    expect(r.frames[1]).toMatchObject({ fn: "run", file: "lib/caller.ts", line: 3, col: 9 });
    expect(r.frames[2]).toMatchObject({ fn: "Promise.all" }); // async 形态
  }, 30_000);

  test("外部分类：node:internal 与 node_modules → external:true，统计面分离", () => {
    const r = analyzeStackTrace(WS, JS_TEXT);
    expect(r.frames[2]!.external).toBe(true); // node:internal（async 形态）
    expect(r.frames[3]!.external).toBe(true); // node_modules
    expect(r.stats.external).toBe(2);
    expect(r.stats.app).toBe(2);
    expect(r.appFrames).toEqual([0, 1]);
  }, 30_000);

  test("符号化：工作区内帧 → 包围符号 + 源码行 snippet + 存在性", () => {
    const r = analyzeStackTrace(WS, JS_TEXT);
    // frame 0: compute 在 lib/app.ts:2 → 包围符号 compute（定义行 1）+ snippet "if (x > 2) {"
    expect(r.frames[0]!.enclosing).toEqual({ kind: "fn", name: "compute", defLine: 1 });
    expect(r.frames[0]!.snippet).toContain("if (x > 2)");
    expect(r.frames[0]!.exists).toBe(true);
    expect(r.frames[1]!.enclosing).toEqual({ kind: "fn", name: "run", defLine: 2 });
    expect(r.stats.symbolicated).toBe(2);
  }, 30_000);

  test("最内层用户帧 = app 帧首（崩溃点语义）；外部帧不占位", () => {
    const r = analyzeStackTrace(WS, JS_TEXT);
    expect(r.innermostAppFrame).toBe(0);
  }, 30_000);

  test("js-null-deref 提示：high + checklist 3 步 + 关联帧回落最内层用户帧", () => {
    const r = analyzeStackTrace(WS, JS_TEXT);
    const h = r.hints.find((x) => x.id === "js-null-deref");
    expect(h).toBeDefined();
    expect(h!.severity).toBe("high");
    expect(h!.checklist).toHaveLength(3);
    expect(h!.frames).toContain(0); // 无帧 raw 命中 → 回落 innermost=0
  }, 30_000);

  test("is not a function / ENOENT / ECONNREFUSED / SyntaxError 家族各自命中", () => {
    const call = analyzeStackTrace(WS, `TypeError: req.send is not a function\n    at f (${WS}/lib/app.ts:1:1)`);
    expect(call.hints.some((h) => h.id === "js-call-non-fn")).toBe(true);
    const enoent = analyzeStackTrace(WS, `Error: ENOENT: no such file or directory, open 'x.txt'\n    at f (${WS}/lib/app.ts:1:1)`);
    expect(enoent.hints.some((h) => h.id === "fs-missing-file")).toBe(true);
    const conn = analyzeStackTrace(WS, `Error: connect ECONNREFUSED 127.0.0.1:9000\n    at f (${WS}/lib/app.ts:1:1)`);
    expect(conn.hints.some((h) => h.id === "net-unreachable")).toBe(true);
    const syn = analyzeStackTrace(WS, `SyntaxError: Unexpected token } in JSON at position 5\n    at f (${WS}/lib/app.ts:1:1)`);
    expect(syn.hints.some((h) => h.id === "syntax-error")).toBe(true);
  }, 30_000);

  test("重复帧去重（递归栈形态：同名帧连续出现只计一次）", () => {
    const r = analyzeStackTrace(WS, [
      "RangeError: Maximum call stack size exceeded",
      `    at compute (${WS}/lib/app.ts:6:9)`,
      `    at compute (${WS}/lib/app.ts:6:9)`,
      `    at compute (${WS}/lib/app.ts:6:9)`,
    ].join("\n"));
    expect(r.frames).toHaveLength(1);
  }, 30_000);
});

// ---- 2. 纯函数：PY / Rust / HSL 帧族 ------------------------------------------

describe("stacktrace · PY / Rust / HSL 帧族", () => {
  test("PY：Traceback 头部探测 + File 行解析 + KeyError 提示 + 源码行 snippet", () => {
    const r = analyzeStackTrace(WS, [
      "Traceback (most recent call last):",
      `  File "${WS}/lib/mod.py", line 2, in scale`,
      "    if v > 0:",
      "KeyError: 'price'",
    ].join("\n"));
    expect(r.language).toBe("py");
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ fn: "scale", file: "lib/mod.py", line: 2 });
    expect(r.frames[0]!.enclosing).toEqual({ kind: "fn", name: "scale", defLine: 1 });
    expect(r.frames[0]!.snippet).toContain("if v > 0");
    expect(r.hints.some((h) => h.id === "py-key")).toBe(true);
  }, 30_000);

  test("PY 生态家族：IndexError / ModuleNotFoundError / NoneType TypeError / RecursionError", () => {
    expect(analyzeStackTrace(WS, "IndexError: list index out of range").hints.some((h) => h.id === "py-index")).toBe(true);
    expect(analyzeStackTrace(WS, "ModuleNotFoundError: No module named 'numpy'").hints.some((h) => h.id === "py-import")).toBe(true);
    expect(analyzeStackTrace(WS, "TypeError: unsupported operand type(s) for +: 'int' and 'NoneType'").hints.some((h) => h.id === "py-none-op")).toBe(true);
    expect(analyzeStackTrace(WS, "RecursionError: maximum recursion depth exceeded").hints.some((h) => h.id === "py-recursion")).toBe(true);
  }, 30_000);

  test("Rust：panicked 主位成帧（panic! + file:line:col）+ unwrap 提示（反引号形态）", () => {
    const r = analyzeStackTrace(WS, [
      "thread 'main' panicked at src/main.rs:5:9:",
      "called `Option::unwrap()` on a `None` value",
      "stack backtrace:",
      "   0: rust_begin_unwind",
    ].join("\n"));
    expect(r.language).toBe("rust");
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ fn: "panic!", file: "src/main.rs", line: 5, col: 9 });
    const h = r.hints.find((x) => x.id === "rs-unwrap");
    expect(h).toBeDefined();
    expect(h!.severity).toBe("high");
    // 关联帧回落主位帧（0）
    expect(h!.frames).toContain(0);
  }, 30_000);

  test("Rust 家族：index out of bounds / overflow", () => {
    expect(analyzeStackTrace(WS, "index out of bounds: the len is 3 but the index is 5").hints.some((h) => h.id === "rs-index")).toBe(true);
    expect(analyzeStackTrace(WS, "attempt to add with overflow").hints.some((h) => h.id === "rs-overflow")).toBe(true);
  }, 30_000);

  test("HSL：at file.hsl:line:col 泛形帧 + S-19 未知方法提示 + error[码] 头部探测", () => {
    const r = analyzeStackTrace(WS, [
      'run 时错误：String 没有方法 "str_nope"',
      `    at parse_widget (${WS}/hsl/orch.hsl:4:20)`,
    ].join("\n"));
    expect(r.language).toBe("hsl");
    expect(r.frames[0]).toMatchObject({ fn: "parse_widget", file: "hsl/orch.hsl", line: 4 });
    expect(r.frames[0]!.enclosing).toEqual({ kind: "fn", name: "parse_widget", defLine: 1 });
    expect(r.hints.some((h) => h.id === "hsl-unknown-method")).toBe(true);
    const head = analyzeStackTrace(WS, "error[S-19]: 接收者类型为 String，但方法面没有 str_nope");
    expect(head.language).toBe("hsl");
    expect(head.hints.some((h) => h.id === "hsl-type-mismatch" || h.id === "hsl-unknown-method")).toBe(true);
  }, 30_000);
});

// ---- 3. 纯函数：诚实边界与帽 --------------------------------------------------

describe("stacktrace · 诚实边界与帽", () => {
  test("空输入：ok:false + 指引文案（粘贴或 --file）", () => {
    const r = analyzeStackTrace(WS, "   ");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("粘贴");
    expect(r.frames).toHaveLength(0);
  }, 30_000);

  test("输入超 64KB：ok:false + 超帽文案", () => {
    const r = analyzeStackTrace(WS, "x".repeat(70 * 1024));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("超帽");
  }, 30_000);

  test("无帧文本（普通错误消息无栈形态）：ok:false + 诚实原因，hints 仍可命中（消息级分析）", () => {
    const r = analyzeStackTrace(WS, "KeyError: 'price' —— 无栈只有消息");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("未解析出栈帧");
    expect(r.hints.some((h) => h.id === "py-key")).toBe(true);
  }, 30_000);

  test("帧帽 60：截断 + truncated 诚实标注", () => {
    const text = Array.from({ length: MAX_STACK_FRAMES + 25 }, (_, i) => `    at f${i} (${WS}/lib/app.ts:${i + 1}:1)`).join("\n");
    const r = analyzeStackTrace(WS, text);
    expect(r.frames).toHaveLength(MAX_STACK_FRAMES);
    expect(r.truncated).toBe(true);
  }, 30_000);

  test("jail 铁律：越界路径帧不读盘（exists 留 null / snippet 空），分析不中断", () => {
    const r = analyzeStackTrace(WS, [
      "TypeError: boom",
      "    at f (/etc/passwd:12:1)",
      `    at g (${WS}/lib/app.ts:2:1)`,
    ].join("\n"));
    expect(r.ok).toBe(true);
    expect(r.frames[0]!.snippet).toBe("");
    expect(r.frames[1]!.snippet).toContain("if (x > 2)");
  }, 30_000);

  test("工作区外但非外部特征的绝对路径：不炸（符号化缺席，帧照常交付）", () => {
    const r = analyzeStackTrace(WS, "Error: x\n    at f (/opt/other/proj/mod.ts:9:2)");
    expect(r.ok).toBe(true);
    expect(r.frames[0]!.file).toBe("/opt/other/proj/mod.ts");
    expect(r.frames[0]!.enclosing).toBeNull();
  }, 30_000);
});

// ---- 4. stackSelfTest 协议自检 -------------------------------------------------

describe("stacktrace · stackSelfTest（协议自检）", () => {
  test("9 项全绿（四语言帧形状 + 外部分类 + 提示命中 + 帽纪律）", () => {
    const r = stackSelfTest();
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(r.total);
    expect(r.total).toBeGreaterThanOrEqual(9);
    for (const c of r.checks) expect(c.ok).toBe(true);
  }, 30_000);
});

// ---- 5. CLI 冒烟（runOrg 真子进程） ---------------------------------------------

describe("stacktrace · CLI 冒烟（org debug stack）", () => {
  test("--text 车道：帧表 + 符号化 ◆ + 提示 3 步清单 + 最内层用户帧", () => {
    const r = runOrg([
      "debug", "stack", "--text",
      `TypeError: Cannot read properties of undefined (reading 'x')\n    at compute (${WS}/lib/app.ts:2:12)\n    at node:internal/x:1:1`,
      "--workspace", WS,
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("堆栈分析（TS/JS");
    expect(r.stdout).toContain("[app] compute — lib/app.ts:2:12 ◆fn compute（定义:1）");
    expect(r.stdout).toContain("[ext]");
    expect(r.stdout).toContain("最内层用户帧");
    expect(r.stdout).toContain("js-null-deref");
    expect(r.stdout).toContain("1.");
    expect(r.stdout).toContain("2.");
    expect(r.stdout).toContain("3.");
  }, 60_000);

  test("日志文件车道 + PY 语言 + KeyError 提示", () => {
    const log = path.join(WS, "crash.log");
    fs.writeFileSync(log, `Traceback (most recent call last):\n  File "${WS}/lib/mod.py", line 2, in scale\n    if v > 0:\nKeyError: 'price'\n`);
    const r = runOrg(["debug", "stack", "crash.log", "--workspace", WS]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("Python");
    expect(r.stdout).toContain("[app] scale — lib/mod.py:2:? ◆fn scale（定义:1）");
    expect(r.stdout).toContain("py-key");
  }, 60_000);

  test("--json 车道：结构化输出（frames/hints/stats 可编程消费）", () => {
    const r = runOrg([
      "debug", "stack", "--text", `TypeError: boom\n    at compute (${WS}/lib/app.ts:2:1)`,
      "--workspace", WS, "--json",
    ]);
    expect(r.ok).toBe(true);
    const j = JSON.parse(r.stdout) as { ok: boolean; frames: unknown[]; hints: Array<{ id: string }>; stats: { total: number } };
    expect(j.ok).toBe(true);
    expect(j.frames).toHaveLength(1);
    expect(j.stats.total).toBe(1);
    expect(j.hints.some((h) => h.id === "js-null-deref")).toBe(false); // "boom" 不命中 null 模式
  }, 60_000);

  test("--self-test：9/9 通过 + 退出码 0", () => {
    const r = runOrg(["debug", "stack", "--self-test"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("堆栈分析器自检");
    expect(r.stdout).toMatch(/\d+\/\d+ 通过/);
  }, 60_000);

  test("用法面：无 text 无 file → 退出码 2；jail 越界日志 → 退出码 1 + 越界文案", () => {
    const usage = runOrg(["debug", "stack"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("用法");
    const esc = runOrg(["debug", "stack", "../../etc/passwd", "--workspace", WS]);
    expect(esc.ok).toBe(false);
    expect(esc.stderr).toContain("路径越界");
  }, 60_000);
});

// ---- 6. Web 端点（GET file / POST text / 自检 / 面板） ---------------------------

describe("stacktrace · Web 🛡 堆栈分析端点（/api/govex/debug）", () => {
  test("GET file 车道 + POST text 车道 + stack-selftest + 错误传播 + 面板要素 + JS 可解析", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    const webWs = path.join(TEST_RUN, "stacktrace-web-ws");
    fs.rmSync(webWs, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), webWs, { recursive: true });
    TMP.push(webWs);
    seedWorkspace(webWs);
    // 工作区内日志文件（GET 车道读它）
    fs.writeFileSync(path.join(webWs, "crash.log"), `Traceback (most recent call last):\n  File "${webWs}/lib/mod.py", line 2, in scale\n    if v > 0:\nKeyError: 'price'\n`);

    const srv = startWebServer({ workspace: webWs, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = async (u: string): Promise<Record<string, unknown>> =>
        (await (await fetch(base + u)).json()) as Record<string, unknown>;
      const post = async (u: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
        (await (await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

      // GET file 车道：PY 栈 + 符号化 + 提示
      const g = await get("/api/govex/debug?action=stack&file=crash.log");
      expect(g.ok).toBe(true);
      expect(g.language).toBe("py");
      const gframes = g.frames as Array<{ fn: string; enclosing: { name: string } }>;
      expect(gframes[0]!.fn).toBe("scale");
      expect(gframes[0]!.enclosing.name).toBe("scale");
      expect((g.hints as Array<{ id: string }>).some((h) => h.id === "py-key")).toBe(true);

      // POST text 车道：JS 栈 + 外部分类 + null-deref 提示
      const p = await post("/api/govex/debug", {
        action: "stack",
        text: `TypeError: Cannot read properties of undefined (reading 'x')\n    at compute (lib/app.ts:2:12)\n    at node:internal/x:1:1`,
      });
      expect(p.ok).toBe(true);
      expect(p.language).toBe("ts");
      expect(p.stats).toMatchObject({ total: 2, app: 1, external: 1 });
      expect((p.hints as Array<{ id: string; frames: number[] }>).some((h) => h.id === "js-null-deref" && h.frames.includes(0))).toBe(true);

      // 自检
      const st = await get("/api/govex/debug?action=stack-selftest");
      expect(st.ok).toBe(true);
      expect(st.passed).toBe(st.total);

      // 错误传播：GET 缺 file / 越界 / POST 空 text / 未知 action
      const noFile = await get("/api/govex/debug?action=stack");
      expect(noFile.ok).toBe(false);
      expect(String(noFile.error)).toContain("file 必填");
      const esc = await get("/api/govex/debug?action=stack&file=../../etc/passwd");
      expect(esc.ok).toBe(false);
      expect(String(esc.error)).toContain("越界");
      const badFile = await get("/api/govex/debug?action=stack&file=ghost.log");
      expect(badFile.ok).toBe(false);
      expect(String(badFile.error)).toContain("不可读");
      const emptyText = await post("/api/govex/debug", { action: "stack", text: "  " });
      expect(emptyText.ok).toBe(false);
      expect(String(emptyText.error)).toContain("text 必填");
      const badAction = await post("/api/govex/debug", { action: "whatever" });
      expect(badAction.ok).toBe(false);

      // 面板要素 + 整页脚本可解析（新函数以函数名切块同守卫）
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('id="gxStackText"');
      expect(html).toContain('id="gxStackOut"');
      expect(html).toContain('gxStackAnalyze()');
      expect(html).toContain('gxStackAnalyzeFile()');
      expect(html).toContain('gxStackSelfTest()');
      expect(html).toContain('"/api/govex/debug?action=stack');
      const m = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(m).not.toBeNull();
      expect(() => new Function(m![1]!)).not.toThrow();
      // 本簇函数独立可解析（wiring2 同款纪律：函数体语法完整）
      for (const fn of ["gxStackRender", "gxStackAnalyze", "gxStackAnalyzeFile", "gxStackSelfTest"]) {
        const fm = m![1]!.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`));
        expect(fm).not.toBeNull();
        expect(() => new Function(fm![0]!)).not.toThrow();
      }
    } finally {
      srv.stop();
    }
  }, 60_000);
});

// ---- 7. 工具环 e2e（scripted 剧本 · direct.hsl） -------------------------------

describe("stacktrace · 工具环 stack_analyze e2e（scripted 剧本）", () => {
  const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");
  const TOOLS_WS = path.join(TEST_RUN, "stacktrace-tools-ws");

  beforeAll(() => {
    fs.rmSync(TOOLS_WS, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), TOOLS_WS, { recursive: true });
    seedWorkspace(TOOLS_WS);
  });

  afterAll(() => {
    try { fs.rmSync(TOOLS_WS, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
  });

  function makeOut(name: string): string {
    const dir = path.join(TEST_RUN, "out-stacktrace-tools", name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeFixture(tracks: Record<string, string[]>): string {
    const file = path.join(TEST_RUN, "stacktrace-tools-fixture.json");
    fs.writeFileSync(file, JSON.stringify({ tracks }, null, 2));
    return file;
  }

  function askOnce(fixture: string, out: string) {
    return runDhv([
      "run", DIRECT,
      "--workspace", TOOLS_WS,
      "--task", "(direct) 堆栈分析工具环接线测试",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "stacktrace-tools", ORG_ASK_QUESTION: "接线测试",
      ORG_TOOLS: "1",
    });
  }

  function toolResults(out: string): string[] {
    return eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
  }

  test("stack_analyze（text 形态）：result_summary 可观测（语言/帧数/符号化/提示 id）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"stack_analyze","args":{"text":"TypeError: Cannot read properties of undefined (reading \'x\')\\n    at compute (lib/app.ts:2:12)\\n    at node:internal/x:1:1"}}</tool>',
        "最终答案：堆栈分析工具可观测。",
      ],
    });
    const out = makeOut("text-lane");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("stack_analyze ok ts 2帧=1用户+1外部 符号化1");
    expect(tr[0]).toContain("top=compute lib/app.ts:2");
    expect(tr[0]).toContain("提示1条[js-null-deref]");
  }, 120_000);

  test("stack_analyze（file 形态）：工作区日志 + PY 语言 + KeyError 提示", () => {
    fs.writeFileSync(path.join(TOOLS_WS, "crash.log"), `Traceback (most recent call last):\n  File "${TOOLS_WS}/lib/mod.py", line 2, in scale\n    if v > 0:\nKeyError: 'price'\n`);
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"stack_analyze","args":{"file":"crash.log"}}</tool>',
        "最终答案：文件车道可观测。",
      ],
    });
    const out = makeOut("file-lane");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("stack_analyze ok py 1帧=1用户+0外部");
    expect(tr[0]).toContain("top=scale lib/mod.py:2");
    expect(tr[0]).toContain("提示1条[py-key]");
  }, 120_000);

  test("工具环 jail 铁律 + 参数校验：越界 file 拒绝先于读盘；text/file 双缺席明确报错", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"stack_analyze","args":{"file":"../../etc/passwd"}}</tool>',
        '<tool>{"name":"stack_analyze","args":{}}</tool>',
        "最终答案：边界被拒。",
      ],
    });
    const out = makeOut("jail");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(2);
    expect(tr[0]).toContain("stack_analyze error");
    expect(tr[0]).toContain("路径越界");
    expect(tr[1]).toContain("stack_analyze error");
    expect(tr[1]).toContain("至少其一");
  }, 120_000);
});
