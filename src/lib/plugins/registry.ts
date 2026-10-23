import type { FeatureCollection } from "geojson";
import type { ExtensionManifest, ExtensionRunContext } from "./types";

const EXTENSION_CATEGORY = "扩展";
const EXTENSION_SUBCATEGORY = "插件";
const WGS84_CRS = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } };

function epsgOf(crs: string | undefined): number | undefined {
  const match = /^EPSG:(\d+)$/i.exec(crs ?? "");
  return match ? Number(match[1]) : undefined;
}

type GeometryFamily = "point" | "polygon";

function geometryFamily(types: string[]): GeometryFamily | undefined {
  if (types.length && types.every(type => type === "Point" || type === "MultiPoint")) return "point";
  if (types.length && types.every(type => type === "Polygon" || type === "MultiPolygon")) return "polygon";
  return undefined;
}

function aoiCollection(bbox: number[]): FeatureCollection {
  const [west, south, east, north] = bbox;
  return {
    type: "FeatureCollection",
    crs: WGS84_CRS as any,
    features: [{
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    }],
  } as FeatureCollection;
}

const linkageMapper: ExtensionManifest = {
  id: "linkage-mapper",
  name: "Linkage Mapper",
  version: "0.2.0",
  tools: [{
    name: "linkage_mapper_corridor",
    label: "生态廊道分析",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "基于核心生境多边形与阻力栅格，构建最小成本廊道（走廊）网络并输出廊道面与中心线；内部串联多边形栅格化与最优廊道连接工具。",
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

const leastCostPath: ExtensionManifest = {
  id: "least-cost-path",
  name: "Least-Cost Path Pipeline",
  version: "0.1.0",
  tools: [{
    name: "least_cost_path_pipeline",
    label: "最小成本路径",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "基于阻力栅格连接源与目的地点/面，输出真实的最小成本路径折线或廊道（走廊）中心线，并保留从源端出发的累积成本距离表面。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "源端点点/多点或面/多面图层" },
        destination: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "目的地点/多点或面/多面图层，几何类型需与源图层一致" },
        resistance: { type: "string", "x-layer": true, "x-layer-kind": "raster", description: "阻力/成本栅格；NoData 表示不可通行" },
        barriers: { type: "string", "x-layer": true, "x-layer-kind": "vector", description: "可选障碍面图层；仅面模式直接传给廊道工具" },
        connections: { type: "string", enum: ["mst", "all_neighbors"], default: "mst", description: "最小生成树或所有相邻区域对连接" },
        corridor_width: { type: "number", description: "面模式的廊道宽度（阻力栅格地图单位）；留空按 10 个像元" },
        include_cost_surface: { type: "boolean", default: true, description: "是否保留从源端出发的累积成本距离栅格" },
        output_name: { type: "string", description: "路径与成本结果名称前缀" },
      },
      required: ["source", "destination", "resistance"],
      additionalProperties: false,
    },
    annotations: {},
  }],
  run: async (toolName, args, context) => {
    if (toolName !== "least_cost_path_pipeline") throw new Error(`未知最小成本路径工具：${toolName}`);
    const width = args.corridor_width == null || args.corridor_width === "" ? undefined : Number(args.corridor_width);
    if (width !== undefined && (!Number.isFinite(width) || width <= 0)) throw new Error("廊道宽度必须为正数。");
    const connections = args.connections === "all_neighbors" ? "all_neighbors" : "mst";
    const includeCostSurface = args.include_cost_surface !== false;
    const base = String(args.output_name || "最小成本路径");
    const [source, destination, resistance] = await Promise.all([
      context.inspectLayer(String(args.source)),
      context.inspectLayer(String(args.destination)),
      context.inspectLayer(String(args.resistance)),
    ]);
    if (source.kind !== "vector" || destination.kind !== "vector") throw new Error("源和目的地必须是矢量点或面图层。");
    if (resistance.kind !== "raster") throw new Error("resistance 必须是阻力栅格。");
    const sourceFamily = geometryFamily(source.geometry_types);
    const destinationFamily = geometryFamily(destination.geometry_types);
    if (!sourceFamily || !destinationFamily) throw new Error("最小成本路径仅支持点/多点或面/多面图层。");
    if (sourceFamily !== destinationFamily) throw new Error("源与目的地的几何类型必须一致（同为点或同为面）。");
    const rasterEpsg = epsgOf(resistance.crs);
    if (!rasterEpsg) throw new Error("阻力栅格必须具有 EPSG 坐标系，才能对齐端点与成本网格。");
    if (source.feature_count < 1 || destination.feature_count < 1) throw new Error("源与目的地图层都必须至少包含一个要素。");

    const tools: string[] = [];
    const steps: Array<Record<string, unknown>> = [];
    const layers: Array<Record<string, any>> = [];
    const layerOf = (result: Record<string, any>, label: string) => {
      const layer = result.layer ?? result.layers?.[0]?.layer;
      if (!layer) throw new Error(`${label}未生成预期图层。`);
      return layer;
    };
    const record = (tool: string, step: string, result: Record<string, any>) => {
      const layer = layerOf(result, step);
      tools.push(tool);
      layers.push(result);
      steps.push({ tool, step, layer: layer.id, status: "completed" });
      return layer;
    };
    const dropIntermediate = async (layerId: string) => {
      try { await context.runTool("remove_layer", { layer: layerId }); } catch { /* Intermediate cleanup must not hide a completed result. */ }
    };
    const aligned = async (info: typeof source, label: string) => {
      const reprojected = epsgOf(info.crs) !== rasterEpsg;
      const result = await context.reprojectLayer(info.id, rasterEpsg, `${base}_${label}_${resistance.crs.replace(":", "")}`);
      const layer = layerOf(result, `${label}重投影`);
      if (reprojected) {
        tools.push("wasm_reproject_vector");
        steps.push({ tool: "wasm_reproject_vector", step: `${label}重投影`, layer: layer.id, status: "completed" });
      }
      return { layer, result, reprojected };
    };

    const sourceAligned = await aligned(source, "源端点");
    const destinationAligned = source.id === destination.id ? sourceAligned : await aligned(destination, "目的地端点");
    const sameEndpointLayer = sourceAligned.layer.id === destinationAligned.layer.id;
    let endpointsResult: Record<string, any>;
    let endpointLayer: Record<string, any>;
    if (sameEndpointLayer) {
      endpointsResult = sourceAligned.result;
      endpointLayer = sourceAligned.layer;
      if (sourceAligned.reprojected) layers.push(endpointsResult);
      steps.push({ tool: "source_layer", step: "端点准备", layer: endpointLayer.id, status: "completed" });
    } else {
      endpointsResult = await context.mergeLayers([sourceAligned.layer.id, destinationAligned.layer.id], `${base}_端点`);
      endpointLayer = layerOf(endpointsResult, "端点合并");
      tools.push("merge_vectors");
      layers.push(endpointsResult);
      steps.push({ tool: "merge_vectors", step: "端点合并", layer: endpointLayer.id, status: "completed" });
      if (destinationAligned.reprojected) await dropIntermediate(destinationAligned.layer.id);
    }
    if (endpointLayer.feature_count < 2) throw new Error("最小成本路径至少需要两个端点要素。");

    const rasterizeTool = sourceFamily === "point" ? "wasm_vector_points_to_raster" : "wasm_vector_polygons_to_raster";
    const sourceRaster = record(rasterizeTool, "源栅格化", await context.runTool(rasterizeTool, {
      input: sourceAligned.layer.id,
      ...(sourceFamily === "point" ? { assign: "num" } : {}),
      base: resistance.id,
      zero_background: true,
      output_name: `${base}_源栅格`,
    }));
    if (sourceAligned.reprojected && !sameEndpointLayer) await dropIntermediate(sourceAligned.layer.id);

    let costSurface: Record<string, any> | null = null;
    if (includeCostSurface) {
      costSurface = record("wasm_cost_distance", "累积成本距离", await context.runTool("wasm_cost_distance", {
        source: sourceRaster.id,
        cost: resistance.id,
        output_name: `${base}_成本距离`,
      }));
    }

    const pathTool = sourceFamily === "point" ? "wasm_cost_connectivity" : "wasm_optimal_corridor_connections";
    const pathResult = await context.runTool(pathTool, sourceFamily === "point" ? {
      sources: endpointLayer.id,
      cost: resistance.id,
      connections,
      output_name: base,
    } : {
      input: endpointLayer.id,
      cost_raster: resistance.id,
      ...(args.barriers ? { barriers: args.barriers } : {}),
      ...(width !== undefined ? { corridor_width: width } : {}),
      neighbor_option: connections === "all_neighbors" ? "all_pairs" : "spanning_tree",
      output_name: base,
    });
    const pathLayers = (pathResult.layers ?? (pathResult.layer ? [{ layer: pathResult.layer }] : [])).map((item: any) => item.layer).filter(Boolean);
    if (!pathLayers.length) throw new Error("最小成本路径未生成矢量结果。");
    tools.push(pathTool);
    layers.push(pathResult);
    steps.push({ tool: pathTool, step: sourceFamily === "point" ? "路径追踪" : "廊道追踪", layer: pathLayers[0].id, status: "completed" });

    const pointLike = pathLayers.some((layer: any) => (layer.geometry_types ?? []).some((type: string) => type === "LineString" || type === "MultiLineString"));
    if (!pointLike) throw new Error("路径工具没有返回折线结果，未声称已生成路径。");
    return {
      ok: true,
      plugin: "least-cost-path",
      model: sourceFamily === "point" ? "cost_connectivity" : "optimal_corridor_connections",
      geometry_family: sourceFamily,
      connections,
      layers,
      tools,
      steps,
      endpoints: endpointLayer,
      source_raster: sourceRaster,
      cost_surface: costSurface,
      path_layers: pathLayers,
      message: sourceFamily === "point"
        ? "最小成本路径已完成：端点按阻力栅格连接，并输出真实折线结果。"
        : "最小成本廊道已完成：输出来源/目的地区域之间的廊道面与中心线。",
      limitations: [
        "阻力栅格中的 NoData 视为不可通行；无法连通的端点不会被补造路径。",
        sourceFamily === "point"
          ? "点模式在多于两个端点时按最小生成树或相邻区域网络连接；单个源加单个目的地时即为一条路径，不表达方向、转弯成本或时间。"
          : "面模式连接源与目的地区域网络，中心线与廊道面不表达特定的源→目的地方向。",
        "成本距离表面从源端出发，表示累积通行成本，不等同于双向成本或通行时间。",
        includeCostSurface ? "" : "本次未保留累积成本表面。",
      ].filter(Boolean).join(""),
    };
  },
};

