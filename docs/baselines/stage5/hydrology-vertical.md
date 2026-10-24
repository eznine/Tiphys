# 阶段 5A · 水文纵向（DEM → 河网）

> 生成：2026-10-24T15:09:32.528Z · 计划来自任务卡 hydro-network（与产品 UI 同一代码路径）· 每格独立子进程

| DEM | 阈值 | 结果 | 河网面数(连通域) | 河网总面积(deg²) | 范围内 | 耗时 |
|---|---|---|---|---|---|---|
| dem_hills | 20 | completed | 1 | 1.14e-3 | true | 210 ms |
| dem_hills | 50 | completed | 58 | 9.82e-5 | true | 223 ms |
| dem_hills | 100 | completed | 59 | 5.98e-6 | true | 216 ms |
| dem_hills | 200 | completed | 1 | 1.90e-7 | true | 210 ms |
| dem_large | 20 | completed | 1 | 2.85e-2 | true | 489 ms |
| dem_large | 50 | completed | 2035 | 1.41e-3 | true | 780 ms |
| dem_large | 100 | completed | 2420 | 2.32e-4 | true | 560 ms |
| dem_large | 200 | completed | 2 | 1.90e-7 | true | 439 ms |

结构验收：8/8 通过（completed + 验收全过 + 范围内）
敏感性不变量（阈值↑⇒河网总面积不增，0.1% 容差）：通过
auditRuns：通过
交付模板：docs/baselines/stage5/hydro-*-t50.geojson（导出 sha256 见 json）
