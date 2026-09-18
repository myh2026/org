// ============================================================================
// tests/rbac.test.ts — RBAC 角色权限层（v0.5.16 · capabilities #149）
// ----------------------------------------------------------------------------
// lib/rbac.ts 全覆盖（16 用例，全部显式 30s 超时，tmp 工作区播种 + afterAll
// best-effort 清理）：
//   加载（4）：缺省兜底（owner 全放行 + fallbackReason）/ 有效文件加载与
//            规范化（缺 deny 补 []）/ 坏 JSON 降级附诊断 / 结构非法降级
//            （roles 缺失 / 清单非数组 / 含非字符串）
//   判定矩阵（6）：四角色命中矩阵（DEFAULT 模板逐角色逐动作）/ deny 优先于
//            allow / 通配边界（fs_write 命中 fs_*、fsx 不命中）/ 中置 *
//            不通配（文档化边界）/ 未知角色拒 / allow 未命中默认拒
//   辅助与审计（6）：空清单角色全拒 / rbacRoles 排序 / rbacActions 调试面 +
//            未知角色 / 决策日志单行 JSONL（可 parse + 字段齐 + 多次渲染
//            差异仅在 ts）/ deny 优先人读原因 / 兜底策略形状锁定
// ============================================================================
import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RBAC_POLICY_FILE,
  DEFAULT_RBAC_POLICY,
  FALLBACK_RBAC_POLICY,
  loadRbac,
  rbacCheck,
  rbacRoles,
  rbacActions,
  rbacDecisionLog,
} from "../lib/rbac.ts";

// ---- 测试基建 -------------------------------------------------------------------

const WSS: string[] = []; // afterAll best-effort 清理清单

/** 一次性 tmp 工作区。 */
function tmpWs(tag: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `org-rbac-${tag}-`));
  WSS.push(ws);
  return ws;
}

/** 写一份 rbac.json（自动建 .org 目录）。 */
function writePolicy(ws: string, content: string): string {
  fs.mkdirSync(path.join(ws, ".org"), { recursive: true });
  const file = path.join(ws, RBAC_POLICY_FILE);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

// ---- 1. 策略加载 -----------------------------------------------------------------

describe("rbac：loadRbac 加载与兜底", () => {
  test("缺省兜底：无 rbac.json → owner 全放行 + file:null + fallbackReason 指路", () => {
    const ws = tmpWs("missing");
    const r = loadRbac(ws);
    expect(r.file).toBeNull();
    expect(r.fallbackReason).toContain("未找到");
    expect(r.fallbackReason).toContain("owner 全放行");
    expect(r.fallbackReason).toContain("DEFAULT_RBAC_POLICY");
    expect(r.policy).toEqual(FALLBACK_RBAC_POLICY);
    // 兜底策略实打实全放行（owner 是唯一角色）
    expect(rbacRoles(r.policy)).toEqual(["owner"]);
    expect(rbacCheck(r.policy, "owner", "tool:shell_run").allowed).toBe(true);
    expect(rbacCheck(r.policy, "owner", "git:push").allowed).toBe(true);
  }, 30_000);

  test("有效文件：加载成功 + file 指向路径 + 无 fallbackReason + 缺 deny 规范化为 []", () => {
    const ws = tmpWs("valid");
    const file = writePolicy(ws, JSON.stringify({
      roles: { operator: { allow: ["tool:fs_*"] } }, // 无 deny 字段
    }));
    const r = loadRbac(ws);
    expect(r.file).toBe(file);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.policy.roles.operator).toEqual({ allow: ["tool:fs_*"], deny: [] }); // 规范化补齐
    expect(rbacCheck(r.policy, "operator", "tool:fs_write").allowed).toBe(true);
    expect(rbacCheck(r.policy, "operator", "tool:shell_run").allowed).toBe(false); // 默认拒
  }, 30_000);

  test("坏 JSON：降级 owner + fallbackReason 附解析诊断 + file 指向坏文件", () => {
    const ws = tmpWs("badjson");
    const file = writePolicy(ws, "{ roles: 缺引号的键 —— 这不是合法 JSON");
    const r = loadRbac(ws);
    expect(r.file).toBe(file);
    expect(r.fallbackReason).toContain("JSON 解析失败");
    expect(r.policy).toEqual(FALLBACK_RBAC_POLICY); // 降级兜底可用
    expect(rbacCheck(r.policy, "owner", "cli:db").allowed).toBe(true);
  }, 30_000);

  test("结构非法降级：roles 缺失 / roles 非对象 / 清单非数组 / 含非字符串 —— 整体判废附诊断", () => {
    const cases: Array<[string, string, string]> = [
      ["no-roles", JSON.stringify({ perms: {} }), "缺少 roles"],
      ["roles-array", JSON.stringify({ roles: [] }), "缺少 roles"],
      ["list-not-array", JSON.stringify({ roles: { x: { allow: "tool:*" } } }), "必须是字符串数组"],
      ["non-string-entry", JSON.stringify({ roles: { x: { allow: ["tool:*", 42] } } }), "非字符串"],
    ];
    for (const [tag, content, expectMsg] of cases) {
      const ws = tmpWs(tag);
      writePolicy(ws, content);
      const r = loadRbac(ws);
      expect(r.fallbackReason).toContain("结构非法");
      expect(r.fallbackReason).toContain(expectMsg);
      expect(r.policy).toEqual(FALLBACK_RBAC_POLICY);
    }
  }, 30_000);
});

