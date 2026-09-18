// ============================================================================
// lib/rbac.ts — RBAC 角色权限层（v0.5.16 · capabilities #149 SSO/RBAC/数据驻留）
// ----------------------------------------------------------------------------
// 「谁能按哪个按钮」的本地实现：角色文件 <ws>/.org/rbac.json 声明
// roles → {allow, deny} 两条模式清单，判定器给出结构化决策 + 单行 JSONL
// 审计记录（由调用方落账本 —— 本模块不写文件）。五个入口：
//   · loadRbac(ws)                     加载策略（文件缺失 / 损坏 → 单机
//                                      owner 全放行兜底 + fallbackReason）
//   · rbacCheck(policy, role, action)  判定（deny 优先；默认拒绝）
//   · rbacRoles(policy)                角色清单
//   · rbacActions(policy, role)        角色的 allow/deny 规则面（调试辅助）
//   · rbacDecisionLog(decision)        决策 → 单行 JSONL 字符串（审计账本行）
//
// 【能力口径（诚实边界）】#149 的三件事本模块落地的是 RBAC 核心；SSO（OIDC
//   对接、身份供应商联邦）与数据驻留（区域固定、出站约束）是路线图 —— 但
//   契约面已为它们预留：action 命名空间不设白名单（sso:* / data:* 等
//   前缀照常走模式匹配），决策日志行是带 ts 的结构化 JSON（审计导出 #150
//   可直接消费）。绝不冒充已有 SSO。
//
// 【模式匹配语义】action 形如 "tool:shell_run" / "cli:db" / "git:push"。
//   · "*"          命中一切
//   · "tool:fs_*"  尾部 * = 前缀通配（action.startsWith("tool:fs_")）
//   · 其余         全等匹配
//   中置 * 不做通配（按字面处理）—— 支持面就是「全量 * 与前缀通配」两
//   种，简单可预测；文档化的诚实边界。边界例：tool:fs_write 命中
//   tool:fs_*；tool:fsx 不命中（缺下划线分隔）。
//
// 【判定次序】deny 优先于 allow：先扫 deny 清单，命中即拒（rule 记
//   "deny:<模式>"）；再扫 allow，命中即放（"allow:<模式>"）；两者皆未命中
//   → 默认拒绝（"default-deny"）。未知角色 → 拒（"unknown-role"，附人读
//   原因）—— 权限体系对「不知道的身份」只有拒绝一个答案。
//
// 【缺省兜底（单机桌面哲学）】文件缺失 → 降级为 owner 单角色全放行
//   （FALLBACK_RBAC_POLICY）+ fallbackReason 明示为什么 —— 可用性优先，
//   绝不静默也绝不把单机用户锁在门外。多人部署路线图中将改为 fail-closed
//   （坏配置拒载）—— 当前取舍在文件头如实记录。文件存在但 JSON 坏 /
//   结构非法（roles 缺失、清单含非字符串…）→ 同兜底，fallbackReason 附
//   诊断（安全敏感配置不允许半载入：要么完整可信，要么整体降级并显式告知）。
//
// 【优雅降级铁律】所有导出零逃逸：loadRbac 永不 throw；rbacCheck 对未知
//   角色 / 空清单 / 畸形 policy 一律结构化拒绝；rbacDecisionLog 输出保证
//   单行（JSON.stringify 转义一切控制字符，物理上不可能出现裸换行）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

/** 角色文件位置（相对工作区根）。 */
export const RBAC_POLICY_FILE = ".org/rbac.json";

// ---- 类型 -------------------------------------------------------------------

/** 一个角色的两条模式清单（都可为空 —— 全空 = 默认全拒的角色）。 */
export interface RbacRoleRules {
  /** 放行模式（命中且未被 deny 拦截才放行）。 */
  allow: string[];
  /** 拒绝模式（优先于 allow —— 先查 deny，命中即拒）。 */
  deny: string[];
}

/** 一份策略：角色名 → 规则。 */
export interface RbacPolicy {
  roles: Record<string, RbacRoleRules>;
}

