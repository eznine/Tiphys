import { Capacitor } from "@capacitor/core";

/** Published on tiphys.xyz; APK builds compare against this (manual check only). */
export const VERSION_JSON_URL = "https://tiphys.xyz/version.json";

/** Bundled fallback when Capacitor App plugin is unavailable (web / pre-sync APK). */
export const BUNDLED_APP_VERSION = "0.1.2";
export const BUNDLED_VERSION_CODE = 3;

/** Always-available download (versioned to bust CDN). */
export const DEFAULT_APK_URL = "https://tiphys.xyz/apk/tiphys-0.1.2.apk";

export type RemoteVersionInfo = {
  version: string;
  versionCode: number;
  apkUrl: string;
  notes?: string;
};

export type LocalAppInfo = {
  version: string;
  versionCode: number;
  native: boolean;
};

export type UpdateCheckResult =
  | { status: "up-to-date"; local: LocalAppInfo; remote: RemoteVersionInfo }
  | { status: "update-available"; local: LocalAppInfo; remote: RemoteVersionInfo }
  | { status: "web-only"; local: LocalAppInfo; remote?: RemoteVersionInfo; message: string };

export function isCapacitorNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function parseVersionCode(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Compare dotted versions; returns >0 if a>b, <0 if a<b, 0 if equal / unparsable tie. */
export function compareSemver(a: string, b: string): number {
  const pa = a.trim().replace(/^v/i, "").split(/[.+-]/).map(p => Number.parseInt(p, 10) || 0);
  const pb = b.trim().replace(/^v/i, "").split(/[.+-]/).map(p => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function isRemoteNewer(remote: RemoteVersionInfo, local: LocalAppInfo): boolean {
  if (remote.versionCode !== local.versionCode) return remote.versionCode > local.versionCode;
  return compareSemver(remote.version, local.version) > 0;
}

export async function getLocalAppInfo(): Promise<LocalAppInfo> {
  if (isCapacitorNative()) {
    try {
      const { App } = await import("@capacitor/app");
      const info = await App.getInfo();
      return {
        version: info.version || BUNDLED_APP_VERSION,
        versionCode: parseVersionCode(info.build, BUNDLED_VERSION_CODE),
        native: true,
      };
    } catch {
      // Plugin not synced into this APK yet — fall back to bundled constants.
    }
  }
  return { version: BUNDLED_APP_VERSION, versionCode: BUNDLED_VERSION_CODE, native: isCapacitorNative() };
}

export async function fetchRemoteVersion(signal?: AbortSignal): Promise<RemoteVersionInfo> {
  const url = `${VERSION_JSON_URL}?t=${Date.now()}`;
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`无法获取版本信息（HTTP ${response.status}）`);
  const data = (await response.json()) as Partial<RemoteVersionInfo>;
  const version = typeof data.version === "string" ? data.version.trim() : "";
  const apkUrl = typeof data.apkUrl === "string" ? data.apkUrl.trim() : "";
  const versionCode = parseVersionCode(data.versionCode, 0);
  if (!version || !apkUrl || versionCode < 1) {
    throw new Error("version.json 格式无效（需要 version、versionCode、apkUrl）");
  }
  const notes = typeof data.notes === "string" ? data.notes.trim() : undefined;
  return { version, versionCode, apkUrl, notes: notes || undefined };
}

/**
 * Manual check-update for the Capacitor Android APK.
 * Web/browser: polite no-op (feature is for the native app).
 */
export async function checkForAppUpdate(signal?: AbortSignal): Promise<UpdateCheckResult> {
  const local = await getLocalAppInfo();
  if (!local.native) {
    return {
      status: "web-only",
      local,
      message: "检查更新仅适用于 Android 应用。请点下方「下载 Android APK」获取安装包。",
    };
  }
  const remote = await fetchRemoteVersion(signal);
  if (isRemoteNewer(remote, local)) {
    return { status: "update-available", local, remote };
  }
  return { status: "up-to-date", local, remote };
}

/** Open the APK URL via Capacitor Browser when available; otherwise system / window open. */
export async function openApkDownload(apkUrl: string): Promise<void> {
  if (isCapacitorNative()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url: apkUrl });
      return;
    } catch {
      // Fall through to window open.
    }
  }
  const opened = window.open(apkUrl, "_blank", "noopener,noreferrer");
  if (!opened) {
    window.location.assign(apkUrl);
  }
}
