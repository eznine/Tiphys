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
const WASM_INPUT_OVERRIDES = new Set(["cost_pathway.destination", "cost_back_link.source", "network_service_area.output_mode"]);

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
  "extend_vector_lines.distance",
  "split_vector_lines.segment_length",
]);

/** Upstream omits required flags on some scalar options and one DEM input. */
const WASM_REQUIRED_OVERRIDES: Record<string, Set<string>> = {
  directional_distribution: new Set(["statistic"]),
  extract_valleys: new Set(["dem"]),
};

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
    value_field: { type: "string", description: "用于插值的数值字段。" },
  },
  local_kriging: {
    cell_size: { type: "number", default: 1, description: "输出像元大小，单位与输入点图层坐标系一致；也可选择基准栅格。" },
    k_neighbors: { type: "integer", default: 10, description: "参与局部估计的最近邻点数。" },
    value_field: { type: "string", description: "用于插值的数值字段。" },
  },
  frost_filter: {
    radius: { type: "integer", default: 2, description: "局部统计窗口半径（像元）；SAR 斑点抑制强度随窗口增大。" },
    damping_factor: { type: "number", default: 2, description: "Frost 指数衰减阻尼因子。" },
  },
  fast_almost_gaussian_filter: {
    sigma: { type: "number", default: 1.8, description: "近似高斯平滑强度；建议不小于 1.8。" },
  },
  focal_statistics: {
    statistics: { type: "string", enum: ["mean", "majority", "maximum", "median", "minimum", "minority", "percentile", "range", "std", "sum", "variety"],
      default: "mean", description: "焦点统计量：均值、众数、最大值、中位数、最小值、少数、百分位、范围、标准差、总和或类别数。" },
    neighborhood: { type: "string", enum: ["rectangle", "circle", "annulus", "wedge"], default: "rectangle",
      description: "邻域形状：矩形、圆形、环形或扇形。" },
    width: { type: "integer", default: 3, description: "矩形邻域宽度（像元）。" },
    height: { type: "integer", default: 3, description: "矩形邻域高度（像元）。" },
    radius: { type: "number", default: 1, description: "圆形/扇形半径，或环形邻域外半径（像元）。" },
    inner_radius: { type: "number", default: 0, description: "环形邻域内半径（像元）。" },
    start_angle: { type: "number", default: 0, description: "扇形起始角（度，正东为 0，逆时针）。" },
    end_angle: { type: "number", default: 90, description: "扇形终止角（度，正东为 0，逆时针）。" },
    percentile_value: { type: "number", default: 90, description: "百分位统计量使用的百分位（0–100）。" },
    ignore_nodata: { type: "boolean", default: true, description: "仅用窗口内有效像元统计；关闭时窗口含 NoData 即输出 NoData。" },
    band: { type: "integer", default: 1, description: "参与计算的 1 基波段。" },
  },
  principal_component_analysis: {
    inputs: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "按波段顺序选择至少 3 个同网格栅格。" },
    num_components: { type: "integer", description: "输出主成分数量；留空时输出全部成分。" },
    standardized: { type: "boolean", default: false, description: "是否基于相关矩阵（标准化各输入波段）。" },
    auto_reproject_method: { type: "string", enum: ["nearest", "bilinear", "cubic", "lanczos", "average", "min", "max", "mode", "median", "stddev"],
      default: "nearest", description: "输入栅格坐标系不一致时的重采样方式。" },
  },
  k_means_clustering: {
    inputs: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "按波段顺序选择参与聚类的栅格。" },
    classes: { type: "integer", description: "目标类别数 k。" },
    max_iterations: { type: "integer", default: 10, description: "最大迭代次数。" },
    class_change: { type: "number", default: 2, description: "变化像元比例低于该百分比时停止迭代。" },
    initialize: { type: "string", enum: ["diagonal", "random"], default: "diagonal", description: "初始质心策略。" },
    min_class_size: { type: "integer", default: 10, description: "更新质心时使用的最小类别像元数。" },
  },
  central_feature: {
    statistic: { type: "string", enum: ["central_feature", "linear_directional_mean"], default: "central_feature",
      description: "central_feature 计算总距离最小的中心要素；linear_directional_mean 用于线要素的方向均值。" },
    distance: { type: "string", enum: ["euclidean", "manhattan"], default: "euclidean",
      description: "中心要素的距离度量。" },
    orientation_only: { type: "boolean", default: false,
      description: "线性方向均值是否忽略线的起止方向（按 0–180° 处理）。" },
  },
  directional_distribution: {
    statistic: { type: "string", enum: ["mean_center", "median_center", "central_feature", "standard_distance", "standard_deviational_ellipse"],
      default: "standard_deviational_ellipse", description: "选择中心、标准距离圆或标准差椭圆。" },
    n_std: { type: "integer", default: 1, description: "标准距离圆与标准差椭圆的标准差倍数（1、2 或 3）。" },
  },
  extract_valleys: {
    dem: { type: "string", "x-layer": true, "x-layer-kind": "raster", description: "输入无洼地 DEM 栅格。" },
    filter_size: { type: "integer", description: "谷线检测窗口大小（奇数像元）。" },
    line_thin: { type: "boolean", default: false, description: "是否细化输出谷线为单像元宽。" },
    variant: { type: "string", enum: ["lq", "jandr", "pandd"], default: "lq",
      description: "谷线检测算法：lq、jandr 或 pandd。" },
  },
  path_distance: {
    source: { type: "string", "x-layer": true, "x-layer-kind": "raster",
      description: "源栅格；正值且非 NoData 的像元为起点。" },
    vertical_factor: { type: "string", enum: ["tobler", "linear", "sym_linear", "inverse_linear", "binary"],
      default: "tobler", description: "坡度垂直因子：Tobler 徒步函数、线性、对称线性、反线性或二值阈值。" },
    slope_factor: { type: "number", default: 1, description: "线性垂直因子的坡度惩罚系数。" },
    zero_factor: { type: "number", default: 0.1, description: "线性/反线性因子的下坡最小值。" },
    max_slope: { type: "number", default: 30, description: "binary 因子允许通过的最大坡度（度）。" },
    band: { type: "integer", default: 1, description: "所有输入栅格使用的 1 基波段。" },
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
  laplacian_filter: {
    variant: { type: "string", enum: ["3x3(1)", "3x3(2)", "3x3(3)", "3x3(4)", "5x5(1)", "5x5(2)"],
      default: "3x3(1)", description: "拉普拉斯卷积核变体。" },
    clip_amount: { type: "number", default: 0, description: "可选的两端裁剪百分比（0–40）。" },
  },
  extend_vector_lines: {
    distance: { type: "number", default: 1, description: "线端点延伸距离，单位与输入图层坐标系一致。" },
    extend_direction: { type: "string", enum: ["both", "start", "end"], default: "both",
      description: "延伸端点：both 两端、start 起点、end 终点。" },
  },
  split_vector_lines: {
    segment_length: { type: "number", description: "每段的最大长度，单位与输入图层坐标系一致。" },
  },
  vector_lines_to_raster: {
    field: { type: "string", description: "可选数值字段，用于烧录像元值；留空时使用 FID。" },
    cell_size: { type: "number", description: "输出像元大小；未提供基准栅格时使用。单位与输入图层坐标系一致。" },
  },
  downslope_index: {
    output_type: { type: "string", enum: ["tangent", "degrees", "radians", "distance"], default: "tangent",
      description: "下坡指数输出形式。" },
  },
  find_identical: {
    compare_geometry: { type: "boolean", default: true, description: "是否把几何形状也纳入相同性判断。" },
    mode: { type: "string", enum: ["report", "delete"], default: "report",
      description: "report 标记重复分组；delete 每组仅保留第一个要素。" },
  },
  integrate: {
    snap_to_edges: { type: "boolean", default: true, description: "是否同时把邻近折点插入相邻线段以消除 T 形缝隙。" },
  },
  lee_filter: {
    filter_size_x: { type: "integer", default: 11, description: "Lee 滤波窗口宽度（奇数像元）。" },
    filter_size_y: { type: "integer", default: 11, description: "Lee 滤波窗口高度（奇数像元）。" },
  },
  conservative_smoothing_filter: {
    filter_size_x: { type: "integer", default: 3, description: "保守平滑窗口宽度（奇数像元）。" },
    filter_size_y: { type: "integer", default: 3, description: "保守平滑窗口高度（奇数像元）。" },
  },
  cost_back_link: {
    source: { type: "string", "x-layer": true, "x-layer-kind": "any",
      description: "源位置：可选择栅格（非零且非 NoData 为源）或点/多点矢量图层。" },
  },
  change_vector_analysis: {
    date1: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "早期日期栅格，按波段顺序选择。" },
    date2: { type: "array", "x-layer": true, "x-layer-kind": "raster", "x-layer-multiple": true,
      description: "后期日期栅格，波段数量与顺序需和早期日期一致。" },
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
      required: manifest.params.filter(p => WASM_REQUIRED_OVERRIDES[manifest.id]?.has(p.name) ||
        p.required && isWasmInputParam(manifest.id, p)).map(p => p.name),
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
