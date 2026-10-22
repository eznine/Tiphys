# TIPHYS Agent 框架参考对比（2026-10-23）

所有仓库在本目录 `git clone --depth 1` 浅克隆。“已核对”= 我打开了源码文件；“未核对”= 只看了 README/文档/搜索结果，没有读到源码。

## 一、先说结论（推荐方案）

1. **Agent 主循环：自己写一个薄的 TypeScript 循环，底层用 Vercel AI SDK（`ai`，Apache-2.0）做多模型调用。** 它对 OpenAI 兼容接口（DeepSeek、通义、Kimi、智谱、tierflow 等）支持最广，工具有 `needsApproval`（人工确认）、`abortSignal`（取消）、流式事件，体积小，能跑在 Node sidecar 里，也基本能跑在 Tauri webview 里（webview 里放 API key 不安全，建议放 sidecar——这是推荐，不是实测）。
2. **TS ↔ Python 之间的工具契约：MCP（官方 typescript-sdk + Python 端 FastMCP/官方 python-sdk）。** Python GIS 引擎做成一个 MCP server，把 `buffer`、`clip`、`gee_export_raster` 等暴露成具名工具（JSON Schema）。MCP 自带 progress 通知和取消通知，正好对应“长任务可见进度、可取消”。
3. **长任务不要卡在一次工具调用里**：照 DeepSeek Harness 的 `jobs` 设计——`gee_export_raster` 立刻返回 job_id，后台跑，Agent 可 `job_status / job_wait / job_cancel`，完成时推送通知。这样就不会有“假超时”。
4. **上下文压缩、记忆、计划、检查点**：抄 Codex / Goose / DeepSeek Harness / Cline 的做法（见第四节），自己实现，不引入整套框架。
5. **状态持久化/恢复**：会话按“事件日志（JSONL 或 SQLite）”落盘，参考 Codex 的 rollout 文件 + openai-agents-js 的 `RunState` 序列化（可在“等人工确认”时暂停、存盘、重启后恢复）。
6. **不推荐整体采用** LangGraph.js 或 Mastra 当骨架：功能多但重，概念多，Tauri 打包和调试成本高；可借鉴其 checkpoint/interrupt 思路。

## 二、仓库清单

| 目录 | 仓库 | commit（短） | 提交日期 | 许可证 | 主要语言 | 备注 |
|---|---|---|---|---|---|---|
| codex | openai/codex | 96a0d8d551a1 | 2026-10-22 | Apache-2.0 | Rust（+TS 外壳） | 重点参考：压缩、记忆、rollout、审批、沙箱 |
| goose | block/goose | b89ab563a034 | 2026-10-22 | Apache-2.0 | Rust | 重点参考：自动压缩阈值、工具对摘要、子 agent、MCP 原生 |
| cline | cline/cline | c441897f11f6 | 2026-10-21 | Apache-2.0 | TypeScript | 重点参考：对话摘要、检查点回滚、人工审批 UI |
| deepseek-harness | deepseek-ai/deepseek-harness | 687f282e8625 | 2026-10-17 | MIT | TypeScript（+Python SDK） | DeepSeek 官方“Agent Harness”（dsh），开发者预览版，会有不兼容变更 |
| ai | vercel/ai | 5893e994f9d8 | 2026-10-22 | Apache-2.0（LICENSE 首行为 Vercel 版权，具体以文件为准） | TypeScript | 推荐的 LLM 调用层 |
| openai-agents-js | openai/openai-agents-js | be4f1f9aa4ad | 2026-10-21 | MIT | TypeScript | RunState 可序列化、审批中断、Session 记忆 |
| langgraphjs | langchain-ai/langgraphjs | 2b982b6cb4fb | 2026-10-22 | MIT | TypeScript | checkpoint/interrupt 最成熟 |
| mastra | mastra-ai/mastra | 259c13f83623 | 2026-10-22 | 混合（部分 Apache-2.0，部分企业许可，见 LICENSE） | TypeScript | **克隆看似不完整（packages/core 无 src），源码未核对** |
| typescript-sdk | modelcontextprotocol/typescript-sdk | 9adb8d5e5b20 | 2026-10-22 | MIT→Apache-2.0 过渡中 | TypeScript | MCP 官方 SDK |
| pydantic-ai | pydantic/pydantic-ai | 767f5267778e | 2026-10-22 | MIT | Python | Python 侧备选；有 approval_required toolset、deferred tools |
| mem0 | mem0ai/mem0 | 2c81af3bbe27 | 2026-10-20 | Apache-2.0 | Python | 长期记忆（LLM 抽取 + 向量库） |
| claude-agent-sdk-typescript | anthropics/claude-agent-sdk-typescript | c17fea5598f3 | 2026-10-22 | **专有（Anthropic 商业条款）** | 仅文档/示例/CHANGELOG | 仓库里没有核心源码 |
| claude-code | anthropics/claude-code | 5ed799e5cc56 | 2026-10-22 | **专有（Anthropic 商业条款）** | 插件/示例/文档 | Claude Code 核心不开源 |

