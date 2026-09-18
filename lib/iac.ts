// ============================================================================
// lib/iac.ts — IaC 深度实现层（v0.5.18 · capabilities #44）
// ----------------------------------------------------------------------------
// 与 lib/iacscan.ts（#147，v0.5.16 容器/IaC 静态安全扫描）**互补而非替代**：
//   · iacscan = 「扫描」面 —— Dockerfile / compose / .tf 的危险模式行级匹配
//     （root 容器 · docker.sock · 0.0.0.0 ingress · 硬编码密钥……）；
//   · 本模块 = 「解析 / 规划 / 生成」面 —— HCL（Terraform 子集）词法 + 语法
//     解析 → AST → 资源依赖图（拓扑排序 + 环检测）→ 人读 Plan → JSON manifest
//     逆向生成 .tf（iacParse 往返自洽）。扫描发现「哪里有风险」，本模块回答
//     「这份配置结构是什么、以什么顺序建、如何从清单重建」。
//
// 设计灵魂 = 多重优雅降级（与 lib/cloud.ts 同规的完整链）：
//   ① 内置静态车道（缺省主车道，恒在）：纯内存解析 / 建图 / 计划 / 生成，
//      零外部依赖、确定性输出（tests 锁定）；lane 恒诚实标记 "builtin"；
//   ② 外部 CLI 车道（在场时可用）：probeIac 探测 terraform / tofu / tflint
//      （which + version 解析）；在场时 iacValidate 可对指定目录跑
//      `terraform validate -json`（**只读**——init/plan/apply/destroy 不在
//      任何车道）；缺席 → 内置车道为主车道，reason 附安装指引，绝不假装
//      跑过 terraform；
//   ③ 诚实拒绝（refuse）：路径越工作区监狱（lib/pathjail.ts 同形比较）、
//      manifest 字段非法、语法错误 —— 全部给 kind/行号 + 人读原因，不 throw。
//
// 诚实边界（文件头写明，plan 输出同步标注）：
//   · HCL 子集：block（terraform/provider/resource/data/variable/output/
//     locals/module + 任意具名块）· label（引号/裸）· attribute 赋值 ·
//     string（含 "${...}" 插值与 $${ 转义）/ heredoc（<<TAG 与 <<-TAG）/
//     number / bool / null / list / object · 表达式（traversal/函数调用/
//     二元/三元/索引/括号/splat —— 只建结构不求值）· 注释（# // /* */）；
//   · 不支持（遇之诚实报错，不静默吞掉）：for 表达式（[for …]/[for …]）、
//     模板指令（%{ if } / %{ for }）、dynamic 块的展开语义（块本身可解析）；
//   · 依赖图是引用级：从插值/属性引用（var./local./data./module./资源地址
//     裸引用/depends_on）提取边；resource 中 provider 函数调用的隐式依赖
//     （如 aws_ami data 源的 filter 关系）不在面内；
//   · Plan 与真 terraform plan 的差异：无状态文件（一律计 create，不区分
//     add/change/destroy）· 无 provider schema（属性不校验）· count/for_each
//     只识别不展开 · 变量不求值（引用形保留）—— 计划文本尾注逐条标注。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { inWorkspace, jailRelative, resolveInWorkspace } from "./pathjail.ts";
import { whichTool } from "./cloud.ts";

// ============================================================================
// 1. 词法层（Lexer）—— 逐字符扫描，行号随行推进
// ============================================================================

/** 词法错误（携带 1 基行号与人读原因）。 */
export class IacSyntaxError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(`第 ${line} 行：${message}`);
    this.name = "IacSyntaxError";
    this.line = line;
  }
}

type TokType =
  | "ident"        // 标识符（block 名/属性名/label 裸形/表达式名）
  | "number"       // 数字字面量（int/float）
  | "string"       // 引号字符串（模板部分已切分）
  | "heredoc"      // <<TAG / <<-TAG heredoc（模板部分已切分）
  | "lbrace" | "rbrace" | "lbrack" | "rbrack" | "lparen" | "rparen"
  | "comma" | "eq" | "dot" | "newline" | "op" | "eof";

interface TemplatePart {
  t: "text" | "expr" | "directive";
  text?: string;          // t:text 的字面片段
  expr?: IacExpr;         // t:expr 的插值表达式
  raw?: string;           // t:directive 的原文（%{...}——不支持，错误面）
}

interface Tok {
  type: TokType;
  text: string;           // 原文（op 为算符本体）
  line: number;
  // string/heredoc 附加面：
  parts?: TemplatePart[]; // 模板切分（无插值时 = [{t:"text",text:整串}]）
  tag?: string;           // heredoc 收口标签
  indent?: boolean;       // heredoc <<-（剥公共缩进）
  directive?: boolean;    // 含 %{ 模板指令（不支持 —— 解析层报错）
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_-]*/y;
const NUM_RE = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const TWO_CHAR_OPS = ["==", "!=", "<=", ">=", "&&", "||", "=>"];
const ONE_CHAR_OPS = "+-*/%<>!?:*";

/** HCL 字符串转义表（\uNNNN/\UNNNNNNNN 单独处理）。 */
function unescapeChar(line: number, esc: string): string {
  switch (esc) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case '"': return '"';
    case "\\": return "\\";
    default:
      throw new IacSyntaxError(line, `不支持的字符串转义 \\${esc}（HCL 支持 \\n \\r \\t \\" \\\\ \\uNNNN \\UNNNNNNNN）`);
  }
}

/**
 * 从 content[i] 起（已在 `${` 之后）扫描到匹配的收口 `}`，返回其下标。
 * 大括号配平 + 嵌套字符串（含再嵌套插值）感知 —— `${upper("${var.a}")}` 类
 * 嵌套形态不误切。
 */
function scanInterpEnd(content: string, start: number): number {
  let depth = 1; // 已消费 "${"
  let i = start;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '"') {
      // 嵌套字符串：跳到闭引号（处理转义与嵌套插值）
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === "\\") { i += 2; continue; }
        if (content[i] === "$" && content[i + 1] === "{") {
          const end = scanInterpEnd(content, i + 2);
          i = end + 1;
          continue;
        }
        i++;
      }
      if (i >= content.length) return -1; // 未闭合（调用方报行号）
    }
    i++;
  }
  return -1;
}

