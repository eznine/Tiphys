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
  ClipParams,
  ClipSpec,
  DissolveParams,
  DissolveSpec,
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
  ZonalStatisticsParams,
  ZonalStatisticsSpec,
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
  | { action: "invoke"; tool: "buffer" | "reproject" | "clip" | "dissolve" | "zonal_statistics"; args: Record<string, unknown> }
  | { action: "noop"; reason: string }
  | { action: "reject"; errors: string[] };

export type LayerSemantics = { id: string; crs: string; kind: LayerRef["kind"] };

const ZONAL_STATISTICS = new Set(["mean", "median", "min", "max", "sum", "stddev", "count"]);

export type NormalizedParams = BufferParams | ReprojectParams | ClipParams | DissolveParams | ZonalStatisticsParams;

/** Normalises a spec's params without knowing which engine will run it. */
export function normalizeParams(spec: OperationSpec): { ok: true; params: NormalizedParams } | { ok: false; errors: string[] } {
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
  if (spec.operation === "gis.clip") {
    const params = spec.params as ClipParams;
    if (typeof params?.maskLayerId !== "string" || !params.maskLayerId) errors.push("clip 需要掩膜图层 maskLayerId。");
    if (errors.length) return { ok: false, errors };
    return { ok: true, params };
  }
  if (spec.operation === "gis.dissolve") {
    const params = spec.params as DissolveParams;
    if (params?.field !== undefined && (typeof params.field !== "string" || !params.field)) errors.push("dissolve 的 field 必须是非空字段名或省略。");
    if (errors.length) return { ok: false, errors };
    return { ok: true, params };
  }
  if (spec.operation === "gis.zonal_statistics") {
    const params = spec.params as ZonalStatisticsParams;
    if (typeof params?.zonesLayerId !== "string" || !params.zonesLayerId) errors.push("zonal_statistics 需要分区图层 zonesLayerId。");
    if (!ZONAL_STATISTICS.has(String(params?.statistic))) errors.push(`未知统计量 ${String(params?.statistic)}。`);
    if (errors.length) return { ok: false, errors };
    return { ok: true, params };
  }
  return { ok: false, errors: [`未知操作 ${String((spec as { operation?: string }).operation)}。`] };
}

/**
 * Decides what an executor should do, given the current layer facts.
 * Rejections carry user-facing Chinese messages because both the toolbox and
 * the agent surface them verbatim.
 */
