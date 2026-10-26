import { toFile, type FC } from "./geojson";
import { bboxArea, getCurrentBounds, getTileExtractor, type Bbox } from "./view";

/** OpenMapTiles source-layers per category (used when Overpass is slow or unreachable). */
const TILE_LAYERS: Record<string, { layers: string[]; keep?: (p: Record<string, any>) => boolean }> = {
  poi: { layers: ["poi"] }, roads: { layers: ["transportation"], keep: p => !/rail|ferry|path|track/.test(String(p.class)) },
  buildings: { layers: ["building"] }, water: { layers: ["water", "waterway"] },
  green: { layers: ["park", "landcover"], keep: p => p.layer === "park" || /wood|grass|forest/.test(String(p.class)) },
  transit: { layers: ["poi"], keep: p => /bus|railway|subway|transit/.test(`${p.class} ${p.subclass}`) }, landuse: { layers: ["landuse"] },
};
function coordsOf(g: any): number[][] {
  if (!g) return [];
  if (g.type === "GeometryCollection") return g.geometries.flatMap(coordsOf);
  const out: number[][] = [];
  const walk = (c: any) => { if (typeof c?.[0] === "number") out.push(c); else if (Array.isArray(c)) c.forEach(walk); };
  walk(g.coordinates); return out;
}
async function fromTiles(category: string, label: string, bbox: Bbox) {
  const extract = getTileExtractor(); const def = TILE_LAYERS[category];
  if (!extract || !def) return null;
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  const view = getCurrentBounds();
  const outside = !view || cx < view[0] || cx > view[2] || cy < view[1] || cy > view[3] || bboxArea(view) > 0.05;
  const r = await extract(def.layers, outside ? { lng: cx, lat: cy, zoom: category === "buildings" ? 15 : 14 } : undefined);
  if (!r) return null;
  const inside = ([x, y]: number[]) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  const features = r.features.filter(f => {
    if (def.keep && !def.keep(f.properties)) return false;
    const cs = coordsOf(f.geometry);
    return cs.length > 0 && cs.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90) && cs.some(inside);
  });
  return { file: toFile({ type: "FeatureCollection", features } as FC, `OSM_${label.replace(/\s.*$/, "")}_底图提取`), count: features.length, label, source: "tiles" as const, zoom: r.zoom };
}
export type OsmCategory = "poi" | "roads" | "buildings" | "water" | "green" | "transit" | "landuse";
export const OSM_CATEGORIES: { id: OsmCategory; label: string; hint: string; query: string; maxArea: number }[] = [
  { id: "poi", label: "兴趣点 POI", hint: "餐饮、商店、学校、医院等", maxArea: 0.5, query: `nwr["amenity"]({{bbox}});nwr["shop"]({{bbox}});nwr["tourism"]({{bbox}});` },
  { id: "roads", label: "道路", hint: "OSM 道路中心线", maxArea: 0.25, query: `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)$"]({{bbox}});` },
  { id: "buildings", label: "建筑轮廓", hint: "适合小范围（约 3km 内）", maxArea: 0.01, query: `way["building"]({{bbox}});` },
  { id: "water", label: "水系", hint: "河流、湖泊、水库", maxArea: 1, query: `way["waterway"~"^(river|stream|canal)$"]({{bbox}});nwr["natural"="water"]({{bbox}});` },
  { id: "green", label: "公园绿地", hint: "公园、林地、草地", maxArea: 0.5, query: `nwr["leisure"~"^(park|garden|nature_reserve)$"]({{bbox}});way["landuse"~"^(forest|grass|meadow)$"]({{bbox}});way["natural"="wood"]({{bbox}});` },
  { id: "transit", label: "公交地铁站", hint: "站点与出入口", maxArea: 0.5, query: `node["public_transport"="stop_position"]({{bbox}});node["railway"~"^(station|subway_entrance)$"]({{bbox}});node["highway"="bus_stop"]({{bbox}});` },
  { id: "landuse", label: "土地利用", hint: "居住、商业、工业、农田等", maxArea: 0.25, query: `way["landuse"]({{bbox}});` },
];
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
const AREA_TAGS = /^(building|landuse|leisure|natural|amenity|shop|tourism|area|place)$/;

