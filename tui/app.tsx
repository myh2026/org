// ============================================================================
// org/tui/app.tsx — 主应用：store 接线 + 键盘路由 + 引擎桥 + 帧循环
// ----------------------------------------------------------------------------
// 职责边界：store.ts 是纯状态管线；本文件是唯一副作用面（stdin/stdout/
// 子进程/定时器）。渲染帧每 100ms 检查一次，内容无变化不写终端。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import {
  initialState, reducer, withDemoCall, parseFilterArg, FILTERS,
  type TuiState, type Action, type Focus,
} from "./store.ts";
import { THEMES, THEME_ORDER, parseThemeName } from "./theme.ts";
import { Screen } from "./renderer.ts";
import { renderFrame } from "./frame.ts";
import {
  startRun, scanWorkspace, replayRun, latestScorecardDir,
  ensureWorkspace, resetWorkspace, gitShortLog, setRetained, keepAllCandidates,
  importHarness,
  type RunHandle, type Scorecard,
} from "../lib/engine.ts";
import type { EngineEvent } from "../lib/events.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const TICK_MS = 100;

export interface AppOptions {
  workspace: string;
  model: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export class App {
  private state: TuiState;
  private screen: Screen;
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private raw = false;
  private running: RunHandle | null = null;
  private demoActive = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastCols = 0;
  private lastRows = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AppOptions) {
    this.stdin = opts.stdin ?? (process.stdin as NodeJS.ReadStream);
    this.stdout = opts.stdout ?? (process.stdout as NodeJS.WriteStream);
    this.state = initialState({
      workspace: opts.workspace,
      model: opts.model,
      cols: this.stdout.columns ?? 120,
      rows: this.stdout.rows ?? 36,
    });
    this.screen = new Screen(this.stdout, THEMES[this.state.theme]);
    this.lastCols = this.state.cols;
    this.lastRows = this.state.rows;
  }

  // ---------- 生命周期 ----------

