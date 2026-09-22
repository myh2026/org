// ============================================================================
// tests/tracker.test.ts — 工单系统（#86 Issue/工单集成 + #82 PR/MR，v0.5.21）
// ----------------------------------------------------------------------------
// 覆盖面：
//   1. 单元：resolveTrackerTarget（repo 形状校验 / 无 token 诚实拒绝 + 指引 /
//      env 优先级 / GHE 端点覆盖）+ maskToken 脱敏
//   2. mock GitHub API e2e（Bun.serve 零外联确定性毫秒级）：
//      - issueList：鉴权头/分页参数/摘要映射（含 labels）
//      - issueCreate：POST body 贯通 + title 空拒绝 + 超长拒绝
//      - issueComment / issueSetState（closed/open）
//      - prList / prView（diff 车道 + 8KB 截断 + diff 失败降级）
//      - prCreate（head/base 必填校验）
//      - HTTP 401/404/500 可诊断错误传播
//   3. CLI 冒烟：无 token → 指引 + 退出码 2；坏 repo 形状 → 2
//   4. 工具环 e2e（scripted 剧本）：issue_list 只读零审批全链（ORG_GH_API
//      指向 mock 网关，工具 native 块真实 fetch）
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveTrackerTarget, issueList, issueCreate, issueComment, issueSetState,
  prList, prView, prCreate, maskToken,
} from "../lib/tracker.ts";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";

// ---- 环境隔离（helpers 已注入 ORG_CONFIG 隔离；GH token 三件套显式管理） ----
const SAVED: Record<string, string | undefined> = {};
const VARS = ["ORG_GH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ORG_GH_API"];

let server: ReturnType<typeof Bun.serve> | null = null;
let requests: { method: string; path: string; auth: string | null; accept: string | null; body: unknown }[] = [];

/** mock GitHub API：记录请求三要素；issue/PR 端点按 REST 形状响应。 */
function startMockGh(): void {
  requests = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => null) : null;
      requests.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), accept: req.headers.get("accept"), body });
      const p = url.pathname;
      if (req.method === "GET" && p === "/repos/acme/widget/issues") {
        return Response.json([
          { number: 51, title: "DevTools 常驻会话", state: "open", user: { login: "alice" }, comments: 2, created_at: "2026-09-19T00:00:00Z", html_url: "https://github.com/acme/widget/issues/51", labels: [{ name: "bug" }, { name: "ci" }] },
          { number: 50, title: "MCP 客户端桥", state: "closed", user: { login: "bob" }, comments: 3, created_at: "2026-09-18T00:00:00Z", html_url: "https://github.com/acme/widget/issues/50", labels: [] },
        ]);
      }
      if (req.method === "GET" && p === "/repos/acme/widget/issues/99999") {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (req.method === "GET" && /^\/repos\/acme\/widget\/issues\/\d+$/.test(p)) {
        return Response.json({ number: 51, title: "DevTools 常驻会话", state: "open", body: "正文", user: { login: "alice" }, comments: 2, created_at: "2026-09-19T00:00:00Z", html_url: "https://github.com/acme/widget/issues/51" });
      }
      if (req.method === "POST" && p === "/repos/acme/widget/issues") {
        const b = body as { title?: string; body?: string; labels?: string[] };
        return Response.json({ number: 52, title: b.title, state: "open", user: { login: "acme" }, comments: 0, created_at: "2026-09-19T12:00:00Z", html_url: "https://github.com/acme/widget/issues/52", labels: (b.labels ?? []).map((n) => ({ name: n })) }, { status: 201 });
      }
      if (req.method === "POST" && /^\/repos\/acme\/widget\/issues\/\d+\/comments$/.test(p)) {
        return Response.json({ id: 9001, html_url: "https://github.com/acme/widget/issues/51#issuecomment-9001" }, { status: 201 });
      }
      if (req.method === "PATCH" && /^\/repos\/acme\/widget\/issues\/\d+$/.test(p)) {
        const b = body as { state?: string };
        return Response.json({ number: 51, title: "DevTools 常驻会话", state: b.state, user: { login: "alice" }, comments: 2, created_at: "2026-09-19T00:00:00Z", html_url: "https://github.com/acme/widget/issues/51", labels: [] });
      }
      if (req.method === "GET" && p === "/repos/acme/widget/pulls") {
        return Response.json([
          { number: 12, title: "feat: tracker", state: "open", draft: false, user: { login: "alice" }, head: { ref: "feat/tracker" }, base: { ref: "main" }, html_url: "https://github.com/acme/widget/pull/12", created_at: "2026-09-19T00:00:00Z" },
        ]);
      }
      if (req.method === "GET" && /^\/repos\/acme\/widget\/pulls\/\d+$/.test(p)) {
        if (req.headers.get("accept")?.includes("vnd.github.v3.diff")) {
          return new Response("diff --git a/x b/x\n+hello", { headers: { "Content-Type": "text/plain" } });
        }
        return Response.json({ number: 12, title: "feat: tracker", state: "open", draft: false, body: "PR 正文", user: { login: "alice" }, head: { ref: "feat/tracker" }, base: { ref: "main" }, html_url: "https://github.com/acme/widget/pull/12", created_at: "2026-09-19T00:00:00Z", additions: 100, deletions: 5, changed_files: 3 });
      }
      if (req.method === "POST" && p === "/repos/acme/widget/pulls") {
        const b = body as { title?: string; head?: string; base?: string };
        return Response.json({ number: 13, title: b.title, state: "open", draft: false, user: { login: "acme" }, head: { ref: b.head }, base: { ref: b.base }, html_url: "https://github.com/acme/widget/pull/13", created_at: "2026-09-19T12:00:00Z" }, { status: 201 });
      }
      if (p === "/repos/acme/protected/issues" || p === "/repos/acme/protected/pulls") {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
}

function ghUrl(): string {
  return `http://127.0.0.1:${server!.port}`;
}

/** 异步 spawn（Bun.spawn 不阻塞事件循环 —— mock 网关可 accept；
 *  spawnSync 阻塞主线程会让子进程对 mock 网关的 fetch 全部挂起超时，
 *  实测形态：in-process fetch 200、spawnSync 子进程 fetch 15s 不可达）。 */
async function runOrgAsync(args: string[], env: Record<string, string> = {}): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, path.join(process.cwd(), "cli/org.ts"), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORG_CONFIG: path.join(TEST_RUN, "isolated-user-config-absent.json"), // B-25 隔离
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, exitCode: code, stdout, stderr };
}

