/**
 * Risk state initialisation and evidence-based updating.
 *
 * Risk has two distinct dimensions:
 * - staticRisk: the normalised prior declared by the developer (never changes).
 * - currentRisk: the engine's continuously-updated estimate from evidence.
 *
 * The invariant that matters here: currentRisk can only be raised above
 * staticRisk, never lowered below it (spec invariant 23, prohibition 20).
 * A developer declaring risk=1 on an action that turns out to be dangerous
 * is overridden by evidence — the prior is a starting point, not a ceiling.
 *
 * Evidence inputs that drive risk upward:
 * - High cost friction (spec §Cost Friction Detection)
 * - High Bayesian surprise (spec §Bayesian Surprise)
 * - High failure rate in recent executions
 *
 * All inputs are normalised to [0, 1]. The updated risk is an exponential
 * moving average of the current estimate and the evidence-derived signal,
 * floored by staticRisk so the prior can never be overridden downward.
 */

import type { RiskState } from "../shared/types";

/**
 * Convert a developer-declared action risk level (1–5) to a normalised
 * staticRisk in [0.2, 1.0] for use in RiskState.
 * Risk 1 → 0.2 (low but not zero — all actions carry some risk).
 */
export const normaliseActionRisk = (risk: 1 | 2 | 3 | 4 | 5): number => risk / 5;

/** Create an initial RiskState from an optional developer-declared prior. */
export const initialRiskState = ({
  anticipatedRisk,
}: {
  anticipatedRisk?: 1 | 2 | 3 | 4 | 5;
} = {}): RiskState => {
  const base = anticipatedRisk !== undefined ? normaliseActionRisk(anticipatedRisk) : 0.2;
  return {
    staticRisk: base,
    currentRisk: base,
    predictedRisk: base,
    confidence: 0.1, // low confidence at start — we have no evidence yet
    escalated: false,
  };
};

/**
 * Update risk from observed evidence.
 *
 * Evidence inputs (all in [0, 1]):
 * - frictionSignal: how much cost friction was detected this step
 * - surpriseMagnitude: how large the Bayesian surprise was
 * - recentFailureRate: fraction of recent executions that returned Err
 *
 * The engine uses a weighted blend of evidence inputs, then applies an
 * exponential moving average against the current estimate. The result is
 * always at least staticRisk — the prior is the floor.
 */
export const updateRisk = ({
  current,
  evidence,
}: {
  current: RiskState;
  evidence: {
    frictionSignal: number;
    surpriseMagnitude: number;
    recentFailureRate: number;
  };
}): RiskState => {
  // Weight evidence contributions (calibration values — see §Follow-Up Work).
  const evidenceRisk =
    evidence.frictionSignal * 0.3 +
    evidence.surpriseMagnitude * 0.4 +
    evidence.recentFailureRate * 0.3;

  // Blend into the current estimate with momentum (EMA, α = 0.3).
  const alpha = 0.3;
  const blended = current.currentRisk * (1 - alpha) + evidenceRisk * alpha;

  // Floor at staticRisk — a low declared prior never allows the engine to
  // conclude "this is safe" when evidence says otherwise (invariant 23).
  const newCurrentRisk = Math.max(current.staticRisk, Math.min(1, blended));

  // Predicted risk is slightly pessimistic — prefer over-caution (MPC principle).
  const newPredictedRisk = Math.min(1, newCurrentRisk * 1.15);

  // Confidence grows with each observation (up to a cap).
  const newConfidence = Math.min(0.99, current.confidence + 0.05);

  return {
    staticRisk: current.staticRisk,
    currentRisk: newCurrentRisk,
    predictedRisk: newPredictedRisk,
    confidence: newConfidence,
    escalated: current.escalated,
  };
};

/**
 * True when current risk warrants automatic escalation to human oversight.
 * Threshold is conservative by design (spec §Follow-Up Work: Governance Metric Calibration).
 */
export const shouldEscalate = (risk: RiskState): boolean =>
  risk.currentRisk >= 0.8 || risk.predictedRisk >= 0.9;
