/**
 * TIPHYS Mobile V2.3 verification driver.
 * Exercises the single bottom card, edge-anchored map readouts, focus-aware
 * chrome, layer-settings and toolbox drawers, attribute-table layout, and the
 * global form-focus rule in a real iPhone 12 viewport.
 *
 *   npm run dev -- --port 1426
 *   MOBILE_APP=http://127.0.0.1:1426/ node scripts/mobile-v23-verify.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = process.env.MOBILE_APP ?? "http://127.0.0.1:1425/";
const OUT = path.join(ROOT, "docs", "screens", "mobile-v23");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean);

const log = (...args) => console.log(...args);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const box = async locator => {
  const b = await locator.boundingBox().catch(() => null);
  return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
};
const style = (page, selector, props) => page.evaluate(([sel, ps]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return Object.fromEntries(ps.map(p => [p, cs[p]]));
}, [selector, props]);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = CHROME_CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
  if (!chrome) { console.error("找不到 Chrome/Edge（可用 CHROME_PATH 指定）。"); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ ...devices["iPhone 12"], viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await context.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("tiphys-theme", "light"); } catch { /* ignore */ } });
  const errors = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

  try {
    await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2800);
    await page.waitForSelector(".m-bottom-card", { timeout: 20000 });
    await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "samples", "beijing_points.geojson"));
    await page.waitForFunction(() => (document.querySelector('.m-glass-round[aria-label^="图层"] .m-round-count')?.textContent ?? "").includes("1"), { timeout: 20000 });
    await page.waitForTimeout(1200);

    log("\n[1] map bottom card / edges");
    const card = await box(page.locator(".m-bottom-card"));
    const cardStyle = await style(page, ".m-bottom-card", ["borderRadius", "background", "position", "bottom"]);
    check("底部卡片为整体单卡", !!card && card.h > 120 && cardStyle?.position === "fixed", JSON.stringify({ card, cardStyle }));
    check("Dock 嵌在卡片内", await page.locator(".m-bottom-card .m-dock-embedded .m-dock-item").count() === 4);
    check("地图页无独立悬浮 Dock", await page.locator(".m-dock:not(.m-dock-embedded)").count() === 0);
    const readout = await box(page.locator(".map-touch-readout"));
    const legend = await box(page.locator(".map-legend-dock"));
    const viewportH = 844;
    check("坐标读数贴近底部", !!readout && readout.y > viewportH * 0.7, JSON.stringify(readout));
    check("图例贴近底部", !!legend && legend.y > viewportH * 0.64, JSON.stringify(legend));
    check("图例在坐标上方不重叠", !!legend && !!readout && legend.y + (legend.h ?? 0) <= readout.y + 2, JSON.stringify({ legend, readout }));
    await page.screenshot({ path: path.join(OUT, "01-map-card.png") });

    log("\n[2] composer focus folds dock");
    await page.locator(".m-bottom-card input").first().focus();
    await page.waitForTimeout(350);
    const focusState = await page.evaluate(() => ({
      typing: document.querySelector(".m-bottom-card")?.getAttribute("data-input-focused"),
      dockDisplay: getComputedStyle(document.querySelector(".m-bottom-card .m-dock")).display,
      statusDisplay: getComputedStyle(document.querySelector(".m-bottom-card .m-bottom-status-slot")).display,
      cardBox: document.querySelector(".m-bottom-card")?.getBoundingClientRect().toJSON(),
    }));
    check("输入聚焦后仅留输入框", focusState.typing === "true" && focusState.dockDisplay === "none" && focusState.statusDisplay === "none", JSON.stringify(focusState));
    await page.screenshot({ path: path.join(OUT, "02-map-focus.png") });
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.waitForTimeout(350);
    check("失焦后卡片恢复", await page.locator(".m-bottom-card[data-input-focused='true']").count() === 0);

    log("\n[3] layer drawer -> symbolization drawer -> back");
    await page.locator('.m-glass-round[aria-label^="图层"]').click();
    await page.waitForSelector(".m-sheet", { timeout: 10000 });
    await page.waitForTimeout(700);
    await page.locator(".m-layer-current-actions button", { hasText: "符号" }).click();
    await page.waitForTimeout(900);
    const sheetCount = await page.locator(".m-sheet").count();
    const propSheet = await box(page.locator(".m-sheet").last());
    const mapVisible = await page.locator(".maplibregl-canvas").isVisible();
    const sheetText = await page.locator(".m-sheet").last().innerText();
    check("符号化以抽屉打开且地图仍可见", sheetCount === 1 && mapVisible && !!propSheet && propSheet.y > 100, JSON.stringify({ sheetCount, propSheet, mapVisible }));
    check("符号化抽屉含颜色/大小字段", /颜色|大小|透明度/.test(sheetText), sheetText.replace(/\s+/g, " ").slice(0, 80));
    await page.screenshot({ path: path.join(OUT, "03-symbolization-sheet.png") });
    await page.locator(".m-sheet-close").click();
    await page.waitForTimeout(800);
    const layerSheetBack = await page.locator(".m-sheet", { hasText: "个图层" }).count();
    check("关闭符号化回到图层抽屉", layerSheetBack === 1);
    await page.locator(".m-sheet-close").click();
    await page.waitForTimeout(500);

    log("\n[4] attribute table");
    await page.locator('.m-glass-round[aria-label^="图层"]').click();
    await page.waitForTimeout(600);
    await page.locator(".m-layer-current-actions button", { hasText: "属性表" }).click();
    await page.waitForSelector(".m-fullscreen-panel .attribute-table", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll(".m-fullscreen-panel .attribute-scroll tbody tr").length > 0, { timeout: 20000 });
    await page.waitForTimeout(700);
    const tableMetrics = await page.evaluate(() => {
      const table = document.querySelector(".attribute-table");
      const scroll = document.querySelector(".attribute-scroll");
      const rows = document.querySelectorAll(".attribute-scroll tbody tr");
      const panel = document.querySelector(".m-fullscreen-panel");
      return {
        table: table?.getBoundingClientRect().toJSON(),
        scroll: scroll?.getBoundingClientRect().toJSON(),
        rows: rows.length,
        firstRow: rows[0]?.getBoundingClientRect().toJSON(),
        panel: panel?.getBoundingClientRect().toJSON(),
        total: document.querySelector(".attribute-toolbar span")?.textContent,
      };
    });
    check("属性表铺满面板且行可见", tableMetrics.rows > 0 && (tableMetrics.scroll?.height ?? 0) > 300 && (tableMetrics.firstRow?.height ?? 0) > 10, JSON.stringify(tableMetrics));
    await page.screenshot({ path: path.join(OUT, "04-attribute-table.png") });
    await page.locator('[aria-label="关闭属性表"]').click();
    await page.waitForTimeout(600);
    check("关闭属性表回到地图", await page.locator(".m-fullscreen-panel").count() === 0);

    log("\n[5] toolbox as drawer, list + form");
    await page.locator('button[aria-label="打开 GIS 工具箱"]').click();
    await page.waitForSelector(".m-tool-section", { timeout: 20000 });
    await page.waitForTimeout(900);
    const toolboxSheet = await box(page.locator(".m-sheet").last());
    check("工具箱是半屏抽屉", !!toolboxSheet && toolboxSheet.y > 200 && toolboxSheet.y < 500, JSON.stringify(toolboxSheet));
    await page.screenshot({ path: path.join(OUT, "05-toolbox-sheet.png") });
    await page.locator('.m-search input[aria-label="搜索工具"]').fill("缓冲区");
    await page.waitForTimeout(500);
    const bufferRow = page.locator(".m-tool-row", { hasText: "缓冲区" }).first();
    if (await bufferRow.count()) {
      await bufferRow.locator(".m-tool-main").click();
      await page.waitForSelector('.m-tool-form select[aria-label^="输入图层"]', { timeout: 30000 });
      await page.waitForTimeout(700);
      const formSheet = await box(page.locator(".m-sheet").last());
      check("工具表单仍是同一可调抽屉", !!formSheet && formSheet.y > 100 && await page.locator(".m-sheet-back").count() === 1, JSON.stringify(formSheet));
      const scrollable = await page.locator(".m-sheet-body").evaluate(el => el.scrollHeight > el.clientHeight + 4);
      await page.screenshot({ path: path.join(OUT, "06-tool-form-sheet.png") });
      await page.locator(".m-sheet-body").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(350);
      check("工具表单可在抽屉内滚动到运行", scrollable && await page.locator('.m-tool-form button[type="submit"]').isVisible());
      await page.locator(".m-sheet-back").click();
      await page.waitForTimeout(600);
      check("工具表单返回工具列表", await page.locator(".m-tool-section").count() === 1);
    } else {
      check("找到缓冲区工具", false);
    }
    await page.locator(".m-sheet-close").click();
    await page.waitForTimeout(700);

    log("\n[6] project form input hides dock globally");
    await page.locator(".m-dock-item", { hasText: "工程" }).click();
    await page.waitForSelector(".m-project-hero", { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.locator(".m-project-hero-actions button", { hasText: "新建工程" }).click();
    await page.waitForSelector(".m-form input", { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator(".m-form input").first().click();
    await page.waitForTimeout(500);
    const nameInputFocused = await page.evaluate(() => document.activeElement?.getAttribute("placeholder") ?? "");
    const projectState = await page.evaluate(() => {
      const shell = document.querySelector(".m-shell");
      const dock = document.querySelector(".m-dock");
      const card = document.querySelector(".m-bottom-card");
      return {
        formFocused: shell?.getAttribute("data-form-focused"),
        dockVisibility: dock ? getComputedStyle(dock).visibility : "none",
        dockOpacity: dock ? getComputedStyle(dock).opacity : "none",
        cardVisibility: card ? getComputedStyle(card).visibility : "absent",
        activePlaceholder: document.activeElement?.getAttribute("placeholder") ?? "",
        activeTag: document.activeElement?.tagName,
      };
    });
    check("工程表单聚焦时底栏隐藏", projectState.formFocused === "true" && projectState.dockVisibility === "hidden", JSON.stringify(projectState));
    check("新建工程输入框保持焦点", /河流廊道/.test(nameInputFocused), JSON.stringify(projectState));
    await page.screenshot({ path: path.join(OUT, "07-project-form-focus.png") });
    await page.locator(".m-form-actions button", { hasText: "取消" }).click();
    await page.waitForTimeout(700);
    const restored = await page.evaluate(() => {
      const dock = document.querySelector(".m-dock");
      const shell = document.querySelector(".m-shell");
      return { formFocused: shell?.getAttribute("data-form-focused"), visibility: dock ? getComputedStyle(dock).visibility : "none" };
    });
    check("关闭表单后底栏恢复", restored.formFocused === null && restored.visibility === "visible", JSON.stringify(restored));

    log("\n[7] chat tab card");
    await page.locator(".m-dock-item", { hasText: "对话" }).click();
    await page.waitForSelector(".m-chat-page", { timeout: 10000 });
    await page.waitForTimeout(800);
    check("对话页复用同一张底部卡片", await page.locator(".m-bottom-card .m-dock-item").count() === 4);
    await page.locator(".m-bottom-card input").first().focus();
    await page.waitForTimeout(350);
    check("对话输入聚焦收起 Dock", await page.locator(".m-bottom-card[data-input-focused='true']").count() === 1);
    await page.screenshot({ path: path.join(OUT, "08-chat-focus.png") });
  } catch (error) {
    check("脚本执行", false, String(error));
    console.error(error);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, "visual-check.json"), JSON.stringify({ checks: results, errors }, null, 2));
    log(`\n${results.filter(item => item.ok).length}/${results.length} checks passed`);
    if (errors.length) log("Errors:\n" + errors.slice(0, 15).join("\n"));
  }
}

void main();
