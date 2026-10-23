import { unzipSync } from "fflate";
import type { FeatureCollection, Geometry } from "geojson";
import type { DataLayer } from "../dataLayers";
import { assertGeojson, boundsOf, metricCrs } from "./geometry";
import { rasterRenderer, type RasterRenderer } from "./raster-display";
import { deleteRecord, readRecord, records, writeRecord } from "./storage";
import { fileInfo, loadWasmManifests, originalGeojson, wasmTool } from "./wasm";
import { browserCatalogState, browserToolCatalog, ensureBrowserCatalog, hydrateWasmCatalog } from "./catalog-schema";
import { pluginToolNames, runPluginTool } from "../plugins/registry";
import type { GeeAuthStatus } from "../gee";

type LayerRecord = {
  info: Omit<DataLayer, "url">;
  geojson?: FeatureCollection;
  bytes: Uint8Array;
  extension: string;
  /** PNG preview bytes for raster layers, rendered once at adoption. */
  preview?: Uint8Array;
};
type Job = { job_id: string; label: string; status: string; progress: number; message: string; step?: string; result?: Record<string, any>; error?: string; owner: string };
export type BrowserLog = { id: string; ts: number; source: string; kind: string; level: string; summary: string; detail: unknown };
const owner = crypto.randomUUID();
const urls = new Map<string, string>();
const controllers = new Map<string, AbortController>();
const running = new Map<string, Job>();
const encoder = new TextEncoder();
export const engineEvents = new EventTarget();
const channel = typeof window === "undefined" || typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("tiphys-browser-workspace-v1");
channel?.addEventListener("message", () => engineEvents.dispatchEvent(new CustomEvent("workspace")));
const notify = () => { engineEvents.dispatchEvent(new CustomEvent("workspace")); channel?.postMessage("changed"); };
export function recordLog(kind: string, summary: string, detail: unknown, level = "info") {
  const entry: BrowserLog = { id: crypto.randomUUID(), ts: Date.now(), source: "Engine", kind, level, summary, detail };
  void writeRecord(`log:${entry.ts}:${entry.id}`, entry);
}
export async function browserLogs() { return (await records<BrowserLog>("log:")).slice(-500); }
function publicLayer(record: LayerRecord): DataLayer {
  if ((record.info.kind ?? "vector") === "raster") {
    let url = urls.get(record.info.id);
    if (!url && record.preview?.length) {
      url = URL.createObjectURL(new Blob([new Uint8Array(record.preview)], { type: "image/png" }));
      urls.set(record.info.id, url);
    }
    const [minx, miny, maxx, maxy] = record.info.bounds ?? [0, 0, 0, 0];
    return { ...record.info, url: url ?? "", image_coords: [[minx, maxy], [maxx, maxy], [maxx, miny], [minx, miny]] };
  }
  if ((record.info.kind ?? "vector") === "table") return { ...record.info, url: "" };
  let url = urls.get(record.info.id);
  if (!url) { url = URL.createObjectURL(new Blob([JSON.stringify(record.geojson)], { type: "application/geo+json" })); urls.set(record.info.id, url); }
  return { ...record.info, url };
}
export async function browserLayers() {
  const all = await records<LayerRecord>("layer:");
  // IndexedDB returns key order; the workspace draw order is kept explicitly.
  const saved = await readRecord<string[]>("workspace:layer-order");
  if (!saved?.length) return all.map(publicLayer);
  const byId = new Map(all.map(r => [r.info.id, r] as const));
  const ordered = saved.map(id => byId.get(id)).filter((r): r is LayerRecord => !!r);
  const rest = all.filter(r => !saved.includes(r.info.id));
  return [...ordered, ...rest].map(publicLayer);
}
async function resolve(value: unknown): Promise<LayerRecord> {
  const all = await records<LayerRecord>("layer:");
  const direct = all.find(r => r.info.id === value);
  if (direct) return direct;
  const matches = all.filter(r => r.info.name === value);
  if (matches.length > 1) throw new Error(`存在多个名为「${value}」的图层，请使用图层 ID。`);
  if (!matches.length) throw new Error(`找不到图层：${value}`);
  return matches[0];
}
async function removeLayer(value: unknown) {
  const record = await resolve(value);
  await deleteRecord(`layer:${record.info.id}`);
  const url = urls.get(record.info.id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(record.info.id);
  const order = await readRecord<string[]>("workspace:layer-order");
  if (order?.length) await writeRecord("workspace:layer-order", order.filter(id => id !== record.info.id));
  notify();
  return { ok: true, removed: record.info.id, name: record.info.name };
}
function epsgValue(crs: string | undefined): number | undefined {
  const match = /^EPSG:(\d+)$/i.exec(crs ?? "");
  return match ? Number(match[1]) : undefined;
}
async function reprojectLayerRecord(value: unknown, epsg: number, name: string, signal?: AbortSignal) {
  const record = await resolve(value);
  if ((record.info.kind ?? "vector") !== "vector") throw new Error("仅矢量图层可以重投影。");
  if (!Number.isInteger(epsg) || epsg < 1) throw new Error("目标 EPSG 无效。");
  if (epsgValue(record.info.crs) === epsg) return { ok: true, layer: publicLayer(record), engine: "GeoLibre WASM · 浏览器计算" };
  const result = await wasmTool("reproject_vector", { [`input.${record.extension}`]: record.bytes }, {
    input: `/work/input.${record.extension}`, epsg, output: "/work/reprojected.gpkg",
  }, signal);
  const bytes = result.files["reprojected.gpkg"];
  if (!bytes?.length) throw new Error("重投影未生成矢量文件。");
  return adopt(bytes, "gpkg", name, signal);
}
async function mergeLayerRecords(values: unknown[], name: string, signal?: AbortSignal) {
  if (!Array.isArray(values) || values.length < 2) throw new Error("合并图层至少需要两个矢量图层。");
  const records = await Promise.all(values.map(resolve));
  if (records.some(record => (record.info.kind ?? "vector") !== "vector")) throw new Error("仅矢量图层可以合并。");
  const crs = records[0].info.crs;
  if (records.some(record => record.info.crs !== crs)) throw new Error("合并图层必须使用同一坐标系。");
  const input: Record<string, Uint8Array> = {};
  const paths = records.map((record, index) => {
    const file = `input_${index}.${record.extension}`;
    input[file] = record.bytes;
    return `/work/${file}`;
  });
  const result = await wasmTool("merge_vectors", input, { inputs: paths.join(","), output: "/work/merged.gpkg" }, signal);
  const bytes = result.files["merged.gpkg"];
  if (!bytes?.length) throw new Error("图层合并未生成矢量文件。");
  return adopt(bytes, "gpkg", name, signal);
}
function fields(record: LayerRecord) { return [...new Set((record.geojson?.features ?? []).flatMap(f => Object.keys(f.properties ?? {})))]; }
function kindLabel(kind: string) { return { vector: "矢量", raster: "栅格", table: "表格" }[kind] ?? kind; }
function geeEnvironment() {
  const vite = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {});
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const read = (...names: string[]) => names.map(name => (vite[name] ?? processEnv[name] ?? "").trim()).find(Boolean);
  return {
    demo: read("TIPHYS_GEE_DEMO", "VITE_TIPHYS_GEE_DEMO") === "1",
    project: read("TIPHYS_GEE_PROJECT", "VITE_TIPHYS_GEE_PROJECT") ?? null,
    token: read("TIPHYS_GEE_TOKEN", "VITE_TIPHYS_GEE_TOKEN"),
    serviceAccount: read("TIPHYS_GEE_SA_PATH", "VITE_TIPHYS_GEE_SA_PATH"),
  };
}

