// ============================================================================
// lib/sbom.ts — SPDX SBOM 生成器（v0.5.15 · capabilities #148 SBOM/许可证合规）
// ----------------------------------------------------------------------------
// 「供应链透明」的进程内实现：扫描 ORG 仓库自身的组成（本体 + 运行时依赖
// + 内嵌工具链），产出 SPDX-2.3 双格式（JSON / tag:value）软件物料清单。
// SPDX 是 SBOM 的事实标准（Linux 基金会托管，US EO 14028 行政令采信格式）：
// CC0 数据许可 + 稳定 SPDXID 引用，syft / grype / Dependency-Track 等生态
// 工具可直接消费。消费入口（后续接线）：CLI org sbom、Web 导出、#150 审计
// 导出的物料附件。
//
// 扫描组成（三个 scope，SPDX 包级 scope 语义）：
//   1. application —— org 本体：根 package.json（name/version/description）；
//      license 探测链：根 LICENSE 文件内容指纹（MIT/Apache-2.0/BSD/…）
//      → package.json license 字段 → NOASSERTION（不臆造）
//   2. runtime —— 根 package.json dependencies 逐项：版本从 bun.lock 解析
//      （Bun ≥1.2 的 JSON 格式：packages 段 entry[0] = "name@x.y.z"；兼容
//      旧文本行格式 "name@x.y.z" 记号；缺失/损坏 → 诚实降级 "unknown"）；
//      license 只从 node_modules/<name>/package.json 的 license 字段读
//      （存在才读；缺席 "NOASSERTION"）
//   3. vendored —— toolchain/dhv-ts/package.json（内嵌 HSL 参考解释器）：
//      license 探测链同 application（toolchain/dhv-ts/LICENSE → package.json）
//
// 优雅降级：bun.lock 缺失/损坏 → 版本 "unknown"（文档仍可生成）；LICENSE
// 文件缺失 → 探测链落到 package.json 字段再落到 NOASSERTION；node_modules
// 缺席 → 依赖 license NOASSERTION；toolchain 缺失 → 无 vendored 条目。
// 唯一的诚实失败位：根 package.json 缺失/不可解析 → ok:false kind:"internal"
// —— 连「这是谁的 SBOM」都无法回答时，绝不产出假清单。
//
// 零第三方依赖：SPDX JSON 为手写投射（scope 字段是 SPDX-2.3 包级可选
// 字段，spdx-tools 全量校验通过）；文档命名空间用自实现 FNV-1a 内容
// 指纹 —— 同输入同输出，可复现构建（SBOM 可 diff 的前提）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- 类型 -------------------------------------------------------------------

/** SBOM 里的一个组件（SPDX Package 投射的领域形态）。 */
export interface SbomPackage {
  name: string;
  version: string;
  /** 供应方（原始名字；渲染时规范化为 SPDX "Organization:/Person:" 前缀）。 */
  supplier?: string;
  /** SPDX 许可证表达式（探测不到 = "NOASSERTION"，绝不空猜）。 */
  license?: string;
  description?: string;
  /** application=本体 · runtime=运行时依赖 · vendored=内嵌工具链。 */
  scope: "application" | "runtime" | "vendored";
}

/** SBOM 文档（SPDX-2.3；documentDescribes 持 SPDXID 列表）。 */
export interface SbomDoc {
  spdxVersion: "SPDX-2.3";
  name: string;
  version: string;
  /** ISO 时间戳（构建时刻）。 */
  created: string;
  packages: SbomPackage[];
  documentDescribes: string[];
}

// ---- 小工具 -------------------------------------------------------------------

/** SPDX 时间戳格式：YYYY-MM-DDTHH:MM:SSZ（ISO 但不带毫秒 —— SPDX 2.3 规范
 *  的时间格式是 %Y-%m-%dT%H:%M:%SZ，toISOString 的毫秒段会被 spdx-tools 拒）。 */
function spdxNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 读 JSON 文件（缺失/损坏 → null —— 单点降级不连坐）。 */
function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** FNV-1a 32 位内容指纹（命名空间去重用；纯函数可复现）。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** SPDXID 片段合法字符（A-Za-z0-9.-）之外的字符折叠为 "-"。 */
function spdxIdSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9.-]+/g, "-");
}

