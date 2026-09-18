// ============================================================================
// lib/iacscan.ts — 容器/IaC 配置静态扫描器（v0.5.16 · capabilities #147）
// ----------------------------------------------------------------------------
// 与 lib/scan.ts（密钥扫描器）同族的「安全底线」能力：scan 钉住密钥面，本
// 模块钉住容器/基础设施面 —— Dockerfile / docker-compose / Terraform 三族
// 配置里的高危反模式（root 容器、docker.sock 挂载、0.0.0.0/0 非 HTTP 开放、
// 镜像内落密钥……）。纯静态行级规则，零第三方依赖，零代码执行。
//
// 诚实边界（如实声明，不装完整解析器）：
//   · 不写完整 YAML / HCL parser —— 规则以「行级模式匹配 + 轻量上下文状态」
//     实现：Dockerfile 续行（\）拼接成指令；compose 用 ports: 键切换的列表
//     上下文 + 行内注释截断；tf 用 ingress 块的花括号配平收集。已知不覆盖：
//     compose 端口长语法（target/published 映射）与 flow 风格内联列表
//     （ports: ["22:22"]）、tf 的 type="ingress" 规则形态（无 ingress 块）、
//     $ref / 变量插值的语义求值 —— 都是路线图，先钉住 80% 的高危形态。
//   · 注释跳过：Dockerfile/compose/tf 的整行注释（#、//、/*…*/ 块注释）不
//     报；yaml/tf 的行内注释按「空白+#」截断（YAML/HCL 的注释规则）—— 引号
//     内含 # 的字符串可能被误截，误截方向是漏报（安全侧），不产生假命中。
//   · 引号内的花括号计入 tf 块深度（${var.x} 插值自平衡通常无害；病态字符
//     串可能错位 —— 行级启发式的固有边界）。
//
// 优雅降级（与 scan.ts 同规）：排除 .git/node_modules/runtime/dist/out-*/
// spawn 与一切隐藏【目录】（隐藏【文件】如 .dockerfile 仍扫）；单文件 1MB
// 帽 / 二进制（前 4KB NUL 嗅探）/ 读失败三重跳过计数不连坐；maxFiles（缺省
// 1000，只计 IaC 候选）触顶 truncated:true；缺席目录从 rootsScanned 剔除。
// 全部导出零逃逸 —— 扫描器只读文件系统，任何单点失败降级为计数/空结果。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- 规则自描述（IAC_RULES —— CLI/Web 面板直接渲染的规则目录）----------------

export type IacSeverity = "high" | "medium" | "low";
export type IacFamily = "dockerfile" | "compose" | "terraform";

export interface IacRule {
  /** 稳定 id（IacHit.ruleId 回指）。 */
  id: string;
  /** 规则族 —— 面板分组与文件路由。 */
  family: IacFamily;
  /** 人读名（报告与面板显示）。 */
  name: string;
  severity: IacSeverity;
  /** 为什么这是问题（面板展开说明）。 */
  description: string;
  /** 修复指引（与 IacHit.hint 同文）。 */
  hint: string;
}

