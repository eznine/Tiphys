# 证据台账与待核实清单

这份台账用来防止“调研印象”变成“产品事实”。原则很简单：源码能证明的写源码路径；官方文档能证明的写 URL 和日期；两者都没有的只能写待核实。对外发布、许可证复用、模型集成和竞品对比之前，必须逐项完成核实。

## 1. 已经核对的本地事实

| 事实 | 证据 |
|---|---|
| 当前 `main` 已与 `origin/main` 同步，生产构建通过 | `git status`、`npm run build`（2026-10-24） |
| Python 引擎有 34 个 MCP 工具 | `engine/tools.py` 中 `@mcp.tool` 计数为 34 |
| Python 引擎提供 buffer/clip/dissolve/reproject，没有 zonal statistics | `engine/tools.py` 第 77、99、143、277 行；全仓检索无业务实现 |
| 浏览器路由提供 buffer/clip/dissolve/reproject，没有 zonal statistics | `src/lib/browser/engine.ts` 第 664-720 行附近 |
| 浏览器 Agent 只把非 `wasm_` 工具作为一等工具，WASM 通过搜索和 `run_browser_tool` 调用 | `src/lib/browser/agent.ts` 的 `runTurn` |
| 桌面 Node Agent 的工具全部来自 Python MCP | `agent/src/server.ts` 第 124-159 行；`agent/src/mcp.ts` 的 `EngineMcp.connect` |
| 浏览器图层存 IndexedDB，包含原始字节和显示 GeoJSON | `src/lib/browser/engine.ts` 的 `LayerRecord`、`adopt` |
| Python 图层存工程工作区与文件，前端通过 `DataLayer` 渲染 | `engine/layers.py`、`engine/data/workspace.json`、`src/lib/dataLayers.ts` |
| 前端图层模型缺少来源引擎、父任务、数据版本、验证状态等字段 | `src/lib/dataLayers.ts` 的 `DataLayer` |
| 浏览器与 Python 各自实现 job 轮询、取消和错误 | `src/lib/browser/agent.ts` 的 `callTool`、`engine/jobs.py` |
| 工具破坏性规则写在 Agent 逻辑中，不由注册表声明 | `src/lib/browser/agent.ts` 的审批判断、`agent/src/server.ts` 的确认逻辑 |
| 浏览器目录已 hydrate 958 个 WASM schema，合并工具数为 997 | `src/lib/browser/catalog-schema.ts`、`docs/CLIENT_PARITY.md` |
| 现有测试覆盖浏览器工具、地图渲染与 Agent 集成 | `tests/browser-engine.test.ts`、`tests/map-render.test.ts`、`agent/tests/*.test.ts` |

这些事实足以支撑方案中的核心判断：工具目录已有合并，但工具契约、图层注册、任务状态和结果验证尚未统一。

## 2. 尚未核实的外部事实

以下内容在 `02`、`03`、`04` 中作为方向性判断使用，不能当作已证实事实。

| 待核实项 | 为什么重要 | 核实方式 |
|---|---|---|
| Linkage Mapper 当前版本、许可证、ArcPy 依赖、各工具输入输出 | 决定能否复用代码或只能复用流程 | 打开官方仓库 LICENSE、README、工具箱源码与示例数据；记录 commit |
| Circuitscape/Circuitscape.jl/Omniscape 的许可证、Julia 依赖、运行方式 | 决定接入桌面还是远程，是否能打包 | 核对官方仓库 LICENSE、安装文档与最小示例 |
| InVEST 当前模型清单、许可证、依赖与输出定义 | 决定生境质量/碳储量能否独立集成 | 核对官方仓库与文档；用样例数据跑通一个模型 |
| pylandstats、GUIDOS、Fragstats 的许可与可复用性 | 决定景观指数/MSPA 的实现路线 | 查仓库 LICENSE 与源码；Fragstats 需确认商业许可 |
| STAC/COG/PMTiles/GeoParquet/DuckDB Spatial 的当前推荐用法 | 决定遥感与大数据的数据层选型 | 查官方文档与最小样例，避免过时方案 |
| QField、Mergin Maps Input、ODK/Kobo 的许可证、同步服务与离线机制 | 决定借鉴程度与是否可复用代码 | 查仓库/LICENSE 与官方文档；区分客户端与服务端许可 |
| Esri Field Maps/Survey123、ArcGIS Pro AI 能力的当前边界 | 竞品对比与需求验证 | 查官方文档与版本说明，避免引用旧版本 |
| CARTO AI Agents、Felt AI、Atlas、Aino 的当前功能与数据处置 | 竞品定位，不可凭营销词下结论 | 查官方文档、演示与隐私条款 |
| 开源自主 GIS 项目的真实代码与评测 | 判断“代码生成型”路线的可靠性 | 找到论文配套仓库，读源码与实验设置 |
| 移动浏览器后台定位、Web Bluetooth、OPFS、推送的当前支持 | 决定手机端能力承诺 | 在目标 iOS/Android 机型实测，并记录系统/浏览器版本 |
| GEE 授权、配额与导出队列的当前政策 | 未来远程执行设计 | 查官方文档与真实授权测试，不在未验证时宣称接通 |

## 3. 不允许提前写进产品文案的说法

在核实完成前，不应写“完整支持 Linkage Mapper”“与 InVEST 结果一致”“支持 Circuitscape 夹点分析”“手机支持 RTK/NTRIP”“GEE 已接通”“跨引擎结果完全一致”。可以写“按 Linkage Mapper 的工作流思路实现”“提供生境质量模型”“计划支持电流连通性”“记录定位精度”“GEE 处于未配置/演示状态”“在同一语义下做容差对照”。

## 4. 外部资料补齐后的处理方式

每补齐一项，在本台账新增一行来源 URL、核对日期、版本/commit 和结论，并回写到对应报告。许可证结论要写明具体条款与义务，不能只写“开源”。竞品能力要区分官方文档、演示视频和实际试用。领域模型要用样例数据跑通后才从“待核实”改为“已验证”，并记录输入数据、参数和输出。

## 5. 下一步核实顺序

先核实与第一条领域包直接相关的 Linkage Mapper、Circuitscape 和 InVEST，因为它们决定生态廊道能不能做成可信工作流；同时核实 Whitebox 成本距离/回溯/廊道的当前参数契约，避免在错误的工具语义上搭流程。随后核实手机端 QField/ODK 与浏览器能力，确定外业闭环的最小实现。竞品资料放在产品定位阶段补齐，不阻塞底层任务底座。最后再评估 STAC/COG、DuckDB 和 GEE，避免数据平台选型先于真实任务。

核实的完成标准不是“看过网页”，而是有可复现的证据：许可证文件、源码路径、官方文档链接、样例运行结果或目标设备实测记录。只有达到这个标准，报告中的“待核实”才可以删除。
