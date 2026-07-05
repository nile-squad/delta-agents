/**
 * Agent stats integration tests: topAgents, agentStats, workflowStats
 * via the full engine with real store and scripted reasoner.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { initialRiskState, initialTrust } from "../../src/governance";
import type { ReasonerPort, ReasonerInput } from "../../src/ports/reasoner-port";
import type { AgentRanking, AgentStats, WorkflowStats } from "../../src/engine/stats";

const anAction = (delta: Awaited<ReturnType<typeof createDeltaEngine>>, name: string) =>
  delta.action({ name, description: "work", schema: z.object({}), fn: async () => Ok("ok") });

describe("agent-stats integration", () => {
  it("topAgents ranks by completedTasks across deployed agents", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "a1")] };
    delta.deploy(delta.agent({ name: "alice", role: "A", ...base }));
    delta.deploy(delta.agent({ name: "bob", role: "B", ...base }));
    delta.deploy(delta.agent({ name: "charlie", role: "C", ...base }));

    // Run tasks to completion: alice 2, bob 1, charlie 0.
    for (let i = 0; i < 2; i++) {
      await delta.send({ agentName: "alice", goal: `alice work ${i}` });
    }
    await delta.send({ agentName: "bob", goal: "bob work" });

    const result = await delta.topAgents({ by: "completedTasks", limit: 10 });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const rankings = result.value as AgentRanking[];
    expect(rankings).toHaveLength(3); // All agents included.
    expect(rankings[0]!.agent).toBe("alice");
    expect(rankings[0]!.completedTasks).toBe(2);
    expect(rankings[1]!.agent).toBe("bob");
    expect(rankings[1]!.completedTasks).toBe(1);
    expect(rankings[2]!.agent).toBe("charlie");
    expect(rankings[2]!.completedTasks).toBe(0);
  });

  it("topAgents respects limit parameter", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "a1")] };
    delta.deploy(delta.agent({ name: "alice", role: "A", ...base }));
    delta.deploy(delta.agent({ name: "bob", role: "B", ...base }));
    delta.deploy(delta.agent({ name: "charlie", role: "C", ...base }));

    for (let i = 0; i < 3; i++) {
      await delta.send({ agentName: "alice", goal: `work ${i}` });
    }

    const result = await delta.topAgents({ by: "completedTasks", limit: 2 });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(2);
  });

  it("agentStats computes counts, successRate, and non-empty scoreOverTime", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "a1")] };
    delta.deploy(delta.agent({ name: "alice", role: "A", ...base }));

    // Run multiple tasks.
    for (let i = 0; i < 2; i++) {
      await delta.send({ agentName: "alice", goal: `task ${i}` });
    }

    const result = await delta.agentStats({ agent: "alice" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const stats = result.value as AgentStats;
    expect(stats.completedTasks).toBe(2);
    expect(stats.failedTasks).toBe(0);
    expect(stats.successRate).toBe(1);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.scoreOverTime).toHaveLength(2);
    // scoreOverTime should be in ascending order by timestamp.
    expect(stats.scoreOverTime[0]!.at.getTime()).toBeLessThanOrEqual(stats.scoreOverTime[1]!.at.getTime());
  });

  it("agentStats includes avgCost from executions", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "a1")] };
    delta.deploy(delta.agent({ name: "alice", role: "A", ...base }));

    await delta.send({ agentName: "alice", goal: "task 1" });

    const result = await delta.agentStats({ agent: "alice" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const stats = result.value as AgentStats;
    expect(stats.avgCost).toBeDefined();
    expect(stats.avgCost.tokens).toBeGreaterThanOrEqual(0);
    expect(stats.avgCost.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("workflowStats computes runs, success rate, and phase durations", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "a1")] };
    delta.deploy(delta.agent({ name: "alice", role: "A", ...base }));

    // Manually create a task with workflow set and add checkpoints with phases.
    const now = new Date("2024-01-01T00:00:00Z");
    const taskId = `task-${Math.random()}`;
    await store.saveTask({
      id: taskId,
      rootId: taskId,
      status: "completed",
      goal: "test workflow",
      assignedAgent: "alice",
      workflow: "refund-flow",
      budget: { tokens: 100, durationMs: 1000 },
      risk: initialRiskState(),
      trust: initialTrust(),
      createdAt: now,
      updatedAt: new Date(now.getTime() + 10000),
    });

    // Add phase checkpoints.
    await store.saveCheckpoint({
      id: `cp-${Math.random()}`,
      taskId,
      phase: "phase1",
      state: {},
      createdAt: new Date(now.getTime() + 1000),
    });
    await store.saveCheckpoint({
      id: `cp-${Math.random()}`,
      taskId,
      phase: "phase2",
      state: {},
      createdAt: new Date(now.getTime() + 3000),
    });

    const result = await delta.workflowStats({ workflow: "refund-flow" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const stats = result.value as WorkflowStats;
    expect(stats.runs).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBe(1);
    expect(stats.phases).toHaveLength(2);
    expect(stats.phases[0]!.phase).toBe("phase1");
    expect(stats.phases[1]!.phase).toBe("phase2");
  });

  it("unknown agent returns zero-valued stats (not Err)", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const result = await delta.agentStats({ agent: "unknown-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const stats = result.value as AgentStats;
    expect(stats.completedTasks).toBe(0);
    expect(stats.failedTasks).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.scoreOverTime).toHaveLength(0);
  });

  it("unknown workflow returns zero-valued stats (not Err)", async () => {
    const store = createInMemoryStore();
    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });

    const result = await delta.workflowStats({ workflow: "unknown-workflow" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const stats = result.value as WorkflowStats;
    expect(stats.runs).toBe(0);
    expect(stats.phases).toHaveLength(0);
  });

  it("store without optional methods returns Err from facade", async () => {
    // Create a stub store with no optional methods.
    const stubStore = {
      // Required methods only: will make facade fail when stats methods are called.
      getLatestTaskByAgent: async () => Ok(null),
    } as any;

    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store: stubStore });

    const result = await delta.agentStats({ agent: "alice" });
    expect(result.isErr).toBe(true);
  });
});
