// ============================================================================
// tests/import.test.ts — 工具库治理（导入用户 harness）机制级测试
// ----------------------------------------------------------------------------
// 覆盖「org import」的完整语义：
//   1. 数据面：check 闸门 → 入库（registry/harnesses/ + index.json + 每专家
//      副本）→ git 留痕（import <name>@0.1.0 (user harness)）
//   2. 元数据面：描述缺省取 /// 文档注释；能力缺省扫描 #[capability]；
//      --name/--description/--capability 显式覆盖
//   3. 治理语义：source=import + retained=true（导入即保留，B 路径立即可
//      复用）；导入后 keep/drop 照常可用
//   4. 防呆面：坏 harness（check 不过）拒绝、重名拒绝、非 .hsl 拒绝、
//      非法名拒绝
//   5. 上下文窗口（Codex 风格）：ask 每轮打印 [ctx] 计量条；会话账本记
//      ctx_tokens；direct_ctx 事件上总线；status 汇总显示
// ============================================================================
// 端到端用例超时：本文件每个用例都真实 spawn 一次解释器跑完整监督回路（实测单轮
// 3–14s），而 bun 的默认每用例超时是 5000ms。全局手段都不可用（bunfig 的 [test]
// 段无 timeout 键；[test] preload 与 setDefaultTimeout 在多文件并行 worker 模式下
// 都不生效 —— 详见 tests/helpers.ts 的说明），故逐例显式声明 120_000，
// 与 tests/demo.test.ts 既有写法一致。放宽的是等待上限，不是断言标准。

import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { ROOT, TEST_RUN, runOrg, makeWorkspace, readJson, exists } from "./helpers";

/** 一个合法的最小 harness（带 /// 描述 + #[capability] 注解，供元数据提取）。 */
const SAMPLE = `/// 一个计算型 harness：阶乘演示（导入测试样例）
#[capability(math)]
export fn main() -> Result<(), String> {
    println!("fact(5) = {}", fact(5));
    Ok(())
}

fn fact(n: i32) -> i32 {
    if n <= 1 {
        1
    } else {
        n * fact(n - 1)
    }
}
`;

function writeSample(dir: string, name: string, content = SAMPLE): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function indexEntry(ws: string, name: string): Record<string, unknown> | undefined {
  const idx = readJson(path.join(ws, "registry/index.json")) as Array<Record<string, unknown>>;
  return idx.find((m) => m.name === name);
}

function gitLog(ws: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", ws, "log", "--oneline", "--all"], { stdout: "pipe" });
  return proc.stdout.toString().split("\n").filter((l) => l.trim().length > 0);
}

describe("工具库治理：import 数据面", () => {
  test("导入落盘三件套：harnesses/ 文件 + index.json 条目 + 每专家副本（git 留痕）", () => {
    const ws = makeWorkspace("import-data");
    const src = writeSample(TEST_RUN, "my-calc.hsl");
    const r = runOrg(["import", src, "--workspace", ws]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);

    expect(exists(path.join(ws, "registry/harnesses/my-calc.hsl"))).toBe(true);
    const e = indexEntry(ws, "my-calc")!;
    expect(e).toBeDefined();
    expect(e.source).toBe("import");
    expect(e.retained).toBe(true);            // 导入即保留
    expect(e.version).toBe("0.1.0");
    expect(e.entry).toBe("registry/harnesses/my-calc.hsl");
    expect(readJson(path.join(ws, "registry/my-calc.json")).name).toBe("my-calc");
    expect(gitLog(ws).some((l) => l.includes("import my-calc@0.1.0 (user harness)"))).toBe(true);
  }, 120_000);

  test("元数据缺省提取：/// 文档注释 → 描述；#[capability] → 能力", () => {
    const ws = makeWorkspace("import-meta");
    const src = writeSample(TEST_RUN, "meta-probe.hsl");
    const r = runOrg(["import", src, "--workspace", ws]);
    expect(r.ok).toBe(true);
    const e = indexEntry(ws, "meta-probe")!;
    expect(String(e.description)).toContain("阶乘演示");
    expect(e.capabilities).toEqual(["math"]);
  }, 120_000);

  test("显式覆盖：--name / --description / --capability 优先于缺省提取", () => {
    const ws = makeWorkspace("import-override");
    const src = writeSample(TEST_RUN, "over.hsl");
    const r = runOrg([
      "import", src, "--workspace", ws,
      "--name", "custom-name",
      "--description", "自定义描述",
      "--capability", "alpha,beta",
    ]);
    expect(r.ok).toBe(true);
    expect(exists(path.join(ws, "registry/harnesses/custom-name.hsl"))).toBe(true);
    const e = indexEntry(ws, "custom-name")!;
    expect(e.description).toBe("自定义描述");
    expect(e.capabilities).toEqual(["alpha", "beta"]);
  }, 120_000);

  test("导入后 keep/drop 照常可用（import 资产参与工具库治理）", () => {
    const ws = makeWorkspace("import-govern");
    const src = writeSample(TEST_RUN, "gov-probe.hsl");
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    expect(runOrg(["drop", "gov-probe", "--workspace", ws]).ok).toBe(true);
    expect(indexEntry(ws, "gov-probe")!.retained).toBe(false);
    expect(runOrg(["keep", "gov-probe", "--workspace", ws]).ok).toBe(true);
    expect(indexEntry(ws, "gov-probe")!.retained).toBe(true);
  }, 120_000);
});

