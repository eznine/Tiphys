import { Capacitor } from "@capacitor/core";

/** Edge-to-edge StatusBar so WebView (map/chat) draws under the system bar; chrome uses safe-area CSS. */
export async function initNativeShell(theme: "light" | "dark" = "light"): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setBackgroundColor({ color: "#00000000" });
    // Capacitor: Style.Dark = dark icons (light UI); Style.Light = light icons (dark UI).
    await StatusBar.setStyle({ style: theme === "dark" ? Style.Light : Style.Dark });
  } catch {
    // Plugin missing in web / older APK — CSS safe-area still applies when insets exist.
  }
}

export async function syncNativeStatusBar(theme: "light" | "dark"): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: theme === "dark" ? Style.Light : Style.Dark });
  } catch {
    /* ignore */
  }
}
