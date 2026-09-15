// ============================================================================
// tests/audio.test.ts — 音频产物链路（v0.5.6）：notes.json → WAV 开袋即食
// ============================================================================
// 覆盖面：
//   1. 渲染器单元（lib/audio.ts 纯函数）：
//      - WAV 头字节级校验（RIFF/WAVE/fmt/PCM16/双通道/采样率/字节率）
//      - 时长公式（拍 × 60/tempo + 曲尾余量）
//      - 非静音断言（RMS > 阈值 —— 蜂鸣空产物当场可见）
//      - 峰值归一化（|peak| ≤ 0.9×32767 —— 不爆音）
//      - 容错矩阵：非对象 / notes 缺失 / 空数组 / 全非法音符 / 全零增益
//      - 字段级降级：坏音符跳过（skipped 记录），好音符照常渲染
//      - 时长上限截断（>240s 截断 + error 提示）
//   2. 文件级渲染（renderNotesFileSync / scanAndRenderArtifacts）：
//      - 文件 → 同名 .wav；坏 JSON → 明确 error 不抛出
//      - 幂等（mtime 新于 notes 的 wav 跳过）；.hsl-runs 目录跳过
//   3. e2e（org run 团队车道，scripted 剧本）：
//      - 音乐任务 → 路由 B:reuse → composer 专家 → music.notes.json
//        + music.wav（RIFF 头校验 + 时长 ≈ 30s）+ ♪ 渲染行 + audio_rendered 事件
//      - 优雅降级：非法 compose 输出 → 内置卡农兜底（WAV 仍在 + 降级标注）
//   4. e2e（工具环 audio_compose，direct 车道）：模型作曲 → 工件 + 渲染
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, runOrg, eventsOf } from "./helpers";
import {
  renderNotesToWav,
  renderNotesFileSync,
  scanAndRenderArtifacts,
  wavInfo,
} from "../lib/audio.ts";

const WS = path.join(TEST_RUN, "audio-ws");
const MUSIC_FIXTURE = path.join(ROOT_FIX(), "fixtures/run-music.json");

function ROOT_FIX(): string {
  return path.resolve(import.meta.dir, "..");
}

/** 单音正弦（最小合法乐谱）。 */
function sineNotes(freq = 440, beats = 2, tempo = 60): Record<string, unknown> {
  return { title: "单音测试", tempo, notes: [{ freq, start_beat: 0, beats }] };
}

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT_FIX(), "demo-ws"), WS, { recursive: true });
});

afterEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

function makeOut(name: string): string {
  const dir = path.join(TEST_RUN, "out-audio", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** WAV 帧的 RMS（音量实证：非静音断言用）。 */
function rms(buf: Buffer): number {
  let sum = 0;
  const frames = Math.floor((buf.length - 44) / 4); // 立体声 2×i16
  for (let i = 0; i < frames; i++) {
    const l = buf.readInt16LE(44 + i * 4);
    sum += l * l;
  }
  return Math.sqrt(sum / Math.max(1, frames));
}

// ---- 1. 渲染器单元 -----------------------------------------------------------

describe("audio：渲染器单元（lib/audio.ts）", () => {
  test("WAV 头字节级校验：RIFF/WAVE/fmt/PCM16/双通道/44100", () => {
    const r = renderNotesToWav(sineNotes());
    expect(r.ok).toBe(true);
    const wav = r.wav!;
    expect(wav.length).toBeGreaterThan(44);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(2); // 立体声
    expect(wav.readUInt32LE(24)).toBe(44100); // 采样率
    expect(wav.readUInt16LE(34)).toBe(16); // 位深
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8); // RIFF 尺寸
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44); // data 尺寸
  });

  test("时长公式：2 拍 @60BPM = 2s + 0.4s 曲尾余量", () => {
    const r = renderNotesToWav(sineNotes(440, 2, 60));
    expect(r.durationSec).toBe(2.4);
    expect(wavInfo(r.wav!)!.durationSec).toBeCloseTo(2.4, 2);
  });

  test("非静音 + 峰值归一化（|sample| ≤ 0.9×32767，不爆音）", () => {
    const notes = sineNotes(440, 2, 60);
    (notes["notes"] as Array<Record<string, unknown>>)[0]!["gain"] = 1.0;
    const r = renderNotesToWav(notes);
    expect(r.ok).toBe(true);
    const wav = r.wav!;
    expect(rms(wav)).toBeGreaterThan(3000); // 有实际音量（非静音产物）
    let peak = 0;
    for (let i = 44; i + 1 < wav.length; i += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    }
    expect(peak).toBeLessThanOrEqual(Math.round(0.9 * 32767) + 1);
  });

  test("容错矩阵：非对象 / notes 缺失 / 空数组 / 全零增益 → 明确 error", () => {
    expect(renderNotesToWav(null).ok).toBe(false);
    expect(renderNotesToWav("string").ok).toBe(false);
    expect(renderNotesToWav({}).ok).toBe(false);
    expect(renderNotesToWav({ notes: [] }).ok).toBe(false);
    const silent = { notes: [{ freq: 440, start_beat: 0, beats: 1, gain: 0 }] };
    expect(renderNotesToWav(silent).ok).toBe(false); // 全静音 = 假绿拒绝
  });

  test("字段级降级：坏音符跳过并记录 skipped，好音符照常渲染", () => {
    const doc = {
      tempo: 60,
      notes: [
        { freq: 440, start_beat: 0, beats: 1 }, // 好
        { freq: "abc", start_beat: 1, beats: 1 }, // 坏：freq 非数
        { start_beat: 2, beats: 1 }, // 坏：freq 缺失
        { freq: 523.25, start_beat: 3, beats: 1 }, // 好
      ],
    };
    const r = renderNotesToWav(doc);
    expect(r.ok).toBe(true);
    expect(r.noteCount).toBe(2);
    expect(r.skipped).toBeDefined();
    expect(r.skipped!.length).toBe(2);
  });

  test("时长上限：超 240s 截断 + error 提示（不静默）", () => {
    // 起拍 200 + 64 拍 @60BPM ≈ 264s > 240（beats 单音符钳 64：跨线音符，截断内可闻）
    const doc = { tempo: 60, notes: [{ freq: 440, start_beat: 200, beats: 64 }] };
    const r = renderNotesToWav(doc);
    expect(r.ok).toBe(true);
    expect(r.durationSec).toBeLessThanOrEqual(240);
    expect(r.error).toContain("截断");
  });
});

