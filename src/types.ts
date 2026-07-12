// minicc 核心类型定义
// 这里刻意贴近 Anthropic Messages API 的消息模型（复刻 Claude Code 的底层语义）：
// 一条对话由 messages 组成；助手可能回文本，也可能回 tool_use；
// 我们本地执行工具后，把 tool_result 作为一条 user 消息塞回，继续循环。

export type Role = "user" | "assistant";

// 消息内容块：文本 / 模型要调工具 / 我们回给模型的工具结果
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string } // 用户发送的图片（data:image/...;base64,xxx）
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

// 一个工具 = 给模型看的 schema + 本地执行函数
export interface ToolSpec {
  name: string;
  description: string;
  // JSON Schema（Anthropic tools 的 input_schema 格式）
  inputSchema: Record<string, unknown>;
  // 只读工具可并行；有状态工具（Write/Edit/Bash）需串行确认
  readOnly: boolean;
}

export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool extends ToolSpec {
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// Provider 抽象：一次"请求模型 → 拿到助手回复（文本增量 + 可能的 tool_use）"
export interface ProviderStreamHandlers {
  onText?: (delta: string) => void; // 文本流式增量
  signal?: AbortSignal; // 中断信号：用户点停止时 abort，provider 传给 fetch/stream
}

export interface TokenUsage {
  inputTokens: number; // 本次请求的输入 token（≈当前上下文总大小）
  outputTokens: number;
  cacheHitTokens?: number; // 缓存命中的输入 token（便宜很多；DeepSeek 等返回）
  cacheMissTokens?: number; // 缓存未命中的输入 token
}

export interface ProviderResult {
  // 助手这一轮产出的完整内容块（文本 + tool_use）
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage?: TokenUsage;
}

export interface Provider {
  name: string;
  complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult>;
}
