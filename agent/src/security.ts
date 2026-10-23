import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TIPHYS_DIR } from "./config.js";

export const allowedOrigins = new Set([
  "http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost",
  "http://tauri.localhost", "https://tauri.localhost",
]);

function loadToken() {
  if (process.env.TIPHYS_SERVICE_TOKEN) return process.env.TIPHYS_SERVICE_TOKEN;
  fs.mkdirSync(TIPHYS_DIR, { recursive: true });
  const file = path.join(TIPHYS_DIR, "service-token");
  try { fs.writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (err: any) { if (err.code !== "EEXIST") throw err; }
  const value = fs.readFileSync(file, "utf8").trim();
  if (value.length < 32) throw new Error("Invalid local service token");
  return value;
}

export const serviceToken = loadToken();
export function authorized(value: string | undefined) {
  const actual = Buffer.from(value ?? "");
  const expected = Buffer.from(serviceToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
