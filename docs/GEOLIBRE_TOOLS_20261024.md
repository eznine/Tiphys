# 2026-10-24 · GeoLibre 工具全面接入与中文化

> **2026-10-25 更新：** 桌面 Agent 已通过 `wasm_search` / `wasm_run` 触达同一 WASM 目录；本文“桌面版仍是 24 个 MCP 工具”是当时快照，最新语义见 [DESKTOP_WASM_BRIDGE](DESKTOP_WASM_BRIDGE.md) 与 [CLIENT_RUNTIME](CLIENT_RUNTIME.md)。

## 背景与目标

用户要求把 GeoLibre 的全部工具接入 TIPHYS 并做高质量中文翻译（对照 RustGIS 的 "1,000+ GeoLibre and Whitebox tools" 宣传口径）。此前浏览器桥只放行 257 个"矢量进/矢量出"工具，其余 808 个被参数/输出类型过滤。

本机 `reference/gis/GeoLibre` 与 `reference/gis/RustGIS` 已更新至最新提交（GeoLibre `ffe2665`、RustGIS `2502d90`，均为 2026-10-22/23 上游版本），`scripts/import-browser-engine.mjs` 固定的 pinned commit 与之一致。

## 实际工具盘点（.tooling/wasm-manifests.json，共 1065 个）

| 类别 | 数量 |
|---|---|
| Vector | 309 |
| Raster | 223 |
| Remote Sensing | 178 |
| Terrain | 111 |
| Hydrology | 105 |
| LiDAR | 67 |
| Conversion | 59 |
| Projection | 13 |

本轮放行 **958 个**：输入限矢量/栅格/表格、输出额外允许文件/文本/JSON 附件、非 IO 参数限单值标量/布尔/字符串/枚举、license=open。未放行 107 个：LiDAR 输入输出（69）、文件输入（5）、文本/JSON 输入、多值（multiple）参数与未知参数类型——待后续批次补桥接。

## 桥接扩展（src/lib/browser/）

- **栅格图层**：`raster-display.worker.ts` 用 geolibre-wasm 的 `geotiff_info`/`geotiff_read_band_f64` 读取元数据与首波段，2–98% 拉伸 + Viridis 色带在 OffscreenCanvas 渲染 PNG 预览；图层记录保存 GeoTIFF 原始字节 + 预览，地图用 MapLibre image source 按 `bbox_lonlat` 四角显示。6400 万像元为预览上限；NoData 像元透明。Node（测试/CI）回退：直读元数据 + 占位 PNG。
- **表格图层**：CSV 输出解析行数后作为表格图层入库（不参与地图绘制），工具箱里可作为表格输入。
- **工具运行泛化**（`runNative`）：按清单参数类型路由输入（矢量/栅格/表格）、按输出 data_kind 采纳为图层或附件；输出扩展名优先用工具示例的扩展名，但限制在 WASI 构建实际支持的格式白名单内（矢量 geojson/fgb/gpkg 等，栅格 tif；shp 会被拒）——这是测试发现的实际约束。多输出工具全部采纳，单图层结果保持旧返回形状（`layer` 字段），多图层返回 `layers[]`，文件/文本/JSON 输出返回 `attachments[]` 下载链接。
- **导入**：添加数据现支持 `.tif/.tiff`（栅格）与 `.csv`（表格）。

## 中文化

- 8 个分批代理翻译全部 1065 个工具的名称与描述（ArcGIS Pro/QGIS 中文术语习惯，非机翻；参数名、公式、单位、专有名词保留），落盘 `.tooling/zh-slices/zh-part*.json`，由导入脚本合并为 `src/lib/i18n/tool-zh.json`。
- `src/lib/i18n/tools.ts`：`zhTool()`（按工具 id 查字典）、类别/子类中文映射、约 90 个常用参数中文名。
- 工具箱：工具名、描述、分组（`栅格 · 地形分析` 这类"类别 · 子类"）、参数标签中文化；图层选择器按参数类型（矢量/栅格/表格）过滤并显示类型标签。
- 翻译 8 个批次全部完成：1065/1065 个工具的名称与描述均为审校后的简体中文（后台代理受并发限制按串行链式执行），目录已合并入库（`src/lib/i18n/tool-zh.json`，覆盖率 100%）。

## Agent 侧

- 浏览器 Agent 的 `search_browser_tools`/`run_browser_tool` 描述更新为覆盖矢量/栅格/地形/水文/遥感；`callTool` 现在为多图层结果逐个发 `layer-added`、为附件发下载通知。
- 前端 `mergeToolResult` 支持 `layers[]` 多图层发布。

## 验证

- `npm run test:browser`：11/11 通过，新增 2 项——目录规模断言（>900 且含栅格/表格代表工具、`x-layer-kind` 标注）与端到端栅格链路（点→栅格→重导入→山体阴影，边界必须为 WGS84，记录必须带 PNG 预览）。
- `npx tsc --noEmit` 与 `vite build` 通过。
- 测试发现并修复：centroid_vector 示例输出为 shp，WASI 构建不支持写 shp，白名单回退 fgb。

## 同批完成：图层重命名与排序（基础工作台）

- 引擎新增 MCP 工具 `rename_layer`（显示名唯一校验、空名拒绝）与 `reorder_layers`（必须是现有图层 ID 的完整排列），顺序写入 workspace.json 并持久化，重启恢复；`list_layers` 顺序即地图绘制顺序。MCP 工具现为 26 个。
- 浏览器桥实现同契约工具；浏览器图层顺序用 `workspace:layer-order` 记录显式保存（IndexedDB 键序不可靠），删除图层时同步清理。
- 内容列表：右键菜单"重命名"行内编辑；行拖拽排序（搜索过滤时禁用拖拽避免歧义）；栅格/表格图层显示类型徽标。
- 前端新增 reducer 事件 `layer-updated`（原地更新不移动图层、不重聚焦）与 `layers-reordered`；手动与 Agent 两条事件通路都接入。

## 同批完成：属性字段统计

- 引擎新增 MCP 工具 `field_statistics`（MCP 共 27 个）：数值字段输出最小/最大/均值/中位数/标准差，其他字段输出前 10 个最常见值，空值单独计数，非有限数值归为 null 保证 JSON 安全。
- 浏览器桥实现同契约；属性表工具栏新增“字段统计…”下拉，选择字段即出统计条，可关闭。

## 边界（不宣称完成）

- 栅格显示是基础版：单波段色带渲染、无波段选择/直方图拉伸调节、无大图金字塔；非 WGS84 栅格直接按角点贴合显示，大范围高纬度会有形变（未做重投影显示）。
- LiDAR 工具（67 个）未接入；文件输入类工具（GTFS 等 5 个）未接入。
- 多值（multiple）参数工具未接入。
- 桌面版（Tauri + Python 引擎）工具目录仍是 24 个 MCP 工具；本轮扩展位于浏览器运行时（1420 预览与浏览器分发）。桌面版如何统一接入 WASM 目录（同一 WebView 内混合运行时）留待下一批决策。
- 工作台批次（图层重命名/排序、地图点选联动、字段统计）尚未开始，见 CLIENT_PARITY 顺序。
