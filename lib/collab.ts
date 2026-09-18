// ============================================================================
// lib/collab.ts — 团队协作层（v0.5.17 · capabilities #87 团队共享会话/评论）
// ----------------------------------------------------------------------------
// 在**单用户会话账本**（lib/sessions.ts，runtime/sessions/<expert>/<s>.jsonl）
// 之上叠一层多用户协作，不破坏既有协议 —— 向后兼容铁律：
//   · lib/sessions.ts 一行不改、只读复用（readSession 是桥的唯一入口）；
//   · 协作文件全部落在 runtime/collab/（与会话账本 runtime/sessions/ 同级、
//     同风格），单用户既有工作流零感知；
//   · 桥（bridgeSession）只「镜像」不「改写」：单用户账本 → 团队线程是单向
//     只读复制，原账本字节不变（tests/collab.test.ts 前后 hash 对拍锁定）。
//
// 文件协议（与审计账本同哲学：append-only JSON lines，只追加不改写）：
//   runtime/collab/collab-user          身份文件（JSON：{user, display?, setAt}）
//   runtime/collab/threads/<id>.jsonl   团队线程，逐行一个帖子：
//     { seq, user, role?, text, at, kind: "post"|"comment"|"system",
//       replyTo?, mentions?, meta? }
//   · seq 单调递增（读现有最大 seq + 1）—— 读侧坏行容忍（半写行跳过，
//     与 events.jsonl 读侧同一纪律：一条坏行不该让整个线程不可读）；
//   · kind 语义：post = 用户发帖 · comment = 对某帖的评论（replyTo 特化）·
//     system = 桥镜像/系统公告（meta 携带 {expert, session, turn} 回溯键）；
//   · mentions 自动从 text 抽 @name（用户 id 形：小写字母数字连字符；
//     与 lib/mentions.ts 的 @路径 抽取同形实现 —— 那边接口是「展开文件内容
//     进上下文」，与本处「抽用户名列表」目的不同，接口不合故同形实现）。
//
// 诚实边界（多重优雅降级）：
//   · 多进程强并发不在面内（本地文件协议，单机协作场景）：postThread 采用
//     append 直写 + seq 冲突检测重读 —— 同进程同步追加天然安全；跨进程竞态
//     后检测到 seq 重复会**诚实报错**要求重试，绝不静默错号；
//   · collab 目录不可写 → 诚实 error + 指引（不静默吞）；
//   · threads 为空 → 空列表 + 诚实摘要（threads:0/posts:0）；
//   · 所有路径过 lib/pathjail.ts（inWorkspace 纵深校验）；userId/threadId
//     全 regex 白名单（SAFE_USER_ID/SAFE_THREAD_ID —— 防路径注入的第一道门，
//     正则里没有 / 与 .，穿越形态在词法层即被拒）。
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { inWorkspace } from "./pathjail.ts";
import { readSession } from "./sessions.ts"; // 桥的唯一依赖（只读复用，绝不改写）

// ---- 白名单与常量 -------------------------------------------------------------

/** 协作用户 id 白名单（与 SAFE_SESSION_NAME 同风格：词法层即拒路径穿越形态）。 */
export const SAFE_USER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 线程 id 白名单（同上；长度放宽到 63 —— 线程名比用户名更长是常态）。 */
export const SAFE_THREAD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 协作文件根（工作区相对；与会话账本 runtime/sessions/ 同级）。 */
export const COLLAB_DIR_REL = "runtime/collab";

/** 单帖文本上限（16KB —— 更长该分帖，拒绝比静默截断诚实）。 */
const TEXT_CAP = 16 * 1024;
/** feed 读侧帖子数上限（增量轮询车道的安全阀）。 */
const FEED_CAP = 2000;
/** 单帖 mentions 抽取上限。 */
const MENTIONS_CAP = 16;
/** 桥镜像单帖 Q/A 截断（镜像是「团队可见」不是全文搬运）。 */
const BRIDGE_Q_CAP = 480;
const BRIDGE_A_CAP = 1600;

// ---- 身份层 -------------------------------------------------------------------

export interface CollabIdentity {
  user: string;
  display?: string;
  setAt?: string;
  /** 身份来源：env（ORG_COLLAB_USER）> file（collab-user）> default（"local"）。 */
  source: "env" | "file" | "default";
}

/** 身份文件路径。 */
function identityFile(ws: string): string {
  return path.join(ws, COLLAB_DIR_REL, "collab-user");
}

