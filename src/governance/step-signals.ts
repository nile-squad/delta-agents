/**
 * Step-signal assembly for the execution gateway.
 *
 * Why this module exists:
 * The live gateway previously fed `updateRisk` hardcoded zeros
 * (`frictionSignal: 0, surpriseMagnitude: 0`), so the only thing that ever
 * moved risk was the failure rate, and the Bayesian-surprise escalation branch
 * was statically unreachable (audit finding H3). This module composes the
 * already-built, already-tested governance primitives (Kalman estimator,
 * surprise, cost friction) into the real evidence the gateway needs after each
 * action runs. It performs NO I/O and has NO side effects — given the same
 * inputs it always returns the same signals, keeping the governance decision
 * deterministic and auditable.
 *
 * Why the progress proxy is what it is:
 * A free reasoning loop has no known total-work denominator — we cannot say
 * "step 3 of 10" because the reasoner decides at runtime how many actions a
 * goal needs. So we use "distinct completions per attempted step"
 * (`completedActionsCount / (stepIndex + 1)`) as the advancement measure. It
 * rises toward 1 when each step completes genuinely new work, and falls during
 * retry storms or loops where many steps are attempted but few complete. That
 * falling ratio is exactly the signal cost-friction detection is built to catch.
 */

import {
  createKalmanState,
  kalmanUpdate,
  computeHealthObservation,
} from "./kalman-estimator";
import { computeSurprise } from "./surprise";
import { detectFriction } from "./cost-friction";
import type { KalmanState, SurpriseScore } from "./types";
import { addCosts, costRatio } from "../shared/cost";
import type { Cost } from "../shared/types";

export type StepSignalsInput = {
  /** Kalman state carried in the task snapshot, or undefined on the first step. */
  priorKalman?: KalmanState;
  /** Developer-declared risk prior (1-5) for this action, if any. Seeds a cold Kalman. */
  anticipatedRisk?: 1 | 2 | 3 | 4 | 5;
  /** Whether the action declared an estimatedCost prior. Tightens initial Kalman variance. */
  hasEstimatedCost: boolean;
  /** Cumulative cost spent BEFORE this action ran. */
  priorSpent: Cost;
  /** This action's recorded cost (reasoning tokens + fn wall-clock duration). */
  actualCost: Cost;
  /** Task budget ceiling. */
  budget: Cost;
  /** Distinct actions completed so far, counted AFTER this step. */
  completedActionsCount: number;
  /** 0-based index of this step in the loop (count of actions attempted before this one). */
  stepIndex: number;
  /** Whether action.fn returned Ok. */
  fnSucceeded: boolean;
};

export type StepSignals = {
  /** Ready to feed straight into updateRisk({ current, evidence }). All values in [0,1]. */
  evidence: { frictionSignal: number; surpriseMagnitude: number; recentFailureRate: number };
  /** Updated Kalman state to store back on the snapshot. */
  kalman: KalmanState;
  /** Observed execution health this step, in [0,1]. Exposed for diagnostics/tests. */
  observedHealth: number;
  /** Full surprise score (magnitude + isSignificant). Exposed for escalation + tests. */
  surprise: SurpriseScore;
};

/**
 * Assemble the governance signals for a single completed step.
 *
 * Composes the friction, surprise, and Kalman primitives into the exact
 * evidence shape the execution gateway feeds to `updateRisk`, plus the updated
 * Kalman state to persist and the diagnostic values (observed health, full
 * surprise score) the escalation path and tests inspect.
 *
 * Pure: no I/O, no mutation. Deterministic for a given input so every risk
 * update remains reproducible and auditable.
 */
export const assembleStepSignals = (input: StepSignalsInput): StepSignals => {
  const {
    priorKalman,
    anticipatedRisk,
    hasEstimatedCost,
    priorSpent,
    actualCost,
    budget,
    completedActionsCount,
    stepIndex,
    fnSucceeded,
  } = input;

  const kalmanPrior =
    priorKalman ?? createKalmanState({ anticipatedRisk, hasEstimatedCost });

  const totalSpent = addCosts(priorSpent, actualCost);
  const progressRatio = completedActionsCount / (stepIndex + 1);

  const friction = detectFriction({ spent: totalSpent, budget, progressRatio });
  // detectFriction caps frictionRatio at 10; normalise to [0,1].
  const frictionSignal = Math.min(1, friction.frictionRatio / 10);

  const cr = costRatio(totalSpent, budget);
  const avgCostRatio = (cr.tokens + cr.durationMs) / 2;

  const observedHealth = computeHealthObservation({
    progressRatio,
    costRatio: avgCostRatio,
  });

  const predictedHealth = kalmanPrior.estimate;
  const surprise = computeSurprise({
    expected: predictedHealth,
    observed: observedHealth,
  });

  const kalman = kalmanUpdate({ state: kalmanPrior, observation: observedHealth });

  const recentFailureRate = fnSucceeded ? 0 : 1;

  return {
    evidence: {
      frictionSignal,
      surpriseMagnitude: surprise.magnitude,
      recentFailureRate,
    },
    kalman,
    observedHealth,
    surprise,
  };
};
