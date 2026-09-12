// ============================================================================
// tests/keep.test.ts — 工具库治理（用户选取保留）机制级测试
// ----------------------------------------------------------------------------
// 覆盖「org keep / org drop」的完整语义：
//   1. 数据面：retained 翻转落盘（index.json + 每专家副本）+ git 留痕
//   2. 路由面：候选（未保留）不参与 B 路径自动复用 → 路由 C 生成（记忆化）
//   3. 转正面：keep 后 B 路径恢复命中（channel=reuse）
//   4. 反悔面：drop 后 B 路径再次失联
//   5. 防呆面：未知名报错、无参用法、dist/demo 只读守卫
// ============================================================================
// 端到端用例超时：本文件每个用例都真实 spawn 一次解释器跑完整监督回路（实测单轮
// 3–14s），而 bun 的默认每用例超时是 5000ms。全局手段都不可用（bunfig 的 [test]
// 段无 timeout 键；[test] preload 与 setDefaultTimeout 在多文件并行 worker 模式下
// 都不生效 —— 详见 tests/helpers.ts 的说明），故逐例显式声明 120_000，
// 与 tests/demo.test.ts 既有写法一致。放宽的是等待上限，不是断言标准。

import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  ROOT, TEST_RUN, runOrg, runOrgRun, makeWorkspace, eventsOf, journalEvents,
  readJson, exists,
} from "./helpers";

const TASK = "抓取某站点近一周公告，输出结构化表格";

/** 铸一个候选专家（run A）并返回工作区。 */
function mintedWorkspace(name: string): string {
  const ws = makeWorkspace(name);
  const a = runOrgRun(ws, path.join(ws, "out-a"));
  if (!a.ok) console.error(a.stdout + a.stderr);
  expect(a.ok).toBe(true);
  return ws;
}

function readManifest(ws: string, name: string): Record<string, unknown> {
  return readJson(path.join(ws, "registry", `${name}.json`));
}

function retainedOf(ws: string, name: string): boolean | undefined {
  const idx = readJson(path.join(ws, "registry/index.json")) as Array<Record<string, unknown>>;
  const hit = idx.find((m) => m.name === name);
  return hit ? Boolean(hit.retained) : undefined;
}

function gitLog(ws: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", ws, "log", "--oneline", "--all"], { stdout: "pipe" });
  return proc.stdout.toString().split("\n").filter((l) => l.trim().length > 0);
}

