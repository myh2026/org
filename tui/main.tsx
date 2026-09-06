#!/usr/bin/env bun
// ============================================================================
// org/tui/main.tsx — TUI 独立执行入口（逻辑在 entry.ts，供 org tui 进程内复用）
// ============================================================================

import { tuiMain } from "./entry.ts";

if (import.meta.main) {
  process.exit(await tuiMain(process.argv.slice(2)));
}
