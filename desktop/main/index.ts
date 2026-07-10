// Electron 主进程：创建窗口，复用 minicc 核心(agent/tools/config)，
// 通过 IPC 把 Agent 流式 hooks 推给渲染进程，权限确认走 IPC 往返。
import { app, BrowserWindow, ipcMain, protocol, net, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../src/config.js";
import { makeProvider } from "../../src/agent/provider.js";
import { Agent } from "../../src/agent/loop.js";
import { systemPrompt } from "../../src/agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP } from "../../src/tools/index.js";
import {
  listSessions,
  loadMessages,
  saveSession,
  deleteSession,
  deriveTitle,
} from "./sessions.js";
import {
  loadSettings,
  saveSettings,
  applyEnvFromSettings,
  loadWindowBounds,
  saveWindowBounds,
  type Settings,
} from "./settings.js";

// __dirname 由 electron-vite 为 ESM 输出自动注入，无需手动声明

// 注册自定义 app:// 协议为特权协议（须在 app ready 前）。
// 用它伺服打包后的 renderer，避免 file:// 下 module 脚本被 CORS/CSP 拦导致黑屏。
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;

// provider/系统提示全局共享；每个会话一个 Agent（各自 messages）
let provider: ReturnType<typeof makeProvider> | null = null;
let sysPrompt = "";
let agentOpts = { compactThreshold: 60000, keepRecent: 6 };
let backendLabel = "";
let modelLabel = "";
let cwd = process.cwd();
const agents = new Map<string, Agent>();
let currentId = "";

// 权限往返：id → resolve
const pendingPerm = new Map<number, (d: "allow" | "deny") => void>();
let permSeq = 0;
// 当前请求的中断控制器（用户点停止时 abort）
let currentAbort: AbortController | null = null;

function send(channel: string, payload?: unknown) {
  win?.webContents.send(channel, payload);
}

function mimeFor(path: string): string | null {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".woff2")) return "font/woff2";
  return null;
}

function initProvider() {
  cwd = process.cwd();
  applyEnvFromSettings(loadSettings()); // 有已保存设置则据此，否则自动推断
  const cfg = loadConfig();
  provider = makeProvider(cfg);
  sysPrompt = systemPrompt(cwd);
  agentOpts = { compactThreshold: cfg.compactThreshold, keepRecent: cfg.keepRecentTurns };
  backendLabel = cfg.provider;
  modelLabel = cfg.model;
}

// 运行时切换模型后端：保存设置、重建 provider、更新所有会话 Agent
function applySettings(s: Settings) {
  saveSettings(s);
  applyEnvFromSettings(s);
  const cfg = loadConfig();
  provider = makeProvider(cfg);
  backendLabel = cfg.provider;
  modelLabel = cfg.model;
  for (const a of agents.values()) a.setProvider(provider);
  send("evt:ready", { backend: backendLabel, model: modelLabel, cwd });
}

// 取/建某会话的 Agent（懒加载并恢复其历史）
function getAgent(id: string): Agent | null {
  if (!provider) return null;
  let a = agents.get(id);
  if (!a) {
    a = new Agent(provider, sysPrompt, ALL_TOOLS, { cwd }, TOOL_MAP, agentOpts);
    a.setMessages(loadMessages(id));
    const meta = listSessions().find((s) => s.id === id); // 恢复该会话的用量
    if (meta?.usage) a.setUsage(meta.usage);
    agents.set(id, a);
  }
  return a;
}

const EMPTY_USAGE = { totalInput: 0, totalOutput: 0, lastInput: 0 };
// 切换/加载会话后推送该会话自己的用量
function sendUsageFor(id: string) {
  const a = agents.get(id);
  send("evt:usage", a ? a.getUsage() : EMPTY_USAGE);
}

// 启动时：选最近会话或新建，推送列表与当前会话历史
function bootstrapSessions() {
  const list = listSessions();
  currentId = list[0]?.id ?? randomUUID();
  const a = getAgent(currentId);
  send("evt:sessions", listSessions());
  send("evt:session-loaded", { id: currentId, messages: a ? a.getMessages() : [] });
  sendUsageFor(currentId); // 当前会话自己的用量
}

// 会话有内容才落盘；空会话不持久化
function persistCurrent() {
  const a = agents.get(currentId);
  if (!a) return;
  const msgs = a.getMessages();
  if (msgs.length === 0) return;
  saveSession(currentId, msgs, deriveTitle(msgs), Date.now(), a.getUsage());
  send("evt:sessions", listSessions());
}

