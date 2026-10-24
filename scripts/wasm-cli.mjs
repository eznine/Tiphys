#!/usr/bin/env node
/**
 * One geolibre WASI tool, one process — the executor behind `wasm_run`.
 *
 * Why a child process: a WASM trap (`RuntimeError: unreachable`) poisons the
 * whole instance (stage-0 finding D2), so in-process execution would take the
 * agent sidecar down with it. A child gives us isolation for free and gives the
 * parent a real cancellation primitive (terminate the process).
 *
 * Protocol: argv[2] is a JSON job file:
 *   { tool, args: string[], files: { "input.fgb": "/abs/path" },
 *     outputDir, convertToGeojson?: boolean, resultPath }
 * The child writes each tool output file into outputDir, optionally converts a
 * vector output to GeoJSON with `vector_convert`, and writes a JSON result to
 * resultPath. Nothing is parsed from stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initTools, runTool } from "geolibre-wasm/tools";
import initLibrary from "geolibre-wasm";

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const wasmRoot = process.env.TIPHYS_WASM_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "geolibre-wasm");
const result = { ok: false, exitCode: null, stdout: "", files: [], error: null };

try {
  await initTools(fs.readFileSync(path.join(wasmRoot, "geolibre-cli.wasm")));
  await initLibrary({ module_or_path: fs.readFileSync(path.join(wasmRoot, "geolibre_wasm_bg.wasm")) });
  const input = Object.fromEntries(Object.entries(job.files ?? {}).map(([name, file]) => [name, new Uint8Array(fs.readFileSync(file))]));
  const started = Date.now();
  const toolResult = await runTool(job.tool, { args: job.args ?? [], input });
  result.exitCode = toolResult.exitCode;
  result.durationMs = Date.now() - started;
  result.stdout = (toolResult.stdout ?? []).join("\n").slice(-4000);
  result.stderr = (toolResult.stderr ?? []).join("\n").slice(-4000);
  fs.mkdirSync(job.outputDir, { recursive: true });
  for (const [name, bytes] of Object.entries(toolResult.files ?? {})) {
    const out = path.join(job.outputDir, path.basename(name));
    fs.writeFileSync(out, bytes);
    result.files.push({ file: path.basename(name), path: out, bytes: bytes.length });
  }
  result.ok = toolResult.exitCode === 0 && result.files.length > 0;
  if (!result.ok && !result.error) result.error = `exit ${toolResult.exitCode}`;

  if (job.convertToGeojson && result.ok) {
    const vectorExts = ["fgb", "gpkg", "shp", "geojson"];
    const source = result.files.find(entry => vectorExts.includes(entry.file.split(".").pop().toLowerCase()));
    if (source) {
      const converted = await runTool("vector_convert", {
        args: [`--input=/work/${source.file}`, "--output=/work/converted.geojson"],
        input: { [source.file]: new Uint8Array(fs.readFileSync(source.path)) },
      });
      const bytes = converted.files?.["converted.geojson"];
      if (converted.exitCode === 0 && bytes?.length) {
        const out = path.join(job.outputDir, "converted.geojson");
        // RFC 7946: a GeoJSON file is WGS84 by definition. The WASI converter
        // writes lon/lat without a `crs` member; state it so add_data cannot
        // mistake the file for an unknown-CRS dataset (it refuses to guess).
        const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
        parsed.crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } };
        fs.writeFileSync(out, JSON.stringify(parsed));
        result.files.push({ file: "converted.geojson", path: out, bytes: fs.statSync(out).size });
      } else {
        result.error = `vector_convert failed: ${(converted.stdout ?? []).join(" ").slice(-400)}`;
      }
    }
  }
} catch (err) {
  result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
fs.mkdirSync(path.dirname(job.resultPath), { recursive: true });
fs.writeFileSync(job.resultPath, JSON.stringify(result));
process.exit(result.ok ? 0 : 1);