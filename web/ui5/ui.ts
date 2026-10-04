// ============================================================================
// web/ui5/ui.ts — ORG Web UI v5（从零重写 · 2026-10-04）
// ----------------------------------------------------------------------------
// 定位：v4 之前的 UI 是在 v2/v3 底座上多轮演进的结果（9543 行、结构层叠）。
// 本文件按「推翻重写」令从零编写：**新设计语言 · 新结构 · 新客户端代码**，
// 服务器层（web/entry.ts 路由/SSE）不动，通过 ORG_WEB_UI=v5 切换渲染。
//
// 设计语言（参考 ui-research.md：codex / dsh / zcode 三源收敛）：
//   · operator's console —— 信息密度优先，chrome 克制（codex）
//   · rail(56) + side(280) + main + statusbar 一条线（dsh 三栏参数）
//   · composer 内联 chip（模式/车道/审批）· 审批 composer 接管（dsh）
//   · 工具/事件行双行内联、可折叠（opencode）
//   · 设计规则即可执行约束（--fs-* 六档；色值仅 token 与契约串）
// 技术纪律：
//   · 单文件、零外链、无第三方依赖；客户端 JS 字符串拼接（无模板串）
//   · 模板字符串内：反引号 \`、美元花括号 \\${ 一律转义；客户端正则反斜杠双写
//   · 契约串（8 项）不在此文件 —— 旧客户端未动，契约由 tests/web.test.ts 继续锁定
// ============================================================================
import { ORG_VERSION as VERSION } from "../../lib/version.ts";

export function renderV5Page(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>org · console</title>
<style>
/* ── v5 · tokens ────────────────────────────────────────────────────────── */
:root {
  --bg0:#0b0c0e; --bg1:#101114; --bg2:#15171b; --bg3:#1b1e23;
  --ln:rgba(255,255,255,.07); --ln2:rgba(255,255,255,.13);
  --tx:#e9eaee; --tx2:#a7abb6; --tx3:#6d717c;
  --ac:#6aa9ff; --ac-bg:rgba(106,169,255,.12); --ac-ring:rgba(106,169,255,.35);
  --ok:#3ecf8e; --warn:#e0a83a; --err:#ef6262; --lane-x:#7dd3fc;
  --fs-xs:11px; --fs-sm:11.5px; --fs-base:13px; --fs-md:14.5px; --fs-lg:17px; --fs-xl:22px;
  --sp1:4px; --sp2:8px; --sp3:12px; --sp4:16px; --sp5:24px;
  --r1:6px; --r2:10px; --r3:14px;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace;
  --ease-out:cubic-bezier(.23,1,.32,1); --ease-drawer:cubic-bezier(.32,.72,0,1);
  --sh:0 0 0 1px rgba(255,255,255,.05),0 18px 44px rgba(0,0,0,.5);
}
* { box-sizing:border-box; margin:0; padding:0; }
html,body { height:100%; }
body { background:var(--bg0); color:var(--tx); font:var(--fs-base)/1.6 var(--sans);
  overflow:hidden; -webkit-font-smoothing:antialiased; }
::selection { background:var(--ac); color:#0b0c0e; }
::-webkit-scrollbar { width:9px; height:9px; }
::-webkit-scrollbar-thumb { background:rgba(255,255,255,.13); border-radius:99px;
  border:3px solid transparent; background-clip:padding-box; }
button { font-family:var(--sans); color:inherit; background:none; border:none;
  cursor:pointer; transition:transform 130ms var(--ease-out),background 130ms var(--ease-out),
  border-color 130ms var(--ease-out),color 130ms var(--ease-out),opacity 130ms var(--ease-out); }
button:active { transform:scale(.97); }
button:disabled { opacity:.45; cursor:not-allowed; }
input,textarea,select { font-family:var(--sans); color:var(--tx); background:none; border:none; outline:none; }
:focus-visible { outline:none; box-shadow:0 0 0 3px var(--ac-ring); border-radius:var(--r1); }
[hidden] { display:none !important; }

/* ── v5 · 布局 ──────────────────────────────────────────────────────────── */
#app { display:grid; grid-template-columns:56px 280px 1fr; grid-template-rows:1fr 28px;
  height:100vh; }
#rail { grid-row:1; border-right:1px solid var(--ln); background:var(--bg1);
  display:flex; flex-direction:column; align-items:center; gap:6px; padding:10px 0; }
#rail .rgrow { flex:1; }
.rb { width:40px; height:40px; border-radius:var(--r2); display:flex; align-items:center;
  justify-content:center; color:var(--tx3); }
.rb:hover { background:var(--bg3); color:var(--tx2); }
.rb.on { background:var(--ac-bg); color:var(--ac); }
.rb svg { width:19px; height:19px; stroke:currentColor; fill:none; stroke-width:1.7;
  stroke-linecap:round; stroke-linejoin:round; }
#side { grid-row:1; border-right:1px solid var(--ln); background:var(--bg1);
  display:flex; flex-direction:column; min-height:0; }
.sec { display:none; flex-direction:column; min-height:0; flex:1; }
.sec.on { display:flex; }
.shead { display:flex; align-items:center; gap:var(--sp2); padding:10px 12px 6px;
  color:var(--tx3); font:600 var(--fs-xs) var(--sans); text-transform:uppercase;
  letter-spacing:.05em; }
