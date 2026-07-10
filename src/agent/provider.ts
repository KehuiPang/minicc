// Provider 实现：把统一的 Message/Tool 语义翻译到具体后端（公开版：仅 API key）。
// - AnthropicProvider：原生 Anthropic Messages API（流式），用 ANTHROPIC_API_KEY
// - OpenAIProvider：任意 OpenAI 兼容 /chat/completions（官方 OpenAI / 本地 vLLM / Ollama 等）
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
    const oaMessages = toOpenAIMessages(system, messages);
    const oaTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const base = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        messages: oaMessages,
        tools: oaTools.length ? oaTools : undefined,
        stream: false,
      }),
      signal: handlers.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenAI 兼容端点报错 ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as any;
    const msg = data.choices?.[0]?.message ?? {};

    const content: ContentBlock[] = [];
    if (typeof msg.content === "string" && msg.content) {
      handlers.onText?.(msg.content);
      content.push({ type: "text", text: msg.content });
    }
    let sawTool = false;
    for (const call of msg.tool_calls ?? []) {
      sawTool = true;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: call.id ?? `call_${content.length}`,
        name: call.function?.name ?? "unknown",
        input,
      });
    }
    return {
      content,
      stopReason: sawTool ? "tool_use" : "end_turn",
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
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

// 把统一 Message[] 转成 OpenAI chat 格式
function toOpenAIMessages(system: string, messages: Message[]): any[] {
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
        if (images.length) {
          const parts: any[] = [];
          if (text) parts.push({ type: "text", text });
          for (const im of images) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
          out.push({ role: "user", content: parts });
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
