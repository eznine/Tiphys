# 阶段 4 · 模型在环基线（浏览器 Agent，真实页面）

> 生成：2026-10-24T15:56:57.501Z · arm: planned · 模型: tierflow_pro（内置默认凭据（TierFlow））

| 任务 | 结果 | 工具链 | 命中预期工具 | 耗时 |
|---|---|---|---|---|
| S01 | PASS | describe_layer | ✓ | 28s |
| S02 | PASS | buffer→zoom_to_layer | ✓ | 27s |
| S03 | PASS | reproject→describe_layer | ✓ | 34s |
| S04 | PASS | describe_layer→select_by_attributes→open_attribute_table→zoom_to_layer | ✓ | 30s |
| S05 | PASS | describe_layer→field_statistics | ✓ | 15s |
| S06 | PASS | describe_layer→calculate_geometry→inspect_layers→open_attribute_table→select_by_attributes | ✓ | 66s |
| S07 | PASS | rename_layer | ✓ | 22s |
| S08 | PASS | export_features | ✓ | 20s |
| S09 | PASS | convex_hull | ✓ | 21s |
| S10 | PASS | describe_layer→open_attribute_table→field_statistics | ✓ | 49s |
| M01 | PASS | buffer→describe_layer | ✓ | 44s |
| M02 | PASS | describe_layer→dissolve→ping→dissolve→list_layers→search_browser_tools→run_plan→calculate_ | ✓ | 203s |
| M03 | PASS | describe_layer→spatial_join→describe_layer→open_attribute_table→field_statistics | ✓ | 37s |
| M04 | PASS | run_plan→reproject→inspect_layers→describe_layer→search_browser_tools→buffer | ✓ | 45s |
| M05 | PASS | select_by_location→export_features→open_attribute_table | ✓ | 18s |
| M06 | PASS | intersection→calculate_geometry→field_statistics→calculate_geometry→field_statistics→disso | ✓ | 247s |
| M07 | PASS | search_browser_tools→inspect_layers→search_browser_tools→search_browser_tools→search_brows | ✗ | 159s |
| M08 | PASS | search_browser_tools→inspect_layers→run_browser_tool→run_browser_tool | ✗ | 32s |
| M09 | PASS | inspect_layers→search_browser_tools→search_browser_tools→hydrology_flow_pipeline→run_brows | ✗ | 101s |
| M10 | PASS | search_browser_tools→search_browser_tools→inspect_layers→run_browser_tool→run_browser_tool | ✗ | 56s |
| M11 | FAIL | inspect_layers→search_browser_tools→search_browser_tools→search_browser_tools→search_brows | ✗ | 158s |
| M12 | PASS | clip→dissolve→calculate_geometry→calculate_geometry→field_statistics→field_statistics→desc | ✓ | 114s |
| H01 | PASS | buffer→zoom_to_layer→set_layer_symbology | ✓ | 19s |
| H02 | PASS | reproject→inspect_layers→buffer→calculate_geometry→field_statistics→zoom_to_layer→set_laye | ✓ | 73s |
| H03 | PASS | inspect_layers→describe_layer→buffer→calculate_geometry→field_statistics→calculate_geometr | ✓ | 103s |
| H04 | PASS | clip→search_browser_tools | ✓ | 49s |
| H05 | PASS | list_layers→plan_list | ✗ | 62s |
| H06 | PASS | search_browser_tools→inspect_layers→run_browser_tool→run_browser_tool→list_layers | ✗ | 28s |
| H07 | PASS | describe_layer→field_statistics | ✗ | 13s |
| H08 | PASS | search_browser_tools→inspect_layers→run_browser_tool→job_status→search_browser_tools→inspe | ✗ | 64s |

合计：29 PASS / 1 FAIL / 0 ERROR（30 任务）· 预期工具命中 21/30 · tokens 输入 333461 / 输出 12389

## M11 FAIL

- ✗ tool_called：没有调用 wasm_basins
- ✗ new_layer：没有满足条件的新图层（新增 0 层）

