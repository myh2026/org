// ============================================================================
// fixtures/sast/bad-sample.ts — SAST 坏样本 · TS 侧（#146 · v0.5.22）
// ----------------------------------------------------------------------------
// 与 bad-sample.py 同族的 5 类危险模式（测试专用语料，密钥为假样例形状）：
// 内置 TS 规则面（eval/new Function / SQL 模板字面量拼接 / exec 模板拼接 /
// Math.random 做 token / 硬编码密钥）。ruff 车道只覆盖 Python —— TS 侧由
// 内置降级规则引擎兜底（这正是降级链的「永远有产出」半面）。
// ============================================================================

// ① 硬编码密钥（三形态假样例）
export const API_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
export const GH_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
export const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

// ② eval / new Function 动态执行（注入面）
export function runUserCode(code: string): unknown {
  return eval(code);
}
export function buildFn(body: string): Function {
  return new Function("x", body);
}

// ③ SQL 模板字面量拼接（注入面）
export function loadUser(userId: string): string {
  return `SELECT * FROM users WHERE id = ${userId}`;
}

// ④ exec 模板拼接（注入面）
import { execSync } from "node:child_process";
export function dumpFile(fname: string): string {
  return execSync(`cat ${fname}`).toString();
}

// ⑤ 弱随机做 token（密码学用途）
export function makeToken(): string {
  return Math.random().toString(36);
}
