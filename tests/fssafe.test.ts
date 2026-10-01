// ============================================================================
// tests/fssafe.test.ts — 安全删除兼容层回归（v0.5.25）
// ----------------------------------------------------------------------------
// 覆盖：三级降级链各级实弹（原生 / 遍历 / shell）· 全局补丁语义保持
// （EISDIR / ENOENT / force 三条不变量）· 悬空链接与符号链接安全 ·
// 幂等挂载 · 观测计数。纯本地文件系统操作，零外部依赖、零网络。
// ============================================================================

// 显式挂载兼容层（与 bunfig preload 双保险；幂等零副作用）
import "../lib/fssafe-preload.ts";
import { test, expect, describe } from "bun:test";
import * as fs from "../lib/fssafe-fs.ts"; // fs 垫片（删除入口带降级链；详见 lib/fssafe.ts）
import * as path from "node:path";
import { rmrf, walkRm, FSSAFE_STATS, installFssafePatch } from "../lib/fssafe.ts";

const SCRATCH = path.join(import.meta.dir, "..", "demo-run-tests", "fssafe-scratch");
let seq = 0;
function scratch(name: string): string {
  const p = path.join(SCRATCH, `${name}-${Date.now()}-${seq++}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 造一棵「难删树」：深嵌套 + 只读文件 + 空目录（符号链接按平台能力可选）。 */
function buildTree(base: string, withLinks: boolean): void {
  fs.mkdirSync(path.join(base, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(base, "a", "f1.txt"), "1");
  fs.writeFileSync(path.join(base, "a", "b", "f2.txt"), "2");
  fs.writeFileSync(path.join(base, "a", "b", "c", "f3.txt"), "3");
  fs.chmodSync(path.join(base, "a", "b", "f2.txt"), 0o444); // 只读文件
  fs.mkdirSync(path.join(base, "a", "b", "empty"));
  if (withLinks) {
    // 符号链接：一个指向文件、一个指向目录（删除时不得跟随出树）
    fs.symlinkSync(path.join(base, "a", "f1.txt"), path.join(base, "a", "link-file"));
    fs.symlinkSync(path.join(base, "a", "b"), path.join(base, "a", "link-dir"));
  }
}

/** 符号链接能力探测（受限挂载点如 iOS 共享目录不允许创建 → 子用例诚实跳过）。 */
function symlinkCapable(): boolean {
  const probe = path.join(SCRATCH, `.symprobe-${Date.now()}`);
  try {
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, "t"), "x");
    fs.symlinkSync(path.join(probe, "t"), path.join(probe, "l"));
    return true;
  } catch {
    return false;
  } finally {
    try { rmrf(probe); } catch { /* 尽力 */ }
  }
}

describe("fssafe：安全删除兼容层", () => {
  test("rmrf 默认链（原生起）：难删树整体删除", () => {
    const t = scratch("rmrf-default");
    buildTree(t, false);
    const ok = rmrf(t);
    expect(ok).toBe(true);
    expect(fs.existsSync(t)).toBe(false);
  });

  test("rmrf forceLevel:2（跳过原生，手工遍历实体）", () => {
    const t = scratch("rmrf-walk");
    buildTree(t, false);
    const ok = rmrf(t, { forceLevel: 2 });
    expect(ok).toBe(true);
    expect(fs.existsSync(t)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("rmrf forceLevel:3（shell 兜底实体）", () => {
    const t = scratch("rmrf-shell");
    buildTree(t, false);
    const ok = rmrf(t, { forceLevel: 3 });
    expect(ok).toBe(true);
    expect(fs.existsSync(t)).toBe(false);
  });

  test.if(symlinkCapable())("walkRm：符号链接不跟随（删链接本体，目标存活）", () => {
    const t = scratch("walk-links");
    buildTree(t, true);
    const outside = scratch("walk-outside");
    fs.writeFileSync(path.join(outside, "precious.txt"), "precious");
    fs.symlinkSync(outside, path.join(t, "a", "link-outside")); // 指向树外
    walkRm(t);
    expect(fs.existsSync(t)).toBe(false);
    // 树外目标必须完好（不跟随出树）
    expect(fs.existsSync(path.join(outside, "precious.txt"))).toBe(true);
    rmrf(outside);
  });

  test("全局补丁：存量 fs.rmSync(recursive) 调用点在失败内核上自动降级", () => {
    const t = scratch("patch-sync");
    buildTree(t, false);
    // 本用例在 iSH 类内核上「修复前必炸（EPERM）」——现在必须静默成功
    expect(() => fs.rmSync(t, { recursive: true, force: true })).not.toThrow();
    expect(fs.existsSync(t)).toBe(false);
  });

  test("语义保持①：非递归删目录照旧抛错，且目录不被接管删除", () => {
    const t = scratch("semantics-dir");
    expect(() => fs.rmSync(t)).toThrow();
    expect(fs.existsSync(t)).toBe(true); // 不越权
    rmrf(t);
  });

  test("语义保持②：非递归删不存在路径抛 ENOENT；force:true 静默", () => {
    const missing = path.join(SCRATCH, `missing-${Date.now()}`);
    expect(() => fs.rmSync(missing)).toThrow();
    expect(() => fs.rmSync(missing, { force: true })).not.toThrow();
  });

  test("异步面：fs.promises.rm 同样获得降级（难删树）", async () => {
    const t = scratch("patch-promises");
    buildTree(t, false);
    await fs.promises.rm(t, { recursive: true, force: true });
    expect(fs.existsSync(t)).toBe(false);
  });

  test("幂等挂载：重复 installFssafePatch 零副作用", () => {
    const r = installFssafePatch(); // 上方 import 已挂载
    expect(r.installed).toBe(false);
    expect(r.reason).toBe("already-patched");
  });

  test("观测：rmrf 调用与成功计数单调增长", () => {
    const before = FSSAFE_STATS.rmrfCalls;
    const t = scratch("stats");
    buildTree(t, false);
    rmrf(t);
    expect(FSSAFE_STATS.rmrfCalls).toBeGreaterThan(before);
    expect(FSSAFE_STATS.rmrfOk).toBeGreaterThanOrEqual(1);
  });
});
