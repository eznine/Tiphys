import { unzipSync, zipSync } from "fflate";
import { arcgisItemId, importArcgisRest, importArcgisItem, isArcgisRestUrl } from "./arcgisRest";
import { parseAprx, parseCimJson, scanMxd, summarizeProject, type RecoveredProject } from "./arcgisProject";
import { extract7z, gdalToGeojson } from "./gdal";
import { type Bbox, type CustomTileSource } from "./view";

export * from "./view";
export type { OsmCategory } from "./openData";
export { fitViewBbox, fetchOsm, fetchBoundary, fetchBoundaryAt, geocode, loadSampleFile, OSM_CATEGORIES, SAMPLE_DATASETS, SAMPLE_PROJECT, ONLINE_TILES, ARCGIS_EXAMPLES } from "./openData";

/** Result of turning user input (files / URL) into plain files the existing importer understands. */
export type Expanded = {
  files: File[];
  /** Colour to apply after import, keyed by file name. */
  styles: Record<string, string>;
  tiles: CustomTileSource[];
  notes: string[];
  project?: RecoveredProject;
};
const PROJECT_EXT = /\.(aprx|mapx|lyrx|mxd)$/i;
const PACKAGE_EXT = /\.(mpkx|ppkx|lpkx|mpk|lpk|mmpk|7z)$/i;
const GDAL_EXT = /\.(dxf|dgn|mif|mid|tab|map|id|dat|sqlite|ods|xlsx|vrt|gmt|osm|pbf)$/i;
export const ECOSYSTEM_ACCEPT = ".aprx,.mapx,.lyrx,.mxd,.mpkx,.ppkx,.lpkx,.mpk,.lpk,.mmpk,.7z,.dxf,.mif,.mid,.tab,.map,.id,.dat,.sqlite";

export function needsEcosystem(files: File[]) {
  return files.some(f => PROJECT_EXT.test(f.name) || PACKAGE_EXT.test(f.name) || GDAL_EXT.test(f.name) || /\.gdb\.zip$/i.test(f.name) || /\.zip$/i.test(f.name));
}
const notName = (n: string) => n.split("/").some(p => p === "__MACOSX" || p.startsWith("."));

/** Group extracted archive members by the .gdb directory they live in, re-zipped for GDAL /vsizip/. */
function gdbBundles(entries: Record<string, Uint8Array>) {
  const groups = new Map<string, Record<string, Uint8Array>>();
  for (const [path, data] of Object.entries(entries)) {
    if (notName(path)) continue;
    const m = /^(.*?[^/]+\.gdb)\/(.+)$/i.exec(path);
    if (!m) continue;
    const g = groups.get(m[1]) ?? {}; g[`${m[1].split("/").pop()}/${m[2]}`] = data; groups.set(m[1], g);
  }
  return [...groups].map(([dir, files]) => new File([zipSync(files, { level: 0 }) as BlobPart], `${dir.split("/").pop()}.zip`, { type: "application/zip" }));
}

