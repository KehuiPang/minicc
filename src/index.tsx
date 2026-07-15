// wuwei 终端入口（P3：Ink TUI）。构造 Agent，渲染 <App/>。
import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { makeProvider } from "./agent/provider.js";
import { Agent } from "./agent/loop.js";
import { systemPrompt } from "./agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";
import { App } from "./ui/app.js";

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail("无为 需要在交互式终端(TTY)里运行。请打开 Terminal / iTerm，直接运行 wuwei。");
}

const cfg = loadConfig();
if (cfg.provider === "anthropic" && !cfg.apiKey) {
  fail(
    "未设置凭证。二选一：\n" +
      "  · Claude API key : export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  · OpenAI/本地    : export WUWEI_BASE_URL=https://api.openai.com/v1（或本地端点）WUWEI_API_KEY=... WUWEI_MODEL=...",
  );
}

const cwd = process.cwd();
const agent = new Agent(makeProvider(cfg), systemPrompt(cwd), ALL_TOOLS, { cwd }, TOOL_MAP, {
  compactThreshold: cfg.compactThreshold,
  keepRecent: cfg.keepRecentTurns,
});

render(<App agent={agent} provider={cfg.provider} model={cfg.model} />);
