import { isTauri } from "@tauri-apps/api/core";

/** Desktop keeps its local sidecars; ordinary web pages never require them. */
export const browserRuntime = typeof window !== "undefined" && !isTauri();
