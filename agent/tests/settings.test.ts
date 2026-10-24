import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { BUILTIN_DEFAULT } from "../src/defaults.ts";
import { parseModelIds } from "../src/models.ts";
import { prepareSettings, publicSettings, saveSettings, ensureSettingsBackup } from "../src/settings.ts";

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

test("first launch seeds the user-profile backup from an existing state-dir config", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-backup-state-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-backup-profile-"));
  try {
    fs.writeFileSync(path.join(state, "agent.json"), JSON.stringify({ provider: "openai-compatible", model: "legacy", apiKeys: ["legacy-key"] }));
    ensureSettingsBackup(state, profile);
    const seeded = JSON.parse(fs.readFileSync(path.join(profile, "agent.json"), "utf8"));
    assert.deepEqual(seeded.apiKeys, ["legacy-key"]);
    // An existing backup is never overwritten by the migration.
    fs.writeFileSync(path.join(profile, "agent.json"), JSON.stringify({ model: "newer" }));
    ensureSettingsBackup(state, profile);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "agent.json"), "utf8")).model, "newer");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("saving mirrors the configuration to the user profile and restores it after app data is wiped", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-settings-state-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-settings-profile-"));
  // The suite runner exports TIPHYS_LLM_PROVIDER=mock; the restore path under
  // test must be judged without it.
  const suiteProvider = process.env.TIPHYS_LLM_PROVIDER;
  delete process.env.TIPHYS_LLM_PROVIDER;
  try {
    saveSettings({ ...current, apiKeys: ["mirror-key-one", "mirror-key-two"] }, state, profile);
    const mirror = JSON.parse(fs.readFileSync(path.join(profile, "agent.json"), "utf8"));
    assert.deepEqual(mirror.apiKeys, ["mirror-key-one", "mirror-key-two"]);
    // Simulate an update/reinstall that clears the app-data directory: only the
    // user-profile backup remains, and loadConfig must come back configured.
    fs.rmSync(state, { recursive: true, force: true });
    const restored = loadConfig(state, profile);
    assert.equal(restored.provider, "openai-compatible");
    assert.deepEqual(restored.apiKeys, ["mirror-key-one", "mirror-key-two"]);
    assert.equal(restored.model, "fixture");
  } finally {
    if (suiteProvider !== undefined) process.env.TIPHYS_LLM_PROVIDER = suiteProvider;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("fresh installs use the bundled TierFlow default configuration", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-default-state-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-default-profile-"));
  const previous = { provider: process.env.TIPHYS_LLM_PROVIDER, key: process.env.TIPHYS_LLM_API_KEY, base: process.env.TIPHYS_LLM_BASE_URL,
    model: process.env.TIPHYS_LLM_MODEL, tf: process.env.TIPHYS_TF_KEYS, tfFile: process.env.TIPHYS_TF_KEYS_FILE, builtin: process.env.TIPHYS_BUILTIN_CREDENTIALS };
  delete process.env.TIPHYS_LLM_PROVIDER; delete process.env.TIPHYS_LLM_API_KEY; delete process.env.TIPHYS_LLM_BASE_URL;
  delete process.env.TIPHYS_LLM_MODEL; delete process.env.TIPHYS_TF_KEYS; delete process.env.TIPHYS_TF_KEYS_FILE; delete process.env.TIPHYS_BUILTIN_CREDENTIALS;
  process.env.TIPHYS_TF_KEYS_FILE = path.join(state, "missing-keys.txt");
  try {
    const config = loadConfig(state, profile);
    assert.equal(config.provider, "openai-compatible");
    assert.equal(config.baseURL, BUILTIN_DEFAULT.baseURL);
    assert.equal(config.model, BUILTIN_DEFAULT.model);
    assert.deepEqual(config.apiKeys, [BUILTIN_DEFAULT.apiKey]);
    assert.match(config.keySource, /内置默认/);
    // An environment endpoint without credentials is an explicit user choice and
    // must stay unconfigured rather than borrowing the bundled key.
    process.env.TIPHYS_LLM_BASE_URL = "https://example.test/v1";
    assert.equal(loadConfig(state, profile).provider, "unconfigured");
  } finally {
    const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
    restore("TIPHYS_LLM_PROVIDER", previous.provider); restore("TIPHYS_LLM_API_KEY", previous.key); restore("TIPHYS_LLM_BASE_URL", previous.base);
    restore("TIPHYS_LLM_MODEL", previous.model); restore("TIPHYS_TF_KEYS", previous.tf); restore("TIPHYS_TF_KEYS_FILE", previous.tfFile);
    restore("TIPHYS_BUILTIN_CREDENTIALS", previous.builtin);
    fs.rmSync(state, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("model payload parsing accepts OpenAI, Ollama and plain-list shapes", () => {
  assert.deepEqual(parseModelIds({ object: "list", data: [{ id: "b-model" }, { id: "a-model" }] }), ["a-model", "b-model"]);
  assert.deepEqual(parseModelIds({ models: [{ name: "qwen:7b" }, { name: "qwen:7b" }] }), ["qwen:7b"]);
  assert.deepEqual(parseModelIds(["z", "a", "z"]), ["a", "z"]);
  assert.deepEqual(parseModelIds({ data: { one: {}, two: {} } }), ["one", "two"]);
});

test("production settings: no mock fallback, authenticated save, real protocol test, redaction and restart", { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-settings-http-"));
  const mockApi = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-api-secret");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model" }, { id: "other-model" }] }));
      return;
    }
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
  const env = { ...process.env, TIPHYS_STATE_DIR: dir, TIPHYS_USER_DIR: path.join(dir, "user-profile"), TIPHYS_PROJECT_ROOT: dir, TIPHYS_AGENT_PORT: String(port),
    TIPHYS_LLM_PROVIDER: "", TIPHYS_LLM_API_KEY: "", TIPHYS_LLM_BASE_URL: "", TIPHYS_LLM_MODEL: "", TIPHYS_TF_KEYS: "",
    TIPHYS_TF_KEYS_FILE: path.join(dir, "missing"), TIPHYS_CONTEXT_WINDOW: "", TIPHYS_MAX_TOOL_OUTPUT: "", TIPHYS_SERVICE_TOKEN: "fixture-service-token-long-enough-for-tests",
    TIPHYS_BUILTIN_CREDENTIALS: "off" };
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
    const backup = JSON.parse(fs.readFileSync(path.join(dir, "user-profile", "agent.json"), "utf8"));
    assert.deepEqual(backup.apiKeys, ["fixture-api-secret"], "saved settings must mirror to the user profile");
    assert.equal((await (await fetch(`${url}/health`)).json()).provider, "openai-compatible");
    const catalog = await request("/settings/models", { baseURL: mockUrl });
    assert.equal(catalog.status, 200, await catalog.clone().text());
    assert.deepEqual((await catalog.json()).models, ["fixture-model", "other-model"]);
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
