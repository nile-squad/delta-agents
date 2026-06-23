# Core Principles

The eight principles the framework is built on, each paired with how the engine actually enforces it in code. The principle statements and their rationale are canonical (spec section Principles); the enforcement notes are the internal map from principle to mechanism, so a maintainer can see where a principle lives and what would break it.

The one sentence the rest follows from: the model reasons, the engine governs. Every principle below is a way of keeping enforcement in the deterministic engine and out of the probabilistic model.

See [delta-agents.spec.md](../../delta-agents.spec.md) for the canonical specification and [architecture.md](../architecture.md) for the system structure.

## 1. The Engine Owns Enforcement

The agent may propose actions. Only the engine may authorize them. Safety, policy, budget, risk, authorization, and workflow validation are enforced by the engine, not learned by the model.

**Why:** models are probabilistic; governance requires deterministic guarantees.

**How it is enforced:** every action runs through one ordered chokepoint, `runGateway` (`src/execution/execution-gateway.ts`): schema validation, legality, approval, before-hook, `fn`, trust and risk update, execution record. There is no second path to a capability. The model emits a `ReasonerDecision`; the engine routes it. Hooks observe and prepare but never authorize (invariant 22, prohibition 17).

## 2. The System Operates Within a Bounded State-Space

Every task exists within a finite set of valid states and transitions. Actions outside the current state-space do not exist.

**Why:** safety is mathematically tractable only when the action space is bounded.

**How it is enforced:** `checkLegality` (`src/state-space/check-legality.ts`) decides the next legal action from the current `TaskStateSnapshot` alone (a Markov property, no history replay). The reachable set is bounded by the agent definition: nothing outside `agent.actions` and `agent.workflows` is discoverable, and the `Registry` is read-only during execution. Contextual discovery never returns an out-of-state action.

## 3. Prediction Precedes Execution

Actions are evaluated against projected future states before execution.

**Why:** preventing failure is cheaper than recovering from it.

**How it is enforced:** the workflow path runs an MPC projection (`projectHorizon`, `src/governance/value.ts`) before execution: it sums declared `estimatedCost` in order and blocks a workflow whose known projected cost already exceeds the budget. Projection stops at the first epistemic boundary (an action with no declared cost), so the engine never pretends to see past an unknown (prohibition 14). Bellman value ranks candidate actions by immediate plus expected future cost.

## 4. Memory Is Retrieved, Not Carried

Agents retrieve context when needed; they do not permanently carry complete historical context.

**Why:** scalable systems retrieve on demand rather than holding unbounded working memory.

**How it is enforced:** memory is a stored, TaskID-attributable resource an agent writes via `ctx.remember` and retrieves on demand, not a growing context blob threaded through every step. A later task by the same agent can retrieve a memory it owns; nothing forces the whole history into the model's window.

## 5. Task Identity Is The Security Boundary

TaskID is the primary unit of governance. Authorization, auditing, budgeting, checkpointing, delegation, communication, and supervision are all attached to TaskIDs.

**Why:** work is performed by tasks, not by agents.

**How it is enforced:** every `Execution`, `Checkpoint`, `EscalationRecord`, `ApprovalRequest`, `Message`, and `Memory` carries its TaskID, and `inspectTask` (`src/engine/runtime.ts`) reads all of them back for one task in a single call. There are no ungoverned side effects: a record is written to the store at the moment it occurs. Budget authority is scoped by TaskID too, a subtask is blocked the moment its parent's budget is exhausted regardless of its own remaining budget.

## 6. Delegation Is Bounded

Delegation exists to reduce complexity. It must never create complexity.

**Why:** unbounded delegation creates exponential state growth and unpredictable resource consumption.

**How it is enforced:** the supervision tree is bounded to at most two active children per parent (`maxConcurrency: 2`, a literal), enforced by `requestSlot` / `releaseSlot` (`src/supervision/task-tree.ts`); further delegations queue FIFO. A child's budget is clamped to the parent's remaining headroom by `enforceSubtaskScope` (`src/supervision/scope.ts`), and the grant is debited from the parent immediately so two concurrent children cannot collectively exceed it. A failed root cascades an abort to all descendants via `abortEntireTree` (`src/supervision/abort.ts`).

## 7. Trust Is Statistical

Trust is earned through evidence and lost through evidence.

**Why:** observed outcomes are more reliable than self-reported confidence.

**How it is enforced:** trust starts at 0.5 and is revised every step by `updateTrust` (`src/governance/trust.ts`) with asymmetric decay (accrues slowly on success, drops fast on failure or surprise). Risk is evidence-based (`updateRisk`), execution health is tracked by a Kalman estimator, and Bayesian surprise measures divergence between expected and observed health. Declared `risk` and `estimatedCost` are priors that seed the estimators, never ceilings; evidence can raise risk above the declared level (invariant 23, prohibition 20). An external `DataSource` starts from a less-trusted risk prior and earns its standing through a successful track record (ADR-007).

## 8. Human Oversight Is Fundamental

The system never assumes perfect autonomy. Every task remains eligible for human intervention.

**Why:** unknown unknowns cannot be eliminated through automation.

**How it is enforced:** an action with `requiresApproval` blocks until a human resolves it, and `checkEscalation` (`src/oversight/escalation.ts`) raises an escalation on risk threshold, Bayesian surprise, trust degradation, budget violation, policy violation, or workflow failure, pausing the task. Every escalation and approval is written to the store, TaskID-attributable, and surfaced by `inspect`. `pause` and `resume` let a human stop and continue a task across process boundaries from the latest checkpoint.
