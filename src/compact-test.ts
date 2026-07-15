// 验证 P2 上下文压缩：用假 provider（零 API 消耗）驱动含工具调用的对话，
// 断言 ①压缩会触发 ②切点不拆散 tool_use/tool_result ③压缩后无孤儿 tool_result ④用量累计。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent/loop.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";
import type {
  Message,
  Provider,
  ProviderResult,
  ToolSpec,
} from "./types.js";

// 脚本化假 provider：识别"压缩摘要"调用返回摘要；否则按队列返回预置回复。
class FakeProvider implements Provider {
  name = "fake";
  private i = 0;
  constructor(private script: ProviderResult[]) {}
  async complete(
    system: string,
    _messages: Message[],
    _tools: ToolSpec[],
    _handlers: unknown,
  ): Promise<ProviderResult> {
    if (system.includes("压缩")) {
      return {
        content: [{ type: "text", text: "【摘要】用户要跑 echo；已执行成功。" }],
        stopReason: "end_turn",
        usage: { inputTokens: 500, outputTokens: 50 },
      };
    }
    return this.script[this.i++];
  }
}

const cwd = mkdtempSync(join(tmpdir(), "wuwei-compact-"));

// 脚本：第1轮先调 bash(高 input 触发压缩阈值)，再给最终答复；第2轮触发压缩后再答复。
const script: ProviderResult[] = [
  {
    content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "echo hi" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 70000, outputTokens: 20 },
  },
  {
    content: [{ type: "text", text: "完成 A。" }],
    stopReason: "end_turn",
    usage: { inputTokens: 71000, outputTokens: 10 },
  },
  {
    content: [{ type: "text", text: "完成 B。" }],
    stopReason: "end_turn",
    usage: { inputTokens: 20000, outputTokens: 10 },
  },
];

const agent = new Agent(new FakeProvider(script), "系统提示", ALL_TOOLS, { cwd }, TOOL_MAP, {
  compactThreshold: 60000,
  keepRecent: 2,
});

let compactBefore = 0;
let compactAfter = 0;
const hooks = {
  requestPermission: async () => "allow" as const,
  onCompact: (b: number, a: number) => {
    compactBefore = b;
    compactAfter = a;
  },
};

await agent.send("任务A：跑一下 echo", hooks);
await agent.send("任务B：继续", hooks);

const msgs = agent.getMessages();
const usage = agent.getUsage();

// 不变量：不存在"孤儿 tool_result"——每个 tool_result 前面必有匹配的 assistant tool_use
function noOrphanToolResults(ms: Message[]): boolean {
  const seenToolUse = new Set<string>();
  for (const m of ms) {
    for (const b of m.content) {
      if (b.type === "tool_use") seenToolUse.add(b.id);
      if (b.type === "tool_result" && !seenToolUse.has(b.tool_use_id)) return false;
    }
  }
  return true;
}
// 首条消息不能是以 tool_result 开头（压缩最易犯的错）
const firstIsClean = !msgs[0]?.content.some((b) => b.type === "tool_result");
const hasSummary = msgs[0]?.content.some(
  (b) => b.type === "text" && b.text.includes("【摘要】"),
);

const checks: [string, boolean][] = [
  ["压缩已触发", compactBefore > 0 && compactAfter > 0 && compactAfter < compactBefore],
  ["压缩后首条是摘要", !!hasSummary],
  ["首条不是孤儿 tool_result", firstIsClean],
  ["全程无孤儿 tool_result（切点没拆散工具对）", noOrphanToolResults(msgs)],
  ["用量已累计(输入>0)", usage.totalInput > 0],
  ["压缩后 lastInput 重新度量到第2轮值", usage.lastInput === 20000],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
console.log(`\n压缩: ${compactBefore} → ${compactAfter} 条 | 累计输入=${usage.totalInput} 输出=${usage.totalOutput}`);
console.log(ok ? "\nCOMPACT TEST PASS ✅" : "\nCOMPACT TEST FAIL ❌");
process.exit(ok ? 0 : 1);
