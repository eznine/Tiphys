import "fake-indexeddb/auto";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { zipSync } from "fflate";
import { initTools, runTool } from "geolibre-wasm/tools";
import initLibrary from "geolibre-wasm";
import { browserCatalog, browserEngineRequest, browserLayers, cancelBrowserJob, importBrowserFile, readBrowserJob, runBrowserTool } from "../src/lib/browser/engine.ts";
import { readRecord, writeRecord } from "../src/lib/browser/storage.ts";
import { metricCrs } from "../src/lib/browser/geometry.ts";
import { browserCatalogState, desktopToolCatalog, ensureBrowserCatalog, shellToolCatalog } from "../src/lib/browser/catalog-schema.ts";
import { zhToolL1, zhToolL2 } from "../src/lib/i18n/tools.ts";
import { searchBrowserTools } from "../src/lib/browser/search.ts";
import { compactBrowserMessages, estimateBrowserTokens, readBrowserContextRecord } from "../src/lib/browser/context.ts";
import { buildBrowserSystemPrompt } from "../src/lib/browser/prompt.ts";
import { mapExportFilename, mapPngDataUrl } from "../src/lib/map-export.ts";
import { geeExecutionAllowed } from "../src/lib/gee.ts";
import { defaultLayerStyle, PALETTE } from "../src/lib/dataLayers.ts";
import { releaseIdleWasmToolWorkers, warmWasmToolRunner } from "../src/lib/browser/wasm-tool-runner.ts";
import { buildWorkspaceSnapshot, normalizeWorkspaceSnapshot, WORKSPACE_SCHEMA, WORKSPACE_VERSION } from "../src/lib/workspace.ts";
import { pipelineResult } from "../src/components/ToolResultDetails.tsx";
import type { ModelMessage } from "ai";

before(async () => {
  await initTools(fs.readFileSync(new URL("../node_modules/geolibre-wasm/geolibre-cli.wasm", import.meta.url)));
  await initLibrary({ module_or_path: fs.readFileSync(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)) });
});
async function finished(name: string, args: Record<string, unknown>) {
  const created = await runBrowserTool(name, args);
  if (!created.job_id) return created;
  for (let n = 0; n < 300; n++) {
    const job = await readBrowserJob(created.job_id);
    if (!["running", "queued", "cancelling"].includes(job.status)) { assert.equal(job.status, "completed", job.error || job.message); return job.result!; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Browser engine test exceeded its observation budget");
}
async function sample(name = "beijing") { return (await importBrowserFile(new Blob([fs.readFileSync(new URL("../samples/beijing_points.geojson", import.meta.url))]), `${name}.geojson`)).layer; }
const rad = (degrees: number) => degrees * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]) { const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2; return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }

test("actual WASM buffer preserves attributes, metric radius, native CRS and readable persistence", async () => {
  const input = await sample();
  const result = await finished("buffer", { layer: input.id, distance: 500, units: "meters", dissolve: false, output_name: "buffer500" });
  assert.equal(result.layer.feature_count, 5); assert.equal(result.layer.crs, "EPSG:32650");
  const original: any = await readRecord(`layer:${input.id}`), output: any = await readRecord(`layer:${result.layer.id}`);
  for (const feature of output.geojson.features) {
    const point = original.geojson.features.find((f: any) => f.properties.id === feature.properties.id).geometry.coordinates;
    for (const vertex of feature.geometry.coordinates[0]) assert.ok(Math.abs(sphericalDistance(point, vertex) - 500) < 2, "independent spherical radius within 2 m");
  }
  assert.equal(output.bytes.length > 0, true);
  assert.equal((await browserLayers()).some(l => l.id === result.layer.id), true);
});

test("actual WASM convex hull, point clipping and native centroid use the same layer store", async () => {
  const input = await sample("analysis");
  const hull = await finished("convex_hull", { layer: input.id });
  assert.equal(hull.layer.feature_count, 1);
  const clipped = await finished("clip", { layer: input.id, mask_layer: hull.layer.id });
  assert.equal(clipped.layer.feature_count, 5);
  const native = await finished("wasm_centroid_vector", { input: hull.layer.id });
  assert.equal(native.layer.feature_count, 1); assert.deepEqual(native.layer.geometry_types, ["Point"]);
});

test("polygon union and measured geometry run with real WASM contracts", async () => {
  const square = (x: number, y: number, id: number) => ({ type: "Feature", properties: { id },
    geometry: { type: "Polygon", coordinates: [[[x, y], [x + .02, y], [x + .02, y + .02], [x, y + .02], [x, y]]] } });
  const collection = (features: any[]) => new Blob([JSON.stringify({ type: "FeatureCollection", features })]);
  const a = (await importBrowserFile(collection([square(116, 39, 1)]), "square_a.geojson")).layer;
  const b = (await importBrowserFile(collection([square(116.01, 39.01, 2)]), "square_b.geojson")).layer;
  const measured = await finished("calculate_geometry", { layer: a.id, output_name: "measured_a" });
  assert.deepEqual(measured.added_columns, ["area_m2", "length_m"]); assert.equal(measured.layer.crs, "EPSG:4326");
  const measuredRecord: any = await readRecord(`layer:${measured.layer.id}`), p = measuredRecord.geojson.features[0].properties;
  assert.ok(Math.abs(p.area_m2 - 3_843_000) < 20_000, `measured area ${p.area_m2}`);
  assert.ok(Math.abs(p.length_m - 7_904) < 30, `measured perimeter ${p.length_m}`);
  const union = await finished("union_layers", { layer: a.id, other_layer: b.id, output_name: "union_ab" });
  assert.equal(union.layer.crs, "EPSG:4326"); assert.ok(union.layer.feature_count >= 1);
  assert.ok(union.layer.geometry_types.every((t: string) => ["Polygon", "MultiPolygon"].includes(t)));
});

