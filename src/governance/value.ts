/**
 * Bellman value and Model Predictive Control horizon.
 *
 * Every path, retry, escalation, and delegation decision is evaluated as
 * immediate cost plus expected future cost (spec §Bellman Optimization).
 * Prediction uses a receding horizon — the engine evaluates a finite future
 * trajectory before allowing an action, and stops at epistemic boundaries
 * (spec §Model Predictive Control, prohibition 14).
 *
 * Epistemic boundary: any point where prediction requires information the
 * engine does not currently have (external data, memory retrieval, unknown
 * observations). Predicting beyond a boundary is prohibited because it would
 * produce false confidence — the engine would act on a fabricated future.
 *
 * Why discount future costs:
 * A cost incurred now is certain. A cost incurred in future steps is uncertain —
 * the task may succeed early, branch differently, or be aborted. The discount
 * factor encodes this uncertainty, making the engine prefer cheaper early paths
 * and avoid committing to expensive trajectories.
 */

import type { Cost } from "../shared/types";
import type { ActionValue } from "./types";
import { addCosts } from "../shared/cost";

/** Standard discount factor for expected future costs. Values < 1 favour cheaper near-term paths. */
export const DEFAULT_DISCOUNT = 0.85;

/**
 * Compute the Bellman value of taking one action on a given path.
 *
 * immediateCost:     the cost of executing this action (tokens, duration).
 * expectedFutureCost: estimated remaining cost after this action completes.
 * discountFactor:    how much future costs are discounted (default 0.85).
 *
 * totalValue uses token cost as the scalar — tokens are the primary
 * governance currency because they directly map to model API cost and
 * context pressure.
 */
export const computeActionValue = ({
  immediateCost,
  expectedFutureCost,
  discountFactor = DEFAULT_DISCOUNT,
}: {
  immediateCost: Cost;
  expectedFutureCost: Cost;
  discountFactor?: number;
}): ActionValue => {
  const totalCost = addCosts(immediateCost, {
    tokens: Math.round(expectedFutureCost.tokens * discountFactor),
    durationMs: Math.round(expectedFutureCost.durationMs * discountFactor),
  });
  return {
    immediateCost,
    expectedFutureCost,
    totalValue: totalCost.tokens, // token cost as primary scalar
  };
};

/**
 * An epistemic boundary descriptor, supplied by the engine when projecting
 * a horizon. The boundary type tells the engine why projection stopped.
 */
export type HorizonBoundary = {
  stoppedAt: number; // step index where projection halted
  reason: string;
};

/**
 * A single step in an MPC horizon projection.
 * The engine fills these in as it simulates the future trajectory.
 */
export type HorizonStep = {
  actionName: string;
  estimatedCost: Cost;
  /** True when this action retrieves external data — marks an epistemic boundary. */
  isEpistemicBoundary: boolean;
};

/**
 * Project a finite horizon and return the accumulated expected cost,
 * stopping before any epistemic boundary (prohibition 14).
 *
 * Returns:
 * - totalProjectedCost: sum of all steps before the boundary.
 * - stepsTaken: how many steps were projected.
 * - boundary: set when projection stopped early at a boundary.
 */
export const projectHorizon = ({
  steps,
  discountFactor = DEFAULT_DISCOUNT,
}: {
  steps: HorizonStep[];
  discountFactor?: number;
}): { totalProjectedCost: Cost; stepsTaken: number; boundary?: HorizonBoundary } => {
  let accumulated: Cost = { tokens: 0, durationMs: 0 };
  let stepsTaken = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) break;

    // Stop before an epistemic boundary — do not predict beyond available evidence.
    if (step.isEpistemicBoundary) {
      return {
        totalProjectedCost: accumulated,
        stepsTaken,
        boundary: {
          stoppedAt: i,
          reason: `epistemic boundary at step ${i}: action "${step.actionName}" retrieves external data`,
        },
      };
    }

    // Apply discount to each step (further steps are less certain).
    const discounted: Cost = {
      tokens: Math.round(step.estimatedCost.tokens * Math.pow(discountFactor, i)),
      durationMs: Math.round(step.estimatedCost.durationMs * Math.pow(discountFactor, i)),
    };

    accumulated = addCosts(accumulated, discounted);
    stepsTaken++;
  }

  return { totalProjectedCost: accumulated, stepsTaken };
};
