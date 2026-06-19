/**
 * Drizzle store contract tests — every StoragePort method verified against
 * a real libsql in-memory database.
 *
 * Each test creates its own isolated store (createDrizzleStore() defaults to
 * ":memory:") so there is no cross-test state. Tests assert against the same
 * behavioral contract the in-memory store satisfies; swapping adapters should
 * never change engine behavior.
 */

import { describe, it, expect } from "vitest";
import { createDrizzleStore } from "../../src/ports/drizzle-store";
import type { Task, TaskTree, Execution, Checkpoint, ApprovalRequest, EscalationRecord, Message, Queue } from "../../src/shared/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id:            "tsk_test_001",
  rootId:        "tsk_test_001",
  status:        "running",
  goal:          "test goal",
  assignedAgent: "agent-x",
  budget:        { tokens: 1000, durationMs: 60_000 },
  risk:          { staticRisk: 0.1, currentRisk: 0.1, predictedRisk: 0.1, confidence: 0.9, escalated: false },
  trust:         { score: 0.8, successfulExecutions: 5, failedExecutions: 0, surpriseEvents: 0 },
  createdAt:     new Date("2026-06-01T10:00:00.000Z"),
  updatedAt:     new Date("2026-06-01T10:00:00.000Z"),
  ...overrides,
});

const makeExecution = (overrides: Partial<Execution> = {}): Execution => ({
  id:        "exc_test_001",
  taskId:    "tsk_test_001",
  action:    "do-something",
  startedAt: new Date("2026-06-01T10:00:01.000Z"),
  status:    "completed",
  cost:      { tokens: 50, durationMs: 1200 },
  ...overrides,
});

const makeCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  id:        "ckpt_test_001",
  taskId:    "tsk_test_001",
  state:     { completedActions: ["do-something"], status: "running" },
  createdAt: new Date("2026-06-01T10:00:02.000Z"),
  ...overrides,
});

const makeApproval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id:        "appr_test_001",
  taskId:    "tsk_test_001",
  action:    "risky-action",
  reason:    "requires human sign-off",
  status:    "pending",
  createdAt: new Date("2026-06-01T10:00:03.000Z"),
  ...overrides,
});

const makeEscalation = (overrides: Partial<EscalationRecord> = {}): EscalationRecord => ({
  id:        "esc_test_001",
  taskId:    "tsk_test_001",
  trigger:   "risk-threshold",
  reason:    "risk exceeded 0.8",
  createdAt: new Date("2026-06-01T10:00:04.000Z"),
  ...overrides,
});

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  id:        "msg_test_001",
  taskId:    "tsk_test_001",
  sender:    "agent-x",
  receiver:  "agent-y",
  payload:   { content: "hello" },
  createdAt: new Date("2026-06-01T10:00:05.000Z"),
  ...overrides,
});

