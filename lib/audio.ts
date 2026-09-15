// ============================================================================
// lib/audio.ts — 音频产物渲染器（v0.5.6 → v0.5.9 音频工坊）
// ----------------------------------------------------------------------------
// 「产物应开袋即食」的音频通道：专家/工具环把乐谱数据写成 *.notes.json
// 工件，引擎收尾（engine.ts finish 钩子）扫描产物目录，把每份乐谱渲染成
// 同名 .wav —— 用户拿到的直接是可播放的音频，而不是一纸乐谱。
//
// v0.5.9 音频工坊：
//   - 音色库 TIMBRES（8 种乐器：谐波表 + 包络特征 + 颤音）
//   - 和弦库（11 种和弦质量 × 7 套进行预设 + 音名/MIDI/频率三向转换）
//   - MIDI 导出（SMF 格式 0；notes.json 声明 export_midi: true 即同写 .mid）
//
// 协议（notes.json）：
//   {
//     "title": "D 大调卡农（片段）",
//     "tempo": 90,                      // BPM，缺省 90，夹紧 [20, 300]
//     "sample_rate": 44100,             // 缺省 44100，夹紧 [8000, 48000]
//     "timbre": "strings",             // v0.5.9：全曲音色（音符级 wave 可覆盖）
//     "export_midi": true,              // v0.5.9：同时导出同名 .mid（SMF 0）
//     "notes": [
//       { "freq": 261.63,               // Hz（16..12000 夹紧）
//         "start_beat": 0,              // 起拍（>= 0）
//         "beats": 1,                   // 时值（0..64 夹紧）
//         "gain": 0.8,                  // 缺省 0.6（0..1 夹紧）
//         "wave": "sine",               // sine|triangle|saw|square（缺省 sine；
//                                       //   顶层 timbre 存在时被音色覆盖）
//         "channel": "both" }           // both|left|right（缺省 both）
//     ]
//   }
//
// 合成器（多重优雅降级）：
//   - 音色：timbre 命中音色库 → 谐波表合成（含颤音/持续包络）；未命中 →
//     逐音符容错降级到 wave 基础波形（不炸曲）
//   - 波形：sine 叠加 2/3 次谐波（钢琴般温暖）；triangle/saw/square 纯波形
//   - 包络：5ms 线性起音 + 指数衰减（时间常数 = 音长 1/3）+ 20ms 线性释放
//   - 峰值归一化到 0.9（防爆音）；整曲时长上限 240s（超限截断并记录）
//   - 逐音符容错：字段非法 → 跳过该音符并记录 skipped 原因（不炸整曲）
//   - 空曲 / 全部跳过 → 明确 error（诚实失败，不产出静音假绿）
//
// WAV 头（44 字节标准 RIFF）：PCM16 · 双通道 · 小端。
// MIDI 头（SMF 格式 0）：MThd + MTrk，480 PPQ，tempo meta + note_on/off + EOT。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

/** 单音符（协议字段；见文件头）。 */
export interface AudioNote {
  freq: number;
  start_beat: number;
  beats: number;
  gain?: number;
  wave?: string;
  channel?: string;
}

/** 乐谱文件（协议顶层）。 */
export interface NotesFile {
  title?: string;
  tempo?: number;
  sample_rate?: number;
  timbre?: string;
  export_midi?: boolean;
  notes: AudioNote[];
}

/** 渲染结果（成功带 wav Buffer；失败带 error —— 调用方决定如何呈现）。 */
export interface RenderOutcome {
  ok: boolean;
  error?: string;
  wav?: Buffer;
  durationSec?: number;
  noteCount?: number;
  skipped?: string[];
  title?: string;
}

/** 渲染落盘的单文件结果（scanAndRenderArtifacts 的条目）。 */
export interface RenderedArtifact {
  notesFile: string;
  wavFile: string;
  midiFile?: string; // v0.5.9：export_midi: true 时同写
  bytes: number;
  durationSec: number;
  notes: number;
  title: string;
  timbre?: string;
}

// ---- 音色库（v0.5.9） --------------------------------------------------------

