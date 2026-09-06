// ============================================================================
// org/lib/root.ts — 运行时根解析（单二进制分发的地基）
// ----------------------------------------------------------------------------
// 两种运行形态：
//   源码模式（bun cli/org.ts / bun tui）    ROOT = 仓库目录，payload 不启用；
//   编译模式（org-* 单二进制）              ROOT = payload 解包目录
//     （~/.org/runtime-<sha112>/，含 hsl/ + toolchain/dhv-ts/src/ +
//      demo-ws/ + fixtures/；按 payload 内容指纹缓存，升级自动换新目录）。
// payload 由 scripts/build-bin.ts 构建期生成（build/payload.json，随二进制嵌入）。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import payload from "../build/payload.json";

const BUNFS_MARKERS = ["~BUN", "/$bunfs", "B:\\~BUN"];

export const COMPILED: boolean =
  BUNFS_MARKERS.some((m) => import.meta.dir.includes(m)) ||
  import.meta.dir.startsWith("bun:") ||
  import.meta.url.startsWith("bun:");

function payloadFiles(): Record<string, string> {
  const p = payload as unknown as { files?: Record<string, string> };
  return p.files ?? {};
}

function payloadHash(): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(JSON.stringify(payloadFiles()));
  return h.digest("hex").slice(0, 12);
}

function extractPayload(): string {
  const base = process.env.ORG_RUNTIME ?? path.join(os.homedir(), ".org");
  const dir = path.join(base, `runtime-${payloadHash()}`);
  const ok = path.join(dir, ".payload-ok");
  if (fs.existsSync(ok)) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const files = payloadFiles();
  for (const [rel, content] of Object.entries(files)) {
    const dst = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  fs.writeFileSync(ok, new Date().toISOString());
  return dir;
}

function resolveSourceRoot(): string {
  // lib/ 的上一层即仓库根（源码模式）
  return path.resolve(import.meta.dir, "..");
}

export const ROOT: string = COMPILED ? extractPayload() : resolveSourceRoot();

/** 默认工作区：源码模式沿用仓库内 demo-run；编译模式用 ~/.org/workspace（跨版本持久）。 */
export const DEFAULT_WORKSPACE: string = COMPILED
  ? path.join(process.env.ORG_RUNTIME ?? path.join(os.homedir(), ".org"), "workspace")
  : path.join(ROOT, "demo-run");

export const RUNTIME_LABEL: string = COMPILED
  ? `单二进制 · 运行时 ${path.basename(ROOT)}`
  : "源码模式";
