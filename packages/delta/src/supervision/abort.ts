/**
 * Cascading abort — store-level operations.
 *
 * abortTask marks a single task as "aborted" in the store.
 *
 * abortEntireTree marks the root task AND every task in its activeChildren
 * and queuedChildren as "aborted", then empties the tree (invariant 17:
 * aborting a parent task aborts all descendant tasks). The tree is cleared
 * so that slot management reflects the aborted state and no queued tasks
 * are later promoted to active.
 *
 * Prohibition 11: the system never continues execution after a terminal abort.
 * After either function succeeds, any call to checkLegality will return
 * { legal: false } because the task status is "aborted" (not "running").
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import type { StoragePort } from "../ports/storage-port";

/** Set a single task's status to "aborted". */
export const abortTask = async ({
  taskId,
  store,
}: {
  taskId: string;
  store: StoragePort;
}): Promise<Result<void, string>> => {
  const result = await store.updateTask(taskId, {
    status: "aborted",
    updatedAt: new Date(),
  });
  if (result.isErr) {
    return Err(`failed to abort task "${taskId}": ${result.error}`);
  }
  return Ok(undefined);
};

/**
 * Abort the root task and every task it owns (active + queued subtasks).
 *
 * Steps:
 *   1. Abort the root task.
 *   2. Abort every task in activeChildren and queuedChildren.
 *   3. Clear the tree so the engine never promotes a queued task again.
 *
 * Returns Err if the tree cannot be retrieved, or if any individual abort
 * fails. In either case the abort sequence halts at the first failure —
 * tasks whose status could not be updated remain in their prior state.
 */
export const abortEntireTree = async ({
  rootTaskId,
  store,
}: {
  rootTaskId: string;
  store: StoragePort;
}): Promise<Result<void, string>> => {
  const treeResult = await store.getTaskTree(rootTaskId);
  if (treeResult.isErr) {
    return Err(`cannot abort tree — task tree "${rootTaskId}" not found: ${treeResult.error}`);
  }

  const tree = treeResult.value;
  const allIds = [rootTaskId, ...tree.activeChildren, ...tree.queuedChildren];

  for (const id of allIds) {
    const result = await abortTask({ taskId: id, store });
    if (result.isErr) return result;
  }

  // Clear the tree: no queued tasks should be promoted after an abort cascade.
  await store.updateTaskTree(rootTaskId, {
    activeChildren: [],
    queuedChildren: [],
  });

  return Ok(undefined);
};
