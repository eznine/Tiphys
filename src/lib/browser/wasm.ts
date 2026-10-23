import { runWasmToolInBackground } from "./wasm-tool-runner";
import { loadWasmManifests } from "./wasm-catalog-loader";

export { loadWasmManifests };
export async function wasmTool(tool: string, input: Record<string, Uint8Array>, parameters: Record<string, string | number | boolean>, signal?: AbortSignal) {
  const result = await runWasmToolInBackground({ tool, input,
    args: Object.entries(parameters).map(([name, value]) => `--${name}=${value}`) }, { signal });
  if (result.exitCode !== 0) throw new Error(`${tool}：${result.stdout.join("\n").slice(-2500) || `退出码 ${result.exitCode}`}`);
  return result;
}
export async function fileInfo(bytes: Uint8Array, extension: string, signal?: AbortSignal): Promise<{ epsg: number | null; features: number }> {
  if (typeof window === "undefined") return JSON.parse((await import("geolibre-wasm")).vector_info(bytes, extension));
  const result = await wasmTool("__tiphys_info", { [`input.${extension}`]: bytes }, { format: extension }, signal);
  return JSON.parse(result.stdout[0]);
}
export async function originalGeojson(bytes: Uint8Array, extension: string, signal?: AbortSignal) {
  if (typeof window === "undefined") return JSON.parse((await import("geolibre-wasm")).vector_to_geojson(bytes, extension));
  const result = await wasmTool("__tiphys_geojson", { [`input.${extension}`]: bytes }, { format: extension }, signal);
  return JSON.parse(result.stdout[0]);
}
