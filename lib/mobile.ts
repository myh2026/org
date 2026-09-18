// ============================================================================
// lib/mobile.ts — 移动端调试统一模块（v0.5.18 · capabilities #117）
// ----------------------------------------------------------------------------
// 一个模块钉住「桌面 Agent 的移动端调试能力」：Android 面探测（adb / aapt /
// aapt2 / scrcpy）、iOS 面（ideviceinstaller / idevice_id）、跨端面（flutter）。
// CLI（org mobile）、工具环（mobile_* 三工具）、Web（🛡 govex 📱 移动端区块）
// 三端同源消费 —— 单一实现防口径漂移（v0.5.17 cloud/collab/lsp 接线模式的
// 延续）。
//
// 设计灵魂 = 多重优雅降级（铁律：每层缺席 → 指引 → 保底车道）：
//   · mobileDevices / mobileLogcat 三层：adb 缺席（tool-absent + 安装指引）
//     → 无设备（no-device + USB 调试开启指引）→ 未授权（unauthorized +
//     设备端弹窗确认指引）；未授权/offline 是设备清单里的诚实状态而非失败；
//   · mobileForward 四层：adb 缺席 → 设备（含 socket 发现：/proc/net/unix
//     扫 webview_devtools_remote_*，无 socket 给「开启 WebView 调试」指引）
//     → socket（adb forward 执行 + http://127.0.0.1:<port>/json 可达性探测
//     fetch + 硬超时）→ 页面（CDP 页面清单 title/url，空清单给指引）；
//   · mobileApkInfo 两层：aapt/aapt2 在场 → dump badging 解析（package/
//     versionCode/sdkVersion/uses-permission 摘要）；缺席 → APK 魔数
//     （PK\x03\x04）+ 文件大小 + 诚实指引 —— 魔数车道永远可用；
//   · mobileDebugPlan 是纯函数保底车道（零外部依赖，任何环境永远可用）：
//     （平台 android/ios/both × 症状 crash/白屏/网络/性能/构建失败…）矩阵
//     → 步骤化计划，每步 = 命令 + 预期 + 降级指引。
//
// 安全铁律：
//   · 零 shell 注入面：所有外部命令走 Bun.spawnSync 数组参数（与 cloud.ts
//     同规）；用户输入永远是 argv 的一个元素，不经字符串拼接、不经 shell；
//   · 路径监狱：mobileApkInfo 的 APK 路径过 lib/pathjail.ts（v0.5.16.1 的
//     跨平台比较形单点收敛）—— 越界即拒，拒绝先于任何读盘；
//   · 全只读车道：devices/logcat（-d dump 非尾随）/forward/apk/probe/plan
//     不做任何 install/uninstall/wipe/reset 类变更动作 —— 需要时人工执行
//     （install/uninstall 命令出现在计划器的可粘贴命令里，不在执行面）。
//
// 诚实边界：
//   · 沙箱/CI 无 adb/无真机 —— 真实车道代码路径完整但只对「工具在场」的
//     环境生效；tests/mobile.test.ts 用假 adb/假 aapt/假 idevice_id 脚本注入
//     PATH 测真实车道（解析器全为纯函数，形态正则断言不锁死输出）；
//   · logcat 是 dump 车道（-d 一次性快照）；真·流式尾随与 CDP 协议深度
//     （evaluate/DOM 操作）是路线图；
//   · iOS 面只到「设备发现 + 工具探测」深度（ideviceinstaller 列 app 需要
//     USB 配对信任）；真 Xcode 深度链路（Instruments/符号化）不在面内。
// ============================================================================
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inWorkspace, resolveInWorkspace } from "./pathjail.ts";
import { whichTool } from "./cloud.ts"; // PATH 扫描定位器单一真源（win32 .exe 兼容 · 读运行期 PATH —— 可测性）

// ---- 预算与常量 ---------------------------------------------------------------

/** 版本探活超时（坏安装快速降级）。 */
const PROBE_VERSION_TIMEOUT_MS = 5_000;
/** adb devices / logcat dump / forward 执行车道缺省硬超时。 */
const RUN_DEFAULT_TIMEOUT_MS = 20_000;
/** 超时上限。 */
const RUN_MAX_TIMEOUT_MS = 60_000;
/** stdout/stderr 捕获帽（结果面回传 CLI/Web/工具环的载荷保护）。 */
const OUTPUT_CAP = 64 * 1024;
/** CDP /json 可达性探测超时（fetch + AbortController）。 */
export const CDP_PROBE_TIMEOUT_MS = 3_000;
/** logcat 行数缺省与钳制（1..2000）。 */
export const LOGCAT_LINES_DEFAULT = 200;
export const LOGCAT_LINES_MAX = 2_000;
/** logcat 级别白名单（V/D/I/W/E/F —— Android 官方六级）。 */
export const LOGCAT_LEVELS: readonly string[] = ["V", "D", "I", "W", "E", "F"];

/** APK 魔数（ZIP 本地文件头：PK\x03\x04）。 */
const APK_MAGIC: readonly number[] = [0x50, 0x4b, 0x03, 0x04];

/**
 * 数组参数 spawn（零 shell 注入面）+ 硬超时 + 输出帽。失败降级为 null（不 throw）。
 * 显式 `env: process.env`：Bun.spawnSync 缺省传「进程启动时环境快照」而非运行期
 * env（tests/cloud.test.ts 假脚本注入 PATH 模式的必坑 —— v0.5.18 remote 簇实测
 * 教训：不传 env 时运行期 PATH/FAKE_* 注入对子进程不可见）。
 */
function spawnCaptured(argv: string[], timeoutMs: number): { exitCode: number | null; stdout: string; stderr: string } | null {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
      env: process.env,
    } as Parameters<typeof Bun.spawnSync>[1]);
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout?.toString() ?? "").slice(0, OUTPUT_CAP),
      stderr: (r.stderr?.toString() ?? "").slice(0, OUTPUT_CAP),
    };
  } catch {
    return null; // 启动失败 / 超时强杀 → 调用方按缺席/失败降级
  }
}

/** 输出首行（版本串提取用）。 */
function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

// ============================================================================
// ① 探测层（probeMobile —— 多面探测 + 版本解析 + 安装指引）
// ============================================================================

/** 单张工具面探测结果。 */
export interface MobileFaceProbe {
  /** 工具名（adb/aapt/aapt2/scrcpy/ideviceinstaller/idevice_id/flutter）。 */
  name: string;
  available: boolean;
  /** 定位到的可执行（PATH 命中或 SDK 路径形态命中；缺席 null）。 */
  path: string | null;
  /** 版本串（--version 探活解析；缺席/未知 null）。 */
  version: string | null;
  /** 人读注记：缺席时 = 安装指引；在场但版本未知时 = 诚实说明。 */
  reason?: string;
}

/** 面的安装指引（缺席诚实 —— 探测结果与指引成对交付）。 */
export const MOBILE_INSTALL_HINTS: Record<string, string> = {
  adb: "安装 platform-tools：https://developer.android.com/tools/releases/platform-tools（macOS: brew install --cask android-platform-tools；Linux: apt install adb）；或装 Android Studio 后经 ANDROID_HOME 自动定位。无真机/无 adb 时：org mobile plan（步骤化排查计划永远可用）。",
  aapt: "aapt/aapt2 随 SDK build-tools 分发：Android Studio → SDK Manager → Android SDK Build-Tools（或 sdkmanager \"build-tools;34.0.0\"）。缺席时 org mobile apk 走魔数车道（PK\\x03\\x04 + 文件大小 + 指引）。",
  scrcpy: "投屏/操控：https://github.com/Genymobile/scrcpy（macOS: brew install scrcpy；Linux: apt install scrcpy；Windows: scoop install scrcpy）。缺席不影响本模块其余车道。",
  ideviceinstaller: "iOS 面（libimobiledevice 套件）：macOS brew install ideviceinstaller libimobiledevice；Linux apt install ideviceinstaller。需要 USB 配对信任（设备端「信任此电脑」）。",
  idevice_id: "iOS 设备 UDID 列出（libimobiledevice 套件，随 ideviceinstaller 同源分发）。",
  flutter: "跨端面：https://docs.flutter.dev/get-started/install（含 Android/iOS 工具链自检 flutter doctor）。缺席不影响 Android/iOS 原生车道。",
};

/**
 * 探测单张面：which → --version 探活 → 版本解析（缺席即不 spawn 版本探针）。
 * tolerant:true 的面（idevice 系）：探活失败仍视为在场（版本未知如实标注）
 * —— 这些工具的 --version 行为跨版本不一，功能可用性在使用车道实测。
 */
function probeFace(name: string, probeFlag: string[], parseVersion: (out: string) => string | null, opts: { tolerant?: boolean } = {}): MobileFaceProbe {
  const bin = whichTool(name);
  if (bin === null) {
    return { name, available: false, path: null, version: null, reason: MOBILE_INSTALL_HINTS[name] ?? `未找到 ${name}。` };
  }
  const v = spawnCaptured([bin, ...probeFlag], PROBE_VERSION_TIMEOUT_MS);
  if (v === null || v.exitCode !== 0) {
    if (opts.tolerant) {
      return { name, available: true, path: bin, version: null, reason: `${name} 在场但 ${probeFlag.join(" ")} 探活未通过（版本未知 —— 功能可用性在使用车道实测，坏安装在那里诚实暴露）` };
    }
    return { name, available: false, path: bin, version: null, reason: `${name} 存在但 ${probeFlag.join(" ")} 探活失败（坏安装按缺席降级）：${firstLine(v?.stderr ?? "") || firstLine(v?.stdout ?? "")}` };
  }
  const out = v.stdout.trim().length > 0 ? v.stdout : v.stderr;
  const version = parseVersion(out) ?? (firstLine(out) || null);
  return { name, available: true, path: bin, version };
}

