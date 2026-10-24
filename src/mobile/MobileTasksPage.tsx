import { useMemo, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import type { ProjectRecord } from "../lib/mobile/projectStore";
import {
  TASK_ENGINE_LABEL, TASK_SOURCE_LABEL, TASK_STATUS_LABEL, TASK_STATUS_TONE, taskStepsSummary,
  type TaskRecord, type TaskStatus,
} from "../lib/mobile/taskStore";
import { AlertTriangle, Check, CircleDashed, Clock3, ListChecks, MapPin, MessageSquareText, Play, RotateCcw, Square, Table2, TerminalSquare, X } from "lucide-react";

type Props = {
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  currentProjectId: string | null;
  onOpenTask: (taskId: string | null) => void;
  onOpenChat: () => void;
  onOpenToolbox: () => void;
};

const RUNNING = new Set<TaskStatus>(["queued", "running", "validating", "waiting"]);
const FAILED = new Set<TaskStatus>(["failed", "interrupted", "resumable"]);

function isToday(value?: number) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function formatTime(value?: number) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

function duration(task: TaskRecord) {
  if (!task.startedAt) return "—";
  const end = task.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function StatusChip({ status }: { status: TaskStatus }) {
  return <span className="m-task-status" data-tone={TASK_STATUS_TONE[status]}>
    <span className="m-task-status-dot" />{TASK_STATUS_LABEL[status]}
  </span>;
}

export function MobileTasksPage(props: Props) {
  const { tasks, projects, currentProjectId, onOpenTask, onOpenChat, onOpenToolbox } = props;
  const [filter, setFilter] = useState<"all" | "running" | "pending" | "failed" | "done">("all");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>(currentProjectId ?? "all");

  const counts = useMemo(() => ({
    running: tasks.filter(task => task.status === "queued" || task.status === "running").length,
    pending: tasks.filter(task => task.status === "pending_approval").length,
    failed: tasks.filter(task => FAILED.has(task.status)).length,
    doneToday: tasks.filter(task => task.status === "succeeded" && isToday(task.finishedAt)).length,
  }), [tasks]);

  const visible = useMemo(() => tasks.filter(task => {
    if (projectFilter !== "all" && task.projectId !== projectFilter) return false;
    if (filter === "running" && !RUNNING.has(task.status)) return false;
    if (filter === "pending" && task.status !== "pending_approval") return false;
    if (filter === "failed" && !FAILED.has(task.status)) return false;
    if (filter === "done" && task.status !== "succeeded") return false;
    const query = search.trim().toLocaleLowerCase();
    if (query && !`${task.name} ${task.goal ?? ""} ${task.stage} ${task.toolName ?? ""}`.toLocaleLowerCase().includes(query)) return false;
    return true;
  }), [tasks, filter, search, projectFilter]);

  const projectName = (id: string | null) => projects.find(project => project.id === id)?.name ?? "未归属工程";

  return <section className="m-page m-tasks-page" aria-label="任务中心">
    <header className="m-page-head m-tasks-head">
      <div className="m-page-heading">
        <h1>任务</h1>
        <div className="m-page-subtitle">统一执行记录 · Agent / 手动工具 / 任务卡</div>
      </div>
    </header>

    <div className="m-page-body m-tasks-body">
      <div className="m-stat-grid">
        <button type="button" className="m-stat" data-tone="info" onClick={() => setFilter("running")}><strong>{counts.running}</strong><span>运行中</span></button>
        <button type="button" className="m-stat" data-tone="warning" onClick={() => setFilter("pending")}><strong>{counts.pending}</strong><span>待确认</span></button>
        <button type="button" className="m-stat" data-tone="danger" onClick={() => setFilter("failed")}><strong>{counts.failed}</strong><span>失败</span></button>
        <button type="button" className="m-stat" data-tone="success" onClick={() => setFilter("done")}><strong>{counts.doneToday}</strong><span>今日完成</span></button>
      </div>

      <label className="m-search">
        <ListChecks size={16} />
        <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务名称、目标或工具" aria-label="搜索任务" />
      </label>

      <div className="m-chip-row" role="tablist" aria-label="任务状态筛选">
        {([["all", "全部"], ["running", "进行中"], ["pending", "待确认"], ["failed", "失败"], ["done", "已完成"]] as const).map(([id, label]) =>
          <button key={id} type="button" role="tab" aria-selected={filter === id} data-active={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      </div>

      {projects.length > 1 && <label className="m-select-inline">
        <span>工程</span>
        <select value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
          <option value="all">全部工程</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>}

      <div className="m-task-list">
        {visible.map(task => {
          const { done, total } = taskStepsSummary(task);
          return <button key={task.id} type="button" className="m-task-row" data-status={task.status} onClick={() => onOpenTask(task.id)}>
            <div className="m-task-row-head">
              <StatusChip status={task.status} />
              <span className="m-task-row-time">{formatTime(task.createdAt)}</span>
            </div>
            <strong>{task.name}</strong>
            <small>{task.stage}</small>
            <div className="m-task-row-foot">
              <span>{TASK_SOURCE_LABEL[task.source]} · {TASK_ENGINE_LABEL[task.engine]}</span>
              <span>{projectName(task.projectId)}</span>
              {total > 0 && <span>步骤 {done}/{total}</span>}
              {task.validation && <span data-ok={task.validation.passed}>{task.validation.passed ? "验证通过" : "验证未通过"}</span>}
            </div>
          </button>;
        })}
        {!visible.length && <div className="m-empty-state">
          <ListChecks size={22} />
          <strong>{tasks.length ? "没有符合筛选的任务" : "还没有任务"}</strong>
          <span>{tasks.length ? "换一个状态或工程筛选。" : "从对话、任务卡或工具箱发起一次真实分析，任务会在这里统一记录。"}</span>
          <div><button type="button" className="m-btn m-btn-primary" onClick={onOpenChat}><MessageSquareText size={15} />去对话</button>
            <button type="button" className="m-btn" onClick={onOpenToolbox}><Play size={15} />打开工具箱</button></div>
        </div>}
      </div>
    </div>
  </section>;
}

export function TaskDetail({ task, layers, connected, projectName, onApprove, onCancel, onRetry, onLocate, onTable, onOpenChat }: {
  task: TaskRecord; layers: DataLayer[]; connected: boolean; projectName: string;
  onApprove: (task: TaskRecord, approved: boolean) => void;
  onCancel: (task: TaskRecord) => void;
  onRetry: (task: TaskRecord) => void;
  onLocate: (layerId: string) => void;
  onTable: (layerId: string) => void;
  onOpenChat: () => void;
}) {
  const { done, total } = taskStepsSummary(task);
  const canCancel = (task.status === "queued" || task.status === "running") && !!task.jobId && (task.source === "agent" ? connected : true);
  const canRetry = (FAILED.has(task.status) || task.status === "cancelled") && !!task.retry;
  const outputs = task.outputs.map(output => ({ ...output, layer: output.layerId ? layers.find(layer => layer.id === output.layerId) : undefined }));

  return <div className="m-task-detail">
    <div className="m-detail-hero">
      <div className="m-detail-hero-top"><StatusChip status={task.status} /><span>{formatTime(task.createdAt)}</span></div>
      <h2>{task.name}</h2>
      <p>{task.stage}</p>
      <div className="m-detail-meta">
        <span>{TASK_SOURCE_LABEL[task.source]} · {TASK_ENGINE_LABEL[task.engine]}</span>
        <span>{projectName}</span>
        <span>耗时 {duration(task)}</span>
      </div>
      {task.progress !== null && <div className="m-detail-progress">
        <span style={{ width: `${Math.round(Math.max(0, Math.min(1, task.progress)) * 100)}%` }} />
        <small>引擎报告 {Math.round(task.progress * 100)}%</small>
      </div>}
      {task.progress === null && total > 0 && <div className="m-detail-steps">步骤 {done}/{total} · 引擎未提供百分比进度，不推算</div>}
    </div>

    {(task.status === "pending_approval" || canCancel || canRetry || !!task.conversationId) && <div className="m-detail-actions">
      {task.status === "pending_approval" && <>
        <button type="button" className="m-btn m-btn-primary" onClick={() => onApprove(task, true)}><Check size={15} />允许执行</button>
        <button type="button" className="m-btn m-btn-danger" onClick={() => onApprove(task, false)}><X size={15} />拒绝</button>
      </>}
      {canCancel && <button type="button" className="m-btn m-btn-danger" onClick={() => onCancel(task)}><Square size={14} />取消任务</button>}
      {canRetry && <button type="button" className="m-btn m-btn-primary" onClick={() => onRetry(task)}><RotateCcw size={15} />重新运行</button>}
      {task.conversationId && <button type="button" className="m-btn" onClick={onOpenChat}><MessageSquareText size={15} />返回对话</button>}
    </div>}

    {task.error && <div className="m-detail-error" role="alert"><AlertTriangle size={16} /><div><strong>{task.error}</strong><span>错误来自真实执行结果，已计入任务日志。</span></div></div>}

    {task.validation && <section className="m-detail-section">
      <h3>{task.status === "validating" ? "正在验证…" : task.validation.passed ? "验证通过" : "验证未通过"}</h3>
      <p className="m-detail-verdict">{task.validation.verdict}</p>
      <ul className="m-check-list">
        {task.validation.checks.map((check, index) => <li key={index} data-ok={check.ok}>
          {check.ok ? <Check size={14} /> : <X size={14} />}
          <div><strong>{check.label}</strong><span>{check.evidence}</span></div>
        </li>)}
      </ul>
    </section>}

    <section className="m-detail-section">
      <h3>步骤</h3>
      {task.steps.length ? <ol className="m-step-list">
        {task.steps.map(step => <li key={step.id} data-status={step.status}>
          <span className="m-step-dot" />
          <div><strong>{step.label}</strong>{step.detail && <span>{step.detail}</span>}</div>
          <small>{step.status === "done" ? "完成" : step.status === "running" ? "进行中" : step.status === "failed" ? "失败" : step.status === "skipped" ? "跳过" : "等待"}</small>
        </li>)}
      </ol> : <p className="m-muted">该来源没有提供可分解的步骤；这里不补造步骤。</p>}
    </section>

    <section className="m-detail-section">
      <h3>输入与参数</h3>
      {task.goal && <p className="m-detail-goal">{task.goal}</p>}
      {task.input !== undefined && <details><summary>查看输入</summary><pre>{JSON.stringify(task.input, null, 2)}</pre></details>}
      {task.params && <details><summary>查看参数</summary><pre>{JSON.stringify(task.params, null, 2)}</pre></details>}
      {task.approval && <div className="m-approval-input"><strong>待确认操作：{task.approval.toolName}</strong><pre>{JSON.stringify(task.approval.input, null, 2)}</pre></div>}
      {!task.goal && task.input === undefined && !task.params && !task.approval && <p className="m-muted">该任务没有留存可展示的输入参数。</p>}
    </section>

    <section className="m-detail-section">
      <h3>输出成果 · {outputs.length}</h3>
      {outputs.length ? <div className="m-output-list">
        {outputs.map((output, index) => <div key={index} className="m-output-row">
          <div><strong>{output.name}</strong><span>{output.layer ? `图层 ${output.layer.kind === "raster" ? "栅格" : output.layer.kind === "table" ? "表格" : `${output.layer.feature_count} 个要素`}${output.layer.crs ? ` · ${output.layer.crs}` : " · 未声明坐标系"}` : output.path ? `文件 ${output.path}` : output.url ? "可下载文件" : "工作区中已找不到该图层"}</span></div>
          <div>
            {output.layer && <button type="button" className="m-icon-btn" aria-label={`定位 ${output.name}`} onClick={() => onLocate(output.layer!.id)}><MapPin size={16} /></button>}
            {output.layer && output.layer.kind !== "raster" && <button type="button" className="m-icon-btn" aria-label={`${output.name} 属性表`} onClick={() => onTable(output.layer!.id)}><Table2 size={16} /></button>}
            {output.url && <a className="m-btn m-btn-small" href={output.url} download={output.name}>下载</a>}
          </div>
        </div>)}
      </div> : <p className="m-muted">执行尚未产出成果，或该工具是只读操作。</p>}
    </section>

    <section className="m-detail-section">
      <h3><TerminalSquare size={15} />执行日志 · {task.logs.length}</h3>
      <ol className="m-log-list">
        {task.logs.map((log, index) => <li key={index} data-level={log.level}>
          <time>{new Date(log.ts).toLocaleTimeString("zh-CN", { hour12: false })}</time>
          <span>{log.text}</span>
        </li>)}
      </ol>
    </section>

    <div className="m-detail-foot">
      <span><Clock3 size={13} />创建 {formatTime(task.createdAt)}</span>
      {task.finishedAt && <span>结束 {formatTime(task.finishedAt)}</span>}
      {task.jobId && <span>job {task.jobId.slice(0, 12)}</span>}
      {task.runId && <span>run {task.runId.slice(0, 12)}</span>}
    </div>
    {task.status === "running" && <div className="m-detail-live"><CircleDashed size={13} />状态正在从真实执行事件更新</div>}
  </div>;
}
