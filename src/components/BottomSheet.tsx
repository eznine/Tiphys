import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: "auto" | "tall" | "full";
};

/** Bottom sheet used by the mobile layout; desktop never renders it. */
export function BottomSheet({ open, title, subtitle, onClose, children, size = "auto" }: Props) {
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className={`sheet${size === "tall" ? " sheet-tall" : ""}${size === "full" ? " sheet-full" : ""}`}>
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div className="sheet-heading">
            <strong>{title}</strong>
            {subtitle && <span className="sheet-subtitle">{subtitle}</span>}
          </div>
          <button type="button" className="plain-icon" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
