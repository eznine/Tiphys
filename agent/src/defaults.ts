/**
 * Built-in default provider used only when no environment overrides, saved
 * settings or key-pool file exist. It makes a fresh install usable without a
 * first-run setup. Retire the shared trial credential by editing this file
 * (or set TIPHYS_BUILTIN_CREDENTIALS=off to disable it without a rebuild).
 */
export const BUILTIN_DEFAULT = {
  label: "TierFlow（内置测试）",
  baseURL: "https://tierflow.cn/v1",
  apiKey: "sk-56mQ6Zwa1GgjvFsScYSFaXByy8PK78s92ehOKdMRQw993N00",
  model: "tierflow_pro",
} as const;

/** Escape hatch for tests and for installs that must start unconfigured. */
export function builtinCredentialsEnabled(): boolean {
  const flag = process.env.TIPHYS_BUILTIN_CREDENTIALS?.trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(flag ?? "");
}
