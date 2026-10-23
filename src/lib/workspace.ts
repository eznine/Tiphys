/** Versioned, lightweight browser workspace metadata. Layer bytes stay in the runtime store. */
import type { DataLayer, LayerSelection } from "./dataLayers";

export const WORKSPACE_STORAGE_KEY = "tiphys-workspace-v1";
export const WORKSPACE_SCHEMA = "tiphys.workspace";
export const WORKSPACE_VERSION = 1;
export const WORKSPACE_SELECTION_LIMIT = 2500;
export const AGENT_GOAL_LIMIT = 3;
export const AGENT_TOOL_LIMIT = 8;
export const AGENT_TEXT_CHAR_LIMIT = 280;

/** A deliberately small recovery aid; never a transcript replay. */
export type AgentSessionStub = { goals: string[]; tools: string[] };

/** UI-safe summary of what was actually restored after a page reload. */
export type WorkspaceRecovery = {
  layerCount: number;
  selectedLayerName: string | null;
  selectionCount: number;
  hasAoi: boolean;
  transcriptAvailable: boolean;
  goals: string[];
  tools: string[];
};

export type WorkspaceLayerMeta = {
  id: string;
  name: string;
  kind: "vector" | "raster" | "table";
  visible: boolean;
  geometry_types: string[];
  feature_count: number;
  crs?: string;
};

export type WorkspaceSnapshot = {
  schema: typeof WORKSPACE_SCHEMA;
  version: typeof WORKSPACE_VERSION;
  updatedAt: number;
  layers: WorkspaceLayerMeta[];
  layerOrder: string[];
  selectedLayerId: string | null;
  aoi: number[] | null;
  selection: LayerSelection | null;
  selectionTruncated: boolean;
  tableLayerId: string | null;
  agent?: AgentSessionStub;
};

export type WorkspaceState = {
  selectedLayerId: string | null;
  aoi: number[] | null;
  selection: LayerSelection | null;
  tableLayerId: string | null;
  agent?: AgentSessionStub;
};

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const recent = new Map<string, true>();
  for (const item of value) {
    const normalized = text(item, maxChars);
    if (!normalized) continue;
    recent.delete(normalized);
    recent.set(normalized, true);
  }
  return [...recent.keys()].slice(-maxItems);
}

export function normalizeAgentSessionStub(value: unknown): AgentSessionStub | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const goals = stringList(item.goals, AGENT_GOAL_LIMIT, AGENT_TEXT_CHAR_LIMIT);
  const tools = stringList(item.tools, AGENT_TOOL_LIMIT, 120);
  return goals.length || tools.length ? { goals, tools } : undefined;
}

/** Keep only recent user goals and tool names, in chronological order. */
export function buildAgentSessionStub(goals: unknown[], tools: unknown[]): AgentSessionStub | undefined {
  return normalizeAgentSessionStub({ goals, tools });
}

export function normalizeWorkspaceRecovery(value: unknown): WorkspaceRecovery | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const layerCount = Math.max(0, Math.trunc(Number(item.layerCount) || 0));
  const selectionCount = Math.max(0, Math.trunc(Number(item.selectionCount) || 0));
  return {
    layerCount,
    selectedLayerName: text(item.selectedLayerName, 240) ?? null,
    selectionCount,
    hasAoi: item.hasAoi === true,
    transcriptAvailable: item.transcriptAvailable === true,
    goals: stringList(item.goals, AGENT_GOAL_LIMIT, AGENT_TEXT_CHAR_LIMIT),
    tools: stringList(item.tools, AGENT_TOOL_LIMIT, 120),
  };
}

export function validAoi(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map(Number);
  if (!bbox.every(Number.isFinite)) return null;
  if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
  return bbox;
}

function layerMeta(value: unknown): WorkspaceLayerMeta | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = text(item.id, 160);
  const name = text(item.name, 240);
  const kind = item.kind === "raster" || item.kind === "table" ? item.kind : "vector";
  if (!id || !name) return null;
  const geometry = Array.isArray(item.geometry_types) ? item.geometry_types.filter(type => typeof type === "string").slice(0, 12) : [];
  return { id, name, kind, visible: item.visible !== false, geometry_types: geometry,
    feature_count: Math.max(0, Math.trunc(Number(item.feature_count) || 0)),
    ...(text(item.crs, 80) ? { crs: text(item.crs, 80) } : {}) };
}

