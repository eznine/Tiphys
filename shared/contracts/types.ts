/**
 * TIPHYS shared GIS contracts — version 1.
 *
 * Purpose: the UI, the browser WASM engine and the Python sidecar must agree on
 * WHAT an operation means even though they execute it differently. These are
 * pure data types plus pure functions: no DOM, no Node, no engine imports, so
 * the same file can be consumed by Vite, the agent sidecar and tests.
 *
 * Rules of this module:
 * - A layer reference never implies "the display URL is the data". `data`
 *   states where the bytes actually live.
 * - Every operation carries a `version`; changing semantics means a new version.
 * - Nothing here may invent a value the executor did not report. Optional fields
 *   are absent rather than guessed.
 */

/** Where an operation runs. */
export type EngineId = "browser-wasm" | "desktop-python";

export type LayerKind = "vector" | "raster" | "table";

/** CRS is kept as an authority string; "EPSG:32650" is the only accepted shape today. */
export type CrsCode = string;

export type FieldType = "integer" | "number" | "string" | "boolean" | "date" | "unknown";

export type FieldInfo = {
  name: string;
  type: FieldType;
  /** Only present when the executor actually counted them. */
  nullCount?: number | null;
  /** One representative value, already JSON-safe. */
  sample?: unknown;
};

export type RasterInfo = {
  width: number;
  height: number;
  bands: number;
  /** NoData of band 1 when the reader reports it; `null` means "read as no NoData". */
  nodata?: number | null;
  dtype?: string;
  /** Pixel size in the unit of `crs` (metres for projected CRSs, degrees otherwise). */
  pixelSize?: [number, number] | null;
};

/**
 * Physical location of the layer's bytes. `location` is a storage key
 * (`file:` path, `indexeddb:<id>`), not a display URL.
 */
export type LayerDataRef = {
  engine: EngineId;
  storage: "file" | "indexeddb";
  location: string;
  /** Original imported file, when known. Never derived from the display URL. */
  sourcePath?: string | null;
  format: string;
  /** Size of the analysis bytes, when the executor can measure them cheaply. */
  bytes?: number;
  /** Content digest used as the version summary (sha256 hex, `sha256:` prefix). */
  sha256?: string;
  /** Cheap human-facing revision: digest prefix + short timestamp. */
  revision?: string;
};

/**
 * A reference to one analysis layer. `crs` is the analysis CRS; `bounds` are
 * WGS84 degrees exactly like `DataLayer.bounds` — never native projected units.
 */
export type LayerRef = {
  id: string;
  name: string;
  kind: LayerKind;
  crs: CrsCode;
  /** Every TIPHYS map representation is WGS84; stated once so nobody re-derives it. */
  displayCrs: "EPSG:4326";
  geometryTypes: string[];
  featureCount: number;
  /** [west, south, east, north] in WGS84 degrees. */
  bounds: number[] | null;
  raster?: RasterInfo;
  data: LayerDataRef;
};

/** Read-only answer to "what is actually in this workspace?". */
export type LayerInspection = {
  layer: LayerRef;
  fields: FieldInfo[];
  /** Present for raster layers when the reader exposes statistics. */
  rasterStats?: { min: number; max: number; mean: number } | null;
  /** Extra engine-specific facts, must be JSON-safe and clearly namespaced. */
  extra?: Record<string, unknown>;
};

export type WorkspaceInspection = {
  engine: EngineId;
  layers: LayerInspection[];
  /** Set when some layer could not be inspected; the rest is still returned. */
  errors?: { layerId: string; message: string }[];
};

export type DistanceUnit = "meters" | "kilometers" | "miles";

/** Operation ids are stable strings; the version lives on the spec. */
export type OperationId = "gis.buffer" | "gis.reproject";

export type OutputOptions = {
  /** Requested display name for the output layer. */
  outputName?: string;
};

export type BufferParams = OutputOptions & {
  /** Always a metric/imperial length; the executor converts to metres internally. */
  distance: number;
  units: DistanceUnit;
  /** Merge overlapping buffers into one geometry per connected component. */
  dissolve?: boolean;
};

export type ReprojectParams = OutputOptions & {
  /** Target authority code, e.g. "EPSG:3857". */
  targetCrs: CrsCode;
};

export type BufferSpec = {
  operation: "gis.buffer";
  version: 1;
  input: string;
  params: BufferParams;
};

export type ReprojectSpec = {
  operation: "gis.reproject";
  version: 1;
  input: string;
  params: ReprojectParams;
};

export type OperationSpec = BufferSpec | ReprojectSpec;

export type ValidationStatus = "pass" | "warn" | "fail" | "not_tested";

export type ValidationCheck = {
  id: string;
  status: "pass" | "warn" | "fail" | "skipped";
  detail: string;
  /** `gate` failures make the operation unusable; `info` findings only inform. */
  severity: "gate" | "info";
};

export type Validation = {
  status: ValidationStatus;
  checks: ValidationCheck[];
};

/** Error taxonomy frozen in stage 1; stage 3 only adds transport details. */
export type ErrorClass =
  | "INPUT_ERROR"
  | "UNSUPPORTED"
  | "RESOURCE_LIMIT"
  | "EXECUTION_ERROR"
  | "VALIDATION_ERROR"
  | "USER_CANCELLED";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/** One executed operation, sufficient to replay and to audit. */
export type ExecutionRun = {
  runId: string;
  operation: OperationId;
  version: number;
  provider: EngineId;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  input: { layerId: string; crs: CrsCode; sha256?: string };
  params: BufferParams | ReprojectParams;
  outputs: LayerRef[];
  validation: Validation;
  error?: { class: ErrorClass; message: string };
  /** Human-readable executor steps; no floating claims. */
  log?: string[];
};

/** What a provider can do; used to route and to explain refusals. */
export type ProviderCapability = {
  provider: EngineId;
  registry: "python-mcp" | "geolibre-wasm";
  operationVersions: Partial<Record<OperationId, number[]>>;
  limits: {
    /** Largest input this provider has been measured on, in bytes (not a guarantee). */
    measuredMaxInputBytes?: number;
    cancellable: "always" | "between-steps" | "no";
    /** True when a crashing tool cannot take down the provider process. */
    isolatedExecutor: boolean;
  };
  notes: string[];
};