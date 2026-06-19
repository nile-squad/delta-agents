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

  // Cost ratio: average of token and duration axes.
  const tokenRatio = budget.tokens <= 0 ? 0 : spent.tokens / budget.tokens;
  const durationRatio = budget.durationMs <= 0 ? 0 : spent.durationMs / budget.durationMs;
  const avgCostRatio = (tokenRatio + durationRatio) / 2;

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
