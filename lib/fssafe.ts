// ============================================================================
// lib/fssafe.ts — 安全递归删除兼容层（多重优雅降级）
// ----------------------------------------------------------------------------
// 背景（v0.5.25 环境实测发现）：某些受限内核/用户态沙箱（iSH 类环境实弹验证：
// Bun 1.1.45 / 1.2.23 / 1.3.14 / 1.4.2 四个版本逐一复现）上，Bun 内建的
// `fs.rmSync(path, { recursive: true })` 会以 EPERM / EACCES / EFAULT 失败
// —— 这是 Bun 内部删除路径与内核的不兼容，而单项 `unlink` / `rmdir` 正常
// （busybox `rm -rf` 与 Node 的 rmSync 同为正常，仅 Bun 路径受影响）。
//
// 本模块提供三级降级链（只在失败时逐级降级，常规内核行为零变化）：
//   级 1  原生 fs.rmSync(recursive)                       —— 常规内核最快路径
//   级 2  手工遍历（readdir + unlink/rmdir，符号链接安全）—— 零外部依赖
//   级 3  shell 兜底（execFileSync("rm", ["-rf", "--", p])—— 仅非 win32）
//
// 两个消费面：
//   a) 显式调用：`rmrf(target)` —— 测试与需要「一定要删掉」的调用点；
//   b) 全局修补：`installFssafePatch()`（见 lib/fssafe-preload.ts）——
//      替换 fs.rmSync / fs.rm / fs.promises.rm，让存量全部调用点自动获得
//      降级能力，且仅在「recursive:true 遇上可恢复错误」时接管。
//
// 语义保持（补丁绝不改变的行为）：
//   - 非递归删目录照旧抛 ERR_FS_EISDIR / EPERM（不越权删目录）；
//   - 非递归删不存在路径照旧抛 ENOENT；force:true 照旧静默通过；
//   - 降级链全部失败时，重抛**原始**错误（不掩盖根因、不静默吞错）。
//
// 环境开关：ORG_FSSAFE_OFF=1 完全关闭修补；ORG_FSSAFE_VERBOSE=1 降级时打日志。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** 可恢复错误集：命中才进入降级链（其余错误照原样抛出）。 */
const RECOVERABLE = new Set(["EPERM", "EACCES", "EFAULT", "EBUSY", "ENOTEMPTY"]);

/** 降级观测计数（供 status/测试断言；不落盘）。 */
export const FSSAFE_STATS = {
  rmrfCalls: 0, // 显式 rmrf() 调用数
  rmrfOk: 0, // 显式 rmrf() 确认删除数
  rmrfFail: 0, // 显式 rmrf() 最终失败数（三级全败）
  patchFallback: 0, // 全局补丁接管的次数（原生失败 → 降级链）
  walkUsed: 0, // 级 2 手工遍历尝试数
  shellUsed: 0, // 级 3 shell 兜底尝试数
  lastError: "", // 最近一次降级链错误摘要（诚实留痕）
};

/** lstat 语义的存在性判断（不跟随符号链接；悬空链接也算存在）。 */
function lexists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/**
 * 级 2：手工遍历删除。符号链接安全（不跟随链接出树）；
 * 逐项吞 ENOENT（并发删除竞态容忍）；win32 只读文件去位重试。
 */
export function walkRm(target: string): void {
  const st = fs.lstatSync(target);
  if (st.isDirectory()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (e: any) {
      if (e?.code === "ENOENT") return; // 已被并发删走
      throw e;
    }
    for (const ent of entries) walkRm(path.join(target, ent.name));
    fs.rmdirSync(target);
    return;
  }
  try {
    fs.unlinkSync(target);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    // win32 只读文件兜底：去只读位后重试一次（POSIX 无此形态）
    if (process.platform === "win32") {
      try { fs.chmodSync(target, 0o666); fs.unlinkSync(target); return; } catch { /* 落入重抛 */ }
    }
    throw e;
  }
}

/** 级 3：shell 兜底。argv 数组直传（无 shell 解释面）；仅非 win32。 */
export function shellRm(target: string): void {
  if (process.platform === "win32") throw new Error("fssafe: shellRm 在 win32 不可用");
  execFileSync("rm", ["-rf", "--", target], { stdio: "ignore", timeout: 30_000 });
}

/** 降级兜底：级 2 → 级 3；返回目标是否已不存在（不抛错，错误进 stats）。 */
export function fssafeFallback(target: string): boolean {
  if (!lexists(target)) return true;
  try {
    walkRm(target);
    FSSAFE_STATS.walkUsed++;
  } catch (e: any) {
    FSSAFE_STATS.lastError = `walk: ${e?.code ?? e?.message}`;
  }
  if (!lexists(target)) return true;
  try {
    shellRm(target);
    FSSAFE_STATS.shellUsed++;
  } catch (e: any) {
    FSSAFE_STATS.lastError = `shell: ${e?.code ?? e?.message}`;
  }
  return !lexists(target);
}

