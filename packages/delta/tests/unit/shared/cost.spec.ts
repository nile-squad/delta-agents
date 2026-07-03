/**
 * Cost arithmetic tests — the multi-axis resource vector (tokens, durationMs,
 * memory, latency, money). The optional axes must be backward-compatible: plain
 * { tokens, durationMs } costs keep their shape, and a budget enforces an
 * optional axis only when it declares a limit for it.
 */

import { describe, it, expect } from "vitest";
import { addCosts, costRatio, isOverBudget, remainingCost, zeroCost } from "../../../src/shared/cost";

describe("addCosts", () => {
  it("sums tokens and durationMs and keeps a plain shape when no optional axes", () => {
    expect(addCosts({ tokens: 1, durationMs: 2 }, { tokens: 3, durationMs: 4 })).toEqual({ tokens: 4, durationMs: 6 });
  });

  it("sums memory and latency when either operand carries them", () => {
    const result = addCosts({ tokens: 1, durationMs: 0, memory: 100 }, { tokens: 0, durationMs: 0, latency: 5 });
    expect(result).toEqual({ tokens: 1, durationMs: 0, memory: 100, latency: 5 });
  });

  it("sums money when either operand carries it", () => {
    const result = addCosts(
      { tokens: 1, durationMs: 0, money: { value: 50, currency: "USD" } },
      { tokens: 0, durationMs: 0, money: { value: 30, currency: "USD" } },
    );
    expect(result).toEqual({ tokens: 1, durationMs: 0, money: { value: 80, currency: "USD" } });
  });

  it("treats missing money as zero when the other operand has money", () => {
    const result = addCosts({ tokens: 1, durationMs: 0, money: { value: 100, currency: "USD" } }, { tokens: 2, durationMs: 0 });
    expect(result).toEqual({ tokens: 3, durationMs: 0, money: { value: 100, currency: "USD" } });
  });
});

describe("isOverBudget", () => {
  it("enforces tokens and durationMs always", () => {
    expect(isOverBudget({ tokens: 11, durationMs: 0 }, { tokens: 10, durationMs: 100 })).toBe(true);
    expect(isOverBudget({ tokens: 0, durationMs: 101 }, { tokens: 10, durationMs: 100 })).toBe(true);
    expect(isOverBudget({ tokens: 5, durationMs: 50 }, { tokens: 10, durationMs: 100 })).toBe(false);
  });

  it("ignores a memory cost when the budget declares no memory limit (unlimited, not zero)", () => {
    expect(isOverBudget({ tokens: 0, durationMs: 0, memory: 9_999 }, { tokens: 10, durationMs: 100 })).toBe(false);
  });

  it("enforces memory only when the budget declares a memory limit", () => {
    expect(isOverBudget({ tokens: 0, durationMs: 0, memory: 200 }, { tokens: 10, durationMs: 100, memory: 100 })).toBe(true);
    expect(isOverBudget({ tokens: 0, durationMs: 0, memory: 50 }, { tokens: 10, durationMs: 100, memory: 100 })).toBe(false);
  });

  it("enforces latency only when the budget declares a latency limit", () => {
    expect(isOverBudget({ tokens: 0, durationMs: 0, latency: 500 }, { tokens: 10, durationMs: 100, latency: 200 })).toBe(true);
    expect(isOverBudget({ tokens: 0, durationMs: 0, latency: 500 }, { tokens: 10, durationMs: 100 })).toBe(false);
  });

  it("enforces money only when the budget declares a money limit", () => {
    expect(
      isOverBudget(
        { tokens: 0, durationMs: 0, money: { value: 200, currency: "USD" } },
        { tokens: 10, durationMs: 100, money: { value: 100, currency: "USD" } },
      ),
    ).toBe(true);
    expect(
      isOverBudget(
        { tokens: 0, durationMs: 0, money: { value: 50, currency: "USD" } },
        { tokens: 10, durationMs: 100, money: { value: 100, currency: "USD" } },
      ),
    ).toBe(false);
  });

  it("ignores a money cost when the budget declares no money limit (unlimited, not zero)", () => {
    expect(isOverBudget({ tokens: 0, durationMs: 0, money: { value: 9_999, currency: "USD" } }, { tokens: 10, durationMs: 100 })).toBe(
      false,
    );
  });
});

describe("remainingCost", () => {
  it("reports memory/latency headroom only when total declares that axis", () => {
    expect(remainingCost({ tokens: 100, durationMs: 100, memory: 1_000 }, { tokens: 40, durationMs: 0, memory: 250 }))
      .toEqual({ tokens: 60, durationMs: 100, memory: 750 });
    expect(remainingCost({ tokens: 100, durationMs: 100 }, zeroCost())).toEqual({ tokens: 100, durationMs: 100 });
  });

  it("clamps each axis to zero", () => {
    expect(remainingCost({ tokens: 10, durationMs: 10, memory: 10 }, { tokens: 99, durationMs: 99, memory: 99 }))
      .toEqual({ tokens: 0, durationMs: 0, memory: 0 });
  });

  it("reports money headroom only when total declares that axis", () => {
    expect(
      remainingCost(
        { tokens: 100, durationMs: 100, money: { value: 500, currency: "USD" } },
        { tokens: 40, durationMs: 0, money: { value: 150, currency: "USD" } },
      ),
    ).toEqual({ tokens: 60, durationMs: 100, money: { value: 350, currency: "USD" } });
    expect(
      remainingCost({ tokens: 100, durationMs: 100 }, { tokens: 40, durationMs: 0, money: { value: 50, currency: "USD" } }),
    ).toEqual({ tokens: 60, durationMs: 100 });
  });

  it("clamps money headroom to zero", () => {
    expect(
      remainingCost(
        { tokens: 10, durationMs: 10, money: { value: 10, currency: "USD" } },
        { tokens: 0, durationMs: 0, money: { value: 99, currency: "USD" } },
      ),
    ).toEqual({ tokens: 10, durationMs: 10, money: { value: 0, currency: "USD" } });
  });
});

describe("costRatio", () => {
  it("includes money ratio when budget declares a money limit", () => {
    const result = costRatio(
      { tokens: 5, durationMs: 50, money: { value: 25, currency: "USD" } },
      { tokens: 10, durationMs: 100, money: { value: 100, currency: "USD" } },
    );
    expect(result).toEqual({ tokens: 0.5, durationMs: 0.5, money: 0.25 });
  });

  it("omits money when budget has no money limit", () => {
    const result = costRatio({ tokens: 5, durationMs: 50, money: { value: 25, currency: "USD" } }, { tokens: 10, durationMs: 100 });
    expect(result).toEqual({ tokens: 0.5, durationMs: 0.5 });
    expect(result.money).toBeUndefined();
  });

  it("handles zero money budget safely", () => {
    const result = costRatio(
      { tokens: 5, durationMs: 50, money: { value: 10, currency: "USD" } },
      { tokens: 10, durationMs: 100, money: { value: 0, currency: "USD" } },
    );
    expect(result.money).toBe(0);
  });
});
