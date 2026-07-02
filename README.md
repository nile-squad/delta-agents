# delta-agents

A deterministic autonomous control plane for AI agents.

Delta Agents is the execution layer between a reasoning model and the real world. The model plans and proposes. The engine validates, authorizes, supervises, and audits. Every real action passes through one gateway, governed by explicit state, budget, risk, and authorization constraints, with human oversight available at every step.

The model is responsible for reasoning. The engine is responsible for governance.

## The Problem

Large language models are probabilistic reasoners operating in partially observable environments. They are strong at planning and language and weak at guarantees. A model cannot promise it will stay inside a budget, refuse an unsafe action, respect an authorization boundary, or follow a workflow in order. Those properties are not learned reliably. They have to be enforced.

Most agent frameworks hand the model a large set of tools and trust it to behave. This produces three recurring failures:

- Invalid actions, where the agent calls a tool in a state where it makes no sense.
- Unbounded cost, where reasoning spirals, retry storms, and runaway delegation consume resources with no progress.
- Silent risk, where an irreversible action runs with no approval gate and no audit trail.

Delta Agents removes these failure classes structurally rather than asking the model to avoid them.

## The Core Idea

The agent may propose actions. Only the engine may authorize them.

Safety checks, policy enforcement, budget accounting, risk scoring, authorization gates, and workflow transitions live in the engine. They are deterministic, auditable, and independent of model capability. The model never gains direct access to a capability. It requests an action, and the engine decides.

This separation means governance does not improve or degrade with the model. A weaker model is still safe. A stronger model is still bounded.

## Install

```
pnpm add delta-agents
```

Requirements: TypeScript 5 or later.

## Quick Example

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

The engine also governs multi-phase workflows, delegation between agents, human approval gates, tools, memory, and multimodal input (images, audio, and files attached to a goal) — all through the same execution gateway. See the full guide (`packages/web/docs/guide/`) for the complete picture.

## Mathematical Foundations

Delta Agents is built on established results from control theory, decision theory, and statistical estimation. Each foundation maps to a concrete governance behavior in the engine.

- **Bounded state-space model.** Execution is movement through a finite set of valid states and transitions. An action outside the current state-space does not exist.
- **Markov constraints.** The legality of the next action depends only on the current state, never on historical replay. Decisions are stateless and reproducible.
- **Bellman optimization.** Path, retry, escalation, and delegation decisions are evaluated as immediate cost plus expected future cost.
- **Model predictive control.** The engine evaluates a finite future trajectory before allowing an action and stops prediction at epistemic boundaries such as data retrieval. Preventing failure is cheaper than recovering from it.
- **Kalman state estimation.** Execution health is continuously estimated from predicted and observed progress, time, and token consumption. Declared anticipated cost and risk seed the estimator with a prior.
- **Bayesian updating.** Trust, confidence, and risk are revised continuously from observed evidence. Trust is never static.
- **Bayesian surprise.** The engine measures divergence between expected and observed outcomes. High divergence raises oversight requirements.
- **Asymmetric reputation decay.** Trust accrues slowly and is lost quickly. Unexpected failures incur larger penalties than successes earn rewards.
- **Cost friction detection.** High resource consumption with low state advancement signals instability such as infinite loops or reasoning spirals.

## How Execution Works

Each incoming request becomes a task. Every action the agent requests passes through the same pipeline:

```
Incoming goal
  -> Create TaskID
  -> Assign Agent
  -> Agent Reasons (or Workflow runs)
  -> Agent Requests Action
  -> Validate Schema
  -> Check Prerequisites
  -> Risk Check
  -> Budget Check
  -> MPC Horizon Check
  -> Approval Check
  -> Execute fn()
  -> Record Execution
  -> Trust and Risk Update
  -> Checkpoint
  -> Continue
```

The TaskID is the unit of governance. Authorization, budgeting, auditing, checkpointing, delegation, messaging, and supervision are all attached to it.

## Documentation

The full guide covers actions, agents and workflows, human oversight and approvals, tools and memory, delegation and teams, the execution gateway, attachments and multimodal input, the cost model, storage/model/channel adapters, and the complete API and type reference. It lives in `packages/web/docs/guide/` (an [rspress](https://rspress.dev) site — run it locally with `pnpm --filter delta-agents-docs dev`).

This README stays intentionally short. Everything below the surface — mechanics, field-by-field references, and internals — lives in the guide.

## Status

Pre-1.0. The specification is stable. The core engine, governance math, supervision strategies, workflow execution, delegation, channels, memory retrieval, tools, multimodal input, and human oversight are all implemented and tested. The API shape is final. Breaking changes before 1.0 will be documented.

Install with `pnpm add delta-agents` to use the current build. The canonical specification is [delta-agents.spec.md](./docs/internal/delta-agents.spec.md).

## License

MIT
