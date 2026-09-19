// ============================================================================
// lib/devtools.ts — 浏览器 DevTools（v0.5.20 · capabilities #116 剩余半面：
// console 面板 / 网络面板 / DOM 交互 —— 常驻会话型引擎）
// ----------------------------------------------------------------------------
// v0.5.16 交付了 #116 的可本地化半面（DOM 快照 + 截图，lib/browser.ts），
// console/网络/交互标注为「需要常驻会话型引擎（CDP 协议）」。本模块补齐：
//
// 双车道设计（探测-降级哲学，与 browser.ts 同构）：
//   ① 裸 CDP 客户端（主车道 —— org 自研 WebSocket CDP 协议客户端）：
//      端点发现链 opts.cdpUrl → env ORG_CDP_URL → agent-browser 守护进程
//      （`get cdp-url`，daemon 的浏览器自带 CDP 端口）→ 缺省 127.0.0.1:9222
//      （用户自启 chromium --remote-debugging-port=9222）。HTTP /json/version
//      + /json/list 发现页面 target → WebSocket attach → CDP 域对话：
//        console 面板：Runtime.enable + Log.enable → 收集 consoleAPICalled
//          （type→level 归一 + args 拼接）/ exceptionThrown / Log.entryAdded
//        网络面板：Network.enable →（可选 Page.navigate）→ requestWillBeSent
//          / responseReceived / loadingFinished / loadingFailed → 请求表
//          （url/method/status/mime/resourceType/size/duration/failed）
//        DOM 交互：Runtime.evaluate（querySelector + click / value 赋值 +
//          input/change 事件派发 —— JSON.stringify 埋参零注入面）
//        eval：Runtime.evaluate returnByValue + awaitPromise
//   ② agent-browser CLI 车道（降级 —— 守护进程本身就是 CDP 常驻会话）：
//      console/errors 文本行解析（`[level] text` 实测契约）· network requests
//      文本行解析（`[requestId] METHOD URL (Type) STATUS`）· click/fill/type/
//      press/hover/check 直通子命令 · eval JSON 输出解析（与 browser.ts 同规）
//   双缺席 → {ok:false, kind:"engine-absent"} + 安装/启动指引（绝不臆造）。
//
// 车道偏好：console/network 主走 ①（结构化 richer：args/stack/mime/size/
// duration 是 agent-browser 文本面没有的）；interact/eval 主走 ②（选择器
// 引擎久经考验 —— refs/等待/焦点管理），①作降级。opts.lane 可强制单车道。
//
// 安全与预算：URL 仅 http/https（与 browser.ts 同规 —— 引擎调用前拒绝）；
// 选择器帽 300 字符 + 控制字符拒绝；eval 表达式帽 8KB（页面上下文执行 ——
// 与 agent-browser eval 同暴露面，非宿主 shell）；console 条目帽 500 · 网络
// 请求帽 300 · 单条文本帽 4KB；采集时长帽 30s（缺省 2s）；CDP 请求超时
// 10s；attach 超时 5s。close 只关自己 spawn 的连接（`agent-browser close
// --all` 是显式动作，见 devtoolsClose）。
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";

// ---- 常量（预算面）----------------------------------------------------------

/** CDP 缺省端点（用户自启 chromium --remote-debugging-port=9222）。 */
export const CDP_DEFAULT_HTTP = "http://127.0.0.1:9222";
/** env 变量名（显式指定 CDP 端点 —— 优先于自动发现）。 */
export const ORG_CDP_URL_ENV = "ORG_CDP_URL";
/** attach（WebSocket 连接 + 首个域使能）超时。 */
const ATTACH_TIMEOUT_MS = 5_000;
/** 单条 CDP 请求超时（缺省；send 可覆盖）。 */
const CDP_REQUEST_TIMEOUT_MS = 10_000;
/** console 采集缺省时长。 */
const DEFAULT_DURATION_MS = 2_000;
/** 采集时长帽（30s —— 预算保护）。 */
const MAX_DURATION_MS = 30_000;
/** console 条目帽 / 网络请求帽 / 单条文本帽。 */
const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_REQUESTS = 300;
const MAX_ENTRY_TEXT = 4 * 1024;
/** 选择器帽 + eval 表达式帽。 */
const MAX_SELECTOR = 300;
const MAX_EVAL = 8 * 1024;
/** 导航后 settle 宽限（loadEventFired 后再收这么久的事件再收工）。 */
const SETTLE_GRACE_MS = 600;
/** 子进程硬超时（agent-browser 车道）。 */
const AB_TIMEOUT_MS = 30_000;

/** 双车道缺席时的指引。 */
const INSTALL_HINT =
  "启用 DevTools 三选一：① agent-browser CLI（npm install -g agent-browser；首次使用前 agent-browser install 下载内核 —— 守护进程自带 CDP 端点）；"
  + " ② 自启 Chromium/Chrome 调试端口：chromium --headless=new --remote-debugging-port=9222 about:blank（或设 ORG_CDP_URL=http://127.0.0.1:9222）；"
  + " ③ 任意 CDP 端点：devtools 调用带 cdpUrl（如 ws://127.0.0.1:9222/devtools/browser/<uuid>）或设 ORG_CDP_URL";

// ---- 类型 -------------------------------------------------------------------

/** CDP /json/version 规范化产物。 */
export interface CdpVersion {
  browser: string;
  protocolVersion: string;
  userAgent?: string;
}

/** CDP /json/list 单个 target（只保留 page 类型的有用字段）。 */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** CDP 端点来源（探测链的哪一环命中）。 */
export type CdpSource = "explicit" | "env" | "agent-browser" | "default-port";

/** 端点发现结果。 */
export type CdpEndpoint =
  | { ok: true; httpUrl: string; source: CdpSource; version: CdpVersion; pages: CdpTarget[] }
  | { ok: false; kind: "engine-absent"; reason: string; hint: string };

/** console 面板单条。 */
export interface DevtoolsConsoleEntry {
  /** 事件源：console（consoleAPICalled）/ exception（exceptionThrown）/ log 域（entryAdded）。 */
  source: "console" | "exception" | "log";
  /** 归一级别：log/info/warn/error/debug。 */
  level: string;
  text: string;
  url?: string;
  line?: number;
  ts: number;
}

/** 网络面板单条（requestId 配对后的完整生命周期视图）。 */
export interface DevtoolsNetworkRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  mime?: string;
  size?: number;
  durationMs?: number;
  failed?: boolean;
  errorText?: string;
}

/** 统一失败类：denied=协议拒绝 · engine-absent=双车道缺席 · timeout=超时 ·
 * attach-failed=CDP 连不上 · nav-error=导航失败 · internal=输出不可解析。 */
export type DevtoolsFailKind = "denied" | "engine-absent" | "timeout" | "attach-failed" | "nav-error" | "internal";

/** 车道选择。 */
export type DevtoolsLane = "cdp" | "agent-browser";

// ---- 小工具 -----------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function excerpt(s: string, max = 300): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t.slice(0, max) : "(无输出)";
}

