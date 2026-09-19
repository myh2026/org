// ============================================================================
// tests/mcp.test.ts — MCP 客户端桥（v0.5.19 · capabilities #122 / C12）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/mcp.ts 的行为级断言 + CLI/工具环/Web 三端冒烟；
// tests/remote.test.ts 同构风格 —— 无真第三方 MCP server 的价值在**协议层
// 真实可测**：tests/fixtures/mcp-fixture-server.ts 是真 stdio JSON-RPC
// 对话的假 server（真 spawn 真握手真调用真分页真降级））：
//   1. 协议层纯函数：换行分帧（编码/解码/跨 chunk/坏行拒收/内嵌换行拒）·
//      消息构造器形状 · mcpSelfTest 全绿；
//   2. 档案层：缺席=诚实缺席非错误 / 坏 JSON / 非数组 / 缺 name / 缺
//      command / args 非字符串数组 / 秘密键字面值拒绝 + $env: 引用放行 /
//      name 重复 / disabled 语义 / save 全量校验拒绝半档 / findMcpServer；
//   3. env 引用解析：$env: 取父环境值 / 引用缺席诚实拒绝；
//   4. 真会话（spawn fixture server）：initialize 握手（serverInfo/能力
//      三面/版本协商记录）· tools/list 四工具 · tools/call echo/add/fail
//      （isError 语义）/ 分页 nextCursor 跟进 · resources/list+read ·
//      prompts/list · server→client 请求自动 -32601 + 通知收集 · 分帧器
//      拒收人话日志行不炸 · 早夭诚实诊断（code=70 + stderr 尾巴）·
//      请求超时（slow 工具 + 短超时）· 能力缺席（FAKE_MCP_CAPS 单面）→
//      unsupported 诚实返回；
//   5. 高层操作门序：call 的 server-not-found 拒绝先于 spawn（PATH 置空
//      宇宙仍拒绝）；no-config 指引；invalid-args 拒绝；
//   6. CLI 冒烟（runOrg 真子进程）：self-test / servers（缺席→指引）/
//      tools（真 spawn fixture）/ call（add 2+3=5 真算）；
//   7. Web /api/govex/mcp 五动作（servers/tools/resources/read/prompts +
//      selftest）+ GUI 🔌 区块要素；
//   8. 工具环 e2e（scripted 剧本驱动 direct.hsl —— wiring2 同款）：
//      mcp_servers（只读）/ mcp_tools（真 spawn）/ mcp_call_tool
//      （process_spawn 门放行后档案门仍拒绝 —— 双层治理）。
// 环境自适应：fixture server 用 bun 宿主（沙箱/CI 同在）；FAKE_MCP_* 变量
// 快照/恢复（env-hygiene 哲学 —— 不留环境侧写）。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encodeMcpMessage, decodeMcpMessages, McpLineDecoder,
  makeInitializeParams, makeToolsCallParams, makeMcpError, JSONRPC_ERROR_CODES, MCP_PROTOCOL_VERSION,
  validateMcpServerEntry, loadMcpServers, saveMcpServers, findMcpServer,
  resolveMcpEnv, probeMcpRuntimes, MCP_SERVERS_FILE, MCP_SERVERS_GUIDANCE,
  spawnMcpServer, normalizeContent, mcpSelfTest,
  mcpListTools, mcpCallTool, mcpListResources, mcpReadResource, mcpListPrompts,
  type McpServerEntry,
} from "../lib/mcp.ts";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";
import { startWebServer } from "../web/entry.ts";
import { snapshotEnv, clearEnv, restoreEnv } from "./env-hygiene";

const FIXTURE_SERVER = path.join(process.cwd(), "tests/fixtures/mcp-fixture-server.ts");

/** fixture server 档案条目（bun 宿主 + FAKE_MCP_* 透传面）。 */
function fixtureEntry(name: string, env?: Record<string, string>): McpServerEntry {
  return { name, command: "bun", args: [FIXTURE_SERVER], ...(env ? { env } : {}) };
}

