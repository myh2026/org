// ============================================================================
// org/lib/voice.ts — 语音入口（v0.5.12）：ASR 转写 + TTS 合成
// ----------------------------------------------------------------------------
// capabilities #15/#120 的执行层：z-ai-web-dev-sdk 的 audio.asr / audio.tts
// （SDK 仅后端使用 —— Web GUI 经 /api/asr、/api/tts 端点调用本模块）。
//
// 多重优雅降级（ORG 核心纪律）：
//   1. SDK 缺席/凭据失败 → {ok:false, error}（明确可诊断，Web 显示提示条，
//      不炸不挂——用户部署环境配好凭据即全功能）；
//   2. DHV_VOICE_DISABLE_SDK=1 → 显式拒绝（CI 零外联开关，对齐
//      DHV_LLM_DISABLE_SDK 惯例）；
//   3. TTS 超长（>1024/段）→ 句子边界切块逐段合成，PCM 拼接自封 WAV 头
//      （24kHz PCM16 单声道——不依赖 SDK wav 内部格式，行为确定可测）；
//   4. 合成缓存（LRU）→ 同文本同参数零重复计费。
//
// 测试注入口：setZaiFactory(fake)（tests/voice.test.ts 全 mock 零外联）。
// ============================================================================

/** 语音合成参数（voice 白名单 + speed 夹紧）。 */
export interface SpeakOptions {
  voice?: string;
  speed?: number;
}

/** TTS 单段上限（SDK 硬限制 1024 字符；切块留余量）。 */
export const TTS_CHUNK_MAX = 1000;

/** TTS 入口总上限（防滥用：一段朗读足够；超出诚实截断并标注）。 */
export const TTS_TEXT_LIMIT = 4096;

/** ASR 音频上限（15MB —— 语音备忘的合理上界）。 */
export const ASR_MAX_BYTES = 15 * 1024 * 1024;

/** TTS 采样率（SDK 语音车道 24kHz）。 */
const TTS_SAMPLE_RATE = 24000;

/** 声音清单（SDK 七声音；label 用于 GUI 选择器）。 */
export const VOICES: Record<string, string> = {
  tongtong: "彤彤 · 温暖亲切",
  chuichui: "吹吹 · 活泼可爱",
  xiaochen: "小陈 · 沉稳专业",
  jam: "Jam · 英音绅士",
  kazi: "卡兹 · 清晰标准",
  douji: "豆吉 · 自然流畅",
  luodo: "罗多 · 富有感染力",
};

/** 声音白名单归一：未知名/未设 → tongtong（缺省声）。 */
export function normalizeVoice(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(VOICES, s) ? s : "tongtong";
}

/** 语速归一：clamp [0.5, 2.0]，非法/未设 → 1.0（SDK 硬约束）。 */
export function normalizeSpeed(s: unknown): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(2.0, Math.max(0.5, n));
}

/** TTS 分段（句子边界优先，超长硬切）：空白归一 → 句号/问叹号/换行切块 →
 *  单句超长再按逗号/分号 → 仍超长硬切。空文本 → []。
 *  「中英混合句。Next sentence.」→ 两段。 */
export function splitTtsChunks(text: string, max = TTS_CHUNK_MAX): string[] {
  const norm = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!norm) return [];
  if (norm.length <= max) return [norm];
  const chunks: string[] = [];
  // 1) 句子边界（。！？!?…与换行归一后的空格）
  const sentences = norm.split(/(?<=[。！？!?…])\s*/);
  let cur = "";
  const pushCur = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const sen of sentences) {
    if (sen.length > max) {
      // 2) 单句超长：逗号/分号次级边界
      pushCur();
      const parts = sen.split(/(?<=[，,；;：:])/);
      let sub = "";
      for (const p of parts) {
        if ((sub + p).length > max) {
          if (sub.trim()) chunks.push(sub.trim());
          if (p.length > max) {
            // 3) 仍超长：硬切
            for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max));
            sub = "";
          } else {
            sub = p;
          }
        } else {
          sub += p;
        }
      }
      if (sub.trim()) chunks.push(sub.trim());
      continue;
    }
    if ((cur + sen).length > max) pushCur();
    cur += sen;
  }
  pushCur();
  return chunks;
}

