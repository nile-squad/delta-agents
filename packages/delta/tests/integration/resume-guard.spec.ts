/**
 * Concurrent-resume guard — transitionTaskStatus is a compare-and-swap.
 *
 * WHY: resumeTask used to read the status and then write "running" as two
 * separate steps, so two concurrent resume() calls could both pass the check
 * and double-drive one task. The CAS makes the check and the write one atomic
 * operation at the adapter level: exactly one caller wins, the loser gets an
 * Err naming the actual current status.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore, createDrizzleStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import type { StoragePort } from "../../src/ports/storage-port";
import { taskId, checkpointId } from "../../src/shared/id";
import { initialRiskState, initialTrust } from "../../src/governance";
import { snapshotToJson } from "../../src/state-space/task-state";
import type { TaskStateSnapshot } from "../../src/state-space/types";
import type { Task } from "../../src/shared/types";

const BUDGET = { tokens: 10_000, durationMs: 300_000 };

const makeTask = (overrides: Partial<Task> = {}): Task => {
  const id = overrides.id ?? taskId();
  const now = new Date();
  return {
    id, rootId: id, status: "paused", goal: "guarded work", assignedAgent: "g-agent",
    budget: BUDGET, risk: initialRiskState(), trust: initialTrust(), createdAt: now, updatedAt: now,
    ...overrides,
  };
};

const casContract = (name: string, makeStore: () => Promise<StoragePort> | StoragePort) => {
  describe(`transitionTaskStatus — ${name}`, () => {
    it("succeeds when the current status is in `from`", async () => {
      const store = await makeStore();
      const task = makeTask({ status: "paused" });
      await store.saveTask(task);

      const result = await store.transitionTaskStatus(task.id, ["paused", "pending"], "running");
      expect(result.isOk).toBe(true);
      if (!result.isOk) return;
      expect(result.value.status).toBe("running");

      const readBack = await store.getTask(task.id);
      expect(readBack.isOk).toBe(true);
      if (!readBack.isOk) return;
      expect(readBack.value.status).toBe("running");
    });

    it("errs naming the actual status when the current status is not in `from`", async () => {
      const store = await makeStore();
      const task = makeTask({ status: "running" });
      await store.saveTask(task);

      const result = await store.transitionTaskStatus(task.id, ["paused"], "running");
      expect(result.isErr).toBe(true);
      if (!result.isErr) return;
      expect(result.error).toContain('"running"');

      // The losing swap changed nothing.
      const readBack = await store.getTask(task.id);
      expect(readBack.isOk).toBe(true);
      if (!readBack.isOk) return;
      expect(readBack.value.status).toBe("running");
    });

    it("errs on an unknown task id", async () => {
      const store = await makeStore();
      const result = await store.transitionTaskStatus("tsk_missing", ["paused"], "running");
      expect(result.isErr).toBe(true);
    });
  });
};

casContract("in-memory store", () => createInMemoryStore());
casContract("drizzle store (libsql :memory:)", () => createDrizzleStore(":memory:"));

describe("resumeTask — the CAS is the resume gate", () => {
  it("refuses to resume a task that is already running", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [] }),
    });
    const act = delta.action({
      name: "work", description: "d", schema: z.object({}),
      fn: async () => Ok("done"),
    });
    delta.deploy(delta.agent({ name: "g-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    const id = taskId();
    const past = new Date(Date.now() - 60_000);
    // A task another process is already driving.
    await store.saveTask(makeTask({ id, status: "running", createdAt: past, updatedAt: past }));
    const snapshot: TaskStateSnapshot = {
      taskId: id, rootId: id, agentName: "g-agent", status: "running",
      completedActions: [], completedWorkflows: [],
      budget: BUDGET, spent: { tokens: 0, durationMs: 0 },
      risk: initialRiskState(), trust: initialTrust(),
    };
    await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: snapshotToJson(snapshot), createdAt: past });

    const resumed = await delta.resume(id);
    expect(resumed.isErr).toBe(true);
    if (!resumed.isErr) return;
    expect(resumed.error).toMatch(/"running"/);
    expect(resumed.error).toMatch(/concurrent resume/);
  });

  it("a second sequential resume of a completed task is refused", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [] }),
    });
    const act = delta.action({
      name: "work", description: "d", schema: z.object({}),
      fn: async () => Ok("done"),
    });
    delta.deploy(delta.agent({ name: "g-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    const id = taskId();
    const past = new Date(Date.now() - 60_000);
    await store.saveTask(makeTask({ id, status: "paused", createdAt: past, updatedAt: past }));
    const snapshot: TaskStateSnapshot = {
      taskId: id, rootId: id, agentName: "g-agent", status: "paused",
      completedActions: [], completedWorkflows: [],
      budget: BUDGET, spent: { tokens: 0, durationMs: 0 },
      risk: initialRiskState(), trust: initialTrust(),
    };
    await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: snapshotToJson(snapshot), createdAt: past });

    const first = await delta.resume(id);
    expect(first.isOk).toBe(true);
    if (!first.isOk) return;
    expect(first.value.status).toBe("completed");

    const second = await delta.resume(id);
    expect(second.isErr).toBe(true);
  });
});
