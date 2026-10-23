import { useEffect, useMemo, useState } from "react";
import { TopBar } from "./components/TopBar";
import { ChatDock } from "./components/ChatDock";
import { MapCanvas } from "./components/MapCanvas";
import { LayerRail } from "./components/LayerRail";
import { engineBaseUrl, pingEngine, PingResult } from "./lib/engine";
import { useAgent } from "./lib/agent";
import "./styles/app.css";

function loadTheme(): "light" | "dark" {
  const saved = localStorage.getItem("tiphys-theme");
  return saved === "light" || saved === "dark" ? saved : "dark";
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(loadTheme);
  const [ping, setPing] = useState<PingResult>({ state: "pending" });
  const agent = useAgent("default");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("tiphys-theme", theme);
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    const check = () => void pingEngine(undefined, controller.signal).then(result => { if (!controller.signal.aborted) setPing(result); });
    check();
    const timer = window.setInterval(check, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  const engineLabel = useMemo(() => {
    if (ping.state === "ok") return `${ping.data.service} · ${ping.latencyMs}ms`;
    if (ping.state === "error") return "unreachable";
    return "…";
  }, [ping]);
  const engineState = ping.state === "ok" ? "ok" : ping.state === "error" ? "error" : "pending";

  return (
    <div className="app-shell">
      <TopBar
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        engineLabel={engineLabel}
        engineState={engineState}
      />
      <div className="workspace">
        <LayerRail layers={agent.state.layers} onToggle={agent.toggleLayer} />
        <main className="map-pane" aria-label="Map">
          <MapCanvas theme={theme} dataLayers={agent.state.layers} focusBounds={agent.state.focus} />
          <div className="map-hud">
            <div className="map-hud-chip">
              <span className="status-dot" data-state={engineState} />
              <code>{engineBaseUrl()}</code>
            </div>
          </div>
        </main>
        <ChatDock
          items={agent.state.items}
          busy={agent.state.busy}
          connected={agent.state.connected}
          provider={agent.state.provider}
          onSend={agent.send}
          onApprove={agent.approve}
          onCancelJob={agent.cancelJob}
          onCancelTurn={agent.cancelTurn}
        />
      </div>
    </div>
  );
}
