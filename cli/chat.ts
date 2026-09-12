// ============================================================================
// org/cli/chat.ts — 交互式聊天 REPL（v0.4.15）
// ----------------------------------------------------------------------------
// 主流 Agent（codex / opencode / zcode）的核心交互面：org chat <expert>
//   - 多轮交互对话（会话史跨轮织入提示词 —— 复用直连池全部治理：
//     事件上总线 · 花销记账 · 会话账本 · 纪要回写，零旁路）
//   - 流式渲染：宿主流式车道（llm-stream.jsonl）逐 token 输出；
//     reasoning 通道显示思考指示器（◈ thinking · N chars）
//   - 斜杠命令：/help /exit /model /expert /new /sessions /resume /status
//     /ctx /history /retry /compact /clear
//   - !cmd shell 逃逸（用户发起 · 用户可见 · 不经 harness 能力面）
//   - Ctrl+C 取消当前轮（SIGTERM 子进程，本轮不落账本）；连按两次退出
//   - ↑↓ 历史导航（readline 原生 + 跨会话持久 runtime/chat-history.txt）
//   - /compact 上下文压缩：LLM 摘要会话史 → 重写账本（备份可回滚）
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { startRun, loadRegistryIndex, expertFixtureOf, renderContextMeter } from "../lib/engine.ts";
import { listApprovals, decideApproval } from "../lib/approvals.ts";
import {
  scanWorkspace, latestScorecardDir, readScorecard, reviewCandidates,
  latestHarnessRunDir, setRetained, forkSession, revertExpert, archivedVersions,
} from "../lib/engine.ts";
import { ORG_VERSION } from "../lib/version.ts";

const CONTEXT_WINDOW = 131072; // 与 direct.hsl / engine.ts 同源的窗口口径
const HISTORY_FILE = "runtime/chat-history.txt";
const HISTORY_CAP = 500;

// ---------- 会话账本（runtime/sessions/<expert>/<session>.jsonl） ----------

import {
  readSession, latestSession, compactLedger, listSessionIds,
  type LedgerTurn,
} from "../lib/sessions.ts";

/** 账本轮次。v0.5.0：解析统一到 lib/sessions.ts —— 三份实现会静默分歧
 *  （例如 Web 此前不解析 compacted，把压缩摘要当普通轮次渲染）。 */
export type SessionTurn = LedgerTurn;
// 再导出：本模块既有的 import 路径与 tests/chat.test.ts 保持不变
export { readSession, latestSession, compactLedger };

/** 列专家的全部会话（mtime 降序；/sessions 与 org sessions 共用）。
 *  解析与容错在 lib/sessions.ts；这里的展示选择是「预取最近问题」。 */
export function listSessions(ws: string, expert: string): SessionSummary[] {
  return listSessionIds(ws, expert).map(({ id, turns, mtimeMs }) => {
    const last = turns[turns.length - 1]!;
    return {
      expert,
      session: id,
      turns: turns.length,
      tokens: turns.reduce((sum, t) => sum + t.tokens, 0),
      ctx_tokens: last.ctx_tokens,
      lastQuestion: last.question.slice(0, 48),
      mtimeMs,
    };
  });
}

// ---------- 斜杠命令解析（可测单元） ----------

export interface ParsedInput {
  kind: "question" | "slash" | "shell" | "empty";
  command: string;     // slash：命令名（不含 /）
  arg: string;         // slash：参数；shell：整条命令
  question: string;    // question：问题正文
}

/** 用户输入解析：/cmd arg → slash；!cmd → shell；空 → empty；其余 → question。 */
export function parseInput(raw: string): ParsedInput {
  const line = raw.replace(/\s+$/, "");
  if (line.trim().length === 0) return { kind: "empty", command: "", arg: "", question: "" };
  if (line.startsWith("/")) {
    const sp = line.indexOf(" ");
    const command = sp < 0 ? line.slice(1) : line.slice(1, sp);
    const arg = sp < 0 ? "" : line.slice(sp + 1).trim();
    return { kind: "slash", command: command.toLowerCase(), arg, question: "" };
  }
  if (line.startsWith("!")) {
    return { kind: "shell", command: "", arg: line.slice(1).trim(), question: "" };
  }
  return { kind: "question", command: "", arg: "", question: line };
}

