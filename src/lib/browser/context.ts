/**
 * Lightweight browser context management, adapted from the desktop Agent's
 * context.ts and the same Goose/deepseek-harness ratios:
 * 80% compaction trigger, retain ~16%, old tool output spills to IndexedDB.
 */
import type { ModelMessage } from "ai";
import { readRecord, writeRecord } from "./storage";

export const BROWSER_COMPACT_THRESHOLD_RATIO = 0.8;
export const BROWSER_COMPACT_RETAIN_RATIO = 0.16;
export const BROWSER_TRIM_THRESHOLD_RATIO = 0.65;

export type BrowserWorkspace = {
  layers: Array<Record<string, unknown>>;
  aoi?: number[] | null;
  aoi_bbox?: number[] | null;
  selectedLayerId?: string | null;
  selectedLayerName?: string | null;
  selection?: { layerId: string; featureIds: number[] } | null;
  outputs?: string[];
  pendingJobs?: string[];
};

const HANDOFF_SELECTION_LIMIT = 120;

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "value" in output && typeof output.value === "string") return output.value;
  try { return JSON.stringify(output ?? ""); } catch { return ""; }
}

function preview(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function textContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map(part => part.type === "text" ? part.text : "").join(" ");
}

function recentToolNames(messages: ModelMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === "tool-result") names.push(part.toolName);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type: string; toolName?: string }>) {
        if (part.type === "tool-call" && part.toolName) names.push(part.toolName);
      }
    }
  }
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let index = names.length - 1; index >= 0 && recent.length < 10; index--) {
    if (seen.has(names[index])) continue;
    seen.add(names[index]);
    recent.push(names[index]);
  }
  return recent.reverse();
}

/** Read a trimmed tool result or a compacted-message archive for this session. */
export async function readBrowserContextRecord(sessionId: string, id: string, offset = 0, length = 4000) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("记录 ID 无效。");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 6000)
    throw new Error("读取范围无效；length 必须为 1..6000。");
  const spill = await readRecord<{ toolName?: string; output?: string }>(`session:${sessionId}:spill:${id}`);
  const archive = spill ? undefined : await readRecord<{ messages?: ModelMessage[] }>(`session:${sessionId}:archive:${id}`);
  if (!spill && !archive) throw new Error("找不到该会话记录。");
  const text = spill ? String(spill.output ?? "") : JSON.stringify(archive!.messages ?? []);
  return {
    kind: spill ? "tool-output" : "message-archive",
    tool_name: spill?.toolName,
    text: text.slice(offset, offset + length),
    offset,
    total_chars: text.length,
    next_offset: offset + length < text.length ? offset + length : null,
  };
}

export function estimateBrowserTokens(messages: ModelMessage[], system = ""): number {
  const text = JSON.stringify(messages) + system;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii);
}

function lastUserIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return messages.length;
}

async function trimOldToolResults(messages: ModelMessage[], sessionId: string, maxChars: number): Promise<ModelMessage[]> {
  const cutoff = lastUserIndex(messages);
  let changed = false;
  const next = [...messages];
  for (let index = 0; index < cutoff; index++) {
    const message = messages[index];
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    const content = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") { content.push(part); continue; }
      const full = outputText(part.output);
      if (full.length <= maxChars) { content.push(part); continue; }
      changed = true;
      const spillId = crypto.randomUUID().replace(/-/g, "");
      await writeRecord(`session:${sessionId}:spill:${spillId}`, { toolName: part.toolName, output: full });
      content.push({
        ...part,
        output: {
          type: "text" as const,
          value: JSON.stringify({
            truncated: true,
            original_chars: full.length,
            spill_id: spillId,
            preview: preview(full),
          }),
        },
      });
    }
    next[index] = { ...message, content } as ModelMessage;
  }
  return changed ? next : messages;
}