// ---- SDK 封装（懒加载单例 + 测试注入口） -----------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type ZaiLike = {
  audio: {
    asr: { create: (r: { file_base64: string }) => Promise<{ text?: string }> };
    tts: { create: (r: { input: string; voice: string; speed: number; response_format: string; stream: boolean }) => Promise<Response> };
  };
};

let zaiFactory: (() => Promise<ZaiLike>) | null = null;
let zaiInstance: ZaiLike | null = null;

/** 测试注入口：替换 SDK 工厂（fake zai）；null = 恢复真实懒加载。 */
export function setZaiFactory(f: (() => Promise<ZaiLike>) | null): void {
  zaiFactory = f;
  zaiInstance = null;
}

async function getZai(): Promise<ZaiLike> {
  if (zaiInstance) return zaiInstance;
  if ((process.env.DHV_VOICE_DISABLE_SDK || "").trim() === "1") {
    throw new Error("voice: SDK 车道已禁用（DHV_VOICE_DISABLE_SDK=1，零外联模式）—— 语音入口需要 z-ai SDK 凭据或关闭该开关");
  }
  if (zaiFactory) {
    zaiInstance = await zaiFactory();
    return zaiInstance;
  }
  const mod: any = await import("z-ai-web-dev-sdk");
  const Ctor: { create: () => Promise<any> } = mod.default ?? mod;
  zaiInstance = (await Ctor.create()) as ZaiLike;
  return zaiInstance;
}

// ---- 合成缓存（LRU：文本+声音+语速 → WAV Buffer） ---------------------------

const ttsCache = new Map<string, Buffer>();
const TTS_CACHE_MAX = 32;
const TTS_CACHE_BYTES = 8 * 1024 * 1024;

function cacheKey(text: string, voice: string, speed: number): string {
  return `${voice}|${speed}|${text}`;
}

function cacheGet(key: string): Buffer | undefined {
  const hit = ttsCache.get(key);
  if (hit !== undefined) {
    ttsCache.delete(key);
    ttsCache.set(key, hit); // LRU 触碰：移到队尾
  }
  return hit;
}

function cachePut(key: string, buf: Buffer): void {
  if (buf.length > TTS_CACHE_BYTES) return; // 单条超限不缓存
  let total = buf.length;
  for (const [k, v] of ttsCache) {
    if (total <= TTS_CACHE_BYTES && ttsCache.size < TTS_CACHE_MAX) break;
    total -= v.length;
    ttsCache.delete(k); // 队首（最旧）淘汰
  }
  ttsCache.set(key, buf);
}

// ---- WAV 封装（24kHz PCM16 单声道 · 44 字节 RIFF 头，与 lib/audio.ts 同构） --

function pcmToWav(pcm: Buffer): Buffer {
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);   // fmt 子块长度（PCM 恒 16）
  buf.writeUInt16LE(1, 20);    // 音频格式：PCM
  buf.writeUInt16LE(1, 22);    // 通道数：单声道（语音车道）
  buf.writeUInt32LE(TTS_SAMPLE_RATE, 24);
  buf.writeUInt32LE(TTS_SAMPLE_RATE * 2, 28); // 字节率（1ch × 2B）
  buf.writeUInt16LE(2, 32);    // 块对齐
  buf.writeUInt16LE(16, 34);   // 位深
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}

// ---- ASR：音频 → 文本 --------------------------------------------------------

export interface TranscribeOutcome {
  ok: boolean;
  text?: string;
  chars?: number;
  error?: string;
}

/** 语音转写：音频 Buffer → {ok, text}。降级：SDK 缺席/凭据失败 → ok:false
 *  + 明确 error（含 remedy 提示）。空转写（audio 无语音）→ 明确错误。 */