describe("工具库治理：keep / drop 数据面", () => {
  test("run A 铸出的候选 retained=false（工厂产物默认候选，不自动复用）", () => {
    const ws = mintedWorkspace("keep-data");
    expect(retainedOf(ws, "record-validator")).toBe(false);
    expect(readManifest(ws, "record-validator").retained).toBe(false);
    // manual 存量资产不受影响
    expect(retainedOf(ws, "notice-parser")).toBe(true);
  }, 120_000);

  test("keep 翻转 retained + git 留痕（user curation 与 mint/patch 同链）", () => {
    const ws = mintedWorkspace("keep-flip");
    const r = runOrg(["keep", "record-validator", "--workspace", ws]);
    expect(r.ok).toBe(true);
    expect(retainedOf(ws, "record-validator")).toBe(true);
    expect(readManifest(ws, "record-validator").retained).toBe(true);
    const log = gitLog(ws);
    expect(log.some((l) => l.includes("keep record-validator@1.0.0") && l.includes("(user curation)"))).toBe(true);
    // keep 不改变版本与 provenance
    const m = readManifest(ws, "record-validator");
    expect(m.version).toBe("1.0.0");
  }, 120_000);

  test("drop 取消保留（B 路径失联原料）+ git 留痕", () => {
    const ws = mintedWorkspace("keep-drop");
    expect(runOrg(["keep", "record-validator", "--workspace", ws]).ok).toBe(true);
    const r = runOrg(["drop", "record-validator", "--workspace", ws]);
    expect(r.ok).toBe(true);
    expect(retainedOf(ws, "record-validator")).toBe(false);
    const log = gitLog(ws);
    expect(log.some((l) => l.includes("drop record-validator@1.0.0") && l.includes("(user curation)"))).toBe(true);
  }, 120_000);

  test("未知名报错（退出码 1 + 明确反馈）", () => {
    const ws = mintedWorkspace("keep-missing");
    const r = runOrg(["keep", "no-such-expert", "--workspace", ws]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("未在注册表找到");
  }, 120_000);

  test("无参用法提示 + 注册表清单（○/★ 可见）", () => {
    const ws = mintedWorkspace("keep-usage");
    const r = runOrg(["keep", "--workspace", ws]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("用法：org keep");
    expect(r.stderr).toContain("record-validator");
  }, 120_000);

  test("dist/demo 入库快照只读（写入拒绝）", () => {
    const r = runOrg(["keep", "record-validator", "--workspace", path.join(ROOT, "dist", "demo")]);
    expect(r.ok).toBe(false);
    expect(r.stderr + r.stdout).toContain("只读");
  }, 120_000);
});

describe("工具库治理：keep / drop 路由面", () => {
  test("未保留候选 → B 路径不命中 → 路由 C 生成（记忆化零工厂）", () => {
    const ws = mintedWorkspace("keep-route-c");
    // 不 keep：候选在库但不参与自动复用
    const out = path.join(ws, "out-c1");
    const r = runOrgRun(ws, out);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const routes = journalEvents(events, "route").filter((d) => String(d.detail).includes("task#3"));
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes.some((d) => String(d.detail).includes("C:generate"))).toBe(true);
    // 记忆化：注册事实已存在，工厂不重跑（零 mint-register）
    expect(journalEvents(events, "mint-register").length).toBe(0);
    // 记忆化派单仍然执行（磁盘车道）
    const dispatches = journalEvents(events, "dispatch").filter((d) => String(d.detail).includes("task#3"));
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("keep 转正后 → B 路径恢复命中（channel=reuse）", () => {
    const ws = mintedWorkspace("keep-route-b");
    expect(runOrg(["keep", "record-validator", "--workspace", ws]).ok).toBe(true);
    const out = path.join(ws, "out-b1");
    const r = runOrgRun(ws, out);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const routes = journalEvents(events, "route").filter((d) => String(d.detail).includes("task#3"));
    expect(routes.some((d) => String(d.detail).includes("B:reuse"))).toBe(true);
    const dispatches = journalEvents(events, "dispatch").filter((d) => String(d.detail).includes("task#3"));
    expect(dispatches.some((d) => String(d.detail).includes("channel=reuse record-validator"))).toBe(true);
  }, 120_000);

  test("drop 反悔 → B 路径再次失联（路由回落 C 记忆化）", () => {
    const ws = mintedWorkspace("keep-route-drop");
    expect(runOrg(["keep", "record-validator", "--workspace", ws]).ok).toBe(true);
    expect(runOrg(["drop", "record-validator", "--workspace", ws]).ok).toBe(true);
    const out = path.join(ws, "out-b2");
    const r = runOrgRun(ws, out);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const events = eventsOf(out);
    const routes = journalEvents(events, "route").filter((d) => String(d.detail).includes("task#3"));
    expect(routes.some((d) => String(d.detail).includes("C:generate"))).toBe(true);
    expect(routes.some((d) => String(d.detail).includes("B:reuse"))).toBe(false);
  }, 120_000);
});

describe("工具库治理：注册表序列化卫生（真实模型文本防损坏）", () => {
  test("含引号/换行的 description 经 load→flush 往返不损坏（json_escape）", () => {
    // 构造一个含危险字符的注册表条目（模拟 deepseek 产出被合入）
    const ws = path.join(TEST_RUN, "keep-json-escape");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "demo-ws"), ws, { recursive: true });
    fs.mkdirSync(path.join(ws, "registry"), { recursive: true });
    const dirty = '校验记录；含 "引号" 与 \\ 反斜杠';
    const idx = [{ name: "dirty-expert", version: "1.0.0", bnf: "v1.5.0", description: dirty, capabilities: ["validate"], signature: "sig", source: "factory", eval_score: 1, fixture: "", entry: "registry/experts/dirty-expert.hsl", uses: 0, pass_rate: 1, retained: false, provenance: [] }];
    fs.writeFileSync(path.join(ws, "registry/index.json"), JSON.stringify(idx));
    // keep 触发 HSL 侧 load→flip→flush 往返
    const r = runOrg(["keep", "dirty-expert", "--workspace", ws]);
    expect(r.ok).toBe(true);
    // 往返后注册表必须仍是合法 JSON 且 description 保真
    const round = readJson(path.join(ws, "registry/index.json")) as Array<Record<string, unknown>>;
    expect(round.length).toBe(1);
    expect(round[0]!.description).toBe(dirty);
    expect(round[0]!.retained).toBe(true);
  }, 120_000);
});
