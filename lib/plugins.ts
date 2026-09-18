// ============================================================================
// lib/plugins.ts — 插件/规则市场：安装·校验·清单（v0.5.16 · capabilities #132）
// ----------------------------------------------------------------------------
// 「市场」的第一性原理是**分发**，不是执行：git 本身就是全球最大的插件市场
// （任意 git 仓库 = 一个市场条目），本模块做安装/校验/清单三件事 —— 把一个
// 本地目录或 git 仓库安全地落到 <ws>/.org/plugins/<name>/，并保证它声明的
// manifest 契约诚实可校验。
//
// ⚠ 安全边界（铁律）：本模块【绝不执行插件代码】。entry 只做「文件存在」
// 校验，permissions 只做「格式」校验 —— 插件的加载与执行是工具环后续接线
// 的事（届时 permissions 与 RBAC 联动：未声明的工具调用一律拒绝）。安装一
// 个插件 ≠ 信任一个插件。
//
// Manifest 契约（<插件目录>/plugin.json）：
//   { name, version, description, entry, permissions: string[] }
//   · name        唯一标识 = 安装目录名（安全字符集，防路径穿越）
//   · version     宽松语义化 x.y.z（可带 -beta.1 后缀）
//   · description 非空（市场列表展示）
//   · entry       相对插件目录的 .ts/.js 入口路径（不得绝对/含 ..）
//   · permissions 形如 ["tool:shell_run"] —— 资源:动作，供 RBAC 联动
//
// 事务性（不留半成品）：所有安装走「staging 中转 → 校验 → 原子 rename 落位」。
// staging 位于插件目录内部（同文件系统，rename 原子），以 .staging-* 命名
// （隐藏目录，pluginList 不列出）；任何一步失败都整体清理 staging，插件目录
// 里要么没有该插件、要么是完整校验通过的插件 —— 不存在装了一半的残骸。
//
// 优雅降级零逃逸：git 缺席 → kind:"tool-absent" + 安装指引；重名 →
// kind:"conflict"；manifest/entry/permissions 校验失败 → kind:"invalid"
//（逐条人读 problems）；源不存在/clone 失败 → kind:"invalid"/"internal"。
// 绝不 throw 穿透。git 子进程 60s 硬超时（超时强杀按失败降级）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

/** 插件根目录（工作区相对；与 .org/CODEOWNERS 同根 —— 工作区级 .org 约定）。 */
export const PLUGINS_DIR_REL = ".org/plugins";
/** manifest 文件名（插件目录内）。 */
export const MANIFEST_FILE = "plugin.json";

/** git clone 硬超时。 */
const GIT_TIMEOUT_MS = 60_000;

// ---- 类型 ---------------------------------------------------------------------

export interface PluginManifest {
  /** 唯一标识 = 安装目录名。 */
  name: string;
  /** 宽松语义化版本（x.y.z[−后缀]）。 */
  version: string;
  /** 市场列表展示用描述。 */
  description: string;
  /** 相对插件目录的入口文件（.ts/.js）。本模块只校验存在，不执行。 */
  entry: string;
  /** 权限声明（"资源:动作"，如 "tool:shell_run"）—— RBAC 联动用。 */
  permissions: string[];
}

export interface PluginInfo {
  /** manifest（不可解析/不合法 → null —— 面板按 broken 渲染）。 */
  manifest: PluginManifest | null;
  /** 插件目录绝对路径。 */
  path: string;
  valid: boolean;
  /** 人读问题清单（合法时为空数组）。 */
  problems: string[];
}

export type PluginInstallResult =
  | { ok: true; name: string; version: string; path: string; warnings: string[] }
  | { ok: false; kind: "conflict" | "invalid" | "tool-absent" | "internal"; error: string };

export type PluginRemoveResult =
  | { ok: true; name: string; path: string }
  | { ok: false; kind: "invalid" | "missing" | "internal"; error: string };

// ---- 校验（纯函数面 —— 市场"预览"用，不安装）-------------------------------------

/** name 允许的字符集（同时是安全的目录名：无斜杠、无 ..、非隐藏开头）。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 宽松语义化版本：x.y.z + 可选预发布后缀。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** 入口文件扩展名（.ts/.js/.mjs/.cjs）。 */
const ENTRY_EXT_RE = /\.(?:ts|js|mjs|cjs)$/;
/** 权限条目：资源:动作（动作侧允许通配 *）。 */
const PERMISSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_*-]*$/;

