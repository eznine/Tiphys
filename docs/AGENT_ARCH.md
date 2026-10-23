# TIPHYS Agent 架构（M2-lite 骨架）

> 本文保留最初骨架的设计记录。当前恢复、审批、压缩、共享工具契约和运行时打包已更新，请以 `RELIABILITY_STATUS.md` 与项目 `README.md` 为准。

2026-10-23 写。这是“能跑通的骨架”，很多地方是占位，下面会标清楚。

## 一句话

界面（Tauri + React）只管显示；**Agent 进程**（Node，`agent/`）负责和大模型对话、决定调用哪个工具；**空间引擎**（Python，`engine/`）真正做 GIS 计算，并通过 **MCP** 协议把工具提供给 Agent。

```
┌────────────── Tauri 窗口（React）──────────────┐
│ 图层列表 │      MapLibre 地球/地图      │ 对话栏 │
└──────────────────────────────────────────────────┘
        │ HTTP + SSE（127.0.0.1:8972）
┌───────▼──────── Agent sidecar（agent/，Node）────┐
│ Vercel AI SDK streamText 循环 · 审批 · 任务监视     │
│ 上下文管理 · 记忆 · JSONL 事件日志                  │
└───────┬──────────────────────────────────────────┘
        │ MCP（streamable HTTP，127.0.0.1:8971/mcp/）
┌───────▼──────── 空间引擎（engine/，FastAPI）──────┐
│ ping/list_layers/add_data/describe_layer/buffer  │
│ job_status/job_cancel/remove_layer · /ping · 图层GeoJSON │
└──────────────────────────────────────────────────┘
```

## 怎么跑

```bash
npm run engine        # Python 引擎 :8971（/ping 和 /mcp/）
npm run agent         # Agent sidecar :8972
npm run tauri dev     # Linux 无头盒需 DISPLAY=:9；Windows 直接运行
```
在对话框点“给 samples 里的点做 500 米缓冲”即可演示。

## 配置真实模型

不配就用内置 **mock 模型**（规则固定，用来演示流程）。配置任一 OpenAI 兼容接口（DeepSeek、通义、Kimi、tierflow、自建…）：

| 环境变量 | 说明 |
|---|---|
| `TIPHYS_LLM_BASE_URL` | 例如 `https://api.deepseek.com/v1` |
| `TIPHYS_LLM_API_KEY` | 密钥（只在 Agent 进程里，不进前端） |
| `TIPHYS_LLM_MODEL` | 例如 `deepseek-chat` |
| `TIPHYS_LLM_PROVIDER` | 可选，`mock` 强制用 mock |
| `TIPHYS_CONTEXT_WINDOW` | 上下文窗口 token 数（默认 64000，到 80% 压缩） |
| `TIPHYS_MAX_TOOL_OUTPUT` | 工具输出超过多少字符就溢写到文件（默认 6000） |

**默认就是 tierflow**：如果没设 `TIPHYS_LLM_API_KEY`，Agent 启动时按顺序找密钥池：环境变量 `TIPHYS_TF_KEYS`（空格/逗号分隔）→ 密钥文件 `TIPHYS_TF_KEYS_FILE`（默认 `~/.tierflow`）→ 仅 Linux/mac：`~/.local/bin/tf-keys.sh` 的 `tf_keys`，baseURL 用 `https://tierflow.cn/v1`，模型 `tierflow_pro`。遇到 401/402/403/429/5xx 自动换下一个 key；日志里 key 只显示掩码。密钥不写进代码或文件。两样都没有 → 回退 mock。`TIPHYS_LLM_PROVIDER=mock` 可强制用 mock。

也可写到 `~/.tiphys/agent.json` 或 `.tiphys/agent.json`：`{"baseURL": "...", "apiKey": "...", "model": "..."}`。

## 各部分说明

1. **Agent 循环**（`agent/src/server.ts`）：用 Vercel AI SDK 的 `streamText` + `stopWhen: stepCountIs(8)`，MCP 工具转成 AI SDK 工具。流式事件（文字、工具调用、结果）通过 SSE 推给界面。
2. **工具 = MCP**（`engine/main.py`）：Python 官方 `mcp` SDK（FastMCP），挂在 FastAPI 的 `/mcp/` 上，和 `/ping` 同一个进程，所以图层状态共享。`engine/mcp_server.py` 是独立 stdio 版本（给 MCP Inspector 之类调试用，状态不共享）。
3. **长任务**（`engine/jobs.py`）：`buffer` 立即返回 `job_id`，后台线程跑；Agent 端 `watchJob` 每 300ms 查一次状态推送进度，**没有固定超时**；界面有进度条卡片和取消按钮。缓冲本身很快，进度是人为放慢的（`TIPHYS_DEMO_DELAY`，默认 2.5，设 0 关掉）。
4. **上下文管理**（`agent/src/context.ts`）：
   - (a) 工具输出超长 → 全文写到 `.tiphys/spill/<调用id>.json`，模型只看到预览和路径。
   - (b) 估算 token 超过窗口 80% → 压缩：保留最近约 16% 的消息（按用户轮次切，不拆开工具调用对），完整旧记录归档到 `.tiphys/spill/`，前面换成“交接摘要”，**强制写入 GIS 工作区状态**（图层/CRS/AOI/输出路径/未完成任务 id）。真实模型用 `COMPACT_PROMPT` 生成摘要；mock 模式用可重复的记录型摘要。摘要失败或压缩后仍超预算时保留原对话并报错。
   - (c) 每轮刷新图层列表，把工作区快照（JSON）放进系统提示词。
   - (d) 记忆文件：项目级 `.tiphys/MEMORY.md` + 用户级 `~/.tiphys/memory.md`，每轮读入系统提示词。
