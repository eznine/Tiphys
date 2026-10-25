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
export function subscribeImeDismiss(onDismiss: () => void): () => void {
  const cleanups: Array<() => void> = [];
  let cancelled = false;
  let sawShrink = false;

  // Prefer native Capacitor Keyboard when present (APK WebView).
  if (Capacitor.isNativePlatform()) {
    void (async () => {
      try {
        if (!Capacitor.isPluginAvailable("Keyboard")) return;
        const { Keyboard } = await import("@capacitor/keyboard");
        const handles: PluginListenerHandle[] = [];
        handles.push(await Keyboard.addListener("keyboardWillHide", onDismiss));
        handles.push(await Keyboard.addListener("keyboardDidHide", onDismiss));
        if (cancelled) {
          for (const h of handles) void h.remove();
          return;
        }
        cleanups.push(() => {
          for (const h of handles) void h.remove();
        });
      } catch {
        // Plugin missing or web stub — other fallbacks still apply.
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
    const onGeometry = () => {
      try {
        if ((vk.boundingRect?.height ?? 0) === 0) onDismiss();
      } catch { /* ignore */ }
    };
    vk.addEventListener("geometrychange", onGeometry);
    cleanups.push(() => vk.removeEventListener("geometrychange", onGeometry));
  }

  const onViewport = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    if (vv.height < window.innerHeight - 8) {
      sawShrink = true;
      return;
    }
    if (!sawShrink) return;
    sawShrink = false;
    onDismiss();
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
  const onPopState = () => onDismiss();
  window.addEventListener("popstate", onPopState);
  cleanups.push(() => window.removeEventListener("popstate", onPopState));

  return () => {
    cancelled = true;
    for (const c of cleanups.splice(0)) c();
  };
}

/** Defer idle so Send pointerdown can run before blur clears fold state. */
export function deferComposerIdle(fn: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(fn, 0);
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
