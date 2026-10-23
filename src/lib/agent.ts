/** Client for the TIPHYS agent sidecar (HTTP + SSE on 127.0.0.1:8972). */
import { useCallback, useEffect, useState } from "react";
import type { DataLayer } from "./dataLayers";
import { AGENT_URL, agentRequest, bootstrap, readEvents } from "./service";

export type TimelineItem =
  | { kind: "msg"; id: string; role: "user" | "agent"; text: string }
  | { kind: "tool"; id: string; name: string; status: "running" | "done" | "error" | "rejected"; input?: unknown; summary?: string }
  | { kind: "job"; id: string; label: string; status: string; progress: number; message: string }
  | { kind: "approval"; id: string; toolName: string; input: unknown; state: "pending" | "approved" | "rejected" | "expired" }
  | { kind: "notice"; id: string; text: string };

export type AgentState = {
  items: TimelineItem[];
  layers: DataLayer[];
  busy: boolean;
  connected: boolean;
  provider: string;
  focus: number[] | null;
  cursor?: number;
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
  if (e.type === "snapshot") {
    let st: AgentState = e.reset ? { ...s, items: [], layers: [], cursor: 0, focus: null } : s;
    for (const event of e.events) st = reduce(st, event);
    return { ...st, cursor: e.cursor, busy: e.busy, layers: (e.workspace.layers as DataLayer[]).map(l => ({ ...l,
      visible: s.layers.find(old => old.id === l.id)?.visible ?? true })),
      items: st.items.map(item => item.kind === "approval" && item.state === "pending" && !e.pendingApprovals.includes(item.id)
        ? { ...item, state: "expired" } : item) };
  }
  if (e.seq && e.seq <= (s.cursor ?? 0)) return s;
  if (e.seq) s = { ...s, cursor: e.seq };
  const eventId = e.seq ?? e.ts ?? Date.now();
  switch (e.type) {
    case "user":
      return { ...s, busy: true, items: [...s.items, { kind: "msg", id: `u-${eventId}`, role: "user", text: e.text }] };
    case "text-delta": {
      // Append to the in-flight bubble even if a notice/job card landed in between.
      const i = lastLive(s.items);
      if (i >= 0) {
        const items = s.items.slice();
        const cur = items[i] as Extract<TimelineItem, { kind: "msg" }>;
        items[i] = { ...cur, text: cur.text + e.text };
        return { ...s, items };
      }
      return { ...s, items: [...s.items, { kind: "msg", id: `live-${eventId}`, role: "agent", text: e.text }] };
    }
    case "assistant-text": {
      const i = lastLive(s.items);
      if (i >= 0) {
        const items = s.items.slice();
        items[i] = { kind: "msg", id: `a-${eventId}`, role: "agent", text: e.text };
        return { ...s, items };
      }
      return { ...s, items: [...s.items, { kind: "msg", id: `a-${eventId}`, role: "agent", text: e.text }] };
    }
    case "tool-call":
      return { ...s, items: upsert(s.items, { kind: "tool", id: e.toolCallId, name: e.toolName, status: "running", input: e.input }) };
    case "tool-result":
      return { ...s, items: upsert(s.items, { kind: "tool", id: e.toolCallId, name: e.toolName, status: e.output?.denied ? "rejected" : "done", summary: summarize(e.output) }) };
    case "tool-error":
      return { ...s, items: upsert(s.items, { kind: "tool", id: e.toolCallId, name: e.toolName, status: "error", summary: e.error }) };
    case "approval-request":
      return { ...s, items: upsert(s.items, { kind: "approval", id: e.toolCallId, toolName: e.toolName, input: e.input, state: "pending" }) };
    case "approval-result":
      return { ...s, items: s.items.map((x) => (x.kind === "approval" && x.id === e.toolCallId ? { ...x, state: e.approved ? "approved" : "rejected" } : x)) };
    case "approval-expired":
      return { ...s, items: s.items.map(x => x.kind === "approval" && x.id === e.toolCallId ? { ...x, state: "expired" } : x) };
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
      return { ...s, items: [...s.items, { kind: "notice", id: `n-${eventId}`, text: e.text }] };
    case "compaction":
      return { ...s, items: [...s.items, { kind: "notice", id: `c-${eventId}`, text: `上下文已压缩 ${e.before}→${e.after} tokens（GIS 状态已保留）` }] };
    case "error":
      return { ...s, items: [...s.items, { kind: "notice", id: `e-${eventId}`, text: `错误：${e.error}` }] };
    case "turn-end":
      return { ...s, busy: false, items: s.items.map(item => {
        if (item.kind === "msg" && item.id.startsWith("live-")) return { ...item, id: `a-${item.id}` };
        return item.kind === "tool" && item.status === "running"
          ? { ...item, status: "error", summary: "执行已中断，请检查工作区" } : item;
      }) };
    default:
      return s;
  }
}

export function useAgent(session = "default") {
  const [state, setState] = useState<AgentState>({ items: [], layers: [], busy: false, connected: false, provider: "?", focus: null });
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    setState(s => ({ ...s, items: [], layers: [], busy: false, connected: false, cursor: 0 }));
    (async () => {
      while (!controller.signal.aborted) {
        try {
          await bootstrap(controller.signal);
          const h = await (await fetch(`${AGENT_URL}/health`, { signal: controller.signal })).json();
          const response = await agentRequest(`/events?session=${encodeURIComponent(session)}&after=${cursor}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setState(s => ({ ...s, connected: true, provider: `${h.provider}:${h.model}` }));
          await readEvents(response, event => {
            if (controller.signal.aborted) return;
            cursor = event.cursor ?? event.seq ?? cursor;
            setState(s => reduce(s, event));
          });
        } catch { /* Reconcile from the server cursor on the next connection. */ }
        if (controller.signal.aborted) return;
        setState(s => ({ ...s, connected: false }));
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, 1500);
          function done() { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    })();
    return () => controller.abort();
  }, [session]);

  const post = useCallback(async (path: string, body: unknown) => {
    try {
      await agentRequest(`${path}?session=${encodeURIComponent(session)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return true;
    } catch (err) {
      setState(s => reduce(s, { type: "error", ts: Date.now(), error: String(err) }));
      return false;
    }
  }, [session]);

  return {
    state,
    send: useCallback((text: string) => post("/chat", { text }), [post]),
    approve: useCallback((toolCallId: string, approved: boolean) => { void post("/approve", { toolCallId, approved }); }, [post]),
    cancelJob: useCallback((jobId: string) => { void post("/jobs/cancel", { jobId }); }, [post]),
    cancelTurn: useCallback(() => { void post("/turn/cancel", {}); }, [post]),
    toggleLayer: useCallback(
      (id: string) => setState((s) => ({ ...s, layers: s.layers.map((l) => (l.id === id ? { ...l, visible: l.visible === false } : l)) })),
      [],
    ),
  };
}
