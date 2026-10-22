/**
 * TIPHYS agent sidecar: thin agent loop on Vercel AI SDK (streamText + tools),
 * tools from the Python engine over MCP, SSE events to the UI on 127.0.0.1.
 */
import http from "node:http";
import { streamText, stepCountIs, tool, jsonSchema, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { loadConfig, maskKey } from "./config.js";
import { EngineMcp } from "./mcp.js";
import { createMockModel } from "./mock.js";
import { Session, type AgentEvent } from "./session.js";
import { loadMemory, maybeCompact, spillIfLarge, workspaceSnapshot } from "./context.js";

const cfg = loadConfig();
const engine = new EngineMcp(cfg.engineUrl);
const sessions = new Map<string, Session>();
const clients = new Map<string, Set<http.ServerResponse>>();
const approvals = new Map<string, (ok: boolean) => void>();
const DESTRUCTIVE = new Set(["remove_layer"]);
const watching = new Set<string>();

/** fetch wrapper: rotate to the next key on 401/402/403/429/5xx (tf-chat behaviour). Keys never logged unmasked. */
let keyIdx = 0;
const rotatingFetch: typeof fetch = async (input, init) => {
  let lastRes: Response | undefined;
  for (let tries = 0; tries < cfg.apiKeys.length; tries++) {
    const key = cfg.apiKeys[keyIdx % cfg.apiKeys.length];
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    const res = await fetch(input, { ...init, headers });
    if (![401, 402, 403, 429].includes(res.status) && res.status < 500) return res;
    console.log(`[tiphys-agent] key ${maskKey(key)} -> HTTP ${res.status}; rotating`);
    lastRes = res;
    keyIdx++;
  }
  return lastRes!;
};

const model =
  cfg.provider === "mock"
    ? createMockModel()
    : createOpenAICompatible({ name: "tiphys-llm", baseURL: cfg.baseURL!, fetch: rotatingFetch }).chatModel(cfg.model);

function getSession(id: string) {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = new Session(id)));
  return s;
}

