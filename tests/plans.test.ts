/**
 * Stage 3 unit tests: plan validation, error classification, the deterministic
 * executor (with a fake adapter), honest reporting and audit invariants.
 *
 * Engine-level behaviour (real WASM plans) lives in scripts/run-plan-baseline.ts;
 * these tests pin down the control flow that must never depend on an engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TOOLS, auditRuns, classifyError, executePlan, honestReport, resumePlan,
  validatePlan, type LayerLite, type Plan, type PlanAdapter, type PlanRun, type ResolvedStep, type StepOutcome,
} from "../shared/plans.ts";
import { planOperation } from "../shared/contracts/index.ts";

const layer = (over: Partial<LayerLite> & { id: string }): LayerLite => ({
  name: over.id, kind: "vector", crs: "EPSG:4326", featureCount: 3, geometryTypes: ["Point"], sha256: `sha256:${over.id}`, ...over,
});

const LAYERS: LayerLite[] = [
  layer({ id: "pts", name: "点", featureCount: 5 }),
  layer({ id: "zones", name: "分区", geometryTypes: ["Polygon"] }),
];

type Behavior = (resolved: ResolvedStep, signal: AbortSignal) => Promise<StepOutcome>;

function fakeAdapter(behavior: Behavior, saved: PlanRun[] = []): PlanAdapter {
  return {
    provider: "browser-wasm",
    async getLayer(ref) { return LAYERS.find(item => item.id === ref || item.name === ref); },
    async geojson(id) { return { type: "FeatureCollection", bbox: [116, 39, 117, 40], features: [] }; },
    async runStep(resolved, signal) { return behavior(resolved, signal); },
    async save(run) { saved.push(run); },
  };
}

/** Default behaviour: contract operations go through planOperation; tools echo a layer. */
const defaultBehavior: Behavior = async (resolved) => {
  if (resolved.kind === "operation") {
    const input = LAYERS.find(item => item.id === resolved.spec.input) ?? LAYERS[0];
    const decision = planOperation(resolved.spec, { id: input.id, crs: input.crs ?? "", kind: input.kind });
    if (decision.action === "reject") throw new Error(decision.errors.join(" "));
    if (decision.action === "noop") return { noop: decision.reason, layer: input };
    return { layer: layer({ id: `${input.id}_${decision.tool}`, crs: input.crs, featureCount: input.featureCount, geometryTypes: input.geometryTypes }) };
  }
  return { layer: LAYERS[0], result: { ok: true } };
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const bufferPlan = (): Plan => ({
  goal: "测试计划",
  steps: [
    { id: "s1", kind: "operation", spec: { operation: "gis.buffer", version: 1, input: "pts", params: { distance: 500, units: "meters" } } },
    { id: "s2", kind: "operation", dependsOn: ["s1"], spec: { operation: "gis.buffer", version: 1, input: "@s1", params: { distance: 100, units: "meters" } } },
    { id: "s3", kind: "tool", dependsOn: ["s2"], tool: "zoom_to_layer", args: { layer: "@s2" } },
  ],
});

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

test("validatePlan rejects unsupported operations at plan time with a degrade path", async () => {
  const plan: Plan = { goal: "融合", steps: [
    { id: "d", kind: "operation", spec: { operation: "gis.dissolve", version: 1, input: "zones", params: { field: "kind" } } },
  ] };
  const issues = await validatePlan(plan, fakeAdapter(defaultBehavior));
  assert.ok(issues.length >= 1);
  const unsupported = issues.find(issue => issue.class === "UNSUPPORTED");
  assert.ok(unsupported, "dissolve on browser-wasm must be UNSUPPORTED");
  assert.equal(unsupported!.stepId, "d");
  assert.match(unsupported!.message, /不支持/);
  assert.ok(unsupported!.next?.includes("降级方案"), "degrade advice must be attached");
});

test("validatePlan flags unknown/forward dependencies, duplicate ids, missing layers, bad params", async () => {
  const adapter = fakeAdapter(defaultBehavior);
  const forward: Plan = { goal: "g", steps: [
    { id: "a", kind: "tool", dependsOn: ["b"], tool: "zoom_to_layer", args: { layer: "pts" } },
    { id: "b", kind: "tool", tool: "zoom_to_layer", args: { layer: "pts" } },
  ] };
  assert.ok((await validatePlan(forward, adapter)).some(issue => /必须排在当前步骤之前/.test(issue.message)));

  const ghost: Plan = { goal: "g", steps: [{ id: "a", kind: "tool", tool: "zoom_to_layer", args: { layer: "@ghost" } }] };
  assert.ok((await validatePlan(ghost, adapter)).some(issue => /不存在/.test(issue.message)));

  const missingLayer: Plan = { goal: "g", steps: [{ id: "a", kind: "tool", tool: "zoom_to_layer", args: { layer: "no_such_layer" } }] };
  assert.ok((await validatePlan(missingLayer, adapter)).some(issue => /引用的图层/.test(issue.message)));

  const negative: Plan = { goal: "g", steps: [
    { id: "a", kind: "operation", spec: { operation: "gis.buffer", version: 1, input: "pts", params: { distance: -5, units: "meters" } } },
  ] };
  assert.ok((await validatePlan(negative, adapter)).some(issue => issue.class === "INPUT_ERROR" && /距离/.test(issue.message)));

  const duplicate: Plan = { goal: "g", steps: [
    { id: "a", kind: "tool", tool: "zoom_to_layer", args: { layer: "pts" } },
    { id: "a", kind: "tool", tool: "zoom_to_layer", args: { layer: "pts" } },
  ] };
  assert.ok((await validatePlan(duplicate, adapter)).some(issue => /重复/.test(issue.message)));
});

test("approval tools require an explicit confirmation entry", async () => {
  const adapter = fakeAdapter(defaultBehavior);
  const plan: Plan = { goal: "导出", steps: [
    { id: "exp", kind: "tool", tool: "export_features", args: { layer: "pts", path: "out.geojson", fmt: "geojson" } },
  ] };
  assert.ok(APPROVAL_TOOLS.has("export_features"));
  const blocked = await validatePlan(plan, adapter);
  assert.ok(blocked.some(issue => issue.class === "INPUT_ERROR" && /需要用户确认/.test(issue.message)));
  const approved = await validatePlan({ ...plan, confirmations: ["exp"] }, adapter);
  assert.equal(approved.length, 0);
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

test("classifyError maps messages onto the frozen taxonomy", () => {
  assert.equal(classifyError("找不到图层：x"), "INPUT_ERROR");
  assert.equal(classifyError("距离必须为正数"), "INPUT_ERROR");
  assert.equal(classifyError("RuntimeError: unreachable"), "EXECUTION_ERROR");
  assert.equal(classifyError("已取消，未生成结果"), "USER_CANCELLED");
  assert.equal(classifyError("step timeout: 超出预算"), "RESOURCE_LIMIT");
  assert.equal(classifyError("whatever", { timeout: true }), "RESOURCE_LIMIT");
  assert.equal(classifyError("whatever", { aborted: true }), "USER_CANCELLED");
  assert.equal(classifyError("验收未通过：数量不符"), "VALIDATION_ERROR");
});

// ---------------------------------------------------------------------------
// executor with a fake adapter
// ---------------------------------------------------------------------------

test("executor completes a plan and checkpoints after every step", async () => {
  const saved: PlanRun[] = [];
  const run = await executePlan(bufferPlan(), fakeAdapter(defaultBehavior, saved));
  assert.equal(run.status, "completed");
  assert.equal(run.steps.map(s => s.phase).join(","), "pass,pass,pass");
  assert.ok(run.honest.deliverables.length >= 1);
  assert.equal(run.honest.blockedAt, undefined);
  assert.ok(saved.length >= run.steps.length, "checkpoint written per step plus final");
  assert.equal(auditRuns([run]).ok, true);
});

test("a failing step cascades skips and never reports completion", async () => {
  const behavior: Behavior = async (resolved) => {
    if (resolved.kind === "operation" && (resolved.spec as { params: { distance: number } }).params.distance === 100) throw new Error("RuntimeError: unreachable");
    return defaultBehavior(resolved);
  };
  const run = await executePlan(bufferPlan(), fakeAdapter(behavior));
  assert.equal(run.status, "failed");
  assert.equal(run.steps[0].phase, "pass");
  assert.equal(run.steps[1].phase, "fail");
  assert.equal(run.steps[1].error!.class, "EXECUTION_ERROR");
  assert.equal(run.steps[2].phase, "skipped");
  assert.match(run.steps[2].error!.message, /跳过/);
  assert.equal(run.honest.blockedAt!.stepId, "s2");
  assert.equal(auditRuns([run]).ok, true);
});

test("user abort marks the running step cancelled and later steps never start", async () => {
  const controller = new AbortController();
  const behavior: Behavior = async (resolved, signal) => {
    if (resolved.kind === "tool" && resolved.step.tool === "zoom_to_layer") return defaultBehavior(resolved);
    if (resolved.kind === "operation" && (resolved.spec as { params: { distance: number } }).params.distance === 100) {
      await new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("never resolves this way")), 500);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("已取消")); }, { once: true });
      });
      throw new Error("unreachable");
    }
    // s1 finishes quickly; abort fires while s2 runs
    void setTimeout(() => controller.abort(), 5);
    return defaultBehavior(resolved);
  };
  const run = await executePlan(bufferPlan(), fakeAdapter(behavior), { signal: controller.signal });
  assert.equal(run.status, "cancelled");
  assert.equal(run.steps[0].phase, "pass");
  assert.equal(run.steps[1].phase, "cancelled");
  assert.equal(run.steps[1].error!.class, "USER_CANCELLED");
  assert.equal(run.steps[2].phase, "cancelled");
  assert.match(run.honest.headline, /已取消/);
  assert.ok(run.honest.next.join("").includes("恢复"));
  assert.equal(auditRuns([run]).ok, true);
});

