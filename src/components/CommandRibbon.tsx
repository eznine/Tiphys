import { useState } from "react";
import {
  FolderPlus, Scan, Focus, Table2, Shapes, Tags, Combine, Scissors, ListFilter,
  CircleDot, Wrench, MessageSquareText, Logs, Settings2, SunMoon, Layers,
  PanelBottom, FolderInput, FileOutput, RefreshCw, Eraser, Hexagon, Ruler,
  Download, Satellite, SlidersHorizontal, Cloud, KeyRound, Search, ListChecks,
  Mountain, Waves, Sparkles, Network, Route, Layers3, type LucideIcon,
} from "lucide-react";

type Props = { hasLayer: boolean; onAdd: () => void; onZoomAll: () => void; onZoomLayer: () => void; onTable: () => void;
  onStyle: () => void; onLabels: () => void; onTool: (name?: string) => void; onChat: () => void; onLogs: () => void; onSettings: () => void; onTheme: () => void;
  hasAoi: boolean; onClipAoi: () => void };

const TABS = [["data", "数据"], ["map", "地图"], ["analysis", "分析"], ["rs", "遥感"], ["gee", "GEE"], ["view", "视图"]] as const;

export function CommandRibbon(props: Props) {
  const [tab, setTab] = useState("map");
  const command = (label: string, Icon: LucideIcon, action: () => void, disabled = false, large = false) =>
    <button type="button" className={`ribbon-command${large ? " large" : ""}`} disabled={disabled} onClick={action}><Icon size={large ? 25 : 17} strokeWidth={1.6} /><span>{label}</span></button>;
  return <section className="command-ribbon" aria-label="工作区命令">
    <div className="ribbon-tabs" role="tablist" aria-label="命令类别">
      <button type="button" className="ribbon-agent-tab" onClick={props.onChat}><MessageSquareText size={14} /> Agent</button>
      {TABS.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{text}</button>)}
      <span>以对话驱动分析，保留熟悉的 GIS 操作</span>
    </div>
    <div className="ribbon-tools">
      {tab === "data" && <>
        <div className="ribbon-group"><div>{command("添加数据", FolderPlus, props.onAdd, false, true)}</div><small>导入</small></div>
        <div className="ribbon-group"><div>{command("路径加载", FolderInput, () => props.onTool("add_data"))}{command("导出要素", FileOutput, () => props.onTool("export_features"), !props.hasLayer)}{command("重投影", RefreshCw, () => props.onTool("reproject"), !props.hasLayer)}</div><small>数据交换</small></div>
        <div className="ribbon-group"><div>{command("查看属性", Table2, () => props.onTool("describe_layer"), !props.hasLayer, true)}<div className="ribbon-stack">{command("重命名", Shapes, () => props.onTool("rename_layer"), !props.hasLayer)}{command("调整顺序", Layers, () => props.onTool("reorder_layers"), !props.hasLayer)}</div></div><small>数据管理</small></div>
      </>}
      {tab === "map" && <>
        <div className="ribbon-group"><div>{command("添加数据", FolderPlus, props.onAdd, false, true)}</div><small>数据</small></div>
        <div className="ribbon-group"><div>{command("全图范围", Scan, props.onZoomAll)}{command("缩放至图层", Focus, props.onZoomLayer, !props.hasLayer)}</div><small>导航</small></div>
        <div className="ribbon-group"><div>{command("属性表", Table2, props.onTable, !props.hasLayer, true)}<div className="ribbon-stack">{command("符号化", Shapes, props.onStyle, !props.hasLayer)}{command("标注", Tags, props.onLabels, !props.hasLayer)}</div></div><small>图层</small></div>
        <div className="ribbon-group"><div>{command("缓冲区", CircleDot, () => props.onTool("buffer"), !props.hasLayer)}{command("裁剪", Scissors, () => props.onTool("clip"), !props.hasLayer)}{command("按属性选择", ListFilter, () => props.onTool("select_by_attributes"), !props.hasLayer)}</div><small>常用操作</small></div>
      </>}
      {tab === "analysis" && <>
        <div className="ribbon-group"><div>{command("工具箱", Wrench, () => props.onTool(), false, true)}</div><small>地理处理</small></div>
        <div className="ribbon-group"><div>{command("缓冲区", CircleDot, () => props.onTool("buffer"))}{command("裁剪", Scissors, () => props.onTool("clip"))}{command("相交", Combine, () => props.onTool("intersection"))}{command("联合", Layers, () => props.onTool("union_layers"))}{command("擦除", Eraser, () => props.onTool("erase"))}{command("融合", Combine, () => props.onTool("dissolve"))}</div><small>矢量叠加</small></div>
        <div className="ribbon-group"><div>{command("空间连接", Combine, () => props.onTool("spatial_join"), !props.hasLayer)}{command("按位置选择", Focus, () => props.onTool("select_by_location"), !props.hasLayer)}{command("裁剪到 AOI", Scissors, props.onClipAoi, !props.hasLayer || !props.hasAoi)}</div><small>空间关联 / AOI</small></div>
        <div className="ribbon-group"><div>{command("凸包", Hexagon, () => props.onTool("convex_hull"))}{command("简化", SlidersHorizontal, () => props.onTool("simplify"))}{command("面积长度", Ruler, () => props.onTool("calculate_geometry"))}</div><small>几何处理</small></div>
        <div className="ribbon-group"><div>{command("按属性选择", ListFilter, () => props.onTool("select_by_attributes"))}{command("字段统计", Download, () => props.onTool("field_statistics"))}</div><small>查询与统计</small></div>
        <div className="ribbon-group"><div>{command("加权叠加", Layers3, () => props.onTool("wasm_weighted_overlay"), !props.hasLayer)}{command("加权总和", Layers3, () => props.onTool("wasm_weighted_sum"), !props.hasLayer)}</div><small>栅格叠加</small></div>
        <div className="ribbon-group"><div>{command("分区统计", Download, () => props.onTool("wasm_zonal_statistics"), !props.hasLayer)}{command("栅格裁剪", Scissors, () => props.onTool("wasm_clip_raster_to_polygon"), !props.hasLayer)}{command("栅格重投影", RefreshCw, () => props.onTool("wasm_reproject_raster"), !props.hasLayer)}</div><small>栅格分析</small></div>
        <div className="ribbon-group"><div>{command("成本距离", Route, () => props.onTool("wasm_cost_distance"))}{command("成本路径", Route, () => props.onTool("wasm_cost_pathway"))}{command("欧氏距离", Route, () => props.onTool("wasm_euclidean_distance"))}</div><small>距离与成本</small></div>
        <div className="ribbon-group"><div>{command("网络拓扑", Network, () => props.onTool("wasm_build_network_topology"), !props.hasLayer)}{command("最近设施", Route, () => props.onTool("wasm_closest_facility_network"), !props.hasLayer)}</div><small>网络分析</small></div>
        <div className="ribbon-group"><div>{command("廊道连通", Network, () => props.onTool("linkage_mapper_corridor"), !props.hasLayer)}{command("水文流程", Waves, () => props.onTool("hydrology_flow_pipeline"), !props.hasLayer)}{command("最小成本路径", Route, () => props.onTool("least_cost_path_pipeline"), !props.hasLayer)}</div><small>扩展工作流</small></div>
        <div className="ribbon-group"><div>{command("坡向", Mountain, () => props.onTool("wasm_aspect"))}{command("坡度", Mountain, () => props.onTool("wasm_slope"))}{command("山体阴影", SunMoon, () => props.onTool("wasm_hillshade"))}{command("平面曲率", Mountain, () => props.onTool("wasm_plan_curvature"))}{command("剖面曲率", Mountain, () => props.onTool("wasm_profile_curvature"))}</div><small>地形</small></div>
        <div className="ribbon-group"><div>{command("等值线", Mountain, () => props.onTool("wasm_contours_from_raster"))}{command("地形 z 分数", Mountain, () => props.onTool("wasm_deviation_from_mean_elevation"))}{command("点提取栅格值", Download, () => props.onTool("wasm_extract_raster_values_at_points"))}</div><small>表面与采样</small></div>
        <div className="ribbon-group"><div>{command("视域分析", Scan, () => props.onTool("wasm_viewshed"))}{command("可见性指数", Focus, () => props.onTool("wasm_visibility_index"))}{command("天空开阔度", SunMoon, () => props.onTool("wasm_sky_view_factor"))}</div><small>可见性</small></div>
        <div className="ribbon-group"><div>{command("填洼", Waves, () => props.onTool("wasm_fill_depressions"))}{command("洼地开裂", Waves, () => props.onTool("wasm_breach_depressions_least_cost"))}{command("D8 流向", Route, () => props.onTool("wasm_d8_pointer"))}{command("汇流累积", Waves, () => props.onTool("wasm_d8_flow_accum"))}{command("河网提取", Waves, () => props.onTool("wasm_extract_streams"))}{command("流域", Waves, () => props.onTool("wasm_watershed"))}</div><small>水文</small></div>
        <div className="ribbon-group"><div>{command("栅格计算器", SlidersHorizontal, () => props.onTool("wasm_raster_calculator"))}{command("重分类", ListChecks, () => props.onTool("wasm_reclass"))}</div><small>栅格代数</small></div>
      </>}
      {tab === "rs" && <>
        <div className="ribbon-group"><div>{command("遥感工具箱", Wrench, () => props.onTool(), false, true)}</div><small>全部工具</small></div>
        <div className="ribbon-group"><div>{command("NDVI / 归一化", Sparkles, () => props.onTool("wasm_normalized_difference_index"))}{command("光谱指数", SlidersHorizontal, () => props.onTool("wasm_spectral_index"))}{command("变化检测", RefreshCw, () => props.onTool("wasm_image_difference_change_detection"))}{command("光谱分析", SlidersHorizontal, () => props.onTool("wasm_extract_spectra_from_image"))}{command("光谱角制图", SlidersHorizontal, () => props.onTool("wasm_spectral_angle_mapper"))}</div><small>光谱分析</small></div>
        <div className="ribbon-group"><div>{command("影像滤波", Satellite, () => props.onTool("wasm_adaptive_filter"))}{command("影像分割", Satellite, () => props.onTool("wasm_image_segmentation"))}{command("超像元分割", Satellite, () => props.onTool("wasm_segment_slic_superpixels"))}{command("多尺度分割", Satellite, () => props.onTool("wasm_segment_multiresolution_hierarchical"))}{command("地物分类", ListChecks, () => props.onTool("wasm_knn_classification"))}</div><small>增强与分割</small></div>
        <div className="ribbon-group"><div>{command("全色锐化", Layers3, () => props.onTool("wasm_panchromatic_sharpening"))}{command("栅格重采样", RefreshCw, () => props.onTool("wasm_resample"))}</div><small>融合与分辨率</small></div>
        <div className="ribbon-group"><div>{command("彩色合成", Layers3, () => props.onTool("wasm_create_colour_composite"))}{command("边缘检测", Scan, () => props.onTool("wasm_sobel_filter"))}{command("栅格镶嵌", Layers3, () => props.onTool("wasm_mosaic"))}</div><small>合成与增强</small></div>
        <div className="ribbon-group"><div>{command("SAR 水体", Waves, () => props.onTool("wasm_extract_water_sar"))}{command("地表温度", SunMoon, () => props.onTool("wasm_land_surface_temperature_single_channel"))}</div><small>SAR / 热红外</small></div>
      </>}
      {tab === "gee" && <>
        <div className="ribbon-group"><div>{command("GEE 工具箱", Cloud, () => props.onTool(), false, true)}</div><small>连接与导出</small></div>
        <div className="ribbon-group"><div>{command("认证状态", KeyRound, () => props.onTool("gee_auth_status"))}{command("搜索影像", Search, () => props.onTool("gee_search_collection"))}</div><small>连接与检索</small></div>
        <div className="ribbon-group"><div>{command("导出栅格", Download, () => props.onTool("gee_export_raster"))}{command("任务状态", ListChecks, () => props.onTool("gee_job_status"))}</div><small>导出与任务</small></div>
      </>}
      {tab === "view" && <>
        <div className="ribbon-group"><div>{command("Agent 对话", MessageSquareText, props.onChat, false, true)}{command("属性表", PanelBottom, props.onTable, !props.hasLayer, true)}</div><small>窗格</small></div>
        <div className="ribbon-group"><div>{command("运行日志", Logs, props.onLogs, false, true)}{command("设置", Settings2, props.onSettings, false, true)}{command("切换主题", SunMoon, props.onTheme, false, true)}</div><small>工作区</small></div>
      </>}
      <button type="button" className="ribbon-ask" onClick={props.onChat}><MessageSquareText size={22} /><span><strong>直接告诉 Agent</strong><small>描述目标，自动选择工具并执行</small></span></button>
    </div>
  </section>;
}
