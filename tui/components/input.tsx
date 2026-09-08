// ============================================================================
// org/tui/components/input.tsx — 输入栏（规格书 §2）
// ----------------------------------------------------------------------------
// › 前缀提示符；运行中显示引擎占用与取消提示；:命令与 ?直连? 语法在
// app.tsx 解析，这里只负责渲染与光标视觉（光标恒在行尾，v1 边界）。
// ============================================================================

import type { TuiState } from "../store.ts";
import { FILTERS } from "../store.ts";
import type { Theme } from "../theme.ts";
import type { Line } from "../text.ts";
import { fitLine, truncate } from "../text.ts";

export function renderInput(state: TuiState, theme: Theme, width: number): Line {
  void theme;
  const inner = Math.max(8, width - 2);
  const running = state.engine === "running";
  const hint = running
    ? `${state.model} · 运行中 ${elapsedSec(state)} · Esc 取消`
    : "团队模式 · 输入任务回车派单 · :help 命令";
  const labelW = displayWidthOf(hint) + 4;
  const budget = Math.max(0, inner - labelW - 2);
  const text = state.input.length > 0 ? state.input : "";
  const showText = text.length > 0;
  const cursor = showText ? "▌" : "";
  const body = showText ? truncate(text, budget) + cursor : "";
  return fitLine(
    [
      { t: " › ", c: running ? "warn" : "brand", b: true },
      { t: body, c: "fg" },
      { t: showText ? "" : ` ${hint}`, c: "faint" },
    ],
    inner,
  );
}

export function renderStatus(state: TuiState, theme: Theme, width: number): Line {
  void theme;
  const inner = Math.max(8, width - 2);
  const engineLabel = state.engine === "running"
    ? { t: `● ${state.mode} · ${state.model} · ${elapsedSec(state)}`, c: "warn", b: true }
    : state.engine === "error"
    ? { t: `◍ ${state.mode} · ${state.model} · 上次失败`, c: "err" }
    : state.engine === "canceled"
    ? { t: `◌ ${state.mode} · ${state.model} · 已取消`, c: "faint" }
    : { t: `○ ${state.mode} · ${state.model} · idle`, c: "ok" };
  const ws = truncate(shortWorkspace(state.workspace), Math.max(6, Math.floor(inner / 3)));
  // :filter 激活时在状态栏右侧前置过滤徽标（视图偏好可观测）
  const filterLabel = FILTERS.find((f) => f.k === state.filter && f.k !== "all")?.label;
  const right: Line = [
    ...(filterLabel ? [{ t: `filter=${filterLabel} · `, c: "info" } as const] : []),
    { t: `${ws} · ? 帮助`, c: "faint" },
  ];
  const left = engineLabel;
  return fitLine([left, { t: "  " }, ...right], inner);
}

export function renderHelp(state: TuiState, theme: Theme, width: number, height: number): Line[] {
  void state;
  const inner = Math.max(30, Math.min(64, width - 8));
  const rows: Array<[string, string]> = [
    ["输入任务 ⏎", "团队模式派单（分解→路由→审查→汇总）"],
    ["?专家 问题?", "直连指定专家（记账 + 纪要回写）"],
    [":demo", "三连跑演示：铸专家 → 用户选取 → 复用+补丁 → 蓝绿"],
    [":replay <out-…>", "重演历史会话（事件流秒开）"],
    [":keep <expert>", "工具库治理：选取保留候选（★ 转正）"],
    [":drop <expert>", "取消保留（○ 候选；B 路径不再自动复用）"],
    [":filter [类]", "事件流过滤：任务/分解/工厂/裁决/直连/汇总/动态"],
    [":score [axis]", "模型评分卡（证据归因）"],
    [":theme dark|light|paper", "切换主题"],
    [":status", "刷新工作区快照"],
    [":clear", "清空当前线程（Ctrl+L 同效）"],
    [":quit", "退出（Ctrl+C 同效）"],
    ["Tab / Shift+Tab", "切换聚焦：输入 ↔ 会话 ↔ 专家库 ↔ 池"],
    ["j / k（栏内）", "移动选择；⏎ 打开会话 / 预填直连"],
    ["g / G", "线程回顶 / 回底并恢复跟随"],
    ["Esc", "取消当前运行"],
    ["?（空输入时）", "打开/关闭本帮助"],
  ];
  const boxH = Math.min(height - 2, rows.length + 6);
  const top = Math.floor((height - boxH) / 2);
  const out: Line[] = [];
  const padTop = Math.max(0, top);
  for (let i = 0; i < padTop; i++) out.push([{ t: "" }]);
  out.push([{ t: `  ╭${"─".repeat(inner)}╮`, c: "border" }]);
  out.push([{ t: "  │ ", c: "border" }, { t: "快捷键与命令", c: "brand", b: true }, { t: "".padEnd(inner - 14) }, { t: " │", c: "border" }]);
  out.push([{ t: `  ├${"─".repeat(inner)}┤`, c: "border" }]);
  for (const [k, v] of rows) {
    if (out.length >= padTop + boxH - 1) break;
    const key = k.padEnd(24 - Math.floor((displayWidthOf(k) - k.length) / 2));
    out.push([
      { t: "  │ ", c: "border" },
      { t: truncate(key, 24), c: "info" },
      { t: truncate(v, inner - 28), c: "fg" },
      { t: "".padEnd(Math.max(0, inner - 28 - displayWidthOf(truncate(v, inner - 28)))) },
      { t: " │", c: "border" },
    ]);
  }
  out.push([{ t: `  ╰${"─".repeat(inner)}╯`, c: "border" }]);
  while (out.length < height) out.push([{ t: "" }]);
  return out.slice(0, height);
}

function displayWidthOf(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! >= 0x1100 && ch.codePointAt(0)! <= 0x9fff || (ch.codePointAt(0)! >= 0xff00 && ch.codePointAt(0)! <= 0xff60) ? 2 : 1;
  return w;
}

function elapsedSec(state: TuiState): string {
  if (state.startedAt === null) return "0.0s";
  const ms = Math.max(0, state.nowMs - state.startedAt);
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortWorkspace(ws: string): string {
  if (!ws) return "未初始化";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const norm = home && ws.startsWith(home) ? `~${ws.slice(home.length)}` : ws;
  const parts = norm.split(/[/\\]/).filter((p) => p.length > 0);
  if (parts.length <= 2) return norm;
  return `…/${parts.slice(-2).join("/")}`;
}
