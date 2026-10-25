# TIPHYS

**From Intent to Outcome** — Agent 优先的 GIS / 遥感工作台（Web + Windows 桌面 + Android 壳）。

React/TypeScript + MapLibre 前端；Node Agent 使用 AI SDK 调用模型；浏览器内 GeoLibre WASM 与桌面 Python GeoPandas/Shapely/PROJ 引擎提供空间算子。产品边界见 [MVP_SPEC](docs/MVP_SPEC.md)，当前验证状态见 [RELIABILITY_STATUS](docs/RELIABILITY_STATUS.md)。

> **开发总纲**：后续一切开发按 [MASTER_ROADMAP](docs/MASTER_ROADMAP.md) 推进——阶段与 Ticket 顺序、架构契约、验收门槛和「明确不做」清单均以它为最高依据。

## 当前状态（2026-10-25）

- **自有模型在环基线：30/30 PASS**（单次运行，P50 30 s / P95 146 s；每项 ≥3 次方差、真机、跨模型尚未做，不能当作稳定上限）。
- **GeoAgentBench 兼容子集：5/6、加权 0.833**；仅 Bangkok 21,660 面 / 64.5 万顶点的大矢量 overlay 受浏览器 WASM 资源边界限制，已加矢量预算守卫诚实拒绝并给桌面/分块降级。
- **工具目录：** 958 个 GeoLibre WASM schema + 34 个 Python MCP 工具 + 5 个扩展工具 + 原生 `centroid` / `drop_empty_geometries`；合并 999 个，工具箱隐藏 4 个引擎控制项后可见 995 个。
- **已上线：** https://tiphys.xyz（`assets/index-Bcx4Lw_p.js`）；Android debug APK 0.1.3 / versionCode 4；Windows portable 2026-10-25 17:20 重建并复制到桌面 `TIPHYS`。
- **明确未做：** ≥3 次基线方差与真机、Bangkok 分块 overlay、真实小流域/路网距离/真实生态阻力、GEE 真实授权与云队列、比例尺/指北针/图例/出版布局。

## 当前实现

- 对话、具名工具、后台任务、审批、流式进度和停止当前对话；任务类预算（quick/standard/pipeline）与可恢复的诚实失败。
- 浏览器侧 958 个 GeoLibre/Whitebox WASM 工具（矢量/栅格/表格进出），桌面侧 34 个 Python MCP 工具；Agent 可用 `wasm_search` / `wasm_run` 触达同一 WASM 目录。
- 多步计划 `run_plan`：计划期支持矩阵校验、步骤依赖、验收断言、sha256 审计、IndexedDB 检查点与断点恢复；验收失败的产物会被收回而不是留在工作区。
- 默认进入对话；添加数据后可直接描述分析目标。手动工具箱按数据管理、邻近分析、叠加分析、几何处理、查询与选择、地图与显示分类，支持搜索，表单来自工具契约。
- 地图/分析/视图命令分组、可搜索的内容树与真实符号图例、选中图层上下文、地图文档栏及坐标/级别状态栏；右侧默认多行 Agent 对话。
- 设置窗口支持 API 地址、模型、保留或替换密钥池、真实连接测试和立即应用；支持浅色/深色/跟随系统、界面密度与运行参数。未配置 API 时明确提示，不会自动退回 Mock。
- 图层右键缩放/属性表/符号化/标注/显示隐藏/删除；点击要素弹出属性卡；属性表分页、搜索、排序、记录定位、定义查询、字段统计；单一符号、唯一值分类与分级设色；点大小/线宽/透明度、字段标注与显示设置保存。
- 属性表支持本页 CSV 与真 XLSX 导出（不含几何）；要素导出按 RFC 7946 统一 EPSG:4326/2D，GPKG/FGB/CSV 保留原生分析 CRS。
- 栅格图层显示、色带预览与大量栅格 WASM 工具；原生真质心、空几何过滤、KML ExtendedData/描述字段保真。
- 手机端同源任务卡（缓冲/裁剪/叠加/字段统计/DEM 坡度/河网/服务圈/生态廊道等）与移动工具栏、属性表抽屉、返回栈。
- Agent 可直接调用缩放、打开属性表、设置符号与标注；顶栏运行日志提供过滤、调用详情、错误、复制与导出，含手动工具记录及服务诊断。
- 点、线、面及混合数据渲染；GeometryCollection 显示副本展开。
- 原始 CRS 的 GPKG 分析数据 + 独立 WGS84 GeoJSON 显示数据，工程清单和稳定图层 id。
- 缺失 CRS 必须指定 `source_crs`；局部 UTM 缓冲在源区和结果区检查投影尺度误差，超过 0.5% 拒绝执行。宽范围及跨日期变更线数据需要显式拆分分析区域；当前不支持极区缓冲。
- 任务取消与结果提交有统一边界；引擎重启后未完成任务显示 interrupted，不会自动重新执行。
- 事件游标补取、刷新后真实审批状态、独立 checkpoint、工具输出分页读取、真实模型的上下文交接摘要。
- 本地服务凭据通过请求头传递，限制浏览器来源，审批与任务取消绑定所属会话。

