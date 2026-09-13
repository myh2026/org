// ============================================================================
// tests/v055.test.ts — 定时触发器 / webhook 出站 / key 池冷却 / 预算水位（v0.5.5）
// ============================================================================
// 覆盖面：
//   1. cron 表达式：五段解析（* / */n / a-b / a,b / dow 7 归一）+ @every +
//      非法形态如实拒绝
//   2. nextAfter 语义：整点 / 跨天 / 跨月 / 2 月边界 / dow 命中 / 366 天无
//      命中（2 月 30 日）—— UTC 基准确定性断言
//   3. 文件协议：add → list（排序确定性）→ on/off → rm；坏文件宽容；
//      invalid 表达式如实标注不炸
//   4. 到期领取：过期 → 触发一次 + runs+1 + next_run 推进；二次领取空
//      （防双发）；misfire=skip 跳过 / run 补跑；disabled 不触发
//   5. TaskRunner 挂载：过期 schedule → 执行器启动 → 自动入队（e2e 前
//      半段：提交即断言，不等完整执行）
//   6. webhook：mock 服务收包（payload 契约）/ off / 事件过滤 / 坏 URL
//      失败静默
//   7. key 池：429 进冷却（跨进程文件）/ 4xx 只记状态 / 成功清零 /
//      cooldownMs 档位 / poolView 渲染
//   8. 预算水位：budget_watermarks 三端统一口径（used/remaining/exceeded）
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_RUN, makeWorkspace } from "./helpers";
import {
  parseExpr, nextAfter, previewNext,
  addSchedule, listSchedules, removeSchedule, setScheduleEnabled, dueSchedules,
  type ScheduleRecord,
} from "../lib/schedule.ts";
import { webhookNotify, notifyEvent, type Notification } from "../lib/notify.ts";
import {
  recordKeyFailure, recordKeyOk, readPool, poolView, budgetWatermark,
} from "../lib/router.ts";
import { TaskRunner, listTasks } from "../lib/tasks.ts";
import { setConfigValue, loadConfig } from "../lib/config.ts";

const WS = path.join(TEST_RUN, "v055-ws");

// ---- 基础设施：临时配置 + 环境卫生（与 providers.test.ts 同模式） --------------

const tmpDir = fs.mkdtempSync("/tmp/org-v055-test-");
const cfgFile = path.join(tmpDir, "config.json");

const SAVED: Record<string, string | undefined> = {};
const ENV_VARS = [
  "ORG_CONFIG", "DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL",
  "DHV_LLM_THINKING", "DHV_LLM_TIMEOUT_MS", "ORG_DEFAULT_MODEL",
];

beforeEach(() => {
  for (const v of ENV_VARS) SAVED[v] = process.env[v];
  process.env.ORG_CONFIG = cfgFile;
  if (fs.existsSync(cfgFile)) fs.rmSync(cfgFile);
  fs.rmSync(WS, { recursive: true, force: true });
});

afterEach(() => {
  for (const v of ENV_VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v]!;
  }
  fs.rmSync(WS, { recursive: true, force: true });
});