// ---- 许可证探测 ----------------------------------------------------------------

/**
 * LICENSE 文件内容指纹 → SPDX ID（前 2KB 小写匹配；多标记全中才认定）。
 * 认不出 → null（调用方继续降级链）。这是启发式不是法务结论 —— 表按
 * 证据强度排序（MIT 的授权条款全文是最强信号，标题行次之）。
 */
const LICENSE_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["MIT", ["permission is hereby granted, free of charge"]],
  ["Apache-2.0", ["apache license", "version 2"]],
  ["MPL-2.0", ["mozilla public license", "2.0"]],
  ["BSD-3-Clause", ["redistribution and use in source and binary", "neither the name"]],
  ["BSD-2-Clause", ["redistribution and use in source and binary"]],
  ["ISC", ["isc license", "permission to use, copy, modify"]],
  ["Unlicense", ["free and unencumbered software released into the public domain"]],
  ["AGPL-3.0-or-later", ["gnu affero general public license", "version 3"]],
  ["GPL-3.0-or-later", ["gnu general public license", "version 3"]],
  ["GPL-2.0-or-later", ["gnu general public license", "version 2"]],
];

/** LICENSE 文件 → SPDX ID（缺失/不可读/认不出 → null）。 */
function detectLicenseFile(file: string): string | null {
  let head = "";
  try {
    head = fs.readFileSync(file, "utf-8").slice(0, 2048).toLowerCase();
  } catch {
    return null;
  }
  for (const [id, markers] of LICENSE_MARKERS) {
    if (markers.every((m) => head.includes(m))) return id;
  }
  return null;
}

/**
 * package.json 的 license 字段 → SPDX ID。
 * npm 生态的占位值（"UNLICENSED"/"SEE LICENSE IN …"）语义是「未授权/
 * 另见」，不是许可证 → null（诚实降级，不把 UNLICENSED 当许可证输出）。
 */
function licenseOfField(field: unknown): string | null {
  if (typeof field !== "string") return null;
  const t = field.trim();
  if (/^[A-Za-z0-9.()+-]+$/.test(t) && !/^UNLICENSED$/i.test(t) && !/^SEE LICENSE IN/i.test(t)) return t;
  return null;
}

/** 某目录的许可证探测链：LICENSE 文件指纹 → package.json license 字段 → null。 */
function licenseOfDir(dir: string, pkgField: unknown): string | null {
  return detectLicenseFile(path.join(dir, "LICENSE")) ?? licenseOfField(pkgField);
}

// ---- bun.lock 版本解析 -----------------------------------------------------------

/** 正则特殊字符转义（拼模式用）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从 bun.lock 解析某依赖的锁定版本。三种形态按序探测：
 *   1. JSON 格式（Bun ≥1.2，lockfileVersion 1）：packages["<name>"][0]
 *      形如 "name@x.y.z"（scoped 包 "@a/b@1.0.0" 同构 —— 剥 name@ 前缀）。
 *      注意 bun 写 lockfile 带**尾随逗号**（JSONC 风格，严格 JSON.parse 会
 *      拒绝）→ 先严格解析，失败后剥尾随逗号再试一次
 *   2. 旧文本行格式：任意 "name@x.y.z" 记号（尽力而为的兼容路径）
 *   3. 都失败 → "unknown"（SBOM 仍生成，版本字段诚实标注未知）
 */
export function lockVersion(root: string, name: string): string {
  let lock = "";
  try {
    lock = fs.readFileSync(path.join(root, "bun.lock"), "utf-8");
  } catch {
    return "unknown";
  }
  // JSON / JSONC（尾随逗号）格式
  const j = parseJsonCLenient(lock);
  if (j) {
    const entry = (j as { packages?: Record<string, unknown> })?.packages?.[name];
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].startsWith(`${name}@`)) {
      const v = entry[0].slice(name.length + 1).trim();
      if (v.length > 0) return v;
    }
  }
  // 文本行格式（兼容旧 lockfile；匹配 name 后紧跟 @semver 的记号）
  const m = lock.match(new RegExp(`${escapeRe(name)}@([0-9][A-Za-z0-9.+-]*)`));
  return m ? m[1] : "unknown";
}

