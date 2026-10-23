import { useEffect, useState } from "react";
import { categoryColors, defaultLayerStyle, type DataLayer, type LayerStyle, type RasterStretch, type VectorRamp } from "../lib/dataLayers";
import { engineRequest } from "../lib/service";

type Tab = "style" | "labels" | "info";
export function LayerProperties({ layer, tab, onTab, onStyle, onClose }: {
  layer: DataLayer; tab: Tab; onTab: (tab: Tab) => void; onStyle: (style: LayerStyle) => void; onClose: () => void;
}) {
  const style = layer.style ?? defaultLayerStyle(layer.id, layer.name);
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
      const colors = categoryColors(result.values.length, style.ramp);
      onStyle({ ...style, categoryField: field, categories: result.values.map((v: { value: string | number | boolean | null }, i: number) => ({ value: v.value, color: colors[i] })) });
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
      {tab === "style" && layer.kind === "raster" && <>
        <label className="tool-field"><span>栅格不透明度 · {Math.round(style.opacity * 100)}%</span><input aria-label="栅格不透明度" type="range" min="0" max="1" step=".05" value={style.opacity} onChange={e => change({ opacity: Number(e.target.value) })} /></label>
        <label className="tool-field"><span>显示拉伸</span><select aria-label="栅格显示拉伸" value={style.rasterStretch ?? "auto"} onChange={e => change({ rasterStretch: e.target.value as RasterStretch })}>
          <option value="auto">自动 · 线性中性</option>
          <option value="soft">柔和 · 压低高光</option>
          <option value="high">强对比 · 突出范围</option>
        </select></label>
        <p className="tool-desc">拉伸只改变地图显示：{style.rasterStretch === "soft" ? "降低高光与饱和度" : style.rasterStretch === "high" ? "提高对比度并略微增强饱和度" : "使用渲染器生成的原始色带"}，不修改像元值。彩色预览色带由栅格渲染器生成；单波段数值不在本面板重算。</p>
        <button type="button" className="icon-btn" onClick={() => onStyle(defaultLayerStyle(layer.id, layer.name))}>恢复默认样式</button>
      </>}
      {tab === "style" && layer.kind === "table" && <p className="tool-desc">表格图层没有地图符号。可在属性表中查看和选择记录。</p>}
      {tab === "style" && (layer.kind ?? "vector") === "vector" && <>
        <label className="tool-field"><span>符号方式</span><select aria-label="符号方式" disabled={classifying} value={style.categoryField ?? ""} onChange={e => void classify(e.target.value)}>
          <option value="">单一符号</option>{description?.columns.map(c => <option key={c} value={c}>唯一值 · {c}</option>)}
        </select></label>
        <div className="property-color-row">
          <label className="tool-field"><span>{style.categoryField ? "其他值填充" : "填充 / 点颜色"}</span><input aria-label="符号颜色" type="color" value={style.color} onChange={e => change({ color: e.target.value })} /></label>
          <label className="tool-field"><span>描边 / 线颜色</span><input aria-label="描边颜色" type="color" value={style.strokeColor ?? style.color} onChange={e => change({ strokeColor: e.target.value })} /></label>
        </div>
        <label className="tool-field"><span>整体不透明度 · {Math.round(style.opacity * 100)}%</span><input aria-label="不透明度" type="range" min="0" max="1" step=".05" value={style.opacity} onChange={e => change({ opacity: Number(e.target.value) })} /></label>
        <div className="property-color-row">
          <label className="tool-field"><span>填充强度 · {Math.round((style.fillOpacity ?? .55) * 100)}%</span><input aria-label="填充不透明度" type="range" min="0" max="1" step=".05" value={style.fillOpacity ?? .55} onChange={e => change({ fillOpacity: Number(e.target.value) })} /></label>
          <label className="tool-field"><span>描边强度 · {Math.round((style.strokeOpacity ?? 1) * 100)}%</span><input aria-label="描边不透明度" type="range" min="0" max="1" step=".05" value={style.strokeOpacity ?? 1} onChange={e => change({ strokeOpacity: Number(e.target.value) })} /></label>
        </div>
        {layer.geometry_types.some(t => t.includes("Point")) && <label className="tool-field"><span>点半径（像素）</span><input aria-label="点半径" type="number" min="1" max="30" value={style.pointSize} onChange={e => change({ pointSize: Math.max(1, Math.min(30, Number(e.target.value))) })} /></label>}
        {layer.geometry_types.some(t => t.includes("Line") || t.includes("Polygon")) && <label className="tool-field"><span>线宽（像素）</span><input aria-label="线宽" type="number" min=".1" max="20" step=".1" value={style.lineWidth} onChange={e => change({ lineWidth: Math.max(.1, Math.min(20, Number(e.target.value))) })} /></label>}
        {!!style.categories?.length && <>
          <label className="tool-field"><span>分类色带</span><select aria-label="分类色带" value={style.ramp ?? "blue"} onChange={e => {
            const ramp = e.target.value as VectorRamp;
            const colors = categoryColors(style.categories!.length, ramp);
            change({ ramp, categories: style.categories!.map((item, index) => ({ ...item, color: colors[index] })) });
          }}>
            <option value="blue">蓝色系 · 默认</option>
            <option value="slate">蓝灰系 · 低饱和</option>
            <option value="earth">大地色 · 对比分类</option>
          </select></label>
          <div className="category-legend" aria-label="唯一值图例">{style.categories.map((item, i) => <label key={i}>
            <input type="color" aria-label={`${item.value ?? "空值"} 颜色`} value={item.color} onChange={e => change({ categories: style.categories!.map((v, idx) => idx === i ? { ...v, color: e.target.value } : v) })} />
            <span>{item.value === null ? "<空值>" : String(item.value)}</span></label>)}
            {(uniqueCount ?? style.categories.length) > 20 && <p>显示前 20 个值，其余使用“其他值填充”颜色。</p>}
          </div>
        </>}
        <button type="button" className="icon-btn" onClick={() => { onStyle(defaultLayerStyle(layer.id, layer.name)); setUniqueCount(null); }}>恢复默认样式</button>
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
