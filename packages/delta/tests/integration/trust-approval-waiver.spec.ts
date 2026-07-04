/**
 * Trust-based approval waiver — `requiresApproval: { untilTrust }`.
 *
 * WHY: an action can declare that human approval is required only until the
 * task's evidence-derived trust score reaches a threshold. Below the threshold
 * the gate behaves exactly like `requiresApproval: true` (pending request +
 * blocked). At/above it, the engine auto-approves with an auditable
 * ApprovalRequest record. A human rejection always wins: a rejected approval is
 * never waived, whatever the trust score (prohibition 11).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import type { StoragePort } from "../../src/ports/storage-port";
import { taskId, checkpointId, approvalId } from "../../src/shared/id";
import { initialRiskState, initialTrust } from "../../src/governance";
import { snapshotToJson } from "../../src/state-space/task-state";
import type { TaskStateSnapshot } from "../../src/state-space/types";

const BUDGET = { tokens: 10_000, durationMs: 300_000 };

/** Seed a paused task (+ checkpoint) with a chosen trust score, so a resume
 *  exercises the waiver against evidence-derived trust the engine would
 *  otherwise take many successful steps to accrue. */
const seedPausedTask = async ({
  store,
  agentName,
  trustScore,
  workflow,
}: {
  store: StoragePort;
  agentName: string;
  trustScore: number;
  workflow?: string;
}): Promise<string> => {
  const id = taskId();
  const past = new Date(Date.now() - 60_000);
  const trust = { score: trustScore, successfulExecutions: 10, failedExecutions: 0, surpriseEvents: 0 };
  await store.saveTask({
    id, rootId: id, status: "paused", goal: "guarded work", assignedAgent: agentName,
    workflow, budget: BUDGET, risk: initialRiskState(), trust, createdAt: past, updatedAt: past,
  });
  const snapshot: TaskStateSnapshot = {
    taskId: id, rootId: id, agentName, status: "paused",
    completedActions: [], completedWorkflows: [],
    budget: BUDGET, spent: { tokens: 0, durationMs: 0 },
    risk: initialRiskState(), trust,
    ...(workflow !== undefined ? { currentWorkflow: workflow } : {}),
  };
  await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: snapshotToJson(snapshot), createdAt: past });
  return id;
};