.shead .cnt { margin-left:auto; font:var(--fs-xs) var(--mono); color:var(--tx3); }
.slist { flex:1; overflow-y:auto; padding:2px 6px 10px; min-height:0; }
.sgrp { margin-top:6px; }
.sitem { display:block; width:100%; text-align:left; padding:6px 8px; border-radius:var(--r1);
  color:var(--tx2); font-size:var(--fs-base); white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; }
.sitem:hover { background:var(--bg3); color:var(--tx); }
.sitem.on { background:var(--ac-bg); color:var(--ac); }
.sitem .sub { color:var(--tx3); font:var(--fs-xs) var(--mono); }
.sitem .bdg { float:right; color:var(--tx3); font-size:var(--fs-xs); }
.sempty { color:var(--tx3); padding:10px 12px; font-size:var(--fs-sm); }
#newAsk { margin:10px 10px 4px; padding:9px 10px; border:1px solid var(--ln2);
  border-radius:var(--r2); color:var(--tx); background:var(--bg2); font-size:var(--fs-base); }
#newAsk:hover { border-color:var(--ac); color:var(--ac); }

/* ── v5 · 主列 ──────────────────────────────────────────────────────────── */
#main { grid-row:1; display:flex; flex-direction:column; min-width:0; min-height:0;
  background:var(--bg0); }
#top { flex:none; height:44px; display:flex; align-items:center; gap:var(--sp3);
  padding:0 18px; border-bottom:1px solid var(--ln); }
#crumb { color:var(--tx2); font:var(--fs-sm) var(--sans); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
#crumb b { color:var(--tx); font-weight:600; }
#top .grow { flex:1; }
.tbtn { padding:5px 10px; border:1px solid var(--ln); border-radius:var(--r1);
  color:var(--tx2); font-size:var(--fs-sm); }
.tbtn:hover { border-color:var(--ln2); color:var(--tx); }

#stream { flex:1; overflow-y:auto; min-height:0; padding:22px 0 12px; }
.col { width:min(780px,100%); margin:0 auto; padding:0 18px; }
.msg { margin:0 0 16px; }
.msg .who { font:600 var(--fs-xs) var(--sans); color:var(--tx3); text-transform:uppercase;
  letter-spacing:.05em; margin-bottom:4px; }
.msg.user .bubble { background:var(--bg2); border:1px solid var(--ln); border-radius:var(--r3);
  padding:10px 14px; white-space:pre-wrap; }
.msg.agent .md { font-size:var(--fs-md); line-height:1.7; color:var(--tx); }
.md code { font:12px var(--mono); background:var(--bg3); padding:1px 5px; border-radius:4px; }
.md pre { font:12px/1.55 var(--mono); background:var(--bg2); border:1px solid var(--ln);
  border-radius:var(--r2); padding:10px 12px; overflow-x:auto; margin:8px 0; white-space:pre-wrap; }
.md p { margin:6px 0; }
.md b { color:#fff; }

/* 运行卡：operator 式 —— 头部一行 + 事实流 */
.rc { border:1px solid var(--ln); border-radius:var(--r3); background:var(--bg1);
  margin:0 0 16px; overflow:hidden; }
.rc .rhead { display:flex; align-items:center; gap:var(--sp2); padding:9px 13px;
  border-bottom:1px solid var(--ln); color:var(--tx2); font-size:var(--fs-sm); }
.rc .rhead .ttl { color:var(--tx); font-weight:600; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.rc .rhead .st { margin-left:auto; font:var(--fs-xs) var(--mono); color:var(--tx3); }
.rc .rbody { padding:6px 0; max-height:340px; overflow-y:auto; }
.fact { display:flex; gap:var(--sp2); padding:3px 13px; font-size:var(--fs-sm);
  color:var(--tx2); line-height:1.5; }
.fact .dot { flex:none; width:14px; text-align:center; color:var(--tx3); font:var(--fs-xs)/1.8 var(--mono); }
.fact.ok .dot, .fact.ok { color:var(--ok); }
.fact.warn .dot, .fact.warn { color:var(--warn); }
.fact.err .dot, .fact.err { color:var(--err); }
.fact.lane .dot, .fact.lane { color:var(--lane-x); }
.fact.dim { color:var(--tx3); }
.fact b { color:var(--tx); font-weight:600; }
.fact code { font:11.5px var(--mono); color:var(--tx2); background:var(--bg3);
  padding:0 4px; border-radius:4px; }
.rc .rfoot { display:flex; gap:var(--sp3); padding:8px 13px; border-top:1px solid var(--ln);
  color:var(--tx3); font:var(--fs-xs) var(--mono); }
.badge { display:inline-block; padding:1px 7px; border-radius:99px; border:1px solid var(--ln2);
  font:var(--fs-xs) var(--mono); color:var(--tx3); }
.badge.team { color:var(--ac); border-color:rgba(106,169,255,.4); }
.badge.expert { color:var(--lane-x); border-color:rgba(125,211,252,.4); }
.badge.degrade { color:var(--warn); border-color:rgba(224,168,58,.4); }

/* 审批接管条（dsh 式：composer 顶部接管） */
#appr { flex:none; width:min(780px,100%); margin:0 auto; padding:0 18px; }
#appr .bar { display:flex; align-items:center; gap:var(--sp3); border:1px solid rgba(224,168,58,.4);
  background:rgba(224,168,58,.07); border-radius:var(--r2); padding:8px 12px; margin-bottom:8px;
  font-size:var(--fs-sm); }
#appr .bar .txt { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#appr .bar b { color:var(--warn); }
#appr button { padding:4px 10px; border:1px solid var(--ln2); border-radius:var(--r1); font-size:var(--fs-sm); }
#appr button.ok { color:var(--ok); border-color:rgba(62,207,142,.5); }
#appr button.no { color:var(--err); border-color:rgba(239,98,98,.5); }

/* composer */
#comp { flex:none; width:min(780px,100%); margin:0 auto; padding:4px 18px 12px; }
.cbox { border:1px solid var(--ln2); border-radius:var(--r3); background:var(--bg1);
  transition:border-color 140ms var(--ease-out),box-shadow 140ms var(--ease-out); }
.cbox:focus-within { border-color:var(--ac); box-shadow:0 0 0 3px var(--ac-ring); }
.chips { display:flex; align-items:center; gap:6px; padding:8px 10px 0; flex-wrap:wrap; }
.chip { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border:1px solid var(--ln);
  border-radius:99px; color:var(--tx2); font-size:var(--fs-sm); background:var(--bg2); }
.chip:hover { border-color:var(--ln2); color:var(--tx); }
.chip .k { color:var(--tx3); }
.chip.hot { color:var(--ac); border-color:rgba(106,169,255,.4); background:var(--ac-bg); }
select.chip { appearance:none; -webkit-appearance:none; padding-right:16px;
  background-image:linear-gradient(45deg,transparent 50%,var(--tx3) 50%),linear-gradient(135deg,var(--tx3) 50%,transparent 50%);
  background-position:calc(100% - 10px) 55%,calc(100% - 6px) 55%; background-size:4px 4px;
  background-repeat:no-repeat; }
select.chip option { background:var(--bg2); color:var(--tx); }
#inp { display:block; width:100%; padding:8px 12px; resize:none; font-size:var(--fs-md);
  line-height:1.6; min-height:44px; max-height:190px; }