/** 模板切分：把字符串/heredoc 体切成 text/expr 部分（$${ → 字面 ${，%%{ → 字面 %{）。 */
function scanTemplate(body: string, startLine: number): { parts: TemplatePart[]; directive: boolean } {
  const parts: TemplatePart[] = [];
  let buf = "";
  let directive = false;
  let i = 0;
  const lineOf = (): number => startLine + (body.slice(0, i).match(/\n/g)?.length ?? 0);
  const flush = () => { if (buf.length > 0) { parts.push({ t: "text", text: buf }); buf = ""; } };
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "$" && body[i + 1] === "$" && body[i + 2] === "{") { buf += "${"; i += 3; continue; }
    if (ch === "%" && body[i + 1] === "%" && body[i + 2] === "{") { buf += "%{"; i += 3; continue; }
    if (ch === "$" && body[i + 1] === "{") {
      const end = scanInterpEnd(body, i + 2);
      if (end < 0) throw new IacSyntaxError(lineOf(), "插值 ${ 未闭合（缺收口 }）");
      const raw = body.slice(i + 2, end);
      flush();
      parts.push({ t: "expr", expr: parseExprSlice(raw, lineOf()) });
      i = end + 1;
      continue;
    }
    if (ch === "%" && body[i + 1] === "{") {
      // 模板指令（if/for/strip）——不支持子集，标记后由解析层诚实报错
      let end = body.indexOf("}", i + 2);
      if (end < 0) end = body.length - 1;
      flush();
      parts.push({ t: "directive", raw: body.slice(i, end + 1) });
      directive = true;
      i = end + 1;
      continue;
    }
    if (ch === "\\") {
      const esc = body[i + 1] ?? "";
      if (esc === "u" || esc === "U") {
        // \uNNNN（4 位）/ \UNNNNNNNN（8 位）码点
        const width = esc === "u" ? 4 : 8;
        const hex = body.slice(i + 2, i + 2 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new IacSyntaxError(lineOf(), `\\${esc} 转义的码点须为 ${width} 位十六进制`);
        buf += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      buf += unescapeChar(lineOf(), esc);
      i += 2;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return { parts, directive };
}

/** 词法主入口：content → token 流（遇错 throw IacSyntaxError）。 */
function lex(content: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = content.length;
  while (i < n) {
    const ch = content[i]!;
    if (ch === "\n") { toks.push({ type: "newline", text: "\n", line }); line++; i++; continue; }
    if (ch === "\r") { i++; continue; } // CRLF 容忍
    if (ch === " " || ch === "\t") { i++; continue; }
    // 注释三形态
    if (ch === "#") { while (i < n && content[i] !== "\n") i++; continue; }
    if (ch === "/" && content[i + 1] === "/") { while (i < n && content[i] !== "\n") i++; continue; }
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (content[k] === "\n") line++;
      if (end < 0) throw new IacSyntaxError(line, "块注释 /* 未闭合（缺 */）");
      i = stop;
      continue;
    }
    // heredoc：<<TAG / <<-TAG
    if (ch === "<" && content[i + 1] === "<") {
      let j = i + 2;
      let indent = false;
      if (content[j] === "-") { indent = true; j++; }
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(content.slice(j));
      if (!m) throw new IacSyntaxError(line, "heredoc 标签须是标识符（<<EOF / <<-EOF）");
      const tag = m[0];
      j += tag.length;
      // 标签后只允许到行尾（空白）
      while (j < n && (content[j] === " " || content[j] === "\t")) j++;
      if (content[j] !== "\n") throw new IacSyntaxError(line, `heredoc 标签 ${tag} 后须直接换行`);
      j++; // 跳过换行
      if (j >= n) throw new IacSyntaxError(line, `heredoc ${tag} 未收口（文件在标签行后即结束）`);
      const startLine = line;
      line++;
      // 收集到「整行（去前导空白）=== tag」的行
      let end = -1;
      let k = j;
      let body = "";
      while (k <= n) {
        let nl = content.indexOf("\n", k);
        if (nl < 0) nl = n;
        const rawLine = content.slice(k, nl);
        if (rawLine.trim() === tag) { end = k; break; }
        body += rawLine + "\n";
        if (nl >= n) break;
        k = nl + 1;
        line++;
      }
      if (end < 0) throw new IacSyntaxError(line, `heredoc ${tag} 未收口（缺 ${tag} 收口行）`);
      let bodyFinal = body;
      if (indent) {
        // <<- 剥公共最小缩进（空行不参与最小值计算）
        const lines = bodyFinal.split("\n");
        let min = Infinity;
        for (const l of lines) { if (l.trim().length === 0) continue; const w = l.match(/^[ \t]*/)![0].length; if (w < min) min = w; }
        if (Number.isFinite(min) && min > 0) bodyFinal = lines.map((l) => (l.trim().length === 0 ? l : l.slice(min))).join("\n");
      } else {
        // << 尾部换行保留（HCL 语义），剥掉最后多余的 \n 由调用方决定 —— 保持原样
      }
      const { parts, directive } = scanTemplate(bodyFinal, startLine + 1);
      toks.push({ type: "heredoc", text: bodyFinal, line: startLine, parts, tag, indent, directive });
      i = end;
      // 跳过收口行（到换行；行号在循环顶推进）
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    // 引号字符串（模板切分在此完成）
    if (ch === '"') {
      const startLine = line;
      let j = i + 1;
      let raw = "";
      let closed = false;
      while (j < n) {
        const c = content[j]!;
        if (c === "\n") throw new IacSyntaxError(line, "字符串未闭合（引号内换行须用 \\ 换行转义或改用 heredoc）");
        if (c === "\\") {
          const esc = content[j + 1] ?? "";
          if (esc === "u" || esc === "U") {
            const width = esc === "u" ? 4 : 8;
            const hex = content.slice(j + 2, j + 2 + width);
            if (!/^[0-9a-fA-F]+$/.test(hex)) throw new IacSyntaxError(line, `\\${esc} 转义的码点须为 ${width} 位十六进制`);
            raw += String.fromCodePoint(parseInt(hex, 16));
            j += 2 + width;
            continue;
          }
          raw += "\\" + esc; // 转义符保留原形，模板层统一解码
          j += 2;
          continue;
        }
        if (c === "$" && content[j + 1] === "$" && content[j + 2] === "{") { raw += "$${"; j += 3; continue; }
        if (c === "%" && content[j + 1] === "%" && content[j + 2] === "{") { raw += "%%{"; j += 3; continue; }
        if (c === "$" && content[j + 1] === "{") {
          const end = scanInterpEnd(content, j + 2);
          if (end < 0) throw new IacSyntaxError(line, "插值 ${ 未闭合（缺收口 }）");
          raw += content.slice(j, end + 1); // 插值原文保留，模板层切分
          j = end + 1;
          continue;
        }
        if (c === '"') { closed = true; break; }
        raw += c;
        j++;
      }
      if (!closed) throw new IacSyntaxError(startLine, "字符串未闭合（缺收口 \"）");
      const { parts, directive } = scanTemplate(raw, startLine);
      toks.push({ type: "string", text: raw, line: startLine, parts, directive });
      i = j + 1;
      continue;
    }
    // 标识符
    IDENT_RE.lastIndex = i;
    const im = IDENT_RE.exec(content);
    if (im && im.index === i) {
      toks.push({ type: "ident", text: im[0], line });
      i += im[0].length;
      continue;
    }
    // 数字
    NUM_RE.lastIndex = i;
    const nm = NUM_RE.exec(content);
    if (nm && nm.index === i) {
      toks.push({ type: "number", text: nm[0], line });
      i += nm[0].length;
      continue;
    }
    // 两字符算符优先
    const two = content.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) { toks.push({ type: "op", text: two, line }); i += 2; continue; }
    if ("{}[](),=.".includes(ch)) {
      const map: Record<string, TokType> = { "{": "lbrace", "}": "rbrace", "[": "lbrack", "]": "rbrack", "(": "lparen", ")": "rparen", ",": "comma", "=": "eq", ".": "dot" };
      toks.push({ type: map[ch]!, text: ch, line });
      i++;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) { toks.push({ type: "op", text: ch, line }); i++; continue; }
    throw new IacSyntaxError(line, `无法识别的字符 "${ch}"（0x${ch.codePointAt(0)!.toString(16)}）`);
  }
  toks.push({ type: "eof", text: "", line });
  return toks;
}

// ============================================================================
// 2. AST 与表达式节点
// ============================================================================

/** 表达式节点（只建结构不求值）。 */
export type IacExpr =
  | { kind: "traversal"; root: string; path: string[]; line: number }          // var.region / aws_instance.web.id
  | { kind: "call"; name: string; args: IacExpr[]; line: number }              // upper(var.name)
  | { kind: "binary"; op: string; left: IacExpr; right: IacExpr; line: number } // a + b / a == b
  | { kind: "unary"; op: string; operand: IacExpr; line: number }              // -x / !x
  | { kind: "conditional"; cond: IacExpr; whenTrue: IacExpr; whenFalse: IacExpr; line: number } // c ? a : b
  | { kind: "index"; target: IacExpr; index: IacExpr; line: number }           // a[0]
  | { kind: "splat"; target: IacExpr; suffix?: string[]; line: number }         // a[*] / a.* （splat 后的属性链收在 suffix，保持 splat 顶层）
  | { kind: "num"; value: number; raw: string; line: number }
  | { kind: "str"; parts: TemplatePart[]; line: number }                        // 表达式位置里的字符串（函数实参等）
  | { kind: "boolv"; value: boolean; line: number }                             // 表达式域的 true/false 字面量（IacValue 域的 bool 折叠自这里）
  | { kind: "nullv"; line: number }                                             // 表达式域的 null 字面量
  | { kind: "paren"; inner: IacExpr; line: number };

/** 属性值（attribute RHS）。 */
export type IacValue =
  | { kind: "string"; parts: TemplatePart[]; literal: string | null; line: number } // literal：无插值时的整串（有插值则 null）
  | { kind: "heredoc"; tag: string; indent: boolean; parts: TemplatePart[]; line: number }
  | { kind: "number"; value: number; raw: string; line: number }
  | { kind: "bool"; value: boolean; line: number }
  | { kind: "null"; line: number }
  | { kind: "list"; items: IacValue[]; line: number }
  | { kind: "object"; entries: Array<{ name: string; value: IacValue; line: number }>; line: number }
  | { kind: "expr"; expr: IacExpr; line: number };                              // 裸表达式（var.region / jsonencode(…) / a ? b : c）

/** attribute 赋值：name = value。 */
export interface IacAttr {
  name: string;
  value: IacValue;
  line: number;
}

/** block：type label… { body }。 */
export interface IacBlock {
  type: string;          // terraform / provider / resource / data / variable / output / locals / module / …
  labels: string[];      // 引号或裸 label（按出现序）
  attrs: IacAttr[];
  blocks: IacBlock[];    // 嵌套块（provisioner/ingress/validation/ebs_block_device…）
  line: number;
}

export interface IacParseError {
  line: number;
  message: string;
}

export interface IacParseResult {
  ok: boolean;
  ast: IacBlock[];
  errors: IacParseError[];
  /** 顶层 block 总数（嵌套不计）。 */
  blocks: number;
  /** 全树（含嵌套）attribute 总数。 */
  attrs: number;
}

// ============================================================================
// 3. 语法层（递归下降 Parser）
// ============================================================================

const RESERVED_EXPR_ROOTS = new Set(["for", "if"]); // for 表达式守卫（诚实报错）

class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(off = 0): Tok {
    return this.toks[Math.min(this.pos + off, this.toks.length - 1)]!;
  }

  private next(): Tok {
    return this.toks[this.pos++] ?? this.toks[this.toks.length - 1]!;
  }

  private expect(type: TokType, what: string): Tok {
    const t = this.peek();
    if (t.type !== type) throw new IacSyntaxError(t.line, `期望 ${what}，实际是 ${describeTok(t)}`);
    return this.next();
  }

  private skipNewlines(): void {
    while (this.peek().type === "newline") this.next();
  }

  /** 文件体：到 EOF 的顶层 block/attr 集合（顶层 attr 保留在虚拟 block "__toplevel__"？否——顶层 attr 非法） */
  parseFile(): IacBlock[] {
    const blocks: IacBlock[] = [];
    this.skipNewlines();
    while (this.peek().type !== "eof") {
      const t = this.peek();
      if (t.type !== "ident") throw new IacSyntaxError(t.line, `期望 block 名或属性名（ident），实际是 ${describeTok(t)}（顶层只允许块）`);
      const item = this.parseBodyItem();
      if (item.kind === "block") blocks.push(item.block);
      else throw new IacSyntaxError(item.attr.line, `顶层不允许裸属性 "${item.attr.name}"（HCL 顶层只允许块）`);
      this.skipNewlines();
    }
    return blocks;
  }

  /** 块体成员：block 或 attribute。 */
  private parseBodyItem(): { kind: "block"; block: IacBlock } | { kind: "attr"; attr: IacAttr } {
    const nameTok = this.expect("ident", "名称");
    const name = nameTok.text;
    const nt = this.peek();
    if (nt.type === "eq") {
      this.next();
      const value = this.parseValue();
      // 属性后须换行/EOF/}（HCL 分隔规则）
      const after = this.peek();
      if (after.type !== "newline" && after.type !== "eof" && after.type !== "rbrace") {
        throw new IacSyntaxError(after.line, `属性 "${name}" 赋值后须换行（两个属性不能同行），实际是 ${describeTok(after)}`);
      }
      return { kind: "attr", attr: { name, value, line: nameTok.line } };
    }
    if (nt.type === "eof") throw new IacSyntaxError(nameTok.line, `"${name}" 后意外结束（块须有 label 与 {）`);
    // block：label* '{' body '}'
    const labels: string[] = [];
    while (this.peek().type === "string" || this.peek().type === "ident") {
      const lt = this.next();
      if (lt.type === "string") {
        if (lt.directive) throw new IacSyntaxError(lt.line, `label 字符串含模板指令 ${lt.parts?.find((p) => p.t === "directive")?.raw ?? "%{…}"} —— 不在支持子集内`);
        labels.push(lt.parts!.map((p) => (p.t === "text" ? p.text ?? "" : "")).join(""));
      } else {
        labels.push(lt.text);
      }
    }
    const brace = this.expect("lbrace", `"${name}" 块的 {`);
    const block: IacBlock = { type: name, labels, attrs: [], blocks: [], line: nameTok.line };
    this.parseBodyInto(block);
    const close = this.expect("rbrace", `"${name}" 块的收口 }（第 ${brace.line} 行开块）`);
    void close;
    return { kind: "block", block };
  }

  /** 块体：到 '}' 或 EOF（EOF 悬空 —— 诚实报未收口）。 */
  private parseBodyInto(block: IacBlock): void {
    this.skipNewlines();
    while (this.peek().type !== "rbrace" && this.peek().type !== "eof") {
      const t = this.peek();
      if (t.type !== "ident") throw new IacSyntaxError(t.line, `块内期望属性名或嵌套块名，实际是 ${describeTok(t)}`);
      const item = this.parseBodyItem();
      if (item.kind === "block") block.blocks.push(item.block);
      else block.attrs.push(item.attr);
      this.skipNewlines();
    }
    if (this.peek().type === "eof") {
      const desc = block.labels.length > 0 ? `${block.type} ${block.labels.map((l) => `"${l}"`).join(" ")}` : block.type;
      throw new IacSyntaxError(this.peek().line, `块 "${desc}"（第 ${block.line} 行开）未收口（缺 }）`);
    }
  }

  // ---- 值（attribute RHS / list 元素 / object 成员值） ----

  private parseValue(): IacValue {
    const t = this.peek();
    if (t.type === "string") {
      this.next();
      if (t.directive) {
        const d = t.parts!.find((p) => p.t === "directive")?.raw ?? "%{…}";
        throw new IacSyntaxError(t.line, `模板指令 ${d} 不在支持子集内（%{ if } / %{ for } / strip 标记是诚实边界外）`);
      }
      const literal = t.parts!.every((p) => p.t === "text") ? t.parts!.map((p) => p.text ?? "").join("") : null;
      return { kind: "string", parts: t.parts!, literal, line: t.line };
    }
    if (t.type === "heredoc") {
      this.next();
      if (t.directive) {
        const d = t.parts!.find((p) => p.t === "directive")?.raw ?? "%{…}";
        throw new IacSyntaxError(t.line, `heredoc 内模板指令 ${d} 不在支持子集内`);
      }
      return { kind: "heredoc", tag: t.tag!, indent: t.indent === true, parts: t.parts!, line: t.line };
    }
    // 容器字面量（string/heredoc/list/object）直接返回 —— 容器开头的二元表达式
    // （如 [1] + [2]）极罕见，属诚实边界（不支持子集，不静默吞）
    if (t.type === "lbrack") return this.parseList();
    if (t.type === "lbrace") return this.parseObject();
    // 标量与裸表达式统一走 parseExpr：二元/一元/三元/后缀续接都在此车道
    // （count = var.x + 1 / c = a ? "on" : "off" 等），结果折叠回 IacValue 域
    const expr = this.parseExpr();
    if (expr.kind === "num") return { kind: "number", value: expr.value, raw: expr.raw, line: expr.line };
    if (expr.kind === "boolv") return { kind: "bool", value: expr.value, line: expr.line };
    if (expr.kind === "nullv") return { kind: "null", line: expr.line };
    return { kind: "expr", expr, line: t.line };
  }

  private parseList(): IacValue {
    const open = this.expect("lbrack", "[");
    const items: IacValue[] = [];
    this.skipNewlines();
    while (this.peek().type !== "rbrack") {
      if (this.peek().type === "eof") throw new IacSyntaxError(this.peek().line, "列表未收口（缺 ]，列表在第 " + open.line + " 行开）");
      items.push(this.parseValue());
      this.skipNewlines();
      if (this.peek().type === "comma") { this.next(); this.skipNewlines(); continue; }
      if (this.peek().type === "rbrack") break;
      throw new IacSyntaxError(this.peek().line, `列表元素之间须用逗号或换行分隔，实际是 ${describeTok(this.peek())}`);
    }
    this.expect("rbrack", "]");
    return { kind: "list", items, line: open.line };
  }

  private parseObject(): IacValue {
    const open = this.expect("lbrace", "{");
    // for 表达式守卫：{ for ... }
    if (this.peek().type === "ident" && this.peek().text === "for") {
      throw new IacSyntaxError(this.peek().line, "对象 for 表达式（{ for … }）不在支持子集内（诚实边界）");
    }
    const entries: Array<{ name: string; value: IacValue; line: number }> = [];
    this.skipNewlines();
    while (this.peek().type !== "rbrace") {
      if (this.peek().type === "eof") throw new IacSyntaxError(this.peek().line, `对象未收口（缺 }，对象在第 ${open.line} 行开）`);
      const kt = this.peek();
      let key: string;
      if (kt.type === "ident") { this.next(); key = kt.text; }
      else if (kt.type === "string") {
        this.next();
        if (kt.directive) throw new IacSyntaxError(kt.line, "对象键含模板指令 —— 不在支持子集内");
        key = kt.parts!.map((p) => (p.t === "text" ? p.text ?? "" : "")).join("");
        if (kt.parts!.some((p) => p.t === "expr")) throw new IacSyntaxError(kt.line, "对象键含插值（HCL 对象键不支持动态求值键的静态解析）");
      }
      else throw new IacSyntaxError(kt.line, `对象键须是标识符或字符串，实际是 ${describeTok(kt)}`);
      const sep = this.peek();
      if (sep.type === "eq") this.next();
      else if (sep.type === "op" && sep.text === ":") this.next();
      else throw new IacSyntaxError(sep.line, `对象键 "${key}" 后须是 = 或 :，实际是 ${describeTok(sep)}`);
      const value = this.parseValue();
      entries.push({ name: key, value, line: kt.line });
      this.skipNewlines();
      if (this.peek().type === "comma") { this.next(); this.skipNewlines(); continue; }
      if (this.peek().type === "rbrace") break;
      // 换行分隔（无逗号）：下一成员的键（ident/string）在场 → 继续（HCL 对象允许）
      if (this.peek().type === "ident" || this.peek().type === "string") continue;
      throw new IacSyntaxError(this.peek().line, `对象成员之间须用逗号或换行分隔，实际是 ${describeTok(this.peek())}`);
    }
    this.expect("rbrace", "}");
    return { kind: "object", entries, line: open.line };
  }

  // ---- 表达式（Pratt-lite：三元 > 二元 > 一元 > 后缀 > 主） ----

  private parseExpr(): IacExpr {
    const cond = this.parseBinary();
    if (this.peek().type === "op" && this.peek().text === "?") {
      this.next();
      const whenTrue = this.parseExpr();
      this.expectOp(":");
      const whenFalse = this.parseExpr();
      return { kind: "conditional", cond, whenTrue, whenFalse, line: cond.line };
    }
    return cond;
  }

  private expectOp(text: string): void {
    const t = this.peek();
    if (t.type !== "op" || t.text !== text) {
      if (t.type === "op" && t.text === "=>") throw new IacSyntaxError(t.line, "=>（for 表达式的条件分隔符）不在支持子集内（诚实边界）");
      throw new IacSyntaxError(t.line, `期望算符 "${text}"，实际是 ${describeTok(t)}`);
    }
    this.next();
  }

  private static PRECEDENCE: Record<string, number> = {
    "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4,
    "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
  };

  private parseBinary(minPrec = 1): IacExpr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== "op") break;
      if (t.text === "=>") throw new IacSyntaxError(t.line, "=>（for 表达式的条件分隔符）不在支持子集内（诚实边界）");
      const prec =Parser.PRECEDENCE[t.text];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { kind: "binary", op: t.text, left, right, line: t.line };
    }
    return left;
  }

  private parseUnary(): IacExpr {
    const t = this.peek();
    if (t.type === "op" && (t.text === "-" || t.text === "!")) {
      this.next();
      return { kind: "unary", op: t.text, operand: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): IacExpr {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.type === "dot") {
        // .ident / .number / .* （splat）
        const ahead = this.peek(1);
        // splat 后的属性链收进 suffix（保持 splat 顶层 —— a[*].id 是 splat 投影，不是 index）
        if (node.kind === "splat" && (ahead.type === "ident" || ahead.type === "number")) {
          this.next(); this.next();
          node = { ...node, suffix: [...(node.suffix ?? []), ahead.text] };
          continue;
        }
        if (ahead.type === "ident") { this.next(); this.next(); node = appendPath(node, ahead.text, ahead.line); continue; }
        if (ahead.type === "number") { this.next(); this.next(); node = appendPath(node, ahead.text, ahead.line); continue; }
        if (ahead.type === "op" && ahead.text === "*") { this.next(); this.next(); node = { kind: "splat", target: node, line: t.line }; continue; }
        throw new IacSyntaxError(t.line, `点号后须是属性名/数字/splat，实际是 ${describeTok(ahead)}`);
      }
      if (t.type === "lbrack") {
        this.next();
        const inner = this.peek();
        if (inner.type === "op" && inner.text === "*") {
          this.next();
          this.expect("rbrack", "]");
          node = { kind: "splat", target: node, line: t.line };
          continue;
        }
        const idx = this.parseExpr();
        this.expect("rbrack", "]");
        node = { kind: "index", target: node, index: idx, line: t.line };
        continue;
      }
      break;
    }
    return node;
  }

  private parsePrimary(): IacExpr {
    const t = this.peek();
    if (t.type === "number") { this.next(); return { kind: "num", value: Number(t.text), raw: t.text, line: t.line }; }
    if (t.type === "string") {
      this.next();
      if (t.directive) {
        const d = t.parts!.find((p) => p.t === "directive")?.raw ?? "%{…}";
        throw new IacSyntaxError(t.line, `模板指令 ${d} 不在支持子集内`);
      }
      return { kind: "str", parts: t.parts!, line: t.line };
    }
    if (t.type === "ident" && (t.text === "true" || t.text === "false")) { this.next(); return { kind: "boolv", value: t.text === "true", line: t.line }; }
    if (t.type === "ident" && t.text === "null") { this.next(); return { kind: "nullv", line: t.line }; }
    if (t.type === "ident") {
      // for 表达式守卫：[for x in y : z] 的 for / if 守卫（裸 ident 形态）
      if (RESERVED_EXPR_ROOTS.has(t.text)) {
        const ahead = this.peek(1);
        if (ahead.type === "ident" || ahead.type === "lparen") {
          throw new IacSyntaxError(t.line, `${t.text} 表达式不在支持子集内（for/if 列表推导是诚实边界）`);
        }
      }
      this.next();
      // 函数调用
      if (this.peek().type === "lparen") {
        this.next();
        const args: IacExpr[] = [];
        while (this.peek().type !== "rparen") {
          if (this.peek().type === "eof") throw new IacSyntaxError(this.peek().line, `函数 ${t.text}( 未收口（缺 )）`);
          args.push(this.parseExpr());
          if (this.peek().type === "comma") { this.next(); continue; }
          if (this.peek().type === "rparen") break;
          throw new IacSyntaxError(this.peek().line, `函数实参之间须用逗号分隔，实际是 ${describeTok(this.peek())}`);
        }
        this.expect("rparen", ")");
        return { kind: "call", name: t.text, args, line: t.line };
      }
      return { kind: "traversal", root: t.text, path: [t.text], line: t.line };
    }
    if (t.type === "lparen") {
      this.next();
      const inner = this.parseExpr();
      this.expect("rparen", ")");
      return { kind: "paren", inner, line: t.line };
    }
    throw new IacSyntaxError(t.line, `期望表达式（字面量/标识符/括号/[/{），实际是 ${describeTok(t)}`);
  }

  /** 供 parseExprSlice 用：完整表达式 + 后续须全空白（切片级入口）。 */
  parseSliceExpr(): IacExpr {
    const e = this.parseExpr();
    this.skipNewlines();
    const t = this.peek();
    if (t.type !== "eof") throw new IacSyntaxError(t.line, `插值表达式后有多余内容 ${describeTok(t)}`);
    return e;
  }
}

