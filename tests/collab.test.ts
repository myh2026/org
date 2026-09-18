// ============================================================================
// tests/collab.test.ts — 团队协作层（v0.5.17 · capabilities #87）
// ----------------------------------------------------------------------------
// 六层锁定（与 tests/iacscan.test.ts 同构风格 —— lib 层为主，CLI/Web 冒烟收口）：
//   1. 身份层：whoami 缺省 local / setUser 持久化 / 非法 userId regex 拒绝 /
//      ORG_COLLAB_USER 环境变量覆盖（非法值走降级链）
//   2. 发帖与回复：postThread seq 单调 + JSONL 行形态 · @mention 自动抽取
//      （@alice @bob · 邮箱不误伤 · 大写不抽）· replyTo 树 flatten 出正确
//      depth（悬挂 replyTo 降级根，不丢帖）· commentOn 特化 · 目标楼层不存在
//      诚实拒绝 · 连续快速 post 的 seq 不冲突（append 直写 + 冲突检测）
//   3. 增量读：sinceSeq 过滤（协作轮询效率车道）
//   4. 视图：多用户多线程去重计数（collaborators / collabSummary）+ 空工作区
//      诚实全零 + 坏行容忍（半写行跳过不连坐）
//   5. 桥：bridgeSession 把 LedgerTurn 镜像成 kind:"system" 帖（text 带 expert
//      标签 + meta 回溯键）· 原账本文件字节不变（读前后 sha256 对拍 —— 向后
//      兼容铁律的机械断言）· 幂等（重复 bridge 只补新轮）· 空会话诚实报错
//   6. 安全与降级：threadId 路径注入形态（../../、绝对路径、空格、大写）在
//      词法层拒绝 · collab 目录被普通文件占位 → 诚实 error（不静默吞）
//   7. 三端冒烟：CLI org collab 九子命令退出码与输出关键字 · Web
//      /api/govex/collab GET/POST 全 action + 越界拒绝 + 面板区块在场 +
//      本簇 JS 块独立可解析（不与并行簇的存量问题互相连坐）
// ============================================================================
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runOrg } from "./helpers";
import {
  currentUser, setUser, postThread, commentOn, listThreads, threadFeed, flattenThread,
  collaborators, collabSummary, bridgeSession, readThread, extractUserMentions,
  threadFilePath, COLLAB_DIR_REL, SAFE_USER_ID, SAFE_THREAD_ID,
} from "../lib/collab.ts";
import { writeSession, readSession, latestSession } from "../lib/sessions.ts";

const ROOT = path.resolve(import.meta.dir, "..");

