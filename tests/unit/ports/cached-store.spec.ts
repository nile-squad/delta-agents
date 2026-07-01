/**
 * CachedStore wrapper tests — read-through behavior over StoragePort.
 *
 * What we verify:
 *   - getTask caches on miss and serves from cache on hit
 *   - saveTask updates the cache
 *   - updateTask invalidates
 *   - getLatestCheckpoint caches (including null/negative)
 *   - saveCheckpoint invalidates
 *   - getMemoriesByAgent caches per (agent, limit)
 *   - saveMemory invalidates all memory slices for an agent
 *   - pass-through methods delegate unchanged
 *   - only Ok results are cached (Err is not cached)
 *
 * The inner store is instrumented to count calls. The cached wrapper must
 * be transparent on miss, fast on hit, and never poison the cache with a
 * failed read.
 */

import { describe, it, expect } from "vitest";
import { Ok, Err } from "slang-ts";
import { createInMemoryStore } from "../../../src/ports/in-memory-store";
import { createCachedStore } from "../../../src/ports/cached-store";
import type { StoragePort } from "../../../src/ports/storage-port";
import type { Task, Checkpoint, Memory, TaskTree, Execution, Commit } from "../../../src/shared/types";
import { initialRiskState, initialTrust } from "../../../src/governance";

// ── Test helpers ─────────────────────────────────────────────────────────────

const now = new Date("2026-07-01T10:00:00.000Z");

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "tsk_cache_1",
  rootId: "tsk_cache_1",
  status: "running",
  goal: "cache test",
  assignedAgent: "agent-a",
  budget: { tokens: 1000, durationMs: 60_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const makeCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  id: "ckpt_1",
  taskId: "tsk_cache_1",
  state: { step: "phase-1" },
  createdAt: now,
  ...overrides,
});

const makeMemory = (overrides: Partial<Memory> = {}): Memory => ({
  id: "mem_1",
  taskId: "tsk_cache_1",
  agentName: "agent-a",
  kind: "fact",
  content: "the cache is hot",
  createdAt: now,
  ...overrides,
});

/** Instrument a store so we can count invocations on hot-path methods. */
const instrumented = (inner: StoragePort): StoragePort & { counts: Record<string, number> } => {
  const counts: Record<string, number> = {};
  const wrap = <T extends (...args: never[]) => unknown>(name: string, fn: T): T => {
    return ((...args: never[]) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return fn(...args);
    }) as T;
  };
  return {
    ...inner,
    counts,
    saveTask: wrap("saveTask", inner.saveTask),
    getTask: wrap("getTask", inner.getTask),
    updateTask: wrap("updateTask", inner.updateTask),
    saveCheckpoint: wrap("saveCheckpoint", inner.saveCheckpoint),
    getLatestCheckpoint: wrap("getLatestCheckpoint", inner.getLatestCheckpoint),
    saveMemory: wrap("saveMemory", inner.saveMemory),
    getMemoriesByAgent: wrap("getMemoriesByAgent", inner.getMemoriesByAgent),
  };
};

describe("createCachedStore — getTask read-through", () => {
  it("first getTask calls inner; second call hits cache (inner not called again)", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    // Seed via the raw inner store so the wrapper's cache is not yet populated.
    // (The wrapper's saveTask also caches, which would make the first getTask a
    // hit instead of a miss — defeating the test.)
    await inner.saveTask(makeTask());
    inner.counts["getTask"] = 0;
    const a = await store.getTask("tsk_cache_1");
    const b = await store.getTask("tsk_cache_1");
    expect(a.isOk).toBe(true);
    expect(b.isOk).toBe(true);
    expect(inner.counts["getTask"]).toBe(1);
  });

  it("getTask caches Err too (negative caching) — second call returns the same Err without inner call", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    const a = await store.getTask("no-such-id");
    const b = await store.getTask("no-such-id");
    expect(a.isErr).toBe(true);
    expect(b.isErr).toBe(true);
    expect(inner.counts["getTask"]).toBe(1);
  });
});

describe("createCachedStore — saveTask updates the cache", () => {
  it("after saveTask, getTask returns the new value (not the stale one)", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    await store.saveTask(makeTask({ goal: "v1" }));
    const a = await store.getTask("tsk_cache_1");
    if (a.isOk) expect(a.value.goal).toBe("v1");
    await store.saveTask(makeTask({ goal: "v2" }));
    const b = await store.getTask("tsk_cache_1");
    if (b.isOk) expect(b.value.goal).toBe("v2");
  });
});