async function expandArchive(entries: Record<string, Uint8Array>, label: string, out: Expanded) {
  const gdbs = gdbBundles(entries);
  for (const gdb of gdbs) await convertGdal(gdb, true, out);
  const loose = Object.entries(entries).filter(([p]) => !notName(p) && !/\.gdb\//i.test(p));
  const docs = loose.filter(([p]) => PROJECT_EXT.test(p));
  for (const [p, data] of docs) { try { const proj = parseDoc(p, data); mergeProject(proj, out); } catch (err) { out.notes.push(`${p} 解析失败：${(err as Error).message}`); } }
  for (const [p, data] of loose) {
    if (/\.(shp|shx|dbf|prj|cpg|tif|tiff|geojson|gpkg|kml|kmz|gpx|fgb)$/i.test(p) && !/(^|\/)esriinfo\//i.test(p))
      out.files.push(new File([data as BlobPart], p.split("/").pop()!));
  }
  if (!gdbs.length && !out.files.length) out.notes.push(`${label} 中没有找到可读的数据（.gdb / .shp / .tif / .gpkg）。`);
}
async function convertGdal(file: File, vsizip: boolean, out: Expanded) {
  out.notes.push(`正在用 GDAL 读取 ${file.name}（首次需下载约 40 MB 组件）…`);
  const result = await gdalToGeojson(file, { vsizip });
  out.notes.pop();
  for (const layer of result.layers) out.files.push(layer.file);
  out.notes.push(`${file.name}（${result.driver || "GDAL"}）：${result.layers.length} 个图层 · ${result.layers.reduce((s, l) => s + l.count, 0)} 个要素`, ...result.notes);
}
function parseDoc(name: string, data: Uint8Array): RecoveredProject {
  const ext = name.split(".").pop()!.toLowerCase();
  if (ext === "aprx") return parseAprx(data);
  if (ext === "mxd") return scanMxd(data);
  return parseCimJson(new TextDecoder().decode(data), ext as "mapx" | "lyrx");
}
function mergeProject(project: RecoveredProject, out: Expanded) {
  if (!out.project) out.project = project;
  else { out.project.layers.push(...project.layers); out.project.maps.push(...project.maps); }
  out.notes.push(summarizeProject(project), ...project.warnings);
}
/** After all data are in, give recovered symbology to matching layers and fetch referenced services. */
async function resolveProject(out: Expanded, bbox: Bbox | null, signal?: AbortSignal) {
  const project = out.project; if (!project) return;
  const stem = (n: string) => n.replace(/\.[^.]+$/, "").toLowerCase();
  const byStem = new Map(out.files.map(f => [stem(f.name), f.name]));
  const missing: string[] = [];
  for (const layer of project.layers) {
    if (layer.kind === "service" && layer.url) {
      try {
        const r = await importArcgisRest(layer.url, { bbox, signal, maxLayers: 4 });
        out.files.push(...r.files); out.tiles.push(...r.tiles); out.notes.push(...r.notes.map(n => `服务 ${layer.name}：${n}`));
        if (layer.color) for (const f of r.files) out.styles[f.name] = layer.color;
      } catch (err) { out.notes.push(`服务「${layer.name}」无法访问：${(err as Error).message}`); }
      continue;
    }
    const match = byStem.get((layer.dataset ?? layer.name).toLowerCase()) ?? byStem.get(layer.name.toLowerCase());
    if (match) { if (layer.color) out.styles[match] = layer.color; }
    else if (layer.kind === "feature" || layer.kind === "raster") missing.push(`${layer.name}${layer.workspace ? `（${layer.workspace}${layer.dataset ? ` › ${layer.dataset}` : ""}）` : ""}`);
  }
  if (missing.length) out.notes.push(`工程引用的本地数据未随文件提供（${missing.length} 个）：${missing.slice(0, 6).join("；")}${missing.length > 6 ? " …" : ""}。把对应 .gdb 压缩为 zip 一起导入，或在 ArcGIS Pro 中“共享 → 打包工程/地图（.ppkx/.mpkx）”后导入，即可自动配对。`);
}

/** Turn ArcGIS documents, packages, zipped .gdb and other GDAL formats into importable files. Other files pass through. */
export async function expandImports(input: File[], opts: { signal?: AbortSignal } = {}): Promise<Expanded> {
  const out: Expanded = { files: [], styles: {}, tiles: [], notes: [] };
  for (const file of input) {
    const name = file.name;
    try {
      if (PROJECT_EXT.test(name)) { mergeProject(parseDoc(name, new Uint8Array(await file.arrayBuffer())), out); continue; }
      if (PACKAGE_EXT.test(name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        let entries: Record<string, Uint8Array>;
        if (isZip) entries = unzipSync(bytes);
        else { out.notes.push(`正在解压 ${name}…`); entries = await extract7z(bytes); out.notes.pop(); }
        await expandArchive(entries, name, out); continue;
      }
      if (/\.zip$/i.test(name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let entries: Record<string, Uint8Array> | null = null;
        try { entries = unzipSync(bytes, { filter: f => !notName(f.name) }); } catch { /* not a zip we understand */ }
        const keys = entries ? Object.keys(entries) : [];
        if (entries && keys.some(k => /\.gdb\//i.test(k))) { await expandArchive(entries, name, out); continue; }
        if (entries && keys.some(k => PROJECT_EXT.test(k)) ) { await expandArchive(entries, name, out); continue; }
        out.files.push(file); continue;   // Shapefile ZIP etc. → existing importer
      }
      if (GDAL_EXT.test(name)) { await convertGdal(file, false, out); continue; }
      out.files.push(file);
    } catch (err) { out.notes.push(`${name}：${err instanceof Error ? err.message : err}`); }
  }
  await resolveProject(out, null, opts.signal);
  return out;
}

export type UrlKind = "arcgis-rest" | "arcgis-item" | "xyz" | "wms" | "wmts" | "file";
export function classifyUrl(raw: string): UrlKind {
  const url = raw.trim();
  if (/\{z\}|\{x\}|\{-?y\}/i.test(url)) return "xyz";
  if (arcgisItemId(url) && /arcgis|portal|sharing|item|webmap/i.test(url)) return "arcgis-item";
  if (isArcgisRestUrl(url)) return "arcgis-rest";
  if (/service=wmts|\/wmts\b|WMTSCapabilities/i.test(url)) return "wmts";
  if (/service=wms|\/wms\b|\/ows\b/i.test(url)) return "wms";
  return "file";
}
async function wmsTiles(raw: string, signal?: AbortSignal): Promise<CustomTileSource> {
  const u = new URL(raw);
  const base = `${u.origin}${u.pathname}`;
  let layers = u.searchParams.get("layers") ?? u.searchParams.get("LAYERS");
  let title = layers ?? "WMS";
  if (!layers) {
    const cap = await (await fetch(`${base}?SERVICE=WMS&REQUEST=GetCapabilities`, { signal })).text();
    const doc = new DOMParser().parseFromString(cap, "text/xml");
    const named = [...doc.getElementsByTagName("Layer")].map(l => ({ name: l.getElementsByTagName("Name")[0]?.textContent, title: l.getElementsByTagName("Title")[0]?.textContent })).filter(l => l.name);
    if (!named.length) throw new Error("WMS 能力文档里没有可用图层。");
    layers = named[named.length > 1 ? 1 : 0].name!; title = named[0].title ?? layers;
  }
  return { label: title, attribution: u.hostname, tiles: [`${base}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${encodeURIComponent(layers)}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256`] };
}
async function wmtsTiles(raw: string, signal?: AbortSignal): Promise<CustomTileSource> {
  const u = new URL(raw);
  const capUrl = /GetCapabilities|\.xml$/i.test(raw) ? raw : `${u.origin}${u.pathname}?SERVICE=WMTS&REQUEST=GetCapabilities`;
  const doc = new DOMParser().parseFromString(await (await fetch(capUrl, { signal })).text(), "text/xml");
  const layer = doc.getElementsByTagName("Layer")[0];
  if (!layer) throw new Error("WMTS 能力文档里没有图层。");
  const tmpl = [...layer.getElementsByTagName("ResourceURL")].find(r => r.getAttribute("resourceType") === "tile")?.getAttribute("template");
  const sets = [...layer.getElementsByTagName("TileMatrixSet")].map(e => e.textContent ?? "");
  const set = sets.find(s => /google|3857|webmercator|w$/i.test(s)) ?? sets[0];
  const id = layer.getElementsByTagName("ows:Identifier")[0]?.textContent ?? layer.getElementsByTagName("Identifier")[0]?.textContent ?? "";
  const style = layer.getElementsByTagName("Style")[0]?.getElementsByTagName("ows:Identifier")[0]?.textContent ?? "default";
  const title = layer.getElementsByTagName("ows:Title")[0]?.textContent ?? id;
  const tile = tmpl ? tmpl.replace("{Style}", style).replace("{TileMatrixSet}", set).replace("{TileMatrix}", "{z}").replace("{TileRow}", "{y}").replace("{TileCol}", "{x}")
    : `${u.origin}${u.pathname}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${id}&STYLE=${style}&TILEMATRIXSET=${set}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png`;
  return { label: title, attribution: u.hostname, tiles: [tile] };
}

/** Paste-a-link import: ArcGIS REST / Online item / WMS / WMTS / XYZ / any data file URL (GeoJSON, KML, zip…). */
export async function expandUrl(raw: string, opts: { bbox?: Bbox | null; signal?: AbortSignal } = {}): Promise<Expanded> {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("请输入以 http(s):// 开头的链接。");
  const out: Expanded = { files: [], styles: {}, tiles: [], notes: [] };
  const kind = classifyUrl(url);
  const bbox = opts.bbox === undefined ? null : opts.bbox;
  if (kind === "xyz") { out.tiles.push({ label: new URL(url.replace(/[{}]/g, "")).hostname, attribution: new URL(url.replace(/[{}]/g, "")).hostname, tiles: [url] }); out.notes.push("XYZ 瓦片已作为底图"); return out; }
  if (kind === "wms") { out.tiles.push(await wmsTiles(url, opts.signal)); out.notes.push(`WMS「${out.tiles[0].label}」已作为底图`); return out; }
  if (kind === "wmts") { out.tiles.push(await wmtsTiles(url, opts.signal)); out.notes.push(`WMTS「${out.tiles[0].label}」已作为底图`); return out; }
  if (kind === "arcgis-item") { const it = arcgisItemId(url)!; const r = await importArcgisItem(it.portal, it.id, { bbox, signal: opts.signal }); return { ...out, ...r, styles: {} }; }
  if (kind === "arcgis-rest") { const r = await importArcgisRest(url, { bbox, signal: opts.signal }); return { ...out, ...r, styles: {} }; }
  let response: Response;
  try { response = await fetch(url, { signal: opts.signal }); }
  catch { throw new Error("无法下载该链接：对方服务器可能不允许跨域访问（CORS）。手机 App 内不受此限制；网页版可先下载到本机再导入。"); }
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  let name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "data");
  if (!/\.[a-z0-9]{2,8}$/i.test(name)) name += /json/.test(type) ? ".geojson" : /kml/.test(type) ? ".kml" : /zip/.test(type) ? ".zip" : /csv/.test(type) ? ".csv" : /tiff/.test(type) ? ".tif" : ".geojson";
  const file = new File([await response.blob()], name, { type });
  const expanded = await expandImports([file], opts);
  return expanded;
}