// ---- 2. 文件级渲染 -------------------------------------------------------------

describe("audio：文件级渲染与扫描", () => {
  test("renderNotesFileSync：合法文件 → 同名 .wav；坏 JSON → error 不抛出", () => {
    const dir = makeOut("file-level");
    const good = path.join(dir, "good.notes.json");
    fs.writeFileSync(good, JSON.stringify(sineNotes(523.25, 3, 90)));
    const r = renderNotesFileSync(good);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.wavFile).toBe("good.wav");
      expect(fs.existsSync(path.join(dir, "good.wav"))).toBe(true);
      expect(r.notes).toBe(1);
    }
    const bad = path.join(dir, "bad.notes.json");
    fs.writeFileSync(bad, "{not json");
    const r2 = renderNotesFileSync(bad);
    expect("error" in r2).toBe(true);
    expect((r2 as { error: string }).error).toContain("JSON");
  });

  test("scanAndRenderArtifacts：子目录递归 + 幂等跳过 + .hsl-runs 排除", () => {
    const dir = makeOut("scan");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".hsl-runs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.notes.json"), JSON.stringify(sineNotes()));
    fs.writeFileSync(path.join(dir, "sub", "b.notes.json"), JSON.stringify(sineNotes()));
    fs.writeFileSync(path.join(dir, ".hsl-runs", "c.notes.json"), JSON.stringify(sineNotes()));
    const r1 = scanAndRenderArtifacts(dir);
    expect(r1.rendered.length).toBe(2); // .hsl-runs 排除
    expect(fs.existsSync(path.join(dir, "a.wav"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "sub", "b.wav"))).toBe(true);
    // 幂等：再扫一次零渲染（wav 已新于 notes）
    const r2 = scanAndRenderArtifacts(dir);
    expect(r2.rendered.length).toBe(0);
  });
});

// ---- 3. e2e：团队车道（org run → composer 专家 → WAV 产物） -------------------

