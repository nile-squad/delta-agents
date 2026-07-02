> **COMPLETED — historical reference only.** Packages H, I, and J are shipped. See `context.md` for the current project state. This file is preserved as a record of the original work order, not an active handoff.

# Implementation Blueprint — Packages H, I, J (handoff)

> **For the implementing agent.** This is a precise, file-by-file work order. Follow it exactly.
> Claude (reviewer) will audit each package after you finish it. Work one package at a time and
> run the full test suite + typecheck before declaring a package done. The master plan is `./task.md`;
> this file is the active handoff for the remaining packages.
>
> **Runtime/tooling:** use `pnpm`. Tests: `pnpm vitest run` (vitest is canonical, NOT `bun test`).
> Typecheck: `pnpm exec tsc --noEmit`. Both MUST pass before a package is "done".
>
> **Hard rules (AGENTS.md — non-negotiable, see "AGENTS.md compliance" at the bottom):**
> no classes (factory/pure functions only), named params in a single object, no `any`/`unknown`,
> `type` over `interface`, no `enum`, explicit return types on exported fns, JSDoc explaining WHY,
> kebab-case filenames, `safeTry`/Result over try/catch, never raw `sleep`+manual backoff
> (use `retryWithJitter` from `../infra`). Never read/edit `.env`. Delete = move to `/trash`, never `rm`.
> Do NOT run any `git`, DB, or install commands — leave those to the user/reviewer.

---

## Package H — Workflow supervision fidelity & per-action inputs

### Context: the bug H exists to fix
`runPhaseSupervised` (in `src/workflow/run-workflow.ts`) currently collapses **retry**,
**restart**, and **resume** into the same behaviour: it re-runs the whole phase from index 0
via `runOnce()`. They are spec-distinct recovery strategies and must differ observably:

- **retry**  — resume the phase from the action that failed, *keeping* prior progress.
- **restart** — re-run the phase from index 0, from the phase *entry* state.
- **resume**  — re-run from the latest *checkpoint* state (fallback to restart when none).

`applyStrategy` already returns the right decision (and `resume` already falls back to
`restart` when `checkpointId` is undefined — see `src/supervision/apply-strategy.ts`). The gap is
entirely in how `runPhaseSupervised` and `runPhase` consume that decision.

---

### H1 — Make retry / restart / resume observably distinct

**H1.a — `src/workflow/types.ts`** (mostly already done; verify)
- `PhaseResult` failed variant already has `failedIndex?: number` — keep it.
- Add `startIndex?: number` to `RunPhaseInput`:
  ```ts
  /** Index in the phase action list to begin at. Lets supervision `retry`
   *  resume from the failed action instead of re-running from the top.
   *  Defaults to 0 (run the whole phase). */
  startIndex?: number;
  ```

**H1.b — `src/workflow/run-phase.ts`**
- Destructure `startIndex` in the `runPhase` params.
- Change `let currentIndex = 0;` → `let currentIndex = startIndex ?? 0;`
- Add `failedIndex: currentIndex` to **every action-level failure return** so retry can resume
  from the right place. The four sites:
  1. action-not-found (`action === undefined`, ~line 96)
  2. gateway error (`gwResult.isErr`, ~line 117)
  3. jump-target failure (`isJumpTarget && typeof ref === "string"` branch, ~line 169)
  4. `next.kind === "end-failure"` (~line 190)
  Do **not** add `failedIndex` to the step-limit failure or the before-hook failure (those aren't
  positional action failures — resuming from an index would be meaningless).
- Guard `startIndex` against the action list bounds: if `startIndex >= actions.length`, treat the
  phase as already complete — return `completePhase(...)` rather than entering the loop. (Prevents a
  stale `failedIndex` from a shorter re-run path from silently skipping the whole phase.)

**H1.c — `src/workflow/run-workflow.ts` — rewrite `runPhaseSupervised`**
Keep the `escalate` / `abort-*` / `give-up` branches exactly as they are. Replace the single
`retry|restart|resume` branch with three distinct re-run inputs. Fetch the latest checkpoint once
(via `input.store.getLatestCheckpoint(taskId)`) so the `resume` decision has a `checkpointId`,
and pass it into `applyStrategy`:

