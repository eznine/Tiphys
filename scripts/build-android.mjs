import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const android = path.join(root, "android");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(android)) {
  throw new Error("android/ is missing. Run npx cap add android once, then retry.");
}

run("npm", ["run", "build"], { env: { ...process.env, CAPACITOR: "1" } });
run(npx, ["cap", "sync", "android"]);

const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
run(gradle, ["assembleDebug"], { cwd: android });

const debugDir = path.join(android, "app", "build", "outputs", "apk", "debug");
if (!existsSync(debugDir)) throw new Error(`Gradle did not produce ${debugDir}`);
const apkName = readdirSync(debugDir).find(name => name.endsWith(".apk"));
if (!apkName) throw new Error(`No debug APK found in ${debugDir}`);

const source = path.join(debugDir, apkName);
const targetDir = path.join(root, "dist-apk");
const target = path.join(targetDir, "tiphys-debug.apk");
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`\nAPK: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MiB)`);
