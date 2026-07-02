# Delta Agents Specification

## Purpose

Delta Agents is a deterministic autonomous control plane for AI agents. It allows agents to reason, plan, delegate, and execute work while ensuring that all real-world actions are governed by explicit state constraints, budget constraints, safety policies, and human oversight.

The system exists to solve the fundamental problem of autonomous execution: large language models are probabilistic reasoners operating in partially observable environments. Delta Agents provides the deterministic execution layer that constrains, validates, supervises, and audits agent behavior without restricting agent intelligence.

The model is responsible for reasoning.

The engine is responsible for governance.

---

# Principles

## 1. The Engine Owns Enforcement

The agent may propose actions.

Only the engine may authorize actions.

Safety, policy, budget, risk, authorization, and workflow validation are enforced by the engine rather than learned by the model.

Why:

Models are probabilistic systems. Governance requires deterministic guarantees.

---

## 2. The System Operates Within a Bounded State-Space

Every task exists within a finite set of valid states and transitions.

Actions outside the current state-space do not exist.

Why:

Safety becomes mathematically tractable only when the action space is bounded.

---

## 3. Prediction Precedes Execution

Actions are evaluated against projected future states before execution.

Why:

Preventing failure is cheaper than recovering from failure.

---

## 4. Memory Is Retrieved, Not Carried

Agents retrieve context when needed.

Agents do not permanently carry complete historical context.

Why:

Scalable systems retrieve information on demand rather than maintaining unbounded working memory.

---

## 5. Task Identity Is The Security Boundary

TaskID is the primary unit of governance.

Authorization, auditing, budgeting, checkpointing, delegation, communication, and supervision are attached to TaskIDs.

Why:

Work is performed by tasks, not by agents.

---

## 6. Delegation Is Bounded

Delegation exists to reduce complexity.

Delegation must never create complexity.

Why:

Unbounded delegation creates exponential state growth and unpredictable resource consumption.

---

## 7. Trust Is Statistical

Trust is earned through evidence.

Trust is lost through evidence.

Why:

Observed outcomes are more reliable than self-reported confidence.

---

## 8. Human Oversight Is Fundamental

The system never assumes perfect autonomy.

Every task remains eligible for human intervention.

Why:

Unknown unknowns cannot be eliminated through automation.

---

# Decision Records

## Decision: Single Execution Gateway

### Context

Large tool surfaces increase hallucination, parameter drift, and invalid actions.

### Alternatives Considered

* Direct tool access
* Large tool registries
* Distributed enforcement

### Rationale

A single execution gateway provides one deterministic enforcement point.

### Tradeoffs

Additional abstraction between agents and capabilities.

---

## Decision: Contextual Action Discovery

### Context

Agents frequently attempt actions that are invalid in the current state.

### Alternatives Considered

* Static tool lists
* Prompt-based restrictions

### Rationale

Only exposing valid actions eliminates entire classes of invalid execution.

### Tradeoffs

Requires state-aware action filtering.

---

## Decision: TaskID-Centric Governance

### Context

Agent identity alone is insufficient for budgeting, auditing, and supervision.

### Alternatives Considered

* Session-based governance
* Agent-based governance

### Rationale

Tasks represent the true unit of work.

### Tradeoffs

Lifecycle management complexity.

---

## Decision: Stateless Governance Engine

### Context

Hidden execution state creates operational complexity.

### Alternatives Considered

* Stateful orchestration
* Long-lived execution contexts

### Rationale

Stateless governance increases portability, reliability, and observability.

### Tradeoffs

Greater reliance on checkpoints and external state stores.

---

## Decision: Binary Supervision Tree

### Context

Unlimited delegation causes complexity explosion.

### Alternatives Considered

* Unlimited subtasks
* Swarm execution

### Rationale

A bounded supervision tree produces predictable cost and risk profiles.

### Tradeoffs

Reduced parallelism.

---

## Decision: On-Demand Memory Retrieval

### Context

Large context windows degrade performance and increase cost.

### Alternatives Considered

* Persistent context
* Full memory injection

### Rationale

Retrieval scales better than retention.

### Tradeoffs

Retrieval quality becomes critical.

---

# Mathematical Governance Model

## State-Space Model

The system models execution as movement through a constrained state-space.

State includes:

* Task state
* Workflow state
* Budget state
* Risk state
* Trust state
* Authorization state
* Delegation state

A state transition is valid only when:

* Prerequisites are satisfied
* Authorization permits execution
* Budget permits execution
* Risk constraints permit execution

Invalid transitions are bugs.

---

## Markov Constraints

The legality of the next action is determined solely by the current state.

The engine never requires historical replay to determine valid actions.

The engine never exposes invalid actions.

This forms a constrained Markov process.

---

## Bellman Optimization

The engine evaluates execution paths using immediate and future costs.

Action value is determined by:

Value = Immediate Cost + Expected Future Cost

This principle governs:

* Path selection
* Retry decisions
* Escalation decisions
* Delegation decisions

Exact implementations may vary.

The optimization principle may not.

---

## Model Predictive Control

Execution is governed using receding-horizon prediction.

The engine evaluates a finite future trajectory before allowing execution.

Prediction stops at epistemic boundaries.

Epistemic boundaries include:

* Data retrieval
* Memory retrieval
* External observations
* Unknown information

The system never requires prediction beyond available evidence.

---

## Kalman State Estimation

The engine continuously estimates execution health using:

* Predicted progress
* Observed progress
* Time consumption
* Token consumption
* Tool outcomes

The estimate is continuously updated.

Large deviations increase risk.

---

## Cost Friction Detection

The system measures resource consumption against state advancement.

High consumption with low advancement indicates instability.

Examples:

* Infinite loops
* Retry storms
* Reasoning spirals

The engine may terminate execution when friction exceeds limits.

---

## Bayesian Updating

Trust, confidence, and risk are continuously updated using observed evidence.

Observed outcomes replace prior assumptions.

Trust is never static.

---

## Bayesian Surprise

The system measures divergence between expected and observed outcomes.

Large divergence indicates:

* Model drift
* Workflow drift
* Novel conditions
* Unsafe behavior

Large surprise increases oversight requirements.

---

## Asymmetric Reputation Decay

Trust increases slowly.

