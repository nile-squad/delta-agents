# Execution Gateway

Every action a deployed agent requests passes through the same execution gateway before it runs. This page describes what the gateway guarantees, not how it is implemented.

## The Guarantee

The model may propose an action. Only the gateway decides whether it runs. Every proposal is checked in the same order, regardless of which agent, workflow, or model produced it:

1. **Schema validation.** The action's input is validated against its schema before anything else happens. Malformed input is rejected immediately.
2. **Legality.** The action must be reachable from the task's current state: nothing outside an agent's declared actions and workflows is ever discoverable or executable, and unmet prerequisites keep an action unreachable.
3. **Approval.** An action marked `requiresApproval: true` does not run until a human approves the pending request.
4. **Execution.** The action's function runs. A thrown error is caught and treated as a failure result; it never crashes the task.
5. **Trust and risk update.** The outcome updates the task's trust and risk estimates for every subsequent decision.
6. **Audit record.** One record is written for the execution: action name, input, outcome, cost, and timing, attributed to the task.

There is no second path to running an action. A bypass is not part of the design.

## Risk and Trust Are Continuous, Not Fixed

A declared `risk` (1 to 5) on an action is a starting prior, not a permanent label. The engine revises its risk estimate for a task continuously from observed behavior, and the estimate can rise above the declared prior when an action behaves unexpectedly. It never falls below the declared prior.

Trust works the same way in reverse: it starts at a neutral midpoint for a task, accrues slowly on repeated success, and drops quickly on failure or on behavior that diverges from what was expected. Trust dropping too far, or risk rising too far, triggers a human escalation, exactly like an explicit `requiresApproval` action does.

## Budget Is Enforced, Not Advisory

A `budget` passed to `send` is a multi-axis ceiling: tokens, wall-clock duration, and optionally memory and money. The gateway tracks spend against it on every axis the budget declares, and a workflow's anticipated cost is projected against the budget before the workflow runs, so a plan that is already known to exceed budget is blocked before it starts rather than partway through. See [Cost and Budget](/guide/basics/cost-and-budget) for the full multi-axis shape.

An action's `estimatedCost` seeds this projection as a prior. It shapes the engine's expectations; it does not cap what an action is allowed to cost.

## Governance Does Not Change With the Model

The gateway sits between the model and every real action, regardless of which model is configured or how capable it is. A weaker model is still bounded by the same schema checks, approval gates, and budget; a stronger model gains no shortcut around them. Swapping models never changes what is guaranteed.

## Auditability

Every execution, approval request, and escalation is attributed to the task that produced it and readable in full through `delta.inspect(taskId)`. Nothing the gateway does is invisible to that call.

See [Human Oversight and Approvals](/guide/basics/human-oversight-and-approvals) for how approvals and escalation work from the caller's side.
