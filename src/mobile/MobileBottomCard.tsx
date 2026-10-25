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

  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (isTextControl(event.target)) setTyping(true);
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      if (isTextControl(event.relatedTarget)) return;
    }
    setTyping(false);
  };

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let sawShrink = false;

    const clearTyping = () => {
      if (!typingRef.current) return;
      setTyping(false);
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLElement && isTextControl(activeEl) && activeEl.closest(".m-bottom-card")) {
        activeEl.blur();
      }
    };

    const onViewport = () => {
      if (!viewportLooksClosed(vv)) {
        sawShrink = true;
        return;
      }
      // Only restore after a shrink→recover cycle (keyboard open then closed).
      if (!sawShrink) return;
      sawShrink = false;
      clearTyping();
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
        const activeEl = document.activeElement;
        if (isTextControl(activeEl) && activeEl instanceof HTMLElement && activeEl.closest(".m-bottom-card")) {
          const vv = window.visualViewport;
          // Still focused inside the card and keyboard appears open — keep typing.
          if (vv && !viewportLooksClosed(vv)) return;
        }
        if (!(activeEl instanceof HTMLElement) || !isTextControl(activeEl) || !activeEl.closest(".m-bottom-card")) {
          setTyping(false);
        }
      }, 100);
    };
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);

  return <div className="m-bottom-card" data-input-focused={typing} onFocus={focus} onBlur={blur}>
    {status && <div className="m-bottom-status-slot">{status}</div>}
    <div className="m-bottom-composer">{children}</div>
    <MobileDock embedded active={active} onChange={onChange} running={running} pending={pending} />
  </div>;
}
