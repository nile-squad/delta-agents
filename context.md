# Project Context: delta-agents

## Audit (2026-06-19) — live-path vs. spec

Phases 0–10 built a sound, individually-tested library of governance primitives, but
the live execution path (`createDeltaEngine` → `runSendLoop` → `runGateway`) only wires
in a fraction of them. Two layers that don't meet. Findings, by severity:

**Critical (FIXED 2026-06-19 — `status:"completed"` is now trustworthy):**
- **C1 [FIXED] — escalated task was marked `completed`.** Escalation now stops the loop:
  persists `status:"paused"` + escalation record, returns `SendResult.status:"blocked"`.
  `runtime.ts` escalation block. Test: engine.spec "C1 ... escalates and blocks".
- **C2 [FIXED] — reasoner failure was marked `completed`.** `ReasonerPort.reason` now returns
  `ReasonerDecision = {kind:"act",request} | {kind:"done",reason?}`. `Ok(done)`→completed,
  `Ok(act)`→run, `Err`→**failed**. Mock: exhausted script→`done` (not Err); `alwaysFail`→Err.
  OpenAI: added `finish_task` tool alongside `request_action`. Test: "C2 ... marks failed".
- **C3 [FIXED] — empty discovery = "done" even when budget-exhausted.** Loop-end now checks
  `isOverBudget` → `failed` ("budget exhausted") as a backstop for the resume-already-over-budget
  case (mid-loop over-budget is caught first by escalation budget-violation → blocked). Test:
  "C3 ... resuming over budget fails".
- **C4 [FIXED] — token cost hard-coded 0.** `ActionRequest.reasoningCost` carries model tokens;
  OpenAI adapter reads `response.usage.total_tokens`; gateway folds into execution cost +
  snapshot spent → token budget enforcement is real. Test: "C4 ... token cost is recorded".
  Note: a `done`-turn's own model tokens are still unaccounted (no execution to attach to) — minor leak.

**High (subsystems built+tested, never called by live path — confirmed by import trace):**
- **H1** Supervision unenforced: `applyStrategy`/`task-tree`/`abortEntireTree`/`retryWithJitter`
  have no live callers. Gateway error → plain `status:"failed"`. Prohibition 10 not applied.
- **H2** Workflows/phases/branching never drive execution: `run-workflow`/`run-phase`/`resolve-next`
  uncalled. Loop is pure reasoner-picks-action. Invariants 7, 21 unexercised.
- **H3 [FIXED 2026-06-19 — Package A] Governance math wired into the live loop.** New pure
  module `src/governance/step-signals.ts` (`assembleStepSignals`) composes friction + Kalman
  health + Bayesian surprise; gateway feeds the result to `updateRisk` (was hardcoded zeros) and
  returns `surpriseMagnitude`; runtime forwards it to `checkEscalation`. `TaskStateSnapshot`
  gained `kalman?: KalmanState` (persists in checkpoints, survives pause/resume). Progress proxy
  for the hornless free loop = `completedActions / (stepIndex+1)`. The `bayesian-surprise`
  escalation branch is now reachable (integration test proves it fires). Still dormant from H3's
  original list: `value.ts` (Bellman/MPC `projectHorizon`, `computeActionValue`) and
  `isTrustDegraded` — not yet wired; surprise→trust ("surprise" TrustUpdateOutcome) also not yet
  used (gateway still success/failure only). Tests: engine.spec "governance math drives the live
  loop (H3)" + `tests/unit/governance/step-signals.spec.ts` (8 unit).
- **H4** Delegation/subtasks absent: nothing sets `parentId` or touches `TaskTree`;
  `parentBudget`/`parentSpent` never populated so parent-budget legality guard is dead.
- **H5** Messages/queues unbuilt: no `saveMessage` in engine; busy-agent `send` returns `Err`
  instead of queueing (spec §No New Task When Work Is Pending). H5a (busy-agent queueing) is the
  small self-contained Package B; H5b (supervisor/agent comms) rides with H4.

Storage note: all 8 entities already have working store methods in BOTH adapters (in-memory +
Drizzle), so no remaining H-item needs new DB schema. New persisted state (H1 retry counters,
done) rides inside the checkpoint `TaskStateSnapshot` JsonRecord.

H-series sequence (scoped): A=H3 [DONE], B=H5a [next, small], C=H2+H1 [needs coexistence
decision: C-a/C-b/C-c], D=H4+H5b [needs delegation-trigger + concurrency decision].

**Medium:** M1 `pauseTask` lacks terminal-status guard (can resurrect completed task).
M2 `resumeTask` accepts `"pending"` but error says `(expected "paused")`. M3 duration budget
excludes reasoner latency (only `fn()` timed). M4 `ReasonerInput.context` (retrieved memory)
never populated — spec principle 4 unimplemented.

