import { describe, it, expect } from "vitest";
import {
  computeActionValue,
  projectHorizon,
  DEFAULT_DISCOUNT,
} from "../../../src/governance";
import type { HorizonStep } from "../../../src/governance";

describe("computeActionValue", () => {
  it("total value equals immediate + discounted future tokens", () => {
    const result = computeActionValue({
      immediateCost: { tokens: 100, durationMs: 1_000 },
      expectedFutureCost: { tokens: 200, durationMs: 2_000 },
      discountFactor: 0.5,
    });
    // totalValue = 100 + round(200 * 0.5) = 200
    expect(result.totalValue).toBe(200);
  });

  it("uses DEFAULT_DISCOUNT when no discountFactor is provided", () => {
    const result = computeActionValue({
      immediateCost: { tokens: 100, durationMs: 1_000 },
      expectedFutureCost: { tokens: 100, durationMs: 1_000 },
    });
    expect(result.totalValue).toBe(100 + Math.round(100 * DEFAULT_DISCOUNT));
  });

  it("lower totalValue means a better (cheaper) path", () => {
    const cheap = computeActionValue({
      immediateCost: { tokens: 50, durationMs: 500 },
      expectedFutureCost: { tokens: 50, durationMs: 500 },
    });
    const expensive = computeActionValue({
      immediateCost: { tokens: 500, durationMs: 5_000 },
      expectedFutureCost: { tokens: 500, durationMs: 5_000 },
    });
    expect(cheap.totalValue).toBeLessThan(expensive.totalValue);
  });

  it("preserves immediateCost and expectedFutureCost unchanged", () => {
    const immediate = { tokens: 100, durationMs: 1_000 };
    const future = { tokens: 200, durationMs: 2_000 };
    const result = computeActionValue({ immediateCost: immediate, expectedFutureCost: future });
    expect(result.immediateCost).toEqual(immediate);
    expect(result.expectedFutureCost).toEqual(future);
  });
});

describe("projectHorizon — normal projection", () => {
  const makeStep = (name: string, tokens: number): HorizonStep => ({
    actionName: name,
    estimatedCost: { tokens, durationMs: tokens * 10 },
    isEpistemicBoundary: false,
  });

  it("projects all steps when no epistemic boundary exists", () => {
    const steps = [makeStep("a", 100), makeStep("b", 100), makeStep("c", 100)];
    const result = projectHorizon({ steps, discountFactor: 1.0 });
    expect(result.stepsTaken).toBe(3);
    expect(result.boundary).toBeUndefined();
    expect(result.totalProjectedCost.tokens).toBe(300);
  });

  it("applies discount factor across steps", () => {
    const steps = [makeStep("a", 100), makeStep("b", 100)];
    const result = projectHorizon({ steps, discountFactor: 0.5 });
    // step 0: 100 * 0.5^0 = 100, step 1: 100 * 0.5^1 = 50 → total 150
    expect(result.totalProjectedCost.tokens).toBe(150);
  });

  it("further steps are discounted more heavily (favour near-term paths)", () => {
    const steps = [makeStep("near", 100), makeStep("far", 100), makeStep("farther", 100)];
    const result = projectHorizon({ steps, discountFactor: 0.5 });
    // 100 + 50 + 25 = 175
    expect(result.totalProjectedCost.tokens).toBe(175);
  });

  it("returns zero cost and zero steps for an empty step list", () => {
    const result = projectHorizon({ steps: [] });
    expect(result.stepsTaken).toBe(0);
    expect(result.totalProjectedCost).toEqual({ tokens: 0, durationMs: 0 });
    expect(result.boundary).toBeUndefined();
  });
});

describe("projectHorizon — epistemic boundary (prohibition 14)", () => {
  it("stops before the first epistemic boundary", () => {
    const steps: HorizonStep[] = [
      { actionName: "safe-a", estimatedCost: { tokens: 100, durationMs: 1_000 }, isEpistemicBoundary: false },
      { actionName: "fetch-data", estimatedCost: { tokens: 200, durationMs: 2_000 }, isEpistemicBoundary: true },
      { actionName: "safe-b", estimatedCost: { tokens: 100, durationMs: 1_000 }, isEpistemicBoundary: false },
    ];
    const result = projectHorizon({ steps, discountFactor: 1.0 });

    // Only step 0 was projected; step 1 (boundary) and step 2 were not.
    expect(result.stepsTaken).toBe(1);
    expect(result.totalProjectedCost.tokens).toBe(100);
    expect(result.boundary).toBeDefined();
    expect(result.boundary?.stoppedAt).toBe(1);
    expect(result.boundary?.reason).toMatch(/"fetch-data"/);
  });

  it("returns zero cost when the very first step is an epistemic boundary", () => {
    const steps: HorizonStep[] = [
      { actionName: "retrieve-memory", estimatedCost: { tokens: 100, durationMs: 500 }, isEpistemicBoundary: true },
    ];
    const result = projectHorizon({ steps });
    expect(result.stepsTaken).toBe(0);
    expect(result.totalProjectedCost.tokens).toBe(0);
    expect(result.boundary?.stoppedAt).toBe(0);
  });

  it("does not include the boundary step's cost (never predict beyond available evidence)", () => {
    const steps: HorizonStep[] = [
      { actionName: "pre", estimatedCost: { tokens: 50, durationMs: 500 }, isEpistemicBoundary: false },
      { actionName: "boundary", estimatedCost: { tokens: 999, durationMs: 9_999 }, isEpistemicBoundary: true },
    ];
    const result = projectHorizon({ steps, discountFactor: 1.0 });
    expect(result.totalProjectedCost.tokens).toBe(50); // boundary cost excluded
  });
});
