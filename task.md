# Task: Implement Delta Agents

Strategic implementation plan for the engine defined in `delta-agents.spec.md`.
Read alongside `context.md` (Quality Bar, Tech Stack) and `AGENTS.md` (coding rules).

This is critical governance software. The order below is deliberate: foundations
first, each layer fully tested before the next is built on it. A wrong foundation
cannot be patched from above (AGENTS.md: "Fix the foundation first").

---

## Strategic Approach

1. **Foundation-first, bottom-up.** Pure logic (state-space, governance math)
   has no I/O and gets exhaustively unit-tested before anything stateful wraps it.
2. **Ports and adapters.** Persistence and model-reasoning are ports (interfaces)
   with an in-memory / mock adapter first. The whole engine becomes testable with
   zero external deps. Real adapters (Drizzle, OpenAI) land later as drop-in
   implementations of the same port. This satisfies "stateless governance engine"
   (spec Decision: Stateless Governance Engine) and "features easy to turn off"
   (Quality Bar).
3. **One test layer per phase.** No phase is "done" until its core mechanisms have
   unit tests, and cross-module phases add integration tests. Abusable/raceable
   mechanisms (supervision, queueing) add stress tests. Untested core = not done.
4. **Traceability to the contract.** Every invariant (1-23) and prohibition (1-20)
   maps to at least one named test. The map lives at the bottom of this file and is
   filled in as phases complete. A contract item with no test is an open hole.
5. **DX facade, decoupled internals.** Each capability is its own module. Only the
   final assembly phase wires them onto the single `delta` object. Do not couple
   module implementations because the surface is unified (context.md DX Pattern).

---

## Gated Decisions (need owner sign-off before the gated phase starts)

These are flagged, not assumed. Do not act on them without asking.

- **G1 — Persistence.** Plan uses a `StoragePort` with an in-memory adapter through
  Phase 8. The Drizzle + SQLite adapter (`db/models`) is Phase 9 and needs the
  install + DB go-ahead (AGENTS.md: DB and installs are gated). Recommendation:
  approve the port now, defer the Drizzle install until Phase 9.
- **G2 — Model reasoning.** The "Agent Reasons" pipeline step is a `ReasonerPort`
  with a deterministic mock adapter for tests. The OpenAI adapter is Phase 10 and
  needs the `openai` install. Recommendation: build governance against the mock;
  real model integration last.
- **G3 — date-fns / ids.** Need `date-fns` + `date-fns-tz` (time) and an id scheme
  for TaskID/ExecutionID. Recommendation: small internal id util (no dep) +
  date-fns when first needed. Confirm before installing.

---

## Target Module Map

Domain folders, each with a barrel `index.ts`, kebab-case files, <=400 LOC each.
Modules stay decoupled; `create-delta-engine.ts` is the only place they meet.

```
src/
  shared/            # Cost, ids, time, result helpers, shared domain types
    types.ts
    cost.ts
    id.ts
    logger.ts        # central logging utility (context.md Tech Stack)
    index.ts
  infra/
    fifo-queue.ts    # deterministic FIFO (spec: Queueing Model)
    abort-task.ts    # abort + promise ergonomics (interim execution model)
    retry-with-jitter.ts
    index.ts
  ports/
    storage-port.ts  # persistence interface (G1)
    reasoner-port.ts # model reasoning interface (G2)
    in-memory-store.ts
    mock-reasoner.ts
    index.ts
  authoring/         # delta.action / workflow / phase / agent definitions
    types.ts
    define-action.ts
    define-workflow.ts
    define-phase.ts
    define-agent.ts
    registry.ts
    index.ts
  state-space/       # bounded state, Markov legality, prerequisites, discovery
    types.ts
    task-state.ts
    check-legality.ts
    evaluate-prerequisites.ts
    discover-actions.ts
    index.ts
  governance/        # the math (pure functions)
    types.ts
    kalman-estimator.ts
    trust.ts          # Bayesian update + asymmetric decay
    risk.ts
    surprise.ts
    cost-friction.ts
    value.ts          # Bellman / MPC horizon
    index.ts
  execution/         # the single gateway
    types.ts
    execution-gateway.ts
    run-hooks.ts
    index.ts
  workflow/          # control flow over phases
    types.ts
    run-phase.ts
    resolve-branch.ts
    checkpoint.ts
    index.ts
  supervision/       # bounded tree, strategies, recovery
    types.ts
    task-tree.ts
    supervisor.ts
    strategies.ts
    recover.ts
    index.ts
  oversight/         # approvals + escalation
    types.ts
    approvals.ts
    escalation.ts
    index.ts
  engine/
    create-delta-engine.ts   # assembles the facade
    runtime.ts               # deploy/send/approve/pause/resume/inspect
    index.ts
db/
  models/            # Phase 9 only (gated)
tests/
  unit/  integration/  stress/
```