/** 手工把 schedule 的 next_run 写到过去（模拟休眠后错过的场景）。 */
function forcePast(ws: string, id: string, pastMs: number): void {
  const file = path.join(ws, "runtime", "schedules", `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as ScheduleRecord;
  raw.next_run = new Date(Date.now() - pastMs).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

// ---- 1. 表达式解析 --------------------------------------------------------------

describe("schedule：表达式解析", () => {
  test("五段 cron 各形态（* / 步进 / 范围 / 列表 / dow 7 归一）", () => {
    const every15 = parseExpr("*/15 9-17 * * 1-5");
    expect(every15?.kind).toBe("cron");
    if (every15?.kind === "cron") {
      expect([...every15.fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
      expect(every15.fields.hour.size).toBe(9); // 9..17
      expect(every15.fields.domStar).toBe(true);
      expect(every15.fields.dow.has(1)).toBe(true);
      expect(every15.fields.dow.has(5)).toBe(true);
    }
    const list = parseExpr("0,30 12 * * *");
    if (list?.kind === "cron") {
      expect([...list.fields.minute]).toEqual([0, 30]);
    }
    // dow 7 归一为 0（周日）
    const dow7 = parseExpr("0 0 * * 7");
    if (dow7?.kind === "cron") {
      expect(dow7.fields.dow.has(0)).toBe(true);
      expect(dow7.fields.dow.has(7)).toBe(false);
    }
  });

  test("@every 简化式（s/m/h/d）与非法形态", () => {
    expect(parseExpr("@every 30m")?.kind).toBe("every");
    if (parseExpr("@every 30m")?.kind === "every") {
      expect((parseExpr("@every 30m") as { ms: number }).ms).toBe(30 * 60_000);
    }
    expect((parseExpr("@every 2h") as { ms: number }).ms).toBe(7_200_000);
    expect((parseExpr("@every 1d") as { ms: number }).ms).toBe(86_400_000);
    // 非法：段数错 / 越界 / 未知 @ 形式 / 负数
    expect(parseExpr("* * * *")).toBeNull();
    expect(parseExpr("60 * * * *")).toBeNull();
    expect(parseExpr("* 24 * * *")).toBeNull();
    expect(parseExpr("@daily")).toBeNull();
    expect(parseExpr("@every 0m")).toBeNull();
    expect(parseExpr("@every 5x")).toBeNull();
    expect(parseExpr("*/0 * * * *")).toBeNull();
  });
});

// ---- 2. nextAfter 语义 ----------------------------------------------------------

describe("schedule：nextAfter（UTC 确定性）", () => {
  const D = (s: string): Date => new Date(s + "Z");

  test("整点推进：10:30 当下已过档 → 下一档 10:45", () => {
    const n = nextAfter("*/15 * * * *", D("2026-07-01T10:30:00"));
    expect(n?.toISOString()).toBe("2026-07-01T10:45:00.000Z");
  });

  test("跨小时：10:50 → 11:00", () => {
    const n = nextAfter("*/15 * * * *", D("2026-07-01T10:50:00"));
    expect(n?.toISOString()).toBe("2026-07-01T11:00:00.000Z");
  });

  test("时窗限定：17:00 后跳到次日 09:00（工作日）", () => {
    const n = nextAfter("0 9-17 * * 1-5", D("2026-07-01T18:00:00")); // 周三
    expect(n?.toISOString()).toBe("2026-07-02T09:00:00.000Z");
  });

  test("周末跳到周一（dow 生效）", () => {
    const sat = nextAfter("0 9 * * 1-5", D("2026-07-04T10:00:00")); // 周六
    expect(sat?.getUTCDay()).toBe(1); // 周一
    expect(sat?.toISOString()).toBe("2026-07-06T09:00:00.000Z");
  });

  test("跨月：1 月 31 日 23:59 → 2 月 1 日 00:00", () => {
    const n = nextAfter("0 0 * * *", D("2026-01-31T23:59:00"));
    expect(n?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  test("2 月 30 日：366 天无命中 → null（不死循环）", () => {
    expect(nextAfter("0 0 30 2 *", D("2026-01-01T00:00:00"))).toBeNull();
  });

  test("@every：from + ms 直推", () => {
    const n = nextAfter("@every 30m", D("2026-07-01T10:00:00"));
    expect(n?.toISOString()).toBe("2026-07-01T10:30:00.000Z");
  });

  test("previewNext：连续触发点推进", () => {
    const out = previewNext("0 9 * * *", D("2026-07-01T10:00:00"), 3);
    expect(out.length).toBe(3);
    expect(out[0]?.toISOString()).toBe("2026-07-02T09:00:00.000Z");
    expect(out[2]?.toISOString()).toBe("2026-07-04T09:00:00.000Z");
  });
});

// ---- 3. 文件协议 ----------------------------------------------------------------

describe("schedule：文件协议", () => {
  test("add → list（排序确定性）→ rm", () => {
    const a = addSchedule(WS, "@every 1h", "run", { task: "每小时巡检", model: "scripted" });
    const b = addSchedule(WS, "*/5 * * * *", "ask", { expert: "pm", question: "状态？", model: "scripted" });
    const list = listSchedules(WS);
    expect(list.length).toBe(2);
    expect(list.map((s) => s.id)).toContain(a.id);
    expect(list.map((s) => s.id)).toContain(b.id);
    // 排序确定性：next_run 升序（同毫秒 id 兜底）
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      expect(prev.next_run < cur.next_run || (prev.next_run === cur.next_run && prev.id < cur.id)).toBe(true);
    }
    expect(removeSchedule(WS, a.id)).toBe(true);
    expect(listSchedules(WS).length).toBe(1);
    expect(() => removeSchedule(WS, "t-bad/id")).toThrow(); // 非法 id 防注入
  });

  test("必填校验 + invalid 表达式如实标注（不炸不扔）", () => {
    expect(() => addSchedule(WS, "@daily", "run", { task: "x", model: "scripted" })).not.toThrow();
    const s = addSchedule(WS, "@daily", "run", { task: "x", model: "scripted" });
    expect(s.invalid).toBeTruthy();
    expect(() => addSchedule(WS, "* * * *", "run", { task: "", model: "scripted" })).toThrow("task");
    expect(() => addSchedule(WS, "* * * *", "ask", { expert: "", question: "q", model: "scripted" })).toThrow("expert");
    // invalid 条目不参与到期判定
    const due = dueSchedules(WS);
    expect(due.due.length).toBe(0);
  });

  test("on/off：停用不触发；重新启用 next_run 从当下重算", () => {
    const s = addSchedule(WS, "@every 10m", "run", { task: "x", model: "scripted" });
    const off = setScheduleEnabled(WS, s.id, false);
    expect(off?.enabled).toBe(false);
    forcePast(WS, s.id, 20 * 60_000);
    expect(dueSchedules(WS).due.length).toBe(0); // 停用不触发
    const on = setScheduleEnabled(WS, s.id, true);
    expect(on?.enabled).toBe(true);
    // 重算的 next_run 在未来（10 分钟内）
    expect(Date.parse(on!.next_run)).toBeGreaterThan(Date.now());
    expect(Date.parse(on!.next_run)).toBeLessThan(Date.now() + 11 * 60_000);
  });

  test("坏文件宽容（列表不炸）", () => {
    const dir = path.join(WS, "runtime", "schedules");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s-bad-1.json"), "not json{");
    fs.writeFileSync(path.join(dir, "s-bad-2.json"), JSON.stringify({ nope: 1 }));
    expect(listSchedules(WS).length).toBe(0);
  });
});

// ---- 4. 到期领取（防双发 + misfire） --------------------------------------------

describe("schedule：到期领取", () => {
  test("过期 → 触发一次 + runs+1 + next_run 推进；二次领取空（防双发）", () => {
    const s = addSchedule(WS, "@every 1h", "run", { task: "x", model: "scripted" });
    forcePast(WS, s.id, 90_000); // 过去 90s（< 2min 容差：正常触发而非 misfire）
    const r1 = dueSchedules(WS);
    expect(r1.due.length).toBe(1);
    expect(r1.due[0]!.id).toBe(s.id);
    expect(r1.due[0]!.runs).toBe(1);
    // next_run 已推进到未来
    expect(Date.parse(r1.due[0]!.next_run)).toBeGreaterThan(Date.now());
    // 立即二次领取（并发窗口兜底）→ 空
    const r2 = dueSchedules(WS);
    expect(r2.due.length).toBe(0);
  });

  test("misfire=skip：迟到超容差 → 跳过本周期（不入队）", () => {
    const s = addSchedule(WS, "@every 1h", "run", { task: "x", model: "scripted" }, { misfire: "skip" });
    forcePast(WS, s.id, 30 * 60_000); // 迟到 30 分钟 > 2min 容差
    const r = dueSchedules(WS);
    expect(r.due.length).toBe(0);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.id).toBe(s.id);
    // next_run 推进了（下周期有效）
    const after = listSchedules(WS).find((x) => x.id === s.id);
    expect(Date.parse(after!.next_run)).toBeGreaterThan(Date.now());
  });

  test("misfire=run：迟到仍补跑一次", () => {
    const s = addSchedule(WS, "@every 1h", "run", { task: "x", model: "scripted" }, { misfire: "run" });
    forcePast(WS, s.id, 30 * 60_000);
    const r = dueSchedules(WS);
    expect(r.due.length).toBe(1);
    expect(r.due[0]!.runs).toBe(1);
  });

  test("journal 审计落盘（fired 事件）", () => {
    const s = addSchedule(WS, "@every 1h", "run", { task: "x", model: "scripted" });
    forcePast(WS, s.id, 90_000);
    dueSchedules(WS);
    const jf = path.join(WS, "runtime", "schedules", `${s.id}.journal.jsonl`);
    expect(fs.existsSync(jf)).toBe(true);
    const lines = fs.readFileSync(jf, "utf-8").trim().split("\n");
    expect(lines.some((l) => l.includes("|fired|"))).toBe(true);
  });
});

// ---- 5. TaskRunner 挂载（e2e 前半段：入队即断言） ------------------------------

describe("schedule：TaskRunner 挂载（执行器 = 定时能力）", () => {
  test("过期 schedule → runner.start() 立即领取 → 任务入队", async () => {
    makeWorkspace(WS); // demo 工作区（scripted 车道可执行）
    const s = addSchedule(WS, "@every 1h", "run", { task: "定时巡检：读取注册表并汇报", model: "scripted" });
    forcePast(WS, s.id, 90_000);
    const runner = new TaskRunner(WS, { concurrency: 1 });
    expect(runner.acquireLock()).toBe(true);
    runner.start();
    // checkSchedules 立即跑 + submitTask 同步 → 轮询等入队（不等完整执行）
    let queued: unknown = null;
    for (let i = 0; i < 40; i++) {
      const hit = listTasks(WS).find((t) => t.status === "queued" || t.status === "running");
      if (hit) { queued = hit; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    runner.stop();
    runner.releaseLock();
    expect(queued).not.toBeNull();
    const t = queued as { spec: { task: string } };
    expect(t.spec.task).toContain("定时巡检");
    // schedule 的 runs 已推进 + next_run 在未来
    const after = listSchedules(WS).find((x) => x.id === s.id);
    expect(after!.runs).toBe(1);
    expect(Date.parse(after!.next_run)).toBeGreaterThan(Date.now());
  }, 30_000);
});

// ---- 6. webhook 出站 -------------------------------------------------------------

describe("notify：webhook 出站", () => {
  const mkNotification = (): Notification => ({
    id: "n-test-1", kind: "task_done", title: "任务完成", detail: "t-xx 已完成",
    ts: new Date().toISOString(), read: false, taskId: "t-xx",
  });

  test("off：未配置 URL → 直接 off", async () => {
    const r = await webhookNotify(mkNotification());
    expect(r.status).toBe("off");
  });

  test("sent：mock 服务收包 + payload 契约", async () => {
    const received: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push(await req.json());
        return Response.json({ ok: true });
      },
    });
    setConfigValue("notify_webhook_url", `http://127.0.0.1:${server.port}/hook`);
    const r = await webhookNotify(mkNotification());
    expect(r.status).toBe("sent");
    expect(received.length).toBe(1);
    const body = received[0] as Record<string, unknown>;
    expect(body.source).toBe("org");
    expect(body.event).toBe("task_done");
    expect(body.title).toBe("任务完成");
    expect(body.taskId).toBe("t-xx");
    server.stop(true);
  });

  test("filtered：事件过滤命中才发", async () => {
    const received: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => { received.push(await req.json()); return Response.json({ ok: true }); },
    });
    setConfigValue("notify_webhook_url", `http://127.0.0.1:${server.port}/hook`);
    setConfigValue("notify_webhook_events", "approval_requested,task_failed");
    const r = await webhookNotify(mkNotification()); // kind=task_done 不在白名单
    expect(r.status).toBe("filtered");
    expect(received.length).toBe(0);
    server.stop(true);
  });

  test("failed：坏 URL 失败静默（返回 failed 不 throw）", async () => {
    setConfigValue("notify_webhook_url", "http://127.0.0.1:1/nope"); // 不可达端口
    const r = await webhookNotify(mkNotification());
    expect(r.status).toBe("failed");
  });

  test("notifyEvent 集成：webhook fire-and-forget 不阻塞不炸", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ ok: true }),
    });
    setConfigValue("notify_webhook_url", `http://127.0.0.1:${server.port}/hook`);
    makeWorkspace(WS);
    const t0 = Date.now();
    notifyEvent(WS, "custom", "标题", "详情", { desktop: false });
    expect(Date.now() - t0).toBeLessThan(500); // 未 await 出站，毫秒级返回
    // 存储照常落地（webhook 不影响写入）
    expect(fs.existsSync(path.join(WS, "runtime", "notifications.json"))).toBe(true);
    server.stop(true);
  });
});