```ts
const latestCkpt = await input.store.getLatestCheckpoint(taskId);
const checkpointId =
  latestCkpt.isOk && latestCkpt.value !== null ? latestCkpt.value.id : undefined;
const decision = applyStrategy({ policy, retryCount: 0, checkpointId });
```

Then in the retry/restart/resume arm, build the per-strategy re-run input. Note `applyStrategy`
maps a `resume` policy with no checkpoint to `decision.action === "restart"`, so a `switch` on
`decision.action` naturally folds that fallback in:

```ts
case "retry":
case "restart":
case "resume": {
  // retry  → resume from the failed action, preserving progress (first.snapshot, failedIndex).
  // restart→ re-run from phase entry state, index 0.
  // resume → re-run from the latest checkpoint state, index 0 (applyStrategy already
  //          downgraded resume→restart when no checkpoint exists).
  const reRunInput = (): RunPhaseInput => {
    if (decision.action === "retry") {
      return { ...input, state: first.snapshot, startIndex: first.failedIndex ?? 0 };
    }
    if (decision.action === "resume" && latestCkpt.isOk && latestCkpt.value !== null) {
      return {
        ...input,
        state: { ...snapshotFromJson(latestCkpt.value.state), status: "running" },
        startIndex: 0,
      };
    }
    return { ...input, state: input.state, startIndex: 0 }; // restart
  };

  const retried = await retryWithJitter<PhaseResult>({
    fn: async () => {
      const r = await runPhase(reRunInput());
      return r.status === "failed" ? Err(r.failedReason) : Ok(r);
    },
    options: { maxAttempts: policy.maxRetries, baseDelayMs: 5, maxDelayMs: 50, jitterFactor: 0.5 },
  });
  if (retried.isOk) return retried.value;
  return {
    status: "failed",
    snapshot: input.state,
    failedReason: `supervision "${decision.action}" exhausted ${policy.maxRetries} attempt(s) on phase "${input.phase.name}": ${retried.error}`,
  };
}
```

- You will need a `snapshotFromJson` helper local to `run-workflow.ts`. **Check
  `src/state-space/task-state.ts` first** and reuse a typed helper if one exists; only if none
  exists, match the existing one-liner pattern used in `run-phase.ts`/`runtime.ts` — but do NOT
  scatter a fresh `unknown` cast (this is exactly what L4 is cleaning up).
- Keep the `runOnce`/`first` initial attempt as-is (the first failing run is what produces
  `failedIndex`).

**H1.d — Test:** `tests/unit/workflow/supervision-strategies.spec.ts` (new)
Construct a phase `[a, flaky]` where:
- `a` increments a module-scoped `aCount` each time it runs and always succeeds.
- `flaky` fails the first 2 invocations then succeeds (closure counter).
Run the same phase under three policies (`maxRetries: 5`) and assert:
- **retry**:   `aCount === 1`  (a never re-runs; retry resumes at `flaky`).
- **restart**: `aCount === 3`  (whole phase re-runs each attempt: initial + 2 retries).
- **resume** with `phase.checkpoint !== true` (no checkpoint): behaves like restart → `aCount === 3`.
Also assert the final `PhaseResult.status === "completed"` in all three.
Reset counters between cases. (This is the canonical proof H1 works — do not skip it.)

---

### H2 — Resume a task that had active children (supervision-tree rehydration)

**Problem:** `resumeTask` → `runSendLoop` builds only the root runner. If the task was paused while
it had active child tasks (delegations), those children are dropped on resume — the tree silently
loses work.

**H2.a — `src/engine/scheduler.ts` — `runScheduler`**
On scheduler start, before the main loop, rehydrate the tree: if a `TaskTree` exists for the root
(`store.getTaskTree(rootId)` returns Ok with a value), load each id in `tree.activeChildren` that is
not already a runner and is not in a terminal status, and push it as a runner (reuse the existing
`startRunner` helper — it already loads the task, resolves the agent, marks it running, and pushes a
`makeRunner`). Guard against: (a) duplicate runners (check `findRunner(id) === undefined` first),
(b) children whose task status is already `completed`/`failed`/`aborted` (skip — they settled before
the pause), (c) a missing/Err task or unknown agent (skip that child, do not abort the whole resume).

