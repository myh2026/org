// ============================================================================
// lib/remote.ts — 远程 Agent / 云执行统一模块（v0.5.18 · capabilities #133）
// ----------------------------------------------------------------------------
// 一个模块钉住「桌面 Agent 的远程会话层」：远程主机档案（结构化会话状态）、
// 会话级远程执行、文件同步、心跳延迟、远程 Agent 部署计划器。CLI（org remote）、
// 工具环（remote_* 四工具）、Web（🛡 govex 🛰 远程 Agent 区块）三端同源消费
// —— 单一实现防口径漂移（v0.5.17 cloud/collab 模块的接线延续）。
//
// 与 lib/cloud.ts #68 cloud_ssh 的关系（互补而非重复）：
//   · cloud_ssh = **单命令执行**：host 白名单是 <ws>/ssh-hosts.allow 纯文本文件
//     （每行一个 host，无会话状态），一次一发，无用户/端口/密钥档案；
//   · remote_*  = **会话/部署/计划层**：本模块用 <ws>/remote-hosts.json 结构化
//     主机档案（name→host/user/port/identity 四元组），在 cloud_ssh 之上补齐
//     「这台机器是谁、怎么连、部署成什么」的会话层 —— 执行、同步、心跳、
//     部署计划都从档案取连接参数，host 不在档案 = 拒绝（不猜默认）。
//   两套门控刻意并存：ssh-hosts.allow 管「一次性命令的 host 放行」，
//   remote-hosts.json 管「会话化操作的连接档案」—— 哲学同源（缺席 = 拒绝），
//   粒度不同。
//
// 设计灵魂 = 多重优雅降级（每层缺席或越界 → 指引或拒绝，绝不假装成功）：
//   ① 探测层 probeRemote：ssh/scp/rsync/ssh-keygen 四工具 which 定位 + OpenSSH
//      版本解析 + ssh-agent 转发环境（SSH_AUTH_SOCK）—— 存在 ≠ 可用；
//   ② 档案层 loadRemoteHosts/saveRemoteHosts：结构化主机档案 + 诚实校验
//      （坏 JSON / 缺字段 / 私钥内容混入 / 密码字段 = 拒绝）；
//   ③ 执行层 remoteExec/remoteSync/remotePing：命令白名单默认只读
//      （echo/uname/df/free/which/ps/cat/uptime/whoami），非白名单须
//      allow_full=true 显式开启（呼应 RBAC 门控哲学）；rsync → scp →
//      指引三层降级；失败三分类（超时 / 拒连 / 鉴权）；
//   ④ 计划层 remoteDeployPlan：纯函数保底车道 —— 目标机摸底 → 部署三式
//      （git clone / rsync 工作区 / 容器）→ run 队列远程化 → 回滚步骤，
//      每步命令 + 预期 + 降级指引。无真远程机的环境交付的仍是可用产物。
//
// 安全铁律：
//   · 私钥内容绝不入档案/账本/日志：档案校验扫描 -----BEGIN … PRIVATE KEY-----
//     形态与 password/passphrase 类字段，命中即拒（identity 只允许**路径**）；
//   · 零 shell 注入面：所有外部命令走 Bun.spawnSync 数组参数；用户输入永远
//     是 argv 的一个元素；白名单车道追加拒绝 shell 元字符（; & | ` $ ( ) 等
//     —— 白名单只读命令本就不需要它们，出现即注入形态）；
//   · host 须在档案：不在档案的 host 一律拒绝 + 创建指引，绝不猜默认主机；
//   · 路径监狱：remoteSync 的 local（upload 源 / download 目标）全过
//     lib/pathjail.ts（v0.5.16.1 跨平台比较形单点收敛）；远端路径拒绝
//     shell 元字符与 - 开头（防远端解释面）；
//   · 密码永不入账：BatchMode=yes —— 密码认证在 ssh 语义上就会失败，档案
//     模型里根本没有密码的位置。
//
// 诚实边界：
//   · 沙箱/CI 无真远程机 —— 探测/档案/白名单/降级链/参数构造/输出解析全部
//     真实可测（tests/remote.test.ts 用假 ssh/rsync 脚本注入 PATH 锁形态，
//     不锁次序），真实远程执行代码路径完整但无真机可实测；
//   · 多路复用长连接（ControlMaster / ConnectionMultiplexing）是路线图 ——
//     本模块每发命令一次 ssh 会话（与 cloud_ssh 同语义）；
//   · 远端命令串由远端登录 shell 解释（ssh 语义本身）：白名单车道用元字符
//     拒绝 + 只读命令封住破坏面，allow_full 车道由调用方对命令内容负责。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inWorkspace, resolveInWorkspace } from "./pathjail.ts";
import { whichTool } from "./cloud.ts"; // 单一实现：PATH 扫描定位器（win32 兼容 .exe；读运行期 PATH —— 可测性）

// ---- 预算与常量 ---------------------------------------------------------------

/** 版本探活超时（坏安装快速降级）。 */
const PROBE_TIMEOUT_MS = 5_000;
/** 执行车道缺省硬超时（ssh/rsync/scp 30s）。 */
const RUN_DEFAULT_TIMEOUT_MS = 30_000;
/** 超时上限（调用方可放宽，但不超过此帽）。 */
const RUN_MAX_TIMEOUT_MS = 5 * 60_000;
/** stdout/stderr 捕获帽（结果面回传 CLI/Web/工具环的载荷保护）。 */
const OUTPUT_CAP = 64 * 1024;
/** ping 缺省轮数。 */
const PING_DEFAULT_ROUNDS = 4;
/** ping 轮数上限（防探测风暴）。 */
const PING_MAX_ROUNDS = 10;

/** #133 远程主机档案文件（工作区相对；结构化会话层 —— 与 cloud_ssh 的
 * ssh-hosts.allow 纯文本白名单互补：allow 管单命令放行，档案管连接参数）。 */
export const REMOTE_HOSTS_FILE = "remote-hosts.json";

/** ssh 安全旗标（BatchMode 免交互挂死 + ConnectTimeout=8 + 首连指纹确认；
 * 与 cloud.ts SSH_SAFE_FLAGS 同哲学，ConnectTimeout 取会话层更紧的 8s）。 */
const REMOTE_SSH_FLAGS: readonly string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];

/** 只读命令白名单（默认车道 —— 呼应 RBAC 门控哲学：读 = Auto，写/执行 = 显式开启）。 */
export const REMOTE_READONLY_COMMANDS: readonly string[] = [
  "echo", "uname", "df", "free", "which", "ps", "cat", "uptime", "whoami",
];

/** 白名单车道拒绝的 shell 元字符（远端登录 shell 的解释面 —— 只读简单命令
 * 本就不需要它们，出现即注入形态；需要时走 allow_full 显式车道）。 */
