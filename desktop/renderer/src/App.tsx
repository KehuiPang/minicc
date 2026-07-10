import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

type Item =
  | { type: "user"; text: string; images?: string[] }
  | { type: "assistant"; text: string }
  | {
      type: "tool";
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      status: "running" | "done";
    }
  | { type: "notice"; text: string };

interface Usage {
  totalInput: number;
  totalOutput: number;
  lastInput: number;
}
interface Pending {
  id: number;
  name: string;
  input: Record<string, unknown>;
}
interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const CTX_MAX = 1_000_000; // gpt-5.5 上下文窗口估算，用于占用条

// 把持久化的 messages 还原成展示用 items
function messagesToItems(messages: any[]): Item[] {
  const items: Item[] = [];
  const toolById: Record<string, Extract<Item, { type: "tool" }>> = {};
  for (const m of messages) {
    if (m.role === "user") {
      let text = "";
      const imgs: string[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) text += b.text;
        else if (b.type === "image") imgs.push(b.dataUrl);
        else if (b.type === "tool_result" && toolById[b.tool_use_id]) {
          const t = toolById[b.tool_use_id];
          t.result = b.content;
          t.isError = b.is_error;
          t.status = "done";
        }
      }
      if (text || imgs.length)
        items.push({ type: "user", text, images: imgs.length ? imgs : undefined });
    } else {
      for (const b of m.content) {
        if (b.type === "text" && b.text) items.push({ type: "assistant", text: b.text });
        else if (b.type === "tool_use") {
          const it: Extract<Item, { type: "tool" }> = {
            type: "tool",
            name: b.name,
            input: b.input,
            status: "done",
          };
          items.push(it);
          toolById[b.id] = it;
        }
      }
    }
  }
  return items;
}