未克隆：letta-ai/letta（时间所限，用 mem0 代表“记忆”类）、langchain-ai/langgraph（Python，用 langgraphjs 代表）。

## 三、能力对比表

| 维度 | Vercel AI SDK | openai-agents-js | LangGraph.js | Mastra | Codex | Goose | Cline | DeepSeek Harness | pydantic-ai |
|---|---|---|---|---|---|---|---|---|---|
| 工具定义 | `tool({inputSchema: zod, execute})` | `tool({parameters: zod})` | LangChain tool / zod | createTool + zod | Rust 内置 + MCP | MCP 扩展为主 | 内置工具 + MCP | 插件注册工具 | Python 函数+类型注解 |
| Agent 循环 | `generateText/streamText` 多步 + `stopWhen` | Runner（含 handoff） | 图（节点/边） | Agent + workflow | 自研 turn 循环 | 自研状态机 | 自研 task 循环 | 插件化 core/session | Agent.run / iter |
| 流式/进度 | 很好 | 好 | 好（stream modes） | 好 | 事件协议很细 | 有 | UI 级 | 有，带 Web UI | 好 |
| 取消 | AbortSignal | AbortSignal（run.ts 已核对） | 支持 | 支持 | 支持（Ctrl-C 中断 turn） | 支持 | 支持 | 支持 + jobs 取消 | 支持 |
| 长任务 | 无专门机制 | 无专门机制 | 靠持久化 | workflow suspend | 后台进程/exec-server | 子 agent | — | **jobs 包：后台任务+完成通知** | deferred tools |
| 人工确认 | `needsApproval`（已核对多个 approval 文件） | interruptions + `approve/reject`，MCP 审批 | `interrupt()` | suspend/resume | 审批策略+沙箱 | 权限模式 | 每步审批（强项） | permission policy | `approval_required` toolset |
| 持久化/恢复 | 需自建 | `RunState` 可序列化 | checkpointer（最强） | 存储层 | rollout JSONL + state SQLite | session 存 SQLite（未细核） | 任务历史+git 检查点 | durable session（SQLite，AGENTS.md 提及） | 消息历史可序列化；可接 Temporal 等（未核对） |
| 多模型/国产 | 最广（OpenAI 兼容通用） | 以 OpenAI 为主，可接其它（扩展包） | 广 | 广 | OpenAI 为主，支持自定义 provider/Ollama | 很广 | 很广 | DeepSeek 为主+自定义 OpenAI 兼容 | 广 |
| MCP | 有 MCP client | 有 | 有适配器 | 有 | 有（client+server） | 原生 | 有 | 有 mcp-client | 有 |
| Tauri 适配 | 好（轻） | 好（Node 侧） | 中（重） | 差（偏服务端） | 不适用（独立 CLI，可参考） | 不适用 | 不适用 | 不适用（整套应用） | Python 侧 |
| 许可证 | Apache-2.0 | MIT | MIT | 混合 | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT | MIT |

## 四、上下文 / 压缩 / 记忆（重点）

### 4.1 各家怎么做（附源码位置）

