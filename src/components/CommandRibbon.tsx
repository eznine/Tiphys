import { useState } from "react";
import { FolderPlus, Scan, Focus, Table2, Shapes, Tags, Combine, Scissors, ListFilter, CircleDot, Wrench, MessageSquareText,
  Logs, Settings2, SunMoon, Layers, PanelBottom, type LucideIcon } from "lucide-react";

type Props = { hasLayer: boolean; onAdd: () => void; onZoomAll: () => void; onZoomLayer: () => void; onTable: () => void;
  onStyle: () => void; onLabels: () => void; onTool: (name?: string) => void; onChat: () => void; onLogs: () => void; onSettings: () => void; onTheme: () => void };
export function CommandRibbon(props: Props) {
  const [tab, setTab] = useState("map");
  const command = (label: string, Icon: LucideIcon, action: () => void, disabled = false, large = false) =>
    <button type="button" className={`ribbon-command${large ? " large" : ""}`} disabled={disabled} onClick={action}><Icon size={large ? 25 : 17} strokeWidth={1.6} /><span>{label}</span></button>;
  return <section className="command-ribbon" aria-label="工作区命令">
    <div className="ribbon-tabs" role="tablist" aria-label="命令类别">
      <button type="button" className="ribbon-agent-tab" onClick={props.onChat}><MessageSquareText size={14} /> Agent</button>
      {[["map", "地图"], ["analysis", "分析"], ["view", "视图"]].map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{text}</button>)}
      <span>以对话驱动分析，保留熟悉的 GIS 操作</span>
    </div>
    <div className="ribbon-tools">
      {tab === "map" && <>
        <div className="ribbon-group"><div>{command("添加数据", FolderPlus, props.onAdd, false, true)}</div><small>数据</small></div>
        <div className="ribbon-group"><div>{command("全图范围", Scan, props.onZoomAll)}{command("缩放至图层", Focus, props.onZoomLayer, !props.hasLayer)}</div><small>导航</small></div>
        <div className="ribbon-group"><div>{command("属性表", Table2, props.onTable, !props.hasLayer, true)}<div className="ribbon-stack">{command("符号化", Shapes, props.onStyle, !props.hasLayer)}{command("标注", Tags, props.onLabels, !props.hasLayer)}</div></div><small>图层</small></div>
        <div className="ribbon-group"><div>{command("缓冲区", CircleDot, () => props.onTool("buffer"))}{command("裁剪", Scissors, () => props.onTool("clip"))}{command("按属性选择", ListFilter, () => props.onTool("select_by_attributes"))}</div><small>常用分析</small></div>
      </>}
      {tab === "analysis" && <>
        <div className="ribbon-group"><div>{command("工具箱", Wrench, () => props.onTool(), false, true)}</div><small>地理处理</small></div>
        <div className="ribbon-group"><div>{command("缓冲区", CircleDot, () => props.onTool("buffer"))}{command("裁剪", Scissors, () => props.onTool("clip"))}{command("相交", Combine, () => props.onTool("intersection"))}{command("融合", Layers, () => props.onTool("dissolve"))}</div><small>矢量分析</small></div>
        <div className="ribbon-group"><div>{command("按属性选择", ListFilter, () => props.onTool("select_by_attributes"))}{command("按位置选择", Focus, () => props.onTool("select_by_location"))}</div><small>查询与选择</small></div>
      </>}
      {tab === "view" && <>
        <div className="ribbon-group"><div>{command("Agent 对话", MessageSquareText, props.onChat, false, true)}{command("属性表", PanelBottom, props.onTable, !props.hasLayer, true)}</div><small>窗格</small></div>
        <div className="ribbon-group"><div>{command("运行日志", Logs, props.onLogs, false, true)}{command("设置", Settings2, props.onSettings, false, true)}{command("切换主题", SunMoon, props.onTheme, false, true)}</div><small>工作区</small></div>
      </>}
      <button type="button" className="ribbon-ask" onClick={props.onChat}><MessageSquareText size={22} /><span><strong>直接告诉 Agent</strong><small>描述目标，自动选择工具并执行</small></span></button>
    </div>
  </section>;
}
