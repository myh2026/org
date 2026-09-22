// ============================================================================
// tests/sast.test.ts — SAST 静态安全分析（#146，v0.5.22）
// ----------------------------------------------------------------------------
// 覆盖面：
//   1. 引擎探测：probeSastEngines 四引擎形状 + ruff 在场（CI 契约）+ 缺席引擎
//      诚实说明（notes 带安装指引）
//   2. 内置规则引擎单元：fixtures/sast/bad-sample.{py,ts} 5 族危险模式全命中
//      （密钥/eval 注入/SQL 拼接/shell 拼接/弱随机）+ 干净代码零误报 + 弱随机
//      语境判定（无凭据语境的 Math.random 不报）
//   3. ruff 车道 vs 内置车道双对拍（工具链真实验证）：auto 车道出 ruff:S 码
//      发现（S307/S608/S605/S311）+ builtin 密钥横切；builtin 车道 5 族全内置
//      —— 两车道各有产出且规则面互补（ruff 缺席环境诚实回落断言）
//   4. 假引擎车道（POSIX skipIf win32）：bandit/gitleaks/semgrep 注入探测结果
//      —— 降级链第二/三环的解析代码路径（canned JSON → findings 映射）
//   5. 目标解析与监狱：glob/目录/精确文件三形态 + 无命中 unresolved + 越界
//      refused
//   6. CLI 冒烟：org sast 高危 exit 1 / 干净工作区 exit 0 / 坏 --engine exit 2
//   7. 工具环 e2e：sast_scan 只读零审批全链（scripted 剧本 → 发现回灌）
//   8. Web GET /api/govex/sast + 🛡 SAST 面板要素 + 本簇 JS 独立可解析
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanSast, probeSastEngines, scanTextBuiltin, SAST_RULES, type SastEngines } from "../lib/sast.ts";
import { ROOT, TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";

const POSIX = process.platform !== "win32"; // 假脚本注入只在 POSIX（remote/mobile 同规）
const FIX = path.join(ROOT, "fixtures/sast");

/** 假引擎 bin 目录（bandit/gitleaks/semgrep canned JSON 车道）。 */
const FAKE_BIN = path.join(TEST_RUN, "sast-fake-bin");
function makeFakeBin(): void {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  // 假 bandit：--version 探活；-f json 车道 → canned bandit JSON
  fs.writeFileSync(path.join(FAKE_BIN, "bandit"), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "bandit 1.7.9 FakeBin"; exit 0; fi',
    'echo \'{"results":[{"filename":"fixtures/sast/bad-sample.py","line_number":26,"test_id":"B307","issue_severity":"HIGH","issue_text":"Use of eval detected (fake bandit lane)"},{"filename":"fixtures/sast/bad-sample.py","line_number":31,"test_id":"B608","issue_severity":"MEDIUM","issue_text":"SQL injection (fake bandit lane)"}]}\'',
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(FAKE_BIN, "bandit"), 0o755);
  // 假 gitleaks：version 探活；detect 车道 → canned 报告写 --report-path 落点
  fs.writeFileSync(path.join(FAKE_BIN, "gitleaks"), [
    "#!/bin/sh",
    'if [ "$1" = "version" ]; then echo "gitleaks 8.19.0 FakeBin"; exit 0; fi',
    'rp=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--report-path" ]; then rp="$a"; fi',
    '  prev="$a"',
    "done",
    "if [ -n \"$rp\" ]; then",
    "  echo '[{\"RuleID\":\"generic-api-key\",\"File\":\"fixtures/sast/bad-sample.py\",\"StartLine\":19,\"Description\":\"Detected a Generic API Key (fake gitleaks lane)\"}]' > \"$rp\"",
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(FAKE_BIN, "gitleaks"), 0o755);
  // 假 semgrep：--version 探活；--json 车道 → canned semgrep JSON
  fs.writeFileSync(path.join(FAKE_BIN, "semgrep"), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "1.90.0 FakeBin"; exit 0; fi',
    "echo '{\"results\":[{\"check_id\":\"fake-rule-eval\",\"path\":\"fixtures/sast/bad-sample.py\",\"start\":{\"line\":26},\"extra\":{\"severity\":\"error\",\"message\":\"eval usage (fake semgrep lane)\"}}]}'",
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(FAKE_BIN, "semgrep"), 0o755);
}

/** 构造注入探测结果（ruff/bandit/gitleaks/semgrep 车道测试）。 */
function injectedEngines(partial: { pyLane?: string; secretsLane?: string; semgrepLane?: boolean }): SastEngines {
  const abs = (p: string) => p;
  return {
    ruff: { name: "ruff", available: false, path: null, version: null },
    bandit: { name: "bandit", available: true, path: abs(path.join(FAKE_BIN, "bandit")), version: "bandit 1.7.9 FakeBin" },
    semgrep: { name: "semgrep", available: true, path: abs(path.join(FAKE_BIN, "semgrep")), version: "1.90.0 FakeBin" },
    gitleaks: { name: "gitleaks", available: true, path: abs(path.join(FAKE_BIN, "gitleaks")), version: "gitleaks 8.19.0 FakeBin" },
    pyLane: "bandit",
    secretsLane: "builtin",
    tsLane: "builtin",
    semgrepLane: false,
    notes: [],
    ...partial,
  } as SastEngines;
}

// ---- 1. 引擎探测 ---------------------------------------------------------------

describe("sast：引擎探测（probeSastEngines）", () => {
  test("四引擎探测形状 + ruff 在场（CI 契约：verify/cross-platform 均装 ruff）", () => {
    const p = probeSastEngines();
    for (const e of [p.ruff, p.bandit, p.semgrep, p.gitleaks]) {
      expect(["ruff", "bandit", "semgrep", "gitleaks"]).toContain(e.name);
      expect(typeof e.available).toBe("boolean");
      expect(e.available ? e.version !== null : e.version === null).toBe(true); // 缺席恒 null / 在场探活解析
    }
    expect(p.ruff.available).toBe(true); // 本机与 CI 契约（ruff-gate 同前提）
    expect(p.pyLane).toBe("ruff");
  }, 30_000);

  test("缺席引擎诚实说明（notes 带安装指引，不静默）", () => {
    const p = probeSastEngines();
    for (const e of [p.bandit, p.semgrep, p.gitleaks]) {
      if (!e.available) {
        expect(e.note).toBeTruthy(); // 安装指引成对交付
        expect(p.notes.some((n) => n.startsWith(e.name))).toBe(true);
      }
    }
    // semgrep 零外联铁律：在场但未配 ORG_SEMGREP_CONFIG → 增广车道不接通
    if (p.semgrep.available && !process.env.ORG_SEMGREP_CONFIG) {
      expect(p.semgrepLane).toBe(false);
    }
  }, 30_000);
});

// ---- 2. 内置规则引擎单元 ---------------------------------------------------------

describe("sast：内置规则引擎（纯 TS regex 降级兜底）", () => {
  test("坏样本 py：密钥×3 + eval/SQL 拼接/shell 拼接/弱随机 五族全命中（行号精确）", () => {
    const text = fs.readFileSync(path.join(FIX, "bad-sample.py"), "utf-8");
    const hits = scanTextBuiltin(text, "bad.py", "py");
    const rules = new Set(hits.map((h) => h.rule));
    expect(rules).toContain("builtin-hardcoded-secret");
    expect(rules).toContain("builtin-eval-exec");
    expect(rules).toContain("builtin-sql-concat");
    expect(rules).toContain("builtin-shell-concat");
    expect(rules).toContain("builtin-weak-random");
    expect(hits.filter((h) => h.rule === "builtin-hardcoded-secret").length).toBe(3); // sk-ant- / ghp_ / AKIA 三形态
    expect(hits.find((h) => h.rule === "builtin-eval-exec")!.line).toBe(26);
    expect(hits.find((h) => h.rule === "builtin-sql-concat")!.line).toBe(31);
    expect(hits.find((h) => h.rule === "builtin-shell-concat")!.line).toBe(37);
    expect(hits.find((h) => h.rule === "builtin-weak-random")!.severity).toBe("medium");
  }, 30_000);

  test("坏样本 ts：eval/new Function / SQL 模板拼接 / exec 模板拼接 / 弱随机 / 密钥", () => {
    const text = fs.readFileSync(path.join(FIX, "bad-sample.ts"), "utf-8");
    const hits = scanTextBuiltin(text, "bad.ts", "ts");
    const rules = new Set(hits.map((h) => h.rule));
    expect(rules).toContain("builtin-hardcoded-secret");
    expect(rules).toContain("builtin-eval-exec"); // eval + new Function
    expect(rules).toContain("builtin-sql-concat"); // `SELECT … ${userId}`
    expect(rules).toContain("builtin-shell-concat"); // execSync(`cat ${fname}`)
    expect(rules).toContain("builtin-weak-random"); // Math.random() 做 token
    expect(hits.filter((h) => h.rule === "builtin-eval-exec").length).toBe(2);
  }, 30_000);

  test("干净代码零误报：正常业务代码 / 注释行 / 无凭据语境随机 不报", () => {
    const clean = [
      "const total = price * count;",
      "// const KEY = 'sk-should-not-flag-in-comment';",
      "const id = Math.random(); // 普通随机（无凭据语境）",
      "function query(db: string, id: string) { return `${db}:${id}`; }",
    ].join("\n");
    expect(scanTextBuiltin(clean, "clean.ts", "ts")).toEqual([]);
    const flaky = scanTextBuiltin("const sessionKey = Math.random();", "x.ts", "ts");
    expect(flaky.length).toBe(1); // 凭据语境（sessionKey）才报
  }, 30_000);
});

// ---- 3. ruff 车道 vs 内置车道双对拍（工具链真实验证） ------------------------------

describe("sast：ruff 车道 vs 内置车道双对拍（fixtures/sast 真实语料）", () => {
  test("auto 车道：ruff --select S 真实执行 → S 码发现 + severity 映射 + 内置密钥横切互补", () => {
    const r = scanSast(ROOT, { targets: ["fixtures/sast"] });
    expect(r.lanes.py).toBe(probeSastEngines().ruff.available ? "ruff" : "builtin");
    expect(r.findings.length).toBeGreaterThanOrEqual(10);
    if (r.lanes.py === "ruff") {
      // ruff 真实车道：S307(eval)/S608(SQL)/S605(shell)/S311(弱随机) 全数在场
      const codes = new Set(r.findings.filter((f) => f.engine === "ruff").map((f) => f.rule));
      expect(codes).toContain("ruff:S307");
      expect(codes).toContain("ruff:S608");
      expect(codes).toContain("ruff:S605");
      expect(codes).toContain("ruff:S311");
      expect(r.findings.find((f) => f.rule === "ruff:S608")!.severity).toBe("high"); // S6xx → high
      expect(r.findings.find((f) => f.rule === "ruff:S307")!.severity).toBe("medium"); // S3xx → medium
    } else {
      // ruff 缺席环境：诚实回落内置（永远有产出）
      expect(r.findings.some((f) => f.rule === "builtin-eval-exec" && f.file.endsWith(".py"))).toBe(true);
    }
    // 密钥横切：ruff 只按变量名认（S105 GH_TOKEN 一处），内置按值形状认（三形态全中）
    expect(r.findings.filter((f) => f.rule === "builtin-hardcoded-secret").length).toBeGreaterThanOrEqual(6);
    expect(r.summary.high).toBeGreaterThanOrEqual(8);
  }, 60_000);

  test("builtin 车道（engine:builtin 强制）：py+ts 全走内置，ruff 零参与", () => {
    const r = scanSast(ROOT, { targets: ["fixtures/sast"], engine: "builtin" });
    expect(r.lanes).toEqual({ py: "builtin", secrets: "builtin", ts: "builtin", semgrep: false });
    expect(r.findings.every((f) => f.engine === "builtin")).toBe(true);
    const byFile = new Map<string, number>();
    for (const f of r.findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
    expect(byFile.get("fixtures/sast/bad-sample.py")!).toBeGreaterThanOrEqual(7); // 密钥3+eval+sql+shell+random
    expect(byFile.get("fixtures/sast/bad-sample.ts")!).toBeGreaterThanOrEqual(8); // 密钥3+eval2+sql+shell+random
  }, 60_000);

  test("双对拍互补性：两车道都有产出且规则集不同（降级链语义）", () => {
    const auto = scanSast(ROOT, { targets: ["fixtures/sast"] });
    const builtin = scanSast(ROOT, { targets: ["fixtures/sast"], engine: "builtin" });
    expect(auto.findings.length).toBeGreaterThanOrEqual(15);
    expect(builtin.findings.length).toBe(15); // py 7（密钥3+eval+sql+shell+random）+ ts 8（密钥3+eval2+sql+shell+random）
    const autoRules = new Set(auto.findings.map((f) => f.rule));
    const builtRules = new Set(builtin.findings.map((f) => f.rule));
    expect(builtRules.has("builtin-weak-random")).toBe(true);
    if (auto.lanes.py === "ruff") {
      expect(autoRules.has("ruff:S311")).toBe(true);
      expect(auto.findings.length).toBe(builtin.findings.length + 1); // ruff:S105（变量名认密钥）与内置（值形状认）互补不重复
    }
  }, 60_000);
});

// ---- 4. 假引擎车道（POSIX） ------------------------------------------------------

describe.skipIf(!POSIX)("sast：假引擎车道（bandit/gitleaks/semgrep 降级链解析）", () => {
  beforeEach(() => makeFakeBin());

  test("bandit 车道：ruff 缺席 → -f json canned 输出 → findings 映射（B 码 + severity）", () => {
    const r = scanSast(ROOT, { targets: ["fixtures/sast"], engines: injectedEngines({ pyLane: "bandit" }) });
    expect(r.lanes.py).toBe("bandit");
    const banditHits = r.findings.filter((f) => f.engine === "bandit");
    expect(banditHits.length).toBe(2);
    expect(banditHits.find((f) => f.rule === "bandit:B307")!.severity).toBe("high"); // HIGH → high
    expect(banditHits.find((f) => f.rule === "bandit:B608")!.severity).toBe("medium");
    // py 代码车道被 bandit 接管，但密钥横切仍走内置（secretsLane 未变）
    expect(r.findings.some((f) => f.rule === "builtin-hardcoded-secret")).toBe(true);
  }, 30_000);

  test("gitleaks 车道：密钥横切接管（--report-path canned 报告 → findings）", () => {
    const r = scanSast(ROOT, { targets: ["fixtures/sast"], engines: injectedEngines({ secretsLane: "gitleaks" }) });
    expect(r.lanes.secrets).toBe("gitleaks");
    const gl = r.findings.filter((f) => f.engine === "gitleaks");
    expect(gl.length).toBe(1);
    expect(gl[0]!.rule).toBe("gitleaks:generic-api-key");
    expect(gl[0]!.severity).toBe("high"); // key 族规则 → high
    expect(gl[0]!.line).toBe(19);
  }, 30_000);

  test("semgrep 增广车道：ORG_SEMGREP_CONFIG 显式规则 → --json canned 结果合入", () => {
    const saved = process.env.ORG_SEMGREP_CONFIG;
    process.env.ORG_SEMGREP_CONFIG = path.join(FAKE_BIN, "semgrep"); // 任意存在文件即可（假引擎忽略内容）
    try {
      const r = scanSast(ROOT, { targets: ["fixtures/sast"], engines: injectedEngines({ semgrepLane: true }) });
      expect(r.lanes.semgrep).toBe(true);
      const sg = r.findings.filter((f) => f.engine === "semgrep");
      expect(sg.length).toBe(1);
      expect(sg[0]!.rule).toBe("semgrep:fake-rule-eval");
      expect(sg[0]!.severity).toBe("high"); // error → high
    } finally {
      if (saved === undefined) delete process.env.ORG_SEMGREP_CONFIG;
      else process.env.ORG_SEMGREP_CONFIG = saved;
    }
  }, 30_000);
});

// ---- 5. 目标解析与监狱 -----------------------------------------------------------

describe("sast：目标解析与路径监狱", () => {
  test("glob / 目录前缀 / 精确文件 三形态 + 无命中 unresolved + 越界 refused", () => {
    const glob = scanSast(ROOT, { targets: ["fixtures/sast/*.py"] });
    expect(glob.files).toBe(1);
    expect(glob.findings.every((f) => f.file.endsWith(".py"))).toBe(true);
    const dir = scanSast(ROOT, { targets: ["fixtures/sast"] });
    expect(dir.files).toBe(2);
    const miss = scanSast(ROOT, { targets: ["fixtures/sast/nope.py"] });
    expect(miss.unresolved).toEqual(["fixtures/sast/nope.py"]);
    expect(miss.findings).toEqual([]);
    const esc = scanSast(ROOT, { targets: ["../../etc"] });
    expect(esc.refused).toEqual(["../../etc"]);
  }, 30_000);
});

// ---- 6. CLI 冒烟 -----------------------------------------------------------------

describe("sast：CLI 冒烟（org sast）", () => {
  test("org sast fixtures/sast --workspace . ：高危 exit 1 + 发现渲染 + 引擎链行", () => {
    const r = runOrg(["sast", "fixtures/sast", "--workspace", "."]);
    expect(r.exitCode).toBe(1); // 高危发现 → 门禁语义（iacscan 同规）
    expect(r.stdout).toContain("SAST 扫描");
    expect(r.stdout).toContain("引擎链");
    expect(r.stdout).toContain("builtin-hardcoded-secret");
    expect(r.stdout).toContain("13 条高危");
  }, 120_000);

  test("org sast 干净工作区（demo-ws 无代码文件）exit 0 + org sast --engine bad exit 2", () => {
    const clean = runOrg(["sast", "--workspace", path.join(ROOT, "demo-ws")]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("未发现危险模式");
    const bad = runOrg(["sast", "x", "--engine", "nope", "--workspace", path.join(ROOT, "demo-ws")]);
    expect(bad.exitCode).toBe(2);
  }, 120_000);
});

// ---- 7. 工具环 e2e（sast_scan 只读零审批） ----------------------------------------

describe("sast：工具环 e2e（sast_scan）", () => {
  const WS = path.join(TEST_RUN, "sast-ws");
  const DIRECT = path.join(ROOT, "hsl/pool/direct.hsl");

  beforeEach(() => {
    fs.rmSync(WS, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true });
    fs.mkdirSync(path.join(WS, "src"), { recursive: true });
    fs.writeFileSync(path.join(WS, "src", "app.py"), 'API_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz123456"\nimport os\ndef run(code):\n    return eval(code)\n');
  });
  afterEach(() => fs.rmSync(WS, { recursive: true, force: true }));

  test("sast_scan 只读工具：ORG_TOOLS=1 零审批执行 → 发现回灌（含引擎车道观测）", () => {
    const fixture = path.join(TEST_RUN, "sast-fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({
      tracks: {
        "direct:notice-parser": [
          '<tool>{"name":"sast_scan","args":{"targets":["src"]}}</tool>',
          "最终答案：src/app.py 有硬编码密钥与 eval 注入。",
        ],
      },
    }, null, 2));
    const out = path.join(TEST_RUN, "out-sast", "e2e");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 扫一下 src 里的安全隐患",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "sast-e2e",
      ORG_ASK_QUESTION: "扫一下 src 里的安全隐患", ORG_TOOLS: "1",
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const calls = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0])).toContain("sast_scan");
    const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    expect(JSON.stringify(results[0])).toContain("sast_scan ok");
    expect(JSON.stringify(results[0])).toContain("high=");
    // 模型消费了发现（账本落最终答案）
    const ledger = fs.readFileSync(path.join(WS, "runtime/sessions/notice-parser/sast-e2e.jsonl"), "utf-8");
    expect(ledger).toContain("硬编码密钥");
  }, 120_000);
});

