// ============================================================================
// lib/owners.ts — CODEOWNERS 加载/匹配 + 评审人推荐（v0.5.15 · capabilities
// #89 CODEOWNERS / #85 评审人推荐）
// ----------------------------------------------------------------------------
// 「改动该找谁审」的两层实现：
//   1. CODEOWNERS（GitHub 兼容子集）：声明式责任规则 —— 模式 → 责任人；
//      匹配语义与 GitHub 一致：越靠后的规则优先级越高（最后命中者胜，
//      不按模式长度仲裁）；`*` 规则即全仓默认责任人
//   2. 评审人推荐：变更文件集 → matchOwners 聚合（谁覆盖的文件多谁排
//      前，reason 溯源到规则模式）；无 CODEOWNERS 时降级为**目录启发式**，
//      产出 "<目录>-owner" 占位评审人 —— 诚实标注这是启发式不是真实
//      维护人（fromCodeowners:false + fallbackReason 指引建规则）
//
// 查找顺序（先到先得）：<ws>/.org/CODEOWNERS → <ws>/CODEOWNERS →
// <ws>/.github/CODEOWNERS；均无 → rules:[] + defaults:[] + file:null。
//
// 语法（GitHub CODEOWNERS 兼容子集）：
//   · 每行 = <glob 路径模式> @owner1 @owner2 …（owner 也可无 @ 前缀或为
//     邮箱形式，空格分隔；@ 前缀规范化剥除）
//   · `#` 起始的整行注释；空行跳过；无 owner 的行无效（跳过，不炸）
//   · 模式：`**` 跨零或多层目录 · `*`/`?` 仅目录内 · 尾部 `/` 目录前缀 ·
//     无 `/` 的裸模式按文件名/目录名任意深度匹配 · 首部 `/` 仅表根锚定
//     （剥除）。不支持字符类 [abc]、`!` 反选与转义序列（文档化子集）
//
// 优雅降级：文件缺失/不可读 → 空规则（推荐器自动切启发式）；损坏行
// 跳过不连坐；从未有静默空结果 —— 无规则时明确告诉调用方「为什么」。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

/** CODEOWNERS 候选位置（优先级从高到低）。 */
export const CO_LOCATIONS = [".org/CODEOWNERS", "CODEOWNERS", ".github/CODEOWNERS"] as const;

/** 一条责任规则（pattern 原样保留；owners 已剥 @ 前缀并去重）。 */
export interface OwnerRule {
  pattern: string;
  owners: string[];
  /** 规则所在行号（1 基 —— UI 定位与审计溯源用）。 */
  line: number;
  /** 规则来源文件的绝对路径。 */
  source: string;
}

// ---- 解析 ---------------------------------------------------------------------

/** 解析 CODEOWNERS 文本（空行/注释/无 owner 行跳过；owners 剥 @ 并去重）。 */
function parseCodeowners(text: string, source: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const pattern = tokens[0]!;
    const owners = [...new Set(tokens.slice(1).map((t) => t.replace(/^@+/, "")).filter((t) => t.length > 0))];
    if (owners.length === 0) continue; // 无 owner 的行无效 —— 跳过不炸
    rules.push({ pattern, owners, line: i + 1, source });
  }
  return rules;
}

/**
 * 加载工作区 CODEOWNERS（查找顺序见文件头；均无 → rules:[] + file:null）。
 * defaults = 最后一条 `*` 规则的 owners（GitHub「全仓默认责任人」惯用法）。
 */
export function loadCodeowners(ws: string): { rules: OwnerRule[]; file: string | null; defaults: string[] } {
  for (const rel of CO_LOCATIONS) {
    const file = path.join(ws, rel);
    let text: string;
    try {
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, "utf-8"); // 存在但不可读 → 试下一位置
    } catch {
      continue;
    }
    const rules = parseCodeowners(text, file);
    let defaults: string[] = [];
    for (const r of rules) {
      if (r.pattern === "*" || r.pattern === "/*") defaults = r.owners; // 后规则覆盖前规则
    }
    return { rules, file, defaults };
  }
  return { rules: [], file: null, defaults: [] };
}

// ---- 匹配 ---------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

/**
 * 模式 → 正则（GitHub CODEOWNERS 兼容子集）：
 *   `lib/**`   → lib 下任意深度（`**` 在中段时跨零或多层完整目录段）
 *   `docs/*`   → docs 直接子项（`*` 与 `?` 均不跨目录分隔符）
 *   `apps/`    → 目录前缀（apps 自身及其全部内容）
 *   `Makefile` / `*.md` → 无 `/` 的裸模式按文件名任意深度匹配
 *   `/docs/x`  → 首部 `/` 仅表根锚定（剥除；路径本就相对工作区根）
 */
