import type { ExtensionManifest, ExtensionRunContext } from "./types";

const EXTENSION_CATEGORY = "扩展";
const EXTENSION_SUBCATEGORY = "插件";

const linkageMapper: ExtensionManifest = {
  id: "linkage-mapper",
  name: "Linkage Mapper",
  version: "0.2.0",
  tools: [{
    name: "linkage_mapper_corridor",
    label: "生态廊道分析",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "基于核心生境多边形与阻力栅格，构建最小成本廊道网络并输出廊道面与中心线；内部串联多边形栅格化与最优廊道连接工具。",
    parameters: {
      type: "object",
      properties: {
        layer: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "核心生境面图层，至少包含两个区域" },
        resistance: { type: "string", "x-layer": true, "x-layer-kind": "raster", description: "阻力/成本栅格；NoData 表示不可通行" },
        barriers: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "可选障碍面图层" },
        corridor_width: { type: "number", description: "廊道宽度（阻力栅格的地图单位）；留空按 10 个像元" },
        neighbor_option: { type: "string", enum: ["spanning_tree", "all_pairs"], description: "使用最小生成树或所有区域对连接" },
        output_name: { type: "string", description: "结果图层名称" },
      },
      required: ["layer", "resistance"],
      additionalProperties: false,
    },
    annotations: {},
  }],
  run: async (_toolName, args, context) => {
    const outputName = String(args.output_name || "生态廊道");
    const width = args.corridor_width == null || args.corridor_width === "" ? undefined : Number(args.corridor_width);
    if (width !== undefined && (!Number.isFinite(width) || width <= 0)) throw new Error("廊道宽度必须为正数。");
    const source = await context.runTool("wasm_vector_polygons_to_raster", {
      input: args.layer,
      base: args.resistance,
      zero_background: true,
      output_name: `${outputName}_核心源`,
    });
    const corridor = await context.runTool("wasm_optimal_corridor_connections", {
      input: args.layer,
      cost_raster: args.resistance,
      ...(args.barriers ? { barriers: args.barriers } : {}),
      ...(width !== undefined ? { corridor_width: width } : {}),
      neighbor_option: args.neighbor_option || "spanning_tree",
      output_name: outputName,
    });
    const sourceLayer = source.layer ?? source.layers?.[0]?.layer;
    const corridorLayers = corridor.layers ?? (corridor.layer ? [{ ok: true, layer: corridor.layer, engine: corridor.engine }] : []);
    if (!sourceLayer || !corridorLayers.length) throw new Error("廊道分析未生成预期结果。");
    return {
      ok: true,
      plugin: "linkage-mapper",
      available: true,
      model: "least_cost_corridor_network",
      corridor_width: width ?? null,
      neighbor_option: args.neighbor_option || "spanning_tree",
      source_raster: sourceLayer,
      layers: [source, ...corridorLayers],
      tools: ["wasm_vector_polygons_to_raster", "wasm_optimal_corridor_connections"],
      message: "廊道网络已生成：核心生境已栅格化到阻力栅格网格，并输出廊道面与中心线。",
      limitations: "当前实现为无方向的最小成本廊道网络；不包含 LinkageMapper 的夹点、阻碍点和分区统计后处理。",
    };
  },
};

const whiteboxExtra: ExtensionManifest = {
  id: "whitebox-extra",
  name: "Whitebox Extra",
  version: "0.1.0-stub",
  tools: [{
    name: "whitebox_extra",
    label: "Whitebox 扩展包（占位）",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "说明入口：GeoLibre/WASM 已覆盖的 Whitebox 栅格、地形与水文工具无需重复安装。",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true },
  }],
  run: () => ({
    ok: false,
    available: false,
    plugin: "whitebox-extra",
    message: "无需额外 Whitebox 扩展：栅格、地形、水文和遥感工具已通过 GeoLibre WASM 内置在工具箱中，可用搜索栏查找。",
    examples: ["wasm_hillshade", "wasm_watershed", "wasm_extract_streams", "wasm_slope"],
  }),
};

