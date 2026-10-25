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
import { deferComposerIdle, isTextControl, subscribeImeDismiss } from "./imeRestore";

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

/**
 * The composer and the four-entry dock are one floating card. While the user is
 * typing, the status line and dock fold away so the keyboard only keeps the
 * input visible; the shell hides the whole card when another form field is
 * focused.
 *
 * OPPO/ColorOS: Back / side-swipe often dismisses IME without a document tap
 * outside the input and without visualViewport shrink. Restore paths:
 * 1) Capacitor Keyboard willHide/didHide (native APK)
 * 2) input blur → deferred clear (Send pointerdown still wins)
 * 3) outside pointer / touch
 * 4) focusout + 300ms activeElement poll while folded
 * 5) visualViewport shrink→recover (secondary)
 */
export function MobileBottomCard({ active, onChange, running, pending, status, children }: Props) {
  const [typing, setTyping] = useState(false);
  const typingRef = useRef(false);
  typingRef.current = typing;
  const cardRef = useRef<HTMLDivElement>(null);

  const clearTypingOnly = () => {
    setTyping(false);
  };

  const releaseComposer = () => {
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
      const activeEl = document.activeElement;
      if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
        return;
      }
      clearTypingOnly();
    });
  };

  // Primary for taps: any pointer outside the text input restores dock.
  useEffect(() => {
    const onOutsidePointer = (event: Event) => {
      if (!typingRef.current) return;
      const target = event.target;
      if (isCardTextInput(target)) return;
      if (isComposerChromeButton(target)) return;
      releaseComposer();
    };
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("touchstart", onOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("touchstart", onOutsidePointer, true);
    };
  }, []);

  // Native Keyboard hide + viewport shrink→recover (no ungated full-height).
  useEffect(() => {
    return subscribeImeDismiss(() => {
      if (typingRef.current) releaseComposer();
    });
  }, []);

  // focusout: Android may blur without relatedTarget / bubble quirks.
  useEffect(() => {
    const onFocusOut = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(".m-bottom-card")) return;
      if (!isTextControl(target)) return;
      deferComposerIdle(() => {
        if (!typingRef.current) return;
        const activeEl = document.activeElement;
        if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
          return;
        }
        clearTypingOnly();
      });
    };
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);

  // While folded: poll activeElement — Back/side-swipe sometimes moves focus
  // off the input without a usable blur/pointer event.
  useEffect(() => {
    if (!typing) return;
    const id = window.setInterval(() => {
      if (!typingRef.current) return;
      const activeEl = document.activeElement;
      if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
        return;
      }
      clearTypingOnly();
    }, 300);
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
    const activeEl = document.activeElement;
    if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
      setTyping(true);
    }
  };

  const composerChildren = Children.map(children, child => {
    if (!isValidElement(child)) return child;
    return cloneElement(child as ReactElement<ComposerIdleChildProps>, {
      onComposerIdle: releaseComposer,
    });
  });

  return <div ref={cardRef} className="m-bottom-card" data-input-focused={typing} onFocus={focus} onBlur={blur} onInput={onInput}>
    {status && <div className="m-bottom-status-slot">{status}</div>}
    <div className="m-bottom-composer">{composerChildren}</div>
    <MobileDock embedded active={active} onChange={onChange} running={running} pending={pending} />
  </div>;
}
