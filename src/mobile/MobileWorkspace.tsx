import { useEffect, useRef, useState } from "react";
import type { AgentWorkspaceContext, useAgent } from "../lib/agent";
import type { LayerSelection, LayerStyle, DataLayer } from "../lib/dataLayers";
import type { WorkspaceRecovery } from "../lib/workspace";
import type { AgentSessionStub } from "../lib/workspace";
import { browserRuntime } from "../lib/runtime";
import { engineRequest } from "../lib/service";
import { MapCanvas, type TiphysMapView } from "../components/MapCanvas";
import { MapLegend } from "../components/MapLegend";
import { AttributeTable } from "../components/AttributeTable";
import { LayerProperties } from "../components/LayerProperties";
import { MobileDock, type MobileTab } from "./MobileDock";
import { MobileBottomCard } from "./MobileBottomCard";
import { MobileMapChrome } from "./MobileMapChrome";
import { MobileMapAskBar } from "./MobileMapAskBar";
import { MobileLayersSheet } from "./MobileLayersSheet";
import { MobileToolbox } from "./MobileToolbox";
import { MobileChatPage, type ChatSendContext } from "./MobileChatPage";
import { MobileTasksPage, TaskDetail } from "./MobileTasksPage";
import { MobilePage } from "./MobilePage";
import { MobileProjectPage } from "./MobileProjectPage";
import { MobileSheet } from "./MobileSheet";
import type { TaskCardEvent } from "../components/TaskCards";
import type { ToolTaskEvent } from "../components/ToolPanel";
import {
  createTask, getTask, getTasksSnapshot, initTaskStore, patchTask, setTaskValidation,
  TASK_SOURCE_LABEL, useTasks, verifyTaskOutputs, type TaskEngine, type TaskRecord,
} from "../lib/mobile/taskStore";
import {
  applyPlanSummary, mapJobStatus, newTaskId, outputsFromToolResult, planIssueChecks, planStepsFromPlan, type PlanSummary,
} from "../lib/mobile/taskBridge";
import {
  DEFAULT_PROJECT_ID, createProject, deleteProject, getCurrentProject, getCurrentProjectId, initProjectStore,
  patchProject, renameProject, setCurrentProject, useCurrentProject, useProjects, type ProjectRecord,
} from "../lib/mobile/projectStore";
import { FolderKanban, Layers, ListChecks, MapPin, MessageSquareText, Palette, Plus, Scissors, Settings2, Shapes, Table2, Tags, Wrench } from "lucide-react";

type Agent = ReturnType<typeof useAgent>;
type PropertiesState = { id: string; tab: "style" | "labels" | "info" } | null;

export type MobileWorkspaceProps = {
  theme: "light" | "dark";
  agent: Agent;
  layers: DataLayer[];
  activeLayer?: DataLayer;
  onSelectLayer: (id: string) => void;
  selection: LayerSelection | null;
  onSelection: (selection: LayerSelection | null, additive: boolean) => void;
  onClearSelection: () => void;
  aoi: number[] | null;
  onAoi: (bounds: number[] | null) => void;
  focus: number[] | null;
  onFocusAll: () => void;
  onZoomBounds: (bounds: number[]) => void;
  onZoomLayer: (layer: DataLayer) => void;
  onAddData: () => void;
  importing: boolean;
  importNotice: string;
  onDismissNotice: () => void;
  sourceCrs: string;
  onSourceCrs: (value: string) => void;
  onRenameLayer: (id: string, name: string) => void;
  onReorderLayers: (ids: string[]) => void;
  onRemoveLayer: (layer: DataLayer) => void;
  onClipAoi: () => void;
  onOpenSettings: () => void;
  onTable: (id: string) => void;
  tableLayer?: DataLayer;
  onTableClose: () => void;
  onTableSelection: (featureIds: number[], additive: boolean) => void;
  properties: PropertiesState;
  propertyLayer?: DataLayer;
  onPropertiesChange: (value: PropertiesState) => void;
  onLayerStyle: (id: string, style: LayerStyle) => void;
  onMapStatus: (status: { lng: number; lat: number; zoom: number }) => void;
  engineState: "ok" | "error" | "pending";
  agentUnconfigured: boolean;
  agentProviderLabel: string;
  recoveryNote: WorkspaceRecovery | null;
  agentSession?: AgentSessionStub;
};

const TAB_LABEL: Record<MobileTab, string> = { chat: "对话", map: "地图", tasks: "任务", project: "工程" };

