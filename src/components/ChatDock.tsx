import { FormEvent, useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../lib/agent";
import type { DataLayer } from "../lib/dataLayers";
import type { WorkspaceRecovery } from "../lib/workspace";
import { ToolPanel } from "./ToolPanel";
import { ChatTimeline, SUGGESTIONS } from "./ChatTimeline";
import { Settings2, FolderPlus, ArrowUp, Square, Layers } from "lucide-react";

type Props = {
  items: TimelineItem[];
  busy: boolean;
  connected: boolean;
  provider: string;
  layers: DataLayer[];
  recovery?: WorkspaceRecovery | null;
  onSend: (text: string) => Promise<boolean>;
  onApprove: (toolCallId: string, ok: boolean) => void;
  onCancelJob: (jobId: string) => void;
  onCancelTurn: () => void;
  onToolResult: (result: Record<string, any>) => void;
  selectedLayer?: DataLayer;
  request?: { id: number; tool?: string; tab: "chat" | "tools"; search?: string };
  onOpenTool: (tool: string) => void;
  onAdd: () => void; onSettings: () => void;
};

export function ChatDock({ items, busy, connected, provider, layers, recovery, onSend, onApprove, onCancelJob, onCancelTurn, onToolResult, selectedLayer, request, onOpenTool, onAdd, onSettings }: Props) {
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "tools">("chat");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const unconfigured = provider.startsWith("unconfigured");
  const modelName = provider.includes(":") ? provider.slice(provider.indexOf(":") + 1) : provider;
  useEffect(() => { if (request) { setTab(request.tab); if (request.tab === "chat") requestAnimationFrame(() => inputRef.current?.focus()); } }, [request]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || !connected) return;
    if (await onSend(text)) setDraft("");
  }

  function insertPrompt(prompt: string) {
    setDraft(prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <aside className="chat-dock" aria-label="Agent chat">
      <div className="chat-dock-header">
        <div className="agent-pane-title"><span className="chat-brand"><img className="chat-dock-logo" src="/logo-temp.png" alt="" aria-hidden="true" /><strong>TIPHYS 对话</strong></span><button type="button" className="plain-icon" aria-label="Agent 设置" title="模型与 API 设置" onClick={onSettings}><Settings2 size={16} /></button></div>
        <div className="dock-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
            对话
          </button>
          <button type="button" role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>
            工具箱
          </button>
        </div>
        <p>
          <span className="status-dot" data-state={connected && !unconfigured ? "ok" : "error"} /> {connected ? unconfigured ? "尚未配置 API" : `${provider.startsWith("mock") ? "模拟测试 · " : ""}${modelName}` : "Agent 连接中断，正在重连…"}
        </p>
      </div>
      <div className="tool-tab" hidden={tab !== "tools"}>
        <ToolPanel layers={layers} onResult={onToolResult} request={request?.tab === "tools" ? request : undefined} selectedLayer={selectedLayer} />
      </div>
      {tab === "chat" && (
        <>
      <ChatTimeline items={items} layers={layers} recovery={recovery} busy={busy}
        onOpenTool={onOpenTool} onInsertPrompt={insertPrompt}
        onApprove={onApprove} onCancelJob={onCancelJob} />
      <div className="chat-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chat-chip" disabled={busy || !connected} onClick={() => void onSend(s)}>
            {s}
          </button>
        ))}
      </div>
      {unconfigured && <button type="button" className="api-setup-notice" onClick={onSettings}>配置 API，开始与 Agent 对话 →</button>}
      <div className="composer-wrap">
      {selectedLayer && <div className="composer-context"><Layers size={12} /><span title={selectedLayer.name}>{selectedLayer.name}</span><small>当前图层</small></div>}
      <form className="chat-composer" onSubmit={submit}>
        <textarea ref={inputRef} autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="描述你的目标，例如：给这些点做 500 米缓冲，并按类别着色…" aria-label="对话消息"
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-toolbar"><button type="button" className="plain-icon" aria-label="对话中添加数据" title="添加数据" onClick={onAdd}><FolderPlus size={19} /></button><span>Enter 发送 · Shift+Enter 换行</span>
        {busy ? <button type="button" className="composer-send" aria-label="停止回复" onClick={onCancelTurn}><Square size={14} /></button> : <button type="submit" className="composer-send" aria-label="发送消息" disabled={!draft.trim() || !connected || unconfigured}><ArrowUp size={20} /></button>}</div>
      </form></div>
      <div className="agent-pane-footer"><span className="status-dot" data-state={connected ? "ok" : "error"} /><span>{busy ? "正在处理任务" : "直接对话，或使用工具箱"}</span><span>本地工作区</span></div>
        </>
      )}
    </aside>
  );
}
