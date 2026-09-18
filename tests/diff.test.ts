// ============================================================================
// tests/diff.test.ts — unified diff 渲染器（v0.5.15 · capabilities #49/#60）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/diff.ts 四导出的行为级断言）：
//   1. identical：相同文本 · CRLF 归一（\r\n 与孤立 \r vs \n）
//   2. 基础编辑：单行增/删/改的 adds/dels/hunks 计数 + @@ 头行号
//   3. 边界形态：全新增（-0,0）/ 全删除（+0,0）
//   4. hunk 几何：远距双改 → 2 hunks（context=3）；context=0 行号断言；
//      公共头尾剥离（头尾相同中间不同 → 单 hunk 精确边界）
//   5. 渲染：renderUnified 标准格式全文断言 · renderStats 摘要三态
//      （无变化 / 单复数 hunks / 截断后缀）
//   6. 性能防线：3000 行改 1 行（剥离后走 LCS 不超时）；5000 行整段重写
//      （中段 >2000 → 整段替换快速路径 + maxLines 截断）
//   7. diffFiles 三态降级：oldFile 缺失=全新增 · newFile 缺失=missing ·
//      二进制=binary · 目录路径=read · 正常双文件
//   8. maxLines：散布修改 → truncated:true + 行数帽 + 全量统计口径
// 全部显式 30s 超时（性能用例的回归防线）。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN } from "./helpers";
import { diffText, diffFiles, renderUnified, renderStats } from "../lib/diff.ts";

const DIR = path.join(TEST_RUN, "diff-fixture");

