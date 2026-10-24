import fs from "node:fs";
import path from "node:path";
import { TIPHYS_DIR, USER_DIR, type AgentConfig } from "./config.js";

export function publicSettings(config: AgentConfig) {
  return { provider: config.provider, baseURL: config.baseURL ?? "", model: config.model,
    hasApiKey: config.apiKeys.length > 0, keyCount: config.apiKeys.length, keySource: config.keySource,
    configIssue: config.configIssue ?? "", contextWindow: config.contextWindow, maxToolOutputChars: config.maxToolOutputChars,
    configPath: path.join(TIPHYS_DIR, "agent.json"), backupPath: path.join(USER_DIR, "agent.json"),
    environmentOverrides: Object.keys(process.env).filter(k => /^TIPHYS_LLM_|^TIPHYS_CONTEXT_WINDOW$|^TIPHYS_MAX_TOOL_OUTPUT$/.test(k) && process.env[k]) };
}

export function prepareSettings(current: AgentConfig, input: Record<string, unknown>): AgentConfig {
  if (typeof input.baseURL !== "string" || typeof input.model !== "string") throw new Error("请填写 API 地址和模型名称。");
  let base: URL;
  try { base = new URL(input.baseURL.trim()); } catch { throw new Error("API 地址必须是完整的 HTTP 或 HTTPS 地址。"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.hash || base.search) throw new Error("API 地址不应包含登录信息、查询参数或片段。");
  const model = input.model.trim();
  if (!model || model.length > 200) throw new Error("请填写有效的模型名称。");
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("API Key 格式无效。");
  const apiKeys = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim().split(/[\s,]+/).filter(Boolean) : current.apiKeys;
  if (!apiKeys.length) throw new Error("尚未配置 API Key，请输入凭据。");
  const contextWindow = Number(input.contextWindow ?? current.contextWindow);
  const maxToolOutputChars = Number(input.maxToolOutputChars ?? current.maxToolOutputChars);
  if (!Number.isInteger(contextWindow) || contextWindow < 8000 || contextWindow > 2_000_000) throw new Error("上下文窗口需为 8000–2000000 之间的整数。");
  if (!Number.isInteger(maxToolOutputChars) || maxToolOutputChars < 1000 || maxToolOutputChars > 100000) throw new Error("工具输出上限需为 1000–100000 之间的整数。");
  return { ...current, provider: "openai-compatible", configIssue: undefined, baseURL: base.toString().replace(/\/$/, ""),
    apiKeys, apiKey: apiKeys[0], model, keySource: "应用 API 设置", contextWindow, maxToolOutputChars };
}

/** Atomic agent.json write that keeps unrelated keys already present in the file. */
function writeAgentJson(file: string, config: AgentConfig) {
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* Initial settings. */ }
  fs.writeFileSync(temporary, JSON.stringify({ ...previous, provider: "openai-compatible", baseURL: config.baseURL,
    model: config.model, apiKey: undefined, apiKeys: config.apiKeys,
    contextWindow: config.contextWindow, maxToolOutputChars: config.maxToolOutputChars }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** First launch after an upgrade: seed the user-profile backup from an existing
 * state-dir configuration so older installs gain the backup before their next save. */
export function ensureSettingsBackup(stateDir = TIPHYS_DIR, backupDir = USER_DIR) {
  if (path.resolve(backupDir) === path.resolve(stateDir)) return;
  const primary = path.join(stateDir, "agent.json");
  const backup = path.join(backupDir, "agent.json");
  if (fs.existsSync(backup) || !fs.existsSync(primary)) return;
  try { fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(primary, backup); fs.chmodSync(backup, 0o600); }
  catch { /* Backup is best-effort. */ }
}

export function saveSettings(config: AgentConfig, stateDir = TIPHYS_DIR, backupDir?: string) {
  writeAgentJson(path.join(stateDir, "agent.json"), config);
  // Mirror to the user profile so reinstalls, app-data wipes or portable-folder
  // replacement cannot lose the saved API configuration. loadConfig falls back
  // to this copy when the state-dir file is missing. A failed backup must not
  // fail the save itself.
  if (!backupDir || path.resolve(backupDir) === path.resolve(stateDir)) return;
  try { writeAgentJson(path.join(backupDir, "agent.json"), config); } catch { /* Backup is best-effort. */ }
}
