// ============================================================================
// lib/provider-registry.ts — 主流模型服务商注册表（v0.5.1）
// ----------------------------------------------------------------------------
// 独立模块（无内部依赖）：被 lib/config.ts（预设）与 lib/providers.ts（车道
// 解析）共同引用，避免两者互相 import 的初始化环。
// 「支持所有主流 API key 模式」的单一事实来源：21 家服务商的 OpenAI 兼容
// 端点、缺省模型、key 的环境变量名、附加头。国内主流（DeepSeek/智谱/月之
// 暗面/通义/MiniMax/硅基流动）与海外主流（OpenAI/Anthropic/Gemini/
// OpenRouter/Groq/Mistral/xAI/Together/Fireworks/Cerebras/Perplexity/
// DeepInfra）全覆盖，本地推理（Ollama/LM Studio/vLLM）即开即用。
// ============================================================================

// ---- 服务商注册表 -----------------------------------------------------------

export interface ProviderSpec {
  /** 展示名。 */
  label: string;
  /** OpenAI 兼容网关（chat/completions 拼在其后）。 */
  gateway: string;
  /** 缺省模型（空 = 本地推理，用户按已拉取模型填）。 */
  model: string;
  /** 该服务商 key 的候选环境变量名（按序探测）。 */
  envKeys: readonly string[];
  /** 附加请求头（如 anthropic-version）。 */
  extraHeaders?: Record<string, string>;
  /** 说明（含 key 获取途径）。 */
  note: string;
  /** 本地推理（无需 key）。 */
  local?: boolean;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  deepseek: {
    label: "DeepSeek 官方 API",
    gateway: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    envKeys: ["DEEPSEEK_API_KEY"],
    note: "api_key 必填（platform.deepseek.com 获取）",
  },
  openai: {
    label: "OpenAI 官方 API",
    gateway: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envKeys: ["OPENAI_API_KEY"],
    note: "api_key 必填；gateway 兼容任何 OpenAI 协议端点",
  },
  anthropic: {
    label: "Anthropic Claude（OpenAI 兼容端点）",
    gateway: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    extraHeaders: { "anthropic-version": "2023-06-01" },
    note: "api_key 必填（console.anthropic.com）；走官方 OpenAI 兼容端点",
  },
  gemini: {
    label: "Google Gemini（OpenAI 兼容端点）",
    gateway: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    note: "api_key 必填（aistudio.google.com）；走官方 OpenAI 兼容端点",
  },
  openrouter: {
    label: "OpenRouter 聚合网关",
    gateway: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    envKeys: ["OPENROUTER_API_KEY"],
    note: "api_key 必填；数百模型经统一协议路由",
  },
  groq: {
    label: "Groq 云推理",
    gateway: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    envKeys: ["GROQ_API_KEY"],
    note: "api_key 必填（console.groq.com）；超低延迟",
  },
  mistral: {
    label: "Mistral 官方 API",
    gateway: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    envKeys: ["MISTRAL_API_KEY"],
    note: "api_key 必填（console.mistral.ai）",
  },
  xai: {
    label: "xAI Grok",
    gateway: "https://api.x.ai/v1",
    model: "grok-3-mini",
    envKeys: ["XAI_API_KEY", "GROK_API_KEY"],
    note: "api_key 必填（console.x.ai）",
  },
  together: {
    label: "Together AI",
    gateway: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    envKeys: ["TOGETHER_API_KEY"],
    note: "api_key 必填（api.together.ai）",
  },
  fireworks: {
    label: "Fireworks AI",
    gateway: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    envKeys: ["FIREWORKS_API_KEY"],
    note: "api_key 必填（fireworks.ai）",
  },
  cerebras: {
    label: "Cerebras 云推理",
    gateway: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    envKeys: ["CEREBRAS_API_KEY"],
    note: "api_key 必填（cloud.cerebras.ai）",
  },
  perplexity: {
    label: "Perplexity Sonar",
    gateway: "https://api.perplexity.ai",
    model: "sonar",
    envKeys: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"],
    note: "api_key 必填（perplexity.ai/settings/api）；联网检索型",
  },
  deepinfra: {
    label: "DeepInfra",
    gateway: "https://api.deepinfra.com/v1/openai",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    envKeys: ["DEEPINFRA_API_KEY"],
    note: "api_key 必填（deepinfra.com）",
  },
  siliconflow: {
    label: "SiliconFlow 硅基流动",
    gateway: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    envKeys: ["SILICONFLOW_API_KEY"],
    note: "api_key 必填（cloud.siliconflow.cn）",
  },
  zhipu: {
    label: "智谱 GLM",
    gateway: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    envKeys: ["ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"],
    note: "api_key 必填（open.bigmodel.cn）",
  },
  moonshot: {
    label: "月之暗面 Kimi",
    gateway: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    note: "api_key 必填（platform.moonshot.cn）",
  },
  dashscope: {
    label: "阿里云百炼 Qwen",
    gateway: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    envKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "ALIYUN_LLM_API_KEY"],
    note: "api_key 必填（bailian.console.aliyun.com）",
  },
  minimax: {
    label: "MiniMax",
    gateway: "https://api.minimax.chat/v1",
    model: "MiniMax-Text-01",
    envKeys: ["MINIMAX_API_KEY"],
    note: "api_key 必填（platform.minimaxi.com）",
  },
  ollama: {
    label: "Ollama 本地推理",
    gateway: "http://127.0.0.1:11434/v1",
    model: "",
    envKeys: [],
    local: true,
    note: "无需 api_key；model 填本地已拉取名（ollama list 查看）",
  },
  lmstudio: {
    label: "LM Studio 本地推理",
    gateway: "http://127.0.0.1:1234/v1",
    model: "",
    envKeys: [],
    local: true,
    note: "无需 api_key；model 填已加载模型名",
  },
  vllm: {
    label: "vLLM 自托管",
    gateway: "http://127.0.0.1:8000/v1",
    model: "",
    envKeys: [],
    local: true,
    note: "自建推理服务；model 填 --served-model-name",
  },
};

export const PROVIDER_NAMES: readonly string[] = Object.keys(PROVIDERS);

// ---- 环境变量自动发现 -------------------------------------------------------

export interface EnvDiscovery {
  provider: string;
  envName: string;
  key: string;
}

/** 扫描 process.env：发现已配置的主流服务商 key（脱敏前原值仅供内部使用）。 */
export function discoverEnvLanes(): EnvDiscovery[] {
  const found: EnvDiscovery[] = [];
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    for (const envName of spec.envKeys) {
      const v = (process.env[envName] ?? "").trim();
      if (v.length > 0) {
        found.push({ provider: name, envName, key: v });
        break; // 每个服务商取第一个命中的变量名
      }
    }
  }
  return found;
}

