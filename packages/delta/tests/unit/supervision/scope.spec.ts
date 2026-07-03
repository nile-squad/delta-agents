/**
 * Subtask budget scope enforcement tests.
 *
 * A subtask must never receive more budget than its parent has remaining.
 * enforceSubtaskScope clamps; isWithinParentScope checks without modifying.
 *
 * Covers: invariant 18; prohibitions 7, 8.
 */

import { describe, it, expect } from "vitest";
import { enforceSubtaskScope, isWithinParentScope } from "../../../src/supervision";
import type { Cost } from "../../../src/shared/types";

const cost = (tokens: number, durationMs: number): Cost => ({ tokens, durationMs });

// ── enforceSubtaskScope ───────────────────────────────────────────────────────

describe("enforceSubtaskScope — clamps to parent remaining (invariant 18)", () => {
  it("returns requested budget unchanged when it fits within parent remaining", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(500, 10_000),
      parentBudget: cost(1_000, 30_000),
      parentSpent: cost(0, 0),
    });
    expect(result).toEqual(cost(500, 10_000));
  });

  it("clamps token budget to parent remaining tokens when requested exceeds available", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(1_000, 10_000),
      parentBudget: cost(1_000, 30_000),
      parentSpent: cost(700, 0), // 300 tokens remaining
    });
    expect(result.tokens).toBe(300);
  });

  it("clamps duration budget to parent remaining durationMs", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(500, 60_000),
      parentBudget: cost(1_000, 30_000),
      parentSpent: cost(0, 25_000), // 5_000ms remaining
    });
    expect(result.durationMs).toBe(5_000);
  });

  it("clamps both axes independently", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(2_000, 120_000),
      parentBudget: cost(1_000, 60_000),
      parentSpent: cost(600, 50_000), // 400 tokens, 10_000ms remaining
    });
    expect(result.tokens).toBe(400);
    expect(result.durationMs).toBe(10_000);
  });

  it("returns zero when parent has no remaining tokens (prohibition 7)", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(1_000, 30_000),
      parentBudget: cost(1_000, 60_000),
      parentSpent: cost(1_000, 0), // tokens exhausted
    });
    expect(result.tokens).toBe(0);
  });

  it("returns zero durationMs when parent has no remaining time", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(500, 30_000),
      parentBudget: cost(1_000, 30_000),
      parentSpent: cost(0, 30_000), // time exhausted
    });
    expect(result.durationMs).toBe(0);
  });

  it("returns zero budget when parent has spent everything", () => {
    const result = enforceSubtaskScope({
      requestedBudget: cost(1_000, 60_000),
      parentBudget: cost(1_000, 60_000),
      parentSpent: cost(1_000, 60_000), // fully spent
    });
    expect(result).toEqual(cost(0, 0));
  });

  it("subtask can never exceed parent remaining — enforced on both axes simultaneously", () => {
    for (let i = 0; i <= 10; i++) {
      const parentSpent = cost(i * 100, i * 5_000);
      const parentBudget = cost(1_000, 50_000);
      const result = enforceSubtaskScope({
        requestedBudget: cost(999, 49_999),
        parentBudget,
        parentSpent,
      });
      const remaining = {
        tokens: Math.max(0, parentBudget.tokens - parentSpent.tokens),
        durationMs: Math.max(0, parentBudget.durationMs - parentSpent.durationMs),
      };
      expect(result.tokens).toBeLessThanOrEqual(remaining.tokens);
      expect(result.durationMs).toBeLessThanOrEqual(remaining.durationMs);
    }
  });
});

// ── isWithinParentScope ───────────────────────────────────────────────────────

describe("isWithinParentScope — scope check predicate", () => {
  it("returns true when proposed budget fits within remaining", () => {
    expect(
      isWithinParentScope({
        proposedBudget: cost(300, 10_000),
        parentBudget: cost(1_000, 30_000),
        parentSpent: cost(0, 0),
      }),
    ).toBe(true);
  });

  it("returns false when proposed tokens exceed remaining", () => {
    expect(
      isWithinParentScope({
        proposedBudget: cost(500, 5_000),
        parentBudget: cost(1_000, 30_000),
        parentSpent: cost(700, 0), // 300 remaining
      }),
    ).toBe(false);
  });

  it("returns false when proposed durationMs exceeds remaining", () => {
    expect(
      isWithinParentScope({
        proposedBudget: cost(100, 20_000),
        parentBudget: cost(1_000, 30_000),
        parentSpent: cost(0, 25_000), // 5_000ms remaining
      }),
    ).toBe(false);
  });

  it("returns true when proposed budget exactly equals remaining (boundary)", () => {
    expect(
      isWithinParentScope({
        proposedBudget: cost(300, 5_000),
        parentBudget: cost(1_000, 30_000),
        parentSpent: cost(700, 25_000), // exactly 300 tokens and 5_000ms left
      }),
    ).toBe(true);
  });
});
