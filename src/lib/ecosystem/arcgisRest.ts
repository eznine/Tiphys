import { esriToGeojson, toFile, type FC } from "./geojson";
import type { Bbox, CustomTileSource } from "./view";

export type RestImport = { files: File[]; tiles: CustomTileSource[]; notes: string[] };
const MAX_FEATURES = 20000;

async function getJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
  const json = await response.json();
  if (json?.error) throw new Error(`ArcGIS 服务错误：${json.error.message ?? json.error.code}${json.error.code === 499 || json.error.code === 498 ? "（需要登录令牌；当前仅支持公开服务）" : ""}`);
  return json;
}
export function isArcgisRestUrl(url: string) { return /\/(FeatureServer|MapServer|ImageServer)(\/\d+)?\/?(\?|$)/i.test(url) || /\/rest\/services\//i.test(url); }
export function arcgisItemId(url: string): { portal: string; id: string } | null {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("id") ?? u.searchParams.get("webmap") ?? u.searchParams.get("appid") ?? /\/items\/([0-9a-f]{32})/i.exec(u.pathname)?.[1];
    if (!id || !/^[0-9a-f]{32}$/i.test(id)) return null;
    const host = /arcgis\.com$/i.test(u.hostname) ? "https://www.arcgis.com" : `${u.protocol}//${u.host}/${u.pathname.split("/").filter(Boolean)[0] ?? "portal"}`;
    return { portal: host, id };
  } catch { return null; }
}
function clean(url: string) { return url.split("?")[0].replace(/\/+$/, ""); }

/** Query one Feature/Map service layer to GeoJSON (WGS84), paging until done or MAX_FEATURES. */
export async function queryRestLayer(layerUrl: string, opts: { bbox?: Bbox | null; where?: string; name?: string; signal?: AbortSignal } = {}): Promise<{ file: File; count: number; truncated: boolean; name: string }> {
  const base = clean(layerUrl);
  const meta = await getJson(`${base}?f=json`, opts.signal);
  if (meta.type && !/Feature Layer|Table/i.test(meta.type)) throw new Error(`「${meta.name ?? base}」是 ${meta.type}，不是要素图层。`);
  const name = opts.name ?? meta.name ?? base.split("/").slice(-3).join("_");
  const page = Math.min(Number(meta.maxRecordCount) || 1000, 2000);
  const supportsGeojson = /geojson/i.test(String(meta.supportedQueryFormats ?? ""));
  const all: FC = { type: "FeatureCollection", features: [] };
  let offset = 0, truncated = false;
  const paging = meta.advancedQueryCapabilities?.supportsPagination !== false;
  for (;;) {
    const q = new URLSearchParams({ where: opts.where ?? "1=1", outFields: "*", outSR: "4326", returnGeometry: "true", f: supportsGeojson ? "geojson" : "json" });
    if (paging) { q.set("resultOffset", String(offset)); q.set("resultRecordCount", String(page)); }
    if (opts.bbox) { q.set("geometry", opts.bbox.join(",")); q.set("geometryType", "esriGeometryEnvelope"); q.set("inSR", "4326"); q.set("spatialRel", "esriSpatialRelIntersects"); }
    const json = await getJson(`${base}/query?${q}`, opts.signal);
    const fc: FC = supportsGeojson && json.type === "FeatureCollection" ? json : esriToGeojson(json);
    all.features.push(...fc.features);
    const more = json.exceededTransferLimit || json.properties?.exceededTransferLimit;
    if (!more || !paging || !fc.features.length) { truncated = !!more && !paging; break; }
    if (all.features.length >= MAX_FEATURES) { truncated = true; break; }
    offset += fc.features.length;
  }
  if (all.features.length > MAX_FEATURES) { all.features.length = MAX_FEATURES; truncated = true; }
  return { file: toFile(all, name), count: all.features.length, truncated, name };
}

