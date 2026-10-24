# 阶段 0 · T-001：能力目录对账与可复现基线（2026-10-24）

> 依据：[MASTER_ROADMAP.md](MASTER_ROADMAP.md) 第 4 节阶段 0、第 7 节 T-001。
> 本轮交付的是**可复现的测量工具与第一份事实记录**，不是功能宣称。凡是没跑的部分都标 `NOT_TESTED` 并写明原因。

## 1. 这一阶段做了什么

| 交付 | 位置 | 说明 |
|---|---|---|
| 引擎目录导出 | [engine-catalog.json](baselines/stage0/engine-catalog.json) · `scripts/export_engine_catalog.py` | 用真实 `FastMCP.list_tools()` 内省 `engine/tools.py`，不是手抄清单 |
| 目录对账 | [CATALOG_AUDIT.md](CATALOG_AUDIT.md) · [catalog-audit.json](baselines/stage0/catalog-audit.json) · `scripts/catalog-audit.ts` | 各端可见数量、同名/独有工具、浏览器分发接线、WASM 分类与输入类型 |
| 固定测试数据 | `tests/fixtures/*` · `scripts/make-test-fixtures.py` | 合成 DEM（120×100、600×500）、分区面、道路线、自相交面，全部可重建并记录 sha256 |
| 30 项任务集 | `tests/baseline/tasks.json` | 10 单工具 + 12 多步 + 8 复杂/歧义/异常；中文自然语言 prompt + 参考执行序列 + 程序化断言 |
| 基线执行器 | `scripts/run-baseline.ts` | 每个任务独立子进程（WASM panic 不污染下一项），记录图层产物、CRS、要素数、字节数与 sha256 |
| 第一份结果 | [baseline-results.json](baselines/stage0/baseline-results.json) · [baseline-results.md](baselines/stage0/baseline-results.md) | 30 项 × 3 次 = 90 次运行：84 PASS / 0 FAIL / 6 ERROR（错误全部集中在 M01/M02，3/3 次可复现） |

复现命令（Windows 本机）：

```powershell
engine/.venv/Scripts/python.exe scripts/make-test-fixtures.py       # 重建 fixtures
engine/.venv/Scripts/python.exe scripts/export_engine_catalog.py    # 导出 Python MCP 目录
npm run audit:catalog                                               # 目录对账 → docs/CATALOG_AUDIT.md
npm run baseline                                                    # 30 项参考执行 → docs/baselines/stage0/
```

## 2. 目录对账结论（事实，不含推测）

| 面 | 数量 | 含义 |
|---|---|---|
| Python MCP 注册表 | 34 | 桌面 Agent 的**唯一**工具来源 |
| 桌面 Agent 可直接调用 | 35 | 34 + `read_tool_output` |
| 浏览器 Agent 可直接调用 | 42 | shell 目录 39（含 5 个插件）+ `search/run/read` 三个入口 |
| 浏览器 Agent 可检索 WASM | 958 | 只能经 `search_browser_tools` → `run_browser_tool` |
| 合并后的工具箱（WebView 手动） | 997 | shell + WASM + 插件去重 |
| 桌面工具箱（Tauri WebView） | 997 | **同一页面里可手动调用 958 个 WASM 工具** |

**核心不对称**：桌面 Agent 循环只连 Python MCP，958 个 WASM 工具在桌面端只能由用户手动调用；浏览器 Agent 反向够不到 Python 的栅格/GEE/导出能力。这正是路线图“首要判断”里要消除的差距，也是阶段 1 `T-002/T-004` 的直接理由。

> 阶段 1 追加了只读工具 `inspect_layers`（Python + 浏览器各 1 个），因此当前数字为 Python 35 / 浏览器 shell 40 / 合并 998；本表保留阶段 0 的快照口径，最新数字见 [CATALOG_AUDIT.md](CATALOG_AUDIT.md)。

其他核对结果：
- Python 与浏览器 shell 的 34 个同名工具**名称级 100% 对齐**，浏览器侧没有实现缺口（全部有分发分支）；
- 5 个插件工具（`clip_layers_to_aoi`、`hydrology_flow_pipeline`、`least_cost_path_pipeline`、`linkage_mapper_corridor`、`whitebox_extra`）只存在于浏览器，Python 侧无对应物；
- Python 侧 `ping`、`list_layers`、`job_status`、`job_cancel` 未归入 `TOOL_GROUPS`，所以在手动工具箱里没有分组入口（Agent 可见）。

## 3. 30 项基线：测什么、怎么判

任务集按路线图要求覆盖简单/多步/复杂三类，并刻意包含**单位陷阱、无效几何、不支持能力、覆盖冲突、取消、空结果、大栅格资源**这些“执行成功但结论可能错误”的场景。每项任务包含：

- `prompt`：用户会真的这么说的一句话（中文）；
- `steps`：参考执行序列，作为真值来源与回归输入；
- `checks`：程序化断言。缓冲半径用**独立球面距离**复核（不信任工具自报），面积/要素数/CRS/行列数/导出字节数/任务状态均逐项记录；
- `artifacts`：每次运行产出图层的 id、CRS、要素数、文件字节数与 sha256，写进 `baseline-results.json`。

执行方式：每个任务、每次运行都在**独立子进程**里跑（`run-baseline.ts` 自带编排）。这样既能做到 3 次重复，也能保证一次 WASM panic 不会污染后续任务或后续重复。

覆盖矩阵：

