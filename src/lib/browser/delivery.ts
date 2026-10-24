const OUTPUT_FILE = /(?:^|[\s`"'(（/\\“”‘’：:])([\p{L}\p{N}_.-]+\.(geojson|gpkg|fgb|csv))(?=$|[\s`"',，。；;“”‘’）)】\]])/iu;
const EXPORT_REQUEST = /\b(?:save|export|write|output|produce|deliver)\b|保存|导出|写入|产出|输出/i;

export type RequestedExport = { filename: string; format: "geojson" | "gpkg" | "fgb" | "csv" };

/** Detect an explicit filename deliverable without guessing a path from vague prose. */
export function requestedExport(text: string): RequestedExport | null {
  if (!EXPORT_REQUEST.test(text)) return null;
  const match = OUTPUT_FILE.exec(text);
  if (!match) return null;
  const extension = match[2].toLowerCase();
  return { filename: match[1], format: extension === "geojson" ? "geojson" : extension as RequestedExport["format"] };
}