test("step budget expiry classifies as RESOURCE_LIMIT even when the adapter ignores the signal", async () => {
  const behavior: Behavior = async (resolved) => {
    if (resolved.kind === "operation" && (resolved.spec as { params: { distance: number } }).params.distance === 500) {
      await sleep(80);
    }
    return defaultBehavior(resolved);
  };
  const run = await executePlan(bufferPlan(), fakeAdapter(behavior), { stepTimeoutMs: 20 });
  assert.equal(run.status, "failed");
  assert.equal(run.steps[0].phase, "fail");
  assert.equal(run.steps[0].error!.class, "RESOURCE_LIMIT");
  assert.equal(run.steps[1].phase, "skipped");
  assert.equal(auditRuns([run]).ok, true);
});

test("acceptance gate failure yields VALIDATION_ERROR and withholds the deliverable", async () => {
  const plan: Plan = { goal: "验收门", steps: [
    { id: "b", kind: "operation", spec: { operation: "gis.buffer", version: 1, input: "pts", params: { distance: 500, units: "meters" } },
      acceptance: [{ type: "feature_count", value: 999 }] },
    { id: "z", kind: "tool", dependsOn: ["b"], tool: "zoom_to_layer", args: { layer: "@b" } },
  ] };
  const run = await executePlan(plan, fakeAdapter(defaultBehavior));
  assert.equal(run.status, "failed");
  assert.equal(run.steps[0].phase, "fail");
  assert.equal(run.steps[0].error!.class, "VALIDATION_ERROR");
  assert.equal(run.steps[0].acceptance![0].ok, false);
  assert.equal(run.steps[1].phase, "skipped");
  assert.equal(run.honest.deliverables.length, 0, "a gate-failed output is not a deliverable");
  assert.match(run.honest.headline, /未通过验收/);
  assert.equal(auditRuns([run]).ok, true);
});