/** 乐器音色规格：谐波表（非整数 ratio = 金属/钟质感）+ 包络特征 + 颤音。 */
export interface TimbreSpec {
  /** UI 显示名（中英混排）。 */
  label: string;
  /** 谐波表：ratio 相对基频倍率，gain 相对幅度（整体幅度不敏感 —— 峰值归一化兜底）。 */
  partials: Array<{ ratio: number; gain: number }>;
  /** 起音时长（秒，线性斜坡）。 */
  attackSec: number;
  /** 衰减时间常数 = 音长 × 此系数（越大越持久）。 */
  decayTauFactor: number;
  /** 衰减渐近水平（0=纯衰减到零；弓弦/管风琴用高 sustain 模拟持续）。 */
  sustain: number;
  /** 释放时长（秒，线性斜坡到零，防味哒声）。 */
  releaseSec: number;
  /** 颤音频率（Hz；0 = 无）。 */
  vibratoHz: number;
  /** 颤音深度（频率偏移比例；0.006 ≈ 柔和揉弦）。 */
  vibratoDepth: number;
}

/** 八种乐器音色（协议名 → 规格；未知名字逐音符降级到 wave 基础波形）。 */
export const TIMBRES: Record<string, TimbreSpec> = {
  piano: {
    label: "钢琴 Piano",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.5 },
      { ratio: 3, gain: 0.25 },
      { ratio: 4, gain: 0.12 },
    ],
    attackSec: 0.004, decayTauFactor: 0.33, sustain: 0, releaseSec: 0.03,
    vibratoHz: 0, vibratoDepth: 0,
  },
  strings: {
    label: "弦乐 Strings",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.35 },
      { ratio: 3, gain: 0.2 },
      { ratio: 4, gain: 0.1 },
      { ratio: 5, gain: 0.06 },
    ],
    attackSec: 0.12, decayTauFactor: 4, sustain: 0.8, releaseSec: 0.15,
    vibratoHz: 5.5, vibratoDepth: 0.006,
  },
  flute: {
    label: "长笛 Flute",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 3, gain: 0.15 },
      { ratio: 5, gain: 0.05 },
    ],
    attackSec: 0.08, decayTauFactor: 3, sustain: 0.85, releaseSec: 0.1,
    vibratoHz: 5, vibratoDepth: 0.004,
  },
  organ: {
    label: "管风琴 Organ",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.6 },
      { ratio: 3, gain: 0.4 },
      { ratio: 4, gain: 0.3 },
      { ratio: 6, gain: 0.15 },
      { ratio: 8, gain: 0.1 },
    ],
    attackSec: 0.05, decayTauFactor: 6, sustain: 0.9, releaseSec: 0.12,
    vibratoHz: 0, vibratoDepth: 0,
  },
  harpsichord: {
    label: "羽管键琴 Harpsichord",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.7 },
      { ratio: 3, gain: 0.5 },
      { ratio: 4, gain: 0.35 },
      { ratio: 5, gain: 0.2 },
      { ratio: 6, gain: 0.15 },
    ],
    attackSec: 0.002, decayTauFactor: 0.25, sustain: 0.05, releaseSec: 0.04,
    vibratoHz: 0, vibratoDepth: 0,
  },
  "music-box": {
    label: "八音盒 Music Box",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 3.98, gain: 0.4 },
      { ratio: 9.2, gain: 0.15 },
    ],
    attackSec: 0.002, decayTauFactor: 0.5, sustain: 0, releaseSec: 0.08,
    vibratoHz: 0, vibratoDepth: 0,
  },
  guitar: {
    label: "吉他 Guitar",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.45 },
      { ratio: 3, gain: 0.2 },
      { ratio: 4, gain: 0.08 },
    ],
    attackSec: 0.006, decayTauFactor: 0.45, sustain: 0.1, releaseSec: 0.06,
    vibratoHz: 0, vibratoDepth: 0,
  },
  bell: {
    label: "钟琴 Bell",
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2.76, gain: 0.5 },
      { ratio: 5.4, gain: 0.25 },
      { ratio: 8.9, gain: 0.1 },
    ],
    attackSec: 0.001, decayTauFactor: 1.2, sustain: 0, releaseSec: 0.3,
    vibratoHz: 0, vibratoDepth: 0,
  },
};