.cbot { display:flex; align-items:center; gap:var(--sp3); padding:2px 10px 9px; }
#hint { flex:1; color:var(--tx3); font-size:var(--fs-xs); }
#send { padding:6px 16px; border-radius:var(--r2); background:var(--tx); color:#0b0c0e;
  font-weight:600; font-size:var(--fs-base); }
#send:hover { background:#fff; }
#stop { padding:6px 14px; border-radius:var(--r2); border:1px solid rgba(239,98,98,.5);
  color:var(--err); font-size:var(--fs-base); }

/* statusbar：一行化常显（opencode 式） */
#sb { grid-column:1 / 4; grid-row:2; display:flex; align-items:center; gap:var(--sp3);
  border-top:1px solid var(--ln); background:var(--bg1); padding:0 12px;
  font:var(--fs-xs) var(--mono); color:var(--tx3); }
#sb .brand { color:var(--tx2); font-weight:700; }
#sb .seg { cursor:default; }
#sb .seg.click { cursor:pointer; }
#sb .seg.click:hover { color:var(--tx); }
#sb .grow { flex:1; }
#sb .run { color:var(--ac); } #sb .idle { color:var(--tx3); } #sb .errst { color:var(--err); }

@media (max-width:1023px) {
  #app { grid-template-columns:56px 0 1fr; }
  #side { position:fixed; left:56px; top:0; bottom:28px; width:280px; z-index:20;
    transform:translateX(-110%); transition:transform 180ms var(--ease-drawer);
    border-right:1px solid var(--ln2); box-shadow:var(--sh); }
  #side.open { transform:none; }
}
@media (prefers-reduced-motion:reduce) {
  * { transition:none !important; animation:none !important; }
}
</style>
</head>
<body>
<div id="app">
  <nav id="rail" aria-label="主导航">
    <button class="rb on" id="rbChat" data-sec="chat" title="对话"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.2-.5L4 21l1.7-4.2A8.4 8.4 0 1 1 21 11.5z"/></svg></button>
    <button class="rb" id="rbRuns" data-sec="runs" title="运行"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></button>
    <button class="rb" id="rbTasks" data-sec="tasks" title="任务"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg></button>
    <div class="rgrow"></div>
    <button class="rb" id="rbAbout" title="关于"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg></button>
  </nav>
  <aside id="side">
    <div class="sec on" id="secChat">
      <button id="newAsk">＋ 新会话</button>
      <div class="shead">专家 <span class="cnt" id="cntExp"></span></div>
      <div class="slist" id="lstExp"></div>
      <div class="shead">会话 <span class="cnt" id="cntSes"></span></div>
      <div class="slist" id="lstSes" style="max-height:34%"></div>
    </div>
    <div class="sec" id="secRuns">
      <div class="shead">运行产物 <span class="cnt" id="cntRuns"></span></div>
      <div class="slist" id="lstRuns"></div>
    </div>
    <div class="sec" id="secTasks">
      <div class="shead">任务队列 <span class="cnt" id="cntTasks"></span></div>
      <div class="slist" id="lstTasks"></div>
    </div>
  </aside>
  <main id="main">
    <header id="top">
      <span id="crumb">org · console</span>
      <span class="grow"></span>
      <button class="tbtn" id="btnCost" title="用量/成本">用量</button>
    </header>
    <div id="stream"><div class="col" id="streamCol"></div></div>
    <div id="appr" hidden></div>
    <div id="comp">
      <div class="cbox">
        <div class="chips">
          <button class="chip hot" id="chipMode" title="发送车道：团队=监督回路 / 直连=单专家"><span class="k">模式</span><span id="modeTx">团队</span></button>
          <select class="chip" id="chipLane" title="模型车道"></select>
          <button class="chip" id="chipAppr" title="审批：运行中的高危操作在此放行（文件协议同 CLI）"><span class="k">审批</span><span id="apprTx">常规</span></button>
        </div>
        <textarea id="inp" rows="1" placeholder="输入任务 —— Enter 发送 · Shift+Enter 换行 · Esc 停止"></textarea>
        <div class="cbot">
          <span id="hint"></span>
          <button id="stop" hidden>停止</button>
          <button id="send">发送 ↑</button>
        </div>
      </div>
    </div>
  </main>
  <footer id="sb">
    <span class="brand">org</span>
    <span class="seg click" id="sbCtx" title="上下文水位（点击查看用量时间线）">ctx —</span>
    <span class="seg" id="sbTok">tok 0</span>
    <span class="seg" id="sbMode">团队</span>
    <span class="grow"></span>
    <span class="seg" id="sbLane">lane —</span>
    <span class="seg" id="sbState"><span class="idle">idle</span></span>
  </footer>
