// ============================================================================
// lib/deps.ts — 依赖管理面（v0.5.22 · capabilities #65 安装依赖）
// ----------------------------------------------------------------------------
// 单一实现三端消费：CLI `org deps probe|list|add` · 工具环 `deps_probe`（只读）
// + `deps_install`（process_spawn 门 + 审批在环）· Web POST /api/govex/deps。
//
// 三层结构：
//   ① 探测：uv/pip/poetry/bun/npm/pnpm/cargo 七工具 which + --version 探活
//      （缺席诚实标注 + 安装指引 —— 与 mobile/cloud 探测层同哲学）。
//   ② 清单解析（行级，零第三方依赖）：
//      package.json（dependencies/devDependencies/optionalDependencies —— JSON
//      解析 + 行号回扫）· pyproject.toml（[project] dependencies 数组 +
//      [project.optional-dependencies] 分组 —— PEP 621 子集）· Cargo.toml
//      （[dependencies]/[dev-dependencies] —— 字面量与 { version = "…" } 两形态）。
//   ③ 安装车道：固定白名单表（封闭集合 —— 用户输入永不进子命令位）：
//        npm 族   bun add > npm install > pnpm add
//        pyproject uv pip install > pip install > poetry add
//        cargo    cargo add
//      安全三件套：包名白名单正则（拒 shell 元字符/flag 注入/../）+ 清单路径
//      监狱（pathjail）+ 120s 硬超时；引擎缺席诚实降级为「给出手动命令」
//      （与 cloud.ts 模板车道同哲学：缺席环境交付物 = 可粘贴命令）。
//
// 诚实边界：
//   · 行级解析非完整 TOML/JSONC parser —— 注释/多行字符串/继承（workspace
//     inheritance）不在面内（pyproject/Cargo 的 workspace.dependencies 继承、
//     package.json 的 npm overrides 不展开）；解析失败诚实报错不猜。
//   · 安装车道接受裸包名或 name@version 形态（uv/bun/npm 生态惯用形）；
//     复杂版本约束（>=、!=、extras）走手动命令车道（命令文本原样交付）。
//   · 不改写清单文件（bun add/cargo add 由引擎自行更新清单；uv pip install
//     只装环境 —— pyproject 需用户自行登记，CLI 输出如实提示）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { inWorkspace } from "./pathjail.ts";

// ---- ① 探测层 ----------------------------------------------------------------

export type DepsToolName = "uv" | "pip" | "poetry" | "bun" | "npm" | "pnpm" | "cargo";

export interface DepsToolProbe {
  name: DepsToolName;
  available: boolean;
  /** 定位到的可执行（PATH 活时扫描 —— tests PATH 操控注入假引擎的通道）；缺席 null。 */
  path: string | null;
  version: string | null;
  /** 缺席 = 安装指引；在场但探活未过 = 诚实说明。 */
  note?: string;
}

const DEPS_INSTALL_HINTS: Record<DepsToolName, string> = {
  uv: "安装：https://docs.astral.sh/uv/（curl -LsSf https://astral.sh/uv/install.sh | sh 或 pip install uv）—— pyproject 首选车道",
  pip: "Python 自带（python -m ensurepip）；pyproject 第二车道",
  poetry: "安装：pipx install poetry —— pyproject 第三车道（uv/pip 缺席时）",
  bun: "安装：https://bun.sh（curl -fsSL https://bun.sh/install | bash）—— package.json 首选车道",
  npm: "随 Node.js 分发（https://nodejs.org）—— package.json 第二车道",
  pnpm: "安装：npm install -g pnpm —— package.json 第三车道",
  cargo: "随 Rust 工具链分发（https://rustup.rs）—— Cargo.toml 唯一车道",
};

/** which 扫描（PATH 活时读 + win32 exe 后缀）。 */
function whichTool(name: string): string | null {
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const c of process.env.PATH?.split(path.delimiter) ?? []) {
    if (!c) continue;
    const p = path.join(c, name + exe);
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
      env: process.env, // 运行期 env（PATH 操控可见）
    } as Parameters<typeof Bun.spawnSync>[1]);
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout?.toString() ?? "").slice(0, 64 * 1024),
      stderr: (r.stderr?.toString() ?? "").slice(0, 64 * 1024),
    };
  } catch {
    return null;
  }
}

