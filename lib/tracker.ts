// ============================================================================
// lib/tracker.ts — Issue/PR 工单系统集成（#86 Issue/工单集成 + #82 PR/MR 创建）
// ----------------------------------------------------------------------------
// 单一实现三端消费：CLI `org issue` / `org pr` · 工具环 `issue_*` / `pr_*` ·
// Web /api/govex/tracker。
//
// GitHub REST API v3 真集成（token 模式；gh CLI 不依赖 —— 沙箱/CI 常缺席）：
//   - 鉴权解析（优先级）：ORG_GH_TOKEN env > config.gh_token（org config set
//     gh_token …）> GH_TOKEN / GITHUB_TOKEN env > 未配置（诚实拒绝 + 指引）
//   - API base（优先级）：ORG_GH_API env > config.gh_api > https://api.github.com
//     （GitHub Enterprise 兼容：指向 <host>/api/v3 即可）
//   - 多重优雅降级：无 token → 明确指引不假装成功；HTTP 4xx/5xx → 可诊断错误
//     （status + 服务端 message）；网络/超时 → AbortController 15s 保护；
//     仓库形如 "owner/repo" 严格校验（防 path 注入）。
//
// 设计哲学与 lib/cloud.ts 同源：探测/模板可降级，真实车道拒绝先于执行；
// 所有写动作（create/comment/close/pr create）在工具环走 file_write 门 +
// 审批在环（org 工具环侧接线），本模块只做平凡调用与错误传播。
// ============================================================================

import { loadConfig, configPath } from "./config";

export interface TrackerTarget {
  repo: string; // "owner/repo"
  api: string; // https://api.github.com（或 GHE <host>/api/v3）
  token: string;
}

export interface GhResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

/** 解析鉴权与端点（env 优先，config 次之；repo 形状校验）。 */
export function resolveTrackerTarget(repo: string): { target?: TrackerTarget; error?: string } {
  const r = String(repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
    return { error: `repo 形状非法："${r}"（期望 owner/repo，如 myh2026/org）` };
  }
  let cfgToken = "";
  let cfgApi = "";
  try {
    const cfg = loadConfig();
    cfgToken = cfg.gh_token;
    cfgApi = cfg.gh_api;
  } catch {
    // 配置读失败不炸 token 解析（env 车道仍可用）
  }
  const token =
    (process.env.ORG_GH_TOKEN || "").trim() ||
    cfgToken.trim() ||
    (process.env.GH_TOKEN || "").trim() ||
    (process.env.GITHUB_TOKEN || "").trim();
  if (!token) {
    return {
      error: "GitHub token 未配置 —— 三选一：ORG_GH_TOKEN 环境变量 · org config set gh_token <token> · GH_TOKEN/GITHUB_TOKEN 环境变量（fine-grained PAT 需 repo issues/pull requests 读写权限）",
    };
  }
  const api =
    (process.env.ORG_GH_API || "").trim() ||
    cfgApi.trim() ||
    "https://api.github.com";
  return { target: { repo: r, api: api.replace(/\/+$/, ""), token } };
}

/** token 脱敏（审计/日志安全口径）。 */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** 平凡 REST 调用：UA + Accept v3 + Bearer + 15s 超时 + 错误可诊断化。 */
export async function ghApi(
  t: TrackerTarget,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<GhResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${t.api}${apiPath}`, {
      method,
      headers: {
        "User-Agent": "org-harness-tracker",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${t.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应（如纯文本代理错误页）：保留原文摘要
    }
    if (!res.ok) {
      const msg =
        (data as { message?: string } | null)?.message ?? text.slice(0, 200) ?? "";
      return { ok: false, status: res.status, data, error: `GitHub API ${res.status}: ${msg}` };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    return {
      ok: false,
      status: 0,
      data: null,
      error: m.includes("abort") ? `网络超时（15s）：${t.api} 不可达或过慢` : `网络错误：${m}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  user: string;
  comments: number;
  created_at: string;
  url: string;
  labels: string[];
}

function toIssueSummary(raw: Record<string, unknown>): IssueSummary {
  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ""),
    state: String(raw.state ?? ""),
    user: String((raw.user as { login?: string } | undefined)?.login ?? ""),
    comments: Number(raw.comments ?? 0),
    created_at: String(raw.created_at ?? ""),
    url: String(raw.html_url ?? ""),
    labels: Array.isArray(raw.labels)
      ? (raw.labels as ({ name?: string } | string)[]).map((l) =>
          typeof l === "string" ? l : String(l?.name ?? ""),
        )
      : [],
  };
}

/** 列 issue（state=open/closed/all，limit ≤ 100，缺省 20）。 */
export async function issueList(
  t: TrackerTarget,
  opts: { state?: string; limit?: number } = {},
): Promise<GhResult<IssueSummary[]>> {
  const state = ["open", "closed", "all"].includes(String(opts.state)) ? String(opts.state) : "open";
  const limit = Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 100);
  const r = await ghApi(t, "GET", `/repos/${t.repo}/issues?state=${state}&per_page=${limit}`);
  if (!r.ok) return r as GhResult<IssueSummary[]>;
  const arr = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
  return { ok: true, status: r.status, data: arr.map(toIssueSummary) };
}

/** 单个 issue 详情（含正文）。 */
export async function issueGet(t: TrackerTarget, num: number): Promise<GhResult> {
  if (!Number.isInteger(num) || num <= 0) return { ok: false, status: 0, data: null, error: `issue 号非法：${num}` };
  return ghApi(t, "GET", `/repos/${t.repo}/issues/${num}`);
}