// ---- 和弦库（v0.5.9） --------------------------------------------------------

/** 和弦质量：根音上的半音级数（0 = 根音）。 */
export const CHORD_QUALITIES: Record<string, { label: string; intervals: number[] }> = {
  maj: { label: "大三", intervals: [0, 4, 7] },
  min: { label: "小三", intervals: [0, 3, 7] },
  dim: { label: "减三", intervals: [0, 3, 6] },
  aug: { label: "增三", intervals: [0, 4, 8] },
  sus4: { label: "挂四", intervals: [0, 5, 7] },
  sus2: { label: "挂二", intervals: [0, 2, 7] },
  "7": { label: "属七", intervals: [0, 4, 7, 10] },
  maj7: { label: "大七", intervals: [0, 4, 7, 11] },
  m7: { label: "小七", intervals: [0, 3, 7, 10] },
  m7b5: { label: "半减七", intervals: [0, 3, 6, 10] },
  "6": { label: "大六", intervals: [0, 4, 7, 9] },
};

/** 进行预设：大调音级级数（半音 offset，相对根音）；播放时按自然音级配质量。 */
export const PROGRESSIONS: Record<string, { label: string; steps: number[] }> = {
  canon: { label: "卡农 I-V-vi-iii-IV-I-IV-V", steps: [0, 7, 9, 4, 5, 0, 5, 7] },
  pop: { label: "流行 I-V-vi-IV", steps: [0, 7, 9, 5] },
  epic: { label: "史诗 vi-IV-I-V", steps: [9, 5, 0, 7] },
  circle: { label: "五度圈 I-IV-V-I", steps: [0, 5, 7, 0] },
  jazz: { label: "爵士 ii-V-I", steps: [2, 7, 0] },
  blues: { label: "十二小节布鲁斯", steps: [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 0] },
  romance: { label: "浪漫 I-vi-IV-V", steps: [0, 9, 5, 7] },
};

/** 科学记谱音名（C4 = MIDI 60 = 261.63Hz）→ MIDI 音符号；非法返回 null。 */
export function noteNameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) return null;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  const oct = Number(m[3]);
  const midi = (oct + 1) * 12 + base[m[1]!.toUpperCase()]! + acc;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** MIDI 音符号 → 频率（Hz，等律 A4=440）。 */
export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** 大调音级（半音 offset mod 12）→ 自然音级和弦质量。 */
function diatonicQuality(offset: number): string {
  switch (((offset % 12) + 12) % 12) {
    case 2: return "m7";   // ii
    case 4: return "m7";   // iii
    case 9: return "m7";   // vi
    case 11: return "dim"; // vii°
    case 7: return "7";    // V（属七）
    default: return "maj"; // I / IV / 其他回到大三
  }
}

/** 和弦进行 → 音符序列（工具环 audio_compose / Web 音色试听的公共床）。
 *
 * 参数宽容：root 非法 → C4；prog 未注册 → canon；style 未识别 → block。 */
