// ============================================================================
// tests/check.test.ts — 结构闸门：全部 HSL 模块必须过 dhv check
// ============================================================================
// 端到端用例超时：本文件每个用例都真实 spawn 一次解释器跑完整监督回路（实测单轮
// 3–14s），而 bun 的默认每用例超时是 5000ms。全局手段都不可用（bunfig 的 [test]
// 段无 timeout 键；[test] preload 与 setDefaultTimeout 在多文件并行 worker 模式下
// 都不生效 —— 详见 tests/helpers.ts 的说明），故逐例显式声明 120_000，
// 与 tests/demo.test.ts 既有写法一致。放宽的是等待上限，不是断言标准。

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, DHV, runDhv, runOrg } from "./helpers";

function collectHsl(dir: string, out: string[] = [], skip = new Set([".git", "node_modules", ".hsl-runs", "demo-run", "demo-run-tests", "out-ask"])): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name)) collectHsl(p, out, skip);
    } else if (e.name.endsWith(".hsl")) {
      out.push(p);
    }
  }
  return out;
}

describe("结构闸门（dhv check）", () => {
  const files = collectHsl(ROOT);

  test("模块数量合理（≥30：内核 + 域目录 + probe + dist 铸出专家）", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  }, 120_000);

  for (const f of files) {
    const rel = path.relative(ROOT, f);
    test(`check ${rel}`, () => {
      const r = runDhv(["check", f]);
      if (!r.ok) console.error(r.stdout + r.stderr);
      expect(r.ok).toBe(true);
    });
  }

  test("org check CLI 全过（入口链优先排序）", () => {
    const r = runOrg(["check"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("0 失败");
  }, 120_000);

  test("mint_hsl 剧本与 stock 逐字一致（生成器出题 = 人工抽查存档）", () => {
    const stock = fs.readFileSync(path.join(ROOT, "hsl/factory/stock/record-validator.hsl"), "utf-8");
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/run-notices.json"), "utf-8"));
    expect(fixture.tracks.mint_hsl[0]).toBe(stock);
  }, 120_000);
});

// ============================================================================
// 能力矩阵统计行防漂移守卫（v0.5.15）
// ----------------------------------------------------------------------------
// docs/capabilities.md 是论文底稿：统计行曾停留在 v0.5.4 口径且被截断，与表格
// 实态漂移（#128/B9 标 ⬜ 但实现已落地两个版本）。本守卫把「统计行 = 表格实态」
// 变成机械断言 —— 改表不改编号行、或改行不改表，CI 当场红。
// ============================================================================
describe("能力矩阵统计防漂移（docs/capabilities.md）", () => {
  const md = fs.readFileSync(path.join(ROOT, "docs/capabilities.md"), "utf-8");

  function count(pattern: RegExp): { total: number; done: number; partial: number; todo: number } {
    // 注意：String.match(/…/g) 返回完整匹配串而非捕获组 —— 必须走 matchAll 取组 1。
    const marks = [...md.matchAll(pattern)].map((m) => m[1] ?? "");
    return {
      total: marks.length,
      done: marks.filter((m) => m === "✅").length,
      partial: marks.filter((m) => m === "🟡").length,
      todo: marks.filter((m) => m === "⬜").length,
    };
  }

  test("主表 150 行齐全（十大类逐项在册）", () => {
    const rows = [...md.matchAll(/^\| (\d+) \| [^|]+ \| (✅|🟡|⬜) \|/gm)];
    expect(rows.length).toBe(150);
    const nums = rows.map((m) => Number(m[1]));
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(150);
    expect(new Set(nums).size).toBe(150);
  });

  test("专家表 25 行齐全（A–E 五组逐项在册）", () => {
    const rows = [...md.matchAll(/^\| ([A-E]\d+) [^|]+\| (✅|🟡|⬜) \|/gm)];
    expect(rows.length).toBe(25);
  });

  test("统计行与表格实态一致（主表 + 专家表，改表必改行）", () => {
    const main = count(/^\| \d+ \| [^|]+ \| (✅|🟡|⬜) \|/gm);
    expect(main.total).toBe(150);
    const expert = count(/^\| [A-E]\d+ [^|]+\| (✅|🟡|⬜) \|/gm);
    expect(expert.total).toBe(25);
    const statsMain = md.match(/主 Agent 150 项 → ✅ (\d+) · 🟡 (\d+) · ⬜ (\d+)/);
    expect(statsMain).not.toBeNull();
    expect(Number(statsMain![1])).toBe(main.done);
    expect(Number(statsMain![2])).toBe(main.partial);
    expect(Number(statsMain![3])).toBe(main.todo);
    const statsExpert = md.match(/专家 25 项 → ✅ (\d+) · 🟡 (\d+) · ⬜ (\d+)/);
    expect(statsExpert).not.toBeNull();
    expect(Number(statsExpert![1])).toBe(expert.done);
    expect(Number(statsExpert![2])).toBe(expert.partial);
    expect(Number(statsExpert![3])).toBe(expert.todo);
  });

  test("无截断残留（统计段完整成句，v0.5.4 截断事故防复发）", () => {
    expect(md).not.toMatch(/（v0\.5\.8：#19$/m);
    expect(md).not.toMatch(/#19\s*$/m);
  });
});
