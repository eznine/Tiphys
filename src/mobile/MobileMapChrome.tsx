import { Layers, Wrench } from "lucide-react";

type Props = {
  projectName: string;
  engineState: "ok" | "error" | "pending";
  layerCount: number;
  onProject: () => void;
  onLayers: () => void;
  onTools: () => void;
};

/** Floating brand/project capsule and the two map entries (layers, toolbox). */
export function MobileMapChrome({ projectName, engineState, layerCount, onProject, onLayers, onTools }: Props) {
  return <div className="m-map-chrome">
    <button type="button" className="m-brand" onClick={onProject} aria-label={`当前工程 ${projectName}，打开工程页`}>
      <span className="m-brand-mark"><img src="/brand/logo-badge.svg" alt="" aria-hidden="true" /></span>
      <span className="m-brand-text">
        <span className="m-brand-wordmark" role="img" aria-label="TIPHYS" />
        <small><span className="m-status-dot" data-state={engineState} />{projectName}</small>
      </span>
    </button>
    <div className="m-map-chrome-actions">
      <button type="button" className="m-glass-round" aria-label={`图层，${layerCount} 个`} onClick={onLayers}>
        <Layers size={19} strokeWidth={1.8} />
        {layerCount > 0 && <span className="m-round-count">{layerCount > 99 ? "99+" : layerCount}</span>}
      </button>
      <button type="button" className="m-glass-round" aria-label="打开 GIS 工具箱" onClick={onTools}>
        <Wrench size={19} strokeWidth={1.8} />
      </button>
    </div>
  </div>;
}
