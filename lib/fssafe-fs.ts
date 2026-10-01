// ============================================================================
// lib/fssafe-fs.ts — node:fs 删除面垫片（环境兼容层 · 主覆盖面）
// ----------------------------------------------------------------------------
// 为什么需要垫片而不是运行期补丁：Bun 的 ESM 命名空间对内置模块函数做
// **链接期快照**（v0.5.25 实测：require("node:fs") 上的改写对 `import * as fs`
// 消费者不可见；命名空间属性 configurable:false，无法二次改写；而 Node 与
// busybox 删除路径均正常 —— 该不兼容仅存在于 Bun 的删除实现与受限内核之间）。
//
// 本模块用「re-export + 显式覆写」提供等价 fs：
//   - export * from "node:fs"           —— 一切读写 API 原样透传；
//   - 覆写 rmSync / rm / promises.rm    —— 三个删除入口走 fssafe 三级降级链；
//   - 正常内核行为零变化（仅原生失败且错误可恢复时接管）。
//
// 消费方式：把 `import * as fs from "node:fs"` 换成
// `import * as fs from "<相对路径>/lib/fssafe-fs.ts"`。
// 语义保持与降级判据见 lib/fssafe.ts 模块头注释（本文件零自研删除逻辑）。
// 次要保险面：lib/fssafe-preload.ts（运行期补丁）+ bunfig.toml preload。
// 关闭开关：ORG_FSSAFE_OFF=1。
// ============================================================================

export * from "node:fs";
import * as nodeFs from "node:fs";
import { fssafeFallback, FSSAFE_STATS } from "./fssafe.ts";

/** 可恢复错误集：命中才进入降级链（其余错误照原样抛出）。 */
const RECOVERABLE = new Set(["EPERM", "EACCES", "EFAULT", "EBUSY", "ENOTEMPTY"]);

/** 语义保持判据：recursive 删除可接管；非递归仅文件/符号链接可接管（目录错误原样抛出）。 */
function canTakeOver(err: any, options: any, target: any): boolean {
  if (!RECOVERABLE.has(err?.code)) return false;
  if (options && options.recursive === true) return true;
  try {
    return !nodeFs.lstatSync(String(target)).isDirectory();
  } catch {
    return false;
  }
}

function note(face: string): void {
  FSSAFE_STATS.patchFallback++; // 与预载面共用同一观测计量
  if (process.env.ORG_FSSAFE_VERBOSE === "1") {
    console.error(`[fssafe] 原生删除失败 → 降级链接管（${face}）`);
  }
}

// ---- 覆写 ①：rmSync --------------------------------------------------------
export function rmSync(target: any, options?: any): void {
  try {
    return nodeFs.rmSync(target, options);
  } catch (err: any) {
    if (!canTakeOver(err, options, target)) throw err;
    note("shim.rmSync");
    if (fssafeFallback(String(target))) return;
    throw err; // 三级全败：重抛原始错误（不掩盖根因）
  }
}

// ---- 覆写 ②：rm（回调形态） -------------------------------------------------
export function rm(target: any, options?: any, callback?: any): void {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const cb = typeof callback === "function" ? callback : () => {};
  try {
    return nodeFs.rm(target, options, (err: any) => {
      if (!err || !canTakeOver(err, options, target)) return cb(err);
      note("shim.rm");
      if (fssafeFallback(String(target))) return cb(null);
      return cb(err);
    });
  } catch (err: any) {
    return cb(err);
  }
}

// ---- 覆写 ③：promises.rm（共享对象原地修补 —— 实测可改写） -------------------
(function patchPromisesRm(): void {
  const p: any = nodeFs.promises;
  if (!p || typeof p.rm !== "function") return;
  const orig = p.rm.bind(p);
  p.rm = async function patchedPromisesRm(target: any, options?: any) {
    try {
      return await orig(target, options);
    } catch (err: any) {
      if (!canTakeOver(err, options, target)) throw err;
      note("shim.promises.rm");
      if (fssafeFallback(String(target))) return;
      throw err;
    }
  };
})();

export const promises = nodeFs.promises;