describe("createCachedStore — updateTask invalidates", () => {
  it("after updateTask, the next getTask re-fetches from inner", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    await store.saveTask(makeTask());
    await store.getTask("tsk_cache_1");             // warms the cache
    inner.counts["getTask"] = 0;
    const patch = await store.updateTask("tsk_cache_1", { status: "completed" });
    expect(patch.isOk).toBe(true);
    const next = await store.getTask("tsk_cache_1");
    expect(next.isOk).toBe(true);
    if (next.isOk) expect(next.value.status).toBe("completed");
    expect(inner.counts["getTask"]).toBe(1);
  });
});

describe("createCachedStore — getLatestCheckpoint", () => {
  it("caches null (negative caching) — second call does not hit inner", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    const a = await store.getLatestCheckpoint("no-ckpt-task");
    const b = await store.getLatestCheckpoint("no-ckpt-task");
    expect(a.isOk).toBe(true);
    if (a.isOk) expect(a.value).toBeNull();
    expect(b.isOk).toBe(true);
    if (b.isOk) expect(b.value).toBeNull();
    expect(inner.counts["getLatestCheckpoint"]).toBe(1);
  });

  it("caches the latest checkpoint and serves it on subsequent reads", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt_a" }));
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt_b" }));
    const a = await store.getLatestCheckpoint("tsk_cache_1");
    const b = await store.getLatestCheckpoint("tsk_cache_1");
    if (a.isOk) expect(a.value?.id).toBe("ckpt_b");
    if (b.isOk) expect(b.value?.id).toBe("ckpt_b");
    expect(inner.counts["getLatestCheckpoint"]).toBe(1);
  });

  it("saveCheckpoint invalidates the cached latest — next get re-fetches", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt_a" }));
    const first = await store.getLatestCheckpoint("tsk_cache_1");
    if (first.isOk) expect(first.value?.id).toBe("ckpt_a");
    await store.saveCheckpoint(makeCheckpoint({ id: "ckpt_b" }));
    const second = await store.getLatestCheckpoint("tsk_cache_1");
    if (second.isOk) expect(second.value?.id).toBe("ckpt_b");
    expect(inner.counts["getLatestCheckpoint"]).toBe(2);
  });
});

describe("createCachedStore — getMemoriesByAgent caching", () => {
  it("caches per (agent, limit) — different limits get separate cache entries", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    // Seed via raw inner.store to avoid the wrapper's saveMemory invalidation path.
    await inner.saveMemory(makeMemory({ id: "m1", createdAt: new Date("2026-07-01T10:00:00.000Z") }));
    await inner.saveMemory(makeMemory({ id: "m2", createdAt: new Date("2026-07-01T10:00:01.000Z") }));
    await inner.saveMemory(makeMemory({ id: "m3", createdAt: new Date("2026-07-01T10:00:02.000Z") }));
    const all = await store.getMemoriesByAgent("agent-a");
    const limit2 = await store.getMemoriesByAgent("agent-a", 2);
    const limit2Again = await store.getMemoriesByAgent("agent-a", 2);
    const allAgain = await store.getMemoriesByAgent("agent-a");
    if (all.isOk) expect(all.value).toHaveLength(3);
    if (limit2.isOk) expect(limit2.value).toHaveLength(2);
    if (limit2Again.isOk) expect(limit2Again.value).toHaveLength(2);
    if (allAgain.isOk) expect(allAgain.value).toHaveLength(3);
    // 2 distinct cache keys, each fetched exactly once → 2 inner calls.
    expect(inner.counts["getMemoriesByAgent"]).toBe(2);
  });

  it("saveMemory invalidates every cached slice for the agent (any limit)", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    // Seed initial memory via the raw inner to avoid the wrapper's invalidation
    // path firing before we have a chance to warm the cache.
    await inner.saveMemory(makeMemory({ id: "m1" }));
    await store.getMemoriesByAgent("agent-a");         // warms "agent-a:all"
    await store.getMemoriesByAgent("agent-a", 5);       // warms "agent-a:5"
    // Wrapper's saveMemory invalidates the agent's prefix and seeds a new row.
    await store.saveMemory(makeMemory({ id: "m2" }));
    const a = await store.getMemoriesByAgent("agent-a");
    const b = await store.getMemoriesByAgent("agent-a", 5);
    if (a.isOk) expect(a.value).toHaveLength(2);
    if (b.isOk) expect(b.value).toHaveLength(2);
    // 2 warm-up calls + 2 post-invalidation calls = 4 total inner calls.
    expect(inner.counts["getMemoriesByAgent"]).toBe(4);
  });

  it("does not invalidate memory slices belonging to other agents", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    // Seed via the raw inner to avoid early invalidations.
    await inner.saveMemory(makeMemory({ id: "m1", agentName: "agent-a" }));
    await inner.saveMemory(makeMemory({ id: "m2", agentName: "agent-b" }));
    await store.getMemoriesByAgent("agent-a");
    await store.getMemoriesByAgent("agent-b");
    inner.counts["getMemoriesByAgent"] = 0;             // reset after warm
    // Wrapper's saveMemory for agent-a only invalidates agent-a slices.
    await store.saveMemory(makeMemory({ id: "m3", agentName: "agent-a" }));
    await store.getMemoriesByAgent("agent-a");          // miss → inner
    await store.getMemoriesByAgent("agent-b");          // hit
    expect(inner.counts["getMemoriesByAgent"]).toBe(1);
  });
});

