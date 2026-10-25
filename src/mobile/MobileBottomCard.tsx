import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
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
 * Composer + four-entry dock as one floating card.
 *
 * Fold UX (hiding the dock while the input is focused) is intentionally
 * removed: OPPO/Chrome side-swipe often dismisses the IME while leaving the
 * input focused, which previously stranded the UI in an input-only layout
 * (`data-input-focused` with dock gone). Dock stays visible; we only blur on
 * IME dismiss / outside tap / history back so focus does not stick.
 */
export function MobileBottomCard({ active, onChange, running, pending, status, children }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  const releaseComposer = () => {
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement && isTextControl(activeEl) && activeEl.closest(".m-bottom-card")) {
      activeEl.blur();
    }
  };

  const focus = (_event: FocusEvent<HTMLDivElement>) => {
    // Dock no longer folds on focus — keep handler so focus events stay local.
  };

  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      if (isTextControl(event.relatedTarget)) return;
    }
    deferComposerIdle(() => {
      /* no fold state to clear */
    });
  };

  // Outside tap blurs the composer so the caret does not stick after IME dismiss.
  useEffect(() => {
    const onOutsidePointer = (event: Event) => {
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

  // Native Keyboard hide + viewport shrink→recover + VirtualKeyboard.
  useEffect(() => {
    return subscribeImeDismiss(() => releaseComposer());
  }, []);

  // Browser / WebView back (incl. OPPO side-swipe that fires popstate or
  // history navigation) must blur so focus cannot stick without an IME.
  useEffect(() => {
    const onNav = () => releaseComposer();
    window.addEventListener("popstate", onNav);
    window.addEventListener("pageshow", onNav);
    window.addEventListener("orientationchange", onNav);
    const onVisibility = () => {
      if (document.visibilityState === "visible") onNav();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("pageshow", onNav);
      window.removeEventListener("orientationchange", onNav);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const onInput = () => {
    /* typing no longer drives layout */
  };

  const composerChildren = Children.map(children, child => {
    if (!isValidElement(child)) return child;
    return cloneElement(child as ReactElement<ComposerIdleChildProps>, {
      onComposerIdle: releaseComposer,
    });
  });

  return <div ref={cardRef} className="m-bottom-card" onFocus={focus} onBlur={blur} onInput={onInput}>
    {status && <div className="m-bottom-status-slot">{status}</div>}
    <div className="m-bottom-composer">{composerChildren}</div>
    <MobileDock embedded active={active} onChange={onChange} running={running} pending={pending} />
  </div>;
}
