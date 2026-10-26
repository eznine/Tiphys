import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { MobileDock, type MobileTab } from "./MobileDock";
import {
  deferComposerIdle,
  imeDebug,
  imeDismissArmed,
  isComposerTextFocused,
  isTextControl,
  noteComposerFocus,
  subscribeImeDismiss,
} from "./imeRestore";
import { getActiveMobileBackStack } from "./mobileBack";

type Props = {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  running: number;
  pending: number;
  /** Optional status line inside the card (agent preview / model state). */
  status?: ReactNode;
  children: ReactNode;
};

type ComposerIdleChildProps = {
  onComposerIdle?: () => void;
};

const COMPOSER_FOLD_KEY = "composer-fold";

function isComposerChromeButton(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(
    ".m-askbar-send, .mobile-composer-send, .m-askbar-add, .mobile-composer-add",
  );
}

function isCardTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (!isTextControl(target)) return false;
  return !!target.closest(".m-bottom-card");
}

function isComposerChrome(target: EventTarget | null) {
  return isCardTextInput(target) || isComposerChromeButton(target);
}

/**
 * Composer + four-entry dock as one floating card.
 *
 * Required fold UX: tap chat/map input → hide dock/status (`data-input-focused`),
 * show composer only. On IME dismiss (Back / OPPO side-swipe / outside tap /
 * Capacitor Keyboard hide) → restore dock immediately. Never leave composer
 * stuck alone.
 *
 * OPPO Chrome often dismisses IME without blur, without visualViewport shrink,
 * and without a document pointer. Restore paths (aggressive):
 * 1) focus → typing=true (fold); push `composer-fold` on mobileBack stack
 * 2) Capacitor Keyboard willHide/didHide (APK)
 * 3) VirtualKeyboard geometrychange height 0
 * 4) visualViewport shrink→recover (secondary)
 * 5) outside pointerdown/touchstart capture (not on input/send/add)
 * 6) popstate / Cap backButton via composer-fold history (consumes back first)
 * 7) focusout + 50ms activeElement check; 200ms poll while folded
 * 8) pageshow / orientation / visibility
 * 9) Send pointerdown → onComposerIdle (one-tap send + unfold)
 */
