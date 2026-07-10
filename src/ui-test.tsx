// Ink TUI 渲染级 + 交互验证（假 provider，零 API 消耗）：
// 模拟用户输入 → 触发工具调用 → 权限确认框出现 → 按 y 放行 → 工具执行 → 最终答复流式渲染。
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./ui/app.js";
import { Agent } from "./agent/loop.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";
import type { Message, Provider, ProviderResult, ToolSpec, ProviderStreamHandlers } from "./types.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeProvider implements Provider {
  name = "fake";
  private i = 0;
  private script: ((h: ProviderStreamHandlers) => ProviderResult)[] = [
    // 第1次：要求调 bash（写类工具，会触发权限确认）
    () => ({
      content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi-ui" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    // 第2次：流式给出最终答复
    (h) => {
      h.onText?.("已经跑完，输出是 hi-ui。");
      return {
        content: [{ type: "text", text: "已经跑完，输出是 hi-ui。" }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 8 },
      };
    },
  ];
  async complete(
    _s: string,
    _m: Message[],
    _t: ToolSpec[],
    h: ProviderStreamHandlers,
  ): Promise<ProviderResult> {
    return this.script[this.i++](h);
  }
}

const cwd = mkdtempSync(join(tmpdir(), "minicc-ui-"));
const agent = new Agent(new FakeProvider(), "sys", ALL_TOOLS, { cwd }, TOOL_MAP, {
  compactThreshold: 0,
});

const { lastFrame, stdin } = render(<App agent={agent} provider="fake" model="fake-1" />);
await tick(50);
const initial = lastFrame() ?? "";

// 输入需求并回车
stdin.write("用 bash 跑一下 echo");
await tick(30);
stdin.write("\r");
await tick(150); // 等第1次 provider 调用 → 权限确认框出现
const permFrame = lastFrame() ?? "";

// 按 y 放行
stdin.write("y");
await tick(300); // 工具执行 + 第2次 provider 调用 → 最终答复
const finalFrame = lastFrame() ?? "";

const checks: [string, boolean][] = [
  ["初始渲染有输入框占位", initial.includes("输入需求")],
  ["状态栏显示后端/模型", finalFrame.includes("fake") && finalFrame.includes("fake-1")],
  ["用户消息已渲染", finalFrame.includes("用 bash 跑一下 echo")],
  ["权限确认框出现(bash)", permFrame.includes("需要执行") && permFrame.includes("bash")],
  ["工具调用块渲染(bash)", finalFrame.includes("bash")],
  ["工具结果渲染(hi-ui)", finalFrame.includes("hi-ui")],
  ["最终答复流式渲染", finalFrame.includes("已经跑完")],
  ["状态栏 token 累计>0", /累计 in \d+/.test(finalFrame) && !finalFrame.includes("累计 in 0/")],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
if (!ok) {
  console.log("\n---- 最终帧 ----\n" + finalFrame);
}
console.log(ok ? "\nUI TEST PASS ✅ Ink TUI 交互链路验证通过" : "\nUI TEST FAIL ❌");
process.exit(ok ? 0 : 1);