Set `treeInitialized = true` when you rehydrate from an existing tree so subsequent settle/slot
bookkeeping uses the loaded tree rather than lazily creating a fresh empty one.

**H2.b — Test:** `tests/integration/resume-tree.spec.ts` (new) — prefer deterministic
direct-state construction over racing a live delegation:
- Persist a root task (`paused`/`pending`), a child task record (`running`/`paused`, non-terminal),
  and a `TaskTree` with that child id in `activeChildren`.
- Call `resumeTask` and assert the child is picked up and driven to a terminal state, and the root
  result aggregates the child's status (the D1 subtree aggregation should survive the pause/resume
  boundary).
- Avoid timing-dependent "pause mid-child" setups — they flake.

---

### H3 — Per-action workflow inputs

**Problem:** `runWorkflowTask` feeds the **same** `input` bag to every action via
`inputFor: () => input ?? {}`. Distinct actions in a workflow often need distinct inputs.

**H3.a — `src/engine/types.ts` — `SendInput`**
Add an optional per-action override map (keep the shared `input` as the fallback/default):
```ts
/**
 * Per-action input overrides for a deterministic workflow run, keyed by action
 * name. When an action name is present here, its bag is used instead of the
 * shared `input` bag; absent action names fall back to `input`. Ignored for the
 * reasoner loop. (Reasoner-filled inputs remain a separate, future path.)
 */
actionInputs?: Record<string, Record<string, string | number | boolean | null>>;
```

**H3.b — `src/engine/runtime.ts` — `runWorkflowTask`**
- Thread `actionInputs` into the function params (add to the destructured arg list + its inline type).
- Replace `inputFor: () => input ?? {}` with:
  ```ts
  inputFor: (name) => actionInputs?.[name] ?? input ?? {},
  ```
- Trace the call site: whoever calls `runWorkflowTask` (the `send` facade in
  `create-delta-engine.ts`) must forward `actionInputs` from `SendInput`. Find it and wire it
  through. Do not change reasoner-loop (`runSendLoop`) signatures — H3 is workflow-only.

**H3.c — Test:** extend the workflow integration test (search `tests/` for `workflow:` /
`runWorkflowTask`):
- Two actions, each asserting (inside its `fn`, or by recording into a captured array) that it
  received its *own* distinct input value.
- A third action with no entry in `actionInputs` to prove the shared-`input` fallback still works.

---

## Package I — Correctness cleanups (audit findings L1–L4, M2)

> Each is a discrete fix with its own minimal test or assertion. Do them in order; they are independent.

- **L1 — `deploy` no-op.** Find `deploy` in `src/engine/create-delta-engine.ts`. Confirm whether it
  actually gates execution (can an undefined-but-undeployed agent still be `send`-ed?). Make
  `deploy` meaningful: mark the agent active and have `send` reject (Err) a goal for an agent that
  was defined but never deployed, with a clear message
  (`agent "X" is defined but not deployed — call delta.deploy(agent) first`). Add a test:
  send-before-deploy → Err; deploy-then-send → Ok. (If `deploy` already gates correctly, document
  that in your report and add the missing test rather than changing code.)

- **L2 — double execution-row write.** Search for where an `Execution` record is persisted
  (`store.saveExecution` / `createExecution`) in `src/execution/execution-gateway.ts` and the
  scheduler/post-step path. There is a duplicate write producing two rows per action. Trace the two
  call sites, keep the single authoritative one, remove the redundant write. Add/adjust a test
  asserting exactly one execution row per successful action (`getExecutionsByTask(...).length`).

- **L3 — per-step double persistence.** Similar to L2 but for the checkpoint / task-update path:
  a single successful step persists the snapshot/task twice. Find the redundant `updateTask` /
  `saveCheckpoint` pair and collapse to one. Verify no test depended on the duplicate.

