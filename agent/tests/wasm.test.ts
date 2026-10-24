/**
 * Stage 1 spike: the desktop sidecar can reach WASM tools through a child
 * process. These tests run the real geolibre CLI, not a mock: projection then a
 * 500 m buffer on the frozen fixture, with an independent area check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { describeWasmTool, runWasmTool } from "../src/wasm.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures");
const points = path.join(FIXTURES, "bj_points.geojson");

const rad = (degrees: number) => degrees * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]) {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function projectedPoints() {
  const result = await runWasmTool({ tool: "reproject_vector", inputPath: points, params: { epsg: 32650 } });
  assert.equal(result.ok, true, result.error);
  const fgb = result.outputs.find(output => output.file.endsWith(".fgb"));
  assert.ok(fgb, "reproject must produce a FlatGeobuf");
  return fgb!.path;
}

test("wasm_run executes a real tool in a child process and returns a readable GeoJSON", async () => {
  const input = await projectedPoints();
  const buffered = await runWasmTool({ tool: "buffer_vector", inputPath: input, params: { distance: 500 } });
  assert.equal(buffered.ok, true, buffered.error);
  assert.equal(buffered.cancelled, false);
  assert.ok(buffered.geojsonPath, "vector tools must yield a GeoJSON for add_data");
  assert.ok(fs.existsSync(buffered.geojsonPath!));

  const collection = JSON.parse(fs.readFileSync(buffered.geojsonPath!, "utf8"));
  assert.equal(collection.features.length, 3);
  assert.equal(collection.crs.properties.name, "urn:ogc:def:crs:EPSG::4326");
  // Independent check in metres: the buffer ring sits 500 m from its own source point.
  const sources = JSON.parse(fs.readFileSync(points, "utf8")).features
    .map((feature: any) => [String(feature.properties.name), feature.geometry.coordinates] as const);
  for (const [index, feature] of collection.features.entries()) {
    const source = sources[index][1];
    const ring = feature.geometry.coordinates[0] as number[][];
    const nearest = Math.min(...ring.map(vertex => sphericalDistance(source, vertex)));
    assert.ok(Math.abs(nearest - 500) < 2, `radius ${nearest} m for ${sources[index][0]}`);
  }
  assert.ok(buffered.outputs.some(output => output.file.endsWith(".fgb")));
});

test("wasm_run propagates cancellation and keeps later runs isolated", async () => {
  const input = await projectedPoints();
  const cancelled = await runWasmTool({ tool: "buffer_vector", inputPath: input, params: { distance: 500 }, timeoutMs: 50 });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.ok, false);
  assert.deepEqual(cancelled.outputs, []);

  // A killed child cannot poison the next run: this is the whole point of the bridge.
  const next = await runWasmTool({ tool: "buffer_vector", inputPath: input, params: { distance: 250 } });
  assert.equal(next.ok, true, next.error);
  assert.equal(next.outputs.length > 0, true);
});

test("wasm_run rejects unknown tools, unknown parameters and missing files", async () => {
  await assert.rejects(() => runWasmTool({ tool: "not_a_real_tool", inputPath: points }), /未知 WASM 工具/);
  await assert.rejects(() => runWasmTool({ tool: "buffer_vector", inputPath: points, params: { distnace: 500 } }), /不认识参数/);
  await assert.rejects(() => runWasmTool({ tool: "buffer_vector", inputPath: path.join(FIXTURES, "missing.geojson") }), /输入文件不存在/);
  assert.throws(() => describeWasmTool("not_a_real_tool"), /未知 WASM 工具/);
  const described = describeWasmTool("buffer_vector");
  assert.equal(described.input.name, "input");
  assert.equal(described.output.name, "output");
});