</div>
<script>
'use strict';
/* ============================================================================
   v5 客户端 —— 从零编写（无框架 · 字符串拼接 · 零外链）
   API 契约（服务器层未动）：
     GET  /api/status /api/runs /api/sessions?expert= /api/session/<e>/<s>
     GET  /api/providers /api/approvals /api/tasks /api/cost?dir=
     POST /api/run-stream {task,model}   SSE: open→start→card*→done/error
     POST /api/ask-stream {expert,question,session,model} SSE: open→(queued?)→start→stage*→log*→done/error
     POST /api/abort {id?}  POST /api/approvals {id,allow,always}
   ========================================================================== */
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
  return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"; }); }
function fmtTok(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
function fmtMs(ms) { ms = Number(ms) || 0; return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms"; }

var state = {
  experts: [], usages: [], runs: [], sessions: [], tasks: [],
  currentExpert: null, currentSession: null,
  mode: "team", model: "scripted", running: false, ticketId: 0
};

/* ---- 通用 ---- */
function api(url, body) {
  return fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) } : undefined).then(function (r) { return r.json(); });
}
function ssePost(url, body, onEvent, onEnd) {
  var doneSeen = false;
  fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) })
    .then(function (r) {
      if (!r.ok) {
        return r.json().then(function (e) { throw new Error(e && e.error ? e.error : "HTTP " + r.status); },
          function () { throw new Error("HTTP " + r.status); });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) { if (onEnd) onEnd(doneSeen); return; }
          buf += dec.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf("\\n\\n")) >= 0) {
            var frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            var ev = "", data = null;
            frame.split("\\n").forEach(function (l) {
              if (l.indexOf("event:") === 0) ev = l.slice(6).trim();
              else if (l.indexOf("data:") === 0) {
                try { data = JSON.parse(l.slice(5).trim()); } catch (e) { data = null; }
              }
            });
            if (ev === "done") doneSeen = true;
            onEvent(ev, data);
          }
          return pump();
        });
      }
      return pump();
    })
    .catch(function (e) { onEvent("error", { message: String(e && e.message || e) }); if (onEnd) onEnd(doneSeen); });
}

/* ---- 迷你 markdown（段落/粗体/行内码/围栏码块/换行） ---- */
function mdToHtml(src) {
  var out = [], lines = String(src || "").split("\\n"), i = 0;
  function inline(s) {
    s = esc(s);
    s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
    return s;
  }
  while (i < lines.length) {
    var l = lines[i];
    if (l.indexOf("\`\`\`") === 0) {
      var body = []; i++;
      while (i < lines.length && lines[i].indexOf("\`\`\`") !== 0) { body.push(lines[i]); i++; }
      i++;
      out.push("<pre>" + esc(body.join("\\n")) + "</pre>");
      continue;
    }
    if (l.trim().length === 0) { i++; continue; }
    var para = [l]; i++;
    while (i < lines.length && lines[i].trim().length > 0 && lines[i].indexOf("\`\`\`") !== 0) {
      para.push(lines[i]); i++;
    }
    out.push("<p>" + para.map(inline).join("<br>") + "</p>");
  }
  return out.join("");
}

