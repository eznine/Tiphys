/**
 * Offline regression for tool discovery (stage 2, T-005).
 *
 * Loads the real shell catalog and the real 958 WASM schemas (no mocks), runs
 * the labeled query set through the same search path the browser agent uses,
 * and reports Top-1 / Top-5 / MRR plus a "gap" metric: for queries where no
 * browser tool exists, does search still emit a confident-looking candidate?
 *
 * Usage: npm run eval:search [-- --json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemaForWasm, shellToolCatalog, type CatalogTool } from "../src/lib/browser/catalog-schema.ts";
import { isBrowserSearchable, scoreBrowserTool, searchBrowserTools } from "../src/lib/browser/search.ts";
import { pluginToolNames } from "../src/lib/plugins/registry.ts";
import { compactTool } from "../src/lib/browser/candidates.ts";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const DATASET = path.join(ROOT, "tests", "search", "labeled-queries.json");
const WASM_MANIFESTS = path.join(ROOT, "src", "lib", "browser", "wasm-catalog.json");
const SCORE_FLOOR = 40;

type Entry = { query: string; expect: string[]; group: "natural" | "alias" | "gap" };

export type QueryResult = {
  query: string;
  group: Entry["group"];
  expect: string[];
  ranked: string[];
  topScore: number;
  top1: boolean;
  top5: boolean;
  reciprocalRank: number;
  confidentWhenGap: boolean;
};

export function catalogForEvaluation(): { tools: CatalogTool[]; searchable: (name: string) => boolean } {
  const manifests = JSON.parse(fs.readFileSync(WASM_MANIFESTS, "utf8")) as Parameters<typeof schemaForWasm>[0][];
  const tools = [...shellToolCatalog, ...manifests.map(manifest => schemaForWasm(manifest))];
  return { tools, searchable: (name: string) => isBrowserSearchable(name) || pluginToolNames.has(name) };
}

const bare = (name: string) => name.replace(/^wasm_/, "");

export function evaluate(options: { limit?: number } = {}) {
  const limit = options.limit ?? 5;
  const dataset = JSON.parse(fs.readFileSync(DATASET, "utf8")) as { entries: Entry[] };
  const { tools, searchable } = catalogForEvaluation();
  const ids = new Set(tools.map(tool => tool.name));
  const missing = dataset.entries.flatMap(entry => entry.expect.filter(id => !ids.has(`wasm_${id}`) && !ids.has(id)).map(id => `${entry.query} -> ${id}`));
  const results: QueryResult[] = dataset.entries.map(entry => {
    const ranked = searchBrowserTools(tools, entry.query, { searchable, limit }).map(tool => bare(tool.name));
    const topScore = ranked.length
      ? Math.max(...searchBrowserTools(tools, entry.query, { searchable, limit }).map(tool => scoreBrowserTool(tool, entry.query)))
      : 0;
    const position = ranked.findIndex(name => entry.expect.includes(name));
    return {
      query: entry.query, group: entry.group, expect: entry.expect, ranked, topScore,
      top1: position === 0, top5: position >= 0 && position < limit,
      reciprocalRank: position >= 0 ? 1 / (position + 1) : 0,
      confidentWhenGap: entry.group === "gap" && topScore >= SCORE_FLOOR,
    };
  });
  const summarise = (group: Entry["group"]) => {
    const entries = results.filter(result => result.group === group);
    const n = entries.length || 1;
    return {
      count: entries.length,
      top1: entries.filter(result => result.top1).length / n,
      top5: entries.filter(result => result.top5).length / n,
      mrr: entries.reduce((sum, result) => sum + result.reciprocalRank, 0) / n,
    };
  };
  const gaps = results.filter(result => result.group === "gap");
  return {
    total: results.length,
    aliases: summarise("alias"),
    natural: summarise("natural"),
    gap: {
      count: gaps.length,
      confident: gaps.filter(result => result.confidentWhenGap).length,
      confidentRate: gaps.length ? gaps.filter(result => result.confidentWhenGap).length / gaps.length : 0,
    },
    missingLabels: missing,
    results,
  };
}

/** Compact view of the candidates the agent would receive for one query. */
export function preview(query: string, limit = 3) {
  const { tools, searchable } = catalogForEvaluation();
  const found = searchBrowserTools(tools, query, { searchable, limit });
  return {
    candidates: found.map(tool => compactTool(tool)),
    bytes: Buffer.byteLength(JSON.stringify(found.map(tool => compactTool(tool))), "utf8"),
    fullBytes: Buffer.byteLength(JSON.stringify(found), "utf8"),
  };
}

if (process.argv[1] && /search-eval\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const report = evaluate();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    console.log(`labeled queries: ${report.total} (natural ${report.natural.count} / alias ${report.aliases.count} / gap ${report.gap.count})`);
    console.log(`natural  Top-1 ${pct(report.natural.top1)}  Top-5 ${pct(report.natural.top5)}  MRR ${report.natural.mrr.toFixed(3)}`);
    console.log(`alias    Top-1 ${pct(report.aliases.top1)}  Top-5 ${pct(report.aliases.top5)}  MRR ${report.aliases.mrr.toFixed(3)}`);
    console.log(`gap      confident candidates ${report.gap.confident}/${report.gap.count} (${pct(report.gap.confidentRate)})`);
    if (report.missingLabels.length) {
      console.log(`\nBAD LABELS (${report.missingLabels.length}):`);
      for (const line of report.missingLabels) console.log(`  ${line}`);
    }
    const misses = report.results.filter(result => result.group !== "gap" && !result.top5);
    if (misses.length) {
      console.log(`\nMISSES (${misses.length}):`);
      for (const miss of misses) console.log(`  ${miss.query}  expect=${miss.expect.join("|")}  got=${miss.ranked.slice(0, 3).join("|")}`);
    }
    const falseAlarms = report.results.filter(result => result.confidentWhenGap);
    if (falseAlarms.length) {
      console.log(`\nCONFIDENT ON GAPS (${falseAlarms.length}):`);
      for (const item of falseAlarms) console.log(`  ${item.query}  score=${item.topScore.toFixed(0)}  got=${item.ranked.slice(0, 2).join("|")}`);
    }
    const sample = preview("统计每个区的平均高程");
    console.log(`\ncompact candidates: ${sample.candidates.length} items, ${sample.bytes} bytes vs ${sample.fullBytes} bytes full schemas`);
  }
  process.exitCode = report.missingLabels.length ? 1 : 0;
}