test("spatial_join transfers polygon attributes to points and supports nearest joins", async () => {
  const points = await sample("join-targets");
  const polygon = { type: "FeatureCollection", features: [{ type: "Feature", properties: { zone: "core", score: 7 },
    geometry: { type: "Polygon", coordinates: [[[116.2, 39.8], [116.6, 39.8], [116.6, 40.1], [116.2, 40.1], [116.2, 39.8]]] } }] };
  const zones = (await importBrowserFile(new Blob([JSON.stringify(polygon)]), "join-zones.geojson")).layer;
  const joined = await finished("spatial_join", { layer: points.id, join_layer: zones.id, predicate: "intersects", keep_fields: true, output_name: "joined_points" });
  assert.equal(joined.layer.feature_count, 5);
  const joinedRecord: any = await readRecord(`layer:${joined.layer.id}`);
  assert.equal(joinedRecord.geojson.features[0].properties.JOIN_zone, "core");
  assert.equal(joinedRecord.geojson.features[0].properties.JOIN_score, 7);
  const targetOnly = await finished("spatial_join", { layer: points.id, join_layer: zones.id, predicate: "intersects", keep_fields: false, output_name: "target_only" });
  const targetRecord: any = await readRecord(`layer:${targetOnly.layer.id}`);
  assert.ok(!Object.keys(targetRecord.geojson.features[0].properties).some((key: string) => key.startsWith("JOIN_")));

  const nearestSource = { type: "FeatureCollection", features: [{ type: "Feature", properties: { station: "A" }, geometry: { type: "Point", coordinates: [116.4, 39.9] } }] };
  const nearestLayer = (await importBrowserFile(new Blob([JSON.stringify(nearestSource)]), "nearest-stations.geojson")).layer;
  const nearest = await finished("spatial_join", { layer: points.id, join_layer: nearestLayer.id, predicate: "nearest", keep_fields: true, output_name: "nearest_join" });
  const nearestRecord: any = await readRecord(`layer:${nearest.layer.id}`);
  assert.equal(nearestRecord.geojson.features[0].properties.JOIN_station, "A");
  assert.equal(typeof nearestRecord.geojson.features[0].properties.NEAR_DIST, "number");
});

test("Shapefile zip and FlatGeobuf import from actual converted files", async () => {
  const source = new Blob([fs.readFileSync(new URL("../samples/beijing_points.geojson", import.meta.url))]);
  const owner = (await importBrowserFile(source, "zip-source.geojson")).layer;
  await finished("export_features", { layer: owner.id, path: "zip-source.fgb", fmt: "fgb" });
  const fgbFile: any = await readRecord("download:zip-source.fgb");
  const reopened = await importBrowserFile(new Blob([fgbFile.bytes]), "reopened.fgb");
  assert.equal(reopened.layer.feature_count, owner.feature_count); assert.equal(reopened.layer.crs, "EPSG:4326");
  const plain = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Tiananmen", id: 1 },
    geometry: { type: "Point", coordinates: [116.3974, 39.9093] } }] };
  const converted = await runTool("vector_convert", { args: ["--input=/work/a.geojson", "--output=/work/shape.shp"],
    input: { "a.geojson": new TextEncoder().encode(JSON.stringify(plain)) } });
  assert.equal(converted.exitCode, 0);
  const zip = zipSync(Object.fromEntries(Object.entries(converted.files).map(([name, data]) => [`folder/${name}`, data])));
  const imported = await importBrowserFile(new Blob([zip]), "shape_points.zip");
  assert.equal(imported.layer.feature_count, 1); assert.equal(imported.layer.crs, "EPSG:4326");
  assert.equal(imported.layer.geometry_types[0], "Point");
  const bad = zipSync({ "roads.shp": new Uint8Array([1]), "roads.shx": new Uint8Array([2]), "roads.dbf": new Uint8Array([3]) });
  await assert.rejects(importBrowserFile(new Blob([bad]), "broken.zip"), /转换没有生成|读取|Shapefile|无效/);
});

test("attribute comparison keeps numeric nulls and text leading zeros distinct", async () => {
  const features = [{ v: 1, code: "01" }, { v: null, code: "1" }, { v: 3, code: null }].map((properties, i) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [116.4 + i * .001, 39.9] } }));
  const input = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", features })]), "nullable.geojson")).layer;
  assert.equal((await finished("select_by_attributes", { layer: input.id, field: "v", op: "gt", value: "1" })).layer.feature_count, 1);
  assert.equal((await finished("select_by_attributes", { layer: input.id, field: "v", op: "isnull" })).layer.feature_count, 1);
  assert.equal((await finished("select_by_attributes", { layer: input.id, field: "code", op: "eq", value: "01" })).layer.feature_count, 1);
  assert.equal((await finished("select_by_attributes", { layer: input.id, field: "code", op: "startswith", value: "0" })).layer.feature_count, 1);
  assert.equal((await finished("select_by_attributes", { layer: input.id, field: "v", op: "gt", value: "100" })).layer.feature_count, 0);
});