// ---- 7. key 池冷却 --------------------------------------------------------------

describe("router：key 池状态落盘（跨进程冷却）", () => {
  test("429 进冷却（60s 档）+ poolView 渲染", () => {
    makeWorkspace(WS);
    recordKeyFailure(WS, "deepseek", "k1(sk-…x1)", "429");
    const pool = readPool(WS);
    expect(pool.deepseek?.["k1(sk-…x1)"]?.fails).toBe(1);
    expect(pool.deepseek?.["k1(sk-…x1)"]!.until).toBeGreaterThan(Date.now());
    const view = poolView(WS, "deepseek");
    expect(view.length).toBe(1);
    expect(view[0]!.keys[0]!.cooling).toBe(true);
    expect(view[0]!.keys[0]!.last_status).toBe("429");
  });

  test("4xx 不冷却（只记状态）；timeout 进冷却", () => {
    makeWorkspace(WS);
    recordKeyFailure(WS, "deepseek", "k1(sk-…x1)", "401");
    let pool = readPool(WS);
    expect(pool.deepseek?.["k1(sk-…x1)"]?.fails).toBe(0);
    expect(pool.deepseek?.["k1(sk-…x1)"]!.until).toBe(0); // 不冷却
    recordKeyFailure(WS, "deepseek", "k1(sk-…x1)", "timeout");
    pool = readPool(WS);
    expect(pool.deepseek?.["k1(sk-…x1)"]?.fails).toBe(1);
    expect(pool.deepseek?.["k1(sk-…x1)"]!.until).toBeGreaterThan(Date.now());
  });

  test("连续失败档位放大（60s → 120s → 封顶 300s）", () => {
    makeWorkspace(WS);
    for (let i = 1; i <= 6; i++) {
      recordKeyFailure(WS, "deepseek", "k1(sk-…x1)", "429");
      const s = readPool(WS).deepseek?.["k1(sk-…x1)"];
      expect(s?.fails).toBe(i);
      if (i <= 5) expect(s!.until - Date.now()).toBeGreaterThan(60_000 * i - 2_000);
    }
    const s = readPool(WS).deepseek?.["k1(sk-…x1)"];
    expect(s!.until - Date.now()).toBeLessThanOrEqual(300_000 + 100);
  });

  test("成功清零 + 空池零写盘", () => {
    makeWorkspace(WS);
    recordKeyFailure(WS, "deepseek", "k1(sk-…x1)", "429");
    const before = readPool(WS);
    expect(before.deepseek?.["k1(sk-…x1)"]?.fails).toBe(1);
    recordKeyOk(WS, "deepseek", "k1(sk-…x1)");
    expect(readPool(WS).deepseek).toBeUndefined(); // 清干净（空 lane 整体删除）
    // 无状态时成功调用零写盘：池已空，再调 recordKeyOk 不重建文件内容
    recordKeyOk(WS, "deepseek", "k1(sk-…x1)");
    expect(readPool(WS).deepseek).toBeUndefined();
  });

  test("坏池文件宽容（空对象不炸）", () => {
    makeWorkspace(WS);
    const file = path.join(WS, "runtime", "llm-pool.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-json{", "utf-8");
    expect(readPool(WS)).toEqual({});
    expect(poolView(WS).length).toBe(0);
  });
});

