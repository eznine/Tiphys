/**
 * Stage 4: GeoAgentBench adaptation (roadmap §4 阶段 4 · 任务 2).
 *
 * Runs a COMPATIBLE SUBSET of the external benchmark (pothos-dev/geoagentbench,
 * shallow-cloned under reference/gis/GeoAgentBench) through the same real-page
 * model-in-the-loop driver as our own baseline, then grades with the benchmark's
 * OWN deterministic graders (grade.py per task, PYTHONPATH=eval). Reported
 * SEPARATELY per the roadmap — these numbers never merge into TIPHYS scores.
 *
 * Compatibility policy (first round): tasks whose operations our engine
 * natively supports (reproject / convex hull / centroid / intersect /
 * attribute filter / KML conversion) and whose expected outputs are geojson /
 * gpkg / csv — formats export_features can produce. Excluded and why, see the
 * generated report. Inputs are preloaded through the real import path; the
 * instruction is sent verbatim (English); export approvals auto-consent.
 *
 *   git clone --depth 1 https://github.com/pothos-dev/geoagentbench reference/gis/GeoAgentBench
 *   npm run dev                # terminal 1
 *   npm run bench:geoagent     # terminal 2 (after other baselines finish)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const BENCH = path.join(ROOT, "reference", "gis", "GeoAgentBench");
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage4");
const APP = "http://127.0.0.1:1420/";
const PYTHON = path.join(ROOT, process.platform === "win32" ? "engine/.venv/Scripts/python.exe" : "engine/.venv/bin/python");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean) as string[];

/** Round-1 subset: ops our engine natively supports + producible output formats. */
const INCLUDED = [
  "crs-l1-paris-lambert93",
  "geo-l1-cairo-multipoint-hull",
  "geo-l1-capetown-building-centroids",
  "geo-l2-bangkok-landuse-intersect",
  "dc-l1-capetown-waterway-nulls",
  "fio-l1-paris-kml-pois",
];
/** Excluded with reasons; the report shows them so the subset is auditable. */
const EXCLUDED: { id: string; reason: string }[] = [
  { id: "geo-l1-tokyo-busstop-buffer", reason: "输出 GeoParquet，浏览器导出暂不支持该格式" },
  { id: "spa-l1-capetown-hospital-nn", reason: "输入为 GeoParquet 且要求精确列名（nearest_hospital_name/distance_m），第一轮不接" },
  { id: "spa-l1-paris-amenity-within / spa-l1-vienna-pip-count", reason: "CSV 列名来自参考实现的 pandas 语义（分组计数/指定列名），我们原生导出对不上 schema" },
  { id: "dc-l2-* / fio-l2-capetown-landuse-dissolve", reason: "依赖 dissolve——浏览器端 D1 缺陷未修" },
  { id: "spa-l3-paris-emergency-routing / spa-l2-*", reason: "需要路网/距离矩阵/kNN 算子，当前引擎无对应能力" },
  { id: "crs-l3 / dc-l3 / fio-l3 / dd-l3 / geo-l3 / lagos", reason: "多算子长链或需外部数据下载（Overture/Overpass），第一轮不接" },
];

type BenchTask = {
  task_id: string;
  instruction: string;
  inputs: { name: string; url: string; format: string }[];
  expected_outputs: { name: string; format: string }[];
};

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const prefix = "--" + name + "=";
  for (const item of argv) if (item.slice(0, prefix.length) === prefix) return item.slice(prefix.length);
  return undefined;
}
const only = flagValue("only")?.split(",").filter(Boolean);
const spawnChild = spawnSync;

function joinInside(root: string, name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("不安全的文件名：" + name);
  const target = path.join(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error("路径越界：" + name);
  return target;
}

/** Runs the benchmark's own grader and returns its JSON verdict. */
function runGrader(taskId: string, submissionDir: string): { ok: boolean; json: any; stderr: string } {
  const gradePy = path.join(BENCH, "tasks", taskId, "grade.py");
  const child = spawnChild(PYTHON, [gradePy, submissionDir], {
    cwd: BENCH, windowsHide: true, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(BENCH, "eval"), PYTHONDONTWRITEBYTECODE: "1" },
  });
  const stdout = String(child.stdout ?? "");
  const stderr = [child.error ? String(child.error) : "", String(child.stderr ?? "")].filter(Boolean).join("\n");
  if (child.status !== 0 && !stdout.trim()) return { ok: false, json: null, stderr: stderr.slice(0, 500) || `grader exited ${child.status} without output` };
  try {
    const start = stdout.indexOf("{");
    return { ok: true, json: JSON.parse(stdout.slice(start)), stderr };
  } catch {
    return { ok: false, json: null, stderr: stderr.slice(0, 500) || stdout.slice(0, 500) };
  }
}

