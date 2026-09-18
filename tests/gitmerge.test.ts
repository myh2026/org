// ============================================================================
// tests/gitmerge.test.ts — merge/rebase 安全操作层（v0.5.16 · capabilities #80）
// ----------------------------------------------------------------------------
// lib/gitmerge.ts 全覆盖（17 用例，全部显式 30s 超时，tmp 仓播种 + afterAll
// best-effort 清理）：
//   状态探测（5）：干净仓基线 / ahead / diverged（真实 clone + fetch）/
//                dirty + stash / detached HEAD（branch:null 不算降级）
//   merge（5）：fast-forward / --no-ff 合并提交 + 自定义 message /
//              Already up to date / 冲突自动 abort（清单 + 工作区干净 +
//              内容回到合并前）/ 多文件冲突清单
//   rebase（3）：真变基成功 / 冲突自动 abort（回到变基前 + 分支不动）/
//                已是最新（up to date）
//   降级与拒绝（4）：非 repo 降级（gitMergeState 完整结构 + degraded）/
//                不存在的目录 / 未知分支 internal 附 git 原文 /
//                git 缺席（PATH 收窄）+ 参数校验 + 脏树拒并非冲突 internal
// ============================================================================
import { describe, test, expect, afterAll } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitMergeState, gitMerge, gitRebase, GIT_LIMITS } from "../lib/gitmerge.ts";

// ---- 测试基建：tmp git 仓播种 ---------------------------------------------------

const REPOS: string[] = []; // afterAll best-effort 清理清单

/** 一次性 tmp 根（所有仓都种在它下面）。 */
function labRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-gitmerge-"));
  REPOS.push(root);
  return root;
}

/** 测试侧直跑 git（不经被测模块 —— 播种与验证用）。 */
function git(cwd: string, args: string[]): cp.SpawnSyncReturns<string> {
  return cp.spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
}

function write(cwd: string, rel: string, content: string): void {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function read(cwd: string, rel: string): string {
  // CRLF 防线第 2 层（v0.5.16.1 CI 修复）：GitHub win32 runner 机器级 core.autocrlf=true
  // 会把 checkout 重写的文件混入 \r\n —— 语义断言按 LF 归一比较（与 turing.test.ts normOut 同规）。
  return fs.readFileSync(path.join(cwd, rel), "utf-8").replace(/\r\n/g, "\n");
}

/** 标准仓：main 分支 + 基线提交（a.txt 三行 + b.txt）。 */
function makeRepo(tag: string): string {
  const repo = path.join(labRoot(), tag);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "org@test"]);
  git(repo, ["config", "user.name", "org-test"]);
  // CRLF 防线第 1 层（v0.5.16.1 CI 修复）：GitHub win32 runner 机器级 core.autocrlf=true
  // 在 merge --abort / checkout 重写文件时把 LF blob 涂成 \r\n —— 仓级关闭换行转
  // 换，播种与断言字节确定性跨平台一致（macOS/linux 本就无此转换，零变化）。
  git(repo, ["config", "core.autocrlf", "false"]);
  write(repo, "a.txt", "line1\nline2\nline3\n");
  write(repo, "b.txt", "keep\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

/** 分叉仓：base → feature 改 a.txt 第 2 行，main 也改 a.txt 第 2 行（必冲突）。 */
function makeConflictRepo(tag: string, files: string[] = ["a.txt"]): string {
  const repo = makeRepo(tag);
  git(repo, ["checkout", "-q", "-b", "feature"]);
  for (const f of files) write(repo, f, "line1\nFEATURE\nline3\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat-change"]);
  git(repo, ["checkout", "-q", "main"]);
  for (const f of files) write(repo, f, "line1\nMAIN\nline3\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main-change"]);
  return repo;
}