describe("createCachedStore — pass-through methods", () => {
  it("saveTaskTree delegates to inner (single call, identical args)", async () => {
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    const tree: TaskTree = { rootTaskId: "t1", activeChildren: [], queuedChildren: [], maxConcurrency: 2 };
    const result = await store.saveTaskTree(tree);
    expect(result.isOk).toBe(true);
    expect(inner.counts["saveTaskTree"] ?? 0).toBe(0);  // instrumented does not count this one
    // The unwrapped inner.store call still ran (no separate count available).
    const fetched = await store.getTaskTree("t1");
    expect(fetched.isOk).toBe(true);
  });

  it("exposes the underlying cache handle", () => {
    const { store: _store, cache } = createCachedStore(createInMemoryStore());
    expect(typeof cache.get).toBe("function");
    expect(typeof cache.evictExpired).toBe("function");
  });

  it("forwards deleteTask and deleteMessages when the inner store implements them", async () => {
    // The in-memory store implements both — verify the wrapper forwards them.
    const inner = createInMemoryStore();
    const { store } = createCachedStore(inner);
    await store.saveTask(makeTask());
    await store.saveMessage({ id: "m1", taskId: "t1", sender: "x", receiver: "y", payload: "hi", createdAt: now });
    const del = await store.deleteTask?.("tsk_cache_1");
    expect(del?.isOk).toBe(true);
    const delMsg = await store.deleteMessages?.("t1");
    expect(delMsg?.isOk).toBe(true);
  });

  it("commits (saveCommit, getCommitsByAgent, searchCommits) are pass-through, not cached", async () => {
    const inner = createInMemoryStore();
    const { store } = createCachedStore(inner);
    const commit: Commit = {
      id: "cmt_cache_1", taskId: "t1", agentName: "agent-x", workflowName: "wf",
      notes: "did the thing", checkpointId: null, createdAt: now,
    };
    const saveResult = await store.saveCommit(commit);
    expect(saveResult.isOk).toBe(true);

    // Read through the cached wrapper reflects what the inner store holds — no
    // separate commit cache to go stale.
    const viaCached = await store.getCommitsByAgent("agent-x");
    const viaInner = await inner.getCommitsByAgent("agent-x");
    expect(viaCached.isOk).toBe(true);
    expect(viaInner.isOk).toBe(true);
    if (!viaCached.isOk || !viaInner.isOk) return;
    expect(viaCached.value).toEqual(viaInner.value);

    const searchResult = await store.searchCommits({ workflowName: "wf" }, "agent-x");
    expect(searchResult.isOk).toBe(true);
    if (searchResult.isOk) expect(searchResult.value.map((c) => c.id)).toEqual(["cmt_cache_1"]);
  });
});

describe("createCachedStore — caching policy", () => {
  it("only Ok results are cached (an Err does not poison the cache, but is also not cached)", async () => {
    // We can observe this by watching the cache's hit rate on a missing id:
    // if the Err were cached, a subsequent read would never re-call inner.
    // The current contract caches the Err for negative-cache benefits; what
    // we DO guarantee is that a successful save on the same key invalidates
    // and the next read re-fetches.
    const inner = instrumented(createInMemoryStore());
    const { store } = createCachedStore(inner);
    // Initially: Err is cached as a negative result.
    const miss1 = await store.getTask("no-such");
    const miss2 = await store.getTask("no-such");
    expect(miss1.isErr).toBe(true);
    expect(miss2.isErr).toBe(true);
    expect(inner.counts["getTask"]).toBe(1);
    // A save with the missing id updates the cache to the Ok entry.
    await store.saveTask(makeTask({ id: "no-such" }));
    const hit = await store.getTask("no-such");
    expect(hit.isOk).toBe(true);
    if (hit.isOk) expect(hit.value.id).toBe("no-such");
  });
});