const makeQueue = (overrides: Partial<Queue> = {}): Queue => ({
  id:        "q_test_001",
  taskId:    "tsk_test_001",
  pending:   ["item-1", "item-2"],
  active:    [],
  completed: [],
  ...overrides,
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

describe("DrizzleStore — tasks", () => {
  it("saveTask then getTask returns the same task", async () => {
    const store = await createDrizzleStore();
    const task = makeTask();
    await store.saveTask(task);
    const result = await store.getTask(task.id);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.id).toBe(task.id);
    expect(result.value.goal).toBe(task.goal);
    expect(result.value.budget).toEqual(task.budget);
    expect(result.value.risk).toEqual(task.risk);
    expect(result.value.trust).toEqual(task.trust);
    expect(result.value.createdAt.toISOString()).toBe(task.createdAt.toISOString());
  });

  it("getTask returns Err for unknown id", async () => {
    const store = await createDrizzleStore();
    const result = await store.getTask("does-not-exist");
    expect(result.isErr).toBe(true);
  });

  it("updateTask patches status and updatedAt", async () => {
    const store = await createDrizzleStore();
    const task = makeTask();
    await store.saveTask(task);
    const later = new Date("2026-06-01T10:05:00.000Z");
    const result = await store.updateTask(task.id, { status: "completed", updatedAt: later });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.updatedAt.toISOString()).toBe(later.toISOString());
  });

  it("updateTask patches risk and trust (nested JSON)", async () => {
    const store = await createDrizzleStore();
    await store.saveTask(makeTask());
    const newRisk = { staticRisk: 0.5, currentRisk: 0.8, predictedRisk: 0.9, confidence: 0.7, escalated: true };
    const result = await store.updateTask("tsk_test_001", { risk: newRisk, updatedAt: new Date() });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.risk).toEqual(newRisk);
  });

  it("getLatestTaskByAgent returns the most-recently-updated task", async () => {
    const store = await createDrizzleStore();
    const early = makeTask({ id: "tsk_early", updatedAt: new Date("2026-06-01T09:00:00.000Z") });
    const late  = makeTask({ id: "tsk_late",  updatedAt: new Date("2026-06-01T11:00:00.000Z") });
    await store.saveTask(early);
    await store.saveTask(late);
    const result = await store.getLatestTaskByAgent("agent-x");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value?.id).toBe("tsk_late");
  });

  it("getLatestTaskByAgent returns null when no tasks exist", async () => {
    const store = await createDrizzleStore();
    const result = await store.getLatestTaskByAgent("nobody");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toBeNull();
  });

  it("parentId roundtrips correctly", async () => {
    const store = await createDrizzleStore();
    const task = makeTask({ id: "tsk_child", parentId: "tsk_parent" });
    await store.saveTask(task);
    const result = await store.getTask("tsk_child");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.parentId).toBe("tsk_parent");
  });
});

// ── Task Trees ────────────────────────────────────────────────────────────────

describe("DrizzleStore — task trees", () => {
  it("saveTaskTree then getTaskTree returns the tree", async () => {
    const store = await createDrizzleStore();
    const tree: TaskTree = { rootTaskId: "tsk_root", activeChildren: ["tsk_a"], queuedChildren: [], maxConcurrency: 2 };
    await store.saveTaskTree(tree);
    const result = await store.getTaskTree("tsk_root");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.activeChildren).toEqual(["tsk_a"]);
    expect(result.value.maxConcurrency).toBe(2);
  });

  it("updateTaskTree patches active children", async () => {
    const store = await createDrizzleStore();
    const tree: TaskTree = { rootTaskId: "tsk_root2", activeChildren: [], queuedChildren: [], maxConcurrency: 2 };
    await store.saveTaskTree(tree);
    const result = await store.updateTaskTree("tsk_root2", { activeChildren: ["tsk_new"] });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.activeChildren).toEqual(["tsk_new"]);
  });
});

// ── Executions ────────────────────────────────────────────────────────────────

describe("DrizzleStore — executions", () => {
  it("saveExecution then getExecution returns the record", async () => {
    const store = await createDrizzleStore();
    const exec = makeExecution();
    await store.saveTask(makeTask());
    await store.saveExecution(exec);
    const result = await store.getExecution(exec.id);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.action).toBe("do-something");
    expect(result.value.cost).toEqual({ tokens: 50, durationMs: 1200 });
  });

  it("getExecutionsByTask returns only executions for that task", async () => {
    const store = await createDrizzleStore();
    await store.saveTask(makeTask({ id: "tsk_a" }));
    await store.saveTask(makeTask({ id: "tsk_b" }));
    await store.saveExecution(makeExecution({ id: "exc_a", taskId: "tsk_a" }));
    await store.saveExecution(makeExecution({ id: "exc_b", taskId: "tsk_b" }));
    const result = await store.getExecutionsByTask("tsk_a");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.taskId).toBe("tsk_a");
  });

  it("updateExecution sets endedAt and status", async () => {
    const store = await createDrizzleStore();
    await store.saveTask(makeTask());
    const exec = makeExecution({ status: "running" });
    await store.saveExecution(exec);
    const endedAt = new Date("2026-06-01T10:01:00.000Z");
    const result = await store.updateExecution(exec.id, { status: "completed", endedAt });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.endedAt?.toISOString()).toBe(endedAt.toISOString());
  });
});

