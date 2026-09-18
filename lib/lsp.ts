// ============================================================================
// lib/lsp.ts — LSP/DAP 协议集成（v0.5.17 · capabilities #26）
// ----------------------------------------------------------------------------
// 「语言服务器协议」的双车道诚实实现：
//   · 协议层（本模块地基，LSP 与 DAP 共用）：JSON-RPC 2.0 消息封装 +
//     Content-Length 头分帧（流式解码器处理粘包/半包；字节级精确 —— CJK
//     多字节体的 Content-Length 按字节数计，不按字符数）；构造器全家桶
//     makeLspRequest / makeLspResponse / makeLspNotification / makeLspError，
//     生命周期消息（initialize → initialized → shutdown → exit）齐备。
//     任何外部 LSP server 都能用这一层对话 —— 与 vscode-jsonrpc 的传输层
//     同语义（本模块不依赖它，零依赖手搓）。
//   · 内置回退车道（多重降级第 1 层，缺省主车道）：无外部 server 时，基于
//     lib/symbols.ts 符号索引实现 lspDefinition（名字→声明位置）/
//     lspReferences（引用列表，call/mention 分类）/ lspHover（符号 kind +
//     所在文件行上下文）—— 零依赖诚实实现，输出同时给 LSP 规范形
//     （uri + range，0 基）与人读形（相对 file + 1 基行列）。
//   · 外部 server 车道（降级第 2 层）：detectLspServers 探测环境里可用的
//     语言服务器（typescript-language-server / pylsp / gopls …，Bun.which
//     探测）；spawnLspServer(cmd, args) 真协议对话（initialize → initialized
//     → 请求/通知 → shutdown → exit 全生命周期），响应按 id 关联、超时
//     诚实拒绝、server 早夭不连坐。沙箱内大概率没有 server —— 内置车道
//     是主车道，但协议层与 spawn 层真实可用（tests/lsp.test.ts 用 echo 型
//     假 server 锁定全生命周期）。
//
//   jail 铁律：所有 file 形入参经 resolveJailedFile（lib/pathjail.ts 同形
//   比较 —— 分隔符归一 + win32 大小写折叠）—— 越界即拒，绝不静默放行。
//   名字形入参（name）过标识符白名单正则（防正则注入，与 symbols.ts
//   findRefs 同规）。
//
// 诚实边界（文件头写明）：
//   · 内置车道是符号索引级：不做作用域解析 / 类型推断 / 文档标记
//     （Markdown 富文本 hover）—— lib/symbols.ts 的行级扫描边界原样继承；
//   · 外部 server 车道只封装「stdio 传输 + 生命周期 + 请求关联」：不启动
//     具体语言的 server（沙箱无），不做 didOpen/didChange 增量同步 ——
//     真编辑器级 LSP 会话（文档同步/补全/格式化/代码动作）是路线图；
//   · DAP 消息构造器在 lib/debug.ts（与这里的分帧层共用 —— DAP 帧与 LSP
//     帧同为 Content-Length + JSON body）。
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { indexSymbols, lookupDef, findRefs, type SymbolHit, type SymbolRef, type SymbolKind } from "./symbols.ts";
import { inWorkspace, jailRelative, resolveInWorkspace } from "./pathjail.ts";

// ---- 常量 -------------------------------------------------------------------

/** 车道标记：builtin = 符号索引内置车道；server = 外部 LSP server 车道。 */
export type LspLane = "builtin" | "server";

/** JSON-RPC 2.0 标准错误码（LSP 沿用；构造器与错误分类共用）。 */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
  REQUEST_CANCELLED: -32800,
} as const;

/** 名字形入参的标识符白名单（与 symbols.ts findRefs 同规 —— 防正则注入）。 */
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 内置车道缺省扫描根：dirs:[""] = 工作区根扫描（v0.5.16 起的 agent 工作区口径）。 */
export const DEFAULT_LSP_DIRS: string[] = [""];

/** 引用列号精确化的逐文件读取帽（防极端引用面拖死交互 —— 超帽时列号诚实置 0）。 */
const COLUMN_FILES_CAP = 200;

/** LSP 客户端缺省超时（ms）：initialize / 普通请求 / shutdown 收尾。 */
export const LSP_TIMEOUTS = { initialize: 15_000, request: 15_000, shutdown: 8_000 } as const;

