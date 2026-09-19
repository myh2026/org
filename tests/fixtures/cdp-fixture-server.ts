// ============================================================================
// tests/fixtures/cdp-fixture-server.ts — 测试用假 CDP 服务端（v0.5.20）
// ----------------------------------------------------------------------------
// 真 HTTP /json/version + /json/list + WebSocket CDP 协议对话（Bun.serve
// websocket 车道），行为由 FAKE_CDP_* 环境变量控制：
//   FAKE_CDP_CONSOLE    Runtime.enable 后发的 consoleAPICalled 序列
//                       （JSON 数组 [{type:"log"|"error"|…, text:"…"}]）
//   FAKE_CDP_EXCEPTION  Runtime.enable 后发的 exceptionThrown 异常文本
//   FAKE_CDP_LOG_ENTRY  Log.enable 后发的 Log.entryAdded 文本
//   FAKE_CDP_NET        Page.navigate 后发的网络请求生命周期序列
//                       （JSON 数组 [{url, method, status, mime, size,
//                        durationMs, failed?, errorText?}]）
//   FAKE_CDP_EVAL       Runtime.evaluate 表达式 → 值映射（JSON 对象
//                       {"1+1": 2, "location.href": "http://x.test/"}；
//                       匹配不到回 undefined）
//   FAKE_CDP_SEL_MISS   "1" = 交互脚本回 {ok:false, reason:"元素未找到"}
//   FAKE_CDP_GARBAGE    "1" = WebSocket open 后先发一行非 JSON 人话
//   FAKE_CDP_DIE_ON     处理完第 N 条消息后关闭 WebSocket（响应已发完）
//   FAKE_CDP_DIE_SILENT 第 N 条消息**不响应直接关 WebSocket**（测 pending
//                       请求统一拒绝 —— 中途死亡车道）
//   FAKE_CDP_HANG       "1" = Runtime.evaluate 永不响应（测请求超时）
//   FAKE_CDP_PAGE_URL   /json/list 里的页面 URL（缺省 http://fixture.test/page）
// 启动后打一行 "CDP_FIXTURE_READY http://127.0.0.1:<port>"（随机端口）。
// ============================================================================
import * as os from "node:os";

