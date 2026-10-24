# TIPHYS Overnight Build Brief (2026-10-25)

Owner is asleep until morning (Asia/Shanghai). Work **continuously** on **/workspace/tiphys** (this Linux box). Prefer `tf-codex` with tierflow_pro; rotate keys on quota (`tf-codex` already rotates). Fallbacks: another key → plain `codex` → `tf-chat` / grok. **Do not stop.** Watcher restarts every ~30m if dead.

Windows PC `F:\tiphys` is in sync with GitHub at kickoff (`017709e`); overnight coding stays on the box. Sync/copy to Windows only if asked later. tiphys.xyz deploy = nginx rsync (see `docs/DEPLOY_TIPHYS_XYZ.md`), not Cloudflare Pages. No secrets in git. Password/keys live outside repo (`F:\server\…` on Windows; box uses env / `~/.config/tiphys`).

Governing docs (read these, do not invent a parallel plan):
- `docs/MASTER_ROADMAP.md` (V4) — decision + acceptance
- `docs/AI_GIS_STRATEGY_20261024.md` → points at roadmap
- `docs/research_20261024/*` especially `05_product_strategy.md`
- `docs/USER_NEEDS_RESEARCH.md`
- Stage reports: STAGE1–5B, BASELINE_STAGE0

Progress log: append every batch to `docs/OVERNIGHT_PROGRESS.md`. Commit + push when a batch is green. Update roadmap progress table when a stage item closes.

## Current status (2026-10-25 ~03:25 CST)

Stages 0–4 ✅ (sim scope); 5A hydrology ✅; 5B service-zone (euclidean) ✅; **5C ecology NOT started**.
Known gaps still open from the plan:
- Browser `gis.dissolve` broken (WASM FGB writer; D1/D2) — do not ship silent-wrong GeoJSON workaround
- `gis.zonal_statistics` designed only — **implement** (vector zones + raster values) on at least one engine, honest contracts
- Stage4 M11 still fails (search → param-name friction, e.g. `d8_pntr`)
- GeoAgentBench subset 2/6; schema fidelity / export discipline / bare-.shp import gaps
- Real-device mobile variance ≥3 not done (skip waking user; use Playwright 390×844)
- Network distance for service-zone, real watershed data — later if time

UI direction: blue accent `#2563eb`, light default, SVG logo system, full ~958 WASM catalog + 2-level taxonomy, chat-first map center. **No teal, no mythology chrome, no fake tool counts.**

## Priority order tonight

### P0 — finish plan leftovers (do these first)
1. **`gis.zonal_statistics`**: real implementation + tests + update OPERATION_SUPPORT / STAGE2 notes. Prefer Python desktop provider first if WASM path is unclear; then browser if feasible.
2. **Identify / attribute UX** (USER_NEEDS P0): copy value/row, export, filter-by-value, jump to table row.
3. **Layer context menu**: reload from source, export/save-as, metadata view.
4. **M11 friction**: better tool param cards / aliases so hydrology params like `d8_pntr` are discoverable; re-run relevant baseline slice if cheap.
5. **Symbology**: graduated colors with manual min/max + auto breaks (at least vector).

### P1 — Stage 5C + workbench
6. **5C ecology corridor vertical** (min-cost corridor style; Linkage Mapper *concepts*, not ArcPy). Fixtures + task card + procedural checks + `docs/STAGE5C_*.md`. Clone/reference OSS under `/workspace/tiphys-refs/` with license notes.
7. Attribute-table basics: rename field, simple definition query.
8. Expand GeoAgentBench compatible subset or fix schema/export failures that blocked scores.
9. Method skills from `muend/geoai-skills` style: more guardrails in knowledge (CRS/units/overlay double-count), not RAG dump.

### P2 — Android offline APK (user asked tonight)
10. Scaffold **offline-capable Android APK** wrapping the existing web app (Capacitor or similar WebView shell). Bundle `dist/` + WASM assets so it opens without network for core map/tools. Document build steps in `docs/ANDROID_APK.md`. Prefer getting a debug APK artifact under `android/` or `dist-apk/` on the box; do not need Play Store signing tonight. Keep engine = browser WASM (no native GIS rewrite). Note memory limits for big rasters.

### P3 — densify / OSS borrow (after P0–P2 have forward motion)
11. Pull useful OSS into `/workspace/tiphys-refs/` (GISclaw patterns, geoai-skills, Whitebox notes, DuckDB-spatial spike, PMTiles, InVEST habitat-quality spike, pysheds cross-check) — adapt ideas into TIPHYS; record licenses in `docs/licenses/` / THIRD_PARTY.
12. Desktop WASM bridge polish; recipe/export improvements; layout/print stub; performance for large layers.
13. Anything clearly valuable from research that fits “reliable GIS task completion” — keep going.

## Constraints
- Box only for coding. Don’t fight Windows overnight.
- Don’t touch mobile layout the user owns unless fixing regressions from your changes.
- No secrets in git. No wrangler/Pages deploy path.
- Prefer small verified batches: implement → test (`npm run test:browser`, `npm run test:contracts`, `npx tsc --noEmit`, relevant vertical scripts) → commit → push → append OVERNIGHT_PROGRESS → next batch.
- If a key/quota dies, rotate and continue. If sandbox blocks `.git`, save patch under `/tmp` and note in progress for supervisor.
- About hourly: self-check UI direction (blue/light/logo/catalog honesty).

## Models
`tf-codex -C /workspace/tiphys` with tierflow profile. Keep a long-running loop: after each successful batch, immediately start the next. Never idle waiting for the user.

## User order lock (2026-10-25 ~03:29 CST)
1. **Finish the plan leftovers first** (MASTER_ROADMAP incomplete items: zonal_statistics, Identify UX, layer menu, M11 params, symbology, then 5C ecology, etc.).
2. **Only after that**: Android offline APK — rough Capacitor/WebView shell prototype is enough.
3. **Then** keep advancing later roadmap items and continuous optimization.

Do not start APK work until P0/P1 plan items above have landed or are honestly blocked with a written note in OVERNIGHT_PROGRESS.md.
