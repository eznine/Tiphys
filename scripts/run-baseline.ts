/**
 * Fixed TIPHYS baseline runner (roadmap §4 stage 0, task 3/4).
 *
 * Engine mode (default) replays every task's reference step sequence against the
 * real browser WASM engine, then evaluates programmatic assertions and records
 * artifacts (hashes, feature counts, CRS, dims). This is the reference half of
 * the baseline: it tells us whether the *engine contract* still holds.
 *
 * Every task runs in its own child process: a WASM panic poisons the shared
 * instance for the rest of the process (observed with flatgeobuf), and a
 * baseline must not let one failing task corrupt the next one.
 *
 * Agent mode (--agent) is not implemented headlessly yet: the browser agent loop
 * needs DOM/Worker/object-URL semantics, so it belongs in the Playwright harness
 * planned for stage 4. Running with --agent exits 2 instead of inventing scores.
 *
 *   node --import ./agent/node_modules/tsx/dist/loader.mjs scripts/run-baseline.ts
 *   ... --only=S02,M09 --repeat=3 --json=.tiphys/baseline.json
 */
import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { initTools } from "geolibre-wasm/tools";
import initLibrary from "geolibre-wasm";
import { importBrowserFile, readBrowserJob, runBrowserTool, cancelBrowserJob, browserLayers, browserEngineRequest } from "../src/lib/browser/engine.ts";
import { readRecord } from "../src/lib/browser/storage.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = path.resolve(import.meta.filename);
const TASKS_PATH = path.join(ROOT, "tests", "baseline", "tasks.json");
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage0");
const LOADER = path.join(ROOT, "agent", "node_modules", "tsx", "dist", "loader.mjs");

type Step = { import?: string; import_download?: string; tool?: string; http?: { method?: string; path: string }; args?: Record<string, unknown>;
  capture?: string; expect_error?: boolean; allow_error?: boolean; cancel_immediately?: boolean };
type Check = { type: string; of?: string; severity?: "gate" | "known_gap"; note?: string; checks?: Check[]; [key: string]: unknown };
type Task = { id: string; group: string; title: string; prompt: string; endpoints: string[]; automation: string;
  expected_tools: string[]; steps: Step[]; checks: Check[]; [key: string]: unknown };
type Capture = { raw: any; layer?: any; error?: string; http?: any; job?: string };
type RunResult = { task: string; group: string; title: string; run: number; status: "PASS" | "WARN" | "FAIL" | "ERROR";
  duration_ms: number; fatal?: string; steps: any[]; checks: any[]; artifacts: any[]; layer_count: { before: number; after: number } };

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find(item => item === `--${name}`) !== undefined;
const value = (name: string) => argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const isChild = process.env.TIPHYS_BASELINE_CHILD === "1";
const only = value("only")?.split(",").filter(Boolean);
const repeat = Number(value("repeat") ?? 1);
const single = value("single");
const outFile = value("out");
const jsonOut = value("json");

if (flag("agent")) {
  console.error("agent 模式的基线尚未实现：浏览器 Agent 循环依赖 DOM/Worker/object URL，需在 Playwright 真机测试环境中运行（阶段 4）。\n"
    + "本次不生成任何模型成功率，避免把“没跑”写成“通过”。请使用默认 engine 模式。");
  process.exit(2);
}

