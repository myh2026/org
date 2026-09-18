// ============================================================================
// tests/owners.test.ts — CODEOWNERS + 评审人推荐（v0.5.15 · capabilities
// #89/#85）
// ----------------------------------------------------------------------------
// 四层验证：
//   1. 解析：注释行/空行跳过、@ 前缀剥除、空格分隔 owner、行号与来源、
//      空文件与纯注释文件不炸
//   2. 匹配：精确 / lib/** 通配 / 覆盖语义（后规则胜）/ 无匹配留空 /
//      裸文件名任意深度 / `*` 默认规则
//   3. 推荐：聚合排序、reason 溯源格式、fromCodeowners:true；无
//      CODEOWNERS → 目录启发式降级（占位人 + fallbackReason）
//   4. 位置优先级：.org/CODEOWNERS > 根 CODEOWNERS > .github/CODEOWNERS
// 工作区全部为 tmp 一次性目录（不触碰真实仓库）。
// ============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCodeowners, matchOwners, recommendReviewers } from "../lib/owners.ts";

/** 一次性测试工作区（用后即焚）。 */
const tmpWs: string[] = [];
function mkWs(files: Record<string, string | null>): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "org-owners-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const dst = path.join(ws, rel);
    if (content === null) continue; // 占位（目录已建但文件缺席）
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, "utf-8");
  }
  tmpWs.push(ws);
  return ws;
}

afterEach(() => {
  while (tmpWs.length > 0) fs.rmSync(tmpWs.pop()!, { recursive: true, force: true });
});

/** 主语料：注释 + 默认规则 + lib/** + docs/*.md（空格分隔 owner）+ png 裸通配 + toolchain 精确前缀。 */
const SEED = [
  "# ORG CODEOWNERS —— 评审责任规则",
  "",
  "*                       @default-team",
  "lib/**                  @hsl-owner @org-owner",
  "docs/*.md               docs-team",
  "*.png                   @png-team",
  "/toolchain/dhv-ts/**    @hsl-owner",
].join("\n") + "\n";

// ---- 1. 解析 ---------------------------------------------------------------------

describe("CODEOWNERS：解析", () => {
  test(".org/CODEOWNERS：注释/空行跳过、@ 剥除、行号与来源正确", () => {
    const ws = mkWs({ ".org/CODEOWNERS": SEED });
    const { rules, file, defaults } = loadCodeowners(ws);
    expect(file).toBe(path.join(ws, ".org", "CODEOWNERS"));
    expect(rules.length).toBe(5);
    expect(rules.map((r) => r.pattern)).toEqual(["*", "lib/**", "docs/*.md", "*.png", "/toolchain/dhv-ts/**"]);
    expect(rules[1]!.owners).toEqual(["hsl-owner", "org-owner"]); // @ 前缀剥除
    expect(rules[2]!.owners).toEqual(["docs-team"]); // 无 @ 的空格分隔 owner
    expect(rules[1]!.line).toBe(4); // 1 基行号（跳过注释与空行后仍按原文行号）
    expect(rules[1]!.source).toBe(file);
    expect(defaults).toEqual(["default-team"]); // `*` 规则 → 全仓默认责任人
  }, 30_000);

  test("无 owner 的行无效（跳过不炸）", () => {
    const ws = mkWs({ ".org/CODEOWNERS": "lib/**\ndocs/ @docs-team\n" });
    const { rules } = loadCodeowners(ws);
    expect(rules.length).toBe(1);
    expect(rules[0]!.pattern).toBe("docs/");
  }, 30_000);

  test("空文件 / 纯注释文件 → rules:[] 不炸（file 仍指向该文件）", () => {
    const a = mkWs({ ".org/CODEOWNERS": "" });
    expect(loadCodeowners(a)).toEqual({ rules: [], file: path.join(a, ".org", "CODEOWNERS"), defaults: [] });
    const b = mkWs({ ".org/CODEOWNERS": "# 只有注释\n# 第二行\n" });
    expect(loadCodeowners(b).rules).toEqual([]);
  }, 30_000);

  test("三位置优先级：.org/ > 根 > .github/", () => {
    const ws = mkWs({
      ".org/CODEOWNERS": "* @org-team\n",
      "CODEOWNERS": "* @root-team\n",
      ".github/CODEOWNERS": "* @github-team\n",
    });
    expect(loadCodeowners(ws).rules[0]!.owners).toEqual(["org-team"]);
    fs.rmSync(path.join(ws, ".org", "CODEOWNERS"));
    expect(loadCodeowners(ws).rules[0]!.owners).toEqual(["root-team"]);
    fs.rmSync(path.join(ws, "CODEOWNERS"));
    expect(loadCodeowners(ws).rules[0]!.owners).toEqual(["github-team"]);
    fs.rmSync(path.join(ws, ".github", "CODEOWNERS"));
    const none = loadCodeowners(ws);
    expect(none.rules).toEqual([]);
    expect(none.file).toBeNull();
    expect(none.defaults).toEqual([]);
  }, 30_000);
});

