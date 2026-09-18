// ============================================================================
// tests/pathjail.test.ts — 工作区监狱跨平台同形比较（v0.5.16.1 CI 修复回归）
// ----------------------------------------------------------------------------
// CI 实锤（run 35367288947 · win32 cross-platform-tests 红）：
//   complete_at 对合法相对路径 src/app.hsl 报「路径越界」—— 根因是 ws 被
//   归一成 "/" 形而 path.resolve() 在 win32 产 "\" 形，混形前缀比较必然失败。
//   本文件把平台参数化（canonFor/inWsFor），在任意宿主平台钉死 win32 分支：
//     1. 混合分隔符同形（THE bug shape，正反两向）
//     2. win32 盘符/路径大小写折叠（D: vs d: —— 文件系统大小写不敏感）
//     3. POSIX 大小写敏感不折叠（折叠反而是假阴性漏洞）
//     4. 逃逸仍然拒绝（../ 词法逃逸与越界前缀都不放行 —— 修复不放松监狱）
//     5. 前缀边界（ws-evil 不是 ws 的子路径 —— 防字典序前缀假阳性）
//     6. payload 嵌入 lib/ 守卫（编译态工具环 import 面，防 PAYLOAD_ROOTS 回退）
// ============================================================================
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonFor, inWsFor, jailCanonical, inWorkspace, jailRelative, resolveInWorkspace } from "../lib/pathjail.ts";

const ROOT = join(import.meta.dir, "..");

describe("pathjail：canonFor 比较形（平台参数化）", () => {
  test("win32：反斜杠归一正斜杠 + 大小写折叠", () => {
    expect(canonFor("win32", "D:\\A\\Ws\\Src\\App.HSL")).toBe("d:/a/ws/src/app.hsl");
    expect(canonFor("win32", "D:/A/Ws/Src/App.HSL")).toBe("d:/a/ws/src/app.hsl"); // 两形同归一形
  });
  test("POSIX：分隔符归一但大小写保持（折叠反而是漏洞）", () => {
    expect(canonFor("linux", "/a/Ws/X.ts")).toBe("/a/Ws/X.ts");
    expect(canonFor("darwin", "/A/wS\\x")).toBe("/A/wS/x"); // mac 语义面按 POSIX（Agent 沙箱/CI 跑 linux 车道）
  });
  test("空值安全：null/undefined/空串不炸，归一为空串", () => {
    expect(canonFor("win32", null as unknown as string)).toBe("");
    expect(canonFor("linux", undefined as unknown as string)).toBe("");
    expect(canonFor("linux", "")).toBe("");
  });
});

describe("pathjail：inWsFor —— CI 实锤 bug shape 回归钉（win32 混形）", () => {
  test("THE bug：ws 正斜杠形 vs resolve 反斜杠产物 → 必须放行（run 35367288947 修复）", () => {
    // 修复前：complete_at 里 abs=path.resolve("D:/a/ws","src/app.hsl") 产 "D:\a\ws\src\app.hsl"，
    // 与 ws="D:/a/ws" 混形前缀比较失败 → 假性「路径越界」。
    expect(inWsFor("win32", "D:/a/ws", "D:\\a\\ws\\src\\app.hsl")).toBe(true);
  });
  test("反向混形：ws 反斜杠形 vs 正斜杠产物 → 放行", () => {
    expect(inWsFor("win32", "D:\\a\\ws", "D:/a/ws/src/app.hsl")).toBe(true);
  });
  test("win32 大小写折叠：d:/A/WS 与 D:/a/ws 同路径", () => {
    expect(inWsFor("win32", "D:/a/ws", "d:/A/WS/src/App.HSL")).toBe(true);
    expect(inWsFor("win32", "d:\\a\\WS", "D:/a/ws")).toBe(true); // 自身等价（仅盘符大小写差）
  });
  test("越界拒绝不放松：别的目录 / 盘符 / 前缀边界", () => {
    expect(inWsFor("win32", "D:/a/ws", "D:\\a\\other\\x")).toBe(false);
    expect(inWsFor("win32", "D:/a/ws", "E:\\a\\ws\\x")).toBe(false);
    expect(inWsFor("win32", "D:/a/ws", "D:\\a\\ws-evil\\x")).toBe(false); // 字典序前缀不是子路径
    expect(inWsFor("win32", "D:/a/ws", "D:/a/ws-evil/x")).toBe(false);
  });
  test("词法逃逸拒绝：../ 出工作区（监狱第一层不变）", () => {
    // 注：inWsFor 拿到的应是 resolve 之后的词法绝对形 —— resolve 已把 ../ 折掉，
    // 这里模拟折掉后的越界结果（真正调用方先 resolve 再判）。
    expect(inWsFor("win32", "D:/a/ws", "D:/a/escape.txt")).toBe(false);
    expect(inWsFor("linux", "/a/ws", "/a/escape.txt")).toBe(false);
  });
  test("POSIX：大小写敏感 + 自身等价 + 子路径", () => {
    expect(inWsFor("linux", "/a/ws", "/a/ws/src/app.hsl")).toBe(true);
    expect(inWsFor("linux", "/a/ws", "/a/ws")).toBe(true);
    expect(inWsFor("linux", "/a/ws", "/a/Ws/x")).toBe(false); // POSIX 大小写敏感
    expect(inWsFor("linux", "/a/ws", "/a/ws-extra/x")).toBe(false);
  });
});

