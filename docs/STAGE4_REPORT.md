# 阶段 4 报告：系统对照评测 + 手机分析体验

> 对应 [MASTER_ROADMAP.md](MASTER_ROADMAP.md) §4 阶段 4。首版结论（模型基线 28/30、移动 7/7）见下；**A/B 对照、预算制与两张新任务卡的补充结果见 §7**。外部基准 GeoAgentBench 的适配单独成节（§8），不与自有基线混算。

## 1. 交付物

| 交付 | 位置 |
|---|---|
| Agent 模式判据（30 任务，只依赖可观测事实） | `tests/baseline/agent-success.json` |
| Agent 基线驱动器（Playwright + 真实页面 + 交互点：审批/取消） | `scripts/run-agent-baseline.ts`（`npm run baseline:agent`，支持 `--only=`、`--merge=`） |
| Agent 基线结果 | `docs/baselines/stage4/agent-baseline.{json,md}` |
| 任务卡库（5 预设 + 手机像素预算 2M + 槽位防冲突） | `src/lib/taskCards.ts` + `tests/task-cards.test.ts`（7 项） |
| 任务卡组件（桌面/手机同源；执行前说明、验收结论、导出） | `src/components/TaskCards.tsx`、`ChatTimeline.tsx`、`ChatDock.tsx`、`App.tsx` |
| 移动基线驱动器（iPhone 12 仿真 390×844） | `scripts/run-mobile-baseline.ts`（`npm run baseline:mobile`） |
| 移动基线结果 | `docs/baselines/stage4/mobile-baseline.{json,md}` |
| token 遥测（usage 事件） | `src/lib/browser/agent.ts` |
| 超预算 DEM fixture（2.24M 像素） | `scripts/make-test-fixtures.py` → `tests/fixtures/dem_over_budget.tif` |
| 环境缺口关闭：Windows Chrome 路径 | `tests/map-render.test.ts`（套件从 69/70 → **70/70**） |

复现：

```powershell
npm run dev               # 终端 1（驱动器不自行启动 dev server）
npm run baseline:agent    # 30 任务 × 真实模型（约 25 分钟，消耗内置 key 额度）
npm run baseline:mobile   # 7 场景 × iPhone 12 仿真（约 2 分钟）
```

## 2. Agent 基线：模型在环的第一组真实数字

设置：真实网页（vite dev）、内置 tierflow_pro、每任务独立浏览器上下文、fixtures 经真实导入路径预载、中文 prompt 只发一次；驱动器只做产品级交互（导出审批自动同意、取消类任务在 job 出现后 150ms 轮询取消）。评分只看可观测事实（新图层属性、独立球面半径复核、事件流、导出通知、回答文本），**不预设工具序列**。

| 指标 | 数值 |
|---|---|
| 任务成功率 | **28/30 PASS**（93%） |
| 预期工具命中 | 21/30（其余多为合理的替代路径，见下） |
| 耗时 | P50 37 s / P95 84 s（含页面加载与模型轮次） |
| tokens（本轮累计） | 输入 350,826 / 输出 12,516 |

值得记录的模型行为（不是噪声，是产品洞察）：

1. **M01（缓冲后合并）**：模型一步 `buffer(dissolve:true)` 得到 2 个面，并正确解释"5 个点分成两组、组间距超过 1600 米所以不合并"——与阶段 1 跨引擎对照记录的 dissolve 语义完全一致。初版判据按"先 5 后 1"写，是判据错，不是模型错。
2. **M09（河网）**：第一轮用产品内置 `hydrology_flow_pipeline` 一步完成并矢量化（正当替代路径，判据已接受）；第二轮在 8 步上限内做了 9 次 `search_browser_tools` 后最后一步参数名写错（`缺少参数：input`）而耗尽预算。**同一任务两次运行一成一败，主因是检索消耗步数**。
3. **H05（同名导出）**：模型拒绝猜路径、诚实追问输出位置——安全属性（不静默覆盖）保持，且暴露一个产品问题：浏览器端导出本不需要绝对路径，模型被桌面心智带偏（后续在提示词里澄清）。
4. **H01（歧义距离）**：模型选择追问而不是瞎跑，符合"不能编造参数"的护栏。
5. **H06（取消）**：驱动器取消 2.24M 像素 DEM 的长任务，job 状态 `cancelled`、对话以错误收尾不假成功；此前已完成的快工具图层保留（合法）。

