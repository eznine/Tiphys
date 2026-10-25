import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
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
  // Android WebView often leaves focus stuck after IME dismiss; treat a recovered
  // visual viewport (~window.innerHeight) as keyboard-closed.
  return vv.height >= window.innerHeight - 8;
}

function isComposerSendTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(".m-askbar-send, .mobile-composer-send");
}

/**
 * The composer and the four-entry dock are one floating card. While the user is
 * typing, the status line and dock fold away so the keyboard only keeps the
 * input visible; the shell hides the whole card when another form field is
 * focused.
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
        const vv = window.visualViewport;
        if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
          // Focus stuck after IME dismiss (viewport recovered).
          if (vv && viewportLooksClosed(vv) && sawShrinkRef.current) {
            releaseComposer();
          }
          return;
        }
        setTyping(false);
        sawShrinkRef.current = false;
      }, 100);
    };
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);

  // Fallback for WebViews that skip visualViewport resize on IME dismiss.
  useEffect(() => {
    if (!typing) return;
    const timer = window.setInterval(() => {
      if (!typingRef.current || !sawShrinkRef.current) return;
      const vv = window.visualViewport;
      if (!vv || !viewportLooksClosed(vv)) return;
      releaseComposer();
    }, 320);
    return () => window.clearInterval(timer);
  }, [typing]);

  // Send/stop: prevent blur-before-click from eating the first tap. preventDefault can
  // suppress the subsequent click on mobile, so submit/click immediately and swallow the ghost.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!isComposerSendTarget(event.target)) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      setTyping(false);
      sawShrinkRef.current = false;
      const btn = (event.target as HTMLElement).closest("button") as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      if (btn.type === "submit") {
        btn.closest("form")?.requestSubmit(btn);
      } else {
        btn.click();
      }
      const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
      btn.addEventListener("click", swallow, { capture: true, once: true });
    };
    card.addEventListener("pointerdown", onPointerDown);
    return () => card.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const onInput = () => {
    const activeEl = document.activeElement;
    if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
      setTyping(true);
    }
  };

  return <div ref={cardRef} className="m-bottom-card" data-input-focused={typing} onFocus={focus} onBlur={blur} onInput={onInput}>
    {status && <div className="m-bottom-status-slot">{status}</div>}
    <div className="m-bottom-composer">{children}</div>
    <MobileDock embedded active={active} onChange={onChange} running={running} pending={pending} />
  </div>;
}
