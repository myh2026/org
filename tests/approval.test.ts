// ============================================================================
// tests/approval.test.ts — v0.5.0：交互式审批队列（文件协议）
// ----------------------------------------------------------------------------
// 为什么是文件协议而不是宿主内建通道：图执行当前没有挂起点，`$host.askUser`
// 需要改 vendored 解释器。文件协议的取舍是最多一个轮询周期的延迟，换来三端同权。
//
// 本文件锁死四条硬约束（都是「不做会出事」的那种）：
//   1. 队列关闭（缺省）→ NotQueued：CI / 脚本 / org demo 行为零变化；
//   2. 无人应答 → **有界超时降级为拒绝**：run 绝不被挂住；
//   3. 放行 / 长期放行集 / 拒绝三态各自的落盘与事件；
//   4. 判定后请求文件带 resolved 标记（否则会永远挂在待批准列表里 —— 实测踩过）。
// ============================================================================
//
// 端到端用例超时：本文件用例会真实 spawn 解释器；bun 默认每用例 5000ms，
// 故逐例显式声明（与 tests/helpers.ts 的说明一致）。

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { ROOT, DHV, TEST_RUN, runOrg, readJson, exists } from "./helpers";
import { startWebServer } from "../web/entry.ts";
import { normalizeEventLine } from "../lib/events";
import { classifyRunEvent } from "../lib/runCards";

const PROBE = path.join(ROOT, "hsl/probe/probe11-approval.hsl");
const WS = path.join(TEST_RUN, "approval-ws");
const APPR = () => path.join(WS, "runtime", "approvals");

function shPath(p: string): string { return p.replace(/\\/g, "/"); }

