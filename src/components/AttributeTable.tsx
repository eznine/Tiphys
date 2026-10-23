import { useEffect, useRef, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { engineRequest } from "../lib/service";
import { tableExportFilename, tablePageCsv } from "../lib/table-export";

type Row = { id: number; attributes: Record<string, unknown>; bounds: number[] | null };
type Page = { fields: { name: string; type: string }[]; rows: Row[]; total: number };

export function AttributeTable({ layer, selectedIds, onSelectionChange, onClearSelection, onClose, onZoom }: {
  layer: DataLayer; selectedIds: number[]; onSelectionChange: (ids: number[], additive: boolean) => void;
  onClearSelection: () => void; onClose: () => void; onZoom: (bounds: number[]) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("");
  const [descending, setDescending] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [statsField, setStatsField] = useState("");
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  const [statsError, setStatsError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const anchorRef = useRef<number | null>(null);
  const selectionKey = selectedIds.join(",");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
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
  useEffect(() => {
    if (!selectedIds.length || search || sort) return;
    const first = selectedIds[0];
    if (first < offset || first >= offset + 100) setOffset(Math.floor(first / 100) * 100);
  }, [selectionKey, search, sort, offset, selectedIds]);
  useEffect(() => {
    if (!selectedIds.length || !page) return;
    const row = page.rows.find(item => selectedIds.includes(item.id));
    rowRefs.current.get(row?.id ?? -1)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [page, selectionKey, selectedIds]);
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
  const selectedSet = new Set(selectedIds);
  const selectedRow = page?.rows.find(row => selectedSet.has(row.id));
  const selectRow = (rowId: number, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (event.shiftKey && anchorRef.current != null && page) {
      const ordered = page.rows.map(row => row.id);
      const from = ordered.indexOf(anchorRef.current), to = ordered.indexOf(rowId);
      if (from >= 0 && to >= 0) {
        const merged = new Set(selectedIds);
        for (const id of ordered.slice(Math.min(from, to), Math.max(from, to) + 1)) merged.add(id);
        onSelectionChange([...merged].sort((a, b) => a - b), false);
        return;
      }
    }
    anchorRef.current = rowId;
    onSelectionChange([rowId], event.shiftKey || event.metaKey || event.ctrlKey);
  };
  const downloadPage = () => {
    if (!page?.rows.length) return;
    const blob = new Blob(["\uFEFF", tablePageCsv(page)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = tableExportFilename(layer.name);
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
    setActionNotice(`已导出本页 ${page.rows.length} 条记录`);
  };
  const copySelectedIds = async () => {
    if (!selectedIds.length) return;
    const text = selectedIds.join(",");
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement("textarea");
        input.value = text; input.style.position = "fixed"; input.style.opacity = "0";
        document.body.append(input); input.select(); document.execCommand("copy"); input.remove();
      }
      setActionNotice(`已复制 ${selectedIds.length} 个要素 ID`);
    } catch { setActionNotice("复制失败，请检查浏览器剪贴板权限"); }
  };
  return <section className="attribute-table" aria-label={`${layer.name} 属性表`}>
    <header className="attribute-header"><strong>{layer.name} · 属性表</strong>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭属性表">×</button></header>
    <div className="attribute-toolbar">
      <input type="search" aria-label="搜索属性" placeholder="搜索属性…" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} />
      <button type="button" className="icon-btn" disabled={!selectedRow?.bounds} onClick={() => selectedRow?.bounds && onZoom(selectedRow.bounds)}>缩放至所选记录</button>
      {selectedIds.length > 0 && <button type="button" className="icon-btn" onClick={onClearSelection}>清除选择</button>}
      <select aria-label="字段统计选择" value={statsField} onChange={e => void loadStats(e.target.value)}>
        <option value="">字段统计…</option>
        {page?.fields.map(field => <option key={field.name} value={field.name}>{field.name}</option>)}
      </select>
      <span>{loading ? "读取中…" : `${page?.total ?? 0} 条记录${selectedIds.length ? ` · 已选 ${selectedIds.length}` : ""}`}</span>
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
      <table><thead><tr><th className="attribute-select-cell"><span className="sr-only">选择</span></th><th>记录</th>{page?.fields.map(field => <th key={field.name} aria-sort={sort === field.name ? descending ? "descending" : "ascending" : "none"}>
        <button type="button" title={`${field.name} · ${field.type}`} onClick={() => { setSort(field.name); setDescending(sort === field.name ? !descending : false); setOffset(0); }}>{field.name} {sort === field.name ? descending ? "↓" : "↑" : ""}</button>
      </th>)}</tr></thead>
      <tbody>{page?.rows.map(row => <tr key={row.id} ref={element => { if (element) rowRefs.current.set(row.id, element); else rowRefs.current.delete(row.id); }}
        data-selected={selectedSet.has(row.id)} aria-selected={selectedSet.has(row.id)} onClick={event => selectRow(row.id, event)} onDoubleClick={() => row.bounds && onZoom(row.bounds)}>
        <td className="attribute-select-cell"><input type="checkbox" aria-label={`选择第 ${row.id + 1} 条记录`} checked={selectedSet.has(row.id)}
          onChange={() => { anchorRef.current = row.id; onSelectionChange([row.id], true); }} onClick={event => event.stopPropagation()} /></td>
        <td>{row.id + 1}</td>{page.fields.map(field => <td key={field.name} title={format(row.attributes[field.name])}>{format(row.attributes[field.name])}</td>)}
      </tr>)}</tbody></table>
      {!loading && !page?.rows.length && <p className="chat-notice">没有匹配的记录。</p>}
    </div>
    <footer className="attribute-footer"><div className="attribute-footer-meta"><span>只读 · 双击记录定位 · Shift 连选</span>{actionNotice && <span role="status">{actionNotice}</span>}</div>
      <div className="attribute-actions"><button type="button" className="icon-btn" disabled={!selectedIds.length || loading} onClick={() => void copySelectedIds()}>复制已选 ID</button>
        <button type="button" className="icon-btn" title="导出当前可见页的属性 CSV（不含几何）" disabled={!page?.rows.length || loading} onClick={downloadPage}>导出本页属性 CSV</button></div>
      <div>
      <button type="button" className="icon-btn" disabled={offset === 0 || loading} onClick={() => setOffset(offset - 100)}>上一页</button>
      <span>{Math.floor(offset / 100) + 1} / {Math.max(1, Math.ceil((page?.total ?? 0) / 100))}</span>
      <button type="button" className="icon-btn" disabled={loading || offset + 100 >= (page?.total ?? 0)} onClick={() => setOffset(offset + 100)}>下一页</button>
    </div></footer>
  </section>;
}
