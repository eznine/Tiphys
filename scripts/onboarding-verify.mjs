/**
 * Onboarding / data-ecosystem verification (mobile viewport, real network).
 *   npx vite preview --port 4317  →  APP=http://localhost:4317/tiphys/ node scripts/onboarding-verify.mjs
 */
import path from "node:path";
import { chromium, devices } from "playwright";
const ROOT = path.resolve(import.meta.dirname, "..");
const APP = process.env.APP ?? "http://localhost:4317/tiphys/";
const OUT = path.join(ROOT, "docs", "screens", "onboarding");
const FX = path.join(ROOT, "tests", "fixtures", "ecosystem");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices["iPhone 12"], geolocation: { latitude: 30.2590, longitude: 120.1300 }, permissions: ["geolocation"] });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("  pageerror:", e.message));
const status = () => page.locator(".gs-status").textContent().catch(() => "");
const waitStatus = async (ms = 90000) => { await page.waitForFunction(() => { const s = document.querySelector(".gs-status"); return s && !s.classList.contains("gs-busy"); }, null, { timeout: ms }); return status(); };
const openHub = async () => { await page.waitForTimeout(1200); if (!(await page.locator(".gs-quick").isVisible().catch(() => false))) { await page.evaluate(() => window.dispatchEvent(new CustomEvent("tiphys:open-hub"))); await page.waitForSelector(".gs-quick", { timeout: 5000 }); } };

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".gs-quick", { timeout: 30000 });
check("first-run hub auto-opens", true);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "01-hub-mobile.png") });

await page.locator(".gs-quick button", { hasText: "试用示例工程" }).click();
let s = await waitStatus(); check("sample project loads", /示例工程已载入 4/.test(s), s);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, "02-sample-project.png") });

await openHub();
await page.locator(".gs-quick button", { hasText: "定位并加载附近数据" }).click();
s = await waitStatus(120000); check("locate + nearby OSM", /已加载附近数据 [2-4]/.test(s), s);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, "03-nearby.png") });

await openHub();
await page.locator("#gs-url").fill("https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Countries_(Generalized)/FeatureServer/0");
await page.locator(".gs-go", { hasText: "导入" }).click();
s = await waitStatus(); check("ArcGIS FeatureServer URL", /已添加 1 个图层/.test(s), s);

await openHub();
await page.evaluate(() => window.dispatchEvent(new CustomEvent("tiphys:flyto", { detail: { lng: 120.145, lat: 30.245, zoom: 15 } })));
await page.waitForTimeout(4000);
await page.locator(".gs-chips button", { hasText: "公园绿地" }).click();
s = await waitStatus(); check("OSM category for current view", /公园绿地/.test(s) && !/没有|失败|太大/.test(s), s);

await openHub();
await page.locator('input[type=search]').fill("杭州市西湖区");
await page.locator(".gs-row .gs-go").last().click();
s = await waitStatus(); check("admin boundary search", /已添加边界/.test(s), s);

// File imports go straight to the hidden input (the hub's 导入文件 opens the same picker).
const notice = async () => { await page.waitForFunction(() => /已添加|没有添加|失败/.test(document.body.innerText), null, { timeout: 150000 }); };
const importFx = async (files, label) => {
  await page.evaluate(() => { for (const el of document.querySelectorAll(".m-sheet-backdrop")) el.click(); });
  await page.locator('input[type=file]').setInputFiles(files.map(f => path.join(FX, f)));
  await page.waitForFunction(() => !document.body.innerText.includes("正在解析工程"), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => [...document.querySelectorAll("[role=status], .m-notice, .import-notice, .m-layers-notice")].map(e => e.textContent).join(" | "));
  return text;
};
const before = await page.evaluate(() => Number(document.querySelector(".m-round-count")?.textContent ?? 0));
let t = await importFx(["city.aprx", "city.gdb.zip"], "aprx+gdb");
let after = await page.evaluate(() => Number(document.querySelector(".m-round-count")?.textContent ?? 0));
check("APRX + zipped GDB import", after - before >= 2, `layers ${before}→${after}`);
t = await importFx(["demo.mpkx"], "mpkx");
const after2 = await page.evaluate(() => Number(document.querySelector(".m-round-count")?.textContent ?? 0));
check(".mpkx (7z) package import", after2 - after >= 2, `layers ${after}→${after2}`);
t = await importFx(["countries.lyrx"], "lyrx");
const after3 = await page.evaluate(() => Number(document.querySelector(".m-round-count")?.textContent ?? 0));
check(".lyrx service layer import", after3 - after2 >= 1, `layers ${after2}→${after3}`);
await page.screenshot({ path: path.join(OUT, "04-after-imports.png") });

// Desktop layout
const desk = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await desk.goto(APP, { waitUntil: "domcontentloaded" });
await desk.waitForSelector(".gs-modal", { timeout: 30000 });
await desk.waitForTimeout(600);
await desk.screenshot({ path: path.join(OUT, "05-hub-desktop.png") });
check("desktop hub modal", true);
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
