// Provider 实现：把统一的 Message/Tool 语义翻译到具体后端（公开版：仅 API key）。
// - AnthropicProvider：原生 Anthropic Messages API（流式），用 ANTHROPIC_API_KEY
// - OpenAIProvider：任意 OpenAI 兼容 /chat/completions（官方 OpenAI / 本地 vLLM / Ollama 等），SSE 流式
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResult,
  ProviderStreamHandlers,
  ToolSpec,
} from "../types.js";

// ---------- Anthropic（API key）----------
class AnthropicProvider implements Provider {
  name = "anthropic";
  private client: Anthropic;
  constructor(private cfg: Config) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  }

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult> {
    const stream = this.client.messages.stream(
      {
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        system,
        messages: toAnthropicMessages(messages),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      },
      { signal: handlers.signal },
    );

    stream.on("text", (delta) => handlers.onText?.(delta));
    const final = await stream.finalMessage();

    const content: ContentBlock[] = [];
    for (const block of final.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use")
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
    }
    const stopReason =
      final.stop_reason === "tool_use"
        ? "tool_use"
        : final.stop_reason === "max_tokens"
          ? "max_tokens"
          : final.stop_reason === "end_turn"
            ? "end_turn"
            : "other";
    return {
      content,
      stopReason,
      usage: {
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0,
      },
    };
  }
}

// ---------- OpenAI 兼容（官方 OpenAI / 本地 / 自建端点）----------
class OpenAIProvider implements Provider {
  name = "openai";
  constructor(private cfg: Config) {}

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult> {
    // 视觉模型才发真图片，否则图片转文本占位(如 deepseek 纯文本模型不认 image_url)
    const vision =
      /gpt-4o|gpt-4\.1|gpt-5|\bo3\b|\bo4|vl\b|vision|omni|internvl|qwen3?-?vl|glm-[\d.]*v|grok-4|kimi-latest|hunyuan-vision|minicpm-v/i.test(
        this.cfg.model,
      );
    const oaMessages = toOpenAIMessages(system, messages, vision);
    const oaTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const base = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    // 小上下文模型：若输出上限≥窗口，会把上下文顶满导致输入没空间报400。
    // 此时不发 max_tokens，让服务端按 (窗口 - 输入) 自适应，绝不越界。
    const ctxWin = this.cfg.contextWindow || 0;
    const sendMaxTokens = ctxWin && this.cfg.maxTokens >= ctxWin ? undefined : this.cfg.maxTokens;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: sendMaxTokens,
        messages: oaMessages,
        tools: oaTools.length ? oaTools : undefined,
        stream: true, // SSE 流式：文字实时逐字打印
        stream_options: { include_usage: true }, // 末尾块带 usage
      }),
      signal: handlers.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenAI 兼容端点报错 ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    let sawTool = false;
    const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};
    let usage: {
      inputTokens: number;
      outputTokens: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    } = { inputTokens: 0, outputTokens: 0 };

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") break outer;
        let j: any;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        if (j.usage) {
          const inTok = j.usage.prompt_tokens ?? 0;
          // DeepSeek 等返回缓存命中/未命中明细；缺失则按全部未命中兜底
          const hit = j.usage.prompt_cache_hit_tokens ?? j.usage.prompt_tokens_details?.cached_tokens;
          const cacheHit = typeof hit === "number" ? hit : 0;
          const cacheMiss =
            typeof j.usage.prompt_cache_miss_tokens === "number"
              ? j.usage.prompt_cache_miss_tokens
              : Math.max(0, inTok - cacheHit);
          usage = {
            inputTokens: inTok,
            outputTokens: j.usage.completion_tokens ?? 0,
            cacheHitTokens: cacheHit,
            cacheMissTokens: cacheMiss,
          };
        }
        const ch = j.choices?.[0];
        if (!ch) continue;
        const d = ch.delta ?? {};
        if (typeof d.content === "string" && d.content) {
          text += d.content;
          handlers.onText?.(d.content); // 逐块推给渲染进程
        }
        for (const tc of d.tool_calls ?? []) {
          sawTool = true;
          const idx = tc.index ?? 0;
          const acc = (toolAcc[idx] ??= { args: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    for (const idx of Object.keys(toolAcc).map(Number).sort((a, b) => a - b)) {
      const acc = toolAcc[idx];
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(acc.args || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: acc.id ?? `call_${idx}`,
        name: acc.name ?? "unknown",
        input,
      });
    }
    return { content, stopReason: sawTool ? "tool_use" : "end_turn", usage };
  }
}

// data:image/png;base64,xxx → { mediaType, data }
function parseDataUrl(d: string): { mediaType: string; data: string } {
  const m = d.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: "image/png", data: d };
}

// 统一 Message[] → Anthropic 格式（text/tool_use/tool_result 直通，image 转 base64 source）
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "image") {
        const { mediaType, data } = parseDataUrl(b.dataUrl);
        return { type: "image", source: { type: "base64", media_type: mediaType, data } };
      }
      return b;
    }),
  })) as unknown as Anthropic.MessageParam[];
}

// 把统一 Message[] 转成 OpenAI chat 格式；vision=false 时图片转文本占位(纯文本模型不认 image_url)
function toOpenAIMessages(system: string, messages: Message[], vision: boolean): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text)
        .join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const am: any = { role: "assistant", content: text || null };
      if (toolCalls.length) am.tool_calls = toolCalls;
      out.push(am);
    } else {
      // user：可能是纯文本、图片，或若干 tool_result
      const toolResults = m.content.filter((b) => b.type === "tool_result");
      if (toolResults.length) {
        for (const r of toolResults as any[]) {
          out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
        }
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) out.push({ role: "user", content: text });
      } else {
        const images = m.content.filter((b) => b.type === "image") as any[];
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (images.length && vision) {
          const parts: any[] = [];
          if (text) parts.push({ type: "text", text });
          for (const im of images) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
          out.push({ role: "user", content: parts });
        } else if (images.length) {
          // 纯文本模型：图片转占位文本，避免 image_url 报 400 卡死历史
          const note = images.map(() => "[图片]").join(" ");
          out.push({ role: "user", content: text ? `${text}\n${note}` : note });
        } else {
          out.push({ role: "user", content: text });
        }
      }
    }
  }
  return out;
}

export function makeProvider(cfg: Config): Provider {
  return cfg.provider === "openai" ? new OpenAIProvider(cfg) : new AnthropicProvider(cfg);
}
