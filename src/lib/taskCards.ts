/**
 * Mobile/desktop task cards (stage 4): preset natural-language tasks that run
 * as audited plans through the local browser WASM engine.
 *
 * Each card maps an editable NL sentence to a `Plan` deterministically — the
 * free-form chat agent stays the path for anything not covered. The card
 * explains the engine and the input budget BEFORE running, refuses rasters
 * above the mobile pixel budget instead of OOM-ing the page, and shows the
 * acceptance verdict afterwards. Pure data/functions: no React, no engine.
 */
import type { Plan, PlanStep, AcceptanceCheck } from "../../shared/plans.ts";

/** Mobile WASM budget: refuse raster inputs above this many pixels (~2 MP). */
export const MOBILE_MAX_PIXELS = 2_000_000;

export type CardLayerFacts = {
  id: string;
  name: string;
  kind: "vector" | "raster" | "table";
  crs?: string;
  featureCount?: number;
  geometryTypes?: string[];
  raster?: { width: number; height: number; bands?: number } | null;
  bytes?: number | null;
  fields?: { name: string; type: "integer" | "number" | "string" | "boolean" | "date" | "unknown" }[];
};

export type CardDraft = {
  /** The NL sentence shown to the user; editable in the card form. */
  goal: string;
  /** Chosen input layer ids (per preset slots). */
  inputs: Record<string, string>;
  /** Numeric parameter (distance etc.) where the preset has one. */
  numeric?: number;
  /** Numeric field name where the preset needs one. */
  field?: string;
};

export type CardReady = {
  ok: true;
  plan: Plan;
  /** Human-facing pre-run explanation: engine, data estimate, budget headroom. */
  explanation: { engine: string; estimate: string; budget?: string };
};

export type CardBlocked = { ok: false; reason: string; degrade: string };

export type TaskCardPreset = {
  id: string;
  title: string;
  detail: string;
  /** Slot requirements for picking input layers. */
  slots: { key: string; label: string; kind: "vector" | "raster"; geometry?: "point" | "polygon" }[];
  needsField?: "numeric";
  needsNumeric?: { label: string; default: number; min: number; max: number; unit: string };
  defaultGoal: (draft: CardDraft, layers: CardLayerFacts[]) => string;
  build: (draft: CardDraft, layers: CardLayerFacts[]) => CardReady | CardBlocked;
};

export const TASK_RECIPE_SCHEMA = "tiphys.task-recipe";
export const TASK_RECIPE_VERSION = 1;

export type TaskRecipeExport = {
  schema: typeof TASK_RECIPE_SCHEMA;
  version: typeof TASK_RECIPE_VERSION;
  exportedAt: string;
  execution: { autoRun: false; note: string };
  card: { id: string; title: string; detail: string };
  goal: string;
  inputs: { slot: string; label: string; layerId: string; layerName: string | null }[];
  numeric?: number;
  field?: string;
  plan: Plan;
};

/** Serializes the visible task-card form and its real plan without executing it. */
export function buildTaskRecipe(card: TaskCardPreset, draft: CardDraft, layers: CardLayerFacts[], plan: Plan, now = new Date()): TaskRecipeExport {
  const recipe: TaskRecipeExport = {
    schema: TASK_RECIPE_SCHEMA,
    version: TASK_RECIPE_VERSION,
    exportedAt: now.toISOString(),
    execution: {
      autoRun: false,
      note: "仅导出方案预览，不会自动执行。图层 ID 只在当前本机工作区有效，重新运行前需核对并重新映射输入。",
    },
    card: { id: card.id, title: card.title, detail: card.detail },
    goal: plan.goal || draft.goal,
    inputs: card.slots.map(slot => {
      const layerId = draft.inputs[slot.key] ?? "";
      return { slot: slot.key, label: slot.label, layerId, layerName: layers.find(layer => layer.id === layerId)?.name ?? null };
    }),
    plan,
  };
  if (draft.numeric !== undefined && Number.isFinite(draft.numeric)) recipe.numeric = draft.numeric;
  if (draft.field) recipe.field = draft.field;
  return recipe;
}

export function taskRecipeJson(recipe: TaskRecipeExport): string {
  return JSON.stringify(recipe, null, 2);
}