/** 后缀路径追加：traversal 追段，其余包成 index 语义（结构保留）。 */
function appendPath(node: IacExpr, seg: string, line: number): IacExpr {
  if (node.kind === "traversal") return { ...node, path: [...node.path, seg] };
  // 非 traversal 的 . 访问（如 call(...).attr）→ 语义上是 index；结构上用 traversal 包裹记录
  return { kind: "index", target: node, index: { kind: "str", parts: [{ t: "text", text: seg }], line }, line };
}

function describeTok(t: Tok): string {
  switch (t.type) {
    case "ident": return `标识符 "${t.text}"`;
    case "number": return `数字 ${t.text}`;
    case "string": return "字符串";
    case "heredoc": return `heredoc <<${t.tag ?? ""}`;
    case "newline": return "换行";
    case "eof": return "文件结束";
    default: return `"${t.text}"`;
  }
}

// ---- 插值切片解析（模板层复用 Parser：切片独立词法 + 行号偏移） ----------------

/**
 * 解析插值表达式切片（"${…}" 的 … 部分）。切片独立词法，行号平移到全文
 * （多行插值罕见但诚实处理）。插值后有多余内容 → 诚实报错（不静默吞）。
 */
export function parseExprSlice(raw: string, startLine: number): IacExpr {
  const expr = new Parser(lex(raw)).parseSliceExpr();
  const delta = startLine - 1;
  if (delta === 0) return expr;
  return shiftLines(expr, delta);
}

