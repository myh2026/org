#!/usr/bin/env bun
// ============================================================================
// org/tui/main.tsx — TUI 独立执行入口（逻辑在 entry.ts，供 org tui 进程内复用）
// ============================================================================

// 环境兼容层挂载（受限内核 rmSync 降级链；详见 lib/fssafe.ts）
import "../lib/fssafe-preload.ts";
import { tuiMain } from "./entry.ts";

if (import.meta.main) {
  process.exit(await tuiMain(process.argv.slice(2)));
}
