/**
 * Stage 1 acceptance demo for T-003: one WASM GIS operation executed by the
 * desktop agent's bridge, then opened by the desktop Python engine as a layer.
 *
 * Steps, all real:
 *   1. reproject the frozen points fixture to UTM 50N with the WASM CLI;
 *   2. buffer 500 m with the WASM CLI (child process per run);
 *   3. hand the resulting GeoJSON to the Python LayerStore (the same code path
 *      add_data uses) and assert the layer it publishes;
 *   4. record timings and the exact commands so another developer can redo it.
 *
 * Usage: npm run wasm:spike
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWasmTool } from "../agent/src/wasm.ts";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const OUT = path.join(ROOT, "docs", "baselines", "stage1", "wasm-spike.json");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "bj_points.geojson");

const steps: Record<string, unknown>[] = [];
const started = Date.now();

const projected = await runWasmTool({ tool: "reproject_vector", inputPath: FIXTURE, params: { epsg: 32650 } });
steps.push({ step: "reproject_vector", ok: projected.ok, ms: projected.durationMs, outputs: projected.outputs.map(o => o.file), error: projected.error });
if (!projected.ok) throw new Error(`reproject failed: ${projected.error}`);
const projectedFgb = projected.outputs.find(output => output.file.endsWith(".fgb"));
if (!projectedFgb) throw new Error("reproject produced no FlatGeobuf");

const buffered = await runWasmTool({ tool: "buffer_vector", inputPath: projectedFgb.path, params: { distance: 500 } });
steps.push({ step: "buffer_vector", ok: buffered.ok, ms: buffered.durationMs, outputs: buffered.outputs.map(o => o.file), error: buffered.error });
if (!buffered.ok || !buffered.geojsonPath) throw new Error(`buffer failed: ${buffered.error}`);

const python = process.platform === "win32" ? "engine/.venv/Scripts/python.exe" : "engine/.venv/bin/python";
const opened = spawnSync(python, [path.join(ROOT, "scripts", "engine-add-layer.py"), buffered.geojsonPath], { cwd: ROOT, encoding: "utf8", windowsHide: true });
if (opened.status !== 0) throw new Error(`python add_data failed: ${opened.stderr?.slice(-800)}`);
const result = JSON.parse(opened.stdout);
steps.push({ step: "python add_data + inspect", ok: true, layer: result.layer.id, featureCount: result.layer.feature_count, crs: result.layer.crs, dataLocation: result.data_location });

const ok = result.layer.feature_count === 3 && String(result.layer.crs).toUpperCase() === "EPSG:4326" && Boolean(result.layer.url);
const summary = {
  generatedAt: new Date().toISOString(),
  totalMs: Date.now() - started,
  verdict: ok ? "PASS" : "FAIL",
  selection: {
    chosen: "Node → WASI shim in a child process (agent sidecar)",
    rejected: "WebView → WASM bridge",
    why: [
      "the agent loop already lives in Node; no new postMessage protocol or IndexedDB duplication",
      "file IO is the natural interface for the 958 file-based WASI tools",
      "one child per run gives crash isolation and process-kill cancellation that the WebView bridge cannot",
      "cost: the UI must add the output via add_data, and WASM work is not visible in the existing browser job cards",
    ],
  },
  steps,
  assertion: { featureCount: result.layer.feature_count, crs: result.layer.crs, url: result.layer.url, sha256: result.sha256 },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
for (const step of steps) console.log(`  ${String(step.step).padEnd(28)} ok=${step.ok} ${step.ms ? `${step.ms} ms` : ""}`);
console.log(`\n${summary.verdict}: WASM buffer -> GeoJSON -> desktop layer ${result.layer.id} (${result.layer.feature_count} features, ${result.layer.crs})`);
process.exitCode = ok ? 0 : 1;