# TIPHYS

**From Intent to Outcome** — Agent 优先的 GIS 桌面基础版本。

Tauri + React/TypeScript + MapLibre；Node Agent 使用 AI SDK 调用模型，通过 MCP 驱动 Python GeoPandas/Shapely/PROJ 引擎。产品边界见 [MVP_SPEC](docs/MVP_SPEC.md)，当前验证状态见 [RELIABILITY_STATUS](docs/RELIABILITY_STATUS.md)。

## 当前实现

- 对话、具名工具、后台任务、审批、流式进度和停止当前对话。
- 默认进入对话；添加数据后可直接描述分析目标。手动工具箱按数据管理、邻近分析、叠加分析、几何处理、查询与选择、地图与显示分类，支持搜索，表单来自 MCP 契约。
- 地图/分析/视图命令分组、可搜索的内容树与真实符号图例、选中图层上下文、地图文档栏及坐标/级别状态栏；右侧默认多行 Agent 对话。
- 设置窗口支持 API 地址、模型、保留或替换密钥池、真实连接测试和立即应用；支持浅色/深色/跟随系统、界面密度与运行参数。未配置 API 时明确提示，不会自动退回 Mock。
- 图层右键缩放/属性表/符号化/标注/显示隐藏/删除；点击要素弹出属性卡；属性表分页、搜索、排序及记录定位；单一符号与唯一值分类、点大小/线宽/透明度、字段标注与显示设置保存。
- Agent 可直接调用缩放、打开属性表、设置符号与标注；顶栏运行日志提供过滤、调用详情、错误、复制与导出，含手动工具记录及服务诊断。
- 点、线、面及混合数据渲染；GeometryCollection 显示副本展开。
- 原始 CRS 的 GPKG 分析数据 + 独立 WGS84 GeoJSON 显示数据，工程清单和稳定图层 id。
- 缺失 CRS 必须指定 `source_crs`；局部 UTM 缓冲在源区和结果区检查投影尺度误差，超过 0.5% 拒绝执行。宽范围及跨日期变更线数据需要显式拆分分析区域；当前不支持极区缓冲。
- 任务取消与结果提交有统一边界；引擎重启后未完成任务显示 interrupted，不会自动重新执行。
- 事件游标补取、刷新后真实审批状态、独立 checkpoint、工具输出分页读取、真实模型的上下文交接摘要。
- 本地服务凭据通过请求头传递，限制浏览器来源，审批与任务取消绑定所属会话。

现有 24 个 MCP 工具覆盖矢量处理、地图显示与任务控制。GEE、栅格、地图要素点选/编辑、复杂符号和出图仍属于后续产品工作；与插件的具体差距和后续顺序见 [客户端能力对照](docs/CLIENT_PARITY.md)。

## 开发运行

Node.js 24+、Python 3.11+。Windows 示例：

```powershell
npm ci
npm ci --prefix agent
py -3 -m venv engine/.venv
engine/.venv/Scripts/python.exe -m pip install -r engine/requirements.txt
npm run dev:all -- --mock
```

打开 http://127.0.0.1:1420 。一次启动会管理引擎、Agent 和 Vite，端口占用会明确报错。Ctrl+C 仅清理自己启动的进程树。`--mock` 仅用于明确指定的模拟测试；正常运行去掉它。可在应用设置中配置真实 API，原有 `TIPHYS_LLM_*`、项目/用户 `agent.json` 与密钥池入口继续支持。已有启动环境覆盖时，设置会明确提示；任务运行中拒绝修改模型配置。不要提交密钥。

也可分别运行 `npm run engine`、`npm run agent`、`npm run dev`。两项服务必须使用相同的 `TIPHYS_STATE_DIR` 或默认项目 `.tiphys`，该目录保存本地服务凭据与会话。`npm run agent:tools` 会从该目录读取凭据。`/ping` 和 `/health` 用于诊断；其余接口要求 Bearer 凭据，不应把凭据放进 URL。

## 验证

```powershell
npm run test:engine
npm run test:agent
npm --prefix agent run typecheck
npm run build
```

Agent 集成测试会生成随机凭据和独立临时工程，启动/关闭自己的服务，强制使用 mock，不调用真实模型。包含结果文件检查、审批归属、断线补取、服务重启和停止审批中的对话。

## Windows 桌面

需要 Rust MSVC 工具链、Visual Studio 的 C++ 桌面工具与 Windows SDK、WebView2。

当前 Windows 状态：NSIS 安装版与便携 zip 均通过构建、安装（解压）、启动、关闭与卸载验收（详见 [RELIABILITY_STATUS](docs/RELIABILITY_STATUS.md)）；均未签名，正式分发前需代码签名。本地固定端口 8971（引擎）/ 8972（Agent），与 GeoAgentPro（8765/8766）、GeoLibre（8765/8766）错开；启动失败（如端口被占）弹错误对话框并在应用数据目录留 `startup-error.log`，不再静默崩溃。

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

## 开源复用

通用能力优先直接使用维护中的库。地图几何过滤适配自 GeoLibre（MIT）；任务取消参考 DeepSeek Harness；上下文交接提示词源自 Codex。来源和许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。不复制专有代码。