/** 已知语言服务器探测清单（name 人读 · cmd 可执行名 · args stdio 启动参数）。 */
export const KNOWN_LSP_SERVERS: ReadonlyArray<{ name: string; cmd: string; args: string[] }> = [
  { name: "typescript-language-server", cmd: "typescript-language-server", args: ["--stdio"] },
  { name: "pylsp", cmd: "pylsp", args: [] },
  { name: "pyright-langserver", cmd: "pyright-langserver", args: ["--stdio"] },
  { name: "gopls", cmd: "gopls", args: [] },
  { name: "rust-analyzer", cmd: "rust-analyzer", args: [] },
  { name: "clangd", cmd: "clangd", args: [] },
  { name: "bash-language-server", cmd: "bash-language-server", args: ["start"] },
];

// ---- 协议层：JSON-RPC 2.0 消息与 Content-Length 分帧 --------------------------

/** 一条 JSON-RPC 2.0 消息（请求/响应/通知共用载体；DAP 消息不含 jsonrpc 字段）。 */
export interface LspMessage {
  jsonrpc?: "2.0";
  /** 请求 id（请求与响应才有；通知无 id）。 */
  id?: number | string;
  /** 方法名（请求与通知才有）。 */
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 请求消息（id + method + params）。 */
export interface LspRequestMessage extends LspMessage {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
}

/** 通知消息（method + params，无 id —— 无响应）。 */
export interface LspNotificationMessage extends LspMessage {
  jsonrpc: "2.0";
  method: string;
}

/**
 * 编码一帧：`Content-Length: <字节数>\r\n\r\n<JSON body>`。
 * body 为任意可 JSON 序列化对象 —— LSP 消息与 DAP 消息共用这一层
 * （两者分帧同形：Content-Length 头 + JSON 体，DAP 体不含 jsonrpc 字段）。
 * Content-Length 按字节计（Buffer.byteLength —— CJK 多字节体不漂移）。
 */
export function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

/** 多帧拼接（粘包构造 —— 自检/测试用）。 */
export function encodeLspMessages(bodies: unknown[]): string {
  return bodies.map((b) => encodeLspMessage(b)).join("");
}

/** 帧头解析结果：body 字节数 + 头部长度（含空行）；null = 尚不完整。 */
interface FrameHeader {
  contentLength: number;
  headerEnd: number; // header + \r\n\r\n 的总字节数
}

/** 在缓冲里找一帧完整头（Content-Length 必需；容忍附加头行与 \n\n 松散形）。 */
function parseHeader(buf: Buffer): FrameHeader | null {
  // 规范形优先：\r\n\r\n
  let idx = buf.indexOf("\r\n\r\n");
  let sepLen = 4;
  let loose = false;
  if (idx < 0) {
    // 松散形兜底：\n\n（个别 server 用 LF 分隔头与体 —— 防御性兼容）
    idx = buf.indexOf("\n\n");
    if (idx < 0) return null;
    sepLen = 2;
    loose = true;
  }
  const headerText = buf.subarray(0, idx).toString("latin1");
  let contentLength = -1;
  for (const line of headerText.split(loose ? "\n" : "\r\n")) {
    const m = /^Content-Length:\s*(\d+)\s*$/i.exec(line.trim());
    if (m) {
      contentLength = Number(m[1]);
      break;
    }
  }
  if (contentLength < 0) return null;
  return { contentLength, headerEnd: idx + sepLen };
}

/** 一次性解码：完整缓冲 → 消息数组 + 尾部半包字节数（粘包多帧一并吐出）。 */
export function decodeLspMessage(buf: string | Buffer): { messages: LspMessage[]; pendingBytes: number } {
  const decoder = new LspFrameDecoder();
  const messages = decoder.push(buf);
  return { messages, pendingBytes: decoder.pendingBytes() };
}

/**
 * 流式帧解码器：push 任意分块的字节流，吐出已完整的消息；半包留在内部
 * 缓冲（pendingBytes() 可观测），下一块续推补全。粘包（一 chunk 多帧）/
 * 半包（一帧跨多 chunk，含头部截断与体部截断）都被正确处理。
 */
export class LspFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private badFrames = 0;