/** 一次判定的结构化决策（审计与 UI 共用）。 */
export interface RbacDecision {
  allowed: boolean;
  role: string;
  action: string;
  /** 命中的规则："allow:<模式>" / "deny:<模式>" / "default-deny" /
   *  "unknown-role"（机器可分型；人读解释在 reason）。 */
  rule: string;
  /** 人读原因（未知角色 / 默认拒绝时给出；显式命中时给出简短溯源）。 */
  reason?: string;
}

// ---- 内置策略 ----------------------------------------------------------------

/** 文档化模板：团队部署的参考 rbac.json（CLI/Web 可直接播种给用户）。四角
 *  色演示 allow/deny/前缀通配的全部形态 —— 注意 observer 的 deny:["*"] 按
 *  「deny 优先」语义压过其 allow 清单（该角色默认全拒，解锁需删掉该 deny
 *  或改写清单 —— 表达「白名单外全拒」不需要 deny:["*"]，allow 未命中本就
 *  默认拒绝）。 */
export const DEFAULT_RBAC_POLICY: RbacPolicy = {
  roles: {
    owner: { allow: ["*"], deny: [] },
    maintainer: { allow: ["tool:*", "cli:*"], deny: ["git:push"] },
    operator: {
      allow: ["tool:fs_*", "tool:shell_run", "cli:db", "cli:read"],
      deny: ["tool:audit_export"],
    },
    observer: {
      allow: ["cli:status", "cli:score", "tool:db_schema", "tool:db_query"],
      deny: ["*"],
    },
  },
};

/** 单机兜底策略：文件缺失 / 损坏时的 owner 全放行（附 fallbackReason 使用）。 */
export const FALLBACK_RBAC_POLICY: RbacPolicy = {
  roles: { owner: { allow: ["*"], deny: [] } },
};

// ---- 模式匹配 ------------------------------------------------------------------

/** 模式 → 是否命中 action。语义见文件头「模式匹配语义」：全量 * / 尾部 *
 *  前缀通配 / 其余全等；中置 * 不通配（诚实边界）。 */
function matchAction(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}

// ---- 策略加载 ------------------------------------------------------------------

/** 严格结构校验 + 规范化：必须是 {roles: {<角色>: {allow?: string[], deny?:
 *  string[]}}}；任何结构偏差（roles 缺失 / 非对象 / 清单含非字符串）→ 整
 *  体判废（安全配置不允许半载入）。通过返回规范化副本（缺省清单补 []）。 */
function validatePolicy(parsed: unknown): { ok: true; policy: RbacPolicy } | { ok: false; error: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "顶层必须是 JSON 对象" };
  }
  const roles = (parsed as { roles?: unknown }).roles;
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
    return { ok: false, error: "缺少 roles 对象（应为 {\"roles\": {\"<角色>\": {\"allow\": [...], \"deny\": [...]}}}" };
  }
  const out: RbacPolicy = { roles: {} };
  for (const [name, rules] of Object.entries(roles)) {
    if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
      return { ok: false, error: `角色「${name}」的规则必须是对象（allow/deny 清单）` };
    }
    const allow = (rules as { allow?: unknown }).allow ?? [];
    const deny = (rules as { deny?: unknown }).deny ?? [];
    if (!Array.isArray(allow) || !Array.isArray(deny)) {
      return { ok: false, error: `角色「${name}」的 allow/deny 必须是字符串数组` };
    }
    for (const p of [...allow, ...deny]) {
      if (typeof p !== "string" || p.length === 0) {
        return { ok: false, error: `角色「${name}」的模式清单含非字符串 / 空串（应为 "tool:fs_*" 这类非空字符串）` };
      }
    }
    out.roles[name] = { allow: [...allow], deny: [...deny] };
  }
  return { ok: true, policy: out };
}

/** 加载工作区策略：<ws>/.org/rbac.json。文件缺失 → 单机 owner 兜底
 *  （file:null + fallbackReason）；文件存在但 JSON 坏 / 结构非法 → 同兜底
 *  （file 指向坏文件 + fallbackReason 附诊断）。绝不抛异常。 */
