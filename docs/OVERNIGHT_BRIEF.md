# TIPHYS Build Brief (updated 2026-10-25 ~17:30 Asia/Shanghai)

> **STATUS: OVERNIGHT PAUSED** (2026-10-25). Do **not** start `tf-codex` / `tiphys-overnight-watch` unless the user explicitly asks to resume.
> **必读 `docs/AGENT_HANDOFF.md` 开头「怎么做得快 / Speed playbook」** — READ THAT FIRST, then this brief + `docs/OVERNIGHT_PROGRESS.md` + `docs/MASTER_ROADMAP.md` 的「2026-10-25 进度快照与下一阶段决策」。

Work **continuously** on **/workspace/tiphys** (Linux box) when resumed. Prefer `tf-codex` with tierflow_pro; rotate keys on quota. Fallbacks: plain `codex` → `tf-chat` / grok. **Do not stop.** Watcher restarts every ~30m if dead.

Governing docs: `docs/MASTER_ROADMAP.md` (V4), `docs/AGENT_HANDOFF.md`, stage reports, `docs/OVERNIGHT_PROGRESS.md`. Append every batch to OVERNIGHT_PROGRESS; commit + push when green.

UI direction (do not drift): blue accent `#2563eb`, light default, logo system, honest ~958 WASM catalog + 2-level taxonomy, chat-first map center. No teal, mythology chrome, fake tool counts. No mobile-layout ownership changes. Box only; no tiphys.xyz deploy unless asked; no secrets in git.

## Current state (2026-10-25 17:30) — do not redo

- **A0 functionally closed on single-run evidence:** browser budgets/search parameter cards/honest failure; desktop WASM bridge with regressions + `docs/DESKTOP_WASM_BRIDGE.md`; shared contracts stay honest.
- **Full 30-task model-in-the-loop baseline: 30/30 PASS** (single run; P50 30 s / P95 146 s; H08 48.7 s warn; 428k input tokens). It overlapped the inspect-context edit and is **not a frozen build**; no ≥3 repeats, real device, or cross-model comparison.
- **GeoAgentBench compatible subset: 5/6, weighted 0.833.** Capetown centroid, Paris KML and Capetown waterway fixed. Only Bangkok (21,660 polygons / 645k vertices) fails at the browser WASM resource boundary; a vector budget guard (20k features / 500k vertices) now fails honestly with desktop/chunking degrade.
- **Shipped:** web `https://tiphys.xyz` (`assets/index-Bcx4Lw_p.js`); Android debug APK 0.1.3 / versionCode 4; Windows portable rebuilt 2026-10-25 17:20 and copied to `C:\Users\alex\Desktop\TIPHYS`. Desktop GUI click-through is NOT_TESTED.
- **New capabilities:** native true centroid, empty-geometry filter, KML description/key-value fidelity, RFC 7946 GeoJSON 4326/2D export, attribute-table true XLSX (current page), inspect `analysisCrs`/`displayBounds` semantics.

## Next priority order (only when user resumes)

### 1 — Evidence hardening (no product rewrite)
- Run the 30-task baseline **≥3 times** and report variance/CI; do not present the single 30/30 as a stable ceiling.
- Real-device mobile checks (OPPO) and real desktop GUI startup/close; record NOT_TESTED honestly.
- Optional cross-model comparison under the same tasks/budgets/data.

### 2 — Stage 5A real watershed data
- Build the minimal “download → CRS/grid/NoData inspection → ingest → hydrology vertical” pipeline.
- At least 2 real small DEMs (SRTM/ALOS or equivalent), then re-run the existing `vertical:hydro` chain and report structural/sensitivity invariants.
- Do not claim basin/stream correctness from screen output; keep independent readback.

### 3 — Stage 5B network-distance service areas
- Add a reproducible road-network provider (OSRM/Valhalla or a precomputed local graph); keep Euclidean vs network distance explicit.
- Re-run `vertical:gis` with real schools/residents and count-conservation rules; no fake road-network claims.

### 4 — Stage 6 data and delivery
- GEE real auth → collection search → export/queue (honest disabled/demo states remain).
- STAC/COG/OSM ingestion; project save/share; print layout (scale bar/north arrow/legend/PDF) only if user needs it.
- A1 leftovers: full-table (not current-page) CSV/XLSX, field editing, undo/redo, systematic large-layer performance benchmarks.

### 5 — Bangkok / large-vector overlay
- Only invest if a high-frequency 20k+ vector task appears. 5,000 cleaned features still failed after 368 s; do not rewrite the geometry engine for one benchmark task. Keep the budget guard and desktop/chunking degrade.

### Explicitly deferred
- Real ecology models (InVEST/Circuitscape/real resistance), Play Store APK polish, tiphys.xyz redeploy without request, Windows sync unless asked, multi-agent orchestration, GIS fine-tuning, 3D/time-series, RTK/LiDAR/InSAR.

## Verification before commit
- `npx tsc --noEmit`
- Relevant: `npm run test:browser` (or browser-engine + note map-render environment), `test:contracts`, `test:methods`, `test:search`, `test:plans`, `test:centroid`, `test:vector-budget`, `test:xlsx`, agent/sidecar tests if present
- Append OVERNIGHT_PROGRESS.md; commit + push if `.git` writable; else `/tmp` patch for supervisor.

## Models
`tf-codex -C /workspace/tiphys` with tierflow. After each green batch, immediately start the next user-approved narrow batch. Never idle.
