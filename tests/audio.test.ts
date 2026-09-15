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

// ============================================================================
// v0.5.9 音频工坊：音色库 × 和弦库 × MIDI 导出
// ============================================================================

import {
  TIMBRES,
  CHORD_QUALITIES,
  PROGRESSIONS,
  progressionToNotes,
  noteNameToMidi,
  midiToFreq,
  renderNotesToMidi,
} from "../lib/audio.ts";

describe("audio v0.5.9：音色库（TIMBRES · 8 种乐器）", () => {
  test("8 种音色全渲染：RIFF 头合法 + 双通道 + 非静音", () => {
    const names = Object.keys(TIMBRES);
    expect(names.length).toBe(8);
    expect(names).toEqual(expect.arrayContaining(["piano", "strings", "flute", "organ", "harpsichord", "music-box", "guitar", "bell"]));
    for (const name of names) {
      const spec = TIMBRES[name]!;
      expect(spec.partials.length).toBeGreaterThan(0);
      expect(spec.partials.every((p) => p.ratio > 0 && p.gain > 0)).toBe(true);
      const r = renderNotesToWav({
        title: `timbre-${name}`, tempo: 120, timbre: name,
        notes: [
          { freq: 261.63, start_beat: 0, beats: 1, gain: 0.7 },
          { freq: 329.63, start_beat: 1, beats: 1, gain: 0.7 },
          { freq: 392.0, start_beat: 2, beats: 2, gain: 0.7 },
        ],
      });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined(); // 无截断/无降级标注
      const info = wavInfo(r.wav!);
      expect(info).not.toBeNull();
      expect(info!.channels).toBe(2);
      // 非静音：正负峰值都存在（有起有伏，非直流）
      const buf = r.wav!;
      let pos = 0, neg = 0;
      for (let off = 44; off < Math.min(buf.length, 44 + 88200); off += 2) {
        const v = buf.readInt16LE(off);
        if (v > 8000) pos++;
        if (v < -8000) neg++;
      }
      expect(pos).toBeGreaterThan(10);
      expect(neg).toBeGreaterThan(10);
    }
  });

  test("音色 vs 田字格波形差异：strings（sustain 0.8 + 颤音）采样不同于无 timbre 基线", () => {
    const score = {
      title: "diff", tempo: 90,
      notes: [{ freq: 220, start_beat: 0, beats: 4, gain: 0.8 }],
    };
    const withTimbre = renderNotesToWav({ ...score, timbre: "strings" });
    const without = renderNotesToWav(score);
    expect(withTimbre.ok && without.ok).toBe(true);
    // 谐波表 + 颤音调制 → 两份 WAV 必然不同（字节级）
    expect(Buffer.compare(withTimbre.wav!, without.wav!)).not.toBe(0);
  });

  test("未知音色名降级：不炸曲（回退 wave 基础波形）", () => {
    const r = renderNotesToWav({
      timbre: "no-such-instrument",
      notes: [{ freq: 440, start_beat: 0, beats: 1, gain: 0.6, wave: "sine" }],
    });
    expect(r.ok).toBe(true); // 降级渲染而非失败
    expect(wavInfo(r.wav!)).not.toBeNull();
  });

  test("颤音音色冒烟：strings（5.5Hz FM）渲染成功且耗时受控", () => {
    const t0 = Date.now();
    const r = renderNotesToWav({
      tempo: 60, timbre: "strings",
      notes: Array.from({ length: 24 }, (_, i) => ({ freq: 220 * Math.pow(2, (i % 7) / 12), start_beat: i, beats: 1.5, gain: 0.4 })),
    });
    expect(r.ok).toBe(true);
    expect(r.durationSec!).toBeGreaterThan(20);
    expect(Date.now() - t0).toBeLessThan(10_000); // 24 音 < 10s（性能护栏）
  });
});

