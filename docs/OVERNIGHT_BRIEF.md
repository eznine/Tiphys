# TIPHYS Overnight Build Brief (updated 2026-10-25 ~12:50 Asia/Shanghai)

> **STATUS: OVERNIGHT PAUSED** (2026-10-25). Do **not** start `tf-codex` / tiphys-overnight-watch unless the user explicitly asks to resume.
> **必读 `docs/AGENT_HANDOFF.md` 开头「怎么做得快 / Speed playbook」** — READ THAT FIRST, then this brief + `docs/OVERNIGHT_PROGRESS.md`.

Work **continuously** on **/workspace/tiphys** (Linux box). Prefer `tf-codex` with tierflow_pro; rotate keys on quota. Fallbacks: plain `codex` → `tf-chat` / grok. **Do not stop.** Watcher restarts every ~30m if dead.

Governing docs: `docs/MASTER_ROADMAP.md` (V4), stage reports, `docs/OVERNIGHT_PROGRESS.md`. Append every batch to OVERNIGHT_PROGRESS; commit + push when green.

UI direction (do not drift): blue accent `#2563eb`, light default, logo system, honest ~958 WASM catalog + 2-level taxonomy, chat-first map center. No teal, mythology chrome, fake tool counts. No mobile-layout ownership changes. Box only; no Windows; no tiphys.xyz deploy unless asked; no secrets in git.

## User priority lock (2026-10-25 ~09:53 Asia/Shanghai) — SUPERSEDES earlier order

**Main line = Agent + whole-product reliability.** Ecology models (InVEST / Circuitscape / real resistance surfaces beyond the synthetic 5C corridor already shipped) are **deferred**. Do not spend batches on them.

Already shipped tonight (do not redo): P0 leftovers (zonal_stats desktop, Identify, layer menu, M11 params, symbology), Stage 5C synthetic corridor, Android debug APK shell, attr-table rename/definition query, GeoAgentBench schema/export product fixes, dissolve fail-loud + densify/layout/recipe batches through ~40.

## Current priority order (do in this order)

### A0 — Agent can finish real GIS jobs (highest)
1. **Browser Agent reliability**: reduce search→param friction (aliases, param cards, clearer tool schemas for hydrology IDs like `d8_pntr`); prefer task-class budgets over a brittle fixed step cap where the code still uses one; honest failure when tools/export are unsupported.
2. **Desktop Agent ↔ WASM bridge**: desktop Agent already has `wasm_run` — make discovery + params + layer/file binding reliable so Agent can use the same catalog tools the ribbon exposes (not only ~34 Python MCP tools). Document the bridge; add regressions for at least 2–3 WASM tools end-to-end from Agent.
3. **Shared contracts stay honest**: keep `OPERATION_SUPPORT` accurate; never silent-wrong dissolve/zonal on browser; prefer desktop Python degrade paths when browser cannot.
4. **GeoAgentBench product path**: keep schema/export/shp multifile discipline green; if the bench repo is available, re-score the compatible subset and report separately (do not invent scores). If network/clone blocked, leave a note and keep product regressions.

### A1 — Product GIS workbench that Agent depends on
5. Attribute / Identify / layer / symbology polish only when it unblocks Agent or delivery.
6. Export/delivery discipline (named files, metadata fields, no fake PDF/print claims).
7. Performance / large-layer safety that affects Agent jobs.

### A2 — Densify only after Agent batches move
8. More catalog-backed ribbon/recipes is fine **after** A0 has forward motion each cycle — never instead of Agent work.
9. OSS idea borrows into `/workspace/tiphys-refs/` with licenses — ideas only, no restricted copy.

### Explicitly deferred
- Real ecology models, network-distance service areas, real watershed datasets, Play Store APK polish, tiphys.xyz redeploy, Windows sync unless asked.

## Verification before commit
- `npx tsc --noEmit`
- Relevant: `npm run test:browser` (or browser-engine + note map-render EPERM), `test:contracts`, `test:methods`, `test:search`, `test:plans`, agent/sidecar tests if present
- Append OVERNIGHT_PROGRESS.md; commit + push if `.git` writable; else `/tmp` patch for supervisor

## Models
`tf-codex -C /workspace/tiphys` with tierflow. After each green batch, immediately start the next Agent-focused batch. Never idle.