/** PATH 扫描定位可执行文件（win32 兼容 .exe；与 browser.ts 同规）。 */
function which(name: string): string | null {
  const exe = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (d.length === 0) continue;
    const c = path.join(d, exe);
    try {
      if (!fs.statSync(c).isFile()) continue;
      if (process.platform !== "win32") fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // 下一个候选位
    }
  }
  return null;
}

/** 跑子进程（硬超时 kill；与 browser.ts 同构）。 */
async function runCmd(cmd: string[], timeoutMs: number, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env ? { ...process.env, ...env } : undefined });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  }, Math.max(1, timeoutMs));
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const code = (await proc.exited) ?? -1;
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** agent-browser CLI 成败判定（退出码恒 0，成败看 "✗" 标记 —— 实测契约）。 */
function abFailed(r: { code: number; stdout: string; stderr: string; timedOut: boolean }): boolean {
  return r.timedOut || r.code !== 0 || r.stdout.includes("✗") || r.stderr.includes("✗");
}

/** URL 前置校验（http/https only —— 与 browser.ts 同规）。 */
export function devtoolsCheckUrl(url: string): { ok: true; url: string } | { ok: false; error: string; hint: string } {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, error: "URL 为空", hint: "传入完整 URL，如 https://example.com" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, error: `URL 不可解析：${url}`, hint: "传入完整 URL（含协议），如 https://example.com" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `协议被拒绝：${parsed.protocol}（仅允许 http/https）`, hint: "DevTools 面只开放 http(s) —— file:/javascript:/data: 等协议一律拒绝（安全边界）" };
  }
  return { ok: true, url: parsed.href };
}

/** 选择器消毒：帽 300 + 控制字符/引号外字符拒绝（CLI argv 安全 + CDP 埋参安全双保险）。 */
export function sanitizeSelector(sel: string): { ok: true; sel: string } | { ok: false; error: string } {
  if (typeof sel !== "string" || sel.trim().length === 0) {
    return { ok: false, error: "选择器为空（如 #submit、button.primary、a[href='/docs']）" };
  }
  if (sel.length > MAX_SELECTOR) {
    return { ok: false, error: `选择器超长（${sel.length} > ${MAX_SELECTOR} 帽）` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(sel)) {
    return { ok: false, error: "选择器含控制字符 —— 拒绝（安全边界）" };
  }
  return { ok: true, sel: sel.trim() };
}

/** 采集时长消毒：非有限/≤0 → 缺省 2s；上限 30s。 */
export function saneDuration(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_DURATION_MS;
  return Math.min(Math.floor(v), MAX_DURATION_MS);
}

/** 文本截断（单条帽，保头）。 */
function clipText(s: string): string {
  return s.length > MAX_ENTRY_TEXT ? `${s.slice(0, MAX_ENTRY_TEXT)}…［截断：${s.length} 字符］` : s;
}

// ---- CDP 事件归一（纯函数 —— 自检锁定形状）-----------------------------------

/** consoleAPICalled.type → 归一级别（warning→warn；assert/其他 exotic → log 系）。 */
export function normalizeConsoleLevel(type: string): string {
  switch (type) {
    case "log":
    case "info":
    case "debug":
    case "warning":
    case "error":
      return type === "warning" ? "warn" : type;
    default:
      // assert / table / dir / trace / count / timeEnd 等异种 —— 归 log（诚实保留原文在 text）
      return "log";
  }
}

/** RemoteObject → 展示文本（value 优先，description 次之，type 兜底）。 */
export function remoteObjectToText(o: unknown): string {
  if (o === null || typeof o !== "object") return o === undefined ? "undefined" : String(o);
  const r = o as Record<string, unknown>;
  if (r.value !== undefined) {
    if (typeof r.value === "string") return r.value;
    try {
      return JSON.stringify(r.value);
    } catch {
      return String(r.value);
    }
  }
  if (typeof r.description === "string") return r.description;
  if (typeof r.type === "string") return `(${r.type})`;
  return "(不可展示)";
}

/** exceptionDetails → 文本（exception.description 优先，text 兜底）。 */
export function exceptionDetailsToText(d: unknown): string {
  if (d === null || typeof d !== "object") return "(无异常详情)";
  const r = d as Record<string, unknown>;
  const exc = r.exception as Record<string, unknown> | undefined;
  if (exc && typeof exc.description === "string") return exc.description;
  if (typeof r.text === "string") return r.text;
  return "(不可展示异常)";
}

// ---- agent-browser 文本行解析（纯函数 —— 实测契约锁定）------------------------

/** agent-browser console 行：`[level] text`。返回 null = 非条目行（跳过）。 */
export function parseAbConsoleLine(line: string): DevtoolsConsoleEntry | null {
  const m = /^\[(\w+)\]\s?(.*)$/.exec(line.trim());
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  const level = raw === "warning" ? "warn" : (["log", "info", "warn", "error", "debug"].includes(raw) ? raw : "log");
  const text = m[2] ?? "";
  if (text.length === 0 && raw.length === 0) return null;
  return { source: "console", level, text: clipText(text), ts: Date.now() };
}

/** agent-browser network 行：`[requestId] METHOD URL (ResourceType) STATUS`。 */
export function parseAbNetworkLine(line: string): DevtoolsNetworkRequest | null {
  const m = /^\[([^\]]+)\]\s+(\S+)\s+(\S+)\s+\(([^)]*)\)\s*(\d{3}|-{1,2}|pending|failed)?\s*$/.exec(line.trim());
  if (!m) return null;
  const statusRaw = m[5];
  const status = statusRaw && /^\d{3}$/.test(statusRaw) ? Number(statusRaw) : undefined;
  return {
    requestId: m[1]!,
    url: m[3]!,
    method: m[2]!,
    resourceType: m[4] || undefined,
    ...(status !== undefined ? { status } : {}),
    ...(statusRaw === "failed" ? { failed: true } : {}),
  };
}

/** CDP ws URL → http 基址（ws://127.0.0.1:40729/devtools/... → http://127.0.0.1:40729）。 */
export function wsUrlToHttpBase(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    return `${u.protocol === "ws:" ? "http" : "https"}://${u.host}`;
  } catch {
    return null;
  }
}

// ---- CDP 端点发现链 ------------------------------------------------------------

/** agent-browser 守护进程的 CDP URL（daemon 未起时返回 null —— 探活失败按缺席降级）。 */
async function agentBrowserCdpUrl(bin: string): Promise<string | null> {
  const r = await runCmd([bin, "get", "cdp-url"], 5_000);
  if (r.timedOut || r.code !== 0) return null;
  const out = r.stdout.trim();
  const m = /ws:\/\/\S+/.exec(out);
  return m ? m[0] : null;
}

