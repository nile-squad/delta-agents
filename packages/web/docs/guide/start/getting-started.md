---
title: Getting Started
description: Install delta-agents and run your first governed agent
---

# Getting Started

delta-agents is a deterministic governance and control-plane engine for AI agents. A reasoning model proposes actions; the engine validates, authorizes, supervises, and audits every real action through one execution gateway.

## Installation

```bash
pnpm add delta-agents
```

Requirements: TypeScript 5 or later.

## Create the Engine

`createDeltaEngine` is asynchronous. It returns one object that is the entire developer surface: authoring methods to define actions, workflows, and agents, and runtime methods to deploy and run them.

```ts
import { createDeltaEngine, Ok } from "delta-agents";
import { z } from "zod";

const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
  systemPrompt: "You are an Acme Corp agent. Always be helpful and concise.",
});
```

## Define an Action

An action is a named, schema-validated operation. `risk` (1 to 5) and `requiresApproval` tell the engine how to govern it.

```ts
const lookupCustomer = delta.action({
  name: "lookup-customer",
  description: "Look up a customer account by ID",
  risk: 1,
  schema: z.object({ customerId: z.string() }),
  fn: async ({ customerId }) => {
    const record = await db.customer.find(customerId);
    return Ok(record);
  },
});
```

## Define an Agent

An agent is a role with the actions and workflows it may use.

```ts
const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles customer support requests",
  role: "Customer Support Specialist",
  rolePrompt: "Help customers resolve their issues.",
  actions: [lookupCustomer],
});
```

## Deploy and Send a Goal

`deploy` activates an agent. `send` hands it a goal and runs it to completion or until it blocks on a human decision.

```ts
delta.deploy(supportAgent);

const result = await delta.send({
  goal: "Look up customer C-42",
  agentName: "support-agent",
  input: { customerId: "C-42" },
  budget: { tokens: 5000, durationMs: 30_000 },
});

if (result.isOk) {
  console.log(result.value.status); // "completed" | "blocked" | "failed" | "queued"
}
```

## Inspect the Audit Trail

`inspect` reads the full governance state for a task: the task record, executions, checkpoint, escalations, and pending approvals.

```ts
const inspection = await delta.inspect(result.value.taskId);
if (inspection.isOk) {
  const { task, executions, escalations, pendingApprovals } = inspection.value;
  console.log(task.trust.score, task.risk.currentRisk);
}
```

## Next Steps

- [Actions](/guide/basics/actions) — schemas, risk, and cost
- [Agents and Workflows](/guide/basics/agents-and-workflows) — phases, supervision, storylines, and structuring multi-step work
- [Attachments](/guide/basics/attachments) — sending images, audio, and files alongside a goal
- [Cost and Budget](/guide/basics/cost-and-budget) — the full multi-axis cost model
- [Human Oversight and Approvals](/guide/basics/human-oversight-and-approvals) — approval gates and escalation
- [Execution Gateway](/guide/internals/execution-gateway) — what every action passes through
- [API Overview](/guide/reference/api-overview) — the full `delta.*` method surface
- [Adapters](/guide/reference/adapters) — storage, models, and channels
