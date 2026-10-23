import type { CatalogTool } from "./catalog-schema";
import { zhTool, zhToolL1, zhToolL2 } from "../i18n/tools";

const SEARCHABLE_PREFIXES = ["wasm_", "gee_"];

/** Common user phrasing that differs from the upstream Chinese tool name. */
const TOOL_ALIASES: Record<string, string[]> = {
  boundary_clean: ["边界清理", "分类边界清理", "平滑分类栅格"],
  buffer_raster: ["栅格缓冲", "像元缓冲", "栅格距离缓冲"],
  contours_from_raster: ["等值线", "等高线", "contour"],
  create_colour_composite: ["色彩合成", "彩色合成", "RGB 合成", "真彩色"],
  cost_distance: ["成本距离", "阻力距离", "累积成本"],
  cost_allocation: ["成本分配", "成本区域分配", "最低成本分配"],
  cost_pathway: ["成本路径", "最小成本路径"],
  centroid_vector: ["质心", "矢量质心", "几何中心", "中心点"],
  concave_hull: ["凹包", "凹壳", "concave hull", "贴合边界"],
  densify_features: ["要素加密", "几何加密", "折点加密", "densify"],
  euclidean_allocation: ["欧氏分配", "欧几里得分配", "最近源分配", "欧氏分配栅格"],
  euclidean_distance: ["欧氏距离", "直线距离"],
  extract_raster_values_at_points: ["点提取", "提取点值", "点采样", "栅格点值"],
  deviation_from_mean_elevation: ["地形 z 分数", "TPI", "局部高程偏差"],
  idw_interpolation: ["IDW", "IDW 插值", "反距离权重", "反距离插值"],
  line_density: ["线密度", "线要素密度", "道路密度", "河流密度", "line density"],
  majority_filter: ["多数滤波", "众数滤波", "分类清理", "类别平滑"],
  median_filter: ["中值滤波", "中位数滤波", "中值平滑", "椒盐噪声"],
  merge_vectors: ["合并矢量", "矢量合并", "合并图层"],
  mosaic: ["栅格镶嵌", "影像镶嵌", "拼接"],
  network_service_area: ["服务区", "服务区分析", "可达范围", "网络可达范围"],
  generate_near_table: ["邻近表", "生成邻近表", "最近邻表", "近邻表", "near table"],
  raster_to_vector_lines: ["栅格转矢量", "栅格矢量化", "栅格转线"],
  raster_to_vector_points: ["栅格转矢量", "栅格矢量化", "栅格转点"],
  raster_to_vector_polygons: ["栅格转矢量", "栅格矢量化", "栅格转面"],
  feature_to_line: ["要素转线", "线要素化", "面边界转线", "平面化"],
  smooth_vectors: ["平滑矢量", "矢量平滑", "几何平滑"],
  snap_points_to_network: ["点捕捉网络", "捕捉到网络", "吸附到网络"],
  sobel_filter: ["边缘检测", "边缘提取"],
  split_lines_at_intersections: ["线交点分割", "交点打断", "网络打断"],
  tin_interpolation: ["TIN", "TIN 插值", "三角网插值", "三角网"],
  vector_points_to_raster: ["点转栅格", "矢量点转栅格", "点栅格化"],
  vector_polygons_to_raster: ["面转栅格", "矢量面转栅格", "面栅格化"],
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
