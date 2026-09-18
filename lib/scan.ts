// ============================================================================
// lib/scan.ts — 密钥/敏感信息扫描器（v0.5.15 · capabilities #141 密钥/漏洞扫描
//                                        + #144 数据脱敏 —— 检测半环）
// ----------------------------------------------------------------------------
// 桌面 Agent 的安全底线能力：模型要写文件时先扫（fs_write 拦截的检测半环 ——
// scanText 单文本入口），用户也能手动扫工作区（scanWorkspace 全量入口，
// CLI/Web 接线预留）。零依赖纯正则：18 条高信噪比模式覆盖主流 LLM / 云厂商 /
// 代码托管平台的密钥形态。诚实边界：gitleaks/trufflehog 级重依赖不进零依赖
// 内核，正则库的召回不穷尽（漏洞扫描 —— 依赖审计、CWE 模式 —— 是路线图，
// 本模块先钉住密钥面）；每条模式的误报特性在注释里如实声明。
//
// 脱敏原则（#144 与本模块构成检测/显示闭环）：
//   · ScanHit.preview 永不含完整密钥 —— 命中行经 maskLine 行级脱敏（每个
//     命中段保留前 4 后 2、中间 ***），超 240 字符截断（截的是脱敏后文本，
//     截断不可能还原出密钥）。
//   · lib/config.ts 已有 maskSecret（整值脱敏：首 3 尾 4，config 面板显示
//     用）；本模块导出 maskLine（行级脱敏：一行内所有命中段各自脱敏）——
//     同族不同粒度故不同名（grep 已确认 config 侧占用 maskSecret）。
//
// 次序契约：SECRET_PATTERNS 先精确后宽泛（deepseek 精确 32 hex 排在 openai
// 宽模式之前；.env 赋值宽模式殿后）。同一行两个模式的命中区间重叠时，让位
// 给数组更靠前（更精确）的那条 —— 一个 DeepSeek key 只报一次且归属正确；
// 「API_KEY=sk-…」只按 openai-key 报（不重复计 env 赋值）。
//
// 优雅降级：二进制（前 4KB 含 NUL 嗅探，与 search.ts 同规）与超 1MB 文件
// 跳过并计数（skippedBinary / skippedOversize）；单文件读失败静默跳过不连
// 坐；maxFiles（缺省 1000）封顶防大工作区拖死，触顶 truncated:true；缺席
// 目录（opts.dirs 指错）从 rootsScanned 里消失而非报错。默认排除 .git/
// node_modules/ runtime/ dist/ out-*/ spawn/（runtime 里是脱敏台账不该重复
// 报；out-* 是运行产物）—— 隐藏【目录】不扫，但隐藏【文件】（.env —— 头号
// 扫描对象）必须扫。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- 模式库（每条注明来源形态与误报权衡）------------------------------------