Trust decreases rapidly.

Unexpected failures incur substantially larger penalties than successful outcomes provide rewards.

The system intentionally biases toward caution.

---

## Predictive Shadow Racing

Multiple candidate agents or workflows may be evaluated before execution.

Selection is based on:

* Projected safety
* Projected cost
* Projected completion probability

Only the selected candidate receives execution authority.

---

# Task Hierarchy

## Master Task

Every objective is rooted in a Master TaskID.

The Master Task owns:

* Budget
* Risk
* Trust attribution
* Audit history
* Checkpoint history

---

## Subtasks

Subtasks inherit governance from their parent.

Subtasks receive:

* Scoped permissions
* Scoped objectives
* Scoped budgets

Subtasks never gain authority beyond parent scope.

---

## Supervision Tree

The supervision tree is bounded.

Maximum active structure:

* One active parent task
* Two active subtasks

Additional work enters a queue.

No additional task may execute until a slot becomes available.

---

# Queueing Model

The system uses FIFO queues.

FIFO applies to:

* Pending tasks
* Pending subtasks
* Agent communications
* Supervisor communications
* Escalation requests

FIFO ordering guarantees deterministic replay and auditability.

---

# Workflow Hierarchy

## Action

Single executable operation.

Typically one step.

---

## Task

Small objective.

Typically one to three actions.

Checkpointing is optional.

---

## Workflow / SOP

Structured execution graph.

Contains:

* Explicit dependencies
* Ordered actions
* Configurable checkpoints

---

## Multi-Phase Workflow

Large objective composed of phases.

Each phase contains:

* Actions
* Tasks
* Workflows
* Checkpoints

Phase completion creates a recovery boundary.

---

# Storylines

A storyline is a free-prose narrative of the ideal user flow. It lives on `Workflow` (the experiential arc) and `Phase` (a beat within that arc).

At runtime, the engine threads storylines onto `ActionContext` so action functions and hooks can read the narrative and shape their behavior — tone, pacing, what to emphasize, how to respond.

* `Workflow.storyline` — the whole-arc narrative. Becomes `ctx.storyline`.
* `Phase.storyline` — this phase's beat within the arc. Becomes `ctx.phaseStoryline`.

Storylines are optional and free-form. They reach the agent through a single channel (`ActionContext`) — no duplicate injection into the reasoner. In the free reasoner loop (no workflow), both fields are `undefined`.

Storylines are authoring content, not runtime state. They are plumbed fresh from the workflow and phase definitions on each call, never persisted in the task snapshot or checkpoint.

Why:

A `description` says what a workflow does. A `storyline` says how it should feel to the user. The distinction lets a developer declare the experiential arc without coupling it to the functional contract — the engine enforces the functional contract regardless, the storyline guides the agent's behavior within that enforcement.

---

# System Prompt and Time Awareness

Two engine-level options ground every agent in shared context and time.

## System Prompt

`DeltaEngineConfig.systemPrompt` — global org instructions passed to all agents. Static content baked into the system message prefix so it hits the model's prompt cache.

* Must not contain time or varying content — anything that changes per call breaks the cacheable prefix.
* Agent-specific instructions stay on `agent.rolePrompt`.
* The system message structure is: `[systemPrompt] → [agent role + rolePrompt] → [governance instructions]` — all static, all cacheable.

## Time Awareness

`DeltaEngineConfig.timezone` — grounds agents with time awareness. The engine injects:

* **Current time** (humanized + ISO + timezone) into the user message on every `reason()` call.
* **Prior messages** loaded from the message store, formatted as a transcript with relative time labels ("4 hours ago") so the model can perceive time gaps across the conversation.

All varying content lives in the user message — never in the system message — to preserve the prompt cache prefix.

Why:

Agents without time awareness cannot reason about recency, urgency, or sequence. A static system prompt gives every agent shared org context without per-call cost. Relative time on prior messages lets the model perceive that a user message arrived 4 hours ago without parsing raw timestamps.

---

# Action Prerequisites

An action may declare prerequisites.

A prerequisite is work that must complete before the action becomes legal.

A prerequisite may be:

* One or more actions
* One or more workflows

The state-space tracks completed actions and completed workflows for the task.

The engine evaluates prerequisites against this state.

While prerequisites are unsatisfied:

* The action is not exposed as a discoverable action.
* The action cannot be authorized.
* A request to execute it is blocked.

Example:

A `process-order` action declares `confirm-order` as a prerequisite action. The engine refuses `process-order` until `confirm-order` has completed for that task. A prerequisite may also be an entire workflow, for example a `fraud-review` workflow that must complete before `release-funds`.

Prerequisites are part of the constrained state-space. They are not advisory. An unsatisfied prerequisite means the action does not exist in the current state.

Why:

Ordering errors are a major source of unsafe execution. Declaring prerequisites moves ordering from model behavior into engine enforcement.

---

# Workflow Control Flow

A workflow defines execution order between its actions.

Two control-flow forms are supported.

## Sequential Order

Actions listed in a phase execute in declared order by default.

The next action begins only after the current action produces a terminal outcome.

## Conditional Branching

A phase may declare branching based on action outcomes.

Branching forms a decision tree. Each branch node evaluates one action and selects the next action from its outcome.

A branch may route on:

* Success, when the action outcome is `Ok`
* Failure, when the action outcome is `Err`
* A declared guard condition evaluated against task state

Example:

A `verify-payment` action routes to `fulfill-order` on success and to `notify-failure` on failure.

Branching is declared, not inferred. The engine never invents transitions. Workflow branching is determined solely by declared transitions and observed action outcomes.

Why:

Real procedures are not linear. Conditional routing keeps decision structure inside the governed workflow rather than inside model reasoning.

---

# Execution Outcomes

Every action function returns a Result.

A Result is either:

* `Ok`, carrying the success value
* `Err`, carrying the failure value

The engine never infers success from the absence of a thrown error. Success and failure are explicit and inspectable.

This contract drives:

* Trust updates, which require a clear pass or fail signal
* Conditional branching, which routes on `Ok` or `Err`
* Supervision, which selects retry, restart, resume, or escalation from the outcome
* Cost friction detection, which correlates outcomes against consumption

Action functions, data source functions, and channel functions all return Results.

Why:

