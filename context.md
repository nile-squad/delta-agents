# Project Context: delta-agents

## Context Rules

### What belongs here
- **Architecture decisions & rationale** — why things are the way they are
- **Established patterns & idioms** — conventions discovered during implementation (hard to glean from code alone)
- **Non-obvious tradeoffs** — what was sacrificed and why
- **Current state summary** — what's implemented, what's deferred/catalogued
- **Critical decisions** — build tools, dependency choices, design forks
- **System overview** — high-level architecture, key types, DX pattern

### What does NOT belong here
- **Changelogs** — git log exists for this. No per-item fix descriptions, commit hashes, or test names
- **Test details** — test file paths, test names, assertion descriptions, test counts
- **Implementation diaries** — "step by step how we fixed X" — belongs in git history
- **Per-package breakdowns** — once a package is wired, its changelog is noise
- **Duplicates of AGENTS.md** — conventions already stated there should not be restated verbatim

### Principles
- Context must be **accurate** (wrong context > no context) and **current** (stale entries removed)
- Future agents need to understand the project in 5 minutes, not 30
- If you can read it from code, it doesn't need to be here
- Only document what's **non-obvious** from reading source files

## Current State (as of 2026-07-01)

All packages A–J are implemented and tested (911 tests pass). Public surface at `src/index.ts`. `dist/` loads under plain Node. Full spec in `docs/internal/delta-agents.spec.md`.

All H-series subsystems are wired into the live path. Remaining work is catalogued below, not whole subsystems.

### What's implemented
- **Logger (pino):** per-engine logger created at `createDeltaEngine` time. Drains: console (dev pretty), file (daily `.log`), sqlite (queryable), custom. Replaces old global sink. Threaded via DI through scheduler/runtime/loop-detector.
- **Diagnostics:** per-module toggle (`DiagnosticsConfig`). Disabled = shared no-op emitter (zero overhead). Enabled = structured events to pino at debug/trace. PoC: engine (step events), actions (gateway timing).
- **Cache (LRU+TTL):** read-through `createCachedStore` over `StoragePort`. Hot-path reads (getTask, getLatestCheckpoint, getMemoriesByAgent) cached. Access refreshes TTL. Eviction = memory only.
- **Cleanup:** opportunistic `cache.evictExpired()` on every `send`/`inspect`. Manual `delta.cleanup(options?)` prunes old tasks + consumed messages (opt-in, destructive). Optional store methods: `deleteTask`, `deleteMessages`, `getTasksOlderThan`, `getTaskIds`.
- **C1-C4 (status honesty):** escalation stops loop -> `paused`+`blocked` (not `completed`). Reasoner failure -> `failed`. Budget exhaustion -> `failed`. Token cost fully wired.
- **H1 (supervision):** per-phase supervision on workflow failure via `applyStrategy` + `retryFnWithJitter`. Recovery boundary = phase.
- **H2 (workflow execution):** `SendInput.workflow` drives deterministic (reasoner-less) execution. Free loop for workflow-less tasks. Shared `applyPostStepGovernance` for both paths (in `oversight/post-step.ts` to avoid engine<->workflow import cycle).
- **H3 (governance math):** `assembleStepSignals` (friction + Kalman + Bayesian surprise) wired into live loop. Kalman state survives pause/resume.
- **H4 (delegation):** `ReasonerDecision.kind:"delegate"` -> bounded supervision tree. Scheduler: step-able loop + round-robin (max 2 active children, FIFO queue). Parent budget reserved at grant, refunded on settle. Parent blocked/failed cascades abort to tree.
- **H5a (busy queue):** agent busy -> `SendResult.status:"queued"`, message attributable to existing task.
- **H5b (message drain):** natural-done drains unconsumed caller messages into task goal. Idempotent via checkpointed `consumedMessages`.
- **E1-E3 (comms + skills):** `ReasonerDecision.kind:"communicate"` -> channel dispatch with optional approval. Chat SDK bridged structurally (no dep). `ActionContext.communicate()` for declarative path. Skills: `folder`-based, engine reads `SKILL.md` internally, scoped by agent/phase/action.
- **F (memory retrieval):** `Memory` type + `memories` table (libsql). `retrieveContext` before each `reason()` call. `ctx.remember()` for write. Keyword ranking (no embeddings).
- **G (optimization + trust):** surprise erodes trust (>0.4 threshold). Degraded trust (<0.3) escalates. Bellman MPC pre-block on workflow. Action ranking cheapest-first.
- **Multi-axis Cost:** `Cost` = `{ tokens, durationMs, memory?, latency? }`. Opt-in enforcement. Flows through budget, MPC, subtask scoping.
- **H1/H3 re-run fidelity:** retry from `failedIndex`, restart from phase entry, resume from checkpoint. Active child rehydration on resume. Per-action workflow inputs (`actionInputs`).
- **Storylines:** `Workflow.storyline?` + `Phase.storyline?` (free-prose narrative of ideal user flow). Injected into `ActionContext.storyline` + `ActionContext.phaseStoryline` via the execution gateway — single channel, no duplicate injection. Free loop (no workflow) sees `undefined`. NOT persisted in `TaskStateSnapshot` (authoring content, plumbed fresh from definitions).
- **System prompt + time awareness:** `DeltaEngineConfig.systemPrompt?` (static org instructions, baked into system message prefix for prompt cache) + `DeltaEngineConfig.timezone?` (grounds agents with time awareness). Current time (humanized + ISO + tz) injected into user message per `reason()` call. Prior messages loaded from store with relative time (`formatDistanceToNow`). System message = cacheable prefix only; user message = all varying content. `buildMessages` exported for direct testing.
- **Package I (correctness):** `deploy()` gates `send()`. All `as unknown` casts centralized to `snapshotFromJson`/`snapshotToJson` (exactly 1 cast in `src/`).
- **Package J (surface + docs):** Complete public API at `src/index.ts`. README rewritten from shipped surface.
- **Agent Commit Feature:** All 7 phases done. Commit entity with storage (in-memory + Drizzle), post-workflow commit step, hard-block on pendingCommit, resume support, context injection (recent N commits into reasoner prompt), `system:search_commits` tool, free-loop optional `system:commit`, full unit + integration test coverage.

