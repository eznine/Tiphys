import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { ChatDock } from "./components/ChatDock";
import { MapCanvas } from "./components/MapCanvas";
import { LayerRail } from "./components/LayerRail";
import { pingEngine, PingResult } from "./lib/engine";
import { Map as MapIcon, Layers, Crosshair, X, FolderPlus, Wrench, MessageSquareText, Table2, Shapes, Tags, Scan, Focus, Logs, Settings2, Scissors, type LucideIcon } from "lucide-react";
import { SettingsDialog, type ThemeMode } from "./components/SettingsDialog";
import { CommandRibbon } from "./components/CommandRibbon";
import { useAgent, type TimelineItem } from "./lib/agent";
import { defaultLayerStyle, type DataLayer, type LayerSelection, type LayerStyle } from "./lib/dataLayers";
import { engineRequest } from "./lib/service";
import { AttributeTable } from "./components/AttributeTable";
import { LayerProperties } from "./components/LayerProperties";
import { MapLegend } from "./components/MapLegend";
import { LogPanel } from "./components/LogPanel";
import { BottomSheet } from "./components/BottomSheet";
import { MobileComposer } from "./components/MobileComposer";
import { ChatTimeline, SUGGESTIONS } from "./components/ChatTimeline";
import { ToolPanel } from "./components/ToolPanel";
import { useMediaQuery } from "./lib/useMediaQuery";
import { browserRuntime } from "./lib/runtime";
import { warmWasmToolRunner } from "./lib/browser/wasm-tool-runner";
import { scheduleIdle } from "./lib/idle";
import { isShapefilePart } from "./lib/shapefile";
import { buildAgentSessionStub, buildWorkspaceSnapshot, loadWorkspaceSnapshot, saveWorkspaceSnapshot, type WorkspaceRecovery } from "./lib/workspace";
import beijingPointsSample from "../samples/beijing_points.geojson?raw";
import "./styles/app.css";
import "./styles/mobile.css";

function loadTheme(): ThemeMode {
  const saved = localStorage.getItem("tiphys-theme");
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "light";
}

function loadLayerStyles(): Record<string, LayerStyle> {
  try { return JSON.parse(localStorage.getItem("tiphys-layer-styles") ?? "{}"); }
  catch { return {}; }
}

function loadAppliedViews(): Set<string | number> {
  try { return new Set(JSON.parse(localStorage.getItem("tiphys-applied-view-commands") ?? "[]")); }
  catch { return new Set(); }
}

function sessionStubFromItems(items: TimelineItem[]) {
  const goals = items.flatMap(item => item.kind === "msg" && item.role === "user" ? [item.text] : []);
  const tools = items.flatMap(item => item.kind === "tool" ? [item.name] : []);
  return buildAgentSessionStub(goals, tools);
}