Governance requires a deterministic pass or fail signal. Exceptions are ambiguous and easy to swallow. An explicit Result removes ambiguity.

---

# Tools

Tools are reusable, stateless utilities registered at the engine level. Unlike actions, tools have no prerequisites, no risk, no state impact, and no budget of their own. They are visible to every agent across all tasks.

Tools serve a specific role: they provide reasoning context rather than changing system state. Web search, mathematical computation, and document retrieval are typical tool use cases. An action changes business state; a tool informs the model.

## Tool Definition

Every tool declares a name, description, Zod schema, and execution function. Tools may optionally declare skills, execution limits (cooldown, max calls per phase, max calls per task), and a budget for cost tracking.

```ts
type Tool = {
  name: string;
  description: string;
  schema: ZodObject<ZodRawShape>;
  skills?: (string | Skill)[];
  fn: (ctx: { data: unknown; ctx: ToolContext }) => Promise<Result<unknown, string>>;
  limits?: {
    maxCallsPerPhase?: number;
    maxCallsPerTask?: number;
    cooldownMs?: number;
  };
  cost?: Cost;
  budget?: Cost;
};
```

## Tools vs Actions

Tools and actions are separate concepts with different governance properties:

| Property | Tool | Action |
|----------|------|--------|
| State impact | None. Tools are read-only utilities. | Changes task state (completedActions, budget, risk, trust). |
| Prerequisites | None. | Declared prerequisites must be satisfied. |
| Risk | Zero. Tools carry no risk. | Declared risk 1-5, continuously estimated. |
| Budget | Optional (cost tracking only). | Mandatory (task budget enforced). |
| Visibility | Global. All tools visible to all agents. | Scoped by task state, prerequisites, phase. |
| Result type | Informs model reasoning. | Drives trust, risk, branching, supervision. |

## Progressive Disclosure

Tools use progressive disclosure to keep the model's context window efficient:

- The model sees a menu of tool names and descriptions on every turn (via `availableTools`).
- Schemas are not included by default. The model fetches them on demand using the internal tool `system:get_tool_schema`.
- Tool execution history entries are also fetched on demand via `system:get_tool_history` and `system:get_tool_history_entry`.

Actions use the opposite pattern. Action schemas are included by default in the model's context (via `availableActionSchemas` converted through `z.toJSONSchema`). Actions are task-specific and the model needs full schema information to execute business logic correctly. Tools are reusable across contexts, so keeping the menu small matters.

## Internal Tools

Tools whose names start with `system:` are reserved for framework-provided capabilities. The engine validates this prefix at registration time; user tools cannot use it.

Internal tools:

- `system:use_tool` — execute a named tool with the given input. The engine routes the call to the registered tool function, records the result in tool history, and enforces limits (cooldown, max calls, budget).
- `system:get_tool_schema` — return the full Zod schema for a named tool. Called by the model on demand (progressive disclosure).
- `system:get_tool_history` — return the full tool history for the current task. Provides the complete execution log beyond the truncated view in context.
- `system:get_tool_history_entry` — return a single tool history entry by index, including the full (untruncated) output. Allows the model to "deep dive" into a specific tool result without re-executing the tool.

## Tool Hints

Phases and actions may declare advisory tool hints. These are suggestions to the model about which tools are useful. All tools remain visible regardless of hints. Hints do not restrict or gate access.

```ts
const phase: Phase = {
  name: "research",
  description: "Gather customer data",
  actions: ["lookup-customer"],
  checkpoint: true,
  tools: ["web-search", "database-query"],  // advisory hints
};

const action = delta.action({
  name: "lookup-customer",
  description: "Look up a customer account",
  schema: z.object({ customerId: z.string() }),
  tools: ["database-query"],                  // overrides phase-level hints
  fn: async ({ customerId }) => { ... },
});
```

## Tool History

Every tool call is logged with full context for audit, governance, and provenance. History entries are persisted in the task state snapshot and recoverable through checkpoints.

```ts
type ToolContext = {
  agentName: string;
  taskId: string;
  phaseName?: string;
  toolHistory: ToolHistoryEntry[];
  // Attachments supplied at send() time — lets a tool look up raw content
  // (e.g. a file to extract text from) by id. Absent or empty when the task
  // carries none.
  attachments?: Attachment[];
};

type ToolHistoryEntry = {
  id: string;
  toolName: string;
  input: unknown;
  output: unknown;
  truncated: boolean;
  timestamp: number;
  agentName: string;
  phaseName?: string;
  tokenCount?: number;
  cost?: Cost;
  outputFull?: unknown;  // full output kept when `output` was truncated
};
```

History entries are truncated by default (500 characters). The full output is retrievable on demand via `system:get_tool_history_entry`. This keeps the model's context window efficient while preserving auditability.

## Loop Detection

The scheduler maintains a per-agent detector that tracks:

- **Cooldown**: minimum time between consecutive calls to the same tool.
- **Max calls per phase**: maximum calls to a tool within a single phase.
- **Max calls per task**: maximum calls to a tool across the entire task.

When a limit is hit, the engine blocks the call and returns a humanized message to the model explaining why. The full context is logged for audit.

The detector is created fresh per `runScheduler` call, so paused/resumed tasks get a clean detector.

## Budget Enforcement

Tools may declare a budget for cost tracking. Unlike action budgets, tool budgets are optional and purely advisory for cost awareness. When a tool's budget is exceeded, the engine blocks further calls and returns a humanized message.

Budgets track the `Cost` axes: tokens, durationMs, memory, latency, money (an explicit `{ value, currency }` amount), and content (attachment/content resource consumption).

---

# Multimodal Input

A caller may attach images, audio, or files to a goal through `SendInput.attachments`. Attachments give the agent access to content beyond plain text without changing the state-space, budget, or risk model — they are input, not action.

## Attachment Kind Is Explicit

An attachment declares `kind: "image"`, `kind: "audio"`, or `kind: "file"`. The kind is supplied by the caller, never inferred from `mimeType` — a file could contain images, so inference would be ambiguous. The engine assigns the attachment's id; a caller never self-assigns one (the same rule that governs TaskIDs: identifiers are engine-issued, never caller-guessable or caller-supplied).

