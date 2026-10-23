/** Shared catalog contracts for the Python-MCP and bundled GeoLibre WASM tools. */
import commonCatalog from "./catalog.json";
import { loadWasmManifests, yieldToMainThread, type WasmManifest } from "./wasm-catalog-loader";
import { pluginToolSchemas } from "../plugins/registry";

export type CatalogSchema = {
  type?: string; enum?: string[]; default?: unknown; anyOf?: CatalogSchema[]; items?: CatalogSchema;
  description?: string; "x-layer"?: boolean; "x-layer-kind"?: string;
};
export type CatalogTool = {
  name: string; description?: string; label?: string;
  category?: string; subcategory?: string;
  parameters: { type?: string; title?: string; properties?: Record<string, CatalogSchema>; required?: string[]; additionalProperties?: boolean };
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
};

/** Convert an upstream WASM manifest into the MCP-style schema ToolPanel expects. */
export function schemaForWasm(manifest: WasmManifest): CatalogTool {
  const properties: Record<string, CatalogSchema> = {};
  for (const p of manifest.params) {
    if (p.io_role === "output") continue;
    const schema = p.schema as Record<string, any>;
    properties[p.name] = p.io_role === "input"
      ? { type: "string", "x-layer": true, "x-layer-kind": p.data_kind, description: p.description }
      : { type: schema.kind === "bool" ? "boolean" : schema.kind === "scalar" ? schema.scalar === "integer" ? "integer" : "number" : "string",
          description: p.description, ...(schema.options ? { enum: schema.options.map((o: any) => String(o.value)) } : {}) };
    // Upstream example paths and required scalar examples are not defaults.
    if (!p.io_role && !p.required && Object.prototype.hasOwnProperty.call(manifest.defaults ?? {}, p.name))
      properties[p.name].default = (manifest.defaults as Record<string, unknown>)[p.name];
  }
  properties.output_name = { type: "string", description: "结果图层名称" };
  return {
    name: `wasm_${manifest.id}`,
    label: manifest.display_name,
    description: manifest.summary,
    category: manifest.taxonomy?.category ?? manifest.category,
    subcategory: manifest.taxonomy?.subcategory,
    parameters: {
      type: "object", properties,
      required: manifest.params.filter(p => p.required && p.io_role !== "output").map(p => p.name),
      additionalProperties: false,
    },
  };
}

/** Shell-visible tools: common MCP operations and local extensions. */
export const commonToolSchemas = commonCatalog as unknown as CatalogTool[];
export const shellToolCatalog = mergeCatalogTools(commonToolSchemas, pluginToolSchemas);

/** Hydrated in place so existing `browserCatalog` references stay valid. */
export const wasmToolSchemas: CatalogTool[] = [];
export const browserToolCatalog = [...shellToolCatalog];

const SHELL_COUNT = shellToolCatalog.length;
let hydration: Promise<CatalogTool[]> | undefined;
let hydrated = false;
let hydrationError = "";

/** Deduplicate by MCP tool name; earlier sources win. */
export function mergeCatalogTools(...sources: CatalogTool[][]): CatalogTool[] {
  const merged = new Map<string, CatalogTool>();
  for (const tools of sources) for (const tool of tools) if (!merged.has(tool.name)) merged.set(tool.name, tool);
  return [...merged.values()];
}

/**
 * Append the 958 WASM schemas in small chunks. The manifest import is dynamic
 * and schema conversion yields between chunks, keeping the shell responsive.
 */
export function hydrateWasmCatalog(): Promise<CatalogTool[]> {
  if (hydrated) return Promise.resolve(wasmToolSchemas);
  if (hydration) return hydration;
  hydration = (async () => {
    try {
      const manifests = await loadWasmManifests();
      const chunkSize = 48;
      for (let offset = 0; offset < manifests.length; offset += chunkSize) {
        for (const manifest of manifests.slice(offset, offset + chunkSize)) wasmToolSchemas.push(schemaForWasm(manifest));
        await yieldToMainThread();
      }
      // Canonical order: common tools, every WASM schema, then plugin tools.
      browserToolCatalog.splice(0, browserToolCatalog.length, ...mergeCatalogTools(commonToolSchemas, wasmToolSchemas, pluginToolSchemas));
      hydrated = true;
      hydrationError = "";
      return wasmToolSchemas;
    } catch (error) {
      hydrationError = String(error);
      hydration = undefined;
      throw error;
    }
  })();
  return hydration;
}

export function ensureBrowserCatalog(): Promise<CatalogTool[]> {
  return hydrateWasmCatalog().then(() => browserToolCatalog);
}

export function browserCatalogState() {
  return {
    shell: SHELL_COUNT,
    initial: SHELL_COUNT,
    wasm: wasmToolSchemas.length,
    total: browserToolCatalog.length,
    hydrated,
    error: hydrationError || undefined,
  };
}

/** Desktop catalog: Python MCP tools plus every WASM schema and shell-only stubs. */
export function desktopToolCatalog(pythonTools: CatalogTool[]): CatalogTool[] {
  return mergeCatalogTools(pythonTools, wasmToolSchemas, commonToolSchemas, pluginToolSchemas);
}
