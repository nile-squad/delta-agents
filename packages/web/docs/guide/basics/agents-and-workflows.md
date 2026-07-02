# Agents and Workflows

## Agents

An agent is a role: a name, a description, and the actions and workflows it is allowed to use. Defining an agent does not start it; `delta.deploy(agent)` activates it, and only a deployed agent can accept a goal through `delta.send(...)`.

```ts
const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles order support requests",
  role: "Order Support Specialist",
  rolePrompt: "Help customers resolve order issues. Look up the order first, then decide whether a refund is warranted.",
  actions: [lookupOrder, issueRefund],
});

delta.deploy(supportAgent);
```

An agent references a model by name through `model`. Omitting `model` uses the engine's default model. `delta.agent()` validates the model name immediately; an unknown name throws before any task runs.

## Sending a Goal

```ts
const result = await delta.send({
  goal: "Look up order ORD-1042 and refund the customer, the item arrived damaged.",
  agentName: "support-agent",
  budget: { tokens: 5000, durationMs: 30_000 },
});
```

`send` returns `Ok(SendResult)`. `SendResult.status` is one of:

- `completed` — all actions finished.
- `blocked` — waiting on a human decision (see [Human Oversight and Approvals](/guide/basics/human-oversight-and-approvals)).
- `failed` — non-recoverable failure.
- `queued` — the agent already had an active task, so the goal was attached to it. No new task was created.

An agent owns at most one active top-level task at a time; a second `send` call while one is running queues rather than starting a parallel task.

## Workflows and Phases

A workflow is an ordered procedure composed of phases. Phases are plain objects passed directly in the `phases` array; there is no separate factory function for a phase.

```ts
const customerSupport = delta.workflow({
  name: "customer-support",
  description: "Standard customer support procedure",
  version: "1",
  phases: [
    {
      name: "investigation",
      description: "Look up the customer record",
      actions: ["lookup-customer"],
      checkpoint: true,
      supervision: { strategy: "retry", maxRetries: 3 },
    },
    {
      name: "communication",
      description: "Send a response to the customer",
      actions: ["notify-customer"],
      checkpoint: true,
      supervision: { strategy: "escalate", maxRetries: 0 },
    },
  ],
});

const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles customer support requests",
  role: "Customer Support Specialist",
  rolePrompt: "Help customers resolve their issues.",
  actions: [lookupCustomer, notifyCustomer],
  workflows: [customerSupport],
});
```

Reference the workflow by name in `send`:

```ts
await delta.send({
  goal: "Look up customer C-42 and notify them their order shipped",
  agentName: "support-agent",
  workflow: "customer-support",
  input: { customerId: "C-42", message: "Your order has shipped." },
});
```

If no `workflow` is given, the agent reasons freely over its available actions instead of following a fixed phase order.

### Phase Fields

| Field | Meaning |
|-------|---------|
| `name` | Unique phase name within the workflow. |
| `description` | What this phase accomplishes. |
| `actions` | Action names available in this phase, run in order (see branching below). |
| `checkpoint` | When `true`, the engine writes a recoverable checkpoint after this phase completes. |
| `supervision` | Optional. What the engine does if this phase fails; see below. |

### Supervision Strategies

When a phase fails, the engine applies the phase's declared strategy:

| Strategy | Behavior |
|----------|---------|
| `retry` | Resume the phase from the action that failed, keeping prior progress. |
| `restart` | Re-run the phase from the beginning. |
| `resume` | Re-run from the latest checkpoint, or fall back to restart if none exists. |
| `escalate` | Pause the task and raise a human escalation. |
| `abort-subtree` | Abort this task and its delegated subtasks. Siblings and the root keep running. |
| `abort-tree` | Abort the entire task tree from the root. |

```ts
{
  name: "risky-step",
  description: "Step with retry on transient failures",
  actions: ["call-external-api"],
  checkpoint: true,
  supervision: { strategy: "retry", maxRetries: 5 },
}
```

### Branching

By default, actions in a phase run sequentially. A branch node routes to the next action based on the prior action's outcome, or on a guard condition:

```ts
const phase = {
  name: "fulfillment",
  description: "Fulfill and ship the order",
  checkpoint: true,
  actions: [
    "prepare-shipment",
    {
      action: "ship-order",
      onSuccess: "notify-customer",
      onFailure: "escalate-to-human",
    },
    "notify-customer",
    "escalate-to-human",
  ],
};
```

```ts
{
  action: "check-inventory",
  when: (ctx) => ctx.agentName === "warehouse-agent",
  onSuccess: "reserve-stock",
}
```

When a guard returns false, the branch is skipped and the next action in the list runs. Branching is always explicit; the engine never invents a transition that was not declared.

## Storylines

A storyline is a free-prose narrative of the ideal user flow, separate from `description`. `description` says what a workflow or phase does; `storyline` says how it should feel. It lives on `Workflow` (the whole-arc narrative) and `Phase` (a beat within that arc), and reaches action functions and hooks through `ActionContext` at runtime — `ctx.storyline` for the workflow-level arc, `ctx.phaseStoryline` for the current phase's beat.

```ts
const onboarding = delta.workflow({
  name: "onboarding",
  description: "Guide a new user through setup",
  storyline: "User signs up, agent welcomes them, walks through one key feature, confirms they're ready, and leaves the door open for questions.",
  phases: [
    {
      name: "welcome",
      description: "Greet the user",
      storyline: "Greet warmly, keep it short, invite the first step — don't dump the whole manual.",
      actions: ["send-welcome"],
      checkpoint: true,
    },
  ],
});

const sendWelcome = delta.action({
  name: "send-welcome",
  description: "Send the welcome message",
  schema: z.object({ userId: z.string() }),
  fn: async ({ userId }, ctx) => {
    const tone = ctx.phaseStoryline ?? "friendly and concise";
    return Ok("sent");
  },
});
```

Storylines are optional and free-form. In the free reasoning loop (no `workflow` on `send`), both `ctx.storyline` and `ctx.phaseStoryline` are `undefined` — there is no workflow to narrate.

## Data Sources

A data source is a named, owned store of governed CRUD operations (`retrieve`, `create`, `update`, `delete`). Each operation is a full action, so a data read or write is governed exactly like any other action.

```ts
const userDb = delta.dataSource({
  name: "user-db",
  description: "the application user store",
  ownership: "internal",
  contentType: "application/json",
  actions: {
    retrieve: {
      name: "user-db.retrieve",
      description: "read a user record by id",
      schema: z.object({ id: z.string() }),
      risk: 2,
      fn: async ({ id }) => Ok(await db.users.find(id)),
    },
  },
});

const agent = delta.agent({
  name: "support-agent",
  description: "answers user questions",
  role: "Support",
  rolePrompt: "Help the user.",
  actions: [],
  dataSources: [userDb],
});
```

Once attached, a data source's operations are flattened into the agent's reachable action set and can be referenced by name in a workflow phase, exactly like any other action. An `ownership: "external"` data source starts from a more cautious risk prior; it earns trust through a track record rather than starting fully trusted.
