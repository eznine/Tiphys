/**
 * Desktop agent → WASM bridge.
 *
 * The desktop sidecar reaches the geolibre/Whitebox catalog through one child
 * process per job. The child is the isolation boundary: a WASM trap kills it,
 * not the sidecar, and cancellation is a real process kill.
 *
 * Discovery and execution both come from the same frozen manifest. Callers get
 * exact wire names, kinds, required flags, enums and defaults; we never invent a
 * parameter or silently drop a required input. Multi-input tools stage every
 * named input under its manifest name, and every declared output gets a unique
 * file name so callers can bind the result back to the parameter that produced
 * it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIPHYS_DIR } from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "wasm-cli.mjs");
const CATALOG = path.join(ROOT, "src", "lib", "browser", "wasm-catalog.json");

type ManifestParam = {
  name: string;
  io_role?: string | null;
  data_kind?: string | null;
  description?: string | null;
  required?: boolean;
  schema?: {
    kind?: string;
    cardinality?: string;
    scalar?: string;
    options?: Array<{ value?: unknown; label?: unknown }>;
    dataset?: { kind?: string; geometry?: string };
  } | null;
};

type Manifest = {
  id: string;
  display_name?: string;
  summary?: string;
  tags?: string[];
  taxonomy?: { category?: string; subcategory?: string };
  params: ManifestParam[];
  defaults?: Record<string, unknown>;
};

export type WasmOutputFile = { file: string; path: string; bytes: number };

export type WasmNamedOutput = {
  name: string;
  kind: string;
  path: string;
  bytes: number;
  geojsonPath?: string;
};

export type WasmRunResult = {
  ok: boolean;
  tool: string;
  cancelled: boolean;
  durationMs: number;
  exitCode: number | null;
  /** Every file the child actually wrote, including converted GeoJSON. */
  outputs: WasmOutputFile[];
  /** Outputs keyed by the manifest wire name that declared them. */
  namedOutputs: WasmNamedOutput[];
  /** First vector output converted to WGS84 GeoJSON, ready for add_data. */
  geojsonPath?: string;
  /** Vector output wire name → converted GeoJSON path. */
  geojsonPaths?: Record<string, string>;
  error?: string;
  stdout?: string;
};

export type WasmParamCard = {
  name: string;
  kind: string;
  required: boolean;
  description?: string;
  default?: unknown;
  options?: unknown[];
  cardinality?: string;
};

