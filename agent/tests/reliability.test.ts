import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/session.js";
import { emptyWorkspace, maybeCompact, readToolOutput, spillIfLarge } from "../src/context.js";
import { reduce, type AgentState } from "../../src/lib/agent.ts";
import { syncDataLayers, defaultLayerStyle } from "../../src/lib/dataLayers.ts";
import { readEvents } from "../../src/lib/service.ts";
import { redact, eventLogEntries } from "../src/diagnostics.ts";

const initial = (): AgentState => ({ items: [], layers: [], busy: false, connected: true, provider: "mock", focus: null });

test("historical model changes cannot override the currently connected provider", () => {
  const state = reduce({ ...initial(), provider: "openai-compatible:current-model" }, { type: "snapshot", reset: true,
    events: [{ type: "model-config", seq: 1, provider: "mock", model: "old-model" }], cursor: 1, busy: false, workspace: emptyWorkspace(), pendingApprovals: [] });
  assert.equal(state.provider, "openai-compatible:current-model");
  assert.equal(reduce(state, { type: "model-config", seq: 2, provider: "openai-compatible", model: "new-model" }).provider, "openai-compatible:new-model");
});

test("diagnostics redact credentials recursively and retain actionable failures", () => {
  const secret = "test-private-credential";
  const scrubbed = redact({ apiKey: secret, nested: [{ text: `failed: ${secret}`, Authorization: "Bearer hidden" }],
    raw: "Bearer abc123 sk-private-key", tool: "buffer" }, [secret]);
  const serialized = JSON.stringify(scrubbed);
  assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes("abc123")); assert.ok(!serialized.includes("sk-private-key"));
  assert.equal(scrubbed.tool, "buffer");
  const entries = eventLogEntries([{ type: "text-delta", seq: 1, text: "noise" }, { type: "tool-error", seq: 2, toolName: "buffer", error: "bad CRS" }]);
  assert.equal(entries.length, 1); assert.equal(entries[0].level, "error"); assert.equal(entries[0].summary, "buffer");
});

test("mixed geometry always gets filtered fill, line and point representations", () => {
  const sources = new Map();
  const layers = new Map();
  const visibility = new Map();
  const map: any = {
    isStyleLoaded: () => true, getStyle: () => ({ sources: Object.fromEntries(sources), layers: [...layers.values()] }),
    getSource: (id: string) => sources.get(id), addSource: (id: string, value: any) => sources.set(id, value),
    getLayer: (id: string) => layers.get(id), addLayer: (value: any) => layers.set(value.id, value),
    setLayoutProperty: (id: string, key: string, value: any) => visibility.set(id, value),
    setPaintProperty: () => {},
    removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id),
  };
  const layer = { id: "lyr_test", name: "mixed", url: "http://localhost/test", geometry_types: ["LineString", "Point", "Polygon"], feature_count: 3, bounds: null };
  syncDataLayers(map, [layer]);
  assert.deepEqual([...layers.values()].map(l => l.type), ["fill", "line", "circle"]);
  assert.ok([...layers.values()].every(l => l.filter[1][0] === "geometry-type"));
  syncDataLayers(map, [{ ...layer, visible: false }]);
  assert.ok([...visibility.values()].every(v => v === "none"));
  syncDataLayers(map, []);
  assert.equal(layers.size, 0);
  assert.equal(sources.size, 0);
});

test("refresh keeps live approval and real busy state; reconnect events are idempotent", () => {
  const events = [{ type: "user", seq: 1, ts: 1, text: "delete" },
    { type: "approval-request", seq: 2, toolCallId: "call_1", toolName: "remove_layer", input: {} }];
  const snapshot = { type: "snapshot", reset: true, events, cursor: 2, busy: true, workspace: emptyWorkspace(), pendingApprovals: ["call_1"] };
  let state = reduce(initial(), snapshot);
  assert.equal(state.busy, true);
  assert.equal((state.items[1] as any).state, "pending");
  state = reduce(state, events[0]);
  assert.equal(state.items.length, 2);
  state = reduce(state, { ...snapshot, reset: false, events: [], pendingApprovals: [], busy: false });
  assert.equal((state.items[1] as any).state, "expired");
  assert.equal(state.busy, false);
});

test("changing symbols updates existing sources and labels follow layer visibility", () => {
  const sources = new Map(); const layers = new Map(); const paint = new Map(); const layout = new Map();
  const map: any = {
    isStyleLoaded: () => true, getStyle: () => ({ sources: Object.fromEntries(sources), layers: [...layers.values()], glyphs: "fonts" }),
    getSource: (id: string) => sources.get(id), addSource: (id: string, value: any) => sources.set(id, value),
    getLayer: (id: string) => layers.get(id), addLayer: (value: any) => layers.set(value.id, value),
    setPaintProperty: (id: string, name: string, value: unknown) => paint.set(`${id}:${name}`, value),
    setLayoutProperty: (id: string, name: string, value: unknown) => layout.set(`${id}:${name}`, value),
    removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id),
  };
  const layer = { id: "lyr_style", name: "source", url: "/layer", geometry_types: ["Point"], feature_count: 1, bounds: null };
  syncDataLayers(map, [layer]);
  const source = sources.get("tiphys-lyr_style");
  const style = { ...defaultLayerStyle(layer.id), color: "#123456", pointSize: 9, labelField: "name" };
  syncDataLayers(map, [{ ...layer, style }]);
  assert.equal(sources.get("tiphys-lyr_style"), source);
  // Paint values are selection-aware case expressions; the fallback branch is
  // the configured style.
  const circleColor = paint.get("tiphys-lyr_style-pt:circle-color") as unknown[];
  const circleRadius = paint.get("tiphys-lyr_style-pt:circle-radius") as unknown[];
  assert.equal(circleColor.at(-1), "#123456");
  assert.equal(circleRadius.at(-1), 9);
  assert.ok(layers.has("tiphys-lyr_style-label"));
  syncDataLayers(map, [{ ...layer, style, visible: false }]);
  assert.equal(layout.get("tiphys-lyr_style-label:visibility"), "none");
  syncDataLayers(map, [{ ...layer, style: { ...style, labelField: undefined } }]);
  assert.equal(layers.has("tiphys-lyr_style-label"), false);
  syncDataLayers(map, []);
  assert.equal(sources.size, 0); assert.equal(layers.size, 0);
});

