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
import { AGENT_GOAL_LIMIT, buildAgentSessionStub, buildWorkspaceSnapshot, normalizeWorkspaceRecovery, normalizeWorkspaceSnapshot, WORKSPACE_SCHEMA, WORKSPACE_VERSION } from "../src/lib/workspace.ts";
import { selectedFeaturesGeoJson, selectedGeoJsonFilename, tableExportFilename, tablePageCsv } from "../src/lib/table-export.ts";
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
  const geojson = await (await browserEngineRequest(`/layers/${input.id}.geojson`)).json();
  assert.equal(geojson.type, "FeatureCollection"); assert.equal(geojson.features.length, 5);
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

test("attribute table page export is scoped to visible rows and escapes spreadsheet formulas", () => {
  const csv = tablePageCsv({
    fields: [{ name: "name" }, { name: "formula" }],
    rows: [{ id: 2, attributes: { name: "天安门, 北京", formula: "=SUM(1,2)" } },
      { id: 3, attributes: { name: "钟楼", formula: null } }],
  });
  assert.equal(csv.split("\r\n")[0], "记录,name,formula");
  assert.match(csv, /3,"天安门, 北京","'=SUM\(1,2\)"/);
  assert.match(csv, /\r\n4,钟楼,$/);
  assert.equal(tableExportFilename("道路/网络:测试"), "道路_网络_测试_本页.csv");
});

test("selected-feature GeoJSON keeps real geometry and drops stale collection bounds", () => {
  const source = { type: "FeatureCollection" as const, name: "roads", bbox: [0, 0, 10, 10],
    crs: { type: "name", properties: { name: "EPSG:4326" } },
    features: [
      { type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [1, 2] } },
      { type: "Feature", properties: { id: 2 }, geometry: { type: "LineString", coordinates: [[1, 2], [3, 4]] } },
      { type: "Feature", properties: { id: 3 }, geometry: { type: "Point", coordinates: [5, 6] } },
    ] };
  const selected = selectedFeaturesGeoJson(source, [0, 2]);
  assert.deepEqual(selected.features.map((feature: any) => feature.properties.id), [1, 3]);
  assert.deepEqual((selected.features[0] as any).geometry, { type: "Point", coordinates: [1, 2] });
  assert.equal("bbox" in selected, false);
  assert.deepEqual(selected.crs, source.crs);
  assert.equal(selectedGeoJsonFilename("道路/网络:测试"), "道路_网络_测试_已选.geojson");
  assert.throws(() => selectedFeaturesGeoJson(source, [9]), /没有可导出/);
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
  for (const name of ["wasm_reproject_raster", "wasm_hillshade", "wasm_zonal_statistics", "wasm_vector_points_to_raster",
    "wasm_vector_polygons_to_raster", "wasm_raster_to_vector_polygons", "wasm_raster_to_vector_lines",
    "wasm_raster_to_vector_points", "wasm_idw_interpolation", "wasm_tin_interpolation", "wasm_buffer_raster",
    "wasm_merge_vectors", "wasm_smooth_vectors"]) {
    assert.ok(native.some(t => t.name === name), `${name} should be exposed`);
  }
  const rasterInput = native.find(t => t.name === "wasm_hillshade")!;
  assert.equal((rasterInput.parameters as any).properties.input["x-layer-kind"], "raster");
});

