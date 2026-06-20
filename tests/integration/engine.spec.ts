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

import { describe, it, expect } from "vitest";
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
    const delta = createDeltaEngine({ store, reasoner });

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
    const delta = createDeltaEngine({ store, reasoner });

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
    const delta2 = createDeltaEngine({ store, reasoner: createMockReasoner({
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
    const delta = createDeltaEngine();
    const result = await delta.send({ goal: "run", agentName: "ghost-agent" });
    expect(result.isErr).toBe(true);
  });

  it("send creates a TaskID for every task (invariant 1)", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [{ actionName: "act", input: {} }] }) });

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
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine();
    const result = await delta.inspect("tsk_ghost");
    expect(result.isErr).toBe(true);
  });

  it("every execution record is attributable to the task's id (invariant 1)", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine({
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
  it("pause sets task status to 'paused'", async () => {
    const store = createInMemoryStore();
    // Send first to create a task
    const delta = createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "work", input: {} }] }),
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "pausable", description: "test action", role: "r", rolePrompt: ".", actions: [work] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "work once", agentName: "pausable" });
    if (!sent.isOk) return;
    const taskId = sent.value.taskId;

    // Pause the (now completed) task — pause is always safe to call
    const pauseResult = await delta.pause(taskId);
    expect(pauseResult.isOk).toBe(true);

    const state = await delta.inspect(taskId);
    if (state.isOk) expect(state.value.task.status).toBe("paused");
  });

  it("pause saves a checkpoint", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "work", input: {} }] }),
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: noop });
    const ag = delta.agent({ name: "p2", description: "test action", role: "r", rolePrompt: ".", actions: [work] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "work", agentName: "p2" });
    if (!sent.isOk) return;

    await delta.pause(sent.value.taskId);

    const state = await delta.inspect(sent.value.taskId);
    if (state.isOk) expect(state.value.latestCheckpoint).not.toBeNull();
  });

  it("resume continues from checkpoint and runs remaining actions", async () => {
    // Scenario: pause after first action, then resume for second action
    const store = createInMemoryStore();
    const executed: string[] = [];

    // First send — only run the first action
    const delta = createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "first", input: {} }] }),
    });
    const first = delta.action({ name: "first", description: "test action", schema: z.object({}), fn: async () => { executed.push("first"); return Ok("ok"); } });
    const second = delta.action({ name: "second", description: "test action", schema: z.object({}), fn: async () => { executed.push("second"); return Ok("ok"); } });
    const ag = delta.agent({ name: "resumable", description: "test action", role: "r", rolePrompt: ".", actions: [first, second] });
    delta.deploy(ag);

    const sent = await delta.send({ goal: "two steps", agentName: "resumable" });
    if (!sent.isOk) return;
    const taskId = sent.value.taskId;

    // Pause
    await delta.pause(taskId);

    // Resume with a fresh reasoner that scripts the second action
    const delta2 = createDeltaEngine({
      store, // shared store — same task
      reasoner: createMockReasoner({ responses: [{ actionName: "second", input: {} }] }),
    });
    // Re-register the same agent (fresh registry for delta2)
    const first2 = delta2.action({ name: "first", description: "test action", schema: z.object({}), fn: async () => Ok("ok") });
    const second2 = delta2.action({ name: "second", description: "test action", schema: z.object({}), fn: async () => { executed.push("second-resumed"); return Ok("ok"); } });
    const ag2 = delta2.agent({ name: "resumable", description: "test action", role: "r", rolePrompt: ".", actions: [first2, second2] });
    delta2.deploy(ag2);

    const resumeResult = await delta2.resume(taskId);
    expect(resumeResult.isOk).toBe(true);
    if (resumeResult.isOk) expect(resumeResult.value.status).toBe("completed");
    expect(executed).toContain("second-resumed");
  });

  it("resume returns Err for unknown task", async () => {
    const delta = createDeltaEngine();
    const result = await delta.resume("tsk_ghost");
    expect(result.isErr).toBe(true);
  });

  it("pause returns Err for unknown task", async () => {
    const delta = createDeltaEngine();
    const result = await delta.pause("tsk_ghost");
    expect(result.isErr).toBe(true);
  });
});

// ── approve ───────────────────────────────────────────────────────────────────

