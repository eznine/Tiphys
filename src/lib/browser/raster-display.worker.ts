// TIPHYS raster preview renderer. Reads GeoTIFF metadata and band pixels with
// the same geolibre-wasm build the tool bridge uses, stretches them and packs a
// PNG preview plus the WGS84 bounds needed for an image source. Kept separate
// from wasm-tool.worker.ts (which is generated from upstream) so the import
// script does not have to carry rendering logic in its patch block.
/// <reference lib="webworker" />
import init, { geotiff_info, geotiff_read_band_f64 } from "geolibre-wasm";

const worker = self as unknown as DedicatedWorkerGlobalScope;

export type RasterMeta = {
  width: number; height: number; bands: number; epsg: number | null;
  nodata: number | null; bbox_lonlat: [number, number, number, number];
};

export type RasterRenderRequest = { bytes: Uint8Array };
export type RasterRenderResponse =
  | { ok: true; meta: RasterMeta; png: ArrayBuffer }
  | { ok: false; error: string };

/** Largest raster we render: 64M cells ≈ 512 MiB of Float64 band data. */
const MAX_CELLS = 64_000_000;

// Viridis stops sampled at even intervals; linear interpolation between them.
const RAMP: [number, number, number][] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
];

/** Map a normalized 0-1 value to the display ramp. Exported for tests. */
export function rampColor(t: number): [number, number, number] {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const scaled = clamped * (RAMP.length - 1);
  const index = Math.min(RAMP.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const low = RAMP[index], high = RAMP[index + 1];
  return [0, 1, 2].map(i => Math.round(low[i] + (high[i] - low[i]) * frac)) as [number, number, number];
}

/**
 * Robust 2-98% stretch bounds from a (possibly huge) sample so a few extreme
 * cells cannot flatten the whole colour ramp. Exported for tests.
 */
export function stretchBounds(values: Float64Array, nodata: number | null): { min: number; max: number } {
  const stride = Math.max(1, Math.floor(values.length / 200_000));
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += stride) {
    const value = values[i];
    if (Number.isFinite(value) && (nodata === null || value !== nodata)) sample.push(value);
  }
  if (!sample.length) return { min: 0, max: 1 };
  sample.sort((a, b) => a - b);
  const low = sample[Math.floor(sample.length * 0.02)];
  const high = sample[Math.ceil(sample.length * 0.98) - 1];
  return high > low ? { min: low, max: high } : { min: low, max: low + 1 };
}

async function render(bytes: Uint8Array): Promise<RasterRenderResponse> {
  await init();
  const info = JSON.parse(geotiff_info(bytes));
  if (!info?.ok || !info.bbox_lonlat) throw new Error("无法读取该 GeoTIFF 的地理信息。");
  const meta: RasterMeta = { width: info.width, height: info.height, bands: info.bands, epsg: info.epsg ?? null, nodata: info.nodata ?? null, bbox_lonlat: info.bbox_lonlat };
  if (meta.width * meta.height > MAX_CELLS) throw new Error(`栅格过大（${meta.width}×${meta.height} 像元），当前预览上限为 6400 万像元。`);
  const band = geotiff_read_band_f64(bytes, 0);
  const { min, max } = stretchBounds(band, meta.nodata);
  const rgba = new Uint8ClampedArray(meta.width * meta.height * 4);
  for (let i = 0; i < meta.width * meta.height; i++) {
    const value = band[i];
    const transparent = !Number.isFinite(value) || (meta.nodata !== null && value === meta.nodata);
    if (transparent) { rgba[i * 4 + 3] = 0; continue; }
    const [r, g, b] = rampColor((value - min) / (max - min));
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(meta.width, meta.height);
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, meta.width, meta.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { ok: true, meta, png: await blob.arrayBuffer() };
}

worker.addEventListener("message", async (event: MessageEvent<RasterRenderRequest>) => {
  worker.postMessage({ ok: "ack" } satisfies { ok: "ack" });
  try {
    const rendered = await render(event.data.bytes);
    if (rendered.ok) worker.postMessage(rendered satisfies RasterRenderResponse, [rendered.png]);
    else worker.postMessage(rendered satisfies RasterRenderResponse);
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RasterRenderResponse);
  }
});
