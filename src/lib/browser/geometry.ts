import proj4 from "proj4";
import type { FeatureCollection, Geometry } from "geojson";

export function boundsOf(collection: FeatureCollection): number[] | null {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const coordinates = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) throw new Error("数据包含无效坐标。");
      bounds[0] = Math.min(bounds[0], value[0]); bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]); bounds[3] = Math.max(bounds[3], value[1]);
    } else value.forEach(coordinates);
  };
  const geometry = (g: Geometry | null) => { if (!g) return; if (g.type === "GeometryCollection") g.geometries.forEach(geometry); else coordinates(g.coordinates); };
  collection.features.forEach(f => geometry(f.geometry));
  return bounds.every(Number.isFinite) ? bounds : null;
}

/** Check local UTM scale numerically against the WGS84 ellipsoid, including corners. */
export function metricCrs(collection: FeatureCollection, paddingMeters = 0): number {
  const b = boundsOf(collection);
  if (!b) throw new Error("输入图层没有可分析的几何。");
  const lng = (b[0] + b[2]) / 2, lat = (b[1] + b[3]) / 2;
  if (b[2] - b[0] > 6 || b[3] - b[1] > 8 || b[1] < -80 || b[3] > 84) throw new Error("该范围不适合单一局部 UTM 分析，请先划分区域。");
  const zone = Math.max(1, Math.min(60, Math.floor((lng + 180) / 6) + 1));
  const epsg = (lat >= 0 ? 32600 : 32700) + zone;
  const definition = `+proj=utm +zone=${zone} ${lat < 0 ? "+south" : ""} +datum=WGS84 +units=m +no_defs`;
  proj4.defs(`EPSG:${epsg}`, definition);
  const dlat = paddingMeters / 110000;
  const dlng = dlat / Math.max(.01, Math.cos(lat * Math.PI / 180));
  for (const x of [b[0] - dlng, lng, b[2] + dlng]) for (const y of [b[1] - dlat, lat, b[3] + dlat]) {
    if (y < -80 || y > 84 || x < -180 || x > 180) throw new Error("分析结果可能超出局部投影有效范围。");
    const delta = 1e-5, radians = y * Math.PI / 180, e2 = .0066943799901413165;
    const q = 1 - e2 * Math.sin(radians) ** 2;
    const north = 6378137 * (1 - e2) / q ** 1.5 * delta * Math.PI / 180;
    const east = 6378137 / Math.sqrt(q) * Math.cos(radians) * delta * Math.PI / 180;
    const p = proj4("EPSG:4326", definition, [x, y]);
    const n = proj4("EPSG:4326", definition, [x, y + delta]);
    const e = proj4("EPSG:4326", definition, [x + delta, y]);
    if ([Math.hypot(n[0] - p[0], n[1] - p[1]) / north, Math.hypot(e[0] - p[0], e[1] - p[1]) / east].some(k => !Number.isFinite(k) || Math.abs(k - 1) > .005)) throw new Error("局部投影尺度误差超过 0.5%，请缩小分析范围。");
  }
  return epsg;
}

export function assertGeojson(value: unknown): asserts value is FeatureCollection {
  const c = value as FeatureCollection;
  if (!c || c.type !== "FeatureCollection" || !Array.isArray(c.features) || c.features.some(f => f.type !== "Feature")) throw new Error("结果不是有效的 GeoJSON 要素集合。");
  const b = boundsOf(c);
  if (b && (b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90)) throw new Error("显示数据不是有效的 WGS84 经纬度，请核对源坐标系。");
}
