// ============================================================================
// tests/vision.test.ts — 视觉入口（v0.5.13）：VLM 图片理解
// ============================================================================
// 覆盖面（全部 mock —— setZaiFactory 注入 fake zai，零外联、确定性）：
//   1. 纯函数：normalizeImageMime（白名单/data URL 前缀容忍/未知名）·
//      sniffImageMime（PNG/JPEG/GIF/BMP/WebP 魔数/未知拒绝）
//   2. analyzeImages（mock）：成功（text/chars/images + prompt 透传）·
//      缺省 prompt（VISION_DEFAULT_PROMPT）· 超长 prompt 截断（truncated）·
//      空列表/超张数/超体积/非图片载荷/伪造 mime 拒绝 · 401 降级（remedy 文案）·
//      空结果明确错误
//   3. visionStatus（mock）：在线/降级
//   4. 禁用开关：DHV_VISION_DISABLE_SDK=1 → 显式拒绝（零外联模式）
//   5. Web 端点（startWebServer · port 0）：POST /api/vision（单图/多图/400
//      必填/503 降级）· GET /api/vision-status · GUI 要素（📷 按钮 / 隐藏
//      file input / visTx 浮条 / [hidden] 防护 / 内联脚本自洽）
// ============================================================================

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspace } from "./helpers";
import { startWebServer } from "../web/entry.ts";
import {
  normalizeImageMime, sniffImageMime, analyzeImages, analyzeImage,
  setZaiFactory, visionStatus,
  VISION_MAX_IMAGES, VISION_PROMPT_MAX, VISION_DEFAULT_PROMPT, IMAGE_MIMES,
} from "../lib/vision.ts";

// ---- 测试图片（真实魔数；载荷填充确定性字节） ----

function pngBuf(size = 64): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.fill(0x11, 8);
  return b;
}
function jpegBuf(size = 64): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b, 0);
  b.fill(0x22, 4);
  return b;
}
function gifBuf(): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from("GIF89a").copy(b, 0);
  return b;
}
function webpBuf(): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from("RIFF").copy(b, 0);
  b.writeUInt32LE(16, 4);
  Buffer.from("WEBP").copy(b, 8);
  return b;
}
function textBuf(): Buffer { return Buffer.from("这不是一张图片，只是文本填充。"); }

/** fake zai：createVision 捕获入参（供消息结构断言），返回固定 content。 */
function makeFakeZai(opts: { fail?: string; content?: string } = {}) {
  const calls = { vision: 0, last: null as Record<string, unknown> | null };
  const fake = {
    chat: {
      completions: {
        createVision: async (r: Record<string, unknown>) => {
          calls.vision++;
          calls.last = r;
          if (opts.fail) throw new Error(opts.fail);
          const content = opts.content ?? "图中有一张桌子，桌上放着一杯咖啡。";
          return { choices: [{ message: { content } }] };
        },
      },
    },
    calls,
  };
  return fake;
}

// ---- 1. 纯函数 ----

