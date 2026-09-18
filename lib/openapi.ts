// ============================================================================
// lib/openapi.ts — OpenAPI/Swagger 解析面（v0.5.16 · capabilities #134
//                                       OpenAPI/GraphQL/gRPC 集成 —— 本轮 OpenAPI）
// ----------------------------------------------------------------------------
// 把一份 API 规范文档变成「工具目录」：模型能调什么、每个操作叫什么名、要
// 哪些参数、要不要鉴权 —— suggestToolName 给工具环命名（api_ 前缀 + 清洗）。
// GraphQL introspection 与 gRPC proto 反射是 #134 的后续轮次（同一目录形态
// 可复用），本模块先钉住 REST 事实标准 OpenAPI。
//
// 支持链（诚实边界如实声明）：
//   · JSON 严格解析：OpenAPI 3.x（openapi: "3.a.b"）与 Swagger 2.0
//     （swagger: "2.0"）双识别；2.0 的 basePath 合成进操作路径
//     （servers = scheme://host，path = basePath + spec 路径 —— 与 3.x 的
//     「server + path = 完整 URL」语义对齐）
//   · YAML 诚实降级：kind:"unsupported" + 转换指引（python3 -c yaml → JSON
//     或 editor.swagger.io 导出）。**不写半吊子 YAML parser** —— YAML 的
//     锚点/多行字符串/缩进语义足够埋一排静默错位 bug，宁可拒之并给路
//   · 不做的：$ref 引用图展开（参数级 $ref 跳过并在计数里消失）、
//     paths.x.$ref、OpenAPI 3.0 的 style/explode 参数细节、examples ——
//     工具目录需要的是 name/in/required 三元组，不是完整规范模型
//
// 优雅降级零逃逸：所有失败 {ok:false, kind, error:人读}；kind ∈
// syntax（坏 JSON / 非规范文档）· unsupported（YAML / 不认识的版本）·
// missing（文件缺席，仅文件封装）· internal（超大/读失败）。操作按
// path+method 枚举，顶层 paths.parameters 公共容器不当路径枚举；路径级
// 公共参数与操作级参数按 (in,name) 去重合并（操作级覆盖路径级）。
// ============================================================================

import * as fs from "node:fs";

/** spec 文件尺寸帽（>1MB 拒 —— 本解析器面向工具目录生成，不处理巨型 spec）。 */
export const OPENAPI_MAX_BYTES = 1024 * 1024;

// ---- 类型 ---------------------------------------------------------------------

export interface ApiParam {
  name: string;
  /** openapi 3 / swagger 2 的参数位置：path / query / header / cookie。 */
  in: string;
  required: boolean;
}

export interface ApiOperation {
  /** 大写 HTTP 动词（GET/POST/…）。 */
  method: string;
  /** 操作路径（2.0 已合成 basePath；相对 servers 拼 URL）。 */
  path: string;
  /** 规范声明或自动合成（method_path 清洗）—— suggestToolName 的输入。 */
  operationId: string;
  /** summary，缺席退 description 首行，再缺席空串。 */
  summary: string;
  /** 路径级公共参数 + 操作级参数（按 in:name 去重，操作级覆盖）。 */
  params: ApiParam[];
  /** true = 本操作（或全局）声明了非空 security 要求。 */
  security: boolean;
}

export interface OpenApiInfo {
  ok: true;
  /** 规范版本（"3.0.3" / "2.0"）。 */
  version: string;
  info: { title: string; version: string };
  servers: string[];
  operations: ApiOperation[];
  /** components.schemas（3.x）/ definitions（2.0）计数。 */
  schemas: number;
}

export type OpenApiTextResult =
  | OpenApiInfo
  | { ok: false; kind: "syntax" | "unsupported" | "internal"; error: string };

export type OpenApiFileResult =
  | OpenApiInfo
  | { ok: false; kind: "missing" | "syntax" | "unsupported" | "internal"; error: string };

