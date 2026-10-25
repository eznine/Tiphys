import type { CatalogTool } from "./catalog-schema";
import { zhTool, zhToolL1, zhToolL2 } from "../i18n/tools";
import { compactTool, matchesFilter, type InputKind, type ToolCandidate, type ToolProvider } from "./candidates";
import { intentBoost } from "./intents";

const SEARCHABLE_PREFIXES = ["wasm_", "gee_"];

/** Common user phrasing that differs from the upstream Chinese tool name. */
const TOOL_ALIASES: Record<string, string[]> = {
  aggregate_points: ["点聚合", "聚合点", "点聚类", "聚集点"],
  aggregate_polygons: ["面聚合", "聚合面", "聚合多边形", "合并邻近面", "形态学闭运算"],
  average_flowpath_slope: ["平均流路坡度", "平均流径坡度", "流路坡度", "flowpath slope"],
  balance_contrast_enhancement: ["对比度均衡", "平衡对比度增强", "色彩偏差校正", "BCE"],
  basins: ["集水区", "流域", "分水岭", "流域盆地", "流域划分", "D8 流域", "盆地划分", "watershed", "basin"],
  bilateral_filter: ["双边滤波", "双边降噪", "保边平滑", "边缘保持平滑", "bilateral"],
  breach_depressions_least_cost: ["洼地修复", "最小代价填洼", "填洼", "破洼", "depression breach"],
  boundary_clean: ["边界清理", "分类边界清理", "平滑分类栅格"],
  buffer_raster: ["栅格缓冲", "像元缓冲", "栅格距离缓冲"],
  closing: ["闭运算", "形态学闭运算", "填充孔洞", "先膨胀后腐蚀"],
  clump: ["斑块", "斑块聚类", "栅格聚类", "连通斑块", "斑块标识"],
  contours_from_raster: ["等值线", "等高线", "contour"],
  create_colour_composite: ["色彩合成", "彩色合成", "RGB 合成", "真彩色"],
  cost_distance: ["成本距离", "阻力面", "阻力距离", "生态阻力", "累积成本"],
  cost_allocation: ["成本分配", "成本区域分配", "最低成本分配"],
  cost_connectivity: ["成本连通", "成本连通性", "最小成本连通", "区域连通网络"],
  cost_pathway: ["成本路径", "最小成本路径", "生态路径"],
  cost_back_link: ["成本回溯", "回溯链接", "成本方向", "回链"],
  corridor: ["廊道", "成本廊道", "最小成本廊道", "生态廊道", "阻力廊道", "生态最小成本廊道"],
  linkage_mapper_corridor: ["生态廊道", "廊道", "走廊", "连接廊道", "生境廊道"],
  clip_layers_to_aoi: ["按范围裁剪", "研究区裁剪", "AOI 裁剪", "范围裁剪"],
  hydrology_flow_pipeline: ["水文流程", "一键水文", "汇流分析流程", "水文分析流程"],
  least_cost_path_pipeline: ["成本路径流程", "最小成本路径流程", "路径规划流程"],
  whitebox_extra: ["白盒扩展", "扩展工具箱", "额外工具"],
  central_feature: ["中心要素", "中央要素", "线性方向均值"],
  change_vector_analysis: ["变化矢量", "变化矢量分析", "CVA", "变化方向"],
  centroid_vector: ["质心", "矢量质心", "几何中心", "中心点"],
  concave_hull: ["凹包", "凹壳", "concave hull", "贴合边界"],
  densify_features: ["要素加密", "几何加密", "折点加密", "densify"],
  difference: ["差集", "矢量差集", "面差集", "叠加擦除", "difference"],
  directional_distribution: ["方向分布", "标准差椭圆", "标准距离", "方向分布分析"],
  edge_preserving_mean_filter: ["保边均值", "边缘保持均值", "保边均值滤波", "边缘保持滤波"],
  euclidean_allocation: ["欧氏分配", "欧几里得分配", "最近源分配", "欧氏分配栅格"],
  euclidean_direction: ["欧氏方向", "欧几里得方向", "最近源方向", "方位角栅格"],
  euclidean_distance: ["欧氏距离", "直线距离"],
  eliminate_polygon_part: ["消除碎面", "消除面部件", "碎面", "小面", "孔洞消除"],
  extract_raster_values_at_points: ["点提取", "提取点值", "点采样", "栅格点值"],
  extract_valleys: ["谷线", "山谷线", "谷线提取", "沟谷提取", "山谷提取"],
  extend_vector_lines: ["线延伸", "延伸线", "端点延伸", "延长线"],
  empirical_bayesian_kriging: ["EBK", "EBK 克里金", "经验贝叶斯克里金", "经验贝叶斯克里金法", "克里金"],
  expand_shrink: ["膨胀收缩", "扩展收缩", "膨胀", "收缩", "类别扩张", "类别收缩"],
  deviation_from_mean_elevation: ["地形 z 分数", "TPI", "局部高程偏差"],
  idw_interpolation: ["IDW", "IDW 插值", "反距离权重", "反距离插值"],
  identity: ["同一性", "恒等叠加", "同一性叠加", "identity"],
  gaussian_filter: ["高斯滤波", "高斯平滑", "高斯模糊", "高斯降噪"],
  hack_stream_order: ["河网分级", "河流分级", "Hack", "Hack 分级", "Hack 河流分级"],
  histogram_equalization: ["直方图均衡", "直方图均衡化", "对比度均衡", "histogram equalization"],
  find_identical: ["查重", "去重", "去除重复", "重复要素", "查找相同", "删除重复"],
  focal_statistics: ["焦点统计", "邻域统计", "窗口统计", "局部统计"],
  integrate: ["整合", "顶点整合", "拓扑整合", "吸附整合"],
  is_nodata: ["无数据", "空值检测", "NoData", "NoData掩膜", "无数据掩膜", "空值掩膜", "NoData 判定"],
  lee_filter: ["Lee滤波", "Lee 滤波", "李滤波", "SAR 滤波"],
  plan_curvature: ["平面曲率", "等高线曲率", "汇流曲率", "plan curvature"],
  profile_curvature: ["剖面曲率", "坡面曲率", "顺坡曲率", "profile curvature"],
  openness: ["地形开阔度", "开阔度", "正负开阔度", "Yokoyama 开阔度", "openness"],
  feature_preserving_smoothing: ["保边平滑", "保边平滑滤波", "特征保持平滑", "DEM 保边平滑"],
  topology_validation_report: ["拓扑检查", "拓扑验证", "拓扑错误报告", "拓扑质检", "topology validation"],
  repair_geometry: ["几何修复", "修复几何", "面自相交修复", "几何有效性修复", "repair geometry"],
  line_density: ["线密度", "线要素密度", "道路密度", "河流密度", "line density"],
  local_kriging: ["局部克里金", "局部普通克里金", "局部插值", "LKO 克里金"],
  majority_filter: ["多数滤波", "众数滤波", "分类清理", "类别平滑"],
  median_filter: ["中值滤波", "中位数滤波", "中值平滑", "中值降噪", "椒盐噪声"],
  median_center: ["中位中心", "中位数中心", "空间中位中心", "几何中位中心"],
  mean_filter: ["均值滤波", "平均滤波", "均值平滑"],
  laplacian_filter: ["拉普拉斯", "拉普拉斯滤波", "拉普拉斯边缘", "边缘增强滤波", "二阶导数"],
  merge_vectors: ["合并矢量", "矢量合并", "合并图层"],
  minimum_bounding_box: ["最小外包框", "最小外接矩形", "最小包围盒", "最小外包矩形"],
  minimum_bounding_circle: ["最小外包圆", "最小外接圆", "最小包围圆", "最小覆盖圆"],
  mosaic: ["栅格镶嵌", "影像镶嵌", "拼接"],
  multipart_to_singlepart: ["多部件", "多部件转单部件", "拆分多部件", "单部件"],
  network_service_area: ["服务区", "服务区分析", "可达范围", "网络可达范围"],
  nibble: ["邻域填充", "蚕食", "栅格填充", "掩膜填充"],
  near: ["邻近", "邻近分析", "邻近距离", "最近要素", "最短距离"],
  opening: ["开运算", "形态学开运算", "去除小对象", "先腐蚀后膨胀"],
  ordinary_kriging: ["普通克里金", "普通克里金插值", "OK 克里金"],
  points_to_line: ["点转线", "点生成线", "点连成线", "按字段连线"],
  relative_topographic_position: ["地形位置", "相对地形位置", "RTP", "地形位置指数"],
  percentile_filter: ["百分位滤波", "百分位", "局部排名"],
  prewitt_filter: ["Prewitt", "Prewitt滤波", "普威特滤波"],
  path_distance: ["路径距离", "路径成本距离", "三维路径距离", "path distance"],
  generate_near_table: ["邻近表", "生成邻近表", "最近邻表", "近邻表", "near table"],
  raster_to_vector_lines: ["栅格转矢量", "栅格矢量化", "栅格转线", "转成线", "转为线"],
  raster_to_vector_points: ["栅格转矢量", "栅格矢量化", "栅格转点", "转成点", "转为点"],
  raster_to_vector_polygons: ["栅格转矢量", "栅格矢量化", "栅格转面", "转成面", "转为面", "转面", "生成面", "面图层", "栅格面化"],
  raster_streams_to_vector: ["河网转矢量", "河网矢量化", "河流栅格转线", "流域河网转矢量"],
  ruggedness_index: ["崎岖度", "地形崎岖度", "地形粗糙度", "TRI", "Riley 崎岖度"],
  feature_to_line: ["要素转线", "线要素化", "面边界转线", "平面化"],
  feature_vertices_to_points: ["要素转点", "折点转点", "要素折点转点", "顶点转点", "要素顶点"],
  smooth_vectors: ["平滑矢量", "矢量平滑", "几何平滑"],
  sieve: ["筛除", "筛除斑块", "斑块筛除", "去除小斑块", "最小斑块"],
  simple_kriging: ["简单克里金", "简单克里金插值", "SK 克里金", "已知均值克里金"],
  snap_points_to_network: ["点捕捉网络", "捕捉到网络", "吸附到网络"],
  snap_pour_points: ["捕捉倒口", "捕捉倾泻点", "汇水点吸附", "倾泻点捕捉", "pour point"],
  sobel_filter: ["边缘检测", "边缘提取"],
  split_lines_at_intersections: ["线交点分割", "交点打断", "网络打断"],
  split_vector_lines: ["线分割", "按长度分割", "等距分割", "线打断"],
  strahler_stream_order: ["河网分级", "河流分级", "Strahler", "Strahler 分级", "Strahler 河流分级"],
  symmetrical_difference: ["对称差", "对称差分", "异或叠加"],
  tin_interpolation: ["TIN", "TIN 插值", "三角网插值", "三角网"],
  trend_surface: ["趋势面", "趋势面拟合", "多项式趋势面", "trend surface"],
  update: ["更新叠加", "叠加更新", "矢量更新", "update overlay"],
  vector_lines_to_raster: ["线转栅格", "矢量线转栅格", "线栅格化", "线转像元"],
  vector_points_to_raster: ["点转栅格", "矢量点转栅格", "点栅格化"],
  vector_polygons_to_raster: ["面转栅格", "矢量面转栅格", "面栅格化"],
  wetness_index: ["湿润指数", "地形湿润指数", "地形湿度指数", "TWI", "湿度指数"],
  downslope_index: ["下坡指数", "下坡湿度指数", "Hjerdt", "downslope index"],
  block_statistics: ["块统计", "分块统计", "邻域块统计"],
  cut_fill: ["填挖方", "挖填方", "土方量", "挖填体积"],
  circular_variance_of_aspect: ["坡向环状方差", "坡向圆方差", "圆形方差", "坡向方差"],
  min_max_contrast_stretch: ["最小最大拉伸", "最小-最大拉伸", "最小最大对比度拉伸", "线性拉伸", "min-max stretch"],
  conservative_smoothing_filter: ["保守平滑", "保守平滑滤波", "保边平滑滤波"],
  frost_filter: ["Frost", "Frost滤波", "弗罗斯特滤波", "SAR Frost"],
  fast_almost_gaussian_filter: ["快速高斯", "快速高斯滤波", "快速近似高斯", "fast almost gaussian"],
  horton_stream_order: ["河网分级", "河流分级", "Horton", "Horton 河流分级", "Horton 分级", "霍顿分级"],
  shreve_stream_magnitude: ["Shreve", "Shreve 河流等级", "Shreve 量级", "施里夫等级"],
  pennock_landform_classification: ["Pennock", "Pennock 地貌分类", "Pennock 地形分类"],
  relative_aspect: ["相对坡向", "参考坡向", "方位相对坡向"],
  max_elevation_deviation: ["最大高程偏差", "最大相对高程偏差", "DEVmax"],
  elev_relative_to_min_max: ["相对高程", "高程相对范围", "相对最小最大高程"],
  depth_to_water: ["水深指数", "至水面深度", "地下水深", "DTW"],
  contour_list: ["指定等值线", "等值线列表", "自定义等值线", "等值线值"],
  contours_from_points: ["点等值线", "点生成等值线", "TIN 等值线"],
  sediment_transport_index: ["泥沙输移", "泥沙输移指数", "泥沙输移指标", "STI", "sediment transport index"],
  total_curvature: ["总曲率", "总曲率指数", "整体曲率", "total curvature"],
  standard_deviation_filter: ["标准差滤波", "局部标准差", "标准差平滑", "stdev filter"],
  scharr_filter: ["Scharr", "Scharr 滤波", "沙尔滤波"],
  principal_component_analysis: ["主成分分析", "PCA", "主成分"],
  anisotropic_diffusion_filter: ["各向异性扩散", "各向异性扩散滤波", "保边扩散", "Perona-Malik", "边缘保持去噪"],
  laplacian_of_gaussians_filter: ["高斯-拉普拉斯", "高斯拉普拉斯滤波", "LoG 滤波", "LoG", "拉普拉斯高斯"],
  roberts_cross_filter: ["Roberts", "Roberts 交叉滤波", "Roberts 算子", "交叉滤波"],
  otsu_thresholding: ["Otsu", "Otsu 阈值", "大津阈值", "自动阈值分割", "二值分割"],
  accumulation_curvature: ["累积曲率", "积累曲率", "accumulation curvature"],
  multiscale_roughness: ["多尺度粗糙度", "多尺度地形粗糙度", "尺度粗糙度"],
  stream_link_identifier: ["河流链路", "河网链路标识", "河流链编号", "河段标识", "stream link"],
  hexagonal_grid_from_vector_base: ["六边形网格", "六边形格网", "蜂窝网格", "六边形采样", "hex grid"],
  k_means_clustering: ["K均值", "K-means", "K 均值聚类", "非监督分类"],
};

