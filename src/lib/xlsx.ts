/**
 * Minimal, dependency-free XLSX writer.
 *
 * The product already bundles fflate, so a table export does not need a second
 * spreadsheet library. This writes a single-sheet OOXML workbook with inline
 * strings, numeric/boolean cells, a bold header and a frozen header row. It is
 * intentionally small: formulas, styles beyond the header and multiple sheets
 * are out of scope.
 */
import { strToU8, zipSync } from "fflate";

export type XlsxValue = string | number | boolean | null | undefined;
export type XlsxSheet = {
  name: string;
  headers: string[];
  rows: XlsxValue[][];
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellXml(reference: string, value: XlsxValue, style?: number): string {
  const styleAttr = style ? ` s="${style}"` : "";
  if (value == null) return `<c r="${reference}"${styleAttr}/>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${styleAttr}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}"${styleAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = String(value);
  // Keep spreadsheet formula injection inert; inline strings are text, but the
  // leading apostrophe also preserves the same safety as the CSV exporter.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(safe)}</t></is></c>`;
}

function rowXml(index: number, values: XlsxValue[], style?: number): string {
  return `<row r="${index}">${values.map((value, column) => cellXml(`${columnName(column)}${index}`, value, style)).join("")}</row>`;
}

function sheetName(value: string): string {
  return (value.trim().replace(/[\\/?*[\]:]+/g, "_").slice(0, 31) || "Sheet1");
}

export function buildXlsxSheet(sheet: XlsxSheet): Uint8Array<ArrayBuffer> {
  if (!sheet.headers.length) throw new Error("Excel 导出至少需要一个字段。");
  const name = sheetName(sheet.name);
  const rows = [rowXml(1, sheet.headers, 1), ...sheet.rows.map((row, index) => rowXml(index + 2, row))];
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>${rows.join("")}</sheetData>
</worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  return new Uint8Array(zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/styles.xml": strToU8(styles),
  }, { level: 6 }));
}