describe("audio：e2e 团队车道（古典音乐 = 音频不是乐谱）", () => {
  test("音乐任务：路由 B:reuse → composer → music.wav（RIFF + ~30s）+ ♪ 行 + 事件", async () => {
    const out = path.join(WS, "out-music");
    const r = runOrg([
      "run", "--task", "为读书会创作一段约 30 秒的古典背景音乐（卡农风格）",
      "--workspace", WS,
      "--fixture", MUSIC_FIXTURE,
      "--out", out,
    ]);
    expect(r.ok).toBe(true);
    // 路由与专家执行
    expect(r.stdout).toContain("task#2 compose");
    expect(r.stdout).toContain("music.notes.json + music.wav");
    // ♪ 渲染行（CLI 车道收尾）
    expect(r.stdout).toContain("♪ 音频产物已渲染：music.wav");
    // 产物本体：真 WAV（RIFF 头 + 双通道 + ≈30s）
    const wavPath = path.join(out, "music.wav");
    expect(fs.existsSync(wavPath)).toBe(true);
    const info = wavInfo(fs.readFileSync(wavPath));
    expect(info).not.toBeNull();
    expect(info!.channels).toBe(2);
    expect(info!.durationSec).toBeGreaterThan(28);
    expect(info!.durationSec).toBeLessThan(32);
    // 事件留痕（三端观测面）
    const events = eventsOf(out);
    const audioEv = events.filter((e) => e.name === "audio_rendered");
    expect(audioEv.length).toBe(1);
    const files = (audioEv[0]!.data as { files?: Array<{ wavFile?: string; file?: string }> }).files ?? [];
    expect(files.some((f) => (f.wavFile ?? f.file) === "music.wav")).toBe(true);
  }, 120_000);

  test("优雅降级：非法 compose 输出 → 内置卡农兜底（WAV 仍在 + 降级标注）", async () => {
    // 剧本：compose 轨道返回垃圾文本（模型输出不可解析）
    const fixture = path.join(TEST_RUN, "audio-degraded-fixture.json");
    const base = JSON.parse(fs.readFileSync(MUSIC_FIXTURE, "utf-8")) as { tracks: Record<string, string[]> };
    base.tracks["compose"] = ["这不是 JSON，只是胡言乱语。"];
    fs.writeFileSync(fixture, JSON.stringify(base));
    const out = path.join(WS, "out-music-degraded");
    const r = runOrg([
      "run", "--task", "为读书会创作一段约 30 秒的古典背景音乐（卡农风格）",
      "--workspace", WS,
      "--fixture", fixture,
      "--out", out,
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("降级"); // 降级事实可观测（不静默）
    const wavPath = path.join(out, "music.wav");
    expect(fs.existsSync(wavPath)).toBe(true);
    const info = wavInfo(fs.readFileSync(wavPath));
    expect(info).not.toBeNull();
    expect(info!.durationSec).toBeGreaterThan(20); // 兜底卡农 8 小节 ≈ 27s
    expect(rms(fs.readFileSync(wavPath))).toBeGreaterThan(3000);
  }, 120_000);
});

// ---- 4. e2e：工具环（direct 车道 audio_compose → 工件 + 渲染） ----------------

describe("audio：e2e 工具环（audio_compose 工具）", () => {
  test("direct 车道作曲：模型调 audio_compose → 工件 + CLI 收尾渲染 WAV", async () => {
    const fixture = path.join(TEST_RUN, "audio-tool-fixture.json");
    const doc = {
      acts: [], reviews: [],
      tracks: {
        "direct:notice-parser": [
          '好的，我作曲。\n<tool>{"name":"audio_compose","args":{"title":"工具环小夜曲","tempo":120,"notes":[{"freq":440,"start_beat":0,"beats":1},{"freq":493.88,"start_beat":1,"beats":1},{"freq":523.25,"start_beat":2,"beats":2}]}}</tool>',
          "最终答案：已创作「工具环小夜曲」（4 拍），music.wav 已渲染。",
        ],
      },
    };
    fs.writeFileSync(fixture, JSON.stringify(doc));
    const out = path.join(WS, "out-tool-audio");
    const r = runOrg([
      "ask", "notice-parser", "创作一段古典音乐",
      "--workspace", WS,
      "--fixture", fixture,
      "--out", out,
    ], { ORG_TOOLS: "write" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("♪ 音频产物已渲染：music.wav");
    const info = wavInfo(fs.readFileSync(path.join(out, "music.wav")));
    expect(info).not.toBeNull();
    expect(info!.durationSec).toBeGreaterThan(1.9); // 4 拍 @120BPM = 2s + 余量
  }, 120_000);

  test("只读模式降级：ORG_TOOLS=1 时 audio_compose 明确拒绝", async () => {
    const fixture = path.join(TEST_RUN, "audio-ro-fixture.json");
    const doc = {
      acts: [], reviews: [],
      tracks: {
        "direct:notice-parser": [
          '我试试作曲。\n<tool>{"name":"audio_compose","args":{"notes":[{"freq":440,"beats":1}]}}</tool>',
          "最终答案：工具环只读模式下无法作曲（需 ORG_TOOLS=write）。",
        ],
      },
    };
    fs.writeFileSync(fixture, JSON.stringify(doc));
    const out = path.join(WS, "out-tool-ro");
    const r = runOrg([
      "ask", "notice-parser", "创作一段古典音乐",
      "--workspace", WS,
      "--fixture", fixture,
      "--out", out,
    ], { ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const denied = events.filter((e) => e.name === "journal"
      && (e.data as { name?: string })?.name === "tool_denied");
    expect(denied.length).toBe(1);
    expect(fs.existsSync(path.join(out, "music.notes.json"))).toBe(false); // 未写工件
  }, 120_000);
});
