#!/usr/bin/env bun
// ============================================================================
// scripts/sync-vendored-dhv.ts —— vendored dhv-ts 双仓机械同步（v0.5.24 新增）
// ----------------------------------------------------------------------------
// 背景（漂移实录）：上游 HSL 仓修复 #23（N-6 + native 桥 + 垫片）后，org 侧
// 只拷贝了部分文件 —— checker.ts 后续修正（IIFE 四段模式）未随拷，导致 org
// check 闸门 72 处 N-6 误报全红。人工逐文件拷贝必然漏（.ts 源 + package.json
// + README 版本横幅 + 未来新增文件），此脚本按「整目录镜像 + 白名单排除」
// 机械同步，跑完自动 diff 汇总 + 版本口径校验。
//
// 用法：
//   bun scripts/sync-vendored-dhv.ts --src /path/to/harness-specification-language
//   （缺省上游路径：../harness-specification-language，找不到时诚实退出 2）
// ============================================================================
// 环境兼容层挂载（受限内核 rmSync 降级链；详见 lib/fssafe.ts）
import "../lib/fssafe-preload.ts";
import * as fs from "../lib/fssafe-fs.ts"; // fs 垫片（删除入口带降级链；详见 lib/fssafe.ts）
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
let srcFlag = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--src' && args[i + 1]) srcFlag = args[i + 1]!;
}
const SRC = path.resolve(srcFlag || path.join(ROOT, '..', 'harness-specification-language'));
const SRC_TC = path.join(SRC, 'toolchain', 'dhv-ts');
const DST_TC = path.join(ROOT, 'toolchain', 'dhv-ts');

if (!fs.existsSync(path.join(SRC_TC, 'package.json'))) {
  console.error(`✗ 上游 dhv-ts 不存在：${SRC_TC}`);
  console.error('  用法：bun scripts/sync-vendored-dhv.ts --src /path/to/harness-specification-language');
  process.exit(2);
}

// 排除：上游的本地运行产物与构建缓存（org 侧不需要 vendored）
const EXCLUDE = new Set(['node_modules', '.hsl-runs', 'dist-bin', 'target']);

function walkCopy(dirRel: string): { copied: number; removed: number } {
  const srcDir = path.join(SRC_TC, dirRel);
  const dstDir = path.join(DST_TC, dirRel);
  let copied = 0;
  let removed = 0;
  fs.mkdirSync(dstDir, { recursive: true });
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));
  // 目标侧多余文件删除（镜像语义；排除目录不删）
  if (fs.existsSync(dstDir)) {
    for (const de of fs.readdirSync(dstDir, { withFileTypes: true })) {
      if (EXCLUDE.has(de.name)) continue;
      if (!srcNames.has(de.name)) {
        fs.rmSync(path.join(dstDir, de.name), { recursive: true, force: true });
        removed++;
        console.log(`  − ${path.join(dirRel, de.name)}`);
      }
    }
  }
  for (const se of srcEntries) {
    if (EXCLUDE.has(se.name)) continue;
    const rel = path.join(dirRel, se.name);
    if (se.isDirectory()) {
      const r = walkCopy(rel);
      copied += r.copied;
      removed += r.removed;
    } else {
      const srcContent = fs.readFileSync(path.join(srcDir, se.name));
      const dstPath = path.join(dstDir, se.name);
      const same = fs.existsSync(dstPath) && fs.readFileSync(dstPath).equals(srcContent);
      if (!same) {
        fs.copyFileSync(path.join(srcDir, se.name), dstPath);
        copied++;
        console.log(`  ${fs.existsSync(dstPath) ? '±' : '+'} ${rel}`);
      }
    }
  }
  return { copied, removed };
}

console.log(`sync-vendored-dhv：${SRC_TC} → ${DST_TC}`);
const { copied, removed } = walkCopy('');
console.log(`  同步 ${copied} 个文件 · 删除 ${removed} 个多余项`);

// 版本口径校验（双端一致）
const srcVer = (JSON.parse(fs.readFileSync(path.join(SRC_TC, 'package.json'), 'utf-8')) as { version: string }).version;
const dstVer = (JSON.parse(fs.readFileSync(path.join(DST_TC, 'package.json'), 'utf-8')) as { version: string }).version;
if (srcVer !== dstVer) {
  console.error(`✗ 版本口径不一致：上游 ${srcVer} vs vendored ${dstVer}`);
  process.exit(1);
}
console.log(`✓ vendored dhv-ts = ${dstVer}（与上游一致）`);
// 提醒：payload（build-bin 内嵌源）若已铸出，需再跑 bun scripts/build-bin.ts 再生
console.log('ℹ 若此前已铸单二进制 payload，请再跑 bun scripts/build-bin.ts 再生（dist/ 新鲜度守卫）');
