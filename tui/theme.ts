// ============================================================================
// org/tui/theme.ts — 三主题 token 表（规格书 §6）
// ----------------------------------------------------------------------------
// 组件只消费 token，语义色全局统一：路由四色 A/B/C/D、裁决四色
// Accept=绿 · Revise=琥珀 · Reject=红 · Escalate=紫。
//   org-dark（默认）：深底 emerald 系（品牌色）
//   org-light：纸感浅底，同语义色系加深
//   paper：米白底 + 全灰阶，仅裁决徽标有色（打印友好）
// ============================================================================

export type ThemeName = "org-dark" | "org-light" | "paper";

export interface Theme {
  name: ThemeName;
  fg: string;
  dim: string;
  faint: string;
  brand: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  badgeA: string;   // A 内联
  badgeB: string;   // B 复用
  badgeC: string;   // C 生成
  badgeD: string;   // D 移交
  verdictAccept: string;
  verdictRevise: string;
  verdictReject: string;
  verdictEscalate: string;
  border: string;
  frameTitle: string;
  accentBg: string;  // 选中项/当前步底色（ink 允许 hex bg）
}

export const THEMES: Record<ThemeName, Theme> = {
  "org-dark": {
    name: "org-dark",
    fg: "#D6E4DC",
    dim: "#7C9A8C",
    faint: "#4A5F55",
    brand: "#34D399",
    ok: "#34D399",
    warn: "#FBBF24",
    err: "#F87171",
    info: "#7DD3FC",
    badgeA: "#7DD3FC",
    badgeB: "#34D399",
    badgeC: "#FBBF24",
    badgeD: "#C084FC",
    verdictAccept: "#34D399",
    verdictRevise: "#FBBF24",
    verdictReject: "#F87171",
    verdictEscalate: "#C084FC",
    border: "#2A3B33",
    frameTitle: "#7C9A8C",
    accentBg: "#12241C",
  },
  "org-light": {
    name: "org-light",
    fg: "#1C2A24",
    dim: "#5F7268",
    faint: "#9AA8A0",
    brand: "#047857",
    ok: "#047857",
    warn: "#B45309",
    err: "#B91C1C",
    info: "#0369A1",
    badgeA: "#0369A1",
    badgeB: "#047857",
    badgeC: "#B45309",
    badgeD: "#6D28D9",
    verdictAccept: "#047857",
    verdictRevise: "#B45309",
    verdictReject: "#B91C1C",
    verdictEscalate: "#6D28D9",
    border: "#C4CFC8",
    frameTitle: "#5F7268",
    accentBg: "#E4EEE8",
  },
  paper: {
    name: "paper",
    fg: "#3B3833",
    dim: "#8A857C",
    faint: "#B8B2A6",
    brand: "#3B3833",
    ok: "#3B3833",
    warn: "#3B3833",
    err: "#3B3833",
    info: "#3B3833",
    badgeA: "#3B3833",
    badgeB: "#3B3833",
    badgeC: "#3B3833",
    badgeD: "#3B3833",
    verdictAccept: "#1B7F4D",
    verdictRevise: "#A66A0F",
    verdictReject: "#A3271F",
    verdictEscalate: "#6D28D9",
    border: "#D8D2C6",
    frameTitle: "#8A857C",
    accentBg: "#EFEAE0",
  },
};

export const THEME_ORDER: ThemeName[] = ["org-dark", "org-light", "paper"];

export function parseThemeName(s: string): ThemeName | null {
  const n = s.trim().toLowerCase();
  if (n === "dark" || n === "org-dark") return "org-dark";
  if (n === "light" || n === "org-light") return "org-light";
  if (n === "paper") return "paper";
  return null;
}
