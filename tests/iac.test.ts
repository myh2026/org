// ============================================================================
// tests/iac.test.ts — IaC 深度实现层（v0.5.18 · capabilities #44）
// ----------------------------------------------------------------------------
// 九段锁定（tests/lsp.test.ts / cloud.test.ts 同构风格）：
//   1. 解析器 · 合法样本：多 block（terraform/provider/resource/data/variable/
//      output/locals/module）· 引号/裸 label · 基础类型 · list/嵌套 object ·
//      heredoc（<< 与 <<-）· 插值（var./local./data./资源地址 + 函数调用 +
//      $${ 转义）· 注释三形态 · depends_on 列表 → AST 结构断言；
//   2. 解析器 · 非法样本：未闭合 string / 未闭合 block / 缺 { / 缺 RHS /
//      %{ 模板指令 / 未闭合插值 / 非法转义 → 行号 + 原因（诚实报错）；
//   3. 依赖图：边提取（属性引用 + depends_on 双来源去重）· 拓扑序（被依赖
//      在前）· 环检测（cycle 路径）· 未声明引用（诚实警告）· data/module 节点；
//   4. Plan：文案（to create N resources 风格）· 每资源摘要 · 依赖序 ·
//      lane=builtin 恒标注 · 与真 terraform plan 差异尾注 · 有环拒绝；
//   5. Generate：四件套块（terraform/provider/variable/resource/output）·
//      $ref → var 引用 · 自动变量提取 · iacParse 往返自洽（逆操作）·
//      非法 manifest 逐字段诚实拒绝；
//   6. probe 降级链：PATH 置空宇宙 → 三面缺席 + builtin 主车道 + 指引（绝不
//      假装跑了 terraform）；假 CLI 脚本注入 PATH（POSIX 平台）→ 在场 +
//      版本解析 + validate 外部车道（-json 输出真解析）；
//   7. 文件入口：jail 越界 / missing / binary / oversize / syntax 各 kind；
//   8. 工具环 e2e（wiring2 同款 scripted 剧本驱动 direct.hsl）：四只读工具
//      result_summary 可观测 + ReadOnly 模式可用 + jail 越界拒绝；
//   9. CLI 冒烟（runOrg 真子进程）+ Web 端点 e2e（startWebServer · port 0）。
// 外部车道全部走假脚本注入（沙箱/CI 无真 terraform —— 与 cloud.test.ts 的
// 形态正则做法同源：不锁环境，锁「可观测」）。win32 无 POSIX shell → 假脚本
// 用例显式 skip（空 PATH 降级用例全平台跑）。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  iacParse, iacParseFile, iacGraph, iacPlan, iacGenerate, probeIac, iacValidate, iacSelfTest,
  renderExpr, IAC_PLAN_NOTES, type IacBlock,
} from "../lib/iac.ts";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";

const WIN32 = process.platform === "win32";

// ---- 工作区与语料 ---------------------------------------------------------------

