import { FormEvent, useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../lib/agent";
import type { DataLayer } from "../lib/dataLayers";
import { ToolPanel } from "./ToolPanel";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Settings2, FolderPlus, ArrowUp, Square, Layers } from "lucide-react";

type Props = {
  items: TimelineItem[];
  busy: boolean;
  connected: boolean;
  provider: string;
  layers: DataLayer[];
  onSend: (text: string) => Promise<boolean>;
  onApprove: (toolCallId: string, ok: boolean) => void;
  onCancelJob: (jobId: string) => void;
  onCancelTurn: () => void;
  onToolResult: (result: Record<string, any>) => void;
  selectedLayer?: DataLayer;
  request?: { id: number; tool?: string; tab: "chat" | "tools" };
  onAdd: () => void; onSettings: () => void;
};

const SUGGESTIONS = ["加载样例点，做 500 米缓冲", "查看当前图层信息"];

export function ChatDock({ items, busy, connected, provider, layers, onSend, onApprove, onCancelJob, onCancelTurn, onToolResult, selectedLayer, request, onAdd, onSettings }: Props) {
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "tools">("chat");
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const unconfigured = provider.startsWith("unconfigured");
  const modelName = provider.includes(":") ? provider.slice(provider.indexOf(":") + 1) : provider;
  useEffect(() => { if (request) { setTab(request.tab); if (request.tab === "chat") requestAnimationFrame(() => inputRef.current?.focus()); } }, [request]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items, tab]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || !connected) return;
    if (await onSend(text)) setDraft("");
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
      <div className="chat-messages">
        {!items.length && <div className="agent-welcome"><span className="agent-welcome-mark">✦</span><h2>直接说你要做什么</h2><p>{layers.length ? "数据已就绪。描述你的目标，我来选择工具、执行分析，并将结果显示在地图上。" : "先添加数据，或让我加载样例。然后描述你的分析目标。"}</p><p className="tool-desc">右键图层可查看属性表、调整符号与标注。</p></div>}
        {items.map((it) => {
          if (it.kind === "msg")
            return (
              <div key={it.id} className="chat-bubble" data-role={it.role}>
                <span className="meta">{it.role === "agent" ? "TIPHYS" : "你"}</span>
                {it.role === "agent" ? <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]}>{it.text}</Markdown></div> : it.text}
              </div>
            );
          if (it.kind === "tool")
            return (
              <div key={`tool:${it.id}`} className="tool-chip" data-status={it.status}>
                <span className="tool-dot" /> <code>{it.name}</code>
                <span className="tool-sum">{it.status === "running" ? "执行中…" : it.summary}</span>
              </div>
            );
          if (it.kind === "job") {
            const active = it.status === "running" || it.status === "queued";
            return (
              <div key={it.id} className="job-card" data-status={it.status}>
                <div className="job-head">
                  <strong>{it.label}</strong>
                  <span>{{ running: "运行中", queued: "排队中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", cancelling: "正在取消", unreachable: "连接中断" }[it.status] ?? it.status} · {Math.round(it.progress * 100)}%</span>
                </div>
                <div className="route-progress job-route">
                  <span style={{ ["--progress" as string]: `${Math.round(it.progress * 100)}%` }} />
                </div>
                <div className="job-foot">
                  <span>{it.message}</span>
                  {active && (
                    <button type="button" className="icon-btn" onClick={() => onCancelJob(it.id)}>
                      取消
                    </button>
                  )}
                </div>
              </div>
            );
          }
          if (it.kind === "approval")
            return (
              <div key={`approval:${it.id}`} className="approval-card" data-state={it.state}>
                <div>
                  ⚠ 需要确认破坏性操作 <code>{it.toolName}</code> {JSON.stringify(it.input)}
                </div>
                {it.state === "pending" ? (
                  <div className="approval-actions">
                    <button type="button" className="primary-btn" onClick={() => onApprove(it.id, true)}>
                      允许
                    </button>
                    <button type="button" className="icon-btn" onClick={() => onApprove(it.id, false)}>
                      拒绝
                    </button>
                  </div>
                ) : (
                  <div className="meta">{it.state === "approved" ? "已允许" : it.state === "expired" ? "审批已失效" : "已拒绝"}</div>
                )}
              </div>
            );
          return (
            <div key={it.id} className="chat-notice">
              {it.text}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
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
