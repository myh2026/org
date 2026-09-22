// ============================================================================
// tests/deps.test.ts — 依赖管理面（#65，v0.5.22）
// ----------------------------------------------------------------------------
// 覆盖面：
//   1. 探测：probeDepsTools 七工具形状 + PATH 操控注入假引擎（remote/mobile
//      同款 fake-bin 前置/替换手法）
//   2. 清单解析单元：package.json（deps/devDeps + 行号回扫）· pyproject.toml
//      （[project] dependencies 数组 + optional-dependencies 分组）· Cargo.toml
//      （字面量与 { version = "…" } 两形态 + dev-dependencies）· 未知类型与
//      路径监狱拒绝面
//   3. 安装车道：白名单表选道（bun > npm > pnpm / uv > pip > poetry / cargo）·
//      假引擎执行（argv 构造断言 + 退出码传播）· 引擎缺席诚实降级手动命令
//   4. 白名单拒绝面：shell 元字符 / flag 注入（- 前缀）/ 路径形态 / 版本约束
//      形态（==）—— 拒绝发生在任何 spawn 之前
//   5. CLI 冒烟：org deps probe / list / add（坏包名 exit 2）
//   6. 工具环 e2e：deps_probe 只读零审批 + deps_install 只读模式被 process_spawn
//      门拦截（mock 引擎零外发）
//   7. Web POST /api/govex/deps：probe/list/add 三动作 + 拒绝面 + 📦 面板要素
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeDepsTools, parseDepsManifest, depsInstall, pickDepsLane } from "../lib/deps.ts";
import { ROOT, TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";

const POSIX = process.platform !== "win32"; // 假脚本注入只在 POSIX（remote/mobile 同规）

/** 测试工作区（三种清单 + registry 锚定 demo-ws 形态）。 */
const WS = path.join(TEST_RUN, "deps-ws");
function seedWorkspace(): void {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true }); // registry/index.json（Web readWorkspaceOf 锚）
  fs.writeFileSync(path.join(WS, "package.json"), JSON.stringify({
    name: "demo-app",
    version: "1.2.3",
    dependencies: { "left-pad": "^1.3.0", "z-ai-web-dev-sdk": "^0.0.18" },
    devDependencies: { "@types/bun": "^1.4.1" },
  }, null, 2));
  fs.writeFileSync(path.join(WS, "pyproject.toml"), [
    "[project]",
    'name = "demo-py"',
    'version = "0.1.0"',
    "dependencies = [",
    '    "httpx>=0.27",',
    '    "pydantic>=2,<3",',
    "]",
    "",
    "[project.optional-dependencies]",
    "dev = [",
    '    "pytest>=8",',
    "]",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(WS, "Cargo.toml"), [
    "[package]",
    'name = "demo-rs"',
    'version = "0.1.0"',
    "",
    "[dependencies]",
    'serde = "1.0"',
    'tokio = { version = "1", features = ["full"] }',
    "",
    "[dev-dependencies]",
    'criterion = "0.5"',
    "",
  ].join("\n"));
}

/** 假引擎 bin 目录：stub 写 argv 落盘（参数构造断言面）+ FAKE_<NAME>_EXIT 控退出码。 */
const FAKE_BIN = path.join(TEST_RUN, "deps-fake-bin");
function makeStub(name: string): void {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const upper = `FAKE_${name.toUpperCase()}_EXIT`;
  fs.writeFileSync(path.join(FAKE_BIN, name), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "1.0.0 FakeBin-' + name + '"; exit 0; fi',
    `echo "$*" >> "\${FAKE_ARGV_LOG:-${FAKE_BIN}/argv.log}"`,
    `exit "\${${upper}:-0}"`,
    "",
  ].join("\n"));
  fs.chmodSync(path.join(FAKE_BIN, name), 0o755);
}

/** PATH 替换宇宙（replace:true = 只留假 bin —— 真工具全部缺席；缺省前置）。 */
function withFakePath<T>(fn: () => T, opts: { replace?: boolean } = {}): T {
  const saved = process.env.PATH;
  const savedLog = process.env.FAKE_ARGV_LOG;
  process.env.PATH = opts.replace ? FAKE_BIN : [FAKE_BIN, saved].filter(Boolean).join(path.delimiter);
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
    if (savedLog === undefined) delete process.env.FAKE_ARGV_LOG;
    else process.env.FAKE_ARGV_LOG = savedLog;
  }
}

// ---- 1. 探测 --------------------------------------------------------------------