// ── Checkpoints ───────────────────────────────────────────────────────────────

describe("DrizzleStore — checkpoints", () => {
  it("saveCheckpoint then getLatestCheckpoint returns the checkpoint", async () => {
    const store = await createDrizzleStore();
    const ckpt = makeCheckpoint();
    await store.saveCheckpoint(ckpt);
    const result = await store.getLatestCheckpoint(ckpt.taskId);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).not.toBeNull();
    expect(result.value?.id).toBe(ckpt.id);
    expect(result.value?.state).toEqual(ckpt.state);
  });

  it("getLatestCheckpoint returns the newest when multiple exist", async () => {
    const store = await createDrizzleStore();
    const older = makeCheckpoint({ id: "ckpt_old", createdAt: new Date("2026-06-01T10:00:00.000Z") });
    const newer = makeCheckpoint({ id: "ckpt_new", createdAt: new Date("2026-06-01T10:05:00.000Z") });
    await store.saveCheckpoint(older);
    await store.saveCheckpoint(newer);
    const result = await store.getLatestCheckpoint("tsk_test_001");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value?.id).toBe("ckpt_new");
  });

  it("getLatestCheckpoint returns null when none exist", async () => {
    const store = await createDrizzleStore();
    const result = await store.getLatestCheckpoint("tsk_no_ckpt");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toBeNull();
  });

  it("checkpoint state preserves nested JSON structure", async () => {
    const store = await createDrizzleStore();
    const state = { completedActions: ["a", "b"], risk: { escalated: false, score: 0.5 }, nested: { deep: true } };
    await store.saveCheckpoint(makeCheckpoint({ state }));
    const result = await store.getLatestCheckpoint("tsk_test_001");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value?.state).toEqual(state);
  });
});

// ── Approvals ─────────────────────────────────────────────────────────────────

describe("DrizzleStore — approvals", () => {
  it("saveApprovalRequest then getApprovalRequest returns the record", async () => {
    const store = await createDrizzleStore();
    const req = makeApproval();
    await store.saveApprovalRequest(req);
    const result = await store.getApprovalRequest(req.id);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.action).toBe("risky-action");
    expect(result.value.status).toBe("pending");
  });

  it("getPendingApprovals filters to pending only", async () => {
    const store = await createDrizzleStore();
    await store.saveApprovalRequest(makeApproval({ id: "appr_1", status: "pending" }));
    await store.saveApprovalRequest(makeApproval({ id: "appr_2", status: "approved" }));
    const result = await store.getPendingApprovals("tsk_test_001");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.id).toBe("appr_1");
  });

  it("getApprovalsByTask returns all regardless of status", async () => {
    const store = await createDrizzleStore();
    await store.saveApprovalRequest(makeApproval({ id: "appr_1", status: "pending" }));
    await store.saveApprovalRequest(makeApproval({ id: "appr_2", status: "rejected" }));
    const result = await store.getApprovalsByTask("tsk_test_001");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(2);
  });

  it("updateApprovalRequest changes status to approved", async () => {
    const store = await createDrizzleStore();
    const req = makeApproval();
    await store.saveApprovalRequest(req);
    const result = await store.updateApprovalRequest(req.id, { status: "approved" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("approved");
  });

  it("getApprovalsByTask scopes to the correct task", async () => {
    const store = await createDrizzleStore();
    await store.saveApprovalRequest(makeApproval({ id: "appr_a", taskId: "tsk_a" }));
    await store.saveApprovalRequest(makeApproval({ id: "appr_b", taskId: "tsk_b" }));
    const result = await store.getApprovalsByTask("tsk_a");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.taskId).toBe("tsk_a");
  });
});

