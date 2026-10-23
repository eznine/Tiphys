import { useEffect, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { engineRequest } from "../lib/service";

type Row = { id: number; attributes: Record<string, unknown>; bounds: number[] | null };
type Page = { fields: { name: string; type: string }[]; rows: Row[]; total: number };

export function AttributeTable({ layer, onClose, onZoom }: { layer: DataLayer; onClose: () => void; onZoom: (bounds: number[]) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("");
  const [descending, setDescending] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [statsField, setStatsField] = useState("");
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  const [statsError, setStatsError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setSelected(null);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ offset: String(offset), limit: "100", search, descending: String(descending) });
      if (sort) params.set("sort", sort);
      void engineRequest(`/layers/${layer.id}/attributes?${params}`, { signal: controller.signal })
        .then(r => r.json()).then(data => { if (!controller.signal.aborted) setPage(data); })
        .catch(err => { if (!controller.signal.aborted) setError(String(err)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [layer.id, offset, search, sort, descending]);
  const format = (value: unknown) => value === null ? "<空值>" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const loadStats = async (field: string) => {
    setStatsField(field); setStats(null); setStatsError("");
    if (!field) return;
    try {
      const result = await (await engineRequest("/tools/run", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "field_statistics", arguments: { layer: layer.id, field } }) })).json();
      setStats(result);
    } catch (err) { setStatsError(String(err)); }
  };
  const STAT_LABELS: [string, string][] = [["count", "非空计数"], ["null_count", "空值数"], ["unique_count", "唯一值数"], ["min", "最小值"], ["max", "最大值"], ["mean", "均值"], ["median", "中位数"], ["std", "标准差"]];
  const number = (value: unknown) => typeof value === "number" ? (Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0) ? value.toExponential(4) : String(Math.round(value * 1e6) / 1e6)) : String(value ?? "—");
  return <section className="attribute-table" aria-label={`${layer.name} 属性表`}>
    <header className="attribute-header"><strong>{layer.name} · 属性表</strong>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭属性表">×</button></header>
    <div className="attribute-toolbar">
      <input type="search" aria-label="搜索属性" placeholder="搜索属性…" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} />
      <button type="button" className="icon-btn" disabled={!selected?.bounds} onClick={() => selected?.bounds && onZoom(selected.bounds)}>缩放至所选记录</button>
      <select aria-label="字段统计选择" value={statsField} onChange={e => void loadStats(e.target.value)}>
        <option value="">字段统计…</option>
        {page?.fields.map(field => <option key={field.name} value={field.name}>{field.name}</option>)}
      </select>
      <span>{loading ? "读取中…" : `${page?.total ?? 0} 条记录`}</span>
    </div>
    {statsError && <p role="alert" className="chat-notice">{statsError}</p>}
    {statsField && stats && <div className="field-stats" aria-label={`${statsField} 统计`}>
      <strong>{statsField}</strong>
      {STAT_LABELS.map(([key, label]) => stats[key] !== undefined && <span key={key}>{label} {number(stats[key])}</span>)}
      {Array.isArray(stats.top_values) && <span className="field-stats-top">{stats.top_values.map((item: { value: unknown; count: number }, index: number) =>
        <em key={index}>{String(item.value)}（{item.count}）</em>)}</span>}
      <button type="button" className="icon-btn" aria-label="关闭统计" onClick={() => { setStatsField(""); setStats(null); }}>×</button>
    </div>}
    {error && <p role="alert" className="chat-notice">{error}</p>}
    <div className="attribute-scroll" aria-busy={loading}>
      <table><thead><tr><th>记录</th>{page?.fields.map(field => <th key={field.name} aria-sort={sort === field.name ? descending ? "descending" : "ascending" : "none"}>
        <button type="button" title={`${field.name} · ${field.type}`} onClick={() => { setSort(field.name); setDescending(sort === field.name ? !descending : false); setOffset(0); }}>{field.name} {sort === field.name ? descending ? "↓" : "↑" : ""}</button>
      </th>)}</tr></thead>
      <tbody>{page?.rows.map(row => <tr key={row.id} data-selected={selected?.id === row.id} onClick={() => setSelected(row)} onDoubleClick={() => row.bounds && onZoom(row.bounds)}>
        <td>{row.id + 1}</td>{page.fields.map(field => <td key={field.name} title={format(row.attributes[field.name])}>{format(row.attributes[field.name])}</td>)}
      </tr>)}</tbody></table>
      {!loading && !page?.rows.length && <p className="chat-notice">没有匹配的记录。</p>}
    </div>
    <footer className="attribute-footer"><span>只读 · 双击记录定位</span><div>
      <button type="button" className="icon-btn" disabled={offset === 0 || loading} onClick={() => setOffset(offset - 100)}>上一页</button>
      <span>{Math.floor(offset / 100) + 1} / {Math.max(1, Math.ceil((page?.total ?? 0) / 100))}</span>
      <button type="button" className="icon-btn" disabled={loading || offset + 100 >= (page?.total ?? 0)} onClick={() => setOffset(offset + 100)}>下一页</button>
    </div></footer>
  </section>;
}
