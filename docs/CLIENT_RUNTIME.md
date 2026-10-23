# 客户端运行时：浏览器与 Tauri 混合模式

核对日期：2026-10-24。本文只描述当前代码实际走通的路径；工具数量以运行时工具箱显示为准。

## 运行时选择

`src/lib/runtime.ts` 用 `!isTauri()` 区分两个入口：

| 形态 | 判定 | 空间引擎 | Agent | 持久化 |
| --- | --- | --- | --- | --- |
| 纯浏览器 | 普通网页，`isTauri() === false` | 页面内 GeoLibre WASM | 浏览器内 AI SDK 循环 | IndexedDB |
| Tauri 混合 | 桌面 WebView，`isTauri() === true` | Python 本地 sidecar + WebView WASM | Node Agent sidecar + Python MCP | 桌面应用数据目录 / 项目 `.tiphys` |

纯浏览器不要求 Python、Node 或本地端口。Tauri 启动时会拉起 Python 引擎与 Node Agent；桌面 Agent 的工具循环仍通过 MCP 调用 Python 工具。

## 目录合并

- 浏览器：首屏先显示 39 个公共/扩展工具壳层；动态加载 958 个 GeoLibre WASM schema 后，合并目录为 997 个。工具箱隐藏 `ping`、`list_layers`、`job_status`、`job_cancel` 四个引擎控制项，因此正常可见 993 个。
- Tauri：`/tools/catalog` 先读取 Python MCP 工具，再合并同一批 WASM schema、公共工具和扩展；当前联合目录同样是 997 个，工具箱可见 993 个。
- 两端的搜索都按工具名、中文名、类别/子类和说明排序；分类和子类命中会加权，避免只靠英文描述命中。

## 首屏与 Worker 预热

- MapLibre 的 worker 通过 `?url` 显式指向 Vite 产出的 `maplibre-gl-worker.mjs`，开发服务器和生产构建都走同一路径。
- 地图创建、点击选择、AOI 渲染和已有数据图层在首屏完成；导航/比例尺控件、地形源和空地图引导动画延迟到首个 idle/`requestAnimationFrame` 之后，避免和第一次绘制抢主线程。
- 浏览器会在首次指针/键盘交互或首个 idle 窗口调用 `warmWasmToolRunner()`。它在后台 worker 中预编译 `geolibre-cli.wasm`，成功后进入最多 1 个 worker 的空闲池；`releaseIdleWasmToolWorkers()` 会终止空闲或正在预热的 worker。
- 工具目录先渲染壳层，再在下一帧开始分块 hydrate；转换期间每 48 个 schema 让出主线程。工具箱只显示骨架/加载文案，不在首开时同步解析整份清单。

## 执行路径

- 纯浏览器的 `/tools/run`、图层、任务、导出和 Agent 请求均由 `src/lib/browser/*` 在页面内处理。
- Tauri 的 `wasm_*` 工具仍进入 WebView Worker；其他 MCP 工具进入 Python sidecar。浏览器任务 ID 在 WebView 内继续轮询，避免刷新后错误地转给 Python。
- 桌面 Agent 只获得 MCP 工具；工具箱中的 WASM 工具是同一工作区的手动并行入口。两端共享结果图层事件和地图渲染，但不把 WASM 结果伪装成 MCP 产物。
- 浏览器不能读取任意电脑路径。样例 `samples/beijing_points.geojson` 可用，其他文件必须通过文件选择器加入。

## 引擎徽标

| 徽标 | 含义 |
| --- | --- |
| `Browser-WASM` | 页面内 WASM 引擎 ping 成功；不需要 Python，数据保存在此浏览器。 |
| `Python · N ms` | Tauri 的 Python sidecar ping 成功，N 是往返延迟。WASM 工具仍在 WebView Worker 内运行，因此这是混合运行时，不是“所有计算都在 Python”。 |
| `未连接` | 当前运行时 ping 失败；查看运行日志中的引擎与 Agent 状态。 |
| `…` | 首次 ping 尚未返回。 |

顶栏徽标和底部状态栏使用同一健康检查；底部还会显示实际图层数量、坐标与级别。

## 记忆与上下文

- Tauri Agent 每轮读取项目 `.tiphys/MEMORY.md` 和用户 `~/.tiphys/memory.md`。
- 浏览器 Agent 读取构建时打包的项目 `.tiphys/MEMORY.md`，并在设置“工作区记忆”中说明该差异。
- 浏览器上下文达到预算时先精简旧工具输出并在 IndexedDB 留档，再按 80% / 最近约 16% 的比例生成交接摘要；当前 GIS 图层列表始终保留在系统提示中。
- 压缩交接额外保留 AOI 经纬度 bbox、当前选中图层、图层名称/类型/数量/坐标系，以及最近工具名，避免下一轮重复运行已完成的走廊、水文、最小成本或 AOI 任务。
- 本批改动不新增密钥；现有运行时凭据文件已被 Git 忽略，不要提交 `.tiphys/` 下的会话、spill 或凭据。

## 工作区快照与符号化

- 浏览器把轻量工作区元数据写入 `localStorage["tiphys-workspace-v1"]`，schema 为 `tiphys.workspace`、版本 `1`。内容包括图层 ID/名称/类型/可见性/几何类型/要素数/坐标系、顺序、当前选中图层、AOI bbox、属性表图层和最多 2500 个选中要素 ID；超出时标记截断。
- 快照**不包含** GeoJSON、GeoTIFF、栅格预览 PNG 或任何分析结果字节。纯浏览器形态的图层字节与预览仍由 `tiphys-browser-v1` IndexedDB 保存；桌面形态由本地引擎/应用数据目录负责。快照只恢复能被当前运行时真实列出的图层，缺失图层会被清除，不伪造恢复成功。
- 页面加载后会校验快照；恢复的 AOI、选中图层和要素选择意图会随下一次 Agent `/chat` 的 workspace 上下文进入系统提示与压缩交接。要素选择只携带图层 ID、总数和最多 120 个要素 ID（超出时标记截断），不会把完整选择集塞进提示词。主题仍使用原有 `tiphys-theme` 键，符号样式仍写入 `tiphys-layer-styles`。
- 矢量符号面板支持填充/描边颜色、整体与分项不透明度、点半径、线宽、唯一值分类和蓝/蓝灰/大地色带。栅格面板支持不透明度与自动/柔和/强对比线性拉伸；拉伸只改变 MapLibre 显示，不重算像元或改写 GeoTIFF。
- 地图左下的紧凑图例只列出可见图层，展开后可回到对应符号面板；没有可见图层时不渲染图例。

## tiphys.xyz

静态 SPA、WASM 缓存头、COOP/COEP 取舍和部署后冒烟检查见 `docs/DEPLOY_TIPHYS_XYZ.md`。