/** 探测七工具（探测零副作用）。 */
export function probeDepsTools(): DepsToolProbe[] {
  const names: DepsToolName[] = ["uv", "pip", "poetry", "bun", "npm", "pnpm", "cargo"];
  return names.map((name) => {
    const bin = whichTool(name);
    if (bin === null) {
      return { name, available: false, path: null, version: null, note: DEPS_INSTALL_HINTS[name] };
    }
    const v = spawnCaptured([bin, "--version"], 5_000);
    const out = ((v?.stdout ?? "") + (v?.stderr ?? "")).trim();
    const first = out.split("\n")[0] ?? "";
    if (v === null || v.exitCode !== 0 || !first) {
      return { name, available: true, path: bin, version: null, note: `${name} 在场但 --version 探活未通过（坏安装按缺席降级）` };
    }
    return { name, available: true, path: bin, version: first.slice(0, 80) };
  });
}

// ---- ② 清单解析（行级） ---------------------------------------------------------

export type DepsManifestKind = "npm" | "pyproject" | "cargo";
export type DepsDepKind = "dependencies" | "devDependencies" | "optionalDependencies";

export interface DepEntry {
  name: string;
  spec: string;
  kind: DepsDepKind;
  /** 1 基行号（JSON 经行号回扫；TOML 行级正则天然有行号）。 */
  line: number;
}

export interface DepsManifest {
  kind: DepsManifestKind;
  /** 工作区相对路径（正斜杠）。 */
  file: string;
  name?: string;
  version?: string;
  deps: DepEntry[];
  /** 解析诚实注记（如 pyproject 无 [project] 段）。 */
  notes: string[];
}

/** 按清单文件名分类。 */
export function classifyManifest(base: string): DepsManifestKind | null {
  if (base === "package.json") return "npm";
  if (base === "pyproject.toml") return "pyproject";
  if (base === "Cargo.toml") return "cargo";
  return null;
}

/** TOML 行内注释截断（# 须前置空白；引号内 # 可能误截 —— 误截方向是漏报侧）。 */
function stripTomlComment(line: string): string {
  const m = line.match(/\s#/);
  return m && m.index !== undefined ? line.slice(0, m.index) : line;
}

/** pyproject.toml 行级解析：[project] dependencies 数组 + optional-dependencies 分组。 */
function parsePyproject(text: string): { deps: DepEntry[]; name?: string; notes: string[] } {
  const deps: DepEntry[] = [];
  const notes: string[] = [];
  let name: string | undefined;
  let section = "";
  let inArray = false; // 当前在 dependencies = [ … ] 数组体内
  let curKind: DepsDepKind | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const bare = stripTomlComment(lines[i]).trim();
    if (bare.length === 0) continue;
    const sec = bare.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1];
      inArray = false;
      continue;
    }
    if (inArray) {
      if (bare === "]") { inArray = false; curKind = null; continue; }
      const item = bare.match(/^"([^"]+)"[,]?$/);
      if (item && curKind) {
        // PEP 508 形态："httpx>=0.27" / "pydantic>=2,<3" / "pytest>=8 ; python_version>..."
        const spec = item[1];
        const m = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
        if (m) deps.push({ name: m[1], spec: (m[2] || "").trim() || "*", kind: curKind, line: i + 1 });
      }
      continue;
    }
    if (section === "project") {
      const nm = bare.match(/^name\s*=\s*"([^"]*)"$/);
      if (nm) name = nm[1];
      const dm = bare.match(/^dependencies\s*=\s*\[$/);
      if (dm) { inArray = true; curKind = "dependencies"; continue; }
      if (/^dependencies\s*=\s*\[\s*\]\s*$/.test(bare)) continue; // 空数组
    }
    if (section === "project.optional-dependencies" || section === "dependency-groups") {
      const gm = bare.match(/^([A-Za-z0-9][\w.-]*)\s*=\s*\[$/);
      if (gm) { inArray = true; curKind = "optionalDependencies"; continue; }
      if (/^([A-Za-z0-9][\w.-]*)\s*=\s*\[\s*\]\s*$/.test(bare)) continue;
    }
  }
  if (deps.length === 0) notes.push("[project] dependencies 数组未声明或为空（可选依赖分组也未命中）—— 解析为零依赖形态");
  return { deps, name, notes };
}

/** Cargo.toml 行级解析：[dependencies]/[dev-dependencies] 两形态条目。 */
function parseCargo(text: string): { deps: DepEntry[]; notes: string[] } {
  const deps: DepEntry[] = [];
  const notes: string[] = [];
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const bare = stripTomlComment(lines[i]).trim();
    if (bare.length === 0) continue;
    const sec = bare.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1]; continue; }
    if (section === "dependencies" || section === "dev-dependencies") {
      // serde = "1.0"  /  tokio = { version = "1", features = ["full"] }  /  path/git 形态
      const lit = bare.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"[,]?$/);
      if (lit) {
        deps.push({ name: lit[1], spec: lit[2], kind: section === "dependencies" ? "dependencies" : "devDependencies", line: i + 1 });
        continue;
      }
      const tbl = bare.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*\{\s*version\s*=\s*"([^"]*)"[,]?/);
      if (tbl) {
        deps.push({ name: tbl[1], spec: tbl[2], kind: section === "dependencies" ? "dependencies" : "devDependencies", line: i + 1 });
        continue;
      }
      const other = bare.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*\{/);
      if (other) {
        deps.push({ name: other[1], spec: "(path/git/workspace 源)", kind: section === "dependencies" ? "dependencies" : "devDependencies", line: i + 1 });
      }
    }
  }
  if (deps.length === 0) notes.push("[dependencies] 段未声明或为空 —— 解析为零依赖形态");
  return { deps, notes };
}