// ---------- REPL 主体 ----------

interface ChatOpts {
  workspace: string;
  expert: string;
  session: string;
  model: string;
  cont: boolean; // --continue：接续专家最近会话
}

const isTTY = process.stdout.isTTY === true;
const dim = (s: string): string => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string): string => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s: string): string => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const amber = (s: string): string => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
// 成功/失败两色（v0.5.0 补：审批与治理类命令用到，此前只在别处用 dim/cyan/amber
// —— 漏定义会让整条命令抛 ReferenceError，而斜杠命令不在既有测试覆盖内）
const green = (s: string): string => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string): string => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);

function clearLine(): void {
  if (isTTY) process.stdout.write("\r\x1b[K");
  else process.stdout.write("\n");
}

/** 入口：org chat [expert] [--session id] [--model m] [--continue]。 */
export async function chatMain(argv: string[]): Promise<number> {
  // 用户配置注入（独立入口 bun cli/chat.ts 直跑也享受 org config；
  // 经 org.ts 进入时 main() 已注入，此处幂等填空不重复覆盖）
  const { applyConfigToEnv } = await import("../lib/config.ts");
  applyConfigToEnv();
  let expert = "";
  let session = "";
  let model = "scripted";
  let modelExplicit = false;
  let workspace = "";
  let cont = false;
  let i = 0;
  while (i < argv.length) {
    const v = argv[i]!;
    if (v === "--session") session = argv[++i] ?? "";
    else if (v === "--model") { model = argv[++i] ?? "scripted"; modelExplicit = true; }
    else if (v === "--workspace") workspace = path.resolve(argv[++i] ?? ".");
    else if (v === "--continue" || v === "-c") cont = true;
    else if (v.length > 0 && !v.startsWith("--")) expert = v;
    i++;
  }
  // 缺省车道（org config set default_lane deepseek）：未显式 --model 时接管
  if (!modelExplicit && (process.env.ORG_DEFAULT_MODEL ?? "").trim().length > 0) {
    model = process.env.ORG_DEFAULT_MODEL!.trim();
  }
  if (!workspace) {
    const { DEFAULT_WORKSPACE } = await import("../lib/root.ts");
    workspace = DEFAULT_WORKSPACE;
  }
  // 专家缺省：取注册表首个保留专家（★）—— codex 缺省 agent 同构
  if (!expert) {
    const retained = loadRegistryIndex(workspace).filter((m) => m.retained === true);
    if (retained.length === 0) {
      console.error("✗ 注册表无保留专家：org chat <expert>（org status 查看 · org keep 选取）");
      return 2;
    }
    expert = retained[0]!.name;
    console.log(dim(`ℹ 未指定专家 → 取首个保留专家 ${expert}（/expert 切换）`));
  } else {
    const hit = loadRegistryIndex(workspace).find((m) => m.name === expert);
    if (!hit) {
      console.error(`✗ 专家 ${expert} 不在注册表（org status 查看）`);
      return 2;
    }
  }
  if (!session) session = cont ? latestSession(workspace, expert) : "default";

  const state = { expert, session, model, workspace };
  printBanner(state);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${cyan("you⟩ ")}${dim(`[${expert}]`)} `,
    historySize: HISTORY_CAP,
  });
  // 跨会话历史持久化（↑↓ 导航含历史会话的问题）
  const histFile = path.join(workspace, HISTORY_FILE);
  try {
    const hist = fs.readFileSync(histFile, "utf-8").split("\n").filter((l) => l.length > 0);
    if (hist.length > 0) (rl as unknown as { history: string[] }).history = hist.slice(-HISTORY_CAP);
  } catch { /* 首次无历史 */ }
  const pushHistory = (line: string): void => {
    try {
      const prev = fs.existsSync(histFile) ? fs.readFileSync(histFile, "utf-8") : "";
      const lines = prev.split("\n").filter((l) => l.length > 0);
      lines.push(line);
      fs.mkdirSync(path.dirname(histFile), { recursive: true });
      fs.writeFileSync(histFile, lines.slice(-HISTORY_CAP).join("\n") + "\n", "utf-8");
    } catch { /* 历史持久化失败不炸会话 */ }
  };

  let lastQuestion = "";
  let running = false;
  let lastSigint = 0;

  // 输入串行泵（readline 异步陷阱修复）：line 事件不等待 async 处理器完成
  // —— 管道/粘贴多行输入时事件会交织，轮次被跳过。队列 + busy 标志保证
  // 上一行（含整轮对话）完全落地后才处理下一行。
  const inputQueue: string[] = [];
  let pumping = false;
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (inputQueue.length > 0) {
        const raw = inputQueue.shift()!;
        await handleLine(raw);
      }
    } finally {
      pumping = false;
    }
    if (!rl.closed) rl.prompt();
  };
  rl.on("line", (raw: string) => {
    inputQueue.push(raw);
    void pump();
  });

  rl.on("SIGINT", () => {
    if (running) {
      // Ctrl+C：取消当前轮（SIGTERM 子进程；本轮未落账本）
      console.log(dim("\n⟲ 已请求取消当前轮（本轮不落账本）…"));
    } else if (pumping) {
      // 队列处理中（非运行轮）：清空待处理队列
      const dropped = inputQueue.length;
      inputQueue.length = 0;
      console.log(dim(`\n⟲ 已跳过待处理的 ${dropped} 行输入`));
    } else {
      const now = Date.now();
      if (now - lastSigint < 2000) { rl.close(); return; }
      lastSigint = now;
      console.log(dim("（再按一次 Ctrl+C 或 /exit 退出）"));
      rl.prompt();
    }
  });

  /** 单行处理（问题/命令/逃逸/空）—— 串行泵内调用。 */
  const handleLine = async (raw: string): Promise<void> => {
    let line = raw;
    // 反斜杠续行（多行输入）
    while (line.endsWith("\\") && !line.endsWith("\\\\")) {
      line = line.slice(0, -1);
      const more = await new Promise<string>((res) => rl.question(dim("…⟩ "), (a: string) => res(a)));
      line += "\n" + more;
    }
    const parsed = parseInput(line);
    if (parsed.kind === "empty") return;
    if (parsed.kind === "shell") {
      const cmd = parsed.arg;
      if (cmd.length === 0) return;
      console.log(dim(`! ${cmd}`));
      try {
        const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit" });
        await proc.exited;
      } catch (e) {
        console.error(`✗ ${(e as Error).message}`);
      }
      return;
    }
    if (parsed.kind === "slash") {
      await handleSlash(state, rl, parsed.command, parsed.arg, () => lastQuestion);
      if (parsed.command === "exit" || parsed.command === "quit" || parsed.command === "q") {
        rl.close();
        return;
      }
      if (parsed.command === "retry") printStatusLine(state);
      return;
    }
    // 普通问题：跑一轮直连（治理全保留）
    lastQuestion = parsed.question;
    pushHistory(parsed.question);
    running = true;
    rl.pause();
    try {
      await runTurn(state, parsed.question);
    } finally {
      running = false;
    }
    printStatusLine(state);
  };

  rl.on("close", () => {
    console.log(dim("\n再见 —— 会话账本已保留（org chat --continue 接续）"));
    process.exit(0);
  });

  rl.prompt();
  return new Promise<number>(() => { /* REPL 常驻：rl close 时 process.exit */ });
}

function printBanner(state: ChatOpts): void {
  const turns = readSession(state.workspace, state.expert, state.session);
  const ctx = turns.length > 0 ? turns[turns.length - 1]!.ctx_tokens : 0;
  console.log(`${bold(`ORG — Organization Harness v${ORG_VERSION}`)} ${dim("· chat")}`);
  console.log(dim(`专家 ${state.expert} · 会话 ${state.session}（${turns.length} 轮） · 模型 ${state.model} · ${path.basename(state.workspace)}`));
  if (ctx > 0) console.log(dim(`ctx ${renderContextMeter({ context: ctx, window: CONTEXT_WINDOW })}`));
  console.log(dim(`问题直接输入 · /help 命令 · !cmd 逃逸 · Ctrl+C 取消当前轮 · Ctrl+D 退出`));
  console.log();
}

function printStatusLine(state: ChatOpts): void {
  const turns = readSession(state.workspace, state.expert, state.session);
  if (turns.length > 0) {
    const last = turns[turns.length - 1]!;
    console.log(dim(`  ${state.expert} · turn ${last.turn} · ctx ${renderContextMeter({ context: last.ctx_tokens, window: CONTEXT_WINDOW })}`));
  }
}

// ---------- 斜杠命令执行（返回 true = 已处理并打印） ----------

type SlashCtx = { lastQuestion: () => string };

async function handleSlash(state: ChatOpts, rl: readline.Interface, command: string, arg: string, ctxSource: SlashCtx): Promise<boolean> {
  switch (command) {
    case "help":
    case "h":
    case "?":
      console.log(`${bold("命令")}：
  /help                本帮助
  /model [m]           查看/切换模型（scripted | deepseek）
  /expert [name]       查看/切换专家（无参列出注册表）
  /new [id]            新会话（缺省 s-<时间戳>）
  /sessions            列出本专家全部会话（轮次 · tokens · 最近问题）
  /resume <id>         切换到指定会话
  /status              专家档案 + 当前会话统计
  /ctx                 上下文窗口占用
  /history             当前会话轮次回放（问题 → 回答首行）
  /retry               重问上一问题
  /compact             上下文压缩（LLM 摘要会话史 → 重写账本，备份可回滚）
  /approvals           交互式审批队列（/approve <id> · /always <id> · /deny <id>）
  /runs                运行产物列表（团队派单的产物；回放走 org replay）
  /score [轴|任务类]    评分卡（证据归因；双轴匹配）
  /review              运行范围复核：本次产出的 harness 待决策候选
  /keep <名> /drop <名> 工具库治理：选取保留 / 取消保留
  /fork [新 id]        会话派生（账本复制即分叉，原会话不变）
  /undo [版本]         版本回退（归档源还原为在岗源，可逆）
  /clear               清屏
  /exit /quit /q       退出（Ctrl+D 同）
  !<cmd>               shell 逃逸（用户发起 · 结果直接可见）`);
      return true;
    case "model": {
      if (arg.length > 0) {
        if (arg !== "scripted" && arg !== "deepseek") {
          console.log(amber(`? 未知模型 ${arg}（可选 scripted | deepseek）`));
          return true;
        }
        state.model = arg;
        console.log(dim(`⟳ 模型 → ${arg}`));
        return true;
      }
      console.log(`模型：${bold(state.model)}${state.model === "deepseek" ? dim("（网关 DHV_LLM_GATEWAY · 流式渲染）") : dim("（剧本 · 秒回）")}`);
      return true;
    }
    case "expert": {
      if (arg.length > 0) {
        const hit = loadRegistryIndex(state.workspace).find((m) => m.name === arg);
        if (!hit) {
          console.log(amber(`? 专家 ${arg} 不在注册表`));
          return true;
        }
        state.expert = arg;
        state.session = latestSession(state.workspace, arg);
        console.log(dim(`⟳ 专家 → ${arg} · 会话 ${state.session}`));
        printBanner(state);
        return true;
      }
      const experts = loadRegistryIndex(state.workspace);
      console.log(bold("注册表："));
      for (const m of experts) {
        const mark = m.retained === true ? "★" : m.source === "import" ? "◆" : "○";
        console.log(`  ${mark} ${m.name}${dim(`@${m.version} · ${String(m.source)}`)}`);
      }
      return true;
    }
    case "new": {
      state.session = arg.length > 0 ? arg : `s-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 17)}`;
      console.log(dim(`⟳ 新会话 ${state.session}（/resume 切回）`));
      printBanner(state);
      return true;
    }
    case "sessions": {
      const list = listSessions(state.workspace, state.expert);
      if (list.length === 0) { console.log(dim("（无会话）")); return true; }
      console.log(bold(`${state.expert} 的会话（mtime 降序）：`));
      for (const s of list) {
        const mark = s.session === state.session ? cyan("▸") : " ";
        console.log(`  ${mark} ${s.session.padEnd(20)} ${String(s.turns).padStart(3)} 轮 · ${String(s.tokens).padStart(7)} tok · ctx ${renderContextMeter({ context: s.ctx_tokens, window: CONTEXT_WINDOW })}`);
        console.log(`      ${dim(`↳ ${s.lastQuestion}`)}`);
      }
      return true;
    }
    case "resume": {
      if (arg.length === 0) { console.log(amber("? 用法：/resume <session-id>（/sessions 查看）")); return true; }
      state.session = arg;
      console.log(dim(`⟳ 会话 → ${arg}`));
      printBanner(state);
      return true;
    }
    case "status": {
      const hit = loadRegistryIndex(state.workspace).find((m) => m.name === state.expert);
      const turns = readSession(state.workspace, state.expert, state.session);
      const tokens = turns.reduce((s, t) => s + t.tokens, 0);
      console.log(bold(`专家档案`));
      if (hit) {
        console.log(`  名称    ${hit.name}@${hit.version}`);
        console.log(`  来源    ${String(hit.source)} ${hit.retained === true ? "★ 保留" : "○ 候选"}`);
        const cap = hit.capabilities;
        if (Array.isArray(cap)) console.log(`  能力    ${cap.join(", ")}`);
        const desc = String(hit.description ?? "");
        if (desc.length > 0) console.log(`  描述    ${desc.slice(0, 72)}${desc.length > 72 ? "…" : ""}`);
      }
      console.log(bold(`当前会话`));
      console.log(`  会话    ${state.session} · ${turns.length} 轮 · 累计 ${tokens} tokens`);
      if (turns.length > 0) {
        const last = turns[turns.length - 1]!;
        console.log(`  ctx     ${renderContextMeter({ context: last.ctx_tokens, window: CONTEXT_WINDOW })}`);
        if (last.compacted) console.log(dim(`  （已压缩：原 ${last.compacted_from} 轮）`));
      }
      console.log(`  模型    ${state.model} · 工作区 ${path.basename(state.workspace)}`);
      return true;
    }
    case "ctx": {
      const turns = readSession(state.workspace, state.expert, state.session);
      const ctx = turns.length > 0 ? turns[turns.length - 1]!.ctx_tokens : 0;
      console.log(`ctx ${renderContextMeter({ context: ctx, window: CONTEXT_WINDOW })}${turns.length > 0 ? dim(` · ${turns.length} 轮`) : dim(" · 新会话")}`);
      return true;
    }
    case "history": {
      const turns = readSession(state.workspace, state.expert, state.session);
      if (turns.length === 0) { console.log(dim("（新会话 · 无轮次）")); return true; }
      for (const t of turns) {
        const tag = t.compacted ? amber(`[compact ×${t.compacted_from}]`) : cyan(`[turn ${t.turn}]`);
        console.log(`${tag} ${t.question.split("\n")[0]!.slice(0, 60)}`);
        console.log(dim(`      ↳ ${t.answer.split("\n")[0]!.slice(0, 72)}${t.answer.split("\n")[0]!.length > 72 ? "…" : ""}`));
      }
      return true;
    }
    case "retry": {
      const q = ctxSource.lastQuestion();
      if (q.length === 0) { console.log(amber("? 没有可重试的问题")); return true; }
      console.log(dim(`⟲ 重试：${q.slice(0, 60)}${q.length > 60 ? "…" : ""}`));
      await runTurn(state, q);
      return true;
    }
    case "compact": {
      await runCompact(state);
      return true;
    }
    case "approvals": {
      // 交互式审批队列（文件协议）：与 CLI / TUI / Web 同一实现（lib/approvals.ts）
      const view = listApprovals(state.workspace);
      if (view.pending.length === 0) {
        const g = view.granted.length > 0 ? " · 长期放行集：" + view.granted.join(", ") : "";
        console.log(green("✓ 没有待批准的项") + dim(g));
        return true;
      }
      console.log(bold("待批准 " + view.pending.length + " 项"));
      for (const p of view.pending) {
        console.log("  " + p.id + "  [" + p.capability + "]");
        console.log("     " + p.action);
      }
      console.log(dim("放行 /approve <id> · 长期 /always <id> · 拒绝 /deny <id>"));
      return true;
    }
    case "approve":
    case "always":
    case "deny": {
      const parts = raw.trim().split(" ").filter(function (x) { return x.length > 0; });
      const id = parts[1] ?? "";
      if (!id) {
        console.log(amber("用法：/approve <审批 id>（/approvals 查看待批准）"));
        return true;
      }
      const allow = command !== "deny";
      const r = decideApproval(state.workspace, id, allow, command === "always", "chat");
      console.log(r.ok
        ? (allow ? green("✓ 已放行 " + id + (command === "always" ? "（长期放行）" : "")) : red("✗ 已拒绝 " + id))
        : amber("✗ " + r.error));
      return true;
    }
    case "runs": {
      // 运行产物列表（TUI 会话栏 / Web 侧栏 runs 的 chat 面）
      const info = scanWorkspace(state.workspace);
      if (info.sessions.length === 0) {
        console.log(dim("暂无运行产物（团队派单即产生；本 REPL 是直连通道）"));
        return true;
      }
      console.log(bold("运行产物 " + info.sessions.length + " 个"));
      for (const r of info.sessions.slice(0, 12)) {
        const mark = r.ok ? green("ok  ") : red("fail");
        console.log("  " + mark + " " + r.name + "  " + (r.elapsed_ms / 1000).toFixed(1) + "s  " + dim((r.task || "").slice(0, 34)));
      }
      console.log(dim("回放：org replay --run <workspace>/<name>"));
      return true;
    }
    case "score": {
      const dir = latestScorecardDir(state.workspace);
      if (!dir) { console.log(amber("尚无评分卡（先派单或 org demo）")); return true; }
      const card = readScorecard(dir);
      if (!card) { console.log(red("评分卡读取失败")); return true; }
      const want = (arg ?? "").trim();
      const cells = !want
        ? card.cells
        : card.cells.filter((c) => c.cell.startsWith(want + "|") || c.cell.endsWith("|" + want));
      if (want && cells.length === 0) {
        const axes = [...new Set(card.cells.map((c) => c.cell.split("|")[0]))].slice(0, 8);
        console.log(amber("无匹配单元「" + want + "」· 可用能力轴：" + axes.join(" / ")));
        return true;
      }
      console.log(bold("评分卡 " + card.model + " · 证据 " + card.evidence_count + " 条 · " + dir));
      for (const c of cells) {
        console.log("  " + c.cell.padEnd(42) + c.score.toFixed(3) + dim("  置信 " + c.confidence.toFixed(2)));
      }
      return true;
    }
    case "review": {
      // 运行范围复核（工具库治理第四动作）：列表 + 指路。逐项交互选取在
      // org review（那张表与 parseSelection 是 CLI 的强项，REPL 里塞表格反而难用）
      const dir = latestHarnessRunDir(state.workspace);
      if (!dir) { console.log(amber("尚无运行产物（先团队派单）")); return true; }
      const plan = reviewCandidates(state.workspace, dir);
      if (!plan.scope) { console.log(red("运行产物读取失败")); return true; }
      if (plan.pending.length === 0) {
        console.log(green("✓ 本次运行没有待决策候选") + dim(" · " + plan.scope.label));
        return true;
      }
      console.log(bold("本次运行（" + plan.scope.label + "）待决策候选 " + plan.pending.length + " 个"));
      for (const c of plan.pending) {
        console.log("  " + c.name + "@" + c.version + "  [" + c.source + "]  " + dim(c.description.slice(0, 40)));
      }
      console.log(dim("选取：org review（交互）或 /keep <名> / /drop <名>"));
      return true;
    }
    case "keep": case "drop": {
      const name = (arg ?? "").trim();
      if (!name) { console.log(amber("用法：/" + command + " <专家名>")); return true; }
      const retained = command === "keep";
      const r = setRetained(state.workspace, [name], retained);
      if (r.kept.length > 0) {
        console.log(retained ? green("★ 已保留 " + name) : amber("○ 已取消保留 " + name));
        console.log(dim("（写入 runtime 外的 registry，并 git 留痕；对下一轮派单生效）"));
      }
      if (r.missing.length > 0) console.log(red("注册表中未找到：" + name));
      return true;
    }
    case "fork": {
      // 会话派生：账本复制即分叉（对应 codex/opencode 的 /fork）
      const to = (arg ?? "").trim() || (state.session + "-f" + Date.now().toString(36).slice(-4));
      try {
        const r = forkSession(state.workspace, state.expert, state.session, to);
        console.log(green("⑂ 已派生 " + r.expert + "/" + r.from + " → " + r.to) + dim("（" + r.turns + " 轮上下文）"));
        console.log(dim("切过去继续：/resume " + r.to));
      } catch (e) {
        console.log(red("派生失败：" + (e as Error).message));
      }
      return true;
    }
    case "undo": {
      // 版本回退：把归档源还原为在岗源（当前源先归档 → 可逆）。对应 opencode /undo
      try {
        const vers = archivedVersions(state.workspace, state.expert);
        const r = revertExpert(state.workspace, state.expert, (arg ?? "").trim() || undefined);
        console.log(green("↩ 已回退 " + r.name + "：" + r.from + " → " + r.to));
        if (r.archived) console.log(dim("  当前源已归档（回退可逆）· 其它可回退版本：" + vers.filter((v) => v !== r.to).join(", ")));
      } catch (e) {
        console.log(amber("回退不可用：" + (e as Error).message));
      }
      return true;
    }
    case "clear": {
      if (isTTY) process.stdout.write("\x1b[2J\x1b[H");
      printBanner(state);
      return true;
    }
    case "exit":
    case "quit":
    case "q":
      // 退出（调用方 rl.close；此处静默）
      return true;
    default:
      console.log(amber(`? 未知命令 /${command}（/help 查看）`));
      return true;
  }
}

// ---------- 一轮对话（直连池全治理 + 流式渲染） ----------

async function runTurn(state: ChatOpts, question: string): Promise<void> {
  const t0 = Date.now();
  const handle = startRun({
    entry: "direct",
    task: question,
    workspace: state.workspace,
    model: state.model as "scripted" | "deepseek",
    expert: state.expert,
    session: state.session,
    // fixture 省略 → 导入剧本自动发现（scripted 零摩擦）；deepseek 不用剧本
    fixture: state.model === "scripted" ? (expertFixtureOf(state.workspace, state.expert) ?? undefined) : undefined,
  });
  let streamed = false;      // 已流式输出正文
  let reasoningChars = 0;
  let thinkingShown = false;
  for await (const ev of handle.events) {
    if (ev.kind === "llm_delta") {
      if (ev.channel === "reasoning") {
        // 思考指示器（推理型模型）：正文未开始前单行刷新
        reasoningChars += ev.delta.length;
        if (!streamed) {
          process.stdout.write(`\r${dim(`◈ thinking · ${reasoningChars} chars`)}\x1b[K`);
          thinkingShown = true;
        }
      } else if (ev.channel === "reset") {
        // 流重置（重试车道）：清除已渲染正文重新开始
        if (streamed) {
          clearLine();
          process.stdout.write("\n");
          console.log(dim("⟲ 网关重试，重新流式 …"));
        }
        streamed = false;
        reasoningChars = 0;
        thinkingShown = false;
      } else {
        if (thinkingShown) { clearLine(); thinkingShown = false; }
        if (!streamed) {
          process.stdout.write(`${amber(`${state.expert}⟩`)} `);
          streamed = true;
        }
        process.stdout.write(ev.delta);
      }
    } else if (ev.kind === "run_result") {
      if (ev.canceled) {
        if (thinkingShown || streamed) clearLine();
        console.log(dim("○ 本轮已取消（未落账本 · /retry 重问）"));
        return;
      }
      if (!ev.ok) {
        if (thinkingShown || streamed) clearLine();
        console.log(amber(`✗ 本轮失败：${(ev.error ?? "").split("\n").slice(-3).join(" / ").slice(0, 160)}`));
        console.log(dim("  （账本未动 · /retry 重试 · /model 换模型）"));
        return;
      }
      // 收尾：未流式（scripted / 无网关）则整段打印
      const turns = readSession(state.workspace, state.expert, state.session);
      const last = turns.length > 0 ? turns[turns.length - 1] : null;
      if (!streamed) {
        if (last) {
          console.log(`${amber(`${state.expert}⟩`)} ${last.answer}`);
        }
      } else {
        process.stdout.write("\n");
      }
      if (thinkingShown) clearLine();
      if (last) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(dim(`  turn ${last.turn} · ${last.tokens} tokens · ${secs}s${reasoningChars > 0 ? ` · 思考 ${reasoningChars} chars` : ""}`));
      }
      return;
    }
  }
}

// ---------- /compact：上下文压缩（主流 Agent 的 context compaction） ----------

async function runCompact(state: ChatOpts): Promise<void> {
  const turns = readSession(state.workspace, state.expert, state.session);
  if (turns.length < 2) {
    console.log(amber("? 至少 2 轮才值得压缩（当前 " + turns.length + " 轮）"));
    return;
  }
  const totalTokens = turns.reduce((s, t) => s + t.tokens, 0);
  console.log(dim(`⟳ 压缩 ${turns.length} 轮（约 ${totalTokens} tokens）→ 摘要 …`));
  const digestQuestion =
    "Summarize this session so far as a compact digest (max ~200 words): " +
    "key questions asked, key answers given, and any decisions or facts established. " +
    "This digest will REPLACE the session history for future context — keep every fact " +
    "needed to continue the conversation coherently. Output only the digest.";
  const t0 = Date.now();
  const handle = startRun({
    entry: "direct",
    task: digestQuestion,
    workspace: state.workspace,
    model: state.model as "scripted" | "deepseek",
    expert: state.expert,
    session: state.session,
    fixture: state.model === "scripted" ? (expertFixtureOf(state.workspace, state.expert) ?? undefined) : undefined,
  });
  let streamed = false;
  for await (const ev of handle.events) {
    if (ev.kind === "llm_delta" && ev.channel === "content") {
      if (!streamed) { process.stdout.write(dim("digest⟩ ")); streamed = true; }
      process.stdout.write(ev.delta);
    } else if (ev.kind === "run_result") {
      if (!ev.ok) {
        console.log(amber("✗ 压缩失败（账本未动）"));
        return;
      }
      if (streamed) process.stdout.write("\n");
      const turnsNow = readSession(state.workspace, state.expert, state.session);
      const last = turnsNow[turnsNow.length - 1] ?? null;
      const summary = last?.answer ?? "";
      if (summary.length === 0) { console.log(amber("✗ 压缩结果为空（账本未动）")); return; }
      const { backup } = compactLedger(state.workspace, state.expert, state.session, summary, turns.length);
      const now = readSession(state.workspace, state.expert, state.session);
      const after = now.length > 0 ? now[0]! : null;
      const saved = totalTokens - (after?.tokens ?? 0);
      console.log(dim(`✓ 压缩完成：${turns.length} 轮 → 1 轮摘要 · 节省约 ${Math.max(0, saved)} tokens · ${((Date.now() - t0) / 1000).toFixed(1)}s`));
      console.log(dim(`  备份 ${path.basename(backup)}（手工回滚：拷回原名）`));
      return;
    }
  }
}

// ----------------------------------------------------------------------------
// 独立入口：bun cli/chat.ts 直接运行时也走 chatMain（与 org chat 等价）。
// 此前直接运行该文件会静默退出（只定义函数、无调用）——实测发现并修复。
// 被 org.ts 动态 import 时 import.meta.main 为 false，不会重复执行。
// ----------------------------------------------------------------------------
if (import.meta.main) {
  process.exitCode = await chatMain(process.argv.slice(2));
}