/** 行号平移（切片 → 全文）：递归重建（表达式不可变共享，重建有界 —— 插值切片短）。 */
function shiftLines(e: IacExpr, delta: number): IacExpr {
  const walk = (x: IacExpr): IacExpr => {
    switch (x.kind) {
      case "call": return { ...x, line: x.line + delta, args: x.args.map(walk) };
      case "binary": return { ...x, line: x.line + delta, left: walk(x.left), right: walk(x.right) };
      case "unary": return { ...x, line: x.line + delta, operand: walk(x.operand) };
      case "conditional": return { ...x, line: x.line + delta, cond: walk(x.cond), whenTrue: walk(x.whenTrue), whenFalse: walk(x.whenFalse) };
      case "index": return { ...x, line: x.line + delta, target: walk(x.target), index: walk(x.index) };
      case "splat": return { ...x, line: x.line + delta, target: walk(x.target), suffix: x.suffix };
      case "paren": return { ...x, line: x.line + delta, inner: walk(x.inner) };
      default: return { ...x, line: x.line + delta } as IacExpr;
    }
  };
  return walk(e);
}

/** 解析 HCL（Terraform 子集）内容。不读文件系统；错误带行号与原因（不 throw）。 */
export function iacParse(content: string): IacParseResult {
  const text = String(content ?? "");
  try {
    const ast = new Parser(lex(text)).parseFile();
    let attrs = 0;
    const countAttrs = (bs: IacBlock[]): void => {
      for (const b of bs) { attrs += b.attrs.length; countAttrs(b.blocks); }
    };
    countAttrs(ast);
    return { ok: true, ast, errors: [], blocks: ast.length, attrs };
  } catch (e) {
    if (e instanceof IacSyntaxError) {
      return { ok: false, ast: [], errors: [{ line: e.line, message: e.message }], blocks: 0, attrs: 0 };
    }
    return { ok: false, ast: [], errors: [{ line: 1, message: `解析器内部错误：${(e as Error).message}` }], blocks: 0, attrs: 0 };
  }
}

// ============================================================================
// 4. 文件入口（jail 铁律 + 尺寸帽 + 二进制嗅探，与 iacscan.ts 同规）
// ============================================================================

const IAC_MAX_FILE_BYTES = 1024 * 1024;

export type IacFileKind = "jail" | "missing" | "binary" | "oversize" | "syntax";

export interface IacFileResult {
  ok: boolean;
  kind?: IacFileKind;
  reason?: string;
  /** 工作区相对路径（正斜杠；越界时原样回显输入）。 */
  file: string;
  ast: IacBlock[];
  errors: IacParseError[];
  tookMs: number;
}

/** 读工作区内 .tf 文件并解析（路径过监狱；1MB 帽；NUL 嗅探 —— 全部诚实降级）。
 *  ws 相对形时相对 process.cwd 解析（与工具环 native 块同口径 —— 面板/CLI 双入口等价）。 */
export function iacParseFile(ws: string, file: string): IacFileResult {
  const t0 = Date.now();
  const wsAbs = path.isAbsolute(String(ws)) ? String(ws) : path.resolve(process.cwd(), String(ws));
  const input = String(file ?? "");
  const abs = resolveInWorkspace(wsAbs, input);
  if (!inWorkspace(wsAbs, abs)) {
    return { ok: false, kind: "jail", reason: `路径越界（须在工作区内）：${input}`, file: input, ast: [], errors: [], tookMs: Date.now() - t0 };
  }
  const rel = jailRelative(wsAbs, abs);
  let buf: Buffer;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      return { ok: false, kind: "missing", reason: `不是常规文件：${rel}`, file: rel, ast: [], errors: [], tookMs: Date.now() - t0 };
    }
    if (st.size > IAC_MAX_FILE_BYTES) {
      return { ok: false, kind: "oversize", reason: `文件超 ${IAC_MAX_FILE_BYTES / 1024}KB 帽：${rel}（${st.size} 字节）`, file: rel, ast: [], errors: [], tookMs: Date.now() - t0 };
    }
    buf = fs.readFileSync(abs);
  } catch {
    return { ok: false, kind: "missing", reason: `文件不存在或不可读：${rel}`, file: rel, ast: [], errors: [], tookMs: Date.now() - t0 };
  }
  if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
    return { ok: false, kind: "binary", reason: `二进制文件（前 4KB 含 NUL）：${rel}`, file: rel, ast: [], errors: [], tookMs: Date.now() - t0 };
  }
  const r = iacParse(buf.toString("utf-8"));
  if (!r.ok) {
    const first = r.errors[0]!;
    return { ok: false, kind: "syntax", reason: `${rel}：第 ${first.line} 行 ${first.message.replace(/^第 \d+ 行：/, "")}`, file: rel, ast: [], errors: r.errors, tookMs: Date.now() - t0 };
  }
  return { ok: true, file: rel, ast: r.ast, errors: [], tookMs: Date.now() - t0 };
}

// ============================================================================
// 5. 资源依赖图（iacGraph：节点 + 边 + 拓扑排序 + 环检测）
// ============================================================================

export type IacNodeKind = "resource" | "data" | "variable" | "local" | "module";

export interface IacGraphNode {
  kind: IacNodeKind;
  /** 资源地址形：resource → type.name；data → data.type.name；variable → var.name；local → local.name；module → module.name。 */
  address: string;
  type?: string;
  name: string;
  line: number;
  /** 该节点的属性数（plan 摘要用）。 */
  attrs: number;
}

export interface IacGraphEdge {
  /** 依赖方（引用者）。 */
  from: string;
  /** 被依赖方（被引用者）。 */
  to: string;
  /** 引用原文（var.region / aws_instance.web.id …）。 */
  via: string;
  line: number;
}

export interface IacGraph {
  ok: boolean;
  reason?: string;
  nodes: IacGraphNode[];
  edges: IacGraphEdge[];
  /** 拓扑序（被依赖在前；确定性：同层按声明序）。有环时为空。 */
  order: string[];
  /** 环清单（每项一条环路径 a → b → a）。 */
  cycles: string[][];
  /** 引用了未声明 var/资源 的引用（诚实警告面）。 */
  undeclaredRefs: Array<{ from: string; via: string; line: number }>;
  summary: { resources: number; dataSources: number; variables: number; locals: number; modules: number };
}

/** 深游 IacValue，收集全部表达式节点。 */
function walkValue(v: IacValue, out: IacExpr[]): void {
  switch (v.kind) {
    case "string": case "heredoc":
      for (const p of v.parts) if (p.t === "expr" && p.expr) out.push(p.expr);
      return;
    case "list":
      for (const it of v.items) walkValue(it, out);
      return;
    case "object":
      for (const en of v.entries) walkValue(en.value, out);
      return;
    case "expr":
      out.push(v.expr);
      return;
    default:
      return;
  }
}

/** 深游表达式，收集全部 traversal 节点。 */
function walkExpr(e: IacExpr, out: Array<{ root: string; path: string[]; line: number }>): void {
  switch (e.kind) {
    case "traversal": out.push({ root: e.root, path: e.path, line: e.line }); return;
    case "call": for (const a of e.args) walkExpr(a, out); return;
    case "binary": walkExpr(e.left, out); walkExpr(e.right, out); return;
    case "unary": walkExpr(e.operand, out); return;
    case "conditional": walkExpr(e.cond, out); walkExpr(e.whenTrue, out); walkExpr(e.whenFalse, out); return;
    case "index": walkExpr(e.target, out); walkExpr(e.index, out); return;
    case "splat": walkExpr(e.target, out); return;
    case "paren": walkExpr(e.inner, out); return;
    default: return;
  }
}

/** 全部块（含嵌套）平铺。 */
function flattenBlocks(blocks: IacBlock[], out: IacBlock[] = []): IacBlock[] {
  for (const b of blocks) { out.push(b); flattenBlocks(b.blocks, out); }
  return out;
}

/** 块内全部属性值（含嵌套块属性 —— 依赖引用可能在任意深度）。 */
function blockExprs(b: IacBlock): IacExpr[] {
  const out: IacExpr[] = [];
  for (const flat of flattenBlocks([b])) {
    for (const a of flat.attrs) walkValue(a.value, out);
  }
  return out;
}

