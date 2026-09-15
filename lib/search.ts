// ============================================================================
// lib/search.ts — 语义检索引擎（v0.5.8 · capabilities #19/#22）
// ----------------------------------------------------------------------------
// 「语义代码搜索 + RAG 检索车道」的进程内实现：工作区语料的 BM25 词频
// 语义检索（Lucene 风格 IDF 防负 + 标准 k1/b 参数），中英混合分词
// （CJK bigram + 西文词元）。四个消费入口共用本实现：
//   · CLI      org search <query>
//   · Web GUI  GET /api/search（顶栏 🔍 面板）
//   · RAG 注入  问题中的 `@?查询词`（lib/mentions.ts）→ 检索结果展开为
//              围栏上下文进入模型（检索增强生成的检索半环）
//   · 工具环   hsl/pool/tools.hsl semantic_search（ABI 内同构实现，
//              tests/search.test.ts 行为对拍保证排序一致 —— 与 HSL
//              「一源多投射 + 行为级对拍」同一治理手法）
//
// 诚实边界：BM25 是词频语义（lexical relevance），不是 embedding 向量
// 语义；后者是路线图（接 z-ai SDK embedding 车道即可，通道已预留）。
//
// 优雅降级（多重）：语料目录缺失 → 空索引（不炸）；二进制/超大文件 →
// 跳过并计数；空查询 → 空结果；索引构建异常 → 逐文件隔离（单文件坏
// 不连坐）。语料上限：512 文件 · 单文件 256KB · 总量 4MB（超限跳过
// 并在结果 surfaced）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- 常量（语料与预算面）----------------------------------------------------

/** 参与索引的工作区子目录（语义：原料/资产/产物 —— 检索的价值面）。 */
export const CORPUS_DIRS = ["raw", "registry", "work", "factory"] as const;

/** 语料上限（超限跳过：防大工作区把 Web 请求拖死）。 */
const MAX_FILES = 512;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** BM25 参数（Lucene 默认族：k1=1.5（词频饱和）、b=0.75（长度归一））。 */
const K1 = 1.5;
const B = 0.75;

// ---- 分词 -------------------------------------------------------------------

/** 中英混合分词：CJK 连续段 → bigram（单字保留）；西文 → 小写词元。
 *  「审计公告」→ [审计, 计公, 公告]；「ISO 8601」→ [iso, 8601]。
 *  bigram 让「日期格式」命中「日期」「格式」双词，是 CJK 无空格分词的
 *  经典精度/召回折衷（jieba 级词典属重依赖，不进零依赖内核）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 西文词元（含数字/下划线）
  for (const m of lower.match(/[a-z0-9_]+/g) ?? []) tokens.push(m);
  // CJK 段 bigram（\u4e00-\u9fa5 基本区 + 兼容扩展 A）
  for (const seg of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (seg.length === 1) {
      tokens.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    // 尾字单字也保留（「格式化」的「化」可被「化」查询命中）
    tokens.push(seg.slice(seg.length - 1));
  }
  return tokens;
}

// ---- 索引 -------------------------------------------------------------------

export interface IndexedDoc {
  /** workspace 相对路径（正斜杠，展示与 @引用通吃）。 */
  path: string;
  /** 文档长度（token 数）。 */
  len: number;
  /** 词频表。 */
  tf: Map<string, number>;
  /** 原文头部（16KB —— 短语加成检测用；标题/首段即文档主旨的常态）。 */
  head: string;
}

export interface BuildStats {
  files: number;
  skippedOversize: number;
  skippedBinary: number;
  skippedTotalCap: number;
  totalBytes: number;
  corpusDirs: string[];
}

export interface SearchIndex {
  /** workspace 锚（摘要回读 + 工具环对拍定位用）。 */
  ws: string;
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgdl: number;
  stats: BuildStats;
}

/** 二进制嗅探：前 4KB 含 NUL → 判二进制（与 mentions.ts 同规）。 */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(4096, buf.length)).includes(0);
}

/** 递归收集目录下文本文件（相对路径正斜杠；跳 .git/node_modules）。 */
function walkTextFiles(ws: string, relDir: string, out: string[], depth: number): void {
  if (out.length >= MAX_FILES || depth > 4) return;
  const abs = path.join(ws, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // 目录不存在/不可读 → 降级为空语料
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkTextFiles(ws, rel, out, depth + 1);
    } else if (e.isFile()) {
      out.push(rel);
      if (out.length >= MAX_FILES) return;
    }
  }
}

