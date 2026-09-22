// ============================================================================
// lib/spawn-decision.ts — 派生决策器（v0.5.22：递归派生的"该不该派"显式化）
// ----------------------------------------------------------------------------
// 背景：agent_spawn 已有深度/预算/池化三道治理（v0.5.6/v0.5.11），但「该不该
// 派」仍是隐式的 —— 提示词口头劝（"Use it ONLY when…"），没有机械判定。
// 用户要求：主 agent 拆解任务后判断哪些亲力亲为、哪些派子智能体；子智能体
// 递归重复该过程 —— 决策必须显式、可观测、可解释。
//
// 决策四态（优先级 deny > self > reuse > spawn）：
//   deny  治理终态：深度/预算耗尽（拒绝即终态，不烧预算）
//   self  亲力亲为：琐碎任务（词元稀疏无多步信号）或可替代工具
//         （读文件/列目录/查库 —— 直接 fs_read/fs_list/db_query 更快更省）
//   reuse 池化复用：相似 goal 已有成功派生（零派生成本）
//   spawn 真派生：多步信号（分解/流水线/多目标）或域内专家匹配
//
// 单一实现三端消费：agent_spawn 内嵌（self/deny 机械执行）+ 工具环
// spawn_decide（模型派生前先问）+ CLI `org spawn-decide`（演示/调试）+
// Web GET /api/govex/spawn-decide。决策落 spawn_decision 事件（可观测）。
// ============================================================================

/** 中英混合分词（与 agent_spawn/semantic_search 同构：西文词元 + CJK bigram）。 */
export function tokenizeGoal(text: string): string[] {
  const tokens: string[] = [];
  const lower = String(text || "").toLowerCase();
  for (const m of lower.match(/[a-z0-9_]+/g) || []) tokens.push(m);
  for (const seg of lower.match(/[\u3400-\u9fff]+/g) || []) {
    if (seg.length === 1) {
      tokens.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    tokens.push(seg.slice(seg.length - 1));
  }
  return tokens;
}

/** 多步信号词表（命中任一即有多步结构迹象）。 */
export const MULTI_STEP_SIGNALS: readonly { re: RegExp; label: string }[] = [
  { re: /然后|接着|其次|最后|首先|并且|同时|分别|以及|再然后/, label: "中文连接词" },
  { re: /步骤|分解|拆解|多步|流水线|逐个|依次/, label: "任务结构词" },
  { re: /\bthen\b|\bafter\b|\bnext\b|\bfirstly\b|\bsecondly\b|\bfinally\b|\bpipeline\b|\bdecompose\b/i, label: "英文连接词" },
  { re: /[、；;]/, label: "列表分隔符" },
  { re: /\b\d+[.、)]\s/, label: "编号列表" },
  { re: /输出结构化|输出表格|生成报告|验收|测试通过/, label: "复合交付词" },
];

/** 工具替代模式：goal 可由本层只读工具直接完成（派生是杀鸡用牛刀）。 */
export const TOOL_SUBSTITUTES: readonly { re: RegExp; tool: string; label: string }[] = [
  { re: /^(读|查看|看看|cat|read|view)([^\n]{0,40}(文件|file|\.ts\b|\.py\b|\.md\b|\.json\b|\.hsl\b))/i, tool: "fs_read", label: "单文件读取" },
  { re: /^(列出|列一下|ls|list|dir)\b/i, tool: "fs_list", label: "目录列举" },
  { re: /(找.{0,6}文件|文件名|glob|find file)/i, tool: "fs_glob", label: "文件名匹配" },
  { re: /(数据库|sqlite|sql 查询|查表|schema)/i, tool: "db_query", label: "SQLite 只读查询" },
  { re: /(语义|semantic|按意图|相似).{0,8}(搜|查|检索)/i, tool: "semantic_search", label: "语义检索" },
];

export interface SpawnSignals {
  /** goal 分词数（中英混合口径）。 */
  tokenCount: number;
  /** 命中的多步信号（label 列表）。 */
  multiStepSignals: string[];
  /** 可替代的只读工具（null = 无替代）。 */
  toolSubstitute: string | null;
  /** 琐碎任务（词元 < 4 且零多步信号）。 */
  trivial: boolean;
  /** 深度耗尽。 */
  depthExhausted: boolean;
  /** 预算耗尽。 */
  budgetExhausted: boolean;
  /** 池内最高相似度（0 = 无记录/不启用）。 */
  poolBestSimilarity: number;
}

export interface SpawnDecision {
  decision: "spawn" | "reuse" | "self" | "deny";
  /** 人读理由（一句话，事件与返回共用）。 */
  reason: string;
  signals: SpawnSignals;
  /** 建议的替代工具（self 态有值）。 */
  suggestedTool?: string;
  /** 派生态的子深度/子预算（spawn 态有值）。 */
  childDepth?: number;
  childBudget?: number;
  /** reuse 态的池记录 id。 */
  poolRecordId?: string;
}

export interface SpawnDecisionContext {
  goal: string;
  /** 当前深度（ORG_SPAWN_DEPTH）。 */
  depth: number;
  /** 深度上限（ORG_SPAWN_MAX，缺省 2；0 = 全局关闭）。 */
  maxDepth: number;
  /** 当前预算份数（ORG_SPAWN_BUDGET，缺省 100；-1 = off）。 */
  budget: number;
  /** 衰减率（ORG_SPAWN_DECAY，缺省 0.5）。 */
  decay: number;
  /** 池记录 goal 列表（预过滤的成功记录；缺席 = 空数组）。 */
  poolGoals: { goal: string; id: string }[];
  /** 复用相似度地板（缺省 0.6）。 */
  reuseFloor?: number;
}