export interface RmrfOptions {
  /** 测试注入：从指定级别起降级（1=原生起、2=遍历起、3=shell 起）。 */
  forceLevel?: 1 | 2 | 3;
}

/** 显式三级降级删除：返回是否确认删除（不抛错；调用方可按需严判）。 */
export function rmrf(target: string, opts: RmrfOptions = {}): boolean {
  FSSAFE_STATS.rmrfCalls++;
  const ok = fssafeRemove(target, opts.forceLevel ?? 1);
  if (ok) FSSAFE_STATS.rmrfOk++;
  else FSSAFE_STATS.rmrfFail++;
  return ok;
}

function fssafeRemove(target: string, startLevel: 1 | 2 | 3): boolean {
  if (startLevel === 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!lexists(target)) return true;
    } catch (e: any) {
      FSSAFE_STATS.lastError = `rmSync: ${e?.code ?? e?.message}`;
    }
  }
  if (startLevel <= 2) {
    try {
      if (lexists(target)) { walkRm(target); FSSAFE_STATS.walkUsed++; }
      if (!lexists(target)) return true;
    } catch (e: any) {
      FSSAFE_STATS.lastError = `walk: ${e?.code ?? e?.message}`;
    }
  }
  try {
    if (lexists(target)) { shellRm(target); FSSAFE_STATS.shellUsed++; }
  } catch (e: any) {
    FSSAFE_STATS.lastError = `shell: ${e?.code ?? e?.message}`;
  }
  return !lexists(target);
}

// ----------------------------------------------------------------------------
// 全局修补：把三个删除入口替换为「原生 → 降级链」包装。
// 幂等（Symbol.for 守卫）；ORG_FSSAFE_OFF=1 关闭；仅可恢复错误才接管。
// ----------------------------------------------------------------------------

const PATCH_SYMBOL = Symbol.for("org.fssafe.patched");

export interface PatchResult { installed: boolean; reason?: string }

/** 判断某次失败是否应交给降级链接管（语义保持的核心判据）。 */
function canFallback(err: any, options: any, target: any): boolean {
  if (!RECOVERABLE.has(err?.code)) return false;
  if (options && options.recursive === true) return true;
  // 非递归：仅文件/符号链接可接管 —— 目录必须保持原有错误语义原样抛出
  try {
    return !fs.lstatSync(String(target)).isDirectory();
  } catch {
    return false;
  }
}

function note(pathUsed: string): void {
  FSSAFE_STATS.patchFallback++;
  if (process.env.ORG_FSSAFE_VERBOSE === "1") {
    console.error(`[fssafe] 原生删除失败 → 降级链接管（${pathUsed}）`);
  }
}

export function installFssafePatch(): PatchResult {
  const g = globalThis as any;
  if (g[PATCH_SYMBOL]) return { installed: false, reason: "already-patched" };
  if (process.env.ORG_FSSAFE_OFF === "1") return { installed: false, reason: "disabled-by-env" };
  if (typeof require !== "function") return { installed: false, reason: "no-cjs-require" };

  let fsm: any;
  try {
    fsm = require("node:fs");
  } catch (e: any) {
    return { installed: false, reason: `require-failed: ${e?.message}` };
  }
  const origSync: any = fsm.rmSync;
  const origRm: any = typeof fsm.rm === "function" ? fsm.rm : null;
  const origPRm: any = fsm.promises && typeof fsm.promises.rm === "function" ? fsm.promises.rm : null;

  if (typeof origSync === "function") {
    fsm.rmSync = function patchedRmSync(target: any, options?: any) {
      try {
        return origSync(target, options);
      } catch (err: any) {
        if (!canFallback(err, options, target)) throw err;
        note("rmSync");
        if (fssafeFallback(String(target))) return undefined;
        throw err; // 三级全败：重抛原始错误（不掩盖根因）
      }
    };
  }

  if (origRm) {
    fsm.rm = function patchedRm(target: any, options: any, callback?: any) {
      if (typeof options === "function") { callback = options; options = undefined; }
      const cb = typeof callback === "function" ? callback : () => {};
      try {
        return origRm.call(fsm, target, options, (err: any) => {
          if (!err || !canFallback(err, options, target)) return cb(err);
          note("rm");
          if (fssafeFallback(String(target))) return cb(null);
          return cb(err);
        });
      } catch (err: any) {
        return cb(err);
      }
    };
  }

  if (origPRm) {
    fsm.promises.rm = async function patchedPromisesRm(target: any, options?: any) {
      try {
        return await origPRm.call(fsm.promises, target, options);
      } catch (err: any) {
        if (!canFallback(err, options, target)) throw err;
        note("promises.rm");
        if (fssafeFallback(String(target))) return undefined;
        throw err;
      }
    };
  }

  g[PATCH_SYMBOL] = true;
  return { installed: true };
}
