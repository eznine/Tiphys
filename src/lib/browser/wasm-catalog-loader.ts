/** Lazy access to the large bundled GeoLibre manifest. */
export type WasmParameter = {
  name: string;
  data_kind: string;
  description?: string;
  io_role?: "input" | "output" | string;
  required?: boolean;
  schema: Record<string, any>;
};

export type WasmManifest = {
  id: string;
  display_name: string;
  summary?: string;
  category?: string;
  taxonomy?: { category?: string; subcategory?: string };
  defaults?: Record<string, unknown>;
  examples?: Array<{ args?: Record<string, unknown> }>;
  params: WasmParameter[];
};

let manifestPromise: Promise<WasmManifest[]> | undefined;

/** Load and parse the manifest once, only when a consumer actually needs it. */
export function loadWasmManifests(): Promise<WasmManifest[]> {
  return manifestPromise ??= import("./wasm-catalog.json").then(module => module.default as WasmManifest[]);
}

/** Yield between schema-conversion chunks so initial hydration does not monopolize the UI thread. */
export function yieldToMainThread(): Promise<void> {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    setImmediate?: (callback: () => void) => unknown;
  };
  if (typeof host.requestIdleCallback === "function") {
    return new Promise(resolve => host.requestIdleCallback!(() => resolve(), { timeout: 50 }));
  }
  if (typeof host.setImmediate === "function") {
    return new Promise(resolve => { host.setImmediate!(() => resolve()); });
  }
  return new Promise(resolve => setTimeout(resolve, 0));
}
