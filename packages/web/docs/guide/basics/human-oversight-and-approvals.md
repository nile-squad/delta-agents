# Human Oversight and Approvals

Every task remains eligible for human intervention. An agent can propose an irreversible or high-risk action, but the engine will not run it without a human decision when the action requires one, and it will pause a task on its own when its risk, trust, or budget signals cross a threshold.

## Requiring Approval

Mark an action `requiresApproval: true` to gate it behind a human decision:

```ts
const issueRefund = delta.action({
  name: "issue-refund",
  description: "Issue a refund for an order. Moves real money.",
  risk: 4,
  requiresApproval: true,
  schema: z.object({ orderId: z.string(), amount: z.number().positive(), reason: z.string() }),
  fn: async ({ orderId, amount, reason }) => {
    const receipt = await refundOrder(orderId, amount);
    return Ok(receipt);
  },
});
```

The model can propose `issue-refund`. The engine will not execute it until a human approves the pending request.

## The Approve, Resume Loop

When `send` reaches an action that requires approval and has no prior approval on record, the task blocks:

```ts
const result = await delta.send({
  goal: "Look up order ORD-1042 and refund the customer, the item arrived damaged.",
  agentName: "support-agent",
});

// result.value.status === "blocked"
```

Find the pending approval and resolve it through `inspect`:

```ts
const inspection = await delta.inspect(result.value.taskId);
const pending = inspection.value.pendingApprovals.find((a) => a.action === "issue-refund");

await delta.approve(pending.id);

const resumed = await delta.resume(result.value.taskId);
// resumed.value.status === "completed"
```

`delta.reject(approvalId)` denies a pending approval instead. `delta.pause(taskId)` and `delta.resume(taskId)` suspend and continue a task from its latest checkpoint at any other time, not only when blocked on approval.

## Escalation

The engine also pauses a task on its own, without a `requiresApproval` action being reached, whenever risk, trust, or budget signals cross a threshold:

- Current risk or predicted risk rises too high.
- Observed behavior diverges significantly from what was expected (a "surprise" event).
- Trust degrades below an acceptable level for the task.
- Spend exceeds the declared budget.
- A workflow phase's supervision strategy is `escalate` and the phase fails.

Any of these raises a human escalation and pauses the task, exactly like an approval gate. `inspect(taskId)` returns the escalation record alongside pending approvals so a human reviewer sees both in one place.

## Risk and Trust

`risk` (1 to 5) on an action is a declared prior, not a fixed value. The engine continuously revises its risk estimate from observed evidence during execution, and the estimate can rise above the declared prior if an action behaves unexpectedly, though it never drops below it.

Trust is tracked per task from observed outcomes. It starts at a neutral midpoint, rises slowly on repeated success, and drops quickly on failure or surprising behavior. `inspect` exposes both:

```ts
const { task } = inspection.value;
console.log(task.trust.score, task.risk.currentRisk);
```

## Budget

`send` accepts a `budget`, a multi-axis cost ceiling:

```ts
await delta.send({
  goal: "...",
  agentName: "support-agent",
  budget: { tokens: 5000, durationMs: 30_000, memory: 64 },
});
```

A budget only enforces the axes it declares. `{ tokens: 5000, durationMs: 30_000 }` is unlimited on memory and latency. An action's `estimatedCost` is a prior used to project whether a workflow is likely to exceed budget before it runs; it is not a ceiling on its own.

## Auditability

Every approval request, escalation, execution, and checkpoint is attributed to the task and readable through `delta.inspect(taskId)`. There are no side effects that bypass this audit trail.
