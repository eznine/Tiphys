# TIPHYS M0

**EN** — Independent product shell: Tauri + React/TypeScript UI + MapLibre blank map + Python engine ping.  
**中文** — 独立产品壳：Tauri + React/TS 界面 + MapLibre 空白底图 + Python 引擎 ping。

> Path: `/workspace/tiphys/` (not under GeoAgentPro).  
> Brand: navigator / *From Intent to Outcome*. Design tokens in `src/styles/tokens.css`.

## Stack (decided)

| Layer | Choice |
|-------|--------|
| Shell | Tauri 2 |
| Agent / UI | React + TypeScript (Vite) |
| Map | MapLibre GL (OSM tiles, no API key) |
| Spatial engine | Python FastAPI sidecar (M0: `/ping` only) |

Windows is a must-ship target later; develop and verify on Linux first.

## Prerequisites (Linux)

- Node.js 20+, npm
- Rust (`rustc` / `cargo`) matching Tauri 2
- System libs for Tauri: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `pkg-config`
- Python 3.11+ (venv with FastAPI + Uvicorn)

## Run on Linux

### 1. Python engine (sidecar)

```bash
cd /workspace/tiphys
python3 -m venv engine/.venv          # once
engine/.venv/bin/pip install -r engine/requirements.txt
npm run engine
# → http://127.0.0.1:8765/ping  →  {"ok":true,"service":"tiphys-engine"}
```

Verify: `npm run engine:ping` or `curl -s http://127.0.0.1:8765/ping`

### 2. UI (Vite only — no display needed)

```bash
cd /workspace/tiphys
npm install
npm run dev          # http://localhost:1420
```

Open the URL in a browser; click **Ping** or wait for auto-ping. Map needs network for OSM tiles.

### 3. Full Tauri desktop

Requires a display (X11/Wayland). Headless boxes will fail `tauri dev` at window creation.

```bash
cd /workspace/tiphys
# start engine in another terminal first
npm run tauri dev
```

Headless / CI substitutes:

```bash
npm run check:rust   # cargo check
npm run build        # tsc + vite build
npm run engine &     # then engine:ping
```

## Design language (M0 chrome)

- Accent teal `#0D9488` → `#14B8A6` for CTA / active / route progress line  
- Dark surfaces `#0B1220` / `#111827`; light `#F8FAFC` / white  
- Layout: thin layer rail · **map center** · ~360px Agent chat dock · minimal top bar + theme toggle  
- Tokens: `src/styles/tokens.css`

## Windows packaging (later)

M0 does not ship Windows installers yet. Planned: `tauri build` → NSIS/MSI (and optional portable) on a Windows runner. Keep the same repo; no GeoAgentPro coupling.

## Project layout

```
tiphys/
  src/                 React UI + MapLibre + tokens
  src-tauri/           Tauri 2 shell
  engine/              Python FastAPI sidecar
  NOTES_M0.md          What works + versions
  README.md            This file
```


## Agent (M2-lite)

```bash
npm run engine     # Python engine + MCP at http://127.0.0.1:8765 (/ping, /mcp/)
npm run agent      # agent sidecar at http://127.0.0.1:8787 (mock model unless TIPHYS_LLM_* set)
DISPLAY=:9 npm run tauri dev
```
See `docs/AGENT_ARCH.md` (中文) and `agent/.env.example`. Third-party attributions: `THIRD_PARTY_NOTICES.md`.