function emit(s: Session, e: AgentEvent) {
  const ev = { ts: Date.now(), ...e };
  if (e.type !== "text-delta") s.append(ev);
  for (const res of clients.get(s.id) ?? []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function layerUrl(l: any) {
  return l?.url?.startsWith("/") ? cfg.engineUrl + l.url : l?.url;
}

async function refreshWorkspace(s: Session) {
  try {
    const r = await engine.call("list_layers", {});
    s.workspace.layers = r.layers ?? [];
  } catch {
    /* engine down: keep last known */
  }
}

/** Watch a job without any fixed timeout; stream progress to UI; add result layer when done. */
async function watchJob(s: Session, jobId: string, toolCallId: string) {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  if (!s.workspace.pendingJobs.includes(jobId)) s.workspace.pendingJobs.push(jobId);
  let last = "";
  for (;;) {
    let st: any;
    try {
      st = await engine.call("job_status", { job_id: jobId });
    } catch (err) {
      emit(s, { type: "job", jobId, toolCallId, status: "unknown", message: String(err) });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const key = `${st.status}:${st.progress}:${st.message}`;
    if (key !== last) {
      emit(s, { type: "job", jobId, toolCallId, status: st.status, progress: st.progress, message: st.message, label: st.label });
      last = key;
    }
    if (!["queued", "running"].includes(st.status)) {
      s.workspace.pendingJobs = s.workspace.pendingJobs.filter((j) => j !== jobId);
      if (st.status === "completed" && st.result?.layer) {
        const layer = st.result.layer;
        s.workspace.outputs.push(layer.path);
        await refreshWorkspace(s);
        emit(s, { type: "layer-added", layer: { ...layer, url: layerUrl(layer) }, fromJob: jobId });
        emit(s, { type: "notice", text: `任务 ${jobId} 完成：生成图层「${layer.name}」（${layer.feature_count} 个要素）。` });
      }
      s.checkpoint();
      watching.delete(jobId);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function requestApproval(s: Session, toolCallId: string, toolName: string, input: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    approvals.set(toolCallId, resolve);
    emit(s, { type: "approval-request", toolCallId, toolName, input });
  });
}

function buildTools(s: Session): ToolSet {
  const tools: ToolSet = {};
  for (const t of engine.tools) {
    tools[t.name] = tool({
      description: t.description ?? t.name,
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (input: any, { toolCallId, abortSignal }) => {
        if (DESTRUCTIVE.has(t.name) || input?.overwrite === true) {
          const ok = await requestApproval(s, toolCallId, t.name, input);
          emit(s, { type: "approval-result", toolCallId, approved: ok });
          if (!ok) return { denied: true, reason: "user rejected destructive action" };
        }
        const out = await engine.call(t.name, input ?? {}, abortSignal);
        if (out?.layer && t.name === "add_data") emit(s, { type: "layer-added", layer: { ...out.layer, url: layerUrl(out.layer) } });
        if (t.name === "remove_layer" && out?.removed) emit(s, { type: "layer-removed", layerId: out.removed });
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
    "Reply in the user's language. Never invent layer ids; use the workspace snapshot.",
    loadMemory(),
    `## GIS workspace snapshot (refreshed each turn)\n${workspaceSnapshot(s.workspace)}`,
  ].join("\n\n");
}

async function runTurn(s: Session, text: string) {
  s.busy = true;
  const turnId = `turn_${Date.now()}`;
  emit(s, { type: "user", text, turnId });
  try {
    await engine.ensure();
    await refreshWorkspace(s);
    s.messages.push({ role: "user", content: text });
    const system = systemPrompt(s);
    const c = maybeCompact(s.messages, system, cfg.contextWindow, s.workspace);
    if (c.compacted) {
      s.messages = c.messages;
      emit(s, { type: "compaction", before: c.before, after: c.after, summary: c.summary });
    }
    const result = streamText({ model, system, messages: s.messages, tools: buildTools(s), stopWhen: stepCountIs(8) });
    let buf = "";
    for await (const p of result.fullStream as AsyncIterable<any>) {
      if (p.type === "text-delta") {
        buf += p.text;
        emit(s, { type: "text-delta", text: p.text, turnId });
      } else if (p.type === "tool-call") emit(s, { type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.input, turnId });
      else if (p.type === "tool-result") emit(s, { type: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, output: p.output });
      else if (p.type === "tool-error") emit(s, { type: "tool-error", toolCallId: p.toolCallId, toolName: p.toolName, error: String(p.error) });
      else if (p.type === "finish-step" && buf) {
        emit(s, { type: "assistant-text", text: buf, turnId });
        buf = "";
      } else if (p.type === "error") emit(s, { type: "error", error: String(p.error) });
    }
    if (buf) emit(s, { type: "assistant-text", text: buf, turnId });
    s.messages.push(...(await result.response).messages);
  } catch (err) {
    emit(s, { type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    s.busy = false;
    s.checkpoint();
    emit(s, { type: "turn-end", turnId });
  }
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        res(JSON.parse(d || "{}"));
      } catch {
        res({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url ?? "/", "http://x");
  const json = (o: unknown, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  const sid = url.searchParams.get("session") || "default";
  try {
    if (url.pathname === "/health")
      return json({ ok: true, provider: cfg.provider, model: cfg.model, baseURL: cfg.baseURL ? new URL(cfg.baseURL).host : null, keys: cfg.keySource, engine: cfg.engineUrl });
    if (url.pathname === "/tools") {
      await engine.ensure();
      return json({ tools: engine.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": ok\n\n");
      const set = clients.get(sid) ?? new Set();
      clients.set(sid, set);
      set.add(res);
      const ka = setInterval(() => res.write(": ka\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ka);
        set.delete(res);
      });
      return;
    }
    if (url.pathname === "/history") {
      const s = getSession(sid);
      return json({ events: s.events(), workspace: s.workspace });
    }
    if (url.pathname === "/chat" && req.method === "POST") {
      const { text } = await body(req);
      const s = getSession(sid);
      if (s.busy) return json({ ok: false, error: "busy" }, 409);
      void runTurn(s, String(text ?? ""));
      return json({ ok: true });
    }
    if (url.pathname === "/approve" && req.method === "POST") {
      const { toolCallId, approved } = await body(req);
      const r = approvals.get(toolCallId);
      if (!r) return json({ ok: false }, 404);
      approvals.delete(toolCallId);
      r(Boolean(approved));
      return json({ ok: true });
    }
    if (url.pathname === "/jobs/cancel" && req.method === "POST") {
      const { jobId } = await body(req);
      return json(await engine.call("job_cancel", { job_id: jobId }));
    }
    json({ error: "not found" }, 404);
  } catch (err) {
    json({ error: String(err) }, 500);
  }
});

server.listen(cfg.port, "127.0.0.1", async () => {
  console.log(`[tiphys-agent] http://127.0.0.1:${cfg.port} provider=${cfg.provider} model=${cfg.model} keys=${cfg.keySource}`);
  try {
    await engine.connect();
    console.log(`[tiphys-agent] MCP tools: ${engine.tools.map((t) => t.name).join(", ")}`);
  } catch (err) {
    console.log(`[tiphys-agent] engine MCP not reachable yet (${String(err)}); will retry per turn`);
  }
});
