/**
 * Turn budgets for the browser agent (roadmap §3.4, implemented in stage 4
 * after the M09/M11 baseline findings: the static 8-step cap was eaten by tool
 * search while the model still had a viable path).
 *
 * Four dimensions per the roadmap: tool steps, wall time, context tokens
 * (and, through context, cost). Pure functions: the agent loop supplies live
 * measurements, this module only decides and explains. Every stop is honest:
 * it names the exhausted dimension and says what is already deliverable.
 */

export type BudgetLimits = {
  /** Hard cap on tool-call steps in one turn (search included). */
  maxToolSteps: number;
  /** Wall-clock budget for one turn. */
  maxTurnMs: number;
  /** Context budget in estimated tokens; 0 disables the check. */
  maxContextTokens: number;
};

export const DEFAULT_BUDGET: BudgetLimits = {
  maxToolSteps: 24,
  maxTurnMs: 8 * 60_000,
  maxContextTokens: 0,
};

/** Derives the context budget from the configured window (85% headroom rule). */
export function contextBudget(contextWindow: number): number {
  return Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow * 0.85) : 0;
}

export type BudgetState = {
  toolSteps: number;
  elapsedMs: number;
  estimatedTokens: number;
};

export type BudgetVerdict =
  | { stop: false }
  | { stop: true; dimension: "context" | "time" | "steps"; reason: string; advice: string };

/**
 * Priority: context > time > steps. Context is the hard constraint (overflow
 * breaks the next request); time protects the user's patience; steps is the
 * most permissive because legitimate tool chains are long.
 */
export function budgetVerdict(state: BudgetState, limits: BudgetLimits): BudgetVerdict {
  if (limits.maxContextTokens > 0 && state.estimatedTokens > limits.maxContextTokens) {
    return {
      stop: true,
      dimension: "context",
      reason: `上下文预算接近上限（约 ${state.estimatedTokens} / ${limits.maxContextTokens} tokens），继续会丢失早期信息。`,
      advice: "已有成果与图层已保留。请基于当前结果发起新消息继续，或让我先压缩历史。",
    };
  }
  if (limits.maxTurnMs > 0 && state.elapsedMs > limits.maxTurnMs) {
    return {
      stop: true,
      dimension: "time",
      reason: `本轮耗时 ${(state.elapsedMs / 1000).toFixed(0)} 秒，超过 ${(limits.maxTurnMs / 1000).toFixed(0)} 秒的时间预算。`,
      advice: "已完成步骤的图层与结论已保留；剩余步骤请在新消息中继续，长任务建议拆分。",
    };
  }
  if (limits.maxToolSteps > 0 && state.toolSteps >= limits.maxToolSteps) {
    return {
      stop: true,
      dimension: "steps",
      reason: `已达工具步数预算（${state.toolSteps}/${limits.maxToolSteps} 步，检索也计入）。`,
      advice: "已有成果已保留。若任务未完，请说明缺口，我会从现有图层继续而不是从头重跑。",
    };
  }
  return { stop: false };
}