An attachment must carry at least one of `data` (base64-encoded content) or `url` (a remote URL). Neither is not a legal attachment — `send()` rejects it before any task is created.

## Images and Audio Reach the Model; Files Do Not

An image or audio attachment is embedded as real multimodal content in the reasoner's request when the agent's resolved model declares the matching capability. The model literally sees the image or hears the audio.

Audio has a narrower path than image: an image may reach the model via a remote `url` (the provider fetches it) or inline `data`, but an audio attachment must carry `data` — the provider's audio content part accepts no URL. An audio attachment that carries only `url` is rejected at `send()` time rather than silently failing downstream, with the rejection naming the loader that resolves it (`loadAttachmentFromUrl`, part of the DX described below). An audio attachment's `mimeType` must also map to a format the provider supports; an unmappable one is rejected the same way.

A file attachment is never sent to the model as raw bytes — no assumption is made that every provider or model can ingest arbitrary file content as part of a chat request. Instead the model sees a short reference (an id, a MIME type, a name) and is expected to read the file's contents through a tool built for that purpose. Reading a file is a tool's job; seeing or hearing image/audio content is the model's.

## Capability Is Declared, Not Assumed

A model definition may declare `vision: true` and/or `audio: true`. Sending an image attachment to an agent whose resolved model does not declare vision capability — or an audio attachment where audio capability is not declared — is rejected before any task is created — a deterministic failure, not a silent drop. Principle 1 governs here the same as everywhere else: the engine owns enforcement, not the model's actual capability at request time.

Why:

A dropped image or audio clip is a silent capability gap — the caller believes the model received something it never got. Rejecting up front, before a task exists, keeps the failure attributable and immediate instead of discovered later as an unexplained gap in the agent's behavior.

## Attachments Persist For The Life Of The Task

An attachment supplied at send time remains part of the task's state for the duration of that task's run, the same way tool history and the task goal do. Every reasoner turn is a fresh reconstruction of the model's context from current task state — there is no assumption of provider-side conversation memory — so an attachment stays available to be shown again on a later turn rather than being consumed once and discarded.

## Resolving Bytes Is the Caller's Job, Not the Engine's

The engine never touches the filesystem and never makes an outbound network call to resolve an attachment's content. A caller who has a local file or a remote URL resolves it into `data` themselves before calling `send()` — optionally through a provided loader (a convenience DX, not a governance mechanism, so it carries no invariant of its own beyond producing a well-formed attachment). This keeps `send()` itself free of I/O side effects that the engine would otherwise have to govern, retry, or account for.

---

# Lifecycle Hooks

Hooks allow observation and preparation around execution without bypassing governance.

Hooks may attach to:

* An action
* A phase
* A workflow

Supported hook points:

* `before`, run prior to execution
* `after`, run following a terminal outcome
* `onError`, run when the outcome is `Err`

Hooks observe and prepare. Hooks never authorize actions. Hooks never bypass schema validation, risk checks, budget checks, approval checks, or prerequisites. A hook cannot grant a capability the engine would otherwise deny.

Why:

Setup, teardown, logging, and notification are common needs. Routing them through declared hooks keeps side effects visible and keeps the execution gateway authoritative.

---

# Anticipated Risk and Cost

An action may declare an anticipated risk level and an anticipated cost. Both are optional.

* `risk`, an integer from 1 to 5, expresses how dangerous or irreversible the developer believes the action is.
* `estimatedCost`, a `Cost`, expresses the resources the developer expects the action to consume.

Delta can operate without either. When they are absent, the engine derives its own estimates from observed history and continuous state estimation. When they are present, they serve two purposes:

* They seed the Kalman state estimator with a prior, so the engine starts from a calibrated expectation instead of a cold one and converges faster. Anticipated values become the predicted baseline that observed risk and observed cost are measured against. A large divergence between anticipated and observed values raises surprise and risk.
* They carry human guidance and control into the governed loop. A developer who knows an action is irreversible or expensive can state it directly, and the engine respects that judgement rather than waiting to learn it from failures.

Declared values are priors, not ceilings. The engine continuously refines its own estimate from evidence and may raise risk above the declared level when observed behavior warrants it. A low declared risk never overrides an observed danger.

Why:

A cold estimator is slow to calibrate and can authorize an irreversible action before it has learned to fear it. Optional anticipated values let human knowledge prime the estimator without making authoring heavy, while keeping the engine free to disagree with the prior once evidence arrives.

---

# Checkpointing

Checkpointing is configurable.

A checkpoint may exist:

* Per action
* Per task
* Per workflow node
* Per phase

Checkpoint boundaries define rollback and recovery points.

Recovery resumes from the latest valid checkpoint.

---

# Supervision Model

Delta Agents uses configurable supervision strategies inspired by Erlang supervision trees.

Supported strategies include:

* Retry
* Restart
* Resume from checkpoint
* Escalate to human
* Abort subtree
* Abort entire tree

The configured strategy must be applied consistently for the lifetime of the task.

---

# Human Oversight

Human oversight is a first-class component of execution.

Escalation may occur because of:

* Risk thresholds
* Bayesian surprise
* Policy violations
* Budget violations
* Workflow failures
* Explicit configuration

The system never assumes complete autonomy.

---

# Task Identity and Retrieval

## Task IDs Are Unguessable

Every TaskID is generated using a cryptographically random generator. The format includes a domain prefix followed by a nanoid-quality random string (at least 10^32 possible values).

Agents cannot infer or guess a TaskID. The engine distributes TaskIDs to agents explicitly: through the response to `delta.send`, through `delta.inspect`, and through the task retrieval mechanism below.

Why:

TaskID is the security boundary. Authorization, budgeting, auditing, checkpointing, delegation, and supervision are all attached to TaskIDs. An agent that can guess or forge a TaskID can impersonate a task, access another task's audit trail, or invoke capabilities outside its own scope. Unguessable IDs close that attack surface structurally.

---

## Task Retrieval

An agent or developer does not need to remember a TaskID to retrieve it.

The engine provides retrieval by agent identity:

* The latest active or pending task for a named agent is always recoverable.
* If a task has completed or been aborted, the most recent completed task is returned.
* The engine exposes this through the runtime surface, for example `delta.lastTask(agentName)`.

Why:

