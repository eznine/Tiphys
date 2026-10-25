# 阶段 2 报告：工具检索、方法与五个基础操作

> 对应 [MASTER_ROADMAP.md](MASTER_ROADMAP.md) 阶段 2。结论先行：**验收门槛已满足**——207 条标注检索、五操作覆盖/缺口矩阵、方法卡、CRS/单位前置校验。后续补齐了桌面 Python 的 `gis.zonal_statistics`（矢量分区 + 栅格取值）；浏览器 `gis.dissolve` 与浏览器 `gis.zonal_statistics` 仍明确不可用，缺口与降级路径写在契约里，不用"支持"掩盖。

## 1. 交付物

| 交付 | 位置 |
|---|---|
| 检索实现（中文分词、强证据、意图词表、候选压缩、过滤器） | `src/lib/browser/search.ts`、`candidates.ts`、`intents.ts` |
| 标注集（207 条） | `tests/search/labeled-queries.json` |
| 检索评测脚本与基线 | `scripts/search-eval.ts`、`docs/baselines/stage2/search-eval.json` |
| 检索回归测试 | `tests/search-quality.test.ts`（5 项） |
| 检索质量报告 | [SEARCH_QUALITY.md](SEARCH_QUALITY.md) |
| 五操作契约（buffer / reproject / clip / dissolve / zonal_statistics） | `shared/contracts/{types,operations,index}.ts` |
| 契约测试 | `tests/contracts.test.ts`（11 项） |
| 方法卡（阶段 2 交付 8 张；现 11 张）与测试 | `src/lib/methods.ts`、`tests/methods.test.ts`、[METHODS.md](METHODS.md) |
| D1/D2 复现基线 | `docs/baselines/stage2/dissolve-baseline.json` |

## 2. 检索：实测数字

同一批 207 条标注（116 自然句 / 69 别名 / 22 应诚实为空），同一份 998 条目录（当时快照；2026-10-25 目录已增至 999，新增原生 centroid/空几何过滤，未重算）：

| 组 | Top-1 | Top-5 | MRR |
|---|---|---|---|
| 自然中文（116） | **87.1%** | **100%** | 0.932 |
| 别名/简称（69） | **100%** | **100%** | 1.000 |
| gap（22） | 20/22 无高分候选；2 条仍误召回（**9.1%**） | | |

改动前自然句 Top-1 只有 12.3%：根因是中文整句被当成一个 token 且要求全命中，不是排序问题。现在失败面剩下的两条是"人脸识别 → identify_narrow_polygons(45)"与"点云分类 → classification_accuracy_assessment(76)"，都记录在 [SEARCH_QUALITY.md](SEARCH_QUALITY.md) §5。

**测试阈值是回归下限**（natural Top-1 ≥0.78、Top-5 ≥0.95、alias Top-1 ≥0.95、gap 置信率 ≤0.4），不是宣称目标；标注集由实现者编写，存在自我偏差，别名与自然句分开报告。

## 3. 五操作：能力覆盖与缺口

`OPERATION_SUPPORT`（`shared/contracts/operations.ts`）是唯一判据。`verified` 表示仓库里有可复现测试；`supported: true, verified: false` 表示工具在、但 v1 没有证据，不允许当"已支持"讲。

| 操作 | 浏览器 WASM | 桌面 Python |
|---|---|---|
| `gis.buffer` | ✅ 已验证（跨引擎 4 例，半径误差 ≤1.07 m） | ✅ 已验证 |
| `gis.reproject` | ✅ 已验证（同 CRS 显式 no-op） | ✅ 已验证（引擎会报错，Agent 前置 no-op） |
| `gis.clip` | ✅ 已验证，**仅面/点**；线、多点显式拒绝 | ⚠️ 工具存在，未纳入基线 |
| `gis.dissolve` | ❌ **不支持**（D1/D2，见下节） | ⚠️ 工具存在，未纳入基线 |
| `gis.zonal_statistics` | ❌ **不支持**（manifest 把分区面声明成栅格） | ✅ **已验证**（rasterio 矢量面掩膜；4×4 GeoTIFF + 2 分区数值测试） |

契约行为：

- `planOperation(spec, layer, provider)` 在 provider 不支持时返回 `reject`，并附**原因 + 降级方案**，绝不静默降级或换个工具名跑。
- `gis.dissolve` 语义 v1：无 `field` → 全部求并成 1 个要素；有 `field` → 每组 1 个要素，只保留分组字段。
- `gis.clip` 语义 v1：面掩膜求交并保留属性；浏览器端线/多点/MultiLineString 直接拒绝。
- `gis.zonal_statistics` 的 `input` 是**数值栅格**，`zonesLayerId` 是**矢量分区**；桌面 Python 用 rasterio 按面掩膜逐区计算 mean/median/min/max/sum/stddev/count，结果保留分区几何与属性并新增 `zonal_<statistic>`、`zone_pixel_count`。`stddev` 明确为总体标准差；`ignoreNoData=false` 时 NoData/非有限值按 0 计入。浏览器仍按 provider 拒绝：同名 WASM 工具的分区输入是栅格，按名调用会算错数据，不做静默映射。

## 4. D1/D2：浏览器 `dissolve` 的调查记录（未修复，已定性）

现象（阶段 0 基线）：M01/M02 六次运行全部 ERROR；`vector_info` 在读取 dissolve 输出时 `RuntimeError: unreachable`。

本轮按证据链逐项排除：

