# OVERNIGHT_PROGRESS

- 2026-10-24 ~01:45 Asia/Shanghai — Switched overnight work to Linux box `/workspace/tiphys` (fresh clone `c04ba95`). Windows PC reserved for ArcGIS plugin.
- Logo at `public/logo-temp.png`.
- Next: P0 catalog+taxonomy+blue light theme+logo+ribbon; do not touch Windows.

- 2026-10-24 01:46 Asia/Shanghai — Confirmed box-only at c04ba95. Launching tf-codex batch01 P0 (catalog+taxonomy+blue+logo+ribbon). npm install in progress.

- 2026-10-24 01:57 Asia/Shanghai — Completed P0 batch01 on Linux:
  - Full catalog union: shared `catalog-schema.ts`; web 989 merged schemas, ToolPanel 985 visible after system-tool skips. Tauri fetches Python catalog then merges 958 WASM schemas + shell stubs, deduped by name.
  - Hybrid desktop routing: `wasm_*` runs and their `/jobs/:id` polling/cancel stay in the WebView worker; all other engine calls use Python MCP.
  - ToolPanel is two-level L1 → collapsible L2, all 48 WASM subcategories translated, vector categories merged, search filters/auto-expands, breadcrumb uses `L1 · L2`, and a health warning appears below 900 tools.
  - Blue accent (`#2563eb/#3b82f6` light, `#3b82f6/#60a5fa` dark), light default retained; logo wired into TopBar and ChatDock.
  - CommandRibbon now has 数据 | 地图 | 分析 | 遥感 | GEE | 视图 + Agent; GEE stub forms open with execution disabled. Engine badge distinguishes Browser-WASM from Python.
  - Fixed unguarded `navigator.locks` in queued WASM jobs under Node tests.
  - Verification: `npm run test:browser` 14/14 passed; `npx tsc --noEmit` passed; `npm run build` passed (expected large WASM/catalog chunks).

- 2026-10-24 02:01 Asia/Shanghai — P0 pushed to origin/main (`02854a6`). Starting batch02 P1 (selection, spatial join, ArcGIS IO stubs, GEE slice, plugin interface).

- 2026-10-24 02:19 Asia/Shanghai — Completed P1 + P2 slice (commit `P1: selection set, spatial join, ArcGIS IO stubs, GEE slice, plugin interface`):
  - Selection set: map click (Shift/Ctrl/Cmd additive), blue feature-state highlight, Escape clear, HUD count, table row highlight/sync/scroll-into-view, selected layer prefilled into tool forms.
  - Spatial join: real browser WASM path for intersects/contains/within and nearest (`generate_near_table`), `JOIN_*` field prefix, optional field stripping; Python/GeoPandas parity with one match per target and `NEAR_DIST`. Ribbon 分析 now exposes 空间连接 and 按位置选择.
  - Analysis ribbon: buffer, clip, intersection, union, erase, dissolve, convex hull, simplify, calculate geometry, attribute/location selection, field statistics. Attribute table keeps the toolbar field-statistics shortcut.
  - ArcGIS IO: `list_supported_formats` and `import_arcgis_project` diagnostic stubs in browser and Python catalogs; open-format alternatives documented in `docs/ARCGIS_IO.md`. No new third-party dependency; File GDB remains unsupported without an external driver.
  - GEE slice: structured auth status `{connected:false,...}`, empty collection search with hint, export as queued job with honest not-connected result, `TIPHYS_GEE_DEMO=1` demo job, and structured job-status lookup. Browser agent `search_browser_tools` now finds `wasm_*`, `gee_*`, and plugin tools.
  - Plugins: `src/lib/plugins/types.ts` + `registry.ts`; `linkage_mapper_corridor` and `whitebox_extra` stubs under 扩展 / 插件; contract documented in `docs/PLUGINS.md`.
  - Files: `src/App.tsx`, `src/components/{MapCanvas,AttributeTable,ToolPanel,CommandRibbon}.tsx`, `src/lib/dataLayers.ts`, `src/lib/browser/{engine,agent,catalog-schema,catalog.json}`, `src/lib/plugins/*`, `src/styles/app.css`, `engine/{geo_ops,tools}.py`, `engine/tests/test_reliability.py`, `tests/browser-engine.test.ts`, `docs/{ARCGIS_IO,PLUGINS}.md`.
  - Verification: `npm run test:browser` 16/16 passed; `npx tsc --noEmit` passed; Python engine tests 30/30 passed; `npm run build` rerun before commit.
  - Next P2: agent memory/recovery, real LinkageMapper corridor model, optional FileGDB/GDAL adapter, real GEE auth, restrained beauty pass on empty states and symbology defaults.

