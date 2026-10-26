# Android APK (Capacitor debug)

Status: **offline-capable debug prototype**. Ship builds that users install over each other must use the **same debug signing cert**.

## Current ship (0.1.4 / versionCode 5)

- App id `xyz.tiphys.app`, label `TIPHYS`, version **0.1.4** (versionCode **5**).
- Published: `https://tiphys.xyz/apk/tiphys-0.1.4.apk` (also mirrored as `tiphys.apk`).
- Check-update polls **`https://tiphys.xyz/version.json`** first (old 0.1.3 installs); falls back to `https://tiphys.xyz/tiphys/version.json`.
- Notes (Chinese): IME grace so tapping the composer opens the keyboard; fold UX kept. Installs **over** 0.1.3-brand when the cert matches.

## Signing — build release-candidate APKs on Windows

| Builder | Cert SHA-256 (fingerprint) | Use for |
|---|---|---|
| **Windows** (`DESKTOP-4O0NU9A`, debug keystore) | `efd833d2…c6db` | **Ship** — matches installed **0.1.3-brand**; in-place upgrade OK |
| Linux box | different (`aca4105b…` historically) | Local smoke only — would force uninstall |

**Always build ship APKs on Windows** so the debug key matches 0.1.3-brand. Box-signed APKs must not replace the public download unless the user accepts a reinstall.

Repo keeps `dist-apk/tiphys-debug.apk` in git (convention). After a Windows ship build, copy that APK onto the box and commit so both machines share the same binary.

### Windows JDK 17

Windows `JAVA_HOME` may point at JDK 8. For Gradle / Android, use JDK 17 for the session only, e.g. Android Studio JBR or Corretto 17:

```powershell
# Examples — pick an existing install:
# $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
# $env:JAVA_HOME = "C:\Program Files\Amazon Corretto\jdk17.0.21_9"
$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
java -version   # must show 17.x
npm run android:build
```

Verify before upload:

```powershell
# aapt / apksigner from Android build-tools
aapt dump badging dist-apk\tiphys-debug.apk | findstr version
apksigner verify --print-certs dist-apk\tiphys-debug.apk
# Expect versionName=0.1.4 versionCode=5 and cert SHA-256 starting efd833d2
```

## Build (both OSes)

```bash
npm run android:build
# → CAPACITOR=1 vite build (base ./) + cap sync + assembleDebug
# → copies to dist-apk/tiphys-debug.apk
```

Toolchain: Node 20+, JDK **17**, Android SDK platform 34 / build-tools 34. Keep SDK/JDK outside the git tree. `android/local.properties` is gitignored.

Install:

```bash
adb install -r dist-apk/tiphys-debug.apk
```

## Debug signing notes

Ship builds are still **debug-signed** (`CN=Android Debug`). Not for Play Store. No release keystore is in the repo. The important constraint is **cert continuity** with whatever users already have installed (currently the Windows debug cert above).

```bash
apksigner verify --verbose --print-certs dist-apk/tiphys-debug.apk
sha256sum dist-apk/tiphys-debug.apk
```

## Check for updates

`src/lib/appUpdate.ts`:

1. Prefers root `https://tiphys.xyz/version.json` (BUNDLED/DEFAULT URL used by installed 0.1.3).
2. Falls back to `https://tiphys.xyz/tiphys/version.json` if root fails.
3. Compares `versionCode` then `version` to `@capacitor/app` / bundled `0.1.4` / code `5`.
4. On native, uses `CapacitorHttp` (bypasses WebView CORS).

`public/version.json` example:

```json
{
  "version": "0.1.4",
  "versionCode": 5,
  "apkUrl": "https://tiphys.xyz/apk/tiphys-0.1.4.apk",
  "notes": "…"
}
```

Deploy both copies with `npm run upload:apk` (see `docs/DEPLOY_TIPHYS_XYZ.md`). Nginx snippet adds CORS + short cache for `/version.json` and `/apk/`.

## Publish checklist

1. Bump version in Capacitor/`appUpdate`/`public/version.json` as needed.
2. **On Windows + JDK 17:** `npm run android:build`.
3. Verify versionCode + cert `efd833d2…`.
4. `npm run upload:apk -- dist-apk/tiphys-0.1.4.apk` (or debug path; script uses `apkUrl` basename).
5. Confirm `https://tiphys.xyz/version.json` and `/tiphys/version.json` show the new version; APK URL returns 200.
6. Copy APK to box `dist-apk/tiphys-debug.apk` and commit if shipping that binary in git.

## Out of scope

Release signing, Play Store, iOS, native GIS engines.