export function progressionToNotes(
  root: string,
  prog: string,
  opts?: { beatsPerChord?: number; style?: "block" | "arp"; gain?: number; octave?: number },
): { ok: boolean; notes: AudioNote[]; chords: string[]; degraded: string[] } {
  const degraded: string[] = [];
  let rootMidi = noteNameToMidi(root);
  if (rootMidi === null) {
    rootMidi = 60; // C4
    degraded.push(`root "${root}" 非法，降级 C4`);
  }
  rootMidi += opts?.octave ?? 0;
  const spec = PROGRESSIONS[prog];
  if (!spec) degraded.push(`进行 "${prog}" 未注册，降级 canon`);
  const steps = spec?.steps ?? PROGRESSIONS["canon"]!.steps;
  const bpc = Math.min(Math.max(opts?.beatsPerChord ?? 4, 1), 16);
  const style = opts?.style === "arp" ? "arp" : "block";
  const gain = Math.min(Math.max(opts?.gain ?? 0.6, 0.05), 1);

  const NOTE_LETTERS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const notes: AudioNote[] = [];
  const chords: string[] = [];
  steps.forEach((step, i) => {
    const quality = diatonicQuality(step);
    const intervals = CHORD_QUALITIES[quality]?.intervals ?? [0, 4, 7];
    const rootNote = rootMidi + step;
    const pitchName = `${NOTE_LETTERS[((rootNote % 12) + 12) % 12]}${Math.floor(rootNote / 12) - 1}`;
    chords.push(`${pitchName}${quality === "maj" ? "" : quality === "7" ? "·7" : "·" + quality}`);
    intervals.forEach((iv, j) => {
      const freq = midiToFreq(rootNote + iv);
      if (style === "block") {
        notes.push({ freq, start_beat: i * bpc, beats: bpc * 0.95, gain, channel: "both" });
      } else {
        // 琶音：和弦音依次滚动（尾音略交叠，连奏感）
        const stepBeats = bpc / intervals.length;
        notes.push({ freq, start_beat: i * bpc + j * stepBeats, beats: stepBeats * 1.4, gain, channel: "both" });
      }
    });
  });
  return { ok: notes.length > 0, notes, chords, degraded };
}

// ---- 常量（合成器参数；全部可被协议字段覆盖的部分已注明） --------------------

const DEFAULT_TEMPO = 90;
const DEFAULT_SAMPLE_RATE = 44100;
const MAX_DURATION_SEC = 240;
const MAX_NOTES = 20000;
const TAIL_SEC = 0.4; // 曲尾混响余量
const PEAK_TARGET = 0.9;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);

/** 波形发生器（phase ∈ [0, 2π) → [-1, 1]）。 */
function waveform(kind: string, phase: number): number {
  switch (kind) {
    case "triangle": {
      // 三角波：锯齿的绝对值折返
      const t = (phase / (2 * Math.PI)) % 1;
      return 4 * Math.abs(t - 0.5) - 1;
    }
    case "saw": {
      const t = (phase / (2 * Math.PI)) % 1;
      return 2 * t - 1;
    }
    case "square":
      return Math.sin(phase) >= 0 ? 0.7 : -0.7;
    case "sine":
    default: {
      // sine + 2/3 次谐波：单音不再「蜂鸣」，接近拨弦/钢琴的暖度
      return 0.62 * Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.11 * Math.sin(3 * phase);
    }
  }
}

/** 归一化后的完整乐谱（WAV / MIDI 两渲染器共用的中间表示）。 */
interface NormalizedScore {
  tempo: number;
  sampleRate: number;
  title: string;
  timbre: TimbreSpec | null;
  exportMidi: boolean;
  notes: Required<AudioNote>[];
  skipped: string[];
}

/** 乐谱归一化（WAV / MIDI 两渲染器的共用层）：结构校验 + 字段级容错。
 * 结构性错误返回 error 字符串（非对象 / notes 缺失 / 过滤后为空）。 */
