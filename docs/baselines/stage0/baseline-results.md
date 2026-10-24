# TIPHYS 基线运行结果（引擎参考执行）

> 生成：2026-10-24T11:40:22.582Z · 模式 engine-reference · 重复 3 次 · Node v24.14.0
> 任务集 sha256 `c90a6483736349c1…` · 每个任务独立进程（WASM panic 不会污染下一项）

| 任务 | 组 | 结果 | 检查 | 耗时 |
|---|---|---|---|---|
| S01 图层体检：看一眼这个点图层有什么 | simple | PASS | 3/3 | 38 ms |
| S02 500 米缓冲（面） | simple | PASS | 3/3 | 196 ms |
| S03 重投影到 Web 墨卡托 | simple | PASS | 3/3 | 103 ms |
| S04 属性选择：人口大于 8000 的区 | simple | PASS | 2/2 | 57 ms |
| S05 字段统计：人口均值 | simple | PASS | 3/3 | 38 ms |
| S06 面积与周长量算 | simple | PASS | 3/3 | 131 ms |
| S07 重命名图层（中文名） | simple | PASS | 1/1 | 37 ms |
| S08 导出 GeoJSON 交付物 | simple | PASS | 2/2 | 56 ms |
| S09 凸包 | simple | PASS | 2/2 | 82 ms |
| S10 属性表分页与排序 | simple | PASS | 3/3 | 37 ms |
| M01 缓冲 → 融合 | multistep | ERROR | 0/3 | 186 ms |
| M02 融合 + 面积量算 | multistep | ERROR | 0/2 | 59 ms |
| M03 空间连接：点取区属性 | multistep | PASS | 3/3 | 121 ms |
| M04 先重投影再做米制缓冲 | multistep | PASS | 3/3 | 226 ms |
| M05 按位置选择 → 导出 CSV | multistep | PASS | 2/2 | 137 ms |
| M06 求交 + 面积比例 | multistep | PASS | 2/2 | 143 ms |
| M07 线 → 栅格 | multistep | PASS | 2/2 | 169 ms |
| M08 DEM 坡度 + 栅格网格一致性 | multistep | PASS | 2/2 | 184 ms |
| M09 水文链：填洼 → 流向 → 汇流 → 河网 → 矢量化 | multistep | PASS | 3/3 | 329 ms |
| M10 山体阴影 + 等高线 | multistep | PASS | 3/3 | 1061 ms |
| M11 流域面提取 | multistep | PASS | 3/3 | 266 ms |
| M12 裁剪 → 融合 → 导出 GeoPackage → 重新打开 | multistep | PASS | 4/4 | 168 ms |
| H01 歧义：没说缓冲距离 | hard | PASS | 1/1 | 32 ms |
| H02 经纬度上的 500 米（单位陷阱） | hard | PASS | 1/1 | 195 ms |
| H03 自相交多边形缓冲 | hard | PASS | 1/1 | 207 ms |
| H04 不支持的能力必须明说：线裁剪 | hard | PASS | 1/1 | 75 ms |
| H05 导出同名文件不得静默覆盖 | hard | PASS | 2/2 | 104 ms |
| H06 取消运行中的任务 | hard | PASS | 2/2 | 118 ms |
| H07 空结果要明确为空 | hard | PASS | 2/2 | 60 ms |
| H08 大栅格资源基线 | hard | PASS | 2/2 | 317 ms |

合计：84 PASS / 0 WARN / 0 FAIL / 6 ERROR（90 次运行）

## M01 缓冲 → 融合 —— 3/3 次运行 ERROR

- 致命错误：`SyntaxError: Bad control character in string literal in JSON at position 120 (line 1 column 121)`
- ✗ feature_count (merged)：skipped: step failed
- ✗ geometry_types (merged)：skipped: step failed
- ✗ field_value (buf)：skipped: step failed
- 其余 2 次失败一致（见 baseline-results.json 的 steps/fatal）

## M02 融合 + 面积量算 —— 3/3 次运行 ERROR

- 致命错误：`RuntimeError: unreachable`
- ✗ feature_count (merged)：skipped: step failed
- ✗ between (geo)：skipped: step failed —— 三区并集，重叠区只算一次
- 其余 2 次失败一致（见 baseline-results.json 的 steps/fatal）
