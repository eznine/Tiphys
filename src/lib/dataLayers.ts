/** Agent/engine result layers rendered as MapLibre GeoJSON sources. */
import type { Map, ExpressionSpecification } from "maplibre-gl";

export type LayerStyle = {
  color: string; strokeColor?: string; opacity: number; fillOpacity?: number; strokeOpacity?: number; pointSize: number; lineWidth: number;
  ramp?: VectorRamp;
  categoryField?: string;
  categories?: { value: string | number | boolean | null; color: string }[];
  classField?: string;
  classBreaks?: ClassBreak[];
  classMethod?: ClassMethod;
  classCount?: number;
  classMin?: number;
  classMax?: number;
  labelField?: string; labelSize: number; labelColor: string;
  rasterStretch?: RasterStretch;
};

export type VectorRamp = "blue" | "slate" | "earth";
export type RasterStretch = "auto" | "soft" | "high";
export type ClassMethod = "manual" | "equal" | "quantile";
export type ClassBreak = { min: number; max: number; color: string; label?: string };
export type SymbologyMode = "single" | "unique" | "graduated";

export type DataLayer = {
  id: string;
  name: string;
  url: string;
  geometry_types: string[];
  feature_count: number;
  bounds: number[] | null;
  crs?: string;
  visible?: boolean;
  style?: LayerStyle;
  /** vector renders GeoJSON; raster renders a georeferenced PNG; table has no map drawing. */
  kind?: "vector" | "raster" | "table";
  /** WGS84 corners of a raster layer in MapLibre image-source order (TL, TR, BR, BL). */
  image_coords?: number[][];
  raster?: { width: number; height: number; bands: number };
  /** Internal managed work-copy path, when the engine reports one. */
  path?: string | null;
  /** Original imported file path. Browser workspace copies intentionally leave this unset. */
  sourcePath?: string | null;
  /** Python engine's snake_case spelling of `sourcePath`. */
  source_path?: string | null;
  /** Analysis data format (for example geojson, gpkg, fgb, tif or csv). */
  format?: string;
  /** Size of the managed analysis/work copy when cheaply known. */
  bytes?: number;
};

export type LayerSelection = { layerId: string; featureIds: number[] };

export const SELECTION_COLOR = "#2563eb";

/** Cool defaults stay in the blue/indigo accent family; IDs produce stable variation. */
export const PALETTE = ["#2563eb", "#0284c7", "#0369a1", "#4f46e5", "#3b82f6", "#1d4ed8", "#0ea5e9", "#6366f1"];
const BLUE_HELPER_PALETTE = ["#2563eb", "#1d4ed8", "#0284c7", "#3b82f6", "#0369a1", "#4f46e5"];
export const RAMP_PRESETS: Record<VectorRamp, string[]> = {
  blue: PALETTE,
  slate: ["#334155", "#475569", "#64748b", "#0f172a", "#94a3b8", "#1e293b", "#cbd5e1", "#334155"],
  earth: ["#92400e", "#b45309", "#a16207", "#4d7c0f", "#9a3412", "#365314", "#ca8a04", "#78350f"],
};

export function categoryColors(count: number, ramp: VectorRamp = "blue"): string[] {
  const colors = RAMP_PRESETS[ramp] ?? PALETTE;
  return Array.from({ length: Math.max(0, count) }, (_, index) => colors[index % colors.length]);
}

/** Helper outputs get a predictable blue treatment so AOI/corridor/LCP do not drift teal. */
function paletteFor(name = ""): string[] {
  if (/(^|[\s_-])(AOI|LCP)([\s_-]|$)|走廊|廊道|corridor|least.?cost|最小成本|水文/i.test(name)) return BLUE_HELPER_PALETTE;
  return PALETTE;
}

export function defaultLayerStyle(id: string, name = ""): LayerStyle {
  const hash = [...id].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  const accent = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--tiphys-accent").trim();
  const fallback = paletteFor(name);
  const palette = accent && /^#[0-9a-f]{6}$/i.test(accent) ? [accent, ...fallback.filter(color => color !== accent)] : fallback;
  return { color: palette[hash % palette.length], opacity: .65, fillOpacity: .55, strokeOpacity: 1, pointSize: 5, lineWidth: 1.6,
    ramp: "blue", labelSize: 13, labelColor: "#172033", rasterStretch: "auto" };
}

export function layerColor(style: LayerStyle): string | ExpressionSpecification {
  if (style.classField && style.classBreaks?.length) return graduatedColorExpression(style.classField, style.classBreaks, style.color);
  if (!style.categoryField || !style.categories?.length) return style.color;
  // Boolean predicates preserve the distinction between null, numeric and text values.
  return ["case", ...style.categories.flatMap(item => [
    ["==", ["get", style.categoryField!], item.value], item.color,
  ]), style.color] as ExpressionSpecification;
}

