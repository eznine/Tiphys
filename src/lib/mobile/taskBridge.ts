/** Pure translation between engine/agent events and the mobile task ledger. */
import type { TaskOutput, TaskStatus, TaskStep, ValidationCheck } from "./taskStore";

export function newTaskId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function mapJobStatus(status: string): { status: TaskStatus; stage: string } {
  switch (status) {
    case "queued": return { status: "queued", stage: "排队中，等待计算槽位" };
    case "running": return { status: "running", stage: "正在执行" };
    case "cancelling": return { status: "running", stage: "正在取消" };
    case "completed": return { status: "validating", stage: "执行结束，正在验证成果" };
    case "failed": return { status: "failed", stage: "执行失败" };
    case "cancelled": return { status: "cancelled", stage: "已取消" };
    case "interrupted": return { status: "interrupted", stage: "执行已中断" };
    default: return { status: "running", stage: status };
  }
}

export function outputsFromToolResult(result: Record<string, any> | null | undefined): TaskOutput[] {
  if (!result) return [];
  const out: TaskOutput[] = [];
  const push = (layer: any) => {
    if (layer && typeof layer.id === "string") out.push({ layerId: layer.id, name: String(layer.name ?? layer.id), kind: layer.kind });
  };
  push(result.layer);
  if (Array.isArray(result.layers)) for (const item of result.layers) push(item?.layer ?? item);
  if (!out.length && (result.path || result.download_url)) {
    const raw = String(result.path ?? "导出结果");
    const name = raw.split(/[\\/]/).pop() || raw;
    out.push({ name, path: result.path ? String(result.path) : undefined, url: result.download_url ? String(result.download_url) : undefined });
  }
  if (!out.length && Array.isArray(result.artifacts)) {
    for (const item of result.artifacts) {
      if (item?.url) out.push({ name: String(item.name ?? "产物"), url: String(item.url), path: item.path ? String(item.path) : undefined });
    }
  }
  return out;
}

export type PlanSummary = {
  ok?: boolean;
  run_id?: string;
  status?: string;
  headline?: string;
  deliverables?: { stepId: string; layerId: string; name: string }[];
  blocked_at?: { stepId: string; label: string; errorClass: string; message: string; next: string[] } | null;
  steps?: {
    stepId: string; label: string; phase: string; durationMs?: number | null;
    outputLayer?: { id: string; name: string } | null;
    error?: { class: string; message: string } | null;
    acceptance?: { type: string; ok: boolean; detail: string }[] | null;
  }[];
  plan_issues?: { stepId: string | null; class: string; message: string }[];
};

export function planStepsFromPlan(plan: { steps?: { id: string; title?: string; kind?: string }[] } | null | undefined): TaskStep[] {
  if (!plan?.steps?.length) return [];
  return plan.steps.map(step => ({ id: step.id, label: step.title ?? step.id, status: "pending" }));
}

export function applyPlanSummary(summary: PlanSummary): { steps: TaskStep[]; checks: ValidationCheck[]; outputs: TaskOutput[]; status: TaskStatus; stage: string } {
  const steps: TaskStep[] = (summary.steps ?? []).map(step => ({
    id: step.stepId,
    label: step.label,
    status: step.phase === "pass" || step.phase === "noop" ? "done" : step.phase === "fail" ? "failed" : step.phase === "skipped" || step.phase === "cancelled" ? "skipped" : "pending",
    detail: step.error ? `${step.error.class}: ${step.error.message}` : step.acceptance?.length ? step.acceptance.map(item => `${item.ok ? "✓" : "✗"} ${item.detail}`).join("；") : undefined,
  }));
  const checks: ValidationCheck[] = [];
  for (const step of summary.steps ?? []) {
    for (const item of step.acceptance ?? []) {
      checks.push({ label: `验收断言 · ${step.label}`, ok: item.ok, evidence: item.detail });
    }
  }
  const outputs: TaskOutput[] = (summary.deliverables ?? []).map(item => ({ layerId: item.layerId, name: item.name }));
  for (const step of summary.steps ?? []) {
    if (step.outputLayer && !outputs.some(item => item.layerId === step.outputLayer!.id)) {
      outputs.push({ layerId: step.outputLayer.id, name: step.outputLayer.name });
    }
  }
  const failedStep = steps.find(step => step.status === "failed");
  const blocked = summary.blocked_at;
  const status: TaskStatus = summary.status === "completed" ? "validating" : summary.status === "cancelled" ? "cancelled" : "failed";
  const stage = summary.status === "completed"
    ? "执行结束，正在验证成果"
    : blocked
      ? `在「${blocked.label}」停止：${blocked.message}`
      : failedStep?.detail ?? (summary.status === "cancelled" ? "计划已取消" : "计划失败");
  return { steps, checks, outputs, status, stage };
}

export function planIssueChecks(summary: PlanSummary): ValidationCheck[] {
  return (summary.plan_issues ?? []).map(issue => ({
    label: "计划校验",
    ok: false,
    evidence: `${issue.class}${issue.stepId ? ` @${issue.stepId}` : ""}：${issue.message}`,
  }));
}
