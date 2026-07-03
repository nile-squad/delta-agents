/**
 * Task tree stress tests — bounds hold under load.
 *
 * Phase 6 exit criterion: no matter how many subtask requests arrive or how
 * many interleaved request/release cycles occur, activeChildren.length is
 * NEVER > 2, FIFO order is preserved in the queue, and no slot is
 * over-allocated.
 *
 * Since requestSlot and releaseSlot are pure synchronous functions there is
 * no true concurrency in this process. The "thundering herd" is simulated by
 * making many calls in tight sequence — the worst-case for a real concurrent
 * caller that holds a shared tree reference.
 *
 * Covers: invariants 15, 16; prohibitions 6, 15 (bounded delegation).
 */

import { describe, it, expect } from "vitest";
import { requestSlot, releaseSlot } from "../../src/supervision";
import type { TaskTree } from "../../src/shared/types";

const freshTree = (): TaskTree => ({
  rootTaskId: "tsk_stress_root",
  activeChildren: [],
  queuedChildren: [],
  maxConcurrency: 2,
});

// ── Thundering herd ───────────────────────────────────────────────────────────

describe("thundering herd — many simultaneous slot requests", () => {
  it("100 slot requests: activeChildren never exceeds 2 (invariant 15, prohibition 6)", () => {
    let tree = freshTree();
    for (let i = 0; i < 100; i++) {
      const result = requestSlot(tree, `sub-${i}`);
      tree = result.tree;
      expect(tree.activeChildren.length).toBeLessThanOrEqual(2);
      expect(tree.activeChildren.length).toBeLessThanOrEqual(tree.maxConcurrency);
    }
    // After 100 requests: exactly 2 active, 98 queued
    expect(tree.activeChildren.length).toBe(2);
    expect(tree.queuedChildren.length).toBe(98);
  });

  it("1000 slot requests: bound still holds (prohibition 15: no unbounded delegation)", () => {
    let tree = freshTree();
    for (let i = 0; i < 1000; i++) {
      tree = requestSlot(tree, `sub-${i}`).tree;
      expect(tree.activeChildren.length).toBeLessThanOrEqual(2);
    }
  });

  it("active + queued accounts for every requested subtask", () => {
    let tree = freshTree();
    const N = 50;
    for (let i = 0; i < N; i++) {
      tree = requestSlot(tree, `sub-${i}`).tree;
    }
    expect(tree.activeChildren.length + tree.queuedChildren.length).toBe(N);
  });
});

// ── Queue saturation ──────────────────────────────────────────────────────────

describe("queue saturation — overflow queues without limit", () => {
  it("all overflow subtasks land in the queue, none are lost", () => {
    let tree = freshTree();
    // Fill active slots first
    tree = requestSlot(tree, "a1").tree;
    tree = requestSlot(tree, "a2").tree;

    // Queue 100 more
    for (let i = 0; i < 100; i++) {
      tree = requestSlot(tree, `q${i}`).tree;
    }

    expect(tree.queuedChildren.length).toBe(100);
    // First queued is still q0 (head of FIFO)
    expect(tree.queuedChildren[0]).toBe("q0");
    expect(tree.queuedChildren[99]).toBe("q99");
  });

  it("FIFO order is preserved: q0 was first in, q0 is first promoted", () => {
    let tree = freshTree();
    tree = requestSlot(tree, "a1").tree;
    tree = requestSlot(tree, "a2").tree;

    for (let i = 0; i < 20; i++) {
      tree = requestSlot(tree, `q${i}`).tree;
    }

    for (let i = 0; i < 20; i++) {
      // Release one active slot — q{i} should be promoted in order
      const active = tree.activeChildren[0]!;
      const release = releaseSlot(tree, active);
      expect(release.promoted).toBe(`q${i}`);
      tree = release.tree;
      // Re-fill the slot by releasing and promoting naturally
    }
  });
});

// ── Concurrent slot contention ────────────────────────────────────────────────

describe("concurrent slot contention — interleaved request/release cycles", () => {
  it("rapid interleaved request/release: active count never exceeds 2", () => {
    let tree = freshTree();
    let nextId = 0;

    for (let cycle = 0; cycle < 200; cycle++) {
      // Request a new subtask
      tree = requestSlot(tree, `task-${nextId++}`).tree;
      expect(tree.activeChildren.length).toBeLessThanOrEqual(2);

      // Every 3rd cycle, release an active slot if one exists
      if (cycle % 3 === 2 && tree.activeChildren.length > 0) {
        const first = tree.activeChildren[0]!;
        const rel = releaseSlot(tree, first);
        tree = rel.tree;
      }

      expect(tree.activeChildren.length).toBeLessThanOrEqual(2);
    }
  });

  it("alternating request and release: queue drains in FIFO order under pressure", () => {
    let tree = freshTree();

    // Fill 2 active + 10 queued
    tree = requestSlot(tree, "a1").tree;
    tree = requestSlot(tree, "a2").tree;
    const queued: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `queued-${i}`;
      queued.push(id);
      tree = requestSlot(tree, id).tree;
    }

    // Release all active slots and verify FIFO drain
    const promotionOrder: string[] = [];
    while (tree.activeChildren.length > 0 || tree.queuedChildren.length > 0) {
      if (tree.activeChildren.length === 0) break;
      const toRelease = tree.activeChildren[0]!;
      const rel = releaseSlot(tree, toRelease);
      tree = rel.tree;
      if (rel.promoted !== undefined) promotionOrder.push(rel.promoted);
      expect(tree.activeChildren.length).toBeLessThanOrEqual(2);
    }

    // The promotions should match the queued order
    for (let i = 0; i < Math.min(promotionOrder.length, queued.length); i++) {
      expect(promotionOrder[i]).toBe(queued[i]);
    }
  });

  it("no slot is double-allocated: each ID appears in activeChildren at most once", () => {
    let tree = freshTree();

    for (let i = 0; i < 30; i++) {
      tree = requestSlot(tree, `sub-${i}`).tree;
      const ids = tree.activeChildren;
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length); // no duplicates
    }
  });

  it("releasing the same ID twice is idempotent — no phantom slots", () => {
    let tree = freshTree();
    tree = requestSlot(tree, "sub-1").tree;
    tree = requestSlot(tree, "sub-2").tree;
    tree = requestSlot(tree, "sub-3").tree; // queued

    // Release sub-1 — promotes sub-3
    tree = releaseSlot(tree, "sub-1").tree;
    // Release sub-1 again — no-op
    tree = releaseSlot(tree, "sub-1").tree;

    // Active count must still be 2, not 3
    expect(tree.activeChildren.length).toBeLessThanOrEqual(2);
  });
});
