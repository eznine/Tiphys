import { useEffect, useRef } from "react";
import type { TimelineItem } from "../lib/agent";
import type { DataLayer } from "../lib/dataLayers";
import type { WorkspaceRecovery } from "../lib/workspace";
import { PipelineResultDetails, pipelineResult } from "./ToolResultDetails";
import { TaskCards } from "./TaskCards";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Layers3, Network, Waves, Route, Scissors, Sparkles, History, Mountain, Shapes, CircleDot, Hexagon, ChartScatter, Expand, Boxes, SlidersHorizontal, RefreshCw, Square } from "lucide-react";

/** Chat timeline shared by the desktop ChatDock and the mobile chat sheet. */
export const SUGGESTIONS = ["加载样例点，做 500 米缓冲", "查看当前图层信息"];

const JOB_STATUS: Record<string, string> = { running: "运行中", queued: "排队中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", cancelling: "正在取消", unreachable: "连接中断" };
const JOB_STEPS: Record<string, string> = {
  linkage_mapper_corridor: "廊道连通",
  hydrology_flow_pipeline: "水文流程",
  least_cost_path_pipeline: "最小成本路径",
  clip_layers_to_aoi: "AOI 裁剪",
  gee_export_raster: "GEE 导出",
};
const RECIPES = [
  { title: "线密度", detail: "线要素 → 搜索半径密度栅格", tool: "wasm_line_density", Icon: Route },
  { title: "凹包", detail: "生成贴合点群边界的凹包面", tool: "wasm_concave_hull", Icon: Hexagon },
  { title: "网络服务区", detail: "线网络 + 起点，打开服务区表单", tool: "wasm_network_service_area", Icon: Network },
  { title: "栅格缓冲", detail: "围绕非零像元生成二值缓冲，打开表单", tool: "wasm_buffer_raster", Icon: CircleDot },
  { title: "栅格转矢量", detail: "把分类栅格转为面，打开表单", tool: "wasm_raster_to_vector_polygons", Icon: Shapes },
  { title: "IDW 插值", detail: "从点采样生成连续栅格，打开表单", tool: "wasm_idw_interpolation", Icon: Sparkles },
  { title: "EBK 克里金", detail: "点场局部插值，同时输出预测与误差栅格", tool: "wasm_empirical_bayesian_kriging", Icon: ChartScatter },
  { title: "等值线提取", detail: "选择 DEM，打开等值线表单", tool: "wasm_contours_from_raster", Icon: Mountain },
  { title: "成本距离", detail: "源栅格 + 成本栅格，打开表单", tool: "wasm_cost_distance", Icon: Route },
  { title: "廊道连通", detail: "核心生境 + 阻力栅格，打开工具表单", tool: "linkage_mapper_corridor", Icon: Network },
  { title: "水文流程", detail: "填洼 → D8 流向 → 汇流 → 河网", tool: "hydrology_flow_pipeline", Icon: Waves },
  { title: "河网分级", detail: "D8 流向 + 河网栅格 → Strahler 分级", tool: "wasm_strahler_stream_order", Icon: Waves },
  { title: "集水区", detail: "从 D8 流向栅格划分流域盆地，打开表单", tool: "wasm_basins", Icon: Waves },
  { title: "成本连通", detail: "多个地点 + 阻力栅格 → 最小成本路径网络", tool: "wasm_cost_connectivity", Icon: Network },
  { title: "开运算", detail: "去除小对象并平滑分类栅格，打开表单", tool: "wasm_opening", Icon: Expand },
  { title: "矢量差集", detail: "从输入面中扣除叠加面范围，打开表单", tool: "wasm_difference", Icon: Scissors },
  { title: "地形崎岖度", detail: "从 DEM 计算 Riley 地形粗糙度指数，打开表单", tool: "wasm_ruggedness_index", Icon: Mountain },
  { title: "对称差", detail: "保留两个面图层互不重叠的区域，打开表单", tool: "wasm_symmetrical_difference", Icon: Boxes },
  { title: "均值滤波", detail: "对 DEM 或影像做局部均值平滑，打开表单", tool: "wasm_mean_filter", Icon: SlidersHorizontal },
  { title: "变化矢量", detail: "双日期多波段影像 → 变化幅度与方向栅格", tool: "wasm_change_vector_analysis", Icon: RefreshCw },
  { title: "邻近分析", detail: "输入图层 → 最近要素 ID 与距离", tool: "wasm_near", Icon: CircleDot },
  { title: "线延伸分割", detail: "端点延伸或按长度拆分折线，打开表单", tool: "wasm_extend_vector_lines", Icon: Scissors },
  { title: "中心要素", detail: "找出到所有要素总距离最小的位置，打开表单", tool: "wasm_central_feature", Icon: ChartScatter },
  { title: "标准差椭圆", detail: "方向分布与标准差椭圆，打开表单", tool: "wasm_directional_distribution", Icon: ChartScatter },
  { title: "Frost 滤波", detail: "SAR 斑点抑制并保留边缘，打开表单", tool: "wasm_frost_filter", Icon: SlidersHorizontal },
  { title: "填挖方", detail: "比较两期 DEM 或参考平面，打开体积表单", tool: "wasm_cut_fill", Icon: Mountain },
  { title: "对比度均衡", detail: "校正 RGB 影像色彩偏差，打开表单", tool: "wasm_balance_contrast_enhancement", Icon: SlidersHorizontal },
  { title: "点生成等值线", detail: "从带高程字段的点生成等值线，打开表单", tool: "wasm_contours_from_points", Icon: Mountain },
  { title: "总曲率", detail: "从 DEM 计算与方向无关的地形曲率，打开表单", tool: "wasm_total_curvature", Icon: Mountain },
  { title: "主成分分析", detail: "多波段栅格栈降维，输出前几个主成分", tool: "wasm_principal_component_analysis", Icon: Layers3 },
  { title: "各向异性扩散", detail: "去噪同时保留边缘，打开表单", tool: "wasm_anisotropic_diffusion_filter", Icon: SlidersHorizontal },
  { title: "多尺度粗糙度", detail: "DEM 多尺度粗糙度与尺度栅格，打开表单", tool: "wasm_multiscale_roughness", Icon: Mountain },
  { title: "最小成本路径", detail: "连接源与目的地，保留真实路径结果", tool: "least_cost_path_pipeline", Icon: Route },
  { title: "按 AOI 裁剪", detail: "先在地图绘制 AOI，再插入提示词", prompt: "用当前 AOI 范围裁剪所选图层。", Icon: Scissors },
] as const;

