// ============================================================================
// lib/mcp.ts — MCP（Model Context Protocol）客户端桥（v0.5.19 · #122 / C12）
// ----------------------------------------------------------------------------
// org 作为 MCP **客户端**：按 <ws>/mcp-servers.json 档案 spawn 外部 MCP
// server（stdio 传输），JSON-RPC 2.0 换行分帧对话，把 server 暴露的
// tools/resources/prompts 翻译成 org 可调用面（CLI / 工具环 / Web）。
// 这是 C12「MCP/插件注册」与主表 #122「MCP 支持」缺的**协议翻译**半面：
// 登记不再是纸面 —— initialize 握手真发生、能力真协商、工具真可调。
//
// 协议口径（MCP stdio transport）：
//   - 消息 = 单行 JSON（UTF-8，\n 结尾，禁止内嵌换行）—— 与 LSP 的
//     Content-Length 分帧不同，这里按行分帧（McpLineDecoder）；
//   - 生命周期：initialize 请求（protocolVersion/capabilities/clientInfo）
//     → 响应（server capabilities/serverInfo）→ notifications/initialized
//     → 请求/通知 → 客户端关 stdin 收尾（MCP 无 shutdown/exit 通知；
//     SIGTERM 宽限 → SIGKILL 兜底）；
//   - 能力面：capabilities.tools/resources/prompts 各自独立 —— 缺席的
//     能力对应操作诚实返回 unsupported（不猜、不假装）；
//   - 分页：nextCursor 跟进（防 server 一页吐不全）。
//
// 安全模型（与 remote-hosts.json 同哲学）：
//   - 档案字段校验单一规则源（validateMcpServerEntry）：name 唯一、
//     command 非空、args 全字符串、cwd 过 pathjail 监狱（相对路径解析
//     进工作区，越界拒绝）；
//   - **秘密不入档案**：env 键名疑似秘密（SECRET/TOKEN/PASSWORD/KEY/
//     CREDENTIAL 族）时字面值拒绝 —— 须用 "$env:VAR" 引用形态（spawn
//     时从父进程环境解析，档案里只有变量名没有值）；$env: 引用缺席时
//     spawn 前拒绝（诚实报「父环境无此变量」）；
//   - 零 shell 注入面：Bun.spawn argv 数组 + 显式 env；
//   - 调用面分层：servers/tools/resources/prompts 是只读协议操作（枚举
//     面）；call 是执行车道（工具环 process_spawn 门 + 审批在环 ——
//     CLI org mcp call 真跑，Web 面只读不设 call，与 remote 口径一致）。
//
// 诚实边界：会话粒度 = 每操作一会话（spawn → initialize → op → close），
//   长连接复用与 notifications/roots 增量订阅是路线图；采样（sampling）
//   与 ELICITATION 不支持（server→client 请求自动按 -32601 拒绝并收集
//   观测）。sandbox 无真第三方 MCP server —— 协议层由 tests/fixtures/
//   mcp-fixture-server.ts 实弹锁定（真 spawn 真握手真调用）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace, inWorkspace } from "./pathjail.ts";

// ---- 协议常量 ----------------------------------------------------------------

/** 客户端声明的协议版本（MCP spec 2025-06-18；server 回什么版本就记什么 —— 协商不挑剔）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_TIMEOUTS = {
  initialize: 10_000,
  request: 15_000,
  closeGrace: 2_500,
} as const;

/** JSON-RPC 2.0 标准错误码（与 LSP/DAP 同族；MCP 复用同一套）。 */
export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const MCP_SERVERS_FILE = "mcp-servers.json";

export const MCP_SERVERS_GUIDANCE =
  `在 <workspace>/${MCP_SERVERS_FILE} 声明外部 MCP server（数组，每项 {name, command, args?, env?, cwd?, disabled?}）。` +
  "示例：[{\"name\":\"fs\",\"command\":\"bun\",\"args\":[\"server.ts\"]}]。env 秘密键只收 $env:VAR 引用（值永不入档案）。";

/** 档案里 env 键的「疑似秘密」启发（键名命中即字面值拒绝 —— 宁可误伤不可放行）。 */
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

/** $env:VAR 引用形态（spawn 时解析 —— 档案只存变量名）。 */
const ENV_REF_PREFIX = "$env:";

// ---- 换行分帧（MCP stdio：单行 JSON，禁止内嵌换行）----------------------------

export interface McpMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 编码一条出站消息（单行 JSON + \n；内嵌换行直接拒 —— 协议铁律）。 */
export function encodeMcpMessage(body: unknown): string {
  const s = JSON.stringify(body);
  if (s.includes("\n")) throw new Error("encodeMcpMessage：消息含内嵌换行（MCP stdio 禁止 —— 改用单行 JSON）");
  return s + "\n";
}

/** 入站换行分帧器：跨 chunk 缓冲、按 \n 切分、坏行拒收计数、非对象拒收。 */
export class McpLineDecoder {
  private buf = "";
  rejectedLines = 0;

  /** 推入一段字节，返回完整解码出的消息（顺序保持）。 */
  push(chunk: string | Buffer): McpMessage[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const out: McpMessage[] = [];
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) {
        try {
          const obj: unknown = JSON.parse(line);
          if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
            this.rejectedLines++;
          } else {
            out.push(obj as McpMessage);
          }
        } catch {
          this.rejectedLines++; // 坏 JSON 行（server 打印了人话日志到 stdout 等）—— 拒收不炸
        }
      }
      idx = this.buf.indexOf("\n");
    }
    return out;
  }

  /** 缓冲区残留（诊断面；正常收尾应为空或半行）。 */
  pending(): string {
    return this.buf;
  }

  reset(): void {
    this.buf = "";
    this.rejectedLines = 0;
  }
}

/** 解码一段完整文本（一次性 —— 协议自检/测试用）。 */
export function decodeMcpMessages(text: string | Buffer): { messages: McpMessage[]; rejected: number } {
  const d = new McpLineDecoder();
  const messages = d.push(text);
  return { messages, rejected: d.rejectedLines };
}

// ---- 消息构造器（协议自检锁形状）----------------------------------------------

export function makeMcpRequest(id: number | string, method: string, params?: unknown): McpMessage {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

export function makeMcpNotification(method: string, params?: unknown): McpMessage {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
}

export function makeMcpResponse(id: number | string, result: unknown): McpMessage {
  return { jsonrpc: "2.0", id, result };
}

export function makeMcpError(id: number | string, code: number, message: string): McpMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function makeInitializeParams(clientInfo?: { name: string; version: string }): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {}, // 诚实最小：sampling/roots/elicitation 均不支持（server 请求会被 -32601 拒）
    clientInfo: clientInfo ?? { name: "org-mcp-bridge", version: "0.5.19" },
  };
}

export function makeToolsCallParams(name: string, args?: Record<string, unknown>): Record<string, unknown> {
  return { name, ...(args !== undefined ? { arguments: args } : {}) };
}

// ---- 档案层（mcp-servers.json）------------------------------------------------

export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  /** 秘密键只收 "$env:VAR" 引用（spawn 时从父环境解析 —— 值永不入档案）。 */
  env?: Record<string, string>;
  /** 工作目录（相对 → 工作区内解析；越界拒绝 —— pathjail 监狱）。 */
  cwd?: string;
  disabled?: boolean;
}

