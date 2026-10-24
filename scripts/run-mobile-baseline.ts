/**
 * Stage 4 mobile baseline (roadmap §4 阶段 4 · 任务 3/4 验收).
 *
 * Drives the real web app in an emulated iPhone 12 (390×844, touch) via
 * Playwright. Five non-view GIS tasks close the loop through the mobile task
 * cards: tap card → engine/data/budget explanation → local WASM run →
 * acceptance verdict → deliverable layer + export link. Plus two degradation
 * cases: an over-budget raster is refused before any computation, and a
 * same-layer clip is blocked with a reason. One lifecycle probe backgrounds
 * the tab mid-run and expects the loop to finish after returning.
 *
 *   npm run dev              # terminal 1
 *   npm run baseline:mobile  # terminal 2
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage4");
const APP = "http://127.0.0.1:1420/";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean) as string[];

type Scenario = {
  id: string;
  title: string;
  fixtures: { key: string; file: string }[];
  card: string;
  /** Optional in-panel tweaks before running (e.g. choose the oversized DEM). */
  prepare?: string;
  /** Background the tab right after tapping run (lifecycle probe). */
  backgroundDuringRun?: boolean;
  /** Per-scenario job observation budget; default 120s. */
  timeoutMs?: number;
  expect: { status?: "completed" | "failed"; blocked?: boolean; export?: boolean; noFailedAcceptance?: boolean };
};

const SCENARIOS: Scenario[] = [
  { id: "M1", title: "点缓冲任务卡闭环（含导出）", fixtures: [{ key: "pts", file: "samples/beijing_points.geojson" }],
    card: "点缓冲服务圈", expect: { status: "completed", noFailedAcceptance: true, export: true } },
  { id: "M2", title: "面裁剪任务卡闭环", fixtures: [{ key: "zones", file: "tests/fixtures/district_zones.geojson" }, { key: "mask", file: "tests/fixtures/zone_a.geojson" }],
    card: "面裁剪", expect: { status: "completed", noFailedAcceptance: true } },
  { id: "M3", title: "叠加求交与面积任务卡闭环", fixtures: [{ key: "zones", file: "tests/fixtures/district_zones.geojson" }, { key: "mask", file: "tests/fixtures/zone_a.geojson" }],
    card: "叠加求交与面积", expect: { status: "completed", noFailedAcceptance: true } },
  { id: "M4", title: "字段统计任务卡闭环（只读）", fixtures: [{ key: "zones", file: "tests/fixtures/district_zones.geojson" }],
    card: "字段统计", expect: { status: "completed", noFailedAcceptance: true } },
  { id: "M5", title: "DEM 坡度任务卡闭环 + 短暂后台恢复", fixtures: [{ key: "dem", file: "tests/fixtures/dem_hills.tif" }],
    card: "DEM 坡度与山体阴影", backgroundDuringRun: true, expect: { status: "completed", noFailedAcceptance: true } },
  { id: "M6", title: "超预算栅格在执行前被拒绝", fixtures: [{ key: "big", file: "tests/fixtures/dem_over_budget.tif" }],
    card: "DEM 坡度与山体阴影", prepare: "big", expect: { blocked: true } },
  { id: "M7", title: "同图层裁剪被阻止并给出降级说明", fixtures: [{ key: "zones", file: "tests/fixtures/district_zones.geojson" }],
    card: "面裁剪", prepare: "same", expect: { blocked: true } },
  { id: "M8", title: "河网任务卡闭环（5 步链，手机预算内）", fixtures: [{ key: "dem", file: "tests/fixtures/dem_hills.tif" }],
    card: "DEM 河网提取", expect: { status: "completed", noFailedAcceptance: true } },
  { id: "M9", title: "服务圈任务卡闭环（双图层 + 统计）", fixtures: [{ key: "schools", file: "tests/fixtures/schools.geojson" }, { key: "homes", file: "tests/fixtures/residential.geojson" }],
    card: "学校服务圈统计", expect: { status: "completed", noFailedAcceptance: true } },
];

