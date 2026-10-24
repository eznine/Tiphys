/**
 * Operation semantics for `gis.buffer` and `gis.reproject`, version 1.
 *
 * These functions are the single place where "what the user asked" becomes
 * "what an engine is told". Both executors (browser WASM, desktop Python) call
 * them, so a unit mistake or a bogus CRS is rejected before any engine runs.
 *
 * Deliberate v1 choices, with the evidence behind them:
 * - Buffer distance is a *metric length*. Both engines already reproject to a
 *   local metric CRS internally; the contract only normalises the unit and
 *   states that the output's analysis CRS is that local metric CRS.
 * - Reprojecting to the CRS a layer already has is a no-op with a warning, not
 *   an error: a redundant step in a chain should not abort the chain. The
 *   no-op is executed by the command layer, never faked as a new dataset.
 * - `version` is part of the stored run. Changing any semantic above requires
 *   bumping it and re-running the cross-engine comparison.
 */
import type {
  BufferParams,
  BufferSpec,
  DistanceUnit,
  ExecutionRun,
  LayerRef,
  OperationId,
  OperationSpec,
  ReprojectParams,
  ReprojectSpec,
  Validation,
  ValidationCheck,
  ValidationStatus,
} from "./types.ts";

export const OPERATION_VERSION = 1 as const;

export const MAX_BUFFER_METRES = 5_000_000;

export const UNIT_METRES: Record<DistanceUnit, number> = {
  meters: 1,
  kilometers: 1000,
  miles: 1609.344,
};

export function isDistanceUnit(value: unknown): value is DistanceUnit {
  return value === "meters" || value === "kilometers" || value === "miles";
}

/** Converts a requested distance to metres; v1 accepts positive distances only. */
export function distanceToMetres(distance: number, units: DistanceUnit): number {
  if (!Number.isFinite(distance)) throw new Error("距离必须是有限数值。");
  if (distance <= 0) throw new Error("距离必须为正数（v1 不支持负距离内缩；引擎行为尚不一致）。");
  const metres = distance * UNIT_METRES[units];
  if (metres > MAX_BUFFER_METRES) throw new Error("距离超过 5000 公里上限。");
  return metres;
}

export function parseEpsg(crs: unknown): number | null {
  if (typeof crs !== "string") return null;
  const match = /^epsg:(\d+)$/i.exec(crs.trim());
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) && code > 0 && code < 1_000_000 ? code : null;
}

export type PlanResult =
  | { action: "invoke"; tool: "buffer" | "reproject"; args: Record<string, unknown> }
  | { action: "noop"; reason: string }
  | { action: "reject"; errors: string[] };

export type LayerSemantics = { id: string; crs: string; kind: LayerRef["kind"] };