失败样本（保留，不粉饰）：

| 任务 | 表现 | 归因 |
|---|---|---|
| M09 | 9 次检索 + 参数名错（input/d8_pntr）→ 8 步上限耗尽 | 检索消耗步数；WASM 参数名（如 `d8_pntr`）对模型不友好 |
| M11 | 4 次检索未命中 basins → `缺少参数：d8_pntr` → 触顶 | 同上 |

**对路线图的直接输入**：`stepCountIs(8)` 静态上限应改为按任务类别的调用/时间/token 预算（§3.4 已规划，现在有数据支撑）；候选工具的参数卡应在检索结果里更醒目。

## 3. 手机端：任务卡闭环（验收门槛满足）

iPhone 12 仿真（390×844，touch，deviceScaleFactor 3）× 真实 WASM 引擎：

| 场景 | 内容 | 结果 |
|---|---|---|
| M1 | 点缓冲 500 m：说明→执行→验收（要素数一致+Polygon）→**导出链接** | PASS |
| M2 | 面裁剪（district_zones × zone_a） | PASS |
| M3 | 叠加求交 + area_m2 量算（2 步计划，2 验收） | PASS |
| M4 | 字段统计（自动建议 pop 字段，只读） | PASS |
| M5 | DEM 坡度 + 山体阴影，**运行中短暂后台后恢复**，验收栅格尺寸一致 | PASS |
| M6 | 2.24M 像素 DEM：**执行前拒绝**（超 2M 手机预算），降级建议可见，按钮禁用 | PASS |
| M7 | 同图层裁剪：阻止 + 原因 + 降级，不误跑 | PASS |

任务卡形态（桌面/手机同一组件）：中文任务句（可编辑）→ 槽位/参数选择（自动建议、防冲突）→ **执行前说明**（本地 WASM、数据不出设备、输入规模、预算占用百分比）→ 计划步骤预览 → 本地执行（job 进度）→ **验收明细**（逐条 ✓/✗）→ 可交付图层 + 导出。自由输入仍走聊天 Agent（桌面已测）。

过程中修复的真实缺陷：

1. **任务卡预设 bug**：坡度步骤的验收引用了后序步骤（山体阴影）——运行诚实判 VALIDATION_ERROR 而非假成功，改预设步骤顺序后通过。这本身就是阶段 3 验收门在真实场景的一次回归。
2. 手机聊天手柄此前只在有对话记录时显示——新用户根本进不了任务卡，改为常驻。
3. HMR 后页面内出现双 engine 模块实例导致取消路由拿不到 job controller，驱动器改走 agent 自身的 `/jobs/cancel`（产品路径）。

## 4. 回归结果

| 套件 | 结果 |
|---|---|
| `npm run test:browser` | **70/70**（map-render 在本机 Chrome 下通过，长期"环境缺项"关闭） |
| `npm run test:plans` | 21/21（plans 14 + task-cards 7） |
| `npm run baseline:plans` | 11/11，auditRuns 0 违规 |
| `npm run test:agent` / `test:engine` / `test:contracts` / `test:methods` / `test:search` | 23/23 · 38 通过 · 11/11 · 4/4 · 5/5（未改动路径） |
| `npx tsc --noEmit` | 通过 |

## 5. NOT_TESTED（明确未测）

首版遗留（§7 已解决的标注 ✅）：

- ✅ **A/B 对照**：已完成，见 §7。
- **单样本方差**：每任务每臂 1 次运行；M09 在 A 臂两轮一成一败说明方差不可忽略，正式结论需 ≥3 次。
- ✅ **GeoAgentBench 适配**：兼容子集已跑，见 §8（GeoAnalystBench 仍未做）。
- **真机**：全部为桌面 Chrome 仿真（含移动仿真）；未在实体手机上验证触控/性能/后台生命周期。
- 模型为内置 tierflow_pro 单模型；无跨模型对比。

## 6. 阶段 5 的输入