test("ribbon quick actions resolve to real catalog tools", async () => {
  await ensureBrowserCatalog();
  const source = fs.readFileSync(new URL("../src/components/CommandRibbon.tsx", import.meta.url), "utf8");
  const names = [...source.matchAll(/props\.onTool\("(wasm_[^"]+)"\)/g)].map(match => match[1]);
  assert.ok(names.length >= 60, `expected a dense ribbon, got ${names.length} WASM actions`);
  assert.equal(new Set(names).size, names.length, "ribbon must not expose duplicate WASM actions");
  for (const name of names) assert.ok(browserCatalog.some(tool => tool.name === name), `${name} must resolve to a catalog tool`);
  for (const name of ["wasm_panchromatic_sharpening", "wasm_resample", "wasm_segment_slic_superpixels",
    "wasm_spectral_angle_mapper", "wasm_viewshed", "wasm_visibility_index", "wasm_sky_view_factor",
    "wasm_contours_from_raster", "wasm_create_colour_composite", "wasm_cost_distance", "wasm_cost_pathway",
    "wasm_euclidean_distance", "wasm_extract_raster_values_at_points", "wasm_deviation_from_mean_elevation",
    "wasm_sobel_filter", "wasm_mosaic", "wasm_raster_to_vector_polygons", "wasm_raster_to_vector_lines",
    "wasm_raster_to_vector_points", "wasm_vector_points_to_raster", "wasm_vector_polygons_to_raster",
    "wasm_idw_interpolation", "wasm_tin_interpolation", "wasm_buffer_raster", "wasm_merge_vectors",
    "wasm_smooth_vectors", "wasm_network_service_area", "wasm_generate_near_table",
    "wasm_majority_filter", "wasm_boundary_clean", "wasm_snap_points_to_network",
    "wasm_split_lines_at_intersections", "wasm_line_density", "wasm_euclidean_allocation",
    "wasm_cost_allocation", "wasm_median_filter", "wasm_centroid_vector",
    "wasm_densify_features", "wasm_concave_hull", "wasm_feature_to_line",
    "wasm_expand_shrink", "wasm_clump", "wasm_sieve", "wasm_empirical_bayesian_kriging",
    "wasm_basins", "wasm_snap_pour_points", "wasm_feature_vertices_to_points",
    "wasm_aggregate_polygons", "wasm_opening", "wasm_closing", "wasm_percentile_filter",
    "wasm_nibble", "wasm_multipart_to_singlepart", "wasm_eliminate_polygon_part",
    "wasm_aggregate_points", "wasm_symmetrical_difference", "wasm_difference", "wasm_identity",
    "wasm_buffer_vector", "wasm_minimum_bounding_circle", "wasm_bilateral_filter",
    "wasm_ordinary_kriging", "wasm_trend_surface", "wasm_ruggedness_index",
    "wasm_strahler_stream_order", "wasm_hack_stream_order", "wasm_cost_connectivity",
    "wasm_gaussian_filter", "wasm_edge_preserving_mean_filter", "wasm_points_to_line",
    "wasm_minimum_bounding_box", "wasm_relative_topographic_position", "wasm_mean_filter",
    "wasm_laplacian_filter", "wasm_euclidean_direction", "wasm_update", "wasm_vector_lines_to_raster",
    "wasm_simple_kriging", "wasm_wetness_index", "wasm_change_vector_analysis",
    "wasm_near", "wasm_extend_vector_lines", "wasm_split_vector_lines", "wasm_find_identical",
    "wasm_integrate", "wasm_median_center", "wasm_lee_filter", "wasm_downslope_index",
    "wasm_central_feature", "wasm_directional_distribution", "wasm_corridor", "wasm_path_distance",
    "wasm_prewitt_filter", "wasm_conservative_smoothing_filter", "wasm_extract_valleys", "wasm_local_kriging",
    "wasm_frost_filter", "wasm_fast_almost_gaussian_filter", "wasm_circular_variance_of_aspect",
    "wasm_average_flowpath_slope", "wasm_cut_fill", "wasm_is_nodata", "wasm_focal_statistics",
    "wasm_k_means_clustering", "wasm_balance_contrast_enhancement", "wasm_histogram_equalization",
    "wasm_min_max_contrast_stretch", "wasm_horton_stream_order", "wasm_shreve_stream_magnitude",
    "wasm_contour_list", "wasm_contours_from_points", "wasm_pennock_landform_classification"]) {
    assert.ok(names.includes(name), `${name} should be exposed in the ribbon`);
  }
  const dock = fs.readFileSync(new URL("../src/components/ChatDock.tsx", import.meta.url), "utf8");
  const recipeTools = [...dock.matchAll(/tool: "(wasm_[^"]+)"/g)].map(match => match[1]);
  for (const name of ["wasm_network_service_area", "wasm_buffer_raster", "wasm_contours_from_raster",
    "wasm_cost_distance", "wasm_raster_to_vector_polygons", "wasm_idw_interpolation",
    "wasm_line_density", "wasm_concave_hull", "wasm_empirical_bayesian_kriging", "wasm_basins",
    "wasm_opening", "wasm_symmetrical_difference", "wasm_difference", "wasm_ruggedness_index",
    "wasm_strahler_stream_order", "wasm_cost_connectivity", "wasm_mean_filter",
    "wasm_change_vector_analysis", "wasm_near", "wasm_extend_vector_lines",
    "wasm_central_feature", "wasm_directional_distribution", "wasm_frost_filter", "wasm_cut_fill",
    "wasm_balance_contrast_enhancement", "wasm_contours_from_points"]) {
    assert.ok(recipeTools.includes(name), `${name} should be available as an agent recipe`);
    assert.ok(browserCatalog.some(tool => tool.name === name), `${name} recipe must resolve to a catalog tool`);
  }
});

test("network and raster ribbon forms expose honest, executable contracts", async () => {
  await ensureBrowserCatalog();
  const service = browserCatalog.find(tool => tool.name === "wasm_network_service_area")!;
  const serviceProps = service.parameters.properties as any;
  assert.equal(serviceProps.output_mode.type, "string", "service-area mode is an enum, not an output path");
  assert.deepEqual(serviceProps.output_mode.enum, ["nodes", "edges", "polygons"]);
  assert.equal(serviceProps.output_mode.default, "nodes");
  assert.equal(serviceProps.ring_costs.type, "string", "multi-ring thresholds accept comma-separated values");
  assert.equal(serviceProps.max_cost.type, "string");
  assert.ok(!("output" in serviceProps), "service-area output path must stay internal");
  const near = browserCatalog.find(tool => tool.name === "wasm_generate_near_table")!;
  assert.equal((near.parameters.properties as any).input["x-layer-kind"], "vector");
  assert.equal((near.parameters.properties as any).near_features["x-layer-kind"], "vector");
  assert.ok(!("output" in near.parameters.properties), "near-table output path must stay internal");
  for (const name of ["wasm_majority_filter", "wasm_median_filter", "wasm_percentile_filter", "wasm_boundary_clean"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
});

test("geometry, density and allocation ribbon forms expose executable contracts", async () => {
  await ensureBrowserCatalog();
  const lineDensity = browserCatalog.find(tool => tool.name === "wasm_line_density")!;
  assert.equal((lineDensity.parameters.properties as any).input["x-layer-kind"], "vector");
  assert.deepEqual((lineDensity.parameters.properties as any).area_units.enum,
    ["square_map_units", "square_meters", "square_kilometers", "square_miles", "square_feet"]);
  assert.ok(!("output" in lineDensity.parameters.properties), "line-density output path must stay internal");
  for (const name of ["wasm_centroid_vector", "wasm_densify_features", "wasm_concave_hull", "wasm_feature_to_line"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.equal((tool.parameters.properties as any).input["x-layer-kind"], "vector", `${name} input must be a vector layer`);
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  for (const name of ["wasm_euclidean_allocation", "wasm_cost_allocation"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  const costAllocation = browserCatalog.find(tool => tool.name === "wasm_cost_allocation")!;
  assert.equal((costAllocation.parameters.properties as any).source["x-layer-kind"], "raster");
  assert.equal((costAllocation.parameters.properties as any).backlink["x-layer-kind"], "raster");
  assert.equal((browserCatalog.find(tool => tool.name === "wasm_median_filter")!.parameters.properties as any).input["x-layer-kind"], "raster");
});

test("morphology, EBK and hydro ribbon forms hide output paths and expose honest fields", async () => {
  await ensureBrowserCatalog();
  for (const name of ["wasm_expand_shrink", "wasm_clump", "wasm_sieve"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.equal((tool.parameters.properties as any).input["x-layer-kind"], "raster", `${name} input must be raster`);
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  const sieve = browserCatalog.find(tool => tool.name === "wasm_sieve")!;
  assert.equal((sieve.parameters.properties as any).zero_background.type, "boolean");

  const ebk = browserCatalog.find(tool => tool.name === "wasm_empirical_bayesian_kriging")!;
  const ebkProps = ebk.parameters.properties as any;
  assert.equal(ebkProps.input["x-layer-kind"], "vector");
  assert.equal(ebkProps.cell_size.type, "number", "EBK cell_size must be numeric");
  assert.equal(ebkProps.subset_size.type, "integer");
  assert.equal(ebkProps.simulations.type, "integer");
  assert.ok(!("output" in ebkProps) && !("error_output" in ebkProps), "EBK dual raster outputs must stay internal");

  for (const name of ["wasm_basins", "wasm_snap_pour_points"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  assert.equal((browserCatalog.find(tool => tool.name === "wasm_basins")!.parameters.properties as any).d8_pntr["x-layer-kind"], "raster");
  const snap = browserCatalog.find(tool => tool.name === "wasm_snap_pour_points")!.parameters.properties as any;
  assert.equal(snap.flow_accum["x-layer-kind"], "raster");
  assert.equal(snap.pour_pts["x-layer-kind"], "vector");

  for (const name of ["wasm_feature_vertices_to_points", "wasm_aggregate_polygons"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.equal((tool.parameters.properties as any).input["x-layer-kind"], "vector", `${name} input must be vector`);
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  for (const name of ["wasm_opening", "wasm_closing"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
});

test("filter, cleanup and overlay ribbon forms expose honest executable contracts", async () => {
  await ensureBrowserCatalog();
  for (const name of ["wasm_opening", "wasm_closing", "wasm_percentile_filter", "wasm_nibble"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.equal((tool.parameters.properties as any).input["x-layer-kind"], "raster", `${name} input must be raster`);
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  for (const name of ["wasm_opening", "wasm_closing", "wasm_percentile_filter"]) {
    const props = browserCatalog.find(item => item.name === name)!.parameters.properties as any;
    assert.equal(props.filter_size_x.type, "integer", `${name} window width must be an integer`);
    assert.equal(props.filter_size_y.type, "integer", `${name} window height must be an integer`);
  }
  const nibble = browserCatalog.find(item => item.name === "wasm_nibble")!.parameters.properties as any;
  assert.equal(nibble.mask["x-layer-kind"], "raster");
  assert.equal(nibble.use_nodata.type, "boolean");
  assert.equal(nibble.nibble_nodata.type, "boolean");

  for (const name of ["wasm_multipart_to_singlepart", "wasm_eliminate_polygon_part", "wasm_aggregate_points", "wasm_symmetrical_difference"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.equal((tool.parameters.properties as any).input["x-layer-kind"], "vector", `${name} input must be vector`);
    assert.ok(!("output" in tool.parameters.properties), `${name} output path must stay internal`);
  }
  const eliminate = browserCatalog.find(item => item.name === "wasm_eliminate_polygon_part")!.parameters.properties as any;
  assert.deepEqual(eliminate.condition.enum, ["AREA", "PERCENT"]);
  assert.deepEqual(eliminate.part_option.enum, ["CONTAINED_ONLY", "ANY"]);
  const points = browserCatalog.find(item => item.name === "wasm_aggregate_points")!.parameters.properties as any;
  assert.deepEqual(points.method.enum, ["convex_hull", "buffer"]);
  assert.equal(points.method.default, "convex_hull");
  assert.equal(points.min_points.type, "integer");
  assert.equal((browserCatalog.find(item => item.name === "wasm_symmetrical_difference")!.parameters.properties as any).overlay["x-layer-kind"], "vector");

  const ordinary = browserCatalog.find(item => item.name === "wasm_ordinary_kriging")!.parameters.properties as any;
  assert.equal(ordinary.cell_size.type, "number", "ordinary kriging cell size must be numeric");
  assert.equal(ordinary.value_field.type, "string", "ordinary kriging value field must be a field picker");
  assert.ok(!("output" in ordinary), "ordinary kriging output path must stay internal");
});

test("new raster ribbon forms expose executable multi-input contracts", async () => {
  await ensureBrowserCatalog();
  const pathway = browserCatalog.find(tool => tool.name === "wasm_cost_pathway")!;
  assert.equal((pathway.parameters.properties as any).destination["x-layer-kind"], "raster");
  assert.ok(pathway.parameters.required?.includes("destination"));
  const mosaic = browserCatalog.find(tool => tool.name === "wasm_mosaic")!;
  assert.equal((mosaic.parameters.properties as any).inputs.type, "array");
  assert.equal((mosaic.parameters.properties as any).inputs["x-layer-multiple"], true);
  const extract = browserCatalog.find(tool => tool.name === "wasm_extract_raster_values_at_points")!;
  assert.equal((extract.parameters.properties as any).rasters.type, "array");
  assert.equal((extract.parameters.properties as any).rasters["x-layer-kind"], "raster");
  for (const name of ["wasm_idw_interpolation", "wasm_tin_interpolation"]) {
    const interpolation = browserCatalog.find(tool => tool.name === name)!;
    assert.equal((interpolation.parameters.properties as any).cell_size.type, "number", `${name} cell_size must be numeric`);
    assert.equal((interpolation.parameters.properties as any).points["x-layer-kind"], "vector");
  }
  const merge = browserCatalog.find(tool => tool.name === "wasm_merge_vectors")!;
  assert.equal((merge.parameters.properties as any).inputs.type, "array");
  assert.equal((merge.parameters.properties as any).inputs["x-layer-multiple"], true);
});

test("overlay, geometry, filter and terrain ribbon forms expose honest contracts", async () => {
  await ensureBrowserCatalog();
  for (const name of ["wasm_difference", "wasm_identity"]) {
    const props = browserCatalog.find(tool => tool.name === name)!.parameters.properties as any;
    assert.equal(props.input["x-layer-kind"], "vector", `${name} input must be vector`);
    assert.equal(props.overlay["x-layer-kind"], "vector", `${name} overlay must be vector`);
    assert.equal(props.snap_tolerance.type, "number", `${name} snap tolerance must be numeric`);
    assert.ok(!("output" in props), `${name} output path must stay internal`);
  }
  const buffer = browserCatalog.find(tool => tool.name === "wasm_buffer_vector")!.parameters.properties as any;
  assert.equal(buffer.input["x-layer-kind"], "vector");
  assert.equal(buffer.distance.type, "number");
  assert.deepEqual(buffer.cap_style.enum, ["round", "flat", "square"]);
  assert.deepEqual(buffer.join_style.enum, ["round", "bevel", "mitre"]);
  assert.equal(buffer.dissolve.type, "boolean");
  assert.ok(!("output" in buffer), "advanced buffer output path must stay internal");

  const circle = browserCatalog.find(tool => tool.name === "wasm_minimum_bounding_circle")!;
  assert.equal((circle.parameters.properties as any).input["x-layer-kind"], "vector");
  assert.equal((circle.parameters.properties as any).individual_feature_hulls.type, "boolean");
  assert.ok(!("output" in circle.parameters.properties), "minimum bounding circle output path must stay internal");

  const bilateral = browserCatalog.find(tool => tool.name === "wasm_bilateral_filter")!.parameters.properties as any;
  assert.equal(bilateral.input["x-layer-kind"], "raster");
  assert.equal(bilateral.sigma_dist.type, "number");
  assert.equal(bilateral.sigma_int.type, "number", "sigma_int is an intensity scalar, not a raster");
  assert.equal(bilateral.treat_as_rgb.type, "boolean", "treat_as_rgb is a boolean, not a raster");
  assert.ok(!("output" in bilateral), "bilateral filter output path must stay internal");

  const trend = browserCatalog.find(tool => tool.name === "wasm_trend_surface")!.parameters.properties as any;
  assert.equal(trend.input["x-layer-kind"], "raster");
  assert.equal(trend.polynomial_order.type, "number");
  assert.ok(!("output" in trend), "trend surface output path must stay internal");
  const ruggedness = browserCatalog.find(tool => tool.name === "wasm_ruggedness_index")!.parameters.properties as any;
  assert.equal(ruggedness.input["x-layer-kind"], "raster");
  assert.ok(!("output" in ruggedness), "ruggedness output path must stay internal");
  for (const name of ["wasm_gaussian_filter", "wasm_mean_filter", "wasm_laplacian_filter",
    "wasm_edge_preserving_mean_filter", "wasm_wetness_index"]) {
    const tool = browserCatalog.find(item => item.name === name)!;
    assert.ok(!("output" in tool.parameters.properties), `${name} file output must stay internal`);
  }
});

test("hydro-order, smoothing, geometry and cost-connectivity forms expose honest contracts", async () => {
  await ensureBrowserCatalog();
  for (const name of ["wasm_strahler_stream_order", "wasm_hack_stream_order"]) {
    const props = browserCatalog.find(tool => tool.name === name)!.parameters.properties as any;
    assert.equal(props.d8_pntr["x-layer-kind"], "raster", `${name} needs a D8 pointer raster`);
    assert.equal(props.streams["x-layer-kind"], "raster", `${name} needs a stream raster`);
    assert.equal(props.esri_pntr.type, "boolean");
    assert.equal(props.zero_background.type, "boolean");
    assert.ok(!("output" in props), `${name} output path must stay internal`);
  }

  const cost = browserCatalog.find(tool => tool.name === "wasm_cost_connectivity")!.parameters.properties as any;
  assert.equal(cost.sources["x-layer-kind"], "vector");
  assert.equal(cost.cost["x-layer-kind"], "raster");
  assert.deepEqual(cost.connections.enum, ["mst", "all_neighbors"]);
  assert.ok(!("output" in cost), "cost-connectivity output path must stay internal");

  const gaussian = browserCatalog.find(tool => tool.name === "wasm_gaussian_filter")!.parameters.properties as any;
  assert.equal(gaussian.input["x-layer-kind"], "raster");
  assert.equal(gaussian.sigma.type, "number");
  assert.equal(gaussian.treat_as_rgb.type, "boolean", "Gaussian RGB mode is a boolean, not a raster");
  assert.ok(!("output" in gaussian), "Gaussian filter file output must stay internal");

  const edge = browserCatalog.find(tool => tool.name === "wasm_edge_preserving_mean_filter")!.parameters.properties as any;
  assert.equal(edge.input["x-layer-kind"], "raster");
  assert.equal(edge.filter_size.type, "integer");
  assert.equal(edge.threshold.type, "number");
  assert.ok(!("output" in edge), "edge-preserving filter file output must stay internal");

  const pointsToLine = browserCatalog.find(tool => tool.name === "wasm_points_to_line")!.parameters.properties as any;
  assert.equal(pointsToLine.input["x-layer-kind"], "vector");
  assert.equal(pointsToLine.close_line.type, "boolean");
  assert.ok(!("output" in pointsToLine), "points-to-line output path must stay internal");

  const bbox = browserCatalog.find(tool => tool.name === "wasm_minimum_bounding_box")!.parameters.properties as any;
  assert.equal(bbox.input["x-layer-kind"], "vector");
  assert.deepEqual(bbox.min_criteria.enum, ["area", "perimeter", "length", "width"]);
  assert.equal(bbox.individual_feature_hulls.type, "boolean");
  assert.ok(!("output" in bbox), "minimum-bounding-box output path must stay internal");

  const rtp = browserCatalog.find(tool => tool.name === "wasm_relative_topographic_position")!.parameters.properties as any;
  assert.equal(rtp.input["x-layer-kind"], "raster");
  assert.equal(rtp.filter_size_x.type, "integer");
  assert.equal(rtp.filter_size_y.type, "integer");
  assert.ok(!("output" in rtp), "relative-topographic-position output path must stay internal");
});

test("filter, distance, vector, interpolation and RS ribbon forms expose honest contracts", async () => {
  await ensureBrowserCatalog();
  const props = (name: string) => browserCatalog.find(tool => tool.name === name)!.parameters.properties as any;

  const mean = props("wasm_mean_filter");
  assert.equal(mean.input["x-layer-kind"], "raster");
  assert.equal(mean.filter_size_x.type, "integer");
  assert.equal(mean.filter_size_y.type, "integer");
  assert.ok(!("output" in mean), "mean filter file output must stay internal");

  const laplacian = props("wasm_laplacian_filter");
  assert.equal(laplacian.input["x-layer-kind"], "raster");
  assert.deepEqual(laplacian.variant.enum, ["3x3(1)", "3x3(2)", "3x3(3)", "3x3(4)", "5x5(1)", "5x5(2)"]);
  assert.equal(laplacian.clip_amount.type, "number");
  assert.ok(!("output" in laplacian), "Laplacian output path must stay internal");

  const direction = props("wasm_euclidean_direction");
  assert.equal(direction.input["x-layer-kind"], "raster");
  assert.equal(direction.barriers["x-layer-kind"], "raster");
  for (const name of ["output", "output_distance", "output_back_direction"]) assert.ok(!(name in direction), `${name} must stay internal`);

  const update = props("wasm_update");
  assert.equal(update.input["x-layer-kind"], "vector");
  assert.equal(update.overlay["x-layer-kind"], "vector");
  assert.ok(!("output" in update), "update overlay output path must stay internal");
  const near = props("wasm_near");
  assert.equal(near.input["x-layer-kind"], "vector");
  assert.equal(near.near["x-layer-kind"], "vector");

  const lines = props("wasm_vector_lines_to_raster");
  assert.equal(lines.input["x-layer-kind"], "vector");
  assert.equal(lines.cell_size.type, "number");
  assert.equal(lines.field.type, "string");
  assert.ok(!("output" in lines), "line-to-raster output path must stay internal");

  const simple = props("wasm_simple_kriging");
  assert.equal(simple.points["x-layer-kind"], "vector");
  assert.equal(simple.value_field.type, "string");
  assert.equal(simple.known_mean.type, "number", "simple kriging mean is a numeric scalar");
  assert.equal(simple.cell_size.type, "number", "simple kriging cell size is a numeric scalar");
  assert.ok(!("output" in simple), "simple kriging output path must stay internal");
  assert.equal(props("wasm_local_kriging").cell_size.type, "number", "local kriging cell size is a numeric scalar");

  assert.equal(props("wasm_extend_vector_lines").distance.type, "number", "line extension distance is numeric, not a vector layer");
  assert.equal(props("wasm_split_vector_lines").segment_length.type, "number", "line split length is numeric, not text");

  const wetness = props("wasm_wetness_index");
  assert.equal(wetness.sca["x-layer-kind"], "raster");
  assert.equal(wetness.slope["x-layer-kind"], "raster");
  assert.ok(!("output" in wetness), "wetness output path must stay internal");
  assert.deepEqual(props("wasm_downslope_index").output_type.enum, ["tangent", "degrees", "radians", "distance"]);

  const change = props("wasm_change_vector_analysis");
  for (const name of ["date1", "date2"]) {
    assert.equal(change[name].type, "array", `${name} must expose an ordered raster list`);
    assert.equal(change[name]["x-layer-kind"], "raster");
    assert.equal(change[name]["x-layer-multiple"], true);
  }
  assert.ok(!("magnitude_output" in change) && !("direction_output" in change), "CVA outputs must stay internal");
});

test("vector QA, statistics, Lee filter and downslope forms expose honest contracts", async () => {
  await ensureBrowserCatalog();
  const props = (name: string) => browserCatalog.find(tool => tool.name === name)!.parameters.properties as any;

  for (const name of ["wasm_near", "wasm_extend_vector_lines", "wasm_split_vector_lines",
    "wasm_find_identical", "wasm_integrate", "wasm_median_center"]) {
    const form = props(name);
    assert.equal(form.input["x-layer-kind"], "vector", `${name} input must be vector`);
    assert.ok(!("output" in form), `${name} output path must stay internal`);
  }
  assert.equal(props("wasm_near").near["x-layer-kind"], "vector");
  assert.equal(props("wasm_near").max_distance.type, "number");
  assert.equal(props("wasm_extend_vector_lines").distance.type, "number");
  assert.deepEqual(props("wasm_extend_vector_lines").extend_direction.enum, ["both", "start", "end"]);
  assert.equal(props("wasm_split_vector_lines").segment_length.type, "number");
  const identical = props("wasm_find_identical");
  assert.deepEqual(identical.mode.enum, ["report", "delete"]);
  assert.equal(identical.mode.default, "report");
  assert.equal(identical.compare_geometry.type, "boolean");
  assert.equal(identical.compare_geometry.default, true, "duplicate comparison includes geometry by default");
  assert.equal(identical.xy_tolerance.type, "number");
  const integrate = props("wasm_integrate");
  assert.equal(integrate.tolerance.type, "number");
  assert.equal(integrate.snap_to_edges.default, true, "integrate snaps T-junctions by default");
  assert.equal(props("wasm_median_center").weight_field.type, "string");

  const lee = props("wasm_lee_filter");
  assert.equal(lee.input["x-layer-kind"], "raster");
  assert.equal(lee.filter_size_x.type, "integer");
  assert.equal(lee.filter_size_y.type, "integer");
  assert.ok(!("output" in lee), "Lee filter output path must stay internal");
  const downslope = props("wasm_downslope_index");
  assert.equal(downslope.input["x-layer-kind"], "raster");
  assert.equal(downslope.vertical_drop.type, "number");
  assert.deepEqual(downslope.output_type.enum, ["tangent", "degrees", "radians", "distance"]);
  assert.ok(!("output" in downslope), "downslope output path must stay internal");

  const backLink = props("wasm_cost_back_link");
  assert.equal(backLink.source["x-layer"], true);
  assert.equal(backLink.source["x-layer-kind"], "any", "back-link source must accept a raster or vector layer");
  assert.equal(backLink.cost["x-layer-kind"], "raster");
  assert.ok(!("output" in backLink) && !("out_distance" in backLink), "back-link outputs must stay internal");
});

test("batch20 statistics, corridor, filter and interpolation forms expose honest contracts", async () => {
  await ensureBrowserCatalog();
  const props = (name: string) => browserCatalog.find(tool => tool.name === name)!.parameters.properties as any;
  const required = (name: string) => browserCatalog.find(tool => tool.name === name)!.parameters.required ?? [];

  const central = props("wasm_central_feature");
  assert.equal(central.input["x-layer-kind"], "vector");
  assert.deepEqual(central.statistic.enum, ["central_feature", "linear_directional_mean"]);
  assert.equal(central.statistic.default, "central_feature");
  assert.equal(central.distance.default, "euclidean");
  assert.equal(central.orientation_only.type, "boolean");
  assert.ok(!("output" in central), "central-feature output path must stay internal");

  const directional = props("wasm_directional_distribution");
  assert.equal(directional.input["x-layer-kind"], "vector");
  assert.equal(directional.statistic.type, "string");
  assert.equal(directional.statistic.default, "standard_deviational_ellipse");
  assert.ok(directional.statistic.enum.includes("standard_deviational_ellipse"));
  assert.equal(directional.n_std.type, "integer");
  assert.ok(required("wasm_directional_distribution").includes("statistic"), "direction statistic must be required");
  assert.ok(!("output" in directional), "directional-distribution output path must stay internal");

  const corridor = props("wasm_corridor");
  for (const name of ["cost1", "cost2", "cost", "source1", "source2"])
    assert.equal(corridor[name]["x-layer-kind"], "raster", `${name} must be a raster`);
  assert.equal(corridor.threshold.type, "number");
  assert.equal(corridor.percent.type, "number");
  assert.ok(!("output" in corridor), "corridor output path must stay internal");

  const path = props("wasm_path_distance");
  assert.equal(path.source["x-layer-kind"], "raster", "path-distance source must be an honest raster input");
  assert.equal(path.surface["x-layer-kind"], "raster");
  assert.deepEqual(path.vertical_factor.enum, ["tobler", "linear", "sym_linear", "inverse_linear", "binary"]);
  assert.equal(path.vertical_factor.default, "tobler");
  assert.equal(path.slope_factor.type, "number");
  assert.equal(path.band.type, "integer");
  assert.ok(!("output" in path), "path-distance output path must stay internal");

  for (const name of ["wasm_prewitt_filter", "wasm_conservative_smoothing_filter"]) {
    const filter = props(name);
    assert.equal(filter.input["x-layer-kind"], "raster", `${name} input must be raster`);
    assert.ok(!("output" in filter), `${name} output path must stay internal`);
  }
  assert.equal(props("wasm_prewitt_filter").clip_tails.type, "number");
  assert.equal(props("wasm_conservative_smoothing_filter").filter_size_x.type, "integer");
  assert.equal(props("wasm_conservative_smoothing_filter").filter_size_y.type, "integer");

  const kriging = props("wasm_local_kriging");
  assert.equal(kriging.points["x-layer-kind"], "vector");
  assert.equal(kriging.cell_size.type, "number");
  assert.equal(kriging.k_neighbors.type, "integer");
  assert.ok(!("output" in kriging), "local-kriging output path must stay internal");

  const valleys = props("wasm_extract_valleys");
  assert.equal(valleys.dem["x-layer-kind"], "raster");
  assert.ok(required("wasm_extract_valleys").includes("dem"), "valley extraction must require a DEM");
  assert.deepEqual(valleys.variant.enum, ["lq", "jandr", "pandd"]);
  assert.equal(valleys.line_thin.type, "boolean");
  assert.ok(!("output" in valleys), "valley output path must stay internal");
});

test("Chinese GIS aliases rank conversion, interpolation and service-area tools", async () => {
  await ensureBrowserCatalog();
  const rasterToVector = searchBrowserTools(browserCatalog, "栅格转矢量", { limit: 6 }).map(tool => tool.name);
  for (const name of ["wasm_raster_to_vector_polygons", "wasm_raster_to_vector_lines", "wasm_raster_to_vector_points"])
    assert.ok(rasterToVector.includes(name), `${name} should rank for 栅格转矢量`);
  assert.equal(searchBrowserTools(browserCatalog, "IDW", { limit: 3 })[0]?.name, "wasm_idw_interpolation");
  assert.equal(searchBrowserTools(browserCatalog, "服务区", { limit: 3 })[0]?.name, "wasm_network_service_area");
  assert.equal(searchBrowserTools(browserCatalog, "邻近表", { limit: 3 })[0]?.name, "wasm_generate_near_table");
  assert.equal(searchBrowserTools(browserCatalog, "栅格缓冲", { limit: 3 })[0]?.name, "wasm_buffer_raster");
  assert.equal(searchBrowserTools(browserCatalog, "多数滤波", { limit: 3 })[0]?.name, "wasm_majority_filter");
  assert.equal(searchBrowserTools(browserCatalog, "线密度", { limit: 3 })[0]?.name, "wasm_line_density");
  assert.equal(searchBrowserTools(browserCatalog, "欧氏分配", { limit: 3 })[0]?.name, "wasm_euclidean_allocation");
  assert.equal(searchBrowserTools(browserCatalog, "中位数滤波", { limit: 3 })[0]?.name, "wasm_median_filter");
  assert.equal(searchBrowserTools(browserCatalog, "凹包", { limit: 3 })[0]?.name, "wasm_concave_hull");
  assert.equal(searchBrowserTools(browserCatalog, "要素转线", { limit: 3 })[0]?.name, "wasm_feature_to_line");
  assert.equal(searchBrowserTools(browserCatalog, "EBK", { limit: 3 })[0]?.name, "wasm_empirical_bayesian_kriging");
  assert.equal(searchBrowserTools(browserCatalog, "克里金", { limit: 3 })[0]?.name, "wasm_empirical_bayesian_kriging");
  assert.equal(searchBrowserTools(browserCatalog, "膨胀收缩", { limit: 3 })[0]?.name, "wasm_expand_shrink");
  assert.equal(searchBrowserTools(browserCatalog, "斑块", { limit: 3 })[0]?.name, "wasm_clump");
  assert.equal(searchBrowserTools(browserCatalog, "筛除", { limit: 3 })[0]?.name, "wasm_sieve");
  assert.equal(searchBrowserTools(browserCatalog, "集水区", { limit: 3 })[0]?.name, "wasm_basins");
  assert.equal(searchBrowserTools(browserCatalog, "捕捉倒口", { limit: 3 })[0]?.name, "wasm_snap_pour_points");
  assert.equal(searchBrowserTools(browserCatalog, "要素转点", { limit: 3 })[0]?.name, "wasm_feature_vertices_to_points");
  for (const [query, expected] of [["开运算", "wasm_opening"], ["闭运算", "wasm_closing"],
    ["对称差", "wasm_symmetrical_difference"], ["多部件", "wasm_multipart_to_singlepart"],
    ["消除碎面", "wasm_eliminate_polygon_part"], ["点聚合", "wasm_aggregate_points"],
    ["普通克里金", "wasm_ordinary_kriging"], ["百分位滤波", "wasm_percentile_filter"],
    ["邻域填充", "wasm_nibble"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  for (const [query, expected] of [["差集", "wasm_difference"], ["同一性", "wasm_identity"],
    ["双边滤波", "wasm_bilateral_filter"], ["保边均值", "wasm_edge_preserving_mean_filter"],
    ["高斯滤波", "wasm_gaussian_filter"], ["趋势面", "wasm_trend_surface"],
    ["欧氏方向", "wasm_euclidean_direction"], ["成本连通", "wasm_cost_connectivity"],
    ["点转线", "wasm_points_to_line"], ["最小外包", "wasm_minimum_bounding_box"],
    ["崎岖度", "wasm_ruggedness_index"], ["地形位置", "wasm_relative_topographic_position"],
    ["湿润指数", "wasm_wetness_index"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  for (const [query, expected] of [["Strahler", "wasm_strahler_stream_order"], ["Hack", "wasm_hack_stream_order"],
    ["成本连通", "wasm_cost_connectivity"], ["廊道", "wasm_corridor"],
    ["高斯滤波", "wasm_gaussian_filter"], ["均值滤波", "wasm_mean_filter"],
    ["拉普拉斯", "wasm_laplacian_filter"], ["保边均值", "wasm_edge_preserving_mean_filter"],
    ["点转线", "wasm_points_to_line"], ["最小外包矩形", "wasm_minimum_bounding_box"],
    ["地形位置", "wasm_relative_topographic_position"], ["湿润指数", "wasm_wetness_index"],
    ["填挖方", "wasm_cut_fill"], ["块统计", "wasm_block_statistics"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  for (const [query, expected] of [["Lee滤波", "wasm_lee_filter"], ["路径距离", "wasm_path_distance"],
    ["更新叠加", "wasm_update"], ["邻近", "wasm_near"], ["线转栅格", "wasm_vector_lines_to_raster"],
    ["简单克里金", "wasm_simple_kriging"], ["局部克里金", "wasm_local_kriging"],
    ["谷线", "wasm_extract_valleys"], ["直方图均衡", "wasm_histogram_equalization"],
    ["变化矢量", "wasm_change_vector_analysis"], ["下坡指数", "wasm_downslope_index"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  for (const [query, expected] of [["线延伸", "wasm_extend_vector_lines"], ["线分割", "wasm_split_vector_lines"],
    ["查重", "wasm_find_identical"], ["整合", "wasm_integrate"], ["中位中心", "wasm_median_center"],
    ["中心要素", "wasm_central_feature"], ["方向分布", "wasm_directional_distribution"],
    ["Prewitt", "wasm_prewitt_filter"], ["保守平滑", "wasm_conservative_smoothing_filter"],
    ["坡向圆方差", "wasm_circular_variance_of_aspect"], ["平均流路坡度", "wasm_average_flowpath_slope"],
    ["成本回溯", "wasm_cost_back_link"], ["填挖方", "wasm_cut_fill"],
    ["局部克里金", "wasm_local_kriging"], ["对比度均衡", "wasm_balance_contrast_enhancement"],
    ["Frost", "wasm_frost_filter"], ["NoData掩膜", "wasm_is_nodata"],
    ["焦点统计", "wasm_focal_statistics"], ["指定等值线", "wasm_contour_list"],
    ["主成分分析", "wasm_principal_component_analysis"], ["K均值", "wasm_k_means_clustering"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  for (const [query, expected] of [["快速高斯", "wasm_fast_almost_gaussian_filter"], ["Horton", "wasm_horton_stream_order"],
    ["Shreve", "wasm_shreve_stream_magnitude"], ["Pennock", "wasm_pennock_landform_classification"],
    ["相对坡向", "wasm_relative_aspect"], ["相对高程", "wasm_elev_relative_to_min_max"],
    ["水深指数", "wasm_depth_to_water"], ["NoData", "wasm_is_nodata"],
    ["焦点统计", "wasm_focal_statistics"], ["点生成等值线", "wasm_contours_from_points"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  for (const [query, expected] of [["最小最大拉伸", "wasm_min_max_contrast_stretch"],
    ["点等值线", "wasm_contours_from_points"], ["泥沙输移", "wasm_sediment_transport_index"],
    ["总曲率", "wasm_total_curvature"], ["标准差滤波", "wasm_standard_deviation_filter"],
    ["Scharr", "wasm_scharr_filter"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
  }
  const streamOrders = searchBrowserTools(browserCatalog, "河网分级", { limit: 4 }).map(tool => tool.name);
  assert.ok(streamOrders.includes("wasm_strahler_stream_order") && streamOrders.includes("wasm_hack_stream_order"),
    "河网分级 should surface both Strahler and Hack stream ordering");
  assert.ok(streamOrders.includes("wasm_horton_stream_order"), "河网分级 should also surface Horton stream ordering");
});

test("geometry densify, centroid and line density tools publish real result layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const lines = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[500000, 4400000], [500500, 4400000]] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "LineString", coordinates: [[500000, 4400200], [500500, 4400200]] } },
  ] })]), "geometry_lines.geojson")).layer;
  const polygons = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "Polygon", coordinates: [[[500000, 4400000], [500100, 4400000], [500100, 4400100], [500000, 4400100], [500000, 4400000]]] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "Polygon", coordinates: [[[500050, 4400050], [500150, 4400050], [500150, 4400150], [500050, 4400150], [500050, 4400050]]] } },
  ] })]), "geometry_polygons.geojson")).layer;

  const centroids = await finished("wasm_centroid_vector", { input: polygons.id, output_name: "geometry_centroids" });
  const centroidLayer = centroids.layer ?? centroids.layers?.[0]?.layer;
  assert.notEqual(centroidLayer.kind, "raster");
  assert.equal(centroidLayer.feature_count, 2);
  assert.deepEqual(centroidLayer.geometry_types, ["Point"]);

  const densified = await finished("wasm_densify_features", { input: lines.id, spacing: 50, output_name: "geometry_densified" });
  const densifiedLayer = densified.layer ?? densified.layers?.[0]?.layer;
  const densifiedRecord: any = await readRecord(`layer:${densifiedLayer.id}`);
  const lineRecord: any = await readRecord(`layer:${lines.id}`);
  assert.ok(densifiedRecord.geojson.features[0].geometry.coordinates.length > lineRecord.geojson.features[0].geometry.coordinates.length,
    "densify must add vertices between the original endpoints");

  const pointSample = await sample("geometry_concave");
  const hull = await finished("wasm_concave_hull", { input: pointSample.id, concavity: 2, output_name: "geometry_concave" });
  const hullLayer = hull.layer ?? hull.layers?.[0]?.layer;
  assert.equal(hullLayer.feature_count, 1);
  assert.ok(hullLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const planar = await finished("wasm_feature_to_line", { input: polygons.id, output_name: "geometry_planar" });
  const planarLayer = planar.layer ?? planar.layers?.[0]?.layer;
  assert.ok(planarLayer.feature_count > polygons.feature_count, "feature-to-line must split polygon boundaries");
  assert.ok(planarLayer.geometry_types.every((type: string) => type === "LineString" || type === "MultiLineString"));

  const density = await finished("wasm_line_density", {
    input: lines.id, search_radius: 500, cell_size: 100, output_name: "geometry_density",
  });
  const densityLayer = density.layer ?? density.layers?.[0]?.layer;
  assert.equal(densityLayer.kind, "raster", "line density must publish a raster layer");
  assert.ok(densityLayer.raster?.width > 1 && densityLayer.raster?.height > 1);
  assert.equal(density.attachments, undefined);

  const lineRaster = await finished("wasm_vector_lines_to_raster", {
    input: lines.id, cell_size: 50, zero_background: true, output_name: "geometry_line_raster",
  });
  const lineRasterLayer = lineRaster.layer ?? lineRaster.layers?.[0]?.layer;
  assert.equal(lineRasterLayer.kind, "raster", "line-to-raster must publish a raster layer");
  assert.ok(lineRasterLayer.raster?.width > 1 && lineRasterLayer.raster?.height > 1);
  assert.equal(lineRaster.attachments, undefined);
});

test("vector QA and median-center ribbon tools publish real layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const features = [
    { type: "Feature", properties: { id: 1, value: 10 }, geometry: { type: "Point", coordinates: [500000, 4400000] } },
    { type: "Feature", properties: { id: 2, value: 20 }, geometry: { type: "Point", coordinates: [500100, 4400000] } },
    { type: "Feature", properties: { id: 3, value: 30 }, geometry: { type: "Point", coordinates: [500000, 4400100] } },
    { type: "Feature", properties: { id: 1, value: 10 }, geometry: { type: "Point", coordinates: [500000, 4400000] } },
  ];
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "vector_qa_points.geojson")).layer;
  const lines = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[500000, 4400000], [500500, 4400000]] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "LineString", coordinates: [[500000, 4400200], [500500, 4400200]] } },
  ] })]), "vector_qa_lines.geojson")).layer;
  const ring = (x: number, y: number, width: number, height: number) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const polygons = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "Polygon", coordinates: [ring(500000, 4400000, 100, 100)] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "Polygon", coordinates: [ring(500100.02, 4400000, 100, 100)] } },
  ] })]), "vector_qa_polygons.geojson")).layer;

  const near = await finished("wasm_near", { input: points.id, near: points.id, max_distance: 1000, output_name: "vector_qa_near" });
  const nearLayer = near.layer ?? near.layers?.[0]?.layer;
  assert.equal(nearLayer.feature_count, points.feature_count);
  const nearRecord: any = await readRecord(`layer:${nearLayer.id}`);
  for (const feature of nearRecord.geojson.features) {
    assert.equal(typeof feature.properties.NEAR_FID, "number");
    assert.equal(typeof feature.properties.NEAR_DIST, "number");
  }

  const extended = await finished("wasm_extend_vector_lines", {
    input: lines.id, distance: 100, extend_direction: "both", output_name: "vector_qa_extended",
  });
  const extendedLayer = extended.layer ?? extended.layers?.[0]?.layer;
  const extendedRecord: any = await readRecord(`layer:${extendedLayer.id}`);
  const lineRecord: any = await readRecord(`layer:${lines.id}`);
  assert.ok(extendedRecord.geojson.features[0].geometry.coordinates[0][0] < lineRecord.geojson.features[0].geometry.coordinates[0][0]);
  assert.ok(extendedRecord.geojson.features[0].geometry.coordinates.at(-1)[0] > lineRecord.geojson.features[0].geometry.coordinates.at(-1)[0]);

  const split = await finished("wasm_split_vector_lines", { input: lines.id, segment_length: 200, output_name: "vector_qa_split" });
  const splitLayer = split.layer ?? split.layers?.[0]?.layer;
  assert.ok(splitLayer.feature_count >= 6, "line splitting must create bounded segments");
  assert.ok(splitLayer.geometry_types.every((type: string) => type === "LineString" || type === "MultiLineString"));

  const duplicates = await finished("wasm_find_identical", {
    input: points.id, fields: "id", compare_geometry: true, mode: "delete", output_name: "vector_qa_unique",
  });
  const uniqueLayer = duplicates.layer ?? duplicates.layers?.[0]?.layer;
  assert.equal(uniqueLayer.feature_count, 3, "delete mode must keep one of each identical pair");

  const integrated = await finished("wasm_integrate", {
    input: polygons.id, tolerance: 1, snap_to_edges: true, output_name: "vector_qa_integrated",
  });
  const integratedLayer = integrated.layer ?? integrated.layers?.[0]?.layer;
  assert.equal(integratedLayer.feature_count, 2);
  assert.ok(integratedLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const median = await finished("wasm_median_center", {
    input: points.id, weight_field: "value", output_name: "vector_qa_median_center",
  });
  const medianLayer = median.layer ?? median.layers?.[0]?.layer;
  assert.equal(medianLayer.feature_count, 1);
  assert.deepEqual(medianLayer.geometry_types, ["Point"]);
});