test("invalid tools and parameters fail without adding output; cancelled jobs never publish", async () => {
  const input = await sample("cancel"); const count = (await browserLayers()).length;
  await assert.rejects(runBrowserTool("buffer", { layer: input.id, distance: "500" }), /数字/);
  await assert.rejects(runBrowserTool("buffer", { layer: input.id, distance: 500, mystery: true }), /未知参数/);
  const job = await runBrowserTool("buffer", { layer: input.id, distance: 500 });
  await cancelBrowserJob(job.job_id);
  for (let n = 0; n < 100; n++) { if ((await readBrowserJob(job.job_id)).status === "cancelled") break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal((await readBrowserJob(job.job_id)).status, "cancelled");
  assert.equal((await browserLayers()).length, count);
  await writeRecord("job:orphan", { job_id: "orphan", owner: "closed-tab", status: "running", message: "", progress: 0 });
  assert.equal((await readBrowserJob("orphan")).status, "interrupted");
});

test("browser routes paginate/sort actual attributes and exports produce valid independent files", async () => {
  const input = await sample("routes");
  const response = await browserEngineRequest(`/layers/${input.id}/attributes?sort=id&descending=true&limit=2&offset=1`);
  const page = await response.json(); assert.equal(page.total, 5); assert.equal(page.rows.length, 2); assert.equal(page.rows[0].attributes.id, 4);
  const exported = await finished("export_features", { layer: input.id, path: "browser.gpkg", fmt: "gpkg" });
  assert.ok(exported.bytes > 0);
  const file: any = await readRecord("download:browser.gpkg");
  const reloaded = await importBrowserFile(new Blob([file.bytes]), "reimport.gpkg");
  assert.equal(reloaded.layer.feature_count, 5); assert.equal(reloaded.layer.crs, "EPSG:4326");
  const duplicate = await runBrowserTool("export_features", { layer: input.id, path: "browser.gpkg", fmt: "gpkg" });
  for (let n = 0; n < 100; n++) { if ((await readBrowserJob(duplicate.job_id)).status === "failed") break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal((await readBrowserJob(duplicate.job_id)).status, "failed");
});

test("CSV export writes original-CRS WKT and safely quotes spreadsheet text", async () => {
  const source = { type: "FeatureCollection", name: "csv_export", crs: { type: "name", properties: { name: "EPSG:3857" } },
    features: [{ type: "Feature", properties: { "名称": "天安门, 北京", formula: "=SUM(1,2)", note: "say \"hello\"" },
      geometry: { type: "Point", coordinates: [12958676.337, 4850689.762] } }] };
  const input = (await importBrowserFile(new Blob([JSON.stringify(source)]), "csv-source.geojson")).layer;
  assert.equal(input.crs, "EPSG:3857");
  const exported = await finished("export_features", { layer: input.id, path: "attributes.csv", fmt: "csv" });
  assert.ok(exported.bytes > 0);
  const file: any = await readRecord("download:attributes.csv");
  const text = new TextDecoder().decode(file.bytes);
  assert.equal(text.split("\n")[0], "名称,formula,note,geometry");
  assert.match(text, /"天安门, 北京","'=SUM\(1,2\)","say ""hello""",POINT\(12958676\.337 4850689\.762\)/);
});

test("metric admission rejects unsuitable extents; WASM catalog contains real parameter contracts", async () => {
  await ensureBrowserCatalog();
  assert.throws(() => metricCrs({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [[0,0],[120,0]] } }] }), /范围/);
  assert.ok(browserCatalog.some(t => t.name === "wasm_centroid_vector"));
  assert.ok(browserCatalog.filter(t => t.name.startsWith("wasm_")).every(t => (t.parameters as any).additionalProperties === false));
});

test("widened catalog exposes the vector, raster and table toolbox", async () => {
  await ensureBrowserCatalog();
  const native = browserCatalog.filter(t => t.name.startsWith("wasm_"));
  assert.ok(native.length > 900, `expected the widened GeoLibre catalog, got ${native.length}`);
  for (const name of ["wasm_reproject_raster", "wasm_hillshade", "wasm_zonal_statistics", "wasm_vector_points_to_raster", "wasm_idw_interpolation"]) {
    assert.ok(native.some(t => t.name === name), `${name} should be exposed`);
  }
  const rasterInput = native.find(t => t.name === "wasm_hillshade")!;
  assert.equal((rasterInput.parameters as any).properties.input["x-layer-kind"], "raster");
});

test("vector points rasterize into a displayed raster layer and feed raster tools", async () => {
  const input = await sample("rasterize-src");
  const result = await finished("wasm_vector_points_to_raster", { input: input.id, cell_size: 100 });
  const layer = result.layers?.[0]?.layer ?? result.layer;
  assert.equal(layer.kind, "raster");
  assert.ok(layer.bounds, "raster layer must carry WGS84 bounds");
  assert.equal(layer.image_coords?.length, 4, "raster layer must expose image-source corners");
  const [minx, miny, maxx, maxy] = layer.bounds;
  assert.ok(minx >= -180 && maxx <= 180 && miny >= -90 && maxy <= 90, "preview bounds must be lon/lat");
  const stored: any = await readRecord(`layer:${layer.id}`);
  assert.equal(stored.info.kind, "raster");
  assert.ok(stored.preview?.length > 0, "raster record must keep a preview PNG");
  assert.equal(stored.preview[0], 0x89, "preview must start with the PNG signature");

  // The stored GeoTIFF re-imports cleanly and a raster tool consumes it.
  const reimported = (await importBrowserFile(new Blob([new Uint8Array(stored.bytes)]), "reimported.tif")).layer;
  assert.equal(reimported.kind, "raster");
  assert.equal(reimported.crs, layer.crs);
  const shade = await finished("wasm_hillshade", { input: reimported.id });
  const shadeLayer = shade.layers?.[0]?.layer ?? shade.layer;
  assert.equal(shadeLayer.kind, "raster");
});

test("linkage mapper helper chains core rasterization and a least-cost corridor network", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const square = (x: number, y: number, id: number) => ({ type: "Feature", properties: { id },
    geometry: { type: "Polygon", coordinates: [[[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100], [x, y]]] } });
  const collection = (features: any[]) => new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]);
  const habitats = (await importBrowserFile(collection([
    square(500000, 4400000, 1), square(500700, 4400200, 2), square(501400, 4400400, 3),
  ]), "habitats.geojson")).layer;
  const resistanceSource = (await importBrowserFile(collection([
    { type: "Feature", properties: { id: 1 }, geometry: { type: "Polygon", coordinates: [[[499500, 4399500], [502000, 4399500], [502000, 4402500], [499500, 4402500], [499500, 4399500]]] } },
  ]), "resistance.geojson")).layer;
  const resistance = await finished("wasm_vector_polygons_to_raster", { input: resistanceSource.id, cell_size: 100, output_name: "resistance" });
  const resistanceLayer = resistance.layer ?? resistance.layers?.[0]?.layer;
  const result = await finished("linkage_mapper_corridor", {
    layer: habitats.id, resistance: resistanceLayer.id, corridor_width: 200,
    neighbor_option: "spanning_tree", output_name: "habitat_corridors",
  });
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.plugin, "linkage-mapper");
  assert.deepEqual(result.tools, ["wasm_vector_polygons_to_raster", "wasm_optimal_corridor_connections"]);
  assert.equal(result.source_raster.kind, "raster");
  assert.equal(result.source_raster.raster.width, resistanceLayer.raster.width);
  const corridorLayers = result.layers.slice(1).map((item: any) => item.layer);
  assert.ok(corridorLayers.some((layer: any) => layer.geometry_types.includes("Polygon") && layer.feature_count > 0));
  assert.ok(corridorLayers.some((layer: any) => layer.geometry_types.includes("LineString") && layer.feature_count > 0));
  const stored = await browserLayers();
  assert.ok(stored.some(layer => layer.id === result.source_raster.id));
  for (const layer of corridorLayers) assert.ok(stored.some(item => item.id === layer.id));
  await assert.rejects(finished("linkage_mapper_corridor", { layer: habitats.id }), /缺少参数：resistance/);
});

