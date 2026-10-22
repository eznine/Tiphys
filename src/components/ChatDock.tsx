import { FormEvent, useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../lib/agent";

type Props = {
  items: TimelineItem[];
  busy: boolean;
  connected: boolean;
  provider: string;
  onSend: (text: string) => void;
  onApprove: (toolCallId: string, ok: boolean) => void;
  onCancelJob: (jobId: string) => void;
};

const SUGGESTIONS = ["给 samples 里的点做 500 米缓冲", "列出图层", "删除最后一个图层"];

export function ChatDock({ items, busy, connected, provider, onSend, onApprove, onCancelJob }: Props) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  }

  return (
    <aside className="chat-dock" aria-label="Agent chat">
      <div className="chat-dock-header">
        <h2>Agent</h2>
        <p>
          <span className="status-dot" data-state={connected ? "ok" : "error"} /> {connected ? provider : "agent sidecar offline (npm run agent)"}
        </p>
      </div>
      <div className="chat-messages">
        {items.map((it) => {
          if (it.kind === "msg")
            return (
              <div key={it.id} className="chat-bubble" data-role={it.role}>
                <span className="meta">{it.role === "agent" ? "TIPHYS" : "You"}</span>
                {it.text}
              </div>
            );
          if (it.kind === "tool")
            return (
              <div key={it.id} className="tool-chip" data-status={it.status}>
                <span className="tool-dot" /> <code>{it.name}</code>
                <span className="tool-sum">{it.status === "running" ? "running…" : it.summary}</span>
              </div>
            );
          if (it.kind === "job") {
            const active = it.status === "running" || it.status === "queued";
            return (
              <div key={it.id} className="job-card" data-status={it.status}>
                <div className="job-head">
                  <strong>{it.label}</strong>
                  <span>{it.status} · {Math.round(it.progress * 100)}%</span>
                </div>
                <div className="route-progress job-route">
                  <span style={{ ["--progress" as string]: `${Math.round(it.progress * 100)}%` }} />
                </div>
                <div className="job-foot">
                  <span>{it.message}</span>
                  {active && (
                    <button type="button" className="icon-btn" onClick={() => onCancelJob(it.id)}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            );
          }
          if (it.kind === "approval")
            return (
              <div key={it.id} className="approval-card" data-state={it.state}>
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
                  <div className="meta">{it.state === "approved" ? "已允许" : "已拒绝"}</div>
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
          <button key={s} type="button" className="chat-chip" disabled={busy} onClick={() => onSend(s)}>
            {s}
          </button>
        ))}
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="描述 GIS 任务…" aria-label="Message" />
        <button type="submit" className="primary-btn" disabled={!draft.trim() || busy}>
          {busy ? "…" : "Send"}
        </button>
      </form>
    </aside>
  );
}