test("Lee, downslope and cost-back-link raster tools publish real result layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const ring = (x: number, y: number, width: number, height: number) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const cell = 100, cells: any[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    cells.push({ type: "Feature", properties: { elev: 100 + row * 4 + col * 2 + (row === 2 && col === 3 ? 18 : 0) },
      geometry: { type: "Polygon", coordinates: [ring(x, y, cell, cell)] } });
  }
  const grid = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: cells })]), "raster_qa_grid.geojson")).layer;
  const dem = (await finished("wasm_vector_polygons_to_raster", {
    input: grid.id, field: "elev", cell_size: cell, output_name: "raster_qa_dem",
  })).layer;

  const lee = await finished("wasm_lee_filter", {
    input: dem.id, filter_size_x: 3, filter_size_y: 3, sigma: 10, m_value: 2, output_name: "raster_qa_lee",
  });
  const leeLayer = lee.layer ?? lee.layers?.[0]?.layer;
  assert.equal(leeLayer.kind, "raster", "Lee filter file output must publish as raster");
  assert.equal(leeLayer.raster?.width, dem.raster?.width);
  assert.equal(lee.attachments, undefined);

  const downslope = await finished("wasm_downslope_index", {
    input: dem.id, vertical_drop: 2, output_type: "tangent", output_name: "raster_qa_downslope",
  });
  const downslopeLayer = downslope.layer ?? downslope.layers?.[0]?.layer;
  assert.equal(downslopeLayer.kind, "raster", "downslope index must publish a raster layer");
  assert.equal(downslopeLayer.raster?.width, dem.raster?.width);
  assert.equal(downslope.attachments, undefined);

  const backLink = await finished("wasm_cost_back_link", {
    source: dem.id, cost: dem.id, max_distance: 10000, output_name: "raster_qa_backlink",
  });
  assert.equal(backLink.layers?.length, 2, `cost back link must publish direction and distance rasters: ${JSON.stringify(backLink)}`);
  const backLinkLayers = backLink.layers.map((item: any) => item.layer);
  assert.ok(backLinkLayers.every((layer: any) => layer.kind === "raster"));
  assert.ok(backLinkLayers.some((layer: any) => /output/.test(layer.name)));
  assert.ok(backLinkLayers.some((layer: any) => /out_distance/.test(layer.name)));
});