interface ManifestCheck {
  /** 全部必填项合法才有值。 */
  manifest: PluginManifest | null;
  /** entry 值（格式合法即有 —— 供存在性检查独立于其他字段进行）。 */
  entry: string | null;
  problems: string[];
  warnings: string[];
}

/** 读取并校验目录里的 plugin.json（缺失/坏 JSON/字段不合法 → problems 逐条
 *  人读）。纯只读，无任何副作用 —— pluginValidate 与 pluginInstall 共用。 */
function readManifest(dir: string): ManifestCheck {
  const mf = path.join(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(mf, "utf-8");
  } catch {
    return { manifest: null, entry: null, problems: [`plugin.json 缺失或不可读（${mf}）`], warnings: [] };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return {
      manifest: null,
      entry: null,
      problems: [`plugin.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
    };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { manifest: null, entry: null, problems: ["plugin.json 顶层必须是对象"], warnings: [] };
  }
  const o = obj as Record<string, unknown>;
  const problems: string[] = [];
  const warnings: string[] = [];

  // name（= 安装目录名 —— 字符集即安全边界）
  let name = "";
  if (typeof o.name !== "string" || o.name.length === 0) problems.push("name：必填字符串（插件唯一标识，同时是安装目录名）");
  else if (!NAME_RE.test(o.name) || o.name.includes("..")) problems.push(`name："${o.name}" 不合法（须匹配 ${NAME_RE.source}，且不得含 ".."）`);
  else name = o.name;

  // version（宽松语义化）
  let version = "";
  if (typeof o.version !== "string" || o.version.length === 0) problems.push("version：必填字符串（语义化版本）");
  else if (!VERSION_RE.test(o.version)) problems.push(`version："${o.version}" 不是宽松语义化版本（期望 x.y.z，如 1.2.3，可带 -beta.1 后缀）`);
  else version = o.version;

  // description（市场列表展示）
  let description = "";
  if (typeof o.description !== "string" || o.description.trim().length === 0) problems.push("description：必填非空字符串（市场列表展示）");
  else description = o.description;

  // entry（相对路径 + 扩展名；存在性由调用方按目录检查）
  let entry = "";
  if (typeof o.entry !== "string" || o.entry.length === 0) problems.push("entry：必填字符串（入口 .ts/.js 文件，相对插件目录）");
  else if (path.isAbsolute(o.entry) || o.entry.split(/[\\/]+/).includes("..")) problems.push(`entry："${o.entry}" 必须是相对路径且不得含 ".."`);
  else if (!ENTRY_EXT_RE.test(o.entry)) problems.push(`entry："${o.entry}" 必须以 .ts/.js/.mjs/.cjs 结尾`);
  else entry = o.entry;

  // permissions（数组 + 条目格式）
  let permissions: string[] = [];
  if (!Array.isArray(o.permissions)) {
    problems.push('permissions：必填字符串数组（如 ["tool:shell_run"]，供 RBAC 联动）');
  } else {
    const bad = (o.permissions as unknown[]).filter((p) => typeof p !== "string" || !PERMISSION_RE.test(p));
    if (bad.length > 0) {
      problems.push(`permissions：格式非法的条目 ${JSON.stringify(bad)}（每条形如 "tool:shell_run" —— 冒号分隔 资源:动作）`);
    } else {
      permissions = o.permissions as string[];
      if (permissions.length === 0) {
        warnings.push("permissions 为空数组：插件将不被 RBAC 授予任何工具（确无工具需求可忽略）");
      }
    }
  }

  // 未知字段提醒（信息级 —— 不拒绝，帮助发现拼写错误）
  const known = new Set(["name", "version", "description", "entry", "permissions"]);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) warnings.push(`manifest 含未知字段 "${k}"（当前版本忽略，请核对拼写）`);
  }

  const manifest = problems.length === 0 ? { name, version, description, entry, permissions } : null;
  return { manifest, entry: entry.length > 0 ? entry : null, problems, warnings };
}

/** 常规文件判定（stat 失败/符号链接断裂 → false）。 */
function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 纯校验（市场"预览"）：目录里的 plugin.json + entry 存在性，不安装。 */
export function pluginValidate(dir: string): { valid: boolean; problems: string[] } {
  const ck = readManifest(dir);
  const problems = [...ck.problems];
  if (ck.entry !== null && !isFileSafe(path.join(dir, ck.entry))) {
    problems.push(`entry 指向的文件不存在：${ck.entry}（相对插件目录）`);
  }
  return { valid: problems.length === 0, problems };
}

// ---- git 探测与克隆 --------------------------------------------------------------

/** PATH 扫描定位 git（win32 兼容 .exe；读运行期 PATH —— 可测性）。 */
function whichGit(): string | null {
  const exe = process.platform === "win32" ? "git.exe" : "git";
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    const c = path.join(d, exe);
    try {
      if (!fs.statSync(c).isFile()) continue;
      if (process.platform !== "win32") fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // 不存在/不可执行 → 下一个候选位
    }
  }
  return null;
}

/** 探测 git 是否可用（CLI/Web 呈现引擎状态用）。 */
export function gitAvailable(): boolean {
  return whichGit() !== null;
}

/** git 源判定：http(s)/git/ssh/file 协议 URL 或 git@host:path 形态。 */
function isGitSource(source: string): boolean {
  return /^(?:https?|git|ssh|file):\/\//i.test(source) || /^git@[\w.-]+:[\w./-]+/i.test(source);
}

/** staging 残留清理（尽力而为，失败不连坐）。 */
function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响降级语义（.staging-* 隐藏目录不会被列出）
  }
}

// ---- 安装 -----------------------------------------------------------------------

/**
 * 安装插件（本地目录拷贝 / git URL 浅克隆）。
 * 事务性：staging 中转 → 校验 → 原子 rename 落位；任何失败整体清理，
 * 绝不留半成品。git 缺席 → kind:"tool-absent"（附安装指引）。
 */
export function pluginInstall(ws: string, source: string): PluginInstallResult {
  const pluginsDir = path.join(ws, PLUGINS_DIR_REL);
  const git = isGitSource(source);

  // ---- 源就位到 staging ----
  if (!git) {
    let isDir = false;
    try {
      isDir = fs.statSync(source).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return {
        ok: false,
        kind: "invalid",
        error: `源不存在或不是目录：${source}（本地源须为插件目录；git 源须以 https://、git@ 或 file:// 开头）`,
      };
    }
    // 快速失败：先在源目录上校验（不拷贝任何东西）
    const pre = pluginValidate(source);
    if (!pre.valid) {
      return { ok: false, kind: "invalid", error: `插件校验失败，已整体拒绝（未安装）：\n  - ${pre.problems.join("\n  - ")}` };
    }
  } else {
    const gitBin = whichGit();
    if (gitBin === null) {
      return {
        ok: false,
        kind: "tool-absent",
        error: "未找到 git，无法从 git 源安装插件。请安装 git（apt install git / brew install git / winget install Git.Git），或改用本地目录源（pluginInstall(ws, <本地插件目录>)）。",
      };
    }
    try {
      fs.mkdirSync(pluginsDir, { recursive: true });
    } catch (e) {
      return { ok: false, kind: "internal", error: `插件目录创建失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return installFromGit(pluginsDir, gitBin, source);
  }

  // ---- 本地目录 → staging 拷贝 → 校验 → rename ----
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
  } catch (e) {
    return { ok: false, kind: "internal", error: `插件目录创建失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const staging = path.join(pluginsDir, `.staging-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    fs.cpSync(source, staging, { recursive: true });
  } catch (e) {
    cleanup(staging);
    return { ok: false, kind: "internal", error: `拷贝插件文件失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return finalizeInstall(pluginsDir, staging, false);
}

/** git 车道：clone --depth 1 到 staging → 校验 → rename。 */
function installFromGit(pluginsDir: string, gitBin: string, url: string): PluginInstallResult {
  const staging = path.join(pluginsDir, `.staging-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  let code: number | null = null;
  let stderr = "";
  try {
    const r = Bun.spawnSync([gitBin, "clone", "--depth", "1", url, staging], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: GIT_TIMEOUT_MS,
    } as Parameters<typeof Bun.spawnSync>[1]);
    code = r.exitCode;
    stderr = r.stderr?.toString() ?? "";
  } catch {
    code = null;
    stderr = "子进程无法启动";
  }
  if (code !== 0) {
    cleanup(staging);
    const tail = stderr.trim().split("\n").slice(-3).join("\n");
    return {
      ok: false,
      kind: "internal",
      error: `git clone --depth 1 失败（${code === null ? "超时或进程异常" : `退出码 ${code}`}）：${tail}。请检查 URL 可达性与仓库访问权限。`,
    };
  }
  return finalizeInstall(pluginsDir, staging, true);
}

/** staging → 校验 → 冲突检查 → 原子 rename 落位（git/local 车道共用收尾）。 */
function finalizeInstall(pluginsDir: string, staging: string, fromGit: boolean): PluginInstallResult {
  // 校验 staging 里的完整拷贝/克隆
  const ck = readManifest(staging);
  const problems = [...ck.problems];
  if (ck.entry !== null && !isFileSafe(path.join(staging, ck.entry))) {
    problems.push(`entry 指向的文件不存在：${ck.entry}（相对插件目录）`);
  }
  if (problems.length > 0 || ck.manifest === null) {
    cleanup(staging);
    return { ok: false, kind: "invalid", error: `插件校验失败，已整体拒绝（未安装）：\n  - ${problems.join("\n  - ")}` };
  }
  const { manifest, warnings } = ck;

  // 重名冲突（安装前 + rename 前双查）
  const final = path.join(pluginsDir, manifest.name);
  if (fs.existsSync(final)) {
    cleanup(staging);
    return { ok: false, kind: "conflict", error: `插件 "${manifest.name}" 已安装在 ${final}；如需重装请先移除（pluginRemove）。` };
  }
  try {
    fs.renameSync(staging, final);
  } catch (e) {
    cleanup(staging);
    const msg = e instanceof Error ? e.message : String(e);
    if (fs.existsSync(final)) {
      return { ok: false, kind: "conflict", error: `插件 "${manifest.name}" 已安装（并发安装竞争）：${final}` };
    }
    return { ok: false, kind: "internal", error: `落位失败：${msg}` };
  }
  if (fromGit && fs.existsSync(path.join(final, ".git"))) {
    warnings.push(".git 目录随插件保留（--depth 1 浅克隆，便于 git pull 更新）；介意体积可手动删除。");
  }
  return { ok: true, name: manifest.name, version: manifest.version, path: final, warnings };
}

// ---- 清单与移除 -------------------------------------------------------------------

/** 列出已安装插件（缺插件目录 → 空清单；staging 残留与隐藏目录不列出；
 *  坏插件不连坐 —— valid:false + problems 供面板渲染）。 */
export function pluginList(ws: string): { plugins: PluginInfo[]; dir: string } {
  const dir = path.join(ws, PLUGINS_DIR_REL);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { plugins: [], dir };
  }
  const plugins: PluginInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    const ck = readManifest(p);
    const problems = [...ck.problems];
    if (ck.entry !== null && !isFileSafe(path.join(p, ck.entry))) {
      problems.push(`entry 指向的文件不存在：${ck.entry}（相对插件目录）`);
    }
    plugins.push({ manifest: ck.manifest, path: p, valid: problems.length === 0, problems });
  }
  plugins.sort((a, b) => (a.manifest?.name ?? path.basename(a.path)).localeCompare(b.manifest?.name ?? path.basename(b.path)));
  return { plugins, dir };
}

/** 移除插件（整目录删除；未安装 → kind:"missing"）。 */
export function pluginRemove(ws: string, name: string): PluginRemoveResult {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("..")) {
    return { ok: false, kind: "invalid", error: `插件名 "${name}" 不合法（须匹配 ${NAME_RE.source}，且不得含 ".."）` };
  }
  const dir = path.join(ws, PLUGINS_DIR_REL, name);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return { ok: false, kind: "missing", error: `插件 "${name}" 未安装（${dir} 不存在）` };
  }
  if (!st.isDirectory()) {
    return { ok: false, kind: "invalid", error: `${dir} 不是插件目录（插件须是 <插件根>/<name>/ 形式的目录）` };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, kind: "internal", error: `移除失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, name, path: dir };
}
