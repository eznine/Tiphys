# TIPHYS 独立产品 MVP 说明书

> 由 Cursor canvas `6deeed4c-8457-439c-8b59-0800ee6d5f39` 转为 Markdown（2026-10-23）。
> Agent 一等公民的 GIS/遥感桌面产品：Tauri + TypeScript 壳与编排，Python 空间引擎，GEE 一等能力；现代 AI 产品风设计语言；与 GeoAgentPro 并行。

## 产品定位

**一句话：** TIPHYS 不是第二个 ArcGIS / QGIS，而是以 Agent 为主体、把地图、本地空间工具和 GEE 当一等公民的桌面产品。

用户用自然语言下任务；系统优先调用稳定工具，而不是每次现写脚本。地图能看见；进度可见。品牌气质是领航者：目标由用户定，TIPHYS 规划路径并交付可检查成果（From Intent to Outcome）。神话只解释名字，不抢产品戏。

| 项 | 值 |
|---|---|
| 产品名 | TIPHYS |
| 主体 | Agent（对话 / 任务 / 工具编排） |
| 眼睛 | 地图 + 图层树 + 属性 |
| 手 | 本地命名工具 + GEE |
| 首发平台 | Windows 必保；Linux 上开发 |
| 后期 | 网页版可跟；手机非 MVP |

## 已定技术栈

| 层 | 选型 | 职责 |
|---|---|---|
| 桌面壳 | Tauri | Windows 安装包；本机文件与进程 |
| UI / 地图 | TypeScript + MapLibre（或同类） | 对话、图层、符号化、拖放 |
| Agent 编排 | TypeScript | 会话、工具芯片、进度、与引擎 RPC |
| 本地空间引擎 | Python | GDAL / rasterio / GeoPandas / Whitebox 等 |
| 云端遥感 | GEE（已有插件经验） | 检索、计算、导出；进度卡与本地工具同构 |
| GeoAgentPro | C# 插件继续 | 并行；工具契约对齐 |

同族参考：GeoLibre = Tauri + React/TS + MapLibre +（可选）Python sidecar。我们同族、Agent 优先。RustGIS = 纯 Rust + egui，偏造完整 GIS，MVP 不跟它重写内核。

## 设计语言

**已定方向：** 现代 AI 产品风：对话为主、地图铺满、深浅两套主题；气质是领航者，不是希腊神话主题站。

界面像现代 AI 工作台，不像传统 GIS 满屏菜单。Agent 对话是主交互面；地图占中心视野；工具栏极薄。品牌只带走「方向感、克制、可信」与 From Intent to Outcome；名字来源可放 About，首页不讲神话。

| 项 | 值 |
|---|---|
| 布局 | 中心地图 + 侧栏 Agent 对话（约 360px）+ 可选薄图层列表 + 顶栏极简 |
| 强调色 | 青绿导航色 #0D9488 → #14B8A6（主按钮、激活、任务「航线」进度） |
| 深色表面 | #0B1220 / #111827；地图在下 |
| 浅色表面 | #F8FAFC / 白；面板与聊天 |
| 字体 | Inter 或系统 UI 无衬线；路径/坐标才用等宽 |
| 圆角 | 卡片 10–12px；聊天气泡略软 |
| 动效 | 克制：任务进度用细「航线」推进；无花哨 AI 渐变 |
| 禁用 | 星空/古希腊柱/帆船主图标；空洞「无所不能」文案 |

| 区域 | 原则 |
|---|---|
| 对话区 | 气泡 + 工具芯片 + 可取消进度卡；Ask/Work 模式可切换 |
| 地图 | 铺满剩余空间；底图与图层对比度保证可读 |
| 任务进度 | 像航线推进，失败可辨，禁止假「用户已取消」 |
| 主题 | 顶栏一键深/浅；令牌进 CSS 变量，全壳共用 |

实现落点：`src/styles/tokens.css` 定义 CSS 变量；壳 chrome、聊天、进度卡全部读令牌，禁止散落硬编码色值。官网若另做，可共用同一令牌与气质，但产品 UI 不复刻营销站动画。

## Agent 运行时

**已定：** Vercel AI SDK 做多模型调用 + 自写薄 TypeScript Agent 循环（Node sidecar）；Python GIS 引擎做成 MCP server；长任务走 job 模式。