export interface SecretPattern {
  /** 稳定 id（ScanHit.pattern 回指；CLI/Web 按它过滤与定位文档）。 */
  id: string;
  /** 人读名（报告与面板显示）。 */
  name: string;
  /** 高（可直接确认为机密）/ 中（形态确凿但身份存疑）/ 低（上下文启发式）。 */
  severity: "high" | "medium" | "low";
  /** 匹配正则。不带 g —— scanText/maskLine 按需克隆，避免 lastIndex 状态残留。 */
  regex: RegExp;
  /** 形态示例（假样本，非真实密钥；tests 锁定「每条模式命中自己的 sample」）。 */
  sample: string;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    // DeepSeek 官方 key 形态：sk- + 精确 32 位小写 hex，尾界断言防更长 hex
    // 串的前缀撞脸。误报权衡：同形串可能是自建网关 key —— 身份存疑但确是
    // 密钥形态，定 medium；必须排在 openai-key 之前（次序契约：先精确后
    // 宽泛），否则会被宽模式吞掉归属。
    id: "deepseek-key",
    name: "DeepSeek API key",
    severity: "medium",
    regex: /sk-[a-f0-9]{32}(?![a-f0-9])/,
    sample: "sk-0123456789abcdef0123456789abcdef",
  },
  {
    // OpenAI key：sk- + 20+ 位字母数字（现行 48+、老 key 32+，取 20 保召回）。
    // 负向先行排除 sk-ant-（Anthropic 前缀撞脸）。误报率：低 —— 随机
    // base64url 串里出现「sk- + 20 位连续字母数字」的概率小，但存在。
    id: "openai-key",
    name: "OpenAI API key",
    severity: "high",
    regex: /sk-(?!ant-)[A-Za-z0-9]{20,}/,
    sample: "sk-Abc123Def456Ghi789Jkl",
  },
  {
    // Anthropic key：sk-ant-（api03- 等）后接 24+ 位。误报率：极低（前缀独特）。
    id: "anthropic-key",
    name: "Anthropic API key",
    severity: "high",
    regex: /sk-ant-[A-Za-z0-9-]{24,}/,
    sample: "sk-ant-api03-Abc123Def456Ghi789JklMno",
  },
  {
    // GitHub token 家族：ghp_（classic）/gho_/ghu_/ghs_/ghr_ + 36-40 位
    // （经典 PAT 全长 40）。误报率：极低（前缀 + 长度双约束）。
    id: "github-token",
    name: "GitHub access token",
    severity: "high",
    regex: /gh[pousr]_[A-Za-z0-9]{36,40}/,
    sample: "ghp_Abc123Def456Ghi789JklMnoPqr456Stu789",
  },
  {
    // GitLab PAT：glpat- + 20+ 位。误报率：极低（前缀独特）。
    id: "gitlab-token",
    name: "GitLab personal access token",
    severity: "high",
    regex: /glpat-[A-Za-z0-9_-]{20,}/,
    sample: "glpat-Abc123Def456Ghi789Jkl",
  },
  {
    // AWS Access Key ID：AKIA（长期）+ ASIA（临时 STS 孪生前缀）+ 16 位
    // 大写字母数字。误报率：极低（前缀 + 全大写约束）。
    id: "aws-access-key",
    name: "AWS access key id",
    severity: "high",
    regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/,
    sample: "AKIAABCDEFGHIJ012345",
  },
  {
    // Google API key：AIza + 35 位（全长 39）；Firebase 项目 apiKey 同形
    // （同家族一并覆盖）。误报率：低（前缀 + 定长）。
    id: "google-api-key",
    name: "Google/Firebase API key",
    severity: "high",
    regex: /AIza[0-9A-Za-z_-]{35}/,
    sample: "AIzaAbc123Def456Ghi789JklMnoPqr456Stu78",
  },
  {
    // Slack token 家族：xoxb（bot）/xoxa/xoxp/xoxr/xoxs + 10+ 位。误报率：
    // 极低（前缀独特）。
    id: "slack-token",
    name: "Slack token",
    severity: "high",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/,
    sample: "xoxb-123456789012-1234567890123-AbcDefGhiJkl",
  },
  {
    // Stripe live 密钥：sk_live_（secret）/rk_live_（restricted）+ 20+ 位。
    // _test_ 测试键不是机密（缺省不报 —— 换零噪音）。误报率：极低。
    id: "stripe-live-key",
    name: "Stripe live key",
    severity: "high",
    regex: /[sr]k_live_[A-Za-z0-9]{20,}/,
    sample: "sk_live_00000000000000000000",
  },
  {
    // 智谱（GLM）key：32 位小写 hex + "." + 16 位字母数字（点分两段）。
    // 前后边界断言（非字母数字）防 40 位 commit hash 的尾段撞脸。误报率：低。
    id: "zhipu-key",
    name: "智谱 AI key",
    severity: "high",
    regex: /(?<![0-9A-Za-z])[a-f0-9]{32}\.[A-Za-z0-9]{16}(?![0-9A-Za-z])/,
    sample: "0123456789abcdef0123456789abcdef.AbcDefGhiJklMnoP",
  },
  {
    // 阿里云（含通义 dashscope）AccessKey ID：LTAI + 12-20 位。误报权衡：
    // LTAI 前缀为阿里云专属、尾段长度放宽是跨代 key 形态的召回折衷 —— 宁可
    // 多看一眼，由 preview 脱敏兜底。
    id: "dashscope-key",
    name: "阿里云/通义 AccessKey ID",
    severity: "high",
    regex: /LTAI[0-9A-Za-z]{12,20}/,
    sample: "LTAI5tGAbc123Def456Xy9",
  },
  {
    // SendGrid key：SG. + 22 位 + "." + 43 位（点分三段，双段定长）。误报率：
    // 极低（定长约束极强）。
    id: "sendgrid-key",
    name: "SendGrid API key",
    severity: "high",
    regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/,
    sample: "SG.0000000000000000000000.0000000000000000000000000000000000000000000",
  },
  {
    // 私钥块头：PEM（RSA/EC/裸）/OPENSSH。只报头行 —— 身体行是无标记
    // base64，靠头行定位已足够。误报率：极低（测试 fixture 里的演示 pem 头
    // 是已知误报源，由人工复核消化）。
    id: "private-key-block",
    name: "私钥块（PEM/OPENSSH）",
    severity: "high",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    sample: "-----BEGIN RSA PRIVATE KEY-----",
  },
  {
    // JWT：eyJ 头 . eyJ 载荷 .（签名段可空 —— alg=none 形态）；头/载荷各
    // ≥10 位 base64url 防散文误报。误报权衡：测试 fixture 里大量演示 JWT，
    // 定 medium（泄露 JWT = 会话劫持，但演示串噪音占比高，交人工复核）。
    id: "jwt",
    name: "JWT（会话凭证）",
    severity: "medium",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
    sample: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmctbGFiIn0.AAAAfakeSigAAAA",
  },
  {
    // 数据库连接串（内嵌凭据）：postgres(ql)://user:pass@ / mysql://…@。
    // 只认「协议 + 凭据@」形态 —— postgres://localhost:5432/app（无凭据）
    // 不报。误报率：低。mongodb/redis 同形可按需扩。
    id: "db-credentials",
    name: "数据库连接串（含凭据）",
    severity: "high",
    regex: /(?:postgres(?:ql)?|mysql):\/\/[^\s:@/"']+:[^\s:@/"']+@/,
    sample: "postgres://alice:S3cretPW@db.internal:5432/prod",
  },
  {
    // Telegram bot token：8-10 位数字 + ":AA" + 33 位。误报率：极低（":AA"
    // 锚点独特；时刻串 12:34:56 因位数不足不会撞）。
    id: "telegram-bot-token",
    name: "Telegram bot token",
    severity: "high",
    regex: /\d{8,10}:AA[A-Za-z0-9_-]{33}/,
    sample: "123456789:AAAbcdef123456789012345678901234567",
  },
  {
    // 微信生态 app secret：wechat/weixin/微信 语境 + secret 赋值 + 32 位
    // 小写 hex。裸 32-hex（md5/uuid 同形）误报率不可接受 —— 语境锚定后定
    // medium 是精度/召回折衷。
    id: "wechat-secret",
    name: "微信 app secret（语境锚定）",
    severity: "medium",
    regex: /(wechat|weixin|微信)[_-]?secret\s*[=:]\s*['"]?[0-9a-f]{32}/i,
    sample: "WECHAT_SECRET=0123456789abcdef0123456789abcdef",
  },
  {
    // .env 风格赋值（殿后 —— 最宽泛）：api_key/apikey/secret/token/password
    // + [:=] + 16+ 位非空白值。已知误报特性（如实声明）：教程占位符
    // （API_KEY=your_api_key_here）、长配置值（token=featureflags_xxx…）会
    // 命中 —— 定 low 交人工复核；值 <16 位（password=hunter2 类）不报。
    // 与精确模式区间重叠时让位（「API_KEY=sk-…」按 openai-key 报）。
    id: "env-assignment",
    name: ".env 风格敏感赋值",
    severity: "low",
    regex: /(api_key|apikey|secret|token|password)\s*[=:]\s*\S{16,}/i,
    sample: "API_KEY=demo_value_NOT_real_0123456789",
  },
];

// ---- 行级脱敏（#144 显示半环共用）------------------------------------------

/** 单段脱敏：保留前 4 后 2，中间 ***。≤8 字符整体 ***（前 4 后 2 会互相
 *  咬尾露全文的长度区间不冒险）。 */
function maskSegment(s: string): string {
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

/** 命中段脱敏：.env 风格命中段含键名 —— 保留「键=」/「键: 」只脱值（审计
 *  者需要知道是哪个键泄漏）；无分隔符（裸 token）整段脱敏。 */
function maskMatch(m: string): string {
  const eq = m.indexOf("=");
  const colonSp = m.indexOf(": ");
  const sep = eq >= 0 && colonSp >= 0 ? Math.min(eq, colonSp) : Math.max(eq, colonSp);
  if (sep >= 0 && m.length - sep > 12) {
    const head = m.slice(0, sep + 1);
    const rest = m.slice(sep + 1);
    const lead = rest.match(/^[\s"']*/)?.[0] ?? "";
    return head + lead + maskSegment(rest.slice(lead.length));
  }
  return maskSegment(m);
}

/** 行级脱敏：把一行内所有密钥命中段各自脱敏（前 4 后 2 中间 ***），其余
 *  文本原样保留（行上下文可读 —— 审计定位需要）。与 lib/config.ts 的
 *  maskSecret（整值、首 3 尾 4）同族不同粒度。非命中行原样返回。
 *  脱敏后的段最长 11 字符且含 ***，不会被后续（更宽泛的）模式重新命中。 */
export function maskLine(line: string): string {
  let out = line;
  for (const p of SECRET_PATTERNS) {
    const g = p.regex.flags.includes("g")
      ? p.regex
      : new RegExp(p.regex.source, p.regex.flags + "g");
    out = out.replace(g, (m) => maskMatch(m));
  }
  return out;
}

/** preview 截断帽（脱敏后文本上截断 —— 截断不可能还原出密钥）。 */
const PREVIEW_MAX = 240;

function previewOf(line: string): string {
  const masked = maskLine(line);
  if (masked.length <= PREVIEW_MAX) return masked;
  return `${masked.slice(0, PREVIEW_MAX)}…（${masked.length} 字符，已截断）`;
}

// ---- 单文本扫描（fs_write 拦截的检测半环）----------------------------------

export interface ScanHit {
  /** 命中模式 id（回指 SECRET_PATTERNS[].id）。 */
  pattern: string;
  severity: "high" | "medium" | "low";
  /** 文件（workspace 相对路径，正斜杠；无文件上下文时为 "?"）。 */
  file: string;
  /** 行号（1 基）。 */
  line: number;
  /** 脱敏后的整行（永不含完整密钥；超长截断）。 */
  preview: string;
}

/** 模式次序即精确度次序：区间重叠时靠前的（更精确）优先。 */
interface Span {
  pi: number;
  start: number;
  end: number;
}

/** 扫描一段文本（fs_write 拦截 / 单文件复检）。逐行匹配全部模式；同行
 *  命中区间重叠时让位给更精确（数组更靠前）的模式 —— DeepSeek key 不会被
 *  openai 宽模式重复计，「API_KEY=sk-…」只按 openai-key 报。无文件上下文
 *  时 file="?"。 */
export function scanText(text: string, file = "?"): ScanHit[] {
  const hits: ScanHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    const accepted: Span[] = [];
    for (let pi = 0; pi < SECRET_PATTERNS.length; pi++) {
      const p = SECRET_PATTERNS[pi];
      const g = p.regex.flags.includes("g")
        ? p.regex
        : new RegExp(p.regex.source, p.regex.flags + "g");
      for (const m of line.matchAll(g)) {
        const start = m.index ?? 0;
        const span: Span = { pi, start, end: start + m[0].length };
        if (span.end === span.start) continue; // 零长防御（本库不会出现，双保险）
        if (accepted.some((a) => span.start < a.end && a.start < span.end)) continue;
        accepted.push(span);
      }
    }
    if (accepted.length === 0) continue;
    accepted.sort((a, b) => a.start - b.start);
    const preview = previewOf(line); // 行内多命中共享同一份脱敏行
    for (const s of accepted) {
      const p = SECRET_PATTERNS[s.pi];
      hits.push({ pattern: p.id, severity: p.severity, file, line: i + 1, preview });
    }
  }
  return hits;
}

// ---- 工作区扫描（手动全量入口）----------------------------------------------

export interface ScanReport {
  /** 检视过的文件总数（含二进制/超限跳过；不含未走到的 —— 触顶截断）。 */
  files: number;
  /** 实际进入正则扫描的文件数。 */
  scanned: number;
  hits: ScanHit[];
  tookMs: number;
  /** 二进制跳过数（前 4KB 含 NUL 嗅探）。 */
  skippedBinary: number;
  /** 超限跳过数（单文件 > 1MB）。 */
  skippedOversize: number;
  /** true = 文件数触到 maxFiles 上限，未扫完（诚实截断标记）。 */
  truncated: boolean;
  /** 实际扫描的根目录（缺省 ["."]；opts.dirs 里缺席者被剔除）。 */
  rootsScanned: string[];
}

/** 单文件尺寸帽：>1MB 跳过（密钥扫描的语料是源码/配置，不是数据集；
 *  同时封顶单文件正则成本）。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** 文件数帽（缺省）：防大工作区把交互入口拖死。 */
const DEFAULT_MAX_FILES = 1000;
/** 递归深度帽：防病态嵌套（排除目录之外的最后防线）。 */
const MAX_DEPTH = 8;

const EXCLUDED_DIRS = new Set([".git", "node_modules", "runtime", "dist", "spawn"]);

/** 排除判定：具名目录 + out-* 前缀（运行产物）+ 一切隐藏目录。粒度注意：
 *  排除的是隐藏【目录】（.git/.vscode…）；隐藏【文件】（.env —— 头号扫描
 *  对象）不排除。 */
function excludedDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (EXCLUDED_DIRS.has(name)) return true;
  return name.startsWith("out-");
}

/** 二进制嗅探：前 4KB 含 NUL → 判二进制（与 search.ts 同规）。 */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(4096, buf.length)).includes(0);
}