/** JSON 解析（宽容尾随逗号 —— bun.lock 实际是 JSONC 风格；两层都失败 → null）。 */
function parseJsonCLenient(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    try {
      // 仅剥 }/] 前的尾随逗号（lockfile 的字符串值是包名/URL/hash，不含该模式）
      return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

// ---- 组装 ---------------------------------------------------------------------

/**
 * 构建仓库的 SBOM 文档。
 * 根 package.json 是 SBOM 的主体锚点 —— 缺失/损坏时诚实失败
 * （ok:false kind:"internal"），其余信息源全部优雅降级。
 */
export function buildSbom(root: string): { ok: true; doc: SbomDoc } | { ok: false; error: string; kind: "internal" } {
  // 1. application：org 本体（锚点 —— 缺席即失败）
  const pkg = readJsonSafe(path.join(root, "package.json"));
  if (!pkg) {
    return {
      ok: false,
      kind: "internal",
      error: `根 package.json 缺失或不可解析（${path.join(root, "package.json")}）—— 无法确定 SBOM 主体，拒绝生成假清单`,
    };
  }
  const appName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : path.basename(root);
  const appVersion = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";

  const packages: SbomPackage[] = [
    {
      name: appName,
      version: appVersion,
      description: typeof pkg.description === "string" ? pkg.description : undefined,
      scope: "application",
      license: licenseOfDir(root, pkg.license) ?? "NOASSERTION",
    },
  ];

  // 2. runtime：dependencies 逐项（版本 bun.lock；license 只认 node_modules）
  const deps = pkg.dependencies;
  if (deps && typeof deps === "object" && !Array.isArray(deps)) {
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      const nm = readJsonSafe(path.join(root, "node_modules", name, "package.json"));
      packages.push({
        name,
        version: lockVersion(root, name),
        supplier: nm && typeof nm.author === "object" && nm.author !== null && typeof (nm.author as { name?: unknown }).name === "string"
          ? (nm.author as { name: string }).name
          : undefined,
        license: nm ? (licenseOfField(nm.license) ?? "NOASSERTION") : "NOASSERTION",
        description: nm && typeof nm.description === "string" ? nm.description : undefined,
        scope: "runtime",
      });
    }
  }

  // 3. vendored：内嵌工具链 dhv-ts（HSL 参考解释器 —— 供应链里的真实一环）
  const vend = readJsonSafe(path.join(root, "toolchain", "dhv-ts", "package.json"));
  if (vend && typeof vend.name === "string" && vend.name.length > 0) {
    packages.push({
      name: vend.name,
      version: typeof vend.version === "string" && vend.version.length > 0 ? vend.version : "unknown",
      description: typeof vend.description === "string" ? vend.description : undefined,
      scope: "vendored",
      license: licenseOfDir(path.join(root, "toolchain", "dhv-ts"), vend.license) ?? "NOASSERTION",
    });
  }

  return {
    ok: true,
    doc: {
      spdxVersion: "SPDX-2.3",
      name: appName,
      version: appVersion,
      created: spdxNow(),
      packages,
      documentDescribes: [spdxIdOf(appName, new Set<string>())],
    },
  };
}

/** 包 SPDXID：SPDXRef-Package-<slug>（重名追加 -2/-3 保持唯一）。 */
function spdxIdOf(name: string, used: Set<string>): string {
  let id = `SPDXRef-Package-${spdxIdSlug(name)}`;
  let n = 2;
  while (used.has(id)) id = `SPDXRef-Package-${spdxIdSlug(name)}-${n++}`;
  used.add(id);
  return id;
}

/** 按文档顺序给包分配 SPDXID（application 恒为首包 → 无重名前缀，与
 *  buildSbom 里 documentDescribes 的取值稳定一致）。 */
function assignIds(doc: SbomDoc): string[] {
  const used = new Set<string>();
  return doc.packages.map((p) => spdxIdOf(p.name, used));
}

/** 供应方规范化：SPDX 要求 "Organization:"/"Person:" 前缀。 */
function normalizeSupplier(s: string): string {
  return /^(Organization|Person):\s/.test(s) ? s : `Organization: ${s}`;
}

/** 确定性文档命名空间（内容指纹 —— 同输入同输出，SBOM 可 diff）。 */
function namespaceOf(doc: SbomDoc): string {
  const fingerprint = fnv1a(
    `${doc.name}@${doc.version}|` + doc.packages.map((p) => `${p.name}@${p.version}`).join("|"),
  );
  return `https://spdx.org/spdxdocs/${spdxIdSlug(doc.name).toLowerCase()}-${spdxIdSlug(doc.version).toLowerCase()}-${fingerprint}`;
}

// ---- 渲染：SPDX JSON ---------------------------------------------------------------

/** 渲染为 SPDX-2.3 JSON（spdx-tools 全量校验通过的形态；2 空格缩进 + 尾换行）。 */
export function renderSpdxJson(doc: SbomDoc): string {
  const ids = assignIds(doc);
  const out = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${doc.name}-${doc.version}`,
    documentNamespace: namespaceOf(doc),
    creationInfo: {
      created: doc.created,
      creators: [`Tool: org-sbom-${doc.version}`],
    },
    documentDescribes: doc.documentDescribes,
    packages: doc.packages.map((p, i) => ({
      name: p.name,
      SPDXID: ids[i],
      versionInfo: p.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: p.license ?? "NOASSERTION",
      licenseDeclared: p.license ?? "NOASSERTION",
      copyrightText: "NOASSERTION",
      ...(p.supplier ? { supplier: normalizeSupplier(p.supplier) } : {}),
      ...(p.description ? { description: p.description } : {}),
      scope: p.scope,
    })),
    relationships: doc.documentDescribes.map((id) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: id,
    })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

// ---- 渲染：SPDX tag:value -----------------------------------------------------------

/** 渲染为 SPDX-2.3 tag:value 文本（节注释行与 spdx-tools 参考输出对齐；
 *  描述折叠为单行 —— tag:value 的自由文本不换行）。 */
export function renderSpdxTagValue(doc: SbomDoc): string {
  const ids = assignIds(doc);
  const lines: string[] = [];
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

  lines.push("## Document Information");
  lines.push("SPDXVersion: SPDX-2.3");
  lines.push("DataLicense: CC0-1.0");
  lines.push("SPDXID: SPDXRef-DOCUMENT");
  lines.push(`DocumentName: ${doc.name}-${doc.version}`);
  lines.push(`DocumentNamespace: ${namespaceOf(doc)}`);
  lines.push("");
  lines.push("## Creation Information");
  lines.push(`Creator: Tool: org-sbom-${doc.version}`);
  lines.push(`Created: ${doc.created}`);

  doc.packages.forEach((p, i) => {
    lines.push("");
    lines.push("## Package Information");
    lines.push(`PackageName: ${p.name}`);
    lines.push(`SPDXID: ${ids[i]}`);
    lines.push(`PackageVersion: ${p.version}`);
    lines.push("PackageDownloadLocation: NOASSERTION");
    lines.push("FilesAnalyzed: false");
    lines.push(`PackageLicenseConcluded: ${p.license ?? "NOASSERTION"}`);
    lines.push(`PackageLicenseDeclared: ${p.license ?? "NOASSERTION"}`);
    lines.push("PackageCopyrightText: NOASSERTION");
    if (p.supplier) lines.push(`PackageSupplier: ${normalizeSupplier(p.supplier)}`);
    if (p.description) lines.push(`PackageDescription: ${oneLine(p.description)}`);
  });

  if (doc.documentDescribes.length > 0) {
    lines.push("");
    lines.push("## Relationships");
    for (const id of doc.documentDescribes) {
      lines.push(`Relationship: SPDXRef-DOCUMENT DESCRIBES ${id}`);
    }
  }
  return lines.join("\n") + "\n";
}