### What's deferred (catalogued)
- Per-action reasoner-filled inputs (single shared `input` bag today)
- Workflow approval round-trip resume (blocked-on-approval re-runs from start)
- Workflow pause/resume correctness
- Semantic/embedding memory ranking (needs embed provider)
- Memory-access audit log (writes attributable; reads not logged)
- Auto-capture execution outcomes as memories (today explicit via `ctx.remember`)
- Richer future-cost estimation for `computeActionValue` (uniform term = ranking reduces to immediate cost)
- MPC horizon in free reasoner loop (only workflow path has declared horizon)
- `Queue` entity is spec-aligned but NOT engine-driven (engine uses `TaskTree.queuedChildren` + `Message`s)

### Storage
All 9 entities have working store methods in both adapters (in-memory + Drizzle). New `commits` table added for the Agent Commit Feature (Drizzle schema + migrations). No remaining work needs new DB schema. New persisted state rides inside `TaskStateSnapshot` JsonRecord.

---

## Critical Decisions

- **Build: Bun -> tsup (esbuild) on Node.** Ships as a library into Node backends; must not require Bun. Extensionless barrel imports + ESM-only deps forced a Node-native bundler. tsup over raw esbuild for `.d.ts` emit.
- **slang-ts bundled (`noExternal`), not external.** `export * from "slang-ts"` requires build-time resolution; esbuild drops star re-exports of externals. Bundled Result works structurally (no `instanceof`), so consumer's own slang-ts interoperates.
- **Delegation trigger = `ReasonerDecision` kind, not magic action.** Keeps gateway as a pure action-execution chokepoint.
- **Queue entity = spec-aligned but engine-unused.** Engine FIFO via `TaskTree.queuedChildren` + `Message`s avoids redundant parallel queue subsystem.
- **Storyline injection = ActionContext only, not reasoner context.** Workflows are reasoner-less (deterministic execution), so injecting storyline into the reasoner would be dead weight in workflow mode. ActionContext reaches action fns + hooks in both paths via the single gateway chokepoint. Free loop has no storyline source (no workflow) — fields stay `undefined`, no duplication possible. Storyline is authoring content, plumbed through `RunPhaseInput` — NOT persisted in `TaskStateSnapshot` (avoids duplicating long narrative strings in every checkpoint).
- **System prompt = cacheable prefix, time = user message.** `systemPrompt` is baked into the system message at reasoner creation time (per-agent, cached instance). Time/varying content (current timestamp, prior messages with relative time) goes in the user message only — never the system message — to preserve the prompt cache prefix. `buildMessages` exported for direct testing. `getMessages` called directly (not safeTry-wrapped) because it returns `Result` and never throws — matches existing `getMessagesByReceiver` pattern.

