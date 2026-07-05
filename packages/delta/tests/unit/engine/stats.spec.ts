/**
 * Unit tests for stats compute functions: topAgents, agentStats, workflowStats.
 *
 * Hand-built Task/Execution/Checkpoint fixtures test sorting, zero-division,
 * fallback values, and edge cases like repeated phases (retries).
 */

import { describe, it, expect } from "vitest";
import { Ok } from "slang-ts";
import { computeTopAgents, computeAgentStats, computeWorkflowStats } from "../../../src/engine/stats";
import { initialRiskState, initialTrust } from "../../../src/governance";
import { createInMemoryStore } from "../../../src/ports";
import type { StoragePort } from "../../../src/ports/storage-port";
import type { Task, Execution, Checkpoint } from "../../../src/shared/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const task = (
  id: string,
  agent: string,
  status: "completed" | "failed" | "aborted" | "running",
  workflow?: string,
  createdAt?: Date,
  updatedAt?: Date,
): Task => ({
  id,
  rootId: id,
  status,
  goal: `goal-${id}`,
  assignedAgent: agent,
  workflow,
  budget: { tokens: 100, durationMs: 1000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: createdAt ?? new Date("2024-01-01T00:00:00Z"),
  updatedAt: updatedAt ?? new Date("2024-01-01T01:00:00Z"),
});

const execution = (
  id: string,
  taskId: string,
  cost: { tokens: number; durationMs: number } = { tokens: 100, durationMs: 500 },
): Execution => ({
  id,
  taskId,
  action: `action-${id}`,
  startedAt: new Date(),
  endedAt: new Date(),
  status: "completed",
  cost,
});

const checkpoint = (
  id: string,
  taskId: string,
  phase?: string,
  createdAt?: Date,
): Checkpoint => ({
  id,
  taskId,
  phase,
  state: {},
  createdAt: createdAt ?? new Date(),
});

describe("computeTopAgents", () => {
  it("ranks agents by completedTasks", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "completed"));
    await store.saveTask(task("t2", "alice", "completed"));
    await store.saveTask(task("t3", "bob", "completed"));

    const result = await computeTopAgents({
      store,
      agentNames: ["alice", "bob", "charlie"],
      by: "completedTasks",
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(3);
    expect(result.value[0]!.agent).toBe("alice");
    expect(result.value[0]!.completedTasks).toBe(2);
    expect(result.value[1]!.agent).toBe("bob");
    expect(result.value[1]!.completedTasks).toBe(1);
    expect(result.value[2]!.agent).toBe("charlie");
    expect(result.value[2]!.completedTasks).toBe(0);
  });

  it("ties break by completedTasks then name asc", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "completed"));
    await store.saveTask(task("t2", "bob", "completed"));

    const result = await computeTopAgents({
      store,
      agentNames: ["alice", "bob"],
      by: "successRate",
      limit: 10,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // Both have successRate 1.0; tie breaks by completedTasks (both 1), then name.
    expect(result.value[0]!.agent).toBe("alice");
    expect(result.value[1]!.agent).toBe("bob");
  });

  it("respects limit", async () => {
    const store = createInMemoryStore();
    for (let i = 0; i < 15; i++) {
      await store.saveTask(task(`t${i}`, `agent-${i % 3}`, "completed"));
    }

    const result = await computeTopAgents({
      store,
      agentNames: ["agent-0", "agent-1", "agent-2"],
      by: "completedTasks",
      limit: 2,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(2);
  });

  it("returns Err when store lacks getTasksByAgent", async () => {
    const store = { getLatestTaskByAgent: async () => Ok(null) } as unknown as StoragePort;
    const result = await computeTopAgents({
      store,
      agentNames: ["alice"],
      by: "completedTasks",
    });
    expect(result.isErr).toBe(true);
  });

  it("includes agents with zero tasks", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "completed"));

    const result = await computeTopAgents({
      store,
      agentNames: ["alice", "bob"],
      by: "completedTasks",
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const bob = result.value.find((r) => r.agent === "bob");
    expect(bob).toBeDefined();
    expect(bob!.completedTasks).toBe(0);
    expect(bob!.trustScore).toBe(0.5); // initialTrust
  });

  it("computes trustScore from most recent task", async () => {
    const store = createInMemoryStore();
    const t1 = task("t1", "alice", "completed");
    t1.trust.score = 0.3;
    const t2 = task("t2", "alice", "completed");
    t2.trust.score = 0.8;
    t2.updatedAt = new Date("2024-01-02T00:00:00Z"); // More recent
    await store.saveTask(t1);
    await store.saveTask(t2);

    const result = await computeTopAgents({
      store,
      agentNames: ["alice"],
      by: "trustScore",
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value[0]!.trustScore).toBe(0.8);
  });

  it("successRate is 0 when no settled tasks", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "running"));

    const result = await computeTopAgents({
      store,
      agentNames: ["alice"],
      by: "successRate",
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value[0]!.successRate).toBe(0);
  });

  it("counts failed and aborted as failedTasks", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "failed"));
    await store.saveTask(task("t2", "alice", "aborted"));
    await store.saveTask(task("t3", "alice", "completed"));

    const result = await computeTopAgents({
      store,
      agentNames: ["alice"],
      by: "completedTasks",
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value[0]!.failedTasks).toBe(2);
    expect(result.value[0]!.completedTasks).toBe(1);
  });
});

