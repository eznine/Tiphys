import { useState } from "react";
import {
  FolderPlus, Scan, Focus, Table2, Shapes, Tags, Combine, Scissors, ListFilter,
  CircleDot, Wrench, MessageSquareText, Logs, Settings2, SunMoon, Layers,
  PanelBottom, FolderInput, FileOutput, RefreshCw, Eraser, Hexagon, Ruler,
  Download, Satellite, SlidersHorizontal, Cloud, KeyRound, Search,
  Mountain, Waves, Route, Sparkles, type LucideIcon,
} from "lucide-react";

type Props = { hasLayer: boolean; onAdd: () => void; onZoomAll: () => void; onZoomLayer: () => void; onTable: () => void;
  onStyle: () => void; onLabels: () => void; onTool: (name?: string) => void; onChat: () => void; onLogs: () => void; onSettings: () => void; onTheme: () => void;
  hasAoi: boolean; onClipAoi: () => void; onSearchTools: (query: string) => void };

const TABS = [["data", "数据"], ["map", "地图"], ["analysis", "分析"], ["rs", "遥感"], ["gee", "GEE"], ["view", "视图"]] as const;

/** The ribbon stays curated: common entry points only. The full catalog lives
 * behind the toolbox and the ribbon search, not as hundreds of buttons. */
