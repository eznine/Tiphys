/** Credentials stay in memory and are sent in headers, including map and SSE requests. */
import { browserRuntime } from "./runtime";
import type { CatalogTool } from "./browser/catalog-schema";
export const AGENT_URL = import.meta.env?.VITE_AGENT_URL?.replace(/\/$/, "") || "http://127.0.0.1:8972";
let token = "";
let engineUrl = import.meta.env?.VITE_ENGINE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8971";
/** Jobs submitted to the in-WebView WASM worker must keep polling there. */
const browserJobIds = new Set<string>();

export function engineHeaders(url: string) {
  return token && url.startsWith(`${engineUrl}/`) ? { Authorization: `Bearer ${token}` } : undefined;
}

/** Resolved engine base URL (bootstrap may override the Vite env default). */
export function currentEngineUrl(): string {
  return engineUrl;
}

async function pythonEngineRequest(path: string, init: RequestInit = {}) {
  if (!token) await bootstrap(init.signal ?? undefined);
  const url = `${engineUrl}${path}`;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(engineHeaders(url) ?? {})) headers.set(name, value);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body.error ?? `HTTP ${response.status}`));
  }
  return response;
}

function requestedToolName(init: RequestInit): string | undefined {
  if (typeof init.body !== "string") return undefined;
  try {
    const body = JSON.parse(init.body);
    return typeof body?.name === "string" ? body.name : undefined;
  } catch { return undefined; }
}

function browserJobId(pathname: string): string | undefined {
  const match = /^\/jobs\/([^/]+)(?:\/cancel)?$/.exec(pathname);
  return match && browserJobIds.has(decodeURIComponent(match[1])) ? decodeURIComponent(match[1]) : undefined;
}

async function rememberBrowserJob(response: Response) {
  if (!response.ok) return response;
  const data = await response.clone().json().catch(() => undefined);
  if (typeof data?.job_id === "string") browserJobIds.add(data.job_id);
  return response;
}

export async function engineRequest(path: string, init: RequestInit = {}) {
  const pathname = new URL(path, "https://engine.invalid").pathname;
  // Bundled WASM tools can still run in the desktop WebView's worker. Everything
  // else keeps using the local Python MCP engine there.
  if (pathname === "/tools/run" && requestedToolName(init)?.startsWith("wasm_"))
    return rememberBrowserJob(await (await import("./browser/engine")).browserEngineRequest(path, init));
  if (browserRuntime) return (await import("./browser/engine")).browserEngineRequest(path, init);
  if (browserJobId(pathname)) return (await import("./browser/engine")).browserEngineRequest(path, init);
  if (pathname === "/tools/catalog") {
    const response = await pythonEngineRequest(path, init);
    const data = await response.json();
    const { desktopToolCatalog, wasmToolSchemas } = await import("./browser/catalog-schema");
    const pythonTools: CatalogTool[] = Array.isArray(data.tools) ? data.tools : [];
    const tools = desktopToolCatalog(pythonTools);
    return Response.json({ ...data, tools, catalog: { python: pythonTools.length, wasm: wasmToolSchemas.length, total: tools.length } });
  }
  return pythonEngineRequest(path, init);
}

export async function bootstrap(signal?: AbortSignal) {
  if (browserRuntime) { signal?.throwIfAborted(); return; }
  const response = await fetch(`${AGENT_URL}/bootstrap`, { headers: { "X-Tiphys-Client": "1" }, signal });
  if (!response.ok) throw new Error(`连接 Agent 失败（HTTP ${response.status}）`);
  const config = await response.json();
  token = config.token;
  engineUrl = config.engineUrl;
}

export async function agentRequest(path: string, init: RequestInit = {}) {
  if (browserRuntime) return (await import("./browser/agent")).browserAgentRequest(path, init);
  if (!token) await bootstrap(init.signal ?? undefined);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${AGENT_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `HTTP ${response.status}`);
  }
  return response;
}

export async function agentHealth(signal?: AbortSignal) {
  const response = browserRuntime ? await agentRequest("/health", { signal }) : await fetch(`${AGENT_URL}/health`, { signal });
  return response.json();
}

/** Fetch-based SSE supports authentication headers and an explicit replay cursor. */
export async function readEvents(response: Response, receive: (event: any) => void) {
  if (!response.body) throw new Error("Agent 事件流为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let split: number;
      while ((split = pending.search(/\r?\n\r?\n/)) >= 0) {
        const block = pending.slice(0, split);
        const separator = pending.slice(split).match(/^\r?\n\r?\n/)![0];
        pending = pending.slice(split + separator.length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) receive(JSON.parse(data));
      }
      if (done) return;
    }
  } finally { reader.releaseLock(); }
}
