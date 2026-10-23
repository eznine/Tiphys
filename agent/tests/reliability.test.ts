import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/session.js";
import { emptyWorkspace, maybeCompact, readToolOutput, spillIfLarge } from "../src/context.js";
import { reduce, type AgentState } from "../../src/lib/agent.ts";
import { syncDataLayers } from "../../src/lib/dataLayers.ts";
import { readEvents } from "../../src/lib/service.ts";

const initial = (): AgentState => ({ items: [], layers: [], busy: false, connected: true, provider: "mock", focus: null });

test("mixed geometry always gets filtered fill, line and point representations", () => {
  const sources = new Map();
  const layers = new Map();
  const visibility = new Map();
  const map: any = {
    isStyleLoaded: () => true, getStyle: () => ({ sources: Object.fromEntries(sources), layers: [...layers.values()] }),
    getSource: (id: string) => sources.get(id), addSource: (id: string, value: any) => sources.set(id, value),
    getLayer: (id: string) => layers.get(id), addLayer: (value: any) => layers.set(value.id, value),
    setLayoutProperty: (id: string, key: string, value: any) => visibility.set(id, value),
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