/** package.json 解析（JSON.parse + 行号回扫）。 */
function parsePackageJson(text: string): { deps: DepEntry[]; name?: string; version?: string; error?: string; notes: string[] } {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { deps: [], error: `package.json JSON 解析失败：${String((e as Error).message ?? e)}`, notes: [] };
  }
  const lines = text.split(/\r?\n/);
  const findLine = (name: string): number => {
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(lines[i])) return i + 1;
    }
    return 1;
  };
  const deps: DepEntry[] = [];
  const kinds: DepsDepKind[] = ["dependencies", "devDependencies", "optionalDependencies"];
  for (const kind of kinds) {
    const obj = doc[kind];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [name, spec] of Object.entries(obj as Record<string, unknown>)) {
        deps.push({ name, spec: String(spec ?? "*"), kind, line: findLine(name) });
      }
    }
  }
  const notes: string[] = [];
  if (deps.length === 0) notes.push("dependencies/devDependencies/optionalDependencies 均未声明 —— 解析为零依赖形态");
  return {
    deps,
    name: typeof doc.name === "string" ? doc.name : undefined,
    version: typeof doc.version === "string" ? doc.version : undefined,
    notes,
  };
}

/** 解析依赖清单（file = 工作区相对或绝对路径，监狱校验）。 */
export function parseDepsManifest(ws: string, file: string): { ok: boolean; manifest?: DepsManifest; error?: string } {
  const kind = classifyManifest(path.basename(file));
  if (kind === null) {
    return { ok: false, error: `不认识的清单类型：${path.basename(file)}（支持 package.json / pyproject.toml / Cargo.toml）` };
  }
  const abs = path.isAbsolute(file) ? file : path.resolve(ws, file);
  if (!inWorkspace(ws, abs)) {
    return { ok: false, error: `清单路径越界：${file}（必须在工作区之内）` };
  }
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return { ok: false, error: `清单不可读：${file}（不存在或无权限）` };
  }
  const rel = abs.replace(/\\/g, "/").slice(ws.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
  if (kind === "npm") {
    const r = parsePackageJson(text);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, manifest: { kind, file: rel, name: r.name, version: r.version, deps: r.deps, notes: r.notes } };
  }
  if (kind === "pyproject") {
    const r = parsePyproject(text);
    return { ok: true, manifest: { kind, file: rel, name: r.name, deps: r.deps, notes: r.notes } };
  }
  const r = parseCargo(text);
  return { ok: true, manifest: { kind, file: rel, deps: r.deps, notes: r.notes } };
}

// ---- ③ 安装车道（白名单 + 监狱 + 超时 + 手动降级） -------------------------------

/** 安装车道白名单表（封闭集合：engine → 固定子命令模板；用户输入只进包名位）。 */
const INSTALL_LANES: Record<DepsManifestKind, Array<{ engine: DepsToolName; sub: string[] }>> = {
  npm: [
    { engine: "bun", sub: ["add"] },
    { engine: "npm", sub: ["install"] },
    { engine: "pnpm", sub: ["add"] },
  ],
  pyproject: [
    { engine: "uv", sub: ["pip", "install"] },
    { engine: "pip", sub: ["install"] },
    { engine: "poetry", sub: ["add"] },
  ],
  cargo: [
    { engine: "cargo", sub: ["add"] },
  ],
};

/** 包名白名单：裸名 / @scope/name / name@version（拒 shell 元字符与 flag 注入）。 */
const PKG_RE = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._+~!*-]*)?$/;

