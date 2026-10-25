/** Forms use the engine's MCP catalog and validated tool entry point. */
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { zhParam, zhTool, zhToolL1, zhToolL2 } from "../lib/i18n/tools";
import { engineRequest } from "../lib/service";
import { geeExecutionAllowed, type GeeAuthStatus } from "../lib/gee";
import { PipelineResultDetails, pipelineResult } from "./ToolResultDetails";

type Schema = { type?: string; enum?: string[]; default?: unknown; anyOf?: Schema[]; description?: string; "x-layer"?: boolean; "x-layer-kind"?: string; "x-layer-multiple"?: boolean };
type CatalogTool = {
  name: string; description?: string;
  label?: string;
  category?: string;
  subcategory?: string;
  parameters: { properties?: Record<string, Schema>; required?: string[] };
  annotations?: { destructiveHint?: boolean };
};
type PanelJob = {
  jobId: string; label: string; status: string; progress: number;
  message: string; result?: Record<string, any>; error?: string;
  taskId?: string;
};

/** Real lifecycle of a manual tool run, for the unified mobile task ledger. */
export type ToolTaskEvent = {
  taskId: string;
  tool: string;
  label: string;
  args: Record<string, unknown>;
  status: string;
  progress: number;
  message: string;
  jobId?: string;
  result?: Record<string, any>;
  error?: string;
};
const SKIP = new Set(["ping", "list_layers", "job_status", "job_cancel"]);
const UNIT_LABELS: Record<string, string> = { meters: "米", meter: "米", kilometers: "千米", kilometer: "千米", km: "千米", feet: "英尺", foot: "英尺", miles: "英里", degree: "度", degrees: "度", pixels: "像元", cells: "像元" };
const FIELD_PARAMS = new Set(["field", "by_field", "field_name", "weight_field", "value_field", "line_field", "sort_field", "id_field"]);
const L1_ORDER = ["矢量", "栅格", "地形", "水文", "遥感", "转换", "投影", "激光雷达", "数据管理", "查询", "图层", "GEE", "扩展", "其他工具"];
const ACTIVE = new Set(["submitting", "queued", "running", "cancelling"]);
const LABELS: Record<string, string> = {
  add_data: "加载矢量数据", describe_layer: "查看图层属性", buffer: "缓冲区",
  clip: "裁剪", intersection: "相交", union_layers: "联合", erase: "擦除",
  dissolve: "融合（需桌面）", convex_hull: "凸包", simplify: "简化几何",
  spatial_join: "空间连接",
  select_by_attributes: "按属性选择", select_by_location: "按位置选择",
  reproject: "重投影", export_features: "导出要素", calculate_geometry: "计算面积与长度", remove_layer: "移除图层",
  rename_layer: "重命名图层", reorder_layers: "调整图层顺序", field_statistics: "字段统计",
  zoom_to_layer: "缩放至图层", open_attribute_table: "打开属性表", set_layer_symbology: "设置单一符号", set_layer_labels: "设置标注",
  list_supported_formats: "支持的格式", import_arcgis_project: "导入 ArcGIS 工程",
};
const DESCRIPTIONS: Record<string, string> = {
  add_data: "加载本地矢量文件，保留原始坐标系，并添加到地图。",
  describe_layer: "查看图层坐标系、字段、要素数量与示例属性。",
  buffer: "按指定距离创建缓冲区，可选择是否融合重叠区域。",
  clip: "使用掩膜区域裁剪输入图层，保留输入要素的属性。",
  intersection: "提取两个图层的相交部分，并合并双方属性。",
  union_layers: "合并两个面图层的覆盖范围，保留各区域的属性。",
  erase: "从输入图层中扣除与掩膜重叠的部分。",
  dissolve: "浏览器 WASM dissolve 已知会静默丢几何，尚未开放；请改用桌面 Python 引擎，或先求并集再处理属性。",
  convex_hull: "创建包围输入要素的最小凸几何。",
  simplify: "按指定距离容差简化几何，保留拓扑关系。",
  select_by_attributes: "按字段条件筛选要素，将匹配结果保存为新图层。",
  select_by_location: "按相交、包含等空间关系筛选要素，保存为新图层。",
  spatial_join: "按相交、包含、位于或最近邻关系，把连接图层的属性追加到目标图层。",
  reproject: "将图层转换到目标坐标系，生成新的分析数据。",
  export_features: "将图层导出为 GeoJSON、GeoPackage 或含 WKT 几何的 CSV。",
  calculate_geometry: "在检查过误差的局部投影中计算面积与长度，单位为平方米与米。",
  remove_layer: "从工作区移除图层和工作副本，原始输入文件不受影响。",
  zoom_to_layer: "将地图视图定位到图层的实际范围。", open_attribute_table: "在地图下方打开图层的属性表。",
  set_layer_symbology: "设置图层的颜色、透明度、点大小和线宽。", set_layer_labels: "按字段显示地图标注，留空关闭标注。",
  rename_layer: "修改图层的显示名称，不改动分析数据。", reorder_layers: "设置工作区图层顺序，即地图绘制顺序（越靠后越在上层）。",
  field_statistics: "统计某属性字段的最小/最大/均值/中位数/标准差或最常见值；空值单独计数。",
  list_supported_formats: "查看可直接读取的矢量、栅格和表格格式，以及 ArcGIS 工程与 GDB 的替代路径。",
  import_arcgis_project: "当前版本不解析 MXD/APRX/File GDB；运行后会返回限制说明和可用的开放格式。",
};
const FIELDS: Record<string, string> = {
  layer: "输入图层", mask_layer: "掩膜图层", other_layer: "叠加图层", filter_layer: "筛选图层", join_layer: "连接图层",
  path: "文件路径", name: "图层名称", source_crs: "源坐标系（源数据未定义时必填）",
  distance: "距离", units: "单位", dissolve: "融合缓冲区", output_name: "输出图层名称",
  by_field: "融合字段（留空则全部融合）", tolerance: "容差", field: "字段", value_field: "数值字段", op: "比较方式",
  value: "比较值", predicate: "空间关系", target_crs: "目标坐标系", fmt: "格式", overwrite: "覆盖已有文件",
  color: "颜色（#RRGGBB）", opacity: "不透明度（0–1）", point_size: "点半径（像素）", line_width: "线宽（像素）", size: "文字大小（像素）",
  keep_fields: "保留连接字段", format_group: "格式类别", resistance: "阻力栅格",
  barriers: "障碍图层（可选）", corridor_width: "廊道宽度（地图单位）", neighbor_option: "连接方式",
  dem: "输入 DEM 栅格", depression_method: "洼地处理方式", stream_threshold: "河网阈值",
  extract_streams: "提取河网", pour_points: "汇水点（可选）", snap_distance: "汇水点吸附距离",
  source: "源端图层", destination: "目的地图层", connections: "连接方式", include_cost_surface: "输出成本距离表面",
  aoi_west: "AOI 西边界（WGS84）", aoi_south: "AOI 南边界（WGS84）", aoi_east: "AOI 东边界（WGS84）", aoi_north: "AOI 北边界（WGS84）",
  maintain_dimensions: "保留原栅格尺寸",
  factors: "因子栅格（多选，按选择顺序）", input_rasters: "输入栅格（多选，按选择顺序）",
  weights: "权重（逗号分隔）", scale_max: "归一化上限", max_dist: "最大搜索距离（像元）",
  max_cost: "最大开裂成本", minimize_dist: "按距离加权开裂成本", flat_increment: "平地增量",
  fill_flat_increment: "填平增量", breach_distance: "开裂搜索距离",
};
const STATUS: Record<string, string> = {
  submitting: "提交中", queued: "排队中", running: "运行中", cancelling: "正在取消",
  completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "已中断",
};
function detailOf(result?: Record<string, any>): string {
  if (!result) return "";
  if (Array.isArray(result.layers)) return result.layers.map((item: any) => item?.layer?.name).filter(Boolean).join("、") || "结果已生成";
  if (result.layer) return `${result.layer.name} · ${result.layer.kind === "raster" ? `栅格 ${result.layer.raster?.width}×${result.layer.raster?.height}` : `${result.layer.feature_count} 个要素`}`;
  if (result.path) return `${result.path} · ${result.feature_count} 个要素 · ${result.bytes} 字节`;
  if (result.removed) return `已移除 ${result.name}`;
  return "";
}
const KIND_ZH: Record<string, string> = { vector: "矢量", raster: "栅格", table: "表格" };
/** Chinese display name for a catalog tool: curated python-tool labels first,
 * then the translated GeoLibre dictionary, then the upstream label. */
