# 阶段 1 · 公共契约与桌面 WASM 可达性（2026-10-24）

> 依据：[MASTER_ROADMAP.md](MASTER_ROADMAP.md) §4 阶段 1（T-002/T-003/T-004 的先行部分）。
> 验收门槛：同一桌面 Agent 能运行至少一个 WASM 工具并把结果显示/保存；`gis.buffer`/`gis.reproject` 在标准数据与误差容差内通过；旧 UI 与取消/审批测试不退化。
> 本文件只写实际跑过的东西；未测项在 §7 明确列出。

## 1. 交付物

| 交付 | 位置 | 状态 |
|---|---|---|
| 共享纯类型与操作语义 | `shared/contracts/{types,operations,capabilities,index}.ts` | 已编译、8 项单测 |
| `inspect_layers`（两端只读图层体检） | `engine/tools.py` + `engine/layers.py` + `src/lib/browser/engine.ts` + `catalog.json` | Python 33 项测试、浏览器测试通过 |
| `gis.buffer` / `gis.reproject` 语义与跨引擎对照 | `scripts/compare-engines.ts`、`scripts/probe-engine-semantics.py`、[CROSS_ENGINE_SEMANTICS.md](CROSS_ENGINE_SEMANTICS.md) | 4 PASS / 2 DIVERGENT（真实发现） |
| 桌面 Agent → WASM 桥接 | `scripts/wasm-cli.mjs`、`agent/src/wasm.ts`、`agent/src/server.ts`（`wasm_run`） | 3 项 agent 测试通过 |
| 端到端演示：WASM 结果成为桌面图层 | `scripts/wasm-spike.ts`、`scripts/engine-add-layer.py`、[wasm-spike.json](baselines/stage1/wasm-spike.json) | PASS（3 要素，EPSG:4326 图层） |

复现：

```powershell
npm run test:contracts        # 契约单测
npm run compare:engines       # 双引擎 buffer/reproject 对照
npm run wasm:spike            # WASM → GeoJSON → Python 图层
npm run test:agent            # 含 wasm_run 的三项测试
```

## 2. 共享契约（版本 1）

规则（写进代码注释，也写在这里，防止以后被“优化”掉）：

1. **图层引用不等于显示 URL**。`LayerRef.data` 明确 `engine / storage / location / format / bytes / sha256 / revision`；浏览器是 `indexeddb:layer:<id>`，桌面是工作区 `.gpkg` 的真实路径。任何执行端都不得从显示 URL 猜原始文件。
2. **`crs` 是分析坐标系，`bounds` 永远是 WGS84 度**。投影图层的原生范围放在 `inspect_layers.extra.nativeBounds`，避免把米当度比较（阶段 0 的假阳性教训）。
3. **操作带版本**。`OperationSpec.version = 1`；语义变化必须升版本并重跑对照。
4. **`gis.buffer` 的距离是正的数量长度**，单位 `meters|kilometers|miles`，上限 5000 km。v1 明确不接受负距离（两端引擎对“内缩后为空”的行为不一致，见 §5）。缓冲区在本地米制 CRS 内计算，输出坐标系就是该分析 CRS。
5. **`gis.reproject` 在同一坐标系下是显式 no-op**，返回原图层并说明“未创建新数据集”，不伪造一次变换。浏览器引擎与桌面 Agent 都调用同一份 `planOperation()`，不存在两套判断。
6. **执行记录可复算**：`ExecutionRun` 带 `runId / operation / version / provider / input.sha256 / params / outputs / validation / durationMs`；`Validation` 区分 `gate` 与 `info`，`skipped` 不等于通过。
7. **错误分类冻结**：`INPUT_ERROR / UNSUPPORTED / RESOURCE_LIMIT / EXECUTION_ERROR / VALIDATION_ERROR / USER_CANCELLED`（阶段 3 只补充传输细节）。

能力表（实测来源见 [CATALOG_AUDIT.md](CATALOG_AUDIT.md)）：

| Provider | 注册表 | 操作版本 | 可取消 | 执行隔离 |
|---|---|---|---|---|
| `browser-wasm` | geolibre-wasm | buffer 1 / reproject 1 | 任务级（AbortSignal + 子进程） | 否（panic 会毒化实例，阶段 0 D2） |
| `desktop-python` | python-mcp | buffer 1 / reproject 1 | 步骤间协作式 | 是（独立 Python 进程） |