describe("deps：七工具探测", () => {
  test("形状：7 家（uv/pip/poetry/bun/npm/pnpm/cargo）+ bun 在场（测试宿主即 bun）", () => {
    const tools = probeDepsTools();
    expect(tools.map((t) => t.name)).toEqual(["uv", "pip", "poetry", "bun", "npm", "pnpm", "cargo"]);
    expect(tools.find((t) => t.name === "bun")!.available).toBe(true); // bun test 宿主契约
    for (const t of tools) {
      expect(typeof t.available).toBe("boolean");
      if (!t.available) expect(t.note).toBeTruthy(); // 缺席 = 安装指引/去向说明成对交付
    }
  }, 30_000);

  test.skipIf(!POSIX)("PATH 操控：假 cargo 注入 → available + 版本解析", () => {
    makeStub("cargo");
    withFakePath(() => {
      const tools = probeDepsTools();
      const cargo = tools.find((t) => t.name === "cargo")!;
      expect(cargo.available).toBe(true);
      expect(cargo.version).toBe("1.0.0 FakeBin-cargo");
      expect(cargo.path).toBe(path.join(FAKE_BIN, "cargo"));
    });
  }, 30_000);
});

// ---- 2. 清单解析单元 --------------------------------------------------------------

describe("deps：清单解析（行级）", () => {
  beforeEach(() => seedWorkspace());

  test("package.json：deps/devDeps + 行号回扫 + name/version", () => {
    const r = parseDepsManifest(WS, "package.json");
    expect(r.ok).toBe(true);
    const m = r.manifest!;
    expect(m.kind).toBe("npm");
    expect(m.name).toBe("demo-app");
    expect(m.version).toBe("1.2.3");
    const names = m.deps.map((d) => `${d.name}@${d.spec}`);
    expect(names).toContain("left-pad@^1.3.0");
    expect(names).toContain("@types/bun@^1.4.1"); // scoped 名
    const dev = m.deps.find((d) => d.name === "@types/bun")!;
    expect(dev.kind).toBe("devDependencies");
    expect(dev.line).toBeGreaterThanOrEqual(6);
  }, 30_000);

  test("pyproject.toml：[project] dependencies 数组 + optional-dependencies 分组", () => {
    const r = parseDepsManifest(WS, "pyproject.toml");
    const m = r.manifest!;
    expect(m.kind).toBe("pyproject");
    expect(m.name).toBe("demo-py");
    expect(m.deps.find((d) => d.name === "httpx")!.spec).toBe(">=0.27");
    expect(m.deps.find((d) => d.name === "pydantic")!.spec).toBe(">=2,<3");
    expect(m.deps.find((d) => d.name === "httpx")!.kind).toBe("dependencies");
    expect(m.deps.find((d) => d.name === "httpx")!.line).toBe(5);
    const pytest = m.deps.find((d) => d.name === "pytest")!;
    expect(pytest.kind).toBe("optionalDependencies"); // optional-dependencies 分组
    expect(pytest.line).toBe(11);
  }, 30_000);

  test("Cargo.toml：字面量与 { version } 两形态 + dev-dependencies", () => {
    const r = parseDepsManifest(WS, "Cargo.toml");
    const m = r.manifest!;
    expect(m.kind).toBe("cargo");
    expect(m.deps.find((d) => d.name === "serde")!.spec).toBe("1.0");
    expect(m.deps.find((d) => d.name === "tokio")!.spec).toBe("1"); // { version = "1", … } 形态
    expect(m.deps.find((d) => d.name === "criterion")!.kind).toBe("devDependencies");
  }, 30_000);

  test("未知清单类型 + 路径监狱拒绝面", () => {
    const unk = parseDepsManifest(WS, "requirements.txt");
    expect(unk.ok).toBe(false);
    expect(unk.error).toContain("不认识的清单类型");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deps-out-"));
    fs.writeFileSync(path.join(outside, "package.json"), "{}");
    const esc = parseDepsManifest(WS, path.join(outside, "package.json"));
    expect(esc.ok).toBe(false);
    expect(esc.error).toContain("越界");
    const abs = parseDepsManifest(WS, path.join(WS, "package.json"));
    expect(abs.ok).toBe(true); // 工作区内绝对路径合法
    fs.rmSync(outside, { recursive: true, force: true });
  }, 30_000);
});

// ---- 3+4. 安装车道 + 白名单拒绝面 ---------------------------------------------------

