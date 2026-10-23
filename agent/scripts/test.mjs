import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "tiphys-tests-"));
const tests = fs.readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.ts")).map(name => path.join(root, "tests", name));
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...tests], {
      cwd: root, windowsHide: true, stdio: "inherit",
      env: { ...process.env, TIPHYS_STATE_DIR: state, TIPHYS_LLM_PROVIDER: "mock" },
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally {
  const resolved = fs.realpathSync(state);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir())) throw new Error("Refusing to clean up outside the test temporary directory");
  fs.rmSync(resolved, { recursive: true, force: true });
}
