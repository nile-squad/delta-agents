# Task: Logger, Diagnostics, Cache Eviction, Opportunistic Cleanup

## Goal
Four features for delta-agents:
1. **Central logger** — pino-based, per-engine, created at `createDeltaEngine` time. Drains: console (dev, pretty), file (daily `.log`), sqlite (queryable), custom. Replaces the current global `configureLogger`/`createLogger` pattern.
2. **Configurable diagnostics** — per-module toggle. When on, module emits structured events to the logger. Toggle off = zero emission.
3. **Auto-eviction cache** — LRU + TTL read-through wrapper over `StoragePort`. Hot-path reads (getTask, getLatestCheckpoint, getMemoriesByAgent) cached in memory. Access refreshes TTL. Eviction = drop from memory only; DB retains data.
4. **Opportunistic + manual cleanup** — lightweight cache-eviction pass piggybacked on engine work (`send`, `inspect`). Manual `delta.cleanup(options?)` for heavier store pruning (completed/failed tasks past retention, consumed messages past retention).

## API Surface

### DeltaEngineConfig additions (in `src/engine/types.ts`)
```ts
logger?: LoggerConfig;
diagnostics?: DiagnosticsConfig;
cache?: CacheConfig;
```

### DeltaEngine facade addition
```ts
cleanup: (options?: CleanupOptions) => Promise<Result<void, string>>;
```

### New types (in `src/shared/logger-types.ts`)
```ts
type LoggerDrain =
  | { type: "console" }
  | { type: "file"; dir?: string }       // default ".delta-logs", daily YYYY-MM-DD.log, append-only
  | { type: "sqlite"; path?: string }    // default "delta-logs.sqlite", separate from task store
  | { type: "custom"; write: (entry: LogEntry) => void };

type LoggerConfig = {
  mode?: "dev" | "prod";                  // default "dev"
  level?: "trace" | "debug" | "info" | "warn" | "error";  // default "info"
  drain?: LoggerDrain;                    // default: console in dev, file in prod
};

type DiagnosticsConfig = {
  actions?: boolean; workflows?: boolean; governance?: boolean;
  supervision?: boolean; memory?: boolean; comms?: boolean;
  tools?: boolean; engine?: boolean;
};  // all default false

type CacheConfig = {
  maxEntries?: number;   // default 1000
  ttlMs?: number;        // default 300_000 (5 min access-window)
};

type CleanupOptions = {
  taskRetentionMs?: number;       // remove completed/failed tasks older than this
  messageRetentionMs?: number;    // remove consumed messages older than this
  evictCache?: boolean;           // default true
};
```

## Architecture

### Logger
- pino is always the engine under the hood.
- `mode: "dev"` → pino-pretty to console (colorized, readable).
- `mode: "prod"` → configured drain (file/sqlite/custom).
- Default drain follows mode: dev=console, prod=file.
- Per-engine logger created at `createDeltaEngine` time, passed to all modules via DI (closure variable, passed into factories).
- Replaces `src/shared/logger.ts` entirely. No backward compat needed (not released).
- `createLogger(module)` now takes the engine logger and returns a child logger: `engineLogger.child({ module })`.
- Existing consumer: `src/engine/loop-detector.ts:31` — `const log = createLogger("loop-detector")`. Must be updated to receive logger via DI.

### Diagnostics
- Each module gets a pino child logger (`logger.child({ module: "actions" })`).
- When a module's diagnostic toggle is on, it emits structured events at `debug`/`trace` level (timing, decision traces, counts).
- Toggle off = zero emission (no overhead — guard clause before emission).
- Diagnostics config lives on `DeltaEngineConfig`, resolved at engine creation, passed to modules.

### Cache
- LRU + TTL cache abstraction in `src/shared/cache.ts`.
- `createCachedStore(inner: StoragePort, config: CacheConfig): StoragePort` — read-through wrapper.
- Caches hot-path reads: `getTask`, `getLatestCheckpoint`, `getMemoriesByAgent`.
- Access (read OR write) refreshes TTL (LRU-on-access).
- Eviction = drop from memory only; DB retains the data.
- Re-load from DB on next access starts fresh tracking.
- Writes (`saveTask`, `saveCheckpoint`, `saveMemory`, `updateTask`) invalidate/update the cache entry.
- `maxEntries` cap: when exceeded, evict least-recently-accessed entry.
- `ttlMs`: entry expires if not accessed within this window.

