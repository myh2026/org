#!/usr/bin/env bun
// ============================================================================
// org/cli/org.ts — ORG 命令行（v0.4.14）
// ----------------------------------------------------------------------------
//   org run --task "..."          团队模式派单（监督回路全流程）
//   org demo                      全叙事演示：铸专家 → 用户选取保留 → 复用+补丁+金丝雀
//                                 → 蓝绿验证 → 多轮直连 → 暖移交
//   org ask <expert> "q" [--session id] [--turns "q1|q2"]
//                                 直连指定专家（记账 + 纪要回写 + 会话账本）
//   org web [--port N]            Web GUI 原型（Bun.serve 零依赖：会话侧栏 +
//                                 对话视图 + 观测元数据；实现见 web/entry.ts）
//   org handoff <expert> --task "..."   转接模式（主控移交摘要 → 专家代答）
//   org keep <expert...>          工具库治理：选取保留 harness（候选 → 转正）
//   org drop <expert...>          工具库治理：取消保留（不再参与 B 路径自动复用）
//   org import <file.hsl>         工具库治理：导入用户自己的 harness（check 闸门 →
//                                 入库即保留 → B 路径即刻可复用）
//   org status                    库 / 池 / 资产状态（★ 保留 · ○ 候选 · 含上下文窗口占用）
//   org score [--axis a]          模型评分卡与证据来源
//   org replay --run <dir>        确定性重放某次历史运行（journal 时间线）
//   org check                     dhv check 全部 HSL 源
//
// 工具链解析（vendored 优先）：$DHV_TS → 内嵌 toolchain/dhv-ts → 兄弟目录克隆
// （向后兼容）。Windows 兼容：子进程用 process.execPath（bun 本体），传给
// HSL 侧的 DHV_TS 统一转正斜杠（bash -c 不吃反斜杠）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { ROOT, DEFAULT_WORKSPACE } from "../lib/root.ts";
import { dhvRun, assertWorkspaceNotTemplate, assertSafeResetWorkspace,
         loadRegistryIndex, setRetained, keepAllCandidates,
         importHarness, listContextUsage, renderContextMeter, expertFixtureOf,
         latestHarnessRunDir, reviewCandidates, applyReview,
         forkSession, revertExpert, archivedVersions, renameSession, deleteSession } from "../lib/engine.ts";
import { readCostTimeline, renderCostTimeline, latestScorecardDir } from "../lib/engine.ts";
import { stockAffinityOf, rescueExpertOf, writeOutOfDomainRun, SEMANTIC_FLOOR } from "../lib/engine.ts"; // v0.5.10 语义地板（B-19）
import { directAskGateOf, directDegradeAnswer, writeDirectDegradeRun, prependAskRescueEvent } from "../lib/engine.ts"; // v0.5.14 直连语义地板（B-22）
import { scanAndRenderArtifacts } from "../lib/audio.ts"; // v0.5.6 音频产物通道（CLI 车道）
import { semanticSearch } from "../lib/search.ts"; // v0.5.8 语义检索（capabilities #19/#22）
import { synthesizeSpeech, voiceStatus, VOICES } from "../lib/voice.ts"; // v0.5.12 语音入口（ASR/TTS）
import { analyzeImages, visionStatus, VISION_MAX_IMAGES } from "../lib/vision.ts"; // v0.5.13 视觉入口（VLM）
import { dbSchema, dbTables, dbQuery, dbMigrations, dbApplyMigration, DB_LIMITS } from "../lib/db.ts"; // v0.5.15 数据库操作层（capabilities #43/#73）
import { diffText, diffFiles, renderUnified, renderStats } from "../lib/diff.ts"; // v0.5.15 diff 预览（#49/#60）
import { indexSymbols, lookupDef, findRefs } from "../lib/symbols.ts"; // v0.5.15 符号定义/引用（#20）
import { scanWorkspace, scanText, SECRET_PATTERNS } from "../lib/scan.ts"; // v0.5.15 密钥扫描（#141）
import { exportAudit, auditSummary } from "../lib/audit.ts"; // v0.5.15 审计导出（#150）
import { buildSbom, renderSpdxJson, renderSpdxTagValue } from "../lib/sbom.ts"; // v0.5.15 SBOM（#148）
import { loadCodeowners, matchOwners, recommendReviewers } from "../lib/owners.ts"; // v0.5.15 CODEOWNERS/评审推荐（#89/#85）
import { pdfEngines, readPdf } from "../lib/pdfread.ts"; // v0.5.15 PDF 读取降级链（#24）
import { dbDiagnose, DBDIAG_LIMITS } from "../lib/dbdiag.ts"; // v0.5.16 数据库查询诊断（#113）
import { gitMergeState, gitMerge, gitRebase, GIT_LIMITS } from "../lib/gitmerge.ts"; // v0.5.16 merge/rebase 安全操作（#80）
import { loadRbac, rbacCheck, rbacRoles, rbacActions, DEFAULT_RBAC_POLICY, RBAC_POLICY_FILE } from "../lib/rbac.ts"; // v0.5.16 RBAC（#149）
import { scanIac, IAC_RULES } from "../lib/iacscan.ts"; // v0.5.16 容器/IaC 扫描（#147）
import { iacParseFile, iacGraph, iacPlan, iacGenerate, probeIac, iacValidate, iacSelfTest,
         type IacBlock } from "../lib/iac.ts"; // v0.5.18 IaC 深度实现层（#44：解析/图/计划/生成 —— 与 iacscan 扫描面互补）
import { resolveInWorkspace, inWorkspace } from "../lib/pathjail.ts"; // 工作区监狱（v0.5.16.1 跨平台比较形单点）
import { pluginList, pluginInstall, pluginRemove, pluginValidate, gitAvailable, PLUGINS_DIR_REL } from "../lib/plugins.ts"; // v0.5.16 插件市场（#132）
import { parseOpenApiFile, suggestToolName, OPENAPI_MAX_BYTES } from "../lib/openapi.ts"; // v0.5.16 OpenAPI 解析（#134）
import { browserEngines, browserSnapshot, browserScreenshot } from "../lib/browser.ts"; // v0.5.16 浏览器 DOM 快照/截图（#116/#30）
import { completeAt } from "../lib/completion.ts"; // v0.5.16 代码补全（#32）
import { applyRename } from "../lib/rename.ts"; // v0.5.16 项目级重命名（#56）
import { probeDocker, dockerRun, dockerBuild, dockerfileFor, DOCKERFILE_TYPES, composeFor, dockerPlan, DOCKER_PLAN_ACTIONS,
         probeSsh, sshRun, scpUpload, sshConfigTemplate, sshPlan, sshHostAllowed, SSH_HOSTS_ALLOW,
         probeK8s, probeTerraform, k8sRun, k8sManifestFor, K8S_MANIFEST_KINDS, terraformPlan,
         probeCloudClis, cloudProvidersOverview, cloudProbeAll, DOCKER_SUBCOMMANDS, K8S_SUBCOMMANDS,
         type CloudRunResult } from "../lib/cloud.ts"; // v0.5.17 云生态统一模块（#67/#68/#72/#74）
import { lspDefinition, lspReferences, lspHover, detectLspServers, protocolSelfTest } from "../lib/lsp.ts"; // v0.5.17 LSP/DAP 协议集成（#26）
import { suggestBreakpoints, debugPlan, dapSelfTest } from "../lib/debug.ts"; // v0.5.17 断点/调试建议（#108）
import { latestSession } from "../lib/sessions.ts"; // v0.5.17：collab bridge 缺省会话（只读复用会话账本协议）
import {
  probeRemote, loadRemoteHosts, saveRemoteHosts, findRemoteHost, REMOTE_HOSTS_FILE, REMOTE_HOSTS_GUIDANCE,
  remoteExec, remoteSync, remotePing, remoteDeployPlan, REMOTE_DEPLOY_MODES, remoteSelfTest,
  REMOTE_READONLY_COMMANDS, type RemoteRunResult,
} from "../lib/remote.ts"; // v0.5.18 远程 Agent 簇（#133 —— 会话/部署/计划层，与 cloud_ssh 单命令执行互补）
import {
  currentUser, setUser, postThread, commentOn, listThreads, threadFeed, flattenThread,
  collaborators, collabSummary, bridgeSession, COLLAB_DIR_REL,
} from "../lib/collab.ts"; // v0.5.17 团队协作层（#87 团队共享会话/评论）
import {
  probeMobile, mobileDevices, mobileLogcat, mobileForward, mobileApkInfo, mobileDebugPlan, mobileSelfTest,
  MOBILE_PLAN_PLATFORMS, MOBILE_SYMPTOMS, LOGCAT_LINES_DEFAULT, LOGCAT_LINES_MAX, LOGCAT_LEVELS,
} from "../lib/mobile.ts"; // v0.5.18 移动端调试统一模块（#117 —— 与 iacscan #147 的扫描面互补）
import {
  probeMcpRuntimes, loadMcpServers, saveMcpServers, MCP_SERVERS_FILE, MCP_SERVERS_GUIDANCE, mcpSelfTest,
  mcpListTools, mcpCallTool, mcpListResources, mcpReadResource, mcpListPrompts,
} from "../lib/mcp.ts"; // v0.5.19 MCP 客户端桥（#122 / C12 —— 协议翻译半面：登记 → 真握手真调用）
import { listApprovals, decideApproval, clearGranted } from "../lib/approvals.ts";
import type { ReviewCandidate } from "../lib/engine.ts";
import { ORG_VERSION as VERSION } from "../lib/version.ts"; // 版本单一来源（v0.4.14）
import { parseJournalLine } from "../lib/events.ts"; // v0.4.17：replay 解析与事件泵同源
import { configPath, loadConfig, setConfigValue, unsetConfigValue, applyPreset,
         effectiveValue, applyConfigToEnv, CONFIG_KEYS, PRESETS, maskSecret,
         normalizeKey, setLaneValue, removeLane, useLane, addApiKey, autoFromEnv,
         type LaneConfig } from "../lib/config.ts"; // 用户模型/API 配置（v0.4.16）
import { PROVIDERS, PROVIDER_NAMES, discoverEnvLanes, resolveModelFlag,
         providerRows, testLane, type ProviderRow } from "../lib/providers.ts"; // 服务商注册表与车道解析（v0.5.1）
import { prepareLlmEnv, readLedger, activeRouter, poolView, budgetWatermark, type LedgerStats } from "../lib/router.ts"; // 本地路由器（v0.5.1 · 池状态/预算水位 v0.5.5）
import {
  submitTask, listTasks, getTask, readTaskJournal, cancelTask, pauseTask,
  resumeTask, retryTask, runNextTask, TaskRunner, type TaskStatus,
} from "../lib/tasks.ts"; // 长程任务队列（v0.5.2）
import {
  notifyEvent, readNotifications, unreadCount, markRead, clearNotifications,
  webhookNotify,
} from "../lib/notify.ts"; // 通知中心（v0.5.2 · webhook 出站 v0.5.5）
import {
  addSchedule, listSchedules, removeSchedule, setScheduleEnabled,
  previewNext, type ScheduleRecord,
} from "../lib/schedule.ts"; // 定时任务触发器（v0.5.5）
import { expandMentions } from "../lib/mentions.ts"; // @文件引用（v0.5.3）
import { listMemories, addMemory, removeMemory, allMemories } from "../lib/memories.ts"; // 长期记忆（v0.5.3）

const HSL_ENTRY = path.join(ROOT, "hsl/org.hsl");
const DIRECT_ENTRY = path.join(ROOT, "hsl/pool/direct.hsl");
const HANDOFF_ENTRY = path.join(ROOT, "hsl/pool/handoff.hsl");
const STOCK_FIXTURE = path.join(ROOT, "fixtures/run-notices.json");

// v0.5.14：终端淡色助手 —— cmdAsk 的 @引用展开（v0.5.3）与直连降级提示
// 早就引用 dim，但本文件从未定义（非 TTY 管道下 ReferenceError 炸退出码，
// 属潜伏 bug；本轮 D3 测试首次踩响）。TTY 才着色，管道/测试拿纯文本。
const isTTY = process.stdout.isTTY === true;
const dim = (s: string): string => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);

