// 冒烟测试：用桩 Provider 驱动真实 loop + 真实工具，验证链路。
// 桩模型的"剧本"：第1轮要求 bash 执行 echo；第2轮看到结果后给最终答复。
import { Agent } from "./agent/loop.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";
import type { Provider, ProviderResult } from "./types.js";

let turn = 0;
const stub: Provider = {
  name: "stub",
  async complete(_system, messages, _tools, handlers): Promise<ProviderResult> {
    turn++;
    if (turn === 1) {
      return {
        content: [
          { type: "text", text: "我先执行一下命令。" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "echo wuwei-ok" } },
        ],
        stopReason: "tool_use",
      };
    }
    // 第2轮：确认收到了工具结果
    const last = messages[messages.length - 1];
    const gotResult = last.content.some(
      (b) => b.type === "tool_result" && b.content.includes("wuwei-ok"),
    );
    const text = gotResult ? "命令已执行，输出为 wuwei-ok。完成。" : "未拿到工具结果。";
    handlers.onText?.(text);
    return { content: [{ type: "text", text }], stopReason: "end_turn" };
  },
};

const agent = new Agent(stub, "test", ALL_TOOLS, { cwd: process.cwd() }, TOOL_MAP);

let finalText = "";
await agent.send("跑个命令验证一下", {
  onText: (d) => (finalText += d),
  onToolStart: (n, i) => console.log(`[tool-start] ${n} ${JSON.stringify(i)}`),
  onToolEnd: (n, r, e) => console.log(`[tool-end] ${n} err=${e} -> ${r}`),
  requestPermission: async () => "allow",
});

console.log("[final]", finalText);
const pass = finalText.includes("wuwei-ok") && turn === 2;
console.log(pass ? "SMOKE PASS ✅" : "SMOKE FAIL ❌");
process.exit(pass ? 0 : 1);
