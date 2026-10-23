// Main-thread bridge to the raster preview worker. The render call is
// injectable so Node tests can exercise adoption logic without a browser.
import type { RasterMeta } from "./raster-display.worker";

export type RasterPreview = { meta: RasterMeta; png: Uint8Array };

export type RasterRenderer = (bytes: Uint8Array) => Promise<RasterPreview>;

function spawnRenderer(): RasterRenderer {
  return async (bytes: Uint8Array) => {
    const worker = new Worker(new URL("./raster-display.worker.ts", import.meta.url), { type: "module" });
    try {
      const ready = new Promise<{ ok: true; meta: RasterMeta; png: ArrayBuffer }>((resolve, reject) => {
        worker.addEventListener("message", event => {
          const data = event.data as { ok: true; meta: RasterMeta; png: ArrayBuffer } | { ok: false; error: string } | { ok: "ack" };
          if (data.ok === "ack") return;
          if (data.ok) resolve(data);
          else reject(new Error(data.error));
        });
        worker.addEventListener("error", event => reject(new Error(event.message || "栅格渲染失败")));
      });
      worker.postMessage({ bytes });
      const result = await ready;
      return { meta: result.meta, png: new Uint8Array(result.png) };
    } finally {
      worker.terminate();
    }
  };
}

let renderer: RasterRenderer | undefined;

/** Node fallback (tests/CI): read metadata directly and emit a 1×1 placeholder
 * PNG — there is no canvas or Worker outside a browser. */
async function nodeRenderer(bytes: Uint8Array): Promise<RasterPreview> {
  const PLACEHOLDER_PNG = new Uint8Array((globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer!.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const lib = await import("geolibre-wasm");
  await lib.default({ module_or_path: new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url) });
  const info = JSON.parse(lib.geotiff_info(bytes));
  if (!info?.ok || !info.bbox_lonlat) throw new Error("无法读取该 GeoTIFF 的地理信息。");
  return { meta: { width: info.width, height: info.height, bands: info.bands, epsg: info.epsg ?? null, nodata: info.nodata ?? null, bbox_lonlat: info.bbox_lonlat }, png: PLACEHOLDER_PNG };
}

/** Real browser renderer; overridable in tests. */
export function rasterRenderer(): RasterRenderer {
  if (typeof Worker === "undefined") return nodeRenderer;
  return renderer ??= spawnRenderer();
}

export function setRasterRenderer(override: RasterRenderer | undefined) {
  renderer = override;
}
