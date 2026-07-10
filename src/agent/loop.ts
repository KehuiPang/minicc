// Agent 主循环：Claude Code 的心脏。
//   组装消息 → 请求模型 → 若要调工具则执行并回灌 → 循环 → 直到模型给最终文字。
// P2：累计 token 用量 + 上下文过长时自动压缩（把旧历史总结成一段，保留最近若干条）。
import type {
  ContentBlock,
  Message,
  Provider,
  Tool,
  ToolContext,
} from "../types.js";

export type PermissionDecision = "allow" | "deny";

export interface AgentOptions {
  compactThreshold?: number; // 上一轮 input tokens 超过此值触发压缩（0=关闭）
  keepRecent?: number; // 压缩时保留最近多少条原始消息
}

export interface SessionUsage {
  totalInput: number;
  totalOutput: number;
  lastInput: number; // 最近一次请求的输入 token，≈当前上下文大小
}

export interface AgentHooks {
  onText?(delta: string): void;
  requestPermission?(tool: Tool, input: Record<string, unknown>): Promise<PermissionDecision>;
  onToolStart?(name: string, input: Record<string, unknown>): void;
  onToolEnd?(name: string, result: string, isError: boolean): void;
  onAssistantDone?(): void;
  onUsage?(u: SessionUsage): void; // 每轮请求后回报累计用量
  onCompact?(before: number, after: number): void; // 压缩发生时回报条数变化
}

export class Agent {
  private messages: Message[] = [];
  private usage: SessionUsage = { totalInput: 0, totalOutput: 0, lastInput: 0 };
  private compactThreshold: number;
  private keepRecent: number;

  constructor(
    private provider: Provider,
    private system: string,
    private tools: Tool[],
    private ctx: ToolContext,
    private toolMap: Map<string, Tool>,
    opts: AgentOptions = {},
  ) {
    this.compactThreshold = opts.compactThreshold ?? 60000;
    this.keepRecent = opts.keepRecent ?? 6;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  // 载入已保存的会话历史（切换/恢复会话时用）
  setMessages(msgs: Message[]): void {
    this.messages = msgs;
  }

  // 运行时切换模型后端（用户在设置里改 provider/model）
  setProvider(p: Provider): void {
    this.provider = p;
  }

  getUsage(): SessionUsage {
    return this.usage;
  }

  setUsage(u: SessionUsage): void {
    this.usage = u;
  }

  async send(
    userInput: string,
    hooks: AgentHooks,
    signal?: AbortSignal,
    images?: string[],
  ): Promise<void> {
    const userContent: ContentBlock[] = [];
    if (userInput) userContent.push({ type: "text", text: userInput });
    for (const dataUrl of images ?? []) userContent.push({ type: "image", dataUrl });
    if (userContent.length === 0) return;
    this.messages.push({ role: "user", content: userContent });

    while (true) {
      if (signal?.aborted) return; // 已被用户中断
      // 上下文过长则先压缩，再请求模型（省 token / 防撑爆）
      await this.maybeCompact(hooks);

      const result = await this.provider.complete(this.system, this.messages, this.tools, {
        onText: hooks.onText,
        signal,
      });

      if (result.usage) {
        this.usage.totalInput += result.usage.inputTokens;
        this.usage.totalOutput += result.usage.outputTokens;
        this.usage.lastInput = result.usage.inputTokens;
        hooks.onUsage?.(this.usage);
      }

      this.messages.push({ role: "assistant", content: result.content });

      const toolUses = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        hooks.onAssistantDone?.();
        return;
      }

      const resultsBlocks: ContentBlock[] = [];
      for (const call of toolUses) {
        const tool = this.toolMap.get(call.name);
        if (!tool) {
          resultsBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `未知工具: ${call.name}`,
            is_error: true,
          });
          continue;
        }

        if (!tool.readOnly && hooks.requestPermission) {
          const decision = await hooks.requestPermission(tool, call.input);
          if (decision === "deny") {
            resultsBlocks.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: "用户拒绝了该操作。",
              is_error: true,
            });
            continue;
          }
        }

        hooks.onToolStart?.(call.name, call.input);
        const out = await tool.run(call.input, this.ctx);
        hooks.onToolEnd?.(call.name, out.content, !!out.isError);
        resultsBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: out.content,
          is_error: out.isError,
        });
      }

      this.messages.push({ role: "user", content: resultsBlocks });
    }
  }

  // —— 上下文压缩 ——
  private async maybeCompact(hooks: AgentHooks): Promise<void> {
    if (this.compactThreshold <= 0) return;
    if (this.usage.lastInput < this.compactThreshold) return;
    if (this.messages.length <= this.keepRecent + 1) return;

    const cut = this.findCutIndex();
    if (cut <= 0) return; // 找不到安全切点则不压

    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const before = this.messages.length;

    // 让模型把旧历史总结成要点（单独一次调用，不带工具）
    const summaryPrompt =
      "把下面这段对话历史压缩成简洁的要点摘要，保留：用户目标、已做的关键操作、涉及的文件/命令、当前进展与未决事项。用中文，条列式。";
    const res = await this.provider.complete(
      summaryPrompt,
      older,
      [],
      {}, // 不流式回显摘要生成
    );
    if (res.usage) {
      this.usage.totalInput += res.usage.inputTokens;
      this.usage.totalOutput += res.usage.outputTokens;
    }
    const summaryText =
      res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("") || "(摘要为空)";

    this.messages = [
      { role: "user", content: [{ type: "text", text: `【之前对话摘要】\n${summaryText}` }] },
      ...recent,
    ];
    // 压缩后当前上下文变小，重置 lastInput 让下轮重新度量
    this.usage.lastInput = 0;
    hooks.onCompact?.(before, this.messages.length);
  }

  // 找一个安全切点：保留最近 keepRecent 条，且切点落在一个"真正的用户输入"上，
  // 不能把 assistant 的 tool_use 与其对应的 tool_result 拆开。
  private findCutIndex(): number {
    const target = this.messages.length - this.keepRecent;
    for (let i = target; i < this.messages.length; i++) {
      const m = this.messages[i];
      const isRealUser =
        m.role === "user" && m.content.every((b) => b.type === "text");
      if (isRealUser) return i;
    }
    return -1; // 最近段里没有干净的用户边界，放弃本次压缩
  }
}
