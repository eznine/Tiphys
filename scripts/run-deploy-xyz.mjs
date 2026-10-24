import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const script = path.join(root, "scripts", isWin ? "deploy-tiphys-xyz.ps1" : "deploy-tiphys-xyz.sh");
const r = isWin
  ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { cwd: root, stdio: "inherit" })
  : spawnSync("bash", [script], { cwd: root, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