Requiring callers to store and manage TaskIDs is a reliability failure mode. A caller that loses its reference cannot inspect, pause, resume, or escalate a running task. Retrieval by agent identity removes that fragility without weakening the security boundary — retrieval still returns the same governance-attributable Task the engine owns.

---

## No New Task When Work Is Pending

The engine does not create a new task for an agent that already has an active or queued task.

When `delta.send` is called for an agent that is already working or has work in the queue:

* The engine returns the existing task and its current status.
* No second task is created.
* The inbound message is attributable to the existing task if it is relevant to ongoing work, or queued as a new message for when the agent becomes free.

Why:

Allowing unbounded task creation per agent produces the same failure as unbounded delegation: exponential state growth, unpredictable resource consumption, and governance state that becomes unauditable. A single active or queued task per agent is the smallest unit that keeps the system tractable. New work that arrives while an agent is busy either attaches to the existing task or waits.

---

# Invariants

1. Every execution event belongs to exactly one TaskID.
2. Every TaskID belongs to at most one parent.
3. Every action executes through the execution gateway.
4. Every executable action has a validation schema.
5. Every discoverable action exposes its validation schema.
6. Every state transition satisfies its prerequisites.
7. Every workflow transition satisfies declared dependencies.
8. Every memory access is attributable to a TaskID.
9. Every message is attributable to a TaskID.
10. Every checkpoint represents a recoverable state.
11. Every trust update is evidence-derived.
12. Every risk update is evidence-derived.
13. Every escalation is auditable.
14. Every supervisor owns at most one active primary task.
15. Every supervisor owns at most two active subtasks.
16. Additional work is queued until active slots become available.
17. Aborting a parent task aborts all descendant tasks.
18. A subtask never gains authority beyond its parent scope.
19. Every action function returns an explicit Result outcome.
20. An action with unsatisfied prerequisites is neither exposed nor executed.
21. Workflow branching is determined solely by declared transitions and observed outcomes.
22. Every hook runs without authorizing actions or bypassing governance.
23. Anticipated risk and anticipated cost are priors only. A declared value never lowers risk below observed evidence and never authorizes an action the engine would otherwise deny.
24. Every TaskID is cryptographically random and unguessable by agents or callers.
25. An agent always has a retrieval path to its latest task without requiring the caller to store the TaskID.
26. No new task is created for an agent that already has an active or queued task.
27. Tools are stateless utilities. They do not change state space, have no prerequisites, and carry no risk.
28. Tool names must not start with "system:" — this prefix is reserved for internal framework tools.
29. Tool results are truncated and stored in tool history. Full results are retrievable on demand via system:get_tool_history_entry.
30. Every tool call is logged with agent name, phase, timestamp, input, output, and token count for audit.
31. Every attachment id is engine-issued; a caller never self-assigns one.
32. An image attachment is rejected before task creation when the resolved model does not declare vision capability.
33. A file attachment is never transmitted to the model as raw content — only a reference (id, mimeType, name).
34. An audio attachment is rejected before task creation when the resolved model does not declare audio capability.
35. An audio attachment is rejected before task creation unless it carries `data` and a `mimeType` mappable to a supported format.
36. Every attachment carries at least one of `data` or `url`; an attachment with neither is rejected before task creation.

---

# Prohibitions

1. The agent never executes capabilities outside the execution gateway.
2. The engine never executes undeclared actions.
3. The engine never expose actions that are invalid in the current state.
4. The engine never authorize execution outside TaskID scope.
5. A supervisor never owns more than one active primary task.
6. A supervisor never owns more than two active subtasks.
7. A child task never gains authority over its parent.
8. A child task never gains authority over sibling tasks.
9. The engine never bypass validation schemas.
10. The engine never bypass configured supervision policies.
11. The system never continue execution after a terminal abort.
12. The system never assume trust without evidence.
13. The system never assume safety without verification.
14. The system never predict beyond an epistemic boundary.
15. The system never allow unbounded delegation.
16. The engine never expose or execute an action with unsatisfied prerequisites.
17. A hook never authorizes an action or bypasses validation, risk, budget, approval, or prerequisite checks.
18. The engine never infer success from the absence of a thrown error.
19. The engine never invent a workflow transition that was not declared.
20. The engine never treat a declared anticipated risk or cost as a ceiling that overrides observed evidence.
21. The engine never creates a new task for an agent that already has an active or queued task.
22. A caller never needs a stored TaskID to retrieve their agent's current or most recent task.
23. Tools must not modify task state space (completedActions, completedWorkflows, budget, risk, trust).
24. Tool names must not collide with action names or internal tool names.
25. The engine never silently drops an image attachment sent to a non-vision model — it rejects the send.
26. The engine never sends a file attachment's raw content to the model.
27. The engine never silently drops an audio attachment sent to a non-audio-capable model — it rejects the send.
28. The engine never fetches or reads an attachment's content on the caller's behalf — resolving `data` from a file or URL is the caller's responsibility.

---

# Follow-Up Work

## Trust Calibration

Initial values for:

* Trust accumulation
* Trust decay
* Bayesian surprise thresholds
* Escalation thresholds

will use conservative defaults and be refined through operational evidence.

Impact:

Suboptimal thresholds may produce excessive or insufficient oversight.

---

## Governance Metric Calibration

Initial values for:

* Cost friction
* Progress estimation
* Risk scoring
* Predictive control horizons

will be empirically tuned.

Impact:

Early versions may be overly conservative or overly permissive.

---

## Workflow Optimization

The workflow hierarchy is stable.

Optimization of workflow discovery, recommendation, and shadow evaluation remains future work.

Impact:

Execution remains safe but may not always be optimal.

## Types And Implementation Blueprint

```txt
Authoring API (Developer touches)
---------------------------------
Agent
Workflow
Phase
Action
DataSource
Channel
Skill

Runtime API (Delta owns)
------------------------
Task
TaskTree
Execution
Checkpoint
Approval
RiskState
TrustState
Message
Queue
```

That separation keeps the DX clean and aligns with the spec.

---

# Core Authoring Types

### Action

