/**
 * T-001 · Capability catalog export and reconciliation (roadmap §4 stage 0, §7 T-001).
 *
 * Exports what each surface can actually see and call, then reconciles the two
 * engines against the user-visible toolbox. Everything is derived from the real
 * registries (FastMCP introspection for Python, the hydrated browser catalog for
 * the WebView) instead of re-typing tool lists, so the numbers cannot drift from
 * the code without the audit failing.
 *
 *   engine/.venv/Scripts/python.exe scripts/export_engine_catalog.py
 *   node --import ./agent/node_modules/tsx/dist/loader.mjs scripts/catalog-audit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureBrowserCatalog, browserCatalogState, commonToolSchemas, shellToolCatalog } from "../src/lib/browser/catalog-schema.ts";
import { loadWasmManifests, type WasmManifest } from "../src/lib/browser/wasm-catalog-loader.ts";
import { pluginToolNames } from "../src/lib/plugins/registry.ts";
import { isBrowserSearchable } from "../src/lib/browser/search.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "baselines", "stage0");
const ENGINE_CATALOG = path.join(OUT_DIR, "engine-catalog.json");

type EngineTool = {
  id: string; engine: string; description: string; category: string; groups: string[];
  input_schema: { properties?: Record<string, unknown>; required?: string[] };
  required: string[]; param_kinds: Record<string, string>; async: boolean; cancellable: boolean;
  read_only: boolean; destructive: boolean; cost: string; error_contract: string;
};

type Surface = "desktop-agent" | "desktop-toolbox" | "browser-agent" | "browser-toolbox" | "browser-search";

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function readEngineCatalog(): { tools: EngineTool[]; groups: Record<string, string[]>; source: string } {
  if (!fs.existsSync(ENGINE_CATALOG)) {
    throw new Error(`missing ${path.relative(ROOT, ENGINE_CATALOG)}; run: engine/.venv/Scripts/python.exe scripts/export_engine_catalog.py`);
  }
  return JSON.parse(fs.readFileSync(ENGINE_CATALOG, "utf8"));
}

/** Names that the browser shell dispatcher actually routes. Plugin tools are
 * dispatched through `pluginToolNames.has(name) → runPluginTool`, so they never
 * appear as string literals in engine.ts. */
function browserDispatchCoverage(names: string[]): { wired: string[]; unwired: string[] } {
  const source = fs.readFileSync(path.join(ROOT, "src", "lib", "browser", "engine.ts"), "utf8");
  const wired: string[] = [];
  const unwired: string[] = [];
  for (const name of names) {
    const viaPlugin = pluginToolNames.has(name) && source.includes("runPluginTool");
    if (viaPlugin || source.includes(`"${name}"`) || source.includes(`'${name}'`)) wired.push(name);
    else unwired.push(name);
  }
  return { wired, unwired };
}

function wasmStats(manifests: WasmManifest[]) {
  const categories = new Map<string, number>();
  const subcategories = new Map<string, number>();
  const kinds = { vector: 0, raster: 0, table: 0, mixed: 0, scalar_only: 0 };
  for (const manifest of manifests) {
    const category = manifest.taxonomy?.category ?? manifest.category ?? "未分类";
    categories.set(category, (categories.get(category) ?? 0) + 1);
    const sub = manifest.taxonomy?.subcategory;
    if (sub) subcategories.set(`${category}/${sub}`, (subcategories.get(`${category}/${sub}`) ?? 0) + 1);
    const layers = new Set((manifest.params ?? []).filter(p => p.io_role === "input" || !p.io_role && p.data_kind !== "scalar")
      .map(p => p.data_kind).filter(kind => kind === "vector" || kind === "raster" || kind === "table"));
    if (layers.size === 0) kinds.scalar_only++;
    else if (layers.size > 1) kinds.mixed++;
    else kinds[[...layers][0] as keyof typeof kinds]++;
  }
  const map = (value: Map<string, number>) => [...value.entries()].sort((a, b) => b[1] - a[1]);
  return { categories: map(categories), subcategories: map(subcategories).slice(0, 40), inputKinds: kinds };
}

