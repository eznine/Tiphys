# 参考仓库（reference/）

这些仓库**不随项目打包**。在 Windows 上运行 `clone_refs.ps1`（PowerShell）会浅克隆（`--depth 1`，最新版）到 `F:\tiphys\reference\<分组>\<名字>`，已存在的跳过。该目录只读参考，不参与构建；复用代码时须保留原许可证声明并记入 `THIRD_PARTY_NOTICES.md`。详细对比见 `docs/AGENT_FRAMEWORK_COMPARISON.md`。

| 分组/名字 | URL | 许可证 | 我们用它做什么 |
|---|---|---|---|
| gis/GeoLibre | https://github.com/opengeos/GeoLibre | MIT | 同族产品（Tauri+React+MapLibre+Python sidecar）；单位约定已照搬；后续样式/分类/图例、格式清单优先搬 `packages/map` |
| gis/RustGIS | https://github.com/opengeos/RustGIS | Apache-2.0 | 命令化工具接口（buffer 参数与上限已照搬）；更多 GIS 工具接口参考 |
| agents/ai | https://github.com/vercel/ai | Apache-2.0 | **直接用库**：多模型调用 + `streamText` 工具循环 |
| agents/typescript-sdk | https://github.com/modelcontextprotocol/typescript-sdk | MIT | **直接用库**：Agent 端 MCP 客户端 |
| agents/codex | https://github.com/openai/codex | Apache-2.0 | 压缩提示词（已复制）、rollout 事件日志/恢复、AGENTS.md 记忆注入思路 |
| agents/goose | https://github.com/block/goose | Apache-2.0 | 上下文管理（80% 阈值、工具输出摘要）参考 |
| agents/deepseek-harness | https://github.com/deepseek-ai/deepseek-harness | MIT | 长任务 job_id/status/cancel、compaction/spill 常数 |
| agents/cline | https://github.com/cline/cline | Apache-2.0 | 人工确认流程、memory bank 思路 |
| agents/openai-agents-js | https://github.com/openai/openai-agents-js | MIT | 会话恢复 / 审批中断设计参考 |
| agents/mem0 | https://github.com/mem0ai/mem0 | Apache-2.0 | 二期向量记忆参考 |
| agents/langgraphjs | https://github.com/langchain-ai/langgraphjs | MIT | 对比评估用；**不**作骨架 |
| agents/mastra | https://github.com/mastra-ai/mastra | Apache-2.0（部分企业目录另有许可） | 对比评估用；**不**作骨架 |
| agents/pydantic-ai | https://github.com/pydantic/pydantic-ai | MIT | Python 侧 Agent 对比参考 |
| agents/claude-code | https://github.com/anthropics/claude-code | 专有（All rights reserved） | 只读公开文档思路，**禁止复制代码** |
| agents/claude-agent-sdk-typescript | https://github.com/anthropics/claude-agent-sdk-typescript | 专有 | 同上，**禁止复制代码** |