---

## Tools Feature (2026-07-01)

### Decision: Tools as a separate concept from Actions
- Tools are reusable, stateless utilities (web search, math). Actions are business logic.
- Tools have no prerequisites, no risk, no state impact.
- Registered globally at engine level, always visible to the model.

### Decision: Progressive disclosure for tools, full disclosure for actions
- Tools: model sees menu (names + descriptions). Schemas fetched on demand via system:get_tool_schema.
- Actions: model sees full description + JSON schema in context by default.
- Rationale: tools are reusable across contexts, so keeping the menu small matters. Actions are task-specific, so the model needs full info to execute correctly.

### Decision: system: prefix for internal tools
- Reserved for framework-provided tools: system:use_tool, system:get_tool_schema, system:get_tool_history, system:get_tool_history_entry.
- User tools cannot use this prefix (validated at registration time).

### Decision: Tool history in TaskStateSnapshot
- Every tool call logged with full context (agent, phase, timestamp, input, output, token count).
- Truncated by default (500 chars). Full results retrievable via system:get_tool_history_entry.
- Persisted in checkpoints for audit and provenance.

### Decision: Loop detection per scheduler run
- Fresh detector per runScheduler call. Tracks cooldown, max calls, budget per agent.
- Humanized messages to model on block. Full context logged for audit.

### Tradeoffs accepted
- lastToolInfoResult persists across turns until overwritten (could become stale, but not harmful)
- Token count uses 4-chars-per-token heuristic (not exact, but sufficient for budget tracking)
- Tool-info queries cost a scheduler step (no re-prompting optimization yet)

---

## Logger, Diagnostics, Cache, Cleanup (2026-07-01)

### Decision: pino-based per-engine logger (replaces global sink)
- Old `configureLogger`/`createLogger`/`consoleLogSink` global pattern replaced entirely. No backward compat (not released).
- `createEngineLogger(config?: LoggerConfig): Logger` — pino always under the hood. Created once at `createDeltaEngine` time, threaded via DI (closure + params). No globals.
- `mode: "dev"` (default) → pino-pretty colorized console. `mode: "prod"` → configured drain (file/sqlite/custom). Default drain follows mode.
- `Logger.child(module)` wraps pino's child logger — auto-injects `module` into every entry. Replaces old `createLogger(module)`.
- Drains: console (dev pretty / prod JSON), file (`.delta-logs/YYYY-MM-DD.log`, append-only, daily rotation), sqlite (`delta-logs.sqlite`, separate from task store, queryable), custom (`(entry) => void`).
- Log drain failures NEVER throw — each drain swallows its own errors. A logger that destabilizes the system it audits is worse than a missing entry.
- pino-pretty used as a Transform stream (not worker-thread transport) — simpler, no thread overhead.
- Files: `src/shared/logger.ts` (factory), `src/shared/logger-types.ts` (types), `src/ports/log-sqlite.ts` (sqlite drain).

### Decision: Diagnostics as structured log events, filtered by module toggle
- Diagnostics feed into the pino logger as structured events at `debug`/`trace` level. One unified pipe — no parallel telemetry subsystem.
- `DiagnosticsConfig` — per-module boolean toggles (actions, workflows, governance, supervision, memory, comms, tools, engine). All default false (opt-in).
- `createDiagnostics(config, logger): Diagnostics` — `for(module)` returns a `DiagnosticEmitter`. Disabled module = shared no-op emitter (zero overhead, no allocation). Enabled module = emits to child logger.
- `DiagnosticEmitter`: `event(name, ctx)`, `trace(name, ctx)`, `time(name, fn)`, `timeAsync(name, fn)`. `time`/`timeAsync` return fn's result even when disabled.
- PoC instrumentation: `engine` module (scheduler step-start/end events), `actions` module (gateway action-start/end with timing). Threading is via optional params on `RunPhaseInput`/`RunWorkflowInput`/`GatewayInput` to avoid breaking existing test fixtures.
- File: `src/shared/diagnostics.ts`.

