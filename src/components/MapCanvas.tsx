import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

// Explicit worker URL so the module worker resolves in both vite dev and production builds.
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import {
  BASEMAPS,
  BasemapId,
  getBasemap,
  rasterStyle,
  TERRAIN_DEM,
} from "../lib/basemaps";
import { DataLayer, syncDataLayers } from "../lib/dataLayers";
import { engineHeaders } from "../lib/service";

type Props = {
  theme: "light" | "dark";
  dataLayers?: DataLayer[];
  focusBounds?: number[] | null;
  onStatus?: (status: { lng: number; lat: number; zoom: number }) => void;
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

export function MapCanvas({ theme, dataLayers = [], focusBounds = null, onStatus }: Props) {
  const dataLayersRef = useRef(dataLayers);
  dataLayersRef.current = dataLayers;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const introDone = useRef(false);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  const [basemapId, setBasemapId] = useState<BasemapId>("liberty");
  const [mode3d, setMode3d] = useState(true);
  const [terrain, setTerrain] = useState(false);
  const [buildings, setBuildings] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

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
    ensureTerrainSource(map);
    if (terrainRef.current) {
      map.setTerrain({ source: TERRAIN_SRC, exaggeration: 1.3 });
    } else {
      map.setTerrain(null);
    }
    setBuildingsVisible(map, buildingsRef.current);
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
      transformRequest: (url) => ({ url, headers: engineHeaders(url) }),
    });

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }),
      "top-right",
    );
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100 }), "bottom-left");
    map.on("mousemove", e => statusRef.current?.({ lng: e.lngLat.wrap().lng, lat: e.lngLat.lat, zoom: map.getZoom() }));
    map.on("moveend", () => { const center = map.getCenter().wrap(); statusRef.current?.({ lng: center.lng, lat: center.lat, zoom: map.getZoom() }); });

    map.on("style.load", () => {
      applyStyleExtras(map);
      syncDataLayers(map, dataLayersRef.current);
    });

    map.once("load", () => {
      applyStyleExtras(map);
      if (!introDone.current && dataLayersRef.current.length === 0) {
        introDone.current = true;
        // Globe projection: avoid easeTo with bearing (unsupported). Zoom then rotate.
        map.easeTo({ zoom: 2.05, pitch: 0, duration: 1600 });
        window.setTimeout(() => {
          if (!mapRef.current) return;
          map.rotateTo(map.getBearing() + 35, { duration: 2200 });
        }, 1700);
      }
    });

    mapRef.current = map;
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    (window as unknown as { __tiphysMap?: Map }).__tiphysMap = map;
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applySky(map, theme);
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
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
    if (map.isStyleLoaded()) syncDataLayers(map, dataLayers);
    else map.once("idle", () => syncDataLayers(map, dataLayersRef.current));
  }, [dataLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusBounds || focusBounds.length !== 4 || !focusBounds.every(Number.isFinite)) return;
    const [a, b, c, d] = focusBounds;
    map.fitBounds([[a, b], [c, d]], { padding: 80, duration: 1800, maxZoom: 14 });
  }, [focusBounds]);

  const current = getBasemap(basemapId);

  return (
    <div className="map-canvas-wrap">
      <div className="maplibre-map" ref={containerRef} />
      <div className="map-controls" aria-label="Map controls">
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
