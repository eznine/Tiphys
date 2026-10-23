/** Package existing runtimes; GIS stays in the maintained Python libraries. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "src-tauri/runtime");
if (process.platform !== "win32") throw new Error("Build Windows runtime resources on Windows");
await fs.mkdir(runtime, { recursive: true });
let agentBundle;
try {
  agentBundle = await build({ entryPoints: [path.join(root, "agent/src/server.ts")], bundle: true, metafile: true, platform: "node", format: "esm", target: "node24",
    outfile: path.join(runtime, "agent.mjs"), banner: { js: 'import { createRequire as __tiphysRequire } from "node:module"; const require = __tiphysRequire(import.meta.url);' } });
} finally { stop(); }
// Bundling removes package directories, so carry their original notices separately.
const packages = new Set();
for (const input of Object.keys(agentBundle.metafile.inputs)) {
  if (!input.includes("node_modules")) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name && metadata.version) { packages.add(directory); break; }
    } catch { /* Some dist folders have only a module-type marker. */ }
    directory = path.dirname(directory);
  }
}
const jsNotices = [];
for (const directory of packages) {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  const destination = path.join(runtime, "licenses/javascript", `${metadata.name.replace(/[^\w.-]/g, "_")}-${metadata.version}`);
  await fs.mkdir(destination, { recursive: true });
  const files = (await fs.readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\b|[._-])/i.test(name));
  for (const name of files) await fs.cp(path.join(directory, name), path.join(destination, name), { recursive: true });
  jsNotices.push({ name: metadata.name, version: metadata.version, license: metadata.license, files });
}
await fs.writeFile(path.join(runtime, "licenses/javascript/index.json"), JSON.stringify(jsNotices, null, 2));
await fs.cp(path.join(root, "docs/licenses"), path.join(runtime, "licenses/adapted-sources"), { recursive: true });
await fs.copyFile(process.execPath, path.join(runtime, "node.exe"));
await fs.cp(path.join(root, "samples"), path.join(runtime, "samples"), { recursive: true });
await fs.copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(runtime, "THIRD_PARTY_NOTICES.md"));
const cache = path.join(root, ".tooling/cache");
await fs.mkdir(cache, { recursive: true });
const nodeLicense = path.join(cache, `node-${process.version}-LICENSE`);
try { await fs.access(nodeLicense); }
catch {
  let license;
  for (const url of [`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
    `https://cdn.jsdelivr.net/gh/nodejs/node@${process.version}/LICENSE`]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.slice(0, 2000).includes("Node.js is licensed")) { license = text; break; }
    } catch { /* Try the tagged upstream file through the CDN. */ }
  }
  if (!license) throw new Error("Unable to collect the Node distribution license; cache its upstream LICENSE before building offline");
  await fs.writeFile(nodeLicense, license);
}
await fs.copyFile(nodeLicense, path.join(runtime, "NODE-LICENSE.txt"));
// A clean build environment prevents unrelated Conda Qt/scientific packages entering the app.
const python = path.join(root, "engine/.venv-build/Scripts/python.exe");
const base = execFileSync(python, ["-c", "import sys; print(sys.base_prefix)"], { encoding: "utf8", windowsHide: true }).trim();
const libraryBin = path.join(base, "Library/bin");
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH";
env[pathKey] = `${libraryBin}${path.delimiter}${env[pathKey] || ""}`;
const args = ["-m", "PyInstaller", "--clean", "--noconfirm", "--onedir", "--name", "tiphys-engine", "--distpath", runtime,
  "--workpath", path.join(root, "engine/build"), "--specpath", path.join(root, "engine/build"),
  "--collect-all", "pyogrio", "--collect-all", "pyproj", "--collect-data", "mcp", "--copy-metadata", "mcp",
  "--exclude-module", "matplotlib", "--exclude-module", "IPython", "--exclude-module", "pytest",
  "--exclude-module", "torch", "--exclude-module", "tkinter", path.join(root, "engine/launcher.py")];
await new Promise((resolve, reject) => {
  const child = spawn(python, args, { cwd: root, env, windowsHide: true, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Engine packaging failed (${code})`)));
});
execFileSync(python, [path.join(root, "scripts/collect-licenses.py"), path.join(runtime, "licenses")], { windowsHide: true });
await fs.writeFile(path.join(runtime, "runtime.json"), JSON.stringify({ node: process.version, builtAt: new Date().toISOString(), platform: process.platform, arch: process.arch }, null, 2));
