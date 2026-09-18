// ============================================================================
// lib/pathjail.ts — 工作区路径监狱 · 跨平台统一比较形（v0.5.16）
// ----------------------------------------------------------------------------
// 背景（CI 实录 · run 35367288947 win32 cross-platform-tests 红）：
//   工具环 native 块里监狱判定把工作区路径归一成 "/" 形（`.replace(/\\/g,"/")`，
//   绝对路径时原样保留），而 `path.resolve()` 在 win32 产出 "\" 形 —— 两侧混形
//   前缀比较必然失败，`src/app.hsl` 这类合法相对路径被判「路径越界」假阳性
//   （complete_at 实锤；git_merge/git_rebase 显式 repo、plugin_install 本地源、
//   browser_screenshot 相对 out 同病潜伏；wsReal 型 7 处对绝对路径输入同潜伏）。
//
// 修复哲学（多重优雅降级）：
//   1. 单点收敛：所有监狱比较走本模块，不再各块手搓前缀判断；
//   2. 双侧同形：比较前把两侧都归一到 "/" 分隔符（Node fs 在 win32 两种分隔符
//      都接受，落盘路径不必改动，只有「比较形」归一）；
//   3. 大小写折变认平台：win32 文件系统大小写不敏感（D: vs d:、Foo vs foo
//      同路径），比较形小写折叠；POSIX 大小写敏感，原样比较。
//
// 可测性：canonFor/inWsFor 把平台参数化 —— 任意宿主平台上都能钉死 win32 分支
// 语义（tests/pathjail.test.ts），不必等 CI 红灯才发现混形回归。
//
// 语义保持：inWorkspace(ws, p) ≡ p === ws || p.startsWith(ws + sep)，
// 语义不变 —— 只是跨平台不再假阳性/假阴性。出口零依赖（node:path + 平台探测）。
// ----------------------------------------------------------------------------
import * as path from "node:path";

/** 比较形（平台参数化）：分隔符统一 "/"；win32 追加大小写折叠（文件系统大小写不敏感）。 */
export function canonFor(platform: string, p: string): string {
  const n = String(p ?? "").replace(/\\/g, "/");
  return platform === "win32" ? n.toLowerCase() : n;
}

/** 监狱判定（平台参数化）：p 是否等于 ws 或位于 ws 之内（跨平台同形比较）。 */
export function inWsFor(platform: string, ws: string, p: string): boolean {
  const w = canonFor(platform, ws);
  const t = canonFor(platform, p);
  return t === w || t.startsWith(w + "/");
}

/** 比较形（当前平台）：测试与内部使用。 */
export function jailCanonical(p: string): string {
  return canonFor(process.platform, p);
}

/** 监狱判定（当前平台）：p 是否等于 ws 或位于 ws 之内。 */
export function inWorkspace(ws: string, p: string): boolean {
  return inWsFor(process.platform, ws, p);
}

/** 相对形：p 相对 ws 的正斜杠路径（越界时原样返回 —— 调用方自行决定报错口径）。 */
export function jailRelative(ws: string, p: string): string {
  if (!inWorkspace(ws, p)) return String(p);
  const w = jailCanonical(ws);
  const t = jailCanonical(p);
  return t === w ? "." : t.slice(w.length + 1);
}

/** 工作区绝对形：相对路径解析进 ws（win32 下 resolve 产 "\" 形 —— fs 两形皆收）。
 * win32 无盘符基底（POSIX 风格 "/a/ws"）：path.resolve 会附当前盘符（D:\a\ws\…），
 * 与基底的比较形不可比 —— 剥回无盘符形（fs 两形皆收，jail 比较恢复可比）。
 * 生产面 ws 恒为带盘符原生形（org 宿主解析），此分支只救测试/词法形调用。 */
export function resolveInWorkspace(ws: string, p: string): string {
  if (path.isAbsolute(String(p ?? ""))) return String(p);
  const joined = path.resolve(String(ws), String(p));
  if (process.platform === "win32" && !/^[a-zA-Z]:/.test(String(ws)) && /^[a-zA-Z]:/.test(joined)) {
    return joined.slice(2); // 剥盘符：D:\a\ws\x → \a\ws\x（canonFor → /a/ws/x，与基底可比）
  }
  return joined;
}