function validUser(u: string): boolean {
  return SAFE_USER_ID.test(u);
}

/**
 * 当前协作用户：ORG_COLLAB_USER 环境变量覆盖 > 身份文件 > 缺省 "local"。
 * 读侧永不失败（文件缺失/半写/非法 → 走降级链，来源字段诚实归因）。
 */
export function currentUser(ws: string): CollabIdentity {
  const envUser = String(process.env.ORG_COLLAB_USER ?? "").trim();
  if (envUser.length > 0 && validUser(envUser)) {
    return { user: envUser, source: "env" };
  }
  try {
    const o = JSON.parse(fs.readFileSync(identityFile(ws), "utf-8")) as { user?: unknown; display?: unknown; setAt?: unknown };
    const user = String(o.user ?? "");
    if (validUser(user)) {
      return {
        user,
        ...(typeof o.display === "string" && o.display.length > 0 ? { display: o.display } : {}),
        ...(typeof o.setAt === "string" ? { setAt: o.setAt } : {}),
        source: "file",
      };
    }
  } catch {
    // 文件缺失/半写/非法 → 缺省身份（首次协作的常态，不是错误）
  }
  return { user: "local", source: "default" };
}

/** 切换协作用户（写身份文件；display 可选，setAt 记录切换时刻）。 */
export function setUser(ws: string, userId: string, display?: string): CollabIdentity {
  if (!validUser(userId)) {
    throw new Error(`用户 id 不合法：${userId}（须匹配 ${SAFE_USER_ID.source} —— 小写字母/数字/连字符，≤32 字符）`);
  }
  const file = identityFile(ws);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const identity: CollabIdentity = {
      user: userId,
      ...(display && display.trim().length > 0 ? { display: display.trim() } : {}),
      setAt: new Date().toISOString(),
      source: "file",
    };
    fs.writeFileSync(file, JSON.stringify(identity, null, 2) + "\n", "utf-8");
    return identity;
  } catch (e) {
    throw new Error(
      `身份文件不可写：${file}（${e instanceof Error ? e.message : String(e)}）—— 检查目录权限，或换 --workspace 指向可写工作区`,
    );
  }
}

// ---- @mention 抽取（与 lib/mentions.ts 的 @路径 同形实现）----------------------

/**
 * 从文本抽 @用户名（用户 id 形：小写字母数字连字符，≤32）。
 * 边界规则：@ 前须是行首/空白/常见开分隔符（不吞邮箱 user@host）；
 * @ 后立即跟更长 id 字符时取最长匹配（@alice-x 抽 alice-x 不抽 alice）。
 * 去重保序、上限 16。大写形态不抽（用户 id 约定全小写 —— 诚实口径）。
 */
