# Supervision

When a workflow phase fails, the engine applies a declared supervision policy to decide what to do next. This document covers the supervision strategies and their exact observable behavior, how retry budget is counted, the bounded supervision tree and its slot mechanics, and how checkpointing and recovery connect to the strategies.

See [delta-agents.spec.md](../delta-agents.spec.md) for the canonical specification.

## Declaring a Supervision Policy

A supervision policy is declared per phase on the `Phase` authoring type:

```ts
delta.phase({
  name: "external-call",
  description: "Call the external API",
  actions: ["call-api"],
  checkpoint: true,
  supervision: { strategy: "retry", maxRetries: 3 },
});
```

`supervision` is optional. A phase with no policy propagates a failure to the workflow level unchanged.

## Strategies and Their Exact Behavior

The strategy is applied by `applyStrategy` (`src/supervision/apply-strategy.ts`) and executed by `runPhaseSupervised` in `src/workflow/run-workflow.ts`. The recovery boundary is the phase: the engine re-runs the whole phase (or from a point within it), not individual actions.

| Strategy | Behavior |
|----------|---------|
| `retry` | Re-runs the phase from the action that failed. Prior completed actions within the phase are preserved. The engine passes `startIndex: failedIndex` to `runPhase` so the actions before the failure are not re-executed. |
| `restart` | Re-runs the phase from its entry state, action index 0. All progress within the phase is discarded. |
| `resume` | Re-runs from the state captured in the latest checkpoint, action index 0. If no checkpoint exists, falls back to restart automatically. |
| `escalate` | Pauses the task and raises a human escalation with trigger `"workflow-failure"`. Returns `status: "blocked"` to the caller. Execution stops until a human acts. Not subject to `maxRetries`. |
| `abort-subtree` | Calls `abortTask` on the failing task only and returns `status: "failed"`. Siblings and the root keep running. Not subject to `maxRetries`. |
| `abort-tree` | Calls `abortEntireTree` from the snapshot's `rootId`: the root and every active and queued child are aborted and the tree is cleared so no queued child is later promoted. Returns `status: "failed"`. Not subject to `maxRetries`. |

### Observably distinct retry, restart, and resume

The three re-run strategies produce different observable outcomes because they differ in which state and which starting index they pass to `runPhase`:

- **retry** passes `state: first.snapshot` (the snapshot at the point of failure, including work done before the failure) and `startIndex: first.failedIndex`. Actions before `failedIndex` do not run again. The `completedActions` list from the prior steps survives.
- **restart** passes `state: input.state` (the state at phase entry, before any action in this phase ran) and `startIndex: 0`. All phase-level progress is wiped.
- **resume** passes the snapshot deserialized from the latest checkpoint and `startIndex: 0`. If no checkpoint was written for this task, `applyStrategy` returns `"restart"` instead of `"resume"`, so the fallback is automatic and does not fail silently.

`run-phase.ts` reads `startIndex ?? 0` as its initial `currentIndex`. It also guards against `startIndex >= actions.length`: if the starting index is at or past the end of the action list, the phase returns completed immediately rather than skipping actions silently.

### maxRetries and give-up

The retry count starts at 0 for the first attempt. When `retryCount >= maxRetries`, `applyStrategy` returns a `"give-up"` decision regardless of the strategy. `runPhaseSupervised` surfaces give-up as a failed phase with a clear reason including the retry count.

Re-runs with jittered backoff use `retryWithJitter` from `src/infra` with `baseDelayMs: 5` and `maxDelayMs: 50`. Raw `sleep` plus a fixed delay is never used.

Only a plain failure consumes a retry. A blocked phase (from escalation) or a completed phase terminates the retry loop early.

## Checkpointing and Recovery

A checkpoint is written after a successful phase when `phase.checkpoint: true`. The checkpoint captures the full `TaskStateSnapshot` at that moment, serialized as a `JsonRecord`. The Kalman estimator state is included so it survives pause and resume.

In the free reasoner loop, a checkpoint is also written after every successful action, not only at phase boundaries. This gives the pause mechanism a recovery point even mid-phase.

The `resume` strategy reads the latest checkpoint via `store.getLatestCheckpoint`. If found, it deserializes the snapshot using `snapshotFromJson` from `src/state-space/task-state.ts`. The cast is isolated to that one function.

### Pause and resume

`pauseTask` (`src/engine/runtime.ts`): reads the latest checkpoint for the task, builds a snapshot from it (or from the task record if no checkpoint exists), writes a new checkpoint with `status: "paused"`, and marks the task status `"paused"`. A terminal task (completed, failed, or aborted) rejects a pause attempt, because pausing a terminal task would allow a later resume to re-enter the loop and re-run finished work.