function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-mcp-${tag}-`));
}

/** FAKE_MCP_* 快照/恢复（测试不留环境侧写）。 */
const FAKE_KEYS = ["FAKE_MCP_CAPS", "FAKE_MCP_VERSION", "FAKE_MCP_PAGINATE", "FAKE_MCP_SLOW_MS", "FAKE_MCP_GARBAGE_N", "FAKE_MCP_DIE_AFTER", "FAKE_MCP_PROBE_REQ", "ORG_MCP_TEST_SECRET"];
let fakeSnap: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of FAKE_KEYS) fakeSnap[k] = process.env[k];
});
afterEach(() => {
  for (const k of FAKE_KEYS) {
    if (fakeSnap[k] === undefined) delete process.env[k];
    else process.env[k] = fakeSnap[k];
  }
});

/** PATH 置空宇宙（档案门序断言用 —— spawn 绝不发生）。 */
function withEmptyPath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** spawn 一个 fixture 会话（env 由 FAKE_MCP_* 控制行为）。 */
async function withFixture(opts: { env?: Record<string, string>; requestTimeoutMs?: number }, fn: (c: ReturnType<typeof spawnMcpServer>) => Promise<void>): Promise<void> {
  const client = spawnMcpServer("bun", [FIXTURE_SERVER], { ...(opts.env ? { env: opts.env } : {}), ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}) });
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

// ---- 1. 协议层纯函数 ----------------------------------------------------------

describe("MCP：换行分帧与构造器（纯函数）", () => {
  test("编码单行 JSON + \\n 结尾", () => {
    expect(encodeMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });

  test("含换行字符串序列化为单行（转义后无裸换行 —— 协议铁律的构造性保证）", () => {
    const s = encodeMcpMessage({ method: "x", params: { a: "b\nc" } });
    const lines = s.split("\n");
    expect(lines.length).toBe(2); // 单行 JSON + 行尾终止符
    expect(lines[0]).toContain("\\n"); // 字符串里的换号被转义成 \\n 序列
    expect(lines[1]).toBe("");
  });

  test("解码：好行收 / 坏 JSON 拒收计数 / 非对象拒收 / 空行跳过", () => {
    const r = decodeMcpMessages('{"id":1,"result":{}}\nnot-json\n[1,2]\n\n{"method":"n"}\n');
    expect(r.messages.length).toBe(2);
    expect(r.rejected).toBe(2);
    expect(r.messages[0].id).toBe(1);
    expect(r.messages[1].method).toBe("n");
  });

  test("跨 chunk 半行缓冲（TCP 分片模拟）", () => {
    const d = new McpLineDecoder();
    expect(d.push('{"jsonrpc":"2.0","id":7,').length).toBe(0);
    const rest = d.push('"result":42}\n');
    expect(rest.length).toBe(1);
    expect(rest[0].result).toBe(42);
  });

  test("initialize / tools-call 构造器形状", () => {
    const init = makeInitializeParams();
    expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect((init.clientInfo as { name: string }).name).toBeString();
    const call = makeToolsCallParams("echo", { a: 1 });
    expect(call.name).toBe("echo");
    expect((call as { arguments: { a: number } }).arguments.a).toBe(1);
    const err = makeMcpError(5, JSONRPC_ERROR_CODES.METHOD_NOT_FOUND, "nope");
    expect(err.error?.code).toBe(-32601);
  });

  test("内容归一：text 拼接 / image-resource 计数 / 16KB 帽 / 非数组零炸", () => {
    const c = normalizeContent([
      { type: "text", text: "hello" },
      { type: "image", data: "x", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///x" } },
      { type: "text", text: "world" },
    ]);
    expect(c.text).toBe("hello\nworld");
    expect(c.textBlocks).toBe(2);
    expect(c.imageBlocks).toBe(1);
    expect(c.resourceBlocks).toBe(1);
    expect(c.truncated).toBe(false);
    const big = normalizeContent([{ type: "text", text: "x".repeat(40 * 1024) }]);
    expect(big.truncated).toBe(true);
    expect(big.text).toContain("MCP 内容已截断");
    expect(normalizeContent(null).text).toBe("");
    expect(normalizeContent("nope").textBlocks).toBe(0);
  });

  test("mcpSelfTest 全绿（协议层无 server 也能锁形状）", () => {
    const r = mcpSelfTest();
    for (const c of r.checks) {
      if (!c.ok) console.error(`  ✗ ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    }
    expect(r.passed).toBe(r.total);
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(18);
  });
});

// ---- 2. 档案层 ----------------------------------------------------------------