export function extractUserMentions(text: string): string[] {
  const re = /(^|[\s([（【:;,])@([a-z0-9][a-z0-9-]{0,31})(?![a-z0-9-])/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[2]!;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MENTIONS_CAP) break;
    // 零宽匹配保护（理论态：re 至少吞一个 @，不会零宽，防御性写上）
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

// ---- 线程协议 ------------------------------------------------------------------

export type ThreadKind = "post" | "comment" | "system";

export interface ThreadPost {
  /** 楼层号（线程内单调递增）。 */
  seq: number;
  user: string;
  role?: string;
  text: string;
  /** ISO 时间戳。 */
  at: string;
  kind: ThreadKind;
  /** 回复目标楼层（comment/system 可选挂）。 */
  replyTo?: number;
  /** @提及的协作者（post/comment 自动抽取；system 不抽）。 */
  mentions?: string[];
  /** 桥镜像回溯键（kind:"system" 专用：定位源账本 expert/session/turn）。 */
  meta?: { expert: string; session: string; turn: number };
}

/** 线程文件路径（id 不合法返回 null —— 调用方据此拒绝，绝不拼出穿越路径）。 */
export function threadFilePath(ws: string, threadId: string): string | null {
  if (!SAFE_THREAD_ID.test(threadId)) return null;
  return path.join(ws, COLLAB_DIR_REL, "threads", `${threadId}.jsonl`);
}

/** 解析后的线程文件路径（id 不合法/越界 → 诚实 error）。 */
function mustThreadFile(ws: string, threadId: string): string {
  const file = threadFilePath(ws, threadId);
  if (!file) {
    throw new Error(`线程 id 不合法：${threadId}（须匹配 ${SAFE_THREAD_ID.source} —— 小写字母/数字/连字符，≤64 字符；路径注入形态在词法层即拒）`);
  }
  // 纵深防御：拼出的路径必须仍在工作区内（pathjail 单点收敛的比较形）
  if (!inWorkspace(path.resolve(ws), file)) {
    throw new Error(`线程路径越界：${threadId}`);
  }
  return file;
}

/** 读一个线程的全部帖子（坏行容忍：半写/非法行跳过，seq 升序）。 */
export function readThread(ws: string, threadId: string): ThreadPost[] {
  const file = threadFilePath(ws, threadId);
  if (!file) return []; // 展示面语义：非法 id = 无帖子（写面 mustThreadFile 才报错）
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return []; // 文件缺失 = 新线程
  }
  const posts: ThreadPost[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const kind = o.kind === "comment" || o.kind === "system" ? o.kind : "post";
      posts.push({
        seq: Number(o.seq ?? 0),
        user: String(o.user ?? ""),
        ...(typeof o.role === "string" && o.role.length > 0 ? { role: o.role } : {}),
        text: String(o.text ?? ""),
        at: String(o.at ?? ""),
        kind,
        ...(typeof o.replyTo === "number" ? { replyTo: o.replyTo } : {}),
        ...(Array.isArray(o.mentions) ? { mentions: o.mentions.map(String) } : {}),
        ...(o.meta && typeof o.meta === "object" ? {
          meta: {
            expert: String((o.meta as Record<string, unknown>).expert ?? ""),
            session: String((o.meta as Record<string, unknown>).session ?? ""),
            turn: Number((o.meta as Record<string, unknown>).turn ?? 0),
          },
        } : {}),
      });
    } catch {
      // 坏行容忍（append-only 半写中间态）
    }
  }
  return posts.sort((a, b) => a.seq - b.seq);
}

export interface PostOptions {
  replyTo?: number;
  kind?: ThreadKind;
  role?: string;
  /** 显式提及（缺省从 text 自动抽取）。 */
  mentions?: string[];
  /** 桥镜像回溯键（kind:"system" 时由 bridgeSession 注入）。 */
  meta?: { expert: string; session: string; turn: number };
}

export interface PostResult {
  seq: number;
  file: string;
  mentions: string[];
  replyTo?: number;
}

/**
 * 发帖（append-only 追加；seq = 现有最大 seq + 1 单调递增）。
 *
 * 并发口径（诚实边界）：本地文件协议、单机协作场景 —— append 直写 +
 * seq 冲突检测重读。同进程同步追加天然安全；跨进程竞态在追加后重读检测
 * seq 重复时**诚实报错**（绝不静默错号）；多进程强并发不在面内。
 */
export function postThread(ws: string, threadId: string, user: string, text: string, opts?: PostOptions): PostResult {
  if (!validUser(user)) {
    throw new Error(`用户 id 不合法：${user}（须匹配 ${SAFE_USER_ID.source}）`);
  }
  const body = String(text ?? "").trim();
  if (body.length === 0) {
    throw new Error("帖子文本不能为空");
  }
  if (body.length > TEXT_CAP) {
    throw new Error(`帖子过长（${body.length} 字符 > ${TEXT_CAP} 上限）—— 拆成多帖更利于团队阅读`);
  }
  const file = mustThreadFile(ws, threadId);
  const existing = readThread(ws, threadId);
  const replyTo = opts?.replyTo;
  if (replyTo !== undefined) {
    if (!Number.isInteger(replyTo) || replyTo < 1) {
      throw new Error(`回复目标楼层不合法：${replyTo}`);
    }
    if (!existing.some((p) => p.seq === replyTo)) {
      throw new Error(`回复目标楼层不存在：#${replyTo}（线程当前 ${existing.length} 帖）`);
    }
  }
  const kind: ThreadKind = opts?.kind ?? "post";
  const mentions = opts?.mentions ?? (kind === "system" ? [] : extractUserMentions(body));
  const seq = existing.length > 0 ? Math.max(...existing.map((p) => p.seq)) + 1 : 1;
  const post: ThreadPost = {
    seq,
    user,
    ...(opts?.role && opts.role.length > 0 ? { role: opts.role } : {}),
    text: body,
    at: new Date().toISOString(),
    kind,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(opts?.meta ? { meta: opts.meta } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(post) + "\n", "utf-8");
  } catch (e) {
    throw new Error(
      `协作目录不可写：${path.dirname(file)}（${e instanceof Error ? e.message : String(e)}）—— 检查目录权限，或换 --workspace 指向可写工作区`,
    );
  }
  // seq 冲突检测重读（跨进程竞态的诚实面：检测到重复即报错，绝不静默错号）
  const seqs = readThread(ws, threadId).map((p) => p.seq);
  if (seqs.filter((s) => s === seq).length > 1) {
    throw new Error(`检测到并发写入冲突（seq ${seq} 重复）—— 本协议为单机协作设计，多进程强并发不在面内；请重试本次发帖`);
  }
  return { seq, file, mentions, ...(replyTo !== undefined ? { replyTo } : {}) };
}

