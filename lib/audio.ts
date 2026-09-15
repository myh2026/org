// ============================================================================
// lib/audio.ts — 音频产物渲染器（v0.5.6）：notes.json → WAV（PCM16 立体声）
// ----------------------------------------------------------------------------
// 「产物应开袋即食」的音频通道：专家/工具环把乐谱数据写成 *.notes.json
// 工件，引擎收尾（engine.ts finish 钩子）扫描产物目录，把每份乐谱渲染成
// 同名 .wav —— 用户拿到的直接是可播放的音频，而不是一纸乐谱。
//
// 协议（notes.json）：
//   {
//     "title": "D 大调卡农（片段）",
//     "tempo": 90,                      // BPM，缺省 90，夹紧 [20, 300]
//     "sample_rate": 44100,             // 缺省 44100，夹紧 [8000, 48000]
//     "notes": [
//       { "freq": 261.63,               // Hz（16..12000 夹紧）
//         "start_beat": 0,              // 起拍（>= 0）
//         "beats": 1,                   // 时值（0..64 夹紧）
//         "gain": 0.8,                  // 缺省 0.6（0..1 夹紧）
//         "wave": "sine",               // sine|triangle|saw|square（缺省 sine）
//         "channel": "both" }           // both|left|right（缺省 both）
//     ]
//   }
//
// 合成器（多重优雅降级）：
//   - 波形：sine 叠加 2/3 次谐波（钢琴般温暖）；triangle/saw/square 纯波形
//   - 包络：5ms 线性起音 + 指数衰减（时间常数 = 音长 1/3）+ 20ms 线性释放
//   - 峰值归一化到 0.9（防爆音）；整曲时长上限 240s（超限截断并记录）
//   - 逐音符容错：字段非法 → 跳过该音符并记录 skipped 原因（不炸整曲）
//   - 空曲 / 全部跳过 → 明确 error（诚实失败，不产出静音假绿）
//
// WAV 头（44 字节标准 RIFF）：PCM16 · 双通道 · 小端。
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
  bytes: number;
  durationSec: number;
  notes: number;
  title: string;
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

/**
 * 乐谱对象 → WAV Buffer。
 * 输入未验证也绝不抛错：字段级容错（坏音符跳过并记录），结构性错误
 * （非对象 / notes 非数组 / 过滤后为空）返回明确 error。
 */
export function renderNotesToWav(input: unknown): RenderOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "notes.json 顶层必须是 JSON 对象（含 notes 数组）" };
  }
  const doc = input as Record<string, unknown>;
  const rawNotes = doc["notes"];
  if (!Array.isArray(rawNotes)) {
    return { ok: false, error: "notes 字段缺失或不是数组" };
  }
  if (rawNotes.length === 0) {
    return { ok: false, error: "notes 为空（零音符无法合成音频）" };
  }
  if (rawNotes.length > MAX_NOTES) {
    return { ok: false, error: `音符数 ${rawNotes.length} 超过上限 ${MAX_NOTES}` };
  }

  const tempo = clamp(num(doc["tempo"]) || DEFAULT_TEMPO, 20, 300);
  const sampleRate = Math.round(clamp(num(doc["sample_rate"]) || DEFAULT_SAMPLE_RATE, 8000, 48000));
  const title = typeof doc["title"] === "string" ? doc["title"] : "untitled";
  const spb = 60 / tempo; // 秒 / 拍

  // ---- 音符归一化（容错过滤） ----
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
    return { ok: false, error: `全部 ${rawNotes.length} 个音符被过滤（${skipped.slice(0, 5).join("; ")}）`, skipped };
  }

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

/**
 * 渲染单份乐谱文件：<name>.notes.json → 同目录 <name>.wav。
 * 读/解析/渲染三级容错：任何失败返回 error 字符串，绝不抛出。
 */
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
  return {
    notesFile: path.basename(jsonPath),
    wavFile: path.basename(wavFile),
    bytes: outcome.wav.length,
    durationSec: outcome.durationSec ?? 0,
    notes: outcome.noteCount ?? 0,
    title: outcome.title ?? "untitled",
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
