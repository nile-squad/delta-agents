# Actions

An action is a named, schema-validated operation that an agent may propose. The agent never executes an action directly; it requests one, and the engine's execution gateway decides whether to run it.

## Defining an Action

```ts
import { createDeltaEngine, Ok, Err } from "delta-agents";
import { z } from "zod";

const delta = await createDeltaEngine({
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
});

const issueRefund = delta.action({
  name: "issue-refund",
  description: "Issue a refund for an order. Moves real money.",
  risk: 4,
  requiresApproval: true,
  schema: z.object({
    orderId: z.string(),
    amount: z.number().positive(),
    reason: z.string(),
  }),
  fn: async ({ orderId, amount, reason }) => {
    const receipt = await refundOrder(orderId, amount);
    return Ok(receipt);
  },
});
```

`delta.action(def)` returns the definition. It does not run anything; execution happens later, when a deployed agent requests the action and the engine authorizes it.

## Fields

| Field | Type | Meaning |
|-------|------|---------|
| `name` | `string` | Unique action name. |
| `description` | `string` | What the action does. Read by the model to decide when to propose it. |
| `schema` | `z.ZodTypeAny` | Validates the action's input before anything else runs. |
| `fn` | `(input, ctx) => Promise<Result>` | The function that executes. Must return `Ok(value)` or `Err(message)`. |
| `risk` | `1 \| 2 \| 3 \| 4 \| 5` | Optional anticipated risk prior. Higher values start the engine's health and risk estimators more cautiously. |
| `requiresApproval` | `boolean` | Optional. When `true`, the action blocks until a human approves it. |
| `estimatedCost` | `Cost` | Optional anticipated cost prior (tokens, duration, memory, latency, money). Seeds the engine's cost estimator; not a ceiling. |
| `prerequisites` | `{ actions?: string[]; workflows?: string[] }` | Optional. Other actions or workflows that must complete before this action becomes available. |

## The Result Pattern

Every `fn` returns a `Result`: `Ok(value)` on success or `Err(message)` on failure. There is no throwing to signal a business failure; a thrown error is caught by the engine and treated as `Err`.

```ts
fn: async ({ customerId }) => {
  const record = await db.customer.find(customerId);
  if (record === null) return Err(`no customer found with id "${customerId}"`);
  return Ok(record);
},
```

## Cost

`estimatedCost` declares a prior for a multi-axis cost vector:

```ts
type Cost = {
  tokens: number;
  durationMs: number;
  memory?: number;
  latency?: number;
  money?: { value: number; currency: string };
};
```

A declared cost is a prior that seeds the engine's estimator, never a hard ceiling. See [Cost and Budget](/guide/basics/cost-and-budget) for the full model and [Human Oversight and Approvals](/guide/basics/human-oversight-and-approvals) for how budgets and approvals interact.

## Prerequisites

An action can require other actions or workflows to complete first. While unsatisfied, the action is not discoverable by the agent and cannot be executed.

```ts
const processOrder = delta.action({
  name: "process-order",
  description: "Process a confirmed order",
  schema: z.object({ orderId: z.string() }),
  prerequisites: { actions: ["confirm-order"] },
  fn: async ({ orderId }) => {
    return Ok({ processed: true });
  },
});
```

The engine validates prerequisite names when the action is defined. An unknown name fails immediately rather than silently at runtime.
