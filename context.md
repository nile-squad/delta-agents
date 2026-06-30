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

## Current State (as of 2026-06-22)

All packages A–J are implemented and tested (~690 tests pass). Public surface at `src/index.ts`. `dist/` loads under plain Node. Full spec in `docs/internal/delta-agents.spec.md`.

All H-series subsystems are wired into the live path. Remaining work is catalogued below, not whole subsystems.

### What's implemented
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
All 8 entities have working store methods in both adapters (in-memory + Drizzle). No remaining work needs new DB schema. New persisted state rides inside `TaskStateSnapshot` JsonRecord.

---

## Critical Decisions

- **Build: Bun -> tsup (esbuild) on Node.** Ships as a library into Node backends; must not require Bun. Extensionless barrel imports + ESM-only deps forced a Node-native bundler. tsup over raw esbuild for `.d.ts` emit.
- **slang-ts bundled (`noExternal`), not external.** `export * from "slang-ts"` requires build-time resolution; esbuild drops star re-exports of externals. Bundled Result works structurally (no `instanceof`), so consumer's own slang-ts interoperates.
- **Delegation trigger = `ReasonerDecision` kind, not magic action.** Keeps gateway as a pure action-execution chokepoint.
- **Queue entity = spec-aligned but engine-unused.** Engine FIFO via `TaskTree.queuedChildren` + `Message`s avoids redundant parallel queue subsystem.
- **Storyline injection = ActionContext only, not reasoner context.** Workflows are reasoner-less (deterministic execution), so injecting storyline into the reasoner would be dead weight in workflow mode. ActionContext reaches action fns + hooks in both paths via the single gateway chokepoint. Free loop has no storyline source (no workflow) — fields stay `undefined`, no duplication possible. Storyline is authoring content, plumbed through `RunPhaseInput` — NOT persisted in `TaskStateSnapshot` (avoids duplicating long narrative strings in every checkpoint).
- **System prompt = cacheable prefix, time = user message.** `systemPrompt` is baked into the system message at reasoner creation time (per-agent, cached instance). Time/varying content (current timestamp, prior messages with relative time) goes in the user message only — never the system message — to preserve the prompt cache prefix. `buildMessages` exported for direct testing. `getMessages` called directly (not safeTry-wrapped) because it returns `Result` and never throws — matches existing `getMessagesByReceiver` pattern.

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
