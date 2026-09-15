// ============================================================================
// org/lib/vision.ts — 视觉入口（v0.5.13）：VLM 图片理解
// ----------------------------------------------------------------------------
// capabilities #25 的执行层：z-ai-web-dev-sdk 的 chat.completions.createVision
// （SDK 仅后端使用 —— Web GUI 经 /api/vision 端点调用本模块；CLI org vision）。
//
// 多重优雅降级（ORG 核心纪律，与 lib/voice.ts 同构）：
//   1. SDK 缺席/凭据失败 → {ok:false, error}（明确可诊断，Web 显示提示条，
//      不炸不挂——用户部署环境配好凭据即全功能）；
//   2. DHV_VISION_DISABLE_SDK=1 → 显式拒绝（CI 零外联开关，对齐
//      DHV_VOICE_DISABLE_SDK / DHV_LLM_DISABLE_SDK 惯例）；
//   3. 非白名单 mime / 超限体积 / 超限张数 / 空结果 → 明确人话错误
//      （与 ASR 的空转写、TTS 的空文本同语义）；
//   4. prompt 超长（>2000）诚实截断并标注。
//
// 测试注入口：setZaiFactory(fake)（tests/vision.test.ts 全 mock 零外联）。
// ============================================================================

/** 视觉分析结果。 */
export interface VisionOutcome {
  ok: boolean;
  text?: string;
  chars?: number;
  images?: number;
  prompt?: string;
  promptTruncated?: boolean;
  error?: string;
}

/** 单图体积上限（10MB —— base64 后 ~13.3MB，传输与模型的合理上界）。 */
export const VISION_MAX_BYTES = 10 * 1024 * 1024;

/** 单次分析图数上限（SDK 支持多图；4 张防滥用）。 */
export const VISION_MAX_IMAGES = 4;

/** prompt 长度上限（视觉问答的提示词足够；超出诚实截断）。 */
export const VISION_PROMPT_MAX = 2000;

/** 缺省分析提示词（GUI 📷 按钮未带 prompt 时使用）。 */
export const VISION_DEFAULT_PROMPT = "请详细描述这张图片的内容（主体、场景、文字如有请转录）";

/** 图片 mime 白名单（SDK 支持格式；data URL 前缀容忍后归一到小写）。 */
export const IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** mime 归一：容忍 data URL 前缀与大小写；未知名 → null（调用方给出人话错误）。 */
export function normalizeImageMime(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const bare = s.replace(/^data:([^;,]+)[;,].*$/, "$1"); // "data:image/png;base64,..." → "image/png"
  return Object.prototype.hasOwnProperty.call(IMAGE_MIMES, bare) ? bare : null;
}

/** 图片嗅探（魔数）：Buffer → mime（未知返回 null）。
 *  优于信任客户端声明 —— 防伪造 mime 灌非图片载荷。 */
export function sniffImageMime(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null;
  const h = buf.subarray(0, 12);
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" / "GIF89a"
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && (h[3] === 0x38)) return "image/gif";
  // BMP: "BM"
  if (h[0] === 0x42 && h[1] === 0x4d) return "image/bmp";
  // WebP: "RIFF" .... "WEBP"
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
      h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return "image/webp";
  return null;
}

/** 输入图（Buffer + 可选 mime；mime 缺省由魔数嗅探补全）。 */
export interface VisionImage {
  buf: Buffer;
  mime?: string;
}

