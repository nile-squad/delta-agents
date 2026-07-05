# delta-agents

**The AI agents framework with built in safety, governance and provenance.**

Delta Agents is a framework and runtime for building production AI agents.

It prevents agents from drifting away from organizational policies and operating procedures by running every agent operation in a deterministic, math-backed governance engine. The model proposes actions; the engine validates, authorizes, supervises, audits and determines whether it is safe to proceed or not, guides the agent towards correctness and blocks if agent does not comply.

When the agent is doing well and following rules, you won't need to do anything. On drift however you can interact via human in the loop: inspect and approve or reject an agent's step with correction or the engine can auto correct it if safe to do so.

It also lifts the common plumbing teams need to build from scratch to achieve production-ready agents, reducing time to ship from months to minutes.

## Under the hood

Delta's governance engine is built on control theory, decision theory, and statistical estimation: bounded state-space models, Markov constraints, Bellman optimization, model predictive control, Kalman estimation, and Bayesian updating. Every governance decision is deterministic, provable, and auditable.

The full specification, mechanics, and architecture: [delta-agents.spec.md](./docs/internal/delta-agents.spec.md).

## Key Highlights

## Your agents can't go rogue.

No amount of prompt engineering can match a system that literally cannot execute an unsafe action. The governance firewall enforces every constraint structurally.

- Budget enforcement at the token, time and multi dimensional level
- Schema and prerequisite validation before every action, agent can't process an order for example before first confirming the order
- Risk scoring that gates high-stakes operations behind human approval, the engine is always watching and guiding on fly.
- Loop detection that catches reasoning spirals before they burn budget, trajectories that predict failure before it happens.

## Multi-agent teams that coordinate.

Agents delegate to other agents with scoped budgets. When network fails or an agent becomes unresponsive, automatic recovery handles retries, restarts, and escalations without manual intervention. Agents communicate through mailboxes with read receipts, so you know messages were delivered. A live roster tracks per-agent load across the team, preventing overload and enabling smart task distribution.

## Agents that remember.

Agents retrieve context from past tasks on demand, so they don't repeat mistakes or ask for the same information twice. Agents take notes on completed work and improve on the same tasks next time. Agents know what time it is and what happened recently, so they can make time-sensitive decisions and understand temporal context.

## Where your team is.

Delta supports messaging channels such as Slack, Teams, Discord, and Telegram, so agents can communicate through the platforms your team already uses. One deployment serves all platforms with cross-platform conversation continuity, so conversations flow seamlessly regardless of which channel the user switches to. Agent execution is decoupled from delivery, so agents work independently of channel availability.

## Workflows that don't drift.

Define multi-phase SOPs as sequences of actions — verify, process, confirm, update — and they run the same way every time, no matter what model is behind them. When something fails, recovery is automatic: retry from the failed step instead of restarting the entire workflow, restart the phase if state is corrupted, resume from where it left off after human approval, or escalate when human judgment is needed. Pause for human approval on high-risk operations, then resume from where it left off. No model drift. No unpredictable behavior.

## Full observability.

Every action, decision, and token is traceable and queryable, so you can debug issues, audit compliance, and understand agent behavior. Trust and risk are based on observed behavior — the engine revises them continuously from what actually happened, so reliable agents get more autonomy and risky agents get more oversight. Commit history tracks what was done, by whom, and when.

## Tools that work safely.

Web search via Exa for grounding agents in live information. Document extraction from PDFs, images, and Office files. Custom tools for connecting agents to external systems. Tools inform the model without changing business state, while still running through the same budget and audit pipeline as actions, so tool usage is tracked and controlled just like any other operation.

## Your model, your provider.

OpenAI, OpenRouter, any OpenAI-compatible endpoint. Per-agent model selection — fast model for routine tasks, reasoning model for complex ones — with no code changes to switch, so you can optimize cost and performance per agent. No lock-in. Vision and audio capabilities are declared per model and enforced at send-time, so a capability mismatch is caught before execution, not after, preventing wasted API calls and confusing errors.

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

if (result.isOk) {
  console.log(result.value.status); // "completed" | "blocked" | "failed" | "queued"
}
```

The agent is budget-enforced, risk-scored, audit-logged, and checkpoint-recoverable. The model cannot exceed the token budget, skip schema validation, or call an action it was not assigned. All enforced structurally, not by prompt engineering.

## Install

```
pnpm add delta-agents
```

Requirements: TypeScript 5 or later.

## Documentation

The full guide covers actions, agents, workflows, human oversight, tools, memory, delegation, channels, multimodal input, the cost model, and the complete API reference.

Read it at **[delta.nilesquad.com](https://delta.nilesquad.com)**. Source lives in [`packages/docs-web/content/docs/`](./packages/docs-web/content/docs/).

## Status

v1. The specification is stable and the API is final. The core engine, governance math, supervision strategies, workflow execution, delegation, channels, memory retrieval, tools, multimodal input, and human oversight are implemented and tested.

## License

MIT