## 3. `inspect_layers`：把“图层在哪”变成可回答的问题

之前：`describe_layer` 只有 CRS/字段/样例，浏览器侧甚至连 `path` 都是拼给人看的字符串，Agent 无法知道分析数据在哪、版本是否变化。

现在两端都回答同一组问题：

- `layer.kind / crs / displayCrs / featureCount / bounds`；
- `layer.data`：存储位置、格式、字节数、sha256 与 `revision`（文件端用 mtime+size+摘要，浏览器用摘要+size）；
- `fields[]`：名称、类型、空值数、样例值；
- 栅格：宽高、波段、NoData、dtype、像元大小（Python 侧；浏览器侧如实省略 NoData——它确实没读）；
- `extra.nativeBounds`（Python 矢量）与 `extra.previewPngBytes`（浏览器栅格）；
- 不传 `layer` 时返回整个工作区，**单层失败只记入 `errors[]`，不拖垮整体**（有测试）。

证据：`engine/tests/test_inspect.py`（矢量位置/摘要/字段/空值、坏图层隔离、栅格 NoData），`tests/browser-engine.test.ts` 的 `inspect_layers ...` 用例（IndexedDB 位置、sha256 格式、栅格 120×100×1 波段）。

## 4. 双引擎对照：不是“都成功”，而是“是否同义”

同一批冻结 fixtures，各自跑、各自读回、在 EPSG:32650 米制下比较。容差：面积 ≤0.5%、半径 ≤2 m。

| 案例 | 判定 | 面积差 | 独立半径误差（浏览器/Python） |
|---|---|---|---|
| 500 m 点缓冲 | **PASS** | 0.000% | 1.07 m / 0.60 m |
| 500 m 缓冲 + dissolve | **DIVERGENT** | 0.000% | — |
| 2 km 面缓冲 | **PASS** | 0.000% | — |
| 负距离缓冲 | **DIVERGENT** | — | — |
| 点重投影到 3857 | **PASS** | — | — |
| 面重投影到 32650 | **PASS** | 0.000% | — |

两个分歧都是真实语义差异，不是数值误差：

1. **dissolve 的含义不同**：Python `unary_union` → 1 个要素；WASM `buffer_vector` 只合并相互重叠的缓冲 → 3 个要素。几何总量完全一致。**阶段 2 必须把“合并为单一要素”定义成独立语义**，不能继续共用 dissolve 这个名字。
2. **负距离**：契约 v1 在命令层拒绝；Python 引擎原生入口仍会静默发布 3 个空几何、NaN 范围的图层（浏览器原生入口拒绝）。阶段 2 修引擎：要么有效内缩，要么明确 `INPUT_ERROR`。

完整逐例数据：[CROSS_ENGINE_SEMANTICS.md](CROSS_ENGINE_SEMANTICS.md)、`docs/baselines/stage1/semantics.json`。

## 5. 桌面 Agent → WASM：选型与结果

阶段 0 的事实是：桌面 Agent 只连 Python MCP，958 个 WASM 工具只能由用户在工具箱里手点。本阶段给它加了一个受控入口 `wasm_run`。

| 维度 | WebView → WASM bridge | **Node → WASI shim（选用）** |
|---|---|---|
| 数据来源 | 需把图层字节从 IndexedDB 搬进/搬出消息通道 | 直接读本地文件路径，和 958 个 WASI 工具的 `/work` 约定天然一致 |
| 取消 | 复用浏览器 job 的 AbortSignal（需新协议） | 杀掉子进程，确定性强 |
| 崩溃隔离 | 与 UI 同实例，panic 会带走页面 | 每次运行独立子进程，panic 只死子进程 |
| 结果上图 | 直接进图层库 | 输出 GeoJSON，再走既有 `add_data`（本阶段已验证） |
| 成本 | 新 postMessage 协议 + 双份数据 | 输出需要一次 add_data；WASM 任务不进入现有浏览器 job 卡片 |

> 诚实说明：**我们没有实现 WebView 方案，因此这张表是设计权衡，不是对照测量**。若阶段 4 的时延数据表明搬移字节是瓶颈，再补测。

实现要点：

