// ============================================================================
// lib/gitmerge.ts — merge/rebase 安全操作层（v0.5.16 · capabilities #80）
// ----------------------------------------------------------------------------
// 「让 Agent 帮你合分支，但绝不在冲突里替你做决定」：三个入口 ——
//   · gitMergeState(repo)    只读状态探测（分支 / 上游 / ahead-behind /
//                            diverged / dirty / stash 数；git 缺席或非 repo
//                            → 诚实降级字段 degraded，绝不炸）
//   · gitMerge(repo, {source, message?, noFf?})   合并；冲突时默认自动
//                            `git merge --abort` 保安全（返回冲突文件清单
//                            + aborted:true），绝不自动解决冲突
//   · gitRebase(repo, {onto})                      同哲学，冲突自动
//                            `git rebase --abort`
//
// 【安全哲学】
//   1. 仓外零执行：所有 git 子进程的 cwd 都锚定在调用方给的 repo 目录，且
//      前置校验 repo 存在 .git（文件或目录 —— worktree 的 .git 是文件也算）。
//      不在仓外执行任何 git 写操作；repo 目录不存在 / 非 repo → 结构化拒绝
//      （kind:"not-repo"）或降级字段（gitMergeState）。
//   2. 冲突即回滚：merge/rebase 非零退出且工作区出现未合并路径（git diff
//      --diff-filter=U）→ 判定冲突 → 自动 abort 恢复合并前状态 + 返回冲突
//      文件清单。绝不 add / checkout --ours / 改写冲突标记 —— 冲突的裁决权
//      只属于人（Agent 可以读清单、报告、建议，不能替人合）。
//   3. 非冲突失败（未知分支 / 脏树拒并 / 超时 / git 缺席）原样透传 git 的
//      人读输出，kind 分型：not-repo / git-missing / timeout / internal。
//
// 【子进程预算】每条 git 命令 spawnSync 超时 30s（超时即 kill —— 实测选用
//   node:child_process.spawnSync 而非 Bun.spawnSync：后者的 timeout 选项在
//   bun 1.3.14 实测不生效，进程会跑满全程；node 侧 ETIMEDOUT 语义可靠）。
//   输出（stdout+stderr 合并）截断 64KB，截断处显式标注 —— 永不静默截断。
//   maxBuffer 放宽到 1MB（先让 git 跑完再截，避免 ENOBUFS 中途击杀留下
//   半写状态）。
//
// 【诚实边界】不解析 git 输出做语义判断（除了稳定的 --porcelain /
//   --diff-filter=U 机器面）；上游 / ahead-behind 依赖本地 refs —— 未
//   fetch 时 behind 反映的是上次 fetch 的快照（本模块不主动 fetch —— 网络
//   操作的裁决权属于调用方）；stash 数只数条目不数内容。detached HEAD 是
//   合法状态：branch:null 如实呈现，不算降级。
//
// 【优雅降级铁律】所有导出零逃逸：gitMergeState 任何失败都返回完整结构 +
//   degraded 人读原因；gitMerge / gitRebase 返回 {ok:false, kind, error}，
//   绝不 throw。
// ============================================================================

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- 常量（预算面）----------------------------------------------------------

/** 子进程预算。 */
export const GIT_LIMITS = {
  /** 每条 git 子进程超时（毫秒）—— 超时即 kill。 */
  timeoutMs: 30_000,
  /** 输出截断上限（字符；stdout+stderr 合并后截断，截断处标注）。 */
  maxOutputChars: 64 * 1024,
  /** spawnSync maxBuffer：放宽到 1MB 让 git 跑完再截（防 ENOBUFS 半途击杀）。 */
  maxBufferBytes: 1024 * 1024,
} as const;

// ---- 类型 -------------------------------------------------------------------