/** 依赖图构建：引用级分析（var./local./data./module./资源地址裸引用/depends_on）。 */
export function iacGraph(ast: IacBlock[]): IacGraph {
  const nodes: IacGraphNode[] = [];
  const index = new Map<string, IacGraphNode>();
  const addNode = (n: IacGraphNode): void => {
    nodes.push(n);
    index.set(n.address, n);
  };
  for (const b of ast) {
    if (b.type === "variable" && b.labels[0]) {
      addNode({ kind: "variable", address: `var.${b.labels[0]}`, name: b.labels[0], line: b.line, attrs: b.attrs.length + b.blocks.reduce((s, x) => s + x.attrs.length, 0) });
    } else if (b.type === "locals") {
      for (const a of b.attrs) {
        // 字面量 local（bool/number/纯串）无依赖语义 → 不入图（诚实降粒度，不虚增节点）
        const nonTrivial = a.value.kind === "expr" || (a.value.kind === "string" && a.value.parts.some((p) => p.t === "expr"));
        if (!nonTrivial) continue;
        addNode({ kind: "local", address: `local.${a.name}`, name: a.name, line: a.line, attrs: 1 });
      }
    } else if (b.type === "resource" && b.labels.length >= 2) {
      addNode({ kind: "resource", address: `${b.labels[0]}.${b.labels[1]}`, type: b.labels[0], name: b.labels[1], line: b.line, attrs: b.attrs.length + b.blocks.reduce((s, x) => s + x.attrs.length, 0) });
    } else if (b.type === "data" && b.labels.length >= 2) {
      addNode({ kind: "data", address: `data.${b.labels[0]}.${b.labels[1]}`, type: b.labels[0], name: b.labels[1], line: b.line, attrs: b.attrs.length + b.blocks.reduce((s, x) => s + x.attrs.length, 0) });
    } else if (b.type === "module" && b.labels[0]) {
      addNode({ kind: "module", address: `module.${b.labels[0]}`, name: b.labels[0], line: b.line, attrs: b.attrs.length });
    }
  }
  // 资源 type 索引（裸引用 aws_instance.web 的根匹配用）
  const resourceTypes = new Set(nodes.filter((n) => n.kind === "resource").map((n) => n.type!));

  const edges: IacGraphEdge[] = [];
  const seenEdge = new Set<string>();
  const undeclared: Array<{ from: string; via: string; line: number }> = [];
  const addEdge = (from: string, to: string, via: string, line: number): void => {
    const key = `${from}→${to}`;
    if (from === to || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ from, to, via, line });
  };

  for (const b of ast) {
    if (b.type !== "resource" && b.type !== "data" && b.type !== "module" && b.type !== "locals") continue;
    let from: string | null = null;
    if (b.type === "resource" && b.labels.length >= 2) from = `${b.labels[0]}.${b.labels[1]}`;
    else if (b.type === "data" && b.labels.length >= 2) from = `data.${b.labels[0]}.${b.labels[1]}`;
    else if (b.type === "module" && b.labels[0]) from = `module.${b.labels[0]}`;
    if (from === null) continue;
    const exprs = blockExprs(b);
    for (const e of exprs) {
      const travs: Array<{ root: string; path: string[]; line: number }> = [];
      walkExpr(e, travs);
      for (const tv of travs) {
        const via = tv.path.join(".");
        if (tv.root === "var" && tv.path.length >= 2) {
          const addr = `var.${tv.path[1]}`;
          if (index.has(addr)) addEdge(from, addr, via, tv.line);
          else undeclared.push({ from, via, line: tv.line });
        } else if (tv.root === "local" && tv.path.length >= 2) {
          const addr = `local.${tv.path[1]}`;
          if (index.has(addr)) addEdge(from, addr, via, tv.line);
          else undeclared.push({ from, via, line: tv.line });
        } else if (tv.root === "data" && tv.path.length >= 3) {
          const addr = `data.${tv.path[1]}.${tv.path[2]}`;
          if (index.has(addr)) addEdge(from, addr, via, tv.line);
          else undeclared.push({ from, via, line: tv.line });
        } else if (tv.root === "module" && tv.path.length >= 2) {
          const addr = `module.${tv.path[1]}`;
          if (index.has(addr)) addEdge(from, addr, via, tv.line);
          else undeclared.push({ from, via, line: tv.line });
        } else if (tv.root === "each" || tv.root === "count" || tv.root === "self" || tv.root === "path" || tv.root === "terraform") {
          // each.value / count.index / self.* / path.module / terraform.workspace —— 上下文内建引用（无图节点，非依赖）
        } else if (tv.path.length >= 2 && resourceTypes.has(tv.root)) {
          // 资源地址裸引用：aws_instance.web.id → 资源节点
          const addr = `${tv.path[0]}.${tv.path[1]}`;
          if (index.has(addr)) addEdge(from, addr, via, tv.line);
          else undeclared.push({ from, via, line: tv.line });
        }
      }
    }
  }
  // locals 逐 attr 建图（local.x 可引用 var.y / 其他 local.z）
  for (const b of ast) {
    if (b.type !== "locals") continue;
    for (const a of b.attrs) {
      const from = `local.${a.name}`;
      const exprs: IacExpr[] = [];
      walkValue(a.value, exprs);
      for (const e of exprs) {
        const travs: Array<{ root: string; path: string[]; line: number }> = [];
        walkExpr(e, travs);
        for (const tv of travs) {
          const via = tv.path.join(".");
          if (tv.root === "var" && tv.path.length >= 2) {
            const addr = `var.${tv.path[1]}`;
            if (index.has(addr)) addEdge(from, addr, via, tv.line);
          } else if (tv.root === "local" && tv.path.length >= 2) {
            const addr = `local.${tv.path[1]}`;
            if (index.has(addr)) addEdge(from, addr, via, tv.line);
          }
        }
      }
    }
  }

  // 拓扑排序（Kahn；同层按声明序 —— 确定性）
  const declOrder = new Map(nodes.map((n, i) => [n.address, i] as const));
  const dependents = new Map<string, string[]>(); // to → from 列表
  const indegree = new Map<string, number>(nodes.map((n) => [n.address, 0] as const));
  for (const e of edges) {
    dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);
    indegree.set(e.from, (indegree.get(e.from) ?? 0) + 1);
  }
  const ready = nodes.filter((n) => (indegree.get(n.address) ?? 0) === 0).map((n) => n.address);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (declOrder.get(a) ?? 0) - (declOrder.get(b) ?? 0));
    const cur = ready.shift()!;
    order.push(cur);
    for (const dep of dependents.get(cur) ?? []) {
      const d = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, d);
      if (d === 0) ready.push(dep);
    }
  }
  const cycles: string[][] = [];
  if (order.length < nodes.length) {
    // 有环：DFS 找环（色标记，最多报 3 条 —— 诚实不刷屏）
    const stuck = new Set(nodes.map((n) => n.address).filter((a) => !order.includes(a)));
    const color = new Map<string, number>(); // 0=白 1=灰 2=黑
    const stack: string[] = [];
    const dfs = (u: string): boolean => {
      color.set(u, 1);
      stack.push(u);
      for (const e of edges) {
        if (e.from !== u) continue;
        if (!stuck.has(e.to)) continue;
        const c = color.get(e.to) ?? 0;
        if (c === 1) {
          const at = stack.indexOf(e.to);
          cycles.push([...stack.slice(at), e.to]);
          if (cycles.length >= 3) return true;
          continue;
        }
        if (c === 0 && dfs(e.to)) return true;
      }
      stack.pop();
      color.set(u, 2);
      return false;
    };
    for (const n of stuck) {
      if ((color.get(n) ?? 0) === 0) { if (dfs(n)) break; }
    }
  }

  const summary = {
    resources: nodes.filter((n) => n.kind === "resource").length,
    dataSources: nodes.filter((n) => n.kind === "data").length,
    variables: nodes.filter((n) => n.kind === "variable").length,
    locals: nodes.filter((n) => n.kind === "local").length,
    modules: nodes.filter((n) => n.kind === "module").length,
  };
  const cycleText = cycles.length > 0 ? cycles[0]!.join(" → ") : "";
  return {
    ok: cycles.length === 0,
    ...(cycles.length > 0 ? { reason: `依赖图有环：${cycleText}（Terraform 同样会拒绝环形依赖 —— 请检查引用方向）` } : {}),
    nodes,
    edges,
    order,
    cycles,
    undeclaredRefs: undeclared,
    summary,
  };
}

// ============================================================================
// 6. Plan 生成（iacPlan：内置静态车道的人读计划）
// ============================================================================

export interface IacPlanResult {
  ok: boolean;
  reason?: string;
  /** 车道恒 "builtin"（内置静态车道 —— 绝不冒充 terraform plan 真输出）。 */
  lane: "builtin";
  text: string;
  summary: { resources: number; dataSources: number; variables: number; locals: number; modules: number };
  /** 拓扑序（被依赖在前）。 */
  order: string[];
  notes: string[];
  cycles?: string[][];
}

/** 表达式 → 人读源形（结构忠实还原；plan 摘要与错误提示共用）。 */
export function renderExpr(e: IacExpr): string {
  switch (e.kind) {
    case "traversal": return e.path.join(".");
    case "call": return `${e.name}(${e.args.map(renderExpr).join(", ")})`;
    case "binary": return `${renderExpr(e.left)} ${e.op} ${renderExpr(e.right)}`;
    case "unary": return `${e.op}${renderExpr(e.operand)}`;
    case "conditional": return `${renderExpr(e.cond)} ? ${renderExpr(e.whenTrue)} : ${renderExpr(e.whenFalse)}`;
    case "index": return `${renderExpr(e.target)}[${renderExpr(e.index)}]`;
    case "splat": return `${renderExpr(e.target)}[*]${(e.suffix ?? []).map((s) => `.${s}`).join("")}`;
    case "num": return e.raw;
    case "str": return `"${e.parts.map((p) => (p.t === "text" ? (p.text ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") : `\${${renderExpr(p.expr!)}}`)).join("")}"`;
    case "paren": return `(${renderExpr(e.inner)})`;
  }
}

/** 值 → 单行内联形（plan 摘要；长结构截断诚实标注）。 */
export function renderValueInline(v: IacValue, depth = 0): string {
  switch (v.kind) {
    case "string": {
      if (v.literal !== null) {
        const s = v.literal.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
        return `"${s.length > 60 ? s.slice(0, 57) + "…" : s}"`;
      }
      const body = v.parts.map((p) => (p.t === "text" ? (p.text ?? "").slice(0, 40) : `\${${renderExpr(p.expr!)}}`)).join("");
      return `"${body.length > 80 ? body.slice(0, 77) + "…" : body}"`;
    }
    case "heredoc": return `<<${v.indent ? "-" : ""}${v.tag} …（heredoc）`;
    case "number": return v.raw;
    case "bool": return String(v.value);
    case "null": return "null";
    case "list": {
      if (v.items.length === 0) return "[]";
      if (v.items.length <= 4 && depth < 2) return `[${v.items.map((it) => renderValueInline(it, depth + 1)).join(", ")}]`;
      return `[…${v.items.length} 项]`;
    }
    case "object": {
      if (v.entries.length === 0) return "{}";
      if (v.entries.length <= 2 && depth < 2) return `{ ${v.entries.map((en) => `${en.name} = ${renderValueInline(en.value, depth + 1)}`).join(", ")} }`;
      return `{ …${v.entries.length} 键 }`;
    }
    case "expr": return renderExpr(v.expr);
  }
}

/** 计划尾注：与真 terraform plan 的差异（诚实边界，逐条可指认）。 */
export const IAC_PLAN_NOTES: readonly string[] = [
  "无状态文件（state）：无法对比云端现状 —— 一律计为 create（真 plan 会区分 add/change/destroy）",
  "无 provider schema：属性名与类型只做语法层解析，不做 provider 侧校验",
  "count / for_each 只识别声明不展开（真 plan 按实例数展开成 N 条）",
  "变量与插值不求值：${var.x} 保持引用形（真 plan 会代入选值）",
  "车道是内置静态解析（org iac plan），不是 terraform plan 子进程输出",
];