function aliasesFor(toolName: string): string[] {
  return TOOL_ALIASES[toolName.startsWith("wasm_") ? toolName.slice(5) : toolName] ?? [];
}

/**
 * Chinese has no word delimiters, so a phrase like "算坡度" never equals a tool
 * name. Bigrams let a shared 2-character term ("坡度") count while requiring at
 * least one strong match keeps single common characters from ranking anything.
 */
function tokensOf(phrase: string): string[] {
  const words = phrase.split(" ").filter(Boolean);
  const pieces = [...words];
  for (const word of words) {
    // Bigrams are a CJK device. Latin fragments like "st" from "postgis" would
    // otherwise match inside "distance" and rank unrelated tools.
    if (!/[\u4e00-\u9fff]/.test(word)) continue;
    const chars = [...word];
    if (chars.length < 2) continue;
    for (let index = 0; index + 1 < chars.length; index++) pieces.push(chars[index] + chars[index + 1]);
  }
  return [...new Set(pieces)].filter(piece => !STOP_TOKENS.has(piece));
}

/**
 * Verbs and fillers that appear in a request but say nothing about which tool to
 * use. Without this, "生成 PDF 地图集" scores high on tools whose labels start
 * with "生成".
 */
const STOP_TOKENS = new Set([
  "生成", "计算", "提取", "制作", "做出", "做成", "帮我", "帮忙", "给我", "我要", "一个", "一份",
  "统计", "分析", "处理", "转换", "这个", "那个", "数据", "结果", "地图", "图层", "范围", "里面",
  "可以", "需要", "进行", "得到", "现在", "如何", "怎么", "怎样", "什么", "哪些", "是否", "以及",
  "然后", "接着", "一起", "所有", "每个",
  "把", "用", "按", "对", "在", "和", "与", "给", "从", "向", "将", "是", "的", "了", "吗", "呢",
]);

