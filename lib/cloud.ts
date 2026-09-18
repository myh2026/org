// ============================================================================
// lib/cloud.ts — 云生态统一模块（v0.5.17 · capabilities #67/#68/#72/#74）
// ----------------------------------------------------------------------------
// 一个模块钉住「桌面 Agent 的云生态四能力」：Docker 容器操作（#67）、远程
// SSH（#68）、K8s/Terraform（#72）、云服务/云 CLI（#74）。CLI（org cloud）、
// 工具环（cloud_* 六工具）、Web（🛡 govex ☁ 云生态区块）三端同源消费 ——
// 单一实现防口径漂移（v0.5.16 九模块接线模式的延续）。
//
// 设计灵魂 = 多重优雅降级（四层完整）：
//   ① 探测（probe）：which 定位 + --version 探活 + 守护进程/集群可达性探测，
//      各带硬超时 —— 存在 ≠ 可用，坏安装按缺席降级，绝不静默臆造状态；
//   ② 真实车道（run）：docker/kubectl/ssh 白名单子命令封装 + 数组参数 spawn
//      （零 shell 注入面 —— 不经任何 shell，argv 直投 execve）+ 硬超时；
//   ③ 模板/计划车道（degrade）：Dockerfile/compose/K8s manifest/terraform/
//      ssh-config 五族生产级模板 + dockerPlan/sshPlan 可粘贴命令序列 ——
//      工具缺席时交付的仍然是「可直接用的产物」，不是一句报错；
//   ④ 诚实拒绝（refuse）：白名单外子命令、host 不在 ssh-hosts.allow、路径
//      越 workspace 监狱 —— 给 kind + 人读 reason，绝不执行再道歉。
//
// 安全铁律：
//   · 白名单哲学：破坏性子命令（docker system prune / kubectl delete /
//     terraform destroy）**绝不在白名单** —— 白名单外一律拒绝并给 reason，
//     拒绝发生在任何 spawn 之前（tests/cloud.test.ts 断言不 spawn）；
//   · 零 shell 注入面：所有外部命令走 Bun.spawnSync 数组参数；用户输入
//     永远是 argv 的一个元素，不经字符串拼接、不经 shell 解释；
//   · 私钥/密钥内容绝不读取绝不回显：probeSsh 只看 ~/.ssh 的 config/
//     known_hosts **存在性**（布尔），不列密钥文件名、不读任何内容；
//   · 路径监狱：docker build context / k8s apply -f / scp local 全过
//     lib/pathjail.ts（v0.5.16.1 的跨平台比较形单点收敛）。
//
// 诚实边界：
//   · 沙箱/CI 无 docker/kubectl/ssh/terraform/云 CLI —— 降级车道（模板+
//     计划）是这些环境的主车道；真实车道代码路径完整但无真实守护进程/
//     集群可实测（探测的可达性分支只对「工具在场」的环境生效）；
//   · docker run 的 -v/--mount 卷挂载参数不做事前校验（子命令白名单是本
//     模块的声明边界；arg 级审查是路线图）—— 已在 dockerRun 注释声明。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inWorkspace, resolveInWorkspace } from "./pathjail.ts";
import { PROVIDERS, PROVIDER_NAMES } from "./provider-registry.ts";

// ---- 预算与常量 ---------------------------------------------------------------

/** 版本探活超时（坏安装快速降级）。 */
const PROBE_VERSION_TIMEOUT_MS = 5_000;
/** 守护进程/集群可达性探测超时（spec：docker info / kubectl cluster-info 5s）。 */
const PROBE_DAEMON_TIMEOUT_MS = 5_000;
/** 执行车道缺省硬超时（docker/ssh/kubectl 30s）。 */
const RUN_DEFAULT_TIMEOUT_MS = 30_000;
/** 超时上限（调用方可放宽，但不超过此帽）。 */
const RUN_MAX_TIMEOUT_MS = 5 * 60_000;
/** stdout/stderr 捕获帽（结果面回传 CLI/Web/工具环的载荷保护）。 */
const OUTPUT_CAP = 64 * 1024;

/** #68 SSH host 白名单文件（工作区相对；缺席 = 拒绝一切远程执行）。 */
export const SSH_HOSTS_ALLOW = "ssh-hosts.allow";

// ---- 工具定位（PATH 扫描；与 lib/plugins.ts whichGit 同规）----------------------

/** PATH 扫描定位可执行（win32 兼容 .exe；读运行期 PATH —— 可测性）。 */
export function whichTool(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    const c = path.join(d, exe);
    try {
      if (!fs.statSync(c).isFile()) continue;
      if (process.platform !== "win32") fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // 不存在/不可执行 → 下一个候选位
    }
  }
  return null;
}

