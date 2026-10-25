/**
 * True XLSX export for the visible attribute-table page. The writer is a small
 * OOXML package built with fflate; no second spreadsheet dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { buildXlsxSheet } from "../src/lib/xlsx.ts";
import { tablePageXlsx, tableXlsxFilename } from "../src/lib/table-export.ts";

test("xlsx package contains the required OOXML parts and a data sheet", () => {
  const bytes = buildXlsxSheet({
    name: "属性",
    headers: ["记录", "name", "pop", "ok", "note"],
    rows: [[1, "天安门", 10, true, "=SUM(1,2)"], [2, null, null, false, "a&b"]],
  });
  const entries = unzipSync(bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/styles.xml"]) {
    assert.ok(entries[name], `missing ${name}`);
  }
  const sheet = strFromU8(entries["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /天安门/);
  assert.match(sheet, /<c r="C2"><v>10<\/v><\/c>/);
  assert.match(sheet, /<c r="D2" t="b"><v>1<\/v><\/c>/);
  assert.match(sheet, /&apos;=SUM\(1,2\)/);
  assert.match(sheet, /a&amp;b/);
  assert.match(strFromU8(entries["xl/workbook.xml"]), /name="属性"/);
});

test("table page export preserves record IDs and filename", () => {
  const bytes = tablePageXlsx({
    fields: [{ name: "name", type: "string" }, { name: "pop", type: "integer" }],
    rows: [{ id: 4, attributes: { name: "故宫", pop: 20 } }],
  });
  const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /<c r="A2"><v>5<\/v><\/c>/);
  assert.match(sheet, /故宫/);
  assert.equal(tableXlsxFilename("道路/分区"), "道路_分区_本页.xlsx");
});