---

## Phases

### Phase 0 — Foundations and scaffolding
**Goal:** the primitives every layer needs, all pure or trivially testable.
**Build:** `shared/` (Cost type + arithmetic, id util, logger, shared types),
`infra/` (FIFO queue, abort+promise util, retry-with-jitter), `ports/`
(StoragePort + ReasonerPort interfaces, in-memory store, mock reasoner).
**Tests (unit):** FIFO order + overflow, jitter spreads retries (no thundering
herd), abort cancels in-flight, in-memory store round-trips and isolates by key.
**Exit:** primitives green; no domain logic depends on a real DB or model.

### Phase 1 — Authoring domain and registry
**Goal:** `delta.action / workflow / phase / agent` produce validated, frozen
definitions and register them. No execution yet.
**Build:** `authoring/`. Validate at definition time: schema present on every
action (inv 4/5), unique names, branch refs point to declared actions, prerequisite
refs resolvable, risk in 1-5 when present.
**Tests (unit):** valid defs accepted; missing schema rejected; duplicate name
rejected; dangling branch/prereq ref rejected; risk/cost optional and pass through
as priors unchanged.
**Covers:** inv 4, 5. **Exit:** any spec authoring example type-checks and registers.

### Phase 2 — State-space core (Markov + prerequisites)
**Goal:** bounded state and the legality function that is the spine of safety.
**Build:** `state-space/`. Task state (completed actions/workflows, budget, risk,
trust, authorization, delegation). `checkLegality` decides next-action validity
from current state only (no history replay). Prerequisite evaluation. Contextual
action discovery exposes only currently-legal actions.
**Tests (unit):** legal/illegal transitions; unsatisfied prereq hides + blocks
action; satisfied prereq exposes it; workflow-as-prerequisite; discovery never
returns an out-of-state action; legality is pure (same state -> same result).
**Stress:** large prerequisite graphs stay correct and fast.
**Covers:** inv 6, 7, 20; proh 2, 3, 16. **Exit:** no path exposes an invalid action.

### Phase 3 — Governance math (pure functions)
**Goal:** the estimators and scorers, isolated and exhaustively tested.
**Build:** `governance/`. Kalman estimator seeded by optional anticipated
risk/cost priors (faster convergence, priors never ceilings). Bayesian trust/risk
update. Asymmetric reputation decay (up slow, down fast). Cost-friction detection.
Bayesian surprise (expected vs observed divergence). Bellman value + MPC horizon
that stops at epistemic boundaries.
**Tests (unit):** estimator converges; a prior speeds convergence but observed
evidence overrides it and can raise risk above the declared level (inv 23, proh 20);
decay asymmetry holds; friction fires on high-consumption/low-progress; surprise
crosses threshold on divergence; prediction halts at an epistemic boundary
(proh 14). Property-style tests over ranges where practical.
**Covers:** inv 11, 12, 23; proh 12, 13, 14, 20. **Exit:** every estimator behaves
to spec across edge ranges; all pure, no I/O.

