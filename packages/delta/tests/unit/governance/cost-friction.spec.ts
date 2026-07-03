import { describe, it, expect } from "vitest";
import { detectFriction, FRICTION_THRESHOLD } from "../../../src/governance";

describe("detectFriction", () => {
  it("returns stable with ratio 0 when no cost has been spent", () => {
    const result = detectFriction({
      spent: { tokens: 0, durationMs: 0 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.5,
    });
    expect(result.isUnstable).toBe(false);
    expect(result.frictionRatio).toBe(0);
  });

  it("returns stable when cost and progress are proportional (ratio ≈ 1)", () => {
    const result = detectFriction({
      spent: { tokens: 500, durationMs: 30_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.5, // 50% cost, 50% progress → ratio = 1.0
    });
    expect(result.isUnstable).toBe(false);
    expect(result.frictionRatio).toBeCloseTo(1.0, 1);
  });

  it("flags unstable when cost far outpaces progress (loop or spiral)", () => {
    // 80% of budget spent, only 10% progress.
    const result = detectFriction({
      spent: { tokens: 800, durationMs: 48_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.1,
    });
    expect(result.isUnstable).toBe(true);
    expect(result.frictionRatio).toBeGreaterThan(FRICTION_THRESHOLD);
  });

  it("flags unstable when progress is zero with any cost spent", () => {
    const result = detectFriction({
      spent: { tokens: 100, durationMs: 1_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0,
    });
    expect(result.isUnstable).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("caps frictionRatio at 10 regardless of how extreme the input is", () => {
    const result = detectFriction({
      spent: { tokens: 999, durationMs: 59_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.001,
    });
    expect(result.frictionRatio).toBeLessThanOrEqual(10);
  });

  it("includes a reason string when unstable", () => {
    const result = detectFriction({
      spent: { tokens: 900, durationMs: 54_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.05,
    });
    expect(result.isUnstable).toBe(true);
    expect(typeof result.reason).toBe("string");
  });

  it("no reason when stable", () => {
    const result = detectFriction({
      spent: { tokens: 200, durationMs: 12_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.5,
    });
    expect(result.reason).toBeUndefined();
  });

  it("handles zero budget dimensions without dividing by zero", () => {
    expect(() =>
      detectFriction({
        spent: { tokens: 100, durationMs: 0 },
        budget: { tokens: 0, durationMs: 60_000 },
        progressRatio: 0.3,
      }),
    ).not.toThrow();
  });

  it("scores the memory axis when the budget declares it", () => {
    // tokens/durationMs spend is zero, but 80% of the memory budget is consumed
    // against only 10% progress. With memory scored, avgCostRatio = 0.8/3 ≈ 0.267
    // and friction ≈ 2.67, above threshold. If memory were ignored the ratio would
    // be 0 and this would read as stable, so this proves the axis is counted.
    const result = detectFriction({
      spent: { tokens: 0, durationMs: 0, memory: 800 },
      budget: { tokens: 1000, durationMs: 60_000, memory: 1000 },
      progressRatio: 0.1,
    });
    expect(result.isUnstable).toBe(true);
    expect(result.frictionRatio).toBeGreaterThan(FRICTION_THRESHOLD);
  });

  it("ignores an axis the budget does not declare (no dilution)", () => {
    // The budget declares only tokens and durationMs (both at 80% spend). The
    // spent memory is huge but unbudgeted, so it must NOT enter the ratio. The
    // friction is therefore 0.8 / 0.5 = 1.6, exactly as if memory were absent.
    const result = detectFriction({
      spent: { tokens: 800, durationMs: 48_000, memory: 9_999_999 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.5,
    });
    expect(result.frictionRatio).toBeCloseTo(1.6, 5);
  });

  it("frictionRatio is proportional to cost-to-progress imbalance", () => {
    const mild = detectFriction({
      spent: { tokens: 500, durationMs: 30_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.3, // 50% cost, 30% progress
    });
    const severe = detectFriction({
      spent: { tokens: 900, durationMs: 54_000 },
      budget: { tokens: 1000, durationMs: 60_000 },
      progressRatio: 0.1, // 90% cost, 10% progress
    });
    expect(severe.frictionRatio).toBeGreaterThan(mild.frictionRatio);
  });
});
