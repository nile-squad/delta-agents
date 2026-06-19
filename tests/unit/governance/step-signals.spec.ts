import { describe, it, expect } from "vitest";
import {
  assembleStepSignals,
  SURPRISE_THRESHOLD,
} from "../../../src/governance";
import type { StepSignalsInput } from "../../../src/governance";

const isFiniteInRange = (n: number): boolean =>
  Number.isFinite(n) && n >= 0 && n <= 1;

describe("assembleStepSignals", () => {
  it("healthy step: one completion at stepIndex 0 with proportional cost yields high health and low friction", () => {
    const input: StepSignalsInput = {
      anticipatedRisk: undefined,
      hasEstimatedCost: false,
      priorSpent: { tokens: 0, durationMs: 0 },
      actualCost: { tokens: 100, durationMs: 1_000 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 1,
      stepIndex: 0,
      fnSucceeded: true,
    };

    const result = assembleStepSignals(input);

    // progressRatio = 1 / (0 + 1) = 1; avgCostRatio = 0.1; health = min(1, 1/0.1) = 1.
    expect(result.observedHealth).toBe(1);
    // friction.frictionRatio = 0.1 / 1 = 0.1; signal = 0.01.
    expect(result.evidence.frictionSignal).toBeCloseTo(0.01, 5);
    expect(result.evidence.frictionSignal).toBeLessThan(0.1);
    expect(result.evidence.recentFailureRate).toBe(0);
  });

  it("retry/stall: low completions relative to stepIndex with high cost yields high friction signal", () => {
    const input: StepSignalsInput = {
      hasEstimatedCost: false,
      priorSpent: { tokens: 800, durationMs: 8_000 },
      actualCost: { tokens: 100, durationMs: 1_000 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 1,
      stepIndex: 9, // attempted 10 steps, only 1 distinct completion
      fnSucceeded: true,
    };

    const result = assembleStepSignals(input);

    // progressRatio = 1 / 10 = 0.1; avgCostRatio = 0.9; friction = 0.9 / 0.1 = 9.
    // signal = min(1, 9 / 10) = 0.9.
    expect(result.evidence.frictionSignal).toBeCloseTo(0.9, 5);
    expect(result.evidence.frictionSignal).toBeGreaterThan(0.5);
  });

  it("surprise present: observed health diverging far from a known prior is significant", () => {
    const input: StepSignalsInput = {
      // Force a known prior so the divergence is deterministic.
      priorKalman: { estimate: 1.0, errorVariance: 0.2 },
      hasEstimatedCost: false,
      priorSpent: { tokens: 500, durationMs: 5_000 },
      actualCost: { tokens: 100, durationMs: 1_000 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 0, // zero progress -> observedHealth = 0
      stepIndex: 5,
      fnSucceeded: true,
    };

    const result = assembleStepSignals(input);

    // observedHealth = 0 (zero progress, non-zero cost), expected = 1.0.
    expect(result.observedHealth).toBe(0);
    expect(result.surprise.magnitude).toBeGreaterThan(0);
    expect(result.surprise.magnitude).toBeGreaterThanOrEqual(SURPRISE_THRESHOLD);
    expect(result.surprise.isSignificant).toBe(true);
    expect(result.evidence.surpriseMagnitude).toBe(result.surprise.magnitude);
  });

  it("kalman moves toward the observation: estimate lands strictly between prior and observed", () => {
    const prior = 1.0;
    const input: StepSignalsInput = {
      priorKalman: { estimate: prior, errorVariance: 0.2 },
      hasEstimatedCost: false,
      priorSpent: { tokens: 0, durationMs: 0 },
      actualCost: { tokens: 600, durationMs: 6_000 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 1,
      stepIndex: 2, // progressRatio = 1/3
      fnSucceeded: true,
    };

    const result = assembleStepSignals(input);
    const observed = result.observedHealth;

    // observed must differ from prior for a strict-between assertion to mean anything.
    expect(observed).toBeLessThan(prior);
    expect(result.kalman.estimate).toBeGreaterThan(observed);
    expect(result.kalman.estimate).toBeLessThan(prior);
  });

  it("recentFailureRate is 1 when fnSucceeded is false, 0 when true", () => {
    const base: StepSignalsInput = {
      hasEstimatedCost: false,
      priorSpent: { tokens: 0, durationMs: 0 },
      actualCost: { tokens: 100, durationMs: 1_000 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 1,
      stepIndex: 0,
      fnSucceeded: true,
    };

    expect(assembleStepSignals(base).evidence.recentFailureRate).toBe(0);
    expect(
      assembleStepSignals({ ...base, fnSucceeded: false }).evidence
        .recentFailureRate,
    ).toBe(1);
  });

  it("cold start: anticipatedRisk 5 seeds a lower initial estimate than no risk", () => {
    const base: StepSignalsInput = {
      hasEstimatedCost: false,
      priorSpent: { tokens: 0, durationMs: 0 },
      actualCost: { tokens: 0, durationMs: 0 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 0,
      stepIndex: 0,
      fnSucceeded: true,
    };

    // With no cost spent, observedHealth = 1 for both, so the surprise score
    // reflects only the seeded prior. Higher anticipated risk -> lower prior
    // estimate -> larger divergence from the observed health of 1.
    const noRisk = assembleStepSignals({ ...base, anticipatedRisk: undefined });
    const highRisk = assembleStepSignals({ ...base, anticipatedRisk: 5 });

    expect(noRisk.surprise.magnitude).toBe(0); // prior 1.0 == observed 1.0
    expect(highRisk.surprise.magnitude).toBeGreaterThan(noRisk.surprise.magnitude);

    // Both still produce finite, in-range values.
    [noRisk, highRisk].forEach((r) => {
      expect(isFiniteInRange(r.observedHealth)).toBe(true);
      expect(isFiniteInRange(r.kalman.estimate)).toBe(true);
      expect(isFiniteInRange(r.surprise.magnitude)).toBe(true);
    });
  });

  it("edge cases never produce NaN/Infinity: zero budget axis and zero progress with non-zero cost", () => {
    const zeroBudgetAxis = assembleStepSignals({
      hasEstimatedCost: false,
      priorSpent: { tokens: 0, durationMs: 0 },
      actualCost: { tokens: 50, durationMs: 500 },
      budget: { tokens: 0, durationMs: 10_000 }, // zero token budget axis
      completedActionsCount: 1,
      stepIndex: 0,
      fnSucceeded: true,
    });

    const zeroProgress = assembleStepSignals({
      hasEstimatedCost: false,
      priorSpent: { tokens: 900, durationMs: 9_000 },
      actualCost: { tokens: 50, durationMs: 500 },
      budget: { tokens: 1_000, durationMs: 10_000 },
      completedActionsCount: 0, // zero progress, non-zero cost
      stepIndex: 3,
      fnSucceeded: false,
    });

    [zeroBudgetAxis, zeroProgress].forEach((r) => {
      expect(isFiniteInRange(r.evidence.frictionSignal)).toBe(true);
      expect(isFiniteInRange(r.evidence.surpriseMagnitude)).toBe(true);
      expect(isFiniteInRange(r.evidence.recentFailureRate)).toBe(true);
      expect(isFiniteInRange(r.observedHealth)).toBe(true);
      expect(isFiniteInRange(r.kalman.estimate)).toBe(true);
      expect(Number.isFinite(r.kalman.errorVariance)).toBe(true);
    });
  });
});
