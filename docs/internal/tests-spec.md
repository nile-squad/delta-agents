# Delta Agents — Test & Benchmark Specification

## Purpose

This spec defines the contract the test and benchmark suites must satisfy: which
claims the runtime makes must be proven, how they must be proven, and what a
benchmark must guarantee to count as evidence. It exists because a governed agent
runtime is only trustworthy to the degree its guarantees are demonstrable — an
enforcement or provenance claim that no suite proves is a marketing assertion,
not a property. It governs how tests are written and organized; it is not a list
of the tests themselves.

## Principles

1. **Every quality claim is backed by a named, isolable suite.** A claim the
   runtime makes — collaboration, enforcement, auditability, security, bounded
   scale — is real only if a suite proves it and a reader can run exactly that
   suite. Why: an unproven claim is marketing, and a claim buried in an unrelated
   suite cannot be pointed to when an organization asks "show me."

2. **Governance is proven adversarially.** Enforcement suites drive a hostile or
   maximally-capable actor that attempts each violation and assert the engine
   refuses. Why: the runtime's core promise is that it bounds a strong model; a
   happy-path test proves only that a cooperative model cooperates.

3. **Tests assert observable behaviour, not internal wiring.** Suites exercise
   the public surface and observable state, never private call graphs or file
   layout. Why: tests coupled to wiring rot on every refactor and stop being
   trusted.

4. **The artifact is tested as shipped.** The published bundle — its exports,
   types, and dependency boundaries — is exercised as a consumer installs it, not
   only as source. Why: a green source suite can still ship a broken package.

5. **Provenance is proven as narrative, not as increments.** Self-healing and
   learning-over-time are demonstrated by multi-run suites showing a trend an
   auditor can read, not only by unit steps of the underlying math. Why: an
   organization relies on reconstructing and trusting what happened, which is a
   story across runs, not a single number.

6. **Security is proven by refusal.** Each security property has a negative test
   that performs the forbidden action and asserts rejection. Why: the absence of
   a positive test never demonstrates that a loophole is closed.

7. **Benchmarks are deterministic and reproducible.** Benchmark scenarios run
   without network or wall-clock nondeterminism in their assertions and record
   the commit, runtime version, and command that produced them. Why: a number no
   one can reproduce is not evidence and must not be presented.

8. **Instrumentation is free when off and inert when read.** The metrics and
   diagnostics surface allocates nothing and touches no hot path when disabled,
   and reading it never alters engine behaviour. Why: observability that taxes or
   perturbs production changes the very thing it measures.

## Decision Records

### Decision: Metrics are exposed through a read-only engine facade reader

- **Decision** — Aggregated startup and runtime metrics are read through a
  dedicated read-only method on the engine facade (`engine.metrics()`).
- **Context** — Timing primitives already exist in the diagnostics module but
  only emit to the logger; a presentable, verifiable benchmark needs an
  aggregated, queryable surface.
- **Alternatives considered** — Changing the engine factory to return the engine
  plus a startup report (rejected: breaks every construction site and its tests
  for a foundational feature); emitting richer logger events and scraping them in
  the harness (rejected: not queryable at runtime and couples the benchmark to
  log format).
- **Rationale** — Additive and discoverable; existing logging is unchanged; the
  benchmark reads structured values instead of parsing text.
- **Tradeoffs** — The engine carries a small metrics accumulator for its
  lifetime; aggregation must stay zero-overhead until read (Principle 8).

### Decision: Skill load cost is measured at first use

- **Decision** — Skill load is measured as first-use latency, not as a startup
  cost.
- **Context** — Skills load lazily on the turn that needs them; there is no
  startup skill-load phase to time.
- **Alternatives considered** — Eager startup pre-load to produce one aggregate
  load number (rejected as default: contradicts the lazy design and slows every
  engine start); retained only as an opt-in benchmark mode.
- **Rationale** — Measures what actually happens in production rather than an
  artificial phase.
- **Tradeoffs** — The headline "skills load time" is per-skill-first-use, not a
  single figure; the benchmark's opt-in pre-warm mode reconciles this when one
  number is wanted.

### Decision: Dimensions are selected by tags and runner projects

- **Decision** — Dimension suites are selected via tags and test-runner projects;
  existing per-module tests stay where they live.
- **Context** — Tests are organized by layer (unit / integration / e2e), but the
  quality dimensions this spec defines cut across layers.
- **Alternatives considered** — Physically relocating every test into
  per-dimension folders (rejected: large churn and history noise for no
  behavioural gain).
