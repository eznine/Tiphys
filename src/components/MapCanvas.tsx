import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// Vite emits this as a regular JS asset. Serving the upstream .mjs file directly
// breaks on hosts that return application/octet-stream for unknown extensions.
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import {
  BASEMAPS,
  BasemapId,
  getBasemap,
  rasterStyle,
  TERRAIN_DEM,
} from "../lib/basemaps";
import { DataLayer, LayerSelection, syncDataLayers } from "../lib/dataLayers";
import { engineHeaders } from "../lib/service";
import { downloadMapPng, mapExportFilename } from "../lib/map-export";
import { scheduleIdle } from "../lib/idle";

type Props = {
  theme: "light" | "dark";
  dataLayers?: DataLayer[];
  focusBounds?: number[] | null;
  onStatus?: (status: { lng: number; lat: number; zoom: number }) => void;
  selection?: LayerSelection | null;
  onSelect?: (selection: LayerSelection | null, additive: boolean) => void;
  aoi?: number[] | null;
  onAoiChange?: (bounds: number[] | null) => void;
  onOpenTable?: (layerId: string) => void;
};

const TERRAIN_SRC = "tiphys-terrain-dem";
const DEFAULT_CENTER: [number, number] = [20, 20];
const GLOBE_ZOOM = 1.6;

function applySky(map: Map, _theme: "light" | "dark") {
  try {
    map.setSky({ "atmosphere-blend": 0.8 });
  } catch {
    /* ignore */
  }
}

function ensureTerrainSource(map: Map) {
  if (!map.getSource(TERRAIN_SRC)) {
    map.addSource(TERRAIN_SRC, {
      type: "raster-dem",
      tiles: [...TERRAIN_DEM.tiles],
      encoding: TERRAIN_DEM.encoding,
      tileSize: TERRAIN_DEM.tileSize,
      maxzoom: TERRAIN_DEM.maxzoom,
      attribution: TERRAIN_DEM.attribution,
    });
  }
}

function setBuildingsVisible(map: Map, on: boolean) {
  if (!map.getLayer("building-3d")) return;
  map.setLayoutProperty("building-3d", "visibility", on ? "visible" : "none");
}

const AOI_SOURCE = "tiphys-aoi";

function renderAoi(map: Map, bounds: number[] | null) {
  const valid = bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[0] !== bounds[2] && bounds[1] !== bounds[3];
  const data = valid ? {
    type: "FeatureCollection" as const,
    features: [{
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Polygon" as const, coordinates: [[[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]]]] },
    }],
  } : null;
  const source = map.getSource(AOI_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!data) {
    if (map.getLayer(`${AOI_SOURCE}-fill`)) map.removeLayer(`${AOI_SOURCE}-fill`);
    if (map.getLayer(`${AOI_SOURCE}-line`)) map.removeLayer(`${AOI_SOURCE}-line`);
    if (source) map.removeSource(AOI_SOURCE);
    return;
  }
  if (source) source.setData(data);
  else map.addSource(AOI_SOURCE, { type: "geojson", data });
  if (!map.getLayer(`${AOI_SOURCE}-fill`)) map.addLayer({ id: `${AOI_SOURCE}-fill`, type: "fill", source: AOI_SOURCE,
    paint: { "fill-color": "#2563eb", "fill-opacity": 0.1 } });
  if (!map.getLayer(`${AOI_SOURCE}-line`)) map.addLayer({ id: `${AOI_SOURCE}-line`, type: "line", source: AOI_SOURCE,
    paint: { "line-color": "#2563eb", "line-width": 1.5, "line-dasharray": [4, 3] } });
}

function boundsFromPoints(a: maplibregl.LngLat, b: maplibregl.LngLat): number[] {
  return [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];
}

