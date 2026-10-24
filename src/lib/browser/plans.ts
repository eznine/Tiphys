/**
 * Browser-WASM adapter for the shared plan executor (stage 3).
 *
 * The executor in shared/plans.ts owns control flow; this file only translates
 * between it and the browser engine: layer lookup, tool invocation with job
 * polling/cancellation, digests, and IndexedDB persistence of run records.
 */
import { executePlan, resumePlan, type LayerLite, type Plan, type PlanAdapter, type PlanRun, type ResolvedStep, type StepOutcome } from "../../../shared/plans.ts";
import { planOperation } from "../../../shared/contracts/index.ts";
import { runEngineStep } from "./engine";
import { readRecord, records, writeRecord } from "./storage";

const HASH_LIMIT = 64 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length > HASH_LIMIT) return null;
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Describe via the engine so name→id resolution matches every other entry point. */
async function describeLayer(ref: string): Promise<Record<string, any> | undefined> {
  try {
    return (await runEngineStep("describe_layer", { layer: ref })) as Record<string, any>;
  } catch {
    return undefined;
  }
}

async function toLayerLite(info: Record<string, any>): Promise<LayerLite> {
  const stored = await readRecord<{ bytes?: Uint8Array }>(`layer:${info.id}`);
  return {
    id: String(info.id),
    name: String(info.name ?? info.id),
    kind: info.kind ?? "vector",
    crs: info.crs,
    featureCount: info.feature_count,
    geometryTypes: info.geometry_types ?? [],
    raster: info.raster ? { width: info.raster.width, height: info.raster.height, bands: info.raster.bands } : null,
    sha256: stored?.bytes ? await sha256Hex(stored.bytes) : null,
  };
}

/**
 * Runs one step directly through the engine. The plan itself executes inside a
 * single engine job that holds the GIS lock; nested per-step jobs would
 * deadlock on that lock, so steps run inline and honour the abort signal.
 */
async function runStepTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, any>> {
  return runEngineStep(name, args, signal);
}

/** Extracts the adopted layer info from a tool result, if there is one. */
function resultLayer(result: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!result) return null;
  // Some tools (e.g. field_statistics) return `layer` as a plain layer-id string.
  if (result.layer && typeof result.layer === "object" && typeof result.layer.id === "string") return result.layer;
  const fromList = Array.isArray(result.layers) ? result.layers.find((item: any) => item?.layer && typeof item.layer.id === "string")?.layer : undefined;
  return fromList ?? null;
}

export const browserPlanAdapter: PlanAdapter = {
  provider: "browser-wasm",
  async getLayer(ref) {
    const described = await describeLayer(ref);
    return described ? await toLayerLite(described) : undefined;
  },
  async geojson(layerId) {
    const stored = await readRecord<{ geojson?: unknown }>(`layer:${layerId}`);
    return stored?.geojson;
  },
  async runStep(resolved: ResolvedStep, signal): Promise<StepOutcome> {
    if (resolved.kind === "operation") {
      const input = await this.getLayer(resolved.spec.input);
      if (!input) throw new Error(`找不到图层：${resolved.spec.input}`);
      const decision = planOperation(resolved.spec, { id: input.id, crs: input.crs ?? "", kind: input.kind }, "browser-wasm");
      if (decision.action === "reject") throw new Error(decision.errors.join(" "));
      if (decision.action === "noop") return { noop: decision.reason, layer: input };
      const result = await runStepTool(decision.tool, decision.args, signal);
      const info = resultLayer(result);
      if (!info && !result?.ok) throw new Error(String(result?.message ?? "工具没有返回结果。"));
      return { layer: info ? await toLayerLite(info) : null, result };
    }
    const result = await runStepTool(resolved.step.tool, resolved.args, signal);
    const info = resultLayer(result);
    if (!info && result?.ok === false) throw new Error(String(result?.message ?? "工具执行失败。"));
    return { layer: info ? await toLayerLite(info) : null, result };
  },
  async save(run) {
    await writeRecord(`plan-run:${run.runId}`, run);
  },
};

export async function readPlanRun(runId: string): Promise<PlanRun | undefined> {
  return readRecord<PlanRun>(`plan-run:${runId}`);
}

export async function listPlanRuns(): Promise<Record<string, any>[]> {
  const all = await records<PlanRun>("plan-run:");
  return all
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 50)
    .map(run => ({
      runId: run.runId, goal: run.goal, status: run.status, provider: run.provider,
      startedAt: run.startedAt, finishedAt: run.finishedAt ?? null, durationMs: run.durationMs ?? null,
      steps: run.steps.map(step => ({ stepId: step.stepId, label: step.label, phase: step.phase, reused: step.reused ?? false })),
      blockedAt: run.honest?.blockedAt ?? null, headline: run.honest?.headline ?? "",
      resumedFrom: run.resumedFrom ?? null,
    }));
}

export function isPlan(value: unknown): value is Plan {
  const candidate = value as Plan;
  return !!candidate && typeof candidate.goal === "string" && Array.isArray(candidate.steps);
}

/**
 * Engine entry behind the `run_plan` tool. Runs as one engine job: cancelling
 * that job aborts the executor, which cancels the in-flight tool job.
 */
export async function runBrowserPlan(args: Record<string, any>, signal?: AbortSignal): Promise<Record<string, any>> {
  const plan = args.plan;
  if (!isPlan(plan)) throw new Error("run_plan 需要一个 plan 对象（goal + steps）。");
  const stepTimeoutMs = Number.isFinite(Number(args.step_timeout_ms)) && Number(args.step_timeout_ms) > 0 ? Number(args.step_timeout_ms) : undefined;
  let run: PlanRun;
  if (args.resume_of) {
    const previous = await readPlanRun(String(args.resume_of));
    if (!previous) throw new Error(`找不到要恢复的运行：${args.resume_of}`);
    run = await resumePlan(previous, plan, browserPlanAdapter, { signal, stepTimeoutMs });
  } else {
    run = await executePlan(plan, browserPlanAdapter, { signal, stepTimeoutMs });
  }
  return {
    ok: run.status === "completed",
    run_id: run.runId,
    status: run.status,
    resumed_from: run.resumedFrom ?? null,
    headline: run.honest.headline,
    deliverables: run.honest.deliverables,
    blocked_at: run.honest.blockedAt ?? null,
    next: run.honest.next,
    plan_issues: run.planIssues,
    steps: run.steps.map(step => ({
      stepId: step.stepId, label: step.label, phase: step.phase, durationMs: step.durationMs ?? null,
      outputLayer: step.outputLayer ? { id: step.outputLayer.id, name: step.outputLayer.name, sha256: step.outputLayer.sha256 ?? null } : null,
      error: step.error ?? null, acceptance: step.acceptance ?? null, reused: step.reused ?? false,
    })),
    run,
  };
}