describe("pathjail：当前平台公共 API（inWorkspace/jailCanonical）", () => {
  test("inWorkspace：子路径放行 / 越界拒绝 / 自身等价", () => {
    expect(inWorkspace("/a/ws", "/a/ws/src/app.hsl")).toBe(true);
    expect(inWorkspace("/a/ws", "/a/ws")).toBe(true);
    expect(inWorkspace("/a/ws", "/b/x")).toBe(false);
  });
  test("jailCanonical：当前平台归一为字符串（不炸）", () => {
    expect(typeof jailCanonical("/a/b\\c")).toBe("string");
    expect(jailCanonical("/a/b\\c")).toBe("/a/b/c");
  });
});

describe("pathjail：jailRelative 相对形", () => {
  test("工作区内 → 相对路径；自身 → '.'；越界 → 原样透传", () => {
    expect(jailRelative("/a/ws", "/a/ws/src/app.hsl")).toBe("src/app.hsl");
    expect(jailRelative("/a/ws", "/a/ws")).toBe(".");
    expect(jailRelative("/a/ws", "/b/x.ts")).toBe("/b/x.ts"); // 越界原样（调用方决定报错口径）
  });
  test("resolveInWorkspace：相对解析进 ws；绝对透传（win32 无盘符基底剥盘符保可比）", () => {
    // win32 的 path.resolve 产 "\" 形且对无盘符基底（"/a/ws"）附当前盘符 ——
    // resolveInWorkspace 剥回无盘符形，canonFor 后与基底可比（跨平台同规）。
    expect(canonFor(process.platform, resolveInWorkspace("/a/ws", "src/app.hsl"))).toBe("/a/ws/src/app.hsl");
    expect(resolveInWorkspace("/a/ws", "/abs/x.ts")).toBe("/abs/x.ts"); // 绝对形透传不 resolve
    // 语义闭环：解析产物经 inWorkspace 判定必在基底内（jail 比较形一致性）
    expect(inWorkspace("/a/ws", resolveInWorkspace("/a/ws", "src/app.hsl"))).toBe(true);
    // win32 真实形态：带盘符基底不剥（生产行为不变）
    if (process.platform === "win32") {
      const drive = process.cwd().slice(0, 2); // 如 "D:"
      expect(canonFor("win32", resolveInWorkspace(drive + "/a/ws", "src/app.hsl"))).toBe("d:/a/ws/src/app.hsl");
    }
  });
});

describe("pathjail：payload 嵌入 lib/ 守卫（编译态工具环 import 面）", () => {
  test("build/payload.json 含 lib/pathjail.ts 与 lib/gitmerge.ts（PAYLOAD_ROOTS 防回退）", () => {
    // v0.5.16.1：编译态 ROOT=解包目录，工具环 native 块 import(root+"/lib/*.ts")
    // 依赖 lib/ 入 payload。此守卫防止 PAYLOAD_ROOTS 被误删 "lib" 后静默回退
    // （native-smoke 只跑 check/demo/TUI 不踩工具环，红灯不会自己暴露）。
    const doc = JSON.parse(readFileSync(join(ROOT, "build/payload.json"), "utf-8")) as { files: Record<string, string> };
    expect(doc.files["lib/pathjail.ts"]).toContain("inWorkspace");
    expect(doc.files["lib/gitmerge.ts"]).toBeTruthy();
    expect(Object.keys(doc.files).some((k) => k.startsWith("lib/"))).toBe(true);
  });
});
