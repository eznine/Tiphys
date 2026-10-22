/** Client for the TIPHYS agent sidecar (HTTP + SSE on 127.0.0.1:8787). */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DataLayer } from "./dataLayers";

export const AGENT_URL = (import.meta.env.VITE_AGENT_URL as string | undefined)?.replace(/\/$/, "") || "http://127.0.0.1:8787";

export type TimelineItem =
  | { kind: "msg"; id: string; role: "user" | "agent"; text: string }
  | { kind: "tool"; id: string; name: string; status: "running" | "done" | "error"; input?: unknown; summary?: string }
  | { kind: "job"; id: string; label: string; status: string; progress: number; message: string }
  | { kind: "approval"; id: string; toolName: string; input: unknown; state: "pending" | "approved" | "rejected" }
  | { kind: "notice"; id: string; text: string };

export type AgentState = {
  items: TimelineItem[];
  layers: DataLayer[];
  busy: boolean;
  connected: boolean;
  provider: string;
  focus: number[] | null;
};

type Ev = { type: string; [k: string]: any };

function upsert(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const i = items.findIndex((x) => x.kind === item.kind && x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = { ...items[i], ...item } as TimelineItem;
  return next;
}

function summarize(out: any): string {
  if (!out) return "";
  if (out.denied) return "rejected";
  if (out.job_id) return `job ${out.job_id}`;
  if (out.layer) return `${out.layer.name} · ${out.layer.feature_count} features`;
  if (out.layers) return `${out.layers.length} layers`;
  if (out.truncated) return `truncated → ${out.spill_path}`;
  return JSON.stringify(out).slice(0, 60);
}

function lastLive(items: TimelineItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x.kind === "msg" && x.id.startsWith("live-")) return i;
  }
  return -1;
}

export function reduce(s: AgentState, e: Ev): AgentState {
  switch (e.type) {
    case "user":
      return { ...s, busy: true, items: [...s.items, { kind: "msg", id: `u-${e.ts}`, role: "user", text: e.text }] };
    case "text-delta": {
      // Append to the in-flight bubble even if a notice/job card landed in between.
      const i = lastLive(s.items);
      if (i >= 0) {
        const items = s.items.slice();
        const cur = items[i] as Extract<TimelineItem, { kind: "msg" }>;
        items[i] = { ...cur, text: cur.text + e.text };
        return { ...s, items };
      }
      return { ...s, items: [...s.items, { kind: "msg", id: `live-${e.ts}`, role: "agent", text: e.text }] };
    }
    case "assistant-text": {
      const i = lastLive(s.items);
      if (i >= 0) {
        const items = s.items.slice();
        items[i] = { kind: "msg", id: `a-${e.ts}`, role: "agent", text: e.text };
        return { ...s, items };
      }
      return { ...s, items: [...s.items, { kind: "msg", id: `a-${e.ts}`, role: "agent", text: e.text }] };
    }
    case "tool-call":
      return { ...s, items: upsert(s.items, { kind: "tool", id: e.toolCallId, name: e.toolName, status: "running", input: e.input }) };
    case "tool-result":
      return { ...s, items: upsert(s.items, { kind: "tool", id: e.toolCallId, name: e.toolName, status: "done", summary: summarize(e.output) }) };
    case "tool-error":
      return { ...s, items: upsert(s.items, { kind: "tool", id: e.toolCallId, name: e.toolName, status: "error", summary: e.error }) };
    case "approval-request":
      return { ...s, items: upsert(s.items, { kind: "approval", id: e.toolCallId, toolName: e.toolName, input: e.input, state: "pending" }) };
    case "approval-result":
      return { ...s, items: s.items.map((x) => (x.kind === "approval" && x.id === e.toolCallId ? { ...x, state: e.approved ? "approved" : "rejected" } : x)) };
    case "job":
      return {
        ...s,
        items: upsert(s.items, { kind: "job", id: e.jobId, label: e.label ?? e.jobId, status: e.status, progress: e.progress ?? 0, message: e.message ?? "" }),
      };
    case "layer-added": {
      const l = e.layer as DataLayer;
      return { ...s, layers: [...s.layers.filter((x) => x.id !== l.id), { ...l, visible: true }], focus: l.bounds };
    }
    case "layer-removed":
      return { ...s, layers: s.layers.filter((x) => x.id !== e.layerId) };
    case "notice":
      return { ...s, items: [...s.items, { kind: "notice", id: `n-${e.ts}`, text: e.text }] };
    case "compaction":
      return { ...s, items: [...s.items, { kind: "notice", id: `c-${e.ts}`, text: `上下文已压缩 ${e.before}→${e.after} tokens（GIS 状态已保留）` }] };
    case "error":
      return { ...s, items: [...s.items, { kind: "notice", id: `e-${e.ts}`, text: `错误：${e.error}` }] };
    case "turn-end":
      return { ...s, busy: false };
    default:
      return s;
  }
}

export function useAgent(session = "default") {
  const [state, setState] = useState<AgentState>({ items: [], layers: [], busy: false, connected: false, provider: "?", focus: null });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await (await fetch(`${AGENT_URL}/health`)).json();
        const hist = await (await fetch(`${AGENT_URL}/history?session=${session}`)).json();
        if (cancelled) return;
        setState((s) => {
          let st: AgentState = { ...s, provider: `${h.provider}:${h.model}`, connected: true };
          for (const e of hist.events as Ev[]) st = reduce(st, e);
          // replayed approvals/jobs without live state are stale
          return { ...st, busy: false, items: st.items.map((x) => (x.kind === "approval" && x.state === "pending" ? { ...x, state: "rejected" } : x)) };
        });
      } catch {
        setState((s) => ({ ...s, connected: false }));
      }
      const es = new EventSource(`${AGENT_URL}/events?session=${session}`);
      es.onopen = () => setState((s) => ({ ...s, connected: true }));
      es.onerror = () => setState((s) => ({ ...s, connected: false }));
      es.onmessage = (m) => setState((s) => reduce(s, JSON.parse(m.data)));
      esRef.current = es;
    })();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [session]);

  const post = (path: string, body: unknown) =>
    fetch(`${AGENT_URL}${path}?session=${session}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  return {
    state,
    send: useCallback((text: string) => void post("/chat", { text }), [session]),
    approve: useCallback((toolCallId: string, approved: boolean) => void post("/approve", { toolCallId, approved }), [session]),
    cancelJob: useCallback((jobId: string) => void post("/jobs/cancel", { jobId }), [session]),
    toggleLayer: useCallback(
      (id: string) => setState((s) => ({ ...s, layers: s.layers.map((l) => (l.id === id ? { ...l, visible: l.visible === false } : l)) })),
      [],
    ),
  };
}
