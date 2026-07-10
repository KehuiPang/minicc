// 运行配置：从环境变量读取，决定接哪个模型后端（公开版：仅 API key 方式）。
// 两条路：
//   1) Claude API key（provider=anthropic）—— ANTHROPIC_API_KEY(sk-ant-...)
//   2) OpenAI 兼容端点（provider=openai）—— 官方 OpenAI、或本地/自建服务器(vLLM/Ollama 等)
//      MINICC_BASE_URL(如 https://api.openai.com/v1 或 http://localhost:8000/v1) + MINICC_API_KEY + MINICC_MODEL

export interface Config {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
  compactThreshold: number; // 上一轮 input tokens 超过此值就压缩上下文
  keepRecentTurns: number; // 压缩时保留最近多少条原始消息
}

function pick(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const explicit = pick("MINICC_PROVIDER");
  const provider: Config["provider"] =
    explicit === "openai" || explicit === "anthropic"
      ? (explicit as Config["provider"])
      : pick("MINICC_BASE_URL")
        ? "openai"
        : "anthropic";

  const model =
    pick("MINICC_MODEL") || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o");

  const apiKey =
    provider === "anthropic" ? pick("ANTHROPIC_API_KEY") : pick("MINICC_API_KEY", "not-needed");

  return {
    provider,
    model,
    apiKey,
    baseUrl: pick("MINICC_BASE_URL") || undefined,
    maxTokens: Number(pick("MINICC_MAX_TOKENS", "8192")),
    compactThreshold: Number(pick("MINICC_COMPACT_THRESHOLD", "60000")),
    keepRecentTurns: Number(pick("MINICC_KEEP_RECENT", "6")),
  };
}
