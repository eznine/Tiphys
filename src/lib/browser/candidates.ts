/**
 * Compact, capability-aware view of a catalog tool.
 *
 * Why: `search_browser_tools` used to return full MCP schemas. Eight of those
 * are several thousand tokens of descriptions, defaults and titles the model
 * cannot use, and nothing said which tools accept a raster or need a table.
 * Search now returns this view: identity, one-line summary, input kinds and the
 * parameters that actually decide whether a call can be built. Layer inputs are
 * included by their exact wire name: `inputKinds` says "this tool takes a
 * raster", but only the parameter card tells the model to send `d8_pntr`.
 *
 * The annotations are not invented here: `x-layer-kind` and `x-layer-multiple`
 * come from the catalog itself (WASM manifests and the hand-written shell
 * schemas), so a filter can only be as precise as the data behind it.
 */
import type { CatalogTool, CatalogSchema } from "./catalog-schema";
import { pluginToolNames } from "../plugins/registry";
import { zhParam } from "../i18n/tools";

export type InputKind = "vector" | "raster" | "table" | "any";
export type ToolProvider = "local" | "gee" | "plugin";

export type ToolCapabilities = {
  provider: ToolProvider;
  inputKinds: InputKind[];
  multiInput: boolean;
  required: string[];
};

export type ToolParameter = {
  name: string;
  type: string;
  required: boolean;
  /** Present for layer inputs; the callable wire name is always `name`. */
  kind?: InputKind | "file" | "mixed";
  /** Short Chinese label, e.g. `d8_pntr` → "上游 D8 流向栅格". */
  label?: string;
  hint?: string;
  multiple?: boolean;
  enum?: string[];
  default?: unknown;
};

export type ToolCandidate = {
  name: string;
  label: string;
  category: string;
  subcategory?: string;
  summary: string;
  provider: ToolProvider;
  inputKinds: InputKind[];
  multiInput: boolean;
  params: ToolParameter[];
};

const KIND_ORDER: InputKind[] = ["vector", "raster", "table", "any"];

function normalKind(kind: string | undefined): InputKind | null {
  if (kind === "vector" || kind === "raster" || kind === "table" || kind === "any") return kind;
  // WASM manifests also use `file` and `mixed`; neither promises a specific
  // geometry or band layout, so they must not pass a vector/raster filter.
  return null;
}

function layerParams(tool: CatalogTool): { kind: InputKind; multiple: boolean }[] {
  const properties = tool.parameters.properties ?? {};
  const found: { kind: InputKind; multiple: boolean }[] = [];
  for (const schema of Object.values(properties)) {
    if (!schema["x-layer"]) continue;
    const kind = normalKind(schema["x-layer-kind"]);
    if (kind) found.push({ kind, multiple: Boolean(schema["x-layer-multiple"]) });
  }
  return found;
}

export function toolProvider(tool: CatalogTool): ToolProvider {
  if (tool.name.startsWith("gee_")) return "gee";
  if (pluginToolNames.has(tool.name)) return "plugin";
  return "local";
}

export function toolCapabilities(tool: CatalogTool): ToolCapabilities {
  const params = layerParams(tool);
  const kinds = new Set(params.map(param => param.kind));
  // A tool with no layer input is not "any input": it takes no dataset at all.
  const inputKinds = [...kinds].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  return {
    provider: toolProvider(tool),
    inputKinds,
    multiInput: params.some(param => param.multiple),
    required: tool.parameters.required ?? [],
  };
}

function summarise(tool: CatalogTool, limit = 110): string {
  const text = (tool.description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return `${tool.label ?? tool.name}。`;
  const first = text.split(/(?<=。)|(?<=\.)\s/)[0].trim();
  return first.length > limit ? `${first.slice(0, limit)}…` : first;
}

function parameter(schema: CatalogSchema, name: string, required: boolean): ToolParameter {
  const type = schema.type ?? (schema.anyOf ? "any" : "string");
  const param: ToolParameter = {
    name, type, required,
    ...(schema.enum?.length ? { enum: schema.enum } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
  };
  if (schema["x-layer"]) {
    const kind = normalKind(schema["x-layer-kind"]) ?? schema["x-layer-kind"];
    if (kind) param.kind = kind as ToolParameter["kind"];
    param.label = zhParam(name);
    const hint = (schema.description ?? "").replace(/\s+/g, " ").trim();
    // English manifest blurbs repeat the Chinese label; keep hints only when
    // they add Chinese context, so the cards stay within the old token budget.
    if (/[\u4e00-\u9fff]/.test(hint)) param.hint = hint.length > 60 ? `${hint.slice(0, 60)}…` : hint;
    if (schema["x-layer-multiple"]) param.multiple = true;
  }
  return param;
}

export function compactTool(tool: CatalogTool): ToolCandidate {
  const capabilities = toolCapabilities(tool);
  const properties = tool.parameters.properties ?? {};
  const required = new Set(capabilities.required);
  const params: ToolParameter[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    if (name === "output_name") continue; // every tool has it; not a decision
    params.push(parameter(schema, name, required.has(name)));
  }
  // Put the arguments that bind data first, required ones first: a model that
  // stops reading after the first line still sees `d8_pntr (raster, required)`.
  const rank = (param: ToolParameter) => param.kind ? (param.required ? 0 : 2) : (param.required ? 1 : 3);
  params.sort((a, b) => rank(a) - rank(b));
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    category: tool.category ?? "未分类",
    ...(tool.subcategory ? { subcategory: tool.subcategory } : {}),
    summary: summarise(tool),
    provider: capabilities.provider,
    inputKinds: capabilities.inputKinds,
    multiInput: capabilities.multiInput,
    params,
  };
}

export type CapabilityFilter = { inputKind?: InputKind; provider?: ToolProvider };

/** A filter with `inputKind` must exclude tools whose data contract is unknown. */
export function matchesFilter(tool: CatalogTool, filter: CapabilityFilter): boolean {
  const capabilities = toolCapabilities(tool);
  if (filter.provider && capabilities.provider !== filter.provider) return false;
  if (filter.inputKind) {
    if (!capabilities.inputKinds.length) return false;
    if (!capabilities.inputKinds.some(kind => kind === filter.inputKind || kind === "any")) return false;
  }
  return true;
}