export interface McpServersFile {
  ok: boolean;
  kind: "ok" | "absent" | "invalid-json" | "not-array" | "invalid-entries";
  entries: McpServerEntry[];
  /** 逐条校验结果（与 entries 等长 —— 坏条目原因逐条可观测）。 */
  validations: Array<{ name: string; ok: boolean; reason?: string }>;
  reason?: string;
}

export interface McpEntryValidation {
  ok: boolean;
  reason?: string;
}

/** 单条档案校验（单一规则源：CLI 渲染 / spawn 前置门 / save 全走这里）。 */
export function validateMcpServerEntry(e: unknown): McpEntryValidation {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return { ok: false, reason: "条目须为对象" };
  const o = e as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.trim().length === 0) return { ok: false, reason: "name 必填（非空字符串）" };
  if (typeof o.command !== "string" || o.command.trim().length === 0) return { ok: false, reason: "command 必填（spawn 的可执行文件，如 bun/node/python3）" };
  if (o.args !== undefined && (!Array.isArray(o.args) || o.args.some((x) => typeof x !== "string"))) {
    return { ok: false, reason: "args 须为字符串数组" };
  }
  if (o.env !== undefined) {
    if (o.env === null || typeof o.env !== "object" || Array.isArray(o.env)) return { ok: false, reason: "env 须为对象（键→值字符串）" };
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v !== "string") return { ok: false, reason: `env.${k} 值须为字符串` };
      if (SECRET_KEY_RE.test(k) && !v.startsWith(ENV_REF_PREFIX)) {
        return { ok: false, reason: `env.${k} 键名疑似秘密 —— 字面值拒绝（档案永不存值）。改用 "${ENV_REF_PREFIX}VAR_NAME" 引用形态（spawn 时从父进程环境解析）` };
      }
    }
  }
  if (o.cwd !== undefined && typeof o.cwd !== "string") return { ok: false, reason: "cwd 须为字符串" };
  if (o.disabled !== undefined && typeof o.disabled !== "boolean") return { ok: false, reason: "disabled 须为布尔" };
  return { ok: true };
}

