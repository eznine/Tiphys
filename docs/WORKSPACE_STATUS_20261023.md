# 2026-10-23 客户端续作验收

> 本文为第一批交付记录。后续发现实际桌面进程仍在 Mock 模式；第一批真实 API 记录来自独立的真实配置进程，不能据此证明当时用户启动的桌面进程用了真实 API。API 设置与工作台改版的后续验收见 [设置与工作台续作](SETTINGS_WORKSPACE_20261023.md)。下方产物哈希保留为第一批历史记录。

## 本轮结果

默认对话与现有地图布局保留。工具总下拉已改为可搜索的分组工具箱；内容列表加入文件选择、图层菜单、属性表、符号化、标注和属性入口；顶栏加入运行日志。Agent 与手动工具共用 MCP 参数校验。

当前 24 个 MCP 工具：`ping`、`list_layers`、`add_data`、`describe_layer`、`buffer`、`clip`、`intersection`、`union_layers`、`erase`、`dissolve`、`convex_hull`、`simplify`、`select_by_attributes`、`select_by_location`、`reproject`、`export_features`、`calculate_geometry`、`zoom_to_layer`、`open_attribute_table`、`set_layer_symbology`、`set_layer_labels`、`job_status`、`job_cancel`、`remove_layer`。手动工具箱隐藏 4 个诊断/任务控制入口，分 6 组显示 20 个用户工具。

关键修复：

- 手动面板此前用引擎基础地址获取鉴权头，无法命中带路径的鉴权规则；统一为实际接口地址的请求封装。
- 去掉手动入口的重复函数映射，直接调用 FastMCP 的已注册函数和参数校验。
- 面板切页不卸载在途任务，轮询顺序执行并在卸载时清理；支持取消和错误状态。
- 含空值的数值字段按数值类型比较；文本保留前导零和空格；空间选择匹配任一筛选要素，避免 union 改变 contains 等谓词。
- 叠加结果保留输入分析 CRS；导出先写临时文件并读回检查，再通过取消/提交边界原子发布；默认拒绝覆盖，保全 fid 属性；GeoJSON 转到 WGS84。
- 多条 Agent 地图命令不能覆盖同一个“最后命令”状态。现以带 id 的命令队列逐条应用，避免同一 React 批次丢失打开表、标注等操作，并防止事件补取重复执行。

## 验证证据

| 检查 | 结果 |
|---|---|
| 前端类型检查与生产构建 | 通过；MapLibre 大包体积提示仍存在 |
| Agent 类型检查 | 通过 |
| 引擎回归 | 26 项通过；开发 Python 与干净的 Python 3.13 构建环境分别通过 |
| Agent/前端/进程集成 | 12 项通过；包括新工具、MCP/REST 校验、205 条属性分页/排序/筛选、分类值、日志鉴权/脱敏、样式更新、批量视图命令 |
| 打包后 Node/PyInstaller 运行集成 | 通过同一隔离进程集成测试；使用 mock 避免混淆为真实模型验收 |
| 真实模型数据任务 | `tierflow_pro`：北海公园属性选择→300 m 缓冲→审批导出；1 个面，实际文件读回通过，无工具错误；独立椭球反算半径约 300.1099–300.1100 m |
| 真实模型界面任务 | 文件选择添加 beijing_points 后，自然语言调用缩放/表/标注/符号；修复批次丢命令后，用 pts_clip 重新测试：实际属性表标题 pts_clip、点半径 8、标注字段 name、字号 14，均通过界面核对 |
| 浏览器手动操作 | 分类/搜索→参数；缓冲 5 要素并上图；切回对话保留任务；图层右键菜单；属性表；单一符号/唯一值；字段标注；Agent 操作后再手动改为点半径 11、标注字号 16，刷新后两值及 name 字段均保留，旧 Agent 事件没有覆盖它们 |
| 日志界面 | 操作记录/服务诊断、搜索和详情通过；实际下载 JSON 文件并读回。包含 Agent 事件和手动工具/任务的引擎记录；密钥与凭据字段脱敏 |
| Windows 最终 release/NSIS/便携版 | 构建通过 |
| 桌面副本 | 1866 个交付文件逐一 SHA-256 对照，无差异 |
| 桌面新版启动验收 | 在副本完成且哈希一致后重跑：资源、5 要素缓冲、关闭清理、重启恢复、两端口冲突隔离、半启动清理全部通过 |

初次桌面复制与验收重叠导致文件占用，该轮结果不作为新版证据。随后重新完整复制、验证全部文件、重跑验收，最终通过。

截图：[Agent 与属性表](screens/workspace-agent-first-20261023.png)、[运行日志](screens/workspace-logs-20261023.png)。详细测试输出保留在本机 `.tooling/engine-clean-tests.log`、`real-continue-evidence.json`、`desktop-smoke-final-persisted-views.log` 等文件中。

## 最终产物

- 桌面：`C:\Users\alex\Desktop\TIPHYS\tiphys.exe`，SHA-256 `AC6383A7C27A88911FE718BBF953A57B97760408F6E2EEF4CF6F1F2C896C3D14`。
- NSIS：`src-tauri/target/release/bundle/nsis/TIPHYS_0.1.0_x64-setup.exe`，78,014,688 字节，SHA-256 `E72B144A598A3302067EC01A72F6503495198105BDC404CD2DB037B8D647B043`。
- ZIP：`src-tauri/target/release/bundle/portable/TIPHYS-0.1.0-x64-portable.zip`，110,323,661 字节，SHA-256 `5109586923751E1879899B6D361DA7A07818579D3B926481339A6F029796D948`。
- 用户已有模型密钥在应用数据目录准备就绪，未放入运行时分发包。已有工程/会话保持；验收使用独立临时状态目录。开发服务已停止，以释放桌面版使用的 8971/8972。

## 边界

尚未全量移植插件功能，见 [客户端能力对照](CLIENT_PARITY.md)。本轮不宣称 GEE、栅格、布局出图、Notebook、数据编辑或撤销已完成。属性表目前只读，符号化是基础单一符号/唯一值，Agent 符号工具目前为单一符号。

桌面原生文件选择命令已编译进入 release；浏览器文件选择与导入已实际操作验证，本轮未单独对 Windows 原生选择对话框做交互验收。服务诊断读取已存在的 agent.log/engine.log/startup-error.log 尾部；分开启动的开发进程写控制台时，此列表可能为空，不表示已有日志被删除。

安装包仍未签名；本轮没有重新执行 NSIS 安装/卸载，当前最终桌面运行证据覆盖便携目录。不能把历史安装验收视为本轮重新安装的证据。
