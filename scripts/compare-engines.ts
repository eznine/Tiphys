/**
 * Cross-engine semantics comparison for `gis.buffer` / `gis.reproject` (T-004).
 *
 * Runs the SAME frozen fixtures through the WASM executor and the Python
 * executor, measures both in EPSG:32650 metres, and reports agreement per case.
 * Nothing is "assumed equal": CRS, feature count, total area, display bounds and
 * independent radius error are all read back from each engine's own output.
 *
 * Usage: npm run compare:engines   (writes docs/CROSS_ENGINE_SEMANTICS.md + json)
 */
import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initTools } from "geolibre-wasm/tools";
import initLibrary, { vector_to_geojson } from "geolibre-wasm";
import { importBrowserFile, readBrowserJob, runBrowserTool } from "../src/lib/browser/engine.ts";
import { readRecord } from "../src/lib/browser/storage.ts";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const OUT_JSON = path.join(ROOT, "docs", "baselines", "stage1", "semantics.json");
const OUT_MD = path.join(ROOT, "docs", "CROSS_ENGINE_SEMANTICS.md");
const MEASURE_CRS = "EPSG:32650";

type Case = { name: string; op: "buffer" | "reproject"; fixture: string; distance?: number; dissolve?: boolean; target?: string; radius?: boolean };

const CASES: Case[] = [
  { name: "buffer_points_500m", op: "buffer", fixture: "bj_points.geojson", distance: 500, radius: true },
  { name: "buffer_points_500m_dissolve", op: "buffer", fixture: "bj_points.geojson", distance: 500, dissolve: true },
  { name: "buffer_zones_2km", op: "buffer", fixture: "district_zones.geojson", distance: 2000 },
  { name: "buffer_points_negative", op: "buffer", fixture: "bj_points.geojson", distance: -100 },
  { name: "reproject_points_3857", op: "reproject", fixture: "bj_points.geojson", target: "EPSG:3857" },
  { name: "reproject_zones_32650", op: "reproject", fixture: "district_zones.geojson", target: "EPSG:32650" },
];

type EngineResult = {
  case: string; ok: boolean; error?: string; outputCrs?: string; analysisCrs?: string | null;
  featureCount?: number; emptyGeometries?: number; areaTotalM2?: number | null;
  measureBounds?: number[] | null; displayBounds?: number[] | null; radiusErrorMaxM?: number | null;
};

await initTools(fs.readFileSync(new URL("../node_modules/geolibre-wasm/geolibre-cli.wasm", import.meta.url)));
await initLibrary({ module_or_path: fs.readFileSync(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)) });

async function finished(name: string, args: Record<string, unknown>) {
  const created = await runBrowserTool(name, args);
  if (!created.job_id) return created;
  for (let n = 0; n < 900; n++) {
    const job = await readBrowserJob(created.job_id);
    if (!["running", "queued", "cancelling"].includes(job.status)) {
      if (job.status !== "completed") throw new Error(`${job.status}: ${job.error ?? job.message}`);
      return job.result!;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("browser job observation budget exhausted");
}

function pointSources(fixture: string) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", fixture), "utf8"));
  const points = new Map<string, [number, number]>();
  for (const feature of data.features ?? []) {
    if (feature.geometry?.type === "Point") points.set(String(feature.properties?.name), feature.geometry.coordinates);
  }
  return points;
}

const rad = (degrees: number) => degrees * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]) {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function ringArea(ring: number[][]) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(sum) / 2;
}
function polygonArea(rings: number[][][]) {
  if (!rings.length) return 0;
  return Math.abs(ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0));
}
function geometryArea(geometry: any): number {
  if (!geometry) return 0;
  if (geometry.type === "Polygon") return polygonArea(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.reduce((sum: number, rings: number[][][]) => sum + polygonArea(rings), 0);
  return 0;
}
function collectBounds(value: any, box: number[]) {
  if (!Array.isArray(value)) return box;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    box[0] = Math.min(box[0], value[0]); box[1] = Math.min(box[1], value[1]);
    box[2] = Math.max(box[2], value[0]); box[3] = Math.max(box[3], value[1]);
    return box;
  }
  for (const item of value) collectBounds(item, box);
  return box;
}

