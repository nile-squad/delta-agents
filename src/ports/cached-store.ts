/**
 * createCachedStore — read-through StoragePort wrapper.
 *
 * Caches the hot-path reads (`getTask`, `getLatestCheckpoint`,
 * `getMemoriesByAgent`) in memory and invalidates or updates the cache on
 * writes (`saveTask`, `updateTask`, `saveCheckpoint`, `saveMemory`). Everything
 * else passes through to the inner store unchanged.
 *
 * Why a wrapper and not a rewrite of the engine:
 *  - The engine calls `StoragePort` exclusively, so wrapping gives transparent
 *    read acceleration with no engine-side changes.
 *  - Eviction is memory-only. The inner store retains the data; a cache miss
 *    re-fetches fresh. This keeps correctness: the cache is an optimization,
 *    never the source of truth.
 *  - Writes invalidate, not update (except `saveTask` which has a known
 *    complete record). Invalidation is safer than partial-update — the next
 *    read re-fetches the authoritative state.
 *
 * Result caching:
 *  - The cache stores `Result<T, string>` values, not raw `T`s. This means a
 *    hit returns the exact same `Result` that the inner store would have
 *    returned — including `Err` for "not found" (negative caching). The inner
 *    store's contract is that errors are stable facts (id absent, etc.), so
 *    caching them is safe and avoids repeated lookups.
 */

import type { Result } from "slang-ts";
import type { StoragePort } from "./storage-port";
import type { Task, Checkpoint, Memory, Commit } from "../shared/types";
import { createCache } from "../shared/cache";
import type { CacheConfig, Cache } from "../shared/cache";

/**
 * Cache key prefixes. Centralized so the wrapper and any future tooling share
 * a single source of truth — changing a key shape is a one-line change.
 */
const KEY = {
  task: (id: string): string => `task:${id}`,
  checkpoint: (taskId: string): string => `checkpoint:${taskId}`,
  memories: (agentName: string, limit: number | "all"): string =>
    `memories:${agentName}:${limit === "all" ? "all" : String(limit)}`,
  memoryPrefix: (agentName: string): string => `memories:${agentName}:`,
} as const;

/**
 * Wrapped store + cache handle. The cache is exposed so the engine's
 * opportunistic cleanup (Phase 4) can call `evictExpired()` without poking
 * at the wrapper's internals.
 */
export type CachedStoreHandle = {
  store: StoragePort;
  cache: Cache<string, unknown>;
};

/**
 * Create a read-through cache wrapper over a StoragePort.
 *
 * @param inner - The underlying store. Required.
 * @param config - Optional cache tuning (`maxEntries`, `ttlMs`). Defaults:
 *   1000 entries, 5-minute sliding window. Omit to accept defaults.
 *
 * @returns A handle containing the wrapped `StoragePort` (use this in the
 *   engine) and the underlying `Cache` (use this for opportunistic eviction
 *   in `send`/`inspect` and for manual cleanup).
 */
