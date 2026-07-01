/**
 * Cleanup unit tests — opportunistic eviction + manual retention sweep.
 *
 * The cleanup module has three independent passes, each gated on a presence
 * check so adapters without the corresponding capability degrade gracefully.
 * We exercise the happy paths, the skip-with-warning paths, and the cache
 * invalidation side-effects of task pruning.
 */

import { describe, it, expect } from "vitest";
import { Ok, Err } from "slang-ts";
import { createInMemoryStore } from "../../../src/ports/in-memory-store";
import { createCache } from "../../../src/shared/cache";
import { createEngineLogger } from "../../../src/shared/logger";
import type { LogEntry, Logger } from "../../../src/shared/logger-types";
import { opportunisticCleanup, runCleanup } from "../../../src/engine/cleanup";
import type { StoragePort } from "../../../src/ports/storage-port";
import type { Task, Message } from "../../../src/shared/types";
import { initialRiskState, initialTrust } from "../../../src/governance";

// ── Test helpers ─────────────────────────────────────────────────────────────

const captureLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  const logger = createEngineLogger({
    level: "trace",
    drain: { type: "custom", write: (e) => { entries.push(e); } },
  });
  return { logger, entries };
};

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  rootId: "t1",
  status: "running",
  goal: "g",
  assignedAgent: "agent-a",
  budget: { tokens: 1000, durationMs: 60_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  ...overrides,
});

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  id: "m1",
  taskId: "t1",
  sender: "x",
  receiver: "y",
  payload: "hi",
  createdAt: new Date("2024-01-01"),
  ...overrides,
});

// ── opportunisticCleanup ─────────────────────────────────────────────────────

describe("opportunisticCleanup", () => {
  it("evicts expired entries and returns the count (synchronous)", async () => {
    const cache = createCache<string, unknown>({ ttlMs: 30 });
    cache.set("a", 1);
    cache.set("b", 2);
    await new Promise((r) => setTimeout(r, 50));
    const removed = opportunisticCleanup(cache);
    expect(removed).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("returns 0 when nothing is expired", () => {
    const cache = createCache<string, unknown>({ ttlMs: 1000 });
    cache.set("a", 1);
    expect(opportunisticCleanup(cache)).toBe(0);
    expect(cache.size()).toBe(1);
  });

  it("is synchronous — returns a number, not a promise", () => {
    const cache = createCache<string, unknown>();
    const result = opportunisticCleanup(cache);
    expect(typeof result).toBe("number");
  });
});

// ── runCleanup — cache eviction ──────────────────────────────────────────────

describe("runCleanup — cache eviction", () => {
  it("evicts expired cache entries by default", async () => {
    const cache = createCache<string, unknown>({ ttlMs: 30 });
    cache.set("a", 1);
    await new Promise((r) => setTimeout(r, 50));
    const store = createInMemoryStore();
    const { logger, entries } = captureLogger();
    const result = await runCleanup({ store, cache, logger });
    expect(result.isOk).toBe(true);
    expect(cache.size()).toBe(0);
    // The cleanup child logger emitted a debug entry summarizing the eviction.
    const ev = entries.find((e) => e.module === "cleanup" && e.message.includes("cache eviction"));
    expect(ev).toBeDefined();
  });

  it("skips cache eviction when evictCache: false", async () => {
    const cache = createCache<string, unknown>({ ttlMs: 30 });
    cache.set("a", 1);
    await new Promise((r) => setTimeout(r, 50));
    const store = createInMemoryStore();
    const { logger, entries } = captureLogger();
    await runCleanup({ store, cache, options: { evictCache: false }, logger });
    expect(cache.size()).toBe(1);
    const ev = entries.find((e) => e.message.includes("cache eviction"));
    expect(ev).toBeUndefined();
  });
});

// ── runCleanup — task pruning ────────────────────────────────────────────────

describe("runCleanup — task pruning", () => {
  it("deletes completed tasks older than taskRetentionMs and invalidates cache", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const { logger } = captureLogger();
    const old = new Date(Date.now() - 10_000);
    const oldTask = makeTask({ id: "old-done", status: "completed", updatedAt: old });
    await store.saveTask(oldTask);
    // Warm the cache so we can verify invalidation.
    cache.set("task:old-done", Ok(oldTask) as unknown);
    cache.set("checkpoint:old-done", Ok(null) as unknown);

    const result = await runCleanup({
      store, cache,
      options: { taskRetentionMs: 5_000 },
      logger,
    });
    expect(result.isOk).toBe(true);
    const after = await store.getTask("old-done");
    expect(after.isErr).toBe(true);
    expect(cache.get("task:old-done")).toBeUndefined();
    expect(cache.get("checkpoint:old-done")).toBeUndefined();
  });

  it("leaves running and pending tasks alone even when their updatedAt is past the threshold", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const { logger } = captureLogger();
    const old = new Date(Date.now() - 10_000);
    await store.saveTask(makeTask({ id: "still-running", status: "running", updatedAt: old }));
    await store.saveTask(makeTask({ id: "still-pending", status: "pending", updatedAt: old }));
    await runCleanup({ store, cache, options: { taskRetentionMs: 5_000 }, logger });
    expect((await store.getTask("still-running")).isOk).toBe(true);
    expect((await store.getTask("still-pending")).isOk).toBe(true);
  });

  it("deletes failed and aborted tasks past the retention window", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const { logger } = captureLogger();
    const old = new Date(Date.now() - 10_000);
    await store.saveTask(makeTask({ id: "old-failed", status: "failed", updatedAt: old }));
    await store.saveTask(makeTask({ id: "old-aborted", status: "aborted", updatedAt: old }));
    await runCleanup({ store, cache, options: { taskRetentionMs: 5_000 }, logger });
    expect((await store.getTask("old-failed")).isErr).toBe(true);
    expect((await store.getTask("old-aborted")).isErr).toBe(true);
  });

  it("leaves completed tasks within the retention window", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const { logger } = captureLogger();
    const recent = new Date(Date.now() - 100);
    await store.saveTask(makeTask({ id: "recent-done", status: "completed", updatedAt: recent }));
    await runCleanup({ store, cache, options: { taskRetentionMs: 5_000 }, logger });
    expect((await store.getTask("recent-done")).isOk).toBe(true);
  });

  it("skips task pruning gracefully when the store lacks getTasksOlderThan", async () => {
    const cache = createCache<string, unknown>();
    const { logger, entries } = captureLogger();
    const noCleanupStore = {} as StoragePort;
    const result = await runCleanup({
      store: noCleanupStore,
      cache,
      options: { taskRetentionMs: 1_000 },
      logger,
    });
    expect(result.isOk).toBe(true);
    const warning = entries.find((e) => e.level === "warn" && e.message.includes("task pruning skipped"));
    expect(warning).toBeDefined();
    expect(warning?.module).toBe("cleanup");
  });

  it("skips task pruning gracefully when the store lacks deleteTask", async () => {
    const cache = createCache<string, unknown>();
    const { logger, entries } = captureLogger();
    // Store has getTasksOlderThan but not deleteTask.
    const partialStore: StoragePort = {
      getTasksOlderThan: async () => Ok([]),
    } as unknown as StoragePort;
    const result = await runCleanup({
      store: partialStore,
      cache,
      options: { taskRetentionMs: 1_000 },
      logger,
    });
    expect(result.isOk).toBe(true);
    const warning = entries.find((e) => e.level === "warn" && e.message.includes("task pruning skipped"));
    expect(warning).toBeDefined();
  });
});

