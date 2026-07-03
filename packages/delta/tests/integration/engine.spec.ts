/**
 * Engine integration tests — full lifecycle through createDeltaEngine.
 *
 * These tests exercise the complete assembled facade: authoring → deploy →
 * send → inspect → pause → resume → approve. The mock reasoner and in-memory
 * store are the only adapters in play so the tests are deterministic and
 * self-contained (Quality Bar: tests never read from persistent DB state).
 *
 * Exit criterion (Phase 8): the spec README Quick Example runs against the
 * real engine with mock ports.
 *
 * Covers: invariants 1, 2, 8, 9, 25, 26; prohibition 4.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import type { ReasonerPort } from "../../src/ports/reasoner-port";
import { taskId, checkpointId } from "../../src/shared/id";
import { initialRiskState, initialTrust } from "../../src/governance";
import type { JsonRecord } from "../../src/shared/types";

// A reasoner that scripts one act per step (with a reported reasoning token cost)
// and signals done when the script is exhausted. Used to drive token-budget and
// escalation paths the mock cannot (the mock reports no usage).
const costReasoner = (steps: Array<{ actionName: string; tokens: number }>): ReasonerPort => {
  const queue = [...steps];
  return {
    reason: async ({ availableActions }) => {
      const next = queue.shift();
      if (next === undefined) return Ok({ kind: "done" });
      if (!availableActions.includes(next.actionName)) {
        return Err(`unavailable: ${next.actionName}`);
      }
      return Ok({
        kind: "act",
        request: { actionName: next.actionName, input: {}, reasoningCost: { tokens: next.tokens, durationMs: 0 } },
      });
    },
  };
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const noop = async () => Ok("done" as unknown);
const fail = async () => Err("action failed") as unknown as ReturnType<typeof noop>;

// ── Basic lifecycle ───────────────────────────────────────────────────────────

describe("deploy + send — task runs to completion", () => {
  it("single action task completes successfully", async () => {
    const store = createInMemoryStore();
    const reasoner = createMockReasoner({
      responses: [{ actionName: "lookup", input: { id: "1" } }],
    });
    const delta = await createDeltaEngine({ store, reasoner });

    const lookup = delta.action({
      name: "lookup",
      description: "look up a record",
      schema: z.object({ id: z.string() }),
      fn: async ({ id }) => Ok(`found-${id}`),
    });

    const myAgent = delta.agent({
      name: "test-agent",
      description: "test agent",
      role: "Tester",
      rolePrompt: "Run tasks.",
      actions: [lookup],
    });

    delta.deploy(myAgent);

    const result = await delta.send({ goal: "find item 1", agentName: "test-agent" });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("completed");
  });

  it("multi-action task runs all actions in reasoner order", async () => {
    const store = createInMemoryStore();
    const executed: string[] = [];
    const reasoner = createMockReasoner({
      responses: [
        { actionName: "step-a", input: {} },
        { actionName: "step-b", input: {} },
      ],
    });
    const delta = await createDeltaEngine({ store, reasoner });

    const stepA = delta.action({
      name: "step-a",
      description: "first step",
      schema: z.object({}),
      fn: async () => { executed.push("a"); return Ok("a"); },
    });
    const stepB = delta.action({
      name: "step-b",
      description: "second step",
      schema: z.object({}),
      fn: async () => { executed.push("b"); return Ok("b"); },
    });

    delta.agent({ name: "seq-agent", description: "test action", role: "r", rolePrompt: ".", actions: [stepA, stepB] });
    delta.deploy(delta.agent({ name: "seq-agent2", description: "test action", role: "r", rolePrompt: ".", actions: [stepA, stepB] }));

    // Use a fresh engine for isolation
    const delta2 = await createDeltaEngine({ store, reasoner: createMockReasoner({
      responses: [{ actionName: "step-a", input: {} }, { actionName: "step-b", input: {} }],
    })});
    const a2 = delta2.action({ name: "step-a", description: "a", schema: z.object({}), fn: async () => { executed.push("a2"); return Ok("a"); } });
    const b2 = delta2.action({ name: "step-b", description: "b", schema: z.object({}), fn: async () => { executed.push("b2"); return Ok("b"); } });
    const ag2 = delta2.agent({ name: "seq-agent", description: "test action", role: "r", rolePrompt: ".", actions: [a2, b2] });
    delta2.deploy(ag2);

    const result = await delta2.send({ goal: "run both steps", agentName: "seq-agent" });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("completed");
    expect(executed).toContain("a2");
    expect(executed).toContain("b2");
  });

  it("returns Err when agent is not deployed", async () => {
    const delta = await createDeltaEngine();
    const result = await delta.send({ goal: "run", agentName: "ghost-agent" });
    expect(result.isErr).toBe(true);
  });

  // L1: deploy gates execution — send-before-deploy → Err; deploy-then-send → Ok
  it("L1 — send returns Err for an agent that is defined (registered) but not yet deployed", async () => {
    const delta = await createDeltaEngine({ reasoner: createMockReasoner() });
    const act = delta.action({ name: "act-l1a", description: "test action", schema: z.object({}), fn: noop });
    // Intentionally call delta.agent() but NOT delta.deploy() — authoring is defined but not activated.
    delta.agent({ name: "undeploy-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] });

    const result = await delta.send({ goal: "run", agentName: "undeploy-agent" });
    expect(result.isErr).toBe(true);
    if (result.isErr) {
      expect(result.error).toMatch(/defined but not deployed/);
      expect(result.error).toMatch(/delta\.deploy/);
    }
  });

  it("L1 — send succeeds after deploy() is called (deploy-then-send → Ok)", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "act-l1b", input: {} }] }),
    });
    const act = delta.action({ name: "act-l1b", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "deploy-then-send-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] });
    // Now deploy — this is the gate.
    delta.deploy(ag);

    const result = await delta.send({ goal: "run", agentName: "deploy-then-send-agent" });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("completed");
  });

  it("send creates a TaskID for every task (invariant 1)", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [{ actionName: "act", input: {} }] }) });

    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "ag", description: "test action", role: "r", rolePrompt: ".", actions: [act] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "go", agentName: "ag" });
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.taskId).toBeTruthy();
      expect(result.value.taskId.startsWith("tsk_")).toBe(true);
    }
  });
});

// ── inspect ───────────────────────────────────────────────────────────────────

describe("inspect — read full governance state", () => {
  it("returns task record, executions, checkpoint, escalations, pending approvals", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "work", input: {} }] }),
    });

    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "worker", description: "test action", role: "r", rolePrompt: ".", actions: [work] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "do work", agentName: "worker" });
    if (!sent.isOk) return;

    const state = await delta.inspect(sent.value.taskId);
    expect(state.isOk).toBe(true);
    if (state.isOk) {
      expect(state.value.task.id).toBe(sent.value.taskId);
      expect(state.value.executions.length).toBeGreaterThan(0);
      expect(state.value.escalations).toEqual([]);
      expect(state.value.pendingApprovals).toEqual([]);
    }
  });

  it("inspect returns Err for unknown taskId", async () => {
    const delta = await createDeltaEngine();
    const result = await delta.inspect("tsk_ghost");
    expect(result.isErr).toBe(true);
  });

  it("every execution record is attributable to the task's id (invariant 1)", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [
        { actionName: "a1", input: {} },
        { actionName: "a2", input: {} },
      ]}),
    });

    const a1 = delta.action({ name: "a1", description: "test action", schema: z.object({}), fn: noop });
    const a2 = delta.action({ name: "a2", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "multi", description: "test action", role: "r", rolePrompt: ".", actions: [a1, a2] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "run two", agentName: "multi" });
    if (!sent.isOk) return;

    const state = await delta.inspect(sent.value.taskId);
    if (state.isOk) {
      for (const exec of state.value.executions) {
        expect(exec.taskId).toBe(sent.value.taskId);
      }
    }
  });

  it("checkpoint is saved after successful action (invariant 10)", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "checkpt", input: {} }] }),
    });

    const checkpt = delta.action({ name: "checkpt", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "chk-agent", description: "test action", role: "r", rolePrompt: ".", actions: [checkpt] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "checkpoint test", agentName: "chk-agent" });
    if (!sent.isOk) return;

    const state = await delta.inspect(sent.value.taskId);
    if (state.isOk) {
      expect(state.value.latestCheckpoint).not.toBeNull();
      expect(state.value.latestCheckpoint?.taskId).toBe(sent.value.taskId);
    }
  });
});

// ── pause + resume ────────────────────────────────────────────────────────────

describe("pause + resume — checkpoint round-trip", () => {
  // Helper: seed a non-terminal task directly in the store (send always runs to
  // completion, so a "running" task is otherwise not observable to pause).
  const seedRunningTask = async (store: ReturnType<typeof createInMemoryStore>, agentName: string): Promise<string> => {
    const id = taskId();
    const now = new Date();
    await store.saveTask({
      id, rootId: id, status: "running", goal: "in progress", assignedAgent: agentName,
      budget: { tokens: 10_000, durationMs: 300_000 }, risk: initialRiskState(), trust: initialTrust(),
      createdAt: now, updatedAt: now,
    });
    return id;
  };

  it("pause sets a non-terminal task's status to 'paused'", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store });
    const id = await seedRunningTask(store, "pausable");

    const pauseResult = await delta.pause(id);
    expect(pauseResult.isOk).toBe(true);

    const state = await delta.inspect(id);
    if (state.isOk) expect(state.value.task.status).toBe("paused");
  });

  it("pause saves a checkpoint", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store });
    const id = await seedRunningTask(store, "p2");

    await delta.pause(id);

    const state = await delta.inspect(id);
    if (state.isOk) expect(state.value.latestCheckpoint).not.toBeNull();
  });

  it("pause returns Err for a terminal (completed) task — no resurrection (M1)", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "work", input: {} }] }),
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "done-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    const sent = await delta.send({ goal: "work once", agentName: "done-agent" });
    if (!sent.isOk) return;
    expect(sent.value.status).toBe("completed");

    const pauseResult = await delta.pause(sent.value.taskId);
    expect(pauseResult.isErr).toBe(true);
    if (pauseResult.isErr) expect(pauseResult.error).toMatch(/terminal|completed/);

    // The task stays completed — pause did not resurrect it.
    const state = await delta.inspect(sent.value.taskId);
    if (state.isOk) expect(state.value.task.status).toBe("completed");
  });

  it("resume continues from checkpoint and runs remaining actions", async () => {
    // Seed a paused task whose checkpoint records the first action already done;
    // resume should run only the second. (Avoids pausing a completed task, which
    // is now correctly rejected — M1.)
    const store = createInMemoryStore();
    const executed: string[] = [];
    const id = taskId();
    const now = new Date();
    const budget = { tokens: 10_000, durationMs: 300_000 };
    await store.saveTask({
      id, rootId: id, status: "paused", goal: "two steps", assignedAgent: "resumable",
      budget, risk: initialRiskState(), trust: initialTrust(), createdAt: now, updatedAt: now,
    });
    const checkpointSnapshot: JsonRecord = {
      taskId: id, rootId: id, agentName: "resumable", status: "paused",
      completedActions: ["first"], completedWorkflows: [],
      budget, spent: { tokens: 0, durationMs: 0 },
      risk: initialRiskState() as unknown as JsonRecord, trust: initialTrust() as unknown as JsonRecord,
    };
    await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: checkpointSnapshot, createdAt: now });

    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "second", input: {} }] }),
    });
    const first = delta.action({ name: "first", description: "test action", schema: z.object({}), fn: async () => Ok("ok") });
    const second = delta.action({ name: "second", description: "test action", schema: z.object({}), fn: async () => { executed.push("second-resumed"); return Ok("ok"); } });
    delta.deploy(delta.agent({ name: "resumable", description: "test action", role: "r", rolePrompt: ".", actions: [first, second] }));

    const resumeResult = await delta.resume(id);
    expect(resumeResult.isOk).toBe(true);
    if (resumeResult.isOk) expect(resumeResult.value.status).toBe("completed");
    expect(executed).toContain("second-resumed");
  });

  it("resume returns Err for unknown task", async () => {
    const delta = await createDeltaEngine();
    const result = await delta.resume("tsk_ghost");
    expect(result.isErr).toBe(true);
  });

  it("pause returns Err for unknown task", async () => {
    const delta = await createDeltaEngine();
    const result = await delta.pause("tsk_ghost");
    expect(result.isErr).toBe(true);
  });
});

// ── approve ───────────────────────────────────────────────────────────────────

describe("approve — resolve a pending approval", () => {
  it("approve marks the approval as approved", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner() });

    // Create an approval manually via the oversight module
    const { requestApproval } = await import("../../src/oversight");
    const req = await requestApproval({ taskId: "tsk_test", action: "pay", reason: "needs sign-off", store });
    if (!req.isOk) return;

    const result = await delta.approve(req.value.id);
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("approved");
  });

  it("send blocks when action requires approval that hasn't been granted", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });

    const pay = delta.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: noop,
    });
    const ag = delta.agent({ name: "payer", description: "test action", role: "r", rolePrompt: ".", actions: [pay] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "pay 100", agentName: "payer" });
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.status).toBe("blocked");
      expect(result.value.reason).toMatch(/approval-required/);
    }
  });

  it("approve + resume unblocks an approval-blocked task", async () => {
    const store = createInMemoryStore();
    const executed: string[] = [];
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });

    const pay = delta.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => { executed.push("paid"); return Ok("paid"); },
    });
    const ag = delta.agent({ name: "payer2", description: "test action", role: "r", rolePrompt: ".", actions: [pay] });
    delta.deploy(ag);

    // First send — blocked waiting for approval
    const blocked = await delta.send({ goal: "pay 100", agentName: "payer2" });
    if (!blocked.isOk || blocked.value.status !== "blocked") return;

    // Extract approvalId from the reason string
    const match = blocked.value.reason?.match(/appr_\S+/);
    const approvalId = match?.[0];
    if (approvalId === undefined) return;

    // Approve
    await delta.approve(approvalId);

    // Resume with fresh reasoner (same approval now in store)
    const delta2 = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });
    const pay2 = delta2.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => { executed.push("paid-resumed"); return Ok("paid"); },
    });
    const ag2 = delta2.agent({ name: "payer2", description: "test action", role: "r", rolePrompt: ".", actions: [pay2] });
    delta2.deploy(ag2);

    const resumed = await delta2.resume(blocked.value.taskId);
    expect(resumed.isOk).toBe(true);
    if (resumed.isOk) expect(resumed.value.status).toBe("completed");
    expect(executed).toContain("paid-resumed");
  });
});

// ── reject ────────────────────────────────────────────────────────────────────

describe("reject — deny a pending approval (prohibition 11)", () => {
  it("reject marks the approval as rejected", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner() });

    const { requestApproval } = await import("../../src/oversight");
    const req = await requestApproval({ taskId: "tsk_test", action: "pay", reason: "needs sign-off", store });
    if (!req.isOk) return;

    const result = await delta.reject(req.value.id);
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("rejected");
  });

  it("a rejected approval stays permanently blocked — resume does not re-authorize", async () => {
    const store = createInMemoryStore();
    const executed: string[] = [];
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });

    const pay = delta.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => { executed.push("paid"); return Ok("paid"); },
    });
    const ag = delta.agent({ name: "payer3", description: "test action", role: "r", rolePrompt: ".", actions: [pay] });
    delta.deploy(ag);

    // First send — blocked waiting for approval.
    const blocked = await delta.send({ goal: "pay 100", agentName: "payer3" });
    if (!blocked.isOk || blocked.value.status !== "blocked") return;

    const approvalId = blocked.value.reason?.match(/appr_\S+/)?.[0];
    if (approvalId === undefined) return;

    // Reject, then attempt to resume — the gateway must re-block, not execute.
    const rejected = await delta.reject(approvalId);
    expect(rejected.isOk && rejected.value.status).toBe("rejected");

    const delta2 = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });
    const pay2 = delta2.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => { executed.push("paid-resumed"); return Ok("paid"); },
    });
    const ag2 = delta2.agent({ name: "payer3", description: "test action", role: "r", rolePrompt: ".", actions: [pay2] });
    delta2.deploy(ag2);

    const resumed = await delta2.resume(blocked.value.taskId);
    expect(resumed.isOk).toBe(true);
    if (resumed.isOk) {
      expect(resumed.value.status).toBe("blocked");
      expect(resumed.value.reason).toMatch(/approval-required/);
    }
    // The action never ran — rejection is terminal.
    expect(executed).toEqual([]);
  });
});

// ── lastTask + invariant 25/26 ────────────────────────────────────────────────

describe("lastTask — retrieval without stored TaskID (invariant 25)", () => {
  it("lastTask returns the agent's most recent task", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "act", input: {} }] }),
    });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "recall-agent", description: "test action", role: "r", rolePrompt: ".", actions: [act] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "run", agentName: "recall-agent" });
    if (!sent.isOk) return;

    const last = await delta.lastTask("recall-agent");
    expect(last.isOk).toBe(true);
    if (last.isOk) {
      expect(last.value).not.toBeNull();
      expect(last.value?.id).toBe(sent.value.taskId);
    }
  });

  it("lastTask returns null when no task exists for agent (invariant 25)", async () => {
    const delta = await createDeltaEngine();
    const result = await delta.lastTask("nobody");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBeNull();
  });
});

describe("invariant 26 — no new task when agent already has active work", () => {
  it("send queues the inbound goal onto the existing task instead of creating a new one", async () => {
    const store = createInMemoryStore();
    // Manually create a running task for the agent.
    const { initialRiskState, initialTrust } = await import("../../src/governance");
    const now = new Date();
    const existingId = taskId();
    await store.saveTask({
      id: existingId,
      rootId: existingId,
      status: "running",
      goal: "previous goal",
      assignedAgent: "busy-agent",
      budget: { tokens: 1_000, durationMs: 30_000 },
      risk: initialRiskState(),
      trust: initialTrust(),
      createdAt: now,
      updatedAt: now,
    });

    const delta = await createDeltaEngine({ store });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "busy-agent", description: "test action", role: "r", rolePrompt: ".", actions: [act] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "new goal", agentName: "busy-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // Returns the existing task and a "queued" status — no second task created.
    expect(result.value.status).toBe("queued");
    expect(result.value.taskId).toBe(existingId);

    const last = await delta.lastTask("busy-agent");
    if (last.isOk) expect(last.value?.id).toBe(existingId);

    // The inbound goal is attributable to the existing task (invariant 9).
    const msgs = await store.getMessages(existingId);
    if (msgs.isOk) {
      expect(msgs.value.length).toBe(1);
      expect(msgs.value[0]?.taskId).toBe(existingId);
      expect(msgs.value[0]?.payload).toBe("new goal");
    }
  });

  it("a running SUBTASK does not block a new major task for the same agent (D3 ruling)", async () => {
    const store = createInMemoryStore();
    // A leftover running subtask (parentId set) for the agent — a separate pool
    // from major tasks, so it must not make the agent look busy to delta.send.
    const now = new Date();
    const subId = taskId();
    await store.saveTask({
      id: subId, rootId: "tsk_root_other", parentId: "tsk_root_other", status: "running",
      goal: "a subtask", assignedAgent: "dual-agent", budget: { tokens: 1_000, durationMs: 30_000 },
      risk: initialRiskState(), trust: initialTrust(), createdAt: now, updatedAt: now,
    });

    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner() });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "dual-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    const result = await delta.send({ goal: "a fresh major task", agentName: "dual-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // A new major task is created and runs — not queued onto the subtask.
    expect(result.value.status).toBe("completed");
    expect(result.value.taskId).not.toBe(subId);
  });
});

// ── Critical-set corrections (C1–C4) ──────────────────────────────────────────

describe("loop terminal states are honest (C1–C4)", () => {
  it("C2 — a persistent reasoner failure retries then escalates to a human, never completes", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ alwaysFail: "model exploded" }),
      // Near-zero backoff so the retries do not slow the test.
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "fail-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    const result = await delta.send({ goal: "go", agentName: "fail-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // After exhausting retries the task is blocked for human review, not failed,
    // and not completed. The reason names the escalation and the attempt count.
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/3 attempt\(s\), escalated/);

    // The escalation is recorded, TaskID-attributable, with the reasoner trigger.
    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    expect(inspected.value.escalations.some((e) => e.trigger === "reasoner-failure")).toBe(true);
    expect(inspected.value.task.status).toBe("paused");
  });

  it("C4 — reasoning token cost is recorded on the execution and drives spent", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: costReasoner([{ actionName: "work", tokens: 50 }]),
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "cost-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    const sent = await delta.send({ goal: "do work", agentName: "cost-agent", budget: { tokens: 10_000, durationMs: 300_000 } });
    expect(sent.isOk).toBe(true);
    if (!sent.isOk) return;
    expect(sent.value.status).toBe("completed");

    const state = await delta.inspect(sent.value.taskId);
    if (state.isOk) {
      expect(state.value.executions[0]?.cost.tokens).toBe(50);
    }
  });

  it("C1 — exceeding token budget escalates and blocks, never completes", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: costReasoner([{ actionName: "spend", tokens: 50 }]),
    });
    const spend = delta.action({ name: "spend", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "budget-agent", description: "d", role: "r", rolePrompt: ".", actions: [spend] }));

    // Tiny token budget — one 50-token step blows past it.
    const result = await delta.send({ goal: "overspend", agentName: "budget-agent", budget: { tokens: 10, durationMs: 300_000 } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/escalated/);

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) {
      expect(state.value.escalations.length).toBeGreaterThan(0);
      expect(state.value.escalations[0]?.trigger).toBe("budget-violation");
      expect(state.value.task.status).toBe("paused");
    }
  });

  it("C3 — resuming a task already over budget fails, never completes", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner() });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "spent-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    // Seed a paused task and a checkpoint whose snapshot is already over budget.
    const id = taskId();
    const now = new Date();
    const budget = { tokens: 10, durationMs: 1_000 };
    await store.saveTask({
      id, rootId: id, status: "paused", goal: "exhausted", assignedAgent: "spent-agent",
      budget, risk: initialRiskState(), trust: initialTrust(), createdAt: now, updatedAt: now,
    });
    const overSpentSnapshot: JsonRecord = {
      taskId: id, rootId: id, agentName: "spent-agent", status: "paused",
      completedActions: [], completedWorkflows: [],
      budget, spent: { tokens: 999, durationMs: 0 },
      risk: initialRiskState() as unknown as JsonRecord, trust: initialTrust() as unknown as JsonRecord,
    };
    await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: overSpentSnapshot, createdAt: now });

    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("failed");
    expect(resumed.value.reason).toMatch(/budget exhausted/);
  });
});

// ── Governance signals wired into the live loop (Package A / H3) ──────────────

describe("governance math drives the live loop (H3)", () => {
  it("a large predicted-vs-observed health divergence escalates via bayesian-surprise", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: costReasoner([{ actionName: "burn", tokens: 1000 }]),
    });
    const burn = delta.action({ name: "burn", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "surprise-agent", description: "d", role: "r", rolePrompt: ".", actions: [burn] }));

    // Budget 100 tokens; the step spends 1000 → observed health ~0.2 against a
    // predicted (cold-start) health of 1.0 → surprise ~0.8, above the 0.7
    // escalation threshold. This trigger was statically unreachable before H3.
    const result = await delta.send({ goal: "burn tokens", agentName: "surprise-agent", budget: { tokens: 100, durationMs: 300_000 } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) {
      expect(state.value.escalations[0]?.trigger).toBe("bayesian-surprise");
    }
  });

  it("kalman health estimate is computed and carried on the snapshot", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: costReasoner([{ actionName: "work", tokens: 10 }]),
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "kalman-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    const sent = await delta.send({ goal: "work", agentName: "kalman-agent", budget: { tokens: 10_000, durationMs: 300_000 } });
    expect(sent.isOk).toBe(true);
    if (!sent.isOk) return;
    expect(sent.value.snapshot.kalman).toBeDefined();
    expect(sent.value.snapshot.kalman?.estimate).toBeGreaterThanOrEqual(0);
    expect(sent.value.snapshot.kalman?.estimate).toBeLessThanOrEqual(1);
  });
});

// ── Workflow-driven tasks (Package C / H2 + H1, C-a) ──────────────────────────

describe("workflow tasks run deterministically through the engine (H2)", () => {
  it("runs phases and actions in declared order, reasoner-less, to completion", async () => {
    const store = createInMemoryStore();
    const order: string[] = [];
    // No reasoner responses scripted — a workflow task must not consult the reasoner.
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ alwaysFail: "reasoner must not run" }) });

    const a1 = delta.action({ name: "a1", description: "test action", schema: z.object({}), fn: async () => { order.push("a1"); return Ok("ok"); } });
    const a2 = delta.action({ name: "a2", description: "test action", schema: z.object({}), fn: async () => { order.push("a2"); return Ok("ok"); } });
    const b1 = delta.action({ name: "b1", description: "test action", schema: z.object({}), fn: async () => { order.push("b1"); return Ok("ok"); } });

    const phase1 = { name: "phase-1", description: "first", actions: ["a1", "a2"], checkpoint: true };
    const phase2 = { name: "phase-2", description: "second", actions: ["b1"], checkpoint: false };
    const wf = delta.workflow({ name: "two-phase", description: "ordered", version: "1.0.0", phases: [phase1, phase2] });

    const ag = delta.agent({ name: "wf-agent", description: "d", role: "r", rolePrompt: ".", actions: [a1, a2, b1], workflows: [wf] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "run workflow", agentName: "wf-agent", workflow: "two-phase" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(order).toEqual(["a1", "a2", "b1"]);
    // The completed workflow is recorded on the snapshot for prerequisite gating.
    expect(result.value.snapshot.completedWorkflows).toContain("two-phase");

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) expect(state.value.task.workflow).toBe("two-phase");
  });

  it("branch routes to onSuccess target and skips the other path", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const delta = await createDeltaEngine({ store });

    const check = delta.action({ name: "check", description: "test action", schema: z.object({}), fn: async () => { ran.push("check"); return Ok("ok"); } });
    const approve = delta.action({ name: "approve", description: "test action", schema: z.object({}), fn: async () => { ran.push("approve"); return Ok("ok"); } });
    const reject = delta.action({ name: "reject", description: "test action", schema: z.object({}), fn: async () => { ran.push("reject"); return Ok("ok"); } });

    const decide = {
      name: "decide",
      description: "branch",
      actions: [{ action: "check", onSuccess: "approve", onFailure: "reject" }, "approve", "reject"],
      checkpoint: false,
    };
    const wf = delta.workflow({ name: "branching", description: "routes", version: "1.0.0", phases: [decide] });
    const ag = delta.agent({ name: "branch-agent", description: "d", role: "r", rolePrompt: ".", actions: [check, approve, reject], workflows: [wf] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "branch", agentName: "branch-agent", workflow: "branching" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(ran).toEqual(["check", "approve"]);
    expect(ran).not.toContain("reject");
  });

  it("returns failed when the agent does not declare the workflow", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    const other = delta.action({ name: "other", description: "test action", schema: z.object({}), fn: noop });
    const ph = { name: "p", description: "p", actions: ["other"], checkpoint: false };
    delta.workflow({ name: "undeclared", description: "x", version: "1.0.0", phases: [ph] });
    // Agent declares no workflows.
    const ag = delta.agent({ name: "no-wf-agent", description: "d", role: "r", rolePrompt: ".", actions: [act, other] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "run", agentName: "no-wf-agent", workflow: "undeclared" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/does not declare workflow/);
  });
});

describe("workflow supervision recovers or surfaces failure (H1)", () => {
  it("retry strategy re-runs the phase and surfaces failure once retries are exhausted", async () => {
    const store = createInMemoryStore();
    let attempts = 0;
    const delta = await createDeltaEngine({ store });

    const flaky = delta.action({
      name: "flaky",
      description: "always fails",
      schema: z.object({}),
      fn: async () => { attempts++; return Err("transient") as unknown as ReturnType<typeof noop>; },
    });
    const ph = {
      name: "flaky-phase",
      description: "retried",
      actions: ["flaky"],
      checkpoint: false,
      supervision: { strategy: "retry" as const, maxRetries: 2 },
    };
    const wf = delta.workflow({ name: "retry-wf", description: "retries", version: "1.0.0", phases: [ph] });
    const ag = delta.agent({ name: "retry-agent", description: "d", role: "r", rolePrompt: ".", actions: [flaky], workflows: [wf] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "retry", agentName: "retry-agent", workflow: "retry-wf" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/exhausted/);
    // First run + 2 retries = 3 attempts.
    expect(attempts).toBe(3);

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) expect(state.value.task.status).toBe("failed");
  });

  it("escalate strategy pauses the task and records a workflow-failure escalation", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store });

    // A failed action routes to the phase's supervision policy (escalate),
    // not to post-step governance — so the policy reliably decides the outcome.
    const boom = delta.action({
      name: "boom",
      description: "fails",
      schema: z.object({}),
      fn: async () => Err("kaboom") as unknown as ReturnType<typeof noop>,
    });
    const ph = {
      name: "boom-phase",
      description: "escalates",
      actions: ["boom"],
      checkpoint: false,
      supervision: { strategy: "escalate" as const, maxRetries: 0 },
    };
    const wf = delta.workflow({ name: "escalate-wf", description: "escalates", version: "1.0.0", phases: [ph] });
    const ag = delta.agent({ name: "escalate-agent", description: "d", role: "r", rolePrompt: ".", actions: [boom], workflows: [wf] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "escalate", agentName: "escalate-agent", workflow: "escalate-wf" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/escalated/);

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) {
      expect(state.value.task.status).toBe("paused");
      expect(state.value.escalations.length).toBeGreaterThan(0);
      expect(state.value.escalations[0]?.trigger).toBe("workflow-failure");
    }
  });
});

describe("workflow approval pre-flight (C-a)", () => {
  it("blocks the whole workflow when a requiresApproval action is not yet approved", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const delta = await createDeltaEngine({ store });

    const prep = delta.action({ name: "prep", description: "test action", schema: z.object({}), fn: async () => { ran.push("prep"); return Ok("ok"); } });
    const pay = delta.action({ name: "pay", description: "needs sign-off", schema: z.object({}), requiresApproval: true, fn: async () => { ran.push("pay"); return Ok("ok"); } });
    const ph = { name: "pay-phase", description: "p", actions: ["prep", "pay"], checkpoint: false };
    const wf = delta.workflow({ name: "pay-wf", description: "pays", version: "1.0.0", phases: [ph] });
    const ag = delta.agent({ name: "pay-agent", description: "d", role: "r", rolePrompt: ".", actions: [prep, pay], workflows: [wf] });
    delta.deploy(ag);

    const result = await delta.send({ goal: "pay", agentName: "pay-agent", workflow: "pay-wf" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/approval-required/);
    // Pre-flight blocks before any action runs — no partial execution.
    expect(ran).toEqual([]);

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) {
      expect(state.value.task.status).toBe("paused");
      expect(state.value.pendingApprovals.some((a) => a.action === "pay")).toBe(true);
    }
  });
});

// ── Per-action workflow inputs (H3) ───────────────────────────────────────────

describe("per-action workflow inputs (H3)", () => {
  it("each action receives its own actionInputs entry when present", async () => {
    const store = createInMemoryStore();
    // Actions record the input they received so we can assert distinctness.
    const receivedInputs: Record<string, Record<string, unknown>> = {};

    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ alwaysFail: "must not run" }) });

    const act1 = delta.action({
      name: "act-one",
      description: "first action",
      schema: z.object({ value: z.string() }),
      fn: async ({ value }) => { receivedInputs["act-one"] = { value }; return Ok("ok"); },
    });
    const act2 = delta.action({
      name: "act-two",
      description: "second action",
      schema: z.object({ value: z.string() }),
      fn: async ({ value }) => { receivedInputs["act-two"] = { value }; return Ok("ok"); },
    });
    const act3 = delta.action({
      name: "act-three",
      description: "third action — no actionInputs entry; uses shared input fallback",
      schema: z.object({ shared: z.string() }),
      fn: async ({ shared }) => { receivedInputs["act-three"] = { shared }; return Ok("ok"); },
    });

    const ph = { name: "p", description: "p", actions: ["act-one", "act-two", "act-three"], checkpoint: false };
    const wf = delta.workflow({ name: "multi-input-wf", description: "per-action inputs", version: "1.0.0", phases: [ph] });
    const ag = delta.agent({ name: "input-agent", description: "d", role: "r", rolePrompt: ".", actions: [act1, act2, act3], workflows: [wf] });
    delta.deploy(ag);

    const result = await delta.send({
      goal: "test per-action inputs",
      agentName: "input-agent",
      workflow: "multi-input-wf",
      // Shared fallback input for actions without a per-action override.
      input: { shared: "shared-value" },
      // Per-action overrides: act-one and act-two each get distinct values.
      actionInputs: {
        "act-one": { value: "input-for-one" },
        "act-two": { value: "input-for-two" },
      },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    // act-one got its own distinct input.
    expect(receivedInputs["act-one"]).toEqual({ value: "input-for-one" });
    // act-two got its own distinct input.
    expect(receivedInputs["act-two"]).toEqual({ value: "input-for-two" });
    // act-three has no actionInputs entry → fell back to the shared `input` bag.
    expect(receivedInputs["act-three"]).toEqual({ shared: "shared-value" });
  });
});

// ── Delegation + bounded supervision tree (Package D / H4) ────────────────────

// A reasoner that scripts decisions per agent role, so one engine-level reasoner
// can drive a parent and its delegated children deterministically. Each role's
// queue yields act/delegate decisions in order; an exhausted queue means done.
type RoleScript =
  | { actionName: string; input?: Record<string, string | number | boolean | null> }
  | { delegate: { goal: string; agentName: string; budget?: { tokens: number; durationMs: number } } };

const routingReasoner = (scripts: Record<string, RoleScript[]>): ReasonerPort => {
  const queues: Record<string, RoleScript[]> = {};
  for (const role of Object.keys(scripts)) queues[role] = [...scripts[role]!];
  return {
    reason: async ({ agentRole, availableActions }) => {
      const queue = queues[agentRole] ?? [];
      const next = queue.shift();
      if (next === undefined) return Ok({ kind: "done" });
      if ("delegate" in next) return Ok({ kind: "delegate", delegation: next.delegate });
      if (!availableActions.includes(next.actionName)) return Err(`unavailable: ${next.actionName}`);
      return Ok({ kind: "act", request: { actionName: next.actionName, input: next.input ?? {} } });
    },
  };
};

describe("delegation drives a bounded supervision tree (H4)", () => {
  it("a delegate decision spawns a child task (parentId set) and both complete", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const reasoner = routingReasoner({
      Parent: [{ delegate: { goal: "do the sub-work", agentName: "child-agent" } }],
      Child: [{ actionName: "work" }],
    });
    const delta = await createDeltaEngine({ store, reasoner });

    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: async () => { ran.push("plan"); return Ok("ok"); } });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: async () => { ran.push("work"); return Ok("ok"); } });

    delta.deploy(delta.agent({ name: "child-agent", description: "d", role: "Child", rolePrompt: ".", actions: [work] }));
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const result = await delta.send({ goal: "delegate then finish", agentName: "parent-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(ran).toContain("work");

    // The child is a real, separate task attributed to the child agent, rooted at the parent.
    const child = await delta.lastTask("child-agent");
    expect(child.isOk).toBe(true);
    if (child.isOk && child.value !== null) {
      expect(child.value.parentId).toBe(result.value.taskId);
      expect(child.value.rootId).toBe(result.value.taskId);
      expect(child.value.status).toBe("completed");
    }
  });

  it("a child's budget is clamped to the parent's remaining scope (invariant 18)", async () => {
    const store = createInMemoryStore();
    const reasoner = routingReasoner({
      // Request far more than the parent owns — the engine must clamp it down.
      Parent: [{ delegate: { goal: "sub", agentName: "child-agent", budget: { tokens: 1_000_000, durationMs: 1_000_000 } } }],
      Child: [{ actionName: "work" }],
    });
    const delta = await createDeltaEngine({ store, reasoner });

    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: noop });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "child-agent", description: "d", role: "Child", rolePrompt: ".", actions: [work] }));
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const parentBudget = { tokens: 100, durationMs: 5_000 };
    const result = await delta.send({ goal: "delegate", agentName: "parent-agent", budget: parentBudget });
    expect(result.isOk).toBe(true);

    const child = await delta.lastTask("child-agent");
    if (child.isOk && child.value !== null) {
      // Parent had spent nothing at delegation time, so the child is clamped to the full parent budget — never more.
      expect(child.value.budget.tokens).toBeLessThanOrEqual(parentBudget.tokens);
      expect(child.value.budget.durationMs).toBeLessThanOrEqual(parentBudget.durationMs);
      expect(child.value.budget.tokens).toBe(100);
    }
  });

  it("a third concurrent delegation queues and is promoted on slot release (invariants 15, 16)", async () => {
    const store = createInMemoryStore();
    let workCount = 0;
    // Parent delegates three children (same role); each child must do work once.
    // Keyed per task id so the three children don't share one scripted queue.
    const parentQueue = ["A", "B", "C"];
    const worked = new Set<string>();
    const reasoner: ReasonerPort = {
      reason: async ({ task, agentRole, availableActions }) => {
        if (agentRole === "Parent") {
          const goal = parentQueue.shift();
          if (goal === undefined) return Ok({ kind: "done" });
          return Ok({ kind: "delegate", delegation: { goal, agentName: "child-agent" } });
        }
        if (availableActions.includes("work") && !worked.has(task.id)) {
          worked.add(task.id);
          return Ok({ kind: "act", request: { actionName: "work", input: {} } });
        }
        return Ok({ kind: "done" });
      },
    };
    const delta = await createDeltaEngine({ store, reasoner });

    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: noop });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: async () => { workCount++; return Ok("ok"); } });
    delta.deploy(delta.agent({ name: "child-agent", description: "d", role: "Child", rolePrompt: ".", actions: [work] }));
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const result = await delta.send({ goal: "delegate three", agentName: "parent-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    // All three children ran even though only two may be active at once — the
    // third was queued and promoted when a slot freed (FIFO).
    expect(workCount).toBe(3);

    // The supervision tree exists for the root and is empty once everything settled.
    const tree = await store.getTaskTree(result.value.taskId);
    if (tree.isOk) {
      expect(tree.value.activeChildren).toEqual([]);
      expect(tree.value.queuedChildren).toEqual([]);
    }
  });

  it("reserves each child's budget so concurrent delegations cannot collectively exceed parent scope (invariant 18)", async () => {
    const store = createInMemoryStore();
    // Parent budget 100 tokens. Each child requests 80 — individually fine, but
    // together (160) they exceed the parent. Reservation must clamp the second.
    const reasoner = routingReasoner({
      Parent: [
        { delegate: { goal: "A", agentName: "child-a", budget: { tokens: 80, durationMs: 1_000 } } },
        { delegate: { goal: "B", agentName: "child-b", budget: { tokens: 80, durationMs: 1_000 } } },
      ],
      ChildA: [{ actionName: "work" }],
      ChildB: [{ actionName: "work" }],
    });
    const delta = await createDeltaEngine({ store, reasoner });
    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: noop });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "child-a", description: "d", role: "ChildA", rolePrompt: ".", actions: [work] }));
    delta.deploy(delta.agent({ name: "child-b", description: "d", role: "ChildB", rolePrompt: ".", actions: [work] }));
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const result = await delta.send({ goal: "delegate two", agentName: "parent-agent", budget: { tokens: 100, durationMs: 300_000 } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    const childA = await delta.lastTask("child-a");
    const childB = await delta.lastTask("child-b");
    if (childA.isOk && childA.value !== null && childB.isOk && childB.value !== null) {
      // First child got its full request; the second was clamped to what was left
      // after reservation (100 − 80 = 20), not its requested 80.
      expect(childA.value.budget.tokens).toBe(80);
      expect(childB.value.budget.tokens).toBe(20);
      expect(childA.value.budget.tokens + childB.value.budget.tokens).toBeLessThanOrEqual(100);
    }
  });

  it("a delegated subtask that fails surfaces the parent as failed, not completed (D1)", async () => {
    const store = createInMemoryStore();
    const parentQueue: Array<{ delegate: { goal: string; agentName: string } } | "done"> = [
      { delegate: { goal: "sub", agentName: "child-agent" } },
      "done",
    ];
    // The child hard-fails by requesting an action that does not exist (a logic
    // failure, distinct from a transient model error which would retry+escalate).
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) => {
        if (agentRole === "Parent") {
          const next = parentQueue.shift();
          if (next === undefined || next === "done") return Ok({ kind: "done" });
          return Ok({ kind: "delegate", delegation: next.delegate });
        }
        return Ok({ kind: "act", request: { actionName: "does-not-exist", input: {} } });
      },
    };
    const delta = await createDeltaEngine({ store, reasoner });
    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: noop });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "child-agent", description: "d", role: "Child", rolePrompt: ".", actions: [work] }));
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const result = await delta.send({ goal: "delegate to a failing child", agentName: "parent-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/delegated subtask .* failed/);

    // The root task record reflects the subtree failure too (auditable consistency).
    const inspected = await delta.inspect(result.value.taskId);
    if (inspected.isOk) expect(inspected.value.task.status).toBe("failed");
  });

  it("a delegated subtask blocked on approval surfaces the parent as blocked (D1)", async () => {
    const store = createInMemoryStore();
    const reasoner = routingReasoner({
      Parent: [{ delegate: { goal: "sub", agentName: "child-agent" } }],
      Child: [{ actionName: "pay" }],
    });
    const delta = await createDeltaEngine({ store, reasoner });
    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: noop });
    const pay = delta.action({ name: "pay", description: "needs sign-off", schema: z.object({}), requiresApproval: true, fn: noop });
    delta.deploy(delta.agent({ name: "child-agent", description: "d", role: "Child", rolePrompt: ".", actions: [pay] }));
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const result = await delta.send({ goal: "delegate work needing approval", agentName: "parent-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/blocked awaiting human oversight/);
  });

  it("delegating to an unknown agent fails the parent task", async () => {
    const store = createInMemoryStore();
    const reasoner = routingReasoner({
      Parent: [{ delegate: { goal: "sub", agentName: "ghost-agent" } }],
    });
    const delta = await createDeltaEngine({ store, reasoner });
    const plan = delta.action({ name: "plan", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "parent-agent", description: "d", role: "Parent", rolePrompt: ".", actions: [plan] }));

    const result = await delta.send({ goal: "delegate to ghost", agentName: "parent-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/agent "ghost-agent" not found/);
  });
});

// ── Queue drain — caller messages are consumed (Package D / H5b) ──────────────

describe("queued caller messages are drained into the task (H5b)", () => {
  it("a message queued on a busy agent's task is consumed when the task next settles", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner() });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "comms-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    // Seed a paused task and a caller message queued against it (the H5a path).
    const id = taskId();
    const now = new Date();
    await store.saveTask({
      id, rootId: id, status: "paused", goal: "original goal", assignedAgent: "comms-agent",
      budget: { tokens: 10_000, durationMs: 300_000 }, risk: initialRiskState(), trust: initialTrust(),
      createdAt: now, updatedAt: now,
    });
    const { messageId } = await import("../../src/shared/id");
    const msgId = messageId();
    await store.saveMessage({ id: msgId, taskId: id, sender: "caller", receiver: "comms-agent", payload: "extra work please", createdAt: now });

    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    // The queued message was folded into the task exactly once (idempotent drain).
    expect(resumed.value.snapshot.consumedMessages).toContain(msgId);

    // The consumed id is checkpointed durably, so a later resume would not
    // re-drain the same message (D4 idempotency across resume).
    const ckpt = await store.getLatestCheckpoint(id);
    if (ckpt.isOk && ckpt.value !== null) {
      expect((ckpt.value.state as { consumedMessages?: string[] }).consumedMessages).toContain(msgId);
    }
  });
});

// ── Channel communication (Package E / comms) ─────────────────────────────────

describe("agents communicate through bound channels (Package E)", () => {
  it("a communicate decision sends through the channel and records a Message", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const reasoner = createMockReasoner({ responses: [{ communicate: { channel: "slack", body: "hi there" } }] });
    const delta = await createDeltaEngine({ store, reasoner });

    const noopAction = delta.action({ name: "noop", description: "test action", schema: z.object({}), fn: noop });
    const channel = {
      type: "slack" as const,
      enabled: true,
      sendMessage: async (message: string) => { sent.push(message); return Ok(undefined); },
    };
    delta.deploy(delta.agent({ name: "comms-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction], channels: [channel] }));

    const result = await delta.send({ goal: "say hi", agentName: "comms-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(sent).toEqual(["hi there"]);

    // The outbound message is recorded and TaskID-attributable (invariant 9).
    const msgs = await store.getMessages(result.value.taskId);
    if (msgs.isOk) {
      expect(msgs.value.some((m) => m.payload === "hi there" && m.sender === "comms-agent" && m.receiver === "slack")).toBe(true);
    }
  });

  it("a message on a requiresApproval channel blocks until human sign-off", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const reasoner = createMockReasoner({ responses: [{ communicate: { channel: "email", body: "your invoice" } }] });
    const delta = await createDeltaEngine({ store, reasoner });

    const noopAction = delta.action({ name: "noop", description: "test action", schema: z.object({}), fn: noop });
    const channel = {
      type: "email" as const,
      enabled: true,
      requiresApproval: true,
      sendMessage: async (message: string) => { sent.push(message); return Ok(undefined); },
    };
    delta.deploy(delta.agent({ name: "approver-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction], channels: [channel] }));

    const result = await delta.send({ goal: "email the customer", agentName: "approver-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/approval-required/);
    // The gate held — nothing was actually sent.
    expect(sent).toEqual([]);

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) expect(state.value.pendingApprovals.some((a) => a.action === "channel:email")).toBe(true);
  });

  it("communicating on an undeclared channel fails the task", async () => {
    const store = createInMemoryStore();
    const reasoner = createMockReasoner({ responses: [{ communicate: { channel: "slack", body: "hi" } }] });
    const delta = await createDeltaEngine({ store, reasoner });
    const noopAction = delta.action({ name: "noop", description: "test action", schema: z.object({}), fn: noop });
    // Agent declares no channels.
    delta.deploy(delta.agent({ name: "no-channel-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction] }));

    const result = await delta.send({ goal: "try to message", agentName: "no-channel-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/no enabled channel of type "slack"/);
  });

  it("an action fn can send through ctx.communicate (declarative path E2)", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const reasoner = createMockReasoner({ responses: [{ actionName: "notify", input: {} }] });
    const delta = await createDeltaEngine({ store, reasoner });

    const channel = {
      type: "slack" as const,
      enabled: true,
      sendMessage: async (message: string) => { sent.push(message); return Ok(undefined); },
    };
    const notify = delta.action({
      name: "notify",
      description: "test action",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        if (ctx.communicate !== undefined) await ctx.communicate("slack", "from action");
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: "notifier", description: "d", role: "r", rolePrompt: ".", actions: [notify], channels: [channel] }));

    const result = await delta.send({ goal: "notify", agentName: "notifier" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(sent).toEqual(["from action"]);

    const msgs = await store.getMessages(result.value.taskId);
    if (msgs.isOk) expect(msgs.value.some((m) => m.payload === "from action")).toBe(true);
  });

  it("a workflow action can send through ctx.communicate (workflow path E2)", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const delta = await createDeltaEngine({ store });

    const channel = {
      type: "slack" as const,
      enabled: true,
      sendMessage: async (message: string) => { sent.push(message); return Ok(undefined); },
    };
    const step = delta.action({
      name: "wf-notify",
      description: "test action",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        if (ctx.communicate !== undefined) await ctx.communicate("slack", "from workflow");
        return Ok("ok");
      },
    });
    const ph = { name: "notify-phase", description: "p", actions: ["wf-notify"], checkpoint: false };
    const wf = delta.workflow({ name: "notify-wf", description: "w", version: "1.0.0", phases: [ph] });
    delta.deploy(delta.agent({ name: "wf-notifier", description: "d", role: "r", rolePrompt: ".", actions: [step], workflows: [wf], channels: [channel] }));

    const result = await delta.send({ goal: "run", agentName: "wf-notifier", workflow: "notify-wf" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(sent).toEqual(["from workflow"]);
  });
});

// ── Skills surfaced to the reasoner (Package E3) ──────────────────────────────

// Temp dirs for skill folders; cleaned up after the suite.
let e3TmpDir: string;
afterAll(() => { if (e3TmpDir) rmSync(e3TmpDir, { recursive: true, force: true }); });

describe("skills are surfaced to the reasoner via SKILL.md (Package E3)", () => {
  it("surfaces skills whose folder contains SKILL.md; omits those without", async () => {
    e3TmpDir = mkdtempSync(join(tmpdir(), "delta-e3-"));
    // refunds: has SKILL.md → surfaced
    const refundsFolder = join(e3TmpDir, "refunds");
    mkdirSync(refundsFolder, { recursive: true });
    writeFileSync(join(refundsFolder, "SKILL.md"), "Refund rules.", "utf-8");
    // legacy: no SKILL.md → omitted
    const legacyFolder = join(e3TmpDir, "legacy");
    mkdirSync(legacyFolder, { recursive: true });

    const store = createInMemoryStore();
    let seenSkills: Array<{ name: string; description: string; content?: string }> | undefined;
    const reasoner: ReasonerPort = {
      reason: async (input) => { seenSkills = input.availableSkills; return Ok({ kind: "done" }); },
    };
    const delta = await createDeltaEngine({ store, reasoner });

    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({
      name: "skilled-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [act],
      skills: [
        { name: "refunds", description: "process customer refunds", folder: refundsFolder },
        { name: "legacy", description: "deprecated capability", folder: legacyFolder },
      ],
    }));

    const result = await delta.send({ goal: "go", agentName: "skilled-agent" });
    expect(result.isOk).toBe(true);
    expect(seenSkills).toEqual([
      { name: "refunds", description: "process customer refunds", content: "Refund rules." },
    ]);
  });
});

// ── On-demand memory retrieval (Package F) ────────────────────────────────────

describe("memory is retrieved on demand, not carried (Package F)", () => {
  it("ctx.remember persists a memory that a later task retrieves as reasoner context", async () => {
    const store = createInMemoryStore();

    // Task 1: an action remembers a fact (shared store).
    const reasoner1 = createMockReasoner({ responses: [{ actionName: "learn", input: {} }] });
    const delta1 = await createDeltaEngine({ store, reasoner: reasoner1 });
    const learn = delta1.action({
      name: "learn",
      description: "test action",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        if (ctx.remember !== undefined) await ctx.remember("the database password rotates weekly", "fact");
        return Ok("ok");
      },
    });
    delta1.deploy(delta1.agent({ name: "mem-agent", description: "d", role: "r", rolePrompt: ".", actions: [learn] }));
    const r1 = await delta1.send({ goal: "learn the setup", agentName: "mem-agent" });
    expect(r1.isOk).toBe(true);

    // Task 2: the same agent's reasoner receives the prior memory as context.
    let seenContext: string | undefined;
    const reasoner2: ReasonerPort = {
      reason: async (input) => { seenContext = input.context; return Ok({ kind: "done" }); },
    };
    const delta2 = await createDeltaEngine({ store, reasoner: reasoner2 });
    const noopAct = delta2.action({ name: "noop", description: "test action", schema: z.object({}), fn: noop });
    delta2.deploy(delta2.agent({ name: "mem-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAct] }));

    await delta2.send({ goal: "what about the database password", agentName: "mem-agent" });
    expect(seenContext).toMatch(/database password rotates weekly/);

    // The memory is attributable to the task that created it (invariant 8).
    const mems = await store.getMemoriesByAgent("mem-agent");
    if (mems.isOk) {
      expect(mems.value).toHaveLength(1);
      expect(mems.value[0]?.taskId).toBe(r1.isOk ? r1.value.taskId : "");
    }
  });

  it("no context is injected when the agent has no memories", async () => {
    const store = createInMemoryStore();
    let seenContext: string | undefined;
    const reasoner: ReasonerPort = {
      reason: async (input) => { seenContext = input.context; return Ok({ kind: "done" }); },
    };
    const delta = await createDeltaEngine({ store, reasoner });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "fresh-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    await delta.send({ goal: "do something", agentName: "fresh-agent" });
    expect(seenContext).toBeUndefined();
  });
});

// ── Bellman value + MPC (Package G) ──────────────────────────────────────────

describe("value-guided execution (Package G)", () => {
  it("blocks a workflow projected to exceed budget before any action runs (MPC, G3)", async () => {
    const store = createInMemoryStore();
    let ran = false;
    const delta = await createDeltaEngine({ store });

    const expensive = delta.action({
      name: "expensive",
      description: "test action",
      schema: z.object({}),
      estimatedCost: { tokens: 5_000, durationMs: 0 },
      fn: async () => { ran = true; return Ok("ok"); },
    });
    const ph = { name: "p", description: "p", actions: ["expensive"], checkpoint: false };
    const wf = delta.workflow({ name: "pricey-wf", description: "w", version: "1.0.0", phases: [ph] });
    delta.deploy(delta.agent({ name: "mpc-agent", description: "d", role: "r", rolePrompt: ".", actions: [expensive], workflows: [wf] }));

    const result = await delta.send({ goal: "run", agentName: "mpc-agent", workflow: "pricey-wf", budget: { tokens: 1_000, durationMs: 300_000 } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/MPC|projected to exceed/);
    expect(ran).toBe(false); // preventive: the action never executed

    const state = await delta.inspect(result.value.taskId);
    if (state.isOk) expect(state.value.escalations.some((e) => e.trigger === "budget-violation")).toBe(true);
  });

  it("blocks a workflow whose projected MEMORY exceeds budget (multi-axis cost, MPC)", async () => {
    const store = createInMemoryStore();
    let ran = false;
    const delta = await createDeltaEngine({ store });

    const heavy = delta.action({
      name: "heavy",
      description: "test action",
      schema: z.object({}),
      estimatedCost: { tokens: 1, durationMs: 0, memory: 5_000 },
      fn: async () => { ran = true; return Ok("ok"); },
    });
    const ph = { name: "p", description: "p", actions: ["heavy"], checkpoint: false };
    const wf = delta.workflow({ name: "mem-wf", description: "w", version: "1.0.0", phases: [ph] });
    delta.deploy(delta.agent({ name: "mem-budget-agent", description: "d", role: "r", rolePrompt: ".", actions: [heavy], workflows: [wf] }));

    // Tokens/time are ample; the memory budget (1000) is what the action overruns (5000).
    const result = await delta.send({ goal: "run", agentName: "mem-budget-agent", workflow: "mem-wf", budget: { tokens: 10_000, durationMs: 300_000, memory: 1_000 } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("blocked");
    expect(result.value.reason).toMatch(/MPC|projected to exceed/);
    expect(ran).toBe(false);
  });

  it("orders discoverable actions cheapest-first for the reasoner (Bellman, G3)", async () => {
    const store = createInMemoryStore();
    let seen: string[] = [];
    const reasoner: ReasonerPort = {
      reason: async (input) => { seen = input.availableActions; return Ok({ kind: "done" }); },
    };
    const delta = await createDeltaEngine({ store, reasoner });

    const cheap = delta.action({ name: "cheap", description: "test action", schema: z.object({}), estimatedCost: { tokens: 10, durationMs: 0 }, fn: noop });
    const pricey = delta.action({ name: "pricey", description: "test action", schema: z.object({}), estimatedCost: { tokens: 900, durationMs: 0 }, fn: noop });
    const unknown = delta.action({ name: "unknown", description: "test action", schema: z.object({}), fn: noop });
    // Declared out of value order; the engine should re-order by Bellman value.
    delta.deploy(delta.agent({ name: "rank-agent", description: "d", role: "r", rolePrompt: ".", actions: [pricey, unknown, cheap] }));

    await delta.send({ goal: "go", agentName: "rank-agent", budget: { tokens: 10_000, durationMs: 300_000 } });
    expect(seen).toEqual(["cheap", "pricey", "unknown"]);
  });
});

// ── Decoupling check ──────────────────────────────────────────────────────────

describe("decoupling — modules individually importable", () => {
  it("state-space module is importable and functional independently", async () => {
    const { checkLegality } = await import("../../src/state-space");
    const { initialRiskState, initialTrust } = await import("../../src/governance");
    const { z } = await import("zod");
    const { Ok } = await import("slang-ts");

    const action = {
      name: "solo",
      description: "test action",
      schema: z.object({}),
      fn: async () => Ok("x"),
    };
    const state = {
      taskId: "tsk_t",
      rootId: "tsk_t",
      agentName: "ag",
      status: "running" as const,
      completedActions: [],
      completedWorkflows: [],
      budget: { tokens: 1_000, durationMs: 10_000 },
      spent: { tokens: 0, durationMs: 0 },
      risk: initialRiskState(),
      trust: initialTrust(),
    };
    const result = checkLegality({ action, state });
    expect(result.legal).toBe(true);
  });

  it("governance module is importable and functional independently", async () => {
    const { updateTrust } = await import("../../src/governance");
    const { initialTrust } = await import("../../src/governance");
    const updated = updateTrust({ current: initialTrust(), outcome: "success" });
    expect(updated.successfulExecutions).toBeGreaterThan(0);
  });

  it("oversight module is importable and functional independently", async () => {
    const { checkEscalation } = await import("../../src/oversight");
    const { initialRiskState } = await import("../../src/governance");
    const result = checkEscalation({
      risk: initialRiskState(),
      spent: { tokens: 0, durationMs: 0 },
      budget: { tokens: 1_000, durationMs: 10_000 },
    });
    expect(result.escalate).toBe(false);
  });

  it("supervision module is importable and functional independently", async () => {
    const { requestSlot } = await import("../../src/supervision");
    const tree = { rootTaskId: "tsk_r", activeChildren: [], queuedChildren: [], maxConcurrency: 2 as const };
    const result = requestSlot(tree, "tsk_child");
    expect("granted" in result && result.granted).toBe(true);
  });
});