/** 生成人读 Plan（"Plan: to create N resources" 风格 + 每资源摘要 + 依赖序）。 */
export function iacPlan(ast: IacBlock[]): IacPlanResult {
  const g = iacGraph(ast);
  const summary = g.summary;
  if (!g.ok) {
    return {
      ok: false, lane: "builtin",
      reason: `计划不可生成：${g.reason ?? "依赖图有环"}`,
      text: "", summary, order: [], notes: [...IAC_PLAN_NOTES],
      ...(g.cycles.length > 0 ? { cycles: g.cycles } : {}),
    };
  }
  const nodeOf = new Map(g.nodes.map((n) => [n.address, n] as const));
  const dependsOn = new Map<string, string[]>();
  for (const e of g.edges) dependsOn.set(e.from, [...(dependsOn.get(e.from) ?? []), e.to]);

  const lines: string[] = [];
  lines.push("IaC 计划（org iac · 内置静态车道 —— 非 terraform plan 真输出，差异见尾注）");
  lines.push("");
  const resNodes = g.order.map((a) => nodeOf.get(a)!).filter((n) => n && (n.kind === "resource" || n.kind === "data" || n.kind === "module"));
  for (const n of resNodes) {
    const deps = (dependsOn.get(n.address) ?? []).filter((d) => nodeOf.get(d)?.kind !== "variable" && nodeOf.get(d)?.kind !== "local");
    if (n.kind === "data") lines.push(`  # ${n.address} will be read（data 源）`);
    else if (n.kind === "module") lines.push(`  # ${n.address} will be created（module）`);
    else lines.push(`  # ${n.address} will be created`);
    if (n.kind === "data") lines.push(`  + data "${n.type}" "${n.name}" {`);
    else if (n.kind === "module") lines.push(`  + module "${n.name}" {`);
    else lines.push(`  + resource "${n.type}" "${n.name}" {`);
    // 摘要属性（≤5 条，来自声明序）
    const b = ast.find((x) => (x.type === "resource" || x.type === "data" || x.type === "module") && addrOfBlock(x) === n.address);
    if (b) {
      const flat = flattenBlocks([b]).flatMap((x) => x.attrs);
      for (const a of flat.slice(0, 5)) {
        lines.push(`      + ${a.name} = ${renderValueInline(a.value)}`);
      }
      if (flat.length > 5) lines.push(`        …（共 ${flat.length} 属性，全量见源文件）`);
      // count/for_each 诚实标注
      if (b.attrs.some((a) => a.name === "count" || a.name === "for_each")) {
        lines.push(`      # 声明了 count/for_each：本计划不展开（真 terraform plan 按实例展开）`);
      }
    }
    if (deps.length > 0) lines.push(`      # 依赖（拓扑序在前）：${deps.join(" · ")}`);
    lines.push("    }");
    lines.push("");
  }
  lines.push(`  Plan: to create ${summary.resources} resources, to read ${summary.dataSources} data sources, to instantiate ${summary.modules} modules; 0 to update, 0 to destroy.`);
  lines.push("");
  lines.push("诚实边界（与真 terraform plan 的差异）：");
  for (const nt of IAC_PLAN_NOTES) lines.push(`  · ${nt}`);
  if (g.undeclaredRefs.length > 0) {
    lines.push(`  ⚠ ${g.undeclaredRefs.length} 处引用了未声明的 var/资源（apply 前须补声明）：`);
    for (const u of g.undeclaredRefs.slice(0, 5)) lines.push(`      ${u.from} → ${u.via}（第 ${u.line} 行）`);
  }

  return {
    ok: true, lane: "builtin",
    text: lines.join("\n"),
    summary, order: g.order, notes: [...IAC_PLAN_NOTES],
  };
}

/** 块 → 图地址形。 */
function addrOfBlock(b: IacBlock): string | null {
  if (b.type === "resource" && b.labels.length >= 2) return `${b.labels[0]}.${b.labels[1]}`;
  if (b.type === "data" && b.labels.length >= 2) return `data.${b.labels[0]}.${b.labels[1]}`;
  if (b.type === "module" && b.labels[0]) return `module.${b.labels[0]}`;
  if (b.type === "variable" && b.labels[0]) return `var.${b.labels[0]}`;
  return null;
}

// ============================================================================
// 7. IaC 代码生成（iacGenerate：JSON manifest → 合法 .tf）
// ============================================================================

export interface IacManifestVariable {
  name: string;
  type?: string;            // "string" | "number" | "bool" | "list(string)" | …（原样落 type =）
  default?: unknown;        // 字面量（string/number/bool/数组/对象）
  description?: string;
  sensitive?: boolean;
}

export interface IacManifestResource {
  type: string;             // aws_instance / google_storage_bucket / …
  name: string;             // web / db / …
  attrs?: Record<string, unknown>;
  count?: number | { $ref: string };
  for_each?: { $ref: string };
  depends_on?: string[];    // 资源地址裸引用清单
}

export interface IacManifestOutput {
  name: string;
  /** 表达式原文（aws_instance.web.id / var.region —— 原样落 value =）。 */
  value: string;
  description?: string;
}

export interface IacManifest {
  provider: string;                 // 本地名（aws/google/azurerm/…）
  provider_source?: string;         // 缺省 hashicorp/<provider>
  provider_version?: string;        // 缺省 "~> 5.0"
  region?: string;                  // 生成 region = var.region + variable "region"
  required_version?: string;        // 缺省 ">= 1.5"
  variables?: IacManifestVariable[];
  resources: IacManifestResource[];
  outputs?: IacManifestOutput[];
}

export interface IacGenerateResult {
  ok: boolean;
  tf: string;
  errors: string[];
  warnings: string[];
  provider: string;
  variables: string[];
  resources: number;
  notes: string[];
  /** 生成后立即用 iacParse 自检（自洽性 —— 逆操作可解析）。 */
  roundTrip: { ok: boolean; blocks?: number; reason?: string };
}

const HCL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TRAVERSAL_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/;