export type WasmToolCard = {
  id: string;
  display_name: string;
  summary: string;
  category?: string;
  subcategory?: string;
  tags: string[];
  inputs: WasmParamCard[];
  parameters: WasmParamCard[];
  outputs: WasmParamCard[];
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
const OUTPUT_EXTENSIONS: Record<string, string> = {
  vector: "fgb", raster: "tif", file: "tif", table: "csv", json: "json", text: "txt",
};

// Search aliases are deliberately narrow: they connect user language to a
// real catalog id, never manufacture a capability the manifest does not have.
const SEARCH_ALIASES: Record<string, string[]> = {
  slope: ["坡度", "斜率", "地形坡度"],
  aspect: ["坡向", "方位角"],
  hillshade: ["山体阴影", "晕渲", "阴影图"],
  basins: ["流域", "盆地", "汇水区", "d8_pntr", "d8 pointer", "d8流向"],
  zonal_statistics: ["分区统计", "区域统计", "分区统计栅格"],
  add: ["栅格相加", "相加", "加和", "raster add"],
  raster_to_vector_polygons: ["栅格转面", "转成面", "转为面", "转面", "生成面", "面图层", "栅格面化"],
  raster_to_vector_lines: ["栅格转线", "转成线", "转为线", "线图层"],
  raster_to_vector_points: ["栅格转点", "转成点", "转为点", "点图层"],
  fill_depressions: ["填洼", "洼地填充", "depression fill"],
  breach_depressions_least_cost: ["填洼", "洼地", "breach"],
  flow_accumulation: ["汇流累积量", "流量累积", "flow accumulation"],
  flow_direction: ["流向", "d8", "flow direction"],
  watershed: ["流域", "集水区", "watershed"],
};

function extensionOf(file: string) {
  return path.extname(file).replace(/^\./, "").toLowerCase() || "bin";
}

function kindOf(param: ManifestParam) {
  return String(param.data_kind ?? param.schema?.dataset?.kind ?? param.schema?.kind ?? "unknown");
}

function outputExtension(param: ManifestParam) {
  return OUTPUT_EXTENSIONS[kindOf(param)] ?? "dat";
}

function cardOf(manifest: Manifest, param: ManifestParam): WasmParamCard {
  const options = (param.schema?.options ?? []).map(option => option.value).filter(value => value !== undefined);
  return {
    name: param.name,
    kind: kindOf(param),
    required: Boolean(param.required),
    ...(param.description ? { description: param.description } : {}),
    ...(manifest.defaults?.[param.name] !== undefined ? { default: manifest.defaults[param.name] } : {}),
    ...(options.length ? { options } : {}),
    ...(param.schema?.cardinality ? { cardinality: param.schema.cardinality } : {}),
  };
}

export function wasmToolCard(tool: string): WasmToolCard {
  const manifest = loadManifests().find(entry => entry.id === tool);
  if (!manifest) throw new Error(`未知 WASM 工具：${tool}。先用 wasm_search 确认工具 id。`);
  return {
    id: manifest.id,
    display_name: manifest.display_name ?? manifest.id,
    summary: manifest.summary ?? "",
    ...(manifest.taxonomy?.category ? { category: manifest.taxonomy.category } : {}),
    ...(manifest.taxonomy?.subcategory ? { subcategory: manifest.taxonomy.subcategory } : {}),
    tags: manifest.tags ?? [],
    inputs: manifest.params.filter(param => param.io_role === "input").map(param => cardOf(manifest, param)),
    parameters: manifest.params.filter(param => !param.io_role).map(param => cardOf(manifest, param)),
    outputs: manifest.params.filter(param => param.io_role === "output").map(param => cardOf(manifest, param)),
  };
}

function searchableText(manifest: Manifest) {
  return [
    manifest.id,
    manifest.display_name,
    manifest.summary,
    manifest.taxonomy?.category,
    manifest.taxonomy?.subcategory,
    ...(manifest.tags ?? []),
    ...(SEARCH_ALIASES[manifest.id] ?? []),
    ...manifest.params.flatMap(param => [param.name, param.description, kindOf(param)]),
  ].filter(Boolean).join(" ").toLowerCase().normalize("NFKC");
}

function scoreTool(manifest: Manifest, query: string, tokens: string[]) {
  const id = manifest.id.toLowerCase();
  const text = searchableText(manifest);
  let score = 0;
  if (id === query) score += 120;
  else if (id.startsWith(query)) score += 60;
  else if (id.includes(query)) score += 36;
  for (const token of tokens) {
    if (id === token) score += 80;
    else if (id.includes(token)) score += 26;
    if ((SEARCH_ALIASES[manifest.id] ?? []).some(alias => alias.toLowerCase().includes(token))) score += 24;
    if (manifest.params.some(param => param.name.toLowerCase() === token || param.name.toLowerCase().includes(token))) score += 18;
    if (text.includes(token)) score += 8;
  }
  return score;
}

/** Real catalog search. Returns compact schema cards, including exact wire names. */
export function searchWasmTools(
  queryText: string,
  options: { limit?: number; inputKind?: string; outputKind?: string } = {},
) {
  const query = String(queryText ?? "").trim().toLowerCase().normalize("NFKC");
  if (!query) throw new Error("wasm_search 需要 query，例如“坡度”或“d8_pntr”。");
  const tokens = query.split(/[\s,，;；/]+/).filter(Boolean);
  const limit = Math.max(1, Math.min(Number(options.limit ?? 8), 20));
  const inputKind = options.inputKind?.toLowerCase();
  const outputKind = options.outputKind?.toLowerCase();
  const matches = loadManifests()
    .filter(manifest => !inputKind || manifest.params.some(param => param.io_role === "input" && kindOf(param) === inputKind))
    .filter(manifest => !outputKind || manifest.params.some(param => param.io_role === "output" && kindOf(param) === outputKind))
    .map(manifest => ({ manifest, score: scoreTool(manifest, query, tokens) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.manifest.id.localeCompare(b.manifest.id));
  return {
    ok: true,
    query,
    total: matches.length,
    returned: Math.min(limit, matches.length),
    tools: matches.slice(0, limit).map(match => wasmToolCard(match.manifest.id)),
    hint: "Run with wasm_run. Use the exact input wire names in `inputs`; workspace layer ids/names are resolved to analysis files.",
  };
}

/** Manifest description used by tests and callers that need the full contract. */
export function describeWasmTool(tool: string) {
  const manifest = loadManifests().find(entry => entry.id === tool);
  if (!manifest) throw new Error(`未知 WASM 工具：${tool}。先用 wasm_search 确认工具 id。`);
  const inputs = manifest.params.filter(param => param.io_role === "input");
  const outputs = manifest.params.filter(param => param.io_role === "output");
  if (!outputs.length) throw new Error(`${tool} 没有声明输出参数，不能通过 wasm_run 运行。`);
  return { manifest, inputs, outputs, input: inputs[0], output: outputs[0] };
}

function stateRoot(explicit?: string) {
  return explicit || path.join(TIPHYS_DIR, "wasm-runs");
}

export async function runWasmTool(options: {
  tool: string;
  /** Backward-compatible single-input form. */
  inputPath?: string;
  /** Exact manifest input wire name → local analysis file. */
  inputs?: Record<string, string>;
  params?: Record<string, unknown>;
  stateDir?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<WasmRunResult> {
  const started = Date.now();
  const { manifest, inputs: declaredInputs, outputs: declaredOutputs } = describeWasmTool(options.tool);
  const providedInputs = { ...(options.inputs ?? {}) };
  if (options.inputPath !== undefined) {
    if (declaredInputs.length !== 1) {
      throw new Error(`${options.tool} 需要 ${declaredInputs.length} 个输入；请用 inputs 按名称绑定：${declaredInputs.map(param => param.name).join("、")}。`);
    }
    providedInputs[declaredInputs[0].name] = options.inputPath;
  }

  const knownInputs = new Set(declaredInputs.map(param => param.name));
  const unknownInputs = Object.keys(providedInputs).filter(name => !knownInputs.has(name));
  if (unknownInputs.length) {
    throw new Error(`工具 ${options.tool} 不认识输入：${unknownInputs.join("、")}。可用输入：${[...knownInputs].join("、") || "无"}。`);
  }
  const missingInputs = declaredInputs.filter(param => param.required && !providedInputs[param.name]);
  if (missingInputs.length) {
    throw new Error(`工具 ${options.tool} 缺少必填输入：${missingInputs.map(param => param.name).join("、")}。请用 inputs 绑定文件或工作区图层。`);
  }

  const knownParams = new Set(manifest.params.map(param => param.name));
  const unknownParams = Object.keys(options.params ?? {}).filter(name => !knownParams.has(name));
  if (unknownParams.length) {
    throw new Error(`工具 ${options.tool} 不认识参数：${unknownParams.join("、")}。可用参数：${[...knownParams].join("、")}。`);
  }

  const runId = `wasm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const outputDir = path.join(stateRoot(options.stateDir), runId);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new Error(`无法创建 WASM 运行目录 ${outputDir}：${err instanceof Error ? err.message : String(err)}。请把 TIPHYS_STATE_DIR 指向可写目录。`);
  }
  const jobFile = path.join(outputDir, "job.json");
  const resultFile = path.join(outputDir, "result.json");

  const args: string[] = [];
  const files: Record<string, string> = {};
  for (const param of declaredInputs) {
    const provided = providedInputs[param.name];
    if (!provided) continue;
    const analysisPath = path.resolve(provided);
    if (!fs.existsSync(analysisPath)) throw new Error(`输入文件不存在（${param.name}）：${analysisPath}`);
    const stagedName = `${param.name}.${extensionOf(analysisPath)}`;
    files[stagedName] = analysisPath;
    args.push(`--${param.name}=/work/${stagedName}`);
  }

  const defaults = manifest.defaults ?? {};
  for (const param of manifest.params) {
    if (param.io_role) continue;
    const value = options.params?.[param.name] ?? defaults[param.name];
    if (value === undefined || value === null || value === "") continue;
    args.push(`--${param.name}=${value}`);
  }

  const outputFiles = new Map<string, string>();
  for (const param of declaredOutputs) {
    const file = `${param.name}.${outputExtension(param)}`;
    outputFiles.set(param.name, file);
    args.push(`--${param.name}=/work/${file}`);
  }

  const convertToGeojson = declaredOutputs.some(param => kindOf(param) === "vector");
  try {
    fs.writeFileSync(jobFile, JSON.stringify({
      tool: options.tool, args, files, outputDir, convertToGeojson, resultPath: resultFile,
    }));
  } catch (err) {
    throw new Error(`无法写入 WASM 作业文件 ${jobFile}：${err instanceof Error ? err.message : String(err)}`);
  }

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
        outputs: [], namedOutputs: [], ...patch,
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
      const filesOut = (parsed.files ?? []) as WasmOutputFile[];
      const namedOutputs = declaredOutputs.map(param => {
        const declaredName = outputFiles.get(param.name)!;
        const actual = filesOut.find(file => file.file === declaredName)
          ?? filesOut.find(file => path.parse(file.file).name === param.name);
        const converted = filesOut.find(file => file.file.endsWith(".geojson") && path.parse(file.file).name === param.name);
        return {
          name: param.name,
          kind: kindOf(param),
          path: actual?.path ?? "",
          bytes: actual?.bytes ?? 0,
          ...(converted?.path ? { geojsonPath: converted.path } : {}),
        };
      });
      const geojsonPaths = Object.fromEntries(namedOutputs.filter(output => output.geojsonPath).map(output => [output.name, output.geojsonPath!]));
      finish({
        ok: Boolean(parsed.ok), exitCode: parsed.exitCode ?? code, outputs: filesOut,
        namedOutputs, ...(Object.keys(geojsonPaths).length ? { geojsonPaths } : {}),
        geojsonPath: Object.values(geojsonPaths)[0], stdout: parsed.stdout,
        error: parsed.ok ? undefined : parsed.error ?? `exit ${parsed.exitCode ?? code}`,
      });
    });
  });
}
