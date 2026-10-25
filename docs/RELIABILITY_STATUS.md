# 可靠性基础版本验收记录

> **2026-10-25 当前状态**以 [README 当前状态](../README.md)、[MASTER_ROADMAP 进度快照](MASTER_ROADMAP.md) 和 [STAGE4_REPORT](STAGE4_REPORT.md) 为准；本文是 2026-10-23 的可靠性批次历史记录。
>
> 后续更新：2026-10-23 的 API、分类工具箱、图层工作区、日志和最终桌面交付见 [客户端续作验收](WORKSPACE_STATUS_20261023.md)。本文下方的工具数、产物哈希和“未完成”清单是第二批历史记录，以新记录为准。

日期：2026-10-23（第二批：release 启动修复与端口迁移）。所有工作在当前项目内完成，未使用子 Agent。当前目标见 [RELIABILITY_PLAN](RELIABILITY_PLAN.md)。

## 当前结论

**源码与打包后的 sidecar 服务、release 桌面启动均已通过验证；NSIS 安装包可以构建、安装和卸载。安装包仍未签名，正式分发前需签名与付费模型验收。**

这一结论按层次区分：

| 环节 | 结果 | 证据 |
|---|---|---|
| 前端、Agent、空间引擎 | ✅ 通过 | 构建、类型检查、源码与打包运行集成测试通过（端口迁移后 17+9 项全部重跑通过） |
| Windows release / NSIS | ✅ 构建通过 | 已生成 64 位 NSIS 安装包 |
| NSIS 安装 | ✅ 通过 | 程序文件、卸载项和 sidecar 资源均已核对 |
| release 桌面启动 | ✅ 通过（第二批修复后） | `desktop-smoke` 六项场景全部通过：资源、缓冲上图、关窗清理、重启恢复、端口冲突隔离、半启动清理 |
| NSIS 卸载 | ✅ 通过 | 静默卸载返回 0；程序目录、HKCU 卸载项和进程均已清理 |
| Debug 桌面启动 | ✅ 通过 | 窗口可用；服务监听；引擎和 Agent 日志生成 |

## Windows 桌面产物与安装验收（第二批，2026-10-23）

- NSIS 安装包：`src-tauri/target/release/bundle/nsis/TIPHYS_0.1.0_x64-setup.exe`，`77,920,185` 字节（74.31 MiB），SHA-256 `80448A0B847A0F5CB5A5BEB83AF163256B222C773B03D0E01CE9ED7A1B82A7E3`。
- 便携 zip：`src-tauri/target/release/bundle/portable/TIPHYS-0.1.0-x64-portable.zip`，`110,229,403` 字节，SHA-256 `1C8060AB6ABC08425C5A0F88161CAFB9208947399910F8EE46069321B34DE2AA`；由 `npm run portable:zip` 生成（思路对齐 GeoLibre 的 portable 打包：解压即用、无安装器、无管理员权限、无注册表写入）。
- 签名状态：**两者均 NotSigned**，不可作为已签名发布包分发。
- NSIS 静默安装到 `F:\tiphys\.tooling\installed2` 后资源完整（`tiphys.exe`、`uninstall.exe`、`runtime/{node.exe, agent.mjs, tiphys-engine, licenses, samples}`）。
- **安装版与便携版各自通过完整 `desktop-smoke` 六项场景**（资源、缓冲上图、关窗清理、重启恢复、端口冲突隔离、半启动清理）——首批缺失的"安装目录内 sidecar 资源定位"与"安装后启动"验收在本批补齐。
- NSIS 静默卸载通过：安装目录删除、HKCU `TIPHYS` 卸载项删除、无残留进程；`%APPDATA%` / `%LOCALAPPDATA%` 下的用户数据按现状保留。

### release 启动失败：根因与修复（第二批）

首批验收记录的 release 启动崩溃（退出码 `-1073740791` / `0xc0000409` / BEX64）已定位为**三层问题叠加**，与 WebView2、MSVC 或引擎均无关：