5. **人工确认**：破坏性工具（目前 `remove_layer`，以及任何带 `overwrite: true` 的调用）执行前，界面弹出确认卡片，点“允许/拒绝”后才继续；不设超时。
6. **事件日志**：每个会话一个 `.tiphys/sessions/<id>.jsonl`，记录所有事件，每轮结束写 `checkpoint`（消息 + 工作区）。Agent 重启后从最后一个 checkpoint 恢复对话；界面打开时用 `/history` 重放事件。
7. **界面**：`src/lib/agent.ts`（SSE 客户端 + 事件归约）、`ChatDock`（流式文字、工具小标签、任务进度卡、确认卡）、`LayerRail`（图层勾选）、`MapCanvas` 加 GeoJSON 图层并缩放到结果。
8. **示例数据**：`samples/beijing_points.geojson`（北京中心 5 个点）。

## 借鉴/复用了谁（许可证见 THIRD_PARTY_NOTICES.md）

| 部分 | 来源 | 方式 |
|---|---|---|
| LLM 调用、工具循环 | Vercel AI SDK（Apache-2.0） | 直接用库 |
| 工具协议 | MCP 官方 TS / Python SDK | 直接用库 |
| 缓冲计算 | geopandas + shapely（投影到当地 UTM 再缓冲） | 直接用库 |
| buffer 参数形式（distance/units/dissolve/输出名、5000 km 上限） | RustGIS `crates/analysis/src/tools.rs`（Apache-2.0） | 照搬接口 |
| 单位名称 meters/kilometers/miles | GeoLibre `vector-tools.ts`（MIT） | 照搬 |
| 长任务 job_id / status / cancel 设计 | deepseek-harness `packages/jobs`（MIT） | 照思路重写（它是 TS 整套应用，不能直接嵌入） |
| 80% 压缩阈值、保留 16%、工具输出溢写 | deepseek-harness `compaction`/`spill`，Goose `context_mgmt`（Apache-2.0） | 常数照搬，代码重写 |
| 压缩提示词、摘要前缀 | Codex `prompts/templates/compact`（Apache-2.0） | 文字复制并加一行 GIS 状态要求 |
| JSONL 事件日志 + checkpoint 恢复 | Codex rollout 思路 | 重写 |
| 记忆文件注入 | Codex AGENTS.md / Cline memory bank 的做法 | 重写 |

为什么 MapLibre 图层和缓冲没直接拷 GeoLibre 代码：GeoLibre 的缓冲是浏览器端 turf，地图层管理绑在它的 `map-controller` 大类里；我们的计算在 Python 引擎，geopandas 更成熟，所以只用了它的单位约定。后面做样式/分类/图例时应优先搬 GeoLibre `packages/map` 的现成实现。
没有使用任何 Claude Code / Claude Agent SDK 的代码（专有许可）。

## 现在能用 vs 占位

能用（已验证）：mock 端到端（加载 → 缓冲任务 → 进度 → 结果上图）；真实模型（tierflow_pro）界面里点“给 samples 里的点做 500 米缓冲”：调用 ping → add_data → buffer，任务完成、缓冲图层上图；坏 key 自动轮换（测过 403 → 下一个 key）；取消任务；删除图层确认；工具输出溢写；压缩触发（小窗口测试）；会话日志与重放。

占位/未做：
- AOI 字段永远为空（还没有画 AOI 的工具）；GEE 任务没有接。
- 工具 schema 来自 MCP，但“哪些是破坏性”写死在 Agent（`DESTRUCTIVE`）。
- 引擎没有通过 MCP progress 通知推进度，而是 Agent 轮询 `job_status`。
- mock 模型每次“缓冲”都会重新 add_data 一份点图层（所以会出现同名图层）。
- 真实付费模型的摘要质量尚未重新验收；自动化测试通过注入的摘要回调检查覆盖范围和归档。
- Windows release 桌面包在窗口创建后、sidecar 就绪前崩溃；Debug 桌面构建可以启动。安装与卸载已通过，启动验收未通过。