/** Numeric class renderer: values outside the manual range clamp to the nearest class. */
export function graduatedColorExpression(field: string, breaks: ClassBreak[], fallback: string): ExpressionSpecification {
  const classes = breaks
    .filter(item => Number.isFinite(item.min) && Number.isFinite(item.max) && item.max > item.min)
    .sort((a, b) => a.min - b.min);
  if (!classes.length) return fallback as unknown as ExpressionSpecification;
  const lower = classes[0].min;
  const upper = classes[classes.length - 1].max;
  const value = ["min", ["max", ["get", field], lower], upper];
  const step: unknown[] = ["step", value, classes[0].color];
  let previous = lower;
  for (const item of classes.slice(1)) {
    if (item.min <= previous) continue;
    step.push(item.min, item.color);
    previous = item.min;
  }
  // Null, text and malformed values keep the ordinary fallback instead of joining class one.
  return ["case", ["==", ["typeof", ["get", field]], "number"], step as unknown as ExpressionSpecification, fallback] as ExpressionSpecification;
}

/** A mode switch must never leave a unique-value and a graduated renderer both active. */
export function symbologyMode(style: LayerStyle): SymbologyMode {
  if (style.classField) return "graduated";
  if (style.categoryField) return "unique";
  return "single";
}

export function withSymbologyMode(style: LayerStyle, mode: SymbologyMode): LayerStyle {
  const next = { ...style };
  if (mode !== "unique") { next.categoryField = undefined; next.categories = undefined; }
  if (mode !== "graduated") {
    next.classField = undefined; next.classBreaks = undefined; next.classMethod = undefined;
    next.classCount = undefined; next.classMin = undefined; next.classMax = undefined;
  }
  return next;
}

export function rampGradient(colors: string[]): string {
  if (!colors.length) return "transparent";
  if (colors.length === 1) return colors[0];
  return `linear-gradient(90deg, ${colors.map((color, index) => `${color} ${(index / (colors.length - 1) * 100).toFixed(1)}%`).join(", ")})`;
}

