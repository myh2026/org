// ============================================================================
// lib/browser.ts — 浏览器面：页面上下文快照 + 截图（v0.5.16 · capabilities
// #116 浏览器 DevTools / #30 浏览器 DOM/页面上下文）
// ----------------------------------------------------------------------------
// 「让 Agent 看见网页」的可本地交付面：打开 URL → 提取页面上下文（标题 /
// 正文文本 / 链接清单 / 图片清单），以及整页截图。**多重引擎降级链**（探测-
// 降级哲学，用户核心要求 —— 引擎检测链逐层回退，绝不静默空结果）：
//   ① agent-browser CLI（PATH 定位 + `--version` 探活 —— 存在 ≠ 可用，坏
//      安装按缺席降级）：`open <url>` 导航 → `eval` 取 {title, url, html}
//      （活 DOM 的 documentElement.outerHTML，含 JS 渲染后的内容）→ 进程内
//      提取。实测契约：成功行 "✓" 前缀；失败行 "✗" 前缀（**退出码恒 0，
//      成败只能看输出标记**）；eval 返回对象 → stdout 是可直接 JSON.parse
//      的 pretty JSON；守护进程串行化命令 —— 不可达地址的导航会把命令队列
//      卡住数十秒（TCP 连接挂起，硬超时杀掉的只是 CLI 客户端，守护进程不
//      随之恢复），故 timeout 错误附 close --all 恢复指引。
//   ② chromium / chromium-browser（PATH 定位，`--headless=new --dump-dom`
//      能力）：一次性子进程 dump HTML → 同一进程内提取管线。探测为 PATH
//      存在性（真实能力在首次使用时验证，失败诚实降级 nav-error/internal）。
//   ③ chrome / google-chrome / google-chrome-stable：同 ②（--headless=new
//      为 Chromium 内核统一能力）。
//   双缺席 → {ok:false, kind:"engine-absent"} + 安装指引（绝不臆造内容）。
//
// 引擎级联语义（与 pdfread.ts 同构）：某车道导航失败（超时/导航错误）时，
// 若后续车道在场则逐层重试；全车道皆败 → error 合并各车道摘要（kind 取末
// 车道的失败类）。
//
// 安全与预算：非 http(s) 协议（file:/javascript:/data:…）一律拒绝
// （kind:"denied" —— 实测 agent-browser 的 open 并不替我们挡 file://，拒绝
// 必须发生在引擎调用之前）；每车道 timeoutMs（缺省 30s）硬超时 kill；DOM
// 捕获帽 256KB · 正文文本帽 64KB · 链接帽 100 · 图片帽 50。
//
// 诚实边界（#116 的完整面是路线图）：本轮交付 = DOM/页面上下文（#30）+
// 截图 + 元素清单。**console 日志流、网络面板（请求/响应抓包）、Cookie/
// localStorage 检视、交互编排（click/type）不在本模块** —— agent-browser
// CLI 本身具备这些子命令，接线层可直接 spawn（本模块聚焦只读快照面）。
// 正文文本 = 剥 script/style/noscript/template 与注释后的标签剥离文本
// （空白折叠）；纯脚本渲染前无正文 → text 为空串并附 hint，绝不臆造。
// ============================================================================
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- 常量（预算面）----------------------------------------------------------

/** 每车道子进程硬超时（缺省；调用方可经 timeoutMs 覆盖）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 引擎探活（agent-browser --version）超时 —— 坏安装快速降级。 */
const PROBE_TIMEOUT_MS = 3_000;
/** DOM 捕获帽（eval/dump-dom 输出超此长度截断 —— 进程内存与提取耗时保护）。 */
const MAX_HTML_CHARS = 256 * 1024;
/** 正文文本帽（提取后）。 */
const MAX_TEXT_CHARS = 64 * 1024;
/** 链接清单帽。 */
const MAX_LINKS = 100;
/** 图片清单帽。 */
const MAX_IMGS = 50;
/** 单字段（链接文本/alt/title）展示帽。 */
const FIELD_MAX = 300;

/** 双引擎缺席时的安装指引。 */
const INSTALL_HINT =
  "安装其一即可启用：① agent-browser CLI（npm install -g agent-browser 或 bun install -g agent-browser，"
  + "首次使用前运行 agent-browser install 下载浏览器内核）；"
  + " ② Chromium（apt install chromium / brew install chromium —— 支持 --headless=new --dump-dom）；"
  + " ③ Google Chrome（apt install google-chrome-stable / brew install google-chrome）";

