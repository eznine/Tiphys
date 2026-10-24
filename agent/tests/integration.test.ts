import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { readEvents } from "../../src/lib/service.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function port() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
async function ready(url: string, child: ChildProcess, logs: () => string) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Service exited: ${logs()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not start: ${logs()}`);
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", () => resolve());
    });
  } else child.kill();
  await exited;
}

test("isolated engine + Agent: auth, buffer, approval ownership, reconnect, restart and unfinished-job recovery", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-integration-"));
  const enginePort = await port();
  const agentPort = await port();
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const agentUrl = `http://127.0.0.1:${agentPort}`;
  let token = "";
  const packaged = process.env.TIPHYS_TEST_PACKAGED === "1";
  const runtime = path.join(root, "src-tauri/runtime");
  const env = { ...process.env, TIPHYS_STATE_DIR: dir, TIPHYS_DATA_DIR: path.join(dir, "data"), TIPHYS_SERVICE_TOKEN: "",
    TIPHYS_LLM_PROVIDER: "mock", TIPHYS_ENGINE_URL: engineUrl, TIPHYS_ENGINE_PORT: String(enginePort),
    TIPHYS_PROJECT_ROOT: packaged ? runtime : root, TIPHYS_AGENT_PORT: String(agentPort),
    TIPHYS_DEMO_DELAY: "0", PYTHONDONTWRITEBYTECODE: "1" };
  let logs = "";
  const launch = (exe: string, args: string[], cwd: string) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", b => { logs = (logs + b).slice(-6000); });
    child.stderr?.on("data", b => { logs = (logs + b).slice(-6000); });
    return child;
  };
  const python = process.platform === "win32" ? path.join(root, "engine/.venv/Scripts/python.exe") : path.join(root, "engine/.venv/bin/python");
  const launchEngine = () => packaged
    ? launch(path.join(runtime, "tiphys-engine/tiphys-engine.exe"), [], runtime)
    : launch(python, ["-m", "uvicorn", "main:app", "--app-dir", "engine", "--host", "127.0.0.1", "--port", String(enginePort)], root);
  const launchAgent = () => packaged
    ? launch(path.join(runtime, "node.exe"), [path.join(runtime, "agent.mjs")], runtime)
    : launch(process.execPath, ["--import", "tsx", "src/server.ts"], path.join(root, "agent"));
  let engine: ChildProcess | undefined;
  let agent: ChildProcess | undefined;
  const controller = new AbortController();
  const events: any[] = [];
  const request = (route: string, body?: object, session = "test") => fetch(`${agentUrl}${route}?session=${session}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const wait = async (predicate: () => boolean) => {
    const end = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error(`Expected event missing: ${JSON.stringify(events.slice(-8))}\n${logs}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    engine = launchEngine();
    await ready(`${engineUrl}/ping`, engine, () => logs);
    token = fs.readFileSync(path.join(dir, "service-token"), "utf8").trim();
    assert.ok(token.length >= 32);
    agent = launchAgent();
    await ready(`${agentUrl}/health`, agent, () => logs);
    assert.equal((await fetch(`${engineUrl}/layers`)).status, 401);
    assert.equal((await fetch(`${agentUrl}/history`)).status, 401);
    assert.equal((await fetch(`${agentUrl}/bootstrap`, { headers: { Origin: "https://untrusted.example", "X-Tiphys-Client": "1" } })).status, 403);
    assert.equal((await fetch(`${agentUrl}/bootstrap`, { headers: { Origin: "http://localhost:1420", "X-Tiphys-Client": "1" } })).status, 200);
    const response = await fetch(`${agentUrl}/events?session=test`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    const reading = readEvents(response, e => events.push(e)).catch(err => { if (!controller.signal.aborted) throw err; });
    assert.equal((await request("/chat", { text: "给 samples 里的点做 500 米缓冲" })).status, 200);
    await wait(() => events.some(e => e.type === "layer-added" && e.fromJob));
    await wait(() => events.some(e => e.type === "turn-end"));
    const output = events.find(e => e.type === "layer-added" && e.fromJob).layer;
    assert.equal(output.feature_count, 5);
    assert.ok(fs.statSync(output.path).size > 0);
    assert.equal((await fetch(output.url, { headers: { Authorization: `Bearer ${token}` } })).status, 200);

    // The manual form uses authenticated REST; dispatch must match the MCP contract.
    const engineRequest = async (route: string, body?: object) => fetch(`${engineUrl}${route}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const manual = async (name: string, args: object) => {
      const response = await engineRequest("/tools/run", { name, arguments: args });
      assert.equal(response.status, 200, await response.clone().text());
      let result = await response.json();
      if (result.job_id) {
        const end = Date.now() + 10000;
        do {
          const state = await (await engineRequest(`/jobs/${result.job_id}`)).json();
          if (state.status === "completed") return state.result;
          assert.ok(["queued", "running"].includes(state.status), JSON.stringify(state));
          await new Promise(resolve => setTimeout(resolve, 30));
        } while (Date.now() < end);
        throw new Error(`Manual job did not settle: ${JSON.stringify(result)}`);
      }
      return result;
    };
    const catalog = await (await engineRequest("/tools/catalog")).json();
    // The Python sidecar catalog grew from 24 to 34 tools with the browser-era
    // additions; assert a floor plus the stable per-tool contracts below.
    assert.ok(catalog.tools.length >= 34, `expected at least 34 engine tools, got ${catalog.tools.length}`);
    assert.equal(catalog.tools.find((t: any) => t.name === "buffer").category, "邻近分析");
    assert.equal(catalog.tools.find((t: any) => t.name === "clip").category, "叠加分析");
    assert.equal(catalog.tools.find((t: any) => t.name === "remove_layer").annotations.destructiveHint, true);
    assert.equal((await fetch(`${engineUrl}/tools/catalog`)).status, 401);
    assert.equal((await engineRequest("/tools/run", { name: "buffer", arguments: { layer: output.id } })).status, 400);
    assert.equal((await engineRequest("/tools/run", { name: "set_layer_symbology", arguments: { layer: output.id, color: "guess", opacity: 4 } })).status, 400);
    const zoom = await manual("zoom_to_layer", { layer: output.id });
    assert.deepEqual(zoom.view.bounds, output.bounds);
    const labels = await manual("set_layer_labels", { layer: output.id, field: "name" });
    assert.equal(labels.view.style.labelField, "name");
    assert.equal((await engineRequest("/tools/run", { name: "set_layer_labels", arguments: { layer: output.id, field: "missing" } })).status, 400);
    assert.equal((await engineRequest("/tools/run", { name: "select_by_location", arguments: { layer: output.id, filter_layer: output.id, predicate: "guess" } })).status, 400);
    const hull = (await manual("convex_hull", { layer: output.id })).layer;
    const clipped = (await manual("clip", { layer: output.id, mask_layer: hull.id })).layer;
    assert.equal(clipped.feature_count, 5);
    const projection = (await manual("reproject", { layer: clipped.id, target_crs: "EPSG:3857" })).layer;
    const description = await manual("describe_layer", { layer: projection.id });
    assert.equal(description.crs, "EPSG:3857");
    const exportedPath = path.join(dir, "manual.geojson");
    const exported = await manual("export_features", { layer: projection.id, path: exportedPath });
    assert.equal(exported.feature_count, 5);
    assert.equal(JSON.parse(fs.readFileSync(exportedPath, "utf8")).features.length, 5);
    for (const layer of [projection, clipped, hull]) {
      assert.equal((await manual("remove_layer", { layer: layer.id })).removed, layer.id);
    }
    const fixture = { type: "FeatureCollection", features: Array.from({ length: 205 }, (_, i) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [116 + i * .00001, 40] },
      properties: { n: i, name: `记录${i}`, category: i % 2 ? "公园" : null },
    })) };
    const upload = await fetch(`${engineUrl}/layers/import?filename=table.geojson`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: JSON.stringify(fixture),
    });
    assert.equal(upload.status, 200);
    const uploaded = (await upload.json()).layer;
    const page = await (await engineRequest(`/layers/${uploaded.id}/attributes?offset=100&limit=100&sort=n&descending=true`)).json();
    assert.equal(page.total, 205);
    assert.equal(page.rows.length, 100);
    assert.equal(page.rows[0].attributes.n, 104);
    assert.equal(page.rows[0].id, 104);
    assert.equal(page.rows[0].bounds.length, 4);
    assert.ok(page.fields.some((f: any) => f.name === "category"));
    const filtered = await (await engineRequest(`/layers/${uploaded.id}/attributes?search=${encodeURIComponent("记录204")}`)).json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.rows[0].id, 204);
    const categories = await (await engineRequest(`/layers/${uploaded.id}/field-values?field=category`)).json();
    assert.equal(categories.unique_count, 2);
    assert.equal(categories.values.find((v: any) => v.value === null).count, 103);
    assert.equal((await engineRequest(`/layers/${uploaded.id}/attributes?sort=missing`)).status, 400);
    assert.equal((await engineRequest(`/layers/${uploaded.id}/attributes?limit=10000`)).status, 422);
    assert.equal((await fetch(`${engineUrl}/layers/${uploaded.id}/attributes`)).status, 401);
    await manual("remove_layer", { layer: uploaded.id });
    const logs = await (await request("/logs")).json();
    assert.ok(logs.entries.some((e: any) => e.source === "Engine" && e.kind === "tool-error"));
    assert.ok(logs.entries.some((e: any) => e.source === "Agent" && e.kind === "tool-call"));
    assert.equal(logs.diagnostics.engineReachable, true);
    assert.ok(!JSON.stringify(logs).includes(token));
    assert.equal((await fetch(`${agentUrl}/logs`)).status, 401);
    assert.equal((await request("/chat", { text: "删除最后一个图层" })).status, 200);
    await wait(() => events.some(e => e.type === "approval-request"));
    const approval = events.find(e => e.type === "approval-request");
    const pending = await (await request("/history")).json();
    assert.equal(pending.busy, true);
    const refreshController = new AbortController();
    const refreshResponse = await fetch(`${agentUrl}/events?session=test`, { headers: { Authorization: `Bearer ${token}` }, signal: refreshController.signal });
    const refreshEvents: any[] = [];
    const refreshRead = readEvents(refreshResponse, e => { refreshEvents.push(e); refreshController.abort(); }).catch(() => {});
    await refreshRead;
    assert.ok(refreshEvents[0].pendingApprovals.includes(approval.toolCallId));
    assert.equal((await request("/approve", { toolCallId: approval.toolCallId, approved: true }, "wrong-session")).status, 404);
    assert.equal((await request("/approve", { toolCallId: approval.toolCallId, approved: false })).status, 200);
    await wait(() => events.filter(e => e.type === "turn-end").length === 2);
    const cursor = events.filter(e => e.seq).at(-1).seq;
    controller.abort();
    await reading;
    assert.equal((await request("/chat", { text: "列出图层" })).status, 200);
    let history: any;
    const end = Date.now() + 10000;
    do {
      history = await (await fetch(`${agentUrl}/history?session=test&after=${cursor}`, { headers: { Authorization: `Bearer ${token}` } })).json();
      if (!history.busy && history.events.some((e: any) => e.type === "turn-end")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < end);
    assert.ok(history.events.every((e: any) => e.seq > cursor));
    assert.ok(history.events.some((e: any) => e.type === "turn-end"));
    await stop(agent);
    agent = launchAgent();
    await ready(`${agentUrl}/health`, agent, () => logs);
    const restored = await (await request("/history")).json();
    assert.equal(restored.busy, false);
    assert.ok(restored.workspace.layers.some((l: any) => l.id === output.id));
    await stop(engine);
    engine = launchEngine();
    await ready(`${engineUrl}/ping`, engine, () => logs);
    const layers = await (await fetch(`${engineUrl}/layers`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(layers.layers.some((l: any) => l.id === output.id));
    assert.equal((await request("/chat", { text: "删除最后一个图层" })).status, 200);
    let pendingAgain: any;
    const approvalEnd = Date.now() + 10000;
    do {
      pendingAgain = await (await request("/history")).json();
      if (pendingAgain.events.filter((e: any) => e.type === "approval-request").length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < approvalEnd);
    assert.equal(pendingAgain.busy, true);
    assert.equal((await request("/turn/cancel", {})).status, 200);
    const cancelEnd = Date.now() + 5000;
    let cancelled: any;
    do {
      cancelled = await (await request("/history")).json();
      if (!cancelled.busy) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < cancelEnd);
    assert.equal(cancelled.busy, false);
    assert.ok(cancelled.events.some((e: any) => e.type === "approval-expired"));
    assert.ok(cancelled.workspace.layers.some((l: any) => l.id === output.id));

    // Exercise an actual unfinished operation, rather than synthesizing a jobs.json record.
    await stop(engine);
    env.TIPHYS_DEMO_DELAY = "2";
    engine = launchEngine();
    await ready(`${engineUrl}/ping`, engine, () => logs);
    const previousBuffers = cancelled.events.filter((e: any) => e.type === "tool-result" && e.toolName === "buffer").length;
    assert.equal((await request("/chat", { text: "给 samples 里的点做 500 米缓冲" })).status, 200);
    let unfinished: any;
    const jobEnd = Date.now() + 10000;
    do {
      unfinished = await (await request("/history")).json();
      if (unfinished.events.filter((e: any) => e.type === "tool-result" && e.toolName === "buffer").length > previousBuffers) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < jobEnd);
    const runningCall = unfinished.events.filter((e: any) => e.type === "tool-result" && e.toolName === "buffer").at(-1);
    assert.ok(runningCall?.output?.job_id);
    const interruptedId = runningCall.output.job_id;
    const running = await (await fetch(`${engineUrl}/jobs/${interruptedId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(running.status, "running");
    const expectedLayers = unfinished.workspace.layers.map((layer: any) => layer.id).sort();
    const expectedJobs = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs.json"), "utf8")).map((job: any) => job.id).sort();
    await stop(agent);
    await stop(engine);
    env.TIPHYS_DEMO_DELAY = "0";
    engine = launchEngine();
    await ready(`${engineUrl}/ping`, engine, () => logs);
    agent = launchAgent();
    await ready(`${agentUrl}/health`, agent, () => logs);
    const recoveryController = new AbortController();
    const recoveryEvents: any[] = [];
    const recoveryDeadline = setTimeout(() => recoveryController.abort(), 10000);
    try {
      const recovery = await fetch(`${agentUrl}/events?session=test`, { headers: { Authorization: `Bearer ${token}` }, signal: recoveryController.signal });
      await readEvents(recovery, event => {
        recoveryEvents.push(event);
        if (event.type === "job" && event.jobId === interruptedId && event.status === "interrupted") recoveryController.abort();
      }).catch(err => { if (!recoveryController.signal.aborted) throw err; });
    } finally { clearTimeout(recoveryDeadline); }
    assert.ok(recoveryEvents.some(event => event.type === "job" && event.status === "interrupted"));
    const recovered = await (await request("/history")).json();
    assert.equal(recovered.busy, false);
    assert.ok(!recovered.workspace.pendingJobs.includes(interruptedId));
    assert.deepEqual(recovered.workspace.layers.map((layer: any) => layer.id).sort(), expectedLayers);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "data/jobs.json"), "utf8")).map((job: any) => job.id).sort(), expectedJobs);
  } finally {
    controller.abort();
    await stop(agent);
    await stop(engine);
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    // Windows can keep engine log/data handles open briefly after taskkill;
    // retry instead of failing the whole suite on cleanup.
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
      catch (err) { if (attempt >= 9 || (err as NodeJS.ErrnoException).code !== "EPERM") throw err; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
  }
});
