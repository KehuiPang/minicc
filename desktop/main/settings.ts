// 用户设置持久化：模型后端(provider)与模型选择，存 ~/.minicc/config.json。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".minicc");
const FILE = join(DIR, "config.json");
const USG = join(DIR, "usage.json");
const WIN = join(DIR, "window.json");

// token 用量快照持久化（上下文窗口占用别每次归零）
export function loadUsage(): unknown {
  try {
    return JSON.parse(readFileSync(USG, "utf8"));
  } catch {
    return null;
  }
}
export function saveUsage(u: unknown) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(USG, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

// 窗口尺寸/位置持久化（下次按上次的开）
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}
export function loadWindowBounds(): WindowBounds | null {
  try {
    return JSON.parse(readFileSync(WIN, "utf8"));
  } catch {
    return null;
  }
}
export function saveWindowBounds(b: WindowBounds) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(WIN, JSON.stringify(b));
  } catch {
    /* ignore */
  }
}

// 公开版：仅 API key 方式（Claude API / OpenAI 兼容/本地）
export type ProviderKind = "anthropic-apikey" | "openai";

export interface Settings {
  kind: ProviderKind;
  providerId?: string; // UI 预设平台标识(anthropic/openai/deepseek/qwen/doubao/minimax/custom)，仅回显用
  model?: string;
  apiKey?: string; // anthropic-apikey / openai
  baseUrl?: string; // openai 兼容端点(官方/国内平台/本地/自建)
}

export function loadSettings(): Settings | null {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveSettings(s: Settings) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

// 把设置映射成环境变量（loadConfig 据此构造 Config）
export function applyEnvFromSettings(s: Settings | null) {
  for (const k of ["MINICC_PROVIDER", "MINICC_MODEL", "MINICC_BASE_URL", "MINICC_API_KEY", "ANTHROPIC_API_KEY"]) {
    delete process.env[k];
  }
  if (!s) return; // 无设置：走 loadConfig 自动推断
  if (s.model) process.env.MINICC_MODEL = s.model;
  switch (s.kind) {
    case "anthropic-apikey":
      process.env.MINICC_PROVIDER = "anthropic";
      if (s.apiKey) process.env.ANTHROPIC_API_KEY = s.apiKey;
      break;
    case "openai":
      process.env.MINICC_PROVIDER = "openai";
      if (s.baseUrl) process.env.MINICC_BASE_URL = s.baseUrl;
      if (s.apiKey) process.env.MINICC_API_KEY = s.apiKey;
      break;
  }
}
