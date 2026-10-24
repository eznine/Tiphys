/**
 * TIPHYS Mobile V2.2 verification driver.
 * Runs the real app in an emulated iPhone 12 (390×844, touch), imports real
 * fixtures, and exercises map → layers → toolbox → real buffer job → task
 * centre → project → chat task card. Screenshots come from the running UI.
 *
 *   npm run dev -- --port 1424
 *   node scripts/mobile-v22-verify.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = process.env.MOBILE_APP ?? "http://127.0.0.1:1425/";
const OUT = path.join(ROOT, "docs", "screens", "mobile-v22");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`    screenshot ${name}.png`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = CHROME_CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
  if (!chrome) { console.error("找不到 Chrome/Edge（可用 CHROME_PATH 指定）。"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ ...devices["iPhone 12"], viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await context.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('tiphys-theme', 'light'); } catch { /* ignore */ } });
  const errors = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

  try {
    await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2600);
    await page.waitForSelector(".m-dock", { timeout: 15000 });
    check("四入口 Dock 渲染", await page.locator(".m-dock-item").count() === 4);
    check("地图画布真实存在", await page.locator(".maplibregl-canvas").count() === 1);
    check("顶部图层/工具入口", await page.locator('.m-glass-round[aria-label^="图层"]').count() === 1 && await page.locator('button[aria-label="打开 GIS 工具箱"]').count() === 1);

    // Real fixture import through the app's hidden file input (real UI path).
    await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "samples", "beijing_points.geojson"));
    await page.waitForTimeout(3200);
    await shot(page, "01-map");
    const layerBadge = await page.locator('.m-glass-round[aria-label^="图层"] .m-round-count').textContent().catch(() => "");
    check("导入真实样例图层", (layerBadge ?? "").includes("1"), `badge=${layerBadge}`);

    // Layers: open, expand via real drag, screenshot.
    await page.locator('.m-glass-round[aria-label^="图层"]').click();
    await page.waitForSelector(".m-sheet", { timeout: 8000 });
    await page.waitForTimeout(800);
    check("图层抽屉打开", await page.locator(".m-layer-row").count() >= 1);
    const grab = await page.locator(".m-sheet-grab").first().boundingBox();
    if (grab) {
      await page.mouse.move(grab.x + grab.width / 2, grab.y + 20);
      await page.mouse.down();
      await page.mouse.move(grab.x + grab.width / 2, grab.y - 250, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    }
    const sheetBox = await page.locator(".m-sheet").first().boundingBox();
    check("抽屉可真实拖动并吸附", !!sheetBox && sheetBox.y < 844 * 0.36, `y=${sheetBox ? Math.round(sheetBox.y) : "?"}`);
    await shot(page, "02-layers");

    // Toggle visibility on the real map layer.
    const eye = page.locator(".m-layer-row .m-layer-eye").first();
    await eye.click();
    await page.waitForTimeout(300);
    const pressed = await eye.getAttribute("aria-pressed");
    check("图层显隐与地图状态同步", pressed === "false", `aria-pressed=${pressed}`);
    await eye.click();
    await page.locator(".m-sheet-close").first().click();
    await page.waitForTimeout(350);

    // Toolbox → buffer → real job.
    await page.locator('button[aria-label="打开 GIS 工具箱"]').click();
    await page.waitForSelector(".m-tool-section", { timeout: 20000 });
    check("工具箱目录加载", await page.locator(".m-tool-row").count() > 10, `${await page.locator(".m-tool-row").count()} visible rows`);
    await shot(page, "03-toolbox");
    await page.locator('.m-search input[aria-label="搜索工具"]').fill("缓冲区");
    await page.waitForTimeout(500);
    const bufferRow = page.locator(".m-tool-row", { hasText: "缓冲区" }).first();
    if (await bufferRow.count()) {
      await bufferRow.locator(".m-tool-main").click();
      await page.waitForSelector(".m-tool-form .tool-panel", { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll(".m-tool-form .tool-field").length > 0, { timeout: 20000 });
      await shot(page, "04-tool-form");
      const layerSelect = page.locator('.m-tool-form select[aria-label^="输入图层"]').first();
      if (await layerSelect.count()) {
        await layerSelect.selectOption({ index: 1 });
        const distance = page.locator('.m-tool-form input[aria-label^="距离"]').first();
        if (await distance.count()) await distance.fill("500");
        const submit = page.locator('.m-tool-form button[type="submit"]').first();
        await submit.click();
        await page.waitForSelector(".m-tool-form .job-card", { timeout: 10000 });
        check("工具真实提交并生成 job", true);
        await page.waitForFunction(() => {
          const card = document.querySelector(".m-tool-form .job-card");
          const text = card?.textContent ?? "";
          return text.includes("完成") || text.includes("失败");
        }, { timeout: 120000 });
        const jobText = await page.locator(".m-tool-form .job-card").first().innerText();
        check("缓冲区任务执行结束", /完成/.test(jobText), jobText.replace(/\s+/g, " ").slice(0, 90));
        await shot(page, "05-tool-job");
      } else {
        check("缓冲区参数表单含输入图层", false, "没有找到图层下拉");
      }
    } else {
      check("工具箱可检索缓冲区", false, "搜索无结果");
    }
    const back = page.locator(".m-page-back");
    if (await back.count()) await back.first().click();
    await page.waitForTimeout(400);
    if (await back.count()) await back.first().click();
    await page.waitForTimeout(3600);

    // Task centre
    await page.locator(".m-dock-item", { hasText: "任务" }).click();
    await page.waitForSelector(".m-task-row", { timeout: 10000 });
    await page.waitForTimeout(450);
    const taskCount = await page.locator(".m-task-row").count();
    check("任务中心汇总真实任务", taskCount >= 1, `${taskCount} 条`);
    await shot(page, "06-tasks");
    await page.locator(".m-task-row").first().click();
    await page.waitForSelector(".m-task-detail", { timeout: 8000 });
    await page.waitForTimeout(3000);
    const validation = await page.locator(".m-task-detail").first().innerText();
    check("任务详情包含验证证据", /验证|证据|输出/.test(validation), validation.replace(/\s+/g, " ").slice(0, 110));
    await shot(page, "07-task-detail");
    await page.locator(".m-page-back").first().click();
    await page.waitForTimeout(400);

    // Project page
    await page.locator(".m-dock-item", { hasText: "工程" }).click();
    await page.waitForSelector(".m-project-hero", { timeout: 8000 });
    await page.waitForTimeout(450);
    check("工程页显示当前工程", (await page.locator(".m-project-hero h2").innerText()).length > 0);
    await shot(page, "08-project");
    await page.locator('.m-tabs button[role="tab"]', { hasText: "数据集" }).click();
    await page.waitForTimeout(300);
    const datasetText = await page.locator(".m-project-tab").innerText();
    check("数据集引用真实图层", /beijing_points|矢量/.test(datasetText), datasetText.replace(/\s+/g, " ").slice(0, 100));
    await shot(page, "09-project-datasets");
    await page.locator('.m-tabs button[role="tab"]', { hasText: "成果" }).click();
    await page.waitForTimeout(300);
    await shot(page, "10-project-outputs");

    // Chat task card: real audited plan run
    await page.locator(".m-dock-item", { hasText: "对话" }).click();
    await page.waitForSelector(".task-cards", { timeout: 10000 });
    await page.waitForTimeout(450);
    await shot(page, "11-chat");
    const card = page.locator(".task-card", { hasText: "点缓冲服务圈" }).first();
    if (await card.count()) {
      await card.click();
      await page.waitForSelector(".task-card-panel", { timeout: 8000 });
      await page.locator(".task-card-actions .primary-btn").click();
      await page.waitForSelector(".task-card-result", { timeout: 120000 });
      const resultText = await page.locator(".task-card-result").innerText();
      check("任务卡真实执行并给出验收", /完成|失败|验收/.test(resultText), resultText.replace(/\s+/g, " ").slice(0, 100));
      await shot(page, "12-chat-taskcard-result");
      await page.waitForTimeout(4500);
      await page.locator(".m-dock-item", { hasText: "任务" }).click();
      await page.waitForTimeout(1200);
      const planRow = page.locator(".m-task-row", { hasText: "点缓冲服务圈" }).first();
      check("任务卡进入统一任务账本", await planRow.count() > 0);
      if (await planRow.count()) {
        await planRow.click();
        await page.waitForTimeout(1200);
        await shot(page, "13-plan-task-detail");
        await page.locator(".m-page-back").first().click();
      }
    } else {
      check("对话页任务卡可见", false);
    }

    // Landscape
    await page.locator(".m-dock-item", { hasText: "地图" }).click();
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(900);
    await shot(page, "14-landscape-map");
    await page.locator('.m-glass-round[aria-label^="图层"]').click();
    await page.waitForTimeout(600);
    const sideSheet = await page.locator(".m-sheet").first().boundingBox();
    check("横屏抽屉切换为侧栏", !!sideSheet && sideSheet.width < 500 && sideSheet.height >= 380, sideSheet ? `${Math.round(sideSheet.width)}×${Math.round(sideSheet.height)}` : "no sheet");
    await shot(page, "15-landscape-layers");
  } catch (error) {
    checks.push({ name: "驱动器异常", ok: false, detail: String(error) });
    console.error(error);
  } finally {
    const pageErrors = errors.filter(text => !/Failed to load resource|net::ERR|WebGL|GPU stall|Download the React DevTools/.test(text));
    await browser.close();
    fs.writeFileSync(path.join(OUT, "verify.json"), JSON.stringify({ generated_at: new Date().toISOString(), checks, errors: pageErrors }, null, 2));
    console.log(`\n${checks.filter(item => item.ok).length}/${checks.length} checks passed`);
    if (pageErrors.length) console.log("Console/page errors:\n" + pageErrors.slice(0, 20).join("\n"));
  }
}

void main();
