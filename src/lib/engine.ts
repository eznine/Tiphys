/** TIPHYS spatial engine HTTP client (M0: ping only). */

export type EnginePing = {
  ok: boolean;
  service: string;
};

export type PingResult =
  | { state: "ok"; data: EnginePing; latencyMs: number }
  | { state: "error"; message: string }
  | { state: "pending" };

const DEFAULT_BASE =
  import.meta.env.VITE_ENGINE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8765";

export function engineBaseUrl(): string {
  return DEFAULT_BASE;
}

export async function pingEngine(
  baseUrl: string = engineBaseUrl(),
  signal?: AbortSignal,
): Promise<PingResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}/ping`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      return { state: "error", message: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as EnginePing;
    if (!data?.ok || data.service !== "tiphys-engine") {
      return { state: "error", message: "unexpected ping payload" };
    }
    return {
      state: "ok",
      data,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "error", message };
  }
}
