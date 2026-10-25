/**
 * TIPHYS agent sidecar: thin agent loop on Vercel AI SDK (streamText + tools),
 * tools from the Python engine over MCP, SSE events to the UI on 127.0.0.1.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { streamText, generateText, stepCountIs, tool, jsonSchema, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { loadConfig, TIPHYS_DIR, USER_DIR, type AgentConfig } from "./config.js";
import { providerFetch } from "./provider-fetch.js";
import { once } from "node:events";
import { eventLogEntries, redact } from "./diagnostics.js";
import { normalizeBaseURL, prepareSettings, publicSettings, saveSettings, ensureSettingsBackup } from "./settings.js";
import { listModels } from "./models.js";
import { EngineMcp } from "./mcp.js";
import { createMockModel } from "./mock.js";
import { Session, type AgentEvent } from "./session.js";
import { COMPACT_PROMPT, estimateTokens, loadMemory, maybeCompact, readToolOutput, spillIfLarge, workspaceSnapshot } from "./context.js";
import { allowedOrigins, authorized, serviceToken } from "./security.js";
import { budgetVerdict, contextBudget, makeOperationSpec, taskBudget, type BudgetVerdict } from "../../shared/contracts/index.ts";
import { runWasmTool, searchWasmTools } from "./wasm.js";
import { resolveWasmInputs } from "./wasm-inputs.js";

let cfg = loadConfig();
ensureSettingsBackup();
const engine = new EngineMcp(cfg.engineUrl);
const sessions = new Map<string, Session>();
const clients = new Map<string, Set<http.ServerResponse>>();
const approvals = new Map<string, { session: string; resolve: (ok: boolean) => void }>();
const DESTRUCTIVE = new Set(["remove_layer"]);
const watching = new Set<string>();

/** fetch wrapper: rotate to the next key on 401/402/403/429/5xx (tf-chat behaviour). Keys never logged unmasked. */
function configuredModel(config: AgentConfig) {
  if (config.provider === "mock") return createMockModel();
  if (config.provider === "unconfigured") return null;
  return createOpenAICompatible({ name: "tiphys-llm", baseURL: config.baseURL!, fetch: providerFetch(config) }).chatModel(config.model);
}
let model = configuredModel(cfg);

function getSession(id: string) {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = new Session(id)));
  return s;
}

function emit(s: Session, e: AgentEvent) {
  const ev = s.append(e);
  for (const res of clients.get(s.id) ?? []) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function layerUrl(l: any) {
  return l?.url?.startsWith("/") ? cfg.engineUrl + l.url : l?.url;
}

async function refreshWorkspace(s: Session) {
  try {
    const r = await engine.call("list_layers", {});
    s.workspace.layers = (r.layers ?? []).map((l: any) => ({ ...l, url: layerUrl(l) }));
  } catch {
    /* engine down: keep last known */
  }
}

/** Watch a job without any fixed timeout; stream progress to UI; add result layer when done. */
async function watchJob(s: Session, jobId: string, toolCallId: string) {
  const watchKey = `${s.id}:${jobId}`;
  if (watching.has(watchKey)) return;
  watching.add(watchKey);
  if (!s.workspace.pendingJobs.includes(jobId)) s.workspace.pendingJobs.push(jobId);
  s.checkpoint();
  let last = "";
  let failures = 0;
  for (;;) {
    let st: any;
    try {
      st = await engine.call("job_status", { job_id: jobId });
      failures = 0;
    } catch (err) {
      const missing = /unknown job/i.test(String(err));
      if (missing) {
        emit(s, { type: "job", jobId, status: "interrupted", message: "引擎中已无此任务，请检查现有结果后再决定是否重试。" });
        s.workspace.pendingJobs = s.workspace.pendingJobs.filter(j => j !== jobId);
        s.checkpoint();
        watching.delete(watchKey);
        return;
      }
      if (++failures === 1) emit(s, { type: "job", jobId, toolCallId, status: "unreachable", message: String(err) });
      if (failures >= 5) { watching.delete(watchKey); return; }
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** failures, 10000)));
      continue;
    }
    const key = `${st.status}:${st.progress}:${st.message}`;
    if (key !== last) {
      emit(s, { type: "job", jobId, toolCallId, status: st.status, progress: st.progress, message: st.message, label: st.label });
      last = key;
    }
    if (!["queued", "running", "cancelling"].includes(st.status)) {
      s.workspace.pendingJobs = s.workspace.pendingJobs.filter((j) => j !== jobId);
      if (st.status === "completed" && st.result?.layer) {
        const layer = st.result.layer;
        s.workspace.outputs.push(layer.path);
        await refreshWorkspace(s);
        emit(s, { type: "layer-added", layer: { ...layer, url: layerUrl(layer) }, fromJob: jobId });
        emit(s, { type: "notice", text: `任务 ${jobId} 完成：生成图层「${layer.name}」（${layer.feature_count} 个要素）。` });
      }
      s.checkpoint();
      watching.delete(watchKey);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function requestApproval(s: Session, toolCallId: string, toolName: string, input: unknown, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const key = `${s.id}:${toolCallId}`;
    const onAbort = () => { approvals.delete(key); emit(s, { type: "approval-expired", toolCallId }); resolve(false); };
    if (signal?.aborted) { resolve(false); return; }
    approvals.set(key, { session: s.id, resolve: ok => { signal?.removeEventListener("abort", onAbort); resolve(ok); } });
    signal?.addEventListener("abort", onAbort, { once: true });
    emit(s, { type: "approval-request", toolCallId, toolName, input });
  });
}

