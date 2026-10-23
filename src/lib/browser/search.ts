import type { CatalogTool } from "./catalog-schema";
import { zhTool, zhToolL1, zhToolL2 } from "../i18n/tools";

const SEARCHABLE_PREFIXES = ["wasm_", "gee_"];

export function isBrowserSearchable(name: string): boolean {
  return SEARCHABLE_PREFIXES.some(prefix => name.startsWith(prefix));
}

function normalized(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Score one catalog tool against a query. Names and Chinese labels are strongest;
 * taxonomy and descriptions help broad requests such as "网络分析" or "栅格叠加".
 */
export function scoreBrowserTool(tool: CatalogTool, query: string): number {
  const zh = zhTool(tool.name);
  const name = normalized(tool.name);
  const label = normalized(tool.label);
  const zhName = normalized(zh?.name);
  const category = normalized(tool.category);
  const zhCategory = normalized(zhToolL1(tool));
  const subcategory = normalized(tool.subcategory);
  const zhSubcategory = normalized(zhToolL2(tool));
  const description = normalized(`${tool.description ?? ""} ${zh?.desc ?? ""}`);
  const phrase = normalized(query);
  if (!phrase) return 0;
  const tokens = [...new Set(phrase.split(" ").filter(Boolean))];
  let score = 0;
  let matchedTokens = 0;

  if (name === phrase) score += 160;
  else if (name.includes(phrase)) score += 80;
  if (zhName === phrase) score += 150;
  else if (zhName.includes(phrase)) score += 75;
  if (label === phrase) score += 140;
  else if (label.includes(phrase)) score += 65;
  if (zhCategory === phrase) score += 55;
  else if (zhCategory.includes(phrase)) score += 28;
  if (zhSubcategory === phrase) score += 65;
  else if (zhSubcategory.includes(phrase)) score += 34;
  if (category === phrase || subcategory === phrase) score += 30;

  for (const token of tokens) {
    let tokenScore = 0;
    if (name === token || zhName === token) tokenScore += 80;
    else if (name.startsWith(token) || zhName.startsWith(token)) tokenScore += 45;
    else if (name.includes(token) || zhName.includes(token) || label.includes(token)) tokenScore += 30;
    if (zhCategory === token || zhSubcategory === token || category === token || subcategory === token) tokenScore += 24;
    else if (zhCategory.includes(token) || zhSubcategory.includes(token) || category.includes(token) || subcategory.includes(token)) tokenScore += 13;
    if (description.includes(token)) tokenScore += 7;
    if (tokenScore) { matchedTokens++; score += tokenScore; }
  }
  return matchedTokens === tokens.length ? score : 0;
}

export function searchBrowserTools(
  tools: CatalogTool[],
  query: string,
  options: { limit?: number; searchable?: (name: string) => boolean } = {},
): CatalogTool[] {
  const limit = options.limit ?? 8;
  const searchable = options.searchable ?? isBrowserSearchable;
  return tools
    .filter(tool => searchable(tool.name))
    .map(tool => ({ tool, score: scoreBrowserTool(tool, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(item => item.tool);
}
