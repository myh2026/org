// ============================================================================
// tests/check.test.ts — 结构闸门：全部 HSL 模块必须过 dhv check
// ============================================================================

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, DHV, runDhv, runOrg } from "./helpers";

function collectHsl(dir: string, out: string[] = [], skip = new Set([".git", "node_modules", ".hsl-runs", "demo-run", "demo-run-tests"])): string[] {
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
  });

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
  });

  test("mint_hsl 剧本与 stock 逐字一致（生成器出题 = 人工抽查存档）", () => {
    const stock = fs.readFileSync(path.join(ROOT, "hsl/factory/stock/record-validator.hsl"), "utf-8");
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/run-notices.json"), "utf-8"));
    expect(fixture.tracks.mint_hsl[0]).toBe(stock);
  });
});
