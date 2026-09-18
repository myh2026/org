// ============================================================================
// lib/pdfread.ts — PDF 文本提取（v0.5.15 · capabilities #24 文档/PDF 读取）
// ----------------------------------------------------------------------------
// 「读 PDF」是文档工作流的常见入口，但 ORG 内核坚持零第三方依赖 —— 不引
// PDF 库，改为**三层降级链**（探测-降级哲学：引擎缺席 → 诚实提示，绝不
// 静默空结果）：
//   1. pdftotext（poppler）：系统 PATH 有则用之（-layout 保持版面、
//      -enc UTF-8 统一编码；页以 \f 分隔 → 进程内数页与截断）
//   2. uv + pypdf：系统有 uv 则 `uv run --no-project --with pypdf
//      python -c <提取脚本>` —— pypdf 由 uv 按需拉取并缓存于 uv 环境，
//      --no-project 保证不触碰用户项目环境，零全局污染（不 pip install、
//      不动 site-packages）；脚本输出 JSON（总页数 + 文本）进程内解析
//   3. 都没有 → 诚实失败：ok:false + engine:"none" + 安装指引 hint
//
// 引擎级联语义：pdftotext 存在但对本文件提取失败（损坏 PDF 等）时仍会
// 尝试 uv 车道；双车道皆败时 error 合并两者摘要。子进程超时 30s（超时
// kill，error 标注）—— 30s 强杀路径不设单测（人为构造挂起子进程的收益
// 低于其脆弱性，靠 code review 与超时常量锁定）。
//
// 诚实边界：只提取文本层 —— 扫描件/纯图片 PDF 无文本层 → text 为空并附
// hint 说明（本引擎不做 OCR，不臆造内容）。预算面：maxPages 缺省 50 页、
// maxChars 缺省 256KB（传 0 = 不限制）；超限截断并在尾部显式标注
// 「[已截断：全文 N 页，仅提取前 K 页]」—— 截断永不静默。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 子进程硬超时（pdftotext / uv 通用）。 */
const SUBPROC_TIMEOUT_MS = 30_000;
/** 引擎探测（uv --version）超时 —— 坏安装快速降级。 */
const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_CHARS = 256 * 1024;

/** 提取结果（ok:false 时 error 附因，engine 标注动用/可用的车道）。 */
export interface PdfReadResult {
  ok: boolean;
  text?: string;
  /** 文档总页数（截断时也是全文页数 —— 截断标注里的 N 与此一致）。 */
  pages?: number;
  engine: "pdftotext" | "uv-pypdf" | "none";
  ms: number;
  error?: string;
  /** 指引（引擎缺席的安装指引 / 空文本层的扫描件说明）。 */
  hint?: string;
}

const INSTALL_HINT =
  "安装其一即可启用：① poppler（apt install poppler-utils / brew install poppler —— 提供 pdftotext）；"
  + " ② uv（https://docs.astral.sh/uv/ —— 首次运行自动拉取 pypdf，缓存于 uv 环境，零全局污染）";

// ---- 引擎探测 -------------------------------------------------------------------

