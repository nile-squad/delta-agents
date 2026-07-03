/**
 * applyStrategy unit tests.
 *
 * The strategy function converts a declared policy and execution context into
 * a concrete decision. It must be deterministic (same input → same output) and
 * must never bypass the declared policy (prohibition 10).
 *
 * Covers: prohibition 10 (engine never bypasses configured supervision policies).
 */

import { describe, it, expect } from "vitest";
import { applyStrategy } from "../../../src/supervision";
import type { SupervisionPolicy } from "../../../src/shared/types";

const policy = (strategy: SupervisionPolicy["strategy"], maxRetries = 3): SupervisionPolicy => ({
  strategy,
  maxRetries,
});

// ── retry ─────────────────────────────────────────────────────────────────────

describe("applyStrategy — retry", () => {
  it("returns retry when retryCount < maxRetries", () => {
    const result = applyStrategy({ policy: policy("retry", 3), retryCount: 0 });
    expect(result.action).toBe("retry");
  });

  it("returns retry up to but not including maxRetries", () => {
    expect(applyStrategy({ policy: policy("retry", 3), retryCount: 2 }).action).toBe("retry");
  });

  it("returns give-up when retryCount reaches maxRetries", () => {
    const result = applyStrategy({ policy: policy("retry", 3), retryCount: 3 });
    expect(result.action).toBe("give-up");
  });

  it("returns give-up when retryCount exceeds maxRetries", () => {
    const result = applyStrategy({ policy: policy("retry", 3), retryCount: 99 });
    expect(result.action).toBe("give-up");
  });

  it("give-up reason mentions maxRetries", () => {
    const result = applyStrategy({ policy: policy("retry", 2), retryCount: 2 });
    if (result.action === "give-up") {
      expect(result.reason).toMatch(/maxRetries/);
      expect(result.reason).toContain("2");
    }
  });
});

// ── restart ───────────────────────────────────────────────────────────────────

describe("applyStrategy — restart", () => {
  it("returns restart when retryCount < maxRetries", () => {
    const result = applyStrategy({ policy: policy("restart", 2), retryCount: 0 });
    expect(result.action).toBe("restart");
  });

  it("returns give-up when maxRetries exhausted", () => {
    const result = applyStrategy({ policy: policy("restart", 2), retryCount: 2 });
    expect(result.action).toBe("give-up");
  });
});

// ── resume ────────────────────────────────────────────────────────────────────

describe("applyStrategy — resume", () => {
  it("returns resume with checkpointId when checkpoint is available", () => {
    const result = applyStrategy({
      policy: policy("resume", 3),
      retryCount: 0,
      checkpointId: "ckpt_abc",
    });
    expect(result.action).toBe("resume");
    if (result.action === "resume") expect(result.checkpointId).toBe("ckpt_abc");
  });

  it("falls back to restart when no checkpoint is available", () => {
    const result = applyStrategy({
      policy: policy("resume", 3),
      retryCount: 0,
      checkpointId: undefined,
    });
    // Graceful fallback: can still recover from the beginning
    expect(result.action).toBe("restart");
  });

  it("returns give-up when maxRetries exhausted regardless of checkpoint", () => {
    const result = applyStrategy({
      policy: policy("resume", 1),
      retryCount: 1,
      checkpointId: "ckpt_abc",
    });
    expect(result.action).toBe("give-up");
  });
});

// ── escalate ──────────────────────────────────────────────────────────────────

describe("applyStrategy — escalate", () => {
  it("always escalates regardless of retryCount", () => {
    for (const retryCount of [0, 1, 100]) {
      const result = applyStrategy({ policy: policy("escalate"), retryCount });
      expect(result.action).toBe("escalate");
    }
  });

  it("escalate is not subject to maxRetries (not retriable)", () => {
    const result = applyStrategy({ policy: policy("escalate", 0), retryCount: 0 });
    expect(result.action).toBe("escalate");
  });
});

// ── abort-subtree ─────────────────────────────────────────────────────────────

describe("applyStrategy — abort-subtree", () => {
  it("always aborts subtree regardless of retryCount", () => {
    for (const retryCount of [0, 1, 100]) {
      const result = applyStrategy({ policy: policy("abort-subtree"), retryCount });
      expect(result.action).toBe("abort-subtree");
    }
  });
});

// ── abort-tree ────────────────────────────────────────────────────────────────

describe("applyStrategy — abort-tree", () => {
  it("always aborts entire tree regardless of retryCount", () => {
    for (const retryCount of [0, 1, 100]) {
      const result = applyStrategy({ policy: policy("abort-tree"), retryCount });
      expect(result.action).toBe("abort-tree");
    }
  });
});

// ── determinism (prohibition 10) ──────────────────────────────────────────────

describe("applyStrategy — determinism (prohibition 10)", () => {
  it("same inputs always produce the same output", () => {
    const input = { policy: policy("retry", 3), retryCount: 1, checkpointId: "ckpt_x" };
    const r1 = applyStrategy(input);
    const r2 = applyStrategy(input);
    expect(r1).toEqual(r2);
  });

  it("maxRetries: 0 means every first failure is give-up for retriable strategies", () => {
    const result = applyStrategy({ policy: policy("retry", 0), retryCount: 0 });
    expect(result.action).toBe("give-up");
  });

  it("maxRetries: 1 allows exactly one retry attempt (retryCount 0 passes, 1 gives up)", () => {
    expect(applyStrategy({ policy: policy("retry", 1), retryCount: 0 }).action).toBe("retry");
    expect(applyStrategy({ policy: policy("retry", 1), retryCount: 1 }).action).toBe("give-up");
  });
});