/** JSON 值 → HCL 字面量/引用（$ref 形 → 裸引用；字符串含 ${…} → 插值原样）。 */
function genValue(name: string, v: unknown, depth: number, errs: string[]): string | null {
  const pad = "  ".repeat(depth);
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) { errs.push(`attrs.${name}：数字须为有限值`); return null; }
    return String(v);
  }
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    if (v.includes("${")) {
      if (!iacParse(`o {\n  x = "${v.replace(/"/g, '\\"')}"\n}`).ok) {
        errs.push(`attrs.${name}：字符串含插值但模板不合法：${v.slice(0, 60)}`);
        return null;
      }
      return `"${v.replace(/"/g, '\\"')}"`;
    }
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  if (Array.isArray(v)) {
    const items = v.map((it, i) => genValue(`${name}[${i}]`, it, depth, errs)).filter((s): s is string => s !== null);
    if (items.length !== v.length) return null;
    if (items.length <= 3 && items.every((s) => s.length <= 40 && !s.includes("\n"))) return `[${items.join(", ")}]`;
    return `[\n${items.map((s) => `${pad}  ${s},`).join("\n")}\n${pad}]`;
  }
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.$ref === "string") {
      if (!TRAVERSAL_RE.test(rec.$ref)) {
        errs.push(`attrs.${name}：$ref 须是点分引用形（var.instance_type），实际 "${rec.$ref}"`);
        return null;
      }
      return rec.$ref;
    }
    const entries = Object.entries(rec).filter(([k]) => k !== "$ref");
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, val]) => {
      const kv = genValue(`${name}.${k}`, val, depth + 1, errs);
      return kv === null ? null : `${pad}  ${HCL_IDENT_RE.test(k) ? k : `"${k}"`} = ${kv}`;
    }).filter((s): s is string => s !== null).join("\n")}\n${pad}}`;
  }
  errs.push(`attrs.${name}：不支持的值类型 ${typeof v}（支持 string/number/bool/null/数组/对象/$ref）`);
  return null;
}

/**
 * JSON manifest → 合法 .tf 文本（provider 块 + variable 提取 + resource 块 +
 * output）。生成的文本保证可被 iacParse 解析（roundTrip 字段即时自检）——
 * 生成器与解析器互为逆操作（自洽性由构造保证 + 测试锁定）。
 */
export function iacGenerate(manifest: IacManifest): IacGenerateResult {
  const errs: string[] = [];
  const warnings: string[] = [];
  const m = (manifest ?? {}) as Partial<IacManifest>;
  const providerLocal = String(m.provider ?? "").trim();
  if (!providerLocal) {
    return { ok: false, tf: "", errors: ["manifest.provider 必填（如 \"aws\" / \"google\" / \"azurerm\"）"], warnings, provider: "", variables: [], resources: 0, notes: [], roundTrip: { ok: false, reason: "manifest 无效" } };
  }
  if (providerLocal.includes("/")) {
    errs.push(`manifest.provider 须是本地名（aws），不是 source 地址（${providerLocal}）—— source 走 provider_source 字段`);
  } else if (!HCL_IDENT_RE.test(providerLocal)) {
    errs.push(`manifest.provider "${providerLocal}" 不是合法 HCL 标识符`);
  }
  const providerSource = String(m.provider_source ?? `hashicorp/${providerLocal}`);
  const providerVersion = String(m.provider_version ?? "~> 5.0");
  const requiredVersion = String(m.required_version ?? ">= 1.5");
  const region = m.region != null ? String(m.region) : null;

  const variables: IacManifestVariable[] = [];
  const varNames = new Set<string>();
  const declared = new Set<string>();
  for (const v of Array.isArray(m.variables) ? m.variables : []) {
    const name = String((v as IacManifestVariable)?.name ?? "");
    if (!HCL_IDENT_RE.test(name)) { errs.push(`variables[].name "${name}" 不是合法 HCL 标识符`); continue; }
    if (declared.has(name)) { errs.push(`variables[].name "${name}" 重复声明`); continue; }
    declared.add(name);
    variables.push(v as IacManifestVariable);
    varNames.add(name);
  }

  const resourcesIn: IacManifestResource[] = Array.isArray(m.resources) ? (m.resources as IacManifestResource[]) : [];
  if (resourcesIn.length === 0) errs.push("manifest.resources 必填且非空（至少一个 {type,name,attrs}）");

  // ---- 生成（边写边校验；任一错误 → 整体 ok:false）----
  const out: string[] = [];
  out.push(`# 由 org iac generate 生成（provider ${providerLocal} · ${new Date().toISOString().slice(0, 10)}）`);
  out.push(`# 密钥铁律：凭证走环境变量/凭证链，绝不硬编码进 .tf（iacscan 的 tf-hardcoded-secret 扫的就是这个）`);
  out.push("");
  out.push("terraform {");
  out.push(`  required_version = "${requiredVersion}"`);
  out.push("  required_providers {");
  out.push(`    ${providerLocal} = {`);
  out.push(`      source  = "${providerSource}"`);
  out.push(`      version = "${providerVersion}"`);
  out.push("    }");
  out.push("  }");
  out.push("}");
  out.push("");
  out.push(`provider "${providerLocal}" {`);
  if (region !== null) {
    out.push("  region = var.region");
  } else {
    out.push(`  # region 等连接属性按 provider 习惯补全（manifest.region 缺席 —— 未生成 region 变量）`);
  }
  out.push("}");
  out.push("");

  // 变量提取：region 自动 + $ref 引用但未声明的自动补（type=string 无 default）
  const autoVars: IacManifestVariable[] = [];
  if (region !== null && !declared.has("region")) {
    autoVars.push({ name: "region", type: "string", default: region, description: "部署区域（org iac generate 自动提取）" });
    varNames.add("region");
  }
  const collectRefs = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "object" && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      if (typeof rec.$ref === "string" && rec.$ref.startsWith("var.")) {
        const n = rec.$ref.slice(4);
        if (!varNames.has(n)) {
          varNames.add(n);
          autoVars.push({ name: n, type: "string", description: `（org iac generate 自动提取：被 $ref 引用但 manifest.variables 未声明 —— apply 时须显式传值）` });
          warnings.push(`变量 "${n}" 被 $ref 引用但未声明 —— 已自动补 variable 块（type=string 无 default）`);
        }
      }
      for (const val of Object.values(rec)) collectRefs(val);
      return;
    }
    if (Array.isArray(v)) { for (const it of v) collectRefs(it); return; }
  };
  for (const r of resourcesIn) collectRefs(r.attrs ?? {});
  for (const v of [...autoVars, ...variables]) {
    out.push(`variable "${v.name}" {`);
    if (v.description) out.push(`  description = "${String(v.description).replace(/"/g, '\\"')}"`);
    out.push(`  type        = ${v.type ?? "string"}`);
    if (v.default !== undefined) {
      const dv = genValue(`variables.${v.name}.default`, v.default, 1, errs);
      if (dv !== null) out.push(`  default     = ${dv}`);
    }
    if (v.sensitive === true) out.push("  sensitive   = true");
    out.push("}");
    out.push("");
  }

  // 资源块
  const seenRes = new Set<string>();
  for (const r of resourcesIn) {
    const type = String(r?.type ?? "");
    const name = String(r?.name ?? "");
    if (!HCL_IDENT_RE.test(type)) { errs.push(`resources[].type "${type}" 不是合法 HCL 标识符`); continue; }
    if (!HCL_IDENT_RE.test(name)) { errs.push(`resources[].name "${name}" 不是合法 HCL 标识符`); continue; }
    const addr = `${type}.${name}`;
    if (seenRes.has(addr)) { errs.push(`资源 ${addr} 重复`); continue; }
    seenRes.add(addr);
    out.push(`resource "${type}" "${name}" {`);
    if (r.count !== undefined) {
      const cv = typeof r.count === "number" ? String(r.count) : (r.count as { $ref: string })?.$ref;
      if (cv === undefined || (typeof r.count !== "number" && !TRAVERSAL_RE.test(String(cv)))) errs.push(`resources[${addr}].count 须是数字或 {$ref:"var.x"}`);
      else out.push(`  count = ${cv}`);
    }
    if (r.for_each !== undefined) {
      const fe = (r.for_each as { $ref?: string })?.$ref;
      if (fe === undefined || !TRAVERSAL_RE.test(fe)) errs.push(`resources[${addr}].for_each 须是 {$ref:"var.x" / "local.x"}`);
      else out.push(`  for_each = ${fe}`);
    }
    if (Array.isArray(r.depends_on) && r.depends_on.length > 0) {
      const deps = r.depends_on.map(String);
      for (const d of deps) if (!TRAVERSAL_RE.test(d)) errs.push(`resources[${addr}].depends_on 项 "${d}" 须是资源地址形（aws_instance.web）`);
      out.push(`  depends_on = [${deps.join(", ")}]`);
    }
    const attrs = Object.entries(r.attrs ?? {});
    for (const [k, val] of attrs) {
      if (!HCL_IDENT_RE.test(k)) { errs.push(`resources[${addr}].attrs 键 "${k}" 不是合法 HCL 标识符`); continue; }
      const rendered = genValue(`${addr}.attrs.${k}`, val, 1, errs);
      if (rendered !== null) out.push(`  ${k} = ${rendered}`);
    }
    if (attrs.length === 0 && r.count === undefined && r.for_each === undefined) {
      out.push("  #（manifest 未给 attrs —— 空资源块，按 provider schema 需补必填属性）");
    }
    out.push("}");
    out.push("");
  }

  // 输出块：显式 outputs；缺席时自动每资源一个 <name>_id（引用形，apply 时由 provider 决定真伪）
  const outputsIn: IacManifestOutput[] = Array.isArray(m.outputs) ? (m.outputs as IacManifestOutput[]) : [];
  if (outputsIn.length > 0) {
    for (const o of outputsIn) {
      const oname = String(o?.name ?? "");
      if (!HCL_IDENT_RE.test(oname)) { errs.push(`outputs[].name "${oname}" 不是合法 HCL 标识符`); continue; }
      const oval = String(o?.value ?? "");
      // 表达式原样（裸引用/函数/三元）或字符串模板两种形态都合法 —— 包进块验证（顶层只允许块）
      if (!iacParse(`o {\n  v = ${oval}\n}`).ok && !iacParse(`o {\n  v = "${oval.replace(/"/g, '\\"')}"\n}`).ok) {
        errs.push(`outputs[${oname}].value 不是合法表达式或字符串：${oval.slice(0, 60)}`);
        continue;
      }
      out.push(`output "${oname}" {`);
      if (o.description) out.push(`  description = "${String(o.description).replace(/"/g, '\\"')}"`);
      out.push(`  value       = ${oval}`);
      out.push("}");
      out.push("");
    }
  } else {
    for (const addr of seenRes) {
      const [t, n] = addr.split(".");
      out.push(`output "${n}_id" {`);
      out.push(`  description = "（org iac generate 自动提取：资源 id 引用）"`);
      out.push(`  value       = ${t}.${n}.id`);
      out.push("}");
      out.push("");
    }
    if (seenRes.size > 0) warnings.push(`manifest.outputs 缺席 —— 已自动为每资源生成 <name>_id 输出`);
  }

  if (errs.length > 0) {
    return { ok: false, tf: "", errors: errs, warnings, provider: providerLocal, variables: [...varNames], resources: 0, notes: [], roundTrip: { ok: false, reason: "manifest 校验失败" } };
  }

  const tf = out.join("\n").trimEnd() + "\n";
  const rt = iacParse(tf);
  return {
    ok: rt.ok,
    tf: rt.ok ? tf : "",
    errors: rt.ok ? [] : rt.errors.map((e) => `生成文本未过自解析（不应发生 —— 请报 issue）：${e.line} 行 ${e.message}`),
    warnings,
    provider: providerLocal,
    variables: [...varNames].sort(),
    resources: seenRes.size,
    notes: [
      "采纳路径：保存为 main.tf → terraform init → terraform plan（先看 diff）→ apply（本模块不代跑 init/plan/apply —— 只读边界）",
      "destroy 永不在本模块任何车道（与 lib/cloud.ts 白名单哲学同源）",
      "state 文件含敏感快照 —— 生产走远端 backend（S3/GCS + 锁）",
    ],
    roundTrip: rt.ok ? { ok: true, blocks: rt.blocks } : { ok: false, reason: rt.errors[0]?.message ?? "解析失败" },
  };
}

// ============================================================================
// 8. 外部车道探测与降级（probeIac 五面 + iacValidate 只读车道）
// ============================================================================

export interface IacToolFace {
  available: boolean;
  version: string | null;
  reason?: string;
}

export interface IacProbe {
  /** 面 1：terraform CLI（which + version）。 */
  terraform: IacToolFace;
  /** 面 2：tofu（OpenTofu —— Terraform 的开源分叉，语法同 HCL）。 */
  tofu: IacToolFace;
  /** 面 3：tflint（HCL lint 车道）。 */
  tflint: IacToolFace;
  /** 面 4：主车道判定（任一 IaC CLI 在场 → "cli" 可用；缺席 → "builtin" 恒在）。 */
  lane: "builtin" | "cli";
  /** 面 5：建议（在场 → validate 车道指引；缺席 → 内置车道 + 安装指引）。 */
  suggestion: string;
  tookMs: number;
}

const IAC_PROBE_TIMEOUT_MS = 5_000;

/** 数组参数 spawn + 硬超时 + 输出帽 + 可选 cwd（与 cloud.ts spawnCaptured 同规 + cwd）。 */
function spawnIac(argv: string[], timeoutMs: number, cwd?: string): { exitCode: number | null; stdout: string; stderr: string } | null {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs,
      ...(cwd !== undefined ? { cwd } : {}),
    } as Parameters<typeof Bun.spawnSync>[1]);
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout?.toString() ?? "").slice(0, 64 * 1024),
      stderr: (r.stderr?.toString() ?? "").slice(0, 64 * 1024),
    };
  } catch {
    return null;
  }
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

/** 单面探测：which → version 解析（terraform/tofu 用 `version`，tflint 用 `--version`）。 */
function probeFace(cmd: string, flag: string, versionRe: RegExp, installHint: string): IacToolFace {
  const bin = whichTool(cmd);
  if (bin === null) {
    return { available: false, version: null, reason: `未找到 ${cmd} CLI。${installHint} 降级车道：内置静态车道（iacParse/iacGraph/iacPlan/iacGenerate —— org iac parse/plan/graph/generate）恒在，不依赖任何 CLI。` };
  }
  const v = spawnIac([bin, flag], IAC_PROBE_TIMEOUT_MS);
  if (v === null || v.exitCode !== 0) {
    return { available: false, version: null, reason: `${cmd} 存在但 ${flag} 探活失败（坏安装按缺席降级）：${firstLine(v?.stderr || v?.stdout || "")}` };
  }
  const m = `${v.stdout}\n${v.stderr}`.match(versionRe);
  return { available: true, version: m ? m[1] : firstLine(v.stdout) || firstLine(v.stderr) };
}

