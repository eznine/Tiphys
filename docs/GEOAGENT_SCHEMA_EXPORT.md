# GeoAgentBench schema / export fidelity follow-up

> 批次 33 · 2026-10-25 · 只针对产品路径；GeoAgentBench 分数仍单独报告，不并入 TIPHYS 自有基线。

## 已修复

### KML 属性保真

- `.kml` / `.kmz` 导入仍由 GeoLibre WASM 读取真实几何；导入层随后写为受管的 FlatGeobuf 工作副本，而不是把原始 KML 一直留作导出源。
- TIPHYS 在导入时补读 KML `Placemark` 的 `name`、`description`、`ExtendedData/Data/value` 和 `SchemaData/SimpleData`，按位置/名称合并到转换后的要素属性。`category`、`verified_date` 等字段因此会进入属性表、查询和后续 GeoJSON 导出。
- 属性值按 KML 文本解码（含 CDATA、XML 实体）。几何解释仍由基准同款 WASM 转换器负责，不另写平行几何转换器。

### GeoJSON 顶层元数据

- `export_features` 新增可选 `metadata` 对象；只接受字符串、数值、布尔值或 `null`，并拒绝覆盖 `type` / `features` / `crs` / `bbox`。
- `select_by_attributes` 生成新图层时记录真实减少的要素数 `dropped_count`，导出 GeoJSON 时自动写到顶层；也可由调用方通过 `metadata` 显式补充。
- `geojson` 支持顶层元数据。`gpkg`、`fgb`、`csv` **NOT_SUPPORTED**：这些容器没有等价的 GeoJSON 顶层字段语义。工具不会静默丢弃，而是在结果中返回 `metadata_status: "not_supported"` 和 `metadata_not_supported` 说明。
- 导出路径扩展名与 `fmt` 不一致时直接拒绝，避免 `.gpkg` 里装 GeoJSON 字节。

### 导出纪律

- 系统提示与 `export_features` 工具说明明确要求：用户给出文件名或要求保存/导出时，必须对最终图层调用真实导出，不得用空文件或口头声明代替。
- 浏览器 Agent 增加交付守卫：仅当用户文本显式包含保存/导出动词和文件名、且本轮没有成功导出该文件时，才对最终结果图层执行一次真实 `export_features`。仍需正常审批；没有图层或导出失败会发出诚实提示。
- 确定性回归按 Bangkok 任务的真实路径跑通“双面图层求交 → 精确文件名 GeoJSON 导出 → 回读非空要素”，不替代模型在环基准评分。
- 推荐工作流增加“保存结果”卡片，直接打开真实导出表单（图层、文件名、格式），让“分析完成后如何落盘”在 UI 中可发现。

### 裸 Shapefile

- 产品已有 `importBrowserShapefiles`：同名 `.shp + .shx + .dbf`（可选 `.prj/.cpg`）作为一次选择导入。
- GeoAgentBench 驱动器原先逐个调用单文件导入器，导致 Capetown 任务只拿到 `.shp` 并报 unsupported format。驱动器现先按扩展名收集所有 Shapefile 部件，再调用真实多文件导入路径。
- 单文件入口收到裸 `.shp` / sidecar 时给出可操作错误，不再透出底层 unsupported-format 文本。

## 验证

- `npx tsc --noEmit`
- 浏览器引擎：78/78，包含 KML ExtendedData 导入→工作副本→GeoJSON 导出、`dropped_count` 自动/显式写入、不支持格式说明、扩展名一致性、裸 Shapefile 错误和多文件导入。
- `npm run test:contracts`、`npm run test:plans` 通过。

## 重评分状态（2026-10-25）

已用本机现有的 `reference/gis/GeoAgentBench` 重跑同一 6 任务子集：**4/6 全过，加权平均 0.764**（报告 `docs/baselines/stage4/geoagentbench.{json,md}`）。相对 2026-10-24 的 2/6：

- **Capetown 建筑质心：ERROR → PASS 9/9。** 驱动器补齐 Shapefile sidecar；新增原生 `centroid`（面按面积加权、洞减面积、UTM 大坐标先平移到局部原点再算，避免双精度抵消），并在方法卡/提示词里要求先投影到局部米制 CRS。
- **巴黎 KML：FAIL → PASS 10/10。** KML `<description>` 中的“键：值”文本展开为真实属性；GeoJSON 导出按 RFC 7946 统一 EPSG:4326、去 Z、把 4979 的 `crs` 重标为 4326；评测器在 Windows 上强制 UTF-8，避免 GBK 读中文/重音字符崩溃。
- **仍然失败：** `dc-l1-capetown-waterway-nulls` 8/12（模型只过滤空 `waterway_type`，没有去掉 5 个 null + 5 个 empty 几何；产品尚无“空几何”过滤器）；`geo-l2-bangkok-landuse-intersect` 无产物（13 MB GeoParquet 上 `clip`/`intersection` 触发 WASM `unreachable`，是浏览器大矢量资源边界，不是超时）。

验证：`npx tsc --noEmit`、`npm run build`、`test:plans` 31/31、`test:methods` 9/9、`test:search` 8/8、`test:contracts` 12/12、`test:centroid` 7/7、`browser-engine` 88/88。后续靶子：空几何过滤与大矢量分块/降级。
