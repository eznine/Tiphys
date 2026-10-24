import { useMemo, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { defaultLayerStyle } from "../lib/dataLayers";
import { type ProjectRecord, type ProjectMapView } from "../lib/mobile/projectStore";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, type TaskRecord } from "../lib/mobile/taskStore";
import { MobileSheet } from "./MobileSheet";
import {
  Check, ChevronRight, Database, FolderKanban, FolderPlus, History, Layers, Map, MapPin,
  Pencil, Plus, Search, Settings2, Sparkles, Table2, Trash2, Wrench,
} from "lucide-react";

type Props = {
  projects: ProjectRecord[];
  currentProject: ProjectRecord | null;
  layers: DataLayer[];
  tasks: TaskRecord[];
  mapView: ProjectMapView | null;
  aoi: number[] | null;
  onSwitch: (projectId: string) => void;
  onCreate: (input: { name: string; description: string; includeLayers: boolean }) => void;
  onRename: (projectId: string, name: string) => void;
  onDelete: (projectId: string) => void;
  onAddData: () => void;
  onOpenLayers: () => void;
  onOpenToolbox: () => void;
  onOpenSettings: () => void;
  onSaveView: () => void;
  onAddLayer: (layerId: string) => void;
  onRemoveLayer: (layerId: string) => void;
  onLocate: (layer: DataLayer) => void;
  onTable: (layerId: string) => void;
  onOpenTask: (taskId: string) => void;
};

type Tab = "overview" | "datasets" | "outputs" | "history";

const KIND_LABEL: Record<string, string> = { vector: "矢量", raster: "栅格", table: "表格" };

function formatTime(value?: number) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

function layerMeta(layer: DataLayer) {
  const kind = KIND_LABEL[layer.kind ?? "vector"];
  if (layer.kind === "raster") return `${kind} · ${layer.raster?.width}×${layer.raster?.height} · ${layer.raster?.bands} 波段`;
  if (layer.kind === "table") return `${kind} · ${layer.feature_count} 行`;
  return `${kind} · ${layer.feature_count} 个要素${layer.crs ? ` · ${layer.crs}` : ""}`;
}

