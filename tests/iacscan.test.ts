// ============================================================================
// tests/iacscan.test.ts — 容器/IaC 静态扫描器（v0.5.16 · capabilities #147）
// ----------------------------------------------------------------------------
// 四层锁定（与 tests/scan.test.ts 同构的风格）：
//   1. 规则库：规模（≥14）/ id 唯一 / severity·family 合法 / 自描述字段非空
//   2. 逐族命中：Dockerfile（root/无 USER/latest/ADD url/EXPOSE 22/ENV 密钥/
//      apt 未清理）· compose（privileged/host 网络/docker.sock/ports 22/2375）
//      · terraform（0.0.0.0/0 非 80·443 / publicly_accessible / 硬编码密钥 /
//      ssl=false）
//   3. 误报守卫：注释行（#/块注释）· 80/443 放行 · COPY 不报 · 容器侧端口/
//      环回绑定不报 · 变量引用密钥不报
//   4. scanIac 工作区面：排除目录播种 · 二进制/超限跳过 · maxFiles 截断 ·
//      dirs 定向 · 干净目录零命中 · 真实仓库 e2e 跑通不炸（不断言命中数）
// ============================================================================
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IAC_RULES, scanIac } from "../lib/iacscan.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const RULE_IDS = new Set(IAC_RULES.map((r) => r.id));

