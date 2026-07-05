# delta-agents

**The AI agents framework with built-in safety, governance and provenance.**

Agents that don't drift. Agents that follow operating procedures even when the model hallucinates. Every agent operation runs through a governance engine that validates, authorizes, supervises, and audits before anything reaches the outside world.

The model proposes. The engine disposes. Budget enforcement, schema validation, risk scoring, trust estimation, and loop detection happen structurally, not by prompt engineering. An agent cannot skip a prerequisite, exceed a budget, or call an action it was not assigned, no matter what the model does.

When the agent is doing well, it runs without intervention. On drift, the engine guides it back or blocks until a human reviews. The engine auto-corrects when safe to do so. It escalates when human judgment is needed.

Full documentation at [delta.nilesquad.com](https://delta.nilesquad.com).

## What you get

**Governance firewall:** Prerequisites validate before actions execute: an agent cannot ship an order before confirming it. Schema enforcement catches malformed input before the action function runs. Budgets cap spend at the engine level, not by prompting.

**Human oversight:** A task mid-flight can be inspected, approved, or rejected with corrective feedback. The engine escalates when it cannot decide safely.

**Guaranteed behavior:** Workflows defined as action sequences retry on failure, resume from checkpoints, and never degrade across model versions. The same SOP runs identically on any model.

**Multi-agent teams:** Agents delegate to each other with scoped budgets. Communication via mailboxes with read receipts: senders see when a message was read. A live roster tracks load across the team, preventing overload.

**Memory that works:** Agents read context from past tasks automatically, so they do not repeat mistakes or re-ask for the same information. They take notes on completed work and improve next time.

**Full traceability:** Every action, decision, and token is queryable. Trust and risk revise from observed behavior, so reliable agents get more autonomy and risky agents get more oversight.

**Tools on the same pipeline:** Web search (Exa), document extraction (PDF, images, Office), and custom integrations run through the same budget and audit pipeline as actions. Tools inform the model without changing state.

**Your model, your provider:** OpenAI, OpenRouter, any OpenAI-compatible endpoint. Per-agent model selection: fast model for routine tasks, reasoning model for complex ones, with no code changes to switch.

**Channel support:** Slack, Teams, Discord, Telegram. One deployment serves all platforms. Agent execution is decoupled from delivery, so agents work independently of channel availability.

## Install

>> Free · Fully open source (MIT) · Type safe · Works with Node, Bun, and Deno.

```
pnpm add delta-agents
```

Requires TypeScript 5+.

## Quick Start

```ts
import { createDeltaEngine, Ok } from "delta-agents";
import { z } from "zod";

const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
});

const lookupCustomer = delta.action({
  name: "lookup-customer",
  description: "Look up a customer account by ID",
  risk: 1,
  schema: z.object({ customerId: z.string() }),
  fn: async ({ customerId }) => Ok(await db.customer.find(customerId)),
});

const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles customer support requests",
  role: "Customer Support Specialist",
  rolePrompt: "Help customers resolve their issues.",
  actions: [lookupCustomer],
});

delta.deploy(supportAgent);

const result = await delta.send({
  goal: "Look up customer C-42",
  agentName: "support-agent",
  input: { customerId: "C-42" },
  budget: { tokens: 5000, durationMs: 30_000 },
});
```

## Human in the Loop

```ts
delta.events.on("approval-requested", async ({ taskId, approvalId }) => {
  const approved = await reviewInDashboard(taskId, approvalId);
  if (approved) {
    await delta.approve(approvalId);
  } else {
    await delta.reject(approvalId, "use a different carrier");
  }
});
```

## Multi-Agent Delegation

```ts
const lead = delta.agent({ name: "lead", ... });
const worker = delta.agent({ name: "worker", ... });
delta.deploy(lead);
delta.deploy(worker);

// Lead mentions @worker to delegate subtasks automatically
const result = await delta.send({
  goal: "Research competitor pricing and draft a report",
  agentName: "lead",
  budget: { tokens: 200_000, durationMs: 120_000 },
});
```

## Contributing

Bug reports, feature requests, and pull requests welcome at [github.com/nile-squad/delta-agents](https://github.com/nile-squad/delta-agents).

## License

MIT