### Decision: LRU+TTL read-through cache over StoragePort
- `createCachedStore(inner, config): { store, cache }` — wraps any `StoragePort` transparently. Same interface, no engine-side changes.
- Caches hot-path reads only: `getTask`, `getLatestCheckpoint`, `getMemoriesByAgent`. Writes invalidate/update cache. Pass-through for all other methods.
- Negative caching: `Err` results (e.g. "task not found") are cached too — absence is a stable fact. Only `Ok` results from `saveTask` update the cache; `Err` from save does not poison.
- LRU eviction: `maxEntries` cap (default 1000). O(n) scan for oldest `lastAccess` — fine at this scale. No linked-list complexity.
- TTL: sliding window (default 5 min). Access (get OR set) refreshes `lastAccess` + `expiresAt`. Expired entries removed lazily on access + swept by `evictExpired()`.
- Eviction = memory only. DB retains data. Re-load from DB on next access starts fresh tracking.
- `Cache<K,V>` exposed on the `CachedStoreHandle` so cleanup (Phase 4) can call `evictExpired()` directly.
- Memory cache invalidation: `saveMemory` invalidates ALL slices for that agent (any limit-based query could now return different top-N).
- Files: `src/shared/cache.ts`, `src/ports/cached-store.ts`.

### Decision: Opportunistic + manual cleanup
- **Opportunistic** (always-on, cheap): `opportunisticCleanup(cache)` = `cache.evictExpired()`. Synchronous, no store I/O. Piggybacked at the start of `send` and `inspect`.
- **Manual** (`delta.cleanup(options?)`): heavier, potentially destructive. `runCleanup({ store, cache, options, logger })`.
  - `taskRetentionMs` → prunes completed/failed/aborted tasks older than threshold. Uses optional `store.getTasksOlderThan(statuses, olderThan)`.
  - `messageRetentionMs` → prunes consumed messages older than threshold. Uses optional `store.getTaskIds()` + `store.deleteMessages(taskId, olderThan)`.
  - `evictCache` (default true) → evicts expired cache entries.
  - Destructive store operations are opt-in: omit retention = skip. Missing optional store methods = skip with warning, no throw.
- Optional store methods added: `deleteTask?`, `deleteMessages?`, `getTasksOlderThan?`, `getTaskIds?`. All optional so existing adapters don't break. Both in-memory + drizzle adapters implement them.
- **Bug found + fixed during QA**: cached-store wrapper initially didn't forward `getTasksOlderThan`/`getTaskIds` from inner store, silently disabling task/message pruning end-to-end. Fix: wrapper forwards ALL optional cleanup methods via spread-conditional.
- File: `src/engine/cleanup.ts`.

### Tradeoffs accepted
- Cache uses single `Map` + O(n) eviction scan (not linked-list O(1)) — fine for max 1000 entries.
- Diagnostics `LogContext` cast at the diagnostics→logger boundary: diagnostics carries extras (`durationMs`, `kind`) not in `LogContext`. Cast is sound at runtime (pino accepts any payload), localized to one file.
- `deleteTask` in in-memory store cascades (checkpoints, messages, escalations, executions) but drizzle-store cascade is explicit per-table deletes. Both match their adapter's idiom.
- Opportunistic cleanup runs on every `send`/`inspect` — `cache.evictExpired()` is O(n) over cache size. Acceptable: cache is bounded by `maxEntries`.

---

## Agent Commit Feature (2026-07-01)

### Decision: Commit as a new entity (not Memory or Checkpoint reuse)
- `Commit` is a first-class entity with its own table, types, and StoragePort methods.
- Not a special kind of Memory — commits carry workflow context (workflowName, checkpointId) that memories don't.
- Not a Checkpoint — checkpoints are internal engine state (TaskStateSnapshot), commits are agent-facing records with optional notes.
- Linked to the latest checkpoint via `checkpointId` for traceability.

