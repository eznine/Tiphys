# 外部基准 · GeoAgentBench（兼容子集，单独报告）

> 生成：2026-10-24T16:32:41.980Z · 36 任务中适配 6 个 · 评分用基准自带 grade.py · **不与 TIPHYS 自有基线混算**

| 任务 | 结果 | Gates | Subchecks | 加权 | 耗时 |
|---|---|---|---|---|---|
| crs-l1-paris-lambert93 | PASS | 1/1 | 11/11 | 1 | 201s |
| geo-l1-cairo-multipoint-hull | PASS | 1/1 | 10/10 | 1 | 71s |
| geo-l1-capetown-building-centroids | ERROR | 0/0 | 0/0 | 0 | 2s |
| geo-l2-bangkok-landuse-intersect | FAIL | 0/1 | 0/0 | 0 | 309s |
| dc-l1-capetown-waterway-nulls | FAIL | 1/1 | 10/12 | 0.897 | 238s |
| fio-l1-paris-kml-pois | FAIL | 0/1 | 0/0 | 0 | 146s |

合计：2/6 全过；加权平均 0.483

## 排除任务与原因（36 − 6）

- geo-l1-tokyo-busstop-buffer：输出 GeoParquet，浏览器导出暂不支持该格式
- spa-l1-capetown-hospital-nn：输入为 GeoParquet 且要求精确列名（nearest_hospital_name/distance_m），第一轮不接
- spa-l1-paris-amenity-within / spa-l1-vienna-pip-count：CSV 列名来自参考实现的 pandas 语义（分组计数/指定列名），我们原生导出对不上 schema
- dc-l2-* / fio-l2-capetown-landuse-dissolve：依赖 dissolve——浏览器端 D1 缺陷未修
- spa-l3-paris-emergency-routing / spa-l2-*：需要路网/距离矩阵/kNN 算子，当前引擎无对应能力
- crs-l3 / dc-l3 / fio-l3 / dd-l3 / geo-l3 / lagos：多算子长链或需外部数据下载（Overture/Overpass），第一轮不接

## geo-l1-capetown-building-centroids

- 驱动器错误：page.evaluate: Error: unsupported vector format 'shp' (try: geojson,topojson,gml,gpx,kml,flatgeobuf,geopackage,kmz,geoparquet)
    at Worker.onMessage (http://127.0.0.1:1420/src/lib/browser/wasm-tool-runner.ts?t=1792808421877:170:45)
- 产物：[]（期望 ["building_centroids.geojson"]）

## geo-l2-bangkok-landuse-intersect

- ✗ gate format_schema_valid：undefined
- 产物：[]（期望 ["bma_landcover_intersect.geojson"]）

## dc-l1-capetown-waterway-nulls

- ✗ dropped_count_present：top-level dropped_count = None
- ✗ dropped_count_correct：reported None, expected 20
- 产物：["waterways_clean.geojson"]（期望 ["waterways_clean.geojson"]）

## fio-l1-paris-kml-pois

- ✗ gate format_schema_valid：undefined
- 产物：["paris_pois.geojson"]（期望 ["paris_pois.geojson"]）

## Batch 33 产品修复（未重评分）

2026-10-25：已修复 KML `ExtendedData` / `SchemaData` 属性保真、GeoJSON 顶层 `dropped_count`、非 GeoJSON 格式的 NOT_SUPPORTED 说明、显式文件名导出守卫，以及驱动器对裸 Shapefile sidecar 的分组导入。确定性浏览器回归通过；因本机缺少 GeoAgentBench 克隆且 `github.com` 不可解析，**agent re-score deferred**。本文件上方计数与 `geoagentbench.json` 保持 2026-10-24 单次实测，不声称新分数。详见 `docs/GEOAGENT_SCHEMA_EXPORT.md`。