/* ---- 事实字典（RunFact.t → 一行渲染） ---- */
function factLine(f) {
  if (!f || !f.t) return null;
  var t = f.t;
  if (t === "mission") return { c: "dim", h: "使命 <b>" + esc(f.mission) + "</b>" };
  if (t === "runStart") return { c: "dim", h: "入口 <code>" + esc(f.entry) + "</code> · 模型 <code>" + esc(f.model) + "</code>" };
  if (t === "route") return { c: "", h: "task#" + f.id + " " + esc(f.role) + " → <code>" + esc(f.route) + ":" + esc(f.channel) + "</code>" };
  if (t === "dispatch") return { c: "", h: "task#" + f.id + " 派单 · " + esc(f.detail) };
  if (t === "review") return { c: f.verdict === "Accept" ? "ok" : (f.verdict === "Revise" ? "warn" : "err"),
    h: "task#" + f.id + " 审查 <b>" + esc(f.verdict) + "</b>" + (f.coverage != null ? " · coverage " + Number(f.coverage).toFixed(2) : "") };
  if (t === "revision") return { c: "warn", h: "task#" + f.id + " 返工 #" + f.attempt + " · " + esc(String(f.remedy || "").slice(0, 120)) };
  if (t === "reroute") return { c: "warn", h: "task#" + f.id + " 重派 · " + esc(f.detail) };
  if (t === "mint") return { c: "ok", h: "铸造专家 <b>" + esc(f.name) + "</b>@" + esc(f.version) + " · eval " + esc(f.eval) };
  if (t === "patch") return { c: "", h: "补丁 · " + esc(f.detail) };
  if (t === "asset") return { c: "ok", h: "资产 <b>" + esc(f.label) + "</b>" };
  if (t === "ctx") return { c: "dim", h: "ctx " + esc(f.expert) + "/" + esc(f.session) + " 轮" + f.turn + " · " + fmtTok(f.ctx) + "/" + fmtTok(f.window) };
  if (t === "drift") return { c: f.alerts > 0 ? "warn" : "dim", h: "评分卡漂移告警 " + f.alerts + (f.detail ? " · " + esc(f.detail) : "") };
  if (t === "mined") return { c: "dim", h: "journal→fixture 基准题 " + f.entries + " 条 · 轨道 " + f.tracks };
  if (t === "crystal") return { c: "dim", h: "固化 " + esc(f.node) + (f.frozen ? "（冻结）" : "（命中 " + esc(f.input) + "）") };
  if (t === "capability") return f.granted ? { c: "dim", h: "能力放行 <code>" + esc(f.capability) + "</code>（" + esc(f.mode) + "）" } : { c: "warn", h: "能力缺席 <code>" + esc(f.capability) + "</code>" };
  if (t === "score") return { c: "dim", h: "评分 " + esc(f.axis) + " · " + esc(f.kind) + " = " + Number(f.value).toFixed(2) };
  if (t === "shadow") return { c: f.agree ? "dim" : "warn", h: "影子对拍 " + esc(f.expert) + "（" + esc(f.candidate) + " vs " + esc(f.baseline) + "）" + (f.agree ? " 一致" : " 分歧") };
  if (t === "notice") return { c: f.tone === "err" ? "err" : (f.tone === "warn" ? "warn" : (f.tone === "ok" ? "ok" : "dim")), h: esc(f.text) };
  if (t === "approval") return { c: "warn", h: "待批准 ⚠ <code>" + esc(f.capability) + "</code> · " + esc(f.action) };
  if (t === "rescue") return { c: f.mode === "degrade" ? "warn" : "lane",
    h: f.mode === "reroute" ? "跨车道救援 → 直连 <b>" + esc(f.expert) + "</b>（评分 " + Number(f.score).toFixed(2) + "）" : "域外任务 · 零消耗降级（重合 " + Number(f.stockScore).toFixed(2) + "）" };
  if (t === "laneDecision") return { c: "lane", h: "判定 <span class='badge " + esc(f.mode) + "'>" + (f.mode === "team" ? "团队直入" : f.mode === "expert" ? "跨车道救援" : "零消耗降级") + "</span> " + esc(String(f.because || "").slice(0, 120)) };
  if (t === "runEnd") return { c: f.ok ? "ok" : "err", h: "运行结束 · ok=" + f.ok + " · " + fmtMs(f.elapsed_ms) };
  if (t === "run_result") return { c: "", h: "运行结果已归集" };
  if (t === "result") return { c: "", h: "汇总完成" };
  if (t === "audio" && f.files && f.files.length) return { c: "ok", h: "音频产物 " + f.files.length + " 件（" + esc(f.files[0].title || "") + "…）" };
  if (t === "clarify") return { c: "dim", h: "澄清 · " + esc(f.q) };
  if (t === "answer") return { c: "dim", h: "回答 · " + esc(String(f.a || "").slice(0, 140)) };
  if (t === "other") return { c: "dim", h: esc(f.name) + " " + esc(f.action) + " · " + esc(String(f.detail || "").slice(0, 120)) };
  if (t === "node") return null; /* 图节点噪声：v1 不渲染 */
  return { c: "dim", h: esc(String(t)) };
}

/* ---- 流渲染 ---- */
var streamEl = $("stream"), streamCol = $("streamCol");
function down(force) {
  var near = streamEl.scrollTop + streamEl.clientHeight > streamEl.scrollHeight - 120;
  if (force || near) streamEl.scrollTop = streamEl.scrollHeight;
}
function clearStream() { streamCol.innerHTML = ""; }
function pushMsg(role, inner) {
  var m = document.createElement("div");
  m.className = "msg " + role;
  var who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "你" : role === "agent" ? "org" : role;
  var body = document.createElement("div");
  body.className = role === "user" ? "bubble" : "md";
  if (role === "user") body.textContent = inner; else body.innerHTML = inner;
  m.appendChild(who); m.appendChild(body);
  streamCol.appendChild(m); down(false);
  return m;
}
function pushUser(t) { return pushMsg("user", t); }
function pushAgentMd(md) { return pushMsg("agent", mdToHtml(md)); }
function newCard(title) {
  var el = document.createElement("div");
  el.className = "rc";
  el.innerHTML = '<div class="rhead"><span class="ttl">' + esc(title) + '</span><span class="st"></span></div>' +
    '<div class="rbody"></div><div class="rfoot" hidden></div>';
  streamCol.appendChild(el);
  return { el: el, st: el.querySelector(".st"), body: el.querySelector(".rbody"), foot: el.querySelector(".rfoot") };
}
function cardSt(card, text) { card.st.textContent = text; }
function cardFoot(card, text) { card.foot.hidden = false; card.foot.textContent = text; }
function appendFact(card, fact) {
  var line = factLine(fact);
  if (!line) return;
  var row = document.createElement("div");
  row.className = "fact" + (line.c ? " " + line.c : "");
  row.innerHTML = '<span class="dot">·</span><span>' + line.h + "</span>";
  card.body.appendChild(row); down(false);
}
function short(s, n) { s = String(s || ""); return s.length > (n || 56) ? s.slice(0, n || 56) + "…" : s; }

