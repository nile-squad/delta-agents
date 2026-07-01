/**
 * Generic LRU + TTL cache.
 *
 * Used as the hot-path read-through layer in `createCachedStore` so the engine
 * can avoid re-fetching stable data (tasks, checkpoints, agent memories) from
 * the underlying store on every call. Two eviction policies compose:
 *
 *  - **LRU (least-recently-used)** — bounded by `maxEntries`. When the cap is
 *    reached, the entry with the oldest `lastAccess` is dropped first.
 *  - **TTL (time-to-live)** — sliding window. Each access (get OR set) refreshes
 *    `expiresAt = now + ttlMs`. Expired entries are skipped on read and swept
 *    opportunistically by `evictExpired()`.
 *
 * Tradeoffs:
 *  - Implementation uses a single `Map` and scans for the oldest entry on
 *    eviction (O(n) per overflow). With `maxEntries: 1000` this is a few
 *    microseconds — well below the cost of a DB round-trip. A linked-list
 *    structure would be O(1) but adds complexity for no real gain at this scale.
 *  - The cache is single-process and in-process only. No cross-instance
 *    coordination, no persistence. Restart = cold cache (acceptable: writes
 *    invalidate on next read).
 */

/**
 * Cache configuration.
 *
 * @property maxEntries - Hard cap on the number of entries. Default 1000.
 * @property ttlMs - Access window in milliseconds. Default 5 minutes
 *   (300_000ms). A read or write refreshes the window for that key.
 */
export type CacheConfig = {
  maxEntries?: number;
  ttlMs?: number;
};

/**
 * A single cache entry. Exposed for the read-through wrapper so it can store
 * `Result` values directly without re-fetching on hit.
 */
export type CacheEntry<V> = {
  value: V;
  /** Wall-clock ms of the most recent access (get OR set). Drives LRU eviction. */
  lastAccess: number;
  /** Wall-clock ms at which this entry becomes invisible. Cleared lazily on access. */
  expiresAt: number;
};

/**
 * Cache surface. All operations are synchronous — the cache holds values, not
 * promises — but the read-through wrapper awaits `inner.<read>(...)` on miss
 * and stores the resolved `Result` back through `set`.
 */
export type Cache<K, V> = {
  /**
   * Look up a key. Returns the stored value if present and not expired; refreshes
   * `lastAccess` + `expiresAt` on hit. Returns `undefined` and removes the
   * entry on expiry — expired entries must not leak into the read path.
   */
  get: (key: K) => V | undefined;
  /**
   * Insert or update a key. Refreshes `lastAccess` + `expiresAt`. If the
   * resulting size exceeds `maxEntries`, evicts the least-recently-used entry.
   */
  set: (key: K, value: V) => void;
  /** Remove a key. No-op if absent. */
  delete: (key: K) => void;
  /**
   * True if a key is present AND not expired. Does NOT refresh access time —
   * use `get` when access semantics matter.
   */
  has: (key: K) => boolean;
  /** Current number of entries (including any that are expired but not yet swept). */
  size: () => number;
  /**
   * Sweep expired entries. Returns the number removed. This is the opportunistic
   * cleanup hook — cheap, called piggybacked on engine work (`send`, `inspect`).
   */
  evictExpired: () => number;
  /**
   * Iterate every key currently in the cache, including expired-but-unswept
   * entries. Used by the read-through wrapper to invalidate prefix-scoped
   * groups (e.g. all memory slices for a single agent). Expired entries that
   * appear here are removed by the next `evictExpired()` call.
   */
  keys: () => IterableIterator<K>;
  /** Drop everything. */
  clear: () => void;
};

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 300_000;

/**
 * Create a new LRU + TTL cache instance.
 *
 * @param config - Optional tuning knobs. Omitted fields fall back to sensible
 *   defaults (1000 entries, 5-minute sliding window). Pass `{}` to accept all defaults.
 *
 * @example
 *   const cache = createCache<string, Task>({ maxEntries: 500, ttlMs: 60_000 });
 *   cache.set("task:abc", someTask);
 *   const hit = cache.get("task:abc");
 */
export const createCache = <K, V>(config?: CacheConfig): Cache<K, V> => {
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  // Non-null assertion: maxEntries and ttlMs have sensible defaults; consumers
  // cannot pass NaN/null through the public type.
  const store = new Map<K, CacheEntry<V>>();

  const now = (): number => Date.now();

  /**
   * Find the entry with the smallest `lastAccess`. Tie-break by insertion order
   * (Map iteration order) — the first such key found wins. O(n).
   */
  const findEvictionKey = (): K | undefined => {
    let oldestKey: K | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [k, entry] of store) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = k;
      }
    }
    return oldestKey;
  };

  const refresh = (entry: CacheEntry<V>): void => {
    const t = now();
    entry.lastAccess = t;
    entry.expiresAt = t + ttlMs;
  };

  const isExpired = (entry: CacheEntry<V>): boolean => now() >= entry.expiresAt;

  return {
    get: (key) => {
      const entry = store.get(key);
      if (entry === undefined) return undefined;
      if (isExpired(entry)) {
        store.delete(key);
        return undefined;
      }
      refresh(entry);
      return entry.value;
    },
    set: (key, value) => {
      const t = now();
      const existing = store.get(key);
      if (existing !== undefined) {
        existing.value = value;
        existing.lastAccess = t;
        existing.expiresAt = t + ttlMs;
        return;
      }
      store.set(key, { value, lastAccess: t, expiresAt: t + ttlMs });
      // Evict after insert so the cap is exact, not approximate.
      if (store.size > maxEntries) {
        const victim = findEvictionKey();
        if (victim !== undefined) store.delete(victim);
      }
    },
    delete: (key) => {
      store.delete(key);
    },
    has: (key) => {
      const entry = store.get(key);
      if (entry === undefined) return false;
      if (isExpired(entry)) {
        store.delete(key);
        return false;
      }
      return true;
    },
    size: () => store.size,
    keys: () => store.keys(),
    evictExpired: () => {
      let removed = 0;
      // Collect keys first to avoid mutating the map during iteration.
      const expired: K[] = [];
      for (const [k, entry] of store) {
        if (isExpired(entry)) expired.push(k);
      }
      for (const k of expired) {
        store.delete(k);
        removed += 1;
      }
      return removed;
    },
    clear: () => {
      store.clear();
    },
  };
};
