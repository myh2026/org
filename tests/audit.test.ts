// ============================================================================
// tests/audit.test.ts — 审计导出（v0.5.15 · capabilities #150 隐私模式/审计导出）
// ----------------------------------------------------------------------------
// 锁定面：
//   1. exportAudit 全量：zip 存在 · entries 精确 · bytes>0 · report.md 含
//      run 一行表；指定 run（opts.run）只带该 run + 全局台账（zip 字节里
//      出现/缺席 entry 名 —— store 零压缩下名字是明文，可零依赖断言）
//   2. zip 容器跨实现校验：python3 zipfile.testzip()（缺席则跳过 —— 与
//      tests/ruff.test.ts findRuff 同哲学：CI 侧已装，本地裸跑不假红）
//   3. 降级诚实：空工作区 ok:true + warnings 非空；run 不存在 → 警告不炸
//   4. auditSummary 聚合数（events/tokens/ok/approvals/ledgerEntries）
//   5. 文件名纪律：时间戳格式 · 同秒重复导出加序号不覆盖 · 自定义 out
// ============================================================================
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportAudit, auditSummary } from "../lib/audit.ts";

/** 播种一个 run 目录（七件套按 skip 裁剪；事件 ts 用 tsBase+i 保证全局时间范围可断言）。 */
function seedRun(
  ws: string,
  name: string,
  o: { events?: number; journal?: number; tokens?: number; ok?: boolean; tsBase?: string; skip?: string[] } = {},
): void {
  const dir = path.join(ws, name);
  fs.mkdirSync(dir, { recursive: true });
  const skip = new Set(o.skip ?? []);
  const events = o.events ?? 3;
  const tsBase = o.tsBase ?? "2026-09-15T15:06:1";
  if (!skip.has("events.jsonl")) {
    const lines: string[] = [];
    for (let i = 0; i < events; i++) {
      lines.push(JSON.stringify({ seq: i, ts: `${tsBase}${i}.000Z`, name: "step", data: {} }));
    }
    fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");
  }
  if (!skip.has("journal.jsonl")) {
    const j = o.journal ?? 2;
    const lines: string[] = [];
    for (let i = 0; i < j; i++) lines.push(JSON.stringify({ seq: i, name: "patch", ts: `${tsBase}${i}.000Z` }));
    fs.writeFileSync(path.join(dir, "journal.jsonl"), lines.join("\n") + "\n");
  }
  if (!skip.has("llm-stream.jsonl")) {
    fs.writeFileSync(path.join(dir, "llm-stream.jsonl"), JSON.stringify({ role: "assistant", ts: `${tsBase}0.000Z` }) + "\n");
  }
  if (!skip.has("run.json")) {
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({ ts: `${tsBase}0.000Z`, ok: o.ok ?? true, elapsed_ms: 649, model: "scripted", task: "t", events }, null, 2) + "\n",
    );
  }
  if (!skip.has("metrics.json")) {
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify({ tokens_total: o.tokens ?? 480, model_calls_total: 5 }, null, 2) + "\n");
  }
  if (!skip.has("report.md")) {
    fs.writeFileSync(path.join(dir, "report.md"), "# 运行报告\n\n本次运行产出了三份公告表格。\n");
  }
  if (!skip.has("scorecard.json")) {
    fs.writeFileSync(path.join(dir, "scorecard.json"), JSON.stringify({ pass: true, score: 0.92 }, null, 2) + "\n");
  }
}