test("batch20 statistics, corridor, filters, valleys and local kriging publish real layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const ring = (x: number, y: number, width: number, height: number) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const pointFeatures = [
    { type: "Feature", properties: { id: 1, value: 10 }, geometry: { type: "Point", coordinates: [500000, 4400000] } },
    { type: "Feature", properties: { id: 2, value: 20 }, geometry: { type: "Point", coordinates: [500300, 4400000] } },
    { type: "Feature", properties: { id: 3, value: 30 }, geometry: { type: "Point", coordinates: [500150, 4400250] } },
    { type: "Feature", properties: { id: 4, value: 40 }, geometry: { type: "Point", coordinates: [500450, 4400250] } },
  ];
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: pointFeatures })]), "batch20_points.geojson")).layer;
  const cell = 100, cells: any[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    cells.push({ type: "Feature", properties: {
      elev: 100 + row * 4 + col * 2 + Math.abs(col - 2) * 6,
      cost: 1,
      src1: row === 0 && col === 0 ? 1 : 0,
      src2: row === 5 && col === 5 ? 1 : 0,
    }, geometry: { type: "Polygon", coordinates: [ring(x, y, cell, cell)] } });
  }
  const grid = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: cells })]), "batch20_grid.geojson")).layer;
  const raster = async (field: string, name: string) => (await finished("wasm_vector_polygons_to_raster", {
    input: grid.id, field, cell_size: cell, output_name: name,
  })).layer;
  const dem = await raster("elev", "batch20_dem");
  const cost = await raster("cost", "batch20_cost");
  const source1 = await raster("src1", "batch20_source1");
  const source2 = await raster("src2", "batch20_source2");

  const central = await finished("wasm_central_feature", {
    input: points.id, statistic: "central_feature", distance: "euclidean", output_name: "batch20_central",
  });
  const centralLayer = central.layer ?? central.layers?.[0]?.layer;
  assert.equal(centralLayer.feature_count, 1);
  assert.deepEqual(centralLayer.geometry_types, ["Point"]);

  const directional = await finished("wasm_directional_distribution", {
    input: points.id, statistic: "standard_deviational_ellipse", n_std: 1, output_name: "batch20_ellipse",
  });
  const directionalLayer = directional.layer ?? directional.layers?.[0]?.layer;
  assert.equal(directionalLayer.feature_count, 1);
  assert.ok(directionalLayer.geometry_types.every((kind: string) => kind === "Polygon" || kind === "MultiPolygon"));

  const corridor = await finished("wasm_corridor", {
    cost: cost.id, source1: source1.id, source2: source2.id, output_name: "batch20_corridor",
  });
  const corridorLayer = corridor.layer ?? corridor.layers?.[0]?.layer;
  assert.equal(corridorLayer.kind, "raster", "corridor must publish a raster layer");
  assert.equal(corridorLayer.raster?.width, dem.raster?.width);

  const path = await finished("wasm_path_distance", {
    source: source1.id, cost: cost.id, surface: dem.id, vertical_factor: "tobler", output_name: "batch20_path_distance",
  });
  const pathLayer = path.layer ?? path.layers?.[0]?.layer;
  assert.equal(pathLayer.kind, "raster", "path distance must publish a raster layer");
  assert.equal(pathLayer.raster?.width, dem.raster?.width);

  for (const [tool, args, name] of [
    ["wasm_prewitt_filter", { input: dem.id, clip_tails: 0 }, "batch20_prewitt"],
    ["wasm_conservative_smoothing_filter", { input: dem.id, filter_size_x: 3, filter_size_y: 3 }, "batch20_conservative"],
  ] as const) {
    const result = await finished(tool, { ...args, output_name: name });
    const layer = result.layer ?? result.layers?.[0]?.layer;
    assert.equal(layer.kind, "raster", `${tool} must publish a raster`);
    assert.equal(layer.raster?.width, dem.raster?.width);
    assert.equal(result.attachments, undefined);
  }

  const kriging = await finished("wasm_local_kriging", {
    points: points.id, value_field: "value", cell_size: cell, k_neighbors: 3, output_name: "batch20_local_kriging",
  });
  const krigingLayer = kriging.layer ?? kriging.layers?.[0]?.layer;
  assert.equal(krigingLayer.kind, "raster", "local kriging must publish a raster");
  assert.ok(krigingLayer.raster?.width > 1 && krigingLayer.raster?.height > 1);

  const valleys = await finished("wasm_extract_valleys", {
    dem: dem.id, filter_size: 3, line_thin: true, variant: "lq", output_name: "batch20_valleys",
  });
  const valleyLayer = valleys.layer ?? valleys.layers?.[0]?.layer;
  assert.equal(valleyLayer.kind, "raster", "valley extraction must publish a raster");
  assert.equal(valleyLayer.raster?.width, dem.raster?.width);
});

