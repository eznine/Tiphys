import { unzipSync } from "fflate";

/** One layer recovered from an ArcGIS Pro document (.aprx / .mapx / .lyrx) or ArcMap .mxd string scan. */
export type RecoveredLayer = {
  name: string;
  kind: "feature" | "raster" | "service" | "basemap" | "other";
  cimType: string;
  /** Feature class / table / raster name inside the workspace. */
  dataset?: string;
  /** Workspace path (e.g. ..\data\city.gdb) or service URL. */
  workspace?: string;
  workspaceFactory?: string;
  url?: string;
  color?: string;
  visible?: boolean;
  map?: string;
};
export type RecoveredProject = { format: "aprx" | "mapx" | "lyrx" | "mxd"; maps: string[]; layers: RecoveredLayer[]; warnings: string[] };

const LAYER_TYPE = /^CIM(Feature|Raster|Tiled|VectorTile|Service|Image|Mosaic|WMS|WMTS|Annotation|Dimension|Elevation|Scene|PointCloud|KML|Graphics|Standalone|Subtype|Group)?\w*Layer$|^CIMStandaloneTable$/;

function hex(values?: number[]) {
  if (!Array.isArray(values) || values.length < 3) return undefined;
  return "#" + values.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function colorOf(color: any): string | undefined {
  if (!color?.values) return undefined;
  if (/RGB/i.test(color.type ?? "CIMRGBColor")) return hex(color.values);
  if (/HSV/i.test(color.type)) { const [h, s, v] = color.values; const c = v / 100 * s / 100, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v / 100 - c; const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return hex([(r + m) * 255, (g + m) * 255, (b + m) * 255]); }
  if (/CMYK/i.test(color.type)) { const [c, m, y, k] = color.values.map((v: number) => v / 100); return hex([255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)]); }
  return undefined;
}
/** First fill colour (else stroke/marker) of a renderer's default symbol. */
export function rendererColor(renderer: any): string | undefined {
  const symbol = renderer?.symbol?.symbol ?? renderer?.defaultSymbol?.symbol ?? renderer?.groups?.[0]?.classes?.[0]?.symbol?.symbol ?? renderer?.breaks?.[0]?.symbol?.symbol;
  const layers: any[] = symbol?.symbolLayers ?? [];
  const pick = (re: RegExp) => layers.filter(l => re.test(l.type ?? "")).map(l => colorOf(l.color) ?? (Array.isArray(l.markerGraphics) ? colorOf(l.markerGraphics[0]?.symbol?.symbolLayers?.find((s: any) => s.color)?.color) : undefined)).find(Boolean);
  return pick(/Fill/) ?? pick(/Marker/) ?? pick(/Stroke/);
}
function parseConnection(text: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of String(text ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim(); }
  return out;
}
function findUrl(obj: any): string | undefined {
  let found: string | undefined;
  const walk = (v: any, depth: number) => {
    if (found || depth > 6 || !v || typeof v !== "object") return;
    for (const [k, value] of Object.entries(v)) {
      if (typeof value === "string" && /^(url|serverConnection|workspaceConnectionString|uRI)$/i.test(k) && /https?:\/\//i.test(value)) { found = /https?:\/\/[^;"\s]+/i.exec(value)![0]; return; }
      walk(value, depth + 1);
    }
  };
  walk(obj, 0); return found;
}
export function layerFromCim(def: any, map?: string): RecoveredLayer | null {
  const cimType = String(def?.type ?? "");
  if (!LAYER_TYPE.test(cimType) || /Group/.test(cimType)) return null;
  const conn = def.featureTable?.dataConnection ?? def.dataConnection ?? def.standaloneTable?.dataConnection;
  const kv = parseConnection(conn?.workspaceConnectionString);
  const factory = conn?.workspaceFactory as string | undefined;
  const url = /FeatureService|SDE_FeatureService|WMS|WMTS|Ags|ArcGIS/i.test(factory ?? "") ? (kv.URL ?? findUrl(def)) : findUrl(def.serviceConnection ?? def.connection ?? (conn?.workspaceConnectionString ? undefined : def));
  let kind: RecoveredLayer["kind"] = /Raster|Image|Mosaic|Elevation/.test(cimType) ? "raster" : /Feature|Standalone/.test(cimType) ? "feature" : /Tiled|VectorTile|WMS|WMTS|Service/.test(cimType) ? "service" : "other";
  if (url && kind === "feature" && /FeatureServer|MapServer/i.test(url)) kind = "service";
  const serviceUrl = url && conn?.dataset && /FeatureServer$|MapServer$/i.test(url.replace(/\/+$/, "")) ? `${url.replace(/\/+$/, "")}/${conn.dataset}` : url;
  return {
    name: String(def.name ?? conn?.dataset ?? "未命名图层"), kind, cimType,
    dataset: conn?.dataset, workspace: kv.DATABASE ?? kv.SERVER ?? (url ? undefined : conn?.workspaceConnectionString), workspaceFactory: factory,
    url: serviceUrl, color: rendererColor(def.renderer), visible: def.visibility !== false, map,
  };
}
function collect(json: any, into: RecoveredLayer[], maps: string[], mapName?: string) {
  const walk = (v: any, map?: string, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 40) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, map, depth + 1); return; }
    if (v.type === "CIMMap" && v.name) { maps.push(String(v.name)); map = String(v.name); }
    const layer = layerFromCim(v, map ?? mapName);
    if (layer) { into.push(layer); return; }
    for (const value of Object.values(v)) if (value && typeof value === "object") walk(value, map, depth + 1);
  };
  walk(json);
}
function dedupe(layers: RecoveredLayer[]) {
  const seen = new Set<string>();
  return layers.filter(l => { const k = `${l.map}|${l.name}|${l.dataset}|${l.url}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
export function parseCimJson(text: string, format: RecoveredProject["format"]): RecoveredProject {
  const layers: RecoveredLayer[] = [], maps: string[] = [];
  collect(JSON.parse(text.replace(/^\uFEFF/, "")), layers, maps);
  return { format, maps: [...new Set(maps)], layers: dedupe(layers), warnings: [] };
}
/** ArcGIS Pro .aprx is a ZIP of CIM JSON documents (Pro 2.x+/3.x). Older XML/binary members are scanned for data paths. */
export function parseAprx(bytes: Uint8Array): RecoveredProject {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw new Error("无法解压 APRX：文件可能损坏，或来自 ArcGIS Pro 1.x（不支持）。"); }
  const layers: RecoveredLayer[] = [], maps: string[] = [], warnings: string[] = [];
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(entries)) {
    if (!data.length) continue;
    const head = decoder.decode(data.subarray(0, 64)).trim().replace(/^\uFEFF/, "");
    if (head.startsWith("{") || head.startsWith("[")) {
      try { collect(JSON.parse(decoder.decode(data).replace(/^\uFEFF/, "")), layers, maps, name.split("/")[0]); } catch { warnings.push(`跳过无法解析的成员 ${name}`); }
    } else if (head.startsWith("<")) {
      const xml = decoder.decode(data);
      for (const m of xml.matchAll(/<WorkspaceConnectionString>([^<]+)<\/WorkspaceConnectionString>[\s\S]{0,400}?<Dataset>([^<]+)<\/Dataset>/g))
        layers.push({ name: m[2], kind: "feature", cimType: "XML", dataset: m[2], workspace: parseConnection(m[1]).DATABASE ?? m[1] });
    }
  }
  if (!layers.length) warnings.push("APRX 中没有找到图层定义（可能为空工程或加密/旧版格式）。");
  return { format: "aprx", maps: [...new Set(maps)], layers: dedupe(layers), warnings };
}
/** ArcMap .mxd is a binary OLE document; we can only recover the data paths it references (UTF-16 strings). */
export function scanMxd(bytes: Uint8Array): RecoveredProject {
  const text = new TextDecoder("utf-16le").decode(bytes.byteLength % 2 ? bytes.subarray(0, bytes.byteLength - 1) : bytes);
  const paths = new Set<string>();
  for (const m of text.matchAll(/(?:[A-Za-z]:\\|\\\\|\.\.?\\)[^\u0000-\u001f"<>|*?]{2,200}?\.(gdb|shp|mdb|sde|tif|tiff|img|lyr)\b/gi)) paths.add(m[0]);
  for (const m of text.matchAll(/https?:\/\/[^\u0000-\u0020"<>]+?\/(FeatureServer|MapServer)(\/\d+)?/gi)) paths.add(m[0]);
  const layers: RecoveredLayer[] = [...paths].map(p => /^https?:/i.test(p)
    ? { name: p.split("/").slice(-3).join("/"), kind: "service" as const, cimType: "MXD", url: p }
    : { name: p.split(/[\\/]/).pop()!, kind: /\.(tif|tiff|img)$/i.test(p) ? "raster" as const : "feature" as const, cimType: "MXD", workspace: p, dataset: p.split(/[\\/]/).pop()!.replace(/\.(shp|tif|tiff|img)$/i, "") });
  return { format: "mxd", maps: [], layers, warnings: ["MXD 是 ArcMap 二进制格式：只能恢复其引用的数据路径与服务地址，图层符号无法读取。建议在 ArcGIS Pro 中“导入地图”后另存为 .aprx/.mapx，或打包为 .mpkx。"] };
}
export function summarizeProject(p: RecoveredProject) {
  const by = (k: RecoveredLayer["kind"]) => p.layers.filter(l => l.kind === k).length;
  return `${p.format.toUpperCase()}：${p.maps.length ? `${p.maps.length} 个地图、` : ""}${p.layers.length} 个图层（要素 ${by("feature")} · 服务 ${by("service")} · 栅格 ${by("raster")}）`;
}