describe("audio v0.5.9：和弦库（11 质量 × 7 进行 + 音名转换）", () => {
  test("音名 ↔ MIDI ↔ 频率三向转换矩阵", () => {
    expect(noteNameToMidi("C4")).toBe(60);
    expect(noteNameToMidi("A4")).toBe(69);
    expect(noteNameToMidi("F#5")).toBe(78);
    expect(noteNameToMidi("Bb3")).toBe(58);
    expect(noteNameToMidi("D#2")).toBe(39);
    expect(noteNameToMidi("c4")).toBe(60); // 小写宽容
    expect(noteNameToMidi("X9")).toBeNull();
    expect(noteNameToMidi("")).toBeNull();
    expect(noteNameToMidi("C10")).toBeNull(); // 出界（132 > 127）
    expect(midiToFreq(69)).toBeCloseTo(440, 1);
    expect(midiToFreq(60)).toBeCloseTo(261.63, 1);
    expect(Object.keys(CHORD_QUALITIES).length).toBe(11);
    expect(Object.keys(PROGRESSIONS).length).toBe(7);
  });

  test("canon 进行：8 和弦 28 音，级数质量正确（I maj / V 7 / vi m7 / iii m7 …）", () => {
    const p = progressionToNotes("C4", "canon", { style: "block", beatsPerChord: 4 });
    expect(p.ok).toBe(true);
    expect(p.degraded).toEqual([]); // 无降级
    expect(p.chords.length).toBe(8);
    expect(p.notes.length).toBe(28); // maj3+7(4)+m7(4)+m7(4)+maj3+maj3+maj3+7(4)
    expect(p.chords[0]).toBe("C4");        // maj 后缀省略
    expect(p.chords[1]).toBe("G4·7");      // 属七
    expect(p.chords[2]).toBe("A4·m7");     // vi m7
    expect(p.chords[3]).toBe("E4·m7");     // iii m7
    expect(p.chords[4]).toBe("F4");        // IV maj
    // 柱式：第一和弦 3 音同拍起（start_beat 全 0），时值 4×0.95
    const first = p.notes.filter((n) => n.start_beat === 0);
    expect(first.length).toBe(3);
    expect(first.every((n) => n.beats === 3.8)).toBe(true);
  });

  test("arp 风格：和弦音滚动起拍 + 尾音交叠（连奏感）", () => {
    const p = progressionToNotes("C4", "pop", { style: "arp", beatsPerChord: 4 });
    expect(p.ok).toBe(true);
    expect(p.notes.length).toBe(14); // pop = 4 和弦 14 音
    const firstChord = p.notes.filter((n) => n.start_beat < 4).sort((a, b) => a.start_beat - b.start_beat);
    expect(firstChord.length).toBe(3); // 第一个和弦 I（maj 3 音）在 0..4 拍滚动
    const starts = firstChord.map((n) => n.start_beat);
    expect(starts[0]).toBe(0);
    // 滚动：第 2/3 音起拍递增（4 拍 / 3 音 ≈ 1.333 间隔）
    expect(starts[1]!).toBeGreaterThan(starts[0]!);
    expect(starts[2]!).toBeGreaterThan(starts[1]!);
    // 交叠：首音时值 > 步长（尾音延伸进下一音）
    expect(firstChord[0]!.beats).toBeGreaterThan(4 / 3);
  });

  test("非法参数宽容降级：坏根音 → C4 + 降级标注；未注册进行 → canon", () => {
    const p = progressionToNotes("X9", "nope-prog");
    expect(p.ok).toBe(true); // 降级后仍有产物
    expect(p.degraded.join(" ")).toContain("C4");
    expect(p.degraded.join(" ")).toContain("canon");
    expect(p.chords.length).toBe(8); // canon 的 8 和弦
  });

  test("和弦进行可直渲染：progressionToNotes → renderNotesToWav 全链", () => {
    const p = progressionToNotes("D3", "canon", { style: "block", beatsPerChord: 2 });
    const r = renderNotesToWav({
      title: "D 大调卡农进行", tempo: 100, timbre: "harpsichord", export_midi: true, notes: p.notes,
    });
    expect(r.ok).toBe(true);
    expect(r.noteCount).toBe(28);
    expect(r.durationSec!).toBeGreaterThan(9.5); // 15.9 拍 @100bpm ≈ 9.5s+（尾和弦留缝）
  });
});