/** 一次性 tmp 工作区（最小受控 —— 不复制 demo-ws，协作不设注册表门槛）。 */
function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-collab-${tag}-`));
}

function sha256(buf: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

/** 直播种一个单用户会话账本（lib/sessions.ts 协议原样手写落盘）。 */
function seedLedger(ws: string, expert: string, session: string, turns: number): string {
  const file = path.join(ws, "runtime", "sessions", expert, `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= turns; i++) {
    lines.push(JSON.stringify({ turn: i, question: `问题 ${i}`, answer: `回答 ${i}`, tokens: 10 + i, ctx_tokens: 12 + i }));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// 环境变量卫生：本文件用例会临时改 ORG_COLLAB_USER（currentUser 读 env）
const ENV_KEY = "ORG_COLLAB_USER";
const envSaved = process.env[ENV_KEY];
afterEach(() => {
  if (envSaved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = envSaved;
});

// ---- 1. 身份层 -------------------------------------------------------------------

describe("协作：身份层", () => {
  test("whoami：无 env 无身份文件 → 缺省 local（来源归因 default）", () => {
    delete process.env[ENV_KEY];
    const ws = tmpWs("id-default");
    try {
      const id = currentUser(ws);
      expect(id.user).toBe("local");
      expect(id.source).toBe("default");
      // 身份文件不因「读」而落盘（读侧零副作用）
      expect(fs.existsSync(path.join(ws, COLLAB_DIR_REL, "collab-user"))).toBe(false);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("setUser：持久化（user/display/setAt）且 whoami 读回同值（source=file）", () => {
    delete process.env[ENV_KEY];
    const ws = tmpWs("id-set");
    try {
      const id = setUser(ws, "alice", "Alice L");
      expect(id.user).toBe("alice");
      expect(id.display).toBe("Alice L");
      expect(typeof id.setAt).toBe("string");
      const back = currentUser(ws);
      expect(back.user).toBe("alice");
      expect(back.display).toBe("Alice L");
      expect(back.source).toBe("file");
      // 文件是合法 JSON（半写检测面）
      expect(() => JSON.parse(fs.readFileSync(path.join(ws, COLLAB_DIR_REL, "collab-user"), "utf-8"))).not.toThrow();
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("非法 userId：regex 拒绝（大写/下划线/斜杠/点/过长/空 —— 也是路径注入的第一道门）", () => {
    const ws = tmpWs("id-bad");
    try {
      for (const bad of ["Alice", "a_b", "a/b", "../x", "a.b", "x".repeat(33), ""]) {
        expect(() => setUser(ws, bad)).toThrow(/不合法/);
      }
      expect(SAFE_USER_ID.test("alice")).toBe(true);
      expect(SAFE_USER_ID.test("a")).toBe(true);
      expect(SAFE_USER_ID.test("dev-2")).toBe(true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("ORG_COLLAB_USER 覆盖（source=env，不落盘）；非法 env 值走降级链到身份文件", () => {
    const ws = tmpWs("id-env");
    try {
      process.env[ENV_KEY] = "bob";
      const viaEnv = currentUser(ws);
      expect(viaEnv.user).toBe("bob");
      expect(viaEnv.source).toBe("env");
      expect(fs.existsSync(path.join(ws, COLLAB_DIR_REL, "collab-user"))).toBe(false); // env 不落盘
      process.env[ENV_KEY] = "NOT-valid"; // 大写非法 → 降级
      setUser(ws, "carol");
      const degraded = currentUser(ws);
      expect(degraded.user).toBe("carol");
      expect(degraded.source).toBe("file");
      delete process.env[ENV_KEY];
      expect(currentUser(ws).user).toBe("carol");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);
});

// ---- 2. 发帖 / 回复 / mentions / 并发 --------------------------------------------

describe("协作：发帖与回复树", () => {
  const ws = tmpWs("post");
  afterAll(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 句柄滞后 */ } });

  test("postThread：seq 单调递增 + JSONL 行形态（append-only 字段齐全）", () => {
    const r1 = postThread(ws, "t1", "alice", "首帖：kickoff");
    const r2 = postThread(ws, "t1", "bob", "第二帖");
    const r3 = postThread(ws, "t1", "alice", "第三帖");
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    const raw = fs.readFileSync(path.join(ws, COLLAB_DIR_REL, "threads", "t1.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(3);
    const o = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(o.seq).toBe(1);
    expect(o.user).toBe("alice");
    expect(o.kind).toBe("post");
    expect(typeof o.at).toBe("string");
    expect(o.at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO
    // append-only：三行都是完整 JSON（无改写痕迹 —— 逐行可 parse 即证）
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  }, 30_000);

  test("mentions 自动抽取：@alice @bob 去重保序；邮箱 user@host 不误伤；大写形态不抽（用户 id 约定小写）", () => {
    const text = "hi @alice and @bob, again @alice — mail me a@example.com not a @mention, and @Carol stays out";
    expect(extractUserMentions(text)).toEqual(["alice", "bob", "mention"]);
    // 显式 mentions 覆盖自动抽取
    const r = postThread(ws, "t2", "alice", "check @bob", { mentions: ["carol"] });
    expect(r.mentions).toEqual(["carol"]);
    // 空文本拒绝（诚实面）
    expect(() => postThread(ws, "t2", "alice", "   ")).toThrow(/不能为空/);
  }, 30_000);

  test("replyTo 树：flattenThread depth 正确（根 0 / 子 1 / 孙 2）；写面拒幽灵楼层、读面悬挂降级根不丢帖", () => {
    postThread(ws, "tree", "alice", "根帖");
    postThread(ws, "tree", "bob", "回根", { replyTo: 1, kind: "comment" });
    postThread(ws, "tree", "carol", "回回根（孙）", { replyTo: 2, kind: "comment" });
    postThread(ws, "tree", "alice", "另一根");
    // 写面：replyTo 指向不存在楼层 → 诚实拒绝（防手滑错楼）
    expect(() => postThread(ws, "tree", "bob", "ghost", { replyTo: 99, kind: "comment" })).toThrow(/不存在/);
    // 读面：手写悬挂 replyTo（模拟脏数据/手编文件）→ flatten 降级根，不丢帖
    const file = path.join(ws, COLLAB_DIR_REL, "threads", "tree.jsonl");
    fs.appendFileSync(file, JSON.stringify({ seq: 5, user: "bob", text: "悬挂（脏数据）", at: "2026-01-01T00:00:00.000Z", kind: "comment", replyTo: 99 }) + "\n");
    const flat = flattenThread(readThread(ws, "tree"));
    expect(flat.map((p) => [p.seq, p.depth])).toEqual([[1, 0], [2, 1], [3, 2], [4, 0], [5, 0]]);
    expect(flat.length).toBe(5); // 悬挂不丢帖（读侧容忍）
  }, 30_000);

  test("commentOn：kind:\"comment\" + replyTo 特化；目标楼层不存在诚实拒绝", () => {
    postThread(ws, "c1", "alice", "host");
    const c = commentOn(ws, "c1", 1, "bob", "a comment @alice");
    expect(c.replyTo).toBe(1);
    const post = readThread(ws, "c1").find((p) => p.seq === c.seq)!;
    expect(post.kind).toBe("comment");
    expect(post.mentions).toEqual(["alice"]);
    expect(() => commentOn(ws, "c1", 42, "bob", "ghost")).toThrow(/不存在/);
    expect(() => commentOn(ws, "c1", -1, "bob", "bad")).toThrow(/不合法/);
  }, 30_000);

  test("连续快速 post：seq 不冲突（append 直写 + 冲突检测重读后文件一致）", () => {
    const results = Array.from({ length: 8 }, (_, i) => postThread(ws, "burst", `u${(i % 3) + 1}`, `fast ${i}`));
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const seqs = readThread(ws, "burst").map((p) => p.seq);
    expect(new Set(seqs).size).toBe(8); // 无重复（并发口径的机械断言）
  }, 30_000);

  test("坏行容忍：半写/非法行跳过，好帖照读（append-only 中间态）", () => {
    const file = path.join(ws, COLLAB_DIR_REL, "threads", "t1.jsonl");
    fs.appendFileSync(file, '{"seq":99,"user":"ghost","text":"半写行（无 kind/at 也无尾换行');
    const posts = readThread(ws, "t1");
    expect(posts.length).toBe(3); // 原三帖照读，坏行不计
    expect(posts.every((p) => p.seq <= 3)).toBe(true);
    // 坏行后继续追加照常（seq 不被坏行干扰 —— 用最大好 seq + 1）
    const r = postThread(ws, "t1", "alice", "after corruption");
    expect(r.seq).toBe(4);
  }, 30_000);
});

// ---- 3. 增量读 -------------------------------------------------------------------

describe("协作：增量读（sinceSeq 效率车道）", () => {
  test("sinceSeq 过滤：0 全量 / N 只取之后 / 超前值空列表（诚实不装满）", () => {
    const ws = tmpWs("feed");
    try {
      for (let i = 1; i <= 5; i++) postThread(ws, "f1", "alice", `p${i}`);
      expect(threadFeed(ws, "f1").posts.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(threadFeed(ws, "f1", { sinceSeq: 3 }).posts.map((p) => p.seq)).toEqual([4, 5]);
      expect(threadFeed(ws, "f1", { sinceSeq: 5 }).posts).toEqual([]);
      expect(threadFeed(ws, "f1", { sinceSeq: 99 }).posts).toEqual([]);
      expect(threadFeed(ws, "f1", { sinceSeq: 3 }).sinceSeq).toBe(3);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);
});

// ---- 4. 协作者视图与摘要 -----------------------------------------------------------

describe("协作：协作者视图与摘要", () => {
  test("多用户多线程：去重用户 / 发帖数 / 最后活跃 / 总量聚合；空工作区诚实全零", () => {
    const ws = tmpWs("views");
    try {
      expect(listThreads(ws)).toEqual([]);
      const empty = collabSummary(ws);
      expect(empty).toEqual({ threads: 0, posts: 0, comments: 0, users: 0, lastActive: null });
      expect(collaborators(ws)).toEqual([]);

      postThread(ws, "a", "alice", "a1");
      postThread(ws, "a", "bob", "a2");
      commentOn(ws, "a", 1, "alice", "a3");
      postThread(ws, "b", "carol", "b1");
      postThread(ws, "b", "alice", "b2");

      const users = collaborators(ws);
      expect(users.map((u) => u.user)).toEqual(["alice", "bob", "carol"]); // 发帖数降序
      expect(users.find((u) => u.user === "alice")!.posts).toBe(3);
      expect(users.find((u) => u.user === "bob")!.posts).toBe(1);

      const s = collabSummary(ws);
      expect(s.threads).toBe(2);
      expect(s.posts).toBe(5);
      expect(s.comments).toBe(1);
      expect(s.users).toBe(3);
      expect(s.lastActive).toBeTruthy();

      const threads = listThreads(ws);
      expect(threads.length).toBe(2);
      const ta = threads.find((t) => t.id === "a")!;
      expect(ta.participants).toEqual(["alice", "bob"]);
      expect(ta.posts).toBe(3);
      expect(ta.comments).toBe(1);
      expect(ta.title).toBe("a1");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);
});

// ---- 5. 会话账本桥（向后兼容铁律的机械断言） --------------------------------------

describe("协作：会话账本桥 bridgeSession", () => {
  test("LedgerTurn 镜像成 kind:\"system\" 帖：text 带 expert 标签 + meta 回溯键；原账本字节不变", () => {
    const ws = tmpWs("bridge");
    try {
      const ledger = seedLedger(ws, "notice-parser", "demo", 3);
      const before = fs.readFileSync(ledger);
      const beforeHash = sha256(before);

      const r = bridgeSession(ws, "notice-parser", "demo", "t-bridge");
      expect(r.turns).toBe(3);
      expect(r.mirrored).toBe(3);
      expect(r.skipped).toBe(0);

      const posts = readThread(ws, "t-bridge");
      expect(posts.length).toBe(3);
      for (const p of posts) {
        expect(p.kind).toBe("system");
        expect(p.text).toContain("[notice-parser/demo #");
        expect(p.meta).toEqual({ expert: "notice-parser", session: "demo", turn: p.seq });
      }
      expect(posts[0]!.text).toContain("Q: 问题 1");
      expect(posts[0]!.text).toContain("A: 回答 1");

      // 向后兼容铁律：原账本字节不变（读前后 sha256 对拍）
      const after = fs.readFileSync(ledger);
      expect(sha256(after)).toBe(beforeHash);
      expect(after.equals(before)).toBe(true);
      // 桥不碰既有会话账本协议：readSession 仍读出原三轮
      expect(readSession(ws, "notice-parser", "demo").length).toBe(3);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("幂等：重复 bridge 只补新轮（meta 回溯键去重），不重复刷屏", () => {
    const ws = tmpWs("bridge-idem");
    try {
      seedLedger(ws, "notice-parser", "demo", 2);
      expect(bridgeSession(ws, "notice-parser", "demo", "tb").mirrored).toBe(2);
      const again = bridgeSession(ws, "notice-parser", "demo", "tb");
      expect(again.mirrored).toBe(0);
      expect(again.skipped).toBe(2);
      expect(readThread(ws, "tb").length).toBe(2);
      // 源账本新增一轮 → 再 bridge 只补那一轮
      writeSession(ws, "notice-parser", "demo", [
        { turn: 1, question: "q1", answer: "a1", tokens: 1, ctx_tokens: 1, compacted: false, compacted_from: 0 },
        { turn: 2, question: "q2", answer: "a2", tokens: 1, ctx_tokens: 1, compacted: false, compacted_from: 0 },
        { turn: 3, question: "q3", answer: "a3", tokens: 1, ctx_tokens: 1, compacted: false, compacted_from: 0 },
      ]);
      const third = bridgeSession(ws, "notice-parser", "demo", "tb");
      expect(third.mirrored).toBe(1);
      expect(readThread(ws, "tb").length).toBe(3);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("空会话/不存在：诚实报错（镜像空账本没有意义）", () => {
    const ws = tmpWs("bridge-empty");
    try {
      expect(() => bridgeSession(ws, "ghost", "demo", "t")).toThrow(/为空或不存在/);
      expect(() => bridgeSession(ws, "notice-parser", "nope", "t")).toThrow(/为空或不存在/);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);
});

// ---- 6. 安全（路径注入）与降级 -----------------------------------------------------

describe("协作：路径监狱与降级", () => {
  test("threadId 注入形态在词法层拒绝（../../、绝对路径、空格、大写、点）+ pathjail 纵深", () => {
    const ws = tmpWs("jail");
    try {
      for (const bad of ["../../etc/passwd", "/etc/passwd", "a b", "T1", ".", "..", "a.b", "t/1", ""]) {
        expect(threadFilePath(ws, bad)).toBeNull();
        expect(() => postThread(ws, bad, "alice", "x")).toThrow(/不合法/);
        expect(() => threadFeed(ws, bad)).toThrow(/不合法/);
      }
      expect(SAFE_THREAD_ID.test("t1")).toBe(true);
      expect(SAFE_THREAD_ID.test("session-notice-parser-demo")).toBe(true);
      // 合法 id 的落点必须仍在工作区内（pathjail 单点收敛比较形）
      const file = threadFilePath(ws, "t1")!;
      expect(file.startsWith(path.resolve(ws))).toBe(true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("非法 userId 发帖拒绝；collab 目录被普通文件占位 → 诚实 error（不静默吞）", () => {
    const ws = tmpWs("degrade");
    try {
      expect(() => postThread(ws, "t1", "../evil", "x")).toThrow(/用户 id 不合法/);
      expect(() => postThread(ws, "t1", "Bad", "x")).toThrow(/用户 id 不合法/);
      // 占位文件形态（平台无关：root 下 chmod 0o555 不可靠，ENOTDIR 恒真）
      fs.mkdirSync(path.join(ws, "runtime"), { recursive: true });
      fs.writeFileSync(path.join(ws, "runtime", "collab"), "占位（非目录）");
      expect(() => postThread(ws, "t1", "alice", "hi")).toThrow(/协作目录不可写/);
      expect(() => setUser(ws, "alice")).toThrow(/身份文件不可写/);
      // 降级后读侧仍诚实：无 threads 目录 → 空列表不炸
      expect(listThreads(ws)).toEqual([]);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);

  test("超长帖拒绝（16KB 上限 —— 拆帖比静默截断诚实）", () => {
    const ws = tmpWs("cap");
    try {
      expect(() => postThread(ws, "t1", "alice", "x".repeat(16 * 1024 + 1))).toThrow(/过长/);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 30_000);
});

// ---- 7. CLI 冒烟（九子命令全链） ---------------------------------------------------

describe("协作：CLI org collab 冒烟", () => {
  const WS = path.join(ROOT, "demo-run-tests", "collab-cli");
  const ledgerFile = () => path.join(WS, "runtime", "sessions", "notice-parser", "demo.jsonl");

  beforeAll(() => {
    fs.rmSync(WS, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
    seedLedger(WS, "notice-parser", "demo", 2);
    // 不用 ensureWorkspace 的模板初始化 —— 协作不设注册表门槛，空目录即工作区
  });
  afterAll(() => { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

  test("whoami（缺省 local）→ user 切换（持久化）→ whoami 读回", () => {
    const w = runOrg(["collab", "whoami", "--workspace", WS], { ORG_COLLAB_USER: "" });
    expect(w.exitCode).toBe(0);
    expect(w.stdout).toContain("local");
    expect(w.stdout).toContain("缺省");

    const u = runOrg(["collab", "user", "alice", "Alice L", "--workspace", WS]);
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toContain("alice");

    const w2 = runOrg(["collab", "whoami", "--workspace", WS]);
    expect(w2.stdout).toContain("alice");
    expect(w2.stdout).toContain("身份文件");

    const env = runOrg(["collab", "whoami", "--workspace", WS], { ORG_COLLAB_USER: "bob" });
    expect(env.stdout).toContain("bob");
    expect(env.stdout).toContain("环境变量");
  }, 60_000);

  test("post（@mention 抽取）→ comment → threads → feed（树缩进 + --since）→ users → summary", () => {
    const p = runOrg(["collab", "post", "t1", "kickoff @bob check the spec", "--workspace", WS]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toContain("#1");
    expect(p.stdout).toContain("@bob");

    const p2 = runOrg(["collab", "post", "t1", "second post from alice", "--workspace", WS]);
    expect(p2.exitCode).toBe(0);

    const c = runOrg(["collab", "comment", "t1", "1", "on it @alice", "--workspace", WS], { ORG_COLLAB_USER: "bob" });
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain("↳ #1");
    expect(c.stdout).toContain("bob");

    const t = runOrg(["collab", "threads", "--workspace", WS]);
    expect(t.exitCode).toBe(0);
    expect(t.stdout).toContain("t1");
    expect(t.stdout).toContain("kickoff");
    expect(t.stdout).toContain("3 帖");
    expect(t.stdout).toContain("alice, bob");

    const f = runOrg(["collab", "feed", "t1", "--workspace", WS]);
    expect(f.exitCode).toBe(0);
    expect(f.stdout).toContain("评论 ↳ #1");
    expect(f.stdout).toContain("@alice");

    const fs2 = runOrg(["collab", "feed", "t1", "--since", "2", "--workspace", WS]);
    expect(fs2.exitCode).toBe(0);
    expect(fs2.stdout).toContain("since #2");
    expect(fs2.stdout).not.toContain("kickoff"); // 被过滤

    const users = runOrg(["collab", "users", "--workspace", WS]);
    expect(users.exitCode).toBe(0);
    expect(users.stdout).toContain("alice");
    expect(users.stdout).toContain("bob");

    const s = runOrg(["collab", "summary", "--workspace", WS]);
    expect(s.exitCode).toBe(0);
    expect(s.stdout).toContain("1 线程 · 3 帖（1 评论）· 2 位协作者");
  }, 120_000);

  test("bridge：镜像会话账本 → 线程；原账本字节不变；幂等（再 bridge 跳过）", () => {
    const before = fs.readFileSync(ledgerFile());
    const b = runOrg(["collab", "bridge", "notice-parser", "demo", "--thread", "mirror-1", "--workspace", WS]);
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toContain("2/2 轮");
    expect(b.stdout).toContain("mirror-1");
    // 向后兼容铁律：CLI 桥也不碰原账本
    expect(fs.readFileSync(ledgerFile()).equals(before)).toBe(true);

    const b2 = runOrg(["collab", "bridge", "notice-parser", "demo", "--thread", "mirror-1", "--workspace", WS]);
    expect(b2.exitCode).toBe(0);
    expect(b2.stdout).toContain("0/2 轮"); // 幂等

    const f = runOrg(["collab", "feed", "mirror-1", "--workspace", WS]);
    expect(f.stdout).toContain("系统");
    expect(f.stdout).toContain("[notice-parser/demo #1]");
  }, 120_000);

  test("用法/防呆：无子命令 → 2；未知子命令 → 2；jail threadId → 1 诚实报错", () => {
    expect(runOrg(["collab", "--workspace", WS]).exitCode).toBe(2);
    expect(runOrg(["collab", "nope", "--workspace", WS]).exitCode).toBe(2);
    const j = runOrg(["collab", "post", "../../evil", "x", "--workspace", WS]);
    expect(j.exitCode).toBe(1);
    expect(j.stderr).toContain("不合法");
  }, 60_000);

  test("sessions 协议零回归：桥之后 latestSession/readSession 原样工作", () => {
    expect(latestSession(WS, "notice-parser")).toBe("demo");
    expect(readSession(WS, "notice-parser", "demo").length).toBe(2);
  }, 30_000);
});

// ---- 8. Web 端点 + 面板 ----------------------------------------------------------

describe("协作：工具环 e2e（collab_* 5 工具 · direct 车道全链）", () => {
  const WS = path.join(ROOT, "demo-run-tests", "collab-ring-ws");
  const DIRECT = path.join(ROOT, "hsl/pool/direct.hsl");
  const DHV = path.join(ROOT, "toolchain/dhv-ts/src/main.ts");
  let seq = 0;

  beforeAll(() => {
    fs.rmSync(WS, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "demo-ws"), WS, { recursive: true });
    // 预置长期放行集（file_write）—— 审批文件协议的 always 语义（与 tests/tools2 同规）
    fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["file_write"] }));
  });
  afterAll(() => { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

  test("collab_summary/post/comment/feed 四工具真链：发帖落盘 + 观测摘要可解析", () => {
    const out = path.join(ROOT, "demo-run-tests", "out-collab-ring", `t${++seq}`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const fixture = path.join(ROOT, "demo-run-tests", `collab-ring-fixture-${seq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: { "direct:notice-parser": [
      '<tool>{"name":"collab_summary","args":{}}</tool>',
      '<tool>{"name":"collab_post","args":{"thread":"ring-t1","text":"tool-ring post @alice"}}</tool>',
      '<tool>{"name":"collab_comment","args":{"thread":"ring-t1","seq":1,"text":"tool-ring comment"}}</tool>',
      '<tool>{"name":"collab_feed","args":{"thread":"ring-t1"}}</tool>',
      "最终答案：协作工具环验证完成。",
    ] } }));
    const r = Bun.spawnSync([process.execPath, DHV, "run", DIRECT,
      "--workspace", WS, "--task", "(direct) 协作工具环测试", "--model", "scripted",
      "--fixture", fixture, "--out", out, "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      cwd: ROOT,
      env: { ...process.env, DHV_TS: DHV.replace(/\\/g, "/"), ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "collab-ring", ORG_ASK_QUESTION: "协作工具环测试", ORG_TOOLS: "write", ORG_APPROVAL: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    // 观测摘要（result_summary 的 journal 人读面）
    const events = fs.readFileSync(path.join(out, "events.jsonl"), "utf-8").split("\n")
      .filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as { name: string; data?: { name?: string; detail?: string } });
    const results = events.filter((e) => e.name === "journal" && e.data?.name === "tool_result").map((e) => String(e.data?.detail ?? ""));
    expect(results.some((d) => d.startsWith("collab_summary ok threads=0"))).toBe(true);
    expect(results.some((d) => d.startsWith("collab_post ok ring-t1 #1") && d.includes("@alice"))).toBe(true);
    expect(results.some((d) => d.startsWith("collab_comment ok ring-t1 #2 ↳#1"))).toBe(true);
    expect(results.some((d) => d.startsWith("collab_feed ok ring-t1 2帖·1评论·1用户"))).toBe(true);
    // 落盘（append-only JSONL · 署名缺省 local · mentions 自动抽取）
    const file = path.join(WS, "runtime", "collab", "threads", "ring-t1.jsonl");
    const posts = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(posts.length).toBe(2);
    expect(posts[0]!.mentions).toEqual(["alice"]);
    expect(posts[1]!.kind).toBe("comment");
  }, 120_000);
});

describe("协作：Web /api/govex/collab + 👥 面板", () => {
  test("GET actions（threads/feed/users/summary/whoami）+ POST actions（post/comment/user/bridge）+ 越界拒绝", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    const ws = tmpWs("web");
    seedLedger(ws, "notice-parser", "demo", 1);
    const srv = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = async (u: string): Promise<Record<string, unknown>> => (await (await fetch(base + u)).json()) as Record<string, unknown>;
      const post = async (u: string, body: unknown): Promise<Record<string, unknown>> =>
        (await (await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

      // 空工作区诚实面
      const who0 = await get("/api/govex/collab?action=whoami");
      expect(who0.ok).toBe(true);
      expect(who0.user).toBe("local");
      expect(who0.source).toBe("default");
      const sum0 = await get("/api/govex/collab");
      expect(sum0.threads).toBe(0);
      expect(sum0.lastActive).toBeNull();

      // 身份切换 → 发帖（XSS 载荷原样存储，渲染层负责转义）
      const u = await post("/api/govex/collab", { action: "user", user: "alice", display: "Alice L" });
      expect(u.ok).toBe(true);
      expect(u.user).toBe("alice");
      const p = await post("/api/govex/collab", { action: "post", thread: "t1", text: "kickoff @bob <script>alert(1)</script>" });
      expect(p.ok).toBe(true);
      expect(p.seq).toBe(1);
      expect(p.mentions).toEqual(["bob"]);
      const c = await post("/api/govex/collab", { action: "comment", thread: "t1", seq: 1, text: "on it @alice" });
      expect(c.ok).toBe(true);
      expect(c.reply_to).toBe(1);

      // GET 面
      const threads = await get("/api/govex/collab?action=threads");
      expect(threads.ok).toBe(true);
      expect(JSON.stringify(threads.threads)).toContain("t1");
      const feed = await get("/api/govex/collab?action=feed&thread=t1");
      const posts = feed.posts as Array<{ seq: number; depth: number; kind: string; text: string }>;
      expect(posts.map((x) => [x.seq, x.depth, x.kind])).toEqual([[1, 0, "post"], [2, 1, "comment"]]);
      expect(posts[0]!.text).toContain("<script>alert(1)</script>"); // 存储不剥不转义（渲染层 esc）
      const since = await get("/api/govex/collab?action=feed&thread=t1&since=1");
      expect((since.posts as unknown[]).length).toBe(1);
      const users = await get("/api/govex/collab?action=users");
      expect(JSON.stringify(users.collaborators)).toContain("alice");

      // 桥（POST）
      const b = await post("/api/govex/collab", { action: "bridge", expert: "notice-parser", session: "demo", thread: "mirror" });
      expect(b.ok).toBe(true);
      expect(b.mirrored).toBe(1);
      expect(fs.readFileSync(path.join(ws, "runtime", "sessions", "notice-parser", "demo.jsonl")).toString()).toContain("问题 1"); // 原账本未动

      // 越界/防呆：注入 threadId 拒绝；缺参 400；未知 action 拒绝
      const esc1 = await post("/api/govex/collab", { action: "post", thread: "../../evil", text: "x" });
      expect(esc1.ok).toBe(false);
      expect(String(esc1.error)).toContain("不合法");
      const esc2 = await post("/api/govex/collab", { action: "post", thread: "t1" });
      expect(esc2.ok).toBe(false);
      const bad = await post("/api/govex/collab", { action: "nope" });
      expect(bad.ok).toBe(false);
      expect(String(bad.error)).toContain("未知 action");
    } finally {
      srv.stop();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  test("面板：👥 协作 Tab 区块在场（gxSecCollab/端点引用）+ 本簇 JS 块独立可解析", async () => {
    const { startWebServer } = await import("../web/entry.ts");
    const ws = tmpWs("web-html");
    const srv = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    try {
      const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      expect(html).toContain('id="gxSecCollab"');
      expect(html).toContain('id="gxTabCollab"');
      expect(html).toContain('"/api/govex/collab"');
      expect(html).toContain("gxCollabPost()");
      expect(html).toContain("gxCollabBridge()");
      // 本簇 JS 函数逐个独立可解析（v0.5.15 踩过模板字面量转义层级坑；按函数名
      // 精确切块 —— 并行簇在同文件插入代码不互相连坐，整页脚本断言由 wiring2/web 守卫）
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
      for (const fn of ["gxCollabWhoRender", "gxCollabLoad", "gxCollabFeed", "gxCollabQuote", "gxCollabPost", "gxCollabComment", "gxCollabSetUser", "gxCollabBridge"]) {
        const i = script.indexOf(`function ${fn}(`);
        expect(i).toBeGreaterThanOrEqual(0); // 函数在场
        const j = script.indexOf("\nfunction ", i + 1);
        const chunk = script.slice(i, j < 0 ? undefined : j);
        expect(() => new Function(chunk)).not.toThrow();
      }
    } finally {
      srv.stop();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);
});
