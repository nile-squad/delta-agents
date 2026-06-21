/**
 * Pure arithmetic over Cost values.
 *
 * Kept as pure functions so governance math (Kalman, friction detection)
 * can operate on costs without mutating task state.
 */

import type { Cost } from "./types";

/** A cost of zero — the starting point for any accumulator. */
export const zeroCost = (): Cost => ({ tokens: 0, durationMs: 0 });

/**
 * Combine two cost measurements into a single total.
 *
 * The optional axes (memory, latency) are only included in the result when at
 * least one operand carries them — so adding two plain { tokens, durationMs }
 * costs yields a plain { tokens, durationMs } cost (no spurious zero axes).
 */
export const addCosts = (a: Cost, b: Cost): Cost => {
  const result: Cost = { tokens: a.tokens + b.tokens, durationMs: a.durationMs + b.durationMs };
  if (a.memory !== undefined || b.memory !== undefined) result.memory = (a.memory ?? 0) + (b.memory ?? 0);
  if (a.latency !== undefined || b.latency !== undefined) result.latency = (a.latency ?? 0) + (b.latency ?? 0);
  return result;
};

/**
 * True when `spent` exceeds `budget` on any dimension the budget constrains.
 * Tokens and time are always enforced. Memory and latency are enforced only when
 * the budget declares a limit for that axis — an undeclared axis is unlimited,
 * never zero (so a memory cost does not "overflow" a budget that ignores memory).
 */
export const isOverBudget = (spent: Cost, budget: Cost): boolean =>
  spent.tokens > budget.tokens ||
  spent.durationMs > budget.durationMs ||
  (budget.memory !== undefined && (spent.memory ?? 0) > budget.memory) ||
  (budget.latency !== undefined && (spent.latency ?? 0) > budget.latency);

/**
 * Remaining headroom after `spent` is deducted from `total`. Clamps to zero.
 * Memory/latency headroom is reported only when `total` declares that axis.
 */
export const remainingCost = (total: Cost, spent: Cost): Cost => {
  const result: Cost = {
    tokens: Math.max(0, total.tokens - spent.tokens),
    durationMs: Math.max(0, total.durationMs - spent.durationMs),
  };
  if (total.memory !== undefined) result.memory = Math.max(0, total.memory - (spent.memory ?? 0));
  if (total.latency !== undefined) result.latency = Math.max(0, total.latency - (spent.latency ?? 0));
  return result;
};

/**
 * Fraction of budget consumed on each axis. Used by friction detection to
 * measure consumption-to-progress ratio (spec §Cost Friction Detection).
 */
export const costRatio = (spent: Cost, budget: Cost): { tokens: number; durationMs: number } => ({
  tokens: budget.tokens === 0 ? 0 : spent.tokens / budget.tokens,
  durationMs: budget.durationMs === 0 ? 0 : spent.durationMs / budget.durationMs,
});