export const IAC_RULES: IacRule[] = [
  {
    id: "docker-user-root",
    family: "dockerfile",
    name: "容器以 root 运行（USER root）",
    severity: "high",
    description: "显式声明 USER root —— 容器进程持全部特权，逃逸即宿主机沦陷。",
    hint: "创建并切换专用用户：RUN useradd -m app 后 USER app（或用基础镜像自带用户 node/python）。",
  },
  {
    id: "docker-no-user",
    family: "dockerfile",
    name: "未声明 USER（默认 root）",
    severity: "medium",
    description: "Dockerfile 无 USER 指令 —— 运行时默认以 root 身份运行。",
    hint: "Dockerfile 末尾追加 USER <非 root 用户>。",
  },
  {
    id: "docker-from-latest",
    family: "dockerfile",
    name: "FROM :latest 浮动标签",
    severity: "medium",
    description: ":latest 是漂移指针 —— 同一 Dockerfile 两次构建可能得到不同基础镜像，不可复现。",
    hint: "钉住具体版本或摘要：FROM node:22-alpine / FROM ubuntu@sha256:…。",
  },
  {
    id: "docker-add-url",
    family: "dockerfile",
    name: "ADD 远程 URL",
    severity: "medium",
    description: "ADD 拉远程 URL 无完整性校验，且 ADD 的自动解压语义易被误用。",
    hint: "远程资源在构建期下载并校验后 COPY；本地文件一律用 COPY。",
  },
  {
    id: "docker-apt-cleanup",
    family: "dockerfile",
    name: "apt-get 未瘦身/未同层清理",
    severity: "low",
    description: "apt-get install 层缺 --no-install-recommends 或同层 rm -rf /var/lib/apt/lists/* —— 推荐包与索引残留撑大镜像层。",
    hint: "RUN apt-get update && apt-get install -y --no-install-recommends pkg && rm -rf /var/lib/apt/lists/*（同层完成才有效）。",
  },
  {
    id: "docker-expose-22",
    family: "dockerfile",
    name: "EXPOSE 22（SSH）",
    severity: "medium",
    description: "镜像声明 SSH 端口 —— 容器内跑 sshd 是反模式（面扩大、密钥管理混乱）。",
    hint: "删除 EXPOSE 22；进容器调试用 docker exec / docker debug。",
  },
  {
    id: "docker-env-secret",
    family: "dockerfile",
    name: "ENV 疑似密钥",
    severity: "high",
    description: "ENV 指令含 sk-/ghp_/AKIA 形态的密钥（密钥嗅探思想与 lib/scan.ts 同族）—— 会持久进镜像层与 docker history，任何拿到镜像的人都能读。",
    hint: "密钥走运行时注入（docker run --env-file / 编排 secret）；镜像内绝不落密钥。",
  },
  {
    id: "compose-privileged",
    family: "compose",
    name: "privileged: true",
    severity: "high",
    description: "特权容器近乎拥有宿主机全部权限（设备、内核能力全开）。",
    hint: "按需授予具体能力（cap_add），删除 privileged: true。",
  },
  {
    id: "compose-network-host",
    family: "compose",
    name: "network_mode: host",
    severity: "medium",
    description: "共享宿主网络栈 —— 容器可监听/抢占宿主任意端口，端口隔离失效。",
    hint: "改用桥接网络 + 端口映射；确需低延迟时评估 host 网络的暴露面。",
  },
  {
    id: "compose-docker-sock",
    family: "compose",
    name: "挂载 /var/run/docker.sock",
    severity: "high",
    description: "持有 docker.sock 即可控制宿主机全部容器（起特权容器/挂载宿主根目录）—— 等价交出宿主 root。",
    hint: "移除 docker.sock 挂载；确需容器管理用受控代理（如 docker-socket-proxy）最小化权限。",
  },
  {
    id: "compose-port-22",
    family: "compose",
    name: "ports 暴露宿主 22（SSH）",
    severity: "high",
    description: "端口映射把宿主 22 暴露给容器侧 SSH —— 与宿主 sshd 抢端口/绕过其访问控制。",
    hint: "删除 22 的映射；调试用 docker exec，SSH 进容器是反模式。",
  },
  {
    id: "compose-port-2375",
    family: "compose",
    name: "ports 暴露宿主 2375（Docker API）",
    severity: "medium",
    description: "2375 是 Docker API 明文端口 —— 暴露即任何人可无认证操控容器。",
    hint: "删除 2375 映射；远程管理走 2376 + TLS 或 unix socket / ssh 通道。",
  },
  {
    id: "tf-open-ingress",
    family: "terraform",
    name: "ingress 全网开放非 HTTP 端口",
    severity: "high",
    description: "ingress 块 cidr 0.0.0.0/0 且端口非 80/443 —— 任意来源直达（SSH/RDB/自研服务裸奔公网）。",
    hint: "收窄 cidr_blocks 到业务网段；确需公网只放行 80/443 并在前置 WAF/ALB。",
  },
  {
    id: "tf-publicly-accessible",
    family: "terraform",
    name: "publicly_accessible = true",
    severity: "high",
    description: "RDS/OpenSearch 等资源声明公网可达 —— 数据面直接暴露公网。",
    hint: "改 publicly_accessible = false，走 VPC 内网/私有链路访问。",
  },
  {
    id: "tf-hardcoded-secret",
    family: "terraform",
    name: "硬编码 secret/password",
    severity: "medium",
    description: "secret/password 字段是字面量字符串（非变量引用）—— 密钥进状态文件与版本库。",
    hint: "改变量引用：password = var.db_password（值走 TF_VAR_/secret manager，绝不入 .tf）。",
  },
  {
    id: "tf-no-tls",
    family: "terraform",
    name: "ssl/tls = false",
    severity: "medium",
    description: "传输加密被显式关闭（如 RDS/Redis 的 ssl = false）—— 链路明文。",
    hint: "删除该行（多数资源默认加密）或显式 ssl/tls = true。",
  },
];

