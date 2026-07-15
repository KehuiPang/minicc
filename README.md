# 无为 <sub>Wuwei</sub>

A from-scratch, open-source **coding agent** — a mini Claude Code you fully own. CLI **and** native macOS desktop app.

本质很简单：**LLM + 工具执行循环 + 界面**。模型接你自己的 API key（或本地/自建端点），壳（harness）完全自研、代码全公开。

> 公开版只支持 **API key / 自定义端点** 方式，合规、通用、谁都能安全用。内置主流平台预设，填 key 即用：
> - **Claude API key**（Anthropic 官方）
> - **OpenAI**（GPT 系列）
> - **国内主流**：DeepSeek、智谱 GLM、通义千问、豆包、Kimi（月之暗面）、腾讯混元、MiniMax
> - **xAI Grok**
> - **本地 / 自建端点**：vLLM、Ollama、LM Studio 等任意 OpenAI 兼容 API

## Features

- 🔌 **多平台预设**：Claude / OpenAI / DeepSeek / 智谱 / 通义千问 / 豆包 / Kimi / 腾讯混元 / MiniMax / Grok / 本地自建，一键切换，**各平台凭证分开保存**互不覆盖
- ⚡ **流式输出**：回复逐字实时打印
- 🔀 **快捷切换**：底栏点供应商名/模型名直接弹菜单切换，不用开设置
- 🛠️ **真工具**：读写文件、精确编辑、跑命令、glob/grep 搜索，带权限确认（可"总是允许"记住）
- 🖼️ **多模态**：粘贴/添加图片发给（视觉）模型
- 💬 **多会话**：历史侧边栏、新建/切换/删除，持久化
- 📝 **Markdown 渲染 + 代码语法高亮**，工具调用意图折叠
- 🧠 **上下文自动压缩**：按各模型真实上下文窗口触发，长任务不撑爆，token 用量按会话统计
- 🖥️ **两种形态**：终端 CLI（Ink）+ macOS 桌面 GUI（Electron）

## Quick start

```bash
npm install

# —— 用 Claude API key ——
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev            # 终端版
npm run desktop:dev    # 桌面版(开发模式)

# —— 用 OpenAI / 本地 / 自建端点 ——
export WUWEI_BASE_URL=https://api.openai.com/v1   # 或 http://localhost:8000/v1
export WUWEI_API_KEY=sk-...                        # 本地可留 not-needed
export WUWEI_MODEL=gpt-4o                           # 或你本地模型名
npm run dev
```

桌面版里点右上角/侧边栏「设置」也能直接填后端和 key，无需环境变量。

## Build the macOS app

```bash
npm run desktop:build     # 构建 main/preload/renderer
npm run desktop:pack      # 打包出 release/mac/wuwei.app
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key（provider=anthropic 时用）|
| `WUWEI_BASE_URL` | OpenAI 兼容端点（设了即视为 openai 后端）|
| `WUWEI_API_KEY` | OpenAI/自建端点的 key |
| `WUWEI_MODEL` | 模型名 |
| `WUWEI_MAX_TOKENS` | 单次最大输出 token（默认 8192）|
| `WUWEI_COMPACT_THRESHOLD` | 上下文超此 token 数自动压缩（默认取该模型窗口的 80%）|

## 结构

```
src/            核心（UI 无关，CLI/桌面共用）
  agent/loop.ts     ★ Agent 主循环 + token 计数 + 上下文压缩
  agent/provider.ts Anthropic / OpenAI 兼容双后端
  tools/index.ts    read/write/edit/bash/glob/grep
  index.tsx         终端 CLI 入口（Ink）
desktop/        Electron 桌面版（复用 src/ 核心）
  main / preload / renderer(React)
```

## 更新日志

### v1.1.0
- **新增多平台预设**：智谱 GLM、Kimi（月之暗面）、腾讯混元、xAI Grok（加上原有 DeepSeek / 通义千问 / 豆包 / MiniMax）
- **流式输出**：回复逐字实时打印
- **底栏快捷切换**：点供应商名 / 模型名直接弹菜单切换，不用开设置
- **凭证分槽保存**，修复切换供应商时 API key 被清空的问题
- 模型选择移到「模型平台」正下方 + 灰字标注基座；简约 SVG 眼睛图标；菜单项不换行
- 上下文压缩改按**各模型真实窗口（80%）**触发
- 修正各家 API Key 获取链接

### v1.0.0
- 首个版本：Claude API / OpenAI / 本地自建端点；真工具（读写 / 编辑 / 命令 / glob·grep）+ 权限确认；多模态；多会话；Markdown 渲染 + 代码高亮；上下文自动压缩 + token 统计；终端 CLI（Ink）+ macOS 桌面 GUI（Electron）。

## License

MIT