/** 数组参数 spawn（零 shell 注入面）+ 硬超时 + 输出帽。失败降级为 null（不 throw）。 */
function spawnCaptured(argv: string[], timeoutMs: number): { exitCode: number | null; stdout: string; stderr: string } | null {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
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

// ---- 执行车道统一结果面 ---------------------------------------------------------

export type CloudRunKind =
  | "denied"          // 白名单外子命令 / 参数形态拒绝
  | "tool-absent"     // CLI 缺席（附安装指引）
  | "host-not-allowed" // #68：host 不在 ssh-hosts.allow
  | "jail"            // 路径越工作区监狱
  | "timeout"         // 硬超时
  | "failed";         // 执行了但退出码非 0

export interface CloudRunResult {
  ok: boolean;
  /** 失败分类（ok:true 时缺席）。 */
  kind?: CloudRunKind;
  /** 实际 argv（观测面 —— 数组形态本身就是「无 shell 拼接」的证明）。 */
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 人读失败原因 / 成功说明。 */
  reason?: string;
  tookMs: number;
}

/** 白名单拒绝（不 spawn —— 拒绝先于一切探测与执行）。 */
function deny(argvTail: string[], reason: string, bin: string): CloudRunResult {
  return { ok: false, kind: "denied", argv: [bin, ...argvTail], exitCode: null, stdout: "", stderr: "", reason, tookMs: 0 };
}

// ============================================================================
// #67 Docker / 容器操作
// ============================================================================

/** docker 子命令白名单（只读 + 构建生命周期；**破坏性命令绝不在内**：
 *  system/prune/kill/exec/cp/save/load/volume/network/swarm/node/service/stack
 *  一律拒绝 —— rm/rmi/stop 属容器生命周期管理，保留但只作用于显式目标）。 */
export const DOCKER_SUBCOMMANDS: readonly string[] = [
  "version", "info", "ps", "images", "build", "run", "create", "start", "stop",
  "rm", "rmi", "logs", "inspect", "pull", "tag", "push",
];

export interface DockerProbe {
  available: boolean;
  /** docker --version 解析出的版本串（缺席 null）。 */
  version: string | null;
  /** docker info 守护进程可达（CLI 在场才有探测意义）。 */
  daemonReachable: boolean;
  /** 守护进程不可达时的摘要（版本输出/错误首行）。 */
  reason?: string;
}

/** 探测 docker：which → --version 探活 → info 守护进程可达性（5s 硬超时）。 */
export function probeDocker(): DockerProbe {
  const bin = whichTool("docker");
  if (bin === null) {
    return {
      available: false,
      version: null,
      daemonReachable: false,
      reason: "未找到 docker CLI。安装：https://docs.docker.com/get-docker/（或 brew install --cask docker / apt install docker.io）；无 docker 时可用降级车道：dockerfileFor / composeFor / dockerPlan 模板与命令序列。",
    };
  }
  const v = spawnCaptured([bin, "--version"], PROBE_VERSION_TIMEOUT_MS);
  if (v === null || v.exitCode !== 0) {
    return { available: false, version: null, daemonReachable: false, reason: `docker CLI 存在但 --version 探活失败（坏安装按缺席降级）：${firstLine(v?.stderr ?? "")}` };
  }
  const info = spawnCaptured([bin, "info"], PROBE_DAEMON_TIMEOUT_MS);
  const daemonReachable = info !== null && info.exitCode === 0;
  return {
    available: true,
    version: firstLine(v.stdout).replace(/^Docker version\s*/i, "").split(",").join(" ").trim() || firstLine(v.stdout),
    daemonReachable,
    ...(daemonReachable ? {} : { reason: `docker 守护进程不可达（docker info 失败）：${firstLine(info?.stderr ?? "（无输出）")}` }),
  };
}

/**
 * docker 白名单子命令封装：`dockerRun("ps", ["-a"])` → argv=[docker, ps, -a]。
 * 拒绝先于探测先于 spawn —— 白名单外子命令在无 docker 的环境也返回
 * kind:"denied"（tests 以此断言不 spawn）。缺省 30s 硬超时。
 * 诚实边界：arg 级审查（如 run 的 -v 卷挂载）是路线图，子命令白名单是本
 * 模块的声明边界。
 */
export function dockerRun(subcommand: string, args: string[] = [], opts: { timeoutMs?: number } = {}): CloudRunResult {
  const bin = whichTool("docker") ?? "docker";
  if (typeof subcommand !== "string" || !DOCKER_SUBCOMMANDS.includes(subcommand)) {
    return deny([String(subcommand ?? ""), ...args.map(String)],
      `子命令 "${subcommand}" 不在 docker 白名单内（允许：${DOCKER_SUBCOMMANDS.join("/")}）。破坏性命令（system prune/kill/exec/cp/save/load/volume/network/swarm…）刻意排除 —— 需要时请人工执行。`, "docker");
  }
  const safeArgs = args.map((a) => String(a));
  // 子命令再保险：argv 里不允许混入第二级子命令词（防 `docker run x` 后接 `; rm`）
  for (const a of safeArgs) {
    if (/[\r\n]/.test(a)) {
      return deny([subcommand, ...safeArgs], "参数含换行符（可疑的多命令注入形态），拒绝执行。", "docker");
    }
  }
  const abs = whichTool("docker");
  if (abs === null) {
    return {
      ok: false, kind: "tool-absent", argv: ["docker", subcommand, ...safeArgs], exitCode: null, stdout: "", stderr: "",
      reason: "未找到 docker CLI（降级车道：org cloud dockerfile <type> / compose / plan —— 生产级模板与可粘贴命令序列）。安装：https://docs.docker.com/get-docker/",
      tookMs: 0,
    };
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const t0 = Date.now();
  const r = spawnCaptured([abs, subcommand, ...safeArgs], timeoutMs);
  const tookMs = Date.now() - t0;
  if (r === null) {
    return { ok: false, kind: "timeout", argv: [abs, subcommand, ...safeArgs], exitCode: null, stdout: "", stderr: "", reason: `docker ${subcommand} 执行失败或超时（>${timeoutMs}ms 硬超时强杀）`, tookMs };
  }
  return {
    ok: r.exitCode === 0,
    ...(r.exitCode === 0 ? {} : { kind: "failed" as CloudRunKind }),
    argv: [abs, subcommand, ...safeArgs],
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.exitCode === 0 ? {} : { reason: `docker ${subcommand} 退出码 ${r.exitCode}` }),
    tookMs,
  };
}

/** docker build 高层封装：build context 与 -f Dockerfile 全过工作区监狱。 */
export function dockerBuild(ws: string, context: string, opts: { dockerfile?: string; tag?: string; timeoutMs?: number } = {}): CloudRunResult {
  const ctx = resolveInWorkspace(ws, context);
  if (!inWorkspace(ws, ctx)) {
    return { ok: false, kind: "jail", argv: ["docker", "build", context], exitCode: null, stdout: "", stderr: "", reason: `build context 越界（须在工作区内）：${context}`, tookMs: 0 };
  }
  const args: string[] = [];
  if (opts.tag) {
    const tag = String(opts.tag);
    if (/[\r\n]/.test(tag)) return deny(["build", "-t", tag, context], "tag 含换行符，拒绝执行。", "docker");
    args.push("-t", tag);
  }
  if (opts.dockerfile) {
    const df = resolveInWorkspace(ws, opts.dockerfile);
    if (!inWorkspace(ws, df)) {
      return { ok: false, kind: "jail", argv: ["docker", "build", "-f", opts.dockerfile, context], exitCode: null, stdout: "", stderr: "", reason: `Dockerfile 路径越界（须在工作区内）：${opts.dockerfile}`, tookMs: 0 };
    }
    args.push("-f", opts.dockerfile);
  }
  args.push(context);
  return dockerRun("build", args, { timeoutMs: opts.timeoutMs });
}

// ---- #67 降级车道：Dockerfile / compose / 计划 --------------------------------

export type DockerfileProject = "node" | "bun" | "python" | "rust";

/** Dockerfile 模板族（node/bun/python/rust 四型 —— 多阶段 + 非 root + healthcheck）。 */
export const DOCKERFILE_TYPES: readonly DockerfileProject[] = ["node", "bun", "python", "rust"];

/**
 * 生产级 Dockerfile 模板（#67 降级车道主交付）：多阶段构建 + 非 root 用户 +
 * HEALTHCHECK + 钉住版本标签。模板自检：通过本仓库 iacscan 的全部 Dockerfile
 * 规则（tests/cloud.test.ts 用 scanIac 对拍 —— 模板本身不带高危反模式）。
 */
export function dockerfileFor(projectType: string): { projectType: DockerfileProject; dockerfile: string; notes: string[] } {
  const t = String(projectType ?? "").toLowerCase();
  const map: Record<DockerfileProject, { dockerfile: string; notes: string[] }> = {
    node: {
      dockerfile: `# syntax=docker/dockerfile:1
# org cloud dockerfile node —— 生产级 Node 多阶段镜像（非 root · healthcheck）
# ---- 构建阶段：装依赖（利用层缓存：先 manifest 后源码）----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

# ---- 运行阶段：只带产物与生产依赖 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# 基础镜像自带非 root 用户 node —— 直接切换（无 apt 面）
USER node
EXPOSE 8080
# Node 18+ 内建 fetch：healthcheck 零额外依赖
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
`,
      notes: [
        "npm ci 优先（可复现锁定安装），失败回退 npm install --omit=dev",
        "USER node：node:22-alpine 自带非 root 用户，零 apt 安装面",
        "healthcheck 用内建 fetch —— 不引入 curl/wget 体积",
      ],
    },
    bun: {
      dockerfile: `# syntax=docker/dockerfile:1
# org cloud dockerfile bun —— 生产级 Bun 多阶段镜像（非 root · healthcheck）
# ---- 构建阶段 ----
FROM oven/bun:1.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install --production
COPY . .

# ---- 运行阶段 ----
FROM oven/bun:1.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# oven/bun 官方镜像自带非 root 用户 bun
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD bun -e "await fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "run", "server.ts"]
`,
      notes: [
        "bun install --frozen-lockfile 优先（锁定可复现）",
        "USER bun：oven/bun 官方镜像自带非 root 用户",
        "healthcheck 用 Bun 内建 fetch —— 零额外依赖",
      ],
    },
    python: {
      dockerfile: `# syntax=docker/dockerfile:1
# org cloud dockerfile python —— 生产级 Python 多阶段镜像（venv 隔离 · 非 root · healthcheck）
# ---- 构建阶段：独立 venv 装依赖 ----
FROM python:3.12-slim AS build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# ---- 运行阶段：只拷 venv 与源码 ----
FROM python:3.12-slim
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY . .
# 专用非 root 用户（Debian useradd，无 apt 安装面）
RUN useradd --create-home --uid 10001 appuser
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status < 500 else 1)"
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
`,
      notes: [
        "venv 整目录从构建阶段拷贝 —— 运行镜像不带 pip 缓存",
        "pip --no-cache-dir：镜像层不落包缓存",
        "useradd uid 10001 专用用户；healthcheck 用标准库 urllib",
      ],
    },
    rust: {
      dockerfile: `# syntax=docker/dockerfile:1
# org cloud dockerfile rust —— 生产级 Rust 多阶段镜像（编译器不进运行镜像 · 非 root · healthcheck）
# ---- 构建阶段：release 编译（依赖层缓存）----
FROM rust:1.83-slim AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
# 依赖骨架先编译（层缓存：源码变更不重编依赖）
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ---- 运行阶段：仅二进制（cargo/rustc 全部留在构建阶段）----
FROM debian:bookworm-slim
RUN useradd --create-home --uid 10001 appuser
WORKDIR /app
COPY --from=build /build/target/release/app /usr/local/bin/app
USER appuser
EXPOSE 8080
# healthcheck 由应用二进制自检（--health 子命令是约定，请在 main() 里实现）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD ["/usr/local/bin/app", "--health"]
CMD ["/usr/local/bin/app"]
`,
      notes: [
        "依赖骨架预编译技巧：Cargo.lock 不变时依赖层直接命中缓存",
        "运行镜像只带一个二进制 —— 无运行时依赖面（Debian slim 仅 libc）",
        "healthcheck 走应用自检子命令 --health（无 curl/wget 依赖）",
      ],
    },
  };
  const hit = map[t as DockerfileProject];
  if (!hit) {
    throw new Error(`未知 projectType "${projectType}"（支持：node/bun/python/rust）`);
  }
  return { projectType: t as DockerfileProject, dockerfile: hit.dockerfile, notes: hit.notes };
}

/** docker-compose.yml 模板（服务 + 专用网络 + 具名卷 + healthcheck + 安全注释）。 */
export function composeFor(opts: { appName?: string; projectType?: string; port?: number } = {}): { compose: string; notes: string[] } {
  const app = (String(opts.appName ?? "app").replace(/[^A-Za-z0-9_-]/g, "-") || "app");
  const port = Number.isFinite(opts.port) && Number(opts.port) > 0 ? Number(opts.port) : 8080;
  const compose = `# org cloud compose —— 生产级 docker-compose 模板（专用网络 · 具名卷 · healthcheck）
# 安全底线：非特权容器 · 不挂 docker 套接字 · 专用 bridge 网络（非宿主网络）
services:
  ${app}:
    build: .
    image: ${app}:1.0.0
    restart: unless-stopped
    ports:
      - "${port}:${port}"
    networks:
      - frontend
    volumes:
      - ${app}-data:/data
    environment:
      - ENV=production
    # secret 不进 compose —— 用 env_file（.gitignore 掉）或编排器 secret 注入
    # env_file:
    #   - .env.production
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:${port}/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    # 容器资源限额（按宿主机预算调整）
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

networks:
  frontend:
    driver: bridge

volumes:
  ${app}-data: {}
`;
  return {
    compose,
    notes: [
      "专用 bridge 网络（不用 network_mode: host）",
      "具名卷而非绑定宿主路径；镜像内已是非 root 用户",
      "healthcheck 的 wget 若镜像没有，改用镜像内可用的探活命令（见 dockerfileFor 的零依赖 healthcheck）",
    ],
  };
}

export type DockerPlanAction = "build" | "run" | "push" | "debug" | "cleanup";

/** dockerPlan 意图集。 */
export const DOCKER_PLAN_ACTIONS: readonly DockerPlanAction[] = ["build", "run", "push", "debug", "cleanup"];

/**
 * dockerPlan(action)：把用户意图翻译成可直接粘贴的命令序列 + 每条命令的
 * 安全注释（#67 降级车道 —— 无 docker 环境交付「可粘贴执行的计划」）。
 * cleanup 刻意排除 docker system prune（破坏性）；只给逐项审查式命令。
 */
export function dockerPlan(action: string): { action: string; steps: { cmd: string; note: string }[]; warning?: string } {
  const a = String(action ?? "").toLowerCase();
  const plans: Record<DockerPlanAction, { steps: { cmd: string; note: string }[]; warning?: string }> = {
    build: {
      steps: [
        { cmd: "docker build -t myapp:1.0.0 .", note: "构建镜像（钉住具体 tag，不用 :latest —— 可复现）" },
        { cmd: "docker images myapp", note: "确认镜像已生成与体积" },
        { cmd: "docker run --rm myapp:1.0.0 <健康检查命令>", note: "一次性容器冒烟（--rm 退出即清理）" },
      ],
    },
    run: {
      steps: [
        { cmd: "docker run -d --name myapp --restart unless-stopped -p 8080:8080 myapp:1.0.0", note: "后台启动 + 崩溃自拉起 + 端口映射" },
        { cmd: "docker ps --filter name=myapp", note: "确认运行状态（含 healthcheck 状态列）" },
        { cmd: "docker logs -f myapp", note: "跟随日志（Ctrl+C 退出不影响容器）" },
      ],
    },
    push: {
      steps: [
        { cmd: "docker tag myapp:1.0.0 <registry>/<ns>/myapp:1.0.0", note: "打仓库全名 tag" },
        { cmd: "docker tag myapp:1.0.0 <registry>/<ns>/myapp:latest", note: "滚动指针 tag（部署器习惯；构建仍以具体 tag 为准）" },
        { cmd: "docker push <registry>/<ns>/myapp:1.0.0", note: "推具体版本 tag（先推版本再推 latest，防半更新）" },
        { cmd: "docker push <registry>/<ns>/myapp:latest", note: "推 latest 指针" },
      ],
      warning: "推公有仓库前先扫密钥（org scan / org iacscan）—— 镜像历史层里的密钥洗不掉。",
    },
    debug: {
      steps: [
        { cmd: "docker ps -a", note: "全量容器（含已退出的 —— 看 STATUS 列的退出码）" },
        { cmd: "docker logs --tail 200 <container>", note: "容器尾部日志" },
        { cmd: "docker inspect <container> --format '{{.State.ExitCode}} {{.State.Error}}'", note: "退出码与错误摘要" },
        { cmd: "docker stats --no-stream", note: "一次性资源占用快照（CPU/内存/网络）" },
      ],
    },
    cleanup: {
      steps: [
        { cmd: "docker ps -a --filter status=exited --format '{{.ID}} {{.Names}}'", note: "先看清单再删 —— 逐项确认，不盲清" },
        { cmd: "docker rm <已退出的容器ID>", note: "删单个已退出容器（白名单内子命令）" },
        { cmd: "docker images --filter dangling=true --format '{{.ID}} {{.Repository}}'", note: "悬空镜像清单（构建残留）" },
        { cmd: "docker rmi <悬空镜像ID>", note: "删单个悬空镜像" },
      ],
      warning: "docker system prune 是破坏性命令（一次性清卷/网络/构建缓存）—— 刻意不在白名单与本计划内；确需执行请人工审查后手动运行。",
    },
  };
  const hit = plans[a as DockerPlanAction];
  if (!hit) {
    throw new Error(`未知 action "${action}"（支持：${DOCKER_PLAN_ACTIONS.join("/")}）`);
  }
  return { action: a, steps: hit.steps, ...(hit.warning ? { warning: hit.warning } : {}) };
}

// ============================================================================
// #68 远程 SSH
// ============================================================================

export interface SshProbe {
  available: boolean;
  version: string | null;
  /** ~/.ssh 目录存在。 */
  sshDirExists: boolean;
  /** ~/.ssh/config 存在（只看存在性 —— 绝不读取内容）。 */
  configExists: boolean;
  /** ~/.ssh/known_hosts 存在。 */
  knownHostsExists: boolean;
  reason?: string;
}

/**
 * 探测 ssh CLI 与 ~/.ssh 配置概况。**私钥/密钥内容绝不读取绝不回显** ——
 * 只列 config/known_hosts 的存在性布尔；不枚举密钥文件名。
 */
export function probeSsh(): SshProbe {
  const sshDir = path.join(os.homedir(), ".ssh");
  let sshDirExists = false;
  let configExists = false;
  let knownHostsExists = false;
  try {
    sshDirExists = fs.statSync(sshDir).isDirectory();
    if (sshDirExists) {
      configExists = fs.statSync(path.join(sshDir, "config")).isFile();
      knownHostsExists = fs.statSync(path.join(sshDir, "known_hosts")).isFile();
    }
  } catch {
    // stat 失败 = 不存在（保持 false）
  }
  const bin = whichTool("ssh");
  if (bin === null) {
    return {
      available: false, version: null, sshDirExists, configExists, knownHostsExists,
      reason: "未找到 ssh CLI。安装：apt install openssh-client / brew install openssh（Windows 用内建 OpenSSH 或 Git for Windows）。降级车道：sshConfigTemplate / sshPlan。",
    };
  }
  // ssh -V 输出到 stderr 且退出码 0（OpenSSH 契约）
  const v = spawnCaptured([bin, "-V"], PROBE_VERSION_TIMEOUT_MS);
  const version = v !== null && v.exitCode === 0 ? firstLine(v.stderr) : null;
  return {
    available: version !== null || v?.exitCode === 0,
    version,
    sshDirExists, configExists, knownHostsExists,
    ...(v === null || (v.exitCode !== 0 && version === null) ? { reason: `ssh CLI 存在但 -V 探活失败：${firstLine(v?.stderr ?? "")}` } : {}),
  };
}

/** ssh 安全旗标（BatchMode 免交互挂死 + ConnectTimeout + 首连指纹确认）。 */
const SSH_SAFE_FLAGS: readonly string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];