describe("trust-based approval waiver (free reasoner loop)", () => {
  it("blocks with a pending approval while trust is below untilTrust", async () => {
    const store = createInMemoryStore();
    let ran = 0;
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "guarded", input: {} }] }),
    });
    const guarded = delta.action({
      name: "guarded",
      description: "needs sign-off until trust is earned",
      schema: z.object({}),
      requiresApproval: { untilTrust: 0.8 },
      fn: async () => {
        ran++;
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: "w-agent", description: "d", role: "r", rolePrompt: ".", actions: [guarded] }));

    // Default trust is 0.5 < 0.8 — same behavior as requiresApproval: true.
    const result = await delta.send({ goal: "guarded work", agentName: "w-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/approval-required/);
    expect(ran).toBe(0);

    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    expect(inspected.value.pendingApprovals).toHaveLength(1);
    expect(inspected.value.pendingApprovals[0]?.action).toBe("guarded");
  });

  it("auto-approves (audited) and executes when trust has reached untilTrust", async () => {
    const store = createInMemoryStore();
    let ran = 0;
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "guarded", input: {} }] }),
    });
    const guarded = delta.action({
      name: "guarded",
      description: "needs sign-off until trust is earned",
      schema: z.object({}),
      requiresApproval: { untilTrust: 0.8 },
      fn: async () => {
        ran++;
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: "w2-agent", description: "d", role: "r", rolePrompt: ".", actions: [guarded] }));

    const id = await seedPausedTask({ store, agentName: "w2-agent", trustScore: 0.9 });
    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    expect(ran).toBe(1); // executed without blocking

    // The waiver is auditable: an approved ApprovalRequest naming the trust score.
    const approvals = await store.getApprovalsByTask(id);
    expect(approvals.isOk).toBe(true);
    if (!approvals.isOk) return;
    expect(approvals.value).toHaveLength(1);
    expect(approvals.value[0]?.status).toBe("approved");
    expect(approvals.value[0]?.reason).toMatch(/auto-approved: trust 0\.90 >= 0\.8 \(declared waiver\)/);
  });

  it("a human rejection wins over trust — never waived, never executed", async () => {
    const store = createInMemoryStore();
    let ran = 0;
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "guarded", input: {} }] }),
    });
    const guarded = delta.action({
      name: "guarded",
      description: "needs sign-off until trust is earned",
      schema: z.object({}),
      requiresApproval: { untilTrust: 0.8 },
      fn: async () => {
        ran++;
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: "w3-agent", description: "d", role: "r", rolePrompt: ".", actions: [guarded] }));

    const id = await seedPausedTask({ store, agentName: "w3-agent", trustScore: 0.9 });
    // A human already rejected this (taskId, action) pair.
    await store.saveApprovalRequest({
      id: approvalId(), taskId: id, action: "guarded",
      reason: "rejected by reviewer", status: "rejected", createdAt: new Date(),
    });

    // The rejection is fed back (not re-blocked); the scripted plan has no
    // alternative, so the model finishes without the action ever executing.
    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    expect(ran).toBe(0); // rejection is final — trust cannot override it

    // No waiver record was written on top of the rejection.
    const approvals = await store.getApprovalsByTask(id);
    expect(approvals.isOk).toBe(true);
    if (!approvals.isOk) return;
    expect(approvals.value.filter((a) => a.status === "approved")).toHaveLength(0);
  });
});

describe("trust-based approval waiver (workflow pre-flight)", () => {
  const defineWorkflowFixture = (delta: Awaited<ReturnType<typeof createDeltaEngine>>, agentName: string, onRun: () => void) => {
    const guarded = delta.action({
      name: "guarded",
      description: "needs sign-off until trust is earned",
      schema: z.object({}),
      requiresApproval: { untilTrust: 0.8 },
      fn: async () => {
        onRun();
        return Ok("done");
      },
    });
    const phase = { name: "only", description: "one guarded step", actions: ["guarded"], checkpoint: false };
    const wf = delta.workflow({ name: "guarded-wf", description: "guarded workflow", version: "1.0.0", phases: [phase] });
    delta.deploy(delta.agent({ name: agentName, description: "d", role: "r", rolePrompt: ".", actions: [guarded], workflows: [wf] }));
  };

  it("pre-flight blocks with a pending approval while trust is below untilTrust", async () => {
    const store = createInMemoryStore();
    let ran = 0;
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });
    defineWorkflowFixture(delta, "wfw-agent", () => ran++);

    const result = await delta.send({ goal: "run it", agentName: "wfw-agent", workflow: "guarded-wf" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/approval-required/);
    expect(ran).toBe(0);

    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    expect(inspected.value.pendingApprovals).toHaveLength(1);
  });

  it("pre-flight auto-approves (audited) and runs the workflow when trust has reached untilTrust", async () => {
    const store = createInMemoryStore();
    let ran = 0;
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });
    defineWorkflowFixture(delta, "wfw2-agent", () => ran++);

    const id = await seedPausedTask({ store, agentName: "wfw2-agent", trustScore: 0.9, workflow: "guarded-wf" });
    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    expect(ran).toBe(1);

    const approvals = await store.getApprovalsByTask(id);
    expect(approvals.isOk).toBe(true);
    if (!approvals.isOk) return;
    expect(approvals.value).toHaveLength(1);
    expect(approvals.value[0]?.status).toBe("approved");
    expect(approvals.value[0]?.reason).toMatch(/auto-approved: trust 0\.90 >= 0\.8 \(declared waiver\)/);
  });
});