const YAML_HINT =
  "检测到 YAML 格式的 OpenAPI/Swagger 文档。本模块坚持不写半吊子 YAML parser（诚实边界）："
  + "请先转成 JSON 再解析 —— 例如 "
  + 'python3 -c "import sys, yaml, json; json.dump(yaml.safe_load(sys.stdin), sys.stdout, ensure_ascii=False)" < spec.yaml > spec.json'
  + "（需 PyYAML：uv run --with pyyaml python 同式可用），或用 editor.swagger.io 导入后导出 JSON。";

// ---- 参数与工具命名 ---------------------------------------------------------------

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** 参数数组规范化：非对象条目与 $ref 条目跳过（不展开引用图 —— 诚实边界）；
 *  required 缺席时 path 参数按 OpenAPI 规范视为必填。 */
function toApiParams(raw: unknown): ApiParam[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiParam[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.$ref === "string") continue; // $ref 参数不解析
    const name = typeof o.name === "string" ? o.name : "";
    const loc = typeof o.in === "string" ? o.in : "";
    if (!name || !loc) continue;
    const required = typeof o.required === "boolean" ? o.required : loc === "path";
    out.push({ name, in: loc, required });
  }
  return out;
}

/** 路径级公共参数 + 操作级参数合并：按 (in:name) 去重，操作级覆盖路径级。 */
function mergeParams(pathParams: ApiParam[], opParams: ApiParam[]): ApiParam[] {
  const map = new Map<string, ApiParam>();
  for (const p of pathParams) map.set(`${p.in}:${p.name}`, p);
  for (const p of opParams) map.set(`${p.in}:${p.name}`, p); // 操作级覆盖（保持首个插入位）
  return [...map.values()];
}