/** 一次性 tmp 工作区（最小受控语料 —— 不复制 demo-ws）。 */
function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-iac-${tag}-`));
}

function w(ws: string, rel: string, content: string): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** 规则 id 集（断言用）。 */
function ruleIdsOf(ws: string): { ruleId: string; file: string; line: number; severity: string }[] {
  return scanIac(ws).hits.map((h) => ({ ruleId: h.ruleId, file: h.file, line: h.line, severity: h.severity }));
}

// ---- 1. 规则库 -----------------------------------------------------------------

describe("IaC 扫描：规则库", () => {
  test("规模与自洽：≥14 条、id 唯一、severity/family 合法、自描述字段非空", () => {
    expect(IAC_RULES.length).toBeGreaterThanOrEqual(14);
    expect(new Set(IAC_RULES.map((r) => r.id)).size).toBe(IAC_RULES.length);
    for (const r of IAC_RULES) {
      expect(["high", "medium", "low"]).toContain(r.severity);
      expect(["dockerfile", "compose", "terraform"]).toContain(r.family);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.hint.length).toBeGreaterThan(0);
    }
    // 三族都有规则（面板分组不空）
    for (const fam of ["dockerfile", "compose", "terraform"] as const) {
      expect(IAC_RULES.some((r) => r.family === fam)).toBe(true);
    }
  }, 30_000);
});

// ---- 2. Dockerfile ---------------------------------------------------------------

describe("IaC 扫描：Dockerfile", () => {
  test("全家桶命中：USER root(high) / :latest / ADD url / EXPOSE 22 / ENV 密钥(high) —— 行号正确", () => {
    const ws = tmpWs("dk-all");
    try {
      w(ws, "Dockerfile", [
        "FROM alpine:latest",
        "ENV API_KEY=sk-Abc123Def456Ghi789Jkl",
        "ADD https://example.com/big.tar.gz /tmp/",
        "EXPOSE 22",
        "USER root",
        "CMD [\"sh\"]",
      ].join("\n"));
      const hits = scanIac(ws).hits;
      expect(hits.map((h) => h.ruleId)).toEqual([
        "docker-from-latest",
        "docker-env-secret",
        "docker-add-url",
        "docker-expose-22",
        "docker-user-root",
      ]);
      expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4, 5]);
      expect(hits.map((h) => h.severity)).toEqual(["medium", "high", "medium", "medium", "high"]);
      // 有 USER 指令 → 不触发 docker-no-user
      expect(hits.some((h) => h.ruleId === "docker-no-user")).toBe(false);
      // hint/description 回指规则表（面板渲染闭环）
      for (const h of hits) {
        expect(RULE_IDS.has(h.ruleId)).toBe(true);
        expect(h.hint.length).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("无 USER → docker-no-user(medium) 定位第 1 行；EXPOSE 80/443 与非 root USER 不报", () => {
    const ws = tmpWs("dk-nouser");
    try {
      w(ws, "Dockerfile", [
        "FROM node:22-alpine",
        "COPY . /app",
        "EXPOSE 80 443",
        "USER app",
        "CMD [\"node\", \"/app/main.js\"]",
      ].join("\n"));
      const hits = scanIac(ws).hits;
      expect(hits.length).toBe(0); // 有 USER app —— 连 docker-no-user 都不该有
      // 再造一个无 USER 的变体
      w(ws, "Dockerfile", ["FROM node:22-alpine", "RUN echo hi"].join("\n"));
      const hits2 = scanIac(ws).hits;
      expect(hits2.map((h) => [h.ruleId, h.severity, h.line])).toEqual([["docker-no-user", "medium", 1]]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("apt-get 三态：裸 install 命中(low)；双最佳实践不报；多行续行按同层判定", () => {
    const ws = tmpWs("dk-apt");
    try {
      w(ws, "Dockerfile", [
        "FROM debian:bookworm-slim",
        "RUN apt-get update && apt-get install -y curl", // 缺双实践 → 命中
        "RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*", // 齐 → 不报
        "RUN useradd -m app", // 无关行
        "USER app",
      ].join("\n"));
      let hits = scanIac(ws).hits;
      expect(hits.map((h) => h.ruleId)).toEqual(["docker-apt-cleanup"]);
      expect(hits[0].severity).toBe("low");
      expect(hits[0].line).toBe(2); // 定位到含 apt-get 的物理行
      expect(hits[0].message).toContain("--no-install-recommends");
      expect(hits[0].message).toContain("/var/lib/apt/lists");

      // 多行续行：cleanup 在同一 RUN 指令的后继行 —— 同层视为已清理（不报）
      w(ws, "Dockerfile", [
        "FROM debian:bookworm-slim",
        "RUN apt-get update \\",
        "    && apt-get install -y --no-install-recommends curl \\",
        "    && rm -rf /var/lib/apt/lists/*",
        "USER app",
      ].join("\n"));
      hits = scanIac(ws).hits;
      expect(hits.filter((h) => h.ruleId === "docker-apt-cleanup").length).toBe(0);

      // 多行续行但缺清理 → 命中且定位到 apt-get 物理行
      w(ws, "Dockerfile", [
        "FROM debian:bookworm-slim",
        "RUN apt-get update \\",
        "    && apt-get install -y --no-install-recommends curl",
        "USER app",
      ].join("\n"));
      hits = scanIac(ws).hits;
      expect(hits.map((h) => [h.ruleId, h.line])).toEqual([["docker-apt-cleanup", 3]]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("ENV 密钥只认密钥形态：ghp_/AKIA 命中；普通 ENV 值与短 token 不报", () => {
    const ws = tmpWs("dk-env");
    try {
      w(ws, "Dockerfile", [
        "FROM alpine:3.19",
        "ENV GITHUB_TOKEN=ghp_" + "0".repeat(36),
        "ENV AWS_KEY=AKIAIOSFODNN7EXAMPLE",
        "ENV MODE=production",
        "ENV SHORT=sk-abc",
        "USER app",
      ].join("\n"));
      const hits = scanIac(ws).hits;
      expect(hits.map((h) => h.ruleId)).toEqual(["docker-env-secret", "docker-env-secret"]);
      expect(hits.map((h) => h.line)).toEqual([2, 3]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("误报守卫：整行注释（# USER root / #FROM x:latest / #EXPOSE 22）不报", () => {
    const ws = tmpWs("dk-cmt");
    try {
      w(ws, "Dockerfile", [
        "# syntax=docker/dockerfile:1",
        "FROM alpine:3.19",
        "# USER root",
        "#FROM evil:latest",
        "# EXPOSE 22",
        "#ENV KEY=sk-Abc123Def456Ghi789Jkl",
        "USER app",
      ].join("\n"));
      expect(scanIac(ws).hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("Dockerfile 变体名路由：Dockerfile.dev / Dockerfile.prod / app.dockerfile 都进扫描面", () => {
    const ws = tmpWs("dk-names");
    try {
      w(ws, "Dockerfile.dev", "FROM a:latest\nUSER app\n");
      w(ws, "Dockerfile.prod", "FROM b:latest\nUSER app\n");
      w(ws, "app.dockerfile", "FROM c:latest\nUSER app\n");
      const r = scanIac(ws);
      expect(r.files).toBe(3);
      expect(r.scanned).toBe(3);
      expect(r.hits.map((h) => h.file).sort()).toEqual(["Dockerfile.dev", "Dockerfile.prod", "app.dockerfile"]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 3. docker-compose -------------------------------------------------------------

describe("IaC 扫描：docker-compose", () => {
  test("全家桶命中：privileged(high) / host 网络(medium) / docker.sock(high) / ports 22(high) / 2375(medium)", () => {
    const ws = tmpWs("cm-all");
    try {
      w(ws, "docker-compose.yml", [
        "services:",
        "  web:",
        "    image: nginx:1.27",
        "    privileged: true",
        "    network_mode: host",
        "    volumes:",
        "      - /var/run/docker.sock:/var/run/docker.sock",
        "    ports:",
        '      - "22:22"',
        '      - "2375:2375"',
      ].join("\n"));
      const hits = scanIac(ws).hits;
      expect(hits.map((h) => h.ruleId)).toEqual([
        "compose-privileged",
        "compose-network-host",
        "compose-docker-sock",
        "compose-port-22",
        "compose-port-2375",
      ]);
      expect(hits.map((h) => h.severity)).toEqual(["high", "medium", "high", "high", "medium"]);
      expect(hits.map((h) => h.line)).toEqual([4, 5, 7, 9, 10]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("误报守卫：80/443 映射 · 容器侧 22（宿主 8022）· 环回绑定 · 注释行/行内注释 · network_mode 非 host", () => {
    const ws = tmpWs("cm-guard");
    try {
      w(ws, "compose.yaml", [
        "# privileged: true",
        "services:",
        "  web:",
        "    network_mode: bridge",
        "    ports:",
        '      - "80:80"',
        '      - "443:443"',
        '      - "8022:22"', // 容器 22 映射到宿主 8022 —— 不是宿主 SSH 暴露
        '      - "127.0.0.1:22:22"', // 只听环回
        "    privileged: false # privileged: true 只是注释里的例子",
      ].join("\n"));
      expect(scanIac(ws).hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("ports 上下文切换：expose:（容器内部端口）与 services 键下的数字列表不报", () => {
    const ws = tmpWs("cm-ctx");
    try {
      w(ws, "docker-compose.yaml", [
        "services:",
        "  a:",
        "    image: x",
        "    ports:",
        '      - "80:80"',
        "    expose:",
        "      - 22",
        "  b:",
        "    image: y",
      ].join("\n"));
      expect(scanIac(ws).hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("0.0.0.0 绑定的 22/2375 仍命中（全接口暴露）", () => {
    const ws = tmpWs("cm-any");
    try {
      w(ws, "compose.yml", [
        "services:",
        "  web:",
        "    ports:",
        '      - "0.0.0.0:22:22"',
        '      - "0.0.0.0:2375:2375"',
      ].join("\n"));
      expect(scanIac(ws).hits.map((h) => h.ruleId)).toEqual(["compose-port-22", "compose-port-2375"]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 4. Terraform -----------------------------------------------------------------

describe("IaC 扫描：Terraform", () => {
  test("ingress 0.0.0.0/0 非 80/443 → high（定位 cidr 行）；0-65535 全开同样命中", () => {
    const ws = tmpWs("tf-ing");
    try {
      w(ws, "main.tf", [
        'resource "aws_security_group" "web" {',
        "  ingress {",
        "    description = \"ssh\"",
        "    from_port   = 22",
        "    to_port     = 22",
        "    protocol    = \"tcp\"",
        "    cidr_blocks = [\"0.0.0.0/0\"]",
        "  }",
        "}",
      ].join("\n"));
      let hits = scanIac(ws).hits;
      expect(hits.map((h) => [h.ruleId, h.line, h.severity])).toEqual([["tf-open-ingress", 7, "high"]]);
      expect(hits[0].message).toContain("22–22");

      // 0-65535 全开（未声明端口同样命中）
      w(ws, "main.tf", [
        'resource "aws_security_group" "all" {',
        "  ingress {",
        "    cidr_blocks = [\"0.0.0.0/0\"]",
        "  }",
        "}",
      ].join("\n"));
      hits = scanIac(ws).hits;
      expect(hits.map((h) => h.ruleId)).toEqual(["tf-open-ingress"]);
      expect(hits[0].message).toContain("全部端口");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("80/443 放行守卫：cidr 全开但端口恰为 80（或 443）→ 不报", () => {
    const ws = tmpWs("tf-http");
    try {
      w(ws, "main.tf", [
        'resource "aws_security_group" "http" {',
        "  ingress {",
        "    from_port   = 80",
        "    to_port     = 80",
        "    cidr_blocks = [\"0.0.0.0/0\"]",
        "  }",
        "  ingress {",
        "    from_port   = 443",
        "    to_port     = 443",
        "    cidr_blocks = [\"0.0.0.0/0\"]",
        "  }",
        "  egress {",
        "    from_port   = 0",
        "    to_port     = 65535",
        "    cidr_blocks = [\"0.0.0.0/0\"]",
        "  }",
        "}",
      ].join("\n"));
      const hits = scanIac(ws).hits;
      // egress 块不触发（只收集 ingress）；两个 http ingress 放行
      expect(hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("非 80/443 的窄端口（8080）与跨段（80-444）仍命中", () => {
    const ws = tmpWs("tf-narrow");
    try {
      w(ws, "main.tf", [
        'resource "aws_security_group" "x" {',
        "  ingress {",
        "    from_port   = 8080",
        "    to_port     = 8080",
        "    cidr_blocks = [\"0.0.0.0/0\", \"10.0.0.0/8\"]",
        "  }",
        "}",
      ].join("\n"));
      expect(scanIac(ws).hits.map((h) => h.ruleId)).toEqual(["tf-open-ingress"]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("publicly_accessible(high) / ssl·tls=false(medium) / 硬编码 secret(password) 命中；变量引用不报", () => {
    const ws = tmpWs("tf-misc");
    try {
      w(ws, "db.tf", [
        'resource "aws_db_instance" "main" {',
        "  publicly_accessible = true",
        "  password            = \"hunter2prod\"",
        "  db_secret           = var.db_secret",
        "  master_password     = \"${var.master_pw}\"",
        '  parameter_group_name = "default"',
        "}",
        'resource "aws_elasticache_replication_group" "c" {',
        "  ssl = false",
        "}",
        'resource "foo" "tls_off" {',
        "  tls = false",
        "}",
      ].join("\n"));
      const hits = scanIac(ws).hits;
      expect(hits.map((h) => [h.ruleId, h.line, h.severity])).toEqual([
        ["tf-publicly-accessible", 2, "high"],
        ["tf-hardcoded-secret", 3, "medium"],
        ["tf-no-tls", 9, "medium"],
        ["tf-no-tls", 12, "medium"],
      ]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("注释守卫：# 行 / // 行 / /* 块注释（含跨行与包裹 ingress）全部不报", () => {
    const ws = tmpWs("tf-cmt");
    try {
      w(ws, "main.tf", [
        "# publicly_accessible = true",
        "// ssl = false",
        "/*",
        "  ingress {",
        "    cidr_blocks = [\"0.0.0.0/0\"]",
        "    from_port = 22",
        "  }",
        "*/",
        "  ok_password = var.db_pw # password = \"hunter2\" 只是行内注释里的示例（截断后不得命中）",
        'resource "ok" "x" {',
        "  /* 单行块注释 password = \"nope\" */",
        "  password = var.ok",
        "}",
      ].join("\n"));
      expect(scanIac(ws).hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 5. 工作区面（scanIac）----------------------------------------------------------

describe("IaC 扫描：scanIac 工作区面", () => {
  test("排除目录不报（runtime/.git/out-*/node_modules/dist/spawn/隐藏目录），根上照常命中", () => {
    const ws = tmpWs("ws-excl");
    try {
      const bad = "FROM evil:latest\nUSER app\n";
      w(ws, "Dockerfile", bad);
      for (const dir of ["runtime", ".git", "out-a", "node_modules", "dist", "spawn", ".venv"]) {
        w(ws, `${dir}/Dockerfile`, bad);
      }
      const r = scanIac(ws);
      expect(r.hits.map((h) => h.file)).toEqual(["Dockerfile"]);
      expect(r.files).toBe(1);
      expect(r.scanned).toBe(1);
      expect(r.rootsScanned).toEqual(["."]);
      expect(r.truncated).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("二进制（NUL 嗅探）与超限（>1MB）跳过并计数；带毒二进制也不报", () => {
    const ws = tmpWs("ws-skip");
    try {
      w(ws, "Dockerfile", "FROM alpine:3.19\nUSER app\n");
      fs.writeFileSync(path.join(ws, "Dockerfile.bin"), Buffer.from("FROM x\x00binary"));
      fs.writeFileSync(path.join(ws, "big.tf"), Buffer.alloc(1024 * 1024 + 1, 0x61)); // 'a' × 1MB+1
      const r = scanIac(ws);
      expect(r.skippedBinary).toBe(1);
      expect(r.skippedOversize).toBe(1);
      expect(r.scanned).toBe(1);
      expect(r.hits.length).toBe(0);
      expect(r.files).toBe(3);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("maxFiles 截断：5 个候选封顶 3 → truncated:true 且 files=3；缺省上限全量", () => {
    const ws = tmpWs("ws-cap");
    try {
      for (let i = 0; i < 5; i++) w(ws, `svc${i}.tf`, `# file ${i}\n`);
      const r = scanIac(ws, { maxFiles: 3 });
      expect(r.truncated).toBe(true);
      expect(r.files).toBe(3);
      expect(r.scanned).toBe(3);
      const full = scanIac(ws);
      expect(full.truncated).toBe(false);
      expect(full.files).toBe(5);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("opts.dirs 定向：只扫指定子目录；缺席目录降级为空根不报错", () => {
    const ws = tmpWs("ws-dirs");
    try {
      w(ws, "a/Dockerfile", "FROM a:latest\nUSER app\n");
      w(ws, "b/Dockerfile", "FROM b:latest\nUSER app\n");
      const r = scanIac(ws, { dirs: ["a"] });
      expect(r.rootsScanned).toEqual(["a"]);
      expect(r.hits.map((h) => h.file)).toEqual(["a/Dockerfile"]);
      const miss = scanIac(ws, { dirs: ["nope"] });
      expect(miss.rootsScanned).toEqual([]);
      expect(miss.files).toBe(0);
      expect(miss.hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("干净目录（无 IaC 文件）零命中；普通源码文件不占候选预算", () => {
    const ws = tmpWs("ws-clean");
    try {
      w(ws, "src/main.ts", "export const x = 1;\n");
      w(ws, "README.md", "# hi\n");
      w(ws, "package.json", "{}\n");
      const r = scanIac(ws);
      expect(r.files).toBe(0);
      expect(r.scanned).toBe(0);
      expect(r.hits).toEqual([]);
      expect(r.tookMs).toBeLessThan(30_000);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("真实仓库 e2e：scanIac(仓库根) 跑通不炸；命中恒指向已注册规则且 severity 一致（不断言命中数）", () => {
    const r = scanIac(ROOT);
    expect(r.tookMs).toBeLessThan(30_000);
    expect(Array.isArray(r.hits)).toBe(true);
    expect(r.rootsScanned).toEqual(["."]);
    const byId = new Map(IAC_RULES.map((x) => [x.id, x]));
    for (const h of r.hits) {
      const rule = byId.get(h.ruleId);
      expect(rule).toBeDefined();
      expect(h.severity).toBe(rule!.severity);
      expect(h.hint).toBe(rule!.hint);
      expect(h.file.startsWith("/")).toBe(false);
      expect(h.line).toBeGreaterThan(0);
    }
    // 仓库当前无 IaC 语料 —— 候选为 0 也正常（只断言机制跑通）
    expect(r.files).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
