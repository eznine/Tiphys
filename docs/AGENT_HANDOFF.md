# TIPHYS Agent 交接文档 / Agent Handoff

> # 读这个再动手 / READ THIS FIRST
>
> **「怎么做得快 / Speed playbook」在下方第一节。** 任何接手的 Agent（Local Codex / 其他医生）先完整读完这一节，再碰代码或脚本。不要跳过 HANDOFF 直接开改。

**更新日期：** 2026-10-25 ~12:50 Asia/Shanghai  
**当前 HEAD（代码时代）：** `2ca7d9e` — `release(android): 0.1.3 APK (immersive StatusBar + CapacitorHttp)`（其后多为 docs handoff）  
**分支：** `main` · remote `https://github.com/eznine/Tiphys.git`  
**工作树：** `/workspace/tiphys`（Linux box，默认热环境）· Windows `F:\tiphys` 用 `git pull` 同步

---

## 0. 怎么做得快 / Speed playbook（必读）

这一节说明：**Tiphys 在 Linux box 上为什么能把移动端 / APK 修得快**，以及下一位 Agent 怎么同样快。不要发明新流程。

### 工作跑在哪 / Where work runs

| 环境 | 路径 | 何时用 |
|---|---|---|
| **默认（热）** | Linux box `/workspace/tiphys` | 日常改代码、类型检查、构建、部署 tiphys.xyz、打 APK。Node / Android SDK / deploy SSH 已暖好。 |
| Windows 本机 | `F:\tiphys`（DESKTOP-4O0NU9A） | **仅当用户要求**交给 Local Codex / 本机 Agent 时。先 `git pull --ff-only origin main`，再动手。 |

同步：box 上 commit + push → Windows `git pull`。不要两边同时脏树抢改。

### 治理文档顺序 / Governing docs（按此读，勿跳过）

1. **`docs/AGENT_HANDOFF.md`（本文件）— 先读本节「怎么做得快」** ← 不要略过
2. `docs/OVERNIGHT_BRIEF.md`（顶部写明 PAUSED + 指向本 playbook）
3. `docs/OVERNIGHT_PROGRESS.md`（**只追加**；先看尾部，避免重做已上船的活）
4. 需要时再读：`docs/ANDROID_APK.md`、`docs/DEPLOY_TIPHYS_XYZ.md`
5. 路线图等：`docs/MASTER_ROADMAP.md`（非紧急）

**不要**只扫 BRIEF / PROGRESS 就开大改。HANDOFF 速度节是效率的入口。

### 任务形状 / Task shape（快的核心）

- **一批一个窄结果**：例如「只恢复 IME / dock fold」「只 bump APK 0.1.x」「只修检查更新 CORS」。
- 每批：改 → 验证（`npx tsc --noEmit`，相关 build）→ **追加** PROGRESS → commit + push → **停住**或开下一批窄任务。
- **禁止**无范围巨型重写、一次改半个产品、跳过验证就 push。

### 关键脚本 / Key scripts（复用，别重造）

```bash
cd /workspace/tiphys
npx tsc --noEmit          # 改代码后必跑
npm run build             # Vite 生产构建
npm run deploy:xyz        # 部署 tiphys.xyz（保护 /srv/tiphys-web/apk/）
npm run android:build     # Capacitor + Gradle → dist-apk/tiphys-debug.apk
npx cap sync android      # 插件/配置变更后
```

部署 / APK 流程以现有脚本与 `ANDROID_APK.md` / `DEPLOY_TIPHYS_XYZ.md` 为准，**不要重新发明 deploy**。

### Overnight builder 配方（仅用户要求恢复时）

**当前：PAUSED。除非用户明确说恢复，否则不要启动。**

```bash
tf-codex -C /workspace/tiphys   # 优先 tierflow_pro
```

- 历史 prompt：`.tooling/overnight/batch*-prompt*`
- Watcher：`tiphys-overnight-watch` ~30m — **已暂停**；勿自行 resume
- 每批绿了才追加 PROGRESS + commit + push

### 当前上船状态 / Current ship state

