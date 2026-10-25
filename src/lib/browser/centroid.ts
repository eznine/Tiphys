/**
 * True planar centroids for browser vector layers.
 *
 * The catalog's Whitebox `centroid_vector` describes a "mean coordinate"
 * centre; on irregular building footprints it can sit more than a metre away
 * from the area-weighted centroid that GIS users and external benchmarks mean
 * by "centroid". This module computes the real thing:
 *
 *   polygon / multipolygon → area-weighted centroid, holes subtract area
 *   line / multiline       → length-weighted midpoint
 *   point / multipoint     → the point, or the mean of the points
 *
 * Coordinates are used in the layer's current CRS. Callers that need metric
 * accuracy should reproject to a local projected CRS first; the method card
 * and prompt say so explicitly.
 */
import type { Geometry } from "geojson";

type Position = number[];
type Ring = Position[];

function finitePoint(position: Position | undefined): [number, number] | null {
  if (!position || position.length < 2) return null;
  const x = Number(position[0]), y = Number(position[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function vertexMean(positions: Position[]): [number, number] | null {
  let x = 0, y = 0, count = 0;
  for (const position of positions) {
    const point = finitePoint(position);
    if (!point) continue;
    x += point[0]; y += point[1]; count++;
  }
  return count ? [x / count, y / count] : null;
}

/**
 * Signed area and centroid of one ring (shoelace).
 *
 * Projected coordinates are often ~10^5–10^7 metres. Summing raw cross
 * products at that scale cancels catastrophically in double precision (a small
 * 10 m² footprint can land metres away from its true centroid). Translate to
 * the ring's first valid vertex, compute, then add the origin back.
 */
function ringMetrics(ring: Ring): { area: number; x: number; y: number } {
  let originX = 0, originY = 0;
  for (const position of ring) {
    const point = finitePoint(position);
    if (point) { originX = point[0]; originY = point[1]; break; }
  }
  let twiceArea = 0, x = 0, y = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const a = finitePoint(ring[index]);
    const b = finitePoint(ring[index + 1]);
    if (!a || !b) continue;
    const ax = a[0] - originX, ay = a[1] - originY;
    const bx = b[0] - originX, by = b[1] - originY;
    const cross = ax * by - bx * ay;
    twiceArea += cross;
    x += (ax + bx) * cross;
    y += (ay + by) * cross;
  }
  const area = twiceArea / 2;
  if (Math.abs(area) < 1e-12) {
    const mean = vertexMean(ring);
    return mean ? { area: 0, x: mean[0], y: mean[1] } : { area: 0, x: 0, y: 0 };
  }
  return { area, x: originX + x / (6 * area), y: originY + y / (6 * area) };
}

function polygonCentroid(rings: Ring[]): [number, number] | null {
  if (!rings.length) return null;
  const outer = ringMetrics(rings[0]);
  let weight = Math.abs(outer.area);
  let x = outer.x * weight, y = outer.y * weight;
  for (const hole of rings.slice(1)) {
    const metrics = ringMetrics(hole);
    const holeWeight = -Math.abs(metrics.area);
    weight += holeWeight;
    x += metrics.x * holeWeight;
    y += metrics.y * holeWeight;
  }
  if (Math.abs(weight) < 1e-12) {
    const mean = vertexMean(rings[0]);
    return mean;
  }
  return [x / weight, y / weight];
}

function combine(parts: Array<{ weight: number; point: [number, number] }>): [number, number] | null {
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  if (!(total > 0)) return null;
  return [
    parts.reduce((sum, part) => sum + part.point[0] * part.weight, 0) / total,
    parts.reduce((sum, part) => sum + part.point[1] * part.weight, 0) / total,
  ];
}

function lineMidpoint(lines: Position[][]): [number, number] | null {
  const segments: Array<{ a: [number, number]; b: [number, number]; length: number }> = [];
  const validLines: Position[][] = [];
  for (const line of lines) {
    const positions = line.map(finitePoint).filter((point): point is [number, number] => !!point);
    if (!positions.length) continue;
    validLines.push(positions);
    for (let index = 0; index < positions.length - 1; index++) {
      const a = positions[index], b = positions[index + 1];
      segments.push({ a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) });
    }
  }
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (total < 1e-12) {
    const points = validLines.flat();
    return vertexMean(points);
  }
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const ratio = segment.length ? remaining / segment.length : 0;
      return [segment.a[0] + (segment.b[0] - segment.a[0]) * ratio, segment.a[1] + (segment.b[1] - segment.a[1]) * ratio];
    }
    remaining -= segment.length;
  }
  const last = segments[segments.length - 1];
  return [last.b[0], last.b[1]];
}

function polygonWeight(rings: Ring[]): number {
  if (!rings.length) return 0;
  const outer = Math.abs(ringMetrics(rings[0]).area);
  const holes = rings.slice(1).reduce((sum, ring) => sum + Math.abs(ringMetrics(ring).area), 0);
  return Math.max(0, outer - holes);
}

/**
 * Returns a point in the geometry's own coordinate space. Throws on mixed
 * GeometryCollections rather than inventing a weighting between metres, square
 * metres and feature counts.
 */
export function centroidOfGeometry(geometry: Geometry | null | undefined): [number, number] {
  if (!geometry) throw new Error("要素没有几何，无法计算质心。");
  switch (geometry.type) {
    case "Point": {
      const point = finitePoint(geometry.coordinates);
      if (!point) throw new Error("点坐标无效。");
      return point;
    }
    case "MultiPoint": {
      const mean = vertexMean(geometry.coordinates);
      if (!mean) throw new Error("多点坐标无效。");
      return mean;
    }
    case "LineString": {
      const midpoint = lineMidpoint([geometry.coordinates]);
      if (!midpoint) throw new Error("线坐标无效。");
      return midpoint;
    }
    case "MultiLineString": {
      const midpoint = lineMidpoint(geometry.coordinates);
      if (!midpoint) throw new Error("多线坐标无效。");
      return midpoint;
    }
    case "Polygon": {
      const centroid = polygonCentroid(geometry.coordinates);
      if (!centroid) throw new Error("面坐标无效。");
      return centroid;
    }
    case "MultiPolygon": {
      const parts = geometry.coordinates
        .map(rings => ({ weight: polygonWeight(rings), point: polygonCentroid(rings) }))
        .filter((part): part is { weight: number; point: [number, number] } => !!part.point && part.weight > 0);
      const centroid = combine(parts);
      if (!centroid) throw new Error("多面坐标无效。");
      return centroid;
    }
    default:
      throw new Error(`不支持的几何类型：${String((geometry as { type?: string }).type)}；请先拆分混合几何。`);
  }
}
