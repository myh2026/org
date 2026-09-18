// ============================================================================
// tests/mobile.test.ts — 移动端调试簇（v0.5.18 · capabilities #117）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/mobile.ts 的行为级断言 + CLI/工具环/Web 三端冒烟；
// tests/cloud.test.ts / tests/remote.test.ts 同构风格 —— 沙箱/CI 无 adb/无
// 真机的价值在**降级链完整 + 参数构造/输出解析真实可测 + 纯函数保底**）：
//   1. 纯函数解析器：adb devices -l（多设备/未授权/offline/噪音行/usb transport
//      整体形态）/ logcat 五元组（MM-DD 与 YYYY-MM-DD 双日期形态 + 噪音拒绝）/
//      aapt badging / devtools socket 提取 / APK 魔数 / 症状归一（中英宽容）/
//      logcat argv 构造 / 端口归一 / SDK 候选；
//   2. 计划器纯函数矩阵：3 平台 × 7 症状（每步 cmd+expect+degrade 成对、编号
//      连续）+ 内容要素（Android: logcat/forward/9222/gfxinfo · iOS: idevice
//      套件/Safari · 安装错误码 · 构建产物核对）+ both 平台拼接序 + 平台
//      非法值兜底 android + mobileSelfTest 8/8；
//   3. 降级路径（PATH 置空宇宙）：probeMobile 各面诚实缺席 + 指引；
//      devices/logcat tool-absent + plan 保底指引（环境自适应：CI runner 若
//      预装 Android SDK，locateInSdk 车道命中真 adb → 接受诚实结果形态 ——
//      cloud.test.ts v0.5.17.2「锁形态不锁环境」哲学）；apk 两层降级（魔数
//      车道恒交付）；forward tool-absent；
//   4. 真实车道可测（假 adb/aapt/idevice_id 脚本注入 PATH —— POSIX skipIf
//      win32）：devices 多形态（就绪/未授权/offline 并存 + 无设备 + 全未授权）；
//      logcat 五元组 + argv 形态（-d -t N / *:E / -s TAG / -s serial · 次序
//      不锁死）+ 行数钳制 + 包名 pidof 过滤（在运行/未运行两态）+ 多设备
//      multi-device 降级；forward 四层（socket 自动发现 → 真本地 CDP HTTP
//      服务可达 + 页面清单 → 空清单 page-empty → 无 socket 指引 → 不可达
//      socket-unreachable）；apk aapt 车道（badging 全量解析）+ aapt 失败
//      魔数降级 + jail 越界拒绝；
//   5. CLI 冒烟（runOrg 真子进程）：probe/self-test/plan（both 白屏双平台）/
//      devices（假 adb 注入 PATH）/apk（jail 拒绝 + aapt 车道）/未知子命令；
//   6. Web /api/govex/mobile 五动作（probe/devices/logcat/plan/selftest）+
//      GUI 📱 区块要素 + 内联脚本 new Function 守卫（wt-iac 教训：改面板 JS
//      后必跑）；
//   7. 工具环 e2e（scripted 剧本驱动 direct.hsl —— wiring2/lsp.test.ts 同款）：
//      mobile_devices/mobile_logcat/mobile_plan 只读模式可用 + result_summary
//      可观测；mobile_plan 非法平台 + mobile_logcat 多设备降级的错误摘要面。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  probeMobile, androidSdkCandidates,
  mobileDevices, parseAdbDevices,
  mobileLogcat, parseLogcatLine, parseLogcat, logcatArgv, LOGCAT_LINES_DEFAULT, LOGCAT_LINES_MAX, LOGCAT_LEVELS,
  mobileForward, extractDevtoolsSockets, normalizeLocalPort, CDP_PROBE_TIMEOUT_MS,
  mobileApkInfo, parseAaptBadging, isApkMagic,
  mobileDebugPlan, normalizeSymptom, MOBILE_PLAN_PLATFORMS, MOBILE_SYMPTOMS,
  mobileSelfTest,
} from "../lib/mobile.ts";
import { whichTool } from "../lib/cloud.ts";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";
import { startWebServer } from "../web/entry.ts";
import { snapshotEnv, clearEnv, restoreEnv, type EnvSnapshot } from "./env-hygiene";

const POSIX = process.platform !== "win32"; // 假脚本注入只在 POSIX（win32 诚实 skipIf）