// ---- 8. Web GET /api/govex/sast + 🛡 面板 -----------------------------------------

describe("sast：Web GET /api/govex/sast + 🛡 SAST 面板", () => {
  test("端点贯通：targets 过滤 + 摘要 + 引擎在场 + 面板要素 + 本簇 JS 可解析", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    // demo-ws 模板（readWorkspaceOf 需 registry/index.json 才不回落 dist/demo 快照）
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "org-sast-web-"));
    fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "app.py"), 'KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz123456"\nimport os\ndef run(c):\n    return eval(c)\n');
    const srv = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const raw = await fetch(base + "/api/govex/sast?targets=" + encodeURIComponent("src/**"));
      const j = (await raw.json()) as Record<string, any>;
      expect(raw.status).toBe(200);
      expect(j.ok).toBe(true);
      expect(j.files).toBe(1);
      expect(j.total_findings).toBeGreaterThanOrEqual(2); // 内置密钥（值形状）+ eval 注入（ruff 在场时 ruff:S307）
      expect(j.summary.high).toBeGreaterThanOrEqual(1);
      expect(typeof j.engines.ruff).toBe("boolean");
      expect(j.findings.some((f: any) => f.rule === "builtin-hardcoded-secret")).toBe(true);

      const clean = await fetch(base + "/api/govex/sast?targets=" + encodeURIComponent("nope/**"));
      const cj = (await clean.json()) as Record<string, any>;
      expect(cj.ok).toBe(true);
      expect(cj.total_findings).toBe(0);

      // 面板要素 + 本簇 JS 独立可解析（tracker 同款守卫）
      const html = await (await fetch(base + "/")).text();
      expect(html).toContain('id="gxSecSast"');
      expect(html).toContain('id="gxTabSast"');
      expect(html).toContain('"/api/govex/sast"');
      expect(html).toContain("gxSastRun()");
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
      for (const fn of ["gxSastRun"]) {
        const i = script.indexOf(`function ${fn}(`);
        expect(i).toBeGreaterThanOrEqual(0);
        const j2 = script.indexOf("\nfunction ", i + 1);
        const chunk = script.slice(i, j2 < 0 ? undefined : j2);
        expect(() => new Function(chunk)).not.toThrow();
      }
    } finally {
      srv.stop(true);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);
});
