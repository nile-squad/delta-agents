# Project Audit — Structure, Boundaries, Contracts (2026-07-01)

> **Resolution status (2026-07-01):** Findings 1, 3, 4, 5 fixed in the follow-up pass.
> - **1 (reject API)** — ✅ `delta.reject(approvalId)` added and tested (see `src/engine/create-delta-engine.ts`, `tests/integration/engine.spec.ts`).
> - **2 (files over 400 LOC)** — ✅ split. `drizzle-store.ts` 704→70 (+ `src/ports/drizzle/*`, one file per entity), `openai-reasoner.ts` 890→319 (+ `openai-tool-defs.ts`, `openai-parse.ts`), `runtime.ts` 533→357 (+ `runtime-lifecycle.ts`), `scheduler.ts` 1079→927 (+ `tool-dispatch.ts`; `stepTask`'s act/delegate/mention/communicate branches and `runScheduler` were left inline — too entangled with scheduler-local mutable state to extract without risking behavior drift). All public import paths unchanged; 913/913 tests pass, typecheck clean.
> - **3 (`any`/`unknown` wording)** — ✅ `context.md` Quality Bar reworded.
> - **4 (stale handoff doc)** — ✅ `task-packages-hij.md` banner added.
> - **5 (spec DX drift)** — ✅ as-built note added to `delta-agents.spec.md` DX section.

Scope: project structure and organization, module boundaries, type/contract consistency, AGENTS.md compliance, and alignment between `docs/internal/delta-agents.spec.md`, `context.md`, and the shipped code. This is an observational audit, not a change set. Nothing in `src/` was modified.

Method: targeted static checks (file sizes, grep for banned patterns, contract diffing between `StoragePort` and its adapters, cross-referencing the public `DeltaEngine` surface against the spec's invariants) rather than a full read of every file. High-confidence findings only.

---

## Findings, ranked by severity

### 1. High: no public way to reject an approval

`ApprovalRequest.status` is `"pending" | "approved" | "rejected"` (`src/shared/types.ts`), and the internal `resolveApproval()` (`src/oversight/approvals.ts`) takes `decision: "approved" | "rejected"` and documents itself as satisfying prohibition 11 ("never re-open a rejected approval").

But `DeltaEngine` (`src/engine/create-delta-engine.ts:314-315`) only wires:

```ts
const approve: DeltaEngine["approve"] = async (approvalId) => {
  return resolveApproval({ approvalId, decision: "approved", store });
};
```

There is no `delta.reject(...)` / `delta.deny(...)` on the public surface. A human reviewer who wants to deny a risky action has no SDK entry point to do it — the only lever is to never call `approve`, which leaves the task blocked forever rather than terminating it with an auditable rejection.

Consequence: the "rejected" branch of the state machine is currently unreachable except by writing directly to the store (which is exactly what `tests/integration/drizzle-store.spec.ts:305` does — no test exercises rejection through `delta.*`). Prohibition 11 is implemented but not exercised by any real code path.

Suggested fix: add `reject: (approvalId: string, reason?: string) => Promise<Result<ApprovalRequest, string>>` to `DeltaEngine`, wired the same way `approve` is, and add an integration test that rejects an approval and confirms the task stays permanently blocked (not just paused) and that a resume does not silently re-authorize the action.

### 2. Medium-High: four files exceed the 400 LOC ceiling

AGENTS.md: "400 LOC/file max unless absolutely necessary."

```
1079  src/engine/scheduler.ts        (2.7x the limit)
 890  src/ports/openai-reasoner.ts   (2.2x)
 704  src/ports/drizzle-store.ts     (1.8x)
 533  src/engine/runtime.ts          (1.3x)
```

`scheduler.ts` has absorbed every feature phase (tools, loop detection, commit step wiring, search-commits, free-loop commit) as flat additions to one file. It now mixes: action-request handling, tool execution, tool-info queries, search-commits, free-loop commit, and phase/workflow re-entry. These are separable concerns.

`drizzle-store.ts` is one file implementing all ~32 `StoragePort` methods across 9+ entities. `openai-reasoner.ts` mixes message-building, tool-schema assembly, and response parsing for every decision kind in one file.

None of these are "absolutely necessary" monoliths — each has natural seams (per-entity for the store, per-decision-kind for the reasoner, per-concern for the scheduler). Splitting is mechanical, not risky, but each is large enough that a mid-sized refactor is warranted rather than a quick pass.

Suggested fix (not urgent, but flagged since it is the most literal AGENTS.md rule violation in the codebase):
- `src/ports/drizzle-store.ts` → split into `src/ports/drizzle/tasks.ts`, `checkpoints.ts`, `commits.ts`, etc., reassembled by `drizzle-store.ts` (mirrors how `db/models/schema.ts` is already organized by entity with comment banners).
- `src/engine/scheduler.ts` → extract tool-related branches (`use_tool`, `tool-info`, `search-commits`, free-loop `commit`) into `src/engine/tool-dispatch.ts`, leaving `scheduler.ts` with action-request handling and phase re-entry.
- `src/ports/openai-reasoner.ts` → extract the tool-definition builders (`buildTool`, `buildFinishTool`, `buildDelegateTool`, `buildSearchCommitsTool`, `buildCommitTool`, etc.) into `src/ports/openai-tool-defs.ts`.

### 3. Low-Medium: `context.md` Quality Bar overstates the `any`/`unknown` ban

`context.md` states: "No `any`, no `unknown`." In practice `unknown` is used deliberately and correctly at generic SDK boundaries: `Result<unknown, string>` on action/tool/channel return types, `ToolContext.data: unknown`, `ToolHistoryEntry.input/output: unknown` (`src/authoring/types.ts`, `src/ports/openai-reasoner.ts`, `src/engine/scheduler.ts`). This is the right call for a library whose consumers define arbitrary payload shapes — `JsonRecord` was deliberately introduced elsewhere in `src/shared/types.ts` specifically to avoid `unknown` where the shape actually is known to be JSON. No real `any` was found anywhere in `src/`.

The rule as written in `context.md` reads as violated when it is not; it was likely copied from a different (application-level) project's AGENTS.md context without being adjusted for a library that has to model consumer-defined payloads. Recommend narrowing the wording, e.g.: "No `any`. `unknown` only at genuine external/consumer boundaries (`Result<unknown,string>` on user-supplied fn returns, tool I/O) — never as a substitute for a knowable type."

### 4. Low: `docs/internal/task-packages-hij.md` is a stale "active handoff" doc

The file opens with "This is the active handoff for the remaining packages," but packages H, I, J are complete per `context.md`'s current-state section (H1-H5b, F, G, I, J all listed as shipped). AGENTS.md's workflow section tells every new agent to "Read `/docs` and project root `.md` files on task start for context," so a 16 KB doc that presents itself as active but describes finished work is a real (if small) tax on every future agent's context budget, and a source of confusion about what is still open.

Suggested fix: prepend a one-line "COMPLETED — historical reference only, see `context.md` for current state" banner, or move it under a `docs/internal/archive/` folder. Same treatment would help `docs/architecture.md` and `docs/diagnostics.md` if they've drifted from `context.md` since diagnostics/logging shipped (not independently verified in this pass — worth a follow-up skim).

### 5. Low: spec.md's DX examples no longer match the shipped DX

`docs/internal/delta-agents.spec.md`'s "Delta DX" section shows `delta.phase({...})` as an authoring method. `context.md` already documents the actual decision: "Phases are plain objects in `delta.workflow({ phases: [...] })` — no `delta.phase()`." The spec's own closing line says the DX shown "is suggestion not set in stone," so this isn't a contract violation, but a reader who only opens the spec (not `context.md`) will write code against a method that doesn't exist. Low cost to fix: add a short note near the DX section pointing at `context.md`'s DX Pattern section for the as-built surface, the same way `core-principles.md` already cross-links the spec for canonical principles.

---

## What checked out clean (worth stating, so this doesn't read as only-negative)

- **No classes, no `enum`, no `interface`** anywhere in `src/` — factory/functional style is fully consistent with AGENTS.md.
- **`StoragePort` contract parity**: all 32 methods declared on `StoragePort` are implemented by both `in-memory-store.ts` and `drizzle-store.ts`, and all are forwarded by `cached-store.ts` (including the optional cleanup methods — the forwarding gap noted in `context.md` as a past bug is confirmed fixed).
- **No raw `process.env` reads** in `src/` (the one hit is inside a JSDoc example comment, not real usage).
- **No domain-crossing barrel re-exports** — every `src/*/index.ts` only re-exports its own sibling files; `src/index.ts` is the single top-level aggregation point. This matches the "no barrel re-exports across domains" rule.
- **`backup/` and `trash/` conventions are real and gitignored**, not just written down and ignored in practice.
- **`package.json`** matches the documented Node/tsup decision exactly (no stray Bun-only dependencies, `engines.node >= 18`, `pnpm` scripts only).

---

## Suggested priority if acted on

1. Add `delta.reject(...)` (finding 1) — this is the only item that's a genuine functional gap versus the spec's own invariants, not just a style/doc issue.
2. Split `scheduler.ts` at minimum (finding 2) — it's the fastest-growing file and will only get harder to split the more that lands on top of it.
3. Fold findings 3-5 into the next `context.md` / spec pass rather than a dedicated task — they're cheap, additive doc edits.
