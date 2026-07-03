/**
 * Markov legality check tests.
 *
 * The legality check is the spine of the state-space safety model.
 * Every path that could allow an illegal action execution is tested here.
 *
 * Covers: invariants 6, 7, 18, 20; prohibitions 2, 3, 16.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { checkLegality } from "../../../src/state-space";
import type { TaskStateSnapshot } from "../../../src/state-space";
import type { Action } from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ id: z.string() });
const fn = async () => Ok("ok");

const makeAction = (name: string, prerequisites?: Action["prerequisites"]): Action => ({
  name,
  description: `${name} description`,
  schema,
  fn,
  prerequisites,
});

const runningState = (): TaskStateSnapshot => ({
  taskId: "tsk_test",
  rootId: "tsk_test",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 10_000, durationMs: 60_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: { staticRisk: 1, currentRisk: 1, predictedRisk: 1, confidence: 0.9, escalated: false },
  trust: { score: 0.8, successfulExecutions: 0, failedExecutions: 0, surpriseEvents: 0 },
});

describe("checkLegality — task status", () => {
  it("returns legal for a running task with no constraints violated", () => {
    const result = checkLegality({ action: makeAction("lookup"), state: runningState() });
    expect(result.legal).toBe(true);
  });

  it("returns illegal when task is paused", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: { ...runningState(), status: "paused" },
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/"paused"/);
  });

  it("returns illegal when task is aborted (prohibition 11: no execution after abort)", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: { ...runningState(), status: "aborted" },
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/"aborted"/);
  });

  it("returns illegal when task is completed", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: { ...runningState(), status: "completed" },
    });
    expect(result.legal).toBe(false);
  });

  it("returns illegal when task is failed", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: { ...runningState(), status: "failed" },
    });
    expect(result.legal).toBe(false);
  });

  it("returns illegal when task is pending (not yet running)", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: { ...runningState(), status: "pending" },
    });
    expect(result.legal).toBe(false);
  });
});

describe("checkLegality — budget constraints", () => {
  it("returns legal when spent is under budget on all dimensions", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: { ...runningState(), spent: { tokens: 500, durationMs: 1_000 } },
    });
    expect(result.legal).toBe(true);
  });

  it("returns illegal when token budget is exhausted", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: {
        ...runningState(),
        budget: { tokens: 100, durationMs: 60_000 },
        spent: { tokens: 101, durationMs: 0 },
      },
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/budget/);
  });

  it("returns illegal when duration budget is exhausted", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: {
        ...runningState(),
        budget: { tokens: 10_000, durationMs: 1_000 },
        spent: { tokens: 0, durationMs: 1_001 },
      },
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/budget/);
  });

  it("returns illegal when parent budget is exhausted (subtask scope — invariant 18)", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: {
        ...runningState(),
        parentBudget: { tokens: 500, durationMs: 10_000 },
        parentSpent: { tokens: 501, durationMs: 0 },
      },
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/parent budget/);
  });

  it("returns legal when parent budget exists but is not exhausted", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: {
        ...runningState(),
        parentBudget: { tokens: 1_000, durationMs: 30_000 },
        parentSpent: { tokens: 100, durationMs: 500 },
      },
    });
    expect(result.legal).toBe(true);
  });
});

describe("checkLegality — risk escalation", () => {
  it("returns illegal when task is escalated (awaiting human oversight)", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: {
        ...runningState(),
        risk: { staticRisk: 3, currentRisk: 5, predictedRisk: 5, confidence: 0.9, escalated: true },
      },
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/escalated/);
  });

  it("returns legal when risk is high but not yet escalated", () => {
    const result = checkLegality({
      action: makeAction("lookup"),
      state: {
        ...runningState(),
        risk: { staticRisk: 4, currentRisk: 4, predictedRisk: 4, confidence: 0.7, escalated: false },
      },
    });
    expect(result.legal).toBe(true);
  });
});

describe("checkLegality — prerequisites (invariant 20, prohibition 16)", () => {
  it("returns illegal when a prerequisite action has not completed", () => {
    const result = checkLegality({
      action: makeAction("process-order", { actions: ["confirm-order"] }),
      state: runningState(), // no completed actions
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/"confirm-order"/);
  });

  it("returns legal once the prerequisite action completes", () => {
    const result = checkLegality({
      action: makeAction("process-order", { actions: ["confirm-order"] }),
      state: { ...runningState(), completedActions: ["confirm-order"] },
    });
    expect(result.legal).toBe(true);
  });

  it("returns illegal when a prerequisite workflow has not completed", () => {
    const result = checkLegality({
      action: makeAction("release-funds", { workflows: ["kyc-review"] }),
      state: runningState(),
    });
    expect(result.legal).toBe(false);
    if (!result.legal) expect(result.reason).toMatch(/"kyc-review"/);
  });
});

describe("checkLegality — Markov property", () => {
  it("same state always produces same legality result (deterministic)", () => {
    const state = runningState();
    const action = makeAction("lookup");
    const r1 = checkLegality({ action, state });
    const r2 = checkLegality({ action, state });
    expect(r1.legal).toBe(r2.legal);
  });

  it("legality depends only on current state, not on which actions were attempted before", () => {
    // An action that failed previously has no effect on current legality
    // (failed actions do not appear in completedActions).
    const stateA = runningState();
    const stateB = { ...runningState(), completedActions: [] }; // same as A

    const action = makeAction("lookup");
    expect(checkLegality({ action, state: stateA }).legal).toBe(
      checkLegality({ action, state: stateB }).legal,
    );
  });
});
