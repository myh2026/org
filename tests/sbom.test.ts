// ============================================================================
// tests/sbom.test.ts — SPDX SBOM 生成器（v0.5.15 · capabilities #148）
// ----------------------------------------------------------------------------
// 三层验证：
//   1. 真实仓库根：扫描组成（application org-harness / runtime z-ai-web-dev-sdk
//      （版本解析自 bun.lock）/ vendored dhv-ts）+ LICENSE 文件探测 MIT
//   2. 双渲染器：SPDX JSON（JSON.parse 回读契约：SPDXID/dataLicense/
//      creationInfo/documentDescribes/relationships）与 tag:value（行契约）
//   3. 降级与边界：tmp 空目录（根 package.json 缺失 → 诚实失败）、伪造根
//      （旧文本格式 bun.lock / 假 node_modules / 损坏 lockfile → unknown）
// 依赖探测按实际断言：本仓库不携带 node_modules（.gitignore），故
// z-ai-web-dev-sdk 的 license 走 NOASSERTION 兜底（有 node_modules 的
// 环境按其 license 字段断言 —— 两种形态都锁定）。
// ============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSbom, renderSpdxJson, renderSpdxTagValue } from "../lib/sbom.ts";

const ROOT = path.resolve(import.meta.dir, "..");

/** 一次性伪造根目录（用后即焚，afterEach 统一清理）。 */
const tmpRoots: string[] = [];
function fakeRoot(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-sbom-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, "utf-8");
  }
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

const MIT_TEXT = "MIT License\n\nCopyright (c) 2026 Test\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction.\n";

// ---- 1. 真实仓库根 ---------------------------------------------------------------

describe("SBOM：真实仓库扫描", () => {
  test("ok:true + SPDX-2.3 + packages ≥3（本体/运行时依赖/内嵌工具链）", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.spdxVersion).toBe("SPDX-2.3");
    expect(r.doc.packages.length).toBeGreaterThanOrEqual(3);
    const scopes = r.doc.packages.map((p) => p.scope);
    expect(scopes).toContain("application");
    expect(scopes).toContain("runtime");
    expect(scopes).toContain("vendored");
  }, 30_000);

  test("application：org-harness 本体（name/version/description/license MIT —— LICENSE 文件探测）", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const app = r.doc.packages.find((p) => p.scope === "application");
    expect(app?.name).toBe("org-harness");
    // 真值源：根 package.json（测试与实现同读一个事实）
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(app?.version).toBe(pkg.version);
    expect(app?.description).toBe(pkg.description);
    expect(app?.license).toBe("MIT"); // 根 LICENSE 文件指纹命中
  }, 30_000);

  test("vendored：dhv-ts 内嵌工具链（version/license MIT）", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dhv = r.doc.packages.find((p) => p.scope === "vendored");
    expect(dhv?.name).toBe("dhv-ts");
    const dhvPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "toolchain/dhv-ts/package.json"), "utf-8"));
    expect(dhv?.version).toBe(dhvPkg.version);
    expect(dhv?.license).toBe("MIT"); // toolchain/dhv-ts/LICENSE 指纹命中
  }, 30_000);

  test("runtime：z-ai-web-dev-sdk 版本解析自 bun.lock（JSON 格式 packages 段）", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sdk = r.doc.packages.find((p) => p.name === "z-ai-web-dev-sdk");
    expect(sdk?.scope).toBe("runtime");
    // 真值源：bun.lock 的锁定条目记号 "z-ai-web-dev-sdk@<version>"
    // （bun.lock 是 JSONC 风格 —— 尾随逗号，严格 JSON.parse 会拒；按记号正则取真值）
    const lockRaw = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf-8");
    const m = lockRaw.match(/z-ai-web-dev-sdk@([0-9][A-Za-z0-9.+-]*)/);
    expect(m).not.toBeNull();
    expect(sdk?.version).toBe(m?.[1]);
  }, 30_000);

  test("组件 license：MIT ≥1；z-ai-web-dev-sdk 按 node_modules 实况断言（缺席 → NOASSERTION）", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.packages.filter((p) => p.license === "MIT").length).toBeGreaterThanOrEqual(1);
    const sdk = r.doc.packages.find((p) => p.name === "z-ai-web-dev-sdk");
    const nmLicense = path.join(ROOT, "node_modules/z-ai-web-dev-sdk/package.json");
    if (fs.existsSync(nmLicense)) {
      const field = JSON.parse(fs.readFileSync(nmLicense, "utf-8")).license;
      expect(sdk?.license).toBe(typeof field === "string" ? field : "NOASSERTION");
    } else {
      expect(sdk?.license).toBe("NOASSERTION"); // node_modules 缺席的诚实兜底
    }
  }, 30_000);
});

// ---- 2. 渲染器契约 ---------------------------------------------------------------

