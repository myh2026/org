// ============================================================================
// org/tui/frame.ts — 帧组合（纯函数，规格书 §1 三区结构）
// ----------------------------------------------------------------------------
//   row 0        标题栏
//   row 1..H-3   body = 左栏 rail │ 线程 thread（窄终端隐藏 rail）
//   row H-2      输入栏
//   row H-1      状态栏
// helpOpen 时 body 区被帮助浮层替换。
// 纯函数：state+尺寸 → Line[]；冒烟测试与渲染器共用。
// ============================================================================

import type { TuiState } from "./store.ts";
import type { Theme, ThemeName } from "./theme.ts";
import { THEMES } from "./theme.ts";
import type { Line } from "./text.ts";
import { fitLine } from "./text.ts";
import { renderRail, railWidth } from "./components/rail.tsx";
import { renderThread } from "./components/thread.tsx";
import { renderInput, renderStatus, renderHelp } from "./components/input.tsx";

export const ORG_VERSION = "v0.4.1";

function hline(width: number, left: string, mid: string, right: string): string {
  return left + mid.repeat(Math.max(0, width)) + right;
}

export function renderFrame(state: TuiState, themeName?: ThemeName): Line[] {
  const theme: Theme = THEMES[themeName ?? state.theme];
  const W = Math.max(40, state.cols);
  const H = Math.max(16, state.rows);
  const lines: Line[] = [];

  // ---- 标题栏 ----
  const title = ` ORG — Organization Harness `;
  const ver = `${ORG_VERSION} `;
  lines.push(fitLine(
    [
      { t: hline(1, "╭", "─", "╮").length > 0 ? "╭" : "╭", c: "border" },
      { t: title, c: "brand", b: true },
      { t: "─".repeat(Math.max(0, W - 3 - title.length - ver.length - 5)), c: "border" },
      { t: ` ${ver}`, c: "faint" },
      { t: "╮", c: "border" },
    ],
    W,
  ));

  // ---- body ----
  const bodyH = Math.max(4, H - 4);
  const bodyLines: Line[] = state.helpOpen
    ? renderHelp(state, theme, W, bodyH)
    : bodySplit(state, theme, W, bodyH);
  for (const l of bodyLines) lines.push(l);

  // ---- 输入栏 ----
  const inputLine = renderInput(state, theme, W - 2);
  lines.push([
    { t: "├", c: "border" },
    { t: "─", c: "border" },
    ...padLine(inputLine, W - 4),
    { t: "─┤", c: "border" },
  ]);

  // ---- 状态栏 ----
  const statusLine = renderStatus(state, theme, W - 4);
  lines.push([
    { t: "│ ", c: "border" },
    ...padLine(statusLine, W - 4),
    { t: " │", c: "border" },
  ]);
  lines.push([{ t: hline(W - 2, "╰", "─", "╯"), c: "border" }]);
  return lines.slice(0, H);
}

function padLine(line: Line, width: number): Line {
  const fitted = fitLine(line, width);
  const used = fitted.reduce((a, s) => a + s.t.length, 0);
  const pad = Math.max(0, width - used);
  return pad > 0 ? [...fitted, { t: "".padEnd(pad) }] : fitted;
}

function bodySplit(state: TuiState, theme: Theme, W: number, bodyH: number): Line[] {
  const rw = railWidth(state);
  const out: Line[] = [];
  if (rw === 0) {
    const thread = renderThread(state, theme, W - 4, bodyH).viewport;
    for (const l of thread) {
      out.push([{ t: "│ ", c: "border" }, ...padLine(l, W - 4), { t: " │", c: "border" }]);
    }
    return out.slice(0, bodyH);
  }
  const tw = W - rw - 4; // 两侧边框 + 中缝
  const rail = renderRail(state, theme, rw, bodyH);
  const thread = renderThread(state, theme, tw, bodyH).viewport;
  for (let i = 0; i < bodyH; i++) {
    const l = rail[i] ?? [{ t: "".padEnd(rw - 2) }];
    const r = thread[i] ?? [{ t: "".padEnd(Math.max(0, tw - 2)) }];
    out.push([
      { t: "│ ", c: "border" },
      ...padLine(l, rw - 3),
      { t: " │", c: "border" },
      ...padLine(r, tw - 3),
      { t: " │", c: "border" },
    ]);
  }
  return out.slice(0, bodyH);
}
