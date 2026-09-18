// ============================================================================
// tests/browser.test.ts — 浏览器面（v0.5.16 · capabilities #116/#30）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/browser.ts 三导出的行为级断言）：
//   1. 引擎探测：结构字段齐全 · 无引擎宇宙（PATH 清空 → 双缺席 + 安装指引）
//   2. 前置校验（无条件跑 —— 与引擎在场与否无关）：file:// / javascript: /
//      非 URL → kind:"denied"
//   3. engine-absent（无条件跑）：PATH 清空 → snapshot/screenshot 双面
//      kind:"engine-absent" + 安装指引（诚实失败，不静默空结果）
//   4. extractPage 进程内提取单元（无条件跑 —— 零引擎依赖）：title/正文
//      （script/style/head 剥除 + 实体解码）/链接（相对地址解析 cap 100）/
//      图片（alt）
//   5. 引擎在场（test.skipIf —— 本机有 agent-browser 0.38.1；缺席跳过而非
//      假红，ruff.test.ts 哲学）：本地 fixture 页（Bun.serve 确定性内容）
//      真实快照 · 链接帽 100 · nav-error（.invalid 域名，快速稳定）· 截图
//      产物 PNG 魔数 · 硬超时 kill（30.0.0.1 不可达 + timeoutMs 2000）
//   6. localhost:3000 真实控制台快照（skipIf 引擎缺席或 3000 不可达 ——
//      依赖 Next.js 控制台在跑；快照失败先 curl localhost:3000 探活再判断）
//
// 实测契约备注（agent-browser 0.38.1）：① CLI 退出码恒 0，成败只看 ✓/✗ 标记；
// ② 守护进程串行化命令 —— 硬超时杀掉 CLI 客户端后，守护进程仍被不可达地址
// 的导航卡住数十秒（TCP 挂起，实测自愈不可靠），故超时用例排在
// agent-browser 用例末位并在用例内恢复守护进程（close --all 取消被卡导航
// + 轮询探活），保证本文件复跑与后续套件稳定；③ localhost:3000 是活跃开发
// 面（并行接线 agent 热重载/重启，实测两代控制台：Z.ai 脚手架有标题无正文
// —— textContent 全来自 dev 内联脚本；ORG 控制台另有正文）—— 正文/链接/
// 图片的精确断言由本地 fixture 页承载，控制台页断言引擎/url/内容非全空
// + 有界重试吸收热重载窗口（诚实优先于教条）。
// 全部显式 30s 超时（localhost 用例 60s · 超时+恢复用例 85s）。
// ============================================================================
import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { browserEngines, browserSnapshot, browserScreenshot, extractPage } from "../lib/browser.ts";

// ---- 引擎实况（模块导入时探测一次；skipIf 据此注册）----------------------------

const ENGINES = browserEngines();
const HAS_AB = ENGINES.agentBrowser;

/** PATH 扫描定位 agent-browser（排空探针用；与 lib 同规的最小实现）。 */
function findAb(): string | null {
  const exe = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (d.length === 0) continue;
    const c = path.join(d, exe);
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 下一个候选位
    }
  }
  return null;
}
const AB_BIN = HAS_AB ? findAb() : null;

/** 3000 端口控制台探活（Next.js dev server；缺席则相应用例跳过）。 */
let REACHABLE_3000 = false;
try {
  await fetch("http://localhost:3000", { signal: AbortSignal.timeout(2500) });
  REACHABLE_3000 = true; // 任何 HTTP 响应都算在场（含 4xx/5xx）
} catch {
  REACHABLE_3000 = false;
}

// ---- 本地 fixture 页（确定性内容；Bun.serve 随机端口）---------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>ORG Browser Fixture 页</title>
<style>.x { color: red; } /* STYLE_SECRET_SHOULD_NOT_APPEAR */</style>
<script>var SCRIPT_SECRET = "SCRIPT_TEXT_SHOULD_NOT_APPEAR";</script>
</head>
<body>
<h1>ORG 页面上下文验收</h1>
<p>这是正文第一段，中文与 English 混排。</p>
<p>第二段：链接与图片清单验收。</p>
<ul>
<li><a href="/docs/guide">使用指南</a></li>
<li><a href="https://example.com/absolute">绝对地址链接</a></li>
<li><a href="/about?x=1&amp;y=2">关于 &amp; 联系</a></li>
</ul>
<img src="/logo.png" alt="组织徽标">
<img src="https://example.com/banner.jpg" alt="横幅">
</body></html>`;

const MANY_LINKS_HTML = `<!DOCTYPE html>
<html><head><title>链接帽验收</title></head><body>
${Array.from({ length: 120 }, (_, i) => `<a href="/l/${i}">链接 ${i}</a>`).join("\n")}
</body></html>`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/many-links") {
      return new Response(MANY_LINKS_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const FIXTURE_URL = `http://127.0.0.1:${server.port}/`;
