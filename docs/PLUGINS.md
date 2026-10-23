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
  run?: (toolName: string, args: Record<string, unknown>) =>
    Promise<Record<string, unknown>> | Record<string, unknown>;
};
```

Tool schemas use the same catalog contract as Python MCP and GeoLibre WASM tools (`parameters`, `annotations`, optional `label`/`category`/`subcategory`). Plugin tools are merged into both the browser and desktop catalogs, so they appear in the two-level toolbox and are available to the browser agent.

`src/lib/plugins/registry.ts` owns registration:

- `registerExtension(manifest)` rejects duplicate extension IDs and duplicate tool names.
- `pluginToolSchemas` feeds catalog merging.
- `pluginToolNames` lets the browser engine route a tool to its extension runner.
- `runPluginTool(name, args)` finds the manifest and invokes `run`.

## Current stubs

| Tool | Category | Behavior |
| --- | --- | --- |
| `linkage_mapper_corridor` | 扩展 / 插件 | Returns an unavailable result with built-in alternatives (buffer, selection, spatial join, cost distance) |
| `whitebox_extra` | 扩展 / 插件 | Explains that GeoLibre WASM already provides raster, terrain, hydrology, and remote-sensing tools |

Stubs return `{ ok: false, available: false, ... }` rather than fabricating a layer. They are discoverable in the catalog and by `search_browser_tools`.

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
