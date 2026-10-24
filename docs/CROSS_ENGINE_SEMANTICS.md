# 双引擎语义对照：`gis.buffer` / `gis.reproject`

> 生成：2026-10-24T11:59:01.574Z ｜ 统一测量坐标系 EPSG:32650 ｜ 容差：面积 0.5%、半径 2 m
>
> 这是**实测**：两个执行端各自运行同一批冻结 fixtures（`tests/fixtures/bj_points.geojson`、`district_zones.geojson`），
> 各自读回自己的输出再比较，不使用任一端自报的“成功”。复现：`npm run compare:engines`。

## 结果

| 案例 | 判定 | 浏览器 CRS | Python CRS | 要素数（浏览器/Python） | 面积差 | 半径误差（浏览器/Python） |
|---|---|---|---|---|---|---|
| buffer_points_500m | PASS | EPSG:32650 | EPSG:32650 | 3.00/3.00 | 0.000% | 1.07 m / 0.60 m |
| buffer_points_500m_dissolve | DIVERGENT | EPSG:32650 | EPSG:32650 | 3.00/1.00 | 0.000% | — m / — m |
| buffer_zones_2km | PASS | EPSG:32650 | EPSG:32650 | 3.00/3.00 | 0.000% | — m / — m |
| buffer_points_negative | DIVERGENT | — | EPSG:32650 | —/3.00 | — | — m / — m |
| reproject_points_3857 | PASS | EPSG:3857 | EPSG:3857 | 3.00/3.00 | — | — m / — m |
| reproject_zones_32650 | PASS | EPSG:32650 | EPSG:32650 | 3.00/3.00 | 0.000% | — m / — m |

合计：4 PASS / 2 DIVERGENT / 0 BOTH_FAILED / 0 NOT_TESTED。

## 逐例说明

### buffer_points_500m — PASS

- 浏览器输出：crs=EPSG:32650，要素 3，空几何 0，面积 2352411.37 m²
- Python 输出：crs=EPSG:32650，要素 3，空几何 0，面积 2352411.37 m²

### buffer_points_500m_dissolve — DIVERGENT

- 浏览器输出：crs=EPSG:32650，要素 3，空几何 0，面积 2352411.37 m²
- Python 输出：crs=EPSG:32650，要素 1，空几何 0，面积 2352411.37 m²

### buffer_zones_2km — PASS

- 浏览器输出：crs=EPSG:32650，要素 3，空几何 0，面积 583744422.20 m²
- Python 输出：crs=EPSG:32650，要素 3，空几何 0，面积 583743847.82 m²

### buffer_points_negative — DIVERGENT

- 浏览器：失败 / 拒绝：failed: Error: 距离必须为正数（v1 不支持负距离内缩；引擎行为尚不一致）。
- Python 输出：crs=EPSG:32650，要素 3，空几何 3，面积 0.00 m²

### reproject_points_3857 — PASS

- 浏览器输出：crs=EPSG:3857，要素 3，空几何 0，面积 0.00 m²
- Python 输出：crs=EPSG:3857，要素 3，空几何 0，面积 0.00 m²

### reproject_zones_32650 — PASS

- 浏览器输出：crs=EPSG:32650，要素 3，空几何 0，面积 305521748.78 m²
- Python 输出：crs=EPSG:32650，要素 3，空几何 0，面积 305521748.73 m²

## 已知分歧（不在本阶段强行抹平）

- **`dissolve:true` 的语义不同**：Python 用 `unary_union` 把全部缓冲合并成 1 个要素；WASM `buffer_vector` 的 dissolve 只合并**相互重叠**的缓冲，
  所以 3 个互不相交的点仍是 3 个要素。面积完全一致（0.000%），差别只在要素分组。阶段 2 必须把“合并为单一要素”实现为独立语义，
  而不是把两种行为都叫 dissolve。
- **负距离缓冲**：契约 v1 明确只接受正数（命令层对两端同时生效）；Python 引擎原生入口仍接受 `-100` 并静默发布 3 个空几何、NaN 范围，
  浏览器原生入口拒绝。引擎级差异待阶段 2 修复：要么产出有效内缩结果，要么以 `INPUT_ERROR` 明确拒绝。
- **同一 CRS 重投影**：契约 v1 规定为显式 no-op；浏览器已按此实现，Python 引擎入口仍抛 `layer is already in …`。
  Agent 侧在调用前用共享契约拦截，因此桌面链路行为一致；引擎原生入口的差异记录在此。

## 如何解读

- `PASS` 表示两端在 CRS、要素数、面积（≤0.5%）与独立半径误差（≤2 m）上一致。
- `DIVERGENT` 是**发现**，不是“差不多”：必须写明哪一侧不符合契约，并进入对应阶段的修复清单。
- 本文件不评价模型能力；模型在环评测见阶段 4。