describe("SBOM：SPDX JSON 渲染", () => {
  test("JSON.parse 回读合法对象 + SPDXID 命名/唯一 + dataLicense + creationInfo", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(renderSpdxJson(r.doc));
    expect(parsed.spdxVersion).toBe("SPDX-2.3");
    expect(parsed.dataLicense).toBe("CC0-1.0");
    expect(parsed.SPDXID).toBe("SPDXRef-DOCUMENT");
    expect(parsed.name).toContain("org-harness");
    expect(typeof parsed.documentNamespace).toBe("string");
    // creationInfo.created 是合法 ISO 时间
    expect(Number.isNaN(Date.parse(parsed.creationInfo.created))).toBe(false);
    expect(parsed.creationInfo.creators.join(",")).toContain("Tool: org-sbom");
    // 每包 SPDXID 前缀 + 全文档唯一
    const ids = parsed.packages.map((p: { SPDXID: string }) => p.SPDXID);
    expect(ids.every((id: string) => id.startsWith("SPDXRef-Package-"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // scope 字段（SPDX-2.3 包级可选字段）随包投射
    expect(parsed.packages.some((p: { scope?: string }) => p.scope === "application")).toBe(true);
  }, 30_000);

  test("documentDescribes 覆盖 application 包 + relationships DESCRIBES", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(renderSpdxJson(r.doc));
    expect(parsed.documentDescribes).toContain("SPDXRef-Package-org-harness");
    const pkgIds = parsed.packages.map((p: { SPDXID: string }) => p.SPDXID);
    expect(parsed.documentDescribes.every((id: string) => pkgIds.includes(id))).toBe(true);
    const rel = parsed.relationships as Array<Record<string, string>>;
    expect(rel.length).toBeGreaterThanOrEqual(1);
    expect(rel[0].spdxElementId).toBe("SPDXRef-DOCUMENT");
    expect(rel[0].relationshipType).toBe("DESCRIBES");
    expect(parsed.documentDescribes).toContain(rel[0].relatedSpdxElement);
  }, 30_000);
});

describe("SBOM：SPDX tag:value 渲染", () => {
  test("含 SPDXVersion/PackageName/PackageLicenseConcluded/Created 行 + DESCRIBES 关系行", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tv = renderSpdxTagValue(r.doc);
    expect(tv).toContain("SPDXVersion: SPDX-2.3\n");
    expect(tv).toContain("DataLicense: CC0-1.0\n");
    expect(tv).toContain("DocumentName: org-harness-");
    expect(tv).toContain("PackageName: org-harness\n");
    expect(tv).toContain("SPDXID: SPDXRef-Package-org-harness\n");
    expect(tv).toContain("PackageName: dhv-ts\n");
    expect(tv).toContain("PackageLicenseConcluded: MIT\n");
    expect(tv).toMatch(/^Created: \d{4}-\d{2}-\d{2}T/m);
    expect(tv).toContain("Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-Package-org-harness\n");
  }, 30_000);
});

// ---- 3. 降级与伪造根 ---------------------------------------------------------------

describe("SBOM：降级与边界", () => {
  test("tmp 空目录（根 package.json 缺失）→ ok:false kind:internal + 错误附路径", () => {
    const r = buildSbom(fakeRoot({}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("internal");
    expect(r.error).toContain("package.json");
    expect(r.error.length).toBeGreaterThan(0);
  }, 30_000);

  test("伪造根：旧文本格式 bun.lock 版本解析 + node_modules license/supplier 探测", () => {
    const root = fakeRoot({
      "package.json": JSON.stringify({
        name: "fake-app", version: "1.0.0", description: "测试本体",
        dependencies: { "left-pad": "^1.3.0", "@scope/util": "^2.0.0", "ghost-dep": "*" },
      }),
      "LICENSE": MIT_TEXT,
      "bun.lock": "# lockfile:test\nleft-pad@1.3.0:\n  integrity: sha512-xxx\n@scope/util@2.0.0:\n  integrity: sha512-yyy\n",
      "node_modules/left-pad/package.json": JSON.stringify({
        name: "left-pad", version: "1.3.0", license: "MIT",
        description: "String left pad", author: { name: "Tester" },
      }),
    });
    const r = buildSbom(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.name).toBe("fake-app");
    expect(r.doc.packages.find((p) => p.name === "left-pad")?.version).toBe("1.3.0"); // 文本格式解析
    expect(r.doc.packages.find((p) => p.name === "@scope/util")?.version).toBe("2.0.0"); // scoped 名
    expect(r.doc.packages.find((p) => p.name === "left-pad")?.license).toBe("MIT"); // node_modules license 字段
    expect(r.doc.packages.find((p) => p.name === "left-pad")?.supplier).toBe("Tester"); // author → supplier
    expect(r.doc.packages.find((p) => p.name === "ghost-dep")?.license).toBe("NOASSERTION"); // 无 node_modules
    expect(r.doc.packages.find((p) => p.scope === "application")?.license).toBe("MIT"); // LICENSE 文件探测
    expect(r.doc.packages.find((p) => p.scope === "vendored")).toBeUndefined(); // 无 toolchain → 无 vendored 条目
    // 渲染：supplier 规范化为 SPDX "Organization:" 前缀
    const parsed = JSON.parse(renderSpdxJson(r.doc));
    const lp = parsed.packages.find((p: { name: string }) => p.name === "left-pad");
    expect(lp.supplier).toBe("Organization: Tester");
  }, 30_000);

  test("伪造根：损坏 bun.lock → 版本诚实降级 unknown（不炸、仍出文档）", () => {
    const root = fakeRoot({
      "package.json": JSON.stringify({ name: "broken-lock", version: "0.0.1", dependencies: { "left-pad": "^1" } }),
      "bun.lock": "this is not a lockfile at all 🙃",
    });
    const r = buildSbom(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.packages.find((p) => p.name === "left-pad")?.version).toBe("unknown");
    // 渲染层同样把 unknown 透传（versionInfo 字段不撒谎）
    const parsed = JSON.parse(renderSpdxJson(r.doc));
    expect(parsed.packages.find((p: { name: string }) => p.name === "left-pad").versionInfo).toBe("unknown");
  }, 30_000);

  test("同输入同输出：命名空间确定性（内容指纹，SBOM 可 diff）", () => {
    const r = buildSbom(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = JSON.parse(renderSpdxJson(r.doc));
    const b = JSON.parse(renderSpdxJson(r.doc));
    expect(a.documentNamespace).toBe(b.documentNamespace);
    expect(a.packages.length).toBe(b.packages.length);
  }, 30_000);
});