function normalizeScore(input: unknown): NormalizedScore | { error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { error: "notes.json 顶层必须是 JSON 对象（含 notes 数组）" };
  }
  const doc = input as Record<string, unknown>;
  const rawNotes = doc["notes"];
  if (!Array.isArray(rawNotes)) {
    return { error: "notes 字段缺失或不是数组" };
  }
  if (rawNotes.length === 0) {
    return { error: "notes 为空（零音符无法合成音频）" };
  }
  if (rawNotes.length > MAX_NOTES) {
    return { error: `音符数 ${rawNotes.length} 超过上限 ${MAX_NOTES}` };
  }

  const tempo = clamp(num(doc["tempo"]) || DEFAULT_TEMPO, 20, 300);
  const sampleRate = Math.round(clamp(num(doc["sample_rate"]) || DEFAULT_SAMPLE_RATE, 8000, 48000));
  const title = typeof doc["title"] === "string" ? doc["title"] : "untitled";
  // v0.5.9 音色：未注册名 → null（降级逐音符 wave 波形，不炸曲）
  const timbreName = typeof doc["timbre"] === "string" ? doc["timbre"] : "";
  const timbre = timbreName ? TIMBRES[timbreName] ?? null : null;
  const exportMidi = doc["export_midi"] === true;

  const skipped: string[] = [];
  const notes: Required<AudioNote>[] = [];
  for (let i = 0; i < rawNotes.length; i++) {
    const raw = rawNotes[i];
    if (raw === null || typeof raw !== "object") {
      skipped.push(`#${i}: 非对象`);
      continue;
    }
    const n = raw as Record<string, unknown>;
    const freq = num(n["freq"]);
    const start = num(n["start_beat"] ?? n["start"]);
    const beats = num(n["beats"] ?? n["duration_beats"] ?? n["dur"]);
    if (!Number.isFinite(freq) || freq <= 0) {
      skipped.push(`#${i}: freq 非法`);
      continue;
    }
    if (!Number.isFinite(start) || start < 0) {
      skipped.push(`#${i}: start_beat 非法`);
      continue;
    }
    if (!Number.isFinite(beats) || beats <= 0) {
      skipped.push(`#${i}: beats 非法`);
      continue;
    }
    const wave = typeof n["wave"] === "string" ? n["wave"] : "sine";
    const channel = typeof n["channel"] === "string" ? n["channel"] : "both";
    // gain：仅 undefined/NaN 才取缺省 0.6（显式 0 是合法值 —— 全零增益
    // 交给「近静音」闸门拒绝，不在归一化层偷换）
    const rawGain = num(n["gain"]);
    const gain = Number.isFinite(rawGain) ? clamp(rawGain, 0, 1) : 0.6;
    notes.push({
      freq: clamp(freq, 16, 12000),
      start_beat: start,
      beats: clamp(beats, 0.01, 64),
      gain,
      wave,
      channel: channel === "left" || channel === "right" ? channel : "both",
    });
  }
  if (notes.length === 0) {
    return { error: `全部 ${rawNotes.length} 个音符被过滤（${skipped.slice(0, 5).join("; ")}）` };
  }
  return { tempo, sampleRate, title, timbre, exportMidi, notes, skipped };
}

/**
 * 乐谱对象 → WAV Buffer。
 * 输入未验证也绝不抛错：字段级容错（坏音符跳过并记录），结构性错误
 * （非对象 / notes 非数组 / 过滤后为空）返回明确 error。
 */