/** fetch /json/version + /json/list（1.5s 预算 —— 快速失败）。 */
async function fetchCdpInfo(httpUrl: string): Promise<{ version: CdpVersion; pages: CdpTarget[] } | null> {
  try {
    const [vRes, lRes] = await Promise.all([
      fetch(`${httpUrl}/json/version`, { signal: AbortSignal.timeout(1500) }),
      fetch(`${httpUrl}/json/list`, { signal: AbortSignal.timeout(1500) }),
    ]);
    if (!vRes.ok || !lRes.ok) return null;
    const v = (await vRes.json()) as Record<string, unknown>;
    const list = (await lRes.json()) as Array<Record<string, unknown>>;
    const pages: CdpTarget[] = [];
    for (const t of Array.isArray(list) ? list : []) {
      if (
        typeof t.id === "string" && typeof t.webSocketDebuggerUrl === "string"
        && typeof t.type === "string" && typeof t.url === "string" && typeof t.title === "string"
      ) {
        pages.push({ id: t.id, type: t.type, title: t.title, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl });
      }
    }
    return {
      version: {
        browser: typeof v.Browser === "string" ? v.Browser : "(未声明)",
        protocolVersion: typeof v["Protocol-Version"] === "string" ? (v["Protocol-Version"] as string) : "(未声明)",
        ...(typeof v["User-Agent"] === "string" ? { userAgent: v["User-Agent"] as string } : {}),
      },
      pages,
    };
  } catch {
    return null;
  }
}

/**
 * CDP 端点发现链：explicit（opts.cdpUrl）→ env（ORG_CDP_URL）→ agent-browser
 * 守护进程（get cdp-url）→ 缺省端口 127.0.0.1:9222。全部缺席 → 诚实
 * engine-absent + 指引。cdpUrl/ws 均可（ws 自动转 http 基址）。
 */
export async function discoverCdpEndpoint(opts?: { cdpUrl?: string }): Promise<CdpEndpoint> {
  const chain: Array<{ httpUrl: string; source: CdpSource }> = [];
  // ① 显式参数 / ② env
  const explicit = opts?.cdpUrl?.trim() || process.env[ORG_CDP_URL_ENV]?.trim() || "";
  if (explicit.length > 0) {
    const http = explicit.startsWith("ws://") || explicit.startsWith("wss://") ? wsUrlToHttpBase(explicit) : explicit.replace(/\/+$/, "");
    if (http) chain.push({ httpUrl: http, source: explicit === opts?.cdpUrl?.trim() ? "explicit" : "env" });
  }
  // ③ agent-browser 守护进程
  const abBin = which("agent-browser");
  if (abBin) {
    const ws = await agentBrowserCdpUrl(abBin);
    if (ws) {
      const http = wsUrlToHttpBase(ws);
      if (http) chain.push({ httpUrl: http, source: "agent-browser" });
    }
  }
  // ④ 缺省端口
  chain.push({ httpUrl: CDP_DEFAULT_HTTP, source: "default-port" });
  for (const c of chain) {
    const info = await fetchCdpInfo(c.httpUrl);
    if (info) return { ok: true, httpUrl: c.httpUrl, source: c.source, version: info.version, pages: info.pages };
  }
  return {
    ok: false,
    kind: "engine-absent",
    reason: "无可用 CDP 端点（显式/env/agent-browser 守护进程/缺省 127.0.0.1:9222 四环全缺席）",
    hint: INSTALL_HINT,
  };
}

// ---- CdpConnection（页面级 WebSocket 会话）------------------------------------

interface CdpPending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type CdpEventHandler = (params: Record<string, unknown>) => void;

/**
 * 页面级 CDP 会话：WebSocket attach → id 配对请求/响应 → 事件订阅分发。
 * 坏消息拒收不炸（catch 不逃逸）；close 幂等。
 */
export class CdpConnection {
  readonly wsUrl: string;
  closed = false;

  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private handlers = new Map<string, Set<CdpEventHandler>>();

