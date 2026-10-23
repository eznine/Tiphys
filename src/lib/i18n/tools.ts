/** Chinese localization for the tool catalog. Tool texts come from the
 * reviewed dictionary merged by scripts/import-browser-engine.mjs; the Python
 * engine's own tools and parameter labels are curated here. */
import zhDict from "./tool-zh.json";

export type ZhEntry = { name: string; desc: string };

const dict = zhDict as Record<string, ZhEntry>;

/** Look up a Chinese name/description for a tool. `wasm_` prefixed catalog
 * entries use their underlying GeoLibre tool id as the dictionary key. */
export function zhTool(toolName: string): ZhEntry | undefined {
  return dict[toolName.startsWith("wasm_") ? toolName.slice(5) : toolName];
}

export const CATEGORY_ZH: Record<string, string> = {
  Vector: "矢量",
  Raster: "栅格",
  Terrain: "地形",
  Hydrology: "水文",
  "Remote Sensing": "遥感",
  Conversion: "转换",
  Projection: "投影",
  LiDAR: "激光雷达",
  GEE: "GEE",
};

const PYTHON_L1: Record<string, string> = {
  "数据管理": "数据管理",
  "查询与选择": "查询",
  "地图与显示": "图层",
  "邻近分析": "矢量",
  "叠加分析": "矢量",
  "几何处理": "矢量",
  "GEE": "GEE",
  "其他工具": "其他工具",
};

const PYTHON_L2: Record<string, string> = {
  "数据管理": "数据与图层",
  "查询与选择": "选择与统计",
  "地图与显示": "显示与属性",
  "邻近分析": "邻近分析",
  "叠加分析": "叠加分析",
  "几何处理": "几何处理",
  "GEE": "接入准备",
  "其他工具": "其他",
};

/** All 48 subcategories currently shipped by the bundled WASM catalog. */
const SUBCATEGORY_ZH: Record<string, string> = {
  // Shared / legacy taxonomy labels
  "Analysis": "分析", "Conversion": "转换", "Data Management": "数据管理",
  "Extraction": "提取", "Features": "要素", "General": "常规",
  "Geometry Processing": "几何处理", "Interpolation": "插值", "Overlay": "叠加",
  "Proximity": "邻近", "Statistics": "统计", "Surface Creation": "表面生成",
  "Terrain Analysis": "地形分析", "Hydrological Analysis": "水文分析",
  "Atmospheric Correction": "大气校正", "Classification": "分类",
  "Change Detection": "变化检测", "Indices": "指数", "Filtering": "滤波",
  "Mosaicking": "镶嵌", "Pan-sharpening": "全色锐化", "Radiometric": "辐射校正",
  "Morphology": "形态学", "Distance": "距离", "Partitioning": "分区",
  "Resampling": "重采样", "Attribute Processing": "属性处理",
  "Stream Network Analysis": "河网分析", "Point Cloud": "点云",
  "Coordinate Systems": "坐标系", "Metadata": "元数据", "Sampling": "采样",
  "Machine Learning": "机器学习", "Segmentation": "分割", "Object-based": "面向对象",

  // Raster (9)
  "Overlay Math": "叠加运算", "Local Neighborhood": "邻域分析",
  "Reclassify & Mask": "重分类与掩膜", "Distance & Cost": "距离与成本",
  "Zonal": "分区统计", "Multidimensional": "多维分析", "Spatial Statistics": "空间统计",

  // Terrain (7)
  "Derivatives": "地形导数", "Visibility": "可见性分析",
  "Roughness & Texture": "粗糙度与纹理", "Landform Indices": "地貌指数",
  "Multiscale Signatures": "多尺度特征", "Workflow Products": "流程化产品",

  // Remote Sensing (10)
  "Filters": "影像滤波", "SAR": "SAR 雷达", "Enhancement & Contrast": "增强与对比度",
  "Radiometric Correction": "辐射校正", "OBIA": "面向对象影像分析",
  "Edge & Feature Detection": "边缘与特征检测", "Spectral Analytics": "光谱分析",
  "Thermal & Emissivity": "热红外与发射率",

  // Vector (12)
  "Attribute Analysis": "属性分析", "3D Features": "三维要素",
  "Cartography & Generalization": "制图与综合", "Overlay Analysis": "叠加分析",
  "Network Analysis": "网络分析", "Space-Time Analysis": "时空分析",
  "Shape Metrics": "形状指标", "Sampling & Gridding": "采样与格网",
  "Linear Referencing": "线性参考", "Online Data": "在线数据",

  // Conversion (4)
  "Vector & Table I/O": "矢量与表格读写", "Raster/Vector Conversion": "栅格矢量转换",
  "Geometry & Topology": "几何与拓扑", "Tiles & Web Formats": "瓦片与 Web 格式",

  // Hydrology (7)
  "Streams - Network Extraction": "河网提取", "Flow Routing": "汇流路径",
  "Watersheds & Basins": "流域与盆地", "Depressions & Storage": "洼地与蓄水",
  "Hydrologic Indices": "水文指数", "Streams - Longitudinal Analysis": "河流纵向分析",
  "Streams - Ordering Metrics": "河流分级指标",

  // Projection (1)
  "Georeferencing": "地理配准",
};

