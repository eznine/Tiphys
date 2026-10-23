import { useEffect, useState } from "react";
import { defaultLayerStyle, PALETTE, type DataLayer, type LayerStyle } from "../lib/dataLayers";
import { engineRequest } from "../lib/service";

type Tab = "style" | "labels" | "info";
export function LayerProperties({ layer, tab, onTab, onStyle, onClose }: {
  layer: DataLayer; tab: Tab; onTab: (tab: Tab) => void; onStyle: (style: LayerStyle) => void; onClose: () => void;
}) {
  const style = layer.style ?? defaultLayerStyle(layer.id);
  const [description, setDescription] = useState<{ columns: string[]; [key: string]: any } | null>(null);
  const [error, setError] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [uniqueCount, setUniqueCount] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDescription(null); setError("");
    void engineRequest(`/layers/${layer.id}/describe`, { signal: controller.signal }).then(r => r.json())
      .then(data => { if (!controller.signal.aborted) setDescription(data); })
      .catch(err => { if (!controller.signal.aborted) setError(String(err)); });
    return () => controller.abort();
  }, [layer.id]);
  const change = (patch: Partial<LayerStyle>) => onStyle({ ...style, ...patch });
  const classify = async (field: string) => {
    if (!field) { change({ categoryField: undefined, categories: undefined }); setUniqueCount(null); return; }
    setClassifying(true); setError("");
    try {
      const result = await (await engineRequest(`/layers/${layer.id}/field-values?${new URLSearchParams({ field, limit: "20" })}`)).json();
      onStyle({ ...style, categoryField: field, categories: result.values.map((v: { value: string | number | boolean | null }, i: number) => ({ value: v.value, color: PALETTE[i % PALETTE.length] })) });
      setUniqueCount(result.unique_count);
    } catch (err) { setError(String(err)); }
    finally { setClassifying(false); }
  };
  return <aside className="layer-properties" aria-label="图层设置">
    <header className="attribute-header"><strong title={layer.name}>{layer.name}</strong><button type="button" className="icon-btn" aria-label="关闭图层设置" onClick={onClose}>×</button></header>
    <div className="property-tabs" role="tablist" aria-label="图层设置页签">
      {([["style", "符号化"], ["labels", "标注"], ["info", "属性"]] as const).map(([value, label]) =>
        <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => onTab(value)}>{label}</button>)}
    </div>
    <div className="property-content">
      {error && <p role="alert" className="chat-notice">{error}</p>}
      {tab === "style" && <>
        <label className="tool-field"><span>符号方式</span><select aria-label="符号方式" disabled={classifying} value={style.categoryField ?? ""} onChange={e => void classify(e.target.value)}>
          <option value="">单一符号</option>{description?.columns.map(c => <option key={c} value={c}>唯一值 · {c}</option>)}
        </select></label>
        <label className="tool-field"><span>{style.categoryField ? "其他值颜色" : "符号颜色"}</span><input aria-label="符号颜色" type="color" value={style.color} onChange={e => change({ color: e.target.value })} /></label>
        <label className="tool-field"><span>不透明度 · {Math.round(style.opacity * 100)}%</span><input aria-label="不透明度" type="range" min="0" max="1" step=".05" value={style.opacity} onChange={e => change({ opacity: Number(e.target.value) })} /></label>
        {layer.geometry_types.some(t => t.includes("Point")) && <label className="tool-field"><span>点半径（像素）</span><input aria-label="点半径" type="number" min="1" max="30" value={style.pointSize} onChange={e => change({ pointSize: Math.max(1, Math.min(30, Number(e.target.value))) })} /></label>}
        {layer.geometry_types.some(t => t.includes("Line") || t.includes("Polygon")) && <label className="tool-field"><span>线宽（像素）</span><input aria-label="线宽" type="number" min=".1" max="20" step=".1" value={style.lineWidth} onChange={e => change({ lineWidth: Math.max(.1, Math.min(20, Number(e.target.value))) })} /></label>}
        {!!style.categories?.length && <div className="category-legend" aria-label="唯一值图例">{style.categories.map((item, i) => <label key={i}>
          <input type="color" aria-label={`${item.value ?? "空值"} 颜色`} value={item.color} onChange={e => change({ categories: style.categories!.map((v, idx) => idx === i ? { ...v, color: e.target.value } : v) })} />
          <span>{item.value === null ? "<空值>" : String(item.value)}</span></label>)}
          {(uniqueCount ?? style.categories.length) > 20 && <p>显示前 20 个值，其余使用“其他值颜色”。</p>}
        </div>}
        <button type="button" className="icon-btn" onClick={() => { onStyle(defaultLayerStyle(layer.id)); setUniqueCount(null); }}>恢复默认样式</button>
      </>}
      {tab === "labels" && <>
        <label className="tool-field"><span>标注字段</span><select aria-label="标注字段" value={style.labelField ?? ""} onChange={e => change({ labelField: e.target.value || undefined })}>
          <option value="">关闭标注</option>{description?.columns.map(c => <option key={c} value={c}>{c}</option>)}
        </select></label>
        <label className="tool-field"><span>文字大小（像素）</span><input type="number" aria-label="标注文字大小" min="8" max="36" value={style.labelSize} onChange={e => change({ labelSize: Math.max(8, Math.min(36, Number(e.target.value))) })} /></label>
        <label className="tool-field"><span>文字颜色</span><input aria-label="标注文字颜色" type="color" value={style.labelColor} onChange={e => change({ labelColor: e.target.value })} /></label>
        <p className="tool-desc">按字段显示文字，自动避让重叠；隐藏图层时同步隐藏标注。</p>
      </>}
      {tab === "info" && <dl className="layer-info">
        <dt>名称</dt><dd>{layer.name}</dd><dt>要素数</dt><dd>{layer.feature_count}</dd>
        <dt>几何类型</dt><dd>{layer.geometry_types.join("、") || "空图层"}</dd><dt>坐标系</dt><dd>{layer.crs}</dd>
        <dt>图层 ID</dt><dd>{layer.id}</dd><dt>分析数据</dt><dd>{description?.path ?? "读取中…"}</dd>
        <dt>字段</dt><dd>{description?.columns.join("、") || "无属性字段"}</dd>
      </dl>}
      <p className="property-note">显示设置自动保存，不改变分析数据。</p>
    </div>
  </aside>;
}
