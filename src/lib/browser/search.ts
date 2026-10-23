import type { CatalogTool } from "./catalog-schema";
import { zhTool, zhToolL1, zhToolL2 } from "../i18n/tools";

const SEARCHABLE_PREFIXES = ["wasm_", "gee_"];

/** Common user phrasing that differs from the upstream Chinese tool name. */
const TOOL_ALIASES: Record<string, string[]> = {
  aggregate_points: ["点聚合", "聚合点", "点聚类", "聚集点"],
  aggregate_polygons: ["面聚合", "聚合面", "聚合多边形", "合并邻近面", "形态学闭运算"],
  basins: ["集水区", "流域盆地", "流域划分", "D8 流域", "盆地划分"],
  bilateral_filter: ["双边滤波", "保边平滑", "边缘保持平滑", "bilateral"],
  boundary_clean: ["边界清理", "分类边界清理", "平滑分类栅格"],
  buffer_raster: ["栅格缓冲", "像元缓冲", "栅格距离缓冲"],
  closing: ["闭运算", "形态学闭运算", "填充孔洞", "先膨胀后腐蚀"],
  clump: ["斑块", "斑块聚类", "栅格聚类", "连通斑块", "斑块标识"],
  contours_from_raster: ["等值线", "等高线", "contour"],
  create_colour_composite: ["色彩合成", "彩色合成", "RGB 合成", "真彩色"],
  cost_distance: ["成本距离", "阻力距离", "累积成本"],
  cost_allocation: ["成本分配", "成本区域分配", "最低成本分配"],
  cost_connectivity: ["成本连通", "成本连通性", "最小成本连通", "区域连通网络"],
  cost_pathway: ["成本路径", "最小成本路径"],
  centroid_vector: ["质心", "矢量质心", "几何中心", "中心点"],
  concave_hull: ["凹包", "凹壳", "concave hull", "贴合边界"],
  densify_features: ["要素加密", "几何加密", "折点加密", "densify"],
  difference: ["差集", "矢量差集", "面差集", "叠加擦除", "difference"],
  edge_preserving_mean_filter: ["保边均值", "边缘保持均值", "保边均值滤波", "边缘保持滤波"],
  euclidean_allocation: ["欧氏分配", "欧几里得分配", "最近源分配", "欧氏分配栅格"],
  euclidean_direction: ["欧氏方向", "欧几里得方向", "最近源方向", "方位角栅格"],
  euclidean_distance: ["欧氏距离", "直线距离"],
  eliminate_polygon_part: ["消除碎面", "消除面部件", "碎面", "小面", "孔洞消除"],
  extract_raster_values_at_points: ["点提取", "提取点值", "点采样", "栅格点值"],
  empirical_bayesian_kriging: ["EBK", "EBK 克里金", "经验贝叶斯克里金", "经验贝叶斯克里金法", "克里金"],
  expand_shrink: ["膨胀收缩", "扩展收缩", "膨胀", "收缩", "类别扩张", "类别收缩"],
  deviation_from_mean_elevation: ["地形 z 分数", "TPI", "局部高程偏差"],
  idw_interpolation: ["IDW", "IDW 插值", "反距离权重", "反距离插值"],
  identity: ["同一性", "恒等叠加", "同一性叠加", "identity"],
  gaussian_filter: ["高斯滤波", "高斯平滑", "高斯模糊"],
  line_density: ["线密度", "线要素密度", "道路密度", "河流密度", "line density"],
  majority_filter: ["多数滤波", "众数滤波", "分类清理", "类别平滑"],
  median_filter: ["中值滤波", "中位数滤波", "中值平滑", "椒盐噪声"],
  merge_vectors: ["合并矢量", "矢量合并", "合并图层"],
  minimum_bounding_box: ["最小外包框", "最小外接矩形", "最小包围盒", "最小外包矩形"],
  minimum_bounding_circle: ["最小外包圆", "最小外接圆", "最小包围圆", "最小覆盖圆"],
  mosaic: ["栅格镶嵌", "影像镶嵌", "拼接"],
  multipart_to_singlepart: ["多部件", "多部件转单部件", "拆分多部件", "单部件"],
  network_service_area: ["服务区", "服务区分析", "可达范围", "网络可达范围"],
  nibble: ["邻域填充", "蚕食", "栅格填充", "掩膜填充"],
  opening: ["开运算", "形态学开运算", "去除小对象", "先腐蚀后膨胀"],
  ordinary_kriging: ["普通克里金", "普通克里金插值", "OK 克里金"],
  points_to_line: ["点转线", "点生成线", "点连成线", "按字段连线"],
  relative_topographic_position: ["地形位置", "相对地形位置", "RTP", "地形位置指数"],
  percentile_filter: ["百分位滤波", "百分位", "局部排名"],
  generate_near_table: ["邻近表", "生成邻近表", "最近邻表", "近邻表", "near table"],
  raster_to_vector_lines: ["栅格转矢量", "栅格矢量化", "栅格转线"],
  raster_to_vector_points: ["栅格转矢量", "栅格矢量化", "栅格转点"],
  raster_to_vector_polygons: ["栅格转矢量", "栅格矢量化", "栅格转面"],
  ruggedness_index: ["崎岖度", "地形崎岖度", "地形粗糙度", "TRI", "Riley 崎岖度"],
  feature_to_line: ["要素转线", "线要素化", "面边界转线", "平面化"],
  feature_vertices_to_points: ["要素转点", "折点转点", "要素折点转点", "顶点转点", "要素顶点"],
  smooth_vectors: ["平滑矢量", "矢量平滑", "几何平滑"],
  sieve: ["筛除", "筛除斑块", "斑块筛除", "去除小斑块", "最小斑块"],
  snap_points_to_network: ["点捕捉网络", "捕捉到网络", "吸附到网络"],
  snap_pour_points: ["捕捉倒口", "捕捉倾泻点", "汇水点吸附", "倾泻点捕捉", "pour point"],
  sobel_filter: ["边缘检测", "边缘提取"],
  split_lines_at_intersections: ["线交点分割", "交点打断", "网络打断"],
  symmetrical_difference: ["对称差", "对称差分", "异或叠加"],
  tin_interpolation: ["TIN", "TIN 插值", "三角网插值", "三角网"],
  trend_surface: ["趋势面", "趋势面拟合", "多项式趋势面", "trend surface"],
  vector_points_to_raster: ["点转栅格", "矢量点转栅格", "点栅格化"],
  vector_polygons_to_raster: ["面转栅格", "矢量面转栅格", "面栅格化"],
  wetness_index: ["湿润指数", "地形湿润指数", "TWI", "湿度指数"],
};

