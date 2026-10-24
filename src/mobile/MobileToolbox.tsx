import { useEffect, useMemo, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { engineRequest } from "../lib/service";
import { zhCategory, zhToolL1 } from "../lib/i18n/tools";
import { favouriteTools, recentTools, rememberTool, toggleFavourite } from "../lib/mobile/toolPrefs";
import { MobileSheet } from "./MobileSheet";
import { ToolPanel, toolDesc, toolTitle, type ToolTaskEvent } from "../components/ToolPanel";
import { ChevronRight, Search, Star, Wrench } from "lucide-react";

type CatalogItem = { name: string; label?: string; description?: string; category?: string; subcategory?: string };

const SKIP = new Set(["ping", "list_layers", "job_status", "job_cancel"]);
const LIMIT = 80;

type Props = {
  open: boolean;
  onClose: () => void;
  layers: DataLayer[];
  selectedLayer?: DataLayer;
  initialTool?: string | null;
  onResult: (result: Record<string, any>) => void;
  onTask: (event: ToolTaskEvent) => void;
  onOpenTask: (taskId: string) => void;
};

function titleOf(tool: CatalogItem) {
  return toolTitle(tool);
}
function descOf(tool: CatalogItem) {
  return toolDesc(tool);
}

/** Mobile toolbox: search, recent, favourites, categories, then the real schema form. */
export function MobileToolbox({ open, onClose, layers, selectedLayer, initialTool = null, onResult, onTask, onOpenTask }: Props) {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(1);
  const [favourites, setFavourites] = useState<string[]>(favouriteTools);
  const [recent, setRecent] = useState<string[]>(recentTools);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLastTaskId(null);
    setSearch("");
    setCategory("全部");
    setSelectedTool(initialTool || null);
    setRequestId(value => value + 1);
    setRecent(recentTools());
    setFavourites(favouriteTools());
  }, [open, initialTool]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadError("");
    void (async () => {
      try {
        const response = await engineRequest("/tools/catalog?hydrate=0", { signal: controller.signal });
        const data = await response.json();
        if (controller.signal.aborted) return;
        const tools: CatalogItem[] = Array.isArray(data.tools) ? data.tools.filter((tool: CatalogItem) => !SKIP.has(tool.name)) : [];
        setCatalog(tools);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(String(error));
      }
    })();
    return () => controller.abort();
  }, [open]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of catalog ?? []) {
      const label = zhToolL1(tool);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const order = ["矢量", "栅格", "地形", "水文", "遥感", "转换", "投影", "激光雷达", "数据管理", "查询", "图层", "GEE", "扩展", "其他工具"];
    return [...counts.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]); const bi = order.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [catalog]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (catalog ?? []).filter(tool => {
      if (category !== "全部" && zhToolL1(tool) !== category) return false;
      if (!query) return true;
      const haystack = `${titleOf(tool)} ${tool.name} ${tool.category ?? ""} ${tool.subcategory ?? ""} ${descOf(tool)}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
  }, [catalog, category, search]);

  const byName = (name: string) => catalog?.find(tool => tool.name === name);
  const recentToolsList = recent.map(byName).filter((tool): tool is CatalogItem => !!tool);
  const favouriteToolsList = favourites.map(byName).filter((tool): tool is CatalogItem => !!tool);

  const choose = (tool: CatalogItem) => {
    setSelectedTool(tool.name);
    setRequestId(value => value + 1);
    setLastTaskId(null);
    rememberTool(tool.name);
    setRecent(recentTools());
  };

  const selectedItem = selectedTool ? byName(selectedTool) : undefined;
  const subtitle = selectedItem ? zhCategory(selectedItem) : catalog ? `${catalog.length} 个工具 · 本地执行` : "正在加载工具目录…";

  const toggleFav = (name: string) => {
    toggleFavourite(name);
    setFavourites(favouriteTools());
  };

  const toolRow = (tool: CatalogItem) => <div key={tool.name} className="m-tool-row">
    <button type="button" className="m-tool-main" onClick={() => choose(tool)}>
      <strong>{titleOf(tool)}</strong>
      <small>{descOf(tool) || tool.name}</small>
      <span>{zhCategory(tool)}</span>
    </button>
    <button type="button" className="m-tool-star" data-active={favourites.includes(tool.name)}
      aria-label={`${favourites.includes(tool.name) ? "取消收藏" : "收藏"} ${titleOf(tool)}`}
      onClick={() => toggleFav(tool.name)}>
      <Star size={16} fill={favourites.includes(tool.name) ? "currentColor" : "none"} />
    </button>
    <ChevronRight size={16} className="m-tool-chevron" />
  </div>;

  return (
    <MobileSheet open={open} onClose={onClose} onBack={selectedTool ? () => setSelectedTool(null) : undefined}
      title={selectedItem ? titleOf(selectedItem) : "工具箱"} subtitle={subtitle}
      initialSnap={0} snapPoints={[0.55, 0.93]}>

      {!selectedTool && <>
        <label className="m-search m-search-sticky">
          <Search size={16} />
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索工具、类别或用途，如 缓冲、坡度" aria-label="搜索工具" autoComplete="off" />
        </label>

        {!search && <div className="m-chip-row" role="tablist" aria-label="工具类别">
          <button type="button" role="tab" aria-selected={category === "全部"} data-active={category === "全部"} onClick={() => setCategory("全部")}>全部</button>
          {categories.map(([name, count]) => <button key={name} type="button" role="tab" aria-selected={category === name} data-active={category === name} onClick={() => setCategory(name)}>{name}<span>{count}</span></button>)}
        </div>}

        {loadError && <div className="m-inline-notice" role="alert"><span>工具目录加载失败：{loadError}</span></div>}
        {!catalog && !loadError && <div className="m-loading" role="status">正在加载工具目录…</div>}

        {!search && category === "全部" && recentToolsList.length > 0 && <section className="m-tool-section">
          <h3>最近使用</h3>
          {recentToolsList.map(toolRow)}
        </section>}

        {!search && category === "全部" && favouriteToolsList.length > 0 && <section className="m-tool-section">
          <h3>收藏</h3>
          {favouriteToolsList.map(toolRow)}
        </section>}

        {catalog && <section className="m-tool-section">
          <h3>{search ? `搜索结果 · ${filtered.length}` : category === "全部" ? "全部工具" : category}</h3>
          {filtered.slice(0, LIMIT).map(toolRow)}
          {filtered.length > LIMIT && <p className="m-tool-more">已显示前 {LIMIT} 个，共 {filtered.length} 个。输入关键词可继续缩小范围。</p>}
          {!filtered.length && <div className="m-empty-inline"><Wrench size={18} /><strong>没有匹配的工具</strong><span>试试“缓冲”“裁剪”“坡度”或工具名称。</span></div>}
        </section>}
      </>}

      {selectedTool && <>
        <div className="m-tool-form-head">
          <span>{selectedItem ? zhCategory(selectedItem) : ""}</span>
          <button type="button" data-active={favourites.includes(selectedTool)} onClick={() => toggleFav(selectedTool)}>
            <Star size={14} fill={favourites.includes(selectedTool) ? "currentColor" : "none"} />
            {favourites.includes(selectedTool) ? "已收藏" : "收藏"}
          </button>
        </div>
        {lastTaskId && <button type="button" className="m-task-linkbar" onClick={() => onOpenTask(lastTaskId)}>
          <span>本次运行已计入任务中心</span><strong>查看任务详情 →</strong>
        </button>}
        <div className="m-tool-form">
          <ToolPanel layers={layers} selectedLayer={selectedLayer}
            request={{ id: requestId, tool: selectedTool }}
            onResult={onResult}
            onTask={event => { setLastTaskId(event.taskId); onTask(event); }} />
        </div>
      </>}
    </MobileSheet>
  );
}