/** 评论指定帖（postThread 的 replyTo 特化：kind:"comment"）。 */
export function commentOn(ws: string, threadId: string, targetSeq: number, user: string, text: string): PostResult {
  return postThread(ws, threadId, user, text, { replyTo: targetSeq, kind: "comment" });
}

// ---- 视图（列表 / 增量读 / 树平铺 / 协作者 / 摘要） ------------------------------

export interface ThreadSummary {
  id: string;
  /** 首帖截断（首行 60 字符）—— 线程标题。 */
  title: string;
  participants: string[];
  posts: number;
  comments: number;
  lastActive: string;
}

function threadsDir(ws: string): string {
  return path.join(ws, COLLAB_DIR_REL, "threads");
}

/** 线程索引（最后活动降序；无 threads 目录/空 → 空数组）。 */
export function listThreads(ws: string): ThreadSummary[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(threadsDir(ws)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // 目录缺失 = 协作尚未开始（常态，空列表诚实）
  }
  const out: ThreadSummary[] = [];
  for (const f of files) {
    const id = f.slice(0, -".jsonl".length);
    const posts = readThread(ws, id);
    if (posts.length === 0) continue;
    const first = posts[0]!;
    const firstLine = first.text.split("\n")[0] ?? "";
    const title = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
    const participants = [...new Set(posts.map((p) => p.user))];
    const lastActive = posts.reduce((m, p) => (p.at > m ? p.at : m), posts[0]!.at);
    out.push({
      id,
      title,
      participants,
      posts: posts.length,
      comments: posts.filter((p) => p.kind === "comment").length,
      lastActive,
    });
  }
  return out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.id.localeCompare(b.id)));
}

export interface ThreadFeed {
  id: string;
  /** sinceSeq 过滤后的帖子（seq 升序）。 */
  posts: ThreadPost[];
  sinceSeq: number;
  truncated: boolean;
}

/** 增量读（协作轮询的效率车道：只取 seq > sinceSeq 的帖子）。 */
export function threadFeed(ws: string, threadId: string, opts?: { sinceSeq?: number }): ThreadFeed {
  const sinceSeq = Number.isInteger(opts?.sinceSeq) ? Math.max(0, opts!.sinceSeq!) : 0;
  const file = threadFilePath(ws, threadId);
  if (!file) {
    throw new Error(`线程 id 不合法：${threadId}（须匹配 ${SAFE_THREAD_ID.source}）`);
  }
  const all = readThread(ws, threadId);
  const filtered = all.filter((p) => p.seq > sinceSeq);
  const truncated = filtered.length > FEED_CAP;
  return {
    id: threadId,
    posts: truncated ? filtered.slice(filtered.length - FEED_CAP) : filtered,
    sinceSeq,
    truncated,
  };
}

export interface FlatPost extends ThreadPost {
  /** 回复树深度（根帖 0；UI 缩进渲染用）。 */
  depth: number;
}

/**
 * 回复树平铺（UI 友好）：根帖在前、子帖紧随其父（DFS 深度优先），
 * 同层按 seq 升序。replyTo 指向不存在楼层（被截断/脏数据）→ 按根帖降级，
 * 不丢帖子（读侧容忍同一纪律）。
 */
