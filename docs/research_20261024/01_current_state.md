# TIPHYS 当前实现核对（2026-10-24）

本文只记录能从当前仓库源码和项目文档核对到的事实，不把产品设想写成已实现。核对对象是 `F:\tiphys` 当前 `main`（与 `origin/main` 同步），构建已通过 `npm run build`。

## 1. 两套运行路径

TIPHYS 目前不是一个统一的 Agent 同时操作所有引擎，而是两条并行路径。

| 路径 | Agent 位置 | 工具来源 | 数据存储 | 任务与审批 |
|---|---|---|---|---|
| 纯浏览器 | 页面内 AI SDK 循环（`src/lib/browser/agent.ts`） | 浏览器工具目录；WASM 通过 `search_browser_tools` 再 `run_browser_tool` 调用 | IndexedDB（`src/lib/browser/storage.ts`、`engine.ts` 的 `LayerRecord`） | 浏览器内 job 轮询、审批、SSE 事件 |
| Tauri 桌面 | Node Agent sidecar（`agent/src/server.ts`） | Python 引擎的 MCP 工具（`agent/src/mcp.ts` 调 `listTools()`） | Python 引擎的工作区与分析文件；显示层由前端接收图层事件 | `engine/jobs.py` + Agent 轮询；审批在 sidecar 与前端 |

桌面版手动工具箱可以在 WebView 里运行 GeoLibre WASM，也可以走 Python MCP；但桌面 Node Agent 自己只看到 MCP 工具。也就是说，**同一个桌面窗口里，用户手动能调用的 WASM 工具，Agent 不一定知道**。这是统一调度要解决的核心事实之一。

## 2. 工具目录与工具可见性

浏览器工具目录由壳层工具、Polyglot/WASM schema 和扩展工具合并。`CLIENT_PARITY.md` 记录的运行时数量是 958 个 WASM schema、997 个合并工具、工具箱显示 993 个（隐藏 4 个引擎控制项）。当前 `src/lib/browser/catalog-schema.ts` 仍把 958 个 schema 分批 hydrate；首屏只有较小的壳层目录。

浏览器 Agent 的 ToolSet 构建方式很清楚（`src/lib/browser/agent.ts` 的 `runTurn`）：

```ts
for (const t of browserCatalog.filter(t => !t.name.startsWith("wasm_"))) {
  tools[t.name] = tool({ ... execute: callTool(...) })
}
tools.search_browser_tools = ...
tools.run_browser_tool = ...
```

这意味着 WASM 工具不是一等工具，Agent 必须先用自然语言搜索，再按返回的 schema 调用。优点是上下文小；缺点是 Agent 不能从统一注册表中直接按能力选择引擎，也无法在计划阶段可靠知道某个 WASM 工具的参数约束。

Python 引擎当前有 34 个 MCP 工具（`grep -c "@mcp.tool" engine/tools.py` 得到 34），覆盖数据导入与图层管理、buffer/clip/intersection/union/erase/dissolve/convex hull/simplify/select/spatial join/field statistics/reproject/export/calculate geometry、视图命令、符号化与标注、格式与 ArcGIS 工程导入、GEE 状态与演示导出、job status/cancel、remove layer。Node Agent 通过 MCP 把这些工具直接放进 ToolSet（`agent/src/server.ts` 第 132 行起），没有浏览器 WASM 工具。

## 3. 五个试点操作的实际能力

| 操作 | Python MCP | 浏览器 WASM 路由 | 当前语义与风险 |
|---|---|---|---|
| Buffer | `buffer(layer, distance, units, dissolve, output_name)` | `buffer` → `buffer_vector`，先按米制距离选择投影，再缓冲 | Python 与浏览器都做了米制投影，但投影选择、象限段数、端帽/连接样式未必一致；需要双引擎容差测试 |
| Clip | `clip(layer, mask_layer, output_name)` | `clip` → 面裁剪；点图层走精确相交选择；线/多点/混合类型裁剪尚未接入 | 浏览器能力不完整；不同 CRS、无效几何、字段保留规则没有统一契约 |
| Reproject | `reproject(layer, target_crs, output_name)` | `reproject` → 只接受 `EPSG:编号`，执行真实坐标转换 | 浏览器限制格式；分析 CRS 与显示 CRS 的分离已有基础，但输出精度和元数据未统一验证 |
| Dissolve | `dissolve(layer, by_field, output_name)` | `dissolve` → GeoLibre `dissolve`，可选 `dissolve_field` | 属性聚合规则、单部件/多部件、空分组没有统一说明 |
| Zonal Statistics | 没有 | 没有 | 五个试点中唯一需要新增实现的能力；不能用其他工具伪装 |

