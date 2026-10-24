import { useEffect, useState } from "react";
import { categoryColors, defaultLayerStyle, symbologyMode, withSymbologyMode, type ClassMethod, type DataLayer, type LayerStyle, type RasterStretch, type SymbologyMode, type VectorRamp } from "../lib/dataLayers";
import { buildGraduatedBreaks, classRangeLabel, clampClassCount, formatClassNumber } from "../lib/graduatedSymbology";
import { formatLayerBytes, layerKindLabel, layerSourcePath } from "../lib/layer-actions";
import { engineRequest } from "../lib/service";

type Tab = "style" | "labels" | "info";
type FieldStats = { count?: number; min?: number; max?: number };
const SAMPLE_PAGE = 500;
const SAMPLE_MAX = 5000;

function optionalNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Numeric samples come from the existing paged attribute API; never from invented statistics. */
async function sampleNumericField(layerId: string, field: string): Promise<{ values: number[]; sampled: number; total: number }> {
  const first = await (await engineRequest(`/layers/${layerId}/attributes?${new URLSearchParams({ offset: "0", limit: String(SAMPLE_PAGE) })}`)).json();
  const total = Math.max(0, Number(first.total) || 0);
  if (!Array.isArray(first.rows)) throw new Error("无法读取属性样本。");
  const rows = [...first.rows];
  if (total > SAMPLE_PAGE) {
    const pages = Math.ceil(SAMPLE_MAX / SAMPLE_PAGE);
    const seen = new Set<number>(rows.map((row: { id: number }) => row.id));
    for (let page = 1; page < pages; page++) {
      const offset = Math.floor((total - 1) * page / pages);
      const result = await (await engineRequest(`/layers/${layerId}/attributes?${new URLSearchParams({ offset: String(offset), limit: String(SAMPLE_PAGE) })}`)).json();
      for (const row of result.rows ?? []) {
        if (seen.has(row.id)) continue;
        seen.add(row.id); rows.push(row);
        if (rows.length >= SAMPLE_MAX) break;
      }
      if (rows.length >= SAMPLE_MAX) break;
    }
  }
  const values = rows.map((row: { attributes: Record<string, unknown> }) => row.attributes?.[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return { values, sampled: rows.length, total };
}

export function LayerProperties({ layer, tab, onTab, onStyle, onClose, embedded = false }: {
  layer: DataLayer; tab: Tab; onTab: (tab: Tab) => void; onStyle: (style: LayerStyle) => void; onClose: () => void; embedded?: boolean;
}) {
  const style = layer.style ?? defaultLayerStyle(layer.id, layer.name);
  const [description, setDescription] = useState<{ columns: string[]; sourcePath?: string | null; source_path?: string | null; [key: string]: any } | null>(null);
  const [error, setError] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [uniqueCount, setUniqueCount] = useState<number | null>(null);
  const [classSummary, setClassSummary] = useState<{ sampled: number; total: number; min: number; max: number } | null>(null);
  const [mode, setMode] = useState<SymbologyMode>(() => symbologyMode(style));
  useEffect(() => {
    const controller = new AbortController();
    setDescription(null); setError("");
    void engineRequest(`/layers/${layer.id}/describe`, { signal: controller.signal }).then(r => r.json())
      .then(data => { if (!controller.signal.aborted) setDescription(data); })
      .catch(err => { if (!controller.signal.aborted) setError(String(err)); });
    return () => controller.abort();
  }, [layer.id]);
  useEffect(() => { setMode(symbologyMode(style)); }, [layer.id]);
  const change = (patch: Partial<LayerStyle>) => onStyle({ ...style, ...patch });
  const sourcePath = layerSourcePath(layer) ?? layerSourcePath(description);
  const format = String(description?.format ?? layer.format ?? "").trim().toUpperCase();
  const bytes = typeof description?.bytes === "number" ? description.bytes : layer.bytes;
  const kind = layer.kind ?? "vector";
  const bounds = layer.bounds;
  const classMethod = style.classMethod ?? "equal";
  const classCount = clampClassCount(style.classCount ?? 5);
  const changeMode = (next: SymbologyMode) => {
    setMode(next);
    setUniqueCount(null); setClassSummary(null); setError("");
    if (next === "graduated") onStyle({ ...withSymbologyMode(style, "graduated"), classMethod: classMethod, classCount });
    else onStyle(withSymbologyMode(style, next));
  };
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
  const applyGraduated = async () => {
    const field = style.classField;
    if (!field) { setError("请先选择分级字段。"); return; }
    setClassifying(true); setError(""); setClassSummary(null);
    try {
      const stats = await (await engineRequest("/tools/run", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "field_statistics", arguments: { layer: layer.id, field } }) })).json() as FieldStats;
      const fieldMin = Number(stats.min), fieldMax = Number(stats.max);
      if (!Number.isFinite(fieldMin) || !Number.isFinite(fieldMax)) throw new Error("该字段没有可用的数值统计，无法生成分级设色。");
      const min = Number.isFinite(style.classMin) ? Number(style.classMin) : fieldMin;
      const max = Number.isFinite(style.classMax) ? Number(style.classMax) : fieldMax;
      if (max <= min) throw new Error("分级最小值必须小于最大值。");
      const sample = classMethod === "quantile" ? await sampleNumericField(layer.id, field) : { values: [], sampled: 0, total: Number(stats.count) || 0 };
      if (classMethod === "quantile" && sample.values.length < 2) throw new Error("属性样本中没有足够的数值来计算分位数。");
      const breaks = buildGraduatedBreaks(sample.values, classMethod, classCount, style.ramp ?? "blue", min, max);
      if (!breaks.length) throw new Error("无法从该字段生成有效分级。");
      onStyle({ ...style, classField: field, classBreaks: breaks, classMin: min === fieldMin ? style.classMin : min, classMax: max === fieldMax ? style.classMax : max });
      setClassSummary({ sampled: sample.sampled, total: sample.total, min, max });
    } catch (err) { setError(String(err)); }
    finally { setClassifying(false); }
  };
  return <aside className={"layer-properties" + (embedded ? " layer-properties-embedded" : "")} aria-label="图层设置">
    {!embedded && <header className="attribute-header"><strong title={layer.name}>{layer.name}</strong><button type="button" className="icon-btn" aria-label="关闭图层设置" onClick={onClose}>×</button></header>}
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
        <label className="tool-field"><span>符号方式</span><select aria-label="符号方式" disabled={classifying} value={mode} onChange={e => changeMode(e.target.value as "single" | "unique" | "graduated")}>
          <option value="single">单一符号</option><option value="unique">唯一值</option><option value="graduated">分级设色</option>
        </select></label>
        {mode === "unique" && <label className="tool-field"><span>唯一值字段</span><select aria-label="唯一值字段" disabled={classifying} value={style.categoryField ?? ""} onChange={e => void classify(e.target.value)}>
          <option value="">选择字段</option>{description?.columns.map(c => <option key={c} value={c}>{c}</option>)}
        </select></label>}
        {mode === "graduated" && <>
          <label className="tool-field"><span>分级字段</span><select aria-label="分级字段" disabled={classifying} value={style.classField ?? ""} onChange={e => {
            setClassSummary(null); change({ classField: e.target.value || undefined, classBreaks: undefined });
          }}>
            <option value="">选择数值字段</option>{description?.columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
          <label className="tool-field"><span>分级方法</span><select aria-label="分级方法" disabled={classifying} value={classMethod} onChange={e => {
            setClassSummary(null); change({ classMethod: e.target.value as ClassMethod, classBreaks: undefined });
          }}>
            <option value="equal">等间距</option><option value="quantile">分位数</option><option value="manual">手动范围 · 等分</option>
          </select></label>
          <label className="tool-field"><span>分级数</span><input aria-label="分级数" type="number" min="3" max="8" value={classCount} disabled={classifying} onChange={e => {
            setClassSummary(null); change({ classCount: clampClassCount(e.target.value), classBreaks: undefined });
          }} /></label>
          <div className="property-color-row">
            <label className="tool-field"><span>最小范围（可选）</span><input aria-label="分级最小范围" type="number" step="any" placeholder="字段最小值" disabled={classifying} value={style.classMin ?? ""} onChange={e => {
              setClassSummary(null); change({ classMin: optionalNumber(e.target.value), classBreaks: undefined });
            }} /></label>
            <label className="tool-field"><span>最大范围（可选）</span><input aria-label="分级最大范围" type="number" step="any" placeholder="字段最大值" disabled={classifying} value={style.classMax ?? ""} onChange={e => {
              setClassSummary(null); change({ classMax: optionalNumber(e.target.value), classBreaks: undefined });
            }} /></label>
          </div>
          <button type="button" className="icon-btn" aria-label="生成分级" disabled={classifying || !style.classField} onClick={() => void applyGraduated()}>
            {classifying ? "正在读取属性…" : "生成 / 更新分级"}
          </button>
          <p className="tool-desc">等间距与手动范围使用字段统计的最小/最大值；分位数按属性表分页样本计算，并显示实际样本量。范围外数值归入首尾级。</p>
          {classSummary && <p className="tool-desc" role="status">范围 {formatClassNumber(classSummary.min)} – {formatClassNumber(classSummary.max)}
            {classMethod === "quantile" ? ` · 分位数基于 ${classSummary.sampled} / ${classSummary.total} 行样本` : ` · 字段统计 ${classSummary.total} 行`}</p>}
        </>}
        <div className="property-color-row">
          <label className="tool-field"><span>{mode === "single" ? "填充 / 点颜色" : "范围外 / 空值颜色"}</span><input aria-label="符号颜色" type="color" value={style.color} onChange={e => change({ color: e.target.value })} /></label>
          <label className="tool-field"><span>描边 / 线颜色</span><input aria-label="描边颜色" type="color" value={style.strokeColor ?? style.color} onChange={e => change({ strokeColor: e.target.value })} /></label>
        </div>
        <label className="tool-field"><span>整体不透明度 · {Math.round(style.opacity * 100)}%</span><input aria-label="不透明度" type="range" min="0" max="1" step=".05" value={style.opacity} onChange={e => change({ opacity: Number(e.target.value) })} /></label>
        <div className="property-color-row">
          <label className="tool-field"><span>填充强度 · {Math.round((style.fillOpacity ?? .55) * 100)}%</span><input aria-label="填充不透明度" type="range" min="0" max="1" step=".05" value={style.fillOpacity ?? .55} onChange={e => change({ fillOpacity: Number(e.target.value) })} /></label>
          <label className="tool-field"><span>描边强度 · {Math.round((style.strokeOpacity ?? 1) * 100)}%</span><input aria-label="描边不透明度" type="range" min="0" max="1" step=".05" value={style.strokeOpacity ?? 1} onChange={e => change({ strokeOpacity: Number(e.target.value) })} /></label>
        </div>
        {layer.geometry_types.some(t => t.includes("Point")) && <label className="tool-field"><span>点半径（像素）</span><input aria-label="点半径" type="number" min="1" max="30" value={style.pointSize} onChange={e => change({ pointSize: Math.max(1, Math.min(30, Number(e.target.value))) })} /></label>}
        {layer.geometry_types.some(t => t.includes("Line") || t.includes("Polygon")) && <label className="tool-field"><span>线宽（像素）</span><input aria-label="线宽" type="number" min=".1" max="20" step=".1" value={style.lineWidth} onChange={e => change({ lineWidth: Math.max(.1, Math.min(20, Number(e.target.value))) })} /></label>}
        {((mode === "unique" && !!style.categories?.length) || (mode === "graduated" && !!style.classBreaks?.length)) && <>
          <label className="tool-field"><span>分类色带</span><select aria-label="分类色带" value={style.ramp ?? "blue"} onChange={e => {
            const ramp = e.target.value as VectorRamp;
            if (mode === "graduated" && style.classBreaks?.length) {
              const colors = categoryColors(style.classBreaks.length, ramp);
              change({ ramp, classBreaks: style.classBreaks.map((item, index) => ({ ...item, color: colors[index] })) });
            } else if (style.categories?.length) {
              const colors = categoryColors(style.categories.length, ramp);
              change({ ramp, categories: style.categories.map((item, index) => ({ ...item, color: colors[index] })) });
            }
          }}>
            <option value="blue">蓝色系 · 默认</option>
            <option value="slate">蓝灰系 · 低饱和</option>
            <option value="earth">大地色 · 对比分类</option>
          </select></label>
          {mode === "unique" && style.categories?.length ? <div className="category-legend" aria-label="唯一值图例">{style.categories.map((item, i) => <label key={i}>
            <input type="color" aria-label={`${item.value ?? "空值"} 颜色`} value={item.color} onChange={e => change({ categories: style.categories!.map((v, idx) => idx === i ? { ...v, color: e.target.value } : v) })} />
            <span>{item.value === null ? "<空值>" : String(item.value)}</span></label>)}
            {(uniqueCount ?? style.categories.length) > 20 && <p>显示前 20 个值，其余使用“其他值填充”颜色。</p>}
          </div> : mode === "graduated" && style.classBreaks?.length ? <div className="category-legend graduated-legend" aria-label="分级设色图例">
            {style.classBreaks.map((item, i) => <label key={i}>
              <input type="color" aria-label={`第 ${i + 1} 级颜色`} value={item.color} onChange={e => change({ classBreaks: style.classBreaks!.map((value, index) => index === i ? { ...value, color: e.target.value } : value) })} />
              <span>{item.label || classRangeLabel(item)}</span></label>)}
          </div> : null}
        </>}
        <button type="button" className="icon-btn" onClick={() => { onStyle(defaultLayerStyle(layer.id, layer.name)); setMode("single"); setUniqueCount(null); setClassSummary(null); }}>恢复默认样式</button>
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
        <dt>名称</dt><dd>{layer.name}</dd>
        <dt>类型</dt><dd>{layerKindLabel(kind)}</dd>
        <dt>{kind === "raster" ? "尺寸 / 波段" : "要素数"}</dt>
        <dd>{kind === "raster" ? `${layer.raster?.width ?? "?"} × ${layer.raster?.height ?? "?"} 像素 · ${layer.raster?.bands ?? "?"} 波段` : layer.feature_count}</dd>
        <dt>几何类型</dt><dd>{layer.geometry_types.join("、") || (kind === "raster" ? "栅格像元" : "空图层")}</dd>
        <dt>坐标系</dt><dd>{layer.crs || "未知"}</dd>
        <dt>显示范围</dt><dd>{bounds?.length === 4 ? bounds.map(value => value.toFixed(6)).join("，") + "（WGS 84）" : "无范围"}</dd>
        <dt>原始路径</dt><dd title={sourcePath ?? undefined}>{sourcePath ?? "无原始路径（仅工作副本）"}</dd>
        <dt>工作副本</dt><dd title={description?.path ?? layer.path ?? undefined}>{description?.path ?? layer.path ?? (description ? "未报告" : "读取中…")}</dd>
        <dt>格式</dt><dd>{format || "未知"}</dd>
        <dt>大小</dt><dd>{formatLayerBytes(bytes)}</dd>
        <dt>图层 ID</dt><dd>{layer.id}</dd>
        <dt>字段</dt><dd>{description?.columns.join("、") || "无属性字段"}</dd>
      </dl>}
      <p className="property-note">显示设置自动保存，不改变分析数据。</p>
    </div>
  </aside>;
}
