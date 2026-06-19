# Delta Agents

A deterministic autonomous control plane for AI agents.

Delta Agents is the execution layer that sits between a reasoning model and the real world. The model plans, reasons, and proposes. The engine validates, authorizes, supervises, and audits. Every real action passes through one gateway, governed by explicit state, budget, risk, and authorization constraints, with human oversight available at every step.

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

## Quick Example

The following shows the target authoring experience from the specification. The API is being implemented and the examples describe the intended shape, not yet shipped behavior. See **Status** below.

```ts
const delta = createDeltaEngine({
  // model provider, persistence, logging, and defaults
  // are configured once, here.
});

const lookupCustomer = delta.action({
  name: "lookup-customer",
  description: "Look up a customer account",
  // risk and estimatedCost are optional priors. Declare them when
  // you know something the engine would otherwise have to learn.
  risk: 1,
  schema: z.object({
    customerId: z.string(),
  }),
  fn: async ({ customerId }) => {
    return db.customer.find(customerId);
  },
});

const notifyCustomer = delta.action({
  name: "notify-customer",
  description: "Send a notification to a customer",
  risk: 2,
  schema: z.object({
    phone: z.string(),
    message: z.string(),
  }),
  fn: async ({ phone, message }) => {
    return messaging.send(phone, message);
  },
});

const customerSupport = delta.workflow({
  name: "customer-support",
  phases: [
    delta.phase({
      name: "investigation",
      checkpoint: true,
      actions: ["lookup-customer"],
    }),
    delta.phase({
      name: "communication",
      checkpoint: true,
      actions: ["notify-customer"],
    }),
  ],
});

const supportAgent = delta.agent({
  name: "support-agent",
  role: "Customer Support Specialist",
  actions: [lookupCustomer, notifyCustomer],
  workflows: [customerSupport],
});

delta.deploy(supportAgent);
```

Delta is created through a factory. You call `createDeltaEngine` once and receive a plain object that is the entire surface. Authoring and runtime both hang off it as methods read as verbs: `delta.action`, `delta.workflow`, `delta.phase`, and `delta.agent` define your definitions; `delta.deploy`, `delta.send`, `delta.approve`, `delta.pause`, `delta.resume`, and `delta.inspect` drive execution. There is no `new`, no inheritance, no global singleton, and no standalone imports beyond `createDeltaEngine`.

You author actions, workflows, and agents. After deployment, Delta owns the runtime. You never construct a `Task`, `Checkpoint`, `TrustState`, or `TaskTree` by hand.

## How Execution Works

Each incoming request becomes a task, and every action the agent requests passes through the same pipeline:

```
Incoming Message
  -> Create TaskID
  -> Assign Agent
  -> Agent Reasons
  -> Agent Requests Action
  -> Validate Schema
  -> Risk Check
  -> Budget Check
  -> Approval Check
  -> Execute fn()
  -> Checkpoint
  -> Trust Update
  -> Continue
```

The `TaskID` is the unit of governance. Authorization, budgeting, auditing, checkpointing, delegation, messaging, and supervision are all attached to it. Work is performed by tasks, not by agents.

### Composition

Authoring composes through four mechanisms, all enforced by the engine:

- **Prerequisites.** An action can require other actions or whole workflows to complete first. Until they do, the action is not exposed and cannot be authorized. Ordering becomes an engine guarantee instead of model behavior.
- **Conditional branching.** A workflow phase routes between actions on their outcome, success or failure, or on a declared guard. Decision structure stays inside the governed workflow.
- **Explicit outcomes.** Every action returns a Result, either `Ok` or `Err`. The engine never infers success from a missing error, which gives trust scoring, branching, and supervision a clean signal.
- **Lifecycle hooks.** `before`, `after`, and `onError` hooks attach to actions, phases, and workflows for setup, teardown, and notification. Hooks observe and prepare. They never authorize an action or bypass a check.

## Mathematical Foundations

Delta Agents is built on established results from control theory, decision theory, and statistical estimation. The goal is to make autonomous execution tractable to reason about rather than to make it feel intelligent. Each foundation below maps to a concrete governance behavior in the engine.

Reference links and formal citations will be added as the work is published. The bracketed markers are placeholders.

- **Bounded state-space model.** Execution is movement through a finite set of valid states and transitions across task, workflow, budget, risk, trust, authorization, and delegation. An action outside the current state-space does not exist. Safety becomes analyzable only when the action space is bounded. [ref-state-space]

- **Markov constraints.** The legality of the next action depends only on the current state, never on historical replay. This forms a constrained Markov process and keeps decisions stateless and reproducible. [ref-markov]

- **Bellman optimization.** Path, retry, escalation, and delegation decisions are evaluated as immediate cost plus expected future cost. Implementations may vary, the optimization principle does not. [ref-bellman]

- **Model predictive control.** Execution uses receding-horizon prediction. The engine evaluates a finite future trajectory before allowing an action and stops prediction at epistemic boundaries such as data retrieval or unknown information. Preventing failure is cheaper than recovering from it. [ref-mpc]

- **Kalman state estimation.** Execution health is continuously estimated from predicted progress, observed progress, time consumption, token consumption, and tool outcomes. An action's optional anticipated risk and cost seed the estimator with a prior, so it starts calibrated rather than cold and converges faster. Large deviations between anticipated and observed values raise risk. Declared values are priors, never ceilings. [ref-kalman]