// ---- 2. 匹配 ---------------------------------------------------------------------

describe("CODEOWNERS：匹配", () => {
  test("精确路径命中 + 无匹配 → owners:[]（file 原样返回）", () => {
    const ws = mkWs({ ".org/CODEOWNERS": "docs/readme.md @docs-team\n" });
    const r = matchOwners(ws, ["docs/readme.md", "docs/other.md"]);
    expect(r[0]).toEqual({ file: "docs/readme.md", owners: ["docs-team"] });
    expect(r[1]).toEqual({ file: "docs/other.md", owners: [] });
  }, 30_000);

  test("lib/** 通配：任意深度命中，lib 目录本身不命中", () => {
    const ws = mkWs({ ".org/CODEOWNERS": "lib/** @lib-team\n" });
    const files = ["lib/search.ts", "lib/a/b/c.ts", "lib", "weblib/x.ts", "hsl/lib.hsl"];
    const r = matchOwners(ws, files);
    expect(r[0]!.owners).toEqual(["lib-team"]);
    expect(r[1]!.owners).toEqual(["lib-team"]);
    expect(r[2]!.owners).toEqual([]); // ** 不含目录自身
    expect(r[3]!.owners).toEqual([]); // 前缀串不算
    expect(r[4]!.owners).toEqual([]);
  }, 30_000);

  test("覆盖语义：两条规则都命中时后者胜（GitHub 后规则覆盖前规则）", () => {
    const ws = mkWs({ ".org/CODEOWNERS": "lib/** @a-team\nlib/search.ts @b-team\n" });
    const r = matchOwners(ws, ["lib/search.ts", "lib/other.ts"]);
    expect(r[0]!.owners).toEqual(["b-team"]); // 更靠后的规则胜出
    expect(r[1]!.owners).toEqual(["a-team"]); // 未被覆盖的回落到通配规则
  }, 30_000);

  test("裸文件名 / 裸通配（无斜线）：任意深度按文件名匹配", () => {
    const ws = mkWs({ ".org/CODEOWNERS": "Makefile @build-team\n*.png @png-team\n" });
    const r = matchOwners(ws, ["Makefile", "tools/Makefile", "assets/icon.png", "icon.png", "docs/vector.svg"]);
    expect(r[0]!.owners).toEqual(["build-team"]);
    expect(r[1]!.owners).toEqual(["build-team"]);
    expect(r[2]!.owners).toEqual(["png-team"]);
    expect(r[3]!.owners).toEqual(["png-team"]);
    expect(r[4]!.owners).toEqual([]);
  }, 30_000);

  test("目录尾斜杠与 docs/* 单层语义", () => {
    const ws = mkWs({ ".org/CODEOWNERS": "apps/ @app-team\ndocs/* @doc-team\n" });
    const r = matchOwners(ws, ["apps/x.ts", "apps/a/b.ts", "docs/a.md", "docs/sub/b.md"]);
    expect(r[0]!.owners).toEqual(["app-team"]);
    expect(r[1]!.owners).toEqual(["app-team"]); // 目录前缀含深层
    expect(r[2]!.owners).toEqual(["doc-team"]);
    expect(r[3]!.owners).toEqual([]); // * 不跨 /
  }, 30_000);

  test("`*` 默认规则兜底一切路径", () => {
    const ws = mkWs({ ".org/CODEOWNERS": SEED });
    const r = matchOwners(ws, ["README.md", "hsl/org.hsl"]);
    expect(r[0]!.owners).toEqual(["default-team"]);
    expect(r[1]!.owners).toEqual(["default-team"]);
  }, 30_000);
});