/** ssh argv 构造（纯函数面 —— tests 断言 BatchMode/ConnectTimeout 在 args 里）。 */
export function sshArgv(host: string, command: string): string[] {
  return ["ssh", ...SSH_SAFE_FLAGS, String(host), String(command)];
}

/** scp argv 构造（同安全旗标）。 */
export function scpArgv(host: string, local: string, remote: string): string[] {
  return ["scp", ...SSH_SAFE_FLAGS, String(local), `${String(host)}:${String(remote)}`];
}

/** host 白名单判定：<ws>/ssh-hosts.allow 每行一个 host（# 注释/空行忽略）。 */
export function sshHostAllowed(ws: string, host: string): { allowed: boolean; file: string; matches: string[] } {
  const file = path.join(ws, SSH_HOSTS_ALLOW);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { allowed: false, file, matches: [] };
  }
  const wanted = String(host).trim();
  const matches: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    if (t === wanted) matches.push(t);
  }
  return { allowed: matches.length > 0, file, matches };
}

/** host 白名单拒绝的统一指引（#68 的第四层：诚实拒绝 + 创建指引）。 */
const SSH_HOSTS_GUIDANCE =
  `在 <工作区>/${SSH_HOSTS_ALLOW} 里逐行写入允许的 host（每行一个，# 注释可留），例如：\n` +
  `  deploy.example.com\n  jump.internal\n创建后即可执行；文件缺席 = 拒绝一切远程执行（安全缺省）。`;