function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-mobile-${tag}-`));
}

function w(ws: string, rel: string, content: string | Uint8Array): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** PATH 置空宇宙（与 tests/cloud.test.ts 同规）。 */
function withEmptyPath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

// ---- 假 adb / aapt / idevice_id 脚本注入（真实车道可测：形态正则，不锁次序） ----

const FAKE_BIN = path.join(TEST_RUN, "mobile-fake-bin");
const IOS_BIN = path.join(TEST_RUN, "mobile-fake-ios-bin");

/**
 * 假 adb：`--version` → 版本串；`devices [-l]` → cat FAKE_ADB_DEVICES_FILE；
 * `logcat …`（$1 或 $3 命中）→ cat FAKE_ADB_LOGCAT_FILE；`-s S forward …` →
 * ARGV 回显 + FAKE_ADB_FORWARD_EXIT；`-s S shell cat /proc/net/unix` → cat
 * FAKE_ADB_UNIX_FILE；`-s S shell pidof PKG` → 回显 FAKE_ADB_PIDOF。
 * 附加输出恒带 `ARGV:<参数连接>` 行（参数构造断言面 —— 数组形态即零 shell 面）。
 */
function makeFakeAdb(dir: string): void {
  fs.writeFileSync(path.join(dir, "adb"), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    '  printf "Android Debug Bridge version 1.0.41\\nVersion 35.0.2-12498017\\n"',
    "  exit 0",
    "fi",
    'if [ "$1" = "devices" ]; then',
    '  if [ -n "$FAKE_ADB_DEVICES_FILE" ]; then cat "$FAKE_ADB_DEVICES_FILE"; fi',
    '  exit "${FAKE_ADB_EXIT:-0}"',
    "fi",
    'if [ "$1" = "logcat" ] || [ "$3" = "logcat" ]; then',
    '  # 忠实模拟 -s TAG 服务端过滤（仅 logcat 之后的 -s，serial 在前不误伤）',
    '  tag=""',
    '  prev=""',
    '  inlog=0',
    '  for a in "$@"; do',
    '    if [ "$a" = "logcat" ]; then inlog=1; prev=""; continue; fi',
    '    if [ "$inlog" = "1" ] && [ "$prev" = "-s" ]; then tag="$a"; fi',
    '    prev="$a"',
    '  done',
    '  if [ -n "$FAKE_ADB_LOGCAT_FILE" ]; then',
    '    if [ -n "$tag" ]; then',
    '      grep -E " ${tag}: " "$FAKE_ADB_LOGCAT_FILE" || true',
    "    else",
    '      cat "$FAKE_ADB_LOGCAT_FILE"',
    "    fi",
    "  fi",
    '  exit "${FAKE_ADB_EXIT:-0}"',
    "fi",
    'if [ "$3" = "forward" ]; then',
    '  printf "ARGV:%s\\n" "$*"',
    '  exit "${FAKE_ADB_FORWARD_EXIT:-0}"',
    "fi",
    'if [ "$3" = "shell" ] && [ "$4" = "cat" ]; then',
    '  printf "ARGV:%s\\n" "$*"',
    '  if [ -n "$FAKE_ADB_UNIX_FILE" ]; then cat "$FAKE_ADB_UNIX_FILE"; fi',
    "  exit 0",
    "fi",
    'if [ "$3" = "shell" ] && [ "$4" = "pidof" ]; then',
    '  printf "ARGV:%s\\n" "$*"',
    '  if [ -n "$FAKE_ADB_PIDOF" ]; then printf "%s\\n" "$FAKE_ADB_PIDOF"; fi',
    '  exit "${FAKE_ADB_PIDOF_EXIT:-0}"',
    "fi",
    'printf "ARGV:%s\\n" "$*"',
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(dir, "adb"), 0o755);
}

/** 假 aapt：version 探活 + `dump badging <file>` → cat FAKE_AAPT_BADGING_FILE。 */
function makeFakeAapt(dir: string): void {
  fs.writeFileSync(path.join(dir, "aapt"), [
    "#!/bin/sh",
    'if [ "$1" = "version" ]; then',
    '  printf "Android Asset Packaging Tool 8.1.0\\n"',
    "  exit 0",
    "fi",
    'if [ "$1" = "dump" ] && [ "$2" = "badging" ]; then',
    '  printf "ARGV:%s\\n" "$*"',
    '  if [ -n "$FAKE_AAPT_BADGING_FILE" ]; then cat "$FAKE_AAPT_BADGING_FILE"; fi',
    '  exit "${FAKE_AAPT_EXIT:-0}"',
    "fi",
    'printf "ARGV:%s\\n" "$*"',
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(dir, "aapt"), 0o755);
}

/** 假 idevice_id：`-l` → 一行 UDID（iOS 面车道）。 */
function makeFakeIdeviceId(dir: string): void {
  fs.writeFileSync(path.join(dir, "idevice_id"), [
    "#!/bin/sh",
    'if [ "$1" = "-l" ]; then printf "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\\n"; fi',
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(dir, "idevice_id"), 0o755);
}

const FAKE_KEYS = [
  "FAKE_ADB_DEVICES_FILE", "FAKE_ADB_LOGCAT_FILE", "FAKE_ADB_UNIX_FILE",
  "FAKE_ADB_PIDOF", "FAKE_ADB_PIDOF_EXIT", "FAKE_ADB_EXIT", "FAKE_ADB_FORWARD_EXIT",
  "FAKE_AAPT_BADGING_FILE", "FAKE_AAPT_EXIT",
] as const;

/** PATH 注入宇宙：fakeBin（+ 额外目录，如 iOS 面）前置。FAKE_* 快照/恢复。 */
function injectPath(extraDirs: string[] = []): { savedPath: string; savedFake: Record<string, string | undefined> } {
  const savedFake: Record<string, string | undefined> = {};
  for (const k of FAKE_KEYS) { savedFake[k] = process.env[k]; delete process.env[k]; }
  const savedPath = process.env.PATH!;
  process.env.PATH = [FAKE_BIN, ...extraDirs, savedPath].filter(Boolean).join(path.delimiter);
  return { savedPath, savedFake };
}

function releasePath(ctx: { savedPath: string; savedFake: Record<string, string | undefined> }): void {
  process.env.PATH = ctx.savedPath;
  for (const k of FAKE_KEYS) {
    if (ctx.savedFake[k] === undefined) delete process.env[k];
    else process.env[k] = ctx.savedFake[k]!;
  }
}

function withFakePath<T>(fn: () => T, extraDirs: string[] = []): T {
  const ctx = injectPath(extraDirs);
  try {
    return fn();
  } finally {
    releasePath(ctx);
  }
}

async function withFakePathAsync<T>(fn: () => Promise<T>, extraDirs: string[] = []): Promise<T> {
  const ctx = injectPath(extraDirs);
  try {
    return await fn();
  } finally {
    releasePath(ctx);
  }
}

// ---- 受控输出 fixture（多形态设备清单 / logcat 五元组 / socket 表 / badging） ----

const DEVICES_MULTI = [
  "List of devices attached",
  "SERIAL001            device usb:1-1 product:razor model:Nexus_7 device:flo transport_id:3",
  "emulator-5554        device product:sdk_phone_x86_64 model:Android_SDK_built_for_x86_64 transport_id:4",
  "AUTH-XYZ             unauthorized usb:1-2 transport_id:5",
  "OFF-123              offline transport_id:6",
  "* daemon started successfully",
  "",
].join("\n");

const DEVICES_NONE = "List of devices attached\n\n";
const DEVICES_ALL_UNAUTHORIZED = "List of devices attached\nPHONE-1  unauthorized usb:1-3 transport_id:9\n";

const LOGCAT_FIXTURE = [
  "--------- beginning of main",
  "05-12 10:15:30.123  4321  4321 I ActivityManager: Start proc 4321:com.example.app/u0a123",
  "05-12 10:15:30.456  4321  4400 E AndroidRuntime: FATAL EXCEPTION: main",
  "05-12 10:15:30.457  4321  4400 E AndroidRuntime: java.lang.NullPointerException at com.example.app.MainActivity.onCreate(MainActivity.kt:42)",
  "05-12 10:15:31.001   999  1000 W chromium: [INFO:CONSOLE] Uncaught TypeError",
  "some noise line without five-tuple structure",
  "2024-05-12 10:15:32.000  4321  4321 D chromium: page loaded",
  "",
].join("\n");

const UNIX_WITH_DEVTOOLS = [
  "Num       RefCount Protocol Flags    Type St Path",
  "0        1        00000000 00010000 0001 01 @webview_devtools_remote_4321",
  "1        1        00000000 00010000 0001 01 @chrome_devtools_remote",
  "2        2        00000000 00000000 0001 01 /dev/socket/zygote",
  "",
].join("\n");

const UNIX_NO_DEVTOOLS = "Num RefCount Protocol Flags Type St Path\n2 2 00000000 00000000 0001 01 /dev/socket/zygote\n";

const AAPT_BADGING = [
  "package: name='com.example.app' versionCode='123' versionName='1.2.3' platformBuildVersionName='14'",
  "sdkVersion:'24'",
  "targetSdkVersion:'33'",
  "uses-permission: name='android.permission.INTERNET'",
  "uses-permission: name='android.permission.CAMERA'",
  "application-label:'演示应用'",
  "launchable-activity: name='com.example.app.MainActivity' label='演示'",
  "native-code: 'arm64-v8a', 'armeabi-v7a'",
  "",
].join("\n");

const BADGING_FILE = path.join(TEST_RUN, "mobile-badging.txt");
const DEVICES_FILE = path.join(TEST_RUN, "mobile-devices.txt");
const LOGCAT_FILE = path.join(TEST_RUN, "mobile-logcat.txt");
const UNIX_FILE = path.join(TEST_RUN, "mobile-unix.txt");

/** 伪 APK：PK\x03\x04 魔数 + padding（真 aapt 对它 dump 必败 → 魔数车道恒兜底）。 */
function makeFakeApk(ws: string, rel = "builds/app.apk", magic = true): string {
  const head = magic ? [0x50, 0x4b, 0x03, 0x04] : [0x7f, 0x45, 0x4c, 0x46];
  const buf = new Uint8Array(4096);
  buf.set(head, 0);
  return w(ws, rel, buf);
}

// ---- 环境卫生（.env.local 污染防线 —— web.test.ts 同规，文件级快照/清零/恢复） ----

const __envSnap: EnvSnapshot = snapshotEnv();

beforeAll(() => {
  clearEnv(); // 敏感变量清零（CLI/Web 子进程继承面 —— mobile 不依赖任何 LLM 配置）
  fs.rmSync(FAKE_BIN, { recursive: true, force: true });
  fs.rmSync(IOS_BIN, { recursive: true, force: true });
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(IOS_BIN, { recursive: true });
  makeFakeAdb(FAKE_BIN);
  makeFakeAapt(FAKE_BIN);
  makeFakeIdeviceId(IOS_BIN);
  fs.writeFileSync(DEVICES_FILE, DEVICES_MULTI);
  fs.writeFileSync(LOGCAT_FILE, LOGCAT_FIXTURE);
  fs.writeFileSync(UNIX_FILE, UNIX_WITH_DEVTOOLS);
  fs.writeFileSync(BADGING_FILE, AAPT_BADGING);
});

afterAll(() => {
  restoreEnv(__envSnap);
});

// ---- 1. 纯函数解析器 ---------------------------------------------------------------

describe("移动端：纯函数解析器（adb devices / logcat / aapt / socket / 魔数）", () => {
  test("parseAdbDevices：多设备/未授权/offline/噪音行（头行 + daemon 行忽略 · usb:1-1 整体入 transport）", () => {
    const ds = parseAdbDevices(DEVICES_MULTI);
    expect(ds.length).toBe(4); // 头行/空行/daemon 噪音行全忽略
    expect(ds[0]).toMatchObject({ serial: "SERIAL001", state: "device", transport: "usb:1-1", product: "razor", model: "Nexus_7", device: "flo" });
    expect(ds[1]).toMatchObject({ serial: "emulator-5554", state: "device", product: "sdk_phone_x86_64" });
    expect(ds[2]).toMatchObject({ serial: "AUTH-XYZ", state: "unauthorized", model: null }); // 未授权设备通常无 -l 描述字段
    expect(ds[3]).toMatchObject({ serial: "OFF-123", state: "offline" });
  }, 30_000);

  test("parseAdbDevices：空输入 / 纯噪音 / undefined 容忍（不 throw）", () => {
    expect(parseAdbDevices("")).toEqual([]);
    expect(parseAdbDevices("* daemon not running; starting now at tcp:5037\n")).toEqual([]);
    expect(parseAdbDevices(String(undefined as unknown))).toEqual([]);
  }, 30_000);

  test("parseLogcatLine：MM-DD 缺省形态 + YYYY-MM-DD 年形态 + 噪音行拒绝", () => {
    const e1 = parseLogcatLine("01-02 12:34:56.789  1234  5678 I ActivityManager: Start proc 4321:com.example.app/u0a123");
    expect(e1).toEqual({ time: "01-02 12:34:56.789", pid: "1234", tid: "5678", level: "I", tag: "ActivityManager", message: "Start proc 4321:com.example.app/u0a123" });
    const e2 = parseLogcatLine("2024-01-02 12:34:56.789  999  1000 E AndroidRuntime: FATAL EXCEPTION: main");
    expect(e2!.level).toBe("E");
    expect(e2!.time.startsWith("2024-")).toBe(true);
    expect(parseLogcatLine("--------- beginning of main")).toBeNull();
    expect(parseLogcatLine("some noise line")).toBeNull();
    expect(parseLogcatLine("")).toBeNull();
  }, 30_000);

  test("parseLogcat：整段解析（匹配入列 + 头行不计 + 噪音行计数 skipped）", () => {
    const { entries, skipped } = parseLogcat(LOGCAT_FIXTURE);
    expect(entries.length).toBe(5);
    expect(skipped).toBe(1); // "some noise line without five-tuple structure"
    expect(entries.filter((e) => e.tag === "chromium").length).toBe(2);
    expect(entries.filter((e) => e.level === "E").every((e) => e.tag === "AndroidRuntime")).toBe(true);
  }, 30_000);

  test("parseAaptBadging：package/versionCode/versionName/sdk/权限/native-code/label 全量解析（容忍多余行）", () => {
    const b = parseAaptBadging(AAPT_BADGING);
    expect(b.package).toBe("com.example.app");
    expect(b.versionCode).toBe("123");
    expect(b.versionName).toBe("1.2.3");
    expect(b.sdkVersion).toBe("24");
    expect(b.targetSdkVersion).toBe("33");
    expect(b.applicationLabel).toBe("演示应用");
    expect(b.permissions).toEqual(["android.permission.INTERNET", "android.permission.CAMERA"]);
    expect(b.nativeCode).toEqual(["arm64-v8a", "armeabi-v7a"]);
    // 空输入 → 全 null/空数组（不 throw）
    const empty = parseAaptBadging("");
    expect(empty.package).toBeNull();
    expect(empty.permissions).toEqual([]);
  }, 30_000);

  test("extractDevtoolsSockets：webview/chrome 双源 + @ 前缀剥离 + 非 devtools 行忽略 + 去重", () => {
    const socks = extractDevtoolsSockets(UNIX_WITH_DEVTOOLS + "@webview_devtools_remote_4321\n");
    expect(socks.length).toBe(2); // 重复 socket 去重
    expect(socks).toContain("webview_devtools_remote_4321");
    expect(socks).toContain("chrome_devtools_remote");
    expect(extractDevtoolsSockets(UNIX_NO_DEVTOOLS)).toEqual([]);
  }, 30_000);

  test("isApkMagic：PK\\x03\\x04 正例 + ELF/短/空反例", () => {
    expect(isApkMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(isApkMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false); // EOCD 不是本地文件头
    expect(isApkMagic(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(false); // ELF
    expect(isApkMagic(new Uint8Array([0x50, 0x4b]))).toBe(false); // 过短
    expect(isApkMagic(new Uint8Array(0))).toBe(false);
  }, 30_000);

  test("normalizeSymptom：中英宽容归一（白屏/whitescreen/ANR/卡顿/装不上 → 归一枚举）+ 未知词缺省 crash", () => {
    expect(normalizeSymptom("crash")).toBe("crash");
    expect(normalizeSymptom("ANR 无响应")).toBe("crash");
    expect(normalizeSymptom("白屏")).toBe("white-screen");
    expect(normalizeSymptom("whitescreen")).toBe("white-screen");
    expect(normalizeSymptom("white screen")).toBe("white-screen");
    expect(normalizeSymptom("网络不通")).toBe("network");
    expect(normalizeSymptom("卡顿")).toBe("performance");
    expect(normalizeSymptom("内存泄漏 oom")).toBe("performance");
    expect(normalizeSymptom("构建失败")).toBe("build");
    expect(normalizeSymptom("gradle 编译报错")).toBe("build");
    expect(normalizeSymptom("装不上")).toBe("install");
    expect(normalizeSymptom("install failed")).toBe("install");
    expect(normalizeSymptom("webview 内嵌页异常")).toBe("webview");
    expect(normalizeSymptom("whatever-unknown")).toBe("crash"); // 缺省归最常见入口
    expect(normalizeSymptom("")).toBe("crash");
  }, 30_000);

  test("logcatArgv：`logcat -d -t N *:LEVEL` / `-s TAG` / `-s serial` 形态（纯函数 · 次序不锁死）+ 行数/级别钳制", () => {
    const plain = logcatArgv("/usr/bin/adb", { lines: 100, level: "E" });
    expect(plain.join(" ")).toContain("logcat -d -t 100 *:E");
    const tag = logcatArgv("adb", { lines: 50, tag: "chromium", serial: "X1" });
    expect(tag.join(" ")).toContain("-s X1");
    expect(tag.join(" ")).toContain("logcat -d -t 50");
    expect(tag.join(" ").endsWith("-s chromium")).toBe(true);
    // 行数帽：5000 → 2000；级别白名单外回退 I（诚实：不猜未知级别）
    expect(logcatArgv("adb", { lines: 5000 }).join(" ")).toContain(`-t ${LOGCAT_LINES_MAX}`);
    expect(logcatArgv("adb", { lines: 0, level: "X" }).join(" ")).toContain(`-t ${LOGCAT_LINES_DEFAULT} *:I`);
    expect(LOGCAT_LEVELS).toEqual(["V", "D", "I", "W", "E", "F"]);
  }, 30_000);

  test("normalizeLocalPort：数字 / tcp:N / 非法 → 9222 缺省", () => {
    expect(normalizeLocalPort(9223)).toBe(9223);
    expect(normalizeLocalPort("tcp:9229")).toBe(9229);
    expect(normalizeLocalPort("not-a-port")).toBe(9222);
    expect(normalizeLocalPort(undefined)).toBe(9222);
    expect(normalizeLocalPort(0)).toBe(9222);
    expect(normalizeLocalPort(70000)).toBe(9222);
    expect(CDP_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  }, 30_000);

  test("androidSdkCandidates：ANDROID_HOME/ANDROID_SDK_ROOT 环境优先 + 去重（结构面，不锁具体环境）", () => {
    const saved = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
    try {
      process.env.ANDROID_HOME = "/opt/fake-android-sdk";
      process.env.ANDROID_SDK_ROOT = "/opt/fake-android-sdk2";
      const c = androidSdkCandidates();
      expect(c[0]).toBe("/opt/fake-android-sdk");
      expect(c[1]).toBe("/opt/fake-android-sdk2");
      expect(new Set(c).size).toBe(c.length); // 去重
    } finally {
      if (saved[0] === undefined) delete process.env.ANDROID_HOME; else process.env.ANDROID_HOME = saved[0];
      if (saved[1] === undefined) delete process.env.ANDROID_SDK_ROOT; else process.env.ANDROID_SDK_ROOT = saved[1];
    }
  }, 30_000);
});

// ---- 2. 计划器纯函数矩阵 ------------------------------------------------------------

describe("移动端：调试计划器（纯函数保底车道 —— 零外部依赖永远可用）", () => {
  test("3 平台 × 7 症状矩阵：每步 cmd+expect+degrade 成对 · 编号连续 · 每计划 ≥2 步", () => {
    expect(MOBILE_PLAN_PLATFORMS).toEqual(["android", "ios", "both"]);
    expect(MOBILE_SYMPTOMS.length).toBe(7);
    for (const plat of MOBILE_PLAN_PLATFORMS) {
      for (const sym of MOBILE_SYMPTOMS) {
        const p = mobileDebugPlan(plat, sym);
        expect(p.platform).toBe(plat);
        expect(p.steps.length).toBeGreaterThanOrEqual(2);
        p.steps.forEach((s, i) => {
          expect(s.step).toBe(i + 1);
          expect(s.expect.length).toBeGreaterThan(0);
          expect(s.degrade.length).toBeGreaterThan(0);
          expect(s.title.length).toBeGreaterThan(0);
        });
      }
    }
  }, 30_000);

  test("Android 内容要素：crash 含 AndroidRuntime:E 定点 + 版本对齐；webview 含 forward tcp:9222 + CDP 页面清单；性能含 gfxinfo/meminfo", () => {
    const crash = mobileDebugPlan("android", "crash");
    const flat = (p: ReturnType<typeof mobileDebugPlan>) => p.steps.map((s) => `${s.title}\n${s.cmd ?? ""}\n${s.expect}\n${s.degrade}`).join("\n");
    expect(flat(crash)).toContain("adb logcat -d -s AndroidRuntime:E");
    expect(flat(crash)).toContain("dumpsys package");
    const wv = mobileDebugPlan("android", "webview");
    expect(flat(wv)).toContain("adb forward tcp:9222");
    expect(flat(wv)).toContain("http://127.0.0.1:9222/json");
    const perf = mobileDebugPlan("android", "performance");
    expect(flat(perf)).toContain("dumpsys gfxinfo");
    expect(flat(perf)).toContain("meminfo");
    const net = mobileDebugPlan("android", "network");
    expect(flat(net)).toContain("ping -c 3");
    expect(flat(net)).toContain("cleartext");
  }, 30_000);

  test("iOS 内容要素：idevice 套件（配对/syslog/crashreport）+ WKWebView 走 Safari 远程（iOS 的主车道不是 CDP）", () => {
    const flat = mobileDebugPlan("ios", "crash");
    const text = flat.steps.map((s) => `${s.title}\n${s.cmd ?? ""}`).join("\n");
    expect(text).toContain("idevice_id -l");
    expect(text).toContain("idevicesyslog");
    expect(text).toContain("idevicecrashreport");
    const wv = mobileDebugPlan("ios", "webview");
    expect(wv.steps.some((s) => (s.cmd ?? "").includes("Safari") || s.title.includes("Safari"))).toBe(true);
  }, 30_000);

  test("both 平台 = Android 步骤在前 + iOS 步骤在后（拼接序）；install 症状含 INSTALL_FAILED 错误码语义", () => {
    const a = mobileDebugPlan("android", "crash");
    const i = mobileDebugPlan("ios", "crash");
    const both = mobileDebugPlan("both", "crash");
    expect(both.steps.length).toBe(a.steps.length + i.steps.length);
    expect(both.steps[0]!.title).toBe(a.steps[0]!.title);
    expect(both.steps[a.steps.length]!.title).toBe(i.steps[0]!.title);
    const install = mobileDebugPlan("android", "install");
    const text = install.steps.map((s) => `${s.expect}\n${s.degrade}`).join("\n");
    expect(text).toContain("INSTALL_FAILED");
  }, 30_000);

  test("构建症状：产物核对步指向 org mobile apk（跨子命令降级指引）+ Android Studio 替代车道", () => {
    const build = mobileDebugPlan("android", "build");
    const text = build.steps.map((s) => `${s.cmd ?? ""}\n${s.degrade}`).join("\n");
    expect(text).toContain("org mobile apk");
    expect(text).toContain("gradlew");
  }, 30_000);

  test("平台非法值兜底 android + 症状关键词宽容（中英）+ note 回显原词", () => {
    expect(mobileDebugPlan("webos", "crash").platform).toBe("android");
    const p = mobileDebugPlan("android", "接口打不开");
    expect(p.symptom).toBe("network"); // 「接口」命中 network 关键词
    expect(p.note).toContain("接口打不开");
    expect(p.note).toContain("零外部依赖");
  }, 30_000);

  test("mobileSelfTest：8 项全绿（解析器/计划矩阵/魔数/socket/argv/症状归一 —— 纯内存零副作用）", () => {
    const t = mobileSelfTest();
    expect(t.ok).toBe(true);
    expect(t.passed).toBe(t.total);
    expect(t.total).toBeGreaterThanOrEqual(8);
  }, 30_000);
});

// ---- 3. 降级路径（PATH 置空宇宙；环境自适应：CI 若预装 Android SDK 则 SDK 形态 ------
// ---- 车道命中真 adb —— 锁形态不锁环境，cloud.test.ts v0.5.17.2 哲学） ----------------

describe("移动端：降级路径（无工具宇宙）", () => {
  test("probeMobile：PATH 置空 → 各面诚实缺席（available 布尔 + 缺席 reason 含安装指引）+ 摘要计数", () => {
    const p = withEmptyPath(() => probeMobile());
    const faces = [p.adb, p.aapt, p.aapt2, p.scrcpy, p.ideviceinstaller, p.ideviceId, p.flutter] as const;
    for (const f of faces) {
      expect(typeof f.available).toBe("boolean");
      if (!f.available) {
        expect(f.reason).toBeTruthy();
        expect(f.reason!.length).toBeGreaterThan(10);
      }
    }
    // 沙箱/常见 CI：全缺席 → adb 指引含 platform-tools 与 plan 保底车道
    if (!p.adb.available) {
      expect(p.adb.reason).toContain("platform-tools");
      expect(p.adb.reason).toContain("org mobile plan");
      expect(p.summary.androidFace).toBe(false);
    }
    expect(typeof p.summary.facesUp).toBe("number");
    expect(p.androidHome === null || typeof p.androidHome === "string").toBe(true);
    expect(p.tookMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("mobileDevices：PATH 置空 → tool-absent + 安装指引 + plan 保底指引（或 SDK 车道诚实结果）", () => {
    const r = withEmptyPath(() => mobileDevices());
    if (r.kind === "tool-absent") {
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("adb");
      expect(r.reason).toContain("platform-tools");
      expect(r.devices).toEqual([]);
      expect(r.ios.available).toBe(false); // iOS 面同宇宙缺席（诚实 note）
      expect(r.ios.note).toContain("idevice");
    } else {
      // CI runner 预装 Android SDK 的诚实形态：真 adb 可执行 → 无设备/真实清单
      expect(r.ok).toBe(true);
      expect(Array.isArray(r.devices)).toBe(true);
    }
    expect(r.argv).toContain("devices");
  }, 30_000);

  test("mobileLogcat：PATH 置空 → tool-absent + plan 保底指引（无 adb 时计划车道永远可用）", () => {
    const r = withEmptyPath(() => mobileLogcat({}));
    if (r.kind === "tool-absent") {
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("adb");
      expect(r.reason).toContain("org mobile plan");
    } else {
      expect(r.ok).toBe(true); // SDK 车道真 adb 的诚实结果（无设备等）
    }
    expect(r.entries).toEqual([]);
  }, 30_000);

  test("mobileForward：PATH 置空 → tool-absent（或 SDK 车道诚实降级）+ 不 throw", async () => {
    const r = await withEmptyPath(() => mobileForward({}));
    expect(r.ok).toBe(false);
    expect(["tool-absent", "no-device", "unauthorized", "multi-device", "timeout", "failed"]).toContain(r.kind);
    expect(r.reason).toBeTruthy();
  }, 30_000);

  test("mobileApkInfo：aapt 缺席 → 魔数车道恒交付（魔数 ✓ + 大小 + 诚实指引）；非 APK 魔数 → failed", () => {
    const ws = tmpWs("magic");
    try {
      const apk = makeFakeApk(ws);
      const r = withEmptyPath(() => mobileApkInfo(ws, "builds/app.apk"));
      expect(r.ok).toBe(true);
      expect(r.lane === "magic" || r.lane === "aapt").toBe(true); // 真 aapt 对伪 APK dump 必败 → 魔数兜底恒成立
      expect(r.sizeBytes).toBe(4096);
      expect(r.magic!.apk).toBe(true);
      if (r.lane === "magic") expect(r.reason).toContain("诚实降级");
      expect(apk.length).toBeGreaterThan(0);
      // 非 APK 魔数（ELF 头）→ failed + 文件头预览
      makeFakeApk(ws, "builds/not-apk", false);
      const bad = withEmptyPath(() => mobileApkInfo(ws, "builds/not-apk"));
      expect(bad.ok).toBe(false);
      expect(bad.kind).toBe("failed");
      expect(bad.reason).toContain("不是 APK 魔数");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("mobileApkInfo：jail 铁律 —— ../../ 逃逸与绝对路径拒绝（先于任何读盘）+ 空参数", () => {
    const ws = tmpWs("jail");
    try {
      const esc = mobileApkInfo(ws, "../../etc/passwd");
      expect(esc.ok).toBe(false);
      expect(esc.kind).toBe("jail");
      expect(esc.reason).toContain("越界");
      const abs = mobileApkInfo(ws, "/etc/passwd");
      expect(abs.ok).toBe(false);
      expect(abs.kind).toBe("jail");
      const empty = mobileApkInfo(ws, "");
      expect(empty.ok).toBe(false);
      expect(empty.reason).toContain("必填");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("mobileApkInfo：文件不存在 → failed（可读性错误，非越界）", () => {
    const ws = tmpWs("noread");
    try {
      const r = mobileApkInfo(ws, "ghost.apk");
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("failed");
      expect(r.reason).toContain("不可读");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("whichTool：PATH 置空 → adb/aapt 定位 null（定位器本体的降级语义）", () => {
    expect(withEmptyPath(() => whichTool("adb"))).toBeNull();
    expect(withEmptyPath(() => whichTool("aapt"))).toBeNull();
  }, 30_000);
});

// ---- 4. 真实车道可测（假 adb/aapt/idevice_id 注入 PATH —— POSIX） -------------------

describe.skipIf(!POSIX)("移动端：假 adb 车道（探测/设备清单多形态/参数构造）", () => {
  test("probeMobile：假 adb + 假 aapt → 双面在场 + 版本解析（1.0.41 / 8.1.0）+ 摘要计数", () => {
    const p = withFakePath(() => probeMobile());
    expect(p.adb.available).toBe(true);
    expect(p.adb.version).toBe("1.0.41");
    expect(p.aapt.available).toBe(true);
    expect(p.summary.androidFace).toBe(true);
    expect(p.summary.apkFace).toBe(true);
    expect(p.summary.iosFace).toBe(false); // iOS 面未注入 → 诚实缺席
    expect(p.summary.crossFace).toBe(false);
    expect(p.summary.facesUp).toBeGreaterThanOrEqual(2); // adb + aapt
  }, 30_000);

  test("mobileDevices：多形态清单（就绪×2 + 未授权 + offline）→ 4 台就绪 2 + 未授权/offline 诚实入列", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      const r = mobileDevices();
      expect(r.ok).toBe(true);
      expect(r.devices.length).toBe(4);
      expect(r.ready).toBe(2);
      expect(r.devices[0]!.serial).toBe("SERIAL001");
      expect(r.devices[2]!.state).toBe("unauthorized");
      expect(r.argv.join(" ")).toContain("devices -l");
      expect(r.ios.available).toBe(false); // iOS 面缺席诚实降级（note 有指引）
      expect(r.ios.note).toContain("idevice");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileDevices：iOS 面注入假 idevice_id → available + UDID 列表（iOS 车道）", () => {
    const ctx = injectPath([IOS_BIN]);
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      const r = mobileDevices();
      expect(r.ok).toBe(true);
      expect(r.ios.available).toBe(true);
      expect(r.ios.udids).toEqual(["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"]);
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileDevices：无设备 → ok:true + USB 调试开启指引（无设备是状态不是失败）", () => {
    const ctx = injectPath();
    try {
      const none = path.join(TEST_RUN, "mobile-devices-none.txt");
      fs.writeFileSync(none, DEVICES_NONE);
      process.env.FAKE_ADB_DEVICES_FILE = none;
      const r = mobileDevices();
      expect(r.ok).toBe(true);
      expect(r.devices).toEqual([]);
      expect(r.reason).toContain("USB 调试");
      expect(r.reason).toContain("org mobile plan");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileDevices：全未授权 → 就绪 0 + 解锁屏幕授权弹窗指引", () => {
    const ctx = injectPath();
    try {
      const un = path.join(TEST_RUN, "mobile-devices-unauth.txt");
      fs.writeFileSync(un, DEVICES_ALL_UNAUTHORIZED);
      process.env.FAKE_ADB_DEVICES_FILE = un;
      const r = mobileDevices();
      expect(r.ok).toBe(true);
      expect(r.ready).toBe(0);
      expect(r.reason).toContain("unauthorized");
      expect(r.reason).toContain("允许");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileDevices：adb 退出码非 0 → failed + stderr 首行", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_EXIT = "3";
      const r = mobileDevices();
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("failed");
      expect(r.reason).toContain("3");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);
});

describe.skipIf(!POSIX)("移动端：假 adb 车道（logcat dump + 过滤 + 降级）", () => {
  test("mobileLogcat：单就绪序列号 → 五元组 5 条 + 头行不计噪音 1 + argv 形态（-d -t 200 *:I）", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      const r = mobileLogcat({ serial: "SERIAL001" });
      expect(r.ok).toBe(true);
      expect(r.entries.length).toBe(5);
      expect(r.skipped).toBe(1);
      const argv = r.argv.join(" ");
      expect(argv).toContain("-s SERIAL001");
      expect(argv).toContain("logcat -d -t 200 *:I"); // 数组形态即零 shell 面的证明
      expect(r.entries[0]!.tag).toBe("ActivityManager");
      expect(r.entries[1]!.level).toBe("E");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileLogcat：tag 过滤（-s chromium 收尾）+ 级别 E（*:E 形态）+ 行数钳制（5000 → 2000）", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      const tag = mobileLogcat({ serial: "SERIAL001", tag: "chromium" });
      expect(tag.ok).toBe(true);
      expect(tag.argv.join(" ").endsWith("-s chromium")).toBe(true);
      expect(tag.entries.every((e) => e.tag === "chromium")).toBe(true);
      expect(tag.entries.length).toBe(2);
      const err = mobileLogcat({ serial: "SERIAL001", level: "E" });
      expect(err.argv.join(" ")).toContain("*:E");
      const clamped = mobileLogcat({ serial: "SERIAL001", lines: 5000 });
      expect(clamped.argv.join(" ")).toContain(`-t ${LOGCAT_LINES_MAX}`);
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileLogcat：包名过滤 —— pidof 命中 pid → 客户端侧按 pid 过滤（argv 含 pidof）", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      process.env.FAKE_ADB_PIDOF = "4321";
      const r = mobileLogcat({ serial: "SERIAL001", package: "com.example.app" });
      expect(r.ok).toBe(true);
      expect(r.argv.join(" ")).not.toContain("pidof"); // pidof 是二次探测（不在主 argv）
      expect(r.entries.length).toBe(4); // pid 999 的 chromium W 行被滤掉
      expect(r.entries.every((e) => e.pid === "4321")).toBe(true);
      expect(r.reason).toContain("com.example.app");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileLogcat：包未运行（pidof 空）→ 诚实空 + 启动指引（monkey 可粘贴命令）", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      process.env.FAKE_ADB_PIDOF = "";
      const r = mobileLogcat({ serial: "SERIAL001", package: "com.example.app" });
      expect(r.ok).toBe(true);
      expect(r.entries).toEqual([]);
      expect(r.reason).toContain("未在运行");
      expect(r.reason).toContain("monkey");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileLogcat：多设备未指定 serial → multi-device 降级 + serial 指引；未授权 serial → unauthorized", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      const multi = mobileLogcat({});
      expect(multi.ok).toBe(false);
      expect(multi.kind).toBe("multi-device");
      expect(multi.reason).toContain("serial");
      const unauth = mobileLogcat({ serial: "AUTH-XYZ" });
      expect(unauth.ok).toBe(false);
      expect(unauth.kind).toBe("unauthorized");
      expect(unauth.reason).toContain("授权");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileLogcat：adb logcat 退出码非 0 → failed；快照空（fixtures 空）→ 诚实空 + 放宽指引", () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      process.env.FAKE_ADB_EXIT = "5";
      const r = mobileLogcat({ serial: "SERIAL001" });
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("failed");
      expect(r.reason).toContain("5");
      delete process.env.FAKE_ADB_EXIT;
      const empty = path.join(TEST_RUN, "mobile-logcat-empty.txt");
      fs.writeFileSync(empty, "--------- beginning of main\n");
      process.env.FAKE_ADB_LOGCAT_FILE = empty;
      const blank = mobileLogcat({ serial: "SERIAL001" });
      expect(blank.ok).toBe(true);
      expect(blank.entries).toEqual([]);
      expect(blank.reason).toContain("空");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);
});

describe.skipIf(!POSIX)("移动端：假 adb 车道（forward 四层降级 + 真本地 CDP 服务）", () => {
  test("mobileForward：socket 自动发现 → forward 形态 → 真本地 CDP HTTP 可达 → 页面清单（全链 happy path）", async () => {
    const cdp = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/json") {
          return Response.json([
            { title: "演示页", url: "https://example.com/h5", type: "page" },
            { title: "", url: "about:blank", type: "page" },
          ]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const ctx = injectPath();
      try {
        process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
        process.env.FAKE_ADB_UNIX_FILE = UNIX_FILE;
        const r = await mobileForward({ serial: "SERIAL001", local: cdp.port });
        expect(r.ok).toBe(true);
        expect(r.serial).toBe("SERIAL001");
        expect(r.localPort).toBe(cdp.port);
        expect(r.sockets).toContain("webview_devtools_remote_4321");
        expect(r.remote).toBe("localabstract:webview_devtools_remote_4321");
        expect(r.argv.join(" ")).toContain(`forward tcp:${cdp.port} localabstract:webview_devtools_remote_4321`);
        expect(r.cdp!.reachable).toBe(true);
        expect(r.cdp!.pages.length).toBe(2);
        expect(r.cdp!.pages[0]!.title).toBe("演示页");
      } finally {
        releasePath(ctx);
      }
    } finally {
      cdp.stop(true);
    }
  }, 30_000);

  test("mobileForward：CDP 可达但页面清单空 → page-empty + 先导航指引", async () => {
    const cdp = Bun.serve({ port: 0, fetch: () => Response.json([]) });
    try {
      const ctx = injectPath();
      try {
        process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
        process.env.FAKE_ADB_UNIX_FILE = UNIX_FILE;
        const r = await mobileForward({ serial: "SERIAL001", local: cdp.port });
        expect(r.ok).toBe(true); // 可达即成功（空页面是状态不是失败 —— kind 标注观察）
        expect(r.kind).toBe("page-empty");
        expect(r.reason).toContain("页面清单为空");
      } finally {
        releasePath(ctx);
      }
    } finally {
      cdp.stop(true);
    }
  }, 30_000);

  test("mobileForward：设备上无 devtools socket → socket-not-found + 开启 WebView 调试指引（setWebContentsDebuggingEnabled）", async () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      const noSock = path.join(TEST_RUN, "mobile-unix-none.txt");
      fs.writeFileSync(noSock, UNIX_NO_DEVTOOLS);
      process.env.FAKE_ADB_UNIX_FILE = noSock;
      const r = await mobileForward({ serial: "SERIAL001" });
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("socket-not-found");
      expect(r.reason).toContain("setWebContentsDebuggingEnabled");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileForward：forward 建立但 CDP HTTP 不可达 → socket-unreachable（含 socket 候选清单回显）", async () => {
    // 借一个空闲端口：起服务拿端口后立刻停 → 该端口大概率保持空闲
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_UNIX_FILE = UNIX_FILE;
      const r = await mobileForward({ serial: "SERIAL001", local: port, cdpTimeoutMs: 500 });
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("socket-unreachable");
      expect(r.reason).toContain(`tcp:${port}`);
      expect(r.reason).toContain("webview_devtools_remote_4321");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);

  test("mobileForward：显式 remote 裸 socket 名 → localabstract: 前缀归一；多设备未指定 serial → multi-device", async () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_UNIX_FILE = UNIX_FILE;
      const r = await mobileForward({ serial: "SERIAL001", local: "tcp:9229", remote: "webview_devtools_remote_777", cdpTimeoutMs: 400 });
      expect(r.remote).toBe("localabstract:webview_devtools_remote_777");
      expect(r.localPort).toBe(9229);
      expect(r.ok).toBe(false); // 9229 无监听 → socket-unreachable（形态已验）
      expect(r.kind).toBe("socket-unreachable");
      const multi = await mobileForward({ cdpTimeoutMs: 400 });
      expect(multi.ok).toBe(false);
      expect(multi.kind).toBe("multi-device");
    } finally {
      releasePath(ctx);
    }
  }, 30_000);
});

describe.skipIf(!POSIX)("移动端：假 aapt 车道（APK 检查两层降级）", () => {
  test("mobileApkInfo：aapt 在场 → badging 全量解析（包名/版本/权限/native-code）+ argv 含 dump badging", () => {
    const ws = tmpWs("aapt");
    try {
      makeFakeApk(ws);
      const ctx = injectPath();
      try {
        process.env.FAKE_AAPT_BADGING_FILE = BADGING_FILE;
        const r = mobileApkInfo(ws, "builds/app.apk");
        expect(r.ok).toBe(true);
        expect(r.lane).toBe("aapt");
        expect(r.badging!.package).toBe("com.example.app");
        expect(r.badging!.versionCode).toBe("123");
        expect(r.badging!.sdkVersion).toBe("24");
        expect(r.badging!.permissions.length).toBe(2);
        expect(r.badging!.nativeCode).toContain("arm64-v8a");
      } finally {
        releasePath(ctx);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("mobileApkInfo：aapt 执行失败 → 魔数车道降级（两层降级完整：魔数 ✓ + 大小 + 指引）", () => {
    const ws = tmpWs("aapt-fail");
    try {
      makeFakeApk(ws);
      const ctx = injectPath();
      try {
        process.env.FAKE_AAPT_BADGING_FILE = BADGING_FILE;
        process.env.FAKE_AAPT_EXIT = "1";
        const r = mobileApkInfo(ws, "builds/app.apk");
        expect(r.ok).toBe(true);
        expect(r.lane).toBe("magic");
        expect(r.magic!.apk).toBe(true);
        expect(r.reason).toContain("魔数车道降级");
      } finally {
        releasePath(ctx);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("mobileApkInfo：aapt 输出无 package 行 → failed + AndroidManifest 提示（aapt 对非 APK 也能跑）", () => {
    const ws = tmpWs("aapt-nopkg");
    try {
      makeFakeApk(ws);
      const ctx = injectPath();
      try {
        const nopkg = path.join(TEST_RUN, "mobile-badging-nopkg.txt");
        fs.writeFileSync(nopkg, "sdkVersion:'24'\napplication-label:'x'\n");
        process.env.FAKE_AAPT_BADGING_FILE = nopkg;
        const r = mobileApkInfo(ws, "builds/app.apk");
        expect(r.ok).toBe(false);
        expect(r.lane).toBe("aapt");
        expect(r.reason).toContain("package");
      } finally {
        releasePath(ctx);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 5. CLI 冒烟（runOrg 真子进程）---------------------------------------------------

describe("移动端：CLI 冒烟（org mobile）", () => {
  test("org mobile probe：三面探测输出 + iOS/跨端面 + 保底车道指引；self-test 8/8", () => {
    const p = runOrg(["mobile", "probe"]);
    expect(p.ok).toBe(true);
    expect(p.stdout).toContain("📱");
    expect(p.stdout).toContain("adb");
    expect(p.stdout).toContain("ideviceinstaller");
    expect(p.stdout).toContain("flutter");
    expect(p.stdout).toContain("Android SDK 根");
    expect(p.stdout).toContain("面就绪");
    const t = runOrg(["mobile", "self-test"]);
    expect(t.ok).toBe(true);
    expect(t.stdout).toContain("8/8 通过");
  }, 120_000);

  test("org mobile plan both 白屏：双平台计划（Android chromium/CDP + iOS WKWebView/Safari）+ 步骤编号", () => {
    const r = runOrg(["mobile", "plan", "both", "白屏"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("平台 both · 症状 white-screen");
    expect(r.stdout).toContain("chromium");
    expect(r.stdout).toContain("Safari");
    expect(r.stdout).toContain("预期：");
    expect(r.stdout).toContain("降级：");
    const bad = runOrg(["mobile", "plan", "webos"]);
    expect(bad.ok).toBe(false);
    expect(bad.stderr).toContain("android/ios/both");
  }, 120_000);

  test.skipIf(!POSIX)("org mobile devices：假 adb 注入 PATH → 4 台就绪 2 + 未授权诚实入列 + argv 观测面", () => {
    const r = runOrg(["mobile", "devices"], {
      PATH: [FAKE_BIN, process.env.PATH!].join(path.delimiter),
      FAKE_ADB_DEVICES_FILE: DEVICES_FILE,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("4 台 · 就绪 2");
    expect(r.stdout).toContain("SERIAL001");
    expect(r.stdout).toContain("unauthorized");
    expect(r.stdout).toContain("devices -l");
    expect(r.stdout).toContain("iOS 面");
  }, 120_000);

  test.skipIf(!POSIX)("org mobile logcat：--serial/--tag → 五元组渲染 + argv 形态", () => {
    const r = runOrg(["mobile", "logcat", "--serial", "SERIAL001", "--tag", "chromium", "--lines", "500"], {
      PATH: [FAKE_BIN, process.env.PATH!].join(path.delimiter),
      FAKE_ADB_DEVICES_FILE: DEVICES_FILE,
      FAKE_ADB_LOGCAT_FILE: LOGCAT_FILE,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("logcat dump");
    expect(r.stdout).toContain("chromium");
    expect(r.stdout).toContain("logcat -d -t 500");
    expect(r.stdout).toContain("-s chromium");
  }, 120_000);

  test.skipIf(!POSIX)("org mobile apk：jail 越界 → exit 1 + 越界文案；假 aapt → badging 渲染", () => {
    const esc = runOrg(["mobile", "apk", "../../etc/passwd"]);
    expect(esc.ok).toBe(false);
    expect(esc.stderr).toContain("越界");
    const ws = tmpWs("cli-apk");
    try {
      makeFakeApk(ws);
      const r = runOrg(["mobile", "apk", "builds/app.apk", "--workspace", ws], {
        PATH: [FAKE_BIN, process.env.PATH!].join(path.delimiter),
        FAKE_AAPT_BADGING_FILE: BADGING_FILE,
      });
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("车道 aapt");
      expect(r.stdout).toContain("com.example.app");
      expect(r.stdout).toContain("android.permission.INTERNET");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);

  test("org mobile 未知子命令 → exit 2 + 用法清单（七面）", () => {
    const r = runOrg(["mobile", "sideload"]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("未知子命令");
    expect(r.stderr).toContain("probe");
    expect(r.stderr).toContain("forward");
    expect(r.stderr).toContain("self-test");
  }, 120_000);
});

// ---- 6. Web /api/govex/mobile 五动作 + GUI 区块 --------------------------------------

describe("移动端：Web /api/govex/mobile 端点", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;

  beforeAll(() => {
    ws = path.join(TEST_RUN, "mobile-web-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), ws, { recursive: true });
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.port).toBeGreaterThan(1024);
  }, 120_000);

  afterAll(() => {
    server.stop(true);
  });

  test("GET action=probe：七面键齐全 + summary 计数 + 保底 hint（环境自适应：面在场形态不锁环境）", async () => {
    const j = (await (await fetch(`${base}/api/govex/mobile?action=probe`)).json()) as Record<string, any>;
    expect(j.ok).toBe(true);
    for (const k of ["adb", "aapt", "aapt2", "scrcpy", "ideviceinstaller", "idevice_id", "flutter", "summary", "android_home", "hint"]) {
      expect(j).toHaveProperty(k);
    }
    for (const k of ["adb", "aapt", "scrcpy", "flutter"]) {
      expect(typeof j[k].available).toBe("boolean");
      if (!j[k].available) expect(j[k].reason).toBeTruthy();
    }
    expect(j.summary.facesUp).toBeGreaterThanOrEqual(0);
    expect(j.hint).toContain("org mobile plan");
  }, 60_000);

  test("GET action=devices：假 adb 注入 PATH（服务进程内 spawn 传运行期 env）→ 4 台就绪 2 + iOS 面缺席", async () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      const j = (await (await fetch(`${base}/api/govex/mobile?action=devices`)).json()) as Record<string, any>;
      expect(j.ok).toBe(true);
      expect(j.devices.length).toBe(4);
      expect(j.ready).toBe(2);
      expect(j.devices[0].serial).toBe("SERIAL001");
      expect(j.devices[0].transport).toBe("usb:1-1");
      expect(j.ios.available).toBe(false);
      expect(j.hint).toContain("诚实状态");
    } finally {
      releasePath(ctx);
    }
  }, 60_000);

  test("GET action=logcat：tag=chromium → 五元组条目 + count + argv 形态", async () => {
    const ctx = injectPath();
    try {
      process.env.FAKE_ADB_DEVICES_FILE = DEVICES_FILE;
      process.env.FAKE_ADB_LOGCAT_FILE = LOGCAT_FILE;
      const j = (await (await fetch(`${base}/api/govex/mobile?action=logcat&serial=SERIAL001&tag=chromium`)).json()) as Record<string, any>;
      expect(j.ok).toBe(true);
      expect(j.count).toBe(2);
      expect(j.entries.length).toBe(2);
      expect(j.entries[0].tag).toBe("chromium");
      expect(j.entries[0].message).toBeTruthy();
      expect(j.argv.join(" ")).toContain("-s chromium");
    } finally {
      releasePath(ctx);
    }
  }, 60_000);

  test("GET action=plan&platform=ios&symptom=白屏 → 归一 white-screen + 步骤化计划（纯函数）", async () => {
    const j = (await (await fetch(`${base}/api/govex/mobile?action=plan&platform=ios&symptom=${encodeURIComponent("白屏")}`)).json()) as Record<string, any>;
    expect(j.ok).toBe(true);
    expect(j.platform).toBe("ios");
    expect(j.symptom).toBe("white-screen");
    expect(j.steps.length).toBeGreaterThanOrEqual(2);
    const flat = j.steps.map((s: any) => s.title + " " + (s.cmd ?? "")).join("\n");
    expect(flat).toContain("Safari");
    const bad = await fetch(`${base}/api/govex/mobile?action=plan&platform=webos`);
    expect(bad.status).toBe(400);
  }, 60_000);

  test("GET action=selftest → 8/8；未知 action → 400 + 动作清单", async () => {
    const j = (await (await fetch(`${base}/api/govex/mobile?action=selftest`)).json()) as Record<string, any>;
    expect(j.ok).toBe(true);
    expect(j.passed).toBe(j.total);
    const bad = await fetch(`${base}/api/govex/mobile?action=forward`);
    expect(bad.status).toBe(400);
    const b = (await bad.json()) as Record<string, any>;
    expect(String(b.error)).toContain("probe");
    expect(String(b.error)).toContain("plan");
  }, 60_000);

  test("GUI 单页：📱 Tab + gxSecMobile 区块 + fetch 接线 + 内联脚本 new Function 可解析（wt-iac 教训守卫）", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="gxTabMobile"');
    expect(html).toContain('id="gxSecMobile"');
    expect(html).toContain('"/api/govex/mobile?action=probe');
    expect(html).toContain('"/api/govex/mobile?action=plan');
    expect(html).toContain("gxMobileLogcat");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1]!)).not.toThrow();
  }, 60_000);
});

// ---- 7. 工具环 e2e（scripted 剧本驱动 direct.hsl —— wiring2/lsp.test.ts 同款） ---------

const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

describe("移动端：工具环 e2e（mobile_* 三工具 · 只读模式可用）", () => {
  const WS_ROOT = path.join(TEST_RUN, "mobile-ws");
  let wsSeq = 0;

  function toolResults(out: string): string[] {
    return eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
  }

  test("mobile_devices + mobile_logcat + mobile_plan：result_summary 可观测（假 adb 注入 PATH → 确定性）", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    const fixture = path.join(TEST_RUN, `mobile-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"mobile_devices","args":{}}</tool>',
        '<tool>{"name":"mobile_logcat","args":{"serial":"SERIAL001","tag":"chromium"}}</tool>',
        '<tool>{"name":"mobile_plan","args":{"platform":"android","symptom":"crash"}}</tool>',
        "最终答案：三工具全部可观测。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-mobile", "three-tools");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 移动端工具环接线",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "mobile", ORG_ASK_QUESTION: "接线", ORG_TOOLS: "1",
      PATH: [FAKE_BIN, process.env.PATH!].join(path.delimiter),
      FAKE_ADB_DEVICES_FILE: DEVICES_FILE, FAKE_ADB_LOGCAT_FILE: LOGCAT_FILE,
    });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(3);
    expect(tr[0]).toContain("mobile_devices ok 4台（就绪2） top=SERIAL001(device)");
    expect(tr[1]).toMatch(/^mobile_logcat ok 2条(（截断）)? 未匹配0 top=chromium \d+ms$/);
    expect(tr[2]).toContain("mobile_plan ok android crash 4步（纯函数保底）");
  }, 120_000);

  test("mobile_plan 非法平台 + mobile_logcat 多设备降级：错误摘要面可观测（kind 进 result_summary）", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    const fixture = path.join(TEST_RUN, `mobile-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"mobile_plan","args":{"platform":"webos","symptom":"crash"}}</tool>',
        '<tool>{"name":"mobile_logcat","args":{}}</tool>',
        "最终答案：错误面可观测。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-mobile", "errors");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 移动端工具环降级",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], {
      ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "mobile2", ORG_ASK_QUESTION: "降级", ORG_TOOLS: "1",
      PATH: [FAKE_BIN, process.env.PATH!].join(path.delimiter),
      FAKE_ADB_DEVICES_FILE: DEVICES_FILE, FAKE_ADB_LOGCAT_FILE: LOGCAT_FILE,
    });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(2);
    expect(tr[0]).toContain("mobile_plan error");
    expect(tr[0]).toContain("android/ios/both");
    expect(tr[1]).toContain("mobile_logcat error [multi-device]");
  }, 120_000);
});
