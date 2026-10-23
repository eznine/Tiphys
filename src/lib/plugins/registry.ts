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

const registry = new Map<string, ExtensionManifest>();

export function registerExtension(manifest: ExtensionManifest) {
  if (registry.has(manifest.id)) throw new Error(`插件已注册：${manifest.id}`);
  if (new Set(manifest.tools.map(tool => tool.name)).size !== manifest.tools.length) throw new Error(`插件 ${manifest.id} 包含重复工具名。`);
  registry.set(manifest.id, manifest);
}

registerExtension(linkageMapper);
registerExtension(whiteboxExtra);

export const extensionRegistry = registry;
export const pluginToolSchemas = [...registry.values()].flatMap(manifest => manifest.tools);
export const pluginToolNames = new Set(pluginToolSchemas.map(tool => tool.name));

export async function runPluginTool(toolName: string, args: Record<string, unknown>, context?: ExtensionRunContext) {
  const manifest = [...registry.values()].find(item => item.tools.some(tool => tool.name === toolName));
  if (!manifest?.run) throw new Error(`插件工具尚未提供执行入口：${toolName}`);
  if (!context) throw new Error(`插件工具缺少浏览器执行上下文：${toolName}`);
  return manifest.run(toolName, args, context);
}