test("batch21 filter, terrain and clustering forms expose honest executable contracts", async () => {
  await ensureBrowserCatalog();
  const props = (name: string) => (browserCatalog.find(tool => tool.name === name)!.parameters.properties ?? {}) as any;
  const required = (name: string) => browserCatalog.find(tool => tool.name === name)!.parameters.required ?? [];
  for (const name of ["wasm_frost_filter", "wasm_fast_almost_gaussian_filter", "wasm_circular_variance_of_aspect",
    "wasm_average_flowpath_slope", "wasm_cut_fill", "wasm_is_nodata", "wasm_focal_statistics"]) {
    const properties = props(name);
    const inputName = name === "wasm_average_flowpath_slope" ? "dem" : "input";
    assert.equal(properties[inputName]["x-layer-kind"], "raster", `${name} input must be raster`);
    assert.ok(!("output" in properties), `${name} output path must stay internal`);
    assert.ok(required(name).includes(inputName), `${name} input must be required`);
  }
  assert.equal(props("wasm_frost_filter").radius.type, "integer");
  assert.equal(props("wasm_fast_almost_gaussian_filter").sigma.type, "number");
  assert.equal(props("wasm_circular_variance_of_aspect").filter.type, "integer");

  const cutFill = props("wasm_cut_fill");
  assert.equal(cutFill.after["x-layer-kind"], "raster");
  assert.equal(cutFill.plane.type, "number");
  assert.equal(cutFill.band.type, "integer");
  assert.ok(!("region_output" in cutFill) && !("csv_output" in cutFill), "cut-fill side outputs must stay internal");

  const focal = props("wasm_focal_statistics");
  assert.deepEqual(focal.statistics.enum, ["mean", "majority", "maximum", "median", "minimum", "minority", "percentile", "range", "std", "sum", "variety"]);
  assert.deepEqual(focal.neighborhood.enum, ["rectangle", "circle", "annulus", "wedge"]);
  assert.equal(focal.width.type, "integer");
  assert.equal(focal.ignore_nodata.type, "boolean");

  const kmeans = props("wasm_k_means_clustering");
  assert.equal(kmeans.inputs.type, "array");
  assert.equal(kmeans.inputs["x-layer-multiple"], true);
  assert.equal(kmeans.classes.type, "integer");
  assert.equal(kmeans.max_iterations.type, "integer");
  assert.deepEqual(kmeans.initialize.enum, ["diagonal", "random"]);

  const pca = props("wasm_principal_component_analysis");
  assert.equal(pca.inputs.type, "array");
  assert.equal(pca.inputs["x-layer-multiple"], true);
  assert.equal(pca.num_components.type, "integer");
  assert.equal(pca.standardized.type, "boolean");
});

test("batch22 RS, stream-order and contour forms expose honest executable contracts", async () => {
  await ensureBrowserCatalog();
  const props = (name: string) => (browserCatalog.find(tool => tool.name === name)!.parameters.properties ?? {}) as any;
  const required = (name: string) => browserCatalog.find(tool => tool.name === name)!.parameters.required ?? [];

  for (const name of ["wasm_balance_contrast_enhancement", "wasm_histogram_equalization",
    "wasm_min_max_contrast_stretch", "wasm_pennock_landform_classification"]) {
    const properties = props(name);
    assert.equal(properties.input["x-layer-kind"], "raster", `${name} input must be raster`);
    assert.ok(!("output" in properties), `${name} output path must stay internal`);
    assert.ok(required(name).includes("input"), `${name} input must be required`);
  }
  const stretch = props("wasm_min_max_contrast_stretch");
  assert.equal(stretch.min_val.type, "number", "min_val is a numeric stretch bound");
  assert.equal(stretch.max_val.type, "number", "max_val is a numeric stretch bound");
  assert.equal(stretch.min_val.default, 0);
  assert.equal(stretch.max_val.default, 255);
  assert.equal(stretch.num_tones.type, "integer");
  assert.equal(props("wasm_histogram_equalization").num_tones.type, "integer");
  assert.equal(props("wasm_balance_contrast_enhancement").band_mean.type, "number");

  for (const name of ["wasm_horton_stream_order", "wasm_shreve_stream_magnitude"]) {
    const properties = props(name);
    for (const input of ["d8_pntr", "streams"]) {
      assert.equal(properties[input]["x-layer-kind"], "raster", `${name}.${input} must be raster`);
      assert.ok(required(name).includes(input), `${name}.${input} must be required`);
    }
    assert.equal(properties.esri_pntr.type, "boolean");
    assert.equal(properties.zero_background.type, "boolean");
    assert.ok(!("output" in properties), `${name} output path must stay internal`);
  }

  const contours = props("wasm_contour_list");
  assert.equal(contours.input["x-layer-kind"], "raster");
  assert.equal(contours.contour_values.type, "string");
  assert.ok(required("wasm_contour_list").includes("contour_values"));
  assert.deepEqual(contours.geometry_type.enum, ["polyline", "polygon"]);
  assert.equal(contours.band.type, "integer");
  assert.ok(!("output" in contours), "contour-list output path must stay internal");

  const pointContours = props("wasm_contours_from_points");
  assert.equal(pointContours.input["x-layer-kind"], "vector");
  assert.equal(pointContours.field_name.type, "string");
  assert.equal(pointContours.interval.type, "number");
  assert.equal(pointContours.smooth.type, "integer");
  assert.equal(pointContours.use_z_values.type, "boolean");
  assert.ok(!("output" in pointContours), "point-contour output path must stay internal");

  const pennock = props("wasm_pennock_landform_classification");
  assert.equal(pennock.plan_curv_threshold.type, "number");
  assert.equal(pennock.prof_curv_threshold.type, "number");
  assert.equal(pennock.slope_threshold.type, "number");
});

test("batch21 filter, terrain, NoData and clustering tools publish result layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const ring = (x: number, y: number, width: number, height: number) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const cell = 100, features: any[] = [];
  for (let row = 0; row < 12; row++) for (let col = 0; col < 12; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    features.push({ type: "Feature", properties: { elev: 1200 - row * 4 - col + (row === 5 && col === 5 ? -15 : 0) },
      geometry: { type: "Polygon", coordinates: [ring(x, y, cell, cell)] } });
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "batch21_dem_source.geojson")).layer;
  const dem = (await finished("wasm_vector_polygons_to_raster", {
    input: source.id, field: "elev", cell_size: cell, output_name: "batch21_dem",
  })).layer;

  for (const [tool, args, name] of [
    ["wasm_frost_filter", { input: dem.id, radius: 2, damping_factor: 2 }, "batch21_frost"],
    ["wasm_fast_almost_gaussian_filter", { input: dem.id, sigma: 1.8 }, "batch21_fast_gaussian"],
    ["wasm_circular_variance_of_aspect", { input: dem.id, filter: 5 }, "batch21_aspect_variance"],
    ["wasm_average_flowpath_slope", { dem: dem.id }, "batch21_flowpath_slope"],
    ["wasm_is_nodata", { input: dem.id }, "batch21_nodata"],
    ["wasm_focal_statistics", { input: dem.id, statistics: "mean", neighborhood: "rectangle", width: 3, height: 3, ignore_nodata: true, band: 1 }, "batch21_focal"],
  ] as const) {
    const result = await finished(tool, { ...args, output_name: name });
    const layer = result.layer ?? result.layers?.[0]?.layer;
    assert.equal(layer.kind, "raster", `${tool} must publish a raster`);
    assert.equal(layer.raster?.width, dem.raster?.width);
    assert.equal(result.attachments, undefined);
  }

  const cutFill = await finished("wasm_cut_fill", {
    input: dem.id, plane: 1150, band: 1, tolerance: 0, output_name: "batch21_cut_fill",
  });
  const cutFillLayers = cutFill.layers?.map((item: any) => item.layer) ?? [];
  assert.deepEqual(cutFillLayers.map((layer: any) => layer.kind), ["raster", "raster", "table"]);
  assert.equal(cutFillLayers[0].raster?.width, dem.raster?.width);

  const clusters = await finished("wasm_k_means_clustering", {
    inputs: [dem.id, dem.id], classes: 3, max_iterations: 5, class_change: 2, initialize: "diagonal",
    min_class_size: 1, output_name: "batch21_kmeans",
  });
  const clusterLayer = clusters.layer ?? clusters.layers?.[0]?.layer;
  assert.equal(clusterLayer.kind, "raster", "K-means must publish its class raster");
  assert.equal(clusterLayer.raster?.width, dem.raster?.width);
  assert.equal(clusters.attachments, undefined, "the optional HTML report must not become a workspace attachment");

  const pca = await finished("wasm_principal_component_analysis", {
    inputs: [dem.id, dem.id, dem.id], num_components: 2, standardized: false, auto_reproject: true,
    output_name: "batch21_pca",
  });
  const pcaLayers = pca.layers?.map((item: any) => item.layer) ?? [];
  assert.equal(pcaLayers.length, 2, "PCA must publish one raster per requested component");
  assert.ok(pcaLayers.every((layer: any) => layer.kind === "raster" && layer.name.includes("_comp")));
});