interface CdpMsg {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface FakeConsole {
  type: string;
  text: string;
}

interface FakeNetReq {
  url: string;
  method: string;
  status: number;
  mime: string;
  size: number;
  durationMs: number;
  failed?: boolean;
  errorText?: string;
}

const CONSOLE_SEQ: FakeConsole[] = (() => {
  try {
    return JSON.parse(process.env.FAKE_CDP_CONSOLE ?? "[]") as FakeConsole[];
  } catch {
    return [];
  }
})();
const EXCEPTION_TEXT = process.env.FAKE_CDP_EXCEPTION ?? "";
const LOG_ENTRY_TEXT = process.env.FAKE_CDP_LOG_ENTRY ?? "";
const NET_SEQ: FakeNetReq[] = (() => {
  try {
    return JSON.parse(process.env.FAKE_CDP_NET ?? "[]") as FakeNetReq[];
  } catch {
    return [];
  }
})();
const EVAL_MAP: Record<string, unknown> = (() => {
  try {
    return JSON.parse(process.env.FAKE_CDP_EVAL ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
})();
const SEL_MISS = process.env.FAKE_CDP_SEL_MISS === "1";
const GARBAGE = process.env.FAKE_CDP_GARBAGE === "1";
const DIE_ON = Number(process.env.FAKE_CDP_DIE_ON ?? 0);
const DIE_SILENT = Number(process.env.FAKE_CDP_DIE_SILENT ?? 0);
const HANG = process.env.FAKE_CDP_HANG === "1";
const PAGE_URL = process.env.FAKE_CDP_PAGE_URL ?? "http://fixture.test/page";

let handled = 0;

function send(ws: { send: (s: string) => void }, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

function respond(ws: { send: (s: string) => void }, id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return;
  send(ws, { id, result });
}

function respondErr(ws: { send: (s: string) => void }, id: number | string | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return;
  send(ws, { id, error: { code, message } });
}

const server = Bun.serve({
  port: 0,
  fetch(req, serverRef) {
    const url = new URL(req.url);
    if (url.pathname === "/json/version") {
      return Response.json({
        Browser: "fixture-chrome/128.0.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "fixture-agent",
        webSocketDebuggerUrl: `ws://127.0.0.1:${serverRef.port}/devtools/browser/fixture-uuid`,
      });
    }
    if (url.pathname === "/json/list") {
      return Response.json([
        {
          id: "fixture-page-1",
          type: "page",
          title: "fixture 页面",
          url: PAGE_URL,
          webSocketDebuggerUrl: `ws://127.0.0.1:${serverRef.port}/devtools/page/fixture-page-1`,
        },
        {
          id: "fixture-worker-1",
          type: "worker",
          title: "fixture worker",
          url: PAGE_URL,
          webSocketDebuggerUrl: `ws://127.0.0.1:${serverRef.port}/devtools/page/fixture-worker-1`,
        },
      ]);
    }
    if (url.pathname.startsWith("/devtools/page/") || url.pathname.startsWith("/devtools/browser/")) {
      if (serverRef.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (GARBAGE) {
        // 坏行 —— 客户端应拒收不炸（分帧防御）
        ws.send("fixture CDP server 启动日志（非 JSON 人话）");
      }
    },
    message(ws, data) {
      let msg: CdpMsg;
      try {
        msg = JSON.parse(typeof data === "string" ? data : "") as CdpMsg;
      } catch {
        return; // 坏消息丢弃
      }
      if (typeof msg.method !== "string") return; // 响应/坏形态 —— 服务端不处理
      handled++;
      if (DIE_SILENT > 0 && handled >= DIE_SILENT) {
        // 第 N 条消息：不响应直接关 —— 客户端 pending 请求由 close 钩子统一拒绝
        try { ws.close(); } catch { /* 已关 */ }
        return;
      }
      const id = msg.id ?? null;
      switch (msg.method) {
        case "Runtime.enable": {
          respond(ws, id, {});
          // 发 console 序列（延迟 10ms 逐条 —— 响应先到，事件后到）
          CONSOLE_SEQ.forEach((c, i) => {
            setTimeout(() => {
              send(ws, {
                method: "Runtime.consoleAPICalled",
                params: {
                  type: c.type,
                  args: [{ type: "string", value: c.text }],
                  timestamp: Date.now(),
                },
              });
            }, 10 * (i + 1));
          });
          if (EXCEPTION_TEXT) {
            setTimeout(() => {
              send(ws, {
                method: "Runtime.exceptionThrown",
                params: { exceptionDetails: { text: "Uncaught", exception: { description: EXCEPTION_TEXT }, url: `${PAGE_URL}/app.js`, lineNumber: 42 } },
              });
            }, 10 * (CONSOLE_SEQ.length + 1));
          }
          break;
        }
        case "Log.enable": {
          respond(ws, id, {});
          if (LOG_ENTRY_TEXT) {
            setTimeout(() => {
              send(ws, { method: "Log.entryAdded", params: { entry: { source: "network", level: "error", text: LOG_ENTRY_TEXT, url: `${PAGE_URL}/404.js`, lineNumber: 1 } } });
            }, 10);
          }
          break;
        }
        case "Network.enable":
        case "Page.enable":
        case "Runtime.disable":
        case "Log.disable":
        case "Network.disable":
          respond(ws, id, {});
          break;
        case "Page.navigate": {
          respond(ws, id, { frameId: "fixture-frame", loaderId: "fixture-loader" });
          // 发网络请求生命周期序列（requestWillBeSent → responseReceived →
          // loadingFinished/loadingFailed）+ loadEventFired —— 时间戳用合成值
          // （客户端按 timestamp 差算 duration，不依赖真实到达时间）
          const t0 = Date.now() / 1000;
          NET_SEQ.forEach((q, i) => {
            send(ws, {
              method: "Network.requestWillBeSent",
              params: { requestId: `req-${i}`, request: { url: q.url, method: q.method }, timestamp: t0, type: "Document" },
            });
            if (q.failed) {
              send(ws, {
                method: "Network.loadingFailed",
                params: { requestId: `req-${i}`, errorText: q.errorText ?? "net::ERR_CONNECTION_REFUSED", timestamp: t0 + q.durationMs / 1000 },
              });
            } else {
              send(ws, {
                method: "Network.responseReceived",
                params: { requestId: `req-${i}`, response: { status: q.status, mimeType: q.mime }, timestamp: t0 + q.durationMs / 1000 },
              });
              send(ws, {
                method: "Network.loadingFinished",
                params: { requestId: `req-${i}`, encodedDataLength: q.size, timestamp: t0 + q.durationMs / 1000 },
              });
            }
          });
          setTimeout(() => {
            send(ws, { method: "Page.loadEventFired", params: { timestamp: t0 + 0.5 } });
          }, 30);
          break;
        }
        case "Runtime.evaluate": {
          if (HANG) break; // 永不响应 —— 客户端应超时
          const expr = String((msg.params ?? {}).expression ?? "");
          if (/document\.querySelector/.test(expr)) {
            // 交互脚本（click/fill/check —— interactScript 的构造形态）
            if (SEL_MISS) {
              respond(ws, id, { result: { type: "object", value: { ok: false, reason: "元素未找到" } } });
            } else if (/el\.click\(\)/.test(expr)) {
              respond(ws, id, { result: { type: "object", value: { ok: true, tag: "BUTTON" } } });
            } else {
              respond(ws, id, { result: { type: "object", value: { ok: true } } });
            }
            break;
          }
          if (expr in EVAL_MAP) {
            const v = EVAL_MAP[expr]!;
            respond(ws, id, { result: { type: typeof v, value: v } });
            break;
          }
          if (/document\.title/.test(expr)) {
            respond(ws, id, { result: { type: "string", value: "fixture 页面标题" } });
            break;
          }
          respond(ws, id, { result: { type: "undefined" } });
          break;
        }
        default:
          respondErr(ws, id, -32601, `未知方法：${msg.method}`);
      }
      if (DIE_ON > 0 && handled >= DIE_ON) {
        // 中途死亡 —— 关 WebSocket（客户端 pending 请求统一拒绝）
        try {
          ws.close();
        } catch {
          // 已关
        }
      }
    },
    close() {
      // 客户端主动关 —— 无事可做
    },
  },
});

// 就绪行（测试 spawn 后按行等它）
console.log(`CDP_FIXTURE_READY http://127.0.0.1:${server.port}`);

// 温和退出（SIGTERM/SIGINT）
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
// 温和提示（os import 防树摇 —— 就绪行是唯一 stdout 契约，多余的都走 stderr）
process.stderr.write(`fixture CDP server on 127.0.0.1:${server.port} (${os.platform()})\n`);
