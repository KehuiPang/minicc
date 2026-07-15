// preload：用 contextBridge 暴露最小安全 API 给渲染进程（隔离，不开 nodeIntegration）。
import { contextBridge, ipcRenderer } from "electron";

const EVENTS = [
  "evt:ready",
  "evt:assistant-delta",
  "evt:tool-start",
  "evt:tool-end",
  "evt:permission-request",
  "evt:usage",
  "evt:compact",
  "evt:done",
  "evt:stopped",
  "evt:error",
  "evt:sessions",
  "evt:session-loaded",
] as const;

contextBridge.exposeInMainWorld("wuwei", {
  send: (text: string, images?: string[]) => ipcRenderer.send("chat:send", text, images),
  stop: () => ipcRenderer.send("chat:stop"),
  reset: () => ipcRenderer.send("chat:reset"),
  newSession: () => ipcRenderer.send("session:new"),
  switchSession: (id: string) => ipcRenderer.send("session:switch", id),
  deleteSession: (id: string) => ipcRenderer.send("session:delete", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: unknown) => ipcRenderer.send("settings:set", s),
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  respondPermission: (id: number, decision: "allow" | "deny") =>
    ipcRenderer.send("perm:respond", id, decision),
  // 统一事件订阅：cb(channel, payload)
  onEvent: (cb: (channel: string, payload: unknown) => void) => {
    for (const ch of EVENTS) {
      ipcRenderer.on(ch, (_e, payload) => cb(ch, payload));
    }
  },
});