test("batch22 contrast, stream order, contours and Pennock publish displayed layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const ring = (x: number, y: number, width: number, height: number) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const cell = 100, features: any[] = [];
  for (let row = 0; row < 12; row++) for (let col = 0; col < 12; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    features.push({ type: "Feature", properties: { elev: 1200 - row * 4 - col + (row === 5 && col === 5 ? -15 : 0) },
      geometry: { type: "Polygon", coordinates: [ring(x, y, cell, cell)] } });
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "batch22_dem_source.geojson")).layer;
  const dem = (await finished("wasm_vector_polygons_to_raster", {
    input: source.id, field: "elev", cell_size: cell, output_name: "batch22_dem",
  })).layer;

  const rgb = await finished("wasm_create_colour_composite", {
    input: dem.id, red: dem.id, green: dem.id, blue: dem.id, enhance: false, output_name: "batch22_rgb",
  });
  const rgbLayer = rgb.layer ?? rgb.layers?.[0]?.layer;
  assert.equal(rgbLayer.kind, "raster", "RGB composite must publish a raster");
  assert.equal(rgb.attachments, undefined);

  for (const [tool, args, name] of [
    ["wasm_balance_contrast_enhancement", { input: rgbLayer.id, band_mean: 100 }, "batch22_balance"],
    ["wasm_histogram_equalization", { input: dem.id, num_tones: 256 }, "batch22_histogram"],
    ["wasm_min_max_contrast_stretch", { input: dem.id, min_val: 1100, max_val: 1250, num_tones: 256 }, "batch22_stretch"],
  ] as const) {
    const result = await finished(tool, { ...args, output_name: name });
    const layer = result.layer ?? result.layers?.[0]?.layer;
    assert.equal(layer.kind, "raster", `${tool} must publish a raster`);
    assert.equal(result.attachments, undefined);
  }

  const chain = await finished("hydrology_flow_pipeline", {
    dem: dem.id, stream_threshold: 10, extract_streams: true, output_name: "batch22_chain",
  });
  const chainLayers = chain.layers?.map((item: any) => item.layer) ?? [];
  assert.equal(chainLayers.length, 4, "hydrology chain must expose fill, pointer, accumulation and streams");
  const pointer = chainLayers[1], streams = chainLayers[3];
  assert.equal(pointer.kind, "raster");
  assert.equal(streams.kind, "raster");

  for (const [tool, name] of [["wasm_horton_stream_order", "batch22_horton"],
    ["wasm_shreve_stream_magnitude", "batch22_shreve"]] as const) {
    const result = await finished(tool, { d8_pntr: pointer.id, streams: streams.id, output_name: name });
    const layer = result.layer ?? result.layers?.[0]?.layer;
    assert.equal(layer.kind, "raster", `${tool} must publish a raster`);
    assert.equal(result.attachments, undefined);
  }
  const contourLines = await finished("wasm_contour_list", {
    input: dem.id, contour_values: "1120,1160", geometry_type: "polyline", min_length: 1,
    close_rings: true, band: 1, output_name: "batch22_contours",
  });
  const contourLayer = contourLines.layer ?? contourLines.layers?.[0]?.layer;
  assert.ok(contourLayer.feature_count > 0, "contour list must publish contour features");
  assert.ok(contourLayer.geometry_types.every((type: string) => type === "LineString" || type === "MultiLineString"));
  assert.equal(contourLines.attachments, undefined);

  const pointFeatures: any[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    pointFeatures.push({ type: "Feature", properties: { elev: 100 + row * 12 + col * 6 },
      geometry: { type: "Point", coordinates: [500000 + col * 250, 4400000 + row * 250] } });
  }
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: pointFeatures })]), "batch22_contour_points.geojson")).layer;
  const pointContours = await finished("wasm_contours_from_points", {
    input: points.id, field_name: "elev", base: 100, interval: 12, smooth: 3, use_z_values: false,
    output_name: "batch22_point_contours",
  });
  const pointContourLayer = pointContours.layer ?? pointContours.layers?.[0]?.layer;
  assert.ok(pointContourLayer.feature_count > 0, "point contours must publish contour features");
  assert.ok(pointContourLayer.geometry_types.every((type: string) => type === "LineString" || type === "MultiLineString"));
  assert.equal(pointContours.attachments, undefined);
  const pennock = await finished("wasm_pennock_landform_classification", {
    input: dem.id, plan_curv_threshold: 0, prof_curv_threshold: 0.1, slope_threshold: 3, z_factor: 1,
    output_name: "batch22_pennock",
  });
  const pennockLayer = pennock.layer ?? pennock.layers?.[0]?.layer;
  assert.equal(pennockLayer.kind, "raster", "Pennock classification must publish a raster");
  assert.equal(pennockLayer.raster?.width, dem.raster?.width);
  assert.equal(pennock.attachments, undefined);
});

test("morphology and vector cleanup ribbon tools publish displayed result layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100, features: any[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    features.push({ type: "Feature", properties: { klass: row >= 2 && row < 5 && col >= 2 && col < 5 ? 2 : 1 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const polygons = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "morphology_polygons.geojson")).layer;
  const classes = (await finished("wasm_vector_polygons_to_raster", {
    input: polygons.id, field: "klass", cell_size: cell, output_name: "morphology_classes",
  })).layer;

  const expanded = await finished("wasm_expand_shrink", {
    input: classes.id, classes: "2", cells: 1, mode: "expand", output_name: "morphology_expanded",
  });
  const expandedLayer = expanded.layer ?? expanded.layers?.[0]?.layer;
  assert.equal(expandedLayer.kind, "raster", "expand/shrink must publish a raster layer");
  assert.equal(expanded.attachments, undefined);

  const clumped = await finished("wasm_clump", { input: classes.id, diag: false, output_name: "morphology_clumps" });
  const clumpedLayer = clumped.layer ?? clumped.layers?.[0]?.layer;
  assert.equal(clumpedLayer.kind, "raster", "clump must publish a raster layer");
  assert.equal(clumpedLayer.raster?.width, classes.raster?.width);

  const sieved = await finished("wasm_sieve", { input: classes.id, threshold: 2, zero_background: false, output_name: "morphology_sieved" });
  const sievedLayer = sieved.layer ?? sieved.layers?.[0]?.layer;
  assert.equal(sievedLayer.kind, "raster", "sieve must publish a raster layer");

  for (const [tool, output] of [["wasm_opening", "morphology_opened"], ["wasm_closing", "morphology_closed"]]) {
    const result = await finished(tool, { input: classes.id, filter_size_x: 3, filter_size_y: 3, output_name: output });
    const layer = result.layer ?? result.layers?.[0]?.layer;
    assert.equal(layer.kind, "raster", `${tool} generic file output must publish as raster`);
    assert.equal(result.attachments, undefined);
  }

  const vertices = await finished("wasm_feature_vertices_to_points", {
    input: polygons.id, point_location: "ALL", output_name: "morphology_vertices",
  });
  const verticesLayer = vertices.layer ?? vertices.layers?.[0]?.layer;
  assert.ok(verticesLayer.feature_count > polygons.feature_count, "feature vertices must emit one point per vertex");
  assert.ok(verticesLayer.geometry_types.every((type: string) => type === "Point"));

  const aggregateSource = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "Polygon", coordinates: [[[500000, 4400000], [500100, 4400000], [500100, 4400100], [500000, 4400100], [500000, 4400000]]] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "Polygon", coordinates: [[[500140, 4400000], [500240, 4400000], [500240, 4400100], [500140, 4400100], [500140, 4400000]]] } },
  ] })]), "aggregate_source.geojson")).layer;
  const aggregated = await finished("wasm_aggregate_polygons", {
    input: aggregateSource.id, aggregation_distance: 100, output_name: "aggregated_polygons",
  });
  const aggregatedLayer = aggregated.layer ?? aggregated.layers?.[0]?.layer;
  assert.ok(aggregatedLayer.feature_count >= 1, "aggregate polygons must return a vector layer");
  assert.ok(aggregatedLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));
});

test("nibble, overlay, multipart cleanup and point aggregation publish displayed layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100, rasterFeatures: any[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    rasterFeatures.push({ type: "Feature", properties: { value: (row + col) % 2 + 1, mask: row === 2 && col === 2 ? 0 : 1 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const grid = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: rasterFeatures })]), "nibble_grid.geojson")).layer;
  const classes = (await finished("wasm_vector_polygons_to_raster", { input: grid.id, field: "value", cell_size: cell, output_name: "nibble_classes" })).layer;
  const mask = (await finished("wasm_vector_polygons_to_raster", { input: grid.id, field: "mask", cell_size: cell, output_name: "nibble_mask" })).layer;
  const nibbled = await finished("wasm_nibble", { input: classes.id, mask: mask.id, use_nodata: false, nibble_nodata: true, output_name: "nibble_filled" });
  const nibbledLayer = nibbled.layer ?? nibbled.layers?.[0]?.layer;
  assert.equal(nibbledLayer.kind, "raster", "nibble must publish a raster layer");
  assert.equal(nibbledLayer.raster?.width, classes.raster?.width);
  assert.equal(nibbled.attachments, undefined);

  const ring = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
  const overlayA = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: "a" }, geometry: { type: "Polygon", coordinates: [ring(500000, 4400000, 200)] } },
  ] })]), "symmetrical_a.geojson")).layer;
  const overlayB = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: "b" }, geometry: { type: "Polygon", coordinates: [ring(500100, 4400000, 200)] } },
  ] })]), "symmetrical_b.geojson")).layer;
  const exclusive = await finished("wasm_symmetrical_difference", {
    input: overlayA.id, overlay: overlayB.id, snap_tolerance: 0.000001, output_name: "exclusive_overlay",
  });
  const exclusiveLayer = exclusive.layer ?? exclusive.layers?.[0]?.layer;
  assert.ok(exclusiveLayer.feature_count >= 1, "symmetrical difference must return a vector layer");
  assert.ok(exclusiveLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const multipart = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [{
    type: "Feature", properties: { id: 1 }, geometry: { type: "MultiPolygon", coordinates: [
      [ring(500000, 4400000, 100)], [ring(500500, 4400000, 10)],
    ] },
  }] })]), "multipart_parts.geojson")).layer;
  const singlepart = await finished("wasm_multipart_to_singlepart", { input: multipart.id, exclude_holes: false, output_name: "single_parts" });
  const singlepartLayer = singlepart.layer ?? singlepart.layers?.[0]?.layer;
  assert.ok(singlepartLayer.feature_count > multipart.feature_count, "multipart conversion must split a feature into singleparts");
  assert.ok(singlepartLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));
  const eliminated = await finished("wasm_eliminate_polygon_part", {
    input: multipart.id, condition: "AREA", min_area: 500, part_option: "ANY", output_name: "large_parts_only",
  });
  const eliminatedLayer = eliminated.layer ?? eliminated.layers?.[0]?.layer;
  assert.ok(eliminatedLayer.feature_count >= 1, "eliminate polygon part must return a vector layer");
  assert.ok(eliminatedLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const pointFeatures = [
    [500000, 4400000, 1], [500100, 4400000, 2], [500000, 4400100, 3],
    [500500, 4400000, 4], [500600, 4400000, 5], [500500, 4400100, 6],
  ].map(([x, y, value]) => ({ type: "Feature", properties: { value }, geometry: { type: "Point", coordinates: [x, y] } }));
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: pointFeatures })]), "aggregate_points.geojson")).layer;
  const aggregates = await finished("wasm_aggregate_points", {
    input: points.id, aggregation_distance: 200, min_points: 2, method: "convex_hull", sum_fields: "value", output_name: "point_clusters",
  });
  const aggregateLayer = aggregates.layer ?? aggregates.layers?.[0]?.layer;
  assert.ok(aggregateLayer.feature_count >= 1, "aggregate points must return cluster polygons");
  assert.ok(aggregateLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));
});

test("ordinary kriging runs from an honest numeric cell-size form", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const features: any[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    features.push({ type: "Feature", properties: { z: 100 + row * 4 + col * 2 },
      geometry: { type: "Point", coordinates: [500000 + col * 500, 4400000 + row * 500] } });
  }
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "ordinary_kriging_points.geojson")).layer;
  const result = await finished("wasm_ordinary_kriging", {
    points: points.id, value_field: "z", cell_size: 500, output_name: "ordinary_kriging_surface",
  });
  const layer = result.layer ?? result.layers?.[0]?.layer;
  assert.equal(layer.kind, "raster", "ordinary kriging must publish a raster layer");
  assert.ok(layer.raster?.width > 1 && layer.raster?.height > 1);
  assert.equal(result.attachments, undefined);

  const simple = await finished("wasm_simple_kriging", {
    points: points.id, value_field: "z", known_mean: 110, cell_size: 500, output_name: "simple_kriging_surface",
  });
  const simpleLayer = simple.layer ?? simple.layers?.[0]?.layer;
  assert.equal(simpleLayer.kind, "raster", "simple kriging must publish a raster layer");
  assert.ok(simpleLayer.raster?.width > 1 && simpleLayer.raster?.height > 1);
  assert.equal(simple.attachments, undefined);
});