/** 标准审计床：out-a（全七件套，ok）+ out-b（缺 run.json → ok:null）+ 审批 4 文件 + 台账 2 行。 */
function makeAuditWs(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "org-audit-test-"));
  seedRun(ws, "out-a", { events: 3, journal: 2, tokens: 480, ok: true, tsBase: "2026-09-15T15:06:1" });
  seedRun(ws, "out-b", { events: 2, journal: 0, tokens: 120, skip: ["run.json"], tsBase: "2026-09-15T15:07:2" });
  fs.mkdirSync(path.join(ws, "runtime", "approvals"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "runtime", "approvals", "ap-1.json"),
    JSON.stringify({
      id: "ap-1", capability: "fs_write", action: "write", detail: "report.md",
      ts: "2026-09-15T15:06:11.000Z", timeout_ms: 60000,
      resolved: { allow: true, always: false, by: "user", ts: "2026-09-15T15:06:12.000Z", waited_ms: 900 },
    }) + "\n",
  );
  fs.writeFileSync(
    path.join(ws, "runtime", "approvals", "ap-2.json"),
    JSON.stringify({ id: "ap-2", capability: "bash", action: "grep", detail: "raw/", ts: "2026-09-15T15:06:12.000Z", timeout_ms: 60000 }) + "\n",
  );
  fs.writeFileSync(path.join(ws, "runtime", "approvals", "ap-1.reply.json"), ""); // 瞬时回复通道（空）
  fs.writeFileSync(path.join(ws, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["fs_read"] }) + "\n");
  fs.writeFileSync(
    path.join(ws, "runtime", "llm-ledger.jsonl"),
    [
      JSON.stringify({ ts: "2026-09-15T15:06:10.500Z", key: "sk-…f3a1", status: "ok", ms: 210, tokens: 300 }),
      JSON.stringify({ ts: "2026-09-15T15:06:11.800Z", key: "sk-…f3a1", status: "ok", ms: 350, tokens: 180 }),
    ].join("\n") + "\n",
  );
  return ws;
}

let WS: string;

beforeEach(() => {
  WS = makeAuditWs();
});

afterEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

/** python3 探测（缺席 → null，调用方跳过 —— ruff.test.ts findRuff 同哲学）。 */
function findPython3(): string | null {
  const cands = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  for (const c of cands) {
    try {
      const r = Bun.spawnSync([c, "--version"], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0) return c;
    } catch {
      // 下一个候选
    }
  }
  return null;
}

// ---- 1. 导出主路径 -----------------------------------------------------------