1. **端口冲突（触发器）**：空间引擎默认端口 `8765` 与 GeoAgentPro 线的 GEE proxy（`GA_GEE_PORT` 默认 8765，常驻）相同；桌面启动时 setup 钩子因"端口被占"返回错误。同一台机器并行两条产品线是明确需求，因此 **TIPHYS 全线迁移到 8971（引擎）/ 8972（Agent）**，与 GeoAgentPro（8765/8766）和 GeoLibre Desktop（8765/8766）彻底错开。
2. **panic=abort 放大（把可解释错误变成崩溃）**：Tauri builder 对 setup 错误执行 `.expect()` panic；release 配置 `panic = "abort"` 使其走 fail-fast，Windows 记为 `0xc0000409`，没有任何用户可见信息。修复：setup 失败改走 `fail_startup` —— 原生错误对话框（rfd）+ `startup-error.log` + 退出码 1；自动化验收用 `TIPHYS_SMOKE_TEST=1` 跳过对话框。此后 `panic = "abort"` 恢复保留（可预期失败不再经过 panic 路径）。
3. **verbatim 路径破坏 Node 主模块解析（修复 1 后暴露的第二层）**：Tauri `resource_dir()` 在部分启动方式下返回 `\\?\F:\...` verbatim 路径；Node 以该路径为主模块启动时 `realpathSync` 在盘符段抛 `EISDIR`（lstat 'F:'），Agent 秒退。PyInstaller 引擎不受影响，因此首批只在 Debug（走源码分支）下无法复现。修复：`plain_root` 在构造任何命令前剥离 `\\?\` / `\\?\UNC\` 前缀。

修复后以 `desktop-smoke`（无头，`CloseMainWindow` 模拟用户点 X 关窗）验证 release exe 六项场景全部通过：安装资源完整、真实缓冲（5 要素）上图、关窗后服务释放、重启后工程图层恢复、两个端口分别被占时干净退出且互不牵连、Agent 入口缺失时引擎清理。同批迁移了全部端口引用（前端、Agent、引擎、脚本、CSP、文档），引擎 17 项、Agent/前端 9 项回归在迁移后重跑通过。

### 卸载与残留

执行 `uninstall.exe /S`，退出码为 0。随后确认安装目录不存在、`TIPHYS` HKCU 卸载项不存在、没有遗留 `tiphys` 进程。`%APPDATA%\com.tiphys.app` 下的测试数据、日志、服务凭据，以及 `%LOCALAPPDATA%\com.tiphys.app\EBWebView` 在卸载后仍保留；本轮未删除，以免误删用户配置或凭据。此结果只覆盖程序文件与注册项的卸载清理，用户数据保留策略尚待明确并验收。

## 已实现

| 范围 | 行为 |
|---|---|
| 空间数据 | 缺失 CRS 明确拒绝，可通过 source_crs 指定；保留原 CRS 的 GPKG 作为分析数据；WGS84 GeoJSON 仅用于显示；写入后检查要素数与 CRS |
| 缓冲 | 使用 GeoPandas/PROJ 选择局部 UTM；检查源区和输出区投影尺度；宽范围、极区等超出当前契约时明确报错；默认演示延迟关闭 |
| 任务 | 排队取消阻止执行；运行中先显示 cancelling；取消与结果提交共享边界；重启后未完成任务标记 interrupted，不自动重试 |
| 地图 | 点、线、面分别过滤；混合数据不会因为面分支而丢掉点或线；显示副本展开 GeometryCollection |
| 工程 | 原生 CRS 数据、元数据、稳定图层 id 与任务记录持久化；工程清单原子替换；同名图层引用有歧义时要求使用 id |
| Agent 恢复 | 独立原子 checkpoint；异步事件日志与序号；断线补取；刷新核对服务端审批状态；重启报告中断；恢复已知任务监视 |
| 访问控制 | 限定本地 UI 来源；HTTP/MCP/地图/SSE 请求用凭据头；审批与取消绑定会话；拒绝无凭据请求与无效会话 id |
| 上下文 | 旧 transcript 完整归档；工具大输出可分页读取；真实模型摘要覆盖所有角色，注入 GIS 状态；失败或预算仍超限时保留原对话并报错 |
| 运行 | 一次启动开发服务，拒绝复用占用端口；Windows 清理自身进程树；release 构建打包 Node Agent 与独立 Python 引擎；Tauri 启停和 NSIS 资源已进入实际构建、安装产物 |

## 已通过的验证

- 前端 `npm run build`；Agent `npm --prefix agent run typecheck`。
- 引擎 17 项回归，在开发环境及干净的 Windows Python 3.13 构建环境分别通过；包含 GPKG 内部主键与用户 fid 属性冲突的保全检查，以及安装目录中的项目相对路径解析。
- Agent/前端函数与进程集成共 9 项检查通过，包括真实 HTTP + MCP 流程、缓冲文件存在和要素数、审批归属、刷新审批、事件补取、服务重启、停止审批中的对话、跨轮流式回复隔离及上下文预算失败保全。
- 使用复制的 Node 运行时、esbuild Agent 与 PyInstaller 引擎执行同一集成测试，通过。
- 后续补充了运行中断验证：通过 Agent 提交真实后台缓冲，确认其仍在 running 时终止自己拥有的 Agent/引擎进程树，再按引擎→Agent 顺序重启。源码运行和打包运行两种模式均验证任务恢复为 interrupted、待监视任务清除、已有图层保持、任务 id 集合不增加，未自动重试或伪造新结果。这覆盖服务恢复，尚不等于 Tauri 窗口退出验收。
- 浏览器操作验证：样例缓冲上图、点线面混合图层、刷新保持待审批状态、拒绝操作、深浅主题。截图见 `screens/reliability-workspace.png` 与 `screens/reliability-light.png`。
- Windows release、前端、Agent、PyInstaller sidecar 和 NSIS 安装包均已实际构建；安装后资源结构已核对。
- NSIS 静默卸载通过，程序目录、卸载注册项和进程均清理；用户数据残留的范围见上文。
- Rust Debug 构建实际启动成功并拉起两个本地服务；release 构建启动失败，证据见上文。

## 尚未完成或不在本批范围

- 安装包未签名；正式分发前需要代码签名与对应的安装/启动验收。
- 卸载后用户级数据（`%APPDATA%\com.tiphys.app` 与 `%LOCALAPPDATA%\com.tiphys.app\EBWebView`）按现状保留；保留/清理策略尚需产品决策并验收。
- 付费模型的 API 调用、摘要质量和密钥轮换未在本批重新验收；自动化测试强制 mock，摘要逻辑用注入的测试回调验证。
- GEE、栅格、属性点选、其他空间工具仍按 MVP 后续里程碑推进；当前未宣称完整 MVP 已完成。
- 缓冲的尺度检查针对局部投影，不是全球测地缓冲算法。极区当前不支持。
- 崩溃发生在数据提交与任务日志落盘之间时，恢复会标为 interrupted 并保留可检查的工程结果，不能自动断言该任务失败或重试。
- 便携版 zip（`npm run portable:zip`，对齐 GeoLibre 的 portable 打包思路）已随本批验收：解压即用、六项场景通过与安装版一致。

## 端口规划

本地固定端口：引擎 `127.0.0.1:8971`、Agent `127.0.0.1:8972`。选择依据：GeoAgentPro GEE proxy 默认 8765/8766（`GA_GEE_PORT` 可覆盖但默认值固定在代码里），GeoLibre Desktop 也探测 8765/8766；三条产品线并行时必须互不抢占。端口常量定义在 `src-tauri/src/lib.rs`（`ENGINE_PORT` / `AGENT_PORT`），服务侧可用 `TIPHYS_ENGINE_PORT` / `TIPHYS_AGENT_PORT` 覆盖。

## 开源与构建

几何过滤适配自 GeoLibre 的 MIT 实现；计算继续使用 GeoPandas、Shapely 与 PROJ；取消请求与最终结束的区分参考 DeepSeek Harness。来源登记在 THIRD_PARTY_NOTICES.md。

Windows 构建使用 `engine/.venv-build`，避免开发 Conda 环境的无关 Qt 等依赖进入包。依赖锁记录在 `engine/requirements-windows.lock.txt`。Node、Python 和 Python 包的许可证随 runtime 资源收集。

## 后续顺序

代码签名 → 付费模型调用验收 → 以真实 GIS 工作流验证当前基础 → 便携版验收入清单 → 扩展本地工具和 GEE 竖切。优先交付能检查的完整结果，继续复用成熟库与现成开源实现。
