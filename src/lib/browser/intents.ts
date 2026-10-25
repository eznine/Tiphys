/**
 * Task phrasing → candidate tools.
 *
 * The alias table answers "what is this tool called"; it cannot answer "把点做成
 * 500 米范围" because that phrasing never names a tool. This lexicon maps the
 * verb-object forms users actually type to the tool ids that implement them, and
 * is kept separate from the catalog so a wrong mapping is a one-line fix here.
 *
 * Rules of thumb:
 * - only unambiguous GIS vocabulary (坡向, 填洼, 外接圆), never generic words;
 * - the boost ranks a tool, it does not filter: input-kind filters and schema
 *   pre-checks still decide whether the call is legal.
 */
type Intent = { match: RegExp; tools: string[]; weight?: number };

export const INTENTS: Intent[] = [
  { match: /缓冲(区|环)?|外扩|膨胀范围|米范围|公里范围|km.*范围/i, tools: ["buffer_vector"] },
  { match: /栅格.*缓冲|像元.*缓冲/, tools: ["buffer_raster"] },
  { match: /多层缓冲|缓冲环/, tools: ["multiple_ring_buffer"] },
  { match: /裁剪|裁切|剪切/, tools: ["clip", "clip_raster_to_polygon"] },
  { match: /合并|合成一个|融合|溶解/, tools: ["dissolve", "merge_vectors", "union"] },
  { match: /交集|相交|求交/, tools: ["intersect"] },
  { match: /并集|联合/, tools: ["union"] },
  { match: /擦除|去掉.*范围|减去|抠掉/, tools: ["erase"] },
  { match: /对称差/, tools: ["symmetrical_difference"] },
  { match: /落在哪个|空间连接|关联到面|属于哪个/, tools: ["spatial_join"] },
  { match: /表连接|属性连接|按字段关联/, tools: ["join_tables"] },
  { match: /分区统计|区域统计|每个.*(区|面|单元).*(平均|统计|总和|最大|最小|值|均值)/, tools: ["zonal_statistics"] },
  { match: /分区直方图/, tools: ["zonal_histogram"] },
  { match: /坡度/, tools: ["slope"] },
  { match: /坡向/, tools: ["aspect"] },
  { match: /山体阴影|晕渲|地形阴影/, tools: ["hillshade"] },
  { match: /分层设色/, tools: ["hypsometrically_tinted_hillshade"] },
  { match: /多方向.*阴影/, tools: ["multidirectional_hillshade"] },
  { match: /填洼|洼地|填平/, tools: ["fill_depressions"] },
  { match: /汇流累积|流量累积|汇水面积|上游面积/, tools: ["d8_flow_accum"] },
  { match: /流向|汇流方向/, tools: ["d8_pointer"] },
  { match: /河网|水系|河流提取/, tools: ["extract_streams", "raster_streams_to_vector"] },
  { match: /流域|集水区|子流域|分水岭|watershed|basins?/i, tools: ["watershed", "basins"] },
  { match: /河网分级|河流分级|strahler|horton/i, tools: ["hack_stream_order", "horton_stream_order"] },
  { match: /等高线|等值线|contour/i, tools: ["contours_from_raster", "contour_list"] },
  { match: /矢量化|栅格转.*(矢量|面)/, tools: ["polygonize"] },
  { match: /重分类|重新分类/, tools: ["reclass", "reclass_equal_interval", "reclassify_field"] },
  { match: /等间距.*重分类/, tools: ["reclass_equal_interval"] },
  { match: /插值/, tools: ["idw_interpolation", "ordinary_kriging", "nearest_neighbour_interpolation"] },
  { match: /反距离|idw/i, tools: ["idw_interpolation"] },
  { match: /克里金|kriging/i, tools: ["ordinary_kriging", "simple_kriging", "local_kriging", "empirical_bayesian_kriging"] },
  { match: /最近邻.*插值/, tools: ["nearest_neighbour_interpolation"] },
  { match: /欧氏距离|直线距离/, tools: ["euclidean_distance"] },
  { match: /成本距离|阻力距离/, tools: ["cost_distance"] },
  { match: /成本路径|最小成本路径|最低成本/, tools: ["cost_pathway"] },
  { match: /服务区|可达范围|覆盖范围/, tools: ["network_service_area"] },
  { match: /廊道/, tools: ["corridor"] },
  { match: /质心|中心点|几何中心/, tools: ["centroid", "centroid_vector"] },
  { match: /空几何|无效几何|空要素|empty geometry/i, tools: ["drop_empty_geometries"] },
  { match: /最小外包(?!圆)|外接矩形|外包框|包围盒/, tools: ["minimum_bounding_box"] },
  { match: /外接圆|包围圆|覆盖圆/, tools: ["minimum_bounding_circle"] },
  { match: /凹包|凹壳/, tools: ["concave_hull"] },
  { match: /凸包|convex hull/i, tools: ["minimum_convex_hull"] },
  { match: /聚成|聚类|聚集|聚合/, tools: ["aggregate_points", "aggregate_polygons"] },
  { match: /线密度|道路密度|河流密度/, tools: ["line_density"] },
  { match: /标准差椭圆|方向分布/, tools: ["directional_distribution"] },
  { match: /中位数中心|中位中心/, tools: ["median_center"] },
  { match: /加密|densify/i, tools: ["densify_features"] },
  { match: /多部件|拆分部件/, tools: ["multipart_to_singlepart"] },
  { match: /合并.*(图层|矢量)|多个.*图层/, tools: ["merge_vectors"] },
  { match: /重复|查重/, tools: ["find_identical"] },
  { match: /碎面|小面|孔洞/, tools: ["eliminate_polygon_part"] },
  { match: /提取.*值|点采样|采样值/, tools: ["extract_raster_values_at_points"] },
  { match: /nodata|无数据/i, tools: ["is_nodata"] },
  { match: /邻域填充|空洞填充/, tools: ["nibble"] },
  { match: /中值滤波/, tools: ["median_filter"] },
  { match: /高斯滤波|高斯平滑/, tools: ["gaussian_filter"] },
  { match: /lee.*滤波|sar.*滤波/i, tools: ["lee_filter"] },
  { match: /直方图均衡/, tools: ["histogram_equalization"] },
  { match: /镶嵌|拼接/, tools: ["mosaic"] },
  { match: /六边形.*(网|格网)|渔网/, tools: ["hexagonal_grid_from_vector_base", "hexagonal_grid_from_raster_base"] },
  { match: /矩形.*格网|规则格网/, tools: ["rectangular_grid_from_vector_base", "rectangular_grid_from_raster_base"] },
  { match: /流路坡度/, tools: ["average_flowpath_slope"] },
  { match: /谷线|山谷线/, tools: ["extract_valleys"] },
  { match: /地形位置|tpi/i, tools: ["deviation_from_mean_elevation"] },
  { match: /视线|可视域|viewshed/i, tools: ["viewshed"] },
  { match: /曲率/, tools: ["profile_curvature", "plan_curvature"] },
  { match: /湿度指数|wetness/i, tools: ["wetness_index"] },
  { match: /烧录|burn.*stream/i, tools: ["burn_streams"] },
  { match: /透视表|pivot/i, tools: ["pivot_table"] },
  { match: /扫描地图|ocr/i, tools: ["extract_scanned_features"] },
  { match: /抽稀|剪枝/, tools: ["prune_vector_streams"] },
  { match: /三维缓冲|3d.*缓冲/i, tools: ["buffer_3d"] },
  { match: /三维相交|3d.*相交/i, tools: ["intersect_3d"] },
  { match: /三维并集|3d.*并集/i, tools: ["union_3d"] },
  { match: /交点/, tools: ["line_intersections", "split_lines_at_intersections"] },
  { match: /交叉表|列联表/, tools: ["tabulate_intersection"] },
  { match: /加权叠加|权重叠加/, tools: ["weighted_overlay"] },
  { match: /求和叠加/, tools: ["sum_overlay"] },
  { match: /成本分配/, tools: ["cost_allocation"] },
  { match: /成本连通/, tools: ["cost_connectivity"] },
  { match: /百分位.*等值线/, tools: ["percentile_contours"] },
  { match: /按字段重分类/, tools: ["reclassify_field"] },
  { match: /随机森林.*(分类|预测)/, tools: ["random_forest_classification", "random_forest_classification_predict"] },
  { match: /随机森林.*回归/, tools: ["random_forest_regression", "random_forest_regression_predict"] },
  { match: /多边形面积|面.*面积/, tools: ["polygon_area", "raster_area"] },
  { match: /周长/, tools: ["polygon_perimeter"] },
  { match: /简化/, tools: ["simplify_features"] },
  { match: /随机点/, tools: ["random_points_in_polygon"] },
  { match: /随机采样/, tools: ["random_sample"] },
  { match: /面转线|面.*转.*线/, tools: ["polygons_to_lines"] },
  { match: /点.*连.*线/, tools: ["points_to_line"] },
  { match: /面积.*过滤|按面积/, tools: ["filter_vector_features_by_area", "filter_raster_features_by_area"] },
  { match: /降低.*密度|抽稀点/, tools: ["reduce_point_density"] },
  { match: /重投影|投影转换|坐标系转换|utm|epsg/i, tools: ["reproject_vector"] },
  { match: /最近要素|邻近要素|最近邻(?!.*插值)/, tools: ["near"] },
  { match: /坡长|坡面长度/, tools: ["downslope_flowpath_length"] },
  { match: /下坡邻域/, tools: ["num_downslope_neighbours"] },
  { match: /流域标记/, tools: ["segment_watershed_markers"] },
  { match: /相对.*高程/, tools: ["elev_relative_to_watershed_min_max"] },
];

const BARE = (name: string) => name.replace(/^wasm_/, "");

export function intentBoost(toolName: string, query: string): number {
  const name = BARE(toolName);
  let best = 0;
  for (const intent of INTENTS) {
    if (!intent.tools.includes(name)) continue;
    if (!intent.match.test(query)) continue;
    best = Math.max(best, intent.weight ?? 120);
  }
  return best;
}