export const createCachedStore = (inner: StoragePort, config?: CacheConfig): CachedStoreHandle => {
  const cache = createCache<string, unknown>(config);

  // Delegate to the inner store for a read; cache the Result. Negative caching
  // (storing "not found" Err) is intentional — the inner store treats absence
  // as a stable fact, and re-querying is wasted work.
  const cachedRead = async <V>(
    key: string,
    read: () => Promise<Result<V, string>>,
  ): Promise<Result<V, string>> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit as Result<V, string>;
    const fresh = await read();
    cache.set(key, fresh as unknown);
    return fresh;
  };

  /**
   * Invalidate every cache entry whose key starts with `prefix`. Uses the
   * public `keys()` iterator; collect-then-delete avoids mutating the cache
   * during iteration.
   */
  const invalidatePrefix = (prefix: string): void => {
    const victims: string[] = [];
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) victims.push(k);
    }
    for (const k of victims) cache.delete(k);
  };

  return {
    store: {
      // Delegate ready to inner. The wrapper does not add async setup.
      ...(inner.ready !== undefined ? { ready: inner.ready } : {}),

      // ── Tasks: cache read, write-through update, invalidate on patch ──
      saveTask: async (task: Task) => {
        const result = await inner.saveTask(task);
        // Update cache only on Ok — a save failure must not poison subsequent reads.
        if (result.isOk) cache.set(KEY.task(task.id), result as unknown);
        return result;
      },
      getTask: (id) => cachedRead(KEY.task(id), () => inner.getTask(id)),
      updateTask: async (id, patch) => {
        const result = await inner.updateTask(id, patch);
        // Invalidate rather than merge — the inner store is the source of truth.
        cache.delete(KEY.task(id));
        return result;
      },
      getLatestTaskByAgent: inner.getLatestTaskByAgent,
      ...(inner.getActiveTasksByAgent !== undefined ? { getActiveTasksByAgent: inner.getActiveTasksByAgent } : {}),

      // ── Task trees: pass-through (not on the hot path) ──
      saveTaskTree: inner.saveTaskTree,
      getTaskTree: inner.getTaskTree,
      updateTaskTree: inner.updateTaskTree,

      // ── Executions: pass-through ──
      saveExecution: inner.saveExecution,
      getExecution: inner.getExecution,
      updateExecution: inner.updateExecution,
      getExecutionsByTask: inner.getExecutionsByTask,

      // ── Checkpoints: cache latest, invalidate on save ──
      saveCheckpoint: async (checkpoint: Checkpoint) => {
        const result = await inner.saveCheckpoint(checkpoint);
        // New checkpoint invalidates the cached "latest" — next read re-fetches.
        cache.delete(KEY.checkpoint(checkpoint.taskId));
        return result;
      },
      getLatestCheckpoint: (taskId) =>
        cachedRead(KEY.checkpoint(taskId), () => inner.getLatestCheckpoint(taskId)),

      // ── Approvals: pass-through ──
      saveApprovalRequest: inner.saveApprovalRequest,
      getApprovalRequest: inner.getApprovalRequest,
      updateApprovalRequest: inner.updateApprovalRequest,
      getPendingApprovals: inner.getPendingApprovals,
      getApprovalsByTask: inner.getApprovalsByTask,

      // ── Escalations: pass-through ──
      saveEscalation: inner.saveEscalation,
      getEscalationsByTask: inner.getEscalationsByTask,

      // ── Messages: pass-through (high churn, low reuse) ──
      saveMessage: inner.saveMessage,
      getMessages: inner.getMessages,
      getMessagesByReceiver: inner.getMessagesByReceiver,
      markMessageConsumed: inner.markMessageConsumed,
      ...(inner.getMessagesBySender !== undefined ? { getMessagesBySender: inner.getMessagesBySender } : {}),
      ...(inner.markMessageRead !== undefined ? { markMessageRead: inner.markMessageRead } : {}),
      ...(inner.recallMessage !== undefined ? { recallMessage: inner.recallMessage } : {}),
      ...(inner.evictReadMessages !== undefined ? { evictReadMessages: inner.evictReadMessages } : {}),

      // ── Memories: cache per-(agent, limit), invalidate on save ──
      saveMemory: async (memory: Memory) => {
        const result = await inner.saveMemory(memory);
        // A new memory invalidates ALL cached slices for that agent — any
        // limit-based query could now return a different top-N.
        if (result.isOk) invalidatePrefix(KEY.memoryPrefix(memory.agentName));
        return result;
      },
      getMemoriesByAgent: (agentName, limit) =>
        cachedRead(
          KEY.memories(agentName, limit ?? "all"),
          () => inner.getMemoriesByAgent(agentName, limit),
        ),

      // ── Commits: pass-through (not on the hot path) ──
      saveCommit: inner.saveCommit,
      getCommitsByAgent: inner.getCommitsByAgent,
      searchCommits: inner.searchCommits,

      // ── Queues: pass-through ──
      saveQueue: inner.saveQueue,
      getQueue: inner.getQueue,
      updateQueue: inner.updateQueue,

      // ── Cleanup methods: pass-through if implemented by inner ──
      // The wrapper must forward every optional cleanup method so that
      // runCleanup — which operates on the wrapped store — sees the inner
      // adapter's capabilities. Missing one here silently disables that
      // cleanup path (the guard in runCleanup treats absence as "skip").
      ...(inner.deleteTask !== undefined ? { deleteTask: inner.deleteTask } : {}),
      ...(inner.deleteMessages !== undefined ? { deleteMessages: inner.deleteMessages } : {}),
      ...(inner.getTasksOlderThan !== undefined ? { getTasksOlderThan: inner.getTasksOlderThan } : {}),
      ...(inner.getTaskIds !== undefined ? { getTaskIds: inner.getTaskIds } : {}),
    },
    cache,
  };
};