/* ---- 侧栏渲染 ---- */
function renderExperts() {
  var el = $("lstExp"); el.innerHTML = "";
  $("cntExp").textContent = String(state.experts.length);
  if (!state.experts.length) { el.innerHTML = '<div class="sempty">注册表为空</div>'; return; }
  state.experts.forEach(function (e) {
    var b = document.createElement("button");
    b.className = "sitem" + (state.currentExpert === e.name ? " on" : "");
    b.innerHTML = esc(e.name) + '<span class="bdg">@' + esc(e.version || "") + (e.retained ? " ★" : "") +
      '</span><br><span class="sub">' + esc(short(e.description || "", 42)) + "</span>";
    b.onclick = function () { selectExpert(e.name); };
    el.appendChild(b);
  });
}
function renderSessions() {
  var el = $("lstSes"); el.innerHTML = "";
  $("cntSes").textContent = String(state.sessions.length);
  if (!state.sessions.length) { el.innerHTML = '<div class="sempty">该专家暂无会话</div>'; return; }
  state.sessions.forEach(function (s) {
    var b = document.createElement("button");
    b.className = "sitem" + (state.currentSession === (s.name || s.session) ? " on" : "");
    b.innerHTML = esc(s.name || s.session || "?") + '<span class="bdg">' + (s.turns != null ? s.turns + " 轮" : "") + "</span>";
    b.onclick = function () { openSession(s.name || s.session); };
    el.appendChild(b);
  });
}
function selectExpert(name) {
  state.currentExpert = name; state.currentSession = null;
  renderExperts(); loadSessions(); crumb();
}
function openSession(sess) {
  if (!state.currentExpert) return;
  state.currentSession = sess; renderSessions(); crumb();
  api("/api/session/" + encodeURIComponent(state.currentExpert) + "/" + encodeURIComponent(sess))
    .then(function (r) {
      clearStream();
      var turns = (r && r.turns) || [];
      turns.forEach(function (t) {
        if (t.question) pushUser(t.question);
        if (t.answer) pushAgentMd(t.answer);
      });
      if (!turns.length) hint("会话为空");
    });
}
function crumb() {
  $("crumb").innerHTML = "<b>" + esc(state.currentExpert || "未选专家") + "</b>" +
    (state.currentSession ? ' <span class="sub">· ' + esc(state.currentSession) + "</span>" : " · 新会话") +
    " · " + (state.mode === "team" ? "团队" : "直连");
}
function renderRuns() {
  var el = $("lstRuns"); el.innerHTML = "";
  $("cntRuns").textContent = String(state.runs.length);
  state.runs.forEach(function (r) {
    var b = document.createElement("button");
    b.className = "sitem";
    b.innerHTML = esc(r.name || r.dir || "?") + '<span class="bdg">' + (r.elapsed_ms != null ? fmtMs(r.elapsed_ms) : "") + "</span>";
    b.onclick = function () { replayRun(r.name || r.dir); };
    el.appendChild(b);
  });
  if (!state.runs.length) el.innerHTML = '<div class="sempty">暂无运行产物</div>';
}
function replayRun(dir) {
  api("/api/run?dir=" + encodeURIComponent(dir)).then(function (r) {
    clearStream();
    var card = newCard("运行回放 · " + dir);
    var rj = (r && r.run) || {};
    if (rj.task) appendFact(card, { t: "mission", mission: rj.task });
    if (rj.ok != null) appendFact(card, { t: "runEnd", ok: rj.ok, elapsed_ms: rj.elapsed_ms || 0 });
    var rep = (r && r.report) ? String(r.report) : "";
    if (rep) pushAgentMd(rep);
    cardSt(card, "回放");
  });
}
function renderTasks() {
  api("/api/tasks").then(function (r) {
    var list = (r && r.tasks) || [];
    state.tasks = list;
    var el = $("lstTasks"); el.innerHTML = "";
    $("cntTasks").textContent = String(list.length);
    list.forEach(function (t) {
      var b = document.createElement("div");
      b.className = "sitem";
      b.innerHTML = esc(short(t.goal || t.id || "?", 44)) + '<span class="bdg">' + esc(t.state || "") + "</span>";
      el.appendChild(b);
    });
    if (!list.length) el.innerHTML = '<div class="sempty">任务队列为空</div>';
  });
}

