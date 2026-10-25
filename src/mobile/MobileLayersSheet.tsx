import { useEffect, useRef, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { defaultLayerStyle } from "../lib/dataLayers";
import { layerExportUnavailableReason, layerReloadUnavailableReason, layerSourcePath } from "../lib/layer-actions";
import { MobileSheet } from "./MobileSheet";
import {
  Download, Eye, EyeOff, Filter, GripVertical, Info, Layers, MapPin, Maximize2, Palette,
  Pencil, Plus, RefreshCw, Search, Table2, Tags, Trash2, Wrench,
} from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  layers: DataLayer[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onAdd: () => void;
  importing: boolean;
  importNotice?: string;
  onDismissNotice?: () => void;
  onZoom: (layer: DataLayer) => void;
  onTable: (id: string) => void;
  onProperties: (id: string, tab: "style" | "labels" | "info") => void;
  onRename: (id: string, name: string) => void;
  onReorder: (ids: string[]) => void;
  onRemove: (layer: DataLayer) => void;
  onReload: (layer: DataLayer) => void;
  onExport: (layer: DataLayer) => void;
  onOpenTool: (tool: string, layerId?: string) => void;
  onActionLevel?: (open: boolean) => void;
  /** Increment to close the nested layer-actions sheet (system Back). */
  actionBackToken?: number;
};

const KIND_LABEL: Record<string, string> = { vector: "矢量", raster: "栅格", table: "表格" };

function layerSummary(layer: DataLayer) {
  const kind = KIND_LABEL[layer.kind ?? "vector"] ?? "矢量";
  if (layer.kind === "raster") return `${kind} · ${layer.raster?.width ?? "?"}×${layer.raster?.height ?? "?"} · ${layer.raster?.bands ?? "?"} 波段`;
  if (layer.kind === "table") return `${kind} · ${layer.feature_count} 行`;
  return `${kind} · ${layer.feature_count} 个要素${layer.crs ? ` · ${layer.crs}` : ""}`;
}

export function MobileLayersSheet(props: Props) {
  const { open, onClose, layers, selectedId, onSelect, onToggle, onAdd, importing, importNotice, onDismissNotice,
    onZoom, onTable, onProperties, onRename, onReorder, onRemove, onReload, onExport, onOpenTool, onActionLevel, actionBackToken = 0 } = props;
  const [search, setSearch] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string } | null>(null);
  const overRef = useRef<string | null>(null);

  const actionLayer = layers.find(layer => layer.id === actionId) ?? null;
  const reloadReason = actionLayer ? layerReloadUnavailableReason(actionLayer, true) : "";
  const exportReason = actionLayer ? layerExportUnavailableReason(actionLayer, true) : "";
  const selected = layers.find(layer => layer.id === selectedId) ?? layers[0] ?? null;

  useEffect(() => { onActionLevel?.(!!actionId); }, [actionId, onActionLevel]);

  useEffect(() => {
    if (!actionBackToken) return;
    setActionId(null);
    setRenaming(false);
    setConfirmRemove(false);
  }, [actionBackToken]);
  const filtered = layers.filter(layer => layer.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  const openActions = (layer: DataLayer) => {
    onSelect(layer.id);
    setActionId(layer.id);
    setRenaming(false);
    setConfirmRemove(false);
    setDraftName(layer.name);
  };

  const closeActions = () => {
    setActionId(null);
    setRenaming(false);
    setConfirmRemove(false);
  };

  const act = (fn: (layer: DataLayer) => void) => {
    if (actionLayer) fn(actionLayer);
    closeActions();
  };

  const startDrag = (event: React.PointerEvent, layer: DataLayer) => {
    if (search.trim()) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: layer.id };
    overRef.current = null;
    setDragId(layer.id);
    setOverId(null);
  };

  const moveDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-layer-id]");
    const target = element?.dataset.layerId ?? null;
    if (target && target !== dragRef.current.id && target !== overRef.current) {
      overRef.current = target;
      setOverId(target);
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const target = overRef.current;
    dragRef.current = null;
    overRef.current = null;
    setDragId(null);
    setOverId(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (!drag || !target || target === drag.id) return;
    const ids = layers.map(layer => layer.id);
    ids.splice(ids.indexOf(drag.id), 1);
    ids.splice(ids.indexOf(target), 0, drag.id);
    onReorder(ids);
  };

  const commitRename = () => {
    if (actionLayer && draftName.trim() && draftName.trim() !== actionLayer.name) onRename(actionLayer.id, draftName.trim());
    setRenaming(false);
    closeActions();
  };

  return <>
    <MobileSheet open={open} title="图层" initialSnap={1} onClose={onClose}
      subtitle={<>{layers.length} 个图层{selected ? ` · 当前 ${selected.name}` : ""}</>}>
      {selected && <div className="m-layer-current">
        <div className="m-layer-current-head">
          <span className="m-layer-swatch" style={{ background: (selected.style ?? defaultLayerStyle(selected.id, selected.name)).color }} />
          <div><strong>{selected.name}</strong><small>{layerSummary(selected)}</small></div>
        </div>
        <div className="m-layer-current-actions">
          <button type="button" disabled={!selected.bounds} onClick={() => onZoom(selected)}><Maximize2 size={15} />缩放</button>
          {selected.kind !== "raster" && <button type="button" onClick={() => onTable(selected.id)}><Table2 size={15} />属性表</button>}
          <button type="button" onClick={() => onProperties(selected.id, "style")}><Palette size={15} />符号</button>
          <button type="button" onClick={() => openActions(selected)}><Wrench size={15} />更多</button>
        </div>
      </div>}

      <label className="m-search">
        <Search size={16} />
        <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索图层" aria-label="搜索图层" />
      </label>

      {(importing || importNotice) && <div className="m-inline-notice" role="status">
        <span>{importing ? "正在导入数据…" : importNotice}</span>
        {!importing && onDismissNotice && <button type="button" aria-label="关闭提示" onClick={onDismissNotice}>×</button>}
      </div>}

      <div className="m-layer-list" data-dragging={!!dragId}>
        {filtered.map(layer => {
          const style = layer.style ?? defaultLayerStyle(layer.id, layer.name);
          return <div key={layer.id} className="m-layer-row" data-layer-id={layer.id}
            data-selected={layer.id === selected?.id} data-hidden={layer.visible === false}
            data-dragging={layer.id === dragId} data-drop={layer.id === overId}>
            <button type="button" className="m-layer-grip" aria-label={`拖动 ${layer.name} 排序`}
              disabled={!!search}
              onPointerDown={event => startDrag(event, layer)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
              <GripVertical size={16} />
            </button>
            <button type="button" className="m-layer-eye" aria-label={`${layer.visible === false ? "显示" : "隐藏"} ${layer.name}`} aria-pressed={layer.visible !== false}
              onClick={() => onToggle(layer.id)}>
              {layer.visible === false ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
            <button type="button" className="m-layer-symbol" aria-label={`${layer.name} 符号化`} onClick={() => onProperties(layer.id, "style")}>
              <span style={{ background: style.color }} />
            </button>
            <button type="button" className="m-layer-main" onClick={() => onSelect(layer.id)}>
              <strong>{layer.name}</strong>
              <small>{layerSummary(layer)}</small>
            </button>
            <button type="button" className="m-layer-more" aria-label={`${layer.name} 更多操作`} onClick={() => openActions(layer)}>···</button>
          </div>;
        })}
        {!filtered.length && <div className="m-empty-inline">
          <Layers size={18} />
          <strong>{layers.length ? "没有匹配的图层" : "还没有图层"}</strong>
          <span>{layers.length ? "换个关键词试试。" : "添加 GeoJSON、GeoPackage、GeoTIFF 或表格开始分析。"}</span>
          {!layers.length && <button type="button" className="m-btn m-btn-primary" onClick={onAdd}><Plus size={15} />添加数据</button>}
        </div>}
      </div>

      <button type="button" className="m-add-row" onClick={onAdd} disabled={importing}>
        <Plus size={16} />{importing ? "正在导入…" : "添加数据"}
      </button>
      <p className="m-sheet-hint">拖动左侧把手可调整绘制顺序；列表顺序与地图渲染一致。搜索时暂停拖动，避免歧义。</p>
    </MobileSheet>

    <MobileSheet open={!!actionLayer} title={actionLayer?.name ?? "图层操作"}
      subtitle={actionLayer ? layerSummary(actionLayer) : undefined}
      initialSnap={0} snapPoints={[0.58, 0.92]} level={1}
      onBack={closeActions} onClose={closeActions}>
      {actionLayer && <div className="m-action-list">
        {actionLayer.kind !== "table" && <button type="button" disabled={!actionLayer.bounds} onClick={() => act(layer => onZoom(layer))}><Maximize2 size={18} /><span>缩放至图层</span><small>定位到真实范围</small></button>}
        {actionLayer.kind !== "raster" && <button type="button" onClick={() => act(layer => onTable(layer.id))}><Table2 size={18} /><span>打开属性表</span><small>查看与选择要素</small></button>}
        <button type="button" onClick={() => act(layer => onProperties(layer.id, "style"))}><Palette size={18} /><span>符号化与透明度</span><small>颜色、点大小、线宽、拉伸</small></button>
        {actionLayer.kind !== "raster" && <button type="button" onClick={() => act(layer => onProperties(layer.id, "labels"))}><Tags size={18} /><span>标注</span><small>按字段显示地图标注</small></button>}
        {actionLayer.kind !== "raster" && <button type="button" onClick={() => act(layer => onOpenTool("select_by_attributes", layer.id))}><Filter size={18} /><span>按属性筛选</span><small>生成匹配要素的新图层</small></button>}
        {actionLayer.kind !== "raster" && <button type="button" onClick={() => act(layer => onOpenTool("select_by_location", layer.id))}><MapPin size={18} /><span>按位置筛选</span><small>按空间关系选择要素</small></button>}
        <button type="button" onClick={() => act(layer => onProperties(layer.id, "info"))}><Info size={18} /><span>图层信息</span><small>坐标系、范围、数据来源</small></button>
        <button type="button" disabled={!!reloadReason} title={reloadReason || layerSourcePath(actionLayer) || undefined} onClick={() => act(layer => onReload(layer))}><RefreshCw size={18} /><span>从源重新加载</span><small>{reloadReason || "重新读取原始文件并保留图层位置"}</small></button>
        <button type="button" disabled={!!exportReason} title={exportReason || undefined} onClick={() => act(layer => onExport(layer))}><Download size={18} /><span>{actionLayer.kind === "raster" ? "下载工作副本" : "导出 / 另存为"}</span><small>{exportReason || (actionLayer.kind === "raster" ? "GeoTIFF 工作副本" : "GeoJSON（WGS 84）")}</small></button>
        <button type="button" onClick={() => act(layer => onOpenTool("", layer.id))}><Wrench size={18} /><span>用 GIS 工具分析</span><small>打开工具箱并带入该图层</small></button>
        <button type="button" onClick={() => { setRenaming(true); setDraftName(actionLayer.name); }}><Pencil size={18} /><span>重命名</span><small>只改显示名称，不动数据</small></button>

        {renaming && <div className="m-inline-form">
          <label>图层名称<input value={draftName} autoFocus onChange={event => setDraftName(event.target.value)} /></label>
          <div><button type="button" className="m-btn" onClick={() => setRenaming(false)}>取消</button><button type="button" className="m-btn m-btn-primary" onClick={commitRename}>保存</button></div>
        </div>}

        <div className="m-action-danger">
          {confirmRemove
            ? <button type="button" className="danger" onClick={() => act(layer => onRemove(layer))}><Trash2 size={18} /><span>确认移除</span><small>将「{actionLayer.name}」从工作区移除，原始文件不受影响</small></button>
            : <button type="button" onClick={() => setConfirmRemove(true)}><Trash2 size={18} /><span>从工作区移除</span><small>不删除原始文件</small></button>}
        </div>
      </div>}
    </MobileSheet>
  </>;
}
