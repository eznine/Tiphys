# 手机版路线与实现（2026-10-24）

## 总路线：不做原生 App

TIPHYS 的移动形态是 **tiphys.xyz 的手机网页布局**，不是独立的原生应用。
所有移动端能力都在现有 SPA（`src/`）内实现，与桌面布局共用同一套组件与状态；
桌面布局必须保持不变。

若将来需要上架应用商店，再考虑用 **PWA（可安装到主屏）** 或 **系统 WebView 壳**
包同一站点 —— 那只是“壳”，不算重做产品，也不引入第二套前端代码。

## 手机布局（本次实现）

- **地图优先**：地图占满主要区域，顶部一条紧凑状态栏，底部一条矮输入栏。
  没有图层时也不显示“地图还没有图层”占位卡——地图与输入栏本身即可用
  （用户要求：无数据也要能直接开始，桌面版占位卡保留）。
- **底部输入栏**（类似常见手机聊天）：
  - `+` 号打开动作面板（添加数据 / 图层 / 工具箱 / 属性表 / 符号化 / 标注 /
    全图 / 缩放至图层 / 日志 / 设置 / 主题 / AOI 裁剪）；
  - 文本输入框，Enter 发送；
  - 发送按钮在 Agent 忙碌时变为停止按钮。
  - 不使用桌面那种高大的 ChatDock 常驻面板。
- **对话抽屉**：底部抽屉（约 88dvh），包含聊天时间线（与桌面 ChatDock 共用
  `ChatTimeline` 组件）、推荐工作流卡片、建议提示词与同一个输入栏组件。
  关闭时地图上方保留一条“对话手柄”胶囊，显示忙碌状态 / 消息数，点按重新打开。
- **其他面板全部走底部抽屉**：图层列表（复用 `LayerRail`）、工具箱（复用
  `ToolPanel`）、属性表（复用 `AttributeTable`）、运行日志（复用 `LogPanel`）、
  图层属性（复用 `LayerProperties`）。Agent 的 view 命令（打开属性表等）在手机上
  同样以抽屉呈现。
- **视觉**：沿用蓝主题 `#2563eb`、默认浅色、临时 logo（`/logo-temp.png`）；
  不引入青绿/神话风。暗色主题照常可用。
- **安全区**：`viewport-fit=cover` + `env(safe-area-inset-*)` 适配刘海与底部手势条。
- **断点**：`max-width: 860px` 时启用手机分支（`useMediaQuery` 驱动，
  根节点加 `.mobile` class；所有手机样式都限定在 `.mobile` 作用域内，
  桌面 CSS 一行不改地保留原样）。

## 实现落点

| 文件 | 作用 |
| --- | --- |
| `src/lib/useMediaQuery.ts` | 断点检测 hook（同步初始化，无桌面/手机闪烁） |
| `src/components/ChatTimeline.tsx` | 从 ChatDock 抽出的聊天时间线（恢复说明、欢迎页/推荐工作流、消息、工具芯片、任务卡、审批卡），桌面与手机共用 |
| `src/components/BottomSheet.tsx` | 通用底部抽屉（backdrop、拖动把手、标题栏、安全区） |
| `src/components/MobileComposer.tsx` | 底部矮输入栏（+ / 输入 / 发送-停止），在底栏与对话抽屉内复用 |
| `src/styles/mobile.css` | 手机样式，全部限定 `.mobile` 作用域 |
| `src/App.tsx` | `isMobile` 分支渲染手机布局；桌面分支原样 |

## 以后可选

1. **PWA**：`manifest.webmanifest` + service worker（缓存静态资源、离线外壳），
   可安装到主屏；工作量小，随时可加。
2. **WebView 壳**：Tauri（现有 `src-tauri`）或原生 WebView 包 tiphys.xyz 上架。
   壳只负责容器，不复制产品代码。
