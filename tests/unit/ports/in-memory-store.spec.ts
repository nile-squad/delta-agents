import { describe, it, expect } from "vitest";
import { createInMemoryStore } from "../../../src/ports";
import type { Task, Checkpoint, ApprovalRequest, Message } from "../../../src/shared/types";

// Minimal valid Task fixture — all required fields set by this test, never by live DB.
const makeTask = (overrides?: Partial<Task>): Task => ({
  id: "task-001",
  rootId: "task-001",
  status: "pending",
  goal: "test goal",
  assignedAgent: "test-agent",
  budget: { tokens: 1000, durationMs: 60_000 },
  risk: { staticRisk: 1, currentRisk: 1, predictedRisk: 1, confidence: 0.9, escalated: false },
  trust: { score: 0.8, successfulExecutions: 0, failedExecutions: 0, surpriseEvents: 0 },
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  ...overrides,
});

const makeCheckpoint = (overrides?: Partial<Checkpoint>): Checkpoint => ({
  id: "ckpt-001",
  taskId: "task-001",
  state: { step: "investigation" },
  createdAt: new Date("2024-01-01"),
  ...overrides,
});

const makeApproval = (overrides?: Partial<ApprovalRequest>): ApprovalRequest => ({
  id: "appr-001",
  taskId: "task-001",
  action: "delete-customer",
  reason: "high risk action",
  status: "pending",
  createdAt: new Date("2024-01-01"),
  ...overrides,
});

const makeMessage = (overrides?: Partial<Message>): Message => ({
  id: "msg-001",
  taskId: "task-001",
  sender: "user",
  receiver: "support-agent",
  payload: "hello",
  createdAt: new Date("2024-01-01"),
  ...overrides,
});

describe("InMemoryStore — tasks", () => {
  it("saves and retrieves a task by id", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);
    const result = await store.getTask("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toEqual(task);
  });

  it("getTask returns Err for an id that was never saved", async () => {
    const store = createInMemoryStore();
    const result = await store.getTask("no-such-id");
    expect(result.isErr).toBe(true);
  });

  it("updateTask applies a patch and returns the updated task", async () => {
    const store = createInMemoryStore();
    await store.saveTask(makeTask());
    const result = await store.updateTask("task-001", { status: "running" });
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.status).toBe("running");
      expect(result.value.goal).toBe("test goal"); // unchanged fields preserved
    }
  });

  it("updateTask returns Err for a missing id", async () => {
    const store = createInMemoryStore();
    const result = await store.updateTask("ghost", { status: "running" });
    expect(result.isErr).toBe(true);
  });

  it("saving the same id twice overwrites with the latest version", async () => {
    const store = createInMemoryStore();
    await store.saveTask(makeTask({ goal: "original" }));
    await store.saveTask(makeTask({ goal: "updated" }));
    const result = await store.getTask("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.goal).toBe("updated");
  });
});

describe("InMemoryStore — isolation", () => {
  it("two store instances share no state", async () => {
    const storeA = createInMemoryStore();
    const storeB = createInMemoryStore();
    await storeA.saveTask(makeTask({ id: "task-A", rootId: "task-A" }));
    const resultB = await storeB.getTask("task-A");
    expect(resultB.isErr).toBe(true);
  });
});

describe("InMemoryStore — checkpoints", () => {
  it("getLatestCheckpoint returns null when none have been saved", async () => {
    const store = createInMemoryStore();
    const result = await store.getLatestCheckpoint("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBeNull();
  });

  it("getLatestCheckpoint returns the most recently saved checkpoint", async () => {
    const store = createInMemoryStore();
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt-001", state: { step: "phase-1" } }));
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt-002", state: { step: "phase-2" } }));
    const result = await store.getLatestCheckpoint("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value?.id).toBe("ckpt-002");
      expect(result.value?.state).toEqual({ step: "phase-2" });
    }
  });

  it("checkpoints from different tasks do not interfere", async () => {
    const store = createInMemoryStore();
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt-A", taskId: "task-A" }));
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt-B", taskId: "task-B" }));
    const resultA = await store.getLatestCheckpoint("task-A");
    const resultB = await store.getLatestCheckpoint("task-B");
    if (resultA.isOk) expect(resultA.value?.id).toBe("ckpt-A");
    if (resultB.isOk) expect(resultB.value?.id).toBe("ckpt-B");
  });
});

describe("InMemoryStore — approvals", () => {
  it("getPendingApprovals returns only pending approvals for the given task", async () => {
    const store = createInMemoryStore();
    await store.saveApprovalRequest(makeApproval({ id: "appr-001", status: "pending", taskId: "task-001" }));
    await store.saveApprovalRequest(makeApproval({ id: "appr-002", status: "approved", taskId: "task-001" }));
    await store.saveApprovalRequest(makeApproval({ id: "appr-003", status: "pending", taskId: "task-002" }));
    const result = await store.getPendingApprovals("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe("appr-001");
    }
  });

  it("updateApprovalRequest resolves the approval status", async () => {
    const store = createInMemoryStore();
    await store.saveApprovalRequest(makeApproval({ id: "appr-001" }));
    const result = await store.updateApprovalRequest("appr-001", { status: "approved" });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("approved");
  });
});

describe("InMemoryStore — messages", () => {
  it("getMessages returns an empty array when no messages have been saved", async () => {
    const store = createInMemoryStore();
    const result = await store.getMessages("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toHaveLength(0);
  });

  it("getMessages returns messages in insertion order (FIFO)", async () => {
    const store = createInMemoryStore();
    await store.saveMessage(makeMessage({ id: "msg-001", payload: "first" }));
    await store.saveMessage(makeMessage({ id: "msg-002", payload: "second" }));
    await store.saveMessage(makeMessage({ id: "msg-003", payload: "third" }));
    const result = await store.getMessages("task-001");
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const payloads = result.value.map((m) => m.payload);
      expect(payloads).toEqual(["first", "second", "third"]);
    }
  });

  it("messages from different tasks are isolated", async () => {
    const store = createInMemoryStore();
    await store.saveMessage(makeMessage({ id: "msg-A", taskId: "task-A" }));
    await store.saveMessage(makeMessage({ id: "msg-B", taskId: "task-B" }));
    const resultA = await store.getMessages("task-A");
    const resultB = await store.getMessages("task-B");
    if (resultA.isOk) expect(resultA.value).toHaveLength(1);
    if (resultB.isOk) expect(resultB.value).toHaveLength(1);
  });
});

describe("InMemoryStore — executions", () => {
  it("getExecutionsByTask returns only executions for the given task", async () => {
    const store = createInMemoryStore();
    const execA = {
      id: "exec-001", taskId: "task-A", action: "lookup",
      startedAt: new Date(), status: "completed" as const,
      cost: { tokens: 50, durationMs: 200 },
    };
    const execB = {
      id: "exec-002", taskId: "task-B", action: "notify",
      startedAt: new Date(), status: "completed" as const,
      cost: { tokens: 30, durationMs: 100 },
    };
    await store.saveExecution(execA);
    await store.saveExecution(execB);
    const result = await store.getExecutionsByTask("task-A");
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe("exec-001");
    }
  });
});
