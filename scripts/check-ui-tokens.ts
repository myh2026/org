#!/usr/bin/env bun
// ============================================================================
// scripts/check-ui-tokens.ts — UI v4 设计约束守卫（P1 制度化）
// ----------------------------------------------------------------------------
// 规则（ui-v4-design.md §3.4）：
//   1) web/entry.ts <style> 区：font/font-size 声明中的字号必须为 var(--fs-*)；
//      白名单仅 12px（预格式等宽常量）/ 16px（移动端输入聚焦缩放防护）；
//   2) 色值：:root 与契约串之外的字面 hex 仅允许「基线债」内且不超量；
//      新增任何 hex 或占用超基线 → 红（bootstrap 只降不升；P3 逐项转 token）；
//   3) 契约串 8 项 must-contain（与 tests/web.test.ts 双保险）。
// 用法：bun scripts/check-ui-tokens.ts [--json]
// ============================================================================
import * as fs from "../lib/fssafe-fs.ts";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = path.join(ROOT, "web", "entry.ts");

/** 不可破坏的 8 项契约字符串（逐字）。 */
export const CONTRACT_STRINGS = [
  "[hidden] { display: none !important; }",
  ".rchip[hidden] { display: none; }",
  ".rsc-badge",
  ".rsc-badge.deg",
  ".t-bot.degraded",
  "#0a0a0b",
  "#d97706",
  "#toolboxPane, #govexPane",
] as const;

/**
 * 色值基线债（bootstrap，P1 实测锁定；只降不升）。
 * P3 起逐项转 token（候选：#b39dff/#b7a6ff 家族 → 派生树主题、
 * #ffc9c9/#ffd7d7 → diff 负色、#7dd3fc → --lane-expert 等）。
 */
export const HEX_DEBT: ReadonlyMap<string, number> = new Map([
  ["#0a0a0b", 7],   // 契约 + ::selection 等
  ["#d97706", 1],   // 契约（--amber 定义外引用）
  ["#b39dff", 3], ["#b7a6ff", 3], ["#cbbfff", 1],
  ["#ffc9c9", 3], ["#ffd7d7", 2],
  ["#ededf0", 3], ["#fff", 3], ["#f5f5f7", 1], ["#f0f0f3", 1],
  ["#9aa2b5", 1], ["#d3ddfa", 1], ["#c8d0e4", 1], ["#b9c1d4", 1],
  ["#7dd3fc", 1],   // 收编中 → --lane-expert（P2）
]);

export interface UiTokenReport {
  ok: boolean;
  problems: string[];
  stats: { fontDecls: number; hexTotal: number; hexBaseline: number };
}

export function runUiTokenChecks(): UiTokenReport {
  const problems: string[] = [];
  const src = fs.readFileSync(ENTRY, "utf-8");
  const m = src.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) return { ok: false, problems: ["web/entry.ts 未找到 <style> 块"], stats: { fontDecls: 0, hexTotal: 0, hexBaseline: 0 } };
  const css = m[1];

  // 规则 1：字号白名单
  let fontDecls = 0;
  for (const decl of css.matchAll(/font(?:-size)?:\s*[^;{}\n]*/g)) {
    fontDecls += 1;
    const d = decl[0];
    if (/var\(--fs-/.test(d)) continue;
    const px = d.match(/(\d+(?:\.\d+)?)px/);
    if (!px) continue; // 无字号（继承）——放行
    if (px[1] === "12" || px[1] === "16") continue; // 白名单两例外
    problems.push(`字号越档（只允许 var(--fs-*) 或 12/16px 例外）：${d.trim().slice(0, 90)}`);
  }

  // 规则 2：色值基线债（:root 之外）
  const noRoot = css.replace(/:root\s*\{[\s\S]*?\n\}/, "");
  const counts = new Map<string, number>();
  let hexTotal = 0;
  for (const h of noRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const k = h[0].toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
    hexTotal += 1;
  }
  let hexBaseline = 0;
  for (const [, n] of HEX_DEBT) hexBaseline += n;
  for (const [k, n] of counts) {
    const base = HEX_DEBT.get(k) ?? 0;
    if (n > base) {
      problems.push(`色值越界：${k} ×${n}（基线 ${base}）—— 新样式只允许 var(--*) 或契约串`);
    }
  }

  // 规则 3：契约串 must-contain
  for (const c of CONTRACT_STRINGS) {
    if (!src.includes(c)) problems.push(`契约串缺失：${c}`);
  }

  return { ok: problems.length === 0, problems, stats: { fontDecls, hexTotal, hexBaseline } };
}

if (import.meta.main) {
  const r = runUiTokenChecks();
  if (r.ok) {
    console.log(
      `✓ UI 令牌守卫全过（font 声明 ${r.stats.fontDecls} · 色值 ${r.stats.hexTotal}/${r.stats.hexBaseline} 基线内 · 契约串 ×${CONTRACT_STRINGS.length}）`,
    );
    process.exit(0);
  }
  console.error("✗ UI 令牌守卫失败：");
  for (const p of r.problems) console.error("  - " + p);
  process.exit(1);
}