describe("computeAgentStats", () => {
  it("computes stats for one agent", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "completed", undefined, new Date("2024-01-01"), new Date("2024-01-01T01:00:00Z")));
    await store.saveExecution(execution("e1", "t1", { tokens: 100, durationMs: 3600000 }));

    const result = await computeAgentStats({ store, agent: "alice" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.completedTasks).toBe(1);
    expect(result.value.failedTasks).toBe(0);
    expect(result.value.successRate).toBe(1);
    expect(result.value.avgDurationMs).toBe(3600000); // 1 hour in ms
  });

  it("returns zero-valued stats for unknown agent", async () => {
    const store = createInMemoryStore();
    const result = await computeAgentStats({ store, agent: "unknown" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.completedTasks).toBe(0);
    expect(result.value.successRate).toBe(0);
    expect(result.value.scoreOverTime).toEqual([]);
  });

  it("scoreOverTime is ascending by updatedAt", async () => {
    const store = createInMemoryStore();
    const t1 = task("t1", "alice", "completed", undefined, new Date("2024-01-01"), new Date("2024-01-01T00:00:00Z"));
    t1.trust.score = 0.3;
    const t2 = task("t2", "alice", "completed", undefined, new Date("2024-01-01"), new Date("2024-01-01T02:00:00Z"));
    t2.trust.score = 0.6;
    const t3 = task("t3", "alice", "completed", undefined, new Date("2024-01-01"), new Date("2024-01-01T01:00:00Z"));
    t3.trust.score = 0.5;
    await store.saveTask(t1);
    await store.saveTask(t2);
    await store.saveTask(t3);

    const result = await computeAgentStats({ store, agent: "alice" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.scoreOverTime).toHaveLength(3);
    expect(result.value.scoreOverTime[0]!.score).toBe(0.3); // t1
    expect(result.value.scoreOverTime[1]!.score).toBe(0.5); // t3
    expect(result.value.scoreOverTime[2]!.score).toBe(0.6); // t2
  });

  it("avgCost sums and averages execution costs", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "completed"));
    await store.saveExecution(execution("e1", "t1", { tokens: 100, durationMs: 1000 }));
    await store.saveExecution(execution("e2", "t1", { tokens: 200, durationMs: 2000 }));

    const result = await computeAgentStats({ store, agent: "alice" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // Total: 300 tokens, 3000 ms; averaged over 1 task: 300, 3000.
    expect(result.value.avgCost.tokens).toBe(300);
    expect(result.value.avgCost.durationMs).toBe(3000);
  });

  it("returns Err when store lacks getTasksByAgent", async () => {
    const store = { getLatestTaskByAgent: async () => Ok(null) } as unknown as StoragePort;
    const result = await computeAgentStats({ store, agent: "alice" });
    expect(result.isErr).toBe(true);
  });
});

