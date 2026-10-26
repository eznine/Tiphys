import { useState, type ReactNode } from "react";
import { Bot, Database, FolderOpen, Globe2, Link2, LocateFixed, Map as MapIcon, MapPinned, Satellite, Search, Sparkles, X } from "lucide-react";
import { MobileSheet } from "../mobile/MobileSheet";
import * as eco from "../lib/ecosystem";

type Props = {
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  /** Open the system file picker (phone files / share / cloud drives). */
  onPickFiles: () => void;
  /** Hand ready-made files (GeoJSON etc.) to the normal importer; resolves with the number of layers added. */
  onImport: (files: File[], extra?: { styles?: Record<string, string>; notes?: string[] }) => Promise<number>;
  /** Pre-fill the Agent with a natural-language request. */
  onAskAgent?: (text: string) => void;
};

const STARTED_KEY = "tiphys-onboarded";
export function shouldAutoOpenGetStarted() { try { return !localStorage.getItem(STARTED_KEY); } catch { return false; } }
export function markGetStartedSeen() { try { localStorage.setItem(STARTED_KEY, String(Date.now())); } catch { /* ignore */ } }

type Status = { kind: "busy" | "ok" | "error"; text: string } | null;

/** “开始的方式” hub: one place to get data in, for people who have none on their phone. */
export function GetStartedSheet({ open, mobile, onClose, onPickFiles, onImport, onAskAgent }: Props) {
  const [status, setStatus] = useState<Status>(null);
  const [url, setUrl] = useState("");
  const [place, setPlace] = useState("");
  const busy = status?.kind === "busy";

  const run = async (label: string, work: () => Promise<string>, closeOnOk = true) => {
    if (busy) return;
    setStatus({ kind: "busy", text: `${label}…` });
    try {
      const text = await work();
      setStatus({ kind: "ok", text });
      markGetStartedSeen();
      if (closeOnOk) window.setTimeout(onClose, 650);
    } catch (err) { setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) }); }
  };
  const importExpanded = async (expanded: eco.Expanded) => {
    if (expanded.tiles.length) eco.useCustomBasemap(expanded.tiles[expanded.tiles.length - 1]);
    const added = expanded.files.length ? await onImport(expanded.files, { styles: expanded.styles, notes: expanded.notes }) : 0;
    if (!added && !expanded.tiles.length) throw new Error(expanded.notes.join("；") || "没有导入任何数据。");
    return [added ? `已添加 ${added} 个图层` : "", expanded.tiles.length ? `底图：${expanded.tiles[expanded.tiles.length - 1].label}` : "", ...expanded.notes].filter(Boolean).join(" · ");
  };
  const sampleProject = () => run("正在载入示例工程", async () => {
    const files = await Promise.all(eco.SAMPLE_PROJECT.datasets.map(id => eco.loadSampleFile(id)));
    const n = await onImport(files);
    return `示例工程已载入 ${n} 个图层。试试问 Agent：“统计每个大洲的国家数量”`;
  });
  const nearby = () => run("正在定位", async () => {
    const me = await eco.locateMe();
    eco.requestFlyTo(me.lng, me.lat, 15);
    setStatus({ kind: "busy", text: "已定位，正在下载附近的行政边界、道路和兴趣点…" });
    const bbox = eco.bboxAround(me.lng, me.lat, 1.2);
    const files: File[] = []; const notes: string[] = [];
    const tasks = await Promise.allSettled([eco.fetchBoundaryAt(me.lng, me.lat, "district"), eco.fetchOsm("roads", bbox, undefined, { timeoutMs: 20000 }), eco.fetchOsm("poi", bbox, undefined, { timeoutMs: 20000 })]);
    for (const t of tasks) {
      if (t.status === "fulfilled") { if (!("count" in t.value) || t.value.count) files.push(t.value.file); }
      else notes.push(t.reason instanceof Error ? t.reason.message : String(t.reason));
    }
    const pos = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: { name: "我的位置", accuracy_m: Math.round(me.accuracy), time: new Date().toISOString() }, geometry: { type: "Point" as const, coordinates: [me.lng, me.lat] } }] };
    files.push(new File([JSON.stringify(pos)], "我的位置.geojson", { type: "application/geo+json" }));
    const n = await onImport(files, { notes });
    return `已加载附近数据 ${n} 个图层（© OpenStreetMap 贡献者）${notes.length ? ` · ${notes.join("；")}` : ""}`;
  });
  const importUrl = (value = url) => run("正在读取链接", async () => importExpanded(await eco.expandUrl(value, { bbox: null })));
  const osm = (category: eco.OsmCategory, label: string) => run(`正在下载当前视图的${label}`, async () => {
    const view = eco.getCurrentBounds();
    if (!view) throw new Error("地图还没准备好，稍后再试。");
    const { bbox, shrunk } = eco.fitViewBbox(category, view);
    if (shrunk) { eco.requestFlyTo((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, category === "buildings" ? 15 : 13); setStatus({ kind: "busy", text: `当前范围较大，改为下载地图中心附近的${label}…` }); }
    const r = await eco.fetchOsm(category, bbox);
    if (!r.count) throw new Error(`当前视图内没有「${label}」数据，换个地方或缩小地图试试。`);
    const n = await onImport([r.file]);
    return `已添加「${label}」${r.count} 个要素${n > 1 ? `（${n} 个图层）` : ""}${r.source === "tiles" ? "（Overpass 繁忙，已从底图矢量切片提取）" : ""} · © OpenStreetMap`;
  });
  const boundary = () => run("正在查找行政边界", async () => {
    const q = place.trim();
    let file: File, name: string;
    if (q) ({ file, name } = await eco.fetchBoundary(q));
    else { const c = eco.getCurrentCenter(); if (!c) throw new Error("请输入地名"); ({ file, name } = await eco.fetchBoundaryAt(c.lng, c.lat, "district")); }
    await onImport([file]);
    return `已添加边界「${name}」· © OpenStreetMap`;
  });
  const basemap = (id: string, label: string) => run(`切换到${label}`, async () => {
    const online = eco.ONLINE_TILES.find(t => t.id === id);
    if (online) eco.useCustomBasemap({ label: online.label, tiles: online.tiles, attribution: online.attribution }); else eco.switchBasemap(id);
    return `底图：${label}`;
  }, false);
  const sample = (id: string, label: string) => run(`正在载入${label}`, async () => { await onImport([await eco.loadSampleFile(id)]); return `已添加「${label}」`; });

  const body: ReactNode = <div className="gs-body">
    {!mobile && <header className="gs-head"><div><strong>开始使用 TIPHYS</strong><span>手机里没有 GIS 数据也能马上开始</span></div><button type="button" className="gs-x" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>}
    <div className="gs-quick">
      <button type="button" disabled={busy} onClick={sampleProject} style={{ animationDelay: "0ms" }}><Sparkles size={22} /><strong>试用示例工程</strong><span>世界国家·河流·城市 + 北京点位</span></button>
      <button type="button" disabled={busy} onClick={nearby} style={{ animationDelay: "40ms" }}><LocateFixed size={22} /><strong>定位并加载附近数据</strong><span>区县边界 · 道路 · POI</span></button>
      <button type="button" disabled={busy} onClick={() => { markGetStartedSeen(); onPickFiles(); onClose(); }} style={{ animationDelay: "80ms" }}><FolderOpen size={22} /><strong>导入文件</strong><span>SHP · GDB · APRX · KML · GPKG…</span></button>
      <button type="button" disabled={busy} onClick={() => document.getElementById("gs-url")?.focus()} style={{ animationDelay: "120ms" }}><Link2 size={22} /><strong>粘贴服务链接</strong><span>ArcGIS · WMS · XYZ · GeoJSON</span></button>
    </div>
    {status && <div className={`gs-status gs-${status.kind}`} role="status">{status.kind === "busy" && <span className="gs-spin" aria-hidden />}{status.text}</div>}

    <section className="gs-sec">
      <h4><Link2 size={14} />粘贴链接导入</h4>
      <form className="gs-row" onSubmit={e => { e.preventDefault(); if (url.trim()) void importUrl(); }}>
        <input id="gs-url" type="url" inputMode="url" placeholder="https://…/FeatureServer/0 或 ArcGIS Online 链接" value={url} onChange={e => setUrl(e.target.value)} />
        <button type="submit" className="gs-go" disabled={busy || !url.trim()}>导入</button>
      </form>
      <div className="gs-chips">{eco.ARCGIS_EXAMPLES.map(x => <button key={x.url} type="button" disabled={busy} onClick={() => { setUrl(x.url); void importUrl(x.url); }}>{x.label}</button>)}</div>
    </section>

    <section className="gs-sec">
      <h4><Globe2 size={14} />在线开放数据 · 当前地图范围</h4>
      <div className="gs-chips">{eco.OSM_CATEGORIES.map(c => <button key={c.id} type="button" disabled={busy} title={c.hint} onClick={() => void osm(c.id, c.label)}>{c.label}</button>)}</div>
      <form className="gs-row" onSubmit={e => { e.preventDefault(); void boundary(); }}>
        <input type="search" placeholder="行政区边界，例如 杭州市西湖区（留空=当前区县）" value={place} onChange={e => setPlace(e.target.value)} />
        <button type="submit" className="gs-go" disabled={busy}><Search size={15} /></button>
      </form>
    </section>

    <section className="gs-sec">
      <h4><Satellite size={14} />底图与影像（免费、无需密钥）</h4>
      <div className="gs-chips">
        {[["satellite", "Esri 卫星"], ["opentopo", "地形图"], ["hillshade", "地形晕渲"], ["liberty", "街道"]].map(([id, label]) => <button key={id} type="button" disabled={busy} onClick={() => void basemap(id, label)}>{label}</button>)}
        {eco.ONLINE_TILES.map(t => <button key={t.id} type="button" disabled={busy} title={t.hint} onClick={() => void basemap(t.id, t.label)}>{t.label}</button>)}
      </div>
    </section>

    <section className="gs-sec">
      <h4><Database size={14} />内置示例数据</h4>
      <div className="gs-list">{eco.SAMPLE_DATASETS.map(d => <button key={d.id} type="button" disabled={busy} onClick={() => void sample(d.id, d.label)}><MapIcon size={16} /><span><strong>{d.label}</strong><small>{d.hint} · {d.license}</small></span></button>)}</div>
    </section>

    <section className="gs-sec gs-guide">
      <h4><MapPinned size={14} />ArcGIS 工程怎么进来</h4>
      <ul>
        <li><b>.aprx / .mapx / .lyrx</b>：读取图层清单、数据源和符号颜色；在线服务图层自动下载。</li>
        <li><b>.ppkx / .mpkx 工程/地图包</b>：在 ArcGIS Pro「共享 → 打包工程/地图」后直接导入，里面的 .gdb 自动读取。</li>
        <li><b>文件地理数据库 .gdb</b>：把 .gdb 文件夹压缩成 .zip 导入（首次需联网下载 GDAL 组件约 40 MB）。</li>
        <li><b>ArcGIS Online / Portal</b>：把公开图层或 Web 地图链接粘贴到上面。</li>
        <li><b>.mxd</b>：只能识别其引用的数据路径，建议在 Pro 中打包为 .mpkx。</li>
      </ul>
    </section>

    {onAskAgent && <button type="button" className="gs-agent" onClick={() => { markGetStartedSeen(); onClose(); onAskAgent("下载当前地图范围内的道路和公园绿地，并统计数量"); }}>
      <Bot size={18} /><span><strong>直接告诉 Agent</strong><small>例如：“下载杭州西湖区的道路和公园”“加载示例工程”“导入这个 FeatureServer 链接”</small></span>
    </button>}
  </div>;

  if (mobile) return <MobileSheet open={open} title="开始的方式" subtitle="没有数据也能马上开始 · 拖动调整高度" initialSnap={0} snapPoints={[0.7, 0.94]} onClose={onClose}>{body}</MobileSheet>;
  if (!open) return null;
  return <div className="gs-overlay" role="dialog" aria-modal="true" aria-label="开始的方式" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="gs-modal">{body}</div>
  </div>;
}
