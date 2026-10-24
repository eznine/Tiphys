# TIPHYS 交接文档

> **2026-10-24 起：所有开发以 [docs/MASTER_ROADMAP.md](docs/MASTER_ROADMAP.md) 为最高依据**——阶段与 Ticket 顺序（T-001 起）、架构契约、验收门槛、明确不做清单。本文件以下内容为历史交接记录。

> 2026-10-24 阶段 4（部分完成：系统评测 + 手机）：**首批模型在环基线**——Playwright 驱动真实网页 + 内置 tierflow_pro，30 项固定任务 **28/30 PASS**（P50 37s/P95 84s，输入 35 万 tokens；判据只看可观测事实，`tests/baseline/agent-success.json` + `npm run baseline:agent`）。两个失败样本（M09/M11）归因一致：8 步静态上限被 9 次检索消耗 + WASM 参数名（d8_pntr）对模型不友好——预算制改革的直接数据支撑。**手机任务卡**：桌面/手机同源 TaskCards（5 预设：缓冲/裁剪/求交量算/字段统计/DEM 坡度），执行前说明引擎与 2M 像素预算、跑完给验收明细与导出；iPhone 12 仿真（390×844）**7/7 场景**闭环含超预算拒绝、同层阻止、运行中短暂后台恢复（`npm run baseline:mobile`）。map-render 补 Windows Chrome 路径后 browser 套件 **70/70**。**未完成**：A/B 双臂对照、≥3 次方差、GeoAgentBench 适配、真机——见 `docs/STAGE4_REPORT.md` §5。注意：tasks.json 追加了 `dem_over_budget` fixture（sha256 已变，engine 步骤未动）。

> 2026-10-24 阶段 3（自适应调度与审计闭环）完成：`shared/plans.ts` 落地"模型写 Plan、确定性执行器跑"的分工——计划期整体校验（不支持/坏参数/幽灵引用/未确认的删除导出一律 0 步执行即拒绝，附降级方案）、逐步输入输出 sha256 入账、验收门失败=VALIDATION_ERROR 不假成功、IndexedDB 检查点 + 断点恢复（成功前缀复用不重跑）、统一错误分类六类（浏览器 `classifyError` 与 Python `engine/jobs.py:error_class` 同表）。引擎新增 `run_plan/plan_list/plan_get` 三个 shell 工具（目录 1001）与 `GET /plans` 审计路由；修复一个真实死锁（计划 job 持 GIS 锁时步骤嵌套 job 互等，改为 `runEngineStep` 内联执行）。基线：11 个真实 3–4 步任务（12 次运行）11/11 通过，auditRuns 0 违规，输出图层摘要由子进程独立重算复验（`npm run baseline:plans`）。回归：plans 14/14、browser 69/70（Chrome 环境缺口）、agent 23/23、engine 38 全通过。NOT_TESTED：模型在环成功率（阶段 4）、桌面计划执行器、回放 UI。完整证据见 `docs/STAGE3_REPORT.md` 与 `docs/baselines/stage3/`。

> 2026-10-24 阶段 2（T-005…T-009）完成：检索质量用 207 条标注实测（自然句 Top-1 87.1%/Top-5 100%、别名 100%、gap 误召回 9.1%，见 `docs/SEARCH_QUALITY.md` 与 `docs/baselines/stage2/search-eval.json`）；五操作契约（buffer/reproject/clip/dissolve/zonal_statistics）与 `OPERATION_SUPPORT` 能力矩阵落地，不支持的操作在计划阶段带原因与降级路径拒绝；8 张方法卡（`src/lib/methods.ts` + `docs/METHODS.md`）与工具目录分开检索；**浏览器 `dissolve` 确认不可用**（D1 脏 FGB 投影 + D2 `vector_info` panic），三种绕行方案均被证据否决并回退，基线保留 6/6 ERROR。回归：browser 68/69（Chrome 环境缺口）、agent 23/23、engine 全通过、contracts 11/11、methods 4/4。完整证据与 NOT_TESTED 见 `docs/STAGE2_REPORT.md`。