  /** 推入一块字节流，返回其中已完整成帧的消息（可能为空数组 —— 半包等待）。 */
  push(chunk: string | Buffer): LspMessage[] {
    const add = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.buf = this.buf.length === 0 ? add : Buffer.concat([this.buf, add]);
    const out: LspMessage[] = [];
    for (;;) {
      const header = parseHeader(this.buf);
      if (header === null) break; // 头不完整（或非协议流）
      if (this.buf.length < header.headerEnd + header.contentLength) break; // 体不完整（半包）
      const body = this.buf.subarray(header.headerEnd, header.headerEnd + header.contentLength);
      this.buf = this.buf.subarray(header.headerEnd + header.contentLength);
      try {
        const msg = JSON.parse(body.toString("utf8"));
        // JSON-RPC 消息必须是对象（数组/标量拒收并计数 —— 防御纵深）
        if (msg && typeof msg === "object" && !Array.isArray(msg)) out.push(msg as LspMessage);
        else this.badFrames++;
      } catch {
        this.badFrames++; // 坏 JSON：跳过该帧不炸流（与 HSL 工具环「坏 JSON 跳过」同哲学）
      }
    }
    return out;
  }

  /** 当前半包缓冲字节数（可观测性：调用方可知流是否在等尾部）。 */
  pendingBytes(): number {
    return this.buf.length;
  }

  /** 累计拒收帧数（坏 JSON / 非对象体）。 */
  rejectedFrames(): number {
    return this.badFrames;
  }

