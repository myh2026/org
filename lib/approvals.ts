// ============================================================================
// org/lib/approvals.ts — 交互式审批队列的文件协议（四端共用的唯一实现）
// ----------------------------------------------------------------------------
// HSL 侧 hsl/policy/approval.hsl 落盘请求并有界轮询回复；本模块是**读侧与写侧
// 的唯一实现**，供 CLI（org approvals）/ TUI（:approvals）/ chat（/approve）/
// Web（/api/approvals）共用 —— 四个前端各写一遍目录遍历与半写容错必然会漂。
//
// 目录契约（<workspace>/runtime/approvals/）：
//   <id>.json         请求；判定后同一文件被写回 resolved{allow,always,by,ts,waited_ms}
//                     —— 请求文件同时是审计记录，所以判定后**不删只标记**
//   <id>.reply.json   回复（HSL 侧读到后清空内容）
//   granted.json      长期放行集 {capabilities: [...]}
//
// 硬约束：已判定的请求不得重复决策（否则一次决策会被计成两次，且审计记录被覆盖）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

export interface ApprovalRequest {
  id: string;
  capability: string;
  action: string;
  detail: string;
  ts: string;
  timeout_ms: number;
  workspace?: string;
}

export interface ApprovalResolution {
  allow: boolean;
  always: boolean;
  by: string;
  ts: string;
  waited_ms: number;
}

export interface ApprovalView {
  pending: ApprovalRequest[];
  granted: string[];
  /** 已判定（审计记录）：给「历史」视图用。 */
  resolved: Array<ApprovalRequest & { resolved: ApprovalResolution }>;
}

/** 审批目录（workspace 相对）。 */
export function approvalsDir(ws: string): string {
  return path.join(ws, "runtime", "approvals");
}

/** id 形态校验（与 HSL 侧 `ap-<base36>-<4>` 的生成式一致）。 */
export function validApprovalId(id: string): boolean {
  return /^ap-[A-Za-z0-9-]{4,64}$/.test(id);
}

/**
 * 列出待批准 / 长期放行集 / 已判定记录。
 * 半写状态（空文件、非法 JSON）一律跳过而不是抛错 —— 审批目录是并发写入的
 * （run 侧在写请求，人侧在写回复），读侧必须容忍中间态。
 */
export function listApprovals(ws: string): ApprovalView {
  const dir = approvalsDir(ws);
  const pending: ApprovalRequest[] = [];
  const resolved: Array<ApprovalRequest & { resolved: ApprovalResolution }> = [];
  let granted: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { pending, granted, resolved }; // 目录不存在 = 从未有过审批
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".reply.json")) continue;
    if (f === "granted.json") {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as { capabilities?: string[] };
        granted = Array.isArray(obj.capabilities) ? obj.capabilities : [];
      } catch { /* 放行集半写：本轮视为空 */ }
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      if (raw.trim().length === 0) continue;
      const obj = JSON.parse(raw) as ApprovalRequest & { resolved?: ApprovalResolution };
      if (obj.resolved) resolved.push({ ...obj, resolved: obj.resolved });
      else pending.push(obj);
    } catch { /* 半写：下一轮再读 */ }
  }
  // 稳定的展示顺序：按写入时间（ts）升序，缺 ts 的排最后
  pending.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  resolved.sort((a, b) => String(b.resolved.ts ?? "").localeCompare(String(a.resolved.ts ?? "")));
  return { pending, granted, resolved };
}

export interface DecideResult {
  ok: boolean;
  error?: string;
  /** HTTP 语义的状态码，供 Web 端点直接映射（400 / 404 / 409）。 */
  status: number;
}

/**
 * 决策：写 `<id>.reply.json`。
 * @param always 仅对 allow 有意义：写入长期放行集（由 HSL 侧落盘，因为它
 *               需要与「本次放行」原子地一起写）。
 */
export function decideApproval(ws: string, id: string, allow: boolean, always: boolean, by: string): DecideResult {
  if (!validApprovalId(id)) return { ok: false, error: `审批 id 不合法：${id}`, status: 400 };
  const dir = approvalsDir(ws);
  const reqFile = path.join(dir, `${id}.json`);
  if (!fs.existsSync(reqFile)) {
    return { ok: false, error: `审批请求不存在或已处理：${id}`, status: 404 };
  }
  // 已判定不得重复决策：否则一次决策会被计两次，且审计记录被覆盖
  try {
    const cur = JSON.parse(fs.readFileSync(reqFile, "utf-8")) as { resolved?: ApprovalResolution };
    if (cur.resolved) {
      return {
        ok: false,
        error: `该审批已判定（${cur.resolved.by}${cur.resolved.allow ? " 放行" : " 拒绝"}）：${id}`,
        status: 409,
      };
    }
  } catch { /* 半写：按未判定处理（HSL 侧消费回复是幂等的） */ }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.reply.json`), JSON.stringify({ allow, always, by }));
  return { ok: true, status: 200 };
}

/** 清空长期放行集（用户撤销「总是放行」；文件删除即失效）。 */
export function clearGranted(ws: string): void {
  fs.rmSync(path.join(approvalsDir(ws), "granted.json"), { force: true });
}
