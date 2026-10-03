// ============================================================================
// tests/gauntlet.test.ts — 故障注入（Gauntlet）org 侧回归接线（v0.5.34 · audit D2）
// ----------------------------------------------------------------------------
// 背景：机制本体在 vendored 宿主（toolchain/dhv-ts/src/host.ts FaultSpec ——
// error/deny/empty/corrupt/slow 五类，注入点在宿主 API 边界），但 org 侧此前
// 「零使用」（无 fixture faults、无测试、无入口）——审计定性为休眠能力。
// 本批把使用面接成回归：fixture faults 定向注入 → fault_injected 落盘 +
// 优雅失败（不挂死、错误可诊断）+ 对照组零误伤。
//
// 目标命名：真实 target 字面量 = `fixture.next:<track>`（带轨道后缀）；
// kind=error/deny 抛错（deny 另落 capability_denied），empty/corrupt 改值。
// ============================================================================

import { TT } from "./tt.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import * as fs from "../lib/fssafe-fs.ts";
import * as path from "node:path";
import { TEST_RUN, runDhv, eventsOf } from "./helpers";

const WS_ROOT = path.join(TEST_RUN, "gauntlet-ws");
let WS = "";
let seq = 0;
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

beforeEach(() => {
  WS = path.join(WS_ROOT, `g${String(++seq).padStart(3, "0")}`);
  fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
});

describe("Gauntlet 故障注入（org 侧接线回归 · D2）", () => {
  test("fixture.next 定向 error 注入：fault_injected 落盘 + 优雅失败", () => {
    const fx = path.join(TEST_RUN, "gauntlet-fixture.json");
    fs.writeFileSync(fx, JSON.stringify({
      tracks: { "direct:notice-parser": ["PONG"] },
      faults: [{ target: "fixture.next:direct:notice-parser", kind: "error", nth: 1, message: "fault: fixture down" }],
    }));
    const out = path.join(TEST_RUN, "out-gauntlet", "err");
    fs.rmSync(out, { recursive: true, force: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 探针", "--model", "scripted",
      "--fixture", fx, "--out", out,
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "gauntlet", ORG_ASK_QUESTION: "hi" });
    // 注入即失败 —— 但必须是「优雅失败」：进程正常退出、错误可诊断（不挂死）
    expect(r.ok).toBe(false);
    const evs = eventsOf(out);
    const fault = evs.find((e) => e.name === "fault_injected");
    expect(fault).toBeDefined();
    expect(JSON.stringify(fault)).toContain("fixture.next:direct:notice-parser");
    expect(r.stdout + r.stderr).toContain("fault: fixture down");
  }, TT);

  test("对照组：无 faults 的同轨道 fixture 正常消费（注入面零误伤）", () => {
    const fx = path.join(TEST_RUN, "gauntlet-fixture-clean.json");
    fs.writeFileSync(fx, JSON.stringify({ tracks: { "direct:notice-parser": ["PONG"] } }));
    const out = path.join(TEST_RUN, "out-gauntlet", "clean");
    fs.rmSync(out, { recursive: true, force: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 探针", "--model", "scripted",
      "--fixture", fx, "--out", out,
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "gauntlet2", ORG_ASK_QUESTION: "hi" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("PONG");
    expect(eventsOf(out).find((e) => e.name === "fault_injected")).toBeUndefined();
  }, TT);
});
