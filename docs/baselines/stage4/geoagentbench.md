# 外部基准 · GeoAgentBench（兼容子集，单独报告）

> 生成：2026-10-25T07:37:14.530Z · 36 任务中适配 6 个 · 评分用基准自带 grade.py · **不与 TIPHYS 自有基线混算**

| 任务 | 结果 | Gates | Subchecks | 加权 | 耗时 |
|---|---|---|---|---|---|
| crs-l1-paris-lambert93 | PASS | 1/1 | 11/11 | 1 | 139s |
| geo-l1-cairo-multipoint-hull | PASS | 1/1 | 10/10 | 1 | 46s |
| geo-l1-capetown-building-centroids | PASS | 1/1 | 9/9 | 1 | 68s |
| geo-l2-bangkok-landuse-intersect | FAIL | 0/1 | 0/0 | 0 | 517s |
| dc-l1-capetown-waterway-nulls | FAIL | 1/1 | 8/12 | 0.586 | 96s |
| fio-l1-paris-kml-pois | PASS | 1/1 | 10/10 | 1 | 131s |

合计：4/6 全过；加权平均 0.764

## 排除任务与原因（36 − 6）

- geo-l1-tokyo-busstop-buffer：输出 GeoParquet，浏览器导出暂不支持该格式
- spa-l1-capetown-hospital-nn：输入为 GeoParquet 且要求精确列名（nearest_hospital_name/distance_m），第一轮不接
- spa-l1-paris-amenity-within / spa-l1-vienna-pip-count：CSV 列名来自参考实现的 pandas 语义（分组计数/指定列名），我们原生导出对不上 schema
- dc-l2-* / fio-l2-capetown-landuse-dissolve：依赖 dissolve——浏览器端 D1 缺陷未修
- spa-l3-paris-emergency-routing / spa-l2-*：需要路网/距离矩阵/kNN 算子，当前引擎无对应能力
- crs-l3 / dc-l3 / fio-l3 / dd-l3 / geo-l3 / lagos：多算子长链或需外部数据下载（Overture/Overpass），第一轮不接

## geo-l2-bangkok-landuse-intersect

- ✗ gate format_schema_valid：undefined
- 工具链：describe_layer → describe_layer → search_browser_tools → search_browser_tools → search_browser_tools → search_browser_tools → search_browser_tools → search_browser_tools → search_browser_tools → clip → search_browser_tools → intersection → run_plan → run_plan
- 工具错误：clip: Error: unreachable
- 工具错误：intersection: Error: unreachable
- 最后回答：参数名应为 `maskLayerId`。重提计划。
- 产物：[]（期望 ["bma_landcover_intersect.geojson"]）

## dc-l1-capetown-waterway-nulls

- ✗ no_null_or_empty_geometry_in_output：null=5, empty=5
- ✗ dropped_count_correct：reported 10, expected 20
- ✗ feature_count_within_tolerance：submission 90 vs reference 80 (±5%)
- ✗ feature_id_set_preserved：Jaccard 0.8889
- 工具链：inspect_layers → describe_layer → field_statistics → select_by_attributes → describe_layer → export_features → export_features
- 最后回答：✅ 完成，文件已导出：**`waterways_clean.geojson`**（18,580 字节，非空文件，点击下载保存即可）。

**处理摘要（可直接转给承包商）**

| 项目 | 结果 |
|---|---|
| 原始要素 | 100 个 |
| 剔除要素 | **10 个**（`waterway_type` 为空，无正规水道类型） |
| 保留要素 | 90 个（类型均为 river / drain / canal / ditch / stream 各 18 个）
- 产物：["capetown_waterways.geojson","waterways_clean.geojson"]（期望 ["waterways_clean.geojson"]）