const aoiClip: ExtensionManifest = {
  id: "aoi-clip",
  name: "AOI Clip Helper",
  version: "0.1.0",
  tools: [{
    name: "clip_layers_to_aoi",
    label: "按 AOI 裁剪",
    category: EXTENSION_CATEGORY,
    subcategory: EXTENSION_SUBCATEGORY,
    description: "从地图 AOI 的 WGS84 边界创建临时 AOI 面，按目标图层坐标系裁剪当前矢量或栅格图层；临时 AOI 在完成后移除。",
    parameters: {
      type: "object",
      properties: {
        layer: { type: "string", "x-layer": true, description: "要裁剪的矢量或栅格图层" },
        aoi_west: { type: "number", description: "AOI 西边界（WGS84 经度）" },
        aoi_south: { type: "number", description: "AOI 南边界（WGS84 纬度）" },
        aoi_east: { type: "number", description: "AOI 东边界（WGS84 经度）" },
        aoi_north: { type: "number", description: "AOI 北边界（WGS84 纬度）" },
        maintain_dimensions: { type: "boolean", default: false, description: "栅格裁剪时保留原栅格尺寸，仅将 AOI 外像元设为 NoData" },
        output_name: { type: "string", description: "裁剪结果图层名称" },
      },
      required: ["layer", "aoi_west", "aoi_south", "aoi_east", "aoi_north"],
      additionalProperties: false,
    },
    annotations: {},
  }],
  run: async (toolName, args, context) => {
    if (toolName !== "clip_layers_to_aoi") throw new Error(`未知 AOI 裁剪工具：${toolName}`);
    const bbox = [args.aoi_west, args.aoi_south, args.aoi_east, args.aoi_north].map(Number);
    if (!bbox.every(Number.isFinite)) throw new Error("AOI 边界必须为有效数字。");
    const [west, south, east, north] = bbox;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error("AOI 边界无效：需满足 WGS84 经纬度范围且西<东、南<北。");
    const layer = await context.inspectLayer(String(args.layer));
    if (!layer.kind || !["vector", "raster"].includes(layer.kind)) throw new Error("AOI 裁剪仅支持矢量或栅格图层。");
    const targetEpsg = epsgOf(layer.crs);
    if (!targetEpsg) throw new Error("目标图层必须具有 EPSG 坐标系，才能对齐 AOI。");
    const outputName = String(args.output_name || `${layer.name}_AOI裁剪`);
    const tools: string[] = [];
    const steps: Array<Record<string, unknown>> = [];
    const temporaryLayers = new Set<string>();
    let aoiId = "";
    let tool = "";
    try {
      const created = await context.createLayer(aoiCollection(bbox), "AOI");
      const createdLayer = created.layer ?? created.layers?.[0]?.layer;
      if (!createdLayer) throw new Error("无法创建临时 AOI 图层。");
      temporaryLayers.add(createdLayer.id);
      aoiId = createdLayer.id;
      steps.push({ tool: "browser_layer", step: "创建 AOI", layer: aoiId, status: "completed" });
      if (targetEpsg !== 4326) {
        const projected = await context.runTool("wasm_reproject_vector", {
          input: aoiId,
          epsg: targetEpsg,
          output_name: `AOI_${targetEpsg}`,
        });
        const projectedLayer = projected.layer ?? projected.layers?.[0]?.layer;
        if (!projectedLayer) throw new Error("AOI 重投影未生成图层。");
        tools.push("wasm_reproject_vector");
        steps.push({ tool: "wasm_reproject_vector", step: "AOI 重投影", layer: projectedLayer.id, status: "completed" });
        temporaryLayers.add(projectedLayer.id);
        aoiId = projectedLayer.id;
      }

      let clipped: Record<string, any>;
      if (layer.kind === "raster") {
        tool = "wasm_clip_raster_to_polygon";
        clipped = await context.runTool(tool, {
          input: layer.id,
          polygons: aoiId,
          maintain_dimensions: args.maintain_dimensions === true,
          output_name: outputName,
        });
      } else {
        const family = geometryFamily(layer.geometry_types);
        if (!family) throw new Error("AOI 裁剪当前支持点、面矢量与栅格；线及混合几何图层尚未接入。");
        tool = "clip";
        clipped = await context.runTool(tool, { layer: layer.id, mask_layer: aoiId, output_name: outputName });
      }
      const resultLayer = clipped.layer ?? clipped.layers?.[0]?.layer;
      if (!resultLayer) throw new Error("AOI 裁剪未生成结果图层。");
      tools.push(tool);
      steps.push({ tool, step: "AOI 裁剪", layer: resultLayer.id, status: "completed" });
      return {
        ok: true,
        plugin: "aoi-clip",
        aoi_bbox: bbox,
        target_epsg: targetEpsg,
        layers: [clipped],
        tools,
        steps,
        message: `已按 AOI 裁剪「${layer.name}」，临时 AOI 图层已移除。`,
        limitations: [
          "AOI 来自地图上绘制的 WGS84 矩形；运行时按目标图层 EPSG 重投影。",
          layer.kind === "raster" ? "AOI 外像元由裁剪工具设为 NoData。" : "矢量裁剪当前支持点与面；线及混合几何未接入。",
          "AOI 是轴对齐经纬度矩形，不是任意绘制多边形。",
        ].join(""),
      };
    } finally {
      for (const id of [...temporaryLayers].reverse()) {
        try { await context.runTool("remove_layer", { layer: id }); } catch { /* Best-effort cleanup after the result has been produced. */ }
      }
    }
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
registerExtension(leastCostPath);
registerExtension(aoiClip);

export const extensionRegistry = registry;
export const pluginToolSchemas = [...registry.values()].flatMap(manifest => manifest.tools);
export const pluginToolNames = new Set(pluginToolSchemas.map(tool => tool.name));

export async function runPluginTool(toolName: string, args: Record<string, unknown>, context?: ExtensionRunContext) {
  const manifest = [...registry.values()].find(item => item.tools.some(tool => tool.name === toolName));
  if (!manifest?.run) throw new Error(`插件工具尚未提供执行入口：${toolName}`);
  if (!context) throw new Error(`插件工具缺少浏览器执行上下文：${toolName}`);
  return manifest.run(toolName, args, context);
}
