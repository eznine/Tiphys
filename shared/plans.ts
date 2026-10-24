/**
 * Stage 3: plan-level deterministic execution, audit and honest reporting.
 *
 * Division of labour (roadmap §4 阶段 3):
 * - The MODEL (or the UI) writes a `Plan`: a short ordered list of steps with
 *   explicit data dependencies and acceptance checks. It never manages jobs,
 *   retries or checkpoints.
 * - The EXECUTOR in this file is deterministic control flow: it validates the
 *   whole plan before touching an engine (stage 2 rule: unsupported operations
 *   are rejected at plan time with a degrade path), holds per-step timeouts,
 *   records `ExecutionRun`-style facts for every step, checkpoints after each
 *   step, can resume from a checkpoint, and never turns a failure into a
 *   "completed" run.
 * - Engine specifics live behind `PlanAdapter`. The browser WASM adapter is in
 *   `src/lib/browser/plans.ts`; a desktop adapter can be added later without
 *   changing this file.
 *
 * Auditability contract: a stored `PlanRun` plus the layer digests it records
 * is sufficient for a second developer to recompute the verdict. `auditRuns`
 * enforces the invariants that make fake success impossible.
 */
import {
  OPERATION_SUPPORT,
  normalizeParams,
  operationSupport,
  parseEpsg,
  planOperation,
  type EngineId,
  type ErrorClass,
  type LayerKind,
  type OperationSpec,
  type Validation,
} from "./contracts/index.ts";

export const PLAN_VERSION = 1 as const;

/** Tools whose direct invocation requires explicit user approval (agent parity). */
export const APPROVAL_TOOLS = new Set(["remove_layer", "export_features"]);

export const ERROR_CLASSES: ErrorClass[] = [
  "INPUT_ERROR", "UNSUPPORTED", "RESOURCE_LIMIT", "EXECUTION_ERROR", "VALIDATION_ERROR", "USER_CANCELLED",
];

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export type AcceptanceCheck =
  | { type: "feature_count"; op?: "eq" | "gte" | "lte"; value: number }
  | { type: "crs"; value: string }
  | { type: "geometry_types"; contains?: string[]; excludes?: string[] }
  | { type: "bounds_lonlat" }
  | { type: "raster_dims"; ref?: string } // ref = step id whose raster dims must match
  | { type: "field_value"; field: string; op?: "eq" | "gte" | "lte"; value: number } // on the step result (dotted path)
  | { type: "layer_field"; index?: number; field: string; op?: "gte" | "lte" | "between"; value?: number; min?: number; max?: number }
  | { type: "buffer_radius"; source: string; distance: number; tol: number } // source = step id holding the point layer
  | { type: "noop" };

export type PlanStepBase = {
  id: string;
  title?: string;
  /** Steps whose outputs this step consumes; must appear earlier in the plan. */
  dependsOn?: string[];
  acceptance?: AcceptanceCheck[];
};

export type PlanStep =
  | (PlanStepBase & { kind: "operation"; spec: OperationSpec })
  | (PlanStepBase & { kind: "tool"; tool: string; args?: Record<string, unknown> });

export type Plan = {
  goal: string;
  /** Executor engine; defaults to the adapter's provider. */
  provider?: EngineId;
  steps: PlanStep[];
  /** Step ids the user explicitly approved (required for APPROVAL_TOOLS steps). */
  confirmations?: string[];
};

// ---------------------------------------------------------------------------
// Run record (the audit artifact)
// ---------------------------------------------------------------------------

export type LayerLite = {
  id: string;
  name: string;
  kind: LayerKind;
  crs?: string;
  featureCount?: number;
  geometryTypes?: string[];
  raster?: { width: number; height: number; bands?: number } | null;
  sha256?: string | null;
};

export type StepPhase = "pass" | "fail" | "skipped" | "noop" | "cancelled";

export type PlanIssue = { stepId: string | null; class: ErrorClass; message: string; next?: string };

