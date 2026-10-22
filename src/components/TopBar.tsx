type Props = {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  engineLabel: string;
  engineState: "ok" | "error" | "pending";
};

export function TopBar({ theme, onToggleTheme, engineLabel, engineState }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="topbar-mark" aria-hidden />
        <div>
          <div className="topbar-title">TIPHYS</div>
          <div className="topbar-subtitle">From Intent to Outcome · M0 shell</div>
        </div>
      </div>
      <div className="topbar-actions">
        <span className="map-hud-chip" style={{ pointerEvents: "none" }}>
          <span className="status-dot" data-state={engineState} />
          <span>engine</span>
          <code>{engineLabel}</code>
        </span>
        <button
          type="button"
          className="icon-btn"
          data-active={theme === "dark"}
          onClick={onToggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </div>
    </header>
  );
}