/** Report only configuration presence. Never return token values or read service-account files. */
export function geeAuthStatus(): GeeAuthStatus {
  const env = geeEnvironment();
  const hasToken = Boolean(env.token);
  const hasServiceAccount = Boolean(env.serviceAccount);
  const configured = hasToken || hasServiceAccount;
  const status = env.demo ? "demo" : configured ? "configured_unverified" : "not_configured";
  const hint = env.demo
    ? "演示模式已启用：可验证表单与任务流程，但不会检索或下载真实 Earth Engine 影像。"
    : configured
      ? "已检测到 GEE 凭据配置，但当前版本尚未执行服务端会话验证，因此不声称已连接。下一步是在受信任的桌面引擎中完成认证验证。"
      : "未配置 GEE 项目或凭据。设置 TIPHYS_GEE_PROJECT 与 TIPHYS_GEE_SA_PATH（或 TIPHYS_GEE_TOKEN）后仍需服务端验证；当前可使用本地 GeoTIFF 与 GeoLibre WASM 遥感工具。";
  return {
    connected: false,
    status,
    project: env.project,
    hasToken,
    hasServiceAccount,
    hint,
    demo: env.demo,
    auth_method: hasToken ? "token" : hasServiceAccount ? "service_account" : null,
    verified: false,
    message: env.demo
      ? "GEE 处于演示模式；没有真实影像会话。"
      : configured
        ? "已识别 GEE 配置，但尚未验证连接；未检索、上传或导出任何影像。"
        : "Google Earth Engine 未配置。未检索、上传或导出任何影像。",
  };
}

