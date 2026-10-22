/** Agent/engine result layers rendered as MapLibre GeoJSON sources. */
import type { Map } from "maplibre-gl";

export type DataLayer = {
  id: string;
  name: string;
  url: string;
  geometry_types: string[];
  feature_count: number;
  bounds: number[] | null;
  crs?: string;
  visible?: boolean;
};

const PALETTE = ["#ff7a45", "#36cfc9", "#9254de", "#f7ba1e", "#4096ff"];

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
  layers.forEach((l, i) => {
    const sid = `tiphys-${l.id}`;
    const color = PALETTE[i % PALETTE.length];
    if (!map.getSource(sid)) map.addSource(sid, { type: "geojson", data: l.url });
    const vis = l.visible === false ? "none" : "visible";
    const poly = l.geometry_types.some((g) => /POLYGON/i.test(g));
    if (poly) {
      if (!map.getLayer(`${sid}-fill`))
        map.addLayer({ id: `${sid}-fill`, type: "fill", source: sid, paint: { "fill-color": color, "fill-opacity": 0.28 } });
      if (!map.getLayer(`${sid}-line`))
        map.addLayer({ id: `${sid}-line`, type: "line", source: sid, paint: { "line-color": color, "line-width": 1.6 } });
    } else if (!map.getLayer(`${sid}-pt`)) {
      map.addLayer({
        id: `${sid}-pt`,
        type: "circle",
        source: sid,
        paint: { "circle-radius": 5, "circle-color": color, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
      });
    }
    for (const suf of ["-fill", "-line", "-pt"]) if (map.getLayer(sid + suf)) map.setLayoutProperty(sid + suf, "visibility", vis);
  });
}
