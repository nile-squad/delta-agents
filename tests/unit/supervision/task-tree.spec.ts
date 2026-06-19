/**
 * Task tree slot management tests.
 *
 * The tree is bounded at exactly 2 active subtasks. Overflow queues in FIFO
 * order and drains in the same order as slots become available.
 *
 * All functions are pure: no I/O, deterministic on their inputs.
 *
 * Covers: invariants 15, 16; prohibitions 6, 15.
 */

import { describe, it, expect } from "vitest";
import { requestSlot, releaseSlot } from "../../../src/supervision";
import type { TaskTree } from "../../../src/shared/types";

const emptyTree = (): TaskTree => ({
  rootTaskId: "tsk_root",
  activeChildren: [],
  queuedChildren: [],
  maxConcurrency: 2,
});

// ── requestSlot — slot allocation ─────────────────────────────────────────────

describe("requestSlot — slot allocation (invariants 15, 16)", () => {
  it("grants the first slot immediately", () => {
    const result = requestSlot(emptyTree(), "sub-1");
    expect("granted" in result && result.granted).toBe(true);
    expect(result.tree.activeChildren).toContain("sub-1");
  });

  it("grants the second slot immediately", () => {
    const { tree: t1 } = requestSlot(emptyTree(), "sub-1") as { granted: true; tree: TaskTree };
    const result = requestSlot(t1, "sub-2");
    expect("granted" in result && result.granted).toBe(true);
    expect(result.tree.activeChildren).toContain("sub-2");
    expect(result.tree.activeChildren.length).toBe(2);
  });

  it("queues the third subtask — does not grant a third slot (invariant 15, prohibition 6)", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "sub-1") as { granted: true; tree: TaskTree });
    ({ tree } = requestSlot(tree, "sub-2") as { granted: true; tree: TaskTree });

    const result = requestSlot(tree, "sub-3");
    expect("queued" in result && result.queued).toBe(true);
    expect(result.tree.activeChildren.length).toBe(2); // still 2, not 3
    expect(result.tree.queuedChildren).toContain("sub-3");
  });

  it("activeChildren never exceeds maxConcurrency (2) regardless of request count", () => {
    let tree = emptyTree();
    for (let i = 0; i < 10; i++) {
      const result = requestSlot(tree, `sub-${i}`);
      tree = result.tree;
      expect(tree.activeChildren.length).toBeLessThanOrEqual(tree.maxConcurrency);
    }
  });

  it("preserves FIFO order in queuedChildren", () => {
    let tree = emptyTree();
    // Fill active slots
    ({ tree } = requestSlot(tree, "a1") as { granted: true; tree: TaskTree });
    ({ tree } = requestSlot(tree, "a2") as { granted: true; tree: TaskTree });

    // Queue 3 more
    tree = requestSlot(tree, "q1").tree;
    tree = requestSlot(tree, "q2").tree;
    tree = requestSlot(tree, "q3").tree;

    expect(tree.queuedChildren).toEqual(["q1", "q2", "q3"]);
  });

  it("does not mutate the original tree", () => {
    const original = emptyTree();
    requestSlot(original, "sub-1");
    expect(original.activeChildren).toHaveLength(0);
  });
});

// ── releaseSlot — slot release and promotion ──────────────────────────────────

describe("releaseSlot — slot release and FIFO promotion", () => {
  it("removes the released subtask from activeChildren", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "sub-1") as { granted: true; tree: TaskTree });
    const result = releaseSlot(tree, "sub-1");
    expect(result.tree.activeChildren).not.toContain("sub-1");
  });

  it("promotes the head of the queue to active (FIFO, invariant 16)", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "a1") as { granted: true; tree: TaskTree });
    ({ tree } = requestSlot(tree, "a2") as { granted: true; tree: TaskTree });
    tree = requestSlot(tree, "q1").tree;
    tree = requestSlot(tree, "q2").tree;

    const result = releaseSlot(tree, "a1");
    expect(result.promoted).toBe("q1");
    expect(result.tree.activeChildren).toContain("q1");
    expect(result.tree.queuedChildren).not.toContain("q1");
    expect(result.tree.queuedChildren).toContain("q2"); // still waiting
  });

  it("promoted ID is removed from queuedChildren", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "a1") as { granted: true; tree: TaskTree });
    tree = requestSlot(tree, "q1").tree;

    const result = releaseSlot(tree, "a1");
    expect(result.tree.queuedChildren).not.toContain("q1");
  });

  it("returns promoted: undefined when the queue is empty", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "sub-1") as { granted: true; tree: TaskTree });

    const result = releaseSlot(tree, "sub-1");
    expect(result.promoted).toBeUndefined();
    expect(result.tree.activeChildren).toHaveLength(0);
  });

  it("releasing a non-existent ID is a no-op (idempotent)", () => {
    const tree = emptyTree();
    const result = releaseSlot(tree, "ghost");
    expect(result.tree.activeChildren).toHaveLength(0);
    expect(result.promoted).toBeUndefined();
  });

  it("FIFO order: multiple releases drain queue in arrival order", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "a1") as { granted: true; tree: TaskTree });
    ({ tree } = requestSlot(tree, "a2") as { granted: true; tree: TaskTree });
    tree = requestSlot(tree, "q1").tree;
    tree = requestSlot(tree, "q2").tree;
    tree = requestSlot(tree, "q3").tree;

    const r1 = releaseSlot(tree, "a1");
    expect(r1.promoted).toBe("q1");
    tree = r1.tree;

    const r2 = releaseSlot(tree, "a2");
    expect(r2.promoted).toBe("q2");
    tree = r2.tree;

    // Now a1-slot has q1, a2-slot has q2; release q1's slot
    const r3 = releaseSlot(tree, "q1");
    expect(r3.promoted).toBe("q3");
  });

  it("does not mutate the original tree", () => {
    let tree = emptyTree();
    ({ tree } = requestSlot(tree, "sub-1") as { granted: true; tree: TaskTree });
    const snapshot = { ...tree, activeChildren: [...tree.activeChildren] };
    releaseSlot(tree, "sub-1");
    expect(tree.activeChildren).toEqual(snapshot.activeChildren);
  });
});
