import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const outputDir = path.join(root, "test-results");
const geojsonFixture = path.join(root, "tests/fixtures/bj_points.geojson");
const rasterFixture = path.join(root, "tests/fixtures/obia-overview.tif");
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const chromePath = chromeCandidates.find(candidate => fs.existsSync(candidate!));

type Stage = "world" | "sample" | "geojson" | "raster";
type PixelProbe = {
  width: number;
  height: number;
  sampled: number;
  uniqueColors: number;
  dominantShare: number;
  nonBackground: number;
  points: { lng: number; lat: number; nonBackground: number; blue: number; samples: number }[];
  sources: { id: string; type: string; features: number }[];
};

let preview: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let baseUrl = "";
let previewLog = "";
const browserErrors: string[] = [];
const workerResponses: { url: string; contentType: string }[] = [];

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a preview port"));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForPreview(url: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* Preview is still starting. */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`vite preview did not start\n${previewLog}`);
}

async function mapProbe(coords: [number, number][], stage: Stage): Promise<PixelProbe> {
  assert.ok(page, "browser page is available");
  const probe = await page.evaluate(({ coords }) => {
    const map = (window as unknown as { __tiphysMap: any }).__tiphysMap;
    if (!map) throw new Error("MapLibre map is unavailable");
    const canvas = map.getCanvas();
    const offscreen = document.createElement("canvas");
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    const context = offscreen.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read the map canvas");
    context.drawImage(canvas, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, offscreen.width, offscreen.height);
    const rgba = (x: number, y: number) => {
      const i = (Math.max(0, Math.min(height - 1, Math.round(y))) * width + Math.max(0, Math.min(width - 1, Math.round(x)))) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
    };
    const background = rgba(4, 4);
    const distance = (pixel: readonly number[]) => Math.abs(pixel[0] - background[0]) + Math.abs(pixel[1] - background[1]) + Math.abs(pixel[2] - background[2]);

    const colors = new Map<string, number>();
    let sampled = 0;
    let nonBackground = 0;
    for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
      const pixel = rgba(x, y);
      const key = `${pixel[0] >> 3},${pixel[1] >> 3},${pixel[2] >> 3},${pixel[3] >> 6}`;
      colors.set(key, (colors.get(key) ?? 0) + 1);
      sampled++;
      if (distance(pixel) > 18) nonBackground++;
    }
    const dominant = Math.max(...colors.values());
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const points = coords.map(([lng, lat]) => {
      const projected = map.project([lng, lat]);
      const radius = Math.ceil(10 * scaleX);
      const centerX = projected.x * scaleX;
      const centerY = projected.y * scaleY;
      let changed = 0;
      let blue = 0;
      let samples = 0;
      for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y++) {
        for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const pixel = rgba(x, y);
          samples++;
          if (distance(pixel) > 18) changed++;
          if (pixel[2] > pixel[0] + 25 && pixel[2] > pixel[1] + 20 && pixel[2] > 100) blue++;
        }
      }
      return { lng, lat, nonBackground: changed, blue, samples };
    });
    const style = map.getStyle();
    const sources = Object.keys(style.sources ?? {}).filter(id => id.startsWith("tiphys-lyr_")).map(id => {
      let features = 0;
      try { features = map.querySourceFeatures(id).length; } catch { /* Source still loading. */ }
      return { id, type: String(style.sources[id].type), features };
    });
    return { width, height, sampled, uniqueColors: colors.size, dominantShare: dominant / sampled, nonBackground, points, sources };
  }, { coords });
  console.log(`[map-render] ${stage} ${JSON.stringify(probe)}`);
  return probe;
}

async function waitForMapIdle() {
  assert.ok(page, "browser page is available");
  await page.waitForFunction(() => {
    const map = (window as unknown as { __tiphysMap?: any }).__tiphysMap;
    return Boolean(map?.loaded() && !map.isMoving());
  }, null, { timeout: 45_000 });
  await page.waitForTimeout(1_200);
}

async function waitForLayer(kind: "geojson" | "image", minimum: number) {
  assert.ok(page, "browser page is available");
  await page.waitForFunction(({ kind, minimum }) => {
    const map = (window as unknown as { __tiphysMap?: any }).__tiphysMap;
    const sources = map?.getStyle()?.sources ?? {};
    return Object.keys(sources).filter(id => id.startsWith("tiphys-lyr_") && sources[id].type === kind).length >= minimum;
  }, { kind, minimum }, { timeout: 30_000 });
}

async function waitForBeijing(zoom: number) {
  assert.ok(page, "browser page is available");
  await page.waitForFunction(({ zoom }) => {
    const map = (window as unknown as { __tiphysMap?: any }).__tiphysMap;
    const center = map?.getCenter();
    return Boolean(center && Math.abs(center.lng - 116.4) < 0.12 && Math.abs(center.lat - 39.9) < 0.12 && map.getZoom() >= zoom);
  }, { zoom }, { timeout: 30_000 });
}