const argv = process.argv.slice(2);
const onlyFlag = (() => { const prefix = "--only="; for (const item of argv) if (item.slice(0, prefix.length) === prefix) return item.slice(prefix.length).split(",").filter(Boolean); return undefined; })();

async function main() {
  const probe = await fetch(APP, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (!probe) { console.error("开发服务器未启动：请先在另一个终端运行 npm run dev。本次不编造任何结果。"); process.exit(2); }
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) { console.error("找不到 Chrome/Edge（可用 CHROME_PATH 指定）。"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const results: any[] = [];

  for (const scenario of SCENARIOS.filter(s => !onlyFlag || onlyFlag.includes(s.id))) {
    const started = Date.now();
    const context = await browser.newContext({ ...devices["iPhone 12"], viewport: { width: 390, height: 844 }, locale: "zh-CN" });
    const page = await context.newPage();
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const note = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok, detail }); console.log(`    ${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`); };
    let fatal: string | undefined;
    try {
      // The dev server occasionally stalls on first compile after edits; retry once.
      await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 }));
      await page.waitForTimeout(1200);
      const viewport = page.viewportSize();
      note("视口 390×844（iPhone 12 仿真）", viewport?.width === 390 && viewport?.height === 844, `${viewport?.width}×${viewport?.height}`);

      await page.evaluate(async (payload: { fixtures: { name: string; b64: string }[] }) => {
        const engine = await import("/src/lib/browser/engine.ts");
        for (const fixture of payload.fixtures) {
          const bytes = Uint8Array.from(atob(fixture.b64), ch => ch.charCodeAt(0));
          await engine.importBrowserFile(new Blob([bytes]), fixture.name);
        }
      }, { fixtures: scenario.fixtures.map(item => ({ name: path.basename(item.file), b64: fs.readFileSync(path.join(ROOT, item.file)).toString("base64") })) });

      await page.click(".mobile-chat-handle");
      await page.waitForSelector(".task-cards", { timeout: 8000 });
      note("手机对话抽屉打开且任务卡可见", true);

      const card = page.locator(".task-card", { hasText: scenario.card }).first();
      await card.click();
      await page.waitForSelector(".task-card-panel", { timeout: 8000 });

      if (scenario.prepare === "big") {
        // Pick the oversized DEM in the slot dropdown.
        const select = page.locator(".task-card-panel select").first();
        await select.selectOption({ label: /dem_over_budget/ } as never).catch(async () => {
          const options = await select.locator("option").allTextContents();
          const target = options.find(text => text.includes("dem_over_budget"));
          if (target) await select.selectOption({ label: target });
        });
      }
      if (scenario.prepare === "same") {
        const selects = page.locator(".task-card-panel select");
        const first = await selects.first().locator("option").allTextContents();
        const target = first.find(text => text.includes("district_zones"));
        if (target) {
          await selects.nth(0).selectOption({ label: target });
          await selects.nth(1).selectOption({ label: target });
        }
      }

      if (scenario.expect.blocked) {
        const blocked = page.locator(".task-card-blocked");
        await blocked.waitFor({ timeout: 8000 });
        const text = await blocked.textContent();
        note("执行前阻止并给出原因", /预算|同一个图层/.test(text ?? ""), (text ?? "").slice(0, 90));
        const runDisabled = await page.locator(".task-card-actions .primary-btn").isDisabled();
        note("执行按钮禁用（不会误跑）", runDisabled);
        const degrade = await page.locator(".task-card-blocked small").textContent();
        note("降级建议可见", !!(degrade && degrade.trim().length), (degrade ?? "").slice(0, 60));
      } else {
        const explain = await page.locator(".task-card-explain").textContent();
        note("执行前说明引擎与数据预算", /本地/.test(explain ?? ""), (explain ?? "").slice(0, 80).replace(/\s+/g, " "));
        await page.locator(".task-card-actions .primary-btn").click();
        if (scenario.backgroundDuringRun) {
          const other = await context.newPage();
          await other.bringToFront();
          await page.waitForTimeout(1500);
          await other.close();
          await page.bringToFront();
          note("运行中短暂后台后返回", true);
        }
        const result = page.locator(".task-card-result");
        const budget = scenario.timeoutMs ?? 120000;
        await result.waitFor({ timeout: budget });
        await page.waitForFunction(() => {
          const node = document.querySelector(".task-card-result");
          return node && node.getAttribute("data-status") !== null && !node.getAttribute("data-status")?.includes("running");
        }, { timeout: budget }).catch(() => undefined);
        const status = await result.getAttribute("data-status");
        note(`运行结束 status=${scenario.expect.status}`, status === scenario.expect.status, `实际 ${status}`);
        if (scenario.expect.noFailedAcceptance) {
          const failed = await result.locator("li[data-ok='false']").count();
          note("验收断言全部通过", failed === 0, `${failed} 条未过`);
        }
        const headline = await result.locator(".task-card-result-head").textContent();
        note("诚实结论（headline）", !!(headline && headline.trim()), (headline ?? "").slice(0, 80));
        if (scenario.expect.export) {
          const exportButton = result.locator(".task-card-deliverables button").first();
          await exportButton.waitFor({ timeout: 8000 });
          await exportButton.click();
          const link = result.locator(".task-card-export a");
          await link.waitFor({ timeout: 60000 });
          const href = await link.getAttribute("href");
          note("导出下载链接生成", !!href && href.startsWith("blob:"));
        }
      }
    } catch (error) {
      fatal = error instanceof Error ? error.message : String(error);
      note("驱动器异常", false, fatal.slice(0, 140));
    } finally {
      await context.close();
    }
    const ok = !fatal && checks.every(check => check.ok);
    results.push({ id: scenario.id, title: scenario.title, ok, duration_ms: Date.now() - started, checks, fatal: fatal ?? null });
    console.log(`  ${scenario.id} ${ok ? "PASS" : "FAIL"} (${(results[results.length - 1].duration_ms / 1000).toFixed(1)}s)`);
  }
  await browser.close();

  const totals = { scenarios: results.length, pass: results.filter(r => r.ok).length, fail: results.filter(r => !r.ok).length };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "mobile-baseline.json"), JSON.stringify({ generated_at: new Date().toISOString(), device: "iPhone 12 emulation (390x844, touch)", totals, results }, null, 2) + "\n");
  const lines = [
    "# 阶段 4 · 手机端任务卡基线（390×844 仿真）", "",
    "> 生成：" + new Date().toISOString() + " · Playwright iPhone 12 仿真 · 真实浏览器 WASM 引擎", "",
    "| 场景 | 标题 | 结果 | 耗时 |", "|---|---|---|---|",
    ...results.map(r => `| ${r.id} | ${r.title} | ${r.ok ? "PASS" : "FAIL"} | ${(r.duration_ms / 1000).toFixed(1)}s |`),
    "", `合计：${totals.pass}/${totals.scenarios} 通过`, "",
  ];
  for (const r of results.filter(r => !r.ok)) {
    lines.push(`## ${r.id} ${r.title}`, "");
    for (const c of r.checks.filter(check => !check.ok)) lines.push(`- ✗ ${c.name}：${c.detail}`);
    if (r.fatal) lines.push(`- 驱动器错误：${r.fatal}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT_DIR, "mobile-baseline.md"), lines.join("\n") + "\n");
  console.log(`\n${totals.pass}/${totals.scenarios} 场景通过；报告 docs/baselines/stage4/mobile-baseline.md`);
  process.exitCode = totals.fail ? 1 : 0;
}

await main();
