// ============================================================================
// lib/mentions.ts — @文件/目录引用 + @?语义检索注入（v0.5.3 · v0.5.8）
// ----------------------------------------------------------------------------
// codex / claude-code 的 @path 提及同形：用户问题里的 `@相对路径` 在进入
// 模型前展开为带围栏的文件内容（精确指定上下文，减少幻觉）。
//
// v0.5.8 RAG 注入：`@?查询词` —— 语义检索（lib/search.ts BM25）top-k
// 命中展开为围栏摘要块（检索增强生成的检索半环；用户不必知道文件名，
// 「@? 审计制度」即可把相关文档带进上下文）。
//
// 展开规则：
//   - 识别 `@路径`（路径不含空白；支持目录 —— 展开为树 + 各文件摘要）
//   - 识别 `@?查询词`（到下一个空白；BM25 top-5 → 路径 + 命中摘要围栏）
//   - 文件 ≤64KB 全文；超出截断并标注
//   - 目录：列出至多 20 个文件，每个附前 8 行预览
//   - 总预算 ≤96KB（超出部分跳过并在附注中说明）
//   - 读取失败（不存在/二进制/越界）→ 附注说明，绝不炸主流程
//
// 优雅降级：无 @ 提及零成本直通；检索无命中 → 附注说明；全部失败 →
// 原样返回 + 提示。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { semanticSearch } from "./search.ts";

export interface MentionResult {
  /** 展开后的完整问题（原问题 + 附注）。 */
  text: string;
  /** 成功展开的路径。 */
  expanded: string[];
  /** 跳过/失败的路径与原因。 */
  skipped: Array<{ path: string; reason: string }>;
}

const FILE_CAP = 64 * 1024;
const TOTAL_CAP = 96 * 1024;
const BINARY_SNIFF = 4096;

/** 展开问题中的 @路径 提及（workspace 相对路径）。 */
export function expandMentions(question: string, workspace: string): MentionResult {
  const res: MentionResult = { text: question, expanded: [], skipped: [] };
  // @path：非空白起始、允许 [A-Za-z0-9_\-./\u4e00-\u9fa5]（中文路径可用）
  const re = /@([A-Za-z0-9_\-.\/\u4e00-\u9fa5][A-Za-z0-9_\-.\/\u4e00-\u9fa5]*)/g;
  const seen = new Set<string>();
  const parts: string[] = [];
  let total = 0;
  let m: RegExpExecArray | null;
  let body = question;
  const attachments: string[] = [];

  // ---- v0.5.8 @?语义检索注入（先于 @path：@?x 不匹配路径正则，两不相扰）----
  const ragRe = /@\?([^\s@]+)/g;
  const ragSeen = new Set<string>();
  let rm: RegExpExecArray | null;
  while ((rm = ragRe.exec(question)) !== null) {
    const q = rm[1]!;
    if (ragSeen.has(q)) continue;
    ragSeen.add(q);
    try {
      const sr = semanticSearch(workspace, q, 5);
      if (sr.hits.length === 0) {
        res.skipped.push({ path: `?${q}`, reason: `检索无命中（${sr.total_docs} 文档）` });
        continue;
      }
      const lines = sr.hits.map((h) =>
        `  ${h.path}（score ${h.score.toFixed(2)}）\n    ${h.snippet}`);
      const block = `🔎 @?${q}（语义检索 top ${sr.hits.length} / ${sr.total_docs} 文档 · ${sr.took_ms}ms）\n${lines.join("\n")}`;
      if (total + block.length > TOTAL_CAP) {
        res.skipped.push({ path: `?${q}`, reason: "总预算超出（96KB）" });
        continue;
      }
      attachments.push(block);
      total += block.length;
      res.expanded.push(`?${q}`);
    } catch (err) {
      // 检索引擎异常不炸主流程（RAG 是增强通道）
      res.skipped.push({ path: `?${q}`, reason: `检索失败（${(err as Error).message}）` });
    }
  }

  while ((m = re.exec(question)) !== null) {
    const rel = m[1]!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.resolve(workspace, rel);
    // 路径监狱：必须在 workspace 内（防 @../../ 逃逸）
    if (!abs.startsWith(path.resolve(workspace) + path.sep) && abs !== path.resolve(workspace)) {
      res.skipped.push({ path: rel, reason: "越出工作区（仅允许工作区内路径）" });
      continue;
    }
    if (!fs.existsSync(abs)) {
      res.skipped.push({ path: rel, reason: "不存在" });
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const { block, size, note } = expandDir(abs, rel);
      if (total + size > TOTAL_CAP) {
        res.skipped.push({ path: rel, reason: "总预算超出（96KB）" });
        continue;
      }
      attachments.push(block);
      total += size;
      res.expanded.push(rel);
      if (note) res.skipped.push({ path: rel, reason: note });
      continue;
    }
    if (stat.size > 4 * FILE_CAP) {
      res.skipped.push({ path: rel, reason: "文件过大（>256KB）" });
      continue;
    }
    let content: string;
    try {
      const buf = fs.readFileSync(abs);
      // 二进制嗅探（NUL 字节 → 拒绝）
      if (buf.subarray(0, Math.min(BINARY_SNIFF, buf.length)).includes(0)) {
        res.skipped.push({ path: rel, reason: "二进制文件" });
        continue;
      }
      content = buf.toString("utf-8");
    } catch {
      res.skipped.push({ path: rel, reason: "读取失败" });
      continue;
    }
    const truncated = content.length > FILE_CAP;
    if (truncated) content = content.slice(0, FILE_CAP) + "\n…(truncated)";
    if (total + content.length > TOTAL_CAP) {
      res.skipped.push({ path: rel, reason: "总预算超出（96KB）" });
      continue;
    }
    attachments.push(`📁 ${rel}\n\`\`\`\n${content}\n\`\`\``);
    total += content.length;
    res.expanded.push(rel);
  }
  if (attachments.length === 0 && res.skipped.length === 0) return res;
  body = question.replace(re, (whole) => whole); // 原文保留 @token（模型可对齐）
  parts.push(body);
  if (attachments.length > 0) {
    parts.push("\n\n---\n[referenced files] " + res.expanded.join(", "));
    parts.push(attachments.join("\n\n"));
  }
  if (res.skipped.length > 0) {
    parts.push(`\n\n[mentions skipped] ${res.skipped.map((s) => `@${s.path}（${s.reason}）`).join("; ")}`);
  }
  res.text = parts.join("");
  return res;
}

function expandDir(abs: string, rel: string): { block: string; size: number; note: string } {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (files.length >= 20 || depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        files.push(p);
        if (files.length >= 20) return;
      }
    }
  };
  walk(abs, 0);
  const chunks: string[] = [`📂 ${rel}/（目录展开 · ${files.length} 个文件${files.length >= 20 ? "（上限 20）" : ""}）`];
  let size = 0;
  for (const f of files) {
    let preview = "";
    try {
      const content = fs.readFileSync(f, "utf-8");
      preview = content.split("\n").slice(0, 8).join("\n");
    } catch { /* 无预览 */ }
    const line = `  ${path.relative(abs, f)}\n    ${preview.split("\n").map((l) => l.slice(0, 100)).join("\n    ")}`;
    size += line.length;
    chunks.push(line);
  }
  return { block: chunks.join("\n"), size, note: files.length >= 20 ? "目录文件超 20 个截断" : "" };
}