test("hydrology helper chains depression fill, D8 flow and stream extraction on a synthetic DEM", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100;
  const features: any[] = [];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const x = 500000 + col * cell, y = 4400000 + row * cell;
      const elevation = 1200 - row * 4 - col + (row === 5 && col === 5 ? -15 : 0);
      features.push({ type: "Feature", properties: { elev: elevation },
        geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
    }
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "synthetic_dem_source.geojson")).layer;
  const dem = await finished("wasm_vector_polygons_to_raster", {
    input: source.id, field: "elev", cell_size: cell, output_name: "synthetic_dem",
  });
  const demLayer = dem.layer ?? dem.layers?.[0]?.layer;
  assert.equal(demLayer.kind, "raster");

  const result = await finished("hydrology_flow_pipeline", {
    dem: demLayer.id, stream_threshold: 20, output_name: "synthetic_hydrology",
  });
  assert.equal(result.ok, true);
  assert.equal(result.plugin, "hydrology-flow");
  assert.deepEqual(result.tools, ["wasm_fill_depressions", "wasm_d8_pointer", "wasm_d8_flow_accum", "wasm_extract_streams"]);
  assert.deepEqual(result.steps.map((step: any) => step.status), ["completed", "completed", "completed", "completed"]);
  const outputs = result.layers.map((item: any) => item.layer);
  assert.equal(outputs.length, 4);
  assert.ok(outputs.every((layer: any) => layer.kind === "raster"));
  assert.match(result.limitations, /D8/);
  const stored = await browserLayers();
  for (const layer of outputs) assert.ok(stored.some(item => item.id === layer.id));

  const pourPoint = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [{
    type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [500650, 4400050] },
  }] })]), "synthetic_pour_points.geojson")).layer;
  const watershed = await finished("hydrology_flow_pipeline", {
    dem: demLayer.id, pour_points: pourPoint.id, extract_streams: false, output_name: "synthetic_watershed",
  });
  assert.deepEqual(watershed.tools, ["wasm_fill_depressions", "wasm_d8_pointer", "wasm_d8_flow_accum", "wasm_watershed"]);
  const watershedLayer = watershed.layers.at(-1).layer;
  assert.equal(watershedLayer.kind, "raster");
  assert.equal(watershedLayer.raster.width, outputs[0].raster.width);
});

test("Whitebox extension is a real breach, fill and D8 chain", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100, features: any[] = [];
  for (let row = 0; row < 10; row++) for (let col = 0; col < 10; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    features.push({ type: "Feature", properties: { elev: 1000 - row * 3 - col + (row === 4 && col === 4 ? -12 : 0) },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "whitebox_dem_source.geojson")).layer;
  const dem = (await finished("wasm_vector_polygons_to_raster", { input: source.id, field: "elev", cell_size: cell, output_name: "whitebox_dem" })).layer;
  const result = await finished("whitebox_extra", { dem: dem.id, max_dist: 20, fill_flat_increment: 0.001, output_name: "whitebox_conditioned" });
  assert.equal(result.ok, true);
  assert.equal(result.plugin, "whitebox-extra");
  assert.deepEqual(result.tools, ["wasm_breach_depressions_least_cost", "wasm_fill_depressions", "wasm_d8_pointer"]);
  assert.deepEqual(result.steps.map((step: any) => step.status), ["completed", "completed", "completed"]);
  const layers = result.layers.map((item: any) => item.layer);
  assert.equal(layers.length, 3);
  assert.ok(layers.every((layer: any) => layer.kind === "raster" && layer.raster.width === dem.raster.width));
  assert.match(result.limitations, /不计算汇流累积/);
});

test("network topology form publishes optional node output instead of requesting it as input", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const network = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[500000, 4400050], [5001000, 4400050]] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "LineString", coordinates: [[5000500, 4400000], [5000500, 4401000]] } },
  ] })]), "network_lines.geojson")).layer;
  const result = await finished("wasm_build_network_topology", { input: network.id, output_name: "noded_network" });
  const layers = Array.isArray(result.layers) ? result.layers.map((item: any) => item.layer).filter(Boolean) : (result.layer ? [result.layer] : []);
  assert.equal(layers.length, 2);
  assert.ok(layers.some((layer: any) => layer.geometry_types.some((type: string) => type.includes("Line"))));
  assert.ok(layers.some((layer: any) => layer.geometry_types.some((type: string) => type.includes("Point"))));
});