async function runDhvAsync(args: string[], env: Record<string, string> = {}): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const DHV = path.join(process.cwd(), "toolchain/dhv-ts/src/main.ts");
  const proc = Bun.spawn([process.execPath, DHV, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DHV_TS: DHV.replace(/\\/g, "/"), // 工具环 native 块定位 org 根的锚
      ORG_CONFIG: path.join(TEST_RUN, "isolated-user-config-absent.json"), // B-25 隔离
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, exitCode: code, stdout, stderr };
}

function target(api = ghUrl()) {
  return { repo: "acme/widget", api, token: "ghp_testtoken1234567890" };
}

beforeEach(() => {
  for (const v of VARS) SAVED[v] = process.env[v];
  for (const v of VARS) delete process.env[v];
  startMockGh();
});

afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v]!;
  }
  server?.stop(true);
  server = null;
});

// ---- 1. 单元 -----------------------------------------------------------------

describe("tracker：resolveTrackerTarget（鉴权与端点解析）", () => {
  test("repo 形状校验：非 owner/repo 形态拒绝（防 path 注入）", () => {
    const r = resolveTrackerTarget("https://evil.com/x");
    expect(r.error).toContain("repo 形状非法");
    const r2 = resolveTrackerTarget("a/b/c");
    expect(r2.error).toContain("repo 形状非法");
  });

  test("无 token 诚实拒绝：错误含三条配置指引", () => {
    const r = resolveTrackerTarget("acme/widget");
    expect(r.error).toContain("ORG_GH_TOKEN");
    expect(r.error).toContain("org config set gh_token");
    expect(r.error).toContain("GH_TOKEN");
  });

  test("token 优先级：ORG_GH_TOKEN > GH_TOKEN > GITHUB_TOKEN", () => {
    process.env.GH_TOKEN = "ghp_low";
    process.env.GITHUB_TOKEN = "ghp_lowest";
    let r = resolveTrackerTarget("acme/widget")!;
    expect(r.target!.token).toBe("ghp_low");
    process.env.ORG_GH_TOKEN = "ghp_high";
    r = resolveTrackerTarget("acme/widget")!;
    expect(r.target!.token).toBe("ghp_high");
  });

  test("GHE 端点覆盖：ORG_GH_API 指向企业网关", () => {
    process.env.ORG_GH_TOKEN = "ghp_x";
    process.env.ORG_GH_API = "https://github.acme.corp/api/v3/";
    const r = resolveTrackerTarget("acme/widget")!;
    expect(r.target!.api).toBe("https://github.acme.corp/api/v3");
  });

  test("maskToken：首 4 + … + 尾 4（密钥不落日志）", () => {
    expect(maskToken("ghp_testtoken1234567890")).toBe("ghp_…7890");
    expect(maskToken("short")).toBe("****");
  });
});