test("same-CRS reproject is recorded as an explicit no-op, not a new dataset", async () => {
  const plan: Plan = { goal: "no-op", steps: [
    { id: "r", kind: "operation", spec: { operation: "gis.reproject", version: 1, input: "pts", params: { targetCrs: "EPSG:4326" } },
      acceptance: [{ type: "noop" }] },
  ] };
  const run = await executePlan(plan, fakeAdapter(defaultBehavior));
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].phase, "noop");
  assert.equal(run.steps[0].acceptance![0].ok, true);
  assert.equal(run.steps[0].outputLayer!.id, "pts", "no-op returns the original layer");
});

test("plan-time UNSUPPORTED failure executes nothing and keeps the honest degrade advice", async () => {
  const plan: Plan = { goal: "融合", steps: [
    { id: "pre", kind: "operation", spec: { operation: "gis.buffer", version: 1, input: "pts", params: { distance: 100, units: "meters" } } },
    { id: "d", kind: "operation", dependsOn: ["pre"], spec: { operation: "gis.dissolve", version: 1, input: "@pre", params: { field: "kind" } } },
    { id: "post", kind: "tool", dependsOn: ["d"], tool: "zoom_to_layer", args: { layer: "@d" } },
  ] };
  const run = await executePlan(plan, fakeAdapter(defaultBehavior));
  assert.equal(run.status, "failed");
  assert.ok(run.steps.every(step => step.phase !== "pass"), "nothing runs when the plan is rejected");
  assert.equal(run.steps.find(step => step.stepId === "d")!.phase, "fail");
  assert.equal(run.honest.blockedAt!.stepId, "d");
  assert.equal(run.honest.blockedAt!.errorClass, "UNSUPPORTED");
  assert.ok(run.honest.blockedAt!.next.join("").includes("降级"));
  assert.equal(run.honest.deliverables.length, 0);
  assert.equal(auditRuns([run]).ok, true);
});