- **L4 — `unknown` casts.** Grep the whole `src/` for `as unknown` and `: unknown`. For each,
  either (a) replace with a properly typed helper, or (b) if it is a genuine serialization boundary
  (snapshot <-> JsonRecord), centralize it in ONE typed helper in `state-space/` and import it
  everywhere instead of re-casting inline. AGENTS.md bans `unknown` — the only acceptable residue is
  a single, documented, JSON-(de)serialization shim with a JSDoc explaining why it is unavoidable.

- **M2 — resume error message.** In `resumeTask` (`src/engine/runtime.ts`), the guard message says
  `(expected "paused")` but the code also accepts `"pending"`. Fix the message to reflect both
  accepted statuses. Trivial; add no test, but verify the existing resume tests still pass.

---

## Package J — Ship hardening (public surface, docs, real-DB)

- **J1 — public `index.ts`.** Currently `src/index.ts` only re-exports `slang-ts`. Build the real
  public surface: export the engine factory (`createDeltaEngine`), the authoring types developers
  need (`Agent`, `Action`, `Workflow`, `Phase`, `Channel`, `ActionContext`, `Cost`, `Budget`,
  etc.), `createChatSdkChannel`, `createInMemoryStore`, the libsql/drizzle store factory, and the
  OpenAI reasoner factory. Do NOT export internal governance internals that aren't part of the DX.
  Keep the `slang-ts` re-export (developers use `Ok`/`Err`/`Result`). Group exports with comments
  (authoring / runtime / adapters / result-utils). Verify with a smoke test that imports the public
  names from `../../src` and constructs an engine.

- **J2 — README.** Write `README.md` from `./delta-agents.spec.md` + `context.md`: the
  "model reasons, engine governs" thesis, install, a minimal `agent`/`action`/`send` example, the
  two-tier authoring/runtime API, supervision strategies, and the cost model (multi-axis:
  tokens/durationMs/memory/latency). Follow `./COPYWRITING.md` (no em dashes, no emojis, full words).

- **J3 — real-DB pass.** The drizzle/libsql store (`src/ports/drizzle-store.ts`, `db/models/`) has
  only been exercised against in-memory. Add an integration test that runs the migration and a
  full task lifecycle (send → checkpoint → inspect → resume) against a real libsql file/`:memory:`
  client. **DB work needs the user's sign-off** — flag this for the reviewer, do not run migration
  commands yourself.

- **J4 — security review + bun-in-build decision.** Defer to the reviewer (Claude will run
  `/security-review` and decide the bun-vs-node build question). Leave a short note here listing any
  spots you (implementer) think are sketchy.

---

## AGENTS.md compliance (apply to EVERY file you touch)

- Factory/pure functions only — **no classes**, no `new` on your own types.
- Named params: a single object arg, destructured. Not positional.
- `type` not `interface`; **no `enum`** (use string-literal unions); **no `any`, no `unknown`**
  (the one allowed `unknown` is the documented JSON-serialization shim from L4).
- Explicit return types on every exported function.
- JSDoc on exported APIs explaining **WHY**, not what.
- Errors via `Result` (`Ok`/`Err` from `slang-ts`) and `safeTry` — **no raw try/catch**.
- Retries/backoff via `retryWithJitter` from `../infra` — **never** raw `setTimeout`/sleep loops.
- kebab-case filenames, verbNoun function names, `.filter().map()` over imperative for-loops where
  it reads cleanly, max 400 LOC/file.
- Delete by moving to `/trash`, never `rm`.
- New types live in the domain's `types.ts` and are re-exported via the barrel `index.ts`.

## Definition of done (per package)
1. `pnpm exec tsc --noEmit` clean.
2. `pnpm vitest run` fully green (run it 2-3x — the suite has had wall-clock flakes; do NOT add new
   timing/perf assertions).
3. New behaviour has a test that fails before your change and passes after.
4. `context.md` updated with a short section describing what the package added.
5. Report back: list files changed + test names added, and call out anything you skipped or that
   needs the reviewer's DB/git sign-off.
