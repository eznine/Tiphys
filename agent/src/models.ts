/** OpenAI-compatible model listing (`GET {baseURL}/models`) with tolerant parsing. */

const MAX_MODELS = 2000;

/** Accept data[].id (OpenAI), models[].name (Ollama), bare arrays and string maps. */
export function parseModelIds(payload: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const id = value.trim();
    if (!id || id.length > 200) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };
  const addItem = (item: unknown) => {
    if (typeof item === "string") return add(item);
    if (item && typeof item === "object") {
      const model = item as Record<string, unknown>;
      add(model.id ?? model.name ?? model.model ?? model.slug);
    }
  };
  const addList = (list: unknown) => {
    if (Array.isArray(list)) for (const item of list) addItem(item);
  };
  if (Array.isArray(payload)) addList(payload);
  else if (payload && typeof payload === "object") {
    const root = payload as Record<string, unknown>;
    if (Array.isArray(root.data)) addList(root.data);
    else if (root.data && typeof root.data === "object") for (const key of Object.keys(root.data)) add(key);
    else if (Array.isArray(root.models)) addList(root.models);
    else if (Array.isArray(root.result)) addList(root.result);
  }
  return ids.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).slice(0, MAX_MODELS);
}

function redactKeys(text: string, keys: string[]): string {
  let out = text;
  for (const key of keys) if (key) out = out.split(key).join("[已脱敏]");
  return out.replace(/Bearer\s+[^\s"']+/gi, "Bearer [已脱敏]").slice(0, 500);
}

/**
 * List models with key rotation on auth/rate-limit/5xx responses. The endpoint
 * usually accepts any key in the pool; an empty pool is allowed for local
 * providers (e.g. Ollama) but rejected by hosted ones with a clear message.
 */
export async function listModels(baseURL: string, keys: string[], signal?: AbortSignal): Promise<string[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const pool = keys.length ? keys : [""];
  let lastStatus = 0;
  let lastBody = "";
  for (const key of pool) {
    const timeout = AbortSignal.timeout(20_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: combined });
    } catch (err) {
      if (timeout.aborted) throw new Error("拉取模型超时（20 秒），请检查接口地址或稍后重试。");
      if (signal?.aborted) throw new Error("已取消拉取模型。");
      throw new Error(`无法连接模型接口：${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text();
    if (response.ok) {
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new Error("模型接口返回的不是 JSON，请确认填写的是 OpenAI 兼容地址。"); }
      const models = parseModelIds(payload);
      if (!models.length) throw new Error("接口返回成功但未解析到模型 id；可手动输入模型名称。");
      return models;
    }
    lastStatus = response.status;
    lastBody = redactKeys(text, keys);
    if (![401, 402, 403, 429].includes(response.status) && response.status < 500) break;
    await response.body?.cancel();
  }
  throw new Error(`拉取模型失败（HTTP ${lastStatus}）：${lastBody || "服务端未返回内容"}`);
}
