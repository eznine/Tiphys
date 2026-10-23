import type { ExtensionManifest } from "./types";

const EXTENSION_CATEGORY = "扩展";
const EXTENSION_SUBCATEGORY = "插件";

const linkageMapper: ExtensionManifest = {
  id: "linkage-mapper",
  name: "Linkage Mapper",
  version: "0.1.0-stub",
  tools: [{
    name: "linkage_mapper_corridor",
    label: "生态廊道分析（占位）",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "LinkageMapper 风格生态连通性插件占位。接口已预留，当前未包含阻力面建模、廊道提取与夹点分析。",
    parameters: {
      type: "object",
      properties: {
        layer: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "核心生境或源地图层" },
        resistance_field: { type: "string", description: "可选阻力字段" },
        output_name: { type: "string", description: "结果图层名称" },
      },
      required: ["layer"],
      additionalProperties: false,
    },
    annotations: {},
  }],
  run: () => ({
    ok: false,
    available: false,
    plugin: "linkage-mapper",
    message: "插件接口已就绪，但 LinkageMapper 廊道模型尚未打包。当前可用内置缓冲区、距离与叠加工具准备源地和阻力数据。",
    alternatives: ["buffer", "select_by_location", "spatial_join", "wasm_cost_distance"],
  }),
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

export async function runPluginTool(toolName: string, args: Record<string, unknown>) {
  const manifest = [...registry.values()].find(item => item.tools.some(tool => tool.name === toolName));
  if (!manifest?.run) throw new Error(`插件工具尚未提供执行入口：${toolName}`);
  return manifest.run(toolName, args);
}
