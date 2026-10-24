import { FolderKanban, ListChecks, Map, MessageSquareText } from "lucide-react";

export type MobileTab = "chat" | "map" | "tasks" | "project";

const TABS: { id: MobileTab; label: string; Icon: typeof Map }[] = [
  { id: "chat", label: "对话", Icon: MessageSquareText },
  { id: "map", label: "地图", Icon: Map },
  { id: "tasks", label: "任务", Icon: ListChecks },
  { id: "project", label: "工程", Icon: FolderKanban },
];

type Props = {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  running: number;
  pending: number;
};

/** Floating four-entry dock. Badges show real counts, not decoration. */
export function MobileDock({ active, onChange, running, pending }: Props) {
  return (
    <nav className="m-dock" aria-label="主要导航">
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