export function taskRecipeFilename(cardId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const stem = cardId.trim().replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "task";
  return `tiphys-recipe-${stem}-${stamp}.json`;
}

const byId = (layers: CardLayerFacts[], id: string | undefined) => layers.find(layer => layer.id === id);const vectorOf = (layers: CardLayerFacts[], id: string | undefined, geometry?: "point" | "polygon") => {
  const layer = byId(layers, id);
  if (!layer || layer.kind !== "vector") return undefined;
  if (geometry === "point" && !(layer.geometryTypes ?? []).every(t => t === "Point")) return undefined;
  if (geometry === "polygon" && !(layer.geometryTypes ?? []).some(t => ["Polygon", "MultiPolygon"].includes(t))) return undefined;
  return layer;
};
const rasterOf = (layers: CardLayerFacts[], id: string | undefined) => {
  const layer = byId(layers, id);
  return layer?.kind === "raster" && layer.raster ? layer : undefined;
};
const firstNumericField = (layer: CardLayerFacts) => layer.fields?.find(field => field.type === "integer" || field.type === "number")?.name;
const mb = (bytes?: number | null) => (bytes ? `约 ${(bytes / 1024 / 1024).toFixed(1)} MB` : "未知大小");

/** Builds a plan step with the shared id/dependsOn/acceptance envelope. */
function step(id: string, body: Record<string, unknown>, dependsOn: string[] = [], acceptance: AcceptanceCheck[] = []): PlanStep {
  return { ...body, id, dependsOn, acceptance } as PlanStep;
}

