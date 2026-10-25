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
  },
};

export default config;