**Low/DX:** L1 `deploy` is a no-op assertion. L2 gateway writes execution row twice/action.
L3 task+checkpoint persisted every step (2 writes/step). L4 lingering `Record<string,unknown>`/
`as unknown as` casts vs. the "no unknown" rule. L5 OpenAI adapter pins `max_tokens`/`temperature`
(newer gpt-5.x models prefer `max_completion_tokens`, ignore temperature).

Critical set C1–C4 DONE (552 tests pass under vitest; bun shows same 4 pre-existing
`vi.runAllTimersAsync` timer failures only). Files touched: `ports/reasoner-port.ts`,
`ports/mock-reasoner.ts`, `ports/openai-reasoner.ts`, `execution/types.ts`,
`execution/execution-gateway.ts`, `engine/runtime.ts`, + tests in `engine.spec.ts` and
`openai-reasoner.spec.ts`. H-series (unwired supervision/workflow/governance-math/delegation/
messaging) is phase-sized, still pending, scoped separately.

## Overview
Delta Agents is a deterministic autonomous control plane for AI agents. It provides the execution layer that constrains, validates, supervises, and audits agent behavior. The model reasons; the engine governs. The full specification is in `delta-agents.spec.md` (1185 lines) — that is the canonical blueprint for implementation.

## Tech Stack (Authoritative, obey every session)

These are the owner's stated decisions. Follow them as written. When you find yourself thinking "I'm sure there's a library for this" or "we'd rather use a library here", stop and ask the owner first. He probably already knows what we should use. Do not add any dependency, especially dev deps, without asking first.

- **Error handling**: Every function returns an `Ok` or `Err` from `slang-ts`. Every caller checks for the error and forwards it. We do not throw unless it is critical and worth halting the entire system.
- **Logging**: We can have a central logging utility.
- **Database**: We use Drizzle ORM and SQLite for the database, for keeping memory and anything we need a database for. Keep things simple. All database code strictly lives in the `db/models` folder. We interact with the database only through Drizzle ORM.
- **Execution model**: We introduce isolated execution later and true actor models later. For now we do it by just having a simple utility with abort and promise ergonomics.
- **Validation**: We use Zod for validation schemas.
- **Model APIs**: We use OpenAI for interacting with model APIs.
- **Shape**: We do not have a server. This library fits into the developer's backend code, just like one would install an SDK.
- **Package manager and runtime**: We use pnpm for package management but Bun for the runtime.
- **Dependencies**: Only add other dev dependencies after asking the owner. For anything where we would rather use a library, ask the owner first.
- **Dates and time**: Use `date-fns` and `date-fns-tz` for handling timezones and time.

Note: Drizzle, OpenAI, and date-fns/date-fns-tz are not installed yet. Ask before installing.

## Quality Bar (Authoritative, obey every session)

This is critical software. Its entire reason to exist is enforcing governance, provenance, and safety. A logical flaw here is not a bug, it is a breach of the contract the whole project promises. Treat correctness as non-negotiable.

- **No logical flaws.** Every governance decision (authorization, prerequisite gating, budget/risk checks, branching, supervision, checkpointing, trust/risk updates) must be provably correct, not "looks right". Reason through edge cases and failure paths before writing code. If the foundation is wrong, no upper-layer fix holds.
- **Every core mechanism is tested.** Nothing core ships untested. The state-space transitions, Markov legality checks, prerequisite evaluation, workflow branching, Result contract, hooks, supervision strategies, checkpoint/recovery, trust/risk math, cost-friction detection, and the execution gateway each get tests. Untested core mechanism = not done.
- **Unit AND integration tests.** Unit tests for each module in isolation. Integration tests for the wired engine (`createDeltaEngine` assembling modules) proving the facade and cross-module flows behave. Both, not one.
- **Scaling and stress tests where applicable.** Pressure tests, thundering-herd / concurrent-contention tests, queue saturation, bounded-supervision limits under load, retry/jitter behavior. Anything that can be abused or raced gets a test that races it. A slight delay beats a race condition.
- **Tests are real.** Self-contained (every asserted value set up by the test itself, never read from live/persistent DB state), never skipped, never faked. Fix or delete failing tests, never paper over them. Tests assert against the spec and intent.
- **Modularity is a correctness property here.** Decoupled modules (see DX facade note below) keep blast radius small and each mechanism independently verifiable. Features should be easy to turn off or remove. Premature abstraction is still banned, but core mechanisms stay isolated and testable.
- **Type system quality.** No `any`, no `unknown`. Types model the real domain and make illegal states unrepresentable where possible. Explicit return types on public functions. `type` over `interface`, no `enum`. The compiler is a governance ally, lean on it.
- **JSDoc on all public APIs.** Explain WHY, not what. The authoring methods, the engine factory, and every runtime method carry docs. Public surface without docs is incomplete.
- **Provenance is auditable.** Every execution event, message, checkpoint, escalation, and trust/risk update is attributable to a TaskID and inspectable. If it cannot be audited, it is not finished.