### Cleanup
- **Opportunistic** (always-on, cheap): piggybacked on `send` and `inspect`. Evicts expired cache entries. No store I/O.
- **Manual** (`delta.cleanup(options?)`): heavier work. Prunes completed/failed tasks past `taskRetentionMs`, prunes consumed messages past `messageRetentionMs`, evicts all expired cache entries. Destructive store operations are opt-in via retention params (omit = don't touch).
- Cleanup needs store methods that don't exist yet on `StoragePort`. Add optional methods:
  - `deleteTask?(id: string): Promise<Result<void, string>>`
  - `deleteMessages?(taskId: string, olderThan?: Date): Promise<Result<number, string>>` — returns count deleted
  - These are optional on `StoragePort` — adapters implement if they support cleanup. In-memory adapter implements them. Drizzle adapter implements them.

## File Structure (new + modified)

### New files
- `src/shared/logger-types.ts` — LoggerConfig, LoggerDrain, LogEntry, LogContext, Logger type
- `src/shared/logger.ts` — REWRITE: pino-based factory `createEngineLogger(config): Logger`
- `src/shared/diagnostics.ts` — DiagnosticsConfig, createDiagnostics
- `src/shared/cache.ts` — LRU+TTL cache abstraction
- `src/ports/cached-store.ts` — read-through StoragePort wrapper
- `src/ports/log-sqlite.ts` — sqlite drain schema + writer
- `src/engine/cleanup.ts` — opportunistic + manual cleanup logic

### Modified files
- `src/engine/types.ts` — add logger, diagnostics, cache to DeltaEngineConfig; add cleanup to DeltaEngine
- `src/engine/create-delta-engine.ts` — wire logger, diagnostics, cache, cleanup
- `src/engine/loop-detector.ts` — receive logger via DI instead of global createLogger
- `src/ports/storage-port.ts` — add optional deleteTask, deleteMessages
- `src/ports/in-memory-store.ts` — implement deleteTask, deleteMessages
- `src/ports/drizzle-store.ts` — implement deleteTask, deleteMessages
- `src/shared/index.ts` — update exports (logger types changed)
- `src/index.ts` — export new public types (LoggerConfig, DiagnosticsConfig, CacheConfig, CleanupOptions)
- `package.json` — add pino, pino-pretty

## Dependencies to Add
- `pino` (approved)
- `pino-pretty` (approved)

## Implementation Phases

| Phase | What | Deps on | Delegate to |
|-------|------|---------|-------------|
| 1 | Logger (pino + drains + wire into config) | — | backend-engineer |
| 2 | Diagnostics (config + per-module emission) | Phase 1 | backend-engineer |
| 3 | Cache (LRU+TTL + cached-store wrapper) | — | backend-engineer |
| 4 | Cleanup (opportunistic + manual method + store methods) | Phase 3 | backend-engineer |
| 5 | Tests (all features) | 1-4 | qa-engineer |
| 6 | context.md update | 1-4 | architect |

Phases 1+3 run in parallel. 2 after 1. 4 after 3. 5 after all.

## Verification
- `pnpm test` — all tests pass (existing + new)
- `tsc --noEmit` — no type errors
- `pnpm build` — builds clean

## Important Notes
- Use `safeTry` over try/catch
- No `any`, no `unknown`
- `type` over `interface`, no `enum`
- Factory functions, no classes
- Named params `{ }` not positional
- JSDoc explains WHY
- Match existing code style
- pino is always the engine; dev mode = pino-pretty to console; prod = configured drain
- Cache is read-through over StoragePort — same interface, transparent to engine
- Eviction = memory only, never DB
- Destructive cleanup is opt-in via retention params
- Default logger: dev mode = console (pretty), silent if not configured? No — dev mode defaults to console pretty. Prod defaults to file drain.