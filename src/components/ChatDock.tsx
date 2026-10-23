import { FormEvent, useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../lib/agent";
import type { DataLayer } from "../lib/dataLayers";
import { ToolPanel } from "./ToolPanel";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Settings2, FolderPlus, ArrowUp, Square, Layers, Network, Waves, Route, Scissors, Sparkles } from "lucide-react";

type Props = {
  items: TimelineItem[];
  busy: boolean;
  connected: boolean;
  provider: string;
  layers: DataLayer[];
  onSend: (text: string) => Promise<boolean>;
  onApprove: (toolCallId: string, ok: boolean) => void;
  onCancelJob: (jobId: string) => void;
  onCancelTurn: () => void;
  onToolResult: (result: Record<string, any>) => void;
  selectedLayer?: DataLayer;
  request?: { id: number; tool?: string; tab: "chat" | "tools" };
  onOpenTool: (tool: string) => void;
  onAdd: () => void; onSettings: () => void;
};

const SUGGESTIONS = ["加载样例点，做 500 米缓冲", "查看当前图层信息"];
const JOB_STATUS: Record<string, string> = { running: "运行中", queued: "排队中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", cancelling: "正在取消", unreachable: "连接中断" };
const JOB_STEPS: Record<string, string> = {
  linkage_mapper_corridor: "廊道连通",
  hydrology_flow_pipeline: "水文流程",
  least_cost_path_pipeline: "最小成本路径",
  clip_layers_to_aoi: "AOI 裁剪",
  gee_export_raster: "GEE 导出",
};
const RECIPES = [
  { title: "廊道连通", detail: "核心生境 + 阻力栅格，打开工具表单", tool: "linkage_mapper_corridor", Icon: Network },
  { title: "水文流程", detail: "填洼 → D8 流向 → 汇流 → 河网", tool: "hydrology_flow_pipeline", Icon: Waves },
  { title: "最小成本路径", detail: "连接源与目的地，保留真实路径结果", tool: "least_cost_path_pipeline", Icon: Route },
  { title: "按 AOI 裁剪", detail: "先在地图绘制 AOI，再插入提示词", prompt: "用当前 AOI 范围裁剪所选图层。", Icon: Scissors },
] as const;

export function ChatDock({ items, busy, connected, provider, layers, onSend, onApprove, onCancelJob, onCancelTurn, onToolResult, selectedLayer, request, onOpenTool, onAdd, onSettings }: Props) {
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "tools">("chat");
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const unconfigured = provider.startsWith("unconfigured");
  const modelName = provider.includes(":") ? provider.slice(provider.indexOf(":") + 1) : provider;
  useEffect(() => { if (request) { setTab(request.tab); if (request.tab === "chat") requestAnimationFrame(() => inputRef.current?.focus()); } }, [request]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items, tab]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || !connected) return;
    if (await onSend(text)) setDraft("");
  }

  function insertPrompt(prompt: string) {
    setDraft(prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <aside className="chat-dock" aria-label="Agent chat">
      <div className="chat-dock-header">
        <div className="agent-pane-title"><span className="chat-brand"><img className="chat-dock-logo" src="/logo-temp.png" alt="" aria-hidden="true" /><strong>TIPHYS 对话</strong></span><button type="button" className="plain-icon" aria-label="Agent 设置" title="模型与 API 设置" onClick={onSettings}><Settings2 size={16} /></button></div>
        <div className="dock-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
            对话
          </button>
          <button type="button" role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>
            工具箱
          </button>
        </div>
        <p>
          <span className="status-dot" data-state={connected && !unconfigured ? "ok" : "error"} /> {connected ? unconfigured ? "尚未配置 API" : `${provider.startsWith("mock") ? "模拟测试 · " : ""}${modelName}` : "Agent 连接中断，正在重连…"}
        </p>
      </div>
      <div className="tool-tab" hidden={tab !== "tools"}>
        <ToolPanel layers={layers} onResult={onToolResult} request={request?.tab === "tools" ? request : undefined} selectedLayer={selectedLayer} />
      </div>
      {tab === "chat" && (
        <>
      <div className="chat-messages">
        {!items.length && <div className="agent-welcome"><h2>从一个空间问题开始</h2><p>{layers.length ? "图层已就绪。描述目标，我会选择工具、执行分析并显示结果。" : "添加本地数据，或让我加载样例，然后描述分析目标。"}</p><p className="tool-desc">也可以打开工具箱逐项运行；右键图层可查看属性与符号。</p>
          <section className="workflow-recipes" aria-label="推荐工作流">
            <div className="workflow-heading"><span><Sparkles size={13} />推荐工作流</span><small>只打开表单或插入提示词，不自动执行</small></div>
            <div className="workflow-grid">
              {RECIPES.map(recipe => <button key={recipe.title} type="button" className="workflow-card" disabled={busy}
                onClick={() => "tool" in recipe ? onOpenTool(recipe.tool) : insertPrompt(recipe.prompt)}>
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
          if (it.kind === "tool")
            return (
              <div key={`tool:${it.id}`} className="tool-chip" data-status={it.status}>
                <span className="tool-dot" /> <code>{it.name}</code>
                <span className="tool-sum">{it.status === "running" ? "执行中…" : it.summary}</span>
              </div>
            );
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
      <div className="chat-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chat-chip" disabled={busy || !connected} onClick={() => void onSend(s)}>
            {s}
          </button>
        ))}
      </div>
      {unconfigured && <button type="button" className="api-setup-notice" onClick={onSettings}>配置 API，开始与 Agent 对话 →</button>}
      <div className="composer-wrap">
      {selectedLayer && <div className="composer-context"><Layers size={12} /><span title={selectedLayer.name}>{selectedLayer.name}</span><small>当前图层</small></div>}
      <form className="chat-composer" onSubmit={submit}>
        <textarea ref={inputRef} autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="描述你的目标，例如：给这些点做 500 米缓冲，并按类别着色…" aria-label="对话消息"
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-toolbar"><button type="button" className="plain-icon" aria-label="对话中添加数据" title="添加数据" onClick={onAdd}><FolderPlus size={19} /></button><span>Enter 发送 · Shift+Enter 换行</span>
        {busy ? <button type="button" className="composer-send" aria-label="停止回复" onClick={onCancelTurn}><Square size={14} /></button> : <button type="submit" className="composer-send" aria-label="发送消息" disabled={!draft.trim() || !connected || unconfigured}><ArrowUp size={20} /></button>}</div>
      </form></div>
      <div className="agent-pane-footer"><span className="status-dot" data-state={connected ? "ok" : "error"} /><span>{busy ? "正在处理任务" : "直接对话，或使用工具箱"}</span><span>本地工作区</span></div>
        </>
      )}
    </aside>
  );
}
