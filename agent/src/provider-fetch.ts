import { maskKey, type AgentConfig } from "./config.js";

/** Same authenticated upstream transport for desktop Agent and browser model proxy. */
export function providerFetch(config: AgentConfig): typeof fetch {
  let index = 0;
  return async (input, init) => {
    let last: Response | undefined;
    for (let tries = 0; tries < config.apiKeys.length; tries++) {
      const key = config.apiKeys[index % config.apiKeys.length];
      const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${key}`);
      const response = await fetch(input, { ...init, headers });
      if (![401, 402, 403, 429].includes(response.status) && response.status < 500) return response;
      console.log(`[tiphys-agent] key ${maskKey(key)} -> HTTP ${response.status}; rotating`);
      last = response; index++;
      if (tries < config.apiKeys.length - 1) await response.body?.cancel();
    }
    if (!last) throw new Error("尚未配置 API 凭据。");
    return last;
  };
}