const sha256 = (input: Buffer | Uint8Array | string) => crypto.createHash("sha256").update(input as any).digest("hex");
const tasksFile = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8")) as { fixtures: Record<string, string>; tasks: Task[] };
const rad = (deg: number) => deg * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function lookup(target: any, dotted: string): any {
  return dotted.split(".").reduce((value, key) => value == null ? undefined : value[key], target);
}
function resolveArgs(input: unknown, captures: Map<string, Capture>): unknown {
  if (typeof input === "string" && input.startsWith("@")) {
    const id = captures.get(input.slice(1))?.layer?.id;
    if (!id) throw new Error(`capture ${input.slice(1)} has no layer id`);
    return id;
  }
  if (Array.isArray(input)) return input.map(item => resolveArgs(item, captures));
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, resolveArgs(item, captures)]));
  }
  return input;
}
async function waitJob(jobId: string, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const job = await readBrowserJob(jobId);
    if (!["running", "queued", "cancelling"].includes(job.status)) {
      if (job.status !== "completed") throw new Error(job.error || job.message || `job ${job.status}`);
      return job.result;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`job timeout after ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function runTask(task: Task): Promise<RunResult[]> {
  const runs: RunResult[] = [];
  for (let run = 1; run <= repeat; run++) {
    const captures = new Map<string, Capture>();
    const steps: any[] = [];
    const started = Date.now();
    const layersBefore = (await browserLayers()).length;
    let fatal: string | undefined;

    for (const [index, step] of task.steps.entries()) {
      const stepStart = Date.now();
      const record: any = { step: index + 1, kind: step.import ? "import" : step.http ? "http" : "tool",
        name: step.import ?? step.import_download ?? step.http?.path ?? step.tool, ok: false, duration_ms: 0 };
      try {
        if (step.import || step.import_download) {
          const relative = step.import ? tasksFile.fixtures[step.import] : step.import_download!;
          const bytes = step.import ? fs.readFileSync(path.join(ROOT, relative)) : (await readRecord<any>(`download:${relative}`))?.bytes;
          if (!bytes) throw new Error(`download ${relative} not found`);
          const imported = await importBrowserFile(new Blob([new Uint8Array(bytes)]), path.basename(relative));
          record.layer = imported.layer;
          if (step.capture) captures.set(step.capture, { raw: imported, layer: imported.layer });
          record.ok = true;
        } else if (step.http) {
          const target = step.http.path.replace(/@([\w-]+)/g, (_match, name) => {
            const id = captures.get(name)?.layer?.id;
            if (!id) throw new Error(`capture ${name} has no layer id`);
            return id;
          });
          const response = await browserEngineRequest(target, { method: step.http.method ?? "GET" });
          const body = await response.json();
          record.summary = body;
          if (step.capture) captures.set(step.capture, { raw: body, http: body });
          record.ok = true;
        } else {
          const toolArgs = resolveArgs(step.args ?? {}, captures) as Record<string, unknown>;
          if (step.cancel_immediately) {
            const layersBeforeStep = (await browserLayers()).length;
            const created = await runBrowserTool(step.tool!, toolArgs);
            if (!created.job_id) throw new Error("tool did not return a job id");
            await cancelBrowserJob(created.job_id);
            let status = await readBrowserJob(created.job_id);
            for (let attempt = 0; attempt < 600 && ["running", "queued", "cancelling"].includes(status.status); attempt++) {
              await new Promise(resolve => setTimeout(resolve, 10));
              status = await readBrowserJob(created.job_id);
            }
            const layerCount = { before: layersBeforeStep, after: (await browserLayers()).length };
            record.job = status.status;
            record.summary = { job: status.status, error: status.error ?? null, layerCount };
            if (step.capture) captures.set(step.capture, { raw: { job: status.status, error: status.error, layerCount }, job: status.status });
            record.ok = true;
          } else {
            try {
              const created = await runBrowserTool(step.tool!, toolArgs);
              const result = created.job_id ? await waitJob(created.job_id, 180_000) : created;
              const layer = result?.layer ?? result?.layers?.[0]?.layer;
              record.layer = layer;
              record.summary = { feature_count: layer?.feature_count, bytes: result?.bytes, ok: result?.ok };
              if (step.capture) captures.set(step.capture, { raw: result, layer });
              record.ok = true;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (step.expect_error || step.allow_error) {
                record.error = message;
                if (step.capture) captures.set(step.capture, { raw: { error: message }, error: message });
                record.ok = true;
              } else throw error;
            }
          }
        }
      } catch (error) {
        fatal = error instanceof Error ? error.message : String(error);
        record.error = fatal;
      }
      record.duration_ms = Date.now() - stepStart;
      steps.push(record);
      if (fatal) break;
    }

    const layersAfter = (await browserLayers()).length;
    const duration = Date.now() - started;
    const checks: any[] = [];

    const evaluate = async (check: Check): Promise<{ ok: boolean; detail: string }> => {
      const capture = check.of ? captures.get(check.of) : undefined;
      const layer = capture?.layer;
      switch (check.type) {
        case "feature_count": {
          if (!layer) return { ok: false, detail: `capture ${check.of} has no layer` };
          const n = Number(layer.feature_count), op = String(check.op ?? "eq"), expected = Number(check.value);
          const ok = op === "gte" ? n >= expected : op === "lte" ? n <= expected : n === expected;
          return { ok, detail: `feature_count=${n} ${op} ${expected}` };
        }
        case "crs": return { ok: layer?.crs === check.value, detail: `crs=${layer?.crs}` };
        case "geometry_types": {
          const types: string[] = layer?.geometry_types ?? [];
          const contains = (check.contains as string[] | undefined) ?? [];
          const excludes = (check.excludes as string[] | undefined) ?? [];
          return { ok: contains.every(item => types.includes(item)) && excludes.every(item => !types.includes(item)),
            detail: `geometry_types=${types.join(",") || "none"}` };
        }
        case "field_exists": {
          const field = String(check.field);
          let ok = capture?.raw != null && Object.prototype.hasOwnProperty.call(capture.raw, field);
          if (!ok && layer) {
            const record = await readRecord<any>(`layer:${layer.id}`);
            ok = Object.prototype.hasOwnProperty.call(record?.geojson?.features?.[0]?.properties ?? {}, field);
          }
          return { ok, detail: `field ${field} ${ok ? "present" : "missing"}` };
        }
        case "field_value": {
          const found = lookup(capture?.raw, String(check.field));
          return { ok: found === check.value, detail: `${check.field}=${JSON.stringify(found)}` };
        }
        case "stats": {
          const found = lookup(capture?.raw, String(check.metric));
          const tol = Number(check.tol ?? 0);
          return { ok: typeof found === "number" && Math.abs(found - Number(check.value)) <= tol,
            detail: `${check.metric}=${found} (expected ${check.value}±${tol})` };
        }
        case "numeric": {
          const record = layer ? await readRecord<any>(`layer:${layer.id}`) : undefined;
          const found = record?.geojson?.features?.[Number(check.index ?? 0)]?.properties?.[String(check.field)];
          return { ok: typeof found === "number" && Math.abs(found - Number(check.value)) <= Number(check.tol ?? 0), detail: `${check.field}=${found}` };
        }
        case "between": {
          const record = layer ? await readRecord<any>(`layer:${layer.id}`) : undefined;
          const found = record?.geojson?.features?.[Number(check.index ?? 0)]?.properties?.[String(check.field)];
          return { ok: typeof found === "number" && found >= Number(check.min) && found <= Number(check.max),
            detail: `${check.field}=${found} in [${check.min}, ${check.max}]` };
        }
        case "buffer_radius": {
          const source = captures.get(String(check.source))?.layer;
          if (!layer || !source) return { ok: false, detail: "missing source or buffer layer" };
          const sourceRecord = await readRecord<any>(`layer:${source.id}`);
          const bufferRecord = await readRecord<any>(`layer:${layer.id}`);
          const points = new Map<string, number[]>();
          for (const feature of sourceRecord.geojson.features) {
            if (feature.geometry?.type === "Point") points.set(String(feature.properties?.id ?? points.size), feature.geometry.coordinates);
          }
          let worst = 0, checked = 0;
          for (const feature of bufferRecord.geojson.features) {
            const origin = points.get(String(feature.properties?.id ?? "")) ?? [...points.values()][0];
            if (!origin) continue;
            const rings = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates : [];
            for (const ring of rings) for (const vertex of ring) {
              worst = Math.max(worst, Math.abs(sphericalDistance(origin, vertex) - Number(check.distance))); checked++;
            }
          }
          return { ok: checked > 0 && worst <= Number(check.tol), detail: `${checked} vertices, worst Δ=${worst.toFixed(2)} m (tol ${check.tol})` };
        }
        case "bounds_within_lonlat": {
          const bounds = layer?.bounds;
          return { ok: Array.isArray(bounds) && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90,
            detail: `bounds=${JSON.stringify(bounds)}` };
        }
        case "raster_dims_match": {
          const ref = captures.get(String(check.ref))?.layer;
          return { ok: !!layer?.raster && !!ref?.raster && layer.raster.width === ref.raster.width && layer.raster.height === ref.raster.height,
            detail: `${layer?.raster?.width}x${layer?.raster?.height} vs ${ref?.raster?.width}x${ref?.raster?.height}` };
        }
        case "raster_dims_positive":
          return { ok: Number(layer?.raster?.width) > 0 && Number(layer?.raster?.height) > 0, detail: `${layer?.raster?.width}x${layer?.raster?.height}` };
        case "export_bytes":
          return { ok: Number(capture?.raw?.bytes) >= Number(check.min), detail: `bytes=${capture?.raw?.bytes}` };
        case "error_pattern": {
          const message = capture?.error ?? "";
          return { ok: new RegExp(String(check.pattern), "i").test(message), detail: `error=${JSON.stringify(message).slice(0, 160)}` };
        }
        case "job_status": return { ok: capture?.job === check.value, detail: `job=${capture?.job}` };
        case "http_total": return { ok: Number(capture?.http?.total) === Number(check.value), detail: `total=${capture?.http?.total}` };
        case "http_rows": return { ok: (capture?.http?.rows?.length ?? -1) === Number(check.count), detail: `rows=${capture?.http?.rows?.length}` };
        case "http_first_row": {
          const found = capture?.http?.rows?.[0]?.attributes?.[String(check.field)];
          return { ok: found === check.value, detail: `${check.field}=${found}` };
        }
        case "layer_count_delta": return { ok: layersAfter - layersBefore === Number(check.value), detail: `delta=${layersAfter - layersBefore}` };
        case "step_layer_delta": {
          const counts = capture?.raw?.layerCount;
          const delta = counts ? counts.after - counts.before : NaN;
          return { ok: delta === Number(check.value), detail: `step delta=${delta}` };
        }
        case "duration_budget_ms": return { ok: duration <= Number(check.max), detail: `${duration} ms <= ${check.max}` };
        case "either": {
          const outcomes = [] as { ok: boolean; detail: string }[];
          for (const item of check.checks ?? []) outcomes.push(await evaluate(item));
          return { ok: outcomes.some(item => item.ok), detail: outcomes.map(item => `${item.ok ? "✓" : "✗"} ${item.detail}`).join(" | ") };
        }
        default: return { ok: false, detail: `unknown check type ${check.type}` };
      }
    };

    let status: RunResult["status"] = fatal ? "ERROR" : "PASS";
    for (const check of task.checks) {
      const outcome = fatal ? { ok: false, detail: "skipped: step failed" } : await evaluate(check);
      const severity = check.severity ?? "gate";
      if (!outcome.ok && !fatal && severity === "gate") status = "FAIL";
      if (!outcome.ok && severity === "known_gap" && status === "PASS") status = "WARN";
      checks.push({ type: check.type, of: check.of, severity, ok: outcome.ok, detail: outcome.detail, note: check.note });
    }

    const artifacts: any[] = [];
    for (const record of steps) {
      if (!record.layer) continue;
      const stored = await readRecord<any>(`layer:${record.layer.id}`);
      artifacts.push({ layer_id: record.layer.id, name: record.layer.name, crs: record.layer.crs,
        feature_count: record.layer.feature_count, raster: record.layer.raster ?? null,
        bytes: stored?.bytes?.length ?? null, sha256: stored?.bytes ? sha256(stored.bytes) : null });
    }

    runs.push({ task: task.id, group: task.group, title: task.title, run, status, duration_ms: duration, fatal, steps, checks, artifacts,
      layer_count: { before: layersBefore, after: layersAfter } });
  }
  return runs;
}

/** Child process: one task, isolated WASM instance. */
async function mainChild(): Promise<void> {
  const task = tasksFile.tasks.find(item => item.id === single)!;
  await initTools(fs.readFileSync(path.join(ROOT, "node_modules", "geolibre-wasm", "geolibre-cli.wasm")));
  await initLibrary({ module_or_path: fs.readFileSync(path.join(ROOT, "node_modules", "geolibre-wasm", "geolibre_wasm_bg.wasm")) });
  const runs = await runTask(task);
  fs.writeFileSync(outFile!, JSON.stringify(runs, null, 2));
  const status = runs[0]?.status ?? "ERROR";
  console.log(`  ${task.id} ${runs.map(item => `${item.status}(${item.checks.filter(c => c.ok).length}/${item.checks.length})`).join(" ")}`);
  process.exitCode = status === "PASS" || status === "WARN" ? 0 : 1;
}

/** Parent: spawn one isolated process per task, then aggregate the report. */
function mainParent(): void {
  const selected = tasksFile.tasks.filter(task => !only || only.includes(task.id));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-baseline-"));
  const results: RunResult[] = [];
  for (const task of selected) {
    for (let run = 1; run <= repeat; run++) {
      const file = path.join(tmpDir, `${task.id}-${run}.json`);
      const child = spawnSync(process.execPath, ["--import", pathToFileURL(LOADER).href, SELF, `--single=${task.id}`, `--out=${file}`], {
        cwd: ROOT, stdio: "inherit", env: { ...process.env, TIPHYS_BASELINE_CHILD: "1" }, windowsHide: true,
      });
      if (child.status !== 0 && !fs.existsSync(file)) {
        results.push({ task: task.id, group: task.group, title: task.title, run, status: "ERROR",
          duration_ms: 0, fatal: `child exited with ${child.status}`, steps: [], checks: [], artifacts: [], layer_count: { before: 0, after: 0 } });
        continue;
      }
      results.push(...(JSON.parse(fs.readFileSync(file, "utf8")) as RunResult[]).map(entry => ({ ...entry, run })));
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const byTask = new Map<string, { id: string; group: string; title: string; runs: RunResult[] }>();
  for (const result of results) {
    const entry = byTask.get(result.task) ?? { id: result.task, group: result.group, title: result.title, runs: [] };
    entry.runs.push(result);
    byTask.set(result.task, entry);
  }
  const fixtureHashes = Object.fromEntries(Object.entries(tasksFile.fixtures).map(([key, relative]) => {
    const file = path.join(ROOT, relative);
    return [key, { path: relative, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }];
  }));
  const summary = {
    generated_at: new Date().toISOString(),
    mode: "engine-reference",
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1e9) },
    tasks_file: { path: path.relative(ROOT, TASKS_PATH), sha256: sha256(fs.readFileSync(TASKS_PATH)) },
    fixtures: fixtureHashes,
    repeat,
    totals: {
      tasks: byTask.size, runs: results.length,
      pass: results.filter(result => result.status === "PASS").length,
      warn: results.filter(result => result.status === "WARN").length,
      fail: results.filter(result => result.status === "FAIL").length,
      error: results.filter(result => result.status === "ERROR").length,
    },
    agent_baseline: {
      status: "NOT_TESTED",
      reason: "浏览器 Agent 循环只能在 DOM/Worker 真环境中运行；本轮没有 Playwright 驱动，因此不报告模型成功率。",
      next: "阶段 4 用 Playwright 驱动真实页面 + 固定模型，复用同一 tasks.json，每任务 3 次。",
    },
    results,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = jsonOut ? path.resolve(ROOT, jsonOut) : path.join(OUT_DIR, "baseline-results.json");
  fs.writeFileSync(target, JSON.stringify(summary, null, 2) + "\n");

  const lines: string[] = [
    "# TIPHYS 基线运行结果（引擎参考执行）", "",
    `> 生成：${summary.generated_at} · 模式 engine-reference · 重复 ${repeat} 次 · Node ${process.version}`,
    `> 任务集 sha256 \`${summary.tasks_file.sha256.slice(0, 16)}…\` · 每个任务独立进程（WASM panic 不会污染下一项）`, "",
    "| 任务 | 组 | 结果 | 检查 | 耗时 |", "|---|---|---|---|---|",
  ];
  for (const task of byTask.values()) {
    const run = task.runs[0];
    lines.push(`| ${task.id} ${task.title} | ${task.group} | ${run.status} | ${run.checks.filter((check: any) => check.ok).length}/${run.checks.length} | ${run.duration_ms} ms |`);
  }
  lines.push("", `合计：${summary.totals.pass} PASS / ${summary.totals.warn} WARN / ${summary.totals.fail} FAIL / ${summary.totals.error} ERROR（${summary.totals.runs} 次运行）`, "");
  for (const task of byTask.values()) {
    const failedRuns = task.runs.filter(run => run.status !== "PASS");
    if (!failedRuns.length) continue;
    const statuses = [...new Set(failedRuns.map(run => run.status))].join("/");
    lines.push(`## ${task.id} ${task.title} —— ${failedRuns.length}/${task.runs.length} 次运行 ${statuses}`, "");
    const first = failedRuns[0];
    if (first.fatal) lines.push(`- 致命错误：\`${first.fatal}\``);
    for (const check of first.checks.filter((item: any) => !item.ok)) {
      lines.push(`- ${check.severity === "known_gap" ? "⚠" : "✗"} ${check.type}${check.of ? ` (${check.of})` : ""}：${check.detail}${check.note ? ` —— ${check.note}` : ""}`);
    }
    if (failedRuns.length > 1) lines.push(`- 其余 ${failedRuns.length - 1} 次失败一致（见 baseline-results.json 的 steps/fatal）`);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT_DIR, "baseline-results.md"), lines.join("\n"));

  console.log(`\n${summary.totals.pass} PASS / ${summary.totals.warn} WARN / ${summary.totals.fail} FAIL / ${summary.totals.error} ERROR`);
  console.log(`wrote ${path.relative(ROOT, target)} and docs/baselines/stage0/baseline-results.md`);
  process.exitCode = summary.totals.fail + summary.totals.error === 0 ? 0 : 1;
}

if (isChild) await mainChild();
else mainParent();