test("least-cost path helper produces point paths, polygon centerlines and a real cost surface", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100;
  const costFeatures: any[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    costFeatures.push({ type: "Feature", properties: { cost: 1 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const costSource = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: costFeatures })]), "lcp_cost_source.geojson")).layer;
  const resistance = (await finished("wasm_vector_polygons_to_raster", { input: costSource.id, field: "cost", cell_size: cell, output_name: "lcp_resistance" })).layer;

  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [500100, 4400100] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "Point", coordinates: [500700, 4400500] } },
  ] })]), "lcp_points.geojson")).layer;
  const pointPath = await finished("least_cost_path_pipeline", {
    source: points.id, destination: points.id, resistance: resistance.id, output_name: "point_lcp",
  });
  assert.equal(pointPath.ok, true);
  assert.equal(pointPath.plugin, "least-cost-path");
  assert.equal(pointPath.model, "cost_connectivity");
  assert.deepEqual(pointPath.tools, ["wasm_vector_points_to_raster", "wasm_cost_distance", "wasm_cost_connectivity"]);
  assert.equal(pointPath.source_raster.kind, "raster");
  assert.equal(pointPath.source_raster.raster.width, resistance.raster.width);
  assert.equal(pointPath.cost_surface.kind, "raster");
  assert.ok(pointPath.path_layers.some((layer: any) => layer.geometry_types.includes("LineString") && layer.feature_count > 0));
  assert.match(pointPath.limitations, /NoData/);

  const wgsDestination = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } }, features: [
      { type: "Feature", properties: { id: 9 }, geometry: { type: "Point", coordinates: [117.00700395977505, 39.75351138287242] } },
    ] })]), "lcp_wgs_destination.geojson")).layer;
  const mixedCrsPath = await finished("least_cost_path_pipeline", {
    source: points.id, destination: wgsDestination.id, resistance: resistance.id, output_name: "mixed_crs_lcp",
  });
  assert.deepEqual(mixedCrsPath.tools, ["wasm_reproject_vector", "merge_vectors", "wasm_vector_points_to_raster", "wasm_cost_distance", "wasm_cost_connectivity"]);
  assert.equal(mixedCrsPath.endpoints.crs, "EPSG:32650");
  assert.ok(mixedCrsPath.path_layers.some((layer: any) => layer.geometry_types.includes("LineString") && layer.feature_count > 0));

  const square = (x: number, y: number, id: number) => ({ type: "Feature", properties: { id },
    geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  const polygonSource = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [square(500100, 4400100, 1)] })]), "lcp_source_polygon.geojson")).layer;
  const polygonDestination = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [square(500600, 4400400, 2)] })]), "lcp_destination_polygon.geojson")).layer;
  const polygonPath = await finished("least_cost_path_pipeline", {
    source: polygonSource.id, destination: polygonDestination.id, resistance: resistance.id, corridor_width: 200, output_name: "polygon_lcp",
  });
  assert.equal(polygonPath.model, "optimal_corridor_connections");
  assert.deepEqual(polygonPath.tools, ["merge_vectors", "wasm_vector_polygons_to_raster", "wasm_cost_distance", "wasm_optimal_corridor_connections"]);
  assert.ok(polygonPath.path_layers.some((layer: any) => layer.geometry_types.includes("LineString") && layer.feature_count > 0));
  assert.ok(polygonPath.path_layers.some((layer: any) => layer.geometry_types.includes("Polygon") && layer.feature_count > 0));
  const stored = await browserLayers();
  for (const item of [...pointPath.layers, ...polygonPath.layers]) if (item.layer) assert.ok(stored.some(layer => layer.id === item.layer.id));
  for (const layer of [...pointPath.path_layers, ...polygonPath.path_layers]) assert.ok(stored.some(item => item.id === layer.id));
  await assert.rejects(finished("least_cost_path_pipeline", { source: points.id, resistance: resistance.id }), /缺少参数：destination/);
});

test("AOI clip helper clips vectors, reprojects for rasters and removes the temporary AOI layers", async () => {
  const crs4326 = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } };
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs: crs4326, features: [
    [116.01, 39.01], [116.02, 39.02], [116.03, 39.03], [116.05, 39.05],
  ].map(([x, y], index) => ({ type: "Feature", properties: { id: index + 1 }, geometry: { type: "Point", coordinates: [x, y] } })) })]), "aoi_points.geojson")).layer;
  const vectorClip = await finished("clip_layers_to_aoi", {
    layer: points.id, aoi_west: 116, aoi_south: 39, aoi_east: 116.035, aoi_north: 39.035, output_name: "aoi_vector_clip",
  });
  assert.equal(vectorClip.plugin, "aoi-clip");
  assert.equal(vectorClip.layers[0].layer.feature_count, 3);
  assert.deepEqual(vectorClip.tools, ["clip"]);
  assert.deepEqual(vectorClip.aoi_bbox, [116, 39, 116.035, 39.035]);

  const crs32650 = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100, squares: any[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    squares.push({ type: "Feature", properties: { value: 1 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const rasterSource = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs: crs32650, features: squares })]), "aoi_raster_source.geojson")).layer;
  const raster = (await finished("wasm_vector_polygons_to_raster", { input: rasterSource.id, field: "value", cell_size: cell, output_name: "aoi_raster" })).layer;
  const [minx, miny, maxx, maxy] = raster.bounds;
  const dx = (maxx - minx) * 0.2, dy = (maxy - miny) * 0.2;
  const rasterClip = await finished("clip_layers_to_aoi", {
    layer: raster.id, aoi_west: minx + dx, aoi_south: miny + dy, aoi_east: maxx - dx, aoi_north: maxy - dy, output_name: "aoi_raster_clip",
  });
  assert.equal(rasterClip.target_epsg, 32650);
  assert.deepEqual(rasterClip.tools, ["wasm_reproject_vector", "wasm_clip_raster_to_polygon"]);
  assert.equal(rasterClip.layers[0].layer.kind, "raster");
  assert.ok(rasterClip.layers[0].layer.raster.width <= raster.raster.width);
  const stored = await browserLayers();
  assert.ok(!stored.some(layer => layer.name === "AOI" || layer.name.startsWith("AOI_")));
});

test("map export produces a PNG data URL and timestamped filename", () => {
  let requestedType = "";
  const canvas = { toDataURL: (type?: string) => { requestedType = type ?? ""; return "data:image/png;base64,AAAA"; } };
  assert.equal(mapPngDataUrl(canvas), "data:image/png;base64,AAAA");
  assert.equal(requestedType, "image/png");
  assert.equal(mapExportFilename(new Date("2026-10-24T02:40:10.500Z")), "tiphys-map-2026-10-24_02-40-10.png");
  assert.throws(() => mapPngDataUrl({ toDataURL: () => "data:," }), /画布为空/);
});

test("rename_layer updates the display name in place and reorder_layers sets the draw order", async () => {
  const first = (await sample("order-keep"));
  const second = (await sample("order-move"));
  const renamed = await finished("rename_layer", { layer: first.id, name: "改名后的图层" });
  assert.equal(renamed.layer.name, "改名后的图层");
  const layersAfterRename = await browserLayers();
  assert.equal(layersAfterRename.find(l => l.id === first.id)?.name, "改名后的图层");
  await finished("reorder_layers", { layer_ids: [second.id, first.id, ...(await browserLayers()).map(l => l.id).filter(id => id !== second.id && id !== first.id)] });
  const layersAfterReorder = await browserLayers();
  assert.equal(layersAfterReorder[0].id, second.id);
  assert.equal(layersAfterReorder[1].id, first.id);
  await finished("remove_layer", { layer: second.id });
  assert.ok(!(await browserLayers()).some(l => l.id === second.id));
});