  /** 丢弃缓冲（连接重置时调用方显式清态）。 */
  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

// ---- 协议层：消息构造器 --------------------------------------------------------

/** 构造一条 JSON-RPC 2.0 请求（id + method + params）。 */
export function makeLspRequest(id: number | string, method: string, params?: unknown): LspRequestMessage {
  const msg: LspRequestMessage = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** 构造一条响应（id + result）。 */
export function makeLspResponse(id: number | string, result: unknown): LspMessage {
  return { jsonrpc: "2.0", id, result };
}

/** 构造一条错误响应（id + error{code, message}）。 */
export function makeLspError(id: number | string, code: number, message: string, data?: unknown): LspMessage {
  const msg: LspMessage = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) msg.error!.data = data;
  return msg;
}

/** 构造一条通知（method + params，无 id —— 无响应）。 */
export function makeLspNotification(method: string, params?: unknown): LspNotificationMessage {
  const msg: LspNotificationMessage = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** LSP initialize 请求参数（进程 id / 根目录 / 客户端能力 —— 规范忠实形）。 */
export function makeInitializeParams(rootUri: string, clientInfo?: { name: string; version?: string }): Record<string, unknown> {
  return {
    processId: process.pid ?? null,
    rootUri,
    clientInfo: clientInfo ?? { name: "org-lsp-client", version: "0.5.17" },
    locale: "en",
    capabilities: {}, // 诚实边界：我们不用编辑器集成能力（didOpen/补全路由等），空集
  };
}

/** initialized 通知参数（规范固定空对象）。 */
export function makeInitializedNotification(): LspNotificationMessage {
  return makeLspNotification("initialized", {});
}

/** shutdown 请求（规范固定无参数）。 */
export function makeShutdownRequest(id: number | string): LspRequestMessage {
  return makeLspRequest(id, "shutdown");
}

/** exit 通知（规范固定无参数 —— server 收到即退出）。 */
export function makeExitNotification(): LspNotificationMessage {
  return makeLspNotification("exit");
}

/** 文件路径 → file:// URI（POSIX 形；win32 盘符 C:\ → file:///c:/）。 */
export function fileUri(absPath: string): string {
  const n = absPath.replace(/\\/g, "/");
  return n.startsWith("/") ? `file://${n}` : `file:///${n}`;
}

// ---- jail 铁律：file 形入参统一入口 -------------------------------------------

/** jail 解析结果：ok=false 时 abs/rel 为空且 reason 说明（越界即拒）。 */
export interface JailedFile {
  ok: boolean;
  /** 绝对路径（jail 通过时）。 */
  abs: string;
  /** 工作区相对路径（正斜杠，jail 通过时；与 SymbolHit.file 同形）。 */
  rel: string;
  reason?: string;
}

/**
 * 工作区文件入参的监狱判定（所有 file 形入参必经）：相对路径解析进 ws、
 * 绝对路径原样接受但都必须 inWorkspace；越界（../ 逃逸 / 盘外绝对路径）
 * 即拒。与 complete_at/rename_symbol 工具环同一条 pathjail 真源。
 */
export function resolveJailedFile(ws: string, file: string): JailedFile {
  const p = String(file ?? "");
  if (p.length === 0) return { ok: false, abs: "", rel: "", reason: "file 必填" };
  const abs = resolveInWorkspace(ws, p);
  if (!inWorkspace(ws, abs)) {
    return { ok: false, abs: "", rel: "", reason: `路径越界（须在工作区内）：${p}` };
  }
  return { ok: true, abs, rel: jailRelative(ws, abs) };
}

// ---- 内置车道：符号索引上的 definition / references / hover --------------------

/** LSP 规范形位置（0 基 line/character —— VSCode 风格）。 */
export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** 一处定义命中（LSP 规范形 uri+range 与人读形 file/line/column 双给出）。 */
export interface BuiltinDefinition {
  kind: SymbolKind;
  name: string;
  /** 工作区相对路径（正斜杠）。 */
  file: string;
  /** 1 基行号（人读 —— 与 SymbolHit 同形）。 */
  line: number;
  /** 1 基列（名字首字符在行内的偏移 + 1；文件不可读时 0 降级）。 */
  column: number;
  /** LSP 规范形（file:// URI + 0 基 range）。 */
  lsp: { uri: string; range: LspRange };
  snippet: string;
}

/** lspDefinition 结果。 */
export interface LspDefinitionResult {
  ok: boolean;
  lane: LspLane;
  name: string;
  definitions: BuiltinDefinition[];
  reason?: string;
}

/** 一次引用命中（call=带调用括号 · mention=纯提及；LSP 规范形并列给出）。 */
export interface BuiltinReference {
  file: string;
  /** 1 基行号。 */
  line: number;
  /** 1 基列（0 = 文件不可读的降级值）。 */
  column: number;
  kind: "call" | "mention";
  snippet: string;
  lsp: { uri: string; range: LspRange };
}

/** lspReferences 结果。 */
export interface LspReferencesResult {
  ok: boolean;
  lane: LspLane;
  name: string;
  refs: BuiltinReference[];
  /** 定义数（引用列表排除定义行 —— 定义数并列给出，不吞信息）。 */
  definitions: number;
  truncated?: boolean;
  reason?: string;
}

/** hover 内容（contents 为 LSP MarkedString[] 的纯文本子集 —— 诚实边界：无 Markdown 富文本）。 */
export interface BuiltinHover {
  kind: SymbolKind;
  name: string;
  file: string;
  /** 1 基行号。 */
  line: number;
  /** 符号所在行原文（trim，≤120 字符）。 */
  lineText: string;
  contents: string[];
}

/** lspHover 结果（未找到 → hover:null + reason —— LSP 对未知符号也返回 null，不是错误）。 */
export interface LspHoverResult {
  ok: boolean;
  lane: LspLane;
  name: string;
  hover: BuiltinHover | null;
  reason?: string;
}

/** 词法边界包裹（symbols.ts 同规 —— \b 的标识符精确版）。 */
function columnOf(name: string, rawLine: string): number {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$])(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?:$|[^A-Za-z0-9_$])`);
  const m = re.exec(rawLine);
  return m === null ? 0 : (m.index === 0 ? 0 : m.index + 1);
}

/** 读文件行集（CRLF 归一；读失败 → null —— 调用方各自降级）。 */
function readLines(abs: string): string[] | null {
  try {
    const text = fs.readFileSync(abs, "utf-8");
    return (text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text).split("\n");
  } catch {
    return null;
  }
}

/** SymbolHit → BuiltinDefinition（列号精确化：读定义行原文定位名字偏移）。 */
function toDefinition(ws: string, hit: SymbolHit): BuiltinDefinition {
  const abs = path.join(ws, hit.file);
  const lines = readLines(abs);
  const raw = lines?.[hit.line - 1] ?? hit.snippet;
  const col0 = columnOf(hit.name, raw); // 0 基字符偏移
  return {
    kind: hit.kind,
    name: hit.name,
    file: hit.file,
    line: hit.line,
    column: col0 + 1,
    lsp: {
      uri: fileUri(abs),
      range: {
        start: { line: hit.line - 1, character: col0 },
        end: { line: hit.line - 1, character: col0 + hit.name.length },
      },
    },
    snippet: hit.snippet,
  };
}

/**
 * 定义查找（内置车道）：lookupDef 两层语义（大小写敏感优先 → 不敏感兜底）
//  原样继承；输出双形（人读 1 基 + LSP 0 基 uri/range）。
 */
export function lspDefinition(ws: string, name: string, opts?: { dirs?: string[] }): LspDefinitionResult {
  const lane: LspLane = "builtin";
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { ok: false, lane, name: String(name ?? ""), definitions: [], reason: "非法符号名（须为标识符）" };
  }
  const idx = indexSymbols(ws, opts?.dirs ?? DEFAULT_LSP_DIRS);
  const defs = lookupDef(idx.symbols, name);
  if (defs.length === 0) {
    return { ok: true, lane, name, definitions: [], reason: `符号未在索引中找到（${idx.files} 文件 · 定义面空 —— 引用可试 lsp references）` };
  }
  return { ok: true, lane, name, definitions: defs.map((h) => toDefinition(ws, h)) };
}

/**
 * 引用查找（内置车道）：findRefs 原样继承（定义行排除 / call vs mention /
 * maxHits 帽），列号精确化按唯一文件分组读取（超 COLUMN_FILES_CAP 文件时
 * 列号诚实置 0 —— 引用行本身仍准确）。
 */
export function lspReferences(ws: string, name: string, opts?: { dirs?: string[]; maxHits?: number }): LspReferencesResult {
  const lane: LspLane = "builtin";
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { ok: false, lane, name: String(name ?? ""), refs: [], definitions: 0, reason: "非法符号名（须为标识符）" };
  }
  const maxHits = typeof opts?.maxHits === "number" && Number.isFinite(opts.maxHits) ? Math.max(0, Math.floor(opts.maxHits)) : 200;
  const idx = indexSymbols(ws, opts?.dirs ?? DEFAULT_LSP_DIRS);
  const defs = lookupDef(idx.symbols, name);
  const refs = findRefs(ws, name, { dirs: opts?.dirs ?? DEFAULT_LSP_DIRS, maxHits });
  const out: BuiltinReference[] = [];
  const linesCache = new Map<string, string[] | null>();
  for (const r of refs) {
    const abs = path.join(ws, r.file);
    let col0 = 0;
    if (linesCache.size < COLUMN_FILES_CAP || linesCache.has(r.file)) {
      if (!linesCache.has(r.file)) linesCache.set(r.file, readLines(abs));
      const raw = linesCache.get(r.file)?.[r.line - 1];
      if (raw !== undefined) col0 = columnOf(name, raw);
    }
    out.push({
      file: r.file,
      line: r.line,
      column: col0 + 1,
      kind: r.kind,
      snippet: r.snippet,
      lsp: {
        uri: fileUri(abs),
        range: {
          start: { line: r.line - 1, character: col0 },
          end: { line: r.line - 1, character: col0 + name.length },
        },
      },
    });
  }
  return {
    ok: true,
    lane,
    name,
    refs: out,
    definitions: defs.length,
    ...(refs.length >= 200 ? { truncated: true } : {}),
    ...(refs.length === 0 && defs.length === 0 ? { reason: `符号未在索引中找到（${idx.files} 文件）` } : {}),
  };
}

/**
 * hover（内置车道）：符号 kind + 所在文件行上下文。contents 为纯文本数组
 * （LSP MarkedString[] 的诚实子集 —— 无类型签名/无 Markdown 文档，正则
 * 词法级索引给不出类型，不臆造）。未找到 → hover:null + reason（LSP 同
//  形态：未知符号的 hover 是 null 不是错误）。
 */
export function lspHover(ws: string, name: string, opts?: { dirs?: string[] }): LspHoverResult {
  const lane: LspLane = "builtin";
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { ok: false, lane, name: String(name ?? ""), hover: null, reason: "非法符号名（须为标识符）" };
  }
  const idx = indexSymbols(ws, opts?.dirs ?? DEFAULT_LSP_DIRS);
  const defs = lookupDef(idx.symbols, name);
  if (defs.length === 0) {
    return { ok: true, lane, name, hover: null, reason: `符号未在索引中找到（大小写敏感优先 + 不敏感兜底均已尝试 · ${idx.files} 文件）` };
  }
  const hit = defs[0]!;
  const abs = path.join(ws, hit.file);
  const lines = readLines(abs);
  const lineText = (lines?.[hit.line - 1] ?? hit.snippet).trim().slice(0, 120);
  return {
    ok: true,
    lane,
    name,
    hover: {
      kind: hit.kind,
      name: hit.name,
      file: hit.file,
      line: hit.line,
      lineText,
      contents: [
        `${hit.kind} ${hit.name}`,
        `定义：${hit.file}:${hit.line}`,
        lineText,
      ],
    },
  };
}

// ---- 外部 server 车道：探测 + spawn + 全生命周期客户端 --------------------------

/** 一个语言服务器探测结果。 */
export interface LspServerProbe {
  name: string;
  cmd: string;
  args: string[];
  available: boolean;
  /** which 命中的绝对路径（缺席为 null）。 */
  path: string | null;
}

/** 探测环境可用的语言服务器（Bun.which —— 缺席是诚实降级不是失败）。 */
export function detectLspServers(): LspServerProbe[] {
  const out: LspServerProbe[] = [];
  for (const s of KNOWN_LSP_SERVERS) {
    let p: string | null = null;
    try {
      p = (Bun as unknown as { which?: (c: string) => string | null }).which?.(s.cmd) ?? null;
    } catch {
      p = null; // which 异常（理论上不到这）→ 缺席
    }
    out.push({ name: s.name, cmd: s.cmd, args: [...s.args], available: p !== null, path: p });
  }
  return out;
}

/** LspClient 可选项。 */
export interface LspClientOptions {
  /** initialize 的 rootUri（缺省 file:// + process.cwd()）。 */
  rootUri?: string;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/** 一条待关联的请求（id → resolve/reject + 超时定时器）。 */
interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 外部 LSP server 客户端（stdio 车道）：spawn 子进程，Content-Length 分帧
 * 对话；响应按 id 关联；server→client 通知（window/logMessage 等）收集在
 * notifications；server→client 请求（workspace/configuration 等）自动空响应
 * 并收集（workspace/configuration 按规范回等长 null 数组）。生命周期：
 * initialize() → initialized 通知 → request()/notify() → shutdown()
 * （shutdown 请求 → exit 通知 → 等退出，超时 kill 兜底）。
 */
export class LspClient {
  readonly cmd: string;
  readonly args: string[];
  /** initialize 响应里的 server capabilities（initialize() 后可用）。 */
  serverCapabilities: Record<string, unknown> | null = null;
  /** server→client 通知（window/logMessage 等）。 */
  notifications: LspMessage[] = [];
  /** server→client 请求（已自动响应，原样收集供观测）。 */
  serverRequests: LspMessage[] = [];
  exited = false;
  exitCode: number | null = null;

  private proc: ReturnType<typeof Bun.spawn>;
  private decoder = new LspFrameDecoder();
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private opts: Required<Pick<LspClientOptions, "initializeTimeoutMs" | "requestTimeoutMs" | "shutdownTimeoutMs">> & { rootUri: string };
  private stderrTail = "";
  private started = false;

  private constructor(cmd: string, args: string[], proc: ReturnType<typeof Bun.spawn>, opts: LspClientOptions) {
    this.cmd = cmd;
    this.args = [...args];
    this.proc = proc;
    this.opts = {
      rootUri: opts.rootUri ?? fileUri(process.cwd()),
      initializeTimeoutMs: opts.initializeTimeoutMs ?? LSP_TIMEOUTS.initialize,
      requestTimeoutMs: opts.requestTimeoutMs ?? LSP_TIMEOUTS.request,
      shutdownTimeoutMs: opts.shutdownTimeoutMs ?? LSP_TIMEOUTS.shutdown,
    };
    // stdout 流式解码（ReadableStream<Uint8Array> → 分帧）
    void (async () => {
      try {
        for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          for (const msg of this.decoder.push(Buffer.from(chunk))) this.dispatch(msg);
        }
      } catch {
        // 流关闭（进程退出）—— pending 由 exited 钩子收尾
      }
    })();
    // stderr 收尾尾巴（诊断用，8KB 帽）
    void (async () => {
      try {
        for await (const chunk of this.proc.stderr as unknown as AsyncIterable<Uint8Array>) {
          this.stderrTail = (this.stderrTail + Buffer.from(chunk).toString("utf-8")).slice(-8192);
        }
      } catch { /* 同上 */ }
    })();
    // 退出钩子：pending 全部诚实拒绝（server 早夭不连坐）
    void this.proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`LSP server 已退出（code=${code}${this.stderrTail ? ` · stderr 尾巴：${this.stderrTail.slice(-400)}` : ""}）`));
      }
      this.pending.clear();
    });
  }

  /** 消息分发：响应（id+result/error）→ 关联；通知（method 无 id）→ 收集；
   *  server 请求（method+id）→ 自动响应 + 收集。 */
  private dispatch(msg: LspMessage): void {
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        // server→client 请求：自动响应（诚实最小实现 —— workspace/configuration
        // 按规范回等长 null 数组；其余回 null result）
        this.serverRequests.push(msg);
        let result: unknown = null;
        if (msg.method === "workspace/configuration" && (msg.params as { items?: unknown[] } | undefined)?.items !== undefined) {
          result = new Array((msg.params as { items: unknown[] }).items.length).fill(null);
        }
        this.write(makeLspResponse(msg.id, result));
      } else {
        this.notifications.push(msg);
      }
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p === undefined) return; // 未知 id（重复响应/迟到的取消）—— 丢弃
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        p.reject(new Error(`LSP 错误响应 ${msg.method ?? p.method}：code=${msg.error.code} ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
    // 其余形态（无 method 无 id 无 result）—— 坏消息丢弃（解码器已拒非对象）
  }

  /** 写一帧到 server stdin。 */
  private write(msg: unknown): void {
    try {
      const sink = this.proc.stdin as unknown as { write: (s: string) => number; flush: () => void };
      sink.write(encodeLspMessage(msg));
      sink.flush();
    } catch (e) {
      // stdin 已关（server 先退）—— 由 exited 钩子拒绝 pending；写失败不炸
      if (!this.exited) throw new Error(`写 server stdin 失败：${(e as Error).message}`);
    }
  }

  /** initialize → initialized 生命周期（返回 server capabilities）。 */
  async initialize(): Promise<Record<string, unknown>> {
    if (this.started) throw new Error("LspClient 已 initialize 过（单会话客户端）");
    this.started = true;
    const caps = await this.request(
      "initialize",
      makeInitializeParams(this.opts.rootUri),
      this.opts.initializeTimeoutMs,
    );
    this.serverCapabilities = (caps ?? {}) as Record<string, unknown>;
    this.notify("initialized", {});
    return this.serverCapabilities;
  }

  /** 发一条请求并等响应（id 自动递增；超时/错误响应/early-exit 均诚实拒绝）。 */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`LSP server 已退出（code=${this.exitCode}）—— 无法发 ${method}`));
    const id = this.nextId++;
    const msg = makeLspRequest(id, method, params);
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时（${timeout}ms）：${method}`));
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

  /** 发一条通知（无响应 —— fire and forget，写失败诚实抛出）。 */
  notify(method: string, params?: unknown): void {
    if (this.exited) throw new Error(`LSP server 已退出（code=${this.exitCode}）—— 无法发通知 ${method}`);
    this.write(makeLspNotification(method, params));
  }

  /** shutdown → exit → 等退出（超时 kill 兜底；返回退出码与是否被 kill）。 */
  async shutdown(): Promise<{ exitCode: number | null; killed: boolean }> {
    // shutdown 请求（规范：结果为 null；server 已退时诚实跳过）
    let killed = false;
    if (!this.exited) {
      try {
        await this.request("shutdown", undefined, this.opts.shutdownTimeoutMs);
      } catch {
        // server 早夭 / 超时 —— exit 通知照发，让生命周期语义完整
      }
      if (!this.exited) {
        try {
          this.notify("exit");
        } catch { /* stdin 已关 —— 等退出钩子 */ }
      }
    }
    if (!this.exited) {
      const timeout = this.opts.shutdownTimeoutMs;
      const exited = await Promise.race([
        this.proc.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
      ]);
      if (!exited) {
        try { this.proc.kill(); } catch { /* 已退 */ }
        killed = true;
        await this.proc.exited;
      }
    }
    try {
      const sink = this.proc.stdin as unknown as { end?: () => void };
      sink?.end?.();
    } catch { /* 已关 */ }
    return { exitCode: this.exitCode, killed };
  }

  /** stderr 尾巴（诊断面；≤8KB）。 */
  stderr(): string {
    return this.stderrTail;
  }
}

/**
 * spawn 一个外部 LSP server 并返回客户端（真协议车道）：spawn 失败（命令
 * 不存在 / 无执行权限）诚实拒绝 —— kind:"spawn" 错误，绝不静默。这是
 * 「多重降级第 2 层」：环境里没有 server 时调用方应落回内置车道。
 */
export async function spawnLspServer(cmd: string, args: string[] = [], opts: LspClientOptions = {}): Promise<LspClient> {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new Error("spawnLspServer：cmd 必填（如 typescript-language-server）");
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
  } catch (e) {
    throw new Error(`LSP server spawn 失败：${cmd}（${(e as Error).message}）—— 环境无此命令时请用内置符号索引车道`);
  }
  return new LspClient(cmd, args, proc, opts);
}

// ---- 协议层自检 ---------------------------------------------------------------

/** 一项自检结果。 */
export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** protocolSelfTest 结果。 */
export interface SelfTestResult {
  ok: boolean;
  passed: number;
  total: number;
  checks: SelfTestCheck[];
}

/**
 * 协议层自检（CLI `org lsp protocol --self-test` / Web protocol-selftest 的
 * 数据源）：分帧 roundtrip / 粘包 / 半包 / CJK 字节精确 / 构造器忠实性 ——
 * 全部纯内存，零依赖零副作用。
 */
export function protocolSelfTest(): SelfTestResult {
  const checks: SelfTestCheck[] = [];
  const t = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  // 1) 单帧 roundtrip（Content-Length 字节精确：重建帧 = 头声明 + 体字节）
  const req = makeLspRequest(7, "textDocument/definition", { a: 1, b: "x" });
  const frame = encodeLspMessage(req);
  const headerEnd = frame.indexOf("\r\n\r\n") + 4;
  const body = frame.slice(headerEnd);
  t(
    "Content-Length = body 字节数",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}` === frame,
    `头声明 ${/Content-Length: (\d+)/.exec(frame)?.[1]} · 实际 ${Buffer.byteLength(body, "utf8")} 字节`,
  );
  const r1 = decodeLspMessage(frame);
  t("单帧 roundtrip", r1.messages.length === 1 && JSON.stringify(r1.messages[0]) === JSON.stringify(req) && r1.pendingBytes === 0);

  // 2) 粘包：两帧一 chunk
  const n1 = makeLspNotification("window/logMessage", { type: 3, message: "hello" });
  const r2 = decodeLspMessage(encodeLspMessages([req, n1]));
  t("粘包两帧一次解码", r2.messages.length === 2 && r2.messages[0]!.id === 7 && r2.messages[1]!.method === "window/logMessage");

  // 3) 半包：头截断 + 体截断（流式解码器缓冲补全）
  {
    const f = Buffer.from(encodeLspMessage(n1), "utf8");
    const d = new LspFrameDecoder();
    const mid = Math.floor(f.length / 2);
    const a1 = d.push(f.subarray(0, mid));
    const pend1 = d.pendingBytes();
    const a2 = d.push(f.subarray(mid));
    t("半包缓冲补全", a1.length === 0 && pend1 > 0 && a2.length === 1 && a2[0]!.method === "window/logMessage", `半包 ${pend1}B → 补全`);
  }
  // 3b) 头部本身截断（Content-Length 行还没到齐）
  {
    const f = Buffer.from(encodeLspMessage(req), "utf8");
    const d = new LspFrameDecoder();
    const cut = f.indexOf("\r\n\r\n"); // 头与体的边界之前
    const a1 = d.push(f.subarray(0, cut));
    const a2 = d.push(f.subarray(cut));
    t("头部截断续推", a1.length === 0 && a2.length === 1 && a2[0]!.method === "textDocument/definition");
  }

  // 4) CJK 多字节体（Content-Length 是字节数不是字符数）
  {
    const cjk = makeLspNotification("window/logMessage", { message: "你好，协议分帧（八字节体的字节精确性）" });
    const f = encodeLspMessage(cjk);
    const r = decodeLspMessage(f);
    const chars = JSON.stringify(cjk).length;
    const bytes = Buffer.byteLength(JSON.stringify(cjk), "utf8");
    t("CJK 体字节精确", r.messages.length === 1 && r.messages[0]!.params !== undefined && bytes > chars, `bytes=${bytes} > chars=${chars}`);
  }

  // 5) 构造器忠实性
  t(
    "构造器字段忠实（request/response/notification/error）",
    req.jsonrpc === "2.0" && req.id === 7 && req.method === "textDocument/definition" && req.params !== undefined
      && makeLspResponse(7, { ok: true }).result !== undefined && makeLspNotification("x").id === undefined
      && makeLspError(8, JSONRPC_ERRORS.METHOD_NOT_FOUND, "nope").error?.code === -32601,
  );

  // 6) 坏帧防御：帧格式合法但 body 是坏 JSON / 非对象 —— 跳过计数不炸流
  //    （帧长对齐 —— 流同步保持，后续好帧照收；流内裸垃圾字节属协议违规，
  //    解码器按「等下一帧头」处理，与 vscode-jsonrpc 失败语义同向）
  {
    const d = new LspFrameDecoder();
    d.push(Buffer.from(`Content-Length: 8\r\n\r\nnot json`, "utf8")); // 体长对齐但非 JSON
    d.push(Buffer.from(`Content-Length: 2\r\n\r\n[]`, "utf8")); // JSON 但非对象
    const ok = d.push(encodeLspMessage(req));
    t("坏帧跳过不炸流", ok.length === 1 && d.rejectedFrames() === 2, `拒收 ${d.rejectedFrames()} 帧`);
  }

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