/**
 * sshRun(ws, host, command)：host 必须在 <ws>/ssh-hosts.allow 白名单内
 * （无此文件 = 拒绝执行 + 创建指引）；BatchMode=yes + ConnectTimeout=10 +
 * StrictHostKeyChecking=accept-new；数组参数（零本地 shell 注入面 —— 远端
 * 命令串由远端登录 shell 解释，这是 ssh 语义本身，调用方对命令内容负责）。
 */
export function sshRun(ws: string, host: string, command: string, opts: { timeoutMs?: number } = {}): CloudRunResult {
  const h = String(host ?? "").trim();
  if (h.length === 0 || /[\s]/.test(h) || h.startsWith("-")) {
    return { ok: false, kind: "host-not-allowed", argv: sshArgv(String(host), String(command)), exitCode: null, stdout: "", stderr: "", reason: `host "${host}" 形态不合法（非空、无空白、不以 - 开头）。`, tookMs: 0 };
  }
  const gate = sshHostAllowed(ws, h);
  if (!gate.allowed) {
    return {
      ok: false, kind: "host-not-allowed", argv: sshArgv(h, String(command)), exitCode: null, stdout: "", stderr: "",
      reason: gate.matches.length === 0 && !fs.existsSync(gate.file)
        ? `host "${h}" 未获放行：${SSH_HOSTS_ALLOW} 白名单文件不存在（${gate.file}）。${SSH_HOSTS_GUIDANCE}`
        : `host "${h}" 不在 ${SSH_HOSTS_ALLOW} 白名单内（${gate.file}）。${SSH_HOSTS_GUIDANCE}`,
      tookMs: 0,
    };
  }
  const bin = whichTool("ssh");
  if (bin === null) {
    return {
      ok: false, kind: "tool-absent", argv: sshArgv(h, String(command)), exitCode: null, stdout: "", stderr: "",
      reason: "未找到 ssh CLI。安装：apt install openssh-client / brew install openssh。降级车道：sshConfigTemplate / sshPlan。",
      tookMs: 0,
    };
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const argv = [bin, ...SSH_SAFE_FLAGS, h, String(command)];
  const t0 = Date.now();
  const r = spawnCaptured(argv, timeoutMs);
  const tookMs = Date.now() - t0;
  if (r === null) {
    return { ok: false, kind: "timeout", argv, exitCode: null, stdout: "", stderr: "", reason: `ssh ${h} 执行失败或超时（>${timeoutMs}ms；ConnectTimeout=10 只管 TCP 连接阶段，总帽在 spawn 层）`, tookMs };
  }
  return {
    ok: r.exitCode === 0,
    ...(r.exitCode === 0 ? {} : { kind: "failed" as CloudRunKind }),
    argv,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.exitCode === 0 ? {} : { reason: `ssh ${h} 退出码 ${r.exitCode}（BatchMode=yes 下密码认证会失败 —— 请配置密钥，见 sshConfigTemplate）` }),
    tookMs,
  };
}

