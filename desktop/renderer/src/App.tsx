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
  const [curProviderId, setCurProviderId] = useState("");
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [sidebarW, setSidebarW] = useState(
    () => Number(localStorage.getItem("wuwei-sidebar-w")) || 232,
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("wuwei-sidebar-collapsed") === "1",
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
        return JSON.parse(localStorage.getItem("wuwei-allow") || "[]");
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

  // 当前平台预设(用于底栏模型快切列出该平台模型)；设置面板关闭后刷新
  useEffect(() => {
    window.wuwei.getSettings().then((r) => setCurProviderId(r?.settings?.providerId || ""));
  }, [showSettings]);
  const curPreset = PRESETS.find((p) => p.id === curProviderId);
  const quickModels = curPreset?.models ?? [];
  async function quickModel(m: string) {
    const r = await window.wuwei.getSettings();
    const cur = r?.settings;
    if (cur) window.wuwei.setSettings({ ...cur, model: m });
    setShowModelMenu(false);
  }
  // 快捷切换供应商：带出该平台已存的 key/baseUrl，默认用该平台第一个模型
  async function quickProvider(p: (typeof PRESETS)[number]) {
    const r = await window.wuwei.getSettings();
    const cur = r?.settings || {};
    const slot = (cur.creds || {})[p.id] || {};
    window.wuwei.setSettings({
      ...cur,
      kind: p.kind,
      providerId: p.id,
      apiKey: slot.apiKey,
      baseUrl: p.fixedBaseUrl ? p.baseUrl : slot.baseUrl || p.baseUrl,
      model: p.models[0] || cur.model,
    });
    setCurProviderId(p.id);
    setShowProviderMenu(false);
  }

  useEffect(() => {
    window.wuwei.onEvent((ch, payload: any) => {
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
            window.wuwei.respondPermission(payload.id, "allow");
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
      localStorage.setItem("wuwei-sidebar-w", String(sidebarWRef.current));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function toggleCollapse(v: boolean) {
    setCollapsed(v);
    localStorage.setItem("wuwei-sidebar-collapsed", v ? "1" : "0");
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
      window.wuwei.reset();
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
    window.wuwei.send(text, imgs.length ? imgs : undefined);
    setInput("");
    setPendingImages([]);
    if (taRef.current) taRef.current.style.height = "auto";
  }

  const stop = () => window.wuwei.stop();

  function answerPerm(decision: "allow" | "deny") {
    if (!pending) return;
    window.wuwei.respondPermission(pending.id, decision);
    setPending(null);
  }

  function allowAlways() {
    if (!pending) return;
    alwaysAllowRef.current.add(pending.name);
    localStorage.setItem("wuwei-allow", JSON.stringify([...alwaysAllowRef.current]));
    window.wuwei.respondPermission(pending.id, "allow");
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
        <button className="new-session" onClick={() => window.wuwei.newSession()}>
          ＋ 新对话
        </button>
        <div className="session-list">
          {sessions.length === 0 && <div className="empty">暂无历史对话</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={"session-item" + (s.id === currentId ? " active" : "")}
              onClick={() => window.wuwei.switchSession(s.id)}
            >
              <span className="s-title">{s.title}</span>
              <button
                className="s-del"
                onClick={(e) => {
                  e.stopPropagation();
                  window.wuwei.deleteSession(s.id);
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
        <div className="titlebar">wuwei — {meta.cwd || "…"}</div>

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
                wuwei <span className="dot">●</span>
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

          <div className="model-quick">
            <button className="mq-btn mq-prov" onClick={() => setShowProviderMenu((v) => !v)}>
              {meta.backend} <span className="mq-caret">▾</span>
            </button>
            <span className="mq-mid">·</span>
            <button className="mq-btn mq-mod" onClick={() => setShowModelMenu((v) => !v)}>
              {meta.model} <span className="mq-caret">▾</span>
            </button>
            {showProviderMenu && (
              <>
                <div className="mq-overlay" onClick={() => setShowProviderMenu(false)} />
                <div className="mq-menu mq-menu-prov">
                  <div className="mq-head">切换平台</div>
                  {ORDERED_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={"mq-item" + (p.id === curProviderId ? " on" : "")}
                      onClick={() => quickProvider(p)}
                    >
                      <span>{p.label}</span>
                      {p.id === curProviderId && <span className="mq-check">✓</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
            {showModelMenu && (
              <>
                <div className="mq-overlay" onClick={() => setShowModelMenu(false)} />
                <div className="mq-menu">
                  <div className="mq-head">切换模型 · {curPreset?.label ?? meta.backend}</div>
                  {quickModels.length === 0 && <div className="mq-empty">无预设模型，去设置里填</div>}
                  {quickModels.map((m) => (
                    <button
                      key={m}
                      className={"mq-item" + (m === meta.model ? " on" : "")}
                      onClick={() => quickModel(m)}
                    >
                      <span>{m}</span>
                      {m === meta.model && <span className="mq-check">✓</span>}
                    </button>
                  ))}
                  <div className="mq-sep" />
                  <button
                    className="mq-item mq-more"
                    onClick={() => {
                      setShowModelMenu(false);
                      setShowSettings(true);
                    }}
                  >
                    全部设置 / 换平台…
                  </button>
                </div>
              </>
            )}
          </div>

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
                if (href) window.wuwei.openExternal(href);
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
interface Preset {
  id: string;
  label: string;
  kind: Kind;
  baseUrl: string; // "" = anthropic 官方 / 或用户自填(custom)
  keyUrl: string; // 获取 API key 的官网页面（点链接跳转）
  keyHint: string; // key 输入框占位
  models: string[];
  modelLabels?: Record<string, string>; // 模型 id → 灰字说明
  note?: string;
  fixedBaseUrl: boolean; // false=用户可编辑 baseUrl(本地/自定义)
}
const PRESETS: Preset[] = [
  {
    id: "anthropic",
    label: "Claude（Anthropic）",
    kind: "anthropic-apikey",
    baseUrl: "",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-...",
    models: [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-fable-5",
    ],
    fixedBaseUrl: true,
  },
  {
    id: "openai",
    label: "OpenAI（GPT）",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-...",
    models: [
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o4-mini",
    ],
    note: "gpt-5.6-terra 均衡 / sol 最强 / luna 省钱",
    fixedBaseUrl: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-...",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    note: "V4 Pro/Flash；deepseek-chat/deepseek-reasoner 2026-07-24 后停用",
    fixedBaseUrl: true,
  },
  {
    id: "qwen",
    label: "通义千问 Qwen（阿里百炼）",
    kind: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    keyHint: "sk-...",
    models: [
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-flash",
      "qwen3-max",
      "qwen-max",
      "qwen-plus",
      "qwen-flash",
      "qwen-turbo",
      "qwen-long",
      "qwen3-coder-plus",
      "qwen3-coder-flash",
    ],
    fixedBaseUrl: true,
  },
  {
    id: "doubao",
    label: "豆包 Doubao（火山方舟）",
    kind: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    keyHint: "火山方舟 API Key",
    models: [
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-1-8-251228",
      "doubao-seed-1-6-251015",
      "doubao-seed-1-6-flash-250828",
      "doubao-seed-1-6-lite-251015",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115",
    ],
    note: "豆包多在方舟「在线推理」创建接入点后用接入点 ID(ep-...)；模型名带日期串会更新，可用「自定义」直接填最新的",
    fixedBaseUrl: true,
  },
  {
    id: "minimax",
    label: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimaxi.com/v1",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    keyHint: "MiniMax API Key",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
    fixedBaseUrl: true,
  },
  {
    id: "zhipu",
    label: "智谱 GLM（BigModel）",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyUrl: "https://open.bigmodel.cn/apikey/platform",
    keyHint: "智谱 API Key",
    models: [
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
      "glm-4.7-flash",
      "glm-5v-turbo",
      "glm-4.6v",
      "glm-4.6v-flash",
      "glm-4.1v-thinking",
    ],
    note: "glm-5.2 旗舰(1M上下文)；glm-5v-turbo / glm-4.6v 为视觉多模态(支持图文)",
    fixedBaseUrl: true,
  },
  {
    id: "kimi",
    label: "Kimi（月之暗面 Moonshot）",
    kind: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    keyHint: "sk-...",
    models: [
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-latest",
      "moonshot-v1-128k",
      "moonshot-v1-32k",
      "moonshot-v1-8k",
      "moonshot-v1-128k-vision-preview",
      "moonshot-v1-32k-vision-preview",
      "moonshot-v1-8k-vision-preview",
    ],
    note: "国际站请改 https://api.moonshot.ai/v1；kimi-latest 与 *-vision-preview 支持图文",
    fixedBaseUrl: false,
  },
  {
    id: "hunyuan",
    label: "腾讯混元（元宝）",
    kind: "openai",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    keyHint: "混元 API Key",
    models: [
      "hunyuan-turbos-latest",
      "hunyuan-t1-latest",
      "hunyuan-turbo-latest",
      "hunyuan-large",
      "hunyuan-standard",
      "hunyuan-lite",
      "hunyuan-vision",
    ],
    note: "元宝对应腾讯混元 API；hunyuan-vision 支持图文",
    fixedBaseUrl: true,
  },
  {
    id: "grok",
    label: "Grok（xAI）",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyHint: "xai-...",
    models: [
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ],
    note: "grok-4.x 系原生多模态(支持图文)；grok-4.3 为 1M 上下文旗舰",
    fixedBaseUrl: true,
  },
  {
    id: "custom",
    label: "本地 / 自建端点（vLLM、Ollama 等）",
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    keyUrl: "",
    keyHint: "本地可留空",
    models: [],
    note: "任意 OpenAI 兼容端点，填你的 Base URL + 模型名即可",
    fixedBaseUrl: false,
  },
];

// 菜单/下拉里的展示顺序(不改 PRESETS 定义本身)；anthropic 打头，custom 收尾
const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "zhipu",
  "deepseek",
  "minimax",
  "doubao",
  "qwen",
  "kimi",
  "hunyuan",
  "grok",
  "custom",
];
const ORDERED_PRESETS: Preset[] = PROVIDER_ORDER.map(
  (id) => PRESETS.find((p) => p.id === id)!,
).filter(Boolean);

type CredSlot = { apiKey?: string; baseUrl?: string };

// 简约线条眼睛图标：off=true 显示"划掉的眼睛"(当前明文，点击隐藏)
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [pid, setPid] = useState("anthropic");
  const [model, setModel] = useState(PRESETS[0].models[0]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [creds, setCreds] = useState<Record<string, CredSlot>>({}); // 各平台凭证分槽
  const credsRef = useRef(creds); // 镜像最新 creds，避免切换时读到过时闭包(会误显示空 key→保存覆盖)
  credsRef.current = creds;
  const preset = PRESETS.find((p) => p.id === pid) ?? PRESETS[0];

  // 把某平台槽里的凭证取出来填进字段(没存过就空/回退默认 baseUrl)
  function slotFields(c: Record<string, CredSlot>, id: string, p: (typeof PRESETS)[number]) {
    const slot = c[id] || {};
    return {
      apiKey: slot.apiKey || "",
      // 固定端点的平台始终用预设 baseUrl，忽略旧存值(避免端点迁移后残留旧地址连不上)
      baseUrl: p.fixedBaseUrl ? p.baseUrl : slot.baseUrl || p.baseUrl,
    };
  }

  useEffect(() => {
    window.wuwei.getSettings().then((r) => {
      const s = r?.settings;
      if (!s) return;
      const p = PRESETS.find((x) => x.id === s.providerId) ?? PRESETS[0];
      const c: Record<string, CredSlot> = { ...(s.creds || {}) };
      // 兼容旧配置(只有顶层单套凭证)：迁移到当前平台槽
      if (!c[p.id] && (s.apiKey || s.baseUrl)) c[p.id] = { apiKey: s.apiKey, baseUrl: s.baseUrl };
      setCreds(c);
      credsRef.current = c;
      const f = slotFields(c, p.id, p);
      setPid(p.id);
      setModel(s.model || p.models[0] || "");
      setApiKey(f.apiKey);
      setBaseUrl(f.baseUrl);
      // 已存模型不在预设列表里(或该平台无预设)→ 切到手输框回显
      setCustomModel(p.models.length === 0 || (!!s.model && !p.models.includes(s.model)));
    });
  }, []);

  function changePreset(id: string) {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
    // 先把当前平台的凭证存回它自己的槽，再从「最新」creds(ref)带出目标平台的槽
    // 用 credsRef 而非闭包 creds：否则连续切换会读到过时值→目标 key 显示空→保存把空覆盖回去
    const merged = { ...credsRef.current, [pid]: { apiKey, baseUrl } };
    credsRef.current = merged;
    setCreds(merged);
    const f = slotFields(merged, id, p);
    setPid(id);
    setModel(p.models[0] || "");
    setApiKey(f.apiKey);
    setBaseUrl(f.baseUrl);
    setCustomModel(p.models.length === 0);
    setShowKey(false);
  }

  // key 只含可见 ASCII：清掉粘贴带进来的空白/非 ASCII 乱码字符(否则网关直接 401)
  const cleanKey = (v: string) => v.replace(/[^\x20-\x7E]/g, "").trim();

  function save() {
    const prevSlot = credsRef.current[pid] || {};
    const slot: CredSlot = {
      // 空则回退到已存的 key，绝不用空把原凭证覆盖掉(防误抹)
      apiKey: cleanKey(apiKey) || prevSlot.apiKey || undefined,
      baseUrl: preset.kind === "openai" ? baseUrl.trim() || preset.baseUrl : undefined,
    };
    const newCreds = { ...credsRef.current, [pid]: slot }; // 存进当前平台的槽(用最新creds,别丢其它槽)
    window.wuwei.setSettings({
      kind: preset.kind,
      providerId: pid,
      model: model || undefined,
      apiKey: slot.apiKey, // 顶层=当前生效平台的凭证
      baseUrl: slot.baseUrl,
      creds: newCreds,
    });
    onClose();
  }

  return (
    <div className="perm-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <h3>模型设置</h3>

        <label className="field">
          <span>模型平台</span>
          <select value={pid} onChange={(e) => changePreset(e.target.value)}>
            {ORDERED_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>模型</span>
          {preset.models.length > 0 && !customModel ? (
            <select
              value={model}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setCustomModel(true);
                  setModel("");
                } else {
                  setModel(e.target.value);
                }
              }}
            >
              {preset.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">自定义 / 其它…</option>
            </select>
          ) : (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="模型名（直接输入）"
            />
          )}
        </label>
        {preset.modelLabels?.[model] && <p className="model-sub">{preset.modelLabels[model]}</p>}

        {preset.keyUrl && (
          <div className="key-guide">
            没有 API Key？
            <a onClick={() => window.wuwei.openExternal(preset.keyUrl)}>
              点此前往 {preset.label} 官网获取 ↗
            </a>
            <span className="key-steps">（登录 → 创建 API Key → 复制粘贴到下方）</span>
          </div>
        )}

        <label className="field">
          <span>API Key</span>
          <div className="key-wrap">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={preset.keyHint}
            />
            <button
              type="button"
              className="eye-btn"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? "隐藏" : "显示"}
            >
              <EyeIcon off={showKey} />
            </button>
          </div>
        </label>

        {!preset.fixedBaseUrl && (
          <label className="field">
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:8000/v1"
            />
          </label>
        )}

        {preset.note && <p className="s-note">{preset.note}</p>}

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
