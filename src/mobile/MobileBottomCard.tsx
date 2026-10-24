import { useState, type FocusEvent, type ReactNode } from "react";
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

/**
 * The composer and the four-entry dock are one floating card. While the user is
 * typing, the status line and dock fold away so the keyboard only keeps the
 * input visible; the shell hides the whole card when another form field is
 * focused.
 */
export function MobileBottomCard({ active, onChange, running, pending, status, children }: Props) {
  const [typing, setTyping] = useState(false);

  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (isTextControl(event.target)) setTyping(true);
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      if (isTextControl(event.relatedTarget)) return;
    }
    setTyping(false);
  };

  return <div className="m-bottom-card" data-input-focused={typing} onFocus={focus} onBlur={blur}>
    {status && <div className="m-bottom-status-slot">{status}</div>}
    <div className="m-bottom-composer">{children}</div>
    <MobileDock embedded active={active} onChange={onChange} running={running} pending={pending} />
  </div>;
}
