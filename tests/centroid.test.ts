/**
 * True centroid semantics for the native browser tool.
 *
 * The catalog's `centroid_vector` is a mean-coordinate centre and diverges from
 * an area-weighted centroid on irregular footprints (GeoAgentBench Capetown:
 * 52/122 > 1 m). These tests pin the replacement: area weighting for polygons
 * (holes subtract), length weighting for lines, identity for points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { centroidOfGeometry } from "../src/lib/browser/centroid.ts";

const close = (actual: [number, number], expected: [number, number], tol = 1e-9) => {
  assert.ok(Math.abs(actual[0] - expected[0]) <= tol, `x ${actual[0]} != ${expected[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) <= tol, `y ${actual[1]} != ${expected[1]}`);
};

test("polygon centroid is area-weighted, not a vertex mean", () => {
  // L-shape: 4×1 base plus 1×3 tower. Vertex mean would be (10/6, 10/6).
  const lShape = {
    type: "Polygon" as const,
    coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]],
  };
  close(centroidOfGeometry(lShape), [1.3571428571428572, 1.3571428571428572]);
});

test("large projected coordinates keep centroid precision", () => {
  const ox = 260000, oy = 6243000;
  const shifted = {
    type: "Polygon" as const,
    coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]].map(([x, y]) => [x + ox, y + oy])],
  };
  const centroid = centroidOfGeometry(shifted);
  close(centroid, [ox + 1.3571428571428572, oy + 1.3571428571428572], 1e-6);
});

test("polygon holes subtract area from the centroid", () => {
  const withHole = {
    type: "Polygon" as const,
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  };
  close(centroidOfGeometry(withHole), [5, 5]);
});

test("multipolygon combines parts by area", () => {
  const multi = {
    type: "MultiPolygon" as const,
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]],
    ],
  };
  close(centroidOfGeometry(multi), [1.5, 0.5]);
});

test("line centroid is a length-weighted midpoint", () => {
  const line = { type: "LineString" as const, coordinates: [[0, 0], [0, 10], [10, 10]] };
  close(centroidOfGeometry(line), [0, 10]);
  const multiLine = {
    type: "MultiLineString" as const,
    coordinates: [[[0, 0], [0, 2]], [[10, 0], [10, 1]]],
  };
  close(centroidOfGeometry(multiLine), [0, 1.5]);
});

test("points are preserved and multipoints average", () => {
  close(centroidOfGeometry({ type: "Point" as const, coordinates: [3, 4] }), [3, 4]);
  close(centroidOfGeometry({ type: "MultiPoint" as const, coordinates: [[0, 0], [2, 0], [4, 0]] }), [2, 0]);
});

test("mixed geometry collections are rejected instead of guessing weights", () => {
  assert.throws(
    () => centroidOfGeometry({ type: "GeometryCollection" as const, geometries: [] }),
    /不支持的几何类型：GeometryCollection/,
  );
});