export const TASK_CARDS: TaskCardPreset[] = [
  {
    id: "buffer-points",
    title: "点缓冲服务圈",
    detail: "围绕点图层生成距离服务圈（米），本地 WASM 计算",
    slots: [{ key: "points", label: "点图层", kind: "vector", geometry: "point" }],
    needsNumeric: { label: "缓冲距离", default: 500, min: 1, max: 50000, unit: "米" },
    defaultGoal: draft => `为点图层生成 ${draft.numeric ?? 500} 米缓冲服务圈`,
    build: (draft, layers) => {
      const points = vectorOf(layers, draft.inputs.points, "point");
      if (!points) return { ok: false, reason: "请选择一个点图层。", degrade: "没有点图层时，先添加数据或加载样例点。" };
      const distance = Number(draft.numeric ?? 500);
      const plan: Plan = {
        goal: draft.goal || `为 ${points.name} 生成 ${distance} 米缓冲`,
        steps: [step("buf", { kind: "operation", spec: { operation: "gis.buffer", version: 1, input: points.id, params: { distance, units: "meters" } } },
          [], [
            { type: "feature_count", op: "eq", value: Number(points.featureCount ?? 0) },
            { type: "geometry_types", contains: ["Polygon"] },
          ])],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre WASM 计算，数据不出设备。",
        estimate: `输入「${points.name}」${points.featureCount ?? "?"} 个点、${mb(points.bytes)}；输出面要素数应与输入一致。`,
      } };
    },
  },
  {
    id: "clip-polygons",
    title: "面裁剪",
    detail: "用掩膜面裁剪输入面图层（本地求交，保留属性）",
    slots: [
      { key: "input", label: "输入面图层", kind: "vector", geometry: "polygon" },
      { key: "mask", label: "掩膜面图层", kind: "vector", geometry: "polygon" },
    ],
    defaultGoal: () => "用掩膜面裁剪所选面图层",
    build: (draft, layers) => {
      const input = vectorOf(layers, draft.inputs.input, "polygon");
      const mask = vectorOf(layers, draft.inputs.mask, "polygon");
      if (!input || !mask) return { ok: false, reason: "裁剪需要两个面图层（输入 + 掩膜）。", degrade: "线/点裁剪在浏览器端尚未支持，可在桌面引擎执行。" };
      if (input.id === mask.id) return { ok: false, reason: "输入与掩膜不能是同一个图层。", degrade: "请另选一个掩膜面图层。" };
      const plan: Plan = {
        goal: draft.goal || `用 ${mask.name} 裁剪 ${input.name}`,
        steps: [step("cut", { kind: "operation", spec: { operation: "gis.clip", version: 1, input: input.id, params: { maskLayerId: mask.id } } },
          [], [
            { type: "geometry_types", contains: ["Polygon"] },
            { type: "feature_count", op: "gte", value: 1 },
          ])],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre WASM 计算，数据不出设备。",
        estimate: `输入「${input.name}」×掩膜「${mask.name}」（合计 ${mb((input.bytes ?? 0) + (mask.bytes ?? 0))}）；结果应落在掩膜范围内。`,
      } };
    },
  },
  {
    id: "intersect-area",
    title: "叠加求交与面积",
    detail: "两个面图层求交，量算重叠面积（平方米）",
    slots: [
      { key: "a", label: "面图层 A", kind: "vector", geometry: "polygon" },
      { key: "b", label: "面图层 B", kind: "vector", geometry: "polygon" },
    ],
    defaultGoal: () => "求两个面图层的重叠部分并计算面积",
    build: (draft, layers) => {
      const a = vectorOf(layers, draft.inputs.a, "polygon");
      const b = vectorOf(layers, draft.inputs.b, "polygon");
      if (!a || !b) return { ok: false, reason: "叠加需要两个面图层。", degrade: "只有单个面图层时，可用缓冲/裁剪任务卡。" };
      if (a.id === b.id) return { ok: false, reason: "两个输入不能是同一个图层。", degrade: "请另选一个面图层。" };
      const plan: Plan = {
        goal: draft.goal || `求 ${a.name} 与 ${b.name} 的交集并量算面积`,
        steps: [
          step("cut", { kind: "operation", spec: { operation: "gis.clip", version: 1, input: a.id, params: { maskLayerId: b.id } } }, [], [
            { type: "geometry_types", contains: ["Polygon"] },
          ]),
          step("area", { kind: "tool", tool: "calculate_geometry", args: { layer: "@cut" } }, ["cut"], [
            { type: "layer_field", index: 0, field: "area_m2", op: "gte", value: 1 },
          ]),
        ],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre WASM 计算，数据不出设备。",
        estimate: `「${a.name}」∩「${b.name}」（合计 ${mb((a.bytes ?? 0) + (b.bytes ?? 0))}）；输出带 area_m2 字段。`,
      } };
    },
  },
  {
    id: "field-stats",
    title: "字段统计",
    detail: "统计数值字段的均值/中位数/标准差（只读，不新建图层）",
    slots: [{ key: "layer", label: "矢量图层", kind: "vector" }],
    needsField: "numeric",
    defaultGoal: () => "统计所选图层数值字段的分布",
    build: (draft, layers) => {
      const layer = vectorOf(layers, draft.inputs.layer);
      if (!layer) return { ok: false, reason: "请选择一个矢量图层。", degrade: "栅格统计请用分区统计（尚在建设中）。" };
      const field = draft.field ?? firstNumericField(layer);
      if (!field) return { ok: false, reason: "该图层没有数值字段可统计。", degrade: "换一个带数值字段的图层。" };
      const plan: Plan = {
        goal: draft.goal || `统计 ${layer.name} 的 ${field} 字段`,
        steps: [step("stat", { kind: "tool", tool: "field_statistics", args: { layer: layer.id, field } }, [], [
          { type: "field_value", field: "count", op: "eq", value: Number(layer.featureCount ?? 0) },
        ])],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地计算，只读不修改数据。",
        estimate: `「${layer.name}」${layer.featureCount ?? "?"} 个要素的 ${field} 字段。`,
      } };
    },
  },
  {
    id: "dem-slope",
    title: "DEM 坡度与山体阴影",
    detail: "坡度（度）+ 山体阴影，像元数受手机预算限制",
    slots: [{ key: "dem", label: "DEM 栅格", kind: "raster" }],
    defaultGoal: () => "计算 DEM 坡度并生成山体阴影",
    build: (draft, layers) => {
      const dem = rasterOf(layers, draft.inputs.dem);
      if (!dem) return { ok: false, reason: "请选择一个 DEM 栅格图层。", degrade: "手机端暂只支持 GeoTIFF DEM。" };
      const pixels = dem.raster!.width * dem.raster!.height;
      if (pixels > MOBILE_MAX_PIXELS) {
        return {
          ok: false,
          reason: `栅格 ${dem.raster!.width}×${dem.raster!.height}＝${(pixels / 1e6).toFixed(1)} 百万像素，超出手机端预算（${(MOBILE_MAX_PIXELS / 1e6).toFixed(1)} 百万）。`,
          degrade: "先裁剪研究区或降采样后重试；或在桌面端执行同一任务。",
        };
      }
      const plan: Plan = {
        goal: draft.goal || `计算 ${dem.name} 的坡度与山体阴影`,
        steps: [
          // Hillshade first so the slope step's raster_dims acceptance can
          // reference an EARLIER step output (acceptance only sees prior steps).
          step("hs", { kind: "tool", tool: "wasm_hillshade", args: { input: dem.id } }, []),
          step("slope", { kind: "tool", tool: "wasm_slope", args: { input: dem.id, units: "degrees" } }, ["hs"], [
            { type: "raster_dims", ref: "hs" },
          ]),
        ],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre WASM（Worker 线程）计算，数据不出设备。",
        estimate: `输入「${dem.name}」${dem.raster!.width}×${dem.raster!.height}、${mb(dem.bytes)}；输出两张同尺寸栅格。`,
        budget: `手机端预算 ${MOBILE_MAX_PIXELS / 1e6} 百万像素，本次占用 ${((pixels / MOBILE_MAX_PIXELS) * 100).toFixed(0)}%。`,
      } };
    },
  },
  {
    id: "hydro-network",
    title: "DEM 河网提取",
    detail: "填洼 → D8 流向 → 汇流累积 → 阈值河网 → 转面（5 步链，带验收）",
    slots: [{ key: "dem", label: "DEM 栅格", kind: "raster" }],
    needsNumeric: { label: "河网阈值（上游汇流像元数）", default: 50, min: 1, max: 100000, unit: "像元" },
    defaultGoal: draft => `从 DEM 提取河网（阈值 ${draft.numeric ?? 50} 像元汇流）并转为面图层`,
    build: (draft, layers) => {
      const dem = rasterOf(layers, draft.inputs.dem);
      if (!dem) return { ok: false, reason: "请选择一个 DEM 栅格图层。", degrade: "手机端暂只支持 GeoTIFF DEM。" };
      const pixels = dem.raster!.width * dem.raster!.height;
      if (pixels > MOBILE_MAX_PIXELS) {
        return {
          ok: false,
          reason: `栅格 ${dem.raster!.width}×${dem.raster!.height}＝${(pixels / 1e6).toFixed(1)} 百万像素，超出手机端预算（${(MOBILE_MAX_PIXELS / 1e6).toFixed(1)} 百万）。`,
          degrade: "先裁剪研究区或降采样后重试；或在桌面端执行同一任务。",
        };
      }
      const threshold = Math.max(1, Math.round(Number(draft.numeric ?? 50)));
      const plan: Plan = {
        goal: draft.goal || `从 ${dem.name} 提取河网并转为面图层`,
        steps: [
          // Whitebox D8 chain; parameter names follow the WASM manifests exactly
          // (d8_pntr / flow_accumulation are raster inputs, not commands).
          step("fill", { kind: "tool", tool: "wasm_fill_depressions", args: { dem: dem.id } }, [], [
            { type: "raster_dims" },
          ]),
          step("d8", { kind: "tool", tool: "wasm_d8_pointer", args: { dem: "@fill" } }, ["fill"], []),
          step("acc", { kind: "tool", tool: "wasm_d8_flow_accum", args: { input: "@d8" } }, ["d8"], [
            { type: "raster_dims", ref: "fill" },
          ]),
          step("streams", { kind: "tool", tool: "wasm_extract_streams", args: { flow_accumulation: "@acc", threshold } }, ["acc"], []),
          step("poly", { kind: "tool", tool: "wasm_raster_to_vector_polygons", args: { input: "@streams" } }, ["streams"], [
            { type: "feature_count", op: "gte", value: 1 },
            { type: "geometry_types", contains: ["Polygon", "MultiPolygon"] },
          ]),
        ],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre WASM（Whitebox D8 链），数据不出设备。",
        estimate: `输入「${dem.name}」${dem.raster!.width}×${dem.raster!.height}；阈值 ${threshold} 像元（阈值越大河网越稀疏）；5 步链每步有验收。`,
        budget: `手机端预算 ${MOBILE_MAX_PIXELS / 1e6} 百万像素，本次占用 ${((pixels / MOBILE_MAX_PIXELS) * 100).toFixed(0)}%。`,
      } };
    },
  },
  {
    id: "service-zone",
    title: "学校服务圈统计",
    detail: "点服务圈 + 居住区覆盖裁剪 + 户数统计（欧式距离，口径见说明）",
    slots: [
      { key: "schools", label: "学校（点）", kind: "vector", geometry: "point" },
      { key: "homes", label: "居住区（面）", kind: "vector", geometry: "polygon" },
    ],
    needsNumeric: { label: "服务半径", default: 1000, min: 10, max: 50000, unit: "米" },
    defaultGoal: draft => `统计学校 ${draft.numeric ?? 1000} 米服务圈覆盖的居住区与户数`,
    build: (draft, layers) => {
      const schools = vectorOf(layers, draft.inputs.schools, "point");
      const homes = vectorOf(layers, draft.inputs.homes, "polygon");
      if (!schools || !homes) return { ok: false, reason: "需要学校点图层与居住区面图层。", degrade: "路网距离版服务圈暂不支持；本卡为欧式距离。" };
      const distance = Number(draft.numeric ?? 1000);
      const plan: Plan = {
        goal: draft.goal || `统计 ${schools.name} ${distance} 米服务圈覆盖的居住区户数`,
        steps: [
          step("buf", { kind: "operation", spec: { operation: "gis.buffer", version: 1, input: schools.id, params: { distance, units: "meters" } } }, [], [
            { type: "feature_count", op: "eq", value: Number(schools.featureCount ?? 0) },
          ]),
          step("cover", { kind: "operation", spec: { operation: "gis.clip", version: 1, input: homes.id, params: { maskLayerId: "@buf" } } }, ["buf"], [
            { type: "geometry_types", contains: ["Polygon", "MultiPolygon"] },
          ]),
          step("stat", { kind: "tool", tool: "field_statistics", args: { layer: "@cover", field: "households" } }, ["cover"], [
            { type: "field_value", field: "count", op: "gte", value: 1 },
          ]),
        ],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre WASM 计算，数据不出设备。",
        estimate: `「${schools.name}」${schools.featureCount ?? "?"} 所 × ${distance} 米圈 ∩「${homes.name}」。`,
        budget: "统计口径：欧式距离、相交即计入（块与任一服务圈有重叠就裁入，跨圈不重复累计户数）；部分覆盖的块按整块户数计入，不做面积加权。路网距离暂不支持，需要时先向用户澄清。",
      } };
    },
  },
  {
    id: "ecology-corridor",
    title: "生态最小成本廊道",
    detail: "源地/目的地累积阻力 → 廊道面（两个用户给定阻力方案对比，非生态模型）",
    slots: [
      { key: "resistance", label: "阻力面（用户给定方案）", kind: "raster" },
      { key: "sources", label: "源地（正值栅格）", kind: "raster" },
      { key: "destination", label: "目的地（正值栅格）", kind: "raster" },
    ],
    needsNumeric: { label: "近最优廊道带宽（高于最小成本百分比）", default: 5, min: 0, max: 50, unit: "%" },
    defaultGoal: draft => `比较阻力方案下的生态最小成本廊道（近最优带 ${draft.numeric ?? 5}%）`,
    build: (draft, layers) => {
      const resistance = rasterOf(layers, draft.inputs.resistance);
      const sources = rasterOf(layers, draft.inputs.sources);
      const destination = rasterOf(layers, draft.inputs.destination);
      if (!resistance || !sources || !destination) {
        return { ok: false, reason: "需要阻力面、源地栅格与目的地栅格。", degrade: "阻力权重必须由用户提供；本卡不推断物种扩散或生境质量。" };
      }
      const grid = (layer: CardLayerFacts) => `${layer.raster!.width}x${layer.raster!.height}`;
      const expected = grid(resistance);
      for (const [label, layer] of [["源地", sources], ["目的地", destination]] as const) {
        if (grid(layer) !== expected) return { ok: false, reason: `${label}栅格 ${grid(layer)} 与阻力面 ${expected} 不同网格。`, degrade: "先重采样/裁剪到与阻力面相同的 CRS 和像元网格；本卡不会静默对齐。" };
        if (resistance.crs && layer.crs && resistance.crs !== layer.crs) return { ok: false, reason: `${label}栅格 CRS ${layer.crs} 与阻力面 ${resistance.crs} 不同。`, degrade: "先重投影到同一 CRS 再运行。" };
      }
      const pixels = resistance.raster!.width * resistance.raster!.height;
      if (pixels > MOBILE_MAX_PIXELS) {
        return {
          ok: false,
          reason: `阻力面 ${resistance.raster!.width}×${resistance.raster!.height}＝${(pixels / 1e6).toFixed(1)} 百万像素，超出手机端预算（${(MOBILE_MAX_PIXELS / 1e6).toFixed(1)} 百万）。`,
          degrade: "先裁剪研究区或降采样后重试；或在桌面端执行同一任务。",
        };
      }
      const percent = Math.min(50, Math.max(0, Number(draft.numeric ?? 5)));
      const plan: Plan = {
        goal: draft.goal || `用 ${resistance.name} 计算源地与目的地之间的最小成本廊道`,
        steps: [
          // Direct corridor mode consumes the two accumulated-cost surfaces. The
          // parameter names are the catalog wire names (source/cost/cost1/cost2).
          step("cost_source", { kind: "tool", tool: "wasm_cost_distance", args: { source: sources.id, cost: resistance.id } }, [], [
            { type: "raster_dims" },
          ]),
          step("cost_dest", { kind: "tool", tool: "wasm_cost_distance", args: { source: destination.id, cost: resistance.id } }, [], [
            { type: "raster_dims", ref: "cost_source" },
          ]),
          step("corridor", { kind: "tool", tool: "wasm_corridor", args: { cost1: "@cost_source", cost2: "@cost_dest", percent } }, ["cost_source", "cost_dest"], [
            { type: "raster_dims", ref: "cost_source" },
          ]),
        ],
      };
      return { ok: true, plan, explanation: {
        engine: "浏览器本地 GeoLibre/Whitebox WASM：两次累积成本距离 + 廊道面，数据不出设备。",
        estimate: `「${resistance.name}」${expected}；源地「${sources.name}」、目的地「${destination.name}」；保留最小廊道成本以上 ${percent}% 的近最优带。`,
        budget: `手机端预算 ${MOBILE_MAX_PIXELS / 1e6} 百万像素，本次占用 ${((pixels / MOBILE_MAX_PIXELS) * 100).toFixed(0)}%。阻力权重是用户给定方案，不是本产品推断的生态学结论；本链是最小成本廊道，不是 Circuitscape 电流连通、InVEST 或 ArcPy Linkage Mapper。`,
      } };
    },
  },
];

