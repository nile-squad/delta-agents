/**
 * Resume-tree integration tests (H2).
 *
 * WHY: when a task is paused while it had active delegated child tasks, the
 * scheduler previously dropped those children on resume — the tree silently
 * lost work. This test suite proves that on resume the scheduler rehydrates
 * the persisted TaskTree's activeChildren and drives them to completion.
 *
 * Test strategy: deterministic direct-state construction (no timing-dependent
 * "pause mid-child" setup — those flake). We persist the root task as paused,
 * the child task as running/paused (non-terminal), and the TaskTree with the
 * child in activeChildren. Then we call delta.resume() and assert the child is
 * picked up and the overall result reflects its completion.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import { initialRiskState, initialTrust } from "../../src/governance";
import type { Task, TaskTree } from "../../src/shared/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date();

const makeTask = (overrides: Partial<Task> & Pick<Task, "id" | "goal" | "assignedAgent">): Task => ({
  rootId: overrides.id,
  status: "running",
  budget: { tokens: 100_000, durationMs: 300_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

// ── H2: Rehydration tests ─────────────────────────────────────────────────────

describe("resume-tree — H2: active children rehydrated on resume", () => {
  it("child task in activeChildren is driven to completion after root is resumed", async () => {
    const store = createInMemoryStore();
    const childRan: string[] = [];

    // ── Directly construct the paused state ──────────────────────────────────
    // Root task: paused (was running, then paused mid-delegation).
    const rootTaskId = "tsk_h2_root";
    const childTaskId = "tsk_h2_child";

    const rootTask: Task = makeTask({
      id: rootTaskId,
      rootId: rootTaskId,
      status: "paused",
      goal: "delegate to child and wait",
      assignedAgent: "root-agent",
    });
    await store.saveTask(rootTask);

    // Child task: paused (was active, paused when parent was paused).
    // Non-terminal status so the rehydration guard picks it up.
    const childTask: Task = makeTask({
      id: childTaskId,
      rootId: rootTaskId,
      parentId: rootTaskId,
      status: "paused",
      goal: "do child work",
      assignedAgent: "child-agent",
      budget: { tokens: 50_000, durationMs: 150_000 },
    });
    await store.saveTask(childTask);

    // TaskTree: root has the child in activeChildren.
    const tree: TaskTree = {
      rootTaskId,
      activeChildren: [childTaskId],
      queuedChildren: [],
      maxConcurrency: 2,
    };
    await store.saveTaskTree(tree);

    // ── Resume the root ───────────────────────────────────────────────────────
    // Build a routing reasoner: when the root agent (root-noop available) is
    // asked, signal done immediately. When the child agent (child-work available)
    // is asked, return the child action. This lets one reasoner serve both roles
    // without consuming the child response on the root's step.
    let childActionServed = false;
    const routingReasoner = {
      reason: async ({ availableActions }: { availableActions: string[] }) => {
        if (availableActions.includes("child-work") && !childActionServed) {
          childActionServed = true;
          return Ok({ kind: "act" as const, request: { actionName: "child-work", input: {} } });
        }
        return Ok({ kind: "done" as const });
      },
    };

    const delta2 = await createDeltaEngine({ store, reasoner: routingReasoner });

    // Re-register both agents in delta2's registry so resume can look them up.
    const rootNoop2 = delta2.action({
      name: "root-noop",
      description: "root noop",
      schema: z.object({}),
      fn: async () => Ok("noop"),
    });
    const rootAgent2 = delta2.agent({
      name: "root-agent",
      description: "root agent",
      role: "Root",
      rolePrompt: "Delegate work.",
      actions: [rootNoop2],
    });
    delta2.deploy(rootAgent2);
    const childWork2 = delta2.action({
      name: "child-work",
      description: "child work action",
      schema: z.object({}),
      fn: async () => {
        childRan.push("child-work");
        return Ok("done");
      },
    });
    const childAgent2 = delta2.agent({
      name: "child-agent",
      description: "child agent",
      role: "Child",
      rolePrompt: "Do child work.",
      actions: [childWork2],
    });
    delta2.deploy(childAgent2);

    const result = await delta2.resume(rootTaskId);

    // The resume should succeed.
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // The child work was executed (rehydration picked up the child runner).
    expect(childRan.length).toBeGreaterThan(0);
    expect(childRan).toContain("child-work");

    // The root result reflects the outcome (completed or aggregated from child).
    // The root agent signals done immediately (no actions), so the D1 aggregation
    // combines the root's completed + child's completed = overall completed.
    expect(result.value.status).toBe("completed");
  });

  it("child in terminal status (completed) is NOT re-run on resume", async () => {
    const store = createInMemoryStore();
    const childRan: string[] = [];

    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });

    const rootNoop = delta.action({
      name: "root-noop2",
      description: "root noop",
      schema: z.object({}),
      fn: async () => Ok("noop"),
    });
    const rootAgent = delta.agent({
      name: "root-agent2",
      description: "root",
      role: "Root",
      rolePrompt: "Root.",
      actions: [rootNoop],
    });
    delta.deploy(rootAgent);

    const childWork = delta.action({
      name: "child-work2",
      description: "child work",
      schema: z.object({}),
      fn: async () => {
        childRan.push("ran");
        return Ok("done");
      },
    });
    const childAgent = delta.agent({
      name: "child-agent2",
      description: "child",
      role: "Child",
      rolePrompt: "Child.",
      actions: [childWork],
    });
    delta.deploy(childAgent);

    const rootTaskId = "tsk_h2b_root";
    const childTaskId = "tsk_h2b_child";

    // Root: paused.
    await store.saveTask(
      makeTask({ id: rootTaskId, rootId: rootTaskId, status: "paused", goal: "test", assignedAgent: "root-agent2" }),
    );

    // Child: already completed — should be skipped.
    await store.saveTask(
      makeTask({
        id: childTaskId,
        rootId: rootTaskId,
        parentId: rootTaskId,
        status: "completed",
        goal: "already done",
        assignedAgent: "child-agent2",
      }),
    );

    // TaskTree with the completed child in activeChildren.
    await store.saveTaskTree({
      rootTaskId,
      activeChildren: [childTaskId],
      queuedChildren: [],
      maxConcurrency: 2,
    });

    const result = await delta.resume(rootTaskId);
    expect(result.isOk).toBe(true);

    // The child work was NOT re-run (it was already terminal).
    expect(childRan).toHaveLength(0);
  });
});
