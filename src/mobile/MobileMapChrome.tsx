import { Layers, Wrench } from "lucide-react";
import { MobileTopCapsule } from "./MobileTopCapsule";

type Props = {
  projectName: string;
  engineState: "ok" | "error" | "pending";
  layerCount: number;
  onProject: () => void;
  onLayers: () => void;
  onTools: () => void;
};

/** Map top chrome: shared project capsule + layers / toolbox glass circles. */
export function MobileMapChrome({ projectName, engineState, layerCount, onProject, onLayers, onTools }: Props) {
  return (
    <MobileTopCapsule
      className="m-map-chrome"
      projectName={projectName}
      onProject={onProject}
      status={engineState}
      left={
        <button type="button" className="m-glass-round" aria-label={`图层，${layerCount} 个`} onClick={onLayers}>
          <Layers size={18} strokeWidth={1.8} />
          {layerCount > 0 && <span className="m-round-count">{layerCount > 99 ? "99+" : layerCount}</span>}
        </button>
      }
      right={
        <button type="button" className="m-glass-round" aria-label="打开 GIS 工具箱" onClick={onTools}>
          <Wrench size={18} strokeWidth={1.8} />
        </button>
      }
    />
  );
}