// ---- 2. mock GitHub API e2e ---------------------------------------------------

describe("tracker：GitHub REST e2e（mock 网关零外联）", () => {
  test("issueList：鉴权头 v3 + 摘要映射（labels 扁平化）", async () => {
    const r = await issueList(target(), { state: "open", limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.data!.length).toBe(2);
    expect(r.data![0].labels).toEqual(["bug", "ci"]);
    expect(requests[0].auth).toBe("Bearer ghp_testtoken1234567890");
    expect(requests[0].accept).toContain("/vnd.github+json");
    expect(requests[0].path).toContain("state=open");
    expect(requests[0].path).toContain("per_page=10");
  });

  test("issueCreate：POST body 贯通（title/body/labels）", async () => {
    const r = await issueCreate(target(), { title: "v0.5.21 工单系统交付", body: "实录……", labels: ["feat"] });
    expect(r.ok).toBe(true);
    expect(r.data!.number).toBe(52);
    const b = requests[0].body as Record<string, unknown>;
    expect(b.title).toBe("v0.5.21 工单系统交付");
    expect(b.labels).toEqual(["feat"]);
  });

  test("issueCreate：title 空/超长拒绝（本地校验不外发）", async () => {
    const r1 = await issueCreate(target(), { title: "  " });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("title 必填");
    const r2 = await issueCreate(target(), { title: "x".repeat(257) });
    expect(r2.error).toContain("title 过长");
    expect(requests.length).toBe(0); // 零外发
  });

  test("issueComment / issueSetState：写动作贯通", async () => {
    const c = await issueComment(target(), 51, "已交付 4314d1a");
    expect(c.ok).toBe(true);
    expect((requests[0].body as { body: string }).body).toBe("已交付 4314d1a");
    const s = await issueSetState(target(), 51, "closed");
    expect(s.ok).toBe(true);
    expect(s.data!.state).toBe("closed");
    expect(requests[1].method).toBe("PATCH");
  });

  test("prList / prView：diff 车道 + 元数据合并", async () => {
    const l = await prList(target(), { state: "open" });
    expect(l.data![0].head).toBe("feat/tracker");
    const v = await prView(target(), 12);
    const d = v.data as Record<string, unknown>;
    expect(d.additions).toBe(100);
    expect(String(d.diff)).toContain("+hello");
  });

  test("prView：diff 车道失败 → 降级为仅元数据（diff_note）", async () => {
    // 第二个 server：meta 正常、diff 500
    server?.stop(true);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const accept = req.headers.get("accept") ?? "";
        if (accept.includes("v3.diff")) return new Response("boom", { status: 500 });
        return Response.json({ number: 12, title: "x", state: "open", draft: false, body: "", user: { login: "a" }, head: { ref: "h" }, base: { ref: "b" }, html_url: "u", created_at: "t", additions: 1, deletions: 1, changed_files: 1 });
      },
    });
    const v = await prView(target(), 12);
    expect(v.ok).toBe(true);
    const d = v.data as Record<string, unknown>;
    expect(d.diff).toBeUndefined();
    expect(d.diff_note).toContain("降级");
  });

  test("prCreate：head/base 必填本地校验", async () => {
    const r = await prCreate(target(), { title: "t", head: "", base: "main" });
    expect(r.error).toContain("head");
    const ok = await prCreate(target(), { title: "feat", head: "feat/x", base: "main" });
    expect(ok.data!.number).toBe(13);
  });

  test("HTTP 错误可诊断：401 Bad credentials / 404 传播服务端 message", async () => {
    const t = target();
    const r1 = await issueList({ ...t, repo: "acme/protected" });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("401");
    expect(r1.error).toContain("Bad credentials");
    const r2 = await issueGet404(t);
    expect(r2.error).toContain("404");
  });
});

