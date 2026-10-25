# TIPHYS Android Debug APK (P2 rough shell)

Status: **rough offline-capable debug prototype**, built and statically verified on the Linux box on 2026-10-25. It is not a Play Store build and has not yet been launched on a physical Android device or emulator.

## What ships

- Capacitor 6.2.2 Android shell (`android/`) around the existing Vite/React/MapLibre app.
- App id `xyz.tiphys.app`, display label `TIPHYS`, version `0.1.3` (versionCode 4).
- `minSdkVersion 22`, `targetSdkVersion 34`, `compileSdkVersion 34`.
- Debug APK: `dist-apk/tiphys-debug.apk` (about 17.2 MiB).
- SHA-256: `4a316bfd9f566cc134afe2ef3753d0eaf15a6fe9eb27f2f7e5f21005a5e0d952`.
- Build helper: `npm run android:build` (`scripts/build-android.mjs`). It runs the Vite build with `CAPACITOR=1`, runs `npx cap sync android`, runs Gradle `assembleDebug`, and copies the APK to `dist-apk/`.

The generated Android project is source. Gradle output, copied web assets, `local.properties`, and SDK/JDK files are ignored and must not be committed.

## Clean-box prerequisites

The build was verified with Node.js 20.19.2, npm 11.21.1, Eclipse Temurin OpenJDK 17.0.21, Android platform 34, and build-tools 34.0.0. The repository README recommends Node 24+ for the full development stack; the Android build itself succeeded on Node 20.

On Ubuntu/Debian, OpenJDK 17 can be installed with `sudo apt-get install -y openjdk-17-jdk`. A portable Temurin JDK unpacked outside the repository is also fine. Keep the JDK and Android SDK outside the TIPHYS git tree.

1. Install Node.js and dependencies:

   ```bash
   cd /workspace/tiphys
   npm ci
   ```

2. Download Android command-line tools from <https://developer.android.com/studio#command-line-tools-only>, then install the SDK at a path outside the repository:

   ```bash
   export JAVA_HOME=/home/box/Android/jdk17
   export ANDROID_SDK_ROOT=/home/box/Android/sdk
   export ANDROID_HOME="$ANDROID_SDK_ROOT"
   export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

   mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
   unzip commandlinetools-linux-*.zip -d /tmp/android-cmdline-tools
   mv /tmp/android-cmdline-tools/cmdline-tools "$ANDROID_SDK_ROOT/cmdline-tools/latest"

   yes | sdkmanager --licenses
   sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
   ```

3. Confirm the toolchain:

   ```bash
   java -version
   sdkmanager --version
   adb version
   ```

The first Gradle build needs network access to download Gradle 8.2.1 and Maven dependencies. Later builds can reuse the Gradle cache. Do not commit `~/.gradle`, `android/.gradle`, `android/app/build`, or the Android SDK.

## Build and install

From the repository root, with the environment above exported:

```bash
npm run android:build
```

Equivalent manual sequence:

```bash
CAPACITOR=1 npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

The Android build uses `base: "./"` only when `CAPACITOR=1`. Normal web and Tauri builds keep the existing `/` base. Vite emits relative script, worker, and WASM URLs so Capacitor's local WebView origin can load them. `cap sync` copies `dist/` into `android/app/src/main/assets/public`; that generated copy is intentionally ignored by git and should be regenerated after every web change.

APK locations:

```text
android/app/build/outputs/apk/debug/app-debug.apk
dist-apk/tiphys-debug.apk
```

With a device connected over ADB:

```bash
adb install -r dist-apk/tiphys-debug.apk
```

## Offline boundary

The APK bundles the SPA, MapLibre renderer/worker, GeoLibre catalog, browser WASM engine, and the two WASM payloads. Files imported through the app and browser-tested local vector/raster rendering do not require a network connection. The UI falls back to the tile-free **离线空白** basemap when the WebView starts offline or when an online style fails and `navigator.onLine` is false.

Bundled and usable without network:

- App HTML, JavaScript, CSS, icons, MapLibre worker, browser WASM worker, GeoLibre CLI WASM, GeoLibre library WASM, and the hydrated tool catalog.
- Local GeoJSON/shapefile/FlatGeobuf/GeoTIFF imports, local layer rendering, attribute inspection, and browser-WASM tools already supported by the web app.
- Browser IndexedDB persistence for local layers created by the web runtime.
- **离线空白**: a real tile-free MapLibre style. It is not imagery, a cached map, or a pretend offline basemap.

Still needs network:

- OpenFreeMap street/light/dark/bright vector tiles, sprites, and fonts.
- Esri satellite and hillshade raster tiles, and OpenTopoMap raster tiles.
- AWS Terrain Tiles for 3D terrain.
- Google-hosted Inter font (the app remains usable with a local font fallback).
- Any configured AI model/API endpoint. To use the agent, the selected provider must be reachable; local WASM tools do not.

No basemap-tile cache is implemented. Airplane mode therefore gives a blank background plus local layers and WASM tools, not cached streets or imagery.

## Large raster and memory limits

Android WebView memory is shared with the app process and is much tighter than desktop. The existing task cards reject selected workflows above **2,000,000 pixels** (`MOBILE_MAX_PIXELS`), but manual imports are not a guarantee against OOM. Raster display converts a selected band to `Float64`, so one 2 MP band is already about 16 MB before render buffers, WASM input/output, and catalog/UI memory; 10 MP is roughly 80 MB per selected band before those copies.

Practical guidance for this prototype:

- Prefer rasters at or below 2 MP for task-card workflows.
- Crop, mosaic, or resample larger products on desktop before transfer.
- Avoid large multi-band rasters and several large rasters in one job.
- Keep the app in the foreground during long WASM work; Android may reclaim a backgrounded WebView process.
- Treat 2-10 MP as unmeasured, device-dependent territory and anything substantially larger as desktop/Tauri work.

These are engineering cautions, not measured Android thresholds.

## Debug signing

Tonight's APK is debug-signed only. `apksigner` reports one signer with certificate `CN=Android Debug`; v1 and v2 signatures verify. Gradle creates/uses the standard local debug keystore, normally `~/.android/debug.keystore`.

This APK is not suitable for distribution: the debug certificate is not a release identity and must not be treated as one. No release keystore, Play Store key, or signing secret is present in the repository. Release signing is deliberately out of scope.

## Verification performed

```bash
export JAVA_HOME=/home/box/Android/jdk17
export PATH="$JAVA_HOME/bin:$PATH"