describe("computeWorkflowStats", () => {
  it("computes stats for one workflow", async () => {
    const store = createInMemoryStore();
    await store.saveTask(task("t1", "alice", "completed", "refund-flow"));
    await store.saveTask(task("t2", "bob", "failed", "refund-flow"));

    const result = await computeWorkflowStats({ store, workflow: "refund-flow" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.runs).toBe(2);
    expect(result.value.completed).toBe(1);
    expect(result.value.failed).toBe(1);
    expect(result.value.successRate).toBe(0.5);
  });

  it("returns zero-valued stats for unknown workflow", async () => {
    const store = createInMemoryStore();
    const result = await computeWorkflowStats({ store, workflow: "unknown" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.runs).toBe(0);
    expect(result.value.phases).toEqual([]);
  });

  it("derives phases from checkpoints with phase set", async () => {
    const store = createInMemoryStore();
    const base = new Date("2024-01-01T00:00:00Z");
    const t = task("t1", "alice", "completed", "flow", base, new Date(base.getTime() + 5000));
    await store.saveTask(t);
    // Phase 1: checkpoint at +1000ms (duration = 1000 - 0 = 1000)
    await store.saveCheckpoint(checkpoint("c1", "t1", "phase1", new Date(base.getTime() + 1000)));
    // Phase 2: checkpoint at +3000ms (duration = 3000 - 1000 = 2000)
    await store.saveCheckpoint(checkpoint("c2", "t1", "phase2", new Date(base.getTime() + 3000)));

    const result = await computeWorkflowStats({ store, workflow: "flow" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.phases).toHaveLength(2);
    expect(result.value.phases[0]!.phase).toBe("phase1");
    expect(result.value.phases[0]!.avgDurationMs).toBe(1000);
    expect(result.value.phases[0]!.runs).toBe(1);
    expect(result.value.phases[1]!.phase).toBe("phase2");
    expect(result.value.phases[1]!.avgDurationMs).toBe(2000);
  });

  it("repeated phases (retries) count as separate runs", async () => {
    const store = createInMemoryStore();
    const base = new Date("2024-01-01T00:00:00Z");
    const t = task("t1", "alice", "completed", "flow", base, new Date(base.getTime() + 5000));
    await store.saveTask(t);
    // Phase 1 first run: +1000ms (duration 1000)
    await store.saveCheckpoint(checkpoint("c1", "t1", "phase1", new Date(base.getTime() + 1000)));
    // Phase 1 retry: +2000ms (duration 1000)
    await store.saveCheckpoint(checkpoint("c2", "t1", "phase1", new Date(base.getTime() + 2000)));
    // Phase 2: +3000ms (duration 1000)
    await store.saveCheckpoint(checkpoint("c3", "t1", "phase2", new Date(base.getTime() + 3000)));

    const result = await computeWorkflowStats({ store, workflow: "flow" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const phase1 = result.value.phases.find((p) => p.phase === "phase1");
    expect(phase1!.runs).toBe(2); // Two occurrences of phase1.
    expect(phase1!.avgDurationMs).toBe(1000); // Average of 1000 and 1000.
  });

  it("ignores checkpoints without phase set", async () => {
    const store = createInMemoryStore();
    const base = new Date("2024-01-01T00:00:00Z");
    const t = task("t1", "alice", "completed", "flow", base, new Date(base.getTime() + 5000));
    await store.saveTask(t);
    // Checkpoint without phase: should be ignored.
    await store.saveCheckpoint(checkpoint("c1", "t1", undefined, new Date(base.getTime() + 1000)));
    // Checkpoint with phase: should be included.
    await store.saveCheckpoint(checkpoint("c2", "t1", "phase1", new Date(base.getTime() + 2000)));

    const result = await computeWorkflowStats({ store, workflow: "flow" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.phases).toHaveLength(1);
    expect(result.value.phases[0]!.phase).toBe("phase1");
  });

  it("returns Err when store lacks getTasksByWorkflow", async () => {
    const store = { getLatestTaskByAgent: async () => Ok(null) } as unknown as StoragePort;
    const result = await computeWorkflowStats({ store, workflow: "flow" });
    expect(result.isErr).toBe(true);
  });

  it("returns Err when store lacks getCheckpointsByTask", async () => {
    const store = createInMemoryStore();
    delete (store as Partial<StoragePort>).getCheckpointsByTask;
    await store.saveTask(task("t1", "alice", "completed", "flow"));

    const result = await computeWorkflowStats({ store, workflow: "flow" });
    expect(result.isErr).toBe(true);
  });
});