function globToRegExpCached(pattern: string): RegExp {
  const hit = globCache.get(pattern);
  if (hit) return hit;

  let p = pattern.replace(/^\/+/, "");
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const hasSlash = p.includes("/");
  const hasWildcard = /[*?]/.test(p);

  let re = "";
  for (let i = 0; i < p.length;) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` → 零或多层完整目录段（a/**/b 命中 a/b）；其余 ** 贪婪跨 /
        if (p[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 3; }
        else { re += ".*"; i += 2; }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }

  let regex: RegExp;
  if (dirOnly) regex = new RegExp(`^(?:${re})(?:/.*)?$`);
  else if (!hasSlash && !hasWildcard) regex = new RegExp(`(?:^|/)${re}(?:/.*)?$`); // 裸名：文件或目录（含内容）
  else if (!hasSlash) regex = new RegExp(`(?:^|/)${re}$`); // 裸通配：按文件名任意深度
  else regex = new RegExp(`^${re}$`); // 含 /：根锚定

  globCache.set(pattern, regex);
  return regex;
}

/** 路径规范化（反斜杠 → 正斜杠；剥 "./" 前缀）。 */
function normPath(f: string): string {
  return f.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 规则集对单文件的命中（GitHub 语义：后规则覆盖前规则，最后命中者胜）。 */
function matchRule(rules: OwnerRule[], norm: string): OwnerRule | null {
  let hit: OwnerRule | null = null;
  for (const r of rules) {
    if (globToRegExpCached(r.pattern).test(norm)) hit = r;
  }
  return hit;
}

interface FileMatch { file: string; owners: string[]; pattern: string | null }

/** 逐文件匹配（详细形态：附命中模式 —— 推荐器溯源用）。 */
function matchRules(rules: OwnerRule[], files: string[]): FileMatch[] {
  return files.map((f) => {
    const hit = matchRule(rules, normPath(f));
    return { file: f, owners: hit ? [...hit.owners] : [], pattern: hit ? hit.pattern : null };
  });
}

/** 逐文件责任匹配（后规则覆盖前规则；无匹配 → owners:[]，file 原样返回）。 */
export function matchOwners(ws: string, files: string[]): { file: string; owners: string[] }[] {
  const { rules } = loadCodeowners(ws);
  return matchRules(rules, files).map(({ file, owners }) => ({ file, owners }));
}

// ---- 评审人推荐 -------------------------------------------------------------------

/** 推荐的评审人（filesCovered = 该 owner 覆盖的变更文件数；reason 溯源）。 */
export interface Reviewer {
  name: string;
  filesCovered: number;
  reason: string;
}

/** 启发式占位评审人上限（目录过于碎片时保持推荐列表可读）。 */
const FALLBACK_MAX = 5;

/**
 * 变更文件集 → 推荐评审人。
 *   · 有 CODEOWNERS：matchOwners 聚合 —— owner 按覆盖文件数降序（同数按名
 *     字典序稳定排序）；reason 溯源 "CODEOWNERS: <命中模式列表>"
 *   · 无 CODEOWNERS：目录启发式降级 —— 按顶层目录聚合出 "<目录>-owner"
 *     **占位**评审人（如 lib/foo.ts → "lib-owner"）。这是启发式不是真实
 *     维护人：fromCodeowners:false + fallbackReason 附建规则指引，调用方
 *     必须向用户呈现该事实，绝不冒充真实责任人。
 */
export function recommendReviewers(
  ws: string,
  changedFiles: string[],
): { reviewers: Reviewer[]; fromCodeowners: boolean; fallbackReason?: string } {
  const co = loadCodeowners(ws);

  if (co.file === null) {
    // 无 CODEOWNERS —— 目录启发式（诚实：占位符 + 降级说明）
    const byDir = new Map<string, number>();
    for (const f of changedFiles) {
      const segs = normPath(f).split("/");
      const dir = segs.length > 1 ? segs[0]! : "";
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }
    const reviewers = [...byDir.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FALLBACK_MAX)
      .map(([dir, n]) => ({
        name: dir === "" ? "repo-root-owner" : `${dir}-owner`,
        filesCovered: n,
        reason: dir === "" ? "目录启发式：仓库根级文件" : `目录启发式：${dir}/ 前缀`,
      }));
    return {
      reviewers,
      fromCodeowners: false,
      fallbackReason:
        `无 CODEOWNERS 文件（已按顺序探测 ${CO_LOCATIONS.join(" / ")}）—— 当前推荐为目录启发式占位人，非真实维护人；`
        + `在 <工作区>/${CO_LOCATIONS[0]} 建立规则后自动切换为真实责任人`,
    };
  }

  // CODEOWNERS 聚合：owner → 覆盖文件数 + 命中模式集（reason 溯源）
  const agg = new Map<string, { files: number; patterns: Set<string> }>();
  for (const m of matchRules(co.rules, changedFiles)) {
    if (m.pattern === null) continue; // 未命中任何规则的文件不归属任何人（诚实留白）
    for (const o of m.owners) {
      const a = agg.get(o) ?? { files: 0, patterns: new Set<string>() };
      a.files += 1;
      a.patterns.add(m.pattern);
      agg.set(o, a);
    }
  }
  const reviewers = [...agg.entries()]
    .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
    .map(([name, a]) => ({ name, filesCovered: a.files, reason: `CODEOWNERS: ${[...a.patterns].join(", ")}` }));
  return { reviewers, fromCodeowners: true };
}