> 2026-10-24 阶段 1（T-002/T-003/T-004 先行）：共享契约 `shared/contracts`（`LayerRef/OperationSpec/ProviderCapability/ExecutionRun/Validation`，版本 1）落地，浏览器与桌面 Agent 共用同一 `planOperation()`；两端新增只读 `inspect_layers`（真实存储位置、sha256、字段空值、栅格 NoData）；双引擎 buffer/reproject 对照 4 PASS / 2 DIVERGENT（dissolve 分组语义、负距离为空），见 `docs/CROSS_ENGINE_SEMANTICS.md`；桌面 Agent 通过 `wasm_run`（子进程 WASI）首次可直接执行 WASM 工具，端到端把 WASM 结果变成桌面图层（`npm run wasm:spike`）。证据与 NOT_TESTED 见 `docs/STAGE1_CONTRACTS_AND_WASM.md`。

> 2026-10-24 阶段 0（T-001）完成：工具目录对账 + 30 项可复现基线落地。新增 `scripts/export_engine_catalog.py`（FastMCP 真实内省）、`scripts/catalog-audit.ts`（各端可见性/同名对账）、`scripts/run-baseline.ts`（每任务独立进程 + 程序化断言 + 产物 sha256）、`tests/baseline/tasks.json`（10+12+8）与合成 fixtures。首轮结果 28 PASS / 2 ERROR，并定位 3 个真实缺陷：`dissolve` 继承退化 `snap_tolerance` 在投影 CRS 下产出损坏 FGB（D1）、`vector_info` 会在部分 FGB 上 panic 并毒化 WASM 实例（D2）、`buffer(dissolve:true)` 可组合性不清（D3）。完整证据与 NOT_TESTED 清单见 `docs/BASELINE_STAGE0.md`，目录矩阵见 `docs/CATALOG_AUDIT.md`。复现：`npm run audit:catalog`、`npm run baseline`。

> 2026-10-24 桌面版修复批次：① API 配置持久化加固——保存时镜像到 `~/.tiphys/agent.json`，新版本首次启动自动从已有 `%APPDATA%` 配置播种备份，重装/清理应用数据后自动恢复（agent 测试 18/18 覆盖镜像、恢复与首次迁移）；② 图层右键新增「显示/隐藏图层」和「删除图层」（二次确认，删除工作副本、不动原始文件）；③ 点击地图要素弹出属性卡（图层名、几何类型、要素 id、最多 8 个字段、跳转属性表）；④ Ribbon 从 158 个动作收敛为常用项，新增「搜索全部工具」直接跳转工具箱并带入关键词。桌面 portable 已重建并部署到 `C:\Users\alex\Desktop\TIPHYS`，实测原配置与 3 个图层跨更新保留。用户需求调研见 `docs/USER_NEEDS_RESEARCH.md`。

> 2026-10-24 续作：GeoLibre 工具目录全面接入浏览器运行时（958/1065 个，含栅格/地形/水文/遥感；LiDAR 与多值参数工具未接），全部 1065 个工具名称与描述已 100% 中文化；栅格图层基础显示（色带 PNG 预览 + image source）；图层重命名/拖动排序与属性字段统计双运行时完成。记录见 `docs/GEOLIBRE_TOOLS_20261024.md`。工作台剩余项（地图点选联动、字段统计）仍按 `docs/CLIENT_PARITY.md` 顺序推进。

> 2026-10-23 晚间续作：已按 ArcGIS Pro 参考图完善命令分组、内容树/图例、地图文档栏与状态栏、多行 Agent 输入，并加入 API/主题/密度/运行参数设置。禁止缺少凭据时自动回退 Mock。桌面副本已实际启动，验证 `tierflow_pro`、13 个密钥、真实查询、配置保存与重启恢复；最新产物和证据以 `docs/SETTINGS_WORKSPACE_20261023.md` 为准。Windows 桌面版是当前交付；1420 为依赖本机服务的浏览器开发预览，未部署公网网页版。