test("resume reuses the successful prefix instead of re-running it", async () => {
  const run1 = await executePlan(bufferPlan(), fakeAdapter(defaultBehavior), {
    runId: "plan_run1",
    failStep: { stepId: "s2", message: "注入：模拟引擎故障" },
  });
  assert.equal(run1.status, "failed");
  assert.equal(run1.injected, true);

  const run2 = await resumePlan(run1, bufferPlan(), fakeAdapter(defaultBehavior), { runId: "plan_run2" });
  assert.equal(run2.resumedFrom, "plan_run1");
  assert.equal(run2.status, "completed");
  assert.equal(run2.steps[0].reused, true);
  assert.equal(run2.steps[0].phase, "pass");
  assert.equal(run2.steps.filter(step => step.reused).length, 1, "only the successful prefix is reused");
  assert.equal(run2.steps[1].reused, undefined);
  const verdict = auditRuns([run1, run2]);
  assert.equal(verdict.ok, true, verdict.violations.join("; "));
});

test("auditRuns catches fabricated completions", async () => {
  const behavior: Behavior = async (resolved) => {
    if (resolved.kind === "operation" && (resolved.spec as { params: { distance: number } }).params.distance === 100) throw new Error("RuntimeError: unreachable");
    return defaultBehavior(resolved);
  };
  const run = await executePlan(bufferPlan(), fakeAdapter(behavior));
  assert.equal(run.status, "failed");
  // Smallest possible fabrication: flip only the status field.
  const forgedStatus: PlanRun = { ...run, status: "completed" };
  const verdictStatus = auditRuns([forgedStatus]);
  assert.equal(verdictStatus.ok, false);
  assert.ok(verdictStatus.violations.some(v => /假完成|未成功步骤/.test(v)));
  // Fabrication 2: keep the status but silently drop the failing acceptance.
  const gateRun = await executePlan(
    { goal: "g", steps: [{ id: "b", kind: "operation", spec: { operation: "gis.buffer", version: 1, input: "pts", params: { distance: 500, units: "meters" } }, acceptance: [{ type: "feature_count", value: 999 }] }] },
    fakeAdapter(defaultBehavior),
  );
  const forgedAcceptance: PlanRun = { ...gateRun, status: "completed" };
  const verdictGate = auditRuns([forgedAcceptance]);
  assert.equal(verdictGate.ok, false);
  assert.ok(verdictGate.violations.some(v => /验收断言/.test(v)));
});

test("honestReport on a cancelled run states progress and the resume path", () => {
  const report = honestReport({
    runId: "r", planVersion: 1, goal: "g", provider: "browser-wasm", status: "cancelled",
    startedAt: new Date().toISOString(), steps: [
      { stepId: "a", kind: "tool", label: "x", phase: "pass", outputLayer: layer({ id: "l1" }) },
      { stepId: "b", kind: "tool", label: "y", phase: "cancelled", error: { class: "USER_CANCELLED", message: "已取消" } },
    ], planIssues: [],
    honest: { headline: "", deliverables: [], next: [] },
  });
  assert.match(report.headline, /已取消.*1\/2/);
  assert.equal(report.deliverables.length, 1);
  assert.ok(report.next.some(item => item.includes("resume") || item.includes("恢复")));
});