export function MobileProjectPage(props: Props) {
  const { projects, currentProject, layers, tasks, mapView, aoi, onSwitch, onCreate, onRename, onDelete, onAddData,
    onOpenLayers, onOpenToolbox, onOpenSettings, onSaveView, onAddLayer, onRemoveLayer, onLocate, onTable, onOpenTask } = props;
  const [tab, setTab] = useState<Tab>("overview");
  const [searchProjects, setSearchProjects] = useState("");
  const [searchLayers, setSearchLayers] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [includeLayers, setIncludeLayers] = useState(true);
  const [renameValue, setRenameValue] = useState("");
  const [saved, setSaved] = useState(false);

  const projectLayers = useMemo(() => {
    if (!currentProject) return [];
    return layers.filter(layer => currentProject.layerIds.includes(layer.id));
  }, [layers, currentProject]);
  const projectTasks = useMemo(() => currentProject ? tasks.filter(task => task.projectId === currentProject.id) : [], [tasks, currentProject]);
  const outputs = useMemo(() => {
    const rows: { task: TaskRecord; layerId?: string; name: string; found?: DataLayer }[] = [];
    for (const task of projectTasks) {
      for (const output of task.outputs) {
        rows.push({ task, layerId: output.layerId, name: output.name, found: output.layerId ? layers.find(layer => layer.id === output.layerId) : undefined });
      }
    }
    return rows;
  }, [projectTasks, layers]);
  const visibleProjects = projects.filter(project => project.name.toLocaleLowerCase().includes(searchProjects.trim().toLocaleLowerCase()));
  const vaultLayers = layers.filter(layer => !currentProject?.layerIds.includes(layer.id));
  const filteredProjectLayers = projectLayers.filter(layer => layer.name.toLocaleLowerCase().includes(searchLayers.trim().toLocaleLowerCase()));
  const filteredVault = vaultLayers.filter(layer => layer.name.toLocaleLowerCase().includes(searchLayers.trim().toLocaleLowerCase()));

  const submitCreate = () => {
    if (!newName.trim()) return;
    onCreate({ name: newName.trim(), description: newDescription.trim(), includeLayers });
    setCreateOpen(false);
    setNewName("");
    setNewDescription("");
    setIncludeLayers(true);
    setTab("overview");
  };

  const submitRename = () => {
    if (currentProject && renameValue.trim()) onRename(currentProject.id, renameValue.trim());
    setRenameOpen(false);
  };

  const mapMode = mapView?.mode === "3d" ? "3D 地球" : "2D 地图";
  const basemap = mapView?.basemap ?? "liberty";
  const centerText = mapView
    ? `${mapView.lng.toFixed(3)}°, ${mapView.lat.toFixed(3)}° · Z ${mapView.zoom.toFixed(1)}`
    : "尚未保存视图";

  return <section className="m-page m-project-page" aria-label="工程">
    <header className="m-page-head">
      <div className="m-page-heading"><h1>工程</h1><div className="m-page-subtitle">数据与成果的长期工作空间</div></div>
      <button type="button" className="m-icon-btn" aria-label="设置" onClick={onOpenSettings}><Settings2 size={19} /></button>
    </header>

    <div className="m-page-body m-project-body">
      {currentProject ? <>
        <div className="m-project-hero">
          <div className="m-project-hero-top">
            <span className="m-project-badge"><FolderKanban size={13} />当前工程</span>
            <span className="m-project-updated">更新 {formatTime(currentProject.updatedAt)}</span>
          </div>
          <h2>{currentProject.name}</h2>
          <p>{currentProject.description || "未填写工程说明。"}</p>
          <div className="m-project-stats">
            <div><strong>{projectLayers.length}</strong><span>图层</span></div>
            <div><strong>{outputs.length}</strong><span>成果</span></div>
            <div><strong>{projectTasks.length}</strong><span>任务</span></div>
            <div><strong>{aoi ? "已设" : "无"}</strong><span>AOI</span></div>
          </div>
          <div className="m-project-hero-actions">
            <button type="button" className="m-btn m-btn-primary" onClick={() => setCreateOpen(true)}><Plus size={15} />新建工程</button>
            <button type="button" className="m-btn" onClick={() => { setRenameValue(currentProject.name); setRenameOpen(true); }}><Pencil size={15} />重命名</button>
            <button type="button" className="m-btn m-btn-danger" disabled={projects.length <= 1} onClick={() => setDeleteOpen(true)}><Trash2 size={15} />删除</button>
          </div>
        </div>

        <label className="m-search">
          <Search size={16} />
          <input type="search" value={searchProjects} onChange={event => setSearchProjects(event.target.value)} placeholder="搜索工程" aria-label="搜索工程" />
        </label>

        {projects.length > 1 && <div className="m-project-switcher" aria-label="切换工程">
          <h3>最近工程</h3>
          <div className="m-project-switcher-list">
            {visibleProjects.map(project => <button key={project.id} type="button" className="m-project-switch" data-active={project.id === currentProject.id}
              onClick={() => { if (project.id !== currentProject.id) onSwitch(project.id); }}>
              <span className="m-project-switch-icon">{project.id === currentProject.id ? <Check size={15} /> : <FolderKanban size={15} />}</span>
              <span className="m-project-switch-main"><strong>{project.name}</strong><small>{project.layerIds.length} 个图层 · {formatTime(project.updatedAt)}</small></span>
              <ChevronRight size={15} />
            </button>)}
            {!visibleProjects.length && <p className="m-muted">没有匹配的工程。</p>}
          </div>
        </div>}

        <div className="m-tabs" role="tablist" aria-label="工程内容">
          {([["overview", "概览"], ["datasets", "数据集"], ["outputs", "成果"], ["history", "历史"]] as const).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-active={tab === id} onClick={() => setTab(id)}>{label}</button>)}
        </div>

        {tab === "overview" && <div className="m-project-tab">
          <section className="m-card">
            <h3><Map size={15} />地图与视图</h3>
            <div className="m-kv"><span>投影</span><strong>{mapMode}</strong></div>
            <div className="m-kv"><span>底图</span><strong>{basemap}</strong></div>
            <div className="m-kv"><span>相机</span><strong>{centerText}</strong></div>
            <div className="m-kv"><span>AOI</span><strong>{aoi ? aoi.map(value => value.toFixed(3)).join(", ") : "未设置"}</strong></div>
            <div className="m-card-actions">
              <button type="button" className="m-btn m-btn-primary" onClick={() => { onSaveView(); setSaved(true); window.setTimeout(() => setSaved(false), 2200); }}>
                {saved ? <><Check size={15} />已保存</> : <><MapPin size={15} />保存当前视图</>}
              </button>
              <button type="button" className="m-btn" onClick={onOpenLayers}><Layers size={15} />管理图层</button>
            </div>
          </section>

          <section className="m-card">
            <h3><Sparkles size={15} />开始工作</h3>
            <div className="m-project-quick">
              <button type="button" onClick={onAddData}><FolderPlus size={18} /><span>添加数据</span><small>导入本机文件</small></button>
              <button type="button" onClick={onOpenLayers}><Layers size={18} /><span>图层</span><small>{projectLayers.length} 个在工程中</small></button>
              <button type="button" onClick={onOpenToolbox}><Wrench size={18} /><span>工具箱</span><small>传统 GIS 操作</small></button>
              <button type="button" onClick={() => setTab("outputs")}><Database size={18} /><span>分析成果</span><small>{outputs.length} 项</small></button>
            </div>
          </section>

          <p className="m-vault-note">数据模型：图层数据保存在本机统一保险库；工程记录图层子集、顺序、显隐、视图与任务归属。切换工程不会复制或删除数据。</p>
        </div>}

        {tab === "datasets" && <div className="m-project-tab">
          <label className="m-search"><Search size={16} /><input type="search" value={searchLayers} onChange={event => setSearchLayers(event.target.value)} placeholder="搜索数据集" aria-label="搜索数据集" /></label>
          <section className="m-card m-card-tight">
            <h3><Layers size={15} />本工程图层 · {projectLayers.length}</h3>
            {filteredProjectLayers.map(layer => <div key={layer.id} className="m-dataset-row">
              <span className="m-dataset-swatch" style={{ background: (layer.style ?? defaultLayerStyle(layer.id, layer.name)).color }} />
              <div className="m-dataset-main"><strong>{layer.name}</strong><small>{layerMeta(layer)}</small></div>
              <div className="m-dataset-actions">
                <button type="button" className="m-icon-btn" aria-label={`定位 ${layer.name}`} disabled={!layer.bounds} onClick={() => onLocate(layer)}><MapPin size={15} /></button>
                {layer.kind !== "raster" && <button type="button" className="m-icon-btn" aria-label={`${layer.name} 属性表`} onClick={() => onTable(layer.id)}><Table2 size={15} /></button>}
                <button type="button" className="m-btn m-btn-small" title="仅移出工程视图，不删除数据" onClick={() => onRemoveLayer(layer.id)}>移出</button>
              </div>
            </div>)}
            {!filteredProjectLayers.length && <p className="m-muted">{projectLayers.length ? "没有匹配的图层。" : "本工程还没有图层。可从下方保险库加入，或添加新数据。"}</p>}
          </section>

          <section className="m-card m-card-tight">
            <h3><Database size={15} />数据保险库 · 其他 {vaultLayers.length}</h3>
            {filteredVault.map(layer => <div key={layer.id} className="m-dataset-row" data-muted="true">
              <span className="m-dataset-swatch" style={{ background: (layer.style ?? defaultLayerStyle(layer.id, layer.name)).color }} />
              <div className="m-dataset-main"><strong>{layer.name}</strong><small>{layerMeta(layer)}</small></div>
              <button type="button" className="m-btn m-btn-small" onClick={() => onAddLayer(layer.id)}><Plus size={13} />加入</button>
            </div>)}
            {!filteredVault.length && <p className="m-muted">其他图层都已在本工程中，或保险库为空。</p>}
            <button type="button" className="m-add-row" onClick={onAddData}><Plus size={16} />添加数据</button>
          </section>
        </div>}

        {tab === "outputs" && <div className="m-project-tab">
          <section className="m-card m-card-tight">
            <h3><Database size={15} />分析成果 · {outputs.length}</h3>
            {outputs.map((row, index) => <button key={`${row.task.id}-${index}`} type="button" className="m-output-card" onClick={() => onOpenTask(row.task.id)}>
              <div className="m-output-card-head">
                <strong>{row.name}</strong>
                <span className="m-task-status" data-tone={row.task.status === "validating" ? "info" : row.task.validation ? (row.task.validation.passed ? "success" : "danger") : "neutral"}>
                  <span className="m-task-status-dot" />{row.task.status === "validating" ? "验证中" : row.task.validation ? (row.task.validation.passed ? "验证通过" : "验证未通过") : "待验证"}
                </span>
              </div>
              <small>来自任务「{row.task.name}」 · {TASK_STATUS_LABEL[row.task.status]} · {formatTime(row.task.finishedAt ?? row.task.createdAt)}</small>
              <div className="m-output-card-foot">
                <span className={row.found ? "" : "m-danger-text"}>{row.found ? layerMeta(row.found) : "成果图层已不在工作区"}</span>
                <span>查看任务 →</span>
              </div>
            </button>)}
            {!outputs.length && <div className="m-empty-inline"><Database size={18} /><strong>还没有分析成果</strong><span>完成一次缓冲区、裁剪、坡度等分析后，成果会自动出现在这里。</span></div>}
          </section>
          <p className="m-vault-note">成果由任务产出并统一引用：对话、任务中心、工程与地图指向同一图层，不复制多份。</p>
        </div>}

        {tab === "history" && <div className="m-project-tab">
          <section className="m-card m-card-tight">
            <h3><History size={15} />任务历史 · {projectTasks.length}</h3>
            {projectTasks.map(task => <button key={task.id} type="button" className="m-history-row" onClick={() => onOpenTask(task.id)}>
              <span className="m-task-status" data-tone={TASK_STATUS_TONE[task.status]}><span className="m-task-status-dot" />{TASK_STATUS_LABEL[task.status]}</span>
              <div><strong>{task.name}</strong><small>{task.stage} · {formatTime(task.createdAt)}</small></div>
              <ChevronRight size={15} />
            </button>)}
            {!projectTasks.length && <p className="m-muted">本工程还没有任务记录。</p>}
          </section>
          <section className="m-card">
            <h3><FolderKanban size={15} />工程信息</h3>
            <div className="m-kv"><span>创建</span><strong>{formatTime(currentProject.createdAt)}</strong></div>
            <div className="m-kv"><span>最近更新</span><strong>{formatTime(currentProject.updatedAt)}</strong></div>
            <div className="m-kv"><span>工程 ID</span><strong className="m-mono">{currentProject.id}</strong></div>
          </section>
        </div>}
      </> : <div className="m-empty-state"><FolderKanban size={22} /><strong>正在载入工程…</strong><span>本机工程存储尚未就绪。</span></div>}
    </div>

    <MobileSheet open={createOpen} title="新建工程" initialSnap={1} snapPoints={[0.62, 0.92]} onClose={() => setCreateOpen(false)}>
      <div className="m-form">
        <label>工程名称<input value={newName} onChange={event => setNewName(event.target.value)} placeholder="如：河流廊道韧性研究" autoFocus /></label>
        <label>说明（可选）<textarea rows={3} value={newDescription} onChange={event => setNewDescription(event.target.value)} placeholder="这项工程要回答什么空间问题？" /></label>
        <label className="m-check"><input type="checkbox" checked={includeLayers} onChange={event => setIncludeLayers(event.target.checked)} /><span>把当前工程的图层加入新工程</span></label>
        <p className="m-sheet-hint">不勾选时新工程为空；数据仍在保险库，可随时从工程页加入。此操作不会复制或删除任何文件。</p>
        <div className="m-form-actions"><button type="button" className="m-btn" onClick={() => setCreateOpen(false)}>取消</button><button type="button" className="m-btn m-btn-primary" disabled={!newName.trim()} onClick={submitCreate}>创建并切换</button></div>
      </div>
    </MobileSheet>

    <MobileSheet open={renameOpen} title="重命名工程" initialSnap={0} snapPoints={[0.42, 0.8]} onClose={() => setRenameOpen(false)}>
      <div className="m-form">
        <label>工程名称<input value={renameValue} onChange={event => setRenameValue(event.target.value)} autoFocus /></label>
        <div className="m-form-actions"><button type="button" className="m-btn" onClick={() => setRenameOpen(false)}>取消</button><button type="button" className="m-btn m-btn-primary" disabled={!renameValue.trim()} onClick={submitRename}>保存</button></div>
      </div>
    </MobileSheet>

    <MobileSheet open={deleteOpen} title="删除工程" initialSnap={0} snapPoints={[0.5, 0.82]} onClose={() => setDeleteOpen(false)}>
      <div className="m-form">
        <p className="m-warning-box">删除工程「{currentProject?.name}」只移除工程记录、视图与任务归属。图层数据、成果文件与任务日志不会被删除。</p>
        <div className="m-form-actions"><button type="button" className="m-btn" onClick={() => setDeleteOpen(false)}>保留</button>
          <button type="button" className="m-btn m-btn-danger" onClick={() => { if (currentProject) onDelete(currentProject.id); setDeleteOpen(false); }}>删除工程记录</button></div>
      </div>
    </MobileSheet>
  </section>;
}