/** 创建 issue（写动作）。 */
export async function issueCreate(
  t: TrackerTarget,
  issue: { title: string; body?: string; labels?: string[] },
): Promise<GhResult<IssueSummary>> {
  const title = String(issue.title || "").trim();
  if (!title) return { ok: false, status: 0, data: null, error: "title 必填（非空）" };
  if (title.length > 256) return { ok: false, status: 0, data: null, error: "title 过长（>256 字符）" };
  const r = await ghApi(t, "POST", `/repos/${t.repo}/issues`, {
    title,
    ...(issue.body ? { body: String(issue.body) } : {}),
    ...(Array.isArray(issue.labels) && issue.labels.length > 0 ? { labels: issue.labels } : {}),
  });
  if (!r.ok) return r as GhResult<IssueSummary>;
  return { ok: true, status: r.status, data: toIssueSummary(r.data as Record<string, unknown>) };
}

/** issue 评论（写动作）。 */
export async function issueComment(t: TrackerTarget, num: number, body: string): Promise<GhResult> {
  const b = String(body || "").trim();
  if (!b) return { ok: false, status: 0, data: null, error: "评论正文必填（非空）" };
  return ghApi(t, "POST", `/repos/${t.repo}/issues/${num}/comments`, { body: b });
}

/** 关闭/重开 issue（写动作；state=close/reopen）。 */
export async function issueSetState(
  t: TrackerTarget,
  num: number,
  state: "closed" | "open",
): Promise<GhResult<IssueSummary>> {
  const r = await ghApi(t, "PATCH", `/repos/${t.repo}/issues/${num}`, { state });
  if (!r.ok) return r as GhResult<IssueSummary>;
  return { ok: true, status: r.status, data: toIssueSummary(r.data as Record<string, unknown>) };
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  user: string;
  head: string;
  base: string;
  url: string;
  created_at: string;
}

function toPrSummary(raw: Record<string, unknown>): PrSummary {
  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ""),
    state: String(raw.state ?? ""),
    draft: Boolean(raw.draft),
    user: String((raw.user as { login?: string } | undefined)?.login ?? ""),
    head: String((raw.head as { ref?: string } | undefined)?.ref ?? ""),
    base: String((raw.base as { ref?: string } | undefined)?.ref ?? ""),
    url: String(raw.html_url ?? ""),
    created_at: String(raw.created_at ?? ""),
  };
}

/** 列 PR（state=open/closed/all）。 */
export async function prList(
  t: TrackerTarget,
  opts: { state?: string; limit?: number } = {},
): Promise<GhResult<PrSummary[]>> {
  const state = ["open", "closed", "all"].includes(String(opts.state)) ? String(opts.state) : "open";
  const limit = Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 100);
  const r = await ghApi(t, "GET", `/repos/${t.repo}/pulls?state=${state}&per_page=${limit}`);
  if (!r.ok) return r as GhResult<PrSummary[]>;
  const arr = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
  return { ok: true, status: r.status, data: arr.map(toPrSummary) };
}

/** PR 详情 + diff（Accept: application/vnd.github.v3.diff 车道）。 */
export async function prView(t: TrackerTarget, num: number): Promise<GhResult> {
  if (!Number.isInteger(num) || num <= 0) return { ok: false, status: 0, data: null, error: `PR 号非法：${num}` };
  const meta = await ghApi(t, "GET", `/repos/${t.repo}/pulls/${num}`);
  if (!meta.ok) return meta;
  // diff 车道（文本响应，失败降级为仅 meta —— diff 不是必需品）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let diff = "";
  try {
    const res = await fetch(`${t.api}/repos/${t.repo}/pulls/${num}`, {
      headers: {
        "User-Agent": "org-harness-tracker",
        Accept: "application/vnd.github.v3.diff",
        Authorization: `Bearer ${t.token}`,
      },
      signal: controller.signal,
    });
    if (res.ok) diff = (await res.text()).slice(0, 8192); // 截断保护（超长 diff 不进上下文）
  } catch {
    // diff 降级：meta 仍返回
  } finally {
    clearTimeout(timer);
  }
  const d = meta.data as Record<string, unknown>;
  return {
    ok: true,
    status: meta.status,
    data: { ...toPrSummary(d), body: String(d.body ?? ""), additions: d.additions, deletions: d.deletions, changed_files: d.changed_files, ...(diff ? { diff } : { diff_note: "diff 获取失败（降级为仅元数据）" }) },
  };
}

/** 创建 PR（写动作；head/base 形如 branch 或 owner:branch）。 */
export async function prCreate(
  t: TrackerTarget,
  pr: { title: string; head: string; base: string; body?: string },
): Promise<GhResult<PrSummary>> {
  const title = String(pr.title || "").trim();
  const head = String(pr.head || "").trim();
  const base = String(pr.base || "").trim();
  if (!title || !head || !base) {
    return { ok: false, status: 0, data: null, error: "title/head/base 三项必填（head=源分支，base=目标分支）" };
  }
  const r = await ghApi(t, "POST", `/repos/${t.repo}/pulls`, {
    title,
    head,
    base,
    ...(pr.body ? { body: String(pr.body) } : {}),
  });
  if (!r.ok) return r as GhResult<PrSummary>;
  return { ok: true, status: r.status, data: toPrSummary(r.data as Record<string, unknown>) };
}

/** 配置指引（CLI 集成帮助）。 */
export function trackerGuidance(): string {
  return `Issue/PR 工单系统（GitHub 真集成）：\n  鉴权：ORG_GH_TOKEN 或 org config set gh_token <token>（或 GH_TOKEN/GITHUB_TOKEN）\n  端点：ORG_GH_API（GitHub Enterprise 指向 <host>/api/v3，缺省 api.github.com）\n  配置文件：${configPath()}`;
}
