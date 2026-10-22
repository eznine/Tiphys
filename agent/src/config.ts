/** Provider config: env vars override ~/.tiphys/agent.json and <project>/.tiphys/agent.json. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TF_KEYS_SCRIPT = path.join(os.homedir(), ".local/bin/tf-keys.sh");

/** Parse a keys file: one key per line, or space/comma separated, or KEY=value lines (TF_BASE=... sets base). '#' comments ignored. */
function parseKeysFile(p: string): { keys: string[]; base?: string } {
  const keys: string[] = [];
  let base: string | undefined;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").replace(/^\s*export\s+/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      const v = m[2].replace(/^["']|["']$/g, "").trim();
      if (/BASE|URL/i.test(m[1])) base = v;
      else if (/MODEL/i.test(m[1])) continue;
      else keys.push(...v.split(/[\s,]+/).filter(Boolean));
    } else keys.push(...line.split(/[\s,]+/).filter(Boolean));
  }
  return { keys, base };
}

/**
 * Load tierflow keys at runtime, first hit wins:
 * 1. TIPHYS_TF_KEYS (space/comma separated)
 * 2. TIPHYS_TF_KEYS_FILE, else <project>/.tiphys/tierflow_keys.txt (gitignored), else ~/.tierflow (Windows: C:\\Users\\<you>\\.tierflow) if it is a file
 * 3. `tf_keys` from ~/.local/bin/tf-keys.sh (non-Windows only, if present)
 * Never throws; missing sources -> no keys (mock fallback).
 */
function loadTierflowKeys(): { keys: string[]; base?: string; source: string } {
  const env = process.env.TIPHYS_TF_KEYS;
  if (env) return { keys: env.split(/[\s,]+/).filter(Boolean), source: "env TIPHYS_TF_KEYS" };
  const candidates = process.env.TIPHYS_TF_KEYS_FILE
    ? [process.env.TIPHYS_TF_KEYS_FILE]
    : [path.join(PROJECT_ROOT, ".tiphys", "tierflow_keys.txt"), path.join(os.homedir(), ".tierflow")];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        const r = parseKeysFile(file);
        if (r.keys.length) return { ...r, source: `keys file ${file}` };
      }
    } catch {
      /* missing file is fine */
    }
  }
  if (process.platform === "win32" || !fs.existsSync(TF_KEYS_SCRIPT)) return { keys: [], source: "none" };
  try {
    const out = execFileSync("bash", ["-c", `source "${TF_KEYS_SCRIPT}" >/dev/null 2>&1; echo "$TF_BASE"; tf_keys`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const [base, ...rest] = out.split("\n");
    return { keys: rest.join(" ").split(/\s+/).filter(Boolean), base: base.trim() || undefined, source: "~/.local/bin/tf-keys.sh" };
  } catch {
    return { keys: [], source: "tf-keys.sh failed" };
  }
}

export function maskKey(k: string): string {
  return k.length > 8 ? `${k.slice(0, 3)}…${k.slice(-2)}` : "***";
}

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TIPHYS_DIR = path.join(PROJECT_ROOT, ".tiphys");
export const USER_DIR = path.join(os.homedir(), ".tiphys");

export type AgentConfig = {
  provider: "mock" | "openai-compatible";
  /** Key pool for rotation (tierflow). Never logged. */
  apiKeys: string[];
  keySource: string;
  baseURL?: string;
  apiKey?: string;
  model: string;
  contextWindow: number;
  maxToolOutputChars: number;
  engineUrl: string;
  port: number;
};

function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function loadConfig(): AgentConfig {
  const file = { ...readJson(path.join(USER_DIR, "agent.json")), ...readJson(path.join(TIPHYS_DIR, "agent.json")) } as Record<string, any>;
  const e = process.env;
  let baseURL = e.TIPHYS_LLM_BASE_URL || file.baseURL;
  const apiKey = e.TIPHYS_LLM_API_KEY || file.apiKey;
  let apiKeys: string[] = apiKey ? [apiKey] : [];
  let keySource = apiKey ? "TIPHYS_LLM_API_KEY/config" : "none";
  let defaultModel = "gpt-4o-mini";
  let provider = (e.TIPHYS_LLM_PROVIDER || file.provider) as AgentConfig["provider"] | undefined;
  // Priority: explicit TIPHYS_LLM_* > tierflow key pool > mock.
  if (provider !== "mock" && !apiKey) {
    const tf = loadTierflowKeys();
    if (tf.keys.length) {
      apiKeys = tf.keys;
      keySource = `${tf.source} (${tf.keys.length} keys)`;
      baseURL = baseURL || e.TF_BASE || tf.base || "https://tierflow.cn/v1";
      defaultModel = "tierflow_pro";
    }
  }
  if (!provider) provider = baseURL && apiKeys.length ? "openai-compatible" : "mock";
  if (provider === "openai-compatible" && !apiKeys.length) provider = "mock";
  return {
    provider,
    baseURL,
    apiKey: apiKeys[0],
    apiKeys,
    keySource,
    model: e.TIPHYS_LLM_MODEL || file.model || (provider === "mock" ? "mock-gis" : defaultModel),
    contextWindow: Number(e.TIPHYS_CONTEXT_WINDOW || file.contextWindow || 64000),
    maxToolOutputChars: Number(e.TIPHYS_MAX_TOOL_OUTPUT || file.maxToolOutputChars || 6000),
    engineUrl: (e.TIPHYS_ENGINE_URL || file.engineUrl || "http://127.0.0.1:8765").replace(/\/$/, ""),
    port: Number(e.TIPHYS_AGENT_PORT || file.port || 8787),
  };
}
