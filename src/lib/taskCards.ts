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
