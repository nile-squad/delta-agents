/**
 * Cleanup — opportunistic + manual retention pass for delta-agents.
 *
 * The engine never destroys state on its own. Cleanup is opt-in at two
 * granularities:
 *
 *  - **Opportunistic** — `opportunisticCleanup(cache)`. Cheap and synchronous.
 *    Sweeps the in-process read-through cache for expired entries. Safe to call
 *    on every engine operation (`send`, `inspect`) because it does no I/O.
 *
 *  - **Manual** — `runCleanup({ store, cache, options, logger })`. The heavier
 *    retention pass. Three independent kinds of work, each gated on a presence
 *    check so adapters without the corresponding capability degrade gracefully:
 *
 *      1. Cache eviction  — non-destructive, always attempted unless
 *         `options.evictCache === false`.
 *      2. Task pruning    — requires `options.taskRetentionMs` AND the store
 *         implementing `getTasksOlderThan` + `deleteTask`. Removes completed/
 *         failed tasks whose `updatedAt` is older than the retention window,
 *         then drops their cache entries.
 *      3. Message pruning — requires `options.messageRetentionMs` AND the store
 *         implementing `getTaskIds` + `deleteMessages`. Removes consumed
 *         messages older than the retention window.
 *
 *  The two destructive passes are scoped by their presence. If an adapter does
 *  not support `getTasksOlderThan` or `getTaskIds`, the corresponding prune is
 *  skipped with a logged warning rather than throwing — cleanup is best-effort,
 *  never a hard failure of the engine.
 */

