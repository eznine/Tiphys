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
import { describeWasmTool, runWasmTool, searchWasmTools } from "../src/wasm.js";
import { resolveWasmInput, resolveWasmInputs } from "../src/wasm-inputs.js";
import { TIPHYS_DIR } from "../src/config.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures");
const points = path.join(FIXTURES, "bj_points.geojson");
const dem = path.join(FIXTURES, "dem_hills.tif");

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

test("wasm_search exposes exact wire names and required flags from the real catalog", () => {
  const d8 = searchWasmTools("d8_pntr", { inputKind: "raster", limit: 5 });
  assert.equal(d8.ok, true);
  assert.ok(d8.total > 0);
  const basins = d8.tools.find(tool => tool.id === "basins");
  assert.ok(basins, "d8_pntr must surface basins");
  const pointer = basins!.inputs.find(input => input.name === "d8_pntr");
  assert.deepEqual(pointer && { name: pointer.name, kind: pointer.kind, required: pointer.required },
    { name: "d8_pntr", kind: "raster", required: true });

  const slope = searchWasmTools("坡度").tools.find(tool => tool.id === "slope");
  assert.ok(slope, "Chinese slope alias must surface slope");
  assert.equal(slope!.inputs[0].name, "input");
  assert.ok(slope!.parameters.some(parameter => parameter.name === "units" && parameter.options?.includes("percent")));
  assert.equal(slope!.outputs[0].name, "output");
  assert.throws(() => searchWasmTools("  "), /需要 query/);
});

test("wasm_run chains real raster tools and keeps outputs inside the writable state dir", async () => {
  const slope = await runWasmTool({ tool: "slope", inputPath: dem, params: { units: "degrees", z_factor: 1 } });
  assert.equal(slope.ok, true, slope.error);
  const raster = slope.namedOutputs.find(output => output.name === "output");
  assert.ok(raster?.path.endsWith(".tif"));
  assert.ok(raster!.path.startsWith(path.join(TIPHYS_DIR, "wasm-runs")), "runs must not stage under the read-only home dir");
  assert.ok(fs.existsSync(raster!.path));

  const polygons = await runWasmTool({ tool: "raster_to_vector_polygons", inputs: { input: raster!.path } });
  assert.equal(polygons.ok, true, polygons.error);
  assert.ok(polygons.geojsonPath, "raster_to_vector_polygons must yield a GeoJSON for add_data");
  const collection = JSON.parse(fs.readFileSync(polygons.geojsonPath!, "utf8"));
  assert.ok(collection.features.length > 0);
  assert.equal(collection.crs.properties.name, "urn:ogc:def:crs:EPSG::4326");
  assert.equal(polygons.namedOutputs[0].geojsonPath, polygons.geojsonPath);
});

test("wasm_run binds every manifest input name for a real multi-input tool", async () => {
  const added = await runWasmTool({ tool: "add", inputs: { input1: dem, input2: dem } });
  assert.equal(added.ok, true, added.error);
  assert.equal(added.namedOutputs.length, 1);
  assert.equal(added.namedOutputs[0].name, "output");
  assert.ok(fs.statSync(added.namedOutputs[0].path).size > 0);

  await assert.rejects(() => runWasmTool({ tool: "add", inputs: { input1: dem } }), /缺少必填输入：input2/);
  await assert.rejects(() => runWasmTool({ tool: "add", inputs: { input1: dem, wrong: dem } }), /不认识输入：wrong/);
  await assert.rejects(() => runWasmTool({ tool: "add", inputPath: dem }), /需要 2 个输入/);
});

test("workspace layer ids resolve through inspect_layers to the analysis file, not the display copy", async () => {
  const direct = await resolveWasmInput(dem, async () => { throw new Error("must not inspect a real file"); });
  assert.equal(direct.via, "file");
  assert.equal(direct.path, path.resolve(dem));

  const layer = await resolveWasmInput("lyr_dem", async id => {
    assert.equal(id, "lyr_dem");
    return { layer: { data: { location: dem, format: "tif" } }, extra: { displayUrl: "/display/dem.geojson" } };
  });
  assert.deepEqual({ via: layer.via, path: layer.path }, { via: "layer", path: path.resolve(dem) });

  const named = await resolveWasmInputs({ input1: dem, input2: "lyr_dem" }, async id => {
    assert.equal(id, "lyr_dem");
    return { layer: { data: { location: dem } } };
  });
  assert.deepEqual(named.paths, { input1: path.resolve(dem), input2: path.resolve(dem) });
  assert.equal(named.bindings.input2.via, "layer");
  await assert.rejects(() => resolveWasmInput("missing-layer", async () => ({ layer: {} })), /找不到 WASM 输入图层或文件/);
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
  const zonal = describeWasmTool("zonal_statistics");
  assert.deepEqual(zonal.inputs.map(input => input.name), ["input", "features"]);
});
