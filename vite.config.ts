import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;
// Capacitor serves the bundled SPA from its local WebView origin. Relative
// asset URLs keep workers and the WASM payload independent of that origin.
const capacitor = process.env.CAPACITOR === "1";
// Tauri desktop also loads from its own custom-protocol origin → relative base.
const desktop = Boolean(process.env.TAURI_ENV_PLATFORM) || process.env.TIPHYS_DESKTOP === "1";
// Web build is served at https://tiphys.xyz/tiphys/ (root "/" is the separate landing page).
const webBase = process.env.TIPHYS_WEB_BASE || "/tiphys/";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: capacitor || desktop ? "./" : command === "serve" ? "/" : webBase,
  plugins: [react()],
  build: { license: { fileName: "licenses/frontend.md" } },
  // maplibre-gl v6 loads its module worker relative to its own file; pre-bundling breaks that URL.
  optimizeDeps: { exclude: ["maplibre-gl", "geolibre-wasm"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    ...(process.env.VITE_FS_ALLOW ? { fs: { allow: [process.cwd(), process.env.VITE_FS_ALLOW] } } : {}),
    proxy: {
      // Optional: fetch('/engine/ping') → Python sidecar
      "/engine": {
        target: "http://127.0.0.1:8971",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/engine/, ""),
      },
    },
  },
}));
