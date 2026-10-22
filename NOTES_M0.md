# TIPHYS NOTES — M0

Scaffolded on the Linux box at `/workspace/tiphys/` (fresh; not under GeoAgentPro).

## What works

| Check | Status | Notes |
|-------|--------|-------|
| Project scaffold | OK | `create-tauri-app` React-TS + Tauri 2 |
| Design tokens + shell chrome | OK | `src/styles/tokens.css`, chat dock / map / top bar / theme toggle |
| MapLibre blank map | OK | OSM raster, no API key; dark theme soft-desaturates tiles |
| Python `/ping` | OK | FastAPI → `{"ok":true,"service":"tiphys-engine"}` on `:8765` |
| TS → ping in UI | OK | Auto + Ping button + chat “ping”; CORS open for local dev |
| `npm run build` (vite) | OK | tsc + vite production build |
| `cargo check` | OK | finished in ~1m15s |
| `npm run tauri dev` / debug binary | Partial | `cargo build` OK; DISPLAY=:9 present; first `tauri dev` smoke hit compile timeout — re-run after warm build |

## Versions (box, Asia/Shanghai)

Recorded at scaffold time — re-check with the commands below if the environment drifts.

| Tool | Version |
|------|---------|
| rustc | 1.85.1 |
| cargo | 1.85.1 |
| node | v20.19.2 |
| npm | 11.21.0 |
| python3 | 3.13.5 |
| webkit2gtk | 4.1 (2.54.0) |
| tauri (crate) | 2.11.6 |
| @tauri-apps/cli | 2.12.4 |
| React | 19.3.1 |
| Vite | 8.3.5 |
| maplibre-gl | 6.15.0 |
| fastapi (venv) | 0.160.0 |
| uvicorn (venv) | 0.54.0 |

**Verified 2026-10-23 ~01:09 CST (Asia/Shanghai):** `curl /ping` OK · `npm run build` OK · `cargo check` OK · `cargo build` (debug) OK. Engine left runnable via `npm run engine`.

## How to re-verify

```bash
cd /workspace/tiphys
npm run engine &          # or: engine/.venv/bin/uvicorn ...
curl -sS http://127.0.0.1:8765/ping
npm run build
npm run check:rust
# with display:
npm run tauri dev
```

## Blockers / known gaps

1. **Headless display** — full `tauri dev` needs a GUI session; without it, rely on `cargo check` + `vite`/`npm run build` + engine ping.
2. **Windows packaging** — deferred; Linux-first development.
3. **Engine process management** — M0 starts Python manually; Tauri sidecar bundling is post-M0.
4. **OSM tiles** — need outbound HTTPS; offline = blank/underlay only.
5. **No spatial tools yet** — chat replies are stub; ping is the only engine capability.

## Design paths

- Tokens: `/workspace/tiphys/src/styles/tokens.css`
- Shell CSS: `/workspace/tiphys/src/styles/app.css`
- Map: `/workspace/tiphys/src/components/MapCanvas.tsx`
- Chat dock: `/workspace/tiphys/src/components/ChatDock.tsx`
- Engine client: `/workspace/tiphys/src/lib/engine.ts`
- Engine server: `/workspace/tiphys/engine/main.py`
