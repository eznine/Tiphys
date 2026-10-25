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
import { buildBrowserSystemPrompt } from "../src/lib/browser/prompt.ts";
import { OPERATION_IDS, operationSupport } from "../shared/contracts/index.ts";

const shellIds = new Set((JSON.parse(fs.readFileSync(new URL("../src/lib/browser/catalog.json", import.meta.url), "utf8")) as { name: string }[]).map(tool => tool.name));
const wasmIds = new Set((JSON.parse(fs.readFileSync(new URL("../src/lib/browser/wasm-catalog.json", import.meta.url), "utf8")) as { id: string }[]).map(tool => tool.id));

test("there are at least ten cards and every field carries content", () => {
  assert.ok(METHOD_CARDS.length >= 10, `only ${METHOD_CARDS.length} cards`);
  const ids = new Set<string>();
  for (const card of METHOD_CARDS) {
    assert.ok(!ids.has(card.id), `duplicate id ${card.id}`);
    ids.add(card.id);
    assert.ok(card.title.length > 2, card.id);
    assert.ok(card.triggers.length >= 3, `${card.id} needs triggers`);
    assert.ok(card.preconditions.length >= 1, `${card.id} needs preconditions`);
    assert.ok(card.guardrails.length >= 1, `${card.id} needs guardrails`);
    for (const guardrail of card.guardrails) {
      assert.ok(["crs", "units", "overlay-double-count", "nodata", "predicate"].includes(guardrail.kind), `${card.id} has unknown guardrail ${guardrail.kind}`);
      assert.ok(guardrail.check.length > 12, `${card.id}/${guardrail.kind} needs a concrete check`);
      assert.ok(guardrail.next.length > 8, `${card.id}/${guardrail.kind} needs a next action`);
    }
    assert.ok(card.antiPatterns.length >= 1, `${card.id} needs anti-patterns`);
    assert.ok(card.acceptance.length >= 2, `${card.id} needs acceptance rules`);
    assert.ok(card.positiveExample.query && card.positiveExample.toolId, card.id);
    assert.ok(card.negativeExample.why.length > 8, `${card.id} negative example needs a why`);
  }
});

test("method knowledge covers CRS, units and overlay double-count guardrails", () => {
  const kinds = new Set(METHOD_CARDS.flatMap(card => card.guardrails.map(item => item.kind)));
  for (const required of ["crs", "units", "overlay-double-count"]) assert.ok(kinds.has(required as never), `missing ${required} guardrail`);

  const overlay = methodById("overlay-double-count");
  assert.ok(overlay);
  assert.deepEqual(new Set(overlay!.guardrails.map(item => item.kind)), new Set(["crs", "units", "overlay-double-count"]));
  assert.match(overlay!.guardrails.find(item => item.kind === "overlay-double-count")!.check, /源 id|唯一源|去重/);
  assert.match(overlay!.guardrails.find(item => item.kind === "units")!.check, /m²|km²|单位/);
});

test("every cited tool exists in the real catalogs", () => {
  const exists = (toolId: string) => shellIds.has(toolId) || wasmIds.has(toolId.replace(/^wasm_/, ""));
  for (const card of METHOD_CARDS) {
    assert.ok(exists(card.positiveExample.toolId), `${card.id} cites unknown tool ${card.positiveExample.toolId}`);
    if (card.negativeExample.toolId) {
      assert.ok(exists(card.negativeExample.toolId), `${card.id} negative example cites ${card.negativeExample.toolId}`);
    }
    for (const toolId of card.workflow ?? []) {
      assert.ok(exists(toolId), `${card.id} workflow cites unknown tool ${toolId}`);
    }
  }
});

test("the hydrology card carries the verified watershed-to-polygon chain", () => {
  assert.deepEqual(methodById("dem-hydrology")?.workflow, [
    "wasm_fill_depressions",
    "wasm_d8_pointer",
    "wasm_basins",
    "wasm_raster_to_vector_polygons",
  ]);
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
  assert.equal(findMethods("两个图层求交后的重叠面积和面积汇总，避免重复计算")[0]?.id, "overlay-double-count");
  assert.deepEqual(findMethods("今天天气不错"), []);
});

test("retrieved guardrails are injected into the browser system prompt", () => {
  const methods = findMethods("两个图层求交后的重叠面积和面积汇总，避免重复计算");
  const prompt = buildBrowserSystemPrompt([], {}, "", methods);
  assert.match(prompt, /\[overlay-double-count\]/);
  assert.match(prompt, /\[units\]/);
  assert.match(prompt, /\[crs\]/);
  assert.match(prompt, /否则：/);
});

test("the hydrology workflow is injected as names, not as parameter values", () => {
  const prompt = buildBrowserSystemPrompt([], {}, "", findMethods("从这个 DEM 提取河网和流域"));
  assert.match(prompt, /wasm_fill_depressions → wasm_d8_pointer → wasm_basins → wasm_raster_to_vector_polygons/);
  assert.match(prompt, /先用 search_browser_tools 核对参数卡/);
  assert.match(prompt, /不要凭名字猜参数/);
});
