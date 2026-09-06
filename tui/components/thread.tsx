// ============================================================================
// org/tui/components/thread.tsx — 主区：消息流视口（规格书 §1/§3）
// ----------------------------------------------------------------------------
// 全部卡片渲染为行序列（renderCard 纯函数），视口按行切片滚动。
// follow=true 时贴底跟随；用户上翻后停止跟随并显示「↓ 回到底部」提示。
// ============================================================================

import type { TuiState } from "../store.ts";
import type { Theme } from "../theme.ts";
import type { Line } from "../text.ts";
import { renderCard } from "./cards.tsx";

export interface ThreadLayout {
  lines: Line[];
  totalLines: number;
  viewport: Line[];
  detached: boolean;
}

export function renderThread(state: TuiState, theme: Theme, width: number, height: number): ThreadLayout {
  const inner = Math.max(10, width - 3); // │ + 两侧空格
  const lines: Line[] = [];
  if (state.cards.length === 0) {
    lines.push([{ t: "" }]);
    lines.push([{ t: "  ORG 组织驾驶舱", c: "brand", b: true }]);
    lines.push([{ t: "  ─────────────", c: "faint" }]);
    lines.push([{ t: "  输入任务回车派单（团队模式）", c: "fg" }]);
    lines.push([{ t: "  ?专家名 问题? 直连专家", c: "fg" }]);
    lines.push([{ t: "  :demo 三连跑演示 · :replay out-… 重演 · :help 全部命令", c: "dim" }]);
    lines.push([{ t: "" }]);
    lines.push([{ t: "  子智能体可生成 · 可验收 · 可复用 · 可演进", c: "faint" }]);
  }
  for (const card of state.cards) {
    if (lines.length > 0) lines.push([{ t: "" }]); // 卡间空行
    for (const l of renderCard(card, inner)) lines.push(l);
  }
  const totalLines = lines.length;
  const viewH = Math.max(1, height - 1); // 底部留一行跟随提示
  let start = 0;
  if (state.follow) {
    start = Math.max(0, totalLines - viewH);
  } else {
    start = Math.max(0, totalLines - viewH - state.scrollFromBottom);
  }
  const viewport = lines.slice(start, start + viewH);
  while (viewport.length < viewH) viewport.unshift([{ t: "" }]);

  const detached = !state.follow && state.scrollFromBottom > 0;
  if (detached && totalLines > viewH) {
    viewport.push([{ t: `  ↓ 回到底部（G）· 第 ${Math.min(state.scrollFromBottom, totalLines - viewH)}/${totalLines} 行`, c: "info" }]);
  } else {
    viewport.push([{ t: "" }]);
  }
  return { lines, totalLines, viewport, detached };
}