describe("审计导出：exportAudit", () => {
  test("全量导出：zip 存在、entries 精确（2 run 七件套 + 审批 4 + 台账 1）、report 含 run 表", () => {
    const r = exportAudit(WS);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.zip)).toBe(true);
    expect(r.entries).toBe(18); // out-a 7 + out-b 6 + approvals 4 + ledger 1
    expect(r.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(r.report)).toBe(true);
    const md = fs.readFileSync(r.report, "utf-8");
    expect(md).toContain("| out-a | 3 | 480 | ok |");
    expect(md).toContain("| out-b | 2 | 120 | — |"); // run.json 缺席 → ok:null → "—"
  }, 30_000);

  test("zip 完整性：python3 zipfile.testzip() 跨实现校验 + entry 名 + 内容回读一致（缺席 python3 则跳过）", () => {
    const py = findPython3();
    if (!py) {
      console.log("(python3 未安装 —— 跳过跨实现校验，CI 侧已装)");
      return;
    }
    const r = exportAudit(WS);
    expect(r.ok).toBe(true);
    const script = [
      "import zipfile, sys",
      "z = zipfile.ZipFile(sys.argv[1])",
      "print('CRC:' + (z.testzip() or 'OK'))",
      "names = z.namelist()",
      "print('HAS_A:' + str('out-a/events.jsonl' in names))",
      "print('FIRST:' + z.read('out-a/events.jsonl').decode().splitlines()[0])",
    ].join("\n");
    const p = Bun.spawnSync([py, "-c", script, r.zip], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out).toContain("CRC:OK");
    expect(out).toContain("HAS_A:True");
    expect(out).toContain('FIRST:{"seq":0');
  }, 30_000);

  test("指定 run（opts.run=\"out-a\"）：entries 只含 out-a 七件套 + 全局台账（无 out-b）", () => {
    const r = exportAudit(WS, { run: "out-a" });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(12); // out-a 7 + approvals 4 + ledger 1
    const buf = fs.readFileSync(r.zip); // store 零压缩 → entry 名是明文，可零依赖断言
    expect(buf.indexOf("out-a/events.jsonl")).toBeGreaterThanOrEqual(0);
    expect(buf.indexOf("out-b/")).toBe(-1);
  }, 30_000);

  test("空工作区：ok:true + entries:0 + warnings 非空（诚实）+ 0 条目 zip 仍写出", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "org-audit-empty-"));
    try {
      const r = exportAudit(empty);
      expect(r.ok).toBe(true);
      expect(r.entries).toBe(0);
      expect(r.bytes).toBeGreaterThan(0); // EOCD-only zip 仍有 22 字节
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(r.warnings.some((w) => w.includes("out-*"))).toBe(true);
      expect(fs.existsSync(r.zip)).toBe(true);
      expect(fs.existsSync(r.report)).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }, 30_000);

  test("run 目录不存在：不炸，警告点名缺席 run，仍导出全局台账", () => {
    const r = exportAudit(WS, { run: "out-zzz" });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("out-zzz"))).toBe(true);
    expect(r.entries).toBe(5); // approvals 4 + ledger 1（run 面为空）
    expect(fs.existsSync(r.zip)).toBe(true);
  }, 30_000);

  test("全局台账面（llm-pool/notifications/git-chain）存在时纳入导出", () => {
    fs.writeFileSync(
      path.join(WS, "runtime", "llm-pool.json"),
      JSON.stringify({ keys: [{ fp: "sk-…f3a1", cooldown_until: null }] }),
    );
    fs.writeFileSync(path.join(WS, "runtime", "notifications.json"), JSON.stringify({ sent: 3 }));
    fs.mkdirSync(path.join(WS, "registry"), { recursive: true });
    fs.writeFileSync(path.join(WS, "registry", "git-chain.json"), JSON.stringify({ captured_at: "2026-09-15T15:07:30.000Z", commits: [] }));
    const r = exportAudit(WS);
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(21); // 18 + 3 全局面
    const buf = fs.readFileSync(r.zip);
    expect(buf.indexOf("runtime/llm-pool.json")).toBeGreaterThanOrEqual(0);
    expect(buf.indexOf("registry/git-chain.json")).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

// ---- 2. 摘要与文件名纪律 ------------------------------------------------------

describe("审计导出：auditSummary 与文件名纪律", () => {
  test("auditSummary 聚合：run 明细（events/tokens/ok）+ 审批数（granted/reply 不计）+ 台账条目", () => {
    const s = auditSummary(WS);
    expect(s.runs).toEqual([
      { name: "out-a", events: 3, tokens: 480, ok: true },
      { name: "out-b", events: 2, tokens: 120, ok: null }, // run.json 缺席 → null（不猜）
    ]);
    expect(s.approvals).toBe(2); // ap-1 + ap-2（granted.json / *.reply.json 不计）
    expect(s.ledgerEntries).toBe(2);
  }, 30_000);

  test("report 摘要聚合：事件总数 / token 总量 / 审批 / 台账 / 时间范围", () => {
    const r = exportAudit(WS);
    const md = fs.readFileSync(r.report, "utf-8");
    expect(md).toContain("| run 数 | 2 |");
    expect(md).toContain("| 事件总数 | 5 |");
    expect(md).toContain("| token 总量 | 600 |");
    expect(md).toContain("| 审批记录 | 2 |");
    expect(md).toContain("| LLM 台账条目 | 2 |");
    expect(md).toContain("2026-09-15T15:06:10.000Z"); // 时间范围起点
    expect(md).toContain("2026-09-15T15:07:21.000Z"); // 时间范围终点
  }, 30_000);

  test("缺省文件名格式：audit-export-<yyyymmdd-hhmmss>.zip + 同名 .md", () => {
    const r = exportAudit(WS);
    expect(path.basename(r.zip)).toMatch(/^audit-export-\d{8}-\d{6}\.zip$/);
    expect(r.report).toBe(r.zip.replace(/\.zip$/, ".md"));
  }, 30_000);

  test("重复导出不覆盖：同秒加序号（-2、-3…），两个产物都在", () => {
    const r1 = exportAudit(WS);
    const r2 = exportAudit(WS);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.zip).not.toBe(r1.zip);
    expect(fs.existsSync(r1.zip)).toBe(true);
    expect(fs.existsSync(r2.zip)).toBe(true);
    if (path.basename(r1.zip).slice(0, -4) === path.basename(r2.zip).slice(0, -4).replace(/-\d+$/, "")) {
      // 同秒：第二个必须带序号
      expect(path.basename(r2.zip)).toMatch(/^audit-export-\d{8}-\d{6}-\d+\.zip$/);
    }
  }, 30_000);

  test("自定义 out：写到指定路径（含子目录自动建），report 为相邻同名 .md", () => {
    const out = path.join(WS, "custom", "my-audit.zip");
    const r = exportAudit(WS, { out });
    expect(r.ok).toBe(true);
    expect(r.zip).toBe(path.resolve(out));
    expect(fs.existsSync(r.zip)).toBe(true);
    expect(r.report).toBe(path.resolve(out).replace(/\.zip$/, ".md"));
    expect(fs.existsSync(r.report)).toBe(true);
  }, 30_000);
});