/** 真实 clone 仓（upstream = origin/main）：seed 提交 + push 建立跟踪。 */
function makeCloneRepo(tag: string): { origin: string; work: string } {
  const root = labRoot();
  const origin = path.join(root, `${tag}-origin.git`);
  const work = path.join(root, `${tag}-work`);
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  fs.mkdirSync(work, { recursive: true });
  git(root, ["clone", "-q", origin, work]);
  git(work, ["config", "user.email", "org@test"]);
  git(work, ["config", "user.name", "org-test"]);
  git(work, ["config", "core.autocrlf", "false"]); // 同 makeRepo：win32 runner 换行转抈关闭（v0.5.16.1）
  write(work, "a.txt", "v1\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "c1"]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  return { origin, work };
}

/** 工作区是否干净（测试侧直验）。 */
function isClean(repo: string): boolean {
  return git(repo, ["status", "--porcelain"]).stdout.trim().length === 0;
}

/** 当前分支名（测试侧直验）。 */
function branchOf(repo: string): string {
  return git(repo, ["branch", "--show-current"]).stdout.trim();
}

// ---- 1. 状态探测 -----------------------------------------------------------------

describe("gitmerge：gitMergeState 状态探测", () => {
  test("干净仓基线：branch=main、upstream=null、零计数、dirty=false", () => {
    const repo = makeRepo("state-clean");
    const s = gitMergeState(repo);
    expect(s.degraded).toBeUndefined();
    expect(s.repo).toBe(repo);
    expect(s.branch).toBe("main");
    expect(s.upstream).toBeNull();
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.diverged).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.stashed).toBe(0);
  }, 30_000);

  test("ahead：clone 仓本地多一提交（远端未动）→ ahead=1 / behind=0 / diverged=false", () => {
    const { work } = makeCloneRepo("state-ahead");
    write(work, "local.txt", "l\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "local-only"]);
    const s = gitMergeState(work);
    expect(s.degraded).toBeUndefined();
    expect(s.branch).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
    expect(s.diverged).toBe(false);
    expect(s.dirty).toBe(false);
  }, 30_000);

  test("diverged：真实 clone + 远端新提交 + fetch → ahead=1 / behind=1 / upstream=origin/main", () => {
    const { origin, work } = makeCloneRepo("state-diverged");
    // 本地提交（ahead）
    write(work, "local.txt", "l\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "local-only"]);
    // 远端提交（另一 clone 推送，behind）
    const seed = path.join(path.dirname(work), "state-diverged-seed");
    git(path.dirname(work), ["clone", "-q", origin, seed]);
    git(seed, ["config", "user.email", "org@test"]);
    git(seed, ["config", "user.name", "org-test"]);
    write(seed, "remote.txt", "r\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "remote-only"]);
    git(seed, ["push", "-q", "origin", "main"]);
    git(work, ["fetch", "-q", "origin"]);
    // 探测前基线：未 fetch 的口径诚实性见实现文件头；此处 fetch 后断言
    const s = gitMergeState(work);
    expect(s.degraded).toBeUndefined();
    expect(s.branch).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(1);
    expect(s.diverged).toBe(true);
  }, 30_000);

  test("dirty + stash：改跟踪文件 → dirty=true；stash 后 dirty=false + stashed=1", () => {
    const repo = makeRepo("state-dirty");
    write(repo, "a.txt", "line1\nmodified\nline3\n");
    const s1 = gitMergeState(repo);
    expect(s1.dirty).toBe(true);
    expect(s1.stashed).toBe(0);
    git(repo, ["stash"]);
    const s2 = gitMergeState(repo);
    expect(s2.dirty).toBe(false); // stash 收走了改动
    expect(s2.stashed).toBe(1);
    // 未跟踪文件也算 dirty
    write(repo, "new-untracked.txt", "x\n");
    expect(gitMergeState(repo).dirty).toBe(true);
  }, 30_000);

  test("detached HEAD：branch=null 但不算降级（degraded 不设）", () => {
    const repo = makeRepo("state-detached");
    git(repo, ["checkout", "-q", "--detach", "HEAD"]);
    const s = gitMergeState(repo);
    expect(s.branch).toBeNull();
    expect(s.degraded).toBeUndefined(); // detached 是合法状态
    expect(s.dirty).toBe(false);
  }, 30_000);
});

// ---- 2. merge ----------------------------------------------------------------------

describe("gitmerge：gitMerge", () => {
  test("fast-forward：feature 领先 → ok:true + Fast-forward 输出 + 文件落地", () => {
    const repo = makeRepo("merge-ff");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    write(repo, "feat.txt", "feat\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "feat-c"]);
    git(repo, ["checkout", "-q", "main"]);
    const r = gitMerge(repo, { source: "feature" });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.aborted).toBe(false);
    expect(r.output).toContain("Fast-forward");
    expect(fs.existsSync(path.join(repo, "feat.txt"))).toBe(true);
    expect(gitMergeState(repo).dirty).toBe(false);
  }, 30_000);

  test("no-ff + 自定义 message：生成双亲合并提交，log 留痕", () => {
    const repo = makeRepo("merge-noff");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    write(repo, "feat2.txt", "feat2\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "feat2-c"]);
    git(repo, ["checkout", "-q", "main"]);
    const r = gitMerge(repo, { source: "feature", noFf: true, message: "自定义合并信息" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Merge made by"); // ort 策略合并提交
    const log = git(repo, ["log", "-1", "--pretty=%s%n%P"]);
    expect(log.stdout).toContain("自定义合并信息");
    expect(log.stdout.trim().split("\n")[1]!.split(" ").length).toBe(2); // 双亲 = 真合并
  }, 30_000);

  test("Already up to date：合并无新提交的分支 → ok:true", () => {
    const repo = makeRepo("merge-uptodate");
    git(repo, ["checkout", "-q", "-b", "solo"]);
    git(repo, ["checkout", "-q", "main"]);
    const r = gitMerge(repo, { source: "solo" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Already up to date");
  }, 30_000);

  test("冲突：两边改同一行 → conflicts 清单 + aborted:true + 工作区干净 + 内容回到合并前", () => {
    const repo = makeConflictRepo("merge-conflict");
    const r = gitMerge(repo, { source: "feature" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("conflict");
    expect(r.conflicts).toEqual(["a.txt"]);
    expect(r.aborted).toBe(true);
    expect(r.error).toContain("冲突");
    expect(r.error).toContain("绝不自动解决");
    // 工作区干净（abort 恢复到合并前 main 的状态）
    expect(isClean(repo)).toBe(true);
    expect(read(repo, "a.txt")).toBe("line1\nMAIN\nline3\n"); // main 侧原内容
    expect(branchOf(repo)).toBe("main");
  }, 30_000);

  test("多文件冲突：清单完整（两个文件都改）", () => {
    const repo = makeConflictRepo("merge-multi", ["a.txt", "b.txt"]);
    const r = gitMerge(repo, { source: "feature" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("conflict");
    expect(r.conflicts.sort()).toEqual(["a.txt", "b.txt"]);
    expect(r.aborted).toBe(true);
    expect(isClean(repo)).toBe(true);
  }, 30_000);
});

// ---- 3. rebase ----------------------------------------------------------------------

describe("gitmerge：gitRebase", () => {
  test("真变基成功：main 前进后 feature 变基 → ok:true + main 提交入 feature 历史", () => {
    const repo = makeRepo("rebase-ok");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    write(repo, "feat.txt", "feat\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "feat-commit"]);
    git(repo, ["checkout", "-q", "main"]);
    write(repo, "main-side.txt", "m\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main-commit"]);
    git(repo, ["checkout", "-q", "feature"]);
    const r = gitRebase(repo, { onto: "main" });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.output).toContain("Successfully rebased"); // git 2.47 语义
    const log = git(repo, ["log", "--oneline"]).stdout;
    expect(log).toContain("main-commit"); // 变基后包含 main 的新提交
    expect(log).toContain("feat-commit");
  }, 30_000);

  test("rebase 冲突：自动 abort → 冲突清单 + 工作区干净 + 分支/内容回到变基前", () => {
    const repo = makeConflictRepo("rebase-conflict");
    git(repo, ["checkout", "-q", "feature"]);
    const r = gitRebase(repo, { onto: "main" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("conflict");
    expect(r.conflicts).toEqual(["a.txt"]);
    expect(r.aborted).toBe(true);
    expect(isClean(repo)).toBe(true);
    expect(branchOf(repo)).toBe("feature"); // abort 回到原分支
    expect(read(repo, "a.txt")).toBe("line1\nFEATURE\nline3\n"); // feature 侧原内容
  }, 30_000);

  test("rebase 已是最新：feature 基于 main 无分叉 → ok:true（up to date 不动历史）", () => {
    const repo = makeRepo("rebase-uptodate");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    const r = gitRebase(repo, { onto: "main" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("up to date");
    expect(git(repo, ["log", "--oneline"]).stdout.trim().split("\n").length).toBe(1); // 历史未动
  }, 30_000);
});

// ---- 4. 降级与拒绝 -------------------------------------------------------------------

describe("gitmerge：降级与拒绝", () => {
  test("非 repo：gitMergeState 完整结构 + degraded；gitMerge/gitRebase kind:not-repo", () => {
    const dir = path.join(labRoot(), "not-a-repo");
    fs.mkdirSync(dir);
    write(dir, "plain.txt", "x\n");
    const s = gitMergeState(dir);
    expect(s.degraded).toContain("不是 git 仓库");
    expect(s.branch).toBeNull();
    expect(s.upstream).toBeNull();
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.diverged).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.stashed).toBe(0);
    const m = gitMerge(dir, { source: "main" });
    expect(m.ok).toBe(false);
    expect(m.kind).toBe("not-repo");
    const rb = gitRebase(dir, { onto: "main" });
    expect(rb.ok).toBe(false);
    expect(rb.kind).toBe("not-repo");
  }, 30_000);

  test("不存在的目录：degraded + gitMerge not-repo（零子进程执行）", () => {
    const nowhere = path.join(labRoot(), "does-not-exist");
    const s = gitMergeState(nowhere);
    expect(s.degraded).toContain("不存在");
    const m = gitMerge(nowhere, { source: "main" });
    expect(m.ok).toBe(false);
    expect(m.kind).toBe("not-repo");
    expect(m.error).toContain("不存在");
  }, 30_000);

  test("未知分支 merge：internal + git 人读原文透传（not something we can merge）", () => {
    const repo = makeRepo("merge-unknown");
    const r = gitMerge(repo, { source: "no-such-branch" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("internal");
    expect(r.conflicts).toEqual([]);
    expect(r.aborted).toBe(false);
    expect(r.error).toContain("no-such-branch");
    expect(isClean(repo)).toBe(true); // 失败不弄脏工作区
  }, 30_000);

  test("脏树拒并（非冲突 internal）：合并会覆盖未跟踪文件 → git 原文 + 无 abort", () => {
    const repo = makeRepo("merge-dirty");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    write(repo, "z.txt", "tracked\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "z-c"]);
    git(repo, ["checkout", "-q", "main"]);
    write(repo, "z.txt", "local-untracked\n"); // 未跟踪文件挡路
    const r = gitMerge(repo, { source: "feature" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("internal"); // 非冲突 —— 没有未合并路径
    expect(r.aborted).toBe(false);
    expect(r.error).toContain("would be overwritten");
    expect(read(repo, "z.txt")).toBe("local-untracked\n"); // 本地文件原样未动
  }, 30_000);

  test("git 缺席（PATH 收窄）：state 降级 / merge kind:git-missing（try/finally 恢复 PATH）", () => {
    const repo = makeRepo("git-missing");
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = path.join(labRoot(), "empty-bin"); // 不含 git 的目录
      fs.mkdirSync(process.env.PATH, { recursive: true });
      const s = gitMergeState(repo);
      expect(s.degraded).toContain("git 不可用");
      expect(s.branch).toBeNull();
      const m = gitMerge(repo, { source: "main" });
      expect(m.ok).toBe(false);
      expect(m.kind).toBe("git-missing");
      const rb = gitRebase(repo, { onto: "main" });
      expect(rb.ok).toBe(false);
      expect(rb.kind).toBe("git-missing");
    } finally {
      process.env.PATH = savedPath; // 恢复 —— 绝不污染后续用例
    }
    // 恢复后正常（自证 PATH 修复无遗漏）
    expect(gitMergeState(repo).branch).toBe("main");
  }, 30_000);

  test("参数校验：空 source / 空 onto → internal 附人读提示", () => {
    const repo = makeRepo("param-check");
    const m = gitMerge(repo, { source: "  " });
    expect(m.ok).toBe(false);
    expect(m.kind).toBe("internal");
    expect(m.error).toContain("opts.source 必填");
    const rb = gitRebase(repo, { onto: "" });
    expect(rb.ok).toBe(false);
    expect(rb.error).toContain("opts.onto 必填");
  }, 30_000);
});

afterAll(() => {
  // best-effort 清理（失败不炸 —— tmp 目录由操作系统兜底回收）
  for (const r of REPOS) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
  }
  // 预算常量锁定（CI 防漂移）
  expect(GIT_LIMITS.timeoutMs).toBe(30_000);
  expect(GIT_LIMITS.maxOutputChars).toBe(64 * 1024);
});
