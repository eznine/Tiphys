/**
 * Project store (V2.2).
 *
 * Honest model: layer bytes stay in the single local data vault (IndexedDB /
 * engine workspace). A project is a named view over that vault — layer subset,
 * order, visibility, AOI, camera view — plus task ownership. Switching projects
 * really applies these states to the map; it never copies or deletes data.
 */
import { openDB, type IDBPDatabase } from "idb";
import { useSyncExternalStore } from "react";

export type ProjectMapView = {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  mode: "2d" | "3d";
  basemap: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  layerIds: string[];
  visibility: Record<string, boolean>;
  aoi: number[] | null;
  mapView: ProjectMapView | null;
};

export const DEFAULT_PROJECT_ID = "project-default";
const DB_NAME = "tiphys-mobile-v2";
const DB_VERSION = 1;
const CURRENT_KEY = "tiphys-current-project-v22";

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

let projects: ProjectRecord[] = [];
let currentId: string | null = null;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const writeTimers = new Map<string, number>();

function emit() { for (const listener of listeners) listener(); }

function sortProjects(list: ProjectRecord[]) {
  return list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveCurrent() {
  try {
    if (currentId) localStorage.setItem(CURRENT_KEY, currentId);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    // Private mode: the current project still lives in memory for this session.
  }
}

function schedulePersist(project: ProjectRecord, immediate = false) {
  const existing = writeTimers.get(project.id);
  if (existing) window.clearTimeout(existing);
  if (immediate) {
    writeTimers.delete(project.id);
    void database().then(db => db.put("projects", project)).catch(() => undefined);
    return;
  }
  const timer = window.setTimeout(() => {
    writeTimers.delete(project.id);
    void database().then(db => db.put("projects", project)).catch(() => undefined);
  }, 350);
  writeTimers.set(project.id, timer);
}

function readCurrentId() {
  try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
}

export function initProjectStore(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const db = await database();
      const stored = (await db.getAll("projects")) as ProjectRecord[];
      projects = sortProjects(stored);
    } catch {
      projects = [];
    }
    if (!projects.length) {
      const now = Date.now();
      const fallback: ProjectRecord = {
        id: DEFAULT_PROJECT_ID,
        name: "默认工程",
        description: "本机空间数据工作区。新建工程可在不移动数据的前提下组织图层与视图。",
        createdAt: now,
        updatedAt: now,
        layerIds: [],
        visibility: {},
        aoi: null,
        mapView: null,
      };
      projects = [fallback];
      void database().then(db => db.put("projects", fallback)).catch(() => undefined);
      currentId = fallback.id;
    } else {
      const remembered = readCurrentId();
      currentId = projects.some(project => project.id === remembered) ? remembered : projects[0].id;
    }
    loaded = true;
    saveCurrent();
    emit();
  })();
  return loading;
}

export function projectStoreReady() { return loaded; }

export function useProjects(): ProjectRecord[] {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => projects,
    () => projects,
  );
}

export function useCurrentProject(): ProjectRecord | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => projects.find(project => project.id === currentId) ?? null,
    () => projects.find(project => project.id === currentId) ?? null,
  );
}

export function getProjects(): ProjectRecord[] { return projects; }
export function getCurrentProject(): ProjectRecord | null { return projects.find(project => project.id === currentId) ?? null; }
export function getCurrentProjectId(): string | null { return currentId; }

export function createProject(input: { name: string; description?: string; layerIds?: string[]; visibility?: Record<string, boolean>; mapView?: ProjectMapView | null; aoi?: number[] | null }): ProjectRecord {
  const now = Date.now();
  const project: ProjectRecord = {
    id: `project-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: input.name.trim() || "未命名工程",
    description: input.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    layerIds: input.layerIds ?? [],
    visibility: input.visibility ?? Object.fromEntries((input.layerIds ?? []).map(id => [id, true])),
    aoi: input.aoi ?? null,
    mapView: input.mapView ?? null,
  };
  projects = sortProjects([project, ...projects]);
  emit();
  schedulePersist(project, true);
  return project;
}

export function patchProject(id: string, patch: Partial<ProjectRecord>) {
  const index = projects.findIndex(project => project.id === id);
  if (index < 0) return;
  const next: ProjectRecord = { ...projects[index], ...patch, updatedAt: Date.now() };
  projects = sortProjects(projects.map((project, i) => (i === index ? next : project)));
  emit();
  schedulePersist(next);
}

export function renameProject(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  patchProject(id, { name: trimmed });
  const project = projects.find(item => item.id === id);
  if (project) schedulePersist(project, true);
}

export function deleteProject(id: string) {
  if (projects.length <= 1) return;
  const rest = projects.filter(project => project.id !== id);
  projects = rest;
  if (currentId === id) {
    currentId = rest[0]?.id ?? null;
    saveCurrent();
  }
  emit();
  void database().then(db => db.delete("projects", id)).catch(() => undefined);
}

export function setCurrentProject(id: string) {
  if (!projects.some(project => project.id === id)) return;
  currentId = id;
  saveCurrent();
  emit();
}
