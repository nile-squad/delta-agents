/**
 * Abort cascade tests.
 *
 * abortTask sets a single task to "aborted".
 * abortEntireTree aborts the root and every task it owns.
 *
 * After either operation, checkLegality must return { legal: false } because
 * the task status is "aborted" (prohibition 11: no execution after terminal abort).
 *
 * Covers: invariant 17; prohibition 11.
 */

import { describe, it, expect } from "vitest";
import { abortTask, abortEntireTree } from "../../../src/supervision";
import { checkLegality } from "../../../src/state-space";
import { createInMemoryStore } from "../../../src/ports";
import { initialRiskState, initialTrust } from "../../../src/governance";
import type { Task, TaskTree } from "../../../src/shared/types";

const makeTask = (id: string, rootId?: string, parentId?: string): Task => ({
  id,
  rootId: rootId ?? id,
  parentId,
  status: "running",
  goal: `goal for ${id}`,
  assignedAgent: "test-agent",
  budget: { tokens: 1_000, durationMs: 30_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeTree = (rootTaskId: string, active: string[] = [], queued: string[] = []): TaskTree => ({
  rootTaskId,
  activeChildren: active,
  queuedChildren: queued,
  maxConcurrency: 2,
});

// ── abortTask ─────────────────────────────────────────────────────────────────

describe("abortTask — single task abort", () => {
  it("sets task status to 'aborted'", async () => {
    const store = createInMemoryStore();
    const task = makeTask("tsk_1");
    await store.saveTask(task);

    await abortTask({ taskId: "tsk_1", store });

    const fetched = await store.getTask("tsk_1");
    if (fetched.isOk) expect(fetched.value.status).toBe("aborted");
  });

  it("returns Ok on success", async () => {
    const store = createInMemoryStore();
    await store.saveTask(makeTask("tsk_x"));

    const result = await abortTask({ taskId: "tsk_x", store });
    expect(result.isOk).toBe(true);
  });

  it("returns Err when task does not exist", async () => {
    const store = createInMemoryStore();
    const result = await abortTask({ taskId: "tsk_ghost", store });
    expect(result.isErr).toBe(true);
  });

  it("after abort, checkLegality returns not-legal (prohibition 11)", async () => {
    const store = createInMemoryStore();
    const task = makeTask("tsk_legal");
    await store.saveTask(task);
    await abortTask({ taskId: "tsk_legal", store });

    const fetched = await store.getTask("tsk_legal");
    if (fetched.isOk) {
      const legality = checkLegality({
        action: {
          name: "any",
          description: "any",
          schema: { safeParse: () => ({ success: true, data: {} }) } as any,
          fn: async () => { throw new Error("should not run"); },
        },
        state: {
          taskId: "tsk_legal",
          rootId: "tsk_legal",
          agentName: "test-agent",
          status: fetched.value.status,  // "aborted"
          completedActions: [],
          completedWorkflows: [],
          budget: fetched.value.budget,
          spent: { tokens: 0, durationMs: 0 },
          risk: fetched.value.risk,
          trust: fetched.value.trust,
        },
      });
      expect(legality.legal).toBe(false);
      if (!legality.legal) expect(legality.reason).toMatch(/aborted/);
    }
  });
});

// ── abortEntireTree ───────────────────────────────────────────────────────────

describe("abortEntireTree — cascade abort (invariant 17)", () => {
  it("aborts the root task", async () => {
    const store = createInMemoryStore();
    const root = makeTask("tsk_root");
    await store.saveTask(root);
    await store.saveTaskTree(makeTree("tsk_root"));

    await abortEntireTree({ rootTaskId: "tsk_root", store });

    const fetched = await store.getTask("tsk_root");
    if (fetched.isOk) expect(fetched.value.status).toBe("aborted");
  });

  it("aborts all active children of the root (invariant 17)", async () => {
    const store = createInMemoryStore();
    const root = makeTask("tsk_root");
    const child1 = makeTask("tsk_c1", "tsk_root", "tsk_root");
    const child2 = makeTask("tsk_c2", "tsk_root", "tsk_root");

    await store.saveTask(root);
    await store.saveTask(child1);
    await store.saveTask(child2);
    await store.saveTaskTree(makeTree("tsk_root", ["tsk_c1", "tsk_c2"]));

    await abortEntireTree({ rootTaskId: "tsk_root", store });

    for (const id of ["tsk_root", "tsk_c1", "tsk_c2"]) {
      const fetched = await store.getTask(id);
      if (fetched.isOk) expect(fetched.value.status).toBe("aborted");
    }
  });

  it("aborts queued children too — they must not be promoted after cascade abort", async () => {
    const store = createInMemoryStore();
    const root = makeTask("tsk_root");
    const active1 = makeTask("tsk_a1", "tsk_root", "tsk_root");
    const active2 = makeTask("tsk_a2", "tsk_root", "tsk_root");
    const queued = makeTask("tsk_q1", "tsk_root", "tsk_root");

    await store.saveTask(root);
    await store.saveTask(active1);
    await store.saveTask(active2);
    await store.saveTask(queued);
    await store.saveTaskTree(makeTree("tsk_root", ["tsk_a1", "tsk_a2"], ["tsk_q1"]));

    await abortEntireTree({ rootTaskId: "tsk_root", store });

    const fetchedQueued = await store.getTask("tsk_q1");
    if (fetchedQueued.isOk) expect(fetchedQueued.value.status).toBe("aborted");
  });

  it("clears the tree's activeChildren and queuedChildren after abort", async () => {
    const store = createInMemoryStore();
    const root = makeTask("tsk_root");
    const child = makeTask("tsk_c1", "tsk_root", "tsk_root");

    await store.saveTask(root);
    await store.saveTask(child);
    await store.saveTaskTree(makeTree("tsk_root", ["tsk_c1"]));

    await abortEntireTree({ rootTaskId: "tsk_root", store });

    const tree = await store.getTaskTree("tsk_root");
    if (tree.isOk) {
      expect(tree.value.activeChildren).toHaveLength(0);
      expect(tree.value.queuedChildren).toHaveLength(0);
    }
  });

  it("returns Ok when tree and all tasks exist", async () => {
    const store = createInMemoryStore();
    await store.saveTask(makeTask("tsk_root"));
    await store.saveTaskTree(makeTree("tsk_root"));

    const result = await abortEntireTree({ rootTaskId: "tsk_root", store });
    expect(result.isOk).toBe(true);
  });

  it("returns Err when task tree does not exist", async () => {
    const store = createInMemoryStore();
    const result = await abortEntireTree({ rootTaskId: "tsk_ghost", store });
    expect(result.isErr).toBe(true);
  });

  it("no further executions are legal after abort of root (prohibition 11)", async () => {
    const store = createInMemoryStore();
    const root = makeTask("tsk_root");
    await store.saveTask(root);
    await store.saveTaskTree(makeTree("tsk_root"));

    await abortEntireTree({ rootTaskId: "tsk_root", store });

    const fetched = await store.getTask("tsk_root");
    if (fetched.isOk) {
      const legality = checkLegality({
        action: {
          name: "any",
          description: "any",
          schema: { safeParse: () => ({ success: true, data: {} }) } as any,
          fn: async () => { throw new Error("must not run"); },
        },
        state: {
          taskId: "tsk_root",
          rootId: "tsk_root",
          agentName: "test-agent",
          status: fetched.value.status,
          completedActions: [],
          completedWorkflows: [],
          budget: fetched.value.budget,
          spent: { tokens: 0, durationMs: 0 },
          risk: fetched.value.risk,
          trust: fetched.value.trust,
        },
      });
      expect(legality.legal).toBe(false);
    }
  });
});
