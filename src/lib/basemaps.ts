/** Keyless basemap catalog. URLs verified via curl HTTP 200 (2026-10-23). */

import type { StyleSpecification } from "maplibre-gl";

export type BasemapId =
  | "liberty"
  | "positron"
  | "dark"
  | "bright"
  | "satellite"
  | "hillshade"
  | "opentopo"
  | "offline"
  | "custom";

export type BasemapDef = {
  id: BasemapId;
  label: string;
  kind: "style-url" | "raster" | "blank";
  url?: string;
  tiles?: string[];
  attribution: string;
  hasBuildings?: boolean;
  keyRequired: false;
};

export const BASEMAPS: BasemapDef[] = [
  {
    id: "liberty",
    label: "街道",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/liberty",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    hasBuildings: true,
    keyRequired: false,
  },
  {
    id: "positron",
    label: "浅色",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/positron",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "dark",
    label: "深色",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/dark",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "bright",
    label: "明亮",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/bright",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "satellite",
    label: "卫星影像",
    kind: "raster",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
    keyRequired: false,
  },
  {
    id: "hillshade",
    label: "地形晕渲",
    kind: "raster",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Tiles © Esri — Elevation hillshade",
    keyRequired: false,
  },
  {
    id: "opentopo",
    label: "地形图",
    kind: "raster",
    tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenTopoMap (CC-BY-SA) © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "offline",
    label: "离线空白",
    kind: "blank",
    attribution: "无在线底图瓦片；仅显示本机图层",
    keyRequired: false,
  },
];

/** Would need API keys — not wired. */
export const KEYED_BASEMAPS_NOTE = [
  "MapTiler (streets/satellite/terrain) — API key",
  "Mapbox styles — access token",
  "Stadia Maps — API key for production",
];

export const TERRAIN_DEM = {
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  encoding: "terrarium" as const,
  tileSize: 256,
  maxzoom: 15,
  attribution:
    'Elevation © <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
};

export function rasterStyle(
  id: string,
  tiles: string[],
  attribution: string,
  bg: string,
): StyleSpecification {
  return {
    version: 8,
    name: id,
    sources: {
      basemap: {
        type: "raster",
        tiles,
        tileSize: 256,
        attribution,
        maxzoom: 19,
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": bg } },
      { id: "basemap", type: "raster", source: "basemap" },
    ],
  };
}

/** A real, tile-free MapLibre style for offline use. It is not a cached basemap. */
export function blankStyle(id: string, bg: string): StyleSpecification {
  return {
    version: 8,
    name: `${id}-blank`,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": bg } }],
  };
}

/** User-added online tile service (XYZ / WMS / ArcGIS tile), persisted in localStorage. */
export function customBasemap(): BasemapDef | null {
  try {
    const raw = localStorage.getItem("tiphys-custom-basemap");
    if (!raw) return null;
    const src = JSON.parse(raw) as { label: string; tiles: string[]; attribution: string };
    return { id: "custom", label: src.label || "自定义", kind: "raster", tiles: src.tiles, attribution: src.attribution || "", keyRequired: false };
  } catch { return null; }
}

export function getBasemap(id: BasemapId): BasemapDef {
  if (id === "custom") { const c = customBasemap(); if (c) return c; return BASEMAPS[0]; }
  const b = BASEMAPS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown basemap ${id}`);
  return b;
}
