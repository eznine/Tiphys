/** Preserve original crate notices beside the redistributed desktop binary. */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--format-version", "1",
  "--filter-platform", "x86_64-pc-windows-msvc", "--manifest-path", "src-tauri/Cargo.toml"],
  { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node.dependencies]));
const included = new Set();
const pending = [metadata.resolve.root];
while (pending.length) {
  const id = pending.pop();
  if (included.has(id)) continue;
  included.add(id);
  pending.push(...(nodes.get(id) || []));
}
const target = path.resolve("src-tauri/runtime/licenses/rust");
await fs.mkdir(target, { recursive: true });
const index = [];
for (const pkg of metadata.packages) {
  if (!pkg.source || !included.has(pkg.id)) continue;
  const directory = path.dirname(pkg.manifest_path);
  const destination = path.join(target, `${pkg.name}-${pkg.version}`);
  await fs.mkdir(destination, { recursive: true });
  const files = (await fs.readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\b|[._-])/i.test(name));
  if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
  for (const name of files) await fs.cp(path.join(directory, name), path.join(destination, name), { recursive: true });
  index.push({ name: pkg.name, version: pkg.version, license: pkg.license, files });
}
await fs.writeFile(path.join(target, "index.json"), JSON.stringify(index, null, 2));
console.log(`Collected notices for ${index.length} Rust crates`);