// ---- 2. 判定矩阵 -----------------------------------------------------------------

describe("rbac：rbacCheck 判定", () => {
  test("四角色命中矩阵（DEFAULT 模板逐角色逐动作）", () => {
    const p = DEFAULT_RBAC_POLICY;
    // owner：全放行
    for (const a of ["tool:shell_run", "cli:db", "git:push", "tool:audit_export", "anything:else"]) {
      expect(rbacCheck(p, "owner", a)).toMatchObject({ allowed: true, rule: "allow:*" });
    }
    // maintainer：tool:*/cli:* 放行；git:push 被 deny；git:commit 默认拒
    expect(rbacCheck(p, "maintainer", "tool:shell_run")).toMatchObject({ allowed: true, rule: "allow:tool:*" });
    expect(rbacCheck(p, "maintainer", "cli:db").allowed).toBe(true);
    expect(rbacCheck(p, "maintainer", "git:push")).toMatchObject({ allowed: false, rule: "deny:git:push" });
    expect(rbacCheck(p, "maintainer", "git:commit")).toMatchObject({ allowed: false, rule: "default-deny" });
    expect(rbacCheck(p, "maintainer", "web:api")).toMatchObject({ allowed: false, rule: "default-deny" });
    // operator：前缀通配 fs_* + 精确项放行；audit_export deny；cli:status 默认拒
    expect(rbacCheck(p, "operator", "tool:fs_write")).toMatchObject({ allowed: true, rule: "allow:tool:fs_*" });
    expect(rbacCheck(p, "operator", "tool:shell_run")).toMatchObject({ allowed: true, rule: "allow:tool:shell_run" });
    expect(rbacCheck(p, "operator", "cli:db").allowed).toBe(true);
    expect(rbacCheck(p, "operator", "cli:read").allowed).toBe(true);
    expect(rbacCheck(p, "operator", "tool:audit_export")).toMatchObject({ allowed: false, rule: "deny:tool:audit_export" });
    expect(rbacCheck(p, "operator", "cli:status")).toMatchObject({ allowed: false, rule: "default-deny" });
    // observer：deny:["*"] 按「deny 优先」语义压过 allow 清单 —— 模板如实呈现该
    // 组合效果（全拒；表达「白名单外全拒」不需要 deny:*，allow 未命中本就默认拒）
    for (const a of ["cli:status", "tool:db_query", "tool:shell_run", "anything"]) {
      expect(rbacCheck(p, "observer", a)).toMatchObject({ allowed: false, rule: "deny:*" });
    }
  }, 30_000);

  test("deny 优先于 allow：allow:[\"*\"] 也拦不住 deny 命中", () => {
    const p: typeof DEFAULT_RBAC_POLICY = {
      roles: { boss: { allow: ["*"], deny: ["tool:danger_run", "tool:fs_*"] } },
    };
    expect(rbacCheck(p, "boss", "tool:shell_run")).toMatchObject({ allowed: true, rule: "allow:*" });
    expect(rbacCheck(p, "boss", "tool:danger_run")).toMatchObject({ allowed: false, rule: "deny:tool:danger_run" });
    expect(rbacCheck(p, "boss", "tool:fs_write")).toMatchObject({ allowed: false, rule: "deny:tool:fs_*" });
    // deny 先扫：即使 allow 清单里也有更精确的命中，deny 的裁决先行
    const p2 = { roles: { r: { allow: ["tool:fs_write"], deny: ["tool:fs_*"] } } };
    expect(rbacCheck(p2, "r", "tool:fs_write").allowed).toBe(false);
  }, 30_000);

  test("通配边界：tool:fs_write 命中 tool:fs_*；tool:fsx 不命中（缺下划线分隔）", () => {
    const p = { roles: { op: { allow: ["tool:fs_*"], deny: [] } } };
    expect(rbacCheck(p, "op", "tool:fs_write").allowed).toBe(true);
    expect(rbacCheck(p, "op", "tool:fs").allowed).toBe(false); // 前缀是 tool:fs_ —— 无下划线不命中
    expect(rbacCheck(p, "op", "tool:fsx").allowed).toBe(false);
    expect(rbacCheck(p, "op", "tool:fs_").allowed).toBe(true); // 前缀本身即命中（startswith 语义）
    expect(rbacCheck(p, "op", "cli:fs_write").allowed).toBe(false); // 命名空间不同不命中
    // 尾部通配的精确形式：cli:* 命中一切 cli: 动作
    const p2 = { roles: { m: { allow: ["cli:*"], deny: [] } } };
    expect(rbacCheck(p2, "m", "cli:db").allowed).toBe(true);
    expect(rbacCheck(p2, "m", "cli:").allowed).toBe(true);
    expect(rbacCheck(p2, "m", "cli").allowed).toBe(false); // 无冒号不命中
  }, 30_000);

  test("中置 * 不通配（文档化边界）：tool:*_run 按字面匹配", () => {
    const p = { roles: { r: { allow: ["tool:*_run"], deny: [] } } };
    expect(rbacCheck(p, "r", "tool:shell_run").allowed).toBe(false); // 不做中置通配
    expect(rbacCheck(p, "r", "tool:*_run").allowed).toBe(true); // 字面全等命中
  }, 30_000);

  test("未知角色拒：rule=unknown-role + 人读原因附已定义角色数", () => {
    const r = rbacCheck(DEFAULT_RBAC_POLICY, "hacker", "tool:db_query");
    expect(r.allowed).toBe(false);
    expect(r.rule).toBe("unknown-role");
    expect(r.role).toBe("hacker");
    expect(r.action).toBe("tool:db_query");
    expect(r.reason).toContain("未知角色");
    expect(r.reason).toContain("4 个已定义角色");
    // 空策略同样拒（畸形 policy 走未知角色路径，不炸）
    expect(rbacCheck({ roles: {} }, "x", "y").rule).toBe("unknown-role");
  }, 30_000);

  test("allow 未命中默认拒：rule=default-deny + 原因指路（追加 allow 模式）", () => {
    const r = rbacCheck(DEFAULT_RBAC_POLICY, "operator", "web:api");
    expect(r.allowed).toBe(false);
    expect(r.rule).toBe("default-deny");
    expect(r.reason).toContain("默认拒绝");
    expect(r.reason).toContain("allow 清单");
  }, 30_000);

  test("空清单角色：allow/deny 皆空 → 一切默认拒（最保守形态）", () => {
    const p = { roles: { ghost: { allow: [], deny: [] } } };
    for (const a of ["tool:shell_run", "cli:db", "*"]) {
      expect(rbacCheck(p, "ghost", a)).toMatchObject({ allowed: false, rule: "default-deny" });
    }
  }, 30_000);
});