const SHELL_METACHARS = /[\n\r;&|`$()<>\\'"]/;

// ---- 执行车道统一结果面 ---------------------------------------------------------

export type RemoteRunKind =
  | "denied"           // 白名单外命令 / 参数形态拒绝（未 spawn）
  | "host-not-found"   // host 不在 remote-hosts.json 档案（不猜默认）
  | "jail"             // local 路径越工作区监狱（sync 车道）
  | "tool-absent"      // ssh/rsync/scp 缺席（附安装指引 + 计划车道指引）
  | "timeout"          // 硬超时（三类失败之一）
  | "refused"          // 拒连/不可达/DNS 解析失败（三类失败之二）
  | "auth"             // 鉴权失败/指纹漂移（三类失败之三）
  | "failed";          // 执行了但退出码非 0（未分类）

export interface RemoteRunResult {
  ok: boolean;
  /** 失败分类（ok:true 时缺席）。 */
  kind?: RemoteRunKind;
  /** 实际 argv（观测面 —— 数组形态本身就是「无 shell 拼接」的证明）。 */
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 人读失败原因 / 成功说明（含降级指引）。 */
  reason?: string;
  tookMs: number;
}

/** 拒绝先于探测先于 spawn（与 cloud.ts deny 同款）。 */
function deny(argvTail: string[], reason: string, bin: string): RemoteRunResult {
  return { ok: false, kind: "denied", argv: [bin, ...argvTail], exitCode: null, stdout: "", stderr: "", reason, tookMs: 0 };
}

/** 数组参数 spawn（零 shell 注入面）+ 硬超时 + 输出帽。失败降级为 null（不 throw）。
 * env 显式传 process.env：Bun.spawnSync 缺省传「进程启动时的环境快照」，
 * 运行时对 process.env 的修改（测试注入的 PATH/FAKE_*）不会进子进程 ——
 * 显式引用让运行期环境（含 tests 的假 bin 注入）真实生效。 */
function spawnCaptured(argv: string[], timeoutMs: number): { exitCode: number | null; stdout: string; stderr: string } | null {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
      env: process.env,
    } as Parameters<typeof Bun.spawnSync>[1]);
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout?.toString() ?? "").slice(0, OUTPUT_CAP),
      stderr: (r.stderr?.toString() ?? "").slice(0, OUTPUT_CAP),
    };
  } catch {
    return null; // 启动失败 / 超时强杀 → 调用方按缺席/失败降级
  }
}

/** 输出首行（版本串提取用）。 */
function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

// ============================================================================
// ① 探测层：probeRemote（ssh/scp/rsync/ssh-keygen + OpenSSH 版本 + agent 环境）
// ============================================================================

export interface RemoteProbe {
  /** ssh CLI 在场且 -V 探活成功。 */
  available: boolean;
  /** ssh -V 原始串（OpenSSH 契约：输出到 stderr 且退出码 0）。 */
  versionRaw: string | null;
  /** 解析后的 OpenSSH 版本（major.minor；非 OpenSSH 形态 → null）。 */
  openSsh: { major: number; minor: number } | null;
  /** scp 在场（rsync 缺席时的同步降级车道）。 */
  scpAvailable: boolean;
  /** rsync 在场（同步主车道）。 */
  rsyncAvailable: boolean;
  /** rsync --version 首行（rsync 有官方版本行格式）。 */
  rsyncVersion: string | null;
  /** ssh-keygen 在场（密钥生成指引的可行性）。 */
  sshKeygenAvailable: boolean;
  /** ssh-agent 转发环境：SSH_AUTH_SOCK 在场（BatchMode 下 agent 密钥可用；
   * **绝不回显 socket 路径值** —— 布尔即安全模型所需全部）。 */
  agentForwarding: boolean;
  /** ssh 缺席 / 探活失败时的人读指引（安装命令 + 降级车道）。 */
  reason?: string;
}

/** 解析 OpenSSH 版本串：`OpenSSH_9.6p1 Ubuntu-…` → { major:9, minor:6 }。
 * 纯函数（remoteSelfTest 锁三形态：标准 p1 / 纯数字 / 非 OpenSSH → null）。 */
export function parseOpenSshVersion(raw: string): { major: number; minor: number } | null {
  const m = String(raw ?? "").match(/OpenSSH[_ ](\d+)\.(\d+)/);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor };
}

/**
 * 探测远程会话工具链全景：ssh（which + -V 探活 + 版本解析）/ scp / rsync
 * （which + --version 探活）/ ssh-keygen（which）+ SSH_AUTH_SOCK agent 转发
 * 环境。工具缺席不是失败 —— reason 给安装指引与降级车道（计划层恒在）。
 */
export function probeRemote(): RemoteProbe {
  const sshBin = whichTool("ssh");
  const scpBin = whichTool("scp");
  const rsyncBin = whichTool("rsync");
  const keygenBin = whichTool("ssh-keygen");
  let versionRaw: string | null = null;
  if (sshBin !== null) {
    const v = spawnCaptured([sshBin, "-V"], PROBE_TIMEOUT_MS);
    // OpenSSH 契约：-V 输出到 stderr 且退出码 0
    if (v !== null && v.exitCode === 0 && firstLine(v.stderr).length > 0) {
      versionRaw = firstLine(v.stderr);
    }
  }
  let rsyncVersion: string | null = null;
  if (rsyncBin !== null) {
    const v = spawnCaptured([rsyncBin, "--version"], PROBE_TIMEOUT_MS);
    if (v !== null && v.exitCode === 0 && firstLine(v.stdout).length > 0) {
      rsyncVersion = firstLine(v.stdout);
    }
  }
  const available = sshBin !== null && versionRaw !== null;
  return {
    available,
    versionRaw,
    openSsh: versionRaw !== null ? parseOpenSshVersion(versionRaw) : null,
    scpAvailable: scpBin !== null,
    rsyncAvailable: rsyncBin !== null,
    rsyncVersion,
    sshKeygenAvailable: keygenBin !== null,
    agentForwarding: Boolean((process.env.SSH_AUTH_SOCK ?? "").trim()),
    ...(available ? {} : {
      reason: sshBin === null
        ? "未找到 ssh CLI。安装：apt install openssh-client / brew install openssh（Windows 用内建 OpenSSH 或 Git for Windows）。降级车道：org remote plan <host>（部署计划纯函数，工具缺席也交付）。"
        : "ssh CLI 存在但 -V 探活失败（坏安装按缺席降级）。降级车道：org remote plan <host>。",
    }),
  };
}

// ============================================================================
// ② 档案层：remote-hosts.json（结构化主机档案 —— 会话层状态）
// ============================================================================

/** 档案条目（identity 是密钥**路径**（可 ~ 开头），绝不含私钥内容；无密码字段 ——
 * BatchMode=yes 下密码认证在 ssh 语义上就会失败，模型里没有密码的位置）。 */
export interface RemoteHostEntry {
  /** 档案名（会话层寻址键 —— org remote exec <name> "cmd"）。 */
  name: string;
  /** 主机名或 IP（不含 user@ 前缀 —— user 独立字段）。 */
  host: string;
  /** 登录用户。 */
  user: string;
  /** 端口（缺省 22）。 */
  port?: number;
  /** 私钥路径（可选 —— 缺席时用 ssh 默认链：agent / ~/.ssh/config / 默认密钥）。 */
  identity?: string;
}

/** 私钥内容形态（PEM/OpenSSH 头）—— 档案任何字段命中即拒。 */
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** 密码类字段黑名单（密码永不入账 —— 档案模型里没有它们的位置）。 */
const BANNED_FIELD_NAMES = /^(password|passwd|passphrase|pass|secret|private_?key|key_?content|credential)s?$/i;

export interface RemoteHostsReport {
  /** 档案文件绝对路径。 */
  file: string;
  /** 档案文件存在。 */
  exists: boolean;
  /** 零错误（坏 JSON / 任何条目校验失败 → false；hosts 只含过检条目）。 */
  ok: boolean;
  /** 过检条目（校验失败的条目被过滤 —— 调用方拿到的 hosts 恒为可用集）。 */
  hosts: RemoteHostEntry[];
  /** 逐条人读错误（诚实降级：不静默吞坏条目）。 */
  errors: string[];
}

/** 单条档案校验（load/save 共用 —— 单一规则源）。返回 null = 过检。 */
function validateRemoteHostEntry(e: unknown, index: number): string | null {
  if (e === null || typeof e !== "object" || Array.isArray(e)) {
    return `第 ${index} 项不是对象`;
  }
  const o = e as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (BANNED_FIELD_NAMES.test(k)) {
      return `第 ${index} 项（${String(o.name ?? "?")}）：字段 "${k}" 不允许 —— 密码/密钥内容永不入档案（identity 只接受路径；BatchMode=yes 下密码认证本就会失败）`;
    }
    const v = o[k];
    if (typeof v === "string" && PRIVATE_KEY_PATTERN.test(v)) {
      return `第 ${index} 项（${String(o.name ?? "?")}）：字段 "${k}" 的值形似私钥内容（-----BEGIN PRIVATE KEY-----）—— 档案绝不存私钥内容，identity 只接受路径`;
    }
  }
  const name = String(o.name ?? "");
  if (name.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return `第 ${index} 项：name 必填（字母/数字/./_/-，≤64 字符，字母数字开头）—— 得到 ${JSON.stringify(name)}`;
  }
  const host = String(o.host ?? "");
  if (host.length === 0 || /[\s]/.test(host) || host.startsWith("-")) {
    return `第 ${index} 项（${name}）：host 必填（非空、无空白、不以 - 开头）—— 得到 ${JSON.stringify(host)}`;
  }
  const user = String(o.user ?? "");
  if (user.length === 0 || /[\s]/.test(user) || user.startsWith("-")) {
    return `第 ${index} 项（${name}）：user 必填（非空、无空白、不以 - 开头）—— 得到 ${JSON.stringify(user)}`;
  }
  if (o.port !== undefined) {
    const p = Number(o.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return `第 ${index} 项（${name}）：port 须为 1-65535 整数 —— 得到 ${JSON.stringify(String(o.port))}`;
    }
  }
  if (o.identity !== undefined && o.identity !== null && String(o.identity).trim().length > 0) {
    const id = String(o.identity);
    if (/[\r\n]/.test(id)) {
      return `第 ${index} 项（${name}）：identity 路径含换行符，拒绝`;
    }
  }
  return null;
}

/**
 * 读取 <ws>/remote-hosts.json 主机档案（诚实校验）：
 *   · 文件缺席 → { exists:false, ok:true, hosts:[] }（空档案不是错误 ——
 *     但任何 host 寻址都会拒绝并附创建指引）；
 *   · 坏 JSON / 非数组 → ok:false + errors（hosts 空）；
 *   · 逐条校验（缺字段/端口越界/私钥内容混入/密码字段）→ 坏条目过滤 +
 *     errors 诚实上浮，过检条目照常可用（部分降级不全体拒绝）。
 */
export function loadRemoteHosts(ws: string): RemoteHostsReport {
  const file = path.join(ws, REMOTE_HOSTS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { file, exists: false, ok: true, hosts: [], errors: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { file, exists: true, ok: false, hosts: [], errors: [`remote-hosts.json 不是合法 JSON：${(e as Error).message}`] };
  }
  if (!Array.isArray(parsed)) {
    return { file, exists: true, ok: false, hosts: [], errors: [`remote-hosts.json 顶层须为数组（每项 {name, host, user, port?, identity?}）—— 得到 ${typeof parsed}`] };
  }
  const hosts: RemoteHostEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, e] of parsed.entries()) {
    const err = validateRemoteHostEntry(e, i);
    if (err !== null) { errors.push(err); continue; }
    const o = e as RemoteHostEntry;
    if (seen.has(o.name)) {
      errors.push(`第 ${i} 项：name "${o.name}" 重复（档案名是寻址键，必须唯一）`);
      continue;
    }
    seen.add(o.name);
    hosts.push({
      name: o.name, host: o.host, user: o.user,
      ...(Number.isInteger(o.port) ? { port: o.port } : {}),
      ...(typeof o.identity === "string" && o.identity.trim().length > 0 ? { identity: o.identity } : {}),
    });
  }
  return { file, exists: true, ok: errors.length === 0, hosts, errors };
}

/** 档案创建指引（host-not-found 拒绝时统一附带 —— 缺席 = 拒绝一切远程会话操作）。 */
export const REMOTE_HOSTS_GUIDANCE =
  `在 <工作区>/${REMOTE_HOSTS_FILE} 写入主机档案（JSON 数组，每项 {name, host, user, port?, identity?}），例如：\n` +
  `  [\n    { "name": "deploy", "host": "deploy.example.com", "user": "deploy", "port": 22,\n      "identity": "~/.ssh/id_ed25519_deploy" }\n  ]\n` +
  `identity 只接受密钥**路径**（私钥内容/密码字段会被校验拒绝 —— 永不入档案）。创建后 org remote exec deploy "uptime" 即可。`;

/**
 * 保存主机档案（写前全量校验 —— 任何一条不过检即拒绝写盘，绝不落半档）。
 * 校验规则与 loadRemoteHosts 同源（validateRemoteHostEntry 单一规则源）。
 */
export function saveRemoteHosts(ws: string, hosts: unknown): { ok: boolean; file: string; errors: string[] } {
  const file = path.join(ws, REMOTE_HOSTS_FILE);
  if (!Array.isArray(hosts)) {
    return { ok: false, file, errors: [`顶层须为数组（每项 {name, host, user, port?, identity?}）—— 得到 ${typeof hosts}`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, e] of hosts.entries()) {
    const err = validateRemoteHostEntry(e, i);
    if (err !== null) { errors.push(err); continue; }
    const name = (e as RemoteHostEntry).name;
    if (seen.has(name)) errors.push(`第 ${i} 项：name "${name}" 重复`);
    seen.add(name);
  }
  if (errors.length > 0) return { ok: false, file, errors };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hosts, null, 2) + "\n", "utf-8");
  return { ok: true, file, errors: [] };
}

/**
 * 按档案名寻址（name 精确匹配优先；name 不中且与某条 host 字段精确相等且
 * 唯一时兜底 —— 两条通道都是**精确匹配**，绝不前缀猜测）。找不到 → entry:null
 * + 可用名列表（诚实指引）。
 */
export function findRemoteHost(ws: string, name: string): { entry: RemoteHostEntry | null; report: RemoteHostsReport; by: "name" | "host" | null } {
  const report = loadRemoteHosts(ws);
  const wanted = String(name ?? "").trim();
  if (wanted.length > 0) {
    const byName = report.hosts.find((h) => h.name === wanted);
    if (byName !== undefined) return { entry: byName, report, by: "name" };
    const byHost = report.hosts.filter((h) => h.host === wanted);
    if (byHost.length === 1) return { entry: byHost[0]!, report, by: "host" };
  }
  return { entry: null, report, by: null };
}

// ============================================================================
// ③ 执行层：remoteExec / remoteSync / remotePing（白名单 + 三层降级 + 三类诊断）
// ============================================================================

/** 私钥路径展开（~/ 前缀 → home；spawn 需要绝对/可解析路径）。 */
function expandIdentity(identity: string): string {
  if (identity.startsWith("~/") || identity === "~") {
    return path.join(os.homedir(), identity.slice(1));
  }
  return identity;
}

/** ssh argv 构造（纯函数面 —— tests 断言 BatchMode/ConnectTimeout/accept-new/
 * -p/-i 形态在 args 里，次序不锁死）。`--` 分隔后接远端命令。 */
export function remoteArgv(entry: Pick<RemoteHostEntry, "user" | "host" | "port" | "identity">, command: string): string[] {
  const argv: string[] = ["ssh", ...REMOTE_SSH_FLAGS, "-p", String(entry.port ?? 22)];
  if (typeof entry.identity === "string" && entry.identity.trim().length > 0) {
    argv.push("-i", expandIdentity(entry.identity));
  }
  argv.push(`${entry.user}@${entry.host}`, "--", String(command));
  return argv;
}

/** rsync 的 -e 远端 shell 参数（单 argv 元素 —— rsync 语义：作为远端 shell 命令串）。 */
function rsyncShellArg(entry: RemoteHostEntry): string {
  const parts = ["ssh", ...REMOTE_SSH_FLAGS, "-p", String(entry.port ?? 22)];
  if (typeof entry.identity === "string" && entry.identity.trim().length > 0) {
    parts.push("-i", expandIdentity(entry.identity));
  }
  return parts.join(" ");
}

/**
 * 只读命令白名单判定（纯函数）：
 *   · 空命令 / 含换行 → 拒（注入形态）；
 *   · 含 shell 元字符（; & | ` $ ( ) < > \\ ' "）→ 拒（白名单只读简单命令
 *     本就不需要它们 —— 需要时 allow_full 显式开启，由调用方对命令内容负责）；
 *   · 首 token ∈ REMOTE_READONLY_COMMANDS → 放行；
 *   · 其余（非白名单首词）→ 拒（allow_full 指引）。
 */
export function remoteCommandAllowed(command: string): { allowed: boolean; first: string; reason?: string } {
  const cmd = String(command ?? "").trim();
  if (cmd.length === 0) return { allowed: false, first: "", reason: "command 为空" };
  if (/[\r\n]/.test(cmd)) return { allowed: false, first: "", reason: "command 含换行符（多命令注入形态），拒绝执行" };
  if (SHELL_METACHARS.test(cmd)) {
    return { allowed: false, first: cmd.split(/\s+/)[0] ?? "", reason: `command 含 shell 元字符（; & | $ ( ) 等）—— 只读白名单车道仅允许简单命令形态；确需元字符请 allow_full=true 显式开启（由调用方对命令内容负责）` };
  }
  const first = cmd.split(/\s+/)[0] ?? "";
  if (!REMOTE_READONLY_COMMANDS.includes(first)) {
    return { allowed: false, first, reason: `命令 "${first}" 不在只读白名单内（允许：${REMOTE_READONLY_COMMANDS.join("/")}）。非只读命令须 allow_full=true 显式开启（RBAC 门控哲学：读 = 缺省，执行 = 显式）` };
  }
  return { allowed: true, first };
}

/** ssh 失败三类诊断（超时 / 拒连 / 鉴权 —— 纯函数，selfTest 锁分类形态）。 */
export function diagnoseSshFailure(stderr: string, exitCode: number | null): Exclude<RemoteRunKind, "denied" | "host-not-found" | "jail" | "tool-absent" | "failed"> {
  const se = String(stderr ?? "");
  if (/refused|no route to host|timed?\s?out|could not resolve|unreachable|reset by peer|network is down/i.test(se)) {
    return "refused";
  }
  if (/permission denied|authentication|publickey|host key verification|REMOTE HOST KEY|has changed|offending/i.test(se)) {
    return "auth";
  }
  return exitCode === null ? "timeout" : "failed";
}

/** host-not-found 拒绝的统一文案（档案指引 + 可用名单）。 */
function hostNotFoundResult(name: string, report: RemoteHostsReport, argvTail: string[], bin: string): RemoteRunResult {
  const names = report.hosts.map((h) => h.name);
  const known = names.length > 0 ? `档案在册：${names.join(" / ")}` : "档案为空（或全部条目未过校验）";
  const errs = report.errors.length > 0 ? `；档案校验错误 ${report.errors.length} 条（org remote hosts 查看）` : "";
  return {
    ok: false, kind: "host-not-found", argv: [bin, ...argvTail], exitCode: null, stdout: "", stderr: "",
    reason: `host "${name}" 不在 ${REMOTE_HOSTS_FILE} 档案内（${known}${errs}）—— 不猜默认主机。${report.exists ? "" : `档案文件不存在（${report.file}）。`}${REMOTE_HOSTS_GUIDANCE}`,
    tookMs: 0,
  };
}

/**
 * remoteExec：会话级远程执行（#133 主车道）。
 *   降级链：白名单拒绝（先于一切）→ host 不在档案（拒绝 + 指引）→ ssh 缺席
 *   （tool-absent + 安装/计划指引）→ 执行失败三类诊断（超时/拒连/鉴权）。
 *   argv 数组参数（零本地 shell 注入面）；缺省 30s 硬超时。
 */
export function remoteExec(ws: string, opts: {
  host: string;
  command: string;
  timeoutMs?: number;
  /** 显式开启全量命令车道（白名单外命令须此旗标 —— RBAC 哲学：执行 = 显式）。 */
  allowFull?: boolean;
}): RemoteRunResult {
  const command = String(opts.command ?? "");
  const allowFull = opts.allowFull === true;
  // 白名单门（拒绝先于档案先于探测先于 spawn —— PATH 置空宇宙下仍返回
  // denied，即「不 spawn」的可测证明）
  if (!allowFull) {
    const gate = remoteCommandAllowed(command);
    if (!gate.allowed) {
      return deny([String(opts.host ?? ""), "--", command], `${gate.reason}。`, "ssh");
    }
  } else if (/[\r\n]/.test(command)) {
    return deny([String(opts.host ?? ""), "--", command], "command 含换行符（多命令注入形态），拒绝执行。", "ssh");
  }
  // 档案门（host 不在档案 = 拒绝，不猜默认）
  const name = String(opts.host ?? "").trim();
  const found = findRemoteHost(ws, name);
  if (found.entry === null) {
    return hostNotFoundResult(name, found.report, [name, "--", command], "ssh");
  }
  const entry = found.entry;
  const bin = whichTool("ssh");
  const argvTemplate = remoteArgv(entry, command);
  if (bin === null) {
    return {
      ok: false, kind: "tool-absent", argv: argvTemplate, exitCode: null, stdout: "", stderr: "",
      reason: "未找到 ssh CLI。安装：apt install openssh-client / brew install openssh（Windows 用内建 OpenSSH 或 Git for Windows）。降级车道：org remote plan（部署计划纯函数，工具缺席也交付）。",
      tookMs: 0,
    };
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const argv = [bin, ...argvTemplate.slice(1)]; // 真实二进制路径 + 同款参数形态
  const t0 = Date.now();
  const r = spawnCaptured(argv, timeoutMs);
  const tookMs = Date.now() - t0;
  if (r === null) {
    return {
      ok: false, kind: "timeout", argv, exitCode: null, stdout: "", stderr: "",
      reason: `ssh ${entry.name}（${entry.user}@${entry.host}:${entry.port ?? 22}）执行失败或超时（>${timeoutMs}ms 硬超时强杀；ConnectTimeout=8 只管 TCP 连接阶段，总帽在 spawn 层）`,
      tookMs,
    };
  }
  if (r.exitCode === 0) {
    return { ok: true, argv, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, tookMs };
  }
  const cls = diagnoseSshFailure(r.stderr, r.exitCode);
  const clsText: Record<string, string> = {
    timeout: "超时", refused: "拒连/不可达（网络层：DNS 解析失败 / 端口不通 / 防火墙）",
    auth: "鉴权失败（密钥未配置或被拒 / 指纹漂移 —— BatchMode=yes 下密码认证必失败，见 org remote plan 的密钥准备段）",
    failed: "执行失败（退出码非 0，未归类）",
  };
  return {
    ok: false, kind: cls, argv, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
    reason: `ssh ${entry.name}（${entry.user}@${entry.host}:${entry.port ?? 22}）${clsText[cls] ?? cls}（退出码 ${r.exitCode}）：${firstLine(r.stderr) || "（stderr 空）"}`,
    tookMs,
  };
}

/** 远端路径校验（拒绝 shell 元字符与 - 开头 —— 远端登录 shell 的解释面）。 */
function remotePathOk(p: string): boolean {
  return p.length > 0 && !p.startsWith("-") && !/[\r\n`;$&|<>]/.test(p);
}

/**
 * remoteSync：文件同步（upload：本地→远端；download：远端→本地）。
 * 三层降级：rsync -avz（主车道）→ scp -r（rsync 缺席）→ 双缺指引（计划车道）。
 * local 路径（upload 源 / download 目标）全过工作区监狱；远端路径过形态校验。
 */
export function remoteSync(ws: string, opts: {
  host: string;
  local: string;
  remote: string;
  direction?: "upload" | "download";
  timeoutMs?: number;
}): RemoteRunResult {
  const direction = opts.direction === "download" ? "download" : "upload";
  const localRaw = String(opts.local ?? "");
  const remote = String(opts.remote ?? "");
  if (!remotePathOk(remote)) {
    return deny([String(opts.host ?? ""), localRaw, remote], `remote 路径含可疑字符、以 - 开头或为空，拒绝执行：${JSON.stringify(remote)}`, direction === "upload" ? "rsync" : "rsync");
  }
  const localAbs = resolveInWorkspace(ws, localRaw);
  if (!inWorkspace(ws, localAbs)) {
    return {
      ok: false, kind: "jail", argv: ["rsync", "-avz", localRaw, remote], exitCode: null, stdout: "", stderr: "",
      reason: `local 路径越界（须在工作区内）：${localRaw}（解析为 ${localAbs}）`,
      tookMs: 0,
    };
  }
  const name = String(opts.host ?? "").trim();
  const found = findRemoteHost(ws, name);
  if (found.entry === null) {
    return hostNotFoundResult(name, found.report, [name, localRaw, remote], "rsync");
  }
  const entry = found.entry;
  const remoteSpec = `${entry.user}@${entry.host}:${remote}`;
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  // ① rsync 主车道：-avz（归档+详细+压缩）+ -e ssh（同款安全旗标 + 档案端口/密钥）
  const rsyncBin = whichTool("rsync");
  if (rsyncBin !== null) {
    const argv = direction === "upload"
      ? [rsyncBin, "-avz", "-e", rsyncShellArg(entry), localAbs, remoteSpec]
      : [rsyncBin, "-avz", "-e", rsyncShellArg(entry), remoteSpec, localAbs];
    const t0 = Date.now();
    const r = spawnCaptured(argv, timeoutMs);
    const tookMs = Date.now() - t0;
    if (r === null) {
      return { ok: false, kind: "timeout", argv, exitCode: null, stdout: "", stderr: "", reason: `rsync ${entry.name} ${direction} 执行失败或超时（>${timeoutMs}ms）`, tookMs };
    }
    return {
      ok: r.exitCode === 0,
      ...(r.exitCode === 0 ? {} : { kind: diagnoseSshFailure(r.stderr, r.exitCode) as RemoteRunKind }),
      argv, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
      ...(r.exitCode === 0 ? {} : { reason: `rsync ${entry.name} ${direction} 退出码 ${r.exitCode}：${firstLine(r.stderr)}` }),
      tookMs,
    };
  }
  // ② scp 降级车道（rsync 缺席 —— -r 支持目录；-P 大写端口）
  const scpBin = whichTool("scp");
  if (scpBin !== null) {
    const scpFlags = [scpBin, ...REMOTE_SSH_FLAGS, "-P", String(entry.port ?? 22)];
    if (typeof entry.identity === "string" && entry.identity.trim().length > 0) {
      scpFlags.push("-i", expandIdentity(entry.identity));
    }
    scpFlags.push("-r");
    const argv = direction === "upload"
      ? [...scpFlags, localAbs, remoteSpec]
      : [...scpFlags, remoteSpec, localAbs];
    const t0 = Date.now();
    const r = spawnCaptured(argv, timeoutMs);
    const tookMs = Date.now() - t0;
    if (r === null) {
      return { ok: false, kind: "timeout", argv, exitCode: null, stdout: "", stderr: "", reason: `scp ${entry.name} ${direction} 执行失败或超时（>${timeoutMs}ms）`, tookMs };
    }
    return {
      ok: r.exitCode === 0,
      ...(r.exitCode === 0 ? {} : { kind: diagnoseSshFailure(r.stderr, r.exitCode) as RemoteRunKind }),
      argv, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
      ...(r.exitCode === 0 ? {} : { reason: `scp ${entry.name} ${direction} 退出码 ${r.exitCode}（rsync 缺席的降级车道）：${firstLine(r.stderr)}` }),
      tookMs,
    };
  }
  // ③ 双缺指引（rsync + scp 都缺席 —— 交付计划车道，不是一句报错）
  return {
    ok: false, kind: "tool-absent",
    argv: ["rsync", "-avz", "-e", rsyncShellArg(entry), direction === "upload" ? localAbs : remoteSpec, direction === "upload" ? remoteSpec : localAbs],
    exitCode: null, stdout: "", stderr: "",
    reason: `rsync 与 scp 均缺席（rsync 主车道 + scp 降级车道都不可用）。安装：apt install openssh-client rsync / brew install openssh rsync。降级车道：org remote plan ${entry.name}（部署计划含手工同步命令序列）。`,
    tookMs: 0,
  };
}

/** ping 统计（纯函数 —— min/avg/max 保留 1 位小数；空数组 → null）。 */
export function computePingStats(timesMs: number[]): { min: number; avg: number; max: number } | null {
  if (timesMs.length === 0) return null;
  const min = Math.min(...timesMs);
  const max = Math.max(...timesMs);
  const avg = timesMs.reduce((a, b) => a + b, 0) / timesMs.length;
  return { min: Math.round(min * 10) / 10, avg: Math.round(avg * 10) / 10, max: Math.round(max * 10) / 10 };
}

export interface RemotePingResult {
  ok: boolean;
  kind?: RemoteRunKind;
  /** 每轮往返毫秒（失败轮缺席 —— failures 计数）。 */
  times: number[];
  /** 三统计（无成功轮 → null）。 */
  stats: { min: number; avg: number; max: number } | null;
  rounds: number;
  failures: number;
  reason?: string;
  argv: string[];
}

/**
 * remotePing：ssh echo 往返计时（min/avg/max 三统计 + 失败轮计数）。
 * 降级链同 remoteExec（白名单固定 echo —— 不接受任意命令；host 须在档案；
 * ssh 缺席 → tool-absent）。rounds 缺省 4、上限 10（防探测风暴）。
 */
export function remotePing(ws: string, opts: { host: string; rounds?: number; timeoutMs?: number }): RemotePingResult {
  const rounds = Math.max(1, Math.min(Math.floor(opts.rounds ?? PING_DEFAULT_ROUNDS) || PING_DEFAULT_ROUNDS, PING_MAX_ROUNDS));
  const name = String(opts.host ?? "").trim();
  const found = findRemoteHost(ws, name);
  if (found.entry === null) {
    const base = hostNotFoundResult(name, found.report, [name, "--", "echo ping"], "ssh");
    return { ok: false, kind: base.kind, times: [], stats: null, rounds, failures: rounds, reason: base.reason, argv: base.argv };
  }
  const entry = found.entry;
  const bin = whichTool("ssh");
  const argvTemplate = remoteArgv(entry, "echo ping");
  if (bin === null) {
    return {
      ok: false, kind: "tool-absent", times: [], stats: null, rounds, failures: rounds,
      reason: "未找到 ssh CLI。安装：apt install openssh-client / brew install openssh。降级车道：org remote plan（部署计划纯函数）。",
      argv: argvTemplate,
    };
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const argv = [bin, ...argvTemplate.slice(1)];
  const times: number[] = [];
  let failures = 0;
  for (let i = 0; i < rounds; i++) {
    const t0 = Date.now();
    const r = spawnCaptured(argv, timeoutMs);
    const took = Date.now() - t0;
    if (r !== null && r.exitCode === 0) times.push(took);
    else failures++;
  }
  const stats = computePingStats(times);
  if (stats === null) {
    return {
      ok: false, kind: "refused", times: [], stats: null, rounds, failures,
      reason: `ssh ${entry.name}（${entry.user}@${entry.host}:${entry.port ?? 22}）${rounds} 轮 echo 全部失败（超时/拒连/鉴权 —— org remote exec ${entry.name} "uptime" 看具体诊断）`,
      argv,
    };
  }
  return {
    ok: true, times, stats, rounds, failures,
    ...(failures > 0 ? { reason: `${failures}/${rounds} 轮失败（部分降级 —— 统计只计成功轮）` } : {}),
    argv,
  };
}

// ============================================================================
// ④ 计划层：remoteDeployPlan（纯函数保底车道 —— 无真远程机环境的主交付）
// ============================================================================

export type RemoteDeployMode = "git" | "rsync" | "container" | "all";

export const REMOTE_DEPLOY_MODES: readonly RemoteDeployMode[] = ["git", "rsync", "container", "all"];

export interface RemotePlanStep {
  /** 可粘贴命令（纯模板 —— 远端/本地按需替换占位符）。 */
  cmd: string;
  /** 说明：做什么 + 预期结果。 */
  note: string;
  /** 降级指引（该步工具缺席/失败时走哪）。 */
  expect?: string;
}

export interface RemoteDeployPlan {
  mode: RemoteDeployMode;
  target: string;
  phases: { title: string; steps: RemotePlanStep[] }[];
}

/**
 * remoteDeployPlan：远程 Agent 部署计划器（纯函数 —— 不 spawn、不读盘、
 * 不依赖任何工具在场；无真远程机的环境里这是主交付车道）。
 *
 * 四段结构（mode 选部署式，all = 三式全列由实施者择一）：
 *   1. 摸底：目标机 bun/git/磁盘/端口 —— 决定部署式的可行性；
 *   2. 部署三式：git clone（可复现，需仓库可达）/ rsync 工作区（免仓库，
 *      直传现场状态）/ 容器（环境一致，需 docker）；
 *   3. run 队列远程化：org web --port + ORG_WEB_HOST=0.0.0.0（容器/远程
 *      场景的既有语义）+ 网关转发模型（XTransformPort：外部网关/云函数把
 *      公网流量转进内网 4600）；
 *   4. 回滚：每式配套的撤销序列（部署前的快照/备份步骤在前置段声明）。
 */
export function remoteDeployPlan(opts: { host?: string; user?: string; mode?: string } = {}): RemoteDeployPlan {
  const mode = (REMOTE_DEPLOY_MODES as readonly string[]).includes(String(opts.mode ?? "all"))
    ? String(opts.mode ?? "all") as RemoteDeployMode
    : "all";
  const host = String(opts.host ?? "").trim() || "<host>";
  const user = String(opts.user ?? "").trim() || "<user>";
  const target = `${user}@${host}`;
  const phases: { title: string; steps: RemotePlanStep[] }[] = [];

  // ---- 段 1：目标机摸底（决定部署式可行性的命令序列）----
  phases.push({
    title: "① 目标机摸底（每条的输出决定部署式取舍）",
    steps: [
      { cmd: `ssh ${target} 'uname -a && cat /etc/os-release | head -2'`, note: "系统与发行版（决定包管理器：apt/dnf/apk/brew）", expect: "Linux x86_64 + Ubuntu/Debian → apt；缺席 ssh 时先 org remote probe 看工具链" },
      { cmd: `ssh ${target} 'bun --version || echo NO_BUN'`, note: "bun 在场性（org 全链路都跑在 bun 上）", expect: "1.x ✓；NO_BUN → 摸底段先装：curl -fsSL https://bun.sh/install | bash" },
      { cmd: `ssh ${target} 'git --version || echo NO_GIT'`, note: "git 在场性（git-clone 式与注册表 git 留痕都依赖）", expect: "2.x ✓；NO_GIT → apt install git / dnf install git" },
      { cmd: `ssh ${target} 'df -h ~ && free -m | head -2'`, note: "磁盘与内存（bun install + 运行时预算：≥1GB 磁盘 / ≥512MB 内存为舒适线）", expect: "不足 → rsync 式可先只传 registry/ 与 hsl/ 精简集" },
      { cmd: `ssh ${target} 'ss -tlnp 2>/dev/null | grep -E ":(4600|4617)" || echo PORTS_FREE'`, note: "端口占用（org web 缺省 4600；示例用 4617）", expect: "PORTS_FREE ✓；被占 → 部署段换 --port" },
    ],
  });

  // ---- 段 2：部署三式（mode 选取；all = 全列，实施者按摸底结果择一）----
  const deployPhases: { key: RemoteDeployMode; title: string; steps: RemotePlanStep[] }[] = [
    {
      key: "git",
      title: "②-A 部署式一：git clone（可复现 —— 仓库可达时的首选）",
      steps: [
        { cmd: `ssh ${target} 'git clone --depth 1 <org仓库URL> ~/org-agent && cd ~/org-agent && bun install --frozen-lockfile'`, note: "浅克隆 + 锁定安装（~30s 级；深度 1 省 hist 体积）", expect: "仓库不可达（私有/内网）→ 改用 ②-B rsync 式直传现场" },
        { cmd: `ssh ${target} 'cd ~/org-agent && git rev-parse HEAD'`, note: "记录部署基线 commit（回滚锚点 —— 记下这个 hash）", expect: "把 hash 存进部署日志（~/org-agent/DEPLOY_BASELINE）" },
        { cmd: `rsync -avz --delete --exclude node_modules --exclude 'demo-run*' <ws>/registry/ ${target}:~/org-agent/demo-ws/registry/`, note: "工作区注册表精传（git 仓库里的代码 + 现场注册表状态拼成完整工作区）", expect: "rsync 缺席 → scp -r（org remote sync 会自动降级）" },
      ],
    },
    {
      key: "rsync",
      title: "②-B 部署式二：rsync 工作区（免仓库 —— 直传现场状态）",
      steps: [
        { cmd: `ssh ${target} 'mkdir -p ~/org-agent'`, note: "目标根目录", expect: "无" },
        { cmd: `rsync -avz --delete --exclude node_modules --exclude 'demo-run*' --exclude '.git' <ws>/ ${target}:~/org-agent/ws/`, note: "整工作区直传（现场注册表/会话账本/记忆原样搬 —— 与 git 式的区别：不依赖仓库可达，所见即所得）", expect: "rsync 缺席 → org remote sync（自动降级 scp -r；双缺走计划车道）" },
        { cmd: `ssh ${target} 'cd ~/org-agent && bun install --frozen-lockfile || bun install --production'`, note: "依赖安装（锁定优先，失败回退生产安装）", expect: "bun 缺席 → 摸底段的安装指引" },
      ],
    },
    {
      key: "container",
      title: "②-C 部署式三：容器（环境一致 —— 目标机有 docker 时）",
      steps: [
        { cmd: `org cloud dockerfile bun > /tmp/Dockerfile.org-agent`, note: "生成生产级 bun 多阶段镜像模板（org 既有车道 —— 多阶段 + 非 root + healthcheck）", expect: "本地 org 在场即可（纯模板生成，无 docker 依赖）" },
        { cmd: `rsync -avz --exclude node_modules --exclude '.git' <ws>/ /tmp/org-agent-ctx/ && cp /tmp/Dockerfile.org-agent /tmp/org-agent-ctx/Dockerfile`, note: "构建上下文组装（工作区 + Dockerfile）", expect: "rsync 缺席 → cp -r 手工组装" },
        { cmd: `rsync -avz /tmp/org-agent-ctx/ ${target}:~/org-agent-ctx/ && ssh ${target} 'cd ~/org-agent-ctx && docker build -t org-agent:1 . && docker run -d --name org-agent --restart unless-stopped -p 4600:8080 -e ORG_WEB_HOST=0.0.0.0 org-agent:1'`, note: "远端构建 + 常驻容器（--restart unless-stopped 掉线自愈；端口映射 4600→容器 8080）", expect: "目标机无 docker → 改用 ②-A/②-B；docker build 失败看 build 段日志" },
        { cmd: `ssh ${target} 'docker ps --filter name=org-agent --format "{{.Status}}"'`, note: "健康观测（healthcheck 生效后 status 会带 (healthy)）", expect: "unhealthy → docker logs org-agent 看运行期错误" },
      ],
    },
  ];
  for (const p of deployPhases) {
    if (mode === "all" || mode === p.key) phases.push({ title: p.title, steps: p.steps });
  }

  // ---- 段 3：run 队列远程化（org web 常驻 + 网关模型）----
  phases.push({
    title: mode === "container" ? "③ run 队列远程化（容器形态：随容器自启）" : "③ run 队列远程化（org web 常驻 + XTransformPort 网关模型）",
    steps: [
      { cmd: `ssh ${target} 'cd ~/org-agent && ORG_WEB_HOST=0.0.0.0 nohup bun cli/org.ts web --port 4600 --workspace demo-ws > ~/org-agent/web.log 2>&1 &'`, note: "org web 常驻（ORG_WEB_HOST=0.0.0.0 是 org 既有语义：容器/远程场景可被网关/内网访问；taskd 执行器内嵌同启）", expect: "nohup 断连不亡；重启自愈 → systemd unit 或容器 --restart" },
      { cmd: `ssh ${target} 'sleep 2 && curl -s http://127.0.0.1:4600/api/status | head -c 200'`, note: "冒烟：/api/status 回 JSON（专家清单 + 会话占用）", expect: "空回 → tail ~/org-agent/web.log；端口被占 → 换 --port 后网关同步改" },
      { cmd: `# XTransformPort 网关模型：公网网关/云函数（或 nginx/caddy）把外部流量转发到 ${host}:4600\n#   例（nginx）：location /org/ { proxy_pass http://${host}:4600/; proxy_set_header Host $host; proxy_buffering off; }\n#   SSE 端点（/api/run-stream、/api/ask-stream）须 proxy_buffering off（流式不被缓冲截断）`, note: "远程 Agent 的对外暴露模型：org web 只听内网，公网经网关转发（与 XTransformPort 的「外部入口 → 内部服务」转发语义同构）；鉴权/证书在网关层收口", expect: "无公网需求 → 跳过（内网直连 host:4600）" },
      { cmd: `org remote ping ${opts.host ?? "<name>"} --rounds 5`, note: "心跳验证（min/avg/max 三统计 —— 部署后的延迟基线入档）", expect: "全失败 → org remote exec <name> \"uptime\" 看三类诊断（超时/拒连/鉴权）" },
    ],
  });

  // ---- 段 4：回滚（每式配套的撤销序列）----
  const rollbackSteps: RemotePlanStep[] = [
    { cmd: `ssh ${target} 'docker rm -f org-agent 2>/dev/null; true'`, note: "容器式回滚（--name 固定名 → 一删即净；镜像保留 org-agent:1 供取证）", expect: "无容器 → 跳过" },
    { cmd: `ssh ${target} 'pkill -f "cli/org.ts web" 2>/dev/null; true'`, note: "进程式回滚（org web 常驻进程停机）", expect: "无进程 → 跳过" },
    { cmd: `ssh ${target} 'mv ~/org-agent ~/org-agent.bak.$(date +%s)'`, note: "目录改名式备份（不 rm —— 保留现场供取证/比对；确认无需后再清）", expect: "git 式有更快的路径：cd ~/org-agent && git checkout <DEPLOY_BASELINE>" },
    { cmd: `# 数据面回滚：工作区注册表/会话账本在部署时未被覆盖式删除（rsync --delete 只对代码目录），如误传 → 从 ~/org-agent.bak.* 拷回`, note: "回滚哲学：先改名后删除，注册表与账本永不 rm 直删", expect: "无" },
  ];
  phases.push({ title: "④ 回滚（部署失败/需要退场时的撤销序列）", steps: rollbackSteps });

  return { mode, target, phases };
}

