// ============================================================================
// tests/pdfread.test.ts — PDF 读取降级链（v0.5.15 · capabilities #24）
// ----------------------------------------------------------------------------
// 三层验证：
//   1. 前置校验：文件不存在/非 PDF（魔数拒绝）/目录 → 诚实失败
//   2. 真实 PDF：手写最小合法 2 页 fixture（正确 xref 偏移 —— 不撒谎的
//      startxref，pdftotext 与 pypdf 双引擎均实测可读）→ 提取文本/页数/
//      引擎名；maxPages/maxChars 截断标注（截断永不静默）
//   3. 降级链终点：PATH+HOME 清空 → 双引擎探测皆空 → engine:"none" +
//      安装指引（诚实失败，不静默空结果）
// 引擎缺席哲学（ruff.test.ts 同款）：本机无任何引擎时，依赖引擎的用例
// skipIf 跳过而非假红；无引擎依赖的用例（校验/降级终点）无条件跑。
// 30s 子进程超时强杀路径不设单测（人为构造挂起子进程脆弱且收益低 —— 由
// SUBPROC_TIMEOUT_MS 常量与 code review 锁定）。
// ============================================================================

import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pdfEngines, readPdf } from "../lib/pdfread.ts";

// ---- fixture：手写最小合法 PDF --------------------------------------------------

/** PDF 文本对象转义（( ) \ 三字符）。 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * 手写最小合法多页 PDF（Type1/Helvetica + 每页一个文本对象）。
 * 关键在**正确的 xref 偏移**（顺序写入时逐对象记录字节偏移，startxref
 * 指向真实位置）—— pypdf/pdftotext 对损坏 xref 的容忍度不一，正确字节流
 * 才是跨引擎可信的 fixture。对象布局：1 catalog · 2 pages ·
 * 3..(2+n) 页对象 · (3+n)..(2+2n) 内容流 · (3+2n) 字体。
 * （开发期已用 pdftotext 与 uv-pypdf 双引擎交叉验证可提取。）
 */
function makePdf(pagesText: string[]): Buffer {
  const n = pagesText.length;
  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ");
  const fontObj = 3 + 2 * n;
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    objs[3 + i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${3 + n + i} 0 R >>`;
  }
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 12 Tf 20 100 Td (${esc(pagesText[i]!)}) Tj ET`;
    objs[3 + n + i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objs[fontObj] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= fontObj; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${fontObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontObj; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${fontObj + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** 2 页 fixture：第 1 页 "Hello ORG"、第 2 页 "Second page text"。 */
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "org-pdfread-test-"));
const FIXTURE = path.join(FIXTURE_DIR, "two-pages.pdf");
fs.writeFileSync(FIXTURE, makePdf(["Hello ORG", "Second page text"]));

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// 引擎实况（模块导入时探测一次；skipIf 据此注册）
const ENGINES = pdfEngines();
const HAS_ENGINE = ENGINES.pdftotext || ENGINES.uv;
const ENGINE_NAME: "pdftotext" | "uv-pypdf" = ENGINES.pdftotext ? "pdftotext" : "uv-pypdf";

// ---- 1. 引擎探测与前置校验 ---------------------------------------------------------

describe("PDF：引擎探测与前置校验", () => {
  test("pdfEngines() 返回布尔结构（不炸；字段齐全）", () => {
    const e = pdfEngines();
    expect(typeof e.pdftotext).toBe("boolean");
    expect(typeof e.uv).toBe("boolean");
  }, 60_000);

  test("文件不存在 → ok:false + 错误附路径", async () => {
    const missing = path.join(FIXTURE_DIR, "no-such.pdf");
    const r = await readPdf(missing);
    expect(r.ok).toBe(false);
    expect(r.engine).toBe("none");
    expect(r.error).toContain(missing);
  }, 60_000);

  test("非 PDF（纯文本文件）→ 魔数拒绝（错误提到 %PDF- 与实际文件头）", async () => {
    const notPdf = path.join(FIXTURE_DIR, "not-a-pdf.txt");
    fs.writeFileSync(notPdf, "just plain text, no magic here\n", "utf-8");
    const r = await readPdf(notPdf);
    expect(r.ok).toBe(false);
    expect(r.engine).toBe("none");
    expect(r.error).toContain("%PDF-");
  }, 60_000);

  test("目录当文件 → ok:false", async () => {
    const r = await readPdf(FIXTURE_DIR);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(FIXTURE_DIR);
  }, 60_000);
});

// ---- 2. 真实 PDF 提取（有引擎才跑；缺席 skip —— ruff.test.ts 哲学）-------------------

describe("PDF：真实提取", () => {
  test.skipIf(!HAS_ENGINE)("两页 PDF → ok:true + 文本 + 总页数 + 引擎名", async () => {
    const r = await readPdf(FIXTURE);
    expect(r.ok).toBe(true);
    expect(r.engine).toBe(ENGINE_NAME);
    expect(r.pages).toBe(2);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test.skipIf(!HAS_ENGINE)("第 1 页文本：Hello ORG", async () => {
    const r = await readPdf(FIXTURE);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Hello ORG");
  }, 60_000);

  test.skipIf(!HAS_ENGINE)("第 2 页文本：Second page text（全量提取，不截页）", async () => {
    const r = await readPdf(FIXTURE);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Second page text");
    expect(r.text).not.toContain("已截断");
  }, 60_000);

  test.skipIf(!HAS_ENGINE)("maxPages:1 → 尾部截断标注 + 不含第二页文本", async () => {
    const r = await readPdf(FIXTURE, { maxPages: 1 });
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(2); // 总页数仍如实报告
    expect(r.text).toContain("Hello ORG");
    expect(r.text).toContain("[已截断：全文 2 页，仅提取前 1 页]");
    expect(r.text).not.toContain("Second page text");
  }, 60_000);

  test.skipIf(!HAS_ENGINE)("maxChars:5 → 字符截断标注（截断永不静默）", async () => {
    const r = await readPdf(FIXTURE, { maxChars: 5 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("[已截断：超出 5 字符上限]");
  }, 60_000);
});

// ---- 3. 降级链终点：无引擎环境 --------------------------------------------------------

describe("PDF：降级链终点", () => {
  test("PATH+HOME 清空 → 双引擎探测皆空 → engine:none + 安装指引（诚实失败）", async () => {
    // 临时清空 PATH 与 HOME：which() 的 PATH 扫描与 uv 兜底安装位全部落空，
    // 确定性进入「无引擎」宇宙（与真实环境装了什么无关）
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = "";
    process.env.HOME = path.join(os.tmpdir(), "org-pdfread-none-home");
    try {
      const r = await readPdf(FIXTURE); // 魔数合法 → 走到引擎层才降级
      expect(r.ok).toBe(false);
      expect(r.engine).toBe("none");
      expect(r.error).toContain("无可用 PDF 提取引擎");
      expect(r.hint).toBeTruthy(); // 安装指引（pdftotext / uv 两条路）
      expect(r.hint).toContain("poppler");
      expect(r.hint).toContain("uv");
    } finally {
      process.env.PATH = savedPath;
      process.env.HOME = savedHome;
    }
  }, 60_000);
});