- **Rationale** — Any dimension is runnable in isolation without moving stable
  suites; new dimension-specific suites still get their own home.
- **Tradeoffs** — A test's dimension is carried by an applied tag, not implied by
  its path, so the tag convention must be enforced.

### Decision: The benchmark gates on tolerance bands

- **Decision** — The benchmark suite asserts key metrics within tolerance bands
  against a committed baseline, failing the build on regression.
- **Context** — A record-only benchmark catches regressions only by eye.
- **Alternatives considered** — Emit results as an artifact with no gate
  (rejected: performance regressions would land silently).
- **Rationale** — Regressions fail the build; bands absorb machine variance so
  the gate does not flake on absolute numbers.
- **Tradeoffs** — Bands need tuning (too tight flakes, too loose misses
  regressions) and the baseline needs occasional deliberate re-blessing.

## Invariants

1. Each dimension — behaviour, governance, provenance, security, scale, packaging
   — has at least one suite that runs in isolation.
2. Every governance property the engine enforces has an adversarial test that
   attempts the violation and asserts refusal.
3. Every public export is exercised through the built artifact, not only source.
4. The default test run has no live-network dependency; live-model coverage runs
   only in a separately-invoked, credential-gated suite.
5. Reading the metrics surface never changes task outcomes, ordering, or state.
6. With diagnostics disabled, no diagnostic event is emitted and no per-call
   allocation occurs.
7. Every reported benchmark result carries the commit, runtime version, and the
   command that reproduces it.

## Prohibitions

1. A quality claim in any public artifact (README, benchmark, marketing) never
   ships without a corresponding passing suite.
2. A security property is never treated as covered by a positive-path test alone.
3. A benchmark number is never presented without its reproduction metadata.
4. Instrumentation never executes on the hot path when diagnostics are disabled.

## Follow-Up Work

Items are listed in intended execution order; the agreed sequence begins with the
diagnostics/benchmark foundation so that every later suite can be measured as it
lands.

- **Metrics surface.** *What*: the read-only startup/runtime metrics reader, with
  a builtin-vs-custom tool breakdown. *Why deferred*: nothing to benchmark
  without it. *Impact*: startup cost is currently unmeasured and unpresentable.
- **Benchmark harness + committed baseline.** *What*: deterministic scenarios
  (cold startup by tool count, skill first-use, single-task throughput,
  delegation fan-out, cache hit/miss) with a tolerance-band regression guard.
  *Why deferred*: depends on the metrics surface. *Impact*: no regression gate and
  no reproducible numbers to present.
- **Adversarial governance suite.** *What*: a scripted maximally-capable actor
  attempting to exceed budget, re-enter a rejected approval, loop, and delegate
  beyond headroom. *Why deferred*: sequenced after the measurement foundation.
  *Impact*: the "bounds a strong model" claim rests on happy-path coverage.
- **Collaboration behaviour scenarios.** *What*: end-to-end multi-agent flows
  (delegation → mention → receipt propagation; roster steering delegation
  choice). *Why deferred*: sequenced. *Impact*: multi-agent behaviour is proven
  only in isolated pieces.
- **Provenance narrative proofs.** *What*: multi-run suites demonstrating
  self-heal (retry / supervision / resume / escalation-then-recovery) and
  learning (trust and surprise trends over repeated runs). *Why deferred*:
  sequenced. *Impact*: these two claims are demonstrated incidentally, not
  asserted.
- **Scale suite.** *What*: loop-runaway capping, cache-burst degradation bounds,
  and interleaved-await races (concurrent sends to one agent, concurrent
  delegations competing for the two supervision slots). *Why deferred*:
  sequenced. *Impact*: only task-tree bounds are currently stressed.
- **Security baseline suite + stance record.** *What*: consolidated negative
  tests for the current security properties (task identity as authorization
  boundary, hooks never authorize, tools take no arbitrary path or URL, rejected
  approvals never re-open, cross-team collaboration rejected) and a written
  stance of what is and is not yet covered. *Why deferred*: sequenced. *Impact*:
  security assertions are scattered across feature suites with no single stance.
- **Packaging install smoke.** *What*: pack the tarball, install it into a clean
  project, import and run a task, and assert optional peer dependencies are not
  pulled unless opted in. *Why deferred*: sequenced. *Impact*: export and
  dependency-boundary correctness is verified only indirectly.
- **OWASP Top 10 for Agentic AI coverage.** *What*: a mapping and per-item
  coverage of the agentic threat list. *Why deferred*: a distinct track that
  builds on the security baseline. *Impact*: no agentic-threat coverage exists
  yet; tracked so it is not mistaken for done.