describe("vision 纯函数（v0.5.13）", () => {
  test("normalizeImageMime：白名单直通 + data URL 前缀容忍 + 大小写归一", () => {
    expect(normalizeImageMime("image/png")).toBe("image/png");
    expect(normalizeImageMime("IMAGE/JPEG")).toBe("image/jpeg");
    expect(normalizeImageMime("data:image/png;base64,AAAA")).toBe("image/png");
    expect(normalizeImageMime("image/jpg")).toBe("image/jpg"); // 别名（嗅探兜底校正）
    expect(normalizeImageMime("application/pdf")).toBeNull();
    expect(normalizeImageMime("")).toBeNull();
    expect(normalizeImageMime(undefined)).toBeNull();
  });

  test("sniffImageMime：五格式魔数识别；文本/短 buffer 拒绝", () => {
    expect(sniffImageMime(pngBuf())).toBe("image/png");
    expect(sniffImageMime(jpegBuf())).toBe("image/jpeg");
    expect(sniffImageMime(gifBuf())).toBe("image/gif");
    expect(sniffImageMime(webpBuf())).toBe("image/webp");
    const bmp = Buffer.alloc(16);
    Buffer.from("BM").copy(bmp, 0);
    expect(sniffImageMime(bmp)).toBe("image/bmp");
    expect(sniffImageMime(textBuf())).toBeNull();
    expect(sniffImageMime(Buffer.alloc(4))).toBeNull(); // 短于 12
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  test("IMAGE_MIMES 清单：6 个键（jpg 别名计入）", () => {
    expect(Object.keys(IMAGE_MIMES).length).toBe(6);
  });
});

// ---- 2. analyzeImages（mock SDK） ----

describe("vision analyzeImages（v0.5.13 · mock）", () => {
  afterEach(() => { setZaiFactory(null); delete process.env.DHV_VISION_DISABLE_SDK; });

  test("成功：text/chars/images + prompt 透传；消息结构（text + image_url data URL）", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const out = await analyzeImages([{ buf: pngBuf() }, { buf: jpegBuf() }], "图里有什么？");
    expect(out.ok).toBe(true);
    expect(out.text).toContain("咖啡");
    expect(out.chars).toBe(out.text!.length);
    expect(out.images).toBe(2);
    expect(out.prompt).toBe("图里有什么？");
    expect(fake.calls.vision).toBe(1);
    // 消息结构：content 数组 = [text, image_url ×2]
    const msg = (fake.calls.last as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }).messages[0];
    expect(msg.role).toBe("user");
    expect(msg.content.length).toBe(3);
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[1].type).toBe("image_url");
    const url = (msg.content[1].image_url as { url: string }).url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // thinking 禁用（与 skill 推荐一致）
    expect((fake.calls.last as { thinking: { type: string } }).thinking.type).toBe("disabled");
  });

  test("缺省 prompt：VISION_DEFAULT_PROMPT 兜底", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const out = await analyzeImage(pngBuf(), undefined);
    expect(out.ok).toBe(true);
    expect(out.prompt).toBe(VISION_DEFAULT_PROMPT);
  });

  test("超长 prompt：诚实截断（promptTruncated: true）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const long = "问".repeat(VISION_PROMPT_MAX + 50);
    const out = await analyzeImage(pngBuf(), undefined, long);
    expect(out.ok).toBe(true);
    expect(out.promptTruncated).toBe(true);
    expect(out.prompt!.length).toBe(VISION_PROMPT_MAX);
  });

  test("空列表 / 超张数 / 超体积：明确人话错误（不触 SDK）", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const empty = await analyzeImages([]);
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("图片为空");
    const many = await analyzeImages(Array.from({ length: VISION_MAX_IMAGES + 1 }, () => ({ buf: pngBuf() })));
    expect(many.ok).toBe(false);
    expect(many.error).toContain("图片过多");
    const big = await analyzeImage(Buffer.concat([pngBuf(), Buffer.alloc(10 * 1024 * 1024 + 1)]));
    expect(big.ok).toBe(false);
    expect(big.error).toContain("过大");
    expect(fake.calls.vision).toBe(0); // 校验全在 SDK 前
  });

  test("非图片载荷（魔数嗅探失败 + 无声明 mime）→ 拒绝", async () => {
    setZaiFactory(async () => makeFakeZai());
    const out = await analyzeImage(textBuf(), undefined);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("格式不受支持");
  });

  test("伪造 mime：声明 png 但内容是 jpeg → 拒绝（不信任客户端声明）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const out = await analyzeImage(jpegBuf(), "image/png");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("伪造");
  });

  test("声明 mime 与嗅探一致（png/png）→ 放行；别名 jpg/jpeg → 放行", async () => {
    setZaiFactory(async () => makeFakeZai());
    const ok1 = await analyzeImage(pngBuf(), "image/png");
    expect(ok1.ok).toBe(true);
    const ok2 = await analyzeImage(jpegBuf(), "image/jpg");
    expect(ok2.ok).toBe(true);
  });

  test("401 降级：明确 remedy 文案（凭据未配置 + 文本交互不受影响）", async () => {
    setZaiFactory(async () => { throw new Error("401 missing X-Token header"); });
    const out = await analyzeImage(pngBuf(), "image/png");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("凭据");
    expect(out.error).toContain("📷");
  });

  test("空结果：SDK 返回空 content → 明确错误", async () => {
    setZaiFactory(async () => makeFakeZai({ content: "   " }));
    const out = await analyzeImage(pngBuf(), "image/png");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("分析结果为空");
  });

  test("visionStatus：在线（formats 计数）与降级（error 透传）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const ok = await visionStatus();
    expect(ok.sdk).toBe(true);
    expect(ok.formats).toBe(6);
    setZaiFactory(async () => { throw new Error("401 missing X-Token"); });
    const bad = await visionStatus();
    expect(bad.sdk).toBe(false);
    expect(bad.error).toContain("凭据");
  });

  test("禁用开关：DHV_VISION_DISABLE_SDK=1 → 显式拒绝（零外联模式）", async () => {
    process.env.DHV_VISION_DISABLE_SDK = "1";
    setZaiFactory(null); // 真实懒加载路径（开关检查先于 import）
    const out = await analyzeImage(pngBuf(), "image/png");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("DHV_VISION_DISABLE_SDK");
    delete process.env.DHV_VISION_DISABLE_SDK;
  });
});