`resumeTask`: reads the task and checks that its status is `"paused"` or `"pending"`. Reads the latest checkpoint. Reconstructs the `TaskStateSnapshot` from it (or from the task record if no checkpoint exists), forces `status: "running"`, and marks the task running in the store. It then routes by task kind, preserving C-a coexistence on resume: a task with an assigned workflow re-enters the deterministic workflow engine (`runWorkflowTask`); a workflow-less task re-enters the free reasoner loop (`runSendLoop`). The reconstructed snapshot is passed as `startingSnapshot` in both cases.

For a workflow task, resume works at two granularities. Every phase that wrote a checkpoint (`phase.checkpoint: true`) is recorded in the snapshot's `completedPhases`, and `runWorkflow` skips those phases on resume, so a recovered workflow does not re-execute finished, possibly side-effectful phases (mid-workflow resume). The send-time input is captured in an initial checkpoint when the workflow task starts (a workflow can block on the approval pre-flight before any phase checkpoint exists), so the deterministic re-run sees the same inputs after a process restart.

When a phase escalates part way through (some actions completed, one failed), the checkpoint also records `currentActionIndex` — the index of the failed action within that phase. On resume, `runWorkflow` re-enters `currentPhase` at that action via `startIndex`, so the actions that already succeeded before the failure are not re-executed (mid-phase resume). This makes the recovery boundary the failed action, not the whole phase: the phase resumes exactly where it stopped.

## The Bounded Supervision Tree

Delegation creates a supervision tree rooted at the root task. The tree is bounded by two structural rules:

1. At most two active children at any time per tree. Enforced by `requestSlot` in `src/supervision/task-tree.ts`. The `TaskTree` type carries `maxConcurrency: 2` as a literal.
2. A child's budget is clamped to the parent's remaining headroom. Enforced by `enforceSubtaskScope` in `src/supervision/scope.ts`. The parent's `spent` is debited by the granted child budget immediately on delegation, so concurrent delegations draw from a shrinking pool.

### Slot promotion

When a third (or later) delegation is requested while two children are already active, `requestSlot` enqueues the new child ID at the tail of `TaskTree.queuedChildren` (FIFO). When an active child settles, `releaseSlot` removes it from `activeChildren`, promotes the head of `queuedChildren` to `activeChildren`, and returns the promoted ID. The scheduler calls `startRunner` on the promoted ID to add it to the live runner set.

### Child budget reservation and refund

On delegation, the parent's `spent` is immediately debited by the child's granted budget. When the child settles, the unused remainder (`remainingCost(child.budget, child.spent)`) is refunded to the parent's `spent`. The net parent spend across delegation and settlement equals the child's real spend, but while the child is live the parent's headroom is reduced. This makes it structurally impossible for two concurrent children to each be granted the parent's full remaining budget.

### Tree rehydration on resume

When `runScheduler` starts and a `TaskTree` already exists in the store (from a previous run that was paused), it iterates `tree.activeChildren` and calls `startRunner` for any non-terminal child not already in the runner list. Terminal children (completed, failed, or aborted) are skipped. Children with missing task records or unknown agents are skipped without aborting the resume. This gives paused tasks with live subtrees the correct behavior: the children are driven to completion alongside the resumed root.

### Root failure cascade

When the root task settles as failed or blocked while children are still live, `abortEntireTree` is called. Every descendant in the tree is marked aborted in the store, and every non-settled runner is immediately settled as failed with the reason `"aborted: parent tree aborted"`. This enforces the invariant that a subtree cannot outlive a failed root.

After the main loop exits, the scheduler also checks: if the root settled as completed but any child settled as failed or blocked, the root result is overridden to failed or blocked respectively. A delegated failure never surfaces as a successful root.

## Caller Message Queue

When `send` is called for an agent that already has a running or pending major task, the goal is saved as a `Message` with `sender: "caller"` attributed to the existing task. No second task is created.

When a runner in the free reasoner loop reaches a natural-done state, `drainMessages` runs before the task settles. It fetches all unconsumed caller messages for the task, appends them to the task goal as `[queued] ...`, adds their IDs to `consumedMessages` on the snapshot, writes a checkpoint so the drain is idempotent across a later resume, and returns true. A true return keeps the task running to handle the appended goals rather than settling.

The `consumedMessages` field on `TaskStateSnapshot` ensures that after a pause and resume, the same messages are not folded in again. The drain is idempotent because it checks the `consumed` set before processing each message.