/** 读档案（缺席 = 诚实缺席非错误；坏 JSON / 非数组 / 坏条目逐条上浮）。 */
export function loadMcpServers(ws: string): McpServersFile {
  const file = path.join(ws, MCP_SERVERS_FILE);
  if (!fs.existsSync(file)) {
    return { ok: false, kind: "absent", entries: [], validations: [], reason: `档案未创建（${MCP_SERVERS_FILE}）—— 外部 MCP server 未登记，一切会话操作拒绝（不猜默认）` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return { ok: false, kind: "invalid-json", entries: [], validations: [], reason: `档案不可读：${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, kind: "invalid-json", entries: [], validations: [], reason: `档案不是合法 JSON：${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, kind: "not-array", entries: [], validations: [], reason: "档案顶层须为数组（每项一个 server 条目）" };
  }
  const seen = new Set<string>();
  const entries: McpServerEntry[] = [];
  const validations: Array<{ name: string; ok: boolean; reason?: string }> = [];
  let invalid = false;
  for (const item of parsed) {
    const v = validateMcpServerEntry(item);
    const name = (item as { name?: unknown })?.name;
    const label = typeof name === "string" && name.trim() ? name : "(未命名)";
    if (v.ok && typeof name === "string") {
      if (seen.has(name)) {
        validations.push({ name, ok: false, reason: `name 重复（${name} 已登记）` });
        invalid = true;
        continue;
      }
      seen.add(name);
      entries.push(item as McpServerEntry);
    } else {
      invalid = true;
    }
    validations.push({ name: label, ok: v.ok, ...(v.reason ? { reason: v.reason } : {}) });
  }
  return { ok: !invalid, kind: invalid ? "invalid-entries" : "ok", entries, validations, ...(invalid ? { reason: "存在未过校验的条目（过检条目照常可用）" } : {}) };
}

/** 写档案（全量校验：任何一条不过 → 整档拒绝，盘上旧文件不动）。 */
export function saveMcpServers(ws: string, entries: McpServerEntry[]): { ok: boolean; reason?: string } {
  for (const e of entries) {
    const v = validateMcpServerEntry(e);
    if (!v.ok) return { ok: false, reason: `save 拒绝（${(e as { name?: string }).name ?? "(未命名)"}）：${v.reason}` };
  }
  const names = entries.map((e) => e.name);
  if (new Set(names).size !== names.length) return { ok: false, reason: "save 拒绝：name 重复" };
  const file = path.join(ws, MCP_SERVERS_FILE);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf-8");
  return { ok: true };
}

/** 按 name 精确查找（disabled 条目也算「在档但停用」—— 与「不在档」区分）。 */
export function findMcpServer(f: McpServersFile, name: string): { entry: McpServerEntry } | { notFound: true } | { disabled: true } {
  const hit = f.entries.find((e) => e.name === name);
  if (!hit) return { notFound: true };
  if (hit.disabled) return { disabled: true };
  return { entry: hit };
}

/** 解析 entry.env → 子进程 env 覆盖面（$env: 引用从父环境取值；缺席诚实拒绝）。 */
export function resolveMcpEnv(entry: McpServerEntry): { ok: boolean; env: Record<string, string>; reason?: string } {
  const out: Record<string, string> = {};
  if (!entry.env) return { ok: true, env: out };
  for (const [k, v] of Object.entries(entry.env)) {
    if (v.startsWith(ENV_REF_PREFIX)) {
      const varName = v.slice(ENV_REF_PREFIX.length);
      const fromParent = process.env[varName];
      if (fromParent === undefined) {
        return { ok: false, env: out, reason: `env.${k} 引用 ${ENV_REF_PREFIX}${varName}，但父进程环境无此变量（spawn 前拒绝 —— 绝不带着空秘密放行）` };
      }
      out[k] = fromParent;
    } else {
      out[k] = v;
    }
  }
  return { ok: true, env: out };
}

// ---- 运行时探测（server spawn 前提）-------------------------------------------

export interface McpRuntimeProbe {
  name: string;
  cmd: string;
  available: boolean;
  path: string | null;
}

/** 探测常见 server 宿主运行时（node/npx/bunx/bun/python3/uvx）。 */
export function probeMcpRuntimes(): McpRuntimeProbe[] {
  const which = (c: string): string | null => {
    try {
      return (Bun as unknown as { which?: (x: string) => string | null }).which?.(c) ?? null;
    } catch {
      return null;
    }
  };
  const runtimes: Array<{ name: string; cmd: string }> = [
    { name: "bun", cmd: "bun" },
    { name: "bunx", cmd: "bunx" },
    { name: "node", cmd: "node" },
    { name: "npx", cmd: "npx" },
    { name: "python3", cmd: "python3" },
    { name: "uvx", cmd: "uvx" },
  ];
  return runtimes.map((r) => {
    const p = which(r.cmd);
    return { name: r.name, cmd: r.cmd, available: p !== null, path: p };
  });
}

// ---- MCP 客户端（spawn → initialize → 操作 → close）---------------------------

export interface McpClientOptions {
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeGraceMs?: number;
  /** 子进程 env 覆盖面（已解析的 entry.env）。 */
  env?: Record<string, string>;
  cwd?: string;
  clientInfo?: { name: string; version: string };
}

interface McpPending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** initialize 响应的规范化产物（能力三面 + serverInfo + 版本协商记录）。 */
export interface McpServerInfo {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  capabilities: { tools: boolean; resources: boolean; prompts: boolean; logging: boolean };
  instructions?: string;
}

/**
 * MCP stdio 客户端：spawn 子进程，换行分帧 JSON-RPC 对话。响应按 id 关联；
 * server→client 通知（notifications/tools/list_changed 等）收集；server→client
 * 请求（sampling/createMessage / roots/list / ping）自动响应（ping → {}；
 * 其余 -32601 不支持 —— 诚实最小客户端），并收集在 serverRequests 供观测。
 */
export class McpClient {
  readonly cmd: string;
  readonly args: string[];
  serverInfo: McpServerInfo | null = null;
  notifications: McpMessage[] = [];
  serverRequests: McpMessage[] = [];
  exited = false;
  exitCode: number | null = null;

  private proc: ReturnType<typeof Bun.spawn>;
  private decoder = new McpLineDecoder();
  private nextId = 1;
  private pending = new Map<number | string, McpPending>();
  private opts: Required<Pick<McpClientOptions, "initializeTimeoutMs" | "requestTimeoutMs" | "closeGraceMs">>;
  private clientInfo: { name: string; version: string };
  private envOverlay: Record<string, string>;
  private cwd: string | undefined;
  private stderrTail = "";
  private initialized = false;

  private constructor(cmd: string, args: string[], proc: ReturnType<typeof Bun.spawn>, opts: McpClientOptions) {
    this.cmd = cmd;
    this.args = [...args];
    this.proc = proc;
    this.opts = {
      initializeTimeoutMs: opts.initializeTimeoutMs ?? MCP_TIMEOUTS.initialize,
      requestTimeoutMs: opts.requestTimeoutMs ?? MCP_TIMEOUTS.request,
      closeGraceMs: opts.closeGraceMs ?? MCP_TIMEOUTS.closeGrace,
    };
    this.clientInfo = opts.clientInfo ?? { name: "org-mcp-bridge", version: "0.5.19" };
    this.envOverlay = opts.env ?? {};
    this.cwd = opts.cwd;
    void (async () => {
      try {
        for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          for (const msg of this.decoder.push(Buffer.from(chunk))) this.dispatch(msg);
        }
      } catch { /* 流关闭 —— pending 由 exited 钩子收尾 */ }
    })();
    void (async () => {
      try {
        for await (const chunk of this.proc.stderr as unknown as AsyncIterable<Uint8Array>) {
          this.stderrTail = (this.stderrTail + Buffer.from(chunk).toString("utf-8")).slice(-8192);
        }
      } catch { /* 同上 */ }
    })();
    void this.proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server 已退出（code=${code}${this.stderrTail ? ` · stderr 尾巴：${this.stderrTail.slice(-400)}` : ""}）`));
      }
      this.pending.clear();
    });
  }

  private dispatch(msg: McpMessage): void {
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        // server→client 请求：诚实最小客户端自动响应
        this.serverRequests.push(msg);
        if (msg.method === "ping") {
          this.write(makeMcpResponse(msg.id, {}));
        } else {
          this.write(makeMcpError(msg.id, JSONRPC_ERROR_CODES.METHOD_NOT_FOUND, `org MCP 桥不支持 ${msg.method}（sampling/roots/elicitation 是路线图）`));
        }
        return;
      }
      this.notifications.push(msg);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p === undefined) return; // 未知 id（迟到/重复响应）—— 丢弃
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        p.reject(new Error(`MCP 错误响应 ${p.method}：code=${msg.error.code} ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
    // 其余形态 —— 坏消息丢弃（解码器已拒非对象/坏 JSON）
  }

  private write(msg: unknown): void {
    try {
      const sink = this.proc.stdin as unknown as { write: (s: string) => number; flush: () => void };
      sink.write(encodeMcpMessage(msg));
      sink.flush();
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      // EPIPE（server 已退出，stdin 管道断裂）—— 容忍：pending 请求由 exited
      // 钩子统一诚实拒绝；通知（fire-and-forget）安全丢弃。exited 标志与管道
      // 断裂之间有竞态窗（DIE_AFTER 型早夭实测抓出），不能只看 this.exited。
      if (this.exited || /EPIPE|broken pipe/i.test(m)) return;
      throw new Error(`写 MCP server stdin 失败：${m}`);
    }
  }

  /** initialize → notifications/initialized（返回规范化 serverInfo）。 */
  async initialize(): Promise<McpServerInfo> {
    if (this.initialized) throw new Error("McpClient 已 initialize 过（单会话客户端）");
    this.initialized = true;
    const raw = (await this.request("initialize", makeInitializeParams(this.clientInfo), this.opts.initializeTimeoutMs)) as Record<string, unknown> | null ?? {};
    const caps = (raw.capabilities ?? {}) as Record<string, unknown>;
    const info = (raw.serverInfo ?? {}) as Record<string, unknown>;
    this.serverInfo = {
      protocolVersion: typeof raw.protocolVersion === "string" ? raw.protocolVersion : "(未声明)",
      serverName: typeof info.name === "string" ? info.name : "(未声明)",
      serverVersion: typeof info.version === "string" ? info.version : "(未声明)",
      capabilities: {
        tools: "tools" in caps,
        resources: "resources" in caps,
        prompts: "prompts" in caps,
        logging: "logging" in caps,
      },
      ...(typeof raw.instructions === "string" ? { instructions: raw.instructions } : {}),
    };
    this.notify("notifications/initialized", {});
    return this.serverInfo;
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`MCP server 已退出（code=${this.exitCode}）—— 无法发 ${method}`));
    const id = this.nextId++;
    const msg = makeMcpRequest(id, method, params);
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${timeout}ms）：${method}`));
      }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exited) throw new Error(`MCP server 已退出（code=${this.exitCode}）—— 无法发通知 ${method}`);
    this.write(makeMcpNotification(method, params));
  }

  /** MCP 无 shutdown 通知 —— 关 stdin → 宽限等退出 → SIGTERM → SIGKILL 兜底。 */
  async close(): Promise<{ exitCode: number | null; killed: boolean }> {
    let killed = false;
    if (!this.exited) {
      try {
        const sink = this.proc.stdin as unknown as { end?: () => void };
        sink?.end?.();
      } catch { /* stdin 已关 */ }
      const grace = await Promise.race([
        this.proc.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.opts.closeGraceMs)),
      ]);
      if (!grace) {
        try { this.proc.kill(); } catch { /* 已退 */ }
        killed = true;
        await this.proc.exited;
      }
    }
    return { exitCode: this.exitCode, killed };
  }

  /** stderr 尾巴（诊断面；≤8KB）。 */
  stderr(): string {
    return this.stderrTail;
  }

  /** 分帧器拒收行计数（server 往 stdout 打印非协议人话时观测）。 */
  rejectedLines(): number {
    return this.decoder.rejectedLines;
  }
}

/**
 * spawn 一个外部 MCP server（真协议车道）。spawn 失败（命令不存在/无执行
 * 权限）诚实拒绝 —— kind:"spawn"。env 覆盖面必须**已解析**（resolveMcpEnv
 * 产物 —— 秘密引用缺席时在调用方提前拒绝，绝不带着缺口放行）。
 */
export function spawnMcpServer(cmd: string, args: string[] = [], opts: McpClientOptions = {}): McpClient {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new Error("spawnMcpServer：cmd 必填（如 bun/node/python3）");
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
  } catch (e) {
    throw new Error(`MCP server spawn 失败：${cmd}（${(e as Error).message}）—— 环境无此命令时请先 probeMcpRuntimes() 探测宿主运行时`);
  }
  return new McpClient(cmd, args, proc, opts);
}

// ---- 高层操作（会话粒度：每操作一会话）-----------------------------------------

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
}

export interface McpContentSummary {
  text: string;
  textBlocks: number;
  imageBlocks: number;
  resourceBlocks: number;
  truncated: boolean;
}

export interface McpCallToolResult {
  ok: boolean;
  kind: "ok" | "no-config" | "server-not-found" | "server-disabled" | "env-ref-missing" | "spawn" | "timeout" | "protocol" | "unsupported" | "tool-error" | "invalid-args";
  server: string;
  tool: string;
  isError?: boolean;
  content?: McpContentSummary;
  structuredContent?: unknown;
  serverInfo?: McpServerInfo;
  reason?: string;
}

/** 内容块归一：text 块拼接、image/resource 块计数、16KB 帽（保头保尾）。 */
export function normalizeContent(content: unknown): McpContentSummary {
  const CAP = 16 * 1024;
  let text = "";
  let textBlocks = 0;
  let imageBlocks = 0;
  let resourceBlocks = 0;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b === null || typeof b !== "object") continue;
      const blk = b as Record<string, unknown>;
      if (blk.type === "text" && typeof blk.text === "string") {
        textBlocks++;
        text += (text ? "\n" : "") + blk.text;
      } else if (blk.type === "image") {
        imageBlocks++;
      } else if (blk.type === "resource" || blk.type === "resource_link") {
        resourceBlocks++;
      }
    }
  }
  const bytes = Buffer.byteLength(text, "utf-8");
  const truncated = bytes > CAP;
  if (truncated) {
    const head = text.slice(0, Math.floor(CAP * 0.75));
    const tail = text.slice(-Math.floor(CAP * 0.25));
    text = `${head}\n…［MCP 内容已截断：共 ${bytes} 字节，超出 16KB 上限］…\n${tail}`;
  }
  return { text, textBlocks, imageBlocks, resourceBlocks, truncated };
}

/** 会话包装：spawn → initialize → fn → close（fn 抛错也保证收尾）。 */
async function withSession<T>(
  entry: McpServerEntry,
  ws: string,
  fn: (client: McpClient) => Promise<T>,
  opts?: { requestTimeoutMs?: number; session?: McpSessionMode },
): Promise<{ ok: true; value: T } | { ok: false; kind: "env-ref-missing" | "spawn" | "timeout" | "protocol"; reason: string }> {
  const envRes = resolveMcpEnv(entry);
  if (!envRes.ok) return { ok: false, kind: "env-ref-missing", reason: envRes.reason ?? "env 引用解析失败" };
  let cwd: string | undefined;
  if (entry.cwd !== undefined) {
    cwd = resolveInWorkspace(ws, entry.cwd);
    if (!inWorkspace(ws, cwd)) {
      return { ok: false, kind: "spawn", reason: `cwd 越界拒绝：${entry.cwd}（须在工作区内 —— pathjail 监狱）` };
    }
  }
  let client: McpClient;
  try {
    client = spawnMcpServer(entry.command, entry.args ?? [], { env: envRes.env, cwd, ...(opts?.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}) });
  } catch (e) {
    return { ok: false, kind: "spawn", reason: (e as Error).message };
  }
  try {
    await client.initialize();
    return { ok: true, value: await fn(client) };
  } catch (e) {
    const msg = (e as Error).message;
    const kind = msg.includes("超时") ? "timeout" : msg.includes("spawn") ? "spawn" : "protocol";
    return { ok: false, kind: kind as "timeout" | "spawn" | "protocol", reason: msg };
  } finally {
    await client.close();
  }
}

// ---- 会话池（v0.5.20 长连接复用：每操作一会话 → 池化常驻）-----------------------
//
// v0.5.19 的会话粒度是「每操作一会话」（spawn → initialize → 操作 → close），
// 诚实但昂贵：每次 tools/call 都重付一次进程启动 + 握手。会话池把活会话按
// 「工作区 + server 名」缓存复用：
//   - 命中（进程活着 + 档案未漂移 + 空闲未超 TTL）→ 直接复用（零 spawn 零握手）
//   - 档案漂移（command/args/cwd/env 变更）→ 丢弃旧会话重 spawn（新配置生效）
//   - 空闲超 TTL → 优雅关闭重 spawn（长寿命 server 的状态陈旧面收敛）
//   - LRU 帽（缺省 4）：超帽逐出最久未用会话
//   - 操作中死亡（server 崩了）→ 丢弃后**单次**重试（诚实恢复，绝不无限）
//   - 并发去重：同 key 并发 acquire 共享同一次 spawn
// 观测面：mcpSessionStats()（命中/未命中/逐出/过期/漂移丢弃计数 + 每会话
// 年龄/空闲/操作数）；mcpCloseSessions() 显式收池（CLI org mcp sessions --close）。

/** 会话池缺省预算（LRU 帽 4 会话 · 空闲 TTL 5 分钟）。 */
export const MCP_POOL_DEFAULTS = { maxSessions: 4, idleTtlMs: 5 * 60_000 } as const;

export interface McpPoolTuning {
  maxSessions?: number;
  idleTtlMs?: number;
}

interface PooledSession {
  server: string;
  ws: string;
  /** 档案身份指纹（command/args/cwd + 解析后 env 的 k=v 排序）—— 漂移检测。 */
  identity: string;
  client: McpClient;
  bornAt: number;
  lastUsed: number;
  ops: number;
}

export interface McpPoolSessionView {
  server: string;
  ws: string;
  ageMs: number;
  idleMs: number;
  ops: number;
  exited: boolean;
}

export interface McpPoolStats {
  totalSessions: number;
  sessions: McpPoolSessionView[];
  hits: number;
  misses: number;
  evictions: number;
  expires: number;
  driftDiscards: number;
  midOpDeaths: number;
  maxSessions: number;
  idleTtlMs: number;
}

/** 池状态（模块级单例 —— CLI 单进程语义；每个 op 查询它）。 */
const pool: {
  sessions: Map<string, PooledSession>;
  inFlight: Map<string, Promise<McpClient>>;
  hits: number;
  misses: number;
  evictions: number;
  expires: number;
  driftDiscards: number;
  midOpDeaths: number;
  tuning: Required<McpPoolTuning>;
} = {
  sessions: new Map(),
  inFlight: new Map(),
  hits: 0,
  misses: 0,
  evictions: 0,
  expires: 0,
  driftDiscards: 0,
  midOpDeaths: 0,
  tuning: { maxSessions: MCP_POOL_DEFAULTS.maxSessions, idleTtlMs: MCP_POOL_DEFAULTS.idleTtlMs },
};

/** 会话键（工作区 + server 名 —— 同名 server 在不同工作区互不混池）。 */
function poolKey(ws: string, server: string): string {
  return `${ws.replace(/\\/g, "/")}\u0000${server}`;
}

/** 档案身份指纹：command/args/cwd + 解析后 env 排序（值入指纹 —— env 变更也触发换血）。 */
function entryIdentity(entry: McpServerEntry, env: Record<string, string>): string {
  const envFp = Object.keys(env).sort().map((k) => `${k}=${env[k]}`).join("\u0001");
  return JSON.stringify([entry.command, entry.args ?? [], entry.cwd ?? "", envFp]);
}

/** 丢弃一条池内会话（已退出的免 close；在飞的由 acquire 竞态窗兜底）。 */
async function discardSession(s: PooledSession): Promise<void> {
  pool.sessions.delete(poolKey(s.ws, s.server));
  if (!s.client.exited) await s.client.close();
}

/** spawn + initialize 一个新会话（并发去重：同 key 共享同一次 spawn）。 */
async function spawnPooled(ws: string, entry: McpServerEntry, opts?: { requestTimeoutMs?: number }): Promise<
  { ok: true; client: McpClient } | { ok: false; kind: "env-ref-missing" | "spawn" | "timeout" | "protocol"; reason: string }
> {
  const envRes = resolveMcpEnv(entry);
  if (!envRes.ok) return { ok: false, kind: "env-ref-missing", reason: envRes.reason ?? "env 引用解析失败" };
  let cwd: string | undefined;
  if (entry.cwd !== undefined) {
    cwd = resolveInWorkspace(ws, entry.cwd);
    if (!inWorkspace(ws, cwd)) {
      return { ok: false, kind: "spawn", reason: `cwd 越界拒绝：${entry.cwd}（须在工作区内 —— pathjail 监狱）` };
    }
  }
  const identity = entryIdentity(entry, envRes.env);
  const key = poolKey(ws, entry.name);
  // 并发去重：已在 spawn 的 key 直接等它的结果（misses 只计一次）
  const existing = pool.inFlight.get(key);
  if (existing) return { ok: true, client: await existing };
  const p = (async () => {
    const client = spawnMcpServer(entry.command, entry.args ?? [], { env: envRes.env, cwd, ...(opts?.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}) });
    try {
      await client.initialize();
    } catch (e) {
      // 握手失败即废 —— 立即收尸，绝不留半初始化会话在池里
      await client.close().catch(() => {});
      throw e;
    }
    return client;
  })();
  pool.inFlight.set(key, p);
  try {
    const client = await p;
    const now = Date.now();
    // LRU 帽：插入前逐出最久未用的**其他**会话（绝不逐出正在用的自己）
    const others = [...pool.sessions.values()].filter((s) => poolKey(s.ws, s.server) !== key);
    while (pool.sessions.size >= pool.tuning.maxSessions && others.length > 0) {
      others.sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = others.shift()!;
      pool.evictions++;
      await discardSession(victim);
    }
    // 同 key 旧会话（理论上已被 acquire 清理 —— 兜底再丢一次）
    const old = pool.sessions.get(key);
    if (old) await discardSession(old);
    pool.sessions.set(key, { server: entry.name, ws, identity, client, bornAt: now, lastUsed: now, ops: 0 });
    pool.misses++;
    return { ok: true as const, client };
  } catch (e) {
    const msg = (e as Error).message;
    const kind = msg.includes("超时") ? "timeout" : msg.includes("spawn") ? "spawn" : "protocol";
    return { ok: false as const, kind: kind as "timeout" | "spawn" | "protocol", reason: msg };
  } finally {
    pool.inFlight.delete(key);
  }
}

/**
 * 池化 acquire：命中（活 + 未漂移 + 未超 TTL）→ 复用并计数 hits；漂移 →
 * 丢弃换血（driftDiscards）；超 TTL → 关闭换血（expires）；已退 → 换血。
 * 未命中 → spawnPooled（并发去重）。
 */
async function poolAcquire(
  ws: string,
  entry: McpServerEntry,
  opts?: { requestTimeoutMs?: number },
): Promise<{ ok: true; client: McpClient; reused: boolean } | { ok: false; kind: "env-ref-missing" | "spawn" | "timeout" | "protocol"; reason: string }> {
  const key = poolKey(ws, entry.name);
  const s = pool.sessions.get(key);
  if (s) {
    const envRes = resolveMcpEnv(entry);
    if (!envRes.ok) {
      // env 引用失效（原 var 被删）→ 旧会话作废，诚实拒绝
      await discardSession(s);
      return { ok: false, kind: "env-ref-missing", reason: envRes.reason ?? "env 引用解析失败" };
    }
    const identity = entryIdentity(entry, envRes.env);
    if (s.client.exited) {
      await discardSession(s); // 已退（免 close）—— 走换血
    } else if (s.identity !== identity) {
      pool.driftDiscards++;
      await discardSession(s);
    } else if (Date.now() - s.lastUsed > pool.tuning.idleTtlMs) {
      pool.expires++;
      await discardSession(s);
    } else {
      pool.hits++;
      s.lastUsed = Date.now();
      s.ops++;
      return { ok: true, client: s.client, reused: true };
    }
  }
  const r = await spawnPooled(ws, entry, opts);
  if (!r.ok) return r;
  const pooled = pool.sessions.get(key);
  if (pooled) pooled.ops++;
  return { ok: true, client: r.client, reused: false };
}

/** 池观测面（CLI org mcp sessions / Web action=sessions / 测试）。 */
export function mcpSessionStats(): McpPoolStats {
  const now = Date.now();
  return {
    totalSessions: pool.sessions.size,
    sessions: [...pool.sessions.values()].map((s) => ({
      server: s.server,
      ws: s.ws,
      ageMs: now - s.bornAt,
      idleMs: now - s.lastUsed,
      ops: s.ops,
      exited: s.client.exited,
    })),
    hits: pool.hits,
    misses: pool.misses,
    evictions: pool.evictions,
    expires: pool.expires,
    driftDiscards: pool.driftDiscards,
    midOpDeaths: pool.midOpDeaths,
    maxSessions: pool.tuning.maxSessions,
    idleTtlMs: pool.tuning.idleTtlMs,
  };
}

/** 池调参（测试用：TTL/帽可缩到毫秒级验证过期与逐出）。 */
export function mcpTunePool(t: McpPoolTuning): void {
  if (typeof t.maxSessions === "number" && Number.isFinite(t.maxSessions) && t.maxSessions >= 1) pool.tuning.maxSessions = Math.floor(t.maxSessions);
  if (typeof t.idleTtlMs === "number" && Number.isFinite(t.idleTtlMs) && t.idleTtlMs >= 1) pool.tuning.idleTtlMs = Math.floor(t.idleTtlMs);
}

/** 显式收池（CLI org mcp sessions --close；ws 省缺 = 全部工作区）。 */
export async function mcpCloseSessions(ws?: string): Promise<{ closed: number }> {
  const victims = [...pool.sessions.values()].filter((s) => ws === undefined || s.ws.replace(/\\/g, "/") === ws.replace(/\\/g, "/"));
  let closed = 0;
  for (const s of victims) {
    await discardSession(s);
    closed++;
  }
  return { closed };
}

/**
 * 池化会话包装（session:"reuse" 车道）：acquire → fn →（不关，标记空闲）。
 * fn 中途死亡（server 崩溃）→ 丢弃 + **单次**换血重试（midOpDeaths++）；
 * 重试仍败按最后一次错误诚实返回。
 */
async function withReusedSession<T>(
  entry: McpServerEntry,
  ws: string,
  fn: (client: McpClient) => Promise<T>,
  opts?: { requestTimeoutMs?: number; session?: McpSessionMode },
): Promise<{ ok: true; value: T } | { ok: false; kind: "env-ref-missing" | "spawn" | "timeout" | "protocol"; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const acq = await poolAcquire(ws, entry, opts);
    if (!acq.ok) return acq;
    try {
      const value = await fn(acq.client);
      // 用完归还：只更新 lastUsed（ops 已在 acquire 计）
      const s = pool.sessions.get(poolKey(ws, entry.name));
      if (s) s.lastUsed = Date.now();
      return { ok: true, value };
    } catch (e) {
      const msg = (e as Error).message;
      if (acq.reused && /已退出|EPIPE|broken pipe/i.test(msg)) {
        // 池内会话中途死亡 —— 丢弃换血，单次重试（诚实恢复不无限）
        pool.midOpDeaths++;
        const dead = pool.sessions.get(poolKey(ws, entry.name));
        if (dead) await discardSession(dead);
        continue;
      }
      const kind = msg.includes("超时") ? "timeout" : msg.includes("spawn") ? "spawn" : "protocol";
      return { ok: false, kind: kind as "timeout" | "spawn" | "protocol", reason: msg };
    }
  }
  // 第二次也死（连 spawn 都起不来或 fn 连续两死）—— 走到这里意味着两次尝试
  // 都抛了非死亡类错误后重入；给出诚实兜底
  return { ok: false, kind: "protocol", reason: `池化会话连续两次操作失败（server ${entry.name} 不稳定 —— 建议检查 server 自身日志）` };
}

export interface McpToolsReport {
  ok: boolean;
  kind: "ok" | "no-config" | "invalid-config" | "unsupported" | "spawn" | "timeout" | "protocol" | "env-ref-missing";
  server: string;
  tools: McpToolDescriptor[];
  serverInfo?: McpServerInfo;
  reason?: string;
}

/** 会话车道选择：fresh = 每操作一会话（v0.5.19 语义）；reuse = 池化长连接（v0.5.20）。 */
export type McpSessionMode = "fresh" | "reuse";

/** 按 session 模式选择会话包装器（fresh 默认 —— 向后兼容 v0.5.19 行为）。 */
function wrapSession<T>(
  mode: McpSessionMode | undefined,
  entry: McpServerEntry,
  ws: string,
  fn: (client: McpClient) => Promise<T>,
  opts?: { requestTimeoutMs?: number },
): Promise<{ ok: true; value: T } | { ok: false; kind: "env-ref-missing" | "spawn" | "timeout" | "protocol"; reason: string }> {
  return mode === "reuse" ? withReusedSession(entry, ws, fn, opts) : withSession(entry, ws, fn, opts);
}

/** tools/list（分页跟进；能力缺席诚实 unsupported）。单 server 或全部（name 省缺）。 */
export async function mcpListTools(ws: string, name?: string, opts?: { session?: McpSessionMode; requestTimeoutMs?: number }): Promise<McpToolsReport[]> {
  const f = loadMcpServers(ws);
  if (f.kind === "absent") return [{ ok: false, kind: "no-config", server: name ?? "*", tools: [], reason: f.reason }];
  if (f.kind === "invalid-json" || f.kind === "not-array") {
    return [{ ok: false, kind: "invalid-config", server: name ?? "*", tools: [], reason: f.reason }];
  }
  const targets = f.entries.filter((e) => !e.disabled && (name === undefined || e.name === name));
  if (name !== undefined && targets.length === 0) {
    const hit = f.entries.find((e) => e.name === name);
    return [{ ok: false, kind: hit?.disabled ? "server-disabled" : "server-not-found", server: name, tools: [], reason: hit?.disabled ? `server ${name} 已停用（disabled）—— 启用后重试` : `server ${name} 未在档案（${MCP_SERVERS_FILE}）—— 不猜默认` }];
  }
  const out: McpToolsReport[] = [];
  for (const entry of targets) {
    const r = await wrapSession(opts?.session, entry, ws, async (client) => {
      const info = client.serverInfo!;
      if (!info.capabilities.tools) {
        return { ok: false as const, kind: "unsupported" as const, server: entry.name, tools: [] as McpToolDescriptor[], reason: `server ${entry.name}（${info.serverName} ${info.serverVersion}）未声明 tools 能力 —— 诚实缺席（协议协商结果）` };
      }
      const tools: McpToolDescriptor[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = (await client.request("tools/list", cursor ? { cursor } : {})) as { tools?: unknown[]; nextCursor?: string } | null ?? {};
        for (const t of Array.isArray(res.tools) ? res.tools : []) {
          if (t !== null && typeof t === "object") {
            const o = t as Record<string, unknown>;
            if (typeof o.name === "string") tools.push({ name: o.name, ...(typeof o.description === "string" ? { description: o.description } : {}), ...(o.inputSchema !== undefined ? { inputSchema: o.inputSchema } : {}) });
          }
        }
        cursor = typeof res.nextCursor === "string" ? res.nextCursor : undefined;
        pages++;
      } while (cursor !== undefined && pages < 8); // 分页帽：防坏 server 无限翻页
      return { ok: true as const, kind: "ok" as const, server: entry.name, tools, serverInfo: info };
    });
    if (r.ok) out.push(r.value as McpToolsReport);
    else out.push({ ok: false, kind: r.kind, server: entry.name, tools: [], reason: r.reason });
  }
  return out;
}

/** tools/call（执行车道 —— CLI 真跑 / 工具环 process_spawn 门 + 审批在环）。 */
export async function mcpCallTool(ws: string, server: string, tool: string, args?: Record<string, unknown>, opts?: { requestTimeoutMs?: number; session?: McpSessionMode }): Promise<McpCallToolResult> {
  const f = loadMcpServers(ws);
  if (f.kind === "absent") return { ok: false, kind: "no-config", server, tool, reason: f.reason };
  if (f.kind === "invalid-json" || f.kind === "not-array") return { ok: false, kind: "protocol", server, tool, reason: f.reason };
  const found = findMcpServer(f, server);
  if ("notFound" in found) {
    return { ok: false, kind: "server-not-found", server, tool, reason: `server ${server} 未在档案（${MCP_SERVERS_FILE}）—— 不猜默认。${MCP_SERVERS_GUIDANCE}` };
  }
  if ("disabled" in found) {
    return { ok: false, kind: "server-disabled", server, tool, reason: `server ${server} 已停用（disabled）—— 启用后重试` };
  }
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    return { ok: false, kind: "invalid-args", server, tool, reason: "arguments 须为 JSON 对象（工具入参键值对）" };
  }
  const entry = found.entry;
  const r = await wrapSession(opts?.session, entry, ws, async (client) => {
    const info = client.serverInfo!;
    if (!info.capabilities.tools) {
      return { ok: false as const, kind: "unsupported" as const, server, tool, reason: `server ${server} 未声明 tools 能力 —— 无法调用（协议协商结果）` };
    }
    const res = (await client.request("tools/call", makeToolsCallParams(tool, args), opts?.requestTimeoutMs)) as
      | { content?: unknown; isError?: boolean; structuredContent?: unknown }
      | null ?? {};
    const content = normalizeContent(res.content);
    return {
      ok: true as const,
      kind: "ok" as const,
      server, tool,
      ...(res.isError === true ? { isError: true } : {}),
      content,
      ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
      serverInfo: info,
    };
  }, { requestTimeoutMs: opts?.requestTimeoutMs, session: opts?.session });
  if (r.ok) return r.value as McpCallToolResult;
  const kind = r.kind === "timeout" ? "timeout" : r.kind === "spawn" ? "spawn" : "protocol";
  return { ok: false, kind, server, tool, reason: r.reason };
}

export interface McpResourcesReport {
  ok: boolean;
  kind: "ok" | "no-config" | "invalid-config" | "server-not-found" | "server-disabled" | "unsupported" | "spawn" | "timeout" | "protocol" | "env-ref-missing";
  server: string;
  resources: McpResourceDescriptor[];
  reason?: string;
}

/** resources/list（能力缺席诚实 unsupported）。 */
export async function mcpListResources(ws: string, name?: string, opts?: { session?: McpSessionMode; requestTimeoutMs?: number }): Promise<McpResourcesReport[]> {
  const f = loadMcpServers(ws);
  if (f.kind === "absent") return [{ ok: false, kind: "no-config", server: name ?? "*", resources: [], reason: f.reason }];
  if (f.kind === "invalid-json" || f.kind === "not-array") return [{ ok: false, kind: "invalid-config", server: name ?? "*", resources: [], reason: f.reason }];
  const targets = f.entries.filter((e) => !e.disabled && (name === undefined || e.name === name));
  if (name !== undefined && targets.length === 0) {
    const hit = f.entries.find((e) => e.name === name);
    return [{ ok: false, kind: hit?.disabled ? "server-disabled" : "server-not-found", server: name, resources: [], reason: hit?.disabled ? `server ${name} 已停用（disabled）—— 启用后重试` : `server ${name} 未在档案 —— 不猜默认` }];
  }
  const out: McpResourcesReport[] = [];
  for (const entry of targets) {
    const r = await wrapSession(opts?.session, entry, ws, async (client) => {
      const info = client.serverInfo!;
      if (!info.capabilities.resources) {
        return { ok: false as const, kind: "unsupported" as const, server: entry.name, resources: [] as McpResourceDescriptor[], reason: `server ${entry.name} 未声明 resources 能力 —— 诚实缺席` };
      }
      const resources: McpResourceDescriptor[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = (await client.request("resources/list", cursor ? { cursor } : {})) as { resources?: unknown[]; nextCursor?: string } | null ?? {};
        for (const t of Array.isArray(res.resources) ? res.resources : []) {
          if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).uri === "string") {
            const o = t as Record<string, unknown>;
            resources.push({ uri: o.uri as string, ...(typeof o.name === "string" ? { name: o.name } : {}), ...(typeof o.description === "string" ? { description: o.description } : {}), ...(typeof o.mimeType === "string" ? { mimeType: o.mimeType } : {}) });
          }
        }
        cursor = typeof res.nextCursor === "string" ? res.nextCursor : undefined;
        pages++;
      } while (cursor !== undefined && pages < 8);
      return { ok: true as const, kind: "ok" as const, server: entry.name, resources };
    });
    if (r.ok) out.push(r.value as McpResourcesReport);
    else out.push({ ok: false, kind: r.kind, server: entry.name, resources: [], reason: r.reason });
  }
  return out;
}

export interface McpReadResult {
  ok: boolean;
  kind: "ok" | "no-config" | "server-not-found" | "server-disabled" | "unsupported" | "spawn" | "timeout" | "protocol" | "env-ref-missing";
  server: string;
  uri: string;
  contents: Array<{ uri: string; mimeType?: string; text?: string }>;
  reason?: string;
}

/** resources/read（只读协议操作）。 */
export async function mcpReadResource(ws: string, server: string, uri: string, opts?: { session?: McpSessionMode; requestTimeoutMs?: number }): Promise<McpReadResult> {
  const f = loadMcpServers(ws);
  if (f.kind === "absent") return { ok: false, kind: "no-config", server, uri, contents: [], reason: f.reason };
  const found = findMcpServer(f, server);
  if ("notFound" in found) return { ok: false, kind: "server-not-found", server, uri, contents: [], reason: `server ${server} 未在档案 —— 不猜默认` };
  if ("disabled" in found) return { ok: false, kind: "server-disabled", server, uri, contents: [], reason: `server ${server} 已停用` };
  const r = await wrapSession(opts?.session, found.entry, ws, async (client) => {
    const info = client.serverInfo!;
    if (!info.capabilities.resources) {
      return { ok: false as const, kind: "unsupported" as const, server, uri, contents: [] as McpReadResult["contents"], reason: `server ${server} 未声明 resources 能力 —— 无法读取` };
    }
    const res = (await client.request("resources/read", { uri })) as { contents?: unknown[] } | null ?? {};
    const contents: McpReadResult["contents"] = [];
    for (const c of Array.isArray(res.contents) ? res.contents : []) {
      if (c !== null && typeof c === "object" && typeof (c as Record<string, unknown>).uri === "string") {
        const o = c as Record<string, unknown>;
        contents.push({ uri: o.uri as string, ...(typeof o.mimeType === "string" ? { mimeType: o.mimeType } : {}), ...(typeof o.text === "string" ? { text: o.text } : {}) });
      }
    }
    return { ok: true as const, kind: "ok" as const, server, uri, contents };
  });
  if (r.ok) return r.value as McpReadResult;
  return { ok: false, kind: r.kind === "timeout" ? "timeout" : r.kind === "spawn" ? "spawn" : "protocol", server, uri, contents: [], reason: r.reason };
}

export interface McpPromptsReport {
  ok: boolean;
  kind: "ok" | "no-config" | "invalid-config" | "server-not-found" | "server-disabled" | "unsupported" | "spawn" | "timeout" | "protocol" | "env-ref-missing";
  server: string;
  prompts: McpPromptDescriptor[];
  reason?: string;
}

/** prompts/list（能力缺席诚实 unsupported）。 */
export async function mcpListPrompts(ws: string, name?: string, opts?: { session?: McpSessionMode; requestTimeoutMs?: number }): Promise<McpPromptsReport[]> {
  const f = loadMcpServers(ws);
  if (f.kind === "absent") return [{ ok: false, kind: "no-config", server: name ?? "*", prompts: [], reason: f.reason }];
  if (f.kind === "invalid-json" || f.kind === "not-array") return [{ ok: false, kind: "invalid-config", server: name ?? "*", prompts: [], reason: f.reason }];
  const targets = f.entries.filter((e) => !e.disabled && (name === undefined || e.name === name));
  if (name !== undefined && targets.length === 0) {
    const hit = f.entries.find((e) => e.name === name);
    return [{ ok: false, kind: hit?.disabled ? "server-disabled" : "server-not-found", server: name, prompts: [], reason: hit?.disabled ? `server ${name} 已停用（disabled）—— 启用后重试` : `server ${name} 未在档案 —— 不猜默认` }];
  }
  const out: McpPromptsReport[] = [];
  for (const entry of targets) {
    const r = await wrapSession(opts?.session, entry, ws, async (client) => {
      const info = client.serverInfo!;
      if (!info.capabilities.prompts) {
        return { ok: false as const, kind: "unsupported" as const, server: entry.name, prompts: [] as McpPromptDescriptor[], reason: `server ${entry.name} 未声明 prompts 能力 —— 诚实缺席` };
      }
      const res = (await client.request("prompts/list", {})) as { prompts?: unknown[] } | null ?? {};
      const prompts: McpPromptDescriptor[] = [];
      for (const p of Array.isArray(res.prompts) ? res.prompts : []) {
        if (p !== null && typeof p === "object" && typeof (p as Record<string, unknown>).name === "string") {
          const o = p as Record<string, unknown>;
          prompts.push({ name: o.name as string, ...(typeof o.description === "string" ? { description: o.description } : {}) });
        }
      }
      return { ok: true as const, kind: "ok" as const, server: entry.name, prompts };
    });
    if (r.ok) out.push(r.value as McpPromptsReport);
    else out.push({ ok: false, kind: r.kind, server: entry.name, prompts: [], reason: r.reason });
  }
  return out;
}

// ---- 协议自检（纯内存 —— 无 server 也能锁协议层形状）---------------------------

export interface McpSelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface McpSelfTestResult {
  ok: boolean;
  passed: number;
  total: number;
  checks: McpSelfTestCheck[];
}

export function mcpSelfTest(): McpSelfTestResult {
  const checks: McpSelfTestCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  };

  // 分帧
  check(
    "换行分帧：编码单行 + \\n",
    encodeMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping" }) === '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
  );
  let encErr = false;
  try { encodeMcpMessage({ jsonrpc: "2.0", method: "x", params: { a: "b\nc" } }); } catch { encErr = true; }
  const encLines = encodeMcpMessage({ jsonrpc: "2.0", method: "x", params: { a: "b\nc" } }).split("\n");
  check("换行分帧：含换行字符串序列化为单行（转义保证）", encLines.length === 2 && encLines[0].includes("\\n"), encErr ? "意外抛错" : "1 行 JSON + 终止符");
  const dec = decodeMcpMessages('{"jsonrpc":"2.0","id":1,"result":{}}\nnot-json\n[1,2]\n\n{"jsonrpc":"2.0","method":"n"}\n');
  check("换行分帧：跨行解码 + 坏行拒收计数", dec.messages.length === 2 && dec.rejected === 2, `messages=${dec.messages.length} rejected=${dec.rejected}`);
  const d2 = new McpLineDecoder();
  const half = d2.push('{"jsonrpc":"2.0","id":7,');
  const rest = d2.push('"result":42}\n');
  check("换行分帧：跨 chunk 半行缓冲", half.length === 0 && rest.length === 1 && (rest[0].result as number) === 42);

  // 构造器
  const init = makeInitializeParams();
  check(
    "initialize 参数：protocolVersion/capabilities/clientInfo 三件齐",
    init.protocolVersion === MCP_PROTOCOL_VERSION &&
      typeof (init.clientInfo as { name: string }).name === "string" &&
      (init.capabilities as Record<string, unknown> !== undefined),
  );
  const call = makeToolsCallParams("echo", { a: 1 });
  check("tools/call 参数：name + arguments", call.name === "echo" && (call.arguments as { a: number }).a === 1);
  const err = makeMcpError(5, JSONRPC_ERROR_CODES.METHOD_NOT_FOUND, "nope");
  check("错误响应构造：-32601 形状", err.error?.code === -32601 && err.id === 5);

  // 档案校验
  check("档案校验：合法条目过检", validateMcpServerEntry({ name: "s", command: "bun", args: ["a.ts"] }).ok);
  check("档案校验：缺 name 拒绝", !validateMcpServerEntry({ command: "bun" }).ok);
  check("档案校验：缺 command 拒绝", !validateMcpServerEntry({ name: "s" }).ok);
  check("档案校验：args 非字符串数组拒绝", !validateMcpServerEntry({ name: "s", command: "bun", args: [1] }).ok);
  check(
    "秘密策略：API_KEY 字面值拒绝",
    !validateMcpServerEntry({ name: "s", command: "bun", env: { API_KEY: "sk-literal" } }).ok,
  );
  check(
    "秘密策略：API_KEY $env: 引用放行",
    validateMcpServerEntry({ name: "s", command: "bun", env: { API_KEY: "$env:MY_KEY" } }).ok,
  );
  check(
    "秘密策略：非秘密键字面值放行",
    validateMcpServerEntry({ name: "s", command: "bun", env: { LOG_LEVEL: "debug" } }).ok,
  );

  // env 引用解析
  const savedKey = process.env.ORG_MCP_SELFTEST_KEY;
  process.env.ORG_MCP_SELFTEST_KEY = "s3cret-value";
  try {
    const r1 = resolveMcpEnv({ name: "s", command: "bun", env: { API_KEY: "$env:ORG_MCP_SELFTEST_KEY", LOG: "info" } });
    check("env 引用解析：$env: 取父环境值 + 字面值直传", r1.ok && r1.env.API_KEY === "s3cret-value" && r1.env.LOG === "info");
  } finally {
    if (savedKey === undefined) delete process.env.ORG_MCP_SELFTEST_KEY;
    else process.env.ORG_MCP_SELFTEST_KEY = savedKey;
  }
  const r2 = resolveMcpEnv({ name: "s", command: "bun", env: { API_KEY: "$env:ORG_MCP_DEFINITELY_MISSING_VAR" } });
  check("env 引用解析：引用缺席诚实拒绝", !r2.ok && (r2.reason ?? "").includes("父进程环境无此变量"));

  // 内容归一
  const c = normalizeContent([
    { type: "text", text: "hello" },
    { type: "image", data: "x", mimeType: "image/png" },
    { type: "resource", resource: { uri: "file:///x" } },
    { type: "text", text: "world" },
  ]);
  check("内容归一：text 拼接 + image/resource 计数", c.text === "hello\nworld" && c.textBlocks === 2 && c.imageBlocks === 1 && c.resourceBlocks === 1 && !c.truncated);
  const big = normalizeContent([{ type: "text", text: "x".repeat(40 * 1024) }]);
  check("内容归一：16KB 帽截断", big.truncated && big.text.includes("MCP 内容已截断"));
  check("内容归一：非数组内容零炸", normalizeContent(null).text === "" && normalizeContent("nope").textBlocks === 0);

  // 协商记录面
  check("JSON-RPC 错误码表：五码齐", JSONRPC_ERROR_CODES.PARSE_ERROR === -32700 && JSONRPC_ERROR_CODES.METHOD_NOT_FOUND === -32601 && JSONRPC_ERROR_CODES.INTERNAL_ERROR === -32603);

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
