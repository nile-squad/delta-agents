# Diagnostics

This document covers the governance math the engine runs on every action step, the signals it produces, and the audit surface available to callers. All of these mechanisms are live in the execution path.

See [delta-agents.spec.md](../internal/delta-agents.spec.md) for the canonical specification.

## Execution Health: Kalman State Estimation

The engine maintains a continuous estimate of execution health across the lifetime of a task. The estimate is a scalar in `[0, 1]`:

- 1.0 means perfectly on track: progress is proportional to cost.
- 0.0 means severely off track: budget is being consumed with no advancement.

The estimate is tracked in a `KalmanState` (`src/governance/types.ts`), which carries two values: `estimate` (the current best health estimate) and `errorVariance` (how uncertain the estimator is about that estimate). A higher variance means the estimator gives more weight to new observations; a lower variance means it trusts its prior more.

The estimator is seeded at the first step using the action's declared `risk` and `estimatedCost` when available:

- A declared `risk` (1 to 5) lowers the initial health estimate proportionally. Higher anticipated risk means the engine starts with a lower health expectation.
- A declared `estimatedCost` tightens the initial variance. A calibrated prior reduces how many observations are needed to converge.

No declared priors means a cold start: estimate 1.0, high variance.

After each action runs, `kalmanUpdate` (`src/governance/kalman-estimator.ts`) blends the prior estimate with the observed health using a Kalman gain computed from the current variance and fixed noise parameters (`processNoise: 0.01`, `measurementNoise: 0.1`). The updated `KalmanState` is stored back on the `TaskStateSnapshot` so the estimator warms up across steps and survives pause and resume. The Kalman state is serialized inside the checkpoint `JsonRecord`.

### Health observation

`computeHealthObservation` computes the observation value fed to the Kalman update:

```
health = progressRatio / costRatio
```

In the free reasoner loop, `progressRatio` is `completedActionsCount / (stepIndex + 1)`. This rises toward 1 when each step completes genuinely new work and falls during retry storms or loops where many steps are attempted but few complete.

`costRatio` is the average of the token and duration fractions of the budget consumed. Health of 1.0 means progress and cost are perfectly proportional. Health returns 1.0 when no cost has been spent yet (no observation to make).

## Cost Friction Detection

Cost friction measures how much resource is being consumed relative to how much work is advancing. A high cost-to-progress ratio signals instability: infinite loops, retry storms, or reasoning spirals.

`detectFriction` (`src/governance/cost-friction.ts`) computes:

```
frictionRatio = avgCostRatio / progressRatio
```

`avgCostRatio` is the average of the token and duration fractions of the budget spent. `progressRatio` is the caller-supplied advancement measure.

Edge cases:

- Zero cost with any progress: `frictionRatio` is 0, not unstable.
- Non-zero cost with zero progress: capped at 10 and flagged as unstable immediately. Reason: "cost consumed with no measurable progress."
- Zero cost with zero progress: no information, not flagged.

The threshold for instability is `FRICTION_THRESHOLD = 2.5`. The friction ratio is capped at 10 for arithmetic safety and then normalized to `[0, 1]` (divided by 10) before being fed into risk evidence.

Cost friction scores every axis the budget declares. `tokens` and `durationMs` are always present; `memory` and `latency` are included in `avgCostRatio` only when the budget sets a limit for them. An undeclared axis is unlimited and never treated as zero, so it does not dilute the ratio. A budget of `{ tokens, durationMs }` scores exactly those two; a budget that also declares `memory` scores three.

## The Multi-Axis Cost Vector

`Cost` (`src/shared/types.ts`) is a four-axis resource vector:

```ts
type Cost = {
  tokens: number;
  durationMs: number;
  memory?: number;
  latency?: number;
};
```

`tokens` and `durationMs` are always present. `memory` and `latency` are optional.

Key properties of the cost arithmetic (`src/shared/cost.ts`):

- `addCosts`: the optional axes appear in the result only when at least one operand carries them. Adding two plain `{ tokens, durationMs }` costs yields a plain `{ tokens, durationMs }` cost, not a result with spurious zero axes.
- `isOverBudget`: enforces an axis only when the budget declares a limit for it. A budget of `{ tokens: 5000, durationMs: 30_000 }` is unlimited on memory and latency. Undeclared axes are never treated as zero.
- `remainingCost`: returns headroom only for the axes the `total` budget declares.

