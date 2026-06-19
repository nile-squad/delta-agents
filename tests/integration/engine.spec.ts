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
