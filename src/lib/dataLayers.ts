/** Agent/engine result layers rendered as MapLibre GeoJSON sources. */
import type { Map, ExpressionSpecification } from "maplibre-gl";

export type LayerStyle = {
  color: string; opacity: number; pointSize: number; lineWidth: number;
  categoryField?: string;
  categories?: { value: string | number | boolean | null; color: string }[];
  labelField?: string; labelSize: number; labelColor: string;
};

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
};

export type LayerSelection = { layerId: string; featureIds: number[] };

export const SELECTION_COLOR = "#2563eb";

/** Cool, accent-compatible defaults; layer IDs still produce stable variation. */
export const PALETTE = ["#2563eb", "#0284c7", "#0891b2", "#4f46e5", "#0d9488", "#3b82f6", "#0369a1", "#6366f1"];

export function defaultLayerStyle(id: string): LayerStyle {
  const hash = [...id].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  const accent = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--tiphys-accent").trim();
  const palette = accent && /^#[0-9a-f]{6}$/i.test(accent) ? [accent, ...PALETTE.filter(color => color !== accent)] : PALETTE;
  return { color: palette[hash % palette.length], opacity: .65, pointSize: 5, lineWidth: 1.6, labelSize: 13, labelColor: "#172033" };
}

export function layerColor(style: LayerStyle): string | ExpressionSpecification {
  if (!style.categoryField || !style.categories?.length) return style.color;
  // Boolean predicates preserve the distinction between null, numeric and text values.
  return ["case", ...style.categories.flatMap(item => [
    ["==", ["get", style.categoryField!], item.value], item.color,
  ]), style.color] as ExpressionSpecification;
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
    const style = l.style ?? defaultLayerStyle(l.id);
    const vis = l.visible === false ? "none" : "visible";
    if ((l.kind ?? "vector") === "table") return;
    if (l.kind === "raster") {
      if (!map.getSource(sid) && l.image_coords?.length === 4 && l.url)
        map.addSource(sid, { type: "image", url: l.url, coordinates: l.image_coords as [[number, number], [number, number], [number, number], [number, number]] });
      if (map.getSource(sid)) {
        if (!map.getLayer(`${sid}-raster`))
          map.addLayer({ id: `${sid}-raster`, type: "raster", source: sid, paint: { "raster-opacity": style.opacity, "raster-fade-duration": 0 } });
        map.setPaintProperty(`${sid}-raster`, "raster-opacity", style.opacity);
        map.setLayoutProperty(`${sid}-raster`, "visibility", vis);
      }
      return;
    }
    const color = layerColor(style);
    if (!map.getSource(sid)) map.addSource(sid, { type: "geojson", data: l.url, generateId: true });
    // Geometry filters adapted from GeoLibre map-controller.ts (MIT, Qiusheng Wu).
    // Always provide all three representations: mixed datasets must not lose features.
      if (!map.getLayer(`${sid}-fill`))
        map.addLayer({ id: `${sid}-fill`, type: "fill", source: sid,
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: { "fill-color": selectedColor(color), "fill-opacity": selectedOpacity(style.opacity * .55) } });
      if (!map.getLayer(`${sid}-line`))
        map.addLayer({ id: `${sid}-line`, type: "line", source: sid,
          filter: ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false],
          paint: { "line-color": selectedColor(color), "line-width": selectedWidth(style.lineWidth, false), "line-opacity": style.opacity } });
    if (!map.getLayer(`${sid}-pt`)) {
      map.addLayer({
        id: `${sid}-pt`,
        type: "circle",
        source: sid,
        filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
        paint: { "circle-radius": selectedWidth(style.pointSize, true), "circle-color": selectedColor(color), "circle-opacity": style.opacity, "circle-stroke-color": selectedColor("#ffffff"), "circle-stroke-width": selectedWidth(1.5, true), "circle-stroke-opacity": style.opacity },
      });
    }
    for (const [suffix, paint] of Object.entries({
      "-fill": { "fill-color": selectedColor(color), "fill-opacity": selectedOpacity(style.opacity * .55) },
      "-line": { "line-color": selectedColor(color), "line-width": selectedWidth(style.lineWidth, false), "line-opacity": style.opacity },
      "-pt": { "circle-radius": selectedWidth(style.pointSize, true), "circle-color": selectedColor(color), "circle-opacity": style.opacity, "circle-stroke-color": selectedColor("#ffffff"), "circle-stroke-width": selectedWidth(1.5, true), "circle-stroke-opacity": style.opacity },
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
