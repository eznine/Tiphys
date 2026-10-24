/**
 * Method-card tests.
 *
 * These check the cards as data, not as prose: required fields, real tool ids,
 * unique triggers, and the promise that a card never advertises an operation the
 * support matrix marks unsupported on every engine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { METHOD_CARDS, findMethods, methodById } from "../src/lib/methods.ts";
import { OPERATION_IDS, operationSupport } from "../shared/contracts/index.ts";

const shellIds = new Set((JSON.parse(fs.readFileSync(new URL("../src/lib/browser/catalog.json", import.meta.url), "utf8")) as { name: string }[]).map(tool => tool.name));
const wasmIds = new Set((JSON.parse(fs.readFileSync(new URL("../src/lib/browser/wasm-catalog.json", import.meta.url), "utf8")) as { id: string }[]).map(tool => tool.id));

test("there are at least eight cards and every field carries content", () => {
  assert.ok(METHOD_CARDS.length >= 8, `only ${METHOD_CARDS.length} cards`);
  const ids = new Set<string>();
  for (const card of METHOD_CARDS) {
    assert.ok(!ids.has(card.id), `duplicate id ${card.id}`);
    ids.add(card.id);
    assert.ok(card.title.length > 2, card.id);
    assert.ok(card.triggers.length >= 3, `${card.id} needs triggers`);
    assert.ok(card.preconditions.length >= 1, `${card.id} needs preconditions`);
    assert.ok(card.antiPatterns.length >= 1, `${card.id} needs anti-patterns`);
    assert.ok(card.acceptance.length >= 2, `${card.id} needs acceptance rules`);
    assert.ok(card.positiveExample.query && card.positiveExample.toolId, card.id);
    assert.ok(card.negativeExample.why.length > 8, `${card.id} negative example needs a why`);
  }
});

test("every cited tool exists in the real catalogs", () => {
  const exists = (toolId: string) => shellIds.has(toolId) || wasmIds.has(toolId.replace(/^wasm_/, ""));
  for (const card of METHOD_CARDS) {
    assert.ok(exists(card.positiveExample.toolId), `${card.id} cites unknown tool ${card.positiveExample.toolId}`);
    if (card.negativeExample.toolId) {
      assert.ok(exists(card.negativeExample.toolId), `${card.id} negative example cites ${card.negativeExample.toolId}`);
    }
  }
});

test("contract-backed cards use real operation ids and honour the support matrix", () => {
  for (const card of METHOD_CARDS.filter(item => item.operation)) {
    assert.ok(OPERATION_IDS.includes(card.operation!), `${card.id} has unknown operation ${card.operation}`);
    const verdicts = [operationSupport(card.operation!, "browser-wasm"), operationSupport(card.operation!, "desktop-python")];
    assert.ok(verdicts.some(verdict => verdict.supported),
      `${card.id} describes ${card.operation} but no engine supports it; the card would teach a lie`);
  }
  // The dissolve card must not pretend the browser can do it.
  const dissolve = methodById("dissolve-group");
  assert.match(dissolve!.antiPatterns.join(" "), /浏览器端/);
});

test("triggers retrieve the right method without tool search", () => {
  assert.equal(findMethods("给这些点做 800 米缓冲")[0]?.id, "buffer-distance");
  assert.equal(findMethods("按类型把这三个区融合成一个面")[0]?.id, "dissolve-group");
  assert.equal(findMethods("统计每个行政区内的平均高程")[0]?.id, "zonal-stats");
  assert.equal(findMethods("从这个 DEM 提取河网和流域")[0]?.id, "dem-hydrology");
  assert.deepEqual(findMethods("今天天气不错"), []);
});