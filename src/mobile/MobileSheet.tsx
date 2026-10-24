import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Initial snap index into snapPoints. */
  initialSnap?: number;
  snapPoints?: number[];
  /** Stacking level for nested sheets. */
  level?: number;
};

const DEFAULT_SNAPS = [0.28, 0.56, 0.93];

/**
 * Real draggable bottom sheet: the handle/header follows the finger and snaps to
 * one of three heights. Only the grab area starts a drag, so inner scrolling and
 * map gestures do not fight it. Heights use dvh-safe measurements and re-measure
 * on keyboard/viewport changes.
 */
export function MobileSheet({ open, title, subtitle, onClose, children, footer, initialSnap = 1, snapPoints = DEFAULT_SNAPS, level = 0 }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ y: number; offset: number } | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const offsetRef = useRef<number | null>(null);
  const [snap, setSnap] = useState(initialSnap);
  const [dragging, setDragging] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const snapOffsets = () => {
    const panel = panelRef.current;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    if (!panel) return { offsets: [] as number[], maxOffset: 0 };
    const full = panel.offsetHeight;
    const offsets = snapPoints.map(fraction => Math.max(0, full - viewport * fraction));
    return { offsets, maxOffset: Math.max(0, ...offsets) };
  };

  useLayoutEffect(() => {
    if (!open) return;
    setSnap(initialSnap);
    const { offsets } = snapOffsets();
    setOffset(offsets[initialSnap] ?? 0);
    offsetRef.current = offsets[initialSnap] ?? 0;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panelRef.current?.focus({ preventScroll: true }), 30);
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.({ preventScroll: true });
    };
    // The sheet is remounted when opened, so these deps only need the open flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    const resize = () => {
      const { offsets } = snapOffsets();
      setOffset(offsets[snap] ?? offsets[0] ?? 0);
      offsetRef.current = offsets[snap] ?? offsets[0] ?? 0;
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snap]);

  if (!open) return null;

  const beginDrag = (event: React.PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const { offsets } = snapOffsets();
    const currentOffset = offsetRef.current ?? offset ?? offsets[snap] ?? 0;
    startRef.current = { y: event.clientY, offset: currentOffset };
    setDragging(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: React.PointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    const { offsets, maxOffset } = snapOffsets();
    const next = Math.min(maxOffset, Math.max(0, start.offset + event.clientY - start.y));
    setOffset(next);
    offsetRef.current = next;
    // Keep the nearest snap highlighted while dragging.
    let nearest = 0;
    offsets.forEach((value, index) => {
      if (Math.abs(value - next) < Math.abs(offsets[nearest] - next)) nearest = index;
    });
    setSnap(nearest);
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!startRef.current) return;
    startRef.current = null;
    setDragging(false);
    const { offsets } = snapOffsets();
    const current = offsetRef.current ?? offset ?? 0;
    let nearest = 0;
    offsets.forEach((value, index) => {
      if (Math.abs(value - current) < Math.abs(offsets[nearest] - current)) nearest = index;
    });
    setSnap(nearest);
    setOffset(offsets[nearest]);
    offsetRef.current = offsets[nearest];
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  const z = 130 + level * 8;

  return (
    <div className="m-sheet-root" style={{ zIndex: z }} role="dialog" aria-modal="true" aria-label={title}>
      <div className="m-sheet-backdrop" onClick={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        className={"m-sheet" + (dragging ? " is-dragging" : "")}
        style={{ transform: offset === null ? undefined : `translate3d(0, ${offset}px, 0)`, visibility: offset === null ? "hidden" : "visible" }}
        tabIndex={-1}
      >
        <div className="m-sheet-grab" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <span className="m-sheet-handle" aria-hidden="true" />
          <div className="m-sheet-head">
            <div className="m-sheet-heading">
              <h2>{title}</h2>
              {subtitle && <div className="m-sheet-subtitle">{subtitle}</div>}
            </div>
            <button type="button" className="m-icon-btn m-sheet-close" aria-label={`关闭${title}`} onPointerDown={event => event.stopPropagation()} onClick={() => onCloseRef.current()}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="m-sheet-body">{children}</div>
        {footer && <div className="m-sheet-footer">{footer}</div>}
        <div className="m-sheet-snaps" aria-hidden="true">
          {snapPoints.map((_, index) => <span key={index} data-active={index === snap} />)}
        </div>
      </div>
    </div>
  );
}