/** 构建工作区索引（CORPUS_DIRS 语料面；逐文件隔离降级）。 */
export function buildIndex(ws: string): SearchIndex {
  const stats: BuildStats = {
    files: 0, skippedOversize: 0, skippedBinary: 0, skippedTotalCap: 0,
    totalBytes: 0, corpusDirs: [],
  };
  const docs: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let totalTokens = 0;

  for (const dir of CORPUS_DIRS) {
    const files: string[] = [];
    walkTextFiles(ws, dir, files, 0);
    if (files.length > 0) stats.corpusDirs.push(`${dir}(${files.length})`);
    for (const rel of files) {
      let buf: Buffer;
      try {
        buf = fs.readFileSync(path.join(ws, rel));
      } catch {
        continue; // 单文件读失败不连坐
      }
      if (buf.length > MAX_FILE_BYTES) { stats.skippedOversize++; continue; }
      if (isBinary(buf)) { stats.skippedBinary++; continue; }
      if (stats.totalBytes + buf.length > MAX_TOTAL_BYTES) { stats.skippedTotalCap++; continue; }
      stats.totalBytes += buf.length;
      stats.files++;
      const text = buf.toString("utf-8");
      const tokens = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      totalTokens += tokens.length;
      docs.push({ path: rel, len: tokens.length, tf, head: text.slice(0, 16384) });
    }
  }

  return {
    ws,
    docs,
    df,
    avgdl: docs.length > 0 ? totalTokens / docs.length : 0,
    stats,
  };
}

// ---- 打分 -------------------------------------------------------------------

export interface SearchHit {
  path: string;
  score: number;
  /** 命中词（客户端高亮用）。 */
  terms: string[];
  /** 首个命中周边摘要（±80 字符）。 */
  snippet: string;
}

export interface SearchResult {
  ok: true;
  query: string;
  k: number;
  took_ms: number;
  total_docs: number;
  hits: SearchHit[];
  stats: BuildStats;
}

/** Lucene 风格 IDF（+1 防负；df=0 词不参与）。 */
function idf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** BM25 打分 + 摘要提取。空查询/空索引 → 空 hits（不炸）。 */
export function searchIndex(index: SearchIndex, query: string, k = 5): SearchResult {
  const t0 = Date.now();
  const qTokens = [...new Set(tokenize(query))];
  const hits: SearchHit[] = [];

  if (qTokens.length > 0 && index.docs.length > 0) {
    const n = index.docs.length;
    // 查询的 CJK 连续段（短语加成：整段在原文头部命中 → 固定奖励 ——
    // BM25 长度归一会让短文档反超，但用户直觉里标题含完整词组（如
    // 「审计制度」）的文档更相关；短语命中是最强相关信号）
    const cjkSegs = (query.match(/[\u3400-\u9fff]+/g) ?? []).filter((s) => s.length >= 2);
    for (const doc of index.docs) {
      let score = 0;
      const matched: string[] = [];
      for (const t of qTokens) {
        const f = doc.tf.get(t);
        if (!f) continue;
        matched.push(t);
        const dfv = index.df.get(t) ?? 0;
        const norm = f * (K1 + 1) /
          (f + K1 * (1 - B + B * (doc.len / (index.avgdl || 1))));
        score += idf(dfv, n) * norm;
      }
      // 短语加成：每个原文头部命中的查询段 +3.0（与工具环同参对拍）
      for (const seg of cjkSegs) {
        if (doc.head.includes(seg)) {
          score += 3.0;
          if (!matched.includes(seg)) matched.push(seg);
        }
      }
      if (matched.length > 0 && score > 0) {
        hits.push({ path: doc.path, score, terms: matched, snippet: "" });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    hits.length = Math.min(hits.length, Math.max(1, k));
  }

  // 摘要：读回原文定位首个命中词（CJK bigram 在原文中连续，直接 indexOf）
  for (const h of hits) h.snippet = snippetOf(index.ws, h);

  return {
    ok: true,
    query,
    k,
    took_ms: Date.now() - t0,
    total_docs: index.docs.length,
    hits,
    stats: index.stats,
  };
}

/** 命中词周边摘要（±80 字符；读失败降级为空摘要不炸）。 */
function snippetOf(ws: string, hit: SearchHit): string {
  if (!ws) return "";
  try {
    const raw = fs.readFileSync(path.join(ws, hit.path), "utf-8");
    let at = -1;
    for (const t of hit.terms) {
      const i = raw.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) return raw.slice(0, 120).replace(/\s+/g, " ");
    const from = Math.max(0, at - 80);
    const to = Math.min(raw.length, at + 80);
    return (from > 0 ? "…" : "") + raw.slice(from, to).replace(/\s+/g, " ") + (to < raw.length ? "…" : "");
  } catch {
    return "";
  }
}

/** 一站式：构建 + 检索（CLI / Web / RAG 注入的公共入口）。 */
export function semanticSearch(ws: string, query: string, k = 5): SearchResult {
  const idx = buildIndex(ws);
  return searchIndex(idx, query, k);
}
