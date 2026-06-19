/**
 * Prerequisite evaluation tests.
 *
 * Covers: invariant 20 (unsatisfied prerequisite → not exposed/executed),
 * prohibition 16 (engine never executes action with unsatisfied prerequisites).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { evaluatePrerequisites } from "../../../src/state-space";
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

const baseState = (): TaskStateSnapshot => ({
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

describe("evaluatePrerequisites — no prerequisites", () => {
  it("returns satisfied when action has no prerequisites", () => {
    const result = evaluatePrerequisites({
      action: makeAction("lookup-customer"),
      state: baseState(),
    });
    expect(result.satisfied).toBe(true);
  });

  it("returns satisfied when prerequisites object is undefined", () => {
    const result = evaluatePrerequisites({
      action: makeAction("lookup-customer", undefined),
      state: baseState(),
    });
    expect(result.satisfied).toBe(true);
  });
});

describe("evaluatePrerequisites — action prerequisites", () => {
  it("returns satisfied when all required actions have completed", () => {
    const result = evaluatePrerequisites({
      action: makeAction("process-order", { actions: ["confirm-order"] }),
      state: { ...baseState(), completedActions: ["confirm-order"] },
    });
    expect(result.satisfied).toBe(true);
  });

  it("returns not-satisfied when a required action has not completed", () => {
    const result = evaluatePrerequisites({
      action: makeAction("process-order", { actions: ["confirm-order"] }),
      state: baseState(), // completedActions is empty
    });
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) expect(result.reason).toMatch(/"confirm-order"/);
  });

  it("returns not-satisfied when only some prerequisites are complete", () => {
    const result = evaluatePrerequisites({
      action: makeAction("release-funds", { actions: ["verify-id", "verify-payment"] }),
      state: { ...baseState(), completedActions: ["verify-id"] }, // verify-payment missing
    });
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) expect(result.reason).toMatch(/"verify-payment"/);
  });

  it("returns satisfied when all of multiple required actions have completed", () => {
    const result = evaluatePrerequisites({
      action: makeAction("release-funds", { actions: ["verify-id", "verify-payment"] }),
      state: { ...baseState(), completedActions: ["verify-id", "verify-payment"] },
    });
    expect(result.satisfied).toBe(true);
  });

  it("an action returning Err does not count as completed (invariant 19)", () => {
    // The state only includes Ok-completed actions. If confirm-order failed,
    // it would not appear in completedActions — tested by its absence here.
    const result = evaluatePrerequisites({
      action: makeAction("process-order", { actions: ["confirm-order"] }),
      state: { ...baseState(), completedActions: [] }, // absent = failed or not run
    });
    expect(result.satisfied).toBe(false);
  });
});

describe("evaluatePrerequisites — workflow prerequisites", () => {
  it("returns satisfied when a required workflow has completed", () => {
    const result = evaluatePrerequisites({
      action: makeAction("release-funds", { workflows: ["fraud-review"] }),
      state: { ...baseState(), completedWorkflows: ["fraud-review"] },
    });
    expect(result.satisfied).toBe(true);
  });

  it("returns not-satisfied when a required workflow has not completed", () => {
    const result = evaluatePrerequisites({
      action: makeAction("release-funds", { workflows: ["fraud-review"] }),
      state: baseState(),
    });
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) expect(result.reason).toMatch(/"fraud-review"/);
  });
});

describe("evaluatePrerequisites — mixed prerequisites", () => {
  it("returns satisfied when both action and workflow prerequisites are complete", () => {
    const result = evaluatePrerequisites({
      action: makeAction("execute-transfer", {
        actions: ["confirm-transfer"],
        workflows: ["kyc-review"],
      }),
      state: {
        ...baseState(),
        completedActions: ["confirm-transfer"],
        completedWorkflows: ["kyc-review"],
      },
    });
    expect(result.satisfied).toBe(true);
  });

  it("returns not-satisfied when workflow prereq is missing despite action being complete", () => {
    const result = evaluatePrerequisites({
      action: makeAction("execute-transfer", {
        actions: ["confirm-transfer"],
        workflows: ["kyc-review"],
      }),
      state: {
        ...baseState(),
        completedActions: ["confirm-transfer"],
        completedWorkflows: [], // kyc-review missing
      },
    });
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) expect(result.reason).toMatch(/"kyc-review"/);
  });
});

describe("evaluatePrerequisites — stress: large prerequisite graph", () => {
  it("evaluates a chain of 100 prerequisites correctly and quickly", () => {
    const count = 100;
    const completedActions = Array.from({ length: count }, (_, i) => `action-${i}`);

    // The 101st action requires all 100 previous actions.
    const finalAction = makeAction("final-action", { actions: completedActions });

    const start = performance.now();
    const result = evaluatePrerequisites({
      action: finalAction,
      state: { ...baseState(), completedActions },
    });
    const elapsed = performance.now() - start;

    expect(result.satisfied).toBe(true);
    // Should evaluate 100 prerequisites in well under 10ms.
    expect(elapsed).toBeLessThan(10);
  });

  it("correctly finds the missing prerequisite in a chain of 100", () => {
    const count = 100;
    // Complete all except action-50.
    const completedActions = Array.from({ length: count }, (_, i) => `action-${i}`)
      .filter((name) => name !== "action-50");

    const finalAction = makeAction("final-action", {
      actions: Array.from({ length: count }, (_, i) => `action-${i}`),
    });

    const result = evaluatePrerequisites({
      action: finalAction,
      state: { ...baseState(), completedActions },
    });

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) expect(result.reason).toMatch(/"action-50"/);
  });
});
