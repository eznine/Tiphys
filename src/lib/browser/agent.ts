import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from "ai";
import { browserCatalog, browserLayers, browserLogs, cancelBrowserJob, engineEvents, readBrowserJob, recordLog, runBrowserTool } from "./engine";
import { ensureBrowserCatalog } from "./catalog-schema";
import { readRecord, writeRecord } from "./storage";
import { pluginToolNames } from "../plugins/registry";
import { compactBrowserMessages, readBrowserContextRecord, type BrowserWorkspace } from "./context";
import { browserProjectMemory } from "./memory";
import { buildBrowserSystemPrompt } from "./prompt";
import { isBrowserSearchable, searchBrowserTools } from "./search";
import { normalizeAgentSessionStub, normalizeWorkspaceRecovery } from "../workspace";

type Event = { type: string; seq?: number; ts?: number; [key: string]: any };
type Session = { id: string; seq: number; events: Event[]; messages: ModelMessage[]; busy: boolean; workspace?: Partial<BrowserWorkspace>; controller?: AbortController; listeners: Set<(event: Event) => void> };
type Config = { transport: "direct" | "desktop-proxy"; baseURL: string; model: string; apiKeys: string[]; keyCount: number; contextWindow: number; maxToolOutputChars: number };
const sessions = new Map<string, Promise<Session>>();
const approvals = new Map<string, (approved: boolean) => void>();
let configPromise: Promise<Config> | undefined;
let proxyToken = "";
const proxyURL = "http://127.0.0.1:8972";
const decoder = new TextDecoder();
const emptyConfig = (): Config => ({ transport: "direct", baseURL: "", model: "", apiKeys: [], keyCount: 0, contextWindow: 64000, maxToolOutputChars: 6000 });
async function proxyRequest(path: string, init: RequestInit = {}) {
  if (!proxyToken) {
    const response = await fetch(`${proxyURL}/bootstrap`, { headers: { "X-Tiphys-Client": "1" }, signal: init.signal });
    if (!response.ok) throw new Error("桌面模型代理不可用，请检查 Agent 或在设置中填写自己的 API。");
    proxyToken = (await response.json()).token;
  }
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${proxyToken}`);
  const response = await fetch(`${proxyURL}${path}`, { ...init, headers });
  if (response.status === 401) proxyToken = "";
  return response;
}
async function loadConfig(): Promise<Config> {
  const saved = await readRecord<Config>("api-config");
  if (saved) return saved;
  // Optional local model proxy: only probe it on trusted loopback development pages.
  // No GIS data, jobs or files use this service.
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    try {
      const response = await fetch(`${proxyURL}/health`, { signal: AbortSignal.timeout(1200) });
      const health = await response.json();
      if (health.provider === "openai-compatible") {
        const settings = await (await proxyRequest("/settings", { signal: AbortSignal.timeout(2000) })).json();
        return { ...emptyConfig(), transport: "desktop-proxy", baseURL: settings.baseURL, model: settings.model, keyCount: settings.keyCount,
          contextWindow: settings.contextWindow, maxToolOutputChars: settings.maxToolOutputChars };
      }
    } catch { /* An entirely static web app still works; API can be configured later. */ }
  }
  return emptyConfig();
}
const getConfig = () => configPromise ??= loadConfig();
function settings(config: Config) {
  return { provider: config.apiKeys.length || config.transport === "desktop-proxy" && config.keyCount ? "openai-compatible" : "unconfigured", model: config.model, baseURL: config.baseURL,
    hasApiKey: config.apiKeys.length > 0 || config.keyCount > 0, keyCount: config.apiKeys.length || config.keyCount,
    keySource: config.transport === "desktop-proxy" ? "桌面 API 代理（GIS 在浏览器计算）" : "此浏览器 API 设置", configIssue: "",
    configPath: "此浏览器 · IndexedDB", contextWindow: config.contextWindow, maxToolOutputChars: config.maxToolOutputChars, environmentOverrides: [], transport: config.transport };
}
function cleanError(error: unknown, config: Config) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of config.apiKeys) message = message.split(key).join("[已脱敏]");
  return message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [已脱敏]");
}
function validAoi(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map(Number);
  if (!bbox.every(Number.isFinite)) return null;
  if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
  return bbox;
}
function validSelection(value: unknown): { layerId: string; featureIds: number[] } | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const layerId = typeof item.layerId === "string" && item.layerId.trim() ? item.layerId.slice(0, 160) : "";
  if (!layerId || !Array.isArray(item.featureIds)) return null;
  const featureIds = [...new Set(item.featureIds.map(Number).filter(id => Number.isInteger(id) && id >= 0))].slice(0, 2500);
  return featureIds.length ? { layerId, featureIds } : null;
}

export const systemPrompt = (layers: Array<Record<string, unknown>>, workspace: Parameters<typeof buildBrowserSystemPrompt>[1] = {}) =>
  buildBrowserSystemPrompt(layers, workspace, browserProjectMemory());
function modelFor(config: Config) {
  if (!settings(config).hasApiKey) throw new Error("请打开设置，配置 API 地址、模型和密钥。GIS 工具可直接在浏览器使用。");
  let index = 0;
  const request: typeof fetch = async (_input, init) => {
    if (config.transport === "desktop-proxy") return proxyRequest("/model/chat/completions", init);
    let last: Response | undefined;
    for (let n = 0; n < config.apiKeys.length; n++) {
      const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${config.apiKeys[index % config.apiKeys.length]}`);
      const response = await fetch(_input, { ...init, headers });
      if (![401, 402, 403, 429].includes(response.status) && response.status < 500) return response;
      last = response; index++;
    }
    return last!;
  };
  return createOpenAICompatible({ name: "tiphys-browser", baseURL: config.baseURL, fetch: request }).chatModel(config.model);
}
async function sessionFor(id: string): Promise<Session> {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error("会话名称无效。");
  if (!sessions.has(id)) sessions.set(id, (async () => {
    const saved = await readRecord<{ seq: number; events: Event[]; messages: ModelMessage[]; busy: boolean }>(`session:${id}`);
    const s: Session = { id, seq: saved?.seq ?? 0, events: saved?.events ?? [], messages: saved?.messages ?? [], busy: false, listeners: new Set() };
    if (saved?.busy) await emit(s, { type: "notice", text: "上次页面关闭时的对话已中断；已有图层和记录已保留。" });
    return s;
  })());
  return sessions.get(id)!;
}
async function checkpoint(s: Session) { await writeRecord(`session:${s.id}`, { seq: s.seq, events: s.events, messages: s.messages, busy: s.busy }); }
async function emit(s: Session, event: Event) {
  const e = { ...event, seq: ++s.seq, ts: Date.now() };
  s.events.push(e); for (const listener of s.listeners) listener(e);
  // Persist completed messages and task milestones, avoiding a full history write per token.
  if (event.type !== "text-delta") await checkpoint(s);
}
async function snapshot(s: Session, after: number, reset = after === 0) {
  const layers = await browserLayers();
  return { type: "snapshot", reset, events: s.events.filter(e => e.seq! > after), cursor: s.seq, busy: s.busy,
    workspace: { layers, pendingJobs: [], outputs: [], aoi: s.workspace?.aoi ?? null, aoi_bbox: s.workspace?.aoi_bbox ?? s.workspace?.aoi ?? null,
      selectedLayerId: s.workspace?.selectedLayerId ?? null, selectedLayerName: s.workspace?.selectedLayerName ?? null, selection: s.workspace?.selection ?? null },
    pendingApprovals: [...approvals.keys()].filter(k => k.startsWith(`${s.id}:`)).map(k => k.slice(s.id.length + 1)) };
}
engineEvents.addEventListener("workspace", () => { for (const pending of sessions.values()) void pending.then(async s => { const event = await snapshot(s, s.seq, false); for (const listener of s.listeners) listener(event); }); });
function approval(s: Session, id: string, name: string, input: unknown, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const key = `${s.id}:${id}`;
    const finish = (accepted: boolean) => { approvals.delete(key); signal.removeEventListener("abort", abort); resolve(accepted); };
    const abort = () => { void emit(s, { type: "approval-expired", toolCallId: id }); finish(false); };
    if (signal.aborted) return finish(false);
    approvals.set(key, finish); signal.addEventListener("abort", abort, { once: true });
    void emit(s, { type: "approval-request", toolCallId: id, toolName: name, input });
  });
}
async function callTool(s: Session, name: string, input: Record<string, any>, id: string, signal: AbortSignal) {
  if (name === "remove_layer" || name === "export_features") {
    const accepted = await approval(s, id, name, input, signal); signal.throwIfAborted();
    await emit(s, { type: "approval-result", toolCallId: id, approved: accepted });
    if (!accepted) return { denied: true };
  }
  let result = await runBrowserTool(name, input);
  if (result.job_id && name !== "job_status" && name !== "job_cancel") {
    const jobId = result.job_id;
    const abortJob = () => { void cancelBrowserJob(jobId); };
    signal.addEventListener("abort", abortJob, { once: true });
    let last = "";
    try {
      for (;;) {
        signal.throwIfAborted();
        const job = await readBrowserJob(jobId);
        const marker = `${job.status}:${job.progress}:${job.step ?? ""}:${job.message}`;
        if (marker !== last) { last = marker; await emit(s, { type: "job", toolCallId: id, toolName: name, ...job, jobId }); }
        if (!["queued", "running", "cancelling"].includes(job.status)) {
          if (job.status !== "completed") throw new Error(job.error || job.message);
          result = { ...job.result, job_id: jobId, status: "completed" }; break;
        }
        await new Promise<void>(resolve => { const timer = setTimeout(done, 200); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
      }
    } finally { signal.removeEventListener("abort", abortJob); }
  }
  if (result.view) await emit(s, { type: "view-command", id: `browser:${s.id}:${s.seq + 1}`, command: result.view });
  if (result.renamed && result.layer) await emit(s, { type: "layer-updated", layer: result.layer });
  if (Array.isArray(result.order)) await emit(s, { type: "layers-reordered", ids: result.order });
  if (result.layer) await emit(s, { type: "layer-added", layer: result.layer });
  if (Array.isArray(result.layers)) for (const item of result.layers) if (item?.layer) await emit(s, { type: "layer-added", layer: item.layer });
  if (Array.isArray(result.attachments)) for (const file of result.attachments) await emit(s, { type: "notice", text: `结果文件已生成：${file.name}（${file.bytes} 字节）。`, downloadUrl: file.url, filename: file.name });
  if (result.removed) await emit(s, { type: "layer-removed", layerId: result.removed });
  if (result.download_url) await emit(s, { type: "notice", text: `导出文件已生成：${result.path}。`, downloadUrl: result.download_url, filename: result.path });
  return result;
}
async function runTurn(s: Session, text: string) {
  s.busy = true; s.controller = new AbortController(); const signal = s.controller.signal, turnId = crypto.randomUUID();
  const config = await getConfig();
  await emit(s, { type: "user", text, turnId });
  try {
    const model = modelFor(config);
    const tools: ToolSet = {};
    for (const t of browserCatalog.filter(t => !t.name.startsWith("wasm_"))) {
      tools[t.name] = tool({ description: t.description + "\nExecutes locally in the user's browser. Jobs are awaited by the tool runner; do not busy-poll.", inputSchema: jsonSchema(t.parameters as any),
        execute: async (input: any, options) => callTool(s, t.name, input, options.toolCallId, signal) });
    }
    const searchable = (name: string) => isBrowserSearchable(name) || pluginToolNames.has(name);
    tools.search_browser_tools = tool({ description: "Find additional local GeoLibre WASM, GEE stub and extension tools. Inspect their schemas before running.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }),
      execute: async ({ query }) => searchBrowserTools(await ensureBrowserCatalog(), query, { searchable }) });
    tools.run_browser_tool = tool({ description: "Run an additional browser tool found by search_browser_tools. Arguments must follow that tool's schema. Metric parameters use the source CRS units; reproject when needed. Raster layers are inputs like vector layers; raster results render automatically. GEE tools report connection status honestly.",
      inputSchema: jsonSchema<{ name: string; arguments: Record<string, any> }>({ type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["name", "arguments"], additionalProperties: false }),
      execute: async (input, options) => { if (!searchable(input.name)) throw new Error("仅接受浏览器 WASM、GEE 或扩展工具名称。"); return callTool(s, input.name, input.arguments, options.toolCallId, signal); } });
    tools.read_browser_output = tool({ description: "Read a trimmed tool result or compacted-message archive from this browser session. Use ids from truncated outputs or the compaction handoff.",
      inputSchema: jsonSchema<{ id: string; offset?: number; length?: number }>({ type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 6000 } }, required: ["id"], additionalProperties: false }),
      execute: async ({ id, offset, length }) => readBrowserContextRecord(s.id, id, offset, length) });
    s.messages.push({ role: "user", content: text }); await checkpoint(s);
    const layers = (await browserLayers()).map(({ url: _url, ...layer }) => layer);
    const workspace = s.workspace ?? {};
    const system = systemPrompt(layers, workspace);
    const context = await compactBrowserMessages(s.messages, system, config.contextWindow,
      { layers, pendingJobs: [], outputs: [], aoi: workspace.aoi ?? null, aoi_bbox: workspace.aoi_bbox ?? workspace.aoi ?? null,
        selectedLayerId: workspace.selectedLayerId ?? null, selectedLayerName: workspace.selectedLayerName ?? null, selection: workspace.selection ?? null }, s.id, config.maxToolOutputChars);
    s.messages = context.messages;
    if (context.compacted) await emit(s, { type: "compaction", before: context.before, after: context.after, summary: context.summary });
    else if (context.trimmed) recordLog("context-trim", "旧工具输出已精简", { before: context.before, after: context.after });
    const result = streamText({ model, system,
      messages: s.messages, tools, stopWhen: stepCountIs(8), abortSignal: signal, maxRetries: 0 });
    let buffer = "";
    for await (const event of result.fullStream as AsyncIterable<any>) {
      if (event.type === "text-delta") { buffer += event.text; await emit(s, { type: "text-delta", text: event.text, turnId }); }
      else if (event.type === "tool-call") await emit(s, { type: "tool-call", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, turnId });
      else if (event.type === "tool-result") await emit(s, { type: "tool-result", toolCallId: event.toolCallId, toolName: event.toolName, output: event.output });
      else if (event.type === "tool-error") await emit(s, { type: "tool-error", toolCallId: event.toolCallId, toolName: event.toolName, error: cleanError(event.error, config) });
      else if (event.type === "error") throw event.error;
      else if (event.type === "finish-step" && buffer) { await emit(s, { type: "assistant-text", text: buffer, turnId }); buffer = ""; }
    }
    if (buffer) await emit(s, { type: "assistant-text", text: buffer, turnId });
    s.messages.push(...(await result.response).messages);
    if (await result.finishReason === "tool-calls") await emit(s, { type: "notice", text: "本轮达到工具步骤上限，已有结果已保留；任务可能尚未完成。" });
  } catch (error) { await emit(s, { type: "error", error: signal.aborted ? "已停止当前回复。" : cleanError(error, config) }); }
  finally { s.busy = false; s.controller = undefined; await emit(s, { type: "turn-end", turnId }); }
}
export async function browserAgentRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, "https://browser.invalid"), config = await getConfig();
  const s = await sessionFor(url.searchParams.get("session") || "default");
  const body = init.body ? JSON.parse(typeof init.body === "string" ? init.body : decoder.decode(init.body as ArrayBuffer)) : {};
  if (url.pathname === "/health") return Response.json({ ok: true, service: "tiphys-agent", ...settings(config), runtime: "browser" });
  if (url.pathname === "/settings" && init.method !== "POST") return Response.json(settings(config));
  if (["/settings", "/settings/test"].includes(url.pathname)) {
    const base = new URL(String(body.baseURL).trim());
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.hash || base.search) throw new Error("请填写有效 API 根地址，不要包含登录信息或查询参数。");
    if (typeof body.model !== "string" || !body.model.trim()) throw new Error("请填写模型名称。");
    const contextWindow = Number(body.contextWindow ?? config.contextWindow), maxToolOutputChars = Number(body.maxToolOutputChars ?? config.maxToolOutputChars);
    if (!Number.isInteger(contextWindow) || contextWindow < 8000 || contextWindow > 2000000 || !Number.isInteger(maxToolOutputChars) || maxToolOutputChars < 1000 || maxToolOutputChars > 100000) throw new Error("运行参数超出允许范围。");
    const next: Config = { ...config, baseURL: base.toString().replace(/\/$/, ""), model: body.model.trim(), contextWindow, maxToolOutputChars };
    if (body.apiKey?.trim()) { next.apiKeys = body.apiKey.trim().split(/[\s,]+/); next.keyCount = next.apiKeys.length; next.transport = "direct"; }
    if (url.pathname === "/settings/test") {
      const start = performance.now(); const result = await generateText({ model: modelFor(next), prompt: "只回复：连接成功", maxOutputTokens: 32, maxRetries: 0, abortSignal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      if (!result.text.trim()) throw new Error("模型未返回文本。");
      return Response.json({ ok: true, model: next.model, latencyMs: Math.round(performance.now() - start) });
    }
    for (const pending of sessions.values()) if ((await pending).busy) throw new Error("当前任务正在运行，完成或停止后再保存 API 配置。");
    modelFor(next);
    if (next.transport === "desktop-proxy") {
      const response = await proxyRequest("/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json()).error || "桌面模型配置保存失败。");
    }
    await writeRecord("api-config", next); configPromise = Promise.resolve(next);
    for (const pending of sessions.values()) await emit(await pending, { type: "model-config", provider: settings(next).provider, model: next.model });
    return Response.json(settings(next));
  }
  if (url.pathname === "/events") {
    const initial = await snapshot(s, Number(url.searchParams.get("after") ?? 0));
    let remove: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const send = (e: Event) => { try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { remove(); } };
      send(initial); s.listeners.add(send);
      remove = () => { s.listeners.delete(send); init.signal?.removeEventListener("abort", abort); };
      const abort = () => { remove(); try { controller.close(); } catch { /* Closed. */ } };
      init.signal?.addEventListener("abort", abort, { once: true });
    }, cancel() { remove(); } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.pathname === "/history") return Response.json(await snapshot(s, 0));
  if (url.pathname === "/chat") {
    if (s.busy) throw new Error("Agent 正在处理任务。");
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 64000) throw new Error("请输入有效消息。");
    if (body.workspace && typeof body.workspace === "object") {
      s.workspace = {
        aoi: validAoi(body.workspace.aoi ?? body.workspace.aoi_bbox),
        aoi_bbox: validAoi(body.workspace.aoi_bbox ?? body.workspace.aoi),
        selectedLayerId: typeof body.workspace.selectedLayerId === "string" ? body.workspace.selectedLayerId.slice(0, 160) : null,
        selectedLayerName: typeof body.workspace.selectedLayerName === "string" ? body.workspace.selectedLayerName.slice(0, 240) : null,
        selection: validSelection(body.workspace.selection),
        recovery: normalizeWorkspaceRecovery(body.workspace.recovery),
        agentSession: normalizeAgentSessionStub(body.workspace.agentSession),
      };
    }
    s.busy = true; void runTurn(s, body.text); return Response.json({ ok: true });
  }
  if (url.pathname === "/approve") { if (typeof body.approved !== "boolean") throw new Error("审批参数无效。"); const accept = approvals.get(`${s.id}:${body.toolCallId}`); if (!accept) throw new Error("审批已失效。"); accept(body.approved); return Response.json({ ok: true }); }
  if (url.pathname === "/turn/cancel") { s.controller?.abort(); return Response.json({ ok: true }); }
  if (url.pathname === "/jobs/cancel") return Response.json(await cancelBrowserJob(body.jobId));
  if (url.pathname === "/logs") {
    const entries = [...await browserLogs(), ...s.events.filter(e => !["text-delta", "assistant-text", "user"].includes(e.type)).map(e => ({ id: `agent:${e.seq}`, ts: e.ts, source: "Agent", kind: e.type, level: e.type.includes("error") ? "error" : "info", summary: e.toolName || e.type, detail: e }))].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)).slice(-1000);
    return Response.json({ entries, diagnostics: { runtime: "浏览器 WASM", engine: "geolibre-wasm 1.7.1", provider: settings(config).provider, model: config.model, modelTransport: config.transport, layerCount: (await browserLayers()).length, storage: "此浏览器 IndexedDB", busy: s.busy, pythonRequired: false } });
  }
  recordLog("error", "未知浏览器 Agent 请求", url.pathname, "error");
  throw new Error(`浏览器 Agent 暂不支持接口：${url.pathname}`);
}