type Props = {
  items: TimelineItem[];
  layers: DataLayer[];
  recovery?: WorkspaceRecovery | null;
  busy: boolean;
  selectedLayerId?: string | null;
  onOpenTool: (tool: string) => void;
  onInsertPrompt: (text: string) => void;
  onApprove: (toolCallId: string, ok: boolean) => void;
  onCancelJob: (jobId: string) => void;
};

export function ChatTimeline({ items, layers, recovery, busy, selectedLayerId, onOpenTool, onInsertPrompt, onApprove, onCancelJob }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items]);
  return (
    <div className="chat-messages">
      {recovery && <div className="agent-recovery-note" role="status" aria-label="工作区恢复说明">
        <History size={14} strokeWidth={1.7} aria-hidden="true" />
        <div>
          <strong>已恢复本机工作区</strong>
          <span>
            {recovery.layerCount} 个图层{recovery.selectedLayerName ? ` · 当前 ${recovery.selectedLayerName}` : ""}
            {recovery.selectionCount ? ` · 已选 ${recovery.selectionCount} 个要素` : ""}{recovery.hasAoi ? " · AOI 已恢复" : ""}
          </span>
          <small>{recovery.transcriptAvailable ? "聊天记录按本机实际保存内容显示。" : recovery.goals.length ? `没有可回放的完整对话；上次目标：${recovery.goals[recovery.goals.length - 1]}` : "没有可回放的完整对话，不会补造历史记录。"}</small>
        </div>
      </div>}
      {!items.length && <div className="agent-welcome"><span className="agent-welcome-kicker">本机 GIS Agent</span><h2>从一个空间问题开始</h2><p className="agent-welcome-lead">{layers.length ? "图层已就绪。描述目标，我会选择工具、执行分析并显示结果。" : "添加本地数据，或让我加载样例，然后描述分析目标。"}</p><p className="agent-welcome-note">也可以打开工具箱逐项运行；右键图层可查看属性与符号。</p>
        <TaskCards layers={layers} selectedLayerId={selectedLayerId} busy={busy} />
        <section className="workflow-recipes" aria-label="推荐工作流">
          <div className="workflow-heading"><span><Sparkles size={13} />推荐工作流</span><small>只打开表单或插入提示词，不自动执行</small></div>
          <div className="workflow-grid">
            {RECIPES.map(recipe => <button key={recipe.title} type="button" className="workflow-card" disabled={busy}
              onClick={() => "tool" in recipe ? onOpenTool(recipe.tool) : onInsertPrompt(recipe.prompt)}>
              <recipe.Icon size={16} strokeWidth={1.7} />
              <strong>{recipe.title}</strong><small>{recipe.detail}</small>
            </button>)}
          </div>
        </section>
      </div>}
      {items.map((it) => {
        if (it.kind === "msg")
          return (
            <div key={it.id} className="chat-bubble" data-role={it.role}>
              <span className="meta">{it.role === "agent" ? "TIPHYS" : "你"}</span>
              {it.role === "agent" ? <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]}>{it.text}</Markdown></div> : it.text}
            </div>
          );
        if (it.kind === "tool") {
          const pipeline = pipelineResult(it.output);
          if (pipeline) return <div key={`tool:${it.id}`} className="tool-result-card" data-status={it.status}>
            <div className="tool-result-card-head"><span className="tool-dot" /><code>{it.name}</code><span className="tool-sum">{it.summary}</span></div>
            <PipelineResultDetails output={it.output} />
          </div>;
          return (
            <div key={`tool:${it.id}`} className="tool-chip" data-status={it.status}>
              <span className="tool-dot" /> <code>{it.name}</code>
              <span className="tool-sum">{it.status === "running" ? "执行中…" : it.summary}</span>
            </div>
          );
        }
        if (it.kind === "job") {
          const active = it.status === "running" || it.status === "queued";
          const cancelling = it.status === "cancelling";
          const percent = Math.max(0, Math.min(100, Math.round((Number.isFinite(it.progress) ? it.progress : 0) * 100)));
          const step = it.status === "queued" ? "等待计算槽位"
            : it.status === "running" ? JOB_STEPS[it.toolName ?? ""] ?? "本机计算"
            : it.status === "cancelling" ? "正在取消"
            : it.status === "completed" ? "完成"
            : it.status === "failed" ? "失败"
            : it.status === "interrupted" ? "已中断"
            : "已取消";
          return (
            <div key={it.id} className="job-card" data-status={it.status} aria-live="polite">
              <div className="job-head">
                <span className="job-title"><strong>{it.label}</strong><span className="job-state" data-status={it.status}>{JOB_STATUS[it.status] ?? it.status}</span></span>
                <span className="job-percent">{percent}%</span>
              </div>
              <div className="route-progress job-route" role="progressbar" aria-label={`${it.label} 进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${step}，${percent}%`}>
                <span style={{ ["--progress" as string]: `${percent}%` }} />
              </div>
              <div className="job-step"><span>{step}</span><span>{it.message}</span></div>
              <div className="job-foot">
                <span className="job-message">{cancelling ? "正在取消任务…" : active ? "长任务可随时取消；已完成的结果会保留。" : ""}</span>
                {(active || cancelling) && (
                  <button type="button" className="job-cancel" aria-label={`取消 ${it.label}`} disabled={cancelling} onClick={() => onCancelJob(it.id)}>
                    <Square size={10} />{cancelling ? "取消中" : "取消"}
                  </button>
                )}
              </div>
            </div>
          );
        }
        if (it.kind === "approval")
          return (
            <div key={`approval:${it.id}`} className="approval-card" data-state={it.state}>
              <div>
                ⚠ 需要确认破坏性操作 <code>{it.toolName}</code> {JSON.stringify(it.input)}
              </div>
              {it.state === "pending" ? (
                <div className="approval-actions">
                  <button type="button" className="primary-btn" onClick={() => onApprove(it.id, true)}>
                    允许
                  </button>
                  <button type="button" className="icon-btn" onClick={() => onApprove(it.id, false)}>
                    拒绝
                  </button>
                </div>
              ) : (
                <div className="meta">{it.state === "approved" ? "已允许" : it.state === "expired" ? "审批已失效" : "已拒绝"}</div>
              )}
            </div>
          );
        return (
          <div key={it.id} className="chat-notice">
            {it.text}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