  private constructor(wsUrl: string, ws: WebSocket) {
    this.wsUrl = wsUrl;
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Record<string, unknown>;
      } catch {
        return; // 坏行丢弃（CDP 不会发 —— 防御性）
      }
      if (typeof msg.method === "string") {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h((msg.params ?? {}) as Record<string, unknown>);
        return;
      }
      if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p === undefined) return; // 迟到/重复 —— 丢弃
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined) {
          p.reject(new Error(`CDP 错误响应：code=${(msg.error as Record<string, unknown>).code} ${(msg.error as Record<string, unknown>).message ?? ""}`.trim()));
        } else {
          p.resolve(msg.result);
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("CDP WebSocket 已关闭"));
      }
      this.pending.clear();
    });
    ws.addEventListener("error", () => {
      // error 事件伴随 close —— pending 由 close 钩子收尾（不重复拒绝）
    });
  }

  /** attach：WebSocket 连接 + open（超时诚实失败）。 */
  static async attach(wsUrl: string, timeoutMs = ATTACH_TIMEOUT_MS): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* 未开 */ }
        reject(new Error(`CDP attach 超时（${timeoutMs}ms）：${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP attach 失败（连接错误）：${wsUrl}`));
      }, { once: true });
    });
    return new CdpConnection(wsUrl, ws);
  }

  /** 订阅事件（方法名 → handler）。 */
  on(method: string, h: CdpEventHandler): void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(h);
  }

  /** 发 CDP 命令（id 配对等待响应）。 */
  send(method: string, params?: Record<string, unknown>, timeoutMs = CDP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`CDP 会话已关闭 —— 无法发 ${method}`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP 发送失败（${method}）：${errMsg(e)}`));
      }
    });
  }

  /** 关闭会话（幂等）。 */
  close(): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      // 已关
    }
    this.closed = true;
  }
}

/** 从端点选页面 target（偏好 http/https 页；缺席 → 诚实错误）。 */
function pickPage(ep: { ok: true; pages: CdpTarget[] }, opts?: { targetId?: string }): { ok: true; target: CdpTarget } | { ok: false; error: string } {
  if (opts?.targetId) {
    const hit = ep.pages.find((p) => p.id === opts.targetId);
    if (hit) return { ok: true, target: hit };
    return { ok: false, error: `指定 targetId=${opts.targetId} 不在 /json/list 清单（现有 ${ep.pages.length} 个 target）` };
  }
  const http = ep.pages.find((p) => p.type === "page" && /^https?:/i.test(p.url));
  if (http) return { ok: true, target: http };
  const anyPage = ep.pages.find((p) => p.type === "page");
  if (anyPage) return { ok: true, target: anyPage };
  return { ok: false, error: `CDP 端点无 page 类型 target（共 ${ep.pages.length} 个 target，全部非 page —— 先用浏览器打开一个页面）` };
}

// ---- CDP 车道操作 --------------------------------------------------------------

/** console 面板（CDP 车道）：attach → Runtime/Log enable →（可选导航）→ 采集。 */
async function consoleViaCdp(
  ep: { ok: true; httpUrl: string; pages: CdpTarget[] },
  opts: { url?: string; durationMs: number; targetId?: string },
): Promise<{ ok: true; entries: DevtoolsConsoleEntry[]; navigated: boolean } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  const pick = pickPage(ep, opts);
  if (!pick.ok) return { ok: false, kind: "attach-failed", error: pick.error };
  let conn: CdpConnection;
  try {
    conn = await CdpConnection.attach(pick.target.webSocketDebuggerUrl);
  } catch (e) {
    return { ok: false, kind: "attach-failed", error: errMsg(e) };
  }
  const entries: DevtoolsConsoleEntry[] = [];
  const push = (e: DevtoolsConsoleEntry): void => {
    if (entries.length < MAX_CONSOLE_ENTRIES) entries.push(e);
  };
  conn.on("Runtime.consoleAPICalled", (p) => {
    const args = Array.isArray(p.args) ? p.args.map(remoteObjectToText) : [];
    push({ source: "console", level: normalizeConsoleLevel(String(p.type ?? "log")), text: clipText(args.join(" ")), ts: Date.now() });
  });
  conn.on("Runtime.exceptionThrown", (p) => {
    push({ source: "exception", level: "error", text: clipText(exceptionDetailsToText(p.exceptionDetails)), ts: Date.now() });
  });
  conn.on("Log.entryAdded", (p) => {
    const entry = (p.entry ?? {}) as Record<string, unknown>;
    push({
      source: "log",
      level: String(entry.level ?? "info"),
      text: clipText(String(entry.text ?? "")),
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
      ...(typeof entry.lineNumber === "number" ? { line: entry.lineNumber } : {}),
      ts: Date.now(),
    });
  });
  try {
    await conn.send("Runtime.enable");
    await conn.send("Log.enable");
    let navigated = false;
    if (opts.url) {
      await conn.send("Page.enable");
      await conn.send("Page.navigate", { url: opts.url });
      navigated = true;
    }
    await new Promise((r) => setTimeout(r, opts.durationMs));
    return { ok: true, entries, navigated };
  } catch (e) {
    return { ok: false, kind: "internal", error: `CDP console 采集失败：${errMsg(e)}` };
  } finally {
    conn.close();
  }
}

/** 网络面板（CDP 车道）：attach → Network enable →（可选导航）→ 请求生命周期配对采集。 */
async function networkViaCdp(
  ep: { ok: true; httpUrl: string; pages: CdpTarget[] },
  opts: { url?: string; durationMs: number; targetId?: string },
): Promise<{ ok: true; requests: DevtoolsNetworkRequest[]; navigated: boolean } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  const pick = pickPage(ep, opts);
  if (!pick.ok) return { ok: false, kind: "attach-failed", error: pick.error };
  let conn: CdpConnection;
  try {
    conn = await CdpConnection.attach(pick.target.webSocketDebuggerUrl);
  } catch (e) {
    return { ok: false, kind: "attach-failed", error: errMsg(e) };
  }
  const map = new Map<string, DevtoolsNetworkRequest & { _start?: number; _end?: number }>();
  const upsert = (requestId: string, init: (r: DevtoolsNetworkRequest & { _start?: number; _end?: number }) => void): void => {
    if (!map.has(requestId) && map.size >= MAX_NETWORK_REQUESTS) return; // 帽满不再新增（已有条仍可更新）
    const r = map.get(requestId) ?? { requestId, url: "", method: "GET" };
    init(r as DevtoolsNetworkRequest & { _start?: number; _end?: number });
    map.set(requestId, r as DevtoolsNetworkRequest & { _start?: number; _end?: number });
  };
  conn.on("Network.requestWillBeSent", (p) => {
    const req = (p.request ?? {}) as Record<string, unknown>;
    upsert(String(p.requestId ?? ""), (r) => {
      r.url = String(req.url ?? r.url);
      r.method = String(req.method ?? r.method);
      r.resourceType = typeof p.type === "string" ? p.type : r.resourceType;
      r._start = typeof p.timestamp === "number" ? p.timestamp : r._start;
    });
  });
  conn.on("Network.responseReceived", (p) => {
    const res = (p.response ?? {}) as Record<string, unknown>;
    upsert(String(p.requestId ?? ""), (r) => {
      if (typeof res.status === "number") r.status = res.status;
      if (typeof res.mimeType === "string") r.mime = res.mimeType;
      if (typeof p.type === "string") r.resourceType = p.type;
      r._end = typeof p.timestamp === "number" ? p.timestamp : r._end;
    });
  });
  conn.on("Network.loadingFinished", (p) => {
    upsert(String(p.requestId ?? ""), (r) => {
      if (typeof p.encodedDataLength === "number") r.size = p.encodedDataLength;
      r._end = typeof p.timestamp === "number" ? p.timestamp : r._end;
    });
  });
  conn.on("Network.loadingFailed", (p) => {
    upsert(String(p.requestId ?? ""), (r) => {
      r.failed = true;
      if (typeof p.errorText === "string") r.errorText = p.errorText;
      r._end = typeof p.timestamp === "number" ? p.timestamp : r._end;
    });
  });
  let settled = false;
  conn.on("Page.loadEventFired", () => {
    settled = true;
  });
  try {
    await conn.send("Network.enable");
    await conn.send("Page.enable");
    let navigated = false;
    if (opts.url) {
      await conn.send("Page.navigate", { url: opts.url });
      navigated = true;
    }
    // 采集窗口：导航时等到 loadEventFired 后再收 SETTLE_GRACE_MS 宽限（或时长帽）；
    // 无导航按 durationMs 直采。settled 只提前收工 —— 绝不延长窗口。
    const start = Date.now();
    const deadline = start + opts.durationMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
      if (opts.url && settled && Date.now() - start >= SETTLE_GRACE_MS) break;
    }
    const requests: DevtoolsNetworkRequest[] = [];
    for (const r of map.values()) {
      const dur = r._start !== undefined && r._end !== undefined ? Math.round((r._end - r._start) * 1000) : undefined;
      const { _start, _end, ...clean } = r as DevtoolsNetworkRequest & { _start?: number; _end?: number };
      void _start;
      void _end;
      requests.push({ ...clean, ...(dur !== undefined && dur >= 0 ? { durationMs: dur } : {}) });
    }
    return { ok: true, requests, navigated };
  } catch (e) {
    return { ok: false, kind: "internal", error: `CDP 网络采集失败：${errMsg(e)}` };
  } finally {
    conn.close();
  }
}

/** DOM 交互脚本构造（click/fill —— JSON.stringify 埋参零注入面）。 */
export function interactScript(action: string, sel: string, value?: string): string {
  const s = JSON.stringify(sel);
  switch (action) {
    case "click":
      return `(()=>{const el=document.querySelector(${s});if(!el)return{ok:false,reason:"元素未找到"};el.click();return{ok:true,tag:el.tagName}})()`;
    case "check":
      return `(()=>{const el=document.querySelector(${s});if(!el)return{ok:false,reason:"元素未找到"};el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));return{ok:true}})()`;
    case "uncheck":
      return `(()=>{const el=document.querySelector(${s});if(!el)return{ok:false,reason:"元素未找到"};el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));return{ok:true}})()`;
    case "fill":
      return `(()=>{const el=document.querySelector(${s});if(!el)return{ok:false,reason:"元素未找到"};el.focus();el.value=${JSON.stringify(value ?? "")};el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return{ok:true}})()`;
    default:
      return `(()=>{return{ok:false,reason:"CDP 车道不支持 ${action}（type/press/hover 走 agent-browser 车道）"}})()`;
  }
}

/** DOM 交互（CDP 车道）：Runtime.evaluate 执行交互脚本。 */
async function interactViaCdp(
  ep: { ok: true; httpUrl: string; pages: CdpTarget[] },
  action: string,
  sel: string,
  value: string | undefined,
  opts: { targetId?: string },
): Promise<{ ok: true; detail: string } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  const pick = pickPage(ep, opts);
  if (!pick.ok) return { ok: false, kind: "attach-failed", error: pick.error };
  let conn: CdpConnection;
  try {
    conn = await CdpConnection.attach(pick.target.webSocketDebuggerUrl);
  } catch (e) {
    return { ok: false, kind: "attach-failed", error: errMsg(e) };
  }
  try {
    const res = (await conn.send("Runtime.evaluate", { expression: interactScript(action, sel, value), returnByValue: true })) as
      | { result?: Record<string, unknown> }
      | null ?? {};
    const val = (res.result ?? {}) as Record<string, unknown>;
    if (val.type === "object" && val.value !== undefined) {
      const o = val.value as Record<string, unknown>;
      if (o.ok === true) return { ok: true, detail: `${action} ${sel} 完成${o.tag ? `（${String(o.tag)}）` : ""}` };
      return { ok: false, kind: "internal", error: `${action} 失败：${String(o.reason ?? "页面返回 ok:false")}` };
    }
    return { ok: false, kind: "internal", error: `CDP 交互返回不可解析：${JSON.stringify(val).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, kind: "internal", error: `CDP 交互失败：${errMsg(e)}` };
  } finally {
    conn.close();
  }
}