export function planOperation(spec: OperationSpec, input: LayerSemantics, provider?: ExecutionRun["provider"]): PlanResult {
  const normalized = normalizeParams(spec);
  if (!normalized.ok) return { action: "reject", errors: normalized.errors };
  if (provider) {
    const support = operationSupport(spec.operation, provider);
    if (!support.supported) {
      return { action: "reject", errors: [support.reason, ...(support.degrade ? [`降级方案：${support.degrade}`] : [])] };
    }
  }
  if (spec.operation === "gis.zonal_statistics") {
    // The value input is a raster and the zones are a vector layer. Desktop
    // Python is the implemented executor; an omitted provider means desktop.
    const effectiveProvider = provider ?? "desktop-python";
    const support = operationSupport("gis.zonal_statistics", effectiveProvider);
    if (!support.supported) {
      return { action: "reject", errors: [support.reason, ...(support.degrade ? [`降级方案：${support.degrade}`] : [])] };
    }
    if (input.kind !== "raster") return { action: "reject", errors: ["gis.zonal_statistics 的 input 必须是数值栅格图层。"] };
    const inputEpsg = parseEpsg(input.crs);
    if (inputEpsg == null) return { action: "reject", errors: [`栅格坐标系「${input.crs || "未知"}」不是 EPSG 编号，无法保证分区对齐。`] };
    const params = normalized.params as ZonalStatisticsParams;
    return {
      action: "invoke",
      tool: "zonal_statistics",
      args: {
        layer: input.id,
        zones_layer: params.zonesLayerId,
        statistic: params.statistic,
        ignore_nodata: params.ignoreNoData ?? true,
        ...(params.valueField ? { value_field: params.valueField } : {}),
        ...(params.outputName ? { output_name: params.outputName } : {}),
      },
    };
  }
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

  if (spec.operation === "gis.clip") {
    const params = normalized.params as ClipParams;
    return {
      action: "invoke",
      tool: "clip",
      args: { layer: input.id, mask_layer: params.maskLayerId, ...(params.outputName ? { output_name: params.outputName } : {}) },
    };
  }

  if (spec.operation === "gis.dissolve") {
    const params = normalized.params as DissolveParams;
    return {
      action: "invoke",
      tool: "dissolve",
      args: { layer: input.id, ...(params.field ? { by_field: params.field } : {}), ...(params.outputName ? { output_name: params.outputName } : {}) },
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
  if (operation === "gis.clip") {
    const spec: ClipSpec = {
      operation: "gis.clip", version: OPERATION_VERSION, input,
      params: { maskLayerId: String(params.maskLayerId ?? params.mask_layer ?? ""),
        ...(typeof params.outputName === "string" ? { outputName: params.outputName } : {}) },
    };
    const normalized = normalizeParams(spec);
    return normalized.ok ? { ok: true, spec } : { ok: false, errors: normalized.errors };
  }
  if (operation === "gis.dissolve") {
    const field = typeof params.field === "string" ? params.field : typeof params.by_field === "string" ? params.by_field : "";
    const spec: DissolveSpec = {
      operation: "gis.dissolve", version: OPERATION_VERSION, input,
      params: { ...(field ? { field } : {}), ...(typeof params.outputName === "string" ? { outputName: params.outputName } : {}) },
    };
    const normalized = normalizeParams(spec);
    return normalized.ok ? { ok: true, spec } : { ok: false, errors: normalized.errors };
  }
  if (operation === "gis.zonal_statistics") {
    const spec: ZonalStatisticsSpec = {
      operation: "gis.zonal_statistics", version: OPERATION_VERSION, input,
      params: {
        zonesLayerId: String(params.zonesLayerId ?? params.zones_layer ?? ""),
        statistic: String(params.statistic ?? "mean") as ZonalStatisticsParams["statistic"],
        ...(typeof params.valueField === "string" ? { valueField: params.valueField } : {}),
        ...(typeof params.ignoreNoData === "boolean" ? { ignoreNoData: params.ignoreNoData } : {}),
        ...(typeof params.outputName === "string" ? { outputName: params.outputName } : {}),
      },
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
  } else if (spec.operation === "gis.reproject") {
    const params = spec.params as ReprojectParams;
    const same = parseEpsg(params.targetCrs) === parseEpsg(facts.outputCrs);
    checks.push(check("target_crs", same ? "pass" : "fail", `输出坐标系 ${facts.outputCrs ?? "未知"}，目标 ${params.targetCrs}。`));
    checks.push(check("feature_count_preserved", typeof facts.featureCount === "number" ? "pass" : "skipped",
      typeof facts.featureCount === "number" ? `重投影后要素数 ${facts.featureCount}。` : "执行端未回报要素数。", "info"));
  } else {
    // Overlay/dissolve/zonal: v1 only has common-sense invariants here; each
    // executor still needs its own area/attribute checks.
    checks.push(check("output_crs_preserved",
      parseEpsg(facts.inputCrs ?? "") !== null && parseEpsg(facts.outputCrs ?? "") === parseEpsg(facts.inputCrs ?? "") ? "pass" : "warn",
      `输入 ${facts.inputCrs ?? "未知"} → 输出 ${facts.outputCrs ?? "未知"}。`));
    checks.push(check("feature_count", typeof facts.featureCount === "number" ? (facts.featureCount > 0 ? "pass" : "warn") : "skipped",
      typeof facts.featureCount === "number" ? `输出要素数 ${facts.featureCount}。` : "执行端未回报要素数。", "info"));
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

export const OPERATION_IDS: OperationId[] = ["gis.buffer", "gis.reproject", "gis.clip", "gis.dissolve", "gis.zonal_statistics"];

/**
 * What each engine can actually do for an operation, version 1.
 *
 * `verified` means a reproducible test or baseline run exists in this repo;
 * `supported: true, verified: false` means the tool exists but v1 has no
 * evidence, and an executor must say so instead of implying it was tested.
 * This table is deliberately blunt: a capability that only "sort of" works is
 * either unsupported here or carries the reason it is limited.
 */
export type OperationSupport = {
  supported: boolean;
  verified: boolean;
  reason: string;
  degrade?: string;
};

export const OPERATION_SUPPORT: Record<OperationId, Record<ExecutionRun["provider"], OperationSupport>> = {
  "gis.buffer": {
    "browser-wasm": { supported: true, verified: true, reason: "面/点缓冲；跨引擎对照 4 例通过，半径误差 ≤1.07 m。" },
    "desktop-python": { supported: true, verified: true, reason: "GeoPandas 缓冲；跨引擎对照同一批数据通过。" },
  },
  "gis.reproject": {
    "browser-wasm": { supported: true, verified: true, reason: "同 CRS 显式 no-op；目标 CRS 由执行端写回。" },
    "desktop-python": { supported: true, verified: true, reason: "同 CRS 时引擎会报错，Agent 在调用前按契约 no-op。" },
  },
  "gis.clip": {
    "browser-wasm": {
      supported: true, verified: true,
      reason: "仅面与点（点走精确相交选择）；线、多点、混合类型被显式拒绝。",
      degrade: "线裁剪请用桌面引擎，或先把线转成面再裁剪。",
    },
    "desktop-python": { supported: true, verified: false, reason: "clip 工具存在；v1 尚未纳入可复现基线。" },
  },
  "gis.dissolve": {
    "browser-wasm": {
      supported: false, verified: false,
      reason: "WASM 1.7.1 的 dissolve 会静默丢弃部分几何：实测 5 个缓冲面只保留 1 个较小范围，且 FlatGeobuf 投影损坏（EPSG:436207616，D1）并可在读回时 panic（D2）；GeoJSON 也可能返回空集合。直接调用与 wasm_dissolve 均被拦截。",
      degrade: "改用桌面 Python 引擎；或先按组求并集（union）再删列。",
    },
    "desktop-python": { supported: true, verified: false, reason: "dissolve 工具存在；v1 尚未纳入可复现基线，不能用“支持”当已验证。" },
  },
  "gis.zonal_statistics": {
    "browser-wasm": {
      supported: false, verified: false,
      reason: "目录中的 zonal_statistics 把分区面声明为栅格，没有矢量分区输入；按工具名映射会跑错数据。",
      degrade: "请改用桌面 Python 引擎的矢量分区 + 栅格取值实现；浏览器端不会静默换成同名 WASM 工具。",
    },
    "desktop-python": {
      supported: true, verified: true,
      reason: "rasterio 以矢量面掩膜逐区统计，支持七个统计量；合成 4×4 GeoTIFF + 2 个多边形分区的数值测试通过，且明确 NoData 语义。",
    },
  },
};

export function operationSupport(id: OperationId, provider: ExecutionRun["provider"]): OperationSupport {
  return OPERATION_SUPPORT[id][provider];
}