/** ruleId → 规则（封闭表；未注册 id 走兜底不 throw）。 */
const RULE_BY_ID = new Map<string, IacRule>(IAC_RULES.map((r) => [r.id, r]));

/** 构造命中（severity/hint 取自规则表 —— 单一事实源）。 */
function hit(ruleId: string, file: string, line: number, message: string): IacHit {
  const rule = RULE_BY_ID.get(ruleId);
  if (!rule) {
    // 规则表封闭，理论不可达；兜底保证零 throw
    return { ruleId, file, line, severity: "medium", message, hint: "" };
  }
  return { ruleId, file, line, severity: rule.severity, message, hint: rule.hint };
}

export interface IacHit {
  /** 回指 IAC_RULES[].id。 */
  ruleId: string;
  /** 工作区相对路径（正斜杠）。 */
  file: string;
  /** 行号（1 基）。 */
  line: number;
  severity: IacSeverity;
  /** 人读命中说明（含具体上下文，如缺了哪个最佳实践）。 */
  message: string;
  /** 修复指引（与规则表同文）。 */
  hint: string;
}

// ---- 文件分类 ----------------------------------------------------------------

/**
 * IaC 候选判定（按 basename）：
 *   dockerfile —— Dockerfile / Dockerfile.* / Dockerfile-* / *.dockerfile
 *   compose    —— docker-compose*.yml|yaml / compose*.yml|yaml
 *   terraform  —— *.tf
 */
function classifyIacFile(base: string): IacFamily | null {
  if (base === "Dockerfile" || /^Dockerfile[.-]/.test(base) || /\.dockerfile$/i.test(base)) return "dockerfile";
  if (/^(?:docker-)?compose[\w.-]*\.ya?ml$/i.test(base)) return "compose";
  if (/\.tf$/i.test(base)) return "terraform";
  return null;
}

// ---- Dockerfile ----------------------------------------------------------------

/** 一条 Dockerfile 指令（续行 \ 拼接；startLine 1 基指向指令首行）。 */
interface DockerInstruction {
  startLine: number;
  /** 续行拼接后的指令全文（行尾 \ 已剥）。 */
  text: string;
  /** 物理行原文（行号定位用）。 */
  lines: string[];
}

/** 组装指令序列：整行注释（# 开头）跳过；未闭合的末尾续行尽力并入。 */
function dockerInstructions(lines: string[]): DockerInstruction[] {
  const out: DockerInstruction[] = [];
  let cur: DockerInstruction | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith("#")) continue; // 整行注释（含 # syntax= parser 指令）
    if (cur === null) cur = { startLine: i + 1, text: "", lines: [] };
    const cont = /\\\s*$/.test(raw);
    const piece = raw.replace(/\\\s*$/, "").trim();
    cur.lines.push(raw);
    cur.text += (cur.text ? " " : "") + piece;
    if (!cont) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** ENV 密钥嗅探：sk-ant-（精确在前）→ sk-（排 ant-）→ ghp 家族 → AKIA/ASIA。
 *  与 lib/scan.ts 的 SECRET_PATTERNS 同族思想，此处只钉 ENV 指令面。 */