/** eval（CDP 车道）：Runtime.evaluate returnByValue + awaitPromise。 */
async function evalViaCdp(
  ep: { ok: true; httpUrl: string; pages: CdpTarget[] },
  expression: string,
  opts: { targetId?: string },
): Promise<{ ok: true; type: string; value: unknown } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  const pick = pickPage(ep, opts);
  if (!pick.ok) return { ok: false, kind: "attach-failed", error: pick.error };
  let conn: CdpConnection;
  try {
    conn = await CdpConnection.attach(pick.target.webSocketDebuggerUrl);
  } catch (e) {
    return { ok: false, kind: "attach-failed", error: errMsg(e) };
  }
  try {
    const res = (await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as
      | { result?: Record<string, unknown>; exceptionDetails?: unknown }
      | null ?? {};
    if (res.exceptionDetails !== undefined) {
      return { ok: false, kind: "internal", error: `页面异常：${exceptionDetailsToText(res.exceptionDetails)}` };
    }
    const r = (res.result ?? {}) as Record<string, unknown>;
    return { ok: true, type: String(r.type ?? "unknown"), value: r.value };
  } catch (e) {
    return { ok: false, kind: "internal", error: `CDP eval 失败：${errMsg(e)}` };
  } finally {
    conn.close();
  }
}

// ---- agent-browser 车道操作 -----------------------------------------------------

function abBin(): string | null {
  return which("agent-browser");
}

/** console 面板（agent-browser 车道）：[open url] → console + errors 文本解析。 */
async function consoleViaAb(bin: string, url: string | undefined, timeoutMs: number): Promise<{ ok: true; entries: DevtoolsConsoleEntry[] } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  if (url) {
    const open = await runCmd([bin, "open", url], timeoutMs);
    if (abFailed(open)) return { ok: false, kind: /timed?\s*out/i.test(open.stderr + open.stdout) ? "timeout" : "nav-error", error: `agent-browser 导航失败：${excerpt(open.stderr || open.stdout)}` };
  }
  const [con, errs] = await Promise.all([
    runCmd([bin, "console"], timeoutMs),
    runCmd([bin, "errors"], timeoutMs),
  ]);
  if (con.timedOut) return { ok: false, kind: "timeout", error: `agent-browser console 超时 ${timeoutMs}ms 硬杀` };
  if (con.code !== 0 && con.stderr.includes("✗")) return { ok: false, kind: "internal", error: `agent-browser console 失败：${excerpt(con.stderr || con.stdout)}` };
  const entries: DevtoolsConsoleEntry[] = [];
  for (const line of con.stdout.split("\n")) {
    const e = parseAbConsoleLine(line);
    if (e) entries.push(e);
    if (entries.length >= MAX_CONSOLE_ENTRIES) break;
  }
  for (const line of errs.stdout.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    entries.push({ source: "exception", level: "error", text: clipText(t), ts: Date.now() });
    if (entries.length >= MAX_CONSOLE_ENTRIES) break;
  }
  return { ok: true, entries };
}

/** 网络面板（agent-browser 车道）：[open url] → network requests 文本解析。 */
async function networkViaAb(bin: string, url: string | undefined, filter: string | undefined, timeoutMs: number): Promise<{ ok: true; requests: DevtoolsNetworkRequest[] } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  if (url) {
    const open = await runCmd([bin, "open", url], timeoutMs);
    if (abFailed(open)) return { ok: false, kind: /timed?\s*out/i.test(open.stderr + open.stdout) ? "timeout" : "nav-error", error: `agent-browser 导航失败：${excerpt(open.stderr || open.stdout)}` };
  }
  const r = await runCmd(filter ? [bin, "network", "requests", "--filter", filter] : [bin, "network", "requests"], timeoutMs);
  if (r.timedOut) return { ok: false, kind: "timeout", error: `agent-browser network requests 超时 ${timeoutMs}ms 硬杀` };
  if (r.code !== 0 && r.stderr.includes("✗")) return { ok: false, kind: "internal", error: `agent-browser network 失败：${excerpt(r.stderr || r.stdout)}` };
  const requests: DevtoolsNetworkRequest[] = [];
  for (const line of r.stdout.split("\n")) {
    const q = parseAbNetworkLine(line);
    if (q) requests.push(q);
    if (requests.length >= MAX_NETWORK_REQUESTS) break;
  }
  return { ok: true, requests };
}

/** DOM 交互（agent-browser 车道）：click/fill/type/press/hover/check/uncheck 直通。 */
async function interactViaAb(
  bin: string,
  action: string,
  sel: string,
  value: string | undefined,
  timeoutMs: number,
): Promise<{ ok: true; detail: string } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  const cmd: string[] = [bin];
  switch (action) {
    case "click": cmd.push("click", sel); break;
    case "dblclick": cmd.push("dblclick", sel); break;
    case "fill": cmd.push("fill", sel, value ?? ""); break;
    case "type": cmd.push("type", sel, value ?? ""); break;
    case "press": cmd.push("press", value ?? "Enter"); break;
    case "hover": cmd.push("hover", sel); break;
    case "check": cmd.push("check", sel); break;
    case "uncheck": cmd.push("uncheck", sel); break;
    case "select": cmd.push("select", sel, ...(value ?? "").split(/\s+/).filter(Boolean)); break;
    default: return { ok: false, kind: "internal", error: `未知交互动作：${action}（click/dblclick/fill/type/press/hover/check/uncheck/select）` };
  }
  const r = await runCmd(cmd, timeoutMs);
  if (abFailed(r)) {
    return { ok: false, kind: /timed?\s*out/i.test(r.stderr + r.stdout) ? "timeout" : "internal", error: `agent-browser ${action} 失败：${excerpt(r.stderr || r.stdout)}` };
  }
  return { ok: true, detail: excerpt(r.stdout, 200) || `${action} ${sel} 完成` };
}