/** Import any ArcGIS REST URL: layer, Feature/MapServer root, tiled/dynamic MapServer, ImageServer. */
export async function importArcgisRest(url: string, opts: { bbox?: Bbox | null; signal?: AbortSignal; maxLayers?: number } = {}): Promise<RestImport> {
  const out: RestImport = { files: [], tiles: [], notes: [] };
  const base = clean(url);
  if (/\/(FeatureServer|MapServer)\/\d+$/i.test(base)) {
    const r = await queryRestLayer(base, opts);
    if (!r.count) { out.notes.push(`「${r.name}」${opts.bbox ? "在当前范围内" : ""}没有要素`); return out; }
    out.files.push(r.file); out.notes.push(`「${r.name}」${r.count} 个要素${r.truncated ? `（已截断到前 ${r.count} 个，可在当前视图内重新导入）` : ""}`);
    return out;
  }
  const meta = await getJson(`${base}?f=json`, opts.signal);
  const title = meta.documentInfo?.Title || meta.mapName || meta.name || base.split("/").slice(-2, -1)[0];
  if (/ImageServer$/i.test(base)) {
    out.tiles.push({ label: title, attribution: meta.copyrightText || "ArcGIS ImageServer", tiles: [`${base}/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png&f=image`] });
    out.notes.push(`影像服务「${title}」已作为在线底图叠加`);
    return out;
  }
  if (/MapServer$/i.test(base) && (meta.singleFusedMapCache || meta.tileInfo)) {
    out.tiles.push({ label: title, attribution: meta.copyrightText || "ArcGIS MapServer", tiles: [`${base}/tile/{z}/{y}/{x}`] });
    out.notes.push(`切片服务「${title}」已作为底图`);
    if (meta.spatialReference?.latestWkid !== 3857 && meta.spatialReference?.wkid !== 102100) out.notes.push("注意：该切片服务不是 Web 墨卡托，显示可能错位");
    return out;
  }
  const layers = ((meta.layers ?? []) as any[]).filter(l => !l.subLayerIds?.length && (!l.type || /Feature Layer/i.test(l.type)));
  if (/MapServer$/i.test(base) && !layers.length) {
    out.tiles.push({ label: title, attribution: meta.copyrightText || "ArcGIS MapServer", tiles: [`${base}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`] });
    out.notes.push(`动态地图服务「${title}」已作为在线底图`);
    return out;
  }
  const max = opts.maxLayers ?? 8;
  for (const layer of layers.slice(0, max)) {
    try {
      const r = await queryRestLayer(`${base}/${layer.id}`, { ...opts, name: layer.name });
      if (!r.count) { out.notes.push(`「${r.name}」没有要素`); continue; }
      out.files.push(r.file); out.notes.push(`「${r.name}」${r.count} 个要素${r.truncated ? "（已截断）" : ""}`);
    } catch (err) { out.notes.push(`「${layer.name}」跳过：${err instanceof Error ? err.message : err}`); }
  }
  if (layers.length > max) out.notes.push(`服务共有 ${layers.length} 个图层，已导入前 ${max} 个；可粘贴 …/${layers[max].id} 单独导入`);
  if (!layers.length) out.notes.push("该服务没有可查询的要素图层");
  return out;
}

/** ArcGIS Online / Portal item: Feature Service, Map Service, Web Map (operational layers + embedded feature collections). */
export async function importArcgisItem(portal: string, id: string, opts: { bbox?: Bbox | null; signal?: AbortSignal } = {}): Promise<RestImport> {
  const item = await getJson(`${portal}/sharing/rest/content/items/${id}?f=json`, opts.signal);
  const out: RestImport = { files: [], tiles: [], notes: [`ArcGIS 条目「${item.title}」（${item.type}）`] };
  const merge = (r: RestImport) => { out.files.push(...r.files); out.tiles.push(...r.tiles); out.notes.push(...r.notes); };
  if (item.url && /Service/i.test(item.type)) { merge(await importArcgisRest(item.url, opts)); return out; }
  if (/Web Map|Feature Collection/i.test(item.type)) {
    const data = await getJson(`${portal}/sharing/rest/content/items/${id}/data?f=json`, opts.signal);
    const ops: any[] = data.operationalLayers ?? (data.layers ? [{ title: item.title, featureCollection: data }] : []);
    for (const op of ops) {
      try {
        if (op.featureCollection?.layers) {
          for (const l of op.featureCollection.layers) {
            const fc = esriToGeojson(l.featureSet ?? {});
            const wkid = l.featureSet?.geometryType && (l.layerDefinition?.spatialReference?.wkid ?? l.featureSet?.spatialReference?.wkid);
            if (wkid === 102100 || wkid === 3857) for (const f of fc.features) reprojectMercator(f.geometry);
            out.files.push(toFile(fc, l.layerDefinition?.name || op.title || "图层")); out.notes.push(`「${op.title}」内嵌 ${fc.features.length} 个要素`);
          }
        } else if (op.url) merge(await importArcgisRest(op.url, { ...opts, maxLayers: 4 }));
        else if (op.itemId) merge(await importArcgisItem(portal, op.itemId, opts));
      } catch (err) { out.notes.push(`「${op.title ?? op.id}」跳过：${err instanceof Error ? err.message : err}`); }
    }
    if (!ops.length) out.notes.push("Web 地图里没有业务图层");
    return out;
  }
  out.notes.push(`暂不支持该条目类型：${item.type}`);
  return out;
}
function mercToLngLat([x, y]: number[]) { return [x / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI]; }
function reprojectMercator(g: any) {
  if (!g) return;
  const walk = (c: any): any => typeof c[0] === "number" ? mercToLngLat(c) : c.map(walk);
  g.coordinates = walk(g.coordinates);
}