### Decision: Commit step = post-workflow constrained reasoner turn
- After a workflow completes, the engine enters `runCommitStep()`: a single reasoner call with `commitMode` flag.
- `commitMode` disables all tool definitions except `finish_task`. The model can only choose to commit (with notes) or fail.
- Notes extracted from `kind: "done"` with `reason` — no new ReasonerDecision kind needed.
- Auto-commits with empty notes if the model exhausts retries (prevents indefinite blocking).

### Decision: Hard block via existing `pendingCommit` status
- `send()` checks agent's latest task status. If `pendingCommit`, the new task is rejected.
- `resumeTask` accepts `pendingCommit` status and re-enters the commit step (must check before workflow branch, since a pendingCommit task has its workflow set).
- Simple, leverages existing status flow. No separate lock mechanism needed.

### Decision: commitContext as separate ReasonerInput field (not merged into context)
- `commitContext` is a distinct field on `ReasonerInput`, alongside `context` (memory + mentions).
- Rendered as a separate `"Recent commits:"` section in the user message, after `"Context:"`.
- Gives the model a clear signal about its past work, distinct from contextual memory.
- `formatCommitContext()` transforms `Commit[]` → bullet list: `- [workflowName] notes (about 2 minutes ago)`. Humanized relative time via `date-fns/formatDistanceToNow`.

### Decision: Best-effort commit injection
- Commit fetch in `stepTask` is best-effort — store error or empty result silently yields no commit context.
- Same pattern as memory retrieval (`retrieveContext`). The step must proceed regardless.

### Decision: Threading `commitContextLimit` through the full call chain
- `DeltaEngineConfig.commitContextLimit` (default 10) → `createDeltaEngine` → `send()`/`resume()` → `runSendLoop` → `runScheduler` → `stepTask`.
- Configurable per engine instance. Default 10 means the model sees the last 10 commits by default.
- Also threaded through `resumeTask` → `runSendLoop` for the resume path.

### Decision: `system:search_commits` as a new `ReasonerDecision` kind (not `tool-info`)
- Unlike schema/history/entry lookups (which read from `ReasonerInput`), commit search needs access to the store — only the scheduler has it. So `search-commits` gets its own decision kind with a dedicated scheduler handler.
- Returns results via the existing `lastToolInfoResult` -> `ReasonerInput.toolInfoResult` round-trip (same pattern as `tool-info`).
- Always offered to the model regardless of tool history or available tools — no precondition.

### Decision: Free-loop `system:commit` as a voluntary, non-terminal tool
- Unlike the post-workflow commit step (`runCommitStep`), the free-loop `system:commit` does NOT change task status or end the task. The Commit is recorded and the loop continues.
- The commit is a `Commit` record with `workflowName: null` (free-loop), linked to the latest checkpoint.
- Always offered in non-commit mode. The model can call it any number of times.
- Handler follows the same `lastToolInfoResult` -> `ReasonerInput.toolInfoResult` round-trip for confirmation.
- `commitId` imported into scheduler for generating commit IDs.

### Files
- `src/shared/types.ts`: `Commit`, `CommitQuery` types, `"pendingCommit"` in `ExecutionStatus`
- `src/shared/id.ts`: `commitId()` generator
- `src/ports/storage-port.ts`: `saveCommit`, `getCommitsByAgent`, `searchCommits` methods
- `src/ports/in-memory-store.ts`, `src/ports/drizzle-store.ts`, `src/ports/cached-store.ts`: store implementations
- `src/engine/commit-step.ts`: `runCommitStep()`, `formatCommitContext()`, `buildCommitPrompt()`
- `src/engine/runtime.ts`: `runSendLoop`, `resumeTask` thread `commitContextLimit`
- `src/engine/scheduler.ts`: `stepTask` fetches + injects commit context; handles `kind: "search-commits"`
- `src/engine/create-delta-engine.ts`: `send()` + `resume()` pass config
- `src/ports/openai-reasoner.ts`: renders `commitContext` in system prompt; `system:search_commits` + `system:commit` tool defs + handlers
- `src/ports/reasoner-port.ts`: `commitMode` flag, `commitContext` field, `search-commits` + `commit` decision kinds
- `db/models/schema.ts` + `db/models/migrate.ts`: commits DDL