export function syncDataLayers(map: Map, layers: DataLayer[]) {
  if (!map.isStyleLoaded()) return;
  const want = new Set(layers.map((l) => `tiphys-${l.id}`));
  for (const l of map.getStyle().layers ?? []) {
    const src = (l as { source?: string }).source;
    if (src?.startsWith("tiphys-lyr_") && !want.has(src)) map.removeLayer(l.id);
  }
  for (const id of Object.keys(map.getStyle().sources ?? {})) {
    if (id.startsWith("tiphys-lyr_") && !want.has(id)) map.removeSource(id);
  }
  layers.forEach((l) => {
    const sid = `tiphys-${l.id}`;
    const style = l.style ?? defaultLayerStyle(l.id, l.name);
    const vis = l.visible === false ? "none" : "visible";
    if ((l.kind ?? "vector") === "table") return;
    if (l.kind === "raster") {
      if (!map.getSource(sid) && l.image_coords?.length === 4 && l.url)
        map.addSource(sid, { type: "image", url: l.url, coordinates: l.image_coords as [[number, number], [number, number], [number, number], [number, number]] });
      if (map.getSource(sid)) {
        const stretch = rasterStretch(style.rasterStretch);
        if (!map.getLayer(`${sid}-raster`))
          map.addLayer({ id: `${sid}-raster`, type: "raster", source: sid, paint: { "raster-opacity": style.opacity, "raster-fade-duration": 0,
            "raster-brightness-min": stretch.brightnessMin, "raster-brightness-max": stretch.brightnessMax,
            "raster-contrast": stretch.contrast, "raster-saturation": stretch.saturation, "raster-resampling": "linear" } });
        map.setPaintProperty(`${sid}-raster`, "raster-opacity", style.opacity);
        map.setPaintProperty(`${sid}-raster`, "raster-brightness-min", stretch.brightnessMin);
        map.setPaintProperty(`${sid}-raster`, "raster-brightness-max", stretch.brightnessMax);
        map.setPaintProperty(`${sid}-raster`, "raster-contrast", stretch.contrast);
        map.setPaintProperty(`${sid}-raster`, "raster-saturation", stretch.saturation);
        map.setPaintProperty(`${sid}-raster`, "raster-resampling", "linear");
        map.setLayoutProperty(`${sid}-raster`, "visibility", vis);
      }
      return;
    }
    const color = layerColor(style);
    const graduated = !!(style.classField && style.classBreaks?.length);
    const strokeColor = graduated ? color : style.strokeColor ?? style.color;
    if (!map.getSource(sid)) map.addSource(sid, { type: "geojson", data: l.url, generateId: true });
    // Geometry filters adapted from GeoLibre map-controller.ts (MIT, Qiusheng Wu).
    // Always provide all three representations: mixed datasets must not lose features.
      if (!map.getLayer(`${sid}-fill`))
        map.addLayer({ id: `${sid}-fill`, type: "fill", source: sid,
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: { "fill-color": selectedColor(color), "fill-opacity": selectedOpacity(style.opacity * (style.fillOpacity ?? .55)) } });
      if (!map.getLayer(`${sid}-line`))
        map.addLayer({ id: `${sid}-line`, type: "line", source: sid,
          filter: ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false],
          paint: { "line-color": selectedColor(strokeColor), "line-width": selectedWidth(style.lineWidth, false), "line-opacity": strokeOpacity(style) } });
    if (!map.getLayer(`${sid}-pt`)) {
      map.addLayer({
        id: `${sid}-pt`,
        type: "circle",
        source: sid,
        filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
        paint: { "circle-radius": selectedWidth(style.pointSize, true), "circle-color": selectedColor(color), "circle-opacity": style.opacity,
          "circle-stroke-color": selectedColor(style.strokeColor ?? "#ffffff"), "circle-stroke-width": selectedWidth(1.5, true), "circle-stroke-opacity": strokeOpacity(style) },
      });
    }
    for (const [suffix, paint] of Object.entries({
      "-fill": { "fill-color": selectedColor(color), "fill-opacity": selectedOpacity(style.opacity * (style.fillOpacity ?? .55)) },
      "-line": { "line-color": selectedColor(strokeColor), "line-width": selectedWidth(style.lineWidth, false), "line-opacity": strokeOpacity(style) },
      "-pt": { "circle-radius": selectedWidth(style.pointSize, true), "circle-color": selectedColor(color), "circle-opacity": style.opacity,
        "circle-stroke-color": selectedColor(style.strokeColor ?? "#ffffff"), "circle-stroke-width": selectedWidth(1.5, true), "circle-stroke-opacity": strokeOpacity(style) },
    })) {
      for (const [name, value] of Object.entries(paint)) map.setPaintProperty(sid + suffix, name as Parameters<Map["setPaintProperty"]>[1], value);
      map.setLayoutProperty(sid + suffix, "visibility", vis);
    }
    const labelId = `${sid}-label`;
    if (style.labelField) {
      if (!map.getStyle().glyphs) map.setGlyphs("https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf");
      if (!map.getLayer(labelId)) map.addLayer({ id: labelId, type: "symbol", source: sid,
        layout: { "text-field": ["to-string", ["coalesce", ["get", style.labelField], ""]], "text-font": ["Noto Sans Regular"],
          "text-size": style.labelSize, "text-offset": [0, 1], "text-anchor": "top" },
        paint: { "text-color": style.labelColor, "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
      map.setLayoutProperty(labelId, "text-field", ["to-string", ["coalesce", ["get", style.labelField], ""]]);
      map.setLayoutProperty(labelId, "text-size", style.labelSize);
      map.setLayoutProperty(labelId, "visibility", vis);
      map.setPaintProperty(labelId, "text-color", style.labelColor);
    } else if (map.getLayer(labelId)) map.removeLayer(labelId);
  });
}

function selectedColor(base: string | ExpressionSpecification): ExpressionSpecification {
  return ["case", ["boolean", ["feature-state", "selected"], false], SELECTION_COLOR, base] as ExpressionSpecification;
}

function selectedOpacity(base: number): ExpressionSpecification {
  return ["case", ["boolean", ["feature-state", "selected"], false], Math.min(1, base + .22), base] as ExpressionSpecification;
}

function selectedWidth(base: number, point: boolean): ExpressionSpecification {
  return ["case", ["boolean", ["feature-state", "selected"], false], base + (point ? 3 : 2), base] as ExpressionSpecification;
}

function strokeOpacity(style: LayerStyle): number {
  return Math.max(0, Math.min(1, style.opacity * (style.strokeOpacity ?? 1)));
}

export function rasterStretch(value: RasterStretch = "auto") {
  if (value === "soft") return { brightnessMin: .06, brightnessMax: .94, contrast: -.08, saturation: -.12 };
  if (value === "high") return { brightnessMin: .12, brightnessMax: .84, contrast: .12, saturation: .08 };
  return { brightnessMin: 0, brightnessMax: 1, contrast: 0, saturation: 0 };
}
