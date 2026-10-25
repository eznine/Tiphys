import { useEffect, useRef, useState } from "react";
import { Download, LayoutTemplate, X } from "lucide-react";
import {
  DEFAULT_MAP_LAYOUT_PREFERENCES,
  MAP_LAYOUT_PREFERENCES_KEY,
  MAP_LAYOUT_PRESETS,
  mapLayoutPreferences,
  parseMapLayoutPreferences,
  type MapLayoutOptions,
  type MapLayoutPresetId,
} from "../lib/map-export";

function loadMapLayoutPreferences(defaultSubtitle: string) {
  let serialized: string | null = null;
  try { serialized = localStorage.getItem(MAP_LAYOUT_PREFERENCES_KEY); } catch { serialized = null; }
  return parseMapLayoutPreferences(serialized, { ...DEFAULT_MAP_LAYOUT_PREFERENCES, subtitle: defaultSubtitle });
}

function persistMapLayoutPreferences(options: MapLayoutOptions) {
  try { localStorage.setItem(MAP_LAYOUT_PREFERENCES_KEY, JSON.stringify(mapLayoutPreferences(options))); } catch { return false; }
  return true;
}

export function MapLayoutDialog({ theme, defaultSubtitle, onExport, onClose }: {
  theme: "light" | "dark";
  defaultSubtitle: string;
  onExport: (options: MapLayoutOptions) => Promise<void>;
  onClose: () => void;
}) {
  const [initial] = useState(() => loadMapLayoutPreferences(defaultSubtitle));
  const [preset, setPreset] = useState<MapLayoutPresetId>(initial.preset);
  const [title, setTitle] = useState(initial.title);
  const [subtitle, setSubtitle] = useState(initial.subtitle);
  const [includeDate, setIncludeDate] = useState(initial.includeDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => { dialog.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const options: MapLayoutOptions = { preset, title, subtitle, includeDate, theme };
      await onExport(options);
      persistMapLayoutPreferences(options);
      setBusy(false);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return <div className="map-layout-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="map-layout-dialog" role="dialog" aria-modal="true" aria-labelledby="map-layout-title" tabIndex={-1} ref={dialog}
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) onClose();
        if (event.key !== "Tab") return;
        const elements = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)");
        if (!elements?.length) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="map-layout-header">
        <div><LayoutTemplate size={18} /><strong id="map-layout-title">地图布局</strong><span>PNG 布局稿</span></div>
        <button type="button" className="icon-btn" aria-label="关闭地图布局" onClick={onClose} disabled={busy}><X size={16} /></button>
      </header>
      <div className="map-layout-body">
        <div className="map-layout-intro">
          <strong>当前视图 + 标题页眉</strong>
          <p>生成 PNG 图片，不是 PDF。当前地图视图会完整放入页面；不添加比例尺、指北针或虚构的制图要素。</p>
        </div>
        <label className="map-layout-field"><span>标题</span>
          <input value={title} maxLength={80} onChange={event => setTitle(event.target.value)} aria-label="布局标题" />
        </label>
        <label className="map-layout-field"><span>副标题</span>
          <input value={subtitle} maxLength={120} onChange={event => setSubtitle(event.target.value)} aria-label="布局副标题" placeholder="可选" />
        </label>
        <fieldset className="map-layout-sizes">
          <legend>画幅</legend>
          <div>{MAP_LAYOUT_PRESETS.map(item => <button key={item.id} type="button" data-active={preset === item.id}
            aria-pressed={preset === item.id} onClick={() => setPreset(item.id)}>
            <strong>{item.label}</strong><small>{item.width} × {item.height} px</small>
          </button>)}</div>
        </fieldset>
        <label className="map-layout-check"><input type="checkbox" checked={includeDate} onChange={event => setIncludeDate(event.target.checked)} />在页脚显示导出日期</label>
        <div className="map-layout-contract" role="note">输出合同：PNG 位图 · 当前视图完整适配 · 页脚明确标注「非 PDF」。</div>
        {error && <div className="settings-feedback error" role="alert">{error}</div>}
      </div>
      <footer className="map-layout-footer">
        <span>布局只保存地图画面，不导出图层文件或统计数据。</span>
        <div>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="primary-btn" onClick={() => void submit()} disabled={busy}>
            <Download size={15} />{busy ? "正在等待地图渲染…" : "导出布局 PNG"}
          </button>
        </div>
      </footer>
    </div>
  </div>;
}
