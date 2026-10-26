import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const script = path.join(root, "scripts", isWin ? "upload-apk-tiphys-xyz.ps1" : "upload-apk-tiphys-xyz.sh");
const extra = process.argv.slice(2);
const r = isWin
  ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...extra], { cwd: root, stdio: "inherit" })
  : spawnSync("bash", [script, ...extra], { cwd: root, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