/** 双向词面重合（与 agent_spawn 池匹配同构：max 覆盖率）。 */
export function goalOverlap(x: string, y: string): number {
  const tx = [...new Set(tokenizeGoal(x))];
  const sy = new Set(tokenizeGoal(y));
  if (tx.length === 0 || sy.size === 0) return 0;
  let hx = 0;
  for (const t of tx) if (sy.has(t)) hx++;
  const ty = [...new Set(tokenizeGoal(y))];
  const sx = new Set(tokenizeGoal(x));
  if (ty.length === 0) return 0;
  let hy = 0;
  for (const t of ty) if (sx.has(t)) hy++;
  return Math.max(hx / tx.length, hy / ty.length);
}

/** 派生决策（纯函数：相同输入恒同决策 —— 可测试、可回放、可解释）。 */
export function decideSpawn(ctx: SpawnDecisionContext): SpawnDecision {
  const goal = String(ctx.goal || "");
  const tokens = [...new Set(tokenizeGoal(goal))];
  const tokenCount = tokens.length;
  const multiStepSignals = MULTI_STEP_SIGNALS.filter((s) => s.re.test(goal)).map((s) => s.label);
  const sub = TOOL_SUBSTITUTES.find((t) => t.re.test(goal));
  const toolSubstitute = sub ? sub.tool : null;
  const trivial = tokenCount < 4 && multiStepSignals.length === 0;

  // 池相似度（复用判定与 agent_spawn 同构）
  const floor = ctx.reuseFloor ?? 0.6;
  let poolBest = 0;
  let poolBestId: string | null = null;
  for (const r of ctx.poolGoals) {
    const s = goalOverlap(goal, r.goal);
    if (s > poolBest) {
      poolBest = s;
      poolBestId = r.id;
    }
  }

  const signals: SpawnSignals = {
    tokenCount,
    multiStepSignals,
    toolSubstitute,
    trivial,
    depthExhausted: ctx.maxDepth === 0 || ctx.depth + 1 > ctx.maxDepth,
    budgetExhausted: ctx.budget !== -1 && ctx.budget < 1,
    poolBestSimilarity: Math.round(poolBest * 100) / 100,
  };

  // 1) deny：治理终态（拒绝即终态，不烧预算 —— 与 agent_spawn 深度/预算门同文案语义）
  if (ctx.maxDepth === 0) {
    return { decision: "deny", reason: "递归派生已全局关闭（ORG_SPAWN_MAX=0）—— 请在本层自行完成任务", signals };
  }
  if (signals.depthExhausted) {
    return { decision: "deny", reason: `递归深度已达上限（depth=${ctx.depth}, max=${ctx.maxDepth}）—— 子子孙孙须有界，请在本层自行完成任务`, signals };
  }
  if (signals.budgetExhausted) {
    return { decision: "deny", reason: `派生预算已耗尽（本层剩余 ${ctx.budget} 份）—— 请在本层自行完成；确需派生请让用户调大 ORG_SPAWN_BUDGET`, signals };
  }

  const childBudget = ctx.budget === -1 ? -1 : Math.floor(ctx.budget * ctx.decay);

  // 2) self：亲力亲为（琐碎 / 可替代工具 —— 派生是杀鸡用牛刀）
  if (trivial) {
    return {
      decision: "self",
      reason: `琐碎任务（${tokenCount} 词元 · 零多步信号）—— 亲力亲为更快：直接回答或用只读工具`,
      signals,
      suggestedTool: toolSubstitute ?? "fs_list",
    };
  }
  if (toolSubstitute && multiStepSignals.length === 0 && tokenCount < 12) {
    return {
      decision: "self",
      reason: `可替代工具（${sub!.label}）—— 本层直接调 ${toolSubstitute} 比派生子组织更快更省（无多步信号）`,
      signals,
      suggestedTool: toolSubstitute,
    };
  }

  // 3) reuse：池化复用（相似 goal 已有成功派生 —— 零成本）
  if (poolBest >= floor && poolBestId) {
    return {
      decision: "reuse",
      reason: `池化命中（相似度 ${signals.poolBestSimilarity} ≥ 地板 ${floor}）—— 复用既有成功派生，零派生成本`,
      signals,
      poolRecordId: poolBestId,
    };
  }

  // 4) spawn：真派生（多步信号 / 复杂度 / 无更优路径）
  const why = multiStepSignals.length > 0
    ? `多步信号（${multiStepSignals.slice(0, 3).join("·")}）`
    : tokenCount >= 12
      ? `任务规模较大（${tokenCount} 词元）`
      : `无自答路径（无工具替代 · 池无命中）`;
  return {
    decision: "spawn",
    reason: `${why} —— 派生子组织（子预算 ${childBudget}${ctx.budget === -1 ? "（治理关闭）" : " 份"} · 深度 ${ctx.depth + 1}/${ctx.maxDepth}）`,
    signals,
    childDepth: ctx.depth + 1,
    childBudget,
  };
}
