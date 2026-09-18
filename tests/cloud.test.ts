// ============================================================================
// tests/cloud.test.ts — 云生态统一模块（v0.5.17 · capabilities #67/#68/#72/#74）
// ----------------------------------------------------------------------------
// 五层锁定（tests/iacscan.test.ts / plugins.test.ts 同构风格）：
//   1. 探测降级：PATH 置空宇宙（docker/ssh/k8s/terraform/云 CLI 全缺席）→
//      available:false + 人读 reason + 安装指引 —— 沙箱降级车道即主车道，
//      诚实边界必须可断言；
//   2. 白名单哲学：docker system prune / kubectl delete / terraform 面拒绝
//      （kind:"denied" 先于 tool-absent —— **拒绝发生在任何 spawn 之前**，
//      PATH 置空下仍返回 denied 即证明不 spawn）；
//   3. 模板车道：Dockerfile 四型（FROM/USER/HEALTHCHECK 关键行 + 过本仓库
//      iacscan 自检 —— 模板不带高危反模式）· compose · K8s manifest 五族
//      （apiVersion/kind/资源限额字段）· terraform 骨架 · ssh-config 模板；
//   4. #68 host 白名单门控：无 ssh-hosts.allow → 拒绝 + 创建指引；白名单内
//      host → sshArgv 断言（BatchMode/ConnectTimeout/StrictHostKeyChecking
//      在 args 里）；scp local 路径越界 → jail 拒绝；
//   5. 注册表与总入口：10 家云 CLI 完整性 · cloudProbeAll 五键齐全 ·
//      cloudProvidersOverview 21+10 全景联动。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DOCKER_SUBCOMMANDS, dockerRun, dockerBuild, dockerfileFor, DOCKERFILE_TYPES, composeFor, dockerPlan, DOCKER_PLAN_ACTIONS,
  probeDocker, probeSsh, probeK8s, probeTerraform, sshArgv, scpArgv, sshRun, scpUpload, sshHostAllowed, sshConfigTemplate, sshPlan, SSH_HOSTS_ALLOW,
  K8S_SUBCOMMANDS, k8sRun, k8sManifestFor, K8S_MANIFEST_KINDS, terraformPlan,
  CLOUD_CLI_REGISTRY, probeCloudClis, cloudProvidersOverview, cloudProbeAll, whichTool,
} from "../lib/cloud.ts";
import { scanIac } from "../lib/iacscan.ts";
import { TEST_RUN, runDhv, runOrg, eventsOf } from "./helpers";
import { startWebServer } from "../web/entry.ts";