export function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [meta, setMeta] = useState({ backend: "…", model: "…", cwd: "" });
  const [usage, setUsage] = useState<Usage>({ totalInput: 0, totalOutput: 0, lastInput: 0 });
  const [input, setInput] = useState("");
  const [autoMode, setAutoMode] = useState(true);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [showUsage, setShowUsage] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarW, setSidebarW] = useState(
    () => Number(localStorage.getItem("minicc-sidebar-w")) || 232,
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("minicc-sidebar-collapsed") === "1",
  );
  const sidebarWRef = useRef(sidebarW);
  sidebarWRef.current = sidebarW;
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const thinkStartRef = useRef<number | null>(null); // 本轮开始时间（思考计时）
  const charsRef = useRef(0); // 本轮已流式字符数（估算 token）
  // 已"总是允许"的工具（记住授权，跨重启，手动模式下不再提示）
  const alwaysAllowRef = useRef<Set<string>>(
    new Set((() => {
      try {
        return JSON.parse(localStorage.getItem("minicc-allow") || "[]");
      } catch {
        return [];
      }
    })()),
  );
  const autoRef = useRef(autoMode);
  autoRef.current = autoMode;
  const streamRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef<number>(-1);

  const push = (it: Item) => setItems((p) => [...p, it]);

  useEffect(() => {
    window.minicc.onEvent((ch, payload: any) => {
      switch (ch) {
        case "evt:ready":
          setMeta(payload);
          break;
        case "evt:sessions":
          setSessions(payload);
          break;
        case "evt:session-loaded":
          setCurrentId(payload.id);
          setItems(messagesToItems(payload.messages));
          setBusy(false);
          break;
        case "evt:assistant-delta":
          charsRef.current += (payload as string).length;
          setItems((p) => {
            const last = p[p.length - 1];
            if (last && last.type === "assistant") {
              const c = [...p];
              c[c.length - 1] = { ...last, text: last.text + payload };
              return c;
            }
            return [...p, { type: "assistant", text: payload }];
          });
          break;
        case "evt:tool-start":
          push({ type: "tool", name: payload.name, input: payload.input, status: "running" });
          break;
        case "evt:tool-end":
          setItems((p) => {
            const idx = [...p].reverse().findIndex((i) => i.type === "tool" && i.status === "running");
            if (idx === -1) return p;
            const real = p.length - 1 - idx;
            const c = [...p];
            c[real] = { ...(c[real] as any), result: payload.result, isError: payload.isError, status: "done" };
            return c;
          });
          break;
        case "evt:permission-request":
          if (autoRef.current || alwaysAllowRef.current.has(payload.name))
            window.minicc.respondPermission(payload.id, "allow");
          else setPending(payload);
          break;
        case "evt:usage":
          setUsage(payload);
          break;
        case "evt:compact":
          push({ type: "notice", text: `上下文已压缩：${payload.before} → ${payload.after} 条消息` });
          break;
        case "evt:done":
          thinkStartRef.current = null;
          setBusy(false);
          break;
        case "evt:stopped":
          thinkStartRef.current = null;
          push({ type: "notice", text: "已停止" });
          setBusy(false);
          break;
        case "evt:error":
          thinkStartRef.current = null;
          push({ type: "notice", text: `出错：${payload}` });
          setBusy(false);
          break;
      }
    });
  }, []);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [items, busy, pending]);

  // 点用量面板外部时自动关闭
  useEffect(() => {
    if (!showUsage) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".usage-panel") && !t.closest(".usage-btn")) setShowUsage(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showUsage]);

  // 拖动侧边栏右边缘调宽度
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWRef.current;
    const move = (ev: MouseEvent) => {
      const w = Math.min(420, Math.max(170, startW + ev.clientX - startX));
      setSidebarW(w);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      localStorage.setItem("minicc-sidebar-w", String(sidebarWRef.current));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function toggleCollapse(v: boolean) {
    setCollapsed(v);
    localStorage.setItem("minicc-sidebar-collapsed", v ? "1" : "0");
  }

  // 读取图片文件为 dataURL
  function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => setPendingImages((p) => [...p, reader.result as string]);
      reader.readAsDataURL(f);
    }
  }

  function submit() {
    const text = input.trim();
    if (busy) return;
    if (!text && pendingImages.length === 0) return;
    if (text === "/reset") {
      window.minicc.reset();
      setInput("");
      return;
    }
    const imgs = pendingImages;
    if (text) {
      history.current.push(text);
      histIdx.current = history.current.length;
    }
    push({ type: "user", text, images: imgs.length ? imgs : undefined });
    setBusy(true);
    thinkStartRef.current = Date.now();
    charsRef.current = 0;
    window.minicc.send(text, imgs.length ? imgs : undefined);
    setInput("");
    setPendingImages([]);
    if (taRef.current) taRef.current.style.height = "auto";
  }

  const stop = () => window.minicc.stop();

  function answerPerm(decision: "allow" | "deny") {
    if (!pending) return;
    window.minicc.respondPermission(pending.id, decision);
    setPending(null);
  }

  function allowAlways() {
    if (!pending) return;
    alwaysAllowRef.current.add(pending.name);
    localStorage.setItem("minicc-allow", JSON.stringify([...alwaysAllowRef.current]));
    window.minicc.respondPermission(pending.id, "allow");
    setPending(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && input === "") {
      if (histIdx.current > 0) {
        histIdx.current -= 1;
        setInput(history.current[histIdx.current] ?? "");
      }
    } else if (e.key === "Escape") {
      setInput("");
    }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (pending) {
        if (e.key === "Escape" || e.key === "n" || e.key === "N") answerPerm("deny");
        if (e.key === "y" || e.key === "Y") answerPerm("allow");
        if (e.key === "a" || e.key === "A") allowAlways();
      } else if (busy && e.key === "Escape") {
        stop();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [pending, busy]);

  const ctxPct = Math.min(100, Math.round((usage.lastInput / CTX_MAX) * 100));

  return (
    <div className="shell">
      {/* 侧边栏：会话历史（可拖宽/可折叠） */}
      {!collapsed && (
      <div className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-top">
          <button className="icon-btn" title="收起侧栏" onClick={() => toggleCollapse(true)}>
            «
          </button>
        </div>
        <button className="new-session" onClick={() => window.minicc.newSession()}>
          ＋ 新对话
        </button>
        <div className="session-list">
          {sessions.length === 0 && <div className="empty">暂无历史对话</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={"session-item" + (s.id === currentId ? " active" : "")}
              onClick={() => window.minicc.switchSession(s.id)}
            >
              <span className="s-title">{s.title}</span>
              <button
                className="s-del"
                onClick={(e) => {
                  e.stopPropagation();
                  window.minicc.deleteSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="acct-logout" onClick={() => setShowSettings(true)}>
            {meta.backend} · {meta.model} · 设置
          </button>
        </div>
        <div className="resizer" onMouseDown={startResize} />
      </div>
      )}

      {/* 主区 */}
      <div className="main">
        <div className="titlebar">minicc — {meta.cwd || "…"}</div>

        <div className="toolbar">
          {collapsed && (
            <button className="icon-btn" title="展开侧栏" onClick={() => toggleCollapse(false)}>
              »
            </button>
          )}
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>模式</span>
          <div className="mode-toggle">
            <button className={autoMode ? "on" : ""} onClick={() => setAutoMode(true)}>
              自动
            </button>
            <button className={!autoMode ? "on" : ""} onClick={() => setAutoMode(false)}>
              手动
            </button>
          </div>
          <span style={{ color: "var(--text-dim)", fontSize: 11.5 }}>
            {autoMode ? "工具自动放行" : "每步需确认"}
          </span>
          <span className="spacer" />
          <button className="model-btn" onClick={() => setShowSettings(true)}>
            {meta.backend} · {meta.model} ⚙
          </button>
        </div>

        <div className="stream" ref={streamRef}>
          {items.length === 0 && (
            <div className="welcome">
              <h1>
                minicc <span className="dot">●</span>
              </h1>
              <p>自研 Claude Code · 桌面版。直接描述你的编码需求，它会读写文件、执行命令帮你完成。</p>
              <p>Enter 发送，Shift+Enter 换行，↑ 翻历史，忙碌时 Esc 停止。</p>
              <p>左侧可新建/切换历史对话；「自动」模式工具直接放行。</p>
              <div className="meta">
                后端 {meta.backend} · 模型 {meta.model}
              </div>
            </div>
          )}
          {groupBlocks(items).map((b, i) =>
            b.kind === "item" ? (
              <ItemView key={i} item={b.item} />
            ) : (
              <ToolGroup key={i} tools={b.tools} />
            ),
          )}
          {busy && !pending && <ThinkingBar startRef={thinkStartRef} charsRef={charsRef} />}
        </div>

        <div className="composer">
          {pendingImages.length > 0 && (
            <div className="img-strip">
              {pendingImages.map((src, i) => (
                <div className="thumb" key={i}>
                  <img src={src} alt="" />
                  <button onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="input-wrap">
            <button
              className="attach-btn"
              title="添加图片"
              onClick={() => fileRef.current?.click()}
            >
              ＋
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <textarea
              ref={taRef}
              rows={1}
              placeholder="描述你的需求…（可粘贴/添加图片；/reset 清空对话）"
              value={input}
              disabled={busy}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const its = e.clipboardData?.items;
                if (!its) return;
                const files: File[] = [];
                for (const it of its)
                  if (it.type.startsWith("image/")) {
                    const f = it.getAsFile();
                    if (f) files.push(f);
                  }
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
            />
            {busy ? (
              <button className="round-btn stop" onClick={stop} title="停止">
                <span className="stop-sq" />
              </button>
            ) : (
              <button
                className="round-btn send"
                onClick={submit}
                title="发送"
                disabled={!input.trim() && pendingImages.length === 0}
              >
                ↑
              </button>
            )}
          </div>
        </div>

        <div className="statusbar">
          <span className={busy ? "busy" : ""}>{busy ? "● 运行中（Esc 停止）" : "○ 就绪"}</span>
          <span className="spacer" />
          <span className="usage-btn" onClick={() => setShowUsage((v) => !v)}>
            <span className="u-seg">上下文 {(usage.lastInput / 1000).toFixed(1)}k</span>
            <span className="u-dot">·</span>
            <span className="u-seg">累计 {((usage.totalInput + usage.totalOutput) / 1000).toFixed(1)}k</span>
            <span className="u-caret">▾</span>
          </span>
        </div>

        {showUsage && (
          <div className="usage-panel">
            <div className="u-row">
              <span>上下文窗口</span>
              <span>
                {(usage.lastInput / 1000).toFixed(1)}k / {(CTX_MAX / 1_000_000).toFixed(1)}M ({ctxPct}
                %)
              </span>
            </div>
            <div className="u-bar">
              <div className="u-fill" style={{ width: ctxPct + "%" }} />
            </div>
            <div className="u-row">
              <span>本会话累计输入</span>
              <span>{usage.totalInput.toLocaleString()} tokens</span>
            </div>
            <div className="u-row">
              <span>本会话累计输出</span>
              <span>{usage.totalOutput.toLocaleString()} tokens</span>
            </div>
            <div className="u-note">token 用量按会话统计，切换会话各自独立。</div>
          </div>
        )}
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {pending && (
        <div className="perm-overlay">
          <div className="perm">
            <h3>
              允许执行 <span className="tname">{pending.name}</span>？
            </h3>
            <div className="args">{JSON.stringify(pending.input, null, 2)}</div>
            <div className="btns">
              <button onClick={() => answerPerm("deny")}>拒绝 (N)</button>
              <button onClick={allowAlways}>总是允许 (A)</button>
              <button className="allow" onClick={() => answerPerm("allow")}>
                允许 (Y)
              </button>
            </div>
            <div className="hint">Y 允许一次 · A 总是允许该工具 · N/Esc 拒绝</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ThinkingBar({
  startRef,
  charsRef,
}: {
  startRef: React.MutableRefObject<number | null>;
  charsRef: React.MutableRefObject<number>;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 400);
    return () => clearInterval(t);
  }, []);
  const start = startRef.current;
  const elapsed = start ? Math.floor((Date.now() - start) / 1000) : 0;
  const chars = charsRef.current;
  const toks = Math.max(0, Math.round(chars / 3));
  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const time = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
  const status = chars === 0 ? (elapsed > 20 ? "深度思考中" : "思考中") : "生成回复";
  return (
    <div className="thinking">
      <span className="tspark">✳</span>
      <span className="tstatus">{status}…</span>
      <span className="tmeta">
        {time} · {toks} tokens
      </span>
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  if (item.type === "user")
    return (
      <div className="msg user">
        <div className="role">你</div>
        <div className="body">
          {item.images && item.images.length > 0 && (
            <div className="msg-imgs">
              {item.images.map((src, i) => (
                <img key={i} src={src} alt="" />
              ))}
            </div>
          )}
          {item.text}
        </div>
      </div>
    );
  if (item.type === "assistant") return <AssistantMsg text={item.text} />;
  if (item.type === "notice") return <div className="notice">ⓘ {item.text}</div>;
  return <ToolView item={item} />;
}

// 把"松散列表"(列表项间有空行)转成紧凑列表，从源头消除列表大间距；段落空行保留
function tightenMarkdown(t: string): string {
  let s = t.replace(/\n{3,}/g, "\n\n");
  // AI 有时用 • ‣ ◦ · ▪ 等字符当项目符号(非标准 markdown → 被当普通段落，间距大)，归一成 -
  s = s.replace(/^([ \t]*)[•‣◦·▪∙]\s+/gm, "$1- ");
  const listItem = /^[ \t]*([-*+]|\d+[.)])\s/;
  const lines = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (cur.trim() === "") {
      const prev = out[out.length - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (listItem.test(prev) && listItem.test(next)) continue; // 删列表项之间的空行
    }
    out.push(cur);
  }
  return out.join("\n").trimEnd();
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path
        d="M12 1.6 Q13.6 10.4 13.6 10.4 Q13.6 10.4 22.4 12 Q13.6 13.6 13.6 13.6 Q13.6 13.6 12 22.4 Q10.4 13.6 10.4 13.6 Q10.4 13.6 1.6 12 Q10.4 10.4 10.4 10.4 Q10.4 10.4 12 1.6 Z"
        fill="#d97757"
      />
    </svg>
  );
}

function AssistantMsg({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="msg assistant">
      <div className="role">
        <SparkIcon />
      </div>
      <div className="body">
        {raw ? (
          <pre className="raw-md">{text}</pre>
        ) : (
          <MarkdownView text={text} />
        )}
        <button className="raw-toggle" onClick={() => setRaw((v) => !v)}>
          {raw ? "← 渲染" : "</> 源码"}
        </button>
      </div>
    </div>
  );
}

function MarkdownView({ text }: { text: string }) {
  const clean = tightenMarkdown(text);
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) window.minicc.openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {clean}
      </Markdown>
    </div>
  );
}

function baseName(p: string): string {
  return p.split("/").pop() || p;
}

// 从 bash 命令推断"在干嘛"（意图），不直白显示命令本身
function bashIntent(cmd: string): { label: string; category: string } {
  const c = cmd.toLowerCase();
  if (/\bgit\b/.test(c)) return { label: "Git 操作", category: "Git 操作" };
  if (/\b(npm|yarn|pnpm|node|python3?|pip|go|cargo|make|tsc)\b/.test(c))
    return { label: "运行命令", category: "运行命令" };
  if (/\b(grep|rg|ag|ack)\b/.test(c)) return { label: "搜索内容", category: "搜索内容" };
  if (/\b(cat|head|tail|less|more|sed|awk)\b/.test(c)) return { label: "查看文件", category: "查看文件" };
  if (/\b(ls|find|tree|cd|pwd|du|stat|fd)\b/.test(c))
    return { label: "浏览目录结构", category: "浏览目录" };
  if (/\b(mkdir|touch|cp|mv|rm|chmod|ln)\b/.test(c))
    return { label: "文件操作", category: "文件操作" };
  return { label: "执行命令", category: "执行命令" };
}

// 工具的图标 + 意图描述 + 类别（分组用）+ 行数增删
function toolMeta(item: Extract<Item, { type: "tool" }>): {
  icon: string;
  label: string;
  category: string;
  add?: number;
  del?: number;
} {
  const inp = item.input as any;
  switch (item.name) {
    case "bash": {
      const bi = bashIntent(String(inp.command || ""));
      return { icon: "⌘", label: bi.label, category: bi.category };
    }
    case "read_file":
      return {
        icon: "◎",
        label: "读取 " + baseName(String(inp.path || "")),
        category: "读取文件",
      };
    case "write_file":
      return {
        icon: "✎",
        label: "新建 " + baseName(String(inp.path || "")),
        category: "新建文件",
        add: String(inp.content ?? "").split("\n").length,
      };
    case "edit_file":
      return {
        icon: "✎",
        label: "编辑 " + baseName(String(inp.path || "")),
        category: "编辑文件",
        add: String(inp.new_string ?? "").split("\n").length,
        del: String(inp.old_string ?? "").split("\n").length,
      };
    case "glob":
      return { icon: "⌕", label: "查找文件", category: "搜索内容" };
    case "grep":
      return { icon: "⌕", label: "搜索内容", category: "搜索内容" };
    default:
      return { icon: "•", label: item.name, category: item.name };
  }
}

function ToolView({ item }: { item: Extract<Item, { type: "tool" }> }) {
  const [open, setOpen] = useState(false); // 默认折叠
  const m = toolMeta(item);
  const running = item.status === "running";
  const diff = renderDiff(item);
  const cmd = item.name === "bash" ? String((item.input as any).command || "") : "";
  const hasDetail = !!diff || !!item.result || !!cmd;
  return (
    <div className="tool">
      <div className="trow" onClick={() => hasDetail && setOpen((v) => !v)}>
        <span className={"ticon" + (running ? " run" : "")}>{running ? "⚙" : m.icon}</span>
        <span className="tlabel">{m.label}</span>
        {(m.add != null || m.del != null) && (
          <span className="tdelta">
            {m.add != null && <span className="add">+{m.add}</span>}
            {m.del != null && <span className="del">-{m.del}</span>}
          </span>
        )}
        <span className="tspacer" />
        <span className={"tstat " + (running ? "run" : item.isError ? "err" : "ok")}>
          {running ? "运行中" : item.isError ? "失败" : "完成"}
        </span>
        {hasDetail && <span className="tcaret">{open ? "▾" : "▸"}</span>}
      </div>
      {open && cmd && <div className="tcmd">$ {cmd}</div>}
      {open && diff}
      {open && !diff && item.result && (
        <div className={"result" + (item.isError ? " err" : "")}>{clip(item.result, 60)}</div>
      )}
    </div>
  );
}

type ToolItem = Extract<Item, { type: "tool" }>;

// 连续的工具调用合并成一组，收起显示概括；点开列步骤，再点开看命令
function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) return <ToolView item={tools[0]} />;
  const running = tools.some((t) => t.status === "running");
  const done = tools.filter((t) => t.status === "done").length;
  const counts: Record<string, number> = {};
  for (const t of tools) {
    const c = toolMeta(t).category;
    counts[c] = (counts[c] || 0) + 1;
  }
  const mainCat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "操作";
  return (
    <div className="tool">
      <div className="trow" onClick={() => setOpen((v) => !v)}>
        <span className={"ticon" + (running ? " run" : "")}>{running ? "⚙" : "⋯"}</span>
        <span className="tlabel">
          {mainCat} · {tools.length} 步{running ? `（${done}/${tools.length}）` : ""}
        </span>
        <span className="tspacer" />
        <span className="tcaret">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="tgroup-items">
          {tools.map((t, i) => (
            <ToolView key={i} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}

type RenderBlock = { kind: "item"; item: Item } | { kind: "tools"; tools: ToolItem[] };
function groupBlocks(items: Item[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  for (const it of items) {
    if (it.type === "tool") {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "tools") last.tools.push(it);
      else blocks.push({ kind: "tools", tools: [it] });
    } else {
      blocks.push({ kind: "item", item: it });
    }
  }
  return blocks;
}

function renderDiff(item: Extract<Item, { type: "tool" }>) {
  if (item.status !== "done") return null;
  if (item.name === "edit_file" && item.input.old_string && item.input.new_string) {
    const del = String(item.input.old_string).split("\n");
    const add = String(item.input.new_string).split("\n");
    return (
      <div className="diff">
        {del.map((l, i) => (
          <div key={"d" + i} className="line del">
            - {l}
          </div>
        ))}
        {add.map((l, i) => (
          <div key={"a" + i} className="line add">
            + {l}
          </div>
        ))}
      </div>
    );
  }
  if (item.name === "write_file" && typeof item.input.content === "string") {
    const add = String(item.input.content).split("\n").slice(0, 40);
    return (
      <div className="diff">
        {add.map((l, i) => (
          <div key={"a" + i} className="line add">
            + {l}
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function clip(text: string, lines = 12): string {
  const arr = text.split("\n");
  return arr.length > lines ? arr.slice(0, lines).join("\n") + "\n…（已截断）" : text;
}

type Kind = "anthropic-apikey" | "openai";
const PROVIDERS: { kind: Kind; label: string }[] = [
  { kind: "anthropic-apikey", label: "Claude API Key" },
  { kind: "openai", label: "OpenAI 兼容 / 本地 / 自建（vLLM、Ollama 等）" },
];
const MODEL_SUGGEST: Record<Kind, string[]> = {
  "anthropic-apikey": ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-20241022"],
  openai: ["gpt-4o", "gpt-4o-mini", "qwen3-coder"],
};
const DEFAULT_MODEL: Record<Kind, string> = {
  "anthropic-apikey": "claude-sonnet-4-20250514",
  openai: "gpt-4o",
};

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("anthropic-apikey");
  const [model, setModel] = useState(DEFAULT_MODEL["anthropic-apikey"]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    window.minicc.getSettings().then((r) => {
      const s = r?.settings;
      if (s) {
        setKind(s.kind);
        setModel(s.model || DEFAULT_MODEL[s.kind as Kind] || "");
        setApiKey(s.apiKey || "");
        setBaseUrl(s.baseUrl || "");
      }
    });
  }, []);

  function changeKind(k: Kind) {
    setKind(k);
    setModel(DEFAULT_MODEL[k]);
  }

  function save() {
    window.minicc.setSettings({
      kind,
      model: model || undefined,
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
    });
    onClose();
  }

  return (
    <div className="perm-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <h3>模型后端设置</h3>

        <label className="field">
          <span>Provider</span>
          <select value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            {PROVIDERS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>模型</span>
          <input
            list="model-suggest"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="模型名"
          />
          <datalist id="model-suggest">
            {MODEL_SUGGEST[kind].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        {kind === "anthropic-apikey" && (
          <label className="field">
            <span>API Key</span>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-..." />
          </label>
        )}
        {kind === "openai" && (
          <>
            <label className="field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1 或 http://localhost:8000/v1"
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-... (本地可留空)" />
            </label>
          </>
        )}

        <div className="btns">
          <button onClick={onClose}>取消</button>
          <button className="allow" onClick={save}>
            保存并切换
          </button>
        </div>
      </div>
    </div>
  );
}