- **Bayesian updating.** Trust, confidence, and risk are revised continuously from observed evidence. Observed outcomes replace prior assumptions. Trust is never static. [ref-bayes]

- **Bayesian surprise.** The engine measures divergence between expected and observed outcomes. High divergence signals model drift, workflow drift, or novel conditions and raises oversight requirements. [ref-surprise]

- **Asymmetric reputation decay.** Trust accrues slowly and is lost quickly. Unexpected failures incur larger penalties than successes earn rewards, biasing the system toward caution. [ref-reputation]

- **Cost friction detection.** Resource consumption is measured against state advancement. High consumption with low advancement indicates instability such as infinite loops or reasoning spirals, and execution may be terminated. [ref-friction]

- **Predictive shadow racing.** Multiple candidate agents or workflows can be evaluated on projected safety, cost, and completion probability before execution. Only the selected candidate receives execution authority. [ref-shadow]

## Authoring API and Runtime API

The surface is split into two tiers so the developer experience stays small while the engine retains full control.

**Authoring API** (you define these):

| Type | Purpose |
|------|---------|
| `Action` | A single executable operation with a validation schema, optional anticipated risk and cost, optional prerequisites, and lifecycle hooks. |
| `Workflow` | An ordered set of phases describing a procedure. |
| `Phase` | A stage of a workflow with its actions, checkpoint, and supervision policy. |
| `Agent` | A role with its actions, workflows, skills, and channels. |
| `DataSource` | An owned or external resource with retrieve, create, update, and delete actions. |
| `Channel` | An inbound or outbound communication surface. |
| `Skill` | A reusable capability attached to an agent. |

**Runtime API** (the engine owns these):

| Type | Purpose |
|------|---------|
| `Task` | The unit of governance. Owns goal, budget, risk, and trust. |
| `TaskTree` | A bounded supervision tree, at most two active children. |
| `Execution` | A single action run with cost and status. |
| `Checkpoint` | A recoverable state boundary. |
| `Approval` | A human approval request and its decision. |
| `RiskState` | Static, current, and predicted risk with confidence. |
| `TrustState` | Evidence-derived trust score and outcome counts. |
| `Message` | A task-attributable communication. |
| `Queue` | A FIFO queue for pending work, messages, and escalations. |

## Supervision and Recovery

Delegation reduces complexity, so it is bounded to never create complexity. A supervision tree has at most one active parent task and two active subtasks. Additional work waits in a FIFO queue until a slot frees. This produces predictable cost and risk profiles instead of exponential state growth.

Supervision strategies are configurable and applied consistently for the lifetime of a task, drawing on the Erlang supervision tree model:

- Retry
- Restart
- Resume from checkpoint
- Escalate to human
- Abort subtree
- Abort entire tree

Checkpoints define rollback and recovery points and can be placed per action, per task, per workflow node, or per phase. Recovery resumes from the latest valid checkpoint. Aborting a parent aborts all descendants.

## Core Principles

- The engine owns enforcement. Agents propose, the engine authorizes.
- Execution stays inside a bounded state-space. Invalid actions do not exist.
- Prediction precedes execution. Actions are checked against projected future states first.
- Memory is retrieved, not carried. Agents pull context on demand.
- Task identity is the security boundary. Governance attaches to the `TaskID`.
- Delegation is bounded. One active parent, two active subtasks.
- Trust is statistical. Earned through evidence, lost through evidence.
- Human oversight is fundamental. Every task stays eligible for intervention.

## Install

```
npm install delta-agents
```

Requirements: TypeScript v5 or later, running on Bun or Node.js.

## Status

The specification is stable. The implementation is in progress. API examples in this document describe the intended developer experience and are not all shipped yet. The canonical blueprint is [delta-agents.spec.md](./delta-agents.spec.md), which defines the principles, governance model, type system, invariants, and prohibitions.

## Documentation

- [delta-agents.spec.md](./delta-agents.spec.md), the full specification.
- [docs/architecture.md](./docs/architecture.md), governance engine and state-space model.
- [docs/supervision.md](./docs/supervision.md), supervision strategies and recovery.
- [docs/diagnostics.md](./docs/diagnostics.md), execution health, trust, and risk metrics.
- [docs/resources.md](./docs/resources.md), data sources and ownership.

## References and Citations

Formal references for the mathematical foundations will be listed here as the work is published. Placeholders below correspond to the markers in the Mathematical Foundations section.

- [ref-state-space] State-space and constrained action modeling. To be added.
- [ref-markov] Markov decision processes. To be added.
- [ref-bellman] Bellman equations and dynamic programming. To be added.
- [ref-mpc] Model predictive control and receding-horizon estimation. To be added.
- [ref-kalman] Kalman filtering and state estimation. To be added.
- [ref-bayes] Bayesian inference and sequential updating. To be added.
- [ref-surprise] Bayesian surprise and divergence measures. To be added.
- [ref-reputation] Asymmetric reputation and trust dynamics. To be added.
- [ref-friction] Resource-to-progress instability detection. To be added.
- [ref-shadow] Predictive evaluation and candidate selection. To be added.

## License

MIT
