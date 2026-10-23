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

- 浏览器：`browserToolCatalog` 合并公共工具、958 个 GeoLibre WASM schema 和已注册扩展。工具箱标题中的数字是合并去重后的实际加载数，不是宣传口径。
- Tauri：`/tools/catalog` 先读取 Python MCP 工具，再合并 WASM schema、仅壳层工具和扩展。工具箱可见数量因此是运行时联合目录。
- 两端的搜索都按工具名、中文名、类别/子类和说明排序；分类和子类命中会加权，避免只靠英文描述命中。

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
- 本批改动不新增密钥；现有运行时凭据文件已被 Git 忽略，不要提交 `.tiphys/` 下的会话、spill 或凭据。
