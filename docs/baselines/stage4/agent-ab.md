# 阶段 4 · A/B 对照：直接工具+8 步上限 vs 预算制+规划提示词

> A 臂：2026-10-24T14:46:15.052Z（arm=current）· B 臂：2026-10-24T15:56:57.501Z（arm=planned）· 同一 30 任务与判据（agent-success.json）· 同一模型 tierflow_pro
> 单次运行/任务；差异方向有意义，差值本身有方差（见 NOT_TESTED）。

| 指标 | A 臂（基线） | B 臂（预算+规划） | Δ |
|---|---|---|---|
| 任务成功 | 28/30 | 29/30 | +1 |
| 预期工具命中 | 21/30 | 21/30 | +0 |
| P50 耗时 | 38 s | 45 s | |
| tokens（输入/输出） | 350826/12516 | 333461/12389 | -17365 输入 |
| 平均工具调用数 | 5.9 | 7.2 | |

## 逐任务

| 任务 | A | B | 变化 | B 臂工具链 |
|---|---|---|---|---|
| H01 | PASS | PASS |  | buffer→zoom_to_layer→set_layer_symbology |
| H02 | PASS | PASS |  | reproject→inspect_layers→buffer→calculate_geometry→field_statistics→zoom_to_laye |
| H03 | PASS | PASS |  | inspect_layers→describe_layer→buffer→calculate_geometry→field_statistics→calcula |
| H04 | PASS | PASS |  | clip→search_browser_tools |
| H05 | PASS | PASS |  | list_layers→plan_list |
| H06 | PASS | PASS |  | search_browser_tools→inspect_layers→run_browser_tool→run_browser_tool→list_layer |
| H07 | PASS | PASS |  | describe_layer→field_statistics |
| H08 | PASS | PASS |  | search_browser_tools→inspect_layers→run_browser_tool→job_status→search_browser_t |
| M01 | PASS | PASS |  | buffer→describe_layer |
| M02 | PASS | PASS |  | describe_layer→dissolve→ping→dissolve→list_layers→search_browser_tools→run_plan→ |
| M03 | PASS | PASS |  | describe_layer→spatial_join→describe_layer→open_attribute_table→field_statistics |
| M04 | PASS | PASS |  | run_plan→reproject→inspect_layers→describe_layer→search_browser_tools→buffer |
| M05 | PASS | PASS |  | select_by_location→export_features→open_attribute_table |
| M06 | PASS | PASS |  | intersection→calculate_geometry→field_statistics→calculate_geometry→field_statis |
| M07 | PASS | PASS |  | search_browser_tools→inspect_layers→search_browser_tools→search_browser_tools→se |
| M08 | PASS | PASS |  | search_browser_tools→inspect_layers→run_browser_tool→run_browser_tool |
| M09 | FAIL | PASS | ↑ 修复 | inspect_layers→search_browser_tools→search_browser_tools→hydrology_flow_pipeline |
| M10 | PASS | PASS |  | search_browser_tools→search_browser_tools→inspect_layers→run_browser_tool→run_br |
| M11 | FAIL | FAIL |  | inspect_layers→search_browser_tools→search_browser_tools→search_browser_tools→se |
| M12 | PASS | PASS |  | clip→dissolve→calculate_geometry→calculate_geometry→field_statistics→field_stati |
| S01 | PASS | PASS |  | describe_layer |
| S02 | PASS | PASS |  | buffer→zoom_to_layer |
| S03 | PASS | PASS |  | reproject→describe_layer |
| S04 | PASS | PASS |  | describe_layer→select_by_attributes→open_attribute_table→zoom_to_layer |
| S05 | PASS | PASS |  | describe_layer→field_statistics |
| S06 | PASS | PASS |  | describe_layer→calculate_geometry→inspect_layers→open_attribute_table→select_by_ |
| S07 | PASS | PASS |  | rename_layer |
| S08 | PASS | PASS |  | export_features |
| S09 | PASS | PASS |  | convex_hull |
| S10 | PASS | PASS |  | describe_layer→open_attribute_table→field_statistics |

B 臂使用 run_plan 的任务：**2/30**（A 臂 0）。

## 状态翻转的任务

- **M09**：FAIL → PASS

## NOT_TESTED

- 每任务单次运行，未做 ≥3 次方差；
- 两臂之间模型服务侧波动未隔离（同一模型与 key，但不同时段）；
- GeoAgentBench 子集单列，不并入本对照。