// ---- 类型 -------------------------------------------------------------------

/** 快照动用的引擎车道（"none" = 无引擎可用）。 */
export type BrowserEngine = "agent-browser" | "chromium" | "chrome" | "none";

/** 引擎探测结果：agentBrowser 布尔（探活通过）+ chromium/chrome 绝对路径形态。 */
export interface BrowserEngines {
  agentBrowser: boolean;
  /** chromium / chromium-browser 可执行绝对路径（缺席 null）。 */
  chromium: string | null;
  /** chrome / google-chrome / google-chrome-stable 可执行绝对路径（缺席 null）。 */
  chrome: string | null;
  /** 全部缺席时的安装指引（在场时 undefined）。 */
  hint?: string;
}

/** 页面链接（href 已按页面 URL 解析为绝对地址）。 */
export interface PageLink {
  href: string;
  text: string;
}

/** 页面图片（src 已按页面 URL 解析为绝对地址）。 */
export interface PageImage {
  src: string;
  alt: string;
}

/** 快照失败分类：denied=协议拒绝 · engine-absent=无引擎 · timeout=硬超时 ·
 * nav-error=导航失败（DNS 拒绝/连接失败等）· internal=引擎输出不可解析。 */
export type BrowserFailKind = "denied" | "engine-absent" | "timeout" | "nav-error" | "internal";

/** browserSnapshot 结果（统一 {ok, engine, url, ms} 面）。 */
export type BrowserResult =
  | {
    ok: true;
    engine: Exclude<BrowserEngine, "none">;
    /** 请求 URL。 */
    url: string;
    /** 最终 URL（重定向后；仅 agent-browser 车道可感知，缺席时回落 url）。 */
    finalUrl?: string;
    title?: string;
    text: string;
    links?: PageLink[];
    imgs?: PageImage[];
    ms: number;
    /** 空正文等场景的诚实说明（ok:true 也可能有 hint —— 空结果永不静默）。 */
    hint?: string;
  }
  | {
    ok: false;
    engine: BrowserEngine;
    url: string;
    kind: BrowserFailKind;
    error: string;
    hint?: string;
    ms: number;
  };

/** browserScreenshot 结果。 */
export type ScreenshotResult =
  | { ok: true; engine: Exclude<BrowserEngine, "none">; url: string; path: string; ms: number }
  | {
    ok: false;
    engine: BrowserEngine;
    url: string;
    kind: BrowserFailKind;
    error: string;
    hint?: string;
    ms: number;
  };

// ---- 小工具 -----------------------------------------------------------------

/** 错误消息提取（catch 不逃逸原则的伴随件）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 输出摘要（错误信息可读性：压空白后首 300 字符）。 */
function excerpt(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t.slice(0, 300) : "(无输出)";
}

/** PATH 扫描定位可执行文件（win32 兼容 .exe；与 pdfread.ts 同规）。 */
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
      // 不存在/不可执行 → 下一个候选位
    }
  }
  return null;
}

// ---- 引擎探测链 ---------------------------------------------------------------

/** 探测浏览器引擎链（① agent-browser → ② chromium → ③ chrome）。 */
export function browserEngines(): BrowserEngines {
  // ① agent-browser：PATH 定位 + --version 实探（存在 ≠ 可用）
  let agentBrowser = which("agent-browser");
  if (agentBrowser) {
    try {
      const r = Bun.spawnSync([agentBrowser, "--version"], {
        stdout: "ignore",
        stderr: "ignore",
        timeout: PROBE_TIMEOUT_MS,
      } as Parameters<typeof Bun.spawnSync>[1]);
      if (r.exitCode !== 0) agentBrowser = null;
    } catch {
      agentBrowser = null;
    }
  }
  // ② chromium 族 / ③ chrome 族：PATH 存在性探测（真实能力在首次使用时验证）
  const chromium = which("chromium") ?? which("chromium-browser");
  const chrome = which("chrome") ?? which("google-chrome") ?? which("google-chrome-stable");
  const out: BrowserEngines = {
    agentBrowser: agentBrowser !== null,
    chromium,
    chrome,
  };
  if (!out.agentBrowser && chromium === null && chrome === null) out.hint = INSTALL_HINT;
  return out;
}