function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-iac-${tag}-`));
}

function w(ws: string, rel: string, content: string): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** PATH 置空宇宙（与 cloud.test.ts / plugins.test.ts 同规）。 */
function withEmptyPath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** PATH 前置注入（假 CLI 车道 —— POSIX 平台专用）。 */
function withPathPrepended<T>(dir: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = dir + path.delimiter + saved;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** 假 CLI bin 目录（写可执行 shell 脚本 —— 仅 POSIX 平台调用）。 */
function fakeBinDir(tag: string, scripts: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `org-iac-bin-${tag}-`));
  for (const [name, body] of Object.entries(scripts)) {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, "#!/bin/sh\n" + body + "\n");
    fs.chmodSync(bin, 0o755);
  }
  return dir;
}

/** 合法全景语料：覆盖任务点名的全部 block 族/类型/插值/注释形态。 */
const CORPUS = `# 顶注释（# 形态）
terraform {
  required_version = ">= 1.5" // 行注释（// 形态）
  /* 块注释（跨行
     形态） */
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
provider "aws" {
  region = var.region
}
variable "region" {
  type        = string
  default     = "ap-northeast-1"
  description = "部署区域"
}
variable "instance_types" {
  type    = list(string)
  default = ["t3.micro", "t3.small"]
}
locals {
  name_prefix = "\${upper(var.region)}-app"
  is_prod     = true
}
data "aws_ami" "ubuntu" {
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu-*"]
  }
}
resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_types[0]
  count         = 2
  ebs_optimized = true
  monitoring    = false
  idle_timeout  = null
  user_data = <<-EOF
    #!/bin/bash
    echo "hello \${var.region}"
  EOF
  tags = {
    Name        = local.name_prefix
    Environment = "prod"
    CommaKey    = "v",
  }
  lifecycle {
    create_before_destroy = true
  }
}
resource "aws_security_group" "sg" {
  name = "web-sg"
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_eip" "ip" {
  instance    = aws_instance.web[0].id
  depends_on  = [aws_instance.web, aws_security_group.sg]
  domain      = "vpc"
}
module "vpc" {
  source  = "./modules/vpc"
  region  = var.region
  az_count = 2
}
output "web_ids" {
  value     = aws_instance.web[*].id
  sensitive = false
}
`;

// ---- 1. 解析器 · 合法样本 ---------------------------------------------------------

describe("iac 解析器：合法样本", () => {
  test("多 block 全景（11 顶层块：terraform/provider/variable×2/locals/data/resource×3/module/output）", () => {
    const r = iacParse(CORPUS);
    expect(r.ok).toBe(true);
    expect(r.blocks).toBe(11);
    expect(r.ast.map((b) => b.type)).toEqual([
      "terraform", "provider", "variable", "variable", "locals", "data", "resource", "resource", "resource", "module", "output",
    ]);
  }, 30_000);

  test("块计数与嵌套块（filter/lifecycle/ingress 是嵌套块不计顶层）", () => {
    const r = iacParse(CORPUS);
    const data = r.ast.find((b) => b.type === "data")!;
    expect(data.labels).toEqual(["aws_ami", "ubuntu"]);
    expect(data.blocks.map((b) => b.type)).toEqual(["filter"]);
    const web = r.ast.find((b) => b.type === "resource" && b.labels[1] === "web")!;
    expect(web.blocks.map((b) => b.type)).toEqual(["lifecycle"]);
    expect(web.blocks[0]!.attrs[0]!.name).toBe("create_before_destroy");
  }, 30_000);

  test("引号 label 与裸 label（module source 等）", () => {
    const r = iacParse(CORPUS);
    expect(r.ast.find((b) => b.type === "provider")!.labels).toEqual(["aws"]);
    const mod = r.ast.find((b) => b.type === "module")!;
    expect(mod.labels).toEqual(["vpc"]);
    expect(mod.attrs.find((a) => a.name === "source")!.value.kind).toBe("string");
  }, 30_000);

  test("基础类型：string / number / bool / null / list(string)", () => {
    const r = iacParse(CORPUS);
    const web = r.ast.find((b) => b.type === "resource" && b.labels[1] === "web")!;
    expect(web.attrs.find((a) => a.name === "count")!.value).toMatchObject({ kind: "number", value: 2 });
    expect(web.attrs.find((a) => a.name === "ebs_optimized")!.value).toMatchObject({ kind: "bool", value: true });
    expect(web.attrs.find((a) => a.name === "monitoring")!.value).toMatchObject({ kind: "bool", value: false });
    expect(web.attrs.find((a) => a.name === "idle_timeout")!.value).toMatchObject({ kind: "null" });
    const types = r.ast.find((b) => b.type === "variable" && b.labels[0] === "instance_types")!;
    expect(types.attrs.find((a) => a.name === "type")!.value.kind).toBe("expr"); // list(string) 是裸表达式（函数调用形）
  }, 30_000);

  test("list 与嵌套 object（含尾逗号容忍）", () => {
    const r = iacParse(CORPUS);
    const types = r.ast.find((b) => b.type === "variable" && b.labels[0] === "instance_types")!;
    const def = types.attrs.find((a) => a.name === "default")!.value as { kind: string; items: Array<{ kind: string; literal: string | null }> };
    expect(def.kind).toBe("list");
    expect(def.items.map((i) => i.literal)).toEqual(["t3.micro", "t3.small"]);
    const sg = r.ast.find((b) => b.type === "resource" && b.labels[1] === "sg")!;
    const ing = sg.blocks[0]!.attrs.find((a) => a.name === "cidr_blocks")!.value as { kind: string; items: Array<{ kind: string; literal: string | null }> };
    expect(ing.items.map((i) => i.literal)).toEqual(["0.0.0.0/0"]);
    const web = r.ast.find((b) => b.type === "resource" && b.labels[1] === "web")!;
    const tags = web.attrs.find((a) => a.name === "tags")!.value as { kind: string; entries: Array<{ name: string }> };
    expect(tags.kind).toBe("object");
    expect(tags.entries.map((e) => e.name)).toEqual(["Name", "Environment", "CommaKey"]);
  }, 30_000);

  test("heredoc：<<-EOF 公共缩进剥除 + 体内插值", () => {
    const r = iacParse(CORPUS);
    const web = r.ast.find((b) => b.type === "resource" && b.labels[1] === "web")!;
    const ud = web.attrs.find((a) => a.name === "user_data")!.value as {
      kind: string; tag: string; indent: boolean; parts: Array<{ t: string; text?: string; expr?: { kind: string; path?: string[] } }>;
    };
    expect(ud.kind).toBe("heredoc");
    expect(ud.tag).toBe("EOF");
    expect(ud.indent).toBe(true);
    // <<- 剥公共缩进：首行不再有前导空格；插值切分点即段边界
    // （text 段到插值点为止 —— 引号留在后续段，与 HCL 模板语义一致）
    expect(ud.parts[0]!.text).toBe("#!/bin/bash\necho \"hello ");
    // 体内 ${var.region} 是插值表达式
    expect(ud.parts[1]!.t).toBe("expr");
    expect(ud.parts[1]!.expr).toMatchObject({ kind: "traversal", path: ["var", "region"] });
    // 插值后收尾：右引号 + 换行
    expect(ud.parts[2]!.t).toBe("text");
    expect(ud.parts[2]!.text).toBe("\"\n");
  }, 30_000);

  test("插值表达式：函数调用 + 索引 + splat（locals.name_prefix / instance_type / output）", () => {
    const r = iacParse(CORPUS);
    const locals = r.ast.find((b) => b.type === "locals")!;
    const np = locals.attrs.find((a) => a.name === "name_prefix")!.value as { kind: string; parts: Array<{ t: string; expr?: unknown }> };
    expect(np.kind).toBe("string");
    expect(np.parts[0]!.t).toBe("expr");
    expect(np.parts[0]!.expr).toMatchObject({ kind: "call", name: "upper" });
    const web = r.ast.find((b) => b.type === "resource" && b.labels[1] === "web")!;
    const it = web.attrs.find((a) => a.name === "instance_type")!.value as { kind: string; expr: { kind: string } };
    expect(it.kind).toBe("expr"); // var.instance_types[0] —— 裸表达式（索引）
    expect(it.expr.kind).toBe("index");
    const out = r.ast.find((b) => b.type === "output")!;
    const val = out.attrs.find((a) => a.name === "value")!.value as { kind: string; expr: { kind: string } };
    expect(val.expr.kind).toBe("splat"); // aws_instance.web[*].id
  }, 30_000);

  test("$${ 转义是字面（不误切插值）", () => {
    const r = iacParse('x {\n  v = "cost $${not_interp} done"\n}\n');
    const v = r.ast[0]!.attrs[0]!.value as { kind: string; literal: string };
    expect(v.literal).toBe("cost ${not_interp} done");
  }, 30_000);

  test("注释三形态全跳过（# // /* */）且不产生块/属性", () => {
    const r = iacParse("# c1\n// c2\n/* c3\n c3 */\nresource \"a\" \"b\" {\n  x = 1 # 尾注释\n}\n");
    expect(r.ok).toBe(true);
    expect(r.blocks).toBe(1);
    expect(r.attrs).toBe(1);
  }, 30_000);

  test("空文件与纯注释文件 → 空 AST（ok 而非报错）", () => {
    expect(iacParse("").ok).toBe(true);
    expect(iacParse("").ast).toEqual([]);
    expect(iacParse("# only comments\n// more\n").ok).toBe(true);
  }, 30_000);

  test("depends_on 列表引用可解析（裸引用进 list）", () => {
    const r = iacParse(CORPUS);
    const eip = r.ast.find((b) => b.type === "resource" && b.labels[1] === "ip")!;
    const deps = eip.attrs.find((a) => a.name === "depends_on")!.value as { kind: string; items: Array<{ kind: string; expr: { kind: string; path: string[] } }> };
    expect(deps.items.map((i) => i.expr.path.join("."))).toEqual(["aws_instance.web", "aws_security_group.sg"]);
  }, 30_000);

  test("一元/二元/三元表达式结构（不求值，只建结构）", () => {
    const r = iacParse('x {\n  a = 1 + 2 * 3\n  b = -5\n  c = var.enable ? "on" : "off"\n}\n');
    const attrs = r.ast[0]!.attrs;
    expect((attrs[0]!.value as { expr: { kind: string; op: string } }).expr).toMatchObject({ kind: "binary", op: "+" });
    expect((attrs[1]!.value as { expr: { kind: string; op: string } }).expr).toMatchObject({ kind: "unary", op: "-" });
    expect((attrs[2]!.value as { expr: { kind: string } }).expr.kind).toBe("conditional");
    expect(renderExpr((attrs[0]!.value as { expr: unknown }).expr as never)).toBe("1 + 2 * 3");
  }, 30_000);
});

// ---- 2. 解析器 · 非法样本（行号 + 原因诚实） --------------------------------------

describe("iac 解析器：非法样本诚实报错", () => {
  const bad = (src: string) => iacParse(src).errors[0]!;

  test("未闭合字符串 → 行号 + 收口指引", () => {
    const r = iacParse('resource "aws_instance" "web" {\n  ami = "ami-123\n}\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.message).toContain("字符串未闭合");
  }, 30_000);

  test("未闭合块（EOF 悬空）→ 行号 + 块名", () => {
    const r = iacParse('resource "aws_instance" "web" {\n  ami = "a"\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("未收口");
    expect(r.errors[0]!.message).toContain("aws_instance");
  }, 30_000);

  test("块缺 { → 期望 { 的诚实提示", () => {
    const r = iacParse('resource "aws_instance" "web" \n  ami = "a"\n}\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("{");
  }, 30_000);

  test("属性缺 RHS（换行先行）→ 期望表达式", () => {
    const r = iacParse('resource "aws_instance" "web" {\n  ami = \n}\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.message).toContain("期望表达式");
  }, 30_000);

  test("模板指令 %{ if } 不在支持子集 → 明说（不静默吞）", () => {
    const r = iacParse('x {\n  v = "hello %{ if true } on %{ endif }"\n}\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("模板指令");
    expect(r.errors[0]!.message).toContain("不在支持子集内");
  }, 30_000);

  test("for 表达式不在支持子集 → 明说（诚实边界）", () => {
    const r = iacParse("x {\n  v = [for a in [1, 2] : a * 2]\n}\n");
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("for");
    expect(r.errors[0]!.message).toContain("不在支持子集内");
  }, 30_000);

  test("未闭合插值 → 行号", () => {
    const r = iacParse('x {\n  v = "hello ${var.name"\n}\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.message).toContain("${");
  }, 30_000);

  test("非法转义 → 行号 + 支持集提示", () => {
    const r = iacParse('x {\n  v = "bad \\q escape"\n}\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("转义");
  }, 30_000);

  test("顶层裸属性拒绝（HCL 顶层只允许块）", () => {
    const r = iacParse('ami = "a"\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("顶层不允许裸属性");
  }, 30_000);

  test("heredoc 未收口 → 行号 + 标签名", () => {
    const r = iacParse("x {\n  v = <<EOF\nbody\n");
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("heredoc");
    expect(r.errors[0]!.message).toContain("EOF");
    expect(bad("x {\n  v = <<EOF\nbody\n").line).toBeGreaterThan(1);
  }, 30_000);
});

// ---- 3. 依赖图 ------------------------------------------------------------------

describe("iac 依赖图（iacGraph）", () => {
  test("边提取：属性引用（var/data/local/资源地址）+ depends_on 双来源去重", () => {
    const r = iacParse(CORPUS);
    const g = iacGraph(r.ast);
    expect(g.ok).toBe(true);
    const edgeSet = new Set(g.edges.map((e) => `${e.from}→${e.to}`));
    expect(edgeSet.has("aws_instance.web→var.instance_types")).toBe(true);
    expect(edgeSet.has("aws_instance.web→data.aws_ami.ubuntu")).toBe(true);
    expect(edgeSet.has("aws_instance.web→local.name_prefix")).toBe(true);
    expect(edgeSet.has("aws_eip.ip→aws_instance.web")).toBe(true);
    expect(edgeSet.has("aws_eip.ip→aws_security_group.sg")).toBe(true);
    expect(edgeSet.has("module.vpc→var.region")).toBe(true);
    expect(edgeSet.has("local.name_prefix→var.region")).toBe(true);
    // depends_on 与属性引用同边去重（aws_eip.ip → aws_instance.web 只 1 条）
    expect(g.edges.filter((e) => e.from === "aws_eip.ip" && e.to === "aws_instance.web")).toHaveLength(1);
  }, 30_000);

  test("拓扑序：被依赖在前（var → data/local → web → sg → eip → module）", () => {
    const r = iacParse(CORPUS);
    const g = iacGraph(r.ast);
    const idx = (a: string) => g.order.indexOf(a);
    expect(idx("var.region")).toBeLessThan(idx("local.name_prefix"));
    expect(idx("local.name_prefix")).toBeLessThan(idx("aws_instance.web"));
    expect(idx("data.aws_ami.ubuntu")).toBeLessThan(idx("aws_instance.web"));
    expect(idx("aws_instance.web")).toBeLessThan(idx("aws_eip.ip"));
    expect(idx("aws_security_group.sg")).toBeLessThan(idx("aws_eip.ip"));
  }, 30_000);

  test("环检测：a.x ⇄ a.y 诚实报环（路径含两端）", () => {
    const src = 'resource "a" "x" {\n  v = a.y.id\n}\nresource "a" "y" {\n  v = a.x.id\n}\n';
    const g = iacGraph(iacParse(src).ast);
    expect(g.ok).toBe(false);
    expect(g.cycles.length).toBeGreaterThan(0);
    const cyc = g.cycles[0]!;
    expect(cyc[0]).toBe(cyc[cyc.length - 1]);
    expect(cyc.join("→")).toContain("a.x");
    expect(cyc.join("→")).toContain("a.y");
    expect(g.reason).toContain("依赖图有环");
    expect(g.order).toEqual([]); // 有环时拓扑序不出
  }, 30_000);

  test("未声明引用 → 诚实警告（apply 前须补声明）", () => {
    const src = 'resource "a" "x" {\n  v = var.missing_one\n  w = a.ghost.id\n}\n';
    const g = iacGraph(iacParse(src).ast);
    expect(g.ok).toBe(true);
    expect(g.undeclaredRefs.map((u) => u.via)).toEqual(["var.missing_one", "a.ghost.id"]);
    expect(g.undeclaredRefs[0]!.line).toBe(2);
  }, 30_000);

  test("计数 summary（resource/data/variable/local/module 五族节点）", () => {
    const g = iacGraph(iacParse(CORPUS).ast);
    expect(g.summary).toEqual({ resources: 3, dataSources: 1, variables: 2, locals: 1, modules: 1 });
    expect(g.nodes.length).toBe(8);
  }, 30_000);
});

// ---- 4. Plan ---------------------------------------------------------------------

describe("iac Plan（iacPlan）", () => {
  test("文案风格：to create N resources + 每资源 will be created 摘要 + 依赖注记", () => {
    const p = iacPlan(iacParse(CORPUS).ast);
    expect(p.ok).toBe(true);
    expect(p.text).toContain("Plan: to create 3 resources, to read 1 data sources, to instantiate 1 modules; 0 to update, 0 to destroy.");
    expect(p.text).toContain("# aws_instance.web will be created");
    expect(p.text).toContain('+ resource "aws_instance" "web" {');
    expect(p.text).toContain("+ ami = data.aws_ami.ubuntu.id");
    expect(p.text).toContain("依赖（拓扑序在前）");
  }, 30_000);

  test("依赖序体现在计划资源顺序（web 在 eip 前）", () => {
    const p = iacPlan(iacParse(CORPUS).ast);
    expect(p.order.indexOf("aws_instance.web")).toBeLessThan(p.order.indexOf("aws_eip.ip"));
    expect(p.order[0]).toBe("var.region");
  }, 30_000);

  test("lane 恒 builtin + 差异尾注（与真 terraform plan 的差异逐条标注）", () => {
    const p = iacPlan(iacParse(CORPUS).ast);
    expect(p.lane).toBe("builtin");
    expect(p.text).toContain("诚实边界");
    for (const note of IAC_PLAN_NOTES) expect(p.text).toContain(note.slice(0, 20));
    expect(p.notes).toHaveLength(IAC_PLAN_NOTES.length);
  }, 30_000);

  test("count/for_each 只识别不展开（资源摘要带诚实标注）", () => {
    const p = iacPlan(iacParse(CORPUS).ast);
    expect(p.text).toContain("count/for_each：本计划不展开");
  }, 30_000);

  test("有环 → 计划拒绝 + 环路径（Terraform 同样会拒绝）", () => {
    const src = 'resource "a" "x" {\n  v = a.y.id\n}\nresource "a" "y" {\n  v = a.x.id\n}\n';
    const p = iacPlan(iacParse(src).ast);
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("依赖图有环");
    expect(p.cycles![0]!.join("→")).toContain("a.x");
    expect(p.text).toBe("");
  }, 30_000);

  test("空配置 → 零资源计划（不臆造）", () => {
    const p = iacPlan([]);
    expect(p.ok).toBe(true);
    expect(p.text).toContain("Plan: to create 0 resources");
    expect(p.summary.resources).toBe(0);
  }, 30_000);
});

// ---- 5. Generate -----------------------------------------------------------------

describe("iac Generate（iacGenerate）", () => {
  const MANIFEST = {
    provider: "aws",
    region: "ap-northeast-1",
    variables: [{ name: "instance_type", type: "string", default: "t3.micro", description: "机型" }],
    resources: [
      {
        type: "aws_instance", name: "web",
        attrs: {
          ami: "ami-0c1234",
          instance_type: { $ref: "var.instance_type" },
          ebs_optimized: true,
          port: 8080,
          zones: ["a", "b"],
          tags: { Name: "web" },
        },
      },
    ],
    outputs: [{ name: "web_id", value: "aws_instance.web.id" }],
  };

  test("四件套：terraform/provider/variable/resource/output 块齐备", () => {
    const r = iacGenerate(MANIFEST);
    expect(r.ok).toBe(true);
    expect(r.tf).toContain("terraform {");
    expect(r.tf).toContain('required_providers {');
    expect(r.tf).toContain('provider "aws" {');
    expect(r.tf).toContain('variable "instance_type" {');
    expect(r.tf).toContain('variable "region" {');
    expect(r.tf).toContain('resource "aws_instance" "web" {');
    expect(r.tf).toContain('output "web_id" {');
  }, 30_000);

  test("$ref → var 裸引用 + 值类型忠实（字符串/数字/bool/list/对象）", () => {
    const r = iacGenerate(MANIFEST);
    expect(r.tf).toContain("instance_type = var.instance_type");
    expect(r.tf).toContain('ami = "ami-0c1234"');
    expect(r.tf).toContain("ebs_optimized = true");
    expect(r.tf).toContain("port = 8080");
    expect(r.tf).toContain('zones = ["a", "b"]');
    expect(r.tf).toContain("Name = \"web\"");
  }, 30_000);

  test("往返自洽：生成的 .tf 可被 iacParse 解析且语义保真（逆操作）", () => {
    const r = iacGenerate(MANIFEST);
    expect(r.roundTrip.ok).toBe(true);
    const back = iacParse(r.tf);
    expect(back.ok).toBe(true);
    const res = back.ast.filter((b: IacBlock) => b.type === "resource");
    expect(res).toHaveLength(1);
    expect(res[0]!.labels).toEqual(["aws_instance", "web"]);
    const it = res[0]!.attrs.find((a) => a.name === "instance_type")!.value as { kind: string; expr: { kind: string; path: string[] } };
    expect(it.kind).toBe("expr");
    expect(it.expr.path.join(".")).toBe("var.instance_type");
    const ebs = res[0]!.attrs.find((a) => a.name === "ebs_optimized")!.value as { kind: string; value: boolean };
    expect(ebs.value).toBe(true);
  }, 30_000);

  test("自动变量提取：$ref 引用未声明变量 → 自动补 variable + 警告", () => {
    const r = iacGenerate({
      provider: "google",
      resources: [{ type: "google_storage_bucket", name: "b", attrs: { location: { $ref: "var.region" } } }],
    });
    expect(r.ok).toBe(true);
    expect(r.variables).toContain("region");
    expect(r.warnings.some((x) => x.includes("region") && x.includes("自动补"))).toBe(true);
    expect(r.tf).toContain('variable "region" {');
  }, 30_000);

  test("outputs 缺席 → 每资源自动 <name>_id 输出（引用形）", () => {
    const r = iacGenerate({ provider: "aws", resources: [{ type: "aws_instance", name: "app", attrs: { ami: "ami-1" } }] });
    expect(r.ok).toBe(true);
    expect(r.tf).toContain('output "app_id" {');
    expect(r.tf).toContain("value       = aws_instance.app.id");
    expect(r.warnings.some((x) => x.includes("自动"))).toBe(true);
  }, 30_000);

  test("非法 manifest 逐字段诚实拒绝（缺 provider / 坏标识符 / 空 resources / 坏 $ref）", () => {
    const noProvider = iacGenerate({ resources: [] } as never);
    expect(noProvider.ok).toBe(false);
    expect(noProvider.errors[0]).toContain("provider 必填");
    const badName = iacGenerate({ provider: "aws", resources: [{ type: "aws instance!", name: "web" }] });
    expect(badName.ok).toBe(false);
    expect(badName.errors.join("\n")).toContain("不是合法 HCL 标识符");
    const empty = iacGenerate({ provider: "aws", resources: [] });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join("\n")).toContain("resources 必填且非空");
    const badRef = iacGenerate({ provider: "aws", resources: [{ type: "a", name: "b", attrs: { x: { $ref: "not a ref!" } } }] });
    expect(badRef.ok).toBe(false);
    expect(badRef.errors.join("\n")).toContain("$ref");
  }, 30_000);

  test("含插值字符串原样透传（生成 → 再解析保持模板）", () => {
    const r = iacGenerate({ provider: "aws", resources: [{ type: "aws_instance", name: "w", attrs: { user_data: "echo ${var.name}" } }] });
    expect(r.ok).toBe(true);
    expect(r.tf).toContain("echo ${var.name}");
    const back = iacParse(r.tf);
    expect(back.ok).toBe(true);
  }, 30_000);
});

// ---- 6. probe 降级链 + 外部车道（假脚本注入） --------------------------------------

describe("iac probe / validate 降级链", () => {
  test("PATH 置空：三面缺席 + lane=builtin + 建议（内置车道为主车道 —— 诚实降级）", () => {
    const p = withEmptyPath(() => probeIac());
    expect(p.terraform.available).toBe(false);
    expect(p.terraform.version).toBeNull();
    expect(p.tofu.available).toBe(false);
    expect(p.tflint.available).toBe(false);
    expect(p.lane).toBe("builtin");
    expect(p.suggestion).toContain("内置静态车道");
    expect(p.suggestion.length).toBeGreaterThan(20);
    expect(p.terraform.reason).toContain("安装");
  }, 30_000);

  test("PATH 置空：iacValidate → tool-absent + lane=builtin（绝不假装跑过 terraform）", () => {
    const ws = tmpWs("val-empty");
    try {
      const r = withEmptyPath(() => iacValidate(ws, "."));
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("tool-absent");
      expect(r.lane).toBe("builtin");
      expect(r.reason).toContain("内置静态车道");
      expect(r.argv).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("iacValidate 目录越界 → jail（监狱先于一切探测）", () => {
    const ws = tmpWs("val-jail");
    try {
      const r = iacValidate(ws, "../../etc");
      expect(r.kind).toBe("jail");
      expect(r.reason).toContain("越界");
      const miss = iacValidate(ws, "not-exist-dir");
      expect(miss.kind).toBe("missing");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  (WIN32 ? test.skip : test)("假 terraform 注入 PATH：在场 + 版本解析（1.9.5）+ lane=cli", () => {
    const dir = fakeBinDir("tf", { terraform: 'echo "Terraform v1.9.5"\necho "on windows there is no linux"' });
    try {
      const p = withPathPrepended(dir, () => probeIac());
      expect(p.terraform.available).toBe(true);
      expect(p.terraform.version).toBe("1.9.5");
      expect(p.lane).toBe("cli");
      expect(p.suggestion).toContain("validate");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  (WIN32 ? test.skip : test)("假 tofu 注入 PATH：OpenTofu 版本解析", () => {
    const dir = fakeBinDir("tofu", { tofu: 'echo "OpenTofu v1.8.5"' });
    try {
      const p = withPathPrepended(dir, () => probeIac());
      expect(p.tofu.available).toBe(true);
      expect(p.tofu.version).toBe("1.8.5");
      expect(p.lane).toBe("cli"); // tofu 在场也算 cli 车道（validate 可用）
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  (WIN32 ? test.skip : test)("假 terraform validate -json：外部车道真解析（valid:true 诊断面送达）", () => {
    const ws = tmpWs("val-fake");
    try {
      fs.mkdirSync(path.join(ws, "infra"), { recursive: true });
      fs.writeFileSync(path.join(ws, "infra", "main.tf"), 'resource "a" "b" {\n  x = 1\n}\n');
      const dir = fakeBinDir("tf-val", {
        terraform: [
          'if [ "$1" = "version" ]; then echo "Terraform v1.9.5"; exit 0; fi',
          'if [ "$1" = "validate" ]; then echo \'{"format_version":"1.0","valid":true,"error_count":0,"diagnostics":[]}\'; exit 0; fi',
        ].join("\n"),
      });
      try {
        const r = withPathPrepended(dir, () => iacValidate(ws, "infra"));
        expect(r.ok).toBe(true);
        expect(r.lane).toBe("cli");
        expect(r.valid).toBe(true);
        expect(r.bin).toBe("terraform");
        expect(r.diagnostics).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  (WIN32 ? test.skip : test)("假 terraform validate 报 invalid：诊断逐条送达", () => {
    const ws = tmpWs("val-invalid");
    try {
      fs.mkdirSync(path.join(ws, "i"), { recursive: true });
      const dir = fakeBinDir("tf-inv", {
        terraform: [
          'if [ "$1" = "version" ]; then echo "Terraform v1.9.5"; exit 0; fi',
          `if [ "$1" = "validate" ]; then echo '{"format_version":"1.0","valid":false,"error_count":1,"diagnostics":[{"severity":"error","summary":"Unsupported argument","detail":"An argument named \\"bad\\" is not expected here.","range":{"filename":"main.tf","start":{"line":3}}}]}'; exit 0; fi`,
        ].join("\n"),
      });
      try {
        const r = withPathPrepended(dir, () => iacValidate(ws, "i"));
        expect(r.ok).toBe(false);
        expect(r.kind).toBe("invalid");
        expect(r.valid).toBe(false);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]!.summary).toBe("Unsupported argument");
        expect(r.diagnostics[0]!.line).toBe(3);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  (WIN32 ? test.skip : test)("坏安装探活失败 → 按缺席降级（available:false，不 throw）", () => {
    // 一个 exit 1 的假 terraform（version 探活非零）→ 坏安装按缺席降级
    const dir = fakeBinDir("tf-bad", { terraform: "exit 1" });
    try {
      const p = withPathPrepended(dir, () => probeIac());
      expect(p.terraform.available).toBe(false);
      expect(p.terraform.version).toBeNull();
      expect(p.lane).toBe("builtin");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("probe 五面结构完备（terraform/tofu/tflint/lane/suggestion）", () => {
    const p = probeIac();
    for (const k of ["terraform", "tofu", "tflint", "lane", "suggestion", "tookMs"] as const) {
      expect(p).toHaveProperty(k);
    }
    expect(["builtin", "cli"]).toContain(p.lane);
  }, 30_000);
});

// ---- 7. 文件入口（jail / missing / binary / oversize / syntax） -------------------

describe("iac 文件入口（iacParseFile）", () => {
  test("jail：越界路径拒绝（拒绝先于读盘）", () => {
    const ws = tmpWs("file-jail");
    try {
      const r = iacParseFile(ws, "../../etc/passwd");
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("jail");
      expect(r.reason).toContain("越界");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("missing / binary / oversize / syntax 四类诚实 kind", () => {
    const ws = tmpWs("file-kinds");
    try {
      expect(iacParseFile(ws, "nope.tf").kind).toBe("missing");
      w(ws, "bin.tf", "a\0b\0c");
      expect(iacParseFile(ws, "bin.tf").kind).toBe("binary");
      w(ws, "big.tf", "x = 1\n".repeat(1024 * 600)); // ~3.6MB > 1MB 帽
      expect(iacParseFile(ws, "big.tf").kind).toBe("oversize");
      w(ws, "bad.tf", 'resource "a" "b" {\n  v = "unclosed\n}\n');
      const r = iacParseFile(ws, "bad.tf");
      expect(r.kind).toBe("syntax");
      expect(r.reason).toContain("bad.tf");
      expect(r.errors[0]!.line).toBe(2);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("正常路径：相对形工作区 + file 输出为工作区相对路径", () => {
    const ws = tmpWs("file-ok");
    try {
      w(ws, path.join("infra", "main.tf"), 'resource "aws_instance" "web" {\n  ami = "a"\n}\n');
      const r = iacParseFile(ws, "infra/main.tf");
      expect(r.ok).toBe(true);
      expect(r.file).toBe("infra/main.tf");
      expect(r.ast).toHaveLength(1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 8. 自检 ---------------------------------------------------------------------

describe("iac 自检（iacSelfTest）", () => {
  test("全通过（解析/label/引用/图/拓扑/环/plan/往返/保真/错误行号/probe）", () => {
    const r = iacSelfTest();
    for (const c of r.checks) {
      if (!c.ok) console.error("  ✗", c.name, c.detail ?? "");
    }
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(r.total);
    expect(r.total).toBeGreaterThanOrEqual(10);
  }, 30_000);
});

// ---- 9. 工具环 e2e（scripted 剧本驱动 direct.hsl —— wiring2 同款） -------------------

const WS_ROOT = path.join(TEST_RUN, "iac-ws");
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");
let wsSeq = 0;
let WS = "";

function seedToolsWs(): void {
  fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
  fs.mkdirSync(path.join(WS, "infra"), { recursive: true });
  fs.writeFileSync(path.join(WS, "infra", "main.tf"), [
    'variable "region" {',
    "  type    = string",
    '  default = "ap-northeast-1"',
    "}",
    'resource "aws_instance" "web" {',
    '  ami           = "ami-123"',
    '  instance_type = "t3.micro"',
    "  tags = {",
    '    Name = "web-${var.region}"',
    "  }",
    "}",
    'resource "aws_eip" "ip" {',
    "  instance = aws_instance.web.id",
    "}",
    "",
  ].join("\n"));
}

describe("iac 工具环 e2e（iac_* 四只读工具 · ReadOnly 模式可用）", () => {
  test("四工具 result_summary 可观测（blocks/plan 计数/graph 拓扑/generate 往返 —— native 块与 lib 同源）", () => {
    WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    seedToolsWs();
    const fixture = path.join(TEST_RUN, `iac-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"iac_parse","args":{"file":"infra/main.tf"}}</tool>',
        '<tool>{"name":"iac_plan","args":{"file":"infra/main.tf"}}</tool>',
        '<tool>{"name":"iac_graph","args":{"file":"infra/main.tf"}}</tool>',
        '<tool>{"name":"iac_generate","args":{"manifest":{"provider":"aws","region":"ap-northeast-1","resources":[{"type":"aws_instance","name":"app","attrs":{"ami":"ami-1","instance_type":{"$ref":"var.instance_type"}}}]}}}</tool>',
        "最终答案：四工具全部可观测。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-iac-tools", "four");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) IaC 工具环接线测试",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "iac-tools", ORG_ASK_QUESTION: "接线测试", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
    expect(tr.length).toBe(4);
    expect(tr[0]).toContain("iac_parse ok blocks=3 infra/main.tf");
    expect(tr[1]).toContain("iac_plan ok create=2 data=0 vars=1 lane=builtin");
    expect(tr[2]).toContain("iac_graph ok nodes=3 edges=2 top=var.region");
    expect(tr[3]).toMatch(/^iac_generate ok aws 资源1 变量2 tf=\d+字符 往返✓$/);
  }, 120_000);

  test("jail 铁律：iac_parse 越界 file → error 摘要 + 越界文案（拒绝先于读盘）", () => {
    WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    seedToolsWs();
    const fixture = path.join(TEST_RUN, `iac-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"iac_parse","args":{"file":"../../etc/passwd"}}</tool>',
        "最终答案：越界被拒。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-iac-tools", "jail");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) IaC 越界拒绝",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "iac-tools", ORG_ASK_QUESTION: "越界", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("iac_parse error [jail]");
    expect(tr[0]).toContain("路径越界");
  }, 120_000);
});

// ---- 10. CLI 冒烟（runOrg 真子进程） ------------------------------------------------

describe("iac CLI 冒烟（org iac）", () => {
  let ws: string;
  beforeAll(() => {
    ws = path.join(TEST_RUN, "iac-cli-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(path.join(ws, "infra"), { recursive: true });
    fs.writeFileSync(path.join(ws, "infra", "main.tf"), [
      'variable "region" {',
      "  type    = string",
      '  default = "ap-northeast-1"',
      "}",
      'resource "aws_instance" "web" {',
      '  ami           = "ami-123"',
      '  instance_type = "t3.micro"',
      "}",
      'resource "aws_eip" "ip" {',
      "  instance = aws_instance.web.id",
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(ws, "manifest.json"), JSON.stringify({
      provider: "aws", region: "ap-northeast-1",
      resources: [{ type: "aws_instance", name: "app", attrs: { ami: "ami-1", instance_type: { $ref: "var.instance_type" } } }],
    }, null, 2));
  });
  afterAll(() => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
  });

  test("org iac parse：块清单 + 属性名；org iac plan：Plan 文案", () => {
    const p = runOrg(["iac", "parse", "infra/main.tf", "--workspace", ws]);
    expect(p.ok).toBe(true);
    expect(p.stdout).toContain("解析成功");
    expect(p.stdout).toContain("aws_instance web");
    expect(p.stdout).toContain("[ami, instance_type]");
    const pl = runOrg(["iac", "plan", "infra/main.tf", "--workspace", ws]);
    expect(pl.ok).toBe(true);
    expect(pl.stdout).toContain("Plan: to create 2 resources");
    expect(pl.stdout).toContain("诚实边界");
  }, 120_000);

  test("org iac graph：边 + 拓扑序；org iac probe：五面 + 内置车道指引", () => {
    const g = runOrg(["iac", "graph", "infra/main.tf", "--workspace", ws]);
    expect(g.ok).toBe(true);
    expect(g.stdout).toContain("aws_eip.ip");
    expect(g.stdout).toContain("拓扑序");
    expect(g.stdout).toContain("var.region → aws_instance.web → aws_eip.ip");
    const p = runOrg(["iac", "probe"]);
    expect(p.ok).toBe(true);
    expect(p.stdout).toContain("terraform");
    expect(p.stdout).toContain("tofu");
    expect(p.stdout).toContain("tflint");
    // 沙箱全缺席 → builtin 主车道文案；CI 若预装 terraform（罕见）也不锁断言
    expect(p.stdout).toMatch(/车道\s+(builtin|cli)/);
  }, 120_000);

  test("org iac generate manifest.json：.tf 文本 + 往返自解析；org iac self-test 全过", () => {
    const g = runOrg(["iac", "generate", "manifest.json", "--workspace", ws]);
    expect(g.ok).toBe(true);
    expect(g.stdout).toContain('provider "aws" {');
    expect(g.stdout).toContain("instance_type = var.instance_type");
    expect(g.stdout).toContain("往返自解析 ✓");
    const st = runOrg(["iac", "self-test"]);
    expect(st.ok).toBe(true);
    expect(st.stdout).toMatch(/\d+\/\d+ 通过/);
  }, 120_000);

  test("org iac parse 越界 → exit 1 + 越界文案；语法错误 → 行号", () => {
    const esc = runOrg(["iac", "parse", "../../etc/passwd", "--workspace", ws]);
    expect(esc.ok).toBe(false);
    expect(esc.stderr).toContain("越界");
    fs.writeFileSync(path.join(ws, "infra", "bad.tf"), 'resource "a" "b" {\n  v = "unclosed\n}\n');
    const syn = runOrg(["iac", "parse", "infra/bad.tf", "--workspace", ws]);
    expect(syn.ok).toBe(false);
    expect(syn.stderr).toContain("syntax");
    expect(syn.stderr).toContain("第 2 行");
  }, 120_000);
});

// ---- 11. Web 端点 e2e（startWebServer · port 0 随机，web.test.ts 同款） --------------

describe("iac Web 端点（GET /api/govex/iac）", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;

  beforeAll(async () => {
    ws = path.join(TEST_RUN, "iac-web-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), ws, { recursive: true });
    fs.mkdirSync(path.join(ws, "infra"), { recursive: true });
    fs.writeFileSync(path.join(ws, "infra", "main.tf"), [
      'variable "region" {',
      "  type    = string",
      '  default = "ap-northeast-1"',
      "}",
      'resource "aws_instance" "web" {',
      '  ami           = "ami-123"',
      '  instance_type = "t3.micro"',
      "}",
      'resource "aws_eip" "ip" {',
      "  instance = aws_instance.web.id",
      "}",
      "",
    ].join("\n"));
    server = (await import("../web/entry.ts")).startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.port).toBeGreaterThan(1024);
  }, 120_000);

  afterAll(() => {
    server.stop(true);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 句柄滞后 */ }
  });

  test("action=parse/plan/graph：三动作送达（AST 摘要 / Plan 文案 / 拓扑序）", async () => {
    const p = (await (await fetch(`${base}/api/govex/iac?action=parse&file=infra/main.tf`)).json()) as Record<string, unknown>;
    expect(p.ok).toBe(true);
    expect(p.blocks).toBe(3);
    expect(p.lane).toBe("builtin");
    expect(Array.isArray(p.ast)).toBe(true);
    const pl = (await (await fetch(`${base}/api/govex/iac?action=plan&file=infra/main.tf`)).json()) as Record<string, unknown>;
    expect(pl.ok).toBe(true);
    expect(String(pl.text)).toContain("Plan: to create 2 resources");
    const g = (await (await fetch(`${base}/api/govex/iac?action=graph&file=infra/main.tf`)).json()) as Record<string, unknown>;
    expect(g.ok).toBe(true);
    expect(g.order).toEqual(["var.region", "aws_instance.web", "aws_eip.ip"]);
  }, 60_000);

  test("action=generate：manifest JSON 串（URL 编码）→ .tf + 往返；坏 JSON → 400 诚实", async () => {
    const manifest = JSON.stringify({ provider: "aws", resources: [{ type: "aws_instance", name: "app", attrs: { ami: "ami-1" } }] });
    const g = (await (await fetch(`${base}/api/govex/iac?action=generate&manifest=${encodeURIComponent(manifest)}`)).json()) as Record<string, unknown>;
    expect(g.ok).toBe(true);
    expect(String(g.tf)).toContain('provider "aws" {');
    expect((g.round_trip as { ok: boolean }).ok).toBe(true);
    const bad = (await (await fetch(`${base}/api/govex/iac?action=generate&manifest=${encodeURIComponent("{oops")}`)).json()) as Record<string, unknown>;
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("JSON");
    const badKind = (await (await fetch(`${base}/api/govex/iac?action=generate&manifest=${encodeURIComponent(JSON.stringify({ provider: "aws", resources: [] }))}`)).json()) as Record<string, unknown>;
    expect(badKind.ok).toBe(false);
    expect(Array.isArray(badKind.errors)).toBe(true);
  }, 60_000);

  test("action=probe：五面结构 + 建议；越界 file → 400 jail", async () => {
    const p = (await (await fetch(`${base}/api/govex/iac?action=probe`)).json()) as Record<string, unknown>;
    expect(p.ok).toBe(true);
    for (const k of ["terraform", "tofu", "tflint", "lane", "suggestion"]) expect(p).toHaveProperty(k);
    expect(p.suggestion).toBeTruthy();
    const esc = (await (await fetch(`${base}/api/govex/iac?action=parse&file=../../etc/passwd`)).json()) as Record<string, unknown>;
    expect(esc.ok).toBe(false);
    expect(esc.kind).toBe("jail");
    const missing = (await (await fetch(`${base}/api/govex/iac?action=parse&file=infra/none.tf`)).json()) as Record<string, unknown>;
    expect(missing.ok).toBe(false);
    expect(missing.kind).toBe("missing");
    const unknown = (await (await fetch(`${base}/api/govex/iac?action=wat`)).json()) as Record<string, unknown>;
    expect(unknown.ok).toBe(false);
    expect(String(unknown.error)).toContain("action");
  }, 60_000);

  test("面板 HTML：⚒ IaC深度 Tab 与五组动作按钮在页面（GUI 可达性）", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Iacx");
    expect(html).toContain("⚒ IaC深度");
    expect(html).toContain("gxIacParse");
    expect(html).toContain("gxIacGenerate");
    expect(html).toContain("gxIacProbe");
  }, 60_000);
});