test("GEE slice, ArcGIS adapters and explanatory plugin return honest structured results", async () => {
  const saved = Object.fromEntries(["TIPHYS_GEE_PROJECT", "TIPHYS_GEE_TOKEN", "TIPHYS_GEE_SA_PATH", "TIPHYS_GEE_DEMO"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  const auth = await runBrowserTool("gee_auth_status", {});
  assert.equal(auth.connected, false);
  assert.equal(auth.status, "not_configured");
  assert.equal(auth.project, null);
  assert.equal(auth.hasToken, false);
  assert.equal(auth.hasServiceAccount, false);
  assert.equal(auth.demo, false);
  assert.equal(geeExecutionAllowed("gee_export_raster", auth), false);
  assert.equal(geeExecutionAllowed("gee_auth_status", auth), true);
  const search = await runBrowserTool("gee_search_collection", { collection: "COPERNICUS/S2_SR_HARMONIZED" });
  assert.deepEqual(search.items, []);
  assert.ok(search.hint);
  const exportJob = await runBrowserTool("gee_export_raster", { collection: "COPERNICUS/S2_SR_HARMONIZED", band: "B4", path: "demo.tif" });
  let exportStatus = await readBrowserJob(exportJob.job_id);
  for (let attempt = 0; attempt < 100 && ["queued", "running", "cancelling"].includes(exportStatus.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    exportStatus = await readBrowserJob(exportJob.job_id);
  }
  assert.equal(exportStatus.status, "failed");
  assert.match(exportStatus.message, /未连接|未执行/);
  const exported = exportStatus.result!;
  assert.equal(exported.connected, false);
  assert.equal(exported.path ?? exported.requested_path, "demo.tif");
  const geeStatus = await runBrowserTool("gee_job_status", { job_id: "missing" });
  assert.equal(geeStatus.job_status, "unknown");
  process.env.TIPHYS_GEE_PROJECT = "tiphy-test-project";
  process.env.TIPHYS_GEE_TOKEN = "do-not-leak-this-token";
  const configured = await runBrowserTool("gee_auth_status", {});
  assert.equal(configured.connected, false);
  assert.equal(configured.status, "configured_unverified");
  assert.equal(configured.project, "tiphy-test-project");
  assert.equal(configured.hasToken, true);
  assert.equal(configured.hasServiceAccount, false);
  assert.ok(!JSON.stringify(configured).includes("do-not-leak-this-token"));
  assert.equal(geeExecutionAllowed("gee_search_collection", configured), false);
  delete process.env.TIPHYS_GEE_TOKEN;
  process.env.TIPHYS_GEE_SA_PATH = "/tmp/not-read-service-account.json";
  const serviceAccount = await runBrowserTool("gee_auth_status", {});
  assert.equal(serviceAccount.status, "configured_unverified");
  assert.equal(serviceAccount.hasToken, false);
  assert.equal(serviceAccount.hasServiceAccount, true);
  assert.ok(!JSON.stringify(serviceAccount).includes("/tmp/not-read-service-account.json"));
  delete process.env.TIPHYS_GEE_PROJECT;
  delete process.env.TIPHYS_GEE_SA_PATH;
  process.env.TIPHYS_GEE_DEMO = "1";
  try {
    const demoAuth = await runBrowserTool("gee_auth_status", {});
    assert.equal(demoAuth.status, "demo");
    assert.equal(demoAuth.demo, true);
    assert.equal(demoAuth.connected, false);
    assert.equal(geeExecutionAllowed("gee_export_raster", demoAuth), true);
    const demo = await finished("gee_export_raster", { collection: "COPERNICUS/S2_SR_HARMONIZED", band: "B4", path: "demo.tif" });
    assert.equal(demo.demo, true);
    assert.equal(demo.path, "demo.tif");
    assert.match(demo.message, /演示/);
  } finally {
    delete process.env.TIPHYS_GEE_DEMO;
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }

  const formats = await runBrowserTool("list_supported_formats", {});
  assert.ok(formats.vector.some((item: string) => item.includes("GeoPackage")));
  const arcgis = await runBrowserTool("import_arcgis_project", { path: "project.aprx" });
  assert.equal(arcgis.supported, false);
  assert.ok(arcgis.alternatives.length > 0);

  const whitebox = browserCatalog.find(tool => tool.name === "whitebox_extra");
  assert.ok(whitebox);
  assert.equal(whitebox.parameters.required?.[0], "dem");
  assert.ok(browserCatalog.some(t => t.name === "linkage_mapper_corridor"));
});

test("field_statistics reports numeric moments or top values with null counts", async () => {
  const input = (await sample("stats-src"));
  const numeric = await finished("field_statistics", { layer: input.id, field: "id" });
  assert.equal(numeric.count, 5); assert.equal(numeric.null_count, 0);
  assert.ok(numeric.min <= numeric.mean && numeric.mean <= numeric.max);
  const text = await finished("field_statistics", { layer: input.id, field: "name" });
  assert.ok(Array.isArray(text.top_values) && text.top_values.length > 0);
  await assert.rejects(finished("field_statistics", { layer: input.id, field: "missing_field" }), /找不到/);
});


test("catalog union, dedupe, L1 folders and every WASM L2 translation", async () => {
  await ensureBrowserCatalog();
  assert.equal(browserCatalog.length, 997, "34 shell/common tools + 958 WASM schemas + 5 plugin tools");
  assert.equal(new Set(browserCatalog.map(t => t.name)).size, browserCatalog.length);
  const desktop = desktopToolCatalog([{ name: "buffer", category: "邻近分析", parameters: { properties: {} } }]);
  assert.equal(desktop.length, 997, "desktop Python + WASM + shell-only stubs");
  assert.equal(new Set(desktop.map(t => t.name)).size, desktop.length);
  assert.ok(desktop.some(t => t.name === "gee_search_collection"));
  const l1 = new Set(browserCatalog.map(zhToolL1));
  for (const folder of ["矢量", "栅格", "地形", "水文", "遥感", "转换", "投影", "数据管理", "查询", "图层", "GEE"]) {
    assert.ok(l1.has(folder), `${folder} should be an L1 folder`);
  }
  const wasm = browserCatalog.filter(t => t.name.startsWith("wasm_"));
  for (const raw of new Set(wasm.map(t => t.subcategory!).filter(Boolean))) {
    assert.notEqual(zhToolL2({ category: "Raster", subcategory: raw }), raw, `${raw} needs a Chinese L2 label`);
  }
});

test("browser tool search ranks Chinese names and taxonomy, not only descriptions", async () => {
  await ensureBrowserCatalog();
  const weighted = searchBrowserTools(browserCatalog, "加权叠加");
  assert.equal(weighted[0]?.name, "wasm_weighted_overlay");
  const nearest = searchBrowserTools(browserCatalog, "最近设施");
  assert.equal(nearest[0]?.name, "wasm_closest_facility_network");
  const network = searchBrowserTools(browserCatalog, "网络分析", { limit: 12 });
  assert.ok(network.some(t => t.name === "wasm_build_network_topology"));
  assert.ok(network.some(t => t.name === "wasm_closest_facility_network"));
  const rasterOverlay = searchBrowserTools(browserCatalog, "栅格 叠加", { limit: 12 });
  assert.ok(rasterOverlay.some(t => t.name === "wasm_weighted_overlay"));
  for (const [query, expected] of [["网络", "wasm_build_network_topology"], ["最近设施", "wasm_closest_facility_network"], ["加权叠加", "wasm_weighted_overlay"]]) {
    const matches = searchBrowserTools(browserCatalog, query, { limit: 20 });
    assert.ok(matches.some(t => t.name === expected), `${query} should discover ${expected}`);
  }
  for (const [query, expected] of [["走廊", "linkage_mapper_corridor"], ["廊道", "linkage_mapper_corridor"],
    ["水文", "hydrology_flow_pipeline"], ["最小成本", "least_cost_path_pipeline"]]) {
    const matches = searchBrowserTools(browserCatalog, query, { limit: 20 });
    assert.ok(matches.some(t => t.name === expected), `${query} should discover ${expected}`);
  }
  const prompt = buildBrowserSystemPrompt([{ id: "lyr_prompt", name: "道路", kind: "vector" }], {
    aoi: [116.1, 39.1, 116.4, 39.4], selectedLayerId: "lyr_prompt", selectedLayerName: "道路",
    selection: { layerId: "lyr_prompt", featureIds: [7, 9] },
  });
  assert.match(prompt, /116\.1,39\.1,116\.4,39\.4/);
  assert.match(prompt, /lyr_prompt/);
  assert.match(prompt, /当前要素选择.*"feature_ids":\[7,9\]/);
  for (const name of ["linkage_mapper_corridor", "hydrology_flow_pipeline", "least_cost_path_pipeline", "clip_layers_to_aoi"]) assert.match(prompt, new RegExp(name));
});

test("weighted stack schemas expose multi-raster inputs and execute weighted overlay/sum", async () => {
  await ensureBrowserCatalog();
  const overlay = browserCatalog.find(tool => tool.name === "wasm_weighted_overlay")!;
  const sum = browserCatalog.find(tool => tool.name === "wasm_weighted_sum")!;
  assert.equal((overlay.parameters.properties as any).factors.type, "array");
  assert.equal((overlay.parameters.properties as any).factors["x-layer-multiple"], true);
  assert.equal((overlay.parameters.properties as any).weights.type, "string");
  assert.equal((sum.parameters.properties as any).input_rasters.type, "array");
  assert.equal((sum.parameters.properties as any).weights.type, "string");
  const topology = browserCatalog.find(tool => tool.name === "wasm_build_network_topology")!;
  assert.ok(!("nodes_output" in topology.parameters.properties), "optional node output must not be requested as a layer input");

  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const features = [] as any[];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const x = 500000 + col * 100, y = 4400000 + row * 100;
    features.push({ type: "Feature", properties: { a: row + col + 1, b: 10 - row - col },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100], [x, y]]] } });
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "weighted_factors.geojson")).layer;
  const factorA = (await finished("wasm_vector_polygons_to_raster", { input: source.id, field: "a", cell_size: 100, output_name: "factor_a" })).layer;
  const factorB = (await finished("wasm_vector_polygons_to_raster", { input: source.id, field: "b", cell_size: 100, output_name: "factor_b" })).layer;
  const weighted = await finished("wasm_weighted_overlay", {
    factors: [factorA.id, factorB.id], weights: "0.6,0.4", scale_max: 1, output_name: "weighted_result",
  });
  const weightedLayer = weighted.layer ?? weighted.layers?.[0]?.layer;
  assert.equal(weightedLayer.kind, "raster");
  assert.equal(weightedLayer.raster.width, factorA.raster.width);
  const summed = await finished("wasm_weighted_sum", {
    input_rasters: [factorA.id, factorB.id], weights: "1,1", output_name: "weighted_sum_result",
  });
  assert.equal((summed.layer ?? summed.layers?.[0]?.layer).kind, "raster");
});

