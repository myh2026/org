// ============================================================================
// tests/plugins.test.ts — 插件/规则市场：安装·校验·清单（v0.5.16 · #132）
// ----------------------------------------------------------------------------
// 锁定四层：
//   1. 安装事务性：本地目录成功落地 / manifest 任何一项非法 → 整体拒绝且
//      插件目录无残留（staging 中转 + 原子 rename）/ 重名冲突不动原件
//   2. git 车道：真 git init 一个裸仓当源（file:// URL，--depth 1 生效）；
//      git 缺席（PATH 置空模拟）→ tool-absent + 安装指引；clone 失败 →
//      internal 且无残留
//   3. 移除：装上→删净→再删 missing；非法名（路径穿越）拒绝
//   4. 清单与预览：pluginValidate 纯只读（不安装）；pluginList 混合
//      valid+invalid 不连坐、排序稳定、staging 残留不列出
// 样本 manifest 全部合法假体；本套件绝不执行任何插件代码（模块本身的边界）。
// ============================================================================
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { pluginInstall, pluginList, pluginRemove, pluginValidate, gitAvailable } from "../lib/plugins.ts";

/** 一次性 tmp 工作区。 */
function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-plugins-${tag}-`));
}

/** 造一个合法的插件源目录。 */
function seedPlugin(dir: string, over: Record<string, unknown> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: "hello-tool",
    version: "1.2.3",
    description: "演示插件：hello 工具",
    entry: "main.ts",
    permissions: ["tool:fs_read", "tool:shell_run"],
    ...over,
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "main.ts"), "export function hello() { return 1; }\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# hello-tool\n");
  return dir;
}

/** pluginsDir 是否存在名为 name 的目录（残留检测）。 */
function installed(ws: string, name: string): boolean {
  return fs.existsSync(path.join(ws, ".org", "plugins", name));
}

// git 实况（模块导入时探测一次；skipIf 据此注册 —— ruff.test.ts 的 findRuff 哲学）
const HAS_GIT = (() => {
  try {
    return Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
})();

/** 造一个本地裸 git 仓库当市场源（file:// URL 供 --depth 1 克隆）。失败 → null。 */
function makeGitSource(tag: string): { url: string; dir: string } | null {
  const base = tmpWs(tag);
  const src = seedPlugin(path.join(base, "src"), { name: "git-hello", description: "从 git 市场安装" });
  const run = (args: string[], cwd?: string) =>
    Bun.spawnSync(args, { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" } as Parameters<typeof Bun.spawnSync>[1]);
  if (run(["git", "init", "-q"], src).exitCode !== 0) return null;
  run(["git", "config", "user.email", "org@test"], src);
  run(["git", "config", "user.name", "org-test"], src);
  run(["git", "add", "-A"], src);
  if (run(["git", "commit", "-q", "-m", "plugin"], src).exitCode !== 0) return null;
  const bare = path.join(base, "bare.git");
  if (run(["git", "clone", "-q", "--bare", src, bare]).exitCode !== 0) return null;
  return { url: pathToFileURL(bare).href, dir: base };
}

// ---- 1. 本地目录安装 ------------------------------------------------------------

describe("插件市场：本地目录安装", () => {
  test("安装成功：ok:true + name/version/path + 文件落位 + 可在清单中看到", () => {
    const ws = tmpWs("local-ok");
    try {
      const src = seedPlugin(path.join(ws, "src")); // 源放在 ws 外更真实 —— 但 ws 内也必须工作（源与安装位不同子树）
      const r = pluginInstall(ws, src);
      expect(r).toMatchObject({ ok: true, name: "hello-tool", version: "1.2.3" });
      if (!r.ok) return;
      expect(r.warnings).toEqual([]);
      expect(fs.existsSync(path.join(r.path, "main.ts"))).toBe(true);
      expect(fs.existsSync(path.join(r.path, "plugin.json"))).toBe(true);
      expect(r.path).toBe(path.join(ws, ".org", "plugins", "hello-tool"));
      const list = pluginList(ws);
      expect(list.plugins.length).toBe(1);
      expect(list.plugins[0].valid).toBe(true);
      expect(list.plugins[0].manifest?.name).toBe("hello-tool");
      expect(list.dir).toBe(path.join(ws, ".org", "plugins"));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("重名冲突：第二次安装 kind:conflict，原件内容不动", () => {
    const ws = tmpWs("conflict");
    try {
      const src = seedPlugin(path.join(ws, "src"));
      expect(pluginInstall(ws, src).ok).toBe(true);
      // 源升级后再装 —— 同名拒绝
      fs.writeFileSync(path.join(src, "main.ts"), "export function hello() { return 2; }\n");
      const r = pluginInstall(ws, src);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("conflict");
      expect(r.error).toContain("hello-tool");
      // 原件未被覆盖
      const kept = fs.readFileSync(path.join(ws, ".org", "plugins", "hello-tool", "main.ts"), "utf-8");
      expect(kept).toContain("return 1");
      expect(pluginList(ws).plugins.length).toBe(1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("manifest 缺 description → 整体拒绝且插件目录无残留（不留半成品）", () => {
    const ws = tmpWs("no-desc");
    try {
      const src = seedPlugin(path.join(ws, "src"), { description: undefined });
      const r = pluginInstall(ws, src);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("invalid");
      expect(r.error).toContain("description");
      expect(installed(ws, "hello-tool")).toBe(false);
      // 连 .org/plugins 目录里都不该有非隐藏残留
      const entries = fs.existsSync(path.join(ws, ".org", "plugins"))
        ? fs.readdirSync(path.join(ws, ".org", "plugins")).filter((e) => !e.startsWith("."))
        : [];
      expect(entries).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("version 非语义化（1.0 / abc / 1.2.3.4）→ 拒绝且无残留", () => {
    const ws = tmpWs("bad-ver");
    try {
      for (const bad of ["1.0", "abc", "1.2.3.4"]) {
        const src = seedPlugin(path.join(ws, `src-${bad.replace(/\./g, "_")}`), { version: bad });
        const r = pluginInstall(ws, src);
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect(r.kind).toBe("invalid");
        expect(r.error).toContain("version");
      }
      expect(pluginList(ws).plugins).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("entry 缺失 / entry 绝对路径 / entry 带 .. → 拒绝且无残留", () => {
    const ws = tmpWs("bad-entry");
    try {
      const miss = seedPlugin(path.join(ws, "s1"), { entry: "nope.ts" });
      let r = pluginInstall(ws, miss);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("invalid");

      const abs = seedPlugin(path.join(ws, "s2"), { entry: "/etc/passwd" });
      r = pluginInstall(ws, abs);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("invalid");
        expect(r.error).toContain("相对");
      }

      const up = seedPlugin(path.join(ws, "s3"), { entry: "../escape.js" });
      r = pluginInstall(ws, up);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("invalid");

      expect(pluginList(ws).plugins).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("permissions 格式：无冒号条目 / 数字条目 / 非数组 → 拒绝；空数组 → 成功但带 warning", () => {
    const ws = tmpWs("perm");
    try {
      const noColon = seedPlugin(path.join(ws, "s1"), { permissions: ["shell_run"] });
      let r = pluginInstall(ws, noColon);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("invalid");

      const numeric = seedPlugin(path.join(ws, "s2"), { permissions: ["tool:fs_read", 42] });
      r = pluginInstall(ws, numeric);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("invalid");
        expect(r.error).toContain("permissions");
      }

      const notArray = seedPlugin(path.join(ws, "s3"), { permissions: "tool:fs_read" });
      r = pluginInstall(ws, notArray);
      expect(r.ok).toBe(false);

      // 空数组合法（确无工具需求的插件）—— 但给出 RBAC 语义提示
      const empty = seedPlugin(path.join(ws, "s4"), { permissions: [] });
      r = pluginInstall(ws, empty);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warnings.some((w) => w.includes("permissions"))).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("plugin.json 坏 JSON / 顶层非对象 → 拒绝且无残留", () => {
    const ws = tmpWs("bad-json");
    try {
      for (const [tag, content] of [["broken", "{ not json "], ["array", "[1,2,3]"]] as const) {
        const src = seedPlugin(path.join(ws, tag));
        fs.writeFileSync(path.join(src, "plugin.json"), content);
        const r = pluginInstall(ws, src);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.kind).toBe("invalid");
      }
      expect(pluginList(ws).plugins).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("源不存在 → invalid（人读错误指向源）；未知 manifest 字段 → 成功但 warning 提醒", () => {
    const ws = tmpWs("src-miss");
    try {
      const r = pluginInstall(ws, path.join(ws, "no-such-dir"));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("invalid");
        expect(r.error).toContain("源不存在");
      }
      const extra = seedPlugin(path.join(ws, "src"), { auther: "typo" } as Record<string, unknown>);
      const r2 = pluginInstall(ws, extra);
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.warnings.some((w) => w.includes("auther"))).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 2. git 车道 ----------------------------------------------------------------

describe("插件市场：git 车道", () => {
  test.skipIf(!HAS_GIT)("真裸仓当源（file:// URL）：clone --depth 1 → 安装成功 + .git 保留 warning", () => {
    const src = makeGitSource("git-ok");
    expect(src).not.toBeNull();
    if (!src) return;
    const ws = tmpWs("git-ok-ws");
    try {
      const r = pluginInstall(ws, src.url);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.name).toBe("git-hello");
      expect(r.version).toBe("1.2.3");
      expect(fs.existsSync(path.join(r.path, "main.ts"))).toBe(true);
      expect(r.warnings.some((w) => w.includes(".git"))).toBe(true);
      expect(pluginList(ws).plugins[0]?.valid).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(src.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("git 缺席降级（PATH 置空模拟）：kind:tool-absent + 安装指引（本地源不受影响）", () => {
    const ws = tmpWs("no-git");
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const r = pluginInstall(ws, "https://example.com/org/some-plugin.git");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("tool-absent");
        expect(r.error).toContain("git");
        expect(r.error).toContain("本地目录"); // 指引给出替代路径
      }
      expect(installed(ws, "some-plugin")).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test.skipIf(!HAS_GIT)("clone 失败（不存在的 file:// 仓库）→ internal + 无残留", () => {
    const ws = tmpWs("git-fail");
    try {
      const nope = pathToFileURL(path.join(os.tmpdir(), `org-plugins-nope-${Date.now()}.git`)).href;
      const r = pluginInstall(ws, nope);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("internal");
        expect(r.error).toContain("git clone");
      }
      const entries = fs.existsSync(path.join(ws, ".org", "plugins"))
        ? fs.readdirSync(path.join(ws, ".org", "plugins")).filter((e) => !e.startsWith("."))
        : [];
      expect(entries).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 3. 移除与预览 ---------------------------------------------------------------

describe("插件市场：移除与预览", () => {
  test("pluginRemove：装上→删净（目录消失）→再删 kind:missing；非法名拒绝", () => {
    const ws = tmpWs("remove");
    try {
      const src = seedPlugin(path.join(ws, "src"));
      expect(pluginInstall(ws, src).ok).toBe(true);
      const r = pluginRemove(ws, "hello-tool");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.path).toBe(path.join(ws, ".org", "plugins", "hello-tool"));
      expect(installed(ws, "hello-tool")).toBe(false);

      const again = pluginRemove(ws, "hello-tool");
      expect(again.ok).toBe(false);
      if (!again.ok) {
        expect(again.kind).toBe("missing");
        expect(again.error).toContain("未安装");
      }
      // 路径穿越名拒绝（非法字符集不过 NAME_RE）
      for (const evil of ["../escape", "a/b", ".hidden", ""]) {
        const bad = pluginRemove(ws, evil);
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.kind).toBe("invalid");
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("pluginValidate 预览：纯只读校验（合法/非法分明），不产生任何安装副作用", () => {
    const ws = tmpWs("preview");
    try {
      const good = seedPlugin(path.join(ws, "good"));
      expect(pluginValidate(good)).toEqual({ valid: true, problems: [] });
      const bad = seedPlugin(path.join(ws, "bad"), { version: "latest" });
      const v = pluginValidate(bad);
      expect(v.valid).toBe(false);
      expect(v.problems.length).toBeGreaterThan(0);
      expect(v.problems[0]).toContain("version");
      // 预览不安装：ws 的插件目录仍不存在
      expect(fs.existsSync(path.join(ws, ".org", "plugins"))).toBe(false);
      expect(pluginList(ws).plugins).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("pluginList 混合：valid + invalid 共存不连坐，按名排序，problems 逐条人读", () => {
    const ws = tmpWs("list");
    try {
      const src = seedPlugin(path.join(ws, "src"));
      expect(pluginInstall(ws, src).ok).toBe(true);
      // 手工播种一个坏插件目录（manifest 缺 entry）
      const brokenDir = path.join(ws, ".org", "plugins", "z-broken");
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(
        path.join(brokenDir, "plugin.json"),
        JSON.stringify({ name: "z-broken", version: "0.1.0", description: "缺 entry" }),
      );
      // staging 残留（异常崩溃的痕迹）不应被列出
      fs.mkdirSync(path.join(ws, ".org", "plugins", ".staging-999-x"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".org", "plugins", ".staging-999-x", "junk"), "x");

      const { plugins, dir } = pluginList(ws);
      expect(dir).toBe(path.join(ws, ".org", "plugins"));
      expect(plugins.length).toBe(2);
      // 名字取 manifest.name（合法插件）或目录 basename（坏插件 —— manifest 为 null 但仍可定位）
      const nameOf = (p: { manifest: { name: string } | null; path: string }) => p.manifest?.name ?? path.basename(p.path);
      expect(plugins.map(nameOf)).toEqual(["hello-tool", "z-broken"]); // 排序稳定
      expect(plugins[0].valid).toBe(true);
      expect(plugins[1].valid).toBe(false);
      expect(plugins[1].problems.join("\n")).toContain("entry");
      // 全新工作区：空清单 + dir 字段如实
      const empty = tmpWs("list-empty");
      try {
        expect(pluginList(empty)).toEqual({ plugins: [], dir: path.join(empty, ".org", "plugins") });
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("gitAvailable 探测与 git 实况一致（PATH 置空 → false，恢复 → 原值）", () => {
    const before = gitAvailable();
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(gitAvailable()).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(gitAvailable()).toBe(before);
  }, 30_000);
});