export function loadRbac(ws: string): {
  policy: RbacPolicy;
  file: string | null;
  fallbackReason?: string;
} {
  const file = path.join(ws, RBAC_POLICY_FILE);
  let text: string;
  try {
    if (!fs.existsSync(file)) {
      return {
        policy: FALLBACK_RBAC_POLICY,
        file: null,
        fallbackReason:
          `未找到 ${RBAC_POLICY_FILE}（${file}）：单机模式按 owner 全放行兜底 —— ` +
          `多人协作请创建该文件（模板见 DEFAULT_RBAC_POLICY）`,
      };
    }
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return {
      policy: FALLBACK_RBAC_POLICY,
      file,
      fallbackReason: `策略文件不可读（${file}）：${e instanceof Error ? e.message : String(e)} —— 已降级单机 owner 全放行兜底`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      policy: FALLBACK_RBAC_POLICY,
      file,
      fallbackReason:
        `策略文件 JSON 解析失败（${file}）：${e instanceof Error ? e.message : String(e)} —— ` +
        `已降级单机 owner 全放行兜底，请修复后重载`,
    };
  }
  const v = validatePolicy(parsed);
  if (!v.ok) {
    return {
      policy: FALLBACK_RBAC_POLICY,
      file,
      fallbackReason: `策略文件结构非法（${file}）：${v.error} —— 已降级单机 owner 全放行兜底，请修复后重载`,
    };
  }
  return { policy: v.policy, file };
}

// ---- 判定 -----------------------------------------------------------------------

/** 判定角色能否执行动作。次序：未知角色 → 拒；deny 命中 → 拒；allow 命中
 *  → 放；皆未命中 → 默认拒。永不抛异常（畸形 policy 按未知角色路径拒）。 */
export function rbacCheck(policy: RbacPolicy, role: string, action: string): RbacDecision {
  const rules = policy?.roles?.[role];
  if (rules === undefined || rules === null) {
    return {
      allowed: false, role, action, rule: "unknown-role",
      reason: `未知角色「${role}」：策略未定义该角色（${Object.keys(policy?.roles ?? {}).length} 个已定义角色），拒绝执行`,
    };
  }
  // deny 优先：先扫 deny，命中即拒（哪怕 allow 也命中）
  for (const p of rules.deny ?? []) {
    if (matchAction(p, action)) {
      return {
        allowed: false, role, action, rule: `deny:${p}`,
        reason: `角色「${role}」的 deny 规则「${p}」命中动作「${action}」（deny 优先于 allow）`,
      };
    }
  }
  for (const p of rules.allow ?? []) {
    if (matchAction(p, action)) {
      return {
        allowed: true, role, action, rule: `allow:${p}`,
        reason: `角色「${role}」的 allow 规则「${p}」命中动作「${action}」`,
      };
    }
  }
  return {
    allowed: false, role, action, rule: "default-deny",
    reason: `动作「${action}」未命中角色「${role}」的任何 allow 规则（默认拒绝 —— 需要放行请在 rbac.json 的 allow 清单追加模式）`,
  };
}

/** 角色清单（字典序稳定输出 —— UI 与测试可预期）。 */
export function rbacRoles(policy: RbacPolicy): string[] {
  return Object.keys(policy?.roles ?? {}).sort();
}

/** 角色的规则面（调试辅助：配置界面 / CLI 调试用）。未知角色 → 空清单 +
 *  unknown:true（不炸、不冒充）。 */
export function rbacActions(policy: RbacPolicy, role: string): {
  role: string;
  allow: string[];
  deny: string[];
  unknown?: boolean;
} {
  const rules = policy?.roles?.[role];
  if (rules === undefined || rules === null) {
    return { role, allow: [], deny: [], unknown: true };
  }
  return { role, allow: [...rules.allow], deny: [...rules.deny] };
}

// ---- 审计日志行 -------------------------------------------------------------------

/** 决策 → 单行 JSONL 字符串（调用方落账本，本模块不写文件）。行内带 ts
 *  （渲染时刻的 ISO 时间戳 —— 判定本身保持纯函数，时间戳属于日志而非决
 *  策）。JSON.stringify 转义一切控制字符 → 物理上不可能是多行。 */
export function rbacDecisionLog(decision: RbacDecision): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...decision });
}