function selectionMeta(value: unknown): { selection: LayerSelection | null; truncated: boolean } {
  if (!value || typeof value !== "object") return { selection: null, truncated: false };
  const item = value as Record<string, unknown>;
  const layerId = text(item.layerId, 160);
  if (!layerId || !Array.isArray(item.featureIds)) return { selection: null, truncated: false };
  const ids = [...new Set(item.featureIds.map(Number).filter(id => Number.isInteger(id) && id >= 0))];
  const featureIds = ids.slice(0, WORKSPACE_SELECTION_LIMIT);
  return { selection: featureIds.length ? { layerId, featureIds } : null, truncated: ids.length > featureIds.length };
}

/** Validate untrusted localStorage content before applying it to map state. */
export function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.schema !== WORKSPACE_SCHEMA || item.version !== WORKSPACE_VERSION) return null;
  const layers = Array.isArray(item.layers) ? item.layers.map(layerMeta).filter((layer): layer is WorkspaceLayerMeta => !!layer) : [];
  const known = new Set(layers.map(layer => layer.id));
  const savedOrder = Array.isArray(item.layerOrder) ? item.layerOrder.map(id => text(id, 160)).filter((id): id is string => !!id && known.has(id)) : [];
  const layerOrder = [...new Set(savedOrder), ...layers.map(layer => layer.id).filter(id => !savedOrder.includes(id))];
  const selectedLayerId = text(item.selectedLayerId, 160);
  const tableLayerId = text(item.tableLayerId, 160);
  const { selection: savedSelection, truncated } = selectionMeta(item.selection);
  const agent = normalizeAgentSessionStub(item.agent);
  return {
    schema: WORKSPACE_SCHEMA,
    version: WORKSPACE_VERSION,
    updatedAt: Math.max(0, Number(item.updatedAt) || 0),
    layers: layerOrder.map(id => layers.find(layer => layer.id === id)!).filter(Boolean),
    layerOrder,
    selectedLayerId: selectedLayerId && known.has(selectedLayerId) ? selectedLayerId : null,
    aoi: validAoi(item.aoi),
    selection: savedSelection && known.has(savedSelection.layerId) ? savedSelection : null,
    selectionTruncated: truncated,
    tableLayerId: tableLayerId && known.has(tableLayerId) ? tableLayerId : null,
    ...(agent ? { agent } : {}),
  };
}

export function buildWorkspaceSnapshot(layers: DataLayer[], state: WorkspaceState, updatedAt = Date.now()): WorkspaceSnapshot {
  const meta = layers.map(layer => ({
    id: layer.id,
    name: layer.name,
    kind: layer.kind ?? "vector",
    visible: layer.visible !== false,
    geometry_types: [...layer.geometry_types],
    feature_count: layer.feature_count,
    ...(layer.crs ? { crs: layer.crs } : {}),
  })) as WorkspaceLayerMeta[];
  const ids = new Set(meta.map(layer => layer.id));
  const uniqueSelection = [...new Set(state.selection?.featureIds ?? [])];
  const selectionIds = uniqueSelection.slice(0, WORKSPACE_SELECTION_LIMIT);
  const agent = normalizeAgentSessionStub(state.agent);
  return {
    schema: WORKSPACE_SCHEMA,
    version: WORKSPACE_VERSION,
    updatedAt,
    layers: meta,
    layerOrder: meta.map(layer => layer.id),
    selectedLayerId: state.selectedLayerId && ids.has(state.selectedLayerId) ? state.selectedLayerId : null,
    aoi: validAoi(state.aoi),
    selection: state.selection && ids.has(state.selection.layerId) && selectionIds.length
      ? { layerId: state.selection.layerId, featureIds: selectionIds } : null,
    selectionTruncated: uniqueSelection.length > WORKSPACE_SELECTION_LIMIT,
    tableLayerId: state.tableLayerId && ids.has(state.tableLayerId) ? state.tableLayerId : null,
    ...(agent ? { agent } : {}),
  };
}

export function loadWorkspaceSnapshot(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): WorkspaceSnapshot | null {
  if (!storage) return null;
  try { return normalizeWorkspaceSnapshot(JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY) ?? "null")); }
  catch { return null; }
}

export function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): boolean {
  if (!storage) return false;
  try { storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot)); return true; }
  catch { return false; }
}

export function clearWorkspaceSnapshot(storage: Pick<Storage, "removeItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage) {
  try { storage?.removeItem(WORKSPACE_STORAGE_KEY); } catch { /* Storage can be unavailable in private modes. */ }
}
