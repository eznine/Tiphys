import { useState } from "react";
import { ChevronDown, ChevronUp, ListFilter } from "lucide-react";
import { defaultLayerStyle, type DataLayer } from "../lib/dataLayers";

const GEOMETRY_ZH: Record<string, string> = {
  Point: "点", MultiPoint: "多点", LineString: "线", MultiLineString: "多线", Polygon: "面", MultiPolygon: "多面",
};

function shape(layer: DataLayer): "point" | "line" | "polygon" {
  if (layer.geometry_types.some(type => type.includes("Polygon"))) return "polygon";
  if (layer.geometry_types.some(type => type.includes("Line"))) return "line";
  return "point";
}

export function MapLegend({ layers, onStyle }: { layers: DataLayer[]; onStyle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const visible = layers.filter(layer => layer.visible !== false && layer.kind !== "table");
  if (!visible.length) return null;
  return <section className="map-legend-dock" aria-label="地图图例">
    <button type="button" className="map-legend-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ListFilter size={13} /><span>图例</span><b>{visible.length}</b>{open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
    </button>
    {open && <div className="map-legend-body">
      {visible.slice(0, 8).map(layer => {
        const style = layer.style ?? defaultLayerStyle(layer.id, layer.name);
        const geometry = shape(layer);
        const categories = style.categoryField && style.categories?.length ? style.categories : null;
        return <button key={layer.id} type="button" className="map-legend-row" title="打开图层符号化" onClick={() => onStyle(layer.id)}>
          <span className="map-legend-symbol" data-geometry={geometry} style={{ background: style.color, borderColor: style.strokeColor ?? style.color }} />
          <span className="map-legend-copy"><strong>{layer.name}</strong><small>{layer.kind === "raster"
            ? `栅格 · ${style.rasterStretch === "high" ? "强对比" : style.rasterStretch === "soft" ? "柔和拉伸" : "自动拉伸"}`
            : categories ? `${style.categoryField} · ${categories.length} 类` : layer.geometry_types.map(type => GEOMETRY_ZH[type] ?? type).join("、") || "要素"}</small></span>
          {categories && <span className="map-legend-ramp">{categories.slice(0, 5).map((item, index) => <i key={index} style={{ background: item.color }} />)}</span>}
        </button>;
      })}
      {visible.length > 8 && <small className="map-legend-more">另有 {visible.length - 8} 个可见图层，请在内容列表查看。</small>}
    </div>}
  </section>;
}