describe("audio v0.5.9：MIDI 导出（SMF 格式 0）", () => {
  test("头字节级校验：MThd + fmt 0 + 1 轨 + 480 PPQ + MTrk 长度前缀一致", () => {
    const m = renderNotesToMidi({
      tempo: 96, notes: [
        { freq: 261.63, start_beat: 0, beats: 1, gain: 0.8 },
        { freq: 329.63, start_beat: 1, beats: 1, gain: 0.6 },
        { freq: 392.0, start_beat: 2, beats: 2, gain: 0.7 },
      ],
    });
    expect(m.ok).toBe(true);
    const b = m.midi!;
    expect(b.toString("ascii", 0, 4)).toBe("MThd");
    expect(b.readUInt32BE(4)).toBe(6);
    expect(b.readUInt16BE(8)).toBe(0);   // 格式 0
    expect(b.readUInt16BE(10)).toBe(1);  // 单轨
    expect(b.readUInt16BE(12)).toBe(480); // PPQ
    expect(b.toString("ascii", 14, 18)).toBe("MTrk");
    const trkLen = b.readUInt32BE(18);
    expect(b.length).toBe(18 + 4 + trkLen); // 长度前缀与实际一致
    // tempo meta：track 首事件 = delta(0) + FF 51 03 + 3 字节大端 µs/qn
    // （96 BPM = 625000 µs = 0x09 89 68；位置 = MThd14 + MTrk4 + len4 + delta1 + meta头3）
    const usec = (b[26]! << 16) | (b[27]! << 8) | b[28]!;
    expect(usec).toBe(625000);
    expect(b[23]).toBe(0xff);
    expect(b[24]).toBe(0x51);
    expect(b[25]).toBe(0x03);
    // 音符数：3 个不同 MIDI 音 → 3 对 note_on/off
    expect(m.noteCount).toBe(3);
    // note_on 事件计数（0x90 状态字节）
    let onCount = 0;
    for (let i = 22; i < b.length - 4; i++) if (b[i] === 0x90) onCount++;
    expect(onCount).toBe(3);
  });

  test("频率 → 最近半音 + 出界夹紧（16Hz→12 · 12000Hz→126）", () => {
    const m = renderNotesToMidi({
      notes: [{ freq: 16, start_beat: 0, beats: 1 }, { freq: 12000, start_beat: 1, beats: 1 }],
    });
    expect(m.ok).toBe(true);
    expect(m.noteCount).toBe(2);
  });

  test("容错同源：结构性错误与 WAV 渲染器同判（notes 缺失 / 空数组 / 全非法）", () => {
    expect(renderNotesToMidi({}).ok).toBe(false);
    expect(renderNotesToMidi({ notes: [] }).ok).toBe(false);
    expect(renderNotesToMidi({ notes: [{ freq: -1, start_beat: 0, beats: 1 }] }).ok).toBe(false);
  });

  test("renderNotesFileSync：export_midi=true 同写 .mid + artifact 字段；缺省不写", () => {
    const dir = makeOut("midi-flag");
    const withMidi = path.join(dir, "a.notes.json");
    fs.writeFileSync(withMidi, JSON.stringify({
      title: "midi-on", tempo: 90, export_midi: true,
      notes: [{ freq: 440, start_beat: 0, beats: 1, gain: 0.6 }],
    }));
    const r1 = renderNotesFileSync(withMidi);
    expect("error" in r1).toBe(false);
    expect(r1.midiFile).toBe("a.mid");
    expect(fs.existsSync(path.join(dir, "a.mid"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.mid")).toString("ascii", 0, 4)).toBe("MThd");
    expect(r1.wavFile).toBe("a.wav");

    const without = path.join(dir, "b.notes.json");
    fs.writeFileSync(without, JSON.stringify({
      title: "midi-off", tempo: 90,
      notes: [{ freq: 440, start_beat: 0, beats: 1, gain: 0.6 }],
    }));
    const r2 = renderNotesFileSync(without);
    expect("error" in r2).toBe(false);
    expect(r2.midiFile).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "b.mid"))).toBe(false);
  });

  test("timbre 透传：artifact.timbre 报告注册音色名", () => {
    const dir = makeOut("timbre-attr");
    const f = path.join(dir, "c.notes.json");
    fs.writeFileSync(f, JSON.stringify({
      tempo: 90, timbre: "music-box",
      notes: [{ freq: 523.25, start_beat: 0, beats: 1, gain: 0.6 }],
    }));
    const r = renderNotesFileSync(f);
    expect("error" in r).toBe(false);
    expect(r.timbre).toBe("music-box");
    // 未注册音色名 → 不进 artifact 字段（渲染侧已降级，报告不留假名）
    const f2 = path.join(dir, "d.notes.json");
    fs.writeFileSync(f2, JSON.stringify({
      tempo: 90, timbre: "ghost",
      notes: [{ freq: 523.25, start_beat: 0, beats: 1, gain: 0.6 }],
    }));
    const r2 = renderNotesFileSync(f2);
    expect("error" in r2).toBe(false);
    expect(r2.timbre).toBeUndefined();
  });

  test("scanAndRenderArtifacts 幂等：wav+mid 双新则跳过（mtime 判定）", () => {
    const dir = makeOut("midi-idem");
    fs.writeFileSync(path.join(dir, "e.notes.json"), JSON.stringify({
      export_midi: true, tempo: 90,
      notes: [{ freq: 330, start_beat: 0, beats: 2, gain: 0.6 }],
    }));
    const s1 = scanAndRenderArtifacts(dir);
    expect(s1.rendered.length).toBe(1);
    expect(s1.rendered[0]!.midiFile).toBe("e.mid");
    const s2 = scanAndRenderArtifacts(dir); // 双产物已新 → 幂等跳过
    expect(s2.rendered.length).toBe(0);
  });
});

