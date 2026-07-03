# Delta Agents — Test & Benchmark Workplan

Execution plan to satisfy `tests-spec.md`. Unlike the spec, this is concrete and
disposable: it names files, steps, and acceptance criteria, and is updated as
phases complete. Each phase lists acceptance criteria that trace back to a spec
invariant (I#) or principle (P#).

Locked decisions (from the spec's Decision Records): metrics via a read-only
`engine.metrics()`; skill cost measured at first use; dimensions selected by tags
+ runner projects; benchmark gates on tolerance bands.

## Conventions

- **Dimension tag**: each suite declares its dimension via a `describe` prefix
  tag `[behaviour] | [governance] | [provenance] | [security] | [scale] |
  [packaging] | [unit]`. New dimension-specific suites live under
  `tests/<dimension>/`; existing per-module unit tests stay put and are tagged in
  place.
- **Runner projects**: `vitest.config.ts` gains projects so `pnpm test:governance`
  etc. filter by tag; `pnpm test` still runs everything.
- **DX-preview gate**: any phase that changes the public API (Phase 1) presents
  the before/after DX and gets sign-off before implementation.
- **No live network in `pnpm test`** (I4). Live-model coverage stays in the
  separate `pnpm test:e2e`.

---

## Phase 0 — Test taxonomy scaffolding

Goal: make every dimension independently runnable before adding suites.

- [ ] Add a `[dimension]` tag convention; document it here and in `context.md`.
- [ ] Configure vitest projects/filters; add `pnpm test:<dimension>` scripts to
      `package.json`.
- [ ] Tag existing suites in place (map current `tests/**` files → dimensions).
- [ ] Add a dimension→suite map table to `context.md` (not the spec — it rots).

Files: `vitest.config.ts`, `package.json`, existing `tests/**` (tag lines only).
Acceptance: **I1** (each dimension runs in isolation); `pnpm test` unchanged.

---

## Phase 1 — Diagnostics & metrics surface

Goal: aggregated, read-only startup/runtime metrics — the benchmark's data source.

- [ ] **DX preview**: present the `MetricsReport` shape + `engine.metrics()`
      signature for sign-off.
- [ ] New `src/engine/metrics.ts`: a metrics accumulator (closure-held) with a
      read projection. Zero-overhead writes; aggregation on read only (P8).
- [ ] Instrument `createDeltaEngine` startup: total, `store.ready()`, registry
      setup, custom-tool registration (count + ms), builtin-tool registration
      (count + ms, including the dynamic `import()` + peer-dep load). **Builtin vs
      custom split is required.**
- [ ] Instrument skill first-use latency in the scheduler's skill-load path
      (`buildAvailableSkills`); record per-skill into `runtime` metrics.
- [ ] Aggregate existing `diag.time` sites (reasoner latency, gateway, memory
      retrieval) into the accumulator without changing their log emission.
- [ ] Add `metrics()` to the `DeltaEngine` facade + type; export `MetricsReport`
      from `src/index.ts`.
- [ ] Unit tests (`tests/unit/engine/metrics.spec.ts`): startup populated;
      builtin/custom counts correct; reading `metrics()` does not alter task
      outcome/ordering (I5); diagnostics-disabled path emits nothing and does not
      allocate per call (I6).

Files: `src/engine/{metrics.ts (new),types.ts,create-delta-engine.ts,scheduler.ts}`,
`src/index.ts`, `src/engine/index.ts`.
Acceptance: **I5, I6**, **P8**; metrics reproducible across runs given the same
inputs.

---

## Phase 2 — Benchmark harness

Goal: a deterministic, reproducible, gated benchmark.

- [ ] `bench/` with a `pnpm bench` entry (mock reasoner, fixed inputs, pinned
      iteration counts — no network, no wall-clock in assertions) (P7).
- [ ] Scenarios: cold startup vs tool count (builtin/custom); skill first-use;
      single-task `send` throughput; delegation fan-out; cache hit/miss ratio.
- [ ] Emit `bench/results/*.json` carrying commit (`git rev-parse`), node
      version, and the reproduction command (I7).
- [ ] Commit `bench/baseline.json`; add `pnpm bench:update` to re-bless it.
- [ ] Regression guard `tests/bench/benchmark.spec.ts`: assert key metrics within
      tolerance bands vs baseline (D4).
- [ ] Document `pnpm bench` reproduction + hardware caveats in the bench README.

Files: `bench/**`, `tests/bench/benchmark.spec.ts`, `package.json`.
Acceptance: **I7**, **P7**, **D4**; `pnpm bench` reproducible; guard fails on a
seeded regression.

---

## Phase 3 — Governance (adversarial)

Goal: prove enforcement holds against a hostile/maximally-capable actor (P2).

- [ ] `tests/governance/adversarial.spec.ts` with a scripted reasoner that
      attempts, and is refused on, each: exceed budget; re-enter a rejected
      approval; runaway tool/step loop; delegate beyond parent headroom; act on a
      non-discoverable/illegal action; mention/delegate across teams.
- [ ] Assert refusal is observable (status/escalation/blocked), and cost is still
      charged where applicable.
- [ ] Tag existing `budget-enforcement`, `loop-detection`, gateway/state-space
      unit suites `[governance]`.

Files: `tests/governance/**`, tags on existing suites.
Acceptance: **I2** (every enforced property has an adversarial refusal test).

---

## Phase 4 — Behaviour (collaboration scenarios)

Goal: prove multi-agent behaviours end-to-end (P1).

- [ ] `tests/behaviour/collaboration.spec.ts`: delegation → mention → receipt
      propagation across three agents; roster load actually steering a scripted
      reasoner's delegate choice (idle over overloaded); multi-turn caller-queue
      conversation.
- [ ] Tag existing `team`, `roster`, `mailbox`, `resume-tree`, `storyline`,
      `time-awareness` `[behaviour]`.

Files: `tests/behaviour/**`, tags.
Acceptance: **I1** for behaviour; scenarios assert observable state only (P3).

---

## Phase 5 — Provenance (proof over runs)

Goal: self-heal and learning demonstrated as readable trends (P5).

- [ ] `tests/provenance/self-heal.spec.ts`: retry, supervision strategy, resume
      from checkpoint, reasoner-failure escalation → recovery — each reconstructed
      from executions/checkpoints/escalations/commits via `inspect`.
- [ ] `tests/provenance/learning.spec.ts`: over repeated runs, trust rises on
      clean runs and degrades on surprise; assert the trend, not a single step.
- [ ] Extend the existing `provenance` integration suite; tag `[provenance]`.

Files: `tests/provenance/**`.
Acceptance: **I1** for provenance; multi-run trend assertions (P5).

---

## Phase 6 — Scale

Goal: bounds hold under load; no loops, races, or burst cliffs (spec §Purpose).

- [ ] `tests/scale/loop-runaway.spec.ts`: a looping agent is capped by the loop
      detector; cost is charged; task terminates bounded.
- [ ] `tests/scale/cache-burst.spec.ts`: thrash the LRU+TTL beyond capacity;
      assert eviction correctness and bounded lookup cost.
- [ ] `tests/scale/races.spec.ts`: interleaved-await races via `Promise.all` on a
      shared store — concurrent sends to one agent (invariant 26 queueing);
      concurrent delegations competing for the two supervision slots; interleaved
      resume. Assert bounds never exceeded and FIFO preserved.
- [ ] Fold the existing `stress/task-tree.stress` under `[scale]`.

Files: `tests/scale/**`.
Acceptance: **I1** for scale; supervision/loop/cache bounds proven under load.

---

## Phase 7 — Security baseline

Goal: consolidate current security properties as refusal tests (P6).

- [ ] `tests/security/baseline.spec.ts`: negative tests for — task identity as
      the authorization boundary (unguessable / non-forgeable id use); hooks never
      authorize; tools accept no arbitrary path/URL (document-extract id-only);
      rejected approvals never re-open; cross-team delegation/mention rejected.
- [ ] Write `docs/internal/security-stance.md`: what is covered, what is not yet.
- [ ] Tag `[security]`.

Files: `tests/security/**`, `docs/internal/security-stance.md`.
Acceptance: **I1** for security; every listed property has a refusal test (P6);
Prohibition 2 satisfied (no positive-only security coverage).

---

## Phase 8 — Packaging install smoke

Goal: the shipped artifact works as installed (P4).

- [ ] `tests/packaging/` (invoked separately, like e2e): `npm pack` → install the
      tarball into a temp project → import → run a task with the mock reasoner.
- [ ] Assert `exports`/types resolve, and optional peer deps (sharp, liteparse)
      are NOT installed/loaded unless opted in.
- [ ] Add `pnpm test:packaging`.

Files: `tests/packaging/**`, `package.json`, `vitest` packaging config.
Acceptance: **I3** (public exports exercised through the built artifact); peer-dep
boundary verified.

---

## Later — OWASP Top 10 for Agentic AI

Separate track built on Phase 7. Produce a mapping doc + per-item coverage.
Tracked here so it is not mistaken for done; not scheduled into the phases above.

---

## Cross-phase acceptance (definition of done for the effort)

- [ ] Every spec invariant (I1–I7) has at least one enforcing test.
- [ ] Every spec prohibition (1–4) has a guard (suite, CI gate, or review rule).
- [ ] `pnpm test` green; `pnpm test:<dimension>` green per dimension; `pnpm bench`
      reproducible and gated; `pnpm test:e2e` and `pnpm test:packaging` green.
