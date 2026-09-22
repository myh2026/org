// ============================================================================
// lib/sast.ts — SAST 静态安全分析（v0.5.22 · capabilities #146）
// ----------------------------------------------------------------------------
// 单一实现三端消费：CLI `org sast` · 工具环 `sast_scan`（只读）·
// Web GET /api/govex/sast。
//
// 多引擎探测降级链（引擎缺席诚实降级，内置规则永远兜底 —— 永远有产出）：
//   ① Python 代码车道：ruff check --select S（flake8-bandit 规则集的 ruff 移植，
//      本机 /usr/local/bin 或 uv tool install 落点 ~/.local/bin，ruff-gate.ts
//      同款定位链）→ ② bandit（-f json，ruff 缺席时的第二引擎）→ ③ 内置
//      降级规则引擎（纯 TS 行级 regex）。
//   ① 密钥横切车道：gitleaks（在场时 --no-git 全文件面）→ 内置密钥规则兜底
//      （sk-ant-/sk-/ghp_/AKIA 值形状 —— 与 lib/scan.ts / iacscan.ts 同族）。
//   semgrep：which 探测入报告；调用需 ORG_SEMGREP_CONFIG 显式给本地规则文件
//   （零外联铁律：不自动拉规则注册表），作为增广车道合入 findings。
//   TS/JS 代码车道：内置规则引擎（eval/new Function / SQL 模板拼接 / exec
//   模板拼接 / 弱随机）—— ruff/bandit 只覆盖 Python，TS 侧降级链终点恒为内置。
//
// 诚实边界（行级 regex，如实声明不装完整语义分析器）：
//   · 行级模式匹配 —— 跨行构造（如字符串分两行拼接）与语义等价改写不在面内；
//     误报方向是漏报（安全侧），注释行跳过但行内尾注释不剥离。
//   · ruff/bandit 只按「S 码 / B 码」映射 severity（S102/S307/S6xx→high，
//     S3xx 密码学/断言→medium/low），未知码缺省 medium。
//   · gitleaks 车道在本沙箱缺席（代码路径完整、缺真实引擎实测 —— 与
//     lib/remote.ts「无真远程机」同款诚实边界）。
//   · 与 lib/scan.ts（密钥扫描 18 类）的分工：scan 钉密钥单面全形态（JWT/
//     私钥/.env 赋值），本模块是「多模式面 SAST」（注入/拼接/弱随机 + 密钥
//     值形状）；与 iacscan.ts 的分工：iacscan 钉容器/IaC 配置面，本模块钉
//     源代码面。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inWorkspace } from "./pathjail.ts";

// ---- 引擎探测 ---------------------------------------------------------------

export type SastEngineName = "ruff" | "bandit" | "semgrep" | "gitleaks";
export type SastEngine = SastEngineName | "builtin";
export type SastSeverity = "high" | "medium" | "low";

export interface SastEngineProbe {
  name: SastEngineName;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 缺席 = 安装指引；在场但版本未知 = 诚实说明。 */
  note?: string;
}

/** which 扫描（PATH 活时读 —— tests PATH 操控注入假引擎的通道）+ win32 exe 后缀。
 *  ruff 额外探测 uv tool install 落点 ~/.local/bin（ruff-gate.ts 同款）。 */
function whichTool(name: string, extraHomes: string[] = []): string | null {
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const c of process.env.PATH?.split(path.delimiter) ?? []) {
    if (!c) continue;
    const p = path.join(c, name + exe);
    if (fs.existsSync(p)) return p;
  }
  for (const h of extraHomes) {
    const p = path.join(h, name + exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 数组参数 spawn（零 shell 注入面）+ 硬超时 + 输出帽；失败降级 null。 */
function spawnCaptured(argv: string[], timeoutMs: number, cwd?: string): { exitCode: number | null; stdout: string; stderr: string } | null {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
      cwd,
      env: process.env, // 运行期 env（PATH 操控可见 —— mobile.ts 同款教训）
    } as Parameters<typeof Bun.spawnSync>[1]);
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout?.toString() ?? "").slice(0, 256 * 1024),
      stderr: (r.stderr?.toString() ?? "").slice(0, 64 * 1024),
    };
  } catch {
    return null; // 启动失败/超时强杀 → 调用方按缺席/失败降级
  }
}

