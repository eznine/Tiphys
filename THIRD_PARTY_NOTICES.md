# Third-party notices

TIPHYS uses or adapts the following third-party works. Full license texts are in each project's LICENSE file (paths are the local reference clones under `/workspace/tiphys-refs/`).

## Code / text adapted into TIPHYS

| What | From | License | Where in TIPHYS |
|---|---|---|---|
| Compaction handoff prompt + "summary prefix" wording (lightly edited, GIS-state line added) | openai/codex — `codex-rs/prompts/templates/compact/prompt.md`, `summary_prefix.md` | Apache-2.0, Copyright OpenAI | `agent/src/context.ts` (`COMPACT_PROMPT`, `SUMMARY_PREFIX`) |
| Compaction ratios (trigger 0.8, retain ~0.16), tool-output spill-to-file idea, jobs surface (`job_id` returned immediately, status/cancel, progress, no fixed timeout) | deepseek-ai/deepseek-harness — `packages/compaction`, `packages/spill`, `packages/jobs/jobs/src/types.ts` | MIT, Copyright DeepSeek | `agent/src/context.ts`, `engine/jobs.py` (re-implemented, not copied) |
| 80% auto-compaction threshold (same constant) | block/goose — `crates/goose/src/context_mgmt/mod.rs` | Apache-2.0, Copyright Block, Inc. | `agent/src/context.ts` |
| `buffer` tool parameter shape (input/distance/units/dissolve/output name, 5000 km limit) | RustGIS — `crates/analysis/src/tools.rs` | Apache-2.0 | `engine/geo_ops.py`, MCP `buffer` schema |
| Unit vocabulary meters/kilometers/miles | GeoLibre — `packages/processing/src/vector-tools.ts` | MIT, Copyright (c) 2026 Qiusheng Wu | `engine/geo_ops.py` |

## Libraries (dependencies, used unmodified)

- Vercel AI SDK `ai`, `@ai-sdk/openai-compatible` — Apache-2.0
- `@modelcontextprotocol/sdk` (TypeScript), `mcp` (Python) — MIT / Apache-2.0 (see packages)
- geopandas (BSD-3), shapely (BSD-3), pyproj (MIT), pyogrio (MIT), FastAPI (MIT), uvicorn (BSD-3)
- maplibre-gl (BSD-3), React (MIT), Tauri (MIT/Apache-2.0)

No code from Anthropic Claude Code / Claude Agent SDK (proprietary) is used.

---

### Apache License 2.0 notice (Codex, Goose, RustGIS)
Licensed under the Apache License, Version 2.0 (the "License"); you may not use these files except in compliance with the License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0. Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. Modified portions are marked in source comments.

### MIT License (GeoLibre, deepseek-harness)
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