### Tradeoffs accepted
- `kind: "done"` with `reason` doubles as both a normal task completion and a commit acknowledgement — the reasoner must produce `reason` text even for commits. This is close to natural model behavior (models naturally summarize when asked "what did you do?"), so it's acceptable.
- `commitContext` is fetched on every step, not cached. Acceptable: commit count is bounded by `commitContextLimit` (default 10) and the query is a simple SELECT.
- Drizzle `searchCommits` builds WHERE clause dynamically with `and(...conditions)` — functional but not optimal for SQL query planning. Fine at expected scale (hundreds, not millions of commits).
- `runCommitStep`'s retry loop (agent-wrong-decision and reasoner-API-failure) both fall through to the same "exhausted retries" auto-commit — a single `send()` call always converges to `completed` and never *returns* `pendingCommit` from a handled path. The persisted `pendingCommit` status only matters for crash recovery (process dies mid-loop before finalizing); tests exercise the hard-block/resume path by seeding a task directly in `pendingCommit` state rather than triggering it via reasoner failure.

---

## slang-ts idiom conventions

**Patterns — apply everywhere, no exceptions:**
- `option(map.get(key))` / `option(arr.find(...))` / `option(arr[i])` / `option(arr.shift())` — all lookup results that may be absent go through `option()`. After `.isNone` guard, rebind: `const x = xOpt.value` so TypeScript sees the narrowed type. `option()` handles both `null` and `undefined` as `None`.
- `safeTry(async () => expr)` replaces every try/catch that should produce a Result. Catches both throws and returned Err. No raw try/catch anywhere in `src/`. For DB adapters: `const r = await safeTry(async () => db.operation()); return r.isErr ? Err(\`context: \${r.error}\`) : Ok(value)`.
- Inside a `safeTry` callback: return the raw value, never `Ok(...)` or `Err(...)`. safeTry normalizes Result returns automatically. Returning `Err(...)` inside a safeTry whose outer error prefix would double-wrap is a bug — pull the early-return Err outside.

**Exclusions — do NOT force option():**
- Drizzle patch patterns (`if (patch.x !== undefined) vals["x"] = ...`)
- Type-predicate filters (`.filter((x): x is T => x !== undefined)`) — option() cannot express the type guard.
- Arithmetic axis checks (`a.x !== undefined || b.x !== undefined`)
- Spread-conditional patterns for length checks (`...(arr.length > 0 ? {arr} : {})`)

**Spread-conditional patterns WITH undefined checks use option():**
`...(x !== undefined ? {x} : {})` -> compute `const xOpt = option(x)` before the object literal, then `...(xOpt.isSome ? { x: xOpt.value } : {})`.

---

## Overview
Delta Agents is a shipped, fully-implemented deterministic autonomous control plane for AI agents. Public surface is live in `src/index.ts`. The model reasons; the engine governs. Full specification in `docs/internal/delta-agents.spec.md`.

## Tech Stack (Authoritative — obey exactly. Never add a dep without asking.)

- **Error handling**: `Ok`/`Err` from `slang-ts`. No throw unless it halts the system. No raw try/catch — use `safeTry`.
- **Null/undefined**: `option()` from `slang-ts`. Both `null` and `undefined` become `None`.
- **Database**: Drizzle ORM + libsql (SQLite). `createDrizzleStore` in `src/ports/drizzle-store.ts`. `createInMemoryStore` for tests. Schema in `src/ports/schema.ts`.
- **Validation**: Zod for action input schemas.
- **Model APIs**: OpenAI (`src/ports/openai-reasoner.ts`). `createMockReasoner` for tests.
- **Shape**: No server. Ships as an npm SDK — `import { createDeltaEngine } from "delta-agents"`.
- **Package manager**: pnpm. **Runtime**: Node.js. **Bundler**: tsup (esbuild).
- **Dates**: `date-fns` + `date-fns-tz`.

## Quality Bar (Authoritative — correctness is non-negotiable)
- No logical flaws. Every governance decision must be provably correct.
- Every core mechanism tested (unit + integration). Tests are self-contained, never skipped, never faked.
- No `any`, no `unknown`. `type` over `interface`, no `enum`. Explicit return types on public functions.
- JSDoc on all public APIs (explain WHY, not what).
- Provenance auditable — every event attributable to a TaskID.

---

## Architecture Overview