- `scripts/wasm-cli.mjs`：一个子进程只跑一个工具；读 `job.json`、把结果文件写回目录、写 `result.json`。stdout 不参与协议。
- `agent/src/wasm.ts`：从 `wasm-catalog.json` 读 manifest，只使用 **manifest 默认值 + 调用者显式参数**，未知参数直接拒绝。`wasm_search` 返回精确 wire name、kind、required、enum/default 与输出参数卡；`wasm_run` 支持 0..N 个命名输入和多个输出，不靠“第一个输入”猜测。
- `agent/src/wasm-inputs.ts`：工作区图层 id/名称经 `inspect_layers(...).layer.data.location` 解析为真实分析文件，绝不使用 WGS84 展示副本；本地文件路径直接绑定。
- 运行目录：子进程作业与输出统一放在 `TIPHYS_STATE_DIR/wasm-runs`（默认 `<project>/.tiphys/wasm-runs`），不再写只读的 `~/.tiphys`。
- 转换：每个矢量输出都用 `vector_convert` 转 GeoJSON，并按 RFC 7946 写入 `crs: EPSG:4326`，这样 `add_data` 不会因为“无 CRS”拒绝或猜错；转换失败会如实返回失败，不发布半成品。
- `agent/src/server.ts`：`wasm_search` + `wasm_run` 工具；系统提示要求先查参数卡、按 wire name 绑定输入，并在 `add_data` 成功后才声称已上图。

端到端证据（`npm run wasm:spike`，[wasm-spike.json](baselines/stage1/wasm-spike.json)）：

| 步骤 | 结果 |
|---|---|
| `reproject_vector`（bj_points → EPSG:32650） | 249 ms，产出 `.fgb` |
| `buffer_vector`（500 m） | 213 ms，产出 `.fgb` + `converted.geojson` |
| Python `LayerStore.add_from_path` + `inspect` | 3 要素、`EPSG:4326` 图层、有可访问 URL、sha256 记录 |

取消与错误（agent 测试）：50 ms 超时 → `cancelled=true`、无输出；随后同一工具正常运行（证明子进程隔离有效）；未知工具/未知参数/文件不存在均返回明确错误。

## 6. 回归证据

| 套件 | 结果 |
|---|---|
| `npm run test:contracts` | 8/8 |
| `npm run test:agent` | 23/23（含 3 项 `wasm_run`） |
| `npm run test:engine` | 33/33 |
| `npm run test:browser` | 68/69；唯一失败是 `map-render` 需要本机 Chrome/Chromium，本机未安装（**环境缺项，与本阶段改动无关，也未标记为通过**） |
| `npm run compare:engines` | 4 PASS / 2 DIVERGENT（分歧已记录，非回归） |
| `npm run wasm:spike` | PASS |

## 7. 没测的部分（NOT_TESTED）

| 项 | 原因 | 何时补 |
|---|---|---|
| 真实模型经 `wasm_run` 完成任务 | 需要模型配额；本阶段只验证执行层，不编造“Agent 会用” | 阶段 4 的 Playwright + 模型基线 |
| 打包后的 sidecar 里 `wasm-cli.mjs` 与 wasm 二进制路径 | 生产包尚未携带该脚本；本阶段只在源码树内验证 | 阶段 2 前的打包任务（需与 `bundle-sidecars` 一起设计） |
| 多输入 WASM 工具（PCA、加权叠加等） | 阶段 1 只支持单输入；**batch41 已解决**，现按 manifest wire name 绑定全部输入 | 已完成 |
| 栅格 WASM 经 `wasm_run` | 阶段 1 只跑了矢量 buffer 链；**batch41 已补**真实 `slope → raster_to_vector_polygons` 链与双输入 `add` | 已完成 |
| WebView 桥接的实测数据 | 未实现，只有设计比较 | 若阶段 4 出现字节搬运瓶颈再补 |
| 移动端 | 不在本阶段范围 | 阶段 4 |

## 8. 对阶段 2 的输入

1. `gis.clip` / `gis.dissolve` / `gis.zonal_statistics` 必须在此契约上扩展；**dissolve 的“单要素”语义先定清楚**（§4 分歧 1）。
2. 修复 Python 负距离/空结果发布（§4 分歧 2）与浏览器 `dissolve:true` 的语义。
3. 工具检索的标注集（≥200 条）应复用本阶段的 `OperationSpec` 语义做“能力过滤”，而不是再写一套映射。
4. `wasm_run` 的打包路径与多输入支持，是阶段 3 调度器可用的前提。