interface WalkState {
  examined: number;
  maxFiles: number;
  truncated: boolean;
}

/** 递归收集文件（相对路径正斜杠）。目录排除按路径段判 —— 任意深度的
 *  runtime/ out-* 都不进扫描面。符号链接一律跳过（防环 + 防逃逸出工作区）。 */
function walk(ws: string, rel: string, st: WalkState, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || st.truncated) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rel ? path.join(ws, rel) : ws, { withFileTypes: true });
  } catch {
    return; // 目录不可读/消失 → 降级为空
  }
  for (const e of entries) {
    if (st.truncated) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (excludedDir(e.name)) continue;
      walk(ws, childRel, st, out, depth + 1);
    } else if (e.isFile()) {
      if (st.examined >= st.maxFiles) {
        st.truncated = true;
        return;
      }
      st.examined++;
      out.push(childRel);
    }
  }
}

function normalizeRoot(d: string): string {
  return d === "." ? "" : d.replace(/[\\/]+$/, "");
}

/** 扫描工作区（缺省全工作区；opts.dirs 定向、opts.maxFiles 封顶）。
 *  逐文件隔离降级：单个读失败/二进制/超限只跳过计数，不连坐。 */
export function scanWorkspace(ws: string, opts?: { dirs?: string[]; maxFiles?: number }): ScanReport {
  const t0 = Date.now();
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  // 定向根：显式 dirs（缺席者剔除）｜缺省/空数组 = 全工作区（"."）
  const requested = opts?.dirs && opts.dirs.length > 0 ? opts.dirs : ["."];
  const roots = requested.filter((d) => {
    try {
      return fs.statSync(path.join(ws, d)).isDirectory();
    } catch {
      return false;
    }
  });

  const st: WalkState = { examined: 0, maxFiles, truncated: false };
  const relFiles: string[] = [];
  for (const r of roots) walk(ws, normalizeRoot(r), st, relFiles, 0);

  let scanned = 0;
  let skippedBinary = 0;
  let skippedOversize = 0;
  const hits: ScanHit[] = [];
  for (const rel of relFiles) {
    const abs = path.join(ws, rel);
    let buf: Buffer;
    try {
      const s = fs.statSync(abs);
      if (!s.isFile()) continue;
      if (s.size > MAX_FILE_BYTES) {
        skippedOversize++;
        continue;
      }
      buf = fs.readFileSync(abs);
    } catch {
      continue; // 读失败静默跳过（不连坐）
    }
    if (isBinary(buf)) {
      skippedBinary++;
      continue;
    }
    scanned++;
    hits.push(...scanText(buf.toString("utf-8"), rel));
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    files: relFiles.length,
    scanned,
    hits,
    tookMs: Date.now() - t0,
    skippedBinary,
    skippedOversize,
    truncated: st.truncated,
    rootsScanned: roots,
  };
}
