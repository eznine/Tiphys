import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

export type MobileBackEntry = {
  key: string;
  /** Return true if this entry consumed the back action. */
  close: () => void;
};

/**
 * In-app back stack synced with history.pushState (web) and Capacitor
 * App.backButton (native). Closers run one level at a time — tool detail →
 * tool list → closed, not a hard jump to the map.
 */
export function createMobileBackStack() {
  const stack: MobileBackEntry[] = [];
  let suppressing = false;
  let rootReady = false;

  const ensureRoot = () => {
    if (rootReady) return;
    rootReady = true;
    try {
      if (!(history.state as { tiphysRoot?: boolean } | null)?.tiphysRoot) {
        history.replaceState({ tiphysRoot: true }, "");
      }
    } catch { /* private mode / SSR */ }
  };

  const push = (key: string, close: () => void) => {
    ensureRoot();
    const top = stack[stack.length - 1];
    if (top?.key === key) {
      top.close = close;
      return;
    }
    stack.push({ key, close });
    try {
      history.pushState({ tiphys: true, key }, "");
    } catch { /* ignore */ }
  };

  /** Drop a key after UI already closed (X / programmatic). Sync history. */
  const dismiss = (key: string) => {
    const idx = stack.findIndex(entry => entry.key === key);
    if (idx < 0) return;
    const wasTop = idx === stack.length - 1;
    stack.splice(idx, 1);
    if (!wasTop) return;
    const state = history.state as { tiphys?: boolean; key?: string } | null;
    if (state?.tiphys && state.key === key) {
      suppressing = true;
      try { history.back(); } catch { suppressing = false; return; }
      window.setTimeout(() => { suppressing = false; }, 50);
    }
  };

  /**
   * Remove entries whose key starts with prefix.
   * Trailing (top) matches rewind history; buried matches are dropped from the
   * in-memory stack only (caller should close overlays first so tab keys are trailing).
   */
  const clearPrefix = (prefix: string) => {
    let backs = 0;
    while (stack.length && stack[stack.length - 1].key.startsWith(prefix)) {
      stack.pop();
      backs += 1;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].key.startsWith(prefix)) stack.splice(i, 1);
    }
    if (backs > 0) {
      suppressing = true;
      for (let i = 0; i < backs; i++) {
        try { history.back(); } catch { /* ignore */ }
      }
      window.setTimeout(() => { suppressing = false; }, 80);
    }
  };

  /** Consume one level. Returns true if something closed. */
  const consume = (): boolean => {
    const top = stack.pop();
    if (!top) return false;
    try { top.close(); } catch { /* ignore */ }
    return true;
  };

  const depth = () => stack.length;

  const subscribe = (onRootBack: () => boolean): (() => void) => {
    ensureRoot();
    const onPopState = () => {
      if (suppressing) return;
      if (consume()) return;
      onRootBack();
    };
    window.addEventListener("popstate", onPopState);

    const cleanups: Array<() => void> = [];
    cleanups.push(() => window.removeEventListener("popstate", onPopState));

    if (Capacitor.isNativePlatform()) {
      let cancelled = false;
      void (async () => {
        try {
          if (!Capacitor.isPluginAvailable("App")) return;
          const { App } = await import("@capacitor/app");
          const handle: PluginListenerHandle = await App.addListener("backButton", () => {
            if (consume()) {
              const state = history.state as { tiphys?: boolean } | null;
              if (state?.tiphys) {
                suppressing = true;
                try { history.back(); } catch { /* ignore */ }
                window.setTimeout(() => { suppressing = false; }, 50);
              }
              return;
            }
            if (onRootBack()) return;
            void App.exitApp();
          });
          if (cancelled) {
            void handle.remove();
            return;
          }
          cleanups.push(() => { void handle.remove(); });
        } catch {
          // Plugin missing — popstate path still works on web.
        }
      })();
      cleanups.push(() => { cancelled = true; });
    }

    return () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  };

  return { push, dismiss, clearPrefix, consume, depth, subscribe };
}

export type MobileBackStack = ReturnType<typeof createMobileBackStack>;