当前目录以运行时合并结果为准：958 个 WASM + 34 个 Python MCP + 5 个扩展 + 原生 `centroid` / `drop_empty_geometries`，合并 999 个、工具箱可见 995 个。浏览器 `dissolve` 与浏览器矢量分区 `zonal_statistics` 仍明确不支持（有降级说明）；GEE 真实授权、真实路网距离、真实流域/生态模型、打印出版布局仍未完成。与插件的具体差距和后续顺序见 [客户端能力对照](docs/CLIENT_PARITY.md)，阶段证据见 [MASTER_ROADMAP](docs/MASTER_ROADMAP.md)。

## 开发运行

Node.js 24+、Python 3.11+。Windows 示例：

```powershell
npm ci
npm ci --prefix agent
py -3 -m venv engine/.venv
engine/.venv/Scripts/python.exe -m pip install -r engine/requirements.txt
npm run dev:all -- --mock
```

打开 http://127.0.0.1:1420 。一次启动会管理引擎、Agent 和 Vite，端口占用会明确报错。Ctrl+C 仅清理自己启动的进程树。`--mock` 仅用于明确指定的模拟测试；正常运行去掉它。可在应用设置中配置真实 API，原有 `TIPHYS_LLM_*`、项目/用户 `agent.json` 与密钥池入口继续支持。设置页提供主流 OpenAI 兼容服务商预设，可一键拉取模型列表；没有任何已保存配置时使用内置 TierFlow 测试凭据（`TIPHYS_BUILTIN_CREDENTIALS=off` 可关闭）。已有启动环境覆盖时，设置会明确提示；任务运行中拒绝修改模型配置。不要提交密钥。

也可分别运行 `npm run engine`、`npm run agent`、`npm run dev`。两项服务必须使用相同的 `TIPHYS_STATE_DIR` 或默认项目 `.tiphys`，该目录保存本地服务凭据与会话。`npm run agent:tools` 会从该目录读取凭据。`/ping` 和 `/health` 用于诊断；其余接口要求 Bearer 凭据，不应把凭据放进 URL。

## 验证

```powershell
npm run test:engine
npm run test:agent
npm --prefix agent run typecheck
npm run build
npm run test:browser        # browser-engine + map-render；map-render 需要本机 Chrome
npm run test:contracts
npm run test:methods
npm run test:search
npm run test:plans
npm run test:centroid
npm run test:vector-budget
npm run test:xlsx
npm run baseline:agent      # 30 项模型在环基线（真实页面 + 模型，非 CI）
npm run bench:geoagent      # GeoAgentBench 兼容子集（单独报告）
```

