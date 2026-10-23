import { Settings2, Logs, Moon, Sun } from "lucide-react";
type Props = {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  engineLabel: string;
  engineState: "ok" | "error" | "pending";
  onLogs: () => void;
  onSettings: () => void;
};

export function TopBar({ theme, onToggleTheme, engineLabel, engineState, onLogs, onSettings }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="topbar-mark" aria-hidden />
        <div>
          <div className="topbar-title">TIPHYS</div>
          <div className="topbar-subtitle">地理空间智能工作区</div>
        </div>
      </div>
      <div className="workspace-title">本地工作区</div>
      <div className="topbar-actions">
        <button type="button" className="plain-icon" aria-label="运行日志" title="运行日志" onClick={onLogs}><Logs size={17} /></button>
        <button type="button" className="plain-icon" aria-label="设置" title="设置" onClick={onSettings}><Settings2 size={17} /></button>
        <span className="map-hud-chip" style={{ pointerEvents: "none" }}>
          <span className="status-dot" data-state={engineState} />
          <span>引擎</span>
          <code>{engineLabel}</code>
        </span>
        <button
          type="button"
          className="icon-btn"
          data-active={theme === "dark"}
          onClick={onToggleTheme}
          aria-label="切换主题"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}
