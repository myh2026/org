// ============================================================================
// lib/retest.ts — 选择性重跑 / flaky 管理（v0.5.22 · capabilities #104）
// ----------------------------------------------------------------------------
// 单一实现三端消费：CLI `org retest plan|run` · 工具环 `retest_plan`（只读 ——
// 生成重跑计划不执行）· Web GET /api/govex/retest。
//
// 四层结构：
//   ① 测试文件发现：workspace tests/*.test.ts（bun test 约定布局，平铺一层）。
//   ② 选择器：--file（glob 或子串）/ --name（子串 → bun test -t 模式）/
//      --failed-only（台账最新一轮的失败集 → 文件集合）。
//   ③ flaky 台账：<ws>/runtime/flaky.jsonl —— append-only JSONL（与审计账本
//      同哲学：只追加不改写；坏行容忍计数不炸）。每行一轮 run 记录
//      { ts, run, command, exitCode, results:[{file,name,pass}] }；
//      test 键 = file::name，**连续 2 次失败**标记 flaky（再 pass 即解除）。
//   ④ 重跑命令生成：`bun test <files> --timeout 120000 [-t <pattern>]`
//      （B-15 超时纪律：逐例 120s 是既定档案，命令行显式携带）。
//
// 诚实边界：
//   · 发现面 = tests/ 平铺一层（bun test 约定）；嵌套子目录测试文件不在
//     自动发现面内（可用 --file 显式给路径）。
//   · 结果解析 = bun test 默认 reporter 的 `(pass)/(fail) name [x.xms]` 行协议
//     （管道形态无色）；bun 升级改输出格式时解析器需同步 —— 解析不到任何
//     结果时如实返回零结果并保留原始 exitCode，不猜。
//   · flaky 判据 = 连续 2 次失败（本批口径）；经典「间歇通过率」统计
//     （pass/fail 比例阈值）是路线图。
//   · retest_run 真跑 bun test（用户亲自触发，与 CLI 直跑同级）；工具环只
//     提供 retest_plan（只读 —— 计划不执行）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- ③ flaky 台账 -------------------------------------------------------------

/** 台账相对路径（append-only JSONL）。 */
export const FLAKY_LEDGER_REL = "runtime/flaky.jsonl";

export interface FlakyTestResult {
  /** 工作区相对路径（正斜杠；bun test 输出的文件头）。 */
  file: string;
  /** 完整测试名（describe > test 形态，bun test 原样）。 */
  name: string;
  pass: boolean;
}

export interface FlakyRunRecord {
  ts: string;
  /** 轮次号（单调递增，1 基）。 */
  run: number;
  /** 本轮执行的完整命令（回放/审计锚点）。 */
  command: string;
  exitCode: number | null;
  results: FlakyTestResult[];
}

export function flakyLedgerPath(ws: string): string {
  return path.join(ws, FLAKY_LEDGER_REL);
}

/** 读台账（坏行容忍 —— 坏行计数不炸；文件缺席 = 空台账）。 */
export function readFlakyLedger(ws: string): { records: FlakyRunRecord[]; bad: number } {
  const p = flakyLedgerPath(ws);
  let text: string;
  try {
    text = fs.readFileSync(p, "utf-8");
  } catch {
    return { records: [], bad: 0 };
  }
  const records: FlakyRunRecord[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as FlakyRunRecord;
      if (r && typeof r === "object" && Array.isArray(r.results) && Number.isFinite(r.run)) {
        records.push({
          ts: String(r.ts ?? ""),
          run: Number(r.run),
          command: String(r.command ?? ""),
          exitCode: r.exitCode === null || r.exitCode === undefined ? null : Number(r.exitCode),
          results: r.results.filter((x) => x && typeof x.name === "string").map((x) => ({ file: String(x.file ?? ""), name: String(x.name), pass: Boolean(x.pass) })),
        });
      } else {
        bad++;
      }
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

/** 追加一轮记录（append-only；runtime/ 目录自动创建）。 */
export function appendFlakyRecord(ws: string, rec: FlakyRunRecord): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(path.dirname(flakyLedgerPath(ws)), { recursive: true });
    fs.appendFileSync(flakyLedgerPath(ws), JSON.stringify(rec) + "\n", "utf-8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `台账写入失败：${String((e as Error).message ?? e)}` };
  }
}

/** 下一轮次号（台账最大 run + 1）。 */
export function nextRunNumber(records: FlakyRunRecord[]): number {
  return records.reduce((m, r) => Math.max(m, r.run), 0) + 1;
}

export interface FlakyEntry {
  /** 台账键：file::name（同名测试跨文件不混账）。 */
  key: string;
  file: string;
  name: string;
  /** 时间序历史（老 → 新）。 */
  history: Array<"pass" | "fail">;
  runs: number;
  fails: number;
  /** 连续 2 次失败 → true（再 pass 即解除）。 */
  flaky: boolean;
}

export interface FlakySummary {
  entries: FlakyEntry[];
  flakyCount: number;
  /** 台账总轮数。 */
  runs: number;
  /** 坏行计数（诚实降级标注）。 */
  bad: number;
}

/** flaky 汇总：按 file::name 聚合历史，连续 2 败标记 flaky。 */
export function flakySummary(ws: string): FlakySummary {
  const { records, bad } = readFlakyLedger(ws);
  const byKey = new Map<string, FlakyEntry>();
  for (const rec of records) {
    for (const r of rec.results) {
      const key = `${r.file}::${r.name}`;
      let e = byKey.get(key);
      if (!e) {
        e = { key, file: r.file, name: r.name, history: [], runs: 0, fails: 0, flaky: false };
        byKey.set(key, e);
      }
      e.history.push(r.pass ? "pass" : "fail");
      e.runs++;
      if (!r.pass) e.fails++;
    }
  }
  const entries = [...byKey.values()].map((e) => ({
    ...e,
    flaky: e.history.length >= 2 && e.history[e.history.length - 1] === "fail" && e.history[e.history.length - 2] === "fail",
  }));
  entries.sort((a, b) => (a.flaky === b.flaky ? a.key.localeCompare(b.key) : a.flaky ? -1 : 1));
  return { entries, flakyCount: entries.filter((e) => e.flaky).length, runs: records.length, bad };
}

// ---- ①②④ 发现 + 选择器 + 计划生成 ---------------------------------------------

/** 测试文件发现：workspace tests/*.test.ts（bun test 约定平铺；排序稳定）。 */
export function discoverTestFiles(ws: string): string[] {
  const dir = path.join(ws, "tests");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // tests/ 不存在 → 空（调用方诚实报「无测试文件」）
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => `tests/${e.name}`)
    .sort();
}