function createWindow() {
  const b = loadWindowBounds(); // 上次窗口尺寸/位置
  win = new BrowserWindow({
    width: b?.width ?? 960,
    height: b?.height ?? 720,
    ...(b?.x != null && b?.y != null ? { x: b.x, y: b.y } : {}),
    minWidth: 640,
    minHeight: 480,
    title: "minicc",
    backgroundColor: "#1a1815",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 记住窗口尺寸/位置（拖动节流保存 + 关闭时保存）
  let saveT: ReturnType<typeof setTimeout> | undefined;
  const persistBounds = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (win && !win.isDestroyed()) saveWindowBounds(win.getBounds());
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
  win.on("close", () => {
    if (win && !win.isDestroyed()) saveWindowBounds(win.getBounds());
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) win.loadURL(devUrl);
  else win.loadURL("app://bundle/index.html");

  win.webContents.on("did-finish-load", () => {
    send("evt:ready", { backend: backendLabel, model: modelLabel, cwd });
    bootstrapSessions();
  });
  // 诊断：把渲染进程报错/加载失败打到主进程 stdout，便于终端排查黑屏
  win.webContents.on("console-message", (_e, _lvl, message, line, src) => {
    console.log(`[renderer] ${message} (${src}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
}

// 单例锁：防御纵深——即使被意外多次启动也只存活一个实例，杜绝 fork bomb 类问题
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    // app://bundle/xxx → out/renderer/xxx（打包后 renderer 与 main 同级 out 下）
    protocol.handle("app", async (request) => {
      const { pathname } = new URL(request.url);
      const rel = pathname === "/" || pathname === "" ? "/index.html" : pathname;
      const filePath = join(__dirname, "../renderer", rel);
      const res = await net.fetch(pathToFileURL(filePath).toString());
      const type = mimeFor(rel);
      if (type) {
        const headers = new Headers(res.headers);
        headers.set("content-type", type);
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    });
    try {
      initProvider();
    } catch {
      // 凭证等问题：窗口起来后提示
    }
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// —— IPC：渲染 → 主 ——
ipcMain.on("chat:send", async (_e, text: string, images?: string[]) => {
  const agent = getAgent(currentId);
  if (!agent) {
    send("evt:error", "未初始化：请在设置里填入 API key(Claude/OpenAI) 或本地端点后重试。");
    return;
  }
  currentAbort = new AbortController();
  try {
    await agent.send(
      text,
      {
        onText: (delta) => send("evt:assistant-delta", delta),
        onToolStart: (name, input) => send("evt:tool-start", { name, input }),
        onToolEnd: (name, result, isError) => send("evt:tool-end", { name, result, isError }),
        requestPermission: (tool, input) =>
          new Promise((resolve) => {
            const id = ++permSeq;
            pendingPerm.set(id, resolve);
            send("evt:permission-request", { id, name: tool.name, input });
          }),
        onUsage: (u) => send("evt:usage", u),
        onCompact: (b, a) => send("evt:compact", { before: b, after: a }),
        onAssistantDone: () => send("evt:done"),
      },
      currentAbort.signal,
      images,
    );
    send("evt:done");
  } catch (e: any) {
    if (e?.name === "AbortError" || currentAbort?.signal.aborted) {
      send("evt:stopped");
    } else {
      send("evt:error", e.message);
    }
  } finally {
    currentAbort = null;
    persistCurrent(); // 每轮结束落盘会话
  }
});

ipcMain.on("chat:stop", () => {
  currentAbort?.abort();
  // 若正卡在权限确认，一并取消
  for (const [id, r] of pendingPerm) {
    r("deny");
    pendingPerm.delete(id);
  }
});

ipcMain.on("perm:respond", (_e, id: number, decision: "allow" | "deny") => {
  const r = pendingPerm.get(id);
  if (r) {
    r(decision);
    pendingPerm.delete(id);
  }
});

// —— 会话管理 IPC ——
ipcMain.on("session:new", () => {
  currentId = randomUUID();
  const a = getAgent(currentId);
  send("evt:session-loaded", { id: currentId, messages: a ? a.getMessages() : [] });
  sendUsageFor(currentId);
});

ipcMain.on("session:switch", (_e, id: string) => {
  currentId = id;
  const a = getAgent(id);
  send("evt:session-loaded", { id, messages: a ? a.getMessages() : [] });
  sendUsageFor(id);
});

ipcMain.on("session:delete", (_e, id: string) => {
  deleteSession(id);
  agents.delete(id);
  if (currentId === id) {
    const list = listSessions();
    currentId = list[0]?.id ?? randomUUID();
    const a = getAgent(currentId);
    send("evt:session-loaded", { id: currentId, messages: a ? a.getMessages() : [] });
    sendUsageFor(currentId);
  }
  send("evt:sessions", listSessions());
});

// /reset：清空当前会话
// 外部链接用系统浏览器打开（Markdown 里的链接，防在 app 内导航离开）
ipcMain.on("open-external", (_e, url: string) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.on("chat:reset", () => {
  const a = getAgent(currentId);
  if (a) {
    a.setMessages([]);
    a.setUsage({ totalInput: 0, totalOutput: 0, lastInput: 0 });
  }
  send("evt:session-loaded", { id: currentId, messages: [] });
  sendUsageFor(currentId);
});

// —— 设置（provider/model）——
ipcMain.handle("settings:get", () => ({
  settings: loadSettings(),
  backend: backendLabel,
  model: modelLabel,
}));

ipcMain.on("settings:set", (_e, s: Settings) => {
  try {
    applySettings(s);
  } catch (e: any) {
    send("evt:error", "切换后端失败：" + e.message);
  }
});
