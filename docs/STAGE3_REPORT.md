# 阶段 3 报告：自适应调度与审计闭环

> 对应 [MASTER_ROADMAP.md](MASTER_ROADMAP.md) §4 阶段 3。结论先行：**验收门槛已满足**——11 个真实 3–4 步任务（12 次运行）可执行、可安全中止、可从断点恢复；运行日志含输入/输出 sha256 与逐步验收明细，可独立复算（子进程内重算 + `auditRuns` 不变量双重校验）；故意制造的错误（不支持的操作、坏参数、幽灵引用、执行故障、错误验收预期）全部产生**诚实失败**，没有任何一条路径能产出"成功完成"的假结论。

## 1. 交付物

| 交付 | 位置 |
|---|---|
| 计划类型 + 计划期校验 + 错误分类 + 确定性执行器 + 诚实报告 + 审计不变量 | `shared/plans.ts`（纯函数 + 适配器接口，无引擎依赖） |
| 浏览器 WASM 适配器（图层摘要、步骤执行、IndexedDB 检查点） | `src/lib/browser/plans.ts` |
| 引擎入口 `run_plan` / `plan_list` / `plan_get`（38 个 shell 工具） | `src/lib/browser/engine.ts` + `catalog.json` |
| 只读审计路由 `GET /plans`、`GET /plans/<id>` | `src/lib/browser/engine.ts` |
| Python 作业错误分类 `error_class`（与共享分类同表） | `engine/jobs.py` |
| 单元测试：校验/分类/取消/超时/级联跳过/验收门/恢复/假完成检测 | `tests/plans.test.ts`（14 项） |
| 引擎级回归：run_plan 全链路（防嵌套 job 死锁） | `tests/browser-engine.test.ts`（新增 1 项，69/70） |
| 11 任务基线 + 独立子进程执行器 | `tests/plans/plan-tasks.json`、`scripts/run-plan-baseline.ts`、`docs/baselines/stage3/` |

复现命令：

```powershell
npm run test:plans        # 执行器控制流单元测试
npm run baseline:plans    # 11 任务 × 真实 WASM 引擎（每任务独立子进程）
```

## 2. 分工：模型规划，程序执行（路线图 3.1 的落地）

- **模型/UI 只写 `Plan`**：goal + 3–6 个步骤（契约操作 `gis.*` 或浏览器工具），步骤间用 `@stepId` 引用上游输出，每步可声明验收断言（feature_count / crs / geometry_types / buffer_radius / raster_dims / field_value / layer_field / noop）。模型不再管理 job、重试或检查点。
- **执行器（`executePlan`）是确定性控制流**：
  1. **先整体校验再执行**（阶段 2 输入 #1）：不支持的操作（如浏览器 dissolve）在计划期被拒绝并附降级方案；坏参数、幽灵引用、依赖乱序、未确认的删除/导出步骤同样拒绝，**一次引擎调用都不发生**（P07/P08/P09 断言 `executedSteps=0`）。
  2. 逐步执行：解析引用 → 记录输入图层摘要（id/CRS/sha256）→ 调引擎 → 记录输出图层与结果摘要 → 评估验收门。**验收门失败 = VALIDATION_ERROR**，即使引擎本身成功（P11：缓冲成功但断言 999 要素，运行失败且不把结果列为可交付）。
  3. 每步后写检查点（IndexedDB `plan-run:<runId>`），`resume` 复用成功前缀不重跑（P10：hillshade 复用、坡度/等高线重跑后完成）。
  4. 取消/超时：外层信号 → 引擎 job 取消 → 步骤记 `USER_CANCELLED`；每步墙钟预算超限记 `RESOURCE_LIMIT`（单元测试用忽略信号的适配器验证）。
  5. 级联跳过：上游失败后下游步骤记 `skipped` 并说明原因，不静默、不重试不可重试的错误。

## 3. 统一错误分类（两端同表）

`INPUT_ERROR / UNSUPPORTED / RESOURCE_LIMIT / EXECUTION_ERROR / VALIDATION_ERROR / USER_CANCELLED`：

- 浏览器：`classifyError()`（shared/plans.ts）按消息特征 + abort/timeout 提示归类；计划期拒绝直接携带分类与降级建议。
- Python：`engine/jobs.py` 的 `classify_error()` 镜像同一张表，`job_status` 返回 `error_class`（5 项测试）。与 TS 实现的同步义务写在两侧注释里。
- **审批语义保留**：`remove_layer`/`export_features` 进入计划必须在 `plan.confirmations` 里带步骤 id（计划期强制）；Agent 直接调用时维持既有审批弹窗不变（P05 走确认导出路径）。

## 4. 审计与独立复算（验收核心）

每次运行记录：`runId / goal / planVersion / provider / 逐步参数（引用已解析）/ 输入图层 sha256 / 输出图层摘要+sha256 / 结果摘要 / 验收明细（每条带可读 detail）/ 错误分类 / durationMs / resumedFrom`。

两重复算：