describe("MCP：档案层（mcp-servers.json）", () => {
  test("缺席 = 诚实缺席非错误 + 创建指引", () => {
    const ws = tmpWs("absent");
    try {
      const f = loadMcpServers(ws);
      expect(f.ok).toBe(false);
      expect(f.kind).toBe("absent");
      expect(f.entries).toBeEmpty();
      expect(f.reason).toContain(MCP_SERVERS_FILE);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("坏 JSON / 顶层非数组拒绝", () => {
    const ws = tmpWs("badjson");
    try {
      fs.writeFileSync(path.join(ws, MCP_SERVERS_FILE), "{oops");
      expect(loadMcpServers(ws).kind).toBe("invalid-json");
      fs.writeFileSync(path.join(ws, MCP_SERVERS_FILE), '{"a":1}');
      expect(loadMcpServers(ws).kind).toBe("not-array");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("逐条校验：缺 name / 缺 command / args 非字符串数组 —— 坏条目过滤 + 过检条目照常可用", () => {
    const ws = tmpWs("mixed");
    try {
      fs.writeFileSync(path.join(ws, MCP_SERVERS_FILE), JSON.stringify([
        { command: "bun" },
        { name: "good", command: "bun", args: ["s.ts"] },
        { name: "noargs", command: "bun", args: [1] },
      ]));
      const f = loadMcpServers(ws);
      expect(f.kind).toBe("invalid-entries");
      expect(f.entries.length).toBe(1);
      expect(f.entries[0].name).toBe("good");
      expect(f.validations.length).toBe(3);
      expect(f.validations.filter((v) => !v.ok).length).toBe(2);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("秘密策略：API_KEY 字面值拒绝（键名启发）· $env: 引用放行 · 非秘密键字面值放行", () => {
    expect(validateMcpServerEntry({ name: "s", command: "bun", env: { API_KEY: "sk-lit" } }).ok).toBe(false);
    expect(validateMcpServerEntry({ name: "s", command: "bun", env: { API_KEY: "$env:MY_KEY" } }).ok).toBe(true);
    expect(validateMcpServerEntry({ name: "s", command: "bun", env: { MY_SECRET_TOKEN: "x" } }).ok).toBe(false);
    expect(validateMcpServerEntry({ name: "s", command: "bun", env: { LOG_LEVEL: "debug" } }).ok).toBe(true);
  });

  test("name 重复拒绝（load 逐条上浮 + save 拒绝）", () => {
    const ws = tmpWs("dup");
    try {
      fs.writeFileSync(path.join(ws, MCP_SERVERS_FILE), JSON.stringify([
        { name: "a", command: "bun" },
        { name: "a", command: "node" },
      ]));
      const f = loadMcpServers(ws);
      expect(f.kind).toBe("invalid-entries");
      expect(f.entries.length).toBe(1); // 第二个重复被滤
      const s = saveMcpServers(ws, [{ name: "x", command: "bun" }, { name: "x", command: "node" }]);
      expect(s.ok).toBe(false);
      expect(s.reason).toContain("重复");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("save 全量校验拒绝半档（盘上旧文件不动）", () => {
    const ws = tmpWs("save");
    try {
      const s1 = saveMcpServers(ws, [fixtureEntry("a")]);
      expect(s1.ok).toBe(true);
      const before = fs.readFileSync(path.join(ws, MCP_SERVERS_FILE), "utf-8");
      const s2 = saveMcpServers(ws, [fixtureEntry("b"), { name: "bad" } as McpServerEntry]);
      expect(s2.ok).toBe(false);
      expect(fs.readFileSync(path.join(ws, MCP_SERVERS_FILE), "utf-8")).toBe(before); // 不被覆盖
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("findMcpServer 三态：在档 / 停用 / 不在档", () => {
    const f = loadMcpServers(".");
    void f;
    const ws = tmpWs("find");
    try {
      saveMcpServers(ws, [fixtureEntry("on"), { ...fixtureEntry("off"), disabled: true }]);
      const g = loadMcpServers(ws);
      expect(findMcpServer(g, "on")).toEqual({ entry: g.entries[0] });
      expect("disabled" in findMcpServer(g, "off")).toBe(true);
      expect("notFound" in findMcpServer(g, "ghost")).toBe(true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("$env: 引用解析：取父环境值 / 引用缺席诚实拒绝", () => {
    process.env.ORG_MCP_TEST_SECRET = "v1";
    const r1 = resolveMcpEnv({ name: "s", command: "bun", env: { API_KEY: "$env:ORG_MCP_TEST_SECRET", LOG: "info" } });
    expect(r1.ok).toBe(true);
    expect(r1.env.API_KEY).toBe("v1");
    expect(r1.env.LOG).toBe("info");
    const r2 = resolveMcpEnv({ name: "s", command: "bun", env: { API_KEY: "$env:ORG_MCP_TEST_MISSING" } });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("父进程环境无此变量");
  });

  test("probeMcpRuntimes：bun 宿主在场（沙箱与 CI 同）+ 形态面", () => {
    const probes = probeMcpRuntimes();
    expect(probes.length).toBeGreaterThanOrEqual(6);
    const bun = probes.find((p) => p.name === "bun");
    expect(bun?.available).toBe(true); // bun 跑测试 —— 必然在场
    expect(typeof bun?.path).toBe("string");
  });
});

// ---- 4. 真会话（spawn fixture server —— 真握手真调用）-------------------------

describe("MCP：真会话（fixture server 实弹）", () => {
  test("initialize 握手：serverInfo + 能力三面 + 版本协商记录 + 通知收集", async () => {
    await withFixture({}, async (client) => {
      const info = await client.initialize();
      expect(info.serverName).toBe("fixture-mcp");
      expect(info.serverVersion).toBe("1.4.2");
      expect(info.capabilities.tools).toBe(true);
      expect(info.capabilities.resources).toBe(true);
      expect(info.capabilities.prompts).toBe(true);
      expect(info.protocolVersion).toBe(MCP_PROTOCOL_VERSION); // fixture 回显客户端版本
      expect(info.instructions).toContain("fixture");
      // fixture 在 initialize 后发通知 + （可选）server 请求
      await Bun.sleep(150);
      expect(client.notifications.some((n) => n.method === "notifications/message")).toBe(true);
      expect(client.serverInfo).not.toBeNull();
    });
  }, 30_000);

  test("版本协商：server 回旧版本 → 记录不挑剔", async () => {
    process.env.FAKE_MCP_VERSION = "2024-11-05";
    await withFixture({}, async (client) => {
      const info = await client.initialize();
      expect(info.protocolVersion).toBe("2024-11-05");
    });
  }, 30_000);

  test("server→client 请求：sampling 自动 -32601 响应 + 收集观测（客户端不炸）", async () => {
    process.env.FAKE_MCP_PROBE_REQ = "1";
    await withFixture({}, async (client) => {
      await client.initialize();
      await Bun.sleep(200);
      expect(client.serverRequests.some((r) => r.method === "sampling/createMessage")).toBe(true);
      // ping 车道仍健康（自动响应没有卡死会话）
      const pong = await client.request("ping");
      expect(pong).toEqual({});
    });
  }, 30_000);

  test("tools/list 四工具（含 inputSchema）+ tools/call echo/add", async () => {
    await withFixture({}, async (client) => {
      await client.initialize();
      const res = (await client.request("tools/list", {})) as { tools: Array<{ name: string }> };
      expect(res.tools.map((t) => t.name).sort()).toEqual(["add", "echo", "fail", "slow"]);
      const echo = (await client.request("tools/call", makeToolsCallParams("echo", { message: "你好 org" }))) as { content: Array<{ type: string; text: string }> };
      expect(echo.content[0].text).toBe("你好 org");
      const add = (await client.request("tools/call", makeToolsCallParams("add", { a: 2, b: 3 }))) as { content: Array<{ text: string }>; structuredContent: { result: number } };
      expect(add.content[0].text).toBe("5");
      expect(add.structuredContent.result).toBe(5);
    });
  }, 30_000);

  test("tools/call fail 工具：isError 语义（协议层成功、工具层失败）", async () => {
    await withFixture({}, async (client) => {
      await client.initialize();
      const r = (await client.request("tools/call", makeToolsCallParams("fail", {}))) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("isError");
    });
  }, 30_000);

  test("分页：nextCursor 跟进（每页 1 个 → 4 页收齐）", async () => {
    process.env.FAKE_MCP_PAGINATE = "1";
    await withFixture({}, async (client) => {
      await client.initialize();
      const names: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = (await client.request("tools/list", cursor ? { cursor } : {})) as { tools: Array<{ name: string }>; nextCursor?: string };
        names.push(...res.tools.map((t) => t.name));
        cursor = res.nextCursor;
        pages++;
      } while (cursor !== undefined && pages < 10);
      expect(pages).toBe(5); // 4 页工具 + 1 页空收尾
      expect(names.sort()).toEqual(["add", "echo", "fail", "slow"]);
    });
  }, 30_000);

  test("能力缺席：FAKE_MCP_CAPS=tools → resources/prompts 诚实 unsupported", async () => {
    process.env.FAKE_MCP_CAPS = "tools";
    await withFixture({ env: { FAKE_MCP_CAPS: "tools" } }, async (client) => {
      const info = await client.initialize();
      expect(info.capabilities.tools).toBe(true);
      expect(info.capabilities.resources).toBe(false);
      expect(info.capabilities.prompts).toBe(false);
      let refused = false;
      try {
        await client.request("resources/list", {});
      } catch (e) {
        refused = true;
        expect((e as Error).message).toContain("-32601");
      }
      expect(refused).toBe(true);
    });
  }, 30_000);

  test("分帧器：server 启动人话日志行拒收不炸（会话照常）", async () => {
    await withFixture({ env: { FAKE_MCP_GARBAGE_N: "3" } }, async (client) => {
      const info = await client.initialize(); // 人话行先到 —— 分帧器拒收，握手照常
      expect(info.serverName).toBe("fixture-mcp");
      await Bun.sleep(100);
      expect(client.rejectedLines()).toBe(3);
      const res = (await client.request("tools/list", {})) as { tools: Array<{ name: string }> };
      expect(res.tools.length).toBe(4);
    });
  }, 30_000);

  test("早夭诊断：DIE_AFTER 后请求 → 诚实拒绝 + stderr 尾巴", async () => {
    process.env.FAKE_MCP_DIE_AFTER = "1"; // initialize 响应后即退
    await withFixture({ env: { FAKE_MCP_DIE_AFTER: "1" } }, async (client) => {
      await client.initialize();
      await Bun.sleep(200);
      expect(client.exited).toBe(true);
      expect(client.exitCode).toBe(70);
      let refused = false;
      try {
        await client.request("tools/list", {});
      } catch (e) {
        refused = true;
        expect((e as Error).message).toContain("已退出");
      }
      expect(refused).toBe(true);
    });
  }, 30_000);

  test("请求超时：slow 工具 + 300ms 超时 → 诚实拒绝", async () => {
    await withFixture({ env: { FAKE_MCP_SLOW_MS: "1500" }, requestTimeoutMs: 300 }, async (client) => {
      await client.initialize();
      let timedOut = false;
      try {
        await client.request("tools/call", makeToolsCallParams("slow", {}));
      } catch (e) {
        timedOut = (e as Error).message.includes("超时");
      }
      expect(timedOut).toBe(true);
    });
  }, 30_000);

  test("未知方法 → JSON-RPC -32601 错误响应拒绝", async () => {
    await withFixture({}, async (client) => {
      await client.initialize();
      let refused = false;
      try {
        await client.request("resources/subscribe", { uri: "x" });
      } catch (e) {
        refused = (e as Error).message.includes("-32601");
      }
      expect(refused).toBe(true);
    });
  }, 30_000);

  test("close 生命周期：fixture 响应 stdin 关闭（优雅退出 + 退出码 0）", async () => {
    const client = spawnMcpServer("bun", [FIXTURE_SERVER]);
    await client.initialize();
    const r = await client.close();
    expect(r.killed).toBe(false); // fixture 在 stdin end 时自退 —— 无需 kill
    expect(r.exitCode).toBe(0);
  }, 30_000);
});

// ---- 5. 高层操作（门序 + 降级 + 真档案实弹）-----------------------------------

describe("MCP：高层操作（mcpListTools/mcpCallTool/... 门序与降级）", () => {
  test("no-config：一切操作诚实缺席 + 指引（不 spawn）", async () => {
    const ws = tmpWs("nocfg");
    try {
      const t = await mcpListTools(ws);
      expect(t[0].kind).toBe("no-config");
      expect(t[0].reason).toContain(MCP_SERVERS_FILE);
      const c = await mcpCallTool(ws, "any", "echo");
      expect(c.kind).toBe("no-config");
      const r = await mcpListResources(ws);
      expect(r[0].kind).toBe("no-config");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("server-not-found 拒绝先于 spawn（PATH 置空宇宙仍拒绝 —— 门序证明）", async () => {
    const ws = tmpWs("order");
    try {
      saveMcpServers(ws, [fixtureEntry("real")]);
      await withEmptyPath(async () => {
        const c = await mcpCallTool(ws, "ghost", "echo", { message: "x" });
        expect(c.kind).toBe("server-not-found");
        expect(c.reason).toContain("不猜默认");
        expect(c.reason).toContain(MCP_SERVERS_GUIDANCE.slice(0, 20));
      });
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("mcpListTools：真档案实弹（fixture 四工具 + serverInfo 附带）", async () => {
    const ws = tmpWs("tools");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const reports = await mcpListTools(ws);
      expect(reports.length).toBe(1);
      expect(reports[0].ok).toBe(true);
      expect(reports[0].server).toBe("fx");
      expect(reports[0].tools.map((t) => t.name).sort()).toEqual(["add", "echo", "fail", "slow"]);
      expect(reports[0].serverInfo?.serverName).toBe("fixture-mcp");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("mcpCallTool 实弹：echo 回显 / add 2+3=5 / fail isError / 未知工具 -32602", async () => {
    const ws = tmpWs("call");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const e = await mcpCallTool(ws, "fx", "echo", { message: "桥接成功" });
      expect(e.ok).toBe(true);
      expect(e.content?.text).toBe("桥接成功");
      const a = await mcpCallTool(ws, "fx", "add", { a: 2, b: 3 });
      expect(a.ok).toBe(true);
      expect(a.content?.text).toBe("5");
      expect((a.structuredContent as { result: number }).result).toBe(5);
      const f = await mcpCallTool(ws, "fx", "fail");
      expect(f.ok).toBe(true); // 协议层成功
      expect(f.isError).toBe(true); // 工具层失败 —— 双层语义
      const u = await mcpCallTool(ws, "fx", "nope-tool");
      expect(u.ok).toBe(false);
      expect(u.kind).toBe("protocol");
      expect(u.reason).toContain("-32602");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 45_000);

  test("多 server 聚合：两个 fixture 条目（不同 env 行为）→ 各自报告", async () => {
    const ws = tmpWs("multi");
    try {
      saveMcpServers(ws, [
        fixtureEntry("fx-a"),
        { ...fixtureEntry("fx-b"), env: { FAKE_MCP_CAPS: "tools" } },
      ]);
      const tools = await mcpListTools(ws);
      expect(tools.length).toBe(2);
      expect(tools.every((r) => r.ok)).toBe(true);
      const res = await mcpListResources(ws);
      const byName = new Map(res.map((r) => [r.server, r]));
      expect(byName.get("fx-a")?.ok).toBe(true);
      expect(byName.get("fx-b")?.kind).toBe("unsupported"); // fx-b 无 resources 能力
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 45_000);

  test("disabled 条目：默认聚合跳过 + 指名单仍拒绝（server-disabled）", async () => {
    const ws = tmpWs("dis");
    try {
      saveMcpServers(ws, [fixtureEntry("on"), { ...fixtureEntry("off"), disabled: true }]);
      const all = await mcpListTools(ws);
      expect(all.map((r) => r.server)).toEqual(["on"]); // disabled 不进默认聚合
      const one = await mcpListTools(ws, "off");
      expect(one[0].ok).toBe(false);
      expect(one[0].reason).toContain("停用");
      const call = await mcpCallTool(ws, "off", "echo");
      expect(call.kind).toBe("server-disabled");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("mcpListResources + mcpReadResource + mcpListPrompts 实弹", async () => {
    const ws = tmpWs("res");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const res = await mcpListResources(ws, "fx");
      expect(res[0].ok).toBe(true);
      expect(res[0].resources.map((r) => r.uri).sort()).toEqual(["org://notes", "org://readme"]);
      const read = await mcpReadResource(ws, "fx", "org://readme");
      expect(read.ok).toBe(true);
      expect(read.contents[0].text).toContain("org MCP 桥测试资源");
      const bad = await mcpReadResource(ws, "fx", "org://missing");
      expect(bad.ok).toBe(false);
      expect(bad.reason).toContain("-32602");
      const prompts = await mcpListPrompts(ws, "fx");
      expect(prompts[0].ok).toBe(true);
      expect(prompts[0].prompts[0].name).toBe("review");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("env 秘密引用：档案 $env:VAR → spawn 解析真值（fixture 观察 LOG 无关面）", async () => {
    const ws = tmpWs("envref");
    process.env.ORG_MCP_TEST_SECRET = "sink-value";
    try {
      saveMcpServers(ws, [{ ...fixtureEntry("fx"), env: { API_KEY: "$env:ORG_MCP_TEST_SECRET", LOG_LEVEL: "debug" } }]);
      const e = await mcpCallTool(ws, "fx", "echo", { message: "env ok" });
      expect(e.ok).toBe(true); // 引用解析成功 → spawn 成功 → 调用成功
      expect(e.content?.text).toBe("env ok");
      // 引用缺席：删除父变量 → spawn 前诚实拒绝（绝不带空秘密放行）
      delete process.env.ORG_MCP_TEST_SECRET;
      const r2 = resolveMcpEnv({ name: "x", command: "bun", env: { API_KEY: "$env:ORG_MCP_TEST_SECRET" } });
      expect(r2.ok).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      delete process.env.ORG_MCP_TEST_SECRET;
    }
  }, 30_000);

  test("invalid-args：arguments 非对象拒绝（数组/字符串/null）", async () => {
    const ws = tmpWs("args");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      for (const bad of [["a" as unknown], "s" as unknown, null as unknown]) {
        const r = await mcpCallTool(ws, "fx", "echo", bad as Record<string, unknown>);
        expect(r.kind).toBe("invalid-args");
      }
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("spawn 失败诊断：command 不存在 → kind=spawn + 指引", async () => {
    const ws = tmpWs("nospawn");
    try {
      saveMcpServers(ws, [{ name: "dead", command: "definitely-not-a-cmd-xyz", args: [] }]);
      const t = await mcpListTools(ws, "dead");
      expect(t[0].ok).toBe(false);
      expect(t[0].kind).toBe("spawn");
      expect(t[0].reason).toContain("spawn 失败");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("坏 JSON 档案：高层操作 invalid-config 上浮（不 spawn）", async () => {
    const ws = tmpWs("badcfg");
    try {
      fs.writeFileSync(path.join(ws, MCP_SERVERS_FILE), "not json at all");
      const t = await mcpListTools(ws);
      expect(t[0].kind).toBe("invalid-config");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

// ---- 6. CLI 冒烟（org mcp）----------------------------------------------------

describe("MCP：CLI 冒烟（org mcp）", () => {
  test("org mcp self-test：协议自检全绿（N/N）", () => {
    const r = runOrg(["mcp", "self-test"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("MCP 协议层自检");
    expect(r.stdout).toMatch(/\d+\/\d+ 通过/);
  }, 120_000);

  test("org mcp servers：档案缺席 → 指引 + 运行时探测；写入后表渲染", () => {
    const ws = tmpWs("cli-servers");
    try {
      const r = runOrg(["mcp", "servers", "--workspace", ws]);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain(MCP_SERVERS_FILE);
      expect(r.stdout).toContain("未创建");
      expect(r.stdout).toContain("bun"); // 运行时探测面
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const r2 = runOrg(["mcp", "servers", "--workspace", ws]);
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("fx");
      expect(r2.stdout).toContain("bun");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 120_000);

  test("org mcp tools：真 spawn fixture → 四工具表渲染", () => {
    const ws = tmpWs("cli-tools");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const r = runOrg(["mcp", "tools", "--workspace", ws]);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("fixture-mcp");
      expect(r.stdout).toContain("echo");
      expect(r.stdout).toContain("add");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 120_000);

  test("org mcp call：add 2 3 → 5 真算 + echo 回显", () => {
    const ws = tmpWs("cli-call");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const r = runOrg(["mcp", "call", "fx", "add", '{"a":2,"b":3}', "--workspace", ws]);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("5");
      const e = runOrg(["mcp", "call", "fx", "echo", '{"message":"CLI 桥接"}', "--workspace", ws]);
      expect(e.ok).toBe(true);
      expect(e.stdout).toContain("CLI 桥接");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 120_000);

  test("org mcp call：server 不在档案 → exit 1 + 指引", () => {
    const ws = tmpWs("cli-ghost");
    try {
      saveMcpServers(ws, [fixtureEntry("fx")]);
      const r = runOrg(["mcp", "call", "ghost", "echo", "{}", "--workspace", ws]);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("未在档案");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 120_000);
});

// ---- 7. Web /api/govex/mcp ----------------------------------------------------

describe("MCP：Web /api/govex/mcp 端点", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;
  let envSnap: ReturnType<typeof snapshotEnv>;

  beforeAll(() => {
    envSnap = snapshotEnv();
    clearEnv();
    ws = path.join(TEST_RUN, "mcp-web-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), ws, { recursive: true });
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    fs.rmSync(ws, { recursive: true, force: true });
    restoreEnv(envSnap);
  });

  test("action=servers：档案缺席 → ok + guidance + 运行时探测", async () => {
    const r = await (await fetch(`${base}/api/govex/mcp?action=servers`)).json();
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("absent");
    expect(r.guidance).toContain(MCP_SERVERS_FILE);
    expect(Array.isArray(r.runtimes)).toBe(true);
  });

  test("action=tools / resources / prompts / read：真 spawn fixture 实弹", async () => {
    saveMcpServers(ws, [fixtureEntry("fx-web")]);
    const t = await (await fetch(`${base}/api/govex/mcp?action=tools`)).json();
    expect(t.ok).toBe(true);
    expect(t.servers[0].tools.map((x: { name: string }) => x.name)).toContain("echo");
    const res = await (await fetch(`${base}/api/govex/mcp?action=resources&server=fx-web`)).json();
    expect(res.ok).toBe(true);
    expect(res.servers[0].resources.length).toBe(2);
    const read = await (await fetch(`${base}/api/govex/mcp?action=read&server=fx-web&uri=${encodeURIComponent("org://readme")}`)).json();
    expect(read.ok).toBe(true);
    expect(read.contents[0].text).toContain("org MCP 桥测试资源");
    const p = await (await fetch(`${base}/api/govex/mcp?action=prompts&server=fx-web`)).json();
    expect(p.ok).toBe(true);
    expect(p.prompts[0].name).toBe("review");
  }, 30_000);

  test("action=selftest：协议自检 N/N 全过", async () => {
    const r = await (await fetch(`${base}/api/govex/mcp?action=selftest`)).json();
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(r.total);
  });

  test("非法 action → 400 + 动作清单；GUI 🔌 区块要素", async () => {
    const r = await (await fetch(`${base}/api/govex/mcp?action=call`)).json();
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("call 不在 Web 只读面"); // Web 面保持只读（remote 口径）
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("🔌"); // MCP 面板 Tab
    expect(html).toContain("gxTabMcp");
    expect(html).toContain("gxMcpServers");
  });
});

// ---- 8. 工具环 e2e（mcp_* 三工具）---------------------------------------------

describe("MCP：工具环 e2e（mcp_servers / mcp_tools / mcp_call_tool）", () => {
  const WS_ROOT = path.join(TEST_RUN, "mcp-ws");
  let wsSeq = 0;

  function toolResults(out: string): string[] {
    return eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
  }

  test("mcp_servers（只读模式可用）：runtime 探测可观测", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    const fixture = path.join(TEST_RUN, `mcp-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"mcp_servers","args":{}}</tool>',
        "最终答案：MCP server 探测完成。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-mcp", "servers");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", path.join(process.cwd(), "hsl/pool/direct.hsl"), "--workspace", WS, "--task", "(direct) MCP 工具环",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "mcp", ORG_ASK_QUESTION: "探测", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toMatch(/mcp_servers ok runtimes=/);
    fs.rmSync(WS, { recursive: true, force: true });
  }, 120_000);

  test("mcp_tools：真 spawn fixture → echo 工具可观测（只读协议操作）", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    saveMcpServers(WS, [fixtureEntry("fx-ring")]);
    const fixture = path.join(TEST_RUN, `mcp-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"mcp_tools","args":{}}</tool>',
        "最终答案：MCP 工具清单完成。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-mcp", "tools");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", path.join(process.cwd(), "hsl/pool/direct.hsl"), "--workspace", WS, "--task", "(direct) MCP 工具清单",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "mcp", ORG_ASK_QUESTION: "清单", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("mcp_tools ok");
    expect(tr[0]).toContain("fx-ring");
    fs.rmSync(WS, { recursive: true, force: true });
  }, 120_000);

  test("mcp_call_tool：process_spawn 门放行后档案门仍拒绝（双层治理）", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    // 档案在场（fx-ring 真条目）—— ghost 不在档案 → server-not-found（区别于 no-config）
    saveMcpServers(WS, [fixtureEntry("fx-ring")]);
    // 预置长期放行集（process_spawn —— mcp_call_tool 的门）
    fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["process_spawn"] }));
    const fixture = path.join(TEST_RUN, `mcp-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"mcp_call_tool","args":{"server":"ghost","tool":"echo","arguments":{"message":"x"}}}</tool>',
        "最终答案：被档案门拒绝。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-mcp", "call");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", path.join(process.cwd(), "hsl/pool/direct.hsl"), "--workspace", WS, "--task", "(direct) MCP 门控",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "mcp", ORG_ASK_QUESTION: "门控", ORG_TOOLS: "write", ORG_APPROVAL: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("mcp_call_tool error");
    expect(tr[0]).toContain("server-not-found");
    fs.rmSync(WS, { recursive: true, force: true });
  }, 120_000);
});