export function CommandRibbon(props: Props) {
  const [tab, setTab] = useState("map");
  const [query, setQuery] = useState("");
  const command = (label: string, Icon: LucideIcon, action: () => void, disabled = false, large = false) =>
    <button type="button" className={`ribbon-command${large ? " large" : ""}`} disabled={disabled} onClick={action}><Icon size={large ? 25 : 17} strokeWidth={1.6} /><span>{label}</span></button>;
  const search = (event: React.FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text) props.onSearchTools(text);
  };
  return <section className="command-ribbon" aria-label="工作区命令">
    <div className="ribbon-tabs" role="tablist" aria-label="命令类别">
      <button type="button" className="ribbon-agent-tab" onClick={props.onChat}><MessageSquareText size={14} /> Agent</button>
      {TABS.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{text}</button>)}
      <form className="ribbon-tool-search" onSubmit={search} role="search" aria-label="搜索全部工具">
        <Search size={13} />
        <input type="search" aria-label="搜索全部工具" placeholder="搜索全部工具，如 廊道、NDVI…" value={query} onChange={e => setQuery(e.target.value)} />
      </form>
    </div>
    <div className="ribbon-tools">
      {tab === "data" && <>
        <div className="ribbon-group"><div>{command("添加数据", FolderPlus, props.onAdd, false, true)}</div><small>导入</small></div>
        <div className="ribbon-group"><div>{command("查看属性", Table2, () => props.onTool("describe_layer"), !props.hasLayer, true)}<div className="ribbon-stack">{command("重命名", Shapes, () => props.onTool("rename_layer"), !props.hasLayer)}{command("调整顺序", Layers, () => props.onTool("reorder_layers"), !props.hasLayer)}</div></div><small>数据管理</small></div>
        <div className="ribbon-group"><div>{command("路径加载", FolderInput, () => props.onTool("add_data"))}{command("导出要素", FileOutput, () => props.onTool("export_features"), !props.hasLayer)}{command("重投影", RefreshCw, () => props.onTool("reproject"), !props.hasLayer)}{command("合并矢量", Combine, () => props.onTool("wasm_merge_vectors"), !props.hasLayer)}</div><small>数据交换</small></div>
      </>}
      {tab === "map" && <>
        <div className="ribbon-group"><div>{command("添加数据", FolderPlus, props.onAdd, false, true)}</div><small>数据</small></div>
        <div className="ribbon-group"><div>{command("全图范围", Scan, props.onZoomAll)}{command("缩放至图层", Focus, props.onZoomLayer, !props.hasLayer)}</div><small>导航</small></div>
        <div className="ribbon-group"><div>{command("属性表", Table2, props.onTable, !props.hasLayer, true)}<div className="ribbon-stack">{command("符号化", Shapes, props.onStyle, !props.hasLayer)}{command("标注", Tags, props.onLabels, !props.hasLayer)}</div></div><small>图层</small></div>
        <div className="ribbon-group"><div>{command("缓冲区", CircleDot, () => props.onTool("buffer"), !props.hasLayer)}{command("裁剪", Scissors, () => props.onTool("clip"), !props.hasLayer)}{command("按属性选择", ListFilter, () => props.onTool("select_by_attributes"), !props.hasLayer)}</div><small>常用操作</small></div>
      </>}
      {tab === "analysis" && <>
        <div className="ribbon-group"><div>{command("工具箱", Wrench, () => props.onTool(), false, true)}</div><small>全部工具</small></div>
        <div className="ribbon-group"><div>{command("缓冲区", CircleDot, () => props.onTool("buffer"), !props.hasLayer)}{command("裁剪", Scissors, () => props.onTool("clip"), !props.hasLayer)}{command("相交", Combine, () => props.onTool("intersection"), !props.hasLayer)}{command("联合", Layers, () => props.onTool("union_layers"), !props.hasLayer)}{command("擦除", Eraser, () => props.onTool("erase"), !props.hasLayer)}{command("融合（需桌面）", Combine, () => props.onTool("dissolve"), true)}</div><small>常用叠加</small></div>
        <div className="ribbon-group"><div>{command("简化", SlidersHorizontal, () => props.onTool("simplify"), !props.hasLayer)}{command("凸包", Hexagon, () => props.onTool("convex_hull"), !props.hasLayer)}{command("质心", CircleDot, () => props.onTool("wasm_centroid_vector"), !props.hasLayer)}{command("面积长度", Ruler, () => props.onTool("calculate_geometry"), !props.hasLayer)}</div><small>几何</small></div>
        <div className="ribbon-group"><div>{command("按属性选择", ListFilter, () => props.onTool("select_by_attributes"), !props.hasLayer)}{command("按位置选择", Focus, () => props.onTool("select_by_location"), !props.hasLayer)}{command("空间连接", Combine, () => props.onTool("spatial_join"), !props.hasLayer)}{command("字段统计", Download, () => props.onTool("field_statistics"), !props.hasLayer)}</div><small>查询与统计</small></div>
        <div className="ribbon-group"><div>{command("栅格计算器", SlidersHorizontal, () => props.onTool("wasm_raster_calculator"))}{command("坡度", Mountain, () => props.onTool("wasm_slope"))}{command("坡向", Mountain, () => props.onTool("wasm_aspect"))}{command("山体阴影", SunMoon, () => props.onTool("wasm_hillshade"))}{command("等值线", Mountain, () => props.onTool("wasm_contours_from_raster"))}{command("平面曲率", Mountain, () => props.onTool("wasm_plan_curvature"))}{command("剖面曲率", Mountain, () => props.onTool("wasm_profile_curvature"))}{command("地形开阔度", Mountain, () => props.onTool("wasm_openness"))}</div><small>栅格与地形</small></div>
        <div className="ribbon-group"><div>{command("保边平滑", SlidersHorizontal, () => props.onTool("wasm_feature_preserving_smoothing"))}{command("Lee 滤波", SlidersHorizontal, () => props.onTool("wasm_lee_filter"))}{command("TIN 插值", Sparkles, () => props.onTool("wasm_tin_interpolation"))}</div><small>滤波与插值</small></div>
        <div className="ribbon-group"><div>{command("拓扑检查", ListFilter, () => props.onTool("wasm_topology_validation_report"), !props.hasLayer)}{command("几何修复", Wrench, () => props.onTool("wasm_repair_geometry"), !props.hasLayer)}</div><small>矢量质检</small></div>
        <div className="ribbon-group"><div>{command("廊道连通", Route, () => props.onTool("linkage_mapper_corridor"), !props.hasLayer)}{command("水文流程", Waves, () => props.onTool("hydrology_flow_pipeline"), !props.hasLayer)}{command("最小成本路径", Route, () => props.onTool("least_cost_path_pipeline"), !props.hasLayer)}{command("裁剪到 AOI", Scissors, props.onClipAoi, !props.hasLayer || !props.hasAoi)}</div><small>扩展工作流</small></div>
      </>}
      {tab === "rs" && <>
        <div className="ribbon-group"><div>{command("遥感工具箱", Wrench, () => props.onTool(), false, true)}</div><small>全部工具</small></div>
        <div className="ribbon-group"><div>{command("NDVI / 归一化", Sparkles, () => props.onTool("wasm_normalized_difference_index"))}{command("光谱指数", SlidersHorizontal, () => props.onTool("wasm_spectral_index"))}{command("变化检测", RefreshCw, () => props.onTool("wasm_image_difference_change_detection"))}</div><small>光谱与变化</small></div>
        <div className="ribbon-group"><div>{command("直方图均衡", SlidersHorizontal, () => props.onTool("wasm_histogram_equalization"))}{command("主成分分析", Layers, () => props.onTool("wasm_principal_component_analysis"))}{command("K 均值分类", ListFilter, () => props.onTool("wasm_k_means_clustering"))}{command("影像分割", Satellite, () => props.onTool("wasm_image_segmentation"))}{command("全色锐化", Layers, () => props.onTool("wasm_panchromatic_sharpening"))}</div><small>增强与分类</small></div>
        <div className="ribbon-group"><div>{command("SAR 水体", Waves, () => props.onTool("wasm_extract_water_sar"))}{command("地表温度", SunMoon, () => props.onTool("wasm_land_surface_temperature_single_channel"))}</div><small>SAR / 热红外</small></div>
      </>}
      {tab === "gee" && <>
        <div className="ribbon-group"><div>{command("GEE 工具箱", Cloud, () => props.onTool(), false, true)}</div><small>连接与导出</small></div>
        <div className="ribbon-group"><div>{command("认证状态", KeyRound, () => props.onTool("gee_auth_status"))}{command("搜索影像", Search, () => props.onTool("gee_search_collection"))}</div><small>连接与检索</small></div>
        <div className="ribbon-group"><div>{command("导出栅格", Download, () => props.onTool("gee_export_raster"))}{command("任务状态", ListFilter, () => props.onTool("gee_job_status"))}</div><small>导出与任务</small></div>
      </>}
      {tab === "view" && <>
        <div className="ribbon-group"><div>{command("Agent 对话", MessageSquareText, props.onChat, false, true)}{command("属性表", PanelBottom, props.onTable, !props.hasLayer, true)}</div><small>窗格</small></div>
        <div className="ribbon-group"><div>{command("运行日志", Logs, props.onLogs, false, true)}{command("设置", Settings2, props.onSettings, false, true)}{command("切换主题", SunMoon, props.onTheme, false, true)}</div><small>工作区</small></div>
      </>}
      <button type="button" className="ribbon-ask" onClick={props.onChat}><MessageSquareText size={22} /><span><strong>直接告诉 Agent</strong><small>描述目标，自动选择工具并执行</small></span></button>
    </div>
  </section>;
}
