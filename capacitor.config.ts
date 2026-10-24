import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "xyz.tiphys.app",
  appName: "TIPHYS",
  webDir: "dist",
  server: { androidScheme: "https" },
};

export default config;
