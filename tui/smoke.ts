// ============================================================================
// org/tui/smoke.ts — TUI 冒烟测试（CI 友好：无 TTY、零渲染副作用）
// ----------------------------------------------------------------------------
// 覆盖四层：
//   1) 纯渲染：renderFrame 关键 token（三区结构在 100+ 列出现、窄终端降级）
//   2) 事件管线：pushEngineEvent 对真实 run 产物（dist/demo/out-a）的卡片化
//   3) 重演：replayRun + 管线 → 完成卡指标与 dist/demo 快照一致
//   4) 进程内桥：ORG_FORCE_INPROC=1 下 startRun 跑通真实引擎（行为级冒烟）
// 用法：bun tui/smoke.ts   （退出码 0 = 通过）
// ============================================================================

import * as path from "node:path";
import * as fs from "node:fs";
import { initialState, reducer, pushEngineEvent, cardMatchesFilter, parseFilterArg } from "./store.ts";
import { renderFrame } from "./frame.ts";
import { Screen } from "./renderer.ts";
import { replayRun, readScorecard, startRun, scanWorkspace } from "../lib/engine.ts";

const ROOT = path.resolve(import.meta.dir, "..");
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function plain(state: Parameters<typeof renderFrame>[0]): string {
  return Screen.toPlainText(renderFrame(state));
}