/** Stable toolbox L1 order; native categories follow the ArcGIS/QGIS grouping. */
export function zhToolL1(tool: { category?: string }): string {
  const category = tool.category?.trim();
  if (!category) return "其他工具";
  return CATEGORY_ZH[category] ?? PYTHON_L1[category] ?? category;
}

/** L2 group inside an L1 toolbox folder. */
export function zhToolL2(tool: { category?: string; subcategory?: string }): string {
  if (tool.subcategory) return SUBCATEGORY_ZH[tool.subcategory] ?? tool.subcategory;
  return PYTHON_L2[tool.category ?? ""] ?? "常规";
}

/** Group label for a catalog tool, e.g. "栅格 · 地形导数". */
export function zhCategory(tool: { category?: string; subcategory?: string }): string {
  const category = zhToolL1(tool);
  const sub = zhToolL2(tool);
  return sub && sub !== category ? `${category} · ${sub}` : category;
}

export function zhSubcategory(sub: string): string {
  return SUBCATEGORY_ZH[sub] ?? sub;
}

/** Chinese labels for common tool parameter names. */
export const PARAM_ZH: Record<string, string> = {
  input: "输入", input_layer: "输入图层", output: "输出名称", output_name: "输出名称",
  mask: "掩膜", mask_layer: "掩膜图层", features: "要素", zone: "分区", zones: "分区",
  distance: "距离", tolerance: "容差", cell_size: "像元大小", cellsize: "像元大小",
  field: "字段", fields: "字段", by_field: "分组字段", group_field: "分组字段",
  value: "值", values: "值", units: "单位", epsg: "EPSG 编号", target_crs: "目标坐标系",
  source_crs: "源坐标系", name: "名称", path: "路径", overwrite: "覆盖已有文件",
  dissolve: "融合结果", predicate: "空间关系", op: "比较方式", fmt: "格式",
  method: "方法", resampling: "重采样方式", band: "波段", bands: "波段",
  stat_type: "统计类型", statistics: "统计类型", radius: "半径", size: "大小",
  width: "宽度", height: "高度", angle: "角度", scale: "比例", exponent: "指数",
  threshold: "阈值", weight: "权重", power: "幂", iterations: "迭代次数",
  color: "颜色", palette: "色带", opacity: "不透明度", nodata: "NoData 值",
  filter_size: "滤波核大小", sigma: "Sigma 参数", kernel: "卷积核", option: "选项",
  points: "点", polygons: "面", lines: "线", table: "表格", layer: "图层",
  min: "最小值", max: "最大值", limit: "数量上限", sort: "排序", ascending: "升序",
  format: "格式", prefix: "前缀", suffix: "后缀", level: "级别", factor: "系数",
  azimuth: "方位角", altitude: "高度角", direction: "方向", mode: "模式",
  type: "类型", category: "类别", class: "类别", label: "标注", resolution: "分辨率",
  extent: "范围", bbox: "范围", crs: "坐标系", vertices: "顶点数", precision: "精度",
  multiplier: "倍率", offset: "偏移", replacement: "替换值", constant: "常量",
  variable: "变量", expression: "表达式", position: "位置", index: "索引",
};

/** Chinese label for a parameter, falling back to the raw name. */
export function zhParam(name: string): string {
  return PARAM_ZH[name] ?? name;
}
