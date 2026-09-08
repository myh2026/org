// ============================================================================
// org/tui/components/rail.tsx — 左栏：会话 / 专家库 / 池与固化（规格书 §1）
// ----------------------------------------------------------------------------
// 三个可折叠分区；focus 分区标题高亮 ▸，选中行品牌色标记。
// 宽度为 0 时整个 rail 隐藏（窄终端降级）。
// ============================================================================

import type { TuiState, Focus } from "../store.ts";
import type { Theme } from "../theme.ts";
import type { Line } from "../text.ts";
import { fitLine, truncate } from "../text.ts";

function sectionHeader(title: string, focused: boolean, collapsed: boolean, width: number): Line {
  const mark = collapsed ? "+" : focused ? "▸" : "▾";
  const m = /^(.*?)(\s*\(\d+\))$/.exec(title);
  const label = m ? m[1]! : title;
  const count = m ? m[2]! : "";
  const color = focused ? "brand" : "frameTitle";
  return fitLine(
    [
      { t: ` ${mark} `, c: color, b: focused },
      { t: label, c: color, b: true },
      { t: count, c: "faint" },
    ],
    width,
  );
}

export function railWidth(state: TuiState): number {
  if (state.cols < 100) return 0;
  return 28;
}

export function renderRail(state: TuiState, theme: Theme, width: number, height: number): Line[] {
  void theme;
  const lines: Line[] = [];
  if (width <= 0) return lines;
  const inner = Math.max(8, width - 3); // │ + 两侧各一空格
  const budget = height;

  const sections: Array<{ key: Focus; title: string }> = [
    { key: "sessions", title: `会话 (${state.sessions.length})` },
    { key: "experts", title: `专家库 (${state.experts.length})` },
    { key: "pool", title: "池与固化" },
  ];

  let used = 0;
  for (const sec of sections) {
    if (used >= budget) break;
    const focused = state.focus === sec.key;
    lines.push(sectionHeader(sec.title, focused, state.collapsed[sec.key as "sessions"], inner));
    used++;
    if (state.collapsed[sec.key as "sessions"]) continue;

    if (sec.key === "sessions") {
      state.sessions.forEach((s, idx) => {
        if (used >= budget) return;
        const sel = focused && idx === state.selIdx.sessions;
        const mark = state.currentSession === s.name ? "●" : s.ok ? "○" : "◍";
        const title = s.task || s.name;
        lines.push(fitLine(
          [
            { t: "  ", dim: true },
            { t: sel ? "▸" : " ", c: "brand" },
            { t: mark + " ", c: state.currentSession === s.name ? "brand" : "faint" },
            { t: truncate(title, inner - 8), c: sel ? "brand" : "fg", b: sel },
          ],
          inner,
        ));
        used++;
      });
      if (state.sessions.length === 0 && used < budget) {
        lines.push(fitLine([{ t: "  ∅ 暂无运行", c: "faint" }], inner));
        used++;
      }
    } else if (sec.key === "experts") {
      state.experts.forEach((e, idx) => {
        if (used >= budget) return;
        const sel = focused && idx === state.selIdx.experts;
        const runnable = e.entry.length > 0;
        // ★ = 用户保留资产（B 路径自动复用命中）· ○ = 工厂候选（待选取转正）
        const mark = e.retained ? "★" : "○";
        const markColor = e.retained ? "ok" : "warn";
        lines.push(fitLine(
          [
            { t: "  ", dim: true },
            { t: sel ? "▸" : " ", c: "brand" },
            { t: mark + " ", c: markColor },
            { t: truncate(`${e.name}@${e.version}`, Math.max(4, Math.floor(inner * 0.55))), c: sel ? "brand" : "fg", b: sel },
            { t: ` eval=${e.eval_score.toFixed(1)}`, c: e.eval_score >= 0.9 ? "ok" : "warn" },
            { t: runnable ? "" : " ◇", c: "faint" },
          ],
          inner,
        ));
        used++;
      });
      if (state.experts.length === 0 && used < budget) {
        lines.push(fitLine([{ t: "  ∅ 空（未初始化）", c: "faint" }], inner));
        used++;
      }
    } else {
      const rows: Line[] = [
        labeled("池", state.engine === "running" ? "busy 1 · 派单中" : `idle ${Math.max(0, state.experts.length)}`, inner),
        labeled("固化", `冻结 ${state.crystal.frozen} · 命中 ${state.crystal.hits}`, inner),
        labeled("memo", `${state.crystal.memos} 条冻结映射`, inner),
      ];
      for (const l of rows) {
        if (used >= budget) break;
        lines.push(l);
        used++;
      }
      if (state.mode !== "team" && used < budget) {
        lines.push(fitLine([{ t: "  ", dim: true }, { t: `模式 ${state.mode}`, c: "info" }], inner));
        used++;
      }
    }
  }
  while (used < budget) {
    lines.push([{ t: "".padEnd(inner) }]);
    used++;
  }
  return lines.slice(0, budget);
}

function labeled(label: string, value: string, width: number): Line {
  return fitLine(
    [
      { t: "  ", dim: true },
      { t: label.padEnd(5), c: "frameTitle" },
      { t: truncate(value, Math.max(0, width - 10)), c: "fg" },
    ],
    width,
  );
}