Bias: when in doubt, test more and prove more. This is not demo software. Real thing or do not ship it.

## Current State
The project is a clean slate. Old @nilejs/future code (actor/concurrency library) has been archived to `/tmp/opencode/delta-agents-trash/` (moved outside project to avoid test runner scanning). The project is prepared for a fresh implementation of the delta-agents spec. Entry points (index.ts, src/index.ts) are minimal placeholders re-exporting slang-ts. A smoke test in `tests/smoke.spec.ts` verifies the slang-ts re-export works. No delta-agents source code exists yet.

## Spec Location
- `delta-agents.spec.md` — canonical specification (1185 lines). Contains: principles, decision records, mathematical governance model, task hierarchy, queueing model, workflow hierarchy, checkpointing, supervision model, human oversight, invariants, prohibitions, follow-up work, and type/implementation blueprint with DX examples.

## Architecture Overview (from spec)

**Two-tier API separation:**
- **Authoring API** (developer touches): Agent, Workflow, Phase, Action, DataSource, Channel, Skill
- **Runtime API** (Delta owns): Task, TaskTree, Execution, Checkpoint, Approval, RiskState, TrustState, Message, Queue

**Governance model:**
- State-space model: execution is movement through constrained state-space (task, workflow, budget, risk, trust, authorization, delegation states)
- Markov constraints: legality of next action determined solely by current state
- Bellman optimization: action value = immediate cost + expected future cost
- Model predictive control: receding-horizon prediction before execution
- Kalman state estimation: continuous execution health estimation
- Cost friction detection: high consumption with low advancement = instability
- Bayesian updating: trust/confidence/risk continuously updated from evidence
- Bayesian surprise: divergence between expected and observed outcomes
- Asymmetric reputation decay: trust increases slowly, decreases rapidly
- Predictive shadow racing: multiple candidates evaluated before execution

**Task hierarchy:**
- Master Task: owns budget, risk, trust, audit, checkpoints
- Subtasks: inherit governance from parent, scoped permissions/budgets/objectives
- Supervision tree: bounded — max 1 active parent + 2 active subtasks, rest queued

**Workflow hierarchy:** Action → Task → Workflow/SOP → Multi-Phase Workflow

**Supervision strategies:** retry, restart, resume from checkpoint, escalate to human, abort subtree, abort entire tree

**Queueing:** FIFO for pending tasks, subtasks, messages, escalations

**23 invariants and 20 prohibitions** defined in the spec — these are the contract.

## Key Types (from spec)

**Authoring types:** Action (name, description, schema, optional risk 1-5, optional estimatedCost, requiresApproval, prerequisites, hooks, fn returning slang Result), Workflow (name, description, version, phases, estimatedCost), Phase (name, description, actions, checkpoint, supervision), Agent (name, description, role, rolePrompt, model, contextWindow, actions, workflows, skills, channels, team), Skill, DataSource, Channel

**Runtime types:** Task (id, rootId, parentId, status, goal, assignedAgent, workflow, currentPhase, budget, risk, trust, createdAt, updatedAt), TaskTree (rootTaskId, activeChildren, queuedChildren, maxConcurrency: 2), Execution, Checkpoint, ApprovalRequest, RiskState (staticRisk, currentRisk, predictedRisk, confidence, escalated), TrustState (score, successfulExecutions, failedExecutions, surpriseEvents), Message, Queue, SupervisionPolicy

## DX Pattern (from spec)
Factory functions everywhere, no classes. The engine itself is created by a factory: `const delta = createDeltaEngine({ ... })` returns a single plain object that is the ENTIRE surface — both authoring and runtime hang off it as methods. There are NO standalone imports beyond `createDeltaEngine`. Authoring methods (define definitions): `delta.action({...})`, `delta.workflow({...})`, `delta.phase({...})`, `delta.agent({...})`. Runtime methods (drive execution): `delta.deploy(agent)`, `delta.send(taskId, message)`, `delta.approve(approvalId)`, `delta.pause(taskId)`, `delta.resume(taskId)`, `delta.inspect(taskId)`. Read as verbs. No `new`, no inheritance, no global singleton. The exact method set is not fixed; the shape is fixed (one factory returning one object whose methods are the whole surface). Developer never creates Task, Checkpoint, TrustState, or TaskTree. Delta owns the runtime.

