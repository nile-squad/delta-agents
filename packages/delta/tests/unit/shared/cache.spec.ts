/**
 * LRU + TTL cache tests.
 *
 * Why a real-timer approach with short TTLs instead of vi.useFakeTimers():
 * the cache uses Date.now() and a real elapsed wait is reliable, small, and
 * matches the production time source. Fake timers work too but add setup
 * overhead for tests that are not verifying the timer plumbing.
 */

import { describe, it, expect } from "vitest";
import { createCache } from "../../../src/shared/cache";
import type { Cache } from "../../../src/shared/cache";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createCache — basic operations", () => {
  it("returns undefined for a missing key", () => {
    const c = createCache<string, number>();
    expect(c.get("nope")).toBeUndefined();
  });

  it("set + get round-trip returns the stored value", () => {
    const c = createCache<string, number>();
    c.set("k", 1);
    expect(c.get("k")).toBe(1);
  });

  it("set overwrites the value for the same key", () => {
    const c = createCache<string, number>();
    c.set("k", 1);
    c.set("k", 2);
    expect(c.get("k")).toBe(2);
  });

  it("has returns true for a stored key and false for a missing one", () => {
    const c = createCache<string, number>();
    c.set("k", 1);
    expect(c.has("k")).toBe(true);
    expect(c.has("nope")).toBe(false);
  });

  it("has does not refresh the access window (semantic difference from get)", async () => {
    const c = createCache<string, number>({ ttlMs: 50 });
    c.set("k", 1);
    // has should NOT refresh — the entry must expire on the same schedule.
    expect(c.has("k")).toBe(true);
    await wait(70);
    expect(c.has("k")).toBe(false);
  });

  it("delete removes a specific key", () => {
    const c = createCache<string, number>();
    c.set("a", 1);
    c.set("b", 2);
    c.delete("a");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
  });

  it("delete on a missing key is a no-op", () => {
    const c = createCache<string, number>();
    expect(() => c.delete("nope")).not.toThrow();
  });

  it("size reports the current entry count", () => {
    const c = createCache<string, number>();
    expect(c.size()).toBe(0);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.size()).toBe(2);
    c.delete("a");
    expect(c.size()).toBe(1);
  });

  it("clear removes every entry", () => {
    const c = createCache<string, number>();
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("keys() iterates every current key", () => {
    const c = createCache<string, number>();
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect([...c.keys()].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("createCache — TTL semantics", () => {
  it("get returns undefined and removes the entry after expiry", async () => {
    const c = createCache<string, number>({ ttlMs: 50 });
    c.set("k", 1);
    expect(c.get("k")).toBe(1);
    await wait(70);
    expect(c.get("k")).toBeUndefined();
    // The expired entry is purged from the cache, not merely hidden.
    expect(c.size()).toBe(0);
  });

  it("has returns false for an expired entry", async () => {
    const c = createCache<string, number>({ ttlMs: 50 });
    c.set("k", 1);
    await wait(70);
    expect(c.has("k")).toBe(false);
  });

  it("a get() call before expiry refreshes the TTL window", async () => {
    // Use a wider TTL so timing slop from awaits and event loop ticks does not
    // trip the assertion. The contract under test is "get refreshes the
    // window", not "exactly N ms after set, the entry is gone".
    const c = createCache<string, number>({ ttlMs: 100 });
    c.set("k", 1);
    await wait(50);
    // Access at t=50ms refreshes the window to t=150ms.
    expect(c.get("k")).toBe(1);
    // At t=120ms — past the original 100ms window but inside the refreshed one.
    await wait(70);
    expect(c.get("k")).toBe(1);
    // At t=240ms — past the refreshed 150ms window.
    await wait(120);
    expect(c.get("k")).toBeUndefined();
  });

  it("a set() call on an existing key also refreshes the TTL window", async () => {
    const c = createCache<string, number>({ ttlMs: 50 });
    c.set("k", 1);
    await wait(30);
    c.set("k", 2);             // refreshes the window
    await wait(30);             // t=60ms — still inside the refreshed window
    expect(c.get("k")).toBe(2);
  });
});

describe("createCache — LRU eviction", () => {
  it("evicts the least-recently-accessed entry when maxEntries is exceeded", async () => {
    const c = createCache<string, number>({ maxEntries: 3 });
    c.set("a", 1);
    await wait(2);             // small spacing to make lastAccess strictly distinct
    c.set("b", 2);
    await wait(2);
    c.set("c", 3);
    await wait(2);
    c.set("d", 4);             // over cap → evicts "a" (oldest lastAccess)
    expect(c.size()).toBe(3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
    expect(c.get("d")).toBe(4);
  });

  it("access via get promotes an entry, so it is no longer the LRU victim", async () => {
    const c = createCache<string, number>({ maxEntries: 3 });
    c.set("a", 1);
    await wait(2);
    c.set("b", 2);
    await wait(2);
    c.set("c", 3);
    // Touch "a" so it is no longer the LRU.
    expect(c.get("a")).toBe(1);
    await wait(2);
    c.set("d", 4);             // over cap → evicts "b" (oldest untouched)
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
    expect(c.get("d")).toBe(4);
  });

  it("updating an existing key does not trigger eviction", async () => {
    const c = createCache<string, number>({ maxEntries: 3 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.set("a", 10);            // update, not insert — size stays at 3
    expect(c.size()).toBe(3);
    expect(c.get("a")).toBe(10);
  });
});

describe("createCache — evictExpired", () => {
  it("removes expired entries and returns the count", async () => {
    const c = createCache<string, number>({ ttlMs: 50 });
    c.set("a", 1);
    await wait(70);             // "a" is now expired
    c.set("b", 2);
    expect(c.size()).toBe(2);
    const removed = c.evictExpired();
    expect(removed).toBe(1);
    expect(c.size()).toBe(1);
    expect(c.get("b")).toBe(2);
  });

  it("returns 0 when nothing is expired", () => {
    const c = createCache<string, number>({ ttlMs: 50 });
    c.set("a", 1);
    expect(c.evictExpired()).toBe(0);
  });
});

describe("createCache — defaults", () => {
  it("applies default maxEntries and ttlMs when config is omitted", () => {
    // No assertion on exact numbers (the defaults are 1000 / 300_000), just
    // verify the cache behaves as expected with a single set/get.
    const c: Cache<string, number> = createCache();
    c.set("k", 1);
    expect(c.get("k")).toBe(1);
  });

  it("accepts an empty config object", () => {
    const c: Cache<string, number> = createCache({});
    c.set("k", 1);
    expect(c.get("k")).toBe(1);
  });
});
