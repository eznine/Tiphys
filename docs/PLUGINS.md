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
};
```

Tool schemas use the same catalog contract as Python MCP and GeoLibre WASM tools (`parameters`, `annotations`, optional `label`/`category`/`subcategory`). Plugin tools are merged into both the browser and desktop catalogs, so they appear in the two-level toolbox and are available to the browser agent.

`src/lib/plugins/registry.ts` owns registration:

- `registerExtension(manifest)` rejects duplicate extension IDs and duplicate tool names.
- `pluginToolSchemas` feeds catalog merging.
- `pluginToolNames` lets the browser engine route a tool to its extension runner.
- `runPluginTool(name, args, context)` finds the manifest and invokes `run`.
- `context.runTool` executes another catalog tool inline, sharing the parent job's cancellation signal. Extensions must use this instead of starting a nested browser job, which would deadlock on the GIS CPU lock.

## Current extensions

| Tool | Category | Behavior |
| --- | --- | --- |
| `linkage_mapper_corridor` | 扩展 / 插件 | Runs a real least-cost corridor network from core habitat polygons + resistance raster |
| `whitebox_extra` | 扩展 / 插件 | Explains that GeoLibre WASM already provides raster, terrain, hydrology, and remote-sensing tools |

The explanatory `whitebox_extra` tool returns `{ ok: false, available: false, ... }` rather than fabricating a layer. Both tools are discoverable in the catalog and by `search_browser_tools`.

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

## Adding an extension

1. Create a manifest with a stable ID and version.
2. Define explicit JSON-schema parameters; mark layer inputs with `x-layer` and `x-layer-kind`.
3. Implement `run` using existing engine calls or bundle a browser-safe implementation.
4. Call `registerExtension` from `registry.ts`.
5. Add a focused test for the catalog schema and any real execution path.

Extensions must not store credentials in the workspace, must not claim unavailable backends, and should return structured limitations when an upstream model or service is not installed.

## Next

- LinkageMapper resistance-surface and corridor extraction behind the existing manifest.
- Optional external plugin discovery for the desktop build.
- Agent memory and recovery work remains a later P2 item, separate from this interface.
