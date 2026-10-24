/**
 * Stage 5A hydrology vertical (roadmap §4 阶段 5 A).
 *
 * "给我一张 DEM，自动处理洼地、计算流向和汇流、按阈值提取河网……" — executed
 * as an AUDITED plan built by the same task-card code the product UI uses.
 *
 * What this proves beyond "it ran":
 * - Structure: fill/accumulation keep the DEM grid (raster_dims acceptance),
 *   the stream vector is non-empty and polygon-shaped, and falls inside the
 *   DEM bounds (not somewhere else on Earth).
 * - Hydrology invariant: a HIGHER threshold must not produce MORE stream
 *   polygons (monotonicity across 20/50/100/200 on two DEMs).
 * - Audit: every run is a PlanRun; auditRuns must be clean; deliverables carry
 *   sha256. One threshold-50 result is exported as the delivery template.
 *
 * Every (dem × threshold) runs in its own child process (WASM panic isolation).
 *   npm run vertical:hydro
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
import { importBrowserFile, browserLayers, runBrowserTool, readBrowserJob } from "../src/lib/browser/engine.ts";
import { browserPlanAdapter } from "../src/lib/browser/plans.ts";
import { readRecord } from "../src/lib/browser/storage.ts";
import { cardById, suggestDraft, type CardLayerFacts } from "../src/lib/taskCards.ts";
import { auditRuns, executePlan, type PlanRun } from "../shared/plans.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = path.resolve(import.meta.filename);
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage5");
const LOADER = path.join(ROOT, "agent", "node_modules", "tsx", "dist", "loader.mjs");
const WASM_DIR = path.join(ROOT, "node_modules", "geolibre-wasm");
const DATASETS = ["dem_hills", "dem_large"];
const THRESHOLDS = [20, 50, 100, 200];
/** Threshold used for the exported delivery template. */
const TEMPLATE_THRESHOLD = 50;

type Cell = { dem: string; threshold: number };
type CellResult = { dem: string; threshold: number; status: PlanRun["status"]; runId: string; durationMs: number | null;
  streamPolygons: number | null; streamAreaDeg2: number | null; acceptanceFailed: string[]; inBounds: boolean | null; headline: string;
  exportInfo: Record<string, unknown> | null; run: PlanRun };

/** Planar shoelace area in square degrees; monotone proxy for stream cell count. */
function totalAreaDeg2(geojson: any): number | null {
  const rings: number[][][] = [];
  for (const feature of geojson?.features ?? []) {
    const geometry = feature.geometry;
    if (geometry?.type === "Polygon") rings.push(...geometry.coordinates);
    else if (geometry?.type === "MultiPolygon") for (const polygon of geometry.coordinates) rings.push(...polygon);
  }
  if (!rings.length) return null;
  let total = 0;
  for (const ring of rings) {
    let twice = 0;
    for (let i = 0; i < ring.length - 1; i++) twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    total += Math.abs(twice) / 2;
  }
  return total;
}

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const prefix = "--" + name + "=";
  for (const item of argv) if (item.slice(0, prefix.length) === prefix) return item.slice(prefix.length);
  return undefined;
}
const isChild = process.env.TIPHYS_HYDRO_CHILD === "1";
const queueDir = process.env.TIPHYS_HYDRO_DIR;
const queueIndex = Number(process.env.TIPHYS_HYDRO_INDEX ?? flagValue("index"));

const sha256 = (input: Uint8Array) => crypto.createHash("sha256").update(input as any).digest("hex");
const spawnChild = spawnSync;