/** 解析引擎链为有序车道列表（优先级：agent-browser → chromium → chrome）。 */
function lanes(): Array<{ engine: Exclude<BrowserEngine, "none">; bin: string }> {
  const e = browserEngines();
  const out: Array<{ engine: Exclude<BrowserEngine, "none">; bin: string }> = [];
  if (e.agentBrowser) {
    // which() 已证其在场（探活通过）；再定位一次拿绝对路径
    const bin = which("agent-browser");
    if (bin) out.push({ engine: "agent-browser", bin });
  }
  if (e.chromium) out.push({ engine: "chromium", bin: e.chromium });
  if (e.chrome) out.push({ engine: "chrome", bin: e.chrome });
  return out;
}

// ---- 子进程 -------------------------------------------------------------------

interface SubprocResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 跑子进程（硬超时 kill；stdout/stderr 全量采集；与 pdfread.ts 同构）。 */
async function runCmd(cmd: string[], timeoutMs: number): Promise<SubprocResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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

/** agent-browser CLI 的成败判定：实测退出码恒 0，成败只看 "✗" 标记（双流检查）。 */
function abFailed(r: SubprocResult): boolean {
  return r.timedOut || r.code !== 0 || r.stdout.includes("✗") || r.stderr.includes("✗");
}

/** 车道失败 → 统一失败类（引擎内部超时输出 "timed out" → timeout；其余 ✗ → nav-error）。 */
function abFailKind(r: SubprocResult): BrowserFailKind {
  if (r.timedOut) return "timeout";
  const combined = `${r.stdout}\n${r.stderr}`;
  if (/timed?\s*out/i.test(combined)) return "timeout";
  return "nav-error";
}

// ---- URL 前置校验 --------------------------------------------------------------

/** 校验 URL：必须可解析且协议为 http/https，否则返回拒绝原因（kind:"denied"）。 */
function checkUrl(url: string): { ok: true; url: string } | { ok: false; error: string; hint: string } {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, error: "URL 为空", hint: "传入完整 URL，如 https://example.com" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return {
      ok: false,
      error: `URL 不可解析：${url}`,
      hint: "传入完整 URL（含协议），如 https://example.com",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `协议被拒绝：${parsed.protocol}（仅允许 http/https）`,
      hint: "浏览器面只开放 http(s) —— file:/javascript:/data: 等协议一律拒绝（安全边界）",
    };
  }
  return { ok: true, url: parsed.href };
}

// ---- 进程内提取管线（两车道共享）------------------------------------------------

