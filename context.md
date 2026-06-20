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
- **H1 [FIXED 2026-06-20 — Package C] Supervision now enforced at phase granularity.**
  `run-workflow.ts` `runPhaseSupervised` wraps each phase: a failed phase with a declared
  `supervision` policy applies `applyStrategy({policy, retryCount:0})` deterministically
  (prohibition 10): retry/restart/resume re-run the phase up to `maxRetries` via `retryWithJitter`
  (AGENTS.md: never raw sleep+backoff; baseDelayMs:5, maxDelayMs:50); escalate → `raiseEscalation`
  (trigger `workflow-failure`) + pause + `blocked`; abort-* → `abortTask` + failed; give-up →
  failed. Recovery boundary is the phase (re-run whole phase), not per-action — matches spec
  §Supervision Model. Tests: engine.spec "workflow supervision recovers or surfaces failure (H1)"
  (retry-exhausted→failed, escalate→blocked+workflow-failure escalation).
- **H2 [FIXED 2026-06-20 — Package C] Workflows/phases/branching now drive execution (C-a model).**
  `SendInput` gained `workflow?` + `input?`; a task with an assigned workflow runs deterministically
  (reasoner-less) via `runWorkflowTask` (engine/runtime.ts) → `runWorkflow`; a workflow-less task
  still uses the free reasoner loop (C-a coexistence). `runWorkflowTask` validates the agent
  declares the workflow, builds the action registry from `agent.actions`, pre-flights approvals
  for the whole workflow (any unapproved requiresApproval action → block + auto-request, mirrors
  the loop's per-action gate), feeds a single shared `input` bag to every action via `inputFor`,
  and maps WorkflowResult→SendResult (completed/blocked/failed). `create-delta-engine.ts` branches
  on `workflow !== undefined`; `Task.workflow` is set. **Key H1/H3 reconciliation (design):** in
  `run-phase.ts`, post-step governance is split by outcome — a *successful* step runs full
  post-step governance (escalate on drift, shared with the free loop) but a *failed* step only
  persists trust/risk and routes to supervision. Escalating on failure from post-step would
  pre-empt the supervision policy (H1) and the branch `onFailure` route, and was timing-flaky
  (cold-start optimism 1.0 vs observed 0.0 → surprise 1.0 only when durationMs rounds ≥1ms).
  Tests: engine.spec "workflow tasks run deterministically (H2)" (phase order, branch routing,
  undeclared-workflow→failed) + "workflow approval pre-flight (C-a)".
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
- **H4 [FIXED 2026-06-20 — Package D] Delegation drives a bounded supervision tree.**
  New `ReasonerDecision` kind `"delegate"` (`{ goal, agentName, budget? }`) — the reasoner signals
  delegation explicitly (NOT a magic action through the gateway). The send loop was refactored into
  a step-able loop + a deterministic round-robin scheduler (`src/engine/scheduler.ts`): `stepTask`
  advances one task one reasoner→gateway step; `runScheduler` advances every runnable task once per
  pass ("spawn + poll later" — a delegation registers a child and returns, parent keeps stepping;
  up to two children run interleaved). `runSendLoop` is now a thin wrapper building the root runner.
  Boundedness is structural: `requestSlot` caps active children at 2 (inv 15), extras queue FIFO and
  `releaseSlot`-promote on a slot free (inv 16), `enforceSubtaskScope` clamps child budget to parent
  remaining (inv 18), child snapshot carries `parentBudget`/`parentSpent` (legality guard now live),
  root failure/block cascades `abortEntireTree` (inv 17). Child `spent` folds back into parent on
  settle. Tests: engine.spec "delegation drives a bounded supervision tree (H4)" (parentId+rootId,
  budget clamp, 3rd delegation queues+promotes, unknown-agent→parent fails).
  **Audit-round-2 fixes (2026-06-20):** D1 — the scheduler now aggregates the subtree outcome into
  the root result and root task record: a delegated child that settled failed→root failed, blocked→
  root blocked (was: parent reported `completed` while a child was blocked/failed; free-loop
  delegation had no failure handling). Tests: H4 "delegated subtask that fails surfaces parent as
  failed (D1)" + "blocked on approval surfaces parent as blocked (D1)". D2 — a child's
  `parentBudget`/`parentSpent` is refreshed from the parent's *live* spend each pass (invariant 18
  now enforced under interleaving, not a stale delegation-time copy), and a subtask starved by an
  exhausted parent budget settles failed, not completed. D4 — `drainMessages` now checkpoints the
  `consumedMessages` snapshot so the caller-message drain is idempotent across resume (test asserts
  the latest checkpoint carries the consumed id).
  **H4-remaining (deferred):** OpenAI adapter has no `delegate` tool yet (needs an `availableAgents`
  contract on `ReasonerInput` to constrain targets — small follow-up; mock fully exercises it); child
  budget is folded on settle, not *reserved* at delegation (two live children could momentarily each
  see full parent remaining — bounded by max-2); a pure-supervisor agent with zero actions hits the
  discovery gate (available=0 → natural-done) before it can delegate, so a supervisor needs ≥1 action
  today; resume does not reload mid-flight children from an existing tree.
  **D3 — OPEN, awaiting owner ruling:** delegation can create multiple concurrent active tasks for
  the *same* agent (the binary tree bounds to 2 active subtasks but does not require distinct
  agents), which a strict reading of invariant 26 / prohibition 21 ("no new task for an agent that
  already has an active or queued task") forbids — but those are framed around `delta.send`. Need a
  decision: is inv 26 `send`-only (delegation exempt), or tree-wide (delegation must also enforce
  one-active-task-per-agent)? `handleDelegate` currently does NOT enforce it.
- **H5a [FIXED 2026-06-19 — Package B] Busy-agent `send` now queues instead of rejecting.**
  Per spec §No New Task When Work Is Pending: when an agent already has a running/pending task,
  `send` saves a `Message` (sender:"caller", payload:goal) attributable to the existing task
  (invariant 9) and returns `Ok({ status:"queued", taskId: existingId, ... })` — no second task
  (invariant 26 / prohibition 21). Return-shape decision: added `"queued"` to `SendResult.status`
  (means "attached to existing task," distinct from the existing task's own lifecycle status).
  `create-delta-engine.ts` send busy-branch. Test: engine.spec invariant-26 "queues the inbound
  goal onto the existing task". NOTE: messages are persisted+attributable but NOT yet consumed —
  nothing drains the queue when the agent frees up; the reasoner doesn't see queued messages.
  That consumption/drain path is **H5b**, deferred with H4 (supervisor/agent comms).
- **H5b [PARTIAL 2026-06-20 — Package D] Queued caller messages are now drained.** When a runner
  reaches natural-done, `drainMessages` folds any unconsumed `sender:"caller"` Messages into the
  task goal (`[queued] ...`) and keeps the task running to handle them; consumed ids persist on the
  snapshot (`TaskStateSnapshot.consumedMessages`) so the drain is idempotent across pause/resume
  (inv 9). The subtask queue drains via `releaseSlot` promotion (see H4). Test: engine.spec "queued
  caller messages are drained into the task (H5b)". **Still deferred:** the `Channel` authoring type
  (whatsapp/email/etc.) is unused — outbound agent↔supervisor comms over real channels is unbuilt;
  the `Queue` entity (`saveQueue`/`getQueue`) is still unused (the FIFO bookkeeping lives in
  `TaskTree.queuedChildren` + Messages, not the `Queue` type).

Storage note: all 8 entities already have working store methods in BOTH adapters (in-memory +
Drizzle), so no remaining H-item needs new DB schema. New persisted state (H1 retry counters,
done) rides inside the checkpoint `TaskStateSnapshot` JsonRecord.

H-series sequence (scoped): A=H3 [DONE de8b1d0], B=H5a [DONE e94124b], C=H2+H1 [DONE 1b4fc15 — C-a
coexistence: task-assigned workflow runs deterministically/reasoner-less; workflow-less task uses
the free loop], D=H4+H5b [DONE — owner chose: trigger=new `ReasonerDecision` kind `"delegate"`;
concurrency=spawn+poll-later interleaving scheduler (`src/engine/scheduler.ts`); drain=both subtask
promotion + caller-message consumption]. **All H-series items now wired.** Remaining work is the
deferrals catalogued under each H-item above (OpenAI delegate tool, Channel comms, budget
reservation, per-action reasoner inputs, value.ts Bellman/MPC, isTrustDegraded, surprise→trust).
C reconciliation (DONE): shared `applyPostStepGovernance` helper
(`src/oversight/post-step.ts`) gives BOTH the free loop and the workflow path identical escalation
+ trust/risk persistence; placed in oversight to avoid an engine↔workflow import cycle.
**C-remaining (deferred):** per-action reasoner-filled inputs (only a single shared `input` bag
today); workflow approval round-trip resume (a blocked-on-approval workflow re-runs from the start
on resume — no mid-workflow checkpoint resume yet); workflow pause/resume correctness. Commits so
far: a7c86dd (critical C1-C4), de8b1d0 (Package A/H3), e94124b (Package B/H5a), Package C pending
commit.

**Medium:** M1 `pauseTask` lacks terminal-status guard (can resurrect completed task).
M2 `resumeTask` accepts `"pending"` but error says `(expected "paused")`. M3 duration budget
excludes reasoner latency (only `fn()` timed). M4 `ReasonerInput.context` (retrieved memory)
never populated — spec principle 4 unimplemented.

**Low/DX:** L1 `deploy` is a no-op assertion. L2 gateway writes execution row twice/action.
L3 task+checkpoint persisted every step (2 writes/step). L4 lingering `Record<string,unknown>`/
`as unknown as` casts vs. the "no unknown" rule. L5 OpenAI adapter pins `max_tokens`/`temperature`
(newer gpt-5.x models prefer `max_completion_tokens`, ignore temperature).

Critical set C1–C4 + Packages A/B/C/D DONE — all H-series subsystems are now wired into the live
path (572 tests pass under vitest; bun shows same 4 pre-existing `vi.runAllTimersAsync` timer
failures only). Remaining work is the per-H-item deferrals catalogued above, not whole subsystems.

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
