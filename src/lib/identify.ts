export type IdentifyTableFilter = { layerId: string; field: string; value: unknown };

/** Text used for copying and for the definition-query value prefilled by Identify. */
export function identifyValueText(value: unknown): string {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function tsvCell(value: unknown): string {
  return identifyValueText(value).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/** Copy all properties as a two-row TSV (field names, then values). */
export function identifyPropertiesTsv(properties: Record<string, unknown>): string {
  const fields = Object.keys(properties);
  if (!fields.length) return "";
  return [fields.map(tsvCell).join("\t"), fields.map(field => tsvCell(properties[field])).join("\t")].join("\n");
}