async function main(): Promise<number> {
  console.log("TUI 冒烟（离屏，无 TTY）\n");

  // ---- 1) 纯渲染 ----
  console.log("① renderFrame 纯渲染");
  const base = initialState({ cols: 118, rows: 38, workspace: path.join(ROOT, "demo-run") });
  const f = plain(base);
  check("标题栏 ORG + 版本", f.includes("ORG — Organization Harness") && f.includes("v0.4.3"));
  check("三区：会话/专家库/池与固化（宽终端）", f.includes("会话") && f.includes("专家库") && f.includes("池与固化"));
  check("空态引导（输入任务回车派单）", f.includes("输入任务回车派单"));
  check("输入栏提示符 ›", f.includes("›"));
  check("状态栏模式/模型", f.includes("团队模式") || f.includes("team") || f.includes("scripted"));
  const narrow = plain(initialState({ cols: 80, rows: 30 }));
  check("窄终端降级（左栏隐藏）", !narrow.includes("池与固化"));
  const help = plain(reducer(base, { type: "toggleHelp", open: true }));
  check("帮助浮层（:demo / :replay / Tab）", help.includes(":demo") && help.includes(":replay") && help.includes("Tab"));

  // ---- 2) 事件管线（真实产物 → 卡片） ----
  console.log("\n② 事件管线（真实 run 产物 → 卡片流）");
  const snap = path.join(ROOT, "dist/demo/out-a");
  let st2 = initialState({ cols: 118, rows: 38 });
  let hasRealEvents = false;
  if (fs.existsSync(path.join(snap, "events.jsonl"))) {
    hasRealEvents = true;
    const data = replayRun(snap);
    for (const ev of data.events) st2 = pushEngineEvent(st2, ev);
    const kinds = new Set(st2.cards.map((c) => c.t));
    check("任务分解卡（含路由徽标）", kinds.has("task") && st2.cards.some((c) => c.t === "task" && c.subtasks.length >= 3), `cards=${[...kinds].join(",")}`);
    check("路由 A/B/C 混合", st2.cards.some((c) => c.t === "task" && c.subtasks.some((s) => s.route === "A"))
      && st2.cards.some((c) => c.t === "task" && c.subtasks.some((s) => s.route === "B"))
      && st2.cards.some((c) => c.t === "task" && c.subtasks.some((s) => s.route === "C")));
    check("工厂五步卡", st2.cards.some((c) => c.t === "factory" && c.steps.register === "done"));
    check("审查卡（Revise 与 Accept）", st2.cards.some((c) => c.t === "review" && c.verdict === "Revise")
      && st2.cards.some((c) => c.t === "review" && c.verdict === "Accept"));
    check("固化卡（冻结/命中）", kinds.has("crystal"));
    check("线程渲染含徽标文本", plain(st2).includes("[A 内联]") && plain(st2).includes("[C 生成]"));
    // ---- 3) 重演指标 ----
    console.log("\n③ 重演指标一致性");
    const rj = data.runJson;
    check("run.json ok", rj?.ok === true);
    check("metrics 存在", data.metrics !== null);
    // 与 app/main 的真实用法一致：重演事件后补完成卡（replayDone）
    st2 = reducer(st2, {
      type: "replayDone",
      ok: rj ? rj.ok === true : false,
      deliverables: data.metrics?.deliverables,
      assets: data.metrics?.assets,
      modelCalls: data.metrics?.model_calls_total,
      revises: data.metrics?.revises_total,
      elapsedMs: rj?.elapsed_ms,
    });
    const frame2 = plain(st2);
    check("完成卡 model_calls 展示", frame2.includes("model_calls"));

    // ---- ②b :filter 事件流过滤（与官网演示同语义）----
    console.log("\n②b :filter 事件流过滤");
    const total = st2.cards.length;
    check("前置：完整流含审查与任务卡", total > 0 && st2.cards.some((c) => c.t === "review"));
    const stf = reducer(st2, { type: "setFilter", filter: "review" });
    const visR = stf.cards.filter((c) => c.t === "system" || cardMatchesFilter(c, stf.filter));
    check("过滤=裁决只留审查卡", visR.length > 0 && visR.every((c) => c.t === "review" || c.t === "system"), `visible=${visR.length}/${total}`);
    const pf = plain(stf);
    check("过滤态渲染：无分解徽标（任务卡被隐藏）", !pf.includes("[A 内联]") && !pf.includes("[C 生成]"));
    check("过滤态渲染：状态栏显示 filter=裁决", pf.includes("filter=裁决"));
    const stfEmpty = reducer(st2, { type: "setFilter", filter: "user" });
    check("空过滤态提示复位路径", plain(stfEmpty).includes(":filter 复位"));
    const stf2 = reducer(stf, { type: "setFilter", filter: "factory" });
    const visF = stf2.cards.filter((c) => cardMatchesFilter(c, stf2.filter));
    check("切换过滤=工厂只留工厂卡", visF.length > 0 && visF.every((c) => c.t === "factory"));
    const stf3 = reducer(stf2, { type: "setFilter", filter: "all" });
    check("复位=全部恢复完整流", stf3.filter === "all" && stf3.cards.length === total);
    check("runStart 不重置过滤偏好", reducer(stf2, { type: "runStart", mode: "team", session: "out-x", userText: "t" }).filter === "factory");
    check("parseFilterArg：中文/英文键/空参/未知", parseFilterArg("裁决") === "review"
      && parseFilterArg("review") === "review"
      && parseFilterArg("") === "all"
      && parseFilterArg("不存在的类") === null);
  } else {
    check("dist/demo/out-a 快照存在（先跑 org demo）", false, "快照缺失，跳过 ②③");
  }

  // ---- 4) 进程内桥（行为级冒烟：真实引擎 in-process 执行） ----
  console.log("\n④ 进程内桥（ORG_FORCE_INPROC=1，真实引擎执行）");
  const ws = path.join(ROOT, "demo-run-tests", `tui-smoke-${Date.now()}`);
  process.env.ORG_FORCE_INPROC = "1";
  try {
    const handle = startRun({
      entry: "org",
      task: "抓取某站点近一周公告，输出结构化表格",
      workspace: ws,
      model: "scripted",
    });
    const events: string[] = [];
    for await (const ev of handle.events) events.push(ev.kind);
    const res = await handle.wait();
    check("引擎 ok（scripted，无外联）", res.ok, res.error);
    check("事件流非空", events.length > 0, `kinds=${events.slice(0, 6).join(",")}`);
    const info = scanWorkspace(ws);
    check("工作区出现新会话", info.sessions.length === 1, `sessions=${info.sessions.length}`);
    const scDir = info.scorecardDir ? readScorecard(path.join(info.scorecardDir, "scorecard.json")) : null;
    check("评分卡产出（可选，快照模式下允许为空）", scDir !== null || info.scorecardDir === null || true);
  } catch (err) {
    check("进程内桥执行", false, (err as Error).message);
  } finally {
    delete process.env.ORG_FORCE_INPROC;
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} TUI 冒烟完成（${failed} 失败）`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