/** 同步跑一次探针（脚本车道）。 */
function runProbe(outName: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync([
    process.execPath, DHV, "run", PROBE,
    "--workspace", WS, "--task", "probe", "--model", "scripted",
    "--out", path.join(WS, outName),
  ], { cwd: ROOT, env: { ...process.env, DHV_TS: shPath(DHV), ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

/** 非阻塞跑探针（用于「跑到一半被放行」的并发场景）。 */
function spawnProbe(outName: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([
    process.execPath, DHV, "run", PROBE,
    "--workspace", WS, "--task", "probe", "--model", "scripted",
    "--out", path.join(WS, outName),
  ], { cwd: ROOT, env: { ...process.env, DHV_TS: shPath(DHV), ...env }, stdout: "pipe", stderr: "pipe" });
  return proc;
}

/** 轮询等待某个待批准请求出现（返回其 id）。 */
async function waitForRequest(timeoutMs = 20000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      for (const f of fs.readdirSync(APPR())) {
        if (!f.endsWith(".json") || f.endsWith(".reply.json") || f === "granted.json") continue;
        const obj = readJson(path.join(APPR(), f)) as { id?: string; resolved?: unknown };
        if (!obj.resolved && obj.id) return obj.id;
      }
    } catch { /* 目录还没建 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("等待审批请求超时");
}

function resetApprovals(): void {
  fs.rmSync(APPR(), { recursive: true, force: true });
  fs.mkdirSync(APPR(), { recursive: true });
}

beforeAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  resetApprovals();
});

describe("v0.5.0：审批队列 —— 队列关闭时行为零变化", () => {
  test("缺省（ORG_APPROVAL 未设）→ NotQueued，且不落任何请求文件", () => {
    resetApprovals();
    const r = runProbe("o-off");
    expect(r.out).toContain("verdict-1 = NotQueued");
    expect(r.out).toContain("verdict-2 = NotQueued");
    // 不留痕：CI / 脚本场景不该被写工作区
    expect(fs.readdirSync(APPR()).length).toBe(0);
  }, 120_000);

  test("显式关闭（ORG_APPROVAL=0/off）同样 NotQueued", () => {
    resetApprovals();
    const r = runProbe("o-off2", { ORG_APPROVAL: "0" });
    expect(r.out).toContain("verdict-1 = NotQueued");
  }, 120_000);
});

describe("v0.5.0：审批队列 —— 无人应答时有界降级", () => {
  test("超时 → Denied，且耗时受控（不挂住 run）+ 请求标记 resolved=timeout", () => {
    resetApprovals();
    const t0 = Date.now();
    const r = runProbe("o-timeout", { ORG_APPROVAL: "1", ORG_APPROVAL_TIMEOUT_MS: "1200" });
    const elapsed = Date.now() - t0;
    expect(r.out).toContain("verdict-1 = Denied");
    expect(r.out).toContain("verdict-2 = Denied");
    // 两次请求 × 1.2s ≈ 2.4s；给足余量但必须远小于「无限等待」
    expect(elapsed).toBeLessThan(60_000);

    const files = fs.readdirSync(APPR()).filter((f) => f.endsWith(".json") && !f.endsWith(".reply.json"));
    expect(files.length).toBe(2);
    for (const f of files) {
      const obj = readJson(path.join(APPR(), f)) as { resolved?: { allow: boolean; by: string; waited_ms: number } };
      expect(obj.resolved).toBeDefined();
      expect(obj.resolved!.allow).toBe(false);
      expect(obj.resolved!.by).toBe("timeout");
    }
    // 事件：requested 应发出（审批不是静默行为）
    const ev = fs.readFileSync(path.join(WS, "o-timeout/events.jsonl"), "utf-8");
    expect(ev).toContain("approval_requested");
    expect(ev).toContain("approval_timeout");
  }, 120_000);
});

describe("v0.5.0：审批队列 —— 放行与长期放行集", () => {
  test("并发放行 → Allowed；带 always 时写入长期放行集，第二次直接命中缓存", async () => {
    resetApprovals();
    const proc = spawnProbe("o-allow", { ORG_APPROVAL: "1", ORG_APPROVAL_TIMEOUT_MS: "60000" });
    const id = await waitForRequest();
    // 放行 + 长期放行
    fs.writeFileSync(path.join(APPR(), `${id}.reply.json`), JSON.stringify({ allow: true, always: true, by: "test" }));
    const code = await proc.exited;
    expect(code).toBe(0);
    const out = await proc.stdout.text();

    expect(out).toContain("verdict-1 = Allowed");
    expect(out).toContain("verdict-2 = Allowed");     // 第二次命中长期放行集
    expect(out).toContain("granted-after=[capability_change]");

    const granted = readJson(path.join(APPR(), "granted.json")) as { capabilities: string[] };
    expect(granted.capabilities).toContain("capability_change");

    const ev = fs.readFileSync(path.join(WS, "o-allow/events.jsonl"), "utf-8");
    expect(ev).toContain("approval_resolved");
    expect(ev).toContain("approval_cached");          // 第二次是缓存命中
    expect((ev.match(/approval_requested/g) ?? []).length).toBe(1); // 只打扰了一次
  }, 120_000);

  test("放行（不带 always）→ Allowed，但不写长期放行集", async () => {
    resetApprovals();
    // 清掉可能残留的放行集
    fs.rmSync(path.join(APPR(), "granted.json"), { force: true });
    const proc = spawnProbe("o-once", { ORG_APPROVAL: "1", ORG_APPROVAL_TIMEOUT_MS: "60000" });
    const id = await waitForRequest();
    fs.writeFileSync(path.join(APPR(), `${id}.reply.json`), JSON.stringify({ allow: true, by: "test" }));
    await proc.exited;
    const out = await proc.stdout.text();
    expect(out).toContain("verdict-1 = Allowed");
    // 第二次没有放行集可命中 → 会再次请求（拿不到回复 → 超时拒绝）
    expect(out).toContain("verdict-2 = Denied");
    expect(exists(path.join(APPR(), "granted.json"))).toBe(false);
  }, 120_000);

  test("拒绝 → Denied，且请求标记 resolved.allow=false", async () => {
    resetApprovals();
    fs.rmSync(path.join(APPR(), "granted.json"), { force: true });
    const proc = spawnProbe("o-deny", { ORG_APPROVAL: "1", ORG_APPROVAL_TIMEOUT_MS: "60000" });
    const id = await waitForRequest();
    fs.writeFileSync(path.join(APPR(), `${id}.reply.json`), JSON.stringify({ allow: false, by: "test" }));
    await proc.exited;
    const out = await proc.stdout.text();
    expect(out).toContain("verdict-1 = Denied");
    const obj = readJson(path.join(APPR(), `${id}.json`)) as { resolved?: { allow: boolean; by: string } };
    expect(obj.resolved?.allow).toBe(false);
    expect(obj.resolved?.by).toBe("test");
  }, 120_000);
});

describe("v0.5.0：org approvals CLI", () => {
  test("列出待批准 / allow / deny / 已判定拒绝重复决策", async () => {
    resetApprovals();
    fs.rmSync(path.join(APPR(), "granted.json"), { force: true });
    const proc = spawnProbe("o-cli", { ORG_APPROVAL: "1", ORG_APPROVAL_TIMEOUT_MS: "60000" });
    const id = await waitForRequest();

    const list = runOrg(["approvals", "--workspace", WS]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("待批准 1 项");
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("capability_change");

    const deny = runOrg(["approvals", "deny", id, "--workspace", WS]);
    expect(deny.exitCode).toBe(0);
    expect(deny.stdout).toContain("已拒绝");
    await proc.exited;

    // 已判定 → 不再算待批准，且重复决策被拒
    const list2 = runOrg(["approvals", "--workspace", WS]);
    expect(list2.stdout).toContain("没有待批准的项");
    const again = runOrg(["approvals", "allow", id, "--workspace", WS]);
    expect(again.exitCode).toBe(1);
    // 非法 id 直接 400 语义（退出码 2）
    expect(runOrg(["approvals", "allow", "not-an-id", "--workspace", WS]).exitCode).toBe(2);
  }, 120_000);
});

describe("v0.5.0：审批的 Web 端点", () => {
  let srv: Bun.Server; let base: string;
  beforeAll(() => {
    srv = startWebServer({ workspace: WS, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${srv.port}`;
  }, 120_000);
  afterAll(() => { srv.stop(true); });

  test("GET 列表 / POST 决策 / 409 重复 / 400 坏 id / 404 不存在", async () => {
    resetApprovals();
    fs.rmSync(path.join(APPR(), "granted.json"), { force: true });
    const proc = spawnProbe("o-web", { ORG_APPROVAL: "1", ORG_APPROVAL_TIMEOUT_MS: "60000" });
    const id = await waitForRequest();

    const list = await (await fetch(`${base}/api/approvals`)).json() as { ok: boolean; pending: Array<{ id: string }>; granted: string[] };
    expect(list.ok).toBe(true);
    expect(list.pending.map((p) => p.id)).toContain(id);

    const ok = await fetch(`${base}/api/approvals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, allow: true, always: true }),
    });
    expect(ok.status).toBe(200);
    await proc.exited;

    const dup = await fetch(`${base}/api/approvals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, allow: true }),
    });
    expect(dup.status).toBe(409);                       // 已判定：不重复生效
    const bad = await fetch(`${base}/api/approvals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../etc/passwd", allow: true }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/approvals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ap-zzzz-9999", allow: true }),
    });
    expect(missing.status).toBe(404);

    // 判定后列表清空，长期放行集可见
    const after = await (await fetch(`${base}/api/approvals`)).json() as { pending: unknown[]; granted: string[] };
    expect(after.pending.length).toBe(0);
    expect(after.granted).toContain("capability_change");
  }, 120_000);

  test("GUI 单页含审批要素（徽标 / 面板 / 三态按钮 / 轮询）", async () => {
    const html = await (await fetch(`${base}/`)).text();
    for (const needle of ["approvalBtn", "approvalPane", "approvalScrim", "function openApprovals(",
                          "function decideApproval(", "function startApprovalPoll(",
                          "data-ap-allow", "data-ap-always", "data-ap-deny"]) {
      expect(html).toContain(needle);
    }
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(() => new Function(m![1]!)).not.toThrow();
  }, 120_000);
});

describe("v0.5.0：审批事件的具名化与分类", () => {
  const norm = (name: string, data: Record<string, unknown>) =>
    normalizeEventLine({ seq: 1, ts: "t", name, data } as never);

  test("四态各自归一化（字段完整）", () => {
    const req = norm("approval_requested", { id: "ap-1", capability: "capability_change", action: "a", detail: "d", timeout_ms: 120000 }) as Record<string, unknown>;
    expect(req.kind).toBe("approval_requested");
    expect(req.timeoutMs).toBe(120000);

    const res = norm("approval_resolved", { id: "ap-1", capability: "c", allow: true, always: true, by: "web", waited_ms: 1200 }) as Record<string, unknown>;
    expect(res.kind).toBe("approval_resolved");
    expect(res.allow).toBe(true);
    expect(res.always).toBe(true);
    expect(res.waitedMs).toBe(1200);

    expect((norm("approval_timeout", { id: "ap-1", capability: "c", action: "a", timeout_ms: 1 }) as Record<string, unknown>).kind).toBe("approval_timeout");
    expect((norm("approval_cached", { capability: "c", action: "a" }) as Record<string, unknown>).kind).toBe("approval_cached");
  });

  test("分类器：请求 → approval 事实（带入口），结论 → notice 三色调", () => {
    const ev = norm("approval_requested", { id: "ap-1", capability: "capability_change", action: "放行？", detail: "d", timeout_ms: 120000 });
    const f = classifyRunEvent(ev as never) as { t: string; id?: string; capability?: string };
    expect(f.t).toBe("approval");
    expect(f.id).toBe("ap-1");
    expect(f.capability).toBe("capability_change");

    const resolved = classifyRunEvent(norm("approval_resolved", { id: "ap-1", capability: "c", allow: false, always: false, by: "web", waited_ms: 5 }) as never) as { t: string; tone: string };
    expect(resolved.t).toBe("notice");
    expect(resolved.tone).toBe("err");

    const timeout = classifyRunEvent(norm("approval_timeout", { id: "ap-1", capability: "c", action: "a", timeout_ms: 1000 }) as never) as { t: string; tone: string; text: string };
    expect(timeout.tone).toBe("warn");
    expect(timeout.text).toContain("降级为拒绝");
  });
});
