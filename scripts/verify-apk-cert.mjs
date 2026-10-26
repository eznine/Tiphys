#!/usr/bin/env node
/**
 * Verify an APK is signed with the canonical TIPHYS cert before upload/ship.
 * Canonical SHA-256 (Windows debug key reused as ship key):
 *   efd833d24fa5151dc24ba5be200d0c48fb09a91271cdeaf583a6ff09e1fec6db
 * Never prints private key material — fingerprint only.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CANONICAL_CERT_SHA256 =
  "efd833d24fa5151dc24ba5be200d0c48fb09a91271cdeaf583a6ff09e1fec6db";

function findApksigner() {
  const env = process.env;
  const home = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "";
  const candidates = [];
  if (home) {
    for (const ver of ["34.0.0", "35.0.0", "33.0.2"]) {
      candidates.push(
        path.join(home, "build-tools", ver, process.platform === "win32" ? "apksigner.bat" : "apksigner"),
      );
    }
  }
  if (process.platform === "win32") {
    candidates.push("F:\\tooling\\android\\sdk\\build-tools\\34.0.0\\apksigner.bat");
  } else {
    candidates.push(path.join(process.env.HOME || "", "Android/sdk/build-tools/34.0.0/apksigner"));
  }
  return candidates.find(p => p && existsSync(p)) || null;
}

export function readApkCertSha256(apkPath) {
  const apksigner = findApksigner();
  if (!apksigner) throw new Error("apksigner not found (set ANDROID_HOME / install build-tools 34)");
  const r = spawnSync(apksigner, ["verify", "--print-certs", apkPath], {
    encoding: "utf8",
    env: process.env,
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.status !== 0) throw new Error(`apksigner failed:\n${out}`);
  const m = out.match(/SHA-256 digest:\s*([0-9a-fA-F:]+)/);
  if (!m) throw new Error(`Could not parse cert SHA-256 from apksigner output`);
  return m[1].replace(/:/g, "").toLowerCase();
}

export function assertCanonicalCert(apkPath) {
  const got = readApkCertSha256(apkPath);
  if (got !== CANONICAL_CERT_SHA256) {
    throw new Error(
      `APK cert SHA-256 mismatch.\n  got:      ${got}\n  expected: ${CANONICAL_CERT_SHA256}\n` +
        `Refuse to ship. Build on Windows with F:\\tooling\\signing\\tiphys-canonical.keystore ` +
        `(or place the same keystore at ~/.config/tiphys/signing/ + keystore.properties).`,
    );
  }
  return got;
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  const apk = process.argv[2];
  if (!apk) {
    console.error("Usage: node scripts/verify-apk-cert.mjs <apk>");
    process.exit(2);
  }
  try {
    const fp = assertCanonicalCert(apk);
    console.log(`OK cert SHA-256 ${fp}`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