> 2026-10-23 续作更新：默认对话为主，常规操作以 ArcGIS Pro 为主要参考；已补分类工具箱、图层菜单、属性表、基础符号化/标注、Agent 地图工具及运行日志。真实 API 已验收。旧里程碑表保留为历史背景；最新能力对照见 `docs/CLIENT_PARITY.md`，本轮验证与交付见 `docs/WORKSPACE_STATUS_20261023.md`。

> 更新：下文保留项目背景和开发入口，里程碑经过 2026-10-23 的可靠性批次修正。当前实现、测试证据和 Windows 发布边界请以 `README.md` 与 `docs/RELIABILITY_STATUS.md` 为准。

> 2026-10-23 · 从 Linux 开发盒交接到 Windows（目标目录 `F:\tiphys`）。价值主张：**From Intent to Outcome**。

## 1. TIPHYS 是什么

以 **Agent 为主体** 的 GIS / 遥感桌面应用：用户用自然语言下任务，Agent 调用**具名的稳定工具**（不是每次现写脚本），地图实时显示结果、任务有可取消的进度。不是第二个 ArcGIS/QGIS，与 GeoAgentPro（ArcGIS Pro C# 插件）并行，工具 id/参数尽量对齐。

| 层 | 技术 | 目录 |
|---|---|---|
| 桌面壳 | Tauri 2 (Rust) | `src-tauri/` |
| 界面 | React + TypeScript (Vite) + MapLibre GL（地球 globe 投影 + 多底图） | `src/` |
| Agent sidecar | Node + Vercel AI SDK（`streamText` 工具循环），HTTP+SSE `127.0.0.1:8972` | `agent/` |
| 空间引擎 | Python FastAPI + MCP（FastMCP，挂在 `/mcp/`），`127.0.0.1:8971`，geopandas/shapely | `engine/` |
| 云端遥感 | Google Earth Engine — **计划中，未接** | — |

完整产品说明：`docs/MVP_SPEC.md`；Agent 架构细节：`docs/AGENT_ARCH.md`；框架选型对比：`docs/AGENT_FRAMEWORK_COMPARISON.md`；参考仓库：`reference/README.md`。

## 2. 各里程碑现状

| 里程碑 | 状态 |
|---|---|
| M0 壳 | ✅ Tauri 2 + React 壳、设计令牌、深/浅主题切换、引擎 `/ping` 打通 |
| 地球 / 底图 | ✅ MapLibre globe ↔ mercator 切换，多底图（无需 API key） |
| M1 本地图层 | ⚠️ 部分：Agent `add_data` 可加载 GeoJSON 等矢量；拖放加载、栅格、点选属性未做 |
| M2-lite Agent 循环 | ✅ 对话 → MCP 工具（ping / list_layers / add_data / describe_layer / buffer / job_status / job_cancel / remove_layer）→ 结果上图 |
| 长任务（buffer job） | ✅ 立即返回 `job_id`，Agent 轮询推进度，UI 进度卡可取消，无固定超时 |
| 人工确认 | ✅ `remove_layer` 及 `overwrite: true` 调用前弹确认卡 |
| 上下文压缩 | ✅ 工具输出溢写到 `.tiphys/spill/`；80% 阈值触发压缩；真实模型生成交接摘要，mock 模式使用记录型摘要 |
| 记忆文件 | ✅ `.tiphys/MEMORY.md`（项目级）+ `~/.tiphys/memory.md`（用户级）每轮注入系统提示 |
| 会话日志/恢复 | ✅ `.tiphys/sessions/<id>.jsonl` + checkpoint，重启恢复、界面重放 |
| M3 GEE | ❌ 未开始 |
| M4 Windows 安装包 | ✅ NSIS 安装版与便携 zip 均通过构建、安装（或解压）、启动、关闭、卸载验收；未签名，正式分发前需签名 |

