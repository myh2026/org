<div align="center">

# ORG — Organization Harness

**基于 HSL 的组织化多智能体系统 · 子智能体可生成、可验收、可复用、可演进**

[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-v0.4.10_可运行-brightgreen.svg)](https://github.com/myh2026/org/releases)
[![Platforms](https://img.shields.io/badge/platform-Windows_%7C_macOS_%7C_Linux-teal.svg)](#-快速开始v042-实测可用)
[![Built on HSL](https://img.shields.io/badge/built_on-HSL-blue.svg)](https://github.com/myh2026/harness-specification-language)
[![BNF](https://img.shields.io/badge/BNF-v1.5.0-blue.svg)](https://github.com/myh2026/harness-specification-language/blob/main/toolchain/hsl-spec/BNF.md)
[![Tests](https://img.shields.io/badge/tests-128_passing-brightgreen.svg)](#-测试)
[![CI](https://github.com/myh2026/org/actions/workflows/ci.yml/badge.svg)](https://github.com/myh2026/org/actions/workflows/ci.yml)
[![Release](https://github.com/myh2026/org/actions/workflows/release.yml/badge.svg)](https://github.com/myh2026/org/actions/workflows/release.yml)

</div>

---

> **一句话定位**：现有框架把子智能体当作一次性函数——任务结束即销毁，不留任何资产；ORG 把子智能体当作**工程资产**管理——结构用 HSL 描述、生成经编译期校验与 fixture 验收、任务结束沉淀回库，使系统能力随使用持续增强。

> **当前状态**：v0.4.9 可运行实现。新增 **Web GUI 工程化重设计（`org web`：Codex 风终端美学 —— 近黑 zinc · 等宽 chrome · tmux 式状态栏 · `❯` 转写行 · run log 终端窗口；正常 Agent 功能补全：停止生成 `POST /api/abort`（SIGKILL 子进程，该轮不落账本）、会话删除/重命名端点、失败重试、导出 Markdown、模型切换、智能滚动）**；**Web GUI 对话流式（`POST /api/ask-stream` SSE：open/start/stage/log/done 事件链，子进程 stdout 逐行实时推送）**；**Web GUI 原型（`org web`：Bun.serve 零依赖单页驾驶舱 —— 专家卡 + 会话侧栏 + 对话视图 + 观测元数据 tokens/耗时/ctx 窗口计量；scripted 占位剧本秒回）**；**B 路径执行面（导入 harness 被任务派单真实执行：注册表登记优先寻址 + 工单序列化卫生 + deliverable 交付物契约）**；**剧本联动（导入即能用：`org import` 自动生成占位剧本，`org ask` / `org handoff` 剧本自动发现 —— 零参数直连，`--model deepseek` 换真实回答）**；**工具库治理三动作：导入你自己的 harness（`org import`）+ 选取保留（`org keep` / `org drop`）** —— 工厂产出是候选，用户选取转正后才参与 B 路径自动复用，导入即保留即刻可复用，动作进 git 账本；直连会话新增 **上下文窗口计量（Codex 风格 meter，`[ctx]` 每轮可见）**。另有 **OpenCode 级终端前端（`org tui`）** 与 **Windows/macOS/Linux 五目标单二进制分发**（无 bun 环境全功能）。信封契约、主控监督回路、工厂闸门（真实 `dhv check` + fixture 验收）、池化（轻档）、多轮直连 + 暖移交、三档补丁（知识 / 流程 / 能力变更）、影子晋升（金丝雀双跑）、静默更新检测、N 版本冗余、评分卡归因（客观档 + 裁判档）、固化管线（精确匹配档 + 自动降级）全部落地，由 128 个机制级测试逐条验证（`bun test`），全叙事可复现（`org demo`，约 2s）。仓库采用「源码（`hsl/`）+ 编译产物（`dist/`，入库）+ CI/CD（GitHub Actions：check / 测试 / 三连跑冒烟 / 产物回写 / tag 发布）」布局。路线图后半段见[实施路线图](#-实施路线图)与[已知边界](#%EF%B8%8F-已知边界诚实声明)。

## ✨ 为什么是 ORG

现有 Agent 框架回答的是「怎么派一个子任务」，ORG 回答的是「怎么让子智能体成为可积累的组织能力」。它把四件通常散落在框架约定、提示词工程和人工经验里的东西，收进一个可校验的系统：

- **专家是流程，不是人设** —— 现有 sub-agent 体系的「专家」= 通用 ReAct 循环 + 系统提示词 + 工具白名单，只贡献人设不贡献流程。ORG 用 HSL `graph` 把专家的标准作业程序形式化为可校验的拓扑：node 是物理依赖、edge 是带守卫的消息通道、循环是有穷尽性要求的程序结构。主控与子智能体之间不再共用同一套运行时约定，只对齐类型化接口。
- **生成必须过闸门** —— 「现场生成一个智能体」在无验收体系的框架里等于把未经检查的代码直接上线。ORG 的生成管线规定：LLM 产出的 `.hsl` 源码必须先通过 `dhv check`（S 严格性 / G 拓扑 / P 投射铁律），再通过 scripted fixture 行为验收，才能注册上岗。机器生成的机器代码，第一次拥有确定性的质量闸门。
- **权限是编译期与审计事件的组合** —— `#[capability(...)]` 注解使最小权限原则在编译期可执行；运行期的临时授权、直连访问、能力变更全部作为审计事件记录。委托关系不再依赖提示词自觉，而是可检查、可追溯的工程约束。
- **任务结束是资产沉淀的开始** —— 每个任务都可能留下多类资产：新专家、验收 fixture、任务记忆、补丁记录。同样的任务第二次到来时，成本结构与第一次完全不同。系统的核心竞争力不在单次执行的聪明程度，而在资产层的增长率。
- **成熟流程固化为代码** —— 运行时把输出长期稳定的判定节点冻结为纯 HSL 函数（带自动降级通道），专家的单位成本随成熟度递减。agent 不只是会写代码，它会随着被使用而逐渐变成代码——HSL 是这个过程的编译目标。

## 🔁 完整流程图

```mermaid
%%{init: {
  "theme": "base",
  "themeVariables": {
    "primaryColor": "#EFF6FF",
    "primaryBorderColor": "#3B82F6",
    "primaryTextColor": "#1E293B",
    "lineColor": "#94A3B8",
    "fontSize": "14px",
    "fontFamily": "-apple-system, BlinkMacSystemFont, PingFang SC, 'Noto Sans SC', SimHei, sans-serif"
  },
  "flowchart": { "curve": "basis", "padding": 24, "nodeSpacing": 50, "rankSpacing": 60, "htmlLabels": false }
}}%%
flowchart TB
    USER["用户 · 总线一等节点 · 信任链的根"]

    subgraph SUP["监督回路 · 主控 HSL graph（事件驱动，不阻塞等待）"]
        direction TB
        DEC["① 任务分解"] --> RTE["② 路由决策"]
        RTE --> SUPV["③ 过程审查<br/>合同对照 · 四态裁决"]
        SUPV --> AGG["④ 汇总输出"]
    end

    subgraph ASSETS["资产层"]
        REG["专家库 · git 注册表<br/>manifest / 类型签名 / 评测分 / 版本"]
        POOL["智能体池 · 有状态实例<br/>记忆 / 私有 fixture / 多会话"]
        SCORE["模型评分卡 · 模型版本×能力轴×任务类<br/>证据归因 · 金丝雀确认"]
    end

    subgraph FAC["专家工厂 · 生成与验收管线"]
        direction LR
        SPEC["规格提取"] --> GEN["HSL 生成"] --> CHK["dhv check<br/>S/G/P 铁律"] --> EXAM["fixture 验收"] --> REGN["入库登记"]
    end

    PATCH["补丁提案 · 审查反馈复发时自动升级"]
    CRYST["固化 · 稳定判定节点冻结为纯函数（带降级通道）"]

    USER -->|"团队模式"| DEC
    USER -->|"直连模式<br/>记账 + 事后纪要"| POOL
    RTE -->|"A 内联处理"| SUPV
    RTE -->|"B 复用现有"| REG
    RTE -->|"C 现场生成"| SPEC
    RTE -->|"D 暖移交"| POOL
    REG -->|"装配实例"| POOL
    POOL -->|"契约化派单"| SUPV
    SUPV -->|"Revise / Reject（有界返工）"| POOL
    SUPV -->|"Escalate 仲裁"| USER
    SUPV -->|"收货"| AGG
    AGG -->|"结果"| USER
    REGN --> REG
    PATCH --> SPEC
    SUPV -.->|"同一意见复发"| PATCH
    POOL -.->|"会话纪要回写"| SUPV
    SUPV -.->|"行为证据归因"| SCORE
    SCORE -->|"能力需求匹配"| POOL
    POOL -->|"判定节点稳定观测"| CRYST
    CRYST -->|"fixture 验收后入库"| REG

    classDef user fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#1E293B
    classDef sup fill:#EFF6FF,stroke:#3B82F6,stroke-width:2px,color:#1E293B
    classDef asset fill:#F5F3FF,stroke:#8B5CF6,stroke-width:1.5px,color:#1E293B
    classDef fac fill:#F0FDF4,stroke:#10B981,stroke-width:1.5px,color:#1E293B
    classDef patch fill:#FEF2F2,stroke:#EF4444,stroke-width:1.5px,color:#1E293B
    classDef score fill:#FFFBEB,stroke:#F59E0B,stroke-width:1.5px,color:#1E293B
    classDef cryst fill:#F0FDFA,stroke:#14B8A6,stroke-width:1.5px,color:#1E293B

    class USER user
    class DEC,RTE,SUPV,AGG sup
    class REG,POOL asset
    class SPEC,GEN,CHK,EXAM,REGN fac
    class PATCH patch
    class SCORE score
    class CRYST cryst

    style SUP fill:#FFFFFF,stroke:#94A3B8,stroke-width:1.5px
    style ASSETS fill:#F8FAFC,stroke:#64748B,stroke-width:1.5px
    style FAC fill:#ECFDF5,stroke:#10B981,stroke-width:1.5px
```

怎么读这张图：**蓝色管线是监督回路（主控的四个阶段），紫色是资产层（库与池），绿色是工厂管线（生成与验收），红色是补丁通路，琥珀色是模型评分卡与证据归因，青色是固化通路。** 用户既是团队模式的委托方，也可以经直连通道直接访问池中专家；工厂同时服务两条生产线——新专家生成与老专家补丁，共用同一道验收闸门；监督回路的行为证据持续归因到评分卡，评分卡反过来决定池中实例的模型匹配。

### 一次典型任务的走读（v0.4.5 已可复现，`org demo`）

1. 用户下达任务：「抓取某站点近一周公告，输出结构化表格」；
2. 主控分解为 检索 / 解析 / 校验 三个子任务，**随即**向用户发出澄清问题（输出格式、字段偏好）——人类思考时间与机器执行时间重叠，而非串行；
3. 路由：检索子任务琐碎且强依赖主控上下文 → **A 内联**；解析子任务在专家库命中 → **B 复用** notice-parser；校验子任务无匹配专家 → **C 现场生成**，生成物通过真实 `dhv check`（结构铁律）与 fixture 验收（行为闸门）后注册入池；
4. 派单契约先行：每份工单写明交付物规格、验收标准、预算水位与返工上限；
5. 主控过程审查发现校验专家覆盖不足，四态裁决为 `Revise`——在早期拦截，而不是汇总后发现全量返工；
6. 任务结束：**新专家以「候选」身份沉淀（retained=false）**；**用户选取保留**（`org keep`，演示中 scripted 自动选取）→ 候选转正进 git 账本；验收样本、固化 memo 一并沉淀（git 注册表提交留痕）；
7. **第二次同类任务**（run B）：校验专家（已转正）直接复用（零工厂成本）；解析专家的日期归一化判定节点持续命中 memo（模型调用 5 → 1）；「覆盖不足」审查意见复发两次 → 自动升级为**补丁提案**，经 check + smoke 闸门合入 record-validator@1.0.1（git 留痕）；
8. **第三次同类任务**（run C）：判定节点 5/5 全命中（**零模型调用**）；补丁版专家首验即收（**零返工**）——蓝绿发布生效，系统单位成本随使用递减。

实测数据（scripted 模式，约 2s 全叙事）：model_calls 衰减 **5 → 1 → 0**，返工 **1 → 1 → 0**，git 注册表四个提交（template → mint → **keep（用户选取）** → patch）即资产层的增长率账本；另有多轮直连（2 轮问答、记账、会话账本、**每轮 `[ctx]` 上下文窗口计量条**）与暖移交（移交摘要 + 专家代答）两个通道产物。

## 🖥️ 组织驾驶舱（TUI）——OpenCode 级终端前端

`org tui` 打开三区布局的产品级终端界面（零依赖自研渲染器，规格见 [docs/tui-spec.md](docs/tui-spec.md)）：

```
╭ ORG — Organization Harness ────────────────────────────── v0.4.5 ╮
│  ▾ 会话 (5)          │  org 任务分解 → 3 子任务                       │
│    ● 抓取某站点近…    │     ├ task#1 fetch   [A 内联] ✓               │
│    ○ (direct) 多轮…  │     ├ task#2 parse   [B 复用] notice-parser ✓  │
│  ▾ 专家库 (2)        │     └ task#3 validate [C 生成]                 │
│    ◆ notice-parser   │                                               │
│    ◆ record-valida…  │  ⚙ 工厂  规格 → 生成 → ✓check → ✓验收 → 登记git │
│  ▾ 池与固化          │                                               │
│    池    idle 2      │  ◆ review [Revise] · 覆盖率 0.80 < 0.95        │
│    固化  冻结0·命中5  │  ◆ review [Accept] · coverage 1.00            │
│    memo 3 条冻结映射  │  ✓ 汇总  交付物 3 · model_calls 5→1→0          │
├─ › 输入任务或 :命令…          团队模式 · scripted · idle ─────────────┤
╰──────────────────────────────────────────────────────────────────────╯
```

- **事件卡片流**：任务分解（A/B/C/D 路由徽标四色）· 工厂五步 stepper · 四态裁决徽标
  （Accept 绿 / Revise 琥珀 / Reject 红 / Escalate 紫）· 固化（❄冻结 ⚡命中）· 补丁
  （版本 bump + git sha + 金丝雀确认）· 用户选取（★ 保留 / ○ 候选）· 直连 · 完成卡
  （成本衰减 5→1→0）· 系统卡；
- **输入协议**：任务回车派单（团队模式）· `?专家 问题?` 直连 · `:demo` 全叙事演示 ·
  `:keep <name>` / `:drop <name>` / `:import <file.hsl>` 工具库治理（keep/drop 无参作用于专家栏选中项；
  import 为 check 闸门 → 入库即保留可复用）·
  `:replay out-…` 历史会话秒开重演（不重跑引擎）· `:filter 任务|分解|工厂|裁决|直连|汇总|动态`
  事件流过滤（视图偏好，不随 run 重置）· `:score :theme :status :clear :help :quit`；
- **三主题**（org-dark / org-light / paper）· 窄终端降级 · 帮助浮层（`?`）· 运行取消（Esc）；
- **键盘**：Tab 切换分区 · j/k 移动 · g/G 回顶回底 · Ctrl+L 清屏 · Ctrl+C 退出；
- 实现与规格：`tui/`（零依赖 Line/Span 渲染器 + useReducer 单 store），
  冒烟测试 `bun run tui:smoke`（离屏 20 断言，CI 无 TTY 可跑）。

## 🌐 Web GUI —— `org web`（Codex 风终端美学）

`org web` 起零依赖轻量 HTTP（Bun.serve，默认端口 4600，`--port N` 覆盖），
单页内联 HTML（无静态文件 / 无第三方依赖，原生 fetch 交互）。设计语言参考
OpenAI Codex CLI 的终端美学：**安静、致密、可工程信任** —— 近黑 zinc 色板 +
1px 发丝边框 + 等宽 chrome（标签/元数据/状态栏）+ tmux 式底部状态栏 + `❯`
提示符转写行（无气泡）+ 运行日志终端窗口；无渐变无辉光，emerald 是唯一功能
色（运行/在线），琥珀仅作状态栏品牌微标记。GUI 只是薄渲染层 —— 逻辑全部
复用 CLI 同一代码路径：

```
┌ org · v0.4.9 · /…/demo-run ─────────── experts 3 · 12 turns ──┐
│ SESSIONS            │ ❯ 写一首关于秋夜湖面的四行现代诗          │
│  + 新会话            │ org · poet · turn 1 · 19 tok · 48 ms     │
│  sprint-42 · 2 轮   │ 月光在湖面铺开银箔，                     │
│  default · 1 轮     │ 几片落叶，轻点涟漪，                     │
│ EXPERTS             │ ▸ run log 12 行                          │
│  poet @0.1.0 import │ ┌────────────────────────────────────┐  │
│  notice-parser@1.0  │ │ ❯ 输入问题…（enter 发送 · esc 停止）│  │
│  record-validator…  │ │ [scripted|deepseek]        [发送]  │  │
└─────────────────────┴─┴────────────────────────────────────┴──┘
 org · expert poet · model scripted · session sprint-42 · ○ idle
```

- **转写式消息流**：用户消息 = `❯` 提示符行；助手消息 = `org · 专家 ·
  turn · tokens · 耗时` 元信息行 + 正文 + run log 终端窗口（`▸` 折叠展开
  · 行计数徽标）；运行中 = braille 旋转 + 流水线阶段行 + 逐行实时日志；
- **正常 Agent 功能面**：停止生成（`POST /api/abort` SIGKILL 子进程，该轮
  不落账本，`Esc` 快捷键，空闲时人话拒绝）· 失败重试（错误块按钮，失败轮
  不落账本安全重发）· 会话重命名（行内编辑，`PATCH` mv 账本）· 会话删除
  （两步确认，`DELETE` 删账本文件）· 导出会话 Markdown · 模型切换
  （scripted/deepseek 分段控制）· 智能滚动（底部跟随 + 「回到最新」）·
  空态终端 banner（engine/workspace/expert/session/快捷键一览）；
- **只读端点**：`GET /api/status`（专家清单 + 会话上下文占用 + 服务级
  model，与 `org status` 同数据源）· `GET /api/sessions?expert=X` ·
  `GET /api/session/<E>/<S>`（逐轮 question/answer/tokens/ctx_tokens，
  账本健壮解析：记录边界重组 + 修复式正则，兼容存量坏账本）；
- **交互端点**：`POST /api/ask`（JSON 整轮，兼容并存）· `POST
  /api/ask-stream`（SSE 流式：`open`（排队状态回显）→ `start` → `stage*`
  （2.6s 轮换 direct.hsl 真实阶段）→ `log*`（子进程 stdout 逐行实时）→
  `done`/`error{aborted?}`；客户端意外断开不中止运行，显式停止走
  `/api/abort`）· `DELETE/PATCH /api/session/<E>/<S>`（会话管理）·
  `POST /api/abort`（停止生成）；
- **model 回落链**：请求体显式传 > 服务级（`org web --model deepseek`）>
  scripted —— GUI 分段控制即请求体逐次覆盖；
- **deepseek 网关路由（v0.4.10）**：`org web --gateway http://127.0.0.1:3030/v1`
  （或环境变量 `DHV_LLM_GATEWAY`）把 `$host.llm` 指向 OpenAI 兼容端点 ——
  独立部署无需本机装 z-ai-web-dev-sdk；未配置时真实模型车道人话报错；
- **实现**：`web/entry.ts`（进程内 import，与 tui 同模式；`startWebServer`
  可编程入口供测试用随机端口）；服务只听 127.0.0.1，expert/session 名
  白名单校验（防路径穿越）；测试 `bun test tests/web.test.ts`（24 用例）；
- 路线图第 4 点（事件总线 WebSocket 拓扑观测）见 issue #10，未做。

## 📦 三平台单二进制分发（Windows / macOS / Linux）

```bash
# 下载对应平台产物（GitHub Release）解压，放入 PATH：
org            # 打开组织驾驶舱（TUI）
org demo       # 全叙事演示（无 bun 环境同样可跑）
org check      # 结构闸门全量校验
```

- **5 目标交叉编译**：`bun-linux-x64 / bun-linux-arm64 / bun-darwin-x64 / bun-darwin-arm64 /
  bun-windows-x64`（`bun build --compile`，GitHub Actions 矩阵产出，见 release.yml）；
- **运行时资源内嵌**：hsl 源码 + vendored dhv-ts 解释器 + 工作区模板 + fixture 剧本打包为
  `build/payload.json`（55 文件 / 934KB）随二进制分发，运行期按内容指纹解包到
  `~/.org/runtime-<sha1>/`（升级自动换新目录，`ORG_RUNTIME` 可重定向）；
- **无 bun 环境全功能**：vendored dhv-ts 暴露 `cliMain` 可编程入口，宿主新增
  `$host.dhv.{check,run}` 进程内兜底——工厂闸门在无 bun 机器上自动切换进程内车道
  （bun 在场仍走嵌套子进程，蓝绿语义不变）；实测无 bun 单二进制 `check 30/30` +
  全叙事 `demo` 完整通过；
- 默认工作区：二进制 `~/.org/workspace`（源码模式仍为仓库内 `demo-run/`）。

## 🏗️ 架构总览（六大部件）

| 部件 | 职责 | 关键机制 | v0.1.0 |
|:---|:---|:---|:---|
| **主控（编排与监督）** | 分解、路由、审查、汇总 | 事件拓扑（microkernel）；批量澄清早发；任务契约先行 | ✅ hsl/org.hsl |
| **路由器** | 每个子任务四选一 | 类型兼容静态可查；纯函数判定 | ✅ hsl/router/policy.hsl |
| **专家库（Registry）** | 磁盘资产，不占运行时资源 | git 注册表；manifest 索引；能力交集 + 语义粗排检索 | ✅ hsl/registry/manifest.hsl |
| **专家工厂（Factory）** | 新品生成 + 补丁合入，同一闸门 | 提取 → 生成 → dhv check → fixture 验收 → 登记 | ✅ hsl/factory/pipeline.hsl |
| **智能体池（Pool）** | 运行中的有状态实例 | 生命周期状态机；双执行车道（进程内/嵌套=蓝绿） | ✅ 轻档 hsl/pool/lifecycle.hsl |
| **直连前台** | 用户可寻址池内专家 | 记账 + 纪要回写 + 会话账本强制执行 | ✅ 多轮 + 暖移交 hsl/pool/direct.hsl · handoff.hsl |

### 主控与监督回路

**主控是全系统唯一手写、唯一不经工厂管线的组件——它是内核。** 主控是一个 HSL `graph`，监督回路的四个阶段以事件拓扑组织（`registry → pool → policy → pool → journal → {pool, scorecard}`，环上全部带 on Guard）。

监督的核心机制是**任务契约**：派单前先写明交付物规格、验收标准、预算水位、返工上限与升级路径。审查因此成为「对照验收标准的有限动作」而非全程盯守，裁决为四态：

```
Accept（收货） │ Revise{意见}（返工，计一次） │ Reject{理由}（重派） │ Escalate（提交用户仲裁）
```

审查**客观闸门先行**（结构性优先于裁判）：预算遵守与覆盖率线是机械判定，只有机械闸门通过才进入语义裁决（模型对照验收标准）。审查只读**结构化状态报告**——契约是类型化结构，执行方无法把原始流水账塞进去，类型系统本身在强制摘要。

### 路由：四条路径

| 路径 | 适用条件 | 成本特征 |
|:---|:---|:---|
| **A 内联处理** | 琐碎任务、强依赖主控上下文 | 最低，无派单开销 |
| **B 复用现有** | 库中有类型兼容、语义匹配的专家 | 摊销成本，随复用次数递减 |
| **C 现场生成** | 库中无匹配，且任务具备复用价值 | 生成 + 验收为一次性成本，完成后转为资产 |
| **D 暖移交** | 用户新请求落在既有专家职责内且规模小 | 一份上下文移交摘要的成本 |

v0.1.0 补充一条工程事实：**C 路径是记忆化的**——注册表已有该专家时返工重派直接走磁盘车道，不重跑工厂（mint 的一次性成本由注册事实记忆）。

### 专家库（Registry）

库是磁盘上的资产层，形态为 **git 仓库作注册表**：版本管理、diff 审计、协作分享复用现有工具链，不发明新基建。每个专家条目六字段：

| manifest 字段 | 说明 |
|:---|:---|
| `interface` | graph 签名（信封契约，见下） |
| `capabilities` | 能力标签（与 `#[capability]` 注解对应） |
| `eval` | fixture 验收记录与评测分（补丁合入不得回退） |
| `version` | 语义版本 + 绑定的 BNF 版本（语言演进的漂移检测） |
| `stats` | 使用次数、裁决通过率、生成来源（工厂 / 人工 / 导入） |
| `provenance` | 补丁历史：每次变更的触发原因（对应哪次审查反馈） |

**工具库治理（v0.4.4）三动作**：

- **`org import <file.hsl>`（导入你自己的 harness）**：check 闸门（坏 harness 拒绝入库）→
  复制入 `registry/harnesses/<name>.hsl` → 注册 `source=import · retained=true`（导入即保留，
  B 路径自动复用立即可用）→ git 留痕（`import <name>@0.1.0 (user harness)`）。元数据自动
  提取：描述取文件首个 `///` 文档注释，能力取 `#[capability(…)]` 注解扫描；`--name / --description /
  --capability` 可显式覆盖。TUI 同构命令 `:import <file.hsl>`。
- **`org keep`（选取保留）**：工厂产出的新专家默认是**候选**（`retained=false`）——注册在库但不
  参与 B 路径自动复用；用户选取保留后转正。选取动作进 git 账本（`(user curation)` 提交，与
  mint / patch / import 同链）。
- **`org drop`（取消保留）**：再次失联（显式寻址与 C 路径记忆化派单仍可用）。

「哪些 harness 值得留下来」是用户的决策权，不是系统的默认行为——导入、选取、反悔全部
git 留痕，构成资产层的增长率账本。

**B 路径执行面（v0.4.6，导入 harness 被真实派单执行）**：`org import` 注册的 harness 不只
能直连问答——任务派单（`org run` / demo 全叙事）命中 B 路径（`find_reusable` 能力交集 +
语义亲和）时，**导入的 harness 经嵌套解释器车道真实执行**。派单寻址注册表登记优先
（`registry/harnesses/`，不再假设 `registry/experts/` 约定），补丁金丝雀 / N 版本冗余的
run 剧本同规则分相解析。磁盘车道信封契约（导入 harness 作者须知）：

- **输入**：`factory/current-spec.json` 工单（goal / acceptance / payload / feedback；
  payload 为字符串字段——上游交付物或 raw 材料原文，JSON 语义由 harness 自行判定）。
- **输出**：`$host.artifacts.write("acceptance.json", …)` 验收工件——`coverage`（0..1）、
  `summary`、`note` 之外可声明 **`deliverable` 字段**（如 parse 专家的记录数组 JSON）：
  交付物经 `work/parse-output.json` 机械编接流转下游子任务（缺省占位符 `(validation
  verdict artifact)`，不编造数据）。

**上下文窗口计量（v0.4.4，Codex 风格）**：直连会话每轮把全部历史织入提示词——上下文
占用随轮次单调增长，现在**可见**：每轮问答后打印 `[ctx] 窗口占用 ▓░░ 8.4k/131.0k（6.4%）`
计量条（GLM-4.5 窗口 128k tokens；chars/3 近似口径，非精确 tokenizer —— 诚实边界）；
会话账本记录 `ctx_tokens` 字段；`direct_ctx` 事件上总线（TUI 直连卡实时渲染 meter，
知情权不可绕）；`org status` 按会话汇总占用。

主控与专家之间的接口采用**信封契约**：外层统一为 `TaskSpec -> Result<Report, ExpertError>`（主控可无差别组合任意专家），payload 按领域自定义类型（专家保持表达能力）。全强类型会使生成端互相卡死，全自由文本会退化为黑盒，信封是两者的平衡点。

### 专家工厂（Factory）

工厂管线五步，全部可静态追踪，且**闸门是真的**（嵌套解释器子进程执行）：

```
规格提取 → HSL 源码生成 → dhv check → fixture 验收 → 入库登记（git commit）
```

- **`dhv check`**：S1–S8 严格性、G1–G6 拓扑、P 投射规则全量校验，结构不合格不允许进入下一阶段；
- **fixture 验收**：scripted 模式确定性重演，判定 = run.json ok **且** acceptance 覆盖率达标（验收语义 ≠ 执行语义——真实派单首轮低覆盖是合法的 Revise 语义）；
- **入库登记**：manifest 建档、评测分建档、git 提交版本记录。

工厂同时承接**补丁流水线**：主控审查中同一意见对同一专家复发两次，反馈自动升级为补丁提案，过闸门后合入——变更分级闸门（提议权与合入权分离）：

| 变更类型 | 改动对象 | 闸门 | v0.3.0 |
|:---|:---|:---|:---|
| 知识补丁 | 静态资源块 / 规则行 | `check` + smoke + 失败回滚 | ✅ |
| 流程补丁 | graph 拓扑关键词 | 全量 fixture 验收 + 评测分不得回退 | ✅ |
| 能力变更 | `#[capability]` 注解 | 审计事件，仅用户可批准（env 门） | ✅ |

**生成者与合入者分离**：主控（或任何 LLM）只有补丁提议权，按合并键的是验收管线（结构闸门不过即回滚）。运行中的专家实例不热改——补丁发布为新版本，在岗会话继续旧版，新派单自动加载新版（v0.1.0 的磁盘专家嵌套执行天然实现了蓝绿）。

### 智能体池（Pool）

池与库的区分：**库是磁盘上的档案（不占运行时资源），池是运行中的实例（占用并发额度）**。实例生命周期：

```
入编（工厂产出 / 外部导入） → 待命 → 派单（busy） → 审查 → 回到待命
```

- **双执行车道（v0.1.0 工程事实）**：静态专家（随 ORG 发行，进程内 import）走进程内车道；磁盘专家（minted / 补丁后）走嵌套解释器车道——每次从磁盘加载最新版，即蓝绿发布语义；
- **热启动**：实例携带固化 memo（跨运行持久化的观测账本 + 冻结映射）上岗，同类任务的第二次执行在速度与质量上均优于冷启动；
- **演进档位**：轻档 = manifest + 任务历史索引（已落地）；重档 = 私有记忆工作台（路线图，依赖语言层 `pool` / `session` 语义）。

### 用户直连

用户是事件总线上的**一等节点**。三条访问通道：团队模式（完整编排）、转接模式（暖移交，`org handoff`）、直连模式（多轮会话，`org ask --session --turns`）。治理原则：**调度权可绕，知情权与记账权不可绕**——直连事件上总线、花销记独立科目（direct-ledger）、结束后纪要回写主控（runtime/direct-memos.md）、会话账本跨轮持久（runtime/sessions/<expert>/<session>.jsonl）。权限跟随委托链：编排模式（用户缺席）confirm 态降级为拒绝；直连模式（用户在场）就地放行。**用户是信任链的根**：唯一可批准能力天花板上调的主体（`ORG_CAPABILITY_APPROVED=1` 环境门）。

### 外部平台兼容（adapters）

ORG 不要求生态迁移——外部智能体以**导入线**接入注册表（`hsl/adapters/bridge.hsl`）：

| 平台 | 文件格式 | 探测特征 | v0.3.0 |
|:---|:---|:---|:---|
| **Claude Code / Codex 式 subagent** | subagent JSON（name / description / tools / model） | `tools` + `model` | ✅ 导入登记 |
| **MCP**（Model Context Protocol） | MCP server manifest（name / instructions / tools） | `tools` + `instructions` | ✅ 导入登记 |
| **A2A**（Agent2Agent） | agent card（name / description / skills / url） | `skills` + `url` | ✅ 导入登记 |

v1 诚实边界：导入 = 注册表登记（manifest `source=import` + 能力标签 + 信封签名核对），每次导入是一条审计事件（知情权不可绕）；导入体的执行接线（协议翻译）是路线图项 —— 登记不等于在岗。

## ⚙️ 运行时动力学

### 固化管线（Crystallization）—— 精确匹配档 + 自动降级已落地

专家 graph 的节点分两类：**判定节点**（需要 LLM 的开放判断）与**机械节点**（确定性变换）。运行时持续记录判定节点的输入输出对：

- **固化条件（v1）**：规范化后的输入在 N 次观测中（跨运行持久化的观测账本）始终映射同一输出 → 冻结 input→output；
- **命中监控**：冻结入口的命中 / 未命中计数；命中率持续归因到评分卡；
- **降级是生命线**：冻结函数的命中率因输入分布漂移而下降时（热启动 + 命中率 < 0.4），自动解冻最旧键、并把**本轮新冻结的键回退到观测态**（漂移期间学习降速，防污染），记审计事件（`crystallize_degrade`）；
- **语义等价固化后置**：v1 仅支持规范化精确匹配（已知边界）。

固化改变了成本结构：**成熟流程的单位成本随复用次数递减**。实测：notice-parser 的日期归一化判定节点，三连跑的模型调用 **5 → 1 → 0**。

### 事件溯源与确定性重放

事件总线的全部事件 append-only 留痕（events.jsonl）+ 人可读期刊（journal.jsonl，按监督回路四阶段归类）。`org replay --run <dir>` 重演时间线；scripted 剧本即当时的模型响应录制——**确定性重放 = 日志 + 代码版本**。

### 模型能力评分卡（Scorecard）

每个模型版本一张卡：能力轴 × 任务类矩阵，每格 = 分数 + 置信度（样本量）；`evidence_count` 是跨运行的累计归因条数（`registry/scorecards/evidence-ledger.json` 增长账本），cells 分数始终是当期窗口聚合。**证据分级**是核心纪律——客观行为信号结构性优先于裁判打分：

| 证据 | 来源 | v0.3.0 |
|:---|:---|:---|
| fixture 考试通过率 | 工厂验收 | ✅ |
| Revise / Reject / Escalate 率 | 监督四态裁决 | ✅ |
| 契约预算遵守率 | 预算水位 | ✅ |
| 固化命中率 | 固化管线观测 | ✅ |
| 直连会话用户接受度 | 直连通道 | ✅ |
| 影子对比得分（裁判档，权重 0.5） | 晋升管线 | ✅ |
| 金丝雀确认 | 验收样本双跑 | ✅ |

### 影子晋升与 N 版本冗余 —— 已落地

- **影子晋升（金丝雀）**：补丁版本合入后，旧版本源码自动归档（`<name>@<from>.hsl`）；候选与在岗版本在验收样本上同输入双跑（产物目录隔离），`(ok, coverage, valid, total)` 全一致 → `canary_confirmed`；任一指标分歧 → `canary_rollback`（归档源写回 + manifest 降版）；
- **静默更新检测**：当期评分卡 vs 基线（`registry/scorecards/baseline-<model>.json`）逐格对比，劣化超阈值 → `score_drift_alert` 审计事件（诚实边界：任务分布漂移同样触发，告警需人工复核归因）；
- **N 版本冗余**（`ORG_REDUNDANCY>=2`）：向实现来源多样的专家对（不同 `source` / 不同 `version`）镜像派单，产出一致置信度加成，分歧记健康度事件（`redundancy_compare`；按执行计次——返工轮是第二次真实执行，同样触发对比）。

## ⚖️ 设计铁律

1. **调度权可绕，知情权与记账权不可绕。** 直连不是旁路：总线可见、预算入账、纪要回写，三者不可协商。
2. **权限跟随委托链。** 编排模式适用静态最小权限；用户亲自委托时适用用户自身的权限范围；能力天花板的调升只属于用户。
3. **天花板管缺席，确认管在场。** 用户不在场的执行用静态能力约束兜底；用户在场的执行用动态确认替代静态天花板。
4. **同一意见第二次出现，修专家本体，不是再退回一次。** 审查反馈的复发自动升级为补丁提案，进入与新品生成相同的验收管线。
5. **裁决者不自我裁决，主控是内核。** 主控可提案修改专家，不可修改自身的编排图与审查标准。
6. **客观证据结构性优先于裁判证据。** 审查的客观闸门（预算/覆盖率）先于语义裁决；评分卡行为信号权重高于裁判打分。

## 🆚 与现有方案的对比

| 维度 | 现有 sub-agent 体系 | ORG |
|:---|:---|:---|
| 子智能体本质 | 通用循环 + 提示词 + 工具白名单 | HSL graph：流程即拓扑，编译期校验 |
| 主子关系 | 共用同一运行时约定，黑盒调用 | 信封契约，类型签名即接口 |
| 新专家来源 | 人工预先编写 | 库检索优先，缺失时现场生成 |
| 生成物验收 | 无，运行时才发现问题 | `dhv check` + fixture 验收，不过不上岗 |
| 过程审查 | 结果导向，事后发现 | 契约对照，过程四态裁决，返工有界 |
| 任务结束 | 产出交付，执行体销毁 | 专家 / fixture / 记忆 / 补丁资产沉淀 |
| 权限控制 | 提示词约束为主 | capability 三态策略：编译期检查 + 审计事件 |
| 模型选择 | 单模型或人工指定 | 评分卡实测画像 × 节点能力需求 |
| 长期成本 | 随使用线性增长 | 固化使成熟流程的单位成本递减（实测 5→1→0） |
| 长期行为 | 不随使用变化 | 库与评测基准随使用增长，成本结构持续优化 |

## 🧬 与 HSL 的关系

ORG 是 [HSL（Harness Specification Language）](https://github.com/myh2026/harness-specification-language)的旗舰应用：主控、工厂管线、专家本体全部以 HSL 编写，运行于 dhv-ts 解释器。当前基于 **BNF v1.5.0**，不依赖未发布的语言特性。

开发过程中对 HSL 做了一次真实实测并回推了两项修复（详见 [BUGFIXES.md](BUGFIXES.md)）：`Vec::iter_mut` 与 `String::push(char)` 缺失于解释器内建方法面（check 过 / run 崩的静默断层）。

同时，ORG 的设计对 HSL 提出了演进需求（BNF v1.6 路线图）：`node user: Human` 人在环节点、`pool`/`session` 实例语义、并发原语、`#[expose]` 注解、G7 返工环有界、G8 失败拓扑穷尽、G9 预算可行性——把组织管理中的经验教训转化为拓扑校验规则。

## 📂 目录结构

```
org/
├── hsl/                          # ✦ HSL 源码（全部 .hsl 单列此层）
│   ├── org.hsl                   #   主控（内核）：监督回路 graph + main 入口 + 投射
│   ├── contracts/contract.hsl    #   信封契约：TaskSpec / StatusReport / 四态裁决
│   ├── router/policy.hsl         #   路由策略：A/B/C/D 四路径判定（纯函数）
│   ├── factory/                  #   pipeline.hsl（五步闸门 + 三档补丁合入）
│   │   └── stock/record-validator.hsl   # 生成物录制 + 人工抽查存档
│   ├── registry/                 #   manifest.hsl（schema + 检索）
│   │   └── experts/notice-parser.hsl    # 示例专家（固化演示）
│   ├── pool/                     #   lifecycle.hsl（状态机 + 双车道）
│   │   ├── direct.hsl            #     org ask：多轮直连（记账 + 会话账本 + 纪要回写）
│   │   └── handoff.hsl           #     org handoff：暖移交通道
│   ├── runtime/                  #   journal.hsl（事件溯源）· crystallize.hsl（固化 + 降级）
│   │   ├── promotion.hsl         #     金丝雀影子晋升 · N 版本冗余 · 静默更新检测
│   │   └── fixture-miner.hsl     #     journal→fixture：生产即出题
│   ├── models/scorecard.hsl      #   评分卡：证据归因聚合（客观档 + 裁判档）
│   ├── providers/model.hsl       #   模型网关：scripted / deepseek
│   ├── policy/capability.hsl     #   能力三态 + 预算水位 + 审计
│   ├── adapters/bridge.hsl       #   外部智能体导入（subagent / MCP / A2A）
│   ├── config/resources.hsl      #   提示词 / 判据 / 运行配置（block 静态资源）
│   ├── types/                    #   state.hsl · errors.hsl
│   └── probe/                    #   HSL 语言探针（含上游 bug 复现）
├── cli/
│   └── org.ts                    # org CLI：run / demo / ask / handoff / status / score / replay / check / tui
├── tui/                          # ✦ 组织驾驶舱（OpenCode 级终端前端，零依赖）
│   ├── main.tsx / entry.ts       #   入口（org tui 进程内复用同一入口）
│   ├── app.tsx / store.ts        #   主应用（键盘路由 + 引擎接线）/ useReducer 单 store
│   ├── frame.ts / renderer.ts    #   帧组合（纯函数）/ 零依赖 ANSI 渲染器
│   ├── theme.ts / text.ts        #   三主题 token 表 / CJK 宽度度量与折行
│   ├── components/               #   rail / thread / cards / input（纯函数渲染）
│   └── smoke.ts                  #   离屏冒烟（20 断言，CI 无 TTY 可跑）
├── lib/
│   ├── engine.ts                 #   引擎桥（CLI/TUI 共用）：dhvRun / startRun / 工作区扫描
│   └── root.ts                   #   运行时根解析（源码模式 / 单二进制解包）
├── tests/                        # 71 个机制级测试（结构闸门 / README 走读 / 动力学点火）
├── demo-ws/                      # 演示工作区模板（raw 公告 + 注册表模板）
├── fixtures/
│   └── run-notices.json          # 三连跑剧本（make-fixture.ts 产出）
├── scripts/
│   ├── make-fixture.ts           # 剧本生成器（轨道消费序列的工程化设计）
│   ├── setup-hsl.ts              # 工具链自动安装（vendored 优先，幂等）
│   └── build-bin.ts              # ✦ 三平台单二进制构建（payload 打包 + 5 目标交叉编译）
├── build/
│   └── payload.json              # ✦ 运行时资源包（构建期再生，随二进制内嵌）
├── toolchain/
│   └── dhv-ts/                   # ✦ 内嵌解释器（vendored；克隆即跑，零环境依赖）
├── dist/                         # ✦ 编译产物（提交入库）
│   └── demo/                     #   全叙事快照：out-{a,b,c,direct,handoff} / registry / runtime
│       └── git-chain.json        #   资产层 git 历史（嵌套 .git 不入库，链条以数据保存）
├── .github/workflows/
│   ├── ci.yml                    # CI：dhv check + bun test + tui:smoke + 三连跑冒烟 + dist 回写
│   └── release.yml               # CD：tag → 校验 → 5 平台二进制矩阵 → GitHub Release
├── docs/                         # 设计文档 / 走读
└── demo-run/                     # 本地构建目录（git 忽略；运行时工作区）
```

> **布局语义**：`hsl/` 是源码层（人写）；`dist/` 是编译产物层（机器生成，与源码同库演进——
> `org demo` 自动导出，CI 每次 push 再生回写）；`demo-run/` 是本地构建目录（含嵌套 git
> 注册表，不入库）；`toolchain/dhv-ts` 内嵌解释器 vendored 入库——克隆即得可校验完整状态：
> `bun cli/org.ts check` 直接全量模块过，无需任何环境准备。

## ⚡ 快速开始（v0.4.5 实测可用）

**终端用户（免环境）**：到 [Releases](https://github.com/myh2026/org/releases/latest) 下载
对应平台产物（`org-windows-x64.exe` / `org-darwin-arm64.zip` / `org-linux-x64.zip` …），
解压放入 PATH 后直接 `org`——无需安装 bun。

**开发者（源码模式）**：

```bash
# 前置：只需 bun（≥1.1）；解释器已 vendored 入库，无需额外安装
# （可选）export DHV_TS=/path/to/dhv-ts/src/main.ts 覆盖内嵌工具链

# 0) 打开组织驾驶舱（TUI；`bun run tui` 同效）
bun cli/org.ts tui

# 0.5) 打开 Web GUI 原型（浏览器 http://127.0.0.1:4600；scripted 占位剧本秒回
#      · 提问走 SSE 流式：阶段轮换 + 实时运行日志 + 回答逐行浮出）
bun cli/org.ts web

# 1) 校验 ORG 全部 HSL 源码（hsl/ 源码 + 语言探针 + dist/ 铸出专家）
bun cli/org.ts check

# 2) 全叙事演示（约 2s：铸专家 → 复用+补丁+金丝雀 → 蓝绿验证
#    → 多轮直连 → 暖移交；结束时自动导出 dist/demo）
bun cli/org.ts demo

# 3) 机制级测试（128 个：结构闸门 / README 走读 / 动力学条件分支点火 /
#    工具库治理 keep-drop-import / 上下文窗口计量 / Web GUI 原型 + SSE 流式）
bun test tests/

# 4) 团队模式派单（单轮）
bun cli/org.ts run --task "抓取某站点近一周公告，输出结构化表格"

# 5) 工具库治理三动作：导入你自己的 harness / 选取保留 / 反悔
bun cli/org.ts import my-tool.hsl --name my-tool   # 导入（check 绿才入库 · 即刻可复用）
bun cli/org.ts keep record-validator --workspace demo-run   # 选取保留（候选转正）
bun cli/org.ts drop record-validator --workspace demo-run   # 反悔：取消保留

# 6) 直连指定专家（多轮：记账 + 会话账本 + 纪要回写 + 每轮 [ctx] 上下文计量）
bun cli/org.ts ask notice-parser "上周抓取任务里的字段映射规则是什么？"
bun cli/org.ts ask notice-parser --session demo --turns "那日期无法解析时怎么处理？|再总结一下字段规则"

# 7) 转接模式（暖移交：主控移交摘要 → 专家代答）
bun cli/org.ts handoff notice-parser --task "帮我把解析规则整理成一句话"

# 8) 查看库与池状态 / git 注册表历史（★ 保留 · ○ 候选；无 demo-run 时自动读 dist/demo 入库快照）
bun cli/org.ts status

# 9) 查看模型评分卡与证据来源（evidence_count 为跨运行累计）
bun cli/org.ts score --axis structured_extract

# 10) 确定性重放某次历史运行
bun cli/org.ts replay --run demo-run/out-a   # 或 dist/demo/out-a

# 11) 真实 LLM 模式（经 $host.llm 网关；判定调用全部走真实模型）
bun cli/org.ts run --task "..." --model deepseek

# 环境变量：
#   ORG_CAPABILITY_APPROVED=1   批准能力变更补丁（仅用户）
#   ORG_REDUNDANCY=2            启用 N 版本冗余（镜像派单对比）
```

### CI/CD 与测试

- **测试**（`bun test tests/`，84 个）：结构闸门（dhv check 全源 + 生成器出题与人工抽查逐字一致）
  / README 走读（三连跑衰减曲线、工厂闸门、用户选取保留（retained 落盘 / B 通道命中 /
  uses 曲线）、补丁与金丝雀、固化持久化、评分卡归因、
  journal→fixture、直连、暖移交、git 注册表链）/ 工具库治理（keep/drop 数据面 +
  路由面 + 序列化卫生）/ 动力学点火（漂移告警、固化降级、
  Reject 重派、Escalate 仲裁返工、三档补丁闸门、N 版本冗余）。
- **push / PR**（`ci.yml`）：`dhv check` 全模块 → `bun test` → 三连跑冒烟 → `status` 冒烟 →
  产物上传 workflow artifact → **dist/ 有变化则自动回写提交**（`chore(dist): … [skip ci]`）。
- **tag `v*`**（`release.yml`）：同套校验 → 打包源码 + dist 产物 → 创建 GitHub Release
  （tar.gz + dist zip，发布说明取 CHANGELOG 对应版本段落）。
- 克隆仓库后无需跑 demo 即可 `check` 与 `status`（读 `dist/demo` 快照）——
  编译产物与源码同库交付。

## 🗺️ 实施路线图

| 阶段 | 内容 | 依赖 | 状态 |
|:---|:---|:---|:---|
| **P0 契约与库格式** | 信封类型 + manifest schema + 注册表约定 | 无 | ✅ 完成 |
| **P1 工厂闭环** | 生成 → `dhv check` → fixture 验收 → 登记 | HSL 工具链现有能力 | ✅ 完成（闸门为真实子进程） |
| **P2 主控编排** | 监督回路 graph + 路由策略 + 事件总线留痕 | P0 | ✅ 完成 |
| **P3 监督制** | 契约结构 + 四态裁决 + 有界返工 | P2 | ✅ 完成（客观闸门先行） |
| **P4 池化（轻档）** | 实例生命周期 + 任务历史索引 | P2 | ✅ 完成（双执行车道） |
| **P5 直连** | 三通道 + 记账 + 纪要回写 | P3, P4 | ✅ 完成（多轮会话 + 暖移交 + 会话账本） |
| **P6 补丁自动化** | 提案 → 合入流水线 + journal→fixture 沉淀 | P1, P3 | ✅ 完成（三档闸门全落地） |
| **P7 评分卡与证据采集** | 监督证据归因聚合 | P3, P4 | ✅ 完成（客观档 + 裁判档 + 静默更新检测） |
| **P8 固化管线（精确匹配档）** | 稳定观测 → 冻结 → 验收 → 降级监控 | P7 | ✅ 完成（实测 5→1→0；自动降级） |
| **P9 影子晋升 / N 版本冗余 / 外部导入** | 金丝雀双跑 + 镜像派单 + adapters | P6, P7 | ✅ 完成（v0.3.0） |
| **P10+ 重档池化 / 执行接线 / 联邦** | 私有记忆工作台 / adapters 协议翻译 / 多机注册表 | BNF v1.6 pool/session 语义 | 未开始 |

MVP（P0+P1+P2）已达成且超额：最小可演示闭环——一个任务在库中无专家时被现场生成、验收、使用并沉淀——**及其后的一切动力学（复用、补丁、固化、评分、金丝雀、冗余）都可以用 `org demo` 复现**。

## 📐 设计决策记录

| 决策 | 选择 | 理由 |
|:---|:---|:---|
| 专家接口契约 | 信封模式：外层统一签名，payload 领域自定义 | 外层保证任意专家可组合；内层保留表达力 |
| 直连治理 | 调度可绕、知情/记账不可绕（事后知情） | 事前审批官僚化；完全绕过则预算与上下文失控 |
| 能力策略 | 三态 `auto/confirm/deny` | 缺席授权与在场授权分型 |
| 补丁合入 | 提议权（主控）与合入权（管线）分离 | 生成者不自验收；LLM 产出与业务代码同等对待 |
| 版本策略 | 蓝绿发布：嵌套解释器按磁盘加载 | 在岗会话继续旧版，新派单自动加载新版，可复现性保住 |
| 自我修改边界 | 主控可提案改专家，不可改自身 | 裁决者自我豁免将使质量链失去锚点 |
| 注册表形态 | git 仓库 | 版本、diff、协作复用现有工具链 |
| 主控可替换 | 否决——主控定为手写内核 | 主控错误全场放大；手写内核保证治理锚点唯一 |
| 模型选择 | 评分卡经验匹配 | 能力需求与实测画像做约束求解 |
| 固化判定 | 保守起步：规范化精确匹配 + 观测账本跨运行持久化 | 跨轮稳定性计数是冻结的必要条件（单轮计数永不达阈值） |
| 执行车道 | 进程内（静态专家）+ 嵌套解释器（磁盘专家）双车道 | 蓝绿语义零成本获得；minted 专家天然按磁盘最新版加载 |
| 剧本轨道设计 | 各轮首条 miss 落同一轨道位置且取值一致 | fixture 索引随进程重置——跨轮剧本的工程约束（见 make-fixture.ts） |
| 固化降级顺序 | 先回滚本轮新冻结、再解冻最旧键 | 降级使表收缩，反向顺序会使 warm 边界偏移一位（漏删一个新冻结键） |
| 证据账本分表 | cells 是当期窗口分数；evidence_count 跨运行累计 | 分数要当期可比，账本要单调增长（静默更新检测的证据基础）——两种语义不混在一张表 |
| 冗余计次口径 | 按真实执行计次（返工轮同样触发对比） | 返工轮的输入已变化（feedback 织入），对比信号仍然有效；按子任务去重会丢失该信号 |

## 🛡️ 已知边界（诚实声明）

- **池化重档未实现**：带私有记忆的有状态实例涉及并发写、序列化与会话隔离，当前仅轻档；
- **`check` 保结构不保行为**：行为验收依赖 fixture，mint_hsl 剧本与 `factory/stock/` 人工抽查存档逐字一致——「生成器同时出题又答题」的结构性风险由人工抽查机制兜底，抽检比例待定案；
- **adapters v1 仅导入线**：subagent / MCP / A2A 描述文件的导入 = 注册表登记 + 审计事件；协议翻译（把外部协议调用翻译为信封派单）是路线图项，登记不等于在岗；
- **固化的语义等价判定为开放难题**：v1 仅精确匹配；观测账本跨运行持久化是冻结的必要条件；
- **金丝雀样本规模有限**：影子对比的判卷依据是验收样本（小样本），对比一致 ≠ 全分布一致；
- **评分卡裁判档权重 0.5**：影子对比得分的置信度受样本规模约束，结构性低于客观档（设计铁律 #6 的保守落地）；
- **生成质量受基座模型约束**：`check` 与 fixture 验收拦截结构缺陷与已测行为缺陷，不保证未覆盖行为的正确性。

## 🔗 文档导航

| 想了解… | 去这里 |
|:---|:---|
| HSL 上游 bug 修复记录 | [BUGFIXES.md](BUGFIXES.md) |
| 版本历史 | [CHANGELOG.md](CHANGELOG.md) |
| 底层语言怎么写 | [HSL 语言完全指南](https://github.com/myh2026/harness-specification-language/blob/main/guide/HSL-GUIDE.md) |
| 语法正式定义（唯一权威源） | [BNF v1.5.0](https://github.com/myh2026/harness-specification-language/blob/main/toolchain/hsl-spec/BNF.md) |
| 多 Agent 编排的 HSL 参考实现 | [nova 示例](https://github.com/myh2026/harness-specification-language/tree/main/toolchain/examples/nova) |
| scripted fixture 机制 | [dsh 示例](https://github.com/myh2026/harness-specification-language/tree/main/toolchain/examples/dsh) |
| 工具链安装 | [HSL Releases](https://github.com/myh2026/harness-specification-language/releases/latest) |

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
