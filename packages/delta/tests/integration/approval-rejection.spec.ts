/**
 * Rejection with reason — the human's "no" is a signpost, not a wall.
 *
 * WHY: a rejected approval is final for the ACTION (prohibition 11: never
 * re-opened, never re-requested, never executed) but must not dead-end the
 * TASK. The reviewer's reason is persisted on the ApprovalRequest
 * (rejectionReason) and fed back to the model on resume via the bounded
 * invalid-decision feedback loop, so the model routes around the closed gate
 * — or, if it insists, the task fails honestly after the retry ceiling.
 * Workflows cannot route around a rejection (deterministic path), so a
 * rejected pre-flight action fails the task with the reason instead of
 * blocking forever.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import type { ReasonerPort, ReasonerInput } from "../../src/ports/reasoner-port";
import type { StoragePort } from "../../src/ports/storage-port";
import { taskId, checkpointId } from "../../src/shared/id";
import { initialRiskState, initialTrust } from "../../src/governance";
import { snapshotToJson } from "../../src/state-space/task-state";
import type { TaskStateSnapshot } from "../../src/state-space/types";

const BUDGET = { tokens: 10_000, durationMs: 300_000 };

/** Seed a paused task (+ checkpoint) so a resume drives the free loop or the
 *  workflow path from a known state. */
const seedPausedTask = async ({
  store,
  agentName,
  workflow,
}: {
  store: StoragePort;
  agentName: string;
  workflow?: string;
}): Promise<string> => {
  const id = taskId();
  const past = new Date(Date.now() - 60_000);
  await store.saveTask({
    id, rootId: id, status: "paused", goal: "guarded work", assignedAgent: agentName,
    workflow, budget: BUDGET, risk: initialRiskState(), trust: initialTrust(), createdAt: past, updatedAt: past,
  });
  const snapshot: TaskStateSnapshot = {
    taskId: id, rootId: id, agentName, status: "paused",
    completedActions: [], completedWorkflows: [],
    budget: BUDGET, spent: { tokens: 0, durationMs: 0 },
    risk: initialRiskState(), trust: initialTrust(),
    ...(workflow !== undefined ? { currentWorkflow: workflow } : {}),
  };
  await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: snapshotToJson(snapshot), createdAt: past });
  return id;
};

/** Wrap a reasoner to record every input it sees (for asserting feedback). */
const spyReasoner = (inner: ReasonerPort, seen: ReasonerInput[]): ReasonerPort => ({
  reason: async (input) => {
    seen.push(input);
    return inner.reason(input);
  },
});

describe("delta.reject(approvalId, reason) — persistence", () => {
  it("persists the reviewer's reason on the ApprovalRequest", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "guarded", input: {} }] }),
    });
    const guarded = delta.action({
      name: "guarded", description: "needs sign-off", schema: z.object({}),
      requiresApproval: true,
      fn: async () => Ok("done"),
    });
    delta.deploy(delta.agent({ name: "rr-agent", description: "d", role: "r", rolePrompt: ".", actions: [guarded] }));

    const sent = await delta.send({ goal: "guarded work", agentName: "rr-agent" });
    expect(sent.isOk).toBe(true);
    if (!sent.isOk) return;
    expect(sent.value.status).toBe("blocked");

    const inspected = await delta.inspect(sent.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    const pending = inspected.value.pendingApprovals[0];
    expect(pending).toBeDefined();
    if (pending === undefined) return;

    const rejected = await delta.reject(pending.id, "over $500 needs finance sign-off");
    expect(rejected.isOk).toBe(true);
    if (!rejected.isOk) return;
    expect(rejected.value.status).toBe("rejected");
    expect(rejected.value.rejectionReason).toBe("over $500 needs finance sign-off");
  });
});

