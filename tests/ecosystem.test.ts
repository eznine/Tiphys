import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseAprx, parseCimJson, scanMxd } from "../src/lib/ecosystem/arcgisProject.ts";
import { esriToGeojson } from "../src/lib/ecosystem/geojson.ts";
import { overpassToGeojson } from "../src/lib/ecosystem/openData.ts";
import { classifyUrl } from "../src/lib/ecosystem/index.ts";
import { arcgisItemId } from "../src/lib/ecosystem/arcgisRest.ts";

const fx = (n: string) => new URL(`./fixtures/ecosystem/${n}`, import.meta.url);

test("aprx: recovers maps, layers, gdb sources and colours", () => {
  const p = parseAprx(new Uint8Array(fs.readFileSync(fx("city.aprx"))));
  assert.deepEqual(p.maps, ["城市地图"]);
  const pts = p.layers.find(l => l.name === "示例点")!;
  assert.equal(pts.dataset, "pts"); assert.equal(pts.workspace, "..\\data\\test.gdb"); assert.equal(pts.color, "#e60000");
  assert.equal(p.layers.find(l => l.name === "示例面")!.color, "#005ce6");
  assert.equal(p.layers.length, 3);
});
test("lyrx: feature service layer resolves to layer URL", () => {
  const p = parseCimJson(fs.readFileSync(fx("countries.lyrx"), "utf8"), "lyrx");
  assert.equal(p.layers.length, 1);
  assert.equal(p.layers[0].kind, "service");
  assert.match(p.layers[0].url!, /FeatureServer\/0$/);
  assert.equal(p.layers[0].color, "#38a800");
});
test("mxd: UTF-16 path scan", () => {
  const text = "\u0000junk C:\\data\\city.gdb\\roads and \\\\server\\share\\parcels.shp https://x.com/arcgis/rest/services/A/MapServer/3 end";
  const buf = Buffer.from(text, "utf16le");
  const p = scanMxd(new Uint8Array(buf));
  assert.ok(p.layers.some(l => l.workspace?.endsWith("city.gdb")));
  assert.ok(p.layers.some(l => l.workspace?.endsWith("parcels.shp")));
  assert.ok(p.layers.some(l => l.url?.endsWith("MapServer/3")));
});
test("esri json → geojson incl. polygon holes", () => {
  const fc = esriToGeojson({ features: [
    { attributes: { a: 1 }, geometry: { x: 1, y: 2 } },
    { attributes: {}, geometry: { paths: [[[0, 0], [1, 1]]] } },
    { attributes: {}, geometry: { rings: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]] } },
  ] });
  assert.equal(fc.features[0].geometry!.type, "Point");
  assert.equal(fc.features[1].geometry!.type, "LineString");
  assert.equal(fc.features[2].geometry!.type, "Polygon");
  assert.equal((fc.features[2].geometry as any).coordinates.length, 2);
});
test("overpass → geojson", () => {
  const fc = overpassToGeojson({ elements: [
    { type: "node", id: 1, lat: 1, lon: 2, tags: { amenity: "cafe" } },
    { type: "way", id: 2, tags: { building: "yes" }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }] },
    { type: "way", id: 3, tags: { highway: "primary" }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
  ] });
  assert.deepEqual(fc.features.map(f => f.geometry!.type), ["Point", "Polygon", "LineString"]);
  assert.equal(fc.features[0].properties.osm_id, "node/1");
});
test("url classification", () => {
  assert.equal(classifyUrl("https://a.com/arcgis/rest/services/X/FeatureServer/0"), "arcgis-rest");
  assert.equal(classifyUrl("https://www.arcgis.com/home/item.html?id=0123456789abcdef0123456789abcdef"), "arcgis-item");
  assert.equal(classifyUrl("https://t.example.com/{z}/{x}/{y}.png"), "xyz");
  assert.equal(classifyUrl("https://ows.example.com/geoserver/wms?service=WMS"), "wms");
  assert.equal(classifyUrl("https://x.com/data.geojson"), "file");
  assert.deepEqual(arcgisItemId("https://www.arcgis.com/apps/mapviewer/index.html?webmap=0123456789abcdef0123456789abcdef"), { portal: "https://www.arcgis.com", id: "0123456789abcdef0123456789abcdef" });
});
