/** Keyless basemap catalog. URLs verified via curl HTTP 200 (2026-10-23). */

import type { StyleSpecification } from "maplibre-gl";

export type BasemapId =
  | "liberty"
  | "positron"
  | "dark"
  | "bright"
  | "satellite"
  | "hillshade"
  | "opentopo";

export type BasemapDef = {
  id: BasemapId;
  label: string;
  kind: "style-url" | "raster";
  url?: string;
  tiles?: string[];
  attribution: string;
  hasBuildings?: boolean;
  keyRequired: false;
};

export const BASEMAPS: BasemapDef[] = [
  {
    id: "liberty",
    label: "Streets",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/liberty",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    hasBuildings: true,
    keyRequired: false,
  },
  {
    id: "positron",
    label: "Light",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/positron",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "dark",
    label: "Dark",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/dark",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "bright",
    label: "Bright",
    kind: "style-url",
    url: "https://tiles.openfreemap.org/styles/bright",
    attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap",
    keyRequired: false,
  },
  {
    id: "satellite",
    label: "Satellite",
    kind: "raster",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
    keyRequired: false,
  },
  {
    id: "hillshade",
    label: "Hillshade",
    kind: "raster",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Tiles © Esri — Elevation hillshade",
    keyRequired: false,
  },
  {
    id: "opentopo",
    label: "Topo",
    kind: "raster",
    tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenTopoMap (CC-BY-SA) © OpenStreetMap",
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

export function getBasemap(id: BasemapId): BasemapDef {
  const b = BASEMAPS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown basemap ${id}`);
  return b;
}