export default function App() {
  const [restoredWorkspace] = useState(loadWorkspaceSnapshot);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadTheme);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
  const [density, setDensity] = useState<"standard" | "compact">(() => localStorage.getItem("tiphys-density") === "compact" ? "compact" : "standard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(restoredWorkspace?.selectedLayerId ?? null);
  const [dockRequest, setDockRequest] = useState<{ id: number; tool?: string; tab: "chat" | "tools"; search?: string }>();
  const [mapStatus, setMapStatus] = useState({ lng: 20, lat: 20, zoom: 1.6 });
  const [ping, setPing] = useState<PingResult>({ state: "pending" });
  const agent = useAgent("default");
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [mobileSheet, setMobileSheet] = useState<"actions" | "chat" | "layers" | "tools" | "table" | "logs" | "properties" | null>(null);
  const [mobileDraft, setMobileDraft] = useState("");
  const [styles, setStyles] = useState(loadLayerStyles);
  const [focus, setFocus] = useState<number[] | null>(null);
  const [tableId, setTableId] = useState<string | null>(restoredWorkspace?.tableLayerId ?? null);
  const [selection, setSelection] = useState<LayerSelection | null>(restoredWorkspace?.selection ?? null);
  const [aoi, setAoi] = useState<number[] | null>(restoredWorkspace?.aoi ?? null);
  const [properties, setProperties] = useState<{ id: string; tab: "style" | "labels" | "info" } | null>(null);
  const [importing, setImporting] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const [sourceCrs, setSourceCrs] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const appliedViews = useRef(loadAppliedViews());
  const restoredVisibility = useRef(false);
  const layers = useMemo(() => agent.state.layers.map(l => ({ ...l, style: { ...defaultLayerStyle(l.id, l.name), ...styles[l.id] } })), [agent.state.layers, styles]);
  const tableLayer = layers.find(l => l.id === tableId);
  const propertyLayer = layers.find(l => l.id === properties?.id);
  const activeLayer = layers.find(l => l.id === selectedId) ?? layers[0];
  const selectionLayer = layers.find(l => l.id === selection?.layerId);
  const agentSession = useMemo(() => sessionStubFromItems(agent.state.items) ?? restoredWorkspace?.agent, [agent.state.items, restoredWorkspace]);
  const recoveredLayerCount = useMemo(() => {
    if (!restoredWorkspace) return 0;
    const live = new Set(agent.state.layers.map(layer => layer.id));
    return restoredWorkspace.layers.filter(layer => live.has(layer.id)).length;
  }, [agent.state.layers, restoredWorkspace]);
  const recoveryNote = useMemo<WorkspaceRecovery | null>(() => {
    if (!restoredWorkspace || !agent.state.hydrated) return null;
    if (!restoredWorkspace.layers.length && !restoredWorkspace.aoi && !restoredWorkspace.selection && !restoredWorkspace.agent) return null;
    return {
      layerCount: recoveredLayerCount,
      selectedLayerName: agent.state.layers.find(layer => layer.id === restoredWorkspace.selectedLayerId)?.name ?? null,
      selectionCount: restoredWorkspace.selection?.featureIds.length ?? 0,
      hasAoi: Boolean(restoredWorkspace.aoi),
      transcriptAvailable: agent.state.items.length > 0,
      goals: restoredWorkspace.agent?.goals ?? [],
      tools: restoredWorkspace.agent?.tools ?? [],
    };
  }, [agent.state.hydrated, agent.state.items.length, agent.state.layers, recoveredLayerCount, restoredWorkspace]);
  const toggleTheme = () => setThemeMode(theme === "dark" ? "light" : "dark");
  const openDock = (tab: "chat" | "tools", tool?: string, search?: string) => setDockRequest({ id: Date.now(), tab, tool, search });
  const zoomAll = () => {
    const bounds = layers.map(l => l.bounds).filter((b): b is number[] => !!b);
    if (bounds.length) setFocus([Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])), Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3]))]);
    else setFocus([-160, -60, 160, 75]);
  };
  useEffect(() => scheduleIdle(() => {
    try { localStorage.setItem("tiphys-layer-styles", JSON.stringify(styles)); }
    catch { /* Storage can be full or disabled; map styling still works for this session. */ }
  }, { timeout: 1800, fallbackDelay: 180 }), [styles]);
  useEffect(() => {
    if (!agent.state.hydrated) return;
    const ids = new Set(layers.map(layer => layer.id));
    if (selection) {
      const selected = layers.find(layer => layer.id === selection.layerId);
      if (!selected) setSelection(null);
      else {
        const featureIds = selection.featureIds.filter(id => Number.isInteger(id) && id >= 0 && id < selected.feature_count);
        if (featureIds.length !== selection.featureIds.length) setSelection(featureIds.length ? { layerId: selected.id, featureIds } : null);
      }
    }
    if (tableId && !ids.has(tableId)) setTableId(null);
    if (!layers.length) { if (selectedId) setSelectedId(null); return; }
    if (selectedId && !ids.has(selectedId)) setSelectedId(layers[0].id);
  }, [agent.state.hydrated, layers, selection, tableId, selectedId]);
  useEffect(() => {
    if (!agent.state.hydrated || restoredVisibility.current) return;
    restoredVisibility.current = true;
    const saved = restoredWorkspace?.layers ?? [];
    for (const layer of saved) if (layer.visible === false) agent.setLayerVisibility(layer.id, false);
  }, [agent, restoredWorkspace, agent.state.hydrated]);
  useEffect(() => {
    if (!agent.state.hydrated) return;
    const timer = window.setTimeout(() => {
      saveWorkspaceSnapshot(buildWorkspaceSnapshot(layers, { selectedLayerId: selectedId, aoi, selection, tableLayerId: tableId, agent: agentSession }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [agent.state.hydrated, layers, selectedId, aoi, selection, tableId, agentSession]);
  useEffect(() => { if (agent.state.focus) setFocus([...agent.state.focus]); }, [agent.state.focus]);
  useEffect(() => {
    let changed = false;
    for (const command of agent.state.viewCommands ?? []) {
      if (appliedViews.current.has(command.id)) continue;
      appliedViews.current.add(command.id);
      changed = true;
      if (command.action === "zoom" && command.bounds) setFocus([...command.bounds]);
      if (command.action === "attributes") { setTableId(command.layer_id); setLogsOpen(false); }
      if (command.style) setStyles(current => ({ ...current,
        [command.layer_id]: { ...defaultLayerStyle(command.layer_id), ...current[command.layer_id], ...command.style },
      }));
    }
    // Replaying historical Agent commands must not undo later manual styling.
    if (changed) localStorage.setItem("tiphys-applied-view-commands", JSON.stringify([...appliedViews.current].slice(-1000)));
  }, [agent.state.viewCommands]);
  const zoomLayer = useCallback((layer: DataLayer) => { if (layer.bounds) setFocus([...layer.bounds]); }, []);
  const clearSelection = useCallback(() => setSelection(null), []);
  const handleMapSelection = useCallback((next: LayerSelection | null, additive: boolean) => {
    if (!next) { if (!additive) setSelection(null); return; }
    setSelectedId(next.layerId);
    setTableId(current => current ? next.layerId : current);
    setSelection(current => {
      if (!additive || current?.layerId !== next.layerId) return next.featureIds.length ? next : null;
      const ids = new Set(current.featureIds);
      for (const id of next.featureIds) { if (ids.has(id)) ids.delete(id); else ids.add(id); }
      return ids.size ? { layerId: next.layerId, featureIds: [...ids].sort((a, b) => a - b) } : null;
    });
  }, []);
  const importFiles = async (files: FileList | File[]) => {
    setImporting(true); setImportNotice("");
    let loaded = 0;
    try {
      const selected = Array.from(files);
      const shapefileFiles = selected.filter(file => isShapefilePart(file.name));
      if (shapefileFiles.length) {
        const query = new URLSearchParams();
        if (sourceCrs) query.set("source_crs", sourceCrs);
        const form = new FormData();
        for (const file of shapefileFiles) form.append(`file:${file.name}`, file, file.name);
        const result = await (await engineRequest(`/layers/import-shapefile?${query}`, { method: "POST", body: form })).json();
        agent.mergeToolResult(result);
        loaded += Array.isArray(result.layers) ? result.layers.length : 1;
      }
      for (const file of selected.filter(file => !isShapefilePart(file.name))) {
        const query = new URLSearchParams({ filename: file.name });
        if (sourceCrs) query.set("source_crs", sourceCrs);
        const result = await (await engineRequest(`/layers/import?${query}`, { method: "POST", body: file })).json();
        agent.mergeToolResult(result); loaded++;
      }
      setImportNotice(`已添加 ${loaded} 个图层，可在右侧直接描述分析任务。`);
    } catch (err) { setImportNotice(`已添加 ${loaded} 个图层；加载失败：${err}`); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const runWorkspaceTool = async (name: string, args: Record<string, unknown>) => {
    const result = await (await engineRequest("/tools/run", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }) })).json();
    agent.mergeToolResult(result);
    return result;
  };
  const clipToAoi = async () => {
    if (!aoi || !activeLayer) return;
    setImportNotice("");
    try {
      const result = await runWorkspaceTool("clip_layers_to_aoi", {
        layer: activeLayer.id,
        aoi_west: aoi[0], aoi_south: aoi[1], aoi_east: aoi[2], aoi_north: aoi[3],
        output_name: `${activeLayer.name}_AOI裁剪`,
      });
      const clipped = result.layer ?? result.layers?.at(-1)?.layer;
      setImportNotice(`AOI 裁剪完成：${clipped?.name ?? "结果图层已添加"}`);
    } catch (err) { setImportNotice(`AOI 裁剪失败：${err}`); }
  };
  const handleRename = (id: string, name: string) => { void runWorkspaceTool("rename_layer", { layer: id, name }).catch(err => setImportNotice(`重命名失败：${err}`)); };
  const handleReorder = (ids: string[]) => { void runWorkspaceTool("reorder_layers", { layer_ids: ids }).catch(err => setImportNotice(`图层排序失败：${err}`)); };
  const handleRemoveLayer = (layer: DataLayer) => {
    setImportNotice("");
    void runWorkspaceTool("remove_layer", { layer: layer.id })
      .then(result => { setImportNotice(`已删除图层「${result?.name ?? layer.name}」，原始数据文件不受影响。`); })
      .catch(err => setImportNotice(`删除图层失败：${err}`));
  };
  const addData = async () => {
    if (!isTauri()) { fileRef.current?.click(); return; }
    setImporting(true); setImportNotice("");
    let loaded = 0;
    try {
      const paths = await invoke<string[]>("pick_vector_files");
      for (const path of paths) {
        const result = await (await engineRequest("/tools/run", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "add_data", arguments: { path, ...(sourceCrs ? { source_crs: sourceCrs } : {}) } }) })).json();
        agent.mergeToolResult(result); loaded++;
      }
      if (loaded) setImportNotice(`已添加 ${loaded} 个图层，可在右侧直接描述分析任务。`);
    } catch (err) { setImportNotice(`已添加 ${loaded} 个图层；加载失败：${err}`); }
    finally { setImporting(false); }
  };
  const loadSamplePoints = () => void importFiles([
    new File([beijingPointsSample], "beijing_points.geojson", { type: "application/geo+json" }),
  ]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("tiphys-theme", themeMode);
  }, [theme, themeMode]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const textInput = target instanceof HTMLInputElement && !["checkbox", "radio", "range", "color", "button", "submit", "reset", "file"].includes(target.type);
      if (event.key === "Escape" && !textInput && !target?.closest("textarea, select, [contenteditable='true']")) clearSelection();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [clearSelection]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { localStorage.setItem("tiphys-density", density); document.documentElement.dataset.density = density; }, [density]);

  useEffect(() => {
    const controller = new AbortController();
    const check = () => void pingEngine(undefined, controller.signal).then(result => { if (!controller.signal.aborted) setPing(result); });
    check();
    const timer = window.setInterval(check, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let done = false;
    let cancelIdle = () => {};
    const warm = () => {
      if (done) return;
      done = true;
      cancelIdle();
      window.removeEventListener("pointerdown", warm);
      window.removeEventListener("keydown", warm);
      void warmWasmToolRunner();
    };
    window.addEventListener("pointerdown", warm, { once: true, passive: true });
    window.addEventListener("keydown", warm, { once: true });
    // Also warm during an idle window so a user who pauses before interacting
    // does not pay the compile cost on their first tool run.
    cancelIdle = scheduleIdle(warm, { timeout: 3500, fallbackDelay: 1800 });
    return () => {
      done = true;
      cancelIdle();
      window.removeEventListener("pointerdown", warm);
      window.removeEventListener("keydown", warm);
    };
  }, []);

  const engineLabel = useMemo(() => {
    if (ping.state === "ok") return browserRuntime ? "Browser-WASM" : `Python · ${ping.latencyMs}ms`;
    if (ping.state === "error") return "未连接";
    return "…";
  }, [ping]);
  const engineState = ping.state === "ok" ? "ok" : ping.state === "error" ? "error" : "pending";

  const lastAgentMessage = useMemo(() => {
    for (let i = agent.state.items.length - 1; i >= 0; i--) {
      const item = agent.state.items[i];
      if (item.kind === "msg" && item.role === "agent") return item.text.replace(/\s+/g, " ");
    }
    return null;
  }, [agent.state.items]);
  const agentUnconfigured = agent.state.provider.startsWith("unconfigured");
  const agentProviderLabel = !agent.state.connected ? "Agent 连接中断，正在重连…"
    : agentUnconfigured ? "尚未配置 API"
    : `${agent.state.provider.startsWith("mock") ? "模拟测试 · " : ""}${agent.state.provider.includes(":") ? agent.state.provider.slice(agent.state.provider.indexOf(":") + 1) : agent.state.provider}`;
  const mobileSend = async (text: string) => {
    const ok = await agent.send(text, { aoi, selectedLayerId: activeLayer?.id ?? null, selectedLayerName: activeLayer?.name ?? null, selection, recovery: recoveryNote, agentSession });
    if (ok) setMobileSheet("chat");
    return ok;
  };
  // Auto-open the matching sheet when panels are requested while on mobile.
  const prevTableId = useRef(tableId);
  const prevProperties = useRef(properties);
  useEffect(() => {
    if (!isMobile) { prevTableId.current = tableId; return; }
    if (prevTableId.current !== tableId && tableId) setMobileSheet("table");
    prevTableId.current = tableId;
  }, [tableId, isMobile]);
  useEffect(() => {
    if (!isMobile) { prevProperties.current = properties; return; }
    if (prevProperties.current !== properties && properties) setMobileSheet("properties");
    prevProperties.current = properties;
  }, [properties, isMobile]);
  useEffect(() => {
    if (!isMobile || !dockRequest) return;
    setMobileSheet(dockRequest.tab === "tools" ? "tools" : "chat");
  }, [dockRequest, isMobile]);
  const mobileActions: { label: string; Icon: LucideIcon; run: () => void; disabled?: boolean }[] = [
    { label: "添加数据", Icon: FolderPlus, run: () => { setMobileSheet(null); void addData(); } },
    { label: "图层", Icon: Layers, run: () => setMobileSheet("layers") },
    { label: "工具箱", Icon: Wrench, run: () => setMobileSheet("tools") },
    { label: "对话", Icon: MessageSquareText, run: () => setMobileSheet("chat") },
    { label: "属性表", Icon: Table2, run: () => { setMobileSheet("table"); if (activeLayer) setTableId(activeLayer.id); }, disabled: !activeLayer },
    { label: "符号化", Icon: Shapes, run: () => { if (activeLayer) setProperties({ id: activeLayer.id, tab: "style" }); }, disabled: !activeLayer },
    { label: "标注", Icon: Tags, run: () => { if (activeLayer) setProperties({ id: activeLayer.id, tab: "labels" }); }, disabled: !activeLayer },
    { label: "全图", Icon: Scan, run: () => { setMobileSheet(null); zoomAll(); } },
    { label: "缩放图层", Icon: Focus, run: () => { setMobileSheet(null); if (activeLayer) zoomLayer(activeLayer); }, disabled: !activeLayer },
    { label: "AOI 裁剪", Icon: Scissors, run: () => { setMobileSheet(null); void clipToAoi(); }, disabled: !aoi || !activeLayer },
    { label: "日志", Icon: Logs, run: () => setMobileSheet("logs") },
    { label: "设置", Icon: Settings2, run: () => { setMobileSheet(null); setSettingsOpen(true); } },
  ];

  return (
    <div className={"app-shell" + (isMobile ? " mobile" : "")}>
      <TopBar
        theme={theme}
        onToggleTheme={toggleTheme}
        engineLabel={engineLabel}
        engineState={engineState}
        onLogs={() => (isMobile ? setMobileSheet("logs") : setLogsOpen(open => !open))}
        onSettings={() => setSettingsOpen(true)}
      />
      <input ref={fileRef} hidden type="file" multiple accept=".geojson,.json,.gpkg,.zip,.shp,.shx,.dbf,.prj,.cpg,.sbn,.sbx,.fgb,.kml,.kmz,.gpx,.gml,.geoparquet,.topojson,.tif,.tiff,.csv" onChange={e => { if (e.target.files?.length) void importFiles(e.target.files); }} />
      {isMobile ? (
        <>
          <main className="mobile-map" aria-label="地图">
            <MapCanvas theme={theme} dataLayers={layers} focusBounds={focus} onStatus={setMapStatus} selection={selection} onSelect={handleMapSelection}
              aoi={aoi} onAoiChange={setAoi} onOpenTable={id => { setTableId(id); setLogsOpen(false); }} />
            <MapLegend layers={layers} onStyle={id => setProperties({ id, tab: "style" })} />
            {(selection?.featureIds.length || aoi) && <div className="map-status-stack">
              {selection?.featureIds.length ? <div className="selection-hud" role="status">
                <span><strong>{selection.featureIds.length}</strong> 个要素已选{selectionLayer ? ` · ${selectionLayer.name}` : ""}</span>
                <button type="button" aria-label="清除要素选择" title="清除选择（Esc）" onClick={clearSelection}><X size={13} />清除</button>
              </div> : null}
              {aoi && <div className="aoi-hud" role="status" title="分析范围（AOI）">
                <span className="aoi-hud-label">AOI</span>
                <code>{aoi[0].toFixed(3)}, {aoi[1].toFixed(3)} — {aoi[2].toFixed(3)}, {aoi[3].toFixed(3)}</code>
                <button type="button" aria-label="清除分析范围" onClick={() => setAoi(null)}><X size={12} />清除</button>
              </div>}
            </div>}
            {importNotice && <div className="import-notice" role="status"><span>{importNotice}</span>
              {importNotice.includes("CRS") && <label>源坐标系 <input aria-label="导入源坐标系" placeholder="如 EPSG:4547，然后重新添加" value={sourceCrs} onChange={e => setSourceCrs(e.target.value)} /></label>}
              <button type="button" className="icon-btn" aria-label="关闭导入提示" onClick={() => setImportNotice("")}>×</button></div>}
          </main>
          {(agent.state.items.length > 0 || agent.state.busy) && mobileSheet !== "chat" && (
            <button type="button" className="mobile-chat-handle" onClick={() => setMobileSheet("chat")}>
              <span className="status-dot" data-state={agent.state.busy ? "pending" : "ok"} />
              <span className="mobile-chat-handle-text">{agent.state.busy ? "TIPHYS 正在处理…" : lastAgentMessage ? lastAgentMessage.slice(0, 64) : `对话 · ${agent.state.items.length} 条`}</span>
              <MessageSquareText size={15} />
            </button>
          )}
          <MobileComposer value={mobileDraft} onChange={setMobileDraft} busy={agent.state.busy} connected={agent.state.connected} unconfigured={agentUnconfigured}
            onSend={mobileSend} onCancelTurn={agent.cancelTurn} onActions={() => setMobileSheet("actions")} />
        </>
      ) : (
        <>
      <CommandRibbon hasLayer={!!activeLayer} onAdd={() => void addData()} onZoomAll={zoomAll}
        onZoomLayer={() => activeLayer && zoomLayer(activeLayer)} onTable={() => { if (activeLayer) { setTableId(activeLayer.id); setLogsOpen(false); } }}
        onStyle={() => activeLayer && setProperties({ id: activeLayer.id, tab: "style" })} onLabels={() => activeLayer && setProperties({ id: activeLayer.id, tab: "labels" })}
        onTool={tool => openDock("tools", tool)} onChat={() => openDock("chat")} onLogs={() => setLogsOpen(true)} onSettings={() => setSettingsOpen(true)} onTheme={toggleTheme}
        hasAoi={!!aoi} onClipAoi={() => void clipToAoi()} onSearchTools={query => openDock("tools", undefined, query)} />
      <div className="workspace">
        <LayerRail layers={layers} onToggle={agent.toggleLayer} onAdd={() => void addData()} importing={importing}
          selectedId={activeLayer?.id} onSelect={setSelectedId}
          onZoom={zoomLayer} onTable={id => { setTableId(id); setLogsOpen(false); }} onProperties={(id, tab) => setProperties({ id, tab })}
          onRename={handleRename} onReorder={handleReorder} onRemove={handleRemoveLayer} />
        <main className="map-pane" aria-label="地图">
          <div className="map-document-bar"><span className="map-document-tab"><MapIcon size={15} /> 地图</span><span>{activeLayer ? activeLayer.name : "地理空间工作区"}</span></div>
          <div className="map-viewport">
          <MapCanvas theme={theme} dataLayers={layers} focusBounds={focus} onStatus={setMapStatus} selection={selection} onSelect={handleMapSelection}
            aoi={aoi} onAoiChange={setAoi} onOpenTable={id => { setTableId(id); setLogsOpen(false); }} />
          <MapLegend layers={layers} onStyle={id => setProperties({ id, tab: "style" })} />
          {!layers.length && <div className="map-empty-state" role="status">
            <span className="map-empty-icon"><Layers size={20} /></span>
            <strong>地图还没有图层</strong>
            <span className="map-empty-copy">添加 GeoJSON、GeoPackage 或 GeoTIFF，开始本机空间分析。</span>
            <div className="map-empty-actions">
              <button type="button" className="primary-btn" onClick={() => void addData()}>添加数据</button>
              <button type="button" className="secondary-btn" onClick={loadSamplePoints} disabled={importing}>加载示例点位</button>
            </div>
          </div>}
          {(selection?.featureIds.length || aoi) && <div className="map-status-stack">
            {selection?.featureIds.length ? <div className="selection-hud" role="status">
              <span><strong>{selection.featureIds.length}</strong> 个要素已选{selectionLayer ? ` · ${selectionLayer.name}` : ""}</span>
              <button type="button" aria-label="清除要素选择" title="清除选择（Esc）" onClick={clearSelection}><X size={13} />清除</button>
            </div> : null}
            {aoi && <div className="aoi-hud" role="status" title="分析范围（AOI）">
              <span className="aoi-hud-label">AOI</span>
              <code>{aoi[0].toFixed(3)}, {aoi[1].toFixed(3)} — {aoi[2].toFixed(3)}, {aoi[3].toFixed(3)}</code>
              <button type="button" aria-label="清除分析范围" onClick={() => setAoi(null)}><X size={12} />清除</button>
            </div>}
          </div>}
          {importNotice && <div className="import-notice" role="status"><span>{importNotice}</span>
            {importNotice.includes("CRS") && <label>源坐标系 <input aria-label="导入源坐标系" placeholder="如 EPSG:4547，然后重新添加" value={sourceCrs} onChange={e => setSourceCrs(e.target.value)} /></label>}
            <button type="button" className="icon-btn" aria-label="关闭导入提示" onClick={() => setImportNotice("")}>×</button></div>}
          {propertyLayer && properties && <LayerProperties key={propertyLayer.id} layer={propertyLayer} tab={properties.tab}
            onTab={tab => setProperties({ id: propertyLayer.id, tab })} onClose={() => setProperties(null)}
            onStyle={style => setStyles(current => ({ ...current, [propertyLayer.id]: style }))} />}
          </div>
          {logsOpen ? <LogPanel onClose={() => setLogsOpen(false)} /> : tableLayer && <AttributeTable key={tableLayer.id} layer={tableLayer}
            selectedIds={selection?.layerId === tableLayer.id ? selection.featureIds : []}
            onSelectionChange={(featureIds, additive) => {
              setSelectedId(tableLayer.id);
              setSelection(current => {
                if (!additive || current?.layerId !== tableLayer.id) return featureIds.length ? { layerId: tableLayer.id, featureIds } : null;
                const ids = new Set(current.featureIds);
                for (const id of featureIds) { if (ids.has(id)) ids.delete(id); else ids.add(id); }
                return ids.size ? { layerId: tableLayer.id, featureIds: [...ids].sort((a, b) => a - b) } : null;
              });
            }}
            onClearSelection={clearSelection} onClose={() => setTableId(null)} onZoom={bounds => setFocus([...bounds])} />}
        </main>
        <ChatDock
          items={agent.state.items}
          busy={agent.state.busy}
          connected={agent.state.connected}
          provider={agent.state.provider}
          layers={layers}
          recovery={recoveryNote}
          selectedLayer={activeLayer} request={dockRequest} onAdd={() => void addData()} onSettings={() => setSettingsOpen(true)}
          onOpenTool={tool => openDock("tools", tool)}
          onSend={text => agent.send(text, { aoi, selectedLayerId: activeLayer?.id ?? null, selectedLayerName: activeLayer?.name ?? null, selection, recovery: recoveryNote, agentSession })}
          onApprove={agent.approve}
          onCancelJob={agent.cancelJob}
          onCancelTurn={agent.cancelTurn}
          onToolResult={agent.mergeToolResult}
        />
      </div>
      <footer className="workspace-status"><span><span className="status-dot" data-state={engineState} />{engineState === "ok" ? browserRuntime ? "Browser-WASM · 数据保存在本机" : "Python 本地引擎已就绪" : "正在加载空间引擎"}</span><span><Layers size={13} />{layers.length} 个图层</span><span className="status-coordinates"><Crosshair size={13} />{mapStatus.lng.toFixed(5)}°，{mapStatus.lat.toFixed(5)}°</span><span>级别 {mapStatus.zoom.toFixed(1)}</span><span>坐标 WGS 84</span></footer>
        </>
      )}
      {isMobile && (
        <>
          <BottomSheet open={mobileSheet === "actions"} title="快捷操作" onClose={() => setMobileSheet(null)}>
            <div className="mobile-actions">
              {mobileActions.map(({ label, Icon, run, disabled }) =>
                <button key={label} type="button" className="mobile-action" disabled={disabled} onClick={run}>
                  <Icon size={21} strokeWidth={1.7} /><span>{label}</span>
                </button>)}
            </div>
          </BottomSheet>
          <BottomSheet open={mobileSheet === "chat"} title="TIPHYS 对话" size="full"
            subtitle={<><span className="status-dot" data-state={agent.state.connected && !agentUnconfigured ? "ok" : "error"} />{agentProviderLabel}</>}
            onClose={() => setMobileSheet(null)}>
            <ChatTimeline items={agent.state.items} layers={layers} recovery={recoveryNote} busy={agent.state.busy}
              onOpenTool={tool => openDock("tools", tool)} onInsertPrompt={setMobileDraft}
              onApprove={agent.approve} onCancelJob={agent.cancelJob} />
            {agentUnconfigured && <button type="button" className="api-setup-notice" onClick={() => setSettingsOpen(true)}>配置 API，开始与 Agent 对话 →</button>}
            <div className="chat-suggestions">
              {SUGGESTIONS.map(s => <button key={s} type="button" className="chat-chip" disabled={agent.state.busy || !agent.state.connected} onClick={() => void mobileSend(s)}>{s}</button>)}
            </div>
            {activeLayer && <div className="composer-context"><Layers size={12} /><span title={activeLayer.name}>{activeLayer.name}</span><small>当前图层</small></div>}
            <MobileComposer value={mobileDraft} onChange={setMobileDraft} busy={agent.state.busy} connected={agent.state.connected} unconfigured={agentUnconfigured}
              onSend={mobileSend} onCancelTurn={agent.cancelTurn} onActions={() => setMobileSheet("actions")} />
          </BottomSheet>
          <BottomSheet open={mobileSheet === "layers"} title={`图层 · ${layers.length}`} size="tall" onClose={() => setMobileSheet(null)}>
            <LayerRail layers={layers} onToggle={agent.toggleLayer} onAdd={() => { setMobileSheet(null); void addData(); }} importing={importing}
              selectedId={activeLayer?.id} onSelect={setSelectedId}
              onZoom={zoomLayer} onTable={id => { setTableId(id); setLogsOpen(false); }} onProperties={(id, tab) => setProperties({ id, tab })}
              onRename={handleRename} onReorder={handleReorder} onRemove={handleRemoveLayer} />
          </BottomSheet>
          <BottomSheet open={mobileSheet === "tools"} title="工具箱" size="full" onClose={() => setMobileSheet(null)}>
            <ToolPanel layers={layers} onResult={agent.mergeToolResult} request={dockRequest?.tab === "tools" ? dockRequest : undefined} selectedLayer={activeLayer} />
          </BottomSheet>
          <BottomSheet open={mobileSheet === "table" && !!tableLayer} title={`属性表${tableLayer ? ` · ${tableLayer.name}` : ""}`} size="tall" onClose={() => setMobileSheet(null)}>
            {tableLayer && <AttributeTable key={tableLayer.id} layer={tableLayer}
              selectedIds={selection?.layerId === tableLayer.id ? selection.featureIds : []}
              onSelectionChange={(featureIds, additive) => {
                setSelectedId(tableLayer.id);
                setSelection(current => {
                  if (!additive || current?.layerId !== tableLayer.id) return featureIds.length ? { layerId: tableLayer.id, featureIds } : null;
                  const ids = new Set(current.featureIds);
                  for (const id of featureIds) { if (ids.has(id)) ids.delete(id); else ids.add(id); }
                  return ids.size ? { layerId: tableLayer.id, featureIds: [...ids].sort((a, b) => a - b) } : null;
                });
              }}
              onClearSelection={clearSelection} onClose={() => { setTableId(null); setMobileSheet(null); }} onZoom={bounds => setFocus([...bounds])} />}
          </BottomSheet>
          <BottomSheet open={mobileSheet === "logs"} title="运行日志" size="full" onClose={() => setMobileSheet(null)}>
            <LogPanel onClose={() => setMobileSheet(null)} />
          </BottomSheet>
          <BottomSheet open={mobileSheet === "properties" && !!propertyLayer} title="图层设置" size="tall"
            onClose={() => { setProperties(null); setMobileSheet(null); }}>
            {propertyLayer && properties && <LayerProperties key={propertyLayer.id} layer={propertyLayer} tab={properties.tab}
              onTab={tab => setProperties({ id: propertyLayer.id, tab })} onClose={() => { setProperties(null); setMobileSheet(null); }}
              onStyle={style => setStyles(current => ({ ...current, [propertyLayer.id]: style }))} />}
          </BottomSheet>
        </>
      )}
      {settingsOpen && <SettingsDialog theme={themeMode} onTheme={setThemeMode} density={density} onDensity={setDensity} onClose={() => setSettingsOpen(false)} onSaved={() => void agent.refreshProvider()} onLogs={() => setLogsOpen(true)} />}
    </div>
  );
}
