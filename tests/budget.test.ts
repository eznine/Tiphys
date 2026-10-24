/** Stage 4: turn budgets replace the static 8-step cap (M09/M11 finding). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetVerdict, contextBudget, DEFAULT_BUDGET } from "../src/lib/browser/budget.ts";

const limits = { maxToolSteps: 24, maxTurnMs: 60_000, maxContextTokens: 50_000 };

test("within budget keeps running", () => {
  assert.deepEqual(budgetVerdict({ toolSteps: 8, elapsedMs: 30_000, estimatedTokens: 20_000 }, limits), { stop: false });
});

test("steps budget fires with an honest, resumable message", () => {
  const verdict = budgetVerdict({ toolSteps: 24, elapsedMs: 30_000, estimatedTokens: 20_000 }, limits);
  assert.equal(verdict.stop, true);
  if (verdict.stop) {
    assert.equal(verdict.dimension, "steps");
    assert.match(verdict.reason, /24\/24/);
    assert.match(verdict.advice, /已保留|继续/);
  }
});

test("time budget fires before the step cap", () => {
  const verdict = budgetVerdict({ toolSteps: 5, elapsedMs: 90_000, estimatedTokens: 20_000 }, limits);
  assert.equal(verdict.stop && verdict.dimension, "time");
});

test("context budget wins over time and steps", () => {
  const verdict = budgetVerdict({ toolSteps: 30, elapsedMs: 90_000, estimatedTokens: 60_000 }, limits);
  assert.equal(verdict.stop && verdict.dimension, "context");
});

test("zero disables a dimension; context budget is 85% of the window", () => {
  assert.deepEqual(budgetVerdict({ toolSteps: 999, elapsedMs: 999_999, estimatedTokens: 0 }, { maxToolSteps: 0, maxTurnMs: 0, maxContextTokens: 0 }), { stop: false });
  assert.equal(contextBudget(64_000), 54_400);
  assert.equal(contextBudget(0), 0);
  assert.ok(DEFAULT_BUDGET.maxToolSteps >= 24, "the cap must be materially above the old static 8");
});