1. **子进程内重算**（`baseline:plans` 的 `recompute`）：运行结束后从存储重新读出每个输出图层、重算 sha256，与执行器记录比对——防止执行器"说产出了但没产出"或"产出被偷换"。
2. **`auditRuns` 不变量**：状态与步骤相位一致（completed ⇒ 全部 pass/noop 且无验收失败）；blockedAt 与第一个失败步骤一致；可交付成果只能来自成功步骤；错误分类必须在冻结表内；resume 的复用步骤摘要与原运行一致；注入故障的运行不允许 completed。篡改实验（单元测试）：只翻状态字段或只抹验收失败，都会被判为"假完成"。

结果：`docs/baselines/stage3/plan-baseline.json` —— 11/11 任务通过，12 次运行（7 completed / 5 failed，其中 3 次为计划期诚实拒绝），auditRuns 0 违规。

## 5. 基线任务表（3–4 步真实任务）

| 任务 | 内容 | 预期 |
|---|---|---|
| P01 | 点缓冲 500 m + 字段统计 + 视图 | completed |
| P02 | 投影 32650 → 缓冲 1 km → 投影回 4326 + 独立半径复核（≤10 m） | completed |
| P03 | describe → 面裁剪 → 字段统计 | completed |
| P04 | 属性选择 pop≥8000 → 均值统计 | completed |
| P05 | 凸包 → 面积量算 → **确认导出** | completed |
| P06 | 投影 3857 → 4326 → 同 CRS **显式 no-op** | completed |
| P07 | 缓冲 → dissolve（浏览器不支持）→ 视图 | 计划期拒绝 UNSUPPORTED，0 步执行 |
| P08 | 缓冲 -5 m → 统计 → 视图 | 计划期拒绝 INPUT_ERROR |
| P09 | 缓冲 → clip 掩膜 @ghost → 统计 | 计划期拒绝 INPUT_ERROR |
| P10 | 山体阴影 → 坡度 → 等高线；**注入执行故障 → 断点恢复** | failed(EXECUTION_ERROR, 有中间成果) → resume completed（1 步复用） |
| P11 | 缓冲 500 m + 错误验收（999 要素） | VALIDATION_ERROR，不假成功 |

## 6. 过程中发现并修复的真实缺陷

1. **嵌套 job 死锁**：`run_plan` 作为引擎 job 持有 `tiphys-gis-cpu` 锁，若步骤再各自创建 job，会互相等待同一把锁（Node 22+ 的 `navigator.locks` 下必现）。修复：新增 `runEngineStep`——计划步骤在计划 job 内**内联执行**（快工具集合直接走 `runBrowserTool`，长工具直接 `execute`），取消经信号贯通。已加回归测试（`tests/browser-engine.test.ts` 最后一项）。
2. **栅格 describe 误判**：`describe_layer` 在 `execute()` 里会先撞"仅矢量"门卫；`runEngineStep` 现按快工具集合显式路由（这正是阶段 0 教训的复现：分发位置不一致 = 假"工具不存在"）。

## 7. 回归结果（本机实测）

| 套件 | 结果 |
|---|---|
| `npm run test:plans` | **14/14** |
| `npm run baseline:plans` | **11/11 任务**，12 次运行，auditRuns 0 违规 |
| `npm run test:browser` | **69/70**；唯一失败仍是 `map-render` 需要本机 Chrome（环境缺项，与前两阶段一致） |
| `npm run test:agent` | 23/23 |
| `npm run test:engine` | 38 项全部通过（含新增 5 项错误分类） |
| `npm run test:contracts` / `test:methods` / `test:search` | 11/11 · 4/4 · 5/5 |
| `npm run audit:catalog` | 重新生成：shell 38（+run_plan/plan_list/plan_get）、合并目录 1001、43/43 接线 |
| `npx tsc --noEmit` | 通过 |

## 8. NOT_TESTED（明确未测）

- **真实模型在环**：没有任何"模型成功率"数字——模型如何产出好的 `Plan`（提示词、方法卡注入、示例）属于阶段 4 的 A/B 评测；本轮只交付了执行层并诚实标注。
- **桌面 Python 端计划执行器**：错误分类已统一到 Python job，但 `run_plan` 适配器只有浏览器实现；桌面跑计划需在阶段 4/5 按同一 `PlanAdapter` 接口补（接口已预留）。
- **客户端可视化回放**：`GET /plans` 与 `plan_get` 已可查全部审计记录，但尚未做专门的 UI 面板（任务列表里的"查看与回放"界面）。
- 计划级取消在真实引擎上的表现由单元测试（信号）+ 单工具 job 取消（阶段 0 H06）分别覆盖，未在基线里造慢任务做端到端取消（避免竞态假阳性）。
- 移动端、多用户并发计划、计划超过 6 步的行为未测。

## 9. 阶段 4 的输入

1. A/B 评测的"新路径"就是 `run_plan`：旧路径 = 模型逐工具调用；新路径 = 模型出 Plan、执行器跑。同一批任务、同一模型与预算对比任务成功率/正确率/token。
2. 方法卡（阶段 2）应注入规划提示词：卡片教方法、`OPERATION_SUPPORT` 定可行性、`run_plan` 执行——三层分离。
3. 桌面 `wasm_run` 的多输入支持与打包路径（阶段 1 遗留）仍是桌面计划执行器的前置条件。
4. `plan_get` 的审计记录已含复算所需的全部要素，可直接作为阶段 4 的结果验收数据源。