**Two-tier API:**
- **Authoring API** (developer): `Action`, `Workflow`, `Phase`, `Agent`, `DataSource`, `Channel`, `Skill`
- **Runtime API** (delta owns): `Task`, `TaskTree`, `Execution`, `Checkpoint`, `ApprovalRequest`, `RiskState`, `TrustState`, `Message`, `Queue`, `Memory`, `SupervisionPolicy`

**Governance model:** State-space (Markov legality) + Bellman action value + MPC preventive budget + Kalman health + cost friction + Bayesian updating/surprise + asymmetric reputation decay.

**Task hierarchy:** Master Task (owns budget/risk/trust/audit/checkpoints) -> Subtasks (scoped permissions/budgets; max 2 active, FIFO queue).

**Workflow hierarchy:** Action -> Task -> Workflow/SOP -> Multi-Phase Workflow.

**Supervision strategies:** retry (from failedIndex), restart (phase entry), resume (from checkpoint), escalate, abort-subtree, abort-entire-tree.

## Key Types

**Authoring:** `Action` (name, description, schema, risk 1-5?, estimatedCost?, requiresApproval?, prerequisites?, hooks?, fn, skills?), `Workflow` (name, description, version, phases, estimatedCost?), `Phase` (name, description, actions, checkpoint, supervision?, skills?), `Agent` (name, description, role, rolePrompt, model?, actions, workflows?, skills?, channels?, team?), `Skill` (name, description, folder), `Channel`

**Runtime:** `Task` (id, rootId, parentId?, status, goal, assignedAgent, workflow?, currentPhase?, budget, risk, trust, createdAt, updatedAt), `TaskTree` (rootTaskId, activeChildren, queuedChildren, maxConcurrency:2), `Execution`, `Checkpoint`, `ApprovalRequest`, `RiskState`, `TrustState`, `Message`, `Queue`, `Memory`, `SupervisionPolicy`

**Cost:** multi-axis vector `{ tokens, durationMs, memory?, latency? }`.

## DX Pattern

Factory functions everywhere, no classes. `createDeltaEngine({...})` returns one plain object — the entire surface. Authoring: `delta.action()`, `delta.workflow()`, `delta.agent()`. Runtime: `delta.deploy()`, `delta.send()`, `delta.approve()`, `delta.pause()`, `delta.resume()`, `delta.inspect()`. Developer never creates Task, Checkpoint, TrustState, or TaskTree. Delta owns the runtime.

Phases are plain objects in `delta.workflow({ phases: [...] })` — no `delta.phase()`. Models declared on engine (`models: ModelDef[]`), agents reference by name (`agent.model`). `createOpenAIReasoner` is internal; pass `createMockReasoner(...)` in tests.

Skills: `agent.skills?: Skill[]`. `phase.skills` and `action.skills` accept `(string | Skill)[]`. Engine reads `SKILL.md` from `folder` internally — no consumer-side `loadSkill`. String refs validated at `delta.agent()` time.

## Dependencies (all installed)

Key: `slang-ts` (bundled into dist), `zod`, `@libsql/client` + `drizzle-orm`, `openai`, `nanoid`, `ms`, `date-fns` + `date-fns-tz`. See `package.json` for versions.

## Build & Test
- **Test runner**: `pnpm test` -> `vitest run`. Do NOT use `bun test`.
- **Typecheck**: `tsc --noEmit`
- **Build**: `pnpm build` -> `vitest run && tsc --noEmit && tsup`
- **Config**: `tsconfig.json` (strict, ESNext, bundler resolution), `tsup.config.ts` (ESM output, slang-ts bundled), `vitest.config.ts` (environment: node)
- **DB tests**: real libsql file store in temp dirs, cleaned up in afterEach.

## Boundaries (DO NOT CROSS)
- Servers: never start without asking
- DB: all db commands/decisions -> ask first
- Git: ask before any git command
- .env: never read/edit
- Installs/stack changes: never without permission

## Files to Reference
- `docs/internal/delta-agents.spec.md` — THE spec, canonical blueprint
- `AGENTS.md` — coding rules for the whole team
- `docs/internal/COPYWRITING.md` — user-facing copy rules
- `context.md` — THIS FILE. Updated at task end with learnings, patterns, tradeoffs. Keep it accurate: wrong context is worse than no context.
