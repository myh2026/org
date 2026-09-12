// ============================================================================
// tests/fixes.test.ts — v0.4.12 修复批次回归（修一个 bug 锁一个用例）
// ----------------------------------------------------------------------------
// 覆盖实测发现的五个缺陷面：
//   1. recurrence 序列化卫生：note 含引号 round-trip 不炸（写侧 json_escape
//      + 读侧损坏容错）—— deepseek 真实模式：一条含引号的 Revise note 即写坏
//      runtime/recurrence.json，之后每次 org run 崩溃
//   2. 工厂有界再生成：首生成物被 dhv check 拒绝后携带诊断重试（不再直接
//      Err 炸全场）—— deepseek 真实模式实测：首生成物是 Rust 风格
//   3. handoff 账本续写：两次暖移交不再截断历史（与 direct.hsl 同款）
//   4. ctx meter 正则：≥1k tokens 的 "8.4k/131.1k" 形态可匹配（不再降级纯文本）
//   5. crystallize 序列化卫生：memo 键值含引号不写坏 registry/memos/
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
  TEST_RUN, FIXTURE, runDhv, runOrg, runOrgRun, runVariant, makeWorkspace, fixtureVariant, readJson, exists,
} from "./helpers";

describe("v0.4.12 修复：recurrence 序列化卫生", () => {
  test("写侧：note 含引号/反斜杠 → recurrence.json 仍是合法 JSON 且键完整", () => {
    const ws = makeWorkspace("fix-recurrence");
    const fx = fixtureVariant((f) => {
      // 语义裁决通道注入含引号的 Revise note（旧代码：裸 format! 插值 → JSON 损坏）
      f.tracks["review:validate"] = [
        '{"verdict":"revise","note":"需要 \\"flagged\\" 语义（引号与反斜杠\\\\）"}',
        '{"verdict":"accept"}',
        '{"verdict":"accept"}',
      ];
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // 写侧断言：readJson 直接 JSON.parse —— 旧代码在此抛 SyntaxError
    const rec = readJson(path.join(ws, "runtime/recurrence.json"));
    const keys = Object.keys(rec);
    expect(keys.some((k) => k.includes("flagged"))).toBe(true);
  }, 120_000);

  test("读侧 round-trip：第二次运行加载既有 recurrence 不崩", () => {
    // 复用上一用例的工作区（recurrence 已含转义键）—— 旧代码：损坏文件 +
    // 裸 JSON.parse → 第二次 run 运行期崩溃（需手工删文件才能恢复）
    const ws = path.join(TEST_RUN, "fix-recurrence");
    const fx = fixtureVariant((f) => {
      f.tracks["review:validate"] = [
        '{"verdict":"revise","note":"需要 \\"flagged\\" 语义（引号与反斜杠\\\\）"}',
        '{"verdict":"accept"}',
        '{"verdict":"accept"}',
      ];
    });
    const r = runVariant(ws, path.join(ws, "out-b"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
  }, 120_000);

  test("读侧容错：手工损坏的 recurrence.json → 降级空表不炸运行（自愈）", () => {
    const ws = makeWorkspace("fix-recurrence-corrupt");
    // 模拟旧版本写侧留下的坏文件（含未转义引号）
    fs.mkdirSync(path.join(ws, "runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "runtime/recurrence.json"),
      '{"record-validator::覆盖率不足（补齐"覆盖"后重报）": 1}',
    );
    const r = runVariant(ws, path.join(ws, "out-a"), FIXTURE);
    if (!r.ok) console.error(r.stdout + r.stderr);
    // 旧代码：load_recurrence 裸 JSON.parse → 整次 run Err；新代码：降级空表
    expect(r.ok).toBe(true);
    expect(r.stderr + r.stdout).toContain("损坏");
    // save 侧重写后文件已自愈为合法 JSON
    expect(() => readJson(path.join(ws, "runtime/recurrence.json"))).not.toThrow();
  }, 120_000);
});

describe("v0.4.12 修复：工厂有界再生成（deepseek 真实模式实测）", () => {
  test("首生成物 Rust 风格被 check 拒绝 → 携带诊断重试 → 第二次过闸门上岗", () => {
    const ws = makeWorkspace("fix-mint-retry");
    const fx = fixtureVariant((f) => {
      // 真实 deepseek 模式实测抓到的形态：模型不认识 HSL，写出 `use std::...`
      // （v0.4.11 及此前：check 正确拒绝后整个 run 直接 Err 崩溃）
      const broken = "use std::collections::HashMap;\nuse std::fs;\n\nfn main() -> Result<(), String> {\n    Ok(())\n}\n";
      f.tracks["mint_hsl"] = [broken, f.tracks["mint_hsl"][0]];
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // 重试日志可观测（有界：第 1/3 次）
    expect(r.stdout).toContain("check 未过");
    // 第二次生成物（stock 源码）过闸门 → 专家注册在库（index.json 为顶层数组）
    expect(exists(path.join(ws, "registry/experts/record-validator.hsl"))).toBe(true);
    const index = readJson(path.join(ws, "registry/index.json"));
    const names = (Array.isArray(index) ? index : index.experts ?? []).map((e: any) => e.name);
    expect(names).toContain("record-validator");
  }, 120_000);

  test("耗尽上限仍不过 → 优雅降级：失败报告交监督回路，不炸整场 run", () => {
    const ws = makeWorkspace("fix-mint-exhaust");
    const broken = "use std::collections::HashMap;\nfn main() -> Result<(), String> { Ok(()) }\n";
    const fx = fixtureVariant((f) => {
      f.tracks["mint_hsl"] = [broken, broken, broken];
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    // v0.4.12 语义：工厂耗尽不再 `?` 炸全场 —— 转失败报告交监督回路
    // （Revise 有界返工重试工厂 → 耗尽强制收货时失败标注随报告可见）
    expect(r.ok).toBe(true);
    const out = r.stdout + r.stderr;
    // 三次尝试耗尽的诊断可观测（重试日志 ×2：第 1/3、第 2/3；第三次走耗尽分支）
    const retries = out.split("check 未过").length - 1;
    expect(retries).toBeGreaterThanOrEqual(2);
    // 失败子任务诚实标注（coverage 0.00 + factory failed），不连累其余子任务
    const report = fs.readFileSync(path.join(ws, "out-a/report.md"), "utf-8");
    expect(report).toContain("(factory failed)");
    expect(report).toContain("coverage 0.00");
    // 耗尽的完整诊断进 journal 观测面（mint-failed 事件 detail 含次数文案）
    const journal = fs.readFileSync(path.join(ws, "out-a/journal.jsonl"), "utf-8");
    expect(journal).toContain("mint-failed");
    expect(journal).toContain("3 次再生成均未过结构闸门");
  }, 120_000);
});

describe("v0.4.12 修复：handoff 账本续写", () => {
  test("两次暖移交 → 账本 2 行（旧代码覆写只剩最后 1 行）", () => {
    const ws = makeWorkspace("fix-handoff");
    for (let i = 0; i < 2; i++) {
      const r = runDhv(
        [
          "run", "hsl/pool/handoff.hsl",
          "--workspace", ws,
          "--task", "帮我把上周公告解析规则整理成一句话给新同事",
          "--model", "scripted",
          "--fixture", FIXTURE,
          "--out", path.join(ws, "out-handoff"),
          "--allow", "bun,node,ls,cat,grep,diff,git",
        ],
        { ORG_HANDOFF_EXPERT: "notice-parser", ORG_HANDOFF_TASK: "帮我把上周公告解析规则整理成一句话给新同事" },
      );
      if (!r.ok) console.error(r.stdout + r.stderr);
      expect(r.ok).toBe(true);
    }
    const ledgerPath = path.join(ws, "out-handoff/direct-ledger.jsonl");
    expect(exists(ledgerPath)).toBe(true);
    const lines = fs.readFileSync(ledgerPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const rec = JSON.parse(line);
      expect(rec.channel).toBe("handoff");
      expect(rec.expert).toBe("notice-parser");
    }
  }, 120_000);
});

describe("v0.4.12 修复：ctx meter 正则（Web GUI）", () => {
  test("≥1k tokens 形态 8.4k/131.1k 可匹配（旧正则只认纯数字侧）", () => {
    // 与 web/entry.ts meterHtml 同源正则（部署态断言见 web.test.ts 的 HTML 回归）
    const re = /([\d.]+)k?\/([\d.]+)k/;
    // 短会话（<1k）：942/131.1k —— 两种形态都必须继续匹配
    const m1 = re.exec("[ctx] 窗口占用 ▓░░ 942/131.1k（0.7%）（1 轮累计）");
    expect(m1).not.toBeNull();
    expect(m1![0]).toBe("942/131.1k");
    // 长会话（≥1k）：8.4k/131.1k —— 旧正则 /(\\d+)\\// 在此失配降级纯文本
    const m2 = re.exec("[ctx] 窗口占用 ▓░░░░░ 8.4k/131.0k（6.4%）（3 轮累计）");
    expect(m2).not.toBeNull();
    expect(m2![0]).toBe("8.4k/131.0k");
    expect(m2![1]).toBe("8.4");
    expect(m2![2]).toBe("131.0");
  }, 120_000);
});

describe("v0.4.12 修复：crystallize 序列化卫生", () => {
  test("memo 键值含引号 → registry/memos/<expert>.json 仍是合法 JSON", () => {
    // 直接驱动 notice-parser 专家（其 memo 键 = 归一化输入、值 = norm_date 输出）：
    // 用变体剧本让 norm_date 输出含引号，跑两轮触发冻结持久化
    const ws = makeWorkspace("fix-crystallize");
    const fx = fixtureVariant((f) => {
      // norm_date 轨道的输出值进入 memo 值位（旧代码裸插值 → JSON 损坏）
      const quoted = '"2025-01-01"（含引号）';
      f.tracks["norm_date"] = [quoted, quoted, quoted, quoted, quoted, quoted, quoted, quoted];
    });
    for (const id of ["a", "b"]) {
      const r = runVariant(ws, path.join(ws, `out-${id}`), fx);
      if (!r.ok) console.error(r.stdout + r.stderr);
      expect(r.ok).toBe(true);
    }
    const memoPath = path.join(ws, "registry/memos/notice-parser.json");
    expect(exists(memoPath)).toBe(true);
    // 旧代码：json_escape 缺失 → 含引号值写坏 JSON → 后续加载丢全部观测计数
    expect(() => readJson(memoPath)).not.toThrow();
  }, 120_000);
});

describe("v0.4.13 修复：任务物料路由（mission 数据不达专家 → 专家编造数据）", () => {
  // 实测根因：prepare_payload 无条件读 raw/notices.txt —— 任意任务都拿演示
  // 样本（情感分析任务解析出 5 条旧公告）；无 raw 文件时载荷为空 → minted
  // 专家无据编造（total_reviews: 25 凭空出现）。
  test("input=mission：分解器路由提示 → 解析子任务载荷 = 使命文本（1 块而非 5 条公告）", () => {
    const ws = makeWorkspace("fix-payload-mission");
    const fx = fixtureVariant((f) => {
      // decompose 轨道产物加 input:"mission"（只在 parse 子任务上）
      const plan = JSON.parse(f.tracks["decompose"][0]);
      for (const t of plan) {
        if (t.id === 2) t.input = "mission";
      }
      f.tracks["decompose"] = [JSON.stringify(plan)];
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // 使命文本作为载荷 → notice-parser 把整条使命切成 1 块（工作区有
    // raw/notices.txt 也不该再用 —— input=mission 是分解器的权威路由）
    const records = readJson(path.join(ws, "work/parse-output.json"));
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(1);
  }, 120_000);

  test("缺省 workspace：不带 input 字段的旧剧本行为不变（载荷 = raw/notices.txt 5 条）", () => {
    const ws = makeWorkspace("fix-payload-default");
    const r = runVariant(ws, path.join(ws, "out-a"), FIXTURE);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const records = readJson(path.join(ws, "work/parse-output.json"));
    expect(records.length).toBe(5);
  }, 120_000);

  test("无工作区材料回落：删 raw/notices.txt → 内联不硬错、载荷回落使命文本", () => {
    const ws = makeWorkspace("fix-payload-fallback");
    fs.rmSync(path.join(ws, "raw/notices.txt"));
    const r = runVariant(ws, path.join(ws, "out-a"), FIXTURE);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    // 旧代码：内联通道 raw/notices.txt 缺失 → OrgError 硬错炸整场 run
    const records = readJson(path.join(ws, "work/parse-output.json"));
    expect(records.length).toBe(1); // 使命文本 1 块（诚实回落，不编造数据）
  }, 120_000);
});

describe("v0.4.13 修复：B 复用语义地板（技能标签命中 ≠ 语义匹配）", () => {
  // 实测根因：serves 只看技能交集、affinity 只用于选优 —— 情感分析任务的
  // parse 子任务被复用到公告解析器（词面重合 2/22=9%）→ 产出 5 条旧公告。
  // 地板：命中比例 ≥ REUSE_AFFINITY_RATIO(0.3) 才可复用，否则 C 现场生成。
  test("低亲和 parse goal（9% 命中）→ 不再复用 notice-parser，走 C:generate", () => {
    const ws = makeWorkspace("fix-route-floor");
    const fx = fixtureVariant((f) => {
      // 演示 goal（14/26≈54%）换成情感分析 goal（2/22≈9%，技能仍 parse）
      const plan = JSON.parse(f.tracks["decompose"][0]);
      for (const t of plan) {
        if (t.id === 2) t.goal = "解析客户反馈文本并抽取情感极性与关键短语";
      }
      f.tracks["decompose"] = [JSON.stringify(plan)];
    });
    const r = runVariant(ws, path.join(ws, "out-a"), fx);
    // 注：剧本合成的 mint 产物是 record-validator（校验器干 parse 活儿，
    // 验收不过 → run Err 收场）—— 下游剧本局限不影响本断言：地板只测路由。
    const evs = fs.readFileSync(path.join(ws, "out-a/events.jsonl"), "utf-8");
    // 路由观测：parse 子任务必须走 C:generate（旧代码：B:reuse notice-parser）
    expect(evs).toContain("task#2 parse -> C:generate");
    expect(evs).toContain("channel=factory mint");
    expect(evs).not.toContain("channel=reuse notice-parser");
  }, 120_000);

  test("高亲和 parse goal（54% 命中，演示场景）→ 仍 B:reuse notice-parser", () => {
    const ws = makeWorkspace("fix-route-floor-keep");
    const r = runVariant(ws, path.join(ws, "out-a"), FIXTURE);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const evs = fs.readFileSync(path.join(ws, "out-a/events.jsonl"), "utf-8");
    expect(evs).toContain("task#2 parse -> B:reuse");
  }, 120_000);
});

// ============================================================================
// v0.4.17 修复批次回归（实测驱动 · 修一个 bug 锁一个用例）
//   6. shell 传参卫生：patch trigger 带撇号 → git 注册表留痕不断裂
//      （commit_registry 拼接 `git commit -m '<msg>'` —— msg 含 ' 即断，
//       git 留痕静默丢失；修复：sh_quote POSIX 单引号转义）
//   7. 直连剧本自动发现 source 分相：工厂专家 scripted 直连不再
//      FIXTURE_EXHAUSTED（expertFixtureOf 与 HSL run_fixture_of 同语义）
//   8. org demo 非默认工作区不再覆写 dist/demo（--export-dist 显式导出）
//   9. Web 会话 DELETE/PATCH 对 dist/demo 入库快照只读守卫
// ============================================================================

describe("v0.4.17 修复：shell 传参卫生（sh_quote）", () => {
  test("patch trigger 带撇号 → git 留痕完整落地（旧代码 registry_commit_skipped）", () => {
    const ws = makeWorkspace("fix-shquote");
    // 注入：铸出专家的 payload_note（→ Revise 意见 → 补丁 trigger → commit msg）带撇号
    // 两轮都用变体剧本 —— trigger 文本经 run A 的 acceptance note 进复发账本
    const fx = fixtureVariant((f) => {
      f.tracks.mint_hsl = [String(f.tracks.mint_hsl[0]).replace(
        "remedy: count date_status=unparsed as valid (flagged, not excluded)",
        "remedy: don't silently exclude flagged records",
      )];
    });
    expect(runVariant(ws, path.join(ws, "out-a"), fx).ok).toBe(true);
    const r = runVariant(ws, path.join(ws, "out-b"), fx);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    const manifest = readJson(path.join(ws, "registry/record-validator.json"));
    expect(manifest.version).toBe("1.0.1");
    // 修复前：命令断裂 → 无 patch 提交（只有 registry_commit_skipped 事件）
    const proc = Bun.spawnSync(["git", "-C", ws, "log", "--pretty=%s", "--all"], { stdout: "pipe" });
    const subjects = proc.stdout.toString().split("\n");
    const patchLine = subjects.find((s) => s.includes("patch record-validator -> 1.0.1"));
    expect(patchLine).toBeDefined();
    expect(patchLine).toContain("don't silently exclude");
  });
});

describe("v0.4.17 修复：直连剧本自动发现 source 分相", () => {
  test("工厂铸出专家 scripted 直连（org ask record-validator）→ Ok 且诚实占位", () => {
    const ws = makeWorkspace("fix-fixture-phase");
    expect(runOrgRun(ws, path.join(ws, "out-a")).ok).toBe(true);
    // 修复前：expertFixtureOf 把 factory/samples/<name>.json（TaskSpec 形态）当
    // 剧本传 → FIXTURE_EXHAUSTED「轨道不存在（可用：无）」
    const r = runOrg(["ask", "record-validator", "把 2026-03-05 这条记录校验一下", "--workspace", ws]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("占位剧本应答");
    // 会话账本正常落盘（直连治理链路零旁路）
    expect(exists(path.join(ws, "runtime/sessions/record-validator/default.jsonl"))).toBe(true);
  });
});

describe("v0.4.17 修复：org demo 非默认工作区不覆写 dist/demo", () => {
  test("demo --workspace /tmp 形态 → 输出跳过导出提示（--export-dist 可显式要求）", () => {
    const tmpWs = path.join(TEST_RUN, "fix-export-dist-ws");
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.cpSync(path.join(TEST_RUN, "..", "demo-ws"), tmpWs, { recursive: true });
    const r = runOrg(["demo", "--workspace", tmpWs]);
    if (!r.ok) console.error(r.stdout + r.stderr);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("跳过 dist/demo 导出");
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });
});