export type StepRun = {
  stepId: string;
  title?: string;
  kind: "operation" | "tool";
  label: string; // operation id or tool name
  phase: StepPhase;
  startedAt?: string;
  durationMs?: number;
  /** Arguments as actually executed, with @refs resolved to layer ids. */
  args?: Record<string, unknown>;
  input?: { layerId: string; crs?: string; sha256?: string | null } | null;
  outputLayer?: LayerLite | null;
  /** Non-layer result (statistics, export path…), trimmed to JSON-safe size. */
  resultSummary?: Record<string, unknown> | null;
  validation?: Validation;
  acceptance?: { type: string; ok: boolean; detail: string }[];
  error?: { class: ErrorClass; message: string };
  /** True when a resume copied this step from a checkpoint instead of re-running. */
  reused?: boolean;
};

export type PlanRun = {
  runId: string;
  planVersion: typeof PLAN_VERSION;
  goal: string;
  provider: EngineId;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  steps: StepRun[];
  /** Plan-time validation issues; any entry means nothing was executed. */
  planIssues: PlanIssue[];
  /** Step ids the user confirmed before submission. */
  confirmations?: string[];
  resumedFrom?: string;
  /** Test-harness fault injection marker; a run with this flag can never be completed. */
  injected?: boolean;
  honest: {
    headline: string;
    deliverables: { stepId: string; layerId: string; name: string }[];
    blockedAt?: { stepId: string; label: string; errorClass: ErrorClass; message: string; next: string[] };
    next: string[];
  };
  environment?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Adapter: everything engine-specific the executor needs
// ---------------------------------------------------------------------------

export type StepOutcome = { layer?: LayerLite | null; result?: Record<string, unknown> | null; noop?: string };

export type ResolvedStep =
  | { kind: "operation"; step: Extract<PlanStep, { kind: "operation" }>; spec: OperationSpec }
  | { kind: "tool"; step: Extract<PlanStep, { kind: "tool" }>; args: Record<string, unknown> };

export type PlanAdapter = {
  provider: EngineId;
  /** Resolve a layer by id or name; undefined when unknown. */
  getLayer(ref: string): Promise<LayerLite | undefined>;
  /** GeoJSON of a vector layer, for independent geometric acceptance checks. */
  geojson?(layerId: string): Promise<unknown>;
  /** Run one resolved step; must throw on failure. */
  runStep(resolved: ResolvedStep, signal: AbortSignal): Promise<StepOutcome>;
  /** Persist a checkpoint; called after every step and at the end. */
  save?(run: PlanRun): Promise<void>;
};

// ---------------------------------------------------------------------------
// Reference resolution: "@stepId" means "the output layer of that step"
// ---------------------------------------------------------------------------

const REF = /^@([\w-]+)$/;

export function resolveRefs(value: unknown, outputs: Map<string, LayerLite>): unknown {
  if (typeof value === "string") {
    const match = value.match(REF);
    if (match) {
      const layer = outputs.get(match[1]);
      if (!layer) throw new Error(`引用的步骤 @${match[1]} 还没有成功输出图层。`);
      return layer.id;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, outputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveRefs(item, outputs)]));
  }
  return value;
}

/** Collect literal (non-@) layer references from a step, for plan-time checks. */
export function layerRefs(step: PlanStep): { field: string; ref: string }[] {
  const found: { field: string; ref: string }[] = [];
  const inputFields = new Set(["input", "layer", "maskLayerId", "zonesLayerId", "mask_layer", "join_layer", "other_layer", "filter_layer"]);
  const visit = (value: unknown, field: string) => {
    if (typeof value !== "string") {
      if (Array.isArray(value)) { value.forEach(item => visit(item, field)); return; }
      if (value && typeof value === "object") { for (const [key, item] of Object.entries(value)) visit(item, key === "params" ? field : key); return; }
      return;
    }
    if (inputFields.has(field) && !REF.test(value)) found.push({ field, ref: value });
  };
  if (step.kind === "operation") {
    visit(step.spec.input, "input");
    visit(step.spec.params, "params");
  } else {
    visit(step.args ?? {}, "layer");
  }
  return found;
}

