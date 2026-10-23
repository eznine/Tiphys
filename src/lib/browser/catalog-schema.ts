/** Shared catalog contracts for the Python-MCP and bundled GeoLibre WASM tools. */
import commonCatalog from "./catalog.json";
import { loadWasmManifests, yieldToMainThread, type WasmManifest } from "./wasm-catalog-loader";
import { pluginToolSchemas } from "../plugins/registry";

export type CatalogSchema = {
  type?: string; enum?: string[]; default?: unknown; anyOf?: CatalogSchema[]; items?: CatalogSchema;
  description?: string; "x-layer"?: boolean; "x-layer-kind"?: string; "x-layer-multiple"?: boolean;
};
export type CatalogTool = {
  name: string; description?: string; label?: string;
  category?: string; subcategory?: string;
  parameters: { type?: string; title?: string; properties?: Record<string, CatalogSchema>; required?: string[]; additionalProperties?: boolean };
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
};

/** Some upstream manifests mark optional output paths as inputs. */
export function isOutputLikeParam(param: { name: string; io_role?: string; description?: string }): boolean {
  return param.io_role === "output" || (param.io_role === "input" && /_output$/.test(param.name) && /output .*path/i.test(param.description ?? ""));
}

/** Upstream manifests occasionally mark real inputs (or enum modes) as outputs. */
const WASM_INPUT_OVERRIDES = new Set(["cost_pathway.destination", "network_service_area.output_mode"]);

/** Upstream occasionally marks numeric scalars as raster/vector inputs. */
const WASM_SCALAR_INPUT_OVERRIDES = new Set([
  "idw_interpolation.cell_size",
  "tin_interpolation.cell_size",
]);

export function isWasmInputParam(toolId: string, param: { name: string; io_role?: string; description?: string }): boolean {
  if (WASM_SCALAR_INPUT_OVERRIDES.has(`${toolId}.${param.name}`)) return false;
  return WASM_INPUT_OVERRIDES.has(`${toolId}.${param.name}`) || param.io_role === "input" && !isOutputLikeParam(param);
}

export function isWasmOutputParam(toolId: string, param: { name: string; io_role?: string; description?: string }): boolean {
  return isOutputLikeParam(param) && !WASM_INPUT_OVERRIDES.has(`${toolId}.${param.name}`);
}

/** Upstream stack tools describe ordered layers as scalar inputs; the UI needs explicit arrays. */
const WASM_SCHEMA_OVERRIDES: Record<string, Record<string, CatalogSchema>> = {
  network_service_area: {
    max_cost: { type: "string", default: "1000", description: "最大可达网络成本；单位与网络图层坐标系或成本字段一致。" },
    ring_costs: { type: "string", description: "可选的多环阈值，用逗号分隔，例如 5,10,15；留空时只输出最大成本范围。" },
    output_mode: { type: "string", enum: ["nodes", "edges", "polygons"], default: "nodes",
      description: "输出模式：nodes 节点、edges 可达边、polygons 每个起点的服务区面。" },
  },
  idw_interpolation: {
    cell_size: { type: "number", default: 1, description: "输出像元大小；未提供基准栅格时使用。单位与输入点图层坐标系一致。" },
  },
  tin_interpolation: {
    cell_size: { type: "number", default: 1, description: "输出像元大小；未提供基准栅格时使用。单位与输入点图层坐标系一致。" },
    max_triangle_edge_length: { type: "number", description: "可选的最大三角网边长，单位与输入点图层坐标系一致。" },
  },
  line_density: {
    area_units: { type: "string", enum: ["square_map_units", "square_meters", "square_kilometers", "square_miles", "square_feet"],
      default: "square_map_units", description: "密度值的面积单位；默认使用输入坐标系的地图单位平方。" },
  },
  merge_vectors: {
    inputs: { type: "array", "x-layer": true, "x-layer-kind": "vector", "x-layer-multiple": true,
      description: "按顺序选择两个或更多同几何类型的矢量图层。" },
  },
  build_network_topology: {
    snap_tolerance: { type: "number", default: 0.000001,
      description: "交叉点吸附容差；默认 0.000001。使用投影坐标时可适当增大。" },
  },
  weighted_overlay: {
    factors: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "按顺序选择 2 个或更多因子栅格。" },
    weights: { type: "string", default: "1,1", description: "与因子顺序对应的逗号分隔权重，例如 0.6,0.4。" },
  },
  weighted_sum: {
    input_rasters: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "按顺序选择 2 个或更多输入栅格。" },
    weights: { type: "string", default: "1,1", description: "与输入栅格顺序对应的逗号分隔权重，例如 1,1。" },
  },
  extract_raster_values_at_points: {
    rasters: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "选择一个或多个栅格；点图层会追加每个栅格的采样值字段。" },
  },
  mosaic: {
    inputs: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "按顺序选择要镶嵌的栅格；输出使用第一个输入的投影与分辨率。" },
  },
};

/** Convert an upstream WASM manifest into the MCP-style schema ToolPanel expects. */
export function schemaForWasm(manifest: WasmManifest): CatalogTool {
  const properties: Record<string, CatalogSchema> = {};
  for (const p of manifest.params) {
    if (isWasmOutputParam(manifest.id, p)) continue;
    const schema = p.schema as Record<string, any>;
    properties[p.name] = isWasmInputParam(manifest.id, p)
      ? { type: "string", "x-layer": true, "x-layer-kind": p.data_kind, description: p.description }
      : { type: schema.kind === "bool" ? "boolean" : schema.kind === "scalar" ? schema.scalar === "integer" ? "integer" : "number" : "string",
          description: p.description, ...(schema.options ? { enum: schema.options.map((o: any) => String(o.value)) } : {}) };
    // Upstream example paths and required scalar examples are not defaults.
    if (!p.io_role && !p.required && Object.prototype.hasOwnProperty.call(manifest.defaults ?? {}, p.name))
      properties[p.name].default = (manifest.defaults as Record<string, unknown>)[p.name];
  }
  Object.assign(properties, WASM_SCHEMA_OVERRIDES[manifest.id] ?? {});
  properties.output_name = { type: "string", description: "结果图层名称" };
  return {
    name: `wasm_${manifest.id}`,
    label: manifest.display_name,
    description: manifest.summary,
    category: manifest.taxonomy?.category ?? manifest.category,
    subcategory: manifest.taxonomy?.subcategory,
    parameters: {
      type: "object", properties,
      required: manifest.params.filter(p => p.required && isWasmInputParam(manifest.id, p)).map(p => p.name),
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