/** PATH 扫描定位可执行文件（win32 兼容 .exe；extraDirs 兜底常见安装位）。 */
function which(name: string, extraDirs: string[] = []): string | null {
  const exe = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0),
    ...extraDirs,
  ];
  for (const d of dirs) {
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

interface Engines { pdftotext: string | null; uv: string | null }

/**
 * 引擎探测（绝对路径形态 —— spawn 时不再依赖 PATH）。
 * uv 探测两步：定位（PATH + ~/.local/bin + ~/.cargo/bin 常见安装位）后
 * 再 `uv --version` 实探 —— 存在 ≠ 可用，坏安装按缺席降级。
 */
function detectEngines(): Engines {
  const pdftotext = which("pdftotext");
  // v0.5.15：运行期 HOME 优先（Node os.homedir() 的文档语义是 $HOME 优先，
  // Bun 实测对运行期 HOME 修改有进程级缓存 —— 显式读 env 保持可测性与语义）
  const home = process.env.HOME
    ?? (process.platform === "win32" ? process.env.USERPROFILE : undefined)
    ?? os.homedir();
  let uv = which("uv", [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  ]);
  if (uv) {
    try {
      const r = Bun.spawnSync([uv, "--version"], {
        stdout: "ignore", stderr: "ignore", timeout: PROBE_TIMEOUT_MS,
      } as Parameters<typeof Bun.spawnSync>[1]);
      if (r.exitCode !== 0) uv = null;
    } catch {
      uv = null;
    }
  }
  return { pdftotext, uv };
}

/** 探测两个引擎是否可用（CLI/Web 呈现引擎状态用；只读探测，无副作用）。 */
export function pdfEngines(): { pdftotext: boolean; uv: boolean } {
  const e = detectEngines();
  return { pdftotext: e.pdftotext !== null, uv: e.uv !== null };
}

// ---- 子进程 ---------------------------------------------------------------------

interface SubprocResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** 跑子进程（30s 硬超时；stdout/stderr 全量采集）。 */
async function runSubproc(cmd: string[]): Promise<SubprocResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* 已退出 */ }
  }, SUBPROC_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** pypdf 提取脚本（uv 车道）：只读前 limit 页、报告总页数，JSON 输出。
 *  参数经 argv 传入（避免路径引号地狱）；ensure_ascii=False 保持原文。 */
const PYPDF_SCRIPT = [
  "import json, sys",
  "from pypdf import PdfReader",
  "reader = PdfReader(sys.argv[1])",
  "total = len(reader.pages)",
  "limit = int(sys.argv[2]) if len(sys.argv) > 2 and int(sys.argv[2]) > 0 else total",
  "texts = [(reader.pages[i].extract_text() or \"\") for i in range(min(limit, total))]",
  "print(json.dumps({\"pages\": total, \"text\": \"\\n\\n\".join(texts)}, ensure_ascii=False))",
].join("\n");

// ---- 结果组装 -------------------------------------------------------------------

/** 失败结果工厂。 */
function fail(engine: PdfReadResult["engine"], error: string, hint?: string, t0 = Date.now()): PdfReadResult {
  return { ok: false, engine, ms: Date.now() - t0, error, ...(hint ? { hint } : {}) };
}

/** 统一收尾：页截断/字符截断标注 + 空文本层说明（截断永不静默）。 */
function finalize(
  engine: PdfReadResult["engine"],
  totalPages: number,
  firstPagesText: string,
  maxPages: number,
  maxChars: number,
  t0: number,
): PdfReadResult {
  let text = firstPagesText;
  const notes: string[] = [];
  if (totalPages > maxPages) notes.push(`[已截断：全文 ${totalPages} 页，仅提取前 ${maxPages} 页]`);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    notes.push(`[已截断：超出 ${maxChars} 字符上限]`);
  }
  const emptyHint = text.trim().length === 0
    ? "提取文本为空 —— 可能是扫描件/纯图片 PDF（无文本层；本引擎不做 OCR）"
    : undefined;
  if (notes.length > 0) text = text.replace(/\s+$/, "") + "\n\n" + notes.join("\n");
  return { ok: true, text, pages: totalPages, engine, ms: Date.now() - t0, ...(emptyHint ? { hint: emptyHint } : {}) };
}

/** stderr/stdout 摘要（错误信息可读性：首 300 字符）。 */
function excerpt(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t.slice(0, 300) : "(无输出)";
}

// ---- 主入口 ---------------------------------------------------------------------

/**
 * 读取 PDF 文本（三层降级链，见文件头）。
 * 前置校验：文件不存在/不是常规文件/缺 %PDF- 魔数 → ok:false（错误附路径
 * 与实际文件头，不做无中生有的尝试）。
 */
