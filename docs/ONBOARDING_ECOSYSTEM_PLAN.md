# TIPHYS 上手与数据生态计划（Onboarding & Ecosystem Plan）

**日期：** 2026-10-26 · **范围：** Web（https://tiphys.xyz/tiphys/）+ Android APK（同一份前端）

核心目标：**手机里什么 GIS 数据都没有，打开 App 30 秒内也能看到自己关心的地图并开始让 Agent 分析**；同时让 ArcGIS 用户的工程"拿得进来"。

---

## 1. 现状审计（改动前）

| 维度 | 改动前 |
|---|---|
| 导入入口 | 单一"添加数据"→系统文件选择器；空状态只有"加载示例点位"（8 个点） |
| 格式 | GeoJSON、GPKG、Shapefile(zip/多文件)、FGB、KML/KMZ、GPX、GML、GeoParquet、TopoJSON、GeoTIFF、CSV（GeoLibre WASM，无 GDAL 驱动，不含 FileGDB） |
| ArcGIS | `import_arcgis_project` 只返回"不支持"；无 REST/Online 导入 |
| 在线数据 | 仅底图（OpenFreeMap、Esri 影像/晕渲、OpenTopo）；无 OSM 要素、无边界、无 URL 导入 |
| Agent | 只能 `add_data samples/beijing_points.geojson`，用户无数据时无路可走 |

## 2. 可行性研究结论（已在 box 上实测）

| 方案 | 结论 |
|---|---|
| **gdal3.js 2.8.1（GDAL WASM）** | Node + 浏览器实测可经 `/vsizip/` 读 **.gdb.zip**（驱动 "ESRI FileGDB"/OpenFileGDB），ogr2ogr→GeoJSON EPSG:4326。体积 ~40 MB → **按需从 jsDelivr CDN 加载**，不进 APK |
| **7z-wasm 1.2（1.8 MB）** | 可解 ArcGIS **.mpkx/.ppkx/.lpkx**（7-Zip 容器）→ 取出 .gdb/.shp/.tif/.mapx；打包进应用，懒加载 |
| **.aprx / .mapx / .lyrx** | aprx = ZIP 内 CIM JSON（Pro 2.x/3.x）；mapx/lyrx = CIM JSON。可恢复：地图名、图层名、数据源（workspace + dataset / 服务 URL）、单一符号颜色 |
| **.mxd** | OLE 二进制，无公开解析器；只能 UTF-16 字符串扫描出数据路径/服务地址 |
| **ArcGIS REST** | FeatureServer/MapServer 图层 `query?f=geojson&outSR=4326` 分页；旧服务回退 Esri JSON→GeoJSON；切片/动态 MapServer、ImageServer 作底图；ArcGIS Online 条目/Web 地图走 `sharing/rest/content/items/{id}(/data)` |
| **OSM Overpass** | 可用但公共实例经常超时（实测 >40 s）→ 必须有回退：**直接从 OpenFreeMap 矢量切片 `querySourceFeatures` 提取**（瞬时，几何按切片裁切） |
| **Nominatim** | 地名→行政边界面（`polygon_geojson`），反查当前位置所在区县，1–2 s |
| CORS | Web 版受目标服务器 CORS 限制；APK 中 CapacitorHttp 拦截 fetch，不受限 |

## 3. 优先级计划

### P0（本次已实现、已上线）

用户看到的：
1. **首次打开自动弹出「开始的方式」**（手机为底部抽屉，桌面为居中卡片，蓝色主题、渐入动画）；之后所有"添加数据/＋"入口都打开它。
2. 四个一键入口：
   - **试用示例工程**：世界国家（Natural Earth 中国视角版）、世界河流、世界城市、北京点位
   - **定位并加载附近数据**：GPS 定位 → 飞到当前位置 → 区县边界 + 1.2 km 内道路 + POI + "我的位置"点
   - **导入文件**：手机文件/网盘/分享（APK 内不限扩展名）
   - **粘贴服务链接**：ArcGIS REST / ArcGIS Online / WMS / WMTS / XYZ / GeoJSON 等直链
3. **在线开放数据（当前地图范围）**：POI、道路、建筑、水系、公园绿地、公交地铁站、土地利用；范围过大自动收缩到地图中心；Overpass 超时自动改为底图切片提取。
4. **行政边界搜索**（例："杭州市西湖区"；留空=当前区县）。
5. **免费底图/影像**：Esri 卫星、地形、晕渲、Esri 地形街道/街道、OSM、Sentinel-2 无云 2021、GEBCO（WMS）；以及任意粘贴的瓦片服务（存为"自定义"底图）。
6. **ArcGIS 工程导入**：.aprx/.mapx/.lyrx 恢复图层+颜色，服务图层自动下载，本地数据随 .gdb.zip 一起选即自动配对上色；.mpkx/.ppkx 一键解包；.gdb.zip 直读；.mxd 扫描路径；DXF/MIF/TAB/SQLite 走 GDAL。
7. **Agent 工具（Agent-first）**：`list_data_sources`、`load_sample_data`、`fetch_osm_data`（地名/bbox/当前视图）、`fetch_admin_boundary`、`import_from_url`、`set_online_basemap`；`import_arcgis_project` / `list_supported_formats` 改为真实能力说明。系统提示词告诉 Agent"用户没数据时主动取数并注明来源"。

