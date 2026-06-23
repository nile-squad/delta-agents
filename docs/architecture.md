# Architecture

Delta Agents is a deterministic autonomous control plane. This document describes how it is structured, how a task flows through it, and why the design makes the guarantees it does.

See [delta-agents.spec.md](../delta-agents.spec.md) for the canonical specification.

## The Central Separation

The engine operates on one invariant: the model reasons, the engine governs.

The reasoning model proposes actions. Every proposal passes through a single ordered chokepoint before any real work happens. Safety checks, budget accounting, authorization, risk scoring, and workflow transitions all live in the engine, not in the model. The model never gains direct access to a capability. It requests, and the engine decides.

This means governance does not improve or degrade with the model. A weaker model is still safe. A stronger model is still bounded.

## Bounded State-Space Model

The engine treats execution as movement through a finite set of valid states and transitions. An action that is not reachable from the current state does not exist, from the agent's perspective.

The legal action set at any moment is determined solely by the current `TaskStateSnapshot`: status, completed actions, completed workflows, budget headroom, risk level, and prerequisite satisfaction. This is a Markov property: the legality of the next action depends only on the current state, never on history. The engine can re-derive every legal transition from the snapshot alone, which is what makes checkpointing and recovery safe.

The state space is bounded by the agent's definition. Nothing outside `agent.actions` and `agent.workflows` is discoverable or reachable. The engine reads this from the `Registry` at authoring time, which is read-only during execution.

The `TaskStateSnapshot` type (`src/state-space/types.ts`) carries the full Markov state: task status, `completedActions`, `completedWorkflows`, `budget`, `spent`, `risk`, `trust`, a running `kalman` estimator, optional parent budget for subtask scoping, and the set of consumed message IDs for drain idempotency.

## The TaskID as the Unit of Governance

Every execution event, message, checkpoint, escalation, approval request, and memory write is attributed to a `TaskID`. There are no ungoverned side effects. The `inspectTask` function (`src/engine/runtime.ts`) reads all of these collections in one call and returns a complete, TaskID-attributable audit view: the task record, all executions, the latest checkpoint, all escalations, and all pending approvals.

The TaskID also scopes budget authority. A subtask task carries `parentBudget` and `parentSpent` on its snapshot and is blocked the moment its parent's budget is exhausted, regardless of its own budget remaining.

## The Execution Gateway

Every action the engine runs passes through `runGateway` (`src/execution/execution-gateway.ts`). There are no bypasses. The pipeline is ordered and deterministic:

| Step | What happens |
|------|-------------|
| 1. Schema validation | Zod parses the raw input. Malformed input is rejected before any governance machinery runs. |
| 2. Legality check | `checkLegality` re-evaluates the Markov state at execution time. State can change between discovery and execution, so the check runs again. |
| 3. Approval gate | Actions with `requiresApproval: true` block until a human has approved. Pending or rejected status returns `Err`. |
| 4. Before hook | The action's `before` hook runs. Hooks observe and prepare; they cannot authorize or bypass governance. A failed before hook blocks execution. |
| 5. fn() execution | The action function runs. Throws are caught and treated as `Err`. |
| 6. After/onError hook | Teardown hook runs. Its result cannot alter the outcome already determined above. |
| 7. Trust and risk update | `assembleStepSignals` composes friction, Kalman health, and Bayesian surprise into the evidence fed to `updateTrust` and `updateRisk`. |
| 8. Execution record | One execution row is written to the store with status, cost, and timing. TaskID-attributable. |

The gateway returns `Ok(GatewaySuccess)` when `fn` ran (the inner `fnResult` carries `Ok` or `Err` from the function itself). It returns `Err(string)` when it blocked before `fn` could run.

## Two Execution Paths: C-a Coexistence

The engine runs two fundamentally different execution paths, and a single `send` call goes to one or the other:

**Free reasoner loop.** A task with no assigned workflow uses `runSendLoop`, which drives `runScheduler`. On each step: discover legal actions, rank them by Bellman value, retrieve relevant memory, call `reasoner.reason`, receive a decision, and route it. The reasoner can request an action, signal done, delegate to another agent, or send a communication. The reasoner drives the sequence; the engine governs every step.

**Deterministic workflow engine.** A task with an assigned workflow uses `runWorkflowTask`. The reasoner is not consulted. Phases run in declared order. Each action runs through the same gateway. Before the workflow starts, the engine pre-flights approvals for every action the workflow references, because the deterministic path cannot pause mid-phase to request approval. The engine also runs an MPC (model predictive control) projection before execution: it sums the declared `estimatedCost` of each action in order, stopping at the first action with no declared cost (an epistemic boundary), and blocks the workflow before it runs if the projected cost already exceeds the budget.

The branch is in `createDeltaEngine` (`src/engine/create-delta-engine.ts`): when `workflowName` is defined on the `SendInput`, the engine calls `runWorkflowTask`; otherwise it calls `runSendLoop`. Both paths share one post-step governance function, `applyPostStepGovernance` (`src/oversight/post-step.ts`), which applies escalation checks and persists trust and risk after every successful action. This guarantees that the audit trail and safety behavior are identical regardless of which path ran the action.