export function flattenThread(posts: ThreadPost[]): FlatPost[] {
  const bySeq = new Map<number, ThreadPost>();
  for (const p of posts) bySeq.set(p.seq, p);
  const children = new Map<number, ThreadPost[]>();
  const roots: ThreadPost[] = [];
  for (const p of posts) {
    if (p.replyTo !== undefined && bySeq.has(p.replyTo)) {
      const list = children.get(p.replyTo) ?? [];
      list.push(p);
      children.set(p.replyTo, list);
    } else {
      roots.push(p);
    }
  }
  const out: FlatPost[] = [];
  const walk = (p: ThreadPost, depth: number): void => {
    out.push({ ...p, depth });
    for (const c of children.get(p.seq) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export interface CollaboratorView {
  user: string;
  posts: number;
  lastActive: string;
}

/** 协作者视图：扫描全部线程的去重用户 + 各自发帖数 + 最后活跃（发帖数降序）。 */
export function collaborators(ws: string): CollaboratorView[] {
  const byUser = new Map<string, CollaboratorView>();
  for (const t of listThreads(ws)) {
    for (const p of readThread(ws, t.id)) {
      if (!validUser(p.user)) continue; // 脏数据行不进视图（读侧容忍）
      const v = byUser.get(p.user) ?? { user: p.user, posts: 0, lastActive: p.at };
      v.posts += 1;
      if (p.at > v.lastActive) v.lastActive = p.at;
      byUser.set(p.user, v);
    }
  }
  return [...byUser.values()].sort((a, b) => b.posts - a.posts || a.user.localeCompare(b.user));
}

export interface CollabSummary {
  threads: number;
  posts: number;
  comments: number;
  users: number;
  lastActive: string | null;
}

/** 协作摘要（Web/CLI 总览；空工作区 → 全零 + null，诚实不装满）。 */
export function collabSummary(ws: string): CollabSummary {
  const threads = listThreads(ws);
  let posts = 0;
  let comments = 0;
  let lastActive: string | null = null;
  for (const t of threads) {
    posts += t.posts;
    comments += t.comments;
    if (lastActive === null || t.lastActive > lastActive) lastActive = t.lastActive;
  }
  return { threads: threads.length, posts, comments, users: collaborators(ws).length, lastActive };
}

// ---- 会话账本桥（单用户账本 → 团队可见；只镜像，绝不改写） ----------------------

export interface BridgeResult {
  /** 本次新镜像的轮数。 */
  mirrored: number;
  /** 已镜像过而跳过的轮数（幂等：重复 bridge 不重复刷屏）。 */
  skipped: number;
  /** 源账本总轮数。 */
  turns: number;
  threadId: string;
}

/**
 * 把单用户会话账本（lib/sessions.ts 协议）镜像成团队线程帖子：
 * 每轮 LedgerTurn → 一帖 kind:"system"（text 带 expert 标签 + 轮号，
 * meta 携带 {expert, session, turn} 回溯键）。
 *
 * · 只读源账本（readSession），原文件字节不变 —— 桥是「单用户账本 →
 *   团队可见」的单向镜像，不是同步（绝不回写）；
 * · 幂等：重复 bridge 同一 (expert, session) 只补新轮（按 meta 回溯键
 *   去重），不重复刷屏；
 * · 会话不存在/空 → 诚实 error（镜像空账本没有意义）。
 */
export function bridgeSession(
  ws: string, expert: string, sessionId: string, threadId: string, opts?: { user?: string },
): BridgeResult {
  const turns = readSession(ws, expert, sessionId); // 只读复用（向后兼容铁律）
  if (turns.length === 0) {
    throw new Error(`会话账本为空或不存在：${expert}/${sessionId}（org chat ${expert} --session ${sessionId} 先攒轮次，或核对专家/会话名）`);
  }
  const user = opts?.user ?? currentUser(ws).user;
  const existing = readThread(ws, threadId);
  const mirroredTurns = new Set(
    existing
      .filter((p) => p.kind === "system" && p.meta?.expert === expert && p.meta?.session === sessionId)
      .map((p) => p.meta!.turn),
  );
  let mirrored = 0;
  for (const t of turns) {
    if (mirroredTurns.has(t.turn)) continue;
    const q = t.question.length > BRIDGE_Q_CAP ? t.question.slice(0, BRIDGE_Q_CAP) + "…" : t.question;
    const a = t.answer.length > BRIDGE_A_CAP ? t.answer.slice(0, BRIDGE_A_CAP) + "…" : t.answer;
    const text =
      `[${expert}/${sessionId} #${t.turn}${t.compacted ? " · compact digest" : ""}] Q: ${q}\nA: ${a}`;
    postThread(ws, threadId, user, text, {
      kind: "system",
      meta: { expert, session: sessionId, turn: t.turn },
    });
    mirrored += 1;
  }
  return { mirrored, skipped: mirroredTurns.size, turns: turns.length, threadId };
}