/** Overpass "out geom" JSON → GeoJSON. Closed ways with area tags become polygons; relations become multipolygon outers. */
export function overpassToGeojson(json: any): FC {
  const features: FC["features"] = [];
  for (const el of json?.elements ?? []) {
    const props = { osm_id: `${el.type}/${el.id}`, ...(el.tags ?? {}) };
    if (el.type === "node" && typeof el.lat === "number") features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [el.lon, el.lat] } });
    else if (el.type === "way" && Array.isArray(el.geometry)) {
      const coords = el.geometry.map((p: any) => [p.lon, p.lat]);
      const closed = coords.length > 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
      const area = closed && Object.keys(el.tags ?? {}).some(k => AREA_TAGS.test(k)) && !(el.tags?.highway || el.tags?.waterway);
      features.push({ type: "Feature", properties: props, geometry: area ? { type: "Polygon", coordinates: [coords] } : { type: "LineString", coordinates: coords } });
    } else if (el.type === "relation" && Array.isArray(el.members)) {
      const rings = el.members.filter((m: any) => m.role === "outer" && Array.isArray(m.geometry)).map((m: any) => m.geometry.map((p: any) => [p.lon, p.lat]))
        .filter((r: number[][]) => r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]);
      if (rings.length) features.push({ type: "Feature", properties: props, geometry: { type: "MultiPolygon", coordinates: rings.map((r: number[][]) => [r]) } });
      else if (typeof el.center?.lat === "number") features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [el.center.lon, el.center.lat] } });
    } else if (typeof el.center?.lat === "number") features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [el.center.lon, el.center.lat] } });
  }
  return { type: "FeatureCollection", features };
}

/** Shrink a too-large view to the largest allowed square around its centre (for “current view” requests). */
export function fitViewBbox(category: OsmCategory, bbox: Bbox): { bbox: Bbox; shrunk: boolean } {
  const def = OSM_CATEGORIES.find(c => c.id === category);
  if (!def || bboxArea(bbox) <= def.maxArea) return { bbox, shrunk: false };
  const half = Math.sqrt(def.maxArea) * 0.45;
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  return { bbox: [cx - half, cy - half * 0.8, cx + half, cy + half * 0.8], shrunk: true };
}
export async function fetchOsm(category: OsmCategory, bbox: Bbox, signal?: AbortSignal, opts: { allowTiles?: boolean; timeoutMs?: number } = {}): Promise<{ file: File; count: number; label: string; source: "overpass" | "tiles" }> {
  const def = OSM_CATEGORIES.find(c => c.id === category);
  if (!def) throw new Error(`未知 OSM 类别：${category}`);
  if (bboxArea(bbox) > def.maxArea) throw new Error(`当前范围太大（${bboxArea(bbox).toFixed(3)}°²），「${def.label}」最多 ${def.maxArea}°²。请放大地图或改用更小区域。`);
  const [w, s, e, n] = bbox;
  const b = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  const body = `[out:json][timeout:60];(${def.query.split("{{bbox}}").join(b)});out geom 20000;`;
  let lastError: unknown;
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  for (const endpoint of OVERPASS) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), left);
    const relay = () => ctl.abort(); signal?.addEventListener("abort", relay);
    try {
      const response = await fetch(endpoint, { method: "POST", body: new URLSearchParams({ data: body }), signal: ctl.signal });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      const fc = overpassToGeojson(await response.json());
      return { file: toFile(fc, `OSM_${def.label.replace(/\s.*$/, "")}`), count: fc.features.length, label: def.label, source: "overpass" };
    } catch (err) { if (signal?.aborted) throw err; lastError = ctl.signal.aborted ? new Error("Overpass 响应超时") : err; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", relay); }
  }
  if (opts.allowTiles !== false) {
    const tiles = await fromTiles(category, def.label, bbox).catch(() => null);
    if (tiles && tiles.count) return tiles;
  }
  throw new Error(`OpenStreetMap 在线服务暂时不可用（${lastError instanceof Error ? lastError.message : lastError}），当前底图视图内也没有可提取的「${def.label}」。请把地图放大到街区级别（缩放 ≥ 14）再试，或稍后重试。`);
}

const NOMINATIM = "https://nominatim.openstreetmap.org";
/** Admin boundary / place polygon by name (Nominatim, OSM). */
export async function fetchBoundary(query: string, signal?: AbortSignal): Promise<{ file: File; name: string; bbox: Bbox | null }> {
  const q = new URLSearchParams({ q: query, format: "geojson", polygon_geojson: "1", polygon_threshold: "0.0005", limit: "1", "accept-language": "zh-CN,zh,en" });
  const response = await fetch(`${NOMINATIM}/search?${q}`, { signal });
  if (!response.ok) throw new Error(`地名服务 HTTP ${response.status}`);
  const fc = await response.json() as FC & { bbox?: number[] };
  const f = fc.features?.[0];
  if (!f) throw new Error(`没有找到「${query}」。试试更完整的名称，例如“杭州市西湖区”。`);
  const name = String(f.properties?.display_name ?? query).split(",")[0];
  return { file: toFile({ type: "FeatureCollection", features: [f] }, `边界_${name}`), name, bbox: (f.bbox ?? fc.bbox ?? null) as Bbox | null };
}
/** Boundary of the admin area containing a point (zoom 10≈city, 12≈district/county). */
export async function fetchBoundaryAt(lng: number, lat: number, level: "city" | "district" = "district", signal?: AbortSignal) {
  const q = new URLSearchParams({ lat: String(lat), lon: String(lng), zoom: level === "city" ? "10" : "12", format: "geojson", polygon_geojson: "1", polygon_threshold: "0.0005", "accept-language": "zh-CN,zh,en" });
  const response = await fetch(`${NOMINATIM}/reverse?${q}`, { signal });
  if (!response.ok) throw new Error(`地名服务 HTTP ${response.status}`);
  const fc = await response.json() as FC;
  const f = fc.features?.[0];
  if (!f || !f.geometry || f.geometry.type === "Point") throw new Error("该位置没有可用的行政边界。");
  const name = String(f.properties?.name || f.properties?.display_name || "当前区域").split(",")[0];
  return { file: toFile({ type: "FeatureCollection", features: [f] }, `边界_${name}`), name };
}
export async function geocode(query: string, signal?: AbortSignal): Promise<{ lng: number; lat: number; name: string; bbox: Bbox | null } | null> {
  const response = await fetch(`${NOMINATIM}/search?${new URLSearchParams({ q: query, format: "json", limit: "1", "accept-language": "zh-CN,zh,en" })}`, { signal });
  if (!response.ok) return null;
  const [hit] = await response.json();
  if (!hit) return null;
  const bb = hit.boundingbox?.map(Number);
  return { lng: Number(hit.lon), lat: Number(hit.lat), name: hit.display_name.split(",")[0], bbox: bb ? [bb[2], bb[0], bb[3], bb[1]] : null };
}

