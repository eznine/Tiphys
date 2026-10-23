import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../src/config.ts";
import { prepareSettings, publicSettings, saveSettings } from "../src/settings.ts";

const current: AgentConfig = { provider: "openai-compatible", model: "fixture", baseURL: "https://example.test/v1", apiKeys: ["fixture-key"], apiKey: "fixture-key",
  keySource: "test", contextWindow: 64000, maxToolOutputChars: 6000, engineUrl: "http://127.0.0.1:8971", port: 8972 };
test("blank settings key retains the pool; settings responses never disclose credentials", () => {
  const next = prepareSettings(current, { baseURL: "https://example.test/v1/", model: "new-model", apiKey: "" });
  assert.deepEqual(next.apiKeys, current.apiKeys); assert.equal(next.baseURL, "https://example.test/v1");
  assert.ok(!JSON.stringify(publicSettings(next)).includes("fixture-key"));
  assert.throws(() => prepareSettings(current, { baseURL: "file:///tmp", model: "x" }));
  assert.throws(() => prepareSettings(current, { baseURL: current.baseURL, model: "x", contextWindow: -1 }));
});
test("API settings save preserves unrelated configuration and the full key pool", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-settings-file-"));
  try {
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ unrelated: "keep", apiKey: "obsolete" }));
    saveSettings({ ...current, apiKeys: ["fixture-one", "fixture-two"] }, dir);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8"));
    assert.equal(saved.unrelated, "keep"); assert.equal(saved.apiKey, undefined);
    assert.deepEqual(saved.apiKeys, ["fixture-one", "fixture-two"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("production settings: no mock fallback, authenticated save, real protocol test, redaction and restart", { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-settings-http-"));
  const mockApi = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-api-secret");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1, model: "fixture-model",
      choices: [{ index: 0, message: { role: "assistant", content: "连接成功" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>(resolve => mockApi.listen(0, "127.0.0.1", resolve));
  const mockUrl = `http://127.0.0.1:${(mockApi.address() as any).port}/v1`;
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as any).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TIPHYS_STATE_DIR: dir, TIPHYS_PROJECT_ROOT: dir, TIPHYS_AGENT_PORT: String(port),
    TIPHYS_LLM_PROVIDER: "", TIPHYS_LLM_API_KEY: "", TIPHYS_LLM_BASE_URL: "", TIPHYS_LLM_MODEL: "", TIPHYS_TF_KEYS: "",
    TIPHYS_TF_KEYS_FILE: path.join(dir, "missing"), TIPHYS_CONTEXT_WINDOW: "", TIPHYS_MAX_TOOL_OUTPUT: "", TIPHYS_SERVICE_TOKEN: "fixture-service-token-long-enough-for-tests" };
  let child: ChildProcess | undefined;
  const launch = () => { child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, windowsHide: true, stdio: "ignore" }); };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    if (process.platform === "win32") await new Promise<void>(resolve => spawn("taskkill", ["/PID", String(child!.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("exit", () => resolve()));
    else child.kill();
    await exited;
  };
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${url}/health`)).ok) return; } catch {}
      if (child?.exitCode !== null) throw new Error("Settings test Agent exited");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Settings test Agent not ready");
  };
  const request = (route: string, body?: unknown) => fetch(`${url}${route}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.TIPHYS_SERVICE_TOKEN}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    launch(); await ready();
    assert.equal((await (await fetch(`${url}/health`)).json()).provider, "unconfigured");
    assert.equal((await fetch(`${url}/settings`)).status, 401);
    const input = { baseURL: mockUrl, model: "fixture-model", apiKey: "fixture-api-secret" };
    const connection = await request("/settings/test", input);
    assert.equal(connection.status, 200, await connection.clone().text());
    assert.equal((await connection.json()).ok, true);
    assert.equal((await (await fetch(`${url}/health`)).json()).provider, "unconfigured", "testing must not save");
    const saved = await request("/settings", input);
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes("fixture-api-secret"));
    assert.equal((await (await fetch(`${url}/health`)).json()).provider, "openai-compatible");
    const proxy = await request("/model/chat/completions", { model: "must-not-override-config", messages: [{ role: "user", content: "test proxy" }] });
    assert.equal(proxy.status, 200);
    assert.equal((await proxy.json()).choices[0].message.content, "连接成功");
    assert.equal((await fetch(`${url}/model/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${url}/model/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${env.TIPHYS_SERVICE_TOKEN}`, Origin: "https://untrusted.example" }, body: "{}" })).status, 403);
    await stop(); launch(); await ready();
    assert.equal((await (await fetch(`${url}/health`)).json()).model, "fixture-model");
    const retained = await request("/settings", { ...input, apiKey: "" });
    assert.equal(retained.status, 200);
    assert.equal((await (await request("/settings")).json()).keyCount, 1);
  } finally { await stop(); await new Promise<void>(resolve => mockApi.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); }
});