/** 只读状态探测结果（git 缺席 / 非 repo 时全部字段仍存在 + degraded 原因）。 */
export interface GitMergeState {
  /** 原样回显的仓库路径。 */
  repo: string;
  /** 当前分支名；detached HEAD → null。 */
  branch: string | null;
  /** 上游跟踪分支（如 origin/main）；无上游 → null。 */
  upstream: string | null;
  /** 本地领先上游的提交数（无上游 / 降级时 0）。 */
  ahead: number;
  /** 本地落后上游的提交数（无上游 / 降级时 0 —— 注意：反映的是上次 fetch 的本地快照）。 */
  behind: number;
  /** ahead>0 且 behind>0。 */
  diverged: boolean;
  /** 工作区或索引有任何未提交改动（含未跟踪文件）。 */
  dirty: boolean;
  /** stash 条目数。 */
  stashed: number;
  /** 降级原因：目录不存在 / 非 git 仓库 / git 不可用 / 探测失败（正常路径 undefined）。 */
  degraded?: string;
}

/** gitMerge / gitRebase 的结构化结果。ok:true = 操作完成（合并 / 变基落
 *  地）；ok:false = 未完成 —— kind 分型：conflict=冲突已自动 abort（安全
 *  回滚，冲突清单在 conflicts）、not-repo、git-missing、timeout、internal
 *  （未知分支 / 脏树拒并等 git 人读原因在 error + output）。 */
export interface GitOpResult {
  ok: boolean;
  /** git 输出（stdout+stderr 合并；截断至 64KB 并标注）。 */
  output: string;
  /** 冲突文件清单（仅 kind:"conflict" 时非空）。 */
  conflicts: string[];
  /** 冲突后是否成功自动 abort（true = 已恢复操作前状态，工作区干净）。 */
  aborted: boolean;
  /** ok:false 时的失败类别。 */
  kind?: "conflict" | "not-repo" | "git-missing" | "timeout" | "internal";
  /** ok:false 时的人读原因（git 原始输出在 output）。 */
  error?: string;
}

/** gitMerge 选项。 */
export interface GitMergeOpts {
  /** 被合并的源分支 / 提交（git merge <source>）。 */
  source: string;
  /** 自定义合并提交信息（git merge -m <message>）；缺省用 git 默认。 */
  message?: string;
  /** 强制生成合并提交（--no-ff，即使可快进）。 */
  noFf?: boolean;
}

/** gitRebase 选项。 */
export interface GitRebaseOpts {
  /** 变基目标分支 / 提交（git rebase <onto>）。 */
  onto: string;
}

// ---- 子进程底座 ----------------------------------------------------------------

/** 一条 git 命令的结果（零逃逸：任何失败都在字段里，绝不 throw）。 */
interface GitRun {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  /** git 二进制缺席（ENOENT）。 */
  gitMissing: boolean;
  /** 超时被 kill。 */
  timedOut: boolean;
}

/** 跑一条 git 命令（cwd 锚定 repo；30s 超时；输出由调用方按需截断）。
 *  env 显式传 {...process.env}：Bun 的 spawnSync 省略 env 选项时会用进程
 *  启动时快照的旧环境（实测无视运行期 process.env.PATH 修改），显式传
 *  副本才与 node:child_process 文档语义一致（调用方对环境的修改生效）。 */
function runGit(repo: string, args: string[]): GitRun {
  try {
    const r = cp.spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: GIT_LIMITS.timeoutMs,
      maxBuffer: GIT_LIMITS.maxBufferBytes,
      windowsHide: true,
      env: { ...process.env },
    });
    if (r.error) {
      const msg = r.error.message;
      if (r.error.code === "ENOENT") {
        return { ok: false, status: -1, stdout: "", stderr: "", gitMissing: true, timedOut: false };
      }
      if (r.error.code === "ETIMEDOUT") {
        return { ok: false, status: -1, stdout: "", stderr: r.stderr ?? "", gitMissing: false, timedOut: true };
      }
      return { ok: false, status: -1, stdout: "", stderr: msg, gitMissing: false, timedOut: false };
    }
    return {
      ok: r.status === 0,
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      gitMissing: false,
      timedOut: false,
    };
  } catch (e) {
    return {
      ok: false, status: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e),
      gitMissing: false, timedOut: false,
    };
  }
}

