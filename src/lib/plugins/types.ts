import type { CatalogTool } from "../browser/catalog-schema";

/** Engine services available while an extension runs inside a browser job. */
export type ExtensionRunContext = {
  /** Run another catalog tool inline, sharing the current job and cancellation signal. */
  runTool: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
};

/** A browser extension contributes normal catalog tools and may execute them locally. */
export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  tools: CatalogTool[];
  run?: (toolName: string, args: Record<string, unknown>, context: ExtensionRunContext) =>
    Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type ExtensionRunResult = Record<string, unknown>;