  boot(initialCommand?: string): void {
    this.screen.enter();
    this.refreshWorkspace();
    this.enableRaw();
    if (this.raw) {
      this.stdin.on("data", (chunk) => this.onKey(chunk as Buffer));
      this.stdin.resume();
    } else {
      // 非 TTY 降级：仍可渲染（等待 EOF/信号），并提示
      this.dispatch({ type: "notice", text: "非交互终端：键位不可用（可用 :print 模式输出帧）", tone: "warn" });
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (initialCommand) {
      // 面向 `org tui ":demo"` 的直接派发（带 300ms 延迟让首帧先出）
      setTimeout(() => this.submit(initialCommand), 300);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.running) void this.running.cancel();
    this.disableRaw();
    this.screen.exit();
  }

  private tick(): void {
    if (this.stopped) return;
    const cols = this.stdout.columns ?? this.state.cols;
    const rows = this.stdout.rows ?? this.state.rows;
    if (cols !== this.lastCols || rows !== this.lastRows) {
      this.lastCols = cols;
      this.lastRows = rows;
      this.dispatch({ type: "resize", cols, rows });
    }
    if (this.state.engine === "running") this.dispatch({ type: "tick" });
    if (this.state.notice) {
      // notice 3.5s 自动消失
      if (!this.noticeTimer) {
        this.noticeTimer = setTimeout(() => {
          this.noticeTimer = null;
          this.dispatch({ type: "dismissNotice" });
        }, 3500);
      }
    }
    this.draw();
  }

  private draw(): void {
    this.screen.setTheme(THEMES[this.state.theme]);
    this.screen.draw(renderFrame(this.state));
  }

  private dispatch(a: Action): void {
    this.state = reducer(this.state, a);
  }

  // ---------- 键盘 ----------

  private enableRaw(): void {
    try {
      if (this.stdin.isTTY && typeof this.stdin.setRawMode === "function") {
        this.stdin.setRawMode(true);
        this.raw = true;
      }
    } catch {
      this.raw = false;
    }
  }

  private disableRaw(): void {
    try {
      if (this.raw && typeof this.stdin.setRawMode === "function") this.stdin.setRawMode(false);
    } catch { /* 尽力而为 */ }
  }

  private onKey(buf: Buffer): void {
    if (this.stopped) return;
    const s = buf.toString("utf-8");
    // Ctrl+C
    if (s === "\x03") {
      if (this.state.engine === "running" && this.running) {
        void this.running.cancel();
        this.dispatch({ type: "notice", text: "已发送取消信号（Ctrl+C 退出）", tone: "warn" });
        return;
      }
      this.stop();
      process.exit(0);
    }
    if (this.state.helpOpen) {
      if (s === "\x1b" || s === "?" || s === "\x1b[") this.dispatch({ type: "toggleHelp", open: false });
      return;
    }
    // 方向键 / 功能键
    switch (s) {
      case "\x1b[A": // up
        if (this.state.focus === "input") this.dispatch({ type: "inputHistory", dir: -1 });
        else this.dispatch({ type: "moveSel", delta: -1 });
        this.draw();
        return;
      case "\x1b[B": // down
        if (this.state.focus === "input") this.dispatch({ type: "inputHistory", dir: 1 });
        else this.dispatch({ type: "moveSel", delta: 1 });
        this.draw();
        return;
      case "\x1b[C": // right
      case "\x1b[D": // left
        this.draw();
        return;
      case "\t":
        this.dispatch({ type: "cycleFocus", dir: 1 });
        this.draw();
        return;
      case "\x1b[Z": // shift+tab
        this.dispatch({ type: "cycleFocus", dir: -1 });
        this.draw();
        return;
      case "\r":
      case "\n":
        this.onEnter();
        this.draw();
        return;
      case "\x7f":
      case "\b":
        this.dispatch({ type: "inputBackspace" });
        this.draw();
        return;
      case "\x1b": // Esc
        if (this.state.engine === "running" && this.running) {
          void this.running.cancel();
          this.dispatch({ type: "notice", text: "取消中…", tone: "warn" });
        } else if (this.state.follow === false) {
          this.dispatch({ type: "scrollBottom" });
        }
        this.draw();
        return;
      case "\x0c": // Ctrl+L
        this.dispatch({ type: "clearScreen" });
        this.draw();
        return;
      case "g":
        if (this.state.focus !== "input") { this.dispatch({ type: "scrollTop" }); this.draw(); return; }
        break;
      case "G":
        if (this.state.focus !== "input") { this.dispatch({ type: "scrollBottom" }); this.draw(); return; }
        break;
      case "?":
        if (this.state.focus === "input" && this.state.input.length === 0) {
          this.dispatch({ type: "toggleHelp", open: true });
          this.draw();
          return;
        }
        break;
    }
    // 可打印输入（含粘贴：多字符一并入框，换行折空格）
    if (s.length > 0 && !s.startsWith("\x1b") && s >= " ") {
      const text = s.replace(/\r?\n/g, " ");
      this.dispatch({ type: "inputAppend", text });
      this.draw();
    }
  }

  private onEnter(): void {
    if (this.state.focus === "input") {
      const value = this.state.input.trim();
      if (value.length === 0) return;
      this.dispatch({ type: "inputSubmit", value });
      this.submit(value);
      return;
    }
    // 栏内 Enter
    if (this.state.focus === "sessions") {
      const s = this.state.sessions[this.state.selIdx.sessions];
      if (s) {
        this.dispatch({ type: "inputSubmit", value: `:replay ${s.name}` });
        this.submit(`:replay ${s.name}`);
      }
      return;
    }
    if (this.state.focus === "experts") {
      const e = this.state.experts[this.state.selIdx.experts];
      if (e) {
        this.dispatch({ type: "setFocus", focus: "input" });
        this.dispatch({ type: "inputSet", value: `?${e.name} ` });
      }
      return;
    }
    this.dispatch({ type: "toggleSection", section: "pool" });
  }

  // ---------- 提交解析（规格书 §2） ----------

  submit(raw: string): void {
    const value = raw.trim();
    if (value.length === 0) return;
    if (value.startsWith(":")) { this.command(value); return; }
    const direct = /^\?(\S+)\s+([\s\S]+)\?$/.exec(value);
    if (direct) {
      this.runDirect(direct[1]!, direct[2]!.trim());
      return;
    }
    if (this.state.engine === "running") {
      this.dispatch({ type: "notice", text: "引擎运行中（Esc 取消后再派单）", tone: "warn" });
      return;
    }
    this.runTeam(value);
  }

  private command(value: string): void {
    const [name, ...rest] = value.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (name) {
      case "demo": this.runDemo(); return;
      case "replay": {
        const target = arg || this.state.sessions[this.state.selIdx.sessions]?.name;
        if (!target) { this.dispatch({ type: "notice", text: "用法：:replay <out-…>（或 Tab 到会话栏选择）", tone: "warn" }); return; }
        this.replay(target);
        return;
      }
      case "score": {
        const dir = latestScorecardDir(this.state.workspace);
        if (!dir) { this.dispatch({ type: "notice", text: "尚无评分卡（先跑任务或 :demo）", tone: "warn" }); return; }
        const card = this.readScorecard(path.join(dir, "scorecard.json"));
        if (!card) { this.dispatch({ type: "notice", text: "评分卡读取失败", tone: "err" }); return; }
        const axis = arg && arg.length > 0 ? arg : undefined;
        this.dispatch({
          type: "scoreCard", model: card.model, evidence: card.evidence_count,
          cells: axis ? card.cells.filter((c) => c.cell.startsWith(axis + "|")) : card.cells,
        });
        return;
      }
      case "theme": {
        const t = parseThemeName(arg);
        if (!t) { this.dispatch({ type: "notice", text: `主题：${THEME_ORDER.join(" / ")}`, tone: "warn" }); return; }
        this.dispatch({ type: "setTheme", theme: t });
        return;
      }
      case "filter": {
        const key = parseFilterArg(arg);
        if (key === null) {
          this.dispatch({
            type: "notice",
            text: `过滤类：${FILTERS.filter((f) => f.k !== "all").map((f) => f.label).join(" / ")}（:filter 复位）`,
            tone: "warn",
          });
          return;
        }
        this.dispatch({ type: "setFilter", filter: key });
        const label = FILTERS.find((f) => f.k === key)?.label ?? "全部";
        this.dispatch({
          type: "notice",
          text: key === "all" ? "事件流过滤已复位（全部）" : `仅显示 ${label} 类卡片（:filter 复位）`,
        });
        return;
      }
      case "status": {
        const info = scanWorkspace(this.state.workspace);
        this.dispatch({ type: "workspace", info });
        const candidates = info.experts.filter((e) => !e.retained);
        this.dispatch({
          type: "notice",
          text: `会话 ${info.sessions.length} · 专家 ${info.experts.length}（候选 ${candidates.length}）· memo ${info.memoKeys} · 基准题 ${info.minedTracks} 轨道`,
        });
        return;
      }
      case "import": {
        // 工具库治理第三动作：导入用户自己的 harness（check 闸门 → 入库即保留）
        if (!arg) {
          this.dispatch({ type: "notice", text: "用法：:import <file.hsl> [--name N]（check 绿才入库 · 入库即保留可复用）", tone: "warn" });
          return;
        }
        // 支持 :import <file> --name <name> 形态（余参拆解）
        const parts = arg.split(/\s+/);
        const file = parts[0]!;
        const nameIdx = parts.indexOf("--name");
        const importName = nameIdx >= 0 ? parts[nameIdx + 1] : undefined;
        void (async () => {
          try {
            const r = await importHarness(this.state.workspace, path.resolve(file), { name: importName });
            this.dispatch({
              type: "notice",
              text: `✓ 已导入 ${r.name}@${r.version}（check 绿 · ${r.capabilities.join(",")} · B 路径即刻可复用）`,
            });
            this.refreshWorkspace();
          } catch (err) {
            this.dispatch({ type: "notice", text: `导入失败：${(err as Error).message}`, tone: "err" });
          }
        })();
        return;
      }
      case "keep": case "drop": {
        // 工具库治理：选取保留（★）/取消保留（○）；无参时作用于专家栏选中项
        const retained = name === "keep";
        const target = arg || this.state.experts[this.state.selIdx.experts]?.name;
        if (!target) {
          this.dispatch({ type: "notice", text: `用法：:${name} <expert>（或 Tab 到专家库选中后 :${name}）`, tone: "warn" });
          return;
        }
        try {
          const { kept, missing } = setRetained(this.state.workspace, [target], retained);
          if (kept.length > 0) {
            this.dispatch({
              type: "notice",
              text: retained
                ? `★ 已保留 ${kept.join(", ")}（B 路径自动复用开始命中）`
                : `○ 已取消保留 ${kept.join(", ")}（B 路径不再自动复用）`,
            });
          }
          if (missing.length > 0) {
            this.dispatch({ type: "notice", text: `注册表中未找到：${missing.join(", ")}`, tone: "err" });
          }
          this.refreshWorkspace();
        } catch (err) {
          this.dispatch({ type: "notice", text: `保留操作失败：${(err as Error).message}`, tone: "err" });
        }
        return;
      }
      case "clear": this.dispatch({ type: "clearScreen" }); return;
      case "help": this.dispatch({ type: "toggleHelp", open: true }); return;
      case "quit": case "q": case "exit":
        this.stop();
        process.exit(0);
        return;
      default:
        this.dispatch({ type: "notice", text: `未知命令 :${name}（:help 查看全部）`, tone: "warn" });
    }
  }

  private readScorecard(file: string): Scorecard | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Scorecard;
    } catch {
      return null;
    }
  }

  // ---------- 运行家族 ----------

  private refreshWorkspace(): void {
    try {
      ensureWorkspace(this.state.workspace);
      this.dispatch({ type: "workspace", info: scanWorkspace(this.state.workspace) });
    } catch (err) {
      this.dispatch({ type: "notice", text: `工作区不可用：${(err as Error).message}`, tone: "err" });
    }
  }

  private runTeam(task: string): void {
    // v0.4.12 修复：会话名与 lib/engine.ts 的 makeOutDir 同格式
    // （out-YYYYMMDD-HHMMSS）—— 此前 toISOString 抹全部连字符生成
    // out-YYYYMMDDHHMMSS，状态栏 currentSession 与真实产物目录永远对不上。
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    const session = `out-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    this.dispatch({ type: "runStart", mode: "team", session, userText: task });
    void this.pump(startRun({
      entry: "org", task,
      workspace: this.state.workspace,
      model: this.state.model === "deepseek" ? "deepseek" : "scripted",
    }), { demo: null });
  }

  private runDirect(expert: string, question: string): void {
    if (this.state.engine === "running") {
      this.dispatch({ type: "notice", text: "引擎运行中（Esc 取消后再派单）", tone: "warn" });
      return;
    }
    const session = `out-ask-${Date.now() % 100000}`;
    this.dispatch({ type: "runStart", mode: "direct", session, userText: `?${expert} ${question}?` });
    void this.pump(startRun({
      entry: "direct", task: question,
      workspace: this.state.workspace,
      model: this.state.model === "deepseek" ? "deepseek" : "scripted",
      expert,
    }), { demo: null });
  }

  private runDemo(): void {
    if (this.state.engine === "running") {
      this.dispatch({ type: "notice", text: "引擎运行中（Esc 取消后再派单）", tone: "warn" });
      return;
    }
    this.demoActive = true;
    this.dispatch({ type: "demoStart" });
    this.dispatch({ type: "notice", text: "三连跑演示开始（重置工作区 → A 铸专家 → B 复用+补丁 → C 蓝绿）" });
    try {
      resetWorkspace(this.state.workspace);
    } catch (err) {
      this.dispatch({ type: "notice", text: `工作区重置失败：${(err as Error).message}`, tone: "err" });
      this.demoActive = false;
      return;
    }
    this.refreshWorkspace();
    const task = "抓取某站点近一周公告，输出结构化表格";
    const steps: Array<"A" | "B" | "C"> = ["A", "B", "C"];
    void (async () => {
      let prevOk = true;
      for (const step of steps) {
        if (this.stopped || !prevOk) break;
        this.dispatch({ type: "demoStep", step });
        const session = `out-${step.toLowerCase()}`;
        this.dispatch({ type: "runStart", mode: "demo", session, userText: `${task}（run ${step}）` });
        const res = await this.pump(startRun({
          entry: "org", task,
          workspace: this.state.workspace,
          model: this.state.model === "deepseek" ? "deepseek" : "scripted",
        }), { demo: step });
        prevOk = res;
        // run A 结束 = 用户选取时点：工厂产出候选 → 保留转正（scripted 自动全选）
        if (step === "A" && res && !this.stopped) {
          const picked = keepAllCandidates(this.state.workspace);
          if (picked.length > 0) {
            this.dispatch({
              type: "notice",
              text: `★ 用户选取保留：${picked.join(", ")}（候选转正；真实用户用 :keep <name> 挑选）`,
            });
            this.refreshWorkspace();
          }
        }
      }
      this.demoActive = false;
      if (prevOk) {
        const hist = [...this.state.demoHistory];
        this.dispatch({
          type: "notice",
          text: hist.length > 1 ? `三连跑完成 · model_calls ${hist.join("→")}（资产层持续增长）` : "三连跑完成",
        });
        this.refreshWorkspace();
      }
    })();
  }

  private replay(name: string): void {
    const dir = path.join(this.state.workspace, name);
    if (!fs.existsSync(path.join(dir, "events.jsonl")) && !fs.existsSync(path.join(dir, "run.json"))) {
      this.dispatch({ type: "notice", text: `找不到会话产物：${name}`, tone: "err" });
      return;
    }
    try {
      const data = replayRun(dir);
      this.dispatch({
        type: "replay", events: data.events, session: name,
        model: data.runJson?.model ?? this.state.model,
      });
      const rj = data.runJson;
      this.dispatch({
        type: "replayDone",
        ok: rj ? rj.ok === true : false,
        deliverables: data.metrics?.deliverables,
        assets: data.metrics?.assets,
        modelCalls: data.metrics?.model_calls_total,
        revises: data.metrics?.revises_total,
        elapsedMs: rj?.elapsed_ms,
      });
      const sha = gitShortLog(this.state.workspace, 1)[0]?.sha;
      if (sha) this.dispatch({ type: "attachSha", sha });
      this.dispatch({ type: "notice", text: `重演 ${name}（${data.events.length} 事件，秒开）` });
    } catch (err) {
      this.dispatch({ type: "notice", text: `重演失败：${(err as Error).message}`, tone: "err" });
    }
  }

  /** 事件泵：RunHandle.events → store；结束时收尾。返回 ok。 */
  private async pump(handle: RunHandle, opts: { demo: "A" | "B" | "C" | null }): Promise<boolean> {
    this.running = handle;
    for await (const ev: EngineEvent of handle.events) {
      if (this.stopped) break;
      this.dispatch({ type: "runEvent", ev });
      this.draw();
    }
    const result = await handle.wait();
    this.running = null;
    this.dispatch({ type: "runDone", ok: result.ok && !result.canceled, error: result.error });
    if (result.ok && !result.canceled) {
      if (result.metrics?.model_calls_total !== undefined && opts.demo) {
        this.dispatch({ type: "demoCalls", calls: result.metrics.model_calls_total });
      }
      const sha = gitShortLog(this.state.workspace, 1)[0]?.sha;
      if (sha) this.dispatch({ type: "attachSha", sha });
      if (this.state.mode === "direct" && result.directTurns && result.directTurns.length > 0) {
        this.dispatch({
          type: "directAnswers",
          answers: result.directTurns.map((t) => t.answer),
          turns: result.directTurns.length,
        });
      }
    }
    this.refreshWorkspace();
    this.draw();
    return result.ok && !result.canceled;
  }

  /** 冒烟/导出：渲染一帧纯文本（无 ANSI）。 */
  renderPlainText(): string {
    return Screen.toPlainText(renderFrame(this.state));
  }

  getState(): TuiState {
    return this.state;
  }

  withDemoCallForTest(calls: number): TuiState {
    return withDemoCall(this.state, calls);
  }
}

/** 供 smoke / --print 使用的纯推进器（不经 stdin）。 */
export function feedEvents(app: App, events: EngineEvent[]): void {
  for (const ev of events) {
    (app as unknown as { dispatch: (a: Action) => void }).dispatch({ type: "runEvent", ev });
  }
}
