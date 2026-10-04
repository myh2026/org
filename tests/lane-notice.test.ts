// ============================================================================
// tests/lane-notice.test.ts — v0.5.45 · B-42 剧本车道提示回归锁
//   背景：歌曲生成测试 F1 —— 裸跑 `org run` 落 scripted 且零提示，
//   用户视角「模型已生成」与「占位剧本秒回」不可区分。
// ============================================================================
import { describe, test, expect } from "bun:test";
import { scriptedLaneNotice } from "../cli/org.ts";

describe("v0.5.45 · B-42 剧本车道提示", () => {
  test("缺省 scripted 未显式 → 必须提示", () => {
    const n = scriptedLaneNotice("scripted", false);
    expect(n).not.toBeNull();
    expect(n!).toContain("零模型调用");
    expect(n!).toContain("--model");
  });

  test("显式选定 scripted（用户知情）→ 静默", () => {
    expect(scriptedLaneNotice("scripted", true)).toBeNull();
  });

  test("真实车道（无论显式与否）→ 静默", () => {
    expect(scriptedLaneNotice("deepseek", false)).toBeNull();
    expect(scriptedLaneNotice("deepseek", true)).toBeNull();
    expect(scriptedLaneNotice("scripted-lane-name-differs", false)).toBeNull();
  });
});
