// ============================================================================
// tests/openapi.test.ts — OpenAPI/Swagger 解析面（v0.5.16 · capabilities #134）
// ----------------------------------------------------------------------------
// 锁定四层：
//   1. OpenAPI 3.x：petstore 精简 fixture（3 操作含参数与 security）—— 版本/
//      info/servers/schemas/操作目录逐字段断言
//   2. Swagger 2.0：basePath 合成路径 + schemes×host 合成 servers +
//      definitions 计数
//   3. 诚实降级：坏 JSON（syntax）· YAML（unsupported + python 转换指引）·
//      缺版本字段 · 不认识的版本 · 空文档
//   4. 工具目录细节：operationId 缺失自动合成 · 顶层公共参数不当路径枚举 +
//      路径级/操作级参数去重合并 · security 覆盖（操作级空数组 = 显式公开）·
//      suggestToolName 清洗 · 文件封装（round-trip / missing / >1MB 拒）
// ============================================================================
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseOpenApiText, parseOpenApiFile, suggestToolName } from "../lib/openapi.ts";

/** 一次性 tmp 目录。 */
function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-openapi-${tag}-`));
}

/** petstore 精简 fixture（3 操作：列表查询参数 / 创建鉴权 / 按 ID 路径参数）。 */
const PETSTORE_3 = {
  openapi: "3.0.3",
  info: { title: "Petstore", version: "1.0.0", description: "演示 API" },
  servers: [{ url: "https://petstore.example.com/v1" }, { url: "http://localhost:3000/v1" }],
  security: [{ api_key: [] }],
  paths: {
    "/pets": {
      get: {
        summary: "List pets",
        operationId: "listPets",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "X-Trace", in: "header", required: false },
        ],
        responses: {},
      },
      post: {
        summary: "Create a pet",
        operationId: "createPet",
        security: [{ petstore_auth: ["write"] }],
        parameters: [{ name: "body", in: "body", required: true }],
        responses: {},
      },
    },
    "/pets/{petId}": {
      get: {
        summary: "Info for a specific pet",
        operationId: "showPetById",
        parameters: [{ name: "petId", in: "path", required: true }],
        responses: {},
      },
    },
  },
  components: {
    schemas: { Pet: { type: "object" }, Pets: { type: "array" }, Error: { type: "object" } },
  },
};

/** Swagger 2.0 fixture（basePath / host / schemes / definitions）。 */
const SWAGGER_2 = {
  swagger: "2.0",
  info: { title: "Legacy API", version: "0.9.0" },
  host: "legacy.example.com",
  basePath: "/v2",
  schemes: ["https", "http"],
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "list", responses: {} },
    },
  },
  definitions: { Pet: { type: "object" } },
};

// ---- 1. OpenAPI 3.x ------------------------------------------------------------

describe("OpenAPI 解析：3.x", () => {
  test("petstore 精简 fixture：版本/info/servers/schemas + 3 操作目录逐字段（排序 path→method）", () => {
    const r = parseOpenApiText(JSON.stringify(PETSTORE_3));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe("3.0.3");
    expect(r.info).toEqual({ title: "Petstore", version: "1.0.0" });
    expect(r.servers).toEqual(["https://petstore.example.com/v1", "http://localhost:3000/v1"]);
    expect(r.schemas).toBe(3);
    expect(r.operations).toEqual([
      {
        method: "GET",
        path: "/pets",
        operationId: "listPets",
        summary: "List pets",
        params: [
          { name: "limit", in: "query", required: false },
          { name: "X-Trace", in: "header", required: false },
        ],
        security: true, // 继承全局 security
      },
      {
        method: "POST",
        path: "/pets",
        operationId: "createPet",
        summary: "Create a pet",
        params: [{ name: "body", in: "body", required: true }],
        security: true, // 操作级声明
      },
      {
        method: "GET",
        path: "/pets/{petId}",
        operationId: "showPetById",
        summary: "Info for a specific pet",
        params: [{ name: "petId", in: "path", required: true }],
        security: true,
      },
    ]);
  }, 30_000);

  test("security 覆盖语义：操作级空数组 = 显式公开（false）；全局无 security 默认 false", () => {
    const r = parseOpenApiText(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "t", version: "1.0.0" },
        paths: {
          "/a": { get: { operationId: "a", responses: {} } }, // 无全局 security → false
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations[0].security).toBe(false);

    const r2 = parseOpenApiText(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "t", version: "1.0.0" },
        security: [{ api_key: [] }],
        paths: {
          "/pub": { get: { operationId: "pub", security: [], responses: {} } }, // 显式公开
          "/priv": { get: { operationId: "priv", responses: {} } }, // 继承全局
        },
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const sec = new Map(r2.operations.map((o) => [o.operationId, o.security]));
    expect(sec.get("pub")).toBe(false);
    expect(sec.get("priv")).toBe(true);
  }, 30_000);

  test("空 paths / paths 缺失 / 空 servers 均诚实 ok（operations/servers 为空）", () => {
    for (const doc of [
      { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {} },
      { openapi: "3.0.0", info: { title: "t", version: "1" } },
    ]) {
      const r = parseOpenApiText(JSON.stringify(doc));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.operations).toEqual([]);
      expect(r.servers).toEqual([]);
      expect(r.schemas).toBe(0);
    }
  }, 30_000);
});

// ---- 2. Swagger 2.0 --------------------------------------------------------------

describe("OpenAPI 解析：Swagger 2.0", () => {
  test("basePath 合成 path（/v2 + /pets）、schemes×host 合成 servers、definitions 计数", () => {
    const r = parseOpenApiText(JSON.stringify(SWAGGER_2));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe("2.0");
    expect(r.info).toEqual({ title: "Legacy API", version: "0.9.0" });
    expect(r.servers).toEqual(["https://legacy.example.com", "http://legacy.example.com"]);
    expect(r.schemas).toBe(1);
    expect(r.operations.length).toBe(1);
    expect(r.operations[0]).toMatchObject({ method: "GET", path: "/v2/pets", operationId: "listPets" });
    // server + path = 完整 URL（与 3.x 语义对齐）
    expect(r.servers[0] + r.operations[0].path).toBe("https://legacy.example.com/v2/pets");
  }, 30_000);

  test("2.0 无 schemes 默认 https；无 host 则 servers 空、路径仍合成 basePath", () => {
    const r = parseOpenApiText(
      JSON.stringify({ swagger: "2.0", info: { title: "t", version: "1" }, basePath: "/api", paths: { "/x": { get: { responses: {} } } } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.servers).toEqual([]);
    expect(r.operations[0].path).toBe("/api/x");
  }, 30_000);
});

// ---- 3. 诚实降级 ------------------------------------------------------------------

describe("OpenAPI 解析：降级", () => {
  test("坏 JSON（花括号开头但截断）→ kind:syntax 附 JSON 解析错误", () => {
    const r = parseOpenApiText('{"openapi": "3.0.0", "info": ');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("syntax");
      expect(r.error).toContain("JSON");
    }
  }, 30_000);

  test("YAML spec → kind:unsupported + 转换指引（python yaml → JSON；不写半吊子 parser）", () => {
    const yaml = ["openapi: 3.0.3", "info:", "  title: Petstore", "  version: 1.0.0", "paths: {}", ""].join("\n");
    const r = parseOpenApiText(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("unsupported");
      expect(r.error).toContain("YAML");
      expect(r.error).toContain("python3");
      expect(r.error).toContain("json.dump");
    }
  }, 30_000);

  test("非规范 JSON（缺 openapi/swagger 字段）与顶层非对象 → kind:syntax", () => {
    const noVersion = parseOpenApiText(JSON.stringify({ info: { title: "x" } }));
    expect(noVersion.ok).toBe(false);
    if (!noVersion.ok) {
      expect(noVersion.kind).toBe("syntax");
      expect(noVersion.error).toContain("openapi");
    }
    const arr = parseOpenApiText("[1, 2, 3]");
    expect(arr.ok).toBe(false);
    if (!arr.ok) expect(arr.kind).toBe("syntax");
    const empty = parseOpenApiText("   ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.kind).toBe("syntax");
  }, 30_000);

  test("不认识的版本（openapi 4.0.0 / swagger 1.2）→ kind:unsupported", () => {
    for (const doc of [{ openapi: "4.0.0", info: {} }, { swagger: "1.2", info: {} }]) {
      const r = parseOpenApiText(JSON.stringify(doc));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("unsupported");
    }
  }, 30_000);
});

// ---- 4. 工具目录细节 ---------------------------------------------------------------

describe("OpenAPI 解析：工具目录细节", () => {
  test("operationId 缺失自动合成（get /pets/{petId} → get_pets_petId）；summary 退 description 首行", () => {
    const r = parseOpenApiText(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: {
          "/pets/{petId}": {
            get: { description: "First line of desc.\nSecond line.", responses: {} },
          },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations[0].operationId).toBe("get_pets_petId");
    expect(r.operations[0].summary).toBe("First line of desc.");
  }, 30_000);

  test("顶层公共参数容器不当路径枚举；路径级参数并入操作且操作级覆盖（required 翻转）", () => {
    const r = parseOpenApiText(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: {
          parameters: [{ name: "global", in: "query", required: true }], // 顶层公共参数容器
          "/a": {
            parameters: [
              { name: "common", in: "query", required: false },
              { name: "p", in: "path", required: true },
            ],
            get: {
              parameters: [{ name: "common", in: "query", required: true }], // 覆盖路径级同位参数
              responses: {},
            },
            post: { responses: {} }, // 无操作级 —— 只继承路径级
          },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations.length).toBe(2); // parameters 容器没被当路径枚举
    const get = r.operations.find((o) => o.method === "GET")!;
    const post = r.operations.find((o) => o.method === "POST")!;
    expect(get.params).toEqual([
      { name: "common", in: "query", required: true }, // 操作级覆盖
      { name: "p", in: "path", required: true },
    ]);
    expect(post.params).toEqual([
      { name: "common", in: "query", required: false }, // 路径级原样
      { name: "p", in: "path", required: true },
    ]);
    // path 参数 required 缺席时按规范视为必填
    const r2 = parseOpenApiText(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: { "/x/{id}": { get: { parameters: [{ name: "id", in: "path" }], responses: {} } } },
      }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.operations[0].params[0].required).toBe(true);
  }, 30_000);

  test("$ref 参数与非对象条目跳过（不展开引用图 —— 诚实边界）；非法 paths 条目跳过", () => {
    const r = parseOpenApiText(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: {
          "/a": {
            get: {
              parameters: [{ $ref: "#/components/parameters/PageParam" }, { name: "ok", in: "query" }, "garbage", 42],
              responses: {},
            },
          },
          "/broken": "not-an-object",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations.length).toBe(1);
    expect(r.operations[0].params).toEqual([{ name: "ok", in: "query", required: false }]);
  }, 30_000);

  test("suggestToolName 清洗：camelCase→snake、非法字符折叠、空回退、api_ 前缀", () => {
    expect(suggestToolName({ operationId: "listPets", method: "GET", path: "/pets" })).toBe("api_list_pets");
    expect(suggestToolName({ operationId: "updatePet-with Variant!", method: "PUT", path: "/pets" })).toBe(
      "api_update_pet_with_variant",
    );
    expect(suggestToolName({ operationId: "getPetByID", method: "GET", path: "/pets/{petId}" })).toBe("api_get_pet_by_id");
    expect(suggestToolName({ operationId: "HTTPCall", method: "POST", path: "/x" })).toBe("api_http_call");
    // operationId 缺席 → method + path 兜底（{petId} 去花括号）
    expect(suggestToolName({ operationId: "get_pets_petId", method: "GET", path: "/pets/{petId}" })).toBe("api_get_pets_pet_id");
    expect(suggestToolName({ operationId: "", method: "GET", path: "/health" })).toBe("api_get_health");
    // 全非法字符清洗为空 → 兜底名
    expect(suggestToolName({ operationId: "!!!", method: "GET", path: "/" })).toBe("api_unnamed");
  }, 30_000);
});

// ---- 5. 文件封装 -------------------------------------------------------------------

describe("OpenAPI 解析：文件封装", () => {
  test("round-trip：写临时文件 → parseOpenApiFile 与文本解析等价", () => {
    const dir = tmpDir("rt");
    try {
      const f = path.join(dir, "petstore.json");
      fs.writeFileSync(f, JSON.stringify(PETSTORE_3));
      const r = parseOpenApiFile(f);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.operations.map((o) => o.operationId)).toEqual(["listPets", "createPet", "showPetById"]);
      expect(r.schemas).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("文件缺失 → kind:missing；目录不是常规文件 → missing", () => {
    const dir = tmpDir("miss");
    try {
      const r = parseOpenApiFile(path.join(dir, "nope.json"));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("missing");
        expect(r.error).toContain("nope.json");
      }
      const d = parseOpenApiFile(dir);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.kind).toBe("missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test(">1MB spec → kind:internal 附人读提示（尺寸检查先于解析）", () => {
    const dir = tmpDir("big");
    try {
      const f = path.join(dir, "big.json");
      fs.writeFileSync(f, '{"pad": "' + "a".repeat(1024 * 1024) + '"}');
      const r = parseOpenApiFile(f);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("internal");
        expect(r.error).toContain("过大");
        expect(r.error).toContain("拆分");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
