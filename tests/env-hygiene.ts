// tests/env-hygiene.ts —— 测试环境卫生（v0.5.17.1）
// ----------------------------------------------------------------------------
// 背景（实锤事故）：控制台 task-runner 从 Next.js dev server 继承 .env.local
// 注入的 DEEPSEEK_API_KEY / GITHUB_TOKEN 等 —— providers / web 测试对
// 「干净环境」有假设（env 自动发现、车道解析、网关缺省、model 回落链）：
//   · providers「无任何变量 → 空发现」在 DEEPSEEK_API_KEY 在场时假红；
//   · web「model 回落链」在 key 在场时走 env 发现车道 —— 不但断言红，
//     还可能触发真实 LLM 网络调用（3.2s 超时形态）。
// 单一修复点：敏感变量快照 + 清零 + 恢复三件套，测试文件 beforeEach/afterEach
// 接入（此前 providers.test.ts 的 beforeEach 只保存不清零 —— 隔离卫生缺失）。

/** 敏感变量全集：车道/网关配置 + 服务商 key（与 provider-registry 面对齐）。 */
export const SENSITIVE_ENV_VARS: readonly string[] = [
  // 车道与网关配置
  "ORG_CONFIG", "DHV_LLM_GATEWAY", "DHV_LLM_API_KEY", "DHV_LLM_MODEL",
  "DHV_LLM_THINKING", "DHV_LLM_TIMEOUT_MS", "ORG_LLM_KEY_POOL",
  "ORG_LLM_FALLBACKS", "ORG_LANE_KIND", "ORG_DEFAULT_MODEL",
  // 服务商 key（全清，防宿主环境污染发现测试）
  "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
  "XAI_API_KEY", "GROK_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY", "PERPLEXITY_API_KEY", "PPLX_API_KEY", "DEEPINFRA_API_KEY",
  "SILICONFLOW_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY",
  "MOONSHOT_API_KEY", "KIMI_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY",
  "ALIYUN_LLM_API_KEY", "MINIMAX_API_KEY", "CLAUDE_API_KEY",
  // 控制台注入（task-runner 继承面）
  "GITHUB_TOKEN", "DEEPSEEK_MODEL",
] as const;

export interface EnvSnapshot {
  saved: Map<string, string>;
}

/** 快照当前敏感变量值（清零前调用）。 */
export function snapshotEnv(): EnvSnapshot {
  const saved = new Map<string, string>();
  for (const v of SENSITIVE_ENV_VARS) {
    const val = process.env[v];
    if (val !== undefined) saved.set(v, val);
  }
  return { saved };
}

/** 清零全部敏感变量（undefined 形删除，恢复宿主原貌）。 */
export function clearEnv(): void {
  for (const v of SENSITIVE_ENV_VARS) delete process.env[v];
}

/** 恢复快照（afterEach 调用 —— 测试不留环境侧写）。 */
export function restoreEnv(snap: EnvSnapshot): void {
  for (const v of SENSITIVE_ENV_VARS) {
    const val = snap.saved.get(v);
    if (val === undefined) delete process.env[v];
    else process.env[v] = val;
  }
}
