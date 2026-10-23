/** One owned process group for development; never reuse or terminate unrelated services. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
if (process.argv.includes("--mock")) env.TIPHYS_LLM_PROVIDER = "mock";
const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      if (process.platform === "win32") {
        await new Promise(resolve => { const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.once("exit", resolve); });
      } else child.kill("SIGTERM");
    }
  }
  process.exitCode = code;
}
function launch(exe, args) {
  const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: "inherit" });
  children.push(child);
  child.once("error", err => { console.error(err.message); void stop(1); });
  child.once("exit", code => { if (!stopping) void stop(code ?? 1); });
  return child;
}
async function ready(url, service, child) {
  const end = Date.now() + 30000;
  while (Date.now() < end && child.exitCode === null && !stopping) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok && (await response.json()).service === service) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${service} did not start; inspect its log above`);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  for (const port of [8971, 8972, 1420]) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once("error", () => reject(new Error(`Port ${port} is occupied; close that service before starting TIPHYS`))); probe.listen(port, "127.0.0.1", resolve); });
    await new Promise(resolve => probe.close(resolve));
  }
  const python = path.join(root, "engine/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!fs.existsSync(python)) throw new Error("Create engine/.venv and install engine/requirements.txt first");
  const engine = launch(python, ["-m", "uvicorn", "main:app", "--app-dir", "engine", "--host", "127.0.0.1", "--port", "8971"]);
  await ready("http://127.0.0.1:8971/ping", "tiphys-engine", engine);
  const agent = launch(process.execPath, ["--import", "./agent/node_modules/tsx/dist/loader.mjs", "agent/src/server.ts"]);
  await ready("http://127.0.0.1:8972/health", "tiphys-agent", agent);
  launch(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]);
} catch (err) { console.error(err.message); await stop(1); }
