/** Package a portable Windows zip from a finished release build (no installer, no admin rights). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src-tauri/target/release");
const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = config.version;
const runtime = path.join(root, "src-tauri/runtime");

if (process.platform !== "win32") throw new Error("Portable packaging targets Windows");
const exe = path.join(target, "tiphys.exe");
if (!fs.existsSync(exe)) throw new Error(`Run a release build first: ${exe} not found`);
if (!fs.existsSync(path.join(runtime, "node.exe"))) throw new Error(`Run npm run bundle:sidecars first: ${runtime} is incomplete`);

const bundleDir = path.join(target, "bundle/portable");
const payload = path.join(bundleDir, `TIPHYS-${version}-x64`);
const zipName = `TIPHYS-${version}-x64-portable.zip`;
fs.rmSync(payload, { recursive: true, force: true });
fs.mkdirSync(payload, { recursive: true });

fs.copyFileSync(exe, path.join(payload, "tiphys.exe"));
fs.cpSync(runtime, path.join(payload, "runtime"), { recursive: true });

// Cargo-registry license copies carry 1970 mtimes, below the zip timestamp
// floor (1980); PowerShell's Compress-Archive throws on those. Clamp all
// entries to now.
const clamp = entry => {
  fs.utimesSync(entry, new Date(), new Date());
  if (fs.statSync(entry).isDirectory()) for (const child of fs.readdirSync(entry)) clamp(path.join(entry, child));
};
clamp(payload);

const readme = `TIPHYS ${version} (portable, x64)

解压到任意目录后直接运行 tiphys.exe。无需安装、无需管理员权限。
Unzip anywhere and run tiphys.exe directly. No installer, no admin rights.

首次启动会创建用户数据目录 %APPDATA%\\com.tiphys.app（日志、工程、密钥），
删除本文件夹不会清除该目录；彻底卸载请手动删除它。

要求 Requirements:
  - Microsoft Edge WebView2 Runtime（Windows 11 / 近期 Windows 10 已自带；
    无法启动时从 https://developer.microsoft.com/microsoft-edge/webview2/ 安装）
  - 其余运行时（Node、空间引擎）已随包附带，无需系统 Python 或 Node。

端口 Ports: 引擎 127.0.0.1:8971，Agent 127.0.0.1:8972（与 GeoAgentPro 的 8765/8766 错开）。
便携版无自动更新；升级请下载新版 zip。
`;
fs.writeFileSync(path.join(payload, "README.txt"), readme, "utf8");

fs.rmSync(path.join(bundleDir, zipName), { force: true });
execFileSync("powershell",
  ["-NoProfile", "-Command", "Compress-Archive", "-Path", JSON.stringify(payload), "-DestinationPath", JSON.stringify(path.join(bundleDir, zipName)), "-CompressionLevel", "Optimal"],
  { stdio: "inherit" });
console.log(`Portable package created at ${path.join(bundleDir, zipName)}`);
