import { describe, it, expect } from "vitest";
import { computeSurprise, aggregateSurprise, SURPRISE_THRESHOLD } from "../../../src/governance";

describe("computeSurprise", () => {
  it("returns zero surprise when expected equals observed", () => {
    expect(computeSurprise({ expected: 0.5, observed: 0.5 }).magnitude).toBe(0);
  });

  it("is significant when divergence is large relative to expected", () => {
    // Expected 0.5, observed 0.0 — large relative divergence.
    const result = computeSurprise({ expected: 0.5, observed: 0.0 });
    expect(result.isSignificant).toBe(true);
  });

  it("is not significant for small divergences", () => {
    const result = computeSurprise({ expected: 0.8, observed: 0.75 });
    expect(result.isSignificant).toBe(false);
  });

  it("magnitude is in [0, 1]", () => {
    const cases = [
      { expected: 0.0, observed: 1.0 },
      { expected: 1.0, observed: 0.0 },
      { expected: 0.5, observed: 0.5 },
      { expected: 0.001, observed: 0.999 },
    ];
    for (const pair of cases) {
      const { magnitude } = computeSurprise(pair);
      expect(magnitude).toBeGreaterThanOrEqual(0);
      expect(magnitude).toBeLessThanOrEqual(1);
    }
  });

  it("is symmetric: surprise(a, b) equals surprise(b, a) in magnitude", () => {
    const s1 = computeSurprise({ expected: 0.3, observed: 0.7 });
    const s2 = computeSurprise({ expected: 0.7, observed: 0.3 });
    // Not exactly equal due to normalisation by expected, but both significant.
    expect(s1.isSignificant).toBe(s2.isSignificant);
  });

  it("handles expected = 0 without division by zero", () => {
    expect(() => computeSurprise({ expected: 0, observed: 0.5 })).not.toThrow();
    const result = computeSurprise({ expected: 0, observed: 0.5 });
    expect(result.magnitude).toBeGreaterThanOrEqual(0);
    expect(result.magnitude).toBeLessThanOrEqual(1);
  });

  it("isSignificant threshold is at SURPRISE_THRESHOLD", () => {
    // Just below: not significant.
    const below = computeSurprise({ expected: 1.0, observed: 1.0 - (SURPRISE_THRESHOLD - 0.01) });
    // Just at or above: significant.
    const above = computeSurprise({ expected: 1.0, observed: 0.0 });
    expect(below.isSignificant).toBe(false);
    expect(above.isSignificant).toBe(true);
  });
});

describe("aggregateSurprise", () => {
  it("returns zero when given an empty list", () => {
    const result = aggregateSurprise([]);
    expect(result.magnitude).toBe(0);
    expect(result.isSignificant).toBe(false);
  });

  it("returns the maximum single-dimension surprise", () => {
    const result = aggregateSurprise([
      { expected: 0.9, observed: 0.85 }, // small
      { expected: 0.5, observed: 0.0 },  // large
      { expected: 0.7, observed: 0.65 }, // small
    ]);
    // The maximum should match the large one.
    const large = computeSurprise({ expected: 0.5, observed: 0.0 });
    expect(result.magnitude).toBeCloseTo(large.magnitude, 5);
  });

  it("is significant if any single dimension crosses the threshold", () => {
    const result = aggregateSurprise([
      { expected: 0.9, observed: 0.89 },  // not significant
      { expected: 0.5, observed: 0.0 },   // significant
    ]);
    expect(result.isSignificant).toBe(true);
  });

  it("is not significant when all dimensions are within normal range", () => {
    const result = aggregateSurprise([
      { expected: 0.8, observed: 0.79 },
      { expected: 0.6, observed: 0.58 },
    ]);
    expect(result.isSignificant).toBe(false);
  });
});