/* ---- statusbar ---- */
function renderSb() {
  var ctx = 0, win = 0, billed = 0;
  state.usages.forEach(function (u) {
    ctx += u.context || 0; win += u.window || 0; billed += u.billed || 0;
  });
  $("sbCtx").textContent = "ctx " + (win > 0 ? Math.round(ctx / win * 100) + "%" : "—");
  $("sbTok").textContent = "tok " + fmtTok(billed);
  $("sbMode").textContent = state.mode === "team" ? "团队" : "直连";
  $("sbLane").textContent = "lane " + state.model;
  $("sbState").innerHTML = state.running ? '<span class="run">running</span>' : '<span class="idle">idle</span>';
}

/* ---- 用量卡 ---- */
function showCost() {
  var dir = state.runs.length ? (state.runs[0].name || state.runs[0].dir) : "";
  if (!dir) { hint("暂无运行 —— 先跑一轮再看用量"); return; }
  api("/api/cost?dir=" + encodeURIComponent(dir)).then(function (r) {
    clearStream();
    var card = newCard("用量时间线 · " + dir);
    var calls = (r && r.calls) || [];
    if (r && r.summary) cardFoot(card, String(r.summary).replace(/\\n/g, " · ").slice(0, 200));
    calls.slice(0, 40).forEach(function (c) {
      appendFact(card, { t: "ctx", expert: c.track || "?", session: String(c.chars || 0) + " 字", turn: c.tokens != null ? c.tokens : 0, ctx: c.tokens || 0, window: 0 });
    });
    if (!calls.length) appendFact(card, { t: "notice", tone: "info", text: "本次运行没有模型调用记录（scripted 剧本车道不经过网关）" });
  });
}