// ── Escalations ───────────────────────────────────────────────────────────────

describe("DrizzleStore — escalations", () => {
  it("saveEscalation then getEscalationsByTask returns the record", async () => {
    const store = await createDrizzleStore();
    const esc = makeEscalation();
    await store.saveEscalation(esc);
    const result = await store.getEscalationsByTask(esc.taskId);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.trigger).toBe("risk-threshold");
    expect(result.value[0]?.id).toBe("esc_test_001");
  });

  it("getEscalationsByTask scopes to the correct task", async () => {
    const store = await createDrizzleStore();
    await store.saveEscalation(makeEscalation({ id: "esc_a", taskId: "tsk_x" }));
    await store.saveEscalation(makeEscalation({ id: "esc_b", taskId: "tsk_y" }));
    const result = await store.getEscalationsByTask("tsk_x");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.taskId).toBe("tsk_x");
  });

  it("stores all six trigger types faithfully", async () => {
    const store = await createDrizzleStore();
    const triggers = ["risk-threshold", "bayesian-surprise", "policy-violation", "budget-violation", "workflow-failure", "explicit"] as const;
    for (const [i, trigger] of triggers.entries()) {
      await store.saveEscalation(makeEscalation({ id: `esc_${i}`, taskId: "tsk_trig", trigger }));
    }
    const result = await store.getEscalationsByTask("tsk_trig");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const stored = result.value.map((e) => e.trigger).sort();
    expect(stored).toEqual([...triggers].sort());
  });
});

// ── Messages ──────────────────────────────────────────────────────────────────

describe("DrizzleStore — messages", () => {
  it("saveMessage then getMessages returns the message", async () => {
    const store = await createDrizzleStore();
    const msg = makeMessage();
    await store.saveMessage(msg);
    const result = await store.getMessages(msg.taskId);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.payload).toEqual({ content: "hello" });
  });

  it("getMessages scopes to the correct task", async () => {
    const store = await createDrizzleStore();
    await store.saveMessage(makeMessage({ id: "msg_a", taskId: "tsk_a" }));
    await store.saveMessage(makeMessage({ id: "msg_b", taskId: "tsk_b" }));
    const result = await store.getMessages("tsk_a");
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.taskId).toBe("tsk_a");
  });
});

// ── Queues ────────────────────────────────────────────────────────────────────

describe("DrizzleStore — queues", () => {
  it("saveQueue then getQueue returns the queue", async () => {
    const store = await createDrizzleStore();
    const queue = makeQueue();
    await store.saveQueue(queue);
    const result = await store.getQueue(queue.id);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.pending).toEqual(["item-1", "item-2"]);
    expect(result.value.active).toEqual([]);
  });

  it("updateQueue moves items from pending to active", async () => {
    const store = await createDrizzleStore();
    const queue = makeQueue();
    await store.saveQueue(queue);
    const result = await store.updateQueue(queue.id, { pending: ["item-2"], active: ["item-1"] });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.pending).toEqual(["item-2"]);
    expect(result.value.active).toEqual(["item-1"]);
  });

  it("getQueue returns Err for unknown id", async () => {
    const store = await createDrizzleStore();
    const result = await store.getQueue("no-such-queue");
    expect(result.isErr).toBe(true);
  });
});

// ── Cross-entity invariants ───────────────────────────────────────────────────

describe("DrizzleStore — cross-entity isolation", () => {
  it("two independent in-memory stores do not share state", async () => {
    const storeA = await createDrizzleStore();
    const storeB = await createDrizzleStore();
    await storeA.saveTask(makeTask({ id: "tsk_only_in_A" }));
    const resultB = await storeB.getTask("tsk_only_in_A");
    expect(resultB.isErr).toBe(true);
  });
});