before(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  assert.ok(chromePath, "A Chrome/Chromium executable is required for the map render test");
  assert.ok(fs.existsSync(path.join(dist, "index.html")), "Run the production build before the map render test");
  const workers = fs.readdirSync(path.join(dist, "assets")).filter(name => name.includes("maplibre-gl-worker"));
  assert.equal(workers.length, 1, "the production build must emit one MapLibre worker asset");
  assert.match(workers[0], /\.js$/, "MapLibre worker must be served with a .js extension so static hosts use text/javascript MIME");

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}/`;
  preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  preview.stdout?.on("data", chunk => { previewLog += chunk.toString(); });
  preview.stderr?.on("data", chunk => { previewLog += chunk.toString(); });
  await waitForPreview(baseUrl);

  browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-gpu-sandbox",
    ],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", message => {
    const location = message.location();
    if (message.type() === "error" && !location.url.includes("127.0.0.1:8972")) browserErrors.push(`console: ${message.text()} (${location.url})`);
  });
  page.on("pageerror", error => browserErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "";
    // Camera flights cancel in-flight tiles by design; the desktop health probe is not part of browser rendering.
    if (failure.includes("ERR_ABORTED") || request.url().includes("127.0.0.1:8972")) return;
    browserErrors.push(`requestfailed: ${request.url()} ${failure}`);
  });
  page.on("response", response => {
    if (response.url().includes("maplibre-gl-worker")) workerResponses.push({ url: response.url(), contentType: response.headers()["content-type"] ?? "" });
  });
  await page.addInitScript({ content: "window.__name = value => value;" });
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __tiphysMap?: any }).__tiphysMap), null, { timeout: 30_000 });
  await waitForMapIdle();
});

after(async () => {
  await browser?.close();
  if (preview && preview.exitCode == null) {
    preview.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 250));
    if (preview.exitCode == null) preview.kill("SIGKILL");
  }
});

test("basemap and imported layers render real pixels after flying", { timeout: 150_000 }, async () => {
  assert.ok(page, "browser page is available");
  assert.ok(fs.existsSync(geojsonFixture), "GeoJSON fixture is missing");
  assert.ok(fs.existsSync(rasterFixture), "GeoTIFF fixture is missing");
  const geojson = JSON.parse(fs.readFileSync(geojsonFixture, "utf8"));
  const geojsonCoords = geojson.features.map((feature: any) => feature.geometry.coordinates as [number, number]);

  const world = await mapProbe([], "world");
  assert.ok(world.uniqueColors > 20, `default globe view is blank (${world.uniqueColors} colors)`);
  assert.ok(world.dominantShare < 0.92, `default globe view is mostly one background color (${world.dominantShare})`);
  await page.screenshot({ path: path.join(outputDir, "map-world.png") });

  await page.getByRole("button", { name: "加载示例点位" }).click();
  await waitForLayer("geojson", 1);
  await waitForBeijing(10);
  await waitForMapIdle();
  const sample = await mapProbe([[116.3974, 39.9093]], "sample");
  assert.ok(sample.sources.some(source => source.type === "geojson"), "the keyless sample did not add a GeoJSON source");
  assert.ok(sample.points[0].blue >= 3, `sample point has no visible blue pixels (${JSON.stringify(sample.points[0])})`);
  assert.ok(sample.uniqueColors > 20 && sample.dominantShare < 0.92, `sample view has no basemap detail (${sample.uniqueColors} colors, dominant ${sample.dominantShare})`);
  await page.screenshot({ path: path.join(outputDir, "map-sample.png") });

  await page.setInputFiles("input[type=file]", geojsonFixture);
  await waitForLayer("geojson", 2);
  await waitForBeijing(10);
  await waitForMapIdle();
  const imported = await mapProbe(geojsonCoords, "geojson");
  for (const point of imported.points) {
    assert.ok(point.blue >= 3, `imported point ${point.lng},${point.lat} is not visible on the canvas (${JSON.stringify(point)})`);
  }
  assert.ok(imported.nonBackground > 500, `imported view is blank except for background (${imported.nonBackground} changed samples)`);
  assert.ok(imported.uniqueColors > 20 && imported.dominantShare < 0.92, `imported view lost the basemap (${imported.uniqueColors} colors, dominant ${imported.dominantShare})`);
  await page.screenshot({ path: path.join(outputDir, "map-geojson-after-fly.png") });

  await page.setInputFiles("input[type=file]", rasterFixture);
  await waitForLayer("image", 1);
  await waitForMapIdle();
  const raster = await mapProbe([], "raster");
  assert.ok(raster.sources.some(source => source.type === "image"), "the GeoTIFF did not add a raster image source");
  assert.ok(raster.uniqueColors > 12, `GeoTIFF view is blank (${raster.uniqueColors} colors)`);
  assert.ok(raster.dominantShare < 0.96, `GeoTIFF view is a flat background (${raster.dominantShare})`);
  await page.screenshot({ path: path.join(outputDir, "map-raster-after-fly.png") });

  assert.ok(workerResponses.length > 0, "MapLibre did not request its worker asset");
  for (const response of workerResponses) {
    assert.match(response.contentType, /javascript/i, `MapLibre worker has the wrong MIME type: ${response.contentType} (${response.url})`);
    assert.match(response.url, /\.js(?:\?|$)/, `MapLibre worker must be a .js asset: ${response.url}`);
  }
  assert.ok(!browserErrors.some(error => /Worker failed to load/i.test(error)), "MapLibre worker failed to boot");
  assert.deepEqual(browserErrors, [], browserErrors.join("\n"));
});
