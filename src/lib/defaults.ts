/** Shared API defaults for the web runtime and the settings dialog. */
export const BUILTIN_API = {
  label: "TierFlow（内置测试）",
  baseURL: "https://tierflow.cn/v1",
  apiKey: "sk-56mQ6Zwa1GgjvFsScYSFaXByy8PK78s92ehOKdMRQw993N00",
  model: "tierflow_pro",
} as const;

export type ProviderPreset = {
  key: string;
  label: string;
  baseURL: string;
  /** Suggested model for presets whose ID is stable; otherwise use 拉取模型. */
  model?: string;
};

/**
 * Quick-fill list for the API form. Ported from GeoAgentPro's provider presets
 * plus TierFlow (the built-in default) and a few extra OpenAI-compatible
 * gateways. Selecting a preset only fills the endpoint (and a known model).
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { key: "tierflow", label: "TierFlow（默认）", baseURL: BUILTIN_API.baseURL, model: BUILTIN_API.model },
  { key: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { key: "openai", label: "OpenAI API", baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "qwen", label: "阿里云百炼", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { key: "moonshot", label: "Kimi（Moonshot）", baseURL: "https://api.moonshot.cn/v1" },
  { key: "zhipu", label: "智谱 BigModel", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { key: "minimax", label: "MiniMax", baseURL: "https://api.minimax.cn/v1" },
  { key: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { key: "nvidia", label: "英伟达（免费）", baseURL: "https://integrate.api.nvidia.com/v1" },
  { key: "siliconflow", label: "硅基流动", baseURL: "https://api.siliconflow.cn/v1" },
  { key: "volcengine", label: "火山方舟", baseURL: "https://ark.cn-beijing.volces.com/api/v3" },
  { key: "custom", label: "自定义兼容接口", baseURL: "" },
];

export function matchProviderPreset(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return "custom";
  return PROVIDER_PRESETS.find(p => p.key !== "custom" && p.baseURL.replace(/\/+$/, "").toLowerCase() === normalized)?.key ?? "custom";
}