export interface RetestPlan {
  ok: boolean;
  /** 工作区相对测试文件（重跑目标集）。 */
  files: string[];
  /** --name 子串（进 bun test -t；failed-only 不自动生成）。 */
  namePattern?: string;
  /** failed-only 命中的失败测试名（观测面）。 */
  failedNames?: string[];
  /** 完整可执行命令（重跑交付物）。 */
  command: string;
  flakyCount: number;
  /** 诚实说明（如 failed-only 台账为空）。 */
  note?: string;
  error?: string;
}

/** --file 过滤：glob（含通配符）或子串。 */
function filterByFilePattern(files: string[], pattern: string): string[] {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/[*?[]/.test(p)) {
    const g = new Bun.Glob(p);
    return files.filter((f) => g.match(f) || g.match(path.posix.basename(f)));
  }
  return files.filter((f) => f === p || f === `tests/${p}` || f.includes(p));
}

/** 生成重跑计划（只读 —— 不执行任何测试）。 */
export function retestPlan(ws: string, opts: { file?: string; name?: string; failedOnly?: boolean } = {}): RetestPlan {
  const all = discoverTestFiles(ws);
  if (all.length === 0) {
    return { ok: false, files: [], command: "", flakyCount: 0, error: "工作区 tests/ 下未发现 *.test.ts（bun test 约定布局；嵌套目录请用 --file 显式指定）" };
  }
  const flaky = flakySummary(ws);
  let files = all;
  let failedNames: string[] | undefined;
  let note: string | undefined;

  if (opts.file) {
    files = filterByFilePattern(files, opts.file);
    if (files.length === 0) {
      return { ok: false, files: [], command: "", flakyCount: flaky.flakyCount, error: `--file "${opts.file}" 无命中（可用文件：${all.slice(0, 6).join(" ")}${all.length > 6 ? " …" : ""}）` };
    }
  }
  if (opts.failedOnly) {
    // 台账最新一轮（run 号最大）的失败集
    const { records } = readFlakyLedger(ws);
    const latest = records.length > 0 ? records.reduce((a, b) => (b.run > a.run ? b : a)) : null;
    if (!latest || latest.results.length === 0) {
      return { ok: false, files: [], command: "", flakyCount: flaky.flakyCount, error: "flaky 台账为空（或最新一轮无逐例结果）—— 先 org retest run 跑一轮，或去掉 --failed-only" };
    }
    const failed = latest.results.filter((r) => !r.pass);
    if (failed.length === 0) {
      return { ok: false, files: [], command: "", flakyCount: flaky.flakyCount, error: `最新一轮（run #${latest.run}）全绿 —— 无失败可重跑` };
    }
    failedNames = failed.map((r) => r.name);
    const failedFiles = [...new Set(failed.map((r) => r.file))].filter((f) => f && fs.existsSync(path.join(ws, f)));
    if (failedFiles.length > 0) files = opts.file ? files.filter((f) => failedFiles.includes(f)) : failedFiles;
    note = `failed-only：run #${latest.run} 的 ${failed.length} 个失败（${failedFiles.length} 文件）`;
  }
  if (files.length === 0) {
    return { ok: false, files: [], command: "", flakyCount: flaky.flakyCount, error: "选择器交集为空（--file 与 --failed-only 叠加无命中）" };
  }

  const name = opts.name ? String(opts.name).trim() : "";
  const parts = ["bun", "test", ...files, "--timeout", "120000"];
  if (name) parts.push("-t", name);
  return {
    ok: true,
    files,
    ...(name ? { namePattern: name } : {}),
    ...(failedNames ? { failedNames } : {}),
    command: parts.join(" "),
    flakyCount: flaky.flakyCount,
    ...(note ? { note } : {}),
  };
}