export function renderNotesToWav(input: unknown): RenderOutcome {
  const norm = normalizeScore(input);
  if ("error" in norm) return { ok: false, error: norm.error, skipped: norm.skipped };
  const { tempo, sampleRate, title, timbre, notes, skipped } = norm;
  const spb = 60 / tempo; // 秒 / 拍

  // ---- 时长预算（超限截断：裁掉出界的长音，保留可渲染前缀） ----
  let endBeat = 0;
  for (const n of notes) endBeat = Math.max(endBeat, n.start_beat + n.beats);
  let durationSec = endBeat * spb + TAIL_SEC;
  let truncated = false;
  if (durationSec > MAX_DURATION_SEC) {
    durationSec = MAX_DURATION_SEC;
    truncated = true;
  }
  const totalSamples = Math.ceil(durationSec * sampleRate);

  // ---- 混音（单声道累加 → 峰值归一化 → 立体声） ----
  const mono = new Float64Array(totalSamples);
  for (const n of notes) {
    const startSec = n.start_beat * spb;
    if (startSec >= durationSec) continue; // 截断边界外的音符静默丢弃（已记录 truncated）
    const durSec = n.beats * spb;
    const nSamples = Math.min(Math.ceil(durSec * sampleRate), totalSamples - Math.floor(startSec * sampleRate));
    if (nSamples <= 0) continue;
    const startIdx = Math.floor(startSec * sampleRate);
    // v0.5.9：音色命中 → 音色包络（起音/衰减渐近 sustain/释放/颤音 FM）；
    // 否则田字格包络（起音 5ms + 衰减 1/3 + 释放 20ms），行为与 v0.5.6 一致
    if (timbre) {
      const attack = Math.max(2, Math.floor(timbre.attackSec * sampleRate));
      const release = Math.max(2, Math.floor(timbre.releaseSec * sampleRate));
      const decayTau = clamp(durSec * timbre.decayTauFactor, 0.05, 8);
      const w0 = 2 * Math.PI * n.freq / sampleRate;
      const vibW = timbre.vibratoHz > 0 ? 2 * Math.PI * timbre.vibratoHz / sampleRate : 0;
      const partials = timbre.partials;
      let phase = 0;
      for (let s = 0; s < nSamples; s++) {
        // 颤音：相位积分（FM）—— 调制连续无跳变
        phase += vibW > 0 ? w0 * (1 + timbre.vibratoDepth * Math.sin(vibW * s)) : w0;
        let osc = 0;
        for (let p = 0; p < partials.length; p++) {
          osc += partials[p]!.gain * Math.sin(phase * partials[p]!.ratio);
        }
        // 包络：起音斜坡 × （衰减到 sustain 渐近）× 释放斜坡
        let env = timbre.sustain + (1 - timbre.sustain) * Math.exp(-(s / sampleRate) / decayTau);
        if (s < attack) env *= s / attack;
        else if (s > nSamples - release) env *= Math.max(0, (nSamples - s) / release);
        mono[startIdx + s] += n.gain * env * osc;
      }
    } else {
      const attack = Math.max(2, Math.floor(0.005 * sampleRate));
      const release = Math.max(2, Math.floor(0.02 * sampleRate));
      const decayTau = Math.max(durSec / 3, 0.05); // 指数衰减时间常数
      const w = 2 * Math.PI * n.freq / sampleRate;
      for (let s = 0; s < nSamples; s++) {
        // 包络：起音斜坡 + 指数衰减 + 释放斜坡（防咔哒声）
        let env = 1;
        if (s < attack) env = s / attack;
        else if (s > nSamples - release) env = Math.max(0, (nSamples - s) / release);
        const tSec = s / sampleRate;
        const decay = Math.exp(-tSec / decayTau);
        mono[startIdx + s] += n.gain * env * decay * waveform(n.wave, w * s);
      }
    }
  }

  // 峰值归一化（防爆音；静音曲 → 诚实报错而不是全零 WAV）
  let peak = 0;
  for (let i = 0; i < totalSamples; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 1e-6) {
    return { ok: false, error: "混音结果近静音（音符增益全为零？）" };
  }
  const scale = PEAK_TARGET / peak;

  // ---- WAV 封装（PCM16 · 双通道 · 小端 44 字节标准头） ----
  const dataBytes = totalSamples * 2 * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt 子块长度（PCM 恒 16）
  buf.writeUInt16LE(1, 20); // 音频格式：PCM
  buf.writeUInt16LE(2, 22); // 通道数：立体声
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2 * 2, 28); // 字节率
  buf.writeUInt16LE(2 * 2, 32); // 块对齐
  buf.writeUInt16LE(16, 34); // 位深
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < totalSamples; i++) {
    const v = mono[i] * scale;
    const s16 = Math.round(clamp(v, -1, 1) * 32767);
    const l = s16;
    const r = s16;
    buf.writeInt16LE(l, off);
    off += 2;
    buf.writeInt16LE(r, off);
    off += 2;
  }

  return {
    ok: true,
    wav: buf,
    durationSec: Math.round(durationSec * 100) / 100,
    noteCount: notes.length,
    skipped: skipped.length > 0 ? skipped : undefined,
    title,
    ...(truncated ? { error: `时长超限（>${MAX_DURATION_SEC}s），已截断` } : {}),
  };
}

// ---- MIDI 导出（v0.5.9：SMF 格式 0） ----------------------------------------