export async function readPdf(
  file: string,
  opts?: { maxPages?: number; maxChars?: number },
): Promise<PdfReadResult> {
  const t0 = Date.now();
  const maxPages = opts?.maxPages == null ? DEFAULT_MAX_PAGES : (opts.maxPages > 0 ? opts.maxPages : Number.POSITIVE_INFINITY);
  const maxChars = opts?.maxChars == null ? DEFAULT_MAX_CHARS : (opts.maxChars > 0 ? opts.maxChars : Number.POSITIVE_INFINITY);

  // 1. 存在性（错误附路径 —— 调用方第一想知道的就是这个）
  try {
    if (!fs.statSync(file).isFile()) {
      return fail("none", `不是常规文件：${file}`, undefined, t0);
    }
  } catch {
    return fail("none", `文件不存在或不可访问：${file}`, undefined, t0);
  }

  // 2. 魔数嗅探（只读头 8 字节，不整读大文件）
  let magic = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8);
      const n = fs.readSync(fd, buf, 0, 8, 0);
      magic = buf.subarray(0, n).toString("latin1");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return fail("none", `文件不可读：${file}`, undefined, t0);
  }
  if (!magic.startsWith("%PDF-")) {
    return fail("none", `非 PDF 文件：缺 %PDF- 魔数（文件头为 ${JSON.stringify(magic)}）：${file}`, undefined, t0);
  }

  // 3. 引擎降级链
  const engines = detectEngines();
  const errors: string[] = [];

  // 3a. pdftotext（首车道：系统级、零冷启动）
  if (engines.pdftotext) {
    const r = await runSubproc([engines.pdftotext, "-layout", "-enc", "UTF-8", file, "-"]);
    if (r.code === 0 && !r.timedOut) {
      // 页以 \f 分隔（含末页）→ 去尾部空段即页数组；无文本页计为 0
      //（pdftotext 车道的诚实边界：页数由文本分页符推断）
      let segs = r.stdout.split("\f");
      while (segs.length > 0 && segs[segs.length - 1].trim().length === 0) segs.pop();
      const pages = segs.length;
      const firstPages = segs.slice(0, maxPages).join("\n\n").trim();
      return finalize("pdftotext", pages, firstPages, maxPages, maxChars, t0);
    }
    errors.push(`pdftotext 提取失败（exit ${r.code}${r.timedOut ? `，超时 ${SUBPROC_TIMEOUT_MS / 1000}s 强杀` : ""}）：${excerpt(r.stderr || r.stdout)}`);
    // 失败 → 级联到 uv 车道
  }

  // 3b. uv + pypdf（次车道：按需拉取、uv 环境缓存、零全局污染）
  if (engines.uv) {
    const r = await runSubproc([
      engines.uv, "run", "--no-project", "--with", "pypdf",
      "python", "-c", PYPDF_SCRIPT, file, String(maxPages === Number.POSITIVE_INFINITY ? 0 : maxPages),
    ]);
    if (r.code === 0 && !r.timedOut) {
      try {
        const parsed = JSON.parse(r.stdout) as { pages?: unknown; text?: unknown };
        if (typeof parsed.pages === "number" && typeof parsed.text === "string") {
          return finalize("uv-pypdf", parsed.pages, parsed.text.trim(), maxPages, maxChars, t0);
        }
        errors.push(`uv-pypdf 输出契约不符：${excerpt(r.stdout)}`);
      } catch {
        errors.push(`uv-pypdf 输出不可解析：${excerpt(r.stdout || r.stderr)}`);
      }
    } else {
      errors.push(`uv-pypdf 提取失败（exit ${r.code}${r.timedOut ? `，超时 ${SUBPROC_TIMEOUT_MS / 1000}s 强杀` : ""}）：${excerpt(r.stderr || r.stdout)}`);
    }
  }

  // 3c. 双车道皆不可用 / 皆失败
  if (errors.length === 0) {
    return fail("none", "无可用 PDF 提取引擎（pdftotext 与 uv 均缺席）", INSTALL_HINT, t0);
  }
  return fail(engines.pdftotext ? "pdftotext" : "uv-pypdf", errors.join("；"), undefined, t0);
}