test("overlay, advanced geometry, bilateral filter and terrain tools publish real layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const ring = (x: number, y: number, width: number, height: number) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const overlayA = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: "a" }, geometry: { type: "Polygon", coordinates: [ring(500000, 4400000, 300, 200)] } },
  ] })]), "difference_a.geojson")).layer;
  const overlayB = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { zone: "b" }, geometry: { type: "Polygon", coordinates: [ring(500100, 4400050, 100, 100)] } },
  ] })]), "difference_b.geojson")).layer;

  const difference = await finished("wasm_difference", {
    input: overlayA.id, overlay: overlayB.id, snap_tolerance: 0.000001, output_name: "difference_result",
  });
  const differenceLayer = difference.layer ?? difference.layers?.[0]?.layer;
  assert.ok(differenceLayer.feature_count >= 1, "difference must publish a polygon result");
  assert.ok(differenceLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));
  assert.equal(difference.attachments, undefined);

  const identity = await finished("wasm_identity", {
    input: overlayA.id, overlay: overlayB.id, snap_tolerance: 0.000001, output_name: "identity_result",
  });
  const identityLayer = identity.layer ?? identity.layers?.[0]?.layer;
  assert.ok(identityLayer.feature_count >= 1, "identity must preserve polygon coverage");
  assert.ok(identityLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const updated = await finished("wasm_update", {
    input: overlayA.id, overlay: overlayB.id, snap_tolerance: 0.000001, output_name: "update_result",
  });
  const updatedLayer = updated.layer ?? updated.layers?.[0]?.layer;
  assert.ok(updatedLayer.feature_count >= 1, "update overlay must publish a polygon result");
  assert.ok(updatedLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const line = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[500000, 4400000], [500200, 4400000], [500200, 4400200]] } },
  ] })]), "advanced_buffer_line.geojson")).layer;
  const buffered = await finished("wasm_buffer_vector", {
    input: line.id, distance: 50, quadrant_segments: 4, cap_style: "flat", join_style: "mitre",
    mitre_limit: 5, dissolve: false, output_name: "advanced_buffer_result",
  });
  const bufferedLayer = buffered.layer ?? buffered.layers?.[0]?.layer;
  assert.ok(bufferedLayer.feature_count >= 1, "advanced buffer must publish a polygon result");
  assert.ok(bufferedLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const circles = await finished("wasm_minimum_bounding_circle", {
    input: line.id, individual_feature_hulls: true, output_name: "minimum_circle_result",
  });
  const circleLayer = circles.layer ?? circles.layers?.[0]?.layer;
  assert.ok(circleLayer.feature_count >= 1, "minimum bounding circle must publish a polygon result");
  assert.ok(circleLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const boxes = await finished("wasm_minimum_bounding_box", {
    input: overlayA.id, min_criteria: "width", individual_feature_hulls: true, output_name: "minimum_box_result",
  });
  const boxLayer = boxes.layer ?? boxes.layers?.[0]?.layer;
  assert.equal(boxLayer.feature_count, 1, "minimum bounding box must publish one box per input feature");
  assert.ok(boxLayer.geometry_types.every((type: string) => type === "Polygon" || type === "MultiPolygon"));

  const routePoints = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { route: "A", step: 2 }, geometry: { type: "Point", coordinates: [500200, 4400000] } },
    { type: "Feature", properties: { route: "A", step: 1 }, geometry: { type: "Point", coordinates: [500000, 4400000] } },
    { type: "Feature", properties: { route: "B", step: 1 }, geometry: { type: "Point", coordinates: [500000, 4400200] } },
    { type: "Feature", properties: { route: "B", step: 2 }, geometry: { type: "Point", coordinates: [500200, 4400200] } },
  ] })]), "points_to_line_source.geojson")).layer;
  const lines = await finished("wasm_points_to_line", {
    input: routePoints.id, line_field: "route", sort_field: "step", close_line: false, output_name: "points_to_line_result",
  });
  const lineLayer = lines.layer ?? lines.layers?.[0]?.layer;
  assert.equal(lineLayer.feature_count, 2, "point-to-line must build one line per group");
  assert.ok(lineLayer.geometry_types.every((type: string) => type === "LineString" || type === "MultiLineString"));

  const cell = 100, cells: any[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    cells.push({ type: "Feature", properties: { elev: 100 + row * 4 + col * 2 + (row === 2 && col === 3 ? 18 : 0) },
      geometry: { type: "Polygon", coordinates: [ring(x, y, cell, cell)] } });
  }
  const grid = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: cells })]), "terrain_filter_grid.geojson")).layer;
  const dem = (await finished("wasm_vector_polygons_to_raster", {
    input: grid.id, field: "elev", cell_size: cell, output_name: "terrain_filter_dem",
  })).layer;

  const bilateral = await finished("wasm_bilateral_filter", {
    input: dem.id, sigma_dist: 1, sigma_int: 2, treat_as_rgb: false, assume_three_band_rgb: false,
    output_name: "bilateral_result",
  });
  const bilateralLayer = bilateral.layer ?? bilateral.layers?.[0]?.layer;
  assert.equal(bilateralLayer.kind, "raster", "bilateral filter file output must publish as raster");
  assert.equal(bilateralLayer.raster?.width, dem.raster?.width);
  assert.equal(bilateral.attachments, undefined);

  const trend = await finished("wasm_trend_surface", {
    input: dem.id, polynomial_order: 1, output_name: "trend_surface_result",
  });
  const trendLayer = trend.layer ?? trend.layers?.[0]?.layer;
  assert.equal(trendLayer.kind, "raster", "trend surface must publish a raster layer");
  assert.equal(trendLayer.raster?.width, dem.raster?.width);

  const ruggedness = await finished("wasm_ruggedness_index", { input: dem.id, output_name: "ruggedness_result" });
  const ruggednessLayer = ruggedness.layer ?? ruggedness.layers?.[0]?.layer;
  assert.equal(ruggednessLayer.kind, "raster", "ruggedness file output must publish as raster");
  assert.equal(ruggednessLayer.raster?.width, dem.raster?.width);
  assert.equal(ruggedness.attachments, undefined);

  const gaussian = await finished("wasm_gaussian_filter", {
    input: dem.id, sigma: 1, treat_as_rgb: false, assume_three_band_rgb: false, output_name: "gaussian_result",
  });
  const gaussianLayer = gaussian.layer ?? gaussian.layers?.[0]?.layer;
  assert.equal(gaussianLayer.kind, "raster", "Gaussian filter file output must publish as raster");
  assert.equal(gaussianLayer.raster?.width, dem.raster?.width);
  assert.equal(gaussian.attachments, undefined);

  const mean = await finished("wasm_mean_filter", {
    input: dem.id, filter_size_x: 3, filter_size_y: 3, output_name: "mean_filter_result",
  });
  const meanLayer = mean.layer ?? mean.layers?.[0]?.layer;
  assert.equal(meanLayer.kind, "raster", "mean filter file output must publish as raster");
  assert.equal(meanLayer.raster?.width, dem.raster?.width);
  assert.equal(mean.attachments, undefined);

  const laplacian = await finished("wasm_laplacian_filter", {
    input: dem.id, variant: "3x3(1)", clip_amount: 0, output_name: "laplacian_result",
  });
  const laplacianLayer = laplacian.layer ?? laplacian.layers?.[0]?.layer;
  assert.equal(laplacianLayer.kind, "raster", "Laplacian filter file output must publish as raster");
  assert.equal(laplacianLayer.raster?.width, dem.raster?.width);
  assert.equal(laplacian.attachments, undefined);

  const edgeMean = await finished("wasm_edge_preserving_mean_filter", {
    input: dem.id, filter_size: 3, threshold: 15, output_name: "edge_mean_result",
  });
  const edgeMeanLayer = edgeMean.layer ?? edgeMean.layers?.[0]?.layer;
  assert.equal(edgeMeanLayer.kind, "raster", "edge-preserving filter file output must publish as raster");
  assert.equal(edgeMeanLayer.raster?.width, dem.raster?.width);
  assert.equal(edgeMean.attachments, undefined);

  const rtp = await finished("wasm_relative_topographic_position", {
    input: dem.id, filter_size_x: 3, filter_size_y: 3, output_name: "rtp_result",
  });
  const rtpLayer = rtp.layer ?? rtp.layers?.[0]?.layer;
  assert.equal(rtpLayer.kind, "raster", "relative topographic position must publish a raster");
  assert.equal(rtpLayer.raster?.width, dem.raster?.width);
  assert.equal(rtp.attachments, undefined);
});

test("empirical Bayesian kriging publishes both prediction and error rasters", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const features: any[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const x = 500000 + col * 1000, y = 4400000 + row * 1000;
    features.push({ type: "Feature", properties: { z: 100 + row * 3 + col * 2 },
      geometry: { type: "Point", coordinates: [x, y] } });
  }
  const points = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "ebk_points.geojson")).layer;
  const result = await finished("wasm_empirical_bayesian_kriging", {
    input: points.id, field: "z", cell_size: 500, subset_size: 8, simulations: 2, output_name: "ebk_surface",
  });
  assert.equal(result.layers?.length, 2, "EBK must publish prediction and error outputs");
  const layers = result.layers.map((item: any) => item.layer);
  assert.ok(layers.every((layer: any) => layer.kind === "raster"));
  assert.ok(layers.some((layer: any) => /prediction|output/i.test(layer.name)), "EBK must expose the prediction raster");
  assert.ok(layers.some((layer: any) => /error/i.test(layer.name)), "EBK must expose the standard-error raster");
  assert.equal(result.attachments, undefined);
});

test("basins and snapped pour points run from a real hydrology chain", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100, features: any[] = [];
  for (let row = 0; row < 10; row++) for (let col = 0; col < 10; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    features.push({ type: "Feature", properties: { elev: 1000 - row * 3 - col + (row === 4 && col === 4 ? -12 : 0) },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "basin_dem_source.geojson")).layer;
  const dem = (await finished("wasm_vector_polygons_to_raster", { input: source.id, field: "elev", cell_size: cell, output_name: "basin_dem" })).layer;
  const chain = await finished("hydrology_flow_pipeline", { dem: dem.id, extract_streams: false, output_name: "basin_chain" });
  const pointer = chain.layers[1].layer;
  const accumulation = chain.layers[2].layer;
  assert.equal(pointer.kind, "raster");
  assert.equal(accumulation.kind, "raster");

  const basins = await finished("wasm_basins", { d8_pntr: pointer.id, output_name: "basins_result" });
  const basinLayer = basins.layer ?? basins.layers?.[0]?.layer;
  assert.equal(basinLayer.kind, "raster", "basins must publish a raster layer");
  assert.equal(basinLayer.raster?.width, pointer.raster?.width);

  const pour = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [{
    type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [500450, 4400450] },
  }] })]), "basin_pour.geojson")).layer;
  const snapped = await finished("wasm_snap_pour_points", {
    flow_accum: accumulation.id, pour_pts: pour.id, snap_dist: 300, output_name: "snapped_pour",
  });
  const snappedLayer = snapped.layer ?? snapped.layers?.[0]?.layer;
  assert.ok(snappedLayer.feature_count >= 1, "snap pour points must return points");
  assert.ok(snappedLayer.geometry_types.every((type: string) => type === "Point"));
  assert.equal(snapped.attachments, undefined);
});

test("network service area and raster cleanup tools produce displayed result layers", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const network = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[500000, 4400000], [5001000, 4400000]] } },
    { type: "Feature", properties: { id: 2 }, geometry: { type: "LineString", coordinates: [[5000500, 4400000], [5000500, 4401000]] } },
  ] })]), "service_network.geojson")).layer;
  const origins = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: [
    { type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [5000500, 4400000] } },
  ] })]), "service_origins.geojson")).layer;
  const service = await finished("wasm_network_service_area", {
    input: network.id, origins: origins.id, max_cost: "800", ring_costs: "400,800", output_mode: "nodes", output_name: "service_nodes",
  });
  const serviceLayers = Array.isArray(service.layers) ? service.layers.map((item: any) => item.layer).filter(Boolean) : (service.layer ? [service.layer] : []);
  assert.ok(serviceLayers.length > 0, "service area must publish a real result layer");
  assert.ok(serviceLayers.some((layer: any) => layer.feature_count > 0), "service area must contain reachable network features");

  const features = [] as any[];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const x = 500000 + col * 100, y = 4400000 + row * 100;
    features.push({ type: "Feature", properties: { klass: (row + col) % 2 + 1 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100], [x, y]]] } });
  }
  const classes = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "classes.geojson")).layer;
  const raster = (await finished("wasm_vector_polygons_to_raster", {
    input: classes.id, field: "klass", cell_size: 100, output_name: "classes_raster",
  })).layer;
  const filtered = await finished("wasm_majority_filter", {
    input: raster.id, filter_size_x: 3, filter_size_y: 3, output_name: "majority_clean",
  });
  const filteredLayer = filtered.layer ?? filtered.layers?.[0]?.layer;
  assert.equal(filteredLayer?.kind, "raster", "majority filter result must be a raster layer, not a generic attachment");
  assert.equal(filtered.attachments, undefined);
  const buffered = await finished("wasm_buffer_raster", {
    input: filteredLayer.id, buffer_size: 1, grid_cell_units: true, output_name: "class_buffer",
  });
  const bufferedLayer = buffered.layer ?? buffered.layers?.[0]?.layer;
  assert.equal(bufferedLayer?.kind, "raster", "raster buffer must publish a raster layer");
  assert.ok(bufferedLayer.raster?.width >= filteredLayer.raster.width);

  const median = await finished("wasm_median_filter", {
    input: filteredLayer.id, filter_size_x: 3, filter_size_y: 3, output_name: "median_clean",
  });
  const medianLayer = median.layer ?? median.layers?.[0]?.layer;
  assert.equal(medianLayer?.kind, "raster", "median filter result must be a raster layer, not a generic attachment");
  assert.equal(median.attachments, undefined);
  const percentile = await finished("wasm_percentile_filter", {
    input: filteredLayer.id, filter_size_x: 3, filter_size_y: 3, output_name: "percentile_clean",
  });
  const percentileLayer = percentile.layer ?? percentile.layers?.[0]?.layer;
  assert.equal(percentileLayer?.kind, "raster", "percentile filter result must be a raster layer, not a generic attachment");
  assert.equal(percentile.attachments, undefined);
});

