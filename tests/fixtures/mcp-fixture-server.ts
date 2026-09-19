// ============================================================================
// tests/fixtures/mcp-fixture-server.ts — 测试用假 MCP server（v0.5.19）
// ----------------------------------------------------------------------------
// 真 stdio JSON-RPC 对话（换行分帧），行为由 FAKE_MCP_* 环境变量控制：
//   FAKE_MCP_CAPS       能力开关（逗号分隔：tools,resources,prompts,logging；
//                       缺省 tools,resources,prompts 全开）
//   FAKE_MCP_VERSION    initialize 回的 protocolVersion（缺省回显客户端版本）
//   FAKE_MCP_PAGINATE   tools/list 分页（"1" = 每页 1 个 + nextCursor）
//   FAKE_MCP_SLOW_MS    slow 工具的响应延迟（测超时）
//   FAKE_MCP_GARBAGE_N  启动时先吐 N 行非 JSON 人话（测分帧器拒收）
//   FAKE_MCP_DIE_AFTER  处理完第 N 条消息后进程退出（测早夭诊断）
//   FAKE_MCP_DIE_ON_CALL 处理第 N 次 tools/call 时在响应前退出（测会话池
//                       中途死亡 → 单次换血重试 —— v0.5.20）
//   FAKE_MCP_PROBE_REQ  "1" = initialize 后先发一条 sampling/createMessage
//                       server→client 请求（测客户端自动 -32601 响应）
// 内置工具面（tools/list）：
//   echo  {message}  → 原样回显（text 块）
//   add   {a,b}      → a+b（text 块 + structuredContent）
//   fail  {}         → isError:true + 错误文本（协议层成功、工具层失败）
//   slow  {}         → FAKE_MCP_SLOW_MS 毫秒后回 "slept Nms"
//   stats {}         → {pid, inits, messages}（v0.5.20 会话池验收：同 pid =
//                       同进程复用；inits = 本进程摆手次数；messages = 已处理
//                       消息数 —— 池化复用的可观测证据面）
// 资源面：org://readme / org://notes 两个 text 资源；提示词面：review 一个。
// ============================================================================
//
// Bun 脚本：process.stdin 逐行读；process.stdout 单行 JSON 写（\n 结尾）。

const CAPS = (process.env.FAKE_MCP_CAPS ?? "tools,resources,prompts,logging").split(",").map((s) => s.trim()).filter(Boolean);
const hasCap = (c: string): boolean => CAPS.includes(c);

interface Msg {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return; // 通知无响应
  send({ jsonrpc: "2.0", id, result });
}

function respondErr(id: number | string | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  { name: "echo", description: "原样回显 message 参数", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "add", description: "整数加法 a+b", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "fail", description: "工具层失败（isError:true）", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "延迟响应（测超时）", inputSchema: { type: "object", properties: {} } },
  { name: "stats", description: "会话池验收面：pid/inits/messages（同 pid = 同进程复用的可观测证据）", inputSchema: { type: "object", properties: {} } },
];

const RESOURCES = [
  { uri: "org://readme", name: "readme", mimeType: "text/plain", description: "说明资源" },
  { uri: "org://notes", name: "notes", mimeType: "text/markdown", description: "笔记资源" },
];

let handled = 0;
let probeSent = false;
let inits = 0;
let callSeq = 0;