// ── runCleanup — message pruning ─────────────────────────────────────────────

describe("runCleanup — message pruning", () => {
  it("removes consumed messages older than messageRetentionMs and leaves unconsumed ones", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const { logger } = captureLogger();
    // The cleanup walk calls store.getTaskIds() — it only scans tasks that
    // exist. Seed a task so its message list is reachable.
    await store.saveTask(makeTask({ id: "t1" }));
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 100);
    await store.saveMessage(makeMessage({ id: "old-consumed", taskId: "t1", consumed: true, createdAt: old }));
    await store.saveMessage(makeMessage({ id: "recent-consumed", taskId: "t1", consumed: true, createdAt: recent }));
    await store.saveMessage(makeMessage({ id: "old-unconsumed", taskId: "t1", consumed: false, createdAt: old }));

    const result = await runCleanup({
      store, cache,
      options: { messageRetentionMs: 5_000 },
      logger,
    });
    expect(result.isOk).toBe(true);
    const messages = await store.getMessages("t1");
    if (!messages.isOk) throw new Error("expected ok");
    const ids = messages.value.map((m) => m.id).sort();
    expect(ids).toEqual(["old-unconsumed", "recent-consumed"]);
  });

  it("skips message pruning gracefully when the store lacks getTaskIds", async () => {
    const cache = createCache<string, unknown>();
    const { logger, entries } = captureLogger();
    const partialStore: StoragePort = {
      deleteMessages: async () => Ok(0),
    } as unknown as StoragePort;
    const result = await runCleanup({
      store: partialStore,
      cache,
      options: { messageRetentionMs: 1_000 },
      logger,
    });
    expect(result.isOk).toBe(true);
    const warning = entries.find((e) => e.level === "warn" && e.message.includes("message pruning skipped"));
    expect(warning).toBeDefined();
  });

  it("skips message pruning gracefully when the store lacks deleteMessages", async () => {
    const cache = createCache<string, unknown>();
    const { logger, entries } = captureLogger();
    const partialStore: StoragePort = {
      getTaskIds: async () => Ok([]),
    } as unknown as StoragePort;
    const result = await runCleanup({
      store: partialStore,
      cache,
      options: { messageRetentionMs: 1_000 },
      logger,
    });
    expect(result.isOk).toBe(true);
    const warning = entries.find((e) => e.level === "warn" && e.message.includes("message pruning skipped"));
    expect(warning).toBeDefined();
  });

  it("a per-task deleteMessages failure is logged and the sweep continues", async () => {
    const cache = createCache<string, unknown>();
    const { logger, entries } = captureLogger();
    const store: StoragePort = {
      getTaskIds: async () => Ok(["t1", "t2"]),
      deleteMessages: async (taskId: string) =>
        taskId === "t1" ? Err("io error") : Ok(3),
    } as unknown as StoragePort;
    const result = await runCleanup({ store, cache, options: { messageRetentionMs: 1_000 }, logger });
    expect(result.isOk).toBe(true);
    const failed = entries.find((e) => e.level === "warn" && e.message.includes("io error"));
    expect(failed).toBeDefined();
  });
});

// ── runCleanup — empty options and no-op ─────────────────────────────────────

describe("runCleanup — empty options and no-op cases", () => {
  it("with no options, evicts cache and touches nothing else", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>({ ttlMs: 30 });
    cache.set("x", 1);
    await new Promise((r) => setTimeout(r, 50));
    const result = await runCleanup({ store, cache });
    expect(result.isOk).toBe(true);
    expect(cache.size()).toBe(0);
  });

  it("works without a logger (optional param)", async () => {
    const store = createInMemoryStore();
    const cache = createCache<string, unknown>();
    const result = await runCleanup({ store, cache });
    expect(result.isOk).toBe(true);
  });
});
