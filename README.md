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

// Create the engine once. Adapters and limits are configured here. Creation is
// awaited so the engine can gate on its store being ready (open a connection,
// run migrations) before it serves a single request.
const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [
    { name: "fast", model: "gpt-4o-mini", default: true },
  ],
});

// Define an action: a named, schema-validated, governed operation.
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

const notifyCustomer = delta.action({
  name: "notify-customer",
  description: "Send a notification to a customer",
  risk: 2,
  requiresApproval: true,
  schema: z.object({ phone: z.string(), message: z.string() }),
  fn: async ({ phone, message }) => {
    await messaging.send(phone, message);
    return Ok("sent");
  },
});

// Define a workflow: an ordered procedure composed of phases.
const customerSupport = delta.workflow({
  name: "customer-support",
  description: "Standard customer support procedure",
  version: "1",
  phases: [
    delta.phase({
      name: "investigation",
      description: "Look up the customer record",
      actions: ["lookup-customer"],
      checkpoint: true,
      supervision: { strategy: "retry", maxRetries: 3 },
    }),
    delta.phase({
      name: "communication",
      description: "Send a response to the customer",
      actions: ["notify-customer"],
      checkpoint: true,
      supervision: { strategy: "escalate", maxRetries: 0 },
    }),
  ],
});

// Define an agent: a role with the actions and workflows it may use.
const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles customer support requests",
  role: "Customer Support Specialist",
  rolePrompt: "Help customers resolve their issues.",
  actions: [lookupCustomer, notifyCustomer],
  workflows: [customerSupport],
});

// Deploy activates the agent. A defined-but-not-deployed agent cannot accept tasks.
delta.deploy(supportAgent);

// Send a goal. The engine creates a task, runs the workflow, and returns when done.
const result = await delta.send({
  goal: "Look up customer C-42 and notify them their order shipped",
  agentName: "support-agent",
  workflow: "customer-support",
  input: { customerId: "C-42", phone: "+1-555-0100", message: "Your order has shipped." },
  budget: { tokens: 5000, durationMs: 30_000 },
});

