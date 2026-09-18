// ============================================================================
// tests/scan.test.ts — 密钥扫描器（v0.5.15 · capabilities #141/#144 检测半环）
// ----------------------------------------------------------------------------
// 四层锁定（样本全部是假样本 —— 形态对、值无效）：
//   1. 模式库：规模（≥16）/ id 唯一 / 自洽（每条命中自己的 sample，且
//      maskLine 能把自己的 sample 脱敏掉 —— 检测与脱敏互为闭环）
//   2. scanText：逐类典型密钥命中 · 先精确后宽泛的归属次序 · 多模式同文本
//      全报 · 大小写（.env 风格 (?i)）· 误报守卫（普通 base64 / URL /
//      短 token / 测试键不报）
//   3. 脱敏：preview 永不含完整密钥原文（断言 not.toContain 假样本）
//   4. scanWorkspace：tmp 工作区播种（排除目录不报 / 隐藏文件必扫 / 二进制
//      与超限跳过 / maxFiles 截断 / dirs 定向）+ 真实仓库 e2e（只断言跑通
//      与预算 —— 仓库自带演示密钥与测试假样本，命中数不断言具体值）
// ============================================================================
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SECRET_PATTERNS, scanText, scanWorkspace, maskLine } from "../lib/scan.ts";

const ROOT = path.resolve(import.meta.dir, "..");

