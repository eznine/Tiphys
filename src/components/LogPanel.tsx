import { useCallback, useEffect, useMemo, useState } from "react";
import { agentRequest } from "../lib/service";

type Entry = { id: string; ts: number; source: string; kind: string; level: string; summary: string; detail: unknown };
type LogData = { entries: Entry[]; diagnostics: Record<string, any> };
export function LogPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<LogData>({ entries: [], diagnostics: {} });
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [tab, setTab] = useState<"events" | "diagnostics">("events");
  const [copyStatus, setCopyStatus] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await (await agentRequest("/logs?session=default", { signal })).json();
      if (!signal?.aborted) { setData(result); setError(""); }
    } catch (err) { if (!signal?.aborted) setError(String(err)); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => { await load(controller.signal); if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000); };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load]);
  const filtered = useMemo(() => data.entries.filter(entry => (!level || entry.level === level) && (!source || entry.source === source)
    && (!query || JSON.stringify(entry).toLocaleLowerCase().includes(query.toLocaleLowerCase()))).reverse(), [data.entries, level, source, query]);
  const displayed = tab === "diagnostics" ? data.diagnostics : selected ?? filtered;
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(displayed, null, 2)); setCopyStatus("已复制"); }
    catch { setCopyStatus("复制失败，请使用导出"); }
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: filtered, diagnostics: data.diagnostics }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `TIPHYS-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="log-panel" aria-label="运行日志">
    <header className="attribute-header"><strong>运行日志</strong><div className="log-header-actions">
      <button type="button" className="icon-btn" onClick={() => void load()}>刷新</button>
      <button type="button" className="icon-btn" onClick={() => void copy()}>复制</button>
      <button type="button" className="icon-btn" onClick={download}>导出日志</button>
      <button type="button" className="icon-btn" aria-label="关闭日志" onClick={onClose}>×</button>
    </div></header>
    <div className="log-toolbar"><div className="property-tabs" role="tablist" aria-label="日志页签">
      <button type="button" role="tab" aria-selected={tab === "events"} onClick={() => setTab("events")}>操作记录</button>
      <button type="button" role="tab" aria-selected={tab === "diagnostics"} onClick={() => setTab("diagnostics")}>服务诊断</button></div>
      <span role="status">{copyStatus || error || `自动刷新 · ${filtered.length} 条记录`}</span>
    </div>
    {tab === "events" ? <>
      <div className="log-filters"><input type="search" aria-label="搜索日志" placeholder="搜索工具、参数、报错…" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="日志级别" value={level} onChange={e => setLevel(e.target.value)}><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告 / 审批</option><option value="info">信息</option></select>
        <select aria-label="日志来源" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option><option value="Agent">Agent</option><option value="Engine">空间引擎</option></select>
        {selected && <button type="button" className="icon-btn" onClick={() => setSelected(null)}>关闭详情</button>}
      </div>
      <div className="log-body"><div className="log-entries">
        {filtered.map(entry => <button key={entry.id} type="button" className="log-entry" data-level={entry.level} data-selected={selected?.id === entry.id} onClick={() => setSelected(entry)}>
          <time>{new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false })}</time><span className="log-level">{entry.level.toUpperCase()}</span>
          <span>{entry.source}</span><span className="log-summary">{entry.summary}</span></button>)}
        {!filtered.length && <p className="chat-notice">没有匹配的日志记录。</p>}
      </div>{selected && <pre className="log-detail">{JSON.stringify(selected.detail, null, 2)}</pre>}</div>
    </> : <pre className="log-detail log-diagnostics">{JSON.stringify(data.diagnostics, null, 2)}</pre>}
  </section>;
}
