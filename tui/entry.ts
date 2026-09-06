// ============================================================================
// org/tui/entry.ts — TUI 入口逻辑（CLI 进程内复用 + 独立执行共用）
// ----------------------------------------------------------------------------
//   tui/main.tsx          独立执行入口（import.meta.main 守卫）
//   cli/org.ts cmdTui     org tui 子命令（进程内 import 本文件）
// 解析规则：
//   --workspace/-w DIR · --model/-m scripted|deepseek · --print [--demo]
//   位置参数 = 启动后立即执行的命令（":demo" / ":replay out-a" / 任务文本）
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { App } from "./app.tsx";
import { initialState, reducer, pushEngineEvent } from "./store.ts";
import { renderFrame } from "./frame.ts";
import { Screen } from "./renderer.ts";
import { replayRun, scanWorkspace, ensureWorkspace, readScorecard } from "../lib/engine.ts";
import { ROOT, DEFAULT_WORKSPACE } from "../lib/root.ts";

export interface TuiParsed {
  workspace: string;
  model: string;
  print: boolean;
  printDemo: boolean;
  command: string | null;
}

export function parseTuiArgv(argv: string[]): TuiParsed {
  const p: TuiParsed = {
    workspace: process.env.ORG_WORKSPACE ?? DEFAULT_WORKSPACE,
    model: "scripted",
    print: false,
    printDemo: false,
    command: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--workspace" || a === "-w") p.workspace = path.resolve(argv[++i] ?? p.workspace);
    else if (a === "--model" || a === "-m") p.model = argv[++i] ?? "scripted";
    else if (a === "--print") p.print = true;
    else if (a === "--demo") p.printDemo = true;
    else if (!a.startsWith("-")) p.command = a;
  }
  return p;
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** --print：组合一帧纯文本。--demo 时先重演团队会话（dist/demo 快照兜底）再渲染。 */
export function printFrame(p: TuiParsed): number {
  let state = initialState({
    workspace: p.workspace,
    cols: Math.max(100, process.stdout.columns ?? 118),
    rows: Math.max(30, process.stdout.rows ?? 38),
  });
  // 左栏数据（会话/专家库/固化 memo）同步真实工作区
  try {
    ensureWorkspace(p.workspace);
    state = reducer(state, { type: "workspace", info: scanWorkspace(p.workspace) });
  } catch { /* 尽力而为 */ }
  if (p.printDemo) {
    // 优先团队模式会话（任务不以 ( 开头——排除 direct/handoff），dist/demo 快照兜底
    const sessions = scanWorkspace(p.workspace).sessions;
    const team = sessions.filter((s) => !s.task.startsWith("("));
    let dir = (team[0] ?? sessions[0])?.dir;
    if (!dir) {
      const snap = path.join(ROOT, "dist", "demo", "out-a");
      if (dirExists(snap)) dir = snap;
    }
    if (!dir) {
      process.stderr.write("没有可重演的会话（先 org demo 或跑一次任务）\n");
      return 1;
    }
    const data = replayRun(dir);
    for (const ev of data.events) state = pushEngineEvent(state, ev);
    const rj = data.runJson;
    state = reducer(state, {
      type: "replayDone",
      ok: rj ? rj.ok === true : false,
      deliverables: data.metrics?.deliverables,
      assets: data.metrics?.assets,
      modelCalls: data.metrics?.model_calls_total,
      revises: data.metrics?.revises_total,
      elapsedMs: rj?.elapsed_ms,
    });
    const sc = readScorecard(path.join(dir, "scorecard.json"));
    if (sc) {
      state = reducer(state, { type: "scoreCard", model: sc.model, evidence: sc.evidence_count, cells: sc.cells });
    }
    state = { ...state, currentSession: path.basename(dir), mode: "replay" };
  }
  process.stdout.write(Screen.toPlainText(renderFrame(state)) + "\n");
  return 0;
}

/** TUI 主入口（独立执行与 org tui 子命令共用）。返回退出码。 */
export async function tuiMain(argv: string[]): Promise<number> {
  const p = parseTuiArgv(argv);
  if (p.print) return printFrame(p);

  if (!process.stdout.isTTY) {
    process.stderr.write(
      "org tui 需要交互终端（TTY）。非交互场景可用：\n" +
      "  org tui --print [--demo]    渲染一帧纯文本\n" +
      "  org run / org demo          无界面运行\n",
    );
    return 2;
  }

  const app = new App({ workspace: p.workspace, model: p.model });
  process.on("SIGINT", () => { app.stop(); process.exit(0); });
  process.on("SIGTERM", () => { app.stop(); process.exit(0); });
  app.boot(p.command ?? undefined);
  // 常驻：stdin 数据流 / 定时器保活；退出统一走 app.stop() + process.exit
  await new Promise<void>(() => { /* never */ });
  return 0;
}