- 2026-10-24 02:24 Asia/Shanghai — P1 committed+pushed as `db655aa` (batch02 had left tree dirty; verified 16/16 browser tests + tsc, then committed).

- 2026-10-24 02:24 Asia/Shanghai — Starting batch03 P2/P4 (agent search/progress, beauty polish, AOI stub, runtime docs).

- 2026-10-24 — P2/P4 implemented: ranked `search_browser_tools` with Chinese/category boosts; browser Agent memory injection and two-stage context trim/compaction with IndexedDB spill and `read_browser_output`; clearer job percent/cancel cards; restrained empty states and blue-family layer defaults; AOI rectangle stored in App state with map chip; weighted overlay and network tools surfaced on the analysis ribbon; runtime parity notes added. Verified 18/18 browser tests, `tsc --noEmit`, and production build.

- 2026-10-24 02:40 Asia/Shanghai — Starting batch04 P3 (corridor pipeline, RS ribbon tools, map export).

- 2026-10-24 — P3 implemented on Linux box:
  - `linkage_mapper_corridor` is now a real inline pipeline instead of a stub. It rasterizes core habitat polygons onto the supplied resistance grid with `wasm_vector_polygons_to_raster`, then runs `wasm_optimal_corridor_connections` for least-cost corridor polygons + centerlines. Extension runners receive `context.runTool` so nested tools share the parent job/cancellation instead of deadlocking on the browser GIS CPU lock. Optional barriers, corridor width, and spanning-tree/all-pairs modes are exposed.
  - 分析 ribbon adds 坡向, 分区统计, and 栅格裁剪; 遥感 adds 光谱指数 alongside the existing NDVI-like normalized difference, change detection, and spectral analysis actions. All buttons open the existing tool form by catalog name.
  - Map view now has a restrained PNG control that waits for MapLibre idle, exports the current canvas via `toDataURL`, and downloads a timestamped PNG. The context uses `preserveDrawingBuffer` so screenshots do not depend on a blank WebGL buffer.
  - Browser tests cover the real corridor chain (raster alignment, corridor polygon/line outputs, persistence) and PNG data-URL/filename validation. Plugin/engine docs updated.
  - Verification: `npm run test:browser` 20/20 passed; `npx tsc --noEmit` passed; production build run before commit.


- 2026-10-24 02:47 Asia/Shanghai — P3 pushed to origin/main (`c9d8282`). Overnight supervisor confirmed batch04 exit=0, worktree clean, tests 20/20. Starting batch05 (catalog lazy-load perf, GEE auth path honesty, hydrology pipeline plugin, notices).

- 2026-10-24 — Batch05 implemented on Linux box:
  - Catalog startup: `wasm-catalog.json` is no longer imported by the initial module graph. `wasm-catalog-loader.ts` dynamically imports it; `catalog-schema.ts` keeps the same mutable `browserToolCatalog`/`browserCatalog` reference for consumers, exposes shell tools first, and converts 958 schemas in 48-item chunks yielding through `requestIdleCallback` (Node: `setImmediate`) between chunks. `/tools/catalog?hydrate=0` returns 37 common/plugin tools immediately; the default request hydrates and returns 995. ToolPanel renders the shell first and only shows the below-900 health warning after hydration has completed. Agent search awaits hydration; `wasm_*` execution awaits the manifest loader.
  - GEE: browser and Python status now distinguish `not_configured`, `configured_unverified`, and `demo` without claiming a session. They expose `connected`, `status`, `project`, `hasToken`, `hasServiceAccount`, `hint`, and `demo`; token/path values are never returned and service-account files are never read. Search/export remain honest no-ops unless verified or demo. ToolPanel disables live search/export unless connected or demo while auth/job status stay available. Exact verified-client work is documented in `docs/GEE.md`.
  - Hydrology: new `hydrology_flow_pipeline` extension chains fill/breach depressions -> D8 pointer -> D8 flow accumulation -> optional stream extraction -> optional snap pour points/watershed via inline `context.runTool`, returning `{layers, tools, steps, limitations}`. The synthetic-DEM browser test covers both the four-step stream chain and the watershed branch with same-grid raster outputs.
  - Docs/notices: added `docs/GEE.md`, updated `docs/PLUGINS.md` and `THIRD_PARTY_NOTICES.md`; no new npm dependency or third-party source was added.
  - Verification: `npm run test:browser` 22/22 passed; `npm run test:engine` 30/30 passed; `npx tsc --noEmit` passed; `npm run build` passed with `wasm-catalog` emitted as a separate 1,946 kB lazy chunk.