### Phase 4 — Execution gateway (the single chokepoint)
**Goal:** every action runs through one deterministic pipeline.
**Build:** `execution/`. Pipeline: validate schema -> risk check -> budget check
-> approval check -> execute `fn()` -> checkpoint -> trust update. Enforce the
Result contract (never infer success from a non-throw). Hooks (before/after/onError)
observe only, never authorize or bypass.
**Tests (unit + integration):** schema-invalid input blocked before fn; over-budget
blocked; requiresApproval blocked until approved; Err result updates trust as failure
(no success inference); hook cannot grant a denied capability; a hook throw does not
bypass governance; every run emits a TaskID-attributable execution record.
**Covers:** inv 1, 3, 4, 18, 19, 22; proh 1, 2, 9, 17, 18. **Exit:** no capability
reachable except through the gateway.

### Phase 5 — Workflow control flow
**Goal:** sequential + branching execution across phases with checkpoints.
**Build:** `workflow/`. Sequential-by-default phase execution; branch nodes route
on Ok / Err / declared guard; checkpoint boundaries per action/task/phase/workflow;
no invented transitions.
**Tests (unit + integration):** sequential order honored; branch routes correctly
on success, failure, and guard; engine never takes an undeclared transition;
checkpoint written at each configured boundary and is recoverable.
**Covers:** inv 10, 21; proh 19. **Exit:** spec fulfillment/branching example runs
end to end through the gateway.

### Phase 6 — Supervision and bounded task tree
**Goal:** delegation that reduces complexity without creating it.
**Build:** `supervision/`. Task tree bounded to 1 active parent + 2 active
subtasks; overflow to FIFO queue; strategies retry/restart/resume/escalate/
abort-subtree/abort-tree applied consistently for task lifetime; checkpoint recovery;
abort cascade; subtasks scoped, never exceeding parent authority.
**Tests (unit + integration):** third subtask queues until a slot frees; strategy is
stable across the task lifetime; resume restores from latest checkpoint; aborting
parent aborts all descendants; subtask cannot exceed parent scope; no execution after
terminal abort.
**Stress:** thundering-herd of subtask requests, queue saturation, concurrent slot
contention — bounds hold, FIFO order preserved, no slot over-allocation.
**Covers:** inv 14, 15, 16, 17, 18; proh 5, 6, 7, 8, 10, 11, 15. **Exit:** bounds
provably hold under load.

### Phase 7 — Human oversight (approvals + escalation)
**Goal:** every task stays eligible for intervention.
**Build:** `oversight/`. Approval requests + resolve (approve/reject). Escalation
triggers: risk threshold, Bayesian surprise, policy violation, budget violation,
workflow failure, explicit config. All escalations auditable.
**Tests (unit + integration):** requiresApproval halts until resolved; reject blocks
execution; each trigger raises an escalation; every escalation is TaskID-attributable
and inspectable.
**Covers:** inv 13. **Exit:** no escalation path is silent or unauditable.

### Phase 8 — Runtime API and engine assembly
**Goal:** `createDeltaEngine` returns the single `delta` facade; full lifecycle works.
**Build:** `engine/`. Wire every module onto one object. Authoring methods
(action/workflow/phase/agent) + runtime methods (deploy/send/approve/pause/resume/
inspect). `send` drives the full pipeline: create TaskID -> assign agent ->
reason (mock port) -> request action -> gateway -> checkpoint -> trust -> continue.
**Tests (integration + provenance):** deploy then send runs a task to completion;
pause/resume round-trips via checkpoint; inspect returns governance state; every
event/message/checkpoint/escalation traces to its TaskID (inv 1, 8, 9); modules
remain individually importable (decoupling check).
**Covers:** inv 1, 2, 8, 9. **Exit:** the README Quick Example runs against the real
engine with mock ports.

### Phase 9 — Persistence adapter (GATED, G1)
**Goal:** durable storage behind the same StoragePort.
**Build:** `db/models` with Drizzle + SQLite implementing StoragePort. No engine
logic changes — adapter swap only.
**Tests:** same port-contract suite as in-memory passes against SQLite; survives
restart (checkpoints/trust/risk persist and reload).
**Exit:** owner-approved install done; engine durable with no logic change.