describe.skipIf(!POSIX)("deps：安装车道（假引擎 argv 构造 + 降级 + 拒绝面）", () => {
  beforeEach(() => {
    seedWorkspace();
    fs.rmSync(FAKE_BIN, { recursive: true, force: true });
  });

  test("车道选择白名单表：bun > npm > pnpm（npm 族）/ uv > pip > poetry（pyproject）/ cargo 唯一", () => {
    makeStub("bun"); makeStub("npm"); makeStub("uv"); makeStub("cargo");
    const probe = withFakePath(() => probeDepsTools(), { replace: true });
    // npm 族：bun 在场 → bun add
    expect(pickDepsLane("npm", probe).engine).toBe("bun");
    const noBun = probe.filter((t) => t.name !== "bun");
    expect(pickDepsLane("npm", noBun).engine).toBe("npm"); // npm 退位
    // pyproject：uv 在场 → uv pip install
    const uvLane = pickDepsLane("pyproject", probe);
    expect(uvLane.engine).toBe("uv");
    expect(uvLane.sub).toEqual(["pip", "install"]);
    // cargo 唯一车道
    expect(pickDepsLane("cargo", probe).engine).toBe("cargo");
  }, 30_000);

  test("执行车道：假 bun add → argv 构造断言（add + 包名）+ cwd = 清单目录", () => {
    makeStub("bun");
    const argvLog = path.join(FAKE_BIN, "argv.log");
    fs.rmSync(argvLog, { force: true });
    process.env.FAKE_ARGV_LOG = argvLog;
    try {
      const r = withFakePath(() => depsInstall(WS, { file: "package.json", packages: ["zod", "dayjs"] }), { replace: true });
      expect(r.ok).toBe(true);
      expect(r.mode).toBe("executed");
      expect(r.engine).toBe("bun");
      expect(r.argv).toEqual([path.join(FAKE_BIN, "bun"), "add", "zod", "dayjs"]); // 白名单子命令 + 包名位
      const logged = fs.readFileSync(argvLog, "utf-8").trim().split("\n");
      expect(logged).toEqual(["add zod dayjs"]); // spawn 真实发生且仅一次（--version 不落 argv 日志）
    } finally {
      delete process.env.FAKE_ARGV_LOG;
    }
  }, 30_000);

  test("退出码传播：假引擎 exit 7 → ok:false + exitCode 7（诚实失败不假绿）", () => {
    makeStub("bun");
    const saved = process.env.FAKE_BUN_EXIT;
    process.env.FAKE_BUN_EXIT = "7";
    try {
      const r = withFakePath(() => depsInstall(WS, { file: "package.json", packages: ["zod"] }), { replace: true });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(7);
    } finally {
      if (saved === undefined) delete process.env.FAKE_BUN_EXIT;
      else process.env.FAKE_BUN_EXIT = saved;
    }
  }, 30_000);

  test("引擎缺席诚实降级：PATH 只剩空目录 → 手动命令车道（cloud 模板车道同哲学）", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "deps-empty-"));
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      const r = depsInstall(WS, { file: "pyproject.toml", packages: ["httpx"] });
      expect(r.ok).toBe(true); // 交付物 = 可粘贴命令（降级车道的产出）
      expect(r.mode).toBe("manual");
      expect(r.engine).toBe("uv"); // 首选车道名
      expect(r.manualCommand).toContain("uv pip install httpx");
      expect(r.manualCommand).toContain("cd ");
      // cargo 同理
      const rc = depsInstall(WS, { file: "Cargo.toml", packages: ["anyhow"] });
      expect(rc.mode).toBe("manual");
      expect(rc.manualCommand).toContain("cargo add anyhow");
    } finally {
      process.env.PATH = saved;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }, 30_000);

  test("白名单拒绝面：shell 元字符 / flag 注入 / 路径形态 / 复杂版本约束 —— 拒绝先于任何 spawn", () => {
    const argvLog = path.join(FAKE_BIN, "argv.log");
    fs.rmSync(argvLog, { force: true });
    makeStub("bun");
    process.env.FAKE_ARGV_LOG = argvLog;
    try {
      for (const bad of ["foo;rm -rf /", "../../etc/passwd", "-evIl", "pkg==1.0", "a|b", "x`y`"]) {
        const r = depsInstall(WS, { file: "package.json", packages: [bad] });
        expect(r.ok).toBe(false);
        expect(r.mode).toBe("denied");
        expect(String(r.error)).toContain("包名非法");
      }
      expect(fs.existsSync(argvLog)).toBe(false); // 零 spawn
      // 合法形态：裸名 / @scope/name / name@version
      for (const ok of ["zod", "@scope/pkg", "dayjs@1.2.3"]) {
        const r = withFakePath(() => depsInstall(WS, { file: "package.json", packages: [ok] }), { replace: true });
        expect(r.mode).toBe("executed");
      }
      // 空 packages 拒绝
      const empty = depsInstall(WS, { file: "package.json", packages: [] });
      expect(empty.ok).toBe(false);
    } finally {
      delete process.env.FAKE_ARGV_LOG;
    }
  }, 60_000);

  test("自动探测清单：无 --file 时根目录 package.json 优先（pyproject/Cargo 其后）", () => {
    makeStub("bun"); makeStub("uv"); makeStub("cargo");
    const r = withFakePath(() => depsInstall(WS, { packages: ["zod"] }), { replace: true });
    expect(r.file).toBe("package.json");
    expect(r.kind).toBe("npm");
    // 移除 package.json → pyproject 接管
    fs.rmSync(path.join(WS, "package.json"));
    const r2 = withFakePath(() => depsInstall(WS, { packages: ["httpx"] }), { replace: true });
    expect(r2.file).toBe("pyproject.toml");
    expect(r2.engine).toBe("uv");
    fs.rmSync(path.join(WS, "pyproject.toml"));
    const r3 = withFakePath(() => depsInstall(WS, { packages: ["anyhow"] }), { replace: true });
    expect(r3.file).toBe("Cargo.toml");
    expect(r3.engine).toBe("cargo");
    fs.rmSync(path.join(WS, "Cargo.toml"));
    const r4 = depsInstall(WS, { packages: ["x"] });
    expect(r4.ok).toBe(false);
    expect(String(r4.error)).toContain("无 package.json");
  }, 60_000);
});

