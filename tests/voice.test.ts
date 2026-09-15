// ============================================================================
// tests/voice.test.ts — 语音入口（v0.5.12）：ASR 转写 + TTS 合成
// ============================================================================
// 覆盖面（全部 mock —— setZaiFactory 注入 fake zai，零外联、确定性）：
//   1. 纯函数：splitTtsChunks（句子边界/逗号次级/超长硬切/空白归一/空文本）·
//      normalizeVoice（白名单/未知名归缺省）· normalizeSpeed（clamp [0.5,2]）
//   2. TTS 合成（mock）：单段 PCM → WAV（RIFF 头 + 24kHz 单声道参数）·
//      多段拼接（chunks 计数 + PCM 连续）· 超长截断（truncated）·
//      缓存命中（零重复调用）· 401 降级（明确 remedy 文案）
//   3. ASR 转写（mock）：成功（text/chars）· 空结果明确错误 · 401 降级
//   4. 禁用开关：DHV_VOICE_DISABLE_SDK=1 → 显式拒绝（零外联模式）
//   5. Web 端点（startWebServer · port 0）：POST /api/tts（audio/wav 二进制 +
//      X-Voice-* 头）· POST /api/asr（JSON）· 503 降级 JSON · GUI 要素
//      （🎙 面板 / 🎤 按钮 / 🔊 操作钮 / 内联脚本自洽）
// ============================================================================

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, makeWorkspace } from "./helpers";
import { startWebServer } from "../web/entry.ts";
import {
  VOICES, splitTtsChunks, normalizeVoice, normalizeSpeed,
  setZaiFactory, synthesizeSpeech, transcribeAudio, voiceStatus,
  TTS_CHUNK_MAX, TTS_TEXT_LIMIT,
} from "../lib/voice.ts";

/** fake zai：TTS 返回确定性 PCM（每段 4800 字节 = 0.1s @24kHz PCM16）；
 *  ASR 返回固定文本。调用计数供缓存断言。 */
function makeFakeZai(opts: { fail?: string; asrText?: string } = {}) {
  const calls = { tts: 0, asr: 0 };
  const fake = {
    audio: {
      tts: {
        create: async (r: { input: string; voice: string; speed: number; response_format: string; stream: boolean }) => {
          calls.tts++;
          if (opts.fail) throw new Error(opts.fail);
          expect(r.response_format).toBe("pcm");    // 拼接车道：PCM（确定行为）
          expect(r.stream).toBe(false);             // 流式仅支持 pcm，非流式对齐
          // 确定性 PCM：段长由输入长度驱动（可区分多段）
          const n = Math.max(4800, r.input.length * 48);
          return new Response(new Uint8Array(n));
        },
      },
      asr: {
        create: async (r: { file_base64: string }) => {
          calls.asr++;
          if (opts.fail) throw new Error(opts.fail);
          return { text: opts.asrText ?? "这是转写出的文本。" };
        },
      },
    },
    calls,
  };
  return fake;
}