/** eval（agent-browser 车道）：eval <js> → JSON 解析（与 browser.ts 同规）。 */
async function evalViaAb(bin: string, expression: string, timeoutMs: number): Promise<{ ok: true; value: unknown } | { ok: false; kind: DevtoolsFailKind; error: string }> {
  const r = await runCmd([bin, "eval", expression], timeoutMs);
  if (abFailed(r)) return { ok: false, kind: /timed?\s*out/i.test(r.stderr + r.stdout) ? "timeout" : "internal", error: `agent-browser eval 失败：${excerpt(r.stderr || r.stdout)}` };
  try {
    const raw = r.stdout.trim();
    const start = Math.min(...[raw.indexOf("{"), raw.indexOf("[")].filter((i) => i >= 0));
    const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
    if (!Number.isFinite(start) || end <= start) {
      // 标量输出（如纯文本）—— 原样返回
      return { ok: true, value: raw };
    }
    return { ok: true, value: JSON.parse(raw.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, kind: "internal", error: `agent-browser eval 输出不可解析：${errMsg(e)}` };
  }
}

// ---- 统一 API -----------------------------------------------------------------

export interface DevtoolsOpts {
  /** CDP 端点（http 或 ws URL —— 显式优先）。 */
  cdpUrl?: string;
  /** 强制车道（缺省 auto：console/network 主 CDP · interact/eval 主 agent-browser）。 */
  lane?: DevtoolsLane;
  /** CDP 页面 target id（缺省自动选 http(s) page）。 */
  targetId?: string;
  /** 子进程超时（agent-browser 车道）。 */
  timeoutMs?: number;
}

/** DevTools 引擎探测（车道可用性 + CDP 版本/页面清单 —— 零副作用观测面）。 */
export interface DevtoolsProbeResult {
  ok: boolean;
  /** 命中的车道（"none" = 双缺席）。 */
  lane: DevtoolsLane | "none";
  cdp?: { httpUrl: string; source: CdpSource; version: CdpVersion; pages: Array<{ id: string; type: string; title: string; url: string }> };
  agentBrowser: boolean;
  hint?: string;
}

export async function devtoolsProbe(opts?: { cdpUrl?: string }): Promise<DevtoolsProbeResult> {
  const ab = abBin() !== null;
  const ep = await discoverCdpEndpoint(opts);
  if (ep.ok) {
    return {
      ok: true,
      lane: "cdp",
      cdp: { httpUrl: ep.httpUrl, source: ep.source, version: ep.version, pages: ep.pages.filter((p) => p.type === "page").map(({ id, type, title, url }) => ({ id, type, title, url })) },
      agentBrowser: ab,
    };
  }
  if (ab) return { ok: true, lane: "agent-browser", agentBrowser: true };
  return { ok: false, lane: "none", agentBrowser: false, hint: INSTALL_HINT };
}

/** console 面板结果。 */
export type DevtoolsConsoleResult =
  | {
    ok: true;
    lane: DevtoolsLane;
    entries: DevtoolsConsoleEntry[];
    /** 采集时长（ms）。 */
    ms: number;
    /** 是否执行了导航。 */
    navigated: boolean;
    /** 空结果说明（诚实面：无事件 ≠ 失败）。 */
    hint?: string;
  }
  | { ok: false; lane: DevtoolsLane | "none"; kind: DevtoolsFailKind; error: string; hint?: string };

/**
 * console 面板（#116）：采集页面 console 输出（log/info/warn/error/debug）+
 * 页面异常 + Log 域条目。url 给定时先导航（采集加载期 console —— CDP 车道
 * 独有优势）；省缺采集当前页面。车道：CDP 主 · agent-browser 降级。
 */
export async function devtoolsConsole(opts?: { url?: string; durationMs?: number } & DevtoolsOpts): Promise<DevtoolsConsoleResult> {
  const t0 = Date.now();
  const durationMs = saneDuration(opts?.durationMs);
  const lane = opts?.lane ?? "cdp";
  const forced = opts?.lane !== undefined; // 显式车道 = 不级联（强制的语义）；auto = CDP 败后降级 ab
  // URL 前置校验（denied 面无条件可测）
  if (opts?.url !== undefined) {
    const checked = devtoolsCheckUrl(opts.url);
    if (!checked.ok) return { ok: false, lane: "none", kind: "denied", error: checked.error, hint: checked.hint };
  }
  const url = opts?.url;
  if (lane === "cdp" || lane === undefined) {
    const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
    if (ep.ok) {
      const r = await consoleViaCdp(ep, { url, durationMs, targetId: opts?.targetId });
      if (r.ok) {
        return {
          ok: true,
          lane: "cdp",
          entries: r.entries,
          ms: Date.now() - t0,
          navigated: r.navigated,
          ...(r.entries.length === 0 ? { hint: "采集窗口内无 console 事件（空结果 ≠ 失败 —— 页面可能本就没有输出；可加 durationMs 或带 url 导航触发）" } : {}),
        };
      }
      // CDP 车道败：auto → 级联 agent-browser（在场才降级）；强制 cdp → 诚实失败不级联
      const bin = abBin();
      if (!forced && bin) {
        const ab = await consoleViaAb(bin, url, opts?.timeoutMs ?? AB_TIMEOUT_MS);
        if (ab.ok) return { ok: true, lane: "agent-browser", entries: ab.entries, ms: Date.now() - t0, navigated: url !== undefined, ...(ab.entries.length === 0 ? { hint: "无 console 输出" } : {}) };
        return { ok: false, lane: "agent-browser", kind: ab.kind, error: `CDP：${r.error}；agent-browser：${ab.error}` };
      }
      return { ok: false, lane: "cdp", kind: r.kind, error: r.error, hint: INSTALL_HINT };
    }
    // CDP 端点缺席：auto → agent-browser 车道；强制 cdp → 诚实缺席
    const bin = abBin();
    if (!forced && bin) {
      const ab = await consoleViaAb(bin, url, opts?.timeoutMs ?? AB_TIMEOUT_MS);
      if (ab.ok) return { ok: true, lane: "agent-browser", entries: ab.entries, ms: Date.now() - t0, navigated: url !== undefined, ...(ab.entries.length === 0 ? { hint: "无 console 输出" } : {}) };
      return { ok: false, lane: "agent-browser", kind: ab.kind, error: ab.error };
    }
    return { ok: false, lane: forced ? "cdp" : "none", kind: "engine-absent", error: forced ? `CDP 端点缺席（强制 --lane cdp 不级联）：${ep.reason}` : "无可用 DevTools 引擎（CDP 端点与 agent-browser 均缺席）", hint: INSTALL_HINT };
  }
  // 强制 agent-browser 车道
  const bin = abBin();
  if (!bin) return { ok: false, lane: "none", kind: "engine-absent", error: "agent-browser 缺席（PATH 无此命令）", hint: INSTALL_HINT };
  const ab = await consoleViaAb(bin, url, opts?.timeoutMs ?? AB_TIMEOUT_MS);
  if (ab.ok) return { ok: true, lane: "agent-browser", entries: ab.entries, ms: Date.now() - t0, navigated: url !== undefined, ...(ab.entries.length === 0 ? { hint: "无 console 输出" } : {}) };
  return { ok: false, lane: "agent-browser", kind: ab.kind, error: ab.error };
}

/** 网络面板结果。 */
export type DevtoolsNetworkResult =
  | {
    ok: true;
    lane: DevtoolsLane;
    requests: DevtoolsNetworkRequest[];
    ms: number;
    navigated: boolean;
    hint?: string;
  }
  | { ok: false; lane: DevtoolsLane | "none"; kind: DevtoolsFailKind; error: string; hint?: string };

/**
 * 网络面板（#116）：请求生命周期表（url/method/status/mime/resourceType/
 * size/durationMs/failed）。url 给定时先导航（采集整页加载请求）；filter
 * 正则/子串过滤（agent-browser 车道 --filter；CDP 车道本地过滤）。
 */
export async function devtoolsNetwork(opts?: { url?: string; durationMs?: number; filter?: string } & DevtoolsOpts): Promise<DevtoolsNetworkResult> {
  const t0 = Date.now();
  const durationMs = saneDuration(opts?.durationMs);
  const lane = opts?.lane ?? "cdp";
  const forced = opts?.lane !== undefined; // 显式车道 = 不级联；auto = CDP 败后降级 ab
  if (opts?.url !== undefined) {
    const checked = devtoolsCheckUrl(opts.url);
    if (!checked.ok) return { ok: false, lane: "none", kind: "denied", error: checked.error, hint: checked.hint };
  }
  const url = opts?.url;
  if (lane === "cdp" || lane === undefined) {
    const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
    if (ep.ok) {
      const r = await networkViaCdp(ep, { url, durationMs, targetId: opts?.targetId });
      if (r.ok) {
        const requests = opts?.filter ? r.requests.filter((q) => q.url.includes(opts.filter!)) : r.requests;
        return {
          ok: true,
          lane: "cdp",
          requests,
          ms: Date.now() - t0,
          navigated: r.navigated,
          ...(requests.length === 0 ? { hint: "采集窗口内无网络请求（空结果 ≠ 失败；带 url 导航可采集整页加载请求）" } : {}),
        };
      }
      const bin = abBin();
      if (!forced && bin) {
        const ab = await networkViaAb(bin, url, opts?.filter, opts?.timeoutMs ?? AB_TIMEOUT_MS);
        if (ab.ok) return { ok: true, lane: "agent-browser", requests: ab.requests, ms: Date.now() - t0, navigated: url !== undefined, ...(ab.requests.length === 0 ? { hint: "无网络请求记录" } : {}) };
        return { ok: false, lane: "agent-browser", kind: ab.kind, error: `CDP：${r.error}；agent-browser：${ab.error}` };
      }
      return { ok: false, lane: "cdp", kind: r.kind, error: r.error, hint: INSTALL_HINT };
    }
    const bin = abBin();
    if (!forced && bin) {
      const ab = await networkViaAb(bin, url, opts?.filter, opts?.timeoutMs ?? AB_TIMEOUT_MS);
      if (ab.ok) return { ok: true, lane: "agent-browser", requests: ab.requests, ms: Date.now() - t0, navigated: url !== undefined, ...(ab.requests.length === 0 ? { hint: "无网络请求记录" } : {}) };
      return { ok: false, lane: "agent-browser", kind: ab.kind, error: ab.error };
    }
    return { ok: false, lane: forced ? "cdp" : "none", kind: "engine-absent", error: forced ? `CDP 端点缺席（强制 --lane cdp 不级联）：${ep.reason}` : "无可用 DevTools 引擎（CDP 端点与 agent-browser 均缺席）", hint: INSTALL_HINT };
  }
  const bin = abBin();
  if (!bin) return { ok: false, lane: "none", kind: "engine-absent", error: "agent-browser 缺席（PATH 无此命令）", hint: INSTALL_HINT };
  const ab = await networkViaAb(bin, url, opts?.filter, opts?.timeoutMs ?? AB_TIMEOUT_MS);
  if (ab.ok) return { ok: true, lane: "agent-browser", requests: ab.requests, ms: Date.now() - t0, navigated: url !== undefined, ...(ab.requests.length === 0 ? { hint: "无网络请求记录" } : {}) };
  return { ok: false, lane: "agent-browser", kind: ab.kind, error: ab.error };
}

/** DOM 交互动作集。 */
export type DevtoolsInteractAction = "click" | "dblclick" | "fill" | "type" | "press" | "hover" | "check" | "uncheck" | "select";

/** DOM 交互结果。 */
export type DevtoolsInteractResult =
  | { ok: true; lane: DevtoolsLane; action: string; selector: string; detail: string; ms: number }
  | { ok: false; lane: DevtoolsLane | "none"; kind: DevtoolsFailKind; error: string; hint?: string };

/**
 * DOM 交互（#116）：click/dblclick/fill/type/press/hover/check/uncheck/select。
 * 车道：agent-browser 主（选择器引擎久经考验）· CDP 降级（click/fill/check/
 * uncheck —— Runtime.evaluate 交互脚本）。
 */
export async function devtoolsInteract(
  action: DevtoolsInteractAction,
  selector: string,
  value?: string,
  opts?: DevtoolsOpts,
): Promise<DevtoolsInteractResult> {
  const t0 = Date.now();
  const sane = sanitizeSelector(selector);
  if (!sane.ok) return { ok: false, lane: "none", kind: "denied", error: sane.error };
  const sel = sane.sel;
  if (value !== undefined && value.length > MAX_ENTRY_TEXT) {
    return { ok: false, lane: "none", kind: "denied", error: `value 超长（${value.length} > ${MAX_ENTRY_TEXT} 帽）` };
  }
  const lane = opts?.lane ?? "agent-browser";
  if (lane === "agent-browser") {
    const bin = abBin();
    if (bin) {
      const r = await interactViaAb(bin, action, sel, value, opts?.timeoutMs ?? AB_TIMEOUT_MS);
      if (r.ok) return { ok: true, lane: "agent-browser", action, selector: sel, detail: r.detail, ms: Date.now() - t0 };
      // ab 败 → CDP 降级（在场的动作才降级）
      if (["click", "fill", "check", "uncheck"].includes(action)) {
        const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
        if (ep.ok) {
          const c = await interactViaCdp(ep, action, sel, value, { targetId: opts?.targetId });
          if (c.ok) return { ok: true, lane: "cdp", action, selector: sel, detail: c.detail, ms: Date.now() - t0 };
          return { ok: false, lane: "cdp", kind: c.kind, error: `agent-browser：${r.error}；CDP：${c.error}` };
        }
      }
      return { ok: false, lane: "agent-browser", kind: r.kind, error: r.error };
    }
    // ab 缺席 → CDP 车道（支持的动作）
    if (["click", "fill", "check", "uncheck"].includes(action)) {
      const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
      if (ep.ok) {
        const c = await interactViaCdp(ep, action, sel, value, { targetId: opts?.targetId });
        if (c.ok) return { ok: true, lane: "cdp", action, selector: sel, detail: c.detail, ms: Date.now() - t0 };
        return { ok: false, lane: "cdp", kind: c.kind, error: c.error, hint: INSTALL_HINT };
      }
    }
    return { ok: false, lane: "none", kind: "engine-absent", error: "agent-browser 缺席且 CDP 端点缺席（或该动作无 CDP 车道）", hint: INSTALL_HINT };
  }
  // 强制 CDP 车道
  const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
  if (!ep.ok) return { ok: false, lane: "none", kind: "engine-absent", error: `CDP 端点缺席：${ep.reason}`, hint: ep.hint };
  const c = await interactViaCdp(ep, action, sel, value, { targetId: opts?.targetId });
  if (c.ok) return { ok: true, lane: "cdp", action, selector: sel, detail: c.detail, ms: Date.now() - t0 };
  return { ok: false, lane: "cdp", kind: c.kind, error: c.error };
}

/** eval 结果。 */
export type DevtoolsEvalResult =
  | { ok: true; lane: DevtoolsLane; value: unknown; type?: string; ms: number }
  | { ok: false; lane: DevtoolsLane | "none"; kind: DevtoolsFailKind; error: string; hint?: string };

/**
 * 页面上下文 eval（#116 附带面）：表达式在**页面**上下文执行（非宿主 shell
 * —— 与 agent-browser eval 同暴露面）。车道：agent-browser 主 · CDP 降级。
 * 表达式帽 8KB。
 */
export async function devtoolsEval(expression: string, opts?: DevtoolsOpts): Promise<DevtoolsEvalResult> {
  const t0 = Date.now();
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return { ok: false, lane: "none", kind: "denied", error: "表达式为空" };
  }
  if (expression.length > MAX_EVAL) {
    return { ok: false, lane: "none", kind: "denied", error: `表达式超长（${expression.length} > ${MAX_EVAL} 帽）` };
  }
  const lane = opts?.lane ?? "agent-browser";
  if (lane === "agent-browser") {
    const bin = abBin();
    if (bin) {
      const r = await evalViaAb(bin, expression, opts?.timeoutMs ?? AB_TIMEOUT_MS);
      if (r.ok) return { ok: true, lane: "agent-browser", value: r.value, ms: Date.now() - t0 };
      const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
      if (ep.ok) {
        const c = await evalViaCdp(ep, expression, { targetId: opts?.targetId });
        if (c.ok) return { ok: true, lane: "cdp", value: c.value, type: c.type, ms: Date.now() - t0 };
        return { ok: false, lane: "cdp", kind: c.kind, error: `agent-browser：${r.error}；CDP：${c.error}` };
      }
      return { ok: false, lane: "agent-browser", kind: r.kind, error: r.error };
    }
    const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
    if (ep.ok) {
      const c = await evalViaCdp(ep, expression, { targetId: opts?.targetId });
      if (c.ok) return { ok: true, lane: "cdp", value: c.value, type: c.type, ms: Date.now() - t0 };
      return { ok: false, lane: "cdp", kind: c.kind, error: c.error, hint: INSTALL_HINT };
    }
    return { ok: false, lane: "none", kind: "engine-absent", error: "agent-browser 与 CDP 端点均缺席", hint: INSTALL_HINT };
  }
  const ep = await discoverCdpEndpoint({ cdpUrl: opts?.cdpUrl });
  if (!ep.ok) return { ok: false, lane: "none", kind: "engine-absent", error: `CDP 端点缺席：${ep.reason}`, hint: ep.hint };
  const c = await evalViaCdp(ep, expression, { targetId: opts?.targetId });
  if (c.ok) return { ok: true, lane: "cdp", value: c.value, type: c.type, ms: Date.now() - t0 };
  return { ok: false, lane: "cdp", kind: c.kind, error: c.error };
}