| 尝试 | 结果 |
|---|---|
| 把上游默认 `snap_tolerance=2.22e-16` 覆盖为 `0` | 错误从 panic 变为 `invalid source EPSG 436207616`——**FGB 写入的投影字段本身就是脏的** |
| 让 dissolve 输出 GPKG | CRS 正确，但把 GPKG 字节交给 `calculate_geometry`（`add_geometry_attributes`）会 panic；多步链断 |
| 让 dissolve 输出 GeoJSON | 对 4326 三区可得到 1 个要素；但对**投影输入（32650 缓冲结果）返回 0 要素**，且 CRS 回退 4326——比报错更危险（静默错结果） |
| 只跳过 `vector_info`、用已知 CRS 回填 | 显示层可读，但下游工具仍拿到脏 CRS 的 FGB |

结论：这不是参数问题，是 WASM 1.7.1 FGB 写入器在 dissolve 路径上的缺陷（D1），加上读取器的 panic（D2）。**没有采用任何"看起来能跑"的绕行**：GeoJSON 方案的静默空结果不可接受，GPKG 方案破坏多步链。改动已全部回退，基线保留在 `docs/baselines/stage2/dissolve-baseline.json`（6/6 ERROR），契约中标为不支持并给出"改桌面引擎 / 先 union 再删列"的降级路径。后续若要修，应替换上游 writer 或在 WASM 外重写 FGB CRS 头，并补一条"投影输入 dissolve 后下游可读"的回归。

2026-10-25 复盘补充：不仅空结果，**看似非空的结果也会丢几何**。对 5 个投影缓冲面执行无字段 dissolve，WASM 返回 1 个要素，但 bbox 从输入 `447004…451016` 收缩为 `447694…449294`；分区样例也只保留 3 个区中的 1–2 个。GPKG 容器同样出现 0 要素，说明问题在 union/dissolve 计算与写出链，不是单个扩展名。因此浏览器 `dissolve` 与裸 `wasm_dissolve` 现在都在结果 adopt 前显式拒绝，`tests/browser-engine.test.ts` 用上述缓冲形态断言失败且不新增图层；不再有任何返回"看起来正确"的 GeoJSON 路径。真正修复仍需替换上游 writer/union 实现并用投影输入 + 下游 `calculate_geometry` 做回归。

## 5. 方法卡

11 张：缓冲与距离、重投影、裁剪与叠加、融合与分组、分区统计、面积/长度量算、真质心/局部米制投影、空间连接、DEM 水文、坡度坡向、叠加汇总与重复计数（索引见 [METHODS.md](METHODS.md)）。2026-10-25 增补类型化 `crs` / `units` / `overlay-double-count` / `nodata` / `predicate` 护栏，并随命中的方法卡注入浏览器 Agent 提示词；这不是外部 Skill 全量导入，也没有建立向量知识库。

- 每张卡含触发词、前置条件、类型化护栏、追问条件、禁止误用、验收规则、正反例七段，缺段测试失败。
- **检索与工具目录分开**：`findMethods()` 只做触发词匹配，不参与工具排序；工具检索不读方法卡。
- 卡片正例引用的工具 ID 必须真实存在于 shell/WASM 目录；契约卡必须符合 `OPERATION_SUPPORT`（例如 dissolve 卡必须写明浏览器端不可用）。
- `zonal-stats` 卡现关联 `gis.zonal_statistics`：桌面 Python 支持、浏览器仍拒绝；验收要求无交集分区返回空值，不能把 NoData 伪装成 0。

## 6. 回归结果（本机实测）

| 套件 | 结果 |
|---|---|
| `npm run test:browser` | **68/69**；唯一失败是 `map-render` 需要 Chrome/Chromium，本机没有（环境缺口，非代码回归） |
| `npm run test:agent` | 23/23 |
| `npm run test:engine` | 全部通过（exit 0） |
| `npm run test:contracts` | 11/11 |
| `npm run test:methods` | 4/4 |
| `npm run test:search` | 5/5 |
| `npm run eval:search` | 207 条，数字见 §2 |

## 7. NOT_TESTED（明确未测）

- **真实模型端到端**：本阶段没有消耗模型额度，任何"成功率"都不是模型跑出来的；阶段 4 才做 A/B。
- 浏览器 `dissolve` 未修复，M01/M02 仍 ERROR（见 §4）。
- `gis.zonal_statistics` 只有合成 GeoTIFF 的单元数值断言；尚未与 ArcGIS/QGIS 或真实遥感产品做逐像元对照，不声称结果位级一致。
- 桌面 `clip` / `dissolve`（Python 工具存在）未纳入可复现基线。
- 方法卡在真实 Agent 提示词中的召回效果未测；目前只测了卡片数据与 `findMethods`。
- 浏览器线裁剪、Chrome 地图渲染（`map-render.test.ts`）在本机不可测。

## 8. 阶段 3 的输入

1. 调度器执行前先查 `OPERATION_SUPPORT`，不支持的操作在**计划阶段**就返回带降级建议的拒绝，而不是执行到一半失败。
2. 每次运行用 `ExecutionRun` 记录：`operation/version/provider/input hash/params/outputs/validation`；D1/D2 这类缺陷必须在记录里体现为 `EXECUTION_ERROR`，不能变成"完成"。
3. 审计要能复算：`docs/baselines/stage2/*.json` 已给出检索与 dissolve 两组可复现输入，可直接作为阶段 3 的回归夹具。
4. 方法卡与支持矩阵应注入 Agent 提示词，但保持"卡片教方法、矩阵定可行性、目录给工具"三层分离。
