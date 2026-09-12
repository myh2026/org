// ============================================================================
// org/lib/sessions.ts — 会话账本读写的唯一实现（v0.5.0）
// ----------------------------------------------------------------------------
// 此前账本解析有三份实现：cli/chat.ts · web/entry.ts · lib/engine.ts。三者的
// 健壮性不一致（web 会做记录边界重组 + 修复式解析，engine/chat 只逐行 JSON.parse），
// 于是同一份账本在 Web 上显示 N 轮、在 chat 与 RunResult 里只剩 M 轮（M ≤ N）——
// 静默分歧，且**compacted 字段只有 chat 解析**，Web 把压缩摘要当普通轮次渲染。
//
// 本模块只收「解析与读写」这一层（漂移真正有害的地方）。
// 各前端的**展示**差异保留在各自文件里：Web 的会话预览取首问、chat 取最近问题，
// 这是各自的产品选择，不是该统一的东西。
//
// 账本形态：runtime/sessions/<expert>/<session>.jsonl，逐行一个 JSON 对象：
//   {turn, question, answer, tokens, ctx_tokens}
//   {turn:1, question:"(compact digest of N turns)", answer:摘要,
//    compacted:true, compacted_from:N}        ← /compact 重写后的单条形态
// 上游（hsl/pool/direct.hsl）历史版本用 format! 裸插值写账本，多行 answer 会带
// 字面换行落盘、破坏逐行 JSON —— 存量坏账本仍在盘上，故解析必须两层兜底。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

/** expert / session 名白名单（同时是防路径穿越的守卫）。 */
export const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface LedgerTurn {
  turn: number;
  question: string;
  answer: string;
  tokens: number;
  ctx_tokens: number;
  /** /compact 重写出的摘要条目（渲染层应显式标注，而不是当普通轮次）。 */
  compacted: boolean;
  compacted_from: number;
}

/** 账本文件路径（名不合法返回 null —— 调用方据此拒绝而非拼出穿越路径）。 */
export function sessionFilePath(ws: string, expert: string, session: string): string | null {
  if (!SAFE_SESSION_NAME.test(expert) || !SAFE_SESSION_NAME.test(session)) return null;
  return path.join(ws, "runtime", "sessions", expert, `${session}.jsonl`);
}

/**
 * 健壮解析账本原文。两层兜底：
 *   1. 按 `\n{"turn":` 记录边界重组 segment（坏账本里 answer 含裸换行）；
 *   2. 逐条先试标准 JSON.parse，失败再用 format! 固定字段布局的修复式解析；
 *   3. 不可解析的 segment 静默跳过（坏行容忍 —— 一条坏记录不该让整个会话不可读）。
 */
export function parseLedgerRaw(raw: string): LedgerTurn[] {
  const turns: LedgerTurn[] = [];
  const segments = raw.split(/\n(?=\{"turn":)/);
  for (const seg of segments) {
    const t = seg.trim();
    if (t.length === 0) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      turns.push({
        turn: Number(o.turn ?? 0),
        question: String(o.question ?? ""),
        answer: String(o.answer ?? ""),
        tokens: Number(o.tokens ?? 0),
        ctx_tokens: Number(o.ctx_tokens ?? 0),
        compacted: o.compacted === true,
        compacted_from: Number(o.compacted_from ?? 0),
      });
      continue;
    } catch { /* fallthrough：修复式解析 */ }
    const m = t.match(
      /^\{"turn":(\d+),"question":"([\s\S]*?)","answer":"([\s\S]*)","tokens":(\d+),"ctx_tokens":(\d+)\}$/,
    );
    if (m) {
      turns.push({
        turn: Number(m[1]),
        question: m[2]!,
        answer: m[3]!,
        tokens: Number(m[4]),
        ctx_tokens: Number(m[5]),
        compacted: false,
        compacted_from: 0,
      });
    }
  }
  return turns;
}

/** 读一个会话的全部轮次（文件缺失 = 新会话 → 空数组）。 */
export function readSession(ws: string, expert: string, session: string): LedgerTurn[] {
  const file = sessionFilePath(ws, expert, session);
  if (!file) return [];
  try {
    return parseLedgerRaw(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/** 写一个会话（整文件重写 —— 仅 /compact 与 fork 这类显式操作使用）。 */
export function writeSession(ws: string, expert: string, session: string, turns: LedgerTurn[]): string {
  const file = sessionFilePath(ws, expert, session);
  if (!file) throw new Error(`会话名不合法：${expert}/${session}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length ? "\n" : ""), "utf-8");
  return file;
}

/** 列出某专家有内容的会话 id（mtime 降序）。展示形状由各前端自定。 */
export function listSessionIds(ws: string, expert: string): Array<{ id: string; turns: LedgerTurn[]; mtimeMs: number }> {
  if (!SAFE_SESSION_NAME.test(expert)) return [];
  const dir = path.join(ws, "runtime", "sessions", expert);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: Array<{ id: string; turns: LedgerTurn[]; mtimeMs: number }> = [];
  for (const f of files) {
    const id = f.slice(0, -".jsonl".length);
    const turns = readSession(ws, expert, id);
    if (turns.length === 0) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* 容忍 */ }
    out.push({ id, turns, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 最近会话（--continue / 专家切换缺省；无会话返回 "default"）。 */
export function latestSession(ws: string, expert: string): string {
  const list = listSessionIds(ws, expert);
  return list.length > 0 ? list[0]!.id : "default";
}

/**
 * 上下文压缩（/compact）：把 N 轮会话史压缩为单轮摘要条目。
 * 账本重写为单条 {turn:1, compacted:true, compacted_from:N}；
 * 原文件备份 `<session>.jsonl.bak-<ts>`（可手工回滚）。
 * tokens/ctx 按正文长度 /3 重估（与 hsl/pool/direct.hsl 的 estimate 同口径）。
 */
export function compactLedger(
  ws: string, expert: string, session: string, summary: string, fromTurns: number,
): { backup: string } {
  const file = sessionFilePath(ws, expert, session);
  if (!file) throw new Error(`会话名不合法：${expert}/${session}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.bak-${stamp}`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  const entry: LedgerTurn = {
    turn: 1,
    question: `(compact digest of ${fromTurns} turns)`,
    answer: summary,
    tokens: Math.max(1, Math.round(summary.length / 3)),
    ctx_tokens: Math.max(1, Math.round((summary.length + 64) / 3)),
    compacted: true,
    compacted_from: fromTurns,
  };
  writeSession(ws, expert, session, [entry]);
  return { backup };
}