test("euclidean and cost allocation tools publish raster surfaces from real inputs", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cells = [] as any[];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
    const x = 500000 + col * 100, y = 4400000 + row * 100;
    cells.push({ type: "Feature", properties: { source: row === 2 && col === 2 ? 1 : 0, friction: 1 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100], [x, y]]] } });
  }
  const grid = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features: cells })]), "allocation_grid.geojson")).layer;
  const source = (await finished("wasm_vector_polygons_to_raster", { input: grid.id, field: "source", cell_size: 100, output_name: "allocation_source" })).layer;
  const friction = (await finished("wasm_vector_polygons_to_raster", { input: grid.id, field: "friction", cell_size: 100, output_name: "allocation_friction" })).layer;

  const euclidean = await finished("wasm_euclidean_allocation", { input: source.id, output_name: "euclidean_regions" });
  const euclideanLayer = euclidean.layer ?? euclidean.layers?.[0]?.layer;
  assert.equal(euclideanLayer.kind, "raster");
  assert.equal(euclideanLayer.raster?.width, source.raster?.width);

  const direction = await finished("wasm_euclidean_direction", { input: source.id, output_name: "euclidean_direction" });
  assert.equal(direction.layers?.length, 3, "Euclidean direction must publish direction, distance and back-direction rasters");
  assert.ok(direction.layers?.every((item: any) => item.layer?.kind === "raster"));
  assert.ok(direction.layers?.every((item: any) => item.layer?.raster?.width === source.raster?.width));
  assert.equal(direction.attachments, undefined);

  const distance = await finished("wasm_cost_distance", { source: source.id, cost: friction.id, output_name: "cost_surface" });
  assert.equal(distance.layers?.length, 2, "cost distance must publish both the cost and backlink rasters");
  const backlink = distance.layers?.find((item: any) => item.layer?.name?.includes("backlink"))?.layer;
  assert.ok(backlink, "cost distance must expose its backlink raster");
  const allocation = await finished("wasm_cost_allocation", { source: source.id, backlink: backlink.id, output_name: "cost_regions" });
  const allocationLayer = allocation.layer ?? allocation.layers?.[0]?.layer;
  assert.equal(allocationLayer.kind, "raster");
  assert.equal(allocationLayer.raster?.width, source.raster?.width);
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

test("real raster/vector conversion and IDW/TIN interpolation produce displayed layers", async () => {
  const square = { type: "Feature", properties: { id: 1 },
    geometry: { type: "Polygon", coordinates: [[[116, 39], [116.05, 39], [116.05, 39.05], [116, 39.05], [116, 39]]] } };
  const polygons = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", features: [square] })]), "convert-source.geojson")).layer;
  const raster = await finished("wasm_vector_polygons_to_raster", { input: polygons.id, field: "id", cell_size: 0.0025, output_name: "convert-raster" });
  const rasterLayer = raster.layer ?? raster.layers?.[0]?.layer;
  assert.equal(rasterLayer.kind, "raster");

  const vector = await finished("wasm_raster_to_vector_polygons", { input: rasterLayer.id, output_name: "polygonized" });
  const vectorLayer = vector.layer ?? vector.layers?.[0]?.layer;
  assert.ok(vectorLayer.feature_count > 0, "raster-to-polygon must emit real polygons");
  assert.ok(vectorLayer.geometry_types.every((type: string) => ["Polygon", "MultiPolygon"].includes(type)));

  const points = await sample("interpolation-points");
  const pointRaster = await finished("wasm_vector_points_to_raster", { input: points.id, field: "id", cell_size: 0.001, output_name: "sampled-points" });
  const pointRasterLayer = pointRaster.layer ?? pointRaster.layers?.[0]?.layer;
  const extracted = await finished("wasm_raster_to_vector_points", { input: pointRasterLayer.id, output_name: "pointized" });
  const extractedLayer = extracted.layer ?? extracted.layers?.[0]?.layer;
  assert.ok(extractedLayer.feature_count > 0, "raster-to-point must emit real point cells");
  assert.ok(extractedLayer.geometry_types.every((type: string) => type === "Point"));

  for (const [tool, output] of [["wasm_idw_interpolation", "idw-surface"], ["wasm_tin_interpolation", "tin-surface"]]) {
    const result = await finished(tool, { points: points.id, field_name: "id", cell_size: 0.001, output_name: output });
    const layer = result.layer ?? result.layers?.[0]?.layer;
    assert.equal(layer.kind, "raster", `${tool} must create a raster layer`);
    assert.ok(layer.raster?.width > 1 && layer.raster?.height > 1, `${tool} must create a real grid`);
  }
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

  const slope = await finished("wasm_slope", { input: demLayer.id, units: "degrees", z_factor: 1, output_name: "synthetic_slope" });
  const slopeLayer = slope.layer ?? slope.layers?.[0]?.layer;
  const sca = await finished("wasm_d8_flow_accum", {
    input: outputs[1].id, input_is_pointer: true, out_type: "sca", output_name: "synthetic_sca",
  });
  const scaLayer = sca.layer ?? sca.layers?.[0]?.layer;
  const wetness = await finished("wasm_wetness_index", {
    sca: scaLayer.id, slope: slopeLayer.id, output_name: "synthetic_wetness",
  });
  const wetnessLayer = wetness.layer ?? wetness.layers?.[0]?.layer;
  assert.equal(wetnessLayer.kind, "raster", "wetness index must publish a raster");
  assert.equal(wetnessLayer.raster?.width, demLayer.raster?.width);
  assert.equal(wetness.attachments, undefined);

  for (const [tool, output] of [["wasm_strahler_stream_order", "strahler_order"],
    ["wasm_hack_stream_order", "hack_order"]]) {
    const order = await finished(tool, {
      d8_pntr: outputs[1].id, streams: outputs[3].id, esri_pntr: false, zero_background: false, output_name: output,
    });
    const orderLayer = order.layer ?? order.layers?.[0]?.layer;
    assert.equal(orderLayer.kind, "raster", `${tool} must publish a raster`);
    assert.equal(orderLayer.raster?.width, outputs[1].raster?.width);
    assert.equal(order.attachments, undefined);
  }

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

test("change vector analysis publishes magnitude and direction rasters", async () => {
  const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32650" } };
  const cell = 100, features: any[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const x = 500000 + col * cell, y = 4400000 + row * cell;
    features.push({ type: "Feature", properties: { before: 100 + row * 3 + col, after: 80 + row * 4 + col * 2 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell], [x, y]]] } });
  }
  const source = (await importBrowserFile(new Blob([JSON.stringify({ type: "FeatureCollection", crs, features })]), "cva_source.geojson")).layer;
  const before = (await finished("wasm_vector_polygons_to_raster", {
    input: source.id, field: "before", cell_size: cell, output_name: "cva_before",
  })).layer;
  const after = (await finished("wasm_vector_polygons_to_raster", {
    input: source.id, field: "after", cell_size: cell, output_name: "cva_after",
  })).layer;
  const change = await finished("wasm_change_vector_analysis", {
    date1: [before.id], date2: [after.id], output_name: "cva_change",
  });
  assert.equal(change.layers?.length, 2, "CVA must publish both magnitude and direction rasters");
  assert.ok(change.layers?.every((item: any) => item.layer?.kind === "raster"));
  assert.ok(change.layers?.some((item: any) => item.layer?.name?.includes("magnitude_output")));
  assert.ok(change.layers?.some((item: any) => item.layer?.name?.includes("direction_output")));
  assert.equal(change.attachments, undefined);
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
  const connectivity = await finished("wasm_cost_connectivity", {
    sources: points.id, cost: resistance.id, connections: "mst", id_field: "id", output_name: "cost_network",
  });
  const connectivityLayer = connectivity.layer ?? connectivity.layers?.[0]?.layer;
  assert.ok(connectivityLayer.feature_count >= 1, "cost connectivity must connect the source points");
  assert.ok(connectivityLayer.geometry_types.every((type: string) => type === "LineString" || type === "MultiLineString"));
  assert.equal(connectivity.attachments, undefined);

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
  for (const [query, expected] of [["等值线", "wasm_contours_from_raster"], ["成本距离", "wasm_cost_distance"],
    ["点提取", "wasm_extract_raster_values_at_points"], ["色彩合成", "wasm_create_colour_composite"]]) {
    assert.equal(searchBrowserTools(browserCatalog, query, { limit: 1 })[0]?.name, expected, `${query} should rank ${expected} first`);
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
  const recovered = buildBrowserSystemPrompt([{ id: "lyr_prompt", name: "道路", kind: "vector" }], {
    aoi: [116.1, 39.1, 116.4, 39.4], selectedLayerId: "lyr_prompt", selectedLayerName: "道路",
    recovery: { layerCount: 1, selectedLayerName: "道路", selectionCount: 2, hasAoi: true, transcriptAvailable: false,
      goals: ["检查道路连通性"], tools: ["describe_layer"] },
    agentSession: { goals: ["检查道路连通性"], tools: ["describe_layer"] },
  });
  assert.match(recovered, /页面恢复说明/);
  assert.match(recovered, /不得补造、概括或声称发生过未显示的旧对话/);
  assert.match(recovered, /检查道路连通性/);
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

test("workspace snapshots validate AOI, selection, layer metadata and capped agent recovery", () => {
  const layer = { id: "lyr_test", name: "测试栅格", url: "blob:preview", geometry_types: [], feature_count: 0, bounds: [116, 39, 117, 40], crs: "EPSG:4326", kind: "raster" as const };
  const snapshot = buildWorkspaceSnapshot([layer], {
    selectedLayerId: layer.id, aoi: [116, 39, 116.5, 39.5], selection: { layerId: layer.id, featureIds: [1, 2, 2] }, tableLayerId: null,
    agent: { goals: ["目标一", "目标二", "目标三", "目标四"], tools: ["a", "b", "a", "c", "d", "e", "f", "g", "h", "i"] },
  }, 1234);
  assert.equal(snapshot.schema, WORKSPACE_SCHEMA);
  assert.equal(snapshot.version, WORKSPACE_VERSION);
  assert.deepEqual(snapshot.aoi, [116, 39, 116.5, 39.5]);
  assert.deepEqual(snapshot.selection?.featureIds, [1, 2]);
  assert.ok(!("url" in snapshot.layers[0]));
  const restored = normalizeWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored?.selectedLayerId, layer.id);
  assert.equal(restored?.layers[0].kind, "raster");
  assert.equal(restored?.agent?.goals.length, AGENT_GOAL_LIMIT);
  assert.deepEqual(restored?.agent?.goals, ["目标二", "目标三", "目标四"]);
  assert.deepEqual(restored?.agent?.tools, ["a", "c", "d", "e", "f", "g", "h", "i"]);
  assert.equal(buildAgentSessionStub(["x", "y", "z", "latest"], [])?.goals[0], "y");
  assert.deepEqual(buildAgentSessionStub(["甲", "乙", "甲"], ["describe_layer", "run_tool", "describe_layer"]), {
    goals: ["乙", "甲"], tools: ["run_tool", "describe_layer"],
  });
  assert.deepEqual(normalizeWorkspaceRecovery({ layerCount: 2, selectionCount: 3, hasAoi: true, goals: ["g"], tools: ["t"] }), {
    layerCount: 2, selectedLayerName: null, selectionCount: 3, hasAoi: true, transcriptAvailable: false, goals: ["g"], tools: ["t"],
  });
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
    selection: { layerId: "lyr_1", featureIds: [2, 5] }, agentSession: { goals: ["检查道路网络"], tools: ["describe_layer", "least_cost_path_pipeline"] },
    outputs: ["/work/path.fgb"], pendingJobs: ["job_demo"] };
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
  assert.match(handoff, /Persisted session stub/);
  assert.match(handoff, /检查道路网络/);
  const archiveId = /read_browser_output with id=([a-f0-9]{32})/.exec(handoff)?.[1];
  assert.ok(archiveId);
  const archive = await readBrowserContextRecord("compact-test", archiveId, 0, 120);
  assert.equal(archive.kind, "message-archive");
  assert.match(archive.text, /轮决策/);
});