export function toolTitle(item: { name: string; label?: string }): string {
  return LABELS[item.name] ?? zhTool(item.name)?.name ?? item.label ?? item.name;
}
export function toolDesc(item: { name: string; description?: string }): string {
  return DESCRIPTIONS[item.name] ?? zhTool(item.name)?.desc ?? item.description?.split("\n")[0] ?? "";
}

export function ToolPanel({ layers, onResult, request, selectedLayer, onTask }: { layers: DataLayer[]; onResult: (result: Record<string, any>) => void; request?: { id: number; tool?: string; search?: string }; selectedLayer?: DataLayer; onTask?: (event: ToolTaskEvent) => void }) {
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [catalogHydrated, setCatalogHydrated] = useState(false);
  const [geeStatus, setGeeStatus] = useState<GeeAuthStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [toolName, setToolName] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [job, setJob] = useState<PanelJob | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [expandedL1, setExpandedL1] = useState<Record<string, boolean>>({});
  const [expandedL2, setExpandedL2] = useState<Record<string, boolean>>({});
  const busy = !!job && ACTIVE.has(job.status);
  const appliedRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!request || appliedRequest.current === request.id) return;
    // Ribbon search only needs the catalogue list, so it does not wait for the
    // form catalog's full hydration.
    if (request.search !== undefined) {
      appliedRequest.current = request.id;
      setToolName("");
      setSearch(request.search);
      return;
    }
    if (!catalog || busy) return;
    appliedRequest.current = request.id;
    const requested = catalog.find(t => t.name === request.tool);
    setToolName(requested?.name ?? "");
    const initial: Record<string, string | boolean | string[]> = selectedLayer ? { layer: selectedLayer.id } : {};
    if (selectedLayer && requested) {
      const layerKind = selectedLayer.kind ?? "vector";
      const match = Object.entries(requested.parameters.properties ?? {}).find(([, raw]) => {
        const schema = raw.anyOf?.find(part => part.type !== "null") ?? raw;
        return schema["x-layer-kind"] === layerKind && !schema["x-layer-multiple"];
      });
      if (match) initial[match[0]] = selectedLayer.id;
    }
    setValues(initial);
    setConfirmed(false);
  }, [request, catalog, busy, selectedLayer]);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError("");
    try {
      const shell = await (await engineRequest("/tools/catalog?hydrate=0", { signal })).json();
      const shellTools: CatalogTool[] = shell.tools.filter((t: CatalogTool) => !SKIP.has(t.name));
      setCatalog(shellTools);
      setCatalogHydrated(Boolean(shell.catalog?.hydrated));
      if (!shell.catalog?.hydrated) {
        // Let the shell render before the catalog conversion starts. Hydration
        // itself yields between chunks, but this avoids starting it in the same
        // microtask as the first render.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (signal?.aborted) return;
        const full = await (await engineRequest("/tools/catalog", { signal })).json();
        const tools: CatalogTool[] = full.tools.filter((t: CatalogTool) => !SKIP.has(t.name));
        if (signal?.aborted) return;
        setCatalog(tools);
        setCatalogHydrated(full.catalog?.hydrated !== false);
      }
    } catch (err) { if (!signal?.aborted) setLoadError(String(err)); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const tool = catalog?.find(t => t.name === toolName);
  const groups = useMemo(() => {
    const grouped = new Map<string, Map<string, CatalogTool[]>>();
    const query = search.trim().toLocaleLowerCase();
    for (const item of catalog ?? []) {
      const l1 = zhToolL1(item);
      const l2 = zhToolL2(item);
      const keywords = `${toolTitle(item)} ${item.name} ${l1} ${l2} ${toolDesc(item)}`;
      if (query && !keywords.toLocaleLowerCase().includes(query)) continue;
      if (!grouped.has(l1)) grouped.set(l1, new Map());
      const subcategories = grouped.get(l1)!;
      if (!subcategories.has(l2)) subcategories.set(l2, []);
      subcategories.get(l2)!.push(item);
    }
    const rank = (name: string) => { const i = L1_ORDER.indexOf(name); return i < 0 ? L1_ORDER.length : i; };
    return [...grouped].map(([name, subcategories]) => ({
      name,
      count: [...subcategories.values()].reduce((sum, tools) => sum + tools.length, 0),
      subcategories: [...subcategories].map(([name, tools]) => ({ name, tools }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    })).sort((a, b) => rank(a.name) - rank(b.name));
  }, [catalog, search]);
  const props = useMemo(() => Object.entries(tool?.parameters.properties ?? {}).map(([name, s]) =>
    [name, s.anyOf?.find(part => part.type !== "null") ?? s] as const), [tool]);
  useEffect(() => {
    if (!tool?.name.startsWith("gee_")) { setGeeStatus(null); return; }
    const controller = new AbortController();
    void engineRequest("/tools/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gee_auth_status", arguments: {} }), signal: controller.signal,
    }).then(response => response.json()).then(status => { if (!controller.signal.aborted) setGeeStatus(status); }).catch(() => {});
    return () => controller.abort();
  }, [tool?.name]);
  const needsColumns = props.some(([name]) => FIELD_PARAMS.has(name));
  const fieldSource = props.find(([, schema]) => schema["x-layer-kind"] === "vector" && !schema["x-layer-multiple"])?.[0];
  const fieldLayerId = values.layer ?? (fieldSource ? values[fieldSource] : undefined);
  useEffect(() => {
    setColumns([]);
    if (!needsColumns || !fieldLayerId) return;
    const controller = new AbortController();
    void engineRequest(`/layers/${encodeURIComponent(String(fieldLayerId))}/describe`, { signal: controller.signal })
      .then(r => r.json()).then(data => { if (!controller.signal.aborted) setColumns(data.columns ?? []); }).catch(() => {});
    return () => controller.abort();
  }, [fieldLayerId, needsColumns]);
  useEffect(() => {
    if (!job?.jobId) return;
    const jobId = job.jobId;
    const taskId = job.taskId;
    const label = job.label;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await (await engineRequest(`/jobs/${jobId}`, { signal: controller.signal })).json();
        if (controller.signal.aborted) return;
        setJob(cur => cur?.jobId === jobId ? { ...cur, ...j, jobId, error: j.error ?? undefined } : cur);
        if (taskId) onTaskRef.current?.({
          taskId, tool: "", label, args: {}, status: String(j.status), progress: Number(j.progress) || 0,
          message: String(j.message ?? ""), jobId, result: j.result, error: j.error ?? undefined,
        });
        if (!ACTIVE.has(j.status)) {
          if (j.status === "completed" && j.result) onResult(j.result);
          return;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setJob(cur => cur?.jobId === jobId ? { ...cur, message: `读取进度失败，正在重连：${err}` } : cur);
      }
      timer = setTimeout(() => void poll(), 800);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.jobId, onResult]);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!tool || busy || (tool.annotations?.destructiveHint && !confirmed)) return;
    const args: Record<string, unknown> = {};
    for (const [name, schema] of props) {
      const value = values[name] ?? schema.default;
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) { if (value.length) args[name] = value; continue; }
      args[name] = schema.type === "number" || schema.type === "integer" ? Number(value) : value;
    }
    const taskId = `tool-${crypto.randomUUID()}`;
    const pending: PanelJob = { jobId: "", label: toolTitle(tool), status: "submitting", progress: 0, message: "提交中…", taskId };
    setJob(pending);
    setConfirmed(false);
    onTaskRef.current?.({ taskId, tool: tool.name, label: pending.label, args, status: "submitting", progress: 0, message: "提交中…" });
    try {
      const body = await (await engineRequest("/tools/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tool.name, arguments: args }),
      })).json();
      if (body.job_id) {
        setJob({ ...pending, jobId: body.job_id, status: "queued", message: "排队中…" });
        onTaskRef.current?.({ taskId, tool: tool.name, label: pending.label, args, status: "queued", progress: 0, message: "排队中…", jobId: body.job_id });
      } else {
        setJob({ ...pending, status: "completed", progress: 1, message: "完成", result: body });
        onTaskRef.current?.({ taskId, tool: tool.name, label: pending.label, args, status: "completed", progress: 1, message: "完成", result: body });
        onResult(body);
      }
    } catch (err) {
      setJob({ ...pending, status: "failed", error: String(err) });
      onTaskRef.current?.({ taskId, tool: tool.name, label: pending.label, args, status: "failed", progress: 0, message: String(err), error: String(err) });
    }
  };
  const cancel = async () => {
    if (!job?.jobId) return;
    try {
      const state = await (await engineRequest(`/jobs/${job.jobId}/cancel`, { method: "POST" })).json();
      setJob(cur => cur ? { ...cur, status: state.status, message: state.message } : cur);
    } catch (err) { setJob(cur => cur ? { ...cur, message: String(err) } : cur); }
  };
  return <form className="tool-panel" onSubmit={event => void run(event)}>
    {loadError && <><p className="chat-notice">工具目录加载失败：{loadError}</p><button type="button" className="icon-btn" onClick={() => void load()}>重试</button></>}
    {!catalog && !loadError && <p className="chat-notice toolbox-loading" role="status" aria-busy="true">正在加载工具…</p>}
    {!tool ? <>
      <div className="toolbox-heading"><h2>地理处理</h2><span>已加载 {catalog?.length ?? 0} 个工具{catalogHydrated ? "" : " · 正在补全 WASM"}</span></div>
      {catalogHydrated && catalog && catalog.length < 900 && <p className="toolbox-health" role="alert">工具目录不完整：仅加载 {catalog.length} 个工具（预期不少于 900 个）。请检查引擎与 WASM 目录。</p>}
      <label className="tool-field toolbox-search"><span className="sr-only">搜索工具</span>
        <input type="search" aria-label="搜索工具" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索工具、类别或子类，如 缓冲、SAR…" /></label>
      <div className="toolbox-groups" aria-label="工具箱">
        {groups.map(group => {
          const openL1 = !!search.trim() || !!expandedL1[group.name];
          return <section key={group.name} className="toolbox-group">
            <button type="button" className="toolbox-group-header" aria-expanded={openL1}
              onClick={() => setExpandedL1(cur => ({ ...cur, [group.name]: !openL1 }))}>
              <span className="toolbox-chevron" aria-hidden="true">{openL1 ? "⌄" : "›"}</span>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" /></svg>
              <span>{group.name}</span><span className="toolbox-count">{group.count}</span>
            </button>
            {openL1 && <div className="toolbox-subgroups">
              {group.subcategories.map(sub => {
                const key = `${group.name}\u0000${sub.name}`;
                const openL2 = !!search.trim() || !!expandedL2[key];
                return <section key={sub.name} className="toolbox-subgroup">
                  <button type="button" className="toolbox-subgroup-header" aria-expanded={openL2}
                    onClick={() => setExpandedL2(cur => ({ ...cur, [key]: !openL2 }))}>
                    <span className="toolbox-chevron" aria-hidden="true">{openL2 ? "⌄" : "›"}</span>
                    <span>{sub.name}</span><span className="toolbox-count">{sub.tools.length}</span>
                  </button>
                  {openL2 && <div className="toolbox-tool-list">{sub.tools.map(item => <button key={item.name} type="button" className="toolbox-tool" disabled={busy}
                    onClick={() => { setToolName(item.name); setValues(selectedLayer ? { layer: selectedLayer.id } : {}); setConfirmed(false); }}>
                    <span className="toolbox-tool-name">{toolTitle(item)}</span>
                    <span className="toolbox-tool-desc">{toolDesc(item)}</span>
                  </button>)}</div>}
                </section>;
              })}
            </div>}
          </section>;
        })}
        {catalog && groups.length === 0 && <div className="toolbox-empty" role="status">
          <strong>{search.trim() ? `没有匹配“${search.trim()}”的工具` : "没有可显示的工具"}</strong>
          <span>可搜索工具名、中文类别或用途，例如“线密度”“凹包”“加权叠加”。</span>
          <button type="button" className="icon-btn" onClick={() => setSearch("")}>清除搜索</button>
        </div>}
      </div>
    </> : <>
    <nav className="toolbox-breadcrumb" aria-label="工具位置"><button type="button" onClick={() => setToolName("")}>‹ 工具箱</button><span>/ {zhToolL1(tool)} · {zhToolL2(tool)}</span></nav>
    <div className="toolbox-heading"><h2>{toolTitle(tool)}</h2></div>
    {tool.name.startsWith("gee_") && <p className="toolbox-stub" role="status">
      {geeStatus?.demo
        ? "演示模式：表单与任务流程可运行，但不会检索或下载真实 Earth Engine 影像。"
        : geeStatus?.connected
          ? `Google Earth Engine 已连接${geeStatus.project ? `（项目 ${geeStatus.project}）` : ""}。`
          : geeStatus?.status === "configured_unverified"
            ? "已检测到 GEE 配置，但尚未验证服务端会话；搜索与导出保持禁用。"
            : "Google Earth Engine 未配置或未连接；认证状态与任务状态仍可查看，搜索与导出保持禁用。"}
    </p>}
    {tool.name.startsWith("wasm_") && <p className="tool-desc">在浏览器本机计算。矢量、栅格和表格图层都可作为输入；栅格结果按波段自动拉伸成图，表格与文件结果在下方下载。距离、面积等参数使用输入数据的坐标系单位。</p>}
    <p className="tool-desc">{toolDesc(tool)}</p>
    <h3 className="toolbox-section-label">参数</h3>
    <fieldset disabled={busy} className="tool-fields">
      {props.map(([name, schema]) => {
        const required = tool?.parameters.required?.includes(name);
        const label = `${FIELDS[name] ?? zhParam(name)}${required ? " *" : ""}`;
        const fieldTitle = `${name}${schema.description ? ` — ${schema.description}` : ""}`;
        const layerKind = schema["x-layer-kind"] ?? ((schema["x-layer"] || name === "layer" || name.endsWith("_layer")) ? "vector" : undefined);
        const kindName = layerKind === "any" ? "栅格或矢量" : KIND_ZH[layerKind ?? ""];
        const fieldParam = FIELD_PARAMS.has(name) && columns.length > 0;
        const kindLayers = layerKind ? layers.filter(l => layerKind === "any" ? l.kind === "raster" || l.kind === "vector" : (l.kind ?? "vector") === layerKind) : [];
        const options = layerKind ? kindLayers.map(l => ({ value: l.id, label: l.kind === "raster" ? `${l.name}（栅格 ${l.raster?.width}×${l.raster?.height}）` : l.kind === "table" ? `${l.name}（表格 ${l.feature_count} 行）` : `${l.name} (${l.feature_count})` }))
          : fieldParam ? columns.map(c => ({ value: c, label: c })) : schema.enum?.map(v => ({ value: v, label: name === "units" ? UNIT_LABELS[v] ?? v : v }));
        if (layerKind && schema["x-layer-multiple"]) {
          const selected = Array.isArray(values[name]) ? values[name] as string[] : [];
          return <label key={name} className="tool-field"><span>{label}</span>
            <select multiple required={required && kindLayers.length > 0} aria-label={label} title={fieldTitle} size={Math.min(6, Math.max(3, kindLayers.length))}
              value={selected} onChange={e => setValues(v => ({ ...v, [name]: Array.from(e.target.selectedOptions, option => option.value) }))}>
              {kindLayers.map(layer => <option key={layer.id} value={layer.id}>{layer.name}{layer.kind === "raster" ? `（${layer.raster?.width}×${layer.raster?.height}）` : ""}</option>)}
            </select>
            {!kindLayers.length && <small className="tool-desc">尚无{kindName}图层，请先导入或生成。</small>}
          </label>;
        }
        if (options) return <label key={name} className="tool-field"><span>{label}</span>
          <select title={fieldTitle} aria-label={label} required={required && options.length > 0} value={String(values[name] ?? schema.default ?? "")} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}>
            <option value="">— {layerKind ? (kindLayers.length ? `选择${kindName}图层` : `尚无${kindName}图层，请先导入或生成`) : "选择"} —</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>;
        if (schema.type === "boolean") return <label key={name} className="tool-field tool-check">
          <input type="checkbox" title={fieldTitle} checked={Boolean(values[name] ?? schema.default ?? false)} onChange={e => setValues(v => ({ ...v, [name]: e.target.checked }))} /><span>{label}</span></label>;
        return <label key={name} className="tool-field"><span>{label}</span>
          <input title={fieldTitle} aria-label={label} required={required} type={schema.type === "number" || schema.type === "integer" ? "number" : "text"}
            value={String(values[name] ?? "")} step={schema.type === "integer" ? "1" : "any"}
            placeholder={name === "path" ? "文件路径" : name.endsWith("crs") ? "EPSG:4326" : ""}
            onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} /></label>;
      })}
    </fieldset>
    {tool?.annotations?.destructiveHint && <label className="tool-field tool-check">
      <input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />
      <span>{tool.name === "remove_layer" ? "确认移除此图层及其工作副本" : "确认写入上述路径；勾选覆盖时将替换已有文件"}</span></label>}
    <button type="submit" className="primary-btn" disabled={!tool || busy || !geeExecutionAllowed(tool.name, geeStatus) || (!!tool.annotations?.destructiveHint && !confirmed)}>运行</button>
    </>}
    {job?.result?.download_url && <a className="primary-btn" href={job.result.download_url} download={job.result.path}>下载 {job.result.path}</a>}
    {Array.isArray(job?.result?.attachments) && job.result.attachments.map((file: { name: string; url: string }, index: number) =>
      <a key={index} className="primary-btn" href={file.url} download={file.name}>下载 {file.name}</a>)}
    {job && <div className="job-card" data-status={job.status} aria-live="polite">
      <div className="job-head"><strong>{job.label}</strong><span>{STATUS[job.status] ?? job.status} · {Math.round(job.progress * 100)}%</span></div>
      <div className="route-progress job-route"><span style={{ ["--progress" as string]: `${Math.round(job.progress * 100)}%` }} /></div>
      <div className="job-foot"><span>{job.error || detailOf(job.result) || job.message}</span>
        {job.jobId && busy && <button type="button" className="icon-btn" disabled={job.status === "cancelling"} onClick={() => void cancel()}>取消任务</button>}</div>
      <PipelineResultDetails output={job.result} />
      {job.result && !pipelineResult(job.result) && !job.result.layer && !job.result.layers && !job.result.path && !job.result.removed && <pre className="tool-result">{JSON.stringify(job.result, null, 2)}</pre>}
    </div>}
  </form>;
}