// ============================================================================
// 自检：remoteSelfTest（纯内存 —— 计划器/解析器/校验器/白名单的锁形检查）
// ============================================================================

export interface RemoteSelfTestReport {
  ok: boolean;
  passed: number;
  total: number;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** remoteSelfTest：计划器多模式 / OpenSSH 版本解析 / 档案校验规则 / 白名单
 * 判定 / ping 统计的纯内存自检（org remote self-test 同款；零 spawn 零落盘）。 */
export function remoteSelfTest(): RemoteSelfTestReport {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  // 1. OpenSSH 版本解析三形态
  const v1 = parseOpenSshVersion("OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13");
  check("版本解析：OpenSSH_9.6p1 → 9.6", v1 !== null && v1.major === 9 && v1.minor === 6);
  const v2 = parseOpenSshVersion("OpenSSH_8.9p1, OpenSSL 3.0.7");
  check("版本解析：OpenSSH_8.9p1 → 8.9", v2 !== null && v2.major === 8 && v2.minor === 9);
  check("版本解析：非 OpenSSH 形态 → null", parseOpenSshVersion("dropbear 2022.83") === null);

  // 2. 档案校验规则（私钥内容混入 / 密码字段 / 缺字段 / 合法条目）
  const badKey = validateRemoteHostEntry({ name: "a", host: "h", user: "u", identity: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAA" }, 0);
  check("档案校验：identity 混入私钥内容 → 拒绝", badKey !== null && badKey.includes("私钥"));
  const badPass = validateRemoteHostEntry({ name: "a", host: "h", user: "u", password: "hunter2" }, 0);
  check("档案校验：password 字段 → 拒绝（密码永不入账）", badPass !== null && badPass.includes("password"));
  const missing = validateRemoteHostEntry({ name: "a", host: "h" }, 0);
  check("档案校验：缺 user → 拒绝", missing !== null && missing.includes("user"));
  check("档案校验：合法条目过检", validateRemoteHostEntry({ name: "deploy", host: "deploy.example.com", user: "deploy", port: 22, identity: "~/.ssh/id_ed25519" }, 0) === null);

  // 3. 白名单判定（只读缺省 + 元字符拒 + allow_full 指引）
  check("白名单：uptime 放行", remoteCommandAllowed("uptime").allowed === true);
  check("白名单：df -h 放行（带参数的只读命令）", remoteCommandAllowed("df -h").allowed === true);
  check("白名单：rm -rf / 拒绝 + allow_full 指引", remoteCommandAllowed("rm -rf /").reason?.includes("allow_full") === true);
  check("白名单：echo x;rm -rf / 元字符拒（注入形态）", remoteCommandAllowed("echo hi;rm -rf /").allowed === false);
  check("白名单：空命令拒", remoteCommandAllowed("").allowed === false);

  // 4. 三类失败诊断
  check("诊断：Connection refused → refused", diagnoseSshFailure("ssh: connect to host x port 22: Connection refused", 255) === "refused");
  check("诊断：Permission denied → auth", diagnoseSshFailure("user@h: Permission denied (publickey).", 255) === "auth");
  check("诊断：host key 漂移 → auth", diagnoseSshFailure("REMOTE HOST IDENTIFICATION HAS CHANGED!", 255) === "auth");
  check("诊断：未归类 → failed", diagnoseSshFailure("some other error", 1) === "failed");

  // 5. 计划器多模式矩阵（纯函数 —— 各模式步数与关键要素）
  for (const m of REMOTE_DEPLOY_MODES) {
    const p = remoteDeployPlan({ host: "deploy.example.com", user: "deploy", mode: m });
    const deployPhaseCount = p.phases.filter((x) => x.title.startsWith("②")).length;
    check(`计划器 mode=${m}：四段结构（all 含三式共 6 段）+ 部署式 ${m === "all" ? 3 : 1} 段`, p.phases.length === (m === "all" ? 6 : 4) && deployPhaseCount === (m === "all" ? 3 : 1));
  }
  const planGit = remoteDeployPlan({ mode: "git" });
  const gitCmds = planGit.phases.flatMap((x) => x.steps.map((s) => s.cmd)).join("\n");
  check("计划器 git 式：git clone + DEPLOY_BASELINE 在列", gitCmds.includes("git clone") && gitCmds.includes("rev-parse"));
  const planC = remoteDeployPlan({ mode: "container" });
  const cCmds = planC.phases.flatMap((x) => x.steps.map((s) => s.cmd)).join("\n");
  check("计划器容器式：docker build + ORG_WEB_HOST 在列", cCmds.includes("docker build") && cCmds.includes("ORG_WEB_HOST"));
  const planR = remoteDeployPlan({ mode: "rsync" });
  check("计划器 rsync 式：--delete 工作区直传在列", planR.phases.flatMap((x) => x.steps.map((s) => s.cmd)).join("\n").includes("rsync -avz --delete"));
  const planRollback = remoteDeployPlan({});
  const rollbackPhase = planRollback.phases.find((x) => x.title.startsWith("④"));
  check("计划器回滚段：改名式备份（不 rm 直删）在列", rollbackPhase !== undefined && rollbackPhase.steps.some((s) => s.cmd.includes("mv ~/org-agent") && s.note.includes("不 rm")));

  // 6. ping 统计（纯函数）
  const st = computePingStats([100, 200, 300]);
  check("ping 统计：[100,200,300] → min 100 / avg 200 / max 300", st !== null && st.min === 100 && st.avg === 200 && st.max === 300);
  check("ping 统计：空数组 → null", computePingStats([]) === null);

  // 7. ssh argv 构造形态（次序不锁死 —— 形态在即可）
  const argv = remoteArgv({ user: "deploy", host: "deploy.example.com", port: 2222, identity: "~/.ssh/id_ed25519" }, "uptime");
  check("ssh argv：BatchMode/ConnectTimeout=8/accept-new/-p/-i/user@host/--/cmd 形态齐全",
    argv.includes("-o") && argv.includes("BatchMode=yes") && argv.includes("ConnectTimeout=8")
    && argv.includes("StrictHostKeyChecking=accept-new") && argv.includes("-p") && argv.includes("2222")
    && argv.includes("-i") && argv.includes("deploy@deploy.example.com") && argv.includes("--") && argv.includes("uptime"));

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
