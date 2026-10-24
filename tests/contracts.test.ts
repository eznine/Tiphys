/** Contract unit tests: pure semantics shared by both executors. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceToMetres,
  finishRun,
  makeOperationSpec,
  newRun,
  normalizeParams,
  parseEpsg,
  planOperation,
  validateResult,
  type BufferSpec,
  type LayerSemantics,
  type ReprojectSpec,
} from "../shared/contracts/index.ts";

const vector: LayerSemantics = { id: "lyr_1", crs: "EPSG:4326", kind: "vector" };

test("distance units convert to metres", () => {
  assert.equal(distanceToMetres(1, "kilometers"), 1000);
  assert.equal(distanceToMetres(1, "miles"), 1609.344);
  assert.throws(() => distanceToMetres(-500, "meters"), /正数/);
  assert.throws(() => distanceToMetres(0, "meters"), /正数/);
  assert.throws(() => distanceToMetres(5001, "kilometers"), /5000 公里/);
  assert.throws(() => distanceToMetres(Number.NaN, "meters"), /有限数值/);
});

test("EPSG parsing is strict about the authority form", () => {
  assert.equal(parseEpsg("EPSG:32650"), 32650);
  assert.equal(parseEpsg("epsg:3857"), 3857);
  assert.equal(parseEpsg("+proj=utm +zone=50"), null);
  assert.equal(parseEpsg("EPSG:0"), null);
  assert.equal(parseEpsg("EPSG:abc"), null);
  assert.equal(parseEpsg(undefined), null);
});

test("buffer rejects zero, negative, unknown units and non-vector input", () => {
  const zero: BufferSpec = { operation: "gis.buffer", version: 1, input: "lyr_1", params: { distance: 0, units: "meters" } };
  assert.equal(normalizeParams(zero).ok, false);
  assert.equal(planOperation(zero, vector).action, "reject");
  const negative: BufferSpec = { operation: "gis.buffer", version: 1, input: "lyr_1", params: { distance: -100, units: "meters" } };
  assert.equal(planOperation(negative, vector).action, "reject");

  const bogus: BufferSpec = { operation: "gis.buffer", version: 1, input: "lyr_1", params: { distance: 500, units: "feet" as never } };
  assert.equal(planOperation(bogus, vector).action, "reject");

  const rasterPlan = planOperation({ operation: "gis.buffer", version: 1, input: "r", params: { distance: 10, units: "meters" } },
    { id: "r", crs: "EPSG:4326", kind: "raster" });
  assert.equal(rasterPlan.action, "reject");

  const unknownCrs = planOperation({ operation: "gis.buffer", version: 1, input: "x", params: { distance: 10, units: "meters" } },
    { id: "x", crs: "", kind: "vector" });
  assert.equal(unknownCrs.action, "reject");
});

test("buffer plan passes the request through unchanged and defaults dissolve to false", () => {
  const spec: BufferSpec = { operation: "gis.buffer", version: 1, input: "lyr_1", params: { distance: 1.5, units: "kilometers" } };
  const plan = planOperation(spec, vector);
  assert.equal(plan.action, "invoke");
  if (plan.action !== "invoke") return;
  assert.equal(plan.tool, "buffer");
  assert.deepEqual(plan.args, { layer: "lyr_1", distance: 1.5, units: "kilometers", dissolve: false });

  const named = planOperation({ ...spec, params: { ...spec.params, dissolve: true, outputName: "服务圈" } }, vector);
  assert.equal(named.action, "invoke");
  if (named.action !== "invoke") return;
  assert.equal(named.args.output_name, "服务圈");
  assert.equal(named.args.dissolve, true);
});

test("reproject to the current CRS is an explicit no-op, not a fake dataset", () => {
  const same: ReprojectSpec = { operation: "gis.reproject", version: 1, input: "lyr_1", params: { targetCrs: "EPSG:4326" } };
  const plan = planOperation(same, vector);
  assert.equal(plan.action, "noop");
  if (plan.action === "noop") assert.match(plan.reason, /已经是 EPSG:4326/);

  const move = planOperation({ ...same, params: { targetCrs: "epsg:3857" } }, vector);
  assert.equal(move.action, "invoke");
  if (move.action !== "invoke") return;
  assert.equal(move.args.target_crs, "EPSG:3857");
  assert.equal(move.tool, "reproject");
});

test("makeOperationSpec coerces loose input and reports errors instead of guessing", () => {
  const made = makeOperationSpec("gis.buffer", "lyr_1", { distance: "800", units: "meters" });
  assert.equal(made.ok, true);
  if (made.ok) assert.equal((made.spec.params as { distance: number }).distance, 800);

  const bad = makeOperationSpec("gis.buffer", "lyr_1", { distance: "很多", units: "meters" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.errors.join(" "), /有限数值/);

  const unknown = makeOperationSpec("gis.clip", "lyr_1", {});
  assert.equal(unknown.ok, false);
  const badReproject = makeOperationSpec("gis.reproject", "lyr_1", { targetCrs: "4326" });
  assert.equal(badReproject.ok, false);
});

test("result validation gates radius and target CRS", () => {
  const buffer: BufferSpec = { operation: "gis.buffer", version: 1, input: "lyr_1", params: { distance: 500, units: "meters" } };
  const good = validateResult(buffer, { outputKind: "vector", outputCrs: "EPSG:32650", featureCount: 3, radiusErrorMetres: 0.4 });
  assert.equal(good.status, "pass");
  const bad = validateResult(buffer, { outputKind: "vector", outputCrs: "EPSG:32650", featureCount: 3, radiusErrorMetres: 40 });
  assert.equal(bad.status, "fail");
  const empty = validateResult(buffer, { outputKind: "vector", outputCrs: "EPSG:32650", featureCount: 0, emptyInput: true });
  assert.equal(empty.status, "pass", "an empty input may legitimately produce an empty output");

  const reproject: ReprojectSpec = { operation: "gis.reproject", version: 1, input: "lyr_1", params: { targetCrs: "EPSG:3857" } };
  assert.equal(validateResult(reproject, { outputKind: "vector", outputCrs: "EPSG:3857", featureCount: 3 }).status, "pass");
  assert.equal(validateResult(reproject, { outputKind: "vector", outputCrs: "EPSG:4326", featureCount: 3 }).status, "fail");
});

test("runs carry identity, version and a measured duration", () => {
  const spec: BufferSpec = { operation: "gis.buffer", version: 1, input: "lyr_1", params: { distance: 1, units: "kilometers" } };
  const run = newRun(spec, "browser-wasm", { layerId: "lyr_1", crs: "EPSG:4326", sha256: "sha256:abc" });
  assert.equal(run.status, "running");
  assert.equal(run.version, 1);
  assert.equal(run.validation.status, "not_tested");
  const done = finishRun(run, { status: "completed", outputs: [] });
  assert.equal(done.status, "completed");
  assert.ok((done.durationMs ?? -1) >= 0);
  assert.ok(done.finishedAt);
});