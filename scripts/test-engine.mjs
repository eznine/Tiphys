import { spawn } from "node:child_process";
const exe = process.platform === "win32" ? "engine/.venv/Scripts/python.exe" : "engine/.venv/bin/python";
const child = spawn(exe, ["-m", "unittest", "discover", "-s", "engine/tests", "-v"], { windowsHide: true, stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
child.once("error", err => { console.error(err.message); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