// ---- retest run（真跑 + 解析 + 记账） -------------------------------------------

/** ANSI 色码剥离（管道形态本无色 —— 防御 TTY 形态）。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 解析 bun test 默认 reporter 输出：文件头 `tests/x.test.ts:` + `(pass)/(fail) name [x.xms]`。 */
export function parseBunTestOutput(text: string): FlakyTestResult[] {
  const out: FlakyTestResult[] = [];
  let file = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = stripAnsi(raw);
    const fm = line.match(/^(\S+\.test\.ts):\s*$/);
    if (fm) {
      file = fm[1]!.replace(/\\/g, "/");
      continue;
    }
    // (pass) name [1.23ms] / (fail) name —— 尾部计时可选
    const rm = line.match(/^\((pass|fail)\)\s+(.+?)(?:\s+\[[0-9.]+m?s\])?\s*$/);
    if (rm) {
      out.push({ file, name: rm[2]!, pass: rm[1] === "pass" });
    }
  }
  return out;
}

export interface RetestRunResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  passed: number;
  failed: number;
  results: FlakyTestResult[];
  /** 本轮之后新落入 flaky 态的测试键（file::name）。 */
  flakyAfter: string[];
  /** 台账追加结果。 */
  recorded: boolean;
  error?: string;
}

/** 执行重跑（真跑 bun test；结果解析 + 台账记账）。用户亲自触发车道 ——
 *  工具环只提供只读的 retest_plan。 */
export function retestRun(ws: string, opts: { file?: string; name?: string; failedOnly?: boolean; timeoutMs?: number }): RetestRunResult {
  const plan = retestPlan(ws, opts);
  if (!plan.ok) {
    return { ok: false, command: "", exitCode: null, passed: 0, failed: 0, results: [], flakyAfter: [], recorded: false, error: plan.error };
  }
  let spawn: { exitCode: number | null; stdout: string; stderr: string } | null;
  try {
    const argv = [process.execPath, "test", ...plan.files.map((f) => f.replace(/\\/g, "/")), "--timeout", "120000"];
    if (plan.namePattern) argv.push("-t", plan.namePattern);
    spawn = (() => {
      try {
        const r = Bun.spawnSync(argv, {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          timeout: opts.timeoutMs ?? 600_000,
          cwd: ws,
          env: process.env,
        } as Parameters<typeof Bun.spawnSync>[1]);
        return { exitCode: r.exitCode, stdout: (r.stdout?.toString() ?? ""), stderr: (r.stderr?.toString() ?? "") };
      } catch {
        return null;
      }
    })();
  } catch {
    spawn = null;
  }
  if (spawn === null) {
    return { ok: false, command: plan.command, exitCode: null, passed: 0, failed: 0, results: [], flakyAfter: [], recorded: false, error: `bun test 执行失败/超时（${opts.timeoutMs ?? 600_000}ms）` };
  }
  const results = parseBunTestOutput(spawn.stdout + "\n" + spawn.stderr);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  // 台账记账（append-only；记账失败不吞测试结果 —— recorded 如实标注）
  const { records } = readFlakyLedger(ws);
  const before = new Set(flakySummary(ws).entries.filter((e) => e.flaky).map((e) => e.key));
  const rec: FlakyRunRecord = {
    ts: new Date().toISOString(),
    run: nextRunNumber(records),
    command: plan.command,
    exitCode: spawn.exitCode,
    results,
  };
  const append = appendFlakyRecord(ws, rec);
  const after = flakySummary(ws).entries.filter((e) => e.flaky).map((e) => e.key);

  return {
    ok: spawn.exitCode === 0,
    command: plan.command,
    exitCode: spawn.exitCode,
    passed,
    failed,
    results,
    flakyAfter: after.filter((k) => !before.has(k)),
    recorded: append.ok,
    ...(append.ok ? {} : { error: append.error }),
  };
}

/** 配置指引（CLI 帮助）。 */
export function retestGuidance(): string {
  return "选择性重跑 / flaky 管理（#104）：org retest plan [--file 模式] [--name 子串] [--failed-only] 生成重跑命令；org retest run 执行并记入 runtime/flaky.jsonl 台账（连续 2 败标记 flaky）。工具环 retest_plan 只读。";
}