// ---- 3. Web 端点（startWebServer · port 0 随机） ------------------------------------

describe("vision Web 端点（v0.5.13）", () => {
  let server: ReturnType<typeof startWebServer>;
  let base: string;
  let ws: string;

  beforeAll(() => {
    ws = makeWorkspace("web-vision");
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(() => {
    server.stop(true);
    setZaiFactory(null);
    delete process.env.DHV_VISION_DISABLE_SDK;
  });

  test("GET /api/vision-status：JSON（sdk 布尔 + formats 数）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const r = await fetch(`${base}/api/vision-status`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { sdk: boolean; formats: number };
    expect(j.sdk).toBe(true);
    expect(j.formats).toBe(6);
  });

  test("POST /api/vision：单图 200（data URL 前缀容忍 + chars/prompt 回传）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const r = await fetch(`${base}/api/vision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_base64: `data:image/png;base64,${pngBuf().toString("base64")}`,
        prompt: "描述一下",
      }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; text: string; chars: number; images: number; prompt: string };
    expect(j.ok).toBe(true);
    expect(j.text).toContain("咖啡");
    expect(j.images).toBe(1);
    expect(j.prompt).toBe("描述一下");
    expect(j.chars).toBe(j.text.length);
  });

  test("POST /api/vision：多图形态（images[] 数组）", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const r = await fetch(`${base}/api/vision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [
          { base64: pngBuf().toString("base64") },
          { base64: jpegBuf().toString("base64") },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; images: number };
    expect(j.ok).toBe(true);
    expect(j.images).toBe(2);
    expect(fake.calls.vision).toBe(1);
  });

  test("POST /api/vision：缺 image_base64 → 400；401 → 503 JSON（remedy）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const r400 = await fetch(`${base}/api/vision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "没有图" }),
    });
    expect(r400.status).toBe(400);
    const j400 = (await r400.json()) as { ok: boolean; error: string };
    expect(j400.error).toContain("image_base64");

    setZaiFactory(async () => { throw new Error("401 missing X-Token header"); });
    const r503 = await fetch(`${base}/api/vision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_base64: pngBuf().toString("base64") }),
    });
    expect(r503.status).toBe(503);
    const j503 = (await r503.json()) as { ok: boolean; error: string };
    expect(j503.ok).toBe(false);
    expect(j503.error).toContain("凭据");
  });

  test("GUI 单页含视觉要素（📷 按钮 / file input / visTx 浮条 / [hidden] 防护 / 内联脚本自洽）", async () => {
    const html = await (await fetch(`${base}/`)).text();
    for (const needle of [
      'id="visBtn"', 'id="visFile"', 'id="visTx"', 'id="visTxText"',
      'accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"',
      '"/api/vision"', "previewVoice", "voaud", // v0.5.13 试听钮同页顺带断言
      "data-del", "spwclean",                    // v0.5.13 派生池清理同页顺带断言
    ]) {
      expect(html).toContain(needle);
    }
    // B-20 全局防护（.mictx/.schmeta 幽灵浮条修复）必须在场
    expect(html).toContain("[hidden] { display: none !important; }");
    // 内联脚本自洽
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1]!)).not.toThrow();
  });

  test("DELETE /api/spawns：mode 防呆（非法值 → 400）", async () => {
    const r = await fetch(`${base}/api/spawns`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "bogus" }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.error).toContain("mode");
  });

  test("DELETE /api/spawns：failed 清理（失败 + 孤儿半成品删，成功保留）", async () => {
    const spawnRoot = path.join(ws, "spawn");
    fs.rmSync(spawnRoot, { recursive: true, force: true }); // 清场（测试隔离）
    fs.mkdirSync(spawnRoot, { recursive: true });
    // 池登记：1 成功 + 1 失败
    const pool = {
      version: 1,
      records: [
        { id: "ok-1", goal: "成功派生", mode: "run", depth: 1, budget: 50, ok: true, workspace: path.join(spawnRoot, "ok-1") },
        { id: "bad-1", goal: "失败派生", mode: "run", depth: 1, budget: 50, ok: false, workspace: path.join(spawnRoot, "bad-1") },
      ],
    };
    fs.writeFileSync(path.join(spawnRoot, "pool.json"), JSON.stringify(pool));
    // 目录：成功 + 失败 + 孤儿半成品（无 run.json）
    for (const id of ["ok-1", "bad-1", "orphan-1"]) {
      fs.mkdirSync(path.join(spawnRoot, id), { recursive: true });
    }
    const r = await fetch(`${base}/api/spawns`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "failed" }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; removed: number; records_kept: number; dirs_removed: number };
    expect(j.ok).toBe(true);
    expect(j.removed).toBe(2);      // bad-1 + orphan-1（半成品 = 失败语义）
    expect(j.records_kept).toBe(1); // ok-1 保留
    expect(j.dirs_removed).toBe(2);
    expect(fs.existsSync(path.join(spawnRoot, "ok-1"))).toBe(true);
    expect(fs.existsSync(path.join(spawnRoot, "bad-1"))).toBe(false);
    expect(fs.existsSync(path.join(spawnRoot, "orphan-1"))).toBe(false);
    // 池回写：只剩 ok-1
    const after = JSON.parse(fs.readFileSync(path.join(spawnRoot, "pool.json"), "utf-8"));
    expect(after.records.length).toBe(1);
    expect(after.records[0].id).toBe("ok-1");
  });

  test("DELETE /api/spawns：ids 精确删除 + all 全量重置", async () => {
    const spawnRoot = path.join(ws, "spawn");
    fs.rmSync(spawnRoot, { recursive: true, force: true }); // 清场（测试隔离）
    fs.mkdirSync(spawnRoot, { recursive: true });
    const pool = {
      version: 1,
      records: [
        { id: "keep-2", goal: "保留", ok: true, workspace: path.join(spawnRoot, "keep-2") },
        { id: "drop-2", goal: "删除", ok: true, workspace: path.join(spawnRoot, "drop-2") },
      ],
    };
    fs.writeFileSync(path.join(spawnRoot, "pool.json"), JSON.stringify(pool));
    for (const id of ["keep-2", "drop-2"]) {
      fs.mkdirSync(path.join(spawnRoot, id), { recursive: true });
    }
    // ids 精确删
    const r1 = await fetch(`${base}/api/spawns`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["drop-2"] }),
    });
    const j1 = (await r1.json()) as { ok: boolean; removed: number; records_kept: number };
    expect(j1.ok).toBe(true);
    expect(j1.removed).toBe(1);
    expect(j1.records_kept).toBe(1);
    expect(fs.existsSync(path.join(spawnRoot, "keep-2"))).toBe(true);
    // all 全量重置
    const r2 = await fetch(`${base}/api/spawns`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "all" }),
    });
    const j2 = (await r2.json()) as { ok: boolean; removed: number; records_kept: number };
    expect(j2.ok).toBe(true);
    expect(j2.removed).toBe(1);      // keep-2（all 语义：成功也删）
    expect(j2.records_kept).toBe(0);
    expect(fs.existsSync(path.join(spawnRoot, "keep-2"))).toBe(false);
  });
});
