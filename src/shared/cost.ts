/**
 * Pure arithmetic over Cost values.
 *
 * Kept as pure functions so governance math (Kalman, friction detection)
 * can operate on costs without mutating task state.
 */

import type { Cost } from "./types";

/** A cost of zero — the starting point for any accumulator. */
export const zeroCost = (): Cost => ({ tokens: 0, durationMs: 0 });

/** Combine two cost measurements into a single total. */
export const addCosts = (a: Cost, b: Cost): Cost => ({
  tokens: a.tokens + b.tokens,
  durationMs: a.durationMs + b.durationMs,
});

/**
 * True when `spent` exceeds `budget` on any dimension.
 * Both token and time budgets must stay within bounds — either axis triggers.
 */
export const isOverBudget = (spent: Cost, budget: Cost): boolean =>
  spent.tokens > budget.tokens || spent.durationMs > budget.durationMs;

/** Remaining headroom after `spent` is deducted from `total`. Clamps to zero. */
export const remainingCost = (total: Cost, spent: Cost): Cost => ({
  tokens: Math.max(0, total.tokens - spent.tokens),
  durationMs: Math.max(0, total.durationMs - spent.durationMs),
});

/**
 * Fraction of budget consumed on each axis. Used by friction detection to
 * measure consumption-to-progress ratio (spec §Cost Friction Detection).
 */
export const costRatio = (spent: Cost, budget: Cost): { tokens: number; durationMs: number } => ({
  tokens: budget.tokens === 0 ? 0 : spent.tokens / budget.tokens,
  durationMs: budget.durationMs === 0 ? 0 : spent.durationMs / budget.durationMs,
});