function aliasesFor(toolName: string): string[] {
  return TOOL_ALIASES[toolName.startsWith("wasm_") ? toolName.slice(5) : toolName] ?? [];
}

export function isBrowserSearchable(name: string, tool?: CatalogTool): boolean {
  return SEARCHABLE_PREFIXES.some(prefix => name.startsWith(prefix)) || tool?.category === "扩展";
}

function normalized(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Score one catalog tool against a query. Names and Chinese labels are strongest;
 * taxonomy and descriptions help broad requests such as "网络分析" or "栅格叠加".
 */
export function scoreBrowserTool(tool: CatalogTool, query: string): number {
  const zh = zhTool(tool.name);
  const name = normalized(tool.name);
  const label = normalized(tool.label);
  const zhName = normalized(zh?.name);
  const category = normalized(tool.category);
  const zhCategory = normalized(zhToolL1(tool));
  const subcategory = normalized(tool.subcategory);
  const zhSubcategory = normalized(zhToolL2(tool));
  const description = normalized(`${tool.description ?? ""} ${zh?.desc ?? ""}`);
  const aliases = aliasesFor(tool.name).map(normalized).filter(Boolean);
  const phrase = normalized(query);
  if (!phrase) return 0;
  const tokens = [...new Set(phrase.split(" ").filter(Boolean))];
  let score = 0;
  let matchedTokens = 0;

  if (name === phrase) score += 160;
  else if (name.includes(phrase)) score += 80;
  if (zhName === phrase) score += 150;
  else if (zhName.includes(phrase)) score += 75;
  if (label === phrase) score += 140;
  else if (label.includes(phrase)) score += 65;
  if (aliases.some(alias => alias === phrase)) score += 150;
  else if (aliases.some(alias => alias.includes(phrase))) score += 60;
  if (zhCategory === phrase) score += 55;
  else if (zhCategory.includes(phrase)) score += 28;
  if (zhSubcategory === phrase) score += 65;
  else if (zhSubcategory.includes(phrase)) score += 34;
  if (category === phrase || subcategory === phrase) score += 30;

  for (const token of tokens) {
    let tokenScore = 0;
    if (name === token || zhName === token) tokenScore += 80;
    else if (name.startsWith(token) || zhName.startsWith(token)) tokenScore += 45;
    else if (name.includes(token) || zhName.includes(token) || label.includes(token)) tokenScore += 30;
    if (aliases.some(alias => alias === token)) tokenScore += 70;
    else if (aliases.some(alias => alias.includes(token))) tokenScore += 35;
    if (zhCategory === token || zhSubcategory === token || category === token || subcategory === token) tokenScore += 24;
    else if (zhCategory.includes(token) || zhSubcategory.includes(token) || category.includes(token) || subcategory.includes(token)) tokenScore += 13;
    if (description.includes(token)) tokenScore += 7;
    if (tokenScore) { matchedTokens++; score += tokenScore; }
  }
  return matchedTokens === tokens.length ? score : 0;
}

export function searchBrowserTools(
  tools: CatalogTool[],
  query: string,
  options: { limit?: number; searchable?: (name: string, tool?: CatalogTool) => boolean } = {},
): CatalogTool[] {
  const limit = options.limit ?? 8;
  const searchable = options.searchable ?? isBrowserSearchable;
  return tools
    .filter(tool => searchable(tool.name, tool))
    .map(tool => ({ tool, score: scoreBrowserTool(tool, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(item => item.tool);
}