// ---- 工具链解析（vendored 优先） ----
function resolveDhv(): string {
  const candidates = [
    process.env.DHV_TS,
    path.join(ROOT, "toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "../hsl/toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "../harness-specification-language/toolchain/dhv-ts/src/main.ts"),
    path.resolve(ROOT, "harness-specification-language/toolchain/dhv-ts/src/main.ts"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error(
    "✗ 找不到 HSL 工具链（dhv-ts）。三选一：\n" +
    "  1) export DHV_TS=/path/to/dhv-ts/src/main.ts\n" +
    "  2) 把 harness-specification-language 仓库 clone 到本仓库的兄弟目录\n" +
    "  3) 检查 toolchain/dhv-ts/src/main.ts 是否存在（仓库自带，不应缺失）",
  );
  process.exit(2);
}

const DHV = resolveDhv();

/** 传给 HSL 侧（bash -c 执行环境）的路径统一正斜杠。 */
function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---- 参数解析 ----
interface Args {
  cmd: string;
  task: string;
  workspace: string;
  fixture: string;
  model: string;
  out: string;
  runDir: string;
  axis: string;
  session: string;
  turns: string[];
  approveCapability: boolean;
  continue: boolean;
  name: string;
  description: string;
  capabilities: string[];
  keepList: string[];      // org review --keep a,b（非交互显式选取）
  dropList: string[];      // org review --drop c（把已保留资产降回候选）
  reviewAll: boolean;      // org review --all / --yes（全选待决策候选）
  reviewNone: boolean;     // org review --none（全不选，只出报告）
  dryRun: boolean;         // org review --dry-run（只看不写）
  fixtureExplicit: boolean;
  modelExplicit: boolean;  // --model 是否显式给出（缺省车道以此判据接管）
  exportDist: boolean;
  toVersion: string;      // org revert --to <x.y.z>
  approval: boolean;      // org run --approval（开交互式审批队列）
  spawnDepth: number;     // v0.5.6：递归派生深度（agent_spawn 工具注入；内部旗标）
  spawnBudget: number;    // v0.5.11：递归派生预算（--spawn-budget N|off；NaN=未设不注入；内部旗标）
  k: number;              // v0.5.8：org search --k（top-N 命中数）
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: argv[0] ?? "help",
    task: "",
    workspace: DEFAULT_WORKSPACE,
    fixture: STOCK_FIXTURE,
    model: "scripted",
    out: "",
    runDir: "",
    axis: "",
    session: "default",
    turns: [],
    approveCapability: false,
    continue: false,
    name: "",
    description: "",
    capabilities: [],
    keepList: [],
    dropList: [],
    reviewAll: false,
    reviewNone: false,
    dryRun: false,
    fixtureExplicit: false,
    modelExplicit: false,
    exportDist: false,
    toVersion: "",
    approval: false,
    spawnDepth: 0,
    spawnBudget: Number.NaN,
    k: 5,
    rest: [],
  };
  let i = 1;
  while (i < argv.length) {
    const v = argv[i]!;
    if (v === "--task") a.task = argv[++i] ?? "";
    else if (v === "--workspace") a.workspace = path.resolve(argv[++i] ?? ".");
    else if (v.startsWith("--workspace=")) a.workspace = path.resolve(v.slice("--workspace=".length)); // v0.5.17.1 等号形态（控制台 param 追加车道：flag 前置 + 值后置的 rawPositionals 兼容）
    else if (v === "--fixture") { a.fixture = path.resolve(argv[++i] ?? "."); a.fixtureExplicit = true; }
    else if (v === "--model") { a.model = argv[++i] ?? "scripted"; a.modelExplicit = true; }
    else if (v === "--out") a.out = path.resolve(argv[++i] ?? ".");
    else if (v === "--run") a.runDir = path.resolve(argv[++i] ?? ".");
    else if (v === "--axis") a.axis = argv[++i] ?? "";
    else if (v === "--session") a.session = argv[++i] ?? "default";
    else if (v === "--turns") a.turns = (argv[++i] ?? "").split("|").filter((s) => s.length > 0);
    else if (v === "--approve-capability") a.approveCapability = true;
    else if (v === "--export-dist") a.exportDist = true;
    else if (v === "--to") a.toVersion = argv[++i] ?? "";
    else if (v === "--approval") a.approval = true;
    else if (v === "--spawn-depth") a.spawnDepth = Math.max(0, Number(argv[++i] ?? "0") || 0);
    else if (v === "--spawn-budget") {
      // v0.5.11：预算旗标（agent_spawn 工具链）：N 份 | off/unlimited（关闭治理）。
      // 非法值 → NaN（不注入，子进程缺省 100）。
      const b = String(argv[++i] ?? "").trim().toLowerCase();
      if (b === "off" || b === "unlimited") a.spawnBudget = -1;
      else {
        const n = Math.floor(Number(b));
        a.spawnBudget = Number.isFinite(n) && n >= 0 ? n : Number.NaN;
      }
    }
    else if (v === "--k") a.k = Math.max(1, Math.floor(Number(argv[++i] ?? "5") || 5));
    else if (v === "--continue" || v === "-c") a.continue = true;
    else if (v === "--name") a.name = (argv[++i] ?? "").toLowerCase();
    else if (v === "--description" || v === "--desc") a.description = argv[++i] ?? "";
    else if (v === "--capability" || v === "--capabilities") a.capabilities = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else if (v === "--keep") a.keepList = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else if (v === "--drop") a.dropList = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else if (v === "--all" || v === "--yes") a.reviewAll = true;
    else if (v === "--none") a.reviewNone = true;
    else if (v === "--dry-run") a.dryRun = true;
    else a.rest.push(v);
    i++;
  }
  return a;
}

// ---- 基础执行（dhvRun：bun 子进程优先，无 bun 环境进程内 fallback） ----
async function runHsl(entry: string, opts: {
  workspace: string; task: string; model: string; fixture: string; out: string;
  env?: Record<string, string>;
}): Promise<{ ok: boolean; out: string }> {
  // 车道环境准备（v0.5.1）：--model 车道名/裸模型 id → key 池/降级链/路由器
  await prepareLlmEnv(opts.model, opts.workspace);
  const args = [
    "run", entry,
    "--workspace", opts.workspace,
    "--task", opts.task,
    "--model", opts.model,
    "--fixture", opts.fixture,
    "--out", opts.out,
    "--allow", "bun,node,ls,cat,grep,diff,git",
  ];
  const r = await dhvRun(args, {
    // v0.5.6：剧本路径透传（agent_spawn 子组织派生需要；绝对路径跨工作区可用）
    ORG_FIXTURE: path.resolve(opts.fixture),
    ...(opts.env ?? {}),
  });
  try {
    // v0.5.6 音频产物通道（CLI 车道）：*.notes.json → 同名 .wav（开袋即食）。
    // 扫描两处：run 产物目录（静态/工具环车道）+ work-out（磁盘专家车道）。
    // 渲染结果拼进运行输出（♪ 行）+ events.jsonl 留痕；失败不改变 run 语义。
    const audio = scanAndRenderArtifacts(opts.out);
    const workOut = scanAndRenderArtifacts(path.join(opts.workspace, "work-out"));
    audio.rendered.push(...workOut.rendered);
    audio.failures.push(...workOut.failures);
    if (audio.rendered.length > 0) {
      for (const a of audio.rendered) {
        r.out += `\n♪ 音频产物已渲染：${a.wavFile}（${a.title} · ${a.durationSec}s · ${a.notes} 音符 · ${(a.bytes / 1024).toFixed(0)}KB）`;
      }
      fs.appendFileSync(
        path.join(opts.out, "events.jsonl"),
        JSON.stringify({
          seq: 2 ** 30 - 1, ts: new Date().toISOString(), name: "audio_rendered",
          data: { files: audio.rendered, failures: audio.failures },
        }) + "\n",
      );
    }
  } catch { /* 音频渲染失败不影响 run 结果 */ }
  return r;
}

async function checkFile(file: string): Promise<boolean> {
  const r = await dhvRun(["check", file]);
  const ok = r.ok;
  const text = r.out;
  const tag = ok ? "✓" : "✗";
  const rel = path.relative(ROOT, file);
  console.log(`  ${tag} ${rel}${ok ? "" : "\n" + text.split("\n").slice(-8).join("\n")}`);
  return ok;
}

// ---- 命令 ----
async function cmdRun(a: Args): Promise<number> {
  if (!a.task) { console.error("✗ --task 必填"); return 2; }
  ensureWorkspace(a.workspace);
  const out = a.out || path.join(a.workspace, "out-latest");
  const env: Record<string, string> = {};
  // 预授权：运行前一次性放行全部能力变更（旧语义，保留）
  if (a.approveCapability) env.ORG_CAPABILITY_APPROVED = "1";
  // 交互式审批：能力类决策写请求 + 有界等待（另一终端跑 org approvals --watch）
  if (a.approval) env.ORG_APPROVAL = "1";
  // v0.5.6：递归派生深度透传（agent_spawn 工具链：子组织的工具环须知道自己在第几层）
  if (a.spawnDepth > 0) env.ORG_SPAWN_DEPTH = String(a.spawnDepth);
  // v0.5.11：递归派生预算透传（子预算 = floor(父预算 × DECAY)；off = 关闭治理）
  if (Number.isFinite(a.spawnBudget)) env.ORG_SPAWN_BUDGET = a.spawnBudget === -1 ? "off" : String(a.spawnBudget);
  // v0.5.10：scripted 团队车道域外任务语义地板（B-19，与 lib/engine.ts
  // startRun 预检同构 —— Web/TUI 走 startRun，CLI run 在此）。仅 scripted +
  // 未显式指定 fixture 时介入：域内放行 / 注册表专家跨车道救援转直连 /
  // 零消耗诚实降级（不套用域外剧本答非所问）。
  let entry = HSL_ENTRY;
  let fixture = a.fixture;
  if (a.model === "scripted" && !a.fixtureExplicit) {
    const stockScore = stockAffinityOf(a.task, STOCK_FIXTURE);
    if (stockScore < SEMANTIC_FLOOR) {
      const pick = rescueExpertOf(a.task, a.workspace);
      if (pick) {
        entry = DIRECT_ENTRY;
        fixture = pick.fixture;
        Object.assign(env, {
          ORG_ASK_EXPERT: pick.expert,
          ORG_ASK_SESSION: "default",
          ORG_ASK_QUESTION: a.task,
          // v0.5.10：救援默认开工具环（audio_compose 即门即用；fs_write 走
          // 审批在环 —— CLI org approvals --watch 放行；用户显式设置优先）
          ORG_TOOLS: process.env.ORG_TOOLS || "write",
        });
        console.log(`⇄ 跨车道救援：任务域外（与团队剧本重合 ${stockScore.toFixed(2)} < ${SEMANTIC_FLOOR}）→ 直连 ${pick.expert}（评分 ${pick.score.toFixed(2)}）`);
      } else {
        writeOutOfDomainRun(out, a.task, stockScore);
        console.log(`◌ 域外任务 · 零消耗降级（与团队剧本重合 ${stockScore.toFixed(2)} < ${SEMANTIC_FLOOR}，流水线未启动）`);
        console.log(`  建议出口：org ask <专家> "问题"（直连）· org run --model <车道>（真实模型动态分解）· org search "关键词"（找在岗专家）`);
        console.log(`  产物：${path.join(out, "report.md")}`);
        return 0;
      }
    }
  }
  const r = await runHsl(entry, {
    workspace: a.workspace, task: entry === DIRECT_ENTRY ? `(direct) ${a.task}` : a.task, model: a.model,
    fixture, out, env,
  });
  process.stdout.write(r.out);
  // 运行收尾：把「本次产出的候选怎么处置」交回用户（工厂产物默认候选，
  // 不选取就不会进 B 路径自动复用 —— 这一步不提示就等于资产白铸）。
  printReviewHint(a.workspace, out);
  return r.ok ? 0 : 1;
}

/**
 * 运行收尾提示：本次运行若有待决策候选，打印一行可执行的下一步。
 * 静默条件：非 TTY（脚本/管道场景不插话）或本次没有待决策候选。
 */
function printReviewHint(ws: string, runDir: string): void {
  if (!process.stdin.isTTY) return;
  if (!fs.existsSync(path.join(ws, "registry/index.json"))) return;
  try {
    const { pending } = reviewCandidates(ws, runDir);
    if (pending.length === 0) return;
    const names = pending.map((c) => c.name).join(", ");
    console.log(`\n[review] 本次铸出/合入 ${pending.length} 个未保留候选：${names}`);
    console.log(`[review] 选取沉淀进工具库：org review --workspace ${ws}（或 --keep ${pending[0]!.name} / --all）`);
  } catch { /* 提示失败不影响运行结果 */ }
}

async function cmdDemo(a: Args): Promise<number> {
  const ws = a.workspace;
  const task = "抓取某站点近一周公告，输出结构化表格";
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║ ORG 全叙事演示：子智能体可生成、可验收、可复用、可演进            ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`  工作区 ${ws}（git 注册表） · 任务「${task}」 · 模式 ${a.model}\n`);

  // 工作区重置（演示可重复）；模板目录只读守卫 + 非工作区目录拒绝删除
  // （rmSync 脚枪防线：指错目录不再静默删光，见 engine.ts assertSafeResetWorkspace）
  try {
    assertWorkspaceNotTemplate(ws);
    assertSafeResetWorkspace(ws);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
  gitInit(ws);

  const t0 = Date.now();
  const phases: Array<{ id: string; label: string; out: string; fn: () => Promise<{ ok: boolean; out: string }> }> = [
    {
      id: "A", label: "run A · 现场铸专家（工厂闸门）+ 过程审查（返工）+ 固化起步",
      out: path.join(ws, "out-a"),
      fn: () => runHsl(HSL_ENTRY, { workspace: ws, task, model: a.model, fixture: a.fixture, out: path.join(ws, "out-a") }),
    },
    {
      // 用户选取（工具库治理）：工厂产出是候选（retained=false），B 路径只
      // 复用用户保留的资产。人在场（TTY）就真的问用户选哪几个 —— 这正是
      // 「在此次过程中选取哪些 harness 沉淀进工具库」的落点；非交互
      // （CI / 管道 / 测试）保持 scripted 全选，叙事确定性不变。
      id: "K", label: "用户选取 · harness 候选转正保留（org keep / org review）",
      out: "",
      fn: async () => {
        const aOut = path.join(ws, "out-a");
        const plan = reviewCandidates(ws, aOut);
        if (plan.pending.length === 0) {
          console.log("    ★ 本次无未保留候选（存量资产均已保留）");
          return { ok: true, out: "" };
        }
        if (!process.stdin.isTTY) {
          const picked = keepAllCandidates(ws);
          const line = picked.length > 0 ? picked.join(", ") : "（无候选 —— 存量资产均已保留）";
          console.log(`    ★ 保留 ${line}（非交互：scripted 全选；真实用户用 org review 逐项挑选）`);
          return { ok: true, out: "" };
        }
        // 人在场：把选取权交回用户（与 org review 同一份表格与解析器）
        console.log(`    本次铸出 ${plan.pending.length} 个候选，等待你选取：\n`);
        printReviewTable(plan.pending, plan.settled);
        const answer = await askLine("    选取保留（编号逗号分隔 / a 全选 / n 全不选 / 回车全选 / q 中止演示）: ");
        if (answer === null) return { ok: false, out: "" };
        const parsed = parseSelection(answer, plan.pending.length);
        if (parsed.kind === "cancel") {
          console.log("    已中止：工具库未做任何变更。重新运行 org demo 可再来一次。");
          return { ok: false, out: "" };
        }
        if (parsed.kind === "invalid") {
          console.error(`    ✗ 无法识别的输入「${parsed.token}」—— 请输入 1..${plan.pending.length} 的编号、a、n 或 q`);
          return { ok: false, out: "" };
        }
        const chosen = parsed.picked.map((n) => plan.pending[n - 1]!.name);
        if (chosen.length === 0) {
          console.log("    ○ 未选取任何候选 —— 全部保持候选态（资产留在库，仅退出 B 路径自动复用）");
          console.log("    （注意：后续 run B/C 将不再展示复用命中的叙事段落）");
          return { ok: true, out: "" };
        }
        const { kept } = applyReview(ws, chosen);
        const rest = plan.pending.filter((c) => !chosen.includes(c.name)).map((c) => c.name);
        console.log(`    ★ 保留 ${kept.join(", ")}（git 留痕，B 路径自动复用从下一轮派单命中）`);
        if (rest.length > 0) console.log(`    ○ 保持候选：${rest.join(", ")}`);
        return { ok: true, out: "" };
      },
    },
    {
      id: "B", label: "run B · 复用资产（零工厂）+ 意见复发 → 补丁合入 → 金丝雀影子晋升",
      out: path.join(ws, "out-b"),
      fn: () => runHsl(HSL_ENTRY, { workspace: ws, task, model: a.model, fixture: a.fixture, out: path.join(ws, "out-b") }),
    },
    {
      id: "C", label: "run C · 蓝绿验证（补丁版 v1.0.1 上岗）+ 零返工",
      out: path.join(ws, "out-c"),
      fn: () => runHsl(HSL_ENTRY, { workspace: ws, task, model: a.model, fixture: a.fixture, out: path.join(ws, "out-c") }),
    },
    {
      id: "D", label: "直连 · 多轮会话（记账 + 纪要回写 + 会话账本）",
      out: path.join(ws, "out-direct"),
      fn: () => runHsl(DIRECT_ENTRY, {
        workspace: ws, task: "(direct) multi-turn", model: a.model, fixture: a.fixture,
        out: path.join(ws, "out-direct"),
        env: { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "demo", ORG_ASK_TURNS: '["上周抓取任务里的字段映射规则是什么？","那日期无法解析时怎么处理？"]' },
      }),
    },
    {
      id: "E", label: "转接 · 暖移交（主控移交摘要 → 专家代答）",
      out: path.join(ws, "out-handoff"),
      fn: () => runHsl(HANDOFF_ENTRY, {
        workspace: ws, task: "(handoff) small request", model: a.model, fixture: a.fixture,
        out: path.join(ws, "out-handoff"),
        env: { ORG_HANDOFF_EXPERT: "notice-parser", ORG_HANDOFF_TASK: "帮我把上周公告解析规则整理成一句话给新同事" },
      }),
    },
  ];
  for (const phase of phases) {
    console.log(`── ${phase.label} ${"─".repeat(Math.max(0, 46 - phase.label.length))}`);
    const r = await phase.fn();
    process.stdout.write(r.out.split("\n").map((l) => "  " + l).join("\n") + "\n");
    if (!r.ok) { console.error(`✗ phase ${phase.id} 失败`); return 1; }
  }

  // ---- 叙事总结（从产物提取关键事件） ----
  console.log("\n╔════════════════════════ 走读摘要 ═════════════════════════╗");
  for (const id of ["A", "B", "C"]) {
    const [, line] = summarizeRun(path.join(ws, `out-${id.toLowerCase()}`), id);
    console.log(`  ${id} ${line}`);
  }
  const [, directLine] = summarizeDirect(ws);
  console.log(`  D ${directLine}`);
  const [, handoffLine] = summarizeHandoff(ws);
  console.log(`  E ${handoffLine}`);
  const gitLog = gitLogOf(ws);
  if (gitLog.length > 0) {
    console.log("\n  git 注册表历史（registry 资产层）：");
    for (const l of gitLog.slice(0, 6)) console.log(`    ${l}`);
  }
  console.log(`\n  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 产物 ${ws}/out-{a,b,c,direct,handoff}`);
  // dist/demo 是入库快照（CI 每次 push 再生回写）。仅默认工作区（demo-run）
  // 或显式 --export-dist 才导出 —— v0.4.17 修复：原先无守卫，`org demo
  // --workspace /tmp/xxx` 也会装仓库内 dist/demo 覆写（28 个文件时间戳漂移，
  // CI 把无关 diff 自动 commit）。
  const isDefaultWs = path.resolve(ws) === path.resolve(DEFAULT_WORKSPACE);
  if (isDefaultWs || a.exportDist) {
    exportDist(ws);
    console.log(`  编译产物已导出 dist/demo（入库快照，含 git-chain.json）`);
  } else {
    console.log(`  跳过 dist/demo 导出（非默认工作区；需要时加 --export-dist）`);
  }
  console.log("");
  return 0;
}

// ---- 编译产物导出：dist/demo（提交进库的运行快照） ----
const DIST_README = `# dist/demo — 全叙事演示编译产物（自动生成，勿手改）

\`org demo\` 的全量输出快照：out-a/b/c（run.json / events.jsonl /
journal.jsonl / 评分卡 / metrics.json）、out-direct（多轮直连）与
out-handoff（暖移交）、registry（专家注册表 + 固化 memo + 基准题沉淀 +
评分卡基线）、runtime（复发计数 / 会话账本 / 纪要）与 git-chain.json
（资产层 git 历史，因嵌套 .git 不入库而以数据保存）。

再生：\`bun cli/org.ts demo\`（CI 每次 push 自动再生并回写，见
.github/workflows/ci.yml）。
`;

function exportDist(ws: string): void {
  const dist = path.join(ROOT, "dist", "demo");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const skip = new Set([".git", ".hsl-runs"]);
  const copy = (src: string, dst: string): void => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copy(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  };
  copy(ws, dist);
  fs.writeFileSync(
    path.join(dist, "git-chain.json"),
    JSON.stringify({ captured_at: new Date().toISOString(), commits: gitLogFull(ws) }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(dist, "README.md"), DIST_README);
}

function gitLogFull(ws: string): Array<{ sha: string; subject: string; date: string }> {
  try {
    const out = Bun.spawnSync(
      ["git", "-C", ws, "log", "--pretty=format:%h%x1f%s%x1f%ci", "--all"],
      { stdout: "pipe" },
    );
    return out.stdout.toString().split("\n").filter((l) => l.trim().length > 0).map((l) => {
      const [sha, subject, date] = l.split("\x1f");
      return { sha: sha ?? "", subject: subject ?? "", date: date ?? "" };
    });
  } catch {
    return [];
  }
}

function readMetrics(ws: string, id: string): Record<string, unknown> | null {
  try {
    const p = path.join(ws, `out-${id.toLowerCase()}`, "metrics.json");
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizeRun(outDir: string, id: string): [string, string] {
  try {
    const events = fs.readFileSync(path.join(outDir, "events.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { name: string; data?: Record<string, unknown> });
    const hits = events.filter((e) => e.name === "crystallize_hit").length;
    const frozen = events.filter((e) => e.name === "crystallize_frozen").length;
    const canary = events.filter((e) => e.name === "canary_confirmed").length;
    const mined = events.filter((e) => e.name === "fixtures_mined").length;
    const m = readMetrics(path.dirname(outDir), id);
    const bits: string[] = [];
    if (m) {
      bits.push(`ok=true ${m.model_calls_total} model_calls · ${m.revises_total} revises · ${m.assets} 资产`);
      if (m.drift_alerts !== undefined) bits.push(`漂移告警 ${m.drift_alerts}`);
    } else {
      const runJson = JSON.parse(fs.readFileSync(path.join(outDir, "run.json"), "utf-8")) as { ok: boolean; elapsed_ms?: number };
      bits.push(`ok=${runJson.ok}`);
    }
    if (frozen > 0) bits.push(`冻结 ${frozen} 条判定映射`);
    if (hits > 0) bits.push(`固化命中 ${hits} 次（零模型调用）`);
    if (canary > 0) bits.push(`金丝雀影子晋升确认 ${canary} 次`);
    if (mined > 0) bits.push(`journal→fixture 出题 ${mined} 批`);
    return [id, bits.join(" · ")];
  } catch {
    return [id, "(产物缺失)"];
  }
}

function summarizeDirect(ws: string): [string, string] {
  try {
    const ledger = fs.readFileSync(path.join(ws, "out-direct", "direct-ledger.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0);
    const sessions = path.join(ws, "runtime/sessions/notice-parser/demo.jsonl");
    const turns = fs.existsSync(sessions)
      ? fs.readFileSync(sessions, "utf-8").split("\n").filter((l) => l.trim().length > 0).length
      : 0;
    return ["D", `多轮直连 ${turns} 轮 · 记账 ${ledger.length} 条 · 会话账本 + 纪要回写完成`];
  } catch {
    return ["D", "(产物缺失)"];
  }
}

function summarizeHandoff(ws: string): [string, string] {
  try {
    const ledger = fs.readFileSync(path.join(ws, "out-handoff", "direct-ledger.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0);
    return ["E", `暖移交 1 次（移交摘要 + 专家代答） · 记账 ${ledger.length} 条（handoff 通道）`];
  } catch {
    return ["E", "(产物缺失)"];
  }
}

function gitLogOf(ws: string): string[] {
  try {
    const out = Bun.spawnSync(["git", "-C", ws, "log", "--oneline", "--all"], { stdout: "pipe" });
    return out.stdout.toString().split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function gitInit(ws: string): void {
  for (const args of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "org@local"],
    ["git", "config", "user.name", "org-registry"],
  ] as const) {
    Bun.spawnSync(args as unknown as string[], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  }
  Bun.spawnSync(["git", "add", "-A"], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["git", "commit", "-q", "-m", "registry template (notice-parser@1.0.0)"],
    { cwd: ws, stdout: "ignore", stderr: "ignore" });
}

function ensureWorkspace(ws: string): void {
  try {
    assertWorkspaceNotTemplate(ws);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(2);
  }
  if (!fs.existsSync(ws)) {
    console.log(`ℹ 初始化工作区（模板 demo-ws → ${path.relative(ROOT, ws)}）`);
    fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
    gitInit(ws);
    return;
  }
  // v0.5.7 空壳工作区修复（与 lib/engine.ts 同构）：runtime/ 空壳不等于
  // 已初始化 —— 标记物（registry/ · raw/ · .git）全缺时补模板。
  const initialized = ["registry", "raw", ".git"]
    .some((m) => fs.existsSync(path.join(ws, m)));
  if (!initialized) {
    console.log(`ℹ 补全空壳工作区（模板 demo-ws → ${path.relative(ROOT, ws)}）`);
    fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
    gitInit(ws);
  }
}

async function cmdAsk(a: Args): Promise<number> {
  const expert = a.rest[0] ?? "";
  const question = a.rest.slice(1).join(" ");
  if (!expert) {
    console.error('用法：org ask <expert> "<question>" [--session id] [--turns "q1|q2"]');
    return 2;
  }
  ensureWorkspace(a.workspace);
  const out = a.out || path.join(a.workspace, "out-ask");
  let turns = a.turns.length > 0 ? a.turns : (question ? [question] : []);
  if (turns.length === 0) {
    console.error('用法：org ask <expert> "<question>"（问题必填）');
    return 2;
  }
  // 剧本自动发现：导入 harness 自带占位剧本（manifest.fixture）—— 不传
  // --fixture 也能立即 scripted 问答（零摩擦）；显式 --fixture 优先。
  let fixture = a.fixture;
  if (!a.fixtureExplicit) {
    const found = expertFixtureOf(a.workspace, expert);
    if (found) {
      fixture = found;
      console.log(`ℹ 使用导入剧本 ${path.relative(a.workspace, found)}（占位应答 · --model deepseek 换真实回答）`);
    }
  }
  // v0.5.14：B-22 直连语义地板（与 Web askOnce/askStreamOnce 同规则；仅
  // scripted 车道 + 未显式指定 fixture 时介入 —— 显式剧本是专家意志，不拦）
  let effExpert = expert;
  let rescueMeta: { score: number; selfScore: number } | null = null;
  if (!a.fixtureExplicit && (a.model === "scripted" || a.model === "")) {
    const gate = directAskGateOf(a.workspace, expert, turns.join(" / "), true);
    if (gate.kind === "degrade") {
      writeDirectDegradeRun(out, expert, turns.join(" / "), gate);
      console.log(directDegradeAnswer(expert, gate));
      console.log(dim(`产物：${out}/events.jsonl · run.json（◌ 零消耗降级，未落账本）`));
      return 0; // 诚实降级不是失败
    }
    if (gate.kind === "reroute" && gate.expert && gate.fixture) {
      console.log(`⇄ 直连救援 → ${gate.expert}（原选 ${expert} 重合 ${gate.selfScore?.toFixed(2)} < ${SEMANTIC_FLOOR} 地板 · 域内专家评分 ${gate.score?.toFixed(2)}）`);
      effExpert = gate.expert;
      fixture = gate.fixture;
      rescueMeta = { score: gate.score ?? 0, selfScore: gate.selfScore ?? 0 };
    }
  }
  const env: Record<string, string> = {
    ORG_ASK_EXPERT: effExpert,
    ORG_ASK_SESSION: a.session,
  };
  // v0.5.14：救援轮默认开工具环（与团队救援/engine startRun 同规则 ——
  // audio_compose 作曲 / fs_write 工件交付需要；用户显式 ORG_TOOLS 优先）
  if (rescueMeta) env.ORG_TOOLS = process.env.ORG_TOOLS || "write";
  // v0.5.6：递归派生深度透传（agent_spawn ask 模式子组织）
  if (a.spawnDepth > 0) env.ORG_SPAWN_DEPTH = String(a.spawnDepth);
  // v0.5.11：递归派生预算透传（ask 模式子组织同享预算语义）
  if (Number.isFinite(a.spawnBudget)) env.ORG_SPAWN_BUDGET = a.spawnBudget === -1 ? "off" : String(a.spawnBudget);
  // v0.5.3：@文件/目录引用展开（workspace 相对路径 → 围栏内容注入）
  if (question.includes("@")) {
    const m = expandMentions(question, a.workspace);
    if (m.expanded.length > 0) {
      console.log(dim(`📎 已展开引用：${m.expanded.join(", ")}${m.skipped.length > 0 ? dim(`（跳过 ${m.skipped.map((s) => `@${s.path}：${s.reason}`).join("; ")}）`) : ""}`));
    }
    turns = turns.map((t) => (t === question ? m.text : t));
  }
  if (turns.length === 1) env.ORG_ASK_QUESTION = turns[0]!;
  else env.ORG_ASK_TURNS = JSON.stringify(turns);
  const r = await runHsl(DIRECT_ENTRY, {
    workspace: a.workspace, task: `(direct) ${turns.join(" / ")}`, model: a.model,
    fixture, out, env,
  });
  process.stdout.write(r.out);
  // v0.5.14：reroute 留痕（out-ask 事件前插，回放面板渲染 ⇄ 卡 —— 与 Web 同叙事）
  if (rescueMeta && r.ok) {
    prependAskRescueEvent(out, {
      mode: "reroute", from: expert, expert: effExpert,
      score: rescueMeta.score, selfScore: rescueMeta.selfScore, floor: SEMANTIC_FLOOR,
    });
  }
  return r.ok ? 0 : 1;
}

async function cmdHandoff(a: Args): Promise<number> {
  const expert = a.rest[0] ?? "";
  if (!expert || !a.task) {
    console.error('用法：org handoff <expert> --task "<request>"');
    return 2;
  }
  ensureWorkspace(a.workspace);
  const out = a.out || path.join(a.workspace, "out-handoff");
  // 剧本自动发现（与 cmdAsk 同规则）：导入 harness 的 handoff:<name> 占位轨道
  let fixture = a.fixture;
  if (!a.fixtureExplicit) {
    const found = expertFixtureOf(a.workspace, expert);
    if (found) {
      fixture = found;
      console.log(`ℹ 使用导入剧本 ${path.relative(a.workspace, found)}（占位应答 · --model deepseek 换真实回答）`);
    }
  }
  const r = await runHsl(HANDOFF_ENTRY, {
    workspace: a.workspace, task: `(handoff) ${a.task}`, model: a.model,
    fixture, out,
    env: { ORG_HANDOFF_EXPERT: expert, ORG_HANDOFF_TASK: a.task },
  });
  process.stdout.write(r.out);
  return r.ok ? 0 : 1;
}

// 读命令的默认工作区：本地 demo-run 优先（活数据），否则 dist/demo（入库快照）
function defaultWorkspace(a: Args): string {
  if (a.workspace !== path.join(ROOT, "demo-run")) return a.workspace;
  if (fs.existsSync(path.join(ROOT, "demo-run", "registry"))) return a.workspace;
  if (fs.existsSync(path.join(ROOT, "dist", "demo", "registry"))) {
    return path.join(ROOT, "dist", "demo");
  }
  return a.workspace;
}

// ---- 工具库治理：用户选取保留（实现见 lib/engine.ts，CLI/TUI 共用） ----

async function cmdKeep(a: Args): Promise<number> {
  return cmdRetain(a, true);
}

async function cmdDrop(a: Args): Promise<number> {
  return cmdRetain(a, false);
}

// ---- 导入用户自己的 harness（工具库治理第三动作：import = 用户交付资产） ----
async function cmdImport(a: Args): Promise<number> {
  const file = a.rest[0] ?? "";
  if (!file) {
    console.error('用法：org import <file.hsl> [--name NAME] [--description "…"] [--capability a,b] [--workspace DIR]');
    console.error("  导入即保留（source=import, retained=true）—— B 路径自动复用立即可用；");
    console.error("  描述缺省取文件首个 /// 文档注释，能力缺省扫描 #[capability(…)] 注解。");
    return 2;
  }
  ensureWorkspace(a.workspace);
  try {
    const r = await importHarness(a.workspace, path.resolve(file), {
      name: a.name || undefined,
      description: a.description || undefined,
      capabilities: a.capabilities.length > 0 ? a.capabilities : undefined,
    });
    console.log(`✓ 已导入 ${r.name}@${r.version}（check 绿 · git 留痕）`);
    console.log(`  描述：${r.description}`);
    console.log(`  能力：${r.capabilities.join(", ")}`);
    console.log(`  入库：${path.relative(process.cwd(), r.file)}（source=import · retained=true · B 路径即刻可复用）`);
    console.log(`  剧本：${path.relative(process.cwd(), r.fixture)}（scripted 占位应答 · org ask ${r.name} "…" 零参数直连）`);
    console.log("  下一步：org status 查看 · org ask " + r.name + ' "…" 直连（占位剧本 · --model deepseek 换真实回答） · org drop ' + r.name + " 取消保留");
    return 0;
  } catch (err) {
    console.error(`✗ 导入失败：${(err as Error).message}`);
    return 1;
  }
}

async function cmdRetain(a: Args, retained: boolean): Promise<number> {
  const names = a.rest;
  const action = retained ? "keep（选取保留）" : "drop（取消保留）";
  if (names.length === 0) {
    console.error(`用法：org ${retained ? "keep" : "drop"} <expert> [expert2 ...] [--workspace DIR]`);
    const experts = loadRegistryIndex(a.workspace);
    if (experts.length > 0) {
      const list = experts.map((m) => `  ${m.retained === false ? "○" : "★"} ${m.name}@${m.version} [${m.source}]`);
      console.error(`当前注册表：\n${list.join("\n")}`);
    }
    return 2;
  }
  // dist/demo 是入库快照（只读）—— 写入会污染编译产物层
  if (path.resolve(a.workspace) === path.join(ROOT, "dist", "demo")) {
    console.error("✗ dist/demo 是入库快照（只读）。请对真实工作区操作：org demo 后用 demo-run，或 --workspace <dir>");
    return 2;
  }
  if (!fs.existsSync(path.join(a.workspace, "registry/index.json"))) {
    console.error(`✗ 工作区 ${a.workspace} 无注册表（先 org demo / org run）`);
    return 2;
  }
  const { kept, missing } = setRetained(a.workspace, names, retained);
  if (kept.length > 0) {
    const mark = retained ? "★" : "○";
    console.log(`${mark} ${action}：${kept.join(", ")}（git 留痕）`);
    console.log(retained
      ? "  候选已转正：B 路径自动复用从下一轮派单开始命中。"
      : "  已取消保留：B 路径不再自动复用（显式寻址 ?专家 与 C 路径记忆化派单仍可用）。");
  }
  if (missing.length > 0) {
    console.error(`✗ 未在注册表找到：${missing.join(", ")}`);
    return 1;
  }
  return 0;
}

// ---- 运行范围复核：本次运行产出的 harness 要不要沉淀进工具库 ----
// 与 org keep/drop 的分工：那两个是「按名字治理库里已有的资产」，review 是
// 「按运行范围复核这一次产出了什么、哪些值得沉淀」。范围由运行产物界定
// （mint-register / patch / channel=reuse 事件），不靠时间戳猜。
// 交互选取之外提供非交互通道（--keep/--all/--none/--dry-run），供脚本与
// 三前端（CLI · TUI · Web）共用同一套语义。

export type SelectionParse =
  | { kind: "ok"; picked: number[] }
  | { kind: "cancel" }
  | { kind: "invalid"; token: string };

/** 解析选取输入：编号列表（"1,3"）/ a（全选）/ n（全不选）/ q（取消）。空输入=全选。 */
export function parseSelection(input: string, count: number): SelectionParse {
  const s = input.trim().toLowerCase();
  if (s === "q" || s === "quit") return { kind: "cancel" };
  if (s === "" || s === "a" || s === "all") return { kind: "ok", picked: Array.from({ length: count }, (_, i) => i + 1) };
  if (s === "n" || s === "none") return { kind: "ok", picked: [] };
  const picked = new Set<number>();
  for (const raw of s.split(/[,，、\s]+/)) {
    if (raw.length === 0) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > count) return { kind: "invalid", token: raw };
    picked.add(n);
  }
  return { kind: "ok", picked: [...picked].sort((x, y) => x - y) };
}

/** 候选一行摘要（CLI 表格与 TUI/Web 同源字段）。 */
function candidateLine(c: ReviewCandidate): string {
  const parts: string[] = [];
  if (c.evalInRun) parts.push(`本次验收 ${c.evalInRun}`);
  parts.push(`库内评测 ${c.eval_score.toFixed(2)}`, `通过率 ${c.pass_rate.toFixed(2)}`);
  if (c.uses > 0) parts.push(`复用 ${c.uses} 次`);
  if (c.capabilities.length > 0) parts.push(`能力 ${c.capabilities.join("/")}`);
  const why = c.origin.includes("minted") ? "铸出" : c.origin.includes("patched") ? "补丁合入" : "复用命中";
  parts.push(`本次：${why}`);
  return parts.join(" · ");
}

/** 复核表打印（cmdReview 与 org demo 的 K 相位共用同一份呈现）。 */
function printReviewTable(pending: ReviewCandidate[], settled: ReviewCandidate[]): void {
  console.log("待决策候选（本次铸出/合入且尚未保留 —— 选取后转正，B 路径自动复用才命中）：");
  pending.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name}@${c.version}  [${c.source}]`);
    if (c.description) console.log(`     ${c.description}`);
    console.log(`     ${candidateLine(c)}`);
    if (c.patchNote) console.log(`     补丁：${c.patchNote}`);
  });
  if (settled.length > 0) {
    console.log("\n已在库保留（仅上下文，不参与本次选取）：");
    for (const c of settled) console.log(`  ${c.retained ? "★" : "○"} ${c.name}@${c.version}  [${c.source}]`);
  }
  console.log("");
}

async function cmdReview(a: Args): Promise<number> {
  const ws = a.workspace;
  if (!fs.existsSync(path.join(ws, "registry/index.json"))) {
    console.error(`✗ 工作区 ${ws} 无注册表（先 org demo / org run）`);
    return 2;
  }
  const runDir = a.runDir || latestHarnessRunDir(ws);
  if (!runDir) {
    console.error(`✗ 工作区 ${ws} 没有 run 产物目录（out-*）—— 先 org run / org demo`);
    return 2;
  }
  if (!fs.existsSync(runDir)) {
    console.error(`✗ 找不到运行产物目录：${runDir}`);
    return 2;
  }
  const { scope, pending, settled } = reviewCandidates(ws, runDir);
  if (!scope) {
    console.error(`✗ 找不到运行产物：${runDir}`);
    return 2;
  }

  console.log(`复核范围：${scope.label}（${path.relative(process.cwd(), scope.dir) || scope.dir}）`);
  console.log(`  任务 ${scope.task || "(未记录)"} · 模型 ${scope.model || "?"} · 结果 ${scope.ok ? "Ok" : "Err"}`);
  console.log(`  本次接触 harness ${pending.length + settled.length} 个：铸出 ${scope.minted.length} · 补丁 ${scope.patched.length} · 复用 ${scope.reused.length}\n`);

  if (pending.length === 0) {
    console.log("✓ 本次运行没有待决策候选（无新铸出/合入的未保留资产）。");
    if (settled.length > 0) {
      console.log(`  本次复用到的存量资产：${settled.map((c) => `${c.retained ? "★" : "○"} ${c.name}`).join(" · ")}`);
    }
    return 0;
  }

  printReviewTable(pending, settled);

  // ---- 显式非交互通道：--keep / --none / --all / --dry-run ----
  let chosen: string[] | null = null;
  if (a.keepList.length > 0) {
    const valid = new Set(pending.map((c) => c.name));
    const bad = a.keepList.filter((n) => !valid.has(n));
    if (bad.length > 0) {
      console.error(`✗ 不在本次待决策候选内：${bad.join(", ")}（可选：${pending.map((c) => c.name).join(", ")}）`);
      return 1;
    }
    chosen = a.keepList;
  } else if (a.reviewNone) {
    chosen = [];
  } else if (a.reviewAll) {
    chosen = pending.map((c) => c.name);
  } else if (a.dryRun) {
    console.log(`（--dry-run：未写入。选取保留请用 org review --keep ${pending.map((c) => c.name).join(",")} 或 --all）`);
    return 0;
  } else if (!process.stdin.isTTY) {
    console.error("✗ 非交互环境（stdin 非 TTY）：请显式给出选取 ——");
    console.error(`  org review --keep ${pending.map((c) => c.name).join(",")}   # 选取其中若干`);
    console.error("  org review --all    # 全选   ·   org review --none   # 全不选");
    return 2;
  } else {
    const answer = await askLine(`选取保留（编号逗号分隔 / a 全选 / n 全不选 / 回车全选 / q 取消）: `);
    if (answer === null) return 2;
    const parsed = parseSelection(answer, pending.length);
    if (parsed.kind === "cancel") {
      console.log("已取消，未写入任何变更。");
      return 0;
    }
    if (parsed.kind === "invalid") {
      console.error(`✗ 无法识别的输入「${parsed.token}」—— 请输入 1..${pending.length} 的编号、a、n 或 q`);
      return 2;
    }
    chosen = parsed.picked.map((n) => pending[n - 1]!.name);
  }

  if (chosen.length === 0) {
    console.log("○ 本次未选取任何候选 —— 全部保持候选态（资产保留在库，仅退出 B 路径自动复用）。");
  } else {
    const { kept, missing } = applyReview(ws, chosen);
    console.log(`★ 已选取保留：${kept.join(", ")}（git 留痕，B 路径自动复用从下一轮派单命中）`);
    if (missing.length > 0) console.error(`✗ 未在注册表找到：${missing.join(", ")}`);
    const rest = pending.filter((c) => !chosen.includes(c.name)).map((c) => c.name);
    if (rest.length > 0) console.log(`○ 保持候选（未选取）：${rest.join(", ")} —— 需要时 org keep <name> 或重跑 org review`);
  }

  // 复核中显式降权（--drop）：把已保留资产退回候选态
  if (a.dropList.length > 0) {
    const { kept: dropped, missing } = setRetained(ws, a.dropList, false);
    if (dropped.length > 0) console.log(`○ 已取消保留：${dropped.join(", ")}（退出 B 路径自动复用，git 留痕）`);
    if (missing.length > 0) console.error(`✗ 未在注册表找到：${missing.join(", ")}`);
  }
  return 0;
}

/** 单行提问（交互选取用）。stdin 非 TTY 返回 null（调用方转非交互通道）。 */
function askLine(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ---- 版本回退（org revert）----
// 「反悔」通道：把归档源还原为在岗源（金丝雀回滚用的是同一批归档源），
// 当前源先归档 → 回退本身可逆，注册表版本号随之回退并 git 留痕。
// 对应 opencode 的 /undo 与 codex 的 diff/revert。
// ---- 用量/成本时间线（org cost）----
// llm_stream_done 的消费面：「成本结构随资产沉淀下降」这个核心叙事的逐调用证据。
// 注意 scripted 剧本车道不经过网关 → 没有 llm_stream_done，此时诚实说明而不是显示 0。
async function cmdCost(a: Args): Promise<number> {
  const dir = a.runDir || latestScorecardDir(a.workspace) || latestHarnessRunDir(a.workspace);
  if (!dir) {
    console.error("✗ 没有可读的运行产物 —— 先 org run / org demo，或用 --run <dir> 指定");
    return 2;
  }
  const t = readCostTimeline(dir);
  console.log(`运行 ${path.relative(process.cwd(), dir) || dir}`);
  console.log(renderCostTimeline(t));
  if (t.calls > 0) {
    console.log("");
    console.log("逐次调用：");
    for (const c of t.calls.slice(0, 20)) {
      console.log(`  ${c.ts}  ${c.track.padEnd(24)} ${String(c.chars).padStart(6)} 字` +
        `${c.reasoningChars > 0 ? " (思考 " + c.reasoningChars + ")" : ""}  ${(c.elapsedMs / 1000).toFixed(1)}s` +
        `${c.tokens != null ? "  " + c.tokens + " tok" : ""}`);
    }
    if (t.calls.length > 20) console.log(`  … 另有 ${t.calls.length - 20} 次（完整列表见 events.jsonl）`);
  }
  return 0;
}

// ---- 交互式审批队列（org approvals）----
// 审批是「文件协议」而非进程内通道（图执行当前没有挂起点）：HSL 侧
// hsl/policy/approval.hsl 落 <id>.json 并有界轮询 <id>.reply.json。
// 因此本命令在**另一个终端**里跑就能给运行中的 run 放行 —— 也可以由
// Web 面板或任何写这个文件的东西代劳（三端同权）。
async function cmdApprovals(a: Args): Promise<number> {
  const verb = a.rest[0] ?? "";
  if (verb === "allow" || verb === "always" || verb === "deny") {
    const id = a.rest[1] ?? "";
    const allow = verb !== "deny";
    const r = decideApproval(a.workspace, id, allow, verb === "always", "cli");
    if (!r.ok) { console.error(`✗ ${r.error}`); return r.status === 400 ? 2 : 1; }
    console.log(`${allow ? "✓ 已放行" : "✗ 已拒绝"} ${id}${verb === "always" ? "（并写入长期放行集）" : ""}`);
    return 0;
  }
  if (verb === "clear") {
    clearGranted(a.workspace);
    console.log("✓ 已清空长期放行集（之后同类能力会重新询问）");
    return 0;
  }

  // 缺省：列出待批准 + 长期放行集
  const { pending, granted, resolved } = listApprovals(a.workspace);
  if (pending.length === 0) {
    console.log("✓ 没有待批准的项。");
  } else {
    console.log(`待批准 ${pending.length} 项：`);
    for (const p of pending) {
      console.log(`  ${p.id}  [${p.capability}]`);
      console.log(`     ${p.action}`);
      if (p.detail) console.log(`     ${p.detail.slice(0, 120)}`);
    }
    console.log("");
    console.log("放行：org approvals allow <id>   · 长期放行：org approvals always <id>   · 拒绝：org approvals deny <id>");
  }
  if (granted.length > 0) {
    console.log(`长期放行集：${granted.join(", ")}（org approvals clear 可清空）`);
  }
  if (resolved.length > 0) {
    const last = resolved[0]!;
    console.log(`已判定 ${resolved.length} 条（最近：${last.id} ${last.resolved.allow ? "放行" : "拒绝"} by ${last.resolved.by}）`);
  }
  if (pending.length > 0) {
    console.log("");
    console.log("提示：请求来自运行中的 run（org run --approval / TUI / Web）。");
    console.log("     超时未回复会被降级为拒绝，run 不会被挂住。");
  }
  return 0;
}

async function cmdRevert(a: Args): Promise<number> {
  const name = (a.rest[0] ?? "").toLowerCase();
  if (!name) {
    console.error("用法：org revert <expert> [--to <x.y.z>] [--workspace DIR]");
    const experts = loadRegistryIndex(a.workspace).filter((m) => m.source !== "manual");
    if (experts.length > 0) {
      console.error("候选（有工厂谱系的专家）：");
      for (const m of experts) {
        const vers = archivedVersions(a.workspace, m.name);
        console.error(`  ${m.name}@${m.version}${vers.length ? "  可回退：" + vers.join(", ") : "  （无归档版本）"}`);
      }
    }
    return 2;
  }
  if (!fs.existsSync(path.join(a.workspace, "registry/index.json"))) {
    console.error(`✗ 工作区 ${a.workspace} 无注册表（先 org demo / org run）`);
    return 2;
  }
  try {
    const r = revertExpert(a.workspace, name, a.toVersion || undefined);
    console.log(`↩ 已回退 ${r.name}：${r.from} → ${r.to}（git 留痕）`);
    console.log(`  在岗源：${path.relative(process.cwd(), r.live)}`);
    if (r.archived) console.log(`  当前源已归档：${path.relative(process.cwd(), r.archived)}（回退可逆，再 revert 可回到 ${r.from}）`);
    const rest = archivedVersions(a.workspace, name);
    if (rest.length > 0) console.log(`  其它可回退版本：${rest.join(", ")}`);
    return 0;
  } catch (err) {
    console.error(`✗ 回退失败：${(err as Error).message}`);
    return 1;
  }
}

// ---- 会话管理（org session fork|rename|rm）----
// Web 早有会话改名/删除端点，TUI/CLI 没有 —— 这里补齐 CLI 面，并补上 Web/chat
// 都没有的 **派生（fork）**：账本 append-only，复制即分叉，上下文从派生点续跑。
async function cmdSession(a: Args): Promise<number> {
  const [verb, expert, p1, p2] = [a.rest[0] ?? "", (a.rest[1] ?? "").toLowerCase(), a.rest[2] ?? "", a.rest[3] ?? ""];
  const usage = (): number => {
    console.error("用法：");
    console.error("  org session fork <expert> <from> <to>    派生会话（原会话不受影响）");
    console.error("  org session rename <expert> <from> <to>  会话改名");
    console.error("  org session rm <expert> <session>        删除会话（删账本文件）");
    return 2;
  };
  if (!verb || !expert) return usage();
  // 注：会话操作只碰 runtime/sessions/<expert>/*.jsonl，不读注册表 ——
  // 不设「工作区必须有 registry」的门槛（否则纯会话工作区用不了）。
  try {
    if (verb === "fork") {
      if (!p1 || !p2) return usage();
      const r = forkSession(a.workspace, expert, p1, p2);
      console.log(`⑂ 已派生会话 ${r.expert}/${r.from} → ${r.to}（${r.turns} 轮上下文，原会话不变）`);
      console.log(`  继续对话：org chat ${r.expert} --session ${r.to} --continue`);
      return 0;
    }
    if (verb === "rename" || verb === "mv") {
      if (!p1 || !p2) return usage();
      renameSession(a.workspace, expert, p1, p2);
      console.log(`✓ 已改名 ${expert}/${p1} → ${p2}`);
      return 0;
    }
    if (verb === "rm" || verb === "delete") {
      if (!p1) return usage();
      deleteSession(a.workspace, expert, p1);
      console.log(`✓ 已删除会话 ${expert}/${p1}（账本是唯一事实源：删文件即删会话）`);
      return 0;
    }
    return usage();
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

async function cmdStatus(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  console.log(`ORG status · 工作区 ${ws}\n`);
  // 注册表
  const index = path.join(ws, "registry/index.json");
  if (fs.existsSync(index)) {
    const experts = JSON.parse(fs.readFileSync(index, "utf-8")) as Array<Record<string, unknown>>;
    const candidates = experts.filter((m) => m.source === "factory" && m.retained === false);
    console.log("registry（磁盘资产层）：");
    for (const m of experts) {
      const mark = m.retained === false ? "○" : "★";
      const tag = m.retained === false ? "candidate" : "retained";
      console.log(`  ${mark} ${m.name}@${m.version} [${m.source}] eval=${m.eval_score} uses=${m.uses} ${tag} entry=${m.entry}`);
    }
    if (candidates.length > 0) {
      console.log(`\n  ○ 候选 ${candidates.length} 个未保留 —— B 路径不自动复用；org keep <name> 转正 / org drop <name> 取消保留`);
    }
  } else {
    console.log("registry：空（未初始化工作区）");
  }
  // 资产
  const memos = path.join(ws, "registry/memos/notice-parser.json");
  if (fs.existsSync(memos)) {
    const memo = JSON.parse(fs.readFileSync(memos, "utf-8")) as Record<string, { memos?: Record<string, string> }>;
    console.log(`\n固化 memo（notice-parser）：${Object.keys(memo.memos ?? {}).length} 条冻结映射`);
  }
  const mined = path.join(ws, "registry/fixtures-mined/reviews.json");
  if (fs.existsSync(mined)) {
    const m = JSON.parse(fs.readFileSync(mined, "utf-8")) as { tracks?: Record<string, unknown> };
    console.log(`基准题沉淀（journal→fixture）：${Object.keys(m.tracks ?? {}).length} 条轨道`);
  }
  const baseline = path.join(ws, "registry/scorecards");
  if (fs.existsSync(baseline)) {
    console.log(`评分卡基线：${fs.readdirSync(baseline).join(", ")}`);
  }
  const recurrence = path.join(ws, "runtime/recurrence.json");
  if (fs.existsSync(recurrence)) {
    const rec = JSON.parse(fs.readFileSync(recurrence, "utf-8")) as Record<string, number>;
    if (Object.keys(rec).length > 0) {
      console.log(`复发计数（补丁判据）：${JSON.stringify(rec)}`);
    }
  }
  // 会话账本（含上下文窗口占用 —— Codex 风格计量）
  const usages = listContextUsage(ws);
  if (usages.length > 0) {
    console.log("\n直连会话账本（上下文窗口占用 · GLM-4.5 窗口 128k tokens）：");
    for (const u of usages) {
      console.log(`  ${u.expert}/${u.session} ${u.turns} 轮 · 记账 ${u.billed} tokens · ctx ${renderContextMeter(u)}`);
    }
  }
  // git 历史
  const log = gitLogOf(ws);
  if (log.length > 0) {
    console.log(`\ngit 注册表历史（${log.length} commits）：`);
    for (const l of log.slice(0, 8)) console.log(`  ${l}`);
  }
  // 运行产物
  const runDirs = ["out-a", "out-b", "out-c", "out-latest", "out-ask", "out-direct", "out-handoff"]
    .map((d) => path.join(ws, d))
    .filter((d) => fs.existsSync(path.join(d, "run.json")));
  if (runDirs.length > 0) {
    console.log("\n历史运行：");
    for (const d of runDirs) {
      const rj = JSON.parse(fs.readFileSync(path.join(d, "run.json"), "utf-8")) as { ok: boolean; task?: string; elapsed_ms?: number };
      console.log(`  ${path.basename(d)} ok=${rj.ok} ${(rj.elapsed_ms ?? 0) / 1000 | 0}s ${(rj.task ?? "").slice(0, 40)}`);
    }
  }
  return 0;
}

async function cmdScore(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const candidates = ["out-c", "out-b", "out-a", "out-latest"]
    .map((d) => path.join(ws, d, "scorecard.json"))
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) {
    console.log("尚无评分卡（先跑 org demo / org run）");
    return 0;
  }
  const card = JSON.parse(fs.readFileSync(candidates[0]!, "utf-8")) as {
    model: string; evidence_count: number; cells: Array<{ cell: string; score: number; confidence: number }>;
  };
  console.log(`scorecard · model=${card.model} · evidence=${card.evidence_count}（来源 ${path.relative(ROOT, candidates[0]!)}）`);
  // 轴名匹配：cell 格式为 "能力轴|任务类"。--axis 同时接受两侧（能力轴或任务类），
  // 任一侧命中即保留——此前只匹配能力轴侧，README 示例的 structured_extract（任务类）
  // 过滤后沉默输出空列表（axis 拼写元反馈缺失）。
  const cells = a.axis
    ? card.cells.filter((c) => c.cell.startsWith(a.axis + "|") || c.cell.endsWith("|" + a.axis))
    : card.cells;
  for (const c of cells) {
    console.log(`  ${c.cell.padEnd(38)} score=${c.score.toFixed(3)} confidence(n)=${c.confidence}`);
  }
  if (a.axis && cells.length === 0) {
    // 空 results 必须给出可行动反馈：列出当前卡上真实的能力轴与任务类，
    // 拼写错误当场可见（此前空输出无法区分「无数据」与「过滤词拼错」）。
    const axes = [...new Set(card.cells.map((c) => c.cell.split("|")[0]!))];
    const classes = [...new Set(card.cells.map((c) => c.cell.split("|")[1]!))];
    console.log(`\n⚠ --axis "${a.axis}" 未命中任何 cell（格式 axis|task_class，两侧任一匹配）。`);
    console.log(`  可用能力轴：${axes.join(", ")}`);
    console.log(`  可用任务类：${classes.join(", ")}`);
  }
  console.log("\n证据分级：客观行为信号（verdict/budget/crystallize/canary/direct）权重 1.0；裁判档（shadow_compare）0.5。");
  return 0;
}

async function cmdReplay(a: Args): Promise<number> {
  if (!a.runDir || !fs.existsSync(path.join(a.runDir, "journal.jsonl"))) {
    console.error("✗ --run <dir> 需指向含 journal.jsonl 的运行产物目录（如 demo-run/out-a）");
    return 2;
  }
  const lines = fs.readFileSync(path.join(a.runDir, "journal.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim().length > 0);
  console.log(`replay · ${path.relative(ROOT, a.runDir)}（${lines.length} 条期刊记录，时间线重演）\n`);
  let lastPhase = "";
  for (const l of lines) {
    // v0.4.17：复用 lib/events.ts parseJournalLine（detail 可含 "|"，
    // 取 slice(5).join("|")）—— 此前手写 split("|") 解构只取第 6 段，
    // detail 里的 "|" 后半被静默截断（与事件泵/重演面板口径不一致）。
    const raw = parseJournalLine(l);
    if (!raw) continue;
    if (raw.phase !== lastPhase) {
      console.log(`\n[阶段 ${raw.phase}]`);
      lastPhase = raw.phase;
    }
    console.log(`  ${raw.actor.padEnd(10)} ${raw.action.padEnd(14)} ${raw.detail.slice(0, 90)}`);
  }
  console.log("\n（确定性重放 = journal + 代码版本；scripted 剧本即当时的模型响应录制）");
  return 0;
}

async function cmdCheck(): Promise<number> {
  console.log(`dhv check · ORG 全源码（解释器 ${path.relative(ROOT, DHV)}）\n`);
  const files: string[] = [];
  // 跳过本地运行时工作区（demo-run / demo-run-tests / out-ask 均 git 忽略）：
  // 测试跑过后 demo-run-tests 会出现铸出专家副本，check 的模块清单不应随本地
  // 状态漂移（稳定口径 = hsl/ 源码 + dist/ 入库产物 + .hsl-runs 之外的库文件）。
  const skip = new Set([".git", "node_modules", ".hsl-runs", "demo-run", "demo-run-tests", "out-ask"]);
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(p);
      } else if (e.name.endsWith(".hsl")) files.push(p);
    }
  };
  walk(ROOT);
  // 顺序：入口优先（其 import 链最先建立），stock 与 probe 随后
  files.sort((x, y) => {
    const rank = (p: string): number =>
      p.endsWith("org.hsl") ? 0 : p.includes("probe/") ? 2 : 1;
    return rank(x) - rank(y) || x.localeCompare(y);
  });
  let failed = 0;
  for (const f of files) {
    const ok = await checkFile(f);
    if (!ok) failed += 1;
  }
  console.log(`\n${failed === 0 ? "✓" : "✗"} ${files.length} 个 HSL 模块（${failed} 失败）`);
  return failed === 0 ? 0 : 1;
}

// ---- TUI（OpenCode 级终端前端；实现见 tui/，规格见 docs/tui-spec.md） ----
// 进程内加载（源码与编译二进制同路径；bun compile 会把 tui/ 静态打进单文件）
async function cmdTui(a: Args): Promise<number> {
  const { tuiMain } = await import("../tui/entry.ts");
  const args: string[] = [];
  if (a.workspace) args.push("--workspace", a.workspace);
  if (a.model && a.model !== "scripted") args.push("--model", a.model);
  args.push(...a.rest);
  return tuiMain(args);
}

// ---- Web GUI 原型（Bun.serve 零依赖；实现见 web/entry.ts） ----
// 进程内加载（与 cmdTui 同模式：bun compile 会把 web/ 静态打进单文件）
async function cmdWeb(a: Args): Promise<number> {
  const { webMain } = await import("../web/entry.ts");
  const args: string[] = [];
  if (a.workspace) args.push("--workspace", a.workspace);
  if (a.model && a.model !== "scripted") args.push("--model", a.model);
  args.push(...a.rest); // --port N 由此转交（parseArgs 不认识的旗标进 rest）
  return webMain(args);
}

// ---- 交互式聊天 REPL（v0.4.15 · codex/opencode 级交互面） ----
// 进程内加载（与 cmdTui 同模式）；实现见 cli/chat.ts
// 注意：chat 是写命令（会话账本/纪要落盘）—— 不走 defaultWorkspace 读回退
// （dist/demo 入库快照只读），与 cmdAsk 同用 ensureWorkspace 初始化活工作区。
async function cmdChat(a: Args): Promise<number> {
  const { chatMain } = await import("./chat.ts");
  ensureWorkspace(a.workspace);
  const args: string[] = [];
  if (a.rest[0]) args.push(a.rest[0]); // 专家名（可缺省 → 首个保留专家）
  if (a.session && a.session !== "default") args.push("--session", a.session);
  if (a.model && a.model !== "scripted") args.push("--model", a.model);
  if (a.continue) args.push("--continue");
  args.push("--workspace", a.workspace);
  return chatMain(args);
}

// ---- 会话清单（org sessions：跨专家列会话账本；/sessions 单专家版在 chat REPL 内） ----
async function cmdSessions(a: Args): Promise<number> {
  const { listSessions } = await import("./chat.ts");
  const expert = a.rest[0] ?? "";
  ensureWorkspace(a.workspace);
  const experts = expert
    ? [expert]
    : loadRegistryIndex(a.workspace).map((m) => m.name);
  if (experts.length === 0) { console.log("（注册表为空）"); return 0; }
  let any = false;
  for (const name of experts) {
    const list = listSessions(a.workspace, name);
    if (list.length === 0) continue;
    any = true;
    console.log(`◆ ${name}`);
    for (const s of list) {
      console.log(`    ${s.session.padEnd(24)} ${String(s.turns).padStart(3)} 轮 · ${String(s.tokens).padStart(7)} tok · ctx ${renderContextMeter({ context: s.ctx_tokens, window: 131072 })}`);
      console.log(`      ↳ ${s.lastQuestion}`);
    }
  }
  if (!any) console.log("（无会话账本 · org chat <expert> 开始对话）");
  return 0;
}

// ---- org config：用户模型/API 配置（v0.4.16） ----------------------------
async function cmdConfig(a: Args): Promise<number> {
  const [verb, ...rest] = a.rest;
  const file = configPath();

  if (verb === undefined || verb === "list" || verb === "get") {
    // 查看当前生效配置（值 + 来源归因：env > file > default）
    if (verb === "get") {
      const key = normalizeKey(rest[0] ?? "");
      if (!key) { console.error(`✗ 未知配置项：${rest[0] ?? ""}（可配置项：${CONFIG_KEYS.join(", ")}）`); return 2; }
      const { value, source } = effectiveValue(key);
      console.log(key === "api_key" || key === "api_keys" ? maskSecret(value) : value);
      if (process.stderr.isTTY) console.error(`  （来源：${source}）`);
      return 0;
    }
    const cfg = loadConfig();
    const exists = fs.existsSync(file);
    console.log(`ORG 用户配置 —— ${file}${exists ? "" : "（不存在，全部走缺省）"}\n`);
    const LABELS: Record<string, string> = {
      gateway: "网关端点", api_key: "鉴权密钥", model: "模型名",
      thinking: "思考档位", timeout_ms: "超时(ms)", default_lane: "缺省车道",
      api_keys: "key 池", fallbacks: "降级链", budget_requests: "日预算(次)",
    };
    for (const k of CONFIG_KEYS) {
      const { value, source } = effectiveValue(k, cfg);
      const shown = k === "api_key" || k === "api_keys" ? maskSecret(value) : value;
      const srcLabel = source === "env" ? "环境变量" : source === "file" ? "配置文件" : "缺省";
      console.log(`  ${String(k).padEnd(16)} ${LABELS[k] ?? k}：${shown.length > 0 ? shown : "（未配置）"}   ← ${srcLabel}`);
    }
    const preset = Object.entries(PRESETS).find(([, p]) => p.gateway === effectiveValue("gateway", cfg).value)?.[0];
    if (preset) console.log(`\n  已匹配预设：${preset}（${PRESETS[preset]!.label}）`);
    // v0.5.1：车道表 + 环境变量发现
    const laneNames = Object.keys(cfg.lanes);
    if (laneNames.length > 0) {
      console.log(`\n  命名车道（${laneNames.length} 条 · org config use <name> 切换）：`);
      for (const name of laneNames) {
        const l = cfg.lanes[name]!;
        const keyCount = (l.api_key ? 1 : 0) + l.api_keys.length;
        const mark = cfg.default_lane === name ? "→" : " ";
        console.log(`  ${mark} ${name.padEnd(12)} ${l.model || "（未设模型）"} · key×${keyCount}${l.fallbacks.length > 0 ? ` · 降级→ ${l.fallbacks.join(",")}` : ""}`);
      }
    }
    const env = discoverEnvLanes();
    if (env.length > 0) {
      console.log(`\n  环境变量发现（${env.length} 家服务商 key 已在 shell 中）：`);
      for (const d of env) console.log(`    ${d.provider.padEnd(12)} ← ${d.envName}`);
    }
    console.log(`\n  命令：org config set/unset · preset <name> · lane <name> set <field> <v> · keys add <k> · fallback "a,b" · use <name> · auto · test`);
    console.log(`  预设：${PROVIDER_NAMES.slice(0, 8).join(" · ")} … 共 ${PROVIDER_NAMES.length} 家（org config presets 查看全部）`);
    return 0;
  }

  if (verb === "set" || verb === "unset") {
    if (verb === "set") {
      const key = setConfigValue(rest[0] ?? "", rest[1] ?? "");
      if (!key) { console.error(`✗ 未知配置项：${rest[0] ?? ""}（可配置项：${CONFIG_KEYS.join(", ")}；别名 key/keys/lane/base_url/fallback/budget 也接受）`); return 2; }
      const shown = key === "api_key" || key === "api_keys" ? maskSecret(rest[1] ?? "") : rest[1] ?? "";
      console.log(`✓ ${key} = ${shown}（已写入 ${path.basename(file)}）`);
      return 0;
    }
    const key = unsetConfigValue(rest[0] ?? "");
    if (!key) { console.error(`✗ 未知配置项：${rest[0] ?? ""}`); return 2; }
    console.log(`✓ ${key} 已清空（${path.basename(file)}）`);
    return 0;
  }

  if (verb === "preset" || verb === "presets") {
    if (verb === "presets" || rest.length === 0) {
      console.log(`可用预设（${PROVIDER_NAMES.length} 家 · OpenAI 兼容协议一条打天下）：\n`);
      for (const [name, p] of Object.entries(PRESETS)) {
        console.log(`  ${name.padEnd(12)} ${p.label}`);
        console.log(`               ${p.gateway}${p.model ? ` · ${p.model}` : ""}`);
        console.log(`               ${p.note}`);
      }
      return 0;
    }
    const name = applyPreset(rest[0] ?? "");
    if (!name) { console.error(`✗ 未知预设：${rest[0]}（org config presets 查看全部）`); return 2; }
    const p = PRESETS[name]!;
    console.log(`✓ 已应用预设 ${name} —— ${p.label}（建为命名车道并设为缺省）`);
    console.log(`  gateway = ${p.gateway}`);
    console.log(`  model   = ${p.model.length > 0 ? p.model : "（待填：org config set model <本地模型名>）"}`);
    console.log(`  ${p.note}`);
    if (p.note.includes("必填")) console.log(`  下一步：org config set api_key <你的密钥>（多 key：org config keys add <k>）`);
    return 0;
  }

  // ---- v0.5.1：命名车道管理 ----
  if (verb === "lane") {
    const [sub, name, field, value] = rest;
    if (!sub || sub === "list") {
      const cfg = loadConfig();
      const names = Object.keys(cfg.lanes);
      if (names.length === 0) { console.log("（无命名车道 · org config preset <name> 一键创建）"); return 0; }
      console.log("命名车道：\n");
      for (const n of names) {
        const l = cfg.lanes[n]!;
        const keyCount = (l.api_key ? 1 : 0) + l.api_keys.length;
        console.log(`  ${cfg.default_lane === n ? "→" : " "} ${n.padEnd(12)} ${l.provider ? `[${l.provider}] ` : ""}${l.model || "（未设模型）"} · ${l.gateway || "（未设网关）"} · key×${keyCount}`);
        if (l.fallbacks.length > 0) console.log(`      降级链 → ${l.fallbacks.join(" → ")}`);
      }
      return 0;
    }
    if (sub === "set") {
      if (!name || !field || value === undefined) {
        console.error('用法：org config lane <name> set <field> <value>（field：gateway/api_key/model/thinking/timeout_ms/provider/api_keys/fallbacks）');
        return 2;
      }
      const n = setLaneValue(name, field, Array.isArray(value) ? value.join(",") : value);
      if (!n) { console.error(`✗ 车道名/字段非法（name：^[a-z0-9_-]+$ 且非 scripted；field 见用法）`); return 2; }
      const shown = field.includes("key") ? maskSecret(String(value)) : String(value);
      console.log(`✓ 车道 ${n}.${field} = ${shown}（已写入 ${path.basename(file)}）`);
      return 0;
    }
    if (sub === "rm" || sub === "remove") {
      const n = removeLane(name ?? "");
      if (!n) { console.error(`✗ 车道不存在：${name ?? ""}`); return 2; }
      console.log(`✓ 车道 ${n} 已删除`);
      return 0;
    }
    if (sub === "test") {
      const cfg = loadConfig();
      const lane = (name && cfg.lanes[name]) ? resolveModelFlag(name) : resolveModelFlag("");
      return printLaneTest(lane);
    }
    console.error(`✗ 未知 lane 子命令：${sub}（可用：list/set/rm/test）`);
    return 2;
  }

  if (verb === "use") {
    const n = useLane(rest[0] ?? "");
    if (!n) {
      const cfg = loadConfig();
      console.error(`✗ 车道不存在：${rest[0] ?? ""}（现有：${Object.keys(cfg.lanes).join(", ") || "无"}）`);
      return 2;
    }
    console.log(`✓ 缺省车道 → ${n}（平面配置已镜像 · chat/run/ask 免 --model）`);
    return 0;
  }

  if (verb === "keys") {
    const [sub, key] = rest;
    if (sub === "add") {
      if (!key) { console.error("用法：org config keys add <api-key>（追加到 key 池 · 429 自动轮换）"); return 2; }
      const n = addApiKey(key);
      console.log(`✓ key 池已有 ${n} 个 key（429/5xx 自动轮换 · 路由器台账归因）`);
      return 0;
    }
    if (sub === "clear") {
      const key0 = setConfigValue("api_keys", "");
      if (!key0) { console.error("✗ 清空失败"); return 2; }
      console.log("✓ key 池已清空（主 api_key 保留）");
      return 0;
    }
    console.error(`✗ 未知 keys 子命令：${sub}（可用：add/clear）`);
    return 2;
  }

  if (verb === "auto") {
    const created = autoFromEnv();
    if (created.length === 0) {
      console.log("（未发现任何服务商环境变量 —— 支持的变量名：");
      for (const [name, spec] of Object.entries(PROVIDERS)) {
        if (spec.envKeys.length > 0) console.log(`    ${name.padEnd(12)} ${spec.envKeys.join(" | ")}`);
      }
      console.log("）");
      return 0;
    }
    console.log(`✓ 已为 ${created.length} 家发现的服务商创建车道：${created.join(", ")}`);
    console.log(`  缺省车道 → ${created[0]}（org config use <name> 换缺省）`);
    console.log(`  下一步：org config test 验证连通 · org providers 查看全部车道健康`);
    return 0;
  }

  if (verb === "path") {
    console.log(file);
    return 0;
  }

  if (verb === "test") {
    // 真实连通性测试：当前生效车道发一次 1-token 请求（「配了没生效」立即暴露）
    const lane = rest[0] ? resolveModelFlag(rest[0]) : resolveModelFlag("");
    return printLaneTest(lane);
  }

  console.error(`✗ 未知子命令：${verb}（可用：get/list/set/unset/preset/presets/lane/use/keys/auto/path/test）`);
  return 2;
}

/** 车道连通测试的统一打印（org config test / org config lane test 共用）。 */
async function printLaneTest(lane: import("../lib/providers.ts").ResolvedLane): Promise<number> {
  if (lane.kind === "scripted") { console.log("✓ 剧本车道（scripted · 零外联无需测试）"); return 0; }
  if (lane.gateway.length === 0) { console.error(`✗ 车道 ${lane.name} 未配置网关（org config preset <name>）`); return 2; }
  if (lane.model.length === 0) { console.error(`✗ 车道 ${lane.name} 未配置模型名（org config set model <name>）`); return 2; }
  console.log(`→ 车道 ${lane.name} · ${lane.origin}`);
  console.log(`  POST ${lane.gateway}/chat/completions · model=${lane.model} · key 池×${lane.keys.length}`);
  const r = await testLane(lane);
  if (r.ok) {
    console.log(`✓ 连通正常（${r.ms}ms · 回复「${r.reply ?? ""}」 · tokens=${r.tokens ?? "?"} · 试了 ${r.triedKeys ?? 1} 个 key）`);
    return 0;
  }
  console.error(`✗ 失败（${r.ms}ms · 试了 ${r.triedKeys ?? 1} 个 key）：${r.error ?? "未知错误"}`);
  return 1;
}

// ---- org task：长程任务队列（v0.5.2） ----------------------------------------

const TASK_STATUS_MARK: Record<TaskStatus, string> = {
  queued: "…", running: "▶", paused: "⏸", done: "✓", failed: "✗", cancelled: "⊘",
};

async function cmdTask(a: Args): Promise<number> {
  const [verb, ...rest] = a.rest;
  const ws = defaultWorkspace(a);

  if (verb === undefined || verb === "list") {
    const status = rest[0] as TaskStatus | undefined;
    const tasks = listTasks(ws, status ? { status } : undefined);
    console.log(`任务队列 · ${ws}/runtime/tasks（执行器状态见 org taskd）\n`);
    if (tasks.length === 0) {
      console.log("（空 —— org task submit --task \"...\" 入队）");
      return 0;
    }
    for (const t of tasks) {
      const mark = TASK_STATUS_MARK[t.status] ?? "?";
      const time = (t.finished_at ?? t.started_at ?? t.created_at).slice(11, 19);
      const body = t.kind === "ask" ? `ask ${t.spec.expert} · ${String(t.spec.question ?? "").slice(0, 30)}` : String(t.spec.task ?? "").slice(0, 40);
      const extra = t.result ? ` · ${t.result.summary.slice(0, 40)}` : t.error ? ` · ${t.error.slice(0, 40)}` : "";
      console.log(`  ${mark} ${t.id.padEnd(16)} P${t.priority} ${time} ${t.status.padEnd(9)} ${body}${extra}`);
    }
    const queuedN = tasks.filter((t) => t.status === "queued").length;
    if (queuedN > 0) console.log(`\n  待执行 ${queuedN} 个 —— org taskd 启动守护执行（或 org task run-next 前台单发）`);
    return 0;
  }

  if (verb === "submit" || verb === "ask") {
    ensureWorkspace(a.workspace);
    const spec = {
      task: verb === "submit" ? a.task : undefined,
      expert: verb === "ask" ? rest[0] : undefined,
      question: verb === "ask" ? rest.slice(1).join(" ") : undefined,
      session: verb === "ask" ? a.session : undefined,
      model: a.model,
      approval: verb === "submit",
    };
    try {
      const t = submitTask(a.workspace, verb === "ask" ? "ask" : "run", spec, { priority: a.priority });
      console.log(`✓ 已入队 ${t.id}（P${t.priority} · ${t.kind}${t.kind === "ask" ? ` ${t.spec.expert}` : ""} · 模型 ${t.spec.model}）`);
      console.log(`  追踪：org task show ${t.id} · 执行：org taskd（守护）或 org task run-next（前台单发）`);
      if (!a.quiet) console.log(`  产物将落 out-task-${t.id}（独立目录，与前台操作并行不冲突）`);
      return 0;
    } catch (e) {
      console.error(`✗ 入队失败：${(e as Error).message}`);
      return 2;
    }
  }

  if (verb === "show") {
    const id = rest[0] ?? "";
    const t = getTask(ws, id);
    if (!t) { console.error(`✗ 任务不存在：${id}`); return 2; }
    console.log(`任务 ${t.id}（${t.status}）`);
    console.log(`  类型 ${t.kind}${t.kind === "ask" ? ` · 专家 ${t.spec.expert}` : ""} · 优先级 P${t.priority} · 模型 ${t.spec.model} · 尝试 ${t.attempts + 1} 次`);
    if (t.kind === "ask") console.log(`  问题：${t.spec.question}`);
    else console.log(`  任务：${t.spec.task}`);
    if (t.run_dir) console.log(`  产物：${t.run_dir}`);
    if (t.result) console.log(`  结果：${t.result.summary}`);
    if (t.error) console.log(`  错误：${t.error}`);
    if (t.paused_inproc) console.log(`  ⚠ inproc 车道暂停为降级语义（本轮自然结束后停领）`);
    const j = readTaskJournal(ws, id);
    if (j.length > 0) {
      console.log(`\n  审计（${j.length} 条）：`);
      for (const line of j.slice(-10)) {
        const [, ev, detail] = line.split("|");
        console.log(`    ${(ev ?? "").padEnd(16)} ${detail ?? ""}`);
      }
    }
    return 0;
  }

  if (verb === "cancel" || verb === "pause" || verb === "resume" || verb === "retry") {
    const id = rest[0] ?? "";
    const fn = verb === "cancel" ? cancelTask : verb === "pause" ? pauseTask : verb === "resume" ? resumeTask : retryTask;
    const r = fn(ws, id);
    if (!r.ok) { console.error(`✗ ${(r as { error?: string }).error ?? "操作失败"}`); return 2; }
    console.log(`✓ ${verb} ${id} → ${r.status}`);
    return 0;
  }

  if (verb === "run-next") {
    ensureWorkspace(a.workspace);
    const t = await runNextTask(a.workspace);
    if (!t) { console.log("（队列空）"); return 0; }
    console.log(`${TASK_STATUS_MARK[t.status] ?? "?"} ${t.id} → ${t.status}${t.result ? ` · ${t.result.summary.slice(0, 60)}` : ""}`);
    return t.status === "done" ? 0 : 1;
  }

  if (verb === "logs") {
    const id = rest[0] ?? "";
    const t = getTask(ws, id);
    if (!t?.run_dir) { console.error(`✗ 任务无产物目录（先执行）`); return 2; }
    const events = path.join(t.run_dir, "events.jsonl");
    if (!fs.existsSync(events)) { console.error(`✗ 无 events.jsonl`); return 2; }
    const lines = fs.readFileSync(events, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.slice(-40)) {
      try {
        const e = JSON.parse(line) as { name: string; data?: Record<string, unknown> };
        console.log(`  ${e.name.padEnd(24)} ${JSON.stringify(e.data ?? {}).slice(0, 90)}`);
      } catch { console.log(`  ${line.slice(0, 100)}`); }
    }
    return 0;
  }

  console.error(`✗ 未知子命令：${verb}（可用：list/submit/ask/show/cancel/pause/resume/retry/run-next/logs）`);
  return 2;
}

// ---- org taskd：守护执行器（v0.5.2） ------------------------------------------

async function cmdTaskd(a: Args): Promise<number> {
  const ws = a.workspace;
  ensureWorkspace(ws);
  const concurrency = Number((process.env.ORG_TASK_CONCURRENCY ?? "1").trim() || "1");
  const runner = new TaskRunner(ws, { concurrency });
  if (!runner.acquireLock()) {
    console.error("✗ 已有执行器在跑（本工作区 runner lock 被持有 —— org web 或另一个 org taskd）。");
    console.error("  若确认没有：rm runtime/tasks/.runner.lock 后重试（锁带 30s 心跳过期，死进程会自动接管）。");
    return 2;
  }
  runner.start();
  console.log(`◆ org taskd · 工作区 ${path.relative(ROOT, ws)} · 并发 ${concurrency} · 500ms 领取间隔`);
  console.log(`  Ctrl+C 退出（排队任务保留，下次启动继续）\n`);
  let lastCount = -1;
  const stat = setInterval(() => {
    const tasks = listTasks(ws);
    const active = tasks.filter((t) => t.status === "queued" || t.status === "running").length;
    if (active !== lastCount) {
      lastCount = active;
      console.log(`  [${new Date().toISOString().slice(11, 19)}] 活跃 ${active}（排队 ${tasks.filter((t) => t.status === "queued").length} · 运行 ${tasks.filter((t) => t.status === "running").length}）`);
    }
  }, 2000);
  const shutdown = (): void => {
    runner.stop();
    runner.releaseLock();
    clearInterval(stat);
    console.log("\n◇ taskd 已退出（排队任务保留在磁盘）");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return await new Promise<number>(() => { /* 由信号处理器结束进程 */ });
}

// ---- org notify：通知中心（v0.5.2） -------------------------------------------

async function cmdNotify(a: Args): Promise<number> {
  const [verb, ...rest] = a.rest;
  const ws = defaultWorkspace(a);

  if (verb === undefined || verb === "list") {
    const unread = readNotifications(ws, { unreadOnly: true });
    const all = readNotifications(ws);
    console.log(`通知中心 · ${ws}/runtime/notifications.json（未读 ${unread.length} / 共 ${all.length}）\n`);
    const list = rest[0] === "all" ? all.slice().reverse() : unread.slice().reverse();
    for (const n of list.slice(0, 30)) {
      const mark = n.read ? "○" : "●";
      console.log(`  ${mark} ${n.ts.slice(11, 19)} [${n.kind}] ${n.title}`);
      if (n.detail) console.log(`      ${n.detail.slice(0, 80)}`);
    }
    if (list.length === 0) console.log("（无未读通知 —— 长程任务完成时自动产生）");
    return 0;
  }
  if (verb === "read") {
    const n = markRead(ws, rest[0] ?? "all");
    console.log(`✓ 标记已读 ${n} 条`);
    return 0;
  }
  if (verb === "clear") {
    clearNotifications(ws);
    console.log("✓ 已清空");
    return 0;
  }
  if (verb === "test") {
    const r = notifyEvent(ws, "custom", "测试通知", "org notify test —— 桌面/存储/webhook 三通道实测", { desktop: true });
    console.log(`✓ 通知已写入 ${r.id}（桌面弹窗视环境而定，通知中心面板/CLI 始终可读）`);
    // v0.5.5：webhook 出站同步实测（fire-and-forget 平时静默，test 显式报告）
    const w = await webhookNotify(r);
    if (w.status === "sent") console.log(`✓ webhook 出站成功（HTTP ${w.code}）`);
    else if (w.status === "off") console.log("○ webhook 未配置（org config set notify_webhook_url URL 启用）");
    else if (w.status === "filtered") console.log("○ webhook 已配置但事件被 notify_webhook_events 过滤");
    else console.error(`✗ webhook 出站失败：${w.code ?? w.error ?? "未知"}`);
    return 0;
  }
  console.error(`✗ 未知子命令：${verb}（可用：list/read/clear/test）`);
  return 2;
}

// ---- org schedule：定时任务触发器（v0.5.5） ------------------------------------

function printScheduleRow(s: ScheduleRecord, now: Date): void {
  const nextMs = Date.parse(s.next_run);
  const inMin = Number.isFinite(nextMs) ? Math.round((nextMs - now.getTime()) / 60_000) : NaN;
  const inStr = !Number.isFinite(inMin) ? "?" : inMin <= 0 ? "到期" : inMin < 90 ? `${inMin} 分钟后` : `${Math.round(inMin / 1440)} 天后`;
  const mark = s.invalid ? "⚠" : s.enabled ? "⏰" : "○";
  const spec = s.kind === "run"
    ? `run · ${s.spec.task.slice(0, 44)}`
    : `ask · ${s.spec.expert} · ${s.spec.question.slice(0, 32)}`;
  console.log(`  ${mark} ${s.id}  ${s.expr}`);
  console.log(`       ${spec}`);
  console.log(`       下次 ${s.next_run.slice(0, 19).replace("T", " ")}（${inStr}） · 已触发 ${s.runs} 次 · misfire=${s.misfire}${s.invalid ? ` · ${s.invalid}` : ""}`);
}

async function cmdSchedule(a: Args): Promise<number> {
  const [verb, ...rest] = a.rest;
  const ws = defaultWorkspace(a);

  if (verb === undefined || verb === "list") {
    const list = listSchedules(ws);
    console.log(`定时任务 · ${ws}/runtime/schedules（${list.length} 条 · 执行器 org taskd / org web 挂载触发）\n`);
    const now = new Date();
    for (const s of list) printScheduleRow(s, now);
    if (list.length === 0) {
      console.log("（空 · org schedule add \"*/30 9-17 * * 1-5\" run \"任务描述\" 工作时段半小时一跑）");
    }
    return 0;
  }

  if (verb === "add") {
    const expr = rest[0];
    const kind = rest[1];
    if (!expr || (kind !== "run" && kind !== "ask")) {
      console.error('用法：org schedule add <expr> run "任务描述" [--model m]');
      console.error('      org schedule add <expr> ask <expert> "问题" [--model m]');
      console.error('expr：五段 cron（分 时 日 月 周）或 @every 30m');
      return 2;
    }
    // 尾参解析：--model m / --misfire skip|run / --notify on|off + 位置参数
    const pos: string[] = [];
    let model = a.model;
    let misfire: "skip" | "run" = "skip";
    let notify = true;
    let i = 2;
    while (i < rest.length) {
      const v = rest[i]!;
      if (v === "--model" || v === "-m") model = rest[++i] ?? model;
      else if (v === "--misfire") {
        const mf = rest[++i];
        if (mf === "run") misfire = "run";
      } else if (v === "--notify") notify = (rest[++i] !== "off");
      else if (v.length > 0 && !v.startsWith("--")) pos.push(v);
      i++;
    }
    try {
      const s = addSchedule(ws, expr, kind, kind === "run"
        ? { task: pos.join(" "), model }
        : { expert: pos[0] ?? "", question: pos.slice(1).join(" "), model },
        { misfire, notify });
      if (s.invalid) {
        console.error(`✗ 表达式不可解析：${expr}（五段 cron 或 @every 30m）`);
        removeSchedule(ws, s.id);
        return 2;
      }
      console.log(`✓ 定时已建 ${s.id}（${expr}）· 下次 ${s.next_run.slice(0, 19).replace("T", " ")}`);
      console.log("  执行：org taskd 启动守护执行器（触发即入任务队列）· org schedule list 查看");
      return 0;
    } catch (e) {
      console.error(`✗ ${((e as Error).message)}`);
      return 2;
    }
  }

  if (verb === "rm") {
    if (!rest[0]) { console.error("用法：org schedule rm <id>"); return 2; }
    try {
      const ok = removeSchedule(ws, rest[0]);
      console.log(ok ? `✓ 已删除 ${rest[0]}` : `○ ${rest[0]} 不存在`);
      return 0;
    } catch (e) {
      console.error(`✗ ${((e as Error).message)}`);
      return 2;
    }
  }

  if (verb === "on" || verb === "off") {
    if (!rest[0]) { console.error(`用法：org schedule ${verb} <id>`); return 2; }
    const s = setScheduleEnabled(ws, rest[0], verb === "on");
    if (!s) { console.error(`✗ ${rest[0]} 不存在`); return 2; }
    console.log(`✓ ${s.id} 已${verb === "on" ? "启用" : "停用"}${verb === "on" ? ` · 下次 ${s.next_run.slice(0, 19).replace("T", " ")}` : ""}`);
    return 0;
  }

  if (verb === "test") {
    const expr = rest[0];
    if (!expr) { console.error("用法：org schedule test <expr>（预览未来 3 个触发点，UTC）"); return 2; }
    const next = previewNext(expr, new Date(), 3);
    if (next.length === 0) {
      console.error(`✗ 不可解析或 366 天内无命中：${expr}`);
      return 2;
    }
    console.log(`⏰ ${expr} —— 未来 ${next.length} 个触发点（UTC）：`);
    for (const d of next) console.log(`  ${d.toISOString().slice(0, 19).replace("T", " ")}`);
    return 0;
  }

  console.error(`✗ 未知子命令：${verb}（可用：list/add/rm/on/off/test）`);
  return 2;
}

// ---- org search：语义检索（v0.5.8 · capabilities #19/#22） ---------------------

async function cmdSearch(a: Args): Promise<number> {
  const query = a.rest.join(" ").trim();
  if (!query) {
    console.error('用法：org search <查询词> [--k N] [--workspace DIR]');
    console.error('  BM25 词频语义检索（中英混合分词）· 语料：raw/ registry/ work/ factory/');
    console.error('  RAG 注入：问题中写 @?查询词 即把检索命中织入模型上下文');
    return 2;
  }
  const k = Number(a.k ?? 5);
  const ws = defaultWorkspace(a);
  ensureWorkspace(ws);
  const sr = semanticSearch(ws, query, Number.isFinite(k) && k > 0 ? k : 5);
  const corpus = sr.stats.corpusDirs.join(" · ") || "（无语料目录）";
  console.log(`🔍 "${query}" · ${sr.hits.length} 命中 · ${sr.took_ms}ms · ${sr.total_docs} 文档（${corpus}）`);
  if (sr.stats.skippedOversize + sr.stats.skippedBinary + sr.stats.skippedTotalCap > 0) {
    console.log(`  语料降级：超限 ${sr.stats.skippedOversize} · 二进制 ${sr.stats.skippedBinary} · 总量帽 ${sr.stats.skippedTotalCap}（跳过不连坐）`);
  }
  if (sr.hits.length === 0) {
    console.log("\n（无命中 —— 换个说法？中英混合查询均可，如「审计 制度」「date format」）");
    return 0;
  }
  console.log("");
  for (const h of sr.hits) {
    console.log(`  ${h.score.toFixed(2).padStart(5)}  ${h.path}`);
    if (h.snippet) console.log(`         ${h.snippet.slice(0, 160)}`);
  }
  console.log(`\n  引用命中：org ask <expert> "… @${sr.hits[0]!.path} …"`);
  console.log(`  RAG 注入：org ask <expert> "… @?${query} …"（检索命中自动织入上下文）`);
  return 0;
}

// ---- org speak / org voice：语音入口 CLI 面（v0.5.12） --------------------------

/** org speak "文本" [--voice v] [--speed s] [--out file.wav]
 *  文本 → TTS WAV 落盘（7 声音 · 语速 0.5-2.0 · 超长分段拼接 · 4K 截断诚实标注）。 */
async function cmdSpeak(a: Args): Promise<number> {
  const text = a.rest.join(" ").trim();
  if (!text) {
    console.error('用法：org speak "要朗读的文本" [--voice tongtong|chuichui|xiaochen|jam|kazi|douji|luodo] [--speed 0.5-2.0] [--out file.wav]');
    console.error('  文本合成语音（z-ai SDK TTS）→ WAV 落盘（缺省 out-speech.wav）');
    console.error('  超长自动分段拼接（段上限 1000 字）；总长 4096 截断诚实标注');
    return 2;
  }
  const voice = process.env.ORG_VOICE || a.rest.find((r) => r.startsWith("--voice="))?.split("=")[1];
  const speedArg = a.rest.find((r) => r.startsWith("--speed="))?.split("=")[1];
  const out = a.out || path.join(DEFAULT_WORKSPACE, "out-speech.wav");
  const o = await synthesizeSpeech(text, {
    voice: voice === undefined ? undefined : String(voice),
    speed: speedArg === undefined ? undefined : Number(speedArg),
  });
  if (!o.ok || !o.wav) {
    console.error(`✗ 合成失败：${o.error}`);
    console.error("  提示：语音需要 z-ai SDK 凭据（部署环境配置后即可用）；DHV_VOICE_DISABLE_SDK=1 可显式关闭");
    return 1;
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, o.wav);
  console.log(`🔊 已合成 ${out}（${(o.wav.length / 1024).toFixed(0)}KB · ${o.voice} ×${o.speed?.toFixed(2)} · ${o.chunks} 段${o.truncated ? ` · 截断 ${o.totalChars}→4096 字` : ""}）`);
  return 0;
}

/** org voice —— 语音服务状态探测 + 声音清单。 */
async function cmdVoice(_a: Args): Promise<number> {
  const st = await voiceStatus();
  if (st.sdk) {
    console.log(`🎙 语音服务在线（${st.voices} 种声音）：`);
  } else {
    console.log(`🎙 语音服务未就绪：${st.error}`);
    console.error("  部署环境配置 z-ai SDK 凭据后，🎤 转写（org web）与 🔊 朗读即刻可用");
  }
  for (const [k, v] of Object.entries(VOICES)) {
    console.log(`  ${k.padEnd(10)} ${v}`);
  }
  console.log("\n  合成：org speak \"文本\" --voice jam --speed 1.3 --out out.wav");
  console.log("  Web：org web → 🎙 语音面板（🎤 录音转写 · 🔊 回复朗读 · 声音/语速设置）");
  return st.sdk ? 0 : 3;
}

/** org vision [图片路径...] [--prompt "问题"]
 *  图片 → VLM 分析（多图 ≤4 · png/jpeg/gif/webp/bmp · 魔数唤探防伪造）。
 *  无参 → 服务状态 + 用法。 */
async function cmdVision(a: Args): Promise<number> {
  const files = a.rest.filter((r) => !r.startsWith("--"));
  const promptArg = a.rest.find((r) => r.startsWith("--prompt="))?.split("=").slice(1).join("=");
  if (files.length === 0) {
    const st = await visionStatus();
    if (st.sdk) {
      console.log(`📷 视觉服务在线（${st.formats} 种图片格式）：`);
    } else {
      console.log(`📷 视觉服务未就绪：${st.error}`);
      console.error("  部署环境配置 z-ai SDK 凭据后，📷 图片分析即刻可用");
    }
    console.log('\n  分析：org vision photo.jpg --prompt="图里有什么文字？"');
    console.log("  多图：org vision a.png b.jpg --prompt=\"对比这两张图\"（≤4 张）");
    console.log("  Web：org web → 📷 按钮（分析结果追加进输入框，分析→引用闭环）");
    return st.sdk ? 0 : 3;
  }
  if (files.length > VISION_MAX_IMAGES) {
    console.error(`✗ 图片过多（${files.length} > ${VISION_MAX_IMAGES} 张上限）`);
    return 2;
  }
  const imgs = [];
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`✗ 图片不存在：${f}`);
      return 2;
    }
    const buf = fs.readFileSync(f);
    imgs.push({ buf, mime: undefined }); // mime 交由魔数唤探（不信任扩展名）
  }
  const out = await analyzeImages(imgs, promptArg);
  if (!out.ok || !out.text) {
    console.error(`✗ 分析失败：${out.error}`);
    console.error("  提示：视觉需要 z-ai SDK 凭据（部署环境配置后即可用）；DHV_VISION_DISABLE_SDK=1 可显式关闭");
    return 1;
  }
  console.log(`📷 ${files.length} 图 · ${out.chars} 字${out.promptTruncated ? "（prompt 已截断）" : ""}：\n`);
  console.log(out.text);
  return 0;
}

/** org spawn [prune [--failed|--all] [--dry-run]] —— 派生池观测与清理（v0.5.13）。
 *  无参：池列表 + 统计；prune：失败记录/全量/孤儿目录清理（与 Web DELETE /api/spawns 同语义）。 */
async function cmdSpawn(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const verb = a.rest[0];
  const spawnRoot = path.join(ws, "spawn");
  const poolPath = path.join(spawnRoot, "pool.json");
  type PoolRec = Record<string, unknown> & { id?: string; goal?: string; ok?: boolean;
    mode?: string; depth?: number; budget?: unknown; reuse_count?: number;
    workspace?: string; usage?: { tokens?: number; model_calls?: number } | null };
  const loadPool = (): PoolRec[] => {
    try {
      const pool = JSON.parse(fs.readFileSync(poolPath, "utf-8")) as { records?: unknown };
      if (Array.isArray(pool.records)) return pool.records.filter((r): r is PoolRec => !!r && typeof r === "object");
    } catch { /* 池不存在/损坏 → 空 */ }
    return [];
  };

  if (verb !== "prune") {
    // 池列表 + 统计（观测面）
    const recs = loadPool();
    // 孤儿目录（legacy 无登记）
    const seen = new Set(recs.map((r) => String(r.id ?? "")));
    const orphans: string[] = [];
    try {
      for (const e of fs.readdirSync(spawnRoot, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (!seen.has(e.name)) orphans.push(e.name);
      }
    } catch { /* spawn 目录不存在 */ }
    const okN = recs.filter((r) => r.ok === true).length;
    const tokens = recs.reduce((s, r) => s + (Number(r.usage?.tokens) || 0), 0);
    const reuse = recs.reduce((s, r) => s + (Number(r.reuse_count) || 0), 0);
    console.log(`🌳 派生池 · ${ws}/spawn（登记 ${recs.length} 条 · 成功 ${okN} · 失败 ${recs.length - okN} · 复用 ${reuse} · tokens ${tokens}${orphans.length > 0 ? ` · 孤儿目录 ${orphans.length}` : ""}）\n`);
    for (const r of recs) {
      const mark = r.ok === true ? "✓" : "✗";
      console.log(`  ${mark} ${String(r.id ?? "?").slice(0, 40)}  [${String(r.mode ?? "run")} d${r.depth ?? "?"} ◈${String(r.budget ?? "?")} ♻×${Number(r.reuse_count) || 0}]`);
    }
    if (recs.length === 0 && orphans.length === 0) console.log("  （空 —— 尚无派生记录）");
    console.log("\n  清理：org spawn prune --failed（失败记录）/ --all（全量重置）/ --dry-run（预览）");
    return 0;
  }

  // ---- prune ----
  const flags = a.rest.slice(1);
  const failed = flags.includes("--failed");
  const all = flags.includes("--all");
  const dryRun = flags.includes("--dry-run");
  if (!failed && !all) {
    console.error('用法：org spawn prune --failed | --all [--dry-run]');
    console.error('  --failed  删除全部失败派生（登记 + 目录 + 失败孤儿目录）');
    console.error('  --all     清空派生池（全部登记 + 目录，不可恢复）');
    console.error('  --dry-run 只列出将删条目，不动手');
    return 2;
  }
  const inGuard = (p: string): boolean => {
    try { const abs = path.resolve(p); return abs.startsWith(path.resolve(spawnRoot) + path.sep); }
    catch { return false; }
  };
  const recs = loadPool();
  const keep: PoolRec[] = [];
  const dropped: Array<{ id: string; dir?: string }> = [];
  for (const r of recs) {
    const id = String(r.id ?? "");
    const drop = all || (failed && r.ok !== true);
    if (drop) dropped.push({ id, dir: String(r.workspace ?? "") || undefined });
    else keep.push(r);
  }
  // 孤儿目录：failed 模式删 run.json 标记失败的；all 模式全删
  const seen = new Set(recs.map((r) => String(r.id ?? "")));
  try {
    for (const e of fs.readdirSync(spawnRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (seen.has(e.name)) continue;
      let isFailed = all;
      if (!isFailed) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(spawnRoot, e.name, "out-spawn", "run.json"), "utf-8")) as { ok?: boolean };
          isFailed = j.ok !== true;
        } catch { isFailed = true; } // 半成品 → 失败语义
      }
      if (isFailed) dropped.push({ id: e.name, dir: path.join(spawnRoot, e.name) });
    }
  } catch { /* spawn 目录不存在 */ }
  const label = all ? "全量重置" : "失败清理";
  if (dropped.length === 0) {
    console.log(`🧹 ${label}：无可清理条目（池登记 ${recs.length} 条均为保留语义）`);
    return 0;
  }
  if (dryRun) {
    console.log(`🧹 ${label}（dry-run —— 将删除 ${dropped.length} 条）：`);
    for (const d of dropped) console.log(`  ✂ ${d.id}${d.dir ? "  " + d.dir : ""}`);
    console.log(`\n  确认执行：org spawn prune ${all ? "--all" : "--failed"}（去掉 --dry-run）`);
    return 0;
  }
  let dirsRemoved = 0, errs = 0;
  for (const d of dropped) {
    const dir = d.dir && inGuard(d.dir) ? d.dir : (d.id ? path.join(spawnRoot, d.id) : "");
    if (!dir || !inGuard(dir) || !fs.existsSync(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); dirsRemoved++; }
    catch { errs++; console.error(`  ✗ 目录删除失败：${d.id}`); }
  }
  try {
    fs.mkdirSync(spawnRoot, { recursive: true });
    fs.writeFileSync(poolPath, JSON.stringify({ version: 1, records: keep }, null, 2));
  } catch (e) {
    console.error(`✗ pool.json 回写失败：${String((e as Error).message ?? e)}`);
    return 1;
  }
  console.log(`🧹 ${label}完成：删除 ${dropped.length} 条（目录 ${dirsRemoved}${errs ? ` · 失败 ${errs}` : ""}）· 保留 ${keep.length} 条`);
  return errs > 0 ? 1 : 0;
}

// ---- v0.5.15 桌面 Agent 补全批次：db / diff / symbols / scan / audit / sbom / owners / read ----

/** rest 里的 --flag value / --flag=value 提取。
 *  直接扫 process.argv 而非 a.rest —— parseArgs 会消费部分 flag（--name/--run/
 *  --out/--dry-run 进 Args 字段），rest 里看不到；argv 扫描对两种形态与大小写原样
 *  透明（--name 的 lowercase 副作用也不受影响）。 */
function restFlag(a: Args, name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
  const pre = argv.find((r) => r.startsWith(`--${name}=`));
  if (pre) return pre.split("=").slice(1).join("=");
  // 兜底：未被 parseArgs 消费的 flag 仍在 a.rest（双形态等价）
  const j = a.rest.indexOf(`--${name}`);
  if (j >= 0 && j + 1 < a.rest.length && !a.rest[j + 1]!.startsWith("--")) return a.rest[j + 1];
  const pre2 = a.rest.find((r) => r.startsWith(`--${name}=`));
  return pre2 ? pre2.split("=").slice(1).join("=") : undefined;
}
function restBool(a: Args, name: string): boolean {
  const argv = process.argv.slice(2);
  return argv.includes(`--${name}`) || a.rest.includes(`--${name}`)
    || argv.some((r) => r.startsWith(`--${name}=`)) || a.rest.some((r) => r.startsWith(`--${name}=`));
}

/** v0.5.16：原始 argv 的位置参数提取（跳过命令本身、--flag 及其值）。
 *  与 restFlag 同一痛点：parseArgs 把未识别 flag 连同其值都推进 a.rest，
 *  位置参数与 flag 值在 a.rest 里无法区分（dbdiag 的 SQL 会吞掉 --setup 的
 *  值变成「多语句」）；raw argv 保真。valueFlags = 消费下一 token 作值的
 *  flag 名清单（布尔 flag 不列）。argv 形态对不上时兜底 a.rest 旧口径。 */
function rawPositionals(a: Args, valueFlags: string[] = []): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 1; i < argv.length; i++) { // 0 = 命令本身
    const t = argv[i]!;
    if (t.startsWith("--")) {
      if (!t.includes("=") && valueFlags.includes(t.slice(2))) i++; // 跳过该 flag 的值
      continue;
    }
    out.push(t);
  }
  return out.length > 0 ? out : a.rest.filter((r) => !r.startsWith("--"));
}

/** org db <schema|tables|query|migrate|history> --file x.db [--sql …] [--name …] [--dry-run] [--limit N]
 *  SQLite 数据库操作（capabilities #43 数据库 Schema/迁移 + #73 迁移/操作）。 */
async function cmdDb(a: Args): Promise<number> {
  const verb = a.rest[0] ?? "schema";
  const file = restFlag(a, "file");
  const positional = a.rest.filter((r) => !r.startsWith("--"));
  if (!file && verb !== "help") {
    console.error('用法：org db schema|tables|query|migrate|history --file <x.db> [--sql "SELECT …"] [--name 迁移名] [--dry-run] [--limit N]');
    console.error("  只读门：query 仅单条 SELECT/WITH/EXPLAIN/PRAGMA table_info（写操作走 migrate 专用通道）");
    console.error("  迁移协议：_org_migrations 版本账本 + 伴车 <x.db>.migrations.json 双写");
    return 2;
  }
  const f = path.resolve(file!);
  if (verb === "schema") {
    const s = dbSchema(f);
    if (s.missing) { console.error(`✗ 无法打开：${f}（${s.journalMode ?? "文件不存在或不是 SQLite 库"}）`); return 1; }
    console.log(`🗄 ${f}（${(s.sizeBytes / 1024).toFixed(1)} KB · journal=${s.journalMode}）`);
    for (const t of s.tables) {
      const cols = t.columns.map((c) => `${c.name}${c.pk ? " PK" : ""}${c.notNull ? "!" : ""}`).join(", ");
      console.log(`  表 ${t.name}（${t.rowCount === null ? "行数未抽查（>10MB）" : `${t.rowCount} 行`}）：${cols}`);
    }
    if (s.indexes.length) console.log(`  索引：${s.indexes.join(" · ")}`);
    if (s.views.length) console.log(`  视图：${s.views.join(" · ")}`);
    return 0;
  }
  if (verb === "tables") {
    const t = dbTables(f);
    if (t.length === 0) { console.error(`✗ 无法打开或无表：${f}`); return 1; }
    console.log(t.join("\n"));
    return 0;
  }
  if (verb === "query") {
    const sql = restFlag(a, "sql");
    if (!sql) { console.error('用法：org db query --file x.db --sql "SELECT * FROM t LIMIT 5"'); return 2; }
    const limitRaw = Number(restFlag(a, "limit") ?? DB_LIMITS.defaultRowLimit);
    const r = dbQuery(f, sql, { limit: Number.isFinite(limitRaw) ? limitRaw : DB_LIMITS.defaultRowLimit });
    if (!r.ok) {
      const kindText: Record<string, string> = { denied: "只读门拒绝（写语句走 migrate 通道）", syntax: "语法错误", missing: "库文件不存在", readonly: "内核只读拦截", internal: "内部限制" };
      console.error(`✗ 查询失败（${kindText[r.kind] ?? r.kind}）：${r.error}`);
      return 1;
    }
    const { columns, rows, rowCount, ms, truncated } = r.result;
    console.log(`📊 ${rowCount} 行 · ${ms}ms${truncated ? `（截断至 ${rows.length} 行，--limit 提高帽，上限 ${DB_LIMITS.maxRowLimit}）` : ""}`);
    if (columns.length > 0) console.log(`  ${columns.join(" | ")}`);
    for (const row of rows) console.log(`  ${row.map((c) => (c === null ? "NULL" : String(c))).join(" | ")}`);
    return 0;
  }
  if (verb === "migrate") {
    const sql = restFlag(a, "sql");
    const name = restFlag(a, "name") ?? `migration-${Date.now().toString(36)}`;
    if (!sql) { console.error('用法：org db migrate --file x.db --name "add users table" --sql "CREATE TABLE …" [--dry-run]'); return 2; }
    const r = dbApplyMigration(f, name, sql, { dryRun: restBool(a, "dry-run") });
    if (!r.ok) { console.error(`✗ 迁移失败（${r.kind}）：${r.error}`); return 1; }
    console.log(`${r.dryRun ? "🔍 dry-run 验证通过（已回滚，未落盘）" : "✓"} 迁移 v${r.version} · ${name} · ${r.durMs}ms`);
    return 0;
  }
  if (verb === "history") {
    const list = dbMigrations(f);
    if (list.length === 0) { console.log(`（无迁移记录 —— ${f}.migrations.json 不存在或为空）`); return 0; }
    for (const m of list) console.log(`  v${m.version}  ${m.appliedAt ?? "?"}  ${m.name}`);
    return 0;
  }
  console.error(`未知子命令：${verb}（schema|tables|query|migrate|history）`);
  return 2;
}

/** org diff <旧> <新> [--context N] —— unified diff 预览（#49/#60）。 */
async function cmdDiff(a: Args): Promise<number> {
  const positional = a.rest.filter((r) => !r.startsWith("--"));
  if (positional.length < 2) {
    console.error("用法：org diff <旧文件> <新文件> [--context 3]");
    console.error("  旧文件不存在 = 全新增；GNU diff -u 格式对拍一致");
    return 2;
  }
  const [oldF, newF] = positional;
  const ctxRaw = Number(restFlag(a, "context") ?? 3);
  const r = diffFiles(path.resolve(oldF!), path.resolve(newF!), { context: Number.isFinite(ctxRaw) ? Math.max(0, ctxRaw) : 3 });
  if (!r.ok) {
    const why: Record<string, string> = { missing: "新文件不存在", binary: "二进制文件不支持 diff", read: "读取失败" };
    console.error(`✗ ${why[r.kind] ?? r.kind}：${r.error}`);
    return 1;
  }
  if (r.result.identical) { console.log("（两文件内容一致）"); return 0; }
  console.log(renderStats(r.result));
  console.log(renderUnified(r.result, oldF!, newF!));
  return 0;
}

/** org symbols <名字> [--refs] [--substring] —— 符号定义/引用跳转（#20）。 */
async function cmdSymbols(a: Args): Promise<number> {
  const name = a.rest.find((r) => !r.startsWith("--"));
  if (!name) {
    console.error("用法：org symbols <名字> [--refs] [--substring] [--workspace DIR]");
    console.error("  定义清单缺省；--refs 附引用（call/mention 两类）；--substring 子串匹配");
    return 2;
  }
  const ws = defaultWorkspace(a);
  const idx = indexSymbols(ws, [""]); // v0.5.15：工作区根扫描（runtime/out-*/spawn 已排除）
  const defs = lookupDef(idx.symbols, name, !restBool(a, "substring"));
  console.log(`🔎 符号索引：${idx.files} 文件 · ${idx.symbols.length} 符号 · ${idx.builtMs}ms${idx.truncated ? "（超文件帽截断）" : ""}`);
  if (defs.length === 0) {
    console.log(`\n（无定义命中 —— ${restBool(a, "substring") ? "" : "试 --substring 子串匹配；"}或换 org search 语义检索）`);
    return 0;
  }
  for (const d of defs) console.log(`  ${d.kind.padEnd(9)} ${d.name}  ${d.file}:${d.line}\n           ${d.snippet.slice(0, 110)}`);
  if (restBool(a, "refs")) {
    const refs = findRefs(ws, name, { dirs: [""] });
    console.log(`\n引用（${refs.length}）：`);
    for (const r of refs) console.log(`  ${r.kind.padEnd(7)} ${r.file}:${r.line}  ${r.snippet.slice(0, 100)}`);
  }
  return 0;
}

/** org scan —— 密钥/敏感信息扫描（#141）。 */
async function cmdScan(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const dirsFlag = restFlag(a, "dirs");
  const r = scanWorkspace(ws, dirsFlag ? { dirs: dirsFlag.split(",").map((d) => d.trim()).filter(Boolean) } : {});
  console.log(`🛡 密钥扫描：${r.scanned}/${r.files} 文件 · ${r.hits.length} 命中 · ${r.tookMs}ms${r.truncated ? "（超文件帽截断）" : ""}`);
  if (r.skippedBinary + r.skippedOversize > 0) {
    console.log(`  降级跳过：二进制 ${r.skippedBinary} · 超限 ${r.skippedOversize}`);
  }
  if (r.hits.length === 0) { console.log("\n✓ 未发现密钥模式（18 类：OpenAI/Anthropic/GitHub/AWS/私钥/JWT/.env 赋值…）"); return 0; }
  const order = { high: 0, medium: 1, low: 2 } as const;
  const hits = [...r.hits].sort((x, y) => order[x.severity] - order[y.severity]);
  for (const h of hits) console.log(`  [${h.severity.toUpperCase()}] ${h.pattern}  ${h.file}:${h.line}\n         ${h.preview.slice(0, 130)}`);
  const high = hits.filter((h) => h.severity === "high").length;
  console.log(`\n  ${high} 条高危 —— 建议立即轮换密钥；工具环 fs_write 已同款拦截（写入前 scanText）`);
  return high > 0 ? 1 : 0;
}

/** org audit [--run out-a] [--out FILE] —— 审计导出（#150）。 */
async function cmdAudit(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const runFlag = restFlag(a, "run");
  const outFlag = restFlag(a, "out");
  const r = exportAudit(ws, { run: runFlag, out: outFlag ? path.resolve(outFlag) : undefined });
  if (!r.ok) { console.error(`✗ 导出失败：${r.warnings.join("; ")}`); return 1; }
  console.log(`📦 审计导出：${r.zip}`);
  console.log(`  ${r.entries} 条目 · ${(r.bytes / 1024).toFixed(1)} KB · 摘要 ${path.basename(r.report)}`);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  const sum = auditSummary(ws);
  console.log(`\n  概览：${sum.runs.length} 次运行 · 审批 ${sum.approvals} 条 · LLM 台账 ${sum.ledgerEntries} 条`);
  for (const run of sum.runs.slice(0, 8)) {
    console.log(`    ${run.name.padEnd(12)} ${String(run.events).padStart(5)} 事件 · ${String(run.tokens).padStart(7)} tokens · ${run.ok === null ? "—" : run.ok ? "ok" : "err"}`);
  }
  return 0;
}

/** org sbom [--format json|tv] —— SPDX SBOM（#148）。 */
async function cmdSbom(a: Args): Promise<number> {
  const fmt = (restFlag(a, "format") ?? "json").toLowerCase();
  const r = buildSbom(ROOT);
  if (!r.ok) { console.error(`✗ ${r.error}`); return 1; }
  const text = fmt === "tv" ? renderSpdxTagValue(r.doc) : renderSpdxJson(r.doc);
  const out = a.out ? path.resolve(a.out) : path.join(DEFAULT_WORKSPACE, fmt === "tv" ? "sbom.spdx" : "sbom.spdx.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`📋 SPDX-2.3 SBOM → ${out}`);
  for (const p of r.doc.packages) console.log(`  ${p.scope.padEnd(9)} ${p.name}@${p.version}${p.license ? ` · ${p.license}` : ""}`);
  return 0;
}

/** org owners [文件...] / org owners --review a.ts,b.ts —— CODEOWNERS + 评审推荐（#89/#85）。 */
async function cmdOwners(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const { rules, file } = loadCodeowners(ws);
  const reviewFlag = restFlag(a, "review");
  const positional = a.rest.filter((r) => !r.startsWith("--"));
  if (reviewFlag) {
    const files = reviewFlag.split(",").map((s) => s.trim()).filter(Boolean);
    const r = recommendReviewers(ws, files);
    console.log(`👥 评审推荐（${files.length} 文件）：`);
    for (const rev of r.reviewers) console.log(`  @${rev.name} · 覆盖 ${rev.filesCovered}/${files.length} · ${rev.reason}`);
    if (!r.fromCodeowners) console.log(`\n  ⚠ ${r.fallbackReason ?? ""}`);
    return 0;
  }
  if (rules.length === 0) {
    console.log(`（无 CODEOWNERS —— 查找顺序 .org/CODEOWNERS → CODEOWNERS → .github/CODEOWNERS）`);
    console.log(`  建议在 ${path.join(ws, ".org", "CODEOWNERS")} 声明，例：\n    lib/ @engine-owner\n    hsl/ @kernel-owner`);
    return 0;
  }
  console.log(`📋 CODEOWNERS：${file}（${rules.length} 规则，后规则覆盖前规则）`);
  for (const r of rules) console.log(`  L${String(r.line).padStart(3)}  ${r.pattern.padEnd(28)} ${r.owners.map((o) => (o.startsWith("@") ? o : "@" + o)).join(" ")}`);
  if (positional.length > 0) {
    console.log(`\n匹配（${positional.length} 文件）：`);
    for (const m of matchOwners(ws, positional)) console.log(`  ${m.file.padEnd(40)} → ${m.owners.length ? m.owners.join(" ") : "（无规则命中）"}`);
  }
  return 0;
}

/** org read <file.pdf> [--max-pages N] —— PDF 文本提取三层降级链（#24）。 */
async function cmdRead(a: Args): Promise<number> {
  const file = a.rest.find((r) => !r.startsWith("--"));
  if (!file) {
    console.error("用法：org read <file.pdf> [--max-pages 50]");
    const e = pdfEngines();
    console.error(`  引擎探测：pdftotext ${e.pdftotext ? "✓" : "✗"} · uv+pypdf ${e.uv ? "✓" : "✗"}（三层降级：pdftotext → uv+pypdf → 诚实失败）`);
    return 2;
  }
  const mpRaw = Number(restFlag(a, "max-pages") ?? 50);
  const r = await readPdf(path.resolve(file), { maxPages: Number.isFinite(mpRaw) ? Math.max(1, mpRaw) : 50 });
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    if (r.hint) console.error(`  ${r.hint}`);
    return 1;
  }
  console.log(`📄 ${file} · ${r.pages} 页 · 引擎 ${r.engine} · ${r.ms}ms\n`);
  console.log(r.text);
  return 0;
}

// ---- v0.5.16 治理与扩展批次：dbdiag / merge / rebase / mergestate / rbac / iacscan / plugin / openapi / browser / complete / rename ----

/** org dbdiag <file|:memory:> <sql> [--setup SQL] —— EXPLAIN QUERY PLAN 诊断（#113）。 */
async function cmdDbdiag(a: Args): Promise<number> {
  const positional = rawPositionals(a, ["setup"]);
  if (positional.length < 2) {
    console.error('用法：org dbdiag <x.db|:memory:> "SELECT …" [--setup "CREATE …; INSERT …"]');
    console.error("  只读诊断：EXPLAIN QUERY PLAN + 计划解析（索引命中/全表扫描/涉及表）+ 建议");
    console.error(`  --setup 仅 :memory: 生效（文件库传 setup 会被拒）；setup 帽 ${DBDIAG_LIMITS.maxSetupBytes / 1024}KB`);
    return 2;
  }
  const [file, ...sqlParts] = positional;
  const sql = sqlParts.join(" ");
  const setup = restFlag(a, "setup");
  const target = file === ":memory:" ? ":memory:" : path.resolve(file!);
  const r = await dbDiagnose(target, sql, setup ? { setup } : {});
  if (!r.ok) {
    const kindText: Record<string, string> = { denied: "只读门拒绝（写语句/文件库带 setup）", syntax: "语法错误", missing: "库文件不存在或非 SQLite", internal: "内部限制" };
    console.error(`✗ 诊断失败（${kindText[r.kind] ?? r.kind}）：${r.error}`);
    return 1;
  }
  console.log(`🩺 查询计划（${r.ms}ms · ${r.plan.steps.length} 步骤 · ${r.plan.fullScan ? "⚠ 含全表扫描" : "无全表扫描"}）`);
  for (const s of r.plan.steps) {
    console.log(`  ${String(s.id).padStart(2)}←${String(s.parent).padStart(2)}  ${s.usesIndex ? "🔑 " : "   "}${s.detail}`);
  }
  console.log(`  涉及表：${r.plan.tables.length ? r.plan.tables.join(" · ") : "（无）"}`);
  if (r.suggestions.length > 0) {
    console.log("\n建议：");
    for (const s of r.suggestions) console.log(`  - ${s}`);
  }
  return 0;
}

/** org mergestate [--repo DIR] —— merge/rebase 只读状态探测（#80）。 */
function printMergeState(repo: string): number {
  const s = gitMergeState(repo);
  if (s.degraded) { console.error(`✗ ${s.degraded}`); return 1; }
  console.log(`🌿 ${s.repo}`);
  console.log(`  分支 ${s.branch ?? "（detached HEAD）"}${s.upstream ? ` → 上游 ${s.upstream}（ahead ${s.ahead} · behind ${s.behind}${s.diverged ? " · ⚠ 已分叉" : ""}）` : "（无上游跟踪）"}`);
  console.log(`  工作区 ${s.dirty ? "⚠ 有未提交改动" : "干净"} · stash ${s.stashed} 条`);
  return 0;
}

/** org merge [--no-ff] [--message M] <source> / org rebase <onto> / org mergestate（#80）。 */
function printGitOp(tool: string, r: { ok: boolean; output: string; conflicts: string[]; aborted: boolean; kind?: string; error?: string }): number {
  if (r.ok) {
    console.log(r.output.trim() || `✓ ${tool} 完成`);
    return 0;
  }
  const kindText: Record<string, string> = {
    conflict: "冲突（已自动 abort，工作区回到操作前）", "not-repo": "不是 git 仓库（或目录不存在）",
    "git-missing": "git 不可用", timeout: `超时（单命令 ${GIT_LIMITS.timeoutMs / 1000}s 预算）`, internal: "git 拒绝",
  };
  console.error(`✗ ${tool} 未完成（${kindText[r.kind ?? "internal"] ?? r.kind}）：${r.error ?? ""}`);
  if (r.conflicts.length > 0) {
    console.error(`  冲突文件（${r.conflicts.length}，绝不自动解决 —— 人工处理后重试）：`);
    for (const c of r.conflicts) console.error(`    ${c}`);
  }
  if (!r.aborted && r.kind === "conflict") console.error("  ⚠ abort 未成功：工作区仍处冲突态，需人工 git merge --abort / git rebase --abort");
  if (r.output.trim()) console.error(dim(r.output.trim().split("\n").slice(0, 6).join("\n")));
  return 1;
}

async function cmdMerge(a: Args): Promise<number> {
  const positional = rawPositionals(a, ["repo", "message"]);
  if (positional.length === 0) {
    console.error("用法：org merge [--no-ff] [--message \"合并说明\"] <source> [--repo DIR]");
    console.error("  冲突哲学：绝不自动解决 —— 冲突即自动 abort 回滚 + 冲突清单（单命令 30s 预算）");
    return 2;
  }
  const repo = restFlag(a, "repo") ? path.resolve(restFlag(a, "repo")!) : defaultWorkspace(a);
  const message = restFlag(a, "message");
  const r = gitMerge(repo, { source: positional[0]!, ...(message ? { message } : {}), noFf: restBool(a, "no-ff") });
  return printGitOp("merge", r);
}

async function cmdRebase(a: Args): Promise<number> {
  const positional = rawPositionals(a, ["repo"]);
  if (positional.length === 0) {
    console.error("用法：org rebase <onto> [--repo DIR]");
    console.error("  冲突哲学：绝不自动解决 —— 冲突即自动 abort 回原分支 + 冲突清单");
    return 2;
  }
  const repo = restFlag(a, "repo") ? path.resolve(restFlag(a, "repo")!) : defaultWorkspace(a);
  const r = gitRebase(repo, { onto: positional[0]! });
  return printGitOp("rebase", r);
}

async function cmdMergestate(a: Args): Promise<number> {
  const repo = restFlag(a, "repo") ? path.resolve(restFlag(a, "repo")!) : defaultWorkspace(a);
  return printMergeState(repo);
}

/** org rbac [list|check <role> <action>|policy] —— SSO/RBAC 角色权限（#149）。 */
async function cmdRbac(a: Args): Promise<number> {
  const verb = a.rest[0] ?? "list";
  const ws = defaultWorkspace(a);
  const { policy, file, fallbackReason } = loadRbac(ws);
  if (verb === "list" || verb === "policy") {
    if (fallbackReason) console.log(`⚠ ${fallbackReason}`);
    console.log(`🛂 RBAC 策略（${file ?? "内建兜底"} · ${rbacRoles(policy).length} 角色 · 动作命名空间 tool:*/cli:*）`);
    for (const role of rbacRoles(policy)) {
      const ra = rbacActions(policy, role);
      console.log(`  ${role.padEnd(12)} allow: ${ra.allow.length ? ra.allow.join(" ") : "（空 → 默认全拒）"}${ra.deny.length ? `\n  ${" ".repeat(12)} deny:  ${ra.deny.join(" ")}（deny 优先）` : ""}`);
    }
    console.log(`\n  判定次序：未知角色拒 → deny 命中拒 → allow 命中放 → 默认拒`);
    console.log(`  模板播种：echo '${JSON.stringify(DEFAULT_RBAC_POLICY)}' > ${path.join(ws, RBAC_POLICY_FILE)}`);
    console.log(`  工具环启用：ORG_RBAC_ROLE=<角色> 启动（未设 = 门控完全不启用，单机缺省 owner 全放行）`);
    return 0;
  }
  if (verb === "check") {
    const [_, role, action] = a.rest;
    if (!role || !action) { console.error("用法：org rbac check <角色> <动作（如 tool:fs_write / cli:db）>"); return 2; }
    const d = rbacCheck(policy, role, action);
    console.log(`${d.allowed ? "✓ 放行" : "✗ 拒绝"} · ${d.role} × ${d.action} · rule=${d.rule}`);
    if (d.reason) console.log(`  ${d.reason}`);
    return d.allowed ? 0 : 1;
  }
  console.error(`未知子命令：${verb}（list|check）`);
  return 2;
}

/** org iacscan [dirs…] —— 容器/IaC 静态扫描（#147）。 */
async function cmdIacscan(a: Args): Promise<number> {
  const ws = defaultWorkspace(a);
  const dirs = a.rest.filter((r) => !r.startsWith("--"));
  const r = scanIac(ws, dirs.length > 0 ? { dirs } : {});
  console.log(`🛡 IaC 扫描：${r.scanned}/${r.files} 候选文件 · ${r.hits.length} 命中 · ${r.tookMs}ms（${IAC_RULES.length} 条规则：Dockerfile/compose/terraform）${r.truncated ? "（超文件帽截断）" : ""}`);
  if (r.skippedBinary + r.skippedOversize + r.skippedRead > 0) {
    console.log(`  降级跳过：二进制 ${r.skippedBinary} · 超限 ${r.skippedOversize} · 读失败 ${r.skippedRead}`);
  }
  if (r.hits.length === 0) { console.log("\n✓ 未发现 IaC 风险模式"); return 0; }
  const order = { high: 0, medium: 1, low: 2 } as const;
  const hits = [...r.hits].sort((x, y) => order[x.severity] - order[y.severity]);
  for (const h of hits) console.log(`  [${h.severity.toUpperCase().padEnd(6)}] ${h.ruleId}  ${h.file}:${h.line}\n         ${h.message}\n         💡 ${h.hint}`);
  const high = hits.filter((h) => h.severity === "high").length;
  console.log(`\n  ${high} 条高危`);
  return high > 0 ? 1 : 0;
}

/** org plugin [list|install <source>|remove <name>|validate <dir>] —— 插件市场（#132）。 */
async function cmdPlugin(a: Args): Promise<number> {
  const verb = a.rest[0] ?? "list";
  const ws = defaultWorkspace(a);
  if (verb === "list") {
    const { plugins, dir } = pluginList(ws);
    console.log(`🧩 插件清单（${dir} · ${plugins.length} 个 · 本模块只装不执行，执行面是路线图）`);
    if (!gitAvailable()) console.log("  ⚠ git 缺席：install 的远程源不可用（本地目录源不受影响）");
    if (plugins.length === 0) { console.log(`\n（空 —— org plugin install <本地目录|git URL>）`); return 0; }
    for (const p of plugins) {
      const m = p.manifest;
      if (!m) { console.log(`  ✗ ${path.basename(p.path)}（manifest 不可解析）`); continue; }
      console.log(`  ${p.valid ? "✓" : "✗"} ${m.name}@${m.version}${m.permissions.length ? ` · 权限 ${m.permissions.join(" ")}` : " · ⚠ 无权限声明（RBAC 联动缺位）"}`);
      console.log(`      ${m.description}${p.problems.length ? `\n      问题：${p.problems.join("；")}` : ""}`);
    }
    return 0;
  }
  if (verb === "install") {
    const source = a.rest[1];
    if (!source) { console.error("用法：org plugin install <本地插件目录|https://…|file://…>"); return 2; }
    const r = pluginInstall(ws, source);
    if (!r.ok) {
      const kindText: Record<string, string> = { conflict: "重名冲突（原件未动）", invalid: "manifest 校验失败", "tool-absent": "git 缺席（远程源不可用）", internal: "内部错误" };
      console.error(`✗ 安装失败（${kindText[r.kind] ?? r.kind}）：${r.error}`);
      return 1;
    }
    console.log(`✓ 已安装 ${r.name}@${r.version} → ${path.relative(ws, r.path)}（${PLUGINS_DIR_REL}/）`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    return 0;
  }
  if (verb === "remove") {
    const name = a.rest[1];
    if (!name) { console.error("用法：org plugin remove <name>"); return 2; }
    const r = pluginRemove(ws, name);
    if (!r.ok) { console.error(`✗ 移除失败（${r.kind}）：${r.error}`); return 1; }
    console.log(`✓ 已移除 ${r.name}（${path.relative(ws, r.path)}）`);
    return 0;
  }
  if (verb === "validate") {
    const dir = a.rest[1];
    if (!dir) { console.error("用法：org plugin validate <目录>（市场预览，纯只读）"); return 2; }
    const r = pluginValidate(path.resolve(dir));
    console.log(`${r.valid ? "✓ 可安装" : "✗ 不可安装"}（${dir}）`);
    for (const p of r.problems) console.log(`  - ${p}`);
    return r.valid ? 0 : 1;
  }
  console.error(`未知子命令：${verb}（list|install|remove|validate）`);
  return 2;
}

/** org openapi <spec.json> —— OpenAPI/Swagger 解析 + 工具命名建议（#134）。 */
async function cmdOpenapi(a: Args): Promise<number> {
  const file = a.rest.find((r) => !r.startsWith("--"));
  if (!file) {
    console.error("用法：org openapi <spec.json>");
    console.error(`  OpenAPI 3.x / Swagger 2.0（JSON；YAML 指引转换）；spec 帽 ${OPENAPI_MAX_BYTES / 1024}KB`);
    console.error("  输出：servers · 操作清单（method/path/operationId/参数/security）· suggestToolName 建议名");
    return 2;
  }
  const r = parseOpenApiFile(path.resolve(file));
  if (!r.ok) {
    const kindText: Record<string, string> = { missing: "文件不存在", syntax: "JSON 解析失败", unsupported: "版本不支持（支持 3.x / 2.0）", internal: "内部限制" };
    console.error(`✗ ${kindText[r.kind] ?? r.kind}：${r.error}`);
    return 1;
  }
  console.log(`🔌 ${r.info.title} v${r.info.version}（OpenAPI ${r.version} · ${r.operations.length} 操作 · ${r.schemas} schema）`);
  if (r.servers.length) console.log(`  servers：${r.servers.join(" · ")}`);
  for (const op of r.operations) {
    const params = op.params.map((p) => `${p.in}:${p.name}${p.required ? "!" : ""}`).join(" ");
    console.log(`  ${op.method.padEnd(6)} ${op.path.padEnd(28)} ${op.operationId}${op.security ? " 🔒" : ""}`);
    if (params) console.log(`         参数：${params}`);
    if (op.summary) console.log(`         ${op.summary.slice(0, 100)}`);
    console.log(`         工具名建议：${suggestToolName(op)}`);
  }
  return 0;
}

/** org browser [status|snapshot <url>|screenshot <url>] —— DOM 快照/截图多引擎降级（#116/#30）。 */
async function cmdBrowser(a: Args): Promise<number> {
  const verb = a.rest[0] ?? "status";
  const engines = browserEngines();
  if (verb === "status" || verb === "engines") {
    console.log(`🌐 浏览器引擎链：agent-browser ${engines.agentBrowser ? "✓" : "✗"} → chromium ${engines.chromium ? "✓" : "✗"} → chrome ${engines.chrome ? "✓" : "✗"}`);
    if (engines.hint) console.log(`  ${engines.hint}`);
    console.log("\n  org browser snapshot <url>   —— DOM 快照（标题/正文/链接/图片清单）");
    console.log("  org browser screenshot <url> [--out F] —— 整页截图 PNG");
    return engines.agentBrowser || engines.chromium || engines.chrome ? 0 : 1;
  }
  const url = a.rest[1];
  if (!url || (verb !== "snapshot" && verb !== "screenshot")) {
    console.error("用法：org browser snapshot <url> | org browser screenshot <url> [--out file.png] [--timeout 30000]");
    return 2;
  }
  const tRaw = Number(restFlag(a, "timeout") ?? 30_000);
  const timeoutMs = Number.isFinite(tRaw) ? Math.max(1_000, Math.min(60_000, tRaw)) : 30_000;
  if (verb === "snapshot") {
    const r = await browserSnapshot(url, { timeoutMs });
    if (!r.ok) { console.error(`✗ [${r.kind}] ${r.error}`); if (r.hint) console.error(`  ${r.hint}`); return 1; }
    console.log(`🌐 ${r.url}${r.finalUrl && r.finalUrl !== r.url ? ` → ${r.finalUrl}` : ""} · 引擎 ${r.engine} · ${r.ms}ms${r.title ? `\n标题：${r.title}` : ""}\n`);
    console.log(r.text);
    if (r.links && r.links.length > 0) {
      console.log(`\n链接（${r.links.length}）：`);
      for (const l of r.links.slice(0, 20)) console.log(`  ${l.text.slice(0, 40).padEnd(40)} ${l.href}`);
      if (r.links.length > 20) console.log(`  …（${r.links.length - 20} 更多）`);
    }
    if (r.hint) console.log(`\n⚠ ${r.hint}`);
    return 0;
  }
  const out = restFlag(a, "out");
  const r = await browserScreenshot(url, { timeoutMs, ...(out ? { out: path.resolve(out) } : {}) });
  if (!r.ok) { console.error(`✗ [${r.kind}] ${r.error}`); if (r.hint) console.error(`  ${r.hint}`); return 1; }
  console.log(`📸 ${r.url} → ${r.path} · 引擎 ${r.engine} · ${r.ms}ms`);
  return 0;
}

/** org complete <file> <line> <col> —— 光标处补全（#32）。 */
async function cmdComplete(a: Args): Promise<number> {
  const positional = rawPositionals(a);
  if (positional.length < 3) {
    console.error("用法：org complete <file> <line> <col>（line/col 均 1 基）");
    console.error("  三级候选：同文件符号 > 项目符号 > 语言关键字（HSL/TS/PY）");
    console.error("  诚实边界：点后成员补全/类型推断是 LSP 路线图（空候选附原因，绝不臆造）");
    return 2;
  }
  const [file, lineS, colS] = positional;
  const ws = defaultWorkspace(a);
  const abs = path.isAbsolute(file!) ? file! : path.join(ws, file!);
  let lineText: string;
  try {
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    lineText = lines[Number(lineS) - 1] ?? "";
  } catch (e) {
    console.error(`✗ 无法读取 ${file}：${(e as Error).message}`);
    return 1;
  }
  // dirs:[""] = 工作区根扫（用户工作区是通用布局而非 org 仓形态 —— 与工具环 complete_at / Web 端点同规）
  const r = await completeAt(ws, file!, lineText, Math.max(0, Number(colS) - 1), { dirs: [""] });
  console.log(`⌨ ${file}:${lineS}:${colS}（${r.language}${r.prefix ? ` · 前缀 "${r.prefix}"` : ""}）`);
  if (r.candidates.length === 0) {
    console.log(`（无候选 —— ${r.reason ?? "前缀无命中"}）`);
    return 0;
  }
  for (const c of r.candidates) console.log(`  ${String(c.score).padStart(4)}  ${c.kind.padEnd(8)} ${c.label.padEnd(28)} ${c.source} · ${c.detail.slice(0, 60)}`);
  return 0;
}

/** org rename <old> <new> [--apply] —— 项目级重命名（#56；缺省 dryRun 预览）。 */
async function cmdRename(a: Args): Promise<number> {
  const positional = rawPositionals(a);
  if (positional.length < 2) {
    console.error("用法：org rename <旧名> <新名> [--apply]");
    console.error("  缺省 dryRun：计划 + 逐文件 unified diff 预览（≤5 文件）不落盘；--apply 真写");
    console.error("  拒绝面：找不到定义 / 目标名冲突 / 新名非法或关键字 —— 附原因");
    return 2;
  }
  const [oldName, newName] = positional;
  const ws = defaultWorkspace(a);
  // dirs:[""] = 工作区根扫（同 cmdComplete —— 与工具环 rename_symbol / Web 端点同规）
  const r = await applyRename(ws, oldName!, newName!, { dryRun: !restBool(a, "apply"), dirs: [""] });
  if (!r.ok) {
    console.error(`✗ 不可执行：${r.reason ?? "计划不可执行"}`);
    if (r.plan.definition) console.error(`  定义：${r.plan.definition.file}:${r.plan.definition.line}`);
    for (const w of r.plan.warnings) console.error(`  ⚠ ${w}`);
    return 1;
  }
  const def = r.plan.definition!;
  console.log(`${r.dryRun ? "🔍 dryRun 预览" : "✓ 已应用"}：${def.kind} ${oldName} → ${newName}（定义 ${def.file}:${def.line} · ${r.plan.edits.length} 处编辑 · ${new Set(r.plan.edits.map((e) => e.file)).size} 文件）`);
  for (const w of r.plan.warnings) console.log(`  ⚠ ${w}`);
  if (r.dryRun) {
    for (const p of r.previews ?? []) {
      console.log(`\n--- ${p.file}（${p.stats}）`);
      const lines = p.diff.split("\n").slice(2); // 剥掉 --- a/+++ b 头两行（CLI 已给文件名）
      for (const l of lines.slice(0, 24)) console.log(`  ${l}`);
      if (lines.length > 24) console.log(`  …（${lines.length - 24} 更多行）`);
    }
    if (r.previewTruncated) console.log(`\n  …（预览帽 5 文件，共 ${r.filesTotal} 文件 —— 全量用 org rename --apply）`);
    console.log(`\n  落盘：org rename ${oldName} ${newName} --apply`);
  } else {
    for (const f of r.applied ?? []) console.log(`  ✓ ${f.file}（${f.lines} 行 · ${f.occurrences} 处）`);
    if (r.failed) console.error(`  ✗ 止步于 ${r.failed.file}：${r.failed.error}`);
  }
  return r.failed ? 1 : 0;
}

// ---- org collab：团队协作（v0.5.17 · capabilities #87 团队共享会话/评论） --------
// 在单用户会话账本之上叠多用户协作层（lib/collab.ts · runtime/collab/）：
// append-only JSONL 团队线程 + 回复树 + @mention + 会话账本桥（只镜像不改写）。
// 子命令：whoami/user（身份）· threads/feed（读）· post/comment（写）·
// users/summary（视图）· bridge（单用户账本 → 团队可见）。

async function cmdCollab(a: Args): Promise<number> {
  const verb = a.rest[0] ?? "";
  const ws = a.workspace;
  // 位置参数提取：parseArgs 已把已识别旗标（--workspace 等）连同其值从 a.rest
  // 消化掉；这里再滤掉 collab 自有旗标（--since/--thread —— 值旗标连值跳过）。
  // 不用 rawPositionals（它扫 process.argv 会把 --workspace 的值当位置参数，
  // post 的文本会被工作区路径污染 —— smoke 实测踩到）。
  const VALUE_FLAGS = new Set(["since", "thread"]);
  const pos: string[] = [];
  for (let i = 1; i < a.rest.length; i++) {
    const t = a.rest[i]!;
    if (t.startsWith("--")) {
      if (!t.includes("=") && VALUE_FLAGS.has(t.slice(2))) i++; // 跳过该旗标的值
      continue;
    }
    pos.push(t);
  }
  const usage = (): number => {
    console.error("用法：");
    console.error("  org collab whoami                     当前协作用户（env > 身份文件 > local）");
    console.error("  org collab user <userId> [显示名]     切换协作用户（写 runtime/collab/collab-user）");
    console.error("  org collab threads                    团队线程清单（标题 · 参与者 · 帖数）");
    console.error("  org collab feed <threadId> [--since N] 线程增量读（回复树缩进渲染）");
    console.error('  org collab post <threadId> "<text>"    发帖（@mention 自动抽取）');
    console.error('  org collab comment <threadId> <seq> "<text>"  评论指定帖（replyTo 树）');
    console.error("  org collab users                      协作者视图（去重用户 · 发帖数 · 活跃）");
    console.error("  org collab summary                    协作摘要（线程/帖/评论/用户/最后活动）");
    console.error("  org collab bridge <expert> [sessionId] 单用户会话账本镜像成团队线程（只镜像不改写，幂等）");
    console.error(`  协议：${COLLAB_DIR_REL}/threads/*.jsonl（append-only JSONL）；身份覆盖：ORG_COLLAB_USER=<userId>`);
    return 2;
  };
  if (!verb) return usage();
  ensureWorkspace(a.workspace); // 与 cmdSessions 同规：协作是写面，不回退 dist/demo 只读快照
  try {
    if (verb === "whoami") {
      const id = currentUser(ws);
      const src: Record<string, string> = { env: "环境变量 ORG_COLLAB_USER", file: "身份文件（持久）", default: "缺省（首次协作）" };
      console.log(`👤 当前协作用户：${id.user}（来源：${src[id.source]}）`);
      if (id.display) console.log(`  显示名：${id.display}`);
      if (id.setAt) console.log(`  设置于：${id.setAt}`);
      console.log(`  协作目录：${COLLAB_DIR_REL}/（线程 threads/*.jsonl · append-only JSONL）`);
      console.log(`  切换：org collab user <userId>（或 ORG_COLLAB_USER 环境变量一次性覆盖）`);
      return 0;
    }
    if (verb === "user") {
      const userId = pos[0] ?? "";
      if (!userId) { console.error("用法：org collab user <userId> [显示名]（如 org collab user alice \"Alice L\"）"); return 2; }
      const display = pos.slice(1).join(" ");
      const id = setUser(ws, userId, display.length > 0 ? display : undefined);
      console.log(`✓ 协作用户已切换：${id.user}${id.display ? `（${id.display}）` : ""} → ${COLLAB_DIR_REL}/collab-user`);
      console.log(`  后续 org collab post/comment 以 ${id.user} 署名；ORG_COLLAB_USER 可按次覆盖`);
      return 0;
    }
    if (verb === "threads" || verb === "list") {
      const list = listThreads(ws);
      console.log(`👥 团队线程（${COLLAB_DIR_REL}/threads · ${list.length} 个 · append-only JSONL）`);
      if (list.length === 0) {
        console.log('\n（空 —— org collab post <threadId> "<text>" 开启第一条线程）');
        return 0;
      }
      for (const t of list) {
        console.log(`  ${t.id.padEnd(24)} ${t.title}`);
        console.log(`  ${"".padEnd(24)} ${t.posts} 帖（${t.comments} 评论）· ${t.participants.join(", ")} · 最后活动 ${t.lastActive.replace("T", " ").slice(0, 19)}`);
      }
      console.log(`\n  命令：org collab feed <threadId> [--since N]（增量读）· org collab post <threadId> "…"`);
      return 0;
    }
    if (verb === "feed") {
      const threadId = pos[0] ?? "";
      if (!threadId) { console.error("用法：org collab feed <threadId> [--since N]"); return 2; }
      const sinceRaw = restFlag(a, "since");
      const sinceSeq = sinceRaw !== undefined ? Math.max(0, Math.floor(Number(sinceRaw) || 0)) : 0;
      const feed = threadFeed(ws, threadId, { sinceSeq });
      console.log(`◆ 线程 ${threadId} · since #${feed.sinceSeq} · ${feed.posts.length} 帖${feed.truncated ? "（超 2000 帖截断）" : ""}`);
      if (feed.posts.length === 0) {
        console.log(`\n（since #${sinceSeq} 之后无新帖 —— 协作轮询增量车道）`);
        return 0;
      }
      for (const p of flattenThread(feed.posts)) {
        const indent = "  " + "    ".repeat(p.depth);
        const kindMark = p.kind === "comment" ? "评论" : p.kind === "system" ? "系统" : "帖";
        const replyMark = p.replyTo !== undefined ? ` ↳ #${p.replyTo}` : "";
        const mentionMark = p.mentions && p.mentions.length > 0 ? ` · @${p.mentions.join(" @")}` : "";
        const ts = p.at.replace("T", " ").slice(0, 19);
        console.log(`${indent}#${String(p.seq).padStart(3)} ${p.user}${p.role ? `(${p.role})` : ""} · ${ts} · ${kindMark}${replyMark}${mentionMark}`);
        const firstLine = p.text.split("\n")[0] ?? "";
        const shown = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        console.log(`${indent}    ${shown}`);
        if (p.text.split("\n").length > 1) console.log(`${indent}    …（${p.text.split("\n").length - 1} 更多行 · org collab feed 全文见 ${COLLAB_DIR_REL}/threads/${threadId}.jsonl）`);
      }
      return 0;
    }
    if (verb === "post") {
      const threadId = pos[0] ?? "";
      const text = pos.slice(1).join(" ");
      if (!threadId || !text) { console.error('用法：org collab post <threadId> "<text>"（@mention 自动抽取）'); return 2; }
      const user = currentUser(ws).user;
      const r = postThread(ws, threadId, user, text);
      console.log(`✓ 已发帖 ${threadId} #${r.seq}（${user}${r.mentions.length > 0 ? ` · 已提及 @${r.mentions.join(" @")}` : ""}）`);
      return 0;
    }
    if (verb === "comment") {
      const threadId = pos[0] ?? "";
      const seqRaw = pos[1] ?? "";
      const text = pos.slice(2).join(" ");
      const targetSeq = Math.floor(Number(seqRaw));
      if (!threadId || !seqRaw || !Number.isFinite(targetSeq) || !text) {
        console.error('用法：org collab comment <threadId> <seq> "<text>"（评论挂 replyTo 树）');
        return 2;
      }
      const user = currentUser(ws).user;
      const r = commentOn(ws, threadId, targetSeq, user, text);
      console.log(`✓ 已评论 ${threadId} #${r.seq}（↳ #${targetSeq} · ${user}）`);
      return 0;
    }
    if (verb === "users") {
      const users = collaborators(ws);
      console.log(`👥 协作者（${users.length} 位 · 扫描全部线程去重 · 发帖数降序）`);
      if (users.length === 0) { console.log("\n（尚无协作者 —— org collab post 后这里会出现署名用户）"); return 0; }
      for (const u of users) {
        console.log(`  ${u.user.padEnd(24)} ${String(u.posts).padStart(3)} 帖 · 最后活跃 ${u.lastActive.replace("T", " ").slice(0, 19)}`);
      }
      return 0;
    }
    if (verb === "summary") {
      const s = collabSummary(ws);
      if (s.threads === 0 && s.posts === 0) {
        console.log("📊 协作摘要：尚无协作活动（org collab post 开启第一条线程，或 org collab bridge 镜像既有会话）");
        return 0;
      }
      console.log(`📊 协作摘要：${s.threads} 线程 · ${s.posts} 帖（${s.comments} 评论）· ${s.users} 位协作者`);
      console.log(`  最后活动：${s.lastActive ? s.lastActive.replace("T", " ").slice(0, 19) : "—"} · 协议 ${COLLAB_DIR_REL}/threads/*.jsonl（append-only）`);
      return 0;
    }
    if (verb === "bridge") {
      const expert = (pos[0] ?? "").toLowerCase();
      if (!expert) { console.error("用法：org collab bridge <expert> [sessionId]（缺省取该专家最近会话）"); return 2; }
      const session = pos[1] || latestSession(ws, expert);
      // 缺省线程 id 由 expert/session 派生：归一到 SAFE_THREAD_ID 词形（大写折叠、
      // 非法字符折成连字符、截 64）—— 用户显式 --thread 不做变换（不合法即诚实报错）
      const derived = `session-${expert}-${session}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, (m) => m ? "-" : "").slice(0, 64);
      const threadId = restFlag(a, "thread") ?? (derived.length > 0 ? derived : "session");
      const user = currentUser(ws).user;
      const r = bridgeSession(ws, expert, session, threadId, { user });
      console.log(`🌉 已镜像 ${expert}/${session} → 线程 ${threadId}：${r.mirrored}/${r.turns} 轮（${r.skipped} 轮已镜像跳过 · kind:"system" · 原账本字节不变）`);
      console.log(`  团队查看：org collab feed ${threadId}`);
      return 0;
    }
    console.error(`未知子命令：${verb}`);
    return usage();
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/** org lsp [definition|references|hover|servers|protocol] <name> —— LSP/DAP 协议集成（#26）。 */
async function cmdLsp(a: Args): Promise<number> {
  const positional = rawPositionals(a);
  const verb = positional[0] ?? "help";
  const ws = defaultWorkspace(a);
  if (verb === "definition" || verb === "references" || verb === "hover") {
    const name = positional[1];
    if (!name) {
      console.error(`用法：org lsp ${verb} <符号名> [--workspace DIR]`);
      console.error("  内置符号索引车道（无外部 server 时的主车道）· 输出 LSP 0 基 uri/range + 人读 1 基行列双形");
      return 2;
    }
    if (verb === "definition") {
      const r = lspDefinition(ws, name);
      if (!r.ok) { console.error(`✗ ${r.reason}`); return 1; }
      console.log(`🎯 ${name} —— ${r.definitions.length} 处定义（${r.lane === "builtin" ? "内置符号索引车道" : r.lane}）`);
      if (r.definitions.length === 0) { console.log(`（${r.reason}）`); return 0; }
      for (const d of r.definitions) {
        console.log(`  ${String(d.line).padStart(4)}:${String(d.column).padStart(3)}  ${d.kind.padEnd(6)} ${d.file}  ${d.snippet.slice(0, 60)}`);
        console.log(`         LSP ${d.lsp.uri} range ${d.lsp.range.start.line}:${d.lsp.range.start.character}`);
      }
      return 0;
    }
    if (verb === "references") {
      const r = lspReferences(ws, name);
      if (!r.ok) { console.error(`✗ ${r.reason}`); return 1; }
      const calls = r.refs.filter((x) => x.kind === "call").length;
      console.log(`🔗 ${name} —— ${r.refs.length} 处引用（call ${calls} · mention ${r.refs.length - calls}）+ ${r.definitions} 处定义（定义行已排除${r.truncated ? " · 截断" : ""}）`);
      if (r.refs.length === 0) { console.log(`（${r.reason ?? "无引用"}）`); return 0; }
      for (const x of r.refs) console.log(`  ${String(x.line).padStart(4)}:${String(x.column).padStart(3)}  ${x.kind.padEnd(8)} ${x.file}  ${x.snippet.slice(0, 60)}`);
      return 0;
    }
    const r = lspHover(ws, name);
    if (!r.ok) { console.error(`✗ ${r.reason}`); return 1; }
    if (!r.hover) { console.log(`💬 ${name} —— hover 为空（${r.reason}）`); return 0; }
    console.log(`💬 ${r.hover.name}（${r.hover.kind} · ${r.hover.file}:${r.hover.line}）`);
    for (const c of r.hover.contents) console.log(`  ${c}`);
    return 0;
  }
  if (verb === "servers") {
    const probes = detectLspServers();
    const hit = probes.filter((p) => p.available);
    console.log(`🔎 外部 LSP server 探测（${probes.length} 个已知 server，which 探测）：`);
    for (const p of probes) console.log(`  ${p.available ? "✓" : "✗"} ${p.name.padEnd(28)} ${p.path ?? "缺席"}`);
    if (hit.length === 0) {
      console.log("\n  （全部缺席 —— 诚实降级到内置符号索引车道：org lsp definition/references/hover <名>）");
      return 1;
    }
    console.log(`\n  spawn 车道可用：spawnLspServer(cmd, args) 走真协议（lib/lsp.ts —— initialize → initialized → shutdown → exit）`);
    return 0;
  }
  if (verb === "protocol" || verb === "self-test" || verb === "selftest") {
    const r = protocolSelfTest();
    console.log(`🧪 LSP/DAP JSON-RPC 2.0 协议层自检（Content-Length 分帧 · LSP 与 DAP 共用）`);
    for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    console.log(`\n  ${r.passed}/${r.total} 通过`);
    return r.ok ? 0 : 1;
  }
  console.error(`用法：org lsp definition <名> | references <名> | hover <名> | servers | protocol [--self-test]`);
  console.error("  协议层（JSON-RPC 2.0 分帧）+ 内置符号索引车道（主车道）+ 外部 server spawn 车道（降级第 2 层）");
  console.error("  诚实边界：真编辑器级 LSP 会话（didOpen/didChange/补全路由）是路线图");
  return 2;
}

/** org debug [suggest|plan] <file> | dap —— 断点/调试建议（#108）。 */
async function cmdDebug(a: Args): Promise<number> {
  const positional = rawPositionals(a);
  const verb = positional[0] ?? "help";
  const ws = defaultWorkspace(a);
  if (verb === "suggest" || verb === "plan") {
    const file = positional[1];
    if (!file) {
      console.error(`用法：org debug ${verb} <文件> [--workspace DIR]（工作区相对路径）`);
      console.error("  入口/分支/循环/return 前断点建议（符号级 > 启发式级，每条带 reason）");
      return 2;
    }
    if (verb === "suggest") {
      const r = suggestBreakpoints(ws, file);
      if (!r.ok) { console.error(`✗ ${r.reason}`); return 1; }
      console.log(`🐞 ${r.file}（${r.language} · ${r.lines} 行 · ${r.suggestions.length} 处建议断点${r.truncated ? "（截断）" : ""}）`);
      if (r.suggestions.length === 0) { console.log(`（${r.reason}）`); return 0; }
      for (const s of r.suggestions) console.log(`  ${String(s.line).padStart(4)}  [${s.confidence === "symbol" ? "符号" : "启发"}] ${s.reason} · ${s.snippet.slice(0, 60)}`);
      return 0;
    }
    const r = debugPlan(ws, file);
    if (!r.ok) { console.error(`✗ ${r.reason}`); return 1; }
    console.log(`📋 调试计划：${r.file}（${r.suggestions} 处断点建议 · ${r.steps.length} 步 · ${r.language}）`);
    for (const st of r.steps) {
      console.log(`\n  第 ${st.step} 步 · ${st.title}`);
      console.log(`    ${st.detail}`);
    }
    console.log(`\n  DAP 消息序列（协议就绪 · ${r.dapMessages.length} 条）：`);
    for (const m of r.dapMessages) console.log(`    seq=${m.seq} ${m.command} ${JSON.stringify(m.arguments).slice(0, 100)}`);
    console.log("\n  诚实边界：不 spawn 真 debug adapter（沙箱无）—— 真 DAP attach 是路线图");
    return 0;
  }
  if (verb === "dap" || verb === "self-test" || verb === "selftest") {
    const r = dapSelfTest();
    console.log("🧪 DAP 构造器自检（initialize/setBreakpoints/stackTrace/threads 字段忠实性 + 分帧共用）");
    for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    console.log(`\n  ${r.passed}/${r.total} 通过`);
    return r.ok ? 0 : 1;
  }
  console.error("用法：org debug suggest <文件> | plan <文件> | dap [--self-test]（breakpoints 是 debug 的别名）");
  console.error("  断点建议器（符号索引 + 源码行扫描）+ 调试计划（步骤说明 + DAP 协议就绪消息序列）");
  return 2;
}

// ---- org cloud：云生态统一入口（v0.5.17 · #67/#68/#72/#74）----------------------

/** CloudRunResult 统一渲染（docker/ssh/k8s 执行车道 —— 成功吐输出、失败吐 kind+reason）。 */
function renderCloudRun(r: CloudRunResult, label: string): number {
  const argvPreview = r.argv.join(" ").slice(0, 160);
  if (!r.ok) {
    const kindText: Record<string, string> = {
      denied: "白名单拒绝（未执行）", "tool-absent": "CLI 缺席（降级车道可用）",
      "host-not-allowed": "host 未获放行", jail: "路径越界（工作区监狱）",
      timeout: "超时/进程异常", failed: "执行失败（退出码非 0）",
    };
    console.error(`✗ ${label}（${kindText[r.kind ?? "?"] ?? r.kind}）：${r.reason ?? ""}`);
    console.error(`  argv（数组参数 · 零 shell 面）：${argvPreview}`);
    return 1;
  }
  console.log(`✓ ${label}（${r.tookMs}ms · argv 数组参数）：${argvPreview}`);
  if (r.stdout.trim().length > 0) console.log(r.stdout.trim().split("\n").slice(0, 60).join("\n"));
  if (r.stderr.trim().length > 0) console.log(`（stderr）${r.stderr.trim().split("\n").slice(0, 10).join("\n")}`);
  return 0;
}

/** org cloud —— Docker/SSH/K8s/Terraform/云 CLI 五面统一入口（多重优雅降级）。 */
async function cmdCloud(a: Args): Promise<number> {
  // rest 保持原始形态（docker/kubectl 的 --flag 须原样透传；org 自有旗标已被
  // parseArgs 消费不会落入 rest —— 与 cmdIacscan 的过滤式不同，这里是透传式）
  const positional = a.rest ?? [];
  const verb = positional[0] ?? "probe";
  const ws = defaultWorkspace(a);

  // ---- 探测面（全景 / 单面）----
  if (verb === "probe") {
    const what = positional[1];
    if (what === "docker") {
      const p = probeDocker();
      console.log(`🐳 docker：${p.available ? `✓ 在场（${p.version ?? "?"}）` : "✗ 缺席"} · 守护进程 ${p.daemonReachable ? "✓ 可达" : "✗ 不可达"}`);
      if (p.reason) console.log(`  ${p.reason}`);
      return p.available && p.daemonReachable ? 0 : 1;
    }
    if (what === "ssh") {
      const p = probeSsh();
      console.log(`🔐 ssh：${p.available ? `✓ 在场（${p.version ?? "?"}）` : "✗ 缺席"} · ~/.ssh ${p.sshDirExists ? "存在" : "无"} · config ${p.configExists ? "✓" : "✗"} · known_hosts ${p.knownHostsExists ? "✓" : "✗"}（只看存在性，绝不读内容）`);
      if (p.reason) console.log(`  ${p.reason}`);
      return p.available ? 0 : 1;
    }
    if (what === "k8s") {
      const p = probeK8s();
      console.log(`☸ kubectl：${p.available ? `✓ 在场（v${p.version ?? "?"}）` : "✗ 缺席"} · 集群 ${p.clusterReachable ? "✓ 可达" : "✗ 不可达"}`);
      if (p.reason) console.log(`  ${p.reason}`);
      return p.available && p.clusterReachable ? 0 : 1;
    }
    if (what === "tf" || what === "terraform") {
      const p = probeTerraform();
      console.log(`🏗 terraform：${p.available ? `✓ 在场（v${p.version ?? "?"}）` : "✗ 缺席"}`);
      if (p.reason) console.log(`  ${p.reason}`);
      return p.available ? 0 : 1;
    }
    if (what === "clis") {
      const clis = probeCloudClis();
      for (const c of clis) console.log(`  ${c.available ? "✓" : "⬜"} ${c.name.padEnd(9)} ${c.available ? (c.version ?? "").slice(0, 50) : c.installHint}`);
      return 0;
    }
    if (what) { console.error(`未知探测面：${what}（docker|ssh|k8s|tf|clis；缺省全景）`); return 2; }
    const r = cloudProbeAll();
    const s = r.summary;
    console.log(`☁ 云生态全景探测（${r.tookMs}ms）：`);
    console.log(`  🐳 docker    ${s.dockerAvailable ? "✓ CLI 在场" : "✗ 缺席"}${s.dockerAvailable ? ` · 守护进程 ${s.dockerDaemon ? "✓" : "✗"}` : ""}`);
    console.log(`  🔐 ssh       ${s.sshAvailable ? "✓ 在场" : "✗ 缺席"}`);
    console.log(`  ☸ kubectl   ${s.k8sAvailable ? "✓ 在场" : "✗ 缺席"}${s.k8sAvailable ? ` · 集群 ${s.k8sCluster ? "✓" : "✗"}` : ""}`);
    console.log(`  🏗 terraform ${s.terraformAvailable ? "✓ 在场" : "✗ 缺席"}`);
    console.log(`  ☁ 云 CLI    ${s.clisAvailable}/${s.clisTotal} 家在场`);
    const anyUp = s.dockerDaemon || s.sshAvailable || s.k8sCluster || s.terraformAvailable || s.clisAvailable > 0;
    if (!anyUp) {
      console.log(`\n  工具缺席环境 —— 降级车道即主车道：`);
      console.log(`    org cloud dockerfile <node|bun|python|rust>   生产级 Dockerfile 模板`);
      console.log(`    org cloud compose                             docker-compose 模板`);
      console.log(`    org cloud plan <build|run|push|debug|cleanup>  可粘贴命令序列`);
      console.log(`    org cloud manifest <kind>                     K8s 五族 manifest 模板`);
      console.log(`    org cloud terraform                           main.tf 骨架`);
      console.log(`    org cloud ssh-template                        ~/.ssh/config 片段模板`);
    }
    return 0;
  }

  // ---- #67 Docker 执行与模板 ----
  if (verb === "docker") {
    const rest = positional.slice(1);
    if (rest.length === 0) { console.error(`用法：org cloud docker <子命令> [args...]（白名单：${DOCKER_SUBCOMMANDS.join("/")}）`); return 2; }
    return renderCloudRun(dockerRun(rest[0]!, rest.slice(1)), `docker ${rest[0]}`);
  }
  if (verb === "build") {
    const ctx = positional[1] ?? ".";
    const tagIdx = positional.indexOf("--tag");
    const tag = tagIdx > 0 ? positional[tagIdx + 1] : undefined;
    return renderCloudRun(dockerBuild(ws, ctx, tag ? { tag } : {}), `docker build ${ctx}`);
  }
  if (verb === "dockerfile") {
    const t = positional[1] ?? "node";
    let r;
    try { r = dockerfileFor(t); } catch (e) { console.error(`✗ ${e instanceof Error ? e.message : String(e)}（四型：${DOCKERFILE_TYPES.join("/")}）`); return 2; }
    console.log(`🐳 Dockerfile 模板（${r.projectType} 型 · 多阶段 · 非 root · healthcheck）：`);
    console.log(r.dockerfile.trimEnd());
    console.log(`\n  采纳建议：`);
    for (const n of r.notes) console.log(`    - ${n}`);
    console.log(`\n  落盘：保存为 Dockerfile 后 org cloud build .（context 过工作区监狱）`);
    return 0;
  }
  if (verb === "compose") {
    const r = composeFor({ appName: positional[1] ?? "app" });
    console.log("🐳 docker-compose.yml 模板（服务 · 专用网络 · 具名卷 · healthcheck）：");
    console.log(r.compose.trimEnd());
    for (const n of r.notes) console.log(`  💡 ${n}`);
    return 0;
  }
  if (verb === "plan") {
    const action = positional[1] ?? "build";
    let p;
    try { p = dockerPlan(action); } catch (e) { console.error(`✗ ${e instanceof Error ? e.message : String(e)}（五意图：${DOCKER_PLAN_ACTIONS.join("/")}）`); return 2; }
    console.log(`📋 docker 命令计划（意图 ${p.action} · 可直接粘贴）：`);
    for (const [i, s] of p.steps.entries()) console.log(`  ${i + 1}. ${s.cmd}\n     # ${s.note}`);
    if (p.warning) console.log(`\n  ⚠ ${p.warning}`);
    return 0;
  }

  // ---- #68 SSH ----
  if (verb === "ssh") {
    const host = positional[1];
    const command = positional.slice(2).join(" ");
    if (!host || !command) { console.error(`用法：org cloud ssh <host> "<command>"（host 须在 <ws>/${SSH_HOSTS_ALLOW} 白名单内）`); return 2; }
    return renderCloudRun(sshRun(ws, host, command), `ssh ${host}`);
  }
  if (verb === "scp") {
    const [host, local, remote] = positional.slice(1);
    if (!host || !local || !remote) { console.error("用法：org cloud scp <host> <local（工作区内）> <remote路径>"); return 2; }
    return renderCloudRun(scpUpload(ws, host, local, remote), `scp ${host}`);
  }
  if (verb === "ssh-template") {
    const t = sshConfigTemplate();
    console.log("🔐 ~/.ssh/config 片段模板（追加到你自己的 ~/.ssh/config）：");
    console.log(t.config.trimEnd());
    console.log("\n  安全建议：");
    for (const ad of t.advice) console.log(`    - ${ad}`);
    return 0;
  }
  if (verb === "ssh-plan") {
    const host = positional[1] ?? "<host>";
    const command = positional.slice(2).join(" ") || "uptime";
    const p = sshPlan(host, command);
    console.log(`🔐 ssh 计划（${host} · 从零到执行一条命令）：`);
    for (const [i, s] of p.steps.entries()) console.log(`  ${i + 1}. ${s.cmd}\n     # ${s.note}`);
    return 0;
  }
  if (verb === "ssh-hosts") {
    const gate = sshHostAllowed(ws, positional[1] ?? "");
    let count = 0;
    try {
      count = fs.readFileSync(path.join(ws, SSH_HOSTS_ALLOW), "utf-8").split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#")).length;
    } catch { /* 缺席 = 0 */ }
    console.log(`🔐 ${SSH_HOSTS_ALLOW}：${fs.existsSync(gate.file) ? `${count} 个 host 在册` : "未创建（拒绝一切远程执行 —— 安全缺省）"}`);
    console.log(`  路径：${gate.file}`);
    console.log(`  判定 ${positional[1] ? `"${positional[1]}" → ${gate.allowed ? "✓ 放行" : "✗ 拒绝"}` : "（org cloud ssh-hosts <host> 查询）"}`);
    return 0;
  }

  // ---- #72 K8s / Terraform ----
  if (verb === "k8s" || verb === "kubectl") {
    const rest = positional.slice(1);
    if (rest.length === 0) { console.error(`用法：org cloud k8s <args...>（首词白名单：${K8S_SUBCOMMANDS.join("/")}；apply -f 过工作区监狱）`); return 2; }
    return renderCloudRun(k8sRun(ws, rest), `kubectl ${rest[0]}`);
  }
  if (verb === "manifest") {
    const k = positional[1] ?? "deployment";
    let m;
    try { m = k8sManifestFor(k); } catch (e) { console.error(`✗ ${e instanceof Error ? e.message : String(e)}（五族：${K8S_MANIFEST_KINDS.join("/")}）`); return 2; }
    console.log(`☸ K8s ${m.kind} 模板（apiVersion ${m.apiVersion}）：`);
    console.log(m.manifest.trimEnd());
    console.log(`\n  要点：`);
    for (const n of m.notes) console.log(`    - ${n}`);
    console.log(`\n  应用：保存到工作区后 org cloud k8s apply -f <file>（-f 路径过监狱）`);
    return 0;
  }
  if (verb === "terraform" || verb === "tf-template") {
    const r = terraformPlan(positional[1] ?? "aws");
    console.log(`🏗 main.tf 骨架（provider ${r.provider} · 变量 + 输出）：`);
    console.log(r.mainTf.trimEnd());
    console.log(`\n  要点：`);
    for (const n of r.notes) console.log(`    - ${n}`);
    return 0;
  }

  // ---- #74 云 CLI ----
  if (verb === "clis") {
    const clis = probeCloudClis();
    console.log(`☁ 云 CLI 注册表（${clis.length} 家 · 探测 ${clis.filter((c) => c.available).length} 家在场）：`);
    for (const c of clis) console.log(`  ${c.available ? "✓" : "⬜"} ${c.name.padEnd(9)} ${c.available ? (c.version ?? "").slice(0, 56) : c.installHint}`);
    console.log(`\n  文档：${clis[0]!.docsUrl} 等 —— docsUrl 字段见注册表`);
    return 0;
  }
  if (verb === "overview") {
    const o = cloudProvidersOverview();
    console.log(`☁ provider 全景：模型服务商 ${o.modelProviders} 家（推理面）+ 云 CLI ${o.cloudClis} 家（基建面）= ${o.total} 面：`);
    const local = o.providers.filter((p) => p.local).map((p) => p.name);
    console.log(`  模型：${o.providers.filter((p) => !p.local).map((p) => p.name).join(" · ")}`);
    console.log(`  本地推理：${local.join(" · ")}（无需 key）`);
    console.log(`  云 CLI：${o.clis.map((c) => `${c.name}${c.available ? "✓" : ""}`).join(" · ")}`);
    return 0;
  }

  console.error(`未知子命令：${verb}`);
  console.error(`用法：org cloud probe [docker|ssh|k8s|tf|clis] · docker <args...> · build <ctx> · dockerfile <type> · compose · plan <action>`);
  console.error(`      org cloud ssh <host> "<cmd>" · scp <host> <local> <remote> · ssh-template · ssh-plan <host> "<cmd>" · ssh-hosts [host]`);
  console.error(`      org cloud k8s <args...> · manifest <kind> · terraform [provider] · clis · overview（#67/#68/#72/#74 四能力统一入口）`);
  return 2;
}

// ---- org iac：IaC 深度实现入口（v0.5.18 · #44）------------------------------
// 与 org iacscan（#147 静态安全扫描）互补：这里是「解析/规划/生成」面。
// 内置 HCL 子集解析器是主车道（恒在）；terraform/tofu 在场时 validate 外部
// 车道可用（只读）；缺席 → 诚实降级，绝不假装跑过 terraform。

/** 解析结果渲染：块清单（类型 + label + 属性名，嵌套块缩进）。 */
function renderIacBlocks(blocks: IacBlock[], depth = 0): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const label = b.labels.length > 0 ? ` ${b.labels.map((l) => (/["\s]/.test(l) ? `"${l}"` : l)).join(" ")}` : "";
    const attrs = b.attrs.length > 0 ? ` [${b.attrs.map((a) => a.name).join(", ")}]` : "";
    out.push(`${"  ".repeat(depth + 1)}${b.type}${label}${attrs}`);
    if (b.blocks.length > 0) out.push(...renderIacBlocks(b.blocks, depth + 1));
  }
  return out;
}

/** org iac [parse|plan|graph|generate|probe|validate|self-test]。 */
async function cmdIac(a: Args): Promise<number> {
  const positional = rawPositionals(a);
  const verb = positional[0] ?? "help";
  const ws = defaultWorkspace(a);

  if (verb === "parse" || verb === "plan" || verb === "graph") {
    const file = positional[1];
    if (!file) {
      console.error(`用法：org iac ${verb} <main.tf> [--workspace DIR]（工作区相对路径）`);
      console.error("  内置 HCL 子集解析器（零依赖主车道）：block/label/属性/插值/heredoc/注释");
      return 2;
    }
    const r = iacParseFile(ws, file);
    if (!r.ok) {
      console.error(`✗ [${r.kind}] ${r.reason}`);
      if (r.errors.length > 1) for (const e of r.errors.slice(0, 5)) console.error(`  第 ${e.line} 行：${e.message.replace(/^第 \d+ 行：/, "")}`);
      return 1;
    }
    if (verb === "parse") {
      console.log(`🧱 ${r.file} 解析成功（${r.ast.length} 顶层块 · ${r.ast.reduce((s, b) => s + b.attrs.length, 0)} 直接属性 · ${r.tookMs}ms · 内置 HCL 解析器）：`);
      for (const line of renderIacBlocks(r.ast)) console.log(line);
      return 0;
    }
    if (verb === "graph") {
      const g = iacGraph(r.ast);
      console.log(`🕸 依赖图：${g.nodes.length} 节点 · ${g.edges.length} 边（${r.file}）`);
      for (const e of g.edges) console.log(`  ${e.from}  →  ${e.to}    （${e.via} · 第 ${e.line} 行）`);
      if (g.undeclaredRefs.length > 0) {
        console.log(`  ⚠ ${g.undeclaredRefs.length} 处未声明引用（apply 前须补声明）：`);
        for (const u of g.undeclaredRefs.slice(0, 10)) console.log(`      ${u.from} → ${u.via}（第 ${u.line} 行）`);
      }
      if (!g.ok) {
        console.error(`\n✗ ${g.reason}`);
        for (const c of g.cycles.slice(0, 3)) console.error(`  环：${c.join(" → ")}`);
        return 1;
      }
      console.log(`\n  拓扑序（被依赖在前）：${g.order.join(" → ")}`);
      return 0;
    }
    // plan
    const p = iacPlan(r.ast);
    if (!p.ok) {
      console.error(`✗ ${p.reason}`);
      for (const c of p.cycles?.slice(0, 3) ?? []) console.error(`  环：${c.join(" → ")}`);
      return 1;
    }
    console.log(p.text);
    return 0;
  }

  if (verb === "generate") {
    const manifest = positional[1];
    if (!manifest) {
      console.error("用法：org iac generate <manifest.json> [--workspace DIR]（工作区相对路径）");
      console.error('  manifest：{provider, region?, variables?, resources:[{type,name,attrs}], outputs?}');
      console.error('  $ref 引用形：{"$ref":"var.instance_type"} → instance_type = var.instance_type');
      console.error("  生成结果可直接被 iacParse 解析（往返自洽 —— 逆操作验证）");
      return 2;
    }
    const abs = resolveInWorkspace(ws, manifest);
    if (!inWorkspace(ws, abs)) { console.error(`✗ manifest 路径越界（须在工作区内）：${manifest}`); return 1; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, "utf-8"));
    } catch (e) {
      console.error(`✗ manifest 读取/JSON 解析失败：${(e as Error).message}`);
      return 1;
    }
    const r = iacGenerate(parsed as Parameters<typeof iacGenerate>[0]);
    if (!r.ok) {
      for (const err of r.errors) console.error(`✗ ${err}`);
      return 1;
    }
    console.log(r.tf.trimEnd());
    console.log(`\n  ⚙ 生成摘要：provider ${r.provider} · 资源 ${r.resources} · 变量 ${r.variables.length}（${r.variables.join(", ")}）· 往返自解析 ✓（${r.roundTrip.blocks} 块）`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    for (const n of r.notes) console.log(`  💡 ${n}`);
    return 0;
  }

  if (verb === "probe") {
    const p = probeIac();
    console.log(`🧱 IaC 工具链五面探测（${p.tookMs}ms）：`);
    console.log(`  terraform ${p.terraform.available ? `✓ 在场（v${p.terraform.version ?? "?"}）` : "✗ 缺席"}`);
    if (p.terraform.reason) console.log(`      ${p.terraform.reason}`);
    console.log(`  tofu       ${p.tofu.available ? `✓ 在场（v${p.tofu.version ?? "?"}）` : "✗ 缺席"}`);
    if (p.tofu.reason) console.log(`      ${p.tofu.reason}`);
    console.log(`  tflint    ${p.tflint.available ? `✓ 在场（v${p.tflint.version ?? "?"}）` : "✗ 缺席"}`);
    if (p.tflint.reason) console.log(`      ${p.tflint.reason}`);
    console.log(`  车道      ${p.lane === "cli" ? "cli（外部 validate 可用）+ builtin（恒在）" : "builtin（内置静态解析主车道 —— 恒在，零外部依赖）"}`);
    console.log(`  建议      ${p.suggestion}`);
    return 0;
  }

  if (verb === "validate") {
    const dir = positional[1] ?? ".";
    const r = iacValidate(ws, dir);
    if (!r.ok && r.kind === "tool-absent") {
      console.log(`ℹ 外部车道缺席（lane ${r.lane}）—— ${r.reason}`);
      console.log("  内置静态车道替代：org iac parse/plan/graph <file>（语法级校验恒在）");
      return 1; // 缺席是诚实降级，非命令失败面 —— 退出码 1 提示车道缺席
    }
    if (!r.ok && r.kind !== "invalid") {
      console.error(`✗ [${r.kind}] ${r.reason}`);
      console.error(`  argv（数组参数 · 零 shell 面）：${r.argv.join(" ")}`);
      return 1;
    }
    if (!r.ok) {
      console.error(`✗ 配置校验未通过（${r.diagnostics.length} 条诊断 · ${r.bin} validate · 车道 ${r.lane}）：`);
      for (const d of r.diagnostics.slice(0, 20)) {
        console.error(`  [${(d.severity ?? "error").toUpperCase()}] ${d.file ?? ""}${d.line ? ":" + d.line : ""} ${d.summary ?? ""}`);
        if (d.detail) console.error(`      ${d.detail.split("\n")[0]}`);
      }
      return 1;
    }
    console.log(`✓ ${r.bin} validate 通过（车道 ${r.lane} · ${r.tookMs}ms · 目录 ${dir}）`);
    return 0;
  }

  if (verb === "self-test" || verb === "selftest" || verb === "self") {
    const r = iacSelfTest();
    console.log("🧪 IaC 深度层自检（解析器/依赖图/计划/生成器往返 + probe 结构）：");
    for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    console.log(`\n  ${r.passed}/${r.total} 通过`);
    return r.ok ? 0 : 1;
  }

  console.error(`未知子命令：${verb}`);
  console.error("用法：org iac parse <main.tf> · plan <main.tf> · graph <main.tf> · generate <manifest.json> · probe · validate [dir] · self-test");
  console.error("  IaC 深度实现（#44）：HCL 子集解析 → 依赖图/拓扑序 → 人读 Plan → manifest 逆向生成 .tf（与 org iacscan 静态扫描互补）");
  console.error("  内置静态车道恒在；terraform/tofu 在场时 validate 外部车道可用（只读 —— init/plan/apply 不在任何车道）");
  return 2;
}

// ---- org mobile：移动端调试统一入口（v0.5.18 · #117） ----------------------------

/** org mobile —— probe/devices/logcat/forward/apk/plan/self-test 七面。 */
async function cmdMobile(a: Args): Promise<number> {
  const positional = a.rest.filter((r) => !r.startsWith("--"));
  const verb = positional[0] ?? "probe";
  const ws = defaultWorkspace(a);

  // ---- 探测面（Android/iOS/跨端三面 + SDK 定位）----
  if (verb === "probe") {
    const p = probeMobile();
    const face = (icon: string, label: string, f: { available: boolean; version: string | null; reason?: string }) =>
      `${icon} ${label.padEnd(15)} ${f.available ? `✓ 在场（${(f.version ?? "?").slice(0, 42)}）` : "✗ 缺席"}`;
    console.log(`📱 移动端调试工具链探测（${p.tookMs}ms · Android/iOS/跨端三面）：`);
    console.log(`  ${face("🤖", "adb", p.adb)}${p.adb.reason ? `\n      ${p.adb.reason}` : ""}`);
    console.log(`  ${face("📦", "aapt", p.aapt)}${p.aapt.reason ? `\n      ${p.aapt.reason}` : ""}`);
    console.log(`  ${face("📦", "aapt2", p.aapt2)}`);
    console.log(`  ${face("🖼", "scrcpy", p.scrcpy)}${p.scrcpy.reason ? `\n      ${p.scrcpy.reason}` : ""}`);
    console.log(`  ${face("🍏", "ideviceinstaller", p.ideviceinstaller)}${p.ideviceinstaller.reason ? `\n      ${p.ideviceinstaller.reason}` : ""}`);
    console.log(`  ${face("🍏", "idevice_id", p.ideviceId)}`);
    console.log(`  ${face("🦋", "flutter", p.flutter)}${p.flutter.reason ? `\n      ${p.flutter.reason}` : ""}`);
    console.log(`  Android SDK 根：${p.androidHome ?? "未定位（ANDROID_HOME/常见位置均缺席 —— adb 在 PATH 时无需定位）"}`);
    const s = p.summary;
    console.log(`\n  面就绪：Android ${s.androidFace ? "✓" : "✗"} · APK ${s.apkFace ? "✓" : "✗"} · iOS ${s.iosFace ? "✓" : "✗"} · 跨端 ${s.crossFace ? "✓" : "✗"}（${s.facesUp}/5 面在场）`);
    if (s.facesUp === 0) {
      console.log(`\n  工具缺席环境 —— 保底车道即主车道：`);
      console.log(`    org mobile plan <android|ios|both> <crash|白屏|network|…>   步骤化排查计划（纯函数，永远可用）`);
      console.log(`    org mobile apk <app.apk>                                    APK 魔数车道（aapt 缺席也交付）`);
    }
    return 0; // 探测本身成功（全景面缺席是结果不是失败 —— org cloud probe 同哲学）
  }

  // ---- 设备清单面（adb devices -l 解析 + iOS 面 + 三层降级）----
  if (verb === "devices") {
    const r = mobileDevices();
    const kindText: Record<string, string> = {
      "tool-absent": "adb CLI 缺席（安装指引见上）",
      timeout: "adb devices 执行超时",
      failed: "adb devices 执行失败",
    };
    if (!r.ok) {
      console.error(`✗ org mobile devices（${kindText[r.kind ?? "failed"] ?? r.kind}）：${r.reason ?? ""}`);
      return 1;
    }
    console.log(`📱 Android 设备（${r.devices.length} 台 · 就绪 ${r.ready}）：`);
    for (const d of r.devices) {
      console.log(`  ${d.serial.padEnd(22)} ${d.state.padEnd(13)} ${[d.model, d.product, d.device].filter(Boolean).join(" · ") || "（无 -l 描述字段 —— 未授权/离线设备常见）"}${d.transport ? ` · ${d.transport}` : ""}`);
    }
    if (r.devices.length === 0) console.log(`  （无设备连接 —— ${r.reason ?? ""}）`);
    else if (r.ready === 0) console.log(`  ⚠ ${r.reason ?? ""}`);
    console.log(`\n  🍏 iOS 面：${r.ios.note}`);
    if (r.ios.udids.length > 0) for (const u of r.ios.udids) console.log(`     ${u}`);
    console.log(`  argv（数组参数 · 零 shell 面）：${r.argv.join(" ")}`);
    return 0;
  }

  // ---- logcat 面（dump 快照 + 五元组 + tag/级别/包名过滤）----
  if (verb === "logcat") {
    const serial = restFlag(a, "serial");
    const tag = restFlag(a, "tag");
    const level = restFlag(a, "level");
    const pkg = restFlag(a, "package");
    const linesRaw = Number(restFlag(a, "lines"));
    const r = mobileLogcat({
      ...(serial ? { serial } : {}),
      ...(tag ? { tag } : {}),
      ...(level ? { level } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...(Number.isFinite(linesRaw) && linesRaw > 0 ? { lines: linesRaw } : {}),
    });
    if (!r.ok) {
      const kindText: Record<string, string> = {
        "tool-absent": "adb CLI 缺席", "no-device": "无设备连接", unauthorized: "设备未授权",
        "multi-device": "多设备未指定 serial", timeout: "执行超时", failed: "执行失败",
      };
      console.error(`✗ org mobile logcat（${kindText[r.kind ?? "failed"] ?? r.kind}）：${r.reason ?? ""}`);
      return 1;
    }
    console.log(`📱 logcat dump（${r.entries.length} 条五元组 · 未匹配行 ${r.skipped}${r.truncated ? " · 尾部截断" : ""}）：`);
    for (const e of r.entries.slice(-Math.min(r.entries.length, 30))) {
      console.log(`  ${e.time}  ${e.pid.padStart(6)}  ${e.level} ${e.tag}: ${e.message.slice(0, 120)}`);
    }
    if (r.entries.length > 30) console.log(`  …（仅示尾 30 条 / 共 ${r.entries.length} 条）`);
    if (r.entries.length === 0) console.log(`  （空 —— ${r.reason ?? "无匹配日志行"}）`);
    console.log(`\n  argv：${r.argv.join(" ")}（-d 快照车道；行数帽 ${LOGCAT_LINES_MAX} · 级别 ${LOGCAT_LEVELS.join("/")}）`);
    return 0;
  }

  // ---- WebView CDP 转发面（四层降级：adb→设备→socket→页面）----
  if (verb === "forward") {
    const serial = restFlag(a, "serial");
    const local = restFlag(a, "port");
    const remote = restFlag(a, "remote");
    const r = await mobileForward({
      ...(serial ? { serial } : {}),
      ...(local !== undefined ? { local } : {}),
      ...(remote ? { remote } : {}),
    });
    const kindText: Record<string, string> = {
      "tool-absent": "adb CLI 缺席", "no-device": "无设备连接", unauthorized: "设备未授权",
      "multi-device": "多设备未指定 serial", "socket-not-found": "设备上无 devtools socket",
      "socket-unreachable": "forward 已建立但 CDP HTTP 不可达", "page-empty": "CDP 页面清单为空",
      timeout: "执行超时", failed: "执行失败",
    };
    if (!r.ok && r.kind !== "page-empty") {
      console.error(`✗ org mobile forward（${kindText[r.kind ?? "failed"] ?? r.kind}）：${r.reason ?? ""}`);
      return 1;
    }
    console.log(`📱 WebView CDP 转发：${r.serial} · tcp:${r.localPort} → ${r.remote}`);
    console.log(`  socket 发现：${r.sockets.length > 0 ? r.sockets.join(" / ") : "（显式 remote 形态 —— 未做自动发现）"}`);
    if (r.cdp) {
      console.log(`  CDP /json 探测：${r.cdp.reachable ? `✓ 可达（HTTP ${r.cdp.httpStatus} · ${r.cdp.pages.length} 页可调试）` : `✗ 不可达`}`);
      for (const p of r.cdp.pages) console.log(`     📄 ${p.title || "（无标题）"} — ${p.url}`);
    }
    if (r.reason) console.log(`  ${r.ok ? "💡" : "⚠"} ${r.reason}`);
    console.log(`\n  下一步：桌面 Chrome 打开 chrome://inspect（Devices → Port forwarding 9222）即可 inspect 目标 WebView。`);
    return r.ok ? 0 : 1;
  }

  // ---- APK 检查面（aapt 车道 / 魔数车道两层降级；路径过工作区监狱）----
  if (verb === "apk") {
    const file = positional[1];
    if (!file) {
      console.error("用法：org mobile apk <app.apk> [--workspace DIR]（工作区相对路径 · 过监狱）");
      console.error("  aapt/aapt2 dump badging 全量解析（包名/版本/权限）→ 缺席降级 APK 魔数车道（PK\\x03\\x04 + 大小 + 指引）");
      return 2;
    }
    const r = mobileApkInfo(ws, file);
    if (!r.ok) {
      const kindText: Record<string, string> = { jail: "路径越界（须在工作区内）", failed: "读取/解析失败" };
      console.error(`✗ org mobile apk（${kindText[r.kind ?? "failed"] ?? r.kind} · 车道 ${r.lane ?? "无"}）：${r.reason ?? ""}`);
      return 1;
    }
    console.log(`📦 APK 检查（车道 ${r.lane === "aapt" ? "aapt —— badging 全量解析" : "magic —— 魔数降级（aapt 缺席/失败）"} · ${(r.sizeBytes / 1024 / 1024).toFixed(2)} MB）：`);
    console.log(`  文件：${r.file} · 魔数 ${r.magic?.apk ? "✓ APK 形态（PK\\x03\\x04）" : "✗ 异常"}`);
    if (r.badging) {
      const b = r.badging;
      console.log(`  包名：${b.package ?? "?"} · versionName ${b.versionName ?? "?"} · versionCode ${b.versionCode ?? "?"}`);
      console.log(`  minSdk ${b.sdkVersion ?? "?"} · targetSdk ${b.targetSdkVersion ?? "?"} · 标签 ${b.applicationLabel ?? "?"}`);
      console.log(`  权限（${b.permissions.length} 项）：${b.permissions.slice(0, 6).join(" · ")}${b.permissions.length > 6 ? " …" : ""}`);
      if (b.nativeCode.length > 0) console.log(`  native-code：${b.nativeCode.join(" · ")}`);
    }
    if (r.reason) console.log(`  💡 ${r.reason}`);
    return 0;
  }

  // ---- 调试计划面（纯函数保底车道 —— 任何环境永远可用）----
  if (verb === "plan") {
    const platform = positional[1] ?? "android";
    const symptom = positional.slice(2).filter((x) => !x.startsWith("--")).join(" ") || "crash";
    if (!(MOBILE_PLAN_PLATFORMS as readonly string[]).includes(platform)) {
      console.error(`✗ 未知平台 "${platform}"（三式：${MOBILE_PLAN_PLATFORMS.join("/")}）`);
      return 2;
    }
    const p = mobileDebugPlan(platform, symptom);
    console.log(`📱 移动端调试计划（平台 ${p.platform} · 症状 ${p.symptom} · ${p.steps.length} 步）：`);
    for (const s of p.steps) {
      console.log(`\n  ${s.step}. ${s.title}`);
      if (s.cmd) console.log(`     $ ${s.cmd}`);
      console.log(`     预期：${s.expect}`);
      console.log(`     降级：${s.degrade}`);
    }
    console.log(`\n  ${p.note}`);
    return 0;
  }

  // ---- 自检面 ----
  if (verb === "self-test" || verb === "selftest") {
    const t = mobileSelfTest();
    console.log("🧪 移动端调试簇自检（解析器/计划器/魔数/socket 提取/argv 形态 —— 纯内存零副作用）：");
    for (const c of t.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    console.log(`\n  ${t.passed}/${t.total} 通过`);
    return t.ok ? 0 : 1;
  }

  console.error(`未知子命令：${verb}`);
  console.error(`用法：org mobile probe · devices · logcat [--serial S] [--lines N] [--tag T] [--level VDIWEF] [--package P]`);
  console.error(`      org mobile forward [--serial S] [--port N] [--remote sock] · apk <app.apk> · plan <android|ios|both> [症状] · self-test`);
  console.error("  移动端调试（#117）：多重优雅降级（adb→设备→socket→页面四层 / aapt→魔数两层 / 计划纯函数保底）·");
  console.error("  执行面全只读（devices/logcat -d dump/forward/apk 检查 —— install/uninstall 只出现在计划的可粘贴命令里）");
  return 2;
}


// ---- org remote：远程 Agent 簇（v0.5.18 · #133）-----------------------------------

/** RemoteRunResult 统一渲染（remoteExec/remoteSync 车道 —— 成功吐输出、失败吐 kind+reason）。 */
function renderRemoteRun(r: RemoteRunResult, label: string): number {
  const kindText: Record<string, string> = {
    denied: "白名单拒绝（未执行）", "host-not-found": "host 未在档案（不猜默认主机）",
    "tool-absent": "CLI 缺席（降级车道可用）", jail: "路径越界（工作区监狱）",
    timeout: "超时", refused: "拒连/不可达", auth: "鉴权失败", failed: "执行失败（退出码非 0）",
  };
  const argvPreview = r.argv.join(" ").slice(0, 160);
  if (!r.ok) {
    console.error(`✗ ${label}（${kindText[r.kind ?? "?"] ?? r.kind}）：${r.reason ?? ""}`);
    console.error(`  argv（数组参数 · 零 shell 面）：${argvPreview}`);
    if (r.kind === "denied" && (r.reason ?? "").includes("allow_full")) {
      console.error(`  全量命令车道：org remote exec <host> "<cmd>" --allow-full（显式开启 —— 由你对命令内容负责）`);
    }
    return 1;
  }
  console.log(`✓ ${label}（${r.tookMs}ms · argv 数组参数）：${argvPreview}`);
  if (r.stdout.trim().length > 0) console.log(r.stdout.trim().split("\n").slice(0, 60).join("\n"));
  if (r.stderr.trim().length > 0) console.log(`（stderr）${r.stderr.trim().split("\n").slice(0, 10).join("\n")}`);
  return 0;
}

async function cmdRemote(a: Args): Promise<number> {
  const positional = a.rest.filter((r) => !r.startsWith("--"));
  const verb = positional[0] ?? "probe";
  const ws = defaultWorkspace(a);

  // ---- 探测面 ----
  if (verb === "probe") {
    const p = probeRemote();
    console.log(`🛰 远程会话工具链探测：`);
    console.log(`  🔐 ssh        ${p.available ? `✓ 在场（${p.versionRaw ?? "?"} → OpenSSH ${p.openSsh ? `${p.openSsh.major}.${p.openSsh.minor}` : "?"}）` : "✗ 缺席"}`);
    console.log(`  📤 rsync      ${p.rsyncAvailable ? `✓ 在场（${(p.rsyncVersion ?? "").slice(0, 46)}）` : "✗ 缺席"}（同步主车道）`);
    console.log(`  📥 scp        ${p.scpAvailable ? "✓ 在场" : "✗ 缺席"}（rsync 缺席时的降级车道）`);
    console.log(`  🔑 ssh-keygen ${p.sshKeygenAvailable ? "✓ 在场" : "✗ 缺席"}（密钥生成指引可行）`);
    console.log(`  🔁 agent      ${p.agentForwarding ? "✓ SSH_AUTH_SOCK 在场（BatchMode 下 agent 密钥可用）" : "✗ 无 agent 转发环境（SSH_AUTH_SOCK 缺席）"}`);
    if (p.reason) console.log(`  ${p.reason}`);
    console.log(`\n  档案：<ws>/${REMOTE_HOSTS_FILE}（主机档案 —— host 寻址的门控源）· 计划车道：org remote plan [host] [git|rsync|container|all]`);
    return 0; // 探测本身成功（全景面缺席是结果不是失败 —— 与 org cloud probe 全景同哲学；诚实呈现绿 ✓ / 灰 ⬜）
  }

  // ---- 主机档案面 ----
  if (verb === "hosts") {
    const report = loadRemoteHosts(ws);
    console.log(`🛰 ${REMOTE_HOSTS_FILE}：${report.exists ? `${report.hosts.length} 个主机在册` : "未创建（host 寻址一律拒绝 —— 安全缺省）"}`);
    console.log(`  路径：${report.file}`);
    if (report.hosts.length > 0) {
      for (const h of report.hosts) {
        console.log(`    ${h.name.padEnd(12)} ${h.user}@${h.host}:${h.port ?? 22}${h.identity ? ` · key ${h.identity}` : ""}`);
      }
    }
    for (const e of report.errors) console.log(`  ⚠ ${e}`);
    if (positional[1]) {
      const f = findRemoteHost(ws, positional[1]);
      console.log(`  判定 "${positional[1]}" → ${f.entry ? `✓ 放行（档案 ${f.by === "name" ? "名" : "host 字段"}：${f.entry.name}）` : "✗ 拒绝（不在档案）"}`);
    }
    if (!report.exists || report.hosts.length === 0) console.log(`\n  ${REMOTE_HOSTS_GUIDANCE}`);
    return 0;
  }

  // ---- 执行面（会话级 remoteExec —— 白名单默认只读）----
  if (verb === "exec") {
    const host = positional[1];
    const command = positional.slice(2).filter((x) => !x.startsWith("--")).join(" ");
    if (!host || !command) {
      console.error(`用法：org remote exec <host> "<command>" [--allow-full] [--timeout N] [--workspace DIR]`);
      console.error(`  host 须在 <ws>/${REMOTE_HOSTS_FILE} 档案内（不猜默认）；命令白名单默认只读：${REMOTE_READONLY_COMMANDS.join("/")}`);
      console.error("  非白名单命令须 --allow-full 显式开启（RBAC 哲学：读 = 缺省，执行 = 显式）");
      return 2;
    }
    const timeout = Number(restFlag(a, "timeout"));
    return renderRemoteRun(remoteExec(ws, {
      host, command,
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
      ...(restBool(a, "allow-full") ? { allowFull: true } : {}),
    }), `remote exec ${host}`);
  }

  // ---- 同步面（rsync → scp → 指引三层降级）----
  if (verb === "sync") {
    const [host, local, remote] = positional.slice(1);
    const direction = restFlag(a, "direction") === "download" ? "download" : "upload";
    if (!host || !local || !remote) {
      console.error(`用法：org remote sync <host> <local（工作区内）> <remote路径> [--direction upload|download]`);
      console.error(`  rsync -avz（主车道）→ scp -r（rsync 缺席降级）→ 指引（双缺）；local 过工作区监狱`);
      return 2;
    }
    return renderRemoteRun(remoteSync(ws, { host, local, remote, direction }), `remote sync ${host}（${direction}）`);
  }

  // ---- 心跳/延迟面 ----
  if (verb === "ping") {
    const host = positional[1];
    if (!host) { console.error(`用法：org remote ping <host> [--rounds N]（ssh echo 往返计时 min/avg/max；host 须在档案）`); return 2; }
    const rounds = Number(restFlag(a, "rounds"));
    const r = remotePing(ws, { host, ...(Number.isFinite(rounds) && rounds > 0 ? { rounds } : {}) });
    if (!r.ok) {
      const kindText: Record<string, string> = { "host-not-found": "host 未在档案（不猜默认主机）", "tool-absent": "ssh CLI 缺席", refused: "拒连/不可达" };
      console.error(`✗ remote ping ${host}（${kindText[r.kind ?? "?"] ?? r.kind}）：${r.reason ?? ""}`);
      return 1;
    }
    console.log(`🛰 remote ping ${host}：${r.rounds} 轮 echo 往返（失败 ${r.failures} 轮）`);
    console.log(`  延迟 min/avg/max = ${r.stats!.min}/${r.stats!.avg}/${r.stats!.max} ms${r.failures > 0 ? "（部分降级：统计只计成功轮）" : ""}`);
    console.log(`  逐轮：${r.times.map((t) => `${t}ms`).join(" · ")}`);
    return 0;
  }

  // ---- 部署计划面（纯函数保底车道 —— 无真远程机环境的主交付）----
  if (verb === "plan") {
    const host = positional[1] ?? restFlag(a, "host") ?? "";
    const mode = positional[2] ?? restFlag(a, "mode") ?? "all";
    if (!(REMOTE_DEPLOY_MODES as readonly string[]).includes(mode)) {
      console.error(`✗ 未知模式 "${mode}"（四式：${REMOTE_DEPLOY_MODES.join("/")}）`);
      return 2;
    }
    // host 若在档案 → 实参化（user/port 就位）；不在档案也照出计划（占位形态）
    const f = host ? findRemoteHost(ws, host) : null;
    const entry = f?.entry;
    const p = remoteDeployPlan({
      host: entry?.host ?? host, user: entry?.user ?? restFlag(a, "user") ?? "", mode,
    });
    console.log(`🛰 远程 Agent 部署计划（模式 ${p.mode} · 目标 ${p.target}${entry ? `（档案 ${entry.name}）` : "（占位 —— 未在档案实参化）"}）：`);
    for (const ph of p.phases) {
      console.log(`\n  ${ph.title}`);
      for (const [i, s] of ph.steps.entries()) {
        console.log(`    ${i + 1}. ${s.cmd.split("\n").join("\n       ")}`);
        console.log(`       # ${s.note}${s.expect ? `\n       ▸ ${s.expect}` : ""}`);
      }
    }
    console.log(`\n  诚实边界：计划是纯函数（不 spawn 不落盘）；真机执行走 org remote exec/sync/ping（须档案 + 白名单）。`);
    return 0;
  }

  // ---- 自检面 ----
  if (verb === "self-test" || verb === "selftest") {
    const t = remoteSelfTest();
    console.log("🧪 远程 Agent 簇自检（计划器/档案校验/白名单/三类诊断/ping 统计/argv 形态 —— 纯内存）");
    for (const c of t.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    console.log(`\n  ${t.passed}/${t.total} 通过`);
    return t.ok ? 0 : 1;
  }

  console.error(`未知子命令：${verb}`);
  console.error(`用法：org remote probe · hosts [name] · exec <host> "<cmd>" [--allow-full] · sync <host> <local> <remote> [--direction upload|download]`);
  console.error(`      org remote ping <host> [--rounds N] · plan [host] [git|rsync|container|all] · self-test（#133 远程 Agent 统一入口）`);
  return 2;
}

// ---- org mcp：MCP 客户端桥（v0.5.19 · #122 / C12）--------------------------------

/**
 * org mcp servers|tools|call|resources|read|prompts|self-test —— MCP 客户端桥统一入口。
 * 会话粒度 = 每操作一会话（spawn → initialize → 操作 → close）；档案缺席/坏档/
 * server 不在档 → 诚实拒绝 + 指引（exit 1）；探测全景缺席是结果不是失败（exit 0）。
 */
async function cmdMcp(a: Args): Promise<number> {
  const positional = a.rest.filter((r) => !r.startsWith("--"));
  const verb = positional[0] ?? "help";
  const ws = defaultWorkspace(a);

  // ---- 档案 + 运行时探测面（不 spawn 任何 server）----
  if (verb === "servers") {
    const runtimes = probeMcpRuntimes();
    const hit = runtimes.filter((r) => r.available);
    console.log(`🔌 MCP server 档案 + 宿主运行时探测：`);
    const f = loadMcpServers(ws);
    if (f.kind === "absent") {
      console.log(`  档案：未创建（<ws>/${MCP_SERVERS_FILE}）—— 一切会话操作拒绝（不猜默认）`);
      console.log(`  ${MCP_SERVERS_GUIDANCE}`);
    } else if (f.kind === "invalid-json" || f.kind === "not-array") {
      console.log(`  档案：✗ 不可用 —— ${f.reason}`);
      return 1;
    } else {
      console.log(`  档案：${f.entries.length} 个过检条目${f.validations.some((v) => !v.ok) ? `（${f.validations.filter((v) => !v.ok).length} 条未过检被滤）` : ""}`);
      for (const v of f.validations) {
        const e = f.entries.find((x) => x.name === v.name);
        console.log(`  ${v.ok ? (e?.disabled ? "⏸" : "✓") : "✗"} ${v.name.padEnd(20)} ${e ? `${e.command} ${(e.args ?? []).join(" ").slice(0, 40)}${e.disabled ? "（已停用）" : ""}` : v.reason}`);
      }
    }
    console.log(`\n  宿主运行时（server spawn 前提）：`);
    for (const r of runtimes) console.log(`  ${r.available ? "✓" : "✗"} ${r.name.padEnd(10)} ${r.path ?? "缺席"}`);
    if (hit.length === 0) console.log(`\n  （全部缺席 —— 装好任一宿主（bun/node/python3）即可登记 server）`);
    return 0;
  }

  // ---- 工具清单（initialize 握手 + tools/list + 分页跟进）----
  if (verb === "tools") {
    const name = positional[1];
    const reports = await mcpListTools(ws, name);
    let anyOk = false;
    for (const r of reports) {
      if (r.ok) {
        anyOk = true;
        console.log(`✓ ${r.server} —— ${r.tools.length} 个工具（${r.serverInfo?.serverName} ${r.serverInfo?.serverVersion} · 协议 ${r.serverInfo?.protocolVersion}）`);
        for (const t of r.tools) {
          console.log(`  🔧 ${t.name.padEnd(24)} ${(t.description ?? "").slice(0, 52)}`);
        }
      } else {
        console.log(`✗ ${r.server} —— ${r.reason}`);
      }
    }
    if (!anyOk) {
      if (reports.every((r) => r.kind === "no-config" || r.kind === "invalid-config")) console.log(`  ${MCP_SERVERS_GUIDANCE}`);
      return 1;
    }
    return 0;
  }

  // ---- 工具调用（执行车道 —— 由你对 server 与工具内容负责）----
  if (verb === "call") {
    const server = positional[1];
    const tool = positional[2];
    const argsRaw = positional[3] ?? "{}";
    if (!server || !tool) {
      console.error(`用法：org mcp call <server> <tool> ['{"参数":"值"}'] [--workspace DIR]`);
      console.error(`  例：org mcp call fx echo '{"message":"你好"}' —— 执行车道，与工具环 mcp_call_tool 同源`);
      return 2;
    }
    let args: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      else if (argsRaw.trim() !== "{}" && argsRaw.trim() !== "") {
        console.error(`✗ arguments 须为 JSON 对象（收到：${argsRaw.slice(0, 40)}）`);
        return 2;
      } else {
        args = {};
      }
    } catch {
      console.error(`✗ arguments 不是合法 JSON：${argsRaw.slice(0, 40)}`);
      return 2;
    }
    const r = await mcpCallTool(ws, server, tool, args);
    if (!r.ok) {
      console.error(`✗ ${r.reason}`);
      if (r.kind === "no-config") console.error(`  ${MCP_SERVERS_GUIDANCE}`);
      return 1;
    }
    const info = r.serverInfo ? `（${r.serverInfo.serverName} ${r.serverInfo.serverVersion}）` : "";
    console.log(`🔧 ${server}.${tool} ${info}${r.isError ? " —— 工具层失败（isError）" : ""}`);
    if (r.content) {
      console.log(`  内容：${r.content.textBlocks} 文本块 · ${r.content.imageBlocks} 图片块 · ${r.content.resourceBlocks} 资源块${r.content.truncated ? "（已截断）" : ""}`);
      if (r.content.text) console.log(r.content.text.split("\n").map((l) => `  | ${l}`).join("\n"));
    }
    if (r.structuredContent !== undefined) console.log(`  structuredContent：${JSON.stringify(r.structuredContent).slice(0, 200)}`);
    return r.isError === true ? 1 : 0; // 协议层成功但工具层失败 → exit 1（诚实呈现双层语义）
  }

  // ---- 资源清单 / 读取 ----
  if (verb === "resources") {
    const name = positional[1];
    const reports = await mcpListResources(ws, name);
    let anyOk = false;
    for (const r of reports) {
      if (r.ok) {
        anyOk = true;
        console.log(`✓ ${r.server} —— ${r.resources.length} 个资源`);
        for (const res of r.resources) console.log(`  📄 ${res.uri.padEnd(36)} ${res.name ?? ""}${res.mimeType ? `（${res.mimeType}）` : ""}`);
      } else {
        console.log(`✗ ${r.server} —— ${r.reason}`);
      }
    }
    return anyOk ? 0 : 1;
  }
  if (verb === "read") {
    const server = positional[1];
    const uri = positional[2];
    if (!server || !uri) {
      console.error(`用法：org mcp read <server> <uri>（如 org mcp read fx org://readme）`);
      return 2;
    }
    const r = await mcpReadResource(ws, server, uri);
    if (!r.ok) {
      console.error(`✗ ${r.reason}`);
      return 1;
    }
    for (const c of r.contents) {
      console.log(`📄 ${c.uri}${c.mimeType ? `（${c.mimeType}）` : ""}`);
      if (c.text) console.log(c.text.split("\n").map((l) => `  | ${l}`).join("\n"));
    }
    return 0;
  }

  // ---- 提示词清单 ----
  if (verb === "prompts") {
    const name = positional[1];
    const reports = await mcpListPrompts(ws, name);
    let anyOk = false;
    for (const r of reports) {
      if (r.ok) {
        anyOk = true;
        console.log(`✓ ${r.server} —— ${r.prompts.length} 个提示词`);
        for (const p of r.prompts) console.log(`  💬 ${p.name.padEnd(20)} ${(p.description ?? "").slice(0, 52)}`);
      } else {
        console.log(`✗ ${r.server} —— ${r.reason}`);
      }
    }
    return anyOk ? 0 : 1;
  }

  // ---- 协议层自检（纯内存，无 server 也能锁形状）----
  if (verb === "self-test" || verb === "selftest") {
    const t = mcpSelfTest();
    console.log("🧪 MCP 协议层自检（换行分帧 · 构造器 · 档案校验 · env 引用解析 · 内容归一 —— 纯内存）");
    for (const c of t.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    console.log(`\n  ${t.passed}/${t.total} 通过`);
    return t.ok ? 0 : 1;
  }

  console.error(`未知子命令：${verb}`);
  console.error(`用法：org mcp servers · tools [name] · call <server> <tool> [json] · resources [name] · read <server> <uri>`);
  console.error(`      org mcp prompts [name] · self-test（#122/C12 MCP 客户端桥统一入口）`);
  return 2;
}

// ---- org memory：专家长期记忆（v0.5.3） ----------------------------------------

async function cmdMemory(a: Args): Promise<number> {
  const [verb, expert, ...rest] = a.rest;
  const ws = defaultWorkspace(a);

  if (verb === undefined || verb === "list") {
    if (expert) {
      const entries = listMemories(ws, expert);
      console.log(`记忆 · ${expert}（${entries.length} 条 · runtime/memories/${expert}.md）\n`);
      if (entries.length === 0) {
        console.log("（空 —— org memory add " + expert + ' "偏好或约定"');
      }
      for (const e of entries) console.log(`  ${String(e.line).padStart(3)}  ${e.text}`);
      console.log("\n  注入：direct 车道自动织入尾部 40 行（org ask / org chat 即生效）");
      return 0;
    }
    const all = allMemories(ws);
    if (all.length === 0) { console.log("（无任何专家记忆 · org memory add <expert> \"...\"）"); return 0; }
    for (const g of all) {
      console.log(`◆ ${g.expert}（${g.entries.length} 条）`);
      for (const e of g.entries.slice(-5)) console.log(`    ${String(e.line).padStart(3)}  ${e.text}`);
    }
    return 0;
  }
  if (verb === "add") {
    const text = rest.join(" ");
    if (!expert || !text) { console.error('用法：org memory add <expert> "记忆内容（≤500 字符）"'); return 2; }
    try {
      const n = addMemory(a.workspace, expert, text);
      console.log(`✓ ${expert} 已记 ${n} 条（direct 车道自动注入提示词）`);
      return 0;
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      return 2;
    }
  }
  if (verb === "rm") {
    const line = Number(rest[0] ?? "0");
    if (!expert || !line) { console.error("用法：org memory rm <expert> <行号>（org memory list 查看行号）"); return 2; }
    try {
      const n = removeMemory(ws, expert, line);
      console.log(`✓ 已删除（剩 ${n} 条）`);
      return 0;
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      return 2;
    }
  }
  console.error(`✗ 未知子命令：${verb}（可用：list/add/rm）`);
  return 2;
}

// ---- org providers：全部服务商健康面板（v0.5.1） -----------------------------
async function cmdProviders(a: Args): Promise<number> {
  const cfg = loadConfig();
  const [verb] = a.rest;
  if (verb === "ledger") {
    const ws = a.workspace;
    const stats = readLedger(ws);
    console.log(`llm-ledger —— ${ws}/runtime/llm-ledger.jsonl\n`);
    console.log(`  总调用 ${stats.total}（ok ${stats.ok} · 失败 ${stats.failed}） · 今日 ${stats.today}（ok ${stats.today_ok}）`);
    const lanes = Object.entries(stats.byLane);
    if (lanes.length > 0) {
      console.log("\n  按车道：");
      for (const [name, s] of lanes) console.log(`    ${name.padEnd(14)} ok ${s.ok} · fail ${s.failed}`);
    }
    if (stats.recent.length > 0) {
      console.log("\n  最近（倒序 5 条）：");
      for (const e of stats.recent.slice(-5).reverse()) {
        console.log(`    ${e.ts.slice(11, 19)} ${String(e.lane).padEnd(12)} ${e.status.padEnd(5)} ${e.ms}ms ${e.key_id}`);
      }
    }
    return 0;
  }
  const rows = providerRows(cfg);
  const env = discoverEnvLanes();
  console.log(`ORG providers —— ${PROVIDER_NAMES.length} 家注册 · 命名车道 ${Object.keys(cfg.lanes).length} 条 · 环境变量发现 ${env.length} 家\n`);
  console.log(`  缺省车道：${cfg.default_lane || "（未设 · 按平面配置/环境变量/剧本回落）"}\n`);
  const STATUS_MARK: Record<ProviderRow["status"], string> = {
    lane: "★ 车道已配置", env: "◆ 环境变量发现", preset: "  预设可用", flat: "  平面配置",
  };
  for (const r of rows) {
    if (r.status === "preset" && !r.local && !env.find((d) => d.provider === r.name) && !cfg.lanes[r.name]) continue; // 未配置的云端预设折叠（列表太长）
    const mark = r.default ? "→" : " ";
    console.log(`  ${mark} ${r.name.padEnd(12)} ${STATUS_MARK[r.status]}${r.keys > 0 ? ` · key×${r.keys}` : ""}${r.fallbacks.length > 0 ? ` · 降级→${r.fallbacks.join(",")}` : ""}`);
    console.log(`       ${r.model || "（待填模型名）"} · ${r.gateway}`);
  }
  // v0.5.5：预算水位 + key 池健康（三端渲染之 CLI 端）
  const wm = budgetWatermark(a.workspace);
  if (wm.budget > 0) {
    const bar = "█".repeat(Math.min(10, Math.round((wm.used / wm.budget) * 10))) + "░".repeat(Math.max(0, 10 - Math.min(10, Math.round((wm.used / wm.budget) * 10))));
    console.log(`\n  预算水位 ${bar} ${wm.used}/${wm.budget}（剩 ${wm.remaining}）${wm.exceeded ? " · 已超额（路由器 429）" : ""}`);
  }
  const pools = poolView(a.workspace);
  if (pools.length > 0) {
    console.log("\n  key 池状态（跨进程共享 · 冷却中的 key 排序沉底）：");
    for (const pv of pools) {
      console.log(`    ${pv.lane.padEnd(12)}`);
      for (const k of pv.keys) {
        console.log(`      ${k.key_id.padEnd(12)} ${k.cooling ? `冷却中（${Math.max(0, Math.round((Date.parse(k.until!) - Date.now()) / 1000))}s）` : "可用"} · 连败 ${k.fails} · 上次 ${k.last_status}`);
      }
    }
  }
  console.log(`\n  命令：org config preset <name> · org config test [lane] · org providers test（测全部已配置车道） · org providers ledger（调用台账）`);
  return 0;
}

/**
 * 命令行入口（可编程）：等价于 `org <argv...>`，返回退出码。
 * 与 cli/chat.ts 的 chatMain 同约定 —— 逻辑函数化，执行留在 import.meta.main 之后。
 */
export async function orgMain(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs([cmd ?? "help", ...rest]);
  // 启动即注入用户配置（环境变量优先，配置文件填空）—— 全部子命令/子进程继承
  if (a.cmd !== "config") applyConfigToEnv();
  // 缺省车道（org config set default_lane deepseek）：未显式 --model 时接管缺省
  if (!a.modelExplicit && (process.env.ORG_DEFAULT_MODEL ?? "").trim().length > 0) {
    a.model = process.env.ORG_DEFAULT_MODEL!.trim();
  }
  switch (a.cmd) {
    case "run": return cmdRun(a);
    case "demo": return cmdDemo(a);
    case "ask": return cmdAsk(a);
    case "handoff": return cmdHandoff(a);
    case "keep": return cmdKeep(a);
    case "drop": return cmdDrop(a);
    case "import": return cmdImport(a);
    case "review": return cmdReview(a);
    case "revert": return cmdRevert(a);
    case "approvals": return cmdApprovals(a);
    case "cost": return cmdCost(a);
    case "session": return cmdSession(a);
    case "status": return cmdStatus(a);
    case "score": return cmdScore(a);
    case "replay": return cmdReplay(a);
    case "check": return cmdCheck();
    case "tui": return cmdTui(a);
    case "web": return cmdWeb(a);
    case "chat": return cmdChat(a);
    case "sessions": return cmdSessions(a);
    case "config": return cmdConfig(a);
    case "providers": return cmdProviders(a);
    case "task": case "tasks": return cmdTask(a);
    case "taskd": return cmdTaskd(a);
    case "schedule": case "schedules": case "cron": return cmdSchedule(a);
    case "notify": case "notifications": return cmdNotify(a);
    case "memory": case "memories": return cmdMemory(a);
    case "search": return cmdSearch(a);
    case "speak": return cmdSpeak(a);
    case "voice": return cmdVoice(a);
    case "vision": return cmdVision(a);
    case "spawn": return cmdSpawn(a);
    // v0.5.15 桌面 Agent 补全批次（capabilities #43/#73/#49/#60/#20/#52/#141/#150/#148/#89/#85/#24）
    case "db": return cmdDb(a);
    case "diff": return cmdDiff(a);
    case "symbols": return cmdSymbols(a);
    case "scan": return cmdScan(a);
    case "audit": case "audit-export": return cmdAudit(a);
    case "sbom": return cmdSbom(a);
    case "owners": case "codeowners": return cmdOwners(a);
    case "read": return cmdRead(a);
    // v0.5.16 治理与扩展批次（capabilities #113/#80/#149/#147/#132/#134/#116/#30/#32/#56）
    case "dbdiag": return cmdDbdiag(a);
    case "merge": return cmdMerge(a);
    case "rebase": return cmdRebase(a);
    case "mergestate": return cmdMergestate(a);
    case "rbac": return cmdRbac(a);
    case "iacscan": return cmdIacscan(a);
    // v0.5.18 IaC 深度簇（capabilities #44 —— 与 #147 iacscan 扫描面互补的解析/规划/生成面）
    case "iac": return cmdIac(a);
    case "plugin": case "plugins": return cmdPlugin(a);
    case "openapi": return cmdOpenapi(a);
    case "browser": return cmdBrowser(a);
    case "complete": return cmdComplete(a);
    case "rename": return cmdRename(a);
    // v0.5.17 LSP/DAP 深度簇（capabilities #26/#108）
    case "lsp": return cmdLsp(a);
    case "debug": case "breakpoints": return cmdDebug(a);
    // v0.5.17 协作簇（capabilities #87 团队共享会话/评论）
    case "collab": return cmdCollab(a);
    // v0.5.17 云生态簇（capabilities #67/#68/#72/#74）
    case "cloud": return cmdCloud(a);
    // v0.5.18 移动端调试簇（capabilities #117）
    case "mobile": return cmdMobile(a);
    // v0.5.18 远程 Agent 簇（capabilities #133 —— 会话/部署/计划层）
    case "remote": return cmdRemote(a);
    // v0.5.19 MCP 客户端桥（capabilities #122 / C12 —— 协议翻译半面）
    case "mcp": return cmdMcp(a);
    default:
      console.log(`ORG — Organization Harness v${VERSION}（基于 HSL · BNF v1.5.0）

用法：
  org run --task "..." [--workspace DIR] [--model scripted|deepseek] [--fixture FILE]
       [--approval] [--approve-capability]
      团队模式派单：分解 → 路由 → 派单 → 审查 → 汇总 → 资产沉淀
  org demo [--workspace DIR]
      全叙事演示：A 现场铸专家 / K 用户选取保留 / B 复用+补丁+金丝雀
      / C 蓝绿验证 / D 多轮直连 / E 暖移交
  org chat [expert] [--session id] [--model m] [--continue]
      交互式聊天 REPL（codex/opencode 级）：流式输出 · 思考指示器 ·
      斜杠命令（/model /expert /sessions /compact …）· ↑↓ 历史 ·
      Ctrl+C 取消当前轮 · ！cmd shell 逃逸；直连池全治理零旁路
  org sessions [expert]
      会话账本清单（跨专家：轮次 · tokens · ctx 窗口 · 最近问题）
  org ask <expert> "<question>" [--session id] [--turns "q1|q2"]
      直连指定专家（事件上总线 · 花销记账 · 会话账本 · 纪要回写）
  org handoff <expert> --task "<request>"
      转接模式（主控移交摘要 → 专家代答 → 记账 + 纪要回写）
  org keep <expert> [expert2 ...] [--workspace DIR]
      工具库治理：选取保留 harness（工厂候选 → 转正，git 留痕）
  org drop <expert> [expert2 ...] [--workspace DIR]
      工具库治理：取消保留（B 路径不再自动复用；显式寻址仍可用）
  org cost [--run <dir>] [--workspace DIR]
      用量/成本时间线（逐次模型调用：轨道 · 字符 · 耗时 · tokens）
  org approvals [allow|always|deny <id>] [--workspace DIR]
      交互式审批队列：列出待批准项 / 放行 / 长期放行 / 拒绝（另一个终端也能放行）
  org revert <expert> [--to x.y.z] [--workspace DIR]
      反悔通道：把归档源还原为在岗源（当前源先归档，回退可逆）+ git 留痕
  org session fork <expert> <from> <to> | rename | rm
      会话派生（原会话不变，上下文从派生点续跑）/ 改名 / 删除
  org import <file.hsl> [--name N] [--description "…"] [--capability a,b]
      工具库治理：导入你自己的 harness（check 闸门 → 入库 → 即刻可复用；
      描述缺省取 /// 文档注释 · 能力缺省扫描 #[capability] 注解）
  org review [--run <dir>] [--workspace DIR] [--keep a,b | --all | --none | --dry-run]
      工具库治理：复核本次运行产出的 harness，交互选取哪些沉淀进工具库。
      范围由运行产物界定（本次铸出 / 补丁合入 / 复用命中），缺省取最新 run；
      非交互环境请显式给 --keep/--all/--none（stdin 非 TTY 时不猜）
  org status [--workspace DIR]
      库 / 池 / memo / 基准题 / 基线 / 复发计数 / 会话账本（含上下文窗口占用）
      / git 注册表历史（★ = 用户保留 · ○ = 工厂候选 · import = 用户导入）
  org score [--axis structured_output]
      模型评分卡（证据归因聚合）
  org replay --run <run-dir>
      确定性重放（journal 时间线重演）
  org check
      dhv check 全部 HSL 源码（hsl/ 源码 + dist/ 产物中的铸出专家）
  org tui [--workspace DIR] [":demo"|":replay out-…"]
      组织驾驶舱（OpenCode 级终端前端）：三区布局 · 事件卡片流 · 四态裁决徽标
  org web [--port N] [--host H] [--workspace DIR]
      Web GUI 原型（Bun.serve 零依赖，默认 4600，--host/ORG_WEB_HOST 默认只听
      127.0.0.1，容器/远程场景可 0.0.0.0）：专家卡 + 会话侧栏 + 对话
      视图（观测元数据 tokens/耗时/ctx 窗口计量；scripted 占位剧本秒回）
  org config [list|get|set|unset|preset|presets|lane/use/keys/auto|path|test]
      用户模型/API 配置（~/.org/config.json，跨版本持久）：21 家服务商
      预设（deepseek/openai/anthropic/gemini/openrouter/groq/mistral/xai/
      zhipu/moonshot/dashscope/…）· 命名车道 + key 池（429 自动轮换）+
      降级链 + 日预算 · 环境变量自动发现（OPENAI_API_KEY 等即刻可用）·
      org config test 真实连通性验证 · default_lane 免每次 --model
  org task [list|submit|ask|show|cancel|pause|resume|retry|run-next|logs]
      长程任务队列：后台提交（run 团队派单 / ask 直连专家）· 优先级
      P0-P10 · 暂停/恢复（运行中 SIGSTOP/SIGCONT）· 取消/重试 · 独立
      产物目录 out-task-<id>（与前台操作并行不冲突）
  org taskd [--workspace DIR]
      守护执行器：领取队列任务并发执行（并发 ORG_TASK_CONCURRENCY，缺省
      1）· runner lock 跨进程互斥 · Ctrl+C 退出保留排队（org web 内置
      同一执行器，二选一）
  org notify [list|read|clear|test]
      通知中心：任务完成/失败/取消自动通知 · 桌面通知三级降级
      （notify-send → osascript → powershell → 控制台）· org config set
      desktop_notify off 关闭
  org schedule [list|add|rm|on|off|test]
      定时任务触发器：五段 cron（*/30 9-17 * * 1-5）或 @every 30m ·
      到期自动入任务队列（org taskd / org web 执行器挂载）·
      misfire 策略（skip 补跑跳过 / run 补跑一次）· 触发审计落 journal
  org memory [list|add|rm] [<expert>]
      专家长期记忆：用户偏好/项目约定沉淀（runtime/memories/<expert>.md）
      —— direct 车道自动注入提示词（跨会话生效）· @文件引用（org ask
      "…@src/main.ts"）与 AGENTS.md 工作区规则同批生效
  org search <查询词> [--k N]
      语义检索（BM25 · 中英混合分词）：raw/ registry/ work/ factory/
      语料的相关性排序 + 命中摘要 —— RAG 注入用 @?查询词（org ask
      "…@?审计制度…" 检索命中自动织入上下文）
  org speak "文本" [--voice v] [--speed s] [--out file.wav]
      文本合成语音（TTS · 7 声音 · 语速 0.5-2.0 · 超长分段拼接）落盘 WAV
  org vision [图片...] [--prompt "问题"]
      VLM 图片理解（多图 ≤4 · png/jpeg/gif/webp/bmp · 魔数唤探；无参显示状态）
  org spawn [prune --failed | --all [--dry-run]]
      派生池观测与清理（登记 + 目录 + 孤儿；dry-run 预览）
  org voice
      语音服务状态探测 + 声音清单（🎤 转写 / 🔊 朗读需要 SDK 凭据）
  org db <schema|tables|query|migrate|history> --file x.db [--sql "SELECT…"]
      SQLite 数据库操作（v0.5.15 · capabilities #43/#73）：schema 表结构/
      索引/视图 · query 只读门（单条 SELECT/WITH，行帽 200 缺省）·
      migrate 迁移（版本化 _org_migrations 账本 + 伴车 .migrations.json +
      --dry-run 事务回滚预演）· history 迁移历史
  org diff <旧文件> <新文件> [--context N]
      unified diff 预览（v0.5.15 · #49/#60）：公共头尾剥离 + LCS ·
      GNU diff -u 对拍一致 · CRLF 归一 · 大文件快速路径
  org symbols <名字> [--refs] [--substring]
      符号定义/引用跳转（v0.5.15 · #20）：HSL/TS/PY 轻量索引（fn/
      struct/enum/graph/class/def…）· --refs 引用清单（call/mention）
  org scan [--dirs a,b] 
      密钥/敏感信息扫描（v0.5.15 · #141）：18 类模式（OpenAI/Anthropic/
      GitHub/AWS/私钥/JWT/.env 赋值…）· 预览行全脱敏 · 工具环 fs_write
      同款拦截
  org audit [--run out-a] [--out FILE.zip]
      审计导出（v0.5.15 · #150）：events/journal/llm-stream/审批台账/
      key 池指纹 + markdown 摘要 → 零依赖 zip（python zipfile 可验）
  org sbom [--format json|tv]
      SPDX-2.3 SBOM（v0.5.15 · #148）：org + 运行时依赖 + vendored
      dhv-ts 的组件清单（spdx-tools 校验通过）
  org owners [文件...] [--review 文件1,文件2]
      CODEOWNERS 读取 + 评审人推荐（v0.5.15 · #89/#85）：.org/CODEOWNERS
      优先 · 后规则覆盖 · 无文件时目录启发式降级
  org read <file.pdf> [--max-pages N]
      PDF 文本提取三层降级链（v0.5.15 · #24）：pdftotext → uv+pypdf
      （零全局污染）→ 诚实失败附安装指引
  org dbdiag <x.db|:memory:> "SELECT …" [--setup SQL]
      数据库查询诊断（v0.5.16 · #113）：EXPLAIN QUERY PLAN + 计划解析
      （索引命中/全表扫描/涉及表）+ 建议；:memory: 瞬态可 --setup 播种
  org merge [--no-ff] [--message M] <source> [--repo DIR]
  org rebase <onto> [--repo DIR] / org mergestate
      merge/rebase 安全操作（v0.5.16 · #80）：冲突绝不自动解决 —— 冲突即
      自动 abort 回滚 + 冲突清单；mergestate 只读探测（分支/上游/分叉/脏树）
  org rbac [list|check <角色> <动作>]
      RBAC 角色权限（v0.5.16 · #149）：.org/rbac.json 策略（缺失 = 单机
      owner 兜底）；check 输出判定（deny 优先 → allow → 默认拒）；
      工具环启用：ORG_RBAC_ROLE=<角色>（未设 = 门控完全不启用）
  org iacscan [dirs…]
      容器/IaC 静态扫描（v0.5.16 · #147）：16 条规则三族（Dockerfile/
      compose/terraform：root 用户/特权容器/0.0.0.0 ingress/硬编码密钥…）
  org plugin [list|install|remove|validate]
      插件市场（v0.5.16 · #132）：事务性安装（staging → 校验 → 原子
      rename，绝不留半成品）· manifest 契约（name/version/entry/
      permissions）· permissions 与 RBAC 联动（执行面是路线图，本模块只装不执行）
  org openapi <spec.json>
      OpenAPI/Swagger 解析（v0.5.16 · #134）：3.x/2.0 双识别 + 操作清单
      （method/path/参数/security）+ suggestToolName 工具命名建议
  org browser [status|snapshot <url>|screenshot <url>]
      浏览器 DOM 快照/截图（v0.5.16 · #116/#30）：多引擎降级链
      agent-browser → chromium → chrome；快照出标题/正文/链接/图片清单；
      console/网络面板是路线图（诚实边界）
  org complete <file> <line> <col>
      代码补全（v0.5.16 · #32）：三级候选（同文件符号 > 项目符号 > 语言
      关键字 · HSL/TS/PY）；空候选附原因（成员补全/类型推断是 LSP 路线图）
  org rename <旧名> <新名> [--apply]
      项目级重命名（v0.5.16 · #56）：缺省 dryRun 预览（unified diff ≤5
      文件）· --apply 真写（写前读 → 行级词边界替换 → 复读校验，失败即停）
  org lsp [definition|references|hover] <名> | servers | protocol
      LSP/DAP 协议集成（v0.5.17 · #26）：JSON-RPC 2.0 分帧（LSP 与 DAP
      共用 · 粘包/半包/CJK 字节精确）+ 内置符号索引车道（无外部 server
      时的主车道）+ spawn 车道（initialize→initialized→shutdown→exit）；
      servers 探测外部语言服务器（缺席诚实降级）· protocol 协议层自检
  org debug [suggest|plan] <文件> | dap
      断点/调试建议（v0.5.17 · #108）：入口/分支/循环/return 前断点建议
      （符号级 > 启发式级，每条带 reason）+ 调试计划（步骤 + DAP 协议
      就绪消息序列）；真 debug adapter attach 是路线图（诚实边界）
  org collab [whoami|user|threads|feed|post|comment|users|summary|bridge]
      团队协作（v0.5.17 · #87）：append-only JSONL 团队线程 + 回复树 +
      @mention 自动抽取 + 会话账本桥（单用户账本 → 团队可见，只镜像不
      改写，幂等）· 身份 runtime/collab/collab-user（ORG_COLLAB_USER 覆盖）
      · 诚实边界：本地文件协议，多进程强并发不在面内
  org providers [ledger]
      服务商健康面板：全部注册预设 + 命名车道 + 环境变量发现状态 +
      调用台账（key 轮换归因 · 失败统计）
  org cloud probe [docker|ssh|k8s|tf|clis] · docker <args…> · build <ctx>
      云生态统一入口（v0.5.17 · #67/#68/#72/#74）：全景探测 → 白名单执行
      →模板/计划降级三车道。docker/kubectl 子命令白名单（破坏性命令一律
      拒绝）· dockerfile <node|bun|python|rust> / compose / plan 五意图 ·
      ssh <host> "<cmd>"（host 须在 <ws>/ssh-hosts.allow）· ssh-template ·
      manifest <deployment|service|ingress|configmap|pvc> · terraform ·
      clis（10 家云 CLI 探测表）· overview（21 模型商 + 10 云 CLI 全景）
  org iac [parse|plan|graph] <main.tf> · generate <manifest.json> · probe · validate [dir]
      IaC 深度实现（v0.5.18 · #44，与 iacscan 扫描面互补）：内置 HCL 子集
      解析器（block/label/属性/插值/heredoc/注释 —— 行号级诚实报错）→ 资源
      依赖图（拓扑序 + 环检测）→ 人读 Plan（to create N resources 风格，
      与真 terraform plan 差异诚实标注）→ JSON manifest 逆向生成 .tf
      （iacParse 往返自洽）；probe 探测 terraform/tofu/tflint 三工具（缺席
      → 内置车道为主车道）；validate 在场时跑 terraform validate -json（只读）
  org mobile probe · devices · logcat · forward · apk · plan · self-test
      移动端调试统一入口（v0.5.18 · #117）：多重优雅降级 —— devices 三层
      （adb 缺席→无设备→未授权）/ forward 四层（adb→设备→socket 发现
      /proc/net/unix→CDP /json 页面清单）/ apk 两层（aapt badging→魔数
      PK 魔数）/ logcat 五元组 dump（-d 快照·tag/级别/包名过滤）· plan
      纯函数保底（平台 × 症状矩阵步骤化计划，零外部依赖永远可用）·
      执行面全只读（install/uninstall 只出现在计划的可粘贴命令里）
  org remote probe · hosts [name] · exec · sync · ping · plan · self-test
      远程 Agent 簇（v0.5.18 · #133 会话/部署/计划层 —— 与 cloud_ssh 单命令
      执行互补）：probe 四工具探测（ssh/scp/rsync/ssh-keygen + OpenSSH
      版本 + agent 环境）· hosts 主机档案（<ws>/remote-hosts.json，name→
      host/user/port/identity；host 不在档案 = 拒绝不猜默认）· exec 会话级
      执行（命令白名单默认只读，非白名单须 --allow-full）· sync rsync→scp→
      指引三层降级（local 过监狱）· ping echo 往返 min/avg/max · plan 部署
      计划四式（git/rsync/容器/run 队列远程化+回滚，纯函数保底车道）
  org mcp servers · tools [name] · call <server> <tool> [json] ·
       resources [name] · read <server> <uri> · prompts [name] · self-test
      MCP 客户端桥（v0.5.19 · #122/C12 协议翻译）：org 作为 MCP 客户端，
      按 <ws>/mcp-servers.json 档案 spawn 外部 server（stdio 换行分帧
      JSON-RPC），initialize 握手 + 能力协商（tools/resources/prompts 三
      面，缺席诚实 unsupported）+ 分页跟进；call 是执行车道（工具环走
      process_spawn 门 + 审批在环）；env 秘密键只收 $env:VAR 引用（值
      永不入档案）；会话粒度 = 每操作一会话（长连接复用是路线图）

仓库布局：hsl/ = HSL 源码；toolchain/dhv-ts = 内嵌解释器（vendored）；
          demo-run/ = 本地构建目录（git 忽略）；dist/ = 编译产物（入库）

环境变量：ORG_CAPABILITY_APPROVED=1 批准能力变更补丁（仅用户）；
          ORG_REDUNDANCY>=2 启用 N 版本冗余；
          DHV_TS 覆盖内嵌工具链；
          模型配置优先用 org config（持久化）：ORG_CONFIG 指定配置文件路径。`);
      return 0;
  }
}

// ----------------------------------------------------------------------------
// 独立入口守卫（与 cli/chat.ts 的既有约定对齐）。
// 此前这里是裸的 `process.exit(await main())`：任何 `import "../cli/org.ts"`
// （例如测试引入纯函数 parseSelection）都会立即执行整个 CLI —— 打印帮助并
// process.exit(0)，把导入方连同测试进程一起终结。chat.ts 早已补上
// import.meta.main 守卫（见其文件尾注），org.ts 漏了，这里补齐。
// ----------------------------------------------------------------------------
if (import.meta.main) {
  process.exit(await orgMain());
}
