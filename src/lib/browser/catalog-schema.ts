/** Shared catalog contracts for the Python-MCP and bundled GeoLibre WASM tools. */
import commonCatalog from "./catalog.json";
import manifests from "./wasm-catalog.json";

export type CatalogSchema = {
  type?: string; enum?: string[]; default?: unknown; anyOf?: CatalogSchema[]; items?: CatalogSchema;
  description?: string; "x-layer"?: boolean; "x-layer-kind"?: string;
};
export type CatalogTool = {
  name: string; description?: string; label?: string;
  category?: string; subcategory?: string;
  parameters: { type?: string; title?: string; properties?: Record<string, CatalogSchema>; required?: string[]; additionalProperties?: boolean };
  annotations?: { destructiveHint?: boolean };
};

type WasmManifest = (typeof manifests)[number];

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
    category: (manifest as any).taxonomy?.category ?? manifest.category,
    subcategory: (manifest as any).taxonomy?.subcategory,
    parameters: {
      type: "object", properties,
      required: manifest.params.filter(p => p.required && p.io_role !== "output").map(p => p.name),
      additionalProperties: false,
    },
  };
}

export const wasmToolSchemas: CatalogTool[] = manifests.map(schemaForWasm);
export const commonToolSchemas = commonCatalog as unknown as CatalogTool[];

/** Deduplicate by MCP tool name; earlier sources win. */
export function mergeCatalogTools(...sources: CatalogTool[][]): CatalogTool[] {
  const merged = new Map<string, CatalogTool>();
  for (const tools of sources) for (const tool of tools) if (!merged.has(tool.name)) merged.set(tool.name, tool);
  return [...merged.values()];
}

/** Web runtime catalog: shell/common tools plus every bundled WASM tool. */
export const browserToolCatalog = mergeCatalogTools(commonToolSchemas, wasmToolSchemas);

/** Desktop catalog: Python MCP tools plus every WASM schema and shell-only stubs. */
export function desktopToolCatalog(pythonTools: CatalogTool[]): CatalogTool[] {
  return mergeCatalogTools(pythonTools, wasmToolSchemas, commonToolSchemas);
}