test("workspace snapshots validate AOI, selection and layer metadata without storing raster bytes", () => {
  const layer = { id: "lyr_test", name: "测试栅格", url: "blob:preview", geometry_types: [], feature_count: 0, bounds: [116, 39, 117, 40], crs: "EPSG:4326", kind: "raster" as const };
  const snapshot = buildWorkspaceSnapshot([layer], {
    selectedLayerId: layer.id, aoi: [116, 39, 116.5, 39.5], selection: { layerId: layer.id, featureIds: [1, 2, 2] }, tableLayerId: null,
  }, 1234);
  assert.equal(snapshot.schema, WORKSPACE_SCHEMA);
  assert.equal(snapshot.version, WORKSPACE_VERSION);
  assert.deepEqual(snapshot.aoi, [116, 39, 116.5, 39.5]);
  assert.deepEqual(snapshot.selection?.featureIds, [1, 2]);
  assert.ok(!("url" in snapshot.layers[0]));
  const restored = normalizeWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored?.selectedLayerId, layer.id);
  assert.equal(restored?.layers[0].kind, "raster");
  assert.equal(normalizeWorkspaceSnapshot({ ...snapshot, version: 2 }), null);
  assert.equal(normalizeWorkspaceSnapshot({ ...snapshot, selectedLayerId: "missing" })?.selectedLayerId, null);
  assert.equal(normalizeWorkspaceSnapshot({ ...snapshot, aoi: [117, 39, 116, 40] })?.aoi, null);
  assert.ok(pipelineResult({ steps: [{ tool: "step", status: "completed" }] }));
  assert.equal(pipelineResult({ ok: true }), null);
});