function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-cloud-${tag}-`));
}

function w(ws: string, rel: string, content: string): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** PATH 置空宇宙（与 tests/plugins.test.ts / browser.test.ts 同规）。 */
function withEmptyPath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

// ---- 1. 探测降级（PATH 置空宇宙）--------------------------------------------------

describe("云生态：探测降级（无工具宇宙）", () => {
  test("probeDocker：PATH 置空 → available:false + version:null + reason 含安装指引", () => {
    const p = withEmptyPath(() => probeDocker());
    expect(p.available).toBe(false);
    expect(p.version).toBeNull();
    expect(p.daemonReachable).toBe(false);
    expect(p.reason).toBeTruthy();
    expect(p.reason).toContain("docker");
    expect(p.reason).toContain("dockerfileFor"); // 降级车道在指引里
  }, 30_000);

  test("probeSsh：PATH 置空 → available:false + reason；不 throw", () => {
    const p = withEmptyPath(() => probeSsh());
    expect(p.available).toBe(false);
    expect(p.version).toBeNull();
    expect(typeof p.sshDirExists).toBe("boolean");
    expect(typeof p.configExists).toBe("boolean");
    expect(typeof p.knownHostsExists).toBe("boolean");
    expect(p.reason).toContain("ssh");
  }, 30_000);

  test("probeSsh 绝不读私钥：结果面只有三个布尔（无任何密钥文件名字段）", () => {
    const p = probeSsh();
    const keys = Object.keys(p);
    expect(keys).toContain("sshDirExists");
    expect(keys).toContain("configExists");
    expect(keys).toContain("knownHostsExists");
    for (const k of keys) expect(/key|secret|priv/i.test(k)).toBe(false);
  }, 30_000);

  test("probeK8s / probeTerraform：PATH 置空 → 双缺席 + 指引指向模板车道", () => {
    const k = withEmptyPath(() => probeK8s());
    expect(k.available).toBe(false);
    expect(k.clusterReachable).toBe(false);
    expect(k.reason).toContain("kubectl");
    expect(k.reason).toContain("k8sManifestFor");
    const t = withEmptyPath(() => probeTerraform());
    expect(t.available).toBe(false);
    expect(t.reason).toContain("terraform");
    expect(t.reason).toContain("terraformPlan");
  }, 30_000);
});

// ---- 2. 白名单哲学（拒绝先于 spawn）-----------------------------------------------

describe("云生态：白名单门控", () => {
  test("dockerRun：system prune 拒绝（kind:denied）且先于 tool-absent —— 无工具宇宙也返回 denied（证明不 spawn）", () => {
    const r = withEmptyPath(() => dockerRun("system", ["prune", "-af"]));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied"); // 若先 spawn 会是 tool-absent —— denied 即证明拒绝发生在探测/spawn 之前
    expect(r.reason).toContain("白名单");
    expect(r.reason).toContain("system prune");
    expect(r.tookMs).toBe(0);
    expect(r.argv).toEqual(["docker", "system", "prune", "-af"]);
  }, 30_000);

  test("dockerRun：白名单外子命令逐个拒绝（kill/exec/cp/save/load/volume/network/swarm）", () => {
    for (const bad of ["kill", "exec", "cp", "save", "load", "volume", "network", "swarm", "node", "service", "stack", "container", "image", "builder", "", "rm\nrm"]) {
      const r = withEmptyPath(() => dockerRun(bad, []));
      expect(r.kind).toBe("denied");
    }
  }, 30_000);

  test("dockerRun：参数含换行（多命令注入形态）拒绝；分号元素在数组参数下无害放行（零 shell 面）", () => {
    const r = withEmptyPath(() => dockerRun("ps", ["x\nrm -rf /", "-a"]));
    expect(r.kind).toBe("denied");
    expect(r.reason).toContain("换行");
    // 数组参数下 ";rm" 只是普通 argv 元素 —— 不经 shell 解释，放行到 tool-absent
    const arr = withEmptyPath(() => dockerRun("ps", [";rm"]));
    expect(arr.kind).toBe("tool-absent");
  }, 30_000);

  test("dockerRun：白名单内子命令 + PATH 置空 → tool-absent（诚实降级 + 降级车道指引）", () => {
    for (const good of DOCKER_SUBCOMMANDS) {
      const r = withEmptyPath(() => dockerRun(good, []));
      expect(r.kind).toBe("tool-absent");
      expect(r.reason).toContain("dockerfile"); // 降级车道指引（dockerfile/compose/plan）
    }
  }, 30_000);

  test("dockerRun 白名单内容：16 子命令在册，不含 system/kill/exec/delete", () => {
    expect(DOCKER_SUBCOMMANDS).toEqual([
      "version", "info", "ps", "images", "build", "run", "create", "start", "stop",
      "rm", "rmi", "logs", "inspect", "pull", "tag", "push",
    ]);
    for (const banned of ["system", "prune", "kill", "exec", "cp", "save", "load", "swarm"]) {
      expect(DOCKER_SUBCOMMANDS.includes(banned)).toBe(false);
    }
  }, 30_000);

  test("k8sRun：delete namespace 拒绝（denied 先于 tool-absent）；白名单内 get → tool-absent", () => {
    const del = withEmptyPath(() => k8sRun("/tmp", ["delete", "namespace", "prod"]));
    expect(del.ok).toBe(false);
    expect(del.kind).toBe("denied");
    expect(del.reason).toContain("delete");
    const edit = withEmptyPath(() => k8sRun("/tmp", ["edit", "deploy/app"]));
    expect(edit.kind).toBe("denied");
    const good = withEmptyPath(() => k8sRun("/tmp", ["get", "pods"]));
    expect(good.kind).toBe("tool-absent"); // 白名单过了才轮到工具缺席
  }, 30_000);

  test("k8sRun：apply -f 路径越界 → jail 拒绝（先于 tool-absent）；-f -（stdin）拒绝", () => {
    const ws = tmpWs("k8s-jail");
    try {
      const esc = withEmptyPath(() => k8sRun(ws, ["apply", "-f", "../../etc/passwd"]));
      expect(esc.kind).toBe("jail");
      expect(esc.reason).toContain("越界");
      const stdin = withEmptyPath(() => k8sRun(ws, ["apply", "-f", "-"]));
      expect(stdin.kind).toBe("denied");
      expect(stdin.reason).toContain("stdin");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("k8sRun：apply -f 工作区内路径放行（改写为绝对路径后进 tool-absent 车道）", () => {
    const ws = tmpWs("k8s-in");
    try {
      w(ws, "deploy.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ok\n");
      const r = withEmptyPath(() => k8sRun(ws, ["apply", "-f", "deploy.yaml"]));
      expect(r.kind).toBe("tool-absent");
      // argv 里 -f 的值已被解析为工作区绝对路径（监狱改写后透传）
      const i = r.argv.indexOf("-f");
      expect(r.argv[i + 1]).toBe(path.join(ws, "deploy.yaml"));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 3. 模板车道（#67/#72/#68 降级主交付）------------------------------------------

describe("云生态：Dockerfile 模板四型", () => {
  test("四型齐全：node/bun/python/rust —— 多阶段（≥2 个 FROM）+ 非 root USER + HEALTHCHECK + 钉版本", () => {
    expect(DOCKERFILE_TYPES).toEqual(["node", "bun", "python", "rust"]);
    for (const t of DOCKERFILE_TYPES) {
      const r = dockerfileFor(t);
      expect(r.projectType).toBe(t);
      const lines = r.dockerfile.split("\n");
      // 多阶段构建
      const froms = lines.filter((l) => /^FROM /i.test(l));
      expect(froms.length).toBeGreaterThanOrEqual(2);
      // 钉版本标签（无 :latest 浮动指针）
      for (const f of froms) expect(f).not.toMatch(/:latest\b/);
      // 非 root 用户
      expect(lines.some((l) => /^USER /i.test(l) && !/root/i.test(l))).toBe(true);
      // healthcheck
      expect(lines.some((l) => /^HEALTHCHECK /i.test(l))).toBe(true);
      // 采纳建议非空
      expect(r.notes.length).toBeGreaterThan(0);
    }
  }, 30_000);

  test("模板过本仓库 iacscan 自检（生成物不带高危反模式 —— 双模块一致性）", () => {
    const ws = tmpWs("dk-self");
    try {
      for (const t of DOCKERFILE_TYPES) w(ws, `Dockerfile.${t}`, dockerfileFor(t).dockerfile);
      w(ws, "docker-compose.yml", composeFor({ appName: "app" }).compose);
      w(ws, "main.tf", terraformPlan("aws").mainTf);
      const r = scanIac(ws);
      expect(r.hits).toEqual([]); // 自家模板必须过自家扫描器
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("未知 projectType → 明确报错（不静默给错模板）", () => {
    expect(() => dockerfileFor("java")).toThrow("node/bun/python/rust");
  }, 30_000);

  test("composeFor：服务 + 专用网络 + 具名卷 + healthcheck；无 privileged/docker.sock/host 网络", () => {
    const r = composeFor({ appName: "my app", port: 3000 });
    expect(r.compose).toContain("services:");
    expect(r.compose).toContain("networks:");
    expect(r.compose).toContain("volumes:");
    expect(r.compose).toContain("healthcheck:");
    expect(r.compose).toContain("restart: unless-stopped");
    expect(r.compose).toContain('"3000:3000"'); // 端口映射生效（自定义端口）
    expect(r.compose).not.toContain("privileged");
    expect(r.compose).not.toContain("docker.sock");
    expect(r.compose).not.toContain("network_mode: host");
    // appName 净化为安全标识符
    expect(r.compose).toContain("my-app:");
  }, 30_000);

  test("dockerPlan 五意图：每步命令 + 安全注释；cleanup 刻意排除 system prune", () => {
    expect(DOCKER_PLAN_ACTIONS).toEqual(["build", "run", "push", "debug", "cleanup"]);
    for (const a of DOCKER_PLAN_ACTIONS) {
      const p = dockerPlan(a);
      expect(p.steps.length).toBeGreaterThanOrEqual(3);
      for (const s of p.steps) {
        expect(s.cmd.length).toBeGreaterThan(0);
        expect(s.note.length).toBeGreaterThan(0);
      }
    }
    const cu = dockerPlan("cleanup");
    expect(cu.warning).toContain("system prune");
    for (const s of cu.steps) expect(s.cmd).not.toMatch(/system\s+prune/);
    const push = dockerPlan("push");
    expect(push.warning).toContain("密钥");
    expect(() => dockerPlan("deploy")).toThrow();
  }, 30_000);
});

describe("云生态：K8s manifest 五族 + terraform 骨架", () => {
  test("Deployment：apps/v1 · 资源限额 requests/limits · liveness/readiness 双探针 · runAsNonRoot", () => {
    const m = k8sManifestFor("deployment");
    expect(m.kind).toBe("deployment");
    expect(m.apiVersion).toBe("apps/v1");
    expect(m.manifest).toContain("kind: Deployment");
    expect(m.manifest).toContain("resources:");
    expect(m.manifest).toContain("requests:");
    expect(m.manifest).toContain("limits:");
    expect(m.manifest).toContain("livenessProbe:");
    expect(m.manifest).toContain("readinessProbe:");
    expect(m.manifest).toContain("runAsNonRoot: true");
    expect(m.manifest).toContain("affinity"); // 亲和性注释块在册
    expect(m.manifest).not.toMatch(/image:.*:latest/); // 钉版本镜像
  }, 30_000);

  test("Service/Ingress/ConfigMap/PVC：apiVersion/kind 口径 + 关键字段", () => {
    const svc = k8sManifestFor("service");
    expect(svc.apiVersion).toBe("v1");
    expect(svc.manifest).toContain("kind: Service");
    expect(svc.manifest).toContain("selector:");
    expect(svc.manifest).toContain("targetPort:");
    const ing = k8sManifestFor("ingress");
    expect(ing.apiVersion).toBe("networking.k8s.io/v1");
    expect(ing.manifest).toContain("kind: Ingress");
    expect(ing.manifest).toContain("ingressClassName:");
    expect(ing.manifest).toContain("tls:");
    const cm = k8sManifestFor("configmap");
    expect(cm.apiVersion).toBe("v1");
    expect(cm.manifest).toContain("kind: ConfigMap");
    expect(cm.manifest).toContain("data:");
    expect(cm.manifest).toContain("Secret"); // 敏感值走 Secret 的注释提醒
    const pvc = k8sManifestFor("pvc");
    expect(pvc.apiVersion).toBe("v1");
    expect(pvc.manifest).toContain("kind: PersistentVolumeClaim");
    expect(pvc.manifest).toContain("storageClassName:");
    expect(pvc.manifest).toContain("accessModes:");
    expect(K8S_MANIFEST_KINDS).toEqual(["deployment", "service", "ingress", "configmap", "pvc"]);
    expect(() => k8sManifestFor("cronjob")).toThrow();
  }, 30_000);

  test("terraformPlan：terraform/provider/variable/output 四件套 + 密钥铁律注释", () => {
    const t = terraformPlan("aws");
    expect(t.provider).toBe("aws");
    expect(t.mainTf).toMatch(/^terraform \{/m);
    expect(t.mainTf).toMatch(/^provider "/m);
    expect(t.mainTf).toMatch(/^variable "/m);
    expect(t.mainTf).toMatch(/^output "/m);
    expect(t.mainTf).toContain("required_providers");
    expect(t.mainTf).toContain("绝不硬编码");
    expect(t.mainTf).not.toMatch(/(access_key|secret_key)\s*=\s*"[^$]/); // 无硬编码密钥形态
    const g = terraformPlan("google");
    expect(g.mainTf).toContain("hashicorp/google");
  }, 30_000);
});

// ---- 4. #68 host 白名单门控 --------------------------------------------------------

describe("云生态：SSH host 白名单门控", () => {
  test("无 ssh-hosts.allow → 拒绝 + 创建指引（host-not-allowed）", () => {
    const ws = tmpWs("ssh-noallow");
    try {
      const r = withEmptyPath(() => sshRun(ws, "deploy.example.com", "uptime"));
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("host-not-allowed");
      expect(r.reason).toContain(SSH_HOSTS_ALLOW);
      expect(r.reason).toContain("deploy.example.com"); // 指引示例含该 host 形态
      expect(r.reason).toContain("拒绝一切远程执行");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("白名单文件在但 host 不在内 → 拒绝（不误伤文件已创建的场景）", () => {
    const ws = tmpWs("ssh-mismatch");
    try {
      w(ws, SSH_HOSTS_ALLOW, "# 允许清单\njump.internal\n");
      const r = withEmptyPath(() => sshRun(ws, "evil.example.com", "cat /etc/passwd"));
      expect(r.kind).toBe("host-not-allowed");
      expect(r.reason).toContain("不在");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("白名单内 host + PATH 置空 → tool-absent（门控放行后才轮到工具缺席）；# 注释行/空行被忽略", () => {
    const ws = tmpWs("ssh-allow");
    try {
      w(ws, SSH_HOSTS_ALLOW, "# 注释行\n\njump.internal\ndeploy.example.com\n");
      expect(sshHostAllowed(ws, "jump.internal").allowed).toBe(true);
      expect(sshHostAllowed(ws, "deploy.example.com").allowed).toBe(true);
      expect(sshHostAllowed(ws, "jump").allowed).toBe(false); // 不做前缀匹配
      expect(sshHostAllowed(ws, "#").allowed).toBe(false);
      const r = withEmptyPath(() => sshRun(ws, "deploy.example.com", "uptime"));
      expect(r.kind).toBe("tool-absent");
      expect(r.reason).toContain("sshConfigTemplate"); // 降级车道指引
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("sshArgv：BatchMode/ConnectTimeout/StrictHostKeyChecking 全在参数数组里（零 shell 拼接）", () => {
    const argv = sshArgv("deploy.example.com", "uptime");
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-o");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("ConnectTimeout=10");
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    expect(argv[argv.length - 2]).toBe("deploy.example.com");
    expect(argv[argv.length - 1]).toBe("uptime");
    // scp 同安全旗标
    const sargv = scpArgv("h", "/tmp/a", "/remote/b");
    expect(sargv).toContain("BatchMode=yes");
    expect(sargv[sargv.length - 1]).toBe("h:/remote/b");
  }, 30_000);

  test("host 形态守卫：空白/前导 - 拒绝（ssh 选项注入面）", () => {
    const ws = tmpWs("ssh-shape");
    try {
      w(ws, SSH_HOSTS_ALLOW, "ok.internal\n");
      for (const bad of ["-oProxyCommand=evil", "a b", ""]) {
        const r = withEmptyPath(() => sshRun(ws, bad, "uptime"));
        expect(r.kind).toBe("host-not-allowed");
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("scpUpload：local 路径越界 → jail；remote 路径含 shell 元字符 → denied", () => {
    const ws = tmpWs("scp-jail");
    try {
      w(ws, SSH_HOSTS_ALLOW, "jump.internal\n");
      const esc = withEmptyPath(() => scpUpload(ws, "jump.internal", "../../etc/passwd", "/tmp/x"));
      expect(esc.kind).toBe("jail");
      expect(esc.reason).toContain("越界");
      const meta = withEmptyPath(() => scpUpload(ws, "jump.internal", "a.txt", "/tmp/$(rm -rf /)"));
      expect(meta.kind).toBe("denied");
      const dash = withEmptyPath(() => scpUpload(ws, "jump.internal", "a.txt", "-oProxyCommand=x"));
      expect(dash.kind).toBe("denied");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("sshConfigTemplate / sshPlan：模板面完整（密钥/跳板机建议 + 五步计划）", () => {
    const t = sshConfigTemplate();
    expect(t.config).toContain("Host deploy");
    expect(t.config).toContain("ProxyJump");
    expect(t.config).toContain("IdentitiesOnly yes");
    expect(t.advice.some((a) => a.includes("密钥"))).toBe(true);
    expect(t.advice.some((a) => a.includes("ForwardAgent"))).toBe(true);
    const p = sshPlan("deploy.example.com", "uptime");
    expect(p.steps.length).toBeGreaterThanOrEqual(5);
    expect(p.steps.some((s) => s.cmd.includes("BatchMode=yes"))).toBe(true);
    expect(p.steps.some((s) => s.cmd.includes(SSH_HOSTS_ALLOW))).toBe(true);
  }, 30_000);
});

// ---- 5. #74 注册表 + 统一总入口 -----------------------------------------------------

describe("云生态：云 CLI 注册表与全景联动", () => {
  test("10 家注册表完整性：name/cmd/probeFlag/installHint/docsUrl 全非空且 name 唯一", () => {
    expect(CLOUD_CLI_REGISTRY.length).toBe(10);
    expect(new Set(CLOUD_CLI_REGISTRY.map((c) => c.name)).size).toBe(10);
    expect(CLOUD_CLI_REGISTRY.map((c) => c.name)).toEqual([
      "aws", "gcloud", "az", "gh", "vercel", "flyctl", "railway", "heroku", "doctl", "oci",
    ]);
    for (const c of CLOUD_CLI_REGISTRY) {
      expect(c.cmd.length).toBeGreaterThan(0);
      expect(c.probeFlag.length).toBeGreaterThan(0);
      expect(c.installHint.length).toBeGreaterThan(0);
      expect(c.docsUrl.startsWith("https://")).toBe(true);
    }
    // 探测旗标两形态都在册（--version 与 version）
    expect(CLOUD_CLI_REGISTRY.some((c) => c.probeFlag === "--version")).toBe(true);
    expect(CLOUD_CLI_REGISTRY.some((c) => c.probeFlag === "version")).toBe(true);
  }, 30_000);

  test("probeCloudClis：PATH 置空 → 10 家全缺席 + installHint 保留；输出形状稳定", () => {
    const clis = withEmptyPath(() => probeCloudClis());
    expect(clis.length).toBe(10);
    for (const c of clis) {
      expect(c.available).toBe(false);
      expect(c.version).toBeNull();
      expect(c.installHint.length).toBeGreaterThan(0);
      expect(c.docsUrl.startsWith("https://")).toBe(true);
    }
  }, 30_000);

  test("cloudProvidersOverview：模型服务商 21 家 + 云 CLI 10 家全景联动（#74 口径）", () => {
    const o = withEmptyPath(() => cloudProvidersOverview());
    expect(o.modelProviders).toBe(21);
    expect(o.cloudClis).toBe(10);
    expect(o.total).toBe(31);
    expect(o.providers.length).toBe(21);
    expect(o.providers.some((p) => p.name === "deepseek")).toBe(true);
    expect(o.providers.some((p) => p.local === true)).toBe(true); // ollama/lmstudio/vllm
    expect(o.clis.length).toBe(10);
  }, 30_000);

  test("cloudProbeAll：五键齐全（docker/ssh/k8s/terraform/clis）+ summary 观测面", () => {
    const r = withEmptyPath(() => cloudProbeAll());
    for (const k of ["docker", "ssh", "k8s", "terraform", "clis", "summary", "tookMs"]) {
      expect(r).toHaveProperty(k);
    }
    expect(r.clis.length).toBe(10);
    expect(r.summary.clisTotal).toBe(10);
    expect(typeof r.summary.dockerAvailable).toBe("boolean");
    expect(typeof r.summary.k8sCluster).toBe("boolean");
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("whichTool：PATH 置空 → null（定位器本体的降级语义）", () => {
    expect(withEmptyPath(() => whichTool("docker"))).toBeNull();
    expect(withEmptyPath(() => whichTool("kubectl"))).toBeNull();
  }, 30_000);
});

// ---- 6. dockerBuild 高层封装（jail 面）----------------------------------------------

describe("云生态：dockerBuild 路径监狱", () => {
  test("build context 越界 → jail；Dockerfile 越界 → jail；界内放行进 tool-absent", () => {
    const ws = tmpWs("dkb");
    try {
      w(ws, "Dockerfile", "FROM alpine:3.19\nUSER app\n");
      const ctxEsc = withEmptyPath(() => dockerBuild(ws, "..", {}));
      expect(ctxEsc.kind).toBe("jail");
      expect(ctxEsc.reason).toContain("build context");
      const dfEsc = withEmptyPath(() => dockerBuild(ws, ".", { dockerfile: "../secret/Dockerfile" }));
      expect(dfEsc.kind).toBe("jail");
      expect(dfEsc.reason).toContain("Dockerfile");
      const ok = withEmptyPath(() => dockerBuild(ws, ".", { dockerfile: "Dockerfile", tag: "app:1.0.0" }));
      expect(ok.kind).toBe("tool-absent"); // 监狱放行 → 工具缺席降级
      expect(ok.argv.join(" ")).toContain("-t app:1.0.0");
      expect(ok.argv.join(" ")).toContain("-f Dockerfile");
      const nl = withEmptyPath(() => dockerBuild(ws, ".", { tag: "x\ny" }));
      expect(nl.kind).toBe("denied");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 7. 工具环 e2e（scripted 剧本驱动直连车道全链，wiring2 同款）--------------------

const WS_ROOT = path.join(TEST_RUN, "cloud-ws");
const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");
let wsSeq = 0;
let WS = "";

describe("云生态：工具环 e2e（cloud_* 六工具）", () => {
  test("cloud_probe（只读模式可用）：全景五面 + clis=0/10 可观测", () => {
    WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    const fixture = path.join(TEST_RUN, `cloud-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"cloud_probe","args":{}}</tool>',
        "最终答案：全景探测完成。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-cloud", "probe");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 云生态探测",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "cloud", ORG_ASK_QUESTION: "探测", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("cloud_probe ok");
    expect(tr[0]).toContain("clis=0/10"); // 沙箱 10 家全缺席 —— 诚实可观测
    expect(tr[0]).toContain("docker=✗");
  }, 120_000);

  test("cloud_dockerfile（只读模式可用）：node 模板四要素可观测", () => {
    WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    const fixture = path.join(TEST_RUN, `cloud-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"cloud_dockerfile","args":{"project_type":"python"}}</tool>',
        "最终答案：模板已生成。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-cloud", "dockerfile");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) Dockerfile 模板",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "cloud", ORG_ASK_QUESTION: "模板", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
    expect(tr.length).toBe(1);
    expect(tr[0]).toContain("cloud_dockerfile ok python 模板");
    expect(tr[0]).toContain("多阶段");
  }, 120_000);

  test("cloud_docker 审批放行后 system prune 仍被 lib 白名单拒绝（拒绝先于 spawn）+ cloud_ssh host 门控", () => {
    WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    // 预置长期放行集（process_spawn —— cloud_docker/cloud_ssh/cloud_k8s 的门）
    fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["process_spawn"] }));
    const fixture = path.join(TEST_RUN, `cloud-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"cloud_docker","args":{"args":["system","prune","-af"]}}</tool>',
        '<tool>{"name":"cloud_ssh","args":{"host":"evil.example.com","command":"cat /etc/passwd"}}</tool>',
        "最终答案：均被拒。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-cloud", "deny");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 白名单拒绝",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "cloud", ORG_ASK_QUESTION: "拒绝", ORG_TOOLS: "write", ORG_APPROVAL: "1" });
    expect(r.ok).toBe(true);
    const tr = eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
    expect(tr.length).toBe(2);
    // 能力门放行（granted process_spawn）→ lib 白名单仍拒绝 —— 双层治理可观测
    expect(tr[0]).toContain("cloud_docker error [denied]");
    expect(tr[0]).toContain("白名单");
    // host 不在 ssh-hosts.allow（文件不存在）→ host-not-allowed
    expect(tr[1]).toContain("cloud_ssh error [host-not-allowed]");
    expect(tr[1]).toContain(SSH_HOSTS_ALLOW);
  }, 120_000);
});

