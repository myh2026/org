#!/usr/bin/env bun
// ============================================================================
// org/cli/org.ts — ORG 命令行（v0.4.8）
// ----------------------------------------------------------------------------
//   org run --task "..."          团队模式派单（监督回路全流程）
//   org demo                      全叙事演示：铸专家 → 用户选取保留 → 复用+补丁+金丝雀
//                                 → 蓝绿验证 → 多轮直连 → 暖移交
//   org ask <expert> "q" [--session id] [--turns "q1","q2"]
//                                 直连指定专家（记账 + 纪要回写 + 会话账本）
//   org web [--port N]            Web GUI 原型（Bun.serve 零依赖：会话侧栏 +
//                                 对话视图 + 观测元数据；实现见 web/entry.ts）
//   org handoff <expert> --task "..."   转接模式（主控移交摘要 → 专家代答）
//   org keep <expert...>          工具库治理：选取保留 harness（候选 → 转正）
//   org drop <expert...>          工具库治理：取消保留（不再参与 B 路径自动复用）
//   org import <file.hsl>         工具库治理：导入用户自己的 harness（check 闸门 →
//                                 入库即保留 → B 路径即刻可复用）
//   org status                    库 / 池 / 资产状态（★ 保留 · ○ 候选 · 含上下文窗口占用）
//   org score [--axis a]          模型评分卡与证据来源
//   org replay --run <dir>        确定性重放某次历史运行（journal 时间线）
//   org check                     dhv check 全部 HSL 源
//
// 工具链解析（vendored 优先）：$DHV_TS → 内嵌 toolchain/dhv-ts → 兄弟目录克隆
// （向后兼容）。Windows 兼容：子进程用 process.execPath（bun 本体），传给
// HSL 侧的 DHV_TS 统一转正斜杠（bash -c 不吃反斜杠）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, DEFAULT_WORKSPACE } from "../lib/root.ts";
import { dhvRun, assertWorkspaceNotTemplate, assertSafeResetWorkspace,
         loadRegistryIndex, setRetained, keepAllCandidates,
         importHarness, listContextUsage, renderContextMeter, expertFixtureOf } from "../lib/engine.ts";

const VERSION = "0.4.10";
const HSL_ENTRY = path.join(ROOT, "hsl/org.hsl");
const DIRECT_ENTRY = path.join(ROOT, "hsl/pool/direct.hsl");
const HANDOFF_ENTRY = path.join(ROOT, "hsl/pool/handoff.hsl");
const STOCK_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");

// ---- 工具链解析（vendored 优先） ----
function resolveDhv(): string {
  const candidates = [
    process.env.DHV_TS,
    path.join(ROOT, "toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "../hsl/toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "../harness-specification-language/toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "harness-specification-language/toolchain/dhv-ts/src/main.ts"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error(
    "✗ 找不到 HSL 工具链（dhv-ts）。三选一：\n" +
    "  1) export DHV_TS=/path/to/dhv-ts/src/main.ts\n" +
    "  2) 把 harness-specification-language 仓库 clone 到本仓库的兄弟目录\n" +
    "  3) 检查 toolchain/dhv-ts/src/main.ts 是否存在（仓库自带，不应缺失）",
  );
  process.exit(2);
}

const DHV = resolveDhv();

/** 传给 HSL 侧（bash -c 执行环境）的路径统一正斜杠。 */
function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---- 参数解析 ----
interface Args {
  cmd: string;
  task: string;
  workspace: string;
  fixture: string;
  model: string;
  out: string;
  runDir: string;
  axis: string;
  session: string;
  turns: string[];
  approveCapability: boolean;
  name: string;
  description: string;
  capabilities: string[];
  fixtureExplicit: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: argv[0] ?? "help",
    task: "",
    workspace: DEFAULT_WORKSPACE,
    fixture: STOCK_FIXTURE,
    model: "scripted",
    out: "",
    runDir: "",
    axis: "",
    session: "default",
    turns: [],
    approveCapability: false,
    name: "",
    description: "",
    capabilities: [],
    fixtureExplicit: false,
    rest: [],
  };
  let i = 1;
  while (i < argv.length) {
    const v = argv[i]!;
    if (v === "--task") a.task = argv[++i] ?? "";
    else if (v === "--workspace") a.workspace = path.resolve(argv[++i] ?? ".");
    else if (v === "--fixture") { a.fixture = path.resolve(argv[++i] ?? "."); a.fixtureExplicit = true; }
    else if (v === "--model") a.model = argv[++i] ?? "scripted";
    else if (v === "--out") a.out = path.resolve(argv[++i] ?? ".");
    else if (v === "--run") a.runDir = path.resolve(argv[++i] ?? ".");
    else if (v === "--axis") a.axis = argv[++i] ?? "";
    else if (v === "--session") a.session = argv[++i] ?? "default";
    else if (v === "--turns") a.turns = (argv[++i] ?? "").split("|").filter((s) => s.length > 0);
    else if (v === "--approve-capability") a.approveCapability = true;
    else if (v === "--name") a.name = (argv[++i] ?? "").toLowerCase();
    else if (v === "--description" || v === "--desc") a.description = argv[++i] ?? "";
    else if (v === "--capability" || v === "--capabilities") a.capabilities = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else a.rest.push(v);
    i++;
  }
  return a;
}

