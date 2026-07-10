// 渲染进程可见的 window.minicc 类型（来自 preload）
export interface MiniccApi {
  send(text: string, images?: string[]): void;
  stop(): void;
  reset(): void;
  newSession(): void;
  switchSession(id: string): void;
  deleteSession(id: string): void;
  getSettings(): Promise<{ settings: any; backend: string; model: string }>;
  setSettings(s: any): void;
  openExternal(url: string): void;
  respondPermission(id: number, decision: "allow" | "deny"): void;
  onEvent(cb: (channel: string, payload: unknown) => void): void;
}
declare global {
  interface Window {
    minicc: MiniccApi;
  }
}
export {};