/** 输出截断（stdout+stderr 合并 → 64KB 帽 + 显式标注，永不静默截断）。 */
function clipOut(stdout: string, stderr: string): string {
  let combined = stdout.replace(/\s+$/, "");
  if (stderr.trim().length > 0) combined += `${combined.length > 0 ? "\n" : ""}[stderr] ${stderr.replace(/\s+$/, "")}`;
  if (combined.length > GIT_LIMITS.maxOutputChars) {
    combined = `${combined.slice(0, GIT_LIMITS.maxOutputChars)}\n…（输出超 64KB 已截断）`;
  }
  return combined;
}

/** 仓库前置校验：目录存在且含 .git（文件或目录 —— worktree 合法）。
 *  通过返回 null；否则返回人读原因（kind:"not-repo"）。 */
function repoGuard(repo: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(repo);
  } catch {
    return `仓库目录不存在：${repo}`;
  }
  if (!st.isDirectory()) {
    return `路径不是目录：${repo}`;
  }
  if (!fs.existsSync(path.join(repo, ".git"))) {
    return `不是 git 仓库（未找到 .git）：${repo}`;
  }
  return null;
}

/** 未合并路径清单（机器面：git diff --name-only --diff-filter=U）。 */
function unmergedFiles(repo: string): string[] {
  const r = runGit(repo, ["diff", "--name-only", "--diff-filter=U"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** rebase 是否在进行中（.git/rebase-merge 或 .git/rebase-apply 存在 ——
 *  经 rev-parse --git-dir 解析，兼容 worktree 的 .git 文件形态）。 */
function rebaseInProgress(repo: string): boolean {
  const r = runGit(repo, ["rev-parse", "--git-dir"]);
  if (!r.ok) return false;
  const gitDir = r.stdout.trim();
  const base = path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir);
  return fs.existsSync(path.join(base, "rebase-merge")) || fs.existsSync(path.join(base, "rebase-apply"));
}

// ---- 状态探测 ------------------------------------------------------------------

/** 探测仓库的合并相关状态（分支 / 上游 / ahead-behind / diverged / dirty /
 *  stash 数）。零逃逸：目录不存在 / 非 repo / git 缺席 / 探测失败 → 完整
 *  结构 + degraded 人读原因（分支与上游为 null、计数为 0）。 */
export function gitMergeState(repo: string): GitMergeState {
  const state: GitMergeState = {
    repo, branch: null, upstream: null, ahead: 0, behind: 0,
    diverged: false, dirty: false, stashed: 0,
  };
  // 1) 仓外守卫（纯文件系统检查，零子进程 —— 快速失败）
  const guard = repoGuard(repo);
  if (guard) return { ...state, degraded: guard };

  // 2) git 可用性（缺席 → 降级，不炸）
  const ver = runGit(repo, ["--version"]);
  if (ver.gitMissing) {
    return { ...state, degraded: "git 不可用：PATH 中未找到 git 可执行文件（请安装 git 或检查 PATH）" };
  }
  if (ver.timedOut) {
    return { ...state, degraded: `git --version 超时（>${GIT_LIMITS.timeoutMs}ms）：环境异常，放弃探测` };
  }
  if (!ver.ok) {
    return { ...state, degraded: `git --version 失败：${clipOut(ver.stdout, ver.stderr)}` };
  }

  // 3) 分支（detached HEAD → 空输出 → null，合法状态不算降级）
  const br = runGit(repo, ["branch", "--show-current"]);
  if (!br.ok) {
    return { ...state, degraded: `分支探测失败：${clipOut(br.stdout, br.stderr)}` };
  }
  const branch = br.stdout.trim();
  state.branch = branch.length > 0 ? branch : null; // detached HEAD

  // 4) 上游（无上游是合法状态 → null）
  const up = runGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (up.ok) {
    const upstream = up.stdout.trim();
    if (upstream.length > 0 && upstream !== "@{upstream}") state.upstream = upstream;
  }

  // 5) ahead/behind（左=HEAD 独有=ahead，右=upstream 独有=behind；实测语义）
  if (state.upstream) {
    const lr = runGit(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (lr.ok) {
      const m = lr.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) {
        state.ahead = Number(m[1]);
        state.behind = Number(m[2]);
      }
    }
  }
  state.diverged = state.ahead > 0 && state.behind > 0;

  // 6) 脏树（含未跟踪文件）
  const st = runGit(repo, ["status", "--porcelain"]);
  state.dirty = st.ok && st.stdout.trim().length > 0;

  // 7) stash 条目数
  const sl = runGit(repo, ["stash", "list"]);
  if (sl.ok) {
    state.stashed = sl.stdout.split("\n").filter((l) => l.trim().length > 0).length;
  }
  return state;
}

// ---- 冲突处置（merge/rebase 共用）-----------------------------------------------

/** 冲突判定 + 自动 abort。unmerged 非空即冲突 → 跑 abortCmd 恢复；返回
 *  冲突清单与 abort 结果。绝不触碰冲突内容本身。 */
function settleConflict(repo: string, abortArgs: string[]): { conflicts: string[]; aborted: boolean; abortError?: string } {
  const conflicts = unmergedFiles(repo);
  if (conflicts.length === 0) return { conflicts, aborted: false };
  const ab = runGit(repo, abortArgs);
  const still = unmergedFiles(repo);
  if (ab.ok && still.length === 0) return { conflicts, aborted: true };
  return {
    conflicts,
    aborted: false,
    abortError: `自动 ${abortArgs.join(" ")} 失败：${clipOut(ab.stdout, ab.stderr)} —— 工作区可能仍处于冲突态（${still.length} 个未合并文件），需人工处理`,
  };
}

/** gitMerge / gitRebase 的公共失败包装。 */
function fail(kind: NonNullable<GitOpResult["kind"]>, error: string, output = ""): GitOpResult {
  return { ok: false, output, conflicts: [], aborted: false, kind, error };
}

// ---- merge / rebase --------------------------------------------------------------

/** 合并 source 到当前分支。冲突时自动 `git merge --abort` 恢复（返回冲突
 *  清单 + aborted:true，绝不自动解决冲突）；非冲突失败原样透传 git 人读
 *  输出。绝不抛异常。 */
export function gitMerge(repo: string, opts: GitMergeOpts): GitOpResult {
  // 参数校验（调用方错误 → internal，附人读提示）
  const source = typeof opts?.source === "string" ? opts.source.trim() : "";
  if (source.length === 0) {
    return fail("internal", "opts.source 必填（被合并的分支 / 提交）");
  }
  // 仓外守卫 + git 可用性
  const guard = repoGuard(repo);
  if (guard) return fail("not-repo", guard);
  const ver = runGit(repo, ["--version"]);
  if (ver.gitMissing) return fail("git-missing", "git 不可用：PATH 中未找到 git 可执行文件");
  if (ver.timedOut) return fail("timeout", `git --version 超时（>${GIT_LIMITS.timeoutMs}ms）`);

  const args = ["merge"];
  if (opts.noFf) args.push("--no-ff");
  if (opts.message !== undefined && opts.message !== null && `${opts.message}`.trim().length > 0) {
    args.push("-m", `${opts.message}`);
  }
  args.push(source);

  const r = runGit(repo, args);
  const output = clipOut(r.stdout, r.stderr);
  if (r.ok) return { ok: true, output, conflicts: [], aborted: false };
  if (r.timedOut) {
    return fail(
      "timeout",
      `git merge 超时（>${GIT_LIMITS.timeoutMs}ms）已击杀 —— 若留下半合并状态请人工 git merge --abort`,
      output,
    );
  }
  // 冲突判定：工作区出现未合并路径 → 自动 abort 保安全
  const settled = settleConflict(repo, ["merge", "--abort"]);
  if (settled.conflicts.length > 0) {
    return {
      ok: false, output, conflicts: settled.conflicts, aborted: settled.aborted,
      kind: "conflict",
      error: settled.aborted
        ? `合并冲突：${settled.conflicts.length} 个文件（${settled.conflicts.slice(0, 5).join("、")}${settled.conflicts.length > 5 ? " 等" : ""}）—— 已自动 git merge --abort 恢复合并前状态，冲突需人工裁决（绝不自动解决）`
        : settled.abortError!,
    };
  }
  // 非冲突失败（未知分支 / 脏树拒并 / 拒绝合并不相关历史…）：原样透传
  return fail("internal", `git merge 失败（非冲突）：${output || "无输出"}`, output);
}

/** 把当前分支变基到 onto。冲突时自动 `git rebase --abort` 恢复（返回冲突
 *  清单 + aborted:true，绝不自动解决冲突）；rebase 中途停住但无未合并路径
 *  的罕见态（如空提交停机）也会尝试 abort 保安全。绝不抛异常。 */
export function gitRebase(repo: string, opts: GitRebaseOpts): GitOpResult {
  const onto = typeof opts?.onto === "string" ? opts.onto.trim() : "";
  if (onto.length === 0) {
    return fail("internal", "opts.onto 必填（变基目标分支 / 提交）");
  }
  const guard = repoGuard(repo);
  if (guard) return fail("not-repo", guard);
  const ver = runGit(repo, ["--version"]);
  if (ver.gitMissing) return fail("git-missing", "git 不可用：PATH 中未找到 git 可执行文件");
  if (ver.timedOut) return fail("timeout", `git --version 超时（>${GIT_LIMITS.timeoutMs}ms）`);

  const r = runGit(repo, ["rebase", onto]);
  const output = clipOut(r.stdout, r.stderr);
  if (r.ok) return { ok: true, output, conflicts: [], aborted: false };
  if (r.timedOut) {
    return fail(
      "timeout",
      `git rebase 超时（>${GIT_LIMITS.timeoutMs}ms）已击杀 —— 若留下变基中状态请人工 git rebase --abort`,
      output,
    );
  }
  // 冲突判定 + abort（未合并路径为准；无未合并但 rebase 目录仍在 → 也 abort）
  const settled = settleConflict(repo, ["rebase", "--abort"]);
  if (settled.conflicts.length > 0) {
    return {
      ok: false, output, conflicts: settled.conflicts, aborted: settled.aborted,
      kind: "conflict",
      error: settled.aborted
        ? `变基冲突：${settled.conflicts.length} 个文件（${settled.conflicts.slice(0, 5).join("、")}${settled.conflicts.length > 5 ? " 等" : ""}）—— 已自动 git rebase --abort 恢复变基前状态，冲突需人工裁决（绝不自动解决）`
        : settled.abortError!,
    };
  }
  if (rebaseInProgress(repo)) {
    // 罕见：rebase 停住但无未合并路径（空提交停机等）→ abort 保安全
    const ab = runGit(repo, ["rebase", "--abort"]);
    if (ab.ok) {
      return {
        ok: false, output, conflicts: [], aborted: true, kind: "internal",
        error: `变基中途停止（非冲突形态）：已自动 git rebase --abort 恢复 —— ${output || "无输出"}`,
      };
    }
    return {
      ok: false, output, conflicts: [], aborted: false, kind: "internal",
      error: `变基中途停止且 abort 失败，工作区可能仍处于变基态：${clipOut(ab.stdout, ab.stderr)}`,
    };
  }
  // 非冲突失败（未知 onto / 脏树拒并 / 已是最新…）：原样透传
  return fail("internal", `git rebase 失败（非冲突）：${output || "无输出"}`, output);
}