describe("free loop — the model routes around a rejection", () => {
  const defineAgent = (delta: Awaited<ReturnType<typeof createDeltaEngine>>, agentName: string, counters: { guarded: number; fallback: number }) => {
    const guarded = delta.action({
      name: "guarded", description: "needs sign-off", schema: z.object({}),
      requiresApproval: true,
      fn: async () => {
        counters.guarded++;
        return Ok("done");
      },
    });
    const fallback = delta.action({
      name: "fallback", description: "the alternative path", schema: z.object({}),
      fn: async () => {
        counters.fallback++;
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: agentName, description: "d", role: "r", rolePrompt: ".", actions: [guarded, fallback] }));
  };

  it("feeds the rejection reason back and completes via a different action", async () => {
    const store = createInMemoryStore();
    const counters = { guarded: 0, fallback: 0 };
    const seen: ReasonerInput[] = [];
    // Script: try the rejected action once, then take the fallback.
    const delta = await createDeltaEngine({
      store,
      reasoner: spyReasoner(
        createMockReasoner({ responses: [{ actionName: "guarded", input: {} }, { actionName: "fallback", input: {} }] }),
        seen,
      ),
    });
    defineAgent(delta, "route-agent", counters);

    const id = await seedPausedTask({ store, agentName: "route-agent" });
    // The human already rejected the guarded action, with a reason.
    const req = await delta.inspect(id); // ensure task exists before requesting
    expect(req.isOk).toBe(true);
    const { requestApproval, resolveApproval } = await import("../../src/oversight");
    const pendingReq = await requestApproval({ taskId: id, action: "guarded", reason: "needs sign-off", store });
    expect(pendingReq.isOk).toBe(true);
    if (!pendingReq.isOk) return;
    await resolveApproval({ approvalId: pendingReq.value.id, decision: "rejected", reason: "use the fallback path instead", store });

    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    expect(counters.guarded).toBe(0); // rejection is final — never executed
    expect(counters.fallback).toBe(1); // the model routed around it

    // The turn after the rejected proposal saw the reviewer's reason.
    const withFeedback = seen.find((input) => input.lastError !== undefined);
    expect(withFeedback).toBeDefined();
    expect(withFeedback?.lastError?.reason).toMatch(/rejected by a human reviewer: use the fallback path instead/);
  });

  it("fails honestly after the retry ceiling when the model insists on the rejected action", async () => {
    const store = createInMemoryStore();
    const counters = { guarded: 0, fallback: 0 };
    // Script: insist on the rejected action past the default ceiling of 3.
    const insist = Array.from({ length: 5 }, () => ({ actionName: "guarded", input: {} }));
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: insist }),
    });
    defineAgent(delta, "insist-agent", counters);

    const id = await seedPausedTask({ store, agentName: "insist-agent" });
    const { requestApproval, resolveApproval } = await import("../../src/oversight");
    const pendingReq = await requestApproval({ taskId: id, action: "guarded", reason: "needs sign-off", store });
    expect(pendingReq.isOk).toBe(true);
    if (!pendingReq.isOk) return;
    await resolveApproval({ approvalId: pendingReq.value.id, decision: "rejected", reason: "no", store });

    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("failed");
    expect(resumed.value.reason).toMatch(/invalid decision retries exhausted/);
    expect(resumed.value.reason).toMatch(/rejected by a human reviewer/);
    expect(counters.guarded).toBe(0); // never executed, no matter how often proposed
  });
});

describe("workflow pre-flight — a rejection fails the task honestly", () => {
  it("returns failed (not blocked) with the reviewer's reason", async () => {
    const store = createInMemoryStore();
    let ran = 0;
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });
    const guarded = delta.action({
      name: "guarded", description: "needs sign-off", schema: z.object({}),
      requiresApproval: true,
      fn: async () => {
        ran++;
        return Ok("done");
      },
    });
    const phase = { name: "only", description: "one guarded step", actions: ["guarded"], checkpoint: false };
    const wf = delta.workflow({ name: "guarded-wf", description: "guarded workflow", version: "1.0.0", phases: [phase] });
    delta.deploy(delta.agent({ name: "wf-rej-agent", description: "d", role: "r", rolePrompt: ".", actions: [guarded], workflows: [wf] }));

    const id = await seedPausedTask({ store, agentName: "wf-rej-agent", workflow: "guarded-wf" });
    const { requestApproval, resolveApproval } = await import("../../src/oversight");
    const pendingReq = await requestApproval({ taskId: id, action: "guarded", reason: "needs sign-off", store });
    expect(pendingReq.isOk).toBe(true);
    if (!pendingReq.isOk) return;
    await resolveApproval({ approvalId: pendingReq.value.id, decision: "rejected", reason: "not in this workflow", store });

    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("failed");
    expect(resumed.value.reason).toMatch(/cannot run/);
    expect(resumed.value.reason).toMatch(/rejected by a human reviewer: not in this workflow/);
    expect(ran).toBe(0);

    // The persisted task status is "failed", not "paused" — no misleading
    // "approval still possible" state survives.
    const taskAfter = await store.getTask(id);
    expect(taskAfter.isOk).toBe(true);
    if (!taskAfter.isOk) return;
    expect(taskAfter.value.status).toBe("failed");
  });
});
