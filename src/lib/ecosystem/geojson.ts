import type { FeatureCollection, Feature, Geometry } from "geojson";
export type FC = FeatureCollection<Geometry | null, Record<string, any>>;
export function toFile(fc: FC, name: string): File {
  const safe = name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "data";
  return new File([JSON.stringify(fc)], `${safe}.geojson`, { type: "application/geo+json" });
}
export function emptyFc(): FC { return { type: "FeatureCollection", features: [] }; }

/** Minimal Esri JSON → GeoJSON (points, multipoints, polylines, polygons with ring orientation). */
export function esriToGeojson(json: any): FC {
  const features: Feature<Geometry | null, Record<string, any>>[] = [];
  for (const f of json?.features ?? []) features.push({ type: "Feature", properties: { ...(f.attributes ?? {}) }, geometry: esriGeometry(f.geometry) });
  return { type: "FeatureCollection", features };
}
function ringArea(r: number[][]) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[i][0] - r[j][0]) * (r[i][1] + r[j][1]); return a; }
export function esriGeometry(g: any): Geometry | null {
  if (!g) return null;
  if (typeof g.x === "number") return { type: "Point", coordinates: [g.x, g.y] };
  if (Array.isArray(g.points)) return { type: "MultiPoint", coordinates: g.points.map((p: number[]) => p.slice(0, 2)) };
  if (Array.isArray(g.paths)) return g.paths.length === 1 ? { type: "LineString", coordinates: g.paths[0].map((p: number[]) => p.slice(0, 2)) } : { type: "MultiLineString", coordinates: g.paths.map((r: number[][]) => r.map(p => p.slice(0, 2))) };
  if (Array.isArray(g.rings)) {
    // Esri outer rings are clockwise (positive shoelace here), holes counter-clockwise.
    const polys: number[][][][] = [];
    for (const ring of g.rings as number[][][]) {
      const r = ring.map(p => p.slice(0, 2));
      if (ringArea(r) >= 0 || !polys.length) polys.push([r]); else polys[polys.length - 1].push(r);
    }
    return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
  }
  return null;
}