/** Bundled small datasets (public/samples). All public domain (Natural Earth) or ODbL (OSM). */
export type SampleDataset = { id: string; label: string; file: string; hint: string; license: string };
export const SAMPLE_DATASETS: SampleDataset[] = [
  { id: "beijing_points", label: "北京示例点位", file: "beijing_points.geojson", hint: "8 个点 · 缓冲/统计入门", license: "TIPHYS 示例" },
  { id: "world_countries", label: "世界国家", file: "ne_countries.geojson", hint: "Natural Earth 1:110m 国界面", license: "Natural Earth（公有领域）" },
  { id: "world_cities", label: "世界主要城市", file: "ne_cities.geojson", hint: "Natural Earth 人口城市点", license: "Natural Earth（公有领域）" },
  { id: "world_rivers", label: "世界主要河流", file: "ne_rivers.geojson", hint: "Natural Earth 河流湖泊中心线", license: "Natural Earth（公有领域）" },
  { id: "china_provinces", label: "中国省级区划", file: "ne_china_provinces.geojson", hint: "Natural Earth 1:10m 一级行政区（示意，非标准地图）", license: "Natural Earth（公有领域）" },
];
export const SAMPLE_PROJECT = { name: "示例工程 · 世界与北京", datasets: ["world_countries", "world_rivers", "world_cities", "beijing_points"] };

export async function loadSampleFile(id: string, signal?: AbortSignal): Promise<File> {
  const def = SAMPLE_DATASETS.find(d => d.id === id || d.file === id || `samples/${d.file}` === id);
  if (!def) throw new Error(`没有名为「${id}」的示例数据。可用：${SAMPLE_DATASETS.map(d => d.id).join("、")}`);
  const response = await fetch(`${import.meta.env.BASE_URL}samples/${def.file}`, { signal });
  if (!response.ok) throw new Error(`示例数据下载失败（HTTP ${response.status}）`);
  return new File([await response.blob()], `${def.label}.geojson`, { type: "application/geo+json" });
}

/** Free public tile services the user can switch on with one tap (no key). */
export const ONLINE_TILES: { id: string; label: string; tiles: string[]; attribution: string; hint: string }[] = [
  { id: "esri-topo", label: "Esri 地形街道", hint: "ArcGIS Online World Topo", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"], attribution: "Tiles © Esri" },
  { id: "esri-street", label: "Esri 街道", hint: "ArcGIS Online World Street", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"], attribution: "Tiles © Esri" },
  { id: "osm", label: "OSM 标准", hint: "OpenStreetMap 官方瓦片", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attribution: "© OpenStreetMap contributors" },
  { id: "s2cloudless", label: "Sentinel-2 无云影像 2021", hint: "EOX s2cloudless（非商用免费）", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg"], attribution: "Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)" },
  { id: "gebco", label: "全球海底地形 GEBCO", hint: "WMS · 海陆地形晕渲", tiles: ["https://wms.gebco.net/mapserv?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=GEBCO_LATEST&STYLES=&FORMAT=image/png&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256"], attribution: "GEBCO Compilation Group" },
];
/** Public ArcGIS feature services that work without login (demo for “粘贴 ArcGIS 链接”). */
export const ARCGIS_EXAMPLES: { label: string; url: string; hint: string }[] = [
  { label: "世界国家（Esri Living Atlas）", url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Countries_(Generalized)/FeatureServer/0", hint: "FeatureServer 图层" },
  { label: "美国州界（Esri 示例）", url: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/2", hint: "MapServer 图层" },
];
