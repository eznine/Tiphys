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
 * Missing sources leave the API unconfigured; read errors are exposed in settings.
 */
function loadTierflowKeys(stateDir: string): { keys: string[]; base?: string; source: string; issue?: string } {
  const env = process.env.TIPHYS_TF_KEYS;
  if (env) return { keys: env.split(/[\s,]+/).filter(Boolean), source: "env TIPHYS_TF_KEYS" };
  const candidates = process.env.TIPHYS_TF_KEYS_FILE
    ? [process.env.TIPHYS_TF_KEYS_FILE]
    : [
        // State dir first: packaged/desktop runs have no repo checkout.
        path.join(stateDir, "tierflow_keys.txt"),
        path.join(PROJECT_ROOT, ".tiphys", "tierflow_keys.txt"),
        path.join(os.homedir(), ".tierflow"),
      ];
  const issues: string[] = [];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        const r = parseKeysFile(file);
        if (r.keys.length) return { ...r, source: `keys file ${file}` };
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") issues.push(`${file}: ${err.code ?? "读取失败"}`);
    }
  }
  if (process.platform === "win32" || !fs.existsSync(TF_KEYS_SCRIPT)) return { keys: [], source: "none", issue: issues.join("；") || undefined };
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

export const PROJECT_ROOT = process.env.TIPHYS_PROJECT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TIPHYS_DIR = process.env.TIPHYS_STATE_DIR || path.join(PROJECT_ROOT, ".tiphys");
/** User-profile config survives reinstalls and app-data wipes; tests redirect it via TIPHYS_USER_DIR. */
export const USER_DIR = process.env.TIPHYS_USER_DIR || path.join(os.homedir(), ".tiphys");

export type AgentConfig = {
  provider: "mock" | "openai-compatible" | "unconfigured";
  configIssue?: string;
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

export function loadConfig(stateDir = TIPHYS_DIR, userDir = USER_DIR): AgentConfig {
  const file = { ...readJson(path.join(userDir, "agent.json")), ...readJson(path.join(stateDir, "agent.json")) } as Record<string, any>;
  const e = process.env;
  let baseURL = e.TIPHYS_LLM_BASE_URL || file.baseURL;
  const apiKey = e.TIPHYS_LLM_API_KEY || file.apiKey;
  let apiKeys: string[] = apiKey ? [apiKey] : Array.isArray(file.apiKeys) ? file.apiKeys.filter((k: unknown) => typeof k === "string" && k.trim()) : [];
  let keySource = apiKeys.length ? "API 设置/环境变量" : "none";
  let configIssue: string | undefined;
  let defaultModel = "gpt-4o-mini";
  // Simulation is only an explicit test/development opt-in. Missing credentials
  // must never turn a production application into a fake model.
  let provider: AgentConfig["provider"] | undefined = e.TIPHYS_LLM_PROVIDER === "mock" ? "mock" : undefined;
  // Priority: explicit TIPHYS_LLM_* > saved API settings > tierflow key pool.
  if (provider !== "mock" && !apiKeys.length) {
    const tf = loadTierflowKeys(stateDir);
    configIssue = tf.issue;
    if (tf.keys.length) {
      apiKeys = tf.keys;
      keySource = `${tf.source} (${tf.keys.length} keys)`;
      baseURL = baseURL || e.TF_BASE || tf.base || "https://tierflow.cn/v1";
      defaultModel = "tierflow_pro";
    }
  }
  if (apiKeys.length && !baseURL) baseURL = "https://api.openai.com/v1";
  if (!provider) provider = baseURL && apiKeys.length ? "openai-compatible" : "unconfigured";
  if (provider === "unconfigured") configIssue ||= "尚未加载 API 凭据，请打开设置。";
  return {
    provider,
    configIssue,
    baseURL,
    apiKey: apiKeys[0],
    apiKeys,
    keySource,
    model: e.TIPHYS_LLM_MODEL || file.model || (provider === "mock" ? "mock-gis" : defaultModel),
    contextWindow: Number(e.TIPHYS_CONTEXT_WINDOW || file.contextWindow || 64000),
    maxToolOutputChars: Number(e.TIPHYS_MAX_TOOL_OUTPUT || file.maxToolOutputChars || 6000),
    engineUrl: (e.TIPHYS_ENGINE_URL || file.engineUrl || "http://127.0.0.1:8971").replace(/\/$/, ""),
    port: Number(e.TIPHYS_AGENT_PORT || file.port || 8972),
  };
}