describe("audio v0.5.9：e2e 工具环和弦车道（timbre + chords 全链）", () => {
  test("direct 车道：audio_compose {timbre, chords} → 28 音符工件 + WAV + MIDI 三产物", async () => {
    const fixture = path.join(TEST_RUN, "audio-chord-fixture.json");
    const doc = {
      acts: [], reviews: [],
      tracks: {
        "direct:notice-parser": [
          '好的，用羽管键琴写一段卡农琶音。\n<tool>{"name":"audio_compose","args":{"title":"羽管键琴卡农","timbre":"harpsichord","chords":"D3:canon:arp","tempo":100}}</tool>',
          "最终答案：已创作「羽管键琴卡农」（卡农进行琶音），music.wav 与 music.mid 已渲染。",
        ],
      },
    };
    fs.writeFileSync(fixture, JSON.stringify(doc));
    const out = path.join(WS, "out-tool-chords");
    const r = runOrg([
      "ask", "notice-parser", "用羽管键琴写一段卡农琶音",
      "--workspace", WS,
      "--fixture", fixture,
      "--out", out,
    ], { ORG_TOOLS: "write" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("♪ 音频产物已渲染：music.wav");
    // 工件：音色 + MIDI 声明 + 28 音符（canon 8 和弦）
    const notesJson = JSON.parse(fs.readFileSync(path.join(out, "music.notes.json"), "utf-8")) as {
      timbre?: string; export_midi?: boolean; notes: unknown[];
    };
    expect(notesJson.timbre).toBe("harpsichord");
    expect(notesJson.export_midi).toBe(true);
    expect(notesJson.notes.length).toBe(28);
    // 双产物：WAV（RIFF）+ MIDI（MThd）
    expect(fs.readFileSync(path.join(out, "music.wav")).toString("ascii", 0, 4)).toBe("RIFF");
    const mid = fs.readFileSync(path.join(out, "music.mid"));
    expect(mid.toString("ascii", 0, 4)).toBe("MThd");
    expect(mid.readUInt16BE(8)).toBe(0);
    expect(mid.readUInt16BE(12)).toBe(480);
    // 观测：CLI 收尾输出附 MIDI 文件名
    expect(r.stdout).toContain("music.mid");
  }, 120_000);

  test("和弦车道宽容形态：对象参数 {root, name, style} 同样可用", async () => {
    const fixture = path.join(TEST_RUN, "audio-chord-obj-fixture.json");
    const doc = {
      acts: [], reviews: [],
      tracks: {
        "direct:notice-parser": [
          '<tool>{"name":"audio_compose","args":{"name":"lullaby","title":"八音盒摇篮曲","timbre":"music-box","chords":{"root":"C4","name":"romance","style":"arp","beats_per_chord":2}}}</tool>',
          "最终答案：八音盒摇篮曲已完成。",
        ],
      },
    };
    fs.writeFileSync(fixture, JSON.stringify(doc));
    const out = path.join(WS, "out-tool-chords-obj");
    const r = runOrg([
      "ask", "notice-parser", "来一段摇篮曲",
      "--workspace", WS,
      "--fixture", fixture,
      "--out", out,
    ], { ORG_TOOLS: "write" });
    expect(r.ok).toBe(true);
    // 注意工件名区分：args 顶层 name=工件名（lullaby）≠ chords.name=进行名（romance）
    const notesJson = JSON.parse(fs.readFileSync(path.join(out, "lullaby.notes.json"), "utf-8")) as { notes: Array<{ start_beat: number }> };
    expect(notesJson.notes.length).toBe(14); // romance 4 和弦 14 音
    expect(notesJson.notes.some((n) => n.start_beat > 0 && n.start_beat < 2)).toBe(true); // 琶音滚动（bpc=2）
    expect(fs.existsSync(path.join(out, "lullaby.mid"))).toBe(true);
    expect(fs.existsSync(path.join(out, "lullaby.wav"))).toBe(true);
  }, 120_000);
});