if (result.isOk) {
  console.log(result.value.status); // "completed" | "blocked" | "failed" | "queued"

  // Read the full governance state: task record, executions, checkpoint,
  // escalations, and pending approvals.
  const inspection = await delta.inspect(result.value.taskId);
  if (inspection.isOk) {
    const { task, executions, escalations, pendingApprovals } = inspection.value;
    console.log(task.trust.score, task.risk.currentRisk);
  }
}
```

## Two-Tier API

The developer surface is split into authoring methods and runtime methods. Authoring defines capabilities; the engine owns execution.

### Authoring methods

These methods define what an agent can do. They return the definitions you pass back to the engine.

| Method | Purpose |
|--------|---------|
| `delta.action(def)` | Define a named, schema-validated operation. Returns the definition. |
| `delta.workflow(def)` | Define an ordered procedure composed of phases. Returns the definition. |
| `delta.phase(def)` | Define a phase within a workflow. Returns the definition. |
| `delta.dataSource(def)` | Define a named, owned store of governed CRUD operations. Returns the definition. |
| `delta.agent(def)` | Define a role with its allowed actions, workflows, data sources, skills, and channels. Returns the definition. |

### Runtime methods

These methods drive execution. The engine creates and owns all runtime state.

| Method | Purpose |
|--------|---------|
| `delta.deploy(agent)` | Activate a defined agent. Required before `send`. |
| `delta.send(input)` | Hand a goal to a named agent and run it to completion or until blocked. Returns `SendResult`. |
| `delta.approve(approvalId)` | Approve a pending human approval request. Call `resume` after approving. |
| `delta.pause(taskId)` | Suspend a running task and write a checkpoint. |
| `delta.resume(taskId)` | Resume a paused or blocked task from its latest checkpoint. |
| `delta.inspect(taskId)` | Read the full governance state: task, executions, checkpoint, escalations, approvals. |
| `delta.lastTask(agentName)` | Return the most recent task for a named agent. |

`send` returns `Ok(SendResult)` on success. `SendResult.status` is one of:

- `completed`: all actions finished.
- `blocked`: waiting on a human decision (approval or escalation).
- `failed`: non-recoverable failure.
- `queued`: the agent was already busy, so the goal was attached to its existing task. No new task was created.

## Supervision Strategies

Each workflow phase can declare a supervision policy. When a phase fails, the engine applies the strategy:

| Strategy | Behavior |
|----------|---------|
| `retry` | Resume the phase from the action that failed, keeping prior progress. |
| `restart` | Re-run the phase from the beginning, from the phase entry state. |
| `resume` | Re-run from the latest checkpoint state, or fall back to restart when no checkpoint exists. |
| `escalate` | Pause the task and raise a human escalation. Execution stops until a human acts. |
| `abort-subtree` | Abort this task and all its delegated subtasks. |
| `abort-tree` | Abort the entire task tree from the root. |

```ts
delta.phase({
  name: "risky-step",
  description: "Step with retry on transient failures",
  actions: ["call-external-api"],
  checkpoint: true,
  supervision: { strategy: "retry", maxRetries: 5 },
});
```

## Teams

An agent has a role and can belong to a team. Teams scope collaboration: an agent may only delegate work to, or mention, agents that share its `team`. An agent with no team treats every other agent as an available peer (teams are opt-in).

```ts
const researcher = delta.agent({ name: "researcher", role: "Researcher", team: "support", /* ... */ });
const writer = delta.agent({ name: "writer", role: "Writer", team: "support", /* ... */ });
```

Within a team an agent can interact two ways:

- **Delegate** a scoped sub-goal to a teammate, which creates a bounded child task the teammate owns.
- **Mention** a teammate to leave them a note, without handing off work. A mention records a TaskID-attributable agent-to-agent message (it spawns no child task) and is delivered into the teammate's reasoning context the next time they run, exactly once.

Both are scoped at the engine, not just hidden from the model: a delegation or mention that targets an agent outside the team is rejected.

## Skills

An agent can carry skills: named, reusable capability descriptions with a `path` to their content (a playbook, a policy, a prompt snippet). Active skills are surfaced to the reasoner. The library does not assume a filesystem, so to load a skill's `path` content you provide a loader; without one, skills are still surfaced by name and description.

```ts
import { readFile } from "node:fs/promises";

const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "default", model: "gpt-4o-mini", default: true }],
  loadSkill: async (skill) => {
    try {
      return Ok(await readFile(skill.path, "utf8"));
    } catch (e) {
      return Err(String(e)); // non-fatal: the skill is still offered by name
    }
  },
});
```

## Cost Model

Cost is a multi-axis vector. The engine tracks and enforces all declared axes:

```ts
type Cost = {
  tokens: number;     // model token usage
  durationMs: number; // wall-clock execution time in milliseconds
  memory?: number;    // memory footprint (developer-chosen unit)
  latency?: number;   // added delay beyond execution time, e.g. a network round-trip
};
```

A budget enforces only the axes it declares. A budget of `{ tokens: 5000, durationMs: 30_000 }` is unlimited on memory and latency. An action's `estimatedCost` is a prior that seeds the Kalman estimator. Declared values are priors, never ceilings.

```ts
delta.send({
  goal: "...",
  agentName: "support-agent",
  budget: { tokens: 5000, durationMs: 30_000, memory: 64 },
});
```

## Adapters

### Storage

```ts
import { createInMemoryStore, createDrizzleStore } from "delta-agents";

// In-memory (default): fast, isolated, lost on restart.
const store = createInMemoryStore();

