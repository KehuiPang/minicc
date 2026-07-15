// 运行配置：从环境变量读取，决定接哪个模型后端（公开版：仅 API key）。
// 两条路：
//   1) Claude API key（provider=anthropic）—— ANTHROPIC_API_KEY(sk-ant-...)
//   2) OpenAI 兼容端点（provider=openai）—— 官方 OpenAI、或本地/自建服务器(vLLM/Ollama 等)
//      WUWEI_BASE_URL(如 https://api.openai.com/v1 或 http://localhost:8000/v1) + WUWEI_API_KEY + WUWEI_MODEL

export interface Config {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
  contextWindow: number; // 该模型的上下文窗口(用于占用条 + 计算压缩阈值)
  compactThreshold: number; // 上一轮 input tokens 超过此值就压缩上下文
  keepRecentTurns: number; // 压缩时保留最近多少条原始消息
}

// 各模型上下文窗口(按 model id 推断；不确定的取保守 128k，避免超限报错)
function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (/claude-(opus|sonnet|fable|mythos)/.test(m)) return 1_000_000;
  if (/claude-haiku/.test(m)) return 200_000;
  if (/deepseek-v4/.test(m)) return 1_000_000; // V4 Pro/Flash 均 1M
  if (/minimax-m3/.test(m)) return 1_000_000;
  if (/minimax/.test(m)) return 200_000;
  if (/gpt-5|gpt-4\.1|\bo3\b|\bo4/.test(m)) return 400_000;
  if (/qwen3?[.-]?(max|7)|qwen-max|qwen-plus/.test(m)) return 256_000;
  if (/doubao/.test(m)) return 256_000;
  if (/glm-5/.test(m)) return 1_000_000; // GLM-5.2/5.1 1M
  if (/glm-4/.test(m)) return 200_000;
  if (/moonshot-v1-8k/.test(m)) return 8_192;
  if (/moonshot-v1-32k/.test(m)) return 32_000;
  if (/moonshot-v1-128k/.test(m)) return 128_000;
  if (/kimi/.test(m)) return 256_000; // K2.x / kimi-latest
  if (/hunyuan/.test(m)) return 256_000;
  if (/grok-4\.[35]/.test(m)) return 1_000_000; // grok-4.3/4.5 旗舰
  if (/grok/.test(m)) return 256_000;
  // 旧 deepseek-chat / gpt-4o / qwen-其它 / 未知 → 128k(保守)
  return 128_000;
}

function pick(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const explicit = pick("WUWEI_PROVIDER");
  const provider: Config["provider"] =
    explicit === "openai" || explicit === "anthropic"
      ? (explicit as Config["provider"])
      : pick("WUWEI_BASE_URL")
        ? "openai"
        : "anthropic";

  const model =
    pick("WUWEI_MODEL") || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o");

  const apiKey =
    provider === "anthropic" ? pick("ANTHROPIC_API_KEY") : pick("WUWEI_API_KEY", "not-needed");

  const ctxWindow = Number(pick("WUWEI_CONTEXT_WINDOW")) || contextWindowFor(model);

  return {
    provider,
    model,
    apiKey,
    baseUrl: pick("WUWEI_BASE_URL") || undefined,
    maxTokens: Number(pick("WUWEI_MAX_TOKENS", "8192")),
    contextWindow: ctxWindow,
    // 阈值默认=窗口的 80%(留 20% 余量再压缩)；env 可显式覆盖
    compactThreshold: pick("WUWEI_COMPACT_THRESHOLD")
      ? Number(pick("WUWEI_COMPACT_THRESHOLD"))
      : Math.floor(ctxWindow * 0.8),
    keepRecentTurns: Number(pick("WUWEI_KEEP_RECENT", "6")),
  };
}