## Task Hierarchy and the Delegation Tree

A top-level `send` creates a root task. A root task may instruct the reasoner to delegate a scoped sub-goal to another agent. That creates a child task with `parentId` set to the root and `rootId` pointing back to the original root. Child tasks carry the same governance machinery as root tasks: their own budget, risk state, trust state, and audit trail, all scoped to the parent's remaining headroom.

Delegation is a first-class `ReasonerDecision` kind: `{ kind: "delegate", delegation: { goal, agentName, budget? } }`. It is not an action through the gateway. The scheduler handles it: create the child task, enforce the budget scope, and register a runner.

The root failure handling is structural: if a root task settles as failed or blocked while children are still active, `abortEntireTree` cascades the abort to all descendants. If a root completes but any child settled as failed or blocked, the root's result is overridden to match the worst child outcome. A delegated failure never silently propagates as success.

## Agent Concurrency Model

The concurrency model is per agent, not per tree:

- An agent owns at most one active major task at a time. A major task is a top-level `send` with no `parentId`. When `send` is called for an agent that already has a running or pending major task, the goal is queued as a `Message` attributable to the existing task, and `send` returns `status: "queued"`. No second task is created.
- Separately, a task may have at most two active child tasks (subtasks, from delegation) at any time. Additional delegations queue FIFO in the `TaskTree.queuedChildren` list and are promoted when a slot opens.
- The queue for subtasks is unlimited.

The two-active-subtask bound is enforced by `requestSlot` and `releaseSlot` in `src/supervision/task-tree.ts`. The `TaskTree` type carries `maxConcurrency: 2` as a literal, not a configurable value.

Child budget is clamped at delegation time by `enforceSubtaskScope` (`src/supervision/scope.ts`), which computes remaining headroom and clamps the requested child budget to it. The parent's `spent` is debited by the granted child budget immediately (a reservation), and the unused portion is refunded when the child settles. This ensures two concurrent children cannot collectively be granted more than the parent's remaining budget.

## The Scheduler

`runScheduler` (`src/engine/scheduler.ts`) drives the entire supervision tree to completion within one `send` or `resume` call. It advances every runnable task by exactly one reasoner-to-gateway step per pass, in deterministic round-robin order: parent first, then children in the order they were added. This is the "spawn and poll later" model: a delegation registers a child and returns immediately; the parent keeps making progress while the child runs interleaved.

On each pass, a child task's view of its parent's current spend is refreshed from the live parent runner state, so the legality guard enforces the parent budget under interleaving rather than from a stale delegation-time copy.

When the scheduler resumes a previously paused task, it rehydrates the supervision tree from the store: any non-terminal active children from the persisted `TaskTree` are added as runners before the main loop begins.

## Two-Tier Authoring versus Runtime

The developer surface is split cleanly:

**Authoring API.** These methods define capabilities. They run before `deploy`, return definitions, and are read-only during execution. `delta.action`, `delta.workflow`, `delta.phase`, `delta.dataSource`, and `delta.agent` populate the `Registry`. A `DataSource` is a named bundle of governed CRUD operations; its operations are full actions, flattened into the agent's reachable action set so a data read or write is governed exactly like any other action (see [resources.md](./resources.md)). Nothing in the authoring API touches the store or creates runtime state.

**Runtime API.** These methods drive execution. `delta.deploy` gates execution by marking an agent as deployed in the registry. `delta.send`, `delta.pause`, `delta.resume`, `delta.approve`, `delta.inspect`, and `delta.lastTask` all touch the store. The engine constructs and owns all runtime types (`Task`, `Execution`, `Checkpoint`, `TaskTree`, `EscalationRecord`, `ApprovalRequest`, `Message`, `Memory`). The developer never constructs these.

The single `createDeltaEngine` factory assembles all modules onto one returned object. The modules themselves stay decoupled: the facade is the only coupling point. Each method delegates to its own domain module. The factory is asynchronous (`await createDeltaEngine(...)`): it awaits the store's optional `ready()` gate before returning, so an adapter that needs async warm-up (open a connection, run migrations) can fail construction loudly instead of deferring the error to the first send.

## Storage Port Abstraction

The engine calls the `StoragePort` interface (`src/ports/storage-port.ts`) exclusively. Two adapters implement it:

- `createInMemoryStore`: volatile in-process store. Default for tests and quick experiments.
- `createDrizzleStore`: persistent Drizzle plus libsql store. For production.

The engine is stateless between `StoragePort` calls. Any state the engine computes at runtime is derived from the snapshot read back from the store. This is what makes pause, resume, and cross-instance persistence correct: a new engine instance on a different process or after a restart reads the same checkpoint and continues from the same state.

The storage port handles every entity the engine needs: tasks, task trees, executions, checkpoints, approval requests, escalation records, messages, memories, and queues. Every method returns `Result` so the engine handles storage failures explicitly rather than letting errors propagate silently.
