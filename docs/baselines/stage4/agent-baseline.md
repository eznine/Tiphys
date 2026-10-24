# 阶段 4 · 模型在环基线（浏览器 Agent，真实页面）

> 生成：2026-10-24T14:46:15.052Z · arm: current · 模型: tierflow_pro（内置默认凭据（TierFlow））

| 任务 | 结果 | 工具链 | 命中预期工具 | 耗时 |
|---|---|---|---|---|
| H01 | PASS | reproject→inspect_layers→buffer→calculate_geometry→field_statistics→describe_layer→buffer→ | ✓ | 67s |
| H02 | PASS | inspect_layers→describe_layer→reproject→inspect_layers→buffer→reproject→calculate_geometry | ✓ | 68s |
| H03 | PASS | inspect_layers→buffer→calculate_geometry→open_attribute_table→field_statistics→describe_la | ✓ | 113s |
| H04 | PASS | clip→intersection→search_browser_tools→search_browser_tools→search_browser_tools→run_brows | ✓ | 50s |
| H05 | PASS | plan_list→list_layers | ✗ | 24s |
| H06 | PASS | search_browser_tools→run_browser_tool→run_browser_tool→run_browser_tool→list_layers | ✗ | 55s |
| H07 | PASS | describe_layer→field_statistics | ✗ | 33s |
| H08 | PASS | search_browser_tools→inspect_layers→search_browser_tools→search_browser_tools→run_browser_ | ✗ | 46s |
| M01 | PASS | buffer→describe_layer→describe_layer | ✓ | 30s |
| M02 | PASS | describe_layer→dissolve→dissolve→ping→inspect_layers→search_browser_tools→run_browser_tool | ✓ | 38s |
| M03 | PASS | describe_layer→describe_layer→spatial_join→describe_layer→open_attribute_table | ✓ | 22s |
| M04 | PASS | reproject→buffer | ✓ | 41s |
| M05 | PASS | describe_layer→describe_layer→select_by_location→open_attribute_table→export_features | ✓ | 34s |
| M06 | PASS | intersection→calculate_geometry→field_statistics→open_attribute_table→calculate_geometry→d | ✓ | 58s |
| M07 | PASS | search_browser_tools→inspect_layers→run_browser_tool→run_browser_tool→inspect_layers→renam | ✗ | 27s |
| M08 | PASS | inspect_layers→search_browser_tools→search_browser_tools→search_browser_tools→search_brows | ✗ | 31s |
| M09 | FAIL | inspect_layers→search_browser_tools→hydrology_flow_pipeline→search_browser_tools→search_br | ✗ | 66s |
| M10 | PASS | search_browser_tools→search_browser_tools→inspect_layers→run_browser_tool→search_browser_t | ✗ | 50s |
| M11 | FAIL | inspect_layers→search_browser_tools→search_browser_tools→search_browser_tools→search_brows | ✗ | 84s |
| M12 | PASS | clip→dissolve→export_features→add_data→list_layers→search_browser_tools→zoom_to_layer→set_ | ✓ | 43s |
| S01 | PASS | describe_layer | ✓ | 26s |
| S02 | PASS | buffer→zoom_to_layer→set_layer_symbology | ✓ | 21s |
| S03 | PASS | reproject→describe_layer→inspect_layers | ✓ | 32s |
| S04 | PASS | describe_layer→select_by_attributes→open_attribute_table→set_layer_symbology | ✓ | 38s |
| S05 | PASS | describe_layer→field_statistics | ✓ | 27s |
| S06 | PASS | calculate_geometry→describe_layer→open_attribute_table | ✓ | 39s |
| S07 | PASS | rename_layer | ✓ | 26s |
| S08 | PASS | export_features | ✓ | 19s |
| S09 | PASS | convex_hull→calculate_geometry→zoom_to_layer→field_statistics→set_layer_symbology | ✓ | 23s |
| S10 | PASS | describe_layer→open_attribute_table | ✓ | 27s |

合计：28 PASS / 2 FAIL / 0 ERROR（30 任务）· 预期工具命中 21/30 · tokens 输入 350826 / 输出 12516

## M09 FAIL

- ✗ new_layer：没有满足条件的新图层（新增 4 层）
- 工具错误 run_browser_tool：缺少参数：input

## M11 FAIL

- ✗ tool_called：没有调用 wasm_basins
- ✗ new_layer：没有满足条件的新图层（新增 4 层）
- 工具错误 run_browser_tool：缺少参数：d8_pntr