export function MapCanvas({ theme, dataLayers = [], focusBounds = null, onStatus, selection = null, onSelect, aoi = null, onAoiChange, onOpenTable }: Props) {
  const dataLayersRef = useRef(dataLayers);
  dataLayersRef.current = dataLayers;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const introDone = useRef(false);
  const introTimerRef = useRef<number | undefined>(undefined);
  const focusRequestedRef = useRef(false);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const aoiRef = useRef(aoi);
  aoiRef.current = aoi;
  const onAoiChangeRef = useRef(onAoiChange);
  onAoiChangeRef.current = onAoiChange;
  const onOpenTableRef = useRef(onOpenTable);
  onOpenTableRef.current = onOpenTable;
  const identifyRef = useRef<maplibregl.Popup | null>(null);
  const drawingAoiRef = useRef(false);
  const appliedSelection = useRef<LayerSelection | null>(null);

  const [basemapId, setBasemapId] = useState<BasemapId>("liberty");
  const [mode3d, setMode3d] = useState(true);
  const [terrain, setTerrain] = useState(false);
  const [buildings, setBuildings] = useState(true);
  const basemapRef = useRef<BasemapId>("liberty");
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawingAoi, setDrawingAoi] = useState(false);
  const [draftAoi, setDraftAoi] = useState<number[] | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const exportStatusTimer = useRef<number | undefined>(undefined);
  const draftAoiRef = useRef<number[] | null>(null);
  drawingAoiRef.current = drawingAoi;

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const mode3dRef = useRef(mode3d);
  mode3dRef.current = mode3d;
  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;
  const buildingsRef = useRef(buildings);
  buildingsRef.current = buildings;

  function applyStyleExtras(map: Map) {
    applySky(map, themeRef.current);
    if (mode3dRef.current) {
      try {
        map.setProjection({ type: "globe" });
      } catch {
        /* ignore */
      }
    } else {
      try {
        map.setProjection({ type: "mercator" });
      } catch {
        /* ignore */
      }
    }
    if (terrainRef.current) {
      ensureTerrainSource(map);
      map.setTerrain({ source: TERRAIN_SRC, exaggeration: 1.3 });
    } else {
      map.setTerrain(null);
    }
    setBuildingsVisible(map, buildingsRef.current);
    renderAoi(map, draftAoiRef.current ?? aoiRef.current);
  }

  function loadBasemap(map: Map, id: BasemapId) {
    const def = getBasemap(id);
    const bg = themeRef.current === "dark" ? "#0B1220" : "#E2E8F0";
    if (def.kind === "style-url" && def.url) {
      map.setStyle(def.url, { diff: false });
    } else if (def.tiles) {
      map.setStyle(rasterStyle(def.id, def.tiles, def.attribution, bg));
    }
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getBasemap("liberty").url!,
      center: DEFAULT_CENTER,
      zoom: GLOBE_ZOOM,
      pitch: 0,
      bearing: 0,
      attributionControl: { compact: true },
      locale: { "NavigationControl.ZoomIn": "放大", "NavigationControl.ZoomOut": "缩小", "NavigationControl.ResetBearing": "拖动旋转，点击恢复正北", "AttributionControl.ToggleAttribution": "显示地图来源" },
      maxPitch: 85,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      transformRequest: (url) => ({ url, headers: engineHeaders(url) }),
    });

    let cancelControls = () => {};
    let cancelTerrain = () => {};
    map.on("mousemove", e => statusRef.current?.({ lng: e.lngLat.wrap().lng, lat: e.lngLat.lat, zoom: map.getZoom() }));
    map.on("moveend", () => { const center = map.getCenter().wrap(); statusRef.current?.({ lng: center.lng, lat: center.lat, zoom: map.getZoom() }); });
    const closeIdentify = () => { identifyRef.current?.remove(); identifyRef.current = null; };
    const geometryLabels: Record<string, string> = { Point: "点", MultiPoint: "多点", LineString: "线", MultiLineString: "多线", Polygon: "面", MultiPolygon: "多面" };
    const showIdentify = (event: maplibregl.MapMouseEvent, feature: maplibregl.MapGeoJSONFeature) => {
      closeIdentify();
      const layerId = String((feature as { source?: string }).source ?? "").slice("tiphys-".length);
      const layer = dataLayersRef.current.find(l => l.id === layerId);
      const geometry = layer?.geometry_types?.[0];
      const geometryLabel = geometry ? geometryLabels[geometry] ?? geometry : "要素";
      const entries = Object.entries(feature.properties ?? {});
      const content = document.createElement("div");
      content.className = "tiphys-identify";
      const title = document.createElement("div");
      title.className = "tiphys-identify-title";
      title.textContent = `${layer?.name ?? layerId} · ${geometryLabel} #${feature.id}`;
      content.append(title);
      if (entries.length) {
        const list = document.createElement("dl");
        for (const [key, value] of entries.slice(0, 8)) {
          const name = document.createElement("dt");
          name.textContent = key;
          const item = document.createElement("dd");
          const text = value == null ? "空" : String(value);
          item.textContent = text.length > 80 ? `${text.slice(0, 80)}…` : text;
          if (text.length > 80) item.title = text;
          list.append(name, item);
        }
        content.append(list);
        if (entries.length > 8) {
          const note = document.createElement("p");
          note.className = "tiphys-identify-note";
          note.textContent = `… 共 ${entries.length} 个字段`;
          content.append(note);
        }
      } else {
        const empty = document.createElement("p");
        empty.className = "tiphys-identify-note";
        empty.textContent = "该要素没有属性字段。";
        content.append(empty);
      }
      if (layer) {
        const actions = document.createElement("div");
        actions.className = "tiphys-identify-actions";
        const openTable = document.createElement("button");
        openTable.type = "button";
        openTable.textContent = "在属性表中查看";
        openTable.addEventListener("click", () => onOpenTableRef.current?.(layerId));
        actions.append(openTable);
        content.append(actions);
      }
      identifyRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "300px", offset: 10, className: "tiphys-identify-popup" })
        .setLngLat(event.lngLat)
        .setDOMContent(content)
        .once("close", closeIdentify)
        .addTo(map);
    };
    const escapeIdentify = (event: KeyboardEvent) => { if (event.key === "Escape") closeIdentify(); };
    window.addEventListener("keydown", escapeIdentify);
    map.on("click", event => {
      if (drawingAoiRef.current) return;
      const hit = map.queryRenderedFeatures(event.point)
        .find(feature => String((feature as { source?: string }).source ?? "").startsWith("tiphys-lyr_") && feature.id != null);
      if (!hit) { closeIdentify(); onSelectRef.current?.(null, event.originalEvent.shiftKey || event.originalEvent.metaKey || event.originalEvent.ctrlKey); return; }
      const id = Number(hit.id);
      if (!Number.isFinite(id)) return;
      const layerId = String((hit as { source: string }).source).slice("tiphys-".length);
      showIdentify(event, hit);
      onSelectRef.current?.({ layerId, featureIds: [id] }, event.originalEvent.shiftKey || event.originalEvent.metaKey || event.originalEvent.ctrlKey);
    });

    map.on("style.load", () => {
      applyStyleExtras(map);
      syncDataLayers(map, dataLayersRef.current);
    });

    map.once("load", () => {
      applyStyleExtras(map);
      // The terrain tile source is metadata-only, so it can wait for idle. AOI
      // and data layers were already rendered by style.load above.
      cancelTerrain = scheduleIdle(() => {
        if (mapRef.current === map) ensureTerrainSource(map);
      }, { timeout: 1400, fallbackDelay: 350 });
      requestAnimationFrame(() => {
        if (mapRef.current !== map || introDone.current || focusRequestedRef.current || dataLayersRef.current.length !== 0) return;
        introDone.current = true;
        // Globe projection: avoid easeTo with bearing (unsupported). Zoom then rotate.
        map.easeTo({ zoom: 2.05, pitch: 0, duration: 1600 });
        introTimerRef.current = window.setTimeout(() => {
          introTimerRef.current = undefined;
          if (mapRef.current !== map || focusRequestedRef.current) return;
          map.rotateTo(map.getBearing() + 35, { duration: 2200 });
        }, 1700);
      });
    });

    mapRef.current = map;
    cancelControls = scheduleIdle(() => {
      if (mapRef.current !== map) return;
      map.addControl(
        new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }),
        "top-right",
      );
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 100 }), "bottom-left");
    }, { timeout: 900, fallbackDelay: 120 });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    (window as unknown as { __tiphysMap?: Map }).__tiphysMap = map;
    return () => {
      cancelControls();
      cancelTerrain();
      window.removeEventListener("keydown", escapeIdentify);
      if (introTimerRef.current !== undefined) window.clearTimeout(introTimerRef.current);
      introTimerRef.current = undefined;
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    if (exportStatusTimer.current !== undefined) window.clearTimeout(exportStatusTimer.current);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applySky(map, theme);
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemapRef.current === basemapId) return;
    basemapRef.current = basemapId;
    loadBasemap(map, basemapId);
  }, [basemapId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (mode3d) {
        map.setProjection({ type: "globe" });
        if (map.getPitch() < 5) {
          map.easeTo({ pitch: 18, duration: 600 });
        }
      } else {
        map.setProjection({ type: "mercator" });
        map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
      }
    } catch {
      /* ignore */
    }
  }, [mode3d]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    ensureTerrainSource(map);
    map.setTerrain(terrain ? { source: TERRAIN_SRC, exaggeration: 1.3 } : null);
    if (terrain && mode3dRef.current && map.getPitch() < 30) {
      map.easeTo({ pitch: 45, duration: 700 });
    }
  }, [terrain]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    setBuildingsVisible(map, buildings);
  }, [buildings]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    let frame = 0;
    // Style sliders can emit several updates in one frame. Coalesce them and
    // paint with the latest layer props instead of synchronously walking every
    // source for each pointer event.
    const apply = () => {
      frame = 0;
      if (cancelled) return;
      if (!map.isStyleLoaded()) { map.once("idle", apply); return; }
      syncDataLayers(map, dataLayersRef.current);
    };
    frame = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      map.off("idle", apply);
    };
  }, [dataLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => renderAoi(map, draftAoi ?? aoi);
    if (map.isStyleLoaded()) apply();
    else map.once("idle", apply);
  }, [aoi, draftAoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!drawingAoi) {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      return;
    }
    map.dragPan.disable();
    map.getCanvas().style.cursor = "crosshair";
    let start: maplibregl.LngLat | null = null;
    const down = (event: maplibregl.MapMouseEvent) => {
      event.originalEvent.preventDefault();
      start = event.lngLat;
      const bounds = boundsFromPoints(start, start);
      draftAoiRef.current = bounds;
      setDraftAoi(bounds);
    };
    const move = (event: maplibregl.MapMouseEvent) => {
      if (!start) return;
      const bounds = boundsFromPoints(start, event.lngLat);
      draftAoiRef.current = bounds;
      setDraftAoi(bounds);
    };
    const up = () => {
      if (!start) return;
      const bounds = draftAoiRef.current;
      start = null;
      setDrawingAoi(false);
      if (bounds && Math.abs(bounds[2] - bounds[0]) > 0.00001 && Math.abs(bounds[3] - bounds[1]) > 0.00001) onAoiChangeRef.current?.(bounds);
      else { draftAoiRef.current = null; setDraftAoi(null); }
    };
    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    return () => {
      map.off("mousedown", down);
      map.off("mousemove", move);
      map.off("mouseup", up);
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    };
  }, [drawingAoi]);

  useEffect(() => {
    if (aoi) { draftAoiRef.current = null; setDraftAoi(null); }
  }, [aoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const previous = appliedSelection.current;
      if (previous) {
        try { for (const id of previous.featureIds) map.removeFeatureState({ source: `tiphys-${previous.layerId}`, id }); }
        catch { /* Source may have been replaced by a basemap style reload. */ }
      }
      if (!selection?.featureIds.length) { appliedSelection.current = null; return; }
      const source = `tiphys-${selection.layerId}`;
      if (!map.getSource(source)) syncDataLayers(map, dataLayersRef.current);
      if (!map.getSource(source)) { appliedSelection.current = null; return; }
      for (const id of selection.featureIds) map.setFeatureState({ source, id }, { selected: true });
      appliedSelection.current = { ...selection, featureIds: [...selection.featureIds] };
    };
    if (map.isStyleLoaded()) apply();
    else map.once("idle", apply);
  }, [selection, dataLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusBounds || focusBounds.length !== 4 || !focusBounds.every(Number.isFinite)) return;
    const [a, b, c, d] = focusBounds;
    focusRequestedRef.current = true;
    introDone.current = true;
    if (introTimerRef.current !== undefined) window.clearTimeout(introTimerRef.current);
    introTimerRef.current = undefined;
    map.stop();
    map.fitBounds([[a, b], [c, d]], { padding: 80, duration: 1800, maxZoom: 14 });
  }, [focusBounds]);

  async function exportMapImage() {
    const map = mapRef.current;
    if (!map || exportStatus === "导出中…") return;
    if (exportStatusTimer.current !== undefined) window.clearTimeout(exportStatusTimer.current);
    setExportStatus("导出中…");
    try {
      await new Promise<void>(resolve => {
        let settled = false;
        let timer: number | undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) window.clearTimeout(timer);
          map.off("idle", finish);
          resolve();
        };
        timer = window.setTimeout(finish, 900);
        map.once("idle", finish);
        map.triggerRepaint();
      });
      downloadMapPng(map.getCanvas(), mapExportFilename());
      setExportStatus("已导出");
    } catch (error) {
      console.error("Map export failed", error);
      setExportStatus("导出失败");
    }
    exportStatusTimer.current = window.setTimeout(() => setExportStatus(""), 1800);
  }

  const current = getBasemap(basemapId);

  return (
    <div className="map-canvas-wrap">
      <div className="maplibre-map" ref={containerRef} />
      <div className="map-controls" aria-label="Map controls">
        <div className="map-ctrl-group">
          <button
            type="button"
            className="map-ctrl-btn"
            data-active={drawingAoi}
            onClick={() => setDrawingAoi(value => !value)}
            aria-pressed={drawingAoi}
            title="在地图上拖动绘制矩形 AOI"
          >
            {drawingAoi ? "绘制中…" : "AOI"}
          </button>
        </div>
        <div className="map-ctrl-group">
          <button
            type="button"
            className="map-ctrl-btn"
            onClick={() => void exportMapImage()}
            disabled={exportStatus === "导出中…"}
            title="将当前地图视图下载为 PNG"
          >
            PNG
          </button>
          {exportStatus && <span className="map-ctrl-status" role="status">{exportStatus}</span>}
        </div>
        <div className="map-ctrl-group">
          <button
            type="button"
            className="map-ctrl-btn"
            data-active={mode3d}
            onClick={() => setMode3d(true)}
            title="3D globe"
          >
            3D
          </button>
          <button
            type="button"
            className="map-ctrl-btn"
            data-active={!mode3d}
            onClick={() => setMode3d(false)}
            title="2D map"
          >
            2D
          </button>
        </div>
        <div className="map-ctrl-group">
          <button
            type="button"
            className="map-ctrl-btn"
            data-active={terrain}
            onClick={() => setTerrain((v) => !v)}
            title="Terrain DEM"
          >
            地形
          </button>
          <button
            type="button"
            className="map-ctrl-btn"
            data-active={buildings}
            disabled={!current.hasBuildings}
            onClick={() => setBuildings((v) => !v)}
            title="3D buildings (Streets style)"
          >
            建筑
          </button>
        </div>
        <div className="map-ctrl-group basemap-switcher">
          <button
            type="button"
            className="map-ctrl-btn"
            data-active={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
          >
            {current.label} ▾
          </button>
          {menuOpen && (
            <ul className="basemap-menu" role="listbox">
              {BASEMAPS.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className="basemap-item"
                    data-active={b.id === basemapId}
                    onClick={() => {
                      setBasemapId(b.id);
                      setMenuOpen(false);
                    }}
                  >
                    {b.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