这四个已有操作的名字相同，但参数并不是同一份契约。例如浏览器 `buffer` 的内部参数是 `quadrant_segments: 16`，Python 侧由 Shapely/GeoPandas 默认行为决定；两者在曲线近似和投影选择上可能有差异。统一工作必须先固定语义和容差，再谈“同一工具”。

## 4. 图层与工作区

前端统一渲染使用的 `DataLayer`（`src/lib/dataLayers.ts`）字段很少：`id`、`name`、`url`、`geometry_types`、`feature_count`、`bounds`、`crs`、`visible`、`style`，加上 `kind` 与栅格显示字段。它能满足地图渲染和属性表，但不足以让 Agent 判断数据来源、引擎位置、数据版本、父任务和验证状态。

浏览器 `LayerRecord`（`src/lib/browser/engine.ts`）保存原始字节、扩展名、GeoJSON 显示副本、栅格预览，图层 ID 形如 `lyr_<uuid>`，并写入 IndexedDB。Python 引擎的资料在 `engine/layers.py`、`engine/data/workspace.json` 与每个图层的 `.gpkg/.geojson` 中，ID 也采用 `lyr_...` 形式，但两边是独立注册表。项目文档明确说明分析数据保留原始 CRS、显示数据是独立 WGS84 GeoJSON，这是正确的基础，但统一注册表还没有建立。

图层事件通过 `layer-added`、`layer-updated`、`layer-removed`、`layers-reordered` 驱动 UI。浏览器 Agent 与手动工具都走这套事件（`src/lib/agent.ts` 的 `mergeToolResult`）；桌面 Agent 的工具结果由 sidecar 发事件，前端再同步。事件能保持界面一致，但不等于统一的跨引擎数据目录。

## 5. 任务、审批与错误

Python 引擎的 job 由 `engine/jobs.py` 管理，工具可以立即返回 `job_id`，Agent 轮询 `job_status` 并显示阶段、百分比和消息；取消走 `job_cancel`。浏览器引擎用内存 `running` Map + IndexedDB job 记录，Agent 在 `callTool` 里每 200ms 轮询，取消通过 `cancelBrowserJob`。两端都有长任务体验，但状态字段、错误格式、取消语义、重启后的 interrupted 处理并不完全一致。

审批方面，浏览器 Agent 在 `remove_layer`、`export_features` 前发审批卡；桌面 sidecar 自己维护审批归属和拒绝/过期逻辑，并有集成测试覆盖。审批规则目前写在 Agent 的破坏性工具列表中，不是工具注册表的能力标记。这也是统一契约应接管的内容。

## 6. 已有的可靠性基础

现有系统并非从零开始。统一任务底座可以直接复用这些已经过测试的能力：会话事件与恢复、上下文压缩与工具输出溢写、人工审批与归属校验、Python 引擎的 job 状态机与取消、浏览器 job 轮询与结果图层事件、项目/用户记忆注入、真实模型与 mock 两条测试路径。桌面 Agent 的集成测试覆盖服务重启、断线补取、审批归属和停止对话；这些测试是渐进迁移的安全网，不能在统一调度重构中丢弃。

## 7. 对方案的直接影响

第一，统一工具不能从“给 958 个 WASM 工具逐个写 Python”开始。正确顺序是先把通用操作契约化，并让专用工具保留原生能力；五个试点正好覆盖四类已有能力和一类缺口。

第二，统一图层必须补全“数据在哪里、属于哪个引擎、由什么任务产生”。前端 `DataLayer` 可以继续作为渲染模型，但 Agent 需要一个更完整的注册表，而不是从 `url` 和名称猜测。

第三，桌面 Node Agent 与浏览器 Agent 的合并不能靠一次性重写。应先共享工具契约、验证器、结果模型和任务状态，再决定哪个宿主负责编排；现有 Node 会话与审批能力在达到同等替代前必须保留。

第四，结果验证目前几乎完全依赖工具自身返回的 `ok` 与异常，没有统一的任务验收。五个试点应同时产出验证报告，才能证明“完成”而不是“调用成功”。
