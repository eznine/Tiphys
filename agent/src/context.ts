/**
 * Context management skeleton.
 * - spill: oversized tool output -> file (idea from deepseek-harness `spill` / compaction-tool-result-pruner).
 * - compaction at 80% (DEFAULT_THRESHOLD_RATIO=0.8, retain ~16% from deepseek-harness packages/compaction; 0.8 also Goose).
 * - handoff prompt text adapted from openai/codex codex-rs/prompts/templates/compact (Apache-2.0).
 * - GIS workspace snapshot + file memory (AGENTS.md-style project file, Codex/Cline pattern).
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { TIPHYS_DIR, USER_DIR } from "./config.js";

export const COMPACT_THRESHOLD_RATIO = 0.8;
export const COMPACT_RETAIN_RATIO = 0.16;

// Adapted from openai/codex (Apache-2.0) codex-rs/prompts/templates/compact/prompt.md
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
- (TIPHYS) GIS workspace state VERBATIM: layers (id/name/CRS), AOI, output paths, pending job ids (incl. GEE tasks)
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

// Adapted from codex summary_prefix.md
export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its work. Build on it and avoid duplicating work. Summary:\n";

export type Workspace = {
  layers: Array<{ id: string; name: string; crs: string; feature_count: number; geometry_types: string[]; bounds: number[] | null; url: string; path?: string }>;
  aoi: number[] | null;
  outputs: string[];
  pendingJobs: string[];
  crs: string;
};

export function emptyWorkspace(): Workspace {
  return { layers: [], aoi: null, outputs: [], pendingJobs: [], crs: "EPSG:4326" };
}

export function workspaceSnapshot(ws: Workspace): string {
  return JSON.stringify(
    {
      crs_display: ws.crs,
      aoi_bbox: ws.aoi,
      layers: ws.layers.map((l) => ({ id: l.id, name: l.name, crs: l.crs, n: l.feature_count, geom: l.geometry_types, bbox: l.bounds })),
      output_paths: ws.outputs,
      pending_job_ids: ws.pendingJobs,
    },
    null,
    0,
  );
}

export function loadMemory(): string {
  const parts: string[] = [];
  for (const [label, p] of [
    ["user memory (~/.tiphys/memory.md)", path.join(USER_DIR, "memory.md")],
    ["project memory (.tiphys/MEMORY.md)", path.join(TIPHYS_DIR, "MEMORY.md")],
  ] as const) {
    try {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) parts.push(`## ${label}\n${t}`);
    } catch {
      /* none */
    }
  }
  return parts.join("\n\n");
}

/** Truncate oversized tool output; full payload spilled to .tiphys/spill/<id>.json */
export function spillIfLarge(callId: string, output: unknown, maxChars: number): unknown {
  const s = JSON.stringify(output);
  if (s.length <= maxChars) return output;
  const dir = path.join(TIPHYS_DIR, "spill");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${callId}.json`);
  fs.writeFileSync(p, s);
  return { truncated: true, original_chars: s.length, spill_path: p, preview: s.slice(0, Math.floor(maxChars * 0.8)) };
}

export function estimateTokens(msgs: ModelMessage[], system = ""): number {
  return Math.ceil((JSON.stringify(msgs).length + system.length) / 4);
}

/**
 * Placeholder compaction: deterministic summary (no LLM call yet) that FORCIBLY
 * preserves GIS workspace state. Keeps the most recent ~16% of messages, cut at a user turn
 * so tool-call/result pairs are never split.
 */
export function maybeCompact(
  msgs: ModelMessage[],
  system: string,
  contextWindow: number,
  ws: Workspace,
): { messages: ModelMessage[]; compacted: boolean; summary?: string; before: number; after: number } {
  const before = estimateTokens(msgs, system);
  if (before < contextWindow * COMPACT_THRESHOLD_RATIO || msgs.length < 4) return { messages: msgs, compacted: false, before, after: before };
  let keepFrom = Math.floor(msgs.length * (1 - COMPACT_RETAIN_RATIO));
  while (keepFrom < msgs.length && msgs[keepFrom].role !== "user") keepFrom++;
  if (keepFrom >= msgs.length) keepFrom = msgs.findLastIndex((m) => m.role === "user");
  const old = msgs.slice(0, Math.max(keepFrom, 0));
  const userAsks = old
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 200));
  const summary = [
    "# Handoff summary (placeholder compaction, deterministic)",
    "## Earlier user requests",
    ...userAsks.map((u) => `- ${u}`),
    "## GIS workspace state (preserved verbatim)",
    workspaceSnapshot(ws),
    "## Next steps",
    "- Continue from the latest user message; check pending_job_ids with job_status.",
  ].join("\n");
  const messages: ModelMessage[] = [{ role: "user", content: SUMMARY_PREFIX + summary }, { role: "assistant", content: "OK, resuming with this state." }, ...msgs.slice(keepFrom)];
  return { messages, compacted: true, summary, before, after: estimateTokens(messages, system) };
}