// ---- 8. 预算水位 ----------------------------------------------------------------

describe("router：预算水位（三端统一口径）", () => {
  test("未配置 → budget=0（不渲染）", () => {
    makeWorkspace(WS);
    const wm = budgetWatermark(WS);
    expect(wm.budget).toBe(0);
    expect(wm.exceeded).toBe(false);
  });

  test("配置 + 当日台账 → used/remaining/exceeded", () => {
    makeWorkspace(WS);
    setConfigValue("budget_requests", "3");
    const today = new Date().toISOString().slice(0, 10);
    const ledger = path.join(WS, "runtime", "llm-ledger.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    const entry = (ts: string, status: string): string =>
      JSON.stringify({ ts, lane: "deepseek", upstream: "api.deepseek.com", key_id: "k1", model: "m", stream: false, status, ms: 100 });
    fs.appendFileSync(ledger, entry(`${today}T01:00:00.000Z`, "ok") + "\n");
    fs.appendFileSync(ledger, entry(`${today}T02:00:00.000Z`, "ok") + "\n");
    fs.appendFileSync(ledger, entry(`${today}T03:00:00.000Z`, "429") + "\n"); // 失败不计
    fs.appendFileSync(ledger, entry("2020-01-01T00:00:00.000Z", "ok") + "\n"); // 非当日不计
    const wm = budgetWatermark(WS);
    expect(wm.budget).toBe(3);
    expect(wm.used).toBe(2);
    expect(wm.remaining).toBe(1);
    expect(wm.exceeded).toBe(false);
    fs.appendFileSync(ledger, entry(`${today}T04:00:00.000Z`, "ok") + "\n");
    const wm2 = budgetWatermark(WS);
    expect(wm2.used).toBe(3);
    expect(wm2.exceeded).toBe(true);
    expect(wm2.remaining).toBe(0);
  });
});

// ---- 9. config 新键 -------------------------------------------------------------

describe("config：webhook 键（v0.5.5）", () => {
  test("set/get + 别名归一 + 老文件前向兼容", () => {
    expect(setConfigValue("webhook_url", "https://example.com/hook")).toBe("notify_webhook_url");
    expect(loadConfig().notify_webhook_url).toBe("https://example.com/hook");
    expect(setConfigValue("webhook_events", "task_done, task_failed")).toBe("notify_webhook_events");
    // 存储原样（trim 外围空白）；读取侧 webhookNotify split+trim 宽容解析
    expect(loadConfig().notify_webhook_events).toBe("task_done, task_failed");
    // 老配置文件（无新键）→ 空串缺省
    fs.rmSync(cfgFile);
    expect(loadConfig().notify_webhook_url).toBe("");
  });
});
