/**
 * Task tree slot management — pure functions.
 *
 * The task tree is bounded:
 *   - maxConcurrency active subtasks (literal 2, not configurable)
 *   - unlimited queued subtasks (FIFO overflow)
 *
 * Every slot decision is derived from the current tree state alone. No I/O,
 * no side effects. The caller persists the updated tree to the store.
 *
 * Invariants enforced here:
 *   15 — supervisor owns at most two active subtasks
 *   16 — additional work queues until a slot is free
 * Prohibitions enforced:
 *    6 — supervisor never owns more than two active subtasks
 *   15 — system never allows unbounded delegation
 */

import type { TaskTree } from "../shared/types";
import type { SlotResult, ReleaseResult } from "./types";

/**
 * Request an active slot for a new subtask.
 *
 * If activeChildren.length < maxConcurrency → granted immediately.
 * Otherwise → enqueued at the tail of queuedChildren (FIFO).
 *
 * The active count is NEVER incremented beyond maxConcurrency (invariant 15).
 */
export const requestSlot = (tree: TaskTree, subtaskId: string): SlotResult => {
  if (tree.activeChildren.length < tree.maxConcurrency) {
    return {
      granted: true,
      tree: { ...tree, activeChildren: [...tree.activeChildren, subtaskId] },
    };
  }
  return {
    queued: true,
    tree: { ...tree, queuedChildren: [...tree.queuedChildren, subtaskId] },
  };
};

/**
 * Release a subtask's active slot when it finishes (success, failure, or abort).
 *
 * If queuedChildren is non-empty, the head of the queue (FIFO) is promoted
 * to an active slot. Returns the promoted task ID so the engine can start it.
 *
 * Removing an ID that is not in activeChildren is a no-op (idempotent).
 */
export const releaseSlot = (tree: TaskTree, subtaskId: string): ReleaseResult => {
  const newActive = tree.activeChildren.filter((id) => id !== subtaskId);

  if (tree.queuedChildren.length === 0) {
    return { tree: { ...tree, activeChildren: newActive }, promoted: undefined };
  }

  // Promote the first-in-queue (FIFO). Safe: we checked length > 0 above.
  const promoted: string = tree.queuedChildren[0]!;
  const remaining = tree.queuedChildren.slice(1);

  return {
    promoted,
    tree: {
      ...tree,
      activeChildren: [...newActive, promoted],
      queuedChildren: remaining,
    },
  };
};
