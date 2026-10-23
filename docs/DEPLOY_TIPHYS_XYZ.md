# Deploying TIPHYS at tiphys.xyz

Checked 2026-10-24 against the current Vite build. The browser build is a static SPA: no Node, Python, database, or local port is required. The optional desktop runtime is separate.

## Build and upload

```bash
npm ci
npm run build
```

The artifact is the **`dist/` directory in the repository root**. Upload its contents (not the parent directory) to the web root:

```text
dist/
  index.html                  # SPA entry, never cache during rollout
  logo-temp.png               # copied from public/
  samples/beijing_points.geojson
  licenses/frontend.md        # generated dependency notices
  assets/*.js
  assets/*.css
  assets/*.wasm
  assets/maplibre-gl-worker-*.mjs
```

Keep the generated `assets/` filenames unchanged; Vite hashes them for cache busting. The map worker URL is emitted by a `?url` import in `MapCanvas.tsx`, so do not rewrite files inside `assets/`. The app must be served from the site root (`/`). If it is deployed under a subpath, set Vite's `base` and rebuild rather than moving hashed assets after the build.

Minimum server behavior:

- Serve `/` and unknown SPA routes from `index.html`.
- Serve `.wasm` as `Content-Type: application/wasm`.
- Serve `index.html` with `Cache-Control: no-cache`.
- Serve hashed `/assets/*` files with a long immutable cache.
- Allow large static WASM responses; do not add an application-level body size limit to GET assets.

`deploy/nginx-tiphys.conf` is a working baseline for these rules.

## Current payload shape

- The lazy catalog chunk is about 1.95 MB uncompressed / 327 kB gzip in the current build. It contains tool schemas, not cartographic tiles.
- The main app chunk is about 1.90 MB uncompressed / 577 kB gzip. It includes MapLibre and the workspace shell; the 500 kB Vite warning is expected and does not mean the page fails to load.
- `geolibre-cli.wasm` is about 24.1 MB uncompressed / 8.2 MB gzip and `geolibre_wasm_bg.wasm` is about 6.66 MB / 2.13 MB gzip. They are fetched only for local WASM tools and are not part of the initial HTML.
- The map starts before tool catalog hydration finishes. The toolbox shows a 39-tool shell first and reaches 997 merged tools after hydration (993 visible after hiding four engine-only controls).
- Enable Brotli/gzip for HTML, JS, CSS and JSON. The host may also compress `.wasm`; always preserve the `application/wasm` type.
- Cloudflare Pages has a 25 MiB per-asset limit. The current 24.1 MB CLI WASM fits, but a dependency upgrade could cross the limit. If that happens, host the WASM from R2/another static origin with CORS and update the explicit worker/fetch URL; do not silently ship a truncated file.

## Cloudflare Pages

Use these project settings for a static Pages deployment:

| Setting | Value |
| --- | --- |
| Framework preset | None / Vite |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Root directory | repository root |
| Node version | `20.19.2` (or Node 22 LTS; pin one in the Pages project) |
| Environment variables | none for the normal static build |

The browser build does not require a Worker, Functions, Python, Node at runtime, or an API key. `VITE_TIPHYS_GEE_DEMO=1` is optional and only enables the labelled demo path; it is not a GEE credential and does not make Earth Engine connected.

Pages handles unknown paths with a static fallback only if configured. TIPHYS is currently a single `/` view, but if direct deep links are added, create `public/_redirects`:

```text
/* /index.html 200
```

For cache headers, keep the entry document fresh and hashed assets immutable. A `public/_headers` template is:

```text
/index.html
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

Do not enable the generic "Always Online" or HTML minification transforms if they rewrite worker/WASM URLs. After upload, verify the response headers and the exact MIME type with `curl -I https://tiphys.xyz/assets/geolibre-cli-*.wasm`; it must be `application/wasm`, not `application/octet-stream`.

An optional CLI deploy (after the project exists and Cloudflare credentials are configured outside this repository) is:

```bash
npx wrangler pages deploy dist --project-name tiphys
```

No deploy is performed by `npm run build`; the build is fully static and credential-free.

## COOP/COEP

The current build does **not** require cross-origin isolation. MapLibre and GeoLibre use module workers, not shared-memory threads. Do not set `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` by default: requiring COEP can break third-party basemap tiles, fonts, and attribution unless every cross-origin response opts in.

If a future release introduces `SharedArrayBuffer` worker threads, add both headers and audit every remote map/style/tile/font response for CORS or CORP compatibility before enabling them:

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

## API keys and GEE

- Browser model keys are entered by the user and stored in that browser's IndexedDB. Never place a shared model key in the static bundle.
- The current GEE path is an honest preparation/demo slice. Do not add a service-account key to the web root or browser environment. A future live GEE endpoint must be a trusted server-side proxy.
- `TIPHYS_GEE_DEMO=1` is a local demo switch, not production credentials. Browser builds use the Vite-exposed `VITE_TIPHYS_GEE_DEMO=1` at build time and still report `connected: false`.

## Smoke test after deploy

1. Open `https://tiphys.xyz/` and confirm the map and blue light theme render.
2. Open 工具箱 and wait for the count to reach the full catalog.
3. Load `samples/beijing_points.geojson` and run a small buffer.
4. Draw an AOI, verify its blue chip, then clear it.
5. Start a long task and confirm progress, stage text, and cancel remain visible.

