/**
 * Context management: retrievable output pages and model-written handoff summaries.
 * - spill: oversized tool output -> file (idea from deepseek-harness `spill` / compaction-tool-result-pruner).
 * - compaction at 80% (DEFAULT_THRESHOLD_RATIO=0.8, retain ~16% from deepseek-harness packages/compaction; 0.8 also Goose).
 * - handoff prompt text adapted from openai/codex codex-rs/prompts/templates/compact (Apache-2.0).
 * - GIS workspace snapshot + file memory (AGENTS.md-style project file, Codex/Cline pattern).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  const spillId = createHash("sha256").update(callId).digest("hex").slice(0, 32);
  const p = path.join(dir, `${spillId}.json`);
  fs.writeFileSync(p, s);
  return { truncated: true, original_chars: s.length, spill_id: spillId, preview: s.slice(0, Math.floor(maxChars * 0.8)), read_with: "read_tool_output" };
}

export function readToolOutput(spillId: string, offset = 0, length = 4000) {
  if (!/^[a-f0-9]{32}$/.test(spillId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 6000)
    throw new Error("Invalid output page; length must be 1..6000");
  const text = fs.readFileSync(path.join(TIPHYS_DIR, "spill", `${spillId}.json`), "utf8");
  return { text: text.slice(offset, offset + length), offset, total_chars: text.length,
    next_offset: offset + length < text.length ? offset + length : null };
}

export function estimateTokens(msgs: ModelMessage[], system = ""): number {
  const text = JSON.stringify(msgs) + system;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii);
}

/**
 * Preserve GIS state and archive the full earlier transcript before summarizing.
 * Cut at a user turn so tool-call/result pairs are never split. Mock mode keeps a trace.
 */
export async function maybeCompact(
  msgs: ModelMessage[],
  system: string,
  contextWindow: number,
  ws: Workspace,
  summarize?: (messages: ModelMessage[]) => Promise<string>,
): Promise<{ messages: ModelMessage[]; compacted: boolean; summary?: string; before: number; after: number }> {
  const before = estimateTokens(msgs, system);
  if (before < contextWindow * COMPACT_THRESHOLD_RATIO) return { messages: msgs, compacted: false, before, after: before };
  if (msgs.length < 4) throw new Error("Current request and tool schemas exceed the context budget; shorten the request or configure the correct model context window");
  let keepFrom = Math.floor(msgs.length * (1 - COMPACT_RETAIN_RATIO));
  while (keepFrom < msgs.length && msgs[keepFrom].role !== "user") keepFrom++;
  if (keepFrom >= msgs.length) keepFrom = msgs.findLastIndex((m) => m.role === "user");
  const old = msgs.slice(0, Math.max(keepFrom, 0));
  const archiveId = randomUUID().replaceAll("-", "");
  const dir = path.join(TIPHYS_DIR, "spill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${archiveId}.json`), JSON.stringify(old));
  // Real models summarize all roles, including tool results and decisions. Mock mode uses a trace.
  const handoff = summarize ? await summarize(old) : old.map(m => `${m.role}: ${JSON.stringify(m.content).slice(0, 1200)}`).join("\n");
  if (!handoff.trim()) throw new Error("Context summary was empty; conversation was preserved and not compacted");
  const summary = [
    "# Handoff summary",
    handoff,
    `## Complete earlier transcript\nUse read_tool_output with spill_id=${archiveId} to retrieve details; offsets are character positions.`,
    "## GIS workspace state (preserved verbatim)",
    workspaceSnapshot(ws),
    "## Next steps",
    "- Continue from the latest user message; check pending_job_ids with job_status.",
  ].join("\n");
  const messages: ModelMessage[] = [{ role: "user", content: SUMMARY_PREFIX + summary }, { role: "assistant", content: "OK, resuming with this state." }, ...msgs.slice(keepFrom)];
  if (estimateTokens(messages, system) >= contextWindow * COMPACT_THRESHOLD_RATIO)
    throw new Error("Context still exceeds its budget after summarizing; shorten the latest request or increase the configured model context window");
  return { messages, compacted: true, summary, before, after: estimateTokens(messages, system) };
}