## 3. 能用 vs 占位

**已验证可用**：mock 模型端到端；真实模型 tierflow_pro 跑通 “给 samples 里的点做 500 米缓冲”（ping → add_data → buffer → 上图）；坏 key 自动轮换（401/402/403/429/5xx）；取消任务；删除确认；工具输出溢写；压缩触发；会话重放。

**占位 / 已知问题**：
- AOI 字段始终为空（无画 AOI 工具）；GEE 未接。
- “哪些工具是破坏性”写死在 Agent 的 `DESTRUCTIVE` 中。
- 进度靠 Agent 轮询 `job_status`，未用 MCP progress 通知。
- mock 模型每次缓冲都会重复 add_data（出现同名图层）。
- 安装包与便携 zip 未签名；付费模型的 API 调用与摘要质量未在本批重新验收。

## 4. 下一步

1. **代码签名** → 付费模型调用验收 → 真实 GIS 工作流验证。
2. **GEE 竖切（M3）**：`gee_auth_status / gee_search_collection / gee_export_raster / gee_job_status`，复用 GeoAgentPro 的导出/队列/进度语义，走现有 job 模式。
3. **更多 GIS 工具**：clip / intersect / union / erase / dissolve / select_* / reproject / export_*、栅格 raster_clip / zonal_stats / ndvi / slope —— 优先从 RustGIS（接口）、GeoLibre（前端样式/图例/格式）、QGIS Processing（分类与参数习惯）、WhiteboxTools（栅格/地形）复用。

**交付约定（2026-10-23 起）**：每次产出可运行的桌面版本后，把便携版解压目录（`src-tauri/target/release/bundle/portable/TIPHYS-<版本>-x64`）整体复制为 **`C:\Users\alex\Desktop\TIPHYS\`**，用户从桌面双击 `tiphys.exe` 直接运行；NSIS 安装器与 zip 留在 `bundle/` 下作为存档。

## 5. 复用规则

**谁最好用谁。** 现成开源实现更好 → 直接复制，保留原许可证声明并登记到 `THIRD_PARTY_NOTICES.md`；只有确定能明显做得更好时才自己写。通用 GIS 能力（缓冲、裁剪、格式读写、渲染）用成熟库与 GeoLibre(MIT) / RustGIS(Apache-2.0)；TIPHYS 特色（Agent 调度、GIS 上下文、GEE 长任务、对话×地图交互）自研。**禁止复制 Claude Code / Claude Agent SDK 代码（专有许可）**。

## 6. 设计语言

- **对话为主、地图居中**：中心地图铺满 + 右侧约 360px Agent 对话栏 + 薄图层栏 + 极简顶栏。
- 深/浅两套主题，顶栏一键切换；所有颜色来自 `src/styles/tokens.css` CSS 变量，禁止硬编码。
- 强调色青绿 `#0D9488` → `#14B8A6`（主按钮、激活态、任务“航线”进度线）。
- 表面色：深色 `#0B1220` / `#111827`；浅色 `#F8FAFC` / 白。
- Inter / 系统无衬线；卡片圆角 10–12px；动效克制。
- **不使用字面神话视觉**（星空、古希腊柱、帆船主图标），也不写空洞“无所不能”文案。品牌只保留“领航、克制、可信”与 **From Intent to Outcome**。

## 7. Windows 环境搭建

### 7.1 前置
- **Node.js 20+**（含 npm）
- **Rust**（rustup，stable，`x86_64-pc-windows-msvc`）+ **Visual Studio 2022 Build Tools**（勾选“使用 C++ 的桌面开发”/MSVC + Windows SDK）+ **WebView2 Runtime**（Win10/11 通常已自带）
- **Python 3.11+**（安装时勾选 Add to PATH；`py` 启动器可用）
- Git（克隆参考仓库用）

