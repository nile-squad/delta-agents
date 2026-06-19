/**
 * Kalman state estimator for execution health.
 *
 * Tracks how well execution is progressing relative to expectations.
 * The estimate is continuously refined as new observations arrive
 * (spec §Kalman State Estimation).
 *
 * Why Kalman for this:
 * Execution health observations are noisy (a single slow action does not mean
 * the whole task is failing). The Kalman filter blends prior belief with new
 * evidence in proportion to each source's uncertainty — more certain sources
 * receive more weight. This avoids both over-reacting to one bad step and
 * under-reacting to a sustained drift.
 *
 * Seeding with anticipated risk / cost priors:
 * When a developer declares `risk` or `estimatedCost` on an action, the engine
 * initialises the Kalman state with a prior rather than starting cold. A warm
 * prior means the first few observations converge faster — the estimator already
 * "knows" something. The prior is just a starting point; observed evidence always
 * takes over (invariant 23, prohibition 20).
 */

import type { KalmanState, KalmanConfig } from "./types";
import { DEFAULT_KALMAN_CONFIG } from "./types";

/**
 * Normalise a developer-declared risk level (1–5) to [0, 1].
 * Used to set the initial health estimate: higher anticipated risk means
 * we start with a lower health expectation.
 */
export const normaliseRisk = (risk: 1 | 2 | 3 | 4 | 5): number => risk / 5;

/**
 * Create an initial KalmanState.
 *
 * With no prior: estimate = 1.0 (assume on-track), high variance (very uncertain).
 * With a risk prior: estimate is reduced proportionally (higher risk → lower start).
 * With a cost prior: the variance is tightened (we have a calibrated expectation).
 *
 * The prior is never a ceiling — kalmanUpdate can move the estimate in any direction
 * once evidence arrives (invariant 23, prohibition 20).
 */
export const createKalmanState = ({
  anticipatedRisk,
  hasEstimatedCost,
}: {
  anticipatedRisk?: 1 | 2 | 3 | 4 | 5;
  hasEstimatedCost?: boolean;
} = {}): KalmanState => {
  // Cold start: neutral estimate, high uncertainty.
  const coldEstimate = 1.0;
  const coldVariance = 0.5;

  // A cost prior tightens the variance — we have calibrated expectations.
  const varianceWithCost = hasEstimatedCost === true ? 0.2 : coldVariance;

  // A risk prior lowers the initial health estimate — we expect more difficulty.
  const estimateWithRisk =
    anticipatedRisk !== undefined
      ? coldEstimate * (1 - normaliseRisk(anticipatedRisk) * 0.3)
      : coldEstimate;

  return {
    estimate: Math.max(0, Math.min(1, estimateWithRisk)),
    errorVariance: varianceWithCost,
  };
};

/**
 * Apply one Kalman update step with a new health observation.
 *
 * observation: a value in [0, 1] representing the measured health at this step.
 *   - 1.0 = perfectly on track (cost / progress ratio exactly as expected)
 *   - 0.0 = severely off track (spending maximum with no progress)
 *
 * The update blends the prior estimate with the new observation. When the
 * observation diverges significantly from the estimate, risk increases upstream
 * (the caller is responsible for acting on a degraded estimate — this function
 * only produces the estimate).
 */
export const kalmanUpdate = ({
  state,
  observation,
  config = DEFAULT_KALMAN_CONFIG,
}: {
  state: KalmanState;
  observation: number;
  config?: KalmanConfig;
}): KalmanState => {
  // Predict step: propagate state and grow uncertainty with process noise.
  const predictedEstimate = state.estimate; // identity transition (no drift model)
  const predictedVariance = state.errorVariance + config.processNoise;

  // Update step: incorporate the new observation weighted by Kalman gain.
  const kalmanGain = predictedVariance / (predictedVariance + config.measurementNoise);
  const newEstimate = predictedEstimate + kalmanGain * (observation - predictedEstimate);
  const newVariance = (1 - kalmanGain) * predictedVariance;

  return {
    estimate: Math.max(0, Math.min(1, newEstimate)),
    errorVariance: Math.max(0, newVariance),
  };
};

/**
 * Compute an execution health observation from cost and progress ratios.
 *
 * progressRatio: fraction of work completed (0–1).
 * costRatio:     fraction of budget consumed (0–1).
 *
 * health = progressRatio / costRatio (how much progress per unit cost).
 * health = 1.0 when progress and cost are proportional.
 * health < 1.0 when cost is outpacing progress.
 * Returns 1.0 when no cost has been spent yet (no observation to make).
 */
export const computeHealthObservation = ({
  progressRatio,
  costRatio,
}: {
  progressRatio: number;
  costRatio: number;
}): number => {
  if (costRatio <= 0) return 1.0;
  if (progressRatio <= 0) return 0.0;
  // Cap at 1.0 — going faster than expected is not a governance concern.
  return Math.min(1.0, progressRatio / costRatio);
};
