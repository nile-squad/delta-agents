/**
 * TaskStateSnapshot factory and transition helpers.
 *
 * Snapshots are never mutated — each transition produces a new object.
 * Tests verify immutability, correct accumulation of cost/history, and
 * that only Ok-completed actions advance the state (invariant 19).
 */

import { describe, it, expect } from "vitest";
import {
  snapshotFromTask,
  withCompletedAction,
  withCompletedWorkflow,
  withStatus,
  withSpent,
  withEscalation,
} from "../../../src/state-space";
import type { Task } from "../../../src/shared/types";

const makeTask = (overrides?: Partial<Task>): Task => ({
  id: "tsk_abc",
  rootId: "tsk_abc",
  status: "running",
  goal: "test goal",
  assignedAgent: "support-agent",
  budget: { tokens: 5_000, durationMs: 30_000 },
  risk: { staticRisk: 2, currentRisk: 2, predictedRisk: 2, confidence: 0.85, escalated: false },
  trust: { score: 0.75, successfulExecutions: 3, failedExecutions: 1, surpriseEvents: 0 },
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  ...overrides,
});

describe("snapshotFromTask", () => {
  it("builds a snapshot with zero spent and empty history from a fresh task", () => {
    const snap = snapshotFromTask(makeTask());
    expect(snap.taskId).toBe("tsk_abc");
    expect(snap.agentName).toBe("support-agent");
    expect(snap.status).toBe("running");
    expect(snap.completedActions).toHaveLength(0);
    expect(snap.completedWorkflows).toHaveLength(0);
    expect(snap.spent).toEqual({ tokens: 0, durationMs: 0 });
    expect(snap.budget).toEqual({ tokens: 5_000, durationMs: 30_000 });
  });

  it("copies risk and trust from the task", () => {
    const snap = snapshotFromTask(makeTask());
    expect(snap.risk.staticRisk).toBe(2);
    expect(snap.trust.score).toBe(0.75);
  });
});

describe("withCompletedAction", () => {
  it("adds the action name to completedActions", () => {
    const snap = snapshotFromTask(makeTask());
    const next = withCompletedAction({ snapshot: snap, actionName: "lookup-customer", cost: { tokens: 200, durationMs: 500 } });
    expect(next.completedActions).toContain("lookup-customer");
  });

  it("accumulates cost into spent", () => {
    const snap = snapshotFromTask(makeTask());
    const next = withCompletedAction({ snapshot: snap, actionName: "lookup", cost: { tokens: 300, durationMs: 1_000 } });
    expect(next.spent).toEqual({ tokens: 300, durationMs: 1_000 });
  });

  it("cost accumulates across multiple transitions", () => {
    let snap = snapshotFromTask(makeTask());
    snap = withCompletedAction({ snapshot: snap, actionName: "step-1", cost: { tokens: 100, durationMs: 200 } });
    snap = withCompletedAction({ snapshot: snap, actionName: "step-2", cost: { tokens: 150, durationMs: 300 } });
    expect(snap.spent).toEqual({ tokens: 250, durationMs: 500 });
  });

  it("does not duplicate an action name already in completedActions", () => {
    let snap = snapshotFromTask(makeTask());
    snap = withCompletedAction({ snapshot: snap, actionName: "lookup", cost: { tokens: 0, durationMs: 0 } });
    snap = withCompletedAction({ snapshot: snap, actionName: "lookup", cost: { tokens: 0, durationMs: 0 } });
    expect(snap.completedActions.filter((a) => a === "lookup")).toHaveLength(1);
  });

  it("does not mutate the original snapshot", () => {
    const snap = snapshotFromTask(makeTask());
    const original = snap.completedActions.length;
    withCompletedAction({ snapshot: snap, actionName: "lookup", cost: { tokens: 0, durationMs: 0 } });
    expect(snap.completedActions.length).toBe(original);
  });
});

describe("withCompletedWorkflow", () => {
  it("adds the workflow name to completedWorkflows", () => {
    const snap = snapshotFromTask(makeTask());
    const next = withCompletedWorkflow({ snapshot: snap, workflowName: "fraud-review" });
    expect(next.completedWorkflows).toContain("fraud-review");
  });

  it("does not duplicate a workflow already in completedWorkflows", () => {
    let snap = snapshotFromTask(makeTask());
    snap = withCompletedWorkflow({ snapshot: snap, workflowName: "kyc" });
    snap = withCompletedWorkflow({ snapshot: snap, workflowName: "kyc" });
    expect(snap.completedWorkflows.filter((w) => w === "kyc")).toHaveLength(1);
  });

  it("does not mutate the original snapshot", () => {
    const snap = snapshotFromTask(makeTask());
    withCompletedWorkflow({ snapshot: snap, workflowName: "kyc" });
    expect(snap.completedWorkflows).toHaveLength(0);
  });
});

describe("withStatus", () => {
  it("changes the status in the new snapshot", () => {
    const snap = snapshotFromTask(makeTask());
    const next = withStatus({ snapshot: snap, status: "paused" });
    expect(next.status).toBe("paused");
  });

  it("does not mutate the original snapshot", () => {
    const snap = snapshotFromTask(makeTask());
    withStatus({ snapshot: snap, status: "aborted" });
    expect(snap.status).toBe("running");
  });
});

describe("withEscalation", () => {
  it("sets escalated to true on the risk state", () => {
    const snap = snapshotFromTask(makeTask());
    const next = withEscalation({ snapshot: snap, escalated: true });
    expect(next.risk.escalated).toBe(true);
  });

  it("can clear escalation once oversight resolves", () => {
    let snap = snapshotFromTask(makeTask());
    snap = withEscalation({ snapshot: snap, escalated: true });
    snap = withEscalation({ snapshot: snap, escalated: false });
    expect(snap.risk.escalated).toBe(false);
  });

  it("preserves all other risk fields when escalation changes", () => {
    const snap = snapshotFromTask(makeTask());
    const next = withEscalation({ snapshot: snap, escalated: true });
    expect(next.risk.staticRisk).toBe(snap.risk.staticRisk);
    expect(next.risk.currentRisk).toBe(snap.risk.currentRisk);
  });

  it("does not mutate the original snapshot", () => {
    const snap = snapshotFromTask(makeTask());
    withEscalation({ snapshot: snap, escalated: true });
    expect(snap.risk.escalated).toBe(false);
  });
});
