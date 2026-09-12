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
