/** Resolve desktop-agent WASM inputs without ever using a layer's WGS84 display copy. */
import fs from "node:fs";
import path from "node:path";

export type InspectLayer = (layer: string) => Promise<unknown>;
export type WasmInputBinding = {
  from: string;
  path: string;
  via: "file" | "layer";
};

export async function resolveWasmInput(value: string, inspectLayer: InspectLayer): Promise<WasmInputBinding> {
  const from = String(value ?? "").trim();
  if (!from) throw new Error("WASM 输入不能为空。");
  if (fs.existsSync(from)) return { from, path: path.resolve(from), via: "file" };
  try {
    const inspected = await inspectLayer(from) as { layer?: { data?: { location?: unknown } } } | undefined;
    const location = inspected?.layer?.data?.location;
    if (typeof location === "string" && fs.existsSync(location)) {
      return { from, path: path.resolve(location), via: "layer" };
    }
  } catch {
    /* fall through to one honest error */
  }
  throw new Error(`找不到 WASM 输入图层或文件：${from}。请传工作区图层 id/名称，或引擎可读的绝对文件路径。`);
}

export async function resolveWasmInputs(inputs: Record<string, string> | undefined, inspectLayer: InspectLayer) {
  const paths: Record<string, string> = {};
  const bindings: Record<string, WasmInputBinding> = {};
  for (const [name, value] of Object.entries(inputs ?? {})) {
    const binding = await resolveWasmInput(value, inspectLayer);
    paths[name] = binding.path;
    bindings[name] = binding;
  }
  return { paths, bindings };
}
