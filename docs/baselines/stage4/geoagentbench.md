# 外部基准 · GeoAgentBench（兼容子集，单独报告）

> 生成：2026-10-25T08:06:15.641Z · 36 任务中适配 6 个 · 评分用基准自带 grade.py · **不与 TIPHYS 自有基线混算**

| 任务 | 结果 | Gates | Subchecks | 加权 | 耗时 |
|---|---|---|---|---|---|
| crs-l1-paris-lambert93 | PASS | 1/1 | 11/11 | 1 | 96s |
| geo-l1-cairo-multipoint-hull | PASS | 1/1 | 10/10 | 1 | 34s |
| geo-l1-capetown-building-centroids | PASS | 1/1 | 9/9 | 1 | 96s |
| geo-l2-bangkok-landuse-intersect | FAIL | 0/1 | 0/0 | 0 | 509s |
| dc-l1-capetown-waterway-nulls | PASS | 1/1 | 12/12 | 1 | 87s |
| fio-l1-paris-kml-pois | PASS | 1/1 | 10/10 | 1 | 94s |

合计：5/6 全过；加权平均 0.833

## 排除任务与原因（36 − 6）

- geo-l1-tokyo-busstop-buffer：输出 GeoParquet，浏览器导出暂不支持该格式
- spa-l1-capetown-hospital-nn：输入为 GeoParquet 且要求精确列名（nearest_hospital_name/distance_m），第一轮不接
- spa-l1-paris-amenity-within / spa-l1-vienna-pip-count：CSV 列名来自参考实现的 pandas 语义（分组计数/指定列名），我们原生导出对不上 schema
- dc-l2-* / fio-l2-capetown-landuse-dissolve：依赖 dissolve——浏览器端 D1 缺陷未修
- spa-l3-paris-emergency-routing / spa-l2-*：需要路网/距离矩阵/kNN 算子，当前引擎无对应能力
- crs-l3 / dc-l3 / fio-l3 / dd-l3 / geo-l3 / lagos：多算子长链或需外部数据下载（Overture/Overpass），第一轮不接

## geo-l2-bangkok-landuse-intersect

- ✗ gate format_schema_valid：undefined
- 工具链：describe_layer → describe_layer → search_browser_tools → search_browser_tools → search_browser_tools → search_browser_tools → search_browser_tools → clip → clip → intersection → ping → inspect_layers → run_plan → run_plan → search_browser_tools
- 工具错误：clip: Error: unreachable
- 工具错误：clip: Error: unreachable
- 工具错误：intersection: Error: unreachable
- 最后回答：计划校验给出两条关键信息：`gis.clip` 的 wire 参数是 `maskLayerId`、`gis.reproject` 是 `targetCrs`；而 **`gis.dissolve` 在 browser-wasm 上被判定不支持（会静默丢几何）**，所以按 class 合并这条路必须放弃。先用正确参数重试裁剪，并顺带验证工具检索是否正常工作：


- 产物：[]（期望 ["bma_landcover_intersect.geojson"]）