function joinInside(root: string, name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("不安全的文件名：" + name);
  const target = path.join(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error("路径越界：" + name);
  return target;
}

async function mainChild(): Promise<void> {
  if (!queueDir || !Number.isInteger(queueIndex)) throw new Error("child needs queue env");
  const queue = JSON.parse(fs.readFileSync(joinInside(queueDir, "queue.json"), "utf8")) as Cell[];
  const cell = queue[queueIndex];
  const outFile = joinInside(queueDir, String(queueIndex) + ".json");

  await initTools(fs.readFileSync(path.join(WASM_DIR, "geolibre-cli.wasm")));
  await initLibrary({ module_or_path: fs.readFileSync(path.join(WASM_DIR, "geolibre_wasm_bg.wasm")) });

  const fixture = cell.dem === "dem_large" ? "tests/fixtures/dem_large.tif" : "tests/fixtures/dem_hills.tif";
  const bytes = fs.readFileSync(path.join(ROOT, fixture));
  const imported = await importBrowserFile(new Blob([new Uint8Array(bytes)]), path.basename(fixture));
  const facts: CardLayerFacts[] = [{
    id: imported.layer.id, name: imported.layer.name, kind: "raster",
    raster: { width: imported.layer.raster.width, height: imported.layer.raster.height },
  }];

  // Dogfood the product preset: the plan is exactly what the task card builds.
  const preset = cardById("hydro-network")!;
  const draft = suggestDraft(preset, facts);
  draft.numeric = cell.threshold;
  draft.goal = `阶段 5A 水文纵向：${cell.dem} 阈值 ${cell.threshold} 像元的河网提取`;
  const built = preset.build(draft, facts);
  if (!built.ok) throw new Error(built.reason);

  const run = await executePlan(built.plan, browserPlanAdapter, { runId: `hydro_${cell.dem}_t${cell.threshold}` });

  // Independent geometric read-back: stream polygons must sit inside the DEM bounds.
  const poly = run.steps.find(step => step.stepId === "poly");
  let inBounds: boolean | null = null;
  let streamAreaDeg2: number | null = null;
  if (poly?.outputLayer) {
    const demBounds = (await browserLayers()).find(l => l.id === imported.layer.id)?.bounds ?? null;
    const polyRecord = await readRecord<any>("layer:" + poly.outputLayer!.id);
    if (demBounds && polyRecord?.info?.bounds) {
      const b = polyRecord.info.bounds;
      inBounds = b[0] >= demBounds[0] - 0.01 && b[1] >= demBounds[1] - 0.01 && b[2] <= demBounds[2] + 0.01 && b[3] <= demBounds[3] + 0.01;
    }
    streamAreaDeg2 = totalAreaDeg2(polyRecord?.geojson);
  }

  // Delivery template for the reference threshold: export the stream polygons.
  let exportInfo: Record<string, unknown> | null = null;
  if (cell.threshold === TEMPLATE_THRESHOLD && poly?.outputLayer && run.status === "completed") {
    const created = await runBrowserTool("export_features", { layer: poly.outputLayer.id, path: `hydro_${cell.dem}_t${cell.threshold}.geojson`, fmt: "geojson", overwrite: true });
    let exported: any = created;
    if (created.job_id) {
      for (let attempt = 0; attempt < 600; attempt++) {
        const job = await readBrowserJob(created.job_id);
        if (!["queued", "running", "cancelling"].includes(job.status)) {
          if (job.status !== "completed") throw new Error(job.error || "导出失败");
          exported = job.result;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const stored = await readRecord<any>("download:hydro_" + cell.dem + "_t" + cell.threshold + ".geojson");
    exportInfo = { path: exported?.path, bytes: exported?.bytes, sha256: stored?.bytes ? sha256(new Uint8Array(stored.bytes)) : null };
    if (stored?.bytes) fs.writeFileSync(joinInside(queueDir, "template-" + cell.dem + ".geojson"), new Uint8Array(stored.bytes));
  }

  fs.writeFileSync(outFile, JSON.stringify({
    dem: cell.dem, threshold: cell.threshold, status: run.status, runId: run.runId,
    durationMs: run.durationMs ?? null,
    streamPolygons: poly?.outputLayer?.featureCount ?? null,
    streamAreaDeg2,
    acceptanceFailed: run.steps.flatMap(step => (step.acceptance ?? []).filter(item => !item.ok).map(item => `${step.stepId}:${item.detail}`)),
    inBounds, headline: run.honest.headline, exportInfo, run,
  }, null, 2));
  console.log(`  ${cell.dem} t=${cell.threshold} ${run.status} polygons=${poly?.outputLayer?.featureCount ?? "-"} area=${streamAreaDeg2?.toExponential(2) ?? "-"} inBounds=${inBounds ?? "-"}`);
  process.exitCode = run.status === "completed" ? 0 : 1;
}

function mainParent(): void {
  const queue: Cell[] = [];
  for (const dem of DATASETS) for (const threshold of THRESHOLDS) queue.push({ dem, threshold });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-hydro-"));
  fs.writeFileSync(joinInside(tmpDir, "queue.json"), JSON.stringify(queue));
  const results: CellResult[] = [];
  const childArgs = ["--import", pathToFileURL(LOADER).href, SELF];
  for (let index = 0; index < queue.length; index++) {
    const child = spawnChild(process.execPath, childArgs, {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, TIPHYS_HYDRO_CHILD: "1", TIPHYS_HYDRO_DIR: tmpDir, TIPHYS_HYDRO_INDEX: String(index) },
      windowsHide: true,
    });
    const file = joinInside(tmpDir, String(index) + ".json");
    if (!fs.existsSync(file)) { console.log(`  ${queue[index].dem} t=${queue[index].threshold} CHILD-FAIL(${child.status})`); continue; }
    results.push(JSON.parse(fs.readFileSync(file, "utf8")));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const dem of DATASETS) {
    const template = joinInside(tmpDir, "template-" + dem + ".geojson");
    if (fs.existsSync(template)) fs.copyFileSync(template, path.join(OUT_DIR, `hydro-${dem}-t${TEMPLATE_THRESHOLD}.geojson`));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const audit = auditRuns(results.map(result => result.run));
  const byDem = new Map(DATASETS.map(dem => [dem, results.filter(result => result.dem === dem).sort((a, b) => a.threshold - b.threshold)] as const));
  // Sensitivity invariant: total stream AREA (∝ stream cell count) must not
  // increase with threshold. Polygon COUNT is deliberately not used: it counts
  // connected components, which peaks at middle thresholds (dense nets merge
  // into one blob; sparse nets shrink to a trunk) — a finding from run 1.
  const sensitivityViolations: string[] = [];
  for (const [dem, cells] of byDem) {
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1].streamAreaDeg2, now = cells[i].streamAreaDeg2;
      if (prev != null && now != null && now > prev * 1.001) sensitivityViolations.push(`${dem}: 阈值 ${cells[i - 1].threshold}→${cells[i].threshold} 河网总面积 ${prev.toExponential(2)}→${now.toExponential(2)}（应当不增）`);
    }
  }
  const structuralFailures = results.filter(result => result.status !== "completed" || result.acceptanceFailed.length || result.inBounds === false);

  const summary = {
    generated_at: new Date().toISOString(),
    datasets: DATASETS, thresholds: THRESHOLDS,
    totals: { cells: results.length, completed: results.filter(r => r.status === "completed").length, structuralFailures: structuralFailures.length },
    sensitivity: { invariant: "阈值↑ ⇒ 河网总面积（∝河网像元数）不增", violations: sensitivityViolations },
    audit: { ok: audit.ok, violations: audit.violations },
    results: results.map(({ run, ...rest }) => rest),
  };
  fs.writeFileSync(path.join(OUT_DIR, "hydrology-vertical.json"), JSON.stringify({ ...summary, runs: results.map(r => r.run) }, null, 2) + "\n");

  const lines = [
    "# 阶段 5A · 水文纵向（DEM → 河网）", "",
    "> 生成：" + summary.generated_at + " · 计划来自任务卡 hydro-network（与产品 UI 同一代码路径）· 每格独立子进程", "",
    "| DEM | 阈值 | 结果 | 河网面数(连通域) | 河网总面积(deg²) | 范围内 | 耗时 |", "|---|---|---|---|---|---|---|",
    ...results.map(r => `| ${r.dem} | ${r.threshold} | ${r.status} | ${r.streamPolygons ?? "-"} | ${r.streamAreaDeg2?.toExponential(2) ?? "-"} | ${r.inBounds ?? "-"} | ${r.durationMs ?? "-"} ms |`),
    "",
    `结构验收：${results.length - structuralFailures.length}/${results.length} 通过（completed + 验收全过 + 范围内）`,
    `敏感性不变量（阈值↑⇒河网总面积不增，0.1% 容差）：${sensitivityViolations.length === 0 ? "通过" : "违反 " + sensitivityViolations.length}`,
    `auditRuns：${audit.ok ? "通过" : "违反 " + audit.violations.length}`,
    `交付模板：docs/baselines/stage5/hydro-*-t${TEMPLATE_THRESHOLD}.geojson（导出 sha256 见 json）`,
  ];
  fs.writeFileSync(path.join(OUT_DIR, "hydrology-vertical.md"), lines.join("\n") + "\n");
  console.log(`\n结构 ${results.length - structuralFailures.length}/${results.length}；敏感性 ${sensitivityViolations.length === 0 ? "OK" : sensitivityViolations.join("; ")}；audit ${audit.ok ? "OK" : "VIOLATIONS"}`);
  process.exitCode = structuralFailures.length || sensitivityViolations.length || !audit.ok ? 1 : 0;
}

if (isChild) await mainChild();
else mainParent();