/** 五面探测：terraform / tofu / tflint / lane / suggestion（沙箱常态 = 全缺席 → builtin 主车道）。 */
export function probeIac(): IacProbe {
  const t0 = Date.now();
  const terraform = probeFace("terraform", "version", /Terraform\s+v([\w.-]+)/i,
    "安装：https://developer.hashicorp.com/terraform/downloads（brew tap hashicorp/tap && brew install terraform）。");
  const tofu = probeFace("tofu", "version", /(?:OpenTofu|Tofu)\s+v([\w.-]+)/i,
    "安装：https://opentofu.org/docs/intro/install/（Terraform 的开源分叉，HCL 同语法）。");
  const tflint = probeFace("tflint", "--version", /TFLint\s+v?([\w.-]+)/i,
    "安装：https://github.com/terraform-linters/tflint#installation（HCL lint 车道）。");
  const lane: "builtin" | "cli" = terraform.available || tofu.available ? "cli" : "builtin";
  let suggestion: string;
  if (terraform.available || tofu.available) {
    const which = terraform.available ? `terraform ${terraform.version ?? "?"}` : `tofu ${tofu.version ?? "?"}`;
    suggestion = `${which} 在场：外部车道可用 —— org iac validate <dir>（terraform validate -json，只读）可做语法+一致性校验；内置静态车道（parse/graph/plan/generate）仍恒在。注意 validate 前须 terraform init（本模块不代跑）。`;
  } else {
    suggestion = "IaC CLI 全缺席 —— 内置静态车道即主车道（org iac parse/plan/graph/generate，零外部依赖）：解析 .tf → 依赖图 → 人读 Plan → manifest 逆向生成；org iac probe 可随时复查。安装任一 CLI 后 validate 车道自动可用。";
  }
  return { terraform, tofu, tflint, lane, suggestion, tookMs: Date.now() - t0 };
}

export interface IacValidateResult {
  ok: boolean;
  kind?: "tool-absent" | "jail" | "missing" | "failed" | "invalid";
  /** 实际车道（cli = 真跑了 validate；builtin = 缺席降级 —— 绝不冒充）。 */
  lane: "builtin" | "cli";
  reason?: string;
  bin: string;
  argv: string[];
  exitCode: number | null;
  valid: boolean | null;
  diagnostics: Array<{ severity?: string; summary?: string; detail?: string; file?: string; line?: number }>;
  stdout: string;
  stderr: string;
  tookMs: number;
}

/**
 * 外部校验车道（只读）：目录在场且 terraform/tofu 可用时跑 `validate -json`。
 * 缺席 → kind:"tool-absent" + lane:"builtin"（诚实降级，绝不假装跑过）。
 * 诚实边界：validate 需要 init 过的 provider 插件（未 init 会失败 —— 原样回传
 * stderr + init 指引）；init/plan/apply/destroy 不在任何车道。
 */
export function iacValidate(ws: string, dir: string): IacValidateResult {
  const t0 = Date.now();
  const wsAbs = path.isAbsolute(String(ws)) ? String(ws) : path.resolve(process.cwd(), String(ws));
  const input = String(dir ?? "").trim() || ".";
  const abs = resolveInWorkspace(wsAbs, input);
  if (!inWorkspace(wsAbs, abs)) {
    return { ok: false, kind: "jail", lane: "builtin", reason: `目录越界（须在工作区内）：${input}`, bin: "", argv: [], exitCode: null, valid: null, diagnostics: [], stdout: "", stderr: "", tookMs: Date.now() - t0 };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch { /* 消失/不可读 → missing */ }
  if (!isDir) {
    return { ok: false, kind: "missing", lane: "builtin", reason: `目录不存在：${jailRelative(wsAbs, abs)}`, bin: "", argv: [], exitCode: null, valid: null, diagnostics: [], stdout: "", stderr: "", tookMs: Date.now() - t0 };
  }
  const p = probeIac();
  const bin = p.terraform.available ? "terraform" : p.tofu.available ? "tofu" : null;
  if (bin === null) {
    return {
      ok: false, kind: "tool-absent", lane: "builtin",
      reason: `未找到 terraform/tofu CLI —— 内置静态车道（org iac parse/plan/graph <file>）恒在；validate 外部车道缺席是诚实降级，不是失败。${p.terraform.reason ?? ""}`,
      bin: "", argv: [], exitCode: null, valid: null, diagnostics: [], stdout: "", stderr: "", tookMs: Date.now() - t0,
    };
  }
  const binPath = whichTool(bin)!;
  const argv = [binPath, "validate", "-json"];
  const r = spawnIac(argv, 30_000, abs);
  const tookMs = Date.now() - t0;
  if (r === null) {
    return { ok: false, kind: "failed", lane: "cli", reason: `${bin} validate 执行失败或超时（>30s）`, bin, argv, exitCode: null, valid: null, diagnostics: [], stdout: "", stderr: "", tookMs };
  }
  // -json 输出解析（terraform validate -json 契约：{valid, error_count, diagnostics[]}）
  let valid: boolean | null = null;
  let diagnostics: IacValidateResult["diagnostics"] = [];
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "null") as {
      valid?: boolean; error_count?: number;
      diagnostics?: Array<{ severity?: string; summary?: string; detail?: string; range?: { filename?: string; start?: { line?: number } } }>;
    } | null;
    if (j && typeof j === "object") {
      valid = j.valid === true;
      diagnostics = (j.diagnostics ?? []).map((d) => ({
        severity: d.severity, summary: d.summary, detail: d.detail?.slice(0, 500),
        file: d.range?.filename, line: d.range?.start?.line,
      }));
    }
  } catch { /* 输出非 JSON → 走 failed 分支（stderr 原样回传） */ }
  if (valid === null) {
    const hint = /initializ|required providers|plugin|init/i.test(r.stderr)
      ? "（validate 需要 init 过的 provider 插件 —— 先 terraform init；本模块只跑 validate 只读面，不代跑 init）"
      : "";
    return { ok: false, kind: "failed", lane: "cli", reason: `${bin} validate 退出码 ${r.exitCode}（输出非 JSON）${hint}`, bin, argv: [bin, "validate", "-json"], exitCode: r.exitCode, valid: null, diagnostics: [], stdout: r.stdout.slice(0, 4096), stderr: r.stderr.slice(0, 4096), tookMs };
  }
  return {
    ok: valid, ...(valid ? {} : { kind: "invalid" as const }),
    lane: "cli",
    ...(valid ? {} : { reason: `配置校验未通过（${diagnostics.length} 条诊断 —— 逐条见 diagnostics）` }),
    bin, argv: [bin, "validate", "-json"], exitCode: r.exitCode, valid, diagnostics,
    stdout: r.stdout.slice(0, 4096), stderr: r.stderr.slice(0, 4096), tookMs,
  };
}

// ============================================================================
// 9. 自检（iacSelfTest：解析样本 → 断言往返 —— CLI org iac self-test / Web / 测试共用）
// ============================================================================

export interface IacSelfTestCheck {
  ok: boolean;
  name: string;
  detail?: string;
}

export interface IacSelfTestResult {
  ok: boolean;
  passed: number;
  total: number;
  checks: IacSelfTestCheck[];
}

const SELF_TEST_TF = `# self-test corpus
terraform {
  required_version = ">= 1.5"
}
provider "aws" {
  region = var.region
}
variable "region" {
  type    = string
  default = "ap-northeast-1"
}
locals {
  name_prefix = "\${var.region}-app"
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
  instance_type = "t3.micro"
  tags = {
    Name = local.name_prefix
  }
}
resource "aws_eip" "ip" {
  instance = aws_instance.web.id
  depends_on = [aws_instance.web]
}
output "web_id" {
  value = aws_instance.web.id
}
`;

/** 解析器/生成器自检（纯内存，零依赖零网络 —— 与 protocolSelfTest 同风格）。 */
export function iacSelfTest(): IacSelfTestResult {
  const checks: IacSelfTestCheck[] = [];
  const eq = (name: string, ok: boolean, detail?: string) => checks.push({ ok, name, ...(detail !== undefined ? { detail } : {}) });

  const r = iacParse(SELF_TEST_TF);
  eq("多 block 解析（8 块：terraform/provider/variable/locals/data/resource×2/output）", r.ok && r.blocks === 8, `blocks=${r.blocks}`);
  const resWeb = r.ast.find((b) => b.type === "resource" && b.labels[1] === "web");
  eq("resource label 解析（引号 label）", resWeb?.labels.join(".") === "aws_instance.web", resWeb?.labels.join("."));
  const ami = resWeb?.attrs.find((a) => a.name === "ami");
  const amiOk = ami?.value.kind === "expr" && ami.value.expr.kind === "traversal" && ami.value.expr.path.join(".") === "data.aws_ami.ubuntu.id";
  eq("裸引用表达式（ami = data.aws_ami.ubuntu.id 引用识别）", amiOk === true, ami?.value.kind);
  const g = iacGraph(r.ast);
  eq("依赖图：aws_eip.ip → aws_instance.web（属性 + depends_on 双来源去重为 1 边）",
    g.edges.some((e) => e.from === "aws_eip.ip" && e.to === "aws_instance.web") && g.edges.filter((e) => e.from === "aws_eip.ip" && e.to === "aws_instance.web").length === 1,
    `edges=${g.edges.length}`);
  eq("拓扑序（web 在 eip 之前）", g.order.indexOf("aws_instance.web") < g.order.indexOf("aws_eip.ip"), g.order.join(" → "));
  const cyc = iacParse('resource "a" "x" {\n  v = a.y.id\n}\nresource "a" "y" {\n  v = a.x.id\n}\n');
  const gc = iacGraph(cyc.ast);
  eq("环检测（a.x ⇄ a.y 诚实报环）", !gc.ok && gc.cycles.length > 0, gc.cycles[0]?.join(" → "));
  const plan = iacPlan(r.ast);
  eq("Plan 生成（to create 2 resources 文案 + 依赖序）", plan.ok && plan.text.includes("Plan: to create 2 resources"), plan.summary.resources + "");
  const gen = iacGenerate({
    provider: "aws", region: "ap-northeast-1",
    variables: [{ name: "instance_type", type: "string", default: "t3.micro" }],
    resources: [
      { type: "aws_instance", name: "web", attrs: { ami: "ami-0c1234", instance_type: { $ref: "var.instance_type" }, tags: { Name: "web" } } },
    ],
  });
  eq("Generate 往返自洽（生成 .tf → iacParse 可解析）", gen.ok && gen.roundTrip.ok === true, gen.roundTrip.reason ?? `blocks=${gen.roundTrip.blocks}`);
  const roundAst = iacParse(gen.tf);
  const roundRes = roundAst.ast.filter((b) => b.type === "resource");
  const roundAttrs = roundRes[0]?.attrs.find((a) => a.name === "instance_type");
  eq("Generate 语义保真（$ref → var. 裸引用可再解析出来）", roundAttrs?.value.kind === "expr" && roundAttrs.value.expr.kind === "traversal" && roundAttrs.value.expr.path.join(".") === "var.instance_type", roundAttrs?.value.kind);
  const bad = iacParse('resource "aws_instance" "web" {\n  ami = \n}\n');
  eq("错误诚实（行号 + 原因）", !bad.ok && bad.errors[0]?.line === 2, bad.errors[0] ? `${bad.errors[0].line}:${bad.errors[0].message.slice(0, 40)}` : "no error");
  const p = probeIac();
  eq("probe 五面结构（lane 只能 builtin|cli；缺席也有指引）", (p.lane === "builtin" || p.lane === "cli") && p.suggestion.length > 0, `lane=${p.lane}`);

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