### How cost flows through the live path

The execution gateway builds `actualCost` from the model's reported `reasoningCost` (tokens, and optionally memory and latency reported by the adapter) and the `fn()` wall-clock duration. The full four-axis cost is folded into `spent` on the snapshot.

Communication dispatch measures the `sendMessage` round-trip and returns it as a `latency` cost, which the scheduler charges to `spent`. The OpenAI adapter reports the API round-trip time as `reasoningCost.latency`.

The MPC projection in `projectHorizon` (`src/governance/value.ts`) discounts and projects all four axes, so a workflow projected to exceed a memory budget is pre-blocked before execution starts.

Child budget scoping via `enforceSubtaskScope` clamps all declared axes on a per-axis basis.

## Trust: Bayesian Updating with Asymmetric Decay

Trust is the engine's statistical confidence that an agent will produce correct, safe, in-scope outcomes. It starts at 0.5 (the midpoint, no evidence), and is revised continuously from observed outcomes.

`TrustState` (`src/shared/types.ts`) carries:

- `score`: the current trust level in `[0, 1]`.
- `successfulExecutions`: count of actions that returned `Ok`.
- `failedExecutions`: count of actions that returned `Err` or a surprise outcome.
- `surpriseEvents`: count of steps where the observed outcome diverged significantly from the predicted trajectory.

`updateTrust` (`src/governance/trust.ts`) applies one update per step. The update rates are defined in `TRUST_RATES`:

| Outcome | Effect |
|---------|--------|
| `"success"` | Slow accrual: `score += SUCCESS_RATE * (1 - score)`. `SUCCESS_RATE = 0.05`. Closes a small fraction of the gap to 1.0. |
| `"failure"` | Fast decay: `score *= (1 - FAILURE_RATE)`. `FAILURE_RATE = 0.25`. Multiplicative reduction. |
| `"surprise"` | Fastest decay: `score *= (1 - SURPRISE_RATE * (0.5 + 0.5 * magnitude))`. `SURPRISE_RATE = 0.40`. Scaled by the surprise magnitude. A surprise event always increments `surpriseEvents` and `failedExecutions`. |

Asymmetry is intentional. An agent that occasionally fails recovers slowly. The engine does not forget failures quickly just because a few successes follow.

### When surprise triggers a trust update

A step triggers the `"surprise"` trust outcome when `signals.surprise.isSignificant` is true, which requires the surprise magnitude to reach or exceed the `SURPRISE_THRESHOLD = 0.4` defined in `src/governance/types.ts`. This is below the escalation threshold of 0.7, so trust erodes before a full escalation is raised. The `"surprise"` outcome is applied even when `fn` returned `Ok`: unexpected behavior is a caution signal regardless of whether the action succeeded.

### Trust degradation and escalation

`isTrustDegraded` returns true when `trust.score < 0.3`. When degraded trust is detected in `checkEscalation`, the escalation trigger is `"trust-degradation"`, and the task is paused for human review. This fires at priority below `"bayesian-surprise"` and above `"budget-violation"`.

## Risk: Evidence-Based State

`RiskState` (`src/shared/types.ts`) carries:

- `staticRisk`: the normalized developer-declared prior, derived from the action's `risk` (1 to 5). A risk of 1 normalizes to 0.2; a risk of 5 normalizes to 1.0. Never changes after initialization.
- `currentRisk`: the engine's continuously updated estimate. Can exceed `staticRisk`. Floored at `staticRisk`, never below it.
- `predictedRisk`: `currentRisk * 1.15`, slightly pessimistic by design (MPC principle: prefer over-caution).
- `confidence`: starts at 0.1 (very low, no evidence), grows by 0.05 per step up to a cap of 0.99.
- `escalated`: set to true when the engine has raised an escalation for this task.

`updateRisk` (`src/governance/risk.ts`) blends three evidence inputs, all in `[0, 1]`:

```
evidenceRisk = frictionSignal * 0.3 + surpriseMagnitude * 0.4 + recentFailureRate * 0.3
newCurrentRisk = max(staticRisk, EMA(currentRisk, evidenceRisk, alpha=0.3))
```