| 能力 | 做法 | 参考 |
|---|---|---|
| 多模型 | OpenAI 兼容接口，接自有 API / tierflow / 国产模型 | Vercel AI SDK |
| 工具契约 | 引擎以 MCP 暴露具名工具（buffer、gee_export_raster…） | MCP SDK |
| 长任务 | 立即返回 job_id，可查、可取消、有进度，无假超时 | DeepSeek Harness jobs |
| 上下文压缩 | 大输出落盘 → 旧工具调用摘要 → 约 80% 时交接摘要 | Goose / Codex / DeepSeek Harness |
| GIS 状态 | 每轮注入工作区快照：图层、坐标系、研究区、输出路径、GEE 任务 | TIPHYS 自定义 |
| 记忆 | 项目级 + 用户级 md 文件；向量记忆二期 | Codex / mem0 |
| 人工确认 | 覆盖、删除等动作前确认 | AI SDK / Cline |
| 恢复 | 事件日志按会话落盘，可续跑 | Codex rollout / openai-agents-js |

不整体采用 LangGraph 或 Mastra 当骨架；Claude Code 核心不开源，只借鉴其公开文档思路。对比细节见 `docs/AGENT_FRAMEWORK_COMPARISON.md`。

## MVP 必做

- [ ] 打开本地目录/简易工程，加载常见矢量与栅格（必做）
- [ ] 地图：底图、图层开关、缩放平移、点选属性（可视化）
- [ ] Agent 对话 + 工具芯片 + 可取消进度（Agent）
- [ ] 约 15–25 个本地命名工具（矢量 + 基础遥感）（分析）
- [ ] GEE：登录/会话、常用导出与进度（对齐现有插件路径）（GEE 必做）
- [ ] 结果回写图层树；路径与日志说得清
- [ ] 工具名/参数与 GeoAgentPro 尽量对齐
- [ ] 设计令牌 + 深浅主题壳 chrome（设计）
- [ ] Windows 安装包可装可跑

## MVP 明确不做

- 完整制图布局 / 出版级出图
- 拓扑编辑、复杂数字化
- 100% 打开任意 .aprx / .mxd 当 Pro 用
- 复刻 Esri GP 或抄闭源实现
- 企业多用户、手机 App（首期）
- 默认 codegen 代替命名工具
- 神话主题视觉（星空、古希腊、帆船主符号）

## 核心工具清单（含 GEE）

**原则：** Agent 调命名工具，不默认 codegen。id 尽量与 GeoAgentPro 对齐；引擎用 Python/GEE，不是 Esri GP。

**矢量（本地）**

| id（草案） | 做什么 | MVP |
|---|---|---|
| buffer | 缓冲 | 要 |
| clip | 裁剪 | 要 |
| intersect | 相交 | 要 |
| union | 合并/联合 | 要 |
| erase | 擦除/差 | 要 |
| dissolve | 融合 | 要 |
| select_by_attribute | 按属性选择 | 要 |
| select_by_location | 按位置选择 | 要 |
| reproject | 重投影 | 要 |
| export_vector | 导出 GeoJSON/GPKG/shp | 要 |

**栅格 / 遥感（本地）**

| id（草案） | 做什么 | MVP |
|---|---|---|
| raster_clip | 栅格裁剪 | 要 |
| zonal_stats | 分区统计 | 要 |
| ndvi | NDVI（或通用指数） | 要 |
| slope | 坡度 | 要 |
| reclassify | 重分类 | 次要 |
| export_raster | 导出 GeoTIFF | 要 |

**GEE（云端，必进）**

| id（草案） | 做什么 | MVP |
|---|---|---|
| gee_auth_status | 登录/会话状态 | 要 |
| gee_search_collection | 查影像集合 | 要 |
| gee_export_raster | 导出栅格到本地（进度卡） | 要 |
| gee_export_table | 导出矢量/表 | 次要 |
| gee_compute_index | 云端指数后再导出 | 次要 |
| gee_job_status | 查询导出任务 | 要 |

**图层 / 工程（壳侧）**