export interface DepsInstallResult {
  ok: boolean;
  /** executed = 真跑引擎；manual = 引擎缺席降级交付手动命令；dry-run = 只出计划；denied/refused = 拒绝。 */
  mode: "executed" | "manual" | "dry-run" | "denied" | "refused";
  /** 命中车道引擎（引擎缺席时 = 首选引擎名，供手动命令渲染）。 */
  engine: string | null;
  kind?: DepsManifestKind;
  file?: string;
  packages: string[];
  /** 实际执行的 argv（executed/dry-run）。 */
  argv?: string[];
  /** 手动命令（manual/always 填充 —— 可直接粘贴执行）。 */
  manualCommand: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/** 选车道：按清单类型 + 探测可用性（白名单顺序优先）。 */
export function pickDepsLane(kind: DepsManifestKind, probe: DepsToolProbe[]): { engine: DepsToolName; sub: string[]; path: string } | { engine: string; sub: string[]; path: null } {
  const byName = new Map(probe.map((p) => [p.name, p]));
  for (const lane of INSTALL_LANES[kind]) {
    const p = byName.get(lane.engine);
    if (p && p.available && p.path) return { engine: lane.engine, sub: lane.sub, path: p.path };
  }
  const first = INSTALL_LANES[kind][0]!;
  return { engine: first.engine, sub: first.sub, path: null };
}

/** 手动命令文本（缺席降级交付物；包名已过白名单 —— 无注入面）。 */
function manualCommandOf(engine: string, sub: string[], dir: string, packages: string[]): string {
  return `cd ${dir} && ${[engine, ...sub, ...packages].join(" ")}`;
}

/** 安装依赖：解析清单 → 白名单校验 → 车道执行（或手动命令降级）。
 *  dryRun:true 只出计划不执行（Web 面板预览/测试用）。 */
export function depsInstall(ws: string, opts: { file?: string; packages: string[]; timeoutMs?: number; dryRun?: boolean }): DepsInstallResult {
  const packages = (opts.packages ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 16);
  if (packages.length === 0) {
    return { ok: false, mode: "denied", engine: null, packages: [], manualCommand: "", error: "packages 必填（至少一个包名）" };
  }
  // 包名白名单（拒绝发生在任何 spawn 之前）
  for (const p of packages) {
    if (!PKG_RE.test(p)) {
      return {
        ok: false, mode: "denied", engine: null, packages,
        manualCommand: "",
        error: `包名非法：${p}（白名单：裸名 / @scope/name / name@version —— 拒 shell 元字符、flag 注入与路径形态）`,
      };
    }
  }
  // 清单解析（显式 --file 或根目录自动探测）+ 路径监狱
  let file = opts.file;
  if (!file) {
    for (const cand of ["package.json", "pyproject.toml", "Cargo.toml"]) {
      if (fs.existsSync(path.join(ws, cand))) { file = cand; break; }
    }
    if (!file) {
      return { ok: false, mode: "denied", engine: null, packages, manualCommand: "", error: "工作区根目录无 package.json / pyproject.toml / Cargo.toml（可用 --file 指定清单）" };
    }
  }
  const parsed = parseDepsManifest(ws, file);
  if (!parsed.ok || !parsed.manifest) {
    return { ok: false, mode: "denied", engine: null, packages, manualCommand: "", error: parsed.error };
  }
  const manifest = parsed.manifest;
  const dir = path.dirname(path.join(ws, manifest.file));
  const probe = probeDepsTools();
  const lane = pickDepsLane(manifest.kind, probe);
  const argv = [lane.path ?? lane.engine, ...lane.sub, ...packages];
  const manual = manualCommandOf(lane.engine, lane.sub, dir, packages);
  if (opts.dryRun) {
    return { ok: true, mode: "dry-run", engine: lane.engine, kind: manifest.kind, file: manifest.file, packages, argv, manualCommand: manual };
  }
  if (lane.path === null) {
    return {
      ok: true, mode: "manual", engine: lane.engine, kind: manifest.kind, file: manifest.file, packages,
      manualCommand: manual,
      error: undefined,
    };
  }
  const r = spawnCaptured(argv, opts.timeoutMs ?? 120_000, dir);
  if (r === null) {
    return { ok: false, mode: "executed", engine: lane.engine, kind: manifest.kind, file: manifest.file, packages, argv, manualCommand: manual, error: `${lane.engine} 执行失败/超时（${opts.timeoutMs ?? 120_000}ms）—— 可用手动命令重试` };
  }
  return {
    ok: r.exitCode === 0,
    mode: "executed",
    engine: lane.engine,
    kind: manifest.kind,
    file: manifest.file,
    packages,
    argv,
    manualCommand: manual,
    exitCode: r.exitCode ?? -1,
    stdout: r.stdout.slice(-4096),
    stderr: r.stderr.slice(-4096),
  };
}

/** 配置指引（CLI 帮助）。 */
export function depsGuidance(): string {
  return "依赖管理面（#65）：org deps probe（七工具探测）· org deps list --file package.json（清单解析）· org deps add <pkg...> --file …（白名单车道安装，缺席降级手动命令）。支持 package.json / pyproject.toml / Cargo.toml。";
}
