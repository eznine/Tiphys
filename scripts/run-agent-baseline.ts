/**
 * Stage 4 model-in-the-loop baseline (roadmap §4 阶段 4 · 任务 1).
 *
 * Drives the REAL web app (vite dev server on 1420, required to be running)
 * in headless Chrome via Playwright. Each of the 30 fixed stage-0 tasks gets a
 * fresh browser context: fixtures are preloaded through the real import path,
 * the natural-language prompt is sent once to the browser agent, and the
 * driver reacts only to product-level interaction points (export approvals,
 * explicit cancel). Everything the model does is captured from the event
 * stream; success is scored against tests/baseline/agent-success.json, which
 * only references observable facts (new layers, events, notices, text).
 *
 * This is a MEASUREMENT run, not a CI gate: the exit code is 0 unless the
 * harness itself is broken. Numbers land in docs/baselines/stage4/.
 *
 *   npm run dev            # terminal 1 (this harness does not start it)
 *   npm run baseline:agent # terminal 2
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { auditRuns, type PlanRun } from "../shared/plans.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TASKS_PATH = path.join(ROOT, "tests", "baseline", "tasks.json");
const SUCCESS_PATH = path.join(ROOT, "tests", "baseline", "agent-success.json");
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage4");
const APP = "http://127.0.0.1:1420/";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean) as string[];

type Criteria = Record<string, any> & { type: string; severity?: "gate" | "warn"; checks?: Criteria[] };
type AgentTask = { task: string; preload: string[]; criteria: Criteria[]; interaction?: { autoApprove?: boolean; cancelFirstJob?: boolean };
  seedDownload?: { name: string }; timeoutMs?: number; comment?: string };
type Event = { type: string; ts?: number; seq?: number; [key: string]: any };

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const prefix = "--" + name + "=";
  for (const item of argv) if (item.slice(0, prefix.length) === prefix) return item.slice(prefix.length);
  return undefined;
}
const only = flagValue("only")?.split(",").filter(Boolean);
const arm = flagValue("arm") ?? "current";

const tasksFile = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8")) as { fixtures: Record<string, string>; tasks: { id: string; prompt: string; expected_tools: string[] }[] };
const successFile = JSON.parse(fs.readFileSync(SUCCESS_PATH, "utf8")) as { model: string; tasks: AgentTask[] };

const rad = (deg: number) => deg * Math.PI / 180;
function sphericalDistance(a: number[], b: number[]): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

type Outcome = { type: string; ok: boolean; detail: string; severity: "gate" | "warn" };

type TaskRecord = {
  layers: any[];
  layerGeo: Record<string, any>;
  sourceGeo: any;
  events: Event[];
  preLayerIds: string[];
};

function evaluate(c: Criteria, ctx: TaskRecord, durationMs: number): Outcome {
  const severity = c.severity === "warn" ? "warn" : "gate";
  const newLayers = ctx.layers.filter(l => !ctx.preLayerIds.includes(l.id));
  const done = (ok: boolean, detail: string): Outcome => ({ type: c.type, ok, detail, severity });
  switch (c.type) {
    case "new_layer": {
      const match = newLayers.find(l =>
        (!c.crs || l.crs === c.crs)
        && (!c.geometryContains || (c.geometryContains as string[]).some(g => (l.geometry_types ?? []).includes(g)))
        && (!c.featureCount || (() => { const n = Number(l.feature_count), v = c.featureCount; return v.op === "gte" ? n >= v.value : v.op === "lte" ? n <= v.value : n === v.value; })()));
      return done(!!match, match ? `新图层「${match.name}」(${match.crs}, ${match.feature_count} 要素)` : `没有满足条件的新图层（新增 ${newLayers.length} 层）`);
    }
    case "new_raster": {
      const match = newLayers.find(l => {
        const raster = l.raster;
        if (!raster) return false;
        if (c.dimsPositive) return raster.width > 0 && raster.height > 0;
        return raster.width === c.width && raster.height === c.height;
      });
      return done(!!match, match ? `新栅格 ${match.raster.width}x${match.raster.height}` : "没有满足条件的新栅格");
    }
    case "radius": {
      const points: number[][] = (ctx.sourceGeo?.features ?? []).filter((f: any) => f.geometry?.type === "Point").map((f: any) => f.geometry.coordinates);
      let worst: { layer: string; delta: number; checked: number } | null = null;
      for (const layer of newLayers) {
        const geo = ctx.layerGeo[layer.id];
        if (!geo) continue;
        let maxDelta = 0, checked = 0;
        for (const feature of geo.features ?? []) {
          const rings: number[][][] = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates : feature.geometry?.type === "MultiPolygon" ? feature.geometry.coordinates.flat() : [];
          for (const ring of rings) for (const vertex of ring) {
            maxDelta = Math.max(maxDelta, Math.min(...points.map(p => Math.abs(sphericalDistance(p, vertex) - c.distance))));
            checked++;
          }
        }
        if (checked && (!worst || maxDelta < worst.delta)) worst = { layer: layer.name, delta: maxDelta, checked };
      }
      return done(!!worst && worst.delta <= c.tol, worst ? `「${worst.layer}」${worst.checked} 顶点最大偏差 ${worst.delta.toFixed(2)} m（容差 ${c.tol}）` : "没有可复核的缓冲几何");
    }
    case "field_on_new_layer": {
      for (const layer of newLayers) {
        const geo = ctx.layerGeo[layer.id];
        const value = Number(geo?.features?.[0]?.properties?.[c.field]);
        if (c.between) { if (Number.isFinite(value) && value >= c.between[0] && value <= c.between[1]) return done(true, `${layer.name}.${c.field}=${value}`); }
        else if (geo?.features?.[0]?.properties && c.field in geo.features[0].properties) return done(true, `${layer.name} 有字段 ${c.field}`);
      }
      return done(false, `新图层上没有字段 ${c.field} 或数值不在区间`);
    }
    case "renamed_to": {
      const hit = ctx.layers.find(l => l.name === c.name);
      return done(!!hit, hit ? `已改名「${c.name}」` : "没有找到改名后的图层");
    }
    case "export_notice": {
      const hit = ctx.events.find(e => e.type === "notice" && typeof e.filename === "string" && e.filename.includes(c.filename));
      return done(!!hit, hit ? `导出 ${hit.filename}` : "没有导出通知");
    }
    case "tool_called": {
      const hit = ctx.events.find(e => e.type === "tool-call" && e.toolName === c.name);
      return done(!!hit, hit ? `调用了 ${c.name}` : `没有调用 ${c.name}`);
    }
    case "tool_called_any": {
      const names = new Set(c.names as string[]);
      const hit = ctx.events.find(e => e.type === "tool-call" && names.has(e.toolName));
      return done(!!hit, hit ? `调用了 ${hit.toolName}` : `没有调用 ${c.names.join("/")}`);
    }
    case "tool_error_contains": {
      const hit = ctx.events.find(e => e.type === "tool-error" && new RegExp(String(c.pattern), "i").test(String(e.error ?? "")));
      return done(!!hit, hit ? `工具错误：${String(hit.error).slice(0, 90)}` : "没有匹配的工具错误");
    }
    case "tool_result_field": {
      const hit = ctx.events.find(e => e.type === "tool-result" && e.toolName === c.tool && Number(e.output?.[c.field]) === Number(e.output?.[c.field]));
      if (!hit) return done(false, `没有 ${c.tool} 的结果事件`);
      const value = Number(hit.output[c.field]);
      return done(Math.abs(value - Number(c.value)) <= Number(c.tol ?? 0), `${c.field}=${value}（期望 ${c.value}±${c.tol ?? 0}）`);
    }
    case "view_command": {
      const hit = ctx.events.find(e => e.type === "view-command" && e.command?.action === c.action);
      return done(!!hit, hit ? `视图命令 ${c.action}` : "没有视图命令");
    }
    case "job_cancelled": {
      const hit = ctx.events.find(e => e.type === "job" && e.status === "cancelled");
      return done(!!hit, hit ? "任务已取消" : "没有已取消的 job");
    }
    case "no_new_layer": return done(newLayers.length === 0, `新增图层 ${newLayers.length} 个`);
    case "text_contains": {
      const text = ctx.events.filter(e => e.type === "assistant-text").map(e => String(e.text ?? "")).join("\n");
      return done(new RegExp(String(c.pattern), "i").test(text), `回答 ${new RegExp(String(c.pattern), "i").test(text) ? "包含" : "不包含"} /${c.pattern}/`);
    }
    case "text_only_clarifies": {
      const anyTool = ctx.events.some(e => e.type === "tool-call");
      const text = ctx.events.filter(e => e.type === "assistant-text").map(e => String(e.text ?? "")).join("\n");
      const matches = new RegExp(String(c.pattern), "i").test(text);
      return done(!anyTool && matches, anyTool ? "模型直接调用了工具（未先澄清）" : matches ? "只追问、未乱跑工具" : "既没追问也没匹配文本");
    }
    case "duration_budget_ms": return done(durationMs <= Number(c.max), `${(durationMs / 1000).toFixed(1)} s ≤ ${c.max / 1000} s`);
    case "any_of": {
      const sub = (c.checks ?? []).map(item => evaluate(item, ctx, durationMs));
      return { type: "any_of", ok: sub.some(item => item.ok), detail: sub.map(item => `${item.ok ? "✓" : "✗"} ${item.detail}`).join(" | "), severity };
    }
    default: return done(false, "未知判据 " + c.type);
  }
}

async function main() {
  const probe = await fetch(APP, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (!probe) {
    console.error("开发服务器未启动：请先在另一个终端运行 npm run dev（1420 端口），再执行本脚本。本次不编造任何结果。");
    process.exit(2);
  }
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) { console.error("找不到 Chrome/Edge 可执行文件（可用 CHROME_PATH 指定）。"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });

  const modelInfo = await (async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(APP, { waitUntil: "domcontentloaded" });
      return await page.evaluate(async () => {
        const agent = await import("/src/lib/browser/agent.ts");
        return agent.browserAgentRequest("/health").then(r => r.json());
      });
    } catch {
      return {} as any;
    } finally {
      await context.close();
    }
  })();
  console.log("model:", modelInfo?.model ?? "未知", "| provider:", modelInfo?.provider ?? "未知", "| keySource:", modelInfo?.keySource ?? "未知");

  const selected = successFile.tasks.filter(task => !only || only.includes(task.task));
  const results: any[] = [];
  const allPlanRuns: PlanRun[] = [];

  for (const spec of selected) {
    const taskInfo = tasksFile.tasks.find(t => t.id === spec.task)!;
    const started = Date.now();
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => console.log(`  [${spec.task}] pageerror: ${String(error).slice(0, 160)}`));
    let record: TaskRecord = { layers: [], layerGeo: {}, sourceGeo: null, events: [], preLayerIds: [] };
    let fatal: string | undefined;
    let preloadedIds: string[] = [];
    try {
      // The dev server occasionally stalls on first compile after edits; retry once.
      await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 }));
      await page.waitForTimeout(1200);

      // Preload fixtures + optional download seed through the real product path.
      preloadedIds = await page.evaluate(async (payload: { fixtures: { name: string; b64: string }[]; seed?: string }) => {
        const engine = await import("/src/lib/browser/engine.ts");
        const storage = await import("/src/lib/browser/storage.ts");
        for (const fixture of payload.fixtures) {
          const bytes = Uint8Array.from(atob(fixture.b64), ch => ch.charCodeAt(0));
          await engine.importBrowserFile(new Blob([bytes]), fixture.name);
        }
        if (payload.seed) await storage.writeRecord("download:" + payload.seed, { filename: payload.seed, bytes: new Uint8Array([123]) });
        return (await engine.browserLayers()).map((l: any) => l.id);
      }, {
        fixtures: spec.preload.map(key => {
          const relative = tasksFile.fixtures[key];
          return { name: path.basename(relative), b64: fs.readFileSync(path.join(ROOT, relative)).toString("base64") };
        }),
        seed: spec.seedDownload?.name,
      });

      const session = spec.task + "_" + Date.now().toString(36);
      await page.evaluate(async (payload: { session: string; text: string }) => {
        const agent = await import("/src/lib/browser/agent.ts");
        const response = await agent.browserAgentRequest("/chat?session=" + payload.session, { method: "POST", body: JSON.stringify({ text: payload.text }) });
        if (!response.ok) throw new Error("chat rejected: " + await response.text());
      }, { session, text: taskInfo.prompt });

      const deadline = Date.now() + (spec.timeoutMs ?? 240000);
      let cancelledJob = false;
      let events: Event[] = [];
      for (;;) {
        await page.waitForTimeout(spec.interaction?.cancelFirstJob ? 150 : 700);
        const snapshot: any = await page.evaluate(async (session: string) => {
          const agent = await import("/src/lib/browser/agent.ts");
          const response = await agent.browserAgentRequest("/history?session=" + session);
          return response.json();
        }, session);
        events = snapshot.events ?? [];
        if (spec.interaction?.cancelFirstJob && !cancelledJob) {
          const running = events.find(e => e.type === "job" && ["queued", "running"].includes(e.status) && e.jobId);
          if (running) {
            // Cancel through the agent's own engine instance: after Vite HMR a
            // freshly imported engine module lacks the live job controllers.
            await page.evaluate(async (payload: { session: string; jobId: string }) => {
              const agent = await import("/src/lib/browser/agent.ts");
              await agent.browserAgentRequest("/jobs/cancel?session=" + payload.session, { method: "POST", body: JSON.stringify({ jobId: payload.jobId }) });
            }, { session, jobId: running.jobId });
            cancelledJob = true;
          }
        }
        if (spec.interaction?.autoApprove) {
          for (const id of snapshot.pendingApprovals ?? []) {
            await page.evaluate(async (payload: { session: string; id: string }) => {
              const agent = await import("/src/lib/browser/agent.ts");
              await agent.browserAgentRequest("/approve?session=" + payload.session, { method: "POST", body: JSON.stringify({ approved: true, toolCallId: payload.id }) });
            }, { session, id });
          }
        }
        const last = events[events.length - 1];
        if (last?.type === "turn-end" || Date.now() > deadline) break;
      }

      const post: any = await page.evaluate(async () => {
        const engine = await import("/src/lib/browser/engine.ts");
        const storage = await import("/src/lib/browser/storage.ts");
        const layers = await engine.browserLayers();
        const layerGeo: Record<string, any> = {};
        for (const layer of layers) {
          const stored = await storage.readRecord("layer:" + layer.id);
          if (stored?.geojson) layerGeo[layer.id] = stored.geojson;
        }
        const planRuns = await storage.records("plan-run:");
        return { layers: layers.map(({ url, ...rest }: any) => rest), layerGeo, planRuns };
      });
      record = { layers: post.layers, layerGeo: post.layerGeo, sourceGeo: null, events, preLayerIds: preloadedIds };
      allPlanRuns.push(...(post.planRuns ?? []));
    } catch (error) {
      fatal = error instanceof Error ? error.message : String(error);
    } finally {
      await context.close();
    }

    const durationMs = Date.now() - started;
    const sourceName = path.basename(tasksFile.fixtures[spec.preload[0]] ?? "").replace(/\.[^.]+$/, "");
    record.sourceGeo = record.layerGeo[Object.keys(record.layerGeo).find(id => record.layers.find(l => l.id === id)?.name === sourceName) ?? ""];
    const outcomes: Outcome[] = fatal
      ? [{ type: "harness", ok: false, detail: fatal, severity: "gate" }]
      : spec.criteria.map(c => evaluate(c, record, durationMs));
    const gates = outcomes.filter(o => o.severity === "gate");
    const status = fatal ? "ERROR" : gates.every(o => o.ok) ? "PASS" : "FAIL";
    const toolCalls = record.events.filter(e => e.type === "tool-call").map(e => e.toolName);
    const usage = record.events.filter(e => e.type === "usage").reduce((acc, e) => ({ input: acc.input + (e.inputTokens ?? 0), output: acc.output + (e.outputTokens ?? 0) }), { input: 0, output: 0 });
    const expectedHit = taskInfo.expected_tools.some(tool => toolCalls.includes(tool));
    results.push({
      task: spec.task, prompt: taskInfo.prompt, status, duration_ms: durationMs, fatal: fatal ?? null,
      tool_calls: toolCalls, tool_errors: record.events.filter(e => e.type === "tool-error").map(e => ({ tool: e.toolName, error: String(e.error).slice(0, 200) })),
      expected_tool_hit: expectedHit, usage, criteria: outcomes,
      final_layers: record.layers.map((l: any) => ({ name: l.name, crs: l.crs, feature_count: l.feature_count, geometry_types: l.geometry_types })),
      transcript_tail: record.events.filter(e => ["assistant-text", "notice", "error"].includes(e.type)).slice(-6).map(e => ({ type: e.type, text: String(e.text ?? e.error ?? "").slice(0, 200) })),
    });
    console.log(`  ${spec.task} ${status} (${gates.filter(o => o.ok).length}/${gates.length} gates) ${toolCalls.length} 工具调用 ${(durationMs / 1000).toFixed(0)}s${fatal ? " FATAL:" + fatal.slice(0, 80) : ""}`);
  }
  await browser.close();

  // --merge=<simple-name>: a rerun-only pass patches the existing report in
  // OUT_DIR (keyed by task id) instead of replacing the whole file.
  const mergeFlag = (() => { const prefix = "--merge="; for (const item of argv) if (item.slice(0, prefix.length) === prefix) return item.slice(prefix.length); return undefined; })();
  if (mergeFlag) {
    if (!/^[\w.-]{1,64}$/.test(mergeFlag)) { console.error("merge 只接受简单文件名。"); process.exit(2); }
    const mergePath = path.join(OUT_DIR, mergeFlag);
    if (!mergePath.startsWith(OUT_DIR + path.sep) || !fs.existsSync(mergePath)) { console.error("merge 目标不存在。"); process.exit(2); }
    const previous = JSON.parse(fs.readFileSync(mergePath, "utf8")) as { results: any[] };
    const rerunIds = new Set(results.map(r => r.task));
    const merged = [...previous.results.filter(r => !rerunIds.has(r.task)), ...results]
      .sort((a, b) => a.task.localeCompare(b.task));
    results.length = 0;
    results.push(...merged);
  }

  const totals = {
    tasks: results.length,
    pass: results.filter(r => r.status === "PASS").length,
    fail: results.filter(r => r.status === "FAIL").length,
    error: results.filter(r => r.status === "ERROR").length,
    expected_tool_hit: results.filter(r => r.expected_tool_hit).length,
    usage: results.reduce((acc: any, r: any) => ({ input: acc.input + r.usage.input, output: acc.output + r.usage.output }), { input: 0, output: 0 }),
  };
  const audit = auditRuns(allPlanRuns);
  const summary = {
    generated_at: new Date().toISOString(),
    mode: "agent-in-the-loop",
    arm,
    model: { name: modelInfo?.model ?? "未知", provider: modelInfo?.provider ?? "未知", keySource: modelInfo?.keySource ?? "未知" },
    tasks_file_sha256: crypto.createHash("sha256").update(fs.readFileSync(TASKS_PATH)).digest("hex"),
    totals,
    plan_tool_usage: { runs: allPlanRuns.length, audit_ok: audit.ok, violations: audit.violations.slice(0, 5) },
    results,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const suffix = arm === "current" ? "" : "-" + arm;
  fs.writeFileSync(path.join(OUT_DIR, "agent-baseline" + suffix + ".json"), JSON.stringify(summary, null, 2) + "\n");
  const lines = [
    "# 阶段 4 · 模型在环基线（浏览器 Agent，真实页面）", "",
    "> 生成：" + summary.generated_at + " · arm: " + arm + " · 模型: " + summary.model.name + "（" + summary.model.keySource + "）", "",
    "| 任务 | 结果 | 工具链 | 命中预期工具 | 耗时 |", "|---|---|---|---|---|",
  ];
  for (const r of results) lines.push(`| ${r.task} | ${r.status} | ${r.tool_calls.join("→").slice(0, 90)} | ${r.expected_tool_hit ? "✓" : "✗"} | ${(r.duration_ms / 1000).toFixed(0)}s |`);
  lines.push("", `合计：${totals.pass} PASS / ${totals.fail} FAIL / ${totals.error} ERROR（${totals.tasks} 任务）· 预期工具命中 ${totals.expected_tool_hit}/${totals.tasks} · tokens 输入 ${totals.usage.input} / 输出 ${totals.usage.output}`);
  if (allPlanRuns.length) lines.push("", `run_plan 使用：${allPlanRuns.length} 次，审计 ${audit.ok ? "通过" : "违规"}`);
  lines.push("");
  for (const r of results.filter(r => r.status !== "PASS")) {
    lines.push(`## ${r.task} ${r.status}`, "");
    if (r.fatal) lines.push(`- 驱动器错误：${r.fatal}`);
    for (const c of r.criteria.filter((o: any) => !o.ok)) lines.push(`- ${c.severity === "warn" ? "⚠" : "✗"} ${c.type}：${c.detail}`);
    for (const e of r.tool_errors) lines.push(`- 工具错误 ${e.tool}：${e.error}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT_DIR, "agent-baseline" + suffix + ".md"), lines.join("\n") + "\n");
  console.log(`\n${totals.pass}/${totals.tasks} PASS；报告已写入 docs/baselines/stage4/agent-baseline${suffix}.md`);
}

await main();