npm run build
npx tsc --noEmit
npm run test:browser
npm run android:build

sha256sum dist-apk/tiphys-debug.apk
/home/box/Android/sdk/build-tools/34.0.0/aapt dump badging dist-apk/tiphys-debug.apk
/home/box/Android/sdk/build-tools/34.0.0/apksigner verify --verbose --print-certs dist-apk/tiphys-debug.apk
```

The APK archive contains `index.html`, relative asset paths, the MapLibre worker, both WASM payloads, and the WASM catalog. Browser tests cover local GeoJSON/GeoTIFF rendering after switching to the tile-free style.

## NOT_TESTED

- Installation, cold start, rotation, touch UI, and performance on a physical Android device or emulator.
- WebView WebGL/WASM behavior across Android API levels and System WebView versions. `minSdk 22` is only the manifest floor; a current updatable System WebView is expected.
- Android document-picker import and Blob download/export behavior.
- Airplane-mode cold start inside the APK (the equivalent tile-free/local-layer path is covered in Chromium, not the Android WebView).
- OOM thresholds, memory profiling, background/foreground recovery, and large-raster jobs on Android.
- Release signing, store packaging, iOS, native GIS, and Play Store policy work.

No emulator/device was available on the Linux box, so this is a buildable, statically verified debug shell rather than an on-device acceptance result.

## Manual check for updates（检查更新）

The Capacitor APK does **not** auto-update. Users tap **设置 → 关于与诊断 →「下载 Android APK」** (always visible on web and native) or **检查更新** (native compares `version.json`).

### How it works

1. Server hosts `https://tiphys.xyz/version.json` (CORS + short Cache-Control via nginx snippet; native fetch uses `CapacitorHttp`) (copied from `public/version.json` on every `npm run deploy:xyz`).
2. The app fetches that JSON with a cache-bust query, compares `versionCode` (then `version`) to the local app via `@capacitor/app` `App.getInfo()` (bundled fallback `0.1.3` / code `4` if the plugin is missing).
3. Up to date → toast 「已是最新」. Newer → show notes + 「下载更新」, which opens `apkUrl` with `@capacitor/browser` (falls back to `window.open` / navigation).
4. Web tiphys.xyz shows the same button but replies politely that the feature is for the Android app (no forced install).

### `version.json` shape

```json
{
  "version": "0.1.3",
  "versionCode": 4,
  "apkUrl": "https://tiphys.xyz/apk/tiphys-0.1.3.apk",
  "notes": "变更说明（可选）"
}
```

### Shipping a new APK

1. Bump `versionName` / `versionCode` in `android/app/build.gradle` (and keep `package.json` / `public/version.json` / `BUNDLED_*` in `src/lib/appUpdate.ts` in sync for the web fallback).
2. `npm run android:build` → `dist-apk/tiphys-debug.apk`.
3. Upload the APK to the origin (survives SPA deploys; deploy scripts protect `/apk/`):

   ```bash
   # example — after ssh/rsync auth is configured
   # Prefer versioned filename to bust Cloudflare max-age=14400 on /apk/
   sshpass -e scp -i "$KEY" dist-apk/tiphys-debug.apk eznine@20.214.241.113:/tmp/tiphys-0.1.3.apk
   sshpass -e ssh -i "$KEY" eznine@20.214.241.113 \
     "printf '%s\n' \"$PASSWORD\" | sudo -S mkdir -p /srv/tiphys-web/apk && \
      printf '%s\n' \"$PASSWORD\" | sudo -S cp /tmp/tiphys-0.1.3.apk /srv/tiphys-web/apk/tiphys-0.1.3.apk && \
      printf '%s\n' \"$PASSWORD\" | sudo -S cp /tmp/tiphys-0.1.3.apk /srv/tiphys-web/apk/tiphys.apk"
   ```

4. Edit `public/version.json` (`version`, `versionCode`, `notes`, `apkUrl` if the filename changed).
5. `npm run build && npm run deploy:xyz` so the new `version.json` is live.

Plugins used: `@capacitor/app`, `@capacitor/browser`, `@capacitor/keyboard` (Capacitor 6). Run `npx cap sync android` (or `npm run android:build`) after install so the next APK embeds them.
