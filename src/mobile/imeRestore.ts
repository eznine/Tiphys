import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

/**
 * Subscribe to IME / soft-keyboard dismiss signals.
 *
 * OPPO/ColorOS (and many Android WebViews) often dismiss the keyboard via
 * Back / side-swipe WITHOUT firing a document tap outside the input, WITHOUT
 * blur, and WITHOUT shrinking visualViewport. Capacitor Keyboard is the
 * reliable native path; web relies on popstate (composer-fold history),
 * outside capture, focus polling, and shrink→recover when available.
 *
 * visualViewport is shrink→recover only (secondary). Ungated "full height"
 * checks are unsafe on OPPO: height often never shrinks while IME is open.
 */
export function imeDebug(...args: unknown[]): void {
  try {
    if (localStorage.getItem("tiphys:imeDebug") === "1") console.log("[ime]", ...args);
  } catch { /* ignore */ }
}

export function subscribeImeDismiss(rawDismiss: () => void): () => void {
  const onDismiss = (source = "?") => {
    imeDebug("dismiss", source);
    rawDismiss();
  };
  const cleanups: Array<() => void> = [];
  let cancelled = false;
  let sawShrink = false;
  let nativeShown = false;
  let useNativeKeyboard = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Keyboard");

  // Native IME events are authoritative. resizeOnFullScreen changes innerHeight
  // while WebView independently changes visualViewport: their heights can become
  // equal DURING show. Running the web shrink→recover heuristic here blurs the
  // input and cancels the keyboard that just started opening.
  if (useNativeKeyboard) {
    void (async () => {
      try {
        const { Keyboard } = await import("@capacitor/keyboard");
        const onShown = () => { nativeShown = true; imeDebug("keyboard shown"); };
        const onHidden = () => {
          // Capacitor 6 also reports hide for non-IME insets animations. An
          // initial hidden state is not a dismissal, regardless of elapsed time.
          if (!nativeShown) return;
          nativeShown = false;
          onDismiss("native");
        };
        const handles: PluginListenerHandle[] = [];
        handles.push(await Keyboard.addListener("keyboardWillShow", onShown));
        handles.push(await Keyboard.addListener("keyboardDidShow", onShown));
        handles.push(await Keyboard.addListener("keyboardWillHide", onHidden));
        handles.push(await Keyboard.addListener("keyboardDidHide", onHidden));
        if (cancelled) {
          for (const h of handles) void h.remove();
          return;
        }
        cleanups.push(() => {
          for (const h of handles) void h.remove();
        });
      } catch {
        // Plugin missing or web stub — other fallbacks still apply.
        useNativeKeyboard = false;
      }
    })();
  }

  // Chrome Android VirtualKeyboard API — geometry height 0 ≈ IME closed.
  // Helps when visualViewport never shrinks (OPPO browser / some WebViews).
  const vk = (navigator as Navigator & {
    virtualKeyboard?: {
      boundingRect: DOMRect;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
  }).virtualKeyboard;
  if (vk) {
    let vkShown = false;
    const onGeometry = () => {
      if (useNativeKeyboard) return;
      try {
        if ((vk.boundingRect?.height ?? 0) > 0) vkShown = true;
        else if (vkShown) {
          vkShown = false;
          onDismiss("vk");
        }
      } catch { /* ignore */ }
    };
    vk.addEventListener("geometrychange", onGeometry);
    cleanups.push(() => vk.removeEventListener("geometrychange", onGeometry));
  }

  const onViewport = () => {
    if (useNativeKeyboard) return;
    const vv = window.visualViewport;
    if (!vv) return;
    if (vv.height < window.innerHeight - 8) {
      sawShrink = true;
      return;
    }
    if (!sawShrink) return;
    sawShrink = false;
    onDismiss("viewport");
  };
  window.visualViewport?.addEventListener("resize", onViewport);
  window.visualViewport?.addEventListener("scroll", onViewport);
  window.addEventListener("resize", onViewport);
  cleanups.push(() => {
    window.visualViewport?.removeEventListener("resize", onViewport);
    window.visualViewport?.removeEventListener("scroll", onViewport);
    window.removeEventListener("resize", onViewport);
  });

  // History / side-swipe back: blur path when visualViewport never moved.
  const onPopState = () => onDismiss("popstate");
  window.addEventListener("popstate", onPopState);
  cleanups.push(() => window.removeEventListener("popstate", onPopState));

  return () => {
    cancelled = true;
    for (const c of cleanups.splice(0)) c();
  };
}

/** Defer blur cleanup for Send, and discard it if a composer regained focus. */
export function deferComposerIdle(fn: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      if (!isComposerTextFocused()) fn();
    }, 0);
  });
}

export function isTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "color", "file", "button", "submit", "reset"].includes(target.type);
  }
  return false;
}

/** True when the focused node is the bottom-card composer text field. */
export function isComposerTextFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (!isTextControl(active)) return false;
  return !!active.closest(".m-bottom-card");
}
