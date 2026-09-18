// ============================================================================
// tests/lsp.test.ts — LSP/DAP 深度簇（v0.5.17 · capabilities #26/#108）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/lsp.ts / lib/debug.ts 的行为级断言 + 三端冒烟）：
//   1. JSON-RPC 2.0 分帧（Content-Length 头 + JSON body）：
//      单帧 roundtrip · 粘包两帧一 chunk · 半包（头截断 / 体截断 / 多字节
//      字符的字节边界截断）· CJK 体字节精确（Content-Length 是字节数不是
//      字符数）· 松散 \n\n 头兜底 · 坏帧（非 JSON / 非对象）跳过不炸流
//   2. 消息构造器字段忠实：request / response / notification / error +
//      initialize/initialized/shutdown/exit 生命周期消息
//   3. 内置车道（符号索引）：lspDefinition / lspReferences / lspHover
//      （LSP 0 基 uri/range + 人读 1 基行列双形；call/mention 分类；
//      未找到 → 诚实 reason；非法名 → 拒绝）
//   4. jail 铁律：resolveJailedFile 的越界拒绝（../ 逃逸 / 盘外绝对路径）
//      + 合法相对/绝对双形态
//   5. 外部 server 车道（spawnLspServer）：echo 型假 LSP server 全生命周期
//      （initialize → initialized → 请求/错误响应/通知收集 → shutdown →
//      exit 0）· 不存在的命令 → 诚实错误（绝不 crash）
//   6. 断点建议器（suggestBreakpoints）：入口（符号级）/ if/else 分支 /
//      循环头 / return 前一行（启发式）· 同行去重 · 闭括号行不选 ·
//      非支持扩展名诚实空建议 · jail 越界拒绝
//   7. DAP 构造器字段忠实 + 与 LSP 分帧层共用往返 + dapSelfTest 全绿
//   8. 调试计划（debugPlan）：步骤编号与顺序 · DAP 消息序列协议就绪
//   9. 自检：protocolSelfTest / dapSelfTest 全部通过
//  10. CLI 冒烟（runOrg 真子进程）：org lsp definition/references/hover/
//      servers/protocol · org debug suggest/plan/dap · 用法面退出码
//  11. Web /api/govex/lsp + /api/govex/debug 端点：动作矩阵 + 越界拒绝 +
//      参数校验 + GUI 单页含 LSP/DAP 区块要素
//  12. 工具环 e2e（wiring2 同款 scripted 剧本驱动 direct.hsl）：六工具
//      （lsp_definition/references/hover/servers + debug_breakpoints/plan）
//      result_summary 观测摘要 + native 块 jail 越界拒绝（只读模式可用）
// 全部显式超时（spawn 类 60s，纯内存 30s；工具环 e2e 120s —— B-15 纪律）。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";
import {
  encodeLspMessage, encodeLspMessages, decodeLspMessage, LspFrameDecoder,
  makeLspRequest, makeLspResponse, makeLspNotification, makeLspError,
  makeInitializeParams, makeInitializedNotification, makeShutdownRequest, makeExitNotification,
  fileUri, resolveJailedFile, JSONRPC_ERRORS,
  lspDefinition, lspReferences, lspHover, detectLspServers, spawnLspServer, protocolSelfTest,
} from "../lib/lsp.ts";
import {
  suggestBreakpoints, debugPlan, dapSelfTest,
  makeDapInitialize, makeDapSetBreakpoints, makeDapStackTrace, makeDapThreads,
} from "../lib/debug.ts";

// ---- 工作区播种 ---------------------------------------------------------------