**Single object is a DX facade, not module coupling.** Internally each capability lives in its own module (`action`, `workflow`, `phase`, `agent`, deploy, send, approve, supervision, checkpointing, etc., in their own domain folders). `createDeltaEngine` imports those separate items and assembles them onto one returned object. The unification is purely the developer-facing surface. The modules themselves stay decoupled — do NOT couple module implementations just because the DX presents one object. Each method delegates to its own module; the facade only wires them together (and shares engine config/context to them).

**Anticipated risk and cost:** An action's `risk` (1-5) and `estimatedCost` are both optional priors, not requirements and not ceilings. Delta can derive its own estimates; declared values seed the Kalman estimator with a calibrated prior (faster convergence) and carry human judgement about danger/irreversibility into the governed loop. The engine continuously refines from evidence and may raise risk above the declared level — a low declared risk never overrides observed danger. See spec section "Anticipated Risk and Cost", invariant 23, prohibition 20.

## Dependencies

See the authoritative Tech Stack section above for the rules. Summary:

Installed:
- `slang-ts` — Result, Option, match, matchAll, safeTry, pipe, atom, println, panic (re-exported from src/index.ts). Every function returns `Ok`/`Err`; callers check and forward; throw only for critical, system-halting failures.
- `zod` — schema validation for actions (every executable action has a validation schema)

Planned (ask before installing):
- `drizzle-orm` + SQLite — all database work, memory included. DB code lives strictly in `db/models`.
- `openai` — model API access.
- `date-fns` + `date-fns-tz` — all date, time, and timezone handling.

Tooling: pnpm for package management, Bun for runtime. No server; ships as an SDK-style library installed into the developer's backend. Isolated execution and true actor models come later; for now a simple abort + promise utility.

## Conventions (from AGENTS.md)
- No classes/OOP — factory functions only. `createUser()` returns plain object with methods.
- Named params: `{ name, email }` not `(name, email)`.
- Max 400 LOC/file.
- `type` over `interface`, ban `enum`.
- JSDoc for all public APIs (explain WHY not what).
- `safeTry` for error handling. No raw try/catch.
- `.filter().map()` over for loops.
- Explicit return types on public functions.
- Domain folders with barrel `index.ts`.
- kebab-case.ts filenames, verbNoun naming.
- No `any`, no `unknown`. Types in domain/types.ts.
- Delete = move to /trash, never rm.

## Build & Test
- Runtime: Bun v1.0+ (primary), Node.js (planned)
- Test runner: `bun test` (primary), `vitest run` (alternative via vitest.config.ts)
- Typecheck: `tsc --noEmit`
- Build: `bun run build` (runs test + typecheck + bun-build.ts + tsc declaration emit)
- Config: tsconfig.json (strict, ESNext, bundler resolution), tsconfig.build.json (declaration emit), bun-build.ts (Bun bundler), vitest.config.ts

## Boundaries (DO NOT CROSS)
- Servers: never start without asking user
- DB: all db commands/decisions → ask user first
- Git: ask before any git command
- .env: never read/edit
- Installs/stack changes: never without permission

## Files to Reference
- `delta-agents.spec.md` — THE spec, read it fully before implementing
- `AGENTS.md` — coding rules for the whole team
- `COPYWRITING.md` — user-facing copy rules (no em dashes, no emojis, full words)
- `documentation-guidelines.md` — how docs should be done
- `spec-guidelines.md` — what a spec is

## Documentation (docs/)

The docs/ directory is being repurposed from @nilejs/future to delta-agents. All files are currently stubs with concept outlines. The implementing agent should write full content based on delta-agents.spec.md. Previous @nilejs/future content is in git history.

| File | Status | Should cover |
|------|--------|--------------|
| `docs/architecture.md` | Stub | Governance engine, state-space model, task hierarchy, workflow hierarchy, queueing, two-tier API separation |
| `docs/supervision.md` | Stub | Supervision strategies (retry, restart, resume, escalate, abort), bounded supervision tree, checkpointing, recovery |
| `docs/diagnostics.md` | Stub | Execution health, cost friction, trust/risk metrics, Bayesian surprise, audit history |
| `docs/resources.md` | Stub | DataSource authoring type, ownership, contentType, authentication, CRUD actions |
| `docs/ADR-006-bun-only-runtime.md` | Stub | Runtime decision for delta-agents (previous ADR was Bun-only for actor isolation) |

Removed (purely @nilejs/future-specific, no delta-agents equivalent):
- `docs/shared-memory.md` — SharedArrayBuffer two-tier communication, no delta-agents equivalent
- `docs/promise-utilities.proposal.md` — Speculative proposal, no longer relevant
- `docs/context/fmt-alloc-analysis.md` — Internal @nilejs utility analysis
