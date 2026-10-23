import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { ChatDock } from "./components/ChatDock";
import { MapCanvas } from "./components/MapCanvas";
import { LayerRail } from "./components/LayerRail";
import { pingEngine, PingResult } from "./lib/engine";
import { Map as MapIcon, Layers, Crosshair } from "lucide-react";
import { SettingsDialog, type ThemeMode } from "./components/SettingsDialog";
import { CommandRibbon } from "./components/CommandRibbon";
import { useAgent } from "./lib/agent";
import { defaultLayerStyle, type DataLayer, type LayerStyle } from "./lib/dataLayers";
import { engineRequest } from "./lib/service";
import { AttributeTable } from "./components/AttributeTable";
import { LayerProperties } from "./components/LayerProperties";
import { LogPanel } from "./components/LogPanel";
import { browserRuntime } from "./lib/runtime";
import "./styles/app.css";

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

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadTheme);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
  const [density, setDensity] = useState<"standard" | "compact">(() => localStorage.getItem("tiphys-density") === "compact" ? "compact" : "standard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dockRequest, setDockRequest] = useState<{ id: number; tool?: string; tab: "chat" | "tools" }>();
  const [mapStatus, setMapStatus] = useState({ lng: 20, lat: 20, zoom: 1.6 });
  const [ping, setPing] = useState<PingResult>({ state: "pending" });
  const agent = useAgent("default");
  const [styles, setStyles] = useState(loadLayerStyles);
  const [focus, setFocus] = useState<number[] | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [properties, setProperties] = useState<{ id: string; tab: "style" | "labels" | "info" } | null>(null);
  const [importing, setImporting] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const [sourceCrs, setSourceCrs] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const appliedViews = useRef(loadAppliedViews());
  const layers = useMemo(() => agent.state.layers.map(l => ({ ...l, style: { ...defaultLayerStyle(l.id), ...styles[l.id] } })), [agent.state.layers, styles]);
  const tableLayer = layers.find(l => l.id === tableId);
  const propertyLayer = layers.find(l => l.id === properties?.id);
  const activeLayer = layers.find(l => l.id === selectedId) ?? layers[0];
  const toggleTheme = () => setThemeMode(theme === "dark" ? "light" : "dark");
  const openDock = (tab: "chat" | "tools", tool?: string) => setDockRequest({ id: Date.now(), tab, tool });
  const zoomAll = () => {
    const bounds = layers.map(l => l.bounds).filter((b): b is number[] => !!b);
    if (bounds.length) setFocus([Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])), Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3]))]);
    else setFocus([-160, -60, 160, 75]);
  };
  useEffect(() => { localStorage.setItem("tiphys-layer-styles", JSON.stringify(styles)); }, [styles]);
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
  const importFiles = async (files: FileList) => {
    setImporting(true); setImportNotice("");
    let loaded = 0;
    try {
      for (const file of Array.from(files)) {
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
  };
  const handleRename = (id: string, name: string) => { void runWorkspaceTool("rename_layer", { layer: id, name }).catch(err => setImportNotice(`重命名失败：${err}`)); };
  const handleReorder = (ids: string[]) => { void runWorkspaceTool("reorder_layers", { layer_ids: ids }).catch(err => setImportNotice(`图层排序失败：${err}`)); };
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

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("tiphys-theme", themeMode);
  }, [theme, themeMode]);
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

  const engineLabel = useMemo(() => {
    if (ping.state === "ok") return browserRuntime ? "Browser-WASM" : `Python · ${ping.latencyMs}ms`;
    if (ping.state === "error") return "未连接";
    return "…";
  }, [ping]);
  const engineState = ping.state === "ok" ? "ok" : ping.state === "error" ? "error" : "pending";

  return (
    <div className="app-shell">
      <TopBar
        theme={theme}
        onToggleTheme={toggleTheme}
        engineLabel={engineLabel}
        engineState={engineState}
        onLogs={() => setLogsOpen(open => !open)}
        onSettings={() => setSettingsOpen(true)}
      />
      <CommandRibbon hasLayer={!!activeLayer} onAdd={() => void addData()} onZoomAll={zoomAll}
        onZoomLayer={() => activeLayer && zoomLayer(activeLayer)} onTable={() => { if (activeLayer) { setTableId(activeLayer.id); setLogsOpen(false); } }}
        onStyle={() => activeLayer && setProperties({ id: activeLayer.id, tab: "style" })} onLabels={() => activeLayer && setProperties({ id: activeLayer.id, tab: "labels" })}
        onTool={tool => openDock("tools", tool)} onChat={() => openDock("chat")} onLogs={() => setLogsOpen(true)} onSettings={() => setSettingsOpen(true)} onTheme={toggleTheme} />
      <div className="workspace">
        <LayerRail layers={layers} onToggle={agent.toggleLayer} onAdd={() => void addData()} importing={importing}
          selectedId={activeLayer?.id} onSelect={setSelectedId}
          onZoom={zoomLayer} onTable={id => { setTableId(id); setLogsOpen(false); }} onProperties={(id, tab) => setProperties({ id, tab })}
          onRename={handleRename} onReorder={handleReorder} />
        <input ref={fileRef} hidden type="file" multiple accept=".geojson,.json,.gpkg,.zip,.fgb,.kml,.tif,.tiff,.csv" onChange={e => { if (e.target.files?.length) void importFiles(e.target.files); }} />
        <main className="map-pane" aria-label="地图">
          <div className="map-document-bar"><span className="map-document-tab"><MapIcon size={15} /> 地图</span><span>{activeLayer ? activeLayer.name : "地理空间工作区"}</span></div>
          <div className="map-viewport">
          <MapCanvas theme={theme} dataLayers={layers} focusBounds={focus} onStatus={setMapStatus} />
          {importNotice && <div className="import-notice" role="status"><span>{importNotice}</span>
            {importNotice.includes("CRS") && <label>源坐标系 <input aria-label="导入源坐标系" placeholder="如 EPSG:4547，然后重新添加" value={sourceCrs} onChange={e => setSourceCrs(e.target.value)} /></label>}
            <button type="button" className="icon-btn" aria-label="关闭导入提示" onClick={() => setImportNotice("")}>×</button></div>}
          {propertyLayer && properties && <LayerProperties key={propertyLayer.id} layer={propertyLayer} tab={properties.tab}
            onTab={tab => setProperties({ id: propertyLayer.id, tab })} onClose={() => setProperties(null)}
            onStyle={style => setStyles(current => ({ ...current, [propertyLayer.id]: style }))} />}
          </div>
          {logsOpen ? <LogPanel onClose={() => setLogsOpen(false)} /> : tableLayer && <AttributeTable key={tableLayer.id} layer={tableLayer} onClose={() => setTableId(null)} onZoom={bounds => setFocus([...bounds])} />}
        </main>
        <ChatDock
          items={agent.state.items}
          busy={agent.state.busy}
          connected={agent.state.connected}
          provider={agent.state.provider}
          layers={layers}
          selectedLayer={activeLayer} request={dockRequest} onAdd={() => void addData()} onSettings={() => setSettingsOpen(true)}
          onSend={agent.send}
          onApprove={agent.approve}
          onCancelJob={agent.cancelJob}
          onCancelTurn={agent.cancelTurn}
          onToolResult={agent.mergeToolResult}
        />
      </div>
      <footer className="workspace-status"><span><span className="status-dot" data-state={engineState} />{engineState === "ok" ? browserRuntime ? "Browser-WASM · 数据保存在本机" : "Python 本地引擎已就绪" : "正在加载空间引擎"}</span><span><Layers size={13} />{layers.length} 个图层</span><span className="status-coordinates"><Crosshair size={13} />{mapStatus.lng.toFixed(5)}°，{mapStatus.lat.toFixed(5)}°</span><span>级别 {mapStatus.zoom.toFixed(1)}</span><span>坐标 WGS 84</span></footer>
      {settingsOpen && <SettingsDialog theme={themeMode} onTheme={setThemeMode} density={density} onDensity={setDensity} onClose={() => setSettingsOpen(false)} onSaved={() => void agent.refreshProvider()} onLogs={() => setLogsOpen(true)} />}
    </div>
  );
}