/** 生成 n 行数组（1 基编号，零填充保证字典序 = 行序）。 */
function lines(n: number, prefix = "l"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(4, "0")}`);
}

/** 行数组 → 文本（尾随换行）。 */
function join(ls: string[]): string {
  return ls.length === 0 ? "" : `${ls.join("\n")}\n`;
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---- 1-3. identical / CRLF / 基础编辑 ----------------------------------------

describe("diffText · identical 与 CRLF 归一", () => {
  test("相同文本 → identical:true，零输出", () => {
    const r = diffText("a\nb\nc\n", "a\nb\nc\n");
    expect(r.identical).toBe(true);
    expect(r.hunks).toBe(0);
    expect(r.adds).toBe(0);
    expect(r.dels).toBe(0);
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(false);
  }, 30_000);

  test("CRLF 归一：\\r\\n 与 \\n（含孤立 \\r）视为相同", () => {
    expect(diffText("a\r\nb\r\n", "a\nb\n").identical).toBe(true);
    expect(diffText("a\rb\n", "a\nb\n").identical).toBe(true); // 孤立 \r（混合行尾）
  }, 30_000);
});

describe("diffText · 基础编辑计数", () => {
  test("单行新增：adds=1 · hunks=1 · 头 @@ -1,2 +1,3 @@", () => {
    const r = diffText("a\nb\n", "a\nb\nc\n");
    expect(r.identical).toBe(false);
    expect(r.adds).toBe(1);
    expect(r.dels).toBe(0);
    expect(r.hunks).toBe(1);
    expect(r.lines[0]).toEqual({ kind: "hunk", text: "@@ -1,2 +1,3 @@" });
    const add = r.lines.filter((l) => l.kind === "add");
    expect(add).toHaveLength(1);
    expect(add[0]!.text).toBe("c");
    expect(add[0]!.newNo).toBe(3);
    expect(add[0]!.oldNo).toBeUndefined();
  }, 30_000);

  test("单行删除：dels=1 · 头 @@ -1,3 +1,2 @@", () => {
    const r = diffText("a\nb\nc\n", "a\nc\n");
    expect(r.dels).toBe(1);
    expect(r.adds).toBe(0);
    expect(r.hunks).toBe(1);
    expect(r.lines[0]!.text).toBe("@@ -1,3 +1,2 @@");
    const del = r.lines.find((l) => l.kind === "del")!;
    expect(del.text).toBe("b");
    expect(del.oldNo).toBe(2);
  }, 30_000);

  test("单行修改 + renderUnified 标准格式全文", () => {
    const r = diffText("a\nb\nc\n", "a\nB\nc\n");
    expect(r.adds).toBe(1);
    expect(r.dels).toBe(1);
    expect(r.hunks).toBe(1);
    expect(renderUnified(r, "old.txt", "new.txt"))
      .toBe("--- a/old.txt\n+++ b/new.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  }, 30_000);

  test("全新增（空旧文本）与全删除（空新文本）", () => {
    const add = diffText("", "x\ny\n");
    expect(add.hunks).toBe(1);
    expect(add.adds).toBe(2);
    expect(add.dels).toBe(0);
    expect(add.lines[0]!.text).toBe("@@ -0,0 +1,2 @@");
    expect(renderStats(add)).toBe("+2 −0 · 1 hunk");
    const del = diffText("x\ny\n", "");
    expect(del.hunks).toBe(1);
    expect(del.dels).toBe(2);
    expect(del.adds).toBe(0);
    expect(del.lines[0]!.text).toBe("@@ -1,2 +0,0 @@");
  }, 30_000);
});

// ---- 4. hunk 几何 ------------------------------------------------------------

describe("diffText · hunk 几何", () => {
  const old40 = lines(40);
  const new40 = [...old40];
  new40[2] = "L0003"; // 第 3 行
  new40[34] = "L0035"; // 第 35 行（远距双改）

  test("远距双改（context=3）→ 2 hunks，双头行号精确", () => {
    const r = diffText(join(old40), join(new40));
    expect(r.hunks).toBe(2);
    expect(r.adds).toBe(2);
    expect(r.dels).toBe(2);
    const heads = r.lines.filter((l) => l.kind === "hunk").map((l) => l.text);
    // hunk1：变更第 3 行 → 覆盖 1-6（前侧上下文触顶）；hunk2：变更第 35 行 → 覆盖 32-38
    expect(heads).toEqual(["@@ -1,6 +1,6 @@", "@@ -32,7 +32,7 @@"]);
    expect(renderStats(r)).toBe("+2 −2 · 2 hunks");
  }, 30_000);

  test("context=0 → 仅变更行，行号断言", () => {
    const r = diffText(join(old40), join(new40), { context: 0 });
    expect(r.hunks).toBe(2);
    expect(r.lines).toHaveLength(6); // 2 头 + 2 del + 2 add
    expect(
      r.lines.map((l) => `${l.kind}:${l.text}:${l.oldNo ?? ""}/${l.newNo ?? ""}`),
    ).toEqual([
      "hunk:@@ -3,1 +3,1 @@:/",
      "del:l0003:3/",
      "add:L0003:/3",
      "hunk:@@ -35,1 +35,1 @@:/",
      "del:l0035:35/",
      "add:L0035:/35",
    ]);
  }, 30_000);

  test("公共头尾剥离：头尾各 5 行相同、中间 1 行不同 → 单 hunk 收敛", () => {
    const old11 = lines(11);
    const new11 = [...old11];
    new11[5] = "X0006"; // 第 6 行
    const r = diffText(join(old11), join(new11), { context: 2 });
    expect(r.hunks).toBe(1);
    expect(r.lines[0]!.text).toBe("@@ -4,5 +4,5 @@");
    // 头部上下文 2 行 + del + add + 尾部上下文 2 行（上下文从剥离区回借）
    expect(r.lines.map((l) => l.kind)).toEqual([
      "hunk", "context", "context", "del", "add", "context", "context",
    ]);
    expect(r.lines[1]!.oldNo).toBe(4);
    expect(r.lines[1]!.newNo).toBe(4);
  }, 30_000);

  test("renderStats 三态：无变化 / 单复数 hunks / 截断后缀", () => {
    expect(renderStats(diffText("a\n", "a\n"))).toBe("无变化");
    expect(renderStats(diffText("a\nb\nc\n", "a\nB\nc\n"))).toBe("+1 −1 · 1 hunk");
    const big = diffText(join(lines(5000, "o")), join(lines(5000, "n")));
    expect(renderStats(big)).toBe("+5000 −5000 · 1 hunk · 已截断");
  }, 30_000);
});

// ---- 6. 性能防线 --------------------------------------------------------------

describe("diffText · 性能防线", () => {
  test("3000 行改 1 行：头尾剥离后走 LCS，单 hunk 精确（不超时）", () => {
    const old3000 = lines(3000);
    const nw = [...old3000];
    nw[1499] = "X1500"; // 第 1500 行
    const r = diffText(join(old3000), join(nw));
    expect(r.hunks).toBe(1);
    expect(r.adds).toBe(1);
    expect(r.dels).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.lines[0]!.text).toBe("@@ -1497,7 +1497,7 @@");
    const del = r.lines.find((l) => l.kind === "del")!;
    expect(del.oldNo).toBe(1500);
  }, 30_000);

  test("5000 行整段重写：中段 >2000 → 快速路径单 hunk + maxLines 截断", () => {
    const r = diffText(join(lines(5000, "o")), join(lines(5000, "n")));
    expect(r.hunks).toBe(1); // 整段替换单 hunk（快速路径）
    expect(r.adds).toBe(5000); // 全量口径
    expect(r.dels).toBe(5000);
    expect(r.truncated).toBe(true); // 10001 行 > 4000 帽
    expect(r.lines).toHaveLength(4000); // 单 hunk 超帽 → 保头硬切
    expect(r.lines[0]!.kind).toBe("hunk");
    expect(renderUnified(r, "a.txt", "b.txt")).toContain("--- a/a.txt");
  }, 30_000);
});

// ---- 7. diffFiles 三态降级 -----------------------------------------------------

describe("diffFiles · 三态降级", () => {
  test("oldFile 不存在 = 全新增；newFile 不存在 = missing", () => {
    const nf = path.join(DIR, "created.txt");
    fs.writeFileSync(nf, "a\nb\n");
    const add = diffFiles(path.join(DIR, "absent-old.txt"), nf);
    expect(add.ok).toBe(true);
    if (add.ok) {
      expect(add.result.identical).toBe(false);
      expect(add.result.hunks).toBe(1);
      expect(add.result.adds).toBe(2);
      expect(add.result.dels).toBe(0);
    }
    const miss = diffFiles(nf, path.join(DIR, "absent-new.txt"));
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.kind).toBe("missing");
      expect(miss.error).toContain("absent-new.txt");
    }
  }, 30_000);

  test("二进制（含 \\0）→ kind:'binary'（新旧两侧同规）", () => {
    const bin = path.join(DIR, "blob.bin");
    fs.writeFileSync(bin, Buffer.from("a\0b"));
    const txt = path.join(DIR, "text.txt");
    fs.writeFileSync(txt, "a\n");
    for (const [o, n] of [
      [bin, txt],
      [txt, bin],
    ] as const) {
      const r = diffFiles(o, n);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("binary");
        expect(r.error).toContain("NUL");
      }
    }
  }, 30_000);

  test("目录路径 → kind:'read'；正常双文件 → ok:true", () => {
    const a = path.join(DIR, "a.txt");
    const b = path.join(DIR, "b.txt");
    fs.writeFileSync(a, "one\ntwo\n");
    fs.writeFileSync(b, "one\nTWO\n");
    const bad = diffFiles(DIR, b); // 目录当文件读 → EISDIR
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("read");
    const ok = diffFiles(a, b);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.result.adds).toBe(1);
      expect(ok.result.dels).toBe(1);
      expect(renderUnified(ok.result, "a.txt", "b.txt")).toContain("-two");
      expect(renderUnified(ok.result, "a.txt", "b.txt")).toContain("+TWO");
    }
  }, 30_000);
});

// ---- 8. maxLines 截断 ----------------------------------------------------------

describe("diffText · maxLines 截断", () => {
  test("10 处散布修改 → truncated:true · 行数帽 · 全量统计口径", () => {
    const old = lines(100);
    const nw = [...old];
    for (let i = 0; i < 10; i++) nw[4 + i * 10] = `X${String(5 + i * 10).padStart(4, "0")}`;
    const r = diffText(join(old), join(nw), { context: 3, maxLines: 30 });
    expect(r.hunks).toBe(10); // 全量口径：散布修改互不相邻（间隔 9 > 2×3）
    expect(r.adds).toBe(10);
    expect(r.dels).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.lines.length).toBeLessThanOrEqual(30);
    expect(r.lines.length).toBeGreaterThanOrEqual(9); // 至少一个完整 hunk（头+3ctx+del+add+3ctx）
    expect(r.lines[0]!.kind).toBe("hunk");
  }, 30_000);
});