const hydrologyFlow: ExtensionManifest = {
  id: "hydrology-flow",
  name: "Hydrology Flow Pipeline",
  version: "0.1.0",
  tools: [{
    name: "hydrology_flow_pipeline",
    label: "水文流向链",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "从 DEM 串联洼地处理、D8 流向、汇流累积，并可选提取河网与按汇水点划分流域；所有中间栅格均保留为图层。",
    parameters: {
      type: "object",
      properties: {
        dem: { type: "string", "x-layer": true, "x-layer-kind": "raster", description: "输入 DEM 栅格；应具有有效高程与 NoData" },
        depression_method: { type: "string", enum: ["fill", "breach"], default: "fill", description: "填洼或最小成本开裂洼地" },
        stream_threshold: { type: "number", default: 1000, description: "河网提取的最小汇流累积值（像元数）" },
        extract_streams: { type: "boolean", default: true, description: "是否从汇流累积中提取河网" },
        pour_points: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "可选点图层；提供后划分流域" },
        snap_distance: { type: "number", description: "可选汇水点吸附距离（DEM 坐标单位）；仅在提供汇水点时使用" },
        output_name: { type: "string", description: "结果图层名称前缀" },
      },
      required: ["dem"],
      additionalProperties: false,
    },
    annotations: {},
  }],
  run: async (toolName, args, context) => {
    if (toolName !== "hydrology_flow_pipeline") throw new Error(`未知水文工具：${toolName}`);
    const threshold = args.stream_threshold == null || args.stream_threshold === "" ? 1000 : Number(args.stream_threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("河网阈值必须为正数。");
    const snapDistance = args.snap_distance == null || args.snap_distance === "" ? undefined : Number(args.snap_distance);
    if (snapDistance !== undefined && (!Number.isFinite(snapDistance) || snapDistance <= 0)) throw new Error("汇水点吸附距离必须为正数。");
    const base = String(args.output_name || "水文分析");
    const method = args.depression_method === "breach" ? "breach" : "fill";
    const tools: string[] = [];
    const steps: Array<Record<string, unknown>> = [];
    const layers: Array<Record<string, any>> = [];
    const layerOf = (result: Record<string, any>, label: string) => {
      const layer = result.layer ?? result.layers?.[0]?.layer;
      if (!layer) throw new Error(`${label}未生成预期的栅格图层。`);
      return layer;
    };
    const record = (tool: string, step: string, result: Record<string, any>) => {
      const layer = result.layer ?? result.layers?.[0]?.layer;
      if (!layer) throw new Error(`${step}未生成结果图层。`);
      tools.push(tool);
      layers.push(result);
      steps.push({ tool, step, layer: layer.id, status: "completed" });
      return layer;
    };

    const depressionTool = method === "breach" ? "wasm_breach_depressions_least_cost" : "wasm_fill_depressions";
    const depression = await context.runTool(depressionTool, {
      dem: args.dem,
      output_name: `${base}_洼地处理`,
    });
    const conditioned = record(depressionTool, "洼地处理", depression);

    const pointerResult = await context.runTool("wasm_d8_pointer", {
      dem: conditioned.id,
      output_name: `${base}_D8流向`,
    });
    const pointer = record("wasm_d8_pointer", "D8 流向", pointerResult);

    const accumulationResult = await context.runTool("wasm_d8_flow_accum", {
      input: pointer.id,
      input_is_pointer: true,
      out_type: "cells",
      output_name: `${base}_汇流累积`,
    });
    const accumulation = record("wasm_d8_flow_accum", "汇流累积", accumulationResult);

    if (args.extract_streams !== false) {
      const streamsResult = await context.runTool("wasm_extract_streams", {
        flow_accumulation: accumulation.id,
        threshold,
        output_name: `${base}_河网`,
      });
      record("wasm_extract_streams", "河网提取", streamsResult);
    }

    if (args.pour_points) {
      let pourPoints = args.pour_points;
      if (snapDistance !== undefined) {
        const snapped = await context.runTool("wasm_snap_pour_points", {
          flow_accum: accumulation.id,
          pour_pts: args.pour_points,
          snap_dist: snapDistance,
          output_name: `${base}_吸附汇水点`,
        });
        pourPoints = layerOf(snapped, "汇水点吸附").id;
        tools.push("wasm_snap_pour_points");
        steps.push({ tool: "wasm_snap_pour_points", step: "汇水点吸附", layer: pourPoints, status: "completed" });
        layers.push(snapped);
      }
      const watershedResult = await context.runTool("wasm_watershed", {
        d8_pntr: pointer.id,
        pour_pts: pourPoints,
        output_name: `${base}_流域`,
      });
      record("wasm_watershed", "流域划分", watershedResult);
    }

    return {
      ok: true,
      plugin: "hydrology-flow",
      model: "dem_fill_d8",
      depression_method: method,
      stream_threshold: threshold,
      layers,
      tools,
      steps,
      message: `水文链已完成，共执行 ${tools.length} 个 GeoLibre WASM 工具。中间栅格均保留在工作区。`,
      limitations: "当前链使用单流向 D8，不进行降雨/融雪汇流或水流路径的时间模拟。未提供汇水点时不划分流域；河网阈值需按 DEM 分辨率与区域校准。无数据区域不会补造。",
    };
  },
};

const registry = new Map<string, ExtensionManifest>();

export function registerExtension(manifest: ExtensionManifest) {
  if (registry.has(manifest.id)) throw new Error(`插件已注册：${manifest.id}`);
  if (new Set(manifest.tools.map(tool => tool.name)).size !== manifest.tools.length) throw new Error(`插件 ${manifest.id} 包含重复工具名。`);
  registry.set(manifest.id, manifest);
}

registerExtension(linkageMapper);
registerExtension(whiteboxExtra);
registerExtension(hydrologyFlow);

export const extensionRegistry = registry;
export const pluginToolSchemas = [...registry.values()].flatMap(manifest => manifest.tools);
export const pluginToolNames = new Set(pluginToolSchemas.map(tool => tool.name));

export async function runPluginTool(toolName: string, args: Record<string, unknown>, context?: ExtensionRunContext) {
  const manifest = [...registry.values()].find(item => item.tools.some(tool => tool.name === toolName));
  if (!manifest?.run) throw new Error(`插件工具尚未提供执行入口：${toolName}`);
  if (!context) throw new Error(`插件工具缺少浏览器执行上下文：${toolName}`);
  return manifest.run(toolName, args, context);
}