1. ✅ 预算制替代 8 步上限：已实现（`src/lib/browser/budget.ts` + agent 循环），A/B 验证见 §7。
2. ✅ 检索候选的参数卡呈现（`d8_pntr` 类参数名）已于 2026-10-25 产品化：层参数以精确 wire name + raster/vector + required + 中文标签返回。单次 M11 复跑不再出现“缺少参数：d8_pntr”，模型已生成 `Basins` 栅格；仍 FAIL 于后续栅格转面检索/预算与独立的 `run_plan` 内部错误。
3. ✅ A/B 驱动器（`--arm`、`--only`、`--merge`）+ 对照报告生成器（`npm run compare:arms`）。
4. ✅ 任务卡预设已扩展为阶段 5 配方入口：`hydro-network`（5A）与 `service-zone`（5B），移动基线新增 M8/M9 场景（9/9）。

## 7. A/B 对照与预算制（补充，2026-10-24 晚）

针对 §2 两个失败样本的根因，做了两处改造并跑 B 臂全量：

1. **预算制**（`budget.ts`）：步数 24 / 单轮 8 分钟 / 上下文 85% 三重预算替代静态 8 步；超限诚实报"哪一维耗尽、成果已保留"。
2. **规划提示词**：多步任务先规划、优先 `run_plan`（@步骤引用 + 验收断言）、检索结果的参数名不许猜；方法卡按触发词注入（最多 2 张，只给"先问什么/怎么验收/易错什么"）。

| 指标 | A 臂（直接工具+8 步） | B 臂（预算+规划） |
|---|---|---|
| 任务成功 | 28/30 | **29/30**（M09 修复；M11 仍败） |
| run_plan 使用 | 0 任务 | 2 任务（M02、M04） |
| P50 耗时 | 38 s | 45 s（预算允许难任务跑完） |
| 输入 tokens | 350,826 | 333,461（−5%） |

解读（单次运行，方向性）：预算制把"检索吃光步数"的失败模式消掉了（M09 两次运行一成一败 → B 臂稳定通过）；规划路径被模型自发使用的比例仍低（2/30），说明**提示词引导不足以让模型改变习惯**，run_plan 的价值目前更多在任务卡（确定性入口）而非自由对话；M11 的残留失败仍是检索→参数名摩擦，对应 §6.2 的产品化工作。完整逐任务表：`docs/baselines/stage4/agent-ab.md`。

移动端同步更新：任务卡新增河网（5 步链）与服务圈（双图层统计）两张，移动基线扩到 **9/9 场景**（M8 河网卡闭环、M9 服务圈卡闭环均通过）。

## 8. 外部基准：GeoAgentBench 兼容子集（单独报告）

适配策略：36 任务中选 6 个（引擎原生支持 + 输出格式可产出：重投影/凸包/质心/求交/空值过滤/KML 转换），用**基准自带的 grade.py**（engine Python + `PYTHONPATH=eval`）评分，排除项逐条给原因。参考解经我们环境跑分验证（gates/subchecks 全满）后才开跑；评分器曾因相对路径未启动导致一轮"空真 PASS"，已修复并加空真守卫（空判定=驱动器失败而非通过）。结果见 `docs/baselines/stage4/geoagentbench.{json,md}`——**不与 TIPHYS 自有基线混算**。

实测（tierflow_pro，单次运行）：

| 任务 | 结果 | 说明 |
|---|---|---|
| crs-l1-paris-lambert93 | **PASS 11/11** | 重投影 Lambert93 + GPKG 导出全对 |
| geo-l1-cairo-multipoint-hull | **PASS 10/10** | 分站凸包，阿文属性逐字保全 |
| dc-l1-capetown-waterway-nulls | FAIL（加权 0.90，10/12） | 几何/过滤全对；缺参考实现的顶层 `dropped_count` 元数据约定，我们的导出不写自定义顶层字段 |
| fio-l1-paris-kml-pois | FAIL（gate） | 产出文件但缺 `category`/`verified_date` 列——KML 属性保真不足 |
| geo-l2-bangkok-landuse-intersect | FAIL（gate） | 未产出导出文件（分析完成但没有执行"保存为文件"这一步） |
| geo-l1-capetown-building-centroids | ERROR | 输入是裸 .shp（非 zip），浏览器导入不支持——兼容性缺口，记 ERROR 不记分 |