test("catalog shell is immediately usable and async hydration reaches the honest full count", async () => {
  await ensureBrowserCatalog();
  const state = browserCatalogState();
  assert.ok(state.initial < 900, `shell should not preload the WASM catalog (${state.initial})`);
  assert.equal(state.shell, shellToolCatalog.length);
  assert.ok(shellToolCatalog.some(tool => tool.name === "hydrology_flow_pipeline"));
  assert.ok(shellToolCatalog.some(tool => tool.name === "least_cost_path_pipeline"));
  assert.ok(shellToolCatalog.some(tool => tool.name === "clip_layers_to_aoi"));
  assert.ok(shellToolCatalog.some(tool => tool.name === "gee_auth_status"));
  assert.ok(!shellToolCatalog.some(tool => tool.name.startsWith("wasm_")));
  assert.equal(state.wasm, 958);
  assert.equal(state.total, 997);
  assert.equal(state.hydrated, true);
});

test("WASM warm path parks a healthy worker and release still terminates it", async () => {
  const originalWorker = globalThis.Worker;
  class FakeWorker {
    static instances: FakeWorker[] = [];
    terminated = false;
    private listeners = new Map<string, Set<(event: any) => void>>();
    constructor() { FakeWorker.instances.push(this); }
    addEventListener(type: string, listener: (event: any) => void) {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener); this.listeners.set(type, set);
    }
    removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
    postMessage(message: { type?: string }) {
      if (message.type === "warmup") setTimeout(() => {
        for (const listener of this.listeners.get("message") ?? []) listener({ data: { ok: "warm" } });
      }, 0);
    }
    terminate() { this.terminated = true; }
  }
  (globalThis as typeof globalThis & { Worker: typeof Worker }).Worker = FakeWorker as unknown as typeof Worker;
  try {
    await warmWasmToolRunner();
    assert.equal(FakeWorker.instances.length, 1);
    assert.equal(FakeWorker.instances[0].terminated, false);
    // A second request reuses the parked worker instead of spawning another.
    await warmWasmToolRunner();
    assert.equal(FakeWorker.instances.length, 1);
    releaseIdleWasmToolWorkers();
    assert.equal(FakeWorker.instances[0].terminated, true);
  } finally {
    releaseIdleWasmToolWorkers();
    (globalThis as typeof globalThis & { Worker: typeof Worker }).Worker = originalWorker;
  }
});

test("default symbology stays in the blue family for helper outputs", () => {
  assert.ok(!PALETTE.includes("#0d9488"));
  assert.ok(!PALETTE.includes("#0891b2"));
  for (const name of ["AOI", "生态廊道", "最小成本路径", "水文分析_D8流向"]) {
    assert.match(defaultLayerStyle("lyr_test", name).color, /^#(2563eb|1d4ed8|0284c7|3b82f6|0369a1|4f46e5)$/);
  }
});

test("browser context trims old tool output, then compacts with GIS state and a retrievable archive", async () => {
  const huge = "旧工具输出 ".repeat(7000);
  const messages: ModelMessage[] = [
    { role: "user", content: "先加载数据并检查字段。" },
    { role: "assistant", content: "已检查字段，接下来做网络分析。" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "describe_layer", output: { type: "text", value: huge } }] },
    { role: "user", content: "继续。" },
  ];
  const trimOnly = await compactBrowserMessages(messages, "system", 50000, { layers: [] }, "trim-test", 200);
  assert.equal(trimOnly.trimmed, true);
  assert.equal(trimOnly.compacted, false);
  assert.ok(trimOnly.after < trimOnly.before);
  const trimmedOutput = (trimOnly.messages[2].content as any[])[0].output.value as string;
  assert.match(trimmedOutput, /"spill_id":"[a-f0-9]{32}"/);
  const spillId = JSON.parse(trimmedOutput).spill_id as string;
  const spill = await readBrowserContextRecord("trim-test", spillId, 0, 80);
  assert.equal(spill.kind, "tool-output");
  assert.match(spill.text, /旧工具输出/);

  const workspace = { layers: [{ id: "lyr_1", name: "道路", kind: "vector", crs: "EPSG:4326", feature_count: 12, geometry_types: ["LineString"], bounds: [1, 2, 3, 4] }],
    aoi_bbox: [116.1, 39.1, 116.4, 39.4], selectedLayerId: "lyr_1", selectedLayerName: "道路",
    selection: { layerId: "lyr_1", featureIds: [2, 5] }, outputs: ["/work/path.fgb"], pendingJobs: ["job_demo"] };
  const longSession: ModelMessage[] = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `第 ${index} 轮决策：保留道路图层，检查网络连通性，准备加权叠加。`.repeat(60),
  }));
  longSession.splice(3, 0, { role: "tool", content: [{ type: "tool-result", toolCallId: "call-path", toolName: "least_cost_path_pipeline", output: { type: "text", value: "最小成本路径完成，保留路径图层。" } }] } as ModelMessage);
  const compacted = await compactBrowserMessages(longSession, "system", 12000, workspace, "compact-test", 200);
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.after < estimateBrowserTokens(longSession, "system"));
  const handoff = String((compacted.messages[0] as { content: unknown }).content);
  assert.match(handoff, /GIS workspace state/);
  assert.match(handoff, /道路/);
  assert.match(handoff, /"aoi_bbox":\[116\.1,39\.1,116\.4,39\.4\]/);
  assert.match(handoff, /AOI bbox \(WGS84\): 116\.1,39\.1,116\.4,39\.4/);
  assert.match(handoff, /Selected layer: 道路 \(lyr_1\)/);
  assert.match(handoff, /Selected features: 2 in 道路 \(lyr_1\)/);
  assert.match(handoff, /"selected_features":\{"layer_id":"lyr_1","layer_name":"道路","count":2,"feature_ids":\[2,5\],"truncated":false\}/);
  assert.match(handoff, /least_cost_path_pipeline/);
  assert.match(handoff, /"selected_layer":\{"id":"lyr_1","name":"道路"\}/);
  const archiveId = /read_browser_output with id=([a-f0-9]{32})/.exec(handoff)?.[1];
  assert.ok(archiveId);
  const archive = await readBrowserContextRecord("compact-test", archiveId, 0, 120);
  assert.equal(archive.kind, "message-archive");
  assert.match(archive.text, /轮决策/);
});
