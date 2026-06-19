/**
 * Bayesian surprise — divergence between expected and observed outcomes.
 *
 * The engine computes surprise whenever a predicted value (from the Kalman
 * estimate or MPC projection) differs significantly from an observed value.
 * High surprise signals model drift, workflow drift, or novel conditions
 * and increases oversight requirements (spec §Bayesian Surprise).
 *
 * Surprise is symmetric: observing much better than expected is also a signal
 * (it could indicate an untested fast path or a silent data quality issue)
 * though it carries a smaller risk weight than negative surprise.
 *
 * Implementation uses absolute normalised divergence:
 *   surprise = |expected - observed| / (expected + ε)
 * The ε prevents division by zero when the expected value is near zero.
 */

import type { SurpriseScore } from "./types";
import { SURPRISE_THRESHOLD } from "./types";

const EPSILON = 0.001;

/**
 * Compute a surprise score from a single (expected, observed) pair.
 *
 * Both inputs should be in the same units and normalised to [0, 1] when possible
 * (e.g. progress ratio, cost ratio, health estimate).
 *
 * Returns a SurpriseScore with magnitude in [0, 1] and whether it crossed
 * the significance threshold.
 */
export const computeSurprise = ({
  expected,
  observed,
}: {
  expected: number;
  observed: number;
}): SurpriseScore => {
  const absoluteDivergence = Math.abs(expected - observed);
  // Normalise by the expected value so the score is relative, not absolute.
  // A divergence of 0.5 when expected is 0.5 is much more surprising than
  // the same divergence when expected is 5.0.
  const magnitude = Math.min(1, absoluteDivergence / (Math.abs(expected) + EPSILON));

  return {
    magnitude,
    isSignificant: magnitude >= SURPRISE_THRESHOLD,
  };
};

/**
 * Aggregate surprise across multiple dimensions (cost, progress, outcome).
 *
 * Returns the maximum single-dimension surprise — any significant surprise
 * triggers the oversight response regardless of which dimension produced it.
 */
export const aggregateSurprise = (
  pairs: Array<{ expected: number; observed: number }>,
): SurpriseScore => {
  if (pairs.length === 0) return { magnitude: 0, isSignificant: false };

  const scores = pairs.map(computeSurprise);
  const maxMagnitude = Math.max(...scores.map((s) => s.magnitude));

  return {
    magnitude: maxMagnitude,
    isSignificant: maxMagnitude >= SURPRISE_THRESHOLD,
  };
};