| 项 | 值 |
|---|---|
| APK | **0.1.3** / versionCode **4** → https://tiphys.xyz/apk/tiphys-0.1.3-brand.apk（新 Logo；Windows debug 签名，旧包需卸载后再装） |
| 代码时代 | `2ca7d9e`（APK 0.1.3）+ A0/A1 修复至 `a74d7a0`；最新 main 以 `git log` 为准 |
| Web | https://tiphys.xyz 已 live（`assets/index-CMwH0Jsa.js`，新品牌 Logo） |
| Windows 桌面 | portable 重建于 2026-10-25 20:05 → `C:\Users\alex\Desktop\TIPHYS`；NSIS 83.50 MiB；新 Logo 图标；GUI 未实机点击验收 |
| Overnight | **PAUSED**（builder + tiphys-overnight-watch） |
| 优先级 | **Agent-first**（browser Agent 可靠性 + desktop WASM bridge）；生态模型延后 |

### 速度技巧 / Speed tips

1. **环境已热**：优先在 box 做 APK / deploy；Windows 只做用户点名的本机交接。
2. **切小**：窄 outcome → 验证 → PROGRESS → push；不要攒一大堆。
3. **复用脚本**：`build` / `deploy:xyz` / `android:build` / `cap sync` / `tsc`。
4. **先看 PROGRESS 尾**：已 ship 的（0.1.1–0.1.3、IME、fold、identify sheet、沉浸顶栏…）不要重做。
5. **部署别伤 APK 目录**：保护 `/srv/tiphys-web/apk/`。

### 禁止 / Forbidden

- 密钥、token、`.env`、service-account JSON **进 git**
- **force-push** `main`
- **未经用户要求**恢复 overnight / tiphys-overnight-watch
- 部署时 **清空** `/srv/tiphys-web/apk/`
- 未经用户要求重建 APK 或全站重部署（纯文档交接除外）

---

## 1. 当前状态 / Current HEAD

| 项 | 值 |
|---|---|
| Commit（APK 代码） | `2ca7d9eb1dbcafe1fc330e6642fc3be178efda13`（短：`2ca7d9e`） |
| 日期 | 2026-10-25 12:20 Asia/Shanghai（APK 0.1.3 发布） |
| Live Web | https://tiphys.xyz |
| Live APK | https://tiphys.xyz/apk/tiphys-0.1.3.apk · versionCode **4** · package `0.1.3` |
| Overnight builder | **PAUSED**（tf-codex / tiphys-overnight-watch 均勿恢复） |
| Windows 同步 | `F:\tiphys` on DESKTOP-4O0NU9A — box push 后 PC `git pull` |

---

## 2. 刚上线内容 / What just shipped

### APK 0.1.3（今日）
- **沉浸式顶栏：** 地图/聊天背景延伸到状态栏下；chrome 用 `--safe-top` / `env(safe-area-inset-top)` 避让；Capacitor StatusBar overlay + 透明。
- **检查更新：** 原生端用 `CapacitorHttp` 拉 `version.json`，绕过 WebView CORS；错误文案更清晰。
- nginx 片段保护 `/version.json` + `/apk/` CORS/短缓存（部署脚本不改 Certbot SSL）。

### 属性表真 XLSX（2026-10-25 17:20）
- 属性表新增“导出本页 Excel”；`src/lib/xlsx.ts` 用已有 fflate 生成单 sheet OOXML（表头加粗、冻结首行、数字/布尔/中文、公式注入前缀）。
- 只导当前可见页，不含几何；`test:xlsx` 2/2，并用 openpyxl 实际回读验证。CSV 导出保留。

### Windows 桌面 portable（2026-10-25 17:20）
- `desktop:build` + `portable:zip` 成功；NSIS 83.27 MiB（87,318,993 B），portable zip 119,559,227 B，解压 290 MB。
- 新版已复制到 `C:\Users\alex\Desktop\TIPHYS`；上一版 17:00 构建备份在工作区 `.trash/TIPHYS_desktop_20261025_1715`。
- 包含 A0 修复（真质心、KML、RFC 7946、空几何、矢量预算、inspect CRS 语义）与属性表真 XLSX。**未启动 GUI 做实机点击验收**。

### A0.1 全量 30 任务基线（2026-10-25 16:42）
- **30/30 PASS，0 FAIL / 0 ERROR**；P50 30 s / P95 146 s / 最长 226 s；输入 428,028 tokens / 输出 14,352；预期工具命中 27/30；计划 11 次，`auditRuns` 0 违规；H08 48.7 s 为 warn。
- 报告 `docs/baselines/stage4/agent-baseline.{json,md}`。**证据边界：** 与 inspect 语义修改有时间重叠，非冻结构建；单次运行，≥3 次方差/真机/跨模型仍未做。

