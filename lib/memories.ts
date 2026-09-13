// ============================================================================
// lib/memories.ts — 专家长期记忆（v0.5.3）
// ----------------------------------------------------------------------------
// 「长期记忆：记住用户偏好、项目约定、领域习惯」（能力清单 A-5）：
//   存储：<ws>/runtime/memories/<expert>.md（每行一条，追加式）
//   注入：direct 车道系统提示自动织入尾部 40 行（hsl/pool/direct.hsl
//         memory_block —— HSL 侧直读，无协议分叉）
//   管理：CLI org memory add/list/rm + Web 记忆面板（同一实现）
// 优雅降级：文件缺失 = 空记忆（零成本）；损坏按空处理不炸。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

const SAFE_EXPERT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function memoryFile(ws: string, expert: string): string | null {
  if (!SAFE_EXPERT.test(expert)) return null;
  return path.join(ws, "runtime", "memories", `${expert}.md`);
}

export interface MemoryEntry {
  line: number;
  text: string;
}

/** 读某专家的记忆（坏文件 → 空列表）。 */
export function listMemories(ws: string, expert: string): MemoryEntry[] {
  const file = memoryFile(ws, expert);
  if (!file || !fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf-8")
      .split("\n")
      .map((text, i) => ({ line: i + 1, text }))
      .filter((e) => e.text.trim().length > 0);
  } catch {
    return [];
  }
}

/** 追加一条记忆（时间戳前缀；原子写）。返回该专家的记忆条数。 */
export function addMemory(ws: string, expert: string, text: string): number {
  const file = memoryFile(ws, expert);
  if (!file) throw new Error(`专家名不合法：${expert}`);
  const t = text.trim();
  if (t.length === 0) throw new Error("记忆内容必填");
  if (t.length > 500) throw new Error("单条记忆 ≤500 字符（拆分多条）");
  const list = listMemories(ws, expert);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${stamp} ${t}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = list.length === 0 ? `${line}\n` : fs.readFileSync(file, "utf-8") + `${line}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, file);
  return list.length + 1;
}

/** 按行号删除一条记忆（1 基）。返回删除后的条数。 */
export function removeMemory(ws: string, expert: string, line: number): number {
  const file = memoryFile(ws, expert);
  if (!file || !fs.existsSync(file)) throw new Error("该专家暂无记忆");
  const list = listMemories(ws, expert);
  const hit = list.find((e) => e.line === line);
  if (!hit) throw new Error(`第 ${line} 行不存在（现有 ${list.length} 条，1-${list.length || 0}）`);
  const kept = fs.readFileSync(file, "utf-8").split("\n").filter((_, i) => i + 1 !== line);
  fs.writeFileSync(file, kept.join("\n"), "utf-8");
  return list.length - 1;
}

/** 全部专家的记忆清单（Web 面板用）。 */
export function allMemories(ws: string): Array<{ expert: string; entries: MemoryEntry[] }> {
  const dir = path.join(ws, "runtime", "memories");
  const out: Array<{ expert: string; entries: MemoryEntry[] }> = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const expert = e.name.slice(0, -3);
      if (!SAFE_EXPERT.test(expert)) continue;
      const entries = listMemories(ws, expert);
      if (entries.length > 0) out.push({ expert, entries });
    }
  } catch { /* 目录不存在 → 空 */ }
  return out;
}