async function main() {
  if (!fs.existsSync(BENCH)) { console.error("未找到 reference/gis/GeoAgentBench，请先浅克隆（见脚本头注释）。"); process.exit(2); }
  const probe = await fetch(APP, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (!probe) { console.error("开发服务器未启动：先在另一个终端 npm run dev。"); process.exit(2); }
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) { console.error("找不到 Chrome/Edge（可用 CHROME_PATH 指定）。"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });

  const selected = INCLUDED.filter(id => !only || only.includes(id));
  const results: any[] = [];
  for (const taskId of selected) {
    const taskDir = path.join(BENCH, "tasks", taskId);
    const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")) as BenchTask;
    const started = Date.now();
    const submissionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-gab-"));
    let fatal: string | undefined;
    try {
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await context.newPage();
      await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 }));
      await page.waitForTimeout(1200);
      await page.evaluate(async (payload: { inputs: { name: string; b64: string }[] }) => {
        const engine = await import("/src/lib/browser/engine.ts");
        for (const input of payload.inputs) {
          const bytes = Uint8Array.from(atob(input.b64), ch => ch.charCodeAt(0));
          await engine.importBrowserFile(new Blob([bytes]), input.name);
        }
      }, { inputs: task.inputs.map(input => ({ name: path.basename(input.url), b64: fs.readFileSync(path.join(BENCH, input.url)).toString("base64") })) });

      const session = "gab_" + taskId;
      await page.evaluate(async (payload: { session: string; text: string }) => {
        const agent = await import("/src/lib/browser/agent.ts");
        const response = await agent.browserAgentRequest("/chat?session=" + payload.session, { method: "POST", body: JSON.stringify({ text: payload.text }) });
        if (!response.ok) throw new Error("chat rejected");
      }, { session, text: task.instruction });

      const deadline = Date.now() + 300000;
      let events: any[] = [];
      for (;;) {
        await page.waitForTimeout(700);
        const snapshot: any = await page.evaluate(async (session: string) => {
          const agent = await import("/src/lib/browser/agent.ts");
          return agent.browserAgentRequest("/history?session=" + session).then(r => r.json());
        }, session);
        events = snapshot.events ?? [];
        for (const id of snapshot.pendingApprovals ?? []) {
          await page.evaluate(async (payload: { session: string; id: string }) => {
            const agent = await import("/src/lib/browser/agent.ts");
            await agent.browserAgentRequest("/approve?session=" + payload.session, { method: "POST", body: JSON.stringify({ approved: true, toolCallId: payload.id }) });
          }, { session, id });
        }
        const last = events[events.length - 1];
        if (last?.type === "turn-end" || Date.now() > deadline) break;
      }

      // Pull exported files out of the browser store into the submission dir.
      const downloads: { name: string; b64: string }[] = await page.evaluate(async () => {
        const storage = await import("/src/lib/browser/storage.ts");
        const records = await storage.records("download:");
        return records.map((record: any) => {
          const bytes = new Uint8Array(record.bytes);
          let binary = "";
          const CHUNK = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
          }
          return { name: record.filename, b64: btoa(binary) };
        });
      });
      for (const download of downloads) {
        fs.writeFileSync(joinInside(submissionDir, download.name), Buffer.from(download.b64, "base64"));
      }
      await context.close();
    } catch (error) {
      fatal = error instanceof Error ? error.message : String(error);
    }

    const graded = fatal ? null : runGrader(taskId, submissionDir);
    const expectedFiles = task.expected_outputs.map(output => output.name);
    const producedFiles = fatal ? [] : fs.readdirSync(submissionDir);
    const gates = graded?.json?.gates ?? [];
    const subchecks = graded?.json?.subchecks ?? [];
    const weighted = subchecks.length
      ? subchecks.reduce((acc: number, check: any) => acc + Number(check.weight ?? 1) * (check.passed ? 1 : 0), 0) / subchecks.reduce((acc: number, check: any) => acc + Number(check.weight ?? 1), 0)
      : 0;
    // Vacuous-pass guard: an empty grader verdict is a harness failure, not a pass.
    const passed = !fatal
      && graded?.ok
      && Array.isArray(gates) && gates.length > 0
      && gates.every((gate: any) => gate.passed)
      && subchecks.every((check: any) => check.passed);
    results.push({
      task_id: taskId, instruction_chars: task.instruction.length,
      expected_files: expectedFiles, produced_files: producedFiles,
      gates, subchecks, weighted_score: Number(weighted.toFixed(3)),
      pass: passed, fatal: fatal ?? null,
      grader_error: graded && !graded.ok ? graded.stderr : null,
      duration_ms: Date.now() - started,
    });
    console.log(`  ${taskId} ${fatal ? "ERROR" : passed ? "PASS" : "FAIL"} gates=${gates.filter((g: any) => g.passed).length}/${gates.length} subchecks=${subchecks.filter((c: any) => c.passed).length}/${subchecks.length} w=${weighted.toFixed(2)}`);
    fs.rmSync(submissionDir, { recursive: true, force: true });
  }
  await browser.close();

  const totals = { tasks: results.length, pass: results.filter(r => r.pass).length, weighted_avg: results.length ? Number((results.reduce((a, r) => a + r.weighted_score, 0) / results.length).toFixed(3)) : 0 };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "geoagentbench.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    source: { repo: "pothos-dev/geoagentbench", cloned_at: fs.statSync(path.join(BENCH, ".git")).mtime.toISOString() },
    subset: { included: INCLUDED, excluded: EXCLUDED, policy: "只收引擎原生支持且输出格式可产出的任务；排除项逐条给原因" },
    scoring: "benchmark 自带 grade.py（gates + 加权 subchecks），非 TIPHYS 自评",
    totals, results,
  }, null, 2) + "\n");

  const lines = [
    "# 外部基准 · GeoAgentBench（兼容子集，单独报告）", "",
    "> 生成：" + new Date().toISOString() + " · 36 任务中适配 " + INCLUDED.length + " 个 · 评分用基准自带 grade.py · **不与 TIPHYS 自有基线混算**", "",
    "| 任务 | 结果 | Gates | Subchecks | 加权 | 耗时 |", "|---|---|---|---|---|---|",
    ...results.map(r => `| ${r.task_id} | ${r.fatal ? "ERROR" : r.pass ? "PASS" : "FAIL"} | ${r.gates.filter((g: any) => g.passed).length}/${r.gates.length} | ${r.subchecks.filter((c: any) => c.passed).length}/${r.subchecks.length} | ${r.weighted_score} | ${(r.duration_ms / 1000).toFixed(0)}s |`),
    "", `合计：${totals.pass}/${totals.tasks} 全过；加权平均 ${totals.weighted_avg}`, "",
    "## 排除任务与原因（36 − " + INCLUDED.length + "）", "",
    ...EXCLUDED.map(item => `- ${item.id}：${item.reason}`), "",
  ];
  for (const r of results.filter(r => !r.pass)) {
    lines.push(`## ${r.task_id}`, "");
    for (const g of r.gates.filter((g: any) => !g.passed)) lines.push(`- ✗ gate ${g.name}：${g.detail}`);
    for (const c of r.subchecks.filter((c: any) => !c.passed)) lines.push(`- ✗ ${c.name}：${String(c.detail).slice(0, 140)}`);
    if (r.fatal) lines.push(`- 驱动器错误：${r.fatal}`);
    if (r.grader_error) lines.push(`- 评分器错误：${r.grader_error}`);
    lines.push(`- 产物：${JSON.stringify(r.produced_files)}（期望 ${JSON.stringify(r.expected_files)}）`, "");
  }
  fs.writeFileSync(path.join(OUT_DIR, "geoagentbench.md"), lines.join("\n") + "\n");
  console.log(`\n${totals.pass}/${totals.tasks} 全过，加权 ${totals.weighted_avg}；报告 docs/baselines/stage4/geoagentbench.md`);
}

await main();
