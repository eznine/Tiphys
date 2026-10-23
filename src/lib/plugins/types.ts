import type { CatalogTool } from "../browser/catalog-schema";

/** A browser extension contributes normal catalog tools and may execute them locally. */
export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  tools: CatalogTool[];
  run?: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type ExtensionRunResult = Record<string, unknown>;