export function MobileWorkspace(props: MobileWorkspaceProps) {
  const {
    theme, agent, layers, activeLayer, onSelectLayer, selection, onSelection, onClearSelection, aoi, onAoi,
    focus, onFocusAll, onZoomBounds, onZoomLayer, onAddData, importing, importNotice, onDismissNotice, sourceCrs, onSourceCrs,
    onRenameLayer, onReorderLayers, onRemoveLayer, onClipAoi, onOpenSettings, onTable, tableLayer, onTableClose, onTableSelection,
    properties, propertyLayer, onPropertiesChange, onLayerStyle, onMapStatus, engineState, agentUnconfigured,
    agentProviderLabel, recoveryNote, agentSession,
  } = props;

  const [tab, setTab] = useState<MobileTab>("map");
  const [layersOpen, setLayersOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [toolboxTool, setToolboxTool] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [mapView, setMapView] = useState<TiphysMapView | null>(null);
  const [viewRequest, setViewRequest] = useState<{ token: number; view: TiphysMapView | null } | null>(null);
  const [bootDelay, setBootDelay] = useState(false);
  const [effects, setEffects] = useState<"full" | "lite">("full");
  const [formFocused, setFormFocused] = useState(false);

  const openTable = (id: string) => {
    setLayersOpen(false);
    setActionsOpen(false);
    setToolboxOpen(false);
    onTable(id);
  };

  useEffect(() => {
    const editable = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      if (target instanceof HTMLTextAreaElement) return true;
      if (target instanceof HTMLSelectElement) return true;
      if (target instanceof HTMLInputElement) {
        return !["checkbox", "radio", "range", "color", "file", "button", "submit", "reset"].includes(target.type);
      }
      return false;
    };
    const focusin = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest(".m-bottom-card")) { setFormFocused(false); return; }
      setFormFocused(editable(target));
    };
    const focusout = () => {
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".m-bottom-card")) { setFormFocused(false); return; }
        setFormFocused(editable(active));
      });
    };
    document.addEventListener("focusin", focusin);
    document.addEventListener("focusout", focusout);
    return () => {
      document.removeEventListener("focusin", focusin);
      document.removeEventListener("focusout", focusout);
    };
  }, []);

  const [storesReady, setStoresReady] = useState(false);
  const tasks = useTasks();
  const projects = useProjects();
  const currentProject = useCurrentProject();
  const layersRef = useRef(layers); layersRef.current = layers;
  const agentRef = useRef(agent); agentRef.current = agent;
  const toolboxOpenRef = useRef(false); toolboxOpenRef.current = toolboxOpen;
  const syncingRef = useRef(false);
  const bootstrappedRef = useRef(false);
  const prevLayerIdsRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef<Set<string>>(new Set());
  const pollErrorsRef = useRef<Map<string, number>>(new Map());
  const agentSeenRef = useRef<Set<string>>(new Set());
  const agentBootstrappedRef = useRef(false);
  const layerSyncRef = useRef<Set<string>>(new Set());
  const layerSyncTriesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    void Promise.all([initTaskStore(), initProjectStore()]).then(() => { if (alive) setStoresReady(true); });
    const timer = window.setTimeout(() => setBootDelay(true), 1500);
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const cores = navigator.hardwareConcurrency ?? 8;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setEffects(cores <= 4 || reduced ? "lite" : "full");
  }, []);

  /* ------------------------------------------------------------------ tasks */

  function createAgentJobTask(item: Extract<Agent["state"]["items"][number], { kind: "job" }>) {
    const id = `agent-${item.id}`;
    if (getTask(id)) return;
    const mapped = mapJobStatus(item.status);
    createTask({
      id, name: item.label, source: "agent", engine: "agent", status: mapped.status,
      stage: item.message ? `${mapped.stage} · ${item.message}` : mapped.stage,
      projectId: getCurrentProjectId(), conversationId: "default", goal: item.label,
      jobId: item.id, toolName: item.toolName, preLayerIds: layersRef.current.map(layer => layer.id),
    });
    if (Number.isFinite(item.progress)) patchTask(id, { progress: item.progress });
  }

  function createApprovalTask(item: Extract<Agent["state"]["items"][number], { kind: "approval" }>) {
    const id = `approval-${item.id}`;
    if (getTask(id)) return;
    createTask({
      id, name: `等待确认：${item.toolName}`, source: "agent", engine: "agent", status: "pending_approval",
      stage: "破坏性操作需要你的确认", projectId: getCurrentProjectId(), conversationId: "default",
      toolName: item.toolName, input: item.input, preLayerIds: layersRef.current.map(layer => layer.id),
    });
  }

  function updateAgentJob(item: Extract<Agent["state"]["items"][number], { kind: "job" }>) {
    const id = `agent-${item.id}`;
    const task = getTask(id);
    if (!task) return;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(task.status)) return;
    const mapped = mapJobStatus(item.status);
    const progress = Number.isFinite(item.progress) ? item.progress : task.progress;
    const stage = item.message ? `${mapped.stage} · ${item.message}` : mapped.stage;
    if (item.status === "completed") {
      const before = new Set(task.preLayerIds ?? []);
      const outputs = layersRef.current.filter(layer => !before.has(layer.id)).map(layer => ({ layerId: layer.id, name: layer.name, kind: layer.kind }));
      patchTask(id, { status: "validating", stage: "执行结束，正在验证成果", progress: progress ?? 1, outputs, finishedAt: Date.now() },
        { text: `Agent 任务执行结束${item.message ? `：${item.message}` : ""}`, level: "success" });
      return;
    }
    if (item.status === "failed" || item.status === "cancelled" || item.status === "interrupted") {
      patchTask(id, { status: mapped.status, stage: mapped.stage, progress, error: item.message || mapped.stage, finishedAt: Date.now() },
        { text: item.message || mapped.stage, level: item.status === "failed" ? "error" : "warn" });
      return;
    }
    if (task.status !== mapped.status || task.stage !== stage || task.progress !== progress) {
      patchTask(id, { status: mapped.status, stage, progress }, item.message && !task.stage.includes(item.message) ? { text: item.message } : undefined);
    }
  }

  function updateApproval(item: Extract<Agent["state"]["items"][number], { kind: "approval" }>) {
    const id = `approval-${item.id}`;
    const task = getTask(id);
    if (!task || task.status !== "pending_approval") return;
    if (item.state === "approved") {
      patchTask(id, { status: "waiting", stage: "已批准，等待执行结果" }, { text: "用户已允许该操作", level: "success" });
    } else if (item.state === "rejected") {
      patchTask(id, { status: "cancelled", stage: "已拒绝", finishedAt: Date.now() }, { text: "用户拒绝了该操作", level: "warn" });
    } else if (item.state === "expired") {
      patchTask(id, { status: "cancelled", stage: "审批已失效", finishedAt: Date.now() }, { text: "审批请求已失效", level: "warn" });
    }
  }

  function updateApprovalTool(item: Extract<Agent["state"]["items"][number], { kind: "tool" }>) {
    const id = `approval-${item.id}`;
    const task = getTask(id);
    if (!task) return;
    if (item.status === "done") {
      const before = new Set(task.preLayerIds ?? []);
      const outputs = layersRef.current.filter(layer => !before.has(layer.id)).map(layer => ({ layerId: layer.id, name: layer.name, kind: layer.kind }));
      patchTask(id, { status: "validating", stage: "已执行，正在验证成果", outputs, finishedAt: Date.now() }, { text: "操作已执行，开始验证成果", level: "success" });
    } else if (item.status === "error") {
      patchTask(id, { status: "failed", stage: "执行失败", error: item.summary ?? "操作执行失败", finishedAt: Date.now() }, { text: item.summary ?? "操作执行失败", level: "error" });
    } else if (item.status === "rejected") {
      patchTask(id, { status: "cancelled", stage: "已拒绝", finishedAt: Date.now() });
    }
  }

  useEffect(() => {
    if (!agent.state.hydrated) return;
    const items = agent.state.items;
    if (!agentBootstrappedRef.current) {
      agentBootstrappedRef.current = true;
      for (const item of items) {
        agentSeenRef.current.add(`${item.kind}:${item.id}`);
        if (item.kind === "job" && ["queued", "running", "cancelling"].includes(item.status)) createAgentJobTask(item);
        if (item.kind === "approval" && item.state === "pending") createApprovalTask(item);
      }
      return;
    }
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      if (item.kind === "job") {
        if (!agentSeenRef.current.has(key)) { agentSeenRef.current.add(key); createAgentJobTask(item); }
        updateAgentJob(item);
      } else if (item.kind === "approval") {
        if (!agentSeenRef.current.has(key)) { agentSeenRef.current.add(key); createApprovalTask(item); }
        updateApproval(item);
      } else if (item.kind === "tool") {
        agentSeenRef.current.add(key);
        updateApprovalTool(item);
      }
    }
  }, [agent.state.items, agent.state.hydrated]);

  function finishToolTask(taskId: string, result: Record<string, any> | null | undefined, merge = true) {
    const task = getTask(taskId);
    if (!task || task.status === "validating" || task.status === "succeeded") return;
    const outputs = outputsFromToolResult(result);
    patchTask(taskId, { status: "validating", stage: "执行结束，正在验证成果", progress: 1, outputs, finishedAt: Date.now(), error: undefined },
      { text: "执行完成，开始验证成果", level: "success" });
    if (merge && result && Object.keys(result).length) agentRef.current.mergeToolResult(result);
  }

  function applyPlanResultToTask(task: TaskRecord, summary: PlanSummary) {
    const result = applyPlanSummary(summary);
    const issues = planIssueChecks(summary);
    const checks = [...result.checks, ...issues];
    const finishedAt = Date.now();
    if (summary.status === "completed" && !issues.length) {
      patchTask(task.id, {
        status: "validating", stage: result.stage, steps: result.steps, outputs: result.outputs, runId: summary.run_id,
        finishedAt, validation: { passed: false, verdict: "正在核对输出与验收断言…", checks, at: finishedAt },
      }, { text: summary.headline ?? "计划执行完成，开始验证成果", level: "success" });
      return;
    }
    patchTask(task.id, {
      status: summary.status === "cancelled" ? "cancelled" : "failed",
      stage: result.stage, steps: result.steps, outputs: result.outputs, runId: summary.run_id, finishedAt,
      error: summary.blocked_at?.message ?? summary.headline ?? result.stage,
      validation: { passed: false, verdict: summary.headline ?? result.stage, checks, at: finishedAt },
    }, { text: summary.headline ?? result.stage, level: "error" });
  }

  function handleToolTask(event: ToolTaskEvent) {
    const engine: TaskEngine = browserRuntime ? "browser-wasm" : event.tool.startsWith("wasm_") ? "browser-wasm" : "python-mcp";
    const mapped = mapJobStatus(event.status === "submitting" ? "queued" : event.status);
    const existing = getTask(event.taskId);
    if (!existing) {
      createTask({
        id: event.taskId, name: event.label, source: "manual", engine,
        status: event.status === "completed" ? "running" : mapped.status,
        stage: event.message ? `${mapped.stage} · ${event.message}` : mapped.stage,
        projectId: getCurrentProjectId(), goal: event.label, toolName: event.tool, params: event.args,
        jobId: event.jobId, preLayerIds: layersRef.current.map(layer => layer.id),
        retry: { kind: "tool", tool: event.tool, args: event.args },
      });
    } else {
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(existing.status)) return;
      const stage = event.message ? `${mapped.stage} · ${event.message}` : mapped.stage;
      if (existing.status !== mapped.status || existing.stage !== stage || existing.jobId !== event.jobId) {
        patchTask(event.taskId, {
          status: event.status === "completed" ? existing.status : mapped.status,
          stage: event.status === "completed" ? existing.stage : stage,
          jobId: event.jobId ?? existing.jobId,
          progress: Number.isFinite(event.progress) ? event.progress : existing.progress,
        });
      }
    }
    if (event.status === "completed") finishToolTask(event.taskId, event.result, false);
    else if (event.status === "failed") patchTask(event.taskId, { status: "failed", stage: "执行失败", error: event.error ?? event.message, finishedAt: Date.now() }, { text: event.error ?? event.message, level: "error" });
    else if (event.status === "cancelled" || event.status === "interrupted") patchTask(event.taskId, { status: mapped.status, stage: mapped.stage, finishedAt: Date.now() });
  }

  function handleTaskCardEvent(event: TaskCardEvent) {
    if (event.type === "start") {
      createTask({
        id: event.taskId, name: event.title, source: "card", engine: "browser-wasm", status: "running",
        stage: "计划已提交，正在执行", projectId: getCurrentProjectId(), conversationId: "default",
        goal: event.goal, plan: event.plan, steps: planStepsFromPlan(event.plan as { steps?: { id: string; title?: string }[] }),
        preLayerIds: layersRef.current.map(layer => layer.id), retry: { kind: "plan", plan: event.plan },
      });
      return;
    }
    const task = getTask(event.taskId);
    if (!task) return;
    if (event.error) {
      patchTask(event.taskId, { status: "failed", stage: "执行失败", error: event.error, finishedAt: Date.now() }, { text: event.error, level: "error" });
      return;
    }
    if (!event.summary) {
      patchTask(event.taskId, { status: "failed", stage: "执行结束但没有返回结果", finishedAt: Date.now() }, { text: "引擎没有返回可验证的结果", level: "error" });
      return;
    }
    applyPlanResultToTask(task, event.summary);
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (toolboxOpenRef.current) return;
      for (const task of getTasksSnapshot()) {
        if (!task.jobId || task.source === "agent") continue;
        if (!["queued", "running"].includes(task.status)) continue;
        if (pollingRef.current.has(task.id)) continue;
        pollingRef.current.add(task.id);
        void (async () => {
          try {
            const job = await (await engineRequest(`/jobs/${encodeURIComponent(task.jobId!)}`)).json();
            pollErrorsRef.current.delete(task.id);
            if (job.status === "completed") {
              if (task.plan) applyPlanResultToTask(task, (job.result ?? {}) as PlanSummary);
              else finishToolTask(task.id, job.result ?? {});
            } else if (["failed", "cancelled", "interrupted"].includes(job.status)) {
              const mapped = mapJobStatus(job.status);
              patchTask(task.id, {
                status: mapped.status, stage: mapped.stage, error: job.error ?? job.message ?? mapped.stage,
                finishedAt: Date.now(), progress: Number.isFinite(job.progress) ? job.progress : task.progress,
              }, { text: job.error ?? job.message ?? mapped.stage, level: job.status === "failed" ? "error" : "warn" });
            } else {
              const mapped = mapJobStatus(job.status);
              const progress = Number.isFinite(job.progress) ? job.progress : task.progress;
              const stage = job.message ? `${mapped.stage} · ${job.message}` : mapped.stage;
              if (task.status !== mapped.status || task.stage !== stage || task.progress !== progress) {
                patchTask(task.id, { status: mapped.status, stage, progress }, job.message ? { text: String(job.message) } : undefined);
              }
            }
          } catch (error) {
            const count = (pollErrorsRef.current.get(task.id) ?? 0) + 1;
            pollErrorsRef.current.set(task.id, count);
            if (count >= 4) {
              patchTask(task.id, { status: "interrupted", stage: "无法读取任务状态", error: String(error), finishedAt: Date.now() },
                { text: "连续多次无法读取任务状态，已标记中断", level: "warn" });
            }
          } finally {
            pollingRef.current.delete(task.id);
          }
        })();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const task of getTasksSnapshot()) {
        if (task.status !== "validating") continue;
        const missing = task.outputs.some(output => output.layerId && !layersRef.current.some(layer => layer.id === output.layerId));
        if (missing) {
          const tries = layerSyncTriesRef.current.get(task.id) ?? 0;
          if (tries < 2 && !layerSyncRef.current.has(task.id)) {
            layerSyncTriesRef.current.set(task.id, tries + 1);
            layerSyncRef.current.add(task.id);
            void (async () => {
              try {
                const response = await engineRequest("/tools/run", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: "list_layers", arguments: {} }),
                });
                const body = await response.json();
                const known = new Set(layersRef.current.map(layer => layer.id));
                for (const layer of Array.isArray(body.layers) ? body.layers : []) {
                  if (layer?.id && !known.has(layer.id) && task.outputs.some(output => output.layerId === layer.id)) {
                    agentRef.current.mergeToolResult({ layer });
                  }
                }
              } catch {
                // The engine may be busy; the bounded wait below still produces an honest verdict.
              } finally {
                layerSyncRef.current.delete(task.id);
              }
            })();
          }
          if (Date.now() - (task.finishedAt ?? task.createdAt) < 5200) continue;
        }
        if (Date.now() - (task.finishedAt ?? task.createdAt) < 2200) continue;
        setTaskValidation(task.id, verifyTaskOutputs(task, layersRef.current));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  /* --------------------------------------------------------------- projects */

  function applyProject(project: ProjectRecord, options: { stay?: boolean } = {}) {
    syncingRef.current = true;
    setCurrentProject(project.id);
    const ids = new Set(project.layerIds);
    for (const layer of layersRef.current) {
      const visible = ids.has(layer.id) ? (project.visibility[layer.id] ?? true) : false;
      if ((layer.visible !== false) !== visible) agentRef.current.setLayerVisibility(layer.id, visible);
    }
    const order = layersRef.current.filter(layer => ids.has(layer.id)).map(layer => layer.id);
    if (order.length) onReorderLayers(order);
    onAoi(project.aoi);
    if (project.mapView) {
      setMapView(project.mapView);
      setViewRequest({ token: Date.now(), view: project.mapView });
    }
    if (activeLayer && !ids.has(activeLayer.id)) {
      const first = layersRef.current.find(layer => ids.has(layer.id));
      if (first) onSelectLayer(first.id);
    }
    prevLayerIdsRef.current = new Set(layersRef.current.map(layer => layer.id));
    window.setTimeout(() => { syncingRef.current = false; }, 480);
    closeSheets();
    if (!options.stay) setTab("map");
  }

  function closeSheets() {
    setLayersOpen(false);
    setActionsOpen(false);
    setToolboxOpen(false);
    setDetailTaskId(null);
  }

  useEffect(() => {
    if (!storesReady || !currentProject) return;
    if (!(agent.state.hydrated || bootDelay)) return;
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    prevLayerIdsRef.current = new Set(layers.map(layer => layer.id));
    if (currentProject.layerIds.length || currentProject.mapView) {
      applyProject(currentProject, { stay: true });
    } else if (currentProject.id === DEFAULT_PROJECT_ID && layers.length) {
      patchProject(currentProject.id, {
        layerIds: layers.map(layer => layer.id),
        visibility: Object.fromEntries(layers.map(layer => [layer.id, layer.visible !== false])),
      });
    }
  }, [storesReady, currentProject, agent.state.hydrated, bootDelay, layers]);

  useEffect(() => {
    if (!bootstrappedRef.current) {
      prevLayerIdsRef.current = new Set(layers.map(layer => layer.id));
      return;
    }
    if (!storesReady || !currentProject) return;
    if (!agent.state.hydrated && !browserRuntime) return;
    const ids = layers.map(layer => layer.id);
    const previous = prevLayerIdsRef.current;
    const added = ids.filter(id => !previous.has(id));
    const removed = [...previous].filter(id => !ids.includes(id));
    prevLayerIdsRef.current = new Set(ids);
    if (!added.length && !removed.length) return;
    let layerIds = currentProject.layerIds.filter(id => !removed.includes(id));
    const visibility = { ...currentProject.visibility };
    for (const id of removed) delete visibility[id];
    for (const id of added) {
      if (!layerIds.includes(id)) layerIds.push(id);
      visibility[id] = true;
    }
    patchProject(currentProject.id, { layerIds, visibility });
    // A newly imported or computed layer should be visible immediately: fit the
    // hidden map to its real bounds so switching back to the map is meaningful.
    const bounds = layers.filter(layer => added.includes(layer.id) && layer.bounds).map(layer => layer.bounds!);
    if (bounds.length) {
      onZoomBounds([
        Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])),
        Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3])),
      ]);
    }
  }, [layers, currentProject, storesReady, agent.state.hydrated]);

  useEffect(() => {
    if (!bootstrappedRef.current || !currentProject || syncingRef.current) return;
    const existing = new Set(currentProject.layerIds.filter(id => layers.some(layer => layer.id === id)));
    const ordered = layers.filter(layer => existing.has(layer.id)).map(layer => layer.id);
    const extras = currentProject.layerIds.filter(id => !existing.has(id));
    const next = [...ordered, ...extras];
    if (next.join("|") !== currentProject.layerIds.join("|")) patchProject(currentProject.id, { layerIds: next });
  }, [layers, currentProject]);

  useEffect(() => {
    if (!bootstrappedRef.current || !currentProject || syncingRef.current) return;
    const visibility: Record<string, boolean> = {};
    for (const layer of layers) {
      if (!currentProject.layerIds.includes(layer.id)) continue;
      const visible = layer.visible !== false;
      if (currentProject.visibility[layer.id] !== visible) visibility[layer.id] = visible;
    }
    if (Object.keys(visibility).length) patchProject(currentProject.id, { visibility: { ...currentProject.visibility, ...visibility } });
  }, [layers, currentProject]);

  useEffect(() => {
    if (!bootstrappedRef.current || !currentProject) return;
    const saved = currentProject.aoi;
    const same = (!aoi && !saved) || (!!aoi && !!saved && aoi.join(",") === saved.join(","));
    if (!same) patchProject(currentProject.id, { aoi });
  }, [aoi, currentProject]);

  const handleViewChange = (view: TiphysMapView) => {
    setMapView(view);
    if (!bootstrappedRef.current || !currentProject || syncingRef.current) return;
    const saved = currentProject.mapView;
    if (saved && saved.lng === view.lng && saved.lat === view.lat && saved.zoom === view.zoom && saved.mode === view.mode && saved.basemap === view.basemap) return;
    patchProject(currentProject.id, { mapView: view });
  };

  /* ------------------------------------------------------------------ actions */

  const send = async (text: string, context: ChatSendContext) => {
    if (!agent.state.connected) { setTab("chat"); return false; }
    const workspace: AgentWorkspaceContext = {
      aoi: context.includeAoi ? aoi : null,
      selectedLayerId: context.includeLayer ? activeLayer?.id ?? null : null,
      selectedLayerName: context.includeLayer ? activeLayer?.name ?? null : null,
      selection: context.includeSelection ? selection : null,
      recovery: recoveryNote,
      agentSession,
    };
    return agent.send(text, workspace);
  };

  const openToolbox = (tool: string | null = null, layerId?: string) => {
    if (layerId) onSelectLayer(layerId);
    setToolboxTool(tool);
    setToolboxOpen(true);
    setLayersOpen(false);
    setActionsOpen(false);
  };

  const openActions = () => {
    setLayersOpen(false);
    setActionsOpen(true);
  };

  const locateLayer = (layerId: string) => {
    const layer = layers.find(item => item.id === layerId);
    if (!layer?.bounds) return;
    setDetailTaskId(null);
    setTab("map");
    onZoomBounds(layer.bounds);
  };

  const approveTask = (task: TaskRecord, approved: boolean) => {
    if (!task.approval) return;
    agent.approve(task.approval.toolCallId, approved);
    patchTask(task.id, approved
      ? { status: "waiting", stage: "已批准，等待执行结果" }
      : { status: "cancelled", stage: "已拒绝", finishedAt: Date.now() },
    { text: approved ? "你允许了该操作" : "你拒绝了该操作", level: approved ? "success" : "warn" });
  };

  const cancelTask = (task: TaskRecord) => {
    if (!task.jobId) return;
    if (task.source === "agent") agent.cancelJob(task.jobId);
    else void engineRequest(`/jobs/${encodeURIComponent(task.jobId)}/cancel`, { method: "POST" }).catch(() => undefined);
    patchTask(task.id, { stage: "正在取消" }, { text: "已请求取消任务", level: "warn" });
  };

  const retryTask = async (task: TaskRecord) => {
    const retry = task.retry;
    if (!retry) return;
    const taskId = newTaskId(retry.kind === "plan" ? "plan" : "tool");
    const name = `重试 · ${task.name}`;
    createTask({
      id: taskId, name, source: "manual", engine: retry.kind === "plan" ? "browser-wasm" : (browserRuntime || retry.tool.startsWith("wasm_") ? "browser-wasm" : "python-mcp"),
      status: "queued", stage: "已重新提交", projectId: getCurrentProjectId(), conversationId: "default",
      goal: task.goal, toolName: retry.kind === "tool" ? retry.tool : "run_plan",
      params: retry.kind === "tool" ? retry.args : undefined, plan: retry.kind === "plan" ? retry.plan : undefined,
      preLayerIds: layersRef.current.map(layer => layer.id), retry,
    });
    setDetailTaskId(taskId);
    setTab("tasks");
    try {
      const response = await engineRequest("/tools/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: retry.kind === "tool" ? retry.tool : "run_plan", arguments: retry.kind === "tool" ? retry.args : { plan: retry.plan } }),
      });
      const body = await response.json();
      if (body.job_id) patchTask(taskId, { jobId: body.job_id, status: "queued", stage: "排队中" });
      else if (retry.kind === "plan") {
        const created = getTask(taskId);
        if (created) applyPlanResultToTask(created, body as PlanSummary);
      } else finishToolTask(taskId, body);
    } catch (error) {
      patchTask(taskId, { status: "failed", stage: "重新提交失败", error: String(error), finishedAt: Date.now() }, { text: String(error), level: "error" });
    }
  };

  /* --------------------------------------------------------------------- UI */

  const runningCount = tasks.filter(task => task.status === "queued" || task.status === "running").length;
  const pendingCount = tasks.filter(task => task.status === "pending_approval").length;
  const projectName = currentProject?.name ?? "默认工程";
  const propertyTab = properties?.tab;
  const detailTask = detailTaskId ? tasks.find(task => task.id === detailTaskId) ?? null : null;
  let lastAgentMessage: string | null = null;
  for (let index = agent.state.items.length - 1; index >= 0; index--) {
    const item = agent.state.items[index];
    if (item.kind === "msg" && item.role === "agent") { lastAgentMessage = item.text.replace(/\s+/g, " "); break; }
  }

  return <div className={"m-shell" + (effects === "lite" ? " m-shell-lite" : "")} data-tab={tab} data-form-focused={formFocused || undefined}>
    <div className="m-map-stage" aria-hidden={tab !== "map"}>
      <MapCanvas variant="mobile" theme={theme} dataLayers={layers} focusBounds={focus} onStatus={onMapStatus}
        selection={selection} onSelect={onSelection} aoi={aoi} onAoiChange={onAoi} onOpenTable={openTable}
        onViewChange={handleViewChange} viewRequest={viewRequest} onFitAll={onFocusAll} />
      <MapLegend layers={layers} onStyle={id => onPropertiesChange({ id, tab: "style" })} />
    </div>

    {tab === "map" && <>
      <MobileMapChrome projectName={projectName} engineState={engineState} layerCount={layers.length}
        onProject={() => setTab("project")} onLayers={() => setLayersOpen(true)} onTools={() => openToolbox(null)} />

      {(selection?.featureIds.length || aoi) && <div className="m-map-hud">
        {selection?.featureIds.length ? <span className="m-hud-chip"><strong>{selection.featureIds.length}</strong> 个要素已选
          <button type="button" aria-label="清除要素选择" onClick={onClearSelection}>×</button></span> : null}
        {aoi ? <span className="m-hud-chip" data-tone="accent">AOI 已设定<button type="button" aria-label="清除 AOI" onClick={() => onAoi(null)}>×</button></span> : null}
      </div>}

      {importNotice && <div className="m-map-banner" role="status">
        <span>{importNotice}</span>
        {importNotice.includes("CRS") && <label>源坐标系<input value={sourceCrs} onChange={event => onSourceCrs(event.target.value)} placeholder="如 EPSG:4547" /></label>}
        <button type="button" className="m-icon-btn" aria-label="关闭提示" onClick={onDismissNotice}>×</button>
      </div>}

      <MobileBottomCard active={tab} onChange={next => { setTab(next); if (next !== "map") setLayersOpen(false); }} running={runningCount} pending={pendingCount}
        status={<button type="button" className="m-bottom-status" onClick={() => setTab("chat")}>
          <span className="status-dot" data-state={agent.state.busy ? "pending" : agent.state.connected ? "ok" : "error"} />
          <span className="m-bottom-status-text">
            {agent.state.busy ? "TIPHYS 正在处理…" : lastAgentMessage ? lastAgentMessage.slice(0, 64) : agent.state.items.length ? `对话 · ${agent.state.items.length} 条` : "对话与任务卡"}
          </span>
          <MessageSquareText size={14} />
        </button>}>
        <MobileMapAskBar value={draft} onChange={setDraft} busy={agent.state.busy} connected={agent.state.connected} unconfigured={agentUnconfigured}
          onSend={async text => { const ok = await send(text, { includeLayer: true, includeSelection: true, includeAoi: true }); if (ok) setTab("chat"); return ok; }}
          onCancelTurn={agent.cancelTurn} onOpenActions={openActions} />
      </MobileBottomCard>
    </>}

    {tab === "chat" && <MobileChatPage
      projectName={projectName}
      items={agent.state.items}
      layers={layers}
      recovery={recoveryNote}
      busy={agent.state.busy}
      connected={agent.state.connected}
      unconfigured={agentUnconfigured}
      providerLabel={agentProviderLabel}
      activeLayer={activeLayer}
      selectionCount={selection?.featureIds.length ?? 0}
      hasAoi={!!aoi}
      tasks={tasks}
      draft={draft}
      onDraft={setDraft}
      onSend={send}
      onCancelTurn={agent.cancelTurn}
      onOpenTool={tool => openToolbox(tool)}
      onInsertPrompt={setDraft}
      onApprove={agent.approve}
      onCancelJob={agent.cancelJob}
      onTask={handleTaskCardEvent}
      onOpenTask={id => { setDetailTaskId(id); setTab("tasks"); }}
      onOpenTasks={() => setTab("tasks")}
      onOpenSettings={onOpenSettings}
      onOpenActions={openActions}
      onTab={next => { setTab(next); if (next !== "map") setLayersOpen(false); }}
      running={runningCount}
      pending={pendingCount}
    />}

    {tab === "tasks" && <MobileTasksPage
      tasks={tasks} projects={projects} currentProjectId={currentProject?.id ?? null}
      onOpenTask={id => { if (id) { setDetailTaskId(id); setTab("tasks"); } }}
      onOpenChat={() => { setDetailTaskId(null); setTab("chat"); }}
      onOpenToolbox={() => openToolbox(null)} />}

    {detailTask && <MobilePage open title="任务详情" subtitle={TASK_SOURCE_LABEL[detailTask.source]} overlay onBack={() => setDetailTaskId(null)}>
      <TaskDetail task={detailTask} layers={layers} connected={agent.state.connected}
        projectName={projects.find(project => project.id === detailTask.projectId)?.name ?? "未归属工程"}
        onApprove={approveTask} onCancel={cancelTask} onRetry={task => void retryTask(task)}
        onLocate={locateLayer} onTable={openTable}
        onOpenChat={() => { setDetailTaskId(null); setTab("chat"); }} />
    </MobilePage>}

    {tab === "project" && <MobileProjectPage
      projects={projects} currentProject={currentProject} layers={layers} tasks={tasks}
      mapView={mapView ?? currentProject?.mapView ?? null} aoi={aoi}
      onSwitch={id => { const project = projects.find(item => item.id === id); if (project) applyProject(project); }}
      onCreate={input => {
        const project = createProject({
          name: input.name, description: input.description,
          layerIds: input.includeLayers ? layers.map(layer => layer.id) : [],
          visibility: input.includeLayers ? Object.fromEntries(layers.map(layer => [layer.id, layer.visible !== false])) : {},
          mapView: mapView, aoi,
        });
        applyProject(project);
      }}
      onRename={(id, name) => renameProject(id, name)}
      onDelete={id => {
        deleteProject(id);
        const next = getCurrentProject();
        if (next) applyProject(next);
      }}
      onAddData={onAddData} onOpenLayers={() => setLayersOpen(true)} onOpenToolbox={() => openToolbox(null)} onOpenSettings={onOpenSettings}
      onSaveView={() => { if (currentProject) patchProject(currentProject.id, { mapView, aoi }); }}
      onAddLayer={id => {
        if (!currentProject) return;
        const layer = layers.find(item => item.id === id);
        patchProject(currentProject.id, {
          layerIds: [...currentProject.layerIds, id],
          visibility: { ...currentProject.visibility, [id]: true },
        });
        if (layer) agent.setLayerVisibility(id, true);
      }}
      onRemoveLayer={id => {
        if (!currentProject) return;
        patchProject(currentProject.id, {
          layerIds: currentProject.layerIds.filter(layerId => layerId !== id),
          visibility: { ...currentProject.visibility, [id]: false },
        });
        agent.setLayerVisibility(id, false);
      }}
      onLocate={layer => locateLayer(layer.id)} onTable={openTable}
      onOpenTask={id => { setDetailTaskId(id); setTab("tasks"); }} />}

    <MobileLayersSheet open={layersOpen} onClose={() => setLayersOpen(false)} layers={layers} selectedId={activeLayer?.id}
      onSelect={onSelectLayer} onToggle={agent.toggleLayer} onAdd={onAddData} importing={importing}
      importNotice={importNotice} onDismissNotice={onDismissNotice}
      onZoom={onZoomLayer} onTable={openTable} onProperties={(id, tab) => { setLayersOpen(false); onPropertiesChange({ id, tab }); }}
      onRename={onRenameLayer} onReorder={onReorderLayers} onRemove={onRemoveLayer}
      onOpenTool={(tool, layerId) => openToolbox(tool || null, layerId)} />

    <MobileToolbox open={toolboxOpen} onClose={() => setToolboxOpen(false)} layers={layers} selectedLayer={activeLayer}
      initialTool={toolboxTool} onResult={agent.mergeToolResult} onTask={handleToolTask}
      onOpenTask={id => { setToolboxOpen(false); setDetailTaskId(id); setTab("tasks"); }} />

    <MobileSheet open={actionsOpen} title="快捷操作" initialSnap={0} snapPoints={[0.58, 0.9]} onClose={() => setActionsOpen(false)}>
      <div className="m-action-grid">
        <button type="button" onClick={() => { setActionsOpen(false); onAddData(); }}><Plus size={20} /><span>添加数据</span></button>
        <button type="button" onClick={() => { setActionsOpen(false); setTab("map"); setLayersOpen(true); }}><Layers size={20} /><span>图层</span></button>
        <button type="button" onClick={() => { setActionsOpen(false); openToolbox(null); }}><Wrench size={20} /><span>工具箱</span></button>
        <button type="button" onClick={() => { setActionsOpen(false); setTab("tasks"); }}><ListChecks size={20} /><span>任务中心</span></button>
        <button type="button" onClick={() => { setActionsOpen(false); setTab("project"); }}><FolderKanban size={20} /><span>工程</span></button>
        {activeLayer && <button type="button" onClick={() => openTable(activeLayer.id)}><Table2 size={20} /><span>属性表</span></button>}
        {activeLayer && <button type="button" onClick={() => { setActionsOpen(false); onPropertiesChange({ id: activeLayer.id, tab: "style" }); }}><Palette size={20} /><span>符号化</span></button>}
        {activeLayer && <button type="button" onClick={() => { setActionsOpen(false); onPropertiesChange({ id: activeLayer.id, tab: "labels" }); }}><Tags size={20} /><span>标注</span></button>}
        {aoi && activeLayer && <button type="button" onClick={() => { setActionsOpen(false); onClipAoi(); }}><Scissors size={20} /><span>AOI 裁剪</span></button>}
        <button type="button" onClick={() => { setActionsOpen(false); onOpenSettings(); }}><Settings2 size={20} /><span>设置</span></button>
        <button type="button" onClick={() => { setActionsOpen(false); setTab("map"); onFocusAll(); }}><MapPin size={20} /><span>全图</span></button>
        <button type="button" onClick={() => { setActionsOpen(false); if (activeLayer) { setTab("map"); onZoomLayer(activeLayer); } }} disabled={!activeLayer}><Shapes size={20} /><span>缩放图层</span></button>
      </div>
    </MobileSheet>

    {tableLayer && <div className="m-fullscreen-panel" role="dialog" aria-modal="true" aria-label={`${tableLayer.name} 属性表`}>
      <AttributeTable key={tableLayer.id} layer={tableLayer}
        selectedIds={selection?.layerId === tableLayer.id ? selection.featureIds : []}
        onSelectionChange={onTableSelection} onClearSelection={onClearSelection} onClose={onTableClose} onZoom={onZoomBounds} />
    </div>}

    {propertyLayer && properties && <MobileSheet open title={propertyLayer.name}
      subtitle={`${propertyTab === "style" ? "符号化" : propertyTab === "labels" ? "标注" : "属性"} · 拖动调整高度，关闭返回图层`}
      initialSnap={0} snapPoints={[0.55, 0.92]}
      onClose={() => { onPropertiesChange(null); setLayersOpen(true); }}>
      <LayerProperties key={propertyLayer.id} embedded layer={propertyLayer} tab={propertyTab ?? "style"}
        onTab={tabValue => onPropertiesChange({ id: propertyLayer.id, tab: tabValue })}
        onStyle={style => onLayerStyle(propertyLayer.id, style)}
        onClose={() => { onPropertiesChange(null); setLayersOpen(true); }} />
    </MobileSheet>}

    {(tab === "tasks" || tab === "project") && <MobileDock active={tab} onChange={next => { setTab(next); if (next !== "map") setLayersOpen(false); }} running={runningCount} pending={pendingCount} />}
    <span className="sr-only" aria-live="polite">{TAB_LABEL[tab]}</span>
  </div>;
}
