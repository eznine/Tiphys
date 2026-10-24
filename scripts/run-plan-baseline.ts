/**
 * Stage 3 plan-execution baseline (roadmap §4 阶段 3 验收).
 *
 * Runs the 11 fixed plan tasks from tests/plans/plan-tasks.json against the
 * REAL browser WASM engine. Every task gets its own child process: a WASM
 * panic must not poison the next task (stage 0 lesson).
 *
 * Process hygiene: the parent writes a queue file into a fresh temp dir and
 * spawns children with a numeric index and that dir — no task JSON content ever
 * reaches the spawn call (static argv array, no shell), and every child path is
 * boundary-checked against the temp dir.
 *
 * Beyond pass/fail, the child performs an independent recomputation of what
 * the executor claims: every recorded output layer is re-read from storage and
 * its sha256 re-derived; the parent then runs auditRuns() over all runs, which
 * enforces the no-fake-completion invariants. Reproduce with:  npm run baseline:plans
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
import { auditRuns, executePlan, resumePlan, type Plan, type PlanRun } from "../shared/plans.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = path.resolve(import.meta.filename);
const TASKS_PATH = path.join(ROOT, "tests", "plans", "plan-tasks.json");
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage3");
const LOADER = path.join(ROOT, "agent", "node_modules", "tsx", "dist", "loader.mjs");
const WASM_DIR = path.join(ROOT, "node_modules", "geolibre-wasm");

type TaskFile = {
  fixtures: Record<string, string>;
  tasks: {
    id: string; title: string; goal: string; fixtures: string[]; steps: unknown[];
    confirmations?: string[]; inject?: { step: string; message: string }; resume?: boolean;
    expect: Record<string, unknown>; expectResume?: Record<string, unknown>;
  }[];
};

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const prefix = "--" + name + "=";
  for (const item of argv) if (item.slice(0, prefix.length) === prefix) return item.slice(prefix.length);
  return undefined;
}
const isChild = process.env.TIPHYS_PLAN_CHILD === "1";
const queueDir = process.env.TIPHYS_PLAN_DIR;
const queueIndex = Number(process.env.TIPHYS_PLAN_INDEX ?? flagValue("index"));
const only = flagValue("only")?.split(",").filter(Boolean);

const tasksFile = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8")) as TaskFile;
const sha256 = (input: Uint8Array) => crypto.createHash("sha256").update(input as any).digest("hex");
const spawnChild = spawnSync;

/** Boundary-checked join: the result must stay inside `root`. */
function joinInside(root: string, name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("不安全的文件名：" + name);
  const target = path.join(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error("路径越界：" + name);
  return target;
}

type ExpectOutcome = { name: string; ok: boolean; detail: string };

function evaluateExpectations(label: string, run: PlanRun, expect: Record<string, unknown>): ExpectOutcome[] {
  const outcomes: ExpectOutcome[] = [];
  const add = (name: string, ok: boolean, detail: string) => outcomes.push({ name: label + "." + name, ok, detail });
  if (typeof expect.status === "string") add("status", run.status === expect.status, "status=" + run.status + "（要求 " + expect.status + "）");
  if (typeof expect.blockedClass === "string") add("blockedClass", run.honest.blockedAt?.errorClass === expect.blockedClass,
    "blockedAt=" + (run.honest.blockedAt?.errorClass ?? "无") + "（要求 " + expect.blockedClass + "）");
  if (typeof expect.deliverablesMin === "number") add("deliverablesMin", run.honest.deliverables.length >= expect.deliverablesMin,
    "deliverables=" + run.honest.deliverables.length + "（≥ " + expect.deliverablesMin + "）");
  if (expect.acceptanceAllOk === true) {
    const failed = run.steps.flatMap(step => (step.acceptance ?? []).filter(item => !item.ok).map(item => step.stepId + ":" + item.detail));
    add("acceptanceAllOk", failed.length === 0, failed.length ? failed.join("；") : "全部验收通过");
  }
  if (typeof expect.executedSteps === "number") {
    const executed = run.steps.filter(step => !step.reused && (step.phase === "pass" || step.phase === "noop")).length;
    add("executedSteps", executed === expect.executedSteps, "实际执行 " + executed + " 步（要求 " + expect.executedSteps + "）");
  }
  if (typeof expect.reusedMin === "number") {
    const reused = run.steps.filter(step => step.reused).length;
    add("reusedMin", reused >= expect.reusedMin, "复用 " + reused + " 步（≥ " + expect.reusedMin + "）");
  }
  if (typeof expect.headlinePattern === "string") add("headlinePattern", new RegExp(String(expect.headlinePattern)).test(run.honest.headline),
    "headline=" + run.honest.headline);
  return outcomes;
}

/** Independent recomputation: outputs the run claims must still exist with the same digest. */
async function recomputeRun(run: PlanRun): Promise<ExpectOutcome[]> {
  const outcomes: ExpectOutcome[] = [];
  for (const step of run.steps) {
    if (!step.outputLayer) continue;
    const stored = await readRecord<{ bytes?: Uint8Array }>("layer:" + step.outputLayer.id);
    const digest = stored?.bytes ? sha256(new Uint8Array(stored.bytes)) : null;
    const ok = !!digest && (!step.outputLayer.sha256 || step.outputLayer.sha256 === digest);
    outcomes.push({ name: "recompute." + run.runId + "." + step.stepId, ok,
      detail: ok ? "图层 " + step.outputLayer.id + " 摘要复验一致"
        : "图层 " + step.outputLayer.id + " 摘要不一致：记录 " + (step.outputLayer.sha256?.slice(0, 12) ?? "无") + " vs 复算 " + (digest?.slice(0, 12) ?? "无") });
  }
  return outcomes;
}

async function mainChild(): Promise<void> {
  if (!queueDir || !Number.isInteger(queueIndex)) throw new Error("child needs TIPHYS_PLAN_DIR and TIPHYS_PLAN_INDEX");
  const queue = JSON.parse(fs.readFileSync(joinInside(queueDir, "queue.json"), "utf8")) as string[];
  const taskId = queue[queueIndex];
  const task = tasksFile.tasks.find(item => item.id === taskId)!;
  const outFile = joinInside(queueDir, String(queueIndex) + ".json");

  await initTools(fs.readFileSync(path.join(WASM_DIR, "geolibre-cli.wasm")));
  await initLibrary({ module_or_path: fs.readFileSync(path.join(WASM_DIR, "geolibre_wasm_bg.wasm")) });

  // Preload fixtures (plans reference layers by their file-stem names).
  const preloaded: Record<string, unknown>[] = [];
  for (const key of task.fixtures) {
    const relative = tasksFile.fixtures[key];
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    const imported = await importBrowserFile(new Blob([new Uint8Array(bytes)]), path.basename(relative));
    preloaded.push({ fixture: key, layerId: imported.layer.id, name: imported.layer.name, sha256: sha256(new Uint8Array(bytes)) });
  }

  const plan: Plan = { goal: task.goal, steps: task.steps as Plan["steps"], confirmations: task.confirmations };
  const run1 = await executePlan(plan, browserPlanAdapter, {
    runId: "plan_" + task.id + "_1",
    failStep: task.inject ? { stepId: task.inject.step, message: task.inject.message } : undefined,
  });
  const runs: PlanRun[] = [run1];
  const expects: ExpectOutcome[] = [...evaluateExpectations("run1", run1, task.expect), ...(await recomputeRun(run1))];

  let run2: PlanRun | undefined;
  if (task.resume) {
    run2 = await resumePlan(run1, plan, browserPlanAdapter, { runId: "plan_" + task.id + "_2" });
    runs.push(run2);
    if (task.expectResume) expects.push(...evaluateExpectations("resume", run2, task.expectResume));
    expects.push(...(await recomputeRun(run2)));
  }

  const result = {
    task: task.id, title: task.title, goal: task.goal,
    environment: { node: process.version, engine: "geolibre-wasm 1.7.1", preloadedLayers: preloaded },
    runs: runs.map(run => ({ runId: run.runId, status: run.status, resumedFrom: run.resumedFrom ?? null, durationMs: run.durationMs ?? null, planIssues: run.planIssues, run })),
    expects,
  };
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  const failed = expects.filter(item => !item.ok);
  console.log("  " + task.id + " " + (failed.length === 0 ? "PASS" : "FAIL") + " (" + (expects.length - failed.length) + "/" + expects.length + ")" + (failed.length ? " — " + failed.map(f => f.name).join(",") : ""));
  process.exitCode = failed.length ? 1 : 0;
}

function mainParent(): void {
  const selected = tasksFile.tasks.filter(task => !only || only.includes(task.id));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-plans-"));
  fs.writeFileSync(joinInside(tmpDir, "queue.json"), JSON.stringify(selected.map(task => task.id)));
  const results: any[] = [];
  const childArgs = ["--import", pathToFileURL(LOADER).href, SELF];
  for (let index = 0; index < selected.length; index++) {
    const child = spawnChild(process.execPath, childArgs, {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, TIPHYS_PLAN_CHILD: "1", TIPHYS_PLAN_DIR: tmpDir, TIPHYS_PLAN_INDEX: String(index) },
      windowsHide: true,
    });
    const resultFile = joinInside(tmpDir, String(index) + ".json");
    if (!fs.existsSync(resultFile)) {
      results.push({ task: selected[index].id, title: selected[index].title, fatal: "child exited with " + child.status,
        expects: [{ name: "process", ok: false, detail: "子进程退出码 " + child.status }] });
      continue;
    }
    results.push(JSON.parse(fs.readFileSync(resultFile, "utf8")));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const allRuns = results.flatMap(result => (result.runs ?? []).map((entry: any) => entry.run)) as PlanRun[];
  const audit = auditRuns(allRuns);
  const failedTasks = results.filter(result => (result.expects ?? []).some((item: any) => !item.ok));
  const summary = {
    generated_at: new Date().toISOString(),
    mode: "plan-executor",
    tasks_file: { path: path.relative(ROOT, TASKS_PATH), sha256: sha256(fs.readFileSync(TASKS_PATH)) },
    totals: {
      tasks: results.length, passed: results.length - failedTasks.length, failed: failedTasks.length,
      runs: allRuns.length,
      completed: allRuns.filter(run => run.status === "completed").length,
      failed_runs: allRuns.filter(run => run.status === "failed").length,
      cancelled: allRuns.filter(run => run.status === "cancelled").length,
      honest_rejections: allRuns.filter(run => run.planIssues.length > 0).length,
    },
    audit: { ok: audit.ok, violations: audit.violations },
    results: results.map(result => ({
      task: result.task, title: result.title,
      runs: (result.runs ?? []).map((entry: any) => ({ runId: entry.runId, status: entry.status, resumedFrom: entry.resumedFrom, durationMs: entry.durationMs })),
      expects: result.expects, fatal: result.fatal ?? null,
    })),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "plan-baseline.json"), JSON.stringify({ ...summary, runs: allRuns }, null, 2) + "\n");

  const lines: string[] = [
    "# 阶段 3 计划执行基线（真实 WASM 引擎）", "",
    "> 生成：" + summary.generated_at + " · 每任务独立子进程 · 任务集 sha256 `" + summary.tasks_file.sha256.slice(0, 16) + "…`", "",
    "| 任务 | 标题 | 结果 | 断言 | 运行 |", "|---|---|---|---|---|",
  ];
  for (const result of results) {
    const ok = !(result.expects ?? []).some((item: any) => !item.ok);
    const total = (result.expects ?? []).length;
    const failedCount = (result.expects ?? []).filter((i: any) => !i.ok).length;
    const runs = (result.runs ?? []).map((entry: any) => entry.status).join("→");
    lines.push("| " + result.task + " | " + result.title + " | " + (ok ? "PASS" : "FAIL") + " | " + (total - failedCount) + "/" + total + " | " + runs + " |");
  }
  lines.push("", "合计：" + summary.totals.passed + "/" + summary.totals.tasks + " 任务通过 · " + summary.totals.runs + " 次运行（" + summary.totals.completed + " completed / " + summary.totals.failed_runs + " failed，其中 " + summary.totals.honest_rejections + " 次为计划期诚实拒绝）");
  lines.push("", "审计不变量（auditRuns）：" + (audit.ok ? "通过" : "违反 " + audit.violations.length + " 条"), "");
  for (const result of results) {
    const failed = (result.expects ?? []).filter((item: any) => !item.ok);
    if (!failed.length) continue;
    lines.push("## " + result.task + " " + (result.title ?? ""), "");
    for (const item of failed) lines.push("- ✗ " + item.name + "：" + item.detail);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT_DIR, "plan-baseline.md"), lines.join("\n") + "\n");

  console.log("\n" + summary.totals.passed + "/" + summary.totals.tasks + " 任务通过；auditRuns " + (audit.ok ? "OK" : "VIOLATIONS: " + audit.violations.join("; ")));
  console.log("wrote docs/baselines/stage3/plan-baseline.{json,md}");
  process.exitCode = failedTasks.length || !audit.ok ? 1 : 0;
}

if (isChild) await mainChild();
else mainParent();