### Phase 10 — Model reasoning adapter (GATED, G2)
**Goal:** real reasoning behind ReasonerPort.
**Build:** OpenAI adapter implementing ReasonerPort. Governance unchanged.
**Tests:** adapter contract; engine still bounded with a real reasoner (governance
independent of model capability, per README core idea).
**Exit:** owner-approved install done; real model governed identically to the mock.

### Phase 11 — Documentation
**Goal:** fill the doc stubs from the implemented system (not just the spec).
**Build:** `docs/architecture.md`, `supervision.md`, `diagnostics.md`,
`resources.md`, `ADR-006-bun-only-runtime.md`. JSDoc already on every public API
per Quality Bar; these docs are the narrative layer.
**Exit:** docs match shipped behavior; COPYWRITING + documentation-guidelines obeyed.

---

## Cross-Cutting (every phase, not a separate step)

- **Provenance.** Every event/message/checkpoint/escalation/trust+risk update is
  TaskID-attributable and inspectable the moment it exists (Quality Bar). Not bolted
  on at the end.
- **Result contract.** Every function returns `Ok`/`Err` from slang-ts; callers check
  and forward; throw only for critical, system-halting failures.
- **Types.** No `any`/`unknown`; illegal states unrepresentable where possible;
  explicit return types; `type` over `interface`; no `enum`.
- **JSDoc** on every public API explaining WHY.
- **Modularity.** Keep module implementations decoupled; only the engine assembly
  wires them.

---

## Contract Traceability (fill as phases complete)

Each invariant/prohibition gets at least one named test before its phase is "done".

| Phase | Invariants | Prohibitions | Status |
|------:|-----------|--------------|--------|
| 0 | (infra) | - | done |
| 1 | 4, 5 | - | done |
| 2 | 6, 7, 20 | 2, 3, 16 | done |
| 3 | 11, 12, 23 | 12, 13, 14, 20 | done |
| 4 | 1, 3, 4, 18, 19, 22 | 1, 2, 9, 17, 18 | done |
| 5 | 10, 21 | 19 | done |
| 6 | 14, 15, 16, 17, 18 | 5, 6, 7, 8, 10, 11, 15 | done |
| 7 | 13 | - | done |
| 8 | 1, 2, 8, 9 | 4 | done |
| 9 (Drizzle adapter, G1) | (port contract) | - | done |
| 10 (OpenAI adapter, G2) | (governance model-independent) | - | done |
| 11 (Documentation) | - | - | done |

All 23 invariants and 20 prohibitions show a covering test. Beyond the master
plan, refinement Packages H, I, and J shipped (supervision-strategy fidelity,
per-action workflow inputs, deploy gating, serialization centralization, public
API surface, real-DB lifecycle tests, Node/tsup build). The `abort-tree`
supervision strategy now cascades the full tree via `abortEntireTree` (it was
previously aliased to the single-task `abort-subtree`).

Known deferred items, by design, not bugs:
- Mid-workflow checkpoint resume: a workflow task resumes from the start of the
  workflow, not the failed phase. Side-effectful actions must be idempotent.
- `DataSource` authoring type: specified but not implemented. See
  `docs/resources.md` for the honest status.
- Cost friction scores only the `tokens` and `durationMs` axes; `memory` and
  `latency` are budgeted and tracked but excluded from the friction ratio.

---

## Definition of Done (per phase)

1. Core mechanisms have unit tests; cross-module phases have integration tests;
   abusable/raceable phases have stress tests.
2. Covered invariants/prohibitions each have a named, self-contained test.
3. Public APIs carry WHY-focused JSDoc.
4. `vitest run` and `tsc --noEmit` clean. (The canonical runner is vitest, not
   `bun test`. See ADR-006 for the Node/tsup build decision.)
5. Traceability table updated; learnings folded into `context.md`.