/** operationId 缺席时的自动合成：method + 路径清洗（{petId} → petId）。 */
function synthesizeOpId(method: string, p: string): string {
  const slug = p.replace(/\{([^}]+)\}/g, "$1").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${method}_${slug || "root"}`;
}

/**
 * 工具环命名建议："api_" + operationId 清洗（camelCase → snake_case、非法
 * 字符折叠为 _、压缩连续 _、去首尾 _、小写）。operationId 空时回退
 * method_path。空清洗结果兜底 "api_unnamed"。
 */
export function suggestToolName(op: Pick<ApiOperation, "operationId" | "method" | "path">): string {
  const base = op.operationId.trim().length > 0 ? op.operationId : `${op.method}_${op.path}`;
  const name = base
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return name.length > 0 ? `api_${name}` : "api_unnamed";
}

// ---- 解析 -----------------------------------------------------------------------

/** 解析 OpenAPI/Swagger 文本文档（JSON 严格解析；YAML 诚实降级）。 */
export function parseOpenApiText(text: string): OpenApiTextResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, kind: "syntax", error: "空文档：没有可解析的 OpenAPI 内容" };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // YAML 识别：未以 { 开头且带 openapi:/swagger: 键行 → 诚实降级给转换指引
    if (/^\s*(?:openapi|swagger)\s*:/m.test(text)) {
      return { ok: false, kind: "unsupported", error: YAML_HINT };
    }
    return { ok: false, kind: "syntax", error: `内容不是合法 JSON（${msg}），也未识别出 YAML 格式的 openapi:/swagger: 头部` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, kind: "syntax", error: "文档顶层必须是 JSON 对象（OpenAPI/Swagger 规范文档）" };
  }
  const doc = obj as Record<string, unknown>;

  // ---- 版本识别（3.x / 2.0 双支持，其余 unsupported）----
  const openapiV = typeof doc.openapi === "string" ? doc.openapi.trim() : null;
  const swaggerV = typeof doc.swagger === "string" ? doc.swagger.trim() : null;
  let flavor: "3" | "2";
  let version: string;
  if (openapiV !== null) {
    if (!/^3\.\d+(\.\d+)?$/.test(openapiV)) {
      return { ok: false, kind: "unsupported", error: `OpenAPI 版本 "${openapiV}" 不受支持（本解析器支持 OpenAPI 3.x 与 Swagger 2.0）` };
    }
    flavor = "3";
    version = openapiV;
  } else if (swaggerV !== null) {
    if (swaggerV !== "2.0") {
      return { ok: false, kind: "unsupported", error: `Swagger 版本 "${swaggerV}" 不受支持（仅支持 Swagger 2.0）` };
    }
    flavor = "2";
    version = swaggerV;
  } else {
    return { ok: false, kind: "syntax", error: "文档缺少 openapi（3.x）或 swagger（2.0）版本字段 —— 不是 OpenAPI/Swagger 规范文档" };
  }

  // ---- info / servers / schemas ----
  const infoObj = doc.info && typeof doc.info === "object" && !Array.isArray(doc.info) ? (doc.info as Record<string, unknown>) : {};
  const info = {
    title: typeof infoObj.title === "string" ? infoObj.title : "",
    version: typeof infoObj.version === "string" ? infoObj.version : "",
  };
  const objKeys = (v: unknown): string[] =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>) : [];

  let servers: string[] = [];
  let pathPrefix = "";
  let schemas = 0;
  if (flavor === "3") {
    if (Array.isArray(doc.servers)) {
      servers = doc.servers
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s))
        .map((s) => (typeof s.url === "string" && s.url.length > 0 ? s.url : ""))
        .filter((u) => u.length > 0);
    }
    schemas = objKeys((doc.components as Record<string, unknown> | undefined)?.schemas).length;
  } else {
    const host = typeof doc.host === "string" ? doc.host : "";
    let schemes: string[] = [];
    if (Array.isArray(doc.schemes)) schemes = doc.schemes.filter((s): s is string => typeof s === "string");
    if (schemes.length === 0 && host.length > 0) schemes = ["https"]; // 2.0 规范：缺席按访问定义本身的协议 —— 工具目录语境取 https 保守默认
    servers = host.length > 0 ? schemes.map((s) => `${s}://${host}`) : [];
    pathPrefix = typeof doc.basePath === "string" ? doc.basePath : "";
    schemas = objKeys(doc.definitions).length;
  }

  // ---- 操作目录（path+method 枚举）----
  const rootSec = Array.isArray(doc.security) ? doc.security.length > 0 : false;
  const operations: ApiOperation[] = [];
  const pathsObj = doc.paths && typeof doc.paths === "object" && !Array.isArray(doc.paths) ? (doc.paths as Record<string, unknown>) : {};
  for (const [p, item] of Object.entries(pathsObj)) {
    if (p === "parameters") continue; // 2.0 允许的顶层公共参数容器 —— 不是路径
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const pi = item as Record<string, unknown>;
    const pathParams = toApiParams(pi.parameters);
    for (const method of METHODS) {
      const op = pi[method];
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      const oi = op as Record<string, unknown>;
      const operationId =
        typeof oi.operationId === "string" && oi.operationId.trim().length > 0 ? oi.operationId.trim() : synthesizeOpId(method, p);
      let summary = "";
      if (typeof oi.summary === "string") summary = oi.summary;
      else if (typeof oi.description === "string") summary = oi.description.split(/\r?\n/)[0] ?? "";
      operations.push({
        method: method.toUpperCase(),
        path: pathPrefix + p,
        operationId,
        summary,
        params: mergeParams(pathParams, toApiParams(oi.parameters)),
        security: Array.isArray(oi.security) ? oi.security.length > 0 : rootSec,
      });
    }
  }
  operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  return { ok: true, version, info, servers, operations, schemas };
}

// ---- 文件封装 ---------------------------------------------------------------------

/** 解析 OpenAPI/Swagger 文件（缺失 → missing；>1MB → internal 附提示；
 *  读失败 → internal；其余委托 parseOpenApiText）。 */
export function parseOpenApiFile(file: string): OpenApiFileResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, kind: "missing", error: `文件不存在或不可访问：${file}` };
  }
  if (!st.isFile()) {
    return { ok: false, kind: "missing", error: `不是常规文件（可能是目录）：${file}` };
  }
  if (st.size > OPENAPI_MAX_BYTES) {
    return {
      ok: false,
      kind: "internal",
      error: `spec 文件过大（${st.size} 字节 > ${OPENAPI_MAX_BYTES} 上限）：本解析器面向工具目录生成，不接受巨型 spec —— 请按 tag 拆分或精简 paths/schemas 后重试`,
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return { ok: false, kind: "internal", error: `文件读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return parseOpenApiText(text);
}