async function issueGet404(t: { repo: string; api: string; token: string }) {
  const { ghApi } = await import("../lib/tracker.ts");
  return ghApi(t, "GET", "/repos/acme/widget/issues/99999");
}

// ---- 3. CLI 冒烟 ---------------------------------------------------------------

describe("tracker：CLI 冒烟（org issue / org pr）", () => {
  test("无 token：指引 + 退出码 2（诚实拒绝不假装成功）", () => {
    const r = runOrg(["issue", "list", "--repo", "acme/widget"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("org config set gh_token");
  });

  test("坏 repo 形状：退出码 2", () => {
    process.env.ORG_GH_TOKEN = "ghp_x";
    const r = runOrg(["issue", "list", "--repo", "a/b/c"]);
    expect(r.exitCode).toBe(2);
  });

  test("org issue list（mock 网关 + ORG_GH_API 覆盖）：渲染清单", async () => {
    process.env.ORG_GH_TOKEN = "ghp_cli_test_12345";
    process.env.ORG_GH_API = ghUrl();
    const r = await runOrgAsync(["issue", "list", "--repo", "acme/widget"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("#51");
    expect(r.stdout).toContain("DevTools 常驻会话");
    expect(r.stdout).toContain("ghp_…2345"); // token 脱敏（首4+尾4）
  }, 120_000);
});

// ---- 4. 工具环 e2e（scripted 剧本 + mock 网关） ---------------------------------

describe("tracker：工具环 e2e（issue_list 只读全链）", () => {
  const WS = path.join(TEST_RUN, "tracker-ws");
  const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

  beforeEach(() => {
    fs.rmSync(WS, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
  });
  afterEach(() => fs.rmSync(WS, { recursive: true, force: true }));

  test("issue_list 工具：只读零审批 → mock 网关真实 fetch → 数据回灌", async () => {
    const fixture = path.join(TEST_RUN, "tracker-fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({
      tracks: {
        "direct:notice-parser": [
          '<tool>{"name":"issue_list","args":{"repo":"acme/widget","limit":10}}</tool>',
          "最终答案：#51 DevTools 常驻会话（open · bug/ci 标签）。",
        ],
      },
    }, null, 2));
    const out = path.join(TEST_RUN, "out-tracker", "e2e");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = await runDhvAsync([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 看看仓库有哪些开着的工单",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tracker-e2e",
      ORG_ASK_QUESTION: "看看仓库有哪些开着的工单", ORG_TOOLS: "1",
      ORG_GH_TOKEN: "ghp_tool_test_123456", ORG_GH_API: ghUrl(),
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const calls = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_call");
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0])).toContain("issue_list");
    const results = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result");
    // 观测摘要面：count=2 + repo（数据完整回灌给模型，事件里是人读摘要）
    expect(JSON.stringify(results[0])).toContain("issue_list ok count=2");
    expect(JSON.stringify(results[0])).toContain("acme/widget");
    // 会话账本落最终答案（模型消费了工具结果）
    const ledger = fs.readFileSync(path.join(WS, "runtime/sessions/notice-parser/tracker-e2e.jsonl"), "utf-8");
    expect(ledger).toContain("DevTools 常驻会话");
  }, 120_000);

  test("issue_create 工具：只读模式（ORG_TOOLS=1）明确拒绝 + 写档需审批的口径", async () => {
    const fixture = path.join(TEST_RUN, "tracker-fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({
      tracks: {
        "direct:notice-parser": [
          '<tool>{"name":"issue_create","args":{"repo":"acme/widget","title":"x"}}</tool>',
          "最终答案：只读模式不能建 issue。",
        ],
      },
    }, null, 2));
    const out = path.join(TEST_RUN, "out-tracker", "ro");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = await runDhvAsync([
      "run", DIRECT,
      "--workspace", WS,
      "--task", "(direct) 建个工单",
      "--model", "scripted",
      "--fixture", fixture,
      "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "tracker-ro",
      ORG_ASK_QUESTION: "建个工单", ORG_TOOLS: "1",
      ORG_GH_TOKEN: "ghp_tool_test_123456", ORG_GH_API: ghUrl(),
    });
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const denied = events.filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_denied");
    expect(denied.length).toBe(1); // 写动作：只读模式拦截（mock 网关零外发）
    expect(requests.length).toBe(0);
  }, 120_000);
});