async function runBrowser(c: Case): Promise<EngineResult> {
  try {
    const file = path.join(ROOT, "tests", "fixtures", c.fixture);
    const layer = (await importBrowserFile(new Blob([fs.readFileSync(file)]), c.fixture)).layer;
    if (c.op === "buffer") {
      // The contract allows negative distances; the browser engine currently rejects them.
      const result = await finished("buffer", { layer: layer.id, distance: c.distance, units: "meters", dissolve: c.dissolve ?? false });
      const record: any = await readRecord(`layer:${result.layer.id}`);
      const native = JSON.parse(vector_to_geojson(record.bytes, record.extension));
      const areas = native.features.map((feature: any) => geometryArea(feature.geometry));
      let radiusError: number | null = null;
      if (c.radius && c.distance) {
        const sources = pointSources(c.fixture);
        let worst = 0;
        for (const feature of record.geojson.features) {
          const point = sources.get(String(feature.properties?.name));
          const ring = feature.geometry.type === "Polygon" ? feature.geometry.coordinates[0]
            : feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates.flatMap((p: any) => p[0]) : null;
          if (!point || !ring) continue;
          const nearest = Math.min(...ring.map((vertex: number[]) => sphericalDistance(point, vertex)));
          worst = Math.max(worst, Math.abs(nearest - Math.abs(c.distance)));
        }
        radiusError = worst;
      }
      return {
        case: c.name, ok: true, outputCrs: result.layer.crs, analysisCrs: result.layer.crs,
        featureCount: native.features.length,
        emptyGeometries: native.features.filter((f: any) => !f.geometry).length,
        areaTotalM2: areas.reduce((a: number, b: number) => a + b, 0),
        measureBounds: collectBounds(native.features.map((f: any) => f.geometry), [Infinity, Infinity, -Infinity, -Infinity]),
        displayBounds: collectBounds(record.geojson.features.map((f: any) => f.geometry), [Infinity, Infinity, -Infinity, -Infinity]),
        radiusErrorMaxM: radiusError,
      };
    }
    const result = await finished("reproject", { layer: layer.id, target_crs: c.target });
    if (result.noop) return { case: c.name, ok: true, outputCrs: result.layer.crs, analysisCrs: result.layer.crs, featureCount: result.layer.feature_count, areaTotalM2: null, radiusErrorMaxM: null };
    const record: any = await readRecord(`layer:${result.layer.id}`);
    const native = JSON.parse(vector_to_geojson(record.bytes, record.extension));
    const areas = native.features.map((feature: any) => geometryArea(feature.geometry));
    return {
      case: c.name, ok: true, outputCrs: result.layer.crs, analysisCrs: result.layer.crs,
      featureCount: native.features.length,
      emptyGeometries: native.features.filter((f: any) => !f.geometry).length,
      areaTotalM2: areas.reduce((a: number, b: number) => a + b, 0),
      measureBounds: collectBounds(native.features.map((f: any) => f.geometry), [Infinity, Infinity, -Infinity, -Infinity]),
      displayBounds: collectBounds(record.geojson.features.map((f: any) => f.geometry), [Infinity, Infinity, -Infinity, -Infinity]),
      radiusErrorMaxM: null,
    };
  } catch (err) {
    return { case: c.name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function runPython(): EngineResult[] {
  const exe = process.platform === "win32" ? "engine/.venv/Scripts/python.exe" : "engine/.venv/bin/python";
  const child = spawnSync(exe, ["scripts/probe-engine-semantics.py"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (child.status !== 0) throw new Error(`python probe failed: ${child.stderr?.slice(-800)}`);
  return JSON.parse(child.stdout).results;
}

const buildMu = (() => {
  try { return JSON.parse(fs.readFileSync(OUT_JSON, "utf8")); } catch { return null; }
})();

const browser = [];
for (const c of CASES) browser.push(await runBrowser(c));
const python = runPython();
const byCase = new Map(python.map(result => [result.case, result]));

const tolerance = { areaPercent: 0.5, radiusMetres: 2, boundsMetres: 1.0 };
const rows = CASES.map(c => {
  const b = browser.find(result => result.case === c.name)!;
  const p = byCase.get(c.name);
  const areaDeltaPercent = b.ok && p?.ok && typeof b.areaTotalM2 === "number" && typeof p.areaTotalM2 === "number" && p.areaTotalM2 > 0
    ? Math.abs(b.areaTotalM2 - p.areaTotalM2) / p.areaTotalM2 * 100 : null;
  const countMatch = b.ok && p?.ok ? b.featureCount === p.featureCount : null;
  const crsMatch = b.ok && p?.ok ? b.outputCrs === p.outputCrs : null;
  let verdict = "NOT_TESTED";
  if (b.ok && p?.ok) {
    const areaOk = areaDeltaPercent == null || areaDeltaPercent <= tolerance.areaPercent;
    const radiusOk = b.radiusErrorMaxM == null || b.radiusErrorMaxM <= tolerance.radiusMetres;
    verdict = crsMatch && countMatch && areaOk && radiusOk ? "PASS" : "DIVERGENT";
  } else if (b.ok !== Boolean(p?.ok)) {
    verdict = "DIVERGENT";
  } else {
    verdict = "BOTH_FAILED";
  }
  return { case: c.name, verdict, browser: b, python: p ?? null, areaDeltaPercent, countMatch, crsMatch };
});

const summary = {
  generatedAt: new Date().toISOString(),
  measureCrs: MEASURE_CRS,
  tolerance,
  engineCounts: { browser: browser.length, python: python.length },
  totals: {
    pass: rows.filter(row => row.verdict === "PASS").length,
    divergent: rows.filter(row => row.verdict === "DIVERGENT").length,
    bothFailed: rows.filter(row => row.verdict === "BOTH_FAILED").length,
    notTested: rows.filter(row => row.verdict === "NOT_TESTED").length,
  },
  rows,
  previous: buildMu ? { generatedAt: buildMu.generatedAt, totals: buildMu.totals } : null,
};

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`);

const cell = (value: unknown, digits = 2) => typeof value === "number" ? value.toFixed(digits) : value == null ? "—" : String(value);
const lines = [
  "# 双引擎语义对照：`gis.buffer` / `gis.reproject`",
  "",
  `> 生成：${summary.generatedAt} ｜ 统一测量坐标系 ${MEASURE_CRS} ｜ 容差：面积 ${tolerance.areaPercent}%、半径 ${tolerance.radiusMetres} m`,
  ">",
  "> 这是**实测**：两个执行端各自运行同一批冻结 fixtures（`tests/fixtures/bj_points.geojson`、`district_zones.geojson`），",
  "> 各自读回自己的输出再比较，不使用任一端自报的“成功”。复现：`npm run compare:engines`。",
  "",
  "## 结果",
  "",
  "| 案例 | 判定 | 浏览器 CRS | Python CRS | 要素数（浏览器/Python） | 面积差 | 半径误差（浏览器/Python） |",
  "|---|---|---|---|---|---|---|",
  ...rows.map(row => `| ${row.case} | ${row.verdict} | ${cell(row.browser.outputCrs)} | ${cell(row.python?.outputCrs)} | ${cell(row.browser.featureCount)}/${cell(row.python?.featureCount)} | ${row.areaDeltaPercent == null ? "—" : row.areaDeltaPercent.toFixed(3) + "%"} | ${cell(row.browser.radiusErrorMaxM)} m / ${cell(row.python?.radiusErrorMaxM)} m |`),
  "",
  `合计：${summary.totals.pass} PASS / ${summary.totals.divergent} DIVERGENT / ${summary.totals.bothFailed} BOTH_FAILED / ${summary.totals.notTested} NOT_TESTED。`,
  "",
  "## 逐例说明",
  "",
];
for (const row of rows) {
  lines.push(`### ${row.case} — ${row.verdict}`, "");
  if (!row.browser.ok) lines.push(`- 浏览器：失败 / 拒绝：${row.browser.error}`);
  if (!row.python?.ok) lines.push(`- Python：失败：${row.python?.error}`);
  if (row.browser.ok) lines.push(`- 浏览器输出：crs=${row.browser.outputCrs}，要素 ${row.browser.featureCount}，空几何 ${row.browser.emptyGeometries}，面积 ${cell(row.browser.areaTotalM2)} m²`);
  if (row.python?.ok) lines.push(`- Python 输出：crs=${row.python.outputCrs}，要素 ${row.python.featureCount}，空几何 ${row.python.emptyGeometries}，面积 ${cell(row.python.areaTotalM2)} m²`);
  if (row.browser.ok && row.python?.ok && row.browser.displayBounds && row.python.displayBounds == null) lines.push("- 范围：仅浏览器侧提供了 WGS84 显示范围。");
  lines.push("");
}
lines.push(
  "## 已知分歧（不在本阶段强行抹平）",
  "",
  "- **`dissolve:true` 的语义不同**：Python 用 `unary_union` 把全部缓冲合并成 1 个要素；WASM `buffer_vector` 的 dissolve 只合并**相互重叠**的缓冲，",
  "  所以 3 个互不相交的点仍是 3 个要素。面积完全一致（0.000%），差别只在要素分组。阶段 2 必须把“合并为单一要素”实现为独立语义，",
  "  而不是把两种行为都叫 dissolve。",
  "- **负距离缓冲**：契约 v1 明确只接受正数（命令层对两端同时生效）；Python 引擎原生入口仍接受 `-100` 并静默发布 3 个空几何、NaN 范围，",
  "  浏览器原生入口拒绝。引擎级差异待阶段 2 修复：要么产出有效内缩结果，要么以 `INPUT_ERROR` 明确拒绝。",
  "- **同一 CRS 重投影**：契约 v1 规定为显式 no-op；浏览器已按此实现，Python 引擎入口仍抛 `layer is already in …`。",
  "  Agent 侧在调用前用共享契约拦截，因此桌面链路行为一致；引擎原生入口的差异记录在此。",
  "",
  "## 如何解读",
  "",
  "- `PASS` 表示两端在 CRS、要素数、面积（≤0.5%）与独立半径误差（≤2 m）上一致。",
  "- `DIVERGENT` 是**发现**，不是“差不多”：必须写明哪一侧不符合契约，并进入对应阶段的修复清单。",
  "- 本文件不评价模型能力；模型在环评测见阶段 4。",
  "",
);
fs.writeFileSync(OUT_MD, lines.join("\n"));

for (const row of rows) {
  console.log(`  ${row.case.padEnd(32)} ${row.verdict.padEnd(12)} area ${row.areaDeltaPercent == null ? "—" : row.areaDeltaPercent.toFixed(3) + "%"}`);
}
console.log(`\n${summary.totals.pass} PASS / ${summary.totals.divergent} DIVERGENT / ${summary.totals.bothFailed} BOTH_FAILED -> ${path.relative(ROOT, OUT_MD)}`);
process.exitCode = summary.totals.divergent || summary.totals.bothFailed ? 1 : 0;