**Codex（OpenAI，已核对部分源码）**
- 压缩提示词：`codex-rs/prompts/templates/compact/prompt.md` —— 让模型写“交接摘要”：当前进展与关键决定、约束与用户偏好、剩余步骤、继续所需关键数据。`summary_prefix.md` 告诉新一轮模型“这是前任的总结，别重复做”。
- 压缩实现：`codex-rs/core/src/compact_*.rs`（含远程压缩、模型回退、保留部分工具输出 `compact_retained_tool_outputs.rs`），`codex-rs/history/src/compaction_checkpoint.rs`、`compaction_resume_metadata.rs`、`retained_context.rs`（压缩后能续跑）。自动压缩阈值可配置（`AutoCompactTokenLimitScope`）。
- 长期记忆：`codex-rs/memories/`，分两阶段：Phase 1 从每次会话记录（rollout）里抽取记忆，Phase 2 合并整理（consolidation）；读取时把记忆注入开发者指令并要求引用（citations）。记忆是**文件**形式，不是向量库。
- 项目记忆：AGENTS.md（仓库根目录约定文件，注入上下文）。
- 会话持久化：rollout（JSONL 事件日志）+ `state` crate（SQLite）。

**Goose（Block，已核对）**
- `crates/goose/src/context_mgmt/mod.rs`：默认在上下文用到 **80%** 时自动压缩（`DEFAULT_COMPACTION_THRESHOLD = 0.8`，可用 `GOOSE_AUTO_COMPACT_THRESHOLD` 改）。
- 特色：**工具调用对单独摘要**（`summarize_tool_call`、`tool_ids_to_summarize`）——把旧的“工具调用+结果”逐个压成一句话，而不是整段对话一次压。对 GIS 很有用（工具结果往往很长）。
- 被压缩的消息不删除，只改“对 agent 可见/对用户可见”标记——UI 仍能看到完整历史。
- 子 agent：`agents/subagent_*`；todo：`platform_extensions/todo.rs`；记忆 MCP：`goose-mcp/src/memory/`（文件型、按标签存）。

**Cline（已核对文件位置）**
- `sdk/packages/core/src/extensions/context/summarize-conversation.ts`、`summary-generation.ts`：接近上限时生成对话摘要；`/condense` 手动命令（`apps/vscode/src/core/controller/slash/condense.ts`）。
- 检查点：`session/checkpoint-restore.ts`、`checkpoint-diff.ts`——每步做快照，可回滚文件和对话到某一步。TIPHYS 可做成“回滚到某一步的图层/输出状态”。
- 项目记忆：`.clinerules` / Memory Bank 约定（来自文档，未核对源码）。

**DeepSeek Harness（官方，MIT，已核对 README 和配置）**
- `packages/compaction/`：默认上下文用到 **80%** 触发（`DEFAULT_THRESHOLD_RATIO = 0.8`），压缩后保留最近约 **16%**（`DEFAULT_RETAIN_RATIO = 0.16`）原文；另有 `compaction-tool-result-pruner`（先修剪超大工具输出）、`compaction-image-offload`（图片超预算时换占位文字）、`/compact` 命令（与运行中轮次串行化）。
- `packages/context/`：agent-instructions（项目指令文件）、file-reference、time-context 等“上下文片段”插件。
- 还有 `todo`、`plan`、`goal`、`subagent`、`jobs`（后台任务）、`guard`（防死循环）、`spill`（超长输出溢写到文件）、`session`（持久化）、`token-meter`。**模块拆分最接近 TIPHYS 需要的清单。**
- 注意：开发者预览，API 会破坏性变化；它是完整应用，不适合直接嵌入，适合照着拆分方式设计。

**openai-agents-js（已核对文件）**
- `agents-core/src/memory/session.ts`、`memorySession.ts`：Session 接口（存取对话历史）；`agents-openai/src/memory/openaiResponsesCompactionSession.ts`：调用 OpenAI 服务端压缩（只对 OpenAI 有效）。
- `runState.ts`：整个运行状态可序列化，配合审批中断可“存盘—重启—继续”。

**Vercel AI SDK（已核对）**
- 只有底层工具：`generate-text/prune-messages.ts`（裁掉旧的推理/工具消息），`prepareStep` 可在每步改消息。压缩、记忆需自建。