export function MobileBottomCard({ active, onChange, running, pending, status, children }: Props) {
  const [typing, setTyping] = useState(false);
  const typingRef = useRef(false);
  typingRef.current = typing;
  const cardRef = useRef<HTMLDivElement>(null);
  const focusOutTimerRef = useRef<number | null>(null);

  const clearTypingOnly = () => {
    typingRef.current = false;
    setTyping(false);
  };

  const releaseComposer = (force = false) => {
    // Grace: while the IME is still opening, keep focus if the input has it
    // (stray blur/keyboard-hide/re-render must not kill the IME).
    if (!force && !imeDismissArmed() && isComposerTextFocused()) {
      imeDebug("release ignored (grace, input still focused)");
      return;
    }
    typingRef.current = false;
    setTyping(false);
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement && isTextControl(activeEl) && activeEl.closest(".m-bottom-card")) {
      activeEl.blur();
    }
  };

  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (isTextControl(event.target)) setTyping(true);
  };

  // Always clear on card blur (deferred so Send pointerdown runs first).
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      if (isTextControl(event.relatedTarget)) return;
    }
    deferComposerIdle(() => {
      if (!typingRef.current) return;
      if (isComposerTextFocused()) return;
      clearTypingOnly();
    });
  };

  // Sync fold ↔ back stack: Back / side-swipe pops composer-fold first.
  useEffect(() => {
    const stack = getActiveMobileBackStack();
    if (!stack) return;
    if (typing) {
      stack.push(COMPOSER_FOLD_KEY, () => {
        // Closer runs from popstate / Cap backButton — clear fold + blur.
        typingRef.current = false;
        setTyping(false);
        const activeEl = document.activeElement;
        if (activeEl instanceof HTMLElement && isTextControl(activeEl) && activeEl.closest(".m-bottom-card")) {
          activeEl.blur();
        }
      });
    } else {
      stack.dismiss(COMPOSER_FOLD_KEY);
    }
  }, [typing]);

  // Primary for taps: any pointer outside the text input / send / add restores dock.
  // Critical for OPPO: capture phase; fires even when IME already gone but focus stuck.
  useEffect(() => {
    const onOutsidePointer = (event: Event) => {
      if (!typingRef.current) return;
      if (isComposerChrome(event.target)) return;
      releaseComposer(true);
    };
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("touchstart", onOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("touchstart", onOutsidePointer, true);
    };
  }, []);

  // Native Keyboard hide + viewport shrink→recover + VirtualKeyboard + popstate.
  useEffect(() => {
    return subscribeImeDismiss(() => {
      if (typingRef.current) releaseComposer();
    });
  }, []);

  // focusin/focusout: if activeElement leaves composer for >50ms while folded, clear.
  useEffect(() => {
    const clearFocusOutTimer = () => {
      if (focusOutTimerRef.current != null) {
        window.clearTimeout(focusOutTimerRef.current);
        focusOutTimerRef.current = null;
      }
    };

    const onFocusIn = (event: Event) => {
      const target = event.target;
      if (isCardTextInput(target)) {
        clearFocusOutTimer();
        if (!typingRef.current) noteComposerFocus();
        setTyping(true);
        return;
      }
      if (!typingRef.current) return;
      // Focus moved to non-composer control while folded — schedule clear.
      clearFocusOutTimer();
      focusOutTimerRef.current = window.setTimeout(() => {
        focusOutTimerRef.current = null;
        if (!typingRef.current) return;
        if (isComposerTextFocused()) return;
        clearTypingOnly();
      }, 50);
    };

    const onFocusOut = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(".m-bottom-card")) return;
      if (!isTextControl(target)) return;
      clearFocusOutTimer();
      focusOutTimerRef.current = window.setTimeout(() => {
        focusOutTimerRef.current = null;
        if (!typingRef.current) return;
        if (isComposerTextFocused()) return;
        clearTypingOnly();
      }, 50);
    };

    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      clearFocusOutTimer();
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);

  // While folded: poll activeElement — Back/side-swipe sometimes keeps focus
  // on the input without usable blur; also catches late focus moves.
  useEffect(() => {
    if (!typing) return;
    const id = window.setInterval(() => {
      if (!typingRef.current) return;
      // If focus left the composer input, unfold. (If focus stayed on input
      // after IME-only dismiss, other paths — Keyboard / popstate / tap — clear.)
      if (isComposerTextFocused()) return;
      clearTypingOnly();
    }, 200);
    return () => window.clearInterval(id);
  }, [typing]);

  // Clear stuck input-only mode across app resume / rotate (IME often gone).
  useEffect(() => {
    const releaseIfTyping = () => {
      if (typingRef.current) releaseComposer();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") releaseIfTyping();
    };
    window.addEventListener("pageshow", releaseIfTyping);
    window.addEventListener("orientationchange", releaseIfTyping);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pageshow", releaseIfTyping);
      window.removeEventListener("orientationchange", releaseIfTyping);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const onInput = () => {
    if (isComposerTextFocused()) setTyping(true);
  };

  const composerChildren = Children.map(children, child => {
    if (!isValidElement(child)) return child;
    return cloneElement(child as ReactElement<ComposerIdleChildProps>, {
      onComposerIdle: () => releaseComposer(true),
    });
  });

  return <div ref={cardRef} className="m-bottom-card" data-input-focused={typing} onFocus={focus} onBlur={blur} onInput={onInput}>
    {status && <div className="m-bottom-status-slot">{status}</div>}
    <div className="m-bottom-composer">{composerChildren}</div>
    <MobileDock embedded active={active} onChange={onChange} running={running} pending={pending} />
  </div>;
}