/** Android SDK 常见安装位置（ANDROID_HOME/ANDROID_SDK_ROOT 之外的路径形态探测）。 */
export function androidSdkCandidates(): string[] {
  const home = os.homedir();
  const fromEnv = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter((v): v is string => Boolean(v && v.trim().length > 0));
  const common = process.platform === "darwin"
    ? [path.join(home, "Library", "Android", "sdk")]
    : process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk")]
      : [path.join(home, "Android", "Sdk"), "/opt/android-sdk", "/usr/lib/android-sdk"];
  return [...new Set([...fromEnv.map((p) => p.trim()), ...common])];
}

/** 在 SDK 候选位置里定位子目录中的可执行（build-tools 特有：枚举版本目录取最高）。 */
function locateInSdk(rel: string[], exeName: string): string | null {
  const exe = process.platform === "win32" ? `${exeName}.exe` : exeName;
  for (const sdk of androidSdkCandidates()) {
    const direct = path.join(sdk, ...rel, exe);
    try {
      if (fs.statSync(direct).isFile()) return direct;
    } catch { /* 不存在 → 下一候选位 */ }
    // build-tools 特有形态：枚举版本目录取字典序最高（latest 语义）
    if (rel.length === 1 && rel[0] === "build-tools") {
      try {
        const versions = fs.readdirSync(path.join(sdk, "build-tools")).filter((d) => /^\d/.test(d)).sort().reverse();
        for (const v of versions) {
          const c = path.join(sdk, "build-tools", v, exe);
          try { if (fs.statSync(c).isFile()) return c; } catch { /* 继续 */ }
        }
      } catch { /* build-tools 目录不存在 */ }
    }
  }
  return null;
}

/** mobileDebugPlan 平台枚举（CLI/工具环/Web 校验同源）。 */
export const MOBILE_PLAN_PLATFORMS: readonly string[] = ["android", "ios", "both"];

/** 探测总结果（三面：Android / iOS / 跨端 + SDK 定位）。 */
export interface MobileProbe {
  adb: MobileFaceProbe & { androidHome: string | null };
  aapt: MobileFaceProbe;
  aapt2: MobileFaceProbe;
  scrcpy: MobileFaceProbe;
  ideviceinstaller: MobileFaceProbe;
  ideviceId: MobileFaceProbe;
  flutter: MobileFaceProbe;
  /** 定位到的 Android SDK 根（ANDROID_HOME/ANDROID_SDK_ROOT/常见位置；缺席 null）。 */
  androidHome: string | null;
  summary: {
    androidFace: boolean;   // adb 在场
    apkFace: boolean;       // aapt 或 aapt2 在场
    iosFace: boolean;       // ideviceinstaller 或 idevice_id 在场
    crossFace: boolean;     // flutter 在场
    facesUp: number;        // 在场面计数（观测摘要）
  };
  tookMs: number;
}

/** 从可执行路径反推 SDK 根（…/platform-tools/adb → …/）。 */
function sdkOf(bin: string): string | null {
  const norm = bin.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/platform-tools/");
  if (idx >= 0) return norm.slice(0, idx);
  const bIdx = norm.lastIndexOf("/build-tools/");
  return bIdx >= 0 ? norm.slice(0, bIdx) : null;
}

/**
 * 一发多面探测（CLI `org mobile probe` / Web action=probe / 工具环探测摘要
 * 的数据源）。adb 面 = which + SDK 路径形态（ANDROID_HOME/常见位置）双定位；
 * 各面缺席 → 诚实 reason + 安装指引，绝不假装在场。
 */
export function probeMobile(): MobileProbe {
  const t0 = Date.now();
  // adb：which 优先，缺席时 SDK 路径形态（platform-tools）
  const adbWhich = whichTool("adb");
  const adbBin = adbWhich ?? locateInSdk(["platform-tools"], "adb");
  const adbFace: MobileFaceProbe & { androidHome: string | null } = (() => {
    if (adbBin === null) {
      return { name: "adb", available: false, path: null, version: null, androidHome: null, reason: MOBILE_INSTALL_HINTS.adb! };
    }
    const v = spawnCaptured([adbBin, "--version"], PROBE_VERSION_TIMEOUT_MS);
    if (v === null || v.exitCode !== 0) {
      return { name: "adb", available: false, path: adbBin, version: null, androidHome: sdkOf(adbBin), reason: `adb 存在但 --version 探活失败（坏安装按缺席降级）：${firstLine(v?.stderr ?? "")}` };
    }
    const m = v.stdout.match(/version\s+([\w.\-]+)/i);
    return { name: "adb", available: true, path: adbBin, version: m ? m[1]! : firstLine(v.stdout), androidHome: sdkOf(adbBin) };
  })();
  // aapt / aapt2：which + build-tools 版本目录双定位
  const locateAapt = (name: string): string | null => whichTool(name) ?? locateInSdk(["build-tools"], name);
  const probeAaptLike = (name: string): MobileFaceProbe => {
    const bin = locateAapt(name);
    if (bin === null) return { name, available: false, path: null, version: null, reason: MOBILE_INSTALL_HINTS.aapt! };
    const v = spawnCaptured([bin, "version"], PROBE_VERSION_TIMEOUT_MS);
    if (v === null || v.exitCode !== 0) {
      return { name, available: false, path: bin, version: null, reason: `${name} 存在但 version 探活失败：${firstLine(v?.stderr ?? "")}` };
    }
    const m = (v.stdout + v.stderr).match(/aapt2?\)?\s*v?([\d.\-]+)/i);
    return { name, available: true, path: bin, version: m ? m[1]! : firstLine(v.stdout) || firstLine(v.stderr) };
  };
  const aapt = probeAaptLike("aapt");
  const aapt2 = probeAaptLike("aapt2");
  const scrcpy = probeFace("scrcpy", ["--version"], (out) => out.match(/scrcpy\s+v?([\d.\w-]+)/i)?.[1] ?? null);
  const ideviceinstaller = probeFace("ideviceinstaller", ["--version"], (out) => out.match(/ideviceinstaller\s*v?([\d.\w-]+)/i)?.[1] ?? out.match(/\bv([\d.]+)\b/)?.[1] ?? null, { tolerant: true });
  const ideviceId = probeFace("idevice_id", ["--help"], (out) => out.match(/idevice_id\s+v?([\d.\w-]+)/i)?.[1] ?? null, { tolerant: true });
  const flutter = probeFace("flutter", ["--version"], (out) => out.match(/Flutter\s+([\d.\w-]+)/)?.[1] ?? null);
  const androidHome = adbFace.androidHome;
  const tookMs = Date.now() - t0;
  return {
    adb: adbFace,
    aapt, aapt2, scrcpy, ideviceinstaller, ideviceId, flutter,
    androidHome,
    summary: {
      androidFace: adbFace.available,
      apkFace: aapt.available || aapt2.available,
      iosFace: ideviceinstaller.available || ideviceId.available,
      crossFace: flutter.available,
      facesUp: [adbFace.available, aapt.available || aapt2.available, scrcpy.available, ideviceinstaller.available || ideviceId.available, flutter.available].filter(Boolean).length,
    },
    tookMs,
  };
}

// ============================================================================
// ② 设备清单（mobileDevices —— adb devices -l 解析 + 三层降级 + iOS 面）
// ============================================================================

/** 一台 Android 设备（adb devices -l 一行）。 */
export interface MobileDevice {
  /** 设备序列号（USB 序列号 / emulator-5554 / <ip>:<port>）。 */
  serial: string;
  /** 状态：device（就绪）/ unauthorized / offline / recovery / sideload / bootloader。 */
  state: string;
  /** transport 描述字段（-l 输出，如 usb:1-1；缺席 null）。 */
  transport: string | null;
  /** product: 字段（缺席 null —— unauthorized/offline 设备通常没有）。 */
  product: string | null;
  /** model: 字段（人读机型，如 Nexus_7）。 */
  model: string | null;
  /** device: 字段（设备代号，如 flo）。 */
  device: string | null;
}

/**
 * 解析 `adb devices -l` 输出（纯函数 —— tests 锁多设备/未授权/offline 形态）。
 * 容忍：头行 "List of devices attached"、空行、daemon 启动噪音（* 开头行）、
 * 宽窄空白、transport_id 字段。
 */
export function parseAdbDevices(stdout: string): MobileDevice[] {
  const out: MobileDevice[] = [];
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^List of devices attached/i.test(line)) continue;
    if (line.startsWith("*")) continue; // * daemon not running; starting now … / * daemon started successfully
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...rest] = parts;
    const kv = new Map<string, string>();
    for (const tok of rest) {
      const m = tok.match(/^([a-zA-Z_]+):(.*)$/);
      if (m) kv.set(m[1]!, m[1] === "usb" ? tok : m[2]!); // usb:1-1 整体入值（transport 描述字段）
    }
    out.push({
      serial: serial!,
      state: state!,
      // transport 描述字段：-l 输出的 usb:1-1 形态（transport_id 数字形态作兑底）
      transport: kv.get("usb") ?? kv.get("transport") ?? kv.get("transport_id") ?? null,
      product: kv.get("product") ?? null,
      model: kv.get("model") ?? null,
      device: kv.get("device") ?? null,
    });
  }
  return out;
}

