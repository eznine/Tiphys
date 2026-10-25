/**
 * Tool discovery regression (stage 2, T-005).
 *
 * The floor values are the measured baseline from the first run of this same
 * harness, minus a little slack. They are regression guards, not a quality
 * claim: the numbers that matter are printed by `npm run eval:search`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, preview } from "../scripts/search-eval.ts";
import { catalogForEvaluation } from "../scripts/search-eval.ts";
import { searchBrowserToolCandidates, searchBrowserTools } from "../src/lib/browser/search.ts";
import { compactTool, toolCapabilities } from "../src/lib/browser/candidates.ts";

const DATASET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "search", "labeled-queries.json");

test("the discovery set is large, complete and internally consistent", () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, "utf8")) as { entries: { query: string; expect: string[]; group: string }[] };
  assert.ok(dataset.entries.length >= 200, `only ${dataset.entries.length} labeled queries`);
  const groups = new Set(dataset.entries.map(entry => entry.group));
  for (const group of ["natural", "alias", "gap"]) assert.ok(groups.has(group), `missing group ${group}`);
  const report = evaluate();
  assert.deepEqual(report.missingLabels, [], "labels must reference real tools");
  assert.equal(report.total, dataset.entries.length);
});

test("discovery quality stays at the measured baseline", () => {
  const report = evaluate();
  assert.ok(report.natural.top1 >= 0.78, `natural Top-1 ${report.natural.top1}`);
  assert.ok(report.natural.top5 >= 0.95, `natural Top-5 ${report.natural.top5}`);
  assert.ok(report.aliases.top1 >= 0.95, `alias Top-1 ${report.aliases.top1}`);
  assert.ok(report.gap.confidentRate <= 0.4, `gap confident ${report.gap.confidentRate}`);
});

test("candidates are capability-annotated and much smaller than full schemas", () => {
  const sample = preview("统计每个区的平均高程");
  assert.ok(sample.candidates.length > 0);
  assert.ok(sample.bytes < sample.fullBytes * 0.75, `compact ${sample.bytes} vs full ${sample.fullBytes}`);
  const zonal = sample.candidates.find(candidate => candidate.name === "wasm_zonal_statistics" || candidate.name === "zonal_statistics");
  assert.ok(zonal, "zonal statistics must be found from task phrasing");
  // Upstream marks both inputs as raster (zone raster), so the contract only
  // promises raster inputs; we do not upgrade that claim here.
  assert.deepEqual(zonal!.inputKinds, ["raster"]);
  assert.ok(zonal!.params.some(param => param.name === "stat_type"));
  // Layer parameters must keep their exact callable names; inputKinds alone
  // cannot tell the model whether to send `input`, `features` or `d8_pntr`.
  const input = zonal!.params.find(param => param.name === "input");
  assert.equal(input?.kind, "raster");
  assert.equal(input?.required, true);
});

test("layer parameter cards expose hydrology wire names", () => {
  const { tools, searchable } = catalogForEvaluation();
  const basins = compactTool(tools.find(tool => tool.name === "wasm_basins")!);
  const d8 = basins.params.find(param => param.name === "d8_pntr");
  assert.deepEqual(
    { kind: d8?.kind, required: d8?.required, label: d8?.label },
    { kind: "raster", required: true, label: "上游 D8 流向栅格" },
  );
  assert.equal(basins.params[0].name, "d8_pntr", "required layer params come first");

  const watershed = compactTool(tools.find(tool => tool.name === "wasm_watershed")!);
  const pour = watershed.params.find(param => param.name === "pour_pts");
  assert.equal(pour?.kind, "vector");
  assert.equal(pour?.required, true);
  assert.equal(pour?.label, "汇水点图层");

  const hillslopes = compactTool(tools.find(tool => tool.name === "wasm_hillslopes")!);
  const streams = hillslopes.params.find(param => param.name === "streams");
  assert.equal(streams?.kind, "raster");
  assert.equal(streams?.required, true);

  for (const query of ["流域", "basins", "分水岭"]) {
    const candidates = searchBrowserToolCandidates(tools, query, { searchable, limit: 5 });
    const found = candidates.find(candidate => candidate.name === "wasm_basins");
    assert.ok(found, `${query} must surface wasm_basins`);
    assert.ok(found.params.some(param => param.name === "d8_pntr" && param.required));
  }
});

test("input-kind filters exclude tools whose data contract does not fit", () => {
  const { tools, searchable } = catalogForEvaluation();
  const rasterOnly = searchBrowserTools(tools, "坡度", { searchable, inputKind: "raster", limit: 10 });
  assert.ok(rasterOnly.some(tool => tool.name === "wasm_slope"));
  assert.ok(rasterOnly.every(tool => toolCapabilities(tool).inputKinds.includes("raster")));
  const vectorOnly = searchBrowserTools(tools, "坡度", { searchable, inputKind: "vector", limit: 10 });
  assert.ok(!vectorOnly.some(tool => tool.name === "wasm_slope"), "a DEM tool must not pass a vector filter");
  assert.ok(vectorOnly.every(tool => toolCapabilities(tool).inputKinds.includes("vector")));
  const gee = searchBrowserTools(tools, "影像", { searchable, provider: "gee", limit: 5 });
  assert.ok(gee.length > 0 && gee.every(tool => tool.name.startsWith("gee_")));
});

test("generic polygon phrasing reaches the raster-to-polygon tool", () => {
  const { tools, searchable } = catalogForEvaluation();
  for (const query of ["转成面图层", "把栅格转为面", "生成面图层", "栅格面化"]) {
    const found = searchBrowserToolCandidates(tools, query, { searchable, limit: 5 });
    assert.ok(found.some(candidate => candidate.name === "wasm_raster_to_vector_polygons"), `${query} must surface raster_to_vector_polygons`);
  }
  const rasterOnly = searchBrowserTools(tools, "转成面图层", { searchable, inputKind: "raster", limit: 5 });
  assert.ok(rasterOnly.some(tool => tool.name === "wasm_raster_to_vector_polygons"));
  assert.ok(rasterOnly.every(tool => toolCapabilities(tool).inputKinds.includes("raster")));
});

test("hydrology wording reaches the real D8 accumulation and pointer ids", () => {
  const { tools, searchable } = catalogForEvaluation();
  const flow = searchBrowserTools(tools, "汇流累积量", { searchable, inputKind: "raster", limit: 5 });
  assert.ok(flow.some(tool => tool.name === "wasm_d8_flow_accum"), "汇流累积量 must reach d8_flow_accum");
  const pointer = searchBrowserToolCandidates(tools, "D8 流向", { searchable, inputKind: "raster", limit: 5 });
  assert.equal(pointer[0]?.name, "wasm_d8_pointer", "D8 流向 must rank d8_pointer first");
});

test("compact view never invents capabilities the catalog lacks", () => {
  const { tools } = catalogForEvaluation();
  const noInputs = tools.find(tool => (tool.parameters.properties ?? {}) && Object.values(tool.parameters.properties ?? {}).every(schema => !schema["x-layer"]));
  if (noInputs) {
    const compact = compactTool(noInputs);
    assert.deepEqual(compact.inputKinds, []);
  }
  const slope = tools.find(tool => tool.name === "wasm_slope")!;
  const capabilities = toolCapabilities(slope);
  assert.deepEqual(capabilities.inputKinds, ["raster"]);
  assert.equal(capabilities.provider, "local");
});