function geeUnavailable(message = "Google Earth Engine 尚未连接。当前运行时没有已验证的 GEE 会话，未读取、上传或导出任何影像。") {
  return { ok: false, ...geeAuthStatus(), message };
}
function csvCell(value: unknown) {
  if (value == null) return "";
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
function position(value: unknown) {
  if (!Array.isArray(value) || value.length < 2 || value.some(v => !Number.isFinite(Number(v)))) throw new Error("源数据包含无法写入 WKT 的无效坐标。");
  return value.map(Number).join(" ");
}
function positions(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("源数据包含无法写入 WKT 的无效坐标。");
  if (!value.length) return "";
  return Array.isArray(value[0]) ? value.map(positions).filter(Boolean).join(",") : position(value);
}
function wkt(geometry: Geometry | null): string {
  if (!geometry) return "";
  if (geometry.type === "GeometryCollection") return `GEOMETRYCOLLECTION(${geometry.geometries.map(wkt).join(",")})`;
  const name = geometry.type.toUpperCase();
  const body = geometry.type === "Point"
    ? position(geometry.coordinates)
    : geometry.type === "MultiPoint" || geometry.type === "LineString"
      ? `(${positions(geometry.coordinates)})`
      : `(${geometry.coordinates.map(positions).join("),(")})`;
  return body ? `${name}(${body})` : `${name} EMPTY`;
}
async function exportCsv(record: LayerRecord, signal?: AbortSignal) {
  const source = await originalGeojson(record.bytes, record.extension, signal) as FeatureCollection;
  // CSV keeps the layer's native CRS, so unlike the display copy it is not
  // required to carry WGS84 longitude/latitude coordinates.
  if (source?.type !== "FeatureCollection" || !Array.isArray(source.features) || source.features.some(f => f?.type !== "Feature")) throw new Error("源数据无法读回为有效的矢量要素集合。");
  const columns = [...new Set(source.features.flatMap(f => Object.keys(f.properties ?? {})))];
  const lines = [ [...columns, "geometry"].map(csvCell).join(","),
    ...source.features.map(f => [...columns.map(name => csvCell(f.properties?.[name])), csvCell(wkt(f.geometry))].join(",")) ];
  return encoder.encode(`${lines.join("\n")}\n`);
}
async function adopt(bytes: Uint8Array, extension: string, name: string, signal?: AbortSignal) {
  const meta = await fileInfo(bytes, extension, signal);
  if (!meta.epsg) throw new Error("源坐标系未定义，请在导入时指定源坐标系。");
  const converted = await wasmTool("vector_convert", { [`input.${extension}`]: bytes }, { input: `/work/input.${extension}`, output: "/work/display.geojson" }, signal);
  const json = JSON.parse(new TextDecoder().decode(converted.files["display.geojson"])); assertGeojson(json);
  if (meta.features !== json.features.length) throw new Error("数据读回校验失败：要素数量不一致。");
  const record: LayerRecord = { info: { id: `lyr_${crypto.randomUUID().replace(/-/g, "")}`, name, crs: `EPSG:${meta.epsg}`,
    feature_count: json.features.length, bounds: boundsOf(json), geometry_types: [...new Set(json.features.map(f => f.geometry?.type).filter((v): v is NonNullable<typeof v> => !!v))], visible: true }, geojson: json, bytes, extension };
  signal?.throwIfAborted();
  await writeRecord(`layer:${record.info.id}`, record, signal);
  notify();
  return { ok: true, layer: publicLayer(record), engine: "GeoLibre WASM · 浏览器计算" };
}
async function adoptRaster(bytes: Uint8Array, name: string, render: RasterRenderer, signal?: AbortSignal) {
  const { meta, png } = await render(bytes);
  if (!png?.length || !meta.width || !meta.height) throw new Error("栅格预览渲染失败，结果未添加。");
  const [minx, miny, maxx, maxy] = meta.bbox_lonlat;
  const record: LayerRecord = {
    info: { id: `lyr_${crypto.randomUUID().replace(/-/g, "")}`, name, crs: meta.epsg ? `EPSG:${meta.epsg}` : "未定义坐标系",
      feature_count: 0, bounds: [minx, miny, maxx, maxy], geometry_types: [], kind: "raster",
      raster: { width: meta.width, height: meta.height, bands: meta.bands }, visible: true },
    bytes, extension: "tif", preview: png,
  };
  signal?.throwIfAborted();
  await writeRecord(`layer:${record.info.id}`, record, signal);
  notify();
  return { ok: true, layer: publicLayer(record), engine: "GeoLibre WASM · 浏览器计算" };
}
/** Minimal CSV split: tables come back as ASCII/UTF-8 tool outputs. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}
async function adoptTable(bytes: Uint8Array, name: string, signal?: AbortSignal) {
  const rows = parseCsvRows(new TextDecoder().decode(bytes));
  const record: LayerRecord = {
    info: { id: `lyr_${crypto.randomUUID().replace(/-/g, "")}`, name, crs: "无（表格）", feature_count: Math.max(0, rows.length - 1),
      bounds: null, geometry_types: [], kind: "table", visible: true },
    bytes, extension: "csv",
  };
  signal?.throwIfAborted();
  await writeRecord(`layer:${record.info.id}`, record, signal);
  notify();
  return { ok: true, layer: publicLayer(record), engine: "GeoLibre WASM · 浏览器计算" };
}
async function project(record: LayerRecord, epsg: number, signal?: AbortSignal) {
  const result = await wasmTool("reproject_vector", { [`input.${record.extension}`]: record.bytes }, { input: `/work/input.${record.extension}`, epsg, output: "/work/result.fgb" }, signal);
  if (!result.files["result.fgb"]?.length) throw new Error("重投影未生成数据文件。");
  return result.files["result.fgb"];
}
async function projectBytes(bytes: Uint8Array, extension: string, epsg: number, signal?: AbortSignal) {
  const result = await wasmTool("reproject_vector", { [`input.${extension}`]: bytes }, { input: `/work/input.${extension}`, epsg, output: "/work/result.fgb" }, signal);
  if (!result.files["result.fgb"]?.length) throw new Error("重投影未生成数据文件。");
  return result.files["result.fgb"];
}
function metricDistance(raw: unknown, units = "meters") {
  const factor = ({ meters: 1, kilometers: 1000, miles: 1609.344 } as Record<string, number>)[units];
  const value = Number(raw) * factor;
  if (!Number.isFinite(value) || value <= 0 || value > 5_000_000) throw new Error("距离必须为正数且不超过 5000 千米，并使用有效单位。");
  return value;
}
export const browserCatalog = browserToolCatalog;
function validate(name: string, args: Record<string, any>) {
  const t = browserCatalog.find(t => t.name === name);
  if (!t) throw new Error(`当前浏览器引擎不支持工具：${name}`);
  const schema = t.parameters as { properties: Record<string, any>; required?: string[] };
  for (const key of schema.required ?? []) if (args[key] === undefined || args[key] === null || args[key] === "") throw new Error(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (!(key in schema.properties)) throw new Error(`未知参数：${key}`);
    const s = schema.properties[key].anyOf?.find((v: any) => v.type !== "null") ?? schema.properties[key];
    if (value == null && schema.properties[key].anyOf?.some((v: any) => v.type === "null")) continue;
    if (s.type === "number" || s.type === "integer") { if (typeof value !== "number" || !Number.isFinite(value) || s.type === "integer" && !Number.isInteger(value)) throw new Error(`参数 ${key} 必须为有效数字。`); }
    if (s.type === "array") { if (!Array.isArray(value)) throw new Error(`参数 ${key} 的类型应为数组。`); }
    else if (s.type && typeof value !== s.type) throw new Error(`参数 ${key} 的类型应为 ${s.type}。`);
    if (s.enum && !s.enum.includes(value)) throw new Error(`参数 ${key} 不在允许值中。`);
    if (s.minimum !== undefined && value < s.minimum || s.maximum !== undefined && value > s.maximum) throw new Error(`参数 ${key} 超出允许范围。`);
  }
}
/** Output file extension per tool output data kind; file outputs keep the tool's own choice. */
const OUTPUT_EXT: Record<string, string> = { vector: "fgb", raster: "tif", table: "csv", text: "txt", json: "json" };
/** Formats the WASI build can actually read/write; example paths sometimes name others (e.g. shp). */
const SUPPORTED_EXT: Record<string, string[]> = {
  vector: ["geojson", "topojson", "gml", "gpx", "kml", "fgb", "gpkg", "kmz", "geoparquet"],
  raster: ["tif", "tiff"],
};
const ATTACHMENT_KINDS = new Set(["file", "text", "json"]);
async function runNative(id: string, args: Record<string, any>, signal?: AbortSignal) {
  const manifest = (await loadWasmManifests()).find(t => t.id === id);
  if (!manifest) throw new Error("未知 WASM 工具。");
  // Format-defining tools read the extension from the output path, so prefer the
  // extension used in the tool's own example when we have one.
  const outputExt = (p: { name: string; data_kind: string }) => {
    const example = (manifest.examples?.[0]?.args as Record<string, unknown> | undefined)?.[p.name];
    const fromExample = typeof example === "string" && example.includes(".") ? example.split(".").pop()! : "";
    const allowed = SUPPORTED_EXT[p.data_kind];
    if (allowed && !allowed.includes(fromExample)) return OUTPUT_EXT[p.data_kind] ?? "bin";
    return fromExample || (OUTPUT_EXT[p.data_kind] ?? "bin");
  };
  const input: Record<string, Uint8Array> = {}, parameters: Record<string, any> = {};
  let vectorCrs: string | undefined;
  for (const p of manifest.params) {
    if (p.io_role === "input") {
      if (!args[p.name]) continue;
      const record = await resolve(args[p.name]);
      const kind = record.info.kind ?? "vector";
      if (kind !== p.data_kind) throw new Error(`参数 ${p.name} 需要${kindLabel(String(p.data_kind))}输入，但「${record.info.name}」是${kindLabel(kind)}图层。`);
      if (kind === "vector") {
        if (vectorCrs && record.info.crs !== vectorCrs) throw new Error("高级工具的输入图层坐标系不同，请先重投影到同一坐标系。");
        vectorCrs = record.info.crs;
      }
      const file = `${p.name}.${record.extension}`; input[file] = record.bytes; parameters[p.name] = `/work/${file}`;
    } else if (p.io_role === "output") parameters[p.name] = `/work/${p.name}.${outputExt(p)}`;
    else if (args[p.name] !== undefined && args[p.name] !== "") parameters[p.name] = args[p.name];
  }
  const result = await wasmTool(id, input, parameters, signal);
  const outputs = manifest.params.filter(p => p.io_role === "output");
  const published = { layers: [] as Record<string, any>[], attachments: [] as Record<string, any>[] };
  let firstName = "";
  for (const p of outputs) {
    const match = Object.entries(result.files).find(([file]) => file === parameters[p.name] || file.endsWith(`/${parameters[p.name]}`) || file.split("/").pop() === parameters[p.name]?.split("/").pop());
    if (!match) {
      if (p.required) throw new Error("工具没有生成声明的必需输出，请检查参数和输入数据。");
      continue;
    }
    const [file, bytes] = match;
    if (!bytes?.length) { if (p.required) throw new Error(`输出 ${p.name} 是空的。`); continue; }
    const base = String(args.output_name || "") || firstName || manifest.display_name;
    const name = outputs.length > 1 ? `${base}_${p.name}` : base;
    firstName = firstName || base;
    // Vector outputs may be written in the tool's example format (e.g. shp);
    // adopt with the actual extension so the read-back conversion is correct.
    if (p.data_kind === "vector") published.layers.push(await adopt(bytes, file.split(".").pop() || "fgb", name, signal));
    else if (p.data_kind === "raster") published.layers.push(await adoptRaster(bytes, name, rasterRenderer(), signal));
    else if (p.data_kind === "table") published.layers.push(await adoptTable(bytes, name, signal));
    else if (ATTACHMENT_KINDS.has(p.data_kind)) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: p.data_kind === "json" ? "application/json" : "application/octet-stream" }));
      published.attachments.push({ name: file.split("/").pop() ?? p.name, kind: p.data_kind, bytes: bytes.length, url });
    }
  }
  if (!published.layers.length && !published.attachments.length) throw new Error("工具运行结束但没有生成结果文件，请检查参数和输入数据。");
  const single = published.layers.length === 1 ? published.layers[0] : undefined;
  return { ok: true, ...(single ? single : {}), layers: published.layers.length ? published.layers : undefined,
    attachments: published.attachments.length ? published.attachments : undefined,
    engine: "GeoLibre WASM · 浏览器计算" };
}
async function spatialJoin(record: LayerRecord, other: LayerRecord, args: Record<string, any>, signal?: AbortSignal) {
  const predicate = String(args.predicate ?? "intersects");
  if (!["intersects", "contains", "within", "nearest"].includes(predicate)) throw new Error("空间连接仅支持 intersects、contains、within 或 nearest。");
  const epsg = Number(record.info.crs?.split(":")[1]);
  if (!Number.isInteger(epsg)) throw new Error("空间连接要求输入图层具有 EPSG 坐标系。");
  const keepFields = args.keep_fields !== false;
  const outputName = String(args.output_name || `${record.info.name}_${predicate}`);
  let bytes: Uint8Array;
  if (predicate === "nearest") {
    const near = await wasmTool("generate_near_table", { [`input.${record.extension}`]: record.bytes, "near_features.fgb": await project(other, epsg, signal) },
      { input: `/work/input.${record.extension}`, near_features: "/work/near_features.fgb", closest_count: 1, output: "/work/near_table.fgb" }, signal);
    const tableBytes = near.files["near_table.fgb"];
    if (!tableBytes?.length) throw new Error("最近邻空间连接没有生成结果。");
    const table: FeatureCollection = await originalGeojson(tableBytes, "fgb", signal) as FeatureCollection;
    const matches = new Map<number, Record<string, any>>();
    for (const row of table.features) if (row.properties) matches.set(Number(row.properties.IN_FID), row.properties);
    const source: FeatureCollection = await originalGeojson(record.bytes, record.extension, signal) as FeatureCollection;
    const joinFeatures = other.geojson!.features;
    const joined = {
      ...source,
      crs: { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } },
      features: source.features.map((feature, index) => {
        const properties = { ...(feature.properties ?? {}) };
        const match = matches.get(index);
        const nearestId = Number(match?.NEAR_FID);
        const joinProperties = Number.isInteger(nearestId) && nearestId >= 0 ? joinFeatures[nearestId]?.properties : undefined;
        if (keepFields && joinProperties) for (const [key, value] of Object.entries(joinProperties)) properties[`JOIN_${key}`] = value;
        if (match?.NEAR_DIST !== undefined) properties.NEAR_DIST = match.NEAR_DIST;
        return { ...feature, properties };
      }),
    } as FeatureCollection & { crs: { type: string; properties: { name: string } } };
    bytes = encoder.encode(JSON.stringify(joined));
    return { ...(await adopt(bytes, "geojson", outputName, signal)), predicate, join_layer_id: other.info.id, feature_count: joined.features.length };
  }
  const joined = await wasmTool("spatial_join", {
    [`target.${record.extension}`]: record.bytes,
    "join.fgb": await project(other, epsg, signal),
  }, {
    target: `/work/target.${record.extension}`, join: "/work/join.fgb", predicate, strategy: "first", prefix: "JOIN_", output: "/work/joined.fgb",
  }, signal);
  bytes = joined.files["joined.fgb"];
  if (!bytes?.length) throw new Error("空间连接没有生成结果。");
  if (!keepFields) {
    const collection: FeatureCollection = await originalGeojson(bytes, "fgb", signal) as FeatureCollection;
    for (const feature of collection.features) {
      if (!feature.properties) continue;
      for (const key of Object.keys(feature.properties)) if (key.startsWith("JOIN_")) delete feature.properties[key];
    }
    bytes = encoder.encode(JSON.stringify(collection));
    const output = await adopt(bytes, "geojson", outputName, signal);
    return { ...output, predicate, join_layer_id: other.info.id };
  }
  return { ...(await adopt(bytes, "fgb", outputName, signal)), predicate, join_layer_id: other.info.id };
}
async function execute(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<Record<string, any>> {
  if (name.startsWith("wasm_")) return runNative(name.slice(5), args, signal);
  if (name === "remove_layer") return removeLayer(args.layer);
  if (pluginToolNames.has(name)) return runPluginTool(name, args, {
    runTool: (toolName, toolArgs) => execute(toolName, toolArgs, signal),
    inspectLayer: async value => {
      const record = await resolve(value);
      return {
        id: record.info.id,
        name: record.info.name,
        kind: record.info.kind ?? "vector",
        crs: record.info.crs ?? "未定义坐标系",
        feature_count: record.info.feature_count,
        bounds: record.info.bounds ?? null,
        geometry_types: [...record.info.geometry_types],
        geojson: record.geojson,
      };
    },
    createLayer: async (geojson, layerName) => {
      if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) throw new Error("扩展生成的 GeoJSON 无效。");
      return adopt(encoder.encode(JSON.stringify(geojson)), "geojson", layerName, signal);
    },
    reprojectLayer: (layer, epsg, layerName) => reprojectLayerRecord(layer, epsg, layerName, signal),
    mergeLayers: (layers, layerName) => mergeLayerRecords(layers, layerName, signal),
  });
  if (name === "list_supported_formats") return {
    ok: true,
    runtime: "browser-wasm",
    vector: ["GeoJSON (.geojson/.json)", "GeoPackage (.gpkg)", "Shapefile (.zip，需含 .shp/.shx/.dbf)", "FlatGeobuf (.fgb)", "KML/KMZ (.kml/.kmz)", "GPX (.gpx)", "GML (.gml)", "GeoParquet (.geoparquet)", "TopoJSON (.topojson)"],
    raster: ["GeoTIFF (.tif/.tiff)"],
    table: ["CSV (.csv，作为只读表格导入)"],
    arcgis: {
      mxd: "不支持直接解析；请在 ArcGIS 中导出要素为 GeoPackage、Shapefile ZIP 或 GeoJSON。",
      aprx: "不支持直接解析；APRX 工程内容请先导出为开放格式。",
      file_gdb: "浏览器端不支持 ESRI File Geodatabase；请导出为 GeoPackage 或 Shapefile ZIP。",
    },
    preferred: ["GeoPackage", "GeoJSON", "FlatGeobuf", "Shapefile ZIP", "GeoTIFF"],
  };
  if (name === "import_arcgis_project") {
    const path = String(args.path ?? "");
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return { ok: false, supported: false, path, format: ext === "gdb" ? "ESRI File Geodatabase" : ext === "mxd" ? "ArcMap document" : ext === "aprx" ? "ArcGIS Pro project" : "unknown",
      message: "当前版本不解析 ArcGIS 专有工程或文件地理数据库，未读取该文件。",
      alternatives: ["GeoPackage (.gpkg)", "GeoJSON (.geojson)", "Shapefile ZIP (.zip)", "KML/KMZ", "GeoTIFF"],
      hint: "在 ArcGIS 中使用“导出要素/转换地理数据库”，或运行“支持的格式”查看完整列表。" };
  }
  if (name === "gee_auth_status") {
    return geeAuthStatus();
  }
  if (name === "gee_search_collection") {
    const collection = String(args.collection ?? "COPERNICUS/S2_SR_HARMONIZED");
    const auth = geeAuthStatus();
    return {
      ok: false,
      ...auth,
      collection,
      items: [],
      start_date: args.start_date ?? null,
      end_date: args.end_date ?? null,
      max_cloud: args.max_cloud ?? null,
      bbox: args.bbox ?? null,
      message: auth.connected
        ? "GEE 已连接。"
        : auth.demo
          ? "演示模式不检索真实影像集合；返回空列表。"
          : "GEE 尚未验证连接，未检索影像集合。返回空列表，不代表该集合不存在。",
    };
  }
  if (name === "gee_export_raster") {
    const auth = geeAuthStatus();
    const collection = String(args.collection ?? "COPERNICUS/S2_SR_HARMONIZED");
    const band = String(args.band ?? "B4");
    const output = String(args.path || `${collection.split("/").pop() ?? "gee"}_${band}.tif`);
    if (!auth.demo && !auth.connected) {
      return {
        ok: false,
        ...auth,
        message: "GEE 导出任务未执行：未连接已验证的 Earth Engine 会话，因此没有下载或写入栅格文件。",
        collection,
        band,
        requested_path: output,
      };
    }
    return {
      ok: true,
      demo: auth.demo,
      connected: auth.connected,
      status: auth.demo ? "demo_completed" : "completed",
      collection,
      band,
      path: output,
      hasToken: auth.hasToken,
      hasServiceAccount: auth.hasServiceAccount,
      project: auth.project,
      message: auth.demo ? "演示任务已完成。这是本地模拟结果，没有下载真实 GEE 影像。" : "GEE 导出已完成。",
      hint: auth.demo ? "TIPHYS_GEE_DEMO=1 仅用于验证任务流程；连接真实 GEE 后才会生成 GeoTIFF。" : auth.hint,
    };
  }
  if (name === "gee_job_status") {
    const jobId = String(args.job_id ?? "");
    const auth = geeAuthStatus();
    try {
      const job = await readBrowserJob(jobId);
      return {
        ok: job.status === "completed" && job.result?.ok !== false,
        connected: false,
        status: auth.status,
        demo: Boolean(job.result?.demo) || auth.demo,
        project: auth.project,
        hasToken: auth.hasToken,
        hasServiceAccount: auth.hasServiceAccount,
        hint: auth.hint,
        job: { job_id: job.job_id, status: job.status, progress: job.progress, step: job.step, message: job.message, result: job.result, error: job.error },
      };
    } catch {
      return {
        ...geeUnavailable("找不到该 GEE 任务。当前浏览器没有已连接的 GEE 任务记录。"),
        job_id: jobId,
        job_status: "unknown",
      };
    }
  }
  if (name === "add_data") {
    const path = String(args.path).replace(/\\/g, "/");
    if (!/^samples\/[\w.-]+\.geojson$/.test(path)) throw new Error("浏览器无法读取电脑路径。请点击添加数据选择文件，或使用 samples/beijing_points.geojson。");
    const response = await fetch(`${import.meta.env.BASE_URL}${path}`, { signal });
    if (!response.ok) throw new Error("找不到样例数据。");
    return adopt(new Uint8Array(await response.arrayBuffer()), "geojson", args.name || path.split("/").pop()!.replace(/\.geojson$/, ""), signal);
  }
  const record = await resolve(args.layer);
  if ((record.info.kind ?? "vector") !== "vector") throw new Error(`该工具适用于矢量图层，「${record.info.name}」是${kindLabel(record.info.kind ?? "vector")}。`);
  const outputName = args.output_name || `${record.info.name}_${name}`;
  if (name === "spatial_join") {
    const other = await resolve(args.join_layer);
    if ((other.info.kind ?? "vector") !== "vector") throw new Error("连接图层必须是矢量图层。");
    return spatialJoin(record, other, args, signal);
  }
  if (name === "select_by_attributes") {
    if (!fields(record).includes(args.field)) throw new Error("找不到指定字段。");
    const values = record.geojson!.features.map(f => f.properties?.[args.field]).filter(v => v != null);
    const numeric = values.length > 0 && values.every(v => typeof v === "number");
    let comparison: any = args.value;
    if (!["isnull", "notnull"].includes(args.op) && numeric) { comparison = Number(args.value); if (!Number.isFinite(comparison)) throw new Error("数值字段必须使用有效数值。"); }
    const selected = record.geojson!.features.filter(f => {
      const value = f.properties?.[args.field];
      if (args.op === "isnull") return value == null;
      if (args.op === "notnull") return value != null;
      if (value == null) return false;
      switch (args.op) { case "eq": return value === comparison; case "ne": return value !== comparison; case "gt": return value > comparison; case "ge": return value >= comparison; case "lt": return value < comparison; case "le": return value <= comparison; case "contains": return String(value).includes(String(comparison)); case "startswith": return String(value).startsWith(String(comparison)); case "endswith": return String(value).endsWith(String(comparison)); default: throw new Error("不支持的比较方式。"); }
    });
    return adopt(encoder.encode(JSON.stringify({ type: "FeatureCollection", features: selected })), "geojson", outputName, signal);
  }
  if (name === "export_features") {
    const format = args.fmt ?? "geojson";
    if (!["geojson", "gpkg", "fgb", "csv"].includes(format)) throw new Error("浏览器当前支持导出 GeoJSON、GeoPackage、FlatGeobuf 和 CSV。");
    const bytes = format === "csv" ? await exportCsv(record, signal)
      : (await wasmTool("vector_convert", { [`input.${record.extension}`]: record.bytes }, { input: `/work/input.${record.extension}`, output: `/work/export.${format}` }, signal)).files[`export.${format}`];
    if (!bytes?.length) throw new Error("导出未生成有效文件。");
    const filename = String(args.path).replace(/\\/g, "/").split("/").pop() || `${record.info.name}.${format}`;
    if (await readRecord(`download:${filename}`) && !args.overwrite) throw new Error("浏览器存储中已有同名导出文件，若要替换请明确勾选覆盖。");
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/octet-stream" }));
    await writeRecord(`download:${filename}`, { filename, bytes });
    return { ok: true, path: filename, download_url: url, bytes: bytes.length, feature_count: record.info.feature_count, message: "点击下载文件保存到电脑。" };
  }
  let inputBytes = record.bytes, extension = record.extension;
  let tool = name, params: Record<string, string | number | boolean> = {};
  const inputs: Record<string, Uint8Array> = {};
  if (["buffer", "simplify"].includes(name)) {
    const distance = metricDistance(name === "buffer" ? args.distance : args.tolerance, args.units);
    inputBytes = await project(record, metricCrs(record.geojson!, name === "buffer" ? distance : 0), signal); extension = "fgb";
    tool = name === "buffer" ? "buffer_vector" : "simplify_features";
    params = name === "buffer" ? { distance, dissolve: args.dissolve ?? false, quadrant_segments: 16 } : { tolerance: distance };
  } else if (name === "reproject") {
    const match = /^EPSG:(\d+)$/i.exec(args.target_crs);
    if (!match) throw new Error("浏览器重投影请使用 EPSG:编号。");
    return adopt(await project(record, Number(match[1]), signal), "fgb", outputName, signal);
  } else if (name === "convex_hull") { tool = "minimum_convex_hull"; params.individual_feature_hulls = false; }
  else if (name === "dissolve") { tool = "dissolve"; if (args.by_field) { if (!fields(record).includes(args.by_field)) throw new Error("找不到融合字段。"); params.dissolve_field = args.by_field; } }
  else if (name === "calculate_geometry") {
    // Geodesic mode measures WGS84 input directly. Reprojecting the measured
    // FlatGeobuf back trips an upstream FlatGeobuf reader panic in 1.7.1.
    const first = await wasmTool("add_geometry_attributes", { [`input.${record.extension}`]: record.bytes }, { input: `/work/input.${record.extension}`, measurement_mode: "geodesic", centroid: false, output: "/work/measured_out.fgb" }, signal);
    let measured = first.files["measured_out.fgb"];
    if (!measured?.length) throw new Error("面积与长度计算没有生成结果。");
    // Polygons report perimeter separately; the desktop contract uses length_m
    // for polygon perimeter, as GeoPandas does.
    const polygon = record.info.geometry_types.every(t => ["Polygon", "MultiPolygon"].includes(t));
    for (const [field, newField] of [["AREA_M2", "area_m2"], [polygon ? "PERIM_M" : "LENGTH_M", "length_m"]]) {
      const renamed = await wasmTool("rename_field", { "named.fgb": measured }, { input: "/work/named.fgb", field, new_field: newField, output: "/work/named_out.fgb" }, signal);
      if (!renamed.files["named_out.fgb"]?.length) throw new Error(`无法写入 ${newField} 字段。`);
      measured = renamed.files["named_out.fgb"];
    }
    const output = await adopt(measured, "fgb", outputName, signal);
    return { ...output, added_columns: ["area_m2", "length_m"], analysis_crs: output.layer.crs, source_layer_id: record.info.id };
  }
  else if (name === "union_layers") {
    const other = await resolve(args.other_layer);
    const epsg = Number(record.info.crs?.split(":")[1]);
    if (!Number.isInteger(epsg)) throw new Error("图层坐标系必须为 EPSG 编号。");
    if (![...record.info.geometry_types, ...other.info.geometry_types].every(t => ["Polygon", "MultiPolygon"].includes(t))) throw new Error("联合工具当前要求两个输入都是面图层。");
    inputs["overlay.fgb"] = await project(other, epsg, signal);
    inputs["input.fgb"] = await project(record, epsg, signal);
    const unioned = await wasmTool("union", inputs, { input: "/work/input.fgb", overlay: "/work/overlay.fgb", output: "/work/union.fgb" }, signal);
    if (!unioned.files["union.fgb"]?.length) throw new Error("联合没有生成结果文件。");
    const native = await projectBytes(unioned.files["union.fgb"], "fgb", epsg, signal);
    return adopt(native, "fgb", outputName, signal);
  }
  else if (["clip", "intersection", "erase", "select_by_location"].includes(name)) {
    const other = await resolve(args.mask_layer ?? args.other_layer ?? args.filter_layer);
    const epsg = Number(record.info.crs?.split(":")[1]);
    inputs["overlay.fgb"] = await project(other, epsg, signal);
    const pointClip = name === "clip" && record.info.geometry_types.every(t => t === "Point");
    if (name !== "select_by_location" && !pointClip && record.info.geometry_types.some(t => !["Polygon", "MultiPolygon"].includes(t))) throw new Error("当前浏览器叠加工具支持面；点裁剪会使用精确相交选择。线、多点及混合类型的裁剪尚未接入。");
    if (name !== "select_by_location" && other.info.geometry_types.some(t => !["Polygon", "MultiPolygon"].includes(t))) throw new Error("叠加掩膜必须是面图层。");
    if (name === "select_by_location" || pointClip) { tool = "select_by_location"; params = { target: `/work/input.${extension}`, query: "/work/overlay.fgb", predicate: pointClip ? "intersects" : args.predicate ?? "intersects" }; }
    else { tool = name === "intersection" ? "intersect" : name; params.overlay = "/work/overlay.fgb"; }
  } else throw new Error(`尚未实现浏览器工具：${name}`);
  inputs[`input.${extension}`] = inputBytes;
  const result = await wasmTool(tool, inputs, { ...(tool !== "select_by_location" ? { input: `/work/input.${extension}` } : {}), ...params, output: "/work/result.fgb" }, signal);
  if (!result.files["result.fgb"]?.length) throw new Error("工具运行结束但没有生成结果文件。");
  return adopt(result.files["result.fgb"], "fgb", outputName, signal);
}
export async function importBrowserFile(file: Blob, filename: string, sourceCrs?: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "geojson";
  if (file.size > 128 * 1024 * 1024) throw new Error("浏览器当前单文件导入上限为 128 MiB。");
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (extension === "zip") return importShapefileZip(bytes, filename, sourceCrs);
  if (extension === "tif" || extension === "tiff") {
    if (sourceCrs) throw new Error("GeoTIFF 自带坐标系信息，无需指定源坐标系。");
    return adoptRaster(bytes, filename.replace(/\.[^.]+$/, ""), rasterRenderer());
  }
  if (extension === "csv") return adoptTable(bytes, filename.replace(/\.[^.]+$/, ""));
  if (sourceCrs) {
    if (!["geojson", "json"].includes(extension)) throw new Error("当前源坐标系覆盖仅适用于 GeoJSON；其他格式请使用包含坐标系的数据文件。");
    const data = JSON.parse(new TextDecoder().decode(bytes)); data.crs = { type: "name", properties: { name: sourceCrs } }; bytes = encoder.encode(JSON.stringify(data));
  }
  return adopt(bytes, extension === "json" ? "geojson" : extension, filename.replace(/\.[^.]+$/, ""));
}
async function importShapefileZip(bytes: Uint8Array, filename: string, sourceCrs?: string) {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries).filter(n => !n.split("/").some(part => part === "__MACOSX" || part.startsWith(".")));
  const shapes = names.filter(n => n.toLowerCase().endsWith(".shp"));
  if (shapes.length !== 1) throw new Error(shapes.length ? "压缩包里有多个 Shapefile；当前一次导入一个。" : "压缩包中没有找到 .shp 文件。");
  const shp = shapes[0], dir = shp.slice(0, shp.lastIndexOf("/") + 1), stem = shp.slice(0, -4), base = stem.slice(dir.length);
  const input: Record<string, Uint8Array> = {};
  for (const ext of ["shp", "shx", "dbf", "prj"]) {
    const match = names.find(n => n.toLowerCase() === `${stem}.${ext}`.toLowerCase());
    if (match) input[`${base}.${ext}`] = entries[match];
  }
  if (!input[`${base}.shx`] || !input[`${base}.dbf`]) throw new Error("Shapefile 压缩包必须同时包含 .shp、.shx 和 .dbf。");
  const result = await wasmTool("vector_convert", { [`${base}.shp`]: input[`${base}.shp`], [`${base}.shx`]: input[`${base}.shx`], [`${base}.dbf`]: input[`${base}.dbf`], ...(input[`${base}.prj`] ? { [`${base}.prj`]: input[`${base}.prj`] } : {}) }, { input: `/work/${base}.shp`, output: "/work/shapefile.fgb" }, undefined);
  const converted = result.files["shapefile.fgb"];
  if (!converted?.length) throw new Error("Shapefile 转换没有生成数据。");
  let data = converted;
  if (sourceCrs) {
    const match = /^EPSG:(\d+)$/i.exec(sourceCrs); if (!match) throw new Error("源坐标系请使用 EPSG:编号。");
    const assigned = await wasmTool("assign_projection_vector", { "crs.fgb": data }, { input: "/work/crs.fgb", epsg: Number(match[1]), output: "/work/assigned.fgb" });
    data = assigned.files["assigned.fgb"]; if (!data?.length) throw new Error("无法设置 Shapefile 坐标系。");
  }
  return adopt(data, "fgb", filename.replace(/\.zip$/i, ""));
}
export async function runBrowserTool(name: string, args: Record<string, any> = {}): Promise<Record<string, any>> {
  if (name.startsWith("wasm_")) await hydrateWasmCatalog();
  validate(name, args); recordLog("tool-call", name, args);
  if (name === "ping") return { ok: true, service: "tiphys-engine", runtime: "browser-wasm" };
  if (name === "list_layers") return { layers: await browserLayers() };
  if (name === "job_status") return readBrowserJob(args.job_id);
  if (name === "job_cancel") return cancelBrowserJob(args.job_id);
  if (name === "describe_layer") return describe(await resolve(args.layer));
  if (["list_supported_formats", "import_arcgis_project", "gee_auth_status", "gee_search_collection", "gee_job_status"].includes(name))
    return execute(name, args);
  if (name === "remove_layer") return removeLayer(args.layer);
  if (name === "rename_layer") {
    const record = await resolve(args.layer);
    const next = String(args.name ?? "").trim();
    if (!next) throw new Error("图层名称不能为空。");
    const all = await records<LayerRecord>("layer:");
    if (all.some(r => r.info.name === next && r.info.id !== record.info.id)) throw new Error(`已有图层叫「${next}」，请换一个名称。`);
    const renamed: LayerRecord = { ...record, info: { ...record.info, name: next } };
    await writeRecord(`layer:${record.info.id}`, renamed); notify();
    return { ok: true, renamed: record.info.id, layer: publicLayer(renamed) };
  }
  if (name === "reorder_layers") {
    const ids: string[] = Array.isArray(args.layer_ids) ? args.layer_ids.map(String) : [];
    const all = await records<LayerRecord>("layer:");
    const known = all.map(r => r.info.id);
    if (ids.length !== known.length || new Set(ids).size !== ids.length || !ids.every(id => known.includes(id))) {
      throw new Error("需要提供全部现有图层 ID，每个恰好一次。");
    }
    await writeRecord("workspace:layer-order", ids); notify();
    return { ok: true, order: ids };
  }
  if (name === "field_statistics") {
    const record = await resolve(args.layer);
    const field = String(args.field ?? "");
    if ((record.info.kind ?? "vector") !== "vector") throw new Error("字段统计适用于矢量图层。");
    if (!fields(record).includes(field)) throw new Error("找不到指定字段。");
    const values = record.geojson!.features.map(f => f.properties?.[field]);
    const present = values.filter((v): v is string | number | boolean => v != null && v !== "");
    const stats: Record<string, any> = { layer: record.info.id, field, count: values.length,
      null_count: values.length - present.length, unique_count: new Set(present.map(v => String(v))).size };
    if (present.length && present.every(v => typeof v === "number" && Number.isFinite(v))) {
      const numbers = present as number[];
      const sorted = [...numbers].sort((a, b) => a - b);
      const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const std = sorted.length > 1 ? Math.sqrt(numbers.reduce((a, b) => a + (b - mean) ** 2, 0) / (sorted.length - 1)) : 0;
      stats.min = sorted[0]; stats.max = sorted[sorted.length - 1]; stats.mean = mean; stats.median = median; stats.std = std;
    } else {
      const counts = new Map<string, number>();
      for (const value of present) { const key = String(value); counts.set(key, (counts.get(key) ?? 0) + 1); }
      stats.top_values = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
    }
    return stats;
  }
  if (["zoom_to_layer", "open_attribute_table", "set_layer_symbology", "set_layer_labels"].includes(name)) {
    const record = await resolve(args.layer);
    const view: Record<string, any> = { layer_id: record.info.id };
    if (name === "zoom_to_layer") { if (!record.info.bounds) throw new Error("空图层没有可缩放范围。"); view.action = "zoom"; view.bounds = record.info.bounds; }
    else if (name === "open_attribute_table") view.action = "attributes";
    else if (name === "set_layer_labels") { if (args.field && !fields(record).includes(args.field)) throw new Error("找不到标注字段。"); view.action = "labels"; view.style = { labelField: args.field || undefined, labelSize: args.size ?? 13, labelColor: args.color ?? "#172033" }; }
    else { view.action = "style"; view.style = Object.fromEntries([["color", args.color], ["opacity", args.opacity], ["pointSize", args.point_size], ["lineWidth", args.line_width]].filter(([,v]) => v !== undefined)); }
    return { ok: true, view };
  }
  const id = `job_${crypto.randomUUID()}`, controller = new AbortController(); controllers.set(id, controller);
  const geeJob = name.startsWith("gee_");
  const job: Job = { job_id: id, label: geeJob ? "GEE 栅格导出" : name, status: "queued", progress: 0, step: "排队", message: geeJob ? "等待检查 GEE 连接" : "等待浏览器计算", owner }; running.set(id, job);
  await writeRecord(`job:${id}`, job);
  const work = async () => {
    try {
      controller.signal.throwIfAborted();
      job.status = "running"; job.progress = Math.max(job.progress, 0.08); job.step = geeJob ? "GEE" : "WASM"; job.message = geeJob ? "检查 GEE 连接与任务参数" : "GeoLibre WASM 在本机浏览器计算中"; await writeRecord(`job:${id}`, job);
      if (geeJob && geeAuthStatus().demo) {
        const stages = [
          [0.18, "校验演示参数", "演示：读取集合、波段与日期参数"],
          [0.42, "准备演示任务", "演示：模拟导出队列，不访问 Earth Engine"],
          [0.72, "生成演示结果", "演示：写入本地任务记录，不生成 GeoTIFF"],
        ] as const;
        for (const [progress, step, message] of stages) {
          controller.signal.throwIfAborted();
          job.progress = progress; job.step = step; job.message = message; await writeRecord(`job:${id}`, job);
          await new Promise<void>(resolve => setTimeout(resolve, 450));
        }
        controller.signal.throwIfAborted();
        const demoResult = await execute(name, args, controller.signal);
        job.result = {
          ...demoResult,
          demo_steps: stages.map(([progress, step, message]) => ({ progress, step, message, status: "demo_completed" })),
        };
      } else {
        job.result = await execute(name, args, controller.signal);
      }
      if (geeJob && job.result?.ok === false) throw new Error(String(job.result.message || "GEE 任务未执行。"));
      job.status = "completed"; job.progress = 1; job.step = "完成";
      job.message = typeof job.result.message === "string" ? job.result.message : "计算和结果读回校验完成";
    } catch (error) { job.status = controller.signal.aborted ? "cancelled" : "failed"; job.step = controller.signal.aborted ? "已取消" : "失败"; job.error = controller.signal.aborted ? undefined : String(error); job.message = job.error ?? "已取消，未生成结果"; }
    finally { controllers.delete(id); await writeRecord(`job:${id}`, job); recordLog("job", name, job, job.status === "failed" ? "error" : "info"); }
  };
  const lockManager = typeof navigator === "undefined" ? undefined : navigator.locks;
  void (async () => { try { if (lockManager) await lockManager.request(`tiphys-job:${id}`, () => lockManager.request("tiphys-gis-cpu", { signal: controller.signal }, work)); else await work(); } catch { job.status = "cancelled"; job.message = "已取消排队"; controllers.delete(id); await writeRecord(`job:${id}`, job); } })();
  return { job_id: id, status: "queued" };
}
export async function readBrowserJob(id: string): Promise<Job> {
  const job = running.get(id) ?? await readRecord<Job>(`job:${id}`);
  if (!job) throw new Error(`找不到任务：${id}`);
  if (["running", "queued", "cancelling"].includes(job.status) && job.owner !== owner) {
    const locks = typeof navigator === "undefined" ? undefined : await navigator.locks?.query();
    if (!locks?.held?.some(l => l.name === `tiphys-job:${id}`)) { job.status = "interrupted"; job.message = "页面已关闭或刷新，原计算未继续运行。"; await writeRecord(`job:${id}`, job); }
  }
  return job;
}
export async function cancelBrowserJob(id: string) { const job = await readBrowserJob(id); const control = controllers.get(id); if (control) { job.status = "cancelling"; job.message = "正在取消浏览器计算"; control.abort(); } else if (["running", "queued"].includes(job.status)) throw new Error("任务在另一个页面运行，请在那里取消。"); return job; }
function describe(record: LayerRecord) {
  const kind = record.info.kind ?? "vector";
  const path = kind === "raster" ? `此浏览器 / ${record.info.name}.tif（${record.info.raster?.width}×${record.info.raster?.height}，${record.info.raster?.bands} 波段）`
    : kind === "table" ? `此浏览器 / ${record.info.name}.csv` : `此浏览器 / ${record.info.name}.${record.extension}`;
  return { ...publicLayer(record), columns: fields(record), path, sample: record.geojson?.features.slice(0, 5).map(f => f.properties) ?? [] };
}
export async function browserEngineRequest(path: string, init: RequestInit = {}): Promise<Response> {
  init.signal?.throwIfAborted();
  const url = new URL(path, "https://browser.invalid"); const p = url.pathname;
  let result: any;
  if (p === "/ping") result = { ok: true, service: "tiphys-engine", runtime: "browser-wasm" };
  else if (p === "/tools/catalog") {
    const hydrate = url.searchParams.get("hydrate") !== "0";
    if (hydrate) await ensureBrowserCatalog();
    result = { tools: browserCatalog, catalog: { runtime: "browser-wasm", ...browserCatalogState() } };
  }
  else if (p === "/tools/run") { const body = JSON.parse(String(init.body)); result = await runBrowserTool(body.name, body.arguments); }
  else if (p === "/layers/import") { if (!(init.body instanceof Blob)) throw new Error("请通过文件选择器添加数据。"); result = await importBrowserFile(init.body, url.searchParams.get("filename") ?? "data.geojson", url.searchParams.get("source_crs") ?? undefined); }
  else if (p.startsWith("/jobs/")) { const [, , id, action] = p.split("/"); result = action === "cancel" ? await cancelBrowserJob(id) : await readBrowserJob(id); }
  else if (p === "/layers") result = { layers: await browserLayers() };
  else if (p.startsWith("/layers/")) {
    const [, , id, action] = p.split("/"); const record = await resolve(decodeURIComponent(id));
    if (action === "describe") result = describe(record);
    else if (action === "field-values") {
      const field = url.searchParams.get("field") ?? ""; if (!fields(record).includes(field)) throw new Error("找不到字段。");
      const values = new Map<string, { value: unknown; count: number }>();
      for (const f of record.geojson!.features) { const value = f.properties?.[field] ?? null, key = JSON.stringify(value); const item = values.get(key) ?? { value, count: 0 }; item.count++; values.set(key, item); }
      result = { unique_count: values.size, values: [...values.values()].slice(0, Number(url.searchParams.get("limit") ?? 20)) };
    } else if (action === "attributes") {
      if ((record.info.kind ?? "vector") !== "vector") result = { fields: [], rows: [], total: 0, offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 100) };
      else {
      const columns = fields(record), search = (url.searchParams.get("search") ?? "").toLocaleLowerCase(), sort = url.searchParams.get("sort"), descending = url.searchParams.get("descending") === "true";
      let rows = record.geojson!.features.map((f, id) => ({ id, attributes: f.properties ?? {}, bounds: boundsOf({ type: "FeatureCollection", features: [f] }) })).filter(r => !search || JSON.stringify(r.attributes).toLocaleLowerCase().includes(search));
      if (sort) rows.sort((a, b) => { const av = a.attributes[sort], bv = b.attributes[sort]; return (av == null ? bv == null ? 0 : 1 : bv == null ? -1 : typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "zh-CN", { numeric: true })) * (descending ? -1 : 1); });
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
      result = { fields: columns.map(name => ({ name, type: typeof record.geojson!.features.find(f => f.properties?.[name] != null)?.properties?.[name] })), total: rows.length, rows: rows.slice(offset, offset + limit) };
      }
    } else throw new Error("未知图层请求。");
  } else throw new Error(`浏览器暂不支持接口：${p}`);
  return Response.json(result);
}
