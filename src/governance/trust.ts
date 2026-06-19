/**
 * Bayesian trust updating with asymmetric reputation decay.
 *
 * Trust is the engine's confidence that an agent will continue to produce
 * correct, safe, and in-scope outcomes. It is purely evidence-derived —
 * the engine never grants trust on declaration or assumption
 * (spec §Trust Is Statistical, spec §Bayesian Updating, invariants 11, 12;
 * prohibitions 12, 13).
 *
 * Asymmetry (spec §Asymmetric Reputation Decay):
 * - Trust accrues slowly: each success closes a fraction of the gap to 1.0.
 * - Trust decays rapidly: each failure multiplies the score by a reduction factor.
 * - Surprises decay even faster, scaled by how surprising the event was.
 *
 * The asymmetry intentionally biases the engine toward caution. An agent that
 * occasionally fails recovers slowly — the engine does not forget failures
 * quickly just because a few successes follow.
 */

import type { TrustState } from "../shared/types";
import type { TrustUpdateOutcome } from "./types";
import { TRUST_RATES } from "./types";

/**
 * Apply one Bayesian trust update from an observed outcome.
 *
 * surpriseMagnitude: [0, 1] — only meaningful for "surprise" outcomes.
 * Higher magnitude = more unusual = steeper penalty.
 */
export const updateTrust = ({
  current,
  outcome,
  surpriseMagnitude = 0,
}: {
  current: TrustState;
  outcome: TrustUpdateOutcome;
  surpriseMagnitude?: number;
}): TrustState => {
  const clampedSurprise = Math.max(0, Math.min(1, surpriseMagnitude));
  let newScore: number;

  switch (outcome) {
    case "success":
      // Slow accrual: close a fixed fraction of the remaining gap to 1.0.
      // e.g. score=0.8, rate=0.05 → 0.8 + 0.05 * 0.2 = 0.81
      newScore = current.score + TRUST_RATES.SUCCESS * (1 - current.score);
      return {
        score: Math.min(1, newScore),
        successfulExecutions: current.successfulExecutions + 1,
        failedExecutions: current.failedExecutions,
        surpriseEvents: current.surpriseEvents,
      };

    case "failure":
      // Fast decay: multiplicative reduction.
      // e.g. score=0.8, rate=0.25 → 0.8 * 0.75 = 0.6
      newScore = current.score * (1 - TRUST_RATES.FAILURE);
      return {
        score: Math.max(0, newScore),
        successfulExecutions: current.successfulExecutions,
        failedExecutions: current.failedExecutions + 1,
        surpriseEvents: current.surpriseEvents,
      };

    case "surprise":
      // Fastest decay, scaled by how surprising the event was.
      // A magnitude of 1.0 applies the full SURPRISE rate.
      // A magnitude of 0.0 still applies a base penalty (surprises are never free).
      newScore =
        current.score * (1 - TRUST_RATES.SURPRISE * (0.5 + 0.5 * clampedSurprise));
      return {
        score: Math.max(0, newScore),
        successfulExecutions: current.successfulExecutions,
        failedExecutions: current.failedExecutions + 1,
        surpriseEvents: current.surpriseEvents + 1,
      };
  }
};

/** Create a neutral starting TrustState. */
export const initialTrust = (): TrustState => ({
  score: 0.5, // No evidence yet — start at the midpoint, not full trust.
  successfulExecutions: 0,
  failedExecutions: 0,
  surpriseEvents: 0,
});

/**
 * True when a trust score has degraded enough to warrant heightened oversight.
 * This threshold is conservative by design (spec §Follow-Up Work: Trust Calibration).
 */
export const isTrustDegraded = (trust: TrustState): boolean => trust.score < 0.3;
