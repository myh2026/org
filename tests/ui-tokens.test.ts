// ============================================================================
// tests/ui-tokens.test.ts — v4 设计约束守卫回归（P1 制度化）
//   字号白名单 / 色值基线债 / 契约串 must-contain ×8（见 scripts/check-ui-tokens.ts）
// ============================================================================
import { describe, test, expect } from "bun:test";
import { runUiTokenChecks, CONTRACT_STRINGS, HEX_DEBT } from "../scripts/check-ui-tokens.ts";

describe("v4 UI 令牌守卫（check-ui-tokens）", () => {
  test("全过：字号白名单 · 色值基线内 · 契约串 ×8", () => {
    const r = runUiTokenChecks();
    if (!r.ok) console.error(r.problems.join("\n"));
    expect(r.ok).toBe(true);
  });

  test("契约串清单 = 8 项（清单本体防漂移）", () => {
    expect(CONTRACT_STRINGS.length).toBe(8);
  });

  test("色值基线只降不升（结构粗检：基线键集合非空）", () => {
    expect(HEX_DEBT.size).toBeGreaterThanOrEqual(10);
  });
});