Agent 集成测试会生成随机凭据和独立临时工程，启动/关闭自己的服务，强制使用 mock，不调用真实模型。包含结果文件检查、审批归属、断线补取、服务重启和停止审批中的对话。浏览器 `map-render` 用例依赖本机 Chrome 和网络；在受限代理/沙箱中可能卡在 `page.goto(..., networkidle)`，浏览器引擎套件仍应单独跑绿。当前证据：`browser-engine` 89/89、`test:plans` 31/31、`test:methods` 9/9、`test:search` 8/8、`test:contracts` 12/12、`test:centroid` 7/7、`test:vector-budget` 3/3、`test:xlsx` 2/2；模型在环 30/30（单次）与 GeoAgentBench 5/6。

## Windows 桌面

需要 Rust MSVC 工具链、Visual Studio 的 C++ 桌面工具与 Windows SDK、WebView2。

历史 Windows 状态：NSIS 安装版与便携 zip 曾通过构建、安装（解压）、启动、关闭与卸载验收（详见 [RELIABILITY_STATUS](docs/RELIABILITY_STATUS.md)）；均未签名，正式分发前需代码签名。当前构建（2026-10-25 17:20）已重新生成 NSIS 83.27 MiB 与 portable 119,559,227 B，并复制到 `C:\Users\alex\Desktop\TIPHYS`；本轮**未重复 GUI 点击验收**。构建产物仍标注 Tauri 包版本 0.1.0，而 `package.json` 为 0.1.3，两者待统一。本地固定端口 8971（引擎）/ 8972（Agent），与 GeoAgentPro（8765/8766）、GeoLibre（8765/8766）错开；启动失败（如端口被占）弹错误对话框并在应用数据目录留 `startup-error.log`，不再静默崩溃。

```powershell
npm run desktop:dev
```

桌面壳会启动 Node/Python 服务，并在退出时清理自己拥有的进程树。不要同时运行 `dev:all`，它们使用同一组本地端口。

安装包使用干净构建环境；已验证的 Windows Python 3.13 依赖锁在 `engine/requirements-windows.lock.txt`：

```powershell
py -3.13 -m venv engine/.venv-build
engine/.venv-build/Scripts/python.exe -m pip install -r engine/requirements-windows.lock.txt
npm run desktop:build
```

`bundle:sidecars` 用 esbuild 打包 Agent、复制 Node 运行时，以 PyInstaller 打包空间引擎；分发内容包括运行时许可证。NSIS 配置为 `src-tauri/tauri.bundle.conf.json`。安装后的数据、凭据与日志写入 Tauri 应用数据目录，开发源码目录无需可写。

便携版（解压即用，无安装器、无管理员权限、不写注册表）：在 `desktop:build` 之后运行 `npm run portable:zip`，产物为 `src-tauri/target/release/bundle/portable/TIPHYS-<版本>-x64-portable.zip`，解压后直接运行 `tiphys.exe`（需要系统 WebView2，其余运行时随包附带）。

独立验证打包后的服务：

```powershell
$env:TIPHYS_TEST_PACKAGED = "1"
node --import ./agent/node_modules/tsx/dist/loader.mjs --test agent/tests/integration.test.ts
```

构建产物存在不代表安装包或桌面窗口已经通过验收；请以 [可靠性状态记录](docs/RELIABILITY_STATUS.md) 中的启动与卸载证据为准。

## Android / 移动端

Capacitor Android 壳使用与 Web 相同的 React 界面和浏览器 WASM 引擎；手机端提供同源任务卡、工具箱、属性表抽屉和返回栈。当前 debug APK **0.1.3 / versionCode 4** 在线：https://tiphys.xyz/apk/tiphys-0.1.3.apk 。移动基线为 390×844 仿真 9/9 场景；**真机长任务、后台生命周期与 OPPO 三项交互仍为 NOT_TESTED**（见 [ANDROID_APK](docs/ANDROID_APK.md)）。APK 为 debug 签名，未上架 Play Store。

## 开源复用

通用能力优先直接使用维护中的库。地图几何过滤适配自 GeoLibre（MIT）；任务取消参考 DeepSeek Harness；上下文交接提示词源自 Codex。来源和许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。不复制专有代码。
