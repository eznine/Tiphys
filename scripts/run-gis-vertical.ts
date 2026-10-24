/**
 * Stage 5B vertical: school service zones (roadmap §4 阶段 5 B, euclidean scope).
 *
 * Runs the service-zone task card's audited plan (buffer -> clip coverage ->
 * household statistics) at four radii on frozen fixtures, and validates with
 * INDEPENDENT recomputation:
 * - touched blocks (distinct rid in the clipped layer) must equal the set
 *   computed from block-centroid-to-nearest-school geodesic distance <= r;
 * - coverage area must not decrease as the radius grows;
 * - at 12 km every block is covered (count conservation: 6 blocks, 5100
 *   households) — no double counting, no silent drops;
 * - auditRuns clean; the 1 km result exports as gpkg + csv delivery template.
 *
 * Counting rule stated on the card: block-level attribute semantics — a block
 * clipped into pieces keeps its full household count per piece; blocks are
 * never double-counted (pieces are disjoint), but partial coverage counts the
 * whole block. Areal interpolation is deliberately NOT faked.
 *
 *   npm run vertical:gis
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
const RADII = [500, 1000, 2000, 12000];
const FULL_COVERAGE_RADIUS = 12000;

type CellResult = {
  radius: number; status: PlanRun["status"]; durationMs: number | null;
  touchedRids: string[]; expectedRids: string[]; touchedMatchesExpected: boolean;
  coverageAreaDeg2: number | null; householdsSum: number | null;
  headline: string; acceptanceFailed: string[]; exports: Record<string, unknown>[];
};

const argv = process.argv.slice(2);
const isChild = process.env.TIPHYS_GIS_CHILD === "1";
const queueDir = process.env.TIPHYS_GIS_DIR;
const queueIndex = Number(process.env.TIPHYS_GIS_INDEX);

const sha256 = (input: Uint8Array) => crypto.createHash("sha256").update(input as any).digest("hex");
const spawnChild = spawnSync;
const rad = (deg: number) => deg * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function joinInside(root: string, name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("不安全的文件名：" + name);
  const target = path.join(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error("路径越界：" + name);
  return target;
}

async function mainChild(): Promise<void> {
  if (!queueDir || !Number.isInteger(queueIndex)) throw new Error("child needs queue env");
  const radius = (JSON.parse(fs.readFileSync(joinInside(queueDir, "queue.json"), "utf8")) as number[])[queueIndex];
  const outFile = joinInside(queueDir, String(queueIndex) + ".json");

  await initTools(fs.readFileSync(path.join(WASM_DIR, "geolibre-cli.wasm")));
  await initLibrary({ module_or_path: fs.readFileSync(path.join(WASM_DIR, "geolibre_wasm_bg.wasm")) });

  const schoolsBytes = fs.readFileSync(path.join(ROOT, "tests/fixtures/schools.geojson"));
  const homesBytes = fs.readFileSync(path.join(ROOT, "tests/fixtures/residential.geojson"));
  const schoolsImported = await importBrowserFile(new Blob([new Uint8Array(schoolsBytes)]), "schools.geojson");
  const homesImported = await importBrowserFile(new Blob([new Uint8Array(homesBytes)]), "residential.geojson");
  const facts: CardLayerFacts[] = [
    { id: schoolsImported.layer.id, name: schoolsImported.layer.name, kind: "vector", geometryTypes: ["Point"], featureCount: 5 },
    { id: homesImported.layer.id, name: homesImported.layer.name, kind: "vector", geometryTypes: ["Polygon"], featureCount: 6 },
  ];

  const preset = cardById("service-zone")!;
  const draft = suggestDraft(preset, facts);
  draft.numeric = radius;
  draft.goal = `阶段 5B 纵向：学校 ${radius} 米服务圈覆盖统计`;
  const built = preset.build(draft, facts);
  if (!built.ok) throw new Error(built.reason);
  const run = await executePlan(built.plan, browserPlanAdapter, { runId: `gis_r${radius}` });

  // Independent recomputation from raw fixtures: a block counts as touched
  // when any school point is within `radius` METRES of the block POLYGON
  // (intersection semantics — the same rule clip uses). Equirectangular
  // metres at this latitude; city scale keeps the error far below 1%.
  const schoolsGeo = JSON.parse(schoolsBytes.toString("utf8"));
  const homesGeo = JSON.parse(homesBytes.toString("utf8"));
  const lat0 = 39.9;
  const MX = 111_195 * Math.cos(rad(lat0)), MY = 111_195;
  const toMeters = (p: number[]): [number, number] => [(p[0]) * MX, (p[1]) * MY];
  function pointToSegDistance(px: number, py: number, a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }
  function pointToRingMeters(point: number[], ring: number[][]): number {
    const [px, py] = toMeters(point);
    const segs = ring.slice(0, -1).map((p, i) => [toMeters(p), toMeters(ring[i + 1])] as [[number, number], [number, number]]);
    let inside = false;
    for (const [[ax, ay], [bx, by]] of segs) {
      if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside) return 0;
    return Math.min(...segs.map(([[ax, ay], [bx, by]]) => pointToSegDistance(px, py, [ax, ay], [bx, by])));
  }
  const schoolPoints: number[][] = schoolsGeo.features.map((f: any) => f.geometry.coordinates);
  const expectedRids: string[] = [];
  for (const feature of homesGeo.features) {
    const ring = feature.geometry.coordinates[0];
    const nearest = Math.min(...schoolPoints.map(p => pointToRingMeters(p, ring)));
    if (nearest <= radius) expectedRids.push(feature.properties.rid);
  }
  expectedRids.sort();

  const cover = run.steps.find(step => step.stepId === "cover");
  let touchedRids: string[] = [];
  let coverageAreaDeg2: number | null = null;
  let householdsSum: number | null = null;
  if (cover?.outputLayer) {
    const record = await readRecord<any>("layer:" + cover.outputLayer.id);
    const features = record?.geojson?.features ?? [];
    touchedRids = [...new Set(features.map((f: any) => f.properties?.rid).filter(Boolean))].sort();
    let total = 0;
    for (const feature of features) {
      const rings = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates : [];
      for (const ring of rings) {
        let twice = 0;
        for (let i = 0; i < ring.length - 1; i++) twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        total += Math.abs(twice) / 2;
      }
    }
    coverageAreaDeg2 = total;
    householdsSum = features.reduce((acc: number, f: any) => acc + Number(f.properties?.households ?? 0), 0);
  }

  // Delivery template at the reference radius: gpkg + csv of the coverage layer.
  const exports: Record<string, unknown>[] = [];
  if (radius === 1000 && cover?.outputLayer && run.status === "completed") {
    for (const fmt of ["gpkg", "csv"]) {
      const name = `service_coverage_r1000.${fmt}`;
      const created = await runBrowserTool("export_features", { layer: cover.outputLayer.id, path: name, fmt, overwrite: true });
      let result: any = created;
      if (created.job_id) {
        for (let attempt = 0; attempt < 600; attempt++) {
          const job = await readBrowserJob(created.job_id);
          if (!["queued", "running", "cancelling"].includes(job.status)) { result = job.result; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      const stored = await readRecord<any>("download:" + name);
      exports.push({ path: name, bytes: result?.bytes ?? null, sha256: stored?.bytes ? sha256(new Uint8Array(stored.bytes)) : null });
      if (stored?.bytes && fmt === "gpkg") fs.writeFileSync(joinInside(queueDir, "template-r1000.gpkg"), new Uint8Array(stored.bytes));
    }
  }
  void browserLayers;

  fs.writeFileSync(outFile, JSON.stringify({
    radius, status: run.status, durationMs: run.durationMs ?? null,
    touchedRids, expectedRids, touchedMatchesExpected: JSON.stringify(touchedRids) === JSON.stringify(expectedRids),
    coverageAreaDeg2, householdsSum, headline: run.honest.headline,
    acceptanceFailed: run.steps.flatMap(step => (step.acceptance ?? []).filter(item => !item.ok).map(item => `${step.stepId}:${item.detail}`)),
    exports, run,
  }, null, 2));
  console.log(`  r=${radius} ${run.status} touched=${touchedRids.join(",")} expected=${expectedRids.join(",")} match=${JSON.stringify(touchedRids) === JSON.stringify(expectedRids)} households=${householdsSum}`);
  process.exitCode = run.status === "completed" ? 0 : 1;
}

function mainParent(): void {
  const queue = RADII;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-gisv-"));
  fs.writeFileSync(joinInside(tmpDir, "queue.json"), JSON.stringify(queue));
  const results: CellResult[] = [];
  const runs: PlanRun[] = [];
  const childArgs = ["--import", pathToFileURL(LOADER).href, SELF];
  for (let index = 0; index < queue.length; index++) {
    const child = spawnChild(process.execPath, childArgs, {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, TIPHYS_GIS_CHILD: "1", TIPHYS_GIS_DIR: tmpDir, TIPHYS_GIS_INDEX: String(index) },
      windowsHide: true,
    });
    const file = joinInside(tmpDir, String(index) + ".json");
    if (!fs.existsSync(file)) { console.log(`  r=${queue[index]} CHILD-FAIL(${child.status})`); continue; }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    results.push(parsed); runs.push(parsed.run);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const template = joinInside(tmpDir, "template-r1000.gpkg");
  if (fs.existsSync(template)) fs.copyFileSync(template, path.join(OUT_DIR, "service-coverage-r1000.gpkg"));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const audit = auditRuns(runs);
  const sorted = [...results].sort((a, b) => a.radius - b.radius);
  const monotonicViolations: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].coverageAreaDeg2, now = sorted[i].coverageAreaDeg2;
    if (prev != null && now != null && now < prev * 0.999) monotonicViolations.push(`r=${sorted[i - 1].radius}→${sorted[i].radius} 覆盖面积 ${prev.toExponential(2)}→${now.toExponential(2)}（应当不减）`);
  }
  const full = sorted.find(cell => cell.radius === FULL_COVERAGE_RADIUS);
  const conservation = full ? { blocks: full.touchedRids.length, households: full.householdsSum, ok: full.touchedRids.length === 6 && full.householdsSum === 5100 } : null;
  const structuralFailures = results.filter(result => result.status !== "completed" || result.acceptanceFailed.length || !result.touchedMatchesExpected);

  const summary = {
    generated_at: new Date().toISOString(),
    radii: RADII,
    invariants: {
      touched_blocks_match_independent_recompute: results.every(r => r.touchedMatchesExpected),
      coverage_area_monotone_nondecreasing: monotonicViolations.length === 0,
      monotonic_violations: monotonicViolations,
      full_coverage_conservation: conservation,
    },
    audit: { ok: audit.ok, violations: audit.violations },
    counting_rule: "块级口径：片段保留原块户数；跨圈不重复；部分覆盖按整块计入（不做面积加权插值）",
    totals: { cells: results.length, structuralFailures: structuralFailures.length },
    results: results.map(({ run, ...rest }) => rest),
  };
  fs.writeFileSync(path.join(OUT_DIR, "gis-vertical.json"), JSON.stringify({ ...summary, runs }, null, 2) + "\n");
  const lines = [
    "# 阶段 5B · 服务圈纵向（学校 1 公里圈 × 居住区统计，欧式距离）", "",
    "> 生成：" + summary.generated_at + " · 计划来自任务卡 service-zone · 每半径独立子进程 · 触达块由“学校点到块多边形的距离 ≤ 半径”独立复算（相交口径，与裁剪一致）", "",
    "| 半径 | 结果 | 触达块 | 独立复算 | 户数合计 | 覆盖面积 deg² |", "|---|---|---|---|---|---|",
    ...sorted.map(r => `| ${r.radius} m | ${r.status} | ${r.touchedRids.join(",") || "-"} | ${r.touchedMatchesExpected ? "一致" : "不一致：" + r.expectedRids.join(",")} | ${r.householdsSum ?? "-"} | ${r.coverageAreaDeg2?.toExponential(2) ?? "-"} |`),
    "",
    `触达块与独立复算一致：${results.every(r => r.touchedMatchesExpected) ? "通过" : "存在不一致"}`,
    `覆盖面积随半径不减：${monotonicViolations.length === 0 ? "通过" : monotonicViolations.join("；")}`,
    `全覆盖守恒（${FULL_COVERAGE_RADIUS} m = 6 块 5100 户）：${conservation ? (conservation.ok ? "通过" : `失败（${conservation.blocks} 块 / ${conservation.households} 户）`) : "未测"}`,
    `auditRuns：${audit.ok ? "通过" : "违反 " + audit.violations.length}`,
    `交付模板：docs/baselines/stage5/service-coverage-r1000.gpkg（sha256 见 json）`,
    `口径说明：${summary.counting_rule}`,
  ];
  fs.writeFileSync(path.join(OUT_DIR, "gis-vertical.md"), lines.join("\n") + "\n");
  console.log(`\n结构 ${results.length - structuralFailures.length}/${results.length}；一致性 ${results.every(r => r.touchedMatchesExpected) ? "OK" : "MISMATCH"}；单调 ${monotonicViolations.length === 0 ? "OK" : "VIOLATIONS"}；守恒 ${conservation?.ok ? "OK" : "FAIL"}；audit ${audit.ok ? "OK" : "VIOLATIONS"}`);
  process.exitCode = structuralFailures.length || monotonicViolations.length || !conservation?.ok || !audit.ok ? 1 : 0;
}

if (isChild) await mainChild();
else mainParent();
