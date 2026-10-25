# Desktop Agent ↔ WASM bridge

> Status: implemented and regression-tested in `agent/tests/wasm.test.ts`; this
> document describes the contract, not a new capability.

## Why it exists

The desktop Agent talks to the Python MCP engine (~34 tools). The browser Agent
can also use the ~958-tool geolibre/Whitebox WASM catalog. Without a bridge, a
desktop user asking for `坡度` or `流域` would be told the tool does not exist
while the same tool is visible on the ribbon and in the browser.

`wasm_search` + `wasm_run` expose the same frozen catalog to the desktop Agent.
They do not invent tools, and a Python tool always wins when it covers the job.

## `wasm_search`

Returns compact parameter cards read from `src/lib/browser/wasm-catalog.json`:

- exact input wire names (`input`, `d8_pntr`, `features`, …), kinds, required
  flags and cardinality;
- enum/default options for scalar parameters;
- declared output names and kinds.

Search accepts a query plus optional `input_kind`, `output_kind` and `limit`.
Aliases connect user wording to real ids (for example `汇流累积量` →
`d8_flow_accum`, `D8 流向` → `d8_pointer`); a name that does not exist in the
catalog is never synthesized. Manifest example filenames such as `dem.tif` are
not exposed as defaults — file inputs must be bound explicitly.

## `wasm_run`

```json
{
  "tool": "basins",
  "inputs": { "d8_pntr": "lyr_d8_pointer" },
  "params": { "output_name": "流域" },
  "timeout_seconds": 300
}
```

Input values may be:

1. a workspace layer id or name — resolved through `inspect_layers` to the
   layer's real analysis file (not the WGS84 display copy), or
2. an absolute file path inside an allowed workspace.

Every input is bound by its manifest wire name. `input_path` is only a
compatibility shortcut for single-input tools and cannot be combined with
`inputs`. Missing, extra or wrongly-kinded inputs fail before the child starts.

Outputs are keyed by the manifest output name. Vector outputs are converted to
CRS-tagged WGS84 GeoJSON (`geojson_path`), raster outputs stay TIFF, table
outputs stay CSV. A conversion failure is reported as a failure, never as a
saved deliverable. The Agent must call `add_data` before claiming a layer is on
the map.

Runs are staged under `TIPHYS_STATE_DIR/wasm-runs` and run in one child process
per job. A WASM trap kills the child, not the sidecar. Cancellation and timeout
are separate (`cancelled` vs `timedOut`); the default run budget is 900 seconds
and `timeout_seconds` accepts 5–900.

## Boundaries and known limits

- The bridge is a catalog executor, not a semantic guard. Two measured traps
  still require care:
  - `dissolve` in WASM 1.7.1 can silently drop geometry; use the Python engine.
  - `zonal_statistics` in this catalog expects **raster zones**. Vector polygon
    zones must use the desktop Python `zonal_statistics` implementation; the
    shared support matrix marks that path as the verified one.
- Multi-value parameters and LiDAR tools are not bridged.
- The bridge exposes tools; it does not make the desktop Agent plan multi-step
  work. Planning and acceptance remain the browser `run_plan` path until a
  desktop adapter exists.
- The Agent's workspace snapshot is refreshed each turn; a `wasm_run` output is
  not a workspace layer until `add_data` adopts it.

## Regressions

`agent/tests/wasm.test.ts` runs the real CLI, not a mock:

- reproject → 500 m buffer (independent geodesic radius check);
- `slope` → `raster_to_vector_polygons` (real raster chain, outputs inside the
  state dir);
- named two-input `add` and `zonal_statistics` (`input` + `features`);
- workspace id/name binding through `inspect_layers`;
- missing/unknown input rejection, cancellation and timeout isolation.

Run:

```bash
npm run test:agent          # all sidecar tests
npm --prefix agent run typecheck
```

Environment note: loopback-only integration tests can fail in sandboxes that
forbid `listen(0, "127.0.0.1")`; that is an environment EPERM, not a bridge
failure.