import { Ok, Err, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import type { StoragePort } from "../ports/storage-port";
import type { Cache } from "../shared/cache";
import type { Logger } from "../shared/logger-types";

/** Statuses considered "terminal" — pruning targets only these so we never
 *  remove a running or pending task by accident. */
const PRUNABLE_STATUSES = ["completed", "failed", "aborted"] as const;

/**
 * Options for the manual cleanup method.
 *
 * Every destructive operation is opt-in — omit a field to skip that cleanup.
 * Cache eviction is always performed unless `evictCache === false` (cheap,
 * non-destructive to the store).
 */
export type CleanupOptions = {
  /** Remove completed/failed tasks older than this age (ms). Omit = skip task pruning. */
  taskRetentionMs?: number;
  /** Remove consumed messages older than this age (ms). Omit = skip message pruning. */
  messageRetentionMs?: number;
  /** Evict expired cache entries. Default true. Set false to skip cache eviction. */
  evictCache?: boolean;
};

/**
 * Opportunistic cleanup — cheap, non-destructive, safe to call on every engine
 * operation. Sweeps the read-through cache for expired entries. No store I/O.
 *
 * @returns the number of cache entries evicted.
 */
export const opportunisticCleanup = (cache: Cache<string, unknown>): number => {
  return cache.evictExpired();
};

/**
 * Manual cleanup — heavier, potentially destructive.
 *
 * Performs three independent passes gated on options and adapter capabilities:
 * cache eviction, task pruning, and message pruning. The destructive passes are
 * skipped with a logged warning if the adapter does not implement the
 * corresponding `getTasksOlderThan` / `getTaskIds` method — cleanup is
 * best-effort and never throws on a missing capability.
 *
 * @returns `Ok(undefined)` on success (any individual pass may have been
 *   skipped, see the logger for details). `Err(message)` only if a fatal
 *   unexpected error escapes the safeTry wrapper.
 */
export const runCleanup = async (params: {
  store: StoragePort;
  cache: Cache<string, unknown>;
  options?: CleanupOptions;
  logger?: Logger;
}): Promise<Result<void, string>> => {
  const { store, cache, options = {}, logger } = params;
  const log = logger?.child("cleanup");
  const atFunction = "runCleanup";

  // safeTry catches anything that escapes the Result-based store layer (e.g. a
  // malformed timestamp, a logger misconfiguration). The body itself uses
  // early-return + `throw` for fatal cleanup failures so safeTry can convert
  // them to a uniform Err.
  const sweep = await safeTry(async () => {
    // ── 1. Cache eviction ──────────────────────────────────────────────────
    // Always performed unless explicitly disabled. Non-destructive.
    if (options.evictCache !== false) {
      const evicted = cache.evictExpired();
      log?.debug(`opportunistic cache eviction: ${evicted} entries removed`);
    }

    // ── 2. Task pruning ────────────────────────────────────────────────────
    // Destructive. Requires both `getTasksOlderThan` and `deleteTask` to be
    // implemented by the adapter; either being absent skips this pass with a
    // logged warning rather than throwing.
    if (options.taskRetentionMs !== undefined) {
      if (store.getTasksOlderThan === undefined || store.deleteTask === undefined) {
        log?.warn(
          "task pruning skipped: store adapter does not implement " +
            `getTasksOlderThan/deleteTask (hasGetTasksOlderThan=${store.getTasksOlderThan !== undefined}, ` +
            `hasDeleteTask=${store.deleteTask !== undefined})`,
        );
      } else {
        const olderThan = new Date(Date.now() - options.taskRetentionMs);
        const scan = await store.getTasksOlderThan([...PRUNABLE_STATUSES], olderThan);
        if (scan.isErr) {
          throw new Error(`cannot scan tasks for pruning: ${scan.error}`);
        }
        const targets = scan.value;
        let removed = 0;
        for (const task of targets) {
          // Capture agentName BEFORE deletion so we can invalidate the agent's
          // memory cache slice (memories:{agentName}:*).
          const agentName = task.assignedAgent;
          const result = await store.deleteTask(task.id);
          if (result.isErr) {
            // A single task failure must not stop the rest of the sweep —
            // log and continue.
            log?.warn(`task pruning: failed to delete task "${task.id}": ${result.error}`);
            continue;
          }
          removed += 1;
          // Drop cached reads for the removed task so the next read re-fetches
          // (and surfaces a clean "not found" rather than a stale value).
          cache.delete(`task:${task.id}`);
          cache.delete(`checkpoint:${task.id}`);
          // Invalidate every cached memory slice for the agent — the cascade
          // delete in `deleteTask` removes their memories too, so any cached
          // top-N is now wrong.
          const memoryPrefix = `memories:${agentName}:`;
          const memoryVictims: string[] = [];
          for (const k of cache.keys()) {
            if (k.startsWith(memoryPrefix)) memoryVictims.push(k);
          }
          for (const k of memoryVictims) cache.delete(k);
        }
        log?.info(
          `task pruning: ${removed} task(s) removed (threshold ${olderThan.toISOString()})`,
        );
      }
    }

    // ── 3. Message pruning ─────────────────────────────────────────────────
    // Destructive but bounded: unconsumed messages are always preserved; only
    // consumed messages older than the retention window are removed.
    if (options.messageRetentionMs !== undefined) {
      if (store.getTaskIds === undefined || store.deleteMessages === undefined) {
        log?.warn(
          "message pruning skipped: store adapter does not implement " +
            `getTaskIds/deleteMessages (hasGetTaskIds=${store.getTaskIds !== undefined}, ` +
            `hasDeleteMessages=${store.deleteMessages !== undefined})`,
        );
      } else {
        const idsResult = await store.getTaskIds();
        if (idsResult.isErr) {
          throw new Error(`cannot list task IDs for message pruning: ${idsResult.error}`);
        }
        const olderThan = new Date(Date.now() - options.messageRetentionMs);
        let totalRemoved = 0;
        for (const taskId of idsResult.value) {
          const result = await store.deleteMessages(taskId, olderThan);
          if (result.isErr) {
            log?.warn(`message pruning: failed for task "${taskId}": ${result.error}`);
            continue;
          }
          totalRemoved += result.value;
        }
        log?.info(
          `message pruning: ${totalRemoved} message(s) removed across ` +
            `${idsResult.value.length} task(s) (threshold ${olderThan.toISOString()})`,
        );
      }
    }
  });

  return sweep.isErr
    ? Err(`${atFunction}: ${sweep.error}`)
    : Ok(undefined);
};
