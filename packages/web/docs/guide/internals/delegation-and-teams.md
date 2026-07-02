# Delegation and Teams

An agent can hand off a scoped piece of work to another agent. Delegation exists to reduce complexity for a single agent; the engine keeps it from creating a new kind of complexity of its own.

## Teams

An agent optionally belongs to a team via `agent.team`. Teams scope collaboration: an agent may only delegate work to, or mention, an agent that shares its team. An agent with no team treats every other agent as an available peer; teams are opt-in, not required.

```ts
const researcher = delta.agent({ name: "researcher", role: "Researcher", team: "support" /* ... */ });
const writer = delta.agent({ name: "writer", role: "Writer", team: "support" /* ... */ });
```

A delegation or mention that targets an agent outside the team is rejected by the engine itself, not just hidden from the model.

## Delegate

Delegating creates a bounded child task that the teammate owns. The child task carries its own budget, risk, and trust state, scoped to the parent's remaining headroom: a child's budget is clamped to what the parent has left, and the amount granted is reserved from the parent immediately so two concurrent children cannot together be granted more than the parent has.

## Mention

A mention leaves a teammate a note without handing off work. It records a message attributed to the sending task, without spawning a child task. The note reaches the recipient's reasoning context the next time that agent runs, exactly once.

## Bounded Concurrency

Delegation is structurally bounded, not just discouraged:

- A task may have at most two active delegated child tasks at a time. Additional delegations queue and are promoted as active children settle. The queue itself is unlimited.
- An agent owns at most one active top-level task at a time. A `send` call for an agent that already has one queues the new goal onto the existing task instead of starting a second one.

## Failure Propagation

A delegated failure never silently becomes a success. If the top-level task fails or is blocked while children are still active, the entire tree is aborted. If the top-level task completes but any child ended in failure or was blocked, the top-level result reflects the worst outcome among its children.

## Auditability

Delegation and mentions are attributed to the tasks and agents involved and are visible through `delta.inspect(taskId)` alongside every other execution and escalation for that task.
