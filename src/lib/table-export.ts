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
