# TIPHYS Overnight Build Brief (2026-10-24)

Owner is asleep. Work continuously on **/workspace/tiphys** (this Linux box). **Do not use the user's Windows PC** — it is busy with ArcGIS Pro / GeoAgentPro. Ship targets later: Windows desktop + tiphys.xyz; sync to `F:\tiphys` only when the user frees that machine.

Private GitHub: eznine/Tiphys. Keep API keys out of git.

After every meaningful batch: update `docs/OVERNIGHT_PROGRESS.md`, run relevant tests, commit locally when coherent. Push to origin/main when stable (no secrets).

## Diagnosis already known

1. **Toolbox**: `wasm-catalog.json` has **958** tools; shell `catalog.json` ~27 → UI should show ~985. Live UI showed ~277 with old `GeoLibre · 矢量分析` labels — fix full catalog exposure + rebuild; Raster/RS/Terrain/Hydrology must appear.
2. **Ribbon** too sparse (`CommandRibbon.tsx`) — expand tabs/groups.
3. **Taxonomy**: two-level ArcGIS/QGIS-like (L1 folders, L2 groups); merge duplicate vector buckets. Use taxonomy.category/subcategory + zh maps.

## Priority order

### P0
- Full catalog in UI (~985) + 2-level taxonomy + search
- Default **light** theme; accent **blue** (not teal); wire `public/logo-temp.png`
- Expand CommandRibbon (数据/分析/遥感/GEE/视图)
- Browser perf: lazy catalog, workers, no main-thread jank

### P1
- Map click selection + attribute table linkage; spatial join
- More analysis exposed; ArcGIS-friendly IO adapters/stubs where feasible
- Desktop WASM unify path prepared (code here; Windows build later)

### P2
- GEE vertical slice (auth/search/export/job) + UI entry
- Agent discovery/planning/compaction improvements (`docs/AGENT_ARCH.md`)
- Borrow open agent patterns from `reference/agents/` (not proprietary Claude Code)

### P3
- Extra capabilities (corridor/LinkageMapper-style stub + plugin interface, etc.)
- License notices in THIRD_PARTY_NOTICES.md

### P4
- Beauty/UX polish; tiphys.xyz when web build ready

## Constraints
Best-available OSS reuse with notices. Differentiator = Agent+GIS orchestration. No secrets in git. **No Windows machineId work tonight.**

## Verify
`npm run test:browser`, `npx tsc --noEmit`, `npm run build`. Toolbox count ≈ 985 with 栅格/遥感/地形/水文.

## Progress
Maintain `docs/OVERNIGHT_PROGRESS.md`. Watcher restarts from that file.

## Models
Prefer box `tf-codex` / `tf-chat` / `codex` / `grok` with tierflow_pro. Rotate on quota. Keep going.
