// 会话持久化：会话列表 + 每会话消息存到 ~/.minicc/。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/types.js";

const DIR = join(homedir(), ".minicc");
const SDIR = join(DIR, "sessions");
const META = join(DIR, "sessions.json");

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  usage?: { totalInput: number; totalOutput: number; lastInput: number };
}

function ensure() {
  mkdirSync(SDIR, { recursive: true });
}

export function listSessions(): SessionMeta[] {
  ensure();
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return [];
  }
}

function saveList(l: SessionMeta[]) {
  ensure();
  writeFileSync(META, JSON.stringify(l));
}

export function loadMessages(id: string): Message[] {
  try {
    return JSON.parse(readFileSync(join(SDIR, id + ".json"), "utf8"));
  } catch {
    return [];
  }
}

export function saveSession(
  id: string,
  messages: Message[],
  title: string,
  now: number,
  usage?: SessionMeta["usage"],
) {
  ensure();
  writeFileSync(join(SDIR, id + ".json"), JSON.stringify(messages));
  const l = listSessions().filter((s) => s.id !== id);
  l.unshift({ id, title, updatedAt: now, usage });
  saveList(l);
}

export function deleteSession(id: string) {
  try {
    rmSync(join(SDIR, id + ".json"));
  } catch {
    /* ignore */
  }
  saveList(listSessions().filter((s) => s.id !== id));
}

// 从首条用户消息推导标题
export function deriveTitle(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) {
          const t = b.text.trim().replace(/\s+/g, " ");
          return t.length > 24 ? t.slice(0, 24) + "…" : t;
        }
      }
    }
  }
  return "新对话";
}
