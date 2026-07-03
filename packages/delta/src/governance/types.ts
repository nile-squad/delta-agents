/**
 * Governance math types.
 *
 * All values are normalised to [0, 1] ranges internally so the different
 * estimators (Kalman, Bayesian, friction) share a common scale and can be
 * composed without unit conversion. The developer-facing risk prior (1–5)
 * is converted at the boundary where it enters the engine.
 */

import type { Cost } from "../shared/types";

// ---------------------------------------------------------------------------
// Kalman estimator
// ---------------------------------------------------------------------------

/** Scalar Kalman state tracking a single health dimension in [0, 1]. */
export type KalmanState = {
  /** Current best estimate of execution health (1.0 = perfectly on track). */
  estimate: number;
  /** Estimation error variance — how uncertain we are about the estimate. */
  errorVariance: number;
};

/** Noise parameters for the Kalman update equations. */
export type KalmanConfig = {
  /** Process noise Q — inherent variability per execution step. */
  processNoise: number;
  /** Measurement noise R — uncertainty in each observation. */
  measurementNoise: number;
};

export const DEFAULT_KALMAN_CONFIG: KalmanConfig = {
  processNoise: 0.01,
  measurementNoise: 0.1,
};

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

export type TrustUpdateOutcome = "success" | "failure" | "surprise";

/**
 * Asymmetric trust update rates (spec §Asymmetric Reputation Decay).
 * Calibration values — these will be tuned from operational evidence
 * (spec §Follow-Up Work: Trust Calibration).
 */
export const TRUST_RATES = {
  /** Fraction of the remaining gap to 1.0 gained on each success. Slow. */
  SUCCESS: 0.05,
  /** Multiplicative score reduction on each failure. Fast. */
  FAILURE: 0.25,
  /**
   * Multiplicative reduction on a surprise event, scaled by surprise magnitude.
   * Always >= FAILURE to enforce the asymmetry principle.
   */
  SURPRISE: 0.40,
} as const;

// ---------------------------------------------------------------------------
// Surprise
// ---------------------------------------------------------------------------

export type SurpriseScore = {
  /** Normalised divergence [0, 1]. 0 = no surprise, 1 = maximum divergence. */
  magnitude: number;
  /** True when magnitude exceeds the threshold warranting oversight escalation. */
  isSignificant: boolean;
};

/**
 * Surprise threshold above which the engine raises oversight requirements
 * (spec §Bayesian Surprise).
 * Conservative default — will be tuned from operational evidence.
 */
export const SURPRISE_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Cost friction
// ---------------------------------------------------------------------------

export type FrictionSignal = {
  /**
   * Ratio of cost consumed to progress made.
   * 1.0 = perfectly proportional. >1 = spending more than expected per progress unit.
   * Capped at 10 for display; the isUnstable flag carries the governance signal.
   */
  frictionRatio: number;
  /** True when consumption is high and advancement is low — likely a loop or spiral. */
  isUnstable: boolean;
  reason?: string;
};

/**
 * Friction ratio above which execution is considered unstable
 * (spec §Cost Friction Detection).
 */
export const FRICTION_THRESHOLD = 2.5;

// ---------------------------------------------------------------------------
// Bellman / MPC
// ---------------------------------------------------------------------------

export type ActionValue = {
  immediateCost: Cost;
  expectedFutureCost: Cost;
  /**
   * Total discounted value (lower = better path).
   * V = immediate_token_cost + discount * expected_future_token_cost
   */
  totalValue: number;
};

export type EpistemicBoundaryType =
  | "data-retrieval"
  | "memory-retrieval"
  | "external-observation"
  | "unknown-information";
