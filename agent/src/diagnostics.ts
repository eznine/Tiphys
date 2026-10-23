import type { AgentEvent } from "./session.js";

export function redact(value: unknown, secrets: string[] = []): any {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
    return text.replace(/Bearer\s+[^\s"']+|\bsk-[A-Za-z0-9_-]+/gi, "[REDACTED]").slice(0, 24000);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /api.?key|authorization|token|password|secret/i.test(key) ? "[REDACTED]" : redact(item, secrets)]));
  return value;
}

export function eventLogEntries(events: AgentEvent[]) {
  const skip = new Set(["text-delta", "assistant-text"]);
  return events.filter(e => !skip.has(e.type)).slice(-500).map(e => ({
    id: `agent-${e.seq}`, ts: e.ts, source: "Agent", kind: e.type,
    level: e.type === "error" || e.type === "tool-error" || (e.type === "job" && e.status === "failed") ? "error"
      : e.type.includes("approval") || e.interrupted || e.status === "cancelled" ? "warn" : "info",
    summary: String(e.toolName ?? e.error ?? e.text ?? (e.command as any)?.action ?? e.label ?? e.type).slice(0, 200),
    detail: e,
  }));
}