### 7.2 安装依赖（PowerShell）
```powershell
cd F:\tiphys
npm install
npm install --prefix agent
py -3 -m venv engine\.venv
engine\.venv\Scripts\python.exe -m pip install --upgrade pip
engine\.venv\Scripts\python.exe -m pip install -r engine\requirements.txt
```
（若 geopandas 依赖安装失败，升级 pip 后重试；新版 wheel 已自带 GDAL/PROJ。）

### 7.3 运行（三个 PowerShell 窗口）
```powershell
# 窗口 1：空间引擎 :8971
cd F:\tiphys; npm run engine
# 验证：npm run engine:ping   → {"ok":true,"service":"tiphys-engine"}

# 窗口 2：Agent sidecar :8972
cd F:\tiphys; npm run agent

# 窗口 3：桌面应用
cd F:\tiphys; npm run tauri dev
```
仅调前端可用 `npm run dev`（浏览器打开 http://localhost:1420）。`npm run engine` 现由 `scripts/engine.mjs` 启动，自动使用 `engine\.venv\Scripts\python.exe`。

> 端口规划：TIPHYS 用 **8971/8972**，与 GeoAgentPro GEE proxy（默认 8765，`GA_GEE_PORT` 可覆盖）和 GeoLibre Desktop（8765/8766）错开，三条产品线可并行。`npm run dev:all` 一次拉起全部服务；`tauri dev`/安装版由壳自行拉起并清理 sidecar。

### 7.4 模型配置
默认：OpenAI 兼容接口 base `https://tierflow.cn/v1`，模型 `tierflow_pro`，多 key 轮换。Agent 按以下顺序取 key（`agent/src/config.ts`），都没有则退回内置 mock 模型，**不会崩溃**：

1. `TIPHYS_LLM_API_KEY`（+ `TIPHYS_LLM_BASE_URL`、`TIPHYS_LLM_MODEL`）——显式单 key，最高优先；
2. `TIPHYS_TF_KEYS`：多个 key，空格或逗号分隔；
3. 密钥文件：`TIPHYS_TF_KEYS_FILE` 指定的路径；未指定时依次找
   - **`F:\tiphys\.tiphys\tierflow_keys.txt`（本包已附带，开箱即用）**
   - `C:\Users\alex\.tierflow`（`%USERPROFILE%\.tierflow`）
4. 仅 Linux/macOS：`~/.local/bin/tf-keys.sh` 的 `tf_keys`（Windows 上自动跳过）。

密钥文件格式：每行一个 key（或空格/逗号分隔），`#` 注释，可选 `TF_BASE=https://tierflow.cn/v1`。也可用 `.tiphys\agent.json` 或 `%USERPROFILE%\.tiphys\agent.json`：`{"baseURL":"...","apiKey":"...","model":"..."}`。

PowerShell 临时设置示例：
```powershell
$env:TIPHYS_TF_KEYS_FILE = "C:\Users\alex\.tierflow"
$env:TIPHYS_LLM_MODEL = "tierflow_pro"
npm run agent
```
强制用 mock：`$env:TIPHYS_LLM_PROVIDER = "mock"`。

> ⚠️ **密钥安全**：`.tiphys/tierflow_keys.txt` 含真实 tierflow 密钥，已写入 `.gitignore`（`.tiphys/agent.json` 同样忽略）。**不得提交到 git、不得公开分享或贴进 issue/聊天/日志**。转交他人前删除该文件，让对方用自己的 key。日志中 key 只显示掩码。

## 8. 参考仓库
在 PowerShell 运行 `reference\clone_refs.ps1`，把 15 个参考仓库浅克隆（最新版）到 `F:\tiphys\reference\<分组>\<名字>`，已存在的跳过。清单、许可证、用途见 `reference/README.md`。
