/**
 * Browser WASM vector budget: refuse oversized layers with a clear downgrade
 * path instead of trapping (GeoAgentBench Bangkok: 21,660 polygons / 645k
 * vertices made clip/intersection return `unreachable`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_VECTOR_BUDGET, assertBrowserVectorBudget, countVertices, vectorBudgetError } from "../src/lib/browser/vector-budget.ts";

test("countVertices handles polygon, multipolygon and geometry collections", () => {
  assert.equal(countVertices({ features: [{ geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }] }), 5);
  assert.equal(countVertices({ features: [{ geometry: { type: "MultiPolygon", coordinates: [
    [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    [[[2, 0], [3, 0], [3, 1], [2, 0]]],
  ] } }] }), 8);
  assert.equal(countVertices({ features: [{ geometry: { type: "GeometryCollection", geometries: [
    { type: "Point", coordinates: [1, 2] },
    { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  ] } }] }), 3);
  assert.equal(countVertices({ features: [{ geometry: null }] }), 0);
});

test("vectorBudgetError draws the line at the published budget", () => {
  assert.equal(vectorBudgetError(BROWSER_VECTOR_BUDGET.maxFeatures, BROWSER_VECTOR_BUDGET.maxVertices), null);
  assert.match(vectorBudgetError(BROWSER_VECTOR_BUDGET.maxFeatures + 1, 0) ?? "", /超过浏览器矢量上限/);
  assert.match(vectorBudgetError(100, BROWSER_VECTOR_BUDGET.maxVertices + 1) ?? "", /顶点.*超过浏览器矢量上限/);
  assert.match(vectorBudgetError(21_660, 645_563) ?? "", /降级/);
});

test("assertBrowserVectorBudget names the layer and operation", () => {
  const record = {
    info: { name: "Bangkok landcover", feature_count: 21_660 },
    geojson: { features: [{ geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] },
  };
  assert.throws(() => assertBrowserVectorBudget(record, "图层求交"), /图层求交.*Bangkok landcover.*上限/);
});
