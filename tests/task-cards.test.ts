/**
 * Stage 4 task-card unit tests: the preset builders must produce plans that
 * pass plan-time validation, the mobile pixel budget must refuse oversized
 * rasters, and slot suggestions must not collide on two-layer presets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBILE_MAX_PIXELS, TASK_CARDS, cardById, suggestDraft, slotMatches, type CardLayerFacts } from "../src/lib/taskCards.ts";
import { validatePlan, type PlanAdapter } from "../shared/plans.ts";

const layer = (over: Partial<CardLayerFacts> & { id: string; name: string }): CardLayerFacts => ({
  kind: "vector", featureCount: 3, geometryTypes: ["Polygon"], crs: "EPSG:4326", ...over,
});

const FACTS: CardLayerFacts[] = [
  layer({ id: "pts", name: "beijing_points", geometryTypes: ["Point"], featureCount: 5 }),
  layer({ id: "zones", name: "district_zones", featureCount: 3, fields: [{ name: "pop", type: "number" }, { name: "zone", type: "string" }] }),
  layer({ id: "mask", name: "zone_a", featureCount: 1 }),
  { id: "dem", name: "dem_hills", kind: "raster", raster: { width: 120, height: 100 } },
  { id: "big", name: "dem_over_budget", kind: "raster", raster: { width: 1600, height: 1400 } },
];

const adapter: PlanAdapter = {
  provider: "browser-wasm",
  async getLayer(ref) { return FACTS.find(item => item.id === ref || item.name === ref); },
  async runStep() { throw new Error("runStep not needed for plan validation"); },
};

const draftFor = (id: string, facts = FACTS) => {
  const preset = cardById(id)!;
  const draft = suggestDraft(preset, facts);
  draft.goal = draft.goal || preset.defaultGoal(draft, facts);
  return { preset, draft };
};

test("all presets build plans that pass plan-time validation", async () => {
  assert.equal(TASK_CARDS.length, 5, "first mobile batch keeps five task cards");
  const cases: string[] = ["buffer-points", "clip-polygons", "intersect-area", "dem-slope"];
  for (const id of cases) {
    const { preset, draft } = draftFor(id);
    const built = preset.build(draft, FACTS);
    assert.ok(built.ok, `${id} should build: ${built.ok ? "" : built.reason}`);
    const issues = await validatePlan(built.plan, adapter);
    assert.deepEqual(issues, [], `${id} plan must pass validation`);
    assert.match(built.explanation.engine, /本地/);
  }
});

test("field-stats builds and validates against the numeric field", async () => {
  const preset = cardById("field-stats")!;
  const draft = suggestDraft(preset, FACTS);
  draft.inputs.layer = "zones";
  draft.field = "pop";
  const built = preset.build(draft, FACTS);
  assert.ok(built.ok, built.ok ? "" : built.reason);
  const issues = await validatePlan(built.plan, adapter);
  assert.deepEqual(issues, []);
  assert.equal(built.plan.steps[0].kind, "tool");
});

test("the mobile pixel budget refuses oversized rasters with a degrade path", async () => {
  const { preset, draft } = draftFor("dem-slope");
  draft.inputs.dem = "big";
  const built = preset.build(draft, FACTS);
  assert.equal(built.ok, false);
  assert.match(built.reason, /超出手机端预算/);
  assert.match(built.degrade, /裁剪|降采样|桌面/);
  assert.ok(1600 * 1400 > MOBILE_MAX_PIXELS);
  // The in-budget DEM still passes.
  draft.inputs.dem = "dem";
  const ok = preset.build(draft, FACTS);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.explanation.budget ?? "", /预算/);
});

test("two-layer presets get distinct suggested inputs", () => {
  for (const id of ["clip-polygons", "intersect-area"]) {
    const draft = suggestDraft(cardById(id)!, FACTS);
    const values = Object.values(draft.inputs);
    assert.equal(new Set(values).size, values.length, `${id} slots must not collide`);
  }
});

test("same-layer clip/intersect is blocked with a reason, not silently run", () => {
  for (const id of ["clip-polygons", "intersect-area"]) {
    const preset = cardById(id)!;
    const draft = suggestDraft(preset, FACTS);
    const [first] = Object.keys(draft.inputs);
    draft.inputs[first] = "zones";
    const other = Object.keys(draft.inputs).find(key => key !== first)!;
    draft.inputs[other] = "zones";
    const built = preset.build(draft, FACTS);
    assert.equal(built.ok, false);
    assert.match(built.reason, /同一个图层/);
  }
});

test("slotMatches separates point/polygon/raster families", () => {
  const points = FACTS[0], polygons = FACTS[1], raster = FACTS[3];
  assert.equal(slotMatches(points, "vector", "point"), true);
  assert.equal(slotMatches(polygons, "vector", "point"), false);
  assert.equal(slotMatches(polygons, "vector", "polygon"), true);
  assert.equal(slotMatches(points, "vector", "polygon"), false);
  assert.equal(slotMatches(raster, "raster"), true);
  assert.equal(slotMatches(raster, "vector"), false);
});

test("presets without matching layers report unavailability instead of building", () => {
  const empty: CardLayerFacts[] = [];
  const { preset, draft } = draftFor("buffer-points", empty);
  const built = preset.build(draft, empty);
  assert.equal(built.ok, false);
  assert.match(built.reason, /点图层/);
});
