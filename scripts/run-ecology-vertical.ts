/**
 * Stage 5C ecology vertical: two (plus one stronger) resistance schemes over
 * the same synthetic source/destination geometry and grid.
 *
 * The audited plan is built by the product task card `ecology-corridor`:
 *   wasm_cost_distance(source, resistance)  -> accumulated cost
 *   wasm_cost_distance(destination, resistance) -> accumulated cost
 *   wasm_corridor(cost1, cost2, percent) -> near-optimal corridor raster
 *
 * Invariants beyond "the tool returned ok":
 * - every scheme completes and its corridor is a non-empty raster on the
 *   resistance grid;
 * - source and destination fixture bytes are identical across schemes;
 * - resistance rasters share one CRS/transform, and all valid resistance
 *   cells are strictly positive;
 * - the corridor minimum (the least source-to-destination accumulated cost)
 *   is non-decreasing as the synthetic mid-band barrier gets stronger;
 * - a Python/rasterio readback independently compares shape, CRS, transform
 *   and bounds, so raster cells cannot sit outside the resistance extent;
 * - auditRuns is clean and the strongest comparison artifact is exported with
 *   its sha256.
 *
 * Every scheme runs in its own child process (WASM panic isolation).
 *   npm run vertical:ecology
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
import { importBrowserFile } from "../src/lib/browser/engine.ts";
import { browserPlanAdapter } from "../src/lib/browser/plans.ts";
import { readRecord } from "../src/lib/browser/storage.ts";
import { cardById, suggestDraft, type CardLayerFacts } from "../src/lib/taskCards.ts";
import { auditRuns, executePlan, type PlanRun } from "../shared/plans.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = path.resolve(import.meta.filename);
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage5");
const LOADER = path.join(ROOT, "agent", "node_modules", "tsx", "dist", "loader.mjs");
const WASM_DIR = path.join(ROOT, "node_modules", "geolibre-wasm");
const PYTHON = process.env.TIPHYS_PYTHON || path.join(ROOT, "engine", ".venv", "bin", "python");
const CORRIDOR_PERCENT = 5;

type Scheme = { id: "A" | "B" | "C"; resistance: string; barrierBoost: number };
const SCHEMES: Scheme[] = [
  { id: "A", resistance: "resistance_a.tif", barrierBoost: 0 },
  { id: "B", resistance: "resistance_b.tif", barrierBoost: 8 },
  { id: "C", resistance: "resistance_c.tif", barrierBoost: 16 },
];

type RasterProfile = {
  width: number; height: number; crs: string | null;
  bounds: [number, number, number, number]; transform: [number, number, number, number, number, number];
  nodata: number | null; validCount: number;
  min: number | null; max: number | null; mean: number | null; sum: number | null;
};

type ChildResult = {
  scheme: Scheme["id"]; barrierBoost: number; status: PlanRun["status"]; runId: string; durationMs: number | null;
  acceptanceFailed: string[]; headline: string;
  input: {
    resistance: { sha256: string; grid: { width: number; height: number; crs?: string } };
    sources: { sha256: string; grid: { width: number; height: number; crs?: string } };
    destination: { sha256: string; grid: { width: number; height: number; crs?: string } };
  };
  corridor: { sha256: string; bytes: number; grid: { width: number; height: number; crs?: string }; artifactFile: string } | null;
  run: PlanRun;
};

const sha256 = (input: Uint8Array) => crypto.createHash("sha256").update(input as any).digest("hex");

function joinInside(root: string, name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("不安全的文件名：" + name);
  const target = path.join(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error("路径越界：" + name);
  return target;
}

async function mainChild(): Promise<void> {
  const queueDir = process.env.TIPHYS_ECOLOGY_DIR;
  const index = Number(process.env.TIPHYS_ECOLOGY_INDEX);
  if (!queueDir || !Number.isInteger(index)) throw new Error("child needs queue env");
  const schemes = JSON.parse(fs.readFileSync(joinInside(queueDir, "queue.json"), "utf8")) as Scheme[];
  const scheme = schemes[index];
  const outFile = joinInside(queueDir, `${index}.json`);

  await initTools(fs.readFileSync(path.join(WASM_DIR, "geolibre-cli.wasm")));
  await initLibrary({ module_or_path: fs.readFileSync(path.join(WASM_DIR, "geolibre_wasm_bg.wasm")) });

  const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, "tests", "fixtures", name)));
  const resistanceBytes = fixture(scheme.resistance);
  const sourceBytes = fixture("habitat_sources.tif");
  const destinationBytes = fixture("habitat_dest.tif");
  const resistance = (await importBrowserFile(new Blob([resistanceBytes]), scheme.resistance)).layer;
  const sources = (await importBrowserFile(new Blob([sourceBytes]), "habitat_sources.tif")).layer;
  const destination = (await importBrowserFile(new Blob([destinationBytes]), "habitat_dest.tif")).layer;
  const facts: CardLayerFacts[] = [resistance, sources, destination].map(layer => ({
    id: layer.id, name: layer.name, kind: "raster", crs: layer.crs,
    raster: { width: layer.raster!.width, height: layer.raster!.height, bands: layer.raster!.bands },
  }));

  const preset = cardById("ecology-corridor")!;
  const draft = suggestDraft(preset, facts);
  draft.inputs = { resistance: resistance.id, sources: sources.id, destination: destination.id };
  draft.numeric = CORRIDOR_PERCENT;
  draft.goal = `阶段 5C 合成校验：阻力方案 ${scheme.id} 的最小成本廊道`;
  const built = preset.build(draft, facts);
  if (!built.ok) throw new Error(built.reason);
  const run = await executePlan(built.plan, browserPlanAdapter, { runId: `ecology_${scheme.id}` });

  const corridorStep = run.steps.find(item => item.stepId === "corridor");
  let corridor: ChildResult["corridor"] = null;
  if (corridorStep?.outputLayer) {
    const stored = await readRecord<any>(`layer:${corridorStep.outputLayer.id}`);
    if (!stored?.bytes?.length) throw new Error("廊道栅格没有可读回的 GeoTIFF 字节。");
    const artifactFile = `${index}.tif`;
    fs.writeFileSync(joinInside(queueDir, artifactFile), new Uint8Array(stored.bytes));
    corridor = {
      sha256: sha256(new Uint8Array(stored.bytes)), bytes: stored.bytes.length,
      grid: { width: stored.info.raster.width, height: stored.info.raster.height, crs: stored.info.crs },
      artifactFile,
    };
  }

  const result: ChildResult = {
    scheme: scheme.id, barrierBoost: scheme.barrierBoost, status: run.status, runId: run.runId,
    durationMs: run.durationMs ?? null,
    acceptanceFailed: run.steps.flatMap(step => (step.acceptance ?? []).filter(item => !item.ok).map(item => `${step.stepId}:${item.detail}`)),
    headline: run.honest.headline,
    input: {
      resistance: { sha256: sha256(resistanceBytes), grid: { width: resistance.raster!.width, height: resistance.raster!.height, crs: resistance.crs } },
      sources: { sha256: sha256(sourceBytes), grid: { width: sources.raster!.width, height: sources.raster!.height, crs: sources.crs } },
      destination: { sha256: sha256(destinationBytes), grid: { width: destination.raster!.width, height: destination.raster!.height, crs: destination.crs } },
    },
    corridor, run,
  };
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`  scheme=${scheme.id} barrier=+${scheme.barrierBoost} ${run.status} corridor=${corridor?.bytes ?? "-"} bytes`);
  process.exitCode = run.status === "completed" ? 0 : 1;
}

function rasterReadback(files: string[]): RasterProfile[] {
  if (!fs.existsSync(PYTHON)) throw new Error(`独立栅格回读需要 Python/rasterio：${PYTHON}`);
  const code = `
import json, sys
import numpy as np
import rasterio
out = []
for filename in sys.argv[1:]:
    with rasterio.open(filename) as ds:
        values = ds.read(1, masked=True).compressed()
        transform = ds.transform
        out.append({
            "width": ds.width,
            "height": ds.height,
            "crs": ds.crs.to_string() if ds.crs else None,
            "bounds": list(ds.bounds),
            "transform": [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f],
            "nodata": ds.nodata,
            "validCount": int(values.size),
            "min": float(values.min()) if values.size else None,
            "max": float(values.max()) if values.size else None,
            "mean": float(values.mean()) if values.size else None,
            "sum": float(values.sum()) if values.size else None,
        })
print(json.dumps(out))
`;
  const read = spawnSync(PYTHON, ["-c", code, ...files], { cwd: ROOT, encoding: "utf8" });
  if (read.status !== 0) throw new Error(`栅格回读失败：${read.stderr || read.stdout}`);
  return JSON.parse(read.stdout) as RasterProfile[];
}

const sameNumber = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
const sameGrid = (a: RasterProfile, b: RasterProfile) =>
  a.width === b.width && a.height === b.height && a.crs === b.crs &&
  a.transform.every((value, index) => sameNumber(value, b.transform[index]));

function mainParent(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-ecology-"));
  fs.writeFileSync(joinInside(tmpDir, "queue.json"), JSON.stringify(SCHEMES));
  const results: ChildResult[] = [];
  const profiles = new Map<string, Record<string, RasterProfile>>();
  const childArgs = ["--import", pathToFileURL(LOADER).href, SELF];

  try {
    for (let index = 0; index < SCHEMES.length; index++) {
      const child = spawnSync(process.execPath, childArgs, {
        cwd: ROOT, stdio: "inherit",
        env: { ...process.env, TIPHYS_ECOLOGY_DIR: tmpDir, TIPHYS_ECOLOGY_INDEX: String(index) },
        windowsHide: true,
      });
      const file = joinInside(tmpDir, `${index}.json`);
      if (!fs.existsSync(file)) {
        console.log(`  scheme=${SCHEMES[index].id} CHILD-FAIL(${child.status})`);
        continue;
      }
      const result = JSON.parse(fs.readFileSync(file, "utf8")) as ChildResult;
      results.push(result);
      if (result.corridor) {
        const [corridor, resistance, sources, destination] = rasterReadback([
          joinInside(tmpDir, result.corridor.artifactFile),
          path.join(ROOT, "tests", "fixtures", SCHEMES[index].resistance),
          path.join(ROOT, "tests", "fixtures", "habitat_sources.tif"),
          path.join(ROOT, "tests", "fixtures", "habitat_dest.tif"),
        ]);
        profiles.set(result.scheme, { corridor, resistance, sources, destination });
      }
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const delivery = results.find(result => result.scheme === "B" && result.corridor);
    let artifact: Record<string, unknown> | null = null;
    if (delivery?.corridor) {
      const target = path.join(OUT_DIR, "ecology-corridor-B.tif");
      fs.copyFileSync(joinInside(tmpDir, delivery.corridor.artifactFile), target);
      const bytes = new Uint8Array(fs.readFileSync(target));
      const digest = sha256(bytes);
      fs.writeFileSync(`${target}.sha256`, `${digest}  ecology-corridor-B.tif\n`);
      artifact = { path: "docs/baselines/stage5/ecology-corridor-B.tif", sha256: digest, bytes: bytes.length };
    }

    const sorted = [...results].sort((a, b) => a.barrierBoost - b.barrierBoost);
    const monotonicViolations: string[] = [];
    for (let index = 1; index < sorted.length; index++) {
      const previous = profiles.get(sorted[index - 1].scheme)?.corridor.min;
      const current = profiles.get(sorted[index].scheme)?.corridor.min;
      if (previous == null || current == null || current < previous * (1 - 1e-9)) {
        monotonicViolations.push(`${sorted[index - 1].scheme}→${sorted[index].scheme} 廊道最小成本 ${previous ?? "?"}→${current ?? "?"}（应当不减）`);
      }
    }
    const sourceHashes = new Set(results.map(result => result.input.sources.sha256));
    const destinationHashes = new Set(results.map(result => result.input.destination.sha256));
    const schemeProfiles = [...profiles.entries()];
    const resistanceGridStable = schemeProfiles.length > 1 && schemeProfiles.every(([, profile]) => sameGrid(profile.resistance, schemeProfiles[0][1].resistance));
    const endpointGridsMatch = schemeProfiles.every(([, profile]) => sameGrid(profile.resistance, profile.sources) && sameGrid(profile.resistance, profile.destination));
    const corridorWithinResistance = schemeProfiles.every(([, profile]) => sameGrid(profile.resistance, profile.corridor));
    const resistancePositive = schemeProfiles.every(([, profile]) => profile.resistance.min != null && profile.resistance.min > 0 && profile.resistance.validCount === profile.resistance.width * profile.resistance.height);
    const corridorNonEmpty = schemeProfiles.every(([, profile]) => profile.corridor.validCount > 0 && profile.corridor.max != null && profile.corridor.max > 0);
    const structuralFailures = results.filter(result => result.status !== "completed" || result.acceptanceFailed.length || !result.corridor);
    const audit = auditRuns(results.map(result => result.run));
    const invariantsOk = structuralFailures.length === 0 && monotonicViolations.length === 0 && sourceHashes.size === 1 &&
      destinationHashes.size === 1 && resistanceGridStable && endpointGridsMatch && corridorWithinResistance && resistancePositive && corridorNonEmpty;

    const summary = {
      generated_at: new Date().toISOString(),
      task_card: "ecology-corridor",
      chain: ["wasm_cost_distance (source)", "wasm_cost_distance (destination)", "wasm_corridor (direct cost1+cost2)"],
      corridor_percent_above_minimum: CORRIDOR_PERCENT,
      cost_metric: "min(valid corridor cells)：两个累积成本面之和的最小值，即源集到目标集的最小总阻力成本",
      schemes: SCHEMES,
      invariants: {
        structure_completed_and_acceptance: structuralFailures.length === 0,
        source_destination_identical_across_schemes: sourceHashes.size === 1 && destinationHashes.size === 1,
        resistance_crs_grid_stable: resistanceGridStable,
        endpoint_grids_match_resistance: endpointGridsMatch,
        corridor_cells_within_resistance_extent: corridorWithinResistance,
        resistance_strictly_positive_full_grid: resistancePositive,
        corridor_non_empty: corridorNonEmpty,
        corridor_min_cost_nondecreasing: monotonicViolations.length === 0,
        monotonic_violations: monotonicViolations,
      },
      audit: { ok: audit.ok, violations: audit.violations },
      artifact,
      totals: { schemes: results.length, structuralFailures: structuralFailures.length },
      results: results.map(({ run, ...rest }) => ({ ...rest, readback: profiles.get(rest.scheme) ?? null })),
    };
    fs.writeFileSync(path.join(OUT_DIR, "ecology-vertical.json"), JSON.stringify({ ...summary, runs: results.map(result => result.run) }, null, 2) + "\n");

    const rows = sorted.map(result => {
      const profile = profiles.get(result.scheme);
      const min = profile?.corridor.min;
      const max = profile?.corridor.max;
      const valid = profile?.corridor.validCount;
      return `| ${result.scheme} | +${result.barrierBoost} | ${result.status} | ${result.corridor?.grid.width ?? "?"}×${result.corridor?.grid.height ?? "?"} | ${valid ?? "-"} | ${min?.toFixed(3) ?? "-"} | ${max?.toFixed(3) ?? "-"} |`;
    });
    const previousMin = profiles.get("A")?.corridor.min;
    const nextMin = profiles.get("B")?.corridor.min;
    const strongerMin = profiles.get("C")?.corridor.min;
    const lines = [
      "# 阶段 5C · 生态最小成本廊道纵向（合成阻力方案 A/B/C）", "",
      `> 生成：${summary.generated_at} · 计划来自任务卡 ${summary.task_card} · 每方案独立子进程 · 独立 rasterio 回读`, "",
      "| 方案 | 中带阻力增量 | 结果 | 廊道网格 | 有效像元 | 廊道最小成本 | 廊道最大成本 |", "|---|---|---|---|---|---|---|",
      ...rows, "",
      `成本不变量：廊道最小成本随中带阻力增强不降 — ${monotonicViolations.length === 0 ? "通过" : "违反"}`,
      `差值解释：A→B 最小成本 ${previousMin?.toFixed(3) ?? "?"}→${nextMin?.toFixed(3) ?? "?"}；B→C ${nextMin?.toFixed(3) ?? "?"}→${strongerMin?.toFixed(3) ?? "?"}。`,
      `同输入：源地/目的地栅格 sha256 跨方案一致；阻力方案 CRS/网格一致；廊道与阻力面同 CRS/transform/bounds。`,
      `auditRuns：${audit.ok ? "通过" : "违反 " + audit.violations.length}`,
      `交付：${artifact?.path ?? "未导出"}（sha256 ${artifact?.sha256 ?? "-"}）`,
      "",
      "口径：廊道面 = 从源地与目的地分别计算的累积成本面之和；最小值为最小成本路径的总阻力成本。百分比参数只保留近最优带，不改变最小值。阻力权重为合成方案，不代表真实物种扩散或栖息地质量。",
    ];
    fs.writeFileSync(path.join(OUT_DIR, "ecology-vertical.md"), lines.join("\n") + "\n");
    console.log(`\n结构 ${results.length - structuralFailures.length}/${results.length}；成本单调 ${monotonicViolations.length === 0 ? "OK" : "VIOLATIONS"}；同网格 ${resistanceGridStable && endpointGridsMatch && corridorWithinResistance ? "OK" : "FAIL"}；audit ${audit.ok ? "OK" : "VIOLATIONS"}`);
    process.exitCode = invariantsOk && audit.ok && artifact ? 0 : 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.env.TIPHYS_ECOLOGY_DIR) await mainChild();
else mainParent();