test("Agent view commands preserve the transcript and reach the UI state", () => {
  let state = reduce(initial(), { type: "view-command", seq: 1, command: { action: "zoom", layer_id: "lyr_test", bounds: [116, 40, 117, 41] } });
  assert.equal(state.viewCommands?.[0].action, "zoom");
  assert.deepEqual(state.viewCommands?.[0].bounds, [116, 40, 117, 41]);
  for (const [i, action] of ["attributes", "labels", "style"].entries()) state = reduce(state, { type: "view-command", seq: i + 2, command: { action, layer_id: "lyr_test" } });
  // React may render once for an entire SSE batch: every action must survive.
  assert.deepEqual(state.viewCommands?.map(command => command.action), ["zoom", "attributes", "labels", "style"]);
  state = reduce(state, { type: "view-command", seq: 4, command: { action: "style", layer_id: "lyr_test" } });
  assert.equal(state.viewCommands?.length, 4);
  assert.equal(state.items.length, 0);
});

test("SSE parser handles split UTF-8 and CRLF without losing or duplicating events", async () => {
  const text = ': ping\r\n\r\nid: 1\r\ndata: {"type":"notice","text":"测试"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events: any[] = [];
  await readEvents(new Response(stream), event => events.push(event));
  assert.deepEqual(events, [{ type: "notice", text: "测试" }]);
});

test("an interrupted response does not absorb text from the next turn", () => {
  let state = initial();
  for (const event of [
    { type: "user", seq: 1, text: "first" }, { type: "text-delta", seq: 2, text: "partial first" },
    { type: "turn-end", seq: 3, interrupted: true }, { type: "user", seq: 4, text: "second" },
    { type: "text-delta", seq: 5, text: "new answer" },
  ]) state = reduce(state, event);
  assert.deepEqual(state.items.filter(item => item.kind === "msg" && item.role === "agent").map(item => (item as any).text), ["partial first", "new answer"]);
});

test("context budget failure preserves messages rather than silently truncating requests", async () => {
  const messages: any[] = [{ role: "user", content: "x".repeat(10000) }];
  const original = JSON.stringify(messages);
  await assert.rejects(maybeCompact(messages, "", 1000, emptyWorkspace()), /context budget/);
  assert.equal(JSON.stringify(messages), original);
});

test("checkpoint restore retains messages, separates events and reports interrupted turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-session-test-"));
  try {
    const session = new Session("test", dir);
    session.messages.push({ role: "user", content: "keep this decision" });
    session.append({ type: "user", text: "keep this decision" });
    session.checkpoint();
    await session.close();
    assert.ok(!fs.readFileSync(session.file, "utf8").includes('"type":"checkpoint"'));
    const restored = new Session("test", dir);
    assert.equal(restored.messages[0].content, "keep this decision");
    assert.equal(restored.events().at(-1)?.type, "turn-end");
    assert.equal(restored.events(1).length, 2);
    await restored.close();
  } finally {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("compaction includes assistant decisions, tool failures and a complete retrievable archive", async () => {
  const messages: any[] = [{ role: "user", content: "Constraint: preserve original CRS " + "x".repeat(6000) },
    { role: "assistant", content: "Decision: use NONE dissolve" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "buffer", output: { type: "error-text", value: "bad projection" } }] },
    { role: "user", content: "continue" }];
  let source: any;
  const result = await maybeCompact(messages, "", 1800, emptyWorkspace(), async old => {
    source = old;
    return "Preserve original CRS. Confirmed dissolve=NONE. Buffer failed: bad projection. Do not retry unchanged.";
  });
  assert.ok(result.compacted);
  assert.match(JSON.stringify(source), /Decision: use NONE/);
  assert.match(result.summary!, /bad projection/);
  const id = result.summary!.match(/spill_id=([a-f0-9]{32})/)![1];
  const first = readToolOutput(id, 0, 6000);
  const rest = first.next_offset === null ? "" : readToolOutput(id, first.next_offset, 6000).text;
  assert.match(first.text + rest, /bad projection/);
});

test("spilled outputs are readable and reject arbitrary file paths", () => {
  const result: any = spillIfLarge("../../untrusted-id", { text: "a".repeat(9000) }, 100);
  assert.match(result.spill_id, /^[a-f0-9]{32}$/);
  assert.equal(readToolOutput(result.spill_id, 0, 100).next_offset, 100);
  assert.throws(() => readToolOutput("../../secret"));
  assert.throws(() => readToolOutput(result.spill_id, -1));
});