### A0.4 GeoAgentBench 重评分（2026-10-25 16:15）
- 6 任务兼容子集 **5/6 PASS，加权 0.833**（此前 2/6）：Paris 重投影 11/11、Cairo 凸包 10/10、Capetown 质心 9/9、Paris KML 10/10、Capetown waterway 12/12。
- 修复：原生真质心（面积加权 + UTM 大坐标稳定化）、KML description 键值展开、GeoJSON 导出按 RFC 7946 统一 EPSG:4326/去 Z、原生空几何过滤、Shapefile sidecar 与 Windows UTF-8 grader。
- 仅剩失败：`geo-l2-bangkok-landuse-intersect`（21,660 面 / 64.5 万顶点，超过浏览器矢量预算；已加 20,000 要素 / 500,000 顶点守卫，诚实拒绝并给桌面/分块降级）。见 `docs/baselines/stage4/geoagentbench.md`。

### 此前移动端修复（在 Linux box 执行，**不是** overnight tf-codex）
| 版本 | 要点 |
|---|---|
| 0.1.1 | IME 收起恢复、Settings 下载按钮、APK 检查更新入口 |
| 0.1.2 | 输入时 dock 折叠、退出后恢复；Identify 底部 sheet；back stack；工具箱 hydrate（~900 工具）；属性表抽屉 |
| 0.1.3 | 沉浸顶栏 + CapacitorHttp 检查更新 |

相关近期 commit（自新到旧）：`2ca7d9e` → `e6d1500` → `4c42a8d` → `d6d50d6` → `6b514f4` → `52e72b6` → `24dfb2c`。

---

## 3. 优先级锁定 / Priority lock

来自 `docs/OVERNIGHT_BRIEF.md` **A0（用户 2026-10-25 ~09:53 锁定）**：

1. **主线 = Agent-first（整产品可靠）**  
   - Browser Agent 可靠性（搜索→参数摩擦、任务预算、诚实失败）  
   - Desktop Agent ↔ WASM bridge（`wasm_run` 发现/参数/图层绑定）  
2. **生态模型（InVEST / Circuitscape / 真实阻力面）= 延后**，不要开批次。  
3. **Overnight = PAUSED** — 用户未说「恢复」就不要启动 builder / tiphys-overnight-watch。

**当前 A0 状态：** 浏览器预算/检索参数卡/诚实失败已落地；桌面 WASM bridge 已实现并有回归/文档；GeoAgentBench 2026-10-25 重评 **5/6**（仅 Bangkok 大矢量资源边界未过，已有预算守卫）；完整 30 任务在环基线 **30/30 PASS**（单次，42.8 万输入 token；与 inspect 语义修改有时间重叠，非冻结构建；≥3 次方差与真机仍未做）。

Densify / 工具目录加厚只在 A0 有进展之后。

---

## 4. 如何继续 / How to continue

### 在 Linux box（`/workspace/tiphys`）— 默认
```bash
cd /workspace/tiphys
git pull origin main
npx tsc --noEmit          # 改代码后必跑
# 需要时再：
npm run build
npm run deploy:xyz        # 仅用户要求时；保护 /srv/tiphys-web/apk/
npm run android:build     # 仅用户要求重建 APK 时
npx cap sync android      # Capacitor 插件/配置变更后
```

### 在 Windows 家用机（用户要求本机交接时）
路径：`F:\tiphys` · machineId `30ebd88b-abb8-449b-a4fa-e347be4f4933`（DESKTOP-4O0NU9A）

```powershell
git -C "F:\tiphys" pull --ff-only origin main
git -C "F:\tiphys" log -1 --oneline
```

确认 HEAD ≥ 含本节 playbook 的 docs commit（或至少 ≥ `2ca7d9e`）。然后把路径交给本机 Agent：`docs/AGENT_HANDOFF.md`（**先读第 0 节**）。

### 治理文档（再次强调顺序）
1. `docs/AGENT_HANDOFF.md` ← **本文件，先读「怎么做得快」**
2. `docs/OVERNIGHT_BRIEF.md`（PAUSED）
3. `docs/OVERNIGHT_PROGRESS.md`（追加式；先看尾）
4. `docs/ANDROID_APK.md` / `docs/DEPLOY_TIPHYS_XYZ.md`（按需）
5. `docs/MASTER_ROADMAP.md`

---

## 5. 关键脚本（无密钥）/ Key scripts