// ---- 8. CLI 冒烟（runOrg 真子进程）--------------------------------------------------

describe("云生态：CLI 冒烟（org cloud）", () => {
  test("org cloud probe：全景输出 + 降级车道指引；org cloud clis 10 家表", () => {
    const p = runOrg(["cloud", "probe"]);
    expect(p.ok).toBe(true);
    expect(p.stdout).toContain("云生态全景探测");
    expect(p.stdout).toContain("docker");
    expect(p.stdout).toContain("terraform");
    expect(p.stdout).toContain("0/10 家在场");
    expect(p.stdout).toContain("降级车道即主车道");
    const c = runOrg(["cloud", "clis"]);
    expect(c.ok).toBe(true);
    expect(c.stdout).toContain("aws");
    expect(c.stdout).toContain("oci");
    expect(c.stdout).toContain("云 CLI 注册表");
  }, 120_000);

  test("org cloud dockerfile node：模板四要素 + 过 iacscan 自检说明；org cloud manifest deployment", () => {
    const d = runOrg(["cloud", "dockerfile", "node"]);
    expect(d.ok).toBe(true);
    expect(d.stdout).toContain("FROM node:22-alpine AS build");
    expect(d.stdout).toContain("USER node");
    expect(d.stdout).toContain("HEALTHCHECK");
    expect(d.stdout).toContain("多阶段");
    const m = runOrg(["cloud", "manifest", "deployment"]);
    expect(m.ok).toBe(true);
    expect(m.stdout).toContain("kind: Deployment");
    expect(m.stdout).toContain("resources:");
    expect(m.stdout).toContain("livenessProbe:");
  }, 120_000);

  test("org cloud docker system prune：CLI 白名单拒绝 exit 1 + 不 spawn 证明", () => {
    const r = runOrg(["cloud", "docker", "system", "prune"]);
    expect(r.ok).toBe(false); // exit 1（拒绝）
    expect(r.stderr).toContain("白名单拒绝");
    expect(r.stderr).toContain("system prune");
    expect(r.stderr).toContain("零 shell 面");
  }, 120_000);

  test("org cloud ssh 无白名单文件 → host-not-allowed + 创建指引", () => {
    const ws = tmpWs("cli-ssh");
    try {
      const r = runOrg(["cloud", "ssh", "deploy.example.com", "uptime", "--workspace", ws]);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("host 未获放行");
      expect(r.stderr).toContain(SSH_HOSTS_ALLOW);
      expect(r.stderr).toContain("拒绝一切远程执行");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---- 9. Web 端点 e2e（startWebServer · port 0 随机，web.test.ts 同款）--------------

describe("云生态：Web /api/govex/cloud 端点", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;

  beforeAll(() => {
    ws = path.join(TEST_RUN, "cloud-web-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), ws, { recursive: true });
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.port).toBeGreaterThan(1024);
  }, 120_000);

  afterAll(() => {
    server.stop(true);
  });

  test("GET action=probe：五键齐全 + 模板车道提示；action=clis 10 家表", async () => {
    const j = (await (await fetch(`${base}/api/govex/cloud?action=probe`)).json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    for (const k of ["docker", "ssh", "k8s", "terraform", "clis", "summary", "took_ms"]) expect(j).toHaveProperty(k);
    expect(j.hint).toContain("模板车道");
    expect(Array.isArray(j.clis)).toBe(true);
    expect((j.clis as unknown[]).length).toBe(10);
    const c = (await (await fetch(`${base}/api/govex/cloud?action=clis`)).json()) as Record<string, unknown>;
    expect(c.ok).toBe(true);
    expect(c.total).toBe(10);
  }, 60_000);

  test("GET action=dockerfile&project=python / manifest&kind=deployment / terraform：模板内容送达", async () => {
    const d = (await (await fetch(`${base}/api/govex/cloud?action=dockerfile&project=python`)).json()) as Record<string, unknown>;
    expect(d.ok).toBe(true);
    expect(String(d.dockerfile)).toContain("FROM python:3.12-slim AS build");
    expect(String(d.dockerfile)).toContain("USER appuser");
    const m = (await (await fetch(`${base}/api/govex/cloud?action=manifest&kind=deployment`)).json()) as Record<string, unknown>;
    expect(m.ok).toBe(true);
    expect(String(m.manifest)).toContain("kind: Deployment");
    expect(String(m.manifest)).toContain("livenessProbe:");
    const t = (await (await fetch(`${base}/api/govex/cloud?action=terraform&provider=aws`)).json()) as Record<string, unknown>;
    expect(t.ok).toBe(true);
    expect(String(t.mainTf)).toContain("required_providers");
    const bad = (await (await fetch(`${base}/api/govex/cloud?action=dockerfile&project=java`)).json()) as Record<string, unknown>;
    expect(bad.ok).toBe(false);
  }, 60_000);

  test("POST docker system prune → kind:denied（白名单拒绝，不 spawn）；POST ssh → host-not-allowed", async () => {
    const d = (await (await fetch(`${base}/api/govex/cloud`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "docker", args: ["system", "prune", "-af"] }),
    })).json()) as Record<string, unknown>;
    expect(d.ok).toBe(false);
    expect(d.kind).toBe("denied");
    expect(String(d.reason)).toContain("白名单");
    const s = (await (await fetch(`${base}/api/govex/cloud`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "ssh", host: "evil.example.com", command: "uptime" }),
    })).json()) as Record<string, unknown>;
    expect(s.ok).toBe(false);
    expect(s.kind).toBe("host-not-allowed");
    expect(String(s.reason)).toContain(SSH_HOSTS_ALLOW);
    const k = (await (await fetch(`${base}/api/govex/cloud`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "k8s", args: ["delete", "namespace", "prod"] }),
    })).json()) as Record<string, unknown>;
    expect(k.kind).toBe("denied");
  }, 60_000);
});
