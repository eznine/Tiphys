/**
 * Browser-agent view of the shared task-class budgets. The decision logic lives
 * in shared/contracts/budget.ts so the desktop loop cannot drift back to a
 * private fixed cap.
 */
export {
  DEFAULT_BUDGET,
  budgetVerdict,
  classifyTask,
  contextBudget,
  taskBudget,
  type BudgetLimits,
  type BudgetState,
  type BudgetVerdict,
  type TaskClass,
} from "../../../shared/contracts/budget.ts";
