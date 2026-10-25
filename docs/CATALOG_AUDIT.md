# TIPHYS 能力目录对账（阶段 0 · T-001）

> 由 `scripts/catalog-audit.ts` 生成，请勿手改；数据来自真实注册表（Python FastMCP 内省 + 浏览器目录 hydration）。
> 生成时间：2026-10-25T01:53:03.363Z

## 1. 各端实际可见的工具数

| 面 | 数量 | 说明 |
|---|---|---|
| 桌面 Python MCP 注册表 | 36 | `engine/tools.py` 真实注册；含 ping/list_layers/job_* |
| 桌面 Agent 可直接调用 | 37 | + `read_tool_output`；WASM 仅经 `wasm_run` 子进程桥接可达（阶段 1） |
| 浏览器 Agent 可直接调用 | 46 | shell 目录 43（含插件 5）+ search/run/read 三个入口 |
| 浏览器 Agent 可检索的 WASM | 958 | 仅能经 `search_browser_tools`→`run_browser_tool` |
| 合并后的浏览器工具箱 | 1001 | 页面手动入口（shell + WASM + 插件去重） |
| 桌面工具箱（Tauri WebView） | 1002 | Python 36 + WASM 958 + 插件；**同一个 WebView 内可手动调用 WASM** |

## 2. 对账结论

- Python 与浏览器 shell 同名工具：**35** 个（名称级 parity）。
- 仅 Python 有：zonal_statistics。
- 仅浏览器 shell 有：clip_layers_to_aoi、hydrology_flow_pipeline、least_cost_path_pipeline、linkage_mapper_corridor、plan_get、plan_list、run_plan、whitebox_extra。
- 浏览器 shell 中在 `engine.ts` 有分发分支（字符串字面量）：43/43。
- Python 侧未归入 `TOOL_GROUPS`（手动面板分组）的工具：job_cancel、job_status、list_layers、ping —— Agent 可见但 UI 分组缺失，需在 T-005/T-006 补齐。
- 插件工具：clip_layers_to_aoi、hydrology_flow_pipeline、least_cost_path_pipeline、linkage_mapper_corridor、whitebox_extra。

**关键不对称（与本方案首要判断一致）**：桌面 Agent 的循环只连 Python MCP，958 个 WASM 工具在桌面原本只能由用户手动调用；浏览器 Agent 反向只能调用浏览器实现，Python 的栅格/GEE/导出能力不可达。阶段 1 已用 `wasm_run`（子进程 WASI）打通单输入 WASM 工具，见 `docs/STAGE1_CONTRACTS_AND_WASM.md`。

## 3. WASM 目录结构与输入类型

- 分类（前 12）：Vector 306；Raster 198；Remote Sensing 176；Terrain 111；Hydrology 105；Conversion 51；Projection 11。
- 输入类型分布：矢量 330、栅格 482、混合 118、无图层输入 17、表格 11。
- 参数 schema 已统一为 JSON Schema，输出路径一律内部化（`schemaForWasm`）。

## 4. 尚未导出的字段（不假装已有）

| 字段 | 现状 | 后续动作 |
|---|---|---|
| 预计成本 | 仅区分 `job`/`interactive`，未测 CPU/内存 | 阶段 4 用固定数据实测 P50/P95 |
| 错误码 | 引擎抛异常/任务 failed+cancelled，未分类 | 阶段 3 统一 `INPUT_ERROR/UNSUPPORTED/...` |
| 取消能力 | Python job 工具与浏览器 job 均可取消；同步工具不可 | 阶段 3 统一 job 语义 |
| 需要文件还是内存 | Python `add_data`/`export_features` 走路径，其余走内存图层；WASM 全部 JSON 参数 | 阶段 1 `LayerRef` 显式化 |

## 5. 复现

```powershell
engine/.venv/Scripts/python.exe scripts/export_engine_catalog.py
node --import ./agent/node_modules/tsx/dist/loader.mjs scripts/catalog-audit.ts
```

原始数据：`docs/baselines/stage0/catalog-audit.json`（sha256 70893f4857be6399…）。
