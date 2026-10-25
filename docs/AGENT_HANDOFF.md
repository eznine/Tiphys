# TIPHYS Agent 交接文档 / Agent Handoff

**更新日期：** 2026-10-25 ~12:42 Asia/Shanghai  
**当前 HEAD：** `2ca7d9e` — `release(android): 0.1.3 APK (immersive StatusBar + CapacitorHttp)`  
**分支：** `main` · remote `https://github.com/eznine/Tiphys.git`  
**工作树：** `/workspace/tiphys`（Linux box）· 干净（本交接文档提交后会前进一 commit）

> **给下一位 Agent：** 先读本文件，再读「治理文档」列表。Overnight builder **已暂停**，除非用户明确要求，否则不要恢复。

---

## 1. 当前状态 / Current HEAD

| 项 | 值 |
|---|---|
| Commit | `2ca7d9eb1dbcafe1fc330e6642fc3be178efda13`（短：`2ca7d9e`） |
| 日期 | 2026-10-25 12:20 Asia/Shanghai（APK 0.1.3 发布） |
| Live Web | https://tiphys.xyz |
| Live APK | https://tiphys.xyz/apk/tiphys-0.1.3.apk · versionCode **4** · package `0.1.3` |
| Overnight builder | **PAUSED**（tf-codex / tiphys-overnight-watch 均勿恢复） |
| Windows 同步 | `F:\tiphys` on DESKTOP-4O0NU9A — 交接时可能离线；box 已 push，PC 上线后 `git pull` |

---

## 2. 刚上线内容 / What just shipped

### APK 0.1.3（今日）
- **沉浸式顶栏：** 地图/聊天背景延伸到状态栏下；chrome 用 `--safe-top` / `env(safe-area-inset-top)` 避让；Capacitor StatusBar overlay + 透明。
- **检查更新：** 原生端用 `CapacitorHttp` 拉 `version.json`，绕过 WebView CORS；错误文案更清晰。
- nginx 片段保护 `/version.json` + `/apk/` CORS/短缓存（部署脚本不改 Certbot SSL）。

### 此前移动端修复（Tiphys bot 在 Linux box 执行，**不是** overnight tf-codex）
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

Densify / 工具目录加厚只在 A0 有进展之后。

---

## 4. 如何继续 / How to continue

### 在 Linux box（`/workspace/tiphys`）
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

### 在 Windows 家用机（同步后交接给本机 Agent）
路径：`F:\tiphys` · machineId `30ebd88b-abb8-449b-a4fa-e347be4f4933`（DESKTOP-4O0NU9A）

```bat
cd /d F:\tiphys
git pull origin main
git log -1 --oneline
```

确认 HEAD 含本交接 commit（或至少 ≥ `2ca7d9e`）。然后把本文件路径交给本机 Agent：`docs/AGENT_HANDOFF.md`。

### 治理文档（按此顺序读）
1. `docs/AGENT_HANDOFF.md` ← **本文件**
2. `docs/MASTER_ROADMAP.md`
3. `docs/OVERNIGHT_BRIEF.md`（顶部写明 PAUSED）
4. `docs/OVERNIGHT_PROGRESS.md`（追加式进度日志）
5. `docs/ANDROID_APK.md`
6. `docs/DEPLOY_TIPHYS_XYZ.md`

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

## 9. 恢复 densify / Agent 主线时的下一批 / Next Agent-core line

当用户允许继续 Agent 工作时（**不是**恢复整晚 densify 乱打）：

1. **Browser Agent 可靠性** — 降低 search→param 摩擦；任务类预算；不支持时诚实失败。  
2. **Desktop WASM bridge** — `wasm_run` 发现 + 参数 + 图层/文件绑定；至少 2–3 个 WASM 工具端到端回归；文档写进 desktop-wasm / agent-core-line。

生态模型、Play Store 打磨、未要求的 tiphys.xyz 重部署 → 仍延后。

---

## 10. 给父 Agent / 用户的一句话

仓库已在 `main` 上干净发布 APK **0.1.3**；overnight **暂停**；交接文档在 `docs/AGENT_HANDOFF.md`。Windows `F:\tiphys` 上线后 `git pull` 即可把同一状态交给本机 Agent。
