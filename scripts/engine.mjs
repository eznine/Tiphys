// Cross-platform engine launcher: uses engine/.venv (Windows: Scripts\python.exe, else bin/python).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venv = path.join(root, "engine", ".venv");
const py = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
const exe = fs.existsSync(py) ? py : process.platform === "win32" ? "python" : "python3";
const port = process.env.TIPHYS_ENGINE_PORT || "8971";
const p = spawn(exe, ["-m", "uvicorn", "main:app", "--app-dir", "engine", "--host", "127.0.0.1", "--port", port], { cwd: root, windowsHide: true, stdio: "inherit" });
p.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
p.on("exit", (c) => { process.exitCode = c ?? 1; });