export function cardById(id: string) {
  return TASK_CARDS.find(card => card.id === id);
}

/** True when a layer can fill a slot (kind + optional geometry family). */
export function slotMatches(layer: CardLayerFacts, kind: "vector" | "raster", geometry?: "point" | "polygon") {
  if (layer.kind !== kind) return false;
  if (geometry === "point") return (layer.geometryTypes ?? []).every(t => t === "Point");
  if (geometry === "polygon") return (layer.geometryTypes ?? []).some(t => ["Polygon", "MultiPolygon"].includes(t));
  return true;
}

/** Suggests inputs for a preset from the current workspace (selected layer first, no slot collisions). */
export function suggestDraft(preset: TaskCardPreset, layers: CardLayerFacts[], selectedLayerId?: string | null): CardDraft {
  const inputs: Record<string, string> = {};
  const used = new Set<string>();
  for (const slot of preset.slots) {
    const chosen = layers.find(layer => layer.id === selectedLayerId && !used.has(layer.id) && slotMatches(layer, slot.kind, slot.geometry))
      ?? layers.find(layer => !used.has(layer.id) && slotMatches(layer, slot.kind, slot.geometry))
      ?? layers.find(layer => slotMatches(layer, slot.kind, slot.geometry));
    if (chosen) { inputs[slot.key] = chosen.id; used.add(chosen.id); }
  }
  const primary = byId(layers, inputs[preset.slots[0].key]);
  const draft: CardDraft = { goal: "", inputs, numeric: preset.needsNumeric?.default };
  if (preset.needsField && primary) draft.field = firstNumericField(primary);
  draft.goal = preset.defaultGoal(draft, layers);
  return draft;
}