// ---- 3. 辅助与审计 ----------------------------------------------------------------

describe("rbac：辅助函数与审计日志", () => {
  test("rbacRoles：字典序稳定输出（UI/测试可预期）", () => {
    expect(rbacRoles(DEFAULT_RBAC_POLICY)).toEqual(["maintainer", "observer", "operator", "owner"]);
    expect(rbacRoles(FALLBACK_RBAC_POLICY)).toEqual(["owner"]);
    expect(rbacRoles({ roles: {} })).toEqual([]);
  }, 30_000);

  test("rbacActions：调试面如实回显；未知角色 → 空清单 + unknown:true（不炸不冒充）", () => {
    expect(rbacActions(DEFAULT_RBAC_POLICY, "operator")).toEqual({
      role: "operator",
      allow: ["tool:fs_*", "tool:shell_run", "cli:db", "cli:read"],
      deny: ["tool:audit_export"],
    });
    expect(rbacActions(DEFAULT_RBAC_POLICY, "nobody")).toEqual({
      role: "nobody", allow: [], deny: [], unknown: true,
    });
  }, 30_000);

  test("决策日志：单行 JSONL —— 可 parse 往返 + 字段齐（ts/allowed/role/action/rule/reason）", () => {
    const d = rbacCheck(DEFAULT_RBAC_POLICY, "maintainer", "git:push");
    const line = rbacDecisionLog(d);
    expect(line.includes("\n")).toBe(false); // 单行铁证
    expect(line.includes("\r")).toBe(false);
    const back = JSON.parse(line) as Record<string, unknown>;
    expect(back.allowed).toBe(false);
    expect(back.role).toBe("maintainer");
    expect(back.action).toBe("git:push");
    expect(back.rule).toBe("deny:git:push");
    expect(typeof back.ts).toBe("string");
    expect((back.ts as string)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 时间戳
    expect(back.reason).toBe(d.reason);
    // 连续两次渲染：业务字段全同，ts 前缀一致（毫秒可能推进 —— 只断言格式）
    const line2 = rbacDecisionLog(d);
    expect(JSON.parse(line2).rule).toBe("deny:git:push");
  }, 30_000);

  test("deny 优先的人读原因：rule 带 deny: 前缀 + 原因说明优先语义", () => {
    const r = rbacCheck(DEFAULT_RBAC_POLICY, "maintainer", "git:push");
    expect(r.reason).toContain("deny 规则");
    expect(r.reason).toContain("deny 优先于 allow");
    const a = rbacCheck(DEFAULT_RBAC_POLICY, "maintainer", "cli:db");
    expect(a.reason).toContain("allow 规则");
    expect(a.reason).toContain("cli:*");
  }, 30_000);

  test("兜底策略形状锁定：owner 单角色全放行（缺省契约防漂移）", () => {
    expect(FALLBACK_RBAC_POLICY).toEqual({ roles: { owner: { allow: ["*"], deny: [] } } });
    expect(RBAC_POLICY_FILE).toBe(".org/rbac.json");
    // DEFAULT 模板四角色形状（文档化模板的稳定性守卫）
    expect(rbacRoles(DEFAULT_RBAC_POLICY)).toHaveLength(4);
  }, 30_000);
});

afterAll(() => {
  // best-effort 清理（失败不炸 —— tmp 目录由操作系统兜底回收）
  for (const ws of WSS) {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
  }
});