describe("voice 纯函数（v0.5.12）", () => {
  test("splitTtsChunks：短文本单段；空白归一", () => {
    expect(splitTtsChunks("你好")).toEqual(["你好"]);
    expect(splitTtsChunks("  多  空  白  \n\t 换 行  ")).toEqual(["多 空 白 换 行"]);
    expect(splitTtsChunks("")).toEqual([]);
  });

  test("splitTtsChunks：句子边界切块（。！？!?…）", () => {
    const long1 = "甲".repeat(600), long2 = "乙".repeat(500);
    const out = splitTtsChunks(`${long1}。${long2}！`, 1000);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(long1 + "。");
    expect(out[1]).toBe(long2 + "！");
  });

  test("splitTtsChunks：无句边界超长 → 逗号次级 → 硬切", () => {
    const noPunct = "字".repeat(2500);
    const out = splitTtsChunks(noPunct, 1000);
    expect(out.length).toBe(3);
    expect(out.every((c) => c.length <= 1000)).toBe(true);
    expect(out.join("")).toBe(noPunct); // 无损重组
    // 逗号次级边界：切点落在逗号后
    const comma = "A".repeat(998) + "，" + "B".repeat(998) + "，" + "C".repeat(998);
    const out2 = splitTtsChunks(comma, 1000);
    expect(out2.length).toBe(3);
  });

  test("normalizeVoice：白名单命中；未知名/未设 → tongtong", () => {
    expect(normalizeVoice("jam")).toBe("jam");
    expect(normalizeVoice("JAM")).toBe("jam");
    expect(normalizeVoice("no-such")).toBe("tongtong");
    expect(normalizeVoice(undefined)).toBe("tongtong");
    expect(Object.keys(VOICES).length).toBe(7);
  });

  test("normalizeSpeed：clamp [0.5, 2.0]；非法 → 1.0", () => {
    expect(normalizeSpeed(0.3)).toBe(0.5);
    expect(normalizeSpeed(9)).toBe(2);
    expect(normalizeSpeed("1.5")).toBe(1.5);
    expect(normalizeSpeed(Number.NaN)).toBe(1);
    expect(normalizeSpeed(undefined)).toBe(1);
  });
});

describe("voice TTS/ASR（mock zai · 确定性）", () => {
  afterEach(() => {
    setZaiFactory(null);
    delete process.env.DHV_VOICE_DISABLE_SDK;
  });

  test("TTS 单段：PCM → WAV 封头（RIFF · 24kHz · 单声道 · PCM16）", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const o = await synthesizeSpeech("短句。", { voice: "jam", speed: 1.2 });
    expect(o.ok).toBe(true);
    expect(o.voice).toBe("jam");
    expect(o.speed).toBe(1.2);
    expect(o.chunks).toBe(1);
    expect(o.truncated).toBe(false);
    const w = o.wav!;
    expect(w.length).toBeGreaterThan(44);
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.toString("ascii", 8, 12)).toBe("WAVE");
    expect(w.readUInt16LE(20)).toBe(1);      // PCM
    expect(w.readUInt16LE(22)).toBe(1);      // 单声道
    expect(w.readUInt32LE(24)).toBe(24000);  // 24kHz
    expect(w.readUInt16LE(34)).toBe(16);     // 16bit
    expect(w.length).toBe(44 + 4800);        // fake 段长（输入 3 字 × 48 < 4800 → max 兜底）
    expect(fake.calls.tts).toBe(1);
  });

  test("TTS 多段拼接：chunks 计数 + PCM 连续（段长由输入驱动）", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const a = "甲".repeat(600) + "。", b = "乙".repeat(500) + "！";
    const o = await synthesizeSpeech(a + b); // 1100+ 字 → 2 段
    expect(o.ok).toBe(true);
    expect(o.chunks).toBe(2);
    expect(fake.calls.tts).toBe(2);
    // PCM 连续：(601字含句号)×48 + (501字含叹号)×48 → 28848+24048
    expect(o.wav!.length).toBe(44 + 601 * 48 + 501 * 48);
  });

  test("TTS 超长截断：>TTS_TEXT_LIMIT → truncated + bounded", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const long = "长".repeat(TTS_TEXT_LIMIT + 100);
    const o = await synthesizeSpeech(long);
    expect(o.ok).toBe(true);
    expect(o.truncated).toBe(true);
    expect(o.totalChars).toBe(TTS_TEXT_LIMIT + 100);
  });

  test("TTS 缓存：同文本同参数二次命中（零重复调用）", async () => {
    const fake = makeFakeZai();
    setZaiFactory(async () => fake);
    const first = await synthesizeSpeech("缓存测试句子。", { voice: "kazi" });
    expect(first.ok).toBe(true);
    expect(fake.calls.tts).toBe(1);
    const second = await synthesizeSpeech("缓存测试句子。", { voice: "kazi" });
    expect(second.ok).toBe(true);
    expect(fake.calls.tts).toBe(1); // 缓存命中：不重复调 SDK
    expect(second.wav!.length).toBe(first.wav!.length);
    // 不同参数 → 不命中（缓存键含 voice/speed）
    const third = await synthesizeSpeech("缓存测试句子。", { voice: "kazi", speed: 1.5 });
    expect(fake.calls.tts).toBe(2);
  });

  test("TTS 401 降级：明确 remedy 文案（部署提示，不裸抛）", async () => {
    setZaiFactory(async () => makeFakeZai({ fail: "API request failed with status 401: missing X-Token header" }));
    const o = await synthesizeSpeech("会被拒绝的句子。");
    expect(o.ok).toBe(false);
    expect(o.error).toContain("语音服务凭据未配置");
    expect(o.error).toContain("401");
  });

  test("ASR 成功：text + chars", async () => {
    const fake = makeFakeZai({ asrText: "转写结果文本。" });
    setZaiFactory(async () => fake);
    const o = await transcribeAudio(Buffer.from("fake-audio-bytes"));
    expect(o.ok).toBe(true);
    expect(o.text).toBe("转写结果文本。");
    expect(o.chars).toBe(7);
    expect(fake.calls.asr).toBe(1);
  });

  test("ASR 空结果 / 空音频 / 超限：明确错误", async () => {
    setZaiFactory(async () => makeFakeZai({ asrText: "   " })); // 空白转写
    const o1 = await transcribeAudio(Buffer.from("x"));
    expect(o1.ok).toBe(false);
    expect(o1.error).toContain("转写结果为空");
    const o2 = await transcribeAudio(Buffer.alloc(0));
    expect(o2.ok).toBe(false);
    expect(o2.error).toContain("音频为空");
    const big = Buffer.alloc(16 * 1024 * 1024); // > 15MB
    const o3 = await transcribeAudio(big);
    expect(o3.ok).toBe(false);
    expect(o3.error).toContain("音频过大");
  });

  test("DHV_VOICE_DISABLE_SDK=1：显式拒绝（零外联开关）", async () => {
    process.env.DHV_VOICE_DISABLE_SDK = "1";
    setZaiFactory(async () => makeFakeZai()); // 有 factory 也应被开关拒绝
    const o = await synthesizeSpeech("禁用模式。");
    expect(o.ok).toBe(false);
    expect(o.error).toContain("DHV_VOICE_DISABLE_SDK");
    const st = await voiceStatus();
    expect(st.sdk).toBe(false);
  });

  test("voiceStatus：factory 就绪 → sdk=true + 7 声音", async () => {
    setZaiFactory(async () => makeFakeZai());
    const st = await voiceStatus();
    expect(st.sdk).toBe(true);
    expect(st.voices).toBe(7);
  });
});

