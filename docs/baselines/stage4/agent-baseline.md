# 阶段 4 · 模型在环基线（浏览器 Agent，真实页面）

> 生成：2026-10-25T08:39:58.859Z · arm: current · 模型: tierflow_pro（内置默认凭据（TierFlow））

| 任务 | 结果 | 工具链 | 命中预期工具 | 耗时 |
|---|---|---|---|---|
| S01 | PASS | describe_layer | ✓ | 23s |
| S02 | PASS | buffer | ✓ | 24s |
| S03 | PASS | reproject→inspect_layers | ✓ | 23s |
| S04 | PASS | describe_layer→select_by_attributes | ✓ | 11s |
| S05 | PASS | field_statistics | ✓ | 15s |
| S06 | PASS | describe_layer→calculate_geometry→describe_layer→field_statistics→open_attribute_table | ✓ | 45s |
| S07 | PASS | rename_layer | ✓ | 7s |
| S08 | PASS | export_features | ✓ | 12s |
| S09 | PASS | convex_hull→zoom_to_layer→set_layer_symbology | ✓ | 15s |
| S10 | PASS | describe_layer→search_browser_tools→open_attribute_table | ✓ | 42s |
| M01 | PASS | run_plan→run_plan→run_plan→rename_layer→set_layer_symbology→zoom_to_layer | ✗ | 58s |
| M02 | PASS | describe_layer→inspect_layers→run_plan(calculate_geometry)→search_browser_tools→reproject→ | ✓ | 146s |
| M03 | PASS | describe_layer→describe_layer→spatial_join→describe_layer→field_statistics→open_attribute_ | ✓ | 34s |
| M04 | PASS | run_plan→run_plan | ✗ | 25s |
| M05 | PASS | select_by_location→export_features | ✓ | 15s |
| M06 | PASS | describe_layer→describe_layer→run_plan(intersection,calculate_geometry)→describe_layer→fie | ✓ | 84s |
| M07 | PASS | search_browser_tools→run_browser_tool(wasm_vector_lines_to_raster) | ✓ | 21s |
| M08 | PASS | search_browser_tools→search_browser_tools→search_browser_tools→run_browser_tool(wasm_slope | ✓ | 26s |
| M09 | PASS | inspect_layers→search_browser_tools→hydrology_flow_pipeline→run_browser_tool(wasm_raster_t | ✓ | 38s |
| M10 | PASS | inspect_layers→search_browser_tools→search_browser_tools→run_browser_tool(wasm_hillshade)→ | ✓ | 59s |
| M11 | PASS | inspect_layers→search_browser_tools→search_browser_tools→search_browser_tools→search_brows | ✓ | 75s |
| M12 | PASS | clip→dissolve→describe_layer→union_layers→search_browser_tools→select_by_attributes→select | ✓ | 226s |
| H01 | PASS | describe_layer→buffer→reorder_layers→set_layer_symbology→zoom_to_layer | ✓ | 30s |
| H02 | PASS | buffer | ✓ | 20s |
| H03 | PASS | inspect_layers→describe_layer→buffer→calculate_geometry→calculate_geometry→zoom_to_layer→f | ✓ | 143s |
| H04 | PASS | clip→search_browser_tools→search_browser_tools→select_by_location→select_by_location→selec | ✓ | 57s |
| H05 | PASS | list_layers→export_features→export_features | ✓ | 50s |
| H06 | PASS | search_browser_tools→run_browser_tool(wasm_slope)→list_layers | ✗ | 29s |
| H07 | PASS | describe_layer→field_statistics→select_by_attributes→open_attribute_table | ✓ | 26s |
| H08 | PASS | inspect_layers→search_browser_tools→run_browser_tool(wasm_slope)→job_status→inspect_layers | ✓ | 49s |

合计：30 PASS / 0 FAIL / 0 ERROR（30 任务）· 预期工具命中 27/30 · tokens 输入 428028 / 输出 14352

run_plan 使用：11 次，审计 通过

