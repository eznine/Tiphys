# Deploying TIPHYS at tiphys.xyz

Checked 2026-10-24 against the current Vite build. The browser build is a static SPA: no Node, Python, database, or local port is required. The optional desktop runtime is separate.

## Build and upload

```bash
npm ci
npm run build
```

Upload the contents of `dist/` to the web root. Keep the generated `assets/` filenames unchanged; Vite hashes them for cache busting. The map worker URL is emitted by `?url` import in `MapCanvas.tsx`, so do not rewrite files inside `assets/`.

Minimum server behavior:

- Serve `/` and unknown SPA routes from `index.html`.
- Serve `.wasm` as `Content-Type: application/wasm`.
- Serve `index.html` with `Cache-Control: no-cache`.
- Serve hashed `/assets/*` files with a long immutable cache.
- Allow large static WASM responses; do not add an application-level body size limit to GET assets.

`deploy/nginx-tiphys.conf` is a working baseline for these rules.

## Current payload shape

- `wasm-catalog.json` is a lazy chunk of roughly 1.9 MB in the current build. It contains tool schemas, not cartographic tiles.
- `geolibre-cli.wasm` is about 24 MB and `geolibre_wasm_bg.wasm` about 6.6 MB in the current dependency. They are fetched for local WASM tools and are not part of the initial HTML.
- The map starts before tool catalog hydration finishes. The toolbox shows a 39-tool shell first and reaches 997 merged tools after hydration (993 visible after hiding four engine-only controls).
- Enable Brotli/gzip for HTML, JS, CSS and JSON. The host may also compress `.wasm`; always preserve the `application/wasm` type.

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