/** SMF 变长量编码（delta time；最大 4 字节足够 28-bit tick）。 */
function midiVarlen(n: number): number[] {
  const v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  let rest = v >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

/** 频率（Hz）→ 最近 MIDI 音符号（等律；夹素 0..127）。 */
function freqToMidi(freq: number): number {
  return Math.round(clamp(69 + 12 * Math.log2(freq / 440), 0, 127));
}

/** MIDI 事件（渲染前中间表示；order 保证同 tick 时 note_off 先于 note_on）。 */
interface MidiEvent {
  tick: number;
  order: number; // -1 meta / 0 note_off / 1 note_on / 2 EOT
  bytes: number[];
}

/** 乐谱对象 → 标准 MIDI 文件（SMF 格式 0，480 PPQ，单轨单通道）。
 * 与 WAV 共用 normalizeScore：同容错、同夹素。频率 → 最近半音
 * （人耳对 ±50 音分不敏感，和弦/旋律语义保真）；同音重叠区间合并
 * （note_off 不提前抬首前音）。MIDI 导出失败不影响 WAV 主产物。 */
export function renderNotesToMidi(input: unknown): { ok: boolean; midi?: Buffer; error?: string; noteCount?: number } {
  const norm = normalizeScore(input);
  if ("error" in norm) return { ok: false, error: norm.error };
  const { tempo, notes } = norm;
  const PPQ = 480;
  const events: MidiEvent[] = [];
  // tempo meta（FF 51 03 微秒/四分音符，大端）
  const usecPerQn = Math.round(clamp(60_000_000 / tempo, 1, 0xffffff));
  events.push({ tick: 0, order: -1, bytes: [0xff, 0x51, 0x03, (usecPerQn >> 16) & 0xff, (usecPerQn >> 8) & 0xff, usecPerQn & 0xff] });

  // 同音重叠合并：note 索引按 (midi, start) 分组，off 取区间 max
  const byNote = new Map<number, Array<{ on: number; off: number; vel: number }>>();
  for (const n of notes) {
    const midi = freqToMidi(n.freq);
    const on = Math.round(n.start_beat * PPQ);
    const off = Math.round((n.start_beat + n.beats) * PPQ);
    const vel = Math.round(clamp(64 + n.gain * 63, 1, 127));
    const bucket = byNote.get(midi) ?? [];
    bucket.push({ on, off, vel });
    byNote.set(midi, bucket);
  }
  for (const [midi, bucket] of byNote) {
    bucket.sort((a, b) => a.on - b.on);
    let cur: { on: number; off: number; vel: number } | null = null;
    for (const seg of bucket) {
      if (cur && seg.on <= cur.off) {
        // 重叠：延长当前音（同音不截断）
        cur.off = Math.max(cur.off, seg.off);
        cur.vel = Math.max(cur.vel, seg.vel);
      } else {
        if (cur) {
          events.push({ tick: cur.on, order: 1, bytes: [0x90, midi, cur.vel] });
          events.push({ tick: cur.off, order: 0, bytes: [0x80, midi, 64] });
        }
        cur = seg;
      }
    }
    if (cur) {
      events.push({ tick: cur.on, order: 1, bytes: [0x90, midi, cur.vel] });
      events.push({ tick: cur.off, order: 0, bytes: [0x80, midi, 64] });
    }
  }
  if (events.length <= 1) {
    return { ok: false, error: "无有效音符可导出（频率全部出界？）" };
  }

  // 排序（tick 升序；同 tick：meta < off < on < EOT）后编码 delta
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const endTick = events[events.length - 1]!.tick + PPQ; // EOT 在末尾留一拍余量
  events.push({ tick: endTick, order: 2, bytes: [0xff, 0x2f, 0x00] });

  const trackData: number[] = [];
  let lastTick = 0;
  for (const ev of events) {
    trackData.push(...midiVarlen(ev.tick - lastTick), ...ev.bytes);
    lastTick = ev.tick;
  }

  // MThd（格式 0 · 1 轨 · PPQ）+ MTrk（4 字节大端长度 + 事件流）
  const head = Buffer.alloc(14);
  head.write("MThd", 0, "ascii");
  head.writeUInt32BE(6, 4);
  head.writeUInt16BE(0, 8); // 格式 0
  head.writeUInt16BE(1, 10); // 轨数 1
  head.writeUInt16BE(PPQ, 12);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(trackData.length, 0);
  const finalBuf = Buffer.concat([head, Buffer.from("MTrk", "ascii"), lenBuf, Buffer.from(trackData)]);
  return { ok: true, midi: finalBuf, noteCount: notes.length };
}

/**
 * 渲染单份乐谱文件：<name>.notes.json → 同目录 <name>.wav
 * （协议声明 export_midi: true 时同时写 <name>.mid）。
 * 读/解析/渲染三级容错：任何失败返回 error 字符串，绝不抛出。
 * MIDI 导出失败降级为备注（不阻断 WAV 主产物）。 */
export function renderNotesFileSync(jsonPath: string): RenderedArtifact | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, "utf-8");
  } catch (err) {
    return { error: `读取失败：${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `JSON 解析失败：${(err as Error).message}` };
  }
  let wantsMidi = false;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    wantsMidi = (parsed as Record<string, unknown>)["export_midi"] === true;
  }
  const outcome = renderNotesToWav(parsed);
  if (!outcome.ok || !outcome.wav) {
    return { error: outcome.error ?? "渲染失败" };
  }
  const wavFile = jsonPath.slice(0, -".notes.json".length) + ".wav";
  try {
    fs.writeFileSync(wavFile, outcome.wav);
  } catch (err) {
    return { error: `写入失败：${(err as Error).message}` };
  }
  // v0.5.9：MIDI 导出（opt-in；失败不炸 WAV）
  let midiFile: string | undefined;
  if (wantsMidi) {
    const midi = renderNotesToMidi(parsed);
    if (midi.ok && midi.midi) {
      midiFile = jsonPath.slice(0, -".notes.json".length) + ".mid";
      try {
        fs.writeFileSync(midiFile, midi.midi);
      } catch {
        midiFile = undefined; // 落盘失败 → 只交付 WAV（降级，不报错）
      }
    }
  }
  let timbreName: string | undefined;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const t = (parsed as Record<string, unknown>)["timbre"];
    if (typeof t === "string" && TIMBRES[t]) timbreName = t;
  }
  return {
    notesFile: path.basename(jsonPath),
    wavFile: path.basename(wavFile),
    ...(midiFile ? { midiFile: path.basename(midiFile) } : {}),
    bytes: outcome.wav.length,
    durationSec: outcome.durationSec ?? 0,
    notes: outcome.noteCount ?? 0,
    title: outcome.title ?? "untitled",
    ...(timbreName ? { timbre: timbreName } : {}),
  };
}

/**
 * 扫描产物目录树，渲染全部 *.notes.json → 同名 .wav（引擎收尾钩子）。
 * 幂等：已存在同名 .wav 且 mtime 更新则跳过（重放/replay 不重复渲染）。
 * 永不抛错：逐文件收集错误到 failures（观测面，不影响其他文件）。
 */
export function scanAndRenderArtifacts(
  rootDir: string,
): { rendered: RenderedArtifact[]; failures: Array<{ file: string; error: string }> } {
  const rendered: RenderedArtifact[] = [];
  const failures: Array<{ file: string; error: string }> = [];
  if (!fs.existsSync(rootDir)) return { rendered, failures };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读：跳过（工作区监狱外的事件目录等）
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".hsl-runs") continue; // 解释器内部目录
        walk(p);
      } else if (e.name.endsWith(".notes.json")) {
        const wavPath = p.slice(0, -".notes.json".length) + ".wav";
        try {
          const notesStat = fs.statSync(p);
          if (fs.existsSync(wavPath)) {
            const wavStat = fs.statSync(wavPath);
            if (wavStat.mtimeMs >= notesStat.mtimeMs) continue; // 已渲染且不旧
          }
        } catch {
          /* stat 失败 → 照常尝试渲染 */
        }
        const r = renderNotesFileSync(p);
        if ("error" in r) {
          failures.push({ file: path.relative(rootDir, p), error: r.error });
        } else {
          rendered.push(r);
        }
      }
    }
  };
  walk(rootDir);
  return { rendered, failures };
}

// ---- WAV 校验（测试与 Web 侧共用：RIFF 头解析，不依赖播放器） ----------------

/** 解析 WAV 头（PCM16 假设下取时长与采样率；坏头返回 null）。 */
export function wavInfo(buf: Buffer): { sampleRate: number; durationSec: number; channels: number } | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const dataBytes = buf.readUInt32LE(40);
  if (channels <= 0 || sampleRate <= 0) return null;
  return { sampleRate, channels, durationSec: dataBytes / (sampleRate * channels * 2) };
}