// ---- 3. 评审人推荐 -------------------------------------------------------------------

describe("CODEOWNERS：评审人推荐", () => {
  test("聚合：filesCovered 降序 + fromCodeowners:true + reason 溯源模式", () => {
    const ws = mkWs({ ".org/CODEOWNERS": SEED });
    const changed = [
      "lib/search.ts", "lib/owners.ts",           // lib/** → hsl-owner + org-owner
      "docs/readme.md",                            // docs/*.md → docs-team
      "toolchain/dhv-ts/src/main.ts",              // /toolchain/dhv-ts/** → hsl-owner
      "README.md",                                 // * → default-team
    ];
    const { reviewers, fromCodeowners } = recommendReviewers(ws, changed);
    expect(fromCodeowners).toBe(true);
    expect(reviewers[0]).toEqual({
      name: "hsl-owner",
      filesCovered: 3,
      reason: "CODEOWNERS: lib/**, /toolchain/dhv-ts/**",
    });
    expect(reviewers[1]!.name).toBe("org-owner");
    expect(reviewers[1]!.filesCovered).toBe(2);
    expect(reviewers[1]!.reason).toBe("CODEOWNERS: lib/**");
    // 计数 1 的两位按名字典序稳定排序（default-team < docs-team）
    expect(reviewers.slice(2).map((r) => r.name)).toEqual(["default-team", "docs-team"]);
    expect(reviewers.every((r) => r.reason.startsWith("CODEOWNERS: "))).toBe(true);
  }, 30_000);

  test("空变更集（有 CODEOWNERS）→ reviewers:[] 且仍 fromCodeowners:true", () => {
    const ws = mkWs({ ".org/CODEOWNERS": SEED });
    const r = recommendReviewers(ws, []);
    expect(r.reviewers).toEqual([]);
    expect(r.fromCodeowners).toBe(true);
  }, 30_000);

  test("无 CODEOWNERS → 目录启发式降级（占位人 + fallbackReason 非空）", () => {
    const ws = mkWs({}); // 干净工作区（三位置均无 CODEOWNERS）
    const changed = ["lib/a.ts", "lib/b.ts", "web/entry.ts", "README.md"];
    const { reviewers, fromCodeowners, fallbackReason } = recommendReviewers(ws, changed);
    expect(fromCodeowners).toBe(false);
    expect(typeof fallbackReason).toBe("string");
    expect(fallbackReason!.length).toBeGreaterThan(0);
    expect(fallbackReason).toContain("CODEOWNERS"); // 指引建立规则
    // 占位评审人：lib-owner 覆盖最多排第一；根级文件归 repo-root-owner
    expect(reviewers[0]!.name).toBe("lib-owner");
    expect(reviewers[0]!.filesCovered).toBe(2);
    const names = reviewers.map((r) => r.name);
    expect(names).toContain("web-owner");
    expect(names).toContain("repo-root-owner");
    expect(reviewers.every((r) => r.reason.startsWith("目录启发式："))).toBe(true);
  }, 30_000);

  test("启发式占位人的诚实性：reason 与 fallbackReason 都明示非真实责任人", () => {
    const ws = mkWs({ "lib/placeholder.txt": "" }); // 有目录结构但无 CODEOWNERS
    const { reviewers, fallbackReason } = recommendReviewers(ws, ["lib/x.ts"]);
    expect(reviewers[0]!.name).toBe("lib-owner");
    expect(reviewers[0]!.reason).toContain("目录启发式");
    expect(fallbackReason).toContain("非真实维护人");
  }, 30_000);
});
