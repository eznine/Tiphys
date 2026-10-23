export type GeeAuthStatus = {
  connected: boolean;
  status: "not_configured" | "configured_unverified" | "demo" | "connected" | string;
  project: string | null;
  hasToken: boolean;
  hasServiceAccount: boolean;
  hint: string;
  demo: boolean;
  auth_method?: "token" | "service_account" | null;
  verified?: boolean;
  message?: string;
};

/** Local status tools remain usable while disconnected; live data tools do not. */
export function geeExecutionAllowed(toolName: string, status: GeeAuthStatus | null | undefined): boolean {
  if (!toolName.startsWith("gee_")) return true;
  if (toolName === "gee_auth_status" || toolName === "gee_job_status") return true;
  return Boolean(status?.connected || status?.demo);
}