const ENGINE_INSTALL_HINTS: Record<SastEngineName, string> = {
  ruff: "安装：uv tool install ruff（或 pip install ruff）—— Python 代码车道主引擎（--select S 规则集）",
  bandit: "安装：pip install bandit / uv tool install bandit —— ruff 缺席时的 Python 第二引擎",
  semgrep: "安装：pip install semgrep；调用需 ORG_SEMGREP_CONFIG=<本地规则文件>（不自动拉注册表 —— 零外联）",
  gitleaks: "安装：https://github.com/gitleaks/gitleaks（brew install gitleaks）—— 密钥横切车道引擎",
};

function probeOne(name: SastEngineName, versionFlag: string[]): SastEngineProbe {
  const bin = whichTool(name, name === "ruff" ? [path.join(os.homedir(), ".local", "bin")] : []);
  if (bin === null) {
    return { name, available: false, path: null, version: null, note: ENGINE_INSTALL_HINTS[name] };
  }
  const v = spawnCaptured([bin, ...versionFlag], 5_000);
  const out = ((v?.stdout ?? "") + (v?.stderr ?? "")).trim();
  const first = out.split("\n")[0] ?? "";
  if (v === null || v.exitCode !== 0 || !first) {
    return { name, available: true, path: bin, version: null, note: `${name} 在场但 ${versionFlag.join(" ")} 探活未通过（版本未知，坏安装按缺席降级）` };
  }
  return { name, available: true, path: bin, version: first.slice(0, 80) };
}

export interface SastEngines {
  ruff: SastEngineProbe;
  bandit: SastEngineProbe;
  semgrep: SastEngineProbe;
  gitleaks: SastEngineProbe;
  /** Python 代码车道决策（ruff > bandit > builtin）。 */
  pyLane: SastEngine;
  /** 密钥横切车道决策（gitleaks > builtin）。 */
  secretsLane: SastEngine;
  /** TS/JS 代码车道决策（恒 builtin —— ruff/bandit 不覆盖；semgrep 增广另计）。 */
  tsLane: SastEngine;
  /** semgrep 增广车道是否接通（在场 + ORG_SEMGREP_CONFIG）。 */
  semgrepLane: boolean;
  /** 缺席引擎的诚实说明（人读）。 */
  notes: string[];
}

/** 探测四引擎 + 车道决策（探测零副作用：不扫文件）。 */
export function probeSastEngines(): SastEngines {
  const ruff = probeOne("ruff", ["--version"]);
  const bandit = probeOne("bandit", ["--version"]);
  const semgrep = probeOne("semgrep", ["--version"]);
  const gitleaks = probeOne("gitleaks", ["version"]);
  const semgrepCfg = (process.env.ORG_SEMGREP_CONFIG || "").trim();
  const notes: string[] = [];
  for (const e of [ruff, bandit, semgrep, gitleaks]) {
    if (!e.available) notes.push(`${e.name} 缺席 —— ${e.note ?? ""}`);
  }
  if (semgrep.available && !semgrepCfg) {
    notes.push("semgrep 在场但 ORG_SEMGREP_CONFIG 未设 —— 增广车道未接通（不自动拉注册表，零外联铁律）");
  }
  return {
    ruff, bandit, semgrep, gitleaks,
    pyLane: ruff.available ? "ruff" : bandit.available ? "bandit" : "builtin",
    secretsLane: gitleaks.available ? "gitleaks" : "builtin",
    tsLane: "builtin",
    semgrepLane: semgrep.available && semgrepCfg.length > 0 && fs.existsSync(semgrepCfg),
    notes,
  };
}

// ---- 内置规则引擎（降级兜底 —— 纯 TS 行级 regex） -----------------------------

export type SastRuleFamily = "secret" | "injection" | "sql" | "shell" | "random";
export type SastLang = "py" | "ts";

export interface SastRule {
  id: string;
  name: string;
  family: SastRuleFamily;
  severity: SastSeverity;
  langs: SastLang[];
  description: string;
  hint: string;
}

