// ============================================================================
// lib/notify.ts — 通知中心与桌面通知（v0.5.2）
// ----------------------------------------------------------------------------
// 长程任务的「完成提醒」层：
//   1. 通知存储：`<ws>/runtime/notifications.json`（数组 + 原子写），CLI
//      `org notify list/read/clear` 与 Web 通知面板共用同一实现；
//   2. 桌面通知：三级降级链 notify-send（Linux）→ osascript（macOS）→
//      powershell toast（Windows）→ 仅控制台；全部失败/无命令时静默
//      返回 "unavailable"，绝不炸主流程；
//   3. 开关：`org config set desktop_notify on|off|auto`（缺省 auto ——
//      检测到命令才发）。通知存储不受开关影响（面板/CLI 始终可读）；
//   4. webhook 出站（v0.5.5）：`org config set notify_webhook_url URL` 后
//      每条通知 fire-and-forget POST JSON（5s 超时，失败静默不炸主流程）；
//      `notify_webhook_events` 可选事件过滤（逗号分隔，缺省全发）。
//      桌面/存储/webhook 三通道互不影响（多重优雅降级）。
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "./config.ts";

export type NotifyKind =
  | "task_done" | "task_failed" | "task_cancelled"
  | "approval_requested" | "custom";

export interface Notification {
  id: string;
  kind: NotifyKind;
  title: string;
  detail: string;
  ts: string;
  read: boolean;
  /** 关联任务 id（可跳转任务详情）。 */
  taskId?: string;
}

function notifyFile(ws: string): string {
  return path.join(ws, "runtime", "notifications.json");
}

function newId(): string {
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 写一条通知（原子写 + 容量上限 200 条，超出裁最老）。 */
export function notifyEvent(
  ws: string,
  kind: NotifyKind,
  title: string,
  detail: string,
  opts: { taskId?: string; desktop?: boolean; webhook?: boolean } = {},
): Notification {
  const n: Notification = {
    id: newId(), kind, title, detail: detail.slice(0, 400),
    ts: new Date().toISOString(), read: false, taskId: opts.taskId,
  };
  try {
    const file = notifyFile(ws);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const list = readNotificationsRaw(file);
    list.push(n);
    while (list.length > 200) list.shift();
    atomicWrite(file, JSON.stringify(list, null, 2) + "\n");
  } catch {
    // 存储失败静默（通知是增强面，绝不挡业务）
  }
  if (opts.desktop !== false) {
    try { desktopNotify(title, detail); } catch { /* 三级降级已兜底 */ }
  }
  // webhook 出站（v0.5.5）：fire-and-forget —— 不 await、不 throw（慢/坏
  // endpoint 绝不拖累通知写入与业务主流程）
  if (opts.webhook !== false) {
    void webhookNotify(n);
  }
  return n;
}

// ---- webhook 出站（v0.5.5） ------------------------------------------------------

export interface WebhookResult {
  status: "sent" | "off" | "filtered" | "failed";
  code?: number;
  error?: string;
}

/** 通知出站到 webhook（POST JSON）。导出供 org notify test 实测与测试。 */
export async function webhookNotify(n: Notification): Promise<WebhookResult> {
  const cfg = loadConfig();
  const url = (cfg.notify_webhook_url ?? "").trim();
  if (url.length === 0) return { status: "off" };
  // 事件过滤（逗号分隔 kind；空/"*" = 全发）
  const filter = (cfg.notify_webhook_events ?? "").trim();
  if (filter.length > 0 && filter !== "*") {
    const allow = filter.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (allow.length > 0 && !allow.includes(n.kind)) return { status: "filtered" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "org", event: n.kind, title: n.title, detail: n.detail,
        ts: n.ts, taskId: n.taskId ?? null, notificationId: n.id,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { status: "failed", code: res.status };
    return { status: "sent", code: res.status };
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** 读通知（坏文件 → 空列表不炸）。 */
export function readNotifications(ws: string, opts: { unreadOnly?: boolean } = {}): Notification[] {
  const list = readNotificationsRaw(notifyFile(ws));
  return opts.unreadOnly ? list.filter((n) => !n.read) : list;
}

export function unreadCount(ws: string): number {
  return readNotifications(ws, { unreadOnly: true }).length;
}

/** 标记已读（id 或 "all"）。返回受影响条数。 */
export function markRead(ws: string, id: string): number {
  const file = notifyFile(ws);
  const list = readNotificationsRaw(file);
  let n = 0;
  for (const item of list) {
    if (!item.read && (id === "all" || item.id === id)) {
      item.read = true;
      n++;
    }
  }
  if (n > 0) atomicWrite(file, JSON.stringify(list, null, 2) + "\n");
  return n;
}

/** 清空全部通知。 */
export function clearNotifications(ws: string): void {
  try { fs.rmSync(notifyFile(ws), { force: true }); } catch { /* 不存在 */ }
}

function readNotificationsRaw(file: string): Notification[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is Notification =>
      x !== null && typeof x === "object" &&
      typeof (x as Notification).id === "string" &&
      typeof (x as Notification).title === "string");
  } catch {
    return [];
  }
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
}

// ---- 桌面通知（三级降级链） ---------------------------------------------------

export type DesktopResult = "sent" | "unavailable" | "disabled";

/**
 * 桌面通知：notify-send → osascript → powershell toast → 仅控制台。
 * 任一环节失败静默降级；无 TTY 的 CI 环境自动跳过（不留悬挂进程）。
 */
export function desktopNotify(title: string, body: string): DesktopResult {
  const cfg = (loadConfig().desktop_notify ?? "").trim().toLowerCase();
  if (cfg === "off" || cfg === "0" || cfg === "false" || cfg === "no") return "disabled";
  const force = cfg === "on" || cfg === "1" || cfg === "true" || cfg === "yes";
  // auto：无 DISPLAY 的 Linux 无桌面可发（CI 容器）—— 跳过省一次 spawn
  if (!force && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "unavailable";
  }
  const t = title.replace(/["']/g, "");
  const b = body.replace(/["']/g, "").slice(0, 180);
  const tryCmd = (args: string[]): boolean => {
    try {
      const r = Bun.spawnSync(args, { stdout: "ignore", stderr: "ignore", timeout: 5000 } as Parameters<typeof Bun.spawnSync>[1]);
      return r.exitCode === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin") {
    if (tryCmd(["osascript", "-e", `display notification "${b}" with title "${t}"`])) return "sent";
  } else if (process.platform === "win32") {
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; Write-Output ok`;
    if (tryCmd(["powershell", "-NoProfile", "-Command", ps])) return "sent";
  } else {
    if (tryCmd(["notify-send", t, b])) return "sent";
  }
  return "unavailable";
}