const MANY_URL = `http://127.0.0.1:${server.port}/many-links`;

/** 截图产物 tmp 目录（afterAll 统一回收）。 */
const SHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "org-browser-test-"));

afterAll(() => {
  server.stop(true);
  fs.rmSync(SHOT_DIR, { recursive: true, force: true });
});

// ---- 1. 引擎探测 ---------------------------------------------------------------

describe("浏览器：引擎探测", () => {
  test("browserEngines() 结构字段齐全（不炸；类型正确）", () => {
    const e = browserEngines();
    expect(typeof e.agentBrowser).toBe("boolean");
    expect(e.chromium === null || typeof e.chromium === "string").toBe(true);
    expect(e.chrome === null || typeof e.chrome === "string").toBe(true);
  }, 30_000);

  test("无引擎宇宙（PATH 清空）→ 双缺席 + 安装指引（诚实失败）", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const e = browserEngines();
      expect(e.agentBrowser).toBe(false);
      expect(e.chromium).toBeNull();
      expect(e.chrome).toBeNull();
      expect(e.hint).toBeTruthy();
      expect(e.hint).toContain("agent-browser");
      expect(e.hint).toContain("chromium");
    } finally {
      process.env.PATH = savedPath;
    }
  }, 30_000);
});

// ---- 2. 前置校验（denied —— 无条件跑）--------------------------------------------

describe("浏览器：协议拒绝（denied）", () => {
  test("file:// 协议 → kind:denied（引擎调用前拒绝 —— open 实测不挡 file://）", async () => {
    const r = await browserSnapshot("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("denied");
      expect(r.error).toContain("file:");
      expect(r.hint).toBeTruthy();
    }
  }, 30_000);

  test("javascript: 协议 → kind:denied", async () => {
    const r = await browserSnapshot("javascript:alert(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("denied");
  }, 30_000);

  test("非 URL 字符串 → kind:denied（附人读提示）", async () => {
    const r = await browserSnapshot("this is not a url at all");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("denied");
      expect(r.error).toContain("不可解析");
      expect(r.hint).toContain("https://");
    }
  }, 30_000);
});

// ---- 3. engine-absent（无条件跑）-------------------------------------------------

describe("浏览器：engine-absent 降级", () => {
  test("PATH 清空 → snapshot → kind:engine-absent + 安装指引", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const r = await browserSnapshot("https://example.com/");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("engine-absent");
        expect(r.engine).toBe("none");
        expect(r.error).toContain("无可用浏览器引擎");
        expect(r.hint).toContain("agent-browser");
      }
    } finally {
      process.env.PATH = savedPath;
    }
  }, 30_000);

  test("PATH 清空 → screenshot → kind:engine-absent（截图面同链降级）", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const r = await browserScreenshot("https://example.com/");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("engine-absent");
        expect(r.engine).toBe("none");
        expect(r.hint).toBeTruthy();
      }
    } finally {
      process.env.PATH = savedPath;
    }
  }, 30_000);
});

// ---- 4. extractPage 进程内提取单元（零引擎依赖，无条件跑）--------------------------