/**
 * 关闭 agent-browser 全部会话（显式动作 —— 守护进程与浏览器整体退出；
 * org 自己 spawn 的 CDP 连接随各操作 close，不在此列）。
 */
export async function devtoolsClose(): Promise<{ ok: boolean; output: string }> {
  const bin = abBin();
  if (!bin) return { ok: false, output: "agent-browser 缺席 —— 无守护进程可关（CDP 车道的连接随操作自动关闭）" };
  const r = await runCmd([bin, "close", "--all"], 10_000);
  return { ok: !abFailed(r), output: excerpt(r.stdout || r.stderr, 300) };
}

// ---- 协议自检（纯内存 —— 无引擎也能锁协议层形状）-------------------------------

export interface DevtoolsSelfTestCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DevtoolsSelfTestResult {
  ok: boolean;
  passed: number;
  total: number;
  checks: DevtoolsSelfTestCheck[];
}

/** DevTools 协议层自检（纯内存 12 项 —— 引擎在场与否不影响）。 */
export function devtoolsSelfTest(): DevtoolsSelfTestResult {
  const checks: DevtoolsSelfTestCheck[] = [];
  const t = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  // 1-2. console 级别归一
  t("console 级别归一：warning→warn", normalizeConsoleLevel("warning") === "warn", `得 ${normalizeConsoleLevel("warning")}`);
  t("console 级别归一：exotic（assert/table）→log", normalizeConsoleLevel("assert") === "log", `得 ${normalizeConsoleLevel("assert")}`);

  // 3-4. RemoteObject 文本化
  t("RemoteObject：字符串 value 直取", remoteObjectToText({ type: "string", value: "你好" }) === "你好", "");
  t("RemoteObject：undefined value 走 description", remoteObjectToText({ type: "object", description: "HTMLDivElement" }) === "HTMLDivElement", "");

  // 5. 异常详情文本化
  t("exceptionDetails：exception.description 优先", exceptionDetailsToText({ text: "Uncaught", exception: { description: "TypeError: x is not a function" } }) === "TypeError: x is not a function", "");

  // 6-7. agent-browser 文本行解析
  const con = parseAbConsoleLine("[warning] 磁盘空间不足");
  t("ab console 行解析：[warning] → level warn", con !== null && con.level === "warn" && con.text === "磁盘空间不足", "");
  const net = parseAbNetworkLine("[ABC123] GET http://x.test/ (Document) 200");
  t("ab network 行解析：状态/类型/方法", net !== null && net.status === 200 && net.method === "GET" && net.resourceType === "Document", "");

  // 8. ws→http 基址换算
  const base = wsUrlToHttpBase("ws://127.0.0.1:40729/devtools/browser/uuid-1");
  t("ws URL → http 基址", base === "http://127.0.0.1:40729", `得 ${base}`);

  // 9-10. 选择器消毒
  const bad = sanitizeSelector("a\x00b");
  t("选择器消毒：控制字符拒绝", !bad.ok, "");
  const long = sanitizeSelector("a".repeat(301));
  t("选择器消毒：超长拒绝", !long.ok, "");

  // 11. URL 校验
  const denied = devtoolsCheckUrl("file:///etc/passwd");
  t("URL 校验：file:// 拒绝", !denied.ok, "");

  // 12. 时长消毒
  t("时长消毒：上限 30s 夹紧", saneDuration(120_000) === MAX_DURATION_MS, `得 ${saneDuration(120_000)}`);

  const passed = checks.filter((c) => c.passed).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