/** mobile 模块统一失败分类（每层降级给 kind + 人读 reason）。 */
export type MobileKind =
  | "tool-absent"        // adb/aapt 等 CLI 缺席（附安装指引）
  | "no-device"          // 无设备连接 / serial 不在清单（附 USB 调试指引）
  | "unauthorized"       // 设备未授权（附设备端弹窗确认指引）
  | "multi-device"       // 多设备且未指定 serial（附清单）
  | "socket-not-found"   // 设备上无 webview_devtools_remote socket（附开启调试指引）
  | "socket-unreachable" // forward 后 CDP HTTP 探测不可达
  | "page-empty"         // CDP 页面清单为空（forward 成功但无页面）
  | "jail"               // 路径越工作区监狱
  | "timeout"            // 硬超时
  | "failed";            // 执行了但退出码非 0 / 解析失败

/** 设备清单结果（Android 面 + iOS 面 + 降级分类）。 */
export interface MobileDevicesResult {
  ok: boolean;
  kind?: MobileKind;
  /** 实际执行的 argv（观测面 —— 数组形态即「无 shell 拼接」的证明）。 */
  argv: string[];
  devices: MobileDevice[];
  /** 就绪设备（state=device）计数。 */
  ready: number;
  /** iOS 面：libimobiledevice 工具探测 + UDID 列表（缺席诚实降级）。 */
  ios: { available: boolean; udids: string[]; note: string };
  reason?: string;
  tookMs: number;
}

/** iOS 面探测（idevice_id -l 列 UDID；工具缺席 → 诚实 note，不炸不 throw）。 */
function probeIosFace(): { available: boolean; udids: string[]; note: string } {
  const bin = whichTool("idevice_id");
  if (bin === null) {
    return { available: false, udids: [], note: `iOS 面缺席（idevice_id/ideviceinstaller 未找到）。${MOBILE_INSTALL_HINTS.ideviceinstaller!}` };
  }
  const r = spawnCaptured([bin, "-l"], RUN_DEFAULT_TIMEOUT_MS);
  if (r === null || r.exitCode !== 0) {
    return { available: true, udids: [], note: `idevice_id 在场但列设备失败（设备未连接或未配对信任：${firstLine(r?.stderr ?? "") || "无输出"}）。` };
  }
  const udids = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return {
    available: true,
    udids,
    note: udids.length === 0
      ? "idevice_id 在场但无 iOS 设备（USB 连接并在设备端「信任此电脑」后重试）。"
      : `${udids.length} 台 iOS 设备（UDID 已列出；ideviceinstaller -l 可进一步列 app —— 需要 USB 配对信任）。`,
  };
}

/**
 * mobileDevices()：`adb devices -l` 解析 + 三层降级（adb 缺席 / 无设备 /
 * 未授权 —— unauthorized/offline 设备如实入列并给指引，不是失败）。iOS 面
 * idevice 探测同构（缺席降级）。永不 throw。
 */
export function mobileDevices(): MobileDevicesResult {
  const t0 = Date.now();
  const bin = whichTool("adb") ?? locateInSdk(["platform-tools"], "adb");
  const ios = probeIosFace();
  if (bin === null) {
    return {
      ok: false, kind: "tool-absent", argv: ["adb", "devices", "-l"], devices: [], ready: 0, ios,
      reason: `未找到 adb CLI。${MOBILE_INSTALL_HINTS.adb!}`,
      tookMs: Date.now() - t0,
    };
  }
  const argv = [bin, "devices", "-l"];
  const r = spawnCaptured(argv, RUN_DEFAULT_TIMEOUT_MS);
  if (r === null) {
    return { ok: false, kind: "timeout", argv, devices: [], ready: 0, ios, reason: `adb devices 执行失败或超时（>${RUN_DEFAULT_TIMEOUT_MS}ms 硬超时强杀）`, tookMs: Date.now() - t0 };
  }
  if (r.exitCode !== 0) {
    return { ok: false, kind: "failed", argv, devices: [], ready: 0, ios, reason: `adb devices 退出码 ${r.exitCode}：${firstLine(r.stderr)}`, tookMs: Date.now() - t0 };
  }
  const devices = parseAdbDevices(r.stdout);
  const ready = devices.filter((d) => d.state === "device").length;
  // 三层降级（解析成功后的诚实状态面；无设备/未授权是状态不是失败 → ok:true）
  if (devices.length === 0) {
    return {
      ok: true, argv, devices, ready: 0, ios,
      reason: "无设备连接。检查：① USB 线/端口 ② 手机端「开发者选项 → USB 调试」已开启 ③ adb kill-server && adb start-server 重启守护进程。降级车道：org mobile plan（步骤化排查计划永远可用）。",
      tookMs: Date.now() - t0,
    };
  }
  if (ready === 0) {
    const unauthorized = devices.filter((d) => d.state === "unauthorized").length;
    return {
      ok: true, argv, devices, ready: 0, ios,
      reason: unauthorized > 0
        ? `${devices.length} 台设备全部未授权（unauthorized）—— 解锁手机屏幕，在「允许 USB 调试吗？」弹窗点「允许」（可勾选一律允许）；仍不行则 adb kill-server 后重插。`
        : `${devices.length} 台设备均非就绪态（offline/recovery/bootloader —— adb wait-for-device 或重插后重试）。`,
      tookMs: Date.now() - t0,
    };
  }
  return { ok: true, argv, devices, ready, ios, tookMs: Date.now() - t0 };
}

// ---- 设备上下文解析（logcat/forward 共用的降级前置） ---------------------------

interface DeviceContext {
  ok: boolean;
  kind?: MobileKind;
  serial: string | null;
  reason?: string;
}

/** 定位 adb（which + SDK 形态）。 */
function adbBin(): string | null {
  return whichTool("adb") ?? locateInSdk(["platform-tools"], "adb");
}

/**
 * 解析目标设备（serial 缺省 = 单设备自动选中）：adb 缺席 → 无设备 → 未授权
 * → 多设备未指定，诚实降级链。就绪返回 serial。
 */
function resolveDevice(serial?: string): DeviceContext {
  const want = serial != null ? String(serial).trim() : "";
  const bin = adbBin();
  if (bin === null) {
    return { ok: false, kind: "tool-absent", serial: null, reason: `未找到 adb CLI。${MOBILE_INSTALL_HINTS.adb!}` };
  }
  const r = spawnCaptured([bin, "devices", "-l"], RUN_DEFAULT_TIMEOUT_MS);
  if (r === null) return { ok: false, kind: "timeout", serial: null, reason: "adb devices 执行失败或超时。" };
  if (r.exitCode !== 0) return { ok: false, kind: "failed", serial: null, reason: `adb devices 退出码 ${r.exitCode}：${firstLine(r.stderr)}` };
  const devices = parseAdbDevices(r.stdout);
  const ready = devices.filter((d) => d.state === "device");
  if (devices.length === 0) {
    return { ok: false, kind: "no-device", serial: null, reason: "无设备连接（USB 调试开启 + 重插后重试；org mobile plan 给步骤化排查）。" };
  }
  if (want.length > 0) {
    const hit = ready.find((d) => d.serial === want);
    if (hit) return { ok: true, serial: hit.serial };
    const anyState = devices.find((d) => d.serial === want);
    return {
      ok: false,
      kind: anyState ? "unauthorized" : "no-device",
      serial: want,
      reason: anyState
        ? `设备 ${want} 状态是 ${anyState.state}（未授权/离线 —— 解锁屏幕确认授权弹窗后重试）。`
        : `serial ${want} 不在设备清单（org mobile devices 查看在场序列号）。`,
    };
  }
  if (ready.length === 0) {
    const unauthorized = devices.some((d) => d.state === "unauthorized");
    return {
      ok: false, kind: "unauthorized", serial: null,
      reason: unauthorized
        ? "设备未授权（unauthorized）—— 解锁手机屏幕，在「允许 USB 调试吗？」弹窗点「允许」。"
        : "设备非就绪态（offline/recovery）—— adb wait-for-device 或重插后重试。",
    };
  }
  if (ready.length > 1) {
    return { ok: false, kind: "multi-device", serial: null, reason: `多台就绪设备（${ready.map((d) => d.serial).join(" / ")}）—— 指定其一：serial 参数（org mobile logcat <serial> …）。` };
  }
  return { ok: true, serial: ready[0]!.serial };
}

// ============================================================================
// ③ logcat 尾随（mobileLogcat —— dump 车道 + 五元组解析 + 三层降级）
// ============================================================================

/** 一条 logcat 结构化记录（五元组：时间/进程/级别/tag/消息；tid 为附赠字段）。 */
export interface LogcatEntry {
  /** 时间戳（"01-02 12:34:56.789" 或带年 "2024-01-02 12:34:56.789"）。 */
  time: string;
  /** 进程号。 */
  pid: string;
  /** 线程号。 */
  tid: string;
  /** 级别单字母：V/D/I/W/E/F。 */
  level: string;
  /** tag（如 ActivityManager / chromium）。 */
  tag: string;
  /** 消息体。 */
  message: string;
}

/**
 * 解析单行 logcat（纯函数）。两种官方格式：
 *   01-02 12:34:56.789  1234  5678 I ActivityManager: Start proc …
 *   2024-01-02 12:34:56.789  1234  5678 I ActivityManager: …
 * 不匹配（--------- beginning of main / 消息续行 / 噪音行）→ null。
 */