```ts
type Action = {
  name: string;
  description: string;

  schema: ZodObject;

  // Anticipated risk. Optional. The engine can derive its own
  // estimate, but a declared value seeds the Kalman estimator with
  // a prior and carries human judgement about danger or
  // irreversibility into the governed loop. A prior, not a ceiling.
  risk?: 1 | 2 | 3 | 4 | 5;

  // Anticipated cost. Optional. Seeds the cost estimate with a prior
  // and becomes the baseline that observed cost is measured against.
  estimatedCost?: Cost;

  requiresApproval?: boolean;

  // Work that must complete before this action becomes legal.
  // The engine tracks completed actions and workflows in the
  // task state-space and blocks until prerequisites are satisfied.
  prerequisites?: {
    actions?: string[];
    workflows?: string[];
  };

  // Observation and preparation around execution.
  // Hooks never authorize actions or bypass governance.
  hooks?: Hooks;

  // Advisory hint: tools useful for this action. All tools remain visible
  // regardless. Hints do not restrict or gate access.
  tools?: string[];

  // Returns a Result. Ok carries success, Err carries failure.
  // The engine never infers success from the absence of a throw.
  fn: (
    data: ActionInput,
    ctx: ActionContext
  ) => Promise<ResultType>;
};
```

`ResultType` is a slang Result, either `Ok` carrying the success value or `Err` carrying the failure value.

```ts
type Hooks = {
  before?: (ctx: ActionContext) => Promise<ResultType>;
  after?: (ctx: ActionContext) => Promise<ResultType>;
  onError?: (ctx: ActionContext) => Promise<ResultType>;
};
```

---

### Workflow

```ts
type Workflow = {
  name: string;

  description: string;

  // Narrative of the ideal user flow — the experiential arc.
  // Phase storylines are beats within this arc. Guides action
  // functions and hooks on how events should unfold experientially.
  storyline?: string;

  version: string;

  phases: Phase[];

  estimatedCost?: Cost;

  hooks?: Hooks;
};
```

---

### Phase

```ts
type Phase = {
  name: string;

  description: string;

  // Narrative of the ideal user flow for this phase — a beat
  // within the workflow's storyline arc. Guides action functions
  // and hooks on how events should unfold experientially.
  storyline?: string;

  // Sequential by default. A branch node overrides the next
  // action based on the prior action's Result or a guard.
  actions: ActionRef[];

  checkpoint: boolean;

  supervision?: SupervisionPolicy;

  hooks?: Hooks;

  // Advisory hint: tools useful in this phase. All tools remain visible
  // regardless. Hints do not restrict or gate access.
  tools?: string[];
};
```

```ts
// A plain string runs in declared order.
// A branch node routes to the next action by outcome.
type ActionRef =
  | string
  | Branch;

type Branch = {
  action: string;

  // Next action when the outcome is Ok.
  onSuccess?: string;

  // Next action when the outcome is Err.
  onFailure?: string;

  // Optional guard evaluated against task state.
  when?: (ctx: ActionContext) => boolean;
};
```

---

### ActionContext

```ts
// Context injected into action fn, hooks, and branch guards at runtime.
// The engine assembles this — the developer never constructs it.
type ActionContext = {
  taskId: string;
  executionId: string;
  agentName: string;
  phase?: string;

  // The workflow-level narrative arc, when running inside a workflow.
  // Absent in the free reasoner loop (no workflow context).
  storyline?: string;

  // The current phase's narrative beat, when running inside a workflow.
  // Absent in the free reasoner loop.
  phaseStoryline?: string;

  availableSkills?: Array<{ name: string; description: string; content?: string }>;
  communicate?: (channelType: string, body: string) => Promise<ResultType>;
  remember?: (content: string, kind?: string) => Promise<ResultType>;
};
```

Storylines reach action functions and hooks through this single channel — no duplicate injection. In the free reasoner loop (no workflow), both `storyline` and `phaseStoryline` are `undefined`.

---

### Agent

```ts
type Agent = {
  name: string;

  description: string;

  role: string;

  rolePrompt: string;

  model?: string;

  contextWindow?: number;

  actions: Action[];

  workflows?: Workflow[];

  skills?: Skill[];

  channels?: Channel[];

  team?: string;
};
```

---

### Skill

```ts
type Skill = {
  name: string;

  description: string;

  path: string;

  active: boolean;
};
```

---

### DataSource

```ts
type DataSource = {
  name: string;

  description: string;

  ownership:
    | "internal"
    | "external";

  contentType: ContentTypes;

  authentication?: Authentication;

  actions: {
    retrieve?: Fn;
    create?: Fn;
    update?: Fn;
    delete?: Fn;
  };
};
```

---

### Channel

```ts
type Channel = {
  type: SupportedChannels;

  enabled: boolean;

  sendMessage: (
    message: string,
    ctx: ChannelContext
  ) => Promise<ResultType>;

  retrieveMessages?: (
    ctx: ChannelContext
  ) => Promise<ResultType>;

  replyMessage?: (
    id: string,
    message: string,
    ctx: ChannelContext
  ) => Promise<ResultType>;
};
```

---

# Runtime Types

Developer normally never touches these.

---

### Task

This becomes the center of the runtime.

```ts
type Task = {
  id: string;

  rootId: string;

  parentId?: string;

  status: ExecutionStatus;

  goal: string;

  assignedAgent: string;

  workflow?: string;

  currentPhase?: string;

  budget: Cost;

  risk: RiskState;

  trust: TrustState;

  createdAt: Date;

  updatedAt: Date;
};
```

---

### TaskTree

```ts
type TaskTree = {
  rootTaskId: string;

  activeChildren: string[];

  queuedChildren: string[];

  maxConcurrency: 2;
};
```

---

### Execution

```ts
type Execution = {
  id: string;

  taskId: string;

  action: string;

  startedAt: Date;

  endedAt?: Date;

  status: ExecutionStatus;

  cost: Cost;
};
```

---

### Checkpoint

```ts
type Checkpoint = {
  id: string;

  taskId: string;

  phase?: string;

  state: Record<string, unknown>;

  createdAt: Date;
};
```

---

### Approval

```ts
type ApprovalRequest = {
  id: string;

  taskId: string;

  action: string;

  reason: string;

  status:
    | "pending"
    | "approved"
    | "rejected";

  createdAt: Date;
};
```

---

### Risk

```ts
type RiskState = {
  staticRisk: number;

  currentRisk: number;

  predictedRisk: number;

  confidence: number;

  escalated: boolean;
};
```

