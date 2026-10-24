import type { DataLayer } from "./dataLayers";

export type LayerExportTarget = {
  endpoint: string;
  filename: string;
  format: "geojson" | "tif";
  label: string;
};

type LayerLocation = Pick<DataLayer, "sourcePath" | "source_path">;

export function layerSourcePath(layer: LayerLocation | null | undefined): string | null {
  const value = layer?.sourcePath ?? layer?.source_path;
  return typeof value === "string" && value.trim() ? value : null;
}

export function layerFilenameStem(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").slice(0, 80) || "layer";
}

export function layerExportTarget(layer: DataLayer): LayerExportTarget | null {
  const stem = layerFilenameStem(layer.name);
  const id = encodeURIComponent(layer.id);
  if (layer.kind === "raster") {
    return { endpoint: `/layers/${id}/download`, filename: `${stem}.tif`, format: "tif", label: "工作副本 GeoTIFF" };
  }
  if (layer.kind === "table") return null;
  return { endpoint: `/layers/${id}.geojson`, filename: `${stem}.geojson`, format: "geojson", label: "GeoJSON（WGS 84）" };
}

export function layerReloadUnavailableReason(layer: DataLayer, hasHandler: boolean): string {
  if (!hasHandler) return "当前环境不支持从源重新加载";
  if (!layerSourcePath(layer)) return "无原始路径，无法重新加载";
  return "";
}

export function layerExportUnavailableReason(layer: DataLayer, hasHandler: boolean): string {
  if (!hasHandler) return "当前环境不支持导出图层";
  if (layer.kind === "table") return "表格图层请在属性表中导出 CSV";
  return "";
}

export function formatLayerBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

export function layerKindLabel(kind: DataLayer["kind"]): string {
  return kind === "raster" ? "栅格" : kind === "table" ? "表格" : "矢量";
}
