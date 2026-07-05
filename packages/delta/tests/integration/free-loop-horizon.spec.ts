/**
 * Free-loop MPC (Model Predictive Control) pre-block integration tests.
 *
 * The free reasoner loop now has a one-step horizon predictive budget check:
 * before executing a proposed action with a declared estimatedCost, project
 * `spent + reasoningCost + estimatedCost` and refuse execution (escalate +
 * pause) when the projection already exceeds the budget. Actions without a
 * declared estimatedCost skip the check entirely (epistemic boundary).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import type { ReasonerPort, ReasonerDecision } from "../../src/ports/reasoner-port";

/** Counter-style reasoner that returns the next call, falling back to "done". */
const counterReasoner = (calls: () => ReasonerDecision[]): ReasonerPort => {
  let i = 0;
  const reasoner: ReasonerPort = {
    reason: async (_input) => Ok(calls()[i++] ?? { kind: "done" }),
  };
  return reasoner;
};

describe("free-loop MPC pre-block", () => {
  it("pre-block fires: action with declared estimatedCost that exceeds remaining budget escalates and blocks before execution", async () => {
    const store = createInMemoryStore();
    let actionExecuted = false;

    const calls: ReasonerDecision[] = [
      {
        kind: "act",
        request: {
          actionName: "expensive",
          input: {},
        },
      },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);

    const delta = await createDeltaEngine({ store, reasoner });

    // Register action first
    const expensiveAction = delta.action({
      name: "expensive",
      description: "costs more than budget allows",
      schema: z.object({}),
      estimatedCost: { tokens: 200, durationMs: 0 }, // exceeds budget of 100 tokens
      fn: async () => {
        actionExecuted = true;
        return Ok("done");
      },
    });

    // Create agent that references the registered action
    const agent = delta.agent({
      name: "test-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [expensiveAction],
    });
    delta.deploy(agent);

    // Budget: 100 tokens. Action costs 200.
    const result = await delta.send({
      goal: "run expensive action",
      agentName: "test-agent",
      budget: { tokens: 100, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // Result should be blocked due to MPC escalation.
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toContain("escalated");
    expect(result.value.reason).toContain("MPC");

    // Action fn must NOT have been called.
    expect(actionExecuted).toBe(false);

    // An escalation with trigger "budget-violation" must exist.
    const escalations = await store.getEscalationsByTask(result.value.taskId);
    expect(escalations.isOk).toBe(true);
    if (!escalations.isOk) return;
    const budgetEscalations = escalations.value.filter((e) => e.trigger === "budget-violation");
    expect(budgetEscalations.length).toBeGreaterThan(0);
  });

  it("epistemic boundary: action with no declared estimatedCost proceeds (no MPC check)", async () => {
    const store = createInMemoryStore();
    let actionExecuted = false;

    const calls: ReasonerDecision[] = [
      {
        kind: "act",
        request: {
          actionName: "uncertain",
          input: {},
        },
      },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);

    const delta = await createDeltaEngine({ store, reasoner });

    // Register action first
    const uncertainAction = delta.action({
      name: "uncertain",
      description: "cost unknown (epistemic boundary)",
      schema: z.object({}),
      // NO estimatedCost declared
      fn: async () => {
        actionExecuted = true;
        return Ok("done");
      },
    });

    // Create agent that references the registered action
    const agent = delta.agent({
      name: "test-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [uncertainAction],
    });
    delta.deploy(agent);

    // Budget: 100 tokens. Action has no estimatedCost.
    const result = await delta.send({
      goal: "run uncertain action",
      agentName: "test-agent",
      budget: { tokens: 100, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // Should complete normally (no MPC block).
    expect(result.value.status).toBe("completed");

    // Action fn MUST have been called.
    expect(actionExecuted).toBe(true);

    // No budget-violation escalation should exist.
    const escalations = await store.getEscalationsByTask(result.value.taskId);
    expect(escalations.isOk).toBe(true);
    if (!escalations.isOk) return;
    const budgetEscalations = escalations.value.filter((e) => e.trigger === "budget-violation");
    expect(budgetEscalations.length).toBe(0);
  });

  it("fits within budget: action with declared estimatedCost that fits executes normally", async () => {
    const store = createInMemoryStore();
    let actionExecuted = false;

    const calls: ReasonerDecision[] = [
      {
        kind: "act",
        request: {
          actionName: "cheap",
          input: {},
        },
      },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);

    const delta = await createDeltaEngine({ store, reasoner });

    // Register action first
    const cheapAction = delta.action({
      name: "cheap",
      description: "affordable action",
      schema: z.object({}),
      estimatedCost: { tokens: 50, durationMs: 0 }, // fits within 100-token budget
      fn: async () => {
        actionExecuted = true;
        return Ok("done");
      },
    });

    // Create agent that references the registered action
    const agent = delta.agent({
      name: "test-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [cheapAction],
    });
    delta.deploy(agent);

    // Budget: 100 tokens. Action costs 50.
    const result = await delta.send({
      goal: "run cheap action",
      agentName: "test-agent",
      budget: { tokens: 100, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // Should complete normally.
    expect(result.value.status).toBe("completed");

    // Action fn MUST have been called.
    expect(actionExecuted).toBe(true);

    // No budget-violation escalation should exist.
    const escalations = await store.getEscalationsByTask(result.value.taskId);
    expect(escalations.isOk).toBe(true);
    if (!escalations.isOk) return;
    const budgetEscalations = escalations.value.filter((e) => e.trigger === "budget-violation");
    expect(budgetEscalations.length).toBe(0);
  });

  it("spend accumulates: second action's declared cost no longer fits after first succeeds; second blocks before execution", async () => {
    const store = createInMemoryStore();
    let firstExecuted = false;
    let secondExecuted = false;

    const calls: ReasonerDecision[] = [
      {
        kind: "act",
        request: {
          actionName: "first",
          input: {},
        },
      },
      {
        kind: "act",
        request: {
          actionName: "second",
          input: {},
          reasoningCost: { tokens: 45, durationMs: 0 }, // Simulate token consumption: 45 + 60 = 105 > 100
        },
      },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);

    const delta = await createDeltaEngine({ store, reasoner });

    // Register actions first
    const firstAction = delta.action({
      name: "first",
      description: "first step",
      schema: z.object({}),
      estimatedCost: { tokens: 60, durationMs: 0 }, // fits
      fn: async () => {
        firstExecuted = true;
        return Ok("done");
      },
    });

    const secondAction = delta.action({
      name: "second",
      description: "second step",
      schema: z.object({}),
      estimatedCost: { tokens: 60, durationMs: 0 }, // would push to 120, exceeds 100
      fn: async () => {
        secondExecuted = true;
        return Ok("done");
      },
    });

    // Create agent that references the registered actions
    const agent = delta.agent({
      name: "test-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [firstAction, secondAction],
    });
    delta.deploy(agent);

    // Budget: 100 tokens.
    const result = await delta.send({
      goal: "run two actions",
      agentName: "test-agent",
      budget: { tokens: 100, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // Result should be blocked due to MPC escalation on second action.
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toContain("escalated");
    expect(result.value.reason).toContain("MPC");

    // First action MUST have executed.
    expect(firstExecuted).toBe(true);

    // Second action MUST NOT have executed.
    expect(secondExecuted).toBe(false);

    // An escalation with trigger "budget-violation" must exist.
    const escalations = await store.getEscalationsByTask(result.value.taskId);
    expect(escalations.isOk).toBe(true);
    if (!escalations.isOk) return;
    const budgetEscalations = escalations.value.filter((e) => e.trigger === "budget-violation");
    expect(budgetEscalations.length).toBeGreaterThan(0);
  });

  it("reasoning cost is included in the projection", async () => {
    const store = createInMemoryStore();
    let actionExecuted = false;

    const calls: ReasonerDecision[] = [
      {
        kind: "act",
        request: {
          actionName: "borderline",
          input: {},
          reasoningCost: { tokens: 30, durationMs: 0 }, // 30 reasoning + 30 action = 60, fits in 60-token budget
        },
      },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);

    const delta = await createDeltaEngine({ store, reasoner });

    // Register action first
    const borderlineAction = delta.action({
      name: "borderline",
      description: "action cost equals remaining budget",
      schema: z.object({}),
      estimatedCost: { tokens: 30, durationMs: 0 },
      fn: async () => {
        actionExecuted = true;
        return Ok("done");
      },
    });

    // Create agent that references the registered action
    const agent = delta.agent({
      name: "test-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [borderlineAction],
    });
    delta.deploy(agent);

    // Budget: 60 tokens. Reasoning: 30. Action: 30. Total: 60 (fits).
    const result = await delta.send({
      goal: "run borderline action",
      agentName: "test-agent",
      budget: { tokens: 60, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // Should complete normally (borderline case, projection is exactly at budget).
    expect(result.value.status).toBe("completed");

    // Action fn MUST have been called.
    expect(actionExecuted).toBe(true);
  });

  it("reasoning cost + action cost exceeds budget: MPC blocks even when each fits alone", async () => {
    const store = createInMemoryStore();
    let actionExecuted = false;

    const calls: ReasonerDecision[] = [
      {
        kind: "act",
        request: {
          actionName: "combined",
          input: {},
          reasoningCost: { tokens: 55, durationMs: 0 }, // 55 reasoning + 55 action = 110, exceeds 100
        },
      },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);

    const delta = await createDeltaEngine({ store, reasoner });

    // Register action first
    const combinedAction = delta.action({
      name: "combined",
      description: "action cost that combines with reasoning to exceed budget",
      schema: z.object({}),
      estimatedCost: { tokens: 55, durationMs: 0 },
      fn: async () => {
        actionExecuted = true;
        return Ok("done");
      },
    });

    // Create agent that references the registered action
    const agent = delta.agent({
      name: "test-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [combinedAction],
    });
    delta.deploy(agent);

    // Budget: 100 tokens. Reasoning: 55. Action: 55. Total: 110 (exceeds).
    const result = await delta.send({
      goal: "run combined action",
      agentName: "test-agent",
      budget: { tokens: 100, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // Result should be blocked due to MPC escalation.
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toContain("escalated");

    // Action fn MUST NOT have been called.
    expect(actionExecuted).toBe(false);

    // An escalation with trigger "budget-violation" must exist.
    const escalations = await store.getEscalationsByTask(result.value.taskId);
    expect(escalations.isOk).toBe(true);
    if (!escalations.isOk) return;
    const budgetEscalations = escalations.value.filter((e) => e.trigger === "budget-violation");
    expect(budgetEscalations.length).toBeGreaterThan(0);
  });
});