describe("浏览器：extractPage 提取管线（单元）", () => {
  test("title/正文/链接/图片：script/style/head 剥除 + 实体解码 + 相对地址解析", () => {
    const base = "http://127.0.0.1:9999/";
    const page = extractPage(FIXTURE_HTML, base);
    expect(page.title).toBe("ORG Browser Fixture 页");
    // 正文：head/script/style 剥除 —— title 与两处 SECRET 绝不入正文
    expect(page.text).toContain("ORG 页面上下文验收");
    expect(page.text).toContain("正文第一段");
    expect(page.text).toContain("English 混排");
    expect(page.text).not.toContain("ORG Browser Fixture 页"); // title 不在正文
    expect(page.text).not.toContain("SCRIPT_TEXT_SHOULD_NOT_APPEAR");
    expect(page.text).not.toContain("STYLE_SECRET_SHOULD_NOT_APPEAR");
    // 链接：3 条 · 相对→绝对 · 实体解码（&amp; → &）
    expect(page.links).toHaveLength(3);
    expect(page.links![0]).toEqual({ href: "http://127.0.0.1:9999/docs/guide", text: "使用指南" });
    expect(page.links![1]!.href).toBe("https://example.com/absolute");
    expect(page.links![2]!.href).toBe("http://127.0.0.1:9999/about?x=1&y=2");
    expect(page.links![2]!.text).toBe("关于 & 联系");
    // 图片：2 条 · alt 解码
    expect(page.imgs).toHaveLength(2);
    expect(page.imgs![0]).toEqual({ src: "http://127.0.0.1:9999/logo.png", alt: "组织徽标" });
    expect(page.imgs![1]!.src).toBe("https://example.com/banner.jpg");
  }, 30_000);

  test("链接帽 100：120 链接页 → 恰 100 条（文档序）", () => {
    const page = extractPage(MANY_LINKS_HTML, "http://127.0.0.1:7/");
    expect(page.links).toHaveLength(100);
    expect(page.links![0]).toEqual({ href: "http://127.0.0.1:7/l/0", text: "链接 0" });
    expect(page.links![99]).toEqual({ href: "http://127.0.0.1:7/l/99", text: "链接 99" });
  }, 30_000);

  test("空壳页（无 body 内容）→ text 为空串（不臆造）", () => {
    const page = extractPage("<html><head><title>空</title></head><body></body></html>", "http://x/");
    expect(page.title).toBe("空");
    expect(page.text).toBe("");
    expect(page.links).toEqual([]);
    expect(page.imgs).toEqual([]);
  }, 30_000);
});

// ---- 5. 引擎在场（skipIf —— agent-browser 缺席跳过而非假红）----------------------