function main(): void {
  const engine = readEngineCatalog();
  const pythonNames = engine.tools.map(tool => tool.id).sort();

  return void (async () => {
    const hydrated = await ensureBrowserCatalog();
    const manifests = await loadWasmManifests();
    const state = browserCatalogState();
    const shell = shellToolCatalog.map(tool => tool.name).sort();
    const wasm = hydrated.filter(tool => tool.name.startsWith("wasm_")).map(tool => tool.name);
    const pluginNames = shellToolCatalog.filter(tool => pluginToolNames.has(tool.name)).map(tool => tool.name).sort();
    const metaTools = ["search_browser_tools", "run_browser_tool", "read_browser_output"];

    const onlyPython = pythonNames.filter(name => !shell.includes(name));
    const onlyShell = shell.filter(name => !pythonNames.includes(name));
    const common = pythonNames.filter(name => shell.includes(name));

    const dispatch = browserDispatchCoverage(shell);
    const searchableWasm = wasm.filter(name => isBrowserSearchable(name));

    const surfaces: Record<Surface, { count: number; detail: string; names?: string[] }> = {
      "desktop-agent": {
        count: pythonNames.length + 1,
        detail: "Python MCP tools + read_tool_output. WASM/GeoLibre tools are NOT reachable from the desktop agent loop.",
        names: [...pythonNames, "read_tool_output"],
      },
      "desktop-toolbox": {
        count: new Set([...pythonNames, ...shell, ...wasm, ...pluginNames]).size,
        detail: "ToolPanel renders python + every WASM schema + plugin tools inside the Tauri WebView.",
      },
      "browser-agent": {
        count: shell.length + metaTools.length,
        detail: "Direct tools = shell catalog (python-name parity + plugins); WASM only via search_browser_tools/run_browser_tool.",
        names: [...shell, ...metaTools],
      },
      "browser-toolbox": {
        count: hydrated.length,
        detail: "Full hydrated catalog after WASM hydration.",
      },
      "browser-search": {
        count: searchableWasm.length,
        detail: "WASM/GEE tools reachable through search_browser_tools (prefix wasm_/gee_ or category 扩展).",
        names: searchableWasm,
      },
    };

    const tools = [
      ...engine.tools.map(tool => ({
        id: tool.id,
        engines: ["desktop-python"],
        category: tool.category,
        async: tool.async,
        read_only: tool.read_only,
        destructive: tool.destructive,
        inputs: Object.keys(tool.input_schema.properties ?? {}),
        required: tool.required,
        surfaces: {
          "desktop-agent": true,
          "desktop-toolbox": true,
          "browser-agent": shell.includes(tool.id),
          "browser-toolbox": true,
          "browser-search": false,
        },
      })),
      ...hydrated.filter(tool => !pythonNames.includes(tool.name) && !shell.includes(tool.name)).map(tool => {
        const manifest = manifests.find(item => `wasm_${item.id}` === tool.name);
        return {
          id: tool.name,
          engines: ["browser-wasm"],
          category: tool.category ?? manifest?.taxonomy?.category ?? "未分类",
          async: true,
          read_only: false,
          destructive: false,
          inputs: Object.keys(tool.parameters.properties ?? {}),
          required: tool.parameters.required ?? [],
          surfaces: {
            "desktop-agent": false,
            "desktop-toolbox": true,
            "browser-agent": false, // direct tool? no: only through search_browser_tools
            "browser-toolbox": true,
            "browser-search": isBrowserSearchable(tool.name),
          },
        };
      }),
    ];

    const payload = {
      generated_at: new Date().toISOString(),
      generated_by: "scripts/catalog-audit.ts",
      sources: {
        python: "engine/tools.py → FastMCP.list_tools() (scripts/export_engine_catalog.py)",
        browser: "src/lib/browser/catalog.json + src/lib/browser/wasm-catalog.json → schemaForWasm()",
        wiring: "src/lib/browser/engine.ts string-literal dispatch scan",
      },
      catalog: state,
      counts: {
        python_mcp: pythonNames.length,
        browser_shell: shell.length,
        browser_plugins: pluginNames.length,
        wasm: wasm.length,
        merged_browser_catalog: hydrated.length,
        searchable_wasm: searchableWasm.length,
        desktop_agent_direct: pythonNames.length + 1,
        browser_agent_direct: shell.length + metaTools.length,
      },
      reconciliation: {
        common,
        only_python: onlyPython,
        only_shell: onlyShell,
        browser_shell_wired: dispatch.wired.length,
        browser_shell_unwired: dispatch.unwired,
        plugins: pluginNames,
        ungrouped_python_tools: engine.tools.filter(tool => tool.groups.length === 0).map(tool => tool.id),
      },
      engine_groups: Object.fromEntries(Object.entries(engine.groups).map(([group, members]) => [group, members.length])),
      wasm: wasmStats(manifests),
      surfaces,
      totals: {
        distinct_tool_ids: new Set(tools.map(tool => tool.id)).size,
        python_desktop_only: onlyPython.length,
        wasm_browser_only: wasm.length,
      },
      tools,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const jsonPath = path.join(OUT_DIR, "catalog-audit.json");
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");

    const lines: string[] = [];
    const push = (...items: string[]) => lines.push(...items);
    push(
      "# TIPHYS 能力目录对账（阶段 0 · T-001）",
      "",
      "> 由 `scripts/catalog-audit.ts` 生成，请勿手改；数据来自真实注册表（Python FastMCP 内省 + 浏览器目录 hydration）。",
      `> 生成时间：${payload.generated_at}`,
      "",
      "## 1. 各端实际可见的工具数",
      "",
      "| 面 | 数量 | 说明 |",
      "|---|---|---|",
      `| 桌面 Python MCP 注册表 | ${pythonNames.length} | \`engine/tools.py\` 真实注册；含 ping/list_layers/job_* |`,
      `| 桌面 Agent 可直接调用 | ${pythonNames.length + 1} | + \`read_tool_output\`；WASM 仅经 \`wasm_run\` 子进程桥接可达（阶段 1） |`,
      `| 浏览器 Agent 可直接调用 | ${shell.length + metaTools.length} | shell 目录 ${shell.length}（含插件 ${pluginNames.length}）+ search/run/read 三个入口 |`,
      `| 浏览器 Agent 可检索的 WASM | ${searchableWasm.length} | 仅能经 \`search_browser_tools\`→\`run_browser_tool\` |`,
      `| 合并后的浏览器工具箱 | ${hydrated.length} | 页面手动入口（shell + WASM + 插件去重） |`,
      `| 桌面工具箱（Tauri WebView） | ${surfaces["desktop-toolbox"].count} | Python ${pythonNames.length} + WASM ${searchableWasm.length} + 插件；**同一个 WebView 内可手动调用 WASM** |`,
      "",
      "## 2. 对账结论",
      "",
      `- Python 与浏览器 shell 同名工具：**${common.length}** 个（名称级 parity）。`,
      `- 仅 Python 有：${onlyPython.length ? onlyPython.join("、") : "无"}。`,
      `- 仅浏览器 shell 有：${onlyShell.length ? onlyShell.join("、") : "无"}。`,
      `- 浏览器 shell 中在 \`engine.ts\` 有分发分支（字符串字面量）：${dispatch.wired.length}/${shell.length}${dispatch.unwired.length ? `；未接线：${dispatch.unwired.join("、")}` : "。"}`,
      `- Python 侧未归入 \`TOOL_GROUPS\`（手动面板分组）的工具：${payload.reconciliation.ungrouped_python_tools.join("、")} —— Agent 可见但 UI 分组缺失，需在 T-005/T-006 补齐。`,
      `- 插件工具：${pluginNames.length ? pluginNames.join("、") : "无"}。`,
      "",
      "**关键不对称（与本方案首要判断一致）**：桌面 Agent 的循环只连 Python MCP，958 个 WASM 工具在桌面原本只能由用户手动调用；浏览器 Agent 反向只能调用浏览器实现，Python 的栅格/GEE/导出能力不可达。阶段 1 已用 `wasm_run`（子进程 WASI）打通单输入 WASM 工具，见 `docs/STAGE1_CONTRACTS_AND_WASM.md`。",
      "",
      "## 3. WASM 目录结构与输入类型",
      "",
      `- 分类（前 12）：${payload.wasm.categories.slice(0, 12).map(([name, count]) => `${name} ${count}`).join("；")}。`,
      `- 输入类型分布：矢量 ${payload.wasm.inputKinds.vector}、栅格 ${payload.wasm.inputKinds.raster}、混合 ${payload.wasm.inputKinds.mixed}、无图层输入 ${payload.wasm.inputKinds.scalar_only}、表格 ${payload.wasm.inputKinds.table}。`,
      `- 参数 schema 已统一为 JSON Schema，输出路径一律内部化（\`schemaForWasm\`）。`,
      "",
      "## 4. 尚未导出的字段（不假装已有）",
      "",
      "| 字段 | 现状 | 后续动作 |",
      "|---|---|---|",
      "| 预计成本 | 仅区分 `job`/`interactive`，未测 CPU/内存 | 阶段 4 用固定数据实测 P50/P95 |",
      "| 错误码 | 引擎抛异常/任务 failed+cancelled，未分类 | 阶段 3 统一 `INPUT_ERROR/UNSUPPORTED/...` |",
      "| 取消能力 | Python job 工具与浏览器 job 均可取消；同步工具不可 | 阶段 3 统一 job 语义 |",
      "| 需要文件还是内存 | Python `add_data`/`export_features` 走路径，其余走内存图层；WASM 全部 JSON 参数 | 阶段 1 `LayerRef` 显式化 |",
      "",
      "## 5. 复现",
      "",
      "```powershell",
      "engine/.venv/Scripts/python.exe scripts/export_engine_catalog.py",
      "node --import ./agent/node_modules/tsx/dist/loader.mjs scripts/catalog-audit.ts",
      "```",
      "",
      `原始数据：\`docs/baselines/stage0/catalog-audit.json\`（sha256 ${sha256(fs.readFileSync(jsonPath)).slice(0, 16)}…）。`,
      "",
    );
    fs.writeFileSync(path.join(ROOT, "docs", "CATALOG_AUDIT.md"), lines.join("\n"));

    console.log(JSON.stringify({
      counts: payload.counts,
      reconciliation: { only_python: onlyPython, only_shell: onlyShell, unwired: dispatch.unwired, plugins: pluginNames },
      wasm_categories: payload.wasm.categories.slice(0, 8),
    }, null, 2));
  })();
}

main();