// ---- Web 端点（startWebServer · port 0 随机） ------------------------------------

describe("voice Web 端点（v0.5.12）", () => {
  let server: ReturnType<typeof startWebServer>;
  let base: string;
  let ws: string;

  beforeAll(() => {
    ws = makeWorkspace("web-voice");
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(() => {
    server.stop(true);
    setZaiFactory(null);
  });

  test("GET /api/voice-status：JSON（sdk 布尔 + voices 数）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const r = await fetch(`${base}/api/voice-status`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { sdk: boolean; voices: number };
    expect(j.sdk).toBe(true);
    expect(j.voices).toBe(7);
  });

  test("POST /api/tts：200 + audio/wav + RIFF + X-Voice-* 头（mock 合成）", async () => {
    setZaiFactory(async () => makeFakeZai());
    const r = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "网页朗读测试。", voice: "xiaochen", speed: 1.1 }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect(r.headers.get("X-Voice-Chunks")).toBe("1");
    expect(r.headers.get("X-Voice-Truncated")).toBe("0");
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(24)).toBe(24000);
  });

  test("POST /api/tts：降级 503 JSON（凭据缺席 → 明确 error）；空文本 400", async () => {
    setZaiFactory(async () => { throw new Error("401 missing X-Token header"); });
    const r = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "会失败。" }),
    });
    expect(r.status).toBe(503);
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain("凭据");
    // 空文本 → 400（参数校验先于 SDK）
    const r2 = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(r2.status).toBe(400);
  });

  test("POST /api/asr：200 + text（mock 转写）；无音频 400；401 → 503", async () => {
    setZaiFactory(async () => makeFakeZai({ asrText: "网页转写测试文本。" }));
    const r = await fetch(`${base}/api/asr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_base64: Buffer.from("fake-webm").toString("base64") }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; text: string; chars: number };
    expect(j.ok).toBe(true);
    expect(j.text).toBe("网页转写测试文本。");
    expect(j.chars).toBe(9);
    // dataURL 前缀形态也接受（FileReader.readAsDataURL 产物）
    const r2 = await fetch(`${base}/api/asr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_base64: "data:audio/webm;base64," + Buffer.from("x").toString("base64") }),
    });
    expect(r2.status).toBe(200);
    // 无音频 → 400
    const r3 = await fetch(`${base}/api/asr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r3.status).toBe(400);
    // 401 → 503
    setZaiFactory(async () => { throw new Error("401 missing X-Token"); });
    const r4 = await fetch(`${base}/api/asr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_base64: Buffer.from("x").toString("base64") }),
    });
    expect(r4.status).toBe(503);
    const j4 = (await r4.json()) as { ok: boolean; error: string };
    expect(j4.ok).toBe(false);
    expect(j4.error).toContain("凭据");
  });

  test("GUI 单页含语音要素（🎙 面板 / 🎤 按钮 / 🔊 操作钮 / Esc 关闭）", async () => {
    const html = await (await fetch(`${base}/`)).text();
    for (const needle of [
      'id="voiceBtn"', 'id="voicePane"', 'id="voGrid"', 'id="voSpeed"',
      'id="micBtn"', 'id="micTx"',
      "/api/voice-status", "/api/asr", "/api/tts",
      "function openVoice(", "function closeVoice(", "function speakText(",
      "function refreshVoiceStatus(", "mact-say",
      '{ pane: "voicePane", close: closeVoice }',
      "VOICE_META", 'localStorage.getItem("org.voice")',
    ]) {
      expect(html).toContain(needle);
    }
    // 声音清单由服务端注入（单一来源 lib/voice.ts VOICES）
    expect(html).toContain("tongtong");
    expect(html).toContain("富有感染力");
    // 内联脚本自洽
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1]!)).not.toThrow();
  });
});