export function parseLogcatLine(line: string): LogcatEntry | null {
  // 日期形态双兼容：缺省 MM-DD（"01-02 12:34:56.789"）与 -v year 的
  // YYYY-MM-DD（"2024-01-02 …"）—— (?:\d{4}-)? 前缀可选（单写 \d{2,4}-\d{2}-\d{2}
  // 会把无年形态拒掉，v0.5.18 自检抓出）
  const m = String(line ?? "").match(
    /^((?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^\s:]+)\s*:\s?(.*)$/,
  );
  if (!m) return null;
  return { time: m[1]!, pid: m[2]!, tid: m[3]!, level: m[4]!, tag: m[5]!, message: m[6]! };
}

/** 解析整段 logcat 输出：匹配行入列，非匹配行计数（头行/续行噪音）。 */
export function parseLogcat(stdout: string): { entries: LogcatEntry[]; skipped: number } {
  const entries: LogcatEntry[] = [];
  let skipped = 0;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    const e = parseLogcatLine(line);
    if (e) entries.push(e);
    else if (!/^---------/.test(line.trim())) skipped++;
  }
  return { entries, skipped };
}

/** logcat 参数选项。 */
export interface MobileLogcatOptions {
  /** 目标设备序列号（缺省单设备自动选中；多设备未指定 → multi-device 降级）。 */
  serial?: string;
  /** 尾部行数（缺省 200，钳制 1..2000）。 */
  lines?: number;
  /** tag 过滤（`-s TAG` 形态；可自带级别 "TAG:E"）。 */
  tag?: string;
  /** 级别（V/D/I/W/E/F，缺省 I —— `*:I` 形态；与 tag 同给时客户端侧兜底过滤）。 */
  level?: string;
  /** 按包名过滤（adb shell pidof <pkg> 解析 pid 后客户端侧过滤）。 */
  package?: string;
  timeoutMs?: number;
}

/** logcat 结果。 */
export interface MobileLogcatResult {
  ok: boolean;
  kind?: MobileKind;
  argv: string[];
  entries: LogcatEntry[];
  /** 未匹配行数（头行/续行噪音 —— 诚实观测）。 */
  skipped: number;
  truncated: boolean;
  reason?: string;
  tookMs: number;
}

/**
 * logcat argv 构造（纯函数 —— tests 断言 `logcat -d -t N *:I` 与 `-s TAG`
 * 形态）。level 白名单外回退 I（诚实：不猜未知级别）。
 */
export function logcatArgv(adbBin: string, opts: MobileLogcatOptions = {}): string[] {
  const lines = Math.max(1, Math.min(LOGCAT_LINES_MAX, Math.floor(Number(opts.lines ?? LOGCAT_LINES_DEFAULT) || LOGCAT_LINES_DEFAULT)));
  const level = LOGCAT_LEVELS.includes(String(opts.level ?? "").toUpperCase()) ? String(opts.level)!.toUpperCase() : "I";
  const argv = [adbBin];
  if (opts.serial != null && String(opts.serial).trim().length > 0) argv.push("-s", String(opts.serial).trim());
  argv.push("logcat", "-d", "-t", String(lines));
  const tag = String(opts.tag ?? "").trim();
  if (tag.length > 0) argv.push("-s", tag); // `-s TAG`：只留该 tag（可自带 :级别）
  else argv.push(`*:${level}`); // `*:I` 形态（全 tag + 级别下限）
  return argv;
}

function levelRank(level: string): number {
  const idx = LOGCAT_LEVELS.indexOf(level.toUpperCase());
  return idx >= 0 ? idx : 2; // 未知按 I（2）计 —— 诚实不猜
}

/**
 * mobileLogcat()：`adb logcat -d -t N *:I` dump 快照 + 五元组解析（时间/
 * 进程/级别/tag/消息）+ tag（-s TAG）与包名（pidof → pid 过滤）双过滤 +
 * 三层降级（adb 缺席 / 无设备 / 未授权 —— resolveDevice 同链）。永不 throw。
 * 诚实边界：-d 一次性 dump（非流式尾随）；真·流式是路线图。
 */
export function mobileLogcat(opts: MobileLogcatOptions = {}): MobileLogcatResult {
  const t0 = Date.now();
  const bin = adbBin();
  if (bin === null) {
    return { ok: false, kind: "tool-absent", argv: ["adb", "logcat", "-d"], entries: [], skipped: 0, truncated: false, reason: `未找到 adb CLI。${MOBILE_INSTALL_HINTS.adb!} 无 adb 时：org mobile plan android crash（步骤化排查计划永远可用）。`, tookMs: 0 };
  }
  const ctx = resolveDevice(opts.serial);
  if (!ctx.ok) {
    return { ok: false, kind: ctx.kind, argv: ["adb", "logcat", "-d"], entries: [], skipped: 0, truncated: false, reason: ctx.reason, tookMs: Date.now() - t0 };
  }
  const lines = Math.max(1, Math.min(LOGCAT_LINES_MAX, Math.floor(Number(opts.lines ?? LOGCAT_LINES_DEFAULT) || LOGCAT_LINES_DEFAULT)));
  const argv = logcatArgv(bin, { ...opts, serial: ctx.serial ?? undefined });
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const r = spawnCaptured(argv, timeoutMs);
  if (r === null) {
    return { ok: false, kind: "timeout", argv, entries: [], skipped: 0, truncated: false, reason: `adb logcat 执行失败或超时（>${timeoutMs}ms 硬超时强杀）`, tookMs: Date.now() - t0 };
  }
  if (r.exitCode !== 0) {
    return { ok: false, kind: "failed", argv, entries: [], skipped: 0, truncated: false, reason: `adb logcat 退出码 ${r.exitCode}：${firstLine(r.stderr)}`, tookMs: Date.now() - t0 };
  }
  const parsed = parseLogcat(r.stdout);
  let entries = parsed.entries;
  // 包名过滤：pidof 解析 pid 集合 → 客户端侧过滤（包未运行 → 诚实空 + 指引）
  let pkgNote: string | undefined;
  const pkg = String(opts.package ?? "").trim();
  if (pkg.length > 0) {
    const pidR = spawnCaptured([bin, "-s", ctx.serial!, "shell", "pidof", pkg], RUN_DEFAULT_TIMEOUT_MS);
    const pids = (pidR?.stdout ?? "").split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    if (pidR === null || pidR.exitCode !== 0 || pids.length === 0) {
      return {
        ok: true, argv, entries: [], skipped: 0, truncated: false,
        reason: `包 ${pkg} 未在运行（pidof 无 pid —— 先启动 app（adb shell monkey -p ${pkg} 1）再抓；org mobile plan android crash 第 1 步起排查）`,
        tookMs: Date.now() - t0,
      };
    }
    const pidSet = new Set(pids);
    entries = entries.filter((e) => pidSet.has(e.pid));
    pkgNote = `包 ${pkg}（pid ${pids.join("/")}）过滤`;
  }
  // tag + level 同给时客户端侧兜底过滤（argv 层 -s TAG 不带级别下限）
  const tag = String(opts.tag ?? "").trim();
  const levelFilter = LOGCAT_LEVELS.includes(String(opts.level ?? "").toUpperCase()) ? String(opts.level)!.toUpperCase() : null;
  if (tag.length > 0 && levelFilter !== null && !tag.includes(":")) {
    entries = entries.filter((e) => levelRank(e.level) >= levelRank(levelFilter));
  }
  const truncated = entries.length > lines;
  if (truncated) entries = entries.slice(-lines);
  return {
    ok: true,
    argv,
    entries,
    skipped: parsed.skipped,
    truncated,
    ...(entries.length === 0
      ? { reason: pkgNote ?? "快照为空（无匹配日志行 —— 级别/tag 过滤太紧可放宽，或 app 触发一次目标操作后再抓）。" }
      : pkgNote ? { reason: pkgNote } : {}),
    tookMs: Date.now() - t0,
  };
}

// ============================================================================
// ④ WebView CDP 转发（mobileForward —— 四层降级：adb→设备→socket→页面）
// ============================================================================

/** CDP /json 里的一页（可调试 WebView/Chrome 页面）。 */
export interface CdpPage {
  title: string;
  url: string;
  type: string;
}

/** forward 参数选项。 */
export interface MobileForwardOptions {
  serial?: string;
  /** 本地端口（数字或 "tcp:N" 形态；缺省 9222）。 */
  local?: number | string;
  /** 远端 socket（"localabstract:webview_devtools_remote_<pid>" 形态；缺省自动发现）。 */
  remote?: string;
  /** CDP HTTP 探测超时（缺省 3s）。 */
  cdpTimeoutMs?: number;
  timeoutMs?: number;
}

/** forward 结果。 */
export interface MobileForwardResult {
  ok: boolean;
  kind?: MobileKind;
  argv: string[];
  serial: string | null;
  /** 实际使用的本地端口（tcp:N → N）。 */
  localPort: number;
  /** 实际转发的远端 socket。 */
  remote: string;
  /** 设备上发现的可调试 WebView socket 清单（自动发现车道的观测面）。 */
  sockets: string[];
  /** CDP /json 可达性探测结果（forward 成功后才有）。 */
  cdp: { reachable: boolean; httpStatus: number | null; pages: CdpPage[] } | null;
  reason?: string;
  tookMs: number;
}

/**
 * 从 `adb shell cat /proc/net/unix` 输出提取 devtools socket 名（纯函数）。
 * /proc/net/unix 的抽象套接字带 @ 前缀（@webview_devtools_remote_1234）——
 * 提取时剥掉。chrome_devtools_remote（Chrome Android）同样收（跨源共用）。
 */
