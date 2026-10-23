type IdleHost = typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Run low-priority setup after the next paint when the browser is idle.
 * Falls back to a short timer in browsers without requestIdleCallback.
 */
export function scheduleIdle(callback: () => void, options: { timeout?: number; fallbackDelay?: number } = {}): () => void {
  const host = globalThis as IdleHost;
  if (typeof host.requestIdleCallback === "function") {
    const handle = host.requestIdleCallback(callback, { timeout: options.timeout ?? 1200 });
    return () => host.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(callback, options.fallbackDelay ?? 80);
  return () => clearTimeout(timer);
}
