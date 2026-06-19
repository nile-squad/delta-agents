/**
 * Action discovery tests.
 *
 * Discovery is the mechanism that makes illegal actions invisible to the reasoner.
 * A model cannot request an action it cannot see — this removes entire classes
 * of invalid execution without requiring the model to refuse them.
 *
 * Covers: prohibition 3 (engine never exposes actions invalid in current state),
 * invariant 20 (unsatisfied prerequisites → not exposed).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { discoverActions } from "../../../src/state-space";
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
  taskId: "tsk_disc",
  rootId: "tsk_disc",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 10_000, durationMs: 60_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: { staticRisk: 1, currentRisk: 1, predictedRisk: 1, confidence: 0.9, escalated: false },
  trust: { score: 0.8, successfulExecutions: 0, failedExecutions: 0, surpriseEvents: 0 },
});

describe("discoverActions — basic availability", () => {
  it("returns all actions when all are legal", () => {
    const actions = [makeAction("lookup"), makeAction("notify"), makeAction("update")];
    const { available } = discoverActions({ agentActions: actions, state: runningState() });
    expect(available.map((a) => a.name)).toEqual(["lookup", "notify", "update"]);
  });

  it("returns empty available when task is paused (prohibition 3)", () => {
    const actions = [makeAction("lookup"), makeAction("notify")];
    const { available, blocked } = discoverActions({
      agentActions: actions,
      state: { ...runningState(), status: "paused" },
    });
    expect(available).toHaveLength(0);
    expect(blocked).toHaveLength(2);
  });

  it("returns empty available when task is aborted", () => {
    const actions = [makeAction("lookup")];
    const { available } = discoverActions({
      agentActions: actions,
      state: { ...runningState(), status: "aborted" },
    });
    expect(available).toHaveLength(0);
  });

  it("returns empty available list when no actions exist for the agent", () => {
    const { available, blocked } = discoverActions({
      agentActions: [],
      state: runningState(),
    });
    expect(available).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });
});

describe("discoverActions — prerequisite gating (invariant 20)", () => {
  it("excludes actions whose prerequisites have not been satisfied", () => {
    const lookup = makeAction("lookup");
    const process = makeAction("process-order", { actions: ["confirm-order"] });
    const { available } = discoverActions({
      agentActions: [lookup, process],
      state: runningState(), // confirm-order not completed
    });
    expect(available.map((a) => a.name)).toEqual(["lookup"]);
  });

  it("includes action once its prerequisite completes", () => {
    const lookup = makeAction("lookup");
    const process = makeAction("process-order", { actions: ["confirm-order"] });
    const { available } = discoverActions({
      agentActions: [lookup, process],
      state: { ...runningState(), completedActions: ["confirm-order"] },
    });
    expect(available.map((a) => a.name)).toContain("process-order");
  });

  it("blocked list includes the gated action with its reason", () => {
    const process = makeAction("process-order", { actions: ["confirm-order"] });
    const { blocked } = discoverActions({
      agentActions: [process],
      state: runningState(),
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.action.name).toBe("process-order");
    expect(blocked[0]?.reason).toMatch(/"confirm-order"/);
  });
});

describe("discoverActions — budget gating", () => {
  it("excludes all actions when budget is exhausted", () => {
    const actions = [makeAction("lookup"), makeAction("notify")];
    const { available } = discoverActions({
      agentActions: actions,
      state: {
        ...runningState(),
        budget: { tokens: 100, durationMs: 60_000 },
        spent: { tokens: 101, durationMs: 0 },
      },
    });
    expect(available).toHaveLength(0);
  });
});

describe("discoverActions — escalation gating", () => {
  it("excludes all actions when task is escalated", () => {
    const actions = [makeAction("lookup"), makeAction("notify")];
    const { available } = discoverActions({
      agentActions: actions,
      state: {
        ...runningState(),
        risk: { staticRisk: 5, currentRisk: 5, predictedRisk: 5, confidence: 0.5, escalated: true },
      },
    });
    expect(available).toHaveLength(0);
  });
});

describe("discoverActions — mixed availability", () => {
  it("correctly separates available and blocked actions in one call", () => {
    const lookup = makeAction("lookup");
    const notify = makeAction("notify");
    const processOrder = makeAction("process-order", { actions: ["confirm-order"] });
    const releasePayment = makeAction("release-payment", { workflows: ["fraud-review"] });

    const { available, blocked } = discoverActions({
      agentActions: [lookup, notify, processOrder, releasePayment],
      state: runningState(),
    });

    expect(available.map((a) => a.name)).toEqual(["lookup", "notify"]);
    expect(blocked.map((b) => b.action.name)).toEqual(["process-order", "release-payment"]);
  });

  it("discovery result is a snapshot — does not mutate state", () => {
    const state = runningState();
    const actions = [makeAction("lookup")];
    discoverActions({ agentActions: actions, state });
    // Original state is unchanged
    expect(state.completedActions).toHaveLength(0);
    expect(state.status).toBe("running");
  });
});

describe("discoverActions — stress: 200 actions with varied prerequisites", () => {
  it("correctly filters 200 actions in under 5ms", () => {
    // 100 with no prereqs (should be available), 100 with unsatisfied prereqs (blocked).
    const available = Array.from({ length: 100 }, (_, i) => makeAction(`free-${i}`));
    const gated = Array.from({ length: 100 }, (_, i) =>
      makeAction(`gated-${i}`, { actions: [`missing-prereq-${i}`] }),
    );
    const allActions = [...available, ...gated];

    const start = performance.now();
    const result = discoverActions({ agentActions: allActions, state: runningState() });
    const elapsed = performance.now() - start;

    expect(result.available).toHaveLength(100);
    expect(result.blocked).toHaveLength(100);
    expect(elapsed).toBeLessThan(5);
  });
});