/**
 * scpUpload(ws, host, local, remote)：host 白名单同 sshRun；local 过工作区
 * 监狱（路径越界拒绝）；remote 路径拒绝 shell 元字符与换行（防远端解释面）。
 */
export function scpUpload(ws: string, host: string, local: string, remote: string, opts: { timeoutMs?: number } = {}): CloudRunResult {
  const h = String(host ?? "").trim();
  const remotePath = String(remote ?? "");
  if (/[\r\n`;$]/.test(remotePath) || remotePath.startsWith("-")) {
    return { ok: false, kind: "denied", argv: scpArgv(h, String(local), remotePath), exitCode: null, stdout: "", stderr: "", reason: `remote 路径含可疑字符或以 - 开头，拒绝执行：${JSON.stringify(remotePath)}`, tookMs: 0 };
  }
  const localAbs = resolveInWorkspace(ws, String(local));
  if (!inWorkspace(ws, localAbs)) {
    return { ok: false, kind: "jail", argv: scpArgv(h, String(local), remotePath), exitCode: null, stdout: "", stderr: "", reason: `local 路径越界（须在工作区内）：${local}`, tookMs: 0 };
  }
  const gate = sshHostAllowed(ws, h);
  if (!gate.allowed) {
    return {
      ok: false, kind: "host-not-allowed", argv: scpArgv(h, String(local), remotePath), exitCode: null, stdout: "", stderr: "",
      reason: gate.matches.length === 0 && !fs.existsSync(gate.file)
        ? `host "${h}" 未获放行：${SSH_HOSTS_ALLOW} 白名单文件不存在（${gate.file}）。${SSH_HOSTS_GUIDANCE}`
        : `host "${h}" 不在 ${SSH_HOSTS_ALLOW} 白名单内（${gate.file}）。${SSH_HOSTS_GUIDANCE}`,
      tookMs: 0,
    };
  }
  const bin = whichTool("scp");
  if (bin === null) {
    return {
      ok: false, kind: "tool-absent", argv: scpArgv(h, localAbs, remotePath), exitCode: null, stdout: "", stderr: "",
      reason: "未找到 scp CLI（随 openssh-client 分发）。安装：apt install openssh-client / brew install openssh。",
      tookMs: 0,
    };
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const argv = [bin, ...SSH_SAFE_FLAGS, localAbs, `${h}:${remotePath}`];
  const t0 = Date.now();
  const r = spawnCaptured(argv, timeoutMs);
  const tookMs = Date.now() - t0;
  if (r === null) {
    return { ok: false, kind: "timeout", argv, exitCode: null, stdout: "", stderr: "", reason: `scp ${h} 执行失败或超时（>${timeoutMs}ms）`, tookMs };
  }
  return {
    ok: r.exitCode === 0,
    ...(r.exitCode === 0 ? {} : { kind: "failed" as CloudRunKind }),
    argv, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
    ...(r.exitCode === 0 ? {} : { reason: `scp ${h}:${remotePath} 退出码 ${r.exitCode}` }),
    tookMs,
  };
}

/** sshConfigTemplate（#68 降级车道）：~/.ssh/config 片段 + 安全建议。 */
export function sshConfigTemplate(): { config: string; advice: string[] } {
  const config = `# org cloud ssh-template —— ~/.ssh/config 片段模板（追加到你自己的 ~/.ssh/config）
# 语义：按别名组织主机 —— IdentityFile 显式指定密钥，杜绝默认把公钥挨个试
Host deploy
  HostName deploy.example.com
  User deploy
  Port 22
  IdentityFile ~/.ssh/id_ed25519_deploy
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 4

# 跳板机模式：内网主机经堡垒中转（公网只暴露跳板）
Host jump.internal
  HostName 10.0.0.10
  User ops
  IdentityFile ~/.ssh/id_ed25519_ops
  IdentitiesOnly yes

Host app.internal
  HostName 10.0.1.20
  User app
  ProxyJump jump.internal
  IdentityFile ~/.ssh/id_ed25519_app
  IdentitiesOnly yes
`;
  const advice = [
    "密钥而非密码：ssh-keygen -t ed25519 -C 'you@host' 生成后 ssh-copy-id 上传公钥（本模块 BatchMode=yes，密码认证一律失败）",
    "IdentitiesOnly yes：只用显式指定的 IdentityFile，避免把 agent 里的钥匙全试一遍（侧信道）",
    "跳板机模式：ProxyJump 一行组织内网拓扑，公网只暴露跳板机",
    "不要开 ForwardAgent（密钥经中间主机转发 —— 中间机沦陷即钥匙沦陷）",
    "私钥永不入仓库/工作区：本模块探测只看 config/known_hosts 存在性，绝不读取或回显密钥内容",
  ];
  return { config, advice };
}

/** sshPlan(host, command)（#68 降级车道）：从零到执行一条命令的完整序列模板。 */
export function sshPlan(host: string, command: string): { steps: { cmd: string; note: string }[] } {
  const h = String(host ?? "").trim() || "<host>";
  return {
    steps: [
      { cmd: "ssh-keygen -t ed25519 -C 'org-agent'", note: "生成专用密钥（已有则跳过；passphrase 可空给自动化，密钥文件权限须 600）" },
      { cmd: `ssh-copy-id -i ~/.ssh/id_ed25519.pub ${h}`, note: "上传公钥（一次性动作；之后 BatchMode 免交互）" },
      { cmd: `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${h} 'echo ok'`, note: "冒烟：首连自动记录指纹（accept-new），之后拒绝指纹漂移" },
      { cmd: `ssh -o BatchMode=yes ${h} '${String(command ?? "uptime")}'`, note: "执行目标命令（与本模块 sshRun 同安全旗标）" },
      { cmd: `# 工作区 ${SSH_HOSTS_ALLOW} 里放行 ${h} 后：org cloud ssh ${h} "<command>"`, note: "进 org 白名单门控车道（host 不在 allow 文件 = 拒绝）" },
    ],
  };
}

// ============================================================================
// #72 K8s / Terraform
// ============================================================================