// Drizzle + libsql: persistent.
const store = await createDrizzleStore("file:./delta.db");
// Or in-memory libsql:
const store = await createDrizzleStore();
```

### Models

Models are defined on the engine and referenced by agents. At least one must carry `default: true`.

```ts
const delta = await createDeltaEngine({
  // Engine-level defaults. Per-model values override these.
  endpoint: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  options: { temperature: 0.1 },

  models: [
    { name: "fast", model: "gpt-4o-mini", default: true },
    {
      name: "smart",
      model: "gpt-4o",
      options: { temperature: 0.3, topP: 0.9 },
    },
    {
      name: "local",
      model: "llama3.2",
      endpoint: "http://localhost:11434/v1",
      apiKey: "ollama",
    },
    {
      name: "reasoning",
      model: "o3-mini",
      endpoint: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      // no options — o-series reasoning models reject sampling params
    },
  ],
});
```

An agent references a model by name. Omitting `model` uses the engine default.

```ts
const researcher = delta.agent({ name: "researcher", model: "smart", /* ... */ });
const worker = delta.agent({ name: "worker", /* model omitted — uses default */ /* ... */ });
```

`delta.agent()` validates the model name immediately. An unknown name throws before any task runs.

For testing, use `createMockReasoner` with the `reasoner` override:

```ts
import { createMockReasoner } from "delta-agents";

const delta = await createDeltaEngine({
  reasoner: createMockReasoner({
    responses: [{ actionName: "greet", input: { name: "world" } }],
  }),
});
```

### Reasoner resilience

Models fail: a network error, a maxed-out rate limit, malformed JSON, or a turn that does not call a tool. Each reasoner step is retried with jittered exponential backoff. When the retries are exhausted the task does not fail outright; it escalates to a human (a `reasoner-failure` escalation, the task paused and resumable), so a transient upstream problem is recoverable rather than fatal.

```ts
const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "default", model: "gpt-4o-mini", default: true }],
  // Defaults: 3 attempts, 200ms base, 5s cap, 0.3 jitter. Partial overrides merge.
  reasonerRetry: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10_000 },
});
```

### Chat SDK channel bridge

Delta Agents is transport-agnostic. Wire any Chat SDK thread into a governed channel:

```ts
import { createChatSdkChannel } from "delta-agents";

// thread is any object with a .post(text: string) method.
const channel = createChatSdkChannel({ thread, type: "slack" });

const agent = delta.agent({
  name: "...",
  // ...
  channels: [channel],
});
```

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

## Authoring and Runtime Types

**Authoring types** (you define these):

| Type | Purpose |
|------|---------|
| `Action` | A single executable operation with a validation schema, optional anticipated risk and cost, optional prerequisites, and lifecycle hooks. |
| `Workflow` | An ordered set of phases describing a procedure. |
| `Phase` | A stage of a workflow with its actions, checkpoint flag, and supervision policy. |
| `DataSource` | A named, owned store of governed CRUD operations. External sources are less trusted by default. |
| `Agent` | A role with its actions, workflows, data sources, skills, and channels. |
| `Channel` | An inbound or outbound communication surface. |
| `Skill` | A reusable capability description attached to an agent. |
| `ModelDef` | A named model with its provider config, endpoint, API key, and options. |
| `ModelOptions` | Provider options forwarded to the model API: temperature, topP, maxTokens. |

**Runtime types** (the engine owns these, you read them via `inspect`):

| Type | Purpose |
|------|---------|
| `Task` | The unit of governance. Owns goal, budget, risk, trust, and audit history. |
| `Execution` | A single action run with cost and status. |
| `Checkpoint` | A recoverable state boundary. |
| `Cost` | Multi-axis resource measurement: tokens, duration, memory, latency. |
| `SupervisionPolicy` | Strategy and retry limit applied when a phase fails. |
| `Memory` | A retrieved-on-demand piece of agent context (spec principle 4). |

## Status

Pre-1.0. The specification is stable. The core engine, governance math, supervision strategies, workflow execution, delegation, channels, memory retrieval, and human oversight are all implemented and tested. The API shape is final. Breaking changes before 1.0 will be documented.

Install with `pnpm add delta-agents` to use the current build. The canonical specification is [delta-agents.spec.md](./delta-agents.spec.md).

## License

MIT