The exponential moving average with momentum (`alpha = 0.3`) smooths out single-step spikes. The floor at `staticRisk` ensures the developer-declared prior is the minimum, never a ceiling.

A declared `risk: 1` on an action never prevents the engine from raising `currentRisk` to 0.9 if evidence warrants it.

### Risk escalation thresholds

`shouldEscalate` in `src/governance/risk.ts` returns true when `currentRisk >= 0.8` or `predictedRisk >= 0.9`. This is evaluated inside `checkEscalation` with priority above Bayesian surprise.

## Bayesian Surprise

Surprise measures the divergence between the expected and observed execution health. `computeSurprise` (`src/governance/surprise.ts`):

```
magnitude = |expected - observed| / (|expected| + epsilon)
```

`epsilon = 0.001` prevents division by zero when `expected` is near zero. The result is clamped to `[0, 1]`. `isSignificant` is true when `magnitude >= SURPRISE_THRESHOLD = 0.4`.

The expected value is the Kalman estimator's current `estimate`. The observed value is `computeHealthObservation(progressRatio, costRatio)` from this step. If the observed health diverges significantly from the estimator's prediction, surprise fires.

Surprise feeds into three outcomes in the gateway:

1. The `frictionSignal`, `surpriseMagnitude`, and `recentFailureRate` triple is fed to `updateRisk`.
2. When `isSignificant` is true (magnitude >= 0.4), the trust update outcome is `"surprise"` instead of `"success"` or `"failure"`.
3. The `surpriseMagnitude` is forwarded to `applyPostStepGovernance`, where `checkEscalation` raises an escalation when magnitude reaches 0.7.

## Escalation Priority and Triggers

`checkEscalation` (`src/oversight/escalation.ts`) evaluates signals in priority order and returns the first trigger that fires:

| Priority | Trigger | Condition |
|----------|---------|-----------|
| 1 | `risk-threshold` | `currentRisk >= 0.8` or `predictedRisk >= 0.9` |
| 2 | `bayesian-surprise` | `surpriseMagnitude >= 0.7` |
| 3 | `trust-degradation` | `trust.score < 0.3` |
| 4 | `budget-violation` | `spent.tokens > budget.tokens` or `spent.durationMs > budget.durationMs` |
| 5 | `policy-violation` | Explicit flag |
| 6 | `workflow-failure` | Explicit flag (raised by supervision `escalate` strategy) |
| 7 | `explicit` | Explicit flag |

Two triggers are raised directly rather than by `checkEscalation`'s signal ordering. `workflow-failure` is raised by the supervision `escalate` strategy. `reasoner-failure` is raised by the free reasoner loop when a model call still fails after its configured retries are exhausted (network error, rate limit, malformed output, or no tool call); the engine escalates instead of failing the task, so a transient upstream problem stays recoverable (configured via `providerRetry`, see the README).

When an escalation fires, `raiseEscalation` writes an `EscalationRecord` to the store (TaskID-attributable, never silent), the task is marked `"paused"`, and the execution loop returns `status: "blocked"`. The task stays paused until a human acts.

Every escalation event is auditable: the trigger, reason, and timestamp are persisted in the store and returned by `delta.inspect`.

## Audit Surface: inspect

`delta.inspect(taskId)` calls `inspectTask` (`src/engine/runtime.ts`), which reads all of the following in parallel from the store:

| Field | Contents |
|-------|---------|
| `task` | The full `Task` record: status, goal, budget, `risk`, `trust`, timestamps. |
| `executions` | All `Execution` records for this task: action name, start/end time, cost, and status for each run. |
| `latestCheckpoint` | The most recent `Checkpoint`, including the serialized `TaskStateSnapshot` (which carries `trust`, `risk`, `kalman`, `spent`, `completedActions`, and more). |
| `escalations` | All `EscalationRecord` entries for this task: trigger, reason, and timestamp for each escalation event. |
| `pendingApprovals` | All `ApprovalRequest` records with status `"pending"` for this task. |

All records are TaskID-attributable. There are no ungoverned side effects that would be invisible to `inspect`. Approval requests, escalations, executions, and messages are all written to the store at the moment they occur, not batched or deferred.