export interface K8sProbe {
  available: boolean;
  version: string | null;
  /** kubectl cluster-info 可达（无 kubeconfig/集群不可达 → false）。 */
  clusterReachable: boolean;
  reason?: string;
}

/** 探测 kubectl：which → version --client 探活 → cluster-info 可达性（5s）。 */
export function probeK8s(): K8sProbe {
  const bin = whichTool("kubectl");
  if (bin === null) {
    return {
      available: false, version: null, clusterReachable: false,
      reason: "未找到 kubectl CLI。安装：https://kubernetes.io/docs/tasks/tools/#kubectl。降级车道：k8sManifestFor 五族模板 + terraformPlan 骨架。",
    };
  }
  const v = spawnCaptured([bin, "version", "--client"], PROBE_VERSION_TIMEOUT_MS);
  if (v === null || v.exitCode !== 0) {
    return { available: false, version: null, clusterReachable: false, reason: `kubectl 存在但 version --client 探活失败：${firstLine(v?.stderr ?? "")}` };
  }
  const m = v.stdout.match(/GitVersion:"?v?([\w.-]+)"?/);
  const info = spawnCaptured([bin, "cluster-info"], PROBE_DAEMON_TIMEOUT_MS);
  const clusterReachable = info !== null && info.exitCode === 0;
  return {
    available: true,
    version: m ? m[1] : firstLine(v.stdout),
    clusterReachable,
    ...(clusterReachable ? {} : { reason: `集群不可达（kubectl cluster-info 失败 —— 无 kubeconfig 或 API server 不通）：${firstLine(info?.stderr ?? "（无输出）")}；降级车道：k8sManifestFor / terraformPlan 模板` }),
  };
}

export interface TerraformProbe {
  available: boolean;
  version: string | null;
  reason?: string;
}

/** 探测 terraform：which → version 探活（HCL 车道与 kubectl 同型）。 */
export function probeTerraform(): TerraformProbe {
  const bin = whichTool("terraform");
  if (bin === null) {
    return {
      available: false, version: null,
      reason: "未找到 terraform CLI。安装：https://developer.hashicorp.com/terraform/downloads。降级车道：terraformPlan main.tf 骨架。",
    };
  }
  const v = spawnCaptured([bin, "version"], PROBE_VERSION_TIMEOUT_MS);
  if (v === null || v.exitCode !== 0) {
    return { available: false, version: null, reason: `terraform 存在但 version 探活失败：${firstLine(v?.stderr ?? "")}` };
  }
  const m = v.stdout.match(/Terraform\s+v([\w.-]+)/);
  return { available: true, version: m ? m[1] : firstLine(v.stdout) };
}

/** kubectl 子命令白名单（读面 + apply 声明面；**delete/edit/scale/exec/cp/
 *  drain/cordon/taint 等变更面一律排除** —— delete namespace 等破坏性操作
 *  刻意不在白名单，需要时人工执行）。 */
export const K8S_SUBCOMMANDS: readonly string[] = [
  "version", "cluster-info", "api-resources", "api-versions", "config", "get",
  "describe", "explain", "logs", "top", "rollout", "wait", "auth", "diff", "apply",
];

/**
 * kubectl 白名单子命令封装：`k8sRun(ws, ["get", "pods"])`。
 * apply/diff 的 -f/--filename 值过工作区监狱（`-`（stdin）拒绝 —— 本模块
 * stdin 恒 ignore，stdin 车道必然挂死，提前拒绝并说明）。缺省 30s 硬超时。
 */
export function k8sRun(ws: string, args: string[], opts: { timeoutMs?: number } = {}): CloudRunResult {
  const safeArgs = (Array.isArray(args) ? args : []).map((a) => String(a));
  const sub = safeArgs[0] ?? "";
  const bin = whichTool("kubectl") ?? "kubectl";
  if (!K8S_SUBCOMMANDS.includes(sub)) {
    return deny(safeArgs, `子命令 "${sub}" 不在 kubectl 白名单内（允许：${K8S_SUBCOMMANDS.join("/")}）。delete/edit/scale/exec/cp/drain 等变更面刻意排除 —— 需要时请人工执行。`, "kubectl");
  }
  // apply/diff 的 -f 值过监狱（-k kustomize 目录同理收监）
  for (let i = 1; i < safeArgs.length; i++) {
    if (/[\r\n]/.test(safeArgs[i]!)) {
      return deny(safeArgs, `参数含换行符（可疑注入形态），拒绝执行。`, "kubectl");
    }
    if ((safeArgs[i] === "-f" || safeArgs[i] === "--filename" || safeArgs[i] === "-k") && i + 1 < safeArgs.length) {
      const val = safeArgs[i + 1]!;
      if (val === "-") {
        return deny(safeArgs, "-f -（stdin 清单）被拒绝：本工具环 stdin 恒关闭，stdin 车道必然挂死。请用工作区内的清单文件路径。", "kubectl");
      }
      if (val.startsWith("-")) continue; // 下一个旗标值不是路径
      const resolved = resolveInWorkspace(ws, val);
      if (!inWorkspace(ws, resolved)) {
        return {
          ok: false, kind: "jail", argv: ["kubectl", ...safeArgs], exitCode: null, stdout: "", stderr: "",
          reason: `清单路径越界（须在工作区内）：${val}`,
          tookMs: 0,
        };
      }
      safeArgs[i + 1] = resolved;
    }
  }
  const abs = whichTool("kubectl");
  if (abs === null) {
    return {
      ok: false, kind: "tool-absent", argv: ["kubectl", ...safeArgs], exitCode: null, stdout: "", stderr: "",
      reason: "未找到 kubectl CLI（降级车道：k8sManifestFor / terraformPlan 模板）。安装：https://kubernetes.io/docs/tasks/tools/#kubectl",
      tookMs: 0,
    };
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS);
  const argv = [abs, ...safeArgs];
  const t0 = Date.now();
  const r = spawnCaptured(argv, timeoutMs);
  const tookMs = Date.now() - t0;
  if (r === null) {
    return { ok: false, kind: "timeout", argv, exitCode: null, stdout: "", stderr: "", reason: `kubectl ${sub} 执行失败或超时（>${timeoutMs}ms）`, tookMs };
  }
  return {
    ok: r.exitCode === 0,
    ...(r.exitCode === 0 ? {} : { kind: "failed" as CloudRunKind }),
    argv, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
    ...(r.exitCode === 0 ? {} : { reason: `kubectl ${sub} 退出码 ${r.exitCode}（无 kubeconfig/集群不可达时常见 —— probeK8s().clusterReachable 可查）` }),
    tookMs,
  };
}

export type K8sManifestKind = "deployment" | "service" | "ingress" | "configmap" | "pvc";

/** manifest 模板族。 */
export const K8S_MANIFEST_KINDS: readonly K8sManifestKind[] = ["deployment", "service", "ingress", "configmap", "pvc"];

/**
 * K8s manifest 生产级模板（#72 降级车道主交付）：Deployment 带资源限额/
 * 双探针/securityContext/亲和性注释；Service/Ingress/ConfigMap/PVC 各自
 * 带口径注释。模板可直接 kubectl apply -f（路径须在工作区内 —— k8sRun 收监）。
 */
