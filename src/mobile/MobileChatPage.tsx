import { useMemo, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import type { TimelineItem } from "../lib/agent";
import type { WorkspaceRecovery } from "../lib/workspace";
import type { TaskRecord } from "../lib/mobile/taskStore";
import { TASK_STATUS_LABEL } from "../lib/mobile/taskStore";
import { ChatTimeline } from "../components/ChatTimeline";
import { MobileComposer } from "../components/MobileComposer";
import { MobileBottomCard } from "./MobileBottomCard";
import type { MobileTab } from "./MobileDock";
import type { TaskCardEvent } from "../components/TaskCards";
import { ChevronRight, FolderKanban, Layers, ListChecks, Settings2, Shapes, X } from "lucide-react";

export type ChatSendContext = { includeLayer: boolean; includeSelection: boolean; includeAoi: boolean };

type Props = {
  projectName: string;
  items: TimelineItem[];
  layers: DataLayer[];
  recovery: WorkspaceRecovery | null;
  busy: boolean;
  connected: boolean;
  unconfigured: boolean;
  providerLabel: string;
  activeLayer?: DataLayer;
  selectionCount: number;
  hasAoi: boolean;
  tasks: TaskRecord[];
  draft: string;
  onDraft: (value: string) => void;
  onSend: (text: string, context: ChatSendContext) => Promise<boolean>;
  onCancelTurn: () => void;
  onOpenTool: (tool: string) => void;
  onInsertPrompt: (text: string) => void;
  onApprove: (toolCallId: string, approved: boolean) => void;
  onCancelJob: (jobId: string) => void;
  onTask: (event: TaskCardEvent) => void;
  onOpenTask: (taskId: string) => void;
  onOpenTasks: () => void;
  onOpenSettings: () => void;
  onOpenActions: () => void;
  onTab: (tab: MobileTab) => void;
  running: number;
  pending: number;
};

const ACTIVE = new Set(["queued", "running", "validating", "waiting", "pending_approval"]);

export function MobileChatPage(props: Props) {
  const { projectName, items, layers, recovery, busy, connected, unconfigured, providerLabel, activeLayer, selectionCount, hasAoi, tasks,
    draft, onDraft, onSend, onCancelTurn, onOpenTool, onInsertPrompt, onApprove, onCancelJob, onTask, onOpenTask, onOpenTasks, onOpenSettings, onOpenActions,
    onTab, running, pending } = props;
  const [includeLayer, setIncludeLayer] = useState(true);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [includeAoi, setIncludeAoi] = useState(true);

  const activeTasks = useMemo(() => tasks.filter(task => ACTIVE.has(task.status)).slice(0, 3), [tasks]);

  return (
    <section className="m-page m-chat-page" aria-label="对话">
      <header className="m-chat-head">
        <div className="m-chat-heading">
          <span className="m-chat-kicker"><FolderKanban size={12} />{projectName}</span>
          <h1>对话</h1>
        </div>
        <div className="m-chat-head-actions">
          <button type="button" className="m-icon-btn m-counter-btn" aria-label={`任务中心，${activeTasks.length} 个进行中`} onClick={onOpenTasks}>
            <ListChecks size={19} />
            {activeTasks.length > 0 && <span>{activeTasks.length}</span>}
          </button>
          <button type="button" className="m-icon-btn" aria-label="设置" onClick={onOpenSettings}><Settings2 size={19} /></button>
        </div>
      </header>

      <div className="m-chat-scroll">
        {!connected && <div className="m-banner" role="status">
          <strong>Agent 未连接</strong>
          <span>{unconfigured ? "尚未配置 API；工具箱与任务卡仍可直接使用。" : "正在尝试连接本机 Agent；地图、工具箱与任务卡不受影响。"}</span>
          {unconfigured && <button type="button" onClick={onOpenSettings}>配置 API</button>}
        </div>}
        <ChatTimeline items={items} layers={layers} recovery={recovery} busy={busy} selectedLayerId={activeLayer?.id}
          onOpenTool={onOpenTool} onInsertPrompt={onInsertPrompt} onApprove={onApprove} onCancelJob={onCancelJob} onTask={onTask} />
      </div>

      {activeTasks.length > 0 && <div className="m-chat-taskbar" aria-label="进行中的任务">
        {activeTasks.map(task => <button key={task.id} type="button" onClick={() => onOpenTask(task.id)}>
          <span className="m-task-dot" data-status={task.status} />
          <span className="m-chat-task-name">{task.name}</span>
          <small>{TASK_STATUS_LABEL[task.status]} · {task.stage}</small>
          <ChevronRight size={14} />
        </button>)}
      </div>}

      <div className="m-context-bar" aria-label="对话上下文">
        <span className="m-context-chip" data-static="true" title="当前工程"><FolderKanban size={12} />{projectName}</span>
        {activeLayer && <button type="button" className="m-context-chip" data-off={!includeLayer} onClick={() => setIncludeLayer(value => !value)}
          title={includeLayer ? "本次发送包含该图层，点击排除" : "已排除，点击包含"}>
          <Layers size={12} />{activeLayer.name}
          {includeLayer ? <X size={11} /> : <small>已排除</small>}
        </button>}
        {selectionCount > 0 && <button type="button" className="m-context-chip" data-off={!includeSelection} onClick={() => setIncludeSelection(value => !value)}>
          <Shapes size={12} />{selectionCount} 个要素{includeSelection ? <X size={11} /> : <small>已排除</small>}
        </button>}
        {hasAoi && <button type="button" className="m-context-chip" data-off={!includeAoi} onClick={() => setIncludeAoi(value => !value)}>
          AOI{includeAoi ? <X size={11} /> : <small>已排除</small>}
        </button>}
      </div>

      <MobileBottomCard active="chat" onChange={onTab} running={running} pending={pending}
        status={<div className="m-bottom-status">
          <span className="m-status-dot" data-state={connected ? (unconfigured ? "warn" : "ok") : "error"} />
          <span className="m-bottom-status-text">{providerLabel}</span>
        </div>}>
        <MobileComposer value={draft} onChange={onDraft} busy={busy} connected={connected} unconfigured={unconfigured}
          onSend={async text => onSend(text, { includeLayer, includeSelection, includeAoi })} onCancelTurn={onCancelTurn}
          onActions={onOpenActions} placeholder="描述空间分析目标，或追问上一步…" />
      </MobileBottomCard>
    </section>
  );
}
