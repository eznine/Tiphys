import { useLayoutEffect, useRef } from "react";
import { FolderKanban, ListChecks, Map, MessageSquareText } from "lucide-react";

export type MobileTab = "chat" | "map" | "tasks" | "project";

export const MOBILE_TAB_ORDER: MobileTab[] = ["chat", "map", "tasks", "project"];

const TABS: { id: MobileTab; label: string; Icon: typeof Map }[] = [
  { id: "chat", label: "对话", Icon: MessageSquareText },
  { id: "map", label: "地图", Icon: Map },
  { id: "tasks", label: "任务", Icon: ListChecks },
  { id: "project", label: "工程", Icon: FolderKanban },
];

/** Survives dock remounts (map/chat embedded vs tasks/project fixed) so skip jumps still animate. */
let lastDockIndex: number | null = null;

type Props = {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  running: number;
  pending: number;
  /** Rendered inside the bottom card, not fixed to the viewport. */
  embedded?: boolean;
};

/** Four-entry dock. Badges show real counts, not decoration. */
export function MobileDock({ active, onChange, running, pending, embedded = false }: Props) {
  const index = Math.max(0, MOBILE_TAB_ORDER.indexOf(active));
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const bubble = nav.querySelector(".m-dock-bubble") as HTMLElement | null;
    const from = lastDockIndex;
    lastDockIndex = index;
    if (from == null || from === index || !bubble) {
      nav.style.setProperty("--dock-index", String(index));
      return;
    }
    // Mount (or jump) at previous index with transition off, then animate to target.
    bubble.style.transition = "none";
    nav.style.setProperty("--dock-index", String(from));
    void bubble.offsetWidth;
    bubble.style.transition = "";
    nav.style.setProperty("--dock-index", String(index));
  }, [index]);

  return (
    <nav
      ref={navRef}
      className={"m-dock" + (embedded ? " m-dock-embedded" : "")}
      aria-label="主要导航"
      data-dock-index={index}
    >
      <span className="m-dock-bubble" aria-hidden="true" />
      {TABS.map(({ id, label, Icon }) => {
        const badge = id === "tasks" ? running + pending : 0;
        return (
          <button key={id} type="button" className="m-dock-item" data-active={active === id} aria-current={active === id ? "page" : undefined} onClick={() => onChange(id)}>
            <span className="m-dock-icon">
              <Icon size={20} strokeWidth={active === id ? 2.1 : 1.7} />
              {badge > 0 && <span className="m-dock-badge" aria-label={`${badge} 个任务需要关注`}>{badge > 9 ? "9+" : badge}</span>}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
