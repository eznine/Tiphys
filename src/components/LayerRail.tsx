import { useEffect, useRef, useState } from "react";
import { defaultLayerStyle, type DataLayer } from "../lib/dataLayers";
import { layerExportUnavailableReason, layerReloadUnavailableReason, layerSourcePath } from "../lib/layer-actions";
import { ChevronDown, ChevronRight, Search, Map, FolderPlus, Layers } from "lucide-react";

type Props = {
  layers: DataLayer[]; onToggle: (id: string) => void; onAdd: () => void; importing: boolean;
  onZoom: (layer: DataLayer) => void; onTable: (id: string) => void;
  onProperties: (id: string, tab: "style" | "labels" | "info") => void;
  onReload?: (layer: DataLayer) => void; onExport?: (layer: DataLayer) => void;
  onRename: (id: string, name: string) => void; onReorder: (ids: string[]) => void;
  onRemove: (layer: DataLayer) => void;
  selectedId?: string; onSelect: (id: string) => void;
};

/** Layer list: basemap + agent/engine result layers. */
export function LayerRail({ layers, onToggle, onAdd, importing, onZoom, onTable, onProperties, onReload, onExport, onRename, onReorder, onRemove, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ layer: DataLayer; x: number; y: number } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", escape); };
  }, [menu]);
  const openMenu = (layer: DataLayer, x: number, y: number) => { setConfirmRemove(false); setMenu({ layer, x: Math.max(8, Math.min(x, window.innerWidth - 208)), y: Math.max(8, Math.min(y, window.innerHeight - 390)) }); };
  const action = (fn: (layer: DataLayer) => void) => { if (menu) fn(menu.layer); setMenu(null); };
  const startRename = (layer: DataLayer) => { setEditing({ id: layer.id, draft: layer.name }); setMenu(null); };
  const commitRename = () => {
    if (editing) {
      const next = editing.draft.trim();
      const current = layers.find(l => l.id === editing.id);
      if (next && current && next !== current.name) onRename(editing.id, next);
    }
    setEditing(null);
  };
  // Dragging is disabled while searching: rows shown are a filtered subset and
  // a drop would otherwise produce an ambiguous target order.
  const dropBefore = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); setDropTarget(null); return; }
    const ids = layers.map(l => l.id);
    ids.splice(ids.indexOf(dragId), 1);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    onReorder(ids);
    setDragId(null); setDropTarget(null);
  };
  const commit = (fn: () => void) => { fn(); setMenu(null); };
  const reloadReason = menu ? layerReloadUnavailableReason(menu.layer, !!onReload) : "";
  const exportReason = menu ? layerExportUnavailableReason(menu.layer, !!onExport) : "";
  return (
    <nav className="layer-rail" aria-label="Layers">
      <div className="layer-rail-header"><strong>内容</strong><span>{layers.length} 个图层</span></div>
      <label className="contents-search"><Search size={14} /><input type="search" aria-label="搜索图层" placeholder="搜索图层" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="contents-toolbar"><span><Layers size={15} />绘制顺序</span><button type="button" className="plain-icon" aria-label="添加数据" title="添加数据" disabled={importing} onClick={onAdd}><FolderPlus size={17} /></button></div>
      <div className="contents-map"><ChevronDown size={14} /><Map size={16} /><strong>地图</strong></div>
      <div className="contents-tree">
      {layers.filter(l => l.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((l) => {
        const style = l.style ?? defaultLayerStyle(l.id);
        const geometryLabels: Record<string, string> = { Point: "点", MultiPoint: "多点", LineString: "线", MultiLineString: "多线", Polygon: "面", MultiPolygon: "多面" };
        const legend = l.kind === "raster" ? [{ text: `栅格 · ${l.raster?.width}×${l.raster?.height} · ${l.raster?.bands} 波段`, color: "#64748b" }]
          : l.kind === "table" ? [{ text: `表格 · ${l.feature_count} 行`, color: "#64748b" }]
          : style.categoryField && style.categories?.length ? style.categories.map(c => ({ text: String(c.value ?? "空值"), color: c.color })) : [{ text: l.geometry_types.map(t => geometryLabels[t] ?? t).join("、") || "要素", color: style.color }];
        return <div key={l.id} className="contents-layer" data-selected={l.id === selectedId} data-drop={dropTarget === l.id}
          draggable={!search && editing?.id !== l.id}
          onDragStart={() => setDragId(l.id)} onDragEnd={() => { setDragId(null); setDropTarget(null); }}
          onDragOver={e => { if (dragId && dragId !== l.id) { e.preventDefault(); setDropTarget(l.id); } }}
          onDragLeave={() => setDropTarget(cur => cur === l.id ? null : cur)}
          onDrop={e => { e.preventDefault(); dropBefore(l.id); }}
          onContextMenu={e => { e.preventDefault(); onSelect(l.id); openMenu(l, e.clientX, e.clientY); }}>
        <div className="layer-row">
          <button type="button" className="plain-icon legend-toggle" aria-label={`${collapsed[l.id] ? "展开" : "折叠"} ${l.name} 图例`} onClick={() => setCollapsed(c => ({ ...c, [l.id]: !c[l.id] }))}>{collapsed[l.id] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
          <input type="checkbox" aria-label={`显示 ${l.name}`} checked={l.visible !== false} onChange={() => onToggle(l.id)} />
          <button type="button" className="layer-symbol-btn" aria-label={`${l.name} 符号化`} onClick={() => onProperties(l.id, "style")}>
            <span className="layer-swatch" style={{ background: (l.style ?? defaultLayerStyle(l.id)).color }} /></button>
          {editing?.id === l.id ? <input ref={editRef} autoFocus className="layer-rename-input" aria-label="编辑图层名称" value={editing.draft}
              onChange={e => setEditing({ id: l.id, draft: e.target.value })}
              onBlur={commitRename} onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setEditing(null); }} />
            : <button type="button" className="layer-name" title={`${l.name} · ${l.feature_count} 个要素 · ${l.crs ?? ""}`} onDoubleClick={() => onProperties(l.id, "info")} onClick={() => onSelect(l.id)}>{l.name}</button>}
          <span className="layer-meta">{l.kind === "raster" ? "栅格" : l.kind === "table" ? "表格" : l.feature_count}</span>
          <button type="button" className="layer-more" aria-label={`${l.name} 操作`} onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); openMenu(l, rect.right, rect.top); }}>⋯</button>
        </div>
        {!collapsed[l.id] && <div className="contents-legend">{style.categoryField && <strong>{style.categoryField}</strong>}{legend.map((item, index) => <button type="button" key={index} onClick={() => onProperties(l.id, "style")}><span className="legend-symbol" data-geometry={l.geometry_types.some(t => t.includes("Polygon")) ? "polygon" : l.geometry_types.some(t => t.includes("Line")) ? "line" : "point"} style={{ background: item.color, borderColor: item.color }} /><span>{item.text}</span></button>)}{style.labelField && <span className="legend-label">标注 · {style.labelField}</span>}</div>}
        </div>;
      })}
      </div>
      {search && !layers.some(l => l.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="layer-empty">没有匹配的图层</p>}
      <div className="contents-base"><Map size={14} />底图<span>在地图中切换</span></div>
      {!layers.length && <p className="layer-empty">添加数据后，直接在右侧描述你要做的分析。</p>}
      {menu && <div ref={menuRef} className="layer-context-menu" role="menu" aria-label={`${menu.layer.name} 图层操作`} style={{ left: menu.x, top: menu.y }}>
        <div className="layer-menu-title">{menu.layer.name}</div>
        <button type="button" role="menuitem" disabled={!menu.layer.bounds} onClick={() => action(onZoom)}>缩放至图层</button>
        <button type="button" role="menuitem" onClick={() => action(l => onTable(l.id))}>打开属性表</button>
        <button type="button" role="menuitem" onClick={() => action(l => onProperties(l.id, "style"))}>符号化</button>
        <button type="button" role="menuitem" onClick={() => action(l => onProperties(l.id, "labels"))}>标注</button>
        <button type="button" role="menuitem" onClick={() => action(l => onProperties(l.id, "info"))}>元数据 / 图层属性</button>
        <button type="button" role="menuitem" disabled={!!reloadReason} title={reloadReason || layerSourcePath(menu.layer) || undefined}
          onClick={() => action(l => onReload?.(l))}>从源重新加载</button>
        <button type="button" role="menuitem" disabled={!!exportReason} title={exportReason || undefined}
          onClick={() => action(l => onExport?.(l))}>{menu.layer.kind === "raster" ? "下载工作副本 GeoTIFF" : "导出 / 另存为 GeoJSON"}</button>
        <button type="button" role="menuitem" onClick={() => commit(() => startRename(menu.layer))}>重命名</button>
        <div className="layer-menu-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => action(l => onToggle(l.id))}>{menu.layer.visible === false ? "显示图层" : "隐藏图层"}</button>
        <button type="button" role="menuitem" className={confirmRemove ? "layer-menu-danger active" : "layer-menu-danger"}
          title="从工作区删除此图层及其工作副本；原始数据文件不受影响"
          onClick={() => {
            if (!confirmRemove) { setConfirmRemove(true); return; }
            onRemove(menu.layer);
            setMenu(null);
          }}>
          {confirmRemove ? `确认删除“${menu.layer.name}”` : "删除图层"}
        </button>
        {confirmRemove && <p className="layer-menu-note">将移除工作副本；原始输入文件不受影响。</p>}
      </div>}
    </nav>
  );
}
