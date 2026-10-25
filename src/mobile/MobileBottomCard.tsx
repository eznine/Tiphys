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

function isTextControl(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "color", "file", "button", "submit", "reset"].includes(target.type);
  }
  return false;
}

function viewportLooksClosed(vv: VisualViewport) {
  // Secondary fallback only — OPPO/ColorOS WebView often never shrinks.
  return vv.height >= window.innerHeight - 8;
}

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
 * OPPO/ColorOS WebView often never fires visualViewport shrink on IME open, so
 * restore cannot depend on viewport gates. Primary restore: any pointer outside
 * the text input blurs + clears typing (send/stop/add handle themselves first).
 */
export function MobileBottomCard({ active, onChange, running, pending, status, children }: Props) {
  const [typing, setTyping] = useState(false);
  const typingRef = useRef(false);
  typingRef.current = typing;
  const cardRef = useRef<HTMLDivElement>(null);
  const sawShrinkRef = useRef(false);

  const releaseComposer = () => {
    setTyping(false);
    sawShrinkRef.current = false;
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement && isTextControl(activeEl) && activeEl.closest(".m-bottom-card")) {
      activeEl.blur();
    }
  };

  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (isTextControl(event.target)) setTyping(true);
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      if (isTextControl(event.relatedTarget)) return;
    }
    setTyping(false);
    sawShrinkRef.current = false;
  };

  // Primary: any tap outside the text input restores dock (OPPO-safe; no viewport needed).
  useEffect(() => {
    const onOutsidePointer = (event: Event) => {
      if (!typingRef.current) return;
      const target = event.target;
      if (isCardTextInput(target)) return;
      // Send/stop/add must run their own handlers first (direct send / open sheet).
      if (isComposerChromeButton(target)) return;
      releaseComposer();
    };
    // capture so we beat scroll/focus quirks; both pointer + touch for older WebViews
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("touchstart", onOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("touchstart", onOutsidePointer, true);
    };
  }, []);

  // Secondary fallback when a WebView does report viewport shrink→recover.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const onViewport = () => {
      if (!viewportLooksClosed(vv)) {
        sawShrinkRef.current = true;
        return;
      }
      if (!sawShrinkRef.current) return;
      sawShrinkRef.current = false;
      if (typingRef.current) releaseComposer();
    };

    vv.addEventListener("resize", onViewport);
    vv.addEventListener("scroll", onViewport);
    window.addEventListener("resize", onViewport);
    return () => {
      vv.removeEventListener("resize", onViewport);
      vv.removeEventListener("scroll", onViewport);
      window.removeEventListener("resize", onViewport);
    };
  }, []);

  useEffect(() => {
    const onFocusOut = () => {
      window.setTimeout(() => {
        if (!typingRef.current) return;
        const activeEl = document.activeElement;
        if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
          return;
        }
        setTyping(false);
        sawShrinkRef.current = false;
      }, 100);
    };
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);

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