### P1（下一批，建议 1–2 周）
- **GeoAgentPro（ArcGIS Pro 插件）→ 手机推送**：插件"发送到手机"= 导出当前地图为 .mpkx/GeoPackage + 二维码短链，手机扫码导入（tiphys.xyz 临时中转，24 h 过期）。
- **二维码/分享链接导入**：`tiphys.xyz/tiphys/?import=<url>` 深链 + Android 分享菜单（intent-filter 接收 .geojson/.kml/.zip/.gpkg）。
- **DEM 下载为分析栅格**：AWS Terrarium 瓦片按当前视图拼 GeoTIFF（让水文/坡度工具一键可用）。
- **GPS 野外采集**：点/轨迹记录、属性表单、离线缓存，导出 GPKG/KML。
- **WMTS 能力文档选择图层 UI**、WMS 图层多选；ArcGIS 私有服务 token 登录。
- 示例工程扩展：中国省级区划（标准地图审图号来源）、城市案例（水文/生态/选址）各一套 + 一键"演示任务卡"。
- 桌面 Tauri 引擎路由这 6 个数据工具（目前仅浏览器/APK 引擎实现）。

### P2
- APRX 唯一值/分级渲染、标注、图层顺序完整还原；地图布局 → TIPHYS 布局。
- GDAL 离线包（APK 可选下载，不依赖 CDN）；栅格 .gdb/镶嵌数据集。
- QGIS .qgz/.qgs（ZIP+XML，图层数据源与简单符号）。
- 云盘直连（Google Drive / OneDrive / 坚果云 WebDAV）；GEE 公开数据集样例（需授权）。
- 数据目录服务端索引（中国区可达的镜像：天地图需 key、OSM 中国镜像）。

## 4. 支持格式表

| 来源/格式 | 状态 | 说明 |
|---|---|---|
| GeoJSON / GPKG / FGB / KML / KMZ / GPX / GML / GeoParquet / TopoJSON / CSV / GeoTIFF | ✅ 可用 | 原有 GeoLibre WASM |
| Shapefile（zip 或多文件） | ✅ 可用 | 原有 |
| File Geodatabase（.gdb 压缩 zip） | ✅ 可用 | GDAL WASM，首次联网下载 ~40 MB；只读矢量 |
| .mpkx / .ppkx / .lpkx（7z） | ✅ 可用 | 内含 .gdb/.shp/.tif/.mapx 自动读取 |
| .aprx / .mapx / .lyrx | 🟡 部分 | 图层清单、数据源、单一符号颜色、服务图层下载；复杂渲染/标注/布局未还原 |
| .mxd | 🟡 部分 | 仅数据路径与服务地址 |
| ArcGIS REST FeatureServer/MapServer 图层 | ✅ 可用 | 分页，上限 20,000 要素 |
| 切片/动态 MapServer、ImageServer | ✅ 底图 | 非 Web 墨卡托切片会提示可能错位 |
| ArcGIS Online / Portal 公开条目、Web 地图 | ✅ 可用 | 需登录的条目暂不支持 |
| WMS / XYZ | ✅ 底图 | WMS 默认取首个命名图层 |
| WMTS | 🟡 部分 | 取首个图层与 3857/Google 矩阵集 |
| DXF / MIF / TAB / SQLite | 🟡 部分 | GDAL；TAB 需附属文件 |
| OSM（Overpass / 切片提取） | ✅ 可用 | ODbL 署名；切片提取几何按切片裁切 |
| 行政边界（Nominatim） | ✅ 可用 | OSM 边界，非官方标准地图 |
| QGIS .qgz | ⏳ 计划 P2 | |
| GeoAgentPro 推送 / 二维码 / 分享菜单 | ⏳ 计划 P1 | |
| DEM 分析栅格 / GPS 采集 | ⏳ 计划 P1 | |

## 5. 诚实限制
- Overpass 公共实例不稳定；回退的切片提取只含底图样式里有的字段。
- GDAL 来自 jsDelivr CDN，无网/被墙时 .gdb/.mpkx 中的 gdb 无法读取（提示明确）。
- Web 版 URL 导入受 CORS；APK 不受限。
- 世界国界使用 Natural Earth 中国视角版，属示意，**非审图号标准地图**。
- 桌面 Tauri 版的 Python 引擎尚未实现 6 个数据工具。

## 6. 验证
- `npm run test:ecosystem`（6/6）：aprx/lyrx/mxd 解析、Esri JSON、Overpass 转换、URL 分类。
- `scripts/onboarding-verify.mjs`（真实网络，iPhone 12 视口 + 桌面）10/10：首启弹出、示例工程、定位附近、FeatureServer、OSM 当前视图、行政边界、APRX+GDB、mpkx、lyrx、桌面弹窗。截图 `docs/screens/onboarding/`。
- Agent 工具在浏览器中实测：list/load_sample/import_from_url/fetch_admin_boundary/fetch_osm_data/set_online_basemap 全部返回真实图层。
