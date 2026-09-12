// ============================================================================
// tests/helpers.ts — 测试基础设施
// ----------------------------------------------------------------------------
// 文件顶层副作用：把 bun test 的默认每用例超时从 5000ms 提到 120s。
//
// 为什么需要：本套件是端到端机制测试 —— 用例体真的 spawn 一次 dhv-ts 解释器
// 跑完整监督回路（工厂铸专家 + 过程审查返工 + 固化 + 补丁 + 金丝雀），实测单轮
// 3–14s（多轮用例 11–14s）。默认 5000ms 下 26 例在普通开发机上必然假红，且失效
// 形态极易误诊：bun 超时后会 kill 该用例派生的子进程，断言读到的是「子进程非零
// 退出」，看起来像产品缺陷而不是超时。
//
// 为什么放在这里而不是 bunfig.toml / tests/setup.ts：bunfig 的 [test] 段没有
// timeout 键（实测写上仍按 5000ms 生效），而 [test] preload 只在**单文件**调用时
// 生效，`bun test tests/` 这种多文件（并行 worker）形态下 preload 不会作用于
// worker —— 实测同一条 6s 用例单跑通过、全量跑仍报 5000ms 超时。helpers.ts 是
// 各测试文件在用例注册前就求值的公共模块，副作用落在正确的时机与进程里。
//
// 120s 与 demo.test.ts 既有的显式 120_000 取值一致 —— 放宽的是等待上限，
// 不是断言标准（断言一字未改）。纯单测文件（config/chat/gate/gateway）不 import
// 本模块也不受影响：它们本来就在毫秒级完成。
// ============================================================================

import { setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";

setDefaultTimeout(120_000);

export const ROOT = path.resolve(import.meta.dir, "..");
export const DHV = path.join(ROOT, "toolchain/dhv-ts/src/main.ts");
export const CLI = path.join(ROOT, "cli/org.ts");
export const FIXTURE = path.join(ROOT, "fixtures/run-notices.json");
export const TEST_RUN = path.join(ROOT, "demo-run-tests");

/** 传给 bash 执行环境的路径统一正斜杠（与 CLI 同规则）。 */
export function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface RunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 直接驱动解释器（等价 org run 的底层调用）。 */
export function runDhv(args: string[], env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, DHV, ...args], {
    cwd: ROOT,
    env: { ...process.env, DHV_TS: shPath(DHV), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** 驱动 org CLI。 */
export function runOrg(args: string[], env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, DHV_TS: shPath(DHV), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** 一次完整监督回路运行（单轮 org run 的等价物）。 */
export function runOrgRun(workspace: string, out: string, env: Record<string, string> = {}, task = "抓取某站点近一周公告，输出结构化表格"): RunResult {
  return runDhv(
    [
      "run", "hsl/org.hsl",
      "--workspace", workspace,
      "--task", task,
      "--model", "scripted",
      "--fixture", FIXTURE,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ],
    env,
  );
}

/** 构造一次性测试工作区（demo-ws 模板 + git 注册表）。 */
export function makeWorkspace(name: string): string {
  const ws = path.join(TEST_RUN, name);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
  for (const args of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "org@test"],
    ["git", "config", "user.name", "org-test"],
    ["git", "add", "-A"],
    ["git", "commit", "-q", "-m", "registry template"],
  ] as const) {
    Bun.spawnSync(args as unknown as string[], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  }
  return ws;
}

export function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export interface OrgEvent { seq: number; ts: string; name: string; data?: Record<string, any> }

export function eventsOf(outDir: string): OrgEvent[] {
  const p = path.join(outDir, "events.jsonl");
  if (!exists(p)) return [];
  return fs.readFileSync(p, "utf-8")
    .split("\n").filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as OrgEvent);
}

export function countEvents(events: OrgEvent[], name: string): number {
  return events.filter((e) => e.name === name).length;
}

export function journalEvents(events: OrgEvent[], action: string): Array<Record<string, any>> {
  return events.filter((e) => e.name === "journal" && e.data?.name === action)
    .map((e) => e.data as Record<string, any>);
}

export function metricsOf(ws: string, id: string): Record<string, any> | null {
  const p = path.join(ws, `out-${id}`, "metrics.json");
  if (!exists(p)) return null;
  return readJson(p);
}

/** 修改 fixture 轨道（测试变体剧本）。 */
export function fixtureVariant(mod: (fixture: any) => void): string {
  const base = readJson(FIXTURE);
  mod(base);
  const out = path.join(TEST_RUN, `fixture-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.mkdirSync(TEST_RUN, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(base, null, 2));
  return out;
}

/** 用变体剧本跑一轮。 */
export function runVariant(workspace: string, out: string, fixturePath: string, env: Record<string, string> = {}): RunResult {
  return runDhv(
    [
      "run", "hsl/org.hsl",
      "--workspace", workspace,
      "--task", "抓取某站点近一周公告，输出结构化表格",
      "--model", "scripted",
      "--fixture", fixturePath,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ],
    env,
  );
}