解读：几何/CRS 类任务满分，失分集中在**schema 保真、元数据约定、导出纪律**——与自有基线的结论互补（那边败在检索/参数，这边败在交付格式细节）。这两个方向就是下一步产品化的靶子。

**Batch 33 产品跟进（2026-10-25，未重评分）**：KML 导入现在补读并持久化 `ExtendedData` / `SchemaData` 属性；属性过滤产生的 `dropped_count` 会随 GeoJSON 导出写到顶层，GPKG/FGB/CSV 明确返回 NOT_SUPPORTED；显式文件名交付有真实导出守卫；GeoAgentBench 驱动器已改为把 `.shp/.shx/.dbf` 作为一次多文件选择导入。确定性浏览器回归覆盖上述路径。由于本机缺少 GeoAgentBench 浅克隆且网络不可用，本轮 **agent re-score deferred**，上表计数仍为 2026-10-24 单次运行结果，不把产品测试冒充新基准分数。细节见 `docs/GEOAGENT_SCHEMA_EXPORT.md`。

### 2026-10-25 重评分（tierflow_pro，单次运行）

本轮在 Windows `F:\tiphys` 用已存在的 `reference/gis/GeoAgentBench` 重跑同一 6 任务子集，结果 **5/6 全过、加权平均 0.833**；报告 `docs/baselines/stage4/geoagentbench.{json,md}` 已按本轮结果重写，旧表保留为历史。

| 任务 | 本轮结果 | 变化 |
|---|---|---|
| crs-l1-paris-lambert93 | **PASS 11/11** | 稳定 |
| geo-l1-cairo-multipoint-hull | **PASS 10/10** | 稳定 |
| geo-l1-capetown-building-centroids | **PASS 9/9** | ERROR → PASS；驱动器补齐 Shapefile sidecar；新增原生真质心工具（面积加权 + 大坐标局部原点稳定化） |
| fio-l1-paris-kml-pois | **PASS 10/10** | FAIL → PASS；KML 描述键值展开为字段；GeoJSON 导出按 RFC 7946 转 4326 并去 Z |
| dc-l1-capetown-waterway-nulls | **PASS 12/12** | 新增原生 `drop_empty_geometries`；模型先过滤空 `waterway_type`，再过滤 5 个 null + 5 个 empty 几何，dropped_count=20 |
| geo-l2-bangkok-landuse-intersect | FAIL（无产物） | 21,660 个面 / 645,563 个顶点；`clip`/`intersection` 触发 WASM `unreachable`。已加浏览器矢量预算守卫（20,000 要素 / 500,000 顶点），超限时诚实拒绝并给桌面/分块降级，不再毒化 WASM 实例 |

另修了评测器自身的三个问题：Shapefile 任务只喂 `.shp` 未带同名 sidecar；Windows grader 默认 GBK 读 JSON 触发 `UnicodeDecodeError`；失败任务缺少工具链/错误诊断。Capetown、KML、waterway 的单任务定跑分别为 9/9、10/10、12/12；完整 6 任务以上表为准。剩余靶子：Bangkok 的分块/桌面降级。

### 2026-10-25 全量 30 任务复跑（tierflow_pro，单次）

同一批 30 项固定任务在真实页面重跑：**30/30 PASS、0 FAIL、0 ERROR**，报告 `docs/baselines/stage4/agent-baseline.{json,md}`。总耗时 1,426 s（P50 30 s / P95 146 s / 最长 226 s），输入 428,028 tokens / 输出 14,352 tokens，预期工具命中 27/30，计划运行 11 次且 `auditRuns` 0 违规。唯一非门警告是 H08 的 48.7 s 超过 30 s 时长预算（warn，不影响 PASS）。

这次复跑与“inspect_layers 显示范围/分析 CRS 语义”修改有时间重叠，**不是冻结构建的正式基准**；且仍是单次运行，路线图要求的每项 ≥3 次方差、真机与跨模型对照仍未做。因此结论只能写“在当前单次运行中 30/30”，不能写成稳定上限。M11 的轨迹已不再误判 DEM 的经纬度显示范围，明确按 EPSG:32650 米制网格推进。