/** 内置规则目录（CLI/Web 面板直接渲染）。 */
export const SAST_RULES: SastRule[] = [
  {
    id: "builtin-hardcoded-secret",
    name: "硬编码密钥（值形状：sk-/ghp_/AKIA）",
    family: "secret",
    severity: "high",
    langs: ["py", "ts"],
    description: "源码里出现 API 密钥值形状（sk-ant-/sk- 前缀、ghp_ 家族、AWS AKIA/ASIA 访问键）—— 任何拿到代码的人都能直接用。",
    hint: "密钥走环境变量/secret manager 注入；已泄露的立即轮换。与 lib/scan.ts 的 18 类密钥扫描同族（此处按值形状钉 SAST 面）。",
  },
  {
    id: "builtin-eval-exec",
    name: "eval/exec/new Function 动态执行",
    family: "injection",
    severity: "high",
    langs: ["py", "ts"],
    description: "动态执行用户可控字符串（py: eval/exec；ts: eval/new Function）—— 经典 RCE 注入面。",
    hint: "改用受控解析器（JSON.parse / ast.literal_eval）或显式白名单派发，绝不 eval 任意输入。",
  },
  {
    id: "builtin-sql-concat",
    name: "SQL 字符串拼接",
    family: "sql",
    severity: "high",
    langs: ["py", "ts"],
    description: "SQL 语句由字符串拼接/模板插值/f-string 构造（引号串 + 变量 / ${var} 插值 / f-string）—— SQL 注入向量。",
    hint: "参数化查询（占位符 ?/$1/prepared statement），值永不进 SQL 文本。",
  },
  {
    id: "builtin-shell-concat",
    name: "shell 命令拼接",
    family: "shell",
    severity: "high",
    langs: ["py", "ts"],
    description: "shell 命令由拼接/插值构造（os.system 拼接 / execSync 模板插值 / subprocess shell=True）—— 命令注入向量。",
    hint: "数组参数 spawn（execFile/spawn 带 args 数组，shell:false），文件名等参数永不拼进命令字符串。",
  },
  {
    id: "builtin-weak-random",
    name: "弱随机做凭据（Math.random/random.random）",
    family: "random",
    severity: "medium",
    langs: ["py", "ts"],
    description: "token/password/secret/key/session/nonce 语境使用非密码学随机（Math.random / random.random/randint）—— 可预测凭据。",
    hint: "密码学随机：py 用 secrets（secrets.token_hex）/ ts 用 crypto.randomUUID() 或 crypto.randomBytes。",
  },
];

const RULE_BY_ID = new Map(SAST_RULES.map((r) => [r.id, r]));

