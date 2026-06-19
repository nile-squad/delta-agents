import { describe, it, expect } from "vitest";
import {
  initialRiskState,
  updateRisk,
  shouldEscalate,
  normaliseActionRisk,
} from "../../../src/governance";

describe("normaliseActionRisk", () => {
  it("maps 1 → 0.2 and 5 → 1.0", () => {
    expect(normaliseActionRisk(1)).toBeCloseTo(0.2);
    expect(normaliseActionRisk(5)).toBeCloseTo(1.0);
  });
});

describe("initialRiskState", () => {
  it("defaults to low risk when no prior is declared", () => {
    const risk = initialRiskState();
    expect(risk.staticRisk).toBe(0.2);
    expect(risk.currentRisk).toBe(0.2);
  });

  it("seeds staticRisk and currentRisk from the anticipated risk prior", () => {
    const risk = initialRiskState({ anticipatedRisk: 4 });
    expect(risk.staticRisk).toBeCloseTo(0.8);
    expect(risk.currentRisk).toBeCloseTo(0.8);
  });

  it("starts with low confidence (no evidence yet)", () => {
    const risk = initialRiskState();
    expect(risk.confidence).toBeLessThan(0.3);
  });

  it("starts not escalated", () => {
    expect(initialRiskState().escalated).toBe(false);
  });
});

describe("updateRisk — evidence raises risk (invariants 12, 23; prohibition 20)", () => {
  it("raises currentRisk when friction signal is high", () => {
    const before = initialRiskState({ anticipatedRisk: 1 });
    const after = updateRisk({
      current: before,
      evidence: { frictionSignal: 0.9, surpriseMagnitude: 0, recentFailureRate: 0 },
    });
    expect(after.currentRisk).toBeGreaterThan(before.currentRisk);
  });

  it("raises currentRisk when surprise is high", () => {
    const before = initialRiskState({ anticipatedRisk: 1 });
    const after = updateRisk({
      current: before,
      evidence: { frictionSignal: 0, surpriseMagnitude: 0.9, recentFailureRate: 0 },
    });
    expect(after.currentRisk).toBeGreaterThan(before.currentRisk);
  });

  it("raises currentRisk when failure rate is high", () => {
    const before = initialRiskState({ anticipatedRisk: 1 });
    const after = updateRisk({
      current: before,
      evidence: { frictionSignal: 0, surpriseMagnitude: 0, recentFailureRate: 0.9 },
    });
    expect(after.currentRisk).toBeGreaterThan(before.currentRisk);
  });

  it("never lowers currentRisk below staticRisk — prior is the floor (invariant 23, prohibition 20)", () => {
    const before = initialRiskState({ anticipatedRisk: 4 }); // staticRisk = 0.8
    // Perfect evidence — everything looks safe
    const after = updateRisk({
      current: before,
      evidence: { frictionSignal: 0, surpriseMagnitude: 0, recentFailureRate: 0 },
    });
    // currentRisk may drop toward staticRisk but never below it
    expect(after.currentRisk).toBeGreaterThanOrEqual(after.staticRisk);
  });

  it("staticRisk is immutable — evidence never changes the declared prior (invariant 23)", () => {
    const before = initialRiskState({ anticipatedRisk: 3 });
    const staticBefore = before.staticRisk;
    const after = updateRisk({
      current: before,
      evidence: { frictionSignal: 1, surpriseMagnitude: 1, recentFailureRate: 1 },
    });
    expect(after.staticRisk).toBe(staticBefore);
  });

  it("predictedRisk is at least as high as currentRisk (pessimistic MPC bias)", () => {
    const before = initialRiskState({ anticipatedRisk: 2 });
    const after = updateRisk({
      current: before,
      evidence: { frictionSignal: 0.5, surpriseMagnitude: 0.3, recentFailureRate: 0.2 },
    });
    expect(after.predictedRisk).toBeGreaterThanOrEqual(after.currentRisk);
  });

  it("confidence increases with each update (more evidence → more confidence)", () => {
    let risk = initialRiskState();
    const initial = risk.confidence;
    for (let i = 0; i < 5; i++) {
      risk = updateRisk({
        current: risk,
        evidence: { frictionSignal: 0.1, surpriseMagnitude: 0.1, recentFailureRate: 0.1 },
      });
    }
    expect(risk.confidence).toBeGreaterThan(initial);
  });

  it("confidence never exceeds 0.99 (we never reach perfect certainty)", () => {
    let risk = initialRiskState();
    for (let i = 0; i < 1000; i++) {
      risk = updateRisk({
        current: risk,
        evidence: { frictionSignal: 0, surpriseMagnitude: 0, recentFailureRate: 0 },
      });
    }
    expect(risk.confidence).toBeLessThanOrEqual(0.99);
  });

  it("all risk values remain in [0, 1] across arbitrary evidence inputs", () => {
    let risk = initialRiskState();
    const extremes = [
      { frictionSignal: 1, surpriseMagnitude: 1, recentFailureRate: 1 },
      { frictionSignal: 0, surpriseMagnitude: 0, recentFailureRate: 0 },
    ];
    for (let i = 0; i < 20; i++) {
      risk = updateRisk({ current: risk, evidence: extremes[i % 2]! });
      expect(risk.currentRisk).toBeGreaterThanOrEqual(0);
      expect(risk.currentRisk).toBeLessThanOrEqual(1);
      expect(risk.predictedRisk).toBeGreaterThanOrEqual(0);
      expect(risk.predictedRisk).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldEscalate", () => {
  it("returns true when currentRisk is critically high", () => {
    const risk = { ...initialRiskState(), currentRisk: 0.85, predictedRisk: 0.85 };
    expect(shouldEscalate(risk)).toBe(true);
  });

  it("returns true when predictedRisk is critically high even if currentRisk is moderate", () => {
    const risk = { ...initialRiskState(), currentRisk: 0.5, predictedRisk: 0.95 };
    expect(shouldEscalate(risk)).toBe(true);
  });

  it("returns false when risk is within acceptable range", () => {
    const risk = { ...initialRiskState(), currentRisk: 0.3, predictedRisk: 0.4 };
    expect(shouldEscalate(risk)).toBe(false);
  });
});