const TMP: string[] = [];
function makeTmp(name: string): string {
  const dir = path.join(TEST_RUN, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  TMP.push(dir);
  return dir;
}

const WS: string = makeTmp("lsp-ws");

/** 播种 LSP/调试工作区：TS（函数/分支/循环/return）+ HSL（if/else/for）+ PY。 */
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
  fs.mkdirSync(path.join(ws, "hsl"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "hsl", "orch.hsl"),
    [
      "export fn parse_widget(spec: String) -> String {",
      "    let out = spec;",
      "    if out.len() > 3 {",
      "        out = out.substr(0, 3);",
      "    } else {",
      '        out = out + "!";',
      "    }",
      "    for i in 0..2 {",
      '        out = out + "x";',
      "    }",
      "    return out;",
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
}

beforeAll(() => {
  seedWorkspace(WS);
});

afterAll(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 1. JSON-RPC 2.0 分帧 ------------------------------------------------------

describe("lsp · JSON-RPC 2.0 分帧（Content-Length + JSON body）", () => {
  const req = makeLspRequest(7, "textDocument/definition", { a: 1, b: "x" });
  const note = makeLspNotification("window/logMessage", { type: 3, message: "hello" });

  test("单帧 roundtrip：头声明字节精确 + 消息深度相等 + 零半包", () => {
    const frame = encodeLspMessage(req);
    expect(frame).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
    const headerEnd = frame.indexOf("\r\n\r\n") + 4;
    const body = frame.slice(headerEnd);
    const declared = Number(/Content-Length: (\d+)/.exec(frame)![1]);
    expect(declared).toBe(Buffer.byteLength(body, "utf8")); // 字节数（非字符数）
    const r = decodeLspMessage(frame);
    expect(r.messages).toEqual([req]);
    expect(r.pendingBytes).toBe(0);
  }, 30_000);

  test("粘包：两帧一 chunk 一次解码吐两条", () => {
    const r = decodeLspMessage(encodeLspMessages([req, note]));
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.id).toBe(7);
    expect(r.messages[1]!.method).toBe("window/logMessage");
  }, 30_000);

  test("半包：头截断 + 体截断（流式解码器缓冲补全）", () => {
    const buf = Buffer.from(encodeLspMessage(note), "utf8");
    const headerEnd = Buffer.from(encodeLspMessage(note), "utf8").indexOf(Buffer.from("\r\n\r\n")) + 4;
    // 头截断：头行还没到齐
    {
      const d = new LspFrameDecoder();
      expect(d.push(buf.subarray(0, 10))).toHaveLength(0);
      expect(d.pendingBytes()).toBe(10);
      expect(d.push(buf.subarray(10))).toHaveLength(1);
    }
    // 体截断：头完整但体只到一半（含恰好头边界：0 字节体）
    {
      const d = new LspFrameDecoder();
      expect(d.push(buf.subarray(0, headerEnd))).toHaveLength(0);
      expect(d.pendingBytes()).toBe(headerEnd);
      expect(d.push(buf.subarray(headerEnd, headerEnd + 3))).toHaveLength(0); // 体前 3 字节
      const out = d.push(buf.subarray(headerEnd + 3));
      expect(out).toHaveLength(1);
      expect(out[0]!.method).toBe("window/logMessage");
    }
  }, 30_000);

  test("CJK 多字节体：字节级截断续推（半个 UTF-8 字符跨 chunk）", () => {
    const cjk = makeLspNotification("window/logMessage", { message: "你好，协议分帧（字节精确性）" });
    const frame = encodeLspMessage(cjk);
    expect(Buffer.byteLength(JSON.stringify(cjk), "utf8")).toBeGreaterThan(JSON.stringify(cjk).length); // 字节 > 字符
    const buf = Buffer.from(frame, "utf8");
    const headerEnd = buf.indexOf(Buffer.from("\r\n\r\n")) + 4;
    const cut = headerEnd + 10; // 落在 CJK 多字节字符的中间（3 字节/字符）
    const d = new LspFrameDecoder();
    expect(d.push(buf.subarray(0, cut))).toHaveLength(0);
    const out = d.push(buf.subarray(cut));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(cjk); // 多字节字符在字节边界切开仍完整重组
  }, 30_000);

  test("松散 \\n\\n 头兜底（个别 server 用 LF 分隔头与体）", () => {
    const json = JSON.stringify(req);
    const loose = `Content-Length: ${Buffer.byteLength(json, "utf8")}\n\n${json}`;
    const r = decodeLspMessage(loose);
    expect(r.messages).toEqual([req]);
  }, 30_000);

  test("坏帧跳过不炸流：非 JSON 体 / 非对象体（数组）拒收计数，后续好帧照收", () => {
    const d = new LspFrameDecoder();
    d.push(Buffer.from(`Content-Length: 8\r\n\r\nnot json`, "utf8")); // 体长对齐但非 JSON
    d.push(Buffer.from(`Content-Length: 2\r\n\r\n[]`, "utf8")); // JSON 但非对象
    const ok = d.push(encodeLspMessage(req));
    expect(ok).toHaveLength(1);
    expect(ok[0]!.id).toBe(7);
    expect(d.rejectedFrames()).toBe(2);
  }, 30_000);
});

// ---- 2. 消息构造器 --------------------------------------------------------------

describe("lsp · 消息构造器字段忠实", () => {
  test("request / response / notification / error", () => {
    expect(makeLspRequest(7, "m", { a: 1 })).toEqual({ jsonrpc: "2.0", id: 7, method: "m", params: { a: 1 } });
    expect(makeLspRequest("s1", "m")).toEqual({ jsonrpc: "2.0", id: "s1", method: "m" }); // 字符串 id + 无 params
    expect(makeLspResponse(7, [1, 2])).toEqual({ jsonrpc: "2.0", id: 7, result: [1, 2] });
    expect(makeLspNotification("initialized", {})).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(makeLspNotification("exit")).toEqual({ jsonrpc: "2.0", method: "exit" }); // 无 id —— 通知无响应
    const err = makeLspError(8, JSONRPC_ERRORS.METHOD_NOT_FOUND, "nope", { x: 1 });
    expect(err.id).toBe(8);
    expect(err.error).toEqual({ code: -32601, message: "nope", data: { x: 1 } });
  }, 30_000);

  test("生命周期消息：initialize 参数 / initialized / shutdown / exit", () => {
    const params = makeInitializeParams("file:///ws", { name: "t", version: "1" });
    expect(params.rootUri).toBe("file:///ws");
    expect(params.processId).toBe(process.pid);
    expect(params.capabilities).toEqual({}); // 诚实边界：不用编辑器集成能力
    expect((params.clientInfo as { name: string }).name).toBe("t");
    expect(makeInitializedNotification()).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(makeShutdownRequest(3)).toEqual({ jsonrpc: "2.0", id: 3, method: "shutdown" });
    expect(makeExitNotification()).toEqual({ jsonrpc: "2.0", method: "exit" });
  }, 30_000);

  test("fileUri：POSIX 与 win32 盘符形", () => {
    expect(fileUri("/a/ws/x.ts")).toBe("file:///a/ws/x.ts");
    expect(fileUri("C:\\a\\x.ts")).toBe("file:///C:/a/x.ts"); // 盘符保留原形（分隔符转 /）
  }, 30_000);
});

// ---- 3. 内置车道（符号索引上的 definition / references / hover） ----------------

describe("lsp · 内置符号索引车道", () => {
  test("definition：compute → lib/app.ts:1:17 + LSP 0 基 uri/range 双形", () => {
    const r = lspDefinition(WS, "compute");
    expect(r.ok).toBe(true);
    expect(r.lane).toBe("builtin");
    expect(r.definitions).toHaveLength(1);
    const d = r.definitions[0]!;
    expect(d.kind).toBe("fn");
    expect(d.file).toBe("lib/app.ts");
    expect(d.line).toBe(1);
    expect(d.column).toBe(17); // export function ▲compute（0 基偏移 16）
    expect(d.lsp.range).toEqual({ start: { line: 0, character: 16 }, end: { line: 0, character: 23 } }); // compute 7 字符：16+7
    expect(d.lsp.uri).toBe(fileUri(path.join(WS, "lib/app.ts")));
  }, 30_000);

  test("references：3 处（call 2 · mention 1）+ 定义行排除 + 列号精确", () => {
    const r = lspReferences(WS, "compute");
    expect(r.ok).toBe(true);
    expect(r.definitions).toBe(1);
    expect(r.refs).toHaveLength(3);
    const calls = r.refs.filter((x) => x.kind === "call");
    const mentions = r.refs.filter((x) => x.kind === "mention");
    expect(calls).toHaveLength(2);
    expect(mentions).toHaveLength(1);
    // app.ts:7 total += compute(x - 1)（call · 8 空格 + "total += " → 0 基 17）
    expect(calls.map((c) => `${c.file}:${c.line}:${c.column}`).sort()).toEqual([
      "lib/app.ts:7:18",
      "lib/caller.ts:3:15",
    ]);
    // caller.ts:1 import { compute }（mention）
    expect(mentions[0]).toMatchObject({ file: "lib/caller.ts", line: 1, kind: "mention" });
    expect(mentions[0]!.lsp.range.start).toEqual({ line: 0, character: 9 });
    // 引用含 LSP 规范形
    expect(calls[0]!.lsp.uri).toContain("file://");
  }, 30_000);

  test("hover：kind + 定义位置 + 所在行上下文；未找到 → hover:null + reason（LSP 同形态）", () => {
    const r = lspHover(WS, "compute");
    expect(r.ok).toBe(true);
    expect(r.hover).not.toBeNull();
    expect(r.hover!.kind).toBe("fn");
    expect(r.hover!.file).toBe("lib/app.ts");
    expect(r.hover!.line).toBe(1);
    expect(r.hover!.lineText).toContain("export function compute");
    expect(r.hover!.contents[0]).toBe("fn compute");
    expect(r.hover!.contents[1]).toBe("定义：lib/app.ts:1");

    const miss = lspHover(WS, "no_such_symbol");
    expect(miss.ok).toBe(true); // 未知符号的 hover 是 null 不是错误
    expect(miss.hover).toBeNull();
    expect(miss.reason).toContain("未在索引中找到");
  }, 30_000);

  test("未找到定义 → 空 definitions + 诚实 reason；非法符号名 → 拒绝", () => {
    const miss = lspDefinition(WS, "no_such_symbol");
    expect(miss.ok).toBe(true);
    expect(miss.definitions).toHaveLength(0);
    expect(miss.reason).toContain("未在索引中找到");
    const bad = lspDefinition(WS, "a-b!");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("非法符号名");
    const badRef = lspReferences(WS, "../etc");
    expect(badRef.ok).toBe(false);
    expect(badRef.reason).toContain("非法符号名");
  }, 30_000);

  test("HSL 面与 PY 面：parse_widget（hsl）与 scale（py def）同车道可用", () => {
    const hslDef = lspDefinition(WS, "parse_widget");
    expect(hslDef.definitions[0]).toMatchObject({ kind: "fn", file: "hsl/orch.hsl", line: 1 });
    expect(hslDef.definitions[0]!.column).toBe(11); // export fn ▲parse_widget（0 基 10）
    const pyDef = lspDefinition(WS, "scale");
    expect(pyDef.definitions[0]).toMatchObject({ kind: "fn", file: "lib/mod.py", line: 1, column: 5 });
  }, 30_000);
});

// ---- 4. jail 铁律 ----------------------------------------------------------------

describe("lsp · jail 铁律（resolveJailedFile）", () => {
  test("合法相对 / 绝对双形态 + 越界拒绝（../ 逃逸 · 盘外绝对路径 · 空参）", () => {
    const rel = resolveJailedFile(WS, "lib/app.ts");
    expect(rel.ok).toBe(true);
    expect(rel.rel).toBe("lib/app.ts");
    expect(rel.abs).toBe(path.join(WS, "lib/app.ts"));

    const abs = resolveJailedFile(WS, path.join(WS, "lib", "app.ts"));
    expect(abs.ok).toBe(true);
    expect(abs.rel).toBe("lib/app.ts");

    const esc1 = resolveJailedFile(WS, "../outside.ts");
    expect(esc1.ok).toBe(false);
    expect(esc1.reason).toContain("路径越界");
    const esc2 = resolveJailedFile(WS, "/etc/passwd");
    expect(esc2.ok).toBe(false);
    expect(esc2.reason).toContain("路径越界");
    const empty = resolveJailedFile(WS, "");
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain("必填");
  }, 30_000);

  test("断点建议器的 file 入参过 jail：逃逸即拒（ok:false + reason）", () => {
    const esc = suggestBreakpoints(WS, "../../etc/passwd");
    expect(esc.ok).toBe(false);
    expect(esc.reason).toContain("路径越界");
    const escAbs = suggestBreakpoints(WS, "/etc/passwd");
    expect(escAbs.ok).toBe(false);
    expect(escAbs.reason).toContain("路径越界");
    const planEsc = debugPlan(WS, "../outside.ts");
    expect(planEsc.ok).toBe(false);
    expect(planEsc.reason).toContain("路径越界");
  }, 30_000);
});

// ---- 5. 外部 server 车道（spawnLspServer 全生命周期） ------------------------------

/** echo 型假 LSP server 源码（与被测代码同一条分帧真源 —— 行为级对拍）。 */
const FAKE_SERVER = [
  '// 极小 echo 型假 LSP server：复用 org 的分帧层（单一真源 —— 行为级对拍）',
  'import { LspFrameDecoder, encodeLspMessage } from "../lib/lsp.ts";',
  "const decoder = new LspFrameDecoder();",
  "const write = (msg) => { process.stdout.write(encodeLspMessage(msg)); };",
  'process.stdin.on("data", (chunk) => {',
  "  for (const m of decoder.push(chunk)) {",
  '    if (typeof m.method !== "string") continue;',
  "    if (m.method === \"initialize\") {",
  '      write({ jsonrpc: "2.0", id: m.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true }, serverInfo: { name: "fake-lsp", version: "0.0.1" } } });',
  '      write({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "fake-lsp 已就绪" } });',
  '    } else if (m.method === "textDocument/definition") {',
  '      write({ jsonrpc: "2.0", id: m.id, result: [{ uri: "file://' + WS.replace(/\\/g, "/") + '/lib/app.ts", range: { start: { line: 0, character: 16 }, end: { line: 0, character: 24 } } }] });',
  '    } else if (m.method === "unknown-method") {',
  '      write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });',
  '    } else if (m.method === "shutdown") {',
  '      write({ jsonrpc: "2.0", id: m.id, result: null });',
  '    } else if (m.method === "exit") {',
  "      process.exit(0);",
  "    }",
  "  }",
  "});",
  "",
].join("\n");

describe("lsp · 外部 server 车道（spawnLspServer 真协议全生命周期）", () => {
  test("initialize → 请求/错误响应/通知收集 → shutdown → exit 0（echo 型假 server）", async () => {
    const serverPath = path.join(TEST_RUN, "fake-lsp-server.ts");
    fs.writeFileSync(serverPath, FAKE_SERVER);
    const client = await spawnLspServer(process.execPath, [serverPath], {
      rootUri: fileUri(WS),
      initializeTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
    });
    // 生命周期 1：initialize（响应 = server capabilities）
    const caps = await client.initialize();
    expect((caps as { serverInfo?: { name: string } }).serverInfo).toEqual({ name: "fake-lsp", version: "0.0.1" });
    expect(client.serverCapabilities).not.toBeNull();
    // 生命周期 2：initialized 后正常请求（响应按 id 关联）
    const def = await client.request("textDocument/definition", {
      textDocument: { uri: fileUri(path.join(WS, "lib/app.ts")) },
      position: { line: 0, character: 6 },
    });
    expect(def).toEqual([{
      uri: `file://${WS.replace(/\\/g, "/")}/lib/app.ts`,
      range: { start: { line: 0, character: 16 }, end: { line: 0, character: 24 } },
    }]);
    // server→client 通知收集（window/logMessage）
    await new Promise((r) => setTimeout(r, 150));
    expect(client.notifications.length).toBeGreaterThanOrEqual(1);
    expect(client.notifications[0]!.method).toBe("window/logMessage");
    // 错误响应 → 诚实拒绝（code + message 在错误串里）
    await expect(client.request("unknown-method")).rejects.toThrow("-32601");
    // 生命周期 3：shutdown → exit → 干净退出（不被 kill）
    const exit = await client.shutdown();
    expect(exit.exitCode).toBe(0);
    expect(exit.killed).toBe(false);
    // 关停后再发请求 → 诚实拒绝（不静默）
    await expect(client.request("textDocument/definition")).rejects.toThrow("已退出");
  }, 60_000);

  test("不存在的 server 命令 → 诚实 spawn 错误（绝不 crash）", async () => {
    await expect(spawnLspServer("definitely-not-a-server-xyz", [])).rejects.toThrow("spawn 失败");
  }, 30_000);

  test("detectLspServers：7 个已知 server 的探测面（缺席是降级不是失败）", () => {
    const probes = detectLspServers();
    expect(probes).toHaveLength(7);
    expect(probes.map((p) => p.name)).toContain("typescript-language-server");
    expect(probes.map((p) => p.name)).toContain("pylsp");
    for (const p of probes) {
      expect(typeof p.available).toBe("boolean");
      expect(Array.isArray(p.args)).toBe(true);
      if (p.available) expect(typeof p.path).toBe("string");
    }
  }, 30_000);
});

// ---- 6. 断点建议器 ---------------------------------------------------------------

describe("debug · 断点建议器（suggestBreakpoints）", () => {
  test("TS：入口（符号级）+ if 分支 + 循环头 + return 前一行（启发式）· 同行去重 · 闭括号行不选", () => {
    const r = suggestBreakpoints(WS, "lib/app.ts");
    expect(r.ok).toBe(true);
    expect(r.file).toBe("lib/app.ts");
    expect(r.language).toBe("ts");
    expect(r.lines).toBe(12); // 11 行 + 尾空行
    expect(r.suggestions.map((s) => s.line)).toEqual([1, 2, 6, 7]);
    // 入口：符号级置信 + reason
    expect(r.suggestions[0]).toMatchObject({ line: 1, kind: "entry", confidence: "symbol", reason: "函数 compute 入口" });
    // if 分支：启发式 + 最近上方符号归因
    expect(r.suggestions[1]).toMatchObject({ line: 2, kind: "branch", confidence: "heuristic", reason: "compute 内 if 分支" });
    // 循环头
    expect(r.suggestions[2]).toMatchObject({ line: 6, kind: "loop", reason: "compute 内 循环头" });
    // return 前一行：line 9 return → 跳过闭括号行 8 落在 7（total += compute…）
    expect(r.suggestions[3]).toMatchObject({ line: 7, kind: "return", reason: "compute 内 return 前一行（观察返回前状态）" });
    // line 3 的 return 前一行是 2（已建议 if 分支 → 去重吞并）
    expect(r.suggestions.some((s) => s.line === 3)).toBe(false);
    // LIMIT（const）不是入口符号 → 无建议
    expect(r.suggestions.some((s) => s.line === 11)).toBe(false);
  }, 30_000);

  test("HSL：if/else 双分支 + for 循环 + return 前一行", () => {
    const r = suggestBreakpoints(WS, "hsl/orch.hsl");
    expect(r.language).toBe("hsl");
    expect(r.suggestions.map((s) => s.line)).toEqual([1, 3, 5, 8, 9]);
    expect(r.suggestions[0]).toMatchObject({ kind: "entry", confidence: "symbol", reason: "函数 parse_widget 入口" });
    expect(r.suggestions[1]).toMatchObject({ line: 3, kind: "branch", reason: "parse_widget 内 if 分支" });
    expect(r.suggestions[2]).toMatchObject({ line: 5, kind: "branch", reason: "parse_widget 内 else 分支" }); // "} else {" 形
    expect(r.suggestions[3]).toMatchObject({ line: 8, kind: "loop", reason: "parse_widget 内 循环头" });
    expect(r.suggestions[4]).toMatchObject({ line: 9, kind: "return", reason: "parse_widget 内 return 前一行（观察返回前状态）" });
  }, 30_000);

  test("PY：def 入口 + if/else 分支（return 前一行被同行去重吞并）", () => {
    const r = suggestBreakpoints(WS, "lib/mod.py");
    expect(r.language).toBe("py");
    expect(r.suggestions.map((s) => s.line)).toEqual([1, 2, 4]);
    expect(r.suggestions[0]).toMatchObject({ kind: "entry", reason: "函数 scale 入口" });
    expect(r.suggestions[1]).toMatchObject({ line: 2, kind: "branch", reason: "scale 内 if 分支" });
    expect(r.suggestions[2]).toMatchObject({ line: 4, kind: "branch", reason: "scale 内 else 分支" });
  }, 30_000);

  test("非支持扩展名 → 诚实空建议 + reason（绝不臆造）", () => {
    fs.writeFileSync(path.join(WS, "notes.md"), "# notes\nif whatever\n");
    const r = suggestBreakpoints(WS, "notes.md");
    expect(r.ok).toBe(true);
    expect(r.suggestions).toHaveLength(0);
    expect(r.reason).toContain("非支持扩展名");
  }, 30_000);

  test("文件不可读 → 诚实 ok:false + reason", () => {
    const r = suggestBreakpoints(WS, "lib/ghost.ts");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("文件不可读");
  }, 30_000);

  test("max 帽：钳制 + truncated 诚实标注", () => {
    const r = suggestBreakpoints(WS, "lib/app.ts", { max: 2 });
    expect(r.suggestions).toHaveLength(2);
    expect(r.truncated).toBe(true);
  }, 30_000);
});

// ---- 7. DAP 构造器 ----------------------------------------------------------------

describe("debug · DAP 消息构造器（字段忠实 + 与 LSP 分帧层共用）", () => {
  test("initialize：adapterID/clientID/locale/linesStartAt1/columnsStartAt1/pathFormat", () => {
    const init = makeDapInitialize(1, { adapterID: "node" });
    expect(init).toEqual({
      seq: 1,
      type: "request",
      command: "initialize",
      arguments: {
        adapterID: "node",
        clientID: "org-debug-client",
        clientName: "ORG Debug Plan (v0.5.17)",
        locale: "en",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: false,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
      },
    });
  }, 30_000);

  test("setBreakpoints：source.path + lines + breakpoints[{line}] 双字段（规范 + 历史兼容）", () => {
    const sbp = makeDapSetBreakpoints(2, "/ws/src/app.ts", [3, 10, 42]);
    expect(sbp.seq).toBe(2);
    expect(sbp.type).toBe("request");
    expect(sbp.command).toBe("setBreakpoints");
    expect(sbp.arguments!.source).toEqual({ path: "/ws/src/app.ts" });
    expect(sbp.arguments!.lines).toEqual([3, 10, 42]);
    expect(sbp.arguments!.breakpoints).toEqual([{ line: 3 }, { line: 10 }, { line: 42 }]);
  }, 30_000);

  test("stackTrace：threadId/startFrame/levels 分页字段；threads：空 arguments", () => {
    const st = makeDapStackTrace(3, { levels: 5 });
    expect(st.arguments).toEqual({ threadId: 1, startFrame: 0, levels: 5 });
    const st2 = makeDapStackTrace(9, { threadId: 7, startFrame: 2, levels: 10 });
    expect(st2.arguments).toEqual({ threadId: 7, startFrame: 2, levels: 10 });
    const th = makeDapThreads(4);
    expect(th).toEqual({ seq: 4, type: "request", command: "threads", arguments: {} });
  }, 30_000);

  test("DAP 消息复用 LSP 分帧往返（Content-Length 层共用，DAP 体无 jsonrpc 字段照收）", () => {
    const sbp = makeDapSetBreakpoints(2, "/ws/x.ts", [1]);
    const decoder = new LspFrameDecoder();
    const back = decoder.push(encodeLspMessage(sbp));
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(sbp);
    expect((back[0] as { jsonrpc?: string }).jsonrpc).toBeUndefined(); // DAP 消息无 jsonrpc 字段
  }, 30_000);

  test("dapSelfTest：全部通过", () => {
    const r = dapSelfTest();
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(r.total);
    expect(r.total).toBeGreaterThanOrEqual(7);
  }, 30_000);
});

// ---- 8. 调试计划 -------------------------------------------------------------------

describe("debug · 调试计划（debugPlan）", () => {
  test("步骤编号与顺序（attach → 入口 → 分支 → 循环 → return → 栈 → 收尾）+ DAP 消息序列协议就绪", () => {
    const r = debugPlan(WS, "lib/app.ts");
    expect(r.ok).toBe(true);
    expect(r.file).toBe("lib/app.ts");
    expect(r.suggestions).toBe(4);
    expect(r.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.steps[0]!.title).toContain("attach");
    expect(r.steps[1]!.title).toContain("入口断点");
    expect(r.steps[1]!.breakpoints).toHaveLength(1);
    expect(r.steps[2]!.title).toContain("分支断点");
    expect(r.steps[3]!.title).toContain("循环断点");
    expect(r.steps[4]!.title).toContain("return 前断点");
    expect(r.steps[5]!.title).toContain("调用栈");
    expect(r.steps[6]!.title).toContain("disconnect");
    // DAP 消息序列：initialize → setBreakpoints（全部建议行）→ threads → stackTrace
    expect(r.dapMessages.map((m) => m.command)).toEqual(["initialize", "setBreakpoints", "threads", "stackTrace"]);
    expect(r.dapMessages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(r.dapMessages[1]!.arguments!.lines).toEqual([1, 2, 6, 7]);
    expect(r.dapMessages[1]!.arguments!.source).toEqual({ path: path.join(WS, "lib/app.ts") });
    // 步骤说明里诚实标注 attach 是路线图
    expect(r.steps[0]!.detail).toContain("路线图");
  }, 30_000);

  test("protocolSelfTest：全部通过（分帧/粘包/半包/CJK/构造器/坏帧）", () => {
    const r = protocolSelfTest();
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(r.total);
    expect(r.total).toBeGreaterThanOrEqual(8);
    expect(r.checks.map((c) => c.name)).toContain("CJK 体字节精确");
  }, 30_000);
});

// ---- 9. CLI 冒烟（runOrg 真子进程） ------------------------------------------------

describe("CLI 冒烟（org lsp / org debug）", () => {
  test("org lsp definition/references/hover <名>：内置车道三动作", () => {
    const def = runOrg(["lsp", "definition", "compute", "--workspace", WS]);
    expect(def.ok).toBe(true);
    expect(def.stdout).toContain("compute");
    expect(def.stdout).toContain("lib/app.ts");
    expect(def.stdout).toContain("内置符号索引车道");
    expect(def.stdout).toContain("file://");

    const refs = runOrg(["lsp", "references", "compute", "--workspace", WS]);
    expect(refs.ok).toBe(true);
    expect(refs.stdout).toContain("call 2");
    expect(refs.stdout).toContain("lib/caller.ts");

    const hover = runOrg(["lsp", "hover", "compute", "--workspace", WS]);
    expect(hover.ok).toBe(true);
    expect(hover.stdout).toContain("fn · lib/app.ts:1");
  }, 60_000);

  test("v0.5.17.1 --workspace= 等号形态：flag 前置 + positional 后置不被吞（控制台 param 追加车道）", () => {
    // 等号形态：rawPositionals 跳过（带 = 不吃值），parseArgs 解析 workspace
    const eq = runOrg(["lsp", "definition", `--workspace=${WS}`, "compute"]);
    expect(eq.ok).toBe(true);
    expect(eq.stdout).toContain("compute");
    expect(eq.stdout).toContain("lib/app.ts");
    // 语义等价：与分离形态同输出形状
    const sep = runOrg(["lsp", "definition", "compute", "--workspace", WS]);
    expect(sep.ok).toBe(true);
    expect(sep.stdout).toContain("lib/app.ts");
    // debug suggest 同形态（file positional 在 flag 之后）
    const sug = runOrg(["debug", "suggest", `--workspace=${WS}`, "lib/app.ts"]);
    expect(sug.ok).toBe(true);
    expect(sug.stdout).toContain("建议断点");
  }, 60_000);

  test("org lsp protocol / org debug dap：自检退出码 0 + 通过计数", () => {
    const proto = runOrg(["lsp", "protocol"]);
    expect(proto.ok).toBe(true);
    expect(proto.stdout).toContain("协议层自检");
    expect(proto.stdout).toMatch(/\d+\/\d+ 通过/);
    const dap = runOrg(["debug", "dap"]);
    expect(dap.ok).toBe(true);
    expect(dap.stdout).toContain("DAP 构造器自检");
  }, 60_000);

  test("org lsp servers：探测输出（缺席退出 1 是诚实降级，非失败）", () => {
    const r = runOrg(["lsp", "servers"]);
    expect(r.stdout).toContain("外部 LSP server 探测");
    expect(r.stdout).toContain("typescript-language-server");
    expect([0, 1]).toContain(r.exitCode);
  }, 60_000);

  test("org debug suggest/plan <file>：断点建议 + 调试计划输出", () => {
    const sug = runOrg(["debug", "suggest", "lib/app.ts", "--workspace", WS]);
    expect(sug.ok).toBe(true);
    expect(sug.stdout).toContain("函数 compute 入口");
    expect(sug.stdout).toContain("if 分支");
    expect(sug.stdout).toContain("循环头");
    expect(sug.stdout).toContain("return 前一行");

    const plan = runOrg(["debug", "plan", "lib/app.ts", "--workspace", WS]);
    expect(plan.ok).toBe(true);
    expect(plan.stdout).toContain("调试计划");
    expect(plan.stdout).toContain("setBreakpoints");
    expect(plan.stdout).toContain("路线图");
  }, 60_000);

  test("org breakpoints（debug 别名）+ 用法面退出码 2", () => {
    const alias = runOrg(["breakpoints", "suggest", "hsl/orch.hsl", "--workspace", WS]);
    expect(alias.ok).toBe(true);
    expect(alias.stdout).toContain("函数 parse_widget 入口");
    expect(alias.stdout).toContain("else 分支");

    const usage = runOrg(["lsp"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("用法");
    const usageDbg = runOrg(["debug"]);
    expect(usageDbg.exitCode).toBe(2);
  }, 60_000);

  test("CLI 冒烟：jail 越界拒绝（退出码 1 + 越界文案）", () => {
    const esc = runOrg(["debug", "suggest", "../../etc/passwd", "--workspace", WS]);
    expect(esc.ok).toBe(false);
    expect(esc.stderr).toContain("路径越界");
  }, 60_000);
});

// ---- 10. Web /api/govex/lsp + /api/govex/debug 端点 -------------------------------

describe("Web 🛡 LSP/DAP 端点（/api/govex/lsp · /api/govex/debug）", () => {
  test("动作矩阵 + 越界拒绝 + 参数校验 + GUI 单页要素", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    // 播种：demo-ws 模板（带 registry → readWorkspaceOf 不落 dist/demo 快照）+ LSP 语料
    const webWs = path.join(TEST_RUN, "lsp-web-ws");
    fs.cpSync(path.join(process.cwd(), "demo-ws"), webWs, { recursive: true });
    TMP.push(webWs);
    seedWorkspace(webWs);

    const srv = startWebServer({ workspace: webWs, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = async (u: string): Promise<Record<string, unknown>> =>
        (await (await fetch(base + u)).json()) as Record<string, unknown>;

      // definition / references / hover（内置车道）
      const def = await get(`/api/govex/lsp?action=definition&name=compute`);
      expect(def.ok).toBe(true);
      expect(def.lane).toBe("builtin");
      const defs = def.definitions as Array<{ file: string; line: number; column: number; lsp: { range: { start: { line: number } } } }>;
      expect(defs[0]!.file).toBe("lib/app.ts");
      expect(defs[0]!.line).toBe(1);
      expect(defs[0]!.column).toBe(17);
      expect(defs[0]!.lsp.range.start.line).toBe(0); // LSP 0 基

      const refs = await get(`/api/govex/lsp?action=references&name=compute`);
      expect(refs.ok).toBe(true);
      expect((refs.refs as unknown[]).length).toBe(3);
      expect(refs.definitions).toBe(1);

      const hover = await get(`/api/govex/lsp?action=hover&name=compute`);
      expect(hover.ok).toBe(true);
      expect((hover.hover as { kind: string }).kind).toBe("fn");

      // servers 探测 + 双自检
      const servers = await get(`/api/govex/lsp?action=servers`);
      expect(servers.ok).toBe(true);
      expect((servers.servers as unknown[]).length).toBe(7);
      const proto = await get(`/api/govex/lsp?action=protocol-selftest`);
      expect(proto.ok).toBe(true);
      expect(proto.passed).toBe(proto.total);
      const dap = await get(`/api/govex/debug?action=dap-selftest`);
      expect(dap.ok).toBe(true);
      expect(dap.passed).toBe(dap.total);

      // 断点建议 + 调试计划
      const sug = await get(`/api/govex/debug?action=suggest&file=lib/app.ts`);
      expect(sug.ok).toBe(true);
      expect(sug.language).toBe("ts");
      expect((sug.suggestions as Array<{ line: number }>).map((s) => s.line)).toEqual([1, 2, 6, 7]);
      const plan = await get(`/api/govex/debug?action=plan&file=lib/app.ts`);
      expect(plan.ok).toBe(true);
      expect((plan.steps as unknown[]).length).toBe(7);
      const dapMsgs = plan.dap_messages as Array<{ command: string; seq: number }>;
      expect(dapMsgs.map((m) => m.command)).toEqual(["initialize", "setBreakpoints", "threads", "stackTrace"]);
      expect(String(plan.roadmap)).toContain("路线图");

      // 越界拒绝（jail）+ 参数校验
      const esc = await get(`/api/govex/debug?action=suggest&file=../../etc/passwd`);
      expect(esc.ok).toBe(false);
      expect(String(esc.error)).toContain("越界");
      const escPlan = await get(`/api/govex/debug?action=plan&file=/etc/passwd`);
      expect(escPlan.ok).toBe(false);
      const noName = await get(`/api/govex/lsp?action=definition`);
      expect(noName.ok).toBe(false);
      expect(String(noName.error)).toContain("name 必填");
      const badAction = await get(`/api/govex/lsp?action=whatever`);
      expect(badAction.ok).toBe(false);

      // GUI 单页含 LSP/DAP 区块要素 + 内联脚本可解析
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('id="gxTabLsp"');
      expect(html).toContain('id="gxSecLsp"');
      expect(html).toContain('"/api/govex/lsp?action=definition');
      expect(html).toContain('"/api/govex/debug?action=suggest');
      const m = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(m).not.toBeNull();
      expect(() => new Function(m![1]!)).not.toThrow();
    } finally {
      srv.stop();
    }
  }, 60_000);
});

// ---- 12. 工具环 e2e（native 块动态 import lib/lsp.ts + lib/debug.ts） ------------

describe("工具环 LSP/DAP 六工具 e2e（scripted 剧本 · 与 wiring2 同款驱动）", () => {
  const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");
  const TOOLS_WS = path.join(TEST_RUN, "lsp-tools-ws");

  beforeAll(() => {
    // demo-ws 模板（registry → direct.hsl 可跑）+ LSP 语料播种
    fs.rmSync(TOOLS_WS, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), TOOLS_WS, { recursive: true });
    seedWorkspace(TOOLS_WS);
  });

  afterAll(() => {
    // best-effort：Windows 句柄滞后不炸
    try { fs.rmSync(TOOLS_WS, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
  });

  function makeOut(name: string): string {
    const dir = path.join(TEST_RUN, "out-lsp-tools", name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeFixture(tracks: Record<string, string[]>): string {
    const file = path.join(TEST_RUN, "lsp-tools-fixture.json");
    fs.writeFileSync(file, JSON.stringify({ tracks }, null, 2));
    return file;
  }

  /** 直连一轮（只读工具环 —— 六工具全在写门例外清单，ORG_TOOLS=1 即可用）。 */
  function askOnce(fixture: string, out: string) {
    return runDhv([
      "run", DIRECT,
      "--workspace", TOOLS_WS,
      "--task", "(direct) LSP/DAP 工具环接线测试",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "lsp-tools", ORG_ASK_QUESTION: "接线测试",
      ORG_TOOLS: "1",
    });
  }

  /** 从 events 里提取全部 tool_result 的 data.detail（result_summary 观测面）。 */
  function toolResults(out: string): string[] {
    return eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
  }

  test("六工具 result_summary 可观测（defs/refs/hover/servers/断点/计划 —— native 块与 lib 同源）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"lsp_definition","args":{"name":"compute"}}</tool>',
        '<tool>{"name":"lsp_references","args":{"name":"compute"}}</tool>',
        '<tool>{"name":"lsp_hover","args":{"name":"compute"}}</tool>',
        '<tool>{"name":"lsp_servers","args":{}}</tool>',
        '<tool>{"name":"debug_breakpoints","args":{"file":"lib/app.ts"}}</tool>',
        '<tool>{"name":"debug_plan","args":{"file":"lib/app.ts"}}</tool>',
        "最终答案：六工具全部可观测。",
      ],
    });
    const out = makeOut("six-tools");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(6);
    expect(tr[0]).toContain("lsp_definition ok defs=1 top=lib/app.ts:1");
    expect(tr[1]).toContain("lsp_references ok refs=3 calls=2 defs=1");
    expect(tr[2]).toContain("lsp_hover ok fn compute lib/app.ts:1");
    expect(tr[3]).toMatch(/lsp_servers ok 可用 \d+\/7/);
    expect(tr[4]).toContain("debug_breakpoints ok 建议4处 ts top=1(entry)");
    expect(tr[5]).toContain("debug_plan ok 4断点 · 7步 · DAP消息4条");
  }, 120_000);

  test("工具环 jail 铁律：debug_breakpoints 越界 file → error 摘要 + 越界文案（拒绝先于读盘）", () => {
    const fixture = makeFixture({
      "direct:notice-parser": [
        '<tool>{"name":"debug_breakpoints","args":{"file":"../../etc/passwd"}}</tool>',
        "最终答案：越界被拒。",
      ],
    });
    const out = makeOut("jail");
    const r = askOnce(fixture, out);
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("debug_breakpoints error");
    expect(tr[0]).toContain("路径越界");
  }, 120_000);
});