/** Chinese terms match as substrings; Latin terms must be whole words. */
function containsTerm(field: string, token: string): boolean {
  if (!/^[a-z0-9]+$/.test(token)) return field.includes(token);
  return field.split(" ").some(word => word === token || (token.length >= 4 && word.startsWith(token)));
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
  const tokens = tokensOf(phrase);
  let score = 0;
  let strong = name === phrase || zhName === phrase || label === phrase ||
    aliases.some(alias => alias === phrase);

  if (name === phrase) score += 160;
  else if (name.includes(phrase)) score += 80;
  if (zhName === phrase) score += 150;
  else if (zhName.startsWith(phrase)) score += 100;
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

  const words = phrase.split(" ").filter(word => word && !STOP_TOKENS.has(word));
  const matchedWords = new Set<string>();
  for (const token of tokens) {
    let lexical = 0;
    if (name === token || zhName === token) lexical += 80;
    else if (name.startsWith(token) || zhName.startsWith(token)) lexical += 45;
    else if (containsTerm(name, token) || containsTerm(zhName, token) || containsTerm(label, token)) lexical += 30;
    if (aliases.some(alias => alias === token)) lexical += 70;
    else if (aliases.some(alias => containsTerm(alias, token))) lexical += 35;
    // Only the tool's own identity (name/label/curated alias) may qualify a hit.
    // Taxonomy and description matches are context, not evidence.
    if (lexical >= 30) strong = true;
    let context = 0;
    if (zhCategory === token || zhSubcategory === token || category === token || subcategory === token) context += 24;
    else if (containsTerm(zhCategory, token) || containsTerm(zhSubcategory, token) || containsTerm(category, token) || containsTerm(subcategory, token)) context += 13;
    if (description.includes(token)) context += 7;
    if (lexical + context > 0 && words.includes(token)) matchedWords.add(token);
    score += lexical + context;
  }
  // A spaced query like "栅格 叠加" names two conditions; short atomic words must
  // all be present. A long CJK run ("填洼后再算流向") is one concept, not two, and
  // an explicit intent match already proves what the user wants.
  const requiredWords = words.filter(word => /^[a-z0-9]+$/.test(word) || [...word].length <= 4);
  const boost = intentBoost(tool.name, phrase);
  if (boost) strong = true;
  else if (requiredWords.length > 1 && requiredWords.some(word => !matchedWords.has(word))) return 0;
  if (!strong) return 0;
  return Math.min(score, 1000) + boost;
}

export type SearchOptions = {
  limit?: number;
  searchable?: (name: string, tool?: CatalogTool) => boolean;
  /** Only tools whose data contract accepts this input kind (unknown contracts are excluded). */
  inputKind?: InputKind;
  provider?: ToolProvider;
};

export function searchBrowserTools(
  tools: CatalogTool[],
  query: string,
  options: SearchOptions = {},
): CatalogTool[] {
  const limit = options.limit ?? 8;
  const searchable = options.searchable ?? isBrowserSearchable;
  const filter = { inputKind: options.inputKind, provider: options.provider };
  return tools
    .filter(tool => searchable(tool.name, tool) && matchesFilter(tool, filter))
    .map(tool => ({ tool, score: scoreBrowserTool(tool, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(item => item.tool);
}

/**
 * What the agent actually receives: identity, input kinds and the parameters
 * that decide a call — not the full schema of every candidate.
 */
export function searchBrowserToolCandidates(
  tools: CatalogTool[],
  query: string,
  options: SearchOptions = {},
): ToolCandidate[] {
  return searchBrowserTools(tools, query, options).map(compactTool);
}