const DOCKER_ENV_SECRET_RE =
  /sk-ant-[A-Za-z0-9-]{24,}|sk-(?!ant-)[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{36,40}|(?:AKIA|ASIA)[0-9A-Z]{16}/;

function scanDockerfile(text: string, file: string): IacHit[] {
  const hits: IacHit[] = [];
  const lines = text.split(/\r?\n/);
  const instrs = dockerInstructions(lines);
  let hasUser = false;
  for (const ins of instrs) {
    const kw = ins.text.split(/\s+/)[0]?.toUpperCase() ?? "";
    if (kw === "USER") {
      hasUser = true;
      if (/^USER\s+root\b/i.test(ins.text)) {
        hits.push(hit("docker-user-root", file, ins.startLine, "USER root —— 容器以 root 身份运行"));
      }
    } else if (kw === "FROM") {
      // FROM [--platform=…] repo:latest [AS builder]
      const m = ins.text.match(/FROM\s+(?:--[\w=-]+\s+)*\S*:latest\b/i);
      if (m) hits.push(hit("docker-from-latest", file, ins.startLine, "基础镜像使用浮动标签 :latest —— 构建不可复现"));
    } else if (kw === "ADD") {
      const m = ins.text.match(/^ADD\s+(https?:\/\/\S+)/i);
      if (m) hits.push(hit("docker-add-url", file, ins.startLine, `ADD 远程 URL（${m[1]}）—— 应改用 COPY + 构建期下载校验`));
    } else if (kw === "EXPOSE") {
      const m = ins.text.match(/^EXPOSE\s+(.+)$/i);
      if (m) {
        for (const tok of m[1].split(/\s+/)) {
          const port = tok.split("/")[0];
          if (port === "22") {
            hits.push(hit("docker-expose-22", file, ins.startLine, "EXPOSE 22 —— 镜像声明 SSH 端口（容器内跑 sshd 是反模式）"));
            break;
          }
        }
      }
    } else if (kw === "ENV") {
      // 多行 ENV 逐物理行嗅探，命中即报（每条指令至多一报）
      for (let li = 0; li < ins.lines.length; li++) {
        if (DOCKER_ENV_SECRET_RE.test(ins.lines[li])) {
          hits.push(hit("docker-env-secret", file, ins.startLine + li, "ENV 指令含疑似密钥（sk-/ghp_/AKIA 形态）—— 密钥持久进镜像层与 docker history"));
          break;
        }
      }
    } else if (kw === "RUN") {
      if (/apt-get\s+(?:-{1,2}[\w-]+\s+)*install/.test(ins.text)) {
        const hasRec = ins.text.includes("--no-install-recommends");
        const hasClean = /rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(ins.text);
        if (!hasRec || !hasClean) {
          const miss: string[] = [];
          if (!hasRec) miss.push("--no-install-recommends（未抑制推荐包）");
          if (!hasClean) miss.push("同层 rm -rf /var/lib/apt/lists/*（未清理索引）");
          // 定位：优先「apt-get 与 install 同行」的物理行（install 可能在续行）
          let li = ins.lines.findIndex((l) => /apt-get/.test(l) && /install/.test(l));
          if (li < 0) li = ins.lines.findIndex((l) => /apt-get/.test(l));
          hits.push(hit("docker-apt-cleanup", file, li >= 0 ? ins.startLine + li : ins.startLine, `apt-get install 层缺少最佳实践：${miss.join("；")}`));
        }
      }
    }
  }
  if (instrs.length > 0 && !hasUser) {
    hits.push(hit("docker-no-user", file, 1, "Dockerfile 未声明 USER —— 运行时默认以 root 运行"));
  }
  return hits;
}

// ---- docker-compose -------------------------------------------------------------

/** YAML 注释截断：整行注释 → 空；行内按「空白+#」截断（YAML 规范：# 前须有
 *  空白或行首）。引号内含 " #" 的值会被误截 —— 误截方向是漏报（安全侧）。 */
function stripYamlComment(line: string): string {
  const t = line.trimStart();
  if (t.startsWith("#")) return "";
  const i = line.indexOf(" #");
  return i >= 0 ? line.slice(0, i) : line;
}

function scanCompose(text: string, file: string): IacHit[] {
  const hits: IacHit[] = [];
  const lines = text.split(/\r?\n/);
  // ports 列表上下文：ports: 键行开启，任何其他键行关闭，列表项行保持
  //（只认块式短语法 "host:container"；长语法 target/published 与 flow 内联
  //  列表是诚实边界外的形态，见文件头）
  let inPorts = false;
  for (let i = 0; i < lines.length; i++) {
    const code = stripYamlComment(lines[i]);
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.match(/^([\w.-]+)\s*:/);
    if (key) inPorts = key[1].toLowerCase() === "ports";

    if (/^privileged\s*:\s*true\s*$/i.test(trimmed)) {
      hits.push(hit("compose-privileged", file, i + 1, "privileged: true —— 特权容器近乎宿主机全权"));
    }
    if (/^network_mode\s*:\s*["']?host["']?\s*$/i.test(trimmed)) {
      hits.push(hit("compose-network-host", file, i + 1, "network_mode: host —— 容器共享宿主网络栈，端口隔离失效"));
    }
    if (/\/var\/run\/docker\.sock\s*:/.test(code)) {
      hits.push(hit("compose-docker-sock", file, i + 1, "挂载 /var/run/docker.sock —— 等价交出宿主机容器全权"));
    }
    if (inPorts && /^-/.test(trimmed)) {
      // 短语法端口项：[- "1.2.3.4:]{host}[:container][/proto]；绑定 127.0.0.1/
      // localhost/[::1] 的项只听环回 —— 不算暴露（误报守卫）
      const pm = trimmed.match(
        /^-\s*["']?(?:(\d{1,3}(?:\.\d{1,3}){3}|localhost|\[::1\]):)?(\d+)(?::(\d+))?(?:\/[a-z]+)?["']?\s*$/i,
      );
      if (pm) {
        const bind = (pm[1] ?? "").toLowerCase();
        const hostPort = pm[2];
        if (bind !== "127.0.0.1" && bind !== "localhost" && bind !== "[::1]") {
          if (hostPort === "22") {
            hits.push(hit("compose-port-22", file, i + 1, 'ports 把宿主 22 映射进容器 —— SSH 暴露在宿主网络'));
          } else if (hostPort === "2375") {
            hits.push(hit("compose-port-2375", file, i + 1, "ports 暴露宿主 2375 —— Docker API 明文无认证端口"));
          }
        }
      }
    }
  }
  return hits;
}

// ---- Terraform -------------------------------------------------------------------

/** HCL 行内注释截断（# 与 //，须前置空白 —— HCL 注释规则）。 */
function stripHclLineComment(line: string): string {
  // HCL 行注释：空白+# 或空白+//；引号内含注释符的字符串可能被误截（漏报侧）
  const m = line.match(/\s(?:\/\/|#)/);
  return m && m.index !== undefined ? line.slice(0, m.index) : line;
}

/** 花括号配平差（引号内花括号同样计入 —— ${} 插值自平衡，见文件头边界）。 */
function braceDelta(line: string): number {
  let d = 0;
  for (const ch of line) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

/** ingress 块收集态。 */
interface IngressBlock {
  startLine: number;
  depth: number;
  /** cidr 0.0.0.0/0 所在行（命中定位用）。 */
  cidrLine: number | null;
  from: number | null;
  to: number | null;
}

function feedIngress(b: IngressBlock, line: string, no: number): void {
  if (b.cidrLine === null && line.includes("0.0.0.0/0")) b.cidrLine = no;
  const fm = line.match(/from_port\s*=\s*(-?\d+)/);
  if (fm) b.from = parseInt(fm[1], 10);
  const tm = line.match(/to_port\s*=\s*(-?\d+)/);
  if (tm) b.to = parseInt(tm[1], 10);
}

/** 块收口判定：cidr 全开 且 端口范围不是「仅 80 或 443」→ 命中。 */
function closeIngress(b: IngressBlock, file: string, hits: IacHit[]): void {
  if (b.cidrLine === null) return;
  const httpOnly = b.from !== null && b.from === b.to && (b.from === 80 || b.from === 443);
  if (httpOnly) return;
  const range = b.from !== null ? `${b.from}–${b.to ?? b.from}` : "全部端口（块内未声明 from_port/to_port）";
  hits.push(hit("tf-open-ingress", file, b.cidrLine, `ingress 块 cidr 0.0.0.0/0 开放 ${range} —— 非 80/443，全网可达`));
}

function scanTerraform(text: string, file: string): IacHit[] {
  const hits: IacHit[] = [];
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;
  let ingress: IngressBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // 块注释状态机（/* … */ 可跨行）
    if (inBlockComment) {
      const e = line.indexOf("*/");
      if (e < 0) continue;
      line = line.slice(e + 2);
      inBlockComment = false;
    }
    const bs = line.indexOf("/*");
    if (bs >= 0) {
      const e = line.indexOf("*/", bs + 2);
      if (e >= 0) {
        line = line.slice(0, bs) + " " + line.slice(e + 2);
      } else {
        line = line.slice(0, bs);
        inBlockComment = true;
      }
    }
    const bare = line.trim();
    if (bare.startsWith("#") || bare.startsWith("//")) continue;
    line = stripHclLineComment(line);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (ingress !== null) {
      feedIngress(ingress, line, i + 1);
      ingress.depth += braceDelta(line);
      if (ingress.depth <= 0) {
        closeIngress(ingress, file, hits);
        ingress = null;
      }
      continue; // 块内行不参与单行规则
    }
    if (/(^|\s)ingress\s*\{/.test(line)) {
      const b: IngressBlock = { startLine: i + 1, depth: braceDelta(line), cidrLine: null, from: null, to: null };
      feedIngress(b, line, i + 1);
      if (b.depth <= 0) closeIngress(b, file, hits);
      else ingress = b;
      continue;
    }
    // 单行规则
    if (/publicly_accessible\s*=\s*true\b/i.test(trimmed)) {
      hits.push(hit("tf-publicly-accessible", file, i + 1, "publicly_accessible = true —— 资源（如 RDS/ES）公网可达"));
    }
    if (/\b(?:ssl|tls)\s*=\s*false\b/i.test(trimmed)) {
      hits.push(hit("tf-no-tls", file, i + 1, "传输加密被显式关闭（ssl/tls = false）—— 链路明文"));
    }
    const sm = trimmed.match(/[\w.-]*(?:secret|password)[\w.-]*\s*=\s*"([^"]*)"/i);
    if (sm && sm[1].length > 0 && !sm[1].includes("${")) {
      hits.push(hit("tf-hardcoded-secret", file, i + 1, "secret/password 字段是字面量字符串（非变量引用）—— 密钥进状态文件与版本库"));
    }
  }
  // 文件在 ingress 块中截断（未收口）—— 尽力评估已收集内容
  if (ingress) closeIngress(ingress, file, hits);
  return hits;
}

// ---- 工作区扫描 -------------------------------------------------------------------

export interface IacScanReport {
  /** IaC 候选文件总数（含二进制/超限/读失败跳过；非 IaC 文件不占此数）。 */
  files: number;
  /** 实际进入规则扫描的文件数。 */
  scanned: number;
  hits: IacHit[];
  tookMs: number;
  /** 二进制跳过数（前 4KB NUL 嗅探）。 */
  skippedBinary: number;
  /** 超限跳过数（单文件 > 1MB）。 */
  skippedOversize: number;
  /** 读失败跳过数（stat/read 抛错 —— 逐文件隔离不连坐）。 */
  skippedRead: number;
  /** true = IaC 候选数触到 maxFiles 上限（诚实截断标记）。 */
  truncated: boolean;
  /** 实际扫描的根目录（缺省 ["."]；opts.dirs 里缺席者被剔除）。 */
  rootsScanned: string[];
}

/** 单文件尺寸帽（>1MB 跳过 —— IaC 配置语料远小于此，同时封顶解析成本）。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** IaC 候选文件数帽（缺省）：防大工作区把交互入口拖死。 */
const DEFAULT_MAX_FILES = 1000;
/** 递归深度帽：防病态嵌套。 */
const MAX_DEPTH = 8;

const EXCLUDED_DIRS = new Set([".git", "node_modules", "runtime", "dist", "spawn"]);

/** 排除判定与 lib/scan.ts 同规：具名目录 + out-* 前缀 + 一切隐藏【目录】
 *  （隐藏【文件】如 .dockerfile 仍扫）。 */
function excludedDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (EXCLUDED_DIRS.has(name)) return true;
  return name.startsWith("out-");
}

/** 二进制嗅探：前 4KB 含 NUL（与 scan.ts / search.ts 同规）。 */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(4096, buf.length)).includes(0);
}

interface WalkState {
  candidates: number;
  maxFiles: number;
  truncated: boolean;
}

/** 递归收集 IaC 候选（相对路径正斜杠）。maxFiles 只计候选 —— 普通源码文件
 *  不占预算；符号链接一律跳过（防环 + 防逃逸出工作区）。 */
function walk(ws: string, rel: string, st: WalkState, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || st.truncated) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rel ? path.join(ws, rel) : ws, { withFileTypes: true });
  } catch {
    return; // 目录不可读/消失 → 降级为空
  }
  for (const e of entries) {
    if (st.truncated) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (excludedDir(e.name)) continue;
      walk(ws, childRel, st, out, depth + 1);
    } else if (e.isFile()) {
      if (classifyIacFile(e.name) === null) continue;
      if (st.candidates >= st.maxFiles) {
        st.truncated = true;
        return;
      }
      st.candidates++;
      out.push(childRel);
    }
  }
}