// ---- CLI：org speak（子进程 spawn —— mock factory 不跨进程，用零外联开关
// 测确定降级路径；成功路径（WAV 封头/分段/缓存）已在模块层 mock 覆盖） ----

describe("voice CLI（org speak · 零外联开关路径）", () => {
  test("org speak：DHV_VOICE_DISABLE_SDK=1 → 明确拒绝 + 退出码 1（任何环境一致）", async () => {
    const proc = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "cli", "org.ts"),
      "speak", "禁用模式句子。", "--out", path.join(TEST_RUN, "no.wav")], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DHV_VOICE_DISABLE_SDK: "1" },
    });
    const text = proc.stdout.toString() + proc.stderr.toString();
    expect(text).toContain("合成失败");
    expect(text).toContain("DHV_VOICE_DISABLE_SDK");
    expect(proc.exitCode).toBe(1);
    expect(fs.existsSync(path.join(TEST_RUN, "no.wav"))).toBe(false); // 失败不落盘
  }, 30_000);

  test("org voice：DHV_VOICE_DISABLE_SDK=1 → 退出码 3 + 状态不就绪", async () => {
    const proc = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "cli", "org.ts"),
      "voice"], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DHV_VOICE_DISABLE_SDK: "1" },
    });
    const text = proc.stdout.toString();
    expect(text).toContain("未就绪");
    expect(text).toContain("tongtong"); // 声音清单照常展示（缺省信息完整）
    expect(proc.exitCode).toBe(3);
  }, 30_000);
});
