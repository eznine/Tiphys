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
  "empirical_bayesian_kriging.cell_size",
  "ordinary_kriging.cell_size",
  "simple_kriging.cell_size",
  "local_kriging.cell_size",
  // Upstream marks bilateral sigma/intensity options as raster inputs.
  "bilateral_filter.sigma_int",
  "bilateral_filter.treat_as_rgb",
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
  sieve: {
    zero_background: { type: "boolean", default: false,
      description: "是否把值为 0 的像元视为背景并写入输出；分类栅格常保持关闭。" },
  },
  empirical_bayesian_kriging: {
    cell_size: { type: "number", description: "输出像元大小，单位与输入点图层坐标系一致；留空时按约 150 格自动确定。" },
    subset_size: { type: "integer", default: 40, description: "每个局部子集的目标点数，最少 4。" },
    simulations: { type: "integer", default: 5, description: "每个子集模拟的半变异函数数量（最多 50）。" },
  },
  ordinary_kriging: {
    cell_size: { type: "number", default: 1, description: "输出像元大小，单位与输入点图层坐标系一致；也可选择基准栅格。" },
    value_field: { type: "string", description: "用于插值的数值字段。" },
  },
  simple_kriging: {
    cell_size: { type: "number", default: 1, description: "输出像元大小，单位与输入点图层坐标系一致；也可选择基准栅格。" },
    known_mean: { type: "number", default: 0, description: "已知的总体均值；仅在空间场均值可靠已知时使用。" },
  },
  local_kriging: {
    cell_size: { type: "number", default: 1, description: "输出像元大小，单位与输入点图层坐标系一致；也可选择基准栅格。" },
    k_neighbors: { type: "integer", default: 10, description: "参与局部估计的最近邻点数。" },
  },
  bilateral_filter: {
    sigma_int: { type: "number", default: 1, description: "强度核阈值；越大保留的强度差异越多，边缘保持越明显。" },
    treat_as_rgb: { type: "boolean", default: false, description: "是否按 RGB 三通道联合处理。" },
  },
  gaussian_filter: {
    treat_as_rgb: { type: "boolean", default: false, description: "是否按 RGB 三通道联合平滑。" },
  },
  edge_preserving_mean_filter: {
    filter_size: { type: "integer", default: 11, description: "移动窗口边长（奇数像元）。" },
  },
  mean_filter: {
    filter_size_x: { type: "integer", default: 11, description: "移动窗口宽度（奇数像元）。" },
    filter_size_y: { type: "integer", default: 11, description: "移动窗口高度（奇数像元）。" },
  },
  minimum_bounding_box: {
    min_criteria: { type: "string", enum: ["area", "perimeter", "length", "width"], default: "area",
      description: "最小化准则：area 面积、perimeter 周长、length 长度或 width 宽度。" },
  },
  opening: {
    filter_size_x: { type: "integer", default: 11, description: "结构元素宽度（奇数像元）。" },
    filter_size_y: { type: "integer", default: 11, description: "结构元素高度（奇数像元）。" },
  },
  closing: {
    filter_size_x: { type: "integer", default: 11, description: "结构元素宽度（奇数像元）。" },
    filter_size_y: { type: "integer", default: 11, description: "结构元素高度（奇数像元）。" },
  },
  percentile_filter: {
    filter_size_x: { type: "integer", default: 11, description: "移动窗口宽度（奇数像元）。" },
    filter_size_y: { type: "integer", default: 11, description: "移动窗口高度（奇数像元）。" },
    sig_digits: { type: "integer", default: 2, description: "分位排名量化使用的有效数字位数。" },
  },
  nibble: {
    use_nodata: { type: "boolean", default: false, description: "是否把输入 NoData 也视为一个类别值。" },
    nibble_nodata: { type: "boolean", default: true, description: "是否同时填充掩膜之外的无数据区域。" },
  },
  eliminate_polygon_part: {
    condition: { type: "string", enum: ["AREA", "PERCENT"], default: "AREA", description: "碎面/孔洞阈值方式。" },
    part_option: { type: "string", enum: ["CONTAINED_ONLY", "ANY"], default: "CONTAINED_ONLY",
      description: "CONTAINED_ONLY 仅移除孔洞；ANY 还会移除除最大面外的小外环部件。" },
  },
  aggregate_points: {
    min_points: { type: "integer", default: 2, description: "输出簇所需的最少点数；设为 1 可保留单点。" },
    method: { type: "string", enum: ["convex_hull", "buffer"], default: "convex_hull", description: "簇面生成方式。" },
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
