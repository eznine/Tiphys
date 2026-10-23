import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const localCargo = path.resolve(".tooling/cargo");
const env = { ...process.env };
// Windows commonly exposes `Path`; a spread object no longer resolves it as `PATH`.
const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH";
if (fs.existsSync(path.join(localCargo, "bin", process.platform === "win32" ? "cargo.exe" : "cargo"))) {
  env.CARGO_HOME ||= localCargo;
  env.RUSTUP_HOME ||= path.resolve(".tooling/rustup");
  env[pathKey] = [path.join(localCargo, "bin"), path.dirname(process.execPath), env[pathKey] || ""].join(path.delimiter);
}
const stages = process.argv.includes("--dev") ? [["node_modules/@tauri-apps/cli/tauri.js", "dev"]] :
  [["node_modules/typescript/bin/tsc"], ["node_modules/vite/bin/vite.js", "build"], ["scripts/bundle-sidecars.mjs"], ["scripts/collect-rust-licenses.mjs"],
   ["node_modules/@tauri-apps/cli/tauri.js", "build", "--config", "src-tauri/tauri.bundle.conf.json"]];
for (const args of stages) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Build stage failed (${code})`)));
  });
}
