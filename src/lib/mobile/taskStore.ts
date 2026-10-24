/**
 * Mobile task ledger (V2.2).
 *
 * One record per real execution, regardless of who started it:
 *   - Agent jobs / approvals (SSE timeline)
 *   - Manual GIS tool jobs (ToolPanel)
 *   - Audited plan runs (TaskCards)
 *
 * Status only advances on evidence from those sources. Progress is stored only
 * when the engine reports it; otherwise the UI shows completed/total steps.
 * Records survive reloads in IndexedDB. A browser task that was mid-flight when
 * the page closed is marked "interrupted" on the next load — never "succeeded".
 */
import { openDB, type IDBPDatabase } from "idb";
import { useSyncExternalStore } from "react";

export type TaskStatus =
  | "draft"
  | "pending_approval"
  | "queued"
  | "running"
  | "waiting"
  | "validating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "resumable";

export type TaskSource = "agent" | "manual" | "card";
export type TaskEngine = "browser-wasm" | "python-mcp" | "agent";
export type TaskLogLevel = "info" | "warn" | "error" | "success";

export type TaskStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
};

export type TaskLog = { ts: number; level: TaskLogLevel; text: string };
export type TaskOutput = { layerId?: string; name: string; kind?: string; path?: string; url?: string };
export type ValidationCheck = { label: string; ok: boolean; evidence: string };
export type TaskValidation = { passed: boolean; verdict: string; checks: ValidationCheck[]; at: number };

export type TaskRecord = {
  id: string;
  name: string;
  source: TaskSource;
  engine: TaskEngine;
  status: TaskStatus;
  stage: string;
  /** Real engine progress (0–1) when the engine reports it; otherwise null. */
  progress: number | null;
  projectId: string | null;
  conversationId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  goal?: string;
  input?: unknown;
  params?: Record<string, unknown>;
  steps: TaskStep[];
  logs: TaskLog[];
  outputs: TaskOutput[];
  validation?: TaskValidation;
  error?: string;
  jobId?: string;
  runId?: string;
  toolName?: string;
  plan?: unknown;
  approval?: { toolCallId: string; toolName: string; input: unknown };
  retry?: { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "plan"; plan: unknown };
  /** Layer ids present before the task started, used to diff real outputs. */
  preLayerIds?: string[];
};

const DB_NAME = "tiphys-mobile-v2";
const DB_VERSION = 1;
const LOG_LIMIT = 240;

let databasePromise: Promise<IDBPDatabase> | null = null;
function database() {
  databasePromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
    },
  });
  return databasePromise;
}

let tasks: TaskRecord[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function sortTasks(list: TaskRecord[]) {
  return list.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function emit() {
  tasks = sortTasks(tasks);
  for (const listener of listeners) listener();
}

async function persist(task: TaskRecord) {
  try {
    const db = await database();
    await db.put("tasks", task);
  } catch {
    // Storage can be unavailable (private mode / quota). The in-memory ledger
    // keeps working for this session; the UI does not claim it was persisted.
  }
}

function finishForReload(task: TaskRecord): TaskRecord {
  if (!["queued", "running", "validating", "waiting"].includes(task.status)) return task;
  // Browser/WASM work dies with the page. Python sidecar jobs may survive, so the
  // poller gets a chance to reattach; only browser work is closed here.
  if (task.engine === "python-mcp") return task;
  return {
    ...task,
    status: "interrupted",
    stage: "浏览器会话已结束",
    finishedAt: Date.now(),
    logs: [...task.logs, {
      ts: Date.now(), level: "warn" as const,
      text: "页面关闭时任务尚未结束。浏览器内计算无法在页面外继续，已如实标记为中断；可重新运行。",
    }].slice(-LOG_LIMIT),
  };
}

export function initTaskStore(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const db = await database();
      const stored = (await db.getAll("tasks")) as TaskRecord[];
      const byId = new Map<string, TaskRecord>();
      for (const task of stored) byId.set(task.id, finishForReload(task));
      // Keep records created before the async load finished (newer wins).
      for (const task of tasks) byId.set(task.id, task);
      tasks = sortTasks([...byId.values()]);
      loaded = true;
      emit();
      // Persist the interrupted verdict so it is not recomputed every reload.
      for (const task of byId.values()) if (task.status === "interrupted" && task.engine !== "python-mcp") void persist(task);
    } catch {
      loaded = true;
      emit();
    }
  })();
  return loading;
}

export function taskStoreReady() {
  return loaded;
}

export function useTasks(): TaskRecord[] {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => tasks,
    () => tasks,
  );
}

export function getTask(id: string | null | undefined): TaskRecord | undefined {
  return id ? tasks.find(task => task.id === id) : undefined;
}

export function getTasksSnapshot(): TaskRecord[] {
  return tasks;
}

type NewTask = {
  id: string;
  name: string;
  source: TaskSource;
  engine: TaskEngine;
  status?: TaskStatus;
  stage?: string;
  projectId: string | null;
  conversationId?: string;
  goal?: string;
  input?: unknown;
  params?: Record<string, unknown>;
  jobId?: string;
  runId?: string;
  toolName?: string;
  plan?: unknown;
  preLayerIds?: string[];
  steps?: TaskStep[];
  retry?: TaskRecord["retry"];
};

