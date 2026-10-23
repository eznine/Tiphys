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
import { desktopToolCatalog } from "../src/lib/browser/catalog-schema.ts";
import { zhToolL1, zhToolL2 } from "../src/lib/i18n/tools.ts";

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

test("metric admission rejects unsuitable extents; WASM catalog contains real parameter contracts", () => {
  assert.throws(() => metricCrs({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [[0,0],[120,0]] } }] }), /范围/);
  assert.ok(browserCatalog.some(t => t.name === "wasm_centroid_vector"));
  assert.ok(browserCatalog.filter(t => t.name.startsWith("wasm_")).every(t => (t.parameters as any).additionalProperties === false));
});

test("widened catalog exposes the vector, raster and table toolbox", () => {
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

test("GEE slice, ArcGIS adapters and plugin stubs return honest structured results", async () => {
  const auth = await runBrowserTool("gee_auth_status", {});
  assert.equal(auth.connected, false);
  assert.equal(auth.status, "not_connected");
  const search = await runBrowserTool("gee_search_collection", { collection: "COPERNICUS/S2_SR_HARMONIZED" });
  assert.deepEqual(search.items, []);
  assert.ok(search.hint);
  const exported = await finished("gee_export_raster", { collection: "COPERNICUS/S2_SR_HARMONIZED", band: "B4", path: "demo.tif" });
  assert.equal(exported.connected, false);
  assert.equal(exported.path ?? exported.requested_path, "demo.tif");
  const geeStatus = await runBrowserTool("gee_job_status", { job_id: "missing" });
  assert.equal(geeStatus.job_status, "unknown");
  process.env.TIPHYS_GEE_DEMO = "1";
  try {
    const demo = await finished("gee_export_raster", { collection: "COPERNICUS/S2_SR_HARMONIZED", band: "B4", path: "demo.tif" });
    assert.equal(demo.demo, true);
    assert.equal(demo.path, "demo.tif");
    assert.match(demo.message, /演示/);
  } finally {
    delete process.env.TIPHYS_GEE_DEMO;
  }

  const formats = await runBrowserTool("list_supported_formats", {});
  assert.ok(formats.vector.some((item: string) => item.includes("GeoPackage")));
  const arcgis = await runBrowserTool("import_arcgis_project", { path: "project.aprx" });
  assert.equal(arcgis.supported, false);
  assert.ok(arcgis.alternatives.length > 0);

  const input = await sample("plugin");
  const corridor = await finished("linkage_mapper_corridor", { layer: input.id });
  assert.equal(corridor.available, false);
  assert.equal(corridor.plugin, "linkage-mapper");
  const whitebox = await finished("whitebox_extra", {});
  assert.equal(whitebox.available, false);
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


test("catalog union, dedupe, L1 folders and every WASM L2 translation", () => {
  assert.equal(browserCatalog.length, 994, "34 shell/common tools + 958 WASM schemas + 2 plugin stubs");
  assert.equal(new Set(browserCatalog.map(t => t.name)).size, browserCatalog.length);
  const desktop = desktopToolCatalog([{ name: "buffer", category: "邻近分析", parameters: { properties: {} } }]);
  assert.equal(desktop.length, 994, "desktop Python + WASM + shell-only stubs");
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