---

### Trust

```ts
type TrustState = {
  score: number;

  successfulExecutions: number;

  failedExecutions: number;

  surpriseEvents: number;
};
```

---

### Message

```ts
type Message = {
  id: string;

  taskId: string;

  sender: string;

  receiver: string;

  payload: unknown;

  createdAt: Date;
};
```

---

### Queue

```ts
type Queue = {
  id: string;

  taskId: string;

  pending: string[];

  active: string[];

  completed: string[];
};
```

---

### Supervision

```ts
type SupervisionPolicy = {
  strategy:
    | "retry"
    | "restart"
    | "resume"
    | "escalate"
    | "abort-subtree"
    | "abort-tree";

  maxRetries: number;
};
```

---

### Cost

```ts
// Financial cost as an explicit amount + currency pair. A bare number would
// assume a single currency; Money makes the currency part of the value so
// governance math never silently mixes regions.
type Money = {
  value: number;     // amount in the currency's minor unit (e.g. cents for USD), integer
  currency: string;  // ISO 4217 code, e.g. "USD", "EUR", "NGN"
};

// Attachment/content resource consumption. count/bytes are always meaningful
// regardless of content kind; unitType/itemSize let a tool (e.g. document
// extraction) report richer per-type cost (pages, tokens) without another
// Cost redesign.
type ContentCost = {
  count: number;
  bytes: number;
  unitType?: "tokens" | "pages" | "images" | "bytes";
  itemSize?: number;
};

// Multi-axis resource consumption vector. Cost is more than tokens and time:
// memory, latency, money, and content are first-class axes so the engine can
// budget, project (MPC), and scope them like any other resource.
// The optional axes are only enforced by a budget that declares them:
// an undeclared memory/latency/money/content budget means "unlimited on that
// axis". Cost axes are trusted to use consistent units within a task the same
// way memory/latency already are — the engine does not cross-validate
// currency or unitType on every operation.
type Cost = {
  tokens: number;
  durationMs: number;
  memory?: number;
  latency?: number;
  money?: Money;
  content?: ContentCost;
};
```

---

### TaskStateSnapshot

```ts
// The Markov state: a complete, self-contained view of task governance
// at a single point in time. Every legality check, prerequisite evaluation,
// and action discovery call takes a snapshot — never a history log.
type TaskStateSnapshot = {
  taskId: string;
  rootId: string;
  agentName: string;
  status: ExecutionStatus;
  completedActions: string[];
  completedWorkflows: string[];
  budget: Cost;
  spent: Cost;
  risk: RiskState;
  trust: TrustState;
  kalman?: KalmanState;
  currentWorkflow?: string;
  currentPhase?: string;
  parentBudget?: Cost;
  parentSpent?: Cost;
  consumedMessages?: string[];
  completedPhases?: string[];
  currentActionIndex?: number;
  workflowInput?: Record<string, unknown>;
  workflowActionInputs?: Record<string, Record<string, string | number | boolean | null>>;

  // Tool execution history for audit and checkpointing.
  // Every tool call is recorded with full context.
  toolHistory?: ToolHistoryEntry[];

  // Most recent tool-info result (schema, history, or history-entry).
  // Carried through so the model sees it on the next reason() call.
  lastToolInfoResult?: string;

  // Attachments supplied at send() time, engine-issued ids attached. Persists
  // across the whole task run (checkpointed like toolHistory) and is
  // forwarded to ReasonerInput on every reasoner call unchanged — the same
  // "always resend relevant state" pattern the rest of the snapshot follows.
  // Also surfaced to tools via ToolContext.attachments.
  attachments?: Attachment[];
};
```

---

### DeltaEngineConfig

```ts
type DeltaEngineConfig = {
  store?: StoragePort;
  endpoint?: string;
  apiKey?: string;
  options?: ModelOptions;
  models?: ModelDef[];
  reasoner?: ReasonerPort;
  maxStepsPerTask?: number;
  providerRetry?: Partial<RetryOptions>;

  // Global org instructions passed to all agents. Static content
  // baked into the system message prefix for prompt cache hits.
  // Must NOT contain time or varying content — anything that changes
  // per call breaks the cacheable prefix.
  systemPrompt?: string;

  // Timezone for humanized time in reasoner messages (e.g. "Africa/Lagos").
  // Defaults to the system timezone. Grounds agents with time awareness.
  timezone?: string;
};
```

### ReasonerInput

```ts
// What the engine passes to the reasoner on each reason() call.
type ReasonerInput = {
  task: Task;
  availableActions: string[];
  availableAgents?: string[];
  availableChannels?: string[];
  availableSkills?: Array<{ name: string; description: string; content?: string }>;
  agentRole: string;
  rolePrompt: string;
  context?: string;

  // Current time injected into the user message for time awareness.
  // Built by the engine before each reason() call. Keeps the system
  // message cacheable.
  currentTimestamp?: { iso: string; humanized: string; timezone: string };

  // Prior conversation transcript with relative time labels, loaded
  // from the message store. Gives the model time-gap awareness across
  // the conversation.
  priorMessages?: Array<{ sender: string; content: string; relativeTime: string }>;

  // Action descriptions + JSON schemas for all legal actions this turn.
  // Schemas converted from Zod via z.toJSONSchema() by the scheduler.
  availableActionSchemas?: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }>;

  // Tool menu: names + descriptions for all registered tools.
  // The model sees this lightweight menu every turn. Schemas are
  // fetched on demand via system:get_tool_schema (progressive disclosure).
  availableTools?: Array<{ name: string; description: string }>;

  // Advisory tool hints from the current phase/action. Suggestions only -
  // all tools remain visible regardless.
  toolHints?: string[];

  // Prior tool execution history (truncated entries) so the model can
  // see what tools it has already called and their results.
  toolHistory?: ToolHistoryEntry[];

  // Most recent tool-info result (schema dump, history snapshot, or
  // single history entry). Forwarded from TaskStateSnapshot.lastToolInfoResult
  // on the next turn.
  toolInfoResult?: string;

  // Attachments supplied at send() time. kind: "image" entries are embedded
  // as vision content parts by an adapter that supports it. kind: "file"
  // entries are surfaced only as a short text note (id, mimeType, name) —
  // never as raw bytes — since reading them is a tool's job.
  attachments?: Attachment[];
};
```