describe("approve — resolve a pending approval", () => {
  it("approve marks the approval as approved", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({ store, reasoner: createMockReasoner() });

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
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine({
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
    const delta2 = createDeltaEngine({
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

// ── lastTask + invariant 25/26 ────────────────────────────────────────────────

describe("lastTask — retrieval without stored TaskID (invariant 25)", () => {
  it("lastTask returns the agent's most recent task", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine();
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

    const delta = createDeltaEngine({ store });
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

    const delta = createDeltaEngine({ store, reasoner: createMockReasoner() });
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
  it("C2 — a reasoner failure marks the task failed, never completed", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({
      store,
      reasoner: createMockReasoner({ alwaysFail: "model exploded" }),
    });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "fail-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    const result = await delta.send({ goal: "go", agentName: "fail-agent" });
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.status).toBe("failed");
      expect(result.value.reason).toMatch(/reasoner failed/);
    }
  });

  it("C4 — reasoning token cost is recorded on the execution and drives spent", async () => {
    const store = createInMemoryStore();
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine({ store, reasoner: createMockReasoner() });
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
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine({
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
    const delta = createDeltaEngine({ store, reasoner: createMockReasoner({ alwaysFail: "reasoner must not run" }) });

    const a1 = delta.action({ name: "a1", description: "test action", schema: z.object({}), fn: async () => { order.push("a1"); return Ok("ok"); } });
    const a2 = delta.action({ name: "a2", description: "test action", schema: z.object({}), fn: async () => { order.push("a2"); return Ok("ok"); } });
    const b1 = delta.action({ name: "b1", description: "test action", schema: z.object({}), fn: async () => { order.push("b1"); return Ok("ok"); } });

    const phase1 = delta.phase({ name: "phase-1", description: "first", actions: ["a1", "a2"], checkpoint: true });
    const phase2 = delta.phase({ name: "phase-2", description: "second", actions: ["b1"], checkpoint: false });
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
    const delta = createDeltaEngine({ store });

    const check = delta.action({ name: "check", description: "test action", schema: z.object({}), fn: async () => { ran.push("check"); return Ok("ok"); } });
    const approve = delta.action({ name: "approve", description: "test action", schema: z.object({}), fn: async () => { ran.push("approve"); return Ok("ok"); } });
    const reject = delta.action({ name: "reject", description: "test action", schema: z.object({}), fn: async () => { ran.push("reject"); return Ok("ok"); } });

    const decide = delta.phase({
      name: "decide",
      description: "branch",
      actions: [{ action: "check", onSuccess: "approve", onFailure: "reject" }, "approve", "reject"],
      checkpoint: false,
    });
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
    const delta = createDeltaEngine({ store });
    const act = delta.action({ name: "act", description: "test action", schema: z.object({}), fn: noop });
    const other = delta.action({ name: "other", description: "test action", schema: z.object({}), fn: noop });
    const ph = delta.phase({ name: "p", description: "p", actions: ["other"], checkpoint: false });
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
    const delta = createDeltaEngine({ store });

    const flaky = delta.action({
      name: "flaky",
      description: "always fails",
      schema: z.object({}),
      fn: async () => { attempts++; return Err("transient") as unknown as ReturnType<typeof noop>; },
    });
    const ph = delta.phase({
      name: "flaky-phase",
      description: "retried",
      actions: ["flaky"],
      checkpoint: false,
      supervision: { strategy: "retry", maxRetries: 2 },
    });
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
    const delta = createDeltaEngine({ store });

    // A failed action routes to the phase's supervision policy (escalate),
    // not to post-step governance — so the policy reliably decides the outcome.
    const boom = delta.action({
      name: "boom",
      description: "fails",
      schema: z.object({}),
      fn: async () => Err("kaboom") as unknown as ReturnType<typeof noop>,
    });
    const ph = delta.phase({
      name: "boom-phase",
      description: "escalates",
      actions: ["boom"],
      checkpoint: false,
      supervision: { strategy: "escalate", maxRetries: 0 },
    });
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
    const delta = createDeltaEngine({ store });

    const prep = delta.action({ name: "prep", description: "test action", schema: z.object({}), fn: async () => { ran.push("prep"); return Ok("ok"); } });
    const pay = delta.action({ name: "pay", description: "needs sign-off", schema: z.object({}), requiresApproval: true, fn: async () => { ran.push("pay"); return Ok("ok"); } });
    const ph = delta.phase({ name: "pay-phase", description: "p", actions: ["prep", "pay"], checkpoint: false });
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
    const delta = createDeltaEngine({ store, reasoner });

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
    const delta = createDeltaEngine({ store, reasoner });

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
    const delta = createDeltaEngine({ store, reasoner });

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

  it("a delegated subtask that fails surfaces the parent as failed, not completed (D1)", async () => {
    const store = createInMemoryStore();
    const parentQueue: Array<{ delegate: { goal: string; agentName: string } } | "done"> = [
      { delegate: { goal: "sub", agentName: "child-agent" } },
      "done",
    ];
    // The child's model fails outright (an Err is never a completion).
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) => {
        if (agentRole === "Parent") {
          const next = parentQueue.shift();
          if (next === undefined || next === "done") return Ok({ kind: "done" });
          return Ok({ kind: "delegate", delegation: next.delegate });
        }
        return Err("child model exploded");
      },
    };
    const delta = createDeltaEngine({ store, reasoner });
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
    const delta = createDeltaEngine({ store, reasoner });
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
    const delta = createDeltaEngine({ store, reasoner });
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
    const delta = createDeltaEngine({ store, reasoner: createMockReasoner() });
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