describe("浏览器：agent-browser 真实车道", () => {
  test.skipIf(!HAS_AB)("fixture 页真实快照：title/正文/链接/图片全链路（活 DOM）", async () => {
    const r = await browserSnapshot(FIXTURE_URL, { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.engine).toBe("agent-browser");
      expect(r.url).toBe(FIXTURE_URL);
      expect(r.title).toBe("ORG Browser Fixture 页");
      expect(r.text).toContain("ORG 页面上下文验收");
      expect(r.text).toContain("English 混排");
      expect(r.text).not.toContain("SCRIPT_TEXT_SHOULD_NOT_APPEAR"); // 活 DOM 同样剥 script
      expect(r.links).toHaveLength(3);
      expect(r.links![0]!.href).toBe(`${FIXTURE_URL}docs/guide`);
      expect(r.imgs).toHaveLength(2);
      expect(r.imgs![0]!.alt).toBe("组织徽标");
      expect(r.ms).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  test.skipIf(!HAS_AB)("链接帽 100：120 链接页真实快照 → 恰 100 条", async () => {
    const r = await browserSnapshot(MANY_URL, { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.links).toHaveLength(100);
      expect(r.links![0]!.href).toBe(`http://127.0.0.1:${server.port}/l/0`);
      expect(r.links![99]!.text).toBe("链接 99");
    }
  }, 30_000);

  test.skipIf(!HAS_AB)("nav-error：.invalid 域名 → 快速失败 + 引擎报错摘要", async () => {
    const r = await browserSnapshot("http://org-nonexistent-domain-xyz-abc.invalid/", { timeoutMs: 25_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("nav-error");
      expect(r.engine).toBe("agent-browser");
      expect(r.error).toContain("agent-browser 导航失败");
    }
  }, 30_000);

  test.skipIf(!HAS_AB)("截图：fixture 页 → PNG 魔数产物落盘", async () => {
    const out = path.join(SHOT_DIR, "fixture.png");
    const r = await browserScreenshot(FIXTURE_URL, { out, timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.engine).toBe("agent-browser");
      expect(r.path).toBe(out);
      const buf = fs.readFileSync(out);
      expect(buf.length).toBeGreaterThan(100); // 非空产物
      expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // \x89PNG
    }
  }, 30_000);

  test.skipIf(!HAS_AB || !REACHABLE_3000)(
    "localhost:3000 真实控制台快照（依赖控制台在跑；见文件头备注③）",
    async () => {
      // 真实控制台是活跃开发面（并行接线 agent 可能热重载/重启 —— 实测瞬态
      // 空页窗口数秒）：有界重试（4 次 × 2s 间隙）吸收热重载窗口，而非把
      // 瞬态当作产品缺陷；全部尝试失败则如实报（附末次结果诊断）
      let r = await browserSnapshot("http://localhost:3000", { timeoutMs: 25_000 });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (r.ok && ((r.title ?? "") !== "" || r.text.length > 0)) break;
        await Bun.sleep(2000);
        r = await browserSnapshot("http://localhost:3000", { timeoutMs: 25_000 });
      }
      expect(r.ok, `快照失败（控制台可能在重启 —— 先 curl localhost:3000 探活）：${JSON.stringify(r)}`).toBe(true);
      if (r.ok) {
        expect(r.engine).toBe("agent-browser");
        expect(r.url).toBe("http://localhost:3000/");
        // 页面必有内容（实测两代控制台：Z.ai 脚手架有标题无正文 · ORG 控制台
        // 有标题）—— 标题与正文全空 = 热重载窗口未吸收，如实报
        expect(
          (r.title ?? "").length + r.text.length,
          `标题与正文全空（热重载窗口？）：${JSON.stringify({ title: r.title, text: r.text.slice(0, 120) })}`,
        ).toBeGreaterThan(0);
        // 正文可为空（如 Z.ai 脚手架页：textContent 全来自 dev 内联脚本，
        // 剥除后为空串）—— 空正文必须附诚实提示，绝不臆造内容
        if (r.text.length === 0) expect(r.hint).toBeTruthy();
        expect(Array.isArray(r.links)).toBe(true);
        expect(Array.isArray(r.imgs)).toBe(true);
        expect(r.ms).toBeGreaterThanOrEqual(0);
      }
    },
    60_000,
  );

  // ---- 硬超时（排在 agent-browser 用例末位：守护进程排空见文件头备注②）---------
  test.skipIf(!HAS_AB)(
    "硬超时：30.0.0.1 不可达 + timeoutMs 2000 → kind:timeout（附守护进程恢复）",
    async () => {
      const r = await browserSnapshot("http://30.0.0.1:9999", { timeoutMs: 2000 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("timeout");
        expect(r.engine).toBe("agent-browser");
        expect(r.error).toContain("2000"); // 错误信息含超时预算（人读）
        expect(r.hint).toBeTruthy(); // 守护进程可能被卡导航阻塞的恢复指引
      }
      // 恢复：硬杀只杀 CLI 客户端，守护进程的导航仍挂在不可达地址的 TCP
      // 连接上（串行队列被阻塞）—— 先 close --all 杀会话取消被卡导航，再轮询
      // 探活直到守护进程响应（保证本文件复跑与后续套件稳定；实测恢复 ~20s）
      await abRun(AB_BIN!, ["close", "--all"], 8_000);
      const t0 = Date.now();
      let drained = false;
      while (Date.now() - t0 < 55_000) {
        const budget = Math.max(2_000, Math.min(25_000, 66_000 - (Date.now() - t0)));
        const out = await abGetUrl(AB_BIN!, budget);
        if (out.length > 0 && !out.includes("✗")) {
          drained = true;
          break;
        }
        await abRun(AB_BIN!, ["close", "--all"], 8_000); // 未恢复则再取消一次后重试
      }
      expect(drained).toBe(true); // 恢复失败 = 后续 agent-browser 用例将假红 —— 如实报
    },
    85_000,
  );
});

/** agent-browser 子命令探针（测试本地助手 —— 排空/恢复守护进程用）。 */
async function abRun(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  }, timeoutMs);
  try {
    const [out] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    await proc.exited;
    return killed ? "" : out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** agent-browser get url 探针（守护进程探活）。 */
function abGetUrl(bin: string, timeoutMs: number): Promise<string> {
  return abRun(bin, ["get", "url"], timeoutMs);
}
