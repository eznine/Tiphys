import type { FeatureCollection } from "geojson";
import type { CatalogTool } from "../browser/catalog-schema";

/** Read-only layer metadata exposed to trusted local extensions. */
export type ExtensionLayerInfo = {
  id: string;
  name: string;
  kind: string;
  crs: string;
  feature_count: number;
  bounds: number[] | null;
  geometry_types: string[];
  /** Display GeoJSON in WGS84, available for vector layers. */
  geojson?: FeatureCollection;
};

/** Engine services available while an extension runs inside a browser job. */
export type ExtensionRunContext = {
  /** Run another catalog tool inline, sharing the current job and cancellation signal. */
  runTool: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  /** Inspect a layer without exposing its binary file handle. */
  inspectLayer: (layer: string) => Promise<ExtensionLayerInfo>;
  /** Create a workspace layer from GeoJSON, used for transient helper layers. */
  createLayer: (geojson: FeatureCollection, name: string) => Promise<Record<string, any>>;
  /** Reproject a vector layer from its original bytes into a new workspace layer. */
  reprojectLayer: (layer: string, epsg: number, name: string) => Promise<Record<string, any>>;
  /** Merge vector layers in their native CRS into one workspace layer. */
  mergeLayers: (layers: string[], name: string) => Promise<Record<string, any>>;
};

/** A browser extension contributes normal catalog tools and may execute them locally. */
export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  tools: CatalogTool[];
  run?: (toolName: string, args: Record<string, unknown>, context: ExtensionRunContext) =>
    Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type ExtensionRunResult = Record<string, unknown>;