// ---- 基础执行（dhvRun：bun 子进程优先，无 bun 环境进程内 fallback） ----
async function runHsl(entry: string, opts: {
  workspace: string; task: string; model: string; fixture: string; out: string;
  env?: Record<string, string>;
}): Promise<{ ok: boolean; out: string }> {
  const args = [
    "run", entry,
    "--workspace", opts.workspace,
    "--task", opts.task,
    "--model", opts.model,
    "--fixture", opts.fixture,
    "--out", opts.out,
    "--allow", "bun,node,ls,cat,grep,diff,git",
  ];
  return dhvRun(args, opts.env);
}

async function checkFile(file: string): Promise<boolean> {
  const r = await dhvRun(["check", file]);
  const ok = r.ok;
  const text = r.out;
  const tag = ok ? "✓" : "✗";
  const rel = path.relative(ROOT, file);
  console.log(`  ${tag} ${rel}${ok ? "" : "\n" + text.split("\n").slice(-8).join("\n")}`);
  return ok;
}

// ---- 命令 ----
async function cmdRun(a: Args): Promise<number> {
  if (!a.task) { console.error("✗ --task 必填"); return 2; }
  ensureWorkspace(a.workspace);
  const out = a.out || path.join(a.workspace, "out-latest");
  const env = a.approveCapability ? { ORG_CAPABILITY_APPROVED: "1" } : {};
  const r = await runHsl(HSL_ENTRY, {
    workspace: a.workspace, task: a.task, model: a.model,
    fixture: a.fixture, out, env,
  });
  process.stdout.write(r.out);
  return r.ok ? 0 : 1;
}

async function cmdDemo(a: Args): Promise<number> {
  const ws = a.workspace;
  const task = "抓取某站点近一周公告，输出结构化表格";
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║ ORG 全叙事演示：子智能体可生成、可验收、可复用、可演进            ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`  工作区 ${ws}（git 注册表） · 任务「${task}」 · 模式 ${a.model}\n`);

  // 工作区重置（演示可重复）；模板目录只读守卫 + 非工作区目录拒绝删除
  // （rmSync 脚枪防线：指错目录不再静默删光，见 engine.ts assertSafeResetWorkspace）
  try {
    assertWorkspaceNotTemplate(ws);
    assertSafeResetWorkspace(ws);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
  gitInit(ws);

  const t0 = Date.now();
  const phases: Array<{ id: string; label: string; out: string; fn: () => Promise<{ ok: boolean; out: string }> }> = [
    {
      id: "A", label: "run A · 现场铸专家（工厂闸门）+ 过程审查（返工）+ 固化起步",
      out: path.join(ws, "out-a"),
      fn: () => runHsl(HSL_ENTRY, { workspace: ws, task, model: a.model, fixture: a.fixture, out: path.join(ws, "out-a") }),
    },
    {
      // 用户选取（工具库治理）：工厂产出是候选（retained=false），B 路径只
      // 复用用户保留的资产。scripted 演示自动全选（真实用户用 org keep 挑选）。
      id: "K", label: "用户选取 · harness 候选转正保留（org keep；scripted 自动全选）",
      out: "",
      fn: async () => {
        const picked = keepAllCandidates(ws);
        const line = picked.length > 0 ? picked.join(", ") : "（无候选 —— 存量资产均已保留）";
        console.log(`    ★ 保留 ${line}（未保留候选不参与 B 路径自动复用）`);
        return { ok: true, out: "" };
      },
    },
    {
      id: "B", label: "run B · 复用资产（零工厂）+ 意见复发 → 补丁合入 → 金丝雀影子晋升",
      out: path.join(ws, "out-b"),
      fn: () => runHsl(HSL_ENTRY, { workspace: ws, task, model: a.model, fixture: a.fixture, out: path.join(ws, "out-b") }),
    },
    {
      id: "C", label: "run C · 蓝绿验证（补丁版 v1.0.1 上岗）+ 零返工",
      out: path.join(ws, "out-c"),
      fn: () => runHsl(HSL_ENTRY, { workspace: ws, task, model: a.model, fixture: a.fixture, out: path.join(ws, "out-c") }),
    },
    {
      id: "D", label: "直连 · 多轮会话（记账 + 纪要回写 + 会话账本）",
      out: path.join(ws, "out-direct"),
      fn: () => runHsl(DIRECT_ENTRY, {
        workspace: ws, task: "(direct) multi-turn", model: a.model, fixture: a.fixture,
        out: path.join(ws, "out-direct"),
        env: { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "demo", ORG_ASK_TURNS: '["上周抓取任务里的字段映射规则是什么？","那日期无法解析时怎么处理？"]' },
      }),
    },
    {
      id: "E", label: "转接 · 暖移交（主控移交摘要 → 专家代答）",
      out: path.join(ws, "out-handoff"),
      fn: () => runHsl(HANDOFF_ENTRY, {
        workspace: ws, task: "(handoff) small request", model: a.model, fixture: a.fixture,
        out: path.join(ws, "out-handoff"),
        env: { ORG_HANDOFF_EXPERT: "notice-parser", ORG_HANDOFF_TASK: "帮我把上周公告解析规则整理成一句话给新同事" },
      }),
    },
  ];
  for (const phase of phases) {
    console.log(`── ${phase.label} ${"─".repeat(Math.max(0, 46 - phase.label.length))}`);
    const r = await phase.fn();
    process.stdout.write(r.out.split("\n").map((l) => "  " + l).join("\n") + "\n");
    if (!r.ok) { console.error(`✗ phase ${phase.id} 失败`); return 1; }
  }

  // ---- 叙事总结（从产物提取关键事件） ----
  console.log("\n╔════════════════════════ 走读摘要 ═════════════════════════╗");
  for (const id of ["A", "B", "C"]) {
    const [, line] = summarizeRun(path.join(ws, `out-${id.toLowerCase()}`), id);
    console.log(`  ${id} ${line}`);
  }
  const [, directLine] = summarizeDirect(ws);
  console.log(`  D ${directLine}`);
  const [, handoffLine] = summarizeHandoff(ws);
  console.log(`  E ${handoffLine}`);
  const gitLog = gitLogOf(ws);
  if (gitLog.length > 0) {
    console.log("\n  git 注册表历史（registry 资产层）：");
    for (const l of gitLog.slice(0, 6)) console.log(`    ${l}`);
  }
  console.log(`\n  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 产物 ${ws}/out-{a,b,c,direct,handoff}`);
  exportDist(ws);
  console.log(`  编译产物已导出 dist/demo（入库快照，含 git-chain.json）\n`);
  return 0;
}