/** 一次性 tmp 工作区（不复制 demo-ws —— 扫描器要的是最小受控语料）。 */
function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-scan-${tag}-`));
}

/** 20+ 字符假样本（形态对、值无效 —— OpenAI 宽形态）。 */
const FAKE_OPENAI = "sk-Abc123Def456Ghi789Jkl";

// ---- 1. 模式库 --------------------------------------------------------------

describe("密钥扫描：模式库", () => {
  test("规模与自洽：≥16 条、id 唯一、severity 合法；每条命中自己的 sample 且 maskLine 能把它脱敏掉（检测/脱敏闭环）", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(16);
    expect(new Set(SECRET_PATTERNS.map((p) => p.id)).size).toBe(SECRET_PATTERNS.length);
    for (const p of SECRET_PATTERNS) {
      expect(["high", "medium", "low"]).toContain(p.severity);
      expect(p.regex.test(p.sample)).toBe(true);
      const masked = maskLine(p.sample);
      expect(masked).not.toContain(p.sample); // 脱敏后不含完整原文
      expect(masked).toContain("***");
    }
  }, 30_000);
});

// ---- 2. scanText：逐类命中 ---------------------------------------------------

describe("密钥扫描：scanText 逐类命中", () => {
  test("OpenAI / Anthropic / DeepSeek：归属正确 + 先精确后宽泛（sk-ant- 不落 OpenAI、32-hex 归 DeepSeek）", () => {
    const hits = scanText(
      [
        `const openai = "${FAKE_OPENAI}";`,
        "const anthropic = 'sk-ant-api03-Abc123Def456Ghi789JklMno';",
        "const deepseek = 'sk-00000000000000000000000000000000';",
      ].join("\n"),
      "config.ts",
    );
    expect(hits.map((h) => h.pattern)).toEqual(["openai-key", "anthropic-key", "deepseek-key"]);
    expect(hits[0]).toMatchObject({ severity: "high", file: "config.ts", line: 1 });
    expect(hits[1]).toMatchObject({ severity: "high", line: 2 });
    expect(hits[2]).toMatchObject({ severity: "medium", line: 3 });
    // 每个 key 恰好一报（宽模式不重复计）
    expect(hits.length).toBe(3);
  }, 30_000);

  test("GitHub（ghp_/gho_）· GitLab（glpat-）· AWS（AKIA/ASIA）· Google（AIza）", () => {
    const hits = scanText(
      [
        "ghp_Abc123Def456Ghi789JklMnoPqr456Stu789",
        "gho_Abc123Def456Ghi789JklMnoPqr456Stu789",
        "glpat-Abc123Def456Ghi789Jkl",
        "AKIAABCDEFGHIJ012345 and ASIA0123456789ABCDEF",
        "AIzaAbc123Def456Ghi789JklMnoPqr456Stu78",
      ].join("\n"),
    );
    expect(hits.map((h) => h.pattern)).toEqual([
      "github-token",
      "github-token",
      "gitlab-token",
      "aws-access-key",
      "aws-access-key",
      "google-api-key",
    ]);
    expect(hits.every((h) => h.severity === "high")).toBe(true);
  }, 30_000);

  test("Slack（xoxb-）· Stripe live · 智谱（32hex.16）· 通义（LTAI）· SendGrid（SG.）", () => {
    const hits = scanText(
      [
        "xoxb-123456789012-1234567890123-AbcDefGhiJkl",
        "sk_live_00000000000000000000",
        "zhipu: 0123456789abcdef0123456789abcdef.AbcDefGhiJklMnoP",
        "LTAI5tGAbc123Def456Xy9",
        "SG.0000000000000000000000.0000000000000000000000000000000000000000000",
      ].join("\n"),
    );
    expect(hits.map((h) => h.pattern)).toEqual([
      "slack-token",
      "stripe-live-key",
      "zhipu-key",
      "dashscope-key",
      "sendgrid-key",
    ]);
  }, 30_000);

  test("私钥块头三变体（裸/RSA/OPENSSH）—— 只报头行，每行一报", () => {
    const hits = scanText(
      [
        "-----BEGIN PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", // 身体行：无标记，不报
      ].join("\n"),
    );
    expect(hits.map((h) => h.pattern)).toEqual([
      "private-key-block",
      "private-key-block",
      "private-key-block",
    ]);
    expect(hits.every((h) => h.severity === "high")).toBe(true);
  }, 30_000);

  test("JWT（eyJ 头.eyJ 载荷.签名）", () => {
    const hits = scanText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmctbGFiIn0.AAAAfakeSigAAAA");
    expect(hits.map((h) => h.pattern)).toEqual(["jwt"]);
    expect(hits[0].severity).toBe("medium");
  }, 30_000);

  test("数据库连接串：postgres/mysql 内嵌凭据命中；无凭据 URL 不报", () => {
    const hits = scanText(
      [
        "db1: postgres://alice:S3cretPW@db.internal:5432/prod",
        "db2: mysql://root:toor@127.0.0.1/app",
        "db3: postgres://localhost:5432/app", // 无凭据 —— 不是泄密
      ].join("\n"),
    );
    expect(hits.map((h) => h.pattern)).toEqual(["db-credentials", "db-credentials"]);
    expect(hits.every((h) => h.severity === "high")).toBe(true);
  }, 30_000);

  test("Telegram bot token + 微信语境 secret（语境锚定）", () => {
    const hits = scanText(
      [
        "tg: 123456789:AAAbcdef123456789012345678901234567",
        "WECHAT_SECRET=0123456789abcdef0123456789abcdef",
      ].join("\n"),
    );
    expect(hits.map((h) => h.pattern)).toEqual(["telegram-bot-token", "wechat-secret"]);
    expect(hits.map((h) => h.severity)).toEqual(["high", "medium"]);
  }, 30_000);

  test(".env 风格赋值：大小写不敏感（(?i)）· low 定级 · 短值（<16）不报", () => {
    const hits = scanText(
      ["password = hunter2abcdefg12", "PASSWORD=hunter2abcdefg12", "api_key: shorter123"].join("\n"),
    );
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
    expect(hits.every((h) => h.pattern === "env-assignment" && h.severity === "low")).toBe(true);
  }, 30_000);

  test("多模式同文本全报（openai + slack + github），行号正确；无文件上下文 file=?", () => {
    const text = [
      "line1 is clean",
      `mid has openai ${FAKE_OPENAI} key`,
      "slack xoxb-123456789012-1234567890123-AbcDefGhiJkl here",
      "ghp_Abc123Def456Ghi789JklMnoPqr456Stu789 at line 4",
    ].join("\n");
    const hits = scanText(text);
    expect(hits.map((h) => [h.file, h.line, h.pattern])).toEqual([
      ["?", 2, "openai-key"],
      ["?", 3, "slack-token"],
      ["?", 4, "github-token"],
    ]);
  }, 30_000);
});

// ---- 3. 误报守卫 + 脱敏 ------------------------------------------------------

describe("密钥扫描：误报守卫与脱敏", () => {
  test("干净文本零命中：普通 base64 / 普通 URL / 短 token（sk-abc）/ Stripe 测试键 / 时刻串", () => {
    const clean = [
      "SGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=", // 普通 base64
      "https://example.com/docs/page?chapter=3",
      "short token sk-abc and sk-ant-xy", // <20 位：不构成密钥
      "pk_live_Abc123Def456Ghi789JklMno", // Stripe publishable（公钥，非机密）
      "meeting at 12:34:56 then lunch", // 时刻串不撞 telegram（位数不足）
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  }, 30_000);

  test("maskLine：命中段保留前 4 后 2 中间 ***；键名保留只脱值；干净行原样", () => {
    expect(maskLine(`key=${FAKE_OPENAI} mode=prod`)).toBe("key=sk-A***kl mode=prod");
    expect(maskLine("password: hunter2abcdefg12")).toBe("password: hunt***12");
    expect(maskLine("just a normal line")).toBe("just a normal line");
    expect(maskLine("")).toBe("");
  }, 30_000);

  test("preview 永不含完整密钥原文（脱敏原则）", () => {
    for (const [line, sample] of [
      [`OPENAI_KEY=${FAKE_OPENAI}`, FAKE_OPENAI],
      ["const k = 'sk-0123456789abcdef0123456789abcdef';", "sk-0123456789abcdef0123456789abcdef"],
      ["ghp_Abc123Def456Ghi789JklMnoPqr456Stu789", "ghp_Abc123Def456Ghi789JklMnoPqr456Stu789"],
      ["postgres://alice:S3cretPW@db.internal:5432/prod", "postgres://alice:S3cretPW@db.internal:5432/prod"],
    ] as const) {
      const hit = scanText(line, "leak.txt")[0];
      expect(hit).toBeDefined();
      expect(hit.preview).not.toContain(sample);
      expect(hit.preview).toContain("***");
    }
  }, 30_000);
});

// ---- 4. scanWorkspace --------------------------------------------------------

describe("密钥扫描：scanWorkspace", () => {
  test("排除目录不报（runtime/.git/out-*/node_modules/spawn/dist），隐藏【文件】必扫，hits 只指向坏文件", () => {
    const ws = tmpWs("excl");
    try {
      fs.writeFileSync(path.join(ws, "clean.txt"), "nothing to see here\n");
      fs.writeFileSync(path.join(ws, "bad.txt"), `line1 ok\nline2 ${FAKE_OPENAI}\n`);
      fs.writeFileSync(path.join(ws, ".env"), "API_KEY=hunter2abcdefg123456\n"); // 头号目标：隐藏文件必扫
      for (const [dir, name] of [
        ["runtime", "x.txt"], // runtime 里是脱敏台账 —— 不该重复报
        [".git", "config"],
        ["out-a", "events.jsonl"],
        ["node_modules", "lib.js"],
        ["spawn", "s.ts"],
        ["dist", "bundle.js"],
      ] as const) {
        fs.mkdirSync(path.join(ws, dir), { recursive: true });
        fs.writeFileSync(path.join(ws, dir, name), `leak ${FAKE_OPENAI} here\n`);
      }
      const r = scanWorkspace(ws);
      expect(r.hits.map((h) => h.file).sort()).toEqual([".env", "bad.txt"]);
      expect(r.hits.every((h) => h.preview.includes("***"))).toBe(true);
      expect(r.scanned).toBe(3); // clean + bad + .env（排除目录不计）
      expect(r.files).toBe(3);
      expect(r.truncated).toBe(false);
      expect(r.rootsScanned).toEqual(["."]);
      expect(r.skippedBinary).toBe(0);
      expect(r.skippedOversize).toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("二进制（NUL 嗅探）与超限（>1MB）跳过并计数 —— 带密钥的二进制也不报", () => {
    const ws = tmpWs("skip");
    try {
      fs.writeFileSync(path.join(ws, "clean.txt"), "all good\n");
      fs.writeFileSync(
        path.join(ws, "blob.bin"),
        Buffer.concat([Buffer.from(`${FAKE_OPENAI}\x00binary tails`), Buffer.alloc(64, 1)]),
      );
      fs.writeFileSync(path.join(ws, "huge.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61)); // 'a' × 1MB+1
      const r = scanWorkspace(ws);
      expect(r.skippedBinary).toBe(1);
      expect(r.skippedOversize).toBe(1);
      expect(r.scanned).toBe(1);
      expect(r.hits.length).toBe(0);
      expect(r.files).toBe(3);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("maxFiles 截断：5 文件封顶 3 → truncated:true 且 scanned ≤ 3", () => {
    const ws = tmpWs("cap");
    try {
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(ws, `f${i}.txt`), `file ${i}\n`);
      const r = scanWorkspace(ws, { maxFiles: 3 });
      expect(r.truncated).toBe(true);
      expect(r.files).toBe(3);
      expect(r.scanned).toBe(3);
      expect(r.hits.length).toBe(0);
      const full = scanWorkspace(ws);
      expect(full.truncated).toBe(false);
      expect(full.scanned).toBe(5);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("opts.dirs 定向扫描：hits 只来自指定目录；缺席目录降级为空根不报错", () => {
    const ws = tmpWs("dirs");
    try {
      for (const d of ["sub", "other"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
      fs.writeFileSync(path.join(ws, "sub", "a.txt"), `${FAKE_OPENAI}\n`);
      fs.writeFileSync(path.join(ws, "other", "b.txt"), `${FAKE_OPENAI}\n`);
      fs.writeFileSync(path.join(ws, "root.txt"), `${FAKE_OPENAI}\n`);
      const r = scanWorkspace(ws, { dirs: ["sub"] });
      expect(r.rootsScanned).toEqual(["sub"]);
      expect(r.hits.map((h) => h.file)).toEqual(["sub/a.txt"]);
      // 指向不存在的目录：根列表剔除、零扫描（优雅降级）
      const miss = scanWorkspace(ws, { dirs: ["nope"] });
      expect(miss.rootsScanned).toEqual([]);
      expect(miss.files).toBe(0);
      expect(miss.hits).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("真实仓库 e2e：scanWorkspace(仓库根) 跑通不炸（断言扫描面与预算，不断言命中数）", () => {
    const r = scanWorkspace(ROOT);
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.tookMs).toBeLessThan(30_000);
    expect(Array.isArray(r.hits)).toBe(true);
    expect(r.rootsScanned).toEqual(["."]);
  }, 30_000);
});