**LangGraph.js（已核对文件）**：`libs/checkpoint/src/`（每步状态快照、可从任意检查点恢复/分叉）、`store/`（跨会话长期记忆，KV+可选向量检索）。

**mem0（已核对）**：`mem0/memory/main.py` 的 `add()` 用 LLM 从对话中抽取“事实”，与已有记忆比较后做新增/更新/删除，存入向量库；`search()` 按语义检索。适合“用户偏好/常用坐标系/常用数据源”这类长期记忆，但需要向量库和额外 LLM 调用。

**Claude Code / Claude Agent SDK（核心闭源，以下来自公开文档与 CHANGELOG，非源码）**
- 自动压缩 + `/compact`；CHANGELOG 提到 `autoCompactWindow`（子 agent 可比主对话更早压缩）、PreCompact 钩子、压缩时可“保留部分消息”、`forkSession`。
- 记忆：CLAUDE.md 分层（用户级/项目级/目录级），文件型。
- 子 agent：独立上下文窗口，只把结果回传主 agent（省主上下文）。
- Hooks：工具前后、压缩前等事件可挂脚本。
- 许可证专有，**只能借鉴思路，不能拷代码**。

### 4.2 TIPHYS 应该借鉴什么

1. **三层压缩**（按成本从低到高）：
   - 先修剪：大工具结果（栅格统计、要素列表、GEE 日志）进上下文前截断，完整内容写文件，只给 Agent 摘要+文件路径（DeepSeek `spill`/`tool-result-pruner`）。
   - 再逐个摘要旧工具调用（Goose 的 tool-pair 摘要）。
   - 最后整段交接摘要：阈值 ~80% 触发，保留最近 ~15–20% 原文（Goose/DeepSeek 的默认值），提示词照 Codex 的“交接摘要”四要点，再加 GIS 必需项：当前图层清单、坐标系、研究区范围、已导出文件路径、未完成的 GEE 任务 ID。
2. **关键状态不靠聊天记录**：图层、CRS、AOI、job 列表放在结构化“工作区状态”里，每轮注入一个短快照。这样压缩丢不掉关键信息（这是我们的设计建议）。
3. **记忆用文件，不急着上向量库**：项目级 `TIPHYS.md`/`AGENTS.md`（项目约定、数据源），用户级偏好文件；会后像 Codex 一样“抽取→合并”。mem0 式向量记忆放二期。
4. **计划/todo**：一个 `todo_write` 工具，UI 显示进度（Goose/DeepSeek/Claude Code 都有）。
5. **子 agent**：大调研/批量处理开子 agent，独立上下文，只回传结论（Claude Code/Goose/DeepSeek）。
6. **检查点/恢复**：事件日志落盘 + 每次写操作前快照，可回滚（Cline 检查点 + Codex rollout + LangGraph checkpoint 思路）。
7. **Prompt 缓存**：系统提示词和工具列表放前面且保持稳定，变化的状态快照放后面——让 OpenAI/DeepSeek/Anthropic 的前缀缓存生效（通用做法；各家具体缓存规则未在本次逐一核对）。
8. **压缩可见**：UI 显示“上下文用量 %”和“已压缩”标记（Cline `ContextWindowSummary.tsx`）。

## 五、借什么 / 不借什么

- **借**：AI SDK（直接用）；MCP SDK（直接用）；DeepSeek Harness 的模块拆分与 jobs 设计；Goose 的阈值与工具对摘要；Codex 的压缩提示词结构与记忆两阶段流程；Cline 的检查点与审批交互；openai-agents-js 的 RunState 可序列化中断。
- **不借**：整套 LangGraph/Mastra 作骨架（重）；Codex/Goose 的 Rust 代码（语言不同，只学设计）；OpenAI 服务端压缩（锁定单一厂商）；Claude Code 任何代码（专有许可）；Mastra 企业许可部分（需确认许可）。

## 六、未核对/存疑
- Mastra 克隆可能不完整，其源码、记忆实现均未核对。
- Goose 会话存储、Cline Memory Bank、pydantic-ai 的 durable 执行：仅凭文档或文件名。
- AI SDK 在 Tauri webview 中直接运行：未实测。
- Letta 未克隆。