function handle(msg: Msg): void {
  handled++;
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize": {
      inits++;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const clientVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      const capabilities: Record<string, unknown> = {};
      if (hasCap("tools")) capabilities.tools = { listChanged: true };
      if (hasCap("resources")) capabilities.resources = { subscribe: false, listChanged: true };
      if (hasCap("prompts")) capabilities.prompts = { listChanged: true };
      if (hasCap("logging")) capabilities.logging = {};
      respond(id, {
        protocolVersion: process.env.FAKE_MCP_VERSION ?? clientVersion,
        capabilities,
        serverInfo: { name: "fixture-mcp", version: "1.4.2" },
        instructions: "fixture server for org MCP bridge tests",
      });
      if (process.env.FAKE_MCP_PROBE_REQ === "1" && !probeSent) {
        probeSent = true;
        // server→client 请求（sampling 不支持 —— 客户端应自动 -32601）
        send({ jsonrpc: "2.0", id: 9001, method: "sampling/createMessage", params: { messages: [] } });
      }
      // 通知（notifications/message —— 客户端应收集不炸）
      send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "fixture ready" } });
      break;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      // 通知无响应
      break;
    case "ping":
      respond(id, {});
      break;
    case "tools/list": {
      if (!hasCap("tools")) { respondErr(id, -32601, "server 无 tools 能力"); break; }
      const paginate = process.env.FAKE_MCP_PAGINATE === "1";
      if (paginate) {
        const cursor = typeof (msg.params as { cursor?: string } | undefined)?.cursor === "string" ? Number((msg.params as { cursor: string }).cursor) : 0;
        if (cursor < TOOLS.length) {
          respond(id, { tools: [TOOLS[cursor]], nextCursor: String(cursor + 1) });
        } else {
          respond(id, { tools: [] });
        }
      } else {
        respond(id, { tools: TOOLS });
      }
      break;
    }
    case "tools/call": {
      if (!hasCap("tools")) { respondErr(id, -32601, "server 无 tools 能力"); break; }
      callSeq++;
      const dieOnCall = Number(process.env.FAKE_MCP_DIE_ON_CALL ?? 0);
      if (dieOnCall > 0 && callSeq >= dieOnCall) {
        // 响应前自杀 —— 客户端 pending 请求由 exited 钩子拒绝（会话池中途死亡车道）
        process.stderr.write("fixture server: died before responding to tools/call\n");
        process.exit(71);
      }
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const args = params.arguments ?? {};
      if (params.name === "echo") {
        respond(id, { content: [{ type: "text", text: String(args.message ?? "(空)") }] });
      } else if (params.name === "add") {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        respond(id, { content: [{ type: "text", text: `${sum}` }], structuredContent: { result: sum } });
      } else if (params.name === "fail") {
        respond(id, { content: [{ type: "text", text: "fixture 工具层失败（isError 语义）" }], isError: true });
      } else if (params.name === "slow") {
        const ms = Number(process.env.FAKE_MCP_SLOW_MS ?? 500);
        setTimeout(() => respond(id, { content: [{ type: "text", text: `slept ${ms}ms` }] }), ms);
      } else if (params.name === "stats") {
        respond(id, { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, inits, messages: handled }) }], structuredContent: { pid: process.pid, inits, messages: handled } });
      } else {
        respondErr(id, -32602, `未知工具：${String(params.name)}`);
      }
      break;
    }
    case "resources/list": {
      if (!hasCap("resources")) { respondErr(id, -32601, "server 无 resources 能力"); break; }
      respond(id, { resources: RESOURCES });
      break;
    }
    case "resources/read": {
      if (!hasCap("resources")) { respondErr(id, -32601, "server 无 resources 能力"); break; }
      const uri = String((msg.params as { uri?: string } | undefined)?.uri ?? "");
      if (uri === "org://readme") {
        respond(id, { contents: [{ uri, mimeType: "text/plain", text: "# fixture readme\norg MCP 桥测试资源。" }] });
      } else if (uri === "org://notes") {
        respond(id, { contents: [{ uri, mimeType: "text/markdown", text: "## notes\n跨会话笔记。" }] });
      } else {
        respondErr(id, -32602, `未知资源：${uri}`);
      }
      break;
    }
    case "prompts/list": {
      if (!hasCap("prompts")) { respondErr(id, -32601, "server 无 prompts 能力"); break; }
      respond(id, { prompts: [{ name: "review", description: "审查给定的代码" }] });
      break;
    }
    default:
      respondErr(id, -32601, `未知方法：${String(msg.method)}`);
  }
  const dieAfter = Number(process.env.FAKE_MCP_DIE_AFTER ?? 0);
  if (dieAfter > 0 && handled >= dieAfter) {
    process.stderr.write("fixture server: simulated early death\n");
    process.exit(70);
  }
}

// 启动时可选吐 N 行人话（测分帧器拒收）
const garbageN = Number(process.env.FAKE_MCP_GARBAGE_N ?? 0);
for (let i = 0; i < garbageN; i++) {
  process.stdout.write(`fixture server 启动日志第 ${i + 1} 行（非协议人话）\n`);
}

let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line) as Msg);
      } catch {
        process.stderr.write(`fixture server: 无法解析行（${line.slice(0, 60)}…）\n`);
      }
    }
    idx = buf.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  // 客户端关 stdin —— 优雅退出
  process.exit(0);
});
