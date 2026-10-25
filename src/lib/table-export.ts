import { buildXlsxSheet, type XlsxValue } from "./xlsx";

export type ExportableTablePage = {
  fields: { name: string; type?: string }[];
  rows: { id: number; attributes: Record<string, unknown> }[];
};

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Export exactly the visible table page, with record IDs and no hidden geometry. */
export function tablePageCsv(page: ExportableTablePage): string {
  const fields = page.fields.map(field => field.name);
  return [
    ["记录", ...fields].map(csvCell).join(","),
    ...page.rows.map(row => [row.id + 1, ...fields.map(field => row.attributes[field])].map(csvCell).join(",")),
  ].join("\r\n");
}

export function tableExportFilename(layerName: string): string {
  const stem = layerName.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "attributes";
  return `${stem}_本页.csv`;
}

function xlsxCell(value: unknown): XlsxValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

/** Export exactly the visible table page as a real single-sheet XLSX workbook. */
export function tablePageXlsx(page: ExportableTablePage): Uint8Array<ArrayBuffer> {
  const fields = page.fields.map(field => field.name);
  return buildXlsxSheet({
    name: "属性",
    headers: ["记录", ...fields],
    rows: page.rows.map(row => [row.id + 1, ...fields.map(field => xlsxCell(row.attributes[field]))]),
  });
}

export function tableXlsxFilename(layerName: string): string {
  const stem = layerName.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "attributes";
  return `${stem}_本页.xlsx`;
}

type FeatureCollectionLike = { type: "FeatureCollection"; features: unknown[]; bbox?: unknown; [key: string]: unknown };

/** Keep only the selected feature indices; never invent geometry or retain a stale bbox. */
export function selectedFeaturesGeoJson<T extends FeatureCollectionLike>(source: T, featureIds: number[]): T {
  if (source?.type !== "FeatureCollection" || !Array.isArray(source.features)) throw new Error("图层没有可导出的 GeoJSON 要素集合。");
  const selected = new Set(featureIds.filter(id => Number.isInteger(id) && id >= 0 && id < source.features.length));
  const features = source.features.filter((_, index) => selected.has(index));
  if (!features.length) throw new Error("没有可导出的已选要素。");
  const collection = { ...source, features } as T;
  delete collection.bbox;
  return collection;
}

export function selectedGeoJsonFilename(layerName: string): string {
  const stem = layerName.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "features";
  return `${stem}_已选.geojson`;
}

export function identifyGeoJsonFilename(layerName: string, featureId: number): string {
  const stem = layerName.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "feature";
  return `${stem}_要素${featureId + 1}.geojson`;
}