| id（草案） | 做什么 | MVP |
|---|---|---|
| add_data | 加载本地数据上图 | 要 |
| list_layers | 列图层 | 要 |
| remove_layer | 移除图层 | 要 |
| zoom_to_layer | 缩放到图层 | 要 |
| describe_layer | 属性/范围摘要 | 要 |

合计约 25 个草案；M2 先落地矢量 5 个 + add_data，M3 打通 gee_export_raster 竖切。

## GEE（必进）

**硬要求：** GEE 不是插件彩蛋，是独立 TIPHYS 的一等能力：对话可导出、有进度、结果能落本地并上图。

- 复用 GeoAgentPro 已验证的导出/队列/进度语义，搬到 Python/TS 契约
- MVP：认证、选影像/集合、导出栅格到本地、进度卡、失败可辨
- 不做：在 MVP 里重做完整 GEE Code Editor

## 能不能兼容 ArcGIS Pro？

**诚实边界：** 可以兼容「数据」和部分「图层含义」；不能承诺像 Pro 一样完整打开任意 .aprx / .mxd。

| 对象 | MVP | 说明 |
|---|---|---|
| shp / geojson / gpkg / geotiff… | 要 | GDAL 读写，和大家都一样 |
| 文件地理数据库 .gdb 要素 | 力争部分 | 开源可读一部分；复杂 annotation 等可能丢 |
| .aprx Pro 工程 | 不完整打开 | 二进制/专有；可做「导入图层列表/路径」类有限导入，不是 Pro 替身 |
| .mxd ArcMap | 不完整打开 | 同上；业界多为转换/部分读取，非一比一 |
| 图层文件 .lyrx | 后期 | 符号化可部分解析，非 MVP 承诺 |
| 在 Pro 里当插件跑 | 继续用 GeoAgentPro | 独立壳不替代 Pro 插件产品线 |

GeoLibre 等开源也是：格式靠 GDAL/DuckDB 等「很多」，工程文件靠有限导入，不是魔法兼容全 Pro。我们同样走「数据优先 + 有限工程导入」。

## 开源参考（不从零写）

**分工原则：** 通用 GIS 能力（缓冲、裁剪、合并、格式读写、渲染）直接复用成熟库与 GeoLibre（MIT）/ RustGIS（Apache-2.0）代码；TIPHYS 特色（Agent 规划调度、GIS 上下文、GEE 长任务、结果核验、对话×地图交互）自己设计，参考优秀开源做法重组。总标准：谁最好用谁——现成更好就直接照搬，只有确定能做得更好才自己写。

遵守各自许可证，引用处记入 THIRD_PARTY_NOTICES。

| 项目 | 我们借什么 | 不借什么 |
|---|---|---|
| GeoLibre | Tauri 壳思路、MapLibre、工具/sidecar 分层、格式清单 | 整站产品叙事与商标 |
| RustGIS | 命令化工具、图层分层思路（可选读） | 纯 Rust 重写内核当 MVP |
| QGIS | Processing 工具分类、UX 习惯、格式期望 | C++ 桌面整套移植 |
| GeoAgentPro | Agent 编排、GEE 导出进度、中文工作流 | 对 Esri API 的硬依赖 |

## 核心能力竖切

1. **加数据** — 本地矢量/栅格上图
2. **本地工具** — 对话完成缓冲等，有进度
3. **GEE 导出** — 对话导出落盘并上图，有进度
4. **结果回写** — 图层树 + 路径摘要

## 与 GeoAgentPro 的关系

- 插件继续服务「人在 Pro 里」的用户
- 独立 TIPHYS 服务「不装 Pro 也能 Agent×GIS×GEE」
- 对齐工具 id / 参数 / 进度字段，工作流可迁移

## 建议里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 | Tauri 空壳 + 地图白屏 + Python ping + 设计令牌壳 | 进程通；深浅主题可切 |
| M1 | 本地图层可见 + 属性 | 拖 shp/tif 可见 |
| M2 | Agent + 5 本地工具有进度 | 对话完成缓冲等 |
| M3 | GEE 导出竖切（进度+落盘+上图） | 对话导出成功 |
| M4 | 再补本地遥感工具 + Windows 包 | 本机可演示 |
| M5 | 格式矩阵 v0 +（可选）有限 aprx 图层导入实验 | 文档写清能/不能 |