export function extractDevtoolsSockets(procNetUnix: string): string[] {
  const names = new Set<string>();
  for (const m of String(procNetUnix ?? "").matchAll(/@?(webview_devtools_remote[_\w.-]*|chrome_devtools_remote[_\w.-]*)/g)) {
    names.add(m[1]!);
  }
  return [...names];
}

/** 端口形态归一（数字或 "tcp:N" → N；非法 → 9222 缺省）。 */
export function normalizeLocalPort(local: number | string | undefined): number {
  const raw = local == null ? "" : String(local).trim().replace(/^tcp:/i, "");
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 9222;
}

/** CDP /json 探测（fetch + AbortController 硬超时；失败给 httpStatus:null）。 */
async function cdpProbe(port: number, timeoutMs: number): Promise<{ reachable: boolean; httpStatus: number | null; pages: CdpPage[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, httpStatus: res.status, pages: [] };
    const list = (await res.json().catch(() => [])) as unknown;
    const pages = (Array.isArray(list) ? list : [])
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .map((p) => ({ title: String(p.title ?? ""), url: String(p.url ?? ""), type: String(p.type ?? "page") }));
    return { reachable: true, httpStatus: res.status, pages };
  } catch {
    return { reachable: false, httpStatus: null, pages: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * mobileForward()：`adb forward tcp:<port> localabstract:webview_devtools_remote_<pid>`
 * 封装 + `http://127.0.0.1:<port>/json` 可达性探测（fetch + 硬超时）→ 可调试
 * WebView 页面清单（title/url）。四层降级：adb 缺席 → 设备（含 socket 自动
 * 发现：无 socket 给「开启 WebView 调试」指引）→ socket（forward 执行 +
 * HTTP 探测不可达）→ 页面（空清单指引）。永不 throw。
 */
export async function mobileForward(opts: MobileForwardOptions = {}): Promise<MobileForwardResult> {
  const t0 = Date.now();
  const localPort = normalizeLocalPort(opts.local);
  const base = { serial: null, localPort, remote: "", sockets: [] as string[], cdp: null } as MobileForwardResult;
  const bin = adbBin();
  if (bin === null) {
    return { ...base, ok: false, kind: "tool-absent", argv: ["adb", "forward"], reason: `未找到 adb CLI。${MOBILE_INSTALL_HINTS.adb!}`, tookMs: 0 };
  }
  const ctx = resolveDevice(opts.serial);
  if (!ctx.ok) {
    return { ...base, ok: false, kind: ctx.kind, argv: ["adb", "forward"], reason: ctx.reason, tookMs: Date.now() - t0 };
  }
  const serial = ctx.serial!;
  // socket 发现：显式 remote 优先；缺席 → /proc/net/unix 扫描自动发现
  let sockets: string[] = [];
  let remote = String(opts.remote ?? "").trim();
  if (remote.length === 0) {
    const u = spawnCaptured([bin, "-s", serial, "shell", "cat", "/proc/net/unix"], RUN_DEFAULT_TIMEOUT_MS);
    if (u !== null && u.exitCode === 0) sockets = extractDevtoolsSockets(u.stdout);
    if (sockets.length === 0) {
      return {
        ...base, serial, localPort, sockets,
        ok: false, kind: "socket-not-found",
        argv: [bin, "-s", serial, "shell", "cat", "/proc/net/unix"],
        reason: "设备上未发现 devtools socket（webview_devtools_remote_* / chrome_devtools_remote）。开启：① debug 构建自带 android:debuggable=true + WebView.setWebContentsDebuggingEnabled(true) ② app 已启动且 WebView 已加载页面 ③ Chrome 桌面版 chrome://inspect 应能看到目标。",
        tookMs: Date.now() - t0,
      };
    }
    remote = `localabstract:${sockets[0]!}`;
  } else if (!/^(localabstract|localfilesystem|tcp|jdwp):/.test(remote)) {
    remote = `localabstract:${remote}`; // 裸 socket 名 → localabstract: 形态
  }
  if (sockets.length === 0) sockets = [remote.replace(/^localabstract:/, "")];
  // forward 执行
  const argv = [bin, "-s", serial, "forward", `tcp:${localPort}`, remote];
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const r = spawnCaptured(argv, timeoutMs);
  if (r === null || r.exitCode !== 0) {
    return { ...base, serial, localPort, remote, sockets, ok: false, kind: "failed", argv, reason: `adb forward 退出码 ${r?.exitCode ?? "null"}：${firstLine(r?.stderr ?? "")}`, tookMs: Date.now() - t0 };
  }
  // CDP /json 可达性探测（fetch + 硬超时）
  const cdpTimeout = Math.max(200, opts.cdpTimeoutMs ?? CDP_PROBE_TIMEOUT_MS);
  const cdp = await cdpProbe(localPort, cdpTimeout);
  if (!cdp.reachable) {
    return {
      ...base, serial, localPort, remote, sockets, cdp,
      ok: false, kind: "socket-unreachable", argv,
      reason: `forward 已建立（tcp:${localPort} → ${remote}）但 http://127.0.0.1:${localPort}/json 不可达（${cdp.httpStatus === null ? "连接被拒/超时" : `HTTP ${cdp.httpStatus}`}）—— app 可能已退出或调试通道关闭；重试或换 sockets 之一：${sockets.join(" / ")}`,
      tookMs: Date.now() - t0,
    };
  }
  if (cdp.pages.length === 0) {
    return {
      ...base, serial, localPort, remote, sockets, cdp,
      ok: true, kind: "page-empty", argv,
      reason: "CDP 可达但页面清单为空 —— WebView 还没加载页面（先导航到目标页再 chrome://inspect / 重试）。",
      tookMs: Date.now() - t0,
    };
  }
  return { ok: true, argv, serial, localPort, remote, sockets, cdp, tookMs: Date.now() - t0 };
}

// ============================================================================
// ⑤ APK 检查（mobileApkInfo —— aapt 车道 / 魔数车道两层降级）
// ============================================================================

/** aapt dump badging 解析结果（aapt 车道字段）。 */
export interface AaptBadging {
  package: string | null;
  versionName: string | null;
  versionCode: string | null;
  sdkVersion: string | null;
  targetSdkVersion: string | null;
  applicationLabel: string | null;
  permissions: string[];
  nativeCode: string[];
}

/**
 * 解析 `aapt dump badging` 输出（纯函数）。容忍字段顺序差异与多余行
 * （launchable-activity / uses-feature 等不入结构面，permissions 摘要收全）。
 */
export function parseAaptBadging(stdout: string): AaptBadging {
  const out: AaptBadging = { package: null, versionName: null, versionCode: null, sdkVersion: null, targetSdkVersion: null, applicationLabel: null, permissions: [], nativeCode: [] };
  const text = String(stdout ?? "");
  const pkg = /package:.*?name='([^']*)'/.exec(text);
  if (pkg) out.package = pkg[1]!;
  const vc = /package:.*?versionCode='([^']*)'/.exec(text);
  if (vc) out.versionCode = vc[1]!;
  const vn = /package:.*?versionName='([^']*)'/.exec(text);
  if (vn) out.versionName = vn[1]!;
  const sdk = /sdkVersion:'([^']*)'/.exec(text);
  if (sdk) out.sdkVersion = sdk[1]!;
  const tsdk = /targetSdkVersion:'([^']*)'/.exec(text);
  if (tsdk) out.targetSdkVersion = tsdk[1]!;
  const label = /application-label:'([^']*)'/.exec(text) ?? /application:.*?label='([^']*)'/.exec(text);
  if (label) out.applicationLabel = label[1]!;
  for (const m of text.matchAll(/uses-permission:.*?name='([^']*)'/g)) out.permissions.push(m[1]!);
  const nc = /native-code:\s*(.+)/.exec(text);
  if (nc) out.nativeCode = nc[1]!.trim().split(/[\s,]+/).map((s) => s.replace(/^'+|'+$/g, "")).filter((s) => s.length > 0);
  return out;
}

/** APK 检查结果（aapt 车道 / 魔数车道 —— lane 字段诚实标注产出车道）。 */
export interface MobileApkInfoResult {
  ok: boolean;
  kind?: MobileKind;
  /** 产出车道："aapt"（badging 全量解析）| "magic"（魔数 + 大小 + 指引）。 */
  lane: "aapt" | "magic" | null;
  /** 工作区相对路径（原样）。 */
  file: string;
  sizeBytes: number;
  /** 魔数校验（PK\x03\x04）。 */
  magic: { apk: boolean } | null;
  badging?: AaptBadging;
  reason?: string;
}

/**
 * APK 魔数判定（纯函数）：本地文件头 PK\x03\x04（ZIP 容器 —— APK 是带
 * AndroidManifest 的 ZIP）。
 */
export function isApkMagic(buf: Uint8Array): boolean {
  if (buf == null || buf.length < 4) return false;
  return buf[0] === APK_MAGIC[0] && buf[1] === APK_MAGIC[1] && buf[2] === APK_MAGIC[2] && buf[3] === APK_MAGIC[3];
}

/** 十六进制头预览（reason 面人读）。 */
function hexHead(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/**
 * mobileApkInfo()：APK 检查两层降级。路径过工作区监狱（越界即拒，拒绝先于
 * 任何读盘）→ aapt/aapt2 dump badging 全量解析 → 工具缺席/执行失败时魔数
 * 车道（PK\x03\x04 + 文件大小 + 诚实指引）。永不 throw。
 */
export function mobileApkInfo(ws: string, file: string): MobileApkInfoResult {
  const rel = String(file ?? "").trim();
  if (rel.length === 0) {
    return { ok: false, kind: "failed", lane: null, file: rel, sizeBytes: 0, magic: null, reason: "file 必填（工作区相对路径，如 builds/app.apk）" };
  }
  const abs = resolveInWorkspace(ws, rel);
  if (!inWorkspace(ws, abs)) {
    return { ok: false, kind: "jail", lane: null, file: rel, sizeBytes: 0, magic: null, reason: `APK 路径越界（须在工作区内）：${rel}` };
  }
  let size = 0;
  let head: Uint8Array = new Uint8Array(0);
  try {
    const fd = fs.openSync(abs, "r");
    try {
      const buf = new Uint8Array(4);
      const n = fs.readSync(fd, buf, 0, 4, 0);
      head = n > 0 ? buf.subarray(0, n) : buf;
      size = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { ok: false, kind: "failed", lane: null, file: rel, sizeBytes: 0, magic: null, reason: `APK 文件不可读：${(e as Error).message}` };
  }
  const magic = { apk: isApkMagic(head) };
  const bin = whichTool("aapt") ?? whichTool("aapt2") ?? locateInSdk(["build-tools"], "aapt") ?? locateInSdk(["build-tools"], "aapt2");
  if (bin === null) {
    // 魔数车道（降级交付 —— 不是报错）：魔数 + 大小 + 诚实指引
    if (!magic.apk) {
      return { ok: false, kind: "failed", lane: "magic", file: rel, sizeBytes: size, magic, reason: `不是 APK 魔数形态（PK\\x03\\x04）：文件头 ${hexHead(head)}` };
    }
    return {
      ok: true, lane: "magic", file: rel, sizeBytes: size, magic,
      reason: `APK 魔数确认 ✓（PK\\x03\\x04 ZIP 容器 · ${(size / 1024 / 1024).toFixed(2)} MB）。aapt/aapt2 缺席 —— 包名/版本/权限明细不可得（诚实降级）。${MOBILE_INSTALL_HINTS.aapt!}`,
    };
  }
  // aapt 车道：dump badging 全量解析
  const r = spawnCaptured([bin, "dump", "badging", abs], RUN_DEFAULT_TIMEOUT_MS);
  if (r === null || r.exitCode !== 0) {
    // aapt 执行失败 → 仍走魔数车道（两层降级完整）
    return magic.apk
      ? { ok: true, lane: "magic", file: rel, sizeBytes: size, magic, reason: `aapt dump badging 失败（${firstLine(r?.stderr ?? "") || "无输出"}）—— 魔数车道降级：APK ✓（PK\\x03\\x04 · ${(size / 1024 / 1024).toFixed(2)} MB）。` }
      : { ok: false, kind: "failed", lane: "magic", file: rel, sizeBytes: size, magic, reason: `不是 APK 魔数形态且 aapt dump 失败（文件头 ${hexHead(head)}）。` };
  }
  const badging = parseAaptBadging(r.stdout);
  if (badging.package === null) {
    return { ok: false, kind: "failed", lane: "aapt", file: rel, sizeBytes: size, magic, badging, reason: "aapt 输出无 package: 行（可能不是 APK —— aapt 对普通 zip/jar 也能跑 dump，但缺 AndroidManifest 字段）。" };
  }
  return {
    ok: true, lane: "aapt", file: rel, sizeBytes: size,
    magic,
    badging,
    ...(magic.apk ? {} : { reason: "aapt 解析成功但文件头魔数异常（PK\\x03\\x04 未对齐 —— 特殊容器，见 badging 字段）。" }),
  };
}

// ============================================================================
// ⑥ 移动端调试计划器（mobileDebugPlan —— 纯函数保底车道，永远可用）
// ============================================================================

/** 症状归一枚举（关键词宽容匹配 → 归一到这些）。 */
export const MOBILE_SYMPTOMS: readonly string[] = [
  "crash",         // 崩溃 / ANR / 闪退
  "white-screen",  // 白屏/空屏
  "network",       // 网络不通/请求失败
  "performance",   // 卡顿/性能/内存
  "build",         // 构建失败
  "install",       // 安装失败/装不上
  "webview",       // WebView/H5 内容异常
];

/** 计划一步（命令可粘贴；预期与降级指引成对）。 */
export interface MobilePlanStep {
  step: number;
  title: string;
  /** 可粘贴命令（纯人工动作步骤缺席）。 */
  cmd?: string;
  /** 该步预期看到什么。 */
  expect: string;
  /** 该步做不了/不符合预期时的降级指引。 */
  degrade: string;
}

/** 计划结果。 */
export interface MobilePlanResult {
  platform: "android" | "ios" | "both";
  /** 归一后的症状。 */
  symptom: string;
  steps: MobilePlanStep[];
  note: string;
}

/** 症状关键词归一（中英宽容：白屏/whitescreen → white-screen、ANR → crash 等）。 */
export function normalizeSymptom(input: string): string {
  const s = String(input ?? "").toLowerCase();
  if (/crash|崩溃|anr|fatal|闪退/.test(s)) return "crash";
  if (/white[-\s]?screen|whitescreen|白屏|空白|blank/.test(s)) return "white-screen";
  if (/network|网络|请求失败|offline|断网|接口/.test(s)) return "network";
  if (/perf|卡顿|性能|slow|lag|jank|内存|oom/.test(s)) return "performance";
  if (/build|构建|编译|gradle|compile/.test(s)) return "build";
  if (/install|安装|装不上|无法安装/.test(s)) return "install";
  if (/webview|h5|hybrid|内嵌/.test(s)) return "webview";
  return "crash"; // 缺省归 crash（最常见排查入口；未知关键词在 note 回显原词）
}

type PlanStepSpec = Omit<MobilePlanStep, "step">;

/** Android 面步骤库（症状 → 步骤；命令可直接粘贴，降级指引成对）。 */
function androidSteps(symptom: string): PlanStepSpec[] {
  const device: PlanStepSpec = {
    title: "确认设备连接与授权",
    cmd: "adb devices -l",
    expect: "目标设备 serial 在列且 state=device（就绪）。",
    degrade: "无 adb → 装 platform-tools（brew install --cask android-platform-tools）；无设备 → 开 USB 调试 + 重插；unauthorized → 解锁屏幕点「允许」。",
  };
  const logcatError: PlanStepSpec = {
    title: "抓错误级日志快照",
    cmd: "adb logcat -d -t 500 *:E",
    expect: "E/F 级最近 500 行里有 FATAL EXCEPTION / 栈回溯（或目标错误）。",
    degrade: "无 adb 时该步只能人工；org mobile logcat --lines 500 --level E 是同款封装（--tag AndroidRuntime 只看崩溃器）。",
  };
  const cdpStep: PlanStepSpec = {
    title: "转发 WebView CDP 并列可调试页面",
    cmd: "adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof <app包名>)",
    expect: "chrome://inspect（桌面 Chrome）看到目标 WebView 页面，可 inspect 进 DevTools。",
    degrade: "org mobile forward 自动发现 socket；socket-not-found → app 需 setWebContentsDebuggingEnabled(true) + debuggable 构建。",
  };
  const bySymptom: Record<string, PlanStepSpec[]> = {
    crash: [
      device,
      logcatError,
      {
        title: "崩溃器定点过滤（FATAL EXCEPTION 全栈）",
        cmd: "adb logcat -d -s AndroidRuntime:E",
        expect: "AndroidRuntime 的 FATAL EXCEPTION 块：异常类型 + 消息 + at … 栈帧（定位到 类.方法(文件:行)）。",
        degrade: "复现一次崩溃后再抓（-d 是快照，崩溃后立刻抓最完整）；ANR 类看 /data/anr/ 需 root 或 bugreport（adb bugreport）。",
      },
      {
        title: "版本对齐（栈帧行号 → 源码）",
        cmd: "adb shell dumpsys package <app包名> | grep versionName",
        expect: "设备上装的版本号可见，与本地符号（mapping.txt / 源码 tag）对齐，栈帧行号可翻译。",
        degrade: "版本对不上 → 重装对齐版本 adb install -r app-debug.apk（先 org mobile apk app.apk 核对包名/版本 —— aapt 缺席走魔数车道）。",
      },
    ],
    "white-screen": [
      device,
      logcatError,
      {
        title: "渲染器/WebView 进程日志（chromium 通道）",
        cmd: "adb logcat -d -s chromium:E chromium:W",
        expect: "chromium 告警里能见到页面加载失败原因（ERR_NAME_NOT_RESOLVED / mixed-content 被拦 / JS 异常）。",
        degrade: "org mobile logcat --tag chromium --level W 同款封装；JS 侧白屏常见未捕获异常 —— 下一步 CDP 看 console。",
      },
      cdpStep,
      {
        title: "CDP console 与页面清单检视",
        cmd: "curl -s http://127.0.0.1:9222/json",
        expect: "页面清单里目标 WebView 的 url 正确；inspect 后 console 有红色未捕获异常即为根因。",
        degrade: "org mobile forward 已给 title/url 清单（chrome://inspect 可视化同源）；页面清单为空 → 先在 app 里导航到目标页再重抓。",
      },
    ],
    network: [
      device,
      {
        title: "确认设备自身连通性（分层：先网络层后 app 层）",
        cmd: "adb shell ping -c 3 8.8.8.8",
        expect: "0% packet loss（设备联网正常 → 问题在 app 层而非网络层）。",
        degrade: "丢包/超时 → 先修设备网络（Wi-Fi 代理 / VPN / 系统时间不正确导致 TLS 失败也是常见根因）。",
      },
      {
        title: "抓网络相关日志（cleartext / TLS / DNS）",
        cmd: "adb logcat -d -t 300 *:W",
        expect: "常见根因可见：cleartext 被拦（targetSdk>=28 默认禁 http）/ 证书校验失败 / DNS 解析失败（ERR_*）。",
        degrade: "org mobile logcat --lines 300 --level W 同款封装后自 grep；cleartext → AndroidManifest 加 usesCleartextTraffic 或改 https。",
      },
      {
        title: "白名单直连验证（排除 DNS/CDN 因素）",
        cmd: "adb shell am start -a android.intent.action.VIEW -d https://<目标域名>",
        expect: "设备浏览器能打开目标域名 → app 的网络栈/证书配置问题；打不开 → 网络层问题（回到第 2 步结论）。",
        degrade: "无 adb 时人工在设备浏览器打开目标域名即可 —— 该步的判据是「浏览器通不通」这一观察，不依赖工具。",
      },
    ],
    performance: [
      device,
      {
        title: "当前帧率/渲染统计",
        cmd: "adb shell dumpsys gfxinfo <app包名> framestats",
        expect: "Total frames / Janky frames 百分比与 p90/p95/p99 帧耗时（>16ms 预算的帧占比即卡顿度）。",
        degrade: "org mobile logcat --package <app包名> 抓 app 自身日志；gfxinfo 需 app 在前台运行中。",
      },
      {
        title: "CPU/内存快照（谁在吃资源）",
        cmd: "adb shell top -n 1 | head -20",
        expect: "目标 app 进程 CPU%/RSS 在列 —— 异常高（CPU>100% / RSS 持续增长）即泄漏/忙循环嫌疑。",
        degrade: "内存长程观察用 adb shell dumpsys meminfo <app包名>（TOTAL / Views / Activities 计数）；无 adb 时 Android Studio Profiler 是桌面侧主车道。",
      },
      {
        title: "GC 抖动 / 主线程阻塞观察",
        cmd: "adb logcat -d -t 500 -s art:W art:I",
        expect: "频繁 GC（art 通道 Blocking GC）与主线程长时间阻塞告警可见。",
        degrade: "org mobile logcat --tag art --lines 500 同款；深度剖析走 Perfetto / Android Studio Profiler（路线图外补充）。",
      },
    ],
    build: [
      {
        title: "本地构建拿完整错误（不经 IDE 摘要）",
        cmd: "./gradlew assembleDebug --stacktrace 2>&1 | tail -60",
        expect: "FAILURE: Build failed 块里的具体任务名与错误（Could not resolve / duplicate class / SDK location missing）。",
        degrade: "org debug plan <出错的构建脚本/源文件> 可给断点建议 + DAP 消息序列；构建问题大多不需要真机 —— 本步零设备可跑。",
      },
      {
        title: "SDK/依赖版本对齐检查",
        cmd: "./gradlew -q dependencies --configuration debugRuntimeClasspath | head -30",
        expect: "依赖树可见 —— 版本冲突（duplicate class）与缺 SDK 的直接证据。",
        degrade: "adb 不在场不影响本步（只影响后续装机验证）；SDK 缺失 → Android Studio SDK Manager 或 sdkmanager --install。",
      },
      {
        title: "产物核对（构建成功但装不上时的分叉）",
        cmd: "org mobile apk app/build/outputs/apk/debug/app-debug.apk",
        expect: "APK 存在 + 包名/versionCode/minSdk/权限清单可读（org mobile apk 的 aapt 车道）。",
        degrade: "aapt 缺席时 org mobile apk 的魔数车道仍给大小与 APK 确认（PK\\x03\\x04）；装不上 → install 症状计划（INSTALL_FAILED_XXX 错误码）。",
      },
    ],
    install: [
      device,
      {
        title: "重装拿精确错误码",
        cmd: "adb install -r app-debug.apk",
        expect: "Success 或 INSTALL_FAILED_XXX（UPDATE_INCOMPATIBLE=签名不一致 / NO_MATCHING_ABIS=ABI 不符 / OLDER_SDK=系统低于 minSdk）。",
        degrade: "签名不一致先卸载再装（adb uninstall <包名>）；org mobile apk 先核对 versionCode/minSdk 排除两成因（装是人工动作 —— 本模块执行面全只读）。",
      },
      {
        title: "设备 ABI 与系统版本核对",
        cmd: "adb shell getprop ro.product.cpu.abi && adb shell getprop ro.build.version.sdk",
        expect: "ABI（arm64-v8a 等）与系统 API level —— 与 APK 的 native-code / minSdkVersion 对齐。",
        degrade: "org mobile apk 的 badging 里 native-code/minSdk 与这两行对读即定位大多数 INSTALL_FAILED（aapt 缺席时魔数车道只给确认，细节人工）。",
      },
    ],
    webview: [
      device,
      cdpStep,
      {
        title: "WebView console 全量抓取",
        cmd: "adb logcat -d -s chromium:I",
        expect: "JS console.log/warn/error 与页面导航记录可见（H5 侧问题在 console 而非原生侧）。",
        degrade: "org mobile logcat --tag chromium 同款；socket-not-found → setWebContentsDebuggingEnabled(true) + debug 构建。",
      },
      {
        title: "页面加载链路核对",
        cmd: "curl -s http://127.0.0.1:9222/json",
        expect: "目标 WebView 的 url 与预期一致（加载了错误页/空白页会直接暴露）。",
        degrade: "org mobile forward 的页面清单同款输出（title/url）；空清单 → 先导航到目标页再重抓。",
      },
    ],
  };
  return bySymptom[symptom] ?? bySymptom.crash!;
}

/** iOS 面步骤库（libimobiledevice 面 —— 配对信任后可深入）。 */
function iosSteps(symptom: string): PlanStepSpec[] {
  const pair: PlanStepSpec = {
    title: "确认 iOS 工具面与设备配对",
    cmd: "idevice_id -l",
    expect: "列出已连接 iOS 设备 UDID（空输出 = 未连接或未「信任此电脑」）。",
    degrade: "工具缺席 → brew install ideviceinstaller libimobiledevice（Linux: apt install ideviceinstaller）；配对后仍空 → 换线/换口（很多线是纯充电线）。",
  };
  const syslog: PlanStepSpec = {
    title: "系统日志抓取（iOS 的 logcat 等价物）",
    cmd: "idevicesyslog | head -200",
    expect: "app 进程输出与系统错误（CFNetwork / JetsamEvent 内存告警 / 崩溃回溯）。",
    degrade: "idevicesyslog 未装（libimobiledevice 套件同源分发）；Xcode 环境可用 Devices 窗口看同等信息。",
  };
  const bySymptom: Record<string, PlanStepSpec[]> = {
    crash: [
      pair,
      syslog,
      {
        title: "崩溃报告定位",
        cmd: "idevicecrashreport -e ./crash-logs",
        expect: "拉回设备崩溃报告（.ips/.crash）—— 目标 app 的最新一份含异常类型与栈。",
        degrade: "无 idevicecrashreport：设置 → 隐私 → 分析与改进 → 分析数据 里直接看；栈符号化需要 dSYM（Xcode 侧人工）。",
      },
    ],
    "white-screen": [
      pair,
      syslog,
      {
        title: "WKWebView 调试（Safari 远程检查）",
        cmd: "# macOS：Safari → 开发（Develop）→ <设备名> → 目标 WKWebView",
        expect: "Safari Web Inspector 能看到页面 DOM/console —— JS 侧白屏根因（未捕获异常/资源加载失败）立现。",
        degrade: "需要 Mac + Safari（设置 → Safari → 高级 → 开发菜单开启）；跨端项目此步与 Android 的 CDP 步骤结论互通。",
      },
    ],
    network: [
      pair,
      syslog,
      {
        title: "ATS 与本地网络权限核对",
        cmd: "# Xcode：目标 Info.plist 的 NSAppTransportSecurity / NSLocalNetworkUsageDescription",
        expect: "http 明文被 ATS 默认拦（NSAllowsArbitraryLoads 才放行）；本地网络访问需 NSLocalNetworkUsageDescription（iOS 14+）。",
        degrade: "CLI 面查 plist：plutil -p <工程>/Info.plist（macOS 自带）；症状在模拟器复现可零设备验证。",
      },
    ],
    performance: [
      pair,
      {
        title: "内存与 CPU 概览",
        cmd: "ideviceinfo -k ProductVersion && idevicesyslog | grep -i jetsam | head -20",
        expect: "JetsamEvent（内存告警杀 app）在 syslog 里可见；系统版本可查。",
        degrade: "CLI 面深度性能不在面内（诚实边界）—— Instruments（Time Profiler / Allocations）是该症状的主车道；Jetsam 告警可先给方向。",
      },
    ],
    build: [
      {
        title: "xcodebuild 拿完整错误",
        cmd: "xcodebuild -project <x>.xcodeproj -scheme <s> build 2>&1 | tail -60",
        expect: "error: 行（签名/证书/Provisioning/Swift 版本）逐一在列。",
        degrade: "需要 macOS + Xcode（路线图外环境）；签名问题查钥匙串与 xcodebuild -showsdks；零设备可跑。",
      },
      {
        title: "依赖解析与缓存清洁（SPM/CocoaPods）",
        cmd: "xcodebuild -resolvePackageDependencies 2>&1 | tail -20 或 pod install --repo-update",
        expect: "依赖解析成功（或报出具体依赖冲突/版本不可用行）。",
        degrade: "SPM 卡死可清 ~/Library/Caches/org.swift.swiftpm；CocoaPods 缺失 → brew install cocoapods； flutter 项目走 flutter build ios --no-codesign（零签名验证构建链）。",
      },
    ],
    install: [
      pair,
      {
        title: "安装与错误码",
        cmd: "ideviceinstaller -i <app>.ipa",
        expect: "Install: Successful 或错误（签名/系统版本/容量）—— 与 Android 的 INSTALL_FAILED 同样可按码定位。",
        degrade: "签名错误 → 重签（codesign/fastlane）；系统版本低于部署目标 → 降 deployment target 或换设备（装是人工动作 —— 本模块执行面全只读）。",
      },
    ],
    webview: [
      pair,
      {
        title: "WKWebView console（Safari 远程）",
        cmd: "# Safari → 开发 → <设备> → 目标 WKWebView（同 white-screen 面）",
        expect: "JS console/网络面板可见（iOS 的 WebView 调试主车道是 Safari 而非 CDP）。",
        degrade: "无 Mac 时跨端项目先在 Android/桌面 CDP 复现（H5 侧根因跨端互通）。",
      },
    ],
  };
  return bySymptom[symptom] ?? bySymptom.crash!;
}

/**
 * mobileDebugPlan()：移动端调试计划器 —— 纯函数、零外部依赖（**保底车道：
 * 任何环境永远可用**）。（platform × symptom）矩阵 → 步骤化计划，每步 =
 * 命令 + 预期 + 降级指引。platform ∈ android/ios/both；症状关键词宽容归一
 * （中英均可）。永不 throw。
 */
export function mobileDebugPlan(platform: string, symptom: string): MobilePlanResult {
  const p = String(platform ?? "").toLowerCase();
  const plat: "android" | "ios" | "both" = p === "ios" ? "ios" : p === "both" ? "both" : "android";
  const raw = String(symptom ?? "").trim();
  const sym = normalizeSymptom(raw);
  const specs: PlanStepSpec[] = [];
  if (plat === "android" || plat === "both") specs.push(...androidSteps(sym));
  if (plat === "ios" || plat === "both") specs.push(...iosSteps(sym));
  const steps: MobilePlanStep[] = specs.map((s, i) => ({ step: i + 1, ...s }));
  return {
    platform: plat,
    symptom: sym,
    steps,
    note: `症状「${raw || "(空)"}」归一为 ${sym} · 平台 ${plat} · ${steps.length} 步。工具缺席时降级指引已嵌每步；org mobile logcat/forward/apk 是本计划的可封装步骤（aapt 缺席走魔数车道）。计划本身零外部依赖 —— 无 adb/无真机环境永远可用。`,
  };
}

// ============================================================================
// ⑦ 自检（mobileSelfTest —— 解析器/计划器纯内存自检）
// ============================================================================

export interface MobileSelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface MobileSelfTestResult {
  ok: boolean;
  passed: number;
  total: number;
  checks: MobileSelfTestCheck[];
}

/**
 * mobileSelfTest()：解析器/计划器自检（CLI `org mobile self-test` / Web
 * action=selftest 的数据源）—— adb devices / logcat 五元组 / aapt badging /
 * socket 提取 / 魔数 / 计划矩阵 / argv 形态，全部纯内存零副作用。
 */
export function mobileSelfTest(): MobileSelfTestResult {
  const checks: MobileSelfTestCheck[] = [];
  const t = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  // 1) adb devices 解析：多设备 / 未授权 / offline / 噪音行
  const devices = parseAdbDevices(
    "List of devices attached\n" +
    "0123456789ABCDEF     device usb:1-1 product:razor model:Nexus_7 device:flo transport_id:3\n" +
    "emulator-5554        device product:sdk_google_phone_x86_64 model:Android_SDK_built_for_x86_64 transport_id:4\n" +
    "AUTH-XYZ             unauthorized usb:1-2 transport_id:5\n" +
    "OFF-123              offline transport_id:6\n" +
    "* daemon started successfully\n",
  );
  t(
    "adb devices 解析（多设备/未授权/offline/噪音行）",
    devices.length === 4
      && devices[0]!.serial === "0123456789ABCDEF" && devices[0]!.state === "device"
      && devices[0]!.product === "razor" && devices[0]!.model === "Nexus_7" && devices[0]!.device === "flo" && devices[0]!.transport === "usb:1-1"
      && devices[1]!.serial === "emulator-5554"
      && devices[2]!.state === "unauthorized" && devices[2]!.model === null
      && devices[3]!.state === "offline",
    `${devices.length} 台（头行/daemon 噪音行已忽略）`,
  );

  // 2) logcat 五元组解析（时间/进程/级别/tag/消息 + 年份形态 + 噪音行拒绝）
  const e1 = parseLogcatLine("01-02 12:34:56.789  1234  5678 I ActivityManager: Start proc 4321:com.example.app/u0a123");
  const e2 = parseLogcatLine("2024-01-02 12:34:56.789  999  1000 E AndroidRuntime: FATAL EXCEPTION: main");
  const e3 = parseLogcatLine("--------- beginning of main");
  t(
    "logcat 五元组解析（时间/进程/级别/tag/消息 + 年份形态 + 噪音行拒绝）",
    e1 !== null && e1.time === "01-02 12:34:56.789" && e1.pid === "1234" && e1.tid === "5678" && e1.level === "I" && e1.tag === "ActivityManager" && e1.message.startsWith("Start proc")
      && e2 !== null && e2.level === "E" && e2.tag === "AndroidRuntime" && e2.time.startsWith("2024-")
      && e3 === null,
  );

  // 3) aapt badging 解析（package/versionCode/sdkVersion/权限摘要/native-code）
  const badging = parseAaptBadging(
    "package: name='com.example.app' versionCode='123' versionName='1.2.3' platformBuildVersionName='14'\n" +
    "sdkVersion:'24'\n" +
    "targetSdkVersion:'33'\n" +
    "uses-permission: name='android.permission.INTERNET'\n" +
    "uses-permission: name='android.permission.CAMERA'\n" +
    "application-label:'演示应用'\n" +
    "native-code: 'arm64-v8a', 'armeabi-v7a'\n",
  );
  t(
    "aapt badging 解析（package/versionCode/sdkVersion/权限摘要）",
    badging.package === "com.example.app" && badging.versionCode === "123" && badging.versionName === "1.2.3"
      && badging.sdkVersion === "24" && badging.targetSdkVersion === "33"
      && badging.applicationLabel === "演示应用"
      && badging.permissions.length === 2 && badging.permissions[1] === "android.permission.CAMERA"
      && badging.nativeCode.includes("arm64-v8a"),
  );

  // 4) devtools socket 提取（/proc/net/unix 扫描）
  const sockets = extractDevtoolsSockets(
    "Num       RefCount Protocol Flags    Type St Path\n" +
    "0        1        00000000 00010000 0001 01 @webview_devtools_remote_4321\n" +
    "1        1        00000000 00010000 0001 01 @chrome_devtools_remote\n" +
    "2        2        00000000 00000000 0001 01 /dev/socket/zygote\n",
  );
  t(
    "devtools socket 提取（webview/chrome 双源 + @ 前缀剥离）",
    sockets.length === 2 && sockets.includes("webview_devtools_remote_4321") && sockets.includes("chrome_devtools_remote"),
  );

  // 5) APK 魔数（PK\x03\x04 正例 + 反例）
  t(
    "APK 魔数判定（PK\\x03\\x04 正例 + ELF/短反例）",
    isApkMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])) === true
      && isApkMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06])) === false
      && isApkMagic(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])) === false
      && isApkMagic(new Uint8Array([0x50, 0x4b])) === false,
  );

  // 6) 计划矩阵：3 平台 × 7 症状，每步 expect+degrade 成对、编号连续
  let planOk = true;
  let stepTotal = 0;
  for (const plat of MOBILE_PLAN_PLATFORMS) {
    for (const sym of MOBILE_SYMPTOMS) {
      const p = mobileDebugPlan(plat, sym);
      if (p.steps.length < 2) planOk = false;
      p.steps.forEach((s, i) => {
        stepTotal++;
        if (s.step !== i + 1 || s.expect.length === 0 || s.degrade.length === 0) planOk = false;
      });
    }
  }
  t("计划矩阵（3 平台 × 7 症状 · 每步 expect+degrade 成对 · 编号连续）", planOk, `${MOBILE_PLAN_PLATFORMS.length}×${MOBILE_SYMPTOMS.length} 计划 · 共 ${stepTotal} 步`);

  // 7) logcat argv 形态（`logcat -d -t N *:I` 与 `-s TAG` / `-s serial`）
  const argvPlain = logcatArgv("adb", { lines: 100, level: "E" });
  const argvTag = logcatArgv("adb", { lines: 50, tag: "chromium", serial: "X1" });
  t(
    "logcat argv 形态（logcat -d -t N *:I / -s TAG / -s serial）",
    argvPlain.join(" ").includes("logcat -d -t 100 *:E")
      && argvTag.join(" ").includes("-s X1") && argvTag.join(" ").includes("logcat -d -t 50") && argvTag.join(" ").endsWith("-s chromium"),
  );

  // 8) 症状归一（中英宽容）
  t(
    "症状关键词归一（白屏/whitescreen/ANR/卡顿 → 归一枚举）",
    normalizeSymptom("白屏") === "white-screen" && normalizeSymptom("whitescreen") === "white-screen"
      && normalizeSymptom("ANR 无响应") === "crash" && normalizeSymptom("卡顿") === "performance"
      && normalizeSymptom("构建失败") === "build" && normalizeSymptom("装不上") === "install"
      && normalizeSymptom("whatever") === "crash",
  );

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