### Attachment

```ts
// Content the caller wants the agent to have access to. kind is explicit and
// required — the caller states intent, it is never inferred from mimeType (a
// PDF could contain images; inference would be ambiguous).
type AttachmentInput = {
  kind: "image" | "file" | "audio";
  mimeType: string;   // e.g. "image/png", "application/pdf", "audio/wav"
  data?: string;       // base64-encoded content
  url?: string;         // remote URL, alternative to inline data (image only — audio requires data)
  name?: string;         // filename, for audit/display
};

// Engine-issued: same as AttachmentInput, plus the id the engine assigns so
// tools can reference the raw content later. Attachment ids are engine-issued,
// never caller-guessable or self-assigned — the same rule that governs TaskIDs.
type Attachment = AttachmentInput & { id: string };
```

---

# Delta DX

> **Note (as-built):** The DX below is the original design sketch. The shipped surface differs in places — most notably, there is **no `delta.phase()`**; phases are plain objects passed to `delta.workflow({ phases: [...] })`. See the DX Pattern section of `context.md` for the canonical, as-built engine surface. The examples here remain useful for intent and shape, not exact signatures.

Delta is created through a factory function, never a class. A developer imports the package, calls `createDeltaEngine`, and receives an engine object whose methods are the entire runtime surface. There is no `new`, no inheritance, no global singleton the developer has to wire up.

```ts
import { createDeltaEngine } from "delta-agents";

const delta = createDeltaEngine({
  // model provider, persistence, logging, and defaults
  // are configured once, here.
  systemPrompt: "You are an Acme Corp agent. Always be helpful and concise.",
  timezone: "Africa/Lagos",
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
});
```

The returned `delta` object exposes everything as plain methods. Authoring factories and runtime operations all hang off the same engine object. There are no standalone imports beyond `createDeltaEngine`. The developer reads the methods as verbs:

Authoring methods (define definitions):

```ts
delta.action({ ... });   // define an executable operation
delta.workflow({ ... });  // define an ordered procedure
delta.phase({ ... });     // define a workflow stage
delta.agent({ ... });     // define a role and its capabilities
delta.tool({ ... });      // define a reusable, stateless utility
```

Runtime methods (drive execution):

```ts
delta.deploy(agent);        // register an agent and its workflows
delta.send(taskId, message); // hand an inbound message to a task
delta.approve(approvalId);   // resolve a pending human approval
delta.pause(taskId);         // suspend a running task
delta.resume(taskId);        // resume from the latest checkpoint
delta.inspect(taskId);       // read governance state for a task
```

The exact method set is not fixed here. The shape is: one factory, `createDeltaEngine`, returning one object that is the entire surface, authoring and runtime alike.

The single object is a developer-experience facade, not an architectural coupling. Internally each capability lives in its own module. `createDeltaEngine` imports those separate items and assembles them onto one returned object, passing shared engine configuration and context to each. The modules stay decoupled. A unified surface for the developer does not mean a unified implementation.

Authoring then feels like:

```ts
const lookupCustomer = delta.action({
  name: "lookup-customer",

  description: "Lookup customer account",

  risk: 1,

  schema: z.object({
    customerId: z.string(),
  }),

  fn: async ({ customerId }) => {
    return db.customer.find(customerId);
  },
});
```

```ts
const notifyCustomer = delta.action({
  name: "notify-customer",

  description: "Send WhatsApp notification",

  risk: 2,

  schema: z.object({
    phone: z.string(),
    message: z.string(),
  }),

  fn: async ({ phone, message }) => {
    return whatsapp.send(phone, message);
  },
});
```

```ts
const customerSupport = delta.workflow({
  name: "customer-support",

  phases: [
    delta.phase({
      name: "investigation",

      checkpoint: true,

      actions: [
        "lookup-customer",
      ],
    }),

    delta.phase({
      name: "communication",

      checkpoint: true,

      actions: [
        "notify-customer",
      ],
    }),
  ],
});
```

```ts
const supportAgent = delta.agent({
  name: "support-agent",

  role: "Customer Support Specialist",

  actions: [
    lookupCustomer,
    notifyCustomer,
  ],

  workflows: [
    customerSupport,
  ],
});
```

```ts
delta.deploy(supportAgent);
```

Prerequisites, branching, and hooks compose into the same authoring surface:

```ts
const confirmOrder = delta.action({
  name: "confirm-order",
  description: "Confirm an order with the customer",
  risk: 2,
  schema: z.object({ orderId: z.string() }),
  fn: async ({ orderId }) => orders.confirm(orderId),
});

const processOrder = delta.action({
  name: "process-order",
  description: "Charge and process a confirmed order",
  risk: 4,
  requiresApproval: true,

  // The engine blocks process-order until confirm-order completes.
  prerequisites: {
    actions: ["confirm-order"],
  },

  hooks: {
    before: async (ctx) => audit.log("process-order:start", ctx),
    onError: async (ctx) => alerts.page("process-order:failed", ctx),
  },

  schema: z.object({ orderId: z.string() }),
  fn: async ({ orderId }) => orders.process(orderId),
});

const fulfillment = delta.workflow({
  name: "fulfillment",
  phases: [
    delta.phase({
      name: "settlement",
      checkpoint: true,
      actions: [
        "confirm-order",
        // Route by outcome. Success fulfills, failure escalates.
        {
          action: "process-order",
          onSuccess: "notify-customer",
          onFailure: "escalate-to-human",
        },
      ],
    }),
  ],
});
```

Then Delta takes over.

Runtime:

```txt
Incoming Message
        ↓
Create TaskID
        ↓
Assign Agent
        ↓
Agent Reasons
        ↓
Agent Requests Action
        ↓
Validate Schema
        ↓
Risk Check
        ↓
Budget Check
        ↓
Approval Check
        ↓
Execute fn()
        ↓
Checkpoint
        ↓
Trust Update
        ↓
Continue
```

The developer never creates a `Task`.

The developer never creates a `Checkpoint`.

The developer never creates a `TrustState`.

The developer never creates a `TaskTree`.

The types and dx can be better and is suggestion not set in stone but very informative of what the ideal DX should be.
