import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "xyz.tiphys.app",
  appName: "TIPHYS",
  webDir: "dist",
  server: { androidScheme: "https" },
  plugins: {
    Keyboard: {
      // Help Android WebView report resize/hide even with overlay chrome.
      resizeOnFullScreen: true,
    },
    CapacitorHttp: {
      // Native HTTP for version.json etc. (also called explicitly via CapacitorHttp).
      enabled: true,
    },
    StatusBar: {
      // Immersive: WebView draws under the status bar; CSS safe-area pads chrome.
      overlaysWebView: true,
      style: "DARK",
      backgroundColor: "#00000000",
    },
  },
};

export default config;