export function createTask(input: NewTask): TaskRecord {
  const now = Date.now();
  const existing = getTask(input.id);
  if (existing) return existing;
  const task: TaskRecord = {
    id: input.id,
    name: input.name,
    source: input.source,
    engine: input.engine,
    status: input.status ?? "queued",
    stage: input.stage ?? "已提交",
    progress: null,
    projectId: input.projectId,
    conversationId: input.conversationId,
    createdAt: now,
    startedAt: ["queued", "running", "waiting", "validating"].includes(input.status ?? "queued") ? now : undefined,
    goal: input.goal,
    input: input.input,
    params: input.params,
    jobId: input.jobId,
    runId: input.runId,
    toolName: input.toolName,
    plan: input.plan,
    preLayerIds: input.preLayerIds,
    steps: input.steps ?? [],
    logs: [{ ts: now, level: "info", text: input.stage ?? "任务已提交" }],
    outputs: [],
    retry: input.retry,
  };
  tasks = [task, ...tasks];
  emit();
  void persist(task);
  return task;
}

export function patchTask(id: string, patch: Partial<TaskRecord>, log?: { text: string; level?: TaskLogLevel }) {
  const index = tasks.findIndex(task => task.id === id);
  if (index < 0) return;
  const task = tasks[index];
  const next: TaskRecord = {
    ...task,
    ...patch,
    logs: log
      ? [...task.logs, { ts: Date.now(), level: log.level ?? "info", text: log.text }].slice(-LOG_LIMIT)
      : patch.logs ?? task.logs,
    steps: patch.steps ?? task.steps,
  };
  tasks = tasks.slice();
  tasks[index] = next;
  emit();
  void persist(next);
}

export function addTaskLog(id: string, text: string, level: TaskLogLevel = "info") {
  const task = getTask(id);
  if (!task) return;
  const last = task.logs[task.logs.length - 1];
  if (last && last.text === text && last.level === level) return;
  patchTask(id, {}, { text, level });
}

export function removeTask(id: string) {
  tasks = tasks.filter(task => task.id !== id);
  emit();
  void database().then(db => db.delete("tasks", id)).catch(() => undefined);
}

export function setTaskValidation(id: string, validation: TaskValidation) {
  patchTask(id, {
    validation,
    status: validation.passed ? "succeeded" : "failed",
    stage: validation.passed ? "验证通过" : "验证未通过",
    finishedAt: Date.now(),
  }, {
    text: validation.verdict,
    level: validation.passed ? "success" : "error",
  });
}

/** Compares declared outputs against the live layer list. Evidence is concrete. */
export function verifyTaskOutputs(task: TaskRecord, layers: { id: string; name: string; kind?: string; feature_count: number; crs?: string }[]): TaskValidation {
  const checks: ValidationCheck[] = [];
  if (!task.outputs.length) {
    checks.push({ label: "输出成果", ok: false, evidence: "引擎没有返回可检查的图层或文件产物。" });
    return { passed: false, verdict: "没有可验证的输出成果。", checks, at: Date.now() };
  }
  for (const output of task.outputs) {
    if (output.layerId) {
      const layer = layers.find(item => item.id === output.layerId);
      checks.push({ label: `输出图层「${output.name}」已生成`, ok: !!layer, evidence: layer ? `图层 id ${layer.id} 存在于当前工作区。` : "工作区中找不到该图层。" });
      if (!layer) continue;
      const readable = layer.kind === "table" ? layer.feature_count >= 0 : layer.feature_count > 0 || layer.kind === "raster";
      checks.push({ label: "数据可读取", ok: readable, evidence: layer.kind === "raster" ? "栅格图层已注册并可渲染。" : `${layer.feature_count} 个要素可访问。` });
      checks.push({ label: "空间参考", ok: !!layer.crs, evidence: layer.crs ? `坐标系 ${layer.crs}。` : "图层未声明坐标系；空间计算与叠加前需确认。" });
    } else if (output.path || output.url) {
      checks.push({ label: `文件「${output.name}」已生成`, ok: true, evidence: output.path ? `引擎返回路径 ${output.path}。` : "引擎返回可下载链接。" });
    }
  }
  if (task.plan || task.source === "card" || task.source === "agent") {
    for (const item of task.validation?.checks ?? []) checks.push(item);
  }
  const passed = checks.length > 0 && checks.every(check => check.ok);
  return {
    passed,
    verdict: passed ? "输出存在、可读取且坐标系明确。" : "存在未通过的检查项，详见证据。",
    checks,
    at: Date.now(),
  };
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "草稿",
  pending_approval: "待确认",
  queued: "排队中",
  running: "运行中",
  waiting: "等待操作",
  validating: "验证中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  resumable: "可恢复",
};

export const TASK_STATUS_TONE: Record<TaskStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  pending_approval: "warning",
  queued: "info",
  running: "info",
  waiting: "warning",
  validating: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning",
  resumable: "warning",
};

export const TASK_SOURCE_LABEL: Record<TaskSource, string> = {
  agent: "Agent",
  manual: "手动工具",
  card: "任务卡",
};

export const TASK_ENGINE_LABEL: Record<TaskEngine, string> = {
  "browser-wasm": "浏览器本地 WASM",
  "python-mcp": "Python 本地引擎",
  agent: "Agent 调度",
};

export function taskStepsSummary(task: TaskRecord) {
  const total = task.steps.length;
  const done = task.steps.filter(step => step.status === "done" || step.status === "skipped").length;
  return { total, done };
}