- 2026-10-24 03:03 Asia/Shanghai — Batch05 pushed to origin/main (`f327fb1`). Overnight supervisor confirmed clean tree, 22/22 browser + 30/30 engine tests. Starting batch06 (LCP pipeline, AOI-aware tools, agent plugin discovery, restrained polish).

- 2026-10-24 03:27 Asia/Shanghai — Batch06 implemented on the Linux box:
  - `least_cost_path_pipeline` is a real extension chain over bundled WASM tools. Point inputs align to the resistance raster CRS, merge with `merge_vectors`, rasterize the source with `vector_points_to_raster`, compute `cost_distance` and trace polylines with `cost_connectivity`. Polygon inputs use the same alignment/merge path, then `optimal_corridor_connections` for corridor polygons + centerlines. `include_cost_surface` controls the retained accumulated-cost raster; no upstream output is invented.
  - Endpoint projection/merge operates on original layer bytes. The helpers write GeoPackage to avoid a FlatGeobuf read-back panic observed with tiny projected features.
  - `clip_layers_to_aoi` builds a transient `AOI` polygon from the map bbox, aligns it to the target CRS, clips rasters with `wasm_clip_raster_to_polygon` or point/polygon vectors with `clip`, and removes `AOI`/`AOI_*` layers in `finally`. The 分析 ribbon has a restrained 裁剪到 AOI action.
  - Browser Agent chat now receives the AOI bbox, selected layer and names; the system prompt and compaction handoff preserve `aoi_bbox`. The prompt lists the corridor, hydrology, LCP and AOI workflows by name without claiming results. Extension tools are searchable for 走廊/水文/最小成本, while existing safety constraints are unchanged.
  - Ribbon adds 廊道连通 / 水文流程 / 最小成本路径 under 分析 · 扩展工作流. ToolPanel continues to render shell tools during hydration and only evaluates the below-900 warning after `catalogHydrated`.
  - Verification: `npm run test:browser` 24/24; `npx tsc --noEmit`; `npm run build`; `git diff --check`. No Python/engine files were changed for this batch.

- 2026-10-24 ~03:32 Asia/Shanghai — Overnight supervisor interrupted after batch06 (`afe67cc` on main, clean tree). No tf-codex alive; re-dispatching supervisor for batch07+. No user ping.

- 2026-10-24 03:32 Asia/Shanghai — Overnight supervisor resumed. Tree at afe67cc (dirty only OVERNIGHT_PROGRESS). No GEE creds on box. Launching batch07 (WASM warm path, agent recipes/job UX, ribbon polish, deploy notes, GEE docs/demo).

- 2026-10-24 03:40 Asia/Shanghai — Batch07 implemented on the Linux box:
  - Perf: added `warmWasmToolRunner()`; it precompiles `geolibre-cli.wasm` in a worker after first gesture/idle, parks at most one worker in the existing idle pool, and remains fully terminable by `releaseIdleWasmToolWorkers()`. MapLibre keeps its explicit worker URL, while navigation/scale controls, terrain source and the empty-map intro now wait for idle/RAF. Toolshell hydration explicitly yields one frame before catalog conversion.
  - Agent UX: job cards show live percent, tool-specific stage labels and a disabled “取消中” state; browser jobs now publish coarse running progress. Four restrained recipe cards open corridor/hydrology/LCP forms or insert an AOI prompt without auto-running. Compaction handoffs now preserve AOI bbox, selected layer, layer kind/count/CRS and the recent tool names.
  - Ribbon/symbology: added 填洼, D8 流向, 汇流累积, 栅格计算器 and 重分类; split terrain/hydrology into cleaner groups. Removed teal palette entries and gave AOI/廊道/最小成本/水文 helper names a deterministic blue-family palette.
  - GEE: browser demo export now emits clearly labelled staged progress (`demo_steps`) while keeping `connected: false`; docs add box presence checks and the exact service-account verification runbook. No credentials were created or read.
  - Docs: added `docs/DEPLOY_TIPHYS_XYZ.md`; updated runtime, parity and GEE notes to the verified 997 merged / 993 visible catalog counts and current hybrid routes.
  - Verification: `npm run test:browser` 26/26; `npx tsc --noEmit`; production build and engine tests run before ship.