| 命令 | 用途 |
|---|---|
| `npm run build` | Vite 生产构建 |
| `npm run deploy:xyz` | 部署到 tiphys.xyz（**勿覆盖** `/srv/tiphys-web/apk/` 历史包，除非用户明确要求） |
| `npm run android:build` | Capacitor + Gradle debug APK → `dist-apk/tiphys-debug.apk` |
| `npx tsc --noEmit` | 类型检查 |
| `npx cap sync android` | 同步 web assets / 插件到 `android/` |

测试（按需）：`npm run test:browser`、`test:contracts`、`test:methods`、`test:search`、`test:plans`。

---

## 6. Overnight builder 配方（仅用户要求恢复时）

**当前状态：PAUSED。不要自动启动。**

恢复时建议：
```bash
tf-codex -C /workspace/tiphys   # 优先 tierflow_pro；配额不足再轮换
```
- 历史 prompt：`.tooling/overnight/batch*-prompt*`
- 每批结束后 **追加** `docs/OVERNIGHT_PROGRESS.md`，绿则 commit + push
- Watcher 例程名：`tiphys-overnight-watch`（约每 30 分钟）；**目前已暂停**
- UI 约束：蓝强调 `#2563eb`、浅色默认、诚实 WASM catalog、chat-first；禁止 teal / 神话皮 / 虚报工具数

---

## 7. 禁止事项 / What NOT to do

- **不要**恢复 overnight builder / tiphys-overnight-watch，除非用户明确说恢复。
- **不要** force-push `main`。
- **不要** 把密钥、token、`.env`、service-account JSON 提交进 git。
- 部署 tiphys.xyz 时 **保护** `/srv/tiphys-web/apk/`（历史 APK 与 versioned 包）；不要无故清空。
- **不要** 未经用户要求就重建 APK 或全站部署（本交接仅为文档）。
- 不要在 Windows 与 box 之间抢同一脏工作树；先 pull 再改。

---

## 8. 用户需在 OPPO 上验证 / Open verify (OPPO)

装 **0.1.3**（https://tiphys.xyz/apk/tiphys-0.1.3.apk）后请确认：

1. **Fold restore：** 打开输入时 dock 隐藏；Back / 侧滑 / 点空白后 dock 恢复。
2. **检查更新：** 设置里「检查更新」能拉到远程 version（不再 CORS 失败）。
3. **沉浸顶栏：** 地图/聊天内容延伸到状态栏下方，顶栏控件不被系统状态栏遮挡。

---

## 9. 下一阶段 / Next line（A0 已基本收口）

A0.1 单次 30/30、A0.2 desktop WASM bridge、A0.3 契约、A0.4 GeoAgentBench 5/6 均已完成；不要重复做参数卡/预算/bridge。

1. **证据硬化（优先，不改产品逻辑）** — 30 任务 ≥3 次方差与 CI、OPPO 真机、桌面 GUI 启动/关闭；30/30 是单次且与 inspect 修改重叠，不能写成稳定上限。
2. **阶段 5A 真实小流域** — 建立“下载 → CRS/网格/NoData 体检 → 入库 → 河网/流域纵向”最小管线，至少 2 个真实 DEM。
3. **阶段 5B 路网距离** — 接入可复现的路网 provider（OSRM/Valhalla 或预计算图），区分欧式与路网距离。
4. **阶段 6 数据与交付** — GEE 真实链路、STAC/COG/OSM、打印布局；A1 剩余全表 CSV/XLSX、字段编辑、撤销、大图层性能基准。
5. **Bangkok 大矢量** — 仅当出现高频 2 万级矢量任务再投入；5,000 个清理后要素仍 368 s 失败，当前保留预算守卫与桌面/分块降级。

生态模型、Play Store 打磨、未要求的 tiphys.xyz 重部署、多 Agent、3D/LiDAR → 仍延后。完整顺序见 `docs/MASTER_ROADMAP.md` 的「2026-10-25 进度快照与下一阶段决策」。

---

## 10. 给父 Agent / 用户的一句话

仓库 `main` 已干净发布 APK **0.1.3**、Web `assets/index-Bcx4Lw_p.js` 与 Windows portable（2026-10-25 17:20）；模型在环 **30/30 单次**、GeoAgentBench **5/6**；overnight **暂停**。下一阶段先补 ≥3 次方差/真机，再做阶段 5A 真实小流域与 5B 路网距离。**速度 playbook 在本文件最开头**；Windows `F:\tiphys` 上线后 `git pull`，交给本机 Agent 时先读第 0 节。