/** 常用 HTML 实体解码（展示用途的最小实现 —— 完整实体表不在零依赖边界内）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return _ as string;
      }
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return _ as string;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** 压空白 + 截断（单字段展示帽）。 */
function squash(s: string, max = FIELD_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** 从 HTML 属性串提取命名属性值（href/src/alt；单双引号与裸值三形态）。 */
function attrOf(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

/** 相对地址解析为绝对（解析失败保留原值 —— 绝不臆造）。 */
function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * 进程内页面上下文提取（#30 的核心管线，两车道共享）：
 * title（<title> 解码）· text（剥 script/style/noscript/template 与注释 →
 * 标签剥离 → 空白折叠）· links（<a href>，相对地址按 base 解析，cap 100）·
 * imgs（<img src/alt>，cap 50）。
 */
export function extractPage(html: string, baseUrl: string): {
  title: string;
  text: string;
  links: PageLink[];
  imgs: PageImage[];
} {
  // DOM 捕获帽（256KB —— 超帽页面的尾部上下文不入提取面）
  const capped = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;

  // 1. title
  let title = "";
  const tm = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(capped);
  if (tm) title = squash(decodeEntities(tm[1] ?? ""), FIELD_MAX);

  // 2. 剥非内容块与注释（script 内文本绝不算正文 —— Next.js dev 页实测教训；
  //    head 整体剥除 —— title/meta 不入正文文本，正文 = body 面）
  const stripped = capped
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // 3. 正文文本：标签 → 空格，实体解码，空白折叠
  const text = squash(decodeEntities(stripped.replace(/<[^>]+>/g, " ")), MAX_TEXT_CHARS);

  // 4. 链接清单（cap 100；顺序 = 文档序）
  const links: PageLink[] = [];
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while (links.length < MAX_LINKS && (lm = linkRe.exec(stripped)) !== null) {
    const href = attrOf(lm[1] ?? "", "href");
    if (href === null || href.length === 0) continue;
    const inner = (lm[2] ?? "").replace(/<[^>]+>/g, " ");
    // 属性值实体解码（&amp; → & —— 与浏览器 DOM 语义一致）后解析相对地址
    links.push({ href: resolveUrl(decodeEntities(href), baseUrl), text: squash(decodeEntities(inner), 80) });
  }

  // 5. 图片清单（cap 50）
  const imgs: PageImage[] = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let im: RegExpExecArray | null;
  while (imgs.length < MAX_IMGS && (im = imgRe.exec(stripped)) !== null) {
    const src = attrOf(im[1] ?? "", "src");
    if (src === null || src.length === 0) continue;
    imgs.push({ src: resolveUrl(decodeEntities(src), baseUrl), alt: squash(decodeEntities(attrOf(im[1] ?? "", "alt") ?? ""), 120) });
  }

  return { title, text, links, imgs };
}

// ---- 车道实现 -----------------------------------------------------------------

/** eval 取活 DOM 的提取脚本（agent-browser eval 返回对象 → stdout 为 pretty JSON）。 */
const EXTRACT_JS = "({title: document.title, url: location.href, html: document.documentElement.outerHTML})";

/** agent-browser 守护进程被卡导航阻塞时的恢复指引（硬杀只杀 CLI 客户端）。 */
const DAEMON_STUCK_HINT =
  "agent-browser 守护进程可能仍被该导航阻塞（串行命令队列，不可达地址的 TCP 连接挂起）"
  + " —— 可运行 `agent-browser close --all` 重置会话后重试";

/** agent-browser 车道：open → eval → 进程内提取。 */
async function snapshotViaAgentBrowser(
  bin: string,
  url: string,
  timeoutMs: number,
): Promise<
  | { ok: true; title: string; finalUrl: string; html: string }
  | { ok: false; kind: BrowserFailKind; error: string; hint?: string }
> {
  // 1. 导航（守护进程串行执行；✗ 标记 = 失败 —— 退出码恒 0）
  const open = await runCmd([bin, "open", url], timeoutMs);
  if (abFailed(open)) {
    const kind = abFailKind(open);
    const detail = excerpt(open.stderr || open.stdout);
    return {
      ok: false,
      kind,
      error: `agent-browser 导航失败（${kind === "timeout" ? `超时 ${timeoutMs}ms 硬杀` : "引擎报错"}）：${detail}`,
      ...(kind === "timeout" ? { hint: DAEMON_STUCK_HINT } : {}),
    };
  }
  // 2. 活 DOM 提取（独立预算：导航后的 DOM 采集通常远快于导航本身）
  const ev = await runCmd([bin, "eval", EXTRACT_JS], timeoutMs);
  if (abFailed(ev)) {
    return {
      ok: false,
      kind: abFailKind(ev) === "timeout" ? "timeout" : "internal",
      error: `agent-browser DOM 提取失败：${excerpt(ev.stderr || ev.stdout)}`,
    };
  }
  // 3. 解析（eval 对象 → pretty JSON；防御：剥可能的非 JSON 前后缀行）
  try {
    const raw = ev.stdout.trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`输出非 JSON 对象：${excerpt(raw)}`);
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { title?: unknown; url?: unknown; html?: unknown };
    if (typeof parsed.html !== "string") throw new Error(`html 字段缺失：${excerpt(raw)}`);
    return {
      ok: true,
      title: typeof parsed.title === "string" ? parsed.title : "",
      finalUrl: typeof parsed.url === "string" ? parsed.url : url,
      html: parsed.html,
    };
  } catch (e) {
    return { ok: false, kind: "internal", error: `agent-browser eval 输出不可解析：${errMsg(e)}` };
  }
}

/** chromium/chrome 车道：--headless=new --dump-dom → 进程内提取。 */
async function snapshotViaChromium(
  engine: "chromium" | "chrome",
  bin: string,
  url: string,
  timeoutMs: number,
): Promise<
  | { ok: true; html: string }
  | { ok: false; kind: BrowserFailKind; error: string; hint?: string }
> {
  const r = await runCmd(
    [bin, "--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", url],
    timeoutMs,
  );
  if (r.timedOut) {
    return { ok: false, kind: "timeout", error: `${engine} 超时 ${timeoutMs}ms 硬杀（页面未在预算内完成加载）` };
  }
  if (r.code !== 0 || r.stdout.trim().length === 0) {
    return {
      ok: false,
      kind: "nav-error",
      error: `${engine} --dump-dom 失败（exit ${r.code}）：${excerpt(r.stderr || r.stdout)}`,
    };
  }
  return { ok: true, html: r.stdout };
}

/** agent-browser 截图车道：open → screenshot <path>。 */
async function screenshotViaAgentBrowser(
  bin: string,
  url: string,
  out: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; kind: BrowserFailKind; error: string; hint?: string }> {
  const open = await runCmd([bin, "open", url], timeoutMs);
  if (abFailed(open)) {
    const kind = abFailKind(open);
    return {
      ok: false,
      kind,
      error: `agent-browser 导航失败（${kind === "timeout" ? `超时 ${timeoutMs}ms 硬杀` : "引擎报错"}）：${excerpt(open.stderr || open.stdout)}`,
      ...(kind === "timeout" ? { hint: DAEMON_STUCK_HINT } : {}),
    };
  }
  const shot = await runCmd([bin, "screenshot", out], timeoutMs);
  if (abFailed(shot)) {
    return {
      ok: false,
      kind: abFailKind(shot) === "timeout" ? "timeout" : "internal",
      error: `agent-browser 截图失败：${excerpt(shot.stderr || shot.stdout)}`,
    };
  }
  return { ok: true };
}

/** chromium/chrome 截图车道：--headless=new --screenshot=<path>。 */
async function screenshotViaChromium(
  engine: "chromium" | "chrome",
  bin: string,
  url: string,
  out: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; kind: BrowserFailKind; error: string; hint?: string }> {
  const r = await runCmd(
    [
      bin,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--screenshot=${out}`,
      "--window-size=1280,800",
      url,
    ],
    timeoutMs,
  );
  if (r.timedOut) {
    return { ok: false, kind: "timeout", error: `${engine} 超时 ${timeoutMs}ms 硬杀（页面未在预算内完成加载）` };
  }
  if (r.code !== 0) {
    return {
      ok: false,
      kind: "nav-error",
      error: `${engine} --screenshot 失败（exit ${r.code}）：${excerpt(r.stderr || r.stdout)}`,
    };
  }
  return { ok: true };
}

// ---- 选项消毒 -----------------------------------------------------------------

/** timeoutMs 消毒：非有限/≤0 → 缺省 30s（上限 10min 防,病态值）。 */
function saneTimeout(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(v), 600_000);
}

// ---- API ----------------------------------------------------------------------

/**
 * 页面上下文快照（#30 + #116 的可本地交付面）：打开 URL → 标题/正文文本/
 * 链接清单（cap 100）/图片清单（cap 50）。
 *
 * 多重引擎降级链：agent-browser → chromium → chrome（在场车道逐层回退，
 * 全败合并错误摘要）；双缺席 → kind:"engine-absent" + 安装指引。
 * 非 http(s) 协议 → kind:"denied"（引擎调用前拒绝）。每车道 timeoutMs
 * （缺省 30s）硬超时 kill。
 */
export async function browserSnapshot(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<BrowserResult> {
  const t0 = Date.now();
  const timeoutMs = saneTimeout(opts?.timeoutMs);

  // 1. 前置校验（denied 面永远无条件可测 —— 与引擎在场与否无关）
  const checked = checkUrl(url);
  if (!checked.ok) {
    return {
      ok: false,
      engine: "none",
      url: typeof url === "string" ? url : "",
      kind: "denied",
      error: checked.error,
      hint: checked.hint,
      ms: Date.now() - t0,
    };
  }
  const target = checked.url;

  // 2. 引擎链（空链 = engine-absent）
  const chain = lanes();
  if (chain.length === 0) {
    return {
      ok: false,
      engine: "none",
      url: target,
      kind: "engine-absent",
      error: "无可用浏览器引擎（agent-browser 与 chromium/chrome 均缺席）",
      hint: INSTALL_HINT,
      ms: Date.now() - t0,
    };
  }

  // 3. 逐车道尝试（失败级联；全败合并摘要，kind 取末车道）
  const failures: string[] = [];
  let lastKind: BrowserFailKind = "internal";
  let lastHint: string | undefined;
  for (const lane of chain) {
    if (lane.engine === "agent-browser") {
      const r = await snapshotViaAgentBrowser(lane.bin, target, timeoutMs);
      if (r.ok) {
        const page = extractPage(r.html, r.finalUrl);
        return {
          ok: true,
          engine: "agent-browser",
          url: target,
          ...(r.finalUrl !== target ? { finalUrl: r.finalUrl } : {}),
          ...(page.title.length > 0 ? { title: page.title } : {}),
          text: page.text,
          links: page.links,
          imgs: page.imgs,
          ms: Date.now() - t0,
          ...(page.text.length === 0
            ? { hint: "正文文本为空 —— 可能是纯脚本渲染前页/空壳页（本引擎不做等待重试，不臆造内容）" }
            : {}),
        };
      }
      lastKind = r.kind;
      lastHint = r.hint;
      failures.push(r.error);
    } else {
      const r = await snapshotViaChromium(lane.engine, lane.bin, target, timeoutMs);
      if (r.ok) {
        const page = extractPage(r.html, target);
        return {
          ok: true,
          engine: lane.engine,
          url: target,
          ...(page.title.length > 0 ? { title: page.title } : {}),
          text: page.text,
          links: page.links,
          imgs: page.imgs,
          ms: Date.now() - t0,
          ...(page.text.length === 0
            ? { hint: "正文文本为空 —— 可能是纯脚本渲染前页/空壳页（本引擎不做等待重试，不臆造内容）" }
            : {}),
        };
      }
      lastKind = r.kind;
      lastHint = r.hint;
      failures.push(r.error);
    }
  }

  // 4. 全车道皆败（诚实合并 —— 调用方第一想知道每条车道各发生了什么）
  return {
    ok: false,
    engine: chain[chain.length - 1]!.engine,
    url: target,
    kind: lastKind,
    error: failures.join("；"),
    ...(lastHint ? { hint: lastHint } : {}),
    ms: Date.now() - t0,
  };
}

/**
 * 整页截图：agent-browser（open → screenshot）或 chromium/chrome
 * （--headless=new --screenshot=<path>，窗口 1280×800）。引擎缺席降级
 * 链与协议拒绝语义同 browserSnapshot；产物校验存在且非空，否则诚实失败。
 *
 * @param out 产物路径（缺省：系统 tmp 下 org-browser-<时间戳>.png）。
 */
export async function browserScreenshot(
  url: string,
  opts?: { out?: string; timeoutMs?: number },
): Promise<ScreenshotResult> {
  const t0 = Date.now();
  const timeoutMs = saneTimeout(opts?.timeoutMs);

  const checked = checkUrl(url);
  if (!checked.ok) {
    return {
      ok: false,
      engine: "none",
      url: typeof url === "string" ? url : "",
      kind: "denied",
      error: checked.error,
      hint: checked.hint,
      ms: Date.now() - t0,
    };
  }
  const target = checked.url;

  const chain = lanes();
  if (chain.length === 0) {
    return {
      ok: false,
      engine: "none",
      url: target,
      kind: "engine-absent",
      error: "无可用浏览器引擎（agent-browser 与 chromium/chrome 均缺席）",
      hint: INSTALL_HINT,
      ms: Date.now() - t0,
    };
  }

  const out = opts?.out && opts.out.trim().length > 0
    ? path.resolve(opts.out)
    : path.join(os.tmpdir(), `org-browser-${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.png`);

  const failures: string[] = [];
  let lastKind: BrowserFailKind = "internal";
  let lastHint: string | undefined;
  for (const lane of chain) {
    const r = lane.engine === "agent-browser"
      ? await screenshotViaAgentBrowser(lane.bin, target, out, timeoutMs)
      : await screenshotViaChromium(lane.engine, lane.bin, target, out, timeoutMs);
    if (r.ok) {
      // 产物校验：存在 + 非空 + PNG 魔数（0x89 "PNG"）—— 引擎说成功不算，盘上字节才算
      try {
        const buf = fs.readFileSync(out);
        if (buf.length === 0) throw new Error("产物为空文件");
        if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
          throw new Error(`产物非 PNG（文件头 ${buf.subarray(0, 4).toString("latin1")}）`);
        }
        return { ok: true, engine: lane.engine, url: target, path: out, ms: Date.now() - t0 };
      } catch (e) {
        lastKind = "internal";
        lastHint = undefined;
        failures.push(`${lane.engine} 截图产物校验失败：${errMsg(e)}（${out}）`);
        continue; // 级联下一车道
      }
    }
    lastKind = r.kind;
    lastHint = r.hint;
    failures.push(r.error);
  }

  return {
    ok: false,
    engine: chain[chain.length - 1]!.engine,
    url: target,
    kind: lastKind,
    error: failures.join("；"),
    ...(lastHint ? { hint: lastHint } : {}),
    ms: Date.now() - t0,
  };
}