/** Collect "@stepId" references from a step's input fields, for dependency checks. */
export function stepRefs(step: PlanStep): string[] {
  const found: string[] = [];
  const inputFields = new Set(["input", "layer", "maskLayerId", "zonesLayerId", "mask_layer", "join_layer", "other_layer", "filter_layer", "dem", "overlay"]);
  const visit = (value: unknown, field: string) => {
    if (typeof value !== "string") {
      if (Array.isArray(value)) { value.forEach(item => visit(item, field)); return; }
      if (value && typeof value === "object") { for (const [key, item] of Object.entries(value)) visit(item, key === "params" ? field : key); return; }
      return;
    }
    const match = value.match(REF);
    if (inputFields.has(field) && match) found.push(match[1]);
  };
  if (step.kind === "operation") {
    visit(step.spec.input, "input");
    visit(step.spec.params, "params");
  } else {
    visit(step.args ?? {}, "layer");
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Plan-time validation — runs BEFORE any engine call
// ---------------------------------------------------------------------------

export async function validatePlan(plan: Plan, adapter: PlanAdapter): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  if (!plan.goal?.trim()) issues.push({ stepId: null, class: "INPUT_ERROR", message: "计划缺少目标描述（goal）。" });
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) issues.push({ stepId: null, class: "INPUT_ERROR", message: "计划没有步骤。" });
  if (issues.length) return issues;

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!/^[\w-]{1,64}$/.test(step.id ?? "")) issues.push({ stepId: step.id ?? null, class: "INPUT_ERROR", message: `步骤 id「${step.id}」不合法（字母数字-_，≤64）。` });
    else if (ids.has(step.id)) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `步骤 id「${step.id}」重复。` });
    ids.add(step.id ?? "");
  }
  const confirmations = new Set(plan.confirmations ?? []);

  plan.steps.forEach((step, index) => {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `依赖的步骤「${dep}」不存在。` });
      else if (plan.steps.findIndex(s => s.id === dep) >= index) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `依赖「${dep}」必须排在当前步骤之前。` });
    }
    for (const ref of stepRefs(step)) {
      if (!ids.has(ref)) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `输入引用的步骤 @${ref} 不存在。` });
      else if (plan.steps.findIndex(s => s.id === ref) >= index) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `输入引用的步骤 @${ref} 必须排在当前步骤之前。` });
    }
    if (step.kind === "tool") {
      if (!step.tool?.trim()) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: "工具步骤缺少 tool 名称。" });
      if (APPROVAL_TOOLS.has(step.tool) && !confirmations.has(step.id)) {
        issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `步骤「${step.id}」调用 ${step.tool}，需要用户确认（把步骤 id 加入 plan.confirmations）后才能执行。`, next: "向用户说明将删除/导出哪个图层，获得同意后再提交确认标记。" });
      }
    }
    if (step.kind === "operation") {
      const normalized = normalizeParams(step.spec);
      if (!normalized.ok) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: normalized.errors.join(" ") });
      const support = operationSupport(step.spec.operation, plan.provider ?? adapter.provider);
      if (!support.supported) {
        issues.push({ stepId: step.id, class: "UNSUPPORTED", message: `${step.spec.operation} 在 ${plan.provider ?? adapter.provider} 上不支持：${support.reason}`, next: support.degrade ? `降级方案：${support.degrade}` : undefined });
      }
    }
  });
  if (issues.length) return issues;

  for (const step of plan.steps) {
    for (const { field, ref } of layerRefs(step)) {
      const layer = await adapter.getLayer(ref);
      if (!layer) issues.push({ stepId: step.id, class: "INPUT_ERROR", message: `${field} 引用的图层「${ref}」不存在。` });
    }
    if (step.kind === "operation") {
      const input = await adapter.getLayer(step.spec.input);
      if (input) {
        const decision = planOperation(step.spec, { id: input.id, crs: input.crs ?? "", kind: input.kind });
        if (decision.action === "reject") issues.push({ stepId: step.id, class: "INPUT_ERROR", message: decision.errors.join(" ") });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyError(message: string, hints: { aborted?: boolean; timeout?: boolean } = {}): ErrorClass {
  if (hints.aborted) return "USER_CANCELLED";
  if (hints.timeout) return "RESOURCE_LIMIT";
  const text = message ?? "";
  if (/已取消|cancelled|canceled|abort/i.test(text)) return "USER_CANCELLED";
  if (/超时|timeout|上限|内存|out of memory|limit exceeded/i.test(text)) return "RESOURCE_LIMIT";
  if (/验收|validation/i.test(text)) return "VALIDATION_ERROR";
  if (/找不到图层|找不到指定字段|不合法|无效|必须是|只适用|请提供|距离必须|坐标系|EPSG|参数|掩膜/i.test(text)) return "INPUT_ERROR";
  if (/不支持|not supported|unsupported|降级/i.test(text)) return "UNSUPPORTED";
  return "EXECUTION_ERROR";
}

// ---------------------------------------------------------------------------
// Honest reporting
// ---------------------------------------------------------------------------

const NEXT_ACTIONS: Record<ErrorClass, string[]> = {
  INPUT_ERROR: ["修正输入（图层/字段/参数）后重新提交计划。"],
  UNSUPPORTED: ["按降级方案改用受支持的引擎或操作；不要换一个名字近似的工具继续跑。"],
  RESOURCE_LIMIT: ["降低数据量或放宽步骤超时预算后重试；大任务考虑改用桌面引擎。"],
  EXECUTION_ERROR: ["该步骤执行失败（引擎或上游缺陷）；可重试一次或换执行引擎，已有图层不会被自动覆盖。"],
  VALIDATION_ERROR: ["结果未通过验收断言：按验收明细修正参数或数据后重跑；不要把未通过验收的结果当作结论。"],
  USER_CANCELLED: ["可从断点恢复：用原计划 resume，已成功步骤不会重复执行。"],
};

export function honestReport(run: Omit<PlanRun, "honest">): PlanRun["honest"] {
  const deliverables = run.steps
    .filter(step => (step.phase === "pass" || step.phase === "noop") && step.outputLayer)
    .map(step => ({ stepId: step.stepId, layerId: step.outputLayer!.id, name: step.outputLayer!.name }));
  const blockedStep = run.steps.find(step => step.phase === "fail" || step.phase === "cancelled");
  const planBlocker = blockedStep ? undefined : run.planIssues[0];
  const blockedAt = blockedStep?.error
    ? { stepId: blockedStep.stepId, label: blockedStep.label, errorClass: blockedStep.error.class, message: blockedStep.error.message, next: NEXT_ACTIONS[blockedStep.error.class] }
    : planBlocker
      ? { stepId: planBlocker.stepId ?? "-", label: planBlocker.stepId ? (run.steps.find(s => s.stepId === planBlocker.stepId)?.label ?? planBlocker.stepId) : "计划", errorClass: planBlocker.class, message: planBlocker.message, next: planBlocker.next ? [planBlocker.next, ...NEXT_ACTIONS[planBlocker.class]] : NEXT_ACTIONS[planBlocker.class] }
      : undefined;
  let headline: string;
  if (run.status === "completed") headline = `计划完成：${run.steps.length} 个步骤全部成功，${deliverables.length} 个可交付图层。`;
  else if (planBlocker && !blockedStep) headline = `计划未执行：${run.planIssues.length} 项校验未通过（${run.planIssues[0].message}）。`;
  else if (run.status === "cancelled") headline = `计划已取消：完成 ${run.steps.filter(s => s.phase === "pass" || s.phase === "noop").length}/${run.steps.length} 步，已有结果已保留，可恢复。`;
  else if (blockedAt?.errorClass === "VALIDATION_ERROR") headline = `计划失败：步骤「${blockedAt.stepId}」(${blockedAt.label}) 的结果未通过验收，不能视为完成。`;
  else headline = `计划失败：步骤「${blockedAt?.stepId ?? "?"}」(${blockedAt?.label ?? "?"}) ${blockedAt?.message ?? "未知错误"}。`;
  const next = blockedAt ? blockedAt.next : run.status === "completed" ? ["结果图层已在地图与图层库中，可用 export_features 导出。"] : [];
  return { headline, deliverables, blockedAt, next };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  runId?: string;
  signal?: AbortSignal;
  /** Per-step wall-clock budget; expiry aborts the step as RESOURCE_LIMIT. */
  stepTimeoutMs?: number;
  /** Resume from this checkpoint: pass/noop steps are reused, not re-run. */
  resumeOf?: PlanRun;
  /** Test harness only: force a step to fail with a message. */
  failStep?: { stepId: string; message: string };
  now?: () => Date;
};

const newRunId = () => `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function linkSignals(external: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; expired: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    expired: () => timedOut,
    cleanup: () => { if (timer) clearTimeout(timer); external?.removeEventListener("abort", onAbort); },
  };
}

function trimResult(result: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!result) return null;
  const keep: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") keep[key] = value;
    else if (key === "layer" || key === "layers") continue; // layers are recorded as outputLayer
    else keep[key] = Array.isArray(value) ? { type: "array", length: value.length } : { type: typeof value };
  }
  return keep;
}

const rad = (deg: number) => deg * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function lookupPath(target: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), target);
}

async function evaluateAcceptance(
  checks: AcceptanceCheck[] | undefined,
  ctx: { step: StepRun; steps: StepRun[]; adapter: PlanAdapter },
): Promise<{ type: string; ok: boolean; detail: string }[]> {
  if (!checks?.length) return [];
  const { step, steps, adapter } = ctx;
  const layer = step.outputLayer;
  const priorOutputs = new Map(steps.filter(s => s.outputLayer).map(s => [s.stepId, s.outputLayer!] as const));
  const out: { type: string; ok: boolean; detail: string }[] = [];
  for (const check of checks) {
    let ok = false, detail = "";
    switch (check.type) {
      case "feature_count": {
        const n = Number(layer?.featureCount ?? -1), op = check.op ?? "eq";
        ok = n >= 0 && (op === "gte" ? n >= check.value : op === "lte" ? n <= check.value : n === check.value);
        detail = `feature_count=${n}（要求 ${op} ${check.value}）`;
        break;
      }
      case "crs": ok = !!layer?.crs && parseEpsg(layer.crs) === parseEpsg(check.value), detail = `crs=${layer?.crs ?? "无"}（要求 ${check.value}）`; break;
      case "geometry_types": {
        const types = layer?.geometryTypes ?? [];
        // `contains` is ANY-of: ["Polygon","MultiPolygon"] means polygon-ish output.
        const contains = check.contains ?? [], excludes = check.excludes ?? [];
        ok = contains.some(t => types.includes(t)) && excludes.every(t => !types.includes(t));
        detail = `geometry_types=${types.join(",") || "无"}`;
        break;
      }
      case "bounds_lonlat": {
        const geo = layer && adapter.geojson ? await adapter.geojson(layer.id) : undefined;
        const bounds = (geo as any)?.bbox ?? null;
        ok = bounds ? bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90 : !!layer?.id;
        detail = bounds ? `bbox=${bounds.join(",")}` : "图层的 WGS84 范围可读（displayCrs=EPSG:4326）";
        break;
      }
      case "raster_dims": {
        const ref = check.ref ? priorOutputs.get(check.ref) : undefined;
        const own = layer?.raster, other = ref?.raster;
        ok = !!own && !!other && own.width === other.width && own.height === other.height;
        detail = `${own?.width ?? "?"}x${own?.height ?? "?"} vs ${other?.width ?? "?"}x${other?.height ?? "?"}`;
        break;
      }
      case "field_value": {
        const found = Number(lookupPath(step.resultSummary, check.field));
        const op = check.op ?? "eq";
        ok = Number.isFinite(found) && (op === "gte" ? found >= check.value : op === "lte" ? found <= check.value : found === check.value);
        detail = `${check.field}=${lookupPath(step.resultSummary, check.field)}（要求 ${op} ${check.value}）`;
        break;
      }
      case "layer_field": {
        const geo = layer && adapter.geojson ? await adapter.geojson(layer.id) : undefined;
        const features = (geo as any)?.features ?? [];
        const found = Number(features[check.index ?? 0]?.properties?.[check.field]);
        if (check.op === "between") ok = Number.isFinite(found) && found >= Number(check.min) && found <= Number(Number.isFinite(check.max) ? check.max : Infinity);
        else if (check.op === "lte") ok = Number.isFinite(found) && found <= Number(check.value);
        else ok = Number.isFinite(found) && found >= Number(check.value);
        detail = `features[${check.index ?? 0}].${check.field}=${features[check.index ?? 0]?.properties?.[check.field]}`;
        break;
      }
      case "buffer_radius": {
        const source = priorOutputs.get(check.source);
        const sourceGeo = source && adapter.geojson ? await adapter.geojson(source.id) : undefined;
        const ownGeo = layer && adapter.geojson ? await adapter.geojson(layer.id) : undefined;
        if (!sourceGeo || !ownGeo) { ok = false; detail = "无法读取源点或缓冲区几何做独立复核。"; break; }
        const points: number[][] = (sourceGeo as any).features.filter((f: any) => f.geometry?.type === "Point").map((f: any) => f.geometry.coordinates);
        let worst = 0, checked = 0;
        for (const feature of (ownGeo as any).features ?? []) {
          const rings: number[][][] = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates : feature.geometry?.type === "MultiPolygon" ? feature.geometry.coordinates.flat() : [];
          for (const ring of rings) for (const vertex of ring) {
            worst = Math.max(worst, Math.min(...points.map(p => Math.abs(sphericalDistance(p, vertex) - check.distance))));
            checked++;
          }
        }
        ok = checked > 0 && worst <= check.tol;
        detail = `${checked} 个顶点，最大半径偏差 ${worst.toFixed(2)} m（容差 ${check.tol} m）`;
        break;
      }
      case "noop": ok = step.phase === "noop", detail = step.phase === "noop" ? "按契约显式 no-op。" : `步骤实际相位为 ${step.phase}，不是 no-op。`; break;
    }
    out.push({ type: check.type, ok, detail });
  }
  return out;
}

export async function executePlan(plan: Plan, adapter: PlanAdapter, options: ExecuteOptions = {}): Promise<PlanRun> {
  const now = options.now ?? (() => new Date());
  const provider = plan.provider ?? adapter.provider;
  const run: PlanRun = {
    runId: options.runId ?? newRunId(),
    planVersion: PLAN_VERSION,
    goal: plan.goal,
    provider,
    status: "running",
    startedAt: now().toISOString(),
    steps: [],
    planIssues: [],
    confirmations: plan.confirmations,
    resumedFrom: options.resumeOf?.runId,
    injected: options.failStep ? true : undefined,
    honest: { headline: "计划运行中。", deliverables: [], next: [] },
  };
  const checkpoint = async () => { if (adapter.save) await adapter.save(run); };

  // Resume: reuse the successful prefix (steps never run out of order, so the
  // pass/noop steps of a stopped run are always a prefix).
  const outputs = new Map<string, LayerLite>();
  if (options.resumeOf) {
    for (const prior of options.resumeOf.steps) {
      if (prior.phase !== "pass" && prior.phase !== "noop") break;
      run.steps.push({ ...prior, reused: true });
      if (prior.outputLayer) outputs.set(prior.stepId, prior.outputLayer);
    }
  }

  run.planIssues = await validatePlan(plan, adapter);
  if (run.planIssues.length) {
    for (const step of plan.steps) {
      const own = run.planIssues.find(item => item.stepId === step.id);
      const generic = run.planIssues.find(item => item.stepId === null) ?? run.planIssues[0];
      const issue = own ?? generic;
      run.steps.push({ stepId: step.id, title: step.title, kind: step.kind === "operation" ? "operation" : "tool",
        label: step.kind === "operation" ? step.spec.operation : step.tool,
        phase: own ? "fail" : "skipped",
        error: { class: issue?.class ?? "INPUT_ERROR", message: own ? issue!.message : `计划校验未通过（${generic?.message ?? "未知问题"}），本步骤未执行。` } });
    }
    run.status = "failed";
    const finished = now().toISOString();
    run.finishedAt = finished; run.durationMs = Date.parse(finished) - Date.parse(run.startedAt);
    run.honest = honestReport(run);
    await checkpoint();
    return run;
  }

  for (const step of plan.steps) {
    if (run.steps.some(s => s.stepId === step.id)) continue;
    const stepRun: StepRun = { stepId: step.id, title: step.title, kind: step.kind === "operation" ? "operation" : "tool",
      label: step.kind === "operation" ? step.spec.operation : step.tool, phase: "pass" };

    if (options.signal?.aborted) {
      run.steps.push({ ...stepRun, phase: "cancelled", error: { class: "USER_CANCELLED", message: "上游步骤停止后本步骤未开始。" } });
      continue;
    }
    const priorFailure = run.steps.find(s => s.phase === "fail" || s.phase === "cancelled");
    if (priorFailure) {
      run.steps.push({ ...stepRun, phase: "skipped", error: { class: priorFailure.error?.class ?? "EXECUTION_ERROR", message: `上游步骤「${priorFailure.stepId}」未成功，本步骤按依赖关系跳过。` } });
      continue;
    }

    run.steps.push(stepRun);
    const startedAt = now().toISOString();
    stepRun.startedAt = startedAt;
    try {
      options.signal?.throwIfAborted();
      const resolved = await resolveStep(step, outputs);
      stepRun.args = resolved.kind === "operation" ? { ...(resolved.spec.params as Record<string, unknown>) } : resolved.args;

      const inputRef = primaryInputRef(step, outputs);
      if (inputRef) {
        const inputLayer = await adapter.getLayer(inputRef);
        stepRun.input = inputLayer ? { layerId: inputLayer.id, crs: inputLayer.crs, sha256: inputLayer.sha256 ?? null } : { layerId: inputRef };
      }

      if (options.failStep && options.failStep.stepId === step.id) throw new Error(options.failStep.message);

      const linked = linkSignals(options.signal, options.stepTimeoutMs);
      let outcome: StepOutcome;
      try {
        outcome = await adapter.runStep(resolved, linked.signal);
      } finally { linked.cleanup(); }
      if (linked.expired() && !outcome?.noop) throw new Error("step timeout: 步骤超出时间预算。");

      if (outcome.noop) {
        stepRun.phase = "noop";
        stepRun.resultSummary = { noop: outcome.noop };
        if (outcome.layer) { stepRun.outputLayer = outcome.layer; outputs.set(step.id, outcome.layer); }
      } else {
        stepRun.outputLayer = outcome.layer ?? null;
        stepRun.resultSummary = trimResult(outcome.result ?? null);
        if (outcome.layer) outputs.set(step.id, outcome.layer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted) {
        stepRun.phase = "cancelled";
        stepRun.error = { class: "USER_CANCELLED", message: `已取消：${message}` };
      } else {
        stepRun.phase = "fail";
        stepRun.error = { class: classifyError(message, { timeout: /step timeout/i.test(message) }), message };
      }
      stepRun.durationMs = Date.parse(now().toISOString()) - Date.parse(startedAt);
      await checkpoint();
      continue;
    }
    stepRun.durationMs = Date.parse(now().toISOString()) - Date.parse(startedAt);

    // Acceptance gates: an engine success that fails a gate is NOT a success.
    const acceptance = await evaluateAcceptance(step.acceptance, { step: stepRun, steps: run.steps, adapter });
    stepRun.acceptance = acceptance;
    if (acceptance.some(item => !item.ok) && stepRun.phase === "pass") {
      stepRun.phase = "fail";
      stepRun.error = { class: "VALIDATION_ERROR", message: `验收未通过：${acceptance.filter(item => !item.ok).map(item => item.detail).join("；")}` };
    }
    await checkpoint();
  }

  const anyFailed = run.steps.some(s => s.phase === "fail");
  const anyCancelled = run.steps.some(s => s.phase === "cancelled");
  run.status = anyFailed ? "failed" : anyCancelled ? "cancelled" : "completed";
  const finished = now().toISOString();
  run.finishedAt = finished;
  run.durationMs = Date.parse(finished) - Date.parse(run.startedAt);
  run.honest = honestReport(run);
  await checkpoint();
  return run;
}

async function resolveStep(step: PlanStep, outputs: Map<string, LayerLite>): Promise<ResolvedStep> {
  if (step.kind === "tool") {
    return { kind: "tool", step, args: resolveRefs(step.args ?? {}, outputs) as Record<string, unknown> };
  }
  const spec = resolveRefs(step.spec, outputs) as OperationSpec;
  return { kind: "operation", step, spec };
}

function primaryInputRef(step: PlanStep, outputs: Map<string, LayerLite>): string | null {
  const toId = (value: unknown): string | null => {
    if (typeof value !== "string" || !value) return null;
    const match = value.match(REF);
    return match ? outputs.get(match[1])?.id ?? null : value;
  };
  if (step.kind === "operation") return toId(step.spec.input);
  for (const key of ["layer", "input", "dem"]) {
    if (typeof step.args?.[key] === "string") return toId(step.args![key]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resume helper
// ---------------------------------------------------------------------------

export async function resumePlan(previous: PlanRun, plan: Plan, adapter: PlanAdapter, options: ExecuteOptions = {}): Promise<PlanRun> {
  return executePlan(plan, adapter, { ...options, resumeOf: previous });
}

// ---------------------------------------------------------------------------
// Audit invariants — what another developer independently recomputes
// ---------------------------------------------------------------------------

export type AuditVerdict = { ok: boolean; violations: string[] };

const PHASES = new Set(["pass", "fail", "skipped", "noop", "cancelled"]);

export function auditRuns(runs: PlanRun[]): AuditVerdict {
  const violations: string[] = [];
  const byId = new Map(runs.map(run => [run.runId, run] as const));
  for (const run of runs) {
    const tag = run.runId;
    if (run.planVersion !== PLAN_VERSION) violations.push(`${tag}: planVersion 不是 ${PLAN_VERSION}。`);
    for (const step of run.steps) {
      if (!PHASES.has(step.phase)) violations.push(`${tag}/${step.stepId}: 未知步骤相位「${step.phase}」。`);
      if (step.error && !ERROR_CLASSES.includes(step.error.class)) violations.push(`${tag}/${step.stepId}: 错误分类「${step.error.class}」不在统一分类表中。`);
      if (step.acceptance) for (const item of step.acceptance) if (!item.detail?.trim()) violations.push(`${tag}/${step.stepId}: 验收明细为空，无法复算。`);
    }
    if (run.status === "completed") {
      if (run.steps.some(s => s.phase !== "pass" && s.phase !== "noop")) violations.push(`${tag}: 状态为 completed 但存在未成功步骤（假完成）。`);
      if (run.steps.some(s => s.acceptance?.some(item => !item.ok))) violations.push(`${tag}: 状态为 completed 但存在未通过的验收断言（假完成）。`);
      if (run.injected) violations.push(`${tag}: 注入故障的运行不允许是 completed。`);
    } else {
      const failedSteps = run.steps.filter(s => s.phase === "fail" || s.phase === "cancelled");
      if (run.planIssues.length === 0 && failedSteps.length === 0 && run.steps.length > 0) violations.push(`${tag}: 状态 ${run.status} 但没有失败步骤也没有计划期问题。`);
      const blocked = run.honest.blockedAt;
      if (blocked && failedSteps.length && blocked.stepId !== failedSteps[0].stepId) violations.push(`${tag}: blockedAt(${blocked.stepId}) 与第一个失败步骤(${failedSteps[0].stepId})不一致。`);
    }
    // deliverables must come from successful steps of this run
    const deliverableSources = new Set(run.steps.filter(s => s.phase === "pass" || s.phase === "noop").map(s => s.stepId));
    for (const deliverable of run.honest.deliverables) if (!deliverableSources.has(deliverable.stepId)) violations.push(`${tag}: 可交付成果「${deliverable.name}」来自未成功步骤 ${deliverable.stepId}。`);
    // a step listed as deliverable must exist in the step record
    const stepIds = new Set(run.steps.map(s => s.stepId));
    for (const deliverable of run.honest.deliverables) if (!stepIds.has(deliverable.stepId)) violations.push(`${tag}: 可交付成果引用了不存在的步骤 ${deliverable.stepId}。`);
    if (run.resumedFrom) {
      const parent = byId.get(run.resumedFrom);
      if (!parent) violations.push(`${tag}: resume 引用的运行 ${run.resumedFrom} 不在审计集内。`);
      else {
        for (const step of run.steps.filter(s => s.reused)) {
          const original = parent.steps.find(s => s.stepId === step.stepId);
          if (!original) violations.push(`${tag}: 复用步骤 ${step.stepId} 在原运行中不存在。`);
          else if (original.phase !== "pass" && original.phase !== "noop") violations.push(`${tag}: 复用步骤 ${step.stepId} 在原运行中并未成功。`);
          else if (step.outputLayer?.sha256 && original.outputLayer?.sha256 && step.outputLayer.sha256 !== original.outputLayer.sha256)
            violations.push(`${tag}: 复用步骤 ${step.stepId} 的图层摘要与原运行不一致。`);
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export { OPERATION_SUPPORT };