function normalizeRoot(d: string): string {
  return d === "." ? "" : d.replace(/[\\/]+$/, "");
}

/** 扫描工作区的容器/IaC 配置（缺省全工作区；opts.dirs 定向、opts.maxFiles
 *  封顶候选数）。纯静态规则，零执行；逐文件隔离降级。 */
export function scanIac(ws: string, opts?: { dirs?: string[]; maxFiles?: number }): IacScanReport {
  const t0 = Date.now();
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const requested = opts?.dirs && opts.dirs.length > 0 ? opts.dirs : ["."];
  const roots = requested.filter((d) => {
    try {
      return fs.statSync(path.join(ws, d)).isDirectory();
    } catch {
      return false;
    }
  });

  const st: WalkState = { candidates: 0, maxFiles, truncated: false };
  const relFiles: string[] = [];
  for (const r of roots) walk(ws, normalizeRoot(r), st, relFiles, 0);

  let scanned = 0;
  let skippedBinary = 0;
  let skippedOversize = 0;
  let skippedRead = 0;
  const hits: IacHit[] = [];
  for (const rel of relFiles) {
    const abs = path.join(ws, rel);
    let buf: Buffer;
    try {
      const s = fs.statSync(abs);
      if (!s.isFile()) continue;
      if (s.size > MAX_FILE_BYTES) {
        skippedOversize++;
        continue;
      }
      buf = fs.readFileSync(abs);
    } catch {
      skippedRead++;
      continue;
    }
    if (isBinary(buf)) {
      skippedBinary++;
      continue;
    }
    scanned++;
    const kind = classifyIacFile(path.posix.basename(rel));
    const text = buf.toString("utf-8");
    if (kind === "dockerfile") hits.push(...scanDockerfile(text, rel));
    else if (kind === "compose") hits.push(...scanCompose(text, rel));
    else if (kind === "terraform") hits.push(...scanTerraform(text, rel));
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));

  return {
    files: relFiles.length,
    scanned,
    hits,
    tookMs: Date.now() - t0,
    skippedBinary,
    skippedOversize,
    skippedRead,
    truncated: st.truncated,
    rootsScanned: roots,
  };
}