export async function transcribeAudio(buf: Buffer): Promise<TranscribeOutcome> {
  if (!buf || buf.length === 0) {
    return { ok: false, error: "音频为空（未录到内容）" };
  }
  if (buf.length > ASR_MAX_BYTES) {
    return { ok: false, error: `音频过大（${(buf.length / 1024 / 1024).toFixed(1)}MB > 15MB 上限）` };
  }
  try {
    const zai = await getZai();
    const r = await zai.audio.asr.create({ file_base64: buf.toString("base64") });
    const text = String(r?.text ?? "").trim();
    if (!text) {
      return { ok: false, error: "转写结果为空（音频无语音内容或质量过低）" };
    }
    return { ok: true, text, chars: text.length };
  } catch (e) {
    return { ok: false, error: voiceError(e) };
  }
}

// ---- TTS：文本 → WAV ---------------------------------------------------------

export interface SpeakOutcome {
  ok: boolean;
  wav?: Buffer;
  chunks?: number;
  voice?: string;
  speed?: number;
  truncated?: boolean;
  totalChars?: number;
  error?: string;
}

/** 文本合成：分段 PCM → 拼接 → 自封 WAV（24kHz 单声道）。
 *  超过 TTS_TEXT_LIMIT 的部分诚实截断（truncated: true）。
 *  降级：SDK 缺席/凭据失败 → ok:false + 明确 error。 */
export async function synthesizeSpeech(text: string, opts: SpeakOptions = {}): Promise<SpeakOutcome> {
  const voice = normalizeVoice(opts.voice);
  const speed = normalizeSpeed(opts.speed);
  const norm = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!norm) return { ok: false, error: "文本为空（无可朗读内容）" };
  const truncated = norm.length > TTS_TEXT_LIMIT;
  const bounded = truncated ? norm.slice(0, TTS_TEXT_LIMIT) : norm;
  const chunks = splitTtsChunks(bounded);
  if (chunks.length === 0) return { ok: false, error: "文本为空（无可朗读内容）" };

  const key = cacheKey(bounded, voice, speed);
  const hit = cacheGet(key);
  if (hit) {
    return { ok: true, wav: hit, chunks, voice, speed, truncated, totalChars: norm.length };
  }

  try {
    const zai = await getZai();
    const pcmParts: Buffer[] = [];
    for (const chunk of chunks) {
      const r = await zai.audio.tts.create({
        input: chunk, voice, speed,
        response_format: "pcm", // 24kHz PCM16 —— 拼接与封头自己做（确定行为）
        stream: false,          // 流式仅支持 pcm，非流式对齐
      });
      const ab = await r.arrayBuffer();
      pcmParts.push(Buffer.from(new Uint8Array(ab)));
    }
    const pcm = Buffer.concat(pcmParts);
    if (pcm.length === 0) {
      return { ok: false, error: "合成结果为空（SDK 返回零字节音频）" };
    }
    const wav = pcmToWav(pcm);
    cachePut(key, wav);
    return { ok: true, wav, chunks: chunks.length, voice, speed, truncated, totalChars: norm.length };
  } catch (e) {
    return { ok: false, error: voiceError(e) };
  }
}

/** 语音服务健康探测（GUI 状态条数据源；探测结果不缓存 —— 一次轻调用）。 */
export async function voiceStatus(): Promise<{ sdk: boolean; voices: number; error?: string }> {
  try {
    await getZai();
    return { sdk: true, voices: Object.keys(VOICES).length };
  } catch (e) {
    return { sdk: false, voices: Object.keys(VOICES).length, error: voiceError(e) };
  }
}

/** 错误归一：401/凭据类 → 明确 remedy；其余保原文（可诊断）。 */
function voiceError(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e);
  if (/401|X-Token|unauthorized/i.test(msg)) {
    return "语音服务凭据未配置（z-ai SDK 401）—— 部署环境配置凭据后 🎤 转写与 🔊 朗读即刻可用；本会话可继续使用文本交互";
  }
  return msg.slice(0, 300);
}