function buildTools(s: Session): ToolSet {
  const tools: ToolSet = {};
  tools.read_tool_output = tool({
    description: "Read a page of an oversized tool output or archived context by spill_id. No arbitrary file paths.",
    inputSchema: jsonSchema<{ spill_id: string; offset?: number; length?: number }>({ type: "object", properties: {
      spill_id: { type: "string", pattern: "^[a-f0-9]{32}$" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 6000 },
    }, required: ["spill_id"], additionalProperties: false }),
    execute: async input => readToolOutput(input.spill_id, input.offset, input.length),
  });
  tools.wasm_search = tool({
    description: "Search the real 958-tool geolibre/Whitebox WASM catalog. Returns compact parameter cards with exact input wire names, kinds, required flags, enums/defaults and outputs. Use this before wasm_run when the tool id or parameter names are uncertain; stop searching once a matching card appears.",
    inputSchema: jsonSchema<{ query: string; input_kind?: string; output_kind?: string; limit?: number }>({
      type: "object",
      properties: {
        query: { type: "string", description: "User wording, tool id, or a wire name such as d8_pntr, slope, 坡度, 栅格转面." },
        input_kind: { type: "string", enum: ["raster", "vector", "table", "file"], description: "Optional input-kind filter." },
        output_kind: { type: "string", enum: ["raster", "vector", "table", "file", "json", "text"], description: "Optional output-kind filter." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Defaults to 8." },
      },
      required: ["query"], additionalProperties: false,
    }),
    execute: async (input: { query: string; input_kind?: string; output_kind?: string; limit?: number }) => {
      try {
        return searchWasmTools(input.query, { inputKind: input.input_kind, outputKind: input.output_kind, limit: input.limit });
      } catch (err) {
        return { ok: false, error_class: "INPUT_ERROR", message: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  tools.wasm_run = tool({
    description: "Run one geolibre/Whitebox WASM catalog tool (same catalog as the ribbon). "
      + "Call wasm_search first when the id or parameter names are uncertain. Bind each manifest input by its exact wire name in `inputs` (for example slope: {input}; basins: {d8_pntr}; zonal_statistics: {input, features}). "
      + "Each input value may be a workspace layer id/name or an absolute analysis file path. "
      + "Vector outputs return geojson_path ready for add_data; raster TIFF outputs can also be passed to add_data. Never claim a layer is on the map until add_data succeeds.",
    inputSchema: jsonSchema<{ tool: string; input_path?: string; inputs?: Record<string, string>; params?: Record<string, unknown>; timeout_seconds?: number }>({
      type: "object",
      properties: {
        tool: { type: "string", description: "Exact geolibre tool id from wasm_search, e.g. slope, basins, zonal_statistics." },
        inputs: { type: "object", additionalProperties: { type: "string" }, description: "Manifest input wire name → workspace layer id/name or absolute file path." },
        input_path: { type: "string", description: "Compatibility shortcut only for tools with exactly one input." },
        params: { type: "object", description: "Scalar/enum parameters by exact manifest name. Do not put file inputs here." },
        timeout_seconds: { type: "integer", minimum: 5, maximum: 900, description: "Optional run limit. Defaults to 900 seconds; cancellation is reported separately from timeout." },
      },
      required: ["tool"],
      additionalProperties: false,
    }),
    execute: async (input: { tool: string; input_path?: string; inputs?: Record<string, string>; params?: Record<string, unknown>; timeout_seconds?: number }, { abortSignal }) => {
      try {
        if (input.input_path && input.inputs && Object.keys(input.inputs).length) {
          return { ok: false, error_class: "INPUT_ERROR", message: "input_path 与 inputs 不能同时使用；多输入工具请只使用 inputs。" };
        }
        const { paths, bindings } = await resolveWasmInputs(input.inputs, layer => engine.call("inspect_layers", { layer }));
        const result = await runWasmTool({ tool: input.tool, inputPath: input.input_path, inputs: paths, params: input.params,
          timeoutMs: input.timeout_seconds === undefined ? undefined : input.timeout_seconds * 1000, signal: abortSignal });
        return { ...result, input_bindings: bindings };
      } catch (err) {
        return { ok: false, error_class: "INPUT_ERROR", message: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  for (const t of engine.tools) {
    tools[t.name] = tool({
      description: t.description ?? t.name,
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (input: any, { toolCallId, abortSignal }) => {
        // Shared operation contract: same unit/CRS rules as the browser engine.
        // Reject before touching the engine, and treat a redundant reprojection
        // as an explicit no-op instead of a second dataset.
        let payload: any = input ?? {};
        if (t.name === "buffer") {
          const spec = makeOperationSpec("gis.buffer", String(payload.layer ?? ""), {
            distance: payload.distance, units: payload.units ?? "meters",
            ...(typeof payload.dissolve === "boolean" ? { dissolve: payload.dissolve } : {}),
          });
          if (!spec.ok) return { ok: false, error_class: "INPUT_ERROR", message: spec.errors.join(" ") };
          payload = { ...payload, units: (spec.spec.params as { units?: string }).units ?? "meters" };
        } else if (t.name === "reproject") {
          const spec = makeOperationSpec("gis.reproject", String(payload.layer ?? ""), { targetCrs: payload.target_crs });
          if (!spec.ok) return { ok: false, error_class: "INPUT_ERROR", message: spec.errors.join(" ") };
          const target = (spec.spec.params as { targetCrs: string }).targetCrs;
          const known = s.workspace.layers.find((l: any) => l.id === payload.layer || l.name === payload.layer);
          if (known && String(known.crs ?? "").toUpperCase() === target) {
            return { ok: true, noop: true, message: `图层已经是 ${target}，未创建新数据集。`, layer: known };
          }
          payload = { ...payload, target_crs: target };
        }
        if (t.annotations?.destructiveHint === true || DESTRUCTIVE.has(t.name) || payload?.overwrite === true) {
          const ok = await requestApproval(s, toolCallId, t.name, payload, abortSignal);
          abortSignal?.throwIfAborted();
          emit(s, { type: "approval-result", toolCallId, approved: ok });
          if (!ok) return { denied: true, reason: "user rejected destructive action" };
        }
        const out = await engine.call(t.name, payload, abortSignal);
        if (out?.view) emit(s, { type: "view-command", command: out.view });
        if (out?.layer && t.name === "add_data") {
          const layer = { ...out.layer, url: layerUrl(out.layer) };
          s.workspace.layers = [...s.workspace.layers.filter(l => l.id !== layer.id), layer];
          emit(s, { type: "layer-added", layer });
        }
        if (t.name === "remove_layer" && out?.removed) {
          s.workspace.layers = s.workspace.layers.filter(l => l.id !== out.removed);
          emit(s, { type: "layer-removed", layerId: out.removed });
        }
        if (out?.job_id && ["queued", "running"].includes(out.status)) void watchJob(s, out.job_id, toolCallId);
        return spillIfLarge(toolCallId, out, cfg.maxToolOutputChars);
      },
    });
  }
  return tools;
}

function systemPrompt(s: Session) {
  return [
    "You are TIPHYS, a GIS agent. Use the engine tools for spatial work; long jobs return job_id (progress is shown to the user; do not busy-poll).",
    "When no Python tool covers a raster/hydrology/terrain operation, call wasm_search to find the exact geolibre tool and its parameter card, then wasm_run with the exact input wire names in `inputs`. Input values may be workspace layer ids/names (resolved through inspect_layers) or absolute files. Add vector geojson_path or raster TIFF outputs through add_data before claiming they are on the map.",
    "Reply in the user's language. Never invent layer ids; use the workspace snapshot.",
    loadMemory(),
    `## GIS workspace snapshot (refreshed each turn)\n${workspaceSnapshot(s.workspace)}`,
  ].join("\n\n");
}

async function runTurn(s: Session, text: string) {
  s.busy = true;
  s.controller = new AbortController();
  const turnId = `turn_${Date.now()}`;
  let budgetStop: BudgetVerdict | undefined;
  emit(s, { type: "user", text, turnId });
  try {
    const turnModel = model;
    if (!turnModel) throw new Error(cfg.configIssue || "API 尚未配置，请打开设置。");
    await engine.ensure();
    await refreshWorkspace(s);
    for (const jobId of s.workspace.pendingJobs) void watchJob(s, jobId, "recovered");
    s.messages.push({ role: "user", content: text });
    s.checkpoint();
    const system = systemPrompt(s);
    const tools = buildTools(s);
    const c = await maybeCompact(s.messages, system + JSON.stringify(engine.tools), cfg.contextWindow, s.workspace,
      cfg.provider === "mock" ? undefined : async messages => (await generateText({ model: turnModel, system: COMPACT_PROMPT, messages,
        maxOutputTokens: Math.min(4000, Math.floor(cfg.contextWindow * 0.15)), abortSignal: s.controller!.signal })).text);
    if (c.compacted) {
      s.messages = c.messages;
      emit(s, { type: "compaction", before: c.before, after: c.after, summary: c.summary });
    }
    // Task-class budgets replace the old fixed 8-step cap. Search and execution
    // both count; the SDK ceiling leaves room for the final text step.
    const budget = { ...taskBudget(text), maxContextTokens: contextBudget(cfg.contextWindow) };
    const turnStarted = Date.now();
    let toolSteps = 0;
    const result = streamText({ model: turnModel, system, messages: s.messages, tools, abortSignal: s.controller.signal,
      stopWhen: stepCountIs(budget.maxToolSteps + 4), maxRetries: 0 });
    let buf = "";
    for await (const p of result.fullStream as AsyncIterable<any>) {
      if (p.type === "text-delta") {
        buf += p.text;
        emit(s, { type: "text-delta", text: p.text, turnId });
      } else if (p.type === "tool-call") emit(s, { type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.input, turnId });
      else if (p.type === "tool-result") {
        toolSteps++;
        emit(s, { type: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, output: p.output });
        let verdict = budgetVerdict({ toolSteps, elapsedMs: Date.now() - turnStarted, estimatedTokens: 0 }, budget);
        if (!verdict.stop && toolSteps % 3 === 0) {
          verdict = budgetVerdict({ toolSteps, elapsedMs: Date.now() - turnStarted,
            estimatedTokens: estimateTokens(s.messages, system) }, budget);
        }
        if (verdict.stop) {
          budgetStop = verdict;
          emit(s, { type: "notice", text: `预算停止：${verdict.reason}${verdict.advice}` });
          s.controller.abort();
        }
      }
      else if (p.type === "tool-error") emit(s, { type: "tool-error", toolCallId: p.toolCallId, toolName: p.toolName, error: String(p.error) });
      else if (p.type === "finish-step" && buf) {
        emit(s, { type: "assistant-text", text: buf, turnId });
        buf = "";
      } else if (p.type === "error") emit(s, { type: "error", error: String(p.error) });
    }
    if (buf) emit(s, { type: "assistant-text", text: buf, turnId });
    try {
      s.messages.push(...(await result.response).messages);
    } catch (err) {
      if (!budgetStop?.stop) throw err;
    }
    if (!budgetStop?.stop && (await result.finishReason) === "tool-calls")
      emit(s, { type: "notice", text: "本轮已达到工具步骤上限，已有结果已保留；任务可能尚未完成，请检查工作区后再继续。" });
  } catch (err) {
    if (!budgetStop?.stop) emit(s, { type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    s.busy = false;
    s.controller = null;
    s.checkpoint();
    emit(s, { type: "turn-end", turnId });
  }
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((res, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 256000) { reject(new Error("Request too large")); req.destroy(); } });
    req.on("error", reject);
    req.on("end", () => {
      try {
        res(JSON.parse(d || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) { res.writeHead(403); res.end(); return; }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Tiphys-Client");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url ?? "/", "http://x");
  const json = (o: unknown, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  const sid = url.searchParams.get("session") || "default";
  try {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sid)) return json({ error: "Invalid session id" }, 400);
    if (url.pathname === "/health")
      return json({ ok: true, service: "tiphys-agent", provider: cfg.provider, model: cfg.model, baseURL: cfg.baseURL ? new URL(cfg.baseURL).host : null, keys: cfg.keySource, engine: cfg.engineUrl });
    if (url.pathname === "/bootstrap" && req.method === "GET") {
      if (!origin || req.headers["x-tiphys-client"] !== "1") return json({ error: "Trusted UI required" }, 403);
      res.setHeader("Cache-Control", "no-store");
      return json({ token: serviceToken, engineUrl: cfg.engineUrl });
    }
    const credential = req.headers.authorization?.replace(/^Bearer /, "");
    if (!authorized(credential)) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/model/chat/completions" && req.method === "POST") {
      if (cfg.provider !== "openai-compatible") return json({ error: "请先配置真实 API。" }, 409);
      const payload = await body(req);
      if (!Array.isArray(payload.messages) || typeof payload !== "object") return json({ error: "Invalid model request" }, 400);
      const current = cfg;
      const abort = new AbortController();
      res.once("close", () => { if (!res.writableEnded) abort.abort(); });
      const upstream = await providerFetch(current)(`${current.baseURL!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, model: current.model }), signal: abort.signal,
      });
      if (!upstream.ok) return json({ error: redact((await upstream.text()).slice(0, 2500), current.apiKeys) }, upstream.status);
      res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      if (upstream.body) for await (const chunk of upstream.body as any) if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
      res.end(); return;
    }
    if (url.pathname === "/settings" && req.method === "GET") return json(publicSettings(cfg));
    if (url.pathname === "/settings" && req.method === "POST") {
      if ([...sessions.values()].some(session => session.busy)) return json({ error: "当前任务正在运行，完成或停止后再保存 API 配置。" }, 409);
      const overrides = publicSettings(cfg).environmentOverrides;
      if (overrides.length) return json({ error: `启动环境覆盖了这些设置：${overrides.join("、")}。请先调整启动配置。` }, 409);
      try {
        const next = prepareSettings(cfg, await body(req));
        const nextModel = configuredModel(next);
        saveSettings(next, undefined, USER_DIR);
        cfg = next; model = nextModel;
        for (const session of sessions.values()) emit(session, { type: "model-config", provider: cfg.provider, model: cfg.model });
        return json(publicSettings(cfg));
      } catch (err) { return json({ error: String(err instanceof Error ? err.message : err) }, 400); }
    }
    if (url.pathname === "/settings/test" && req.method === "POST") {
      let candidate: AgentConfig | undefined;
      try {
        candidate = prepareSettings(cfg, await body(req));
        const testModel = configuredModel(candidate)!;
        const started = Date.now();
        const result = await generateText({ model: testModel, prompt: "只回复：连接成功", maxOutputTokens: 32, maxRetries: 0,
          abortSignal: AbortSignal.timeout(60000) });
        if (!result.text.trim()) throw new Error("API 未返回文本，请核对模型名称。");
        return json({ ok: true, model: candidate.model, latencyMs: Date.now() - started, message: "真实 API 调用成功" });
      } catch (err) { return json({ error: redact(err instanceof Error ? err.message : String(err), candidate?.apiKeys ?? cfg.apiKeys) }, 400); }
    }
    if (url.pathname === "/settings/models" && req.method === "POST") {
      const input = await body(req);
      try {
        const baseURL = normalizeBaseURL(input.baseURL ?? cfg.baseURL);
        const supplied = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
        const keys = supplied ? supplied.split(/[\s,]+/).filter(Boolean) : cfg.apiKeys;
        const models = await listModels(baseURL, keys);
        return json({ models });
      } catch (err) { return json({ error: redact(err instanceof Error ? err.message : String(err), cfg.apiKeys) }, 400); }
    }
    if (url.pathname === "/logs" && req.method === "GET") {
      const s = getSession(sid);
      let engineDiagnostics: any = {};
      try {
        const response = await fetch(`${cfg.engineUrl}/diagnostics`, { headers: { Authorization: `Bearer ${serviceToken}` }, signal: AbortSignal.timeout(3000) });
        if (response.ok) engineDiagnostics = await response.json();
      } catch { /* Local Agent records remain available if the engine is offline. */ }
      const serviceLogs: Record<string, string> = {};
      for (const name of ["agent.log", "engine.log", "startup-error.log"]) {
        const file = path.join(TIPHYS_DIR, name);
        if (!fs.existsSync(file)) continue;
        const fd = fs.openSync(file, "r");
        try {
          const size = fs.fstatSync(fd).size;
          const buffer = Buffer.alloc(Math.min(size, 64000));
          const count = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
          serviceLogs[name] = buffer.subarray(0, count).toString("utf8");
        } finally { fs.closeSync(fd); }
      }
      return json(redact({ entries: [...eventLogEntries(s.events()), ...(engineDiagnostics.entries ?? [])].sort((a, b) => a.ts - b.ts).slice(-1000),
        diagnostics: { provider: cfg.provider, model: cfg.model, engineUrl: cfg.engineUrl, stateDir: TIPHYS_DIR,
          engineReachable: !!engineDiagnostics.entries, layerCount: engineDiagnostics.layer_count, pendingJobs: engineDiagnostics.pending_jobs ?? [], busy: s.busy, serviceLogs } }, cfg.apiKeys));
    }
    if (url.pathname === "/tools") {
      await engine.ensure();
      return json({ tools: engine.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (url.pathname === "/events") {
      const s = getSession(sid);
      await refreshWorkspace(s);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const after = Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0);
      if (!Number.isSafeInteger(after) || after < 0) { res.end(); return; }
      const pendingApprovals = [...approvals].filter(([, a]) => a.session === sid).map(([key]) => key.slice(sid.length + 1));
      res.write(`id: ${s.lastSeq}\ndata: ${JSON.stringify({ type: "snapshot", events: s.events(after), reset: after === 0, cursor: s.lastSeq, workspace: s.workspace, busy: s.busy, pendingApprovals })}\n\n`);
      const set = clients.get(sid) ?? new Set();
      clients.set(sid, set);
      set.add(res);
      for (const jobId of s.workspace.pendingJobs) void watchJob(s, jobId, "recovered");
      const ka = setInterval(() => res.write(": ka\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ka);
        set.delete(res);
      });
      return;
    }
    if (url.pathname === "/history") {
      const s = getSession(sid);
      await refreshWorkspace(s);
      const after = Number(url.searchParams.get("after") || 0);
      const events = s.events(after).slice(0, 500);
      return json({ events, cursor: events.at(-1)?.seq ?? after, hasMore: events.length === 500, workspace: s.workspace, busy: s.busy });
    }
    if (url.pathname === "/chat" && req.method === "POST") {
      const { text } = await body(req);
      if (typeof text !== "string" || !text.trim() || text.length > 64000) return json({ error: "Invalid message" }, 400);
      const s = getSession(sid);
      if (s.busy) return json({ ok: false, error: "busy" }, 409);
      void runTurn(s, String(text ?? ""));
      return json({ ok: true });
    }
    if (url.pathname === "/approve" && req.method === "POST") {
      const { toolCallId, approved } = await body(req);
      if (typeof approved !== "boolean") return json({ error: "approved must be boolean" }, 400);
      const key = `${sid}:${toolCallId}`;
      const r = approvals.get(key);
      if (!r) return json({ ok: false }, 404);
      approvals.delete(key);
      r.resolve(approved);
      return json({ ok: true });
    }
    if (url.pathname === "/jobs/cancel" && req.method === "POST") {
      const { jobId } = await body(req);
      if (!getSession(sid).workspace.pendingJobs.includes(jobId)) return json({ error: "Job not owned by this session" }, 404);
      return json(await engine.call("job_cancel", { job_id: jobId }));
    }
    if (url.pathname === "/turn/cancel" && req.method === "POST") {
      getSession(sid).controller?.abort();
      return json({ ok: true });
    }
    json({ error: "not found" }, 404);
  } catch (err) {
    json({ error: String(err) }, 500);
  }
});

server.listen(cfg.port, "127.0.0.1", async () => {
  console.log(`[tiphys-agent] http://127.0.0.1:${cfg.port} provider=${cfg.provider} model=${cfg.model} keys=${cfg.keySource}`);
  try {
    await engine.ensure();
    console.log(`[tiphys-agent] MCP tools: ${engine.tools.map((t) => t.name).join(", ")}`);
  } catch (err) {
    console.log(`[tiphys-agent] engine MCP not reachable yet (${String(err)}); will retry per turn`);
  }
});