export function k8sManifestFor(kind: string): { kind: string; apiVersion: string; manifest: string; notes: string[] } {
  const k = String(kind ?? "").toLowerCase();
  const map: Record<K8sManifestKind, { apiVersion: string; manifest: string; notes: string[] }> = {
    deployment: {
      apiVersion: "apps/v1",
      manifest: `# org cloud manifest deployment —— 生产级 Deployment（资源限额 · 双探针 · 非 root · 滚动策略）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: app
spec:
  replicas: 3
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0        # 滚动期间不留容量空洞
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      securityContext:
        runAsNonRoot: true     # 拒绝 root 容器（准入层兜底）
        runAsUser: 10001
        fsGroup: 10001
      # 亲和性（按需启用）：节点反亲和把副本摊到不同节点 —— 单节点故障不连坐
      # affinity:
      #   podAntiAffinity:
      #     preferredDuringSchedulingIgnoredDuringExecution:
      #       - weight: 100
      #         podAffinityTerm:
      #           labelSelector:
      #             matchLabels: { app: app }
      #           topologyKey: kubernetes.io/hostname
      containers:
        - name: app
          image: registry.example.com/ns/app:1.0.0   # 钉版本 tag（避免 latest 浮动指针）
          ports:
            - containerPort: 8080
          resources:
            requests:                # 调度器的容量下限承诺
              cpu: 100m
              memory: 128Mi
            limits:                  # 硬帽（超限 OOMKill / CPU 限流）
              cpu: 500m
              memory: 256Mi
          livenessProbe:             # 存活探针：失败即重启
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:            # 就绪探针：失败摘出 Service 端点（不重启）
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 2
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true   # 只读根fs（可写目录用 emptyDir 卷）
            capabilities:
              drop: ["ALL"]
          # emptyDir 挂载点（readOnlyRootFilesystem 的配套）
          # volumeMounts:
          #   - name: tmp
          #     mountPath: /tmp
      # volumes:
      #   - name: tmp
      #     emptyDir: {}
`,
      notes: [
        "requests/limits 成对出现（无 limits 的容器可吃光节点内存）",
        "liveness 与 readiness 分离：存活=重启，就绪=摘流量",
        "readOnlyRootFilesystem + drop ALL capabilities：容器面最小权限",
      ],
    },
    service: {
      apiVersion: "v1",
      manifest: `# org cloud manifest service —— ClusterIP 服务（选择器联动 Deployment）
apiVersion: v1
kind: Service
metadata:
  name: app
  labels:
    app: app
spec:
  type: ClusterIP            # 集群内访问；对外暴露走 ingress（见 ingress 模板）
  selector:
    app: app                 # 与 Deployment 的 pod label 对齐
  ports:
    - name: http
      port: 80               # Service 暴露端口
      targetPort: 8080       # 容器端口（与 Deployment containerPort 对齐）
      protocol: TCP
  # sessionAffinity: ClientIP   # 需要会话粘滞时启用（注释态：多数应用无状态）
`,
      notes: [
        "selector 与 Deployment pod label 严格对齐 —— 摘不到端点先查这里",
        "port/targetPort 分离：Service 80 → 容器 8080 的映射惯例",
      ],
    },
    ingress: {
      apiVersion: "networking.k8s.io/v1",
      manifest: `# org cloud manifest ingress —— 入口路由（TLS 终止 + 按路径分服务）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app
  annotations:
    # cert-manager 自动签发（集群已装 cert-manager 时取消注释）
    # cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: 10m
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls    # cert-manager 维护（或手工 kubectl create secret tls）
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app    # 指向 Service metadata.name
                port:
                  number: 80
`,
      notes: [
        "pathType: Prefix 语义明确（ImplementationSpecific 是版本兼容坑）",
        "TLS secret 缺失时入口仍建得起来但握手失败 —— 先查 secret",
      ],
    },
    configmap: {
      apiVersion: "v1",
      manifest: `# org cloud manifest configmap —— 非敏感配置（敏感配置用 Secret，绝不进 ConfigMap）
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
  config.yaml: |
    server:
      port: 8080
      timeout_seconds: 30
    # 注意：密钥/令牌绝不放这里 —— ConfigMap 是明文（kubectl get -o yaml 全量可见）
`,
      notes: [
        "ConfigMap 明文可见 —— 敏感值走 Secret（base64 也不是加密，配合 RBAC 限读）",
        "yaml 子键用块标量 | —— 多行配置原样保留",
      ],
    },
    pvc: {
      apiVersion: "v1",
      manifest: `# org cloud manifest pvc —— 持久卷声明（按存储类动态供给）
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
spec:
  accessModes:
    - ReadWriteOnce          # RWO：单节点挂载（多节点并发读用 ReadOnlyMany）
  storageClassName: standard # 集群供给器名（kubectl get storageclass 查）
  resources:
    requests:
      storage: 10Gi
  # volumeMode: Filesystem    # 缺省；块设备裸给时用 Block
`,
      notes: [
        "storageClassName 对不上供给器 → PVC 永远 Pending",
        "缩容 PVC 不被支持（K8s 单向扩容）—— 初始容量按 12 个月预估",
      ],
    },
  };
  const hit = map[k as K8sManifestKind];
  if (!hit) {
    throw new Error(`未知 kind "${kind}"（支持：${K8S_MANIFEST_KINDS.join("/")}）`);
  }
  return { kind: k, apiVersion: hit.apiVersion, manifest: hit.manifest, notes: hit.notes };
}

/** terraformPlan（#72 降级车道）：main.tf 骨架（provider + 变量 + 输出）。 */
export function terraformPlan(provider = "aws"): { provider: string; mainTf: string; notes: string[] } {
  const p = String(provider ?? "aws").toLowerCase();
  const known: Record<string, { source: string; region: string; resource: string }> = {
    aws: { source: "hashicorp/aws", region: "ap-northeast-1", resource: 'aws_instance' },
    google: { source: "hashicorp/google", region: "asia-east1", resource: "google_compute_instance" },
    azurerm: { source: "hashicorp/azurerm", region: "japaneast", resource: "azurerm_linux_virtual_machine" },
  };
  const hit = known[p];
  const src = hit ? hit.source : `hashicorp/${p}`;
  const region = hit ? hit.region : "ap-northeast-1";
  const res = hit ? hit.resource : `${p}_example`;
  const mainTf = `# org cloud terraform —— main.tf 骨架（provider + 变量 + 输出）
# 密钥铁律：凭证走环境变量/凭证链（AWS_PROFILE / GOOGLE_APPLICATION_CREDENTIALS /
# ARM_*），**绝不硬编码进 .tf**（iacscan 的 tf-hardcoded-secret 规则扫的就是这个）

terraform {
  required_version = ">= 1.5"
  required_providers {
    ${src.split("/")[1]} = {
      source  = "${src}"
      version = "~> 5.0"          # 钉主版本（允许补丁升级，锁死 breaking change）
    }
  }
}

provider "${src.split("/")[1]}" {
  region = var.region            # 各家命名不同（google=zone/azurerm=location），按需调整
}

variable "region" {
  description = "部署区域"
  type        = string
  default     = "${region}"
}

variable "environment" {
  description = "环境名（prod/staging/dev —— 资源命名的公共前缀）"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment 只允许 prod/staging/dev。"
  }
}

variable "instance_type" {
  description = "机型（小起步，容量观测后再升）"
  type        = string
  default     = "t3.micro"
}

resource "${res}" "app" {
  # count/for_each 走变量驱动 —— 环境×区域的矩阵不写死
  count = 1

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"   # 云侧可识别 terraform 管理面（防手工误改）
  }
}

output "app_id" {
  description = "应用资源 ID（部署引用面）"
  value       = ${res === "aws_instance" ? "aws_instance.app[*].id" : `${res}.app[*].id`}
}

output "app_region" {
  value = var.region
}
`;
  return {
    provider: p,
    mainTf,
    notes: [
      "terraform init → plan（先看 diff）→ apply；destroy 刻意不在本模块任何车道",
      "state 文件含敏感快照 —— 远端 backend（S3/GCS + 锁）是生产姿势",
      "变量校验（validation 块）把环境名白名单钉进语言层",
    ],
  };
}

