/**
 * Tool-call attribution for the model-in-the-loop baseline.
 *
 * The browser Agent can reach a WASM tool directly (`wasm_basins`) or through
 * the generic dispatcher (`run_browser_tool`). Success criteria name the
 * concrete tool id, so the evaluator must see both. Regression for M11, where
 * the product created basins and polygons but the gate reported "wasm_basins
 * not called" because the call arrived through the dispatcher.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calledTool, toolCallLabel, toolCallNames } from "../scripts/agent-tool-calls.ts";

test("direct curated WASM tool counts as itself", () => {
  const event = { type: "tool-call", toolName: "wasm_basins", input: {} };
  assert.deepEqual(toolCallNames(event), ["wasm_basins"]);
  assert.equal(calledTool([event], "wasm_basins"), true);
  assert.equal(toolCallLabel(event), "wasm_basins");
});

test("run_browser_tool attributes the inner tool id", () => {
  const event = { type: "tool-call", toolName: "run_browser_tool", input: { name: "wasm_basins", arguments: { d8_pntr: "lyr_d8" } } };
  assert.deepEqual(toolCallNames(event), ["run_browser_tool", "wasm_basins"]);
  assert.equal(calledTool([event], "wasm_basins"), true);
  assert.equal(calledTool([event], "wasm_d8_pointer"), false);
  assert.equal(toolCallLabel(event), "run_browser_tool(wasm_basins)");
});

test("desktop wasm_run maps its bare tool id to the wasm_ prefix", () => {
  const event = { type: "tool-call", toolName: "wasm_run", input: { tool: "basins", inputs: { d8_pntr: "lyr_d8" } } };
  assert.deepEqual(toolCallNames(event), ["wasm_run", "wasm_basins"]);
  assert.equal(calledTool([event], "wasm_basins"), true);
  assert.equal(toolCallLabel(event), "wasm_run(wasm_basins)");
});

test("run_plan attributes every tool step in the plan", () => {
  const event = {
    type: "tool-call",
    toolName: "run_plan",
    input: { plan: { goal: "流域", steps: [
      { id: "fill", kind: "tool", tool: "wasm_fill_depressions", args: {} },
      { id: "d8", kind: "tool", tool: "wasm_d8_pointer", args: {} },
      { id: "basins", kind: "tool", tool: "wasm_basins", args: {} },
      { id: "poly", kind: "tool", tool: "wasm_raster_to_vector_polygons", args: {} },
      { id: "dupe", kind: "tool", tool: "wasm_basins", args: {} },
      { id: "op", kind: "operation", spec: { operation: "gis.buffer" } },
    ] } },
  };
  assert.deepEqual(toolCallNames(event), [
    "run_plan",
    "wasm_fill_depressions",
    "wasm_d8_pointer",
    "wasm_basins",
    "wasm_raster_to_vector_polygons",
  ]);
  assert.equal(calledTool([event], "wasm_basins"), true);
  assert.match(toolCallLabel(event), /^run_plan\(wasm_fill_depressions,wasm_d8_pointer,wasm_basins,/);
});

test("attribution ignores malformed and unrelated events", () => {
  const events = [
    { type: "tool-result", toolName: "wasm_basins", input: {} },
    { type: "tool-call", toolName: "search_browser_tools", input: { query: "basins" } },
    { type: "tool-call", toolName: "run_browser_tool", input: { name: 42 } },
    { type: "tool-call", input: { name: "wasm_basins" } },
    null,
  ];
  assert.equal(calledTool(events as any, "wasm_basins"), false);
  assert.deepEqual(toolCallNames(events[3]), []);
  assert.equal(toolCallLabel(events[3] as any), "");
});

test("attribution works across a full M11-style trace", () => {
  const events = [
    { type: "tool-call", toolName: "inspect_layers", input: {} },
    { type: "tool-call", toolName: "search_browser_tools", input: { query: "流域" } },
    { type: "tool-call", toolName: "hydrology_flow_pipeline", input: { layer: "dem" } },
    { type: "tool-call", toolName: "run_browser_tool", input: { name: "wasm_basins", arguments: {} } },
    { type: "tool-call", toolName: "run_browser_tool", input: { name: "wasm_raster_to_vector_polygons", arguments: {} } },
  ];
  const called = new Set(events.flatMap(toolCallNames));
  for (const expected of ["wasm_basins", "wasm_raster_to_vector_polygons", "hydrology_flow_pipeline"]) {
    assert.equal(called.has(expected), true, expected);
  }
});