// ---- SDK 封装（懒加载单例 + 测试注入口） -----------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type ZaiLike = {
  chat: {
    completions: {
      createVision: (r: Record<string, unknown>) => Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
    };
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
  if ((process.env.DHV_VISION_DISABLE_SDK || "").trim() === "1") {
    throw new Error("vision: SDK 车道已禁用（DHV_VISION_DISABLE_SDK=1，零外联模式）—— 视觉入口需要 z-ai SDK 凭据或关闭该开关");
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

// ---- 分析（多图 + prompt） ----------------------------------------------------

/** 视觉分析：图片 Buffer 列表 + prompt → {ok, text}。
 *  校验（体积/张数/mime 白名单 + 魔数嗅探）全在 SDK 调用前 —— 防伪造与滥用。
 *  降级：SDK 缺席/凭据失败 → ok:false + 明确 error（含 remedy 提示）。 */
export async function analyzeImages(
  images: VisionImage[],
  prompt?: string,
): Promise<VisionOutcome> {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) {
    return { ok: false, error: "图片为空（未选择任何图片）" };
  }
  if (list.length > VISION_MAX_IMAGES) {
    return { ok: false, error: `图片过多（${list.length} > ${VISION_MAX_IMAGES} 张上限）` };
  }
  // 校验 + data URL 构造（mime：声明值优先，魔数嗅探兜底校验）
  const urls: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    const buf = img?.buf;
    if (!buf || buf.length === 0) {
      return { ok: false, error: `第 ${i + 1} 张图片为空（未读到内容）` };
    }
    if (buf.length > VISION_MAX_BYTES) {
      return { ok: false, error: `第 ${i + 1} 张图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB > 10MB 上限）` };
    }
    const claimed = normalizeImageMime(img.mime);
    const sniffed = sniffImageMime(buf);
    if (!claimed && !sniffed) {
      return { ok: false, error: `第 ${i + 1} 张图片格式不受支持（png/jpeg/gif/webp/bmp）` };
    }
    if (claimed && sniffed && claimed !== sniffed &&
        !(claimed === "image/jpeg" && sniffed === "image/jpeg") &&
        !(claimed === "image/jpg" && sniffed === "image/jpeg")) {
      return { ok: false, error: `第 ${i + 1} 张图片声明 ${claimed} 但内容是 ${sniffed}（伪造 mime 拒绝）` };
    }
    const mime = sniffed ?? claimed!;
    urls.push(`data:${mime};base64,${buf.toString("base64")}`);
  }
  // prompt 归一（缺省提示词；超长截断标注）
  const rawPrompt = String(prompt ?? "").replace(/\s+/g, " ").trim();
  const finalPrompt = rawPrompt || VISION_DEFAULT_PROMPT;
  const promptTruncated = finalPrompt.length > VISION_PROMPT_MAX;
  const boundedPrompt = promptTruncated ? finalPrompt.slice(0, VISION_PROMPT_MAX) : finalPrompt;

  try {
    const zai = await getZai();
    const content: Array<Record<string, unknown>> = [{ type: "text", text: boundedPrompt }];
    for (const url of urls) content.push({ type: "image_url", image_url: { url } });
    const r = await zai.chat.completions.createVision({
      messages: [{ role: "user", content }],
      thinking: { type: "disabled" },
    });
    const text = String(r?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      return { ok: false, error: "分析结果为空（图片无有效内容或质量过低）" };
    }
    return {
      ok: true, text, chars: text.length,
      images: urls.length, prompt: boundedPrompt, promptTruncated,
    };
  } catch (e) {
    return { ok: false, error: visionError(e) };
  }
}

/** 单图便捷入口（GUI 📷 按钮 / CLI org vision）。 */
export async function analyzeImage(
  buf: Buffer,
  mime: string | undefined,
  prompt?: string,
): Promise<VisionOutcome> {
  return analyzeImages([{ buf, mime }], prompt);
}

/** 视觉服务健康探测（GUI 状态条数据源；凭据在首次调用时校验 —— 与 voice 同语义）。 */
export async function visionStatus(): Promise<{ sdk: boolean; formats: number; error?: string }> {
  try {
    await getZai();
    return { sdk: true, formats: Object.keys(IMAGE_MIMES).length };
  } catch (e) {
    return { sdk: false, formats: Object.keys(IMAGE_MIMES).length, error: visionError(e) };
  }
}

/** 错误归一：401/凭据类 → 明确 remedy；其余保原文（可诊断）。 */
function visionError(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e);
  if (/401|X-Token|unauthorized/i.test(msg)) {
    return "视觉服务凭据未配置（z-ai SDK 401）—— 部署环境配置凭据后 📷 图片分析即刻可用；本会话可继续使用文本交互";
  }
  return msg.slice(0, 300);
}
