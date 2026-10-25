import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";

type Props = {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  /** Drill-down back action; shows a back chevron before the title. */
  onBack?: () => void;
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
 * Draggable bottom sheet sized by snap height (not a full-height panel translated
 * down). The body is a flex child with min-height:0 + overflow-y:auto, so inner
 * scroll works immediately without waiting for a handle tug to remount layout.
 * Drag is limited to the grab/header area.
 */
export function MobileSheet({ open, title, subtitle, onClose, onBack, children, footer, initialSnap = 1, snapPoints = DEFAULT_SNAPS, level = 0 }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ y: number; height: number } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const heightRef = useRef<number | null>(null);
  const [snap, setSnap] = useState(initialSnap);
  const [dragging, setDragging] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const snapHeights = () => {
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const ceiling = viewport * 0.94;
    const heights = snapPoints.map(fraction => Math.max(120, Math.min(ceiling, viewport * fraction)));
    return { heights, maxHeight: Math.max(120, ...heights), minHeight: Math.min(...heights), viewport };
  };

  useLayoutEffect(() => {
    if (!open) return;
    setSnap(initialSnap);
    const { heights } = snapHeights();
    const next = heights[initialSnap] ?? heights[0] ?? 0;
    setHeight(next);
    heightRef.current = next;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (panelRef.current && active instanceof HTMLElement && panelRef.current.contains(active)) return;
      panelRef.current?.focus({ preventScroll: true });
    }, 30);
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
      const { heights } = snapHeights();
      const next = heights[snap] ?? heights[0] ?? 0;
      setHeight(next);
      heightRef.current = next;
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
    const { heights } = snapHeights();
    const current = heightRef.current ?? height ?? heights[snap] ?? 0;
    startRef.current = { y: event.clientY, height: current };
    setDragging(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: React.PointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    const { heights, maxHeight } = snapHeights();
    // Finger down collapses the sheet (smaller height).
    const floor = Math.max(72, heights[0] * 0.55);
    const next = Math.min(maxHeight, Math.max(floor, start.height - (event.clientY - start.y)));
    setHeight(next);
    heightRef.current = next;
    let nearest = 0;
    heights.forEach((value, index) => {
      if (Math.abs(value - next) < Math.abs(heights[nearest] - next)) nearest = index;
    });
    setSnap(nearest);
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!startRef.current) return;
    startRef.current = null;
    setDragging(false);
    const { heights } = snapHeights();
    const current = heightRef.current ?? height ?? 0;
    let nearest = 0;
    heights.forEach((value, index) => {
      if (Math.abs(value - current) < Math.abs(heights[nearest] - current)) nearest = index;
    });
    // Dismiss when dragged well below the lowest snap.
    if (current < heights[0] * 0.7) {
      onCloseRef.current();
      try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* already released */ }
      return;
    }
    setSnap(nearest);
    setHeight(heights[nearest]);
    heightRef.current = heights[nearest];
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  const z = 130 + level * 8;

  return (
    <div className="m-sheet-root" style={{ zIndex: z }} role="dialog" aria-modal="true" aria-label={title}>
      <div className="m-sheet-backdrop" onClick={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        className={"m-sheet" + (dragging ? " is-dragging" : "")}
        style={{
          ["--m-sheet-h" as string]: height === null ? undefined : `${height}px`,
          visibility: height === null ? "hidden" : "visible",
        }}
        tabIndex={-1}
      >
        <div className="m-sheet-grab" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <span className="m-sheet-handle" aria-hidden="true" />
          <div className="m-sheet-head">
            {onBack && <button type="button" className="m-sheet-back" aria-label="返回上一级" onPointerDown={event => event.stopPropagation()} onClick={onBack}>
              <ChevronLeft size={20} />
            </button>}
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