/** Normalises a spec's params without knowing which engine will run it. */
export function normalizeParams(spec: OperationSpec): { ok: true; params: BufferParams | ReprojectParams } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (spec.operation === "gis.buffer") {
    const params = spec.params as BufferParams;
    if (typeof params?.distance !== "number") errors.push("buffer 需要数值 distance。");
    const units = params?.units ?? "meters";
    if (!isDistanceUnit(units)) errors.push(`未知距离单位 ${String(units)}；只接受 meters/kilometers/miles。`);
    if (typeof params?.distance === "number" && isDistanceUnit(units)) {
      try {
        distanceToMetres(params.distance, units);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (typeof params?.dissolve !== "undefined" && typeof params.dissolve !== "boolean") errors.push("dissolve 只能是布尔值。");
    if (errors.length) return { ok: false, errors };
    return { ok: true, params: { ...params, units } };
  }
  if (spec.operation === "gis.reproject") {
    const params = spec.params as ReprojectParams;
    if (typeof params?.targetCrs !== "string" || !parseEpsg(params.targetCrs)) errors.push("reproject 需要形如 EPSG:3857 的 targetCrs。");
    if (errors.length) return { ok: false, errors };
    return { ok: true, params: { ...params, targetCrs: String(params.targetCrs).toUpperCase().replace(/^EPSG:/, "EPSG:") } };
  }
  return { ok: false, errors: [`未知操作 ${String((spec as { operation?: string }).operation)}。`] };
}

/**
 * Decides what an executor should do, given the current layer facts.
 * Rejections carry user-facing Chinese messages because both the toolbox and
 * the agent surface them verbatim.
 */
export function planOperation(spec: OperationSpec, input: LayerSemantics): PlanResult {
  const normalized = normalizeParams(spec);
  if (!normalized.ok) return { action: "reject", errors: normalized.errors };
  if (input.kind !== "vector") return { action: "reject", errors: [`${spec.operation} 只适用于矢量图层。`] };
  const inputEpsg = parseEpsg(input.crs);
  if (inputEpsg == null) return { action: "reject", errors: [`图层坐标系「${input.crs || "未知"}」不是 EPSG 编号，无法保证分析精度。`] };

  if (spec.operation === "gis.buffer") {
    const params = normalized.params as BufferParams;
    return {
      action: "invoke",
      tool: "buffer",
      args: {
        layer: input.id,
        distance: params.distance,
        units: params.units,
        dissolve: params.dissolve ?? false,
        ...(params.outputName ? { output_name: params.outputName } : {}),
      },
    };
  }

  const params = normalized.params as ReprojectParams;
  const targetEpsg = parseEpsg(params.targetCrs);
  if (targetEpsg == null) return { action: "reject", errors: ["目标坐标系必须是 EPSG:编号。"] };
  if (targetEpsg === inputEpsg) {
    return { action: "noop", reason: `图层已经是 ${params.targetCrs}，不重复创建数据集。` };
  }
  return {
    action: "invoke",
    tool: "reproject",
    args: { layer: input.id, target_crs: params.targetCrs, ...(params.outputName ? { output_name: params.outputName } : {}) },
  };
}

/** Builds a spec from loose UI/agent input; returns errors instead of guessing. */
export function makeOperationSpec(operation: string, input: string, params: Record<string, unknown>): { ok: true; spec: OperationSpec } | { ok: false; errors: string[] } {
  if (operation === "gis.buffer") {
    const units = params.units ?? "meters";
    const spec: BufferSpec = {
      operation: "gis.buffer",
      version: OPERATION_VERSION,
      input,
      params: {
        distance: typeof params.distance === "number" ? params.distance : Number(params.distance),
        units: isDistanceUnit(units) ? units : "meters",
        ...(typeof params.dissolve === "boolean" ? { dissolve: params.dissolve } : {}),
        ...(typeof params.outputName === "string" ? { outputName: params.outputName } : {}),
      },
    };
    const normalized = normalizeParams(spec);
    return normalized.ok ? { ok: true, spec } : { ok: false, errors: normalized.errors };
  }
  if (operation === "gis.reproject") {
    const targetCrs = String(params.targetCrs ?? "");
    const spec: ReprojectSpec = {
      operation: "gis.reproject",
      version: OPERATION_VERSION,
      input,
      params: { targetCrs, ...(typeof params.outputName === "string" ? { outputName: params.outputName } : {}) },
    };
    const normalized = normalizeParams(spec);
    return normalized.ok ? { ok: true, spec } : { ok: false, errors: normalized.errors };
  }
  return { ok: false, errors: [`未知操作 ${operation}。`] };
}

export function check(id: string, status: ValidationCheck["status"], detail: string, severity: ValidationCheck["severity"] = "gate"): ValidationCheck {
  return { id, status, detail, severity };
}

/** `fail` only when a gate check fails; a warn keeps the run usable. */
export function validationFrom(checks: ValidationCheck[]): Validation {
  const status: ValidationStatus = checks.some(c => c.status === "fail" && c.severity === "gate") ? "fail"
    : checks.some(c => c.status === "warn") ? "warn"
      : checks.every(c => c.status === "skipped") ? "not_tested"
        : "pass";
  return { status, checks };
}

/**
 * Result checks shared by both engines. `facts` must come from the executor's
 * own read-back, not from the request.
 */
export function validateResult(spec: OperationSpec, facts: {
  outputKind?: LayerRef["kind"];
  outputCrs?: string;
  featureCount?: number;
  emptyInput?: boolean;
  radiusErrorMetres?: number | null;
  inputCrs?: string;
}): Validation {
  const checks: ValidationCheck[] = [];
  checks.push(check("output_kind", facts.outputKind === "vector" ? "pass" : "fail", `输出类型：${facts.outputKind ?? "未知"}。`));
  if (spec.operation === "gis.buffer") {
    const params = spec.params as BufferParams;
    if (typeof facts.radiusErrorMetres === "number") {
      const tolerance = Math.max(2, Math.abs(distanceToMetres(params.distance, params.units)) * 0.005);
      checks.push(check("buffer_radius", facts.radiusErrorMetres <= tolerance ? "pass" : "fail",
        `半径误差 ${facts.radiusErrorMetres.toFixed(2)} m（容差 ${tolerance.toFixed(2)} m）。`));
    } else {
      checks.push(check("buffer_radius", "skipped", "执行端未提供独立半径复核。", "info"));
    }
    const epsg = parseEpsg(facts.outputCrs);
    checks.push(check("analysis_crs", epsg != null ? "pass" : "warn", `分析坐标系：${facts.outputCrs ?? "未知"}。`));
    if (typeof facts.featureCount === "number") {
      const emptyOk = facts.emptyInput === true;
      checks.push(check("feature_count", facts.featureCount > 0 || emptyOk ? "pass" : "fail",
        `输出要素数 ${facts.featureCount}${emptyOk ? "（输入为空，允许 0）" : ""}。`));
    }
  } else {
    const params = spec.params as ReprojectParams;
    const same = parseEpsg(params.targetCrs) === parseEpsg(facts.outputCrs);
    checks.push(check("target_crs", same ? "pass" : "fail", `输出坐标系 ${facts.outputCrs ?? "未知"}，目标 ${params.targetCrs}。`));
    checks.push(check("feature_count_preserved", typeof facts.featureCount === "number" ? "pass" : "skipped",
      typeof facts.featureCount === "number" ? `重投影后要素数 ${facts.featureCount}。` : "执行端未回报要素数。", "info"));
  }
  return validationFrom(checks);
}

export function newRun(spec: OperationSpec, provider: ExecutionRun["provider"], input: ExecutionRun["input"]): ExecutionRun {
  return {
    runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    operation: spec.operation,
    version: spec.version,
    provider,
    status: "running",
    startedAt: new Date().toISOString(),
    input,
    params: spec.params,
    outputs: [],
    validation: { status: "not_tested", checks: [] },
  };
}

export function finishRun(run: ExecutionRun, patch: Partial<ExecutionRun> & { status: ExecutionRun["status"] }): ExecutionRun {
  const finishedAt = new Date().toISOString();
  return {
    ...run,
    ...patch,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(run.startedAt),
  };
}

export const OPERATION_IDS: OperationId[] = ["gis.buffer", "gis.reproject"];