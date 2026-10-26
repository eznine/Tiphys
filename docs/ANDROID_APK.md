# Android APK (Capacitor)

Status: **offline-capable debug-prototype APK**, signed with a **single canonical cert** so installs upgrade in place.

## Current ship (0.1.5 / versionCode 6)

- App id `xyz.tiphys.app`, label `TIPHYS`, version **0.1.5** (versionCode **6**).
- Published: `https://tiphys.xyz/apk/tiphys-0.1.5.apk` (also mirrored as `tiphys.apk`).
- Check-update polls **`https://tiphys.xyz/version.json`** first; falls back to `https://tiphys.xyz/tiphys/version.json`.
- Notes: IME root-cause fix (see below) + **canonical signing**.

---

## 签名冲突 / 已安装签名冲突（必读）

### 现象

安装时提示 **「已安装签名冲突」** / signature conflict：系统里已有同包名 `xyz.tiphys.app`，但证书指纹不同，Android 拒绝覆盖安装。

### 原因

历史上用过 **两台机器各自的 `~/.android/debug.keystore`**：

| 构建机 | Cert SHA-256（指纹） | 典型版本 |
|---|---|---|
| Linux box | `aca4105b…f1d8`（`AC:A4:10:5B…F1:D8`） | 0.1.0–0.1.3（箱上 debug） |
| **Windows（规范）** | **`efd833d2…c6db`** | **0.1.3-品牌、0.1.4、0.1.5+** |

同一包名、不同证书 → 必须先卸载再装。

### 规范密钥（canonical）

- **指纹（SHA-256，无冒号小写）：** `efd833d24fa5151dc24ba5be200d0c48fb09a91271cdeaf583a6ff09e1fec6db`
- **来源：** 复用 Windows 本机 debug 密钥（已装 0.1.3-品牌 / 0.1.4 用户可直接覆盖）。
- **存放（均在 git 外，勿提交）：**
  - **Windows（唯一规范构建机）：** `F:\tooling\signing\tiphys-canonical.keystore` + `F:\tooling\signing\keystore.properties`
  - 可选镜像：`F:\tiphys\.signing\`（gitignored）
  - **Linux box（可选）：** `~/.config/tiphys/signing/` — CopyToBox **无法**从 Windows 拉密钥；无密钥时 Gradle **大声失败**，不要用箱上 `~/.android/debug.keystore` 冒充发版包。
- **Gradle：** `android/app/build.gradle` 的 `signingConfigs.tiphys` 显式签名 debug/release；不再隐式依赖每机 `~/.android/debug.keystore`。
- **上传前校验：** `scripts/verify-apk-cert.mjs`（`npm run android:build` 与 `npm run upload:apk` 都会跑）。指纹不对 → **拒绝上传**。

### 用户要做的一次性操作

- 若手机上是 **箱签名** 的旧包（0.1.0–0.1.3 等）：**先卸载 TIPHYS，再装 0.1.5**（会清空该 App 本地存储，一次性）。
- 若已是 **Windows 签名** 的 0.1.3-品牌 / 0.1.4：直接覆盖安装即可。

---

## IME / 软键盘（0.1.5 根因）

### 现象

APK 内点聊天输入框：底栏闪一下（fold/unfold），**软键盘不弹出**。手机 Chrome 打开 `tiphys.xyz/tiphys/` 正常 → **仅 Capacitor WebView**。

### 根因（代码级复现，非再猜）

`resizeOnFullScreen` + StatusBar overlays 下，键盘弹出过程中 Capacitor 会改 WebView 内容高度，同时 `visualViewport` 也在变。旧逻辑把 **「visualViewport 高度 ≈ layout 高度」** 当成键盘已收起，并在 `keyboardWillShow` 已把 dismiss「武装」后立刻 `blur()`，键盘被自己掐掉。700ms grace **挡不住**（show 事件会立刻武装）。另：Capacitor 6 会对非 IME 的 insets 动画也发 hide；未先观察到 show 的 hide 不应收起。

证据：`tests/mobile-ime.test.mjs` 在 HEAD 上复现失败；修复后 10/10。详见交接文档与 `/tmp/codex-ime-report.md` 类记录。

### 修复

- Native 平台：**只用** Capacitor Keyboard 的 show→hide（必须先 show）。
- Web：保留 visualViewport / VirtualKeyboard 启发，且要求可见→隐藏过渡。
- `deferComposerIdle` 在回调前复查焦点，避免 stale blur 清掉新焦点。
- **保留 UX：** 输入时底栏隐藏（`data-input-focused`）；Back / 侧滑 / 外点 / 发送后立即恢复。

---

## Build（发版请在 Windows）

```powershell
# JDK 17 for the session
$env:JAVA_HOME = "F:\tooling\android\jdk17"   # or Android Studio JBR / Corretto 17
$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
$env:ANDROID_HOME = "F:\tooling\android\sdk"
java -version   # 17.x
cd F:\tiphys
git pull --ff-only origin main
npm run android:build
# → CAPACITOR=1 vite build + cap sync + assembleDebug (tiphys signing)
# → dist-apk/tiphys-debug.apk + cert check
```

```bash
# Linux box: only if ~/.config/tiphys/signing/keystore.properties exists
npm run android:build
# else Gradle fails with a clear "keystore.properties not found" message — by design
```

Verify:

```powershell
aapt dump badging dist-apk\tiphys-debug.apk | findstr version
node scripts/verify-apk-cert.mjs dist-apk\tiphys-debug.apk
# Expect versionName=0.1.5 versionCode=6 and cert efd833d2…
```

Install:

```bash
adb install -r dist-apk/tiphys-debug.apk
# 若签名冲突：先 adb uninstall xyz.tiphys.app
```

## Check for updates

`src/lib/appUpdate.ts` polls root then `/tiphys/` `version.json`, compares `versionCode` / semver, uses `CapacitorHttp` on native.

## Publish checklist

1. Bump version in `android/app/build.gradle`, `src/lib/appUpdate.ts`, `public/version.json`.
2. **On Windows + JDK 17 + F:\tooling\signing\：** `npm run android:build`.
3. Cert check must print OK `efd833d2…`.
4. `npm run upload:apk -- dist-apk/tiphys-0.1.5.apk`（脚本会再次验证书）.
5. Confirm both `version.json` URLs and APK 200.
6. Optional: copy APK to box `dist-apk/tiphys-debug.apk` and commit so both machines share the binary.

## Out of scope

Play Store / release keystore rotation beyond this canonical debug cert, iOS, native GIS engines.
