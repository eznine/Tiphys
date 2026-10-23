# Plugin and extension interface

TIPHYS extensions are catalog tools plus an optional local runner. The interface is intentionally small so LinkageMapper-style workflows can be added without changing the shell.

## Contract

`src/lib/plugins/types.ts` defines:

```ts
type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  tools: CatalogTool[];
  run?: (toolName: string, args: Record<string, unknown>, context: ExtensionRunContext) =>
    Promise<Record<string, unknown>> | Record<string, unknown>;
};

type ExtensionRunContext = {
  runTool: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  inspectLayer: (layer: string) => Promise<ExtensionLayerInfo>;
  createLayer: (geojson: FeatureCollection, name: string) => Promise<Record<string, unknown>>;
  reprojectLayer: (layer: string, epsg: number, name: string) => Promise<Record<string, unknown>>;
  mergeLayers: (layers: string[], name: string) => Promise<Record<string, unknown>>;
};
```

Tool schemas use the same catalog contract as Python MCP and GeoLibre WASM tools (`parameters`, `annotations`, optional `label`/`category`/`subcategory`). Plugin tools are merged into both the browser and desktop catalogs, so they appear in the two-level toolbox and are available to the browser agent.

`src/lib/plugins/registry.ts` owns registration:

- `registerExtension(manifest)` rejects duplicate extension IDs and duplicate tool names.
- `pluginToolSchemas` feeds catalog merging.
- `pluginToolNames` lets the browser engine route a tool to its extension runner.
- `runPluginTool(name, args, context)` finds the manifest and invokes `run`.
- `context.runTool` executes another catalog tool inline, sharing the parent job's cancellation signal. Extensions must use this instead of starting a nested browser job, which would deadlock on the GIS CPU lock.
- `context.inspectLayer` returns read-only layer metadata and display GeoJSON without exposing the stored file handle.
- `context.createLayer` adopts a transient GeoJSON layer, used by the AOI helper.
- `context.reprojectLayer` operates on the original layer bytes, avoiding display-GeoJSON round trips, and creates a persisted result layer.
- `context.mergeLayers` runs the bundled `merge_vectors` WASM tool on native layer bytes to build a combined endpoint layer.

## Current extensions

| Tool | Category | Behavior |
| --- | --- | --- |
| `linkage_mapper_corridor` | 扩展 / 插件 | Runs a real least-cost corridor network from core habitat polygons + resistance raster |
| `hydrology_flow_pipeline` | 扩展 / 插件 | Runs DEM depression conditioning, D8 flow routing, accumulation, optional stream extraction and watersheds inline |
| `least_cost_path_pipeline` | 扩展 / 插件 | Connects source and destination points or polygons over a resistance raster and returns path polylines, a corridor network and an accumulated-cost surface |
| `clip_layers_to_aoi` | 扩展 / 插件 | Builds a transient AOI polygon from the map bbox, clips the active vector or raster layer, then removes the temporary AOI layers |
| `whitebox_extra` | 扩展 / 插件 | Explains that GeoLibre WASM already provides raster, terrain, hydrology, and remote-sensing tools |

The explanatory `whitebox_extra` tool returns `{ ok: false, available: false, ... }` rather than fabricating a layer. All extension tools are discoverable in the catalog and by `search_browser_tools`, including Chinese queries such as 走廊、水文、最小成本 and 廊道.

## Corridor pipeline

`linkage_mapper_corridor` accepts:

- `layer`: core habitat polygons (at least two regions).
- `resistance`: a cost/friction GeoTIFF; NoData is treated as impassable by the underlying tool.
- `barriers`: optional impassable polygon layer.
- `corridor_width`: width in the resistance raster's map units; omitted uses the GeoLibre default of 10 cells.
- `neighbor_option`: `spanning_tree` (default) or `all_pairs`.

The runner chains two bundled WASM tools inline:

1. `wasm_vector_polygons_to_raster` rasterizes core habitats onto the resistance grid (the source surface is retained for inspection).
2. `wasm_optimal_corridor_connections` computes least-cost corridor polygons and centerlines across the resistance surface.

The result includes `source_raster`, `layers`, `tools`, and a limitations note. This is a directional-neutral corridor network; LinkageMapper pinch-point, barrier, and post-processing analyses are not claimed.

## Hydrology pipeline

`hydrology_flow_pipeline` accepts a DEM raster plus optional stream threshold, depression method (`fill` or `breach`), stream extraction toggle, pour points, and pour-point snap distance. It chains bundled WASM tools inline through `context.runTool`:

1. `wasm_fill_depressions` (default) or `wasm_breach_depressions_least_cost`.
2. `wasm_d8_pointer` from the conditioned DEM.
3. `wasm_d8_flow_accum` from the D8 pointer (`input_is_pointer: true`, cell counts).
4. `wasm_extract_streams` from the accumulation grid, unless disabled.
5. Optional `wasm_snap_pour_points` and `wasm_watershed` when a point layer is supplied.

The result contains `{ layers, tools, steps, limitations }`. Every intermediate raster is persisted as a normal workspace layer. The runner fails instead of fabricating output if any upstream tool returns no layer. It does not claim rainfall-runoff simulation or calibrated channel thresholds; D8 is a single-flow-direction model and NoData remains NoData.

## Least-cost path pipeline

`least_cost_path_pipeline` accepts a cost/friction raster, a source layer and a destination layer. Source and destination must both be point/multipoint or both be polygon/multipolygon. The runner aligns them to the resistance raster's EPSG from their original bytes, then merges the two endpoint layers with `merge_vectors` when they differ.

- Point mode rasterizes only the source endpoints, computes `wasm_cost_distance`, then runs `wasm_cost_connectivity` (`mst` or `all_neighbors`) for real path polylines.
- Polygon mode rasterizes the source polygons and runs `wasm_optimal_corridor_connections` for corridor polygons plus centerlines.
- `include_cost_surface` controls whether the accumulated cost-distance raster is retained.

The result returns `{ layers, tools, steps, limitations, endpoints, source_raster, cost_surface, path_layers }`. It fails if the upstream tool returns no polyline geometry, and NoData cells are reported as impassable rather than bridged or invented.

## AOI clip helper

`clip_layers_to_aoi` accepts the active layer ID plus `aoi_west`, `aoi_south`, `aoi_east` and `aoi_north` from the map's WGS84 rectangle. It creates a temporary polygon named `AOI`, reprojects that polygon when needed, and then:

1. Calls `wasm_clip_raster_to_polygon` for rasters with `maintain_dimensions: false` by default.
2. Calls the standard vector `clip` tool for point or polygon layers.

The helper returns `{ layers, tools, steps, limitations, aoi_bbox, target_epsg }` and removes all temporary `AOI`/`AOI_*` layers in a `finally` block. Line and mixed-geometry vector clipping is not claimed yet; the limitation is returned instead of silently dropping features.

## Adding an extension

1. Create a manifest with a stable ID and version.
2. Define explicit JSON-schema parameters; mark layer inputs with `x-layer` and `x-layer-kind`.
3. Implement `run` using existing engine calls or bundle a browser-safe implementation.
4. Call `registerExtension` from `registry.ts`.
5. Add a focused test for the catalog schema and any real execution path.

Extensions must not store credentials in the workspace, must not claim unavailable backends, and should return structured limitations when an upstream model or service is not installed.

## Next

- Optional path corridor thresholding and source/destination role labels where upstream tools expose them.
- Optional external plugin discovery for the desktop build.
- Agent memory and recovery work remains a later P2 item, separate from this interface.