// ---- 编译产物导出：dist/demo（提交进库的运行快照） ----
const DIST_README = `# dist/demo — 全叙事演示编译产物（自动生成，勿手改）

\`org demo\` 的全量输出快照：out-a/b/c（run.json / events.jsonl /
journal.jsonl / 评分卡 / metrics.json）、out-direct（多轮直连）与
out-handoff（暖移交）、registry（专家注册表 + 固化 memo + 基准题沉淀 +
评分卡基线）、runtime（复发计数 / 会话账本 / 纪要）与 git-chain.json
（资产层 git 历史，因嵌套 .git 不入库而以数据保存）。

再生：\`bun cli/org.ts demo\`（CI 每次 push 自动再生并回写，见
.github/workflows/ci.yml）。
`;

function exportDist(ws: string): void {
  const dist = path.join(ROOT, "dist", "demo");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const skip = new Set([".git", ".hsl-runs"]);
  const copy = (src: string, dst: string): void => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copy(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  };
  copy(ws, dist);
  fs.writeFileSync(
    path.join(dist, "git-chain.json"),
    JSON.stringify({ captured_at: new Date().toISOString(), commits: gitLogFull(ws) }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(dist, "README.md"), DIST_README);
}

function gitLogFull(ws: string): Array<{ sha: string; subject: string; date: string }> {
  try {
    const out = Bun.spawnSync(
      ["git", "-C", ws, "log", "--pretty=format:%h%x1f%s%x1f%ci", "--all"],
      { stdout: "pipe" },
    );
    return out.stdout.toString().split("\n").filter((l) => l.trim().length > 0).map((l) => {
      const [sha, subject, date] = l.split("\x1f");
      return { sha: sha ?? "", subject: subject ?? "", date: date ?? "" };
    });
  } catch {
    return [];
  }
}

function readMetrics(ws: string, id: string): Record<string, unknown> | null {
  try {
    const p = path.join(ws, `out-${id.toLowerCase()}`, "metrics.json");
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizeRun(outDir: string, id: string): [string, string] {
  try {
    const events = fs.readFileSync(path.join(outDir, "events.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { name: string; data?: Record<string, unknown> });
    const hits = events.filter((e) => e.name === "crystallize_hit").length;
    const frozen = events.filter((e) => e.name === "crystallize_frozen").length;
    const canary = events.filter((e) => e.name === "canary_confirmed").length;
    const mined = events.filter((e) => e.name === "fixtures_mined").length;
    const m = readMetrics(path.dirname(outDir), id);
    const bits: string[] = [];
    if (m) {
      bits.push(`ok=true ${m.model_calls_total} model_calls · ${m.revises_total} revises · ${m.assets} 资产`);
      if (m.drift_alerts !== undefined) bits.push(`漂移告警 ${m.drift_alerts}`);
    } else {
      const runJson = JSON.parse(fs.readFileSync(path.join(outDir, "run.json"), "utf-8")) as { ok: boolean; elapsed_ms?: number };
      bits.push(`ok=${runJson.ok}`);
    }
    if (frozen > 0) bits.push(`冻结 ${frozen} 条判定映射`);
    if (hits > 0) bits.push(`固化命中 ${hits} 次（零模型调用）`);
    if (canary > 0) bits.push(`金丝雀影子晋升确认 ${canary} 次`);
    if (mined > 0) bits.push(`journal→fixture 出题 ${mined} 批`);
    return [id, bits.join(" · ")];
  } catch {
    return [id, "(产物缺失)"];
  }
}

function summarizeDirect(ws: string): [string, string] {
  try {
    const ledger = fs.readFileSync(path.join(ws, "out-direct", "direct-ledger.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0);
    const sessions = path.join(ws, "runtime/sessions/notice-parser/demo.jsonl");
    const turns = fs.existsSync(sessions)
      ? fs.readFileSync(sessions, "utf-8").split("\n").filter((l) => l.trim().length > 0).length
      : 0;
    return ["D", `多轮直连 ${turns} 轮 · 记账 ${ledger.length} 条 · 会话账本 + 纪要回写完成`];
  } catch {
    return ["D", "(产物缺失)"];
  }
}

function summarizeHandoff(ws: string): [string, string] {
  try {
    const ledger = fs.readFileSync(path.join(ws, "out-handoff", "direct-ledger.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0);
    return ["E", `暖移交 1 次（移交摘要 + 专家代答） · 记账 ${ledger.length} 条（handoff 通道）`];
  } catch {
    return ["E", "(产物缺失)"];
  }
}

function gitLogOf(ws: string): string[] {
  try {
    const out = Bun.spawnSync(["git", "-C", ws, "log", "--oneline", "--all"], { stdout: "pipe" });
    return out.stdout.toString().split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function gitInit(ws: string): void {
  for (const args of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "org@local"],
    ["git", "config", "user.name", "org-registry"],
  ] as const) {
    Bun.spawnSync(args as unknown as string[], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  }
  Bun.spawnSync(["git", "add", "-A"], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["git", "commit", "-q", "-m", "registry template (notice-parser@1.0.0)"],
    { cwd: ws, stdout: "ignore", stderr: "ignore" });
}

function ensureWorkspace(ws: string): void {
  try {
    assertWorkspaceNotTemplate(ws);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(2);
  }
  if (!fs.existsSync(ws)) {
    console.log(`ℹ 初始化工作区（模板 demo-ws → ${path.relative(ROOT, ws)}）`);
    fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
    gitInit(ws);
  }
}

async function cmdAsk(a: Args): Promise<number> {
  const expert = a.rest[0] ?? "";
  const question = a.rest.slice(1).join(" ");
  if (!expert) {
    console.error('用法：org ask <expert> "<question>" [--session id] [--turns "q1|q2"]');
    return 2;
  }
  ensureWorkspace(a.workspace);
  const out = a.out || path.join(a.workspace, "out-ask");
  const turns = a.turns.length > 0 ? a.turns : (question ? [question] : []);
  if (turns.length === 0) {
    console.error('用法：org ask <expert> "<question>"（问题必填）');
    return 2;
  }
  const env: Record<string, string> = {
    ORG_ASK_EXPERT: expert,
    ORG_ASK_SESSION: a.session,
  };
  if (turns.length === 1) env.ORG_ASK_QUESTION = turns[0]!;
  else env.ORG_ASK_TURNS = JSON.stringify(turns);
  // 剧本自动发现：导入 harness 自带占位剧本（manifest.fixture）—— 不传
  // --fixture 也能立即 scripted 问答（零摩擦）；显式 --fixture 优先。
  let fixture = a.fixture;
  if (!a.fixtureExplicit) {
    const found = expertFixtureOf(a.workspace, expert);
    if (found) {
      fixture = found;
      console.log(`ℹ 使用导入剧本 ${path.relative(a.workspace, found)}（占位应答 · --model deepseek 换真实回答）`);
    }
  }
  const r = await runHsl(DIRECT_ENTRY, {
    workspace: a.workspace, task: `(direct) ${turns.join(" / ")}`, model: a.model,
    fixture, out, env,
  });
  process.stdout.write(r.out);
  return r.ok ? 0 : 1;
}

async function cmdHandoff(a: Args): Promise<number> {
  const expert = a.rest[0] ?? "";
  if (!expert || !a.task) {
    console.error('用法：org handoff <expert> --task "<request>"');
    return 2;
  }
  ensureWorkspace(a.workspace);
  const out = a.out || path.join(a.workspace, "out-handoff");
  // 剧本自动发现（与 cmdAsk 同规则）：导入 harness 的 handoff:<name> 占位轨道
  let fixture = a.fixture;
  if (!a.fixtureExplicit) {
    const found = expertFixtureOf(a.workspace, expert);
    if (found) {
      fixture = found;
      console.log(`ℹ 使用导入剧本 ${path.relative(a.workspace, found)}（占位应答 · --model deepseek 换真实回答）`);
    }
  }
  const r = await runHsl(HANDOFF_ENTRY, {
    workspace: a.workspace, task: `(handoff) ${a.task}`, model: a.model,
    fixture, out,
    env: { ORG_HANDOFF_EXPERT: expert, ORG_HANDOFF_TASK: a.task },
  });
  process.stdout.write(r.out);
  return r.ok ? 0 : 1;
}

// 读命令的默认工作区：本地 demo-run 优先（活数据），否则 dist/demo（入库快照）
function defaultWorkspace(a: Args): string {
  if (a.workspace !== path.join(ROOT, "demo-run")) return a.workspace;
  if (fs.existsSync(path.join(ROOT, "demo-run", "registry"))) return a.workspace;
  if (fs.existsSync(path.join(ROOT, "dist", "demo", "registry"))) {
    return path.join(ROOT, "dist", "demo");
  }
  return a.workspace;
}

// ---- 工具库治理：用户选取保留（实现见 lib/engine.ts，CLI/TUI 共用） ----

async function cmdKeep(a: Args): Promise<number> {
  return cmdRetain(a, true);
}

async function cmdDrop(a: Args): Promise<number> {
  return cmdRetain(a, false);
}

// ---- 导入用户自己的 harness（工具库治理第三动作：import = 用户交付资产） ----
async function cmdImport(a: Args): Promise<number> {
  const file = a.rest[0] ?? "";
  if (!file) {
    console.error('用法：org import <file.hsl> [--name NAME] [--description "…"] [--capability a,b] [--workspace DIR]');
    console.error("  导入即保留（source=import, retained=true）—— B 路径自动复用立即可用；");
    console.error("  描述缺省取文件首个 /// 文档注释，能力缺省扫描 #[capability(…)] 注解。");
    return 2;
  }
  ensureWorkspace(a.workspace);
  try {
    const r = await importHarness(a.workspace, path.resolve(file), {
      name: a.name || undefined,
      description: a.description || undefined,
      capabilities: a.capabilities.length > 0 ? a.capabilities : undefined,
    });
    console.log(`✓ 已导入 ${r.name}@${r.version}（check 绿 · git 留痕）`);
    console.log(`  描述：${r.description}`);
    console.log(`  能力：${r.capabilities.join(", ")}`);
    console.log(`  入库：${path.relative(process.cwd(), r.file)}（source=import · retained=true · B 路径即刻可复用）`);
    console.log(`  剧本：${path.relative(process.cwd(), r.fixture)}（scripted 占位应答 · org ask ${r.name} "…" 零参数直连）`);
    console.log("  下一步：org status 查看 · org ask " + r.name + ' "…" 直连（占位剧本 · --model deepseek 换真实回答） · org drop ' + r.name + " 取消保留");
    return 0;
  } catch (err) {
    console.error(`✗ 导入失败：${(err as Error).message}`);
    return 1;
  }
}

async function cmdRetain(a: Args, retained: boolean): Promise<number> {
  const names = a.rest;
  const action = retained ? "keep（选取保留）" : "drop（取消保留）";
  if (names.length === 0) {
    console.error(`用法：org ${retained ? "keep" : "drop"} <expert> [expert2 ...] [--workspace DIR]`);
    const experts = loadRegistryIndex(a.workspace);
    if (experts.length > 0) {
      const list = experts.map((m) => `  ${m.retained === false ? "○" : "★"} ${m.name}@${m.version} [${m.source}]`);
      console.error(`当前注册表：\n${list.join("\n")}`);
    }
    return 2;
  }
  // dist/demo 是入库快照（只读）—— 写入会污染编译产物层
  if (path.resolve(a.workspace) === path.join(ROOT, "dist", "demo")) {
    console.error("✗ dist/demo 是入库快照（只读）。请对真实工作区操作：org demo 后用 demo-run，或 --workspace <dir>");
    return 2;
  }
  if (!fs.existsSync(path.join(a.workspace, "registry/index.json"))) {
    console.error(`✗ 工作区 ${a.workspace} 无注册表（先 org demo / org run）`);
    return 2;
  }
  const { kept, missing } = setRetained(a.workspace, names, retained);
  if (kept.length > 0) {
    const mark = retained ? "★" : "○";
    console.log(`${mark} ${action}：${kept.join(", ")}（git 留痕）`);
    console.log(retained
      ? "  候选已转正：B 路径自动复用从下一轮派单开始命中。"
      : "  已取消保留：B 路径不再自动复用（显式寻址 ?专家 与 C 路径记忆化派单仍可用）。");
  }
  if (missing.length > 0) {
    console.error(`✗ 未在注册表找到：${missing.join(", ")}`);
    return 1;
  }
  return 0;
}

async function cmdStatus(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  console.log(`ORG status · 工作区 ${ws}\n`);
  // 注册表
  const index = path.join(ws, "registry/index.json");
  if (fs.existsSync(index)) {
    const experts = JSON.parse(fs.readFileSync(index, "utf-8")) as Array<Record<string, unknown>>;
    const candidates = experts.filter((m) => m.source === "factory" && m.retained === false);
    console.log("registry（磁盘资产层）：");
    for (const m of experts) {
      const mark = m.retained === false ? "○" : "★";
      const tag = m.retained === false ? "candidate" : "retained";
      console.log(`  ${mark} ${m.name}@${m.version} [${m.source}] eval=${m.eval_score} uses=${m.uses} ${tag} entry=${m.entry}`);
    }
    if (candidates.length > 0) {
      console.log(`\n  ○ 候选 ${candidates.length} 个未保留 —— B 路径不自动复用；org keep <name> 转正 / org drop <name> 取消保留`);
    }
  } else {
    console.log("registry：空（未初始化工作区）");
  }
  // 资产
  const memos = path.join(ws, "registry/memos/notice-parser.json");
  if (fs.existsSync(memos)) {
    const memo = JSON.parse(fs.readFileSync(memos, "utf-8")) as Record<string, { memos?: Record<string, string> }>;
    console.log(`\n固化 memo（notice-parser）：${Object.keys(memo.memos ?? {}).length} 条冻结映射`);
  }
  const mined = path.join(ws, "registry/fixtures-mined/reviews.json");
  if (fs.existsSync(mined)) {
    const m = JSON.parse(fs.readFileSync(mined, "utf-8")) as { tracks?: Record<string, unknown> };
    console.log(`基准题沉淀（journal→fixture）：${Object.keys(m.tracks ?? {}).length} 条轨道`);
  }
  const baseline = path.join(ws, "registry/scorecards");
  if (fs.existsSync(baseline)) {
    console.log(`评分卡基线：${fs.readdirSync(baseline).join(", ")}`);
  }
  const recurrence = path.join(ws, "runtime/recurrence.json");
  if (fs.existsSync(recurrence)) {
    const rec = JSON.parse(fs.readFileSync(recurrence, "utf-8")) as Record<string, number>;
    if (Object.keys(rec).length > 0) {
      console.log(`复发计数（补丁判据）：${JSON.stringify(rec)}`);
    }
  }
  // 会话账本（含上下文窗口占用 —— Codex 风格计量）
  const usages = listContextUsage(ws);
  if (usages.length > 0) {
    console.log("\n直连会话账本（上下文窗口占用 · GLM-4.5 窗口 128k tokens）：");
    for (const u of usages) {
      console.log(`  ${u.expert}/${u.session} ${u.turns} 轮 · 记账 ${u.billed} tokens · ctx ${renderContextMeter(u)}`);
    }
  }
  // git 历史
  const log = gitLogOf(ws);
  if (log.length > 0) {
    console.log(`\ngit 注册表历史（${log.length} commits）：`);
    for (const l of log.slice(0, 8)) console.log(`  ${l}`);
  }
  // 运行产物
  const runDirs = ["out-a", "out-b", "out-c", "out-latest", "out-ask", "out-direct", "out-handoff"]
    .map((d) => path.join(ws, d))
    .filter((d) => fs.existsSync(path.join(d, "run.json")));
  if (runDirs.length > 0) {
    console.log("\n历史运行：");
    for (const d of runDirs) {
      const rj = JSON.parse(fs.readFileSync(path.join(d, "run.json"), "utf-8")) as { ok: boolean; task?: string; elapsed_ms?: number };
      console.log(`  ${path.basename(d)} ok=${rj.ok} ${(rj.elapsed_ms ?? 0) / 1000 | 0}s ${(rj.task ?? "").slice(0, 40)}`);
    }
  }
  return 0;
}

async function cmdScore(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const candidates = ["out-c", "out-b", "out-a", "out-latest"]
    .map((d) => path.join(ws, d, "scorecard.json"))
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) {
    console.log("尚无评分卡（先跑 org demo / org run）");
    return 0;
  }
  const card = JSON.parse(fs.readFileSync(candidates[0]!, "utf-8")) as {
    model: string; evidence_count: number; cells: Array<{ cell: string; score: number; confidence: number }>;
  };
  console.log(`scorecard · model=${card.model} · evidence=${card.evidence_count}（来源 ${path.relative(ROOT, candidates[0]!)}）`);
  // 轴名匹配：cell 格式为 "能力轴|任务类"。--axis 同时接受两侧（能力轴或任务类），
  // 任一侧命中即保留——此前只匹配能力轴侧，README 示例的 structured_extract（任务类）
  // 过滤后沉默输出空列表（axis 拼写元反馈缺失）。
  const cells = a.axis
    ? card.cells.filter((c) => c.cell.startsWith(a.axis + "|") || c.cell.endsWith("|" + a.axis))
    : card.cells;
  for (const c of cells) {
    console.log(`  ${c.cell.padEnd(38)} score=${c.score.toFixed(3)} confidence(n)=${c.confidence}`);
  }
  if (a.axis && cells.length === 0) {
    // 空 results 必须给出可行动反馈：列出当前卡上真实的能力轴与任务类，
    // 拼写错误当场可见（此前空输出无法区分「无数据」与「过滤词拼错」）。
    const axes = [...new Set(card.cells.map((c) => c.cell.split("|")[0]!))];
    const classes = [...new Set(card.cells.map((c) => c.cell.split("|")[1]!))];
    console.log(`\n⚠ --axis "${a.axis}" 未命中任何 cell（格式 axis|task_class，两侧任一匹配）。`);
    console.log(`  可用能力轴：${axes.join(", ")}`);
    console.log(`  可用任务类：${classes.join(", ")}`);
  }
  console.log("\n证据分级：客观行为信号（verdict/budget/crystallize/canary/direct）权重 1.0；裁判档（shadow_compare）0.5。");
  return 0;
}

async function cmdReplay(a: Args): Promise<number> {
  if (!a.runDir || !fs.existsSync(path.join(a.runDir, "journal.jsonl"))) {
    console.error("✗ --run <dir> 需指向含 journal.jsonl 的运行产物目录（如 demo-run/out-a）");
    return 2;
  }
  const lines = fs.readFileSync(path.join(a.runDir, "journal.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim().length > 0);
  console.log(`replay · ${path.relative(ROOT, a.runDir)}（${lines.length} 条期刊记录，时间线重演）\n`);
  let lastPhase = "";
  for (const l of lines) {
    const parts = l.split("|");
    if (parts.length < 6) continue;
    const [, , phase, actor, action, detail] = parts;
    if (phase !== lastPhase) {
      console.log(`\n[阶段 ${phase}]`);
      lastPhase = phase;
    }
    console.log(`  ${actor.padEnd(10)} ${action.padEnd(14)} ${detail.slice(0, 90)}`);
  }
  console.log("\n（确定性重放 = journal + 代码版本；scripted 剧本即当时的模型响应录制）");
  return 0;
}

async function cmdCheck(): Promise<number> {
  console.log(`dhv check · ORG 全源码（解释器 ${path.relative(ROOT, DHV)}）\n`);
  const files: string[] = [];
  // 跳过本地运行时工作区（demo-run / demo-run-tests / out-ask 均 git 忽略）：
  // 测试跑过后 demo-run-tests 会出现铸出专家副本，check 的模块清单不应随本地
  // 状态漂移（稳定口径 = hsl/ 源码 + dist/ 入库产物 + .hsl-runs 之外的库文件）。
  const skip = new Set([".git", "node_modules", ".hsl-runs", "demo-run", "demo-run-tests", "out-ask"]);
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(p);
      } else if (e.name.endsWith(".hsl")) files.push(p);
    }
  };
  walk(ROOT);
  // 顺序：入口优先（其 import 链最先建立），stock 与 probe 随后
  files.sort((x, y) => {
    const rank = (p: string): number =>
      p.endsWith("org.hsl") ? 0 : p.includes("probe/") ? 2 : 1;
    return rank(x) - rank(y) || x.localeCompare(y);
  });
  let failed = 0;
  for (const f of files) {
    const ok = await checkFile(f);
    if (!ok) failed += 1;
  }
  console.log(`\n${failed === 0 ? "✓" : "✗"} ${files.length} 个 HSL 模块（${failed} 失败）`);
  return failed === 0 ? 0 : 1;
}

// ---- TUI（OpenCode 级终端前端；实现见 tui/，规格见 docs/tui-spec.md） ----
// 进程内加载（源码与编译二进制同路径；bun compile 会把 tui/ 静态打进单文件）
async function cmdTui(a: Args): Promise<number> {
  const { tuiMain } = await import("../tui/entry.ts");
  const args: string[] = [];
  if (a.workspace) args.push("--workspace", a.workspace);
  if (a.model && a.model !== "scripted") args.push("--model", a.model);
  args.push(...a.rest);
  return tuiMain(args);
}

// ---- Web GUI 原型（Bun.serve 零依赖；实现见 web/entry.ts） ----
// 进程内加载（与 cmdTui 同模式：bun compile 会把 web/ 静态打进单文件）
async function cmdWeb(a: Args): Promise<number> {
  const { webMain } = await import("../web/entry.ts");
  const args: string[] = [];
  if (a.workspace) args.push("--workspace", a.workspace);
  if (a.model && a.model !== "scripted") args.push("--model", a.model);
  args.push(...a.rest); // --port N 由此转交（parseArgs 不认识的旗标进 rest）
  return webMain(args);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs([cmd ?? "help", ...rest]);
  switch (a.cmd) {
    case "run": return cmdRun(a);
    case "demo": return cmdDemo(a);
    case "ask": return cmdAsk(a);
    case "handoff": return cmdHandoff(a);
    case "keep": return cmdKeep(a);
    case "drop": return cmdDrop(a);
    case "import": return cmdImport(a);
    case "status": return cmdStatus(a);
    case "score": return cmdScore(a);
    case "replay": return cmdReplay(a);
    case "check": return cmdCheck();
    case "tui": return cmdTui(a);
    case "web": return cmdWeb(a);
    default:
      console.log(`ORG — Organization Harness v${VERSION}（基于 HSL · BNF v1.5.0）

用法：
  org run --task "..." [--workspace DIR] [--model scripted|deepseek] [--fixture FILE]
      团队模式派单：分解 → 路由 → 派单 → 审查 → 汇总 → 资产沉淀
  org demo [--workspace DIR]
      全叙事演示：A 现场铸专家 / K 用户选取保留 / B 复用+补丁+金丝雀
      / C 蓝绿验证 / D 多轮直连 / E 暖移交
  org ask <expert> "<question>" [--session id] [--turns "q1|q2"]
      直连指定专家（事件上总线 · 花销记账 · 会话账本 · 纪要回写）
  org handoff <expert> --task "<request>"
      转接模式（主控移交摘要 → 专家代答 → 记账 + 纪要回写）
  org keep <expert> [expert2 ...] [--workspace DIR]
      工具库治理：选取保留 harness（工厂候选 → 转正，git 留痕）
  org drop <expert> [expert2 ...] [--workspace DIR]
      工具库治理：取消保留（B 路径不再自动复用；显式寻址仍可用）
  org import <file.hsl> [--name N] [--description "…"] [--capability a,b]
      工具库治理：导入你自己的 harness（check 闸门 → 入库 → 即刻可复用；
      描述缺省取 /// 文档注释 · 能力缺省扫描 #[capability] 注解）
  org status [--workspace DIR]
      库 / 池 / memo / 基准题 / 基线 / 复发计数 / 会话账本（含上下文窗口占用）
      / git 注册表历史（★ = 用户保留 · ○ = 工厂候选 · import = 用户导入）
  org score [--axis structured_output]
      模型评分卡（证据归因聚合）
  org replay --run <run-dir>
      确定性重放（journal 时间线重演）
  org check
      dhv check 全部 HSL 源码（hsl/ 源码 + dist/ 产物中的铸出专家）
  org tui [--workspace DIR] [":demo"|":replay out-…"]
      组织驾驶舱（OpenCode 级终端前端）：三区布局 · 事件卡片流 · 四态裁决徽标
  org web [--port N] [--workspace DIR]
      Web GUI 原型（Bun.serve 零依赖，默认 4600）：专家卡 + 会话侧栏 + 对话
      视图（观测元数据 tokens/耗时/ctx 窗口计量；scripted 占位剧本秒回）

仓库布局：hsl/ = HSL 源码；toolchain/dhv-ts = 内嵌解释器（vendored）；
          demo-run/ = 本地构建目录（git 忽略）；dist/ = 编译产物（入库）

环境变量：ORG_CAPABILITY_APPROVED=1 批准能力变更补丁（仅用户）；
          ORG_REDUNDANCY>=2 启用 N 版本冗余；
          DHV_TS 覆盖内嵌工具链。`);
      return 0;
  }
}

process.exit(await main());
