/**
 * Desktop agent → WASM bridge (stage 1 spike, T-003).
 *
 * The desktop agent could not reach any of the 958 WASM tools because it only
 * speaks MCP to Python. This module gives it one honest entry: run a named
 * geolibre tool on a local file, in a child process, and return the files it
 * actually wrote. The child is what makes isolation and cancellation real:
 * a WASM trap kills the child, not the sidecar, and cancelling means killing it.
 *
 * Deliberately NOT done here:
 * - no invented parameters: only the manifest defaults plus caller overrides;
 * - no multi-input tools yet (the spike covers the single-input case and says so);
 * - no claiming a layer is "on the map": the caller must add the GeoJSON output
 *   through the normal add_data path, which is what the tool description says.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "wasm-cli.mjs");
const CATALOG = path.join(ROOT, "src", "lib", "browser", "wasm-catalog.json");

export type WasmRunResult = {
  ok: boolean;
  tool: string;
  cancelled: boolean;
  durationMs: number;
  exitCode: number | null;
  outputs: { file: string; path: string; bytes: number }[];
  /** GeoJSON output ready for add_data, when the tool produced vector data. */
  geojsonPath?: string;
  error?: string;
  stdout?: string;
};

type Manifest = {
  id: string;
  params: { name: string; io_role?: string | null; data_kind?: string | null; required?: boolean }[];
  defaults?: Record<string, unknown>;
};

let manifests: Manifest[] | null = null;
function loadManifests(): Manifest[] {
  if (!manifests) {
    const parsed = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
    manifests = (Array.isArray(parsed) ? parsed : parsed.tools ?? parsed.manifests ?? []) as Manifest[];
  }
  return manifests;
}

const VECTOR_EXTENSIONS = new Set(["fgb", "gpkg", "shp", "geojson", "json"]);

function extensionOf(file: string) {
  return path.extname(file).replace(/^\./, "").toLowerCase() || "bin";
}

/** Locates the tool, its single input and its output parameter, or explains why not. */
export function describeWasmTool(tool: string) {
  const manifest = loadManifests().find(entry => entry.id === tool);
  if (!manifest) throw new Error(`未知 WASM 工具：${tool}。先用工具箱搜索确认工具 id。`);
  const inputs = manifest.params.filter(param => param.io_role === "input");
  const outputs = manifest.params.filter(param => param.io_role === "output");
  if (inputs.length !== 1) throw new Error(`wasm_run 目前只支持单输入工具；${tool} 有 ${inputs.length} 个输入。`);
  if (!outputs.length) throw new Error(`${tool} 没有声明输出参数。`);
  return { manifest, input: inputs[0], output: outputs[0] };
}

export async function runWasmTool(options: {
  tool: string;
  inputPath: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<WasmRunResult> {
  const started = Date.now();
  const { manifest, input, output } = describeWasmTool(options.tool);
  const inputPath = path.resolve(options.inputPath);
  if (!fs.existsSync(inputPath)) throw new Error(`输入文件不存在：${inputPath}`);
  const inputExtension = extensionOf(inputPath);
  const vector = input.data_kind === "vector" || (input.data_kind !== "raster" && VECTOR_EXTENSIONS.has(inputExtension));
  const outputExtension = vector ? "fgb" : "tif";

  const known = new Set(manifest.params.map(param => param.name));
  const unknown = Object.keys(options.params ?? {}).filter(name => !known.has(name));
  if (unknown.length) {
    throw new Error(`工具 ${options.tool} 不认识参数：${unknown.join("、")}。可用参数：${[...known].join("、")}。`);
  }

  const runId = `wasm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const outputDir = path.join(os.homedir(), ".tiphys", "wasm-runs", runId);
  fs.mkdirSync(outputDir, { recursive: true });
  const jobFile = path.join(outputDir, "job.json");
  const resultFile = path.join(outputDir, "result.json");
  const inputFile = `${input.name}.${inputExtension}`;
  const outputFile = `${output.name}.${outputExtension}`;

  const args: string[] = [`--${input.name}=/work/${inputFile}`, `--${output.name}=/work/${outputFile}`];
  const defaults = manifest.defaults ?? {};
  const reserved = new Set([input.name, output.name]);
  for (const param of manifest.params) {
    if (reserved.has(param.name)) continue;
    const value = options.params?.[param.name] ?? defaults[param.name];
    if (value === undefined || value === null || value === "") continue;
    args.push(`--${param.name}=${value}`);
  }

  fs.writeFileSync(jobFile, JSON.stringify({
    tool: options.tool, args, files: { [inputFile]: inputPath }, outputDir,
    convertToGeojson: vector, resultPath: resultFile,
  }));

  return await new Promise<WasmRunResult>(resolve => {
    const child = spawn(process.execPath, [CLI, jobFile], { cwd: ROOT, stdio: "ignore", windowsHide: true });
    let settled = false;
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (patch: Partial<WasmRunResult>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        ok: false, tool: options.tool, cancelled, durationMs: Date.now() - started, exitCode: null,
        outputs: [], ...patch,
      });
    };
    const onAbort = () => { cancelled = true; child.kill(); };
    if (options.signal?.aborted) { cancelled = true; child.kill(); }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { cancelled = true; child.kill(); }, options.timeoutMs ?? 120_000);
    child.once("error", err => finish({ error: err.message }));
    child.once("exit", code => {
      if (cancelled) return finish({ cancelled: true, error: "已取消：子进程被终止。" });
      let parsed: any = null;
      try { parsed = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch { /* reported below */ }
      if (!parsed) return finish({ exitCode: code, error: `WASM 子进程未写出结果（exit ${code}）。` });
      const geojson = parsed.files?.find((file: { file: string }) => file.file.endsWith(".geojson"));
      finish({
        ok: Boolean(parsed.ok), exitCode: parsed.exitCode ?? code, outputs: parsed.files ?? [],
        geojsonPath: geojson?.path, stdout: parsed.stdout,
        error: parsed.ok ? undefined : parsed.error ?? `exit ${parsed.exitCode ?? code}`,
      });
    });
  });
}