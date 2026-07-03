/**
 * Cost friction detection.
 *
 * Measures resource consumption against state advancement. High consumption
 * with low advancement indicates instability: infinite loops, retry storms,
 * or reasoning spirals (spec §Cost Friction Detection).
 *
 * The friction ratio is:
 *   frictionRatio = costRatio / progressRatio
 *
 * Where costRatio = spent / budget and progressRatio = completed / total.
 * A ratio of 1.0 means perfectly proportional — we are spending exactly as
 * much as we are advancing. Above FRICTION_THRESHOLD, execution may be
 * terminated or escalated.
 *
 * Edge cases:
 * - Zero progress with non-zero cost → frictionRatio is effectively infinite;
 *   capped to FRICTION_CAP for arithmetic safety, always flagged as unstable.
 * - Zero cost with any progress → frictionRatio = 0; always stable.
 * - Zero cost with zero progress → no information; not flagged as unstable.
 */

import type { Cost } from "../shared/types";
import type { FrictionSignal } from "./types";
import { FRICTION_THRESHOLD } from "./types";

const FRICTION_CAP = 10;

/**
 * Detect cost friction for a task.
 *
 * spent:         cost consumed so far.
 * budget:        total cost budget for the task.
 * progressRatio: fraction of work that has been completed [0, 1].
 *                Caller derives this from completed phases / total phases, or
 *                completed actions / total expected actions.
 */
export const detectFriction = ({
  spent,
  budget,
  progressRatio,
}: {
  spent: Cost;
  budget: Cost;
  progressRatio: number;
}): FrictionSignal => {
  const clampedProgress = Math.max(0, Math.min(1, progressRatio));

  // Cost ratio: average over every axis the budget declares. tokens and
  // durationMs are always present; memory and latency are scored only when the
  // budget sets a limit for them. This mirrors isOverBudget/remainingCost: an
  // undeclared axis is unlimited, never treated as zero, so it does not dilute
  // the ratio. A budget of just { tokens, durationMs } scores exactly those two.
  const axisRatio = (spentValue: number, budgetValue: number | undefined): number | undefined => {
    if (budgetValue === undefined) return undefined; // axis not declared, not enforced
    if (budgetValue <= 0) return 0;
    return spentValue / budgetValue;
  };
  const ratios = [
    axisRatio(spent.tokens, budget.tokens),
    axisRatio(spent.durationMs, budget.durationMs),
    axisRatio(spent.memory ?? 0, budget.memory),
    axisRatio(spent.latency ?? 0, budget.latency),
  ].filter((ratio): ratio is number => ratio !== undefined);
  const avgCostRatio = ratios.length === 0 ? 0 : ratios.reduce((sum, r) => sum + r, 0) / ratios.length;

  // No cost spent yet — nothing to detect.
  if (avgCostRatio <= 0) {
    return { frictionRatio: 0, isUnstable: false };
  }

  // Progress is zero but cost is non-zero — stuck with spending.
  if (clampedProgress <= 0) {
    return {
      frictionRatio: FRICTION_CAP,
      isUnstable: true,
      reason: `cost consumed (ratio ${avgCostRatio.toFixed(2)}) with no measurable progress — possible loop or stall`,
    };
  }

  const frictionRatio = Math.min(FRICTION_CAP, avgCostRatio / clampedProgress);
  const isUnstable = frictionRatio >= FRICTION_THRESHOLD;

  return {
    frictionRatio,
    isUnstable,
    reason: isUnstable
      ? `cost ratio ${avgCostRatio.toFixed(2)} vs progress ${clampedProgress.toFixed(2)} (friction ${frictionRatio.toFixed(2)}x) — possible instability`
      : undefined,
  };
};
