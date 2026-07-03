/**
 * End-to-end delta.cleanup() tests.
 *
 * Wires the engine with a mock reasoner, runs tasks to completion/failure,
 * waits past the retention window, then calls delta.cleanup() and verifies
 * the right rows are gone and the right rows remain. Also exercises the
 * graceful-degradation path (a store without the optional cleanup methods).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports/in-memory-store";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import type { Task, Message } from "../../src/shared/types";
import { initialRiskState, initialTrust } from "../../src/governance";
import type { StoragePort } from "../../src/ports/storage-port";

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeTask = (
  overrides: Partial<Task> & Pick<Task, "id" | "assignedAgent">,
): Task => ({
  rootId: overrides.id,
  status: "running",
  goal: overrides.goal ?? "g",
  budget: { tokens: 10_000, durationMs: 60_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// A trivial reasoner that always returns done — useful for tests that need a
// wired engine but do not exercise the reasoner loop.
const doneReasoner = {
  reason: async () => Ok({ kind: "done" as const }),
};

// ── end-to-end cleanup ───────────────────────────────────────────────────────

describe("delta.cleanup() — end-to-end", () => {
  it("removes completed tasks past taskRetentionMs and leaves running ones", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: doneReasoner });

    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 100);
    await store.saveTask(makeTask({ assignedAgent: "a", id: "old-completed", status: "completed", updatedAt: old, goal: "old" }));
    await store.saveTask(makeTask({ assignedAgent: "a", id: "recent-completed", status: "completed", updatedAt: recent, goal: "recent" }));
    await store.saveTask(makeTask({ assignedAgent: "a", id: "old-running", status: "running", updatedAt: old, goal: "running" }));

    const result = await delta.cleanup({ taskRetentionMs: 5_000 });
    expect(result.isOk).toBe(true);
    expect((await store.getTask("old-completed")).isErr).toBe(true);
    expect((await store.getTask("recent-completed")).isOk).toBe(true);
    expect((await store.getTask("old-running")).isOk).toBe(true);
  });

  it("removes failed tasks past the retention window", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: doneReasoner });
    const old = new Date(Date.now() - 10_000);
    await store.saveTask(makeTask({ assignedAgent: "a", id: "old-failed", status: "failed", updatedAt: old, goal: "x" }));

    const result = await delta.cleanup({ taskRetentionMs: 5_000 });
    expect(result.isOk).toBe(true);
    expect((await store.getTask("old-failed")).isErr).toBe(true);
  });

  it("removes consumed messages past messageRetentionMs and leaves unconsumed ones", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: doneReasoner });
    await store.saveTask(makeTask({ assignedAgent: "a", id: "t1" }));
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 100);
    const baseMessage = { taskId: "t1", sender: "x", receiver: "y", payload: "hi" };
    await store.saveMessage({ ...baseMessage, id: "old-consumed", consumed: true, createdAt: old });
    await store.saveMessage({ ...baseMessage, id: "recent-consumed", consumed: true, createdAt: recent });
    await store.saveMessage({ ...baseMessage, id: "old-unconsumed", consumed: false, createdAt: old });

    const result = await delta.cleanup({ messageRetentionMs: 5_000 });
    expect(result.isOk).toBe(true);
    const messages = await store.getMessages("t1");
    if (!messages.isOk) throw new Error("expected ok");
    const ids = messages.value.map((m) => m.id).sort();
    expect(ids).toEqual(["old-unconsumed", "recent-consumed"]);
  });

  it("a no-op cleanup (no options) is Ok and touches nothing", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: doneReasoner });

    await store.saveTask(makeTask({ assignedAgent: "a", id: "any", status: "completed", updatedAt: new Date(Date.now() - 100_000) }));
    const result = await delta.cleanup();
    expect(result.isOk).toBe(true);
    expect((await store.getTask("any")).isOk).toBe(true);
  });

  it("combined cleanup prunes both tasks and messages in one call", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: doneReasoner });
    const old = new Date(Date.now() - 10_000);
    await store.saveTask(makeTask({ assignedAgent: "a", id: "old-done", status: "completed", updatedAt: old, goal: "x" }));
    await store.saveMessage({ id: "old-msg", taskId: "old-done", sender: "x", receiver: "y", payload: "hi", consumed: true, createdAt: old });

    const result = await delta.cleanup({ taskRetentionMs: 5_000, messageRetentionMs: 5_000 });
    expect(result.isOk).toBe(true);
    expect((await store.getTask("old-done")).isErr).toBe(true);
    const messages = await store.getMessages("old-done");
    if (messages.isOk) expect(messages.value).toHaveLength(0);
  });
});

describe("delta.cleanup() — graceful degradation for stores missing cleanup methods", () => {
  it("returns Ok and skips task/message pruning with no throw", async () => {
    const inner = createInMemoryStore();
    // Build a minimal store that omits the optional cleanup methods.
    const minimalStore: StoragePort = {
      saveTask: inner.saveTask,
      getTask: inner.getTask,
      updateTask: inner.updateTask,
      getLatestTaskByAgent: inner.getLatestTaskByAgent,
      saveTaskTree: inner.saveTaskTree,
      getTaskTree: inner.getTaskTree,
      updateTaskTree: inner.updateTaskTree,
      saveExecution: inner.saveExecution,
      getExecution: inner.getExecution,
      updateExecution: inner.updateExecution,
      getExecutionsByTask: inner.getExecutionsByTask,
      saveCheckpoint: inner.saveCheckpoint,
      getLatestCheckpoint: inner.getLatestCheckpoint,
      saveApprovalRequest: inner.saveApprovalRequest,
      getApprovalRequest: inner.getApprovalRequest,
      updateApprovalRequest: inner.updateApprovalRequest,
      getPendingApprovals: inner.getPendingApprovals,
      getApprovalsByTask: inner.getApprovalsByTask,
      saveEscalation: inner.saveEscalation,
      getEscalationsByTask: inner.getEscalationsByTask,
      saveMessage: inner.saveMessage,
      getMessages: inner.getMessages,
      getMessagesByReceiver: inner.getMessagesByReceiver,
      markMessageConsumed: inner.markMessageConsumed,
      saveMemory: inner.saveMemory,
      getMemoriesByAgent: inner.getMemoriesByAgent,
      saveCommit: inner.saveCommit,
      getCommitsByAgent: inner.getCommitsByAgent,
      searchCommits: inner.searchCommits,
      saveQueue: inner.saveQueue,
      getQueue: inner.getQueue,
      updateQueue: inner.updateQueue,
      // deleteTask, deleteMessages, getTasksOlderThan, getTaskIds intentionally omitted.
    };
    const delta = await createDeltaEngine({ store: minimalStore, reasoner: doneReasoner });
    const result = await delta.cleanup({ taskRetentionMs: 1, messageRetentionMs: 1 });
    expect(result.isOk).toBe(true);
  });
});

describe("delta.cleanup() — through a real send()", () => {
  it("after a task runs to completion, cleanup removes it past the retention window", async () => {
    const store = createInMemoryStore();
    const reasoner = createMockReasoner({ responses: [{ actionName: "noop", input: {} }] });
    const delta = await createDeltaEngine({ store, reasoner });

    const noop = delta.action({
      name: "noop",
      description: "does nothing",
      schema: z.object({}),
      fn: async () => Ok("done"),
    });
    delta.deploy(delta.agent({
      name: "cleanup-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [noop],
    }));

    const r1 = await delta.send({ goal: "first run", agentName: "cleanup-agent" });
    expect(r1.isOk).toBe(true);
    if (!r1.isOk) return;
    expect(r1.value.status).toBe("completed");

    // Backdate the task so it falls outside the retention window.
    await store.updateTask(r1.value.taskId, { updatedAt: new Date(Date.now() - 10_000) });

    const cleanup = await delta.cleanup({ taskRetentionMs: 5_000 });
    expect(cleanup.isOk).toBe(true);
    // Task is pruned end-to-end through the engine facade.
    const after = await store.getTask(r1.value.taskId);
    expect(after.isErr).toBe(true);
  });
});


// ── cleanup against the inner store directly (intended behavior) ────────────
// These tests bypass the engine facade and call runCleanup against the
// in-memory store directly. They prove the cleanup LOGIC is correct; the
// engine-facade test above documents the current wrapper limitation.

describe("runCleanup against the inner store — intended behavior", () => {
  it("removes completed tasks past taskRetentionMs and leaves running ones", async () => {
    const { runCleanup } = await import("../../src/engine/cleanup");
    const { createCache } = await import("../../src/shared/cache");
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 100);
    await store.saveTask(makeTask({ assignedAgent: "a",  id: "old-completed", status: "completed", updatedAt: old, goal: "old"  }));
    await store.saveTask(makeTask({ assignedAgent: "a",  id: "recent-completed", status: "completed", updatedAt: recent, goal: "recent"  }));
    await store.saveTask(makeTask({ assignedAgent: "a",  id: "old-running", status: "running", updatedAt: old, goal: "running"  }));

    const result = await runCleanup({ store, cache, options: { taskRetentionMs: 5_000 } });
    expect(result.isOk).toBe(true);

    expect((await store.getTask("old-completed")).isErr).toBe(true);
    expect((await store.getTask("recent-completed")).isOk).toBe(true);
    expect((await store.getTask("old-running")).isOk).toBe(true);
  });

  it("removes consumed messages past messageRetentionMs and leaves unconsumed ones", async () => {
    const { runCleanup } = await import("../../src/engine/cleanup");
    const { createCache } = await import("../../src/shared/cache");
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 100);
    await store.saveTask(makeTask({ assignedAgent: "a",  id: "t1"  }));
    const baseMessage = { taskId: "t1", sender: "x", receiver: "y", payload: "hi" };
    await store.saveMessage({ ...baseMessage, id: "old-consumed", consumed: true, createdAt: old });
    await store.saveMessage({ ...baseMessage, id: "recent-consumed", consumed: true, createdAt: recent });
    await store.saveMessage({ ...baseMessage, id: "old-unconsumed", consumed: false, createdAt: old });

    const result = await runCleanup({ store, cache, options: { messageRetentionMs: 5_000 } });
    expect(result.isOk).toBe(true);

    const messages = await store.getMessages("t1");
    if (!messages.isOk) throw new Error("expected ok");
    const ids = messages.value.map((m) => m.id).sort();
    expect(ids).toEqual(["old-unconsumed", "recent-consumed"]);
  });

  it("removes failed and aborted tasks past the retention window", async () => {
    const { runCleanup } = await import("../../src/engine/cleanup");
    const { createCache } = await import("../../src/shared/cache");
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const old = new Date(Date.now() - 10_000);
    await store.saveTask(makeTask({ assignedAgent: "a",  id: "old-failed", status: "failed", updatedAt: old  }));
    await store.saveTask(makeTask({ assignedAgent: "a",  id: "old-aborted", status: "aborted", updatedAt: old  }));
    const result = await runCleanup({ store, cache, options: { taskRetentionMs: 5_000 } });
    expect(result.isOk).toBe(true);
    expect((await store.getTask("old-failed")).isErr).toBe(true);
    expect((await store.getTask("old-aborted")).isErr).toBe(true);
  });
});