| 维度 | 覆盖 |
|---|---|
| 矢量 | 缓冲、重投影、属性选择、位置选择、空间连接、裁剪、求交、融合、凸包、量算、属性表、导出/回读（GeoJSON/CSV/GPKG） |
| 栅格 | 坡度、山体阴影、等高线、线转栅格、面化、600×500 大栅格 |
| 水文 | 填洼 → D8 流向 → 汇流累积 → 河网提取 → 矢量化；D8 → 流域面 |
| 异常 | 缺参数、经纬度米制、自相交面、线裁剪不支持、同名导出、取消、空结果 |
| 端 | 仅浏览器 WASM（桌面 Python 端与移动端本轮 **NOT_TESTED**，原因见 §6） |

## 4. 结果与发现

第一轮：**90 次参考运行 = 30 项 × 3 次；84 PASS / 6 ERROR**。错误全部来自 M01/M02，且 3/3 次稳定复现（不是抖动）。逐项结果见 [baseline-results.md](baselines/stage0/baseline-results.md)。

### D1（高）`dissolve` 继承退化 `snap_tolerance`，投影坐标系下产出损坏文件

- 复现：`buffer`（EPSG:32650）→ `dissolve` ⇒ 报 `SyntaxError: Bad control character in string literal in JSON`。
- 证据：直接跑 CLI 对比，`--snap_tolerance=2.220446049250313e-16`（manifest 默认值）产出 **660 字节**的损坏 FGB，`vector_info` 读出 `epsg:436207616`、字段名含 `\u0000` 等控制字符；改成 `--snap_tolerance=0.001` 后产出 **4080 字节**、1 个 MultiPolygon、`epsg:32650`，完全正常。
- 影响：融合是叠加分析的核心步骤，M01/M02 因此失败；错误信息完全无法定位。
- 归属：阶段 2 `gis.dissolve` 契约（T-005/T-006），修复方式为按 CRS 单位给出合法容差（或省略该参数），并在输出后做读回校验。

### D2（高）`vector_info` 在部分 FGB 上 panic，且会毒化整个 WASM 实例

- 复现：`dissolve --dissolve_field=kind` 输出 888 字节、`vector_convert` 可正常读成 GeoJSON，但 `vector_info` 抛 `RuntimeError: unreachable`（Whitebox flatgeobuf `slice index starts at …`）。
- 后果：同一进程内**之后所有** WASM 工具都以 `unreachable` 失败（实测 M02 被前一个任务的 panic 连带）。
- 缓解：本轮基线用“每任务独立子进程”隔离，避免污染；但产品里任务共享 WASM 实例，属真实可靠性缺口（阶段 3）。
- 修复方向：`adopt` 不再依赖 `vector_info`，改由 `vector_convert` 的 GeoJSON 读回推导 CRS/要素数/范围；并对 panic 后的实例做回收。

### D3（中）`buffer(dissolve:true)` 语义与可组合性不清

- 5 个点、800 米、`dissolve:true` 得到 2 个要素，且其结果不能被后续 `dissolve` 再次处理（撞上 D1/D2）。
- 归属：阶段 2 明确“工具内 dissolve”与独立 `dissolve` 的关系，并给出一致输出。

### D4（低）手动工具箱缺少 4 个系统工具的分组

`ping` / `list_layers` / `job_status` / `job_cancel` 未进入 `TOOL_GROUPS`，UI 无分组入口。

### 通过的关键断言（说明现有能力是可信的）

- 500/1000 米缓冲在经纬度图层上经独立球面复核，误差 < 2 m（单位没有退化成“度”）；
- 重投影后图层 `crs=EPSG:3857`，显示副本仍为 WGS84，`bounds` 不会被误当投影坐标；
- 面积量算与球面估算一致（zone A ≈ 113.8 km²）；求交面积不超过掩膜；
- 空间连接不产生重复要素（5 点仍是 5 行，带 `JOIN_*` 字段）；
- 空选择返回 0 要素图层而不是报错/`null`；
- 同名导出第二次被拒绝（不静默覆盖）；
- 取消 PCA 任务后 `job=cancelled` 且**没有**发布半成品图层；
- 水文 5 步链与流域面提取全部产出非空结果；
- 600×500 DEM 坡度 < 30 s（实测约 0.2 s，含导入）。

## 5. “没测”的部分（明确 NOT_TESTED）

| 项 | 原因 | 何时补 |
|---|---|---|
| 模型在环的任务成功率（30 项 × 3 次） | 浏览器 Agent 循环依赖 DOM/Worker/object URL，本轮没有 Playwright 驱动；不编造数字 | 阶段 4，用 Playwright 驱动真实页面 + 固定模型，复用同一 `tasks.json` |
| 桌面 Python 端同名任务 | Python 引擎需要启动 sidecar；本轮只验证浏览器参考实现 | 阶段 1（跨引擎语义对照） |
| 移动端 390×844 完整任务 | 需要真实移动布局与内存限制下的运行环境 | 阶段 5（T-010） |
| 成本/时延分布（P50/P95） | 只记录单次耗时，未做统计采样 | 阶段 4 |
| GEE 真实影像 | 没有已验证的 Earth Engine 会话，工具返回“未连接”是正确行为 | 阶段 7（T-014 起） |

## 6. 对下一阶段的输入

1. **阶段 1 的直接输入**：桌面 Agent 与 WASM 的 958 工具缺口（§2）、显示副本/native CRS 的契约（已在本轮被断言固化）、`adopt` 不依赖 `vector_info`（D2）。
2. **阶段 2 的直接输入**：`dissolve` 容差与属性合并语义（D1/D3）。
3. **阶段 3 的直接输入**：WASM 实例 panic 后的隔离与恢复（D2）、取消/半成品发布语义（已通过 H06）。
4. 基线从此只用 `tasks.json` 的 sha256 判定“同一把尺子”；任何指标变化必须附 `baseline-results.json` 前后两份。