/* ---- 审批 ---- */
function refreshApprovals() {
  api("/api/approvals").then(function (r) {
    var pend = (r && r.pending) || [];
    var box = $("appr");
    $("apprTx").textContent = pend.length ? "待批 " + pend.length : "常规";
    $("chipAppr").className = "chip" + (pend.length ? " hot" : "");
    if (!pend.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    pend.forEach(function (p) {
      var d = document.createElement("div"); d.className = "bar";
      d.innerHTML = "<span>⚠ 请求 <b>" + esc(p.capability) + "</b> · " + esc(short(p.action || p.detail || "", 80)) +
        "</span><span class='grow'></span>";
      var b1 = document.createElement("button"); b1.className = "ok"; b1.textContent = "允许一次";
      b1.onclick = function () { decideApproval(p.id, true, false); };
      var b2 = document.createElement("button"); b2.textContent = "本会话允许";
      b2.onclick = function () { decideApproval(p.id, true, true); };
      var b3 = document.createElement("button"); b3.className = "no"; b3.textContent = "拒绝";
      b3.onclick = function () { decideApproval(p.id, false, false); };
      d.appendChild(b1); d.appendChild(b2); d.appendChild(b3);
      box.appendChild(d);
    });
  }).catch(function () { /* 服务离线：静默 */ });
}
function decideApproval(id, allow, always) {
  api("/api/approvals", { id: id, allow: allow, always: always }).then(function () {
    hint(allow ? "已放行 " + id : "已拒绝 " + id);
    refreshApprovals();
  });
}

/* ---- 发送流 ---- */
function setRunning(on) {
  state.running = on;
  $("send").hidden = on; $("stop").hidden = !on; $("inp").disabled = false;
  renderSb();
}
function startTeam(task) {
  pushUser(task);
  var card = newCard("监督回路 · " + short(task, 40));
  cardSt(card, "启动…");
  state.teamCard = card;
  ssePost("/api/run-stream", { task: task, model: state.model }, function (ev, d) {
    if (ev === "open") { state.ticketId = (d && d.ticketId) || 0;
      if (d && d.queued) cardSt(card, "排队中（前一轮运行中）· Esc 可取消"); }
    else if (ev === "start") cardSt(card, "运行中…");
    else if (ev === "card") appendFact(card, d && d.fact);
    else if (ev === "done") {
      cardSt(card, d && d.ok === false ? "异常结束" : "完成");
      if (d) cardFoot(card, "ok=" + (d.ok === false ? "false" : "true") + (d.outDir ? " · " + d.outDir : ""));
      loadRuns(); loadStatus();
    } else if (ev === "error") {
      cardSt(card, "失败");
      appendFact(card, { t: "notice", tone: "err", text: (d && d.message) || "引擎失败" });
    }
  }, function (doneSeen) {
    if (!doneSeen) appendFact(card, { t: "notice", tone: "warn", text: "SSE 连接中断（未收到 done）" });
    setRunning(false);
  });
}
function startDirect(q) {
  if (!state.currentExpert) { hint("请先在左栏选择专家（直连模式）"); return; }
  pushUser(q);
  var card = newCard("直连 · " + state.currentExpert);
  cardSt(card, "启动…");
  ssePost("/api/ask-stream", { expert: state.currentExpert, question: q,
    session: state.currentSession || undefined, model: state.model }, function (ev, d) {
    if (ev === "open") { state.ticketId = (d && d.ticketId) || 0; }
    else if (ev === "start") cardSt(card, "生成中…");
    else if (ev === "stage") { if (d && (d.stage || d.text)) cardSt(card, String(d.stage || d.text)); }
    else if (ev === "log") { appendFact(card, { t: "notice", tone: "info", text: String((d && (d.line || d.text)) || "").slice(0, 160) }); }
    else if (ev === "done") {
      cardSt(card, "完成");
      var ans = d && (d.answer != null ? d.answer : "");
      if (ans) pushAgentMd(String(ans));
      if (d) cardFoot(card, (d.tokens != null ? "tokens " + d.tokens + " · " : "") + (d.durationMs != null ? fmtMs(d.durationMs) : ""));
    } else if (ev === "error") {
      cardSt(card, "失败");
      appendFact(card, { t: "notice", tone: "err", text: (d && d.message) || "生成失败" });
    }
  }, function (doneSeen) {
    if (!doneSeen) appendFact(card, { t: "notice", tone: "warn", text: "SSE 连接中断（未收到 done）" });
    setRunning(false); loadStatus();
  });
}
function send() {
  var text = $("inp").value.trim();
  if (!text || state.running) return;
  $("inp").value = ""; autoGrow();
  setRunning(true);
  if (state.mode === "team") startTeam(text); else startDirect(text);
}
function abortRun() {
  api("/api/abort", state.ticketId ? { id: state.ticketId } : {}).then(function () { hint("已请求停止"); });
}
function hint(t) { $("hint").textContent = t || ""; }
function autoGrow() {
  var el = $("inp"); el.style.height = "auto";
  el.style.height = Math.min(190, Math.max(44, el.scrollHeight)) + "px";
}

/* ---- rail / about ---- */
function switchSec(sec) {
  ["chat", "runs", "tasks"].forEach(function (s) {
    $("sec" + s.charAt(0).toUpperCase() + s.slice(1)).className = "sec" + (s === sec ? " on" : "");
  });
  ["rbChat", "rbRuns", "rbTasks"].forEach(function (id) {
    $(id).className = "rb" + (id === "rb" + sec.charAt(0).toUpperCase() + sec.slice(1) ? " on" : "");
  });
  if (sec === "runs") renderRuns();
  if (sec === "tasks") renderTasks();
}
function showAbout() {
  clearStream();
  var card = newCard("关于 org");
  appendFact(card, { t: "notice", tone: "ok", text: "v" + VERSION + " · Organization Harness · HSL BNF v1.5.0 · 单文件分发（零外链）" });
  appendFact(card, { t: "notice", tone: "info", text: "v5 全新 UI（从零重写）：rail+三栏 · composer 内联 chip · 审批接管 · 一行状态栏" });
  appendFact(card, { t: "notice", tone: "info", text: "更新要点见 CHANGELOG；设计约束：check-ui-tokens（--fs-* 六档 / 色值 token 化）" });
  cardSt(card, "v" + VERSION);
}

/* ---- 数据装载 ---- */
function loadStatus() {
  return api("/api/status").then(function (r) {
    if (!r) return;
    state.experts = r.experts || [];
    state.usages = r.usages || [];
    if (r.model) state.model = r.model;
    if (!state.currentExpert && state.experts.length) state.currentExpert = state.experts[0].name;
    renderExperts(); renderSb(); crumb();
    if (state.currentExpert && !state.sessions.length) loadSessions();
  }).catch(function () {});
}
function loadSessions() {
  if (!state.currentExpert) return;
  api("/api/sessions?expert=" + encodeURIComponent(state.currentExpert)).then(function (r) {
    state.sessions = (r && r.sessions) || [];
    renderSessions();
  }).catch(function () {});
}
function loadRuns() {
  api("/api/runs").then(function (r) {
    state.runs = (r && r.runs) || [];
    renderRuns();
  }).catch(function () {});
}
function loadProviders() {
  api("/api/providers").then(function (r) {
    var sel = $("chipLane"); sel.innerHTML = "";
    var names = ["scripted"];
    ((r && r.rows) || []).forEach(function (x) {
      var n = x.name || x.id || x.label;
      if (n && names.indexOf(n) < 0) names.push(n);
    });
    if (names.indexOf(state.model) < 0) names.push(state.model);
    names.forEach(function (n) {
      var o = document.createElement("option"); o.value = n; o.textContent = n;
      if (n === state.model) o.selected = true;
      sel.appendChild(o);
    });
  }).catch(function () {});
}

/* ---- 交互接线 ---- */
$("rbChat").onclick = function () { switchSec("chat"); };
$("rbRuns").onclick = function () { switchSec("runs"); };
$("rbTasks").onclick = function () { switchSec("tasks"); };
$("rbAbout").onclick = function () { showAbout(); };
$("newAsk").onclick = function () { state.currentSession = null; renderSessions(); crumb(); clearStream(); hint("新会话"); };
$("chipMode").onclick = function () {
  state.mode = state.mode === "team" ? "direct" : "team";
  $("modeTx").textContent = state.mode === "team" ? "团队" : "直连";
  $("chipMode").className = "chip" + (state.mode === "team" ? " hot" : "");
  crumb(); renderSb();
};
$("chipLane").onchange = function () { state.model = this.value; renderSb(); };
$("chipAppr").onclick = function () { refreshApprovals(); hint("审批队列已刷新"); };
$("send").onclick = send;
$("stop").onclick = abortRun;
$("btnCost").onclick = showCost;
$("sbCtx").onclick = showCost;
$("inp").addEventListener("input", autoGrow);
$("inp").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && state.running) abortRun();
});

/* ---- boot ---- */
loadStatus().then(function () { loadProviders(); });
loadRuns();
refreshApprovals();
setInterval(refreshApprovals, 5000);
setInterval(renderSb, 10000);
setInterval(function () { if (!state.running) loadStatus(); }, 15000);
</script>
</body>
</html>`;
}
