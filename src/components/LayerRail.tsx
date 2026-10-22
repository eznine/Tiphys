import type { DataLayer } from "../lib/dataLayers";

type Props = { layers: DataLayer[]; onToggle: (id: string) => void };

/** Layer list: basemap + agent/engine result layers. */
export function LayerRail({ layers, onToggle }: Props) {
  return (
    <nav className="layer-rail" aria-label="Layers">
      <div className="layer-rail-title">Layers</div>
      <div className="layer-row" title="Basemap">
        <span className="layer-swatch" data-kind="base" /> Basemap
      </div>
      {layers.map((l) => (
        <label key={l.id} className="layer-row" title={`${l.id} · ${l.crs ?? ""}`}>
          <input type="checkbox" checked={l.visible !== false} onChange={() => onToggle(l.id)} />
          <span className="layer-name">{l.name}</span>
          <span className="layer-meta">{l.feature_count}</span>
        </label>
      ))}
    </nav>
  );
}
