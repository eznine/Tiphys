/**
 * Provider capabilities as MEASURED in stage 0, not as hoped.
 *
 * Numbers come from docs/CATALOG_AUDIT.md (2026-10-24). When a stage changes a
 * provider, update the note and the stage-0 baseline together, otherwise the
 * capability table becomes marketing.
 */
import type { ProviderCapability } from "./types.ts";

export const BROWSER_WASM: ProviderCapability = {
  provider: "browser-wasm",
  registry: "geolibre-wasm",
  operationVersions: { "gis.buffer": [1], "gis.reproject": [1] },
  limits: {
    cancellable: "always",
    // A WASM panic is process-wide: once a tool traps, every later tool in the
    // same instance fails with "unreachable" (stage-0 finding D2).
    isolatedExecutor: false,
  },
  notes: [
    "958 WASM tools are searchable; 34 shell tools are direct.",
    "Advanced tools are file-based (WASI /work); layers live in IndexedDB.",
    "No file-path access: inputs must be imported bytes or sample URLs.",
  ],
};

export const DESKTOP_PYTHON: ProviderCapability = {
  provider: "desktop-python",
  registry: "python-mcp",
  operationVersions: { "gis.buffer": [1], "gis.reproject": [1] },
  limits: {
    cancellable: "between-steps",
    isolatedExecutor: true,
  },
  notes: [
    "34 MCP tools, all reachable by the desktop agent.",
    "Works on real files under the project workspace; no WASM tools are reachable from the agent today.",
    "Jobs run in the engine process; cancellation is cooperative between steps.",
  ],
};

export const PROVIDERS: ProviderCapability[] = [BROWSER_WASM, DESKTOP_PYTHON];