describe("工具库治理：import 防呆面", () => {
  test("check 闸门：坏 harness 拒绝入库（工具库不收坏件）", () => {
    const ws = makeWorkspace("import-bad-hsl");
    const src = writeSample(TEST_RUN, "broken.hsl", "fn broken( {\n");
    const r = runOrg(["import", src, "--workspace", ws]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("dhv check 未通过");
    expect(exists(path.join(ws, "registry/harnesses/broken.hsl"))).toBe(false);
    expect(indexEntry(ws, "broken")).toBeUndefined();
  }, 120_000);

  test("重名拒绝：注册表已有同名专家（改名或先 drop）", () => {
    const ws = makeWorkspace("import-dup");
    const src = writeSample(TEST_RUN, "dup-probe.hsl");
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    const r2 = runOrg(["import", src, "--workspace", ws]);
    expect(r2.ok).toBe(false);
    expect(r2.stderr).toContain("同名专家");
  }, 120_000);

  test("非 .hsl 文件拒绝", () => {
    const ws = makeWorkspace("import-ext");
    const src = writeSample(TEST_RUN, "not-hsl.ts", "console.log(1);\n");
    const r = runOrg(["import", src, "--workspace", ws]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("只接受 .hsl 文件");
  }, 120_000);

  test("非法名拒绝（--name 大写/下划线；stem 数字开头）", () => {
    const ws = makeWorkspace("import-name");
    const src = writeSample(TEST_RUN, "okstem.hsl");
    const r = runOrg(["import", src, "--workspace", ws, "--name", "Bad_Name"]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("名字不合法");
    const src2 = writeSample(TEST_RUN, "1digit.hsl");
    const r2 = runOrg(["import", src2, "--workspace", ws]);
    expect(r2.ok).toBe(false);
    expect(r2.stderr).toContain("名字不合法");
  }, 120_000);
});

describe("上下文窗口计量（Codex 风格）", () => {
  test("org ask 每轮打印 [ctx] 计量条（窗口 128k）", () => {
    const ws = makeWorkspace("ctx-ask");
    const r = runOrg(["ask", "notice-parser", "字段映射规则是什么？", "--workspace", ws]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("[ctx] 窗口占用");
    expect(r.stdout).toContain("131.0k");   // 窗口规模显示
    expect(r.stdout).toContain("▓");        // meter 条
  }, 120_000);

  test("多轮会话：ctx 随轮次单调增长（会话史织入提示词）", () => {
    const ws = makeWorkspace("ctx-grow");
    const r = runOrg([
      "ask", "notice-parser", "x",
      "--workspace", ws,
      "--session", "grow",
      "--turns", "字段映射规则是什么？|日期无法解析怎么办？",
    ]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const ctxLines = r.stdout.split("\n").filter((l) => l.includes("[ctx]"));
    expect(ctxLines.length).toBe(2);
    const nums = ctxLines.map((l) => Number(/(\d+)\//.exec(l)?.[1] ?? 0));
    expect(nums[1]!).toBeGreaterThan(nums[0]!);   // 第 2 轮 > 第 1 轮
  }, 120_000);

  test("会话账本记录 ctx_tokens 字段（磁盘持久，跨调用可读）", () => {
    const ws = makeWorkspace("ctx-ledger");
    expect(runOrg(["ask", "notice-parser", "分类怎么判定？", "--workspace", ws]).ok).toBe(true);
    const ledger = fs.readFileSync(path.join(ws, "runtime/sessions/notice-parser/default.jsonl"), "utf-8");
    const row = JSON.parse(ledger.trim().split("\n")[0]!) as Record<string, unknown>;
    expect(typeof row.ctx_tokens).toBe("number");
    expect(Number(row.ctx_tokens)).toBeGreaterThan(0);
  }, 120_000);

  test("direct_ctx 事件上总线（知情权：TUI / replay 可消费）", () => {
    const ws = makeWorkspace("ctx-event");
    expect(runOrg(["ask", "notice-parser", "字段映射规则是什么？", "--workspace", ws]).ok).toBe(true);
    const events = fs.readFileSync(path.join(ws, "out-ask/events.jsonl"), "utf-8");
    const hit = events.split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { name: string; data?: { name?: string; detail?: string } })
      .find((e) => e.name === "journal" && e.data?.name === "direct_ctx");
    expect(hit).toBeDefined();
    expect(String(hit?.data?.detail)).toMatch(/notice-parser\/default turn=1 ctx=\d+ window=131072/);
  }, 120_000);

  test("org status 汇总上下文窗口占用（每会话一行 meter）", () => {
    const ws = makeWorkspace("ctx-status");
    expect(runOrg(["ask", "notice-parser", "字段映射规则是什么？", "--workspace", ws]).ok).toBe(true);
    const r = runOrg(["status", "--workspace", ws]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("上下文窗口占用");
    expect(r.stdout).toContain("notice-parser/default 1 轮");
    expect(r.stdout).toMatch(/ctx ▓░+/);
  }, 120_000);
});

describe("剧本联动（导入即能用：占位剧本 + 自动发现，v0.4.5）", () => {
  test("导入生成占位剧本：manifest.fixture 指向存在文件 + direct/handoff 双轨道", () => {
    const ws = makeWorkspace("fixgen");
    const src = writeSample(TEST_RUN, "fixgen-probe.hsl");
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    const e = indexEntry(ws, "fixgen-probe")!;
    expect(String(e.fixture)).toBe("registry/harnesses/fixgen-probe.fixture.json");
    const fx = readJson(path.join(ws, "registry/harnesses/fixgen-probe.fixture.json"));
    const tracks = Object.keys(fx.tracks as Record<string, string[]>);
    expect(tracks).toContain("direct:fixgen-probe");
    expect(tracks).toContain("handoff:fixgen-probe");
    expect((fx.tracks as Record<string, string[]>)["direct:fixgen-probe"]!.length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  test("零参数 ask：不传 --fixture 自动发现占位剧本（占位应答 + 记账 + ctx meter）", () => {
    const ws = makeWorkspace("fixask");
    const src = writeSample(TEST_RUN, "fixask-probe.hsl");
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    const r = runOrg(["ask", "fixask-probe", "这是什么工具？", "--workspace", ws]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("使用导入剧本");
    expect(r.stdout).toContain("占位剧本应答");
    expect(r.stdout).toContain("[ctx] 窗口占用");
    // 会话账本落盘（零摩擦链路的完整闭环）
    expect(exists(path.join(ws, "runtime/sessions/fixask-probe/default.jsonl"))).toBe(true);
  }, 120_000);

  test("handoff 同规则：自动发现 handoff:<name> 占位轨道", () => {
    const ws = makeWorkspace("fixhand");
    const src = writeSample(TEST_RUN, "fixhand-probe.hsl");
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    const r = runOrg(["handoff", "fixhand-probe", "--task", "总结一句话", "--workspace", ws]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("占位剧本应答");
  }, 120_000);

  test("显式 --fixture 优先于自动发现（fixtureExplicit 语义）", () => {
    const ws = makeWorkspace("fixexplicit");
    const src = writeSample(TEST_RUN, "fixexp-probe.hsl");
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    // 显式传 stock fixture：其中没有 direct:fixexp-probe 轨道 → 失败可证显式优先
    const r = runOrg(["ask", "fixexp-probe", "q", "--workspace", ws, "--fixture", path.join(ROOT, "fixtures/run-notices.json")]);
    expect(r.ok).toBe(false);
    expect((r.stdout + r.stderr)).not.toContain("使用导入剧本");
  }, 120_000);
});

// ============================================================================
// B 路径执行面（v0.4.6，issue #6）：导入 harness 被任务派单真实执行
// ----------------------------------------------------------------------------
// v0.4.5 前的断层：import 注册的 harness 在 registry/harnesses/，但派单执行
// (run_expert) 硬编码 registry/experts/ 约定 —— B 路径命中导入专家必然
// 「入口文件不存在」。v0.4.6 修复后：注册表登记优先寻址 + 工单序列化卫生
// + deliverable 契约（磁盘车道交付物流转下游）。
// ============================================================================
import { runOrgRun, eventsOf } from "./helpers";

/** 高亲和导入 harness：机械解析 raw/notices.txt，经 deliverable 契约交付记录。 */
const BPATH_HARNESS = `/// 结构化解析公告为记录：标题、日期、部门、分类（结构化解析公告为记录·标题·日期·部门·分类·导入高亲和专家）
#[capability(parse)]
export fn main() -> Result<(), String> {
    let spec_json: String = native typescript {
        try {
            return $host.fs.read("factory/current-spec.json");
        } catch (e) {
            return "";
        }
    };
    if spec_json.len() == 0 {
        return Err(String::from("factory/current-spec.json 缺失（工单未落盘）"));
    }
    let records: String = native typescript {
        let raw = "";
        try { raw = $host.fs.read("raw/notices.txt"); } catch (e) { raw = ""; }
        const out = [];
        for (const block of raw.split("=== NOTICE")) {
            if (block.trim().length === 0) continue;
            const rec = { title: "", date: "", date_status: "unparsed", dept: "", category: "notice" };
            for (const line of block.split("\\n")) {
                let m = /^标题[:：]\\s*(.+)$/.exec(line.trim());
                if (m) rec.title = m[1].trim();
                m = /^日期[:：]\\s*(.+)$/.exec(line.trim());
                if (m) {
                    const v = m[1].trim();
                    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) { rec.date = v; rec.date_status = "ok"; }
                    else rec.date = v;
                }
                m = /^部门[:：]\\s*(.+)$/.exec(line.trim());
                if (m) rec.dept = m[1].trim();
            }
            if (rec.title.includes("公告")) rec.category = "announcement";
            if (rec.title.length > 0) out.push(rec);
        }
        return JSON.stringify(out);
    };
    let summary: String = native typescript {
        const recs = JSON.parse(records);
        const valid = recs.filter((r) => r.title && r.dept).length;
        const cov = recs.length > 0 ? valid / recs.length : 0;
        const body = JSON.stringify({
            coverage: cov, valid: valid, total: recs.length,
            summary: "bpath-parse: " + valid + "/" + recs.length + " records",
            note: "B-path disk lane, deliverable declared",
            deliverable: JSON.stringify(recs),
        });
        $host.artifacts.write("acceptance.json", body);
        return "parsed " + recs.length + " records";
    };
    println!("[bpath-parse] {} via B path", summary);
    Ok(())
}
`;

describe("B 路径执行面（导入 harness 被真实派单执行，v0.4.6）", () => {
  test("端到端：task#2 route B:reuse 派单导入专家 → 真实执行 → 交付物流转下游", () => {
    const ws = makeWorkspace("bpath-e2e");
    const src = writeSample(TEST_RUN, "bpath-parse.hsl", BPATH_HARNESS);
    const imp = runOrg(["import", src, "--workspace", ws]);
    if (!imp.ok) console.error(imp.stdout + imp.stderr);
    expect(imp.ok).toBe(true);

    const out = path.join(ws, "out-bpath");
    const r = runOrgRun(ws, out);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("accepted 3 / 3 subtasks");

    // 派单事件铁证：路由 B 路径 + 复用通道指向导入专家
    const events = eventsOf(out);
    const routes = events.filter((e) => e.name === "journal" && e.data?.name === "route");
    expect(routes.some((e) => String(e.data?.detail).includes("B:reuse"))).toBe(true);
    const dispatches = events.filter((e) => e.name === "journal" && e.data?.name === "dispatch");
    expect(dispatches.some((e) => String(e.data?.detail).includes("reuse bpath-parse"))).toBe(true);

    // deliverable 契约：磁盘车道交付物 = 真实解析记录（非占位符），
    // 下游 validate 的 payload 就来自这份文件
    const parseOut = fs.readFileSync(path.join(ws, "work/parse-output.json"), "utf-8");
    const records = JSON.parse(parseOut) as Array<Record<string, unknown>>;
    expect(records.length).toBeGreaterThanOrEqual(4);
    expect(records.every((x) => typeof x.title === "string" && x.title.length > 0)).toBe(true);
  }, 120_000);

  test("工单序列化卫生：current-spec.json 始终合法 JSON（payload 转义嵌入）", () => {
    const ws = makeWorkspace("bpath-spec-hygiene");
    const src = writeSample(TEST_RUN, "bpath-parse.hsl", BPATH_HARNESS);
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    const r = runOrgRun(ws, path.join(ws, "out-bpath"));
    expect(r.ok).toBe(true);
    // 任务结束后盘上工单是合法 JSON；payload 是字符串字段（转义嵌入），
    // 既有 harness 的 JSON.parse(payload) 语义不变
    const spec = readJson(path.join(ws, "factory/current-spec.json"));
    expect(typeof spec.payload).toBe("string");
    expect(() => JSON.parse(String(spec.payload))).not.toThrow();
  }, 120_000);

  test("uses 计数：B 路径派单一次 → 注册表 uses+1（治理账本跟进）", () => {
    const ws = makeWorkspace("bpath-uses");
    const src = writeSample(TEST_RUN, "bpath-parse.hsl", BPATH_HARNESS);
    expect(runOrg(["import", src, "--workspace", ws]).ok).toBe(true);
    expect(Number(indexEntry(ws, "bpath-parse")!.uses)).toBe(0);
    const r = runOrgRun(ws, path.join(ws, "out-bpath"));
    expect(r.ok).toBe(true);
    expect(Number(indexEntry(ws, "bpath-parse")!.uses)).toBe(1);
  }, 120_000);
});