// ============================================================================
// #74 云服务 / 云 CLI 注册表
// ============================================================================

export interface CloudCliSpec {
  /** 稳定注册名（aws/gcloud/…）。 */
  name: string;
  /** CLI 可执行名（PATH 定位用）。 */
  cmd: string;
  /** 版本探活旗标（--version 或 version —— 各家 CLI 习惯不同）。 */
  probeFlag: string;
  /** 缺席时的安装指引。 */
  installHint: string;
  /** 官方文档入口。 */
  docsUrl: string;
}

/** 云 CLI 注册表（10 家：三大公有云 + 代码托管 + 五家应用平台/ niche 云）。 */
export const CLOUD_CLI_REGISTRY: readonly CloudCliSpec[] = [
  { name: "aws", cmd: "aws", probeFlag: "--version", installHint: "pip install awscli / brew install awscli / winget install AWS.AWSCLI", docsUrl: "https://docs.aws.amazon.com/cli/" },
  { name: "gcloud", cmd: "gcloud", probeFlag: "--version", installHint: "https://cloud.google.com/sdk/docs/install（brew install --cask google-cloud-sdk）", docsUrl: "https://cloud.google.com/sdk/gcloud" },
  { name: "az", cmd: "az", probeFlag: "--version", installHint: "https://learn.microsoft.com/cli/azure/install-azure-cli（brew install azure-cli）", docsUrl: "https://learn.microsoft.com/cli/azure/" },
  { name: "gh", cmd: "gh", probeFlag: "--version", installHint: "brew install gh / apt install gh / winget install GitHub.cli", docsUrl: "https://cli.github.com/" },
  { name: "vercel", cmd: "vercel", probeFlag: "--version", installHint: "npm i -g vercel", docsUrl: "https://vercel.com/docs/cli" },
  { name: "flyctl", cmd: "flyctl", probeFlag: "version", installHint: "brew install flyctl / curl -L https://fly.io/install.sh | sh", docsUrl: "https://fly.io/docs/flyctl/" },
  { name: "railway", cmd: "railway", probeFlag: "--version", installHint: "npm i -g @railway/cli", docsUrl: "https://railway.com/docs/cli" },
  { name: "heroku", cmd: "heroku", probeFlag: "--version", installHint: "npm i -g heroku", docsUrl: "https://devcenter.heroku.com/articles/heroku-cli" },
  { name: "doctl", cmd: "doctl", probeFlag: "version", installHint: "brew install doctl / apt install doctl", docsUrl: "https://docs.digitalocean.com/reference/doctl/" },
  { name: "oci", cmd: "oci", probeFlag: "--version", installHint: "https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm", docsUrl: "https://docs.oracle.com/iaas/Content/API/Concepts/cliconcepts.htm" },
];

export interface CloudCliProbe {
  name: string;
  available: boolean;
  version: string | null;
  installHint: string;
  docsUrl: string;
}

/** 批量探测 10 家云 CLI（which + 版本旗标各带超时；缺席即不 spawn）。 */
export function probeCloudClis(): CloudCliProbe[] {
  return CLOUD_CLI_REGISTRY.map((spec) => {
    const bin = whichTool(spec.cmd);
    if (bin === null) {
      return { name: spec.name, available: false, version: null, installHint: spec.installHint, docsUrl: spec.docsUrl };
    }
    const v = spawnCaptured([bin, spec.probeFlag], PROBE_VERSION_TIMEOUT_MS);
    if (v === null || v.exitCode !== 0) {
      return { name: spec.name, available: false, version: null, installHint: spec.installHint, docsUrl: spec.docsUrl };
    }
    return { name: spec.name, available: true, version: firstLine(v.stdout) || firstLine(v.stderr), installHint: spec.installHint, docsUrl: spec.docsUrl };
  });
}

/**
 * cloudProvidersOverview（#74 与 provider-registry 口径打通）：「模型服务商
 * 21 家 + 云 CLI 10 家」的全景 —— 两种生态都算 provider 面（推理面 + 基建面）。
 */
export function cloudProvidersOverview(): {
  modelProviders: number;
  cloudClis: number;
  total: number;
  providers: { name: string; label: string; local: boolean }[];
  clis: CloudCliProbe[];
} {
  return {
    modelProviders: PROVIDER_NAMES.length,
    cloudClis: CLOUD_CLI_REGISTRY.length,
    total: PROVIDER_NAMES.length + CLOUD_CLI_REGISTRY.length,
    providers: PROVIDER_NAMES.map((n) => ({ name: n, label: PROVIDERS[n]!.label, local: PROVIDERS[n]!.local === true })),
    clis: probeCloudClis(),
  };
}

// ============================================================================
// 统一探测总入口（Web/CLI/工具环三端共用 —— 单一实现防口径漂移）
// ============================================================================

export interface CloudProbeAll {
  docker: DockerProbe;
  ssh: SshProbe;
  k8s: K8sProbe;
  terraform: TerraformProbe;
  clis: CloudCliProbe[];
  /** 各面可用计数（观测摘要：探测到几台引擎/几把 CLI）。 */
  summary: { dockerAvailable: boolean; dockerDaemon: boolean; sshAvailable: boolean; k8sAvailable: boolean; k8sCluster: boolean; terraformAvailable: boolean; clisAvailable: number; clisTotal: number };
  tookMs: number;
}

/** 一发全景探测：docker / ssh / k8s / terraform / clis[]（五键齐全）。 */
export function cloudProbeAll(): CloudProbeAll {
  const t0 = Date.now();
  const docker = probeDocker();
  const ssh = probeSsh();
  const k8s = probeK8s();
  const terraform = probeTerraform();
  const clis = probeCloudClis();
  const tookMs = Date.now() - t0;
  return {
    docker, ssh, k8s, terraform, clis,
    summary: {
      dockerAvailable: docker.available,
      dockerDaemon: docker.daemonReachable,
      sshAvailable: ssh.available,
      k8sAvailable: k8s.available,
      k8sCluster: k8s.clusterReachable,
      terraformAvailable: terraform.available,
      clisAvailable: clis.filter((c) => c.available).length,
      clisTotal: clis.length,
    },
    tookMs,
  };
}
