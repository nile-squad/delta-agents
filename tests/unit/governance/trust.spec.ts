import { describe, it, expect } from "vitest";
import {
  updateTrust,
  initialTrust,
  isTrustDegraded,
  TRUST_RATES,
} from "../../../src/governance";
import type { TrustState } from "../../../src/shared/types";

const trustAt = (score: number): TrustState => ({
  score,
  successfulExecutions: 0,
  failedExecutions: 0,
  surpriseEvents: 0,
});

describe("initialTrust", () => {
  it("starts at 0.5 — no evidence, so no full trust assumed (prohibition 12)", () => {
    expect(initialTrust().score).toBe(0.5);
  });

  it("starts with all execution counts at zero", () => {
    const t = initialTrust();
    expect(t.successfulExecutions).toBe(0);
    expect(t.failedExecutions).toBe(0);
    expect(t.surpriseEvents).toBe(0);
  });
});

describe("updateTrust — success (slow accrual)", () => {
  it("increases trust score on success", () => {
    const next = updateTrust({ current: trustAt(0.7), outcome: "success" });
    expect(next.score).toBeGreaterThan(0.7);
  });

  it("increments successfulExecutions", () => {
    const t = { ...initialTrust(), successfulExecutions: 2 };
    const next = updateTrust({ current: t, outcome: "success" });
    expect(next.successfulExecutions).toBe(3);
  });

  it("does not change failedExecutions or surpriseEvents on success", () => {
    const next = updateTrust({ current: initialTrust(), outcome: "success" });
    expect(next.failedExecutions).toBe(0);
    expect(next.surpriseEvents).toBe(0);
  });

  it("score never exceeds 1.0 even after many successes", () => {
    let t = trustAt(0.99);
    for (let i = 0; i < 100; i++) {
      t = updateTrust({ current: t, outcome: "success" });
    }
    expect(t.score).toBeLessThanOrEqual(1.0);
  });

  it("accrues slower than failure decays (asymmetry — spec §Asymmetric Reputation Decay)", () => {
    // Gain from one success starting at 0.5
    const afterSuccess = updateTrust({ current: trustAt(0.5), outcome: "success" });
    const successGain = afterSuccess.score - 0.5;

    // Loss from one failure starting at 0.5
    const afterFailure = updateTrust({ current: trustAt(0.5), outcome: "failure" });
    const failureLoss = 0.5 - afterFailure.score;

    expect(failureLoss).toBeGreaterThan(successGain);
  });
});

describe("updateTrust — failure (fast decay)", () => {
  it("decreases trust score on failure", () => {
    const next = updateTrust({ current: trustAt(0.8), outcome: "failure" });
    expect(next.score).toBeLessThan(0.8);
  });

  it("increments failedExecutions", () => {
    const t = { ...initialTrust(), failedExecutions: 1 };
    const next = updateTrust({ current: t, outcome: "failure" });
    expect(next.failedExecutions).toBe(2);
  });

  it("does not change successfulExecutions or surpriseEvents on failure", () => {
    const next = updateTrust({ current: initialTrust(), outcome: "failure" });
    expect(next.successfulExecutions).toBe(0);
    expect(next.surpriseEvents).toBe(0);
  });

  it("score never goes below 0 even after many failures", () => {
    let t = trustAt(0.01);
    for (let i = 0; i < 100; i++) {
      t = updateTrust({ current: t, outcome: "failure" });
    }
    expect(t.score).toBeGreaterThanOrEqual(0);
  });

  it("decay is multiplicative (trust recovery requires proportionally more successes)", () => {
    // After a failure, trust dropped by FAILURE_RATE fraction.
    const before = 0.8;
    const after = updateTrust({ current: trustAt(before), outcome: "failure" });
    const expectedScore = before * (1 - TRUST_RATES.FAILURE);
    expect(after.score).toBeCloseTo(expectedScore, 5);
  });
});

describe("updateTrust — surprise (fastest decay, invariant 12)", () => {
  it("decreases trust more than a plain failure", () => {
    const afterFailure = updateTrust({ current: trustAt(0.8), outcome: "failure" });
    const afterSurprise = updateTrust({
      current: trustAt(0.8),
      outcome: "surprise",
      surpriseMagnitude: 1.0,
    });
    expect(afterSurprise.score).toBeLessThan(afterFailure.score);
  });

  it("increments both failedExecutions and surpriseEvents", () => {
    const next = updateTrust({ current: initialTrust(), outcome: "surprise", surpriseMagnitude: 0.5 });
    expect(next.failedExecutions).toBe(1);
    expect(next.surpriseEvents).toBe(1);
  });

  it("higher surpriseMagnitude causes steeper decay", () => {
    const lowSurprise = updateTrust({ current: trustAt(0.8), outcome: "surprise", surpriseMagnitude: 0.1 });
    const highSurprise = updateTrust({ current: trustAt(0.8), outcome: "surprise", surpriseMagnitude: 1.0 });
    expect(highSurprise.score).toBeLessThan(lowSurprise.score);
  });

  it("zero surpriseMagnitude still penalises — surprises are never free", () => {
    const before = 0.8;
    const after = updateTrust({ current: trustAt(before), outcome: "surprise", surpriseMagnitude: 0 });
    expect(after.score).toBeLessThan(before);
  });

  it("score never goes below 0 on extreme surprise", () => {
    const after = updateTrust({ current: trustAt(0.001), outcome: "surprise", surpriseMagnitude: 1.0 });
    expect(after.score).toBeGreaterThanOrEqual(0);
  });
});

describe("isTrustDegraded", () => {
  it("returns true below the degradation threshold", () => {
    expect(isTrustDegraded({ ...initialTrust(), score: 0.29 })).toBe(true);
  });

  it("returns false above the threshold", () => {
    expect(isTrustDegraded({ ...initialTrust(), score: 0.31 })).toBe(false);
  });

  it("trust is never static — evidence always moves it (invariant 11)", () => {
    const t = initialTrust();
    const afterSuccess = updateTrust({ current: t, outcome: "success" });
    const afterFailure = updateTrust({ current: t, outcome: "failure" });
    expect(afterSuccess.score).not.toBe(t.score);
    expect(afterFailure.score).not.toBe(t.score);
  });
});