// 密钥值形状（与 iacscan.ts DOCKER_ENV_SECRET_RE 同族）
const SECRET_VALUE_RE =
  /sk-ant-[A-Za-z0-9-]{24,}|sk-(?!ant-)[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{36,40}|(?:AKIA|ASIA)[0-9A-Z]{16}/;

/** 注释行跳过（整行注释；行内尾注释不剥离 —— 诚实边界，见文件头）。 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

const SQL_KW = /\b(?:SELECT|INSERT|INTO|UPDATE|DELETE|DROP)\b/;

/** 语境窗口关键词（弱随机判定的上下文线索）。 */
const CREDENTIAL_CTX_RE = /token|password|passwd|secret|api[_-]?key|session|otp|nonce|salt|credential/i;

function pushFinding(out: SastFinding[], f: SastFinding): void {
  out.push(f);
}

/** 内置引擎：单文件扫描（行级规则 + 弱随机 3 行语境窗口）。 */
export function scanTextBuiltin(text: string, file: string, lang: SastLang, families: SastRuleFamily[] = ["secret", "injection", "sql", "shell", "random"]): SastFinding[] {
  const out: SastFinding[] = [];
  const lines = text.split(/\r?\n/);
  const want = (family: SastRuleFamily): boolean => families.includes(family);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    // ① 密钥值形状（横切车道：gitleaks 缺席时的兜底；有 gitleaks 时本规则仍跑 —— 值形状与 gitleaks 规则面互补，重复命中按 file+line+rule 去重）
    if (want("secret") && SECRET_VALUE_RE.test(line)) {
      pushFinding(out, { file, line: i + 1, rule: "builtin-hardcoded-secret", severity: "high", engine: "builtin", message: "硬编码密钥（sk-/ghp_/AKIA 值形状）—— 密钥进了源码" });
    }
    // ② eval/exec 注入
    if (want("injection")) {
      if (lang === "py" && /\b(?:eval|exec)\s*\(/.test(line)) {
        pushFinding(out, { file, line: i + 1, rule: "builtin-eval-exec", severity: "high", engine: "builtin", message: "eval/exec 动态执行 —— 任意代码执行注入面" });
      }
      if (lang === "ts" && (/\beval\s*\(/.test(line) || /new\s+Function\s*\(/.test(line))) {
        pushFinding(out, { file, line: i + 1, rule: "builtin-eval-exec", severity: "high", engine: "builtin", message: "eval/new Function 动态执行 —— 任意代码执行注入面" });
      }
    }
    // ③ SQL 字符串拼接（引号串含 SQL 关键词 + 拼接/插值/f 前缀/% 格式化）
    if (want("sql")) {
      if (lang === "py") {
        if ((/"[^"]*"|'[^']*'/.test(line) && SQL_KW.test(line)) &&
          (/\+\s*\w/.test(line) || /f["']/.test(line) || /["']\s*%/.test(line))) {
          pushFinding(out, { file, line: i + 1, rule: "builtin-sql-concat", severity: "high", engine: "builtin", message: "SQL 由字符串拼接/f-string 构造 —— SQL 注入向量" });
        }
      } else {
        if ((SQL_KW.test(line)) && (/"[^"]*"\s*\+|'[^']*'\s*\+/.test(line) || /`[^`]*\$\{/.test(line))) {
          pushFinding(out, { file, line: i + 1, rule: "builtin-sql-concat", severity: "high", engine: "builtin", message: "SQL 由字符串拼接/模板插值构造 —— SQL 注入向量" });
        }
      }
    }
    // ④ shell 命令拼接
    if (want("shell")) {
      if (lang === "py") {
        if (/os\.system\s*\(/.test(line) && (/["']\s*\+/.test(line) || /f["']/.test(line))) {
          pushFinding(out, { file, line: i + 1, rule: "builtin-shell-concat", severity: "high", engine: "builtin", message: "os.system 命令拼接/f-string —— 命令注入向量" });
        }
        if (/subprocess\.\w+\s*\([^)]*shell\s*=\s*True/.test(line)) {
          pushFinding(out, { file, line: i + 1, rule: "builtin-shell-concat", severity: "high", engine: "builtin", message: "subprocess shell=True —— shell 注入面（应数组参数 + shell=False）" });
        }
      } else {
        if (/\b(?:execSync|exec|spawnSync|spawn)\s*\(/.test(line) && (/`[^`]*\$\{/.test(line) || /["']\s*\+\s*\w/.test(line))) {
          pushFinding(out, { file, line: i + 1, rule: "builtin-shell-concat", severity: "high", engine: "builtin", message: "exec/spawn 命令由模板插值/拼接构造 —— 命令注入向量" });
        }
      }
    }
    // ⑤ 弱随机做凭据（3 行语境窗口：本行或前三行含凭据语境词）
    if (want("random")) {
      const used = lang === "py" ? /random\.(?:random|randint|choice|uniform)\s*\(/.test(line) : /Math\.random\s*\(\s*\)/.test(line);
      if (used) {
        const ctx = lines.slice(Math.max(0, i - 3), i + 1).join(" ");
        if (CREDENTIAL_CTX_RE.test(ctx)) {
          pushFinding(out, { file, line: i + 1, rule: "builtin-weak-random", severity: "medium", engine: "builtin", message: `${lang === "py" ? "random.*" : "Math.random()"} 用于凭据语境（${CREDENTIAL_CTX_RE.exec(ctx)?.[0] ?? "token"}）—— 非密码学随机可预测` });
        }
      }
    }
  }
  return out;
}

// ---- 外部引擎车道 ------------------------------------------------------------

export interface SastFinding {
  /** 工作区相对路径（正斜杠）。 */
  file: string;
  /** 行号（1 基）。 */
  line: number;
  /** 规则 id：内置 builtin-* 或引擎码 ruff:S307 / bandit:B602 / gitleaks:generic-api-key / semgrep:<check_id>。 */
  rule: string;
  severity: SastSeverity;
  engine: SastEngine;
  message: string;
}

/** ruff S 码 → severity（未知码缺省 medium）。 */
function ruffSeverity(code: string): SastSeverity {
  if (/^S(10[25]|30[12]|506|60[125789]|61[02])/.test(code)) return "high";
  if (/^S(3\d\d|11)/.test(code)) return "medium";
  if (/^S101/.test(code)) return "low";
  return "medium";
}

/** ruff 车道：check --select S --output-format json（exit 1 = 有诊断，属正常）。 */
function runRuff(ruffPath: string, absPyFiles: string[]): { findings: SastFinding[]; error?: string } {
  const r = spawnCaptured([ruffPath, "check", "--select", "S", "--output-format", "json", ...absPyFiles], 60_000);
  if (r === null) return { findings: [], error: "ruff 执行失败/超时（60s）—— 降级内置规则" };
  let diags: unknown;
  try {
    diags = JSON.parse(r.stdout || "[]");
  } catch {
    return { findings: [], error: `ruff JSON 输出不可解析（exit ${r.exitCode}）—— 降级内置规则` };
  }
  if (!Array.isArray(diags)) return { findings: [], error: "ruff 输出形状异常 —— 降级内置规则" };
  const findings: SastFinding[] = [];
  for (const d of diags as Array<Record<string, unknown>>) {
    const code = String(d.code ?? "");
    if (!code.startsWith("S")) continue; // 只取 S（bandit 家族）码 —— lint 噪声不进 SAST 面
    const loc = d.location as { row?: number } | null;
    findings.push({
      file: String(d.filename ?? ""),
      line: Number(loc?.row ?? 1),
      rule: `ruff:${code}`,
      severity: ruffSeverity(code),
      engine: "ruff",
      message: String(d.message ?? code),
    });
  }
  return { findings };
}

/** bandit 车道：-f json -q（ruff 缺席时的 Python 第二引擎）。 */
function runBandit(banditPath: string, absPyFiles: string[]): { findings: SastFinding[]; error?: string } {
  const r = spawnCaptured([banditPath, "-f", "json", "-q", ...absPyFiles], 60_000);
  if (r === null) return { findings: [], error: "bandit 执行失败/超时（60s）—— 降级内置规则" };
  let doc: { results?: Array<Record<string, unknown>> };
  try {
    doc = JSON.parse(r.stdout || "{}");
  } catch {
    return { findings: [], error: `bandit JSON 输出不可解析（exit ${r.exitCode}）—— 降级内置规则` };
  }
  const findings: SastFinding[] = [];
  for (const d of doc.results ?? []) {
    const sev = String(d.issue_severity ?? "").toLowerCase();
    findings.push({
      file: String(d.filename ?? ""),
      line: Number(d.line_number ?? 1),
      rule: `bandit:${String(d.test_id ?? "B")}`,
      severity: sev === "high" ? "high" : sev === "medium" ? "medium" : "low",
      engine: "bandit",
      message: String(d.issue_text ?? ""),
    });
  }
  return { findings };
}

/** gitleaks 车道：detect --no-git 全文件面（报告写临时文件再读回）。 */
function runGitleaks(gitleaksPath: string, ws: string, absFiles: string[]): { findings: SastFinding[]; error?: string } {
  const tmp = path.join(os.tmpdir(), `org-gitleaks-${Date.now()}.json`);
  const r = spawnCaptured([gitleaksPath, "detect", "--no-git", "--report-format", "json", "--report-path", tmp, ...absFiles.map((f) => path.relative(ws, f))], 60_000, ws);
  if (r === null) return { findings: [], error: "gitleaks 执行失败/超时（60s）—— 降级内置密钥规则" };
  let arr: Array<Record<string, unknown>> = [];
  try {
    arr = JSON.parse(fs.readFileSync(tmp, "utf-8") || "[]");
  } catch {
    return { findings: [], error: "gitleaks 报告不可读 —— 降级内置密钥规则" };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件清理失败不连坐 */ }
  }
  const findings: SastFinding[] = [];
  for (const d of arr) {
    findings.push({
      file: String(d.File ?? ""),
      line: Number(d.StartLine ?? 1),
      rule: `gitleaks:${String(d.RuleID ?? "secret")}`,
      severity: /key|token|password|secret|credential/i.test(String(d.RuleID ?? "")) ? "high" : "medium",
      engine: "gitleaks",
      message: String(d.Description ?? "疑似密钥泄露"),
    });
  }
  return { findings };
}

/** semgrep 增广车道：需 ORG_SEMGREP_CONFIG 显式本地规则（零外联铁律）。 */
function runSemgrep(semgrepPath: string, cfg: string, ws: string, absFiles: string[]): { findings: SastFinding[]; error?: string } {
  const r = spawnCaptured([semgrepPath, "--config", cfg, "--json", ...absFiles.map((f) => path.relative(ws, f))], 120_000, ws);
  if (r === null) return { findings: [], error: "semgrep 执行失败/超时（120s）" };
  let doc: { results?: Array<Record<string, unknown>> };
  try {
    doc = JSON.parse(r.stdout || "{}");
  } catch {
    return { findings: [], error: "semgrep JSON 输出不可解析" };
  }
  const findings: SastFinding[] = [];
  for (const d of doc.results ?? []) {
    const start = d.start as { line?: number } | undefined;
    const extra = d.extra as { severity?: string; message?: string } | undefined;
    const sev = String(extra?.severity ?? "").toLowerCase();
    findings.push({
      file: String(d.path ?? ""),
      line: Number(start?.line ?? 1),
      rule: `semgrep:${String(d.check_id ?? "rule")}`,
      severity: sev === "error" ? "high" : sev === "warning" ? "medium" : "low",
      engine: "semgrep",
      message: String(extra?.message ?? ""),
    });
  }
  return { findings };
}

// ---- 目标解析（文件 / glob / 目录前缀） ---------------------------------------

const CODE_EXTS = new Set([".py", ".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "runtime", "dist", "spawn", "__pycache__"]);
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 500;
const MAX_DEPTH = 8;

function excludedDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (EXCLUDED_DIRS.has(name)) return true;
  return name.startsWith("out-");
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(4096, buf.length)).includes(0);
}

interface WalkState { files: string[]; truncated: boolean; maxFiles: number }

/** 递归收集代码候选（相对路径正斜杠；符号链接跳过防环）。 */
function walk(ws: string, rel: string, st: WalkState, depth: number): void {
  if (depth > MAX_DEPTH || st.truncated) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rel ? path.join(ws, rel) : ws, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (st.truncated) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (excludedDir(e.name)) continue;
      walk(ws, childRel, st, depth + 1);
    } else if (e.isFile()) {
      if (!CODE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      if (st.files.length >= st.maxFiles) {
        st.truncated = true;
        return;
      }
      st.files.push(childRel);
    }
  }
}

export interface SastReport {
  ok: boolean;
  /** 命中的目标数（展开后文件数计入 files）。 */
  targets: string[];
  /** 展开后的代码文件总数（含跳过者）。 */
  files: number;
  /** 实际进入规则扫描的文件数。 */
  scanned: number;
  findings: SastFinding[];
  /** 按严重度计数。 */
  summary: { high: number; medium: number; low: number };
  engines: SastEngines;
  /** 各车道实际使用的引擎。 */
  lanes: { py: SastEngine; secrets: SastEngine; ts: SastEngine; semgrep: boolean };
  tookMs: number;
  skipped: { binary: number; oversize: number; read: number };
  /** 文件帽触顶（诚实截断标记）。 */
  truncated: boolean;
  /** 目标解析失败（文件不存在/glob 无命中）。 */
  unresolved: string[];
  /** 目标越出工作区监狱（拒绝执行）。 */
  refused: string[];
  /** 引擎降级/失败说明（诚实降级不静默）。 */
  notes: string[];
}

function langOf(rel: string): SastLang {
  return path.extname(rel).toLowerCase() === ".py" ? "py" : "ts";
}

/** glob 命中（Bun.Glob；无通配符时按精确文件/目录前缀/子串三档解析）。 */
function matchTarget(relFiles: string[], target: string): string[] {
  const t = target.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (/[*?[]/.test(t)) {
    const g = new Bun.Glob(t);
    const hit = relFiles.filter((f) => g.match(f) || g.match(path.posix.basename(f)));
    // 目录前缀 + 双星（"src/**" 应命中 src/a.py）
    if (hit.length === 0 && t.endsWith("**")) {
      const dir = t.slice(0, -2).replace(/\/+$/, "");
      return relFiles.filter((f) => f === dir || f.startsWith(dir + "/"));
    }
    return hit;
  }
  if (t === "." || t === "") return relFiles;
  const exact = relFiles.filter((f) => f === t);
  if (exact.length > 0) return exact;
  const dir = t.replace(/\/+$/, "");
  const under = relFiles.filter((f) => f.startsWith(dir + "/"));
  if (under.length > 0) return under;
  return relFiles.filter((f) => f === path.posix.basename(t) || f.includes("/" + t));
}

/** SAST 扫描（缺省全工作区；targets 精确文件/目录/glob；engine:"builtin" 强制
 *  全内置车道 —— 与引擎车道对拍用；engines 可注入探测结果 —— 假引擎车道测试）。
 *  同步实现（CLI/工具环/Web 同形调用）。 */
export function scanSast(ws: string, opts: { targets?: string[]; engine?: "auto" | "builtin"; maxFiles?: number; engines?: SastEngines } = {}): SastReport {
  const t0 = Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const forcedBuiltin = opts.engine === "builtin";
  const engines = opts.engines ?? probeSastEngines();

  // ① 收集代码文件全集（供 glob/目录展开）
  const st: WalkState = { files: [], truncated: false, maxFiles: Math.max(maxFiles, 2000) };
  walk(ws, "", st, 0);

  // ② 目标解析（去重保序 + 监狱过滤）
  const targets = (opts.targets && opts.targets.length > 0 ? opts.targets : ["."]).map((s) => String(s).trim()).filter(Boolean).slice(0, 32);
  const unresolved: string[] = [];
  const refused: string[] = [];
  const picked = new Set<string>();
  for (const t of targets) {
    const hits = matchTarget(st.files, t);
    if (hits.length === 0) {
      // 精确文件路径可能带越界或不存在 —— 诚实分类
      const abs = path.resolve(ws, t);
      if (!inWorkspace(ws, abs)) refused.push(t);
      else unresolved.push(t);
      continue;
    }
    for (const f of hits) {
      const abs = path.join(ws, f);
      if (!inWorkspace(ws, abs)) { refused.push(f); continue; }
      picked.add(f);
    }
  }
  const relFiles = [...picked].sort();

  // ③ 逐文件读取（三重跳过计数不连坐）
  const loaded: Array<{ rel: string; abs: string; text: string; lang: SastLang }> = [];
  const skipped = { binary: 0, oversize: 0, read: 0 };
  for (const rel of relFiles) {
    const abs = path.join(ws, rel);
    try {
      const s = fs.statSync(abs);
      if (!s.isFile()) continue;
      if (s.size > MAX_FILE_BYTES) { skipped.oversize++; continue; }
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) { skipped.binary++; continue; }
      loaded.push({ rel, abs, text: buf.toString("utf-8"), lang: langOf(rel) });
    } catch {
      skipped.read++;
    }
  }

  const pyFiles = loaded.filter((f) => f.lang === "py");
  const tsFiles = loaded.filter((f) => f.lang === "ts");
  const notes: string[] = [...engines.notes];
  const findings: SastFinding[] = [];

  // ④ Python 代码车道：ruff > bandit > 内置
  const pyLane: SastEngine = forcedBuiltin ? "builtin" : engines.pyLane;
  if (pyFiles.length > 0) {
    if (pyLane === "ruff") {
      const r = runRuff(engines.ruff.path!, pyFiles.map((f) => f.abs));
      if (r.error) { notes.push(r.error); findings.push(...pyFiles.flatMap((f) => scanTextBuiltin(f.text, f.rel, "py", ["injection", "sql", "shell", "random"]))); }
      else findings.push(...r.findings.map((f) => ({ ...f, file: toRel(ws, f.file) })));
    } else if (pyLane === "bandit") {
      const r = runBandit(engines.bandit.path!, pyFiles.map((f) => f.abs));
      if (r.error) { notes.push(r.error); findings.push(...pyFiles.flatMap((f) => scanTextBuiltin(f.text, f.rel, "py", ["injection", "sql", "shell", "random"]))); }
      else findings.push(...r.findings.map((f) => ({ ...f, file: toRel(ws, f.file) })));
    } else {
      findings.push(...pyFiles.flatMap((f) => scanTextBuiltin(f.text, f.rel, "py", ["injection", "sql", "shell", "random"])));
    }
  }

  // ⑤ TS/JS 代码车道：内置（ruff/bandit 不覆盖 —— 降级链终点恒为内置）
  findings.push(...tsFiles.flatMap((f) => scanTextBuiltin(f.text, f.rel, "ts", ["injection", "sql", "shell", "random"])));

  // ⑥ 密钥横切车道：gitleaks > 内置（全部文件；值形状与 gitleaks 规则面互补 → 去重）
  const secretsLane: SastEngine = forcedBuiltin ? "builtin" : engines.secretsLane;
  if (secretsLane === "gitleaks") {
    const r = runGitleaks(engines.gitleaks.path!, ws, loaded.map((f) => f.abs));
    if (r.error) {
      notes.push(r.error);
      findings.push(...loaded.flatMap((f) => scanTextBuiltin(f.text, f.rel, f.lang, ["secret"])));
    } else {
      findings.push(...r.findings.map((f) => ({ ...f, file: toRel(ws, f.file) })));
    }
  } else {
    findings.push(...loaded.flatMap((f) => scanTextBuiltin(f.text, f.rel, f.lang, ["secret"])));
  }

  // ⑦ semgrep 增广车道（在场 + ORG_SEMGREP_CONFIG）
  let semgrepOn = false;
  if (!forcedBuiltin && engines.semgrepLane) {
    const cfg = (process.env.ORG_SEMGREP_CONFIG || "").trim();
    const r = runSemgrep(engines.semgrep.path!, cfg, ws, loaded.map((f) => f.abs));
    if (r.error) notes.push(r.error);
    else { semgrepOn = true; findings.push(...r.findings.map((f) => ({ ...f, file: toRel(ws, f.file) }))); }
  }

  // ⑧ 去重（file+line+rule —— 跨车道互补不连坐）+ 排序
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const k = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));

  const summary = {
    high: deduped.filter((f) => f.severity === "high").length,
    medium: deduped.filter((f) => f.severity === "medium").length,
    low: deduped.filter((f) => f.severity === "low").length,
  };
  return {
    ok: true,
    targets,
    files: relFiles.length,
    scanned: loaded.length,
    findings: deduped,
    summary,
    engines,
    lanes: { py: pyLane, secrets: secretsLane, ts: "builtin", semgrep: semgrepOn },
    tookMs: Date.now() - t0,
    skipped,
    truncated: relFiles.length >= maxFiles,
    unresolved,
    refused,
    notes,
  };
}

/** 绝对/任意形 → 工作区相对（越界原样返回 —— 引擎输出的路径归一）。 */
function toRel(ws: string, f: string): string {
  const n = String(f).replace(/\\/g, "/");
  if (!path.isAbsolute(n)) return n;
  return inWorkspace(ws, n) ? n.slice(jailLen(ws)) : n;
}

function jailLen(ws: string): number {
  const w = ws.replace(/\\/g, "/").replace(/\/+$/, "");
  return w.length + 1;
}

/** 配置指引（CLI 帮助）。 */
export function sastGuidance(): string {
  return "SAST 静态分析（#146）：多引擎降级链 ruff --select S → bandit → 内置规则（永远有产出）；gitleaks 密钥横切；semgrep 增广需 ORG_SEMGREP_CONFIG。CLI org sast <path>；Web GET /api/govex/sast。";
}

// 保留 RULE_BY_ID 供未来按 id 查规则（当前导出面未用 —— 防 tree-shake 误删的显式引用）
export const SAST_RULE_BY_ID: ReadonlyMap<string, SastRule> = RULE_BY_ID;