// ---- 5. CLI 冒烟 -------------------------------------------------------------------

describe("deps：CLI 冒烟（org deps）", () => {
  beforeEach(() => seedWorkspace());

  test("org deps probe：七工具表 + org deps list --file：行级渲染", () => {
    const probe = runOrg(["deps", "probe"]);
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout).toContain("七工具");
    expect(probe.stdout).toContain("bun");
    const list = runOrg(["deps", "list", "--file", "package.json", "--workspace", WS]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("left-pad");
    expect(list.stdout).toContain("^1.3.0");
    expect(list.stdout).toContain("[devDependencies]");
    const py = runOrg(["deps", "list", "--file", "pyproject.toml", "--workspace", WS]);
    expect(py.exitCode).toBe(0);
    expect(py.stdout).toContain("pydantic");
  }, 120_000);

  test("org deps add：坏包名 exit 2（白名单拒绝面）+ 坏清单 exit 1 + 缺 --file exit 2", () => {
    const bad = runOrg(["deps", "add", "foo;rm", "--file", "package.json", "--workspace", WS]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("包名非法");
    const nofile = runOrg(["deps", "list", "--workspace", WS]);
    expect(nofile.exitCode).toBe(2);
    const badmf = runOrg(["deps", "list", "--file", "requirements.txt", "--workspace", WS]);
    expect(badmf.exitCode).toBe(1);
    expect(badmf.stderr).toContain("不认识的清单类型");
  }, 120_000);
});

// ---- 6. 工具环 e2e（deps_probe 只读 + deps_install 门控） ---------------------------

describe("deps：工具环 e2e", () => {
  const WSE = path.join(TEST_RUN, "deps-e2e-ws");
  const DIRECT = path.join(ROOT, "hsl/pool/direct.hsl");

  beforeEach(() => {
    fs.rmSync(WSE, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "demo-ws"), WSE, { recursive: true });
    fs.writeFileSync(path.join(WSE, "package.json"), JSON.stringify({
      name: "e2e-app", version: "0.0.1", dependencies: { "left-pad": "^1.3.0" },
    }));
  });
  afterEach(() => fs.rmSync(WSE, { recursive: true, force: true }));

  test("deps_probe 只读零审批 + deps_install 只读模式被 process_spawn 门拦截", () => {
    const fixture = path.join(TEST_RUN, "deps-fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({
      tracks: {
        "direct:notice-parser": [
          '<tool>{"name":"deps_probe","args":{}}</tool>',
          '<tool>{"name":"deps_install","args":{"packages":["zod"]}}</tool>',
          "最终答案：工具链已探测；安装需写档审批。",
        ],
      },
    }, null, 2));
    const out = path.join(TEST_RUN, "out-deps", "e2e");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WSE,
      "--task", "(direct) 看看依赖工具链，装个包",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "deps-e2e",
      ORG_ASK_QUESTION: "看看依赖工具链，装个包", ORG_TOOLS: "1", // 只读模式
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(results.length).toBe(1); // probe 有结果（观测摘要面；完整数据回灌模型）
    expect(JSON.stringify(results[0])).toContain("deps_probe ok");
    expect(JSON.stringify(results[0])).toContain("清单=package.json"); // 工作区清单自动探测
    const denied = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_denied");
    expect(denied.length).toBe(1); // install：process_spawn 门只读模式拦截
    // e2e-app 的 package.json 未被改写（门先于任何 spawn）
    const pkg = JSON.parse(fs.readFileSync(path.join(WSE, "package.json"), "utf-8"));
    expect(pkg.dependencies).toEqual({ "left-pad": "^1.3.0" });
  }, 120_000);
});

