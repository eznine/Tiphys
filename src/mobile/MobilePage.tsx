import { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

type Props = {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onBack: () => void;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Hide the back button for root-level pages. */
  root?: boolean;
  /** Cover the dock (toolbox, task detail) instead of sitting below it. */
  overlay?: boolean;
};

/** Full-screen mobile page used for the toolbox, task detail and project detail. */
export function MobilePage({ open, title, subtitle, onBack, children, actions, footer, root = false, overlay = false }: Props) {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onBackRef.current(); };
    window.addEventListener("keydown", escape);
    pageRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!open) return null;

  return (
    <section className={"m-page" + (overlay ? " m-page-overlay" : "")} aria-label={title} ref={pageRef} tabIndex={-1}>
      <header className="m-page-head">
        {!root && <button type="button" className="m-icon-btn m-page-back" aria-label="返回" onClick={onBack}><ChevronLeft size={22} /></button>}
        <div className="m-page-heading">
          <h2>{title}</h2>
          {subtitle && <div className="m-page-subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="m-page-actions">{actions}</div>}
      </header>
      <div className="m-page-body">{children}</div>
      {footer && <div className="m-page-footer">{footer}</div>}
    </section>
  );
}