function buildHandoff(old: ModelMessage[], archiveId: string, workspace: BrowserWorkspace, maxChars: number): string {
  const toolLines: string[] = [];
  const decisions: string[] = [];
  for (const message of old) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const text = outputText(part.output);
        if (text) toolLines.push(`- ${part.toolName}: ${preview(text, Math.min(maxChars, 360))}`);
      }
    } else if (message.role === "assistant") {
      const text = textContent(message.content);
      if (text.trim()) decisions.push(`- ${preview(text, 280)}`);
    }
  }
  const layers = workspace.layers.map(layer => ({
    id: layer.id, name: layer.name, kind: layer.kind, crs: layer.crs, n: layer.feature_count, geometry: layer.geometry_types, bbox: layer.bounds,
  }));
  const aoi = workspace.aoi_bbox ?? workspace.aoi ?? null;
  const selection = workspace.selection?.layerId && workspace.selection.featureIds?.length
    ? {
        layer_id: workspace.selection.layerId,
        layer_name: layers.find(layer => layer.id === workspace.selection?.layerId)?.name ?? null,
        count: workspace.selection.featureIds.length,
        feature_ids: workspace.selection.featureIds.slice(0, HANDOFF_SELECTION_LIMIT),
        truncated: workspace.selection.featureIds.length > HANDOFF_SELECTION_LIMIT,
      }
    : null;
  const toolNames = recentToolNames(old);
  const layerLines = layers.slice(0, 40).map(layer => {
    const geometry = Array.isArray(layer.geometry) && layer.geometry.length ? ` · ${layer.geometry.join("/")}` : "";
    return `- ${String(layer.name ?? layer.id)} (${String(layer.id)}): ${String(layer.kind ?? "vector")}, ${String(layer.n ?? "?")} features${layer.crs ? `, ${String(layer.crs)}` : ""}${geometry}`;
  });
  if (layers.length > layerLines.length) layerLines.push(`- …另有 ${layers.length - layerLines.length} 个图层，完整元数据见下方 JSON。`);
  return [
    "# Browser Agent handoff",
    "Continue from the latest user message. Do not repeat completed analysis.",
    "## GIS context (authoritative current workspace)",
    `- AOI bbox (WGS84): ${aoi ? aoi.join(",") : "not set"}`,
    `- Selected layer: ${workspace.selectedLayerId ? `${workspace.selectedLayerName ?? workspace.selectedLayerId} (${workspace.selectedLayerId})` : "none"}`,
    `- Selected features: ${selection ? `${selection.count} in ${selection.layer_name ?? selection.layer_id} (${selection.layer_id}); feature_ids listed up to ${HANDOFF_SELECTION_LIMIT}` : "none"}`,
    `- Layers (${layers.length}):`,
    ...(layerLines.length ? layerLines : ["- None."]),
    "## Recent tool names",
    ...(toolNames.length ? [`- ${toolNames.join(", ")}`] : ["- None recorded."]),
    "## Recent decisions",
    ...(decisions.slice(-8).length ? decisions.slice(-8) : ["- None recorded."]),
    "## Earlier tool results (summarized)",
    ...(toolLines.slice(-12).length ? toolLines.slice(-12) : ["- None recorded."]),
    `## Archive\nUse read_browser_output with id=${archiveId} to retrieve the full earlier transcript.`,
    "## GIS workspace state (preserved verbatim)",
    JSON.stringify({
      layers,
      aoi_bbox: aoi,
      selected_layer: workspace.selectedLayerId ? { id: workspace.selectedLayerId, name: workspace.selectedLayerName ?? null } : null,
      selected_features: selection,
      output_paths: workspace.outputs ?? [],
      pending_job_ids: workspace.pendingJobs ?? [],
    }),
    "## Next steps",
    "- Treat the GIS context above as current state; inspect a layer with describe_layer if its schema is uncertain.",
    "- Continue the latest request without re-running tool calls that already produced retained layers.",
  ].join("\n");
}

/**
 * Trim oversized older tool results first, then drop the oldest turns with a
 * retrievable handoff if the conversation is still near the context limit.
 */
export async function compactBrowserMessages(
  messages: ModelMessage[],
  system: string,
  contextWindow: number,
  workspace: BrowserWorkspace,
  sessionId: string,
  maxToolOutputChars = 6000,
): Promise<{ messages: ModelMessage[]; compacted: boolean; trimmed: boolean; before: number; after: number; summary?: string }> {
  const before = estimateBrowserTokens(messages, system);
  if (before < contextWindow * BROWSER_TRIM_THRESHOLD_RATIO) {
    return { messages, compacted: false, trimmed: false, before, after: before };
  }
  const trimmedMessages = await trimOldToolResults(messages, sessionId, maxToolOutputChars);
  const trimmedTokens = estimateBrowserTokens(trimmedMessages, system);
  const trimmed = trimmedMessages !== messages;
  if (trimmedTokens < contextWindow * BROWSER_COMPACT_THRESHOLD_RATIO) {
    return { messages: trimmedMessages, compacted: false, trimmed, before, after: trimmedTokens };
  }
  if (messages.length < 4) throw new Error("当前请求与工具定义已超出上下文预算；请缩短请求或调大模型上下文窗口。");

  let keepFrom = Math.floor(messages.length * (1 - BROWSER_COMPACT_RETAIN_RATIO));
  while (keepFrom < messages.length && messages[keepFrom].role !== "user") keepFrom++;
  if (keepFrom >= messages.length) keepFrom = lastUserIndex(messages);
  const old = messages.slice(0, Math.max(keepFrom, 0));
  const archiveId = crypto.randomUUID().replace(/-/g, "");
  await writeRecord(`session:${sessionId}:archive:${archiveId}`, { messages: old });
  const summary = buildHandoff(old, archiveId, workspace, maxToolOutputChars);
  const next: ModelMessage[] = [
    { role: "user", content: `Another language model compacted this browser session. Build on it and avoid duplicate work.\n\n${summary}` },
    { role: "assistant", content: "OK, I will continue from this handoff and the current workspace." },
    ...messages.slice(keepFrom),
  ];
  const after = estimateBrowserTokens(next, system);
  if (after >= contextWindow * BROWSER_COMPACT_THRESHOLD_RATIO) {
    throw new Error("压缩后上下文仍超出预算；请缩短最新请求或调大模型上下文窗口。");
  }
  return { messages: next, compacted: true, trimmed, before, after, summary };
}