// ---- 7. Web POST /api/govex/deps + 📦 面板 ------------------------------------------

describe("deps：Web POST /api/govex/deps + 📦 依赖面板", () => {
  test("probe/list/add 三动作 + 拒绝面 + 面板要素 + 本簇 JS 可解析", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    seedWorkspace();
    const srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = async (body: unknown, raw = false): Promise<any> => {
      const res = await fetch(base + "/api/govex/deps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return raw ? res : res.json();
    };
    try {
      // ① probe：七工具 + 工作区清单自动探测
      const probe = await post({ action: "probe" });
      expect(probe.ok).toBe(true);
      expect(probe.tools.length).toBe(7);
      expect(probe.manifest.file).toBe("package.json"); // 根目录优先
      expect(probe.manifest.deps).toBeGreaterThanOrEqual(2);

      // ② list：三清单解析 + 越界/未知 400
      const list = await post({ action: "list", file: "Cargo.toml" });
      expect(list.ok).toBe(true);
      expect(list.manifest.deps.some((d: any) => d.name === "tokio")).toBe(true);
      const badType = await post({ action: "list", file: "nope.toml" }, true);
      expect(badType.status).toBe(400);
      const noFile = await post({ action: "list" }, true);
      expect(noFile.status).toBe(400);

      // ③ add：POSIX 下用假 bun（进程内服务器共享本进程 env —— PATH 操控可见）；
      //    非 POSIX 断言拒绝面（包名白名单在任何 spawn 之前）
      if (POSIX) {
        makeStub("bun");
        const argvLog = path.join(FAKE_BIN, "argv.log");
        fs.rmSync(argvLog, { force: true });
        process.env.FAKE_ARGV_LOG = argvLog;
        const savedPath = process.env.PATH;
        process.env.PATH = FAKE_BIN;
        try {
          const add = await post({ action: "add", file: "package.json", packages: ["zod"] });
          expect(add.ok).toBe(true);
          expect(add.mode).toBe("executed");
          expect(add.engine).toBe("bun");
          expect(fs.readFileSync(argvLog, "utf-8").trim()).toBe("add zod");
        } finally {
          process.env.PATH = savedPath;
          delete process.env.FAKE_ARGV_LOG;
        }
      }
      const badPkg = await post({ action: "add", packages: ["foo;rm"] }, true);
      expect(badPkg.status).toBe(400);
      const badPkgJ = await badPkg.json();
      expect(badPkgJ.error).toContain("包名非法");
      const unk = await post({ action: "nope" }, true);
      expect(unk.status).toBe(400);

      // ④ 面板要素 + 本簇 JS 独立可解析
      const html = await (await fetch(base + "/")).text();
      expect(html).toContain('id="gxSecDeps"');
      expect(html).toContain('id="gxTabDeps"');
      expect(html).toContain('"/api/govex/deps"');
      expect(html).toContain("gxDepsProbe()");
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
      for (const fn of ["gxDepsProbe", "gxDepsList", "gxDepsAdd"]) {
        const i = script.indexOf(`function ${fn}(`);
        expect(i).toBeGreaterThanOrEqual(0);
        const j2 = script.indexOf("\nfunction ", i + 1);
        const chunk = script.slice(i, j2 < 0 ? undefined : j2);
        expect(() => new Function(chunk)).not.toThrow();
      }
    } finally {
      srv.stop(true);
    }
  }, 60_000);
});
