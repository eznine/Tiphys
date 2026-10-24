# TIPHYS AI+GIS 调研资料（2026-10-24）

这个文件夹集中存放 2026-10-24 这一轮的产品与技术调研，避免报告散落在 `docs/` 根目录。先说明证据状态：本地代码与项目文档已经核对；外部同类产品和领域工具的研究在您要求“不用搜那么多”后停止，因此 `02`、`03`、`04` 是方向性研究，不是逐条引用核验的最终报告。`06` 专门记录哪些结论已经核实、哪些必须在使用前复核。

| 文件 | 内容 | 证据状态 |
|---|---|---|
| [01_current_state.md](01_current_state.md) | TIPHYS 当前 Agent、引擎、图层、任务与五个试点操作的事实核对 | 源码与项目文档核对 |
| [02_peers.md](02_peers.md) | AI+GIS 同类产品的四种形态、共同逻辑与缺口 | 方向性研究，部分待核实 |
| [03_domain_toolkits.md](03_domain_toolkits.md) | 生态廊道、Circuitscape、InVEST、景观指数、遥感与测绘工具链 | 方向性研究，许可证与版本待复核 |
| [04_mobile_field.md](04_mobile_field.md) | 手机外业 GIS 场景、开源参照与移动 Web 边界 | 方向性研究，部分需按机型实测 |
| [05_product_strategy.md](05_product_strategy.md) | 完整产品与技术方案、平台分工、路线图与风险 | 源码事实 + 推断 |
| [06_evidence_and_verification.md](06_evidence_and_verification.md) | 已核实证据、待核实清单与复核方法 | 证据台账 |

## 与已有项目报告的关系

本文件夹是这一轮的汇总，不复制既有报告，保持单一来源。相关内容仍在原位置：

- [用户需求调研](../USER_NEEDS_RESEARCH.md)：QGIS issue 与 GIS StackExchange 的高频需求。
- [客户端能力对照](../CLIENT_PARITY.md)：与插件/ArcGIS Pro 的功能差距。
- [Agent 框架对比](../AGENT_FRAMEWORK_COMPARISON.md)：压缩、记忆、审批、长任务框架选型。
- [GeoLibre 工具接入记录](../GEOLIBRE_TOOLS_20261024.md)：958 个 WASM 工具的接入情况。
- [移动布局记录](../MOBILE_LAYOUT_20261024.md)：当前移动 Web 的界面实现。
- [部署说明](../DEPLOY_TIPHYS_XYZ.md)：tiphys.xyz 的上线方式。

## 阅读顺序

如果只关心下一步做什么，先读 `05_product_strategy.md` 的“结论先行”“分阶段实施路线”“下一批建议”。如果关心方案是否站得住，读 `01_current_state.md` 和 `06_evidence_and_verification.md`。如果准备开始做生态廊道或手机外业，先读 `03_domain_toolkits.md` 和 `04_mobile_field.md`，并按其中的待核实项补齐许可证、版本与数据要求。

## 维护规则

新增报告放入本文件夹，并在上表登记。涉及外部项目的事实必须写下来源 URL、核对日期和许可证；无法核实的写成“待核实”，不能写成已经验证。方案中的产品判断与代码事实分栏，避免以后把推断当成实现现状。
