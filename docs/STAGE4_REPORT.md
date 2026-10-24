# 阶段 4 报告：系统对照评测 + 手机分析体验

> 对应 [MASTER_ROADMAP.md](MASTER_ROADMAP.md) §4 阶段 4。结论先行：**首批两个模型在环基线落地**——浏览器 Agent 在 30 项固定任务上 **28/30 PASS**（真实页面、真实模型 tierflow_pro、单轮运行），手机端（390×844 仿真）**7/7 场景通过**，其中 5 项非查看 GIS 任务从任务卡到验收/导出完整闭环，超预算栅格在执行前被拒绝、运行中短暂后台可恢复。两个失败任务（M09/M11）是真实样本：**失败主因不是选错工具，而是 8 步静态上限被检索消耗殆尽**——这直接验证了路线图"改预算制"的判断。阶段 4 的 A/B（旧 vs 新检索、单 Agent vs 规划）与外部基准（GeoAgentBench）**未在本轮完成**，见 §6。

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

- **A/B 对照（阶段 4 任务 1 的核心）**：旧检索 vs 新检索、直接工具 vs `run_plan` 规划路径的对照尚未跑——本轮只建立了"新路径"的基线数字；A/B 需要双臂 × 30 任务 ≈ 双倍额度与时间，建议作为下一轮第一件事（驱动器已支持 `--arm` 参数位）。
- **单样本方差**：每任务 1 次运行；M09 两次运行一成一败说明方差不可忽略，正式对照需 ≥3 次。
- **GeoAgentBench / GeoAnalystBench 适配**（阶段 4 任务 2）：未开始。
- **真机**：全部为桌面 Chrome 仿真（含移动仿真）；未在实体手机上验证触控/性能/后台生命周期。
- 模型为内置 tierflow_pro 单模型；无跨模型对比。
- `run_plan` 在本轮 agent 基线中被模型主动使用 0 次（plan_tool_usage runs=0）——模型默认逐工具调用，A/B 需要在提示词/工具面中显式引导。

## 6. 阶段 5 的输入

1. 预算制替代 8 步上限：数据在本报告 §2（检索消耗是主因）。
2. 检索候选的参数卡呈现（`d8_pntr` 类参数名）需要产品化。
3. A/B 驱动器已就绪（`--arm`、`--only`、`--merge`），跑双臂即可出对照报告。
4. 任务卡预设可扩展为阶段 5 的"配方"入口（水文档线 B 即一条 6 